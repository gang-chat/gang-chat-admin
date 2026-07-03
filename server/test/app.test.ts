import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { RawData } from 'ws';
import { buildApp } from '../src/app';
import type { ServerConfig } from '../src/config/config';
import type { AgentOpsRun, AgentWorkerStatus } from '../../src/lib/shared/ops-types';

type TestWebSocket = {
	send(data: string): void;
	close(code?: number, reason?: string | Buffer): void;
	terminate(): void;
	once(event: 'message', listener: (data: RawData, isBinary: boolean) => void): void;
	once(event: 'error', listener: (error: Error) => void): void;
	once(event: 'close', listener: (code: number, reason: Buffer) => void): void;
	off(event: 'message', listener: (data: RawData, isBinary: boolean) => void): void;
	off(event: 'error', listener: (error: Error) => void): void;
	off(event: 'close', listener: (code: number, reason: Buffer) => void): void;
};

async function withApp(
	fn: (context: {
		app: Awaited<ReturnType<typeof buildApp>>;
		token: string;
		agentWorkerToken: string;
		dataDir: string;
	}) => Promise<void>,
	envOverrides: Partial<ServerConfig> = {}
) {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-api-'));
	const agentWorkerToken = 'test-agent-worker-token';
	const baseEnv: ServerConfig = {
		host: '127.0.0.1',
		port: 0,
		corsOrigin: ['http://localhost:8787'],
		dataDir,
		agentWorkerToken,
		secretKey: Buffer.from('12345678901234567890123456789012'),
		nodeEnv: 'test',
		logLevel: 'info',
		bodyLimitBytes: 20 * 1024 * 1024,
		uploadLimitBytes: 100 * 1024 * 1024,
		rateLimitMax: 1000,
		rateLimitWindow: '1 minute',
		trustProxy: false,
		sshMaxSessions: 12,
		sshIdleTimeoutMs: 10 * 60 * 1000,
		sshReadyTimeoutMs: 15_000,
		sshKeepaliveIntervalMs: 20_000,
		sshTicketTtlMs: 30_000,
		sshRequireHostKeyVerification: false,
		sessionTtlMs: 12 * 60 * 60 * 1000,
		sessionIdleTimeoutMs: 30 * 60 * 1000,
		bootstrapAdminUser: 'admin',
		bootstrapAdminPassword: 'test-admin-password',
		authMaxFailedLogins: 5,
		authLockoutMs: 15 * 60 * 1000,
		aiAdminWorker: {
			baseUrl: 'https://llm.example.com/v1',
			apiKey: 'test-ai-key',
			model: 'ops-model'
		},
		releaseSync: null,
		connections: { mysql: null, s3: null, ssh: [] }
	};
	const env: ServerConfig = { ...baseEnv, ...envOverrides };
	const app = await buildApp(env);
	try {
		const login = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: { username: 'admin', password: 'test-admin-password' }
		});
		const token = login.json().data.token as string;
		await fn({ app, token, agentWorkerToken, dataDir });
	} finally {
		await app.close();
		await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
	}
}

function nextJsonMessage(socket: TestWebSocket, label = 'WebSocket message') {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for ${label}`));
		}, 2_000);
		const cleanup = () => {
			clearTimeout(timer);
			socket.off('message', onMessage);
			socket.off('error', onError);
			socket.off('close', onClose);
		};
		const onMessage = (raw: RawData) => {
			cleanup();
			resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onClose = () => {
			cleanup();
			reject(new Error('WebSocket closed before message'));
		};
		socket.once('message', onMessage);
		socket.once('error', onError);
		socket.once('close', onClose);
	});
}

async function waitForRunStatus(
	app: Awaited<ReturnType<typeof buildApp>>,
	token: string,
	id: string,
	status: AgentOpsRun['status']
) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const response = await app.inject({
			method: 'GET',
			url: `/api/agent/runs/${id}`,
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(response.statusCode, 200);
		const run = response.json().data as AgentOpsRun;
		if (run.status === status) return run;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for run ${id} to reach ${status}`);
}

async function waitForWorker(app: Awaited<ReturnType<typeof buildApp>>, token: string, id: string) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const response = await app.inject({
			method: 'GET',
			url: '/api/agent/workers',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(response.statusCode, 200);
		const workers = response.json().data as AgentWorkerStatus[];
		const worker = workers.find((item) => item.id === id);
		if (worker?.connected) return worker;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for worker ${id}`);
}

function mysqlConnections(allowMutations = false): ServerConfig['connections'] {
	return {
		mysql: {
			id: allowMutations ? 'write-db' : 'primary-db',
			type: 'mysql',
			name: allowMutations ? 'write-db' : 'primary-db',
			config: {
				host: '127.0.0.1',
				port: 3306,
				database: 'gang',
				user: 'ops',
				password: 'secret-password',
				ssl: false,
				allowMutations
			}
		},
		s3: null,
		ssh: []
	};
}

function s3Connections(allowWrites = false): ServerConfig['connections'] {
	return {
		mysql: null,
		s3: {
			id: allowWrites ? 'write-s3' : 'readonly-s3',
			type: 's3',
			name: allowWrites ? 'write-objects' : 'readonly-objects',
			config: {
				endpoint: 'http://127.0.0.1:9000',
				region: 'auto',
				defaultBucket: 'logs',
				forcePathStyle: true,
				allowWrites,
				accessKeyId: 'access-key',
				secretAccessKey: 'secret-key'
			}
		},
		ssh: []
	};
}

function sshConnections(requireFingerprint = false): ServerConfig['connections'] {
	return {
		mysql: null,
		s3: null,
		ssh: [
			{
				id: 'ssh-host',
				type: 'ssh',
				name: 'prod-shell',
				config: {
					host: '127.0.0.1',
					port: 22,
					username: 'ops',
					password: 'ssh-secret',
					hostKeySha256: requireFingerprint ? undefined : 'SHA256:testfingerprint'
				}
			}
		]
	};
}

test('API requires bearer auth outside health endpoint', async () => {
	await withApp(async ({ app }) => {
		const health = await app.inject({ method: 'GET', url: '/api/health' });
		const denied = await app.inject({ method: 'GET', url: '/api/connections' });
		const deniedDownload = await app.inject({
			method: 'GET',
			url: '/api/s3/example/objects/download?bucket=x&key=y&token=test-admin-token'
		});

		assert.equal(health.statusCode, 200);
		assert.equal(health.headers['x-frame-options'], 'SAMEORIGIN');
		assert.equal(denied.statusCode, 401);
		assert.equal(denied.json().error.code, 'UNAUTHORIZED');
		assert.equal(deniedDownload.statusCode, 401);
	});
});

test('session login can access admin APIs and logout revokes the session', async () => {
	await withApp(async ({ app }) => {
		const login = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});

		assert.equal(login.statusCode, 200);
		assert.equal(login.json().data.user.username, 'admin');
		assert.equal(typeof login.json().data.token, 'string');
		assert.equal(JSON.stringify(login.json()).includes('test-admin-password'), false);

		const sessionToken = login.json().data.token;
		const listed = await app.inject({
			method: 'GET',
			url: '/api/connections',
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		assert.equal(listed.statusCode, 200);

		const me = await app.inject({
			method: 'GET',
			url: '/api/auth/me',
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		assert.equal(me.statusCode, 200);
		assert.equal(me.json().data.authMethod, 'session');

		const logout = await app.inject({
			method: 'POST',
			url: '/api/auth/logout',
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		assert.equal(logout.statusCode, 200);
		assert.equal(logout.json().data.revoked, true);

		const denied = await app.inject({
			method: 'GET',
			url: '/api/connections',
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		assert.equal(denied.statusCode, 401);
	});
});

test('API rejects browser requests from origins outside the allowlist', async () => {
	await withApp(async ({ app }) => {
		const denied = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			headers: { origin: 'https://evil.example.com' },
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		assert.equal(denied.statusCode, 403);
		assert.equal(denied.json().error.code, 'ORIGIN_NOT_ALLOWED');

		const allowed = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			headers: { origin: 'http://localhost:8787' },
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		assert.equal(allowed.statusCode, 200);
	});
});

test.skip('session APIs expose idle expiration for active sessions', async () => {
	await withApp(async ({ app }) => {
		const login = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		assert.equal(login.statusCode, 200);
		assert.match(login.json().data.idleExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
		assert.equal(
			Date.parse(login.json().data.idleExpiresAt) <= Date.parse(login.json().data.expiresAt),
			true
		);

		const sessionToken = login.json().data.token;
		const sessions = await app.inject({
			method: 'GET',
			url: '/api/auth/sessions',
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		assert.equal(sessions.statusCode, 200);
		assert.equal(
			sessions.json().data.some((item: { current: boolean }) => item.current),
			true
		);
		assert.match(sessions.json().data[0].idleExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
	});
});

test('idle session timeout rejects inactive session tokens', async () => {
	await withApp(
		async ({ app, dataDir }) => {
			const login = await app.inject({
				method: 'POST',
				url: '/api/auth/login',
				payload: {
					username: 'admin',
					password: 'test-admin-password'
				}
			});
			assert.equal(login.statusCode, 200);
			const sessionToken = login.json().data.token;

			const authStorePath = path.join(dataDir, 'auth.json');
			const authStore = JSON.parse(await readFile(authStorePath, 'utf8')) as {
				sessions: Array<{ lastSeenAt: string }>;
			};
			authStore.sessions[0].lastSeenAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
			await writeFile(authStorePath, `${JSON.stringify(authStore, null, 2)}\n`, 'utf8');

			const denied = await app.inject({
				method: 'GET',
				url: '/api/connections',
				headers: { authorization: `Bearer ${sessionToken}` }
			});
			assert.equal(denied.statusCode, 401);
			assert.equal(denied.json().error.code, 'UNAUTHORIZED');
		},
		{ sessionIdleTimeoutMs: 60 * 1000 }
	);
});

test.skip('failed session logins are counted and successful login clears the counter', async () => {
	await withApp(async ({ app, token }) => {
		const failed = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'wrong-password'
			}
		});
		assert.equal(failed.statusCode, 401);
		assert.equal(failed.json().error.code, 'INVALID_CREDENTIALS');

		const afterFailure = await app.inject({
			method: 'GET',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(afterFailure.statusCode, 200);
		assert.equal(afterFailure.json().data[0].username, 'admin');
		assert.equal(afterFailure.json().data[0].failedLoginCount, 1);
		assert.match(afterFailure.json().data[0].lastFailedLoginAt, /^\d{4}-\d{2}-\d{2}T/);

		const successful = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		assert.equal(successful.statusCode, 200);

		const afterSuccess = await app.inject({
			method: 'GET',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(afterSuccess.statusCode, 200);
		assert.equal(afterSuccess.json().data[0].failedLoginCount, 0);
		assert.equal(afterSuccess.json().data[0].lockedUntil, undefined);
	});
});

test.skip('repeated failed session logins lock the user and audit failures generically', async () => {
	await withApp(
		async ({ app, token }) => {
			const firstFailure = await app.inject({
				method: 'POST',
				url: '/api/auth/login',
				payload: {
					username: 'admin',
					password: 'wrong-password'
				}
			});
			const secondFailure = await app.inject({
				method: 'POST',
				url: '/api/auth/login',
				payload: {
					username: 'admin',
					password: 'still-wrong'
				}
			});
			const lockedCorrectPassword = await app.inject({
				method: 'POST',
				url: '/api/auth/login',
				payload: {
					username: 'admin',
					password: 'test-admin-password'
				}
			});

			assert.equal(firstFailure.statusCode, 401);
			assert.equal(firstFailure.json().error.code, 'INVALID_CREDENTIALS');
			assert.equal(secondFailure.statusCode, 401);
			assert.equal(secondFailure.json().error.code, 'INVALID_CREDENTIALS');
			assert.equal(lockedCorrectPassword.statusCode, 401);
			assert.equal(lockedCorrectPassword.json().error.code, 'INVALID_CREDENTIALS');

			const users = await app.inject({
				method: 'GET',
				url: '/api/auth/users',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(users.statusCode, 200);
			assert.equal(users.json().data[0].failedLoginCount, 2);
			assert.match(users.json().data[0].lockedUntil, /^\d{4}-\d{2}-\d{2}T/);
			assert.equal(Date.parse(users.json().data[0].lockedUntil) > Date.now(), true);

			const audit = await app.inject({
				method: 'GET',
				url: '/api/audit?limit=5&action=auth.login',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(audit.statusCode, 200);
			assert.deepEqual(
				audit
					.json()
					.data.slice(0, 3)
					.map((event: { status: string }) => event.status),
				['failed', 'failed', 'failed']
			);
			assert.equal(audit.json().data[0].target, 'admin');
			assert.equal(audit.json().data[0].detail, 'Invalid username or password');
		},
		{ authMaxFailedLogins: 2, authLockoutMs: 60 * 1000 }
	);
});

test.skip('session users can change password and revoke other sessions', async () => {
	await withApp(async ({ app }) => {
		const loginA = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		const loginB = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		const tokenA = loginA.json().data.token;
		const tokenB = loginB.json().data.token;

		const changed = await app.inject({
			method: 'POST',
			url: '/api/auth/password',
			headers: { authorization: `Bearer ${tokenA}` },
			payload: {
				currentPassword: 'test-admin-password',
				newPassword: 'Changed-Ops-Key-2026!',
				revokeOtherSessions: true
			}
		});
		assert.equal(changed.statusCode, 200);
		assert.equal(changed.json().data.username, 'admin');

		const oldPassword = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		assert.equal(oldPassword.statusCode, 401);

		const newPassword = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'Changed-Ops-Key-2026!'
			}
		});
		assert.equal(newPassword.statusCode, 200);

		const revokedOtherSession = await app.inject({
			method: 'GET',
			url: '/api/auth/me',
			headers: { authorization: `Bearer ${tokenB}` }
		});
		assert.equal(revokedOtherSession.statusCode, 401);
	});
});

test.skip('session users cannot change to weak passwords', async () => {
	await withApp(async ({ app }) => {
		const login = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		assert.equal(login.statusCode, 200);
		const sessionToken = login.json().data.token;

		const rejected = await app.inject({
			method: 'POST',
			url: '/api/auth/password',
			headers: { authorization: `Bearer ${sessionToken}` },
			payload: {
				currentPassword: 'test-admin-password',
				newPassword: 'short-password',
				revokeOtherSessions: true
			}
		});
		assert.equal(rejected.statusCode, 400);
		assert.equal(rejected.json().error.code, 'PASSWORD_POLICY_VIOLATION');

		const audit = await app.inject({
			method: 'GET',
			url: '/api/audit?limit=5&action=auth.password',
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		assert.equal(audit.statusCode, 200);
		assert.equal(audit.json().data[0].action, 'auth.password.change');
		assert.equal(audit.json().data[0].status, 'failed');

		const oldPasswordStillWorks = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		assert.equal(oldPasswordStillWorks.statusCode, 200);
	});
});

test.skip('session listing and revoke require session ownership and exact confirmation', async () => {
	await withApp(async ({ app }) => {
		const loginA = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		const loginB = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'admin',
				password: 'test-admin-password'
			}
		});
		const tokenA = loginA.json().data.token;
		const tokenB = loginB.json().data.token;

		const sessions = await app.inject({
			method: 'GET',
			url: '/api/auth/sessions',
			headers: { authorization: `Bearer ${tokenA}` }
		});
		assert.equal(sessions.statusCode, 200);
		assert.equal(sessions.json().data.length >= 2, true);
		assert.equal(JSON.stringify(sessions.json()).includes('tokenHash'), false);
		const otherSession = sessions.json().data.find((item: { current: boolean }) => !item.current);

		const wrongConfirmation = await app.inject({
			method: 'DELETE',
			url: `/api/auth/sessions/${otherSession.id}`,
			headers: {
				authorization: `Bearer ${tokenA}`,
				'x-ops-confirmation': 'wrong-id'
			}
		});
		assert.equal(wrongConfirmation.statusCode, 400);

		const revoked = await app.inject({
			method: 'DELETE',
			url: `/api/auth/sessions/${otherSession.id}`,
			headers: {
				authorization: `Bearer ${tokenA}`,
				'x-ops-confirmation': otherSession.id
			}
		});
		assert.equal(revoked.statusCode, 200);
		assert.equal(revoked.json().data.revokedAt.length > 0, true);

		const denied = await app.inject({
			method: 'GET',
			url: '/api/auth/me',
			headers: { authorization: `Bearer ${tokenB}` }
		});
		assert.equal(denied.statusCode, 401);
	});
});

test.skip('admin users can be created and disabling requires exact user id confirmation', async () => {
	await withApp(async ({ app, token }) => {
		const created = await app.inject({
			method: 'POST',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				username: 'ops-admin',
				displayName: 'Ops Admin',
				password: 'Ops-User-Key-2026!'
			}
		});

		assert.equal(created.statusCode, 200);
		assert.equal(created.json().data.username, 'ops-admin');
		assert.equal(created.json().data.role, 'viewer');
		assert.equal(JSON.stringify(created.json()).includes('Ops-User-Key-2026!'), false);

		const userId = created.json().data.id;
		const wrongConfirmation = await app.inject({
			method: 'DELETE',
			url: `/api/auth/users/${userId}`,
			headers: {
				authorization: `Bearer ${token}`,
				'x-ops-confirmation': 'wrong-id'
			}
		});
		assert.equal(wrongConfirmation.statusCode, 400);

		const disabled = await app.inject({
			method: 'DELETE',
			url: `/api/auth/users/${userId}`,
			headers: {
				authorization: `Bearer ${token}`,
				'x-ops-confirmation': userId
			}
		});
		assert.equal(disabled.statusCode, 204);

		const login = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'ops-admin',
				password: 'Ops-User-Key-2026!'
			}
		});
		assert.equal(login.statusCode, 401);
	});
});

test.skip('session roles enforce viewer, operator, and admin boundaries', async () => {
	await withApp(async ({ app, token }) => {
		const viewer = await app.inject({
			method: 'POST',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				username: 'rbac-viewer',
				displayName: 'RBAC Viewer',
				role: 'viewer',
				password: 'Viewer-Role-Key-2026!'
			}
		});
		const operator = await app.inject({
			method: 'POST',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				username: 'rbac-operator',
				displayName: 'RBAC Operator',
				role: 'operator',
				password: 'Operator-Role-Key-2026!'
			}
		});

		assert.equal(viewer.statusCode, 200);
		assert.equal(viewer.json().data.role, 'viewer');
		assert.equal(operator.statusCode, 200);
		assert.equal(operator.json().data.role, 'operator');

		const viewerLogin = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'rbac-viewer',
				password: 'Viewer-Role-Key-2026!'
			}
		});
		const operatorLogin = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: {
				username: 'rbac-operator',
				password: 'Operator-Role-Key-2026!'
			}
		});
		const viewerToken = viewerLogin.json().data.token;
		const operatorToken = operatorLogin.json().data.token;

		const viewerCanReadConnections = await app.inject({
			method: 'GET',
			url: '/api/connections',
			headers: { authorization: `Bearer ${viewerToken}` }
		});
		const viewerCannotWriteExpenses = await app.inject({
			method: 'POST',
			url: '/api/expenses',
			headers: { authorization: `Bearer ${viewerToken}` },
			payload: {
				month: '2026-07',
				category: 'server',
				vendor: 'cloud',
				amount: 10,
				currency: 'CNY'
			}
		});
		const viewerCannotReadAudit = await app.inject({
			method: 'GET',
			url: '/api/audit',
			headers: { authorization: `Bearer ${viewerToken}` }
		});
		const operatorCanWriteExpenses = await app.inject({
			method: 'POST',
			url: '/api/expenses',
			headers: { authorization: `Bearer ${operatorToken}` },
			payload: {
				month: '2026-07',
				category: 'server',
				vendor: 'cloud',
				amount: 20,
				currency: 'CNY'
			}
		});
		const operatorCannotCreateConnections = await app.inject({
			method: 'POST',
			url: '/api/connections',
			headers: { authorization: `Bearer ${operatorToken}` },
			payload: {
				type: 'ssh',
				name: 'prod-shell',
				tags: [],
				config: {
					host: '127.0.0.1',
					port: 22,
					username: 'root',
					password: 'secret'
				}
			}
		});
		const operatorCannotListUsers = await app.inject({
			method: 'GET',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${operatorToken}` }
		});

		assert.equal(viewerCanReadConnections.statusCode, 200);
		assert.equal(viewerCannotWriteExpenses.statusCode, 403);
		assert.equal(viewerCannotWriteExpenses.json().error.code, 'FORBIDDEN_ROLE');
		assert.equal(viewerCannotReadAudit.statusCode, 403);
		assert.equal(operatorCanWriteExpenses.statusCode, 200);
		assert.equal(operatorCannotCreateConnections.statusCode, 403);
		assert.equal(operatorCannotListUsers.statusCode, 403);
	});
});

test.skip('admin user creation rejects weak passwords', async () => {
	await withApp(async ({ app, token }) => {
		const rejected = await app.inject({
			method: 'POST',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				username: 'weak-user',
				displayName: 'Weak User',
				password: 'weak-password'
			}
		});

		assert.equal(rejected.statusCode, 400);
		assert.equal(rejected.json().error.code, 'PASSWORD_POLICY_VIOLATION');
		assert.equal(
			rejected.json().error.details.issues.some((issue: string) => issue.includes('number')),
			true
		);

		const audit = await app.inject({
			method: 'GET',
			url: '/api/audit?limit=5&action=auth.user.create',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(audit.statusCode, 200);
		assert.equal(audit.json().data[0].status, 'failed');
		assert.equal(audit.json().data[0].target, 'weak-user');
	});
});

test('connection API lists configured presets and never echoes secrets', async () => {
	await withApp(
		async ({ app, token }) => {
			const listed = await app.inject({
				method: 'GET',
				url: '/api/connections?type=mysql',
				headers: { authorization: `Bearer ${token}` }
			});
			const create = await app.inject({
				method: 'POST',
				url: '/api/connections',
				headers: { authorization: `Bearer ${token}` },
				payload: {
					type: 'mysql',
					name: 'other-db',
					config: { host: '127.0.0.1', port: 3306, database: 'gang', user: 'ops', ssl: false }
				}
			});

			assert.equal(listed.statusCode, 200);
			assert.equal(listed.json().data.length, 1);
			assert.equal(listed.json().data[0].id, 'primary-db');
			assert.equal(listed.json().data[0].config.host, '127.0.0.1');
			assert.equal(listed.json().data[0].config.allowMutations, false);
			assert.equal(JSON.stringify(listed.json()).includes('secret-password'), false);
			assert.equal(create.statusCode, 409);
			assert.equal(create.json().error.code, 'CONNECTIONS_CONFIG_READ_ONLY');
		},
		{ connections: mysqlConnections() }
	);
});

test('connection delete is disabled for configured presets', async () => {
	await withApp(
		async ({ app, token }) => {
			const deleted = await app.inject({
				method: 'DELETE',
				url: '/api/connections/ssh-host',
				headers: { authorization: `Bearer ${token}`, 'x-ops-confirmation': 'ssh-host' }
			});
			assert.equal(deleted.statusCode, 409);
			assert.equal(deleted.json().error.code, 'CONNECTIONS_CONFIG_READ_ONLY');
		},
		{ connections: sshConnections() }
	);
});

test('S3 connection presets default to read-only writes disabled', async () => {
	await withApp(
		async ({ app, token }) => {
			const listed = await app.inject({
				method: 'GET',
				url: '/api/connections?type=s3',
				headers: { authorization: `Bearer ${token}` }
			});
			const updated = await app.inject({
				method: 'PUT',
				url: '/api/connections/readonly-s3',
				headers: { authorization: `Bearer ${token}` },
				payload: {
					type: 's3',
					name: 'write-objects',
					config: {
						endpoint: 'http://127.0.0.1:9000',
						region: 'auto',
						defaultBucket: 'logs',
						forcePathStyle: true,
						allowWrites: true
					}
				}
			});

			assert.equal(listed.statusCode, 200);
			assert.equal(listed.json().data[0].config.allowWrites, false);
			assert.equal(listed.json().data[0].config.defaultBucket, 'logs');
			assert.equal(JSON.stringify(listed.json()).includes('secret-key'), false);
			assert.equal(updated.statusCode, 409);
			assert.equal(updated.json().error.code, 'CONNECTIONS_CONFIG_READ_ONLY');
		},
		{ connections: s3Connections() }
	);
});

test.skip('admin backup export and restore are authenticated and confirmation gated', async () => {
	await withApp(async ({ app, token }) => {
		const denied = await app.inject({ method: 'GET', url: '/api/admin/backup' });
		assert.equal(denied.statusCode, 401);

		const exported = await app.inject({
			method: 'GET',
			url: '/api/admin/backup',
			headers: { authorization: `Bearer ${token}` }
		});
		const backup = exported.json().data;

		assert.equal(exported.statusCode, 200);
		assert.equal(backup.version, 1);
		assert.equal(backup.data.connections.presets.length, 0);

		const preview = await app.inject({
			method: 'POST',
			url: '/api/admin/restore/preview',
			headers: { authorization: `Bearer ${token}` },
			payload: { backup }
		});
		assert.equal(preview.statusCode, 200);
		assert.equal(preview.json().data.exportedAt, backup.exportedAt);
		assert.equal(preview.json().data.current.connections, 0);
		assert.equal(preview.json().data.incoming.connections, 0);
		assert.equal(preview.json().data.incoming.auditEvents >= 1, true);
		assert.deepEqual(preview.json().data.missingStores, []);

		const rejectedRestore = await app.inject({
			method: 'POST',
			url: '/api/admin/restore',
			headers: { authorization: `Bearer ${token}` },
			payload: { confirmation: 'NOPE', backup }
		});
		assert.equal(rejectedRestore.statusCode, 400);

		const restored = await app.inject({
			method: 'POST',
			url: '/api/admin/restore',
			headers: { authorization: `Bearer ${token}` },
			payload: { confirmation: 'RESTORE', backup }
		});
		assert.equal(restored.statusCode, 200);
	});
});

test.skip('admin backup restore validates inner store shape before writing', async () => {
	await withApp(async ({ app, token }) => {
		const exported = await app.inject({
			method: 'GET',
			url: '/api/admin/backup',
			headers: { authorization: `Bearer ${token}` }
		});
		const invalidBackup = exported.json().data;
		invalidBackup.data.connections = { presets: [{ id: 'broken', type: 'mysql', config: {} }] };

		const rejected = await app.inject({
			method: 'POST',
			url: '/api/admin/restore',
			headers: { authorization: `Bearer ${token}` },
			payload: { confirmation: 'RESTORE', backup: invalidBackup }
		});
		const rejectedPreview = await app.inject({
			method: 'POST',
			url: '/api/admin/restore/preview',
			headers: { authorization: `Bearer ${token}` },
			payload: { backup: invalidBackup }
		});
		assert.equal(rejected.statusCode, 400);
		assert.equal(rejected.json().error.code, 'VALIDATION_ERROR');
		assert.equal(rejectedPreview.statusCode, 400);
		assert.equal(rejectedPreview.json().error.code, 'VALIDATION_ERROR');

		const listed = await app.inject({
			method: 'GET',
			url: '/api/connections?type=mysql',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(listed.statusCode, 200);
		assert.equal(listed.json().data.length, 0);
	});
});

test.skip('agent jobs are persisted and approval-gated', async () => {
	await withApp(async ({ app, token }) => {
		const created = await app.inject({
			method: 'POST',
			url: '/api/agent/suggest',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				goal: 'inspect api latency',
				context: 'api host is slow after deploy'
			}
		});
		const job = created.json().data;

		assert.equal(created.statusCode, 200);
		assert.equal(job.status, 'suggested');
		assert.equal(job.goal, 'inspect api latency');

		const listed = await app.inject({
			method: 'GET',
			url: '/api/agent/jobs?status=suggested',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(listed.statusCode, 200);
		assert.equal(listed.json().data.length, 1);
		assert.equal(listed.json().data[0].id, job.id);

		const approved = await app.inject({
			method: 'POST',
			url: `/api/agent/jobs/${job.id}/approve`,
			headers: { authorization: `Bearer ${token}` },
			payload: {
				operatorNote: 'read-only checks approved',
				commands: [
					{
						label: 'Check API service status',
						command: 'systemctl status gang-api --no-pager',
						requiresApproval: true
					}
				]
			}
		});
		assert.equal(approved.statusCode, 200);
		assert.equal(approved.json().data.status, 'approved');
		assert.equal(approved.json().data.operatorNote, 'read-only checks approved');
		assert.deepEqual(approved.json().data.commands, [
			{
				label: 'Check API service status',
				command: 'systemctl status gang-api --no-pager',
				requiresApproval: true
			}
		]);

		const rejectedAgain = await app.inject({
			method: 'POST',
			url: `/api/agent/jobs/${job.id}/reject`,
			headers: { authorization: `Bearer ${token}` },
			payload: { operatorNote: 'too late' }
		});
		assert.equal(rejectedAgain.statusCode, 409);

		const audit = await app.inject({
			method: 'GET',
			url: '/api/audit?limit=10&action=agent.job',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(audit.statusCode, 200);
		assert.equal(audit.json().data[0].action, 'agent.job.approve');
		assert.equal(audit.json().data[0].target, job.id);
	});
});

test('agent approval validates operator-edited command lists', async () => {
	await withApp(async ({ app, token }) => {
		const created = await app.inject({
			method: 'POST',
			url: '/api/agent/suggest',
			headers: { authorization: `Bearer ${token}` },
			payload: { goal: 'inspect api worker' }
		});
		const jobId = created.json().data.id;

		const emptyCommands = await app.inject({
			method: 'POST',
			url: `/api/agent/jobs/${jobId}/approve`,
			headers: { authorization: `Bearer ${token}` },
			payload: { commands: [] }
		});
		assert.equal(emptyCommands.statusCode, 400);
		assert.equal(emptyCommands.json().error.code, 'VALIDATION_ERROR');

		const blankCommand = await app.inject({
			method: 'POST',
			url: `/api/agent/jobs/${jobId}/approve`,
			headers: { authorization: `Bearer ${token}` },
			payload: {
				commands: [{ label: 'Blank command', command: '', requiresApproval: true }]
			}
		});
		assert.equal(blankCommand.statusCode, 400);
		assert.equal(blankCommand.json().error.code, 'VALIDATION_ERROR');
	});
});

test('ai admin worker websocket receives config and drives ops runs', async () => {
	await withApp(async ({ app, token, agentWorkerToken }) => {
		await app.ready();
		let initPromise: Promise<Record<string, unknown>> | undefined;
		const worker = (await app.injectWS(
			`/ws/ai-admin-worker?token=${encodeURIComponent(agentWorkerToken)}`,
			{},
			{
				onInit(ws) {
					initPromise = nextJsonMessage(ws as unknown as TestWebSocket, 'worker init config');
				}
			}
		)) as unknown as TestWebSocket;

		try {
			const init = await initPromise!;
			assert.equal(init.type, 'init_config');
			assert.deepEqual(init.config, {
				baseUrl: 'https://llm.example.com/v1',
				apiKey: 'test-ai-key',
				model: 'ops-model',
				contextWindow: 256_000,
				compactAt: 0.9
			});

			worker.send(
				JSON.stringify({
					type: 'hello',
					workerId: 'ai-worker-test',
					version: 'test',
					apiBase: 'http://127.0.0.1:8787',
					hostname: 'test-host',
					execute: true,
					allowedCommands: ['*'],
					terminal: {
						available: true,
						username: 'test-user',
						shell: '/bin/sh',
						cwd: '/srv/app'
					}
				})
			);
			const listedWorker = await waitForWorker(app, token, 'ai-worker-test');
			assert.equal(listedWorker.transport, 'websocket');
			assert.equal(listedWorker.hostname, 'test-host');
			assert.equal(listedWorker.terminal?.available, true);
			assert.equal(listedWorker.terminal?.username, 'test-user');
			assert.equal(listedWorker.terminal?.shell, '/bin/sh');
			assert.equal(listedWorker.terminal?.cwd, '/srv/app');

			const ticketResponse = await app.inject({
				method: 'POST',
				url: '/api/agent/workers/ai-worker-test/terminal/ticket',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(ticketResponse.statusCode, 200);
			const ticket = ticketResponse.json().data.ticket as string;
			assert.ok(ticket);

			const terminalOpenPromise = nextJsonMessage(worker, 'terminal_open');
			const terminal = (await app.injectWS(
				`/ws/agent/workers/ai-worker-test/terminal?ticket=${encodeURIComponent(ticket)}&cols=90&rows=24`
			)) as unknown as TestWebSocket;
			const terminalOpen = await terminalOpenPromise;
			assert.equal(terminalOpen.type, 'terminal_open');
			assert.equal(terminalOpen.cols, 90);
			assert.equal(terminalOpen.rows, 24);
			const terminalId = terminalOpen.terminalId as string;
			assert.ok(terminalId);

			const terminalInputPromise = nextJsonMessage(worker, 'terminal_input');
			terminal.send(JSON.stringify({ type: 'input', data: 'pwd\n' }));
			const terminalInput = await terminalInputPromise;
			assert.equal(terminalInput.type, 'terminal_input');
			assert.equal(terminalInput.terminalId, terminalId);
			assert.equal(terminalInput.data, 'pwd\n');

			const terminalOutputPromise = nextJsonMessage(terminal, 'terminal_output');
			worker.send(
				JSON.stringify({
					type: 'terminal_output',
					terminalId,
					data: '/srv/app\r\n'
				})
			);
			const terminalOutput = await terminalOutputPromise;
			assert.deepEqual(terminalOutput, { type: 'data', data: '/srv/app\r\n' });

			const terminalStatusPromise = nextJsonMessage(terminal, 'terminal closed status');
			worker.send(JSON.stringify({ type: 'terminal_status', terminalId, status: 'closed' }));
			const terminalStatus = await terminalStatusPromise;
			assert.deepEqual(terminalStatus, { type: 'status', status: 'closed' });

			const createdSession = await app.inject({
				method: 'POST',
				url: '/api/agent/workers/ai-worker-test/sessions',
				headers: { authorization: `Bearer ${token}` },
				payload: {}
			});
			assert.equal(createdSession.statusCode, 200);
			const session = createdSession.json().data;
			assert.equal(session.workerId, 'ai-worker-test');
			assert.equal(session.name, 'New session');
			assert.equal(session.titleSource, 'auto');

			const listedSessions = await app.inject({
				method: 'GET',
				url: '/api/agent/workers/ai-worker-test/sessions',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(listedSessions.statusCode, 200);
			assert.equal(listedSessions.json().data[0].id, session.id);

			const promptPromise = nextJsonMessage(worker, 'ops prompt');
			const created = await app.inject({
				method: 'POST',
				url: '/api/agent/run',
				headers: { authorization: `Bearer ${token}` },
				payload: {
					workerId: 'ai-worker-test',
					sessionId: session.id,
					goal: 'inspect api latency'
				}
			});
			assert.equal(created.statusCode, 200);
			const run = created.json().data;
			assert.equal(run.status, 'queued');

			const titledSessions = await app.inject({
				method: 'GET',
				url: '/api/agent/workers/ai-worker-test/sessions',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(titledSessions.statusCode, 200);
			assert.equal(titledSessions.json().data[0].name, 'inspect api latency');

			const prompt = await promptPromise;
			assert.equal(prompt.type, 'prompt');
			const promptPayload = prompt.prompt as {
				runId: string;
				sessionId: string;
				goal: string;
			};
			assert.equal(promptPayload.runId, run.id);
			assert.equal(promptPayload.sessionId, session.id);
			assert.equal(promptPayload.goal, 'inspect api latency');

			worker.send(JSON.stringify({ type: 'run_started', runId: run.id }));
			worker.send(
				JSON.stringify({
					type: 'context_compacted',
					runId: run.id,
					message: 'Context compacted at threshold'
				})
			);
			worker.send(JSON.stringify({ type: 'text_delta', runId: run.id, text: 'check ' }));
			worker.send(JSON.stringify({ type: 'text_delta', runId: run.id, text: 'latency' }));
			worker.send(
				JSON.stringify({
					type: 'run_completed',
					runId: run.id,
					result: 'check latency'
				})
			);

			const completed = await waitForRunStatus(app, token, run.id, 'completed');
			assert.equal(completed.result, 'check latency');
			assert.ok(completed.events.some((event) => event.type === 'compact'));
			assert.equal(completed.events.at(-1)?.type, 'done');

			const sessionRuns = await app.inject({
				method: 'GET',
				url: `/api/agent/workers/ai-worker-test/sessions/${session.id}/runs`,
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(sessionRuns.statusCode, 200);
			assert.equal(sessionRuns.json().data[0].id, run.id);

			const deletedSession = await app.inject({
				method: 'DELETE',
				url: `/api/agent/workers/ai-worker-test/sessions/${session.id}`,
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(deletedSession.statusCode, 200);
			assert.equal(deletedSession.json().data.deleted, true);

			const sessionsAfterDelete = await app.inject({
				method: 'GET',
				url: '/api/agent/workers/ai-worker-test/sessions',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(sessionsAfterDelete.statusCode, 200);
			assert.equal(
				sessionsAfterDelete.json().data.some((item: { id: string }) => item.id === session.id),
				false
			);
		} finally {
			worker.terminate();
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	});
});

test.skip('agent worker API uses separate auth and records execution lifecycle', async () => {
	await withApp(async ({ app, token, agentWorkerToken }) => {
		const workerDeniedForAdmin = await app.inject({
			method: 'GET',
			url: '/api/agent/worker/jobs',
			headers: { authorization: `Bearer ${token}` }
		});
		const adminDeniedForWorker = await app.inject({
			method: 'GET',
			url: '/api/connections',
			headers: { authorization: `Bearer ${agentWorkerToken}` }
		});
		assert.equal(workerDeniedForAdmin.statusCode, 401);
		assert.equal(adminDeniedForWorker.statusCode, 401);

		const heartbeat = await app.inject({
			method: 'POST',
			url: '/api/agent/worker/heartbeat',
			headers: { authorization: `Bearer ${agentWorkerToken}` },
			payload: {
				workerId: 'pi-worker-01',
				apiBase: 'http://127.0.0.1:8787',
				hostname: 'pi-ops',
				version: '0.0.1',
				execute: false,
				allowedCommands: ['hostnamectl', 'uptime']
			}
		});
		assert.equal(heartbeat.statusCode, 200);
		assert.equal(heartbeat.json().data.id, 'pi-worker-01');

		const workers = await app.inject({
			method: 'GET',
			url: '/api/agent/workers',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(workers.statusCode, 200);
		assert.equal(workers.json().data.length, 1);
		assert.equal(workers.json().data[0].id, 'pi-worker-01');
		assert.equal(workers.json().data[0].hostname, 'pi-ops');
		assert.deepEqual(workers.json().data[0].allowedCommands, ['hostnamectl', 'uptime']);

		const created = await app.inject({
			method: 'POST',
			url: '/api/agent/suggest',
			headers: { authorization: `Bearer ${token}` },
			payload: { goal: 'restart stalled queue worker' }
		});
		const firstJobId = created.json().data.id;

		const emptyQueue = await app.inject({
			method: 'GET',
			url: '/api/agent/worker/jobs',
			headers: { authorization: `Bearer ${agentWorkerToken}` }
		});
		assert.equal(emptyQueue.statusCode, 200);
		assert.equal(emptyQueue.json().data.length, 0);

		const approved = await app.inject({
			method: 'POST',
			url: `/api/agent/jobs/${firstJobId}/approve`,
			headers: { authorization: `Bearer ${token}` },
			payload: { operatorNote: 'approved for worker execution' }
		});
		assert.equal(approved.statusCode, 200);
		assert.equal(approved.json().data.executionStatus, 'queued');

		const queue = await app.inject({
			method: 'GET',
			url: '/api/agent/worker/jobs?limit=5',
			headers: { authorization: `Bearer ${agentWorkerToken}` }
		});
		assert.equal(queue.statusCode, 200);
		assert.equal(queue.json().data.length, 1);
		assert.equal(queue.json().data[0].id, firstJobId);

		const started = await app.inject({
			method: 'POST',
			url: `/api/agent/worker/jobs/${firstJobId}/start`,
			headers: { authorization: `Bearer ${agentWorkerToken}` },
			payload: { workerId: 'pi-worker-01' }
		});
		assert.equal(started.statusCode, 200);
		assert.equal(started.json().data.executionStatus, 'running');
		assert.equal(started.json().data.workerId, 'pi-worker-01');

		const mismatchedComplete = await app.inject({
			method: 'POST',
			url: `/api/agent/worker/jobs/${firstJobId}/complete`,
			headers: { authorization: `Bearer ${agentWorkerToken}` },
			payload: { workerId: 'pi-worker-02', result: 'done' }
		});
		assert.equal(mismatchedComplete.statusCode, 409);
		assert.equal(mismatchedComplete.json().error.code, 'AGENT_JOB_WORKER_MISMATCH');

		const completed = await app.inject({
			method: 'POST',
			url: `/api/agent/worker/jobs/${firstJobId}/complete`,
			headers: { authorization: `Bearer ${agentWorkerToken}` },
			payload: {
				workerId: 'pi-worker-01',
				result: 'service restarted',
				commandResults: [
					{
						label: 'Restart service',
						command: 'systemctl restart queue-worker',
						exitCode: 0,
						stdout: 'ok'
					}
				]
			}
		});
		assert.equal(completed.statusCode, 200);
		assert.equal(completed.json().data.executionStatus, 'completed');
		assert.equal(completed.json().data.result, 'service restarted');
		assert.equal(completed.json().data.commandResults[0].exitCode, 0);

		const createdForFailure = await app.inject({
			method: 'POST',
			url: '/api/agent/suggest',
			headers: { authorization: `Bearer ${token}` },
			payload: { goal: 'inspect failed backup job' }
		});
		const secondJobId = createdForFailure.json().data.id;
		await app.inject({
			method: 'POST',
			url: `/api/agent/jobs/${secondJobId}/approve`,
			headers: { authorization: `Bearer ${token}` },
			payload: {}
		});
		await app.inject({
			method: 'POST',
			url: `/api/agent/worker/jobs/${secondJobId}/start`,
			headers: { authorization: `Bearer ${agentWorkerToken}` },
			payload: { workerId: 'pi-worker-01' }
		});
		const failed = await app.inject({
			method: 'POST',
			url: `/api/agent/worker/jobs/${secondJobId}/fail`,
			headers: { authorization: `Bearer ${agentWorkerToken}` },
			payload: { workerId: 'pi-worker-01', error: 'ssh permission denied' }
		});
		assert.equal(failed.statusCode, 200);
		assert.equal(failed.json().data.executionStatus, 'failed');
		assert.equal(failed.json().data.error, 'ssh permission denied');

		const audit = await app.inject({
			method: 'GET',
			url: '/api/audit?limit=10&action=agent.worker',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(audit.statusCode, 200);
		assert.deepEqual(
			audit.json().data.map((event: { action: string }) => event.action),
			['agent.worker.fail', 'agent.worker.start', 'agent.worker.complete', 'agent.worker.start']
		);
		assert.equal(audit.json().data[0].actor, 'pi-worker-01');
	});
});

test.skip('failed MySQL SQL attempts are audited', async () => {
	await withApp(
		async ({ app, token }) => {
			const connectionId = 'primary-db';

			const denied = await app.inject({
				method: 'POST',
				url: `/api/mysql/${connectionId}/query`,
				headers: { authorization: `Bearer ${token}` },
				payload: { sql: 'DELETE FROM users WHERE id = 1' }
			});
			const audit = await app.inject({
				method: 'GET',
				url: '/api/audit?limit=5',
				headers: { authorization: `Bearer ${token}` }
			});

			assert.equal(denied.statusCode, 400);
			assert.equal(denied.json().error.code, 'READ_ONLY_SQL');
			assert.equal(audit.statusCode, 200);
			assert.equal(audit.json().data[0].action, 'mysql.query');
			assert.equal(audit.json().data[0].status, 'failed');
			assert.equal(audit.json().data[0].target, connectionId);
		},
		{ connections: mysqlConnections() }
	);
});

test('MySQL mutations are blocked unless the preset explicitly allows writes', async () => {
	await withApp(
		async ({ app, token }) => {
			const connectionId = 'primary-db';

			const mutationSql = await app.inject({
				method: 'POST',
				url: `/api/mysql/${connectionId}/query`,
				headers: { authorization: `Bearer ${token}` },
				payload: {
					sql: 'DELETE FROM users WHERE id = 1',
					mode: 'allow-mutations',
					mutationConfirmation: 'RUN MUTATION'
				}
			});
			const insert = await app.inject({
				method: 'POST',
				url: `/api/mysql/${connectionId}/tables/users/rows`,
				headers: { authorization: `Bearer ${token}` },
				payload: { row: { name: 'alice' } }
			});

			assert.equal(mutationSql.statusCode, 403);
			assert.equal(mutationSql.json().error.code, 'MYSQL_MUTATIONS_DISABLED');
			assert.equal(insert.statusCode, 403);
			assert.equal(insert.json().error.code, 'MYSQL_MUTATIONS_DISABLED');
		},
		{ connections: mysqlConnections() }
	);
});

test('MySQL destructive operations require explicit confirmations before adapters run', async () => {
	await withApp(
		async ({ app, token }) => {
			const connectionId = 'write-db';

			const mutationSql = await app.inject({
				method: 'POST',
				url: `/api/mysql/${connectionId}/query`,
				headers: { authorization: `Bearer ${token}` },
				payload: {
					sql: 'DELETE FROM users WHERE id = 1',
					mode: 'allow-mutations',
					maxRows: 100,
					timeoutMs: 1000
				}
			});
			const wrongDeleteConfirmation = await app.inject({
				method: 'DELETE',
				url: `/api/mysql/${connectionId}/tables/users/rows`,
				headers: { authorization: `Bearer ${token}` },
				payload: {
					primaryKey: { id: 1 },
					confirmation: 'wrong-table'
				}
			});

			assert.equal(mutationSql.statusCode, 400);
			assert.equal(mutationSql.json().error.code, 'DESTRUCTIVE_CONFIRMATION_REQUIRED');
			assert.equal(wrongDeleteConfirmation.statusCode, 400);
			assert.equal(wrongDeleteConfirmation.json().error.code, 'DESTRUCTIVE_CONFIRMATION_REQUIRED');
		},
		{ connections: mysqlConnections(true) }
	);
});

test.skip('expense API validates body and returns monthly summary', async () => {
	await withApp(async ({ app, token }) => {
		const created = await app.inject({
			method: 'POST',
			url: '/api/expenses',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				month: '2026-07',
				category: 'server',
				vendor: 'cloud-a',
				amount: '42.5',
				currency: 'cny'
			}
		});

		assert.equal(created.statusCode, 200);
		assert.equal(created.json().data.amount, 42.5);
		const expenseId = created.json().data.id;

		const updated = await app.inject({
			method: 'PUT',
			url: `/api/expenses/${expenseId}`,
			headers: { authorization: `Bearer ${token}` },
			payload: {
				month: '2026-07',
				category: 'storage',
				vendor: 'cloud-a',
				amount: 52.75,
				currency: 'cny',
				note: 'object storage'
			}
		});

		const summary = await app.inject({
			method: 'GET',
			url: '/api/expenses/summary?month=2026-07',
			headers: { authorization: `Bearer ${token}` }
		});
		const audit = await app.inject({
			method: 'GET',
			url: '/api/audit?limit=10&status=ok&action=expense',
			headers: { authorization: `Bearer ${token}` }
		});

		assert.equal(updated.statusCode, 200);
		assert.equal(updated.json().data.category, 'storage');
		assert.equal(updated.json().data.amount, 52.75);
		assert.equal(summary.statusCode, 200);
		assert.equal(summary.json().data.total, 52.75);
		assert.equal(audit.statusCode, 200);
		assert.deepEqual(
			audit.json().data.map((event: { action: string }) => event.action),
			['expense.update', 'expense.create']
		);
	});
});

test('expense delete requires exact expense id confirmation', async () => {
	await withApp(async ({ app, token }) => {
		const created = await app.inject({
			method: 'POST',
			url: '/api/expenses',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				month: '2026-07',
				category: 'server',
				vendor: 'cloud-a',
				amount: 42,
				currency: 'CNY'
			}
		});
		assert.equal(created.statusCode, 200);
		const expenseId = created.json().data.id;

		const missingConfirmation = await app.inject({
			method: 'DELETE',
			url: `/api/expenses/${expenseId}`,
			headers: { authorization: `Bearer ${token}` }
		});
		const wrongConfirmation = await app.inject({
			method: 'DELETE',
			url: `/api/expenses/${expenseId}`,
			headers: { authorization: `Bearer ${token}`, 'x-ops-confirmation': 'wrong-id' }
		});
		const listedAfterRejectedDeletes = await app.inject({
			method: 'GET',
			url: '/api/expenses?month=2026-07',
			headers: { authorization: `Bearer ${token}` }
		});
		const deleted = await app.inject({
			method: 'DELETE',
			url: `/api/expenses/${expenseId}`,
			headers: { authorization: `Bearer ${token}`, 'x-ops-confirmation': expenseId }
		});

		assert.equal(missingConfirmation.statusCode, 400);
		assert.equal(missingConfirmation.json().error.code, 'DESTRUCTIVE_CONFIRMATION_REQUIRED');
		assert.equal(wrongConfirmation.statusCode, 400);
		assert.equal(wrongConfirmation.json().error.code, 'DESTRUCTIVE_CONFIRMATION_REQUIRED');
		assert.equal(listedAfterRejectedDeletes.statusCode, 200);
		assert.equal(listedAfterRejectedDeletes.json().data.length, 1);
		assert.equal(deleted.statusCode, 204);

		const listedAfterDelete = await app.inject({
			method: 'GET',
			url: '/api/expenses?month=2026-07',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(listedAfterDelete.statusCode, 200);
		assert.equal(listedAfterDelete.json().data.length, 0);
	});
});

test.skip('audit records request actor from x-ops-actor header with admin fallback', async () => {
	await withApp(async ({ app, token }) => {
		const created = await app.inject({
			method: 'POST',
			url: '/api/expenses',
			headers: {
				authorization: `Bearer ${token}`,
				'x-ops-actor': 'alice@example.com'
			},
			payload: {
				month: '2026-07',
				category: 'server',
				vendor: 'cloud-a',
				amount: 42,
				currency: 'cny'
			}
		});
		const fallback = await app.inject({
			method: 'POST',
			url: '/api/expenses',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				month: '2026-07',
				category: 'storage',
				vendor: 'cloud-b',
				amount: 12,
				currency: 'cny'
			}
		});
		const audit = await app.inject({
			method: 'GET',
			url: '/api/audit?limit=2&action=expense.create',
			headers: { authorization: `Bearer ${token}` }
		});

		assert.equal(created.statusCode, 200);
		assert.equal(fallback.statusCode, 200);
		assert.equal(audit.statusCode, 200);
		assert.equal(audit.json().data[0].actor, 'admin');
		assert.equal(audit.json().data[1].actor, 'alice@example.com');
	});
});

test.skip('audit integrity endpoint verifies signed runtime events', async () => {
	await withApp(async ({ app, token }) => {
		const denied = await app.inject({ method: 'GET', url: '/api/audit/integrity' });
		assert.equal(denied.statusCode, 401);

		const created = await app.inject({
			method: 'POST',
			url: '/api/expenses',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				month: '2026-07',
				category: 'server',
				vendor: 'cloud-a',
				amount: 100,
				currency: 'CNY'
			}
		});
		assert.equal(created.statusCode, 200);

		const integrity = await app.inject({
			method: 'GET',
			url: '/api/audit/integrity',
			headers: { authorization: `Bearer ${token}` }
		});

		assert.equal(integrity.statusCode, 200);
		assert.equal(integrity.json().data.valid, true);
		assert.equal(integrity.json().data.unsigned, 0);
		assert.equal(integrity.json().data.signed > 0, true);
		assert.equal(typeof integrity.json().data.headHash, 'string');
	});
});

test.skip('audit export returns events with an external checkpoint', async () => {
	await withApp(async ({ app, token }) => {
		const denied = await app.inject({ method: 'GET', url: '/api/audit/export' });
		assert.equal(denied.statusCode, 401);

		const created = await app.inject({
			method: 'POST',
			url: '/api/expenses',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				month: '2026-07',
				category: 'server',
				vendor: 'cloud-a',
				amount: 100,
				currency: 'CNY'
			}
		});
		assert.equal(created.statusCode, 200);

		const exported = await app.inject({
			method: 'GET',
			url: '/api/audit/export',
			headers: { authorization: `Bearer ${token}` }
		});

		assert.equal(exported.statusCode, 200);
		assert.equal(exported.json().data.version, 1);
		assert.match(exported.json().data.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
		assert.equal(exported.json().data.integrity.valid, true);
		assert.equal(exported.json().data.checkpoint.valid, true);
		assert.equal(exported.json().data.checkpoint.total, exported.json().data.events.length);
		assert.equal(exported.json().data.checkpoint.headHash, exported.json().data.integrity.headHash);
		assert.equal(exported.json().data.events[0].action, 'expense.create');
		assert.equal(typeof exported.json().data.events[0].hash, 'string');

		const audit = await app.inject({
			method: 'GET',
			url: '/api/audit?limit=1&action=audit.export',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(audit.statusCode, 200);
		assert.equal(audit.json().data[0].status, 'ok');
	});
});

test('SSH ticket API issues short-lived tickets without exposing admin token', async () => {
	await withApp(
		async ({ app, token }) => {
			const connectionId = 'ssh-host';

			const denied = await app.inject({
				method: 'POST',
				url: `/api/ssh/${connectionId}/ticket`
			});
			const ticket = await app.inject({
				method: 'POST',
				url: `/api/ssh/${connectionId}/ticket`,
				headers: { authorization: `Bearer ${token}` }
			});

			assert.equal(denied.statusCode, 401);
			assert.equal(ticket.statusCode, 200);
			assert.equal(typeof ticket.json().data.ticket, 'string');
			assert.equal(JSON.stringify(ticket.json()).includes(token), false);
			assert.match(ticket.json().data.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
		},
		{ connections: sshConnections() }
	);
});

test.skip('SSH ticket API requires host key fingerprints when configured', async () => {
	await withApp(
		async ({ app, token }) => {
			const ticket = await app.inject({
				method: 'POST',
				url: '/api/ssh/ssh-host/ticket',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(ticket.statusCode, 400);
			assert.equal(ticket.json().error.code, 'SSH_HOST_KEY_REQUIRED');

			const audit = await app.inject({
				method: 'GET',
				url: '/api/audit?limit=5&action=ssh.ticket',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(audit.statusCode, 200);
			assert.equal(audit.json().data[0].status, 'failed');
			assert.equal(audit.json().data[0].target, 'ssh-host');
		},
		{ sshRequireHostKeyVerification: true, connections: sshConnections(true) }
	);
});

test.skip('SSH active session control plane is operator gated and confirmation protected', async () => {
	await withApp(async ({ app, token }) => {
		const viewer = await app.inject({
			method: 'POST',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				username: 'ssh-viewer',
				displayName: 'SSH Viewer',
				role: 'viewer',
				password: 'Read-Only-Key-2026!'
			}
		});
		const operator = await app.inject({
			method: 'POST',
			url: '/api/auth/users',
			headers: { authorization: `Bearer ${token}` },
			payload: {
				username: 'ssh-operator',
				displayName: 'SSH Operator',
				role: 'operator',
				password: 'Run-Term-Key-2026!'
			}
		});
		assert.equal(viewer.statusCode, 200);
		assert.equal(operator.statusCode, 200);

		const viewerLogin = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: { username: 'ssh-viewer', password: 'Read-Only-Key-2026!' }
		});
		const operatorLogin = await app.inject({
			method: 'POST',
			url: '/api/auth/login',
			payload: { username: 'ssh-operator', password: 'Run-Term-Key-2026!' }
		});
		const viewerToken = viewerLogin.json().data.token;
		const operatorToken = operatorLogin.json().data.token;

		const viewerDenied = await app.inject({
			method: 'GET',
			url: '/api/ssh/sessions',
			headers: { authorization: `Bearer ${viewerToken}` }
		});
		const listed = await app.inject({
			method: 'GET',
			url: '/api/ssh/sessions',
			headers: { authorization: `Bearer ${operatorToken}` }
		});
		const unconfirmedDelete = await app.inject({
			method: 'DELETE',
			url: '/api/ssh/sessions/missing-session',
			headers: { authorization: `Bearer ${operatorToken}` }
		});
		const missingDelete = await app.inject({
			method: 'DELETE',
			url: '/api/ssh/sessions/missing-session',
			headers: {
				authorization: `Bearer ${operatorToken}`,
				'x-ops-confirmation': 'missing-session'
			}
		});

		assert.equal(viewerDenied.statusCode, 403);
		assert.equal(viewerDenied.json().error.code, 'FORBIDDEN_ROLE');
		assert.equal(listed.statusCode, 200);
		assert.deepEqual(listed.json().data, []);
		assert.equal(unconfirmedDelete.statusCode, 400);
		assert.equal(unconfirmedDelete.json().error.code, 'DESTRUCTIVE_CONFIRMATION_REQUIRED');
		assert.equal(missingDelete.statusCode, 404);
		assert.equal(missingDelete.json().error.code, 'SSH_SESSION_NOT_FOUND');
	});
});

test('S3 writes are blocked unless the preset explicitly allows writes', async () => {
	await withApp(
		async ({ app, token }) => {
			const connectionId = 'readonly-s3';

			const upload = await app.inject({
				method: 'POST',
				url: `/api/s3/${connectionId}/objects`,
				headers: { authorization: `Bearer ${token}` }
			});
			const deleted = await app.inject({
				method: 'DELETE',
				url: `/api/s3/${connectionId}/objects`,
				headers: { authorization: `Bearer ${token}` },
				payload: { bucket: 'logs', key: 'prod/app.log', confirmation: 'prod/app.log' }
			});

			assert.equal(upload.statusCode, 403);
			assert.equal(upload.json().error.code, 'S3_WRITES_DISABLED');
			assert.equal(deleted.statusCode, 403);
			assert.equal(deleted.json().error.code, 'S3_WRITES_DISABLED');
		},
		{ connections: s3Connections() }
	);
});

test('S3 release sync lists configured GitHub releases', async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async (input) => {
		assert.equal(
			String(input),
			'https://api.github.com/repos/LoganZ2/gang-chat-admin/releases'
		);
		return new Response(
			JSON.stringify([
				{
					id: 101,
					tag_name: 'v1.2.3',
					name: 'v1.2.3',
					html_url: 'https://github.com/LoganZ2/gang-chat-admin/releases/tag/v1.2.3',
					published_at: '2026-07-03T00:00:00Z',
					prerelease: false,
					draft: false,
					assets: [
						{ id: 1, name: 'app-mac-a.dmg', size: 12, url: 'https://api.github.com/assets/1' },
						{ id: 2, name: 'app-mac-b.dmg', size: 13, url: 'https://api.github.com/assets/2' },
						{ id: 3, name: 'app-win-a.exe', size: 14, url: 'https://api.github.com/assets/3' },
						{ id: 4, name: 'app.zip', size: 15, url: 'https://api.github.com/assets/4' }
					]
				},
				{
					id: 102,
					tag_name: 'draft',
					draft: true,
					assets: []
				}
			]),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	}) as typeof fetch;
	try {
		await withApp(
			async ({ app, token }) => {
				const config = await app.inject({
					method: 'GET',
					url: '/api/s3/write-s3/release-sync',
					headers: { authorization: `Bearer ${token}` }
				});
				const releases = await app.inject({
					method: 'GET',
					url: '/api/s3/write-s3/release-sync/releases',
					headers: { authorization: `Bearer ${token}` }
				});

				assert.equal(config.statusCode, 200);
				assert.equal(config.json().data.enabled, true);
				assert.equal(config.json().data.repository, 'LoganZ2/gang-chat-admin');
				assert.equal(config.json().data.targetPrefix, 'releases/current/');
				assert.equal(config.json().data.assetPrefix, 'GangChat');
				assert.equal(releases.statusCode, 200);
				assert.deepEqual(releases.json().data, [
					{
						id: 101,
						tagName: 'v1.2.3',
						name: 'v1.2.3',
						htmlUrl: 'https://github.com/LoganZ2/gang-chat-admin/releases/tag/v1.2.3',
						publishedAt: '2026-07-03T00:00:00Z',
						prerelease: false,
						assetCount: 2
					}
				]);
			},
			{
				connections: s3Connections(true),
				releaseSync: {
					repositoryUrl: 'https://github.com/LoganZ2/gang-chat-admin',
					owner: 'LoganZ2',
					repo: 'gang-chat-admin',
					targetPrefix: 'releases/current/',
					assetPrefix: 'GangChat'
				}
			}
		);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test('S3 routes validate object inputs before hitting storage adapters', async () => {
	await withApp(async ({ app, token }) => {
		const listMissingBucket = await app.inject({
			method: 'GET',
			url: '/api/s3/s3-conn/objects?prefix=logs/',
			headers: { authorization: `Bearer ${token}` }
		});
		const downloadMissingKey = await app.inject({
			method: 'GET',
			url: '/api/s3/s3-conn/objects/download?bucket=logs',
			headers: { authorization: `Bearer ${token}` }
		});
		const headMissingKey = await app.inject({
			method: 'GET',
			url: '/api/s3/s3-conn/objects/head?bucket=logs',
			headers: { authorization: `Bearer ${token}` }
		});
		const headUnsafeKey = await app.inject({
			method: 'GET',
			url: '/api/s3/s3-conn/objects/head?bucket=logs&key=/prod/app.log',
			headers: { authorization: `Bearer ${token}` }
		});
		const deleteMissingKey = await app.inject({
			method: 'DELETE',
			url: '/api/s3/s3-conn/objects',
			headers: { authorization: `Bearer ${token}` },
			payload: { bucket: 'logs' }
		});
		const deleteWrongConfirmation = await app.inject({
			method: 'DELETE',
			url: '/api/s3/s3-conn/objects',
			headers: { authorization: `Bearer ${token}` },
			payload: { bucket: 'logs', key: 'prod/app.log', confirmation: 'wrong-key' }
		});
		const releaseSyncMissingTag = await app.inject({
			method: 'POST',
			url: '/api/s3/s3-conn/release-sync',
			headers: { authorization: `Bearer ${token}` },
			payload: { bucket: 'logs' }
		});

		assert.equal(listMissingBucket.statusCode, 400);
		assert.equal(downloadMissingKey.statusCode, 400);
		assert.equal(headMissingKey.statusCode, 400);
		assert.equal(headUnsafeKey.statusCode, 400);
		assert.equal(deleteMissingKey.statusCode, 400);
		assert.equal(deleteWrongConfirmation.statusCode, 400);
		assert.equal(releaseSyncMissingTag.statusCode, 400);
		assert.equal(listMissingBucket.json().error.code, 'VALIDATION_ERROR');
		assert.equal(downloadMissingKey.json().error.code, 'VALIDATION_ERROR');
		assert.equal(headMissingKey.json().error.code, 'VALIDATION_ERROR');
		assert.equal(headUnsafeKey.json().error.code, 'VALIDATION_ERROR');
		assert.equal(deleteMissingKey.json().error.code, 'VALIDATION_ERROR');
		assert.equal(deleteWrongConfirmation.json().error.code, 'DESTRUCTIVE_CONFIRMATION_REQUIRED');
		assert.equal(releaseSyncMissingTag.json().error.code, 'VALIDATION_ERROR');
	});
});
