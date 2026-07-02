import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectionInput, S3ConnectionInput } from '../../../src/lib/shared/ops-types';
import { passwordPolicyIssues } from '../modules/auth/password-policy';

export type ServerConfig = {
	host: string;
	port: number;
	corsOrigin: string[];
	dataDir: string;
	agentWorkerToken: string;
	secretKey: Buffer;
	nodeEnv: string;
	logLevel: string;
	bodyLimitBytes: number;
	uploadLimitBytes: number;
	rateLimitMax: number;
	rateLimitWindow: string;
	trustProxy: boolean;
	sshMaxSessions: number;
	sshIdleTimeoutMs: number;
	sshReadyTimeoutMs: number;
	sshKeepaliveIntervalMs: number;
	sshTicketTtlMs: number;
	sshRequireHostKeyVerification: boolean;
	sessionTtlMs: number;
	sessionIdleTimeoutMs: number;
	bootstrapAdminUser: string;
	bootstrapAdminPassword: string;
	authMaxFailedLogins: number;
	authLockoutMs: number;
	aiAdminWorker: AiAdminWorkerConfig;
	connections: ConfigConnections;
};

export type AiAdminWorkerConfig = {
	baseUrl: string;
	apiKey: string;
	model: string;
};

export type ConfigConnectionInput = ConnectionInput & { id?: string };
export type ConfigS3ConnectionInput = S3ConnectionInput & { id?: string };

export type ConfigConnections = {
	mysql: ConfigConnectionInput | null;
	s3: ConfigS3ConnectionInput | null;
	ssh: ConfigConnectionInput[];
};

type RawConfig = {
	mode?: string;
	host?: string;
	port?: number;
	corsOrigin?: string[];
	dataDir?: string;
	agentWorkerToken?: string;
	secretKey?: string;
	logLevel?: string;
	bodyLimitBytes?: number;
	uploadLimitBytes?: number;
	rateLimitMax?: number;
	rateLimitWindow?: string;
	trustProxy?: boolean;
	sshMaxSessions?: number;
	sshIdleTimeoutMs?: number;
	sshReadyTimeoutMs?: number;
	sshKeepaliveIntervalMs?: number;
	sshTicketTtlMs?: number;
	sshRequireHostKeyVerification?: boolean;
	sessionTtlMs?: number;
	sessionIdleTimeoutMs?: number;
	adminUsername?: string;
	adminPassword?: string;
	authMaxFailedLogins?: number;
	authLockoutMs?: number;
	aiAdminWorker?: Partial<AiAdminWorkerConfig>;
	connections?: Partial<ConfigConnections>;
};

export async function loadConfig(): Promise<ServerConfig> {
	const configPath = path.resolve(getConfigPath());
	let raw: RawConfig;
	try {
		raw = JSON.parse(await readFile(configPath, 'utf8')) as RawConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Admin config file not found: ${configPath}`);
		}
		throw error;
	}

	const nodeEnv = requiredString(raw.mode, 'mode');
	const dataDir = path.resolve(path.dirname(configPath), requiredString(raw.dataDir, 'dataDir'));
	await mkdir(dataDir, { recursive: true });

	const adminUsername = requiredString(raw.adminUsername, 'adminUsername');
	const adminPassword = requiredString(raw.adminPassword, 'adminPassword');
	const issues = passwordPolicyIssues(adminPassword, adminUsername);
	if (nodeEnv === 'production' && issues.length > 0) {
		throw new Error(`adminPassword violates password policy: ${issues.join('; ')}`);
	}

	const corsOrigin = raw.corsOrigin ?? [];
	validateCorsOrigins(corsOrigin, nodeEnv);

	return {
		host: requiredString(raw.host, 'host'),
		port: positiveNumber(raw.port, 'port'),
		corsOrigin,
		dataDir,
		agentWorkerToken: requiredString(raw.agentWorkerToken, 'agentWorkerToken'),
		secretKey: loadSecretKey(requiredString(raw.secretKey, 'secretKey')),
		nodeEnv,
		logLevel: raw.logLevel?.trim() || 'info',
		bodyLimitBytes: positiveNumber(raw.bodyLimitBytes, 'bodyLimitBytes'),
		uploadLimitBytes: positiveNumber(raw.uploadLimitBytes, 'uploadLimitBytes'),
		rateLimitMax: positiveNumber(raw.rateLimitMax, 'rateLimitMax'),
		rateLimitWindow: requiredString(raw.rateLimitWindow, 'rateLimitWindow'),
		trustProxy: requiredBoolean(raw.trustProxy, 'trustProxy'),
		sshMaxSessions: positiveNumber(raw.sshMaxSessions, 'sshMaxSessions'),
		sshIdleTimeoutMs: positiveNumber(raw.sshIdleTimeoutMs, 'sshIdleTimeoutMs'),
		sshReadyTimeoutMs: positiveNumber(raw.sshReadyTimeoutMs, 'sshReadyTimeoutMs'),
		sshKeepaliveIntervalMs: positiveNumber(raw.sshKeepaliveIntervalMs, 'sshKeepaliveIntervalMs'),
		sshTicketTtlMs: positiveNumber(raw.sshTicketTtlMs, 'sshTicketTtlMs'),
		sshRequireHostKeyVerification: requiredBoolean(
			raw.sshRequireHostKeyVerification,
			'sshRequireHostKeyVerification'
		),
		sessionTtlMs: positiveNumber(raw.sessionTtlMs, 'sessionTtlMs'),
		sessionIdleTimeoutMs: positiveNumber(raw.sessionIdleTimeoutMs, 'sessionIdleTimeoutMs'),
		bootstrapAdminUser: adminUsername,
		bootstrapAdminPassword: adminPassword,
		authMaxFailedLogins: positiveNumber(raw.authMaxFailedLogins, 'authMaxFailedLogins'),
		authLockoutMs: positiveNumber(raw.authLockoutMs, 'authLockoutMs'),
		aiAdminWorker: normalizeAiAdminWorker(raw.aiAdminWorker),
		connections: normalizeConnections(raw.connections)
	};
}

function normalizeAiAdminWorker(input: RawConfig['aiAdminWorker']): AiAdminWorkerConfig {
	if (!input) throw new Error('aiAdminWorker is required in config.json');
	return {
		baseUrl: requiredString(input.baseUrl, 'aiAdminWorker.baseUrl').replace(/\/$/, ''),
		apiKey: requiredString(input.apiKey, 'aiAdminWorker.apiKey'),
		model: requiredString(input.model, 'aiAdminWorker.model')
	};
}

function normalizeConnections(input: Partial<ConfigConnections> | undefined): ConfigConnections {
	return {
		mysql: assertSingleConnectionType(input?.mysql ?? null, 'mysql'),
		s3: assertSingleS3Connection(input?.s3 ?? null),
		ssh: assertConnectionTypes(input?.ssh ?? [], 'ssh')
	};
}

function assertSingleConnectionType<T extends ConfigConnectionInput['type']>(
	item: ConfigConnectionInput | null,
	type: T
) {
	if (!item) return null;
	if (item.type !== type) throw new Error(`connections.${type} contains ${item.type} item`);
	if (!item.name?.trim()) throw new Error(`connections.${type} item must have a name`);
	return item;
}

function assertSingleS3Connection(item: ConfigS3ConnectionInput | null) {
	if (!item) return null;
	if (item.type !== 's3') throw new Error(`connections.s3 contains ${item.type} item`);
	if (!item.name?.trim()) throw new Error('connections.s3 item must have a name');
	return item;
}

function assertConnectionTypes<T extends ConfigConnectionInput['type']>(
	items: ConfigConnectionInput[],
	type: T
) {
	for (const item of items) {
		if (item.type !== type) throw new Error(`connections.${type} contains ${item.type} item`);
		if (!item.name?.trim()) throw new Error(`connections.${type} contains item without name`);
	}
	return items;
}

function getConfigPath() {
	const index = process.argv.indexOf('--config');
	if (index !== -1) {
		const value = process.argv[index + 1];
		if (!value) throw new Error('--config requires a file path');
		return value;
	}
	return 'config.json';
}

function loadSecretKey(raw: string) {
	const decoded = raw.startsWith('base64:')
		? Buffer.from(raw.slice(7), 'base64')
		: Buffer.from(raw);
	if (decoded.length < 32) throw new Error('secretKey must be at least 32 bytes');
	return decoded.subarray(0, 32);
}

function requiredString(value: string | undefined, name: string) {
	if (!value?.trim()) throw new Error(`${name} is required in config.json`);
	return value.trim();
}

function requiredBoolean(value: boolean | undefined, name: string) {
	if (typeof value !== 'boolean') throw new Error(`${name} is required in config.json`);
	return value;
}

function positiveNumber(value: number | undefined, name: string) {
	if (!Number.isFinite(value) || value! <= 0) {
		throw new Error(`${name} must be a positive number in config.json`);
	}
	return value!;
}

function validateCorsOrigins(origins: string[], nodeEnv: string) {
	if (origins.length === 0) throw new Error('corsOrigin must contain at least one origin');
	if (nodeEnv === 'production' && origins.includes('*')) {
		throw new Error('corsOrigin cannot contain * in production');
	}
	for (const origin of origins) {
		let parsed: URL;
		try {
			parsed = new URL(origin);
		} catch {
			throw new Error(`corsOrigin contains invalid origin: ${origin}`);
		}
		if (!['http:', 'https:'].includes(parsed.protocol)) {
			throw new Error(`corsOrigin only supports http or https origins: ${origin}`);
		}
		if (nodeEnv === 'production' && parsed.protocol !== 'https:' && !isLocalhost(parsed.hostname)) {
			throw new Error(`corsOrigin must use https in production: ${origin}`);
		}
	}
}

function isLocalhost(hostname: string) {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
