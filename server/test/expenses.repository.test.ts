import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExpensesRepository } from '../src/modules/expenses/expenses.repository';
import { HttpError } from '../src/core/http';

test('expenses repository persists entries and computes category summary', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-expenses-'));
	try {
		const repo = new ExpensesRepository(dir);
		await repo.create({
			month: '2026-07',
			category: 'server',
			vendor: 'cloud-a',
			amount: 100,
			currency: 'CNY'
		});
		await repo.create({
			month: '2026-07',
			category: 'storage',
			vendor: 's3',
			amount: 25,
			currency: 'CNY'
		});
		await repo.create({
			month: '2026-06',
			category: 'server',
			vendor: 'cloud-a',
			amount: 70,
			currency: 'CNY'
		});

		const july = await repo.list('2026-07');
		const summary = await repo.summary('2026-07');

		assert.equal(july.length, 2);
		assert.equal(summary.total, 125);
		assert.deepEqual(summary.byCategory, [
			{ category: 'storage', total: 25 },
			{ category: 'server', total: 100 }
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('expenses repository rejects invalid month and negative amount', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-expenses-'));
	try {
		const repo = new ExpensesRepository(dir);
		await assert.rejects(
			() =>
				repo.create({
					month: '2026/07',
					category: 'server',
					vendor: 'cloud-a',
					amount: 100,
					currency: 'CNY'
				}),
			(error) => error instanceof HttpError && error.code === 'INVALID_MONTH'
		);

		await assert.rejects(
			() =>
				repo.create({
					month: '2026-07',
					category: 'server',
					vendor: 'cloud-a',
					amount: -1,
					currency: 'CNY'
				}),
			(error) => error instanceof HttpError && error.code === 'INVALID_AMOUNT'
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
