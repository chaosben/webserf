<script lang="ts">
	/**
	 * BYOA — "bring your own assets". The archive is never part of the repository and never shipped;
	 * the player brings their own original copy. Accepted is the very file a DOS installation
	 * carries: `SPAD.PA` (German) or its language variants.
	 *
	 * The file dialog hangs off a `<label>` around a visually hidden `<input type=file>`: that way
	 * the browser opens it itself (no element reference needed) and the keyboard can reach it.
	 */
	import { st } from "./i18n.js";
	
	/**
	 * The search term is NOT translated — it is input for a search engine, not a sentence. It lives
	 * here instead of in the language table so that it is the same in every language.
	 */
	const SEARCH_TERM = "settlers dos download";

	/**
	 * The search runs as a REAL LINK, not as a sentence to retype. DuckDuckGo because it needs no
	 * cookie banner and no account — the visitor is here to load a file, not to be profiled.
	 */
	const SEARCH_URL = `https://google.com/?q=${encodeURIComponent(SEARCH_TERM)}`;

	let {
		onfile,
		busy = false,
		error = null,
	}: {
		onfile: (file: File) => void;
		busy?: boolean;
		error?: string | null;
	} = $props();

	let dragging = $state(false);

	function take(list: FileList | null): void {
		const file = list?.[0];
		if (file) onfile(file);
	}
</script>

<div
	class="zone"
	class:dragging
	class:busy
	role="region"
	aria-label={st('drop.aria')}
	ondragover={(e: DragEvent) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={(e: DragEvent) => {
		e.preventDefault();
		dragging = false;
		take(e.dataTransfer?.files ?? null);
	}}
>
	<h1>webserf</h1>
	<p class="lead">{st('drop.lead')}</p>

	<label class="pick">
		<input type="file" accept=".PA,.pa" class="sr-only" onchange={(e) => take(e.currentTarget.files)} />
		<span>{busy ? st('drop.reading') : st('drop.choose')}</span>
	</label>

	<p class="file">
		<code>SPAD.PA</code> · <code>SPAE.PA</code> · <code>SPAF.PA</code> · <code>SPAU.PA</code>
	</p>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	<div class="hint">
		<p>{st('drop.what')}</p>
		<p>{st('drop.need')}</p>
		<p>
			{st('drop.buy')}
			<a href={st('link.store')} target="_blank" rel="noreferrer noopener">
				{st('drop.buyLink')}
			</a><br />
			{st('drop.search')}
			<a href={SEARCH_URL} target="_blank" rel="noreferrer noopener">
				{st('drop.searchLink', { terms: SEARCH_TERM })}
			</a>
			<!-- The wink is not text: it means the same in every language and needs no translation. -->
			😉
		</p>
	</div>
</div>

<style>
	.zone {
		height: 100%;
		display: grid;
		align-content: center;
		justify-items: center;
		gap: 0.6rem;
		padding: 2rem;
		margin: 1.5rem;
		text-align: center;
		border: 2px dashed var(--line);
	}

	.zone.dragging {
		border-color: var(--accent);
		background: #0e120d;
	}

	.zone.busy {
		cursor: progress;
	}

	h1 {
		margin: 0;
		font-size: 2.2em;
		font-weight: normal;
		letter-spacing: 0.35em;
		color: var(--accent);
		text-transform: uppercase;
	}

	.lead {
		margin: 0;
		font-size: 1.1em;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	.pick span {
		display: inline-block;
		border: 1px solid var(--line);
		background: var(--bg-raised);
		padding: 0.3rem 0.9rem;
		cursor: pointer;
	}

	.pick:hover span,
	.pick:focus-within span {
		border-color: var(--accent);
		color: var(--accent);
	}

	.file {
		margin: 0;
		color: var(--fg-dim);
	}

	.hint {
		display: grid;
		gap: 0.6rem;
		margin: 1.5rem 0 0;
		max-width: 38rem;
		color: var(--fg-dim);
		line-height: 1.5;
	}

	.hint p {
		margin: 0;
	}

	.hint a {
		color: var(--accent);
	}

	.error {
		margin: 0;
		color: var(--danger);
	}
</style>
