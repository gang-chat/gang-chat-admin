<script lang="ts">
	import { onMount } from 'svelte';
	import { Pencil, Plus, Trash2, X } from '@lucide/svelte';
	import type { ApiClient } from '$lib/api/client';
	import type { AuthRole, ExpenseEntry, ExpenseInput, ExpenseSummary } from '$lib/shared/ops-types';
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

	const currentMonth = new Date().toISOString().slice(0, 7);

	let month = $state(currentMonth);
	let expenses = $state<ExpenseEntry[]>([]);
	let summary = $state<ExpenseSummary | undefined>();
	let editingId = $state<string | undefined>();
	let form = $state<ExpenseInput>(blankForm());
	let deleteExpenseId = $state<string | undefined>();
	let deleteExpenseConfirmation = $state('');
	let deleteExpenseTarget = $derived(expenses.find((item) => item.id === deleteExpenseId));
	let canOperate = $derived(currentRole === 'operator' || currentRole === 'admin');

	function blankForm(): ExpenseInput {
		return {
			month: currentMonth,
			category: 'server',
			vendor: '',
			amount: 0,
			currency: 'CNY',
			note: ''
		};
	}

	onMount(() => {
		void loadExpenses();
	});

	async function loadExpenses() {
		await run(async () => {
			expenses = await api.expenses(month);
			summary = await api.expenseSummary(month);
		});
	}

	async function saveExpense() {
		await run(
			async () => {
				if (editingId) await api.updateExpense(editingId, form);
				else await api.createExpense(form);
				month = form.month;
				await loadExpenses();
				await onAuditRefresh();
				resetForm();
			},
			editingId ? 'Expense updated' : 'Expense saved'
		);
	}

	function editExpense(entry: ExpenseEntry) {
		editingId = entry.id;
		form = {
			month: entry.month,
			category: entry.category,
			vendor: entry.vendor,
			amount: entry.amount,
			currency: entry.currency,
			note: entry.note ?? ''
		};
	}

	function resetForm() {
		editingId = undefined;
		form = { ...blankForm(), month };
	}

	function prepareDeleteExpense(id: string) {
		deleteExpenseId = id;
		deleteExpenseConfirmation = '';
	}

	async function deleteExpense() {
		if (!deleteExpenseId || deleteExpenseConfirmation !== deleteExpenseId) return;
		const id = deleteExpenseId;
		await run(async () => {
			await api.deleteExpense(id, deleteExpenseConfirmation);
			await loadExpenses();
			await onAuditRefresh();
			deleteExpenseId = undefined;
			deleteExpenseConfirmation = '';
		}, 'Expense deleted');
	}
</script>

<section class="workspace">
	<div class="toolbar">
		<input type="month" bind:value={month} onchange={loadExpenses} />
		<div class="text-sm font-medium">
			Total {summary?.total ?? 0}
			{summary?.currency ?? 'CNY'}
		</div>
	</div>
	<div class="grid grid-cols-[360px_1fr] gap-4">
		<div class="panel">
			<div class="flex items-center justify-between">
				<div class="panel-title">{editingId ? 'Edit Expense' : 'Manual Expense'}</div>
				{#if editingId}
					<button class="icon-button" title="Cancel edit" onclick={resetForm}>
						<X class="size-4" />
					</button>
				{/if}
			</div>
			<div class="form-grid">
				<input type="month" bind:value={form.month} />
				<input bind:value={form.category} placeholder="category" />
				<input bind:value={form.vendor} placeholder="vendor" />
				<input type="number" bind:value={form.amount} placeholder="amount" />
				<input bind:value={form.currency} placeholder="currency" />
				<input bind:value={form.note} placeholder="note" />
			</div>
			<button class="command-button mt-3" onclick={saveExpense} disabled={!canOperate}>
				<Plus class="size-4" />
				{editingId ? 'Update' : 'Save'}
			</button>
		</div>
		<div class="panel overflow-auto">
			<div class="flex items-start justify-between gap-3">
				<div class="panel-title">Monthly Ledger</div>
				{#if deleteExpenseTarget}
					<div class="w-80 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-950">
						<div class="font-semibold">Confirm expense delete</div>
						<div class="mt-1">
							{deleteExpenseTarget.month} / {deleteExpenseTarget.vendor} /
							{deleteExpenseTarget.amount}
							{deleteExpenseTarget.currency}
						</div>
						<div class="mt-1 break-all">id: {deleteExpenseTarget.id}</div>
						<input
							class="mt-2 w-full rounded border-red-200 text-xs"
							bind:value={deleteExpenseConfirmation}
							placeholder="type expense id to delete"
						/>
						<div class="mt-2 flex gap-2">
							<button
								class="danger-button compact"
								onclick={deleteExpense}
								disabled={!canOperate || deleteExpenseConfirmation !== deleteExpenseTarget.id}
							>
								<Trash2 class="size-3" /> Delete
							</button>
							<button
								class="command-button compact"
								onclick={() => {
									deleteExpenseId = undefined;
									deleteExpenseConfirmation = '';
								}}
							>
								Cancel
							</button>
						</div>
					</div>
				{/if}
			</div>
			<table class="data-table">
				<thead
					><tr
						><th>Month</th><th>Category</th><th>Vendor</th><th>Amount</th><th>Note</th><th></th></tr
					></thead
				>
				<tbody>
					{#each expenses as item (item.id)}
						<tr>
							<td>{item.month}</td>
							<td>{item.category}</td>
							<td>{item.vendor}</td>
							<td>{item.amount} {item.currency}</td>
							<td>{item.note ?? ''}</td>
							<td class="text-right">
								<button
									class="command-button compact"
									onclick={() => editExpense(item)}
									disabled={!canOperate}
								>
									<Pencil class="size-3" />
								</button>
								<button
									class="danger-button compact"
									onclick={() => prepareDeleteExpense(item.id)}
									disabled={!canOperate}
								>
									<Trash2 class="size-3" />
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>
