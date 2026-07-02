import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../core/access-control';
import { HttpError, ok, requireConfirmation } from '../../core/http';
import { idParamSchema, parseInput } from '../../core/validation';
import type { AuditRepository } from '../audit/audit.repository';
import { auditErrorDetail } from '../audit/audit-error';
import type { MysqlService } from '../mysql/mysql.service';
import type { S3Service } from '../s3/s3.service';
import type { ConnectionsRepository } from './connections.repository';
import { connectionInputSchema, connectionTypeQuerySchema } from './connections.schema';

export async function registerConnectionRoutes(
	app: FastifyInstance,
	deps: {
		connections: ConnectionsRepository;
		mysql: MysqlService;
		s3: S3Service;
		audit: AuditRepository;
	}
) {
	app.get('/api/connections', async (request) => {
		const { type } = parseInput(connectionTypeQuerySchema, request.query);
		return ok(await deps.connections.list(type));
	});

	app.post('/api/connections', async (request) => {
		requireRole(request, 'admin');
		try {
			const input = parseInput(connectionInputSchema, request.body);
			const preset = await deps.connections.create(input);
			await deps.audit.record({
				action: 'connection.create',
				target: `${preset.type}:${preset.name}`,
				status: 'ok'
			});
			return ok(preset);
		} catch (error) {
			await deps.audit.record({
				action: 'connection.create',
				target: 'new',
				status: 'failed',
				detail: auditErrorDetail(error, 'Connection create failed')
			});
			throw error;
		}
	});

	app.put('/api/connections/:id', async (request) => {
		requireRole(request, 'admin');
		const { id } = parseInput(idParamSchema, request.params);
		try {
			const input = parseInput(connectionInputSchema, request.body);
			const preset = await deps.connections.update(id, input);
			await deps.audit.record({
				action: 'connection.update',
				target: `${preset.type}:${preset.name}`,
				status: 'ok'
			});
			return ok(preset);
		} catch (error) {
			await deps.audit.record({
				action: 'connection.update',
				target: id,
				status: 'failed',
				detail: auditErrorDetail(error, 'Connection update failed')
			});
			throw error;
		}
	});

	app.delete('/api/connections/:id', async (request, reply) => {
		requireRole(request, 'admin');
		const { id } = parseInput(idParamSchema, request.params);
		try {
			requireConfirmation(
				request.headers['x-ops-confirmation']?.toString(),
				id,
				'Confirm the connection id to delete this preset'
			);
			await deps.connections.remove(id);
			await deps.audit.record({
				action: 'connection.delete',
				target: id,
				status: 'ok'
			});
			reply.status(204).send();
		} catch (error) {
			await deps.audit.record({
				action: 'connection.delete',
				target: id,
				status: 'failed',
				detail: auditErrorDetail(error, 'Connection delete failed')
			});
			throw error;
		}
	});

	app.post('/api/connections/:id/test', async (request) => {
		requireRole(request, 'admin');
		const { id } = parseInput(idParamSchema, request.params);
		const preset = await deps.connections.get(id);
		try {
			if (preset.type === 'mysql') await deps.mysql.test(id);
			else if (preset.type === 's3') await deps.s3.test(id);
			else
				throw new HttpError(400, 'SSH_TEST_UNSUPPORTED', 'Use the terminal workspace to test SSH');
			await deps.connections.setStatus(id, 'healthy');
			await deps.audit.record({
				action: 'connection.test',
				target: `${preset.type}:${preset.name}`,
				status: 'ok'
			});
			return ok({ status: 'healthy' });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Connection test failed';
			await deps.connections.setStatus(id, 'failed', message);
			await deps.audit.record({
				action: 'connection.test',
				target: `${preset.type}:${preset.name}`,
				status: 'failed',
				detail: message
			});
			throw error;
		}
	});
}
