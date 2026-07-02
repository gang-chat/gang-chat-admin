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
		s3: null,
		ssh: [
			{
				id: 'pi-1',
				type: 'ssh',
				name: 'Pi 1',
				config: { host: '10.0.0.2', port: 22, username: 'pi', password: 'raspberry' }
			}
		]
	});

	const mysql = await repository.list('mysql');
	const ssh = await repository.list('ssh');
	const withSecrets = await repository.getWithSecrets('main-db');

	assert.equal(mysql.length, 1);
	assert.equal(ssh.length, 1);
	assert.equal(mysql[0].id, 'main-db');
	assert.equal('password' in mysql[0].config, false);
	assert.deepEqual(withSecrets.secrets, { password: 'secret-password' });
});

test('connection repository rejects runtime mutation', async () => {
	const repository = new ConnectionsRepository({ mysql: null, s3: null, ssh: [] });
	await assert.rejects(
		repository.create({
			type: 'ssh',
			name: 'new ssh',
			config: { host: '127.0.0.1', port: 22, username: 'root' }
		}),
		/Connection presets are configured in config.json/
	);
});
