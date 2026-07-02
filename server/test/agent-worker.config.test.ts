import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadAgentWorkerConfig } from '../src/agent-worker/config';

test('agent worker config is loaded from standalone worker config file', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-worker-config-'));
	try {
		const configPath = path.join(dir, 'worker.json');
		await writeFile(configPath, JSON.stringify(baseWorkerConfig(), null, 2), 'utf8');
		await withArgv(['node', 'test', '--worker-config', configPath], async () => {
			const env = await loadAgentWorkerConfig();
			assert.equal(env.apiBase, 'http://127.0.0.1:8787');
			assert.equal(env.token, 'worker-token');
			assert.equal(env.workerId, 'pi-local');
			assert.equal(env.execute, false);
			assert.deepEqual(env.allowedCommands, []);
			assert.equal(env.workingDirectory, undefined);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('agent worker config supports env overrides and full access wildcard', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-worker-config-'));
	try {
		const configPath = path.join(dir, 'worker.json');
		await writeFile(configPath, JSON.stringify(baseWorkerConfig(), null, 2), 'utf8');
		await withEnv(
			{
				AI_ADMIN_WORKER_TOKEN: 'env-worker-token',
				AI_ADMIN_WORKER_EXECUTE: 'true',
				AI_ADMIN_WORKER_ALLOWED_COMMANDS: '*',
				AI_ADMIN_WORKER_WORKING_DIRECTORY: '/srv/ops'
			},
			async () => {
				await withArgv(['node', 'test', '--worker-config', configPath], async () => {
					const env = await loadAgentWorkerConfig();
					assert.equal(env.token, 'env-worker-token');
					assert.equal(env.execute, true);
					assert.deepEqual(env.allowedCommands, ['*']);
					assert.equal(env.workingDirectory, '/srv/ops');
				});
			}
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('agent worker config requires commands for real execution', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-worker-config-'));
	try {
		const configPath = path.join(dir, 'worker.json');
		const config = baseWorkerConfig();
		config.execute = true;
		await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
		await withArgv(['node', 'test', '--worker-config', configPath], async () => {
			await assert.rejects(loadAgentWorkerConfig(), /allowedCommands is required/);
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

async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	try {
		await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function baseWorkerConfig() {
	return {
		apiBase: 'http://127.0.0.1:8787/',
		token: 'worker-token',
		workerId: 'pi-local',
		pollMs: 5000,
		execute: false,
		once: false,
		commandTimeoutMs: 60000,
		maxOutputBytes: 200000,
		allowedCommands: [] as string[],
		workingDirectory: null as string | null
	};
}
