<script lang="ts">
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/utils.js';

	type InputType = Exclude<HTMLInputTypeAttribute, 'file'>;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, 'type'> &
			({ type: 'file'; files?: FileList } | { type?: InputType; files?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		class: className,
		'data-slot': dataSlot = 'input',
		...restProps
	}: Props = $props();
</script>

{#if type === 'file'}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'border-input bg-field hover:border-field-border-hover focus-visible:border-signal focus-visible:ring-signal/15 aria-invalid:ring-destructive/20 aria-invalid:border-destructive disabled:opacity-50 h-9 rounded-full border py-1 pl-1.5 pr-4 text-base text-foreground transition-colors focus-visible:ring-3 aria-invalid:ring-3 md:text-sm placeholder:text-faint w-full min-w-0 outline-none disabled:pointer-events-none disabled:cursor-not-allowed text-muted-foreground cursor-pointer file:bg-surface-raised file:text-foreground file:mr-3 file:h-[26px] file:cursor-pointer file:rounded-full file:border-0 file:px-3 file:text-xs file:font-medium hover:file:bg-surface-hover',
			className
		)}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'border-input bg-field hover:border-field-border-hover focus-visible:border-signal focus-visible:ring-signal/15 aria-invalid:ring-destructive/20 aria-invalid:border-destructive disabled:opacity-50 h-9 rounded-full border px-4 py-1 text-base text-foreground transition-colors focus-visible:ring-3 aria-invalid:ring-3 md:text-sm placeholder:text-faint w-full min-w-0 outline-none disabled:pointer-events-none disabled:cursor-not-allowed',
			className
		)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
