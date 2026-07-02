import { createHash } from 'node:crypto';
import type {
	ConnectionInput,
	ConnectionPreset,
	ConnectionStatus,
	ConnectionType,
	MysqlSecretConfig,
	S3SecretConfig,
	SshSecretConfig
} from '../../../../src/lib/shared/ops-types';
import type { ConfigConnectionInput, ConfigConnections, ConfigS3ConnectionInput } from '../../config/config';
import { HttpError } from '../../core/http';

type StoredPreset = Omit<ConnectionPreset, 'config'> & {
	config: Record<string, unknown>;
	secrets: Record<string, unknown>;
};

export class ConnectionsRepository {
	private readonly presets: StoredPreset[];

	constructor(connections: ConfigConnections) {
		const now = new Date().toISOString();
		this.presets = [connections.mysql, connections.s3, ...connections.ssh]
			.filter((input): input is NonNullable<typeof input> => Boolean(input))
			.map((input) => ({
			id: input.id?.trim() || stableConnectionId(input),
			name: input.name.trim(),
			type: input.type,
			tags: input.tags ?? [],
			status: 'unknown',
			config: publicConfig(input),
			secrets: secretConfig(input),
				createdAt: now,
				updatedAt: now
			}));
	}

	async list(type?: ConnectionType) {
		return this.presets.filter((preset) => !type || preset.type === type).map(redactPreset);
	}

	async get(id: string) {
		const preset = this.presets.find((item) => item.id === id);
		if (!preset) throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'Connection preset not found');
		return redactPreset(preset);
	}

	async getWithSecrets(id: string) {
		const preset = this.presets.find((item) => item.id === id);
		if (!preset) throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'Connection preset not found');
		return {
			...redactPreset(preset),
			secrets: preset.secrets
		};
	}

	async create(_input: ConnectionInput): Promise<ConnectionPreset> {
		throw readOnlyError();
	}

	async update(_id: string, _input: ConnectionInput): Promise<ConnectionPreset> {
		throw readOnlyError();
	}

	async remove(_id: string) {
		throw readOnlyError();
	}

	async setStatus(id: string, status: ConnectionStatus, lastError?: string) {
		const preset = this.presets.find((item) => item.id === id);
		if (!preset) return;
		preset.status = status;
		preset.lastCheckedAt = new Date().toISOString();
		preset.lastError = lastError;
		preset.updatedAt = new Date().toISOString();
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

function publicConfig(input: ConfigConnectionInput | ConfigS3ConnectionInput) {
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

function secretConfig(input: ConnectionInput): MysqlSecretConfig | S3SecretConfig | SshSecretConfig {
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

function stableConnectionId(input: ConnectionInput) {
	return `${input.type}-${createHash('sha256')
		.update(`${input.type}:${input.name}`)
		.digest('hex')
		.slice(0, 12)}`;
}

function readOnlyError() {
	return new HttpError(
		409,
		'CONNECTIONS_CONFIG_READ_ONLY',
		'Connection presets are configured in config.json. Edit the config file and restart the admin server.'
	);
}
