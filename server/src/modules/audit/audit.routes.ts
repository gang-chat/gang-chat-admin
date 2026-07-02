import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../core/access-control';
import { ok } from '../../core/http';
import { parseInput } from '../../core/validation';
import type { AuditRepository } from './audit.repository';
import { auditQuerySchema } from './audit.schema';

export async function registerAuditRoutes(app: FastifyInstance, audit: AuditRepository) {
	app.get('/api/audit/integrity', async (request) => {
		requireRole(request, 'admin');
		return ok(await audit.integrity());
	});

	app.get('/api/audit/export', async (request) => {
		requireRole(request, 'admin');
		const exported = await audit.exportLog();
		await audit.record({
			action: 'audit.export',
			target: exported.checkpoint.headHash ?? 'empty',
			status: 'ok',
			detail: `${exported.checkpoint.total} events`
		});
		return ok(exported);
	});

	app.get('/api/audit', async (request) => {
		requireRole(request, 'admin');
		const query = parseInput(auditQuerySchema, request.query);
		return ok(await audit.list(query));
	});
}
