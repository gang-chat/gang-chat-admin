<script lang="ts">
	import { Database, HardDrive, Package, RefreshCw, Users } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { ApiClient, ApiClientError, defaultApiBase } from '$lib/api/client';
	import brandMark from '$lib/assets/gang_chat.svg';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import AccountsPanel from '$lib/components/ops/AccountsPanel.svelte';
	import DatabaseBrowser from '$lib/components/ops/DatabaseBrowser.svelte';
	import ReleasesPanel from '$lib/components/ops/ReleasesPanel.svelte';
	import S3Browser from '$lib/components/ops/S3Browser.svelte';
	import type { RunTask } from '$lib/components/ops/types';
	import type { AdminOverview, AdminSession } from '$lib/shared/ops-types';

	type View = 'releases' | 'files' | 'accounts' | 'database';
	type ApiState = 'checking' | 'online' | 'off' | 'unreachable';

	const tokenKey = 'ops-admin-token';

	let token = $state('');
	let loginUsername = $state('');
	let loginPassword = $state('');
	let apiState = $state<ApiState>('checking');
	let busy = $state(false);
	let message = $state('');
	let activeSection = $state<View>('releases');
	let session = $state<AdminSession | undefined>();
	let overview = $state<AdminOverview | undefined>();
	let releasesPanel = $state<ReturnType<typeof ReleasesPanel> | undefined>();
	// Bumped by Refresh; the panels load on mount, so a new value reloads them all.
	let generation = $state(0);

	let api = $derived(new ApiClient(defaultApiBase, token));
	let isAuthenticated = $derived(Boolean(token.trim() && session && overview));
	let apiLabel = $derived(
		{
			checking: 'API …',
			online: 'API online',
			off: 'Console off',
			unreachable: 'API unreachable'
		}[apiState]
	);

	const navItems: Array<{ id: View; label: string; icon: typeof Database }> = [
		{ id: 'releases', label: 'Releases', icon: Package },
		{ id: 'files', label: 'Files', icon: HardDrive },
		{ id: 'accounts', label: 'Accounts', icon: Users },
		{ id: 'database', label: 'Database', icon: Database }
	];

	onMount(() => {
		token = readToken();
		void refreshAll().then(updateActiveSection);
		updateActiveSection();
		window.addEventListener('scroll', updateActiveSection, { passive: true });
		return () => window.removeEventListener('scroll', updateActiveSection);
	});

	function readToken() {
		try {
			return localStorage.getItem(tokenKey) ?? '';
		} catch {
			return '';
		}
	}

	function storeToken(value: string) {
		try {
			if (value) localStorage.setItem(tokenKey, value);
			else localStorage.removeItem(tokenKey);
		} catch {
			// Private windows can refuse storage; the session then lasts until reload.
		}
	}

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
			if (error instanceof ApiClientError && error.status === 401 && token) {
				signedOut('Your session ended; sign in again');
				return undefined;
			}
			message = formatError(error);
			return undefined;
		} finally {
			busy = false;
		}
	};

	function formatError(error: unknown) {
		if (error instanceof ApiClientError) return `${error.code}: ${error.message}`;
		return error instanceof Error ? error.message : 'Operation failed';
	}

	async function refreshAll() {
		await run(async () => {
			try {
				apiState = (await api.status()).enabled ? 'online' : 'off';
			} catch {
				apiState = 'unreachable';
				return;
			}
			if (!token.trim()) return;
			session = await api.me();
			overview = await api.overview();
			generation += 1;
		});
	}

	async function login() {
		await run(async () => {
			const result = await api.login(loginUsername, loginPassword);
			token = result.token;
			storeToken(result.token);
			session = result.session;
			loginPassword = '';
			overview = await new ApiClient(defaultApiBase, result.token).overview();
			message = `Signed in as ${result.session.username}`;
		});
	}

	async function logout() {
		await run(async () => {
			if (token.trim()) await api.logout().catch(() => undefined);
			signedOut('Signed out');
		});
	}

	function signedOut(note: string) {
		storeToken('');
		token = '';
		session = undefined;
		overview = undefined;
		message = note;
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
					<span class="signal-tag {apiState === 'online' ? 'signal-tag--live' : ''}">
						<span class="signal-tag__dot"></span>{apiLabel}
					</span>
				</div>
				{#if apiState === 'off'}
					<p class="mt-3 text-sm text-muted-foreground">
						Set a strong <code class="font-mono text-[13px] text-foreground">admin_password</code> in
						the server's config.json and restart it. The server log says what is missing.
					</p>
				{/if}
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
				disabled={!loginUsername || !loginPassword || busy || apiState === 'off'}
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
				<span class="signal-tag {apiState === 'online' ? 'signal-tag--live' : ''}">
					<span class="signal-tag__dot"></span>{apiLabel}
				</span>
				{#if session}
					<span class="signal-tag min-w-0">
						<span class="truncate">{session.username}</span>
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

		{#if overview}
			{#key generation}
				<section id="releases" class="scroll-mt-6">
					{@render sectionHeading('01', 'Releases')}
					<ReleasesPanel bind:this={releasesPanel} {api} {run} />
				</section>

				<section id="files" class="scroll-mt-6">
					{@render sectionHeading('02', 'Files')}
					<S3Browser
						{api}
						storage={overview.storage}
						releaseSyncConfig={overview.releaseSync}
						{run}
						onReleaseSynced={async () => releasesPanel?.reload()}
					/>
				</section>

				<section id="accounts" class="scroll-mt-6">
					{@render sectionHeading('03', 'Accounts')}
					<AccountsPanel {api} {run} />
				</section>

				<section id="database" class="scroll-mt-6">
					{@render sectionHeading('04', 'Database')}
					<DatabaseBrowser {api} database={overview.database} {run} />
				</section>
			{/key}
		{/if}

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
				<button
					class="wheel-button wheel-exit"
					title={`Sign out ${session?.username ?? ''}`}
					onclick={logout}>×</button
				>
			</div>
		</aside>
	</main>
{/if}
