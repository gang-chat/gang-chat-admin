<script lang="ts">
	import { ChevronLeft, ChevronRight, RefreshCw } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import type { ApiClient } from '$lib/api/client';
	import type { ConnectionPreset, MysqlColumn, MysqlTableSummary } from '$lib/shared/ops-types';
	import type { RunTask } from './types';

	let {
		api,
		mysqlConnections,
		run
	}: {
		api: ApiClient;
		mysqlConnections: ConnectionPreset[];
		run: RunTask;
	} = $props();

	let connectionId = $state('');
	let tables = $state<MysqlTableSummary[]>([]);
	let tableName = $state('');
	let schema = $state<MysqlColumn[]>([]);
	let rows = $state<Record<string, unknown>[]>([]);
	let rowLimit = $state(100);
	let rowLimitValue = $state('100');
	let rowOffset = $state(0);

	let selectedTable = $derived(tables.find((table) => table.name === tableName));
	let selectedConnection = $derived(
		mysqlConnections.find((item) => item.id === connectionId && item.type === 'mysql')
	);
	let mutationsAllowed = $derived(
		Boolean(
			selectedConnection?.config &&
				'allowMutations' in selectedConnection.config &&
				selectedConnection.config.allowMutations
		)
	);
	let displayFields = $derived(
		rows[0] ? Object.keys(rows[0]) : schema.map((column) => column.field)
	);
	let canPageBackward = $derived(rowOffset > 0);
	let canPageForward = $derived(rows.length >= rowLimit);

	async function loadTables() {
		if (!connectionId) return;
		await run(async () => {
			tables = await api.mysqlTables(connectionId);
			tableName = tables[0]?.name ?? '';
			rowOffset = 0;
			if (tableName) await loadTable(true);
		});
	}

	async function loadTable(resetPage = false) {
		if (!connectionId || !tableName) return;
		if (resetPage) rowOffset = 0;
		await run(async () => {
			schema = await api.mysqlSchema(connectionId, tableName);
			rows = await api.mysqlRows(connectionId, tableName, Number(rowLimit), Number(rowOffset));
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

	$effect(() => {
		const configuredId = mysqlConnections[0]?.id ?? '';
		if (configuredId && connectionId !== configuredId) {
			connectionId = configuredId;
			void loadTables();
		}
	});
</script>

<section class="workspace space-y-4">
	{#if !connectionId}
		<Card.Root>
			<Card.Content class="text-muted-foreground text-sm">
				<div class="text-foreground font-medium">No MySQL connection configured</div>
				<div class="mt-1">
					This is a preview shell. Add <code>connections.mysql</code> in config.json and restart to enable data operations.
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="grid min-h-[640px] grid-cols-[260px_1fr] gap-4">
		<Card.Root>
			<Card.Header>
				<div class="flex items-start justify-between gap-2">
					<div>
						<Card.Title>Tables</Card.Title>
						<Card.Description>{selectedConnection?.name ?? 'MySQL not configured'}</Card.Description>
					</div>
					{#if selectedConnection}
						<Badge variant={mutationsAllowed ? 'secondary' : 'outline'}>
							{mutationsAllowed ? 'writes' : 'read only'}
						</Badge>
					{/if}
				</div>
			</Card.Header>
			<Card.Content class="space-y-1 overflow-auto">
				{#each tables as table (table.name)}
					<Button
						variant={tableName === table.name ? 'secondary' : 'ghost'}
						class="w-full justify-between"
						onclick={() => selectTable(table.name)}
					>
						<span class="truncate">{table.name}</span>
						<span class="text-muted-foreground text-xs">{table.rows ?? 0}</span>
					</Button>
				{/each}
			</Card.Content>
		</Card.Root>

		<Card.Root class="min-w-0">
			<Card.Header>
				<div class="flex items-center justify-between gap-3">
					<div>
						<Card.Title>Rows</Card.Title>
						<Card.Description>
							{tableName || 'No table selected'} / offset {rowOffset}
							{#if selectedTable?.rows !== undefined}
								/ approx {selectedTable.rows} rows
							{/if}
						</Card.Description>
					</div>
					<div class="flex items-center gap-2">
						<Select.Root type="single" bind:value={rowLimitValue} onValueChange={updateRowLimit}>
							<Select.Trigger aria-label="Row page size" class="w-[112px]">{rowLimit} rows</Select.Trigger>
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
								<Table.Head>{field}</Table.Head>
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
					<div class="text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-6 text-center text-sm">
						No rows loaded for this table.
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
		</div>
	{/if}
</section>
