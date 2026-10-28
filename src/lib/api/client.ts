import type {
	AdminLoginResult,
	AdminOverview,
	AdminSession,
	ApiEnvelope,
	AppRelease,
	AppReleaseInput,
	DbColumn,
	DbTableSummary,
	GangAccountCreateInput,
	GangAccountDetail,
	GangAccountList,
	GangAccountUpdateInput,
	GangRoomRole,
	GangRoomSummary,
	S3ObjectList,
	S3ObjectMetadata,
	S3ReleaseSyncResult,
	S3ReleaseVersion
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

/** The Go server's API root, as the browser reaches it through nginx. */
export const defaultApiBase = import.meta.env.VITE_API_BASE || '/gang-chat/api/v1';

export class ApiClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string
	) {}

	async status() {
		return this.get<{ enabled: boolean }>('/admin/status', false);
	}

	async login(username: string, password: string) {
		return this.request<AdminLoginResult>(
			'/admin/login',
			{
				method: 'POST',
				body: JSON.stringify({ username, password })
			},
			false
		);
	}

	async me() {
		return this.get<AdminSession>('/admin/me');
	}

	async logout() {
		return this.request<{ revoked: boolean }>('/admin/logout', { method: 'POST' });
	}

	async overview() {
		return this.get<AdminOverview>('/admin/overview');
	}

	async dbTables() {
		return this.get<DbTableSummary[]>('/admin/db/tables');
	}

	async dbSchema(table: string) {
		return this.get<DbColumn[]>(`/admin/db/tables/${encodeURIComponent(table)}/schema`);
	}

	async dbRows(table: string, limit = 100, offset = 0) {
		return this.get<Record<string, unknown>[]>(
			`/admin/db/tables/${encodeURIComponent(table)}/rows?limit=${limit}&offset=${offset}`
		);
	}

	async s3Objects(options: { prefix?: string; continuationToken?: string; maxKeys?: number } = {}) {
		const params = new URLSearchParams();
		params.set('prefix', options.prefix ?? '');
		params.set('maxKeys', String(options.maxKeys ?? 500));
		if (options.continuationToken) params.set('continuationToken', options.continuationToken);
		return this.get<S3ObjectList>(`/admin/storage/objects?${params.toString()}`);
	}

	async s3Upload(form: FormData) {
		return this.request<{ bucket: string; key: string }>('/admin/storage/objects', {
			method: 'POST',
			body: form,
			json: false
		});
	}

	async s3Head(key: string) {
		return this.get<S3ObjectMetadata>(`/admin/storage/objects/head?key=${encodeURIComponent(key)}`);
	}

	async s3Delete(key: string, confirmation: string) {
		return this.request<{ deleted: boolean }>('/admin/storage/objects', {
			method: 'DELETE',
			body: JSON.stringify({ key, confirmation })
		});
	}

	async s3Download(key: string) {
		return this.raw(`/admin/storage/objects/download?key=${encodeURIComponent(key)}`);
	}

	async s3ReleaseVersions() {
		return this.get<S3ReleaseVersion[]>('/admin/release-sync/releases');
	}

	async s3SyncRelease(tagName: string) {
		return this.request<S3ReleaseSyncResult>('/admin/release-sync', {
			method: 'POST',
			body: JSON.stringify({ tagName })
		});
	}

	async releases() {
		return this.get<AppRelease[]>('/admin/releases');
	}

	async createRelease(input: AppReleaseInput & { version: string }) {
		return this.request<AppRelease>('/admin/releases', {
			method: 'POST',
			body: JSON.stringify(input)
		});
	}

	async updateRelease(version: string, patch: AppReleaseInput) {
		return this.request<AppRelease>(`/admin/releases/${encodeURIComponent(version)}`, {
			method: 'PATCH',
			body: JSON.stringify(patch)
		});
	}

	async deleteRelease(version: string, confirmation: string) {
		return this.request<{ deleted: boolean }>(`/admin/releases/${encodeURIComponent(version)}`, {
			method: 'DELETE',
			headers: { 'x-ops-confirmation': confirmation }
		});
	}

	async accounts(query: { q?: string; status?: string; limit?: number; offset?: number } = {}) {
		const params = new URLSearchParams();
		if (query.q) params.set('q', query.q);
		if (query.status) params.set('status', query.status);
		params.set('limit', String(query.limit ?? 50));
		params.set('offset', String(query.offset ?? 0));
		return this.get<GangAccountList>(`/admin/accounts?${params.toString()}`);
	}

	async account(id: string) {
		return this.get<GangAccountDetail>(`/admin/accounts/${encodeURIComponent(id)}`);
	}

	async accountRooms(q = '') {
		return this.get<GangRoomSummary[]>(`/admin/accounts/rooms?q=${encodeURIComponent(q)}`);
	}

	async createAccount(input: GangAccountCreateInput) {
		return this.request<GangAccountDetail>('/admin/accounts', {
			method: 'POST',
			body: JSON.stringify(input)
		});
	}

	async updateAccount(id: string, patch: GangAccountUpdateInput) {
		return this.request<GangAccountDetail>(`/admin/accounts/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			body: JSON.stringify(patch)
		});
	}

	async resetAccountPassword(id: string, password: string) {
		return this.request<{ revokedSessions: number }>(
			`/admin/accounts/${encodeURIComponent(id)}/password`,
			{ method: 'POST', body: JSON.stringify({ password }) }
		);
	}

	async revokeAccountSessions(id: string) {
		return this.request<{ revokedSessions: number }>(
			`/admin/accounts/${encodeURIComponent(id)}/sessions/revoke`,
			{ method: 'POST' }
		);
	}

	async deleteAccount(id: string, confirmation: string) {
		return this.request<{ username: string }>(`/admin/accounts/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: { 'x-ops-confirmation': confirmation }
		});
	}

	async addAccountMembership(id: string, roomId: string, role: 'member' | 'admin') {
		return this.request<{ role: GangRoomRole }>(
			`/admin/accounts/${encodeURIComponent(id)}/memberships`,
			{ method: 'POST', body: JSON.stringify({ roomId, role }) }
		);
	}

	async updateAccountMembership(id: string, roomId: string, role: GangRoomRole) {
		return this.request<{ role: GangRoomRole }>(
			`/admin/accounts/${encodeURIComponent(id)}/memberships/${encodeURIComponent(roomId)}`,
			{ method: 'PATCH', body: JSON.stringify({ role }) }
		);
	}

	async removeAccountMembership(id: string, roomId: string) {
		return this.request<{ username: string }>(
			`/admin/accounts/${encodeURIComponent(id)}/memberships/${encodeURIComponent(roomId)}`,
			{ method: 'DELETE' }
		);
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
