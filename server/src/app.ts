import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import type { ServerConfig } from './config/config';
import { HttpError, registerErrors, requireAuth } from './core/http';
import { actorFromRequest, enterRequestContext } from './core/request-context';
import { AgentService } from './modules/agent/agent.service';
import { registerAiAdminWorkerSocket } from './modules/agent/ai-admin-worker-hub';
import { registerAgentRoutes } from './modules/agent/agent.routes';
import { AuditRepository } from './modules/audit/audit.repository';
import { registerAuthRoutes } from './modules/auth/auth.routes';
import { AuthService } from './modules/auth/auth.service';
import { ConnectionsRepository } from './modules/connections/connections.repository';
import { registerConnectionRoutes } from './modules/connections/connections.routes';
import { ExpensesRepository } from './modules/expenses/expenses.repository';
import { registerExpenseRoutes } from './modules/expenses/expenses.routes';
import { MysqlService } from './modules/mysql/mysql.service';
import { registerMysqlRoutes } from './modules/mysql/mysql.routes';
import { S3Service } from './modules/s3/s3.service';
import { registerS3Routes } from './modules/s3/s3.routes';
import { registerSshRoutes } from './modules/ssh/ssh.routes';
import { registerWebRoutes } from './web/web.routes';

export async function buildApp(env: ServerConfig) {
	const app = Fastify({
		logger:
			env.nodeEnv === 'test'
				? false
				: {
						level: env.logLevel,
						transport: env.nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined
					},
		bodyLimit: env.bodyLimitBytes,
		trustProxy: env.trustProxy
	});

	registerErrors(app);
	await app.register(helmet, {
		contentSecurityPolicy: false
	});
	await app.register(cors, {
		origin: env.corsOrigin,
		credentials: true
	});
	await app.register(rateLimit, {
		max: env.rateLimitMax,
		timeWindow: env.rateLimitWindow,
		allowList: (request) => !request.url.startsWith('/api/'),
		keyGenerator: (request) =>
			request.headers.authorization
				? `${request.ip}:${request.headers.authorization.slice(0, 24)}`
				: request.ip
	});
	const backendWebsocketUpgrades = new EventEmitter();
	await app.register(websocket, {
		options: {
			server: backendWebsocketUpgrades as never
		}
	});
	app.server.on('upgrade', (request, socket, head) => {
		if (!request.url?.startsWith('/ws/')) return;
		backendWebsocketUpgrades.emit('upgrade', request, socket, head);
	});
	await app.register(multipart, {
		limits: {
			fileSize: env.uploadLimitBytes,
			files: 1
		}
	});

	const connections = new ConnectionsRepository(env.connections);
	const audit = new AuditRepository(env.dataDir, env.secretKey);
	const auth = new AuthService(
		env.dataDir,
		env.secretKey,
		env.sessionTtlMs,
		env.sessionIdleTimeoutMs,
		{
			username: env.bootstrapAdminUser,
			password: env.bootstrapAdminPassword,
			maxFailedLogins: env.authMaxFailedLogins,
			lockoutMs: env.authLockoutMs
		}
	);
	await auth.initialize();
	const mysql = new MysqlService(connections);
	const s3 = new S3Service(connections);
	const expenses = new ExpensesRepository(env.dataDir);
	const agent = new AgentService(env.dataDir);

	app.get('/api/health', async () => ({
		data: {
			status: 'ok',
			at: new Date().toISOString(),
			mode: env.nodeEnv
		}
	}));

	app.addHook('preHandler', async (request) => {
		enterRequestContext(actorFromRequest(request));
		if (
			request.url.startsWith('/api/health') ||
			request.url.startsWith('/ws/ssh') ||
			request.url.startsWith('/ws/ai-admin-worker')
		) {
			return;
		}
		if (!request.url.startsWith('/api/')) return;
		assertAllowedOrigin(env, request.headers.origin);
		if (request.url.startsWith('/api/auth/login')) {
			return;
		}
		if (request.url.startsWith('/api/agent/worker/')) return;
		const identity = await requireAuth(env, request, (token) => auth.validateToken(token));
		request.opsIdentity = identity;
		enterRequestContext(actorFromRequest(request, identity.actor), identity);
	});

	await registerAuthRoutes(app, { auth, audit });
	await registerConnectionRoutes(app, { connections, mysql, s3, audit });
	await registerMysqlRoutes(app, { mysql, audit });
	await registerS3Routes(app, { s3, audit });
	await registerExpenseRoutes(app, { expenses, audit });
	const aiAdminWorkerHub = registerAiAdminWorkerSocket(app, { env, agent });
	await registerAgentRoutes(app, { env, agent, audit, aiAdminWorkerHub });
	await registerSshRoutes(app, { env, connections, audit });
	await registerWebRoutes(app, env);

	return app;
}

function assertAllowedOrigin(env: ServerConfig, origin: string | undefined) {
	if (!origin) return;
	if (env.corsOrigin.includes(origin)) return;
	throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
}
