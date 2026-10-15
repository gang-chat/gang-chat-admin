<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	export const badgeVariants = tv({
		// SignalTag: a monospace uppercase capsule.
		base: 'h-5 gap-1 rounded-full border px-2 font-mono text-[10.5px] font-bold tracking-[0.08em] uppercase transition-colors has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap focus-visible:ring-[3px] [&>svg]:pointer-events-none',
		variants: {
			variant: {
				// Live: the lime signal.
				default: 'border-signal/28 bg-signal/10 text-signal',
				secondary: 'border-muted-foreground/28 bg-muted-foreground/10 text-muted-foreground',
				destructive: 'border-destructive/32 bg-destructive/10 text-destructive',
				warning: 'border-warning/32 bg-warning/10 text-warning',
				outline: 'border-border-strong bg-transparent text-faint',
				ghost: 'border-transparent text-muted-foreground hover:bg-surface-hover',
				link: 'border-transparent text-signal underline-offset-4 hover:underline'
			}
		},
		defaultVariants: {
			variant: 'default'
		}
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];
</script>

<script lang="ts">
	import type { HTMLAnchorAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = 'default',
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		variant?: BadgeVariant;
	} = $props();
</script>

<svelte:element
	this={href ? 'a' : 'span'}
	bind:this={ref}
	data-slot="badge"
	{href}
	class={cn(badgeVariants({ variant }), className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
