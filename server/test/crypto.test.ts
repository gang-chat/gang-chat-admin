import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptJson, encryptJson } from '../src/core/crypto';

test('encryptJson stores decryptable but non-plaintext payloads', () => {
	const key = Buffer.from('12345678901234567890123456789012');
	const payload = { password: 'secret', nested: { ok: true } };

	const encrypted = encryptJson(payload, key);

	assert.match(encrypted, /^v1:/);
	assert.equal(encrypted.includes('secret'), false);
	assert.deepEqual(decryptJson(encrypted, key, {}), payload);
});
