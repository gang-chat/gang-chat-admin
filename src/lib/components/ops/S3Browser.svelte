<script lang="ts">
	import {
		ArrowUp,
		ChevronLeft,
		ChevronRight,
		Download,
		File as FileIcon,
		Folder,
		RefreshCw,
		Trash2,
		Upload
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import type { ApiClient } from '$lib/api/client';
	import type {
		AuthRole,
		ConnectionPreset,
		S3ObjectSummary,
		S3ReleaseSyncConfig,
		S3ReleaseVersion
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
	let bucket = $state('');
	let prefix = $state('');
	let maxKeys = $state(500);
	let maxKeysValue = $state('500');
	let pageTokens = $state<Array<string | undefined>>([]);
	let currentPageToken = $state<string | undefined>();
	let nextContinuationToken = $state<string | undefined>();
	let prefixes = $state<string[]>([]);
	let objects = $state<S3ObjectSummary[]>([]);
	let selectedKey = $state('');
	let uploadKey = $state('');
	let uploadFile = $state<File | undefined>();
	let allowOverwrite = $state(false);
	let overwriteConfirmKey = $state('');
	let deleteCandidate = $state<S3ObjectSummary | undefined>();
	let deleteConfirmKey = $state('');
	let releaseSyncConfig = $state<S3ReleaseSyncConfig>({ enabled: false });
	let releaseVersions = $state<S3ReleaseVersion[]>([]);
	let releaseLoadedFor = $state('');
	let selectedReleaseTag = $state('');
	let releaseSyncSummary = $state('');

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
	let configuredBucket = $derived(configuredBucketName(selectedConnection));
	let canOperate = $derived(currentRole === 'operator' || currentRole === 'admin');
	let resolvedUploadKey = $derived(resolveUploadKey());
	let uploadOverwrites = $derived(
		Boolean(resolvedUploadKey && objects.some((object) => object.key === resolvedUploadKey))
	);
	let canUpload = $derived(
		Boolean(
			connectionId &&
			canOperate &&
			writesAllowed &&
			bucket &&
			uploadFile &&
			resolvedUploadKey &&
			(!uploadOverwrites || (allowOverwrite && overwriteConfirmKey === resolvedUploadKey))
		)
	);
	let selectedRelease = $derived(
		releaseVersions.find((release) => release.tagName === selectedReleaseTag)
	);
	let canSyncRelease = $derived(
		Boolean(
			connectionId &&
				bucket &&
				canOperate &&
				writesAllowed &&
				releaseSyncConfig.enabled &&
				selectedReleaseTag
		)
	);
	let canPageBackward = $derived(pageTokens.length > 0);
	let canPageForward = $derived(Boolean(nextContinuationToken));

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
		});
	}

	async function loadReleaseSync() {
		if (!connectionId) return;
		await run(async () => {
			const config = await api.s3ReleaseSyncConfig(connectionId);
			releaseSyncConfig = config;
			releaseSyncSummary = '';
			if (!config.enabled) {
				releaseVersions = [];
				selectedReleaseTag = '';
				return;
			}
			releaseVersions = await api.s3ReleaseVersions(connectionId);
			if (!releaseVersions.some((release) => release.tagName === selectedReleaseTag)) {
				selectedReleaseTag = releaseVersions[0]?.tagName ?? '';
			}
		});
	}

	async function syncRelease() {
		if (!canSyncRelease || !selectedReleaseTag) return;
		await run(async () => {
			const result = await api.s3SyncRelease(connectionId, bucket, selectedReleaseTag);
			releaseSyncSummary = `${result.tagName}: uploaded ${result.uploaded.length}, deleted ${result.deleted}`;
			prefix = result.targetPrefix;
			await loadObjects(true);
			await onAuditRefresh();
		}, 'Release synced');
	}

	async function uploadObject() {
		if (!connectionId || !bucket || !uploadFile || !canUpload) return;
		const form = new FormData();
		form.set('bucket', bucket);
		form.set('key', resolvedUploadKey);
		form.set('overwrite', allowOverwrite ? 'true' : 'false');
		if (allowOverwrite) form.set('overwriteConfirmation', overwriteConfirmKey);
		if (uploadFile.type) form.set('contentType', uploadFile.type);
		form.set('file', uploadFile);
		await run(async () => {
			await api.s3Upload(connectionId, form);
			uploadKey = '';
			uploadFile = undefined;
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

	function updateMaxKeys(value: string) {
		maxKeysValue = value;
		maxKeys = Number(value);
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
	}

	function resolveUploadKey() {
		if (!uploadFile && !uploadKey.trim()) return '';
		const key = uploadKey.trim() || uploadFile?.name || '';
		if (!key || key.startsWith(prefix) || key.startsWith('/')) return key.replace(/^\/+/, '');
		return `${prefix}${key}`;
	}

	function onUploadFileChange(event: Event) {
		uploadFile = (event.currentTarget as HTMLInputElement).files?.[0];
	}

	function configuredBucketName(connection: ConnectionPreset | undefined) {
		const config = connection?.config;
		if (!config || !('endpoint' in config)) return '';
		return config.defaultBucket || '';
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

	$effect(() => {
		if (maxKeysValue !== String(maxKeys)) maxKeysValue = String(maxKeys);
	});

	$effect(() => {
		const configuredId = s3Connections[0]?.id ?? '';
		if (configuredId && connectionId !== configuredId) connectionId = configuredId;
		if (configuredBucket && bucket !== configuredBucket) {
			bucket = configuredBucket;
			prefix = '';
			void loadObjects(true);
		}
	});

	$effect(() => {
		if (connectionId && releaseLoadedFor !== connectionId) {
			releaseLoadedFor = connectionId;
			void loadReleaseSync();
		}
	});
</script>

<section class="workspace">
	{#if !connectionId || !bucket}
		<Card.Root>
			<Card.Content class="text-muted-foreground text-sm">
				<div class="text-foreground font-medium">S3 file manager unavailable</div>
				<div class="mt-1">Configure <code>connections.s3.config.defaultBucket</code> in config.json and restart.</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between gap-3">
					<div>
						<Card.Title>Files</Card.Title>
						<Card.Description>{bucket} / {prefix || '(root)'}</Card.Description>
					</div>
					<div class="flex items-center gap-2">
						<Select.Root type="single" bind:value={maxKeysValue} onValueChange={updateMaxKeys}>
							<Select.Trigger aria-label="S3 page size" class="w-[112px]">{maxKeys} keys</Select.Trigger>
							<Select.Content>
								{#each [100, 250, 500, 1000] as size (size)}
									<Select.Item value={String(size)}>{size} keys</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<Button variant="outline" size="sm" onclick={openParentPrefix} disabled={!prefix}><ArrowUp class="size-4" /> Up</Button>
						<Button variant="outline" size="sm" onclick={() => loadObjects(false)}><RefreshCw class="size-4" /> Reload</Button>
					</div>
				</div>
			</Card.Header>
			<Card.Content>
				{#if releaseSyncConfig.enabled}
					<div class="mb-4 border-b pb-4">
						<div class="flex flex-wrap items-end justify-between gap-3">
							<div class="min-w-0">
								<div class="text-sm font-medium">Release sync</div>
								<div class="text-muted-foreground mt-1 truncate text-xs">
									{releaseSyncConfig.repository} -> {bucket}/{releaseSyncConfig.targetPrefix}
								</div>
								{#if releaseSyncConfig.assetPrefix}
									<div class="text-muted-foreground mt-1 truncate text-xs">
										{releaseSyncConfig.assetPrefix}_&lt;tag&gt;.dmg / {releaseSyncConfig.assetPrefix}_&lt;tag&gt;.exe / {releaseSyncConfig.assetPrefix}_&lt;tag&gt;.apk
									</div>
								{/if}
							</div>
							<div class="flex min-w-0 flex-wrap items-center gap-2">
								<Select.Root type="single" bind:value={selectedReleaseTag}>
									<Select.Trigger aria-label="GitHub release version" class="w-[220px]">
										{selectedReleaseTag || 'No releases'}
									</Select.Trigger>
									<Select.Content>
										{#each releaseVersions as release (release.id)}
											<Select.Item value={release.tagName}>
												{release.tagName}{release.assetCount ? ` · ${release.assetCount}` : ''}
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
								<Button variant="outline" size="sm" onclick={loadReleaseSync}><RefreshCw class="size-4" /> Versions</Button>
								<Button size="sm" onclick={syncRelease} disabled={!canSyncRelease}><Upload class="size-4" /> Sync</Button>
							</div>
						</div>
						{#if selectedRelease?.publishedAt || releaseSyncSummary}
							<div class="text-muted-foreground mt-2 text-xs">
								{#if selectedRelease?.publishedAt}{selectedRelease.publishedAt}{/if}
								{#if releaseSyncSummary}{selectedRelease?.publishedAt ? ' · ' : ''}{releaseSyncSummary}{/if}
							</div>
						{/if}
					</div>
				{/if}
				<div class="mb-3 grid grid-cols-[1fr_1fr_auto] gap-2">
					<Input bind:value={uploadKey} placeholder={prefix ? `${prefix}file.ext` : 'file key'} />
					<Input type="file" onchange={onUploadFileChange} />
					<Button onclick={uploadObject} disabled={!canUpload}><Upload class="size-4" /> Upload</Button>
				</div>
				<div class="text-muted-foreground mb-3 flex items-center justify-between gap-2 text-xs">
					<div class="truncate">target: {resolvedUploadKey || '-'}</div>
					<label class="flex items-center gap-2">
						<Checkbox bind:checked={allowOverwrite} disabled={!uploadOverwrites} />
						overwrite
					</label>
				</div>
				{#if uploadOverwrites && !allowOverwrite}
					<div class="text-muted-foreground mb-3 rounded-lg border px-2 py-1 text-xs">This file already exists. Enable overwrite to replace it.</div>
				{/if}
				{#if uploadOverwrites && allowOverwrite}
					<Input class="mb-3" bind:value={overwriteConfirmKey} placeholder="type exact key to overwrite" />
				{/if}

				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Name</Table.Head>
							<Table.Head>Size</Table.Head>
							<Table.Head>Modified</Table.Head>
							<Table.Head></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each prefixes as item (item)}
							<Table.Row class="cursor-pointer" onclick={() => openPrefix(item)}>
								<Table.Cell class="font-medium"><div class="flex items-center gap-2"><Folder class="size-4" />{shortName(item)}/</div></Table.Cell>
								<Table.Cell></Table.Cell>
								<Table.Cell></Table.Cell>
								<Table.Cell class="text-right"><Button variant="ghost" size="icon-xs" onclick={() => openPrefix(item)}><ChevronRight class="size-3" /></Button></Table.Cell>
							</Table.Row>
						{/each}
						{#each objects as object (object.key)}
							<Table.Row class={selectedKey === object.key ? 'bg-muted cursor-pointer' : 'cursor-pointer'} onclick={() => selectObject(object)}>
								<Table.Cell><div class="flex items-center gap-2"><FileIcon class="text-muted-foreground size-4" /><span class="break-all">{shortName(object.key)}</span></div></Table.Cell>
								<Table.Cell>{formatBytes(object.size)}</Table.Cell>
								<Table.Cell>{object.lastModified ?? ''}</Table.Cell>
								<Table.Cell class="text-right">
									<Button variant="ghost" size="icon-xs" onclick={() => downloadObject(object.key)}><Download class="size-3" /></Button>
									<Button variant="destructive" size="icon-xs" onclick={() => { deleteCandidate = object; deleteConfirmKey = ''; }} disabled={!writesAllowed || !canOperate}><Trash2 class="size-3" /></Button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#if prefixes.length === 0 && objects.length === 0}
					<div class="text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-6 text-center text-sm">No files found.</div>
				{/if}
				<div class="mt-3 flex items-center justify-between gap-2">
					<div class="text-muted-foreground min-w-0 text-xs">
						{#if selectedObject}
							<span class="break-all">Selected: {selectedObject.key} · {formatBytes(selectedObject.size)}</span>
						{/if}
					</div>
					<div class="flex gap-2">
						<Button variant="outline" size="sm" onclick={previousPage} disabled={!canPageBackward}><ChevronLeft class="size-4" /> Prev</Button>
						<Button variant="outline" size="sm" onclick={nextPage} disabled={!canPageForward}>Next <ChevronRight class="size-4" /></Button>
					</div>
				</div>

				{#if deleteCandidate}
					<div class="text-destructive mt-4 rounded-lg border p-3 text-xs">
						<div class="font-semibold">Confirm delete</div>
						<div class="mt-1 break-all">{deleteCandidate.key}</div>
						<Input class="mt-2" bind:value={deleteConfirmKey} placeholder="type exact key to confirm" />
						<div class="mt-2 flex gap-2">
							<Button variant="destructive" onclick={deleteObject} disabled={!writesAllowed || !canOperate || deleteConfirmKey !== deleteCandidate.key}>
								<Trash2 class="size-4" /> Delete file
							</Button>
							<Button variant="outline" onclick={() => { deleteCandidate = undefined; deleteConfirmKey = ''; }}>
								Cancel
							</Button>
						</div>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</section>
