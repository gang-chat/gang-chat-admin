import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../core/access-control';
import { ok, requireConfirmation } from '../../core/http';
import { paginationQuerySchema, parseInput, tableParamSchema } from '../../core/validation';
import type { AuditRepository } from '../audit/audit.repository';
import { auditErrorDetail } from '../audit/audit-error';
import {
	deleteRowBodySchema,
	insertRowBodySchema,
	sqlQueryBodySchema,
	updateRowBodySchema
} from './mysql.schema';
import type { MysqlService } from './mysql.service';

export async function registerMysqlRoutes(
	app: FastifyInstance,
	deps: { mysql: MysqlService; audit: AuditRepository }
) {
	app.get('/api/mysql/:id/tables', async (request) => {
		const { id } = parseInput(tableParamSchema.pick({ id: true }), request.params);
		return ok(await deps.mysql.listTables(id));
	});

	app.get('/api/mysql/:id/tables/:table/schema', async (request) => {
		const { id, table } = parseInput(tableParamSchema, request.params);
		return ok(await deps.mysql.describeTable(id, table));
	});

	app.get('/api/mysql/:id/tables/:table/rows', async (request) => {
		const { id, table } = parseInput(tableParamSchema, request.params);
		const query = parseInput(paginationQuerySchema, request.query);
		return ok(await deps.mysql.readRows(id, table, query.limit, query.offset));
	});

	app.post('/api/mysql/:id/tables/:table/rows', async (request) => {
		requireRole(request, 'operator');
		const { id, table } = parseInput(tableParamSchema, request.params);
		try {
			const body = parseInput(insertRowBodySchema, request.body);
			const result = await deps.mysql.insertRow(id, table, body.row);
			await deps.audit.record({
				action: 'mysql.insert',
				target: `${id}:${table}`,
				status: 'ok',
				detail: `${result.affectedRows} rows`
			});
			return ok({ affectedRows: result.affectedRows, insertId: result.insertId });
		} catch (error) {
			await deps.audit.record({
				action: 'mysql.insert',
				target: `${id}:${table}`,
				status: 'failed',
				detail: auditErrorDetail(error, 'MySQL insert failed')
			});
			throw error;
		}
	});

	app.patch('/api/mysql/:id/tables/:table/rows', async (request) => {
		requireRole(request, 'operator');
		const { id, table } = parseInput(tableParamSchema, request.params);
		try {
			const body = parseInput(updateRowBodySchema, request.body);
			const result = await deps.mysql.updateRow(id, table, body.primaryKey, body.patch);
			await deps.audit.record({
				action: 'mysql.update',
				target: `${id}:${table}`,
				status: 'ok',
				detail: `${result.affectedRows} rows`
			});
			return ok({ affectedRows: result.affectedRows });
		} catch (error) {
			await deps.audit.record({
				action: 'mysql.update',
				target: `${id}:${table}`,
				status: 'failed',
				detail: auditErrorDetail(error, 'MySQL update failed')
			});
			throw error;
		}
	});

	app.delete('/api/mysql/:id/tables/:table/rows', async (request) => {
		requireRole(request, 'operator');
		const { id, table } = parseInput(tableParamSchema, request.params);
		try {
			const body = parseInput(deleteRowBodySchema, request.body);
			requireConfirmation(body.confirmation, table, 'Type the table name to delete a row');
			const result = await deps.mysql.deleteRow(id, table, body.primaryKey);
			await deps.audit.record({
				action: 'mysql.delete',
				target: `${id}:${table}`,
				status: 'ok',
				detail: `${result.affectedRows} rows`
			});
			return ok({ affectedRows: result.affectedRows });
		} catch (error) {
			await deps.audit.record({
				action: 'mysql.delete',
				target: `${id}:${table}`,
				status: 'failed',
				detail: auditErrorDetail(error, 'MySQL delete failed')
			});
			throw error;
		}
	});

	app.post('/api/mysql/:id/query', async (request) => {
		const { id } = parseInput(tableParamSchema.pick({ id: true }), request.params);
		try {
			const body = parseInput(sqlQueryBodySchema, request.body);
			if (body.mode === 'allow-mutations') requireRole(request, 'operator');
			const result = await deps.mysql.query(id, body.sql, {
				mode: body.mode,
				maxRows: body.maxRows,
				timeoutMs: body.timeoutMs,
				mutationConfirmation: body.mutationConfirmation
			});
			await deps.audit.record({
				action: result.mutation ? 'mysql.query.mutation' : 'mysql.query.read',
				target: id,
				status: 'ok',
				detail: `${result.executionMs}ms / ${result.policy.mode} / ${result.limited ? 'limited' : 'full'}`
			});
			return ok(result);
		} catch (error) {
			await deps.audit.record({
				action: 'mysql.query',
				target: id,
				status: 'failed',
				detail: auditErrorDetail(error, 'MySQL query failed')
			});
			throw error;
		}
	});
}
