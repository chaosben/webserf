<script lang="ts">
	import { resolve } from "$app/paths";
	import { updates } from "$lib/shell/update.svelte.js";

	let { children } = $props();

	/*
		Watching the service worker belongs to the layout rather than the page: it needs nothing from
		the page, and here it exists exactly once no matter what the page shows.
	*/
	$effect(() => updates.watch());
</script>

<svelte:head>
	<link rel="icon" href="{resolve('/')}favicon.ico" sizes="48x48" />
	<link rel="icon" type="image/png" href="{resolve('/')}icon-32.png" sizes="32x32" />
	<link rel="icon" type="image/png" href="{resolve('/')}icon-16.png" sizes="16x16" />
	<link rel="apple-touch-icon" href="{resolve('/')}apple-touch-icon.png" />
	<!--
		The short name for the browser tab. The long, descriptive title for search engines sits in
		`app.html` — it has to be in the delivered HTML, which this head is not (`ssr = false`).
	-->
	<title>webserf</title>
</svelte:head>

{@render children()}

<style>
	/* The application is the whole page: no document scrolling, no margins. */
	:global(html),
	:global(body) {
		height: 100%;
		margin: 0;
		overflow: hidden;
	}

	:global(:root) {
		/* Dark DOS look: near-black ground, muted phosphor green, amber as the accent. */
		--bg: #0a0b0a;
		--bg-raised: #141614;
		--bg-sunken: #060706;
		--line: #2a2f2a;
		--fg: #c2ccc0;
		--fg-dim: #7d867c;
		--accent: #86c06a;
		--accent-dim: #4c7a3c;
		--amber: #d7a03c;
		--danger: #c9583f;
		--overlay: rgb(6 8 6 / 82%);
		/*
		 * Rising and falling. Tokens of their own although the green matches `--accent`: that one
		 * means "touched/active" everywhere else, and a shared token would tie two unrelated
		 * meanings together. The red is lighter than `--danger`, because a single glyph on a dark
		 * plate needs more luminance than a button label does.
		 */

		color-scheme: dark;
		background: var(--bg);
		color: var(--fg);
		font-family: ui-monospace, "DejaVu Sans Mono", "Courier New", monospace;
		font-size: 13px;
	}

	/* Pixels stay pixels — this holds for every canvas of the game surface. */
	:global(canvas) {
		image-rendering: pixelated;
	}

	:global(button) {
		font: inherit;
		color: inherit;
		background: var(--bg-raised);
		border: 1px solid var(--line);
		padding: 0.25rem 0.6rem;
		cursor: pointer;
	}

	:global(button:hover:not(:disabled)) {
		border-color: var(--accent-dim);
		color: var(--accent);
	}

	:global(button:disabled) {
		color: var(--fg-dim);
		cursor: default;
	}
</style>
