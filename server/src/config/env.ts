import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { passwordPolicyIssues } from '../modules/auth/password-policy';

export type ServerEnv = {
	host: string;
	port: number;
	corsOrigin: string[];
	dataDir: string;
	apiToken: string;
	agentWorkerToken: string;
	secretKey: Buffer;
	nodeEnv: string;
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
	bootstrapAdminUser?: string;
	bootstrapAdminPassword?: string;
	authMaxFailedLogins: number;
	authLockoutMs: number;
};

const DEFAULT_DEV_TOKEN = 'dev-admin-token';
const DEFAULT_DEV_AGENT_WORKER_TOKEN = 'dev-agent-worker-token';
const DEFAULT_DEV_SECRET = 'development-only-change-me-development-only';
const MIN_PRODUCTION_TOKEN_LENGTH = 32;

function parseOrigins(value: string | undefined) {
	if (!value) return ['http://localhost:5173', 'http://127.0.0.1:5173'];
	return value
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

function loadSecretKey(nodeEnv: string) {
	const raw = process.env.OPS_SECRET_KEY;
	if (!raw) {
		if (nodeEnv === 'production') {
			throw new Error('OPS_SECRET_KEY is required in production');
		}
		return Buffer.from(DEFAULT_DEV_SECRET.padEnd(32, '0')).subarray(0, 32);
	}

	const decoded = raw.startsWith('base64:')
		? Buffer.from(raw.slice(7), 'base64')
		: Buffer.from(raw);
	if (decoded.length < 32) {
		throw new Error('OPS_SECRET_KEY must be at least 32 bytes');
	}
	return decoded.subarray(0, 32);
}

function numberEnv(name: string, fallback: number) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return parsed;
}

function booleanEnv(name: string, fallback: boolean) {
	const raw = process.env[name];
	if (!raw) return fallback;
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	throw new Error(`${name} must be true or false`);
}

function validateCorsOrigins(origins: string[], nodeEnv: string) {
	if (nodeEnv !== 'production') return;
	if (!process.env.OPS_CORS_ORIGIN) {
		throw new Error('OPS_CORS_ORIGIN is required in production');
	}
	if (origins.length === 0) {
		throw new Error('OPS_CORS_ORIGIN must contain at least one origin in production');
	}
	if (origins.includes('*')) {
		throw new Error('OPS_CORS_ORIGIN cannot contain * in production');
	}

	const allowInsecure = booleanEnv('OPS_ALLOW_INSECURE_CORS_ORIGIN', false);
	for (const origin of origins) {
		let parsed: URL;
		try {
			parsed = new URL(origin);
		} catch {
			throw new Error(`OPS_CORS_ORIGIN contains invalid origin: ${origin}`);
		}
		if (!['http:', 'https:'].includes(parsed.protocol)) {
			throw new Error(`OPS_CORS_ORIGIN only supports http or https origins: ${origin}`);
		}
		if (parsed.protocol !== 'https:' && !allowInsecure && !isLocalhost(parsed.hostname)) {
			throw new Error(
				`OPS_CORS_ORIGIN must use https in production unless OPS_ALLOW_INSECURE_CORS_ORIGIN=true: ${origin}`
			);
		}
	}
}

function isLocalhost(hostname: string) {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function assertProductionToken(name: string, value: string, defaultValue: string) {
	if (value === defaultValue) {
		throw new Error(`${name} is required in production`);
	}
	if (value.length < MIN_PRODUCTION_TOKEN_LENGTH) {
		throw new Error(
			`${name} must be at least ${MIN_PRODUCTION_TOKEN_LENGTH} characters in production`
		);
	}
}

export async function loadEnv(): Promise<ServerEnv> {
	const nodeEnv = process.env.NODE_ENV ?? 'development';
	const apiToken = process.env.OPS_ADMIN_TOKEN ?? DEFAULT_DEV_TOKEN;
	const agentWorkerToken = process.env.OPS_AGENT_WORKER_TOKEN ?? DEFAULT_DEV_AGENT_WORKER_TOKEN;
	if (nodeEnv === 'production') {
		assertProductionToken('OPS_ADMIN_TOKEN', apiToken, DEFAULT_DEV_TOKEN);
		assertProductionToken(
			'OPS_AGENT_WORKER_TOKEN',
			agentWorkerToken,
			DEFAULT_DEV_AGENT_WORKER_TOKEN
		);
		if (agentWorkerToken === apiToken) {
			throw new Error('OPS_AGENT_WORKER_TOKEN must be different from OPS_ADMIN_TOKEN');
		}
	}

	const dataDir = path.resolve(process.env.OPS_DATA_DIR ?? './.ops-data');
	await mkdir(dataDir, { recursive: true });
	const bootstrapAdminUser =
		process.env.OPS_BOOTSTRAP_ADMIN_USER ?? (nodeEnv === 'development' ? 'admin' : undefined);
	const bootstrapAdminPassword =
		process.env.OPS_BOOTSTRAP_ADMIN_PASSWORD ??
		(nodeEnv === 'development' ? 'dev-admin-password' : undefined);
	const corsOrigin = parseOrigins(process.env.OPS_CORS_ORIGIN);
	validateCorsOrigins(corsOrigin, nodeEnv);

	if (nodeEnv === 'production' && bootstrapAdminPassword) {
		const issues = passwordPolicyIssues(bootstrapAdminPassword, bootstrapAdminUser);
		if (issues.length > 0) {
			throw new Error(
				`OPS_BOOTSTRAP_ADMIN_PASSWORD violates password policy: ${issues.join('; ')}`
			);
		}
	}

	return {
		host: process.env.OPS_HOST ?? '127.0.0.1',
		port: Number(process.env.OPS_PORT ?? 8787),
		corsOrigin,
		dataDir,
		apiToken,
		agentWorkerToken,
		secretKey: loadSecretKey(nodeEnv),
		nodeEnv,
		bodyLimitBytes: numberEnv('OPS_BODY_LIMIT_BYTES', 20 * 1024 * 1024),
		uploadLimitBytes: numberEnv('OPS_UPLOAD_LIMIT_BYTES', 100 * 1024 * 1024),
		rateLimitMax: numberEnv('OPS_RATE_LIMIT_MAX', 600),
		rateLimitWindow: process.env.OPS_RATE_LIMIT_WINDOW ?? '1 minute',
		trustProxy: process.env.OPS_TRUST_PROXY === 'true',
		sshMaxSessions: numberEnv('OPS_SSH_MAX_SESSIONS', 12),
		sshIdleTimeoutMs: numberEnv('OPS_SSH_IDLE_TIMEOUT_MS', 10 * 60 * 1000),
		sshReadyTimeoutMs: numberEnv('OPS_SSH_READY_TIMEOUT_MS', 15_000),
		sshKeepaliveIntervalMs: numberEnv('OPS_SSH_KEEPALIVE_INTERVAL_MS', 20_000),
		sshTicketTtlMs: numberEnv('OPS_SSH_TICKET_TTL_MS', 30_000),
		sshRequireHostKeyVerification: booleanEnv(
			'OPS_SSH_REQUIRE_HOST_KEY_VERIFICATION',
			nodeEnv === 'production'
		),
		sessionTtlMs: numberEnv('OPS_SESSION_TTL_MS', 12 * 60 * 60 * 1000),
		sessionIdleTimeoutMs: numberEnv('OPS_SESSION_IDLE_TIMEOUT_MS', 30 * 60 * 1000),
		bootstrapAdminUser,
		bootstrapAdminPassword,
		authMaxFailedLogins: numberEnv('OPS_AUTH_MAX_FAILED_LOGINS', 5),
		authLockoutMs: numberEnv('OPS_AUTH_LOCKOUT_MS', 15 * 60 * 1000)
	};
}
