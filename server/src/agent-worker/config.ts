import os from 'node:os';

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

function numberEnv(name: string, fallback: number) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return value;
}

function booleanEnv(name: string, fallback = false) {
	const raw = process.env[name];
	if (!raw) return fallback;
	return raw === 'true' || raw === '1';
}

function listEnv(name: string) {
	return (process.env[name] ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

export function loadAgentWorkerEnv(): AgentWorkerEnv {
	const token = process.env.OPS_AGENT_WORKER_TOKEN;
	if (!token) throw new Error('OPS_AGENT_WORKER_TOKEN is required');
	const execute = booleanEnv('OPS_AGENT_WORKER_EXECUTE');
	const allowedCommands = listEnv('OPS_AGENT_WORKER_ALLOW_COMMANDS');
	if (execute && allowedCommands.length === 0) {
		throw new Error('OPS_AGENT_WORKER_ALLOW_COMMANDS is required when execution is enabled');
	}

	return {
		apiBase: (process.env.OPS_API_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
		token,
		workerId: process.env.OPS_AGENT_WORKER_ID ?? `pi-${os.hostname()}`,
		pollMs: numberEnv('OPS_AGENT_WORKER_POLL_MS', 5000),
		execute,
		once: booleanEnv('OPS_AGENT_WORKER_ONCE'),
		commandTimeoutMs: numberEnv('OPS_AGENT_WORKER_COMMAND_TIMEOUT_MS', 60_000),
		maxOutputBytes: numberEnv('OPS_AGENT_WORKER_MAX_OUTPUT_BYTES', 200_000),
		allowedCommands,
		workingDirectory: process.env.OPS_AGENT_WORKER_CWD?.trim() || undefined
	};
}
