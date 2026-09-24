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
	import { blockPageZoom } from '$lib/shell/page-zoom.js';
	import { followVisualViewport, visualViewportEnv } from '$lib/shell/visual-viewport.js';
	import type { DrawerGroup, DrawerMark, OverlayTab } from '$lib/shell/drawer.js';
	import OverlayPanel from '$lib/shell/OverlayPanel.svelte';
	import SettingsPanel from '$lib/shell/SettingsPanel.svelte';
	import BugReportPanel from '$lib/shell/BugReportPanel.svelte';
	import RecordingPanel from '$lib/shell/RecordingPanel.svelte';
	import InfoPanel from '$lib/shell/InfoPanel.svelte';
	import SavesPanel from '$lib/shell/SavesPanel.svelte';
	import EnhancementsPanel from '$lib/enhancements/EnhancementsPanel.svelte';
	import EnhancementNav from '$lib/enhancements/EnhancementNav.svelte';
	import { ENHANCEMENTS, enhancementFor, enhancementTabFor } from '$lib/enhancements/registry.js';
	import { provideIconSource } from '$lib/enhancements/icon-images.svelte.js';
	import IconSettings from '~icons/material-symbols-light/settings-outline';
	import IconTransfer from '~icons/material-symbols-light/swap-vert';
	import IconBug from '~icons/material-symbols-light/bug-report-outline';
	import IconRecord from '~icons/material-symbols-light/videocam-outline';
	import IconEnhance from '~icons/material-symbols-light/extension-outline';
	import IconInfo from '~icons/material-symbols-light/info-outline';
	import { recordings } from '$lib/shell/recording.svelte.js';
	import { updates } from '$lib/shell/update.svelte.js';
	import { toasts } from '$lib/shell/toasts.svelte.js';
	import ToastStack from '$lib/shell/ToastStack.svelte';
	import { untrack } from 'svelte';
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
		saveDirectorySupported,
		saveDirectoryUsable
	} from '$lib/views/save-directory.js';
	import { startNewGameSteps } from '$lib/core/engine/new-game.js';
	import { snapshot } from '$lib/core/engine/state.js';
	import { MAP_GEN_BAR, type CampaignProgress, type MainMenuState } from '$lib/core/main-menu.js';
	import type { Palette, SaveGameState } from '$lib/core/types.js';

	const GROUPS: readonly DrawerGroup[] = [
		{ id: 'settings', icon: IconSettings, labelKey: 'group.settings' },
		{ id: 'io', icon: IconTransfer, labelKey: 'group.io' },
		{ id: 'bug', icon: IconBug, labelKey: 'group.bug' },
		{ id: 'record', icon: IconRecord, labelKey: 'group.record' },
		{ id: 'enhance', icon: IconEnhance, labelKey: 'group.enhance' },
		{ id: 'info', icon: IconInfo, labelKey: 'group.info' }
	];

	/**
	 * The tabs of the import/export screen. The two halves are tabs and not one list below each other
	 * because they have nothing to do with each other: one is about save games, the other about the
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
	 * The handle belonging to the attached folder. Deliberately NOT `$state`: nothing draws it, and
	 * it exists only so a folder lost mid-session can be offered for renewal again.
	 */
	let saveDirHandle: unknown = null;

	/**
	 * The marks on the rail icons — the only way to see any of these with the panel closed: a video is
	 * running, a newer version is waiting to take over, or the remembered save folder is not
	 * attached. Module constants and a `$derived` list rather than inline literals, so the rail is
	 * handed a new array only when one of the conditions actually changes.
	 */
	const RECORDING_MARKS: readonly DrawerMark[] = [{ group: 'record', labelKey: 'rail.recording' }];
	const UPDATE_MARKS: readonly DrawerMark[] = [{ group: 'info', labelKey: 'rail.update' }];
	const FOLDER_MARKS: readonly DrawerMark[] = [{ group: 'io', labelKey: 'rail.folder' }];
	const marks = $derived([
		...(recordings.running ? RECORDING_MARKS : []),
		...(updates.ready || updates.switched ? UPDATE_MARKS : []),
		// A remembered folder that is not attached, whatever the reason — after a "no" as well. The
		// statement is the same either way, and it is the only one visible with the panel closed.
		...(saveDirPending !== null ? FOLDER_MARKS : [])
	]);
	/**
	 * A waiting version says so once, over the game — the rail mark alone is easy to miss. The full
	 * text and the restart button stay in the info panel; a restart must never be one stray click
	 * away on the map.
	 */
	$effect(() => {
		if (updates.ready) untrack(() => toasts.push(st('toast.update'), { tone: 'info', ms: 12000 }));
	});

	/**
	 * An archive problem. The drop zone shows it itself when it is up; otherwise — a replacement
	 * archive from the import screen, while a game or the menu is showing — it has to come as a
	 * message, or nobody sees it.
	 */
	function assetProblem(text: string, tone: 'warn' | 'error'): void {
		assetError = text;
		if (archive !== null) toasts.push(text, { tone });
	}
	/**
	 * The open tab of the import/export screen. Deliberately NOT in the settings: on opening it
	 * should sit where most of the work happens, not where someone removed the archive once three
	 * days ago.
	 */
	let ioTab = $state<string>(IO_TABS[0]!.id);
	/**
	 * Same reasoning for the enhancements panel, on both of its levels: which enhancement and which
	 * of its tabs are open is not worth persisting.
	 *
	 * Switching enhancement needs no reset of `enhanceTab`: tab ids are unique across the whole
	 * registry, so the remembered one no longer belongs to the new enhancement and
	 * `enhancementTabFor` falls back to its first — the same rule the panel applies when marking.
	 */
	let enhanceId = $state<string>(ENHANCEMENTS[0]!.id);
	let enhanceTab = $state<string>(ENHANCEMENTS[0]!.tabs[0]!.id);
	const enhancement = $derived(enhancementFor(enhanceId));

	const palette = $derived(palettes[GAME_PALETTE_INDEX] ?? null);
	/**
	 * What the assets tab can say about the loaded file. The LANGUAGE is part of it because it is
	 * visible nowhere else: it hangs off the content of the archive, not off its filename, and it
	 * determines every string of the interface.
	 */
	/**
	 * The original icons for the enhancement screens. Registered HERE and not in the game view: the
	 * dialog is reachable from the main menu too, where no game view exists.
	 */
	$effect(() => {
		if (archive === null || palette === null) return;
		return provideIconSource(archive, palette);
	});

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
	 * Which drawer group is open (`null` = collapsed). Deliberately NOT persisted: a panel is what
	 * you are looking at, not how the program should behave, and a reload is where you want the game
	 * and not the screen you last read. Being session state also drops the guard the persisted id
	 * needed — a stored group can vanish between two versions, a variable holding one of `GROUPS`
	 * cannot.
	 */
	let activeGroup = $state<string | null>(null);

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
			store.onDirectoryLost = saveFolderLost;
			const handle = await store.storedDirectoryHandle();
			if (handle !== null && !saveDirectoryUsable(handle)) {
				// Not marked: renewing this one cannot succeed, so the mark would sit next to a
				// button that has nothing to offer.
				log.warn('assets', 'The remembered save folder cannot be used by this browser.');
			} else if (handle !== null) {
				const dir = await restoreSaveDirectory(handle);
				if (dir !== null) {
					saveDirHandle = handle;
					const report = await store.attachDirectory(dir);
					// Read back from the store, not from `dir`: the permission can go away during that
					// sync, and then the folder is already gone by the time we get here.
					saveDirName = store.directoryLabel;
					log.info(
						'assets',
						`Save folder "${dir.label}": ${report.toDirectory.length} slot(s) written, ${report.toDatabase.length} imported.`
					);
				} else {
					saveDirPending = handle;
					log.info(
						'assets',
						'A save folder is remembered but needs permission again — the next gesture asks.'
					);
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
		saveDirHandle = handle;
		try {
			const report = await store.attachDirectory(dir, handle);
			// See `openSaves`: the store is the one that knows whether the folder survived the sync.
			saveDirName = store.directoryLabel;
			log.info(
				'assets',
				`Save folder "${dir.label}": ${report.toDirectory.length} slot(s) written, ${report.toDatabase.length} imported.`
			);
		} catch (err) {
			saveDirName = store.directoryLabel;
			// Only offer it again if the folder really came off — a full disk leaves it attached, and
			// a button asking for a permission that already holds explains nothing.
			if (saveDirName === null) saveDirPending = handle;
			log.error(
				'assets',
				`Save folder could not be synced: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * The folder permission went away while the session ran.
	 *
	 * NOT asked for again on the next gesture. A permission that merely failed to survive a restart
	 * is a choice waiting to be continued; one taken away with the app running is a choice being
	 * made, and answering it with a dialog is exactly the spam the renewal below avoids. The mark on
	 * the rail and the button stay as the way back.
	 */
	function saveFolderLost(): void {
		saveDirName = null;
		saveDirAsked = true;
		if (saveDirHandle !== null) saveDirPending = saveDirHandle;
		log.warn('assets', 'The save folder lost its permission — the saves stay in the browser.');
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
	 * STORED handle, i.e. on the second visit). What we do control is the MOMENT, and the button in
	 * the import/export screen cannot be it on its own: it is only found by someone who opens that
	 * drawer, and because everything keeps working out of IndexedDB, nothing else hints that the
	 * folder is detached.
	 *
	 * THIS IS NOT DIALOG SPAM but the continuation of a choice made in an earlier session:
	 * `saveDirPending` is only set when a handle IS stored. A "no" (`denied`) ends the question for
	 * this session; `blocked` means "this gesture did not count" and leaves the listeners in place —
	 * so nobody here needs to know which event types carry a user activation (on touch only
	 * `pointerup` does, not `pointerdown`).
	 *
	 * AND THERE IS DELIBERATELY NO CAP ACROSS SESSIONS. Where the permission is session-scoped, a
	 * session IS an app start — a cap would then hit precisely the user who says yes every time and
	 * leave them opening a drawer on every start, for a question one tap settles. Whoever does not
	 * want to be asked again detaches the folder; that button is the way out, not a count.
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
		saveDirHandle = null;
		log.info('assets', 'Save folder detached — the saves stay in the browser.');
	}

	async function onfile(file: File): Promise<void> {
		if (!looksLikeArchive(file.name)) {
			const text = st('assets.badType', { file: file.name });
			assetProblem(text, 'warn');
			log.warn('assets', text);
			return;
		}
		busy = true;
		try {
			const raw = await file.arrayBuffer();
			apply(PaArchive.parse(raw), file.name);
			await cacheArchive(file.name, raw);
			log.info('assets', `${file.name} stored in the browser.`);
			toasts.push(st('assets.loaded', { file: file.name }), { tone: 'good' });
		} catch (err) {
			const text = st('assets.unreadable', { why: err instanceof Error ? err.message : String(err) });
			assetProblem(text, 'error');
			log.error('assets', text);
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
		activeGroup = null;
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
				// `gs+0x35a` — the menu buffer and the game field are ONE cell in the original.
				levelPassword: menu.password,
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

	/** The shell element itself — the two effects below are about the window, not about a view. */
	let shellEl: HTMLDivElement | undefined = $state();

	/*
		ONE MEANING FOR A PINCH, across the whole application. `touch-action` below settles it wherever
		it is honoured; this covers WebKit, which ignores it for the pinch. It hangs here rather than
		on each view because the events bubble — the game view and the main menu are both inside.
	*/
	$effect(() => {
		const el = shellEl;
		if (el === undefined) return;
		return blockPageZoom(el);
	});

	/*
		THE SHELL IS LAID ON THE PART OF THE WINDOW THAT IS VISIBLE, not on the layout viewport that
		`100dvh` measures. The on-screen keyboard shrinks the one and not the other, and so does a
		pinch on the engines where neither line above bites — either way the rail and the control bar
		would end up off-screen, and there is no way back: nothing here scrolls, and over the map the
		gesture belongs to the map.

		Without the API nothing is written and the CSS below stands on its own.
	*/
	$effect(() => {
		const el = shellEl;
		const env = visualViewportEnv();
		if (el === undefined || env === null) return;
		return followVisualViewport((box) => {
			el.style.width = `${box.w}px`;
			el.style.height = `${box.h}px`;
			el.style.transform = `translate(${box.x}px, ${box.y}px)`;
		}, env);
	});
</script>

<div class="shell" bind:this={shellEl}>
	<DrawerRail
		groups={GROUPS}
		active={activeGroup}
		{marks}
		onselect={(id) => (activeGroup = id)}
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
			<OverlayPanel title={st('group.settings')} onclose={() => (activeGroup = null)}>
				<SettingsPanel />
			</OverlayPanel>
		{:else if activeGroup === 'io'}
			<OverlayPanel
				title={st('group.io')}
				tabs={IO_TABS}
				tab={ioTab}
				ontab={(id) => (ioTab = id)}
				onclose={() => (activeGroup = null)}
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
							{#if saveDirPending !== null}
								<p class="note">{st('folder.renews')}</p>
							{/if}
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
			<OverlayPanel title={st('group.bug')} onclose={() => (activeGroup = null)}>
				<BugReportPanel />
			</OverlayPanel>
		{:else if activeGroup === 'record'}
			<OverlayPanel title={st('group.record')} onclose={() => (activeGroup = null)}>
				<RecordingPanel />
			</OverlayPanel>
		{:else if activeGroup === 'enhance'}
			<OverlayPanel
				title={st('group.enhance')}
				tabs={enhancement.tabs}
				tab={enhancementTabFor(enhancement, enhanceTab).id}
				ontab={(id) => (enhanceTab = id)}
				onclose={() => (activeGroup = null)}
			>
				{#snippet nav()}
					<EnhancementNav
						enhancements={ENHANCEMENTS}
						active={enhancement.id}
						onselect={(id) => (enhanceId = id)}
					/>
				{/snippet}
				<EnhancementsPanel {enhancement} tab={enhanceTab} />
			</OverlayPanel>
		{:else if activeGroup === 'info'}
			<OverlayPanel title={st('group.info')} onclose={() => (activeGroup = null)}>
				<InfoPanel />
			</OverlayPanel>
		{/if}

		<!-- Last in the stage, so a message stands over an open panel as well. -->
		<ToastStack />
	</div>
</div>

<style>
	/*
		`fixed` and not just a block in the flow: the effect above moves the shell onto the visible
		part of the window, and `offsetLeft`/`offsetTop` count from the layout viewport — which is
		exactly where a `fixed` element without a transformed ancestor sits. The values here are what
		holds while nothing has shrunk the visible area, and where the API is missing they are all
		there is.

		`touch-action: pan-y` is the page zoom, turned off. `none` would be wrong: the effective value
		is the INTERSECTION down the ancestor chain, so a `none` here could not be taken back below and
		the panels (`overflow: auto`) would lose their scrolling. `pan-y` keeps that and drops pinch
		and double-tap zoom. The game view sets `none` for itself, which wins over this.
	*/
	.shell {
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100dvh;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		overflow: hidden;
		touch-action: pan-y;
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
