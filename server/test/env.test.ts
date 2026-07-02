import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadEnv } from '../src/config/env';

const ENV_KEYS = [
	'NODE_ENV',
	'OPS_ADMIN_TOKEN',
	'OPS_AGENT_WORKER_TOKEN',
	'OPS_BOOTSTRAP_ADMIN_USER',
	'OPS_BOOTSTRAP_ADMIN_PASSWORD',
	'OPS_SECRET_KEY',
	'OPS_DATA_DIR',
	'OPS_CORS_ORIGIN',
	'OPS_ALLOW_INSECURE_CORS_ORIGIN'
];

async function withIsolatedEnv(fn: (dataDir: string) => Promise<void>) {
	const snapshot = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-env-'));
	try {
		for (const key of ENV_KEYS) delete process.env[key];
		process.env.NODE_ENV = 'production';
		process.env.OPS_SECRET_KEY = 'production-secret-key-32-bytes-minimum';
		process.env.OPS_ADMIN_TOKEN = 'production-admin-token-32-bytes-ok';
		process.env.OPS_AGENT_WORKER_TOKEN = 'production-worker-token-32-bytes-ok';
		process.env.OPS_DATA_DIR = dataDir;
		process.env.OPS_CORS_ORIGIN = 'https://ops.example.com';
		await fn(dataDir);
	} finally {
		for (const key of ENV_KEYS) {
			const value = snapshot.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(dataDir, { recursive: true, force: true });
	}
}

test('production env rejects short admin and worker tokens', async () => {
	await withIsolatedEnv(async () => {
		process.env.OPS_ADMIN_TOKEN = 'short-token';
		await assert.rejects(loadEnv(), /OPS_ADMIN_TOKEN must be at least 32 characters/);

		process.env.OPS_ADMIN_TOKEN = 'production-admin-token-32-bytes-ok';
		process.env.OPS_AGENT_WORKER_TOKEN = 'short-worker';
		await assert.rejects(loadEnv(), /OPS_AGENT_WORKER_TOKEN must be at least 32 characters/);
	});
});

test('production env validates bootstrap admin password policy', async () => {
	await withIsolatedEnv(async () => {
		process.env.OPS_BOOTSTRAP_ADMIN_USER = 'admin';
		process.env.OPS_BOOTSTRAP_ADMIN_PASSWORD = 'admin-password';
		await assert.rejects(loadEnv(), /OPS_BOOTSTRAP_ADMIN_PASSWORD violates password policy/);

		process.env.OPS_BOOTSTRAP_ADMIN_PASSWORD = 'Initial-Ops-Key-2026!';
		const env = await loadEnv();
		assert.equal(env.bootstrapAdminPassword, 'Initial-Ops-Key-2026!');
		assert.equal(env.sshRequireHostKeyVerification, true);
	});
});

test('production env requires explicit safe CORS origins', async () => {
	await withIsolatedEnv(async () => {
		delete process.env.OPS_CORS_ORIGIN;
		await assert.rejects(loadEnv(), /OPS_CORS_ORIGIN is required in production/);

		process.env.OPS_CORS_ORIGIN = '*';
		await assert.rejects(loadEnv(), /OPS_CORS_ORIGIN cannot contain \*/);

		process.env.OPS_CORS_ORIGIN = 'http://ops.example.com';
		await assert.rejects(loadEnv(), /OPS_CORS_ORIGIN must use https in production/);

		process.env.OPS_ALLOW_INSECURE_CORS_ORIGIN = 'true';
		const env = await loadEnv();
		assert.deepEqual(env.corsOrigin, ['http://ops.example.com']);
	});
});
