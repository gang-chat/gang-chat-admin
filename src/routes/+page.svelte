<script lang="ts">
	import { Bot, Database, HardDrive, RefreshCw, Settings, Terminal, Wallet } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { ApiClient, ApiClientError } from '$lib/api/client';
	import AgentPanel from '$lib/components/ops/AgentPanel.svelte';
	import ConnectionsPanel from '$lib/components/ops/ConnectionsPanel.svelte';
	import ExpensesPanel from '$lib/components/ops/ExpensesPanel.svelte';
	import MysqlWorkbench from '$lib/components/ops/MysqlWorkbench.svelte';
	import S3Browser from '$lib/components/ops/S3Browser.svelte';
	import TerminalWorkspace from '$lib/components/ops/TerminalWorkspace.svelte';
	import type { RunTask } from '$lib/components/ops/types';
	import type {
		AuditEvent,
		AuditIntegrity,
		AuthRole,
		AuthUser,
		ConnectionPreset
	} from '$lib/shared/ops-types';

	type View = 'mysql' | 's3' | 'ssh' | 'expenses' | 'agent' | 'settings';

	const apiBase = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8787';
	const wsBase = import.meta.env.VITE_WS_BASE ?? apiBase.replace(/^http/, 'ws');
	const defaultToken = import.meta.env.DEV ? 'dev-admin-token' : '';
	const defaultLoginUsername = import.meta.env.DEV ? 'admin' : '';

	let view = $state<View>('mysql');
	let token = $state(defaultToken);
	let actor = $state('');
	let loginUsername = $state(defaultLoginUsername);
	let loginPassword = $state('');
	let health = $state('unknown');
	let busy = $state(false);
	let message = $state('');
	let connections = $state<ConnectionPreset[]>([]);
	let audit = $state<AuditEvent[]>([]);
	let auditIntegrity = $state<AuditIntegrity | undefined>();
	let currentUser = $state<AuthUser | undefined>();

	let api = $derived(new ApiClient(apiBase, token, actor));
	let mysqlConnections = $derived(connections.filter((item) => item.type === 'mysql'));
	let s3Connections = $derived(connections.filter((item) => item.type === 's3'));
	let sshConnections = $derived(connections.filter((item) => item.type === 'ssh'));
	let currentRole = $derived<AuthRole | undefined>(currentUser?.role);
	let isAdmin = $derived(currentRole === 'admin');

	const navItems: Array<{ id: View; label: string; icon: typeof Database }> = [
		{ id: 'mysql', label: 'MySQL', icon: Database },
		{ id: 's3', label: 'S3', icon: HardDrive },
		{ id: 'ssh', label: 'SSH', icon: Terminal },
		{ id: 'expenses', label: 'Cost', icon: Wallet },
		{ id: 'agent', label: 'Agent', icon: Bot },
		{ id: 'settings', label: 'Connections', icon: Settings }
	];

	onMount(async () => {
		token = localStorage.getItem('ops-admin-token') ?? defaultToken;
		actor = localStorage.getItem('ops-actor') ?? '';
		await refreshAll();
	});

	const run: RunTask = async (task, success) => {
		busy = true;
		message = '';
		try {
			const result = await task();
			if (success) message = success;
			return result;
		} catch (error) {
			message = formatError(error);
			return undefined;
		} finally {
			busy = false;
		}
	};

	function formatError(error: unknown) {
		if (error instanceof ApiClientError) {
			if (error.status === 401) return 'UNAUTHORIZED: check credentials or token';
			return `${error.code}: ${error.message}`;
		}
		return error instanceof Error ? error.message : 'Operation failed';
	}

	async function refreshAll() {
		await run(async () => {
			const h = await api.health();
			health = `${h.status} / ${h.mode}`;
			if (!token.trim()) {
				connections = [];
				audit = [];
				auditIntegrity = undefined;
				currentUser = undefined;
				message = 'Enter admin token';
				return;
			}
			await refreshIdentity();
			await refreshConnections();
			if (isAdmin) await refreshAudit();
			else {
				audit = [];
				auditIntegrity = undefined;
			}
		});
	}

	async function refreshIdentity() {
		try {
			const identity = await api.me();
			currentUser = identity.user;
			if (!actor.trim()) actor = identity.user.displayName || identity.user.username;
		} catch {
			currentUser = {
				id: 'legacy-token',
				username: 'legacy-token',
				displayName: actor.trim() || 'legacy token',
				role: 'admin',
				disabled: false,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString()
			};
		}
	}

	async function refreshConnections() {
		connections = await api.connections();
	}

	async function refreshAudit() {
		if (!isAdmin) {
			audit = [];
			auditIntegrity = undefined;
			return;
		}
		[audit, auditIntegrity] = await Promise.all([api.audit({ limit: 200 }), api.auditIntegrity()]);
	}

	function saveToken() {
		const trimmed = token.trim();
		const actorName = actor.trim();
		if (actorName) localStorage.setItem('ops-actor', actorName);
		else localStorage.removeItem('ops-actor');
		if (trimmed) {
			token = trimmed;
			localStorage.setItem('ops-admin-token', trimmed);
			message = actorName ? 'Token and operator saved locally' : 'Token saved locally';
			void refreshAll();
			return;
		}
		localStorage.removeItem('ops-admin-token');
		connections = [];
		audit = [];
		auditIntegrity = undefined;
		currentUser = undefined;
		message = actorName ? 'Token cleared' : 'Token and operator cleared';
	}

	async function login() {
		await run(async () => {
			const session = await api.login(loginUsername, loginPassword);
			token = session.token;
			actor = session.user.displayName || session.user.username;
			currentUser = session.user;
			localStorage.setItem('ops-admin-token', session.token);
			localStorage.setItem('ops-actor', actor);
			loginPassword = '';
			message = `Signed in as ${actor}`;
			await refreshAll();
		});
	}

	async function logout() {
		await run(async () => {
			if (token.trim()) await api.logout().catch(() => undefined);
			localStorage.removeItem('ops-admin-token');
			token = '';
			connections = [];
			audit = [];
			auditIntegrity = undefined;
			currentUser = undefined;
			message = 'Signed out';
		});
	}
</script>

<svelte:head>
	<title>Gang Chat Ops</title>
</svelte:head>

<main class="grid min-h-screen grid-cols-[220px_1fr] bg-zinc-100 text-zinc-950">
	<aside class="flex min-h-screen flex-col border-r border-zinc-200 bg-zinc-950 text-zinc-100">
		<div class="border-b border-zinc-800 px-4 py-4">
			<div class="text-sm font-semibold">Gang Chat Ops</div>
			<div class="mt-1 text-xs text-zinc-400">operations control plane</div>
		</div>
		<nav class="flex-1 space-y-1 p-2">
			{#each navItems as item (item.id)}
				{@const Icon = item.icon}
				<button
					class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition hover:bg-zinc-800 {view ===
					item.id
						? 'bg-zinc-800 text-cyan-200'
						: 'text-zinc-300'}"
					onclick={() => (view = item.id)}
				>
					<Icon class="size-4" />
					{item.label}
				</button>
			{/each}
		</nav>
		<div class="border-t border-zinc-800 p-3 text-xs text-zinc-400">
			<div>API {health}</div>
			<div class="mt-1 truncate">{apiBase}</div>
		</div>
	</aside>

	<section class="flex min-w-0 flex-col">
		<header class="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-4">
			<div>
				<div class="text-sm font-semibold">Ops Panel</div>
				<div class="text-xs text-zinc-500">MySQL / S3 / SSH / Cost / Agent</div>
			</div>
			<div class="flex items-center gap-2">
				{#if currentRole}
					<span class="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
						{currentRole}
					</span>
				{/if}
				<input
					class="h-9 w-36 rounded-md border-zinc-300 text-xs"
					bind:value={actor}
					placeholder="operator"
				/>
				<input
					class="h-9 w-32 rounded-md border-zinc-300 text-xs"
					bind:value={loginUsername}
					placeholder="username"
				/>
				<input
					class="h-9 w-40 rounded-md border-zinc-300 text-xs"
					type="password"
					bind:value={loginPassword}
					placeholder="password"
					onkeydown={(event) => {
						if (event.key === 'Enter') void login();
					}}
				/>
				<button
					class="command-button h-9"
					onclick={login}
					disabled={!loginUsername || !loginPassword}
				>
					Login
				</button>
				<input
					class="h-9 w-56 rounded-md border-zinc-300 text-xs"
					type="password"
					bind:value={token}
					placeholder="session or admin token"
				/>
				<button class="icon-button" title="Save token" onclick={saveToken}>
					<Settings class="size-4" />
				</button>
				<button class="command-button h-9" onclick={logout} disabled={!token.trim()}>Logout</button>
				<button class="icon-button" title="Refresh" onclick={refreshAll} disabled={busy}>
					<RefreshCw class="size-4 {busy ? 'animate-spin' : ''}" />
				</button>
			</div>
		</header>

		{#if message}
			<div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
				{message}
			</div>
		{/if}

		<div class="min-h-0 flex-1 overflow-auto p-4">
			{#if view === 'mysql'}
				<MysqlWorkbench
					{api}
					{mysqlConnections}
					{currentRole}
					{run}
					onAuditRefresh={refreshAudit}
				/>
			{:else if view === 's3'}
				<S3Browser {api} {s3Connections} {currentRole} {run} onAuditRefresh={refreshAudit} />
			{:else if view === 'ssh'}
				<TerminalWorkspace {api} {sshConnections} {wsBase} {currentRole} />
			{:else if view === 'expenses'}
				<ExpensesPanel {api} {currentRole} {run} onAuditRefresh={refreshAudit} />
			{:else if view === 'agent'}
				<AgentPanel {api} {currentRole} {run} onAuditRefresh={refreshAudit} />
			{:else}
				<ConnectionsPanel
					{api}
					{connections}
					{audit}
					{auditIntegrity}
					{currentRole}
					{run}
					onConnectionsRefresh={refreshConnections}
					onAuditRefresh={refreshAudit}
				/>
			{/if}
		</div>
	</section>
</main>
