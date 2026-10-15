import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { S3Client } from '@aws-sdk/client-s3';
import { buildApp } from '../src/app';
import type { ServerConfig } from '../src/config/config';

async function withApp(
	fn: (context: {
		app: Awaited<ReturnType<typeof buildApp>>;
		token: string;
		dataDir: string;
	}) => Promise<void>,
	envOverrides: Partial<ServerConfig> = {}
) {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-api-'));
	const baseEnv: ServerConfig = {
		host: '127.0.0.1',
		port: 0,
		basePath: '',
		corsOrigin: ['http://localhost:8787'],
		dataDir,
		secretKey: Buffer.from('12345678901234567890123456789012'),
		nodeEnv: 'test',
		logLevel: 'info',
		bodyLimitBytes: 20 * 1024 * 1024,
		uploadLimitBytes: 100 * 1024 * 1024,
		rateLimitMax: 1000,
		rateLimitWindow: '1 minute',
		trustProxy: false,
		sessionTtlMs: 12 * 60 * 60 * 1000,
		sessionIdleTimeoutMs: 30 * 60 * 1000,
		bootstrapAdminUser: 'admin',
		bootstrapAdminPassword: 'test-admin-password',
		authMaxFailedLogins: 5,
		authLockoutMs: 15 * 60 * 1000,
		releaseSync: null,
		connections: { mysql: null, s3: null }
	};
	const env: ServerConfig = { ...baseEnv, ...envOverrides };
	const app = await buildApp(env);
	try {
		const login = await app.inject({
			method: 'POST',
			url: apiPath(env, '/api/auth/login'),
			payload: { username: 'admin', password: 'test-admin-password' }
		});
		const token = login.json().data.token as string;
		await fn({ app, token, dataDir });
	} finally {
		await app.close();
		await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
	}
}

function apiPath(env: ServerConfig, path: string) {
	return `${env.basePath}${path}`;
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
		s3: null
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
		}
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

test('basePath scopes backend API routes', async () => {
	await withApp(
		async ({ app }) => {
			const health = await app.inject({ method: 'GET', url: '/admin/api/health' });
			const rootHealth = await app.inject({ method: 'GET', url: '/api/health' });
			const denied = await app.inject({ method: 'GET', url: '/admin/api/connections' });

			assert.equal(health.statusCode, 200);
			assert.equal(rootHealth.statusCode, 404);
			assert.equal(denied.statusCode, 401);
			assert.equal(denied.json().error.code, 'UNAUTHORIZED');
		},
		{ basePath: '/admin' }
	);
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
				type: 'mysql',
				name: 'other-db',
				tags: [],
				config: { host: '127.0.0.1', port: 3306, database: 'gang', user: 'ops', ssl: false }
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
				url: '/api/connections/primary-db',
				headers: { authorization: `Bearer ${token}`, 'x-ops-confirmation': 'primary-db' }
			});
			assert.equal(deleted.statusCode, 409);
			assert.equal(deleted.json().error.code, 'CONNECTIONS_CONFIG_READ_ONLY');
		},
		{ connections: mysqlConnections() }
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
		assert.equal(String(input), 'https://api.github.com/repos/LoganZ2/gang-chat-admin/releases');
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
						{ id: 4, name: 'app.zip', size: 15, url: 'https://api.github.com/assets/4' },
						{ id: 5, name: 'app-android.apk', size: 16, url: 'https://api.github.com/assets/5' }
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
						assetCount: 3
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

function releaseSyncFetch(appcastXml: string): typeof fetch {
	const assets = [
		// Listed first on purpose: the sync must still upload it last.
		{ id: 9, name: 'appcast.xml', size: appcastXml.length, url: 'https://api.github.com/assets/9' },
		{ id: 1, name: 'GangChat_v1.2.3.dmg', size: 3, url: 'https://api.github.com/assets/1' },
		{ id: 2, name: 'GangChat_v1.2.3.exe', size: 3, url: 'https://api.github.com/assets/2' },
		{ id: 3, name: 'GangChat_v1.2.3.apk', size: 3, url: 'https://api.github.com/assets/3' }
	];
	return (async (input) => {
		const url = String(input);
		if (url.endsWith('/releases/tags/v1.2.3')) {
			return Response.json({ id: 101, tag_name: 'v1.2.3', assets });
		}
		if (url === 'https://api.github.com/assets/9') return new Response(appcastXml);
		if (url.startsWith('https://api.github.com/assets/')) return new Response('bin');
		throw new Error(`unexpected fetch ${url}`);
	}) as typeof fetch;
}

function recordS3Commands() {
	const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
	const send = mock.method(S3Client.prototype, 'send', async (command: unknown) => {
		const { constructor, input } = command as {
			constructor: { name: string };
			input: Record<string, unknown>;
		};
		sent.push({ command: constructor.name, input });
		if (constructor.name === 'ListObjectsV2Command') {
			return {
				Contents: [{ Key: 'releases/GangChat_v1.2.2.dmg' }, { Key: 'releases/appcast.xml' }]
			};
		}
		return { ETag: '"etag"' };
	});
	return { sent, restore: () => send.mock.restore() };
}

const releaseSyncEnv = {
	connections: s3Connections(true),
	releaseSync: {
		repositoryUrl: 'https://github.com/gang-chat/gang-chat-client',
		owner: 'gang-chat',
		repo: 'gang-chat-client',
		targetPrefix: 'releases/',
		assetPrefix: 'GangChat'
	}
};

const appcastFor = (dmgUrl: string) =>
	`<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>` +
	`<enclosure url="${dmgUrl}" type="application/octet-stream" sparkle:edSignature="sig" length="3"/>` +
	`</item></channel></rss>`;

test('S3 release sync uploads installers before the Sparkle appcast', async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = releaseSyncFetch(
		appcastFor('https://os.ky-z.com:9000/gang-chat/releases/GangChat_v1.2.3.dmg')
	);
	const s3 = recordS3Commands();
	try {
		await withApp(async ({ app, token }) => {
			const response = await app.inject({
				method: 'POST',
				url: '/api/s3/write-s3/release-sync',
				headers: { authorization: `Bearer ${token}` },
				payload: { bucket: 'gang-chat', tagName: 'v1.2.3' }
			});

			assert.equal(response.statusCode, 200);
			assert.equal(response.json().data.deleted, 2);
			assert.deepEqual(
				s3.sent.map(({ command, input }) => `${command} ${input.Key ?? input.Prefix}`),
				[
					'ListObjectsV2Command releases/',
					'DeleteObjectCommand releases/GangChat_v1.2.2.dmg',
					'DeleteObjectCommand releases/appcast.xml',
					'PutObjectCommand releases/GangChat_v1.2.3.dmg',
					'PutObjectCommand releases/GangChat_v1.2.3.exe',
					'PutObjectCommand releases/GangChat_v1.2.3.apk',
					'PutObjectCommand releases/appcast.xml'
				]
			);
			const appcastPut = s3.sent.at(-1)!.input;
			assert.equal(appcastPut.ContentType, 'application/xml');
			assert.equal(appcastPut.CacheControl, 'no-cache');
		}, releaseSyncEnv);
	} finally {
		s3.restore();
		globalThis.fetch = previousFetch;
	}
});

test('S3 release sync leaves the bucket alone when the appcast points elsewhere', async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = releaseSyncFetch(
		appcastFor('https://os.ky-z.com:9000/gang-chat/releases/GangChat_v1.2.2.dmg')
	);
	const s3 = recordS3Commands();
	try {
		await withApp(async ({ app, token }) => {
			const response = await app.inject({
				method: 'POST',
				url: '/api/s3/write-s3/release-sync',
				headers: { authorization: `Bearer ${token}` },
				payload: { bucket: 'gang-chat', tagName: 'v1.2.3' }
			});

			assert.equal(response.statusCode, 400);
			assert.equal(response.json().error.code, 'RELEASE_APPCAST_MISMATCH');
			assert.deepEqual(s3.sent, []);
		}, releaseSyncEnv);
	} finally {
		s3.restore();
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

test('account admin needs the Gang Chat MySQL preset', async () => {
	await withApp(async ({ app, token }) => {
		const listed = await app.inject({
			method: 'GET',
			url: '/api/accounts',
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(listed.statusCode, 409);
		assert.equal(listed.json().error.code, 'ACCOUNTS_UNAVAILABLE');
	});
});

test('account changes are blocked unless the MySQL preset allows writes', async () => {
	await withApp(
		async ({ app, token }) => {
			const created = await app.inject({
				method: 'POST',
				url: '/api/accounts',
				headers: { authorization: `Bearer ${token}` },
				payload: { username: 'new_user', email: 'new@example.test', password: 'long-enough-1' }
			});
			const removed = await app.inject({
				method: 'DELETE',
				url: '/api/accounts/u-1/memberships/r-1',
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(created.statusCode, 403);
			assert.equal(created.json().error.code, 'MYSQL_MUTATIONS_DISABLED');
			assert.equal(removed.statusCode, 403);
			assert.equal(removed.json().error.code, 'MYSQL_MUTATIONS_DISABLED');
		},
		{ connections: mysqlConnections() }
	);
});

test('account input is validated like the Gang Chat server before touching MySQL', async () => {
	await withApp(
		async ({ app, token }) => {
			const badUsername = await app.inject({
				method: 'POST',
				url: '/api/accounts',
				headers: { authorization: `Bearer ${token}` },
				payload: { username: 'no spaces', email: 'a@example.test', password: 'long-enough-1' }
			});
			const shortPassword = await app.inject({
				method: 'POST',
				url: '/api/accounts/u-1/password',
				headers: { authorization: `Bearer ${token}` },
				payload: { password: 'short' }
			});
			const badRole = await app.inject({
				method: 'PATCH',
				url: '/api/accounts/u-1/memberships/r-1',
				headers: { authorization: `Bearer ${token}` },
				payload: { role: 'superuser' }
			});
			assert.equal(badUsername.statusCode, 400);
			assert.match(badUsername.json().error.message, /Username must be 3-32/);
			assert.equal(shortPassword.statusCode, 400);
			assert.match(shortPassword.json().error.message, /8-256 characters/);
			assert.equal(badRole.statusCode, 400);
			assert.equal(badRole.json().error.code, 'VALIDATION_ERROR');
		},
		{ connections: mysqlConnections(true) }
	);
});
