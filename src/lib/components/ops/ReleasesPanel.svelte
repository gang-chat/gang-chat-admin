<script lang="ts">
	import { Plus, RefreshCw, Save, Trash2, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { ApiClient } from '$lib/api/client';
	import type { AppRelease, AppReleaseInput } from '$lib/shared/ops-types';
	import type { RunTask } from './types';

	let {
		api,
		run
	}: {
		api: ApiClient;
		run: RunTask;
	} = $props();

	type Form = {
		version: string;
		title: string;
		release_date: string;
		published: boolean;
		minimum_supported_version: string;
		notes: string;
		windows: string;
		macos: string;
		android: string;
	};

	const versionPattern = /^\d+\.\d+\.\d+$/;

	let releases = $state<AppRelease[]>([]);
	// A version, 'new', or '' for nothing selected.
	let selected = $state('');
	let form = $state<Form>(emptyForm());
	let saved = $state<Form>(emptyForm());
	let deleteOpen = $state(false);
	let deleteConfirmation = $state('');

	let creating = $derived(selected === 'new');
	let latest = $derived(releases.find((release) => release.published));
	let dirty = $derived(JSON.stringify(form) !== JSON.stringify(saved));
	let formError = $derived(validate(form));

	onMount(() => {
		void reload();
	});

	/** Reloads the list, keeping the selection when it still exists. */
	export async function reload() {
		await run(async () => {
			releases = await api.releases();
			if (selected && selected !== 'new') {
				const current = releases.find((release) => release.version === selected);
				if (current && !dirty) select(current);
				if (!current) selected = '';
			}
		});
	}

	function emptyForm(): Form {
		return {
			version: '',
			title: '',
			release_date: today(),
			published: false,
			minimum_supported_version: '',
			notes: '',
			windows: '',
			macos: '',
			android: ''
		};
	}

	function toForm(release: AppRelease): Form {
		return {
			version: release.version,
			title: release.title,
			release_date: release.release_date,
			published: release.published,
			minimum_supported_version: release.minimum_supported_version,
			notes: release.notes,
			windows: release.downloads.windows,
			macos: release.downloads.macos,
			android: release.downloads.android
		};
	}

	function toInput(value: Form): AppReleaseInput {
		return {
			title: value.title,
			release_date: value.release_date,
			published: value.published,
			minimum_supported_version: value.minimum_supported_version,
			notes: value.notes,
			downloads: { windows: value.windows, macos: value.macos, android: value.android }
		};
	}

	function select(release: AppRelease) {
		selected = release.version;
		form = toForm(release);
		saved = toForm(release);
		deleteOpen = false;
		deleteConfirmation = '';
	}

	function startCreate() {
		selected = 'new';
		form = emptyForm();
		// The next patch after the newest version is the usual case.
		const newest = releases[0]?.version;
		if (newest && versionPattern.test(newest)) {
			const [major, minor, patch] = newest.split('.').map(Number);
			form.version = `${major}.${minor}.${patch + 1}`;
		}
		saved = emptyForm();
		deleteOpen = false;
	}

	function validate(value: Form) {
		const version = value.version.trim().replace(/^v/, '');
		if (!versionPattern.test(version)) return 'Version must look like 1.2.3';
		const minimum = value.minimum_supported_version.trim();
		if (minimum && !versionPattern.test(minimum)) return 'Minimum version must look like 1.2.3';
		if (minimum && compareVersions(minimum, version) > 0) {
			return 'Minimum version cannot be newer than the release';
		}
		for (const url of [value.windows, value.macos, value.android]) {
			if (url.trim() && !/^https?:\/\//.test(url.trim()))
				return 'Download links must be http(s) URLs';
		}
		return '';
	}

	async function save() {
		if (formError) return;
		if (creating) {
			const created = await run(
				() => api.createRelease({ version: form.version.trim(), ...toInput(form) }),
				'Release created'
			);
			if (!created) return;
			releases = await api.releases();
			select(created);
			return;
		}
		const version = selected;
		const updated = await run(() => api.updateRelease(version, toInput(form)), 'Release saved');
		if (!updated) return;
		releases = releases.map((release) => (release.version === version ? updated : release));
		select(updated);
	}

	async function remove() {
		const version = selected;
		if (deleteConfirmation !== version) return;
		const result = await run(
			() => api.deleteRelease(version, deleteConfirmation),
			'Release deleted'
		);
		if (!result) return;
		releases = releases.filter((release) => release.version !== version);
		selected = '';
		deleteOpen = false;
		deleteConfirmation = '';
	}

	function compareVersions(a: string, b: string) {
		const left = a.split('.').map(Number);
		const right = b.split('.').map(Number);
		for (let index = 0; index < 3; index += 1) {
			if (left[index] !== right[index]) return left[index] - right[index];
		}
		return 0;
	}

	function today() {
		// Release dates are Beijing time, like the homepage shows them.
		return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
	}

	function downloadCount(release: AppRelease) {
		return Object.values(release.downloads).filter(Boolean).length;
	}
</script>

<section>
	<div class="grid gap-4 lg:grid-cols-[minmax(260px,320px)_1fr]">
		<Card.Root class="min-w-0 self-start">
			<Card.Header>
				<div class="flex items-center justify-between gap-2">
					<div class="min-w-0">
						<Card.Title>Versions</Card.Title>
						<Card.Description class="font-mono text-[12px]">
							{releases.length} · latest {latest?.version ?? 'none'}
						</Card.Description>
					</div>
					<div class="flex gap-2">
						<Button variant="outline" size="icon-sm" title="Reload" onclick={reload}>
							<RefreshCw class="size-4" />
						</Button>
						<Button size="sm" onclick={startCreate}><Plus class="size-4" /> New</Button>
					</div>
				</div>
			</Card.Header>
			<Card.Content class="space-y-1 overflow-auto px-3 max-lg:max-h-80 lg:max-h-[640px]">
				{#each releases as release (release.version)}
					<Button
						variant={selected === release.version ? 'active' : 'ghost'}
						class="h-auto w-full justify-between rounded-md px-3 py-2"
						onclick={() => select(release)}
					>
						<span class="min-w-0 text-left">
							<span class="block truncate font-mono text-sm">{release.version}</span>
							<span
								class="block truncate font-mono text-[11px] {selected === release.version
									? 'text-on-inverse/60'
									: 'text-faint'}"
								>{release.release_date || 'no date'} · {downloadCount(release)} links</span
							>
						</span>
						{#if !release.published}
							<!-- The selected row is a white pill; lime and faint badges vanish on it. -->
							<Badge variant={selected === release.version ? 'secondary' : 'outline'}>draft</Badge>
						{:else if release.version === latest?.version}
							<Badge variant={selected === release.version ? 'secondary' : 'default'}>latest</Badge>
						{/if}
					</Button>
				{/each}
				{#if releases.length === 0}
					<div
						class="rounded-md border border-dashed border-border-strong px-3 py-6 text-center text-sm text-faint"
					>
						No versions yet. Syncing a GitHub release adds one.
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if selected}
			<Card.Root class="min-w-0">
				<Card.Header>
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<Card.Title>{creating ? 'New version' : form.version}</Card.Title>
							<Card.Description>
								The newest published version is the one the homepage offers for download. Notes show
								on the homepage as that version's announcement.
							</Card.Description>
						</div>
						<Button variant="ghost" size="icon-sm" title="Close" onclick={() => (selected = '')}>
							<X class="size-4" />
						</Button>
					</div>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="space-y-1.5">
							<span class="eyebrow block">Version</span>
							<Input
								bind:value={form.version}
								placeholder="1.2.3"
								class="font-mono"
								disabled={!creating}
							/>
						</label>
						<label class="space-y-1.5">
							<span class="eyebrow block">Title</span>
							<Input
								bind:value={form.title}
								placeholder={`Gang Chat ${form.version || 'x.y.z'}`}
								maxlength={120}
							/>
						</label>
						<label class="space-y-1.5">
							<span class="eyebrow block">Release date</span>
							<Input type="date" bind:value={form.release_date} />
						</label>
						<label class="space-y-1.5">
							<span class="eyebrow block">Minimum supported version</span>
							<Input
								bind:value={form.minimum_supported_version}
								placeholder="Empty: only this version"
								class="font-mono"
							/>
						</label>
					</div>

					<label class="flex items-center gap-3 text-sm">
						<Switch bind:checked={form.published} />
						<span>
							Published
							<span class="block text-xs text-muted-foreground"
								>Drafts are hidden from the homepage and the public API.</span
							>
						</span>
					</label>

					<label class="block space-y-1.5">
						<span class="eyebrow block">Notes</span>
						<Textarea
							bind:value={form.notes}
							rows={6}
							maxlength={4000}
							placeholder="What changed. Leave empty to show no announcement."
						/>
					</label>

					<div class="space-y-2">
						<span class="eyebrow block">Downloads</span>
						{#each [{ key: 'windows', label: 'Windows' }, { key: 'macos', label: 'macOS' }, { key: 'android', label: 'Android' }] as platform (platform.key)}
							<label class="grid items-center gap-2 sm:grid-cols-[80px_1fr]">
								<span class="text-sm text-muted-foreground">{platform.label}</span>
								<Input
									bind:value={form[platform.key as 'windows' | 'macos' | 'android']}
									placeholder="https://…"
									class="font-mono text-[12px]"
								/>
							</label>
						{/each}
						<p class="text-xs text-faint">
							Syncing a GitHub release fills these in, and clears links to installers it removed.
						</p>
					</div>

					{#if formError && (dirty || creating)}
						<div
							class="rounded-md border border-warning/32 bg-warning/10 px-3 py-2 text-xs text-warning"
						>
							{formError}
						</div>
					{/if}

					<div class="flex flex-wrap gap-2">
						<Button onclick={save} disabled={!!formError || (!creating && !dirty)}>
							<Save class="size-4" />
							{creating ? 'Create version' : 'Save'}
						</Button>
						{#if !creating}
							<Button variant="outline" onclick={() => (form = { ...saved })} disabled={!dirty}>
								Revert
							</Button>
							<Button
								variant="destructive"
								class="ml-auto"
								onclick={() => {
									deleteOpen = true;
									deleteConfirmation = '';
								}}
							>
								<Trash2 class="size-4" /> Delete
							</Button>
						{/if}
					</div>

					{#if deleteOpen && !creating}
						<div
							class="rounded-lg border border-danger-border bg-danger-surface p-4 text-xs text-destructive"
						>
							<div class="eyebrow text-destructive">Confirm delete</div>
							<p class="mt-2">
								Removes {saved.version} from the homepage. Its files on the server stay.
							</p>
							<Input
								class="mt-3"
								bind:value={deleteConfirmation}
								placeholder={`type ${saved.version} to confirm`}
							/>
							<div class="mt-3 flex gap-2">
								<Button
									variant="destructive"
									onclick={remove}
									disabled={deleteConfirmation !== saved.version}
								>
									<Trash2 class="size-4" /> Delete version
								</Button>
								<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
							</div>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		{:else}
			<Card.Root>
				<Card.Content class="py-10 text-center text-sm text-faint">
					Select a version to edit its notes, downloads and visibility.
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</section>
