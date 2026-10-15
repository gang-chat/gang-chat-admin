import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../core/access-control';
import { ok } from '../../core/http';
import { parseInput } from '../../core/validation';
import type { AuditRepository } from '../audit/audit.repository';
import { auditErrorDetail } from '../audit/audit-error';
import {
	accountCreateSchema,
	accountIdParamSchema,
	accountListQuerySchema,
	accountUpdateSchema,
	membershipCreateSchema,
	membershipParamSchema,
	membershipUpdateSchema,
	passwordResetSchema,
	roomSearchQuerySchema
} from './accounts.schema';
import type { AccountsService } from './accounts.service';

export async function registerAccountRoutes(
	app: FastifyInstance,
	deps: { accounts: AccountsService; audit: AuditRepository }
) {
	// Records every write, including refused and failed ones.
	async function audited<T>(
		action: string,
		target: string,
		fn: () => Promise<T>,
		detail?: (result: T) => string
	) {
		try {
			const result = await fn();
			await deps.audit.record({ action, target, status: 'ok', detail: detail?.(result) });
			return result;
		} catch (error) {
			await deps.audit.record({
				action,
				target,
				status: 'failed',
				detail: auditErrorDetail(error, 'Account change failed')
			});
			throw error;
		}
	}

	app.get('/api/accounts', async (request) => {
		const query = parseInput(accountListQuerySchema, request.query);
		return ok(await deps.accounts.list(query));
	});

	app.get('/api/accounts/rooms', async (request) => {
		const { q } = parseInput(roomSearchQuerySchema, request.query);
		return ok(await deps.accounts.listRooms(q));
	});

	app.get('/api/accounts/:id', async (request) => {
		const { id } = parseInput(accountIdParamSchema, request.params);
		return ok(await deps.accounts.get(id));
	});

	app.post('/api/accounts', async (request) => {
		requireRole(request, 'operator');
		const body = parseInput(accountCreateSchema, request.body);
		const account = await audited(
			'accounts.create',
			body.username.trim(),
			() => deps.accounts.create(body),
			(created) => `uid ${created.uid}`
		);
		return ok(account);
	});

	app.patch('/api/accounts/:id', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(accountIdParamSchema, request.params);
		const body = parseInput(accountUpdateSchema, request.body);
		const account = await audited(
			'accounts.update',
			id,
			() => deps.accounts.update(id, body),
			() => Object.keys(body).join(', ')
		);
		return ok(account);
	});

	app.post('/api/accounts/:id/password', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(accountIdParamSchema, request.params);
		const body = parseInput(passwordResetSchema, request.body);
		const result = await audited(
			'accounts.password.reset',
			id,
			() => deps.accounts.resetPassword(id, body.password),
			(reset) => `${reset.username}; ${reset.revokedSessions} sessions signed out`
		);
		return ok(result);
	});

	app.post('/api/accounts/:id/sessions/revoke', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(accountIdParamSchema, request.params);
		const result = await audited(
			'accounts.sessions.revoke',
			id,
			() => deps.accounts.revokeAllSessions(id),
			(revoked) => `${revoked.username}; ${revoked.revokedSessions} sessions signed out`
		);
		return ok(result);
	});

	app.delete('/api/accounts/:id', async (request) => {
		requireRole(request, 'admin');
		const { id } = parseInput(accountIdParamSchema, request.params);
		const confirmation = request.headers['x-ops-confirmation'];
		const result = await audited(
			'accounts.delete',
			id,
			() => deps.accounts.delete(id, typeof confirmation === 'string' ? confirmation : undefined),
			(deleted) => `${deleted.username} (uid ${deleted.uid})`
		);
		return ok(result);
	});

	app.post('/api/accounts/:id/memberships', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(accountIdParamSchema, request.params);
		const body = parseInput(membershipCreateSchema, request.body);
		const result = await audited(
			'accounts.membership.add',
			`${id} -> ${body.roomId}`,
			() => deps.accounts.addMembership(id, body.roomId, body.role),
			(added) => `${added.username} joined ${added.room} as ${added.role}`
		);
		return ok(result);
	});

	app.patch('/api/accounts/:id/memberships/:roomId', async (request) => {
		requireRole(request, 'operator');
		const { id, roomId } = parseInput(membershipParamSchema, request.params);
		const body = parseInput(membershipUpdateSchema, request.body);
		const result = await audited(
			'accounts.membership.role',
			`${id} -> ${roomId}`,
			() => deps.accounts.updateMembershipRole(id, roomId, body.role),
			(changed) => `${changed.username} is ${changed.role} of ${changed.room}`
		);
		return ok(result);
	});

	app.delete('/api/accounts/:id/memberships/:roomId', async (request) => {
		requireRole(request, 'operator');
		const { id, roomId } = parseInput(membershipParamSchema, request.params);
		const result = await audited(
			'accounts.membership.remove',
			`${id} -> ${roomId}`,
			() => deps.accounts.removeMembership(id, roomId),
			(removed) => `${removed.username} left ${removed.room}`
		);
		return ok(result);
	});
}
