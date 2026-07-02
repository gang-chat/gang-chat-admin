import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../core/access-control';
import { ok } from '../../core/http';
import { parseInput } from '../../core/validation';
import { auditErrorDetail } from '../audit/audit-error';
import type { AuditRepository } from '../audit/audit.repository';
import { restoreBodySchema, restorePreviewBodySchema } from './admin.schema';
import type { AdminService } from './admin.service';

export async function registerAdminRoutes(
	app: FastifyInstance,
	deps: { admin: AdminService; audit: AuditRepository }
) {
	app.get('/api/admin/backup', async (request) => {
		requireRole(request, 'admin');
		const backup = await deps.admin.exportBackup();
		await deps.audit.record({
			action: 'admin.backup.export',
			target: 'runtime-store',
			status: 'ok'
		});
		return ok(backup);
	});

	app.post('/api/admin/restore', async (request) => {
		requireRole(request, 'admin');
		try {
			const body = parseInput(restoreBodySchema, request.body);
			await deps.admin.restoreBackup(body.backup);
			await deps.audit.record({
				action: 'admin.backup.restore',
				target: 'runtime-store',
				status: 'ok',
				detail: body.backup.exportedAt
			});
			return ok({ restored: true });
		} catch (error) {
			await deps.audit.record({
				action: 'admin.backup.restore',
				target: 'runtime-store',
				status: 'failed',
				detail: auditErrorDetail(error, 'Backup restore failed')
			});
			throw error;
		}
	});

	app.post('/api/admin/restore/preview', async (request) => {
		requireRole(request, 'admin');
		try {
			const body = parseInput(restorePreviewBodySchema, request.body);
			const preview = await deps.admin.previewRestore(body.backup);
			await deps.audit.record({
				action: 'admin.backup.restore.preview',
				target: 'runtime-store',
				status: 'ok',
				detail: body.backup.exportedAt
			});
			return ok(preview);
		} catch (error) {
			await deps.audit.record({
				action: 'admin.backup.restore.preview',
				target: 'runtime-store',
				status: 'failed',
				detail: auditErrorDetail(error, 'Backup restore preview failed')
			});
			throw error;
		}
	});
}
