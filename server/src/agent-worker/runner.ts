import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AgentCommandResult, AgentJob } from '../../../src/lib/shared/ops-types';

export type AgentWorkerRunOptions = {
	execute: boolean;
	commandTimeoutMs: number;
	maxOutputBytes: number;
	policy?: AgentWorkerCommandPolicy;
};

export type AgentWorkerCommandPolicy = {
	allowedCommands: string[];
	workingDirectory?: string;
};

export type AgentWorkerRunResult = {
	success: boolean;
	result: string;
	commandResults: AgentCommandResult[];
};

export async function runAgentJob(
	job: AgentJob,
	options: AgentWorkerRunOptions
): Promise<AgentWorkerRunResult> {
	if (!options.execute) {
		return {
			success: true,
			result: `Dry-run: ${job.commands.length} command(s) approved but not executed. Set execute=true in the worker config to run commands.`,
			commandResults: job.commands.map((command) => ({
				label: command.label,
				command: command.command,
				exitCode: null,
				stderr: 'dry-run mode'
			}))
		};
	}

	const commandResults: AgentCommandResult[] = [];
	for (const command of job.commands) {
		const policyError = validateCommandPolicy(command.command, options.policy);
		if (policyError) {
			commandResults.push({
				label: command.label,
				command: command.command,
				exitCode: null,
				stderr: policyError
			});
			return {
				success: false,
				result: `Command rejected by worker policy: ${command.label}`,
				commandResults
			};
		}
		const result = await runCommand(command.command, {
			label: command.label,
			timeoutMs: options.commandTimeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			cwd: options.policy?.workingDirectory
		});
		commandResults.push(result);
		if (result.exitCode !== 0) {
			return {
				success: false,
				result: `Stopped after command failed: ${command.label}`,
				commandResults
			};
		}
	}

	return {
		success: true,
		result: `Completed ${commandResults.length} command(s).`,
		commandResults
	};
}

export async function runCommand(
	command: string,
	options: { label?: string; timeoutMs: number; maxOutputBytes: number; cwd?: string }
): Promise<AgentCommandResult> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const stdout = createOutputCollector(options.maxOutputBytes);
	const stderr = createOutputCollector(options.maxOutputBytes);

	const child = spawn(command, {
		shell: true,
		windowsHide: true,
		cwd: options.cwd,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGTERM');
	}, options.timeoutMs);

	child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
	child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));

	const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
	clearTimeout(timer);

	if (timedOut) {
		stderr.append(Buffer.from(`\nCommand timed out after ${options.timeoutMs}ms.`));
	}
	if (signal && !timedOut) {
		stderr.append(Buffer.from(`\nCommand terminated by signal ${signal}.`));
	}

	return {
		label: options.label,
		command,
		exitCode: timedOut ? null : code,
		stdout: stdout.value() || undefined,
		stderr: stderr.value() || undefined,
		startedAt,
		completedAt: new Date().toISOString(),
		durationMs: Date.now() - started
	};
}

export function validateCommandPolicy(command: string, policy?: AgentWorkerCommandPolicy) {
	const trimmed = command.trim();
	if (!trimmed) return 'Command is empty';
	if (trimmed.length > 20_000) return 'Command is too long';
	if (hasControlCharacter(trimmed)) return 'Command contains control characters';

	const allowedCommands = policy?.allowedCommands ?? [];
	if (allowedCommands.length === 0) {
		return 'Worker execution allowlist is empty';
	}
	const normalizedAllowedCommands = allowedCommands.map((item) => item.toLowerCase());
	if (normalizedAllowedCommands.includes('*')) return '';

	if (/[;&|<>`]/.test(trimmed) || /\$\s*\(/.test(trimmed)) {
		return 'Command uses shell chaining, redirection or command substitution';
	}

	const executable = firstToken(trimmed).toLowerCase();
	if (!normalizedAllowedCommands.includes(executable)) {
		return `Executable is not allowed by this worker: ${executable}`;
	}
	return '';
}

function firstToken(command: string) {
	const trimmed = command.trim();
	if (trimmed.startsWith('"')) {
		const end = trimmed.indexOf('"', 1);
		if (end > 1) return trimmed.slice(1, end);
	}
	if (trimmed.startsWith("'")) {
		const end = trimmed.indexOf("'", 1);
		if (end > 1) return trimmed.slice(1, end);
	}
	return trimmed.split(/\s+/)[0] ?? '';
}

function hasControlCharacter(value: string) {
	return Array.from(value).some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

export function createOutputCollector(maxBytes: number) {
	let bytes = 0;
	let truncated = false;
	const chunks: Buffer[] = [];

	return {
		append(chunk: Buffer) {
			if (truncated) return;
			const remaining = maxBytes - bytes;
			if (remaining <= 0) {
				truncated = true;
				return;
			}
			if (chunk.byteLength > remaining) {
				chunks.push(chunk.subarray(0, remaining));
				bytes += remaining;
				truncated = true;
				return;
			}
			chunks.push(chunk);
			bytes += chunk.byteLength;
		},
		value() {
			const output = Buffer.concat(chunks).toString('utf8');
			return truncated ? `${output}\n[output truncated at ${maxBytes} bytes]` : output;
		}
	};
}
