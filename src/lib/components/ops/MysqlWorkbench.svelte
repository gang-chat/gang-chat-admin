<script lang="ts">
	import { ChevronLeft, ChevronRight, Copy, Play, Plus, RefreshCw, Trash2 } from '@lucide/svelte';
	import type { ApiClient } from '$lib/api/client';
	import type {
		ConnectionPreset,
		AuthRole,
		MysqlColumn,
		MysqlQueryResult,
		MysqlSqlMode,
		MysqlTableSummary
	} from '$lib/shared/ops-types';
	import type { RunTask } from './types';

	let {
		api,
		mysqlConnections,
		currentRole,
		run,
		onAuditRefresh
	}: {
		api: ApiClient;
		mysqlConnections: ConnectionPreset[];
		currentRole?: AuthRole;
		run: RunTask;
		onAuditRefresh: () => Promise<void>;
	} = $props();

	let connectionId = $state('');
	let tables = $state<MysqlTableSummary[]>([]);
	let tableName = $state('');
	let schema = $state<MysqlColumn[]>([]);
	let rows = $state<Record<string, unknown>[]>([]);
	let rowLimit = $state(100);
	let rowOffset = $state(0);
	let selectedRowKey = $state('');
	let sqlText = $state('SELECT 1 AS ok;');
	let sqlMode = $state<MysqlSqlMode>('read-only');
	let sqlMaxRows = $state(200);
	let sqlTimeoutMs = $state(10000);
	let sqlMutationConfirmation = $state('');
	let sqlResult = $state<MysqlQueryResult | undefined>();
	let rowJson = $state('{\n  "id": 1\n}');
	let patchJson = $state('{\n  "name": "new value"\n}');
	let insertJson = $state('{\n  "name": "new value"\n}');
	let deleteRowConfirmation = $state('');

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
	let canOperate = $derived(currentRole === 'operator' || currentRole === 'admin');
	let displayFields = $derived(
		rows[0] ? Object.keys(rows[0]) : schema.map((column) => column.field)
	);
	let primaryColumns = $derived(schema.filter((column) => column.key === 'PRI'));
	let uniqueColumns = $derived(schema.filter((column) => column.key === 'UNI'));
	let rowKeyColumns = $derived(primaryColumns.length > 0 ? primaryColumns : uniqueColumns);
	let rowKeyLabel = $derived(
		primaryColumns.length > 0
			? 'primary key'
			: uniqueColumns.length > 0
				? 'unique key'
				: 'no primary or unique key'
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
			selectedRowKey = '';
			insertJson = formatJson(buildInsertTemplate());
			deleteRowConfirmation = '';
		});
	}

	async function executeSql() {
		if (!connectionId) return;
		await run(async () => {
			sqlResult = await api.mysqlQuery(connectionId, sqlText, {
				mode: sqlMode,
				maxRows: Number(sqlMaxRows),
				timeoutMs: Number(sqlTimeoutMs),
				mutationConfirmation: sqlMutationConfirmation
			});
			await onAuditRefresh();
		}, 'SQL executed');
	}

	async function insertRow() {
		if (!connectionId || !tableName) return;
		await run(async () => {
			await api.mysqlInsert(connectionId, tableName, parseJson(insertJson));
			await loadTable();
			await onAuditRefresh();
		}, 'Row inserted');
	}

	async function updateRow() {
		if (!connectionId || !tableName) return;
		await run(async () => {
			await api.mysqlUpdate(connectionId, tableName, parseJson(rowJson), parseJson(patchJson));
			await loadTable();
			await onAuditRefresh();
		}, 'Row updated');
	}

	async function deleteRow() {
		if (!connectionId || !tableName) return;
		if (deleteRowConfirmation !== tableName) return;
		await run(async () => {
			await api.mysqlDelete(connectionId, tableName, parseJson(rowJson), deleteRowConfirmation);
			deleteRowConfirmation = '';
			await loadTable();
			await onAuditRefresh();
		}, 'Row deleted');
	}

	function parseJson(value: string) {
		return JSON.parse(value) as Record<string, unknown>;
	}

	function selectTable(name: string) {
		tableName = name;
		void loadTable(true);
	}

	function selectRow(row: Record<string, unknown>, rowIndex: number) {
		selectedRowKey = `${rowOffset}:${rowIndex}`;
		rowJson = formatJson(primaryKeyForRow(row));
		patchJson = formatJson(patchForRow(row));
	}

	function applyInsertTemplate() {
		rowJson = insertJson;
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

	function buildInsertTemplate() {
		const template: Record<string, unknown> = {};
		for (const column of schema) {
			if (column.extra.toLowerCase().includes('auto_increment')) continue;
			template[column.field] = column.defaultValue ?? sampleValue(column);
		}
		return template;
	}

	function primaryKeyForRow(row: Record<string, unknown>) {
		const keys = rowKeyColumns.map((column) => column.field);
		return Object.fromEntries(keys.map((key) => [key, row[key]]));
	}

	function patchForRow(row: Record<string, unknown>) {
		const primaryFields = new Set(rowKeyColumns.map((column) => column.field));
		const entries = Object.entries(row).filter(([key]) => !primaryFields.has(key));
		return Object.fromEntries(entries.length > 0 ? entries : Object.entries(row));
	}

	function sampleValue(column: MysqlColumn) {
		const type = column.type.toLowerCase();
		if (
			type.includes('int') ||
			type.includes('decimal') ||
			type.includes('float') ||
			type.includes('double')
		)
			return 0;
		if (type.includes('bool') || type === 'tinyint(1)') return false;
		if (type.includes('json')) return {};
		if (type.includes('date') || type.includes('time')) return new Date().toISOString();
		return '';
	}

	function formatJson(value: Record<string, unknown>) {
		return JSON.stringify(value, null, 2);
	}

	$effect(() => {
		if (!mutationsAllowed && sqlMode !== 'read-only') {
			sqlMode = 'read-only';
			sqlMutationConfirmation = '';
		}
	});
</script>

<section class="workspace">
	<div class="toolbar">
		<select bind:value={connectionId} onchange={loadTables}>
			<option value="">Select MySQL connection</option>
			{#each mysqlConnections as item (item.id)}
				<option value={item.id}>{item.name}</option>
			{/each}
		</select>
		<select bind:value={tableName} onchange={() => loadTable(true)}>
			<option value="">Select table</option>
			{#each tables as table (table.name)}
				<option value={table.name}>{table.name}</option>
			{/each}
		</select>
		<select bind:value={rowLimit} onchange={() => loadTable(true)} aria-label="Row page size">
			<option value={50}>50 rows</option>
			<option value={100}>100 rows</option>
			<option value={250}>250 rows</option>
			<option value={500}>500 rows</option>
		</select>
		<button class="command-button" onclick={() => loadTable()}>
			<RefreshCw class="size-4" /> Reload
		</button>
		{#if selectedConnection}
			<span
				class="rounded border px-2 py-1 text-xs {mutationsAllowed
					? 'border-amber-300 bg-amber-50 text-amber-900'
					: 'border-emerald-300 bg-emerald-50 text-emerald-900'}"
			>
				{mutationsAllowed ? 'writes enabled' : 'read only preset'}
			</span>
		{/if}
	</div>
	<div class="grid min-h-[640px] grid-cols-[260px_1fr] gap-4">
		<div class="panel overflow-auto">
			<div class="panel-title">Tables</div>
			{#each tables as table (table.name)}
				<button
					class="list-row {tableName === table.name ? 'active' : ''}"
					onclick={() => {
						selectTable(table.name);
					}}
				>
					<span>{table.name}</span>
					<span>{table.rows ?? 0}</span>
				</button>
			{/each}
		</div>
		<div class="grid min-w-0 grid-rows-[250px_1fr] gap-4">
			<div class="grid grid-cols-2 gap-4">
				<div class="panel">
					<div class="panel-title">SQL Console</div>
					<textarea class="code-input h-28" bind:value={sqlText}></textarea>
					<div class="mt-2 grid grid-cols-[1.2fr_0.8fr_0.9fr_auto] gap-2">
						<select bind:value={sqlMode} disabled={!mutationsAllowed || !canOperate}>
							<option value="read-only">Read only</option>
							<option value="allow-mutations">Allow mutations</option>
						</select>
						<input type="number" min="1" max="1000" bind:value={sqlMaxRows} aria-label="Max rows" />
						<input
							type="number"
							min="1000"
							max="60000"
							step="1000"
							bind:value={sqlTimeoutMs}
							aria-label="Timeout milliseconds"
						/>
						<button class="command-button" onclick={executeSql}>
							<Play class="size-4" /> Execute
						</button>
					</div>
					{#if sqlMode === 'allow-mutations'}
						<div
							class="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900"
						>
							Mutation mode is active. Single-statement SQL is still enforced.
						</div>
						<input
							class="mt-2 w-full"
							bind:value={sqlMutationConfirmation}
							placeholder="type RUN MUTATION for mutation SQL"
						/>
					{/if}
				</div>
				<div class="panel overflow-auto">
					<div class="flex items-center justify-between">
						<div class="panel-title">Row Mutation</div>
						{#if tableName}
							<span
								class="rounded border px-2 py-1 text-xs {rowKeyColumns.length > 0
									? 'border-emerald-300 bg-emerald-50 text-emerald-900'
									: 'border-amber-300 bg-amber-50 text-amber-900'}"
							>
								{rowKeyLabel}
							</span>
						{/if}
					</div>
					<div class="grid grid-cols-3 gap-2">
						<div>
							<div class="mb-1 text-xs font-semibold text-zinc-500">insert row</div>
							<textarea class="code-input h-28" bind:value={insertJson}></textarea>
						</div>
						<div>
							<div class="mb-1 text-xs font-semibold text-zinc-500">where key</div>
							<textarea class="code-input h-28" bind:value={rowJson}></textarea>
						</div>
						<div>
							<div class="mb-1 text-xs font-semibold text-zinc-500">patch</div>
							<textarea class="code-input h-28" bind:value={patchJson}></textarea>
						</div>
					</div>
					<input
						class="mt-2 w-full"
						bind:value={deleteRowConfirmation}
						placeholder={tableName ? `type ${tableName} to delete` : 'select table before deleting'}
					/>
					<div class="mt-2 flex flex-wrap gap-2">
						<button class="command-button" onclick={applyInsertTemplate}>
							<Copy class="size-4" /> Copy insert
						</button>
						<button
							class="command-button"
							onclick={insertRow}
							disabled={!mutationsAllowed || !canOperate}><Plus class="size-4" /> Insert</button
						>
						<button
							class="command-button"
							onclick={updateRow}
							disabled={!mutationsAllowed || !canOperate || rowKeyColumns.length === 0}
							><Play class="size-4" /> Update</button
						>
						<button
							class="danger-button"
							onclick={deleteRow}
							disabled={!mutationsAllowed ||
								!canOperate ||
								!tableName ||
								rowKeyColumns.length === 0 ||
								deleteRowConfirmation !== tableName}><Trash2 class="size-4" /> Delete</button
						>
					</div>
				</div>
			</div>
			<div class="panel min-w-0 overflow-auto">
				<div class="mb-3 flex items-center justify-between gap-2">
					<div>
						<div class="panel-title mb-1">Rows</div>
						<div class="text-xs text-zinc-500">
							{tableName || 'No table selected'} / offset {rowOffset}
							{#if selectedTable?.rows !== undefined}
								/ approx {selectedTable.rows} rows
							{/if}
						</div>
					</div>
					<div class="flex items-center gap-2">
						<button
							class="command-button compact"
							onclick={previousPage}
							disabled={!canPageBackward}
						>
							<ChevronLeft class="size-4" /> Prev
						</button>
						<button class="command-button compact" onclick={nextPage} disabled={!canPageForward}>
							Next <ChevronRight class="size-4" />
						</button>
					</div>
				</div>
				<table class="data-table">
					<thead>
						<tr>
							<th class="w-16">Select</th>
							{#each displayFields as field (field)}
								<th>{field}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each rows as row, rowIndex (rowIndex)}
							<tr
								class={selectedRowKey === `${rowOffset}:${rowIndex}` ? 'selected-row' : ''}
								onclick={() => selectRow(row, rowIndex)}
							>
								<td>
									<button class="command-button compact" onclick={() => selectRow(row, rowIndex)}>
										<Copy class="size-3" />
									</button>
								</td>
								{#each displayFields as field (field)}
									<td>{String(row[field] ?? '')}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
				{#if rows.length === 0}
					<div
						class="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500"
					>
						No rows loaded for this table.
					</div>
				{/if}
				{#if sqlResult}
					<div class="mt-4 border-t border-zinc-200 pt-3 text-xs text-zinc-600">
						SQL result: {sqlResult.executionMs}ms / {sqlResult.affectedRows ??
							sqlResult.rows.length} rows / {sqlResult.policy.mode}
						{#if sqlResult.limited}
							<span class="text-amber-700"> / limited to {sqlResult.policy.maxRows}</span>
						{/if}
					</div>
					{#if sqlResult.rows.length > 0}
						<table class="data-table mt-2">
							<thead>
								<tr>
									{#each sqlResult.fields as field (field)}
										<th>{field}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each sqlResult.rows as row, rowIndex (rowIndex)}
									<tr>
										{#each sqlResult.fields as field (field)}
											<td>{String(row[field] ?? '')}</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				{/if}
			</div>
		</div>
	</div>
</section>
