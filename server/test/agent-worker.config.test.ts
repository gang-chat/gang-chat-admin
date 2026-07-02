import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentWorkerEnv } from '../src/agent-worker/config';

const ENV_KEYS = [
	'OPS_AGENT_WORKER_TOKEN',
	'OPS_API_BASE',
	'OPS_AGENT_WORKER_ID',
	'OPS_AGENT_WORKER_POLL_MS',
	'OPS_AGENT_WORKER_EXECUTE',
	'OPS_AGENT_WORKER_ONCE',
	'OPS_AGENT_WORKER_COMMAND_TIMEOUT_MS',
	'OPS_AGENT_WORKER_MAX_OUTPUT_BYTES',
	'OPS_AGENT_WORKER_ALLOW_COMMANDS',
	'OPS_AGENT_WORKER_CWD'
];

function withAgentWorkerEnv(fn: () => void) {
	const snapshot = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const key of ENV_KEYS) delete process.env[key];
		process.env.OPS_AGENT_WORKER_TOKEN = 'worker-token';
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			const value = snapshot.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test('agent worker config keeps dry-run usable without an allowlist', () => {
	withAgentWorkerEnv(() => {
		const env = loadAgentWorkerEnv();

		assert.equal(env.execute, false);
		assert.deepEqual(env.allowedCommands, []);
		assert.equal(env.apiBase, 'http://127.0.0.1:8787');
	});
});

test('agent worker config requires an allowlist for real execution', () => {
	withAgentWorkerEnv(() => {
		process.env.OPS_AGENT_WORKER_EXECUTE = 'true';
		assert.throws(loadAgentWorkerEnv, /OPS_AGENT_WORKER_ALLOW_COMMANDS is required/);

		process.env.OPS_AGENT_WORKER_ALLOW_COMMANDS = 'hostnamectl, uptime, df';
		process.env.OPS_AGENT_WORKER_CWD = '/srv/ops';
		const env = loadAgentWorkerEnv();
		assert.equal(env.execute, true);
		assert.deepEqual(env.allowedCommands, ['hostnamectl', 'uptime', 'df']);
		assert.equal(env.workingDirectory, '/srv/ops');
	});
});
