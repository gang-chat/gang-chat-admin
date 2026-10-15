import { randomBytes } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';

// The Gang Chat server verifies passwords with github.com/alexedwards/argon2id,
// which reads the parameters back out of the hash. These match its
// DefaultParams (64 MiB, one pass, 16-byte salt, 32-byte key); parallelism is
// fixed rather than tied to the host's CPU count.
const ARGON2_VERSION = 19;
const MEMORY_KIB = 64 * 1024;
const ITERATIONS = 1;
const PARALLELISM = 2;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

/** Hashes a password in the `$argon2id$v=19$m=…,t=…,p=…$salt$key` form Gang Chat stores. */
export async function hashGangPassword(password: string) {
	const salt = randomBytes(SALT_LENGTH);
	const key = await argon2idAsync(password, salt, {
		m: MEMORY_KIB,
		t: ITERATIONS,
		p: PARALLELISM,
		dkLen: KEY_LENGTH,
		version: ARGON2_VERSION
	});
	return [
		'',
		'argon2id',
		`v=${ARGON2_VERSION}`,
		`m=${MEMORY_KIB},t=${ITERATIONS},p=${PARALLELISM}`,
		rawBase64(salt),
		rawBase64(key)
	].join('$');
}

// Go's base64.RawStdEncoding: standard alphabet without padding.
function rawBase64(bytes: Uint8Array) {
	return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
}
