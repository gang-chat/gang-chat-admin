import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionsRepository } from '../src/modules/connections/connections.repository';

test('connection repository exposes configured presets with secrets', async () => {
	const repository = new ConnectionsRepository({
		mysql: {
			id: 'main-db',
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
		},
		s3: {
			id: 'main-s3',
			type: 's3',
			name: 'objects',
			config: {
				endpoint: 'http://127.0.0.1:9000',
				region: 'auto',
				defaultBucket: 'gang',
				forcePathStyle: true,
				allowWrites: false,
				accessKeyId: 'access-key',
				secretAccessKey: 'secret-key'
			}
		}
	});

	const mysql = await repository.list('mysql');
	const s3 = await repository.list('s3');
	const withSecrets = await repository.getWithSecrets('main-db');

	assert.equal(mysql.length, 1);
	assert.equal(s3.length, 1);
	assert.equal('secretAccessKey' in s3[0].config, false);
	assert.equal(mysql[0].id, 'main-db');
	assert.equal('password' in mysql[0].config, false);
	assert.deepEqual(withSecrets.secrets, { password: 'secret-password' });
});

test('connection repository rejects runtime mutation', async () => {
	const repository = new ConnectionsRepository({ mysql: null, s3: null });
	await assert.rejects(
		repository.create({
			type: 'mysql',
			name: 'new db',
			config: { host: '127.0.0.1', port: 3306, database: 'gang', user: 'ops', ssl: false }
		}),
		/Connection presets are configured in config.json/
	);
});
