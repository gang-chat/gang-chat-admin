import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../core/access-control';
import { bearerToken, ok, requireConfirmation } from '../../core/http';
import { parseInput } from '../../core/validation';
import { auditErrorDetail } from '../audit/audit-error';
import type { AuditRepository } from '../audit/audit.repository';
import {
	authChangePasswordBodySchema,
	authCreateUserBodySchema,
	authLoginBodySchema,
	authSessionIdParamSchema,
	authUserIdParamSchema
} from './auth.schema';
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

	app.post('/api/auth/password', async (request) => {
		let revokeOtherSessions = true;
		try {
			const body = parseInput(authChangePasswordBodySchema, request.body);
			revokeOtherSessions = body.revokeOtherSessions;
			const user = await deps.auth.changePassword(
				bearerToken(request),
				body.currentPassword,
				body.newPassword,
				body.revokeOtherSessions
			);
			await deps.audit.record({
				actor: user.displayName || user.username,
				action: 'auth.password.change',
				target: user.username,
				status: 'ok',
				detail: body.revokeOtherSessions ? 'revoked-other-sessions' : undefined
			});
			return ok(user);
		} catch (error) {
			await deps.audit.record({
				action: 'auth.password.change',
				target: 'current-user',
				status: 'failed',
				detail: revokeOtherSessions
					? auditErrorDetail(error, 'Password change failed')
					: `${auditErrorDetail(error, 'Password change failed')} / keep-other-sessions`
			});
			throw error;
		}
	});

	app.get('/api/auth/sessions', async (request) => {
		return ok(await deps.auth.listSessions(bearerToken(request)));
	});

	app.delete('/api/auth/sessions/:id', async (request) => {
		const { id } = parseInput(authSessionIdParamSchema, request.params);
		requireConfirmation(
			request.headers['x-ops-confirmation'] as string | undefined,
			id,
			'Type the session id to revoke this session'
		);
		const session = await deps.auth.revokeSession(bearerToken(request), id);
		await deps.audit.record({
			actor: session.username,
			action: 'auth.session.revoke',
			target: id,
			status: 'ok',
			detail: session.current ? 'current-session' : session.username
		});
		return ok(session);
	});

	app.get('/api/auth/users', async (request) => {
		requireRole(request, 'admin');
		return ok(await deps.auth.listUsers());
	});

	app.post('/api/auth/users', async (request) => {
		requireRole(request, 'admin');
		let target = 'new-user';
		try {
			const body = parseInput(authCreateUserBodySchema, request.body);
			target = body.username.trim().toLowerCase();
			const user = await deps.auth.createUser(body);
			await deps.audit.record({
				action: 'auth.user.create',
				target: user.username,
				status: 'ok'
			});
			return ok(user);
		} catch (error) {
			await deps.audit.record({
				action: 'auth.user.create',
				target,
				status: 'failed',
				detail: auditErrorDetail(error, 'User create failed')
			});
			throw error;
		}
	});

	app.delete('/api/auth/users/:id', async (request, reply) => {
		requireRole(request, 'admin');
		const { id } = parseInput(authUserIdParamSchema, request.params);
		requireConfirmation(
			request.headers['x-ops-confirmation'] as string | undefined,
			id,
			'Type the user id to disable this user'
		);
		await deps.auth.disableUser(id);
		await deps.audit.record({
			action: 'auth.user.disable',
			target: id,
			status: 'ok'
		});
		reply.status(204).send();
	});
}
