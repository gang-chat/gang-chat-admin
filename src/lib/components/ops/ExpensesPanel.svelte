<script lang="ts">
	import { onMount } from 'svelte';
	import { Pencil, Plus, Trash2, X } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import * as Table from '$lib/components/ui/table';
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
	<div class="mb-4 flex items-center gap-3">
		<Input class="w-44" type="month" bind:value={month} onchange={loadExpenses} />
		<Badge variant="secondary">
			Total {summary?.total ?? 0}
			{summary?.currency ?? 'CNY'}
		</Badge>
	</div>
	<div class="grid grid-cols-[360px_1fr] gap-4">
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<Card.Title>{editingId ? 'Edit Expense' : 'Manual Expense'}</Card.Title>
				{#if editingId}
					<Button variant="ghost" size="icon" title="Cancel edit" onclick={resetForm}>
						<X class="size-4" />
					</Button>
				{/if}
				</div>
			</Card.Header>
			<Card.Content class="space-y-2">
				<Input type="month" bind:value={form.month} />
				<Input bind:value={form.category} placeholder="category" />
				<Input bind:value={form.vendor} placeholder="vendor" />
				<Input type="number" bind:value={form.amount} placeholder="amount" />
				<Input bind:value={form.currency} placeholder="currency" />
				<Input bind:value={form.note} placeholder="note" />
				<Button class="mt-1" onclick={saveExpense} disabled={!canOperate}>
				<Plus class="size-4" />
				{editingId ? 'Update' : 'Save'}
				</Button>
			</Card.Content>
		</Card.Root>
		<Card.Root class="overflow-auto">
			<Card.Header>
				<div class="flex items-start justify-between gap-3">
					<Card.Title>Monthly Ledger</Card.Title>
				{#if deleteExpenseTarget}
					<div class="text-destructive w-80 rounded-lg border p-2 text-xs">
						<div class="font-semibold">Confirm expense delete</div>
						<div class="mt-1">
							{deleteExpenseTarget.month} / {deleteExpenseTarget.vendor} /
							{deleteExpenseTarget.amount}
							{deleteExpenseTarget.currency}
						</div>
						<div class="mt-1 break-all">id: {deleteExpenseTarget.id}</div>
						<Input
							class="mt-2"
							bind:value={deleteExpenseConfirmation}
							placeholder="type expense id to delete"
						/>
						<div class="mt-2 flex gap-2">
							<Button
								variant="destructive"
								size="sm"
								onclick={deleteExpense}
								disabled={!canOperate || deleteExpenseConfirmation !== deleteExpenseTarget.id}
							>
								<Trash2 class="size-3" /> Delete
							</Button>
							<Button
								variant="outline"
								size="sm"
								onclick={() => {
									deleteExpenseId = undefined;
									deleteExpenseConfirmation = '';
								}}
							>
								Cancel
							</Button>
						</div>
					</div>
				{/if}
				</div>
			</Card.Header>
			<Card.Content>
			<Table.Root>
				<Table.Header>
					<Table.Row><Table.Head>Month</Table.Head><Table.Head>Category</Table.Head><Table.Head>Vendor</Table.Head><Table.Head>Amount</Table.Head><Table.Head>Note</Table.Head><Table.Head></Table.Head></Table.Row>
				</Table.Header>
				<Table.Body>
					{#each expenses as item (item.id)}
						<Table.Row>
							<Table.Cell>{item.month}</Table.Cell>
							<Table.Cell>{item.category}</Table.Cell>
							<Table.Cell>{item.vendor}</Table.Cell>
							<Table.Cell>{item.amount} {item.currency}</Table.Cell>
							<Table.Cell>{item.note ?? ''}</Table.Cell>
							<Table.Cell class="text-right">
								<Button
									variant="ghost"
									size="icon-xs"
									onclick={() => editExpense(item)}
									disabled={!canOperate}
								>
									<Pencil class="size-3" />
								</Button>
								<Button
									variant="destructive"
									size="icon-xs"
									onclick={() => prepareDeleteExpense(item.id)}
									disabled={!canOperate}
								>
									<Trash2 class="size-3" />
								</Button>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			</Card.Content>
		</Card.Root>
	</div>
</section>
