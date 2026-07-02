import { nanoid } from 'nanoid';
import type {
	ConnectionInput,
	ConnectionPreset,
	ConnectionStatus,
	ConnectionType,
	MysqlSecretConfig,
	S3SecretConfig,
	SshSecretConfig
} from '../../../../src/lib/shared/ops-types';
import { encryptJson, decryptJson } from '../../core/crypto';
import { HttpError } from '../../core/http';
import { JsonStore, storePath } from '../../store/json-store';

type StoredPreset = Omit<ConnectionPreset, 'config'> & {
	config: Record<string, unknown>;
	secrets?: string;
};

type ConnectionState = {
	presets: StoredPreset[];
};

export class ConnectionsRepository {
	private readonly store: JsonStore<ConnectionState>;

	constructor(
		dataDir: string,
		private readonly secretKey: Buffer
	) {
		this.store = new JsonStore(storePath(dataDir, 'connections'), { presets: [] });
	}

	async list(type?: ConnectionType) {
		const state = await this.store.read();
		return state.presets.filter((preset) => !type || preset.type === type).map(redactPreset);
	}

	async get(id: string) {
		const state = await this.store.read();
		const preset = state.presets.find((item) => item.id === id);
		if (!preset) throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'Connection preset not found');
		return redactPreset(preset);
	}

	async getWithSecrets(id: string) {
		const state = await this.store.read();
		const preset = state.presets.find((item) => item.id === id);
		if (!preset) throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'Connection preset not found');
		return {
			...redactPreset(preset),
			secrets: decryptJson<Record<string, unknown>>(preset.secrets, this.secretKey, {})
		};
	}

	async create(input: ConnectionInput) {
		const now = new Date().toISOString();
		const stored: StoredPreset = {
			id: nanoid(),
			name: input.name.trim(),
			type: input.type,
			tags: input.tags ?? [],
			status: 'unknown',
			config: publicConfig(input),
			secrets: encryptJson(secretConfig(input), this.secretKey),
			createdAt: now,
			updatedAt: now
		};

		await this.store.update((state) => {
			state.presets.unshift(stored);
		});
		return redactPreset(stored);
	}

	async update(id: string, input: ConnectionInput) {
		const now = new Date().toISOString();
		let updated: StoredPreset | undefined;
		await this.store.update((state) => {
			const index = state.presets.findIndex((preset) => preset.id === id);
			if (index === -1)
				throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'Connection preset not found');
			const previous = state.presets[index];
			const previousSecrets =
				previous.type === input.type
					? decryptJson<Record<string, unknown>>(previous.secrets, this.secretKey, {})
					: {};
			updated = {
				...previous,
				name: input.name.trim(),
				type: input.type,
				tags: input.tags ?? [],
				config: publicConfig(input),
				secrets: encryptJson(mergeSecrets(previousSecrets, secretConfig(input)), this.secretKey),
				updatedAt: now
			};
			state.presets[index] = updated;
		});
		return redactPreset(updated!);
	}

	async remove(id: string) {
		await this.store.update((state) => {
			const before = state.presets.length;
			state.presets = state.presets.filter((preset) => preset.id !== id);
			if (state.presets.length === before) {
				throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'Connection preset not found');
			}
		});
	}

	async setStatus(id: string, status: ConnectionStatus, lastError?: string) {
		await this.store.update((state) => {
			const preset = state.presets.find((item) => item.id === id);
			if (!preset) return;
			preset.status = status;
			preset.lastCheckedAt = new Date().toISOString();
			preset.lastError = lastError;
			preset.updatedAt = new Date().toISOString();
		});
	}
}

function redactPreset(preset: StoredPreset): ConnectionPreset {
	return {
		id: preset.id,
		name: preset.name,
		type: preset.type,
		tags: preset.tags,
		status: preset.status,
		lastCheckedAt: preset.lastCheckedAt,
		lastError: preset.lastError,
		config: preset.config as ConnectionPreset['config'],
		createdAt: preset.createdAt,
		updatedAt: preset.updatedAt
	};
}

function publicConfig(input: ConnectionInput) {
	if (input.type === 'mysql') {
		const { host, port, database, user, ssl, allowMutations } = input.config;
		return { host, port, database, user, ssl, allowMutations };
	}
	if (input.type === 's3') {
		const { endpoint, region, defaultBucket, forcePathStyle, allowWrites } = input.config;
		return { endpoint, region, defaultBucket, forcePathStyle, allowWrites };
	}
	const { host, port, username, hostKeySha256 } = input.config;
	return { host, port, username, hostKeySha256 };
}

function secretConfig(
	input: ConnectionInput
): MysqlSecretConfig | S3SecretConfig | SshSecretConfig {
	if (input.type === 'mysql') return { password: input.config.password };
	if (input.type === 's3') {
		return {
			accessKeyId: input.config.accessKeyId,
			secretAccessKey: input.config.secretAccessKey,
			sessionToken: input.config.sessionToken
		};
	}
	return {
		password: input.config.password,
		privateKey: input.config.privateKey,
		passphrase: input.config.passphrase
	};
}

function mergeSecrets(
	previous: Record<string, unknown>,
	next: MysqlSecretConfig | S3SecretConfig | SshSecretConfig
) {
	const merged = { ...previous };
	for (const [key, value] of Object.entries(next)) {
		if (value !== undefined && value !== '') merged[key] = value;
	}
	return merged;
}
