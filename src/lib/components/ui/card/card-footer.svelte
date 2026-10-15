<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="card-footer"
	class={cn(
		'bg-card rounded-b-xl border-t px-5 py-4 group-data-[size=sm]/card:px-4 group-data-[size=sm]/card:py-3 flex items-center',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
