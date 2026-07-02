import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
	BackupPayload,
	BackupStoreSummary,
	RestorePreview
} from '../../../../src/lib/shared/ops-types';
import { acquireStoreFileLock, storePath } from '../../store/json-store';

const STORE_DEFAULTS = {
	connections: { presets: [] },
	audit: { events: [] },
	expenses: { entries: [] },
	agent: { jobs: [] },
	auth: { users: [], sessions: [] }
} as const;

type StoreName = keyof typeof STORE_DEFAULTS;

export class AdminService {
	constructor(private readonly dataDir: string) {}

	async exportBackup(): Promise<BackupPayload> {
		return {
			version: 1,
			exportedAt: new Date().toISOString(),
			data: {
				connections: await this.readStore('connections'),
				audit: await this.readStore('audit'),
				expenses: await this.readStore('expenses'),
				agent: await this.readStore('agent'),
				auth: await this.readStore('auth')
			}
		};
	}

	async restoreBackup(backup: BackupPayload) {
		await mkdir(this.dataDir, { recursive: true });
		await this.writeStores({
			connections: backup.data.connections,
			audit: backup.data.audit,
			expenses: backup.data.expenses,
			agent: backup.data.agent ?? STORE_DEFAULTS.agent,
			auth: backup.data.auth ?? STORE_DEFAULTS.auth
		});
	}

	async previewRestore(backup: BackupPayload): Promise<RestorePreview> {
		return {
			version: backup.version,
			exportedAt: backup.exportedAt,
			incoming: summarizeBackup(backup),
			current: summarizeBackup(await this.exportBackup()),
			missingStores: missingOptionalStores(backup)
		};
	}

	private async readStore(name: StoreName) {
		try {
			return JSON.parse(await readFile(storePath(this.dataDir, name), 'utf8')) as unknown;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return STORE_DEFAULTS[name];
			throw error;
		}
	}

	private async writeStores(values: Record<StoreName, unknown>) {
		const batchId = `${process.pid}.${Date.now()}`;
		const writes = Object.entries(values)
			.map(([name, value]) => ({
				value,
				target: storePath(this.dataDir, name),
				tmp: path.join(this.dataDir, `${name}.${batchId}.restore.tmp`)
			}))
			.sort((left, right) => left.target.localeCompare(right.target));

		const releases: Array<() => Promise<void>> = [];
		let committed = false;
		try {
			for (const write of writes) {
				releases.push(await acquireStoreFileLock(write.target));
			}
			await Promise.all(writes.map((write) => writeJsonTemp(write.tmp, write.value)));
			await Promise.all(writes.map((write) => backupCurrent(write.target)));
			for (const write of writes) {
				await rename(write.tmp, write.target);
			}
			committed = true;
		} finally {
			await Promise.all(
				(committed ? [] : writes).map((write) =>
					rm(write.tmp, { force: true }).catch(() => undefined)
				)
			);
			await Promise.all([...releases].reverse().map((release) => release()));
		}
	}
}

function summarizeBackup(backup: BackupPayload): BackupStoreSummary {
	return {
		connections: countArrayField(backup.data.connections, 'presets'),
		auditEvents: countArrayField(backup.data.audit, 'events'),
		expenseEntries: countArrayField(backup.data.expenses, 'entries'),
		agentJobs: countArrayField(backup.data.agent ?? STORE_DEFAULTS.agent, 'jobs'),
		authUsers: countArrayField(backup.data.auth ?? STORE_DEFAULTS.auth, 'users'),
		authSessions: countArrayField(backup.data.auth ?? STORE_DEFAULTS.auth, 'sessions')
	};
}

function countArrayField(value: unknown, key: string) {
	if (!value || typeof value !== 'object') return 0;
	const field = (value as Record<string, unknown>)[key];
	return Array.isArray(field) ? field.length : 0;
}

function missingOptionalStores(backup: BackupPayload) {
	const missing: string[] = [];
	if (!backup.data.agent) missing.push('agent');
	if (!backup.data.auth) missing.push('auth');
	return missing;
}

async function writeJsonTemp(filePath: string, value: unknown) {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	const handle = await open(filePath, 'w');
	try {
		await handle.writeFile(content, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	JSON.parse(await readFile(filePath, 'utf8'));
}

async function backupCurrent(filePath: string) {
	try {
		await copyFile(filePath, `${filePath}.bak`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}
