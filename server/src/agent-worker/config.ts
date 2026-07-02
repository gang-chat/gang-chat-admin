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

export function loadAgentWorkerEnv(): AgentWorkerEnv {
	const token = process.env.OPS_AGENT_WORKER_TOKEN;
	if (!token) throw new Error('OPS_AGENT_WORKER_TOKEN is required');

	return {
		apiBase: (process.env.OPS_API_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
		token,
		workerId: process.env.OPS_AGENT_WORKER_ID ?? `pi-${os.hostname()}`,
		pollMs: numberEnv('OPS_AGENT_WORKER_POLL_MS', 5000),
		execute: booleanEnv('OPS_AGENT_WORKER_EXECUTE'),
		once: booleanEnv('OPS_AGENT_WORKER_ONCE'),
		commandTimeoutMs: numberEnv('OPS_AGENT_WORKER_COMMAND_TIMEOUT_MS', 60_000),
		maxOutputBytes: numberEnv('OPS_AGENT_WORKER_MAX_OUTPUT_BYTES', 200_000)
	};
}
