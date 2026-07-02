import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnPty, type IPty } from 'node-pty';
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool
} from '@earendil-works/pi-agent-core';
import {
	createModels,
	createProvider,
	Type,
	type Model,
	type SimpleStreamOptions
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import WebSocket from 'ws';
import { loadAgentWorkerConfig, type AgentWorkerEnv } from '../agent-worker/config';
import { runCommand, validateCommandPolicy } from '../agent-worker/runner';
import {
	AI_ADMIN_WORKER_VERSION,
	type AiAdminAdminMessage,
	type AiAdminWorkerInitConfig,
	type AiAdminWorkerPrompt,
	type AiAdminWorkerRunEvent
} from './protocol';

type WorkerRuntime = {
	config?: AiAdminWorkerInitConfig;
	agents: Map<string, SessionAgent>;
	terminals: Map<string, WorkerTerminal>;
	queue: Promise<void>;
	activeRunId?: string;
	currentResult: string;
};

type WorkerTerminal = {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: NodeJS.Signals): void;
};

type SessionAgent = {
	agent: Agent;
	unsubscribe: () => void;
};

type CompactEvent = {
	estimatedTokens: number;
	thresholdTokens: number;
	retainedMessages: number;
	totalMessages: number;
};

type ToolPath = {
	root: string;
	target: string;
	relative: string;
};

const SYSTEM_PROMPT = [
	'You are a web-driven operations diagnostic assistant.',
	'Use tools when they are needed to inspect local project state or make requested local changes.',
	'Prefer read-only checks first, call out risk, and do not run destructive commands unless the operator explicitly requested them.',
	'If a tool reports dry-run mode, say clearly that nothing was executed or written.',
	'Do not expose credentials or secret values in your final answer unless the operator explicitly asks for that exact secret.'
].join(' ');

const RECONNECT_MS = 2_000;
const PROVIDER_ID = 'ai-admin-worker';
const MAX_WRITE_BYTES = 500_000;
const RECENT_MESSAGES_TO_KEEP = 12;

const env = await loadAgentWorkerConfig();
let stopping = false;

process.on('SIGINT', () => {
	stopping = true;
});
process.on('SIGTERM', () => {
	stopping = true;
});

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	console.info(`ai admin worker ${env.workerId} connecting to ${env.apiBase}`);
	while (!stopping) {
		try {
			await connectOnce();
		} catch (error) {
			console.error(`ai admin worker connection failed: ${errorMessage(error)}`);
		}
		if (!stopping) await sleep(RECONNECT_MS);
	}
}

async function connectOnce() {
	const socket = new WebSocket(workerWsUrl(env.apiBase, env.token));
	const runtime: WorkerRuntime = {
		agents: new Map(),
		terminals: new Map(),
		queue: Promise.resolve(),
		currentResult: ''
	};

	await new Promise<void>((resolve, reject) => {
		let opened = false;
		socket.once('open', () => {
			opened = true;
			send(socket, {
				type: 'hello',
				workerId: env.workerId,
				version: AI_ADMIN_WORKER_VERSION,
				apiBase: env.apiBase,
				hostname: os.hostname(),
				execute: env.execute,
				allowedCommands: env.allowedCommands,
				terminal: workerTerminalInfo()
			});
			console.info(`ai admin worker connected from ${os.hostname()}`);
		});

		socket.on('message', (raw) => {
			const message = parseAdminMessage(raw.toString());
			if (!message) {
				socket.close(1003, 'Invalid admin message');
				return;
			}
			if (message.type === 'init_config') {
				configureRuntime(runtime, message.config);
				console.info('ai admin worker received model config');
				return;
			}
			if (isTerminalAdminMessage(message)) {
				handleTerminalMessage(socket, runtime, message);
				return;
			}
			runtime.queue = runtime.queue
				.then(() => handlePrompt(socket, runtime, message.prompt))
				.catch((error) => {
					console.error(`ai admin worker prompt failed: ${errorMessage(error)}`);
				});
		});

		socket.once('error', (error) => {
			if (!opened) reject(error);
			else console.error(`ai admin worker websocket error: ${errorMessage(error)}`);
		});

		socket.once('close', () => {
			resetRuntime(runtime);
			if (opened) console.info('ai admin worker disconnected; context cleared');
			resolve();
		});
	});
}

function configureRuntime(runtime: WorkerRuntime, config: AiAdminWorkerInitConfig) {
	disposeAgents(runtime);
	runtime.config = config;
	runtime.activeRunId = undefined;
	runtime.currentResult = '';
}

function resetRuntime(runtime: WorkerRuntime) {
	disposeAgents(runtime);
	closeTerminals(runtime);
	runtime.config = undefined;
	runtime.activeRunId = undefined;
	runtime.currentResult = '';
}

function disposeAgents(runtime: WorkerRuntime) {
	for (const session of runtime.agents.values()) {
		session.unsubscribe();
		session.agent.abort();
	}
	runtime.agents.clear();
}

function closeTerminals(runtime: WorkerRuntime) {
	for (const child of runtime.terminals.values()) {
		child.kill('SIGTERM');
	}
	runtime.terminals.clear();
}

function getSessionAgent(
	socket: WebSocket,
	runtime: WorkerRuntime,
	sessionId: string,
	config: AiAdminWorkerInitConfig
) {
	const existing = runtime.agents.get(sessionId);
	if (existing) return existing.agent;
	const agent = createAgent(config, (event) => {
		handleContextCompaction(socket, runtime, event);
	});
	const unsubscribe = agent.subscribe((event) => {
		handleAgentEvent(socket, runtime, event);
	});
	runtime.agents.set(sessionId, { agent, unsubscribe });
	return agent;
}

function createAgent(config: AiAdminWorkerInitConfig, onCompact: (event: CompactEvent) => void) {
	const models = createModels();
	const model = createModel(config);
	models.setProvider(
		createProvider({
			id: PROVIDER_ID,
			name: 'AI Admin Worker',
			baseUrl: model.baseUrl,
			auth: {
				apiKey: {
					name: 'AI admin worker API key',
					resolve: async () => ({
						auth: { apiKey: config.apiKey },
						source: 'config.json'
					})
				}
			},
			models: [model],
			api: openAICompletionsApi()
		})
	);

	return new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			tools: createTools()
		},
		streamFn: (streamModel, context, options) =>
			models.streamSimple(streamModel, context, withModelDefaults(config, options)),
		transformContext: async (messages) => compactMessagesIfNeeded(messages, config, onCompact),
		getApiKey: () => config.apiKey,
		toolExecution: 'sequential',
		maxRetryDelayMs: 20_000
	});
}

function createModel(config: AiAdminWorkerInitConfig): Model<'openai-completions'> {
	const baseUrl = config.baseUrl.replace(/\/$/, '');
	return {
		id: config.model,
		name: config.model,
		api: 'openai-completions',
		provider: PROVIDER_ID,
		baseUrl,
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow,
		maxTokens: 32_000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false
		}
	};
}

function withModelDefaults(
	config: AiAdminWorkerInitConfig,
	options?: SimpleStreamOptions
): SimpleStreamOptions {
	return {
		temperature: 0.2,
		maxTokens: Math.min(32_000, Math.max(1_024, Math.floor(config.contextWindow * 0.2))),
		...options,
		apiKey: config.apiKey
	};
}

function createTools(): AgentTool[] {
	return [createBashTool(), createReadFileTool(), createWriteFileTool()];
}

function createBashTool(): AgentTool {
	const parameters = Type.Object({
		command: Type.String({
			description:
				'Single command to run. Shell chaining, redirection, pipes, command substitution, and control characters are rejected.'
		}),
		description: Type.Optional(
			Type.String({ description: 'Short reason for running this command.' })
		)
	});
	const tool: AgentTool<typeof parameters> = {
		name: 'bash',
		label: 'Bash',
		description:
			'Run a single shell command in the worker working directory. Execution is blocked unless worker execution is enabled and the executable is allowlisted.',
		parameters,
		executionMode: 'sequential',
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const command = params.command.trim();
			const cwd = toolRoot();
			if (!env.execute) {
				return {
					content: [
						{
							type: 'text',
							text: `Dry-run: command was not executed because worker execute=false.\nCommand: ${command}`
						}
					],
					details: { command, cwd, dryRun: true }
				};
			}

			const policyError = validateCommandPolicy(command, {
				allowedCommands: env.allowedCommands,
				workingDirectory: cwd
			});
			if (policyError) throw new Error(`Command rejected by worker policy: ${policyError}`);

			const result = await runCommand(command, {
				label: params.description,
				timeoutMs: env.commandTimeoutMs,
				maxOutputBytes: env.maxOutputBytes,
				cwd
			});
			return {
				content: [{ type: 'text', text: formatCommandResult(result) }],
				details: { ...result, cwd }
			};
		}
	};
	return tool;
}

function createReadFileTool(): AgentTool {
	const parameters = Type.Object({
		path: Type.String({ description: 'Relative path to read.' }),
		maxBytes: Type.Optional(
			Type.Number({
				description: 'Maximum bytes to return. Defaults to the worker maxOutputBytes setting.',
				minimum: 1,
				maximum: 1_000_000
			})
		)
	});
	const tool: AgentTool<typeof parameters> = {
		name: 'read_file',
		label: 'Read File',
		description:
			'Read a UTF-8 text file under the worker working directory. Use this for project files and local docs.',
		parameters,
		executionMode: 'sequential',
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const file = resolveToolPath(params.path);
			const maxBytes = clampBytes(params.maxBytes ?? env.maxOutputBytes, 1, 1_000_000);
			const buffer = await readFile(file.target);
			const truncated = buffer.byteLength > maxBytes;
			const content = buffer.subarray(0, maxBytes).toString('utf8');
			return {
				content: [
					{
						type: 'text',
						text: truncated
							? `${content}\n[file truncated at ${maxBytes} bytes; original size ${buffer.byteLength} bytes]`
							: content
					}
				],
				details: {
					path: file.relative,
					bytes: buffer.byteLength,
					returnedBytes: Math.min(buffer.byteLength, maxBytes),
					truncated
				}
			};
		}
	};
	return tool;
}

function createWriteFileTool(): AgentTool {
	const parameters = Type.Object({
		path: Type.String({ description: 'Relative path to write.' }),
		content: Type.String({ description: 'Full UTF-8 text content to write.' }),
		append: Type.Optional(Type.Boolean({ description: 'Append instead of overwriting.' }))
	});
	const tool: AgentTool<typeof parameters> = {
		name: 'write_file',
		label: 'Write File',
		description:
			'Write a UTF-8 text file under the worker working directory. This is dry-run unless worker execution is enabled.',
		parameters,
		executionMode: 'sequential',
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const file = resolveToolPath(params.path);
			const bytes = Buffer.byteLength(params.content, 'utf8');
			if (bytes > MAX_WRITE_BYTES) {
				throw new Error(`write_file content is too large: ${bytes} bytes`);
			}
			if (!env.execute) {
				return {
					content: [
						{
							type: 'text',
							text: `Dry-run: file was not ${params.append ? 'appended' : 'written'} because worker execute=false.\nPath: ${file.relative}\nBytes: ${bytes}`
						}
					],
					details: { path: file.relative, bytes, append: params.append === true, dryRun: true }
				};
			}

			await mkdir(path.dirname(file.target), { recursive: true });
			await writeFile(file.target, params.content, {
				encoding: 'utf8',
				flag: params.append ? 'a' : 'w'
			});
			return {
				content: [
					{
						type: 'text',
						text: `${params.append ? 'Appended' : 'Wrote'} ${bytes} bytes to ${file.relative}.`
					}
				],
				details: { path: file.relative, bytes, append: params.append === true }
			};
		}
	};
	return tool;
}

function handleTerminalMessage(
	socket: WebSocket,
	runtime: WorkerRuntime,
	message: Extract<AiAdminAdminMessage, { type: `terminal_${string}` }>
) {
	if (message.type === 'terminal_open') {
		openTerminal(socket, runtime, message.terminalId, message.cols, message.rows);
		return;
	}
	const terminal = runtime.terminals.get(message.terminalId);
	if (!terminal) return;
	if (message.type === 'terminal_input') {
		terminal.write(message.data);
		return;
	}
	if (message.type === 'terminal_resize') {
		terminal.resize(message.cols, message.rows);
		return;
	}
	if (message.type === 'terminal_close') {
		terminal.kill('SIGTERM');
		runtime.terminals.delete(message.terminalId);
		return;
	}
}

function openTerminal(
	socket: WebSocket,
	runtime: WorkerRuntime,
	terminalId: string,
	cols: number,
	rows: number
) {
	runtime.terminals.get(terminalId)?.kill('SIGTERM');
	runtime.terminals.delete(terminalId);
	if (!env.execute) {
		send(socket, {
			type: 'terminal_error',
			terminalId,
			message: 'Worker execute=false; terminal is disabled.'
		});
		send(socket, { type: 'terminal_status', terminalId, status: 'closed' });
		return;
	}

	const shell = terminalShell();
	const cwd = toolRoot();
	let terminal: WorkerTerminal;
	let mode: 'pty' | 'pipe' = 'pty';
	const onClose = () => {
		runtime.terminals.delete(terminalId);
	};
	try {
		terminal = openPtyTerminal(socket, terminalId, shell, cwd, cols, rows, onClose);
	} catch (error) {
		mode = 'pipe';
		send(socket, {
			type: 'terminal_output',
			terminalId,
			data: `\r\n[terminal] PTY unavailable (${errorMessage(error)}); using shell pipe fallback.\r\n`
		});
		terminal = openPipeTerminal(socket, terminalId, shell, cwd, onClose);
	}
	runtime.terminals.set(terminalId, terminal);
	send(socket, { type: 'terminal_status', terminalId, status: 'connected', message: mode });
}

function openPtyTerminal(
	socket: WebSocket,
	terminalId: string,
	shell: string,
	cwd: string,
	cols: number,
	rows: number,
	onClose: () => void
): WorkerTerminal {
	const child = spawnPty(shell, [], {
		cwd,
		name: 'xterm-256color',
		cols,
		rows,
		env: terminalEnv()
	});
	child.onData((data) => {
		send(socket, { type: 'terminal_output', terminalId, data });
	});
	child.onExit(() => {
		onClose();
		send(socket, { type: 'terminal_status', terminalId, status: 'closed' });
	});
	return child;
}

function openPipeTerminal(
	socket: WebSocket,
	terminalId: string,
	shell: string,
	cwd: string,
	onClose: () => void
): WorkerTerminal {
	const child = spawnProcess(shell, shellArgs(shell), {
		cwd,
		env: terminalEnv(),
		stdio: 'pipe'
	});
	child.stdout.on('data', (data: Buffer) => {
		send(socket, { type: 'terminal_output', terminalId, data: data.toString('utf8') });
	});
	child.stderr.on('data', (data: Buffer) => {
		send(socket, { type: 'terminal_output', terminalId, data: data.toString('utf8') });
	});
	child.on('error', (error) => {
		send(socket, { type: 'terminal_error', terminalId, message: error.message });
	});
	child.on('close', () => {
		onClose();
		send(socket, { type: 'terminal_status', terminalId, status: 'closed' });
	});
	return {
		write(data: string) {
			child.stdin.write(data);
		},
		resize() {},
		kill(signal?: NodeJS.Signals) {
			child.kill(signal);
		}
	};
}

function terminalEnv() {
	return {
		...process.env,
		TERM: 'xterm-256color',
		COLORTERM: process.env.COLORTERM || 'truecolor',
		HISTFILE: process.env.HISTFILE || ''
	};
}

function shellArgs(shell: string) {
	return process.platform === 'win32' || /(?:^|[/\\])cmd(?:\.exe)?$/i.test(shell) ? [] : ['-i'];
}

function workerTerminalInfo() {
	return {
		available: env.execute,
		username: os.userInfo().username,
		shell: terminalShell(),
		cwd: toolRoot()
	};
}

function terminalShell() {
	if (process.env.SHELL?.trim()) return process.env.SHELL.trim();
	return process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}

async function handlePrompt(
	socket: WebSocket,
	runtime: WorkerRuntime,
	prompt: AiAdminWorkerPrompt
) {
	if (!runtime.config) {
		sendEvent(socket, {
			type: 'run_failed',
			runId: prompt.runId,
			error: 'AI admin worker has not received model config'
		});
		return;
	}

	const sessionId = prompt.sessionId?.trim() || 'default';
	const agent = getSessionAgent(socket, runtime, sessionId, runtime.config);
	const startIndex = agent.state.messages.length;
	runtime.activeRunId = prompt.runId;
	runtime.currentResult = '';
	sendEvent(socket, { type: 'run_started', runId: prompt.runId });

	try {
		await agent.prompt({
			role: 'user',
			content: userPrompt(prompt),
			timestamp: Date.now()
		});

		const error = agent.state.errorMessage;
		if (error) {
			sendEvent(socket, {
				type: 'run_failed',
				runId: prompt.runId,
				error
			});
			return;
		}

		const finalResult =
			runtime.currentResult.trim().length > 0
				? runtime.currentResult
				: assistantTextFromMessages(agent.state.messages.slice(startIndex));
		sendEvent(socket, {
			type: 'run_completed',
			runId: prompt.runId,
			result: finalResult
		});
	} catch (error) {
		sendEvent(socket, {
			type: 'run_failed',
			runId: prompt.runId,
			error: errorMessage(error)
		});
	} finally {
		runtime.activeRunId = undefined;
		runtime.currentResult = '';
	}
}

function handleAgentEvent(socket: WebSocket, runtime: WorkerRuntime, event: AgentEvent) {
	const runId = runtime.activeRunId;
	if (!runId) return;

	if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
		const text = event.assistantMessageEvent.delta;
		runtime.currentResult += text;
		sendEvent(socket, {
			type: 'text_delta',
			runId,
			text
		});
		return;
	}

	if (event.type === 'tool_execution_start') {
		sendEvent(socket, {
			type: 'tool_call',
			runId,
			message: formatToolCall(event.toolName, event.args)
		});
		return;
	}

	if (event.type === 'tool_execution_end') {
		sendEvent(socket, {
			type: 'tool_result',
			runId,
			message: formatToolEventResult(event.toolName, event.result, event.isError)
		});
	}
}

function handleContextCompaction(socket: WebSocket, runtime: WorkerRuntime, event: CompactEvent) {
	const runId = runtime.activeRunId;
	if (!runId) return;
	sendEvent(socket, {
		type: 'context_compacted',
		runId,
		message: `Context compacted at ~${event.estimatedTokens.toLocaleString()} tokens (threshold ~${event.thresholdTokens.toLocaleString()}); retained ${event.retainedMessages} of ${event.totalMessages} messages.`
	});
}

function compactMessagesIfNeeded(
	messages: AgentMessage[],
	config: AiAdminWorkerInitConfig,
	onCompact: (event: CompactEvent) => void
): AgentMessage[] {
	const estimatedTokens = estimateMessagesTokens(messages);
	const thresholdTokens = Math.floor(config.contextWindow * config.compactAt);
	if (estimatedTokens < thresholdTokens) {
		return messages;
	}

	const recent = messages.slice(-RECENT_MESSAGES_TO_KEEP);
	onCompact({
		estimatedTokens,
		thresholdTokens,
		retainedMessages: recent.length,
		totalMessages: messages.length
	});
	return [
		{
			role: 'user',
			content: `Earlier conversation context was pruned locally at ${new Date().toISOString()} because estimated usage approached ${Math.round(config.compactAt * 100)}% of the ${config.contextWindow} token window. Continue from the retained recent messages.`,
			timestamp: Date.now()
		},
		...recent
	];
}

function estimateMessagesTokens(messages: AgentMessage[]) {
	const chars = messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
	return Math.ceil(chars / 4);
}

function estimateMessageChars(message: AgentMessage) {
	if (!isRecord(message)) return 0;
	const content = message.content;
	if (typeof content === 'string') return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, block) => {
		if (!isRecord(block)) return sum;
		if (block.type === 'text' && typeof block.text === 'string') return sum + block.text.length;
		if (block.type === 'thinking' && typeof block.thinking === 'string') {
			return sum + block.thinking.length;
		}
		if (block.type === 'toolCall') return sum + safeJsonStringify(block).length;
		return sum;
	}, 0);
}

function assistantTextFromMessages(messages: AgentMessage[]) {
	return messages
		.filter(isAssistantMessage)
		.flatMap((message) => message.content)
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('');
}

function isAssistantMessage(message: AgentMessage): message is AgentMessage & {
	role: 'assistant';
	content: Array<{ type: string; text?: string }>;
} {
	return isRecord(message) && message.role === 'assistant' && Array.isArray(message.content);
}

function userPrompt(prompt: AiAdminWorkerPrompt) {
	return `Operation goal:\n${prompt.goal}`;
}

function toolRoot() {
	return path.resolve(env.workingDirectory ?? process.cwd());
}

function resolveToolPath(input: string): ToolPath {
	const rawPath = input.trim();
	if (!rawPath) throw new Error('Path is empty');
	if (rawPath.includes('\0')) throw new Error('Path contains a null byte');

	const root = toolRoot();
	const target = path.resolve(root, rawPath);
	const relative = path.relative(root, target);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`Path is outside worker working directory: ${input}`);
	}
	return {
		root,
		target,
		relative: relative || '.'
	};
}

function formatCommandResult(result: Awaited<ReturnType<typeof runCommand>>) {
	const parts = [
		`Command: ${result.command}`,
		`Exit code: ${result.exitCode ?? 'null'}`,
		`Duration: ${result.durationMs}ms`
	];
	if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
	if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
	return parts.join('\n\n');
}

function formatToolCall(toolName: string, args: unknown) {
	if (toolName === 'bash' && isRecord(args) && typeof args.command === 'string') {
		return `bash: ${args.command}`;
	}
	if ((toolName === 'read_file' || toolName === 'write_file') && isRecord(args)) {
		const target = typeof args.path === 'string' ? args.path : '(unknown path)';
		return `${toolName}: ${target}`;
	}
	return `${toolName}: ${safeJsonStringify(args)}`;
}

function formatToolEventResult(toolName: string, result: unknown, isError: boolean) {
	const prefix = isError ? `${toolName} failed` : `${toolName} completed`;
	if (!isRecord(result)) return prefix;
	const details = isRecord(result.details) ? result.details : undefined;

	if (toolName === 'bash' && details) {
		const exitCode =
			typeof details.exitCode === 'number' ? details.exitCode : (details.exitCode ?? 'null');
		const duration = typeof details.durationMs === 'number' ? ` in ${details.durationMs}ms` : '';
		const dryRun = details.dryRun === true ? ' (dry-run)' : '';
		return `${prefix}${dryRun}: exit ${exitCode}${duration}`;
	}
	if ((toolName === 'read_file' || toolName === 'write_file') && details) {
		const file = typeof details.path === 'string' ? details.path : '(unknown path)';
		const bytes = typeof details.bytes === 'number' ? `, ${details.bytes} bytes` : '';
		const dryRun = details.dryRun === true ? ' (dry-run)' : '';
		return `${prefix}${dryRun}: ${file}${bytes}`;
	}

	if (Array.isArray(result.content)) {
		const text = result.content
			.filter(
				(item): item is { type: 'text'; text: string } => isRecord(item) && item.type === 'text'
			)
			.map((item) => item.text)
			.join('\n')
			.trim();
		if (text) return `${prefix}: ${text.slice(0, 240)}`;
	}
	return prefix;
}

function workerWsUrl(apiBase: string, token: string) {
	const url = new URL('/ws/ai-admin-worker', apiBase);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('token', token);
	return url.toString();
}

function parseAdminMessage(raw: string): AiAdminAdminMessage | undefined {
	try {
		const parsed = JSON.parse(raw) as AiAdminAdminMessage;
		if (
			parsed.type === 'init_config' ||
			parsed.type === 'prompt' ||
			parsed.type === 'terminal_open' ||
			parsed.type === 'terminal_input' ||
			parsed.type === 'terminal_resize' ||
			parsed.type === 'terminal_close'
		) {
			return parsed;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function isTerminalAdminMessage(
	message: AiAdminAdminMessage
): message is Extract<AiAdminAdminMessage, { type: `terminal_${string}` }> {
	return (
		message.type === 'terminal_open' ||
		message.type === 'terminal_input' ||
		message.type === 'terminal_resize' ||
		message.type === 'terminal_close'
	);
}

function sendEvent(socket: WebSocket, event: AiAdminWorkerRunEvent) {
	send(socket, event);
}

function send(socket: WebSocket, payload: unknown) {
	if (socket.readyState === socket.OPEN) {
		socket.send(JSON.stringify(payload));
	}
}

function clampBytes(value: number, min: number, max: number) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error('Tool execution aborted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function safeJsonStringify(value: unknown) {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function errorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return typeof error === 'string' ? error : 'Unknown error';
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
