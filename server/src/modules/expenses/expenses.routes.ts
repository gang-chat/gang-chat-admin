import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../core/access-control';
import { ok, requireConfirmation } from '../../core/http';
import { idParamSchema, parseInput } from '../../core/validation';
import type { AuditRepository } from '../audit/audit.repository';
import { auditErrorDetail } from '../audit/audit-error';
import {
	expenseInputSchema,
	expenseQuerySchema,
	expenseSummaryQuerySchema
} from './expenses.schema';
import type { ExpensesRepository } from './expenses.repository';

export async function registerExpenseRoutes(
	app: FastifyInstance,
	deps: { expenses: ExpensesRepository; audit: AuditRepository }
) {
	app.get('/api/expenses', async (request) => {
		const query = parseInput(expenseQuerySchema, request.query);
		return ok(await deps.expenses.list(query.month));
	});

	app.get('/api/expenses/summary', async (request) => {
		const query = parseInput(expenseSummaryQuerySchema, request.query);
		return ok(await deps.expenses.summary(query.month));
	});

	app.post('/api/expenses', async (request) => {
		requireRole(request, 'operator');
		try {
			const entry = await deps.expenses.create(parseInput(expenseInputSchema, request.body));
			await deps.audit.record({
				action: 'expense.create',
				target: `${entry.month}:${entry.vendor}`,
				status: 'ok'
			});
			return ok(entry);
		} catch (error) {
			await deps.audit.record({
				action: 'expense.create',
				target: 'new',
				status: 'failed',
				detail: auditErrorDetail(error, 'Expense create failed')
			});
			throw error;
		}
	});

	app.put('/api/expenses/:id', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		try {
			const entry = await deps.expenses.update(id, parseInput(expenseInputSchema, request.body));
			await deps.audit.record({
				action: 'expense.update',
				target: id,
				status: 'ok'
			});
			return ok(entry);
		} catch (error) {
			await deps.audit.record({
				action: 'expense.update',
				target: id,
				status: 'failed',
				detail: auditErrorDetail(error, 'Expense update failed')
			});
			throw error;
		}
	});

	app.delete('/api/expenses/:id', async (request, reply) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		try {
			requireConfirmation(
				request.headers['x-ops-confirmation']?.toString(),
				id,
				'Confirm the expense id to delete this ledger entry'
			);
			await deps.expenses.remove(id);
			await deps.audit.record({
				action: 'expense.delete',
				target: id,
				status: 'ok'
			});
			reply.status(204).send();
		} catch (error) {
			await deps.audit.record({
				action: 'expense.delete',
				target: id,
				status: 'failed',
				detail: auditErrorDetail(error, 'Expense delete failed')
			});
			throw error;
		}
	});
}
