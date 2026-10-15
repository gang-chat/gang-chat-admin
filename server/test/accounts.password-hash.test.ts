import test from 'node:test';
import assert from 'node:assert/strict';
import { argon2id } from '@noble/hashes/argon2.js';
import { hashGangPassword } from '../src/modules/accounts/password-hash';

test('account passwords use the argon2id format the Gang Chat server verifies', async () => {
	const hash = await hashGangPassword('Correct-Horse-9 密码');
	const [, algorithm, version, params, salt, key] = hash.split('$');
	assert.equal(algorithm, 'argon2id');
	assert.equal(version, 'v=19');
	assert.equal(params, 'm=65536,t=1,p=2');
	// Go's base64.RawStdEncoding: no padding.
	assert.equal(salt.includes('='), false);
	assert.equal(Buffer.from(salt, 'base64').length, 16);
	assert.equal(Buffer.from(key, 'base64').length, 32);

	const recomputed = argon2id('Correct-Horse-9 密码', Buffer.from(salt, 'base64'), {
		m: 65536,
		t: 1,
		p: 2,
		dkLen: 32
	});
	assert.equal(Buffer.from(recomputed).toString('base64').replace(/=+$/, ''), key);
	assert.notEqual(await hashGangPassword('Correct-Horse-9 密码'), hash);
});
