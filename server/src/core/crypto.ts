import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

export function encryptJson(value: unknown, key: Buffer) {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();

	return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptJson<T>(value: string | undefined, key: Buffer, fallback: T): T {
	if (!value) return fallback;
	const [version, ivRaw, tagRaw, payloadRaw] = value.split(':');
	if (version !== 'v1' || !ivRaw || !tagRaw || !payloadRaw) {
		throw new Error('Invalid encrypted secret payload');
	}

	const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivRaw, 'base64'));
	decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
	const decrypted = Buffer.concat([
		decipher.update(Buffer.from(payloadRaw, 'base64')),
		decipher.final()
	]);
	return JSON.parse(decrypted.toString('utf8')) as T;
}
