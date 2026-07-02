import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export type JsonStoreLockOptions = {
	lockTimeoutMs?: number;
	lockPollMs?: number;
	staleLockMs?: number;
};

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 25;
const DEFAULT_STALE_LOCK_MS = 120_000;

export class JsonStore<T extends object> {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly filePath: string,
		private readonly initialState: T,
		private readonly lockOptions: JsonStoreLockOptions = {}
	) {}

	async read(): Promise<T> {
		return this.enqueue(() =>
			withStoreFileLock(this.filePath, () => this.readUnlocked(), this.lockOptions)
		);
	}

	async write(value: T) {
		return this.enqueue(() =>
			withStoreFileLock(this.filePath, () => this.writeUnlocked(value), this.lockOptions)
		);
	}

	async update(mutator: (state: T) => void | Promise<void>) {
		return this.enqueue(() =>
			withStoreFileLock(
				this.filePath,
				async () => {
					const state = await this.readUnlocked();
					await mutator(state);
					await this.writeUnlocked(state);
					return state;
				},
				this.lockOptions
			)
		);
	}

	private async enqueue<R>(operation: () => Promise<R>) {
		const run = this.queue.then(operation, operation);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async readUnlocked(): Promise<T> {
		try {
			const content = await readFile(this.filePath, 'utf8');
			return JSON.parse(content) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				await this.writeUnlocked(this.initialState);
				return structuredClone(this.initialState);
			}
			throw error;
		}
	}

	private async writeUnlocked(value: T) {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		const content = `${JSON.stringify(value, null, 2)}\n`;
		let shouldCleanTmp = true;
		try {
			const handle = await open(tmp, 'w');
			try {
				await handle.writeFile(content, 'utf8');
				await handle.sync();
			} finally {
				await handle.close();
			}
			JSON.parse(await readFile(tmp, 'utf8'));
			await this.backupCurrent();
			await rename(tmp, this.filePath);
			shouldCleanTmp = false;
		} finally {
			if (shouldCleanTmp) await rm(tmp, { force: true }).catch(() => undefined);
		}
	}

	private async backupCurrent() {
		try {
			await copyFile(this.filePath, `${this.filePath}.bak`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}

export async function withStoreFileLock<R>(
	filePath: string,
	operation: () => Promise<R>,
	options: JsonStoreLockOptions = {}
) {
	const release = await acquireStoreFileLock(filePath, options);
	try {
		return await operation();
	} finally {
		await release();
	}
}

export async function acquireStoreFileLock(
	filePath: string,
	options: JsonStoreLockOptions = {}
): Promise<() => Promise<void>> {
	const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const pollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
	const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
	const lockDir = `${filePath}.lock`;
	const ownerFile = path.join(lockDir, 'owner.json');
	const startedAt = Date.now();

	await mkdir(path.dirname(filePath), { recursive: true });
	for (;;) {
		try {
			await mkdir(lockDir);
			let released = false;
			const heartbeat = setInterval(
				() => {
					void writeLockOwner(ownerFile);
				},
				Math.max(1000, Math.floor(staleLockMs / 3))
			);
			heartbeat.unref?.();
			await writeLockOwner(ownerFile);
			return async () => {
				if (released) return;
				released = true;
				clearInterval(heartbeat);
				await rm(lockDir, { recursive: true, force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await isStaleLock(lockDir, ownerFile, staleLockMs)) {
				await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				const lockError = new Error(`Timed out waiting for JSON store lock: ${filePath}`);
				(lockError as NodeJS.ErrnoException).code = 'JSON_STORE_LOCK_TIMEOUT';
				throw lockError;
			}
			await sleep(pollMs);
		}
	}
}

async function writeLockOwner(ownerFile: string) {
	await writeFile(
		ownerFile,
		`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
		'utf8'
	).catch(() => undefined);
}

async function isStaleLock(lockDir: string, ownerFile: string, staleLockMs: number) {
	try {
		const info = await stat(ownerFile).catch(async (error) => {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			return stat(lockDir);
		});
		return Date.now() - info.mtimeMs > staleLockMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw error;
	}
}

export function storePath(dataDir: string, name: string) {
	return path.join(dataDir, `${name}.json`);
}
