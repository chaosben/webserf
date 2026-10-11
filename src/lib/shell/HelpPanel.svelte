<script lang="ts">
	/**
	 * THE HELP — one tab of `help-content.ts` at a time, with the original's pictures: icons and
	 * markers from the archive, buildings and goods under their original names, and whole dialogs
	 * drawn from a sample game (`help-shots.ts`).
	 *
	 * The search runs over every tab and replaces the tab while it has text; a hit jumps to its
	 * section. `focus` is the section of the dialog that was open in the game when the help opened.
	 */
	import { tick } from 'svelte';
	import { st } from './i18n.js';
	import {
		HELP_SECTIONS,
		HELP_TABS,
		helpImageCaption,
		helpImageEntry,
		searchHelp,
		type HelpHit,
		type HelpImage,
		type HelpItem,
		type HelpSection
	} from './help-content.js';
	import { helpShotUrl } from './help-images.js';
	import { HELP_SHOT_WIDTH } from './help-shots.js';
	import { spriteImage } from '../enhancements/icon-images.svelte.js';
	import type { PaArchive } from '../core/pa-parser.js';
	import type { Palette } from '../core/types.js';

	let {
		tab,
		ontab,
		archive,
		palette,
		focus = null
	}: {
		tab: string;
		ontab: (id: string) => void;
		archive: PaArchive;
		palette: Palette;
		/** Section to scroll to on opening, and the shot to mark as "open in the game". */
		focus?: { readonly tab: string; readonly section: string; readonly shot: string } | null;
	} = $props();

	let query = $state('');
	let body = $state<HTMLElement | null>(null);
	/** Height of the sticky head, so a section scrolled to lands below it and not behind it. */
	let headHeight = $state(0);

	const hits = $derived(searchHelp(query));
	const sections = $derived(HELP_SECTIONS[tab] ?? []);

	/** Picture step 2: the original's pixels doubled, as on the game screen at normal size. */
	const IMAGE_STEP = 2;

	function image(img: HelpImage) {
		const entry = helpImageEntry(img);
		return entry === null ? null : spriteImage(entry, IMAGE_STEP);
	}

	function sectionOf(hit: HelpHit): HelpSection | undefined {
		return (HELP_SECTIONS[hit.tab] ?? []).find((s) => s.id === hit.section);
	}

	function tabLabel(id: string): string {
		const t = HELP_TABS.find((x) => x.id === id);
		return t === undefined ? id : st(t.labelKey);
	}

	function itemLine(item: HelpItem): string {
		return item.kind === 'text' ? st(item.textKey) : `${st(item.labelKey)}: ${st(item.mouseKey)} · ${st(item.touchKey)}`;
	}

	const anchorId = (tabId: string, section: string): string => `help-${tabId}-${section}`;

	async function scrollTo(tabId: string, section: string): Promise<void> {
		await tick();
		body?.querySelector(`#${anchorId(tabId, section)}`)?.scrollIntoView({ block: 'start' });
	}

	/** A section the next tab change should land on, instead of the top. */
	let pending: { tab: string; section: string } | null = null;

	function open(hit: HelpHit): void {
		query = '';
		if (hit.tab === tab) {
			void scrollTo(hit.tab, hit.section);
			return;
		}
		pending = { tab: hit.tab, section: hit.section };
		ontab(hit.tab);
	}

	/**
	 * On a tab change the body starts at the top — it is one scroll container for all tabs. Two
	 * exceptions land on a section instead: a search hit in another tab, and the first showing of the
	 * focus tab (the dialog open in the game). The focus is spent after that, otherwise coming back to
	 * the tab would jump again.
	 */
	let focusShown = false;
	$effect(() => {
		const current = tab;
		const f = focus;
		let target: { tab: string; section: string } | null = null;
		if (pending !== null && pending.tab === current) target = pending;
		else if (f !== null && f.tab === current && !focusShown) target = f;
		pending = null;
		if (target !== null && target === f) focusShown = true;
		if (target !== null) void scrollTo(target.tab, target.section);
		else void tick().then(() => body?.parentElement?.scrollTo({ top: 0 }));
	});
</script>

<div class="help" bind:this={body} style:--head="{headHeight}px">
	<div class="head" bind:clientHeight={headHeight}>
		<label class="search">
			<span class="sr">{st('help.search.label')}</span>
			<input type="search" placeholder={st('help.search.placeholder')} bind:value={query} />
		</label>
		{#if query.trim() === '' && sections.length > 2}
			<nav class="toc" aria-label={st('help.contents')}>
				{#each sections as section (section.id)}
					<button type="button" onclick={() => void scrollTo(tab, section.id)}>
						{st(section.titleKey)}
					</button>
				{/each}
			</nav>
		{/if}
	</div>

	{#if query.trim() !== ''}
		{#if hits.length === 0}
			<p class="note">{st('help.search.none', { query: query.trim() })}</p>
		{:else}
			<p class="note">{st('help.search.count', { count: hits.length })}</p>
			<ul class="hits">
				{#each hits as hit, i (i)}
					{@const section = sectionOf(hit)}
					{@const item = hit.item === null ? undefined : section?.items[hit.item]}
					<li>
						<button type="button" onclick={() => open(hit)}>
							<span class="where">
								{tabLabel(hit.tab)} › {section === undefined ? '' : st(section.titleKey)}
							</span>
							{#if item !== undefined}
								<span class="line">{itemLine(item)}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		{#each sections as section (section.id)}
			<section id={anchorId(tab, section.id)}>
				<h3>{st(section.titleKey)}</h3>
				{#if section.items.some((it) => it.kind === 'control')}
					<table>
						<thead>
							<tr>
								<th>{st('help.table.action')}</th>
								<th>{st('help.table.mouse')}</th>
								<th>{st('help.table.touch')}</th>
							</tr>
						</thead>
						<tbody>
							{#each section.items as item, i (i)}
								{#if item.kind === 'control'}
									<tr>
										<th scope="row">{st(item.labelKey)}</th>
										<td>{st(item.mouseKey)}</td>
										<td>{st(item.touchKey)}</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				{/if}
				{#each section.items as item, i (i)}
					{#if item.kind === 'text'}
						<div class="item">
							{#if item.images !== undefined && item.images.length > 0}
								<div class="pics">
									{#each item.images as img, j (j)}
										{@const pic = image(img)}
										{@const caption = helpImageCaption(img)}
										{#if pic !== null}
											<figure>
												<img src={pic.url} width={pic.width} height={pic.height} alt={caption ?? ''} />
												{#if caption !== null}<figcaption>{caption}</figcaption>{/if}
											</figure>
										{/if}
									{/each}
								</div>
							{/if}
							<p class="note">{st(item.textKey)}</p>
							{#if item.shot !== undefined}
								{@const url = helpShotUrl(item.shot, archive, palette)}
								{#if url !== null}
									<figure class="shot" class:open={focus?.shot === item.shot}>
										<img src={url} width={HELP_SHOT_WIDTH * IMAGE_STEP} alt="" />
										{#if focus?.shot === item.shot}
											<figcaption>{st('help.context')}</figcaption>
										{/if}
									</figure>
								{/if}
							{/if}
						</div>
					{/if}
				{/each}
			</section>
		{/each}
	{/if}
</div>

<style>
	.help {
		display: grid;
		gap: 0.9rem;
	}

	/*
	 * Stays at the top of the panel body, which is the scroll container (`OverlayPanel scroll`). A
	 * sticky element pins at the container's CONTENT edge, inside its padding — so `top` is the
	 * negative padding, and the negative margin pulls the head over that padding; with `top: 0` the
	 * text scrolls through the padding strip above the search field.
	 */
	.head {
		position: sticky;
		top: -0.75rem;
		z-index: 1;
		display: grid;
		gap: 0.5rem;
		margin: -0.75rem -0.75rem 0;
		padding: 0.75rem 0.75rem 0.5rem;
		background: var(--bg-raised);
		border-bottom: 1px solid var(--line);
	}

	.search input {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 0.35rem 0.5rem;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.toc {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.8rem;
	}

	.toc button,
	.hits button {
		all: unset;
		cursor: pointer;
		color: var(--accent);
	}

	.hits {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}

	.hits button {
		display: grid;
		gap: 0.15rem;
	}

	.where {
		font-size: 0.85em;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.line {
		color: var(--fg-dim);
	}

	section {
		display: grid;
		gap: 0.6rem;
		scroll-margin-top: calc(var(--head) + 0.5rem);
	}

	section h3 {
		margin: 0;
		font-size: 1em;
		font-weight: normal;
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.item {
		display: grid;
		gap: 0.4rem;
	}

	.note {
		margin: 0;
		color: var(--fg-dim);
		line-height: 1.5;
	}

	.pics {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.9rem;
	}

	figure {
		margin: 0;
		display: grid;
		justify-items: center;
		gap: 0.2rem;
	}

	figcaption {
		font-size: 0.8em;
		color: var(--fg-dim);
		text-align: center;
	}

	img {
		image-rendering: pixelated;
		max-width: 100%;
		height: auto;
	}

	.shot {
		justify-items: start;
	}

	.shot.open img {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	table {
		border-collapse: collapse;
		width: 100%;
	}

	th,
	td {
		text-align: left;
		vertical-align: top;
		padding: 0.3rem 0.5rem 0.3rem 0;
		color: var(--fg-dim);
		line-height: 1.4;
	}

	thead th {
		font-weight: normal;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-size: 0.85em;
	}

	tbody th {
		font-weight: normal;
		color: inherit;
	}
</style>
