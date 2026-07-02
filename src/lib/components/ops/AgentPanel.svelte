<script lang="ts">
	import { Bot, Check, Plus, RefreshCw, Trash2, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { ApiClient } from '$lib/api/client';
	import type {
		AgentCommand,
		AgentJob,
		AgentJobStatus,
		AgentWorkerStatus,
		AuthRole
	} from '$lib/shared/ops-types';
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

	type StatusFilter = 'all' | AgentJobStatus;

	let goal = $state('');
	let context = $state('');
	let jobs = $state<AgentJob[]>([]);
	let workers = $state<AgentWorkerStatus[]>([]);
	let selectedJobId = $state('');
	let commandDraftJobId = $state('');
	let commandDrafts = $state<AgentCommand[]>([]);
	let statusFilter = $state<StatusFilter>('all');
	let operatorNote = $state('');
	let selectedJob = $derived(jobs.find((job) => job.id === selectedJobId) ?? jobs[0]);
	let canOperate = $derived(currentRole === 'operator' || currentRole === 'admin');
	let commandDraftError = $derived(validateCommandDrafts(commandDrafts));
	let canApprove = $derived(
		Boolean(
			canOperate &&
			selectedJob &&
			selectedJob.status === 'suggested' &&
			commandDraftJobId === selectedJob.id &&
			!commandDraftError
		)
	);

	onMount(() => {
		void loadJobs();
		void loadWorkers();
	});

	async function suggestAgent() {
		await run(async () => {
			const job = await api.agentSuggest(goal, context);
			selectedJobId = job.id;
			goal = '';
			context = '';
			await loadJobs();
			await loadWorkers();
			await onAuditRefresh();
		}, 'Agent job created');
	}

	async function loadJobs() {
		await run(async () => {
			jobs = await api.agentJobs(statusFilter === 'all' ? undefined : statusFilter);
			if (selectedJobId && !jobs.some((job) => job.id === selectedJobId)) selectedJobId = '';
			if (!selectedJobId && jobs[0]) selectJob(jobs[0]);
			else if (selectedJob && commandDraftJobId !== selectedJob.id) resetCommandDrafts(selectedJob);
		});
	}

	async function approveJob() {
		if (!selectedJob) return;
		await run(async () => {
			const job = await api.approveAgentJob(selectedJob.id, operatorNote, commandDrafts);
			selectedJobId = job.id;
			operatorNote = '';
			await loadJobs();
			await loadWorkers();
			await onAuditRefresh();
		}, 'Agent job approved');
	}

	async function rejectJob() {
		if (!selectedJob) return;
		await run(async () => {
			const job = await api.rejectAgentJob(selectedJob.id, operatorNote);
			selectedJobId = job.id;
			operatorNote = '';
			await loadJobs();
			await loadWorkers();
			await onAuditRefresh();
		}, 'Agent job rejected');
	}

	async function loadWorkers() {
		if (!canOperate) {
			workers = [];
			return;
		}
		await run(async () => {
			workers = await api.agentWorkers();
		});
	}

	function selectJob(job: AgentJob) {
		selectedJobId = job.id;
		resetCommandDrafts(job);
	}

	function resetCommandDrafts(job: AgentJob) {
		commandDraftJobId = job.id;
		commandDrafts = job.commands.map((command) => ({ ...command }));
	}

	function addCommandDraft() {
		commandDrafts = [
			...commandDrafts,
			{ label: 'New command', command: '', requiresApproval: true }
		];
	}

	function removeCommandDraft(index: number) {
		commandDrafts = commandDrafts.filter((_, itemIndex) => itemIndex !== index);
	}

	function validateCommandDrafts(commands: AgentCommand[]) {
		if (commands.length === 0) return 'At least one command is required for approval.';
		if (commands.length > 50) return 'No more than 50 commands can be approved.';
		for (const [index, command] of commands.entries()) {
			if (!command.label.trim()) return `Command ${index + 1} needs a label.`;
			if (command.label.length > 200) return `Command ${index + 1} label is too long.`;
			if (!command.command.trim()) return `Command ${index + 1} is empty.`;
			if (command.command.length > 20_000) return `Command ${index + 1} is too long.`;
		}
		return '';
	}

	function workerFresh(worker: AgentWorkerStatus) {
		return Date.now() - Date.parse(worker.lastSeenAt) < 30_000;
	}

	function relativeSeconds(value: string) {
		const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
		return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
	}
</script>

<section class="workspace">
	<div class="grid grid-cols-[380px_1fr] gap-4">
		<div class="panel">
			<div class="panel-title">Pi Agent Gateway</div>
			<input bind:value={goal} placeholder="operation goal" />
			<textarea class="mt-2 h-40" bind:value={context} placeholder="host/service context"
			></textarea>
			<button
				class="command-button mt-3"
				onclick={suggestAgent}
				disabled={!canOperate || !goal.trim()}
			>
				<Bot class="size-4" /> Create suggestion job
			</button>

			<div class="mt-6 border-t border-zinc-200 pt-4">
				<div class="panel-title">Jobs</div>
				<div class="mb-2 grid grid-cols-[1fr_auto] gap-2">
					<select bind:value={statusFilter} onchange={loadJobs}>
						<option value="all">All jobs</option>
						<option value="suggested">Suggested</option>
						<option value="approved">Approved</option>
						<option value="rejected">Rejected</option>
					</select>
					<button
						class="icon-button"
						title="Refresh jobs"
						onclick={() => {
							void loadJobs();
							void loadWorkers();
						}}
					>
						<RefreshCw class="size-4" />
					</button>
				</div>
				<div class="space-y-1">
					{#each jobs as job (job.id)}
						<button
							class="list-row {selectedJob?.id === job.id ? 'active' : ''}"
							onclick={() => selectJob(job)}
						>
							<span class="truncate">{job.goal}</span>
							<span>{job.executionStatus ?? job.status}</span>
						</button>
					{/each}
					{#if jobs.length === 0}
						<div
							class="rounded border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500"
						>
							No agent jobs match the filter.
						</div>
					{/if}
				</div>
			</div>

			<div class="mt-6 border-t border-zinc-200 pt-4">
				<div class="panel-title">Workers</div>
				<div class="space-y-1">
					{#each workers as worker (worker.id)}
						<div class="rounded border border-zinc-200 bg-white px-2 py-2 text-xs">
							<div class="flex items-center justify-between gap-2">
								<div class="font-medium">{worker.id}</div>
								<span class={workerFresh(worker) ? 'text-emerald-700' : 'text-amber-700'}>
									{workerFresh(worker) ? 'online' : 'stale'}
								</span>
							</div>
							<div class="mt-1 text-zinc-500">
								{worker.hostname ?? 'unknown host'} · {relativeSeconds(worker.lastSeenAt)}
							</div>
							<div class="mt-1 truncate text-zinc-500">
								{worker.execute ? 'execute' : 'dry-run'} ·
								{worker.allowedCommands.length ? worker.allowedCommands.join(', ') : 'no allowlist'}
							</div>
							{#if worker.currentJobId}
								<div class="mt-1 truncate text-cyan-700">job: {worker.currentJobId}</div>
							{/if}
						</div>
					{/each}
					{#if canOperate && workers.length === 0}
						<div
							class="rounded border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500"
						>
							No workers have checked in.
						</div>
					{/if}
				</div>
			</div>
		</div>

		<div class="panel overflow-auto">
			<div class="panel-title">Approval Queue</div>
			{#if selectedJob}
				<div class="flex items-start justify-between gap-3">
					<div>
						<div class="text-sm font-medium">{selectedJob.summary}</div>
						<div class="mt-2 flex gap-2 text-xs uppercase text-zinc-500">
							<span>Risk: {selectedJob.risk}</span>
							<span>Status: {selectedJob.status}</span>
							{#if selectedJob.executionStatus}
								<span>Execution: {selectedJob.executionStatus}</span>
							{/if}
							<span>Created: {selectedJob.createdAt.slice(0, 19).replace('T', ' ')}</span>
						</div>
					</div>
					<span
						class="rounded px-2 py-1 text-xs {selectedJob.executionStatus === 'completed'
							? 'bg-emerald-50 text-emerald-700'
							: selectedJob.executionStatus === 'failed' || selectedJob.status === 'rejected'
								? 'bg-red-50 text-red-700'
								: selectedJob.executionStatus === 'running'
									? 'bg-cyan-50 text-cyan-700'
									: 'bg-amber-50 text-amber-700'}"
					>
						{selectedJob.executionStatus ?? selectedJob.status}
					</span>
				</div>

				<div class="mt-4 space-y-2">
					{#if selectedJob.status === 'suggested'}
						<div class="flex items-center justify-between gap-2">
							<div class="panel-title">Commands For Approval</div>
							<button class="command-button compact" onclick={addCommandDraft}>
								<Plus class="size-4" /> Add
							</button>
						</div>
					{/if}
					{#each selectedJob.status === 'suggested' ? commandDrafts : selectedJob.commands as command, index (`${selectedJob.id}-${index}`)}
						<div class="rounded-md border border-zinc-200 bg-zinc-50 p-3">
							<div class="flex items-center justify-between gap-2">
								{#if selectedJob.status === 'suggested'}
									<input
										class="min-w-0 flex-1"
										bind:value={command.label}
										placeholder="command label"
									/>
									<label class="checkline text-xs">
										<input type="checkbox" bind:checked={command.requiresApproval} />
										approval required
									</label>
									<button
										class="danger-button compact"
										onclick={() => removeCommandDraft(index)}
										disabled={commandDrafts.length <= 1}
										title="Remove command"
									>
										<Trash2 class="size-3" />
									</button>
								{:else}
									<div class="text-sm font-medium">{command.label}</div>
									<div class="text-xs text-zinc-500">
										{command.requiresApproval ? 'approval required' : 'read-only'}
									</div>
								{/if}
							</div>
							{#if selectedJob.status === 'suggested'}
								<textarea
									class="mt-2 min-h-20 w-full font-mono text-xs"
									bind:value={command.command}
									placeholder="command to run on the worker"></textarea>
							{:else}
								<pre
									class="mt-2 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-100">{command.command}</pre>
							{/if}
						</div>
					{/each}
					{#if selectedJob.status === 'suggested' && commandDraftError}
						<div class="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900">
							{commandDraftError}
						</div>
					{/if}
				</div>

				<div class="mt-4 rounded border border-zinc-200 bg-white p-3">
					<div class="panel-title">Operator Decision</div>
					<textarea
						class="h-20 w-full"
						bind:value={operatorNote}
						placeholder="operator note for audit and worker queue"></textarea>
					<div class="mt-2 flex gap-2">
						<button class="command-button" onclick={approveJob} disabled={!canApprove}>
							<Check class="size-4" /> Approve
						</button>
						<button
							class="danger-button"
							onclick={rejectJob}
							disabled={!canOperate || selectedJob.status !== 'suggested'}
						>
							<X class="size-4" /> Reject
						</button>
					</div>
				</div>

				<div class="mt-4 space-y-1 text-xs text-zinc-600">
					{#each selectedJob.notes as note (note)}
						<div class="rounded border border-zinc-200 px-2 py-1">{note}</div>
					{/each}
					{#if selectedJob.operatorNote}
						<div class="rounded border border-cyan-200 bg-cyan-50 px-2 py-1 text-cyan-900">
							operator note: {selectedJob.operatorNote}
						</div>
					{/if}
					{#if selectedJob.workerId}
						<div class="rounded border border-zinc-200 px-2 py-1">
							worker: {selectedJob.workerId}
						</div>
					{/if}
					{#if selectedJob.result}
						<div class="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-900">
							result: {selectedJob.result}
						</div>
					{/if}
					{#if selectedJob.error}
						<div class="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-900">
							error: {selectedJob.error}
						</div>
					{/if}
				</div>
				{#if selectedJob.commandResults?.length}
					<div class="mt-4 space-y-2">
						<div class="panel-title">Worker Command Results</div>
						{#each selectedJob.commandResults as result, index (`${result.command}-${index}`)}
							<div class="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs">
								<div class="flex items-center justify-between gap-2">
									<div class="font-medium">{result.label ?? 'Command'}</div>
									<div class={result.exitCode === 0 ? 'text-emerald-700' : 'text-red-700'}>
										exit: {result.exitCode ?? 'unknown'}
									</div>
								</div>
								<pre
									class="mt-2 overflow-auto rounded bg-zinc-950 p-2 text-zinc-100">{result.command}</pre>
								{#if result.stdout}
									<pre
										class="mt-2 max-h-40 overflow-auto rounded border border-zinc-200 bg-white p-2 text-zinc-700">{result.stdout}</pre>
								{/if}
								{#if result.stderr}
									<pre
										class="mt-2 max-h-40 overflow-auto rounded border border-red-200 bg-red-50 p-2 text-red-800">{result.stderr}</pre>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{:else}
				<div class="text-sm text-zinc-500">
					Agent execution is approval-gated. Approved jobs are exposed through the separate Pi
					worker API, and this panel does not execute commands.
				</div>
			{/if}
		</div>
	</div>
</section>
