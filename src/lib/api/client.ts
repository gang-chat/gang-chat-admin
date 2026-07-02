import type {
	ApiEnvelope,
	AgentJob,
	AgentOpsRun,
	AgentOpsSession,
	AgentWorkerStatus,
	AuthLoginResult,
	AuthRole,
	AuthUser,
	ConnectionInput,
	ConnectionPreset,
	ConnectionType,
	ExpenseEntry,
	ExpenseInput,
	ExpenseSummary,
	MysqlColumn,
	MysqlQueryResult,
	MysqlSqlPolicy,
	MysqlTableSummary,
	S3ObjectList,
	S3ObjectMetadata,
	SshActiveSession
} from '$lib/shared/ops-types';

export class ApiClientError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		public readonly details?: unknown
	) {
		super(message);
		this.name = 'ApiClientError';
	}
}

export class ApiClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly actor = ''
	) {}

	async health() {
		return this.get<{ status: string; at: string; mode: string }>('/api/health', false);
	}

	async login(username: string, password: string) {
		return this.request<AuthLoginResult>(
			'/api/auth/login',
			{
				method: 'POST',
				body: JSON.stringify({ username, password })
			},
			false
		);
	}

	async me() {
		return this.get<{
			user: AuthUser;
			expiresAt: string;
			idleExpiresAt: string;
			authMethod: 'session';
		}>('/api/auth/me');
	}

	async logout() {
		return this.request<{ revoked: boolean }>('/api/auth/logout', { method: 'POST' });
	}

	async connections(type?: ConnectionType) {
		return this.get<ConnectionPreset[]>(`/api/connections${type ? `?type=${type}` : ''}`);
	}

	async createConnection(input: ConnectionInput) {
		return this.request<ConnectionPreset>('/api/connections', {
			method: 'POST',
			body: JSON.stringify(input)
		});
	}

	async updateConnection(id: string, input: ConnectionInput) {
		return this.request<ConnectionPreset>(`/api/connections/${id}`, {
			method: 'PUT',
			body: JSON.stringify(input)
		});
	}

	async testConnection(id: string) {
		return this.request<{ status: string }>(`/api/connections/${id}/test`, { method: 'POST' });
	}

	async deleteConnection(id: string, confirmation: string) {
		await this.raw(`/api/connections/${id}`, {
			method: 'DELETE',
			headers: { 'x-ops-confirmation': confirmation }
		});
	}

	async mysqlTables(id: string) {
		return this.get<MysqlTableSummary[]>(`/api/mysql/${id}/tables`);
	}

	async mysqlSchema(id: string, table: string) {
		return this.get<MysqlColumn[]>(`/api/mysql/${id}/tables/${encodeURIComponent(table)}/schema`);
	}

	async mysqlRows(id: string, table: string, limit = 100, offset = 0) {
		return this.get<Record<string, unknown>[]>(
			`/api/mysql/${id}/tables/${encodeURIComponent(table)}/rows?limit=${limit}&offset=${offset}`
		);
	}

	async mysqlInsert(id: string, table: string, row: Record<string, unknown>) {
		return this.request<{ affectedRows: number; insertId?: number }>(
			`/api/mysql/${id}/tables/${encodeURIComponent(table)}/rows`,
			{ method: 'POST', body: JSON.stringify({ row }) }
		);
	}

	async mysqlUpdate(
		id: string,
		table: string,
		primaryKey: Record<string, unknown>,
		patch: Record<string, unknown>
	) {
		return this.request<{ affectedRows: number }>(
			`/api/mysql/${id}/tables/${encodeURIComponent(table)}/rows`,
			{ method: 'PATCH', body: JSON.stringify({ primaryKey, patch }) }
		);
	}

	async mysqlDelete(
		id: string,
		table: string,
		primaryKey: Record<string, unknown>,
		confirmation: string
	) {
		return this.request<{ affectedRows: number }>(
			`/api/mysql/${id}/tables/${encodeURIComponent(table)}/rows`,
			{ method: 'DELETE', body: JSON.stringify({ primaryKey, confirmation }) }
		);
	}

	async mysqlQuery(id: string, sql: string, policy: MysqlSqlPolicy) {
		return this.request<MysqlQueryResult>(`/api/mysql/${id}/query`, {
			method: 'POST',
			body: JSON.stringify({ sql, ...policy })
		});
	}

	async s3Objects(
		id: string,
		bucket: string,
		options: { prefix?: string; continuationToken?: string; maxKeys?: number } = {}
	) {
		const params = new URLSearchParams();
		params.set('bucket', bucket);
		params.set('prefix', options.prefix ?? '');
		params.set('maxKeys', String(options.maxKeys ?? 500));
		if (options.continuationToken) params.set('continuationToken', options.continuationToken);
		return this.get<S3ObjectList>(`/api/s3/${id}/objects?${params.toString()}`);
	}

	async s3Upload(id: string, form: FormData) {
		return this.request<{ bucket: string; key: string }>(`/api/s3/${id}/objects`, {
			method: 'POST',
			body: form,
			json: false
		});
	}

	async s3Head(id: string, bucket: string, key: string) {
		return this.get<S3ObjectMetadata>(
			`/api/s3/${id}/objects/head?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`
		);
	}

	async s3Delete(id: string, bucket: string, key: string, confirmation: string) {
		return this.request<{ deleted: boolean }>(`/api/s3/${id}/objects`, {
			method: 'DELETE',
			body: JSON.stringify({ bucket, key, confirmation })
		});
	}

	async s3Download(id: string, bucket: string, key: string) {
		return this.raw(
			`/api/s3/${id}/objects/download?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`
		);
	}

	async sshTicket(id: string) {
		return this.request<{ ticket: string; expiresAt: string }>(`/api/ssh/${id}/ticket`, {
			method: 'POST'
		});
	}

	async sshSessions() {
		return this.get<SshActiveSession[]>('/api/ssh/sessions');
	}

	async closeSshSession(id: string, confirmation: string) {
		return this.request<{ closed: boolean }>(`/api/ssh/sessions/${id}`, {
			method: 'DELETE',
			headers: { 'x-ops-confirmation': confirmation }
		});
	}

	async expenses(month?: string) {
		return this.get<ExpenseEntry[]>(`/api/expenses${month ? `?month=${month}` : ''}`);
	}

	async expenseSummary(month: string) {
		return this.get<ExpenseSummary>(`/api/expenses/summary?month=${month}`);
	}

	async createExpense(input: ExpenseInput) {
		return this.request<ExpenseEntry>('/api/expenses', {
			method: 'POST',
			body: JSON.stringify(input)
		});
	}

	async updateExpense(id: string, input: ExpenseInput) {
		return this.request<ExpenseEntry>(`/api/expenses/${id}`, {
			method: 'PUT',
			body: JSON.stringify(input)
		});
	}

	async deleteExpense(id: string, confirmation: string) {
		await this.raw(`/api/expenses/${id}`, {
			method: 'DELETE',
			headers: { 'x-ops-confirmation': confirmation }
		});
	}

	async agentSuggest(goal: string, context: string) {
		return this.request<AgentJob>('/api/agent/suggest', {
			method: 'POST',
			body: JSON.stringify({ goal, context })
		});
	}

	async agentWorkers() {
		return this.get<AgentWorkerStatus[]>('/api/agent/workers');
	}

	async agentSessions(workerId: string) {
		return this.get<AgentOpsSession[]>(
			`/api/agent/workers/${encodeURIComponent(workerId)}/sessions`
		);
	}

	async createAgentSession(workerId: string, input: { name?: string }) {
		return this.request<AgentOpsSession>(
			`/api/agent/workers/${encodeURIComponent(workerId)}/sessions`,
			{
				method: 'POST',
				body: JSON.stringify(input)
			}
		);
	}

	async agentSessionRuns(workerId: string, sessionId: string) {
		return this.get<AgentOpsRun[]>(
			`/api/agent/workers/${encodeURIComponent(workerId)}/sessions/${encodeURIComponent(sessionId)}/runs`
		);
	}

	async deleteAgentSession(workerId: string, sessionId: string) {
		return this.request<{ deleted: boolean }>(
			`/api/agent/workers/${encodeURIComponent(workerId)}/sessions/${encodeURIComponent(sessionId)}`,
			{ method: 'DELETE' }
		);
	}

	async agentWorkerTerminalTicket(workerId: string) {
		return this.request<{ ticket: string; expiresAt: string }>(
			`/api/agent/workers/${encodeURIComponent(workerId)}/terminal/ticket`,
			{ method: 'POST' }
		);
	}

	async agentRun(input: { workerId: string; sessionId: string; goal: string }) {
		return this.request<AgentOpsRun>('/api/agent/run', {
			method: 'POST',
			body: JSON.stringify(input)
		});
	}

	async agentRunStatus(id: string) {
		return this.get<AgentOpsRun>(`/api/agent/runs/${id}`);
	}

	private async get<T>(path: string, auth = true) {
		return this.request<T>(path, { method: 'GET' }, auth);
	}

	private async request<T>(
		path: string,
		init: RequestInit & { json?: boolean } = {},
		auth = true
	): Promise<T> {
		const response = await this.raw(path, init, auth);
		const payload = (await response.json()) as ApiEnvelope<T>;
		return payload.data;
	}

	private async raw(path: string, init: RequestInit & { json?: boolean } = {}, auth = true) {
		const headers = new Headers(init.headers);
		if (auth) headers.set('Authorization', `Bearer ${this.token}`);
		if (auth && this.actor.trim()) headers.set('x-ops-actor', this.actor.trim());
		if (init.json !== false && init.body != null && !headers.has('content-type')) {
			headers.set('content-type', 'application/json');
		}
		const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
		if (!response.ok) {
			throw await toApiError(response);
		}
		return response;
	}
}

async function toApiError(response: Response) {
	const contentType = response.headers.get('content-type') ?? '';
	if (contentType.includes('application/json')) {
		const payload = (await response.json().catch(() => undefined)) as
			{ error?: { code?: string; message?: string; details?: unknown } } | undefined;
		const error = payload?.error;
		if (error?.message) {
			return new ApiClientError(
				response.status,
				error.code ?? `HTTP_${response.status}`,
				error.message,
				error.details
			);
		}
	}

	const text = await response.text().catch(() => '');
	return new ApiClientError(
		response.status,
		`HTTP_${response.status}`,
		text || response.statusText || `HTTP ${response.status}`
	);
}
