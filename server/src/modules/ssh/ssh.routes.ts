import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { Client } from 'ssh2';
import type {
	SshActiveSession,
	SshPublicConfig,
	SshSessionStatus
} from '../../../../src/lib/shared/ops-types';
import type { ServerConfig } from '../../config/config';
import { requireRole } from '../../core/access-control';
import { HttpError, ok, requireConfirmation } from '../../core/http';
import { idParamSchema, parseInput } from '../../core/validation';
import type { AuditRepository } from '../audit/audit.repository';
import type { ConnectionsRepository } from '../connections/connections.repository';

type SshSecret = {
	password?: string;
	privateKey?: string;
	passphrase?: string;
};

type TerminalMessage =
	| { type: 'input'; data: string }
	| { type: 'resize'; cols: number; rows: number }
	| { type: 'ping' };

type SshTicket = {
	connectionId: string;
	expiresAt: number;
};

type ActiveSshSession = {
	public: SshActiveSession;
	close: (detail: string) => Promise<void>;
};

const MAX_INPUT_BYTES = 64 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 300;
const MIN_ROWS = 5;
const MAX_ROWS = 120;

export async function registerSshRoutes(
	app: FastifyInstance,
	deps: {
		env: ServerConfig;
		connections: ConnectionsRepository;
		audit: AuditRepository;
	}
) {
	const tickets = new Map<string, SshTicket>();
	const activeSessions = new Map<string, ActiveSshSession>();

	app.get('/api/ssh/sessions', async (request) => {
		requireRole(request, 'operator');
		return ok(listActiveSessions(activeSessions));
	});

	app.delete('/api/ssh/sessions/:id', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		requireConfirmation(
			request.headers['x-ops-confirmation']?.toString(),
			id,
			'Confirm the SSH session id to close this terminal'
		);
		const session = activeSessions.get(id);
		if (!session) throw new HttpError(404, 'SSH_SESSION_NOT_FOUND', 'SSH session not found');
		await session.close('force-closed');
		await deps.audit.record({
			action: 'ssh.session.kill',
			target: id,
			status: 'ok'
		});
		return ok({ closed: true });
	});

	app.post('/api/ssh/:id/ticket', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		const preset = await deps.connections.get(id);
		if (preset.type !== 'ssh') {
			throw new HttpError(400, 'WRONG_CONNECTION_TYPE', 'Connection preset is not SSH');
		}
		const publicConfig = preset.config as SshPublicConfig;
		if (deps.env.sshRequireHostKeyVerification && !publicConfig.hostKeySha256) {
			await deps.audit.record({
				action: 'ssh.ticket.create',
				target: id,
				status: 'failed',
				detail: 'SSH host key fingerprint is required'
			});
			throw new HttpError(
				400,
				'SSH_HOST_KEY_REQUIRED',
				'SSH host key fingerprint is required for this environment'
			);
		}

		pruneTickets(tickets);
		const ticket = nanoid(32);
		const expiresAt = Date.now() + deps.env.sshTicketTtlMs;
		tickets.set(ticket, { connectionId: id, expiresAt });
		await deps.audit.record({
			action: 'ssh.ticket.create',
			target: id,
			status: 'ok'
		});

		return ok({
			ticket,
			expiresAt: new Date(expiresAt).toISOString()
		});
	});

	app.get('/ws/ssh/:id', { websocket: true }, async (socket, request: FastifyRequest) => {
		const { id } = request.params as { id: string };
		const query = request.query as { ticket?: string; cols?: string; rows?: string };
		if (!consumeTicket(tickets, query.ticket, id)) {
			socket.close(1008, 'Unauthorized');
			return;
		}

		if (activeSessions.size >= deps.env.sshMaxSessions) {
			await deps.audit.record({
				action: 'ssh.connect',
				target: id,
				status: 'failed',
				detail: 'SSH session limit reached'
			});
			socket.close(1013, 'SSH session limit reached');
			return;
		}

		const sessionId = nanoid(12);
		const ssh = new Client();
		let stream:
			| (NodeJS.ReadWriteStream & {
					setWindow?: (rows: number, cols: number, height: number, width: number) => void;
			  })
			| undefined;
		let closed = false;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const cols = Number(query.cols ?? 120);
		const rows = Number(query.rows ?? 32);
		const startedAt = new Date().toISOString();

		const send = (payload: unknown) => {
			if (!closed && socket.readyState === socket.OPEN) {
				socket.send(JSON.stringify(payload));
			}
		};

		const closeSession = async (detail: string) => {
			if (closed) return;
			closed = true;
			if (idleTimer) clearTimeout(idleTimer);
			updateSession(activeSessions, sessionId, { status: 'closing' });
			activeSessions.delete(sessionId);
			stream?.end();
			ssh.end();
			if (socket.readyState === socket.OPEN) {
				socket.close(1000, detail);
			}
			await deps.audit.record({
				action: 'ssh.disconnect',
				target: id,
				status: 'ok',
				detail
			});
		};
		activeSessions.set(sessionId, {
			public: {
				id: sessionId,
				connectionId: id,
				target: id,
				startedAt,
				lastActiveAt: startedAt,
				status: 'connecting',
				cols,
				rows
			},
			close: closeSession
		});

		const resetIdleTimer = () => {
			updateSession(activeSessions, sessionId, { lastActiveAt: new Date().toISOString() });
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				send({ type: 'error', message: 'SSH session closed after idle timeout' });
				socket.close(1000, 'SSH session idle timeout');
				void closeSession('idle-timeout');
			}, deps.env.sshIdleTimeoutMs);
		};

		try {
			resetIdleTimer();
			const preset = await deps.connections.getWithSecrets(id);
			if (preset.type !== 'ssh') {
				socket.close(1003, 'Connection preset is not SSH');
				await closeSession('wrong-connection-type');
				return;
			}
			const config = preset.config as SshPublicConfig;
			const secrets = preset.secrets as SshSecret;
			updateSession(activeSessions, sessionId, {
				connectionName: preset.name,
				target: `${config.username}@${config.host}:${config.port}`,
				host: config.host,
				port: config.port,
				username: config.username
			});

			await deps.audit.record({
				action: 'ssh.connect',
				target: `${config.username}@${config.host}:${config.port}`,
				status: 'pending'
			});

			ssh
				.on('ready', async () => {
					updateSession(activeSessions, sessionId, { status: 'connected' });
					send({ type: 'status', status: 'connected' });
					await deps.audit.record({
						action: 'ssh.connect',
						target: `${config.username}@${config.host}:${config.port}`,
						status: 'ok'
					});
					ssh.shell({ term: 'xterm-256color', cols, rows }, (error, shellStream) => {
						if (error) {
							send({ type: 'error', message: error.message });
							void deps.audit.record({
								action: 'ssh.shell',
								target: `${config.username}@${config.host}:${config.port}`,
								status: 'failed',
								detail: error.message
							});
							socket.close(1011, error.message);
							return;
						}
						stream = shellStream;
						shellStream.on('data', (data: Buffer) => {
							resetIdleTimer();
							send({ type: 'data', data: data.toString('utf8') });
						});
						shellStream.stderr.on('data', (data: Buffer) => {
							resetIdleTimer();
							send({ type: 'data', data: data.toString('utf8') });
						});
						shellStream.on('close', () => {
							send({ type: 'status', status: 'closed' });
							socket.close();
						});
					});
				})
				.on('error', async (error) => {
					send({ type: 'error', message: error.message });
					await deps.audit.record({
						action: 'ssh.connect',
						target: id,
						status: 'failed',
						detail: error.message
					});
					socket.close(1011, error.message);
				})
				.on('close', () => {
					if (!closed) send({ type: 'status', status: 'closed' });
				})
				.connect({
					host: config.host,
					port: config.port,
					username: config.username,
					password: secrets.password || undefined,
					privateKey: secrets.privateKey || undefined,
					passphrase: secrets.passphrase || undefined,
					readyTimeout: deps.env.sshReadyTimeoutMs,
					keepaliveInterval: deps.env.sshKeepaliveIntervalMs,
					...hostKeyVerificationOptions(config.hostKeySha256)
				});

			socket.on('message', (raw: Buffer) => {
				resetIdleTimer();
				const message = parseTerminalMessage(raw.toString());
				if (!message) return;
				if (message.type === 'input') stream?.write(message.data);
				if (message.type === 'resize') {
					updateSession(activeSessions, sessionId, { cols: message.cols, rows: message.rows });
					stream?.setWindow?.(message.rows, message.cols, 0, 0);
				}
				if (message.type === 'ping') send({ type: 'pong' });
			});

			socket.on('close', async () => {
				await closeSession('socket-closed');
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'SSH session failed';
			send({ type: 'error', message });
			await closeSession('session-failed');
			socket.close(1011, message);
		}
	});
}

function listActiveSessions(activeSessions: Map<string, ActiveSshSession>) {
	return Array.from(activeSessions.values())
		.map((session) => session.public)
		.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function updateSession(
	activeSessions: Map<string, ActiveSshSession>,
	sessionId: string,
	patch: Partial<Omit<SshActiveSession, 'id'> & { status: SshSessionStatus }>
) {
	const session = activeSessions.get(sessionId);
	if (!session) return;
	session.public = { ...session.public, ...patch };
}

export function normalizeSshHostKeySha256(value: string | undefined) {
	if (!value) return undefined;
	const normalized = value.trim().replace(/^SHA256:/i, '');
	if (!normalized) return undefined;
	return normalized.includes(':') ? normalized.replaceAll(':', '').toLowerCase() : normalized;
}

export function verifySshHostKeySha256(expected: string | undefined, actual: string) {
	const expectedNormalized = normalizeSshHostKeySha256(expected);
	const actualNormalized = normalizeSshHostKeySha256(actual);
	return Boolean(expectedNormalized && actualNormalized && expectedNormalized === actualNormalized);
}

function hostKeyVerificationOptions(hostKeySha256: string | undefined) {
	const expected = normalizeSshHostKeySha256(hostKeySha256);
	if (!expected) return {};
	return {
		hostHash: 'sha256' as const,
		hostVerifier: (actual: string) => verifySshHostKeySha256(expected, actual)
	};
}

function pruneTickets(tickets: Map<string, SshTicket>) {
	const now = Date.now();
	for (const [ticket, value] of tickets) {
		if (value.expiresAt <= now) tickets.delete(ticket);
	}
}

function consumeTicket(
	tickets: Map<string, SshTicket>,
	ticket: string | undefined,
	connectionId: string
) {
	if (!ticket) return false;
	const value = tickets.get(ticket);
	tickets.delete(ticket);
	return Boolean(value && value.connectionId === connectionId && value.expiresAt > Date.now());
}

export function parseTerminalMessage(value: string): TerminalMessage | undefined {
	try {
		const parsed = JSON.parse(value) as TerminalMessage;
		if (
			parsed.type === 'input' &&
			typeof parsed.data === 'string' &&
			Buffer.byteLength(parsed.data, 'utf8') <= MAX_INPUT_BYTES
		) {
			return parsed;
		}
		if (
			parsed.type === 'resize' &&
			Number.isInteger(parsed.cols) &&
			Number.isInteger(parsed.rows) &&
			parsed.cols >= MIN_COLS &&
			parsed.cols <= MAX_COLS &&
			parsed.rows >= MIN_ROWS &&
			parsed.rows <= MAX_ROWS
		) {
			return parsed;
		}
		if (parsed.type === 'ping') return parsed;
		return undefined;
	} catch {
		if (Buffer.byteLength(value, 'utf8') > MAX_INPUT_BYTES) return undefined;
		return { type: 'input', data: value };
	}
}
