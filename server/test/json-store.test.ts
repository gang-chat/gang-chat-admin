import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { JsonStore } from '../src/store/json-store';

type CounterState = {
	count: number;
	items: number[];
};

async function withStore(fn: (store: JsonStore<CounterState>, filePath: string) => Promise<void>) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'gang-ops-json-store-'));
	const filePath = path.join(dir, 'state.json');
	try {
		await fn(new JsonStore(filePath, { count: 0, items: [] }), filePath);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
	}
}

test('json store serializes concurrent read-modify-write updates', async () => {
	await withStore(async (store) => {
		await Promise.all(
			Array.from({ length: 50 }, async (_, index) =>
				store.update(async (state) => {
					await setTimeout(index % 3);
					state.count += 1;
					state.items.push(index);
				})
			)
		);

		const state = await store.read();

		assert.equal(state.count, 50);
		assert.equal(state.items.length, 50);
		assert.equal(new Set(state.items).size, 50);
	});
});

test('json store keeps the previous committed version as a backup', async () => {
	await withStore(async (store, filePath) => {
		await store.write({ count: 1, items: [1] });
		await store.write({ count: 2, items: [1, 2] });

		const current = JSON.parse(await readFile(filePath, 'utf8')) as CounterState;
		const backup = JSON.parse(await readFile(`${filePath}.bak`, 'utf8')) as CounterState;

		assert.deepEqual(current, { count: 2, items: [1, 2] });
		assert.deepEqual(backup, { count: 1, items: [1] });
	});
});

test('json store serializes updates across separate store instances', async () => {
	await withStore(async (_store, filePath) => {
		const left = new JsonStore<CounterState>(filePath, { count: 0, items: [] });
		const right = new JsonStore<CounterState>(filePath, { count: 0, items: [] });

		await Promise.all(
			Array.from({ length: 40 }, async (_, index) => {
				const store = index % 2 === 0 ? left : right;
				await store.update(async (state) => {
					await setTimeout(index % 5);
					state.count += 1;
					state.items.push(index);
				});
			})
		);

		const state = await left.read();
		assert.equal(state.count, 40);
		assert.equal(state.items.length, 40);
		assert.equal(new Set(state.items).size, 40);
	});
});

test('json store removes stale lock directories before writing', async () => {
	await withStore(async (_store, filePath) => {
		const staleStore = new JsonStore<CounterState>(
			filePath,
			{ count: 0, items: [] },
			{ staleLockMs: 10, lockTimeoutMs: 200, lockPollMs: 5 }
		);
		const lockDir = `${filePath}.lock`;
		await mkdir(lockDir, { recursive: true });
		const oldDate = new Date(Date.now() - 60_000);
		await utimes(lockDir, oldDate, oldDate);

		await staleStore.write({ count: 1, items: [1] });
		const state = await staleStore.read();

		assert.deepEqual(state, { count: 1, items: [1] });
	});
});

test('json store times out while a fresh lock is held', async () => {
	await withStore(async (_store, filePath) => {
		const lockedStore = new JsonStore<CounterState>(
			filePath,
			{ count: 0, items: [] },
			{ staleLockMs: 60_000, lockTimeoutMs: 30, lockPollMs: 5 }
		);
		await mkdir(`${filePath}.lock`, { recursive: true });

		await assert.rejects(
			() => lockedStore.write({ count: 1, items: [1] }),
			(error: Error & { code?: string }) => error.code === 'JSON_STORE_LOCK_TIMEOUT'
		);
	});
});
