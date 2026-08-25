<script lang="ts">
	/**
	 * Panel opened from the drawer: a slightly translucent dark surface laid OVER the game view —
	 * the game surface is not shrunk to make room.
	 *
	 * TABS ARE OPTIONAL. Without `tabs` the panel behaves as it did before; with `tabs` a bar
	 * appears below the title and the caller decides via `tab` which body it renders. The panel
	 * deliberately does not own that state: otherwise no action inside the body could switch tabs,
	 * and remembering the choice beyond closing would only be possible in here, where nobody sees
	 * it.
	 *
	 * Keyboard handling sits on the bar, not on the window: arrow keys otherwise belong to the game
	 * surface. Escape closes — the only key the panel claims globally.
	 */
	import type { Snippet } from 'svelte';
	import type { OverlayTab } from './drawer.js';
	import { st } from './i18n.js';

	let {
		title,
		onclose,
		tabs,
		tab,
		ontab,
		children
	}: {
		title: string;
		onclose: () => void;
		/** Missing or empty == no tabs, a single body. */
		tabs?: readonly OverlayTab[];
		/** The open tab. */
		tab?: string | null;
		ontab?: (id: string) => void;
		children: Snippet;
	} = $props();

	/** Own id so that `aria-controls`/`aria-labelledby` do not collide with a second panel. */
	const uid = $props.id();
	const strip = $derived(tabs !== undefined && tabs.length > 1 ? tabs : null);
	const current = $derived(strip === null ? null : (strip.find((t) => t.id === tab) ?? strip[0]!));

	/**
	 * Arrow keys. They hang off the focused TAB, not off the tab bar — otherwise the bar itself
	 * would need a `tabindex` and would sit as a focusable shell around focusable buttons.
	 *
	 * Reaching into the DOM is deliberate: the new tab gets `tabindex="0"`, the old one `-1` — and
	 * without an explicit `focus()` the focus would be left on a button the tab key can no longer
	 * reach.
	 */
	function onkeydown(e: KeyboardEvent): void {
		if (strip === null || current === null) return;
		const at = strip.indexOf(current);
		const to =
			e.key === 'ArrowLeft'
				? (at - 1 + strip.length) % strip.length
				: e.key === 'ArrowRight'
					? (at + 1) % strip.length
					: e.key === 'Home'
						? 0
						: e.key === 'End'
							? strip.length - 1
							: -1;
		if (to < 0) return;
		e.preventDefault();
		ontab?.(strip[to]!.id);
		const buttons = (e.currentTarget as HTMLElement).parentElement?.querySelectorAll('button');
		(buttons?.[to] as HTMLElement | undefined)?.focus();
	}
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape') onclose();
	}}
/>

<div class="overlay">
	<div class="panel">
		<header>
			<h2>{title}</h2>
			<button type="button" onclick={onclose} aria-label={st('overlay.close')}>×</button>
		</header>

		{#if strip !== null}
			<div class="tabs" role="tablist" aria-label={title}>
				{#each strip as t (t.id)}
					<button
						type="button"
						role="tab"
						id="{uid}-tab-{t.id}"
						aria-controls="{uid}-panel"
						aria-selected={t.id === current?.id}
						tabindex={t.id === current?.id ? 0 : -1}
						class:active={t.id === current?.id}
						onclick={() => ontab?.(t.id)}
						{onkeydown}
					>
						{st(t.labelKey)}
					</button>
				{/each}
			</div>
		{/if}

		{#if strip === null}
			<div class="body">
				{@render children()}
			</div>
		{:else}
			<div
				class="body"
				id="{uid}-panel"
				role="tabpanel"
				aria-labelledby="{uid}-tab-{current?.id}"
			>
				{@render children()}
			</div>
		{/if}
	</div>
</div>

<style>
	.overlay {
		position: absolute;
		inset: 0;
		background: var(--overlay);
		display: grid;
		place-items: start center;
		padding: 2rem 1rem;
		overflow: auto;
		z-index: 10;
	}

	.panel {
		width: min(36rem, 100%);
		background: var(--bg-raised);
		border: 1px solid var(--line);
		box-shadow: 0 0 0 1px #000;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--line);
		background: var(--bg-sunken);
	}

	h2 {
		margin: 0;
		font-size: 1em;
		font-weight: normal;
		color: var(--amber);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	header button {
		border: none;
		background: none;
		padding: 0 0.4rem;
		font-size: 1.2em;
		line-height: 1;
	}

	.tabs {
		display: flex;
		gap: 1px;
		padding: 0 0.5rem;
		background: var(--bg-sunken);
		border-bottom: 1px solid var(--line);
	}

	.tabs button {
		border: none;
		border-bottom: 2px solid transparent;
		background: none;
		padding: 0.35rem 0.7rem;
		color: var(--fg-dim);
	}

	.tabs button:hover {
		color: var(--accent);
	}

	.tabs button.active {
		color: var(--amber);
		border-bottom-color: var(--amber);
	}

	.body {
		padding: 0.75rem;
		display: grid;
		gap: 0.75rem;
	}
</style>
