<script lang="ts">
	import { ChevronLeft, ChevronRight, RefreshCw } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import type { ApiClient } from '$lib/api/client';
	import type { AdminOverview, DbColumn, DbTableSummary } from '$lib/shared/ops-types';
	import type { RunTask } from './types';

	let {
		api,
		database,
		run
	}: {
		api: ApiClient;
		database: AdminOverview['database'];
		run: RunTask;
	} = $props();

	let tables = $state<DbTableSummary[]>([]);
	let tableName = $state('');
	let schema = $state<DbColumn[]>([]);
	let rows = $state<Record<string, unknown>[]>([]);
	let rowLimit = $state(100);
	let rowLimitValue = $state('100');
	let rowOffset = $state(0);

	let selectedTable = $derived(tables.find((table) => table.name === tableName));
	let displayFields = $derived(
		rows[0] ? Object.keys(rows[0]) : schema.map((column) => column.field)
	);
	let canPageBackward = $derived(rowOffset > 0);
	let canPageForward = $derived(rows.length >= rowLimit);

	async function loadTables() {
		await run(async () => {
			tables = await api.dbTables();
			if (!tables.some((table) => table.name === tableName)) tableName = tables[0]?.name ?? '';
			rowOffset = 0;
			if (tableName) await loadTable(true);
		});
	}

	async function loadTable(resetPage = false) {
		if (!tableName) return;
		if (resetPage) rowOffset = 0;
		await run(async () => {
			schema = await api.dbSchema(tableName);
			rows = await api.dbRows(tableName, Number(rowLimit), Number(rowOffset));
		});
	}

	function updateRowLimit(value: string) {
		rowLimitValue = value;
		rowLimit = Number(value);
		void loadTable(true);
	}

	function selectTable(name: string) {
		tableName = name;
		void loadTable(true);
	}

	function previousPage() {
		if (!canPageBackward) return;
		rowOffset = Math.max(0, rowOffset - Number(rowLimit));
		void loadTable();
	}

	function nextPage() {
		if (!canPageForward) return;
		rowOffset += Number(rowLimit);
		void loadTable();
	}

	$effect(() => {
		if (rowLimitValue !== String(rowLimit)) rowLimitValue = String(rowLimit);
	});

	function formatBytes(size: number) {
		if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
		return `${(size / 1024 / 1024).toFixed(1)} MB`;
	}

	onMount(() => {
		void loadTables();
	});
</script>

<section class="space-y-4">
	<div class="grid gap-4 lg:min-h-[640px] lg:grid-cols-[260px_1fr]">
		<Card.Root>
			<Card.Header>
				<div class="flex items-start justify-between gap-2">
					<div class="min-w-0">
						<Card.Title>Tables</Card.Title>
						<Card.Description class="truncate font-mono text-[12px]" title={database.path}
							>{database.path || 'SQLite'} · {formatBytes(database.sizeBytes)}</Card.Description
						>
					</div>
					<Badge variant="outline">read only</Badge>
				</div>
			</Card.Header>
			<Card.Content class="space-y-1 overflow-auto px-3 max-lg:max-h-80">
				{#each tables as table (table.name)}
					<Button
						variant={tableName === table.name ? 'active' : 'ghost'}
						class="w-full justify-between rounded-md px-3"
						onclick={() => selectTable(table.name)}
					>
						<span class="truncate">{table.name}</span>
						<span
							class="font-mono text-[11px] {tableName === table.name
								? 'text-on-inverse/60'
								: 'text-faint'}">{table.rows ?? 0}</span
						>
					</Button>
				{/each}
			</Card.Content>
		</Card.Root>

		<Card.Root class="min-w-0">
			<Card.Header>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="min-w-0">
						<Card.Title>Rows</Card.Title>
						<Card.Description class="font-mono text-[12px]">
							{tableName || 'No table selected'} / offset {rowOffset}
							{#if selectedTable}
								/ {selectedTable.rows} rows
							{/if}
						</Card.Description>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<Select.Root type="single" bind:value={rowLimitValue} onValueChange={updateRowLimit}>
							<Select.Trigger aria-label="Row page size" size="sm" class="w-[120px]"
								>{rowLimit} rows</Select.Trigger
							>
							<Select.Content>
								{#each [50, 100, 250, 500] as size (size)}
									<Select.Item value={String(size)}>{size} rows</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<Button variant="outline" size="sm" onclick={() => loadTable()}>
							<RefreshCw class="size-4" /> Reload
						</Button>
						<Button variant="outline" size="sm" onclick={previousPage} disabled={!canPageBackward}>
							<ChevronLeft class="size-4" /> Prev
						</Button>
						<Button variant="outline" size="sm" onclick={nextPage} disabled={!canPageForward}>
							Next <ChevronRight class="size-4" />
						</Button>
					</div>
				</div>
			</Card.Header>
			<Card.Content class="min-w-0 overflow-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							{#each displayFields as field (field)}
								<!-- Column names keep their case. -->
								<Table.Head class="tracking-[0.04em] normal-case">{field}</Table.Head>
							{/each}
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each rows as row, rowIndex (rowIndex)}
							<Table.Row>
								{#each displayFields as field (field)}
									<Table.Cell>{String(row[field] ?? '')}</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#if rows.length === 0}
					<div
						class="mt-4 rounded-md border border-dashed border-border-strong px-3 py-6 text-center text-sm text-faint"
					>
						No rows loaded for this table.
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</section>
