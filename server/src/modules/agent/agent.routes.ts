import type { FastifyInstance } from 'fastify';
import type { ServerEnv } from '../../config/env';
import { requireRole } from '../../core/access-control';
import { ok, requireAgentWorkerAuth } from '../../core/http';
import { idParamSchema, parseInput } from '../../core/validation';
import type { AuditRepository } from '../audit/audit.repository';
import {
	agentDecisionBodySchema,
	agentJobsQuerySchema,
	agentSuggestBodySchema,
	agentWorkerCompleteBodySchema,
	agentWorkerFailBodySchema,
	agentWorkerJobsQuerySchema,
	agentWorkerStartBodySchema
} from './agent.schema';
import type { AgentService } from './agent.service';

export async function registerAgentRoutes(
	app: FastifyInstance,
	deps: { env: ServerEnv; agent: AgentService; audit: AuditRepository }
) {
	app.get('/api/agent/jobs', async (request) => {
		const query = parseInput(agentJobsQuerySchema, request.query);
		return ok(await deps.agent.list(query.status));
	});

	app.post('/api/agent/suggest', async (request) => {
		requireRole(request, 'operator');
		const body = parseInput(agentSuggestBodySchema, request.body);
		const job = await deps.agent.suggest(body.goal, body.context);
		await deps.audit.record({
			action: 'agent.suggest',
			target: job.id,
			status: 'pending',
			detail: job.goal
		});
		return ok(job);
	});

	app.post('/api/agent/jobs/:id/approve', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		const body = parseInput(agentDecisionBodySchema, request.body);
		const job = await deps.agent.approve(id, body.operatorNote, body.commands);
		await deps.audit.record({
			action: 'agent.job.approve',
			target: id,
			status: 'ok',
			detail: body.operatorNote || `${job.goal}; commands=${job.commands.length}`
		});
		return ok(job);
	});

	app.post('/api/agent/jobs/:id/reject', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		const body = parseInput(agentDecisionBodySchema, request.body);
		const job = await deps.agent.reject(id, body.operatorNote);
		await deps.audit.record({
			action: 'agent.job.reject',
			target: id,
			status: 'ok',
			detail: body.operatorNote || job.goal
		});
		return ok(job);
	});

	app.get('/api/agent/worker/jobs', async (request) => {
		requireAgentWorkerAuth(deps.env, request);
		const query = parseInput(agentWorkerJobsQuerySchema, request.query);
		return ok(await deps.agent.listWorkerQueue(query.limit));
	});

	app.post('/api/agent/worker/jobs/:id/start', async (request) => {
		requireAgentWorkerAuth(deps.env, request);
		const { id } = parseInput(idParamSchema, request.params);
		const body = parseInput(agentWorkerStartBodySchema, request.body);
		const job = await deps.agent.start(id, body.workerId);
		await deps.audit.record({
			actor: body.workerId,
			action: 'agent.worker.start',
			target: id,
			status: 'ok',
			detail: job.goal
		});
		return ok(job);
	});

	app.post('/api/agent/worker/jobs/:id/complete', async (request) => {
		requireAgentWorkerAuth(deps.env, request);
		const { id } = parseInput(idParamSchema, request.params);
		const body = parseInput(agentWorkerCompleteBodySchema, request.body);
		const job = await deps.agent.complete(id, body.workerId, body.result, body.commandResults);
		await deps.audit.record({
			actor: body.workerId,
			action: 'agent.worker.complete',
			target: id,
			status: 'ok',
			detail: body.result || job.goal
		});
		return ok(job);
	});

	app.post('/api/agent/worker/jobs/:id/fail', async (request) => {
		requireAgentWorkerAuth(deps.env, request);
		const { id } = parseInput(idParamSchema, request.params);
		const body = parseInput(agentWorkerFailBodySchema, request.body);
		const job = await deps.agent.fail(id, body.workerId, body.error, body.commandResults);
		await deps.audit.record({
			actor: body.workerId,
			action: 'agent.worker.fail',
			target: id,
			status: 'failed',
			detail: body.error || job.goal
		});
		return ok(job);
	});
}
