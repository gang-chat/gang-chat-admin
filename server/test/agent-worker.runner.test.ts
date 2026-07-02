import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentJob } from '../../src/lib/shared/ops-types';
import {
	createOutputCollector,
	runAgentJob,
	runCommand,
	validateCommandPolicy
} from '../src/agent-worker/runner';

function jobWithCommand(command: string): AgentJob {
	return {
		id: 'job-1',
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		status: 'approved',
		executionStatus: 'running',
		goal: 'test command',
		summary: 'test command',
		risk: 'low',
		commands: [{ label: 'test', command, requiresApproval: false }],
		notes: []
	};
}

test('agent worker dry-run returns command evidence without executing', async () => {
	const result = await runAgentJob(jobWithCommand('exit 42'), {
		execute: false,
		commandTimeoutMs: 1000,
		maxOutputBytes: 1000
	});

	assert.equal(result.success, true);
	assert.match(result.result, /Dry-run/);
	assert.equal(result.commandResults[0].exitCode, null);
	assert.equal(result.commandResults[0].stderr, 'dry-run mode');
});

test('agent worker executes approved commands and captures stdout', async () => {
	const result = await runAgentJob(jobWithCommand('node -e "console.log(123)"'), {
		execute: true,
		commandTimeoutMs: 5000,
		maxOutputBytes: 1000,
		policy: { allowedCommands: ['node'] }
	});

	assert.equal(result.success, true);
	assert.equal(result.commandResults[0].exitCode, 0);
	assert.match(result.commandResults[0].stdout ?? '', /123/);
});

test('agent worker marks non-zero command results as failed', async () => {
	const result = await runAgentJob(jobWithCommand('node -e "process.exit(7)"'), {
		execute: true,
		commandTimeoutMs: 5000,
		maxOutputBytes: 1000,
		policy: { allowedCommands: ['node'] }
	});

	assert.equal(result.success, false);
	assert.equal(result.commandResults[0].exitCode, 7);
});

test('agent worker truncates command output', async () => {
	const collector = createOutputCollector(5);
	collector.append(Buffer.from('1234567890'));
	assert.equal(collector.value(), '12345\n[output truncated at 5 bytes]');
});

test('agent worker rejects execution when command policy fails', async () => {
	const result = await runAgentJob(jobWithCommand('node -e "console.log(123)"'), {
		execute: true,
		commandTimeoutMs: 5000,
		maxOutputBytes: 1000,
		policy: { allowedCommands: [] }
	});

	assert.equal(result.success, false);
	assert.match(result.result, /worker policy/);
	assert.equal(result.commandResults[0].exitCode, null);
	assert.match(result.commandResults[0].stderr ?? '', /allowlist/);
});

test('agent worker command policy blocks unapproved executables and shell chaining', () => {
	assert.equal(validateCommandPolicy('node -v', { allowedCommands: ['node'] }), '');
	assert.match(
		validateCommandPolicy('powershell Get-Process', { allowedCommands: ['node'] }),
		/not allowed/
	);
	assert.match(
		validateCommandPolicy('node -v && whoami', { allowedCommands: ['node'] }),
		/shell chaining/
	);
	assert.match(
		validateCommandPolicy('node -e "console.log(1)" > out.txt', { allowedCommands: ['node'] }),
		/shell chaining/
	);
});

test('agent worker command policy supports explicit full access wildcard', () => {
	assert.equal(
		validateCommandPolicy('node -v && whoami > /tmp/worker-policy-test', {
			allowedCommands: ['*']
		}),
		''
	);
	assert.equal(
		validateCommandPolicy('some-unlisted-binary --flag', { allowedCommands: ['*'] }),
		''
	);
});

test('agent worker times out long-running commands', async () => {
	const result = await runCommand('node -e "setTimeout(() => {}, 5000)"', {
		timeoutMs: 100,
		maxOutputBytes: 1000
	});

	assert.equal(result.exitCode, null);
	assert.match(result.stderr ?? '', /timed out/);
});
