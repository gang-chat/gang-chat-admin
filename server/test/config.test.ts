import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config/config';

test('loadConfig reads explicit config file', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-config-'));
	try {
		const configPath = path.join(dir, 'config.json');
		await writeFile(configPath, JSON.stringify(baseConfig(), null, 2), 'utf8');
		await withArgv(['node', 'test', '--config', configPath], async () => {
			const config = await loadConfig();
			assert.equal(config.bootstrapAdminUser, 'admin');
			assert.equal(config.bootstrapAdminPassword, 'test-admin-password');
			assert.deepEqual(config.aiAdminWorker, {
				baseUrl: 'https://llm.example.com/v1',
				apiKey: 'test-ai-key',
				model: 'ops-model'
			});
			assert.deepEqual(config.releaseSync, {
				repositoryUrl: 'https://github.com/LoganZ2/gang-chat-admin',
				owner: 'LoganZ2',
				repo: 'gang-chat-admin',
				targetPrefix: 'releases/current/',
				assetNames: {
					dmg: 'GangChat.dmg',
					exe: 'GangChat.exe'
				},
				githubToken: undefined
			});
			assert.equal(config.connections.ssh.length, 0);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('loadConfig applies defaults for operational settings', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-config-'));
	try {
		const configPath = path.join(dir, 'config.json');
		await writeFile(configPath, JSON.stringify(minimalConfig(), null, 2), 'utf8');
		await withArgv(['node', 'test', '--config', configPath], async () => {
			const config = await loadConfig();
			assert.equal(config.nodeEnv, 'development');
			assert.equal(config.host, '127.0.0.1');
			assert.equal(config.port, 8787);
			assert.equal(config.dataDir, path.join(dir, '.ops-data'));
			assert.equal(config.rateLimitMax, 600);
			assert.equal(config.releaseSync, null);
			assert.equal(config.connections.mysql, null);
			assert.equal(config.connections.s3, null);
			assert.deepEqual(config.connections.ssh, []);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('loadConfig rejects missing admin password', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-config-'));
	try {
		const configPath = path.join(dir, 'config.json');
		const config = baseConfig() as Record<string, unknown>;
		delete config.adminPassword;
		await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
		await withArgv(['node', 'test', '--config', configPath], async () => {
			await assert.rejects(loadConfig(), /adminPassword is required/);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('loadConfig rejects insecure production cors origin', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-config-'));
	try {
		const configPath = path.join(dir, 'config.json');
		const config = {
			...baseConfig(),
			mode: 'production',
			adminPassword: 'Initial-Ops-Key-2026!',
			corsOrigin: ['http://ops.example.com']
		};
		await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
		await withArgv(['node', 'test', '--config', configPath], async () => {
			await assert.rejects(loadConfig(), /corsOrigin must use https in production/);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function withArgv(argv: string[], fn: () => Promise<void>) {
	const previous = process.argv;
	process.argv = argv;
	try {
		await fn();
	} finally {
		process.argv = previous;
	}
}

function baseConfig() {
	return {
		mode: 'test',
		host: '127.0.0.1',
		port: 8787,
		corsOrigin: ['http://localhost:8787'],
		dataDir: './data',
		agentWorkerToken: 'test-agent-worker-token',
		secretKey: '12345678901234567890123456789012',
		logLevel: 'info',
		bodyLimitBytes: 1024,
		uploadLimitBytes: 1024,
		rateLimitMax: 10,
		rateLimitWindow: '1 minute',
		trustProxy: false,
		sshMaxSessions: 2,
		sshIdleTimeoutMs: 1000,
		sshReadyTimeoutMs: 1000,
		sshKeepaliveIntervalMs: 1000,
		sshTicketTtlMs: 1000,
		sshRequireHostKeyVerification: false,
		sessionTtlMs: 1000,
		sessionIdleTimeoutMs: 1000,
		adminUsername: 'admin',
		adminPassword: 'test-admin-password',
		authMaxFailedLogins: 5,
		authLockoutMs: 1000,
		aiAdminWorker: {
			baseUrl: 'https://llm.example.com/v1/',
			apiKey: 'test-ai-key',
			model: 'ops-model'
		},
		releaseSync: {
			repositoryUrl: 'https://github.com/LoganZ2/gang-chat-admin',
			targetPrefix: 'releases/current',
			assetNames: {
				dmg: 'GangChat.dmg',
				exe: 'GangChat.exe'
			}
		},
		connections: { mysql: null, s3: null, ssh: [] }
	};
}

function minimalConfig() {
	return {
		agentWorkerToken: 'test-agent-worker-token',
		secretKey: '12345678901234567890123456789012',
		adminUsername: 'admin',
		adminPassword: 'test-admin-password',
		aiAdminWorker: {
			baseUrl: 'https://llm.example.com/v1/',
			apiKey: 'test-ai-key',
			model: 'ops-model'
		}
	};
}
