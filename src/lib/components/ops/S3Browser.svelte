<script lang="ts">
	import {
		ArrowUp,
		ChevronLeft,
		ChevronRight,
		Download,
		File as FileIcon,
		Folder,
		RefreshCw,
		Search,
		Trash2,
		Upload
	} from '@lucide/svelte';
	import type { ApiClient } from '$lib/api/client';
	import type {
		ConnectionPreset,
		AuthRole,
		S3Bucket,
		S3ObjectMetadata,
		S3ObjectSummary
	} from '$lib/shared/ops-types';
	import type { RunTask } from './types';

	let {
		api,
		s3Connections,
		currentRole,
		run,
		onAuditRefresh
	}: {
		api: ApiClient;
		s3Connections: ConnectionPreset[];
		currentRole?: AuthRole;
		run: RunTask;
		onAuditRefresh: () => Promise<void>;
	} = $props();

	let connectionId = $state('');
	let buckets = $state<S3Bucket[]>([]);
	let bucket = $state('');
	let prefix = $state('');
	let maxKeys = $state(500);
	let pageTokens = $state<Array<string | undefined>>([]);
	let currentPageToken = $state<string | undefined>();
	let nextContinuationToken = $state<string | undefined>();
	let prefixes = $state<string[]>([]);
	let objects = $state<S3ObjectSummary[]>([]);
	let selectedKey = $state('');
	let uploadKey = $state('');
	let uploadFile = $state<File | undefined>();
	let uploadContentType = $state('');
	let uploadCacheControl = $state('');
	let uploadContentDisposition = $state('');
	let uploadMetadataJson = $state('');
	let allowOverwrite = $state(false);
	let overwriteConfirmKey = $state('');
	let deleteCandidate = $state<S3ObjectSummary | undefined>();
	let deleteConfirmKey = $state('');
	let objectMetadata = $state<S3ObjectMetadata | undefined>();
	let metadataError = $state('');

	let selectedObject = $derived(objects.find((object) => object.key === selectedKey));
	let selectedConnection = $derived(
		s3Connections.find((item) => item.id === connectionId && item.type === 's3')
	);
	let writesAllowed = $derived(
		Boolean(
			selectedConnection?.config &&
			'allowWrites' in selectedConnection.config &&
			selectedConnection.config.allowWrites
		)
	);
	let canOperate = $derived(currentRole === 'operator' || currentRole === 'admin');
	let resolvedUploadKey = $derived(resolveUploadKey());
	let uploadOverwrites = $derived(
		Boolean(resolvedUploadKey && objects.some((object) => object.key === resolvedUploadKey))
	);
	let uploadMetadataError = $derived(validateUploadMetadata(uploadMetadataJson));
	let canUpload = $derived(
		Boolean(
			connectionId &&
			canOperate &&
			writesAllowed &&
			bucket &&
			uploadFile &&
			resolvedUploadKey &&
			!uploadMetadataError &&
			(!uploadOverwrites || (allowOverwrite && overwriteConfirmKey === resolvedUploadKey))
		)
	);
	let canPageBackward = $derived(pageTokens.length > 0);
	let canPageForward = $derived(Boolean(nextContinuationToken));

	async function loadBuckets() {
		if (!connectionId) return;
		await run(async () => {
			buckets = await api.s3Buckets(connectionId);
			const selected = s3Connections.find((item) => item.id === connectionId);
			bucket =
				bucket ||
				buckets[0]?.name ||
				(selected?.config && 'defaultBucket' in selected.config
					? selected.config.defaultBucket
					: '') ||
				'';
			if (bucket) await loadObjects(true);
		});
	}

	async function loadObjects(resetPage = false) {
		if (!connectionId || !bucket) return;
		if (resetPage) {
			pageTokens = [];
			currentPageToken = undefined;
		}
		await run(async () => {
			const result = await api.s3Objects(connectionId, bucket, {
				prefix,
				continuationToken: currentPageToken,
				maxKeys: Number(maxKeys)
			});
			prefixes = result.prefixes;
			objects = result.objects;
			nextContinuationToken = result.nextContinuationToken;
			selectedKey = '';
			allowOverwrite = false;
			overwriteConfirmKey = '';
			deleteCandidate = undefined;
			deleteConfirmKey = '';
			objectMetadata = undefined;
			metadataError = '';
		});
	}

	async function uploadObject() {
		if (!connectionId || !bucket || !uploadFile || !canUpload) return;
		const form = new FormData();
		form.set('bucket', bucket);
		form.set('key', resolvedUploadKey);
		form.set('overwrite', allowOverwrite ? 'true' : 'false');
		if (allowOverwrite) form.set('overwriteConfirmation', overwriteConfirmKey);
		if (uploadContentType.trim()) form.set('contentType', uploadContentType.trim());
		if (uploadCacheControl.trim()) form.set('cacheControl', uploadCacheControl.trim());
		if (uploadContentDisposition.trim()) {
			form.set('contentDisposition', uploadContentDisposition.trim());
		}
		if (uploadMetadataJson.trim()) form.set('metadata', uploadMetadataJson.trim());
		form.set('file', uploadFile);
		await run(async () => {
			await api.s3Upload(connectionId, form);
			uploadKey = '';
			uploadFile = undefined;
			uploadContentType = '';
			uploadCacheControl = '';
			uploadContentDisposition = '';
			uploadMetadataJson = '';
			allowOverwrite = false;
			overwriteConfirmKey = '';
			await loadObjects(true);
			await onAuditRefresh();
		}, 'Object uploaded');
	}

	async function deleteObject() {
		if (!connectionId || !bucket) return;
		if (!deleteCandidate || deleteConfirmKey !== deleteCandidate.key) return;
		const target = deleteCandidate;
		await run(async () => {
			await api.s3Delete(connectionId, bucket, target.key, deleteConfirmKey);
			await loadObjects(false);
			await onAuditRefresh();
			deleteCandidate = undefined;
			deleteConfirmKey = '';
		}, 'Object deleted');
	}

	async function downloadObject(key: string) {
		if (!connectionId || !bucket) return;
		await run(async () => {
			const response = await api.s3Download(connectionId, bucket, key);
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = key.split('/').at(-1) || 'object';
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
		});
	}

	function selectBucket(name: string) {
		bucket = name;
		prefix = '';
		void loadObjects(true);
	}

	function openPrefix(nextPrefix: string) {
		prefix = nextPrefix;
		void loadObjects(true);
	}

	function openParentPrefix() {
		prefix = parentPrefix(prefix);
		void loadObjects(true);
	}

	function nextPage() {
		if (!nextContinuationToken) return;
		pageTokens = [...pageTokens, currentPageToken];
		currentPageToken = nextContinuationToken;
		void loadObjects(false);
	}

	function previousPage() {
		if (pageTokens.length === 0) return;
		const copy = [...pageTokens];
		currentPageToken = copy.pop();
		pageTokens = copy;
		void loadObjects(false);
	}

	function selectObject(object: S3ObjectSummary) {
		selectedKey = object.key;
		deleteCandidate = undefined;
		deleteConfirmKey = '';
		void loadObjectMetadata(object.key);
	}

	async function loadObjectMetadata(key: string) {
		if (!connectionId || !bucket) return;
		objectMetadata = undefined;
		metadataError = '';
		try {
			objectMetadata = await api.s3Head(connectionId, bucket, key);
			await onAuditRefresh();
		} catch (error) {
			metadataError = error instanceof Error ? error.message : 'Failed to load object metadata';
		}
	}

	function resolveUploadKey() {
		if (!uploadFile && !uploadKey.trim()) return '';
		const key = uploadKey.trim() || uploadFile?.name || '';
		if (!key || key.startsWith(prefix) || key.startsWith('/')) return key.replace(/^\/+/, '');
		return `${prefix}${key}`;
	}

	function onUploadFileChange(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		uploadFile = file;
		if (file?.type && !uploadContentType.trim()) uploadContentType = file.type;
	}

	function validateUploadMetadata(value: string) {
		const trimmed = value.trim();
		if (!trimmed) return '';
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return 'Metadata must be a JSON object';
			}
			const entries = Object.entries(parsed);
			if (entries.length > 20) return 'Metadata supports up to 20 entries';
			let totalSize = 0;
			for (const [key, metadataValue] of entries) {
				if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(key)) {
					return `Invalid metadata key: ${key}`;
				}
				if (key.toLowerCase().startsWith('x-amz-')) {
					return 'Use raw metadata keys without x-amz prefixes';
				}
				if (typeof metadataValue !== 'string') {
					return `Metadata value for ${key} must be a string`;
				}
				if (metadataValue.length > 1024) return `Metadata value for ${key} is too long`;
				if (hasControlCharacter(metadataValue)) {
					return `Metadata value for ${key} cannot contain control characters`;
				}
				totalSize += new TextEncoder().encode(key).length;
				totalSize += new TextEncoder().encode(metadataValue).length;
				if (totalSize > 8192) return 'Metadata is too large';
			}
			return '';
		} catch {
			return 'Metadata must be valid JSON';
		}
	}

	function hasControlCharacter(value: string) {
		return Array.from(value).some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 127;
		});
	}

	function parentPrefix(value: string) {
		const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
		const index = trimmed.lastIndexOf('/');
		return index >= 0 ? `${trimmed.slice(0, index)}/` : '';
	}

	function shortName(key: string) {
		const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
		return trimmed.split('/').at(-1) || key;
	}

	function formatBytes(size: number) {
		if (size < 1024) return `${size} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let value = size / 1024;
		let index = 0;
		while (value >= 1024 && index < units.length - 1) {
			value /= 1024;
			index += 1;
		}
		return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
	}
</script>

<section class="workspace">
	<div class="toolbar">
		<select bind:value={connectionId} onchange={loadBuckets}>
			<option value="">Select S3 connection</option>
			{#each s3Connections as item (item.id)}
				<option value={item.id}>{item.name}</option>
			{/each}
		</select>
		<input bind:value={bucket} placeholder="bucket" />
		<input bind:value={prefix} placeholder="prefix" />
		<select bind:value={maxKeys} onchange={() => loadObjects(true)} aria-label="S3 page size">
			<option value={100}>100 keys</option>
			<option value={250}>250 keys</option>
			<option value={500}>500 keys</option>
			<option value={1000}>1000 keys</option>
		</select>
		<button class="command-button" onclick={() => loadObjects(true)}
			><Search class="size-4" /> Browse</button
		>
		{#if selectedConnection}
			<span
				class="rounded border px-2 py-1 text-xs {writesAllowed
					? 'border-amber-300 bg-amber-50 text-amber-900'
					: 'border-emerald-300 bg-emerald-50 text-emerald-900'}"
			>
				{writesAllowed ? 'writes enabled' : 'read only preset'}
			</span>
		{/if}
	</div>
	<div class="grid min-h-[640px] grid-cols-[260px_1fr] gap-4">
		<div class="panel overflow-auto">
			<div class="panel-title">Buckets</div>
			{#each buckets as item (item.name)}
				<button
					class="list-row {bucket === item.name ? 'active' : ''}"
					onclick={() => {
						selectBucket(item.name);
					}}
				>
					<span>{item.name}</span>
				</button>
			{/each}
		</div>
		<div class="grid min-w-0 grid-cols-[1fr_320px] gap-4">
			<div class="panel min-w-0 overflow-auto">
				<div class="mb-3 flex items-center justify-between gap-2">
					<div>
						<div class="panel-title mb-1">Objects</div>
						<div class="text-xs text-zinc-500">{bucket || 'No bucket'} / {prefix || '(root)'}</div>
					</div>
					<div class="flex gap-2">
						<button class="command-button compact" onclick={openParentPrefix} disabled={!prefix}>
							<ArrowUp class="size-4" /> Up
						</button>
						<button class="command-button compact" onclick={() => loadObjects(false)}>
							<RefreshCw class="size-4" /> Reload
						</button>
					</div>
				</div>
				<div class="mb-3 grid grid-cols-[1fr_1fr_auto] gap-2">
					<input
						bind:value={uploadKey}
						placeholder={prefix ? `${prefix}object.ext` : 'object key'}
					/>
					<input type="file" onchange={onUploadFileChange} />
					<button class="command-button" onclick={uploadObject} disabled={!canUpload}
						><Upload class="size-4" /> Upload</button
					>
				</div>
				<div class="mb-3 grid grid-cols-3 gap-2">
					<input bind:value={uploadContentType} placeholder="content type" />
					<input bind:value={uploadCacheControl} placeholder="cache-control" />
					<input bind:value={uploadContentDisposition} placeholder="content-disposition" />
				</div>
				<textarea
					class="mb-2 min-h-20 w-full resize-y"
					bind:value={uploadMetadataJson}
					placeholder="metadata JSON object"
					aria-label="S3 upload metadata JSON"></textarea>
				{#if uploadMetadataError}
					<div class="mb-3 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900">
						{uploadMetadataError}
					</div>
				{/if}
				<div class="mb-3 flex items-center justify-between gap-2 text-xs text-zinc-600">
					<div class="truncate">target: {resolvedUploadKey || '-'}</div>
					<label class="checkline text-xs">
						<input type="checkbox" bind:checked={allowOverwrite} disabled={!uploadOverwrites} />
						allow overwrite
					</label>
				</div>
				{#if uploadOverwrites && !allowOverwrite}
					<div
						class="mb-3 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900"
					>
						An object with this key already exists. Enable overwrite to upload.
					</div>
				{/if}
				{#if uploadOverwrites && allowOverwrite}
					<input
						class="mb-3 w-full"
						bind:value={overwriteConfirmKey}
						placeholder="type exact key to overwrite"
					/>
				{/if}
				<table class="data-table">
					<thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead>
					<tbody>
						{#each prefixes as item (item)}
							<tr class="cursor-pointer" onclick={() => openPrefix(item)}>
								<td class="font-medium text-cyan-800">
									<div class="flex items-center gap-2">
										<Folder class="size-4" />
										{shortName(item)}/
									</div>
								</td>
								<td></td>
								<td></td>
								<td class="text-right">
									<button class="command-button compact" onclick={() => openPrefix(item)}>
										<ChevronRight class="size-3" />
									</button>
								</td>
							</tr>
						{/each}
						{#each objects as object (object.key)}
							<tr
								class={selectedKey === object.key ? 'selected-row' : ''}
								onclick={() => selectObject(object)}
							>
								<td>
									<div class="flex items-center gap-2">
										<FileIcon class="size-4 text-zinc-500" />
										<span class="break-all">{shortName(object.key)}</span>
									</div>
								</td>
								<td>{formatBytes(object.size)}</td>
								<td>{object.lastModified ?? ''}</td>
								<td class="text-right">
									<button class="command-button compact" onclick={() => downloadObject(object.key)}>
										<Download class="size-3" />
									</button>
									<button
										class="danger-button compact"
										onclick={() => {
											deleteCandidate = object;
											deleteConfirmKey = '';
										}}
										disabled={!writesAllowed || !canOperate}
									>
										<Trash2 class="size-3" />
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if prefixes.length === 0 && objects.length === 0}
					<div
						class="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500"
					>
						No objects found for this prefix.
					</div>
				{/if}
				<div class="mt-3 flex justify-end gap-2">
					<button class="command-button compact" onclick={previousPage} disabled={!canPageBackward}>
						<ChevronLeft class="size-4" /> Prev
					</button>
					<button class="command-button compact" onclick={nextPage} disabled={!canPageForward}>
						Next <ChevronRight class="size-4" />
					</button>
				</div>
			</div>
			<div class="panel overflow-auto">
				<div class="panel-title">Object Detail</div>
				{#if selectedObject}
					<div class="space-y-2 text-sm">
						<div>
							<div class="text-xs font-semibold text-zinc-500">key</div>
							<div class="break-all">{selectedObject.key}</div>
						</div>
						<div>
							<div class="text-xs font-semibold text-zinc-500">size</div>
							<div>{formatBytes(selectedObject.size)} ({selectedObject.size} bytes)</div>
						</div>
						<div>
							<div class="text-xs font-semibold text-zinc-500">modified</div>
							<div>{selectedObject.lastModified ?? '-'}</div>
						</div>
						<div>
							<div class="text-xs font-semibold text-zinc-500">etag</div>
							<div class="break-all">{selectedObject.etag ?? '-'}</div>
						</div>
						<div>
							<div class="text-xs font-semibold text-zinc-500">storage class</div>
							<div>{selectedObject.storageClass ?? '-'}</div>
						</div>
						{#if metadataError}
							<div
								class="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900"
							>
								{metadataError}
							</div>
						{/if}
						{#if objectMetadata}
							<div>
								<div class="text-xs font-semibold text-zinc-500">content type</div>
								<div>{objectMetadata.contentType ?? '-'}</div>
							</div>
							<div>
								<div class="text-xs font-semibold text-zinc-500">cache control</div>
								<div>{objectMetadata.cacheControl ?? '-'}</div>
							</div>
							<div>
								<div class="text-xs font-semibold text-zinc-500">content disposition</div>
								<div class="break-all">{objectMetadata.contentDisposition ?? '-'}</div>
							</div>
							{#if Object.keys(objectMetadata.metadata).length > 0}
								<div>
									<div class="text-xs font-semibold text-zinc-500">metadata</div>
									<div class="space-y-1">
										{#each Object.entries(objectMetadata.metadata) as [name, value] (name)}
											<div class="break-all rounded bg-zinc-100 px-2 py-1 text-xs">
												{name}: {value}
											</div>
										{/each}
									</div>
								</div>
							{/if}
						{/if}
						<div class="flex gap-2 pt-2">
							<button class="command-button" onclick={() => downloadObject(selectedObject.key)}>
								<Download class="size-4" /> Download
							</button>
							<button
								class="danger-button"
								onclick={() => {
									deleteCandidate = selectedObject;
									deleteConfirmKey = '';
								}}
								disabled={!writesAllowed || !canOperate}
							>
								<Trash2 class="size-4" /> Delete
							</button>
						</div>
					</div>
				{:else}
					<div
						class="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500"
					>
						Select an object to inspect metadata.
					</div>
				{/if}

				{#if deleteCandidate}
					<div class="mt-4 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-900">
						<div class="font-semibold">Confirm delete</div>
						<div class="mt-1 break-all">{deleteCandidate.key}</div>
						<input
							class="mt-2 w-full"
							bind:value={deleteConfirmKey}
							placeholder="type exact key to confirm"
						/>
						<div class="mt-2 flex gap-2">
							<button
								class="danger-button"
								onclick={deleteObject}
								disabled={!writesAllowed || !canOperate || deleteConfirmKey !== deleteCandidate.key}
							>
								<Trash2 class="size-4" /> Delete object
							</button>
							<button
								class="command-button"
								onclick={() => {
									deleteCandidate = undefined;
									deleteConfirmKey = '';
								}}
							>
								Cancel
							</button>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</section>
