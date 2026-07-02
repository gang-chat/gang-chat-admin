import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config/config';

type NodeMiddleware = (
	request: IncomingMessage,
	response: ServerResponse,
	next: (error?: unknown) => void
) => void | Promise<void>;

export async function registerWebRoutes(app: FastifyInstance, env: ServerConfig) {
	if (env.nodeEnv === 'test') return;
	if (env.nodeEnv === 'development') {
		await registerViteWebRoutes(app);
		return;
	}
	await registerBuiltWebRoutes(app);
}

async function registerViteWebRoutes(app: FastifyInstance) {
	const { createServer } = await import('vite');
	const vite = await createServer({
		root: process.cwd(),
		server: {
			middlewareMode: {
				server: app.server
			},
			ws: {
				server: app.server,
				path: '/__vite_ws'
			}
		}
	});

	app.addHook('onClose', async () => {
		await vite.close();
	});

	registerNodeMiddleware(app, vite.middlewares as NodeMiddleware);
}

async function registerBuiltWebRoutes(app: FastifyInstance) {
	const handlerPath = pathToFileURL(path.resolve(process.cwd(), 'build/handler.js')).href;
	const { handler } = (await import(handlerPath)) as { handler: NodeMiddleware };
	registerNodeMiddleware(app, handler);
}

function registerNodeMiddleware(app: FastifyInstance, middleware: NodeMiddleware) {
	app.route({
		method: ['GET', 'HEAD'],
		url: '/*',
		handler: (request, reply) => {
			if (isBackendRoute(request.url)) {
				reply.callNotFound();
				return;
			}
			runNodeMiddleware(app, request, reply, middleware);
		}
	});
}

function runNodeMiddleware(
	app: FastifyInstance,
	request: FastifyRequest,
	reply: FastifyReply,
	middleware: NodeMiddleware
) {
	reply.hijack();
	void Promise.resolve(
		middleware(request.raw, reply.raw, (error?: unknown) => {
			if (error) {
				app.log.error({ err: error }, 'web handler failed');
				sendFallback(reply.raw, 500, 'Web handler failed');
				return;
			}
			sendFallback(reply.raw, 404, 'Not found');
		})
	).catch((error) => {
		app.log.error({ err: error }, 'web handler failed');
		sendFallback(reply.raw, 500, 'Web handler failed');
	});
}

function sendFallback(response: ServerResponse, statusCode: number, message: string) {
	if (response.writableEnded) return;
	if (!response.headersSent) {
		response.statusCode = statusCode;
		response.setHeader('content-type', 'text/plain; charset=utf-8');
	}
	response.end(message);
}

function isBackendRoute(url: string) {
	return url.startsWith('/api/') || url === '/api' || url.startsWith('/ws/');
}
