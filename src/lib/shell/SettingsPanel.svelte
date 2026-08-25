<script lang="ts">
	/**
	 * Settings overlay.
	 *
	 * What lives here is what the browser adds — game speed and pause. The sound and control
	 * options (music, effects, volume, fast build click, message level) belong to the ORIGINAL
	 * screen "EXTRA OPTION" (0x25), reachable from the main menu as well as in game; they are
	 * deliberately not offered a second time here. They are remembered nonetheless — that is what
	 * the settings store is for, and both screens read from it.
	 *
	 * Speed and pause have NO counterpart in the original (it runs at 100 ticks/s while a game is
	 * open) — they are an explicit extension.
	 */
	import { settings, SPEED_FACTORS, ticksPerSecondOf } from '../settings/settings.svelte.js';
	import { simulation } from './simulation.svelte.js';
	import { st } from './i18n.js';

	const speed = $derived(settings.value.speedFactor);
	/** Short form without a trailing zero: 0.25 -> "0.25x", 1 -> "1x". */
	const label = (f: number): string => `${String(f).replace('.', ',')}×`;
</script>

<section>
	<h3>{st('set.simulation')}</h3>
	<div class="row">
		<button
			type="button"
			onclick={() => simulation.toggle()}
			disabled={!simulation.present}
			aria-pressed={simulation.running}
		>
			{simulation.running ? `❚❚ ${st('set.pause')}` : `▶ ${st('set.play')}`}
		</button>
		<span class="note">
			{#if !simulation.present}
				{st('set.noGame')}
			{:else if simulation.active}
				{st('set.running', { tps: ticksPerSecondOf(speed) })}
			{:else if simulation.running}
				<!-- The user wants it running but an original screen is holding the clock (quit
				     dialog, mission end, open report dialog). That deserves saying — otherwise a
				     stopped game with a "pause" button looks like a bug. -->
				{st('set.held')}
			{:else}
				{st('set.paused')}
			{/if}
		</span>
	</div>

	<div class="row">
		<span id="speed-label">{st('set.speed')}</span>
		<div class="speeds" role="group" aria-labelledby="speed-label">
			{#each SPEED_FACTORS as factor (factor)}
				<button
					type="button"
					class:on={factor === speed}
					aria-pressed={factor === speed}
					onclick={() => settings.set('speedFactor', factor)}
				>
					{label(factor)}
				</button>
			{/each}
		</div>
	</div>
	<p class="note">{st('set.speedNote')}</p>
</section>

<section>
	<h3>{st('set.rest')}</h3>
	<p class="note">{st('set.restNote')}</p>
	<div class="row">
		<button type="button" onclick={() => settings.reset()}>{st('set.reset')}</button>
	</div>
</section>

<style>
	section {
		display: grid;
		gap: 0.5rem;
	}

	h3 {
		margin: 0;
		font-size: 1em;
		font-weight: normal;
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.speeds {
		display: flex;
		gap: 0.25rem;
	}

	.speeds button.on {
		border-color: var(--accent);
		color: var(--accent);
	}

	.note {
		margin: 0;
		color: var(--fg-dim);
		line-height: 1.5;
	}
</style>
