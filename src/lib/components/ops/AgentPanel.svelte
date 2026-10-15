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

	function runStatusClass(status: AgentOpsRun['status']) {
		if (status === 'running') return 'text-signal';
		if (status === 'failed') return 'text-destructive';
		if (status === 'completed') return 'text-muted-foreground';
		return 'text-faint';
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

<section>
	<Card.Root class="gap-0 rounded-b-none pb-0">
		<Card.Header class="border-b pb-4">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div class="min-w-0">
					<Card.Title>AI Admin Worker</Card.Title>
					<Card.Description class="truncate"
						>{selectedSession?.name ?? 'Select or create a session'}</Card.Description
					>
				</div>
				<Button
					variant="outline"
					size="sm"
					class="self-start sm:self-auto"
					onclick={() => void loadWorkers()}
					disabled={loadingWorkers}
				>
					<RefreshCw class="size-4" /> Refresh
				</Button>
			</div>
		</Card.Header>
		<Card.Content class="p-0">
			<div
				class="grid min-h-[620px] grid-rows-[auto_minmax(0,1fr)] lg:h-[calc(100vh-11rem)] lg:grid-cols-[300px_1fr] lg:grid-rows-1"
			>
				<aside class="flex min-h-0 flex-col border-b border-border lg:border-r lg:border-b-0">
					<div class="space-y-3 border-b border-border p-4">
						<div class="eyebrow flex items-center gap-2">
							<Wifi class="size-3.5" /> Worker
						</div>
						<select
							class="field-select"
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
							<div class="flex items-center gap-2 font-mono text-[11px] text-faint">
								{#if selectedWorker.connected}
									<span
										class="size-1.5 shrink-0 rounded-full bg-signal shadow-[0_0_0_3px_rgb(212_255_63/0.18)]"
									></span>
								{/if}
								<span class="min-w-0 break-all">{workerMeta(selectedWorker)}</span>
							</div>
							<div class="rounded-md border border-border bg-card p-3 text-xs">
								<div class="eyebrow mb-1.5 flex items-center gap-2">
									<SquareTerminal class="size-3" /> Terminal
								</div>
								<div class="font-mono text-[11px] break-all text-muted-foreground">
									{terminalMeta(selectedWorker)}
								</div>
							</div>
						{/if}
						{#if workerError}
							<div class="text-xs text-destructive">{workerError}</div>
						{/if}
					</div>

					<div class="flex min-h-0 flex-1 flex-col">
						<div
							class="flex items-center justify-between gap-2 border-b border-border py-2 pr-2 pl-4"
						>
							<div class="eyebrow">Sessions</div>
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
						<div class="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 max-lg:max-h-64">
							{#each sessions as session (session.id)}
								<div
									class="grid grid-cols-[1fr_auto] items-center gap-1 rounded-md transition-colors {selectedSessionId ===
									session.id
										? 'bg-inverse text-on-inverse'
										: 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'}"
								>
									<button
										type="button"
										class="min-w-0 px-3 py-2 text-left text-sm"
										onclick={() => void selectSession(session.id)}
									>
										<div class="truncate font-medium">{session.name}</div>
										<div
											class="mt-1 font-mono text-[11px] {selectedSessionId === session.id
												? 'text-on-inverse/60'
												: 'text-faint'}"
										>
											{formatDate(session.updatedAt)}
										</div>
									</button>
									<Button
										variant="ghost"
										size="icon-sm"
										title="Delete session"
										class={selectedSessionId === session.id
											? 'mr-1 text-on-inverse/60 hover:bg-black/10 hover:text-on-inverse active:bg-black/15'
											: 'mr-1 text-faint'}
										onclick={(event) => handleDeleteSessionClick(event, session.id)}
										disabled={!canOperate || deletingSessionId === session.id}
									>
										<Trash2 class="size-4" />
									</Button>
								</div>
							{/each}
							{#if selectedWorkerId && !loadingSessions && sessions.length === 0}
								<div class="px-3 py-6 text-center text-xs text-faint">No sessions yet</div>
							{/if}
						</div>
						{#if sessionError}
							<div
								class="border-t border-danger-border bg-danger-surface px-4 py-2 text-xs text-destructive"
							>
								{sessionError}
							</div>
						{/if}
					</div>
				</aside>

				<div class="flex min-h-0 flex-col">
					<div bind:this={chatViewport} class="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
						{#if loadingRuns}
							<div class="text-sm text-faint">Loading...</div>
						{:else if !selectedSessionId}
							<div class="text-sm text-faint">Create a session to start.</div>
						{:else if runs.length === 0}
							<div class="text-sm text-faint">No messages yet.</div>
						{:else}
							{#each runs as item (item.id)}
								<div class="flex justify-end">
									<div
										class="max-w-[78%] rounded-lg border border-signal-border bg-outgoing px-4 py-3 text-sm text-foreground"
									>
										<div class="whitespace-pre-wrap">{item.goal}</div>
									</div>
								</div>
								<div class="flex justify-start">
									<div
										class="max-w-[82%] min-w-0 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-foreground"
									>
										<div class="eyebrow mb-2 {runStatusClass(item.status)}">{item.status}</div>
										<pre
											class="font-sans leading-6 whitespace-pre-wrap {item.error
												? 'text-destructive'
												: ''}">{runOutput(item)}</pre>
										{#if activityEvents(item).length}
											<div class="mt-3 space-y-1 border-t border-border pt-3 text-xs text-faint">
												{#each activityEvents(item) as event (`${item.id}-${event.at}-${event.message}`)}
													<div class="grid grid-cols-[56px_1fr] gap-2">
														<span
															class="font-mono text-[10.5px] font-bold tracking-[0.08em] uppercase"
															>{activityLabel(event.type)}</span
														>
														<span class="truncate font-mono text-[11px] text-muted-foreground"
															>{event.message}</span
														>
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
						class="border-t border-border p-4"
						onsubmit={(event) => {
							event.preventDefault();
							if (canSend) void runAgent();
						}}
					>
						<div
							class="flex items-end gap-2 rounded-lg border border-input bg-field p-2 pl-1 transition-colors focus-within:border-signal focus-within:ring-3 focus-within:ring-signal/15 hover:border-field-border-hover focus-within:hover:border-signal"
						>
							<Textarea
								class="max-h-40 min-h-16 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
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
