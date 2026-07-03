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
		await registerViteWebRoutes(app, env);
		return;
	}
	await registerBuiltWebRoutes(app, env);
}

async function registerViteWebRoutes(app: FastifyInstance, env: ServerConfig) {
	const { createServer } = await import('vite');
	const vite = await createServer({
		root: process.cwd(),
		server: {
			middlewareMode: {
				server: app.server
			},
			ws: {
				server: app.server,
				path: env.basePath ? `${env.basePath}/__vite_ws` : '/__vite_ws'
			}
		}
	});

	app.addHook('onClose', async () => {
		await vite.close();
	});

	registerNodeMiddleware(app, vite.middlewares as NodeMiddleware, env.basePath);
}

async function registerBuiltWebRoutes(app: FastifyInstance, env: ServerConfig) {
	const handlerPath = pathToFileURL(path.resolve(process.cwd(), 'build/handler.js')).href;
	const { handler } = (await import(handlerPath)) as { handler: NodeMiddleware };
	registerNodeMiddleware(app, handler, env.basePath);
}

function registerNodeMiddleware(
	app: FastifyInstance,
	middleware: NodeMiddleware,
	basePath: string
) {
	if (basePath) {
		app.route({
			method: ['GET', 'HEAD'],
			url: basePath,
			handler: (_request, reply) => {
				reply.redirect(`${basePath}/`);
			}
		});
	}
	app.route({
		method: ['GET', 'HEAD'],
		url: basePath ? `${basePath}/*` : '/*',
		handler: (request, reply) => {
			if (isBackendRoute(request.url, basePath)) {
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

function isBackendRoute(url: string, basePath: string) {
	const logicalUrl =
		basePath && (url === basePath || url.startsWith(`${basePath}/`))
			? url.slice(basePath.length) || '/'
			: url;
	return logicalUrl.startsWith('/api/') || logicalUrl === '/api' || logicalUrl.startsWith('/ws/');
}
