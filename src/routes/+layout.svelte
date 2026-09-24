<script lang="ts">
	import { resolve } from "$app/paths";
	import { updates } from "$lib/shell/update.svelte.js";
	import { settings } from "$lib/settings/settings.svelte.js";

	let { children } = $props();

	/*
		Watching the service worker belongs to the layout rather than the page: it needs nothing from
		the page, and here it exists exactly once no matter what the page shows.
	*/
	$effect(() => updates.watch());

	/*
		The chosen size of the shell, as one property on the document root — every `rem` below hangs
		off it. Here for the same reason as the worker above: the layout exists exactly once, whatever
		the page shows.

		It is the replacement for a page zoom, which `app.html` turns off: over the game view a pinch
		means "zoom the map", so a zoomed page could only push the rail and the control bar out of
		reach.
	*/
	$effect(() => {
		document.documentElement.style.setProperty("--ui-scale", String(settings.value.uiScale));
	});
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

		/*
			TWO SIZES, and keeping them apart is the point.

			`font-size` is the shell's — rail, panels, their text — and it is meant to move: `--ui-base`
			is larger where the pointer is a finger, `--ui-scale` is what the settings offer.

			`--game-px` is the game's and stands still. What our own plates over the game surface show
			are 16-pixel sprites at their true size, so their text and padding are measured against a
			fixed pixel base and against the control bar's scale — never against the shell, which would
			let them drift apart from the pictures beside them.
		*/
		--game-px: 13px;
		font-size: calc(var(--ui-base, 13px) * var(--ui-scale, 1));
	}

	/*
		A finger needs more than a mouse: bigger type, and with it bigger hit areas, since the rail and
		the buttons are measured in `rem`. Deliberately not a width condition — the reason is the
		pointer, not the window.
	*/
	@media (pointer: coarse) {
		:global(:root) {
			--ui-base: 15px;
		}
	}

	/* Pixels stay pixels — this holds for every canvas of the game surface. */
	:global(canvas) {
		image-rendering: pixelated;
	}

	/*
	 * The text size of OUR OWN overlays over the game surface, defined once.
	 *
	 * Every one of them takes the control bar's scale (`uiScaleFor`) and nothing else, so it grows
	 * and shrinks with the map exactly as the bar does. Writing the same `calc` in each plate would
	 * be two rules that merely happen to agree today; this is one rule they share. Buttons inside
	 * pick it up through `font: inherit` below, which is why a switch is the size of a readout.
	 */
	:global(.game-overlay) {
		font-size: calc(var(--game-px) * var(--overlay-scale, 1));
		/* The WHOLE plate fades, content included — a see-through backing behind fully opaque
		   pictures and numbers would still cover the map where it matters. */
		opacity: var(--plate-opacity, 1);
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
