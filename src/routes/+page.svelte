<script lang="ts">
	import { Bot, Database, HardDrive, RefreshCw, Wallet } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { ApiClient, ApiClientError } from '$lib/api/client';
	import brandMark from '$lib/assets/gang_chat.svg';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
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
	let apiOnline = $derived(health.startsWith('ok'));

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

{#snippet sectionHeading(index: string, title: string)}
	<div class="section-heading">
		<span class="section-heading__index" aria-hidden="true">{index}</span>
		<h2>{title}</h2>
	</div>
{/snippet}

{#if !isAuthenticated}
	<main class="flex min-h-screen items-center justify-center px-4 py-10 text-foreground">
		<section class="login-card">
			<div class="mb-7">
				<img src={brandMark} alt="" class="mb-6 size-12" />
				<h1 class="font-display text-[30px] leading-[1.15] font-bold tracking-[-0.02em]">
					Gang Chat Ops
				</h1>
				<p class="mt-2 text-[15px] text-muted-foreground">Sign in to the control plane.</p>
				<div class="mt-5">
					<span class="signal-tag {apiOnline ? 'signal-tag--live' : ''}">
						<span class="signal-tag__dot"></span>API {health}
					</span>
				</div>
			</div>

			<label class="eyebrow block" for="ops-username">Username</label>
			<Input
				id="ops-username"
				class="mt-2 h-11"
				bind:value={loginUsername}
				autocomplete="username"
			/>

			<label class="eyebrow mt-5 block" for="ops-password">Password</label>
			<Input
				id="ops-password"
				class="mt-2 h-11"
				type="password"
				bind:value={loginPassword}
				autocomplete="current-password"
				onkeydown={(event) => {
					if (event.key === 'Enter' && loginUsername && loginPassword) void login();
				}}
			/>

			<Button
				class="mt-7 h-11 w-full"
				onclick={login}
				disabled={!loginUsername || !loginPassword || busy}
			>
				Login
			</Button>

			{#if message}
				<div
					class="mt-4 rounded-md border border-warning/32 bg-warning/10 px-4 py-2.5 text-sm text-warning"
				>
					{message}
				</div>
			{/if}
		</section>
	</main>
{:else}
	<main class="min-h-screen space-y-8 px-4 pt-4 pb-28 text-foreground sm:pr-28 sm:pb-16 sm:pl-6">
		<header class="ops-header">
			<div class="flex min-w-0 items-center gap-3">
				<img src={brandMark} alt="" class="size-9 shrink-0" />
				<span class="truncate font-display text-xl leading-none font-bold tracking-[-0.01em]">
					Gang Chat Ops
				</span>
			</div>
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<span class="signal-tag {apiOnline ? 'signal-tag--live' : ''}">
					<span class="signal-tag__dot"></span>API {health}
				</span>
				{#if currentUser}
					<span class="signal-tag min-w-0">
						<span class="truncate">{actor} · {currentUser.role}</span>
					</span>
				{/if}
			</div>
		</header>

		{#if message}
			<div
				class="rounded-md border border-warning/32 bg-warning/10 px-4 py-2.5 text-sm text-warning"
			>
				{message}
			</div>
		{/if}

		<section id="mysql" class="scroll-mt-6">
			{@render sectionHeading('01', 'MySQL')}
			<MysqlWorkbench {api} {mysqlConnections} {run} />
		</section>

		<section id="s3" class="scroll-mt-6">
			{@render sectionHeading('02', 'S3 files')}
			<S3Browser {api} {s3Connections} {currentRole} {run} onAuditRefresh={refreshAudit} />
		</section>

		<section id="agent" class="scroll-mt-6">
			{@render sectionHeading('03', 'Agent')}
			<AgentPanel {api} {currentRole} {run} onAuditRefresh={refreshAudit} />
		</section>

		<section id="expenses" class="scroll-mt-6">
			{@render sectionHeading('04', 'Cost')}
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
