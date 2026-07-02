import type { AgentCommandResult, AgentJob } from '../../../src/lib/shared/ops-types';

export class AgentWorkerClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string
	) {}

	async listJobs(limit = 1) {
		return this.request<AgentJob[]>(`/api/agent/worker/jobs?limit=${limit}`);
	}

	async heartbeat(body: {
		workerId: string;
		apiBase?: string;
		hostname?: string;
		version?: string;
		execute: boolean;
		allowedCommands: string[];
		currentJobId?: string;
	}) {
		return this.request<{ id: string; lastSeenAt: string }>('/api/agent/worker/heartbeat', {
			method: 'POST',
			body: JSON.stringify(body)
		});
	}

	async startJob(id: string, workerId: string) {
		return this.request<AgentJob>(`/api/agent/worker/jobs/${encodeURIComponent(id)}/start`, {
			method: 'POST',
			body: JSON.stringify({ workerId })
		});
	}

	async completeJob(
		id: string,
		body: { workerId: string; result?: string; commandResults?: AgentCommandResult[] }
	) {
		return this.request<AgentJob>(`/api/agent/worker/jobs/${encodeURIComponent(id)}/complete`, {
			method: 'POST',
			body: JSON.stringify(body)
		});
	}

	async failJob(
		id: string,
		body: { workerId: string; error: string; commandResults?: AgentCommandResult[] }
	) {
		return this.request<AgentJob>(`/api/agent/worker/jobs/${encodeURIComponent(id)}/fail`, {
			method: 'POST',
			body: JSON.stringify(body)
		});
	}

	private async request<T>(path: string, init: RequestInit = {}) {
		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.token}`,
				'content-type': 'application/json',
				...init.headers
			}
		});
		const body = (await response.json().catch(() => ({}))) as {
			data?: T;
			error?: { code?: string; message?: string };
		};
		if (!response.ok) {
			throw new Error(body.error?.message ?? `Agent worker request failed: ${response.status}`);
		}
		return body.data as T;
	}
}
