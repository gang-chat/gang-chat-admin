import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config/config';
import { HttpError, registerErrors, requireAuth } from './core/http';
import { actorFromRequest, enterRequestContext } from './core/request-context';
import { AccountsService } from './modules/accounts/accounts.service';
import { registerAccountRoutes } from './modules/accounts/accounts.routes';
import { AuditRepository } from './modules/audit/audit.repository';
import { registerAuthRoutes } from './modules/auth/auth.routes';
import { AuthService } from './modules/auth/auth.service';
import { ConnectionsRepository } from './modules/connections/connections.repository';
import { registerConnectionRoutes } from './modules/connections/connections.routes';
import { MysqlService } from './modules/mysql/mysql.service';
import { registerMysqlRoutes } from './modules/mysql/mysql.routes';
import { S3Service } from './modules/s3/s3.service';
import { registerS3Routes } from './modules/s3/s3.routes';
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
		allowList: (request) => !logicalUrl(env, request.url).startsWith('/api/'),
		keyGenerator: (request) =>
			request.headers.authorization
				? `${request.ip}:${request.headers.authorization.slice(0, 24)}`
				: request.ip
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
	const s3 = new S3Service(connections, env.releaseSync);
	const accounts = new AccountsService(connections, mysql);

	app.addHook('preHandler', async (request) => {
		const url = logicalUrl(env, request.url);
		enterRequestContext(actorFromRequest(request));
		if (url.startsWith('/api/health')) return;
		if (!url.startsWith('/api/')) return;
		assertAllowedOrigin(env, request.headers.origin);
		if (url.startsWith('/api/auth/login')) {
			return;
		}
		const identity = await requireAuth(env, request, (token) => auth.validateToken(token));
		request.opsIdentity = identity;
		enterRequestContext(actorFromRequest(request, identity.actor), identity);
	});

	const registerBackendRoutes = async (scope: FastifyInstance) => {
		scope.get('/api/health', async () => ({
			data: {
				status: 'ok',
				at: new Date().toISOString(),
				mode: env.nodeEnv
			}
		}));
		await registerAuthRoutes(scope, { auth, audit });
		await registerConnectionRoutes(scope, { connections, mysql, s3, audit });
		await registerMysqlRoutes(scope, { mysql, audit });
		await registerS3Routes(scope, { s3, audit });
		await registerAccountRoutes(scope, { accounts, audit });
	};
	if (env.basePath) {
		await app.register(registerBackendRoutes, { prefix: env.basePath });
	} else {
		await registerBackendRoutes(app);
	}
	await registerWebRoutes(app, env);

	return app;
}

function assertAllowedOrigin(env: ServerConfig, origin: string | undefined) {
	if (!origin) return;
	if (env.corsOrigin.includes(origin)) return;
	throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
}

function logicalUrl(env: ServerConfig, url: string) {
	if (!env.basePath) return url;
	if (url === env.basePath) return '/';
	if (url.startsWith(`${env.basePath}/`)) {
		return url.slice(env.basePath.length) || '/';
	}
	return url;
}
