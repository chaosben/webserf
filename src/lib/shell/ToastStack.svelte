<script lang="ts">
	/**
	 * The status messages of `toasts`, stacked at the top edge of the stage.
	 *
	 * It sits over whatever the stage holds — drop zone, main menu or map — because a message has to
	 * be readable where it arose, and the map is most of the time the only thing on screen. At the
	 * TOP: the control bar the game draws lies at the bottom, and a message must never cover it.
	 *
	 * The column itself lets the pointer through, so the map under an empty stretch keeps its clicks;
	 * a message takes the pointer back so its close cross can be hit — the message itself does
	 * nothing on a click, a stray one while playing must not throw away what it says.
	 */
	import IconInfo from '~icons/material-symbols-light/info-outline';
	import IconGood from '~icons/material-symbols-light/check-circle-outline';
	import IconWarn from '~icons/material-symbols-light/warning-outline';
	import IconError from '~icons/material-symbols-light/error-outline';
	import IconClose from '~icons/material-symbols-light/close';
	import { toasts, type ToastTone } from './toasts.svelte.js';
	import { st } from './i18n.js';
	import type { Component } from 'svelte';

	const TONE_ICON: Record<ToastTone, Component> = {
		info: IconInfo,
		good: IconGood,
		warn: IconWarn,
		error: IconError
	};
</script>

<!-- `polite`: a message waits for the screen reader to finish, it does not interrupt the game. -->
<ol class="stack" role="status" aria-live="polite">
	{#each toasts.items as toast (toast.id)}
		{@const Icon = toast.icon ?? TONE_ICON[toast.tone]}
		<li class="toast {toast.tone}">
			<Icon class="tone" aria-hidden="true" />
			<span>{toast.text}</span>
			{#if toast.count > 1}
				<span class="count">×{toast.count}</span>
			{/if}
			<button
				type="button"
				class="close"
				title={st('toast.dismiss')}
				aria-label={st('toast.dismiss')}
				onclick={() => toasts.dismiss(toast.id)}
			>
				<IconClose aria-hidden="true" />
			</button>
		</li>
	{/each}
</ol>

<style>
	.stack {
		position: absolute;
		top: 0.5rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		width: max-content;
		max-width: min(36rem, calc(100% - 2rem));
		margin: 0;
		padding: 0;
		list-style: none;
		pointer-events: none;
	}

	.toast {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 100%;
		padding: 0.4rem 0.4rem 0.4rem 0.7rem;
		background: var(--overlay);
		border: 1px solid var(--line);
		border-left: 3px solid var(--tone);
		color: var(--fg);
		box-shadow: 0 2px 8px rgb(0 0 0 / 40%);
		pointer-events: auto;
	}

	.toast :global(svg.tone) {
		flex: none;
		width: 1.3em;
		height: 1.3em;
		color: var(--tone);
	}

	.close {
		display: flex;
		flex: none;
		margin-left: 0.25rem;
		padding: 0.1rem;
		background: none;
		border: none;
		color: var(--fg-dim);
	}

	.close :global(svg) {
		width: 1em;
		height: 1em;
	}

	.count {
		color: var(--fg-dim);
	}

	.info {
		--tone: var(--fg-dim);
	}

	.good {
		--tone: var(--accent);
	}

	.warn {
		--tone: var(--amber);
	}

	.error {
		--tone: var(--danger);
	}
</style>
