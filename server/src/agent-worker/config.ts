import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type AgentWorkerEnv = {
	apiBase: string;
	token: string;
	workerId: string;
	pollMs: number;
	execute: boolean;
	once: boolean;
	commandTimeoutMs: number;
	maxOutputBytes: number;
	allowedCommands: string[];
	workingDirectory?: string;
};

type RawAgentWorkerConfig = {
	apiBase?: string;
	token?: string;
	workerId?: string;
	pollMs?: number;
	execute?: boolean;
	once?: boolean;
	commandTimeoutMs?: number;
	maxOutputBytes?: number;
	allowedCommands?: string[];
	workingDirectory?: string | null;
};

const DEFAULT_WORKER_CONFIG_PATH = '.ai-admin-worker/config.json';

export async function loadAgentWorkerConfig(): Promise<AgentWorkerEnv> {
	const fileConfig = await readWorkerConfigFile();
	const envConfig = readWorkerConfigEnv();
	return normalizeWorkerConfig(mergeWorkerConfig(fileConfig, envConfig));
}

async function readWorkerConfigFile(): Promise<RawAgentWorkerConfig> {
	const configPath = workerConfigPath();
	try {
		return JSON.parse(await readFile(configPath, 'utf8')) as RawAgentWorkerConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
}

function readWorkerConfigEnv(): RawAgentWorkerConfig {
	return {
		apiBase: firstEnv('AI_ADMIN_WORKER_API_BASE', 'AGENT_WORKER_API_BASE'),
		token: firstEnv('AI_ADMIN_WORKER_TOKEN', 'AGENT_WORKER_TOKEN'),
		workerId: firstEnv('AI_ADMIN_WORKER_ID', 'AGENT_WORKER_ID'),
		pollMs: envNumber('AI_ADMIN_WORKER_POLL_MS', 'AGENT_WORKER_POLL_MS'),
		execute: envBoolean('AI_ADMIN_WORKER_EXECUTE', 'AGENT_WORKER_EXECUTE'),
		once: envBoolean('AI_ADMIN_WORKER_ONCE', 'AGENT_WORKER_ONCE'),
		commandTimeoutMs: envNumber(
			'AI_ADMIN_WORKER_COMMAND_TIMEOUT_MS',
			'AGENT_WORKER_COMMAND_TIMEOUT_MS'
		),
		maxOutputBytes: envNumber('AI_ADMIN_WORKER_MAX_OUTPUT_BYTES', 'AGENT_WORKER_MAX_OUTPUT_BYTES'),
		allowedCommands: envList('AI_ADMIN_WORKER_ALLOWED_COMMANDS', 'AGENT_WORKER_ALLOWED_COMMANDS'),
		workingDirectory: firstEnv(
			'AI_ADMIN_WORKER_WORKING_DIRECTORY',
			'AGENT_WORKER_WORKING_DIRECTORY'
		)
	};
}

function normalizeWorkerConfig(input: RawAgentWorkerConfig): AgentWorkerEnv {
	const execute = input.execute ?? false;
	const allowedCommands = input.allowedCommands ?? [];
	if (!Array.isArray(allowedCommands)) {
		throw new Error('allowedCommands must be an array in worker config');
	}
	if (execute && allowedCommands.length === 0) {
		throw new Error('allowedCommands is required when worker execution is enabled');
	}
	return {
		apiBase: requiredString(input.apiBase, 'apiBase').replace(/\/$/, ''),
		token: requiredString(input.token, 'token'),
		workerId: input.workerId?.trim() || 'pi-local',
		pollMs: positiveNumber(input.pollMs ?? 5_000, 'pollMs'),
		execute,
		once: input.once ?? false,
		commandTimeoutMs: positiveNumber(input.commandTimeoutMs ?? 60_000, 'commandTimeoutMs'),
		maxOutputBytes: positiveNumber(input.maxOutputBytes ?? 200_000, 'maxOutputBytes'),
		allowedCommands: allowedCommands.map((command) => command.trim()).filter(Boolean),
		workingDirectory: input.workingDirectory?.trim() || undefined
	};
}

function workerConfigPath() {
	const explicit = argvValue('--worker-config') ?? argvValue('--config');
	const envPath = firstEnv('AI_ADMIN_WORKER_CONFIG', 'AGENT_WORKER_CONFIG');
	return path.resolve(explicit ?? envPath ?? DEFAULT_WORKER_CONFIG_PATH);
}

function argvValue(name: string) {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	if (!value) throw new Error(`${name} requires a file path`);
	return value;
}

function mergeWorkerConfig(
	base: RawAgentWorkerConfig,
	overrides: RawAgentWorkerConfig
): RawAgentWorkerConfig {
	const merged = mergeDefined(base, overrides);
	return merged;
}

function mergeDefined<T extends Record<string, unknown>>(base: T, overrides: T): T {
	const merged = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) {
			(merged as Record<string, unknown>)[key] = value;
		}
	}
	return merged;
}

function firstEnv(...names: string[]) {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function envNumber(...names: string[]) {
	const value = firstEnv(...names);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${names[0]} must be a number`);
	return parsed;
}

function envBoolean(...names: string[]) {
	const value = firstEnv(...names);
	if (value === undefined) return undefined;
	if (/^(1|true|yes)$/i.test(value)) return true;
	if (/^(0|false|no)$/i.test(value)) return false;
	throw new Error(`${names[0]} must be true or false`);
}

function envList(...names: string[]) {
	const value = firstEnv(...names);
	if (value === undefined) return undefined;
	return value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

function requiredString(value: string | undefined, name: string) {
	if (!value?.trim()) throw new Error(`${name} is required in worker config`);
	return value.trim();
}

function positiveNumber(value: number, name: string) {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number in worker config`);
	}
	return value;
}
