import test from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeSshHostKeySha256,
	parseTerminalMessage,
	verifySshHostKeySha256
} from '../src/modules/ssh/ssh.routes';

test('SSH terminal parser accepts bounded input and ping messages', () => {
	assert.deepEqual(parseTerminalMessage('ls -la'), { type: 'input', data: 'ls -la' });
	assert.deepEqual(parseTerminalMessage(JSON.stringify({ type: 'ping' })), { type: 'ping' });
	assert.deepEqual(parseTerminalMessage(JSON.stringify({ type: 'input', data: 'whoami' })), {
		type: 'input',
		data: 'whoami'
	});
});

test('SSH terminal parser validates resize boundaries', () => {
	assert.deepEqual(parseTerminalMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 32 })), {
		type: 'resize',
		cols: 120,
		rows: 32
	});
	assert.equal(
		parseTerminalMessage(JSON.stringify({ type: 'resize', cols: 10, rows: 32 })),
		undefined
	);
	assert.equal(
		parseTerminalMessage(JSON.stringify({ type: 'resize', cols: 120.5, rows: 32 })),
		undefined
	);
});

test('SSH terminal parser rejects oversized input payloads', () => {
	const tooLarge = 'x'.repeat(64 * 1024 + 1);

	assert.equal(parseTerminalMessage(tooLarge), undefined);
	assert.equal(parseTerminalMessage(JSON.stringify({ type: 'input', data: tooLarge })), undefined);
});

test('SSH host key verifier normalizes pinned SHA256 fingerprints', () => {
	assert.equal(normalizeSshHostKeySha256(' SHA256:AbCdEf123= '), 'AbCdEf123=');
	assert.equal(normalizeSshHostKeySha256('aa:bb:cc'), 'aabbcc');
	assert.equal(verifySshHostKeySha256('SHA256:AbCdEf123=', 'AbCdEf123='), true);
	assert.equal(verifySshHostKeySha256('AA:BB:CC', 'aabbcc'), true);
	assert.equal(verifySshHostKeySha256('SHA256:expected', 'actual'), false);
	assert.equal(verifySshHostKeySha256(undefined, 'actual'), false);
});
