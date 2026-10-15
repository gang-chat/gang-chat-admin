<script lang="ts" module>
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { type VariantProps, tv } from 'tailwind-variants';

	export const buttonVariants = tv({
		base: "focus-visible:border-signal focus-visible:ring-signal/15 aria-invalid:ring-destructive/20 aria-invalid:border-destructive rounded-full border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 aria-invalid:ring-3 [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-[120ms] outline-none select-none disabled:pointer-events-none disabled:border-disabled-border disabled:bg-disabled-surface disabled:text-faint disabled:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				// Signal primary: the lime signal with dark text.
				default:
					'bg-primary text-primary-foreground border-primary hover:shadow-glow active:bg-signal-strong active:border-signal-strong active:shadow-none font-semibold',
				// Signal neutral: a dark capsule.
				outline:
					'border-border-strong bg-surface text-foreground hover:bg-surface-hover active:bg-surface-pressed aria-expanded:bg-surface-hover',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-surface-hover active:bg-surface-pressed aria-expanded:bg-surface-hover',
				ghost:
					'text-muted-foreground hover:bg-surface-hover hover:text-foreground active:bg-surface-pressed aria-expanded:bg-surface-hover aria-expanded:text-foreground disabled:border-transparent disabled:bg-transparent',
				// Selected item: the inverse white pill.
				active: 'bg-inverse text-on-inverse hover:bg-inverse active:bg-[#dcdcd8]',
				destructive:
					'bg-danger-surface border-danger-border text-destructive hover:bg-[#341213] active:bg-[#170708] focus-visible:border-destructive focus-visible:ring-destructive/20',
				link: 'text-signal underline-offset-4 hover:underline disabled:border-transparent disabled:bg-transparent'
			},
			size: {
				default:
					'h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
				xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1 px-3 text-[13px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
				lg: 'h-10 gap-1.5 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4',
				icon: 'size-9',
				'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
				'icon-sm': 'size-8',
				'icon-lg': 'size-10'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? 'link' : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
