<script lang="ts">
	import {
		ChevronLeft,
		ChevronRight,
		KeyRound,
		LogOut,
		Plus,
		RefreshCw,
		Search,
		ShieldOff,
		Trash2,
		UserCheck,
		X
	} from '@lucide/svelte';
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
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
		GangAccount,
		GangAccountDetail,
		GangAccountStatus,
		GangAccountUpdateInput,
		GangRoomRole,
		GangRoomSummary
	} from '$lib/shared/ops-types';
	import type { RunTask } from './types';

	let {
		api,
		mysqlConnections,
		currentRole,
		run
	}: {
		api: ApiClient;
		mysqlConnections: ConnectionPreset[];
		currentRole?: AuthRole;
		run: RunTask;
	} = $props();

	type StatusFilter = 'all' | 'active' | 'suspended';
	type PendingAction =
		| { kind: 'suspend' }
		| { kind: 'reactivate' }
		| { kind: 'signout' }
		| { kind: 'remove'; roomId: string; roomName: string }
		| { kind: 'owner'; roomId: string; roomName: string };

	const pageSize = 25;
	const statusFilters: Array<{ id: StatusFilter; label: string }> = [
		{ id: 'all', label: 'All' },
		{ id: 'active', label: 'Active' },
		{ id: 'suspended', label: 'Suspended' }
	];
	const roleLabels: Record<GangRoomRole, string> = {
		owner: 'Owner',
		admin: 'Admin',
		member: 'Member'
	};

	let query = $state('');
	let statusFilter = $state<StatusFilter>('all');
	let offset = $state(0);
	let total = $state(0);
	let accounts = $state<GangAccount[]>([]);
	let loadedFor = $state('');
	let selectedId = $state('');
	let detail = $state<GangAccountDetail | undefined>();
	let profile = $state({ username: '', email: '', displayName: '', emailVerified: false });
	let draft = $state({ username: '', email: '', displayName: '', password: '' });
	let newPassword = $state('');
	let deleteOpen = $state(false);
	let deleteConfirmation = $state('');
	let pending = $state<PendingAction | undefined>();
	let roomQuery = $state('');
	let roomResults = $state<GangRoomSummary[]>([]);
	let addRole = $state<'member' | 'admin'>('member');

	let connection = $derived(mysqlConnections[0]);
	let writesAllowed = $derived(
		Boolean(
			connection?.config &&
			'allowMutations' in connection.config &&
			connection.config.allowMutations
		)
	);
	let canOperate = $derived(
		writesAllowed && (currentRole === 'operator' || currentRole === 'admin')
	);
	let canDelete = $derived(writesAllowed && currentRole === 'admin');
	let editable = $derived(canOperate && !!detail && !detail.isSuperuser);
	let memberRoomIds = $derived(new Set(detail?.memberships.map((item) => item.roomId) ?? []));
	let profilePatch = $derived(buildProfilePatch());
	let canPageBackward = $derived(offset > 0);
	let canPageForward = $derived(offset + accounts.length < total);

	$effect(() => {
		const id = connection?.id ?? '';
		if (id && loadedFor !== id) {
			loadedFor = id;
			void loadAccounts();
		}
	});

	async function loadAccounts(resetPage = false) {
		if (resetPage) offset = 0;
		await run(async () => {
			const result = await api.accounts({
				q: query.trim() || undefined,
				status: statusFilter,
				limit: pageSize,
				offset
			});
			accounts = result.items;
			total = result.total;
		});
	}

	function setStatusFilter(next: StatusFilter) {
		statusFilter = next;
		void loadAccounts(true);
	}

	function previousPage() {
		offset = Math.max(0, offset - pageSize);
		void loadAccounts();
	}

	function nextPage() {
		offset += pageSize;
		void loadAccounts();
	}

	async function selectAccount(id: string) {
		selectedId = id;
		resetPanels();
		await run(async () => {
			showDetail(await api.account(id));
		});
	}

	function startCreate() {
		selectedId = 'new';
		detail = undefined;
		draft = { username: '', email: '', displayName: '', password: '' };
		resetPanels();
	}

	function resetPanels() {
		newPassword = '';
		deleteOpen = false;
		deleteConfirmation = '';
		pending = undefined;
		roomQuery = '';
		roomResults = [];
	}

	function showDetail(next: GangAccountDetail) {
		detail = next;
		profile = {
			username: next.username,
			email: next.email,
			displayName: next.displayName ?? '',
			emailVerified: next.emailVerified
		};
		accounts = accounts.map((item) => (item.id === next.id ? next : item));
	}

	function buildProfilePatch(): GangAccountUpdateInput {
		if (!detail) return {};
		const patch: GangAccountUpdateInput = {};
		if (profile.username.trim() !== detail.username) patch.username = profile.username;
		if (profile.email.trim() !== detail.email) patch.email = profile.email;
		if (profile.displayName.trim() !== (detail.displayName ?? ''))
			patch.displayName = profile.displayName;
		if (profile.emailVerified !== detail.emailVerified) patch.emailVerified = profile.emailVerified;
		return patch;
	}

	async function saveProfile() {
		if (!detail || Object.keys(profilePatch).length === 0) return;
		const id = detail.id;
		const patch = profilePatch;
		await run(async () => {
			showDetail(await api.updateAccount(id, patch));
		}, 'Account updated');
	}

	async function createAccount() {
		const created = await run(
			() =>
				api.createAccount({
					username: draft.username,
					email: draft.email,
					password: draft.password,
					displayName: draft.displayName || undefined
				}),
			'Account created'
		);
		if (!created) return;
		selectedId = created.id;
		showDetail(created);
		await loadAccounts(true);
	}

	function generatePassword() {
		const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
	}

	async function confirmPending() {
		if (!detail || !pending) return;
		const id = detail.id;
		const action = pending;
		pending = undefined;
		if (action.kind === 'suspend' || action.kind === 'reactivate') {
			const status = action.kind === 'suspend' ? 'suspended' : 'active';
			await run(
				async () => showDetail(await api.updateAccount(id, { status })),
				action.kind === 'suspend' ? 'Account suspended and signed out' : 'Account reactivated'
			);
		} else if (action.kind === 'signout') {
			await run(async () => {
				const result = await api.revokeAccountSessions(id);
				showDetail(await api.account(id));
				return result;
			}, 'Signed out everywhere');
		} else if (action.kind === 'remove') {
			await run(async () => {
				await api.removeAccountMembership(id, action.roomId);
				showDetail(await api.account(id));
			}, `Removed from ${action.roomName}`);
		} else {
			await changeRole(action.roomId, 'owner');
		}
	}

	async function changeRole(roomId: string, role: GangRoomRole) {
		if (!detail) return;
		const id = detail.id;
		await run(async () => {
			await api.updateAccountMembership(id, roomId, role);
			showDetail(await api.account(id));
		}, 'Room role updated');
	}

	function requestRole(roomId: string, roomName: string, role: string) {
		if (role === 'owner') pending = { kind: 'owner', roomId, roomName };
		else void changeRole(roomId, role as GangRoomRole);
	}

	async function resetPassword() {
		if (!detail || newPassword.length < 8) return;
		const id = detail.id;
		const password = newPassword;
		const result = await run(
			() => api.resetAccountPassword(id, password),
			'Password reset; the account was signed out everywhere'
		);
		if (!result) return;
		newPassword = '';
		await run(async () => showDetail(await api.account(id)));
	}

	async function deleteAccount() {
		if (!detail || deleteConfirmation !== detail.username) return;
		const id = detail.id;
		const confirmation = deleteConfirmation;
		const result = await run(() => api.deleteAccount(id, confirmation), 'Account deleted');
		if (!result) return;
		selectedId = '';
		detail = undefined;
		resetPanels();
		await loadAccounts();
	}

	async function searchRooms() {
		await run(async () => {
			roomResults = await api.accountRooms(roomQuery.trim());
		});
	}

	async function addToRoom(room: GangRoomSummary) {
		if (!detail) return;
		const id = detail.id;
		const role = addRole;
		await run(async () => {
			await api.addAccountMembership(id, room.id, role);
			showDetail(await api.account(id));
			roomResults = await api.accountRooms(roomQuery.trim());
		}, `Added to ${room.name}`);
	}

	function statusVariant(status: GangAccountStatus): BadgeVariant {
		if (status === 'suspended') return 'warning';
		if (status === 'deleted') return 'destructive';
		return 'secondary';
	}

	function initial(account: GangAccount) {
		return (account.displayName || account.username).trim().charAt(0).toUpperCase() || '?';
	}

	function formatDate(value: string | undefined) {
		if (!value) return '—';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, {
			year: 'numeric',
			month: 'short',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	}
</script>

<section>
	{#if !connection}
		<Card.Root>
			<Card.Content class="text-sm text-muted-foreground">
				<div class="font-medium text-foreground">Account admin unavailable</div>
				<div class="mt-1">
					Accounts are read and changed in the Gang Chat database. Add <code
						class="font-mono text-[13px] text-foreground">connections.mysql</code
					> in config.json and restart.
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		{#if !writesAllowed}
			<div
				class="mb-4 rounded-md border border-warning/32 bg-warning/10 px-4 py-2.5 text-sm text-warning"
			>
				Read only. Set <code class="font-mono text-[13px]">allowMutations</code> on
				<code class="font-mono text-[13px]">connections.mysql</code> to change accounts.
			</div>
		{/if}
		<div class="grid gap-4 lg:grid-cols-[minmax(320px,400px)_1fr]">
			<Card.Root class="min-w-0 self-start">
				<Card.Header>
					<div class="flex items-center justify-between gap-2">
						<div class="min-w-0">
							<Card.Title>Gang Chat accounts</Card.Title>
							<Card.Description class="font-mono text-[12px]">{total} found</Card.Description>
						</div>
						<Button size="sm" onclick={startCreate} disabled={!canOperate}>
							<Plus class="size-4" /> New
						</Button>
					</div>
				</Card.Header>
				<Card.Content class="space-y-3">
					<div class="flex gap-2">
						<Input
							bind:value={query}
							placeholder="Username, email, name or UID"
							onkeydown={(event) => {
								if (event.key === 'Enter') void loadAccounts(true);
							}}
						/>
						<Button variant="outline" size="icon" title="Search" onclick={() => loadAccounts(true)}>
							<Search class="size-4" />
						</Button>
					</div>
					<!-- SegmentedControl: the inverse pill marks the selected filter. -->
					<div
						class="inline-flex rounded-full border border-border bg-surface-pressed p-1"
						role="group"
						aria-label="Account status"
					>
						{#each statusFilters as filter (filter.id)}
							<button
								type="button"
								class="h-7 rounded-full px-3 text-[13px] font-medium transition-colors {statusFilter ===
								filter.id
									? 'bg-inverse text-on-inverse'
									: 'text-muted-foreground hover:text-foreground'}"
								aria-pressed={statusFilter === filter.id}
								onclick={() => setStatusFilter(filter.id)}
							>
								{filter.label}
							</button>
						{/each}
					</div>
					<div class="max-h-[560px] space-y-1 overflow-y-auto">
						{#each accounts as account (account.id)}
							<button
								type="button"
								class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors {selectedId ===
								account.id
									? 'bg-inverse text-on-inverse'
									: 'hover:bg-surface-hover'}"
								onclick={() => selectAccount(account.id)}
							>
								<span
									class="grid size-8 shrink-0 place-items-center rounded-full font-display text-[13px] font-bold {selectedId ===
									account.id
										? 'bg-on-inverse/10'
										: 'bg-surface-raised text-foreground'}">{initial(account)}</span
								>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium"
										>{account.displayName || account.username}</span
									>
									<span
										class="block truncate font-mono text-[11px] {selectedId === account.id
											? 'text-on-inverse/60'
											: 'text-faint'}">@{account.username} · {account.uid}</span
									>
								</span>
								{#if account.isSuperuser}
									<Badge variant="outline">super</Badge>
								{:else if account.status !== 'active'}
									<Badge variant={statusVariant(account.status)}>{account.status}</Badge>
								{/if}
							</button>
						{/each}
						{#if accounts.length === 0}
							<div
								class="rounded-md border border-dashed border-border-strong px-3 py-6 text-center text-sm text-faint"
							>
								No accounts match.
							</div>
						{/if}
					</div>
					<div class="flex items-center justify-between gap-2">
						<span class="font-mono text-[11px] text-faint">
							{total ? `${offset + 1}–${offset + accounts.length} of ${total}` : ''}
						</span>
						<div class="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								onclick={previousPage}
								disabled={!canPageBackward}
							>
								<ChevronLeft class="size-4" /> Prev
							</Button>
							<Button variant="outline" size="sm" onclick={nextPage} disabled={!canPageForward}>
								Next <ChevronRight class="size-4" />
							</Button>
						</div>
					</div>
				</Card.Content>
			</Card.Root>

			<div class="min-w-0 space-y-4">
				{#if selectedId === 'new'}
					<Card.Root>
						<Card.Header>
							<div class="flex items-center justify-between gap-2">
								<div>
									<Card.Title>New account</Card.Title>
									<Card.Description
										>Created active with a verified email, like a normal sign-up.</Card.Description
									>
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									title="Cancel"
									onclick={() => (selectedId = '')}
								>
									<X class="size-4" />
								</Button>
							</div>
						</Card.Header>
						<Card.Content class="grid gap-3 sm:grid-cols-2">
							<label class="space-y-1.5">
								<span class="eyebrow block">Username</span>
								<Input bind:value={draft.username} placeholder="3-32 letters, digits, _ or -" />
							</label>
							<label class="space-y-1.5">
								<span class="eyebrow block">Email</span>
								<Input type="email" bind:value={draft.email} placeholder="name@example.com" />
							</label>
							<label class="space-y-1.5">
								<span class="eyebrow block">Display name</span>
								<Input bind:value={draft.displayName} placeholder="Defaults to the username" />
							</label>
							<label class="space-y-1.5">
								<span class="eyebrow block">Password</span>
								<div class="flex gap-2">
									<Input bind:value={draft.password} placeholder="8+ characters" />
									<Button
										variant="outline"
										onclick={() => (draft.password = generatePassword())}
										title="Generate a password">Generate</Button
									>
								</div>
							</label>
							<div class="sm:col-span-2">
								<Button
									onclick={createAccount}
									disabled={!canOperate ||
										!draft.username.trim() ||
										!draft.email.trim() ||
										draft.password.length < 8}
								>
									<Plus class="size-4" /> Create account
								</Button>
							</div>
						</Card.Content>
					</Card.Root>
				{:else if detail}
					<Card.Root>
						<Card.Header>
							<div class="flex flex-wrap items-start justify-between gap-3">
								<div class="flex min-w-0 items-center gap-3">
									<span
										class="grid size-12 shrink-0 place-items-center rounded-full bg-surface-raised font-display text-lg font-bold"
										>{initial(detail)}</span
									>
									<div class="min-w-0">
										<Card.Title class="truncate text-[21px]"
											>{detail.displayName || detail.username}</Card.Title
										>
										<Card.Description class="font-mono text-[12px]"
											>@{detail.username} · UID {detail.uid}</Card.Description
										>
									</div>
								</div>
								<div class="flex flex-wrap items-center gap-2">
									{#if detail.isSuperuser}<Badge variant="outline">super user</Badge>{/if}
									<Badge variant={statusVariant(detail.status)}>{detail.status}</Badge>
									<Button
										variant="ghost"
										size="icon-sm"
										title="Reload"
										onclick={() => selectAccount(detail!.id)}
									>
										<RefreshCw class="size-4" />
									</Button>
								</div>
							</div>
						</Card.Header>
						<Card.Content class="space-y-5">
							<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
								{#each [['Created', formatDate(detail.createdAt)], ['Last seen', formatDate(detail.lastSeenAt)], ['Active sessions', String(detail.activeSessionCount)], ['Rooms', String(detail.roomCount)]] as [label, value] (label)}
									<div class="rounded-md border border-border bg-card px-3 py-2.5">
										<dt class="eyebrow">{label}</dt>
										<dd class="mt-1 font-mono text-[13px] text-foreground">{value}</dd>
									</div>
								{/each}
							</dl>

							{#if detail.isSuperuser}
								<div
									class="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
								>
									The super user is managed by the Gang Chat server, which resets it on every start,
									so it is read only here.
								</div>
							{/if}

							<div class="grid gap-3 sm:grid-cols-2">
								<label class="space-y-1.5">
									<span class="eyebrow block">Username</span>
									<Input bind:value={profile.username} disabled={!editable} />
								</label>
								<label class="space-y-1.5">
									<span class="eyebrow block">Display name</span>
									<Input bind:value={profile.displayName} disabled={!editable} />
								</label>
								<label class="space-y-1.5">
									<span class="eyebrow block">Email</span>
									<Input type="email" bind:value={profile.email} disabled={!editable} />
								</label>
								<div class="flex items-end gap-3 pb-2">
									<label class="flex items-center gap-2 text-sm text-muted-foreground">
										<Checkbox bind:checked={profile.emailVerified} disabled={!editable} />
										Email verified
									</label>
								</div>
							</div>
							<div class="flex flex-wrap gap-2">
								<Button
									onclick={saveProfile}
									disabled={!editable || Object.keys(profilePatch).length === 0}
								>
									Save changes
								</Button>
								{#if Object.keys(profilePatch).length > 0}
									<Button variant="outline" onclick={() => detail && showDetail(detail)}>
										Discard
									</Button>
								{/if}
							</div>
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Header>
							<Card.Title>Access</Card.Title>
							<Card.Description
								>Suspending or resetting the password signs the account out everywhere.</Card.Description
							>
						</Card.Header>
						<Card.Content class="space-y-4">
							<div class="flex flex-wrap gap-2">
								{#if detail.status === 'active'}
									<Button
										variant="outline"
										onclick={() => (pending = { kind: 'suspend' })}
										disabled={!editable}
									>
										<ShieldOff class="size-4" /> Suspend
									</Button>
								{:else}
									<Button
										variant="outline"
										onclick={() => (pending = { kind: 'reactivate' })}
										disabled={!editable}
									>
										<UserCheck class="size-4" /> Reactivate
									</Button>
								{/if}
								<Button
									variant="outline"
									onclick={() => (pending = { kind: 'signout' })}
									disabled={!canOperate || detail.activeSessionCount === 0}
								>
									<LogOut class="size-4" /> Sign out everywhere
								</Button>
								<Button
									variant="destructive"
									onclick={() => {
										deleteOpen = !deleteOpen;
										deleteConfirmation = '';
									}}
									disabled={!canDelete || detail.isSuperuser}
								>
									<Trash2 class="size-4" /> Delete account
								</Button>
							</div>

							{#if pending && (pending.kind === 'suspend' || pending.kind === 'reactivate' || pending.kind === 'signout')}
								<div
									class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-strong bg-card px-4 py-3 text-sm"
								>
									<span>
										{#if pending.kind === 'suspend'}
											Suspend @{detail.username}? They are signed out and can't sign in until
											reactivated.
										{:else if pending.kind === 'reactivate'}
											Reactivate @{detail.username}? They can sign in again.
										{:else}
											Sign @{detail.username} out of all {detail.activeSessionCount} sessions?
										{/if}
									</span>
									<span class="flex gap-2">
										<Button size="sm" onclick={confirmPending}>Confirm</Button>
										<Button variant="outline" size="sm" onclick={() => (pending = undefined)}
											>Cancel</Button
										>
									</span>
								</div>
							{/if}

							<div class="flex flex-wrap items-end gap-2">
								<label class="min-w-[220px] flex-1 space-y-1.5">
									<span class="eyebrow block">New password</span>
									<Input
										bind:value={newPassword}
										placeholder="8+ characters"
										disabled={!editable}
									/>
								</label>
								<Button
									variant="outline"
									onclick={() => (newPassword = generatePassword())}
									disabled={!editable}>Generate</Button
								>
								<Button onclick={resetPassword} disabled={!editable || newPassword.length < 8}>
									<KeyRound class="size-4" /> Reset password
								</Button>
							</div>

							{#if deleteOpen}
								<div
									class="rounded-lg border border-danger-border bg-danger-surface p-4 text-xs text-destructive"
								>
									<div class="eyebrow text-destructive">Delete account</div>
									<p class="mt-2 text-[13px] leading-relaxed">
										Permanently deletes @{detail.username} and their room memberships, sessions and settings.
										Their messages stay, shown with a snapshot of their name. This can't be undone.
									</p>
									<Input
										class="mt-3"
										bind:value={deleteConfirmation}
										placeholder={`type ${detail.username} to confirm`}
									/>
									<div class="mt-3 flex gap-2">
										<Button
											variant="destructive"
											onclick={deleteAccount}
											disabled={!canDelete || deleteConfirmation !== detail.username}
										>
											<Trash2 class="size-4" /> Delete permanently
										</Button>
										<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
									</div>
								</div>
							{/if}
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Header>
							<Card.Title>Rooms and roles</Card.Title>
							<Card.Description>
								Owner is the room's creator. Making someone owner turns the current owner into an
								admin.
							</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-4">
							{#if detail.memberships.length}
								<Table.Root>
									<Table.Header>
										<Table.Row>
											<Table.Head>Room</Table.Head>
											<Table.Head>RID</Table.Head>
											<Table.Head>Role</Table.Head>
											<Table.Head>Joined</Table.Head>
											<Table.Head></Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each detail.memberships as membership (membership.roomId)}
											<Table.Row>
												<Table.Cell>
													<div class="flex items-center gap-2">
														<span
															class="grid size-7 shrink-0 place-items-center rounded-sm bg-surface-raised font-display text-[12px] font-bold"
															>{membership.roomName.charAt(0).toUpperCase()}</span
														>
														<span class="truncate">{membership.roomName}</span>
													</div>
												</Table.Cell>
												<Table.Cell class="font-mono text-[12px] text-muted-foreground"
													>{membership.rid}</Table.Cell
												>
												<Table.Cell>
													<!-- Remount when a pending owner change is cancelled so the menu shows the real role. -->
													{#key `${membership.role}:${pending?.kind === 'owner' && pending.roomId === membership.roomId}`}
														<Select.Root
															type="single"
															value={membership.role}
															onValueChange={(value) =>
																requestRole(membership.roomId, membership.roomName, value)}
															disabled={!editable || membership.role === 'owner'}
														>
															<Select.Trigger
																size="sm"
																class="w-[116px]"
																aria-label={`Role in ${membership.roomName}`}
															>
																{roleLabels[membership.role]}
															</Select.Trigger>
															<Select.Content>
																{#each ['member', 'admin', 'owner'] as role (role)}
																	<Select.Item value={role}
																		>{roleLabels[role as GangRoomRole]}</Select.Item
																	>
																{/each}
															</Select.Content>
														</Select.Root>
													{/key}
												</Table.Cell>
												<Table.Cell class="font-mono text-[12px] text-muted-foreground"
													>{formatDate(membership.joinedAt)}</Table.Cell
												>
												<Table.Cell class="text-right">
													<Button
														variant="destructive"
														size="icon-xs"
														title="Remove from room"
														onclick={() =>
															(pending = {
																kind: 'remove',
																roomId: membership.roomId,
																roomName: membership.roomName
															})}
														disabled={!editable || membership.role === 'owner'}
													>
														<X class="size-3" />
													</Button>
												</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							{:else}
								<div
									class="rounded-md border border-dashed border-border-strong px-3 py-6 text-center text-sm text-faint"
								>
									Not in any room.
								</div>
							{/if}

							{#if pending && (pending.kind === 'remove' || pending.kind === 'owner')}
								<div
									class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-strong bg-card px-4 py-3 text-sm"
								>
									<span>
										{#if pending.kind === 'remove'}
											Remove @{detail.username} from {pending.roomName}?
										{:else}
											Make @{detail.username} the owner of {pending.roomName}? The current owner
											becomes an admin.
										{/if}
									</span>
									<span class="flex gap-2">
										<Button size="sm" onclick={confirmPending}>Confirm</Button>
										<Button variant="outline" size="sm" onclick={() => (pending = undefined)}
											>Cancel</Button
										>
									</span>
								</div>
							{/if}

							<div class="space-y-3 rounded-lg border border-border bg-card p-4">
								<div class="eyebrow">Add to a room</div>
								<div class="flex flex-wrap gap-2">
									<Input
										class="min-w-[200px] flex-1"
										bind:value={roomQuery}
										placeholder="Room name or RID"
										disabled={!editable}
										onkeydown={(event) => {
											if (event.key === 'Enter') void searchRooms();
										}}
									/>
									<Button variant="outline" onclick={searchRooms} disabled={!editable}>
										<Search class="size-4" /> Find
									</Button>
									<Select.Root
										type="single"
										value={addRole}
										onValueChange={(value) => (addRole = value as 'member' | 'admin')}
									>
										<Select.Trigger class="w-[116px]" aria-label="Role for the new room">
											{roleLabels[addRole]}
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="member">Member</Select.Item>
											<Select.Item value="admin">Admin</Select.Item>
										</Select.Content>
									</Select.Root>
								</div>
								{#if roomResults.length}
									<div class="space-y-1">
										{#each roomResults as room (room.id)}
											<div
												class="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-surface-hover"
											>
												<span class="min-w-0 truncate text-sm">
													{room.name}
													<span class="ml-2 font-mono text-[11px] text-faint"
														>{room.rid} · {room.memberCount} members</span
													>
												</span>
												<Button
													size="sm"
													variant="outline"
													onclick={() => addToRoom(room)}
													disabled={!editable || memberRoomIds.has(room.id)}
												>
													{memberRoomIds.has(room.id) ? 'Joined' : 'Add'}
												</Button>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						</Card.Content>
					</Card.Root>
				{:else}
					<Card.Root>
						<Card.Content class="py-10 text-center text-sm text-faint">
							Select an account to see its profile, access and rooms.
						</Card.Content>
					</Card.Root>
				{/if}
			</div>
		</div>
	{/if}
</section>
