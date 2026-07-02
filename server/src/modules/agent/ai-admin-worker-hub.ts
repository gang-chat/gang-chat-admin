import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import type { ServerConfig } from '../../config/config';
import { HttpError, bearerToken } from '../../core/http';
import {
	AI_ADMIN_WORKER_VERSION,
	type AiAdminAdminMessage,
	type AiAdminWorkerMessage,
	type AiAdminWorkerPrompt
} from '../../ai-admin-worker/protocol';
import {
	AI_ADMIN_COMPACT_THRESHOLD,
	AI_ADMIN_CONTEXT_WINDOW_TOKENS,
	type AgentService
} from './agent.service';

type ActiveAiAdminWorker = {
	socket: WebSocket;
	workerId?: string;
	version?: string;
	connectedAt: string;
	terminalClients: Map<string, TerminalClient>;
};

type TerminalClient = {
	socket: WebSocket;
	terminalId: string;
	closingFromWorker?: boolean;
};

type TerminalTicket = {
	workerId: string;
	expiresAt: number;
};

type TerminalClientMessage =
	| { type: 'input'; data: string }
	| { type: 'resize'; cols: number; rows: number }
	| { type: 'ping' };

const TERMINAL_TICKET_TTL_MS = 30_000;
const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const MIN_TERMINAL_COLS = 20;
const MAX_TERMINAL_COLS = 300;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_ROWS = 120;

export class AiAdminWorkerHub {
	private readonly activeByWorkerId = new Map<string, ActiveAiAdminWorker>();
	private readonly terminalTickets = new Map<string, TerminalTicket>();

	constructor(
		private readonly app: FastifyInstance,
		private readonly env: ServerConfig,
		private readonly agent: AgentService
	) {}

	register() {
		void this.agent.resetAiAdminWorkerConnections().catch((error) => {
			this.app.log.warn({ err: error }, 'failed to reset ai admin worker connection state');
		});
		this.agent.setOpsPromptDispatcher((workerId, prompt) => this.sendPrompt(workerId, prompt));

		this.app.get(
			'/ws/ai-admin-worker',
			{ websocket: true },
			async (socket, request: FastifyRequest) => {
				await this.handleConnection(socket as WebSocket, request);
			}
		);
		this.app.get(
			'/ws/agent/workers/:workerId/terminal',
			{ websocket: true },
			async (socket, request: FastifyRequest) => {
				await this.handleTerminalClient(socket as WebSocket, request);
			}
		);
	}

	sendPrompt(workerId: string, prompt: AiAdminWorkerPrompt) {
		const active = this.activeByWorkerId.get(workerId);
		if (!active || active.socket.readyState !== active.socket.OPEN) {
			throw new HttpError(
				503,
				'AI_ADMIN_WORKER_OFFLINE',
				'Selected AI admin worker is not connected'
			);
		}
		this.send(active.socket, { type: 'prompt', prompt });
	}

	createTerminalTicket(workerId: string) {
		const active = this.activeByWorkerId.get(workerId);
		if (!active || active.socket.readyState !== active.socket.OPEN) {
			throw new HttpError(
				503,
				'AI_ADMIN_WORKER_OFFLINE',
				'Selected AI admin worker is not connected'
			);
		}
		this.pruneTerminalTickets();
		const ticket = nanoid(32);
		const expiresAt = Date.now() + TERMINAL_TICKET_TTL_MS;
		this.terminalTickets.set(ticket, { workerId, expiresAt });
		return { ticket, expiresAt: new Date(expiresAt).toISOString() };
	}

	private async handleConnection(socket: WebSocket, request: FastifyRequest) {
		if (!this.isAuthorized(request)) {
			socket.close(1008, 'Unauthorized');
			return;
		}

		const active: ActiveAiAdminWorker = {
			socket,
			connectedAt: new Date().toISOString(),
			terminalClients: new Map()
		};
		this.app.log.info('ai admin worker connected');

		this.send(socket, {
			type: 'init_config',
			config: {
				baseUrl: this.env.aiAdminWorker.baseUrl,
				apiKey: this.env.aiAdminWorker.apiKey,
				model: this.env.aiAdminWorker.model,
				contextWindow: AI_ADMIN_CONTEXT_WINDOW_TOKENS,
				compactAt: AI_ADMIN_COMPACT_THRESHOLD
			}
		});

		socket.on('message', (raw) => {
			void this.handleWorkerMessage(active, raw);
		});

		socket.on('close', () => {
			for (const client of active.terminalClients.values()) {
				if (client.socket.readyState === client.socket.OPEN) {
					client.socket.close(1011, 'AI admin worker disconnected');
				}
			}
			active.terminalClients.clear();
			const workerId = active.workerId;
			if (workerId && this.activeByWorkerId.get(workerId) === active) {
				this.activeByWorkerId.delete(workerId);
				void this.agent.disconnectAiAdminWorker(workerId).catch((error) => {
					this.app.log.warn(
						{ err: error, workerId },
						'failed to mark ai admin worker disconnected'
					);
				});
			}
			this.app.log.info(
				{
					workerId: active.workerId,
					version: active.version,
					connectedAt: active.connectedAt
				},
				'ai admin worker disconnected'
			);
			if (!workerId) return;
			void this.agent.failActiveOpsRuns('AI admin worker disconnected', workerId).catch((error) => {
				this.app.log.warn({ err: error }, 'failed to mark active ai admin runs as failed');
			});
		});
	}

	private async handleWorkerMessage(active: ActiveAiAdminWorker, raw: RawData) {
		let message: AiAdminWorkerMessage;
		try {
			message = JSON.parse(raw.toString()) as AiAdminWorkerMessage;
		} catch {
			active.socket.close(1003, 'Invalid JSON message');
			return;
		}

		if (message.type === 'hello') {
			const workerId = message.workerId.trim();
			if (!workerId) {
				active.socket.close(1008, 'Worker id is required');
				return;
			}
			const previousWorkerId = active.workerId;
			if (
				previousWorkerId &&
				previousWorkerId !== workerId &&
				this.activeByWorkerId.get(previousWorkerId) === active
			) {
				this.activeByWorkerId.delete(previousWorkerId);
			}
			const previous = this.activeByWorkerId.get(workerId);
			if (previous && previous !== active && previous.socket.readyState === previous.socket.OPEN) {
				previous.socket.close(1012, 'Replaced by newer AI admin worker connection');
			}
			active.workerId = workerId;
			active.version = message.version.trim() || AI_ADMIN_WORKER_VERSION;
			this.activeByWorkerId.set(workerId, active);
			await this.agent.connectAiAdminWorker({
				workerId,
				apiBase: message.apiBase,
				hostname: message.hostname,
				version: active.version,
				execute: message.execute,
				allowedCommands: message.allowedCommands,
				terminal: message.terminal
			});
			this.app.log.info(
				{ workerId: active.workerId, version: active.version },
				'ai admin worker identified'
			);
			return;
		}

		if (
			message.type === 'terminal_output' ||
			message.type === 'terminal_status' ||
			message.type === 'terminal_error'
		) {
			this.forwardTerminalMessage(active, message);
			return;
		}

		try {
			await this.agent.applyOpsWorkerEvent(message);
		} catch (error) {
			this.app.log.warn(
				{
					err: error,
					type: message.type,
					runId: 'runId' in message ? message.runId : undefined
				},
				'failed to apply ai admin worker event'
			);
		}
	}

	private isAuthorized(request: FastifyRequest) {
		const query = request.query as { token?: string } | undefined;
		return (
			query?.token === this.env.agentWorkerToken ||
			bearerToken(request) === this.env.agentWorkerToken
		);
	}

	private send(socket: WebSocket, message: AiAdminAdminMessage) {
		socket.send(JSON.stringify(message));
	}

	private async handleTerminalClient(socket: WebSocket, request: FastifyRequest) {
		const { workerId } = request.params as { workerId: string };
		const query = request.query as { ticket?: string; cols?: string; rows?: string };
		if (!this.consumeTerminalTicket(query.ticket, workerId)) {
			socket.close(1008, 'Unauthorized');
			return;
		}
		const active = this.activeByWorkerId.get(workerId);
		if (!active || active.socket.readyState !== active.socket.OPEN) {
			socket.close(1013, 'Selected AI admin worker is not connected');
			return;
		}
		const terminalId = nanoid(12);
		const cols = boundedNumber(query.cols, 120, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
		const rows = boundedNumber(query.rows, 32, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
		const client: TerminalClient = { socket, terminalId };
		active.terminalClients.set(terminalId, client);
		this.send(active.socket, { type: 'terminal_open', terminalId, cols, rows });

		socket.on('message', (raw) => {
			const message = parseTerminalClientMessage(raw.toString());
			if (!message) return;
			if (message.type === 'ping') {
				if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'pong' }));
				return;
			}
			if (message.type === 'input') {
				this.send(active.socket, {
					type: 'terminal_input',
					terminalId,
					data: message.data
				});
				return;
			}
			this.send(active.socket, {
				type: 'terminal_resize',
				terminalId,
				cols: message.cols,
				rows: message.rows
			});
		});

		socket.on('close', () => {
			active.terminalClients.delete(terminalId);
			if (client.closingFromWorker) return;
			if (active.socket.readyState === active.socket.OPEN) {
				this.send(active.socket, { type: 'terminal_close', terminalId });
			}
		});
	}

	private forwardTerminalMessage(
		active: ActiveAiAdminWorker,
		message: Extract<AiAdminWorkerMessage, { type: `terminal_${string}` }>
	) {
		const client = active.terminalClients.get(message.terminalId);
		if (!client || client.socket.readyState !== client.socket.OPEN) return;
		if (message.type === 'terminal_output') {
			client.socket.send(JSON.stringify({ type: 'data', data: message.data }));
			return;
		}
		if (message.type === 'terminal_error') {
			client.socket.send(JSON.stringify({ type: 'error', message: message.message }));
			return;
		}
		client.socket.send(
			JSON.stringify({ type: 'status', status: message.status, message: message.message })
		);
		if (message.status === 'closed') {
			client.closingFromWorker = true;
			active.terminalClients.delete(message.terminalId);
			client.socket.close(1000, message.message ?? 'Terminal closed');
		}
	}

	private consumeTerminalTicket(ticket: string | undefined, workerId: string) {
		this.pruneTerminalTickets();
		if (!ticket) return false;
		const stored = this.terminalTickets.get(ticket);
		if (!stored || stored.workerId !== workerId) return false;
		this.terminalTickets.delete(ticket);
		return true;
	}

	private pruneTerminalTickets() {
		const now = Date.now();
		for (const [ticket, value] of this.terminalTickets) {
			if (value.expiresAt <= now) this.terminalTickets.delete(ticket);
		}
	}
}

function parseTerminalClientMessage(raw: string): TerminalClientMessage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') return undefined;
	const item = parsed as Partial<TerminalClientMessage>;
	if (item.type === 'ping') return { type: 'ping' };
	if (item.type === 'input' && typeof item.data === 'string') {
		if (Buffer.byteLength(item.data) > MAX_TERMINAL_INPUT_BYTES) return undefined;
		return { type: 'input', data: item.data };
	}
	if (item.type === 'resize') {
		return {
			type: 'resize',
			cols: boundedNumber(item.cols, 120, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
			rows: boundedNumber(item.rows, 32, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
		};
	}
	return undefined;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
	const parsed = Number(value ?? fallback);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function registerAiAdminWorkerSocket(
	app: FastifyInstance,
	deps: { env: ServerConfig; agent: AgentService }
) {
	const hub = new AiAdminWorkerHub(app, deps.env, deps.agent);
	hub.register();
	return hub;
}
