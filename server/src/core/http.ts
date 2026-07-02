import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRole } from '../../../src/lib/shared/ops-types';
import type { ServerConfig } from '../config/config';

export class HttpError extends Error {
	constructor(
		public statusCode: number,
		public code: string,
		message: string,
		public details?: unknown
	) {
		super(message);
	}
}

export function ok<T>(data: T) {
	return { data };
}

export function bearerToken(request: FastifyRequest) {
	const header = request.headers.authorization;
	return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

export type AdminAuthResult = {
	actor: string;
	authMethod: 'session';
	role: AuthRole;
	userId?: string;
};

declare module 'fastify' {
	interface FastifyRequest {
		opsIdentity?: AdminAuthResult;
	}
}

export async function requireAuth(
	_env: ServerConfig,
	request: FastifyRequest,
	validateSession?: (token: string | undefined) => Promise<AdminAuthResult | undefined>
): Promise<AdminAuthResult> {
	const token = bearerToken(request);
	const session = await validateSession?.(token);
	if (session) return session;
	throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
}

export function requireAgentWorkerAuth(env: ServerConfig, request: FastifyRequest) {
	const token = bearerToken(request);
	if (token !== env.agentWorkerToken) {
		throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid agent worker token');
	}
}

export function requireConfirmation(actual: string | undefined, expected: string, message: string) {
	if (actual !== expected) {
		throw new HttpError(400, 'DESTRUCTIVE_CONFIRMATION_REQUIRED', message);
	}
}

export function registerErrors(app: FastifyInstance) {
	app.setErrorHandler((error, _request, reply: FastifyReply) => {
		const err = error as Error & { statusCode?: number };
		if (err instanceof HttpError) {
			reply.status(err.statusCode).send({
				error: {
					code: err.code,
					message: err.message,
					details: err.details
				}
			});
			return;
		}

		const statusCode = Number(err.statusCode ?? 500);
		reply.status(Number.isFinite(statusCode) ? statusCode : 500).send({
			error: {
				code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
				message: err.message || 'Unexpected server error'
			}
		});
	});
}
