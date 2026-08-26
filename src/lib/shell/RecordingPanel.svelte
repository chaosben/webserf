<script lang="ts">
	/**
	 * Record the game screen — a still picture and a video, in that order.
	 *
	 * Both take the ONE canvas the game screen lives on; that is why bar and popups are composed into
	 * it rather than lying next to it. The video runs at the clone's own drawing pace, so a paused
	 * game produces no frames: it is game time, not wall-clock time.
	 *
	 * THE STILL IS TAKEN WHEN THIS PANEL MOUNTS, not on a button. Opening the panel is what a person
	 * does when something is worth keeping, and by the time a button could be pressed the screen has
	 * moved on. There is deliberately no "take it again" (a decision, not an omission): the
	 * consequence belongs with it — a panel left open shows an ageing picture, and one already open at
	 * start-up, before there is a game, keeps saying so until it is closed and opened again.
	 *
	 * Where the browser has a file picker, the video is written into the chosen file WHILE recording
	 * and nothing is held in memory; otherwise it comes back as a download at the end, and then the
	 * length is bounded by memory. The panel says which of the two applies BEFORE the recording
	 * starts — afterwards is too late to choose differently.
	 */
	import { untrack } from 'svelte';
	import { recordings, recordingSupported } from './recording.svelte.js';
	import { fileStreamingSupported } from '../views/screen-recorder.js';
	import { log } from './log.js';
	import { st } from './i18n.js';

	async function start(): Promise<void> {
		// `new Date()` here rather than in the bus: the bus stays testable without a clock.
		if (await recordings.start(new Date())) log.info('game', 'Recording started');
		else if (recordings.error !== null) log.warn('game', `Recording: ${recordings.error}`);
	}

	async function stop(): Promise<void> {
		const result = await recordings.stop();
		if (result === null) return;
		log.info('game', `Recording stopped: ${result.frames} frames, ${kb(result.bytes)}`);
		// Only the fallback hands data back — then it still has to reach the disk.
		if (result.blob !== null) download(result.fileName, result.blob);
	}

	function download(fileName: string, blob: Blob): void {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	const kb = (bytes: number): string =>
		bytes < 1024 * 1024
			? `${Math.round(bytes / 1024)} kB`
			: `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

	/**
	 * The frame counter is POLLED, not pushed: it grows once per drawn image from inside the drawing
	 * pass, and as reactive state it would invalidate the graph at that rate (see `frameCount` in the
	 * bus). Twice a second is plenty for a counter a human reads. A `$derived` cannot do this: the
	 * counter is not reactive, so nothing would ever invalidate it — the timer IS the source of
	 * change here, which is what an effect is for.
	 */
	let frames = $state(0);
	$effect(() => {
		if (!recordings.running) {
			frames = 0;
			return;
		}
		frames = recordings.frameCount;
		const id = setInterval(() => (frames = recordings.frameCount), 500);
		return () => clearInterval(id);
	});

	/** Images per second the clone draws — the video inherits it. */
	const seconds = $derived(Math.round(frames / 12.5));

	/** A local copy so the markup can narrow it — a class field is not narrowed across expressions. */
	const still = $derived(recordings.still);

	/**
	 * Take the picture on opening, drop it on closing — mount and unmount of this panel are exactly
	 * those two moments, so the whole life of the object URL fits into one effect.
	 *
	 * `untrack` because `takeStill` reads the registered view before its first `await`: without it the
	 * effect would depend on that view and take a second picture whenever it re-registers.
	 */
	$effect(() => {
		untrack(() => void recordings.takeStill(new Date()));
		return () => recordings.clearStill();
	});
</script>

<section>
	<h3>{st('record.stillTitle')}</h3>
	{#if still !== null}
		<!-- Pixel art: the preview must not be smoothed, and it stays small on purpose. -->
		<img class="still" src={still.url} alt={st('record.stillTitle')} />
		<!--
			A real link, not a button: an object URL needs no JavaScript to be saved, and a link can be
			opened in a tab or copied from the context menu.
		-->
		<a href={still.url} download={still.fileName}>
			{st('record.download', { size: kb(still.bytes) })}
		</a>
		<p class="note">{st('record.stillNote')}</p>
	{:else if !recordings.available}
		<p class="note">{st('record.needGame')}</p>
	{:else}
		<p class="note">{st('record.stillNone')}</p>
	{/if}
</section>

<section>
	<h3>{st('record.videoTitle')}</h3>
	<p class="note">{st('record.intro')}</p>

	{#if !recordingSupported()}
		<p class="warn">{st('record.unsupported')}</p>
	{:else}
		<p class="note">
			{fileStreamingSupported() ? st('record.toFile') : st('record.toMemory')}
		</p>

		<div class="row">
			{#if recordings.running}
				<button type="button" onclick={() => void stop()} disabled={recordings.busy}>
					{st('record.stop')}
				</button>
				<span class="note">{st('record.progress', { frames, seconds })}</span>
			{:else}
				<button
					type="button"
					onclick={() => void start()}
					disabled={!recordings.available || recordings.busy}
				>
					{st('record.start')}
				</button>
			{/if}
		</div>

		{#if !recordings.available}
			<p class="note">{st('record.needGame')}</p>
		{/if}

		{#if recordings.error !== null}
			<p class="warn">{recordings.error}</p>
		{/if}

		{#if recordings.last !== null}
			<p class="note">
				{st('record.done', {
					name: recordings.last.fileName,
					frames: recordings.last.frames,
					size: kb(recordings.last.bytes)
				})}
			</p>
		{/if}
	{/if}
</section>

<style>
	section {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
	}

	/* The hairline between the two stages — only between them, not above the first. */
	section + section {
		padding-top: 0.9rem;
		border-top: 1px solid var(--line);
	}

	section h3 {
		margin: 0;
		font-size: 1em;
		font-weight: normal;
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.still {
		max-width: 100%;
		max-height: 9rem;
		border: 1px solid var(--line);
		/* Pixel art — the browser's smoothing turns the original's dithering to mush. */
		image-rendering: pixelated;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.note {
		margin: 0;
		color: var(--fg-dim);
		line-height: 1.5;
	}

	.warn {
		margin: 0;
		color: var(--amber);
	}
</style>
