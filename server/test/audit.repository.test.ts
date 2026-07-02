import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditRepository } from '../src/modules/audit/audit.repository';

async function withAuditRepository(
	fn: (repository: AuditRepository, filePath: string) => Promise<void>
) {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-audit-'));
	const key = Buffer.from('12345678901234567890123456789012');
	try {
		await fn(new AuditRepository(dataDir, key), path.join(dataDir, 'audit.json'));
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
}

test('audit repository signs records as a verifiable hash chain', async () => {
	await withAuditRepository(async (repository) => {
		await repository.record({
			action: 'connection.create',
			target: 'mysql-primary',
			status: 'ok'
		});
		await repository.record({
			action: 'mysql.query',
			target: 'mysql-primary',
			status: 'failed',
			detail: 'mutation confirmation missing'
		});

		const events = await repository.list();
		const integrity = await repository.integrity();

		assert.equal(events.length, 2);
		assert.equal(typeof events[0].hash, 'string');
		assert.equal(events[0].previousHash, events[1].hash);
		assert.equal(integrity.valid, true);
		assert.equal(integrity.signed, 2);
		assert.equal(integrity.unsigned, 0);
		assert.equal(integrity.headHash, events[0].hash);
	});
});

test('audit repository detects tampered signed events', async () => {
	await withAuditRepository(async (repository, filePath) => {
		const event = await repository.record({
			action: 's3.delete',
			target: 'bucket/object.txt',
			status: 'ok'
		});
		const state = JSON.parse(await readFile(filePath, 'utf8')) as {
			events: Array<{ id: string; status: string }>;
		};
		state.events[0].status = 'failed';
		await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

		const integrity = await repository.integrity();

		assert.equal(integrity.valid, false);
		assert.equal(integrity.brokenAt, event.id);
		assert.equal(integrity.reason, 'hash-mismatch');
	});
});

test('audit repository reports legacy unsigned events without failing the chain', async () => {
	await withAuditRepository(async (repository, filePath) => {
		await writeFile(
			filePath,
			`${JSON.stringify(
				{
					events: [
						{
							id: 'legacy-1',
							at: '2026-07-01T00:00:00.000Z',
							actor: 'admin',
							action: 'legacy.event',
							target: 'runtime-store',
							status: 'ok'
						}
					]
				},
				null,
				2
			)}\n`,
			'utf8'
		);

		const integrity = await repository.integrity();

		assert.equal(integrity.valid, true);
		assert.equal(integrity.total, 1);
		assert.equal(integrity.signed, 0);
		assert.equal(integrity.unsigned, 1);
	});
});
