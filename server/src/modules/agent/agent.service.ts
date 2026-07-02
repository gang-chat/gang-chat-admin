import { nanoid } from 'nanoid';
import type {
	AgentCommand,
	AgentCommandResult,
	AgentJob,
	AgentJobStatus,
	AgentOpsRun,
	AgentOpsSession,
	AgentWorkerTerminalStatus,
	AgentWorkerStatus
} from '../../../../src/lib/shared/ops-types';
import type { AiAdminWorkerPrompt, AiAdminWorkerRunEvent } from '../../ai-admin-worker/protocol';
import { HttpError } from '../../core/http';
import { JsonStore, storePath } from '../../store/json-store';

export const AI_ADMIN_CONTEXT_WINDOW_TOKENS = 256_000;
export const AI_ADMIN_COMPACT_THRESHOLD = 0.9;

type OpsPromptDispatcher = (workerId: string, prompt: AiAdminWorkerPrompt) => void | Promise<void>;

type AgentState = {
	jobs: AgentJob[];
	opsRuns?: AgentOpsRun[];
	opsSessions?: AgentOpsSession[];
	workers?: AgentWorkerStatus[];
};

export class AgentService {
	private readonly store: JsonStore<AgentState>;
	private opsPromptDispatcher?: OpsPromptDispatcher;

	constructor(dataDir: string) {
		this.store = new JsonStore(storePath(dataDir, 'agent'), { jobs: [] });
	}

	setOpsPromptDispatcher(dispatcher: OpsPromptDispatcher) {
		this.opsPromptDispatcher = dispatcher;
	}

	async list(status?: AgentJobStatus) {
		const state = await this.store.read();
		return state.jobs.filter((job) => !status || job.status === status);
	}

	async listWorkers() {
		const state = await this.store.read();
		return [...(state.workers ?? [])].sort((a, b) => {
			const connectedDelta = Number(b.connected === true) - Number(a.connected === true);
			if (connectedDelta !== 0) return connectedDelta;
			return b.lastSeenAt.localeCompare(a.lastSeenAt);
		});
	}

	async listWorkerSessions(workerId: string) {
		const state = await this.store.read();
		return [...(state.opsSessions ?? [])]
			.filter((session) => session.workerId === workerId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async createWorkerSession(workerId: string, name?: string): Promise<AgentOpsSession> {
		const now = new Date().toISOString();
		let created: AgentOpsSession | undefined;
		await this.store.update((state) => {
			const worker = state.workers?.find((item) => item.id === workerId);
			if (!worker) throw new HttpError(404, 'AGENT_WORKER_NOT_FOUND', 'Agent worker not found');
			state.opsSessions ??= [];
			const customName = name?.trim();
			created = {
				id: nanoid(),
				workerId,
				name: customName || 'New session',
				titleSource: customName ? 'custom' : 'auto',
				createdAt: now,
				updatedAt: now
			};
			state.opsSessions.unshift(created);
			state.opsSessions = state.opsSessions.slice(0, 500);
		});
		return created!;
	}

	async listSessionRuns(workerId: string, sessionId: string) {
		const state = await this.store.read();
		const session = state.opsSessions?.find(
			(item) => item.id === sessionId && item.workerId === workerId
		);
		if (!session) throw new HttpError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent session not found');
		return [...(state.opsRuns ?? [])]
			.filter((run) => run.workerId === workerId && run.sessionId === sessionId)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	async deleteWorkerSession(workerId: string, sessionId: string) {
		await this.store.update((state) => {
			const sessions = state.opsSessions ?? [];
			const index = sessions.findIndex(
				(session) => session.id === sessionId && session.workerId === workerId
			);
			if (index === -1) {
				throw new HttpError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent session not found');
			}
			const hasActiveRun = (state.opsRuns ?? []).some(
				(run) =>
					run.workerId === workerId &&
					run.sessionId === sessionId &&
					(run.status === 'queued' || run.status === 'running')
			);
			if (hasActiveRun) {
				throw new HttpError(
					409,
					'AGENT_SESSION_ACTIVE',
					'Agent session has an active run and cannot be deleted'
				);
			}
			sessions.splice(index, 1);
			state.opsSessions = sessions;
			state.opsRuns = (state.opsRuns ?? []).filter(
				(run) => run.workerId !== workerId || run.sessionId !== sessionId
			);
		});
		return { deleted: true };
	}

	async listWorkerQueue(limit: number) {
		const state = await this.store.read();
		return state.jobs
			.filter((job) => job.status === 'approved')
			.filter((job) => !job.executionStatus || job.executionStatus === 'queued')
			.slice(0, limit);
	}

	async runOpsPrompt(workerId: string, sessionId: string, goal: string): Promise<AgentOpsRun> {
		const normalizedGoal = goal.trim();
		const now = new Date().toISOString();
		const run: AgentOpsRun = {
			id: nanoid(),
			workerId,
			sessionId,
			createdAt: now,
			updatedAt: now,
			goal: normalizedGoal,
			status: 'queued',
			events: [
				{
					type: 'status',
					message: 'Queued ops prompt for AI admin worker.',
					at: now
				}
			]
		};

		await this.store.update((state) => {
			const session = state.opsSessions?.find(
				(item) => item.id === sessionId && item.workerId === workerId
			);
			if (!session) {
				throw new HttpError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent session not found');
			}
			if (!session.lastRunId && session.titleSource !== 'custom') {
				session.name = summarizeSessionTitle(normalizedGoal);
				session.titleSource = 'auto';
			}
			session.updatedAt = now;
			session.lastRunId = run.id;
			state.opsRuns ??= [];
			state.opsRuns.unshift(run);
			state.opsRuns = state.opsRuns.slice(0, 100);
		});

		try {
			if (!this.opsPromptDispatcher) {
				throw new HttpError(
					503,
					'AI_ADMIN_WORKER_NOT_CONFIGURED',
					'AI admin worker bridge is not configured'
				);
			}
			await this.opsPromptDispatcher(workerId, {
				runId: run.id,
				sessionId,
				goal: normalizedGoal
			});
			return run;
		} catch (error) {
			return this.failOpsRun(run.id, errorMessage(error));
		}
	}

	async getOpsRun(id: string) {
		const state = await this.store.read();
		const run = state.opsRuns?.find((item) => item.id === id);
		if (!run) throw new HttpError(404, 'AGENT_RUN_NOT_FOUND', 'Agent run not found');
		return run;
	}

	async applyOpsWorkerEvent(event: AiAdminWorkerRunEvent) {
		let updated: AgentOpsRun | undefined;
		const now = new Date().toISOString();
		await this.store.update((state) => {
			const run = state.opsRuns?.find((item) => item.id === event.runId);
			if (!run) throw new HttpError(404, 'AGENT_RUN_NOT_FOUND', 'Agent run not found');

			run.updatedAt = now;
			if (event.type === 'run_started') {
				run.status = 'running';
				run.events.push({
					type: 'status',
					message: 'AI admin worker started this run.',
					at: now
				});
			}
			if (event.type === 'text_delta') {
				run.status = 'running';
				run.result = `${run.result ?? ''}${event.text}`;
				run.events.push({
					type: 'text',
					message: event.text,
					at: now
				});
			}
			if (event.type === 'tool_call' || event.type === 'tool_result') {
				run.events.push({
					type: 'tool',
					message: event.message,
					at: now
				});
			}
			if (event.type === 'context_compacted') {
				run.events.push({
					type: 'compact',
					message: event.message,
					at: now
				});
			}
			if (event.type === 'run_completed') {
				run.status = 'completed';
				if (event.result !== undefined) run.result = event.result;
				delete run.error;
				run.events.push({
					type: 'done',
					message: 'Run completed.',
					at: now
				});
			}
			if (event.type === 'run_failed') {
				run.status = 'failed';
				run.error = event.error;
				run.events.push({
					type: 'error',
					message: event.error,
					at: now
				});
			}
			run.events = run.events.slice(-200);
			const session = state.opsSessions?.find(
				(item) => item.id === run.sessionId && item.workerId === run.workerId
			);
			if (session) {
				session.updatedAt = now;
				session.lastRunId = run.id;
			}
			updated = run;
		});
		return updated!;
	}

	async failActiveOpsRuns(message: string, workerId?: string) {
		const now = new Date().toISOString();
		await this.store.update((state) => {
			for (const run of state.opsRuns ?? []) {
				if (run.status !== 'queued' && run.status !== 'running') continue;
				if (workerId && run.workerId !== workerId) continue;
				run.status = 'failed';
				run.updatedAt = now;
				run.error = message;
				run.events.push({
					type: 'error',
					message,
					at: now
				});
				run.events = run.events.slice(-200);
			}
		});
	}

	async connectAiAdminWorker(input: {
		workerId: string;
		apiBase?: string;
		hostname?: string;
		version?: string;
		execute?: boolean;
		allowedCommands?: string[];
		terminal?: AgentWorkerTerminalStatus;
	}) {
		return this.upsertWorker({
			id: input.workerId,
			apiBase: input.apiBase,
			hostname: input.hostname,
			version: input.version,
			execute: input.execute ?? false,
			allowedCommands: input.allowedCommands ?? [],
			transport: 'websocket',
			connected: true,
			terminal: input.terminal
		});
	}

	async resetAiAdminWorkerConnections() {
		const now = new Date().toISOString();
		await this.store.update((state) => {
			for (const worker of state.workers ?? []) {
				if (worker.transport !== 'websocket') continue;
				worker.connected = false;
				worker.lastSeenAt = now;
				delete worker.currentJobId;
			}
		});
	}

	async disconnectAiAdminWorker(workerId: string) {
		const now = new Date().toISOString();
		await this.store.update((state) => {
			const worker = state.workers?.find((item) => item.id === workerId);
			if (!worker) return;
			worker.lastSeenAt = now;
			worker.connected = false;
			if (worker.transport !== 'websocket') worker.transport = 'websocket';
			delete worker.currentJobId;
		});
	}

	async suggest(goal: string, context?: string): Promise<AgentJob> {
		const normalizedGoal = goal.trim();
		const now = new Date().toISOString();
		const notes = [
			'Pi should run as a separate constrained worker, not inside the main ops API process.',
			'Command execution is intentionally approval-gated at the API boundary.',
			'This endpoint returns an operator-readable plan until the Pi worker adapter is connected.'
		];
		if (context?.trim()) notes.push(`Context captured: ${context.trim().slice(0, 240)}`);

		const job: AgentJob = {
			id: nanoid(),
			createdAt: now,
			updatedAt: now,
			status: 'suggested',
			goal: normalizedGoal,
			summary: normalizedGoal
				? `Review the target host or service, gather read-only state first, then propose the smallest command set for: ${normalizedGoal}`
				: 'Describe the operation goal before asking the agent for commands.',
			risk: 'medium',
			commands: [
				{
					label: 'Read host identity',
					command: 'hostnamectl',
					requiresApproval: false
				},
				{
					label: 'Read uptime and load',
					command: 'uptime',
					requiresApproval: false
				},
				{
					label: 'Check failed services',
					command: 'systemctl --failed --no-pager',
					requiresApproval: false
				},
				{
					label: 'Inspect disk pressure',
					command: 'df -h',
					requiresApproval: false
				}
			],
			notes
		};
		await this.store.update((state) => {
			state.jobs.unshift(job);
			state.jobs = state.jobs.slice(0, 500);
		});
		return job;
	}

	private async failOpsRun(id: string, message: string) {
		let updated: AgentOpsRun | undefined;
		const now = new Date().toISOString();
		await this.store.update((state) => {
			const run = state.opsRuns?.find((item) => item.id === id);
			if (!run) throw new HttpError(404, 'AGENT_RUN_NOT_FOUND', 'Agent run not found');
			run.status = 'failed';
			run.updatedAt = now;
			run.error = message;
			run.events.push({
				type: 'error',
				message,
				at: now
			});
			run.events = run.events.slice(-200);
			updated = run;
		});
		return updated!;
	}

	async approve(id: string, operatorNote?: string, commands?: AgentCommand[]) {
		return this.transition(id, 'approved', operatorNote, commands);
	}

	async reject(id: string, operatorNote?: string) {
		return this.transition(id, 'rejected', operatorNote);
	}

	async heartbeat(input: {
		workerId: string;
		apiBase?: string;
		hostname?: string;
		version?: string;
		execute: boolean;
		allowedCommands: string[];
		currentJobId?: string;
	}) {
		return this.upsertWorker({
			id: input.workerId,
			apiBase: input.apiBase,
			hostname: input.hostname,
			version: input.version,
			execute: input.execute,
			allowedCommands: input.allowedCommands,
			currentJobId: input.currentJobId,
			transport: 'poll',
			connected: true
		});
	}

	private async transition(
		id: string,
		status: Exclude<AgentJobStatus, 'suggested'>,
		operatorNote?: string,
		commands?: AgentCommand[]
	) {
		let updated: AgentJob | undefined;
		const now = new Date().toISOString();
		await this.store.update((state) => {
			const job = state.jobs.find((item) => item.id === id);
			if (!job) throw new HttpError(404, 'AGENT_JOB_NOT_FOUND', 'Agent job not found');
			if (job.status !== 'suggested') {
				throw new HttpError(409, 'AGENT_JOB_ALREADY_DECIDED', 'Agent job already decided');
			}
			if (status === 'approved' && commands) {
				job.commands = commands.map((command) => ({
					label: command.label.trim(),
					command: command.command.trim(),
					requiresApproval: command.requiresApproval
				}));
			}
			job.status = status;
			job.updatedAt = now;
			job.operatorNote = operatorNote?.trim() || undefined;
			if (status === 'approved') job.approvedAt = now;
			if (status === 'approved') job.executionStatus = 'queued';
			if (status === 'rejected') job.rejectedAt = now;
			updated = job;
		});
		return updated!;
	}

	async start(id: string, workerId: string) {
		let updated: AgentJob | undefined;
		const now = new Date().toISOString();
		await this.store.update((state) => {
			const job = this.findRunnableJob(state.jobs, id);
			if (job.executionStatus && job.executionStatus !== 'queued') {
				throw new HttpError(409, 'AGENT_JOB_NOT_QUEUED', 'Agent job is not queued for execution');
			}
			job.executionStatus = 'running';
			job.workerId = workerId;
			job.claimedAt = now;
			job.startedAt = now;
			job.updatedAt = now;
			delete job.completedAt;
			delete job.failedAt;
			delete job.result;
			delete job.error;
			delete job.commandResults;
			updated = job;
		});
		return updated!;
	}

	async complete(
		id: string,
		workerId: string,
		result?: string,
		commandResults?: AgentCommandResult[]
	) {
		let updated: AgentJob | undefined;
		const now = new Date().toISOString();
		await this.store.update((state) => {
			const job = this.findRunningJob(state.jobs, id, workerId);
			job.executionStatus = 'completed';
			job.completedAt = now;
			job.updatedAt = now;
			job.result = result?.trim() || undefined;
			job.commandResults = commandResults?.length ? commandResults : undefined;
			delete job.error;
			delete job.failedAt;
			updated = job;
		});
		return updated!;
	}

	async fail(id: string, workerId: string, error: string, commandResults?: AgentCommandResult[]) {
		let updated: AgentJob | undefined;
		const now = new Date().toISOString();
		await this.store.update((state) => {
			const job = this.findRunningJob(state.jobs, id, workerId);
			job.executionStatus = 'failed';
			job.failedAt = now;
			job.updatedAt = now;
			job.error = error.trim();
			job.commandResults = commandResults?.length ? commandResults : undefined;
			delete job.completedAt;
			delete job.result;
			updated = job;
		});
		return updated!;
	}

	private findRunnableJob(jobs: AgentJob[], id: string) {
		const job = jobs.find((item) => item.id === id);
		if (!job) throw new HttpError(404, 'AGENT_JOB_NOT_FOUND', 'Agent job not found');
		if (job.status !== 'approved') {
			throw new HttpError(409, 'AGENT_JOB_NOT_APPROVED', 'Agent job is not approved for execution');
		}
		return job;
	}

	private findRunningJob(jobs: AgentJob[], id: string, workerId: string) {
		const job = this.findRunnableJob(jobs, id);
		if (job.executionStatus !== 'running') {
			throw new HttpError(409, 'AGENT_JOB_NOT_RUNNING', 'Agent job is not running');
		}
		if (job.workerId !== workerId) {
			throw new HttpError(
				409,
				'AGENT_JOB_WORKER_MISMATCH',
				'Agent job is claimed by another worker'
			);
		}
		return job;
	}

	private async upsertWorker(
		input: Omit<AgentWorkerStatus, 'lastSeenAt'> & { lastSeenAt?: string }
	) {
		let updated: AgentWorkerStatus | undefined;
		const now = input.lastSeenAt ?? new Date().toISOString();
		await this.store.update((state) => {
			state.workers ??= [];
			const existing = state.workers.find((worker) => worker.id === input.id);
			const next: AgentWorkerStatus = {
				...input,
				lastSeenAt: now
			};
			if (existing) {
				Object.assign(existing, next);
				updated = existing;
			} else {
				state.workers.unshift(next);
				updated = next;
			}
			state.workers = state.workers
				.sort((a, b) => {
					const connectedDelta = Number(b.connected === true) - Number(a.connected === true);
					if (connectedDelta !== 0) return connectedDelta;
					return b.lastSeenAt.localeCompare(a.lastSeenAt);
				})
				.slice(0, 100);
		});
		return updated!;
	}
}

function errorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return typeof error === 'string' ? error : 'AI admin worker request failed';
}

function summarizeSessionTitle(goal: string) {
	const normalized = goal
		.replace(/\s+/g, ' ')
		.replace(/^[#*>\s-]+/, '')
		.trim();
	if (!normalized) return 'New session';
	const sentence = normalized.split(/[。！？.!?]/)[0]?.trim() || normalized;
	return sentence.length > 36 ? `${sentence.slice(0, 36)}...` : sentence;
}
