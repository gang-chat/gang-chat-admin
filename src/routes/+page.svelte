<script lang="ts">
	import { Bot, Database, HardDrive, RefreshCw, Wallet } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { ApiClient, ApiClientError } from '$lib/api/client';
	import AgentPanel from '$lib/components/ops/AgentPanel.svelte';
	import ExpensesPanel from '$lib/components/ops/ExpensesPanel.svelte';
	import MysqlWorkbench from '$lib/components/ops/MysqlWorkbench.svelte';
	import S3Browser from '$lib/components/ops/S3Browser.svelte';
	import type { RunTask } from '$lib/components/ops/types';
	import type { AuthRole, AuthUser, ConnectionPreset } from '$lib/shared/ops-types';

	type View = 'mysql' | 's3' | 'expenses' | 'agent';

	const apiBase = base;

	let token = $state('');
	let actor = $state('');
	let loginUsername = $state('');
	let loginPassword = $state('');
	let health = $state('unknown');
	let busy = $state(false);
	let message = $state('');
	let activeSection = $state<View>('mysql');
	let connections = $state<ConnectionPreset[]>([]);
	let currentUser = $state<AuthUser | undefined>();

	let api = $derived(new ApiClient(apiBase, token, actor));
	let mysqlConnections = $derived(connections.filter((item) => item.type === 'mysql'));
	let s3Connections = $derived(connections.filter((item) => item.type === 's3'));
	let currentRole = $derived<AuthRole | undefined>(currentUser?.role);
	let isAuthenticated = $derived(Boolean(token.trim() && currentUser));

	const navItems: Array<{ id: View; label: string; icon: typeof Database }> = [
		{ id: 'mysql', label: 'MySQL', icon: Database },
		{ id: 's3', label: 'S3', icon: HardDrive },
		{ id: 'agent', label: 'Agent', icon: Bot },
		{ id: 'expenses', label: 'Cost', icon: Wallet }
	];

	onMount(() => {
		token = localStorage.getItem('ops-admin-token') ?? '';
		actor = localStorage.getItem('ops-actor') ?? '';
		void refreshAll().then(updateActiveSection);
		updateActiveSection();
		window.addEventListener('scroll', updateActiveSection, { passive: true });
		return () => window.removeEventListener('scroll', updateActiveSection);
	});

	function updateActiveSection() {
		let next = activeSection;
		let closest = Number.POSITIVE_INFINITY;
		for (const item of navItems) {
			const element = document.getElementById(item.id);
			if (!element) continue;
			const distance = Math.abs(element.getBoundingClientRect().top - 80);
			if (distance < closest) {
				closest = distance;
				next = item.id;
			}
		}
		activeSection = next;
	}

	function scrollToSection(id: View) {
		activeSection = id;
		document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

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
				currentUser = undefined;
				return;
			}
			await refreshIdentity();
			await refreshConnections();
		});
	}

	async function refreshIdentity() {
		const identity = await api.me();
		currentUser = identity.user;
		if (!actor.trim()) actor = identity.user.displayName || identity.user.username;
	}

	async function refreshConnections() {
		connections = await api.connections();
	}

	async function refreshAudit() {}

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
			localStorage.removeItem('ops-actor');
			token = '';
			actor = '';
			connections = [];
			currentUser = undefined;
			message = 'Signed out';
		});
	}
</script>

<svelte:head>
	<title>Gang Chat Ops</title>
</svelte:head>

{#if !isAuthenticated}
	<main class="ops-page-bg flex min-h-screen items-center justify-center px-4 text-foreground">
		<section class="login-card">
			<div class="mb-6">
				<div class="text-[40px] font-semibold leading-tight tracking-[-0.02em]">Gang Chat Ops</div>
				<div class="mt-2 text-[21px] leading-snug text-[#333]">Sign in to the control plane.</div>
				<div class="mt-5 text-sm text-[#7a7a7a]">API {health}</div>
			</div>

			<label class="block text-sm font-medium text-zinc-700" for="ops-username">Username</label>
			<input
				id="ops-username"
				class="mt-1 h-10 w-full rounded-md border-zinc-300 text-sm"
				bind:value={loginUsername}
				autocomplete="username"
			/>

			<label class="mt-4 block text-sm font-medium text-zinc-700" for="ops-password">Password</label
			>
			<input
				id="ops-password"
				class="mt-1 h-10 w-full rounded-md border-zinc-300 text-sm"
				type="password"
				bind:value={loginPassword}
				autocomplete="current-password"
				onkeydown={(event) => {
					if (event.key === 'Enter' && loginUsername && loginPassword) void login();
				}}
			/>

			<button
				class="command-button mt-5 h-10 w-full"
				onclick={login}
				disabled={!loginUsername || !loginPassword || busy}
			>
				Login
			</button>

			{#if message}
				<div
					class="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
				>
					{message}
				</div>
			{/if}
		</section>
	</main>
{:else}
	<main
		class="ops-page-bg min-h-screen space-y-8 px-4 py-4 pr-24 pb-16 text-foreground sm:px-6 sm:pr-28"
	>
		{#if message}
			<div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
				{message}
			</div>
		{/if}

		<section id="mysql" class="scroll-mt-6">
			<MysqlWorkbench {api} {mysqlConnections} {run} />
		</section>

		<section id="s3" class="scroll-mt-6">
			<S3Browser {api} {s3Connections} {currentRole} {run} onAuditRefresh={refreshAudit} />
		</section>

		<section id="agent" class="scroll-mt-6">
			<AgentPanel {api} {currentRole} {run} onAuditRefresh={refreshAudit} />
		</section>

		<section id="expenses" class="scroll-mt-6">
			<ExpensesPanel {api} {currentRole} {run} onAuditRefresh={refreshAudit} />
		</section>

		<aside class="wheel-rail" aria-label="Page navigation">
			<div class="floating-wheel">
				{#each navItems as item (item.id)}
					{@const Icon = item.icon}
					<button
						class="wheel-button {activeSection === item.id ? 'active' : ''}"
						title={item.label}
						onclick={() => scrollToSection(item.id)}
					>
						<Icon class="size-4" />
					</button>
				{/each}
				<button class="wheel-button" title="Refresh" onclick={refreshAll} disabled={busy}>
					<RefreshCw class="size-4 {busy ? 'animate-spin' : ''}" />
				</button>
				<button class="wheel-button wheel-exit" title={`Sign out ${actor}`} onclick={logout}
					>×</button
				>
			</div>
		</aside>
	</main>
{/if}
