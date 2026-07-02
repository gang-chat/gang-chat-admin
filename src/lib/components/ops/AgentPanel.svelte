<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { Bot, Plus, RefreshCw, SquareTerminal, Trash2, Wifi } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { ApiClient } from '$lib/api/client';
	import type {
		AgentOpsRun,
		AgentOpsSession,
		AgentWorkerStatus,
		AuthRole
	} from '$lib/shared/ops-types';
	import TerminalPane from './TerminalPane.svelte';
	import type { RunTask } from './types';

	let {
		api,
		currentRole,
		run,
		onAuditRefresh
	}: {
		api: ApiClient;
		currentRole?: AuthRole;
		run: RunTask;
		onAuditRefresh: () => Promise<void>;
	} = $props();

	let workers = $state<AgentWorkerStatus[]>([]);
	let sessions = $state<AgentOpsSession[]>([]);
	let runs = $state<AgentOpsRun[]>([]);
	let selectedWorkerId = $state('');
	let selectedSessionId = $state('');
	let draft = $state('');
	let activePollRunId = $state('');
	let deletingSessionId = $state('');
	let loadingWorkers = $state(false);
	let loadingSessions = $state(false);
	let loadingRuns = $state(false);
	let workerError = $state('');
	let sessionError = $state('');
	let chatViewport: HTMLDivElement | undefined;
	let sessionLoadToken = 0;
	let runLoadToken = 0;

	let canOperate = $derived(currentRole === 'operator' || currentRole === 'admin');
	let selectedWorker = $derived(workers.find((worker) => worker.id === selectedWorkerId));
	let selectedSession = $derived(sessions.find((session) => session.id === selectedSessionId));
	let canSend = $derived(
		canOperate && !!selectedWorkerId && !!selectedSessionId && !!draft.trim() && !activePollRunId
	);

	onMount(() => {
		void loadWorkers();
	});

	async function loadWorkers() {
		loadingWorkers = true;
		workerError = '';
		try {
			const allWorkers = await api.agentWorkers();
			workers = allWorkers.filter(
				(worker) => worker.transport === 'websocket' && worker.connected === true
			);
			const nextWorkerId = workers.some((worker) => worker.id === selectedWorkerId)
				? selectedWorkerId
				: (workers[0]?.id ?? '');
			selectedWorkerId = nextWorkerId;
			if (nextWorkerId) await loadSessions(nextWorkerId);
			else resetSessionState();
		} catch (error) {
			workerError = errorMessage(error);
		} finally {
			loadingWorkers = false;
		}
	}

	async function selectWorker() {
		if (!selectedWorkerId) {
			resetSessionState();
			return;
		}
		await loadSessions(selectedWorkerId);
	}

	async function loadSessions(workerId: string, preferredSessionId = selectedSessionId) {
		const loadToken = ++sessionLoadToken;
		loadingSessions = true;
		sessionError = '';
		try {
			const nextSessions = await api.agentSessions(workerId);
			if (loadToken !== sessionLoadToken) return;
			sessions = nextSessions;
			const nextSessionId = sessions.some((session) => session.id === preferredSessionId)
				? preferredSessionId
				: (sessions[0]?.id ?? '');
			selectedSessionId = nextSessionId;
			if (nextSessionId) await loadSessionRuns(workerId, nextSessionId);
			else runs = [];
		} catch (error) {
			if (loadToken === sessionLoadToken) sessionError = errorMessage(error);
		} finally {
			if (loadToken === sessionLoadToken) loadingSessions = false;
		}
	}

	async function loadSessionRuns(workerId = selectedWorkerId, sessionId = selectedSessionId) {
		if (!workerId || !sessionId) {
			runs = [];
			return;
		}
		const loadToken = ++runLoadToken;
		loadingRuns = true;
		sessionError = '';
		try {
			const nextRuns = await api.agentSessionRuns(workerId, sessionId);
			if (loadToken !== runLoadToken) return;
			runs = nextRuns;
			await scrollChatToBottom();
		} catch (error) {
			if (loadToken === runLoadToken) sessionError = errorMessage(error);
		} finally {
			if (loadToken === runLoadToken) loadingRuns = false;
		}
	}

	async function createSession() {
		if (!selectedWorkerId) return;
		const emptySession = sessions.find((session) => !session.lastRunId);
		if (emptySession) {
			await selectSession(emptySession.id);
			return;
		}
		await run(async () => {
			const workerId = selectedWorkerId;
			const session = await api.createAgentSession(workerId, {});
			await loadSessions(workerId, session.id);
		}, 'Agent session created');
	}

	async function deleteSession(sessionId: string) {
		if (!selectedWorkerId || deletingSessionId) return;
		const workerId = selectedWorkerId;
		const remaining = sessions.filter((session) => session.id !== sessionId);
		const nextSessionId =
			selectedSessionId === sessionId ? (remaining[0]?.id ?? '') : selectedSessionId;
		deletingSessionId = sessionId;
		sessionError = '';
		try {
			await api.deleteAgentSession(workerId, sessionId);
			if (selectedWorkerId !== workerId) return;
			sessions = remaining;
			if (selectedSessionId === sessionId) {
				selectedSessionId = nextSessionId;
				if (!nextSessionId) runs = [];
			}
			await loadSessions(workerId, nextSessionId);
			await onAuditRefresh();
		} catch (error) {
			sessionError = errorMessage(error);
		} finally {
			if (deletingSessionId === sessionId) deletingSessionId = '';
		}
	}

	function handleDeleteSessionClick(event: MouseEvent, sessionId: string) {
		event.stopPropagation();
		void deleteSession(sessionId);
	}

	async function selectSession(sessionId: string) {
		selectedSessionId = sessionId;
		await loadSessionRuns(selectedWorkerId, sessionId);
	}

	async function runAgent() {
		if (!selectedWorkerId || !selectedSessionId || !draft.trim()) return;
		await run(async () => {
			const workerId = selectedWorkerId;
			const sessionId = selectedSessionId;
			const goal = draft.trim();
			draft = '';
			const created = await api.agentRun({ workerId, sessionId, goal });
			if (selectedWorkerId === workerId && selectedSessionId === sessionId) {
				runs = upsertRun(runs, created);
				await scrollChatToBottom();
			}
			await loadSessions(workerId, sessionId);
			await pollRun(created.id, workerId, sessionId);
			if (selectedWorkerId === workerId) await loadSessions(workerId, sessionId);
			await onAuditRefresh();
		}, 'AI admin worker run finished');
	}

	async function pollRun(id: string, workerId: string, sessionId: string) {
		activePollRunId = id;
		while (activePollRunId === id) {
			await sleep(800);
			const next = await api.agentRunStatus(id);
			if (selectedWorkerId === workerId && selectedSessionId === sessionId) {
				runs = upsertRun(runs, next);
				await scrollChatToBottom();
			}
			if (next.status === 'completed' || next.status === 'failed') break;
		}
		if (activePollRunId === id) activePollRunId = '';
	}

	function handleComposerKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		if (canSend) void runAgent();
	}

	function resetSessionState() {
		sessions = [];
		runs = [];
		selectedSessionId = '';
	}

	function upsertRun(items: AgentOpsRun[], next: AgentOpsRun) {
		const index = items.findIndex((item) => item.id === next.id);
		if (index === -1)
			return [...items, next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return items.map((item, itemIndex) => (itemIndex === index ? next : item));
	}

	async function scrollChatToBottom() {
		await tick();
		chatViewport?.scrollTo({ top: chatViewport.scrollHeight });
	}

	function sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function workerMeta(worker: AgentWorkerStatus) {
		const parts = [worker.connected ? 'connected' : 'offline'];
		if (worker.hostname) parts.push(worker.hostname);
		if (worker.execute) parts.push('execute');
		if (worker.version) parts.push(worker.version);
		return parts.join(' / ');
	}

	function terminalMeta(worker: AgentWorkerStatus) {
		const terminal = worker.terminal;
		if (!terminal?.available) return 'terminal unavailable';
		const parts = [];
		if (terminal.username) parts.push(terminal.username);
		if (terminal.shell) parts.push(terminal.shell);
		if (terminal.cwd) parts.push(terminal.cwd);
		return parts.join(' / ') || 'terminal ready';
	}

	function formatDate(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	}

	function runOutput(run: AgentOpsRun) {
		if (run.result) return run.result;
		if (run.error) return run.error;
		if (run.status === 'queued') return 'Queued...';
		if (run.status === 'running') return 'Running...';
		return '';
	}

	function activityEvents(run: AgentOpsRun) {
		return run.events.filter((event) => event.type === 'tool' || event.type === 'compact');
	}

	function activityLabel(type: string) {
		return type === 'compact' ? 'compact' : 'tool';
	}

	function errorMessage(error: unknown) {
		if (error instanceof Error) return error.message;
		return typeof error === 'string' ? error : 'Request failed';
	}

	onDestroy(() => {
		activePollRunId = '';
		deletingSessionId = '';
	});
</script>

<section class="workspace">
	<Card.Root class="rounded-b-none">
		<Card.Header>
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<Card.Title>AI Admin Worker</Card.Title>
					<Card.Description
						>{selectedSession?.name ?? 'Select or create a session'}</Card.Description
					>
				</div>
				<Button
					variant="outline"
					size="sm"
					onclick={() => void loadWorkers()}
					disabled={loadingWorkers}
				>
					<RefreshCw class="size-4" /> Refresh
				</Button>
			</div>
		</Card.Header>
		<Card.Content class="p-0">
			<div class="grid h-[calc(100vh-11rem)] min-h-[620px] lg:grid-cols-[300px_1fr]">
				<aside class="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
					<div class="space-y-2 border-b border-zinc-200 p-4 dark:border-zinc-800">
						<div class="flex items-center gap-2 text-sm font-medium">
							<Wifi class="size-4" /> Worker
						</div>
						<select
							class="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 shadow-sm outline-none focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
							bind:value={selectedWorkerId}
							onchange={() => void selectWorker()}
							disabled={!workers.length || loadingWorkers}
						>
							{#if workers.length === 0}
								<option value="">No worker connected</option>
							{:else}
								{#each workers as worker (worker.id)}
									<option value={worker.id}>{worker.id}</option>
								{/each}
							{/if}
						</select>
						{#if selectedWorker}
							<div class="text-xs text-zinc-500">{workerMeta(selectedWorker)}</div>
							<div
								class="rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
							>
								<div class="mb-1 flex items-center gap-2 font-medium">
									<SquareTerminal class="size-3" /> Terminal
								</div>
								<div class="break-all text-zinc-500">{terminalMeta(selectedWorker)}</div>
							</div>
						{/if}
						{#if workerError}
							<div class="text-xs text-red-600">{workerError}</div>
						{/if}
					</div>

					<div class="flex min-h-0 flex-1 flex-col">
						<div
							class="flex items-center justify-between gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800"
						>
							<div class="text-sm font-medium">Sessions</div>
							<Button
								variant="ghost"
								size="icon-sm"
								title="New session"
								onclick={createSession}
								disabled={!canOperate || !selectedWorkerId}
							>
								<Plus class="size-4" />
							</Button>
						</div>
						<div class="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
							{#each sessions as session (session.id)}
								<div
									class="grid grid-cols-[1fr_auto] items-center gap-1 rounded-md transition {selectedSessionId ===
									session.id
										? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950'
										: 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'}"
								>
									<button
										type="button"
										class="min-w-0 px-3 py-2 text-left text-sm"
										onclick={() => void selectSession(session.id)}
									>
										<div class="truncate font-medium">{session.name}</div>
										<div
											class="mt-1 text-xs {selectedSessionId === session.id
												? 'text-zinc-300 dark:text-zinc-600'
												: 'text-zinc-500'}"
										>
											{formatDate(session.updatedAt)}
										</div>
									</button>
									<Button
										variant="ghost"
										size="icon-sm"
										title="Delete session"
										class={selectedSessionId === session.id
											? 'mr-1 text-zinc-300 hover:bg-zinc-800 hover:text-white dark:text-zinc-600 dark:hover:bg-zinc-200 dark:hover:text-zinc-950'
											: 'mr-1 text-zinc-500'}
										onclick={(event) => handleDeleteSessionClick(event, session.id)}
										disabled={!canOperate || deletingSessionId === session.id}
									>
										<Trash2 class="size-4" />
									</Button>
								</div>
							{/each}
							{#if selectedWorkerId && !loadingSessions && sessions.length === 0}
								<div class="px-3 py-6 text-center text-xs text-zinc-500">No sessions yet</div>
							{/if}
						</div>
						{#if sessionError}
							<div class="border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
								{sessionError}
							</div>
						{/if}
					</div>
				</aside>

				<div class="flex min-h-0 flex-col">
					<div bind:this={chatViewport} class="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
						{#if loadingRuns}
							<div class="text-sm text-zinc-500">Loading...</div>
						{:else if !selectedSessionId}
							<div class="text-sm text-zinc-500">Create a session to start.</div>
						{:else if runs.length === 0}
							<div class="text-sm text-zinc-500">No messages yet.</div>
						{:else}
							{#each runs as item (item.id)}
								<div class="flex justify-end">
									<div
										class="max-w-[78%] rounded-lg bg-zinc-900 px-4 py-3 text-sm text-white dark:bg-zinc-100 dark:text-zinc-950"
									>
										<div class="whitespace-pre-wrap">{item.goal}</div>
									</div>
								</div>
								<div class="flex justify-start">
									<div
										class="max-w-[82%] rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
									>
										<div class="mb-2 text-xs uppercase text-zinc-500">{item.status}</div>
										<pre
											class="whitespace-pre-wrap font-sans leading-6 {item.error
												? 'text-red-700 dark:text-red-300'
												: ''}">{runOutput(item)}</pre>
										{#if activityEvents(item).length}
											<div
												class="mt-3 space-y-1 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-zinc-800"
											>
												{#each activityEvents(item) as event (`${item.id}-${event.at}-${event.message}`)}
													<div class="grid grid-cols-[56px_1fr] gap-2">
														<span class="uppercase">{activityLabel(event.type)}</span>
														<span class="truncate">{event.message}</span>
													</div>
												{/each}
											</div>
										{/if}
									</div>
								</div>
							{/each}
						{/if}
					</div>

					<form
						class="border-t border-zinc-200 p-4 dark:border-zinc-800"
						onsubmit={(event) => {
							event.preventDefault();
							if (canSend) void runAgent();
						}}
					>
						<div
							class="flex items-end gap-2 rounded-lg border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
						>
							<Textarea
								class="max-h-40 min-h-16 resize-none border-0 shadow-none focus-visible:ring-0"
								bind:value={draft}
								placeholder="Message the worker"
								onkeydown={handleComposerKeydown}
								disabled={!selectedSessionId}
							/>
							<Button type="submit" size="icon" title="Send" disabled={!canSend}>
								<Bot class="size-4" />
							</Button>
						</div>
					</form>
				</div>
			</div>
		</Card.Content>
	</Card.Root>

	<div class="-mt-px h-80">
		<TerminalPane
			{api}
			workerId={selectedWorkerId || undefined}
			title={selectedWorker ? `Terminal / ${selectedWorker.id}` : 'Worker terminal'}
			canOperate={canOperate && !!selectedWorker?.terminal?.available}
			attachedTop
		/>
	</div>
</section>
