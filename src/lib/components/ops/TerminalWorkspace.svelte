<script lang="ts">
	import { Copy, Grid2X2, RefreshCw, Plus, Trash2 } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { ApiClient } from '$lib/api/client';
	import type { AuthRole, ConnectionPreset, SshActiveSession } from '$lib/shared/ops-types';
	import TerminalPane from './TerminalPane.svelte';

	type TerminalBlock = { id: string; connectionId: string; label: string };

	let {
		api,
		sshConnections,
		wsBase,
		currentRole
	}: {
		api: ApiClient;
		sshConnections: ConnectionPreset[];
		wsBase: string;
		currentRole?: AuthRole;
	} = $props();

	const storageKey = 'gang-ops-terminal-workspace';

	let terminalBlocks = $state<TerminalBlock[]>([newTerminalBlock('')]);
	let columns = $state(2);
	let sessions = $state<SshActiveSession[]>([]);
	let sessionsLoading = $state(false);
	let sessionMessage = $state('');
	let killSessionId = $state('');
	let killConfirmation = $state('');
	let selectedTerminalNames = $derived(
		Object.fromEntries(sshConnections.map((item) => [item.id, item.name]))
	);
	let gridTemplate = $derived(`repeat(${columns}, minmax(320px, 1fr))`);
	let canOperate = $derived(currentRole === 'operator' || currentRole === 'admin');
	let killTarget = $derived(sessions.find((session) => session.id === killSessionId));

	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as {
				columns?: number;
				blocks?: TerminalBlock[];
			};
			if (saved.columns && [1, 2, 3, 4].includes(saved.columns)) columns = saved.columns;
			if (saved.blocks?.length) terminalBlocks = saved.blocks;
		} catch {
			// Ignore invalid local workspace state.
		}
		void refreshSessions();
	});

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(storageKey, JSON.stringify({ columns, blocks: terminalBlocks }));
	});

	function newTerminalBlock(connectionId: string): TerminalBlock {
		return {
			id: crypto.randomUUID(),
			connectionId,
			label: ''
		};
	}

	function addTerminalBlock() {
		terminalBlocks = [...terminalBlocks, newTerminalBlock(sshConnections[0]?.id ?? '')];
	}

	function duplicateTerminalBlock(block: TerminalBlock) {
		terminalBlocks = [
			...terminalBlocks,
			{ ...newTerminalBlock(block.connectionId), label: block.label }
		];
	}

	function removeTerminalBlock(id: string) {
		terminalBlocks = terminalBlocks.filter((block) => block.id !== id);
		if (terminalBlocks.length === 0) terminalBlocks = [newTerminalBlock('')];
	}

	function resetWorkspace() {
		terminalBlocks = [newTerminalBlock(sshConnections[0]?.id ?? '')];
		columns = 1;
	}

	function blockTitle(block: TerminalBlock) {
		return block.label || selectedTerminalNames[block.connectionId] || 'SSH terminal';
	}

	function connectionTarget(connectionId: string) {
		const preset = sshConnections.find((item) => item.id === connectionId);
		if (!preset || !('username' in preset.config)) return '';
		return `${preset.config.username}@${preset.config.host}:${preset.config.port}`;
	}

	async function refreshSessions() {
		if (!canOperate) return;
		sessionsLoading = true;
		sessionMessage = '';
		try {
			sessions = await api.sshSessions();
		} catch (error) {
			sessionMessage = error instanceof Error ? error.message : 'Failed to load SSH sessions';
		} finally {
			sessionsLoading = false;
		}
	}

	function prepareKillSession(id: string) {
		killSessionId = id;
		killConfirmation = '';
	}

	async function closeSession() {
		if (!killTarget || killConfirmation !== killTarget.id) return;
		sessionMessage = '';
		try {
			await api.closeSshSession(killTarget.id, killConfirmation);
			killSessionId = '';
			killConfirmation = '';
			await refreshSessions();
			sessionMessage = 'SSH session closed';
		} catch (error) {
			sessionMessage = error instanceof Error ? error.message : 'Failed to close SSH session';
		}
	}
</script>

<section class="workspace">
	<div class="grid gap-3 xl:grid-cols-[1fr_360px]">
		<div class="min-w-0">
			<div class="toolbar justify-between">
				<div>
					<div class="text-sm font-semibold">Terminal Workspace</div>
					<div class="text-xs text-zinc-500">{terminalBlocks.length} panes / {columns} columns</div>
				</div>
				<div class="flex items-center gap-2">
					<Grid2X2 class="size-4 text-zinc-500" />
					<select class="h-9 text-xs" bind:value={columns}>
						<option value={1}>1 column</option>
						<option value={2}>2 columns</option>
						<option value={3}>3 columns</option>
						<option value={4}>4 columns</option>
					</select>
					<button class="command-button" onclick={addTerminalBlock}>
						<Plus class="size-4" /> Add terminal
					</button>
					<button class="danger-button" onclick={resetWorkspace}>
						<Trash2 class="size-4" /> Reset
					</button>
				</div>
			</div>

			<div class="grid h-[720px] gap-3 overflow-auto" style:grid-template-columns={gridTemplate}>
				{#each terminalBlocks as block (block.id)}
					<div
						class="grid min-h-[360px] min-w-[320px] grid-rows-[42px_1fr] overflow-hidden rounded-md border border-zinc-300 bg-white"
					>
						<div class="flex items-center gap-2 border-b border-zinc-200 px-2">
							<input class="h-7 w-32 text-xs" bind:value={block.label} placeholder="label" />
							<select class="h-7 min-w-0 flex-1 text-xs" bind:value={block.connectionId}>
								<option value="">Select SSH preset</option>
								{#each sshConnections as item (item.id)}
									<option value={item.id}>{item.name} / {connectionTarget(item.id)}</option>
								{/each}
							</select>
							<button
								class="icon-button h-7 w-7"
								title="Duplicate terminal"
								onclick={() => duplicateTerminalBlock(block)}
							>
								<Copy class="size-3" />
							</button>
							<button
								class="icon-button h-7 w-7"
								title="Remove terminal"
								onclick={() => removeTerminalBlock(block.id)}
							>
								<Trash2 class="size-3" />
							</button>
						</div>
						{#key `${block.id}:${block.connectionId}`}
							<TerminalPane
								{api}
								connectionId={block.connectionId}
								{wsBase}
								title={blockTitle(block)}
								{canOperate}
							/>
						{/key}
					</div>
				{/each}
			</div>
		</div>

		<div class="panel overflow-auto">
			<div class="mb-3 flex items-center justify-between gap-2">
				<div>
					<div class="panel-title mb-1">Active SSH Sessions</div>
					<div class="text-xs text-zinc-500">{sessions.length} tracked by API</div>
				</div>
				<button
					class="icon-button"
					title="Refresh sessions"
					onclick={refreshSessions}
					disabled={!canOperate || sessionsLoading}
				>
					<RefreshCw class="size-4 {sessionsLoading ? 'animate-spin' : ''}" />
				</button>
			</div>
			{#if sessionMessage}
				<div
					class="mb-3 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900"
				>
					{sessionMessage}
				</div>
			{/if}
			{#if killTarget}
				<div class="mb-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-900">
					<div class="font-semibold">Confirm session close</div>
					<div class="mt-1 break-all">{killTarget.target}</div>
					<div class="mt-1 break-all">id: {killTarget.id}</div>
					<input
						class="mt-2 w-full"
						bind:value={killConfirmation}
						placeholder="type session id to close"
					/>
					<div class="mt-2 flex gap-2">
						<button
							class="danger-button compact"
							onclick={closeSession}
							disabled={killConfirmation !== killTarget.id}
						>
							<Trash2 class="size-3" /> Close
						</button>
						<button
							class="command-button compact"
							onclick={() => {
								killSessionId = '';
								killConfirmation = '';
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			{/if}
			<div class="space-y-2">
				{#each sessions as session (session.id)}
					<div class="rounded border border-zinc-200 bg-white p-2 text-xs">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="truncate font-medium">
									{session.connectionName ?? session.connectionId}
								</div>
								<div class="mt-1 break-all text-zinc-500">{session.target}</div>
							</div>
							<span
								class="rounded px-2 py-0.5 uppercase {session.status === 'connected'
									? 'bg-emerald-50 text-emerald-700'
									: session.status === 'closing'
										? 'bg-red-50 text-red-700'
										: 'bg-amber-50 text-amber-700'}"
							>
								{session.status}
							</span>
						</div>
						<div class="mt-2 grid grid-cols-2 gap-1 text-zinc-500">
							<div>started {session.startedAt.slice(0, 19).replace('T', ' ')}</div>
							<div>active {session.lastActiveAt.slice(0, 19).replace('T', ' ')}</div>
							<div>{session.cols}x{session.rows}</div>
							<div class="truncate">{session.id}</div>
						</div>
						<button
							class="danger-button compact mt-2"
							onclick={() => prepareKillSession(session.id)}
							disabled={!canOperate}
						>
							<Trash2 class="size-3" /> Close session
						</button>
					</div>
				{/each}
				{#if sessions.length === 0}
					<div
						class="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500"
					>
						No active SSH sessions.
					</div>
				{/if}
			</div>
		</div>
	</div>
</section>
