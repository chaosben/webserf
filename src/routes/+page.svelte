<script lang="ts">
	/**
	 * The only page of the application.
	 *
	 * Flow: if an archive is in the browser cache it is loaded and the main menu appears; otherwise
	 * the drop zone does. From the menu, `startNewGame` starts a game that then fills the whole
	 * surface. Everything additional comes from the rail on the left, as an overlay above it.
	 *
	 * What is deliberately NOT here any more: an in-page console below the game surface and a
	 * readout of the render measurements. Log output goes to the browser console, the measurements
	 * keep running and travel inside the bug report — both without costing screen space.
	 */
	import MainMenuView from '$lib/views/MainMenuView.svelte';
	import MapView from '$lib/views/MapView.svelte';
	import Dropzone from '$lib/shell/Dropzone.svelte';
	import DrawerRail from '$lib/shell/DrawerRail.svelte';
	import type { DrawerGroup, OverlayTab } from '$lib/shell/drawer.js';
	import OverlayPanel from '$lib/shell/OverlayPanel.svelte';
	import SettingsPanel from '$lib/shell/SettingsPanel.svelte';
	import BugReportPanel from '$lib/shell/BugReportPanel.svelte';
	import InfoPanel from '$lib/shell/InfoPanel.svelte';
	import SavesPanel from '$lib/shell/SavesPanel.svelte';
	import IconSettings from '~icons/material-symbols-light/settings-outline';
	import IconTransfer from '~icons/material-symbols-light/swap-vert';
	import IconBug from '~icons/material-symbols-light/bug-report-outline';
	import IconInfo from '~icons/material-symbols-light/info-outline';
	import { log } from '$lib/shell/log.js';
	import { st } from '$lib/shell/i18n.js';
	import { settings } from '$lib/settings/settings.svelte.js';
	import { extractInArchivePalettes, GAME_PALETTE_INDEX, looksLikeArchive } from '$lib/shell/archive.js';
	import { PaArchive } from '$lib/core/pa-parser.js';
	import { detectArchiveLanguage, gameLanguage, setGameLanguage } from '$lib/core/language.js';
	import { cacheArchive, getCachedArchive, clearCachedArchive } from '$lib/core/asset-store.js';
	import { SaveStore, type SaveDirectory } from '$lib/core/save-store.js';
	import {
		grantSaveDirectory,
		pickSaveDirectory,
		restoreSaveDirectory,
		saveDirectorySupported
	} from '$lib/views/save-directory.js';
	import { startNewGameSteps } from '$lib/core/engine/new-game.js';
	import { snapshot } from '$lib/core/engine/state.js';
	import { MAP_GEN_BAR, type CampaignProgress, type MainMenuState } from '$lib/core/main-menu.js';
	import type { Palette, SaveGameState } from '$lib/core/types.js';

	const GROUPS: readonly DrawerGroup[] = [
		{ id: 'settings', icon: IconSettings, labelKey: 'group.settings' },
		{ id: 'io', icon: IconTransfer, labelKey: 'group.io' },
		{ id: 'bug', icon: IconBug, labelKey: 'group.bug' },
		{ id: 'info', icon: IconInfo, labelKey: 'group.info' }
	];

	/**
	 * The tabs of the import/export screen. Both halves used to sit below each other in one overlay
	 * — but they have nothing to do with each other: one is about save games, the other about the
	 * asset file, and only one of them is what you are looking for when you click the icon.
	 */
	const IO_TABS: readonly OverlayTab[] = [
		{ id: 'saves', labelKey: 'io.tab.saves' },
		{ id: 'assets', labelKey: 'io.tab.assets' }
	];

	let archive = $state<PaArchive | null>(null);
	let archiveName = $state<string | null>(null);
	let palettes = $state<Record<number, Palette>>({});
	let booting = $state(true);
	let busy = $state(false);
	let assetError = $state<string | null>(null);
	/**
	 * `null` = the main menu is open.
	 *
	 * `$state.raw` IS MANDATORY HERE, not a matter of taste. A save game holds `mapTiles` with up to
	 * 131,072 tiles; ordinary `$state` proxies DEEPLY, and `MapView` passes this value straight to
	 * the draw pass while the simulation is paused (`renderState` then returns `save` instead of
	 * taking a snapshot). Every tile access of the ground and entity passes went through a proxy
	 * trap: 20.8 ms versus 197.5 ms for the entity pass on a reported state, a factor of twelve.
	 * While PLAYING it does not show, because `loadState` unproxies via `deepClonePlain` — which is
	 * why the same machine measured 3 ms running and 136 ms paused.
	 *
	 * It is allowed because the state is only ever REPLACED and never changed through a property —
	 * all mutations go through `engineState` in `MapView`, which works on the unproxied clone
	 * anyway.
	 */
	let game = $state.raw<SaveGameState | null>(null);
	/**
	 * Raw bytes of the file the open save came from, `null` for a freshly generated game. On saving
	 * they fill the regions our model does not model yet — without them those areas are zero, and a
	 * save written that way is unusable for the original.
	 */
	let gameBytes = $state<Uint8Array | null>(null);
	/**
	 * The opening credits belong to program start, not to the menu: after leaving a game
	 * `MainMenuView` is rebuilt and would otherwise show them again. Only reloading the page resets
	 * this — which is what the top-left corner of the menu does (A11, "leave program").
	 */
	let introSeen = $state(false);
	/**
	 * THE CAMPAIGN PROGRESS (`gs+0x356`/`gs+0x358`) — the two numbers the original keeps globally
	 * and that advance by one when a won level is left.
	 *
	 * They live here because in the port they have to travel between TWO components: `MainMenuView`
	 * is rebuilt when returning from a game and would otherwise start at level 1 again. `null` =
	 * nothing played yet, in which case the menu's initial state applies (level 1 / unlocked 1,
	 * `mov $0x1` @0xb41d/@0xb42b).
	 *
	 * NOT persisted, and that is the template: the original keeps the two numbers in RAM only, so a
	 * program restart begins at 1 again — that is what the PASSWORDS are for. Our counterpart to a
	 * restart is reloading the page (A11 "leave program" does exactly that).
	 */
	let campaign = $state<CampaignProgress | null>(null);
	/**
	 * Progress of map generation in bar segments, `null` = none running. The menu draws the
	 * original's progress bar from it.
	 */
	let mapGenProgress = $state<number | null>(null);
	/**
	 * The store of the ten save-game slots. It belongs to the page because both views need it: the
	 * main menu loads from it ("LOAD"), the map view writes into it ("SAVE") — and both have to see
	 * the same index.
	 */
	let saveStore = $state<SaveStore | null>(null);
	/** Display only: the name of the attached folder, `null` = none. */
	let saveDirName = $state<string | null>(null);
	/** A stored folder handle without permission — the button has to renew it. */
	let saveDirPending = $state<unknown | null>(null);
	/**
	 * The open tab of the import/export screen. Deliberately NOT in the settings: on opening it
	 * should sit where most of the work happens, not where someone removed the archive once three
	 * days ago.
	 */
	let ioTab = $state<string>(IO_TABS[0]!.id);

	const palette = $derived(palettes[GAME_PALETTE_INDEX] ?? null);
	/**
	 * What the assets tab can say about the loaded file. The LANGUAGE is part of it because it is
	 * visible nowhere else: it hangs off the content of the archive, not off its filename, and it
	 * determines every string of the interface.
	 */
	const archiveInfo = $derived(
		archive === null
			? null
			: {
					name: archiveName ?? '—',
					entries: archive.entries.length,
					palettes: Object.keys(palettes).length,
					language: st(gameLanguage() === 'de' ? 'lang.de' : 'lang.en')
				}
	);
	/**
	 * The remembered group — but only if it still EXISTS. The id is persisted, and a group can
	 * disappear between two versions ("developer tools" became "about webserf"): a stale id would
	 * otherwise leave the rail unmarked and every overlay closed, which reads as "the drawer is
	 * broken" rather than "that screen is gone".
	 */
	const activeGroup = $derived(
		GROUPS.some((g) => g.id === settings.value.drawerGroup) ? settings.value.drawerGroup : null
	);

	function apply(loaded: PaArchive, name: string): void {
		archive = loaded;
		archiveName = name;
		palettes = extractInArchivePalettes(loaded);
		assetError = null;
		// The game language hangs off the asset file, not off its name: the original ships one
		// program per language. This is the single funnel of both load paths — cache and file
		// picker — which is why detection sits exactly here.
		const lang = detectArchiveLanguage(loaded);
		setGameLanguage(lang);
		log.info(
			'assets',
			`${name}: ${loaded.entries.length} entries, ${Object.keys(palettes).length} palettes, language ${lang}`,
		);
	}

	/** On start: if an archive is already in the browser, continue without a detour. */
	async function boot(): Promise<void> {
		try {
			const cached = await getCachedArchive();
			if (cached === null) log.info('assets', 'No archive in browser storage — showing the drop zone.');
			else apply(PaArchive.parse(cached.data), cached.name);
		} catch (err) {
			assetError = st('assets.cacheFailed', { why: err instanceof Error ? err.message : String(err) });
			log.error('assets', assetError);
		} finally {
			booting = false;
		}
	}

	/**
	 * Open the save-game store and — if a folder handle is stored and its permission still holds —
	 * sync. SILENTLY: `requestPermission` needs a user gesture and would be refused here; if the
	 * permission does not hold, `saveDirPending` remembers the handle and the first gesture asks
	 * (see the `$effect` below `chooseSaveFolder`); the button in the import/export screen stays the
	 * manual route.
	 */
	async function openSaves(): Promise<void> {
		try {
			const store = await SaveStore.open();
			const handle = await store.storedDirectoryHandle();
			if (handle !== null) {
				const dir = await restoreSaveDirectory(handle);
				if (dir !== null) {
					const report = await store.attachDirectory(dir);
					saveDirName = dir.label;
					log.info(
						'assets',
						`Save folder "${dir.label}": ${report.toDirectory.length} slot(s) written, ${report.toDatabase.length} imported.`
					);
				} else {
					saveDirPending = handle;
					log.info('assets', 'A save folder is remembered but needs permission again.');
				}
			}
			saveStore = store;
		} catch (err) {
			log.error(
				'assets',
				`Save storage unavailable: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/** Attach a granted folder and sync — the shared half of all three routes. */
	async function attachSaveFolder(
		store: SaveStore,
		dir: SaveDirectory,
		handle: unknown
	): Promise<void> {
		saveDirPending = null;
		const report = await store.attachDirectory(dir, handle);
		saveDirName = dir.label;
		log.info(
			'assets',
			`Save folder "${dir.label}": ${report.toDirectory.length} slot(s) written, ${report.toDatabase.length} imported.`
		);
	}

	/** Pick a folder — on the button, because the permission needs a user gesture. */
	async function chooseSaveFolder(): Promise<void> {
		const store = saveStore;
		if (store === null) return;
		const pending = saveDirPending;
		if (pending !== null) {
			const grant = await grantSaveDirectory(pending);
			if (grant.kind !== 'granted') return;
			await attachSaveFolder(store, grant.dir, pending);
			return;
		}
		const picked = await pickSaveDirectory();
		if (picked === null) return;
		await attachSaveFolder(store, picked.dir, picked.handle);
	}

	/**
	 * RENEW THE REMEMBERED FOLDER PERMISSION ON THE FIRST USER GESTURE.
	 *
	 * The browser's "allow on every visit" dialog cannot be *requested* — the API has no field for
	 * it, and on the first pick it structurally cannot appear (it hangs off `requestPermission` on a
	 * STORED handle, i.e. on the second visit). What we do control is the MOMENT: while only the
	 * button in the import/export screen called it, the dialog appeared only once the user found
	 * that drawer — and because everything keeps working out of IndexedDB, nothing hinted that the
	 * folder was detached.
	 *
	 * THIS IS NOT DIALOG SPAM but the continuation of a choice made in an earlier session:
	 * `saveDirPending` is only set when a handle IS stored. A "no" (`denied`) ends the question for
	 * this session; `blocked` means "this gesture did not count" and leaves the listeners in place —
	 * so nobody here needs to know which event types carry a user activation (on touch only
	 * `pointerup` does, not `pointerdown`).
	 *
	 * Why an `$effect` and NOT a `$derived`: nothing is derived here. It is a side effect with a
	 * dialog and file access, it is asynchronous, and it runs exactly once per session. That
	 * `attachSaveFolder` clears `saveDirPending` — one of its own dependencies — is intended and
	 * terminates: the next run sees `null` and returns immediately; the assignment happens in an
	 * `await` callback, not in the tracking run, so it is not an unsafe mutation either.
	 */
	// Deliberately NOT `$state`: this flag must not re-trigger the `$effect`, it is only the latch
	// "the question has been asked in this session".
	let saveDirAsked = false;
	$effect(() => {
		const handle = saveDirPending;
		const store = saveStore;
		if (handle === null || store === null || saveDirAsked) return;
		const ctrl = new AbortController();
		let asking = false;
		const ask = async (): Promise<void> => {
			if (asking || saveDirAsked) return;
			asking = true;
			const grant = await grantSaveDirectory(handle);
			if (grant.kind === 'blocked') {
				asking = false;
				return;
			}
			saveDirAsked = true;
			ctrl.abort();
			if (grant.kind === 'denied') {
				log.info('assets', 'Save folder permission declined — the saves stay in the browser.');
				return;
			}
			await attachSaveFolder(store, grant.dir, handle);
		};
		const opts = { capture: true, signal: ctrl.signal };
		for (const type of ['pointerdown', 'pointerup', 'keydown']) {
			window.addEventListener(type, () => void ask(), opts);
		}
		return () => ctrl.abort();
	});

	async function forgetSaveFolder(): Promise<void> {
		await saveStore?.detachDirectory();
		saveDirName = null;
		saveDirPending = null;
		log.info('assets', 'Save folder detached — the saves stay in the browser.');
	}

	async function onfile(file: File): Promise<void> {
		if (!looksLikeArchive(file.name)) {
			assetError = st('assets.badType', { file: file.name });
			log.warn('assets', assetError);
			return;
		}
		busy = true;
		try {
			const raw = await file.arrayBuffer();
			apply(PaArchive.parse(raw), file.name);
			await cacheArchive(file.name, raw);
			log.info('assets', `${file.name} stored in the browser.`);
		} catch (err) {
			assetError = st('assets.unreadable', { why: err instanceof Error ? err.message : String(err) });
			log.error('assets', assetError);
		} finally {
			busy = false;
		}
	}

	async function forgetArchive(): Promise<void> {
		try {
			await clearCachedArchive();
		} catch (err) {
			log.error('assets', `Could not clear the cache: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		archive = null;
		archiveName = null;
		palettes = {};
		game = null;
		settings.set('drawerGroup', null);
		log.info('assets', 'Archive removed from the browser.');
	}

	/** Await one frame — otherwise generation blocks the thread and the bar never appears. */
	function nextFrame(): Promise<void> {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}

	/**
	 * Earliest time before drawing again. One frame PER message would be wrong: generation costs
	 * 21 ms (64x64) to 265 ms (512x256) on today's hardware, while 26 forced frames cost around
	 * 420 ms — the bar would have been showing mostly itself.
	 */
	const FRAME_BUDGET_MS = 16;

	/**
	 * START in the main menu. The menu fields map 1:1 onto `NewGameSetup`.
	 *
	 * Generation runs in the 26 steps of the original: the generator reports and presents after each
	 * stage, so the bar grows WHILE the map is being built.
	 *
	 * AFTER THE LAST MESSAGE THERE IS NO MORE WAITING, and that is the original rather than a
	 * shortcut: there the bar stands at 39 of 40 while the minimap is being built, and the last
	 * segment coincides with the screen change. At that point the port has its own expensive
	 * preparation — building the game state and mounting the map view — and treats it the same way.
	 * A full bar that then hangs would read as a bug.
	 */
	async function runStart(menu: MainMenuState): Promise<void> {
		mapGenProgress = 0;
		try {
			const steps = startNewGameSteps({
				gameType: menu.gameType,
				levelSetupIndex: menu.level,
				levelSetupShown: menu.unlockedLevel,
				missionSetupIndex: menu.mission,
				mapSize: menu.mapSizeChoice,
				seed: menu.seed,
				menuPlayers: [0, 1, 2, 3].map((i) => [
					menu.face[i] ?? 0,
					menu.supply[i] ?? 0,
					menu.intelligence[i] ?? 0,
					menu.reproduction[i] ?? 0
				]) as never,
				humanSupplies: menu.humanSupply as readonly [number, number],
				humanReproduction: menu.humanReproduction as readonly [number, number],
				// The control options are a save-game field, but in the original they are preloaded
				// from the configuration file — so the remembered value is the STARTING value of a
				// new game. A save loaded later brings its own.
				viewOptions: settings.value.viewOptions
			});
			let done = 0;
			let painted = performance.now();
			let step = steps.next();
			while (!step.done) {
				done += step.value;
				mapGenProgress = done;
				if (done < MAP_GEN_BAR.segments && performance.now() - painted >= FRAME_BUDGET_MS) {
					await nextFrame();
					painted = performance.now();
				}
				step = steps.next();
			}
			// The last `next()` above finished building the game state. Full bar AND map in the same
			// frame — only the map is drawn, because it replaces the menu.
			const started = snapshot(step.value);
			game = started;
			gameBytes = null; // a freshly generated game has no source file
			log.info(
				'engine',
				`New game: type ${started.header.gameType}, map ${started.header.mapCols}x${started.header.mapRows}`
			);
		} catch (err) {
			// Console only: there is no message strip below the game surface any more.
			log.error('engine', `Could not start the game: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			mapGenProgress = null;
		}
	}

	function onstart(menu: MainMenuState): void {
		void runStart(menu);
	}

	// Two independent entry points, on purpose: the save-game store does NOT depend on the archive.
	// While it hung at the end of `boot`, the drop-zone path bypassed it — in the FIRST session of a
	// browser there was no store at all, so "save" and "load" silently did nothing. It was reported
	// as "saving does not work in Firefox": that was simply the first start there, while another
	// browser had the archive in its cache and took the other branch.
	void boot();
	void openSaves();
</script>

<div class="shell">
	<DrawerRail
		groups={GROUPS}
		active={activeGroup}
		onselect={(id) => settings.set('drawerGroup', id)}
	/>

	<div class="stage">
		{#if booting}
			<p class="center">{st('page.loading')}</p>
		{:else if archive === null}
			<Dropzone {onfile} {busy} error={assetError} />
		{:else if game !== null}
			<MapView
				save={game}
				{archive}
				{palette}
				sourceFile={gameBytes === null ? 'New game' : 'Loaded save game'}
				sourceBytes={gameBytes}
				store={saveStore}
				onload={(loaded, bytes) => {
					game = loaded;
					gameBytes = bytes;
					log.info('engine', 'Save game loaded.');
				}}
				onquit={(progress) => {
					game = null;
					gameBytes = null;
					// `null` = not a campaign game; the original then leaves the two cells untouched.
					if (progress !== null) campaign = progress;
					log.info(
						'engine',
						`Left the game — back to the main menu.${
							progress === null ? '' : ` Campaign: level ${progress.level}, unlocked ${progress.unlockedLevel}.`
						}`
					);
				}}
			/>
		{:else}
			<MainMenuView
				{archive}
				{palette}
				{onstart}
				{campaign}
				intro={!introSeen}
				onintroend={() => (introSeen = true)}
				{mapGenProgress}
				store={saveStore}
				onload={(loaded, bytes) => {
					game = loaded;
					gameBytes = bytes;
					log.info('engine', 'Save game loaded.');
				}}
			/>
		{/if}

		{#if activeGroup === 'settings'}
			<OverlayPanel title={st('group.settings')} onclose={() => settings.set('drawerGroup', null)}>
				<SettingsPanel />
			</OverlayPanel>
		{:else if activeGroup === 'io'}
			<OverlayPanel
				title={st('group.io')}
				tabs={IO_TABS}
				tab={ioTab}
				ontab={(id) => (ioTab = id)}
				onclose={() => settings.set('drawerGroup', null)}
			>
				{#if ioTab === 'saves'}
					<SavesPanel store={saveStore} folder={saveDirName} />

					<section>
						<h3>{st('folder.title')}</h3>
						<p class="note">{st('folder.what')}</p>
						{#if !saveDirectorySupported()}
							<p class="note">{st('folder.unsupported')}</p>
						{:else if saveDirName !== null}
							<p class="note">{st('folder.attached')} <code>{saveDirName}</code></p>
							<button type="button" onclick={() => void forgetSaveFolder()}>
								{st('folder.detach')}
							</button>
						{:else}
							<button type="button" onclick={() => void chooseSaveFolder()}>
								{saveDirPending !== null ? st('folder.allow') : st('folder.choose')}
							</button>
						{/if}
					</section>
				{:else}
					<section>
						<h3>{st('archive.title')}</h3>
						{#if archiveInfo === null}
							<p class="note">{st('archive.none')}</p>
						{:else}
							<p class="note">
								<code>{archiveInfo.name}</code> — {st('archive.info', {
									entries: archiveInfo.entries,
									palettes: archiveInfo.palettes,
									language: archiveInfo.language
								})}
							</p>
						{/if}
						<p class="note">{st('archive.privacy')}</p>
						<button type="button" onclick={() => void forgetArchive()}>
							{st('archive.remove')}
						</button>
					</section>
				{/if}
			</OverlayPanel>
		{:else if activeGroup === 'bug'}
			<OverlayPanel title={st('group.bug')} onclose={() => settings.set('drawerGroup', null)}>
				<BugReportPanel />
			</OverlayPanel>
		{:else if activeGroup === 'info'}
			<OverlayPanel title={st('group.info')} onclose={() => settings.set('drawerGroup', null)}>
				<InfoPanel />
			</OverlayPanel>
		{/if}
	</div>
</div>

<style>
	.shell {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		height: 100dvh;
		overflow: hidden;
	}

	/* Reference frame for the overlays — and the surface the views measure themselves against. */
	.stage {
		position: relative;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.center {
		display: grid;
		place-items: center;
		height: 100%;
		margin: 0;
		color: var(--fg-dim);
	}

	.note {
		margin: 0;
		color: var(--fg-dim);
		line-height: 1.5;
	}

	/* The sections of the import/export overlay — same look as in `SavesPanel`. */
	section {
		display: grid;
		gap: 0.5rem;
	}

	section h3 {
		margin: 0;
		font-size: 1em;
		font-weight: normal;
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	section button {
		justify-self: start;
	}
</style>
