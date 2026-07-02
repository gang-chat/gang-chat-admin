import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AgentCommandResult, AgentJob } from '../../../src/lib/shared/ops-types';

export type AgentWorkerRunOptions = {
	execute: boolean;
	commandTimeoutMs: number;
	maxOutputBytes: number;
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
			result: `Dry-run: ${job.commands.length} command(s) approved but not executed. Set OPS_AGENT_WORKER_EXECUTE=true to run commands.`,
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
		const result = await runCommand(command.command, {
			label: command.label,
			timeoutMs: options.commandTimeoutMs,
			maxOutputBytes: options.maxOutputBytes
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
	options: { label?: string; timeoutMs: number; maxOutputBytes: number }
): Promise<AgentCommandResult> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const stdout = createOutputCollector(options.maxOutputBytes);
	const stderr = createOutputCollector(options.maxOutputBytes);

	const child = spawn(command, {
		shell: true,
		windowsHide: true,
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
