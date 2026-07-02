import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';
import type { AdminAuthResult } from './http';

type RequestContext = {
	actor: string;
	identity?: AdminAuthResult;
};

const requestContext = new AsyncLocalStorage<RequestContext>();

export function enterRequestContext(actor: string, identity?: AdminAuthResult) {
	requestContext.enterWith({ actor: sanitizeActor(actor), identity });
}

export function currentActor() {
	return requestContext.getStore()?.actor;
}

export function currentIdentity() {
	return requestContext.getStore()?.identity;
}

export function actorFromRequest(request: FastifyRequest, fallback = 'admin') {
	const raw = request.headers['x-ops-actor'];
	return sanitizeActor(Array.isArray(raw) ? raw[0] : (raw ?? fallback));
}

function sanitizeActor(value: unknown) {
	const actor = String(value ?? '')
		.trim()
		.replace(/[^\w@.+:-]/g, '-')
		.slice(0, 80);
	return actor || 'admin';
}
