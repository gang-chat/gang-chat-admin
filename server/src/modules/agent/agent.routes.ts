import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config/config';
import { requireRole } from '../../core/access-control';
import { ok, requireAgentWorkerAuth } from '../../core/http';
import { idParamSchema, parseInput } from '../../core/validation';
import type { AuditRepository } from '../audit/audit.repository';
import {
	agentDecisionBodySchema,
	agentJobsQuerySchema,
	agentOpsRunBodySchema,
	agentOpsSessionBodySchema,
	agentSessionParamSchema,
	agentSuggestBodySchema,
	agentWorkerCompleteBodySchema,
	agentWorkerFailBodySchema,
	agentWorkerHeartbeatBodySchema,
	agentWorkerJobsQuerySchema,
	agentWorkerParamSchema,
	agentWorkerStartBodySchema
} from './agent.schema';
import type { AgentService } from './agent.service';
import type { AiAdminWorkerHub } from './ai-admin-worker-hub';

export async function registerAgentRoutes(
	app: FastifyInstance,
	deps: {
		env: ServerConfig;
		agent: AgentService;
		audit: AuditRepository;
		aiAdminWorkerHub: AiAdminWorkerHub;
	}
) {
	app.get('/api/agent/jobs', async (request) => {
		const query = parseInput(agentJobsQuerySchema, request.query);
		return ok(await deps.agent.list(query.status));
	});

	app.get('/api/agent/workers', async (request) => {
		requireRole(request, 'operator');
		return ok(await deps.agent.listWorkers());
	});

	app.get('/api/agent/workers/:workerId/sessions', async (request) => {
		requireRole(request, 'operator');
		const { workerId } = parseInput(agentWorkerParamSchema, request.params);
		return ok(await deps.agent.listWorkerSessions(workerId));
	});

	app.post('/api/agent/workers/:workerId/sessions', async (request) => {
		requireRole(request, 'operator');
		const { workerId } = parseInput(agentWorkerParamSchema, request.params);
		const body = parseInput(agentOpsSessionBodySchema, request.body);
		const session = await deps.agent.createWorkerSession(workerId, body.name);
		await deps.audit.record({
			action: 'agent.ops.session.create',
			target: session.id,
			status: 'ok',
			detail: `${session.workerId}: ${session.name}`
		});
		return ok(session);
	});

	app.get('/api/agent/workers/:workerId/sessions/:sessionId/runs', async (request) => {
		requireRole(request, 'operator');
		const { workerId, sessionId } = parseInput(agentSessionParamSchema, request.params);
		return ok(await deps.agent.listSessionRuns(workerId, sessionId));
	});

	app.delete('/api/agent/workers/:workerId/sessions/:sessionId', async (request) => {
		requireRole(request, 'operator');
		const { workerId, sessionId } = parseInput(agentSessionParamSchema, request.params);
		const result = await deps.agent.deleteWorkerSession(workerId, sessionId);
		await deps.audit.record({
			action: 'agent.ops.session.delete',
			target: sessionId,
			status: 'ok',
			detail: workerId
		});
		return ok(result);
	});

	app.post('/api/agent/workers/:workerId/terminal/ticket', async (request) => {
		requireRole(request, 'operator');
		const { workerId } = parseInput(agentWorkerParamSchema, request.params);
		const ticket = deps.aiAdminWorkerHub.createTerminalTicket(workerId);
		await deps.audit.record({
			action: 'agent.worker.terminal.ticket',
			target: workerId,
			status: 'ok',
			detail: ticket.expiresAt
		});
		return ok(ticket);
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

	app.post('/api/agent/run', async (request) => {
		requireRole(request, 'operator');
		const body = parseInput(agentOpsRunBodySchema, request.body);
		const run = await deps.agent.runOpsPrompt(body.workerId, body.sessionId, body.goal);
		await deps.audit.record({
			action: 'agent.ops.run',
			target: run.id,
			status: run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'failed' : 'pending',
			detail: run.goal
		});
		return ok(run);
	});

	app.get('/api/agent/runs/:id', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		return ok(await deps.agent.getOpsRun(id));
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

	app.post('/api/agent/worker/heartbeat', async (request) => {
		requireAgentWorkerAuth(deps.env, request);
		const body = parseInput(agentWorkerHeartbeatBodySchema, request.body);
		return ok(await deps.agent.heartbeat(body));
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
