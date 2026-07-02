<script lang="ts">
	import { Download, Pencil, Play, Plus, Trash2, Upload, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { ApiClient } from '$lib/api/client';
	import type {
		AuditEvent,
		AuditIntegrity,
		AuthSession,
		AuthUser,
		AuthRole,
		BackupPayload,
		ConnectionInput,
		ConnectionPreset,
		ConnectionType,
		RestorePreview
	} from '$lib/shared/ops-types';
	import type { RunTask } from './types';

	let {
		api,
		connections,
		audit,
		auditIntegrity,
		currentRole,
		run,
		onConnectionsRefresh,
		onAuditRefresh
	}: {
		api: ApiClient;
		connections: ConnectionPreset[];
		audit: AuditEvent[];
		auditIntegrity?: AuditIntegrity;
		currentRole?: AuthRole;
		run: RunTask;
		onConnectionsRefresh: () => Promise<void>;
		onAuditRefresh: () => Promise<void>;
	} = $props();

	type AuditStatusFilter = 'all' | 'ok' | 'failed' | 'pending';
	const PASSWORD_MIN_LENGTH = 14;

	type ConnectionForm = {
		type: ConnectionType;
		name: string;
		tags: string;
		host: string;
		port: number;
		database: string;
		user: string;
		password: string;
		ssl: boolean;
		allowMutations: boolean;
		endpoint: string;
		region: string;
		defaultBucket: string;
		forcePathStyle: boolean;
		allowWrites: boolean;
		accessKeyId: string;
		secretAccessKey: string;
		sessionToken: string;
		username: string;
		hostKeySha256: string;
		privateKey: string;
		passphrase: string;
	};

	let editingId = $state<string | undefined>();
	let form = $state<ConnectionForm>(blankForm());
	let auditStatus = $state<AuditStatusFilter>('all');
	let auditAction = $state('');
	let auditTarget = $state('');
	let expandedAuditId = $state<string | undefined>();
	let restoreFile = $state<File | undefined>();
	let restoreBackupPayload = $state<BackupPayload | undefined>();
	let restorePreview = $state<RestorePreview | undefined>();
	let restoreConfirmation = $state('');
	let deleteConnectionId = $state<string | undefined>();
	let deleteConnectionConfirmation = $state('');
	let authUsers = $state<AuthUser[]>([]);
	let authSessions = $state<AuthSession[]>([]);
	let newUsername = $state('');
	let newDisplayName = $state('');
	let newRole = $state<AuthRole>('viewer');
	let newPassword = $state('');
	let currentPassword = $state('');
	let nextPassword = $state('');
	let revokeOtherSessions = $state(true);
	let disableUserId = $state<string | undefined>();
	let disableUserConfirmation = $state('');
	let revokeSessionId = $state<string | undefined>();
	let revokeSessionConfirmation = $state('');
	let deleteConnectionTarget = $derived(connections.find((item) => item.id === deleteConnectionId));
	let disableUserTarget = $derived(authUsers.find((item) => item.id === disableUserId));
	let revokeSessionTarget = $derived(authSessions.find((item) => item.id === revokeSessionId));
	let newPasswordIssues = $derived(passwordPolicyIssues(newPassword, newUsername));
	let nextPasswordIssues = $derived(passwordPolicyIssues(nextPassword));
	let now = $state(Date.now());
	let filteredAudit = $derived(
		audit.filter((item) => {
			const matchesStatus = auditStatus === 'all' || item.status === auditStatus;
			const matchesAction =
				!auditAction || item.action.toLowerCase().startsWith(auditAction.toLowerCase());
			const matchesTarget =
				!auditTarget || item.target.toLowerCase().includes(auditTarget.toLowerCase());
			return matchesStatus && matchesAction && matchesTarget;
		})
	);
	let isAdmin = $derived(currentRole === 'admin');

	onMount(() => {
		const clock = setInterval(() => {
			now = Date.now();
		}, 30_000);
		void loadAuthSessions().catch(() => undefined);
		return () => clearInterval(clock);
	});

	$effect(() => {
		if (isAdmin && authUsers.length === 0) void refreshAuthUsers();
	});

	function blankForm(): ConnectionForm {
		return {
			type: 'mysql',
			name: '',
			tags: '',
			host: '',
			port: 3306,
			database: '',
			user: '',
			password: '',
			ssl: false,
			allowMutations: false,
			endpoint: '',
			region: 'auto',
			defaultBucket: '',
			forcePathStyle: true,
			allowWrites: false,
			accessKeyId: '',
			secretAccessKey: '',
			sessionToken: '',
			username: '',
			hostKeySha256: '',
			privateKey: '',
			passphrase: ''
		};
	}

	function resetForm() {
		editingId = undefined;
		form = blankForm();
	}

	function editConnection(item: ConnectionPreset) {
		const next = blankForm();
		next.type = item.type;
		next.name = item.name;
		next.tags = item.tags.join(', ');
		const config = item.config;
		if ('database' in config) {
			next.host = config.host;
			next.port = config.port;
			next.database = config.database;
			next.user = config.user;
			next.ssl = config.ssl;
			next.allowMutations = Boolean(config.allowMutations);
		} else if ('endpoint' in config) {
			next.endpoint = config.endpoint;
			next.region = config.region;
			next.defaultBucket = config.defaultBucket ?? '';
			next.forcePathStyle = config.forcePathStyle;
			next.allowWrites = Boolean(config.allowWrites);
		} else if ('username' in config) {
			next.host = config.host;
			next.port = config.port;
			next.username = config.username;
			next.hostKeySha256 = config.hostKeySha256 ?? '';
		}
		editingId = item.id;
		form = next;
	}

	$effect(() => {
		if (form.type === 'mysql' && !form.port) form.port = 3306;
		if (form.type === 'ssh' && !form.port) form.port = 22;
	});

	async function saveConnection() {
		const input = buildConnectionInput();
		await run(
			async () => {
				if (editingId) await api.updateConnection(editingId, input);
				else await api.createConnection(input);
				await onConnectionsRefresh();
				await onAuditRefresh();
				resetForm();
			},
			editingId ? 'Connection updated' : 'Connection saved'
		);
	}

	async function testConnection(id: string) {
		await run(async () => {
			await api.testConnection(id);
			await onConnectionsRefresh();
			await onAuditRefresh();
		}, 'Connection healthy');
	}

	function prepareDeleteConnection(id: string) {
		deleteConnectionId = id;
		deleteConnectionConfirmation = '';
	}

	async function deleteConnection() {
		if (!deleteConnectionId || deleteConnectionConfirmation !== deleteConnectionId) return;
		const id = deleteConnectionId;
		await run(async () => {
			await api.deleteConnection(id, deleteConnectionConfirmation);
			await onConnectionsRefresh();
			await onAuditRefresh();
			deleteConnectionId = undefined;
			deleteConnectionConfirmation = '';
		}, 'Connection deleted');
	}

	async function exportBackup() {
		await run(async () => {
			const backup = await api.exportBackup();
			const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], {
				type: 'application/json'
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = `gang-chat-ops-backup-${backup.exportedAt.replaceAll(':', '-')}.json`;
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
			await onAuditRefresh();
		}, 'Backup exported');
	}

	async function exportAudit() {
		await run(async () => {
			const exported = await api.exportAudit();
			const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], {
				type: 'application/json'
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = `gang-chat-ops-audit-${exported.exportedAt.replaceAll(':', '-')}.json`;
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
			await onAuditRefresh();
		}, 'Audit export downloaded');
	}

	function handleRestoreFile(file: File | undefined) {
		restoreFile = file;
		restoreBackupPayload = undefined;
		restorePreview = undefined;
		restoreConfirmation = '';
	}

	async function previewRestoreBackup() {
		if (!restoreFile) return;
		const file = restoreFile;
		await run(async () => {
			const backup = JSON.parse(await file.text()) as BackupPayload;
			const preview = await api.previewRestoreBackup(backup);
			restoreBackupPayload = backup;
			restorePreview = preview;
			await onAuditRefresh();
		}, 'Backup preview ready');
	}

	async function restoreBackup() {
		if (!restoreBackupPayload || !restorePreview || restoreConfirmation !== 'RESTORE') return;
		const backup = restoreBackupPayload;
		await run(async () => {
			await api.restoreBackup(backup, 'RESTORE');
			restoreFile = undefined;
			restoreBackupPayload = undefined;
			restorePreview = undefined;
			restoreConfirmation = '';
			await onConnectionsRefresh();
			await onAuditRefresh();
		}, 'Backup restored');
	}

	async function refreshAuthUsers() {
		if (!isAdmin) return;
		await run(async () => {
			await loadAuthUsers();
		});
	}

	async function loadAuthUsers() {
		if (!isAdmin) return;
		authUsers = await api.authUsers();
	}

	async function refreshAuthSessions() {
		await run(async () => {
			await loadAuthSessions();
		});
	}

	async function loadAuthSessions() {
		authSessions = await api.authSessions();
	}

	async function createAuthUser() {
		await run(async () => {
			await api.createAuthUser({
				username: newUsername,
				displayName: newDisplayName || undefined,
				role: newRole,
				password: newPassword
			});
			newUsername = '';
			newDisplayName = '';
			newRole = 'viewer';
			newPassword = '';
			await loadAuthUsers();
			await onAuditRefresh();
		}, 'User created');
	}

	function prepareDisableUser(id: string) {
		disableUserId = id;
		disableUserConfirmation = '';
	}

	async function disableAuthUser() {
		if (!disableUserId || disableUserConfirmation !== disableUserId) return;
		const id = disableUserId;
		await run(async () => {
			await api.disableAuthUser(id, disableUserConfirmation);
			disableUserId = undefined;
			disableUserConfirmation = '';
			await loadAuthUsers();
			await onAuditRefresh();
		}, 'User disabled');
	}

	async function changePassword() {
		await run(async () => {
			await api.changePassword({
				currentPassword,
				newPassword: nextPassword,
				revokeOtherSessions
			});
			currentPassword = '';
			nextPassword = '';
			await loadAuthSessions();
			await onAuditRefresh();
		}, 'Password changed');
	}

	function prepareRevokeSession(id: string) {
		revokeSessionId = id;
		revokeSessionConfirmation = '';
	}

	async function revokeAuthSession() {
		if (!revokeSessionId || revokeSessionConfirmation !== revokeSessionId) return;
		const id = revokeSessionId;
		await run(async () => {
			await api.revokeAuthSession(id, revokeSessionConfirmation);
			revokeSessionId = undefined;
			revokeSessionConfirmation = '';
			await loadAuthSessions();
			await onAuditRefresh();
		}, 'Session revoked');
	}

	function buildConnectionInput(): ConnectionInput {
		const tags = form.tags
			.split(',')
			.map((tag) => tag.trim())
			.filter(Boolean);
		if (form.type === 'mysql') {
			return {
				type: 'mysql',
				name: form.name,
				tags,
				config: {
					host: form.host,
					port: Number(form.port),
					database: form.database,
					user: form.user,
					password: form.password,
					ssl: form.ssl,
					allowMutations: form.allowMutations
				}
			};
		}
		if (form.type === 's3') {
			return {
				type: 's3',
				name: form.name,
				tags,
				config: {
					endpoint: form.endpoint,
					region: form.region,
					defaultBucket: form.defaultBucket || undefined,
					forcePathStyle: form.forcePathStyle,
					allowWrites: form.allowWrites,
					accessKeyId: form.accessKeyId,
					secretAccessKey: form.secretAccessKey,
					sessionToken: form.sessionToken || undefined
				}
			};
		}
		return {
			type: 'ssh',
			name: form.name,
			tags,
			config: {
				host: form.host,
				port: Number(form.port || 22),
				username: form.username,
				hostKeySha256: form.hostKeySha256 || undefined,
				password: form.password || undefined,
				privateKey: form.privateKey || undefined,
				passphrase: form.passphrase || undefined
			}
		};
	}

	function userStatus(user: AuthUser) {
		if (user.disabled) return 'disabled';
		if (user.lockedUntil && Date.parse(user.lockedUntil) > now) return 'locked';
		return 'active';
	}

	function passwordPolicyIssues(password: string, username = '') {
		const issues: string[] = [];
		if (password.length < PASSWORD_MIN_LENGTH) issues.push(`${PASSWORD_MIN_LENGTH}+ chars`);
		if (!/[a-z]/.test(password)) issues.push('lowercase');
		if (!/[A-Z]/.test(password)) issues.push('uppercase');
		if (!/\d/.test(password)) issues.push('number');
		if (!/[^A-Za-z0-9]/.test(password)) issues.push('symbol');
		const normalizedUsername = username
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '');
		const normalizedPassword = password.toLowerCase().replace(/[^a-z0-9]/g, '');
		if (normalizedUsername.length >= 3 && normalizedPassword.includes(normalizedUsername)) {
			issues.push('no username');
		}
		return issues;
	}
</script>

<section class="workspace">
	<div class="grid grid-cols-[420px_1fr] gap-4">
		<div class="panel">
			<div class="flex items-center justify-between">
				<div class="panel-title">
					{editingId ? 'Edit Connection Preset' : 'New Connection Preset'}
				</div>
				{#if editingId}
					<button class="icon-button" title="Cancel edit" onclick={resetForm}>
						<X class="size-4" />
					</button>
				{/if}
			</div>
			<div class="form-grid">
				<select bind:value={form.type} disabled={Boolean(editingId)}>
					<option value="mysql">MySQL</option>
					<option value="s3">S3</option>
					<option value="ssh">SSH</option>
				</select>
				<input bind:value={form.name} placeholder="name" />
				<input bind:value={form.tags} placeholder="tags, comma separated" />
				{#if form.type === 'mysql'}
					<input bind:value={form.host} placeholder="host" />
					<input type="number" bind:value={form.port} placeholder="port" />
					<input bind:value={form.database} placeholder="database" />
					<input bind:value={form.user} placeholder="user" />
					<input type="password" bind:value={form.password} placeholder="password" />
					<label class="checkline"><input type="checkbox" bind:checked={form.ssl} /> TLS</label>
					<label class="checkline"
						><input type="checkbox" bind:checked={form.allowMutations} /> allow writes</label
					>
				{:else if form.type === 's3'}
					<input bind:value={form.endpoint} placeholder="endpoint" />
					<input bind:value={form.region} placeholder="region" />
					<input bind:value={form.defaultBucket} placeholder="default bucket" />
					<input bind:value={form.accessKeyId} placeholder="access key id" />
					<input
						type="password"
						bind:value={form.secretAccessKey}
						placeholder="secret access key"
					/>
					<input type="password" bind:value={form.sessionToken} placeholder="session token" />
					<label class="checkline"
						><input type="checkbox" bind:checked={form.forcePathStyle} /> path style</label
					>
					<label class="checkline"
						><input type="checkbox" bind:checked={form.allowWrites} /> allow writes</label
					>
				{:else}
					<input bind:value={form.host} placeholder="host" />
					<input type="number" bind:value={form.port} placeholder="port" />
					<input bind:value={form.username} placeholder="username" />
					<input bind:value={form.hostKeySha256} placeholder="host key SHA256 fingerprint" />
					<input type="password" bind:value={form.password} placeholder="password" />
					<textarea bind:value={form.privateKey} placeholder="private key"></textarea>
					<input type="password" bind:value={form.passphrase} placeholder="passphrase" />
				{/if}
			</div>
			{#if editingId}
				<div class="mt-2 rounded border border-cyan-200 bg-cyan-50 px-2 py-1 text-xs text-cyan-900">
					Secret fields left blank keep their existing encrypted values.
				</div>
			{/if}
			<button class="command-button mt-3" onclick={saveConnection} disabled={!isAdmin}>
				<Plus class="size-4" />
				{editingId ? 'Update preset' : 'Save preset'}
			</button>

			{#if isAdmin}
				<div class="mt-6 border-t border-zinc-200 pt-4">
					<div class="panel-title">Runtime Backup</div>
					<div class="space-y-2 text-xs text-zinc-600">
						<button class="command-button w-full" onclick={exportBackup}>
							<Download class="size-4" /> Export encrypted state
						</button>
						<input
							type="file"
							accept="application/json"
							onchange={(event) => handleRestoreFile(event.currentTarget.files?.[0])}
						/>
						<button
							class="command-button w-full"
							onclick={previewRestoreBackup}
							disabled={!restoreFile}
						>
							Preview restore
						</button>
						{#if restorePreview}
							<div class="rounded border border-cyan-200 bg-cyan-50 p-2 text-xs text-cyan-950">
								<div class="font-semibold">Restore preview</div>
								<div class="mt-1">exported: {restorePreview.exportedAt}</div>
								<div class="mt-2 grid grid-cols-[1fr_auto_auto] gap-x-2 gap-y-1">
									<span></span><span>current</span><span>incoming</span>
									<span>connections</span><span>{restorePreview.current.connections}</span><span
										>{restorePreview.incoming.connections}</span
									>
									<span>audit events</span><span>{restorePreview.current.auditEvents}</span><span
										>{restorePreview.incoming.auditEvents}</span
									>
									<span>expenses</span><span>{restorePreview.current.expenseEntries}</span><span
										>{restorePreview.incoming.expenseEntries}</span
									>
									<span>agent jobs</span><span>{restorePreview.current.agentJobs}</span><span
										>{restorePreview.incoming.agentJobs}</span
									>
									<span>users</span><span>{restorePreview.current.authUsers}</span><span
										>{restorePreview.incoming.authUsers}</span
									>
									<span>sessions</span><span>{restorePreview.current.authSessions}</span><span
										>{restorePreview.incoming.authSessions}</span
									>
								</div>
								{#if restorePreview.missingStores.length > 0}
									<div class="mt-2 text-amber-800">
										Missing optional stores will use defaults: {restorePreview.missingStores.join(
											', '
										)}
									</div>
								{/if}
							</div>
						{/if}
						<input bind:value={restoreConfirmation} placeholder="type RESTORE to overwrite state" />
						<button
							class="danger-button w-full"
							onclick={restoreBackup}
							disabled={!restorePreview || restoreConfirmation !== 'RESTORE'}
						>
							<Upload class="size-4" /> Restore backup
						</button>
						<div>
							Backups include encrypted connection secrets. Restore overwrites connections,
							expenses, audit logs, users, and active sessions.
						</div>
					</div>
				</div>
			{/if}

			<div class="mt-6 border-t border-zinc-200 pt-4">
				{#if isAdmin}
					<div class="flex items-center justify-between">
						<div class="panel-title">Admin Users</div>
						<button class="command-button compact" onclick={refreshAuthUsers}>Refresh</button>
					</div>
					<div class="form-grid">
						<input bind:value={newUsername} placeholder="username" />
						<input bind:value={newDisplayName} placeholder="display name" />
						<select bind:value={newRole}>
							<option value="viewer">viewer</option>
							<option value="operator">operator</option>
							<option value="admin">admin</option>
						</select>
						<input
							type="password"
							bind:value={newPassword}
							placeholder="password, 14+ chars + Aa1!"
						/>
					</div>
					{#if newPassword && newPasswordIssues.length > 0}
						<div class="mt-1 text-xs text-amber-700">
							Missing: {newPasswordIssues.join(', ')}
						</div>
					{/if}
					<button
						class="command-button mt-2 w-full"
						onclick={createAuthUser}
						disabled={!newUsername || newPasswordIssues.length > 0}
					>
						<Plus class="size-4" /> Create user
					</button>
					{#if disableUserTarget}
						<div class="mt-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-900">
							<div class="font-semibold">Confirm user disable</div>
							<div class="mt-1">{disableUserTarget.username}</div>
							<div class="mt-1 break-all">id: {disableUserTarget.id}</div>
							<input
								class="mt-2 w-full"
								bind:value={disableUserConfirmation}
								placeholder="type user id to disable"
							/>
							<div class="mt-2 flex gap-2">
								<button
									class="danger-button"
									onclick={disableAuthUser}
									disabled={disableUserConfirmation !== disableUserTarget.id}
								>
									<Trash2 class="size-4" /> Disable user
								</button>
								<button
									class="command-button"
									onclick={() => {
										disableUserId = undefined;
										disableUserConfirmation = '';
									}}
								>
									Cancel
								</button>
							</div>
						</div>
					{/if}
					<div class="mt-3 space-y-1">
						{#each authUsers as user (user.id)}
							<div
								class="grid grid-cols-[1fr_auto] items-center gap-2 rounded border border-zinc-200 bg-white px-2 py-1 text-xs"
							>
								<div>
									<div class="font-medium">{user.displayName}</div>
									<div class="text-zinc-500">
										{user.username} / {user.role} / {userStatus(user)}
										{#if user.failedLoginCount}
											/ failed {user.failedLoginCount}
										{/if}
									</div>
									{#if user.lockedUntil && Date.parse(user.lockedUntil) > now}
										<div class="text-red-600">
											locked until {user.lockedUntil.slice(0, 19).replace('T', ' ')}
										</div>
									{/if}
								</div>
								<button
									class="danger-button compact"
									onclick={() => prepareDisableUser(user.id)}
									disabled={user.disabled}
								>
									<Trash2 class="size-3" />
								</button>
							</div>
						{/each}
						{#if authUsers.length === 0}
							<div
								class="rounded border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500"
							>
								No users loaded.
							</div>
						{/if}
					</div>
				{/if}

				<div class="mt-5 border-t border-zinc-200 pt-4">
					<div class="panel-title">Password</div>
					<div class="form-grid">
						<input type="password" bind:value={currentPassword} placeholder="current password" />
						<input
							type="password"
							bind:value={nextPassword}
							placeholder="new password, 14+ chars + Aa1!"
						/>
						<label class="checkline"
							><input type="checkbox" bind:checked={revokeOtherSessions} /> revoke other sessions</label
						>
					</div>
					{#if nextPassword && nextPasswordIssues.length > 0}
						<div class="mt-1 text-xs text-amber-700">
							Missing: {nextPasswordIssues.join(', ')}
						</div>
					{/if}
					<button
						class="command-button mt-2 w-full"
						onclick={changePassword}
						disabled={!currentPassword || nextPasswordIssues.length > 0}
					>
						Update password
					</button>
				</div>

				<div class="mt-5 border-t border-zinc-200 pt-4">
					<div class="flex items-center justify-between">
						<div class="panel-title">Sessions</div>
						<button class="command-button compact" onclick={refreshAuthSessions}>Refresh</button>
					</div>
					{#if revokeSessionTarget}
						<div class="mb-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-900">
							<div class="font-semibold">Confirm session revoke</div>
							<div class="mt-1">
								{revokeSessionTarget.current ? 'current session' : revokeSessionTarget.username}
							</div>
							<div class="mt-1 break-all">id: {revokeSessionTarget.id}</div>
							<input
								class="mt-2 w-full"
								bind:value={revokeSessionConfirmation}
								placeholder="type session id to revoke"
							/>
							<div class="mt-2 flex gap-2">
								<button
									class="danger-button"
									onclick={revokeAuthSession}
									disabled={revokeSessionConfirmation !== revokeSessionTarget.id}
								>
									<Trash2 class="size-4" /> Revoke session
								</button>
								<button
									class="command-button"
									onclick={() => {
										revokeSessionId = undefined;
										revokeSessionConfirmation = '';
									}}
								>
									Cancel
								</button>
							</div>
						</div>
					{/if}
					<div class="space-y-1">
						{#each authSessions as session (session.id)}
							<div
								class="grid grid-cols-[1fr_auto] items-center gap-2 rounded border border-zinc-200 bg-white px-2 py-1 text-xs"
							>
								<div>
									<div class="font-medium">
										{session.current ? 'Current session' : session.id.slice(0, 8)}
									</div>
									<div class="text-zinc-500">
										seen {session.lastSeenAt.slice(0, 19).replace('T', ' ')}
									</div>
									<div class="text-zinc-500">
										idle expires {session.idleExpiresAt.slice(0, 19).replace('T', ' ')}
									</div>
									<div class="text-zinc-500">
										expires {session.expiresAt.slice(0, 19).replace('T', ' ')}
									</div>
								</div>
								<button
									class="danger-button compact"
									onclick={() => prepareRevokeSession(session.id)}
									disabled={Boolean(session.revokedAt)}
								>
									<Trash2 class="size-3" />
								</button>
							</div>
						{/each}
						{#if authSessions.length === 0}
							<div
								class="rounded border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500"
							>
								No sessions loaded.
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>
		<div class="panel overflow-auto">
			<div class="panel-title">Presets</div>
			{#if !isAdmin}
				<div
					class="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
				>
					Connection, audit, backup, and user administration require admin role.
				</div>
			{/if}
			{#if deleteConnectionTarget}
				<div class="mb-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-900">
					<div class="font-semibold">Confirm preset delete</div>
					<div class="mt-1">
						{deleteConnectionTarget.name} / {deleteConnectionTarget.type}
					</div>
					<div class="mt-1 break-all">id: {deleteConnectionTarget.id}</div>
					<input
						class="mt-2 w-full"
						bind:value={deleteConnectionConfirmation}
						placeholder="type connection id to delete"
					/>
					<div class="mt-2 flex gap-2">
						<button
							class="danger-button"
							onclick={deleteConnection}
							disabled={deleteConnectionConfirmation !== deleteConnectionTarget.id}
						>
							<Trash2 class="size-4" /> Delete preset
						</button>
						<button
							class="command-button"
							onclick={() => {
								deleteConnectionId = undefined;
								deleteConnectionConfirmation = '';
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			{/if}
			<table class="data-table">
				<thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Target</th><th></th></tr></thead>
				<tbody>
					{#each connections as item (item.id)}
						<tr>
							<td>{item.name}</td>
							<td>{item.type}</td>
							<td>{item.status}</td>
							<td>
								{'host' in item.config
									? item.config.host
									: 'endpoint' in item.config
										? item.config.endpoint
										: ''}
							</td>
							<td class="text-right">
								<button
									class="command-button compact"
									onclick={() => editConnection(item)}
									disabled={!isAdmin}
								>
									<Pencil class="size-3" />
								</button>
								<button
									class="command-button compact"
									onclick={() => testConnection(item.id)}
									disabled={!isAdmin}
								>
									<Play class="size-3" />
								</button>
								<button
									class="danger-button compact"
									onclick={() => prepareDeleteConnection(item.id)}
									disabled={!isAdmin}
								>
									<Trash2 class="size-3" />
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if isAdmin}
				<div class="mt-6 flex items-center justify-between gap-2">
					<div class="panel-title">Audit</div>
					<button class="command-button compact" onclick={exportAudit}>
						<Download class="size-3" /> Export
					</button>
				</div>
				{#if auditIntegrity}
					<div
						class="mb-2 rounded border px-3 py-2 text-xs {auditIntegrity.valid
							? 'border-emerald-200 bg-emerald-50 text-emerald-900'
							: 'border-red-200 bg-red-50 text-red-900'}"
					>
						<div class="font-semibold">
							{auditIntegrity.valid ? 'Audit integrity verified' : 'Audit integrity failed'}
						</div>
						<div class="mt-1 grid grid-cols-[repeat(4,minmax(0,1fr))] gap-2">
							<span>total: {auditIntegrity.total}</span>
							<span>signed: {auditIntegrity.signed}</span>
							<span>unsigned: {auditIntegrity.unsigned}</span>
							<span class="truncate">head: {auditIntegrity.headHash ?? 'none'}</span>
						</div>
						{#if !auditIntegrity.valid}
							<div class="mt-1">
								{auditIntegrity.reason ?? 'unknown'} at {auditIntegrity.brokenAt ?? 'unknown'}
							</div>
						{/if}
					</div>
				{/if}
				<div class="mb-2 grid grid-cols-[130px_1fr_1fr] gap-2">
					<select bind:value={auditStatus}>
						<option value="all">All status</option>
						<option value="ok">OK</option>
						<option value="failed">Failed</option>
						<option value="pending">Pending</option>
					</select>
					<input bind:value={auditAction} placeholder="action prefix" />
					<input bind:value={auditTarget} placeholder="target contains" />
				</div>
				<div class="space-y-1">
					{#each filteredAudit as item (item.id)}
						<button
							class="grid w-full grid-cols-[150px_170px_1fr_70px] gap-2 rounded border border-zinc-200 px-2 py-1 text-left text-xs {item.status ===
							'failed'
								? 'border-red-200 bg-red-50'
								: item.status === 'pending'
									? 'border-amber-200 bg-amber-50'
									: 'bg-white'}"
							onclick={() => (expandedAuditId = expandedAuditId === item.id ? undefined : item.id)}
						>
							<span>{item.at.slice(0, 19).replace('T', ' ')}</span>
							<span>{item.action}</span>
							<span class="truncate">{item.target}</span>
							<span>{item.status}</span>
						</button>
						{#if expandedAuditId === item.id}
							<div
								class="rounded border border-zinc-200 bg-zinc-50 px-2 py-2 text-xs text-zinc-700"
							>
								<div>actor: {item.actor}</div>
								<div>target: {item.target}</div>
								{#if item.detail}
									<div class="mt-1 whitespace-pre-wrap">detail: {item.detail}</div>
								{/if}
							</div>
						{/if}
					{/each}
					{#if filteredAudit.length === 0}
						<div
							class="rounded border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500"
						>
							No audit events match the filters.
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</section>
