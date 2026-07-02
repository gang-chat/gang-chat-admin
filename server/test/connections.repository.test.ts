import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConnectionsRepository } from '../src/modules/connections/connections.repository';

async function withRepository(fn: (repository: ConnectionsRepository) => Promise<void>) {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-connections-'));
	const key = Buffer.from('12345678901234567890123456789012');
	const repository = new ConnectionsRepository(dataDir, key);
	try {
		await fn(repository);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
}

test('connection updates preserve existing secrets when secret fields are omitted', async () => {
	await withRepository(async (repository) => {
		const created = await repository.create({
			type: 'mysql',
			name: 'primary',
			tags: ['prod'],
			config: {
				host: '127.0.0.1',
				port: 3306,
				database: 'gang',
				user: 'ops',
				password: 'secret-password',
				ssl: false
			}
		});

		await repository.update(created.id, {
			type: 'mysql',
			name: 'primary-renamed',
			tags: ['prod', 'critical'],
			config: {
				host: 'db.internal',
				port: 3306,
				database: 'gang',
				user: 'ops',
				ssl: true
			}
		});

		const withSecrets = await repository.getWithSecrets(created.id);

		assert.equal(withSecrets.name, 'primary-renamed');
		assert.equal('host' in withSecrets.config ? withSecrets.config.host : undefined, 'db.internal');
		assert.deepEqual(withSecrets.secrets, { password: 'secret-password' });
	});
});
