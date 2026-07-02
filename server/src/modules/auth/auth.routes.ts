import type { FastifyInstance } from 'fastify';
import { bearerToken, ok } from '../../core/http';
import { parseInput } from '../../core/validation';
import { auditErrorDetail } from '../audit/audit-error';
import type { AuditRepository } from '../audit/audit.repository';
import { authLoginBodySchema } from './auth.schema';
import type { AuthService } from './auth.service';

export async function registerAuthRoutes(
	app: FastifyInstance,
	deps: { auth: AuthService; audit: AuditRepository }
) {
	app.post('/api/auth/login', async (request) => {
		let target = 'unknown';
		try {
			const body = parseInput(authLoginBodySchema, request.body);
			target = body.username.trim().toLowerCase();
			const session = await deps.auth.login(body.username, body.password);
			await deps.audit.record({
				actor: session.user.displayName || session.user.username,
				action: 'auth.login',
				target: session.user.username,
				status: 'ok'
			});
			return ok(session);
		} catch (error) {
			await deps.audit.record({
				action: 'auth.login',
				target,
				status: 'failed',
				detail: auditErrorDetail(error, 'Login failed')
			});
			throw error;
		}
	});

	app.get('/api/auth/me', async (request) => {
		return ok(await deps.auth.me(bearerToken(request)));
	});

	app.post('/api/auth/logout', async (request) => {
		const revoked = await deps.auth.logout(bearerToken(request));
		await deps.audit.record({
			action: 'auth.logout',
			target: revoked ? 'session' : 'missing-session',
			status: revoked ? 'ok' : 'failed'
		});
		return ok({ revoked });
	});

}
