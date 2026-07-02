import { nanoid } from 'nanoid';
import type {
	AgentCommand,
	AgentCommandResult,
	AgentJob,
	AgentJobStatus,
	AgentWorkerStatus
} from '../../../../src/lib/shared/ops-types';
import { HttpError } from '../../core/http';
import { JsonStore, storePath } from '../../store/json-store';

type AgentState = {
	jobs: AgentJob[];
	workers?: AgentWorkerStatus[];
};

export class AgentService {
	private readonly store: JsonStore<AgentState>;

	constructor(dataDir: string) {
		this.store = new JsonStore(storePath(dataDir, 'agent'), { jobs: [] });
	}

	async list(status?: AgentJobStatus) {
		const state = await this.store.read();
		return state.jobs.filter((job) => !status || job.status === status);
	}

	async listWorkers() {
		const state = await this.store.read();
		return [...(state.workers ?? [])].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
	}

	async listWorkerQueue(limit: number) {
		const state = await this.store.read();
		return state.jobs
			.filter((job) => job.status === 'approved')
			.filter((job) => !job.executionStatus || job.executionStatus === 'queued')
			.slice(0, limit);
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
		let updated: AgentWorkerStatus | undefined;
		const now = new Date().toISOString();
		await this.store.update((state) => {
			state.workers ??= [];
			const existing = state.workers.find((worker) => worker.id === input.workerId);
			const next: AgentWorkerStatus = {
				id: input.workerId,
				lastSeenAt: now,
				apiBase: input.apiBase,
				hostname: input.hostname,
				version: input.version,
				execute: input.execute,
				allowedCommands: input.allowedCommands,
				currentJobId: input.currentJobId
			};
			if (existing) Object.assign(existing, next);
			else state.workers.unshift(next);
			state.workers = state.workers
				.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
				.slice(0, 100);
			updated = existing ?? next;
		});
		return updated!;
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
}
