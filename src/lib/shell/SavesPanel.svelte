<script lang="ts">
	/**
	 * THE TEN SAVE-GAME SLOTS in the import/export overlay.
	 *
	 * Why this view exists: the saves live in IndexedDB, and without an attached folder there was NO
	 * way to reach them at all — no download, no upload, no delete. The folder layer only covers
	 * browsers that have the file-system access API; Firefox and Safari do not.
	 *
	 * TWO ROUTES, WITH DIFFERENT PURPOSES (see `core/save-transfer.ts`):
	 * - ONE SLOT as `SAVEn.DS`. Exactly the filename the original reads — copy it into a DOSBox
	 *   directory and load it there. The name of the save is lost on the way, because it does not
	 *   live in the file but in `ARCHIV.DS`; on upload it is derived from the filename.
	 * - THE WHOLE PACKAGE as a ZIP with all eleven files. For moving house, names included.
	 *
	 * The heading is not here: it is the overlay's TAB, and this section fills that tab entirely.
	 *
	 * The per-row buttons carry ICONS, not word labels — they appear ten times in a column, and in a
	 * language with long words that squeezes the name column. The text is still there, as
	 * `aria-label` and `title`: screen readers need it, and as a tooltip it explains the icon to
	 * whoever does not know it.
	 *
	 * DELETING SWAPS ITS ICON (bin -> bin-permanent): the waiting second click has to look
	 * different, and on an icon button colour alone does not carry that.
	 *
	 * The delete button asks IN THE BUTTON ITSELF (second click) rather than via `confirm()`: a
	 * browser modal stops the game clock and looks foreign in this interface.
	 */
	import { parseArchiv } from '$lib/core/archiv-parser.js';
	import { DISK_RESULT } from '$lib/core/disk-menu.js';
	import { fabricatedSlotName, saveFileName } from '$lib/core/save-slots.js';
	import type { SaveStore } from '$lib/core/save-store.js';
	import type { SaveSlot } from '$lib/core/types.js';
	import {
		buildSavePackage,
		namedArchivEntry,
		readSavePackage,
		SAVE_PACKAGE_FILE_NAME,
		saveGameRejection,
		slotNameFromFileName
	} from '$lib/core/save-transfer.js';
	import { log } from './log.js';
	import { st } from './i18n.js';
	import IconDownload from '~icons/material-symbols-light/download';
	import IconUpload from '~icons/material-symbols-light/upload';
	import IconDelete from '~icons/material-symbols-light/delete-outline';
	import IconDeleteForever from '~icons/material-symbols-light/delete-forever-outline';

	interface Props {
		/** `null` while the store is not open yet (or never will be). */
		store: SaveStore | null;
		/** Name of the attached folder, `null` = none. Only for the hint shown when deleting. */
		folder: string | null;
	}
	let { store, folder }: Props = $props();

	/** One row of the list: the index entry plus whatever else the store knows. */
	interface Row extends SaveSlot {
		savedAt: number;
		size: number;
	}

	let rows = $state<Row[]>([]);
	let busy = $state(false);
	let note = $state<string | null>(null);
	let error = $state<string | null>(null);
	/** Slot whose deletion is waiting for confirmation. */
	let confirming = $state<number | null>(null);

	const used = $derived(rows.filter((r) => r.used).length);

	$effect(() => {
		// Runs as soon as the store exists — before that there is nothing to show. Not a `$derived`:
		// the list comes from two `await`s on a class that is not reactive itself, and it has to be
		// re-read after every action (`run` does that).
		if (store !== null) void refresh(store);
	});

	async function refresh(s: SaveStore): Promise<void> {
		const slots = await s.slots();
		rows = parseArchiv(s.archiv).map((entry) => {
			const rec = slots.find((r) => r.index === entry.index);
			return { ...entry, savedAt: rec?.savedAt ?? 0, size: rec?.data?.length ?? 0 };
		});
	}

	/**
	 * Offer a file for download. Revoking the URL is mandatory — otherwise the buffer lives until
	 * the page reloads — but NOT immediately: right after `click()` it can abort the download that
	 * is just starting. One macrotask later it has safely begun.
	 */
	function offer(name: string, data: Uint8Array): void {
		const url = URL.createObjectURL(
			new Blob([data as BlobPart], { type: 'application/octet-stream' })
		);
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	/** Every action runs through here: a guard against double clicks, and one place for messages. */
	async function run(what: string, fn: (s: SaveStore) => Promise<string>): Promise<void> {
		const s = store;
		if (s === null || busy) return;
		busy = true;
		note = null;
		error = null;
		confirming = null;
		try {
			note = await fn(s);
			log.info('game', `${what}: ${note}`);
			await refresh(s);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			log.error('game', `${what} failed: ${error}`);
		} finally {
			busy = false;
		}
	}

	const downloadSlot = (slot: number): Promise<void> =>
		run(`Export slot ${slot}`, async (s) => {
			const { code, data } = await s.load(slot);
			if (data === null) throw new Error(st('saves.unreadableSlot', { slot, code }));
			offer(saveFileName(slot), data);
			return st('saves.downloaded', { file: saveFileName(slot), bytes: data.length });
		});

	const downloadPackage = (): Promise<void> =>
		run('Export all slots', async (s) => {
			const slots = await s.slots();
			if (slots.length === 0) throw new Error(st('saves.nothingSaved'));
			offer(SAVE_PACKAGE_FILE_NAME, buildSavePackage(s.archiv, slots));
			return st('saves.packed', { count: slots.length, file: SAVE_PACKAGE_FILE_NAME });
		});

	const deleteSlot = (slot: number): Promise<void> =>
		run(`Delete slot ${slot}`, async (s) => {
			const gone = await s.remove(slot);
			// If the file stays in the folder, the next sync brings the save back — that has to be
			// said, otherwise it reappears inexplicably.
			return gone
				? st('saves.deleted', { slot })
				: st('saves.deletedButFile', { slot, file: saveFileName(slot) });
		});

	/**
	 * Ask for a file — without an element in the template, just like {@link offer} builds the
	 * download anchor. `null` == cancelled.
	 */
	function chooseFile(accept: string): Promise<File | null> {
		return new Promise((resolve) => {
			const input = document.createElement('input');
			input.type = 'file';
			input.accept = accept;
			input.onchange = () => resolve(input.files?.[0] ?? null);
			// A cancel fires no `change` but a `cancel` — otherwise the promise waits forever.
			input.oncancel = () => resolve(null);
			input.click();
		});
	}

	async function importPackage(): Promise<void> {
		const file = await chooseFile('.zip');
		if (file === null) return;
		const data = new Uint8Array(await file.arrayBuffer());
		await run('Import package', async (s) => {
			const pkg = await readSavePackage(data);
			if (pkg.slots.length === 0) throw new Error(st('saves.noneInPackage'));
			for (const rec of pkg.slots) {
				const code = await s.importSlot(rec.index, rec.entry, rec.data!);
				if (code !== DISK_RESULT.saved)
					throw new Error(st('saves.writeFailed', { slot: rec.index, code }));
			}
			const which = pkg.slots.map((r) => r.index).join(', ');
			const skipped = pkg.ignored.length > 0 ? st('saves.ignored', { list: pkg.ignored.join(', ') }) : '';
			const names = pkg.hadIndex ? '' : st('saves.madeUpNames');
			return st('saves.imported', { which }) + names + skipped;
		});
	}

	async function importSlot(slot: number): Promise<void> {
		const file = await chooseFile('.DS,.ds');
		if (file === null) return;
		const data = new Uint8Array(await file.arrayBuffer());
		await run(`Import into slot ${slot}`, async (s) => {
			const why = saveGameRejection(data);
			if (why !== null) throw new Error(st('saves.notASave', { file: file.name, why }));
			const name = slotNameFromFileName(file.name);
			const code = await s.importSlot(slot, namedArchivEntry(name, slot), data);
			if (code !== DISK_RESULT.saved) throw new Error(st('saves.writeFailed', { slot, code }));
			return st('saves.importedInto', {
				file: file.name,
				slot,
				name: name === '' ? fabricatedSlotName(slot) : name
			});
		});
	}

	const when = (ms: number): string =>
		ms === 0 ? '' : new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
</script>

<section>
	{#if store === null}
		<p class="note">{st('saves.unavailable')}</p>
	{:else}
		<ul>
			{#each rows as row (row.index)}
				<li class:free={!row.used}>
					<span class="slot">{row.index}</span>
					<span class="name">{row.used ? row.name.trim() : st('saves.empty')}</span>
					<span class="meta">
						{#if row.used}{when(row.savedAt)}{#if row.size > 0} · {row.size} B{/if}{/if}
					</span>
					<span class="actions">
						{#if row.used}
							<button
								type="button"
								class="icon"
								disabled={busy}
								title={st('saves.download')}
								aria-label={st('saves.download')}
								onclick={() => void downloadSlot(row.index)}
							>
								<IconDownload />
							</button>
							<button
								type="button"
								class="icon"
								disabled={busy}
								title={st('saves.replace')}
								aria-label={st('saves.replace')}
								onclick={() => void importSlot(row.index)}
							>
								<IconUpload />
							</button>
							{#if confirming === row.index}
								<button
									type="button"
									class="icon danger"
									disabled={busy}
									title={st('saves.confirm')}
									aria-label={st('saves.confirm')}
									onclick={() => void deleteSlot(row.index)}
								>
									<IconDeleteForever />
								</button>
							{:else}
								<button
									type="button"
									class="icon"
									disabled={busy}
									title={st('saves.delete')}
									aria-label={st('saves.delete')}
									onclick={() => (confirming = row.index)}
								>
									<IconDelete />
								</button>
							{/if}
						{:else}
							<button
								type="button"
								class="icon"
								disabled={busy}
								title={st('saves.import')}
								aria-label={st('saves.import')}
								onclick={() => void importSlot(row.index)}
							>
								<IconUpload />
							</button>
						{/if}
					</span>
				</li>
			{/each}
		</ul>

		<div class="row">
			<button type="button" disabled={busy || used === 0} onclick={() => void downloadPackage()}>
				{st('saves.downloadAll', { count: used })}
			</button>
			<button type="button" disabled={busy} onclick={() => void importPackage()}>
				{st('saves.importPackage')}
			</button>
		</div>

		{#if error !== null}
			<p class="note bad">{error}</p>
		{:else if note !== null}
			<p class="note good">{note}</p>
		{/if}

		<p class="note">
			{st('saves.footnote')}
			{folder === null ? st('saves.deleteLocal') : st('saves.deleteBoth', { folder })}
		</p>
	{/if}
</section>

<style>
	section {
		display: grid;
		gap: 0.5rem;
	}

	ul {
		display: grid;
		gap: 0.15rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: grid;
		grid-template-columns: 1.5rem 9ch minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		padding: 0.15rem 0.3rem;
		background: var(--bg-sunken);
	}

	li.free .name,
	li.free .slot {
		color: var(--fg-dim);
	}

	.slot {
		color: var(--fg-dim);
		text-align: right;
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		color: var(--fg-dim);
		font-size: 0.9em;
		overflow: hidden;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		gap: 0.25rem;
	}

	/* Square and narrow — the row should leave its space to the name column. */
	.icon {
		display: grid;
		place-items: center;
		width: 1.7rem;
		height: 1.7rem;
		padding: 0;
	}

	.icon :global(svg) {
		width: 1.1rem;
		height: 1.1rem;
	}

	.row {
		display: flex;
		gap: 0.5rem;
	}

	.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	.note {
		margin: 0;
		color: var(--fg-dim);
		line-height: 1.5;
	}

	.note.good {
		color: var(--accent);
	}

	.note.bad {
		color: var(--danger);
	}
</style>
