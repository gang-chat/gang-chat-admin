<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLThAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLThAttributes> = $props();
</script>

<th
	bind:this={ref}
	data-slot="table-head"
	class={cn(
		'text-faint h-9 px-3 text-left align-middle font-mono text-[10.5px] font-bold tracking-[0.12em] uppercase whitespace-nowrap [&:has([role=checkbox])]:pr-0',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</th>
