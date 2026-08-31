<script lang="ts">
  import { untrack } from 'svelte';
  import type { SaveGameState, DecodedSprite } from '../core/types.js';
  import { HEIGHT_UNIT, TILE_W, TILE_H } from '../core/map-render.js';
  import { buildOptionsView, buildSettingsView, engineEntityIndex } from './map-view-data.js';
  import {
    cameraCenteredOnTile,
    cameraCenterTile,
    minZoomForWholeMap,
    gotoOwnCastle,
    scrollCenterTileByEdgeMask,
    windowToTile,
    type Camera,
  } from '../core/viewport-camera.js';
  import { IndexPresenter } from './index-presenter.js';
  import { groundSignature } from '../core/terrain-retention.js';
  import { renderMapFrame } from './map-frame-render.js';
  import {
    createSoundMixer,
    createSoundQueue,
    enqueueSound,
    serviceSound,
    soundServiceDue,
    tickSoundVoices,
    type SoundMixer,
  } from '../core/sound.js';
  import { createSoundLatches } from '../core/sound-emit.js';
  import { musicShouldPlay } from '../core/music.js';
  import { advanceCampaignProgress, type CampaignProgress } from '../core/main-menu.js';
  import { MusicPlayer } from './music-player.js';
  import {
    CONTROL_BAR_SOUND_ICONS,
    UI_SOUND_ACCEPT,
    UI_SOUND_DEMOLISH_ROAD,
    UI_SOUND_PANEL_BUTTON,
    UI_SOUND_QUIT_CONFIRM,
    UI_SOUND_RECALL_SET,
    UI_SOUND_REJECT,
    buildMenuOutcomeSound,
    demolishOutcomeSound,
    plainMapClickSilent,
  } from '../core/ui-sound.js';
  import { demolishOutcomeAt } from '../core/engine/demolish.js';
  import EndCreditsView from './EndCreditsView.svelte';
  import TextEntryField from './TextEntryField.svelte';
  import StockOverlay from '../enhancements/StockOverlay.svelte';
  import {
    buildStockView,
    stockRefreshDue,
    type StockSelection,
    type StockView,
  } from '../enhancements/stock-overview.js';
  import { SfxPlayer } from './sfx-player.js';
  import { TerrainSurface } from './terrain-surface.js';
  import {
    buildBorderKit,
    buildRoadKit,
    buildSpriteKit,
    createIndexedSpriteSource,
    tryLoadAnimationTable,
  } from './sprite-kit.js';
  import { isSpectatorGame } from '../core/engine/new-game.js';
  import { mapGeometry, posOf } from '../core/engine/position.js';
  import { decodeSprite } from '../core/sprite-decoder.js';
  import type { PaArchive } from '../core/pa-parser.js';
  import type { Palette } from '../core/types.js';
  import { loadState, snapshot, type GameState } from '../core/engine/state.js';
  import {
    DISK_RESULT,
    DISK_SCREENS,
    DISK_SCREEN_ARCHIV,
    DISK_SCREEN_LIST,
    DISK_SCREEN_LIST_REDRAW,
    DISK_SCREEN_RESULT,
    DISK_SLOT_BAR_COLOR_INDEX,
    applyDiskMenuAction,
    applyDiskMenuKey,
    clickDiskScreen,
    completeDiskOperation,
    diskSaveResetsClocks,
    enterDiskMenu,
    type DiskMenuState,
  } from '../core/disk-menu.js';
  import { encodeSaveGame } from '../core/save-encoder.js';
  import { parseSaveGame } from '../core/save-parser.js';
  import type { SaveStore } from '../core/save-store.js';
  import {
    buildDebugReport,
    type DebugReport,
    type RecordedAction,
  } from './debug-export.js';
  import { bugReports } from '../shell/bug-report.svelte.js';
  import { simulation } from '../shell/simulation.svelte.js';
  import { log } from '../shell/log.js';
  import { st } from '../shell/i18n.js';
  import { metrics } from './render-metrics.js';
  import { settings, ticksPerSecondOf } from '../settings/settings.svelte.js';
  import { logicFrame, runTicks } from '../core/engine/tick.js';
  import { missionEndScreenDue, writeMissionEndPassword } from '../core/engine/economy.js';
  import {
    drawMissionEndPopup,
    missionEndPassword,
    missionEndSteps,
    MISSION_END_EXIT_BAR_ICONS,
    MISSION_END_EXIT_SCREEN,
    type MissionEndView,
  } from '../core/mission-end-popup.js';
  import { TickScheduler, DEFAULT_TICKS_PER_SECOND } from '../core/engine/scheduler.js';
  import { startTickClock } from './tick-clock.js';
  import {
    applyAttackLaunch,
    applyAttackPrepare,
    applyCommand,
    applyRecruitKnights,
    applyRoadBuildClick,
    buildFlagRejection,
    canApplyCommand,
    type Command,
  } from '../core/engine/commands.js';
  import { canAttachFlagToRoad } from '../core/engine/road-attach.js';
  import {
    updateRoadMarkers,
    roadEdgeScroll,
    SOUND_EDGE_SCROLL,
    ROAD_BAR_ICONS_ENTER,
    ROAD_BAR_ICONS_LEAVE,
    type RoadBuildingState,
    type RoadClickResult,
  } from '../core/engine/road-building.js';
  import {
    buildMenuClickOutcome,
    classifyBuildSite,
    CURSOR_BUILDING,
    CURSOR_REMOVABLE_FLAG,
    BUILD_LARGE,
  } from '../core/engine/build-site.js';
  import { BUILDING_TYPE_NAMES } from '../core/save-parser.js';
  import { BUILD_SCREENS, buildPopupAction, nextBuildScreen } from '../core/build-popup.js';
  import {
    drawBuildMenuBody,
    drawMenuBody,
    drawObjectPopupBody,
    paintPopup,
    POPUP_W,
    POPUP_H,
  } from './popup-draw.js';
  import { boxPixel, originBoxRect, uiScaleFor } from './ui-layout.js';
  import { composeUiOverlay, type OverlayLayer } from './ui-overlay.js';
  import {
    clearFramebuffer,
    clickControlPanel,
    contextBarState,
    createFramebuffer,
    drawControlPanel,
    drawControlPanelFrame,
    drawMapPreviewBar,
    drawMessageIndicators,
    hitPopupPlayerButton,
    hitTestControlPanelButton,
    hitTestPanel,
    CONTROL_PANEL_BOUNDS,
    BUILD_HELPER_TOGGLE_ICONS,
    CONTROL_PANEL_BUTTON_ACTIONS,
    CONTROL_PANEL_DEFAULT_ICONS,
    controlPanelIconsAfterClose,
    mapSpecialClickScreen,
    panelActionMatchesClick,
    POPUP_BOUNDS,
    MAP_AREA,
    SLIDER_BAR_COLOR_INDEX,
    type CursorMarkerPair,
    type Framebuffer,
    type PanelButtonAction,
    type PopupPlayerButtonsView,
    type SpriteProvider,
  } from '../core/ui-render.js';
  import { analyzeSoil } from '../core/engine/soil-analysis.js';
  import { SOIL_POPUP_ACTION_EXIT, drawSoilPopup, soilPopupAction } from '../core/soil-popup.js';
  import { buildMinimap } from '../core/minimap.js';
  import { MENU_SCREENS, menuPopupAction } from '../core/menu-popup.js';
  import {
    MESSAGE_POPUP_HITBOXES,
    MESSAGE_ACTION_CLOSE,
    drawMessagePopup,
    hitMessagePanelStrip,
    hitRecallClockStrip,
    messageHasPosition,
    messageStripShowOutcome,
    messageType,
    popMessage,
    pruneFilteredMessages,
  } from '../core/message-popup.js';
  import {
    createMessageOverlayState,
    hasVisibleMessage,
    messageOverlayDisplay,
    noteArrowClicked,
    noteMessageShown,
    serviceMessageOverlay,
  } from '../core/message-overlay.js';
  import {
    recallClockRow,
    recallClockRowEighths,
    recallIsBuildingScreen,
    recallMenuIndex,
    recallQueueFull,
  } from '../core/engine/message-recall.js';
  import {
    SETTINGS_SCREENS,
    clickSettingsPopup,
    type SettingsPopupView,
  } from '../core/settings-popup.js';
  import {
    OPTIONS_SCREENS,
    QUIT_POPUP_SCREEN,
    clickOptionsPopup,
    type OptionsPopupView,
  } from '../core/options-popup.js';
  import { DEVICE_SCREEN, clickDevicePopup } from '../core/device-popup.js';
  import {
    MAP_FILTER_SCREENS,
    applyMapFilterClose,
    applyMapFilterSelection,
    clickMapFilterPopup,
  } from '../core/map-filter-popup.js';
  import {
    DEVICE_OPTIONS_DEFAULT,
    commitDeviceOptions,
    cycleDeviceMode,
    loadDeviceWorkingCopy,
    stepDeviceValue,
    type DeviceOptions,
  } from '../core/engine/device-options.js';
  import {
    VIEW_OPTION_FAST_BUILD_CLICK,
    VIEW_OPTION_FAST_MAP_CLICK,
    VIEW_OPTION_ROAD_SCROLL,
    hasViewOption,
    stepVolume,
    viewOptions,
  } from '../core/engine/view-options.js';
  // Only the PIXEL COMPUTATION of the slider: the nine menu actions themselves run through the
  // command layer (`commands.ts`) so they appear in the action log.
  import { sliderValueFromClick } from '../core/engine/player-settings.js';
  import {
    STATS_SCREENS,
    clickStatsPopup,
    compareAspect,
    compareLevel,
    compareMode,
  } from '../core/stats-popup.js';
  import { playerFaces, SETUP_PASSWORD_BYTES } from '../core/player-setup.js';
  import { flagPopupAction } from '../core/flag-popup.js';
  import { attackPopupAction } from '../core/attack-popup.js';
  import {
    DEMOLISH_ACTION_CONFIRM,
    DEMOLISH_SCREEN,
    clickDemolishPopup,
  } from '../core/demolish-popup.js';
  import {
    DISPLAY_ONLY_POPUP_HITBOXES,
    castlePopupAction,
    serfCensusPopupAction,
    inventoryModePopupAction,
  } from '../core/building-popup.js';
  import {
    CURSOR_HOTSPOT,
    CURSOR_MAX_SCALE,
    CURSOR_SPRITE_INDEX,
    buildCursorCanvas,
    cursorScaleOf,
    cursorStyleFrom,
  } from './mouse-cursor.js';
  import { recordings } from '../shell/recording.svelte.js';
  import {
    MAP_PREVIEW_ACTION,
    MAP_PREVIEW_HITBOXES,
    PREVIEW_X,
    PREVIEW_Y,
    PREVIEW_ZOOM,
    applyMapPreviewAction,
    drawMapPreview,
    mapPreviewClickToTile,
    mapPreviewOrigin,
    previewTileStep,
    type MapPreviewData,
  } from '../core/map-preview.js';

  import { anchorCamera, pinchZoom, scenePoint, wheelZoomFactor } from './zoom-gesture.js';
  import {
    TOUCH_HOLD_MS,
    TOUCH_IDLE,
    touchDown,
    touchMove,
    touchTick,
    touchUp,
  } from './touch-gesture.js';

  let {
    save,
    archive = null,
    palette = null,
    sourceFile = undefined,
    sourceBytes = null,
    store = null,
    onload = undefined,
    onquit = undefined,
  }: {
    save: SaveGameState;
    archive?: PaArchive | null;
    palette?: Palette | null;
    /** File name of the loaded save — goes into the bug report only. */
    sourceFile?: string;
    /**
     * Raw bytes of the source file, if there is one. On SAVING they fill the ranges our model does not
     * hold yet (`encodeSaveGame({ base })`). Without them there are zeroes — a freshly created game
     * has no source file, and that is the situation, not an error.
     */
    sourceBytes?: Uint8Array | null;
    /** The save storage (`core/save-store.ts`); `null` = not opened yet. */
    store?: SaveStore | null;
    /** A save was loaded in the disk menu — the page swaps the game state. */
    onload?: (save: SaveGameState, bytes: Uint8Array) => void;
    /** "JA" in the ENDE dialog: leave the game (`gs+0x1c9` bit 2, see `applyOptionsClick`). */
    /**
     * Leave the game — with the CAMPAIGN PROGRESS the exit "ENDE/JA" yields
     * (`advanceCampaignProgress`). `null` = not a campaign game, then the menu state stays.
     */
    onquit?: (progress: CampaignProgress | null) => void;
  } = $props();

  // Animation table from the archive (for serf sprites); null without an archive or on a parse error.
  const animTable = $derived(archive === null ? null : tryLoadAnimationTable(archive));

  // Player colours (4 slots) — category colours, not an original palette.
  const PLAYER_COLORS: readonly [number, number, number][] = [
    [0x00, 0xe3, 0xe3], // player 0 – cyan
    [0xcf, 0x63, 0x63], // player 1 – red
    [0xdf, 0x7f, 0xef], // player 2 – violet
    [0xef, 0xef, 0x8f], // player 3 – yellow
  ];

  let showObjects = $state(true);
  let showBuildings = $state(true);
  let showFlags = $state(true);
  let showSerfs = $state(true);
  let showRoads = $state(true);
  /**
   * The map is always drawn in relief (original look). The flat mode (`heightUnit = 0`) remains as a
   * computing mode of the renderer — only without a control.
   */
  const heightUnit = HEIGHT_UNIT;

  // --- deterministic tick engine (play/pause) ----------------------------------------------------
  // The scheduler is a stable, NON-reactive object (fixed accumulator); the speed is controlled
  // through `ticksPerSecond`.
  const scheduler = new TickScheduler(DEFAULT_TICKS_PER_SECOND);
  // The original knows no pause: it runs as soon as a game is open. Our play/pause is an extension
  // and sits in the shell's settings overlay — the wish therefore comes in via `simulation.running`,
  // not from a control of this view.
  const running = $derived(simulation.running);
  /**
   * Four things additionally stop the clock. Three of them are original screens, and all three do it
   * IN THEIR RENDERER (`call pause_game_clock` @0x3ecb9 as the first instruction: end dialog
   * @0x3bd6c, mission end @0x3831d, disk menu @0x3ed98) — which is exactly why this is a derived
   * value and not a remembered one: they can be closed in many ways (`closePopups` has two dozen
   * callers), and a parked running state would get stuck on every one that does not put it back.
   *
   * `pause_game_clock` is a PAIR in the original: it parks the tick rate `gs+0x1fe` in `gs+0x1fa` and
   * zeroes it, `resume_game_clock` @0x3ecd7 fetches it back. Seven stopping and eight resuming sites
   * are recorded; the two of the disk menu are @0x28532 and @0x285a9. In LOAD mode it is never
   * resumed — there the sequence ends in the main menu.
   *
   * **One deliberate deviation:** the original only stops at screen 0x18, i.e. one frame after 0x17.
   * Here all four disk screens are included, because the folder reconciliation sits in 0x17 and can
   * take arbitrarily long — one frame in the original against an open wait here.
   */
  const playing = $derived.by(
    // `$derived.by`, because the two popup states stand further below: the alternative would be to
    // pull them out of their context up here.
    () =>
      running &&
      menuScreen !== QUIT_POPUP_SCREEN &&
      missionEndStep === null &&
      !diskMenuOpen &&
      // The fourth is its own: an open report window freezes the state it describes.
      !bugReports.composing,
  );
  /** Tick rate from the stored speed multiple (default 1× = 100 ticks/s). */
  const ticksPerSecond = $derived(ticksPerSecondOf(settings.value.speedFactor));
  // Frame counter: the rAF loop mutates `engineState` in place (not reactive) and bumps this counter
  // so `renderState` / the blit effect recompute per frame.
  let frameVersion = $state(0);
  const canPlay = $derived(archive !== null && palette !== null);

  // --- sound effects (drawing passes enqueue, the service drains into four voices) ---------------
  //
  // All three parts are mutable plain objects and deliberately NOT reactive — just like `engineState`
  // and the scheduler: the drawing passes refill the queue every frame, the service drains it in the
  // same pass. A signal on them would be an endless loop (the render effect reads and writes the same
  // values) and useless, because none of it is displayed.
  const soundQueue = createSoundQueue();
  const soundLatches = createSoundLatches();
  /**
   * Last logic frame that sounded ({@link logicFrame} — the same computation with which the original
   * forms its animation phases; `gameTick` grows by 8 per frame).
   *
   * Why this is necessary: in the original drawing and logic are the SAME pass, so the sounds arise
   * exactly once per frame (~12.5/s). Here `requestAnimationFrame` draws at ~60/s, and the sound
   * passes hang on drawing (that is the original architecture, see `sound-emit.ts`). Without this gate
   * every `always` branch enqueues about FIVE TIMES too often — audible at the sawmill and the smith,
   * whose sound ran longer than the work, and at the FISHERMAN, the only place in the original with no
   * latch at all, which therefore enqueues in every frame.
   * No `$state`: the value is only read and written inside the drawing effect.
   */
  let lastSoundFrame = -1;
  /**
   * Last DRAWN logic frame. Kept apart from {@link lastSoundFrame} although both hold the same number:
   * sound hangs on the drawing pass (including one triggered by moving the camera), the drawing here
   * on the progress of the simulation. A shared marker would reset the drawing rate on every camera
   * frame. No `$state`, same reasoning as above: read/written only inside the clock callback.
   */
  let lastDrawnFrame = -1;
  /**
   * Frame period of the original in ms (12.5 fps). Needed ONLY with the simulation paused, see
   * {@link playUiSound}.
   */
  const ORIGINAL_FRAME_MS = 80;
  /** Time of the last queue service (real time) — only for the paused case. */
  let lastServiceMs = 0;
  /**
   * A random stream of its own plus the four voices. Seeded from the three `random` words of the save
   * (`.DS`@84/86/88) — in the original the sound layer draws the same RNG as the logic; we separate
   * the streams so the frame rate does not feed into the game (reasoning in `core/sound.ts`).
   */
  // `untrack`, because only the INITIAL save is read here on purpose: the stream is updated on a save
  // change in the reset effect below, not through reactivity.
  let soundMixer: SoundMixer = createSoundMixer(untrack(() => save.header.random));

  /**
   * Browser playback (`sfx-player.ts`). Only possible with an archive (BYOA — the sounds are archive
   * entries from slot 3899) and only audible after a user gesture: `resume()` runs from the map
   * handlers, before that the player discards silently. `$state.raw` so the volume coupling below
   * gets the fresh instance.
   *
   * Deliberately an `$effect` with a cleanup return and NOT a `$derived`: the player holds an
   * `AudioContext` and sounding voices — a discarded value has to be switched off, and only the
   * cleanup function can do that.
   */
  let sfxPlayer = $state.raw<SfxPlayer | null>(null);

  $effect(() => {
    const ar = archive;
    if (ar === null) return;
    const player = new SfxPlayer(ar);
    player.setMasterVolume(untrack(() => uiVolume));
    sfxPlayer = player;
    return () => {
      player.stopAll();
      if (sfxPlayer === player) sfxPlayer = null;
    };
  });

  // Volume from the options screen (0x25) to the mixer — `gs+0x3dc` in the original, the value the
  // driver call takes along.
  $effect(() => {
    sfxPlayer?.setMasterVolume(uiVolume);
  });

  // Tick off ⇒ whatever is sounding stops at once. Without that a started voice would run its full
  // duration — with the music tick the original does the same at the same place.
  $effect(() => {
    if (!uiSfx) sfxPlayer?.stopAll();
  });

  /**
   * **Background music** (`music-player.ts`, facts in `core/music.ts`). One track, endless, archive
   * entry 3989 — started in the init chain in the original (@0xb162) and stopped only by the tick in
   * the options screen or by the mission end.
   *
   * The same construction as the effect player above, and an `$effect` with a cleanup return for the
   * same reason: the player holds `AudioContext` + WASM synth.
   */
  let musicPlayer = $state.raw<MusicPlayer | null>(null);

  $effect(() => {
    const ar = archive;
    if (ar === null) return;
    const player = new MusicPlayer(ar);
    player.setVolume(untrack(() => uiVolume));
    musicPlayer = player;
    return () => {
      if (musicPlayer === player) musicPlayer = null;
      void player.dispose();
    };
  });

  $effect(() => {
    musicPlayer?.setVolume(uiVolume);
  });

  /**
   * The tick from screen 0x25 to the player — the counterpart of `gs+0x1cb` bit 1
   * (`musicShouldPlay`, see `core/music.ts`).
   *
   * Why `start()` stands here AND in the click path: this effect also runs when the tick was already
   * on before there was an archive — then the `AudioContext` is not yet permitted and `start()` only
   * notes the wish. The first map click wakes it (see `resumeAudio`). Without the duplication the
   * user would have to switch the tick off and on again to get music.
   */
  $effect(() => {
    const player = musicPlayer;
    // The MISSION END is the only place in the original that stops the music without user action:
    // `call 0xbe7f` @0x38322 at the start of `draw_popup_mission_end`, `call 0xbf5b` @0x38886 at its
    // end. Not on pausing the simulation — the original knows no pause, and the stop there is a call
    // of its own BESIDE `pause_game_clock`, not a side effect of it.
    const missionEndOpen = missionEndStep !== null;
    // The DISK MENU is the second: its entry calls `stop_music` @0xbe7f right after
    // `pause_game_clock` (@0x3ed9d), and both exits start it again with `0xbf5b` (@0x28490 /
    // @0x28550). They are the same two routines the music switch of the options screen uses — so no
    // new mechanism here.
    const diskOpen = diskMenuOpen;
    // Counterpart to `gs[0x1f5] == 0`: without an archive there is no track — as in the original,
    // where the switch stays ineffective without a driver (`@0x2d6be`).
    if (missionEndOpen || diskOpen || !musicShouldPlay(player !== null, uiMusic)) {
      player?.stop();
      return;
    }
    void player!.start();
  });

  // --- action/command layer (deterministic, applied at tick boundaries = AI/MP interface) ---------
  // Command queue: deliberately NOT reactive (plain array). Drained at the frame/tick boundary.
  const commandQueue: Command[] = [];
  // true as soon as the live state has been touched (tick run OR command applied) — from then on the
  // view renders the live snapshot instead of the static original save, paused as well.
  let engineDirty = $state(false);
  // Bumps ONLY on map-changing actions (demolition etc.) → triggers the rare redraw of the base layer
  // (terrain/roads) WITHOUT re-rendering the whole map per tick frame.
  let mapVersion = $state(0);
  /**
   * Fingerprint of the ground-relevant tile fields at the last build of the retained surface. Not
   * reactive: read and written exclusively in the clock callback of the logic loop.
   */
  let lastGroundSig = -1;
  // Clicked tile (pinned selection for the action bar); null = nothing selected.
  let selected = $state<{ col: number; row: number } | null>(null);

  // Live game state: rebuilt on every new `save` (new file). Mutated in place while playing; the
  // mutation is deliberately NOT reactive (plain object).
  const engineState = $derived<GameState>(loadState(save));

  // On a new state (file change): let the clock run, reset accumulator and frame counter.
  $effect(() => {
    void engineState;
    untrack(() => {
      // A freshly opened game runs — even if the previous one was left paused.
      simulation.running = true;
      scheduler.reset();
      frameVersion = 0;
      engineDirty = false;
      commandQueue.length = 0;
      barIcons = [...CONTROL_PANEL_DEFAULT_ICONS]; // panel back to its initial state
      closePopups();
      restoreCursorFromSave();
      // Sound layer onto the new save: reseed the stream from its `random` words, abort sounding
      // voices, clear the once-latches of the drawing passes (they buffer only one beat).
      soundMixer = createSoundMixer(engineState.header.random);
      soundLatches.serf.clear();
      soundLatches.building.clear();
      // The new save brings its own `tick`; without a reset the sound gate would stay silent until
      // the old frame counter is reached (or fire once too early).
      lastSoundFrame = -1;
      sfxPlayer?.stopAll();
    });
  });

  // Pass the speed on to the scheduler (select ⇒ ticksPerSecond ⇒ setSpeed).
  $effect(() => {
    scheduler.setSpeed(ticksPerSecond);
  });

  /*
   * Clock and speed are operated from the settings overlay (`shell/simulation.svelte.ts` respectively
   * `settings.speedFactor`). The ZOOM explicitly does not belong there: it runs exclusively through
   * the mouse wheel, a control for it is not provided.
   */
  // While this view is up, the shell has a clock to operate; it starts out running.
  $effect(() => (canPlay ? simulation.provide() : undefined));
  // What actually becomes of it the view reports back — the original screens stop the clock by
  // themselves, and the overlay should show that instead of claiming it runs.
  $effect(() => {
    simulation.active = playing;
  });

  /**
   * **The live state has been changed** — the one place where the display learns of it.
   *
   * Two things hang on this, and they are easy to overlook because `engineState` is deliberately NOT
   * reactive (plain object, mutated in place):
   * 1. `engineDirty` switches the render source from the STATIC original save to the live snapshot.
   *    If it stays clear, the view keeps drawing the file while paused — a change is then *invisible*,
   *    not merely late.
   * 2. `map = true` bumps `mapVersion` and thus `surfaceVersion`: only that rebuilds the RETAINED
   *    ground/road surface. Without it a map change appears only once something else changes the
   *    version (territory recolouring, next command) — exactly the "appears some time later".
   *
   * Every path touching `engineState` outside the command layer has to go through here.
   */
  function markEngineMutated(map = false): void {
    engineDirty = true;
    if (map) mapVersion += 1; // redraw the base layer (roads/objects)
    frameVersion += 1; // recompute rendering and action gating
  }

  /**
   * Enqueue an INTERACTION SOUND (`enqueue_sound_priority` @0x3688a, `core/ui-sound.ts`).
   *
   * The repaint nudge belongs to it: the queue is drained in the drawing effect, and that runs only
   * when something reactive changes. With the simulation PAUSED there is no logic tick to trigger it
   * anyway — without this `frameVersion` the sound would stay in the queue until the next click.
   */
  function playUiSound(sound: number): void {
    enqueueSound(soundQueue, sound);
    frameVersion += 1;
  }

  // Apply all waiting commands at the current tick boundary (in order, deterministic). Returns true
  // when at least one was carried out.
  function flushCommands(): boolean {
    let applied = false;
    while (commandQueue.length > 0) {
      const ok = runCommand(commandQueue.shift()!);
      if (ok) applied = true;
    }
    if (applied) markEngineMutated(true);
    applyRoadBuildAbort();
    consumeContextDirty();
    // An applied action may have enqueued a message (combat, occupation, warehouse …). With the
    // simulation paused there is no frame to collect the wake-up — hence here.
    serviceMessageIndicators(0);
    return applied;
  }

  /**
   * The dirty bit `vp[1]` bit 2 of the build-site classification — the tile whose cursor kind has to
   * be determined anew after a command has been APPLIED.
   *
   * Why this is necessary: the original carries out a build action IMMEDIATELY and lets the frame
   * handler catch up with the classification afterwards. Our command layer is deterministically
   * timed — while playing there is a tick between click and effect. A `refreshContextIcons` right
   * after `enqueueCommand` would therefore classify the OLD state: after placing a flag the cursor
   * kind stayed on "there is room here" instead of jumping to "removable flag". With the simulation
   * paused it did not show — there `enqueueCommand` applies at once.
   */
  let contextDirtyAt: { col: number; row: number } | null = null;

  /** Set the dirty bit (`vp[1] |= 4`) — before enqueueing, as the original does before the effect. */
  function markContextDirty(col: number, row: number): void {
    contextDirtyAt = { col, row };
  }

  /** Process and clear the dirty bit (`if (vp[1] & 4) { vp[1] &= ~4; classify_build_site(); … }`). */
  function consumeContextDirty(): void {
    const at = contextDirtyAt;
    if (at === null) return;
    contextDirtyAt = null;
    refreshContextIcons(at.col, at.row);
  }

  // Enqueue a command. While paused it is applied at once at the current tick boundary; while playing
  // the logic loop drains the queue at the next beat.
  function enqueueCommand(cmd: Command): void {
    commandQueue.push(cmd);
    if (!playing) flushCommands();
  }

  /**
   * **Action log for the debug report.** Every applied command with game tick and outcome.
   *
   * Recorded in `flushCommands`, i.e. WHEN APPLIED and not when enqueued: only there is the tick at
   * which the command takes effect settled, and only there is it known whether the engine accepted
   * it. The REJECTED ones in particular are often the interesting case when debugging.
   *
   * Why this runs along at all: the engine is deterministic, from a save I can compute forward as far
   * as I like — but not guess the clicks that led to the wrong picture. The ring buffer caps the
   * memory; older entries drop out.
   */
  const ACTION_LOG_LIMIT = 500;
  let actionLog = $state<RecordedAction[]>([]);

  /**
   * **Apply a command now and log it** — the only way a command enters the state.
   *
   * The logging sits at the APPLICATION, not at the transport: hanging `recordAction` on
   * {@link flushCommands} would tie it to the queue, and the commands applied immediately (demolish
   * confirmation, "attach road") would be missing from the log.
   */
  function runCommand(cmd: Command): boolean {
    const ok = applyCommand(engineState, cmd);
    recordAction(cmd, ok);
    return ok;
  }

  /**
   * Apply a road-building click and log it. An entry point of its own, because the interaction layer
   * needs sound, "road finished" and the segment count — the same effect as {@link runCommand}, see
   * `applyRoadBuildClick`.
   */
  function runRoadClick(cmd: Extract<Command, { kind: 'roadBuildClick' }>): RoadClickResult {
    const res = applyRoadBuildClick(engineState, cmd);
    recordAction(cmd, res.applied);
    return res;
  }

  /** Prepare an attack and log it; the interaction layer needs sound and the reason for failure. */
  function runAttackPrepare(cmd: Extract<Command, { kind: 'prepareAttack' }>) {
    const res = applyAttackPrepare(engineState, cmd);
    recordAction(cmd, res.applied);
    return res;
  }

  /** Launch an attack and log it; the interaction layer needs sound and "window closed". */
  function runAttackLaunch(cmd: Extract<Command, { kind: 'launchAttack' }>) {
    const res = applyAttackLaunch(engineState, cmd);
    recordAction(cmd, res.applied);
    return res;
  }

  /** Recruit and log; the interaction layer needs the count for sound and note. */
  function runRecruit(cmd: Extract<Command, { kind: 'recruitKnights' }>): { recruited: number } {
    const res = applyRecruitKnights(engineState, cmd);
    recordAction(cmd, res.applied);
    return res;
  }

  function recordAction(cmd: Command, applied: boolean): void {
    const { kind, ...detail } = cmd as { kind: string } & Record<string, unknown>;
    actionLog.push({ tick: engineState.gameTick, kind, detail, applied });
    if (actionLog.length > ACTION_LOG_LIMIT) actionLog = actionLog.slice(-ACTION_LOG_LIMIT);
  }

  /**
   * **Collect a bug report.** It is triggered in the shell's debug overlay; only the gathering stands
   * here, because only this view knows state, camera and canvas. What belongs in it is in
   * `debug-export.ts`; out comes a ZIP package the shell downloads.
   */
  async function collectBugReport(note: string): Promise<DebugReport> {
    // The PNG comes from the visible map canvas. `toDataURL` can fail (lost context) — then the
    // report goes out without the image instead of not at all.
    let png: string | null = null;
    try {
      png = host?.toDataURL('image/png') ?? null;
    } catch {
      png = null;
    }
    return buildDebugReport({
      note,
      state: snapshot(engineState),
      actions: actionLog,
      screenshotDataUrl: png,
      sourceFile,
      // The drawing costs of this machine. Nothing displays them; the measurement exists for exactly
      // this line of the report.
      render: metrics.report(),
      view: {
        camX,
        camY,
        zoom,
        viewportW,
        viewportH,
        popupScreen: menuScreen,
        previewOpen,
        roadBuilding: roadBuild().active,
        playing,
        barIcons: barIcons.slice(),
        marked: selected,
      },
    });
  }

  $effect(() => bugReports.provide(collectBugReport));

  /**
   * Logic loop. Runs ONLY while playing; it reads `playing`/`engineState` (dependencies), drives logic
   * ticks from the elapsed real time and bumps `frameVersion` in the clock callback — that write
   * happens outside the effect's tracking scope, so there is no self-retrigger loop.
   *
   * The BEAT comes from `tick-clock.ts` and no longer directly from `requestAnimationFrame`: with the
   * tab invisible the browser stops rAF, and the simulation then stood still without anyone having
   * pressed pause. In that case the clock switches to a worker beat.
   *
   * **Invisible we compute but do not draw**: `frameVersion` stays put so neither snapshot nor blit
   * pass does work for an image nobody sees. On coming back the first visible beat bumps once even if
   * no tick was due — otherwise the map would show the state from before the switch until the next
   * tick.
   *
   * Side effect, deliberately so: the sound passes hang on drawing (original architecture, see
   * `sound-emit.ts`) — so no new sounds arise in the background. On coming back one pass runs for the
   * then current logic frame, not for the missed ones.
   */
  $effect(() => {
    if (!playing) return;
    // Every pause ends with an empty accumulator — otherwise the standing time would come through as
    // a burst of ticks.
    scheduler.reset();
    const gs = engineState;
    let wasHidden = false;
    return startTickClock((deltaMs, visible) => {
      // **The whole callback is measured** (`pump`), the simulation within it once more separately
      // (`logic`). Reason: a report proved the drawing side uncritical (2.6 ms at 15.4 frames/s) and
      // had NO number for this side — without it the next question about CPU load is unanswerable.
      // Cost of the measurement itself: 1.9 µs per frame.
      metrics.begin('pump');
      const n = scheduler.pump(deltaMs);
      flushCommands(); // apply pending commands on the frame/tick boundary
      if (n > 0) {
        metrics.begin('logic');
        runTicks(gs, n);
        metrics.end('logic');
        metrics.countTicks(n); // reference: a median per call says nothing about load without the rate
        engineDirty = true;
        applyRoadBuildAbort(); // @0x4a5f1 - the engine can only report the road build, not abort it
        openMissionEndIfDue();
        serviceMessageIndicators(n); // @0xbe22 - note, arrow, message sound, plus the arrow clock
      }
      // **Drawing rate: one frame per logic frame, not per `rAF`.** The original draws ~12.5 times a
      // second (`gameTick` +8 per frame); we ran at ~60 and thereby showed intermediate states it
      // never produced — the same excess the sound pass already has a gate against (see
      // `lastSoundFrame`). Measured, that was the lever: the passes themselves suffice for 346 fps,
      // they merely ran five times too often.
      //
      // The CAMERA does not hang on this: the drawing effect reads `camera`/`zoom` directly, so
      // panning and zooming stay at refresh rate. Only catching up with the simulation is throttled.
      const frame = logicFrame(gs.gameTick);
      const newFrame = frame !== lastDrawnFrame;
      if (visible && ((n > 0 && newFrame) || wasHidden)) {
        // Did the simulation touch the MAP? Then the retained ground surface has to be rebuilt —
        // otherwise a road laid by the AI, levelled terrain or a recoloured border stays invisible
        // while the camera stands still. Reasoning for the signature instead of an engine counter:
        // `core/terrain-retention.ts::groundSignature`.
        //
        // It stands HERE and not in the `n > 0` block above: on a 512×256 map it costs about 1.1 ms
        // (131 072 tiles) and would run ~60 times per second, while it is CONSUMED only when drawing —
        // `mapVersion` has exactly one reader (`surfaceVersion`), and that is read again in this
        // branch. At 1× that is 12.5 instead of ~60 calls. The invisible tab is covered as well:
        // there we compute and do not draw, and the first visible beat comes through here via
        // `wasHidden` — the signature then sees all tiles changed meanwhile at once.
        //
        // **Condition of equivalence**: `mapVersion` must not gain a reader outside the drawing path.
        // If one appears, the signature has to move back into the tick block.
        const sig = groundSignature(gs.mapTiles);
        if (sig !== lastGroundSig) {
          lastGroundSig = sig;
          mapVersion += 1;
        }
        lastDrawnFrame = frame;
        frameVersion += 1; // triggert renderState + Blit-Effekt
      }
      wasHidden = !visible;
      metrics.end('pump');
    });
  });

  // Render source: paused = the static original snapshot (`save`); playing = a snapshot of the live
  // state serialised fresh per frame (whose `header.tick == gameTick`).
  const renderState = $derived.by((): SaveGameState => {
    if (!playing && !engineDirty) return save;
    void frameVersion; // recompute per frame / after actions
    return snapshot(engineState);
  });

  // --- stock overview (OUR OWN ADDITION, no original counterpart) -------------------------------

  /**
   * The shown set of numbers, and when it was built. Plain `let`s on purpose — the same idiom as
   * `lastGroundSig` and `lastSoundFrame` below: they are bookkeeping of the draw path, not state
   * anybody renders from.
   */
  let stockShown: StockView | null = null;
  let stockShownAt = Number.NEGATIVE_INFINITY;
  let stockShownSel: StockSelection | null = null;

  /**
   * The selection IS the switch: nothing chosen means nothing shown. There is no separate one, so
   * that a tick in the dialog shows its effect straight away.
   */
  const stockSelection = $derived.by((): StockSelection | null => {
    const goods = settings.value.stockGoods;
    const serfs = settings.value.stockSerfs;
    if (goods === 0 && serfs === 0) return null;
    return { goods, serfs, mode: settings.value.stockSerfMode };
  });

  /**
   * **The early return has to come BEFORE `void frameVersion`.** Dependencies are collected afresh
   * on every run, so while nothing is selected this derived depends on nothing and is not run per
   * frame at all — rather than running and returning null quickly. Swap the two lines and it is
   * called up to a hundred times a second for nothing.
   *
   * The throttle is display only and touches no logic. It is dropped as soon as the SELECTION
   * changes (`stockSelection` is a fresh object then), because a tick in the dialog that takes a
   * fifth of a second to show up reads as a fault.
   */
  const stockView = $derived.by((): StockView | null => {
    const sel = stockSelection;
    if (sel === null) return null;
    void frameVersion;
    const now = performance.now();
    if (sel === stockShownSel && !stockRefreshDue(now, stockShownAt, playing)) return stockShown;
    const p = engineState.players[buildPlayer];
    stockShown = p && p.active ? buildStockView(engineState, p, sel) : null;
    stockShownAt = now;
    stockShownSel = sel;
    return stockShown;
  });

  // --- building (original: build popup selection `gs+0x27a` × map cursor) ------------------------

  /** Plain text of the cursor kind (`player+0x100`) for the selection display. */
  const CURSOR_LABELS = [
    'nothing possible',
    'flag (not removable)',
    'flag (removable)',
    'building',
    'road',
    'free, flag next to it',
    'free, road next to it',
    'free',
  ];
  /** Plain text of the build possibility (`player+0x101`). */
  const POSSIBILITY_LABELS = ['—', 'flag only', 'mine', 'small building', 'large building', 'castle'];

  /**
   * Player being built for (slot 0..3) — the viewport player `vp[0x82]` in the original.
   *
   * The initial value 0 is not arbitrary: the viewport init of the main window writes `gs+0x64`
   * (== slot 0) into `vp[0x82]` (@0x5ad5). Across all four write sites of the field there is only one
   * that changes it at runtime — the player switch of spectator mode (@0x2bf71), see
   * {@link popupPlayerButtons}.
   */
  let buildPlayer = $state(0);

  /**
   * **The player switch in the frame head** (`FUN_000444e3`) — `undefined` outside game type 4, then
   * `paintPopup` does not draw it. It sits in EVERY popup, because the original has it in the
   * presenter and not in the individual screen.
   */
  const popupPlayerButtons = $derived.by<PopupPlayerButtonsView | undefined>(() => {
    if (!isSpectatorGame(engineState.header.gameType)) return undefined;
    void frameVersion; // a player can drop out during the game (`flags` bit 6)
    return {
      active: [0, 1, 2, 3].map((slot) => engineState.players[slot]?.active === true),
      current: buildPlayer,
    };
  });

  /**
   * Click into the upper frame strip of a popup = switch player. Returns `true` when the click was
   * consumed (also for a rejected, i.e. empty, slot — the original plays sound 4 there and returns,
   * so it does NOT pass the click on to the screen).
   *
   * `x`/`y` are canvas coordinates of the 144 × 160 frame area; the original hit test computes from
   * the content anchor, i.e. minus the frame width (8, 9).
   */
  function popupPlayerSwitchClick(x: number, y: number): boolean {
    if (popupPlayerButtons === undefined) return false;
    const slot = hitPopupPlayerButton(x - 8, y - 9);
    if (slot === null) return false;
    if (!runCommand({ kind: 'switchSpectatorPlayer', slot })) {
      playUiSound(UI_SOUND_REJECT); // sound 4 @0x2bf88 — empty slot
      return true;
    }
    buildPlayer = slot; // `vp[0x82] = player` @0x2bf71
    noteMessageShown(messageOverlay); // `vp[0x87] &= 0xfe` @0x2bf79 - the note is acknowledged
    playUiSound(UI_SOUND_PANEL_BUTTON); // sound 8 @0x2bf85
    note(`view: player ${slot + 1}`);
    return true;
  }

  /** Build-site classification of the selected tile (`FUN_00032075`) — null without a selection. */
  const buildSite = $derived.by(() => {
    if (selected === null) return null;
    void frameVersion;
    const player = engineState.players[buildPlayer];
    if (!player || !player.active) return null;
    return classifyBuildSite(engineState, player, selected.col, selected.row);
  });

  // --- original build menu (popup screens 3..7) --------------------------------------------------

  /** Currently open build screen (`vp[0x72]`) or null = closed. */
  let buildMenuScreen = $state<number | null>(null);
  /** Feedback of the last menu click (e.g. a rejected build site). */
  let buildMenuNote = $state<string | null>(null);

  /**
   * Sprite provider for the UI renderer (cache of its own, independent of the map renderer).
   *
   * ⚠️ The same case as {@link surface}: the value RETAINS a decode cache. Nothing frame-varying may
   * be read in the body of this `$derived.by` (camera, `frameVersion`, `renderState`) — otherwise the
   * provider is recreated every frame and the cache is gone. The bar and popup effects call it dozens
   * of times per run; the drop would be silent.
   */
  const uiProvider = $derived.by<SpriteProvider | null>(() => {
    if (archive === null || palette === null) return null;
    const ar = archive;
    const pal = palette;
    const cache = new Map<number, DecodedSprite | null>();
    return (entry: number): DecodedSprite | null => {
      const hit = cache.get(entry);
      if (hit !== undefined) return hit;
      let spr: DecodedSprite | null = null;
      try {
        const raw = ar.getRaw(entry);
        if (raw !== null) spr = decodeSprite(raw, pal, { physicalIndex: entry });
      } catch {
        // Empty or unreadable slot — skip.
      }
      cache.set(entry, spr);
      return spr;
    };
  });

  /** Click into the build menu: original click table → action → command or paging. */
  function handleBuildMenuClick(x: number, y: number, special: boolean): void {
    const screen = buildMenuScreen;
    if (screen === null || selected === null) return;
    // **The player switch in the frame head** (spectator mode) lies BEFORE the screen dispatch — the
    // same in the original: `popup_click_router` checks the y<0 strip (@0x2c016 ff.) before entering
    // the screen's jump table (@0x2c09c).
    if (popupPlayerSwitchClick(x, y)) return;
    const action = buildPopupAction(screen, x, y);
    if (action === null) return;
    playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
    if (action.kind === 'page') {
      buildMenuScreen = nextBuildScreen(screen);
      buildMenuNote = null;
      return;
    }
    if (action.kind === 'flag') {
      // `build_flag_action` @0x2fe96 in original order: FIRST the lock `player+3` bit 1 (then nothing
      // happens and the popup stays open), THEN popup closed (`0x28be3`), THEN the tail jump onto the
      // same handler as bar icon 0x01 — including its gate.
      if (buildSite?.flagBlocked === true) return;
      closePopups();
      note(runBarCommand('buildFlag', 'place flag'));
      return;
    }
    const player = engineState.players[buildPlayer];
    if (!player) return;
    const { col, row } = selected;
    const name = BUILDING_TYPE_NAMES[action.buildingType];
    // The FOUR exits of the three placement bodies (`engine/build-site.ts`). Two of them are silent
    // in the original and leave the popup standing — hence no `allowed` fork here but the exit
    // itself.
    const outcome = buildMenuClickOutcome(
      engineState,
      player,
      col,
      row,
      action.buildingType,
      special, // special click, `bt $0x3` on `vp[1]` @0x30155
    );
    const sound = buildMenuOutcomeSound(outcome);
    if (outcome === 'blocked') {
      // `ret` @0x300ba/@0x300f1 — military building locked: no sound, popup stays open.
      buildMenuNote = `${name} — military building locked here (enemy military building within reach).`;
      return;
    }
    if (outcome === 'keep') {
      // `ret` @0x3019c/@0x30278/@0x30354 — a building stands here; only the special click demolishes.
      buildMenuNote = `${name} — a building stands here; the special click demolishes it.`;
      return;
    }
    if (outcome === 'reject') {
      if (sound !== null) playUiSound(sound);
      buildMenuNote = `${name} not possible here.`;
      // The original closes the popup in the build branch BEFORE the check (`call 0x28be3` @0x3019d)
      // and leaves it standing in the building branch (the reject jump comes from @0x30147).
      if (buildSite?.cursorType !== CURSOR_BUILDING) closePopups();
      return;
    }
    const cmd: Command =
      outcome === 'demolish'
        ? {
            kind: 'demolishFromBuildMenu',
            col,
            row,
            player: buildPlayer,
            pendingType: action.buildingType,
          }
        : {
            kind: 'placeBuilding',
            col,
            row,
            player: buildPlayer,
            buildingType: action.buildingType,
          };
    if (!canApplyCommand(engineState, cmd)) {
      // The classification agreed, the command did not — in the original the abort INSIDE the shared
      // body (warehouse limit @0x303d7, no free flag slot). It no longer sounds there: sound 2 stands
      // before it already, @0x303af.
      if (sound !== null) playUiSound(sound);
      buildMenuNote = `${name} — not possible (warehouse limit or no free slot).`;
      closePopups();
      return;
    }
    if (sound !== null) playUiSound(sound);
    markContextDirty(col, row); // see `markContextDirty` - only valid after applying
    enqueueCommand(cmd);
    closePopups();
  }


  // --- soil-sample popup (screen 0x16) -----------------------------------------------------------

  /** Is the soil-sample popup open? A popup screen of its own in the original (`vp[0x72] == 0x16`). */
  let soilPopupOpen = $state(false);

  /**
   * The four raw sums around the selected tile — in the original the renderer recomputes them on
   * every draw (`FUN_0003f42c`), hence a `$derived` here instead of a stored value.
   */
  const soilAnalysis = $derived.by<number[] | null>(() => {
    if (!soilPopupOpen || selected === null) return null;
    const player = engineState.players[buildPlayer];
    if (!player) return null;
    return analyzeSoil(engineState, player, selected.col, selected.row);
  });

  /** Text colour = palette index 31 (`FUN_00037c78` sets foreground 0x1f). */
  const uiTextColor = $derived.by<readonly [number, number, number]>(() => {
    if (palette === null) return [255, 255, 255];
    return [palette.rgba[31 * 4], palette.rgba[31 * 4 + 1], palette.rgba[31 * 4 + 2]];
  });

  /** Palette index → RGB (the original drawing routines pass colours as an index). */
  function paletteColor(index: number): readonly [number, number, number] {
    if (palette === null) return [255, 255, 255];
    const i = index * 4;
    return [palette.rgba[i], palette.rgba[i + 1], palette.rgba[i + 2]];
  }

  /** Bar colour of the sliders = palette index `0x1e` (`FUN_0003cd8c` passes it to the rectangle). */
  const uiBarColor = $derived.by<readonly [number, number, number] | undefined>(() =>
    palette === null ? undefined : paletteColor(SLIDER_BAR_COLOR_INDEX),
  );

  /** Click into the soil-sample popup: the only zone is the exit symbol. */
  function handleSoilPopupClick(x: number, y: number): void {
    // Screen 0x16 has exactly one zone ("RAUS"); a hit sounds as everywhere (@0x2cd3b).
    if (soilPopupAction(x, y) === SOIL_POPUP_ACTION_EXIT) {
      playUiSound(UI_SOUND_PANEL_BUTTON);
      closePopups();
    }
  }


  // --- statistics/distribution menu (popup screens 8, 0x1b, 0x24) + its sub-screens --------------

  /**
   * The two selection menus of the right bar tabs (`menu-popup.ts`) AND the eight sub-screens of the
   * distribution menu (`settings-popup.ts`). All run in the same popup slot, because the original
   * works the same way: one handler writes `vp[0x70]` and the next frame draws the new screen into
   * the same window. The STATISTICS sub-screens (screen 8) are still missing — their click says so.
   */
  /**
   * Feedback of an interaction — target screen, rejected action, "not ported yet".
   *
   * It goes to the CONSOLE and not onto the playing field: the original has no room for it there (the
   * bar is 352 × 40 and full), and a strip below would shift the area.
   */
  function note(text: string): void {
    log.info('game', text);
  }

  let menuScreen = $state<number | null>(null);

  /**
   * Is one of the four disk screens up? They stop the clock and silence the music — the original does
   * both in the RENDERER of the entry (`pause_game_clock` @0x3ed98, `stop_music` @0x3ed9d), see
   * `playing` and the music effect above.
   */
  const diskMenuOpen = $derived(menuScreen !== null && DISK_SCREENS.includes(menuScreen));

  /** State the eight distribution screens show — the fields of the acting player. */
  const settingsView = $derived.by<SettingsPopupView | null>(() => {
    void frameVersion;
    return buildSettingsView(engineState, buildPlayer);
  });

  /**
   * Mode of the comparison curves (`vp[0xd4]` = `(aspect << 2) | time window`). The original keeps it
   * in the viewport, not in the save state — the same here.
   */
  let compareStatsMode = $state(0);

  /**
   * Selected ware of the production curve (`vp[0xd6] − 1`). Like the curve mode it lives in the
   * viewport, not in the save state.
   */
  let resourceStatsItem = $state(0);

  /** Click into a statistics screen (`stats-popup.ts`). */
  function applyStatsClick(screen: number, x: number, y: number): void {
    const action = clickStatsPopup(screen, x, y);
    if (action === null) return;
    playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b - the zone walker sounds before it dispatches
    switch (action.kind) {
      case 'menu':
        // Action 0x25 leads back to the statistics menu (`vp[0x70] = 8`).
        menuScreen = 8;
        break;
      case 'page':
        menuScreen = action.screen;
        break;
      case 'aspect':
        compareStatsMode = compareMode(action.aspect, compareLevel(compareStatsMode));
        break;
      case 'level':
        compareStatsMode = compareMode(compareAspect(compareStatsMode), action.level);
        break;
      case 'resource':
        resourceStatsItem = action.resource;
        break;
      case 'screen':
        // 0xf3 opens the colour legend 0x35, whose click (0x1f) leads back to the curves 0x0e.
        menuScreen = action.screen;
        break;
    }
  }

  /** Click into one of the eight distribution sub-screens (original handler semantics). */
  function applySettingsClick(screen: number, x: number, y: number): void {
    const action = clickSettingsPopup(screen, x, y);
    if (action === null) return;
    playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
    if (action.kind === 'menu') {
      // Action 0x63 returns to the menu WITHOUT the footer (`vp[0x70] = 0x1b`).
      menuScreen = 0x1b;
      return;
    }
    const player = engineState.players[buildPlayer];
    if (!player) return;
    switch (action.kind) {
      case 'slider':
        // Pixel → value stays here (layout knowledge), the command carries only the result.
        runCommand({
          kind: 'setDistributionValue',
          player: buildPlayer,
          list: action.slider.list,
          index: action.slider.index,
          value: sliderValueFromClick(action.slider, action.clickX),
        });
        break;
      case 'defaults':
        runCommand({ kind: 'resetDistributionDefaults', player: buildPlayer, screen });
        break;
      case 'occupation':
        runCommand({
          kind: 'setKnightOccupation',
          player: buildPlayer,
          index: action.index,
          bound: action.bound,
          delta: action.delta,
        });
        break;
      case 'prioritySelect':
        runCommand({
          kind: 'selectPriorityItem',
          player: buildPlayer,
          list: action.list,
          slot: action.slot,
        });
        break;
      case 'priorityMove':
        runCommand({
          kind: 'movePriorityItem',
          player: buildPlayer,
          list: action.list,
          move: action.move,
        });
        break;
      case 'recruit': {
        const made = runRecruit({ kind: 'recruitKnights', player: buildPlayer, limit: action.count })
          .recruited;
        // The four recruit buttons (@0x2dec2/@0x2dece/@0x2deda/@0x2dee6 → `call 0x2df33`) sound at the
        // RESULT: `or %ax,%ax ; je` @0x2df10 ⇒ 0 recruits sound 4 @0x2df24, otherwise sound 2
        // @0x2df15. The `vp[0x70] = 0x2d` @0x2df01 before it is not a screen change — the buttons lie
        // on 0x2d themselves; it is the redraw our `$derived` does anyway.
        playUiSound(made === 0 ? UI_SOUND_REJECT : UI_SOUND_ACCEPT);
        note(made === 0 ? 'no recruits (settlers or weapons missing)' : `${made} recruited`);
        break;
      }
      case 'attackSelection':
        // Both ticks sound ALWAYS (sound 2 @0x2e0d0 / @0x2e110) — there is no reject branch: the
        // handlers consist of `btr`/`bts $0x1` on `player+2`, the screen and the sound.
        runCommand({ kind: 'setAttackSelection', player: buildPlayer, strong: action.strong });
        playUiSound(UI_SOUND_ACCEPT);
        break;
      case 'knightValue':
        runCommand({ kind: 'setCastleGarrisonTarget', player: buildPlayer, delta: action.delta });
        break;
      case 'knightRotation':
        // `@0x2dda4`: two `flags` bits + the counter in block 496. The work is done afterwards by the
        // military handlers (ejection) and the serf request (rank lower bound), see
        // `engine/player-settings.ts` → `startKnightShift`.
        runCommand({ kind: 'startKnightShift', player: buildPlayer });
        // Sound 2 @0x2dde6 — unconditional, the handler has only this one exit.
        playUiSound(UI_SOUND_ACCEPT);
        note('knight shift running');
        break;
    }
    // All branches write player fields (sliders, occupation, recruits) — map unchanged.
    markEngineMutated();
  }

  /**
   * The interaction options (`.DS`@72/73) live in the SAVE STATE — that is the original and stays so.
   * In addition the browser remembers them as the starting value of the next game, so "fast build
   * click" need not be switched on for every game and the same setting applies whether it was set
   * here or in the main menu.
   *
   * Read from the engine AFTER the command instead of recomputing the action: the original does not
   * merely flip bits (`cycleMessageLevel` is a cascade), and a second computation would drift apart
   * eventually.
   */
  function rememberViewOptions(): void {
    settings.set('viewOptions', [viewOptions(engineState, 0), viewOptions(engineState, 1)]);
  }

  /**
   * Click into the footer screens (0x25 "EXTRA OPTION", 0x22 "ENDE"). Action semantics as in the
   * original handlers, see `options-popup.ts`.
   */
  function applyOptionsClick(screen: number, x: number, y: number): void {
    const action = clickOptionsPopup(screen, x, y);
    if (action === null) return;
    playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
    switch (action.kind) {
      case 'close':
        // `FUN_0002e613` — popup closed, bar slots restored (the branch for the running game).
        closePopups();
        note('EXTRA OPTION (EXIT)');
        break;
      case 'toggle':
        runCommand({ kind: 'setViewOption', side: action.side, mask: action.mask });
        rememberViewOptions();
        break;
      case 'messageLevel':
        runCommand({ kind: 'cycleMessageLevel', side: action.side });
        rememberViewOptions();
        break;
      case 'music':
        settings.set('music', !uiMusic);
        break;
      case 'volume':
        settings.set('volume', stepVolume(uiVolume, action.delta));
        break;
      case 'sfx':
        // In the original this box switches the SVGA mode (`toggle_screen_layout`, a completely
        // different screen layout this port will never draw). Here it switches the SOUND EFFECTS —
        // reasoning in `core/options-popup.ts`. The switch deliberately sits at the OUTPUT only:
        // queue, voice countdowns and RNG draws run on unchanged, otherwise the game state would
        // hang on an interaction setting.
        settings.set('sfx', !uiSfx);
        break;
      case 'screen':
        if (action.screen === DEVICE_SCREEN) {
          // Zone `0xf5` (`@0x2d5de`) fills the working copy from the effective values and opens 0x3c.
          deviceWorking = loadDeviceWorkingCopy(deviceLive);
          menuScreen = DEVICE_SCREEN;
        } else {
          note(`${action.label} — screen 0x${action.screen.toString(16)} is not ported yet.`);
        }
        break;
      case 'quitCancel':
        // `action_quit_cancel` @0x2ecb1: sound **4** — in the original an aborted dialog is a rejected
        // action —, then `resume_game_clock`, bar back, popup closed. The resuming is in the closing
        // here: `playing` hangs on the open screen.
        playUiSound(UI_SOUND_REJECT);
        closePopups();
        break;
      case 'quitConfirm':
        // `action_quit_confirm` @0x2ebdb: sound 0x4c, then `gs+0x1c9` bit 2 — the bit at which
        // `frame_loop` @0xbbdb leaves the loop. Here that is the return to the main menu.
        //
        // OFFEN @0x2ebea — if the 60-second counter `gs+0x186` stands at 0 (it runs down from the
        // game start), the original silently opens screen 0x23 instead; the second end screen is not
        // ported, so we leave the game immediately after the first minute as well.
        //
        // @0x2ec2b — the CAMPAIGN PROGRESS. In the original `gs+0x356`/`gs+0x358` are global and
        // survive leaving by themselves; our menu is a component of its own, rebuilt on return, so
        // the result travels with `onquit`. Computed on the RUNNING header, not on `save.header`:
        // the winner is set only during play.
        playUiSound(UI_SOUND_QUIT_CONFIRM);
        closePopups();
        onquit?.(advanceCampaignProgress(engineState.header));
        break;
    }
    frameVersion += 1;
  }

  /**
   * Click into the device screen (0x3c). All four number buttons run through ONE cascade that decides
   * only at the device value which field is meant — like `@0x2f328`.
   */
  function applyDeviceClick(x: number, y: number): void {
    const action = clickDevicePopup(x, y);
    if (action === null) return;
    playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
    switch (action.kind) {
      case 'cycleMode':
        deviceWorking = { ...deviceWorking, mode: cycleDeviceMode(deviceWorking.mode) };
        break;
      case 'step':
        deviceWorking = stepDeviceValue(deviceWorking, action.row, action.delta);
        break;
      case 'commit':
        // `@0x2f1ea`: working copy → effective values, then driver restart + `DEVICE.CFG` (neither
        // has a counterpart in the browser, see `device-options.ts`), then back as with "RAUS".
        deviceLive = commitDeviceOptions(deviceWorking);
        closePopups();
        note('INPUT DEVICE (CONFIRMED)');
        break;
      case 'close':
        // `FUN_0002e613` — the same return as in the options window; the working copy is discarded.
        closePopups();
        note('INPUT DEVICE (EXIT)');
        break;
    }
    frameVersion += 1;
  }

  /**
   * Click into the BUILDING SELECTION of the overview map (screens 0x2f..0x32,
   * `map-filter-popup.ts`).
   *
   * All three action kinds end with `vp[0x70] = 1` or the next page in the original — there is no
   * branch closing the window without a successor. Selection and "RAUS" therefore both lead back to
   * the overview map without touching `previewCenter` (the original writes `vp[0x74/0x76]` only when
   * OPENING the map, not on return).
   */
  function applyMapFilterClick(screen: number, x: number, y: number): void {
    const action = clickMapFilterPopup(screen, x, y);
    if (action === null) return;
    playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
    if (action.kind === 'page') {
      menuScreen = action.screen;
      return;
    }
    const state = { mode: previewMode, buildingFilter: previewFilter };
    const next =
      action.kind === 'select'
        ? applyMapFilterSelection(state, action.filter)
        : applyMapFilterClose(state);
    previewMode = next.mode;
    previewFilter = next.buildingFilter;
    menuScreen = null;
    previewOpen = true;
    note(action.kind === 'select'
        ? `map shows: ${
            action.filter === 0
              ? 'flags with an unfinished road'
              : (BUILDING_TYPE_NAMES[action.filter] ?? `type ${action.filter}`)
          }`
        : 'map shows: all buildings');
  }

  /** Click into a menu popup: the screen's original click table → action. */
  function handleMenuPopupClick(x: number, y: number): void {
    const screen = menuScreen;
    if (screen === null) return;
    // **The player switch in the frame head** (spectator mode) lies BEFORE the screen dispatch — the
    // same in the original: `popup_click_router` checks the y<0 strip (@0x2c016 ff.) before entering
    // the screen's jump table (@0x2c09c).
    if (popupPlayerSwitchClick(x, y)) return;
    if (SETTINGS_SCREENS.includes(screen)) {
      applySettingsClick(screen, x, y);
      return;
    }
    if (STATS_SCREENS.includes(screen)) {
      applyStatsClick(screen, x, y);
      return;
    }
    if (OPTIONS_SCREENS.includes(screen)) {
      applyOptionsClick(screen, x, y);
      return;
    }
    if (screen === DEVICE_SCREEN) {
      applyDeviceClick(x, y);
      return;
    }
    if (MAP_FILTER_SCREENS.includes(screen)) {
      applyMapFilterClick(screen, x, y);
      return;
    }
    if (DISK_SCREENS.includes(screen)) {
      applyDiskClick(screen, x, y);
      return;
    }
    const action = menuPopupAction(screen, x, y);
    if (action === null) return;
    playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
    if (action.kind === 'close') {
      // `FUN_0002827c` / `FUN_0002820b` — byte-identical to closing through the bar tab.
      closePopups();
      note(`${action.label} (EXIT)`);
      return;
    }
    if (action.kind === 'page') {
      // The paging handler rewrites bar slots 3/4 itself (`vp[0x63]`/`vp[0x64]`) so the pressed tab
      // travels with the menu; `pressedTabIcon` is exactly the new pressed value.
      menuScreen = action.screen;
      barIcons = [barIcons[0]!, barIcons[1]!, barIcons[2]!, action.barSlot3, action.barSlot4];
      pressedTabIcon = action.screen === 8 ? action.barSlot3 : action.barSlot4;
      return;
    }
    if (
      action.kind === 'screen' &&
      (SETTINGS_SCREENS.includes(action.screen) ||
        STATS_SCREENS.includes(action.screen) ||
        OPTIONS_SCREENS.includes(action.screen))
    ) {
      // The "ENDE" screen stops the clock — that is in `playing`, not here.
      menuScreen = action.screen;
      return;
    }
    if (action.kind === 'saveGame') {
      // @0x2eb39 — "SICHERN": the disk menu in save mode. The sound lies in `openDiskSave`, because
      // the original enqueues it only AFTER the (here unreachable) split-screen gate.
      void openDiskSave();
      return;
    }
    note(action.kind === 'screen'
        ? `${action.label} — screen 0x${action.screen.toString(16)} is not ported yet.`
        : `${action.label} — not ported yet.`);
  }


  // --- disk menu (screens 0x17..0x1a) ------------------------------------------------------------

  /**
   * The state of the disk menu. It uses `menuScreen` like the other menu popups — the original
   * dispatcher knows only ONE `vp[0x70]`, and the entrance "SICHERN" lies in the footer of exactly
   * that menu.
   */
  let disk = $state<DiskMenuState | null>(null);
  /** Is a file operation running? Keeps a second click on "AUSFUEHREN" away. */
  let diskBusy = false;
  /** The loaded save with its bytes, until the user clicks the result window away. */
  let diskPending: { save: SaveGameState; bytes: Uint8Array } | null = null;

  /** Colour of the slot list's selection bar (palette index 0x4c); without a palette no bar. */
  const diskBarColor = $derived.by<readonly [number, number, number] | null>(() => {
    const pal = palette;
    if (pal === null) return null;
    const o = DISK_SLOT_BAR_COLOR_INDEX * 4;
    return [pal.rgba[o] ?? 0, pal.rgba[o + 1] ?? 0, pal.rgba[o + 2] ?? 0];
  });

  /**
   * **"SICHERN"** (`@0x2eb39`) — the disk menu in SAVE mode. Screen 0x17 stands for one frame (the
   * original reads the index from the disk there, we reconcile a folder), then the list.
   *
   * The original's gate is unreachable here: it checks `gs+0x37e` bit 2, i.e. the second human
   * player, and there is none in this port. Sound **2** ("carried out") is therefore the only branch;
   * the rejection with sound 4 would be an invention.
   */
  async function openDiskSave(): Promise<void> {
    const st = store;
    if (st === null) {
      note('save: storage is not available.');
      return;
    }
    playUiSound(UI_SOUND_ACCEPT);
    menuScreen = DISK_SCREEN_ARCHIV;
    disk = enterDiskMenu(st.archiv, true);
    await st.reconcile();
    if (menuScreen !== DISK_SCREEN_ARCHIV) return; // dazwischen geschlossen
    disk = enterDiskMenu(st.archiv, true);
    menuScreen = DISK_SCREEN_LIST;
  }

  /** Click into the disk menu (popup pixels). The zone walker sounds in `applyDiskMenuAction`. */
  function applyDiskClick(screen: number, x: number, y: number): void {
    const s0 = disk;
    if (s0 === null) return;
    const action = clickDiskScreen(screen, x, y);
    if (action === null) return;
    const r = applyDiskMenuAction(s0, action);
    playUiSound(r.sound);
    disk = r.state;
    keepEntryFocus();
    switch (r.effect.kind) {
      case 'redraw':
        menuScreen = DISK_SCREEN_LIST_REDRAW;
        break;
      case 'perform':
        void runDisk(r.effect.save, r.effect.slot);
        break;
      case 'exitToGame':
        // @0x28592 — back into the game: bar slots and clock are already done by `closePopups`.
        disk = null;
        diskPending = null;
        closePopups();
        break;
      case 'exitToMenu':
        // Unreachable in save mode (the branch belongs to the main-menu entry), but ported.
        disk = null;
        closePopups();
        break;
      case 'enterLoadedGame':
        disk = null;
        closePopups();
        if (diskPending !== null) {
          onload?.(diskPending.save, diskPending.bytes);
          diskPending = null;
        }
        break;
      default:
        break;
    }
  }

  /**
   * The file operation. Synchronous and in the same routine in the original; asynchronous here,
   * because the storage is — codes and state transitions stay in `core/disk-menu.ts`.
   *
   * What is saved is the LIVE state (`snapshot`), not the loaded one: anything else would be saving
   * from before playing. `base` fills the byte ranges not modelled yet from the source file — without
   * it the save would be unusable for the original.
   */
  async function runDisk(saveMode: boolean, slot: number): Promise<void> {
    const st = store;
    const s0 = disk;
    if (st === null || s0 === null || diskBusy) return;
    diskBusy = true;
    menuScreen = DISK_SCREEN_RESULT; // @0x37173 / @0x46e7b - screen BEFORE the file
    try {
      let code: number;
      if (saveMode) {
        const bytes = encodeSaveGame(snapshot(engineState), { base: sourceBytes });
        code = await st.save(slot, s0.archiv, bytes);
        if (diskSaveResetsClocks(code)) {
          // @0x28506/@0x28514/@0x28522 — a successful save resets the three clocks. Through the
          // COMMAND LAYER, because it is the only state change of a save and stands in an action
          // handler in the original: an assignment from here would be outside the action log, and a
          // replayed report would fire the two save reminders at a different time.
          runCommand({ kind: 'noteGameSaved' });
          note(`saved to slot ${slot}.`);
        }
      } else {
        const r = await st.load(slot);
        code = r.code;
        if (code === DISK_RESULT.loaded && r.data !== null) {
          try {
            diskPending = { save: parseSaveGame(r.data), bytes: r.data };
          } catch (err) {
            code = DISK_RESULT.headerRejected;
            diskPending = null;
            note(`slot ${slot} is not a readable save game: ${String(err)}`);
          }
        }
      }
      disk = completeDiskOperation(s0, code);
    } finally {
      diskBusy = false;
    }
  }

  /**
   * Key press into the disk menu's name input — the same mapping as in the main menu, because it is
   * the SAME routine in the original (`input_buffer_putchar` @0xd073). Without a running input the
   * handler stays silent and without `preventDefault`: then the keys belong to the browser.
   */
  function runDiskKey(code: number): void {
    const s0 = disk;
    if (s0 === null || s0.nameInput === null) return;
    disk = applyDiskMenuKey(s0, code);
  }

  let entryField = $state<TextEntryField | null>(null);

  /**
   * As soon as the name entry runs, the focus belongs to the entry field — otherwise the user types
   * into nothing, and without a hint that it is not something else. It is asked for INSIDE the tap
   * that started the entry, because several mobile browsers open their keyboard only for a
   * `focus()` a user gesture caused.
   */
  function keepEntryFocus(): void {
    if (disk?.nameInput != null) entryField?.focusEntry();
  }

  // --- special-click windows (popup screens 0x2a / 0x28 / 0x27 / 0x29) ---------------------------

  /**
   * The six ported SPECIAL-CLICK WINDOWS: flag (0x2a), construction site (0x28), mine (0x27),
   * military building (0x29), finished building (0x34), castle/stock (0x26). `objectSubject` is our
   * `player+0x176` — the index the original's map branch writes immediately after choosing the screen
   * (@0x2a1cb). If it is unusable (object gone, building burning), the original renderers close
   * themselves; so do we.
   */
  let objectScreen = $state<number | null>(null);
  let objectSubject = $state(0);
  /**
   * The map position of the window's subject, carried along on opening.
   *
   * Why not `selected`: on opening that is the SAME tile (the special click sets both), but the two
   * can drift apart later. The flag window's actions go through the command layer by position — a
   * second source for the same thing would be exactly the trap.
   */
  let objectSubjectPos = $state<{ col: number; row: number }>({ col: 0, row: 0 });

  /** Screens {@link drawObjectPopup} can draw. */
  const OBJECT_SCREENS: ReadonlySet<number> = new Set([0x2a, 0x28, 0x27, 0x29, 0x34, 0x26, 0x2b, 0x2c, 0x14, DEMOLISH_SCREEN]);

  /**
   * Does the flag window show the "attach road" symbol? Exactly the original's predicate
   * (`can_attach_flag_to_road` @0x4c9b3) at the CURSOR TILE — the same condition decides drawing
   * *and* click zone.
   */
  const attachRoadPossible = $derived.by(() => {
    if (selected === null) return false;
    void frameVersion; // roads change during the game
    return canAttachFlagToRoad(engineState, selected.col, selected.row);
  });

  /** Why the original only plays an error tone on an attack click (`FUN_0003688a(4)`). */
  const ATTACK_PREP_NOTES: Readonly<Record<string, string>> = {
    notAttackable: 'attack: only hut, tower, fortress and castle are targets.',
    inactive: 'attack: the building is not in service yet.',
    threatLevel: 'attack: the threat level of the target is too low.',
    outOfRange: 'attack: no own land within reach of the target.',
  };


  /**
   * Click into a special-click window. Four of the six are DISPLAY ONLY (shared zone table
   * `@0x2c7e4`: just "RAUS"); the flag window additionally has geologist and road demolition.
   */
  function handleObjectPopupClick(x: number, y: number, special: boolean): void {
    const screen = objectScreen;
    if (screen === null) return;
    // **The player switch in the frame head** (spectator mode) lies BEFORE the screen dispatch — the
    // same in the original: `popup_click_router` checks the y<0 strip (@0x2c016 ff.) before entering
    // the screen's jump table (@0x2c09c).
    if (popupPlayerSwitchClick(x, y)) return;
    if (screen === 0x14) {
      const act = attackPopupAction(x, y);
      if (act === null) return;
      playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b - a zone hit sounds before the action
      const attacker = engineState.players[buildPlayer];
      if (attacker === null || attacker === undefined) return;
      if (act.kind === 'close') {
        closePopups();
        return;
      }
      if (act.kind === 'launch') {
        // `attack_launch` @0x3169c: sends the chosen knights off and then jumps into the same closing
        // path as the "RAUS" button. Without chosen knights it returns before that — the window stays
        // open and there is only an error tone.
        const res = runAttackLaunch({ kind: 'launchAttack', player: buildPlayer });
        // The OUTCOME sound (2 = carried out / 4 = rejected / null = silent, see `ui-sound.ts`). It
        // adds to the zone sound above, as in the original: two different call sites.
        if (res.sound !== null) playUiSound(res.sound);
        if (!res.closePopup) {
          note('no knight chosen — the original rejects the action with a sound.');
          return;
        }
        closePopups();
        markEngineMutated(); // knights leave the garrison - the map is unchanged
        return;
      }
      // The counting buttons are pure player-field changes; the original only redraws the number
      // afterwards (screen 0x15) — our window rebuilds completely anyway.
      runCommand(
        act.kind === 'decrement'
          ? { kind: 'adjustAttackCount', player: buildPlayer, mode: 'dec' }
          : act.kind === 'increment'
            ? { kind: 'adjustAttackCount', player: buildPlayer, mode: 'inc' }
            : { kind: 'adjustAttackCount', player: buildPlayer, mode: 'preset', bands: act.bands },
      );
      markEngineMutated();
      return;
    }
    if (screen === 0x26 || screen === 0x2b) {
      // The castle window pages in a circle: 0x26 (wares) → 0x2b (settlers) → 0x2c → back.
      const act = screen === 0x26 ? castlePopupAction(x, y) : serfCensusPopupAction(x, y);
      if (act === null) return;
      playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
      if (act.kind === 'close') {
        closePopups();
      } else if (OBJECT_SCREENS.has(act.screen)) {
        objectScreen = act.screen;
      } else {
        note(`screen 0x${act.screen.toString(16)} is not ported yet.`);
      }
      frameVersion += 1;
      return;
    }
    if (screen === 0x2c) {
      const act = inventoryModePopupAction(x, y);
      if (act === null) return;
      playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
      if (act.kind === 'close') {
        closePopups();
        frameVersion += 1;
        return;
      }
      if (act.kind === 'screen') {
        objectScreen = act.screen;
        frameVersion += 1;
        return;
      }
      // The four lower ticks require the special click (`bt $0x3, vp[1]` @0x2e16e). Without it the
      // handler returns without doing anything.
      if (act.special && !special) return;
      const bld = engineState.buildings[objectSubject];
      if (!bld) return;
      // Through the command layer so the switching appears in the action log. The command carries the
      // map position of the stock; the mode values are the original's (0/1/**3**).
      runCommand({
        kind: 'setInventoryMode',
        col: bld.col,
        row: bld.row,
        player: buildPlayer,
        group: act.group,
        mode: act.value === 0 ? 0 : act.value === 1 ? 1 : 3,
      });
      // All six handlers set `vp[0x70] = 0x2c` — the window therefore stays open.
      markEngineMutated(); // inventory mode plus two flag bits - the map is unchanged
      return;
    }
    if (screen === DEMOLISH_SCREEN) {
      // Two zones (`@0x2c6f6`): "RAUS" only closes, the confirm button calls `FUN_00048c8a` and
      // closes afterwards through the same path. The routine reclassifies by itself — hence the
      // cursor tile suffices for it, there is no subject.
      const act = clickDemolishPopup(x, y);
      if (act === null) return;
      // @0x2cd3b — the zone walker sounds first; the demolish sounds of `FUN_00048c8a` come on top
      // afterwards (two different call sites in the original, see `ui-sound.ts`).
      playUiSound(UI_SOUND_PANEL_BUTTON);
      if (act === DEMOLISH_ACTION_CONFIRM && selected !== null) {
        const cmd: Command = {
          kind: 'demolishAtCursor',
          col: selected.col,
          row: selected.row,
          player: buildPlayer,
        };
        // The sound comes BEFORE the effect, as in the original: `FUN_00048c8a` enqueues one in each
        // of its three branches (8 / 0x4c / 4) and only then calls the demolition. The branch comes
        // from the same classification `applyCommand` uses — asked beforehand, because afterwards the
        // building burns and the tile has a different kind.
        const player0x37 = engineState.players[buildPlayer];
        if (player0x37) {
          playUiSound(
            demolishOutcomeSound(
              demolishOutcomeAt(engineState, player0x37, selected.col, selected.row),
            ),
          );
        }
        const razed = runCommand(cmd);
        note(razed
          ? 'demolished.'
          : 'demolition refused — a military building cannot be razed while an enemy knight is within reach.');
        // Demolition changes map objects and road bits ⇒ rebuild the ground/road surface.
        if (razed) markEngineMutated(true);
      }
      closePopups();
      return;
    }
    if (screen !== 0x2a) {
      // Display windows (construction site 0x28 / mine 0x27 / military building 0x29): only "RAUS" is
      // a zone — a hit sounds all the same, like any other (@0x2cd3b).
      if (hitTestPanel(DISPLAY_ONLY_POPUP_HITBOXES, x, y) !== null) {
        playUiSound(UI_SOUND_PANEL_BUTTON);
        closePopups();
      }
      return;
    }
    const action = flagPopupAction(x, y, { attachRoadShown: attachRoadPossible });
    if (action === null) return;
    playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2cd3b
    if (action.kind === 'close') {
      closePopups();
      return;
    }
    if (action.kind === 'callGeologist') {
      // `FUN_0002e4e4` @0x2e4e4, read back in the ASM — the two exits are NOT symmetric:
      //
      //   2e589  call 0x12370                  ; serf type 20 to this flag
      //   2e58e  js  0x2e5a3                   ; negative = no geologist reachable
      //   2e590  mov $0x2 ; call 0x3688a       ; carried out
      //   2e59e  jmp 0x2827c                   ; → popup closed, bar restored
      //   2e5a3  mov $0x4 ; call 0x3688a       ; rejected
      //   2e5b1  ret                           ; ← NO jump: the window stays OPEN
      //
      // The failure branch ends on `ret`, not on the closing path: whoever has no geologist free
      // keeps the window.
      const ok = runCommand({
        kind: 'callGeologist',
        col: objectSubjectPos.col,
        row: objectSubjectPos.row,
      });
      playUiSound(ok ? UI_SOUND_ACCEPT : UI_SOUND_REJECT);
      markEngineMutated(); // new serf in the stock — map unchanged
      note(ok
        ? 'geologist requested — he leaves the nearest stock that has a hammer.'
        : 'no geologist reachable (no stock with a geologist or generic + hammer).');
      if (ok) closePopups();
      else note('no geologist reachable.');
      return;
    }
    // `action_attach_flag_to_road` (@0x2db12): call `FUN_0004ccdf`, then sound 2 (success, ZF set
    // @0x4d40f) or 4 (failure) — and in BOTH cases `close_popup_restore_bar`, which Ghidra inlines
    // here via a tail jump. So exactly as with the geologist: note into the bar, window closed.
    const attached = runCommand({
      kind: 'attachFlagToRoad',
      col: objectSubjectPos.col,
      row: objectSubjectPos.row,
    });
    // @0x2db30 (`mov $0x4`, failure) respectively @0x2db43 (`mov $0x2`, success) — here BOTH branches
    // go to `jmp 0x2827c`, unlike the geologist above.
    playUiSound(attached ? UI_SOUND_ACCEPT : UI_SOUND_REJECT);
    // Attaching relinks a road tile ⇒ map change.
    markEngineMutated(attached);
    note(attached
      ? 'road attached to the flag.'
      : 'no road passes close enough to the flag here.');
    closePopups();
  }

  // --- overview map (popup screens 1/2) ----------------------------------------------------------

  /** Centre tile of the view = our `vp+0x46/0x48` (reasoning at {@link cameraCenterTile}). */
  function viewCenterTile(): { col: number; row: number } {
    return cameraCenterTile(camera, geo, heightAt, heightUnit);
  }

  /** The counterpart: `vp[0x46]/[0x48] = (col, row)` — the tile becomes the centre of the view. */
  function centerCameraOnTile(col: number, row: number): void {
    const cam = cameraCenteredOnTile(col, row, viewportW / zoom, viewportH / zoom);
    camX = cam.originX;
    camY = cam.originY;
  }

  /**
   * The original's overview map (`FUN_000422eb`, ported in `map-preview.ts`) as a popup IN the game
   * screen. State as in the original:
   * - `previewMode` == `vp+0xd1` (init **8** = buildings on), `previewFilter` == `vp+0x2e` (−1 = all),
   * - `previewCenter` == `vp+0x74/0x76` (window centre, set on OPENING — not tracked continuously,
   *   exactly as in the original, where the icon handler writes it once).
   *
   * The map's cursor marker shows `vp+0x46/0x48` — the CENTRE TILE of the view (the same field the
   * scroll driver moves). Because our window, unlike the original's, is freely sized and zoomable, we
   * draw a frame the size of the actually visible section (`viewportSpan`) instead of the fixed
   * 15×15 sprite.
   */
  let previewOpen = $state(false);
  let previewMode = $state(8);
  let previewFilter = $state(-1);
  let previewCenter = $state.raw<{ col: number; row: number }>({ col: 0, row: 0 });

  /**
   * Landscape base image of the overview map. Depends ONLY on the terrain (height + terrain types),
   * which never changes during play — hence derived from the loaded save and not rebuilt per frame
   * (the build runs over all tiles).
   */
  const previewMinimap = $derived.by(() =>
    buildMinimap(save.mapTiles, save.header.mapCols, save.header.mapRows),
  );

  /** Preview data: terrain static from the save, everything changeable LIVE from the engine. */
  const previewData = $derived.by<MapPreviewData | null>(() => {
    if (palette === null) return null;
    return {
      tiles: engineState.mapTiles,
      cols: geo.cols,
      rows: geo.rows,
      minimap: previewMinimap,
      palette: palette.rgba,
      flags: engineState.flags,
      buildings: engineState.buildings,
    };
  });

  /**
   * Click into the overview map — `map_preview_click_goto` (@0x2cd66) for the map area, the four
   * toggles via {@link applyMapPreviewAction}:
   *
   * ```
   * col/row = click → tile (shear removed, toroidal)
   * vp[0x46] = col ; vp[0x48] = row          // WINDOW origin ⇒ the main view jumps there
   * vp[1] &= ~0x40 ; vp[0] |= 0x10           // tab flag off, redraw
   * vp[0x62..0x64] = {10, 0xc, 0xe}          // the three right bar slots fall back
   * vp[1] |= 2 ; vp[0x72] = 0                // map accepts clicks again, popup closed
   * player[0xfc/0xfe] = vp[0x46/0x48]        // (except in all-players mode) drag the cursor along
   * vp[1] |= 4                               // trigger the icon derivation
   * ```
   *
   * `vp+0x46/0x48` is the CENTRE TILE of the view (see {@link viewCenterTile}) — the clicked tile
   * therefore ends up in the middle, not in the corner.
   */
  function handlePreviewClick(x: number, y: number, special: boolean): void {
    const data = previewData;
    if (data === null) return;
    const action = hitTestPanel(MAP_PREVIEW_HITBOXES, x, y);
    if (action === null) return;
    // @0x2cd3b — the map area is a zone of the table like any button in the original, so jumping to
    // a tile sounds along.
    playUiSound(UI_SOUND_PANEL_BUTTON);
    if (action === MAP_PREVIEW_ACTION.GOTO) {
      // The magnifier takes precedence, exactly as when drawing (see `drawMapPreview`).
      const step = (previewMode & PREVIEW_ZOOM) !== 0 ? 1 : previewStep;
      const origin = mapPreviewOrigin(
        previewCenter.col,
        previewCenter.row,
        data.cols,
        data.rows,
        step,
      );
      const t = mapPreviewClickToTile(
        origin,
        x - PREVIEW_X,
        y - PREVIEW_Y,
        data.cols,
        data.rows,
        (previewMode & PREVIEW_ZOOM) !== 0,
        step,
      );
      centerCameraOnTile(t.col, t.row);
      selected = { col: t.col, row: t.row };
      closePopups();
      refreshContextIcons(t.col, t.row);
      return;
    }
    // **Special click on the building icon** — `@0x2fdc4` checks `vp[1]` bit 3 BEFORE anything else
    // and then opens the building selection (screen 0x2f) instead of toggling the overlay. Only this
    // one of the five bar zones has a special-click branch.
    if (action === MAP_PREVIEW_ACTION.BUILDINGS && special) {
      openScreen(0x2f);
      note('map: building filter');
      return;
    }
    const next = applyMapPreviewAction({ mode: previewMode, buildingFilter: previewFilter }, action);
    previewMode = next.mode;
    previewFilter = next.buildingFilter;
  }

  /**
   * **Overview special click** — the interaction half of `goto_own_castle` @0x56d8. The routine
   * itself lives in the core as {@link gotoOwnCastle}, because it writes TWO things: the player's
   * cursor (`player[0xfc]/[0xfe]` == blocks 380/382, @0x5783) and the centre tile of the view
   * (`vp[0x46]/[0x48]`, @0x576e). Only the second half belongs to us — the core writes the first
   * itself so it cannot be forgotten here.
   *
   * Returns `false` when the player has no castle (then the original does nothing — no sound).
   */
  function jumpToCastle(): boolean {
    const player = engineState.players[buildPlayer];
    if (!player || !player.active) return false;
    const tile = gotoOwnCastle(player, engineState.buildings, geo);
    if (tile === null) return false;
    centerCameraOnTile(tile.col, tile.row);
    selected = { col: tile.col, row: tile.row };
    refreshContextIcons(tile.col, tile.row);
    return true;
  }

  /**
   * **Fast map click** — `FUN_00029d05` (@0x29d05), triggered by the double-click bit `vp[1]` bit 5:
   *
   * ```
   * vp[1] &= ~0x20;                                   // consume the double-click bit
   * if (vp[0x62] != 0x0a) return;                     // only when the overview is NOT open
   * if (vp[1] & 0x40) return FUN_00028061();          // a tab is pressed ⇒ different path
   * vp[1] |= 0x40 ; vp[0x60..0x64] = {0,7,0x13,0xb,0xd} ; vp[1] &= ~2 ; vp[0x70] = 1
   * vp[0x74] = vp[0x46] ; vp[0x76] = vp[0x48]         // window CENTRE := window ORIGIN
   * ```
   * It therefore opens the same overview map as the bar icon, only without going through the bar.
   */
  function fastMapClick(): void {
    if (!mapAcceptsClicks) return;
    if (barIcons[2] !== 0x0a) return; // minimap already open, or another state
    openScreen(1);
    barIcons = [0, 7, 0x13, 0xb, 0xd];
    pressedTabIcon = 0x0a;
    note('map (fast map click)');
  }


  // --- original control bar (click + context icons) ----------------------------------------------

  /**
   * The bar is drawn in exactly its original section ({@link CONTROL_PANEL_BOUNDS} = 352×40 at
   * x 144 / y 440) — no empty space around it, so it sits flush ON the map. In the original it is an
   * overlay just the same: the map fills the whole screen and stays visible left and right of it.
   */
  const BAR_WIDTH = CONTROL_PANEL_BOUNDS.width;
  const BAR_HEIGHT = CONTROL_PANEL_BOUNDS.height;
  const BAR_OFFSET_X = -CONTROL_PANEL_BOUNDS.x;
  const BAR_OFFSET_Y = -CONTROL_PANEL_BOUNDS.y;

  /**
   * The five button icons (`panel[0x60..0x64]`) — STATE, just as in the original. `$state.raw`,
   * because the row is always replaced whole and never mutated element-wise.
   */
  let barIcons = $state.raw<readonly number[]>([...CONTROL_PANEL_DEFAULT_ICONS]);
  /**
   * Sprite pair of the map markers (`panel[0xa4]` records 0 and 2), which `context_bar_set_icons` sets
   * together with the icons — `null` in the two early exits, then the init sprites stay (arrows +
   * dots). Inserted into the 7 records by `buildCursorMarkers` (`core/cursor-marker-layer.ts`).
   */
  let cursorMarkers = $state.raw<CursorMarkerPair | null>(null);
  /**
   * Road-building state of the viewport (`vp[1]` bit 7, `vp+0xce`, `vp+0xd0`, `vp+0xaa`ff) — the
   * provisional road itself lies in the real map bits, as in the original, not here.
   *
   * The engine changes the object in place; for display it is mirrored via {@link syncRoadView}
   * instead of hanging reactivity on a counter.
   */
  /**
   * The road-building session lives in the GAME STATE (`GameState.roadBuild[slot]`) rather than here
   * — only that way is a single road-building click a command and lands in the action log of the
   * debug report. A function rather than a held object, because `engineState` is replaced when
   * another save is loaded.
   */
  function roadBuild(): RoadBuildingState {
    return engineState.roadBuild[buildPlayer]!;
  }

  let roadActive = $state(false);
  let roadRingSprites = $state.raw<readonly number[]>([...roadBuild().markers]);

  function syncRoadView(): void {
    roadActive = roadBuild().active;
    roadRingSprites = [...roadBuild().markers];
  }

  /**
   * **The display half of the abort branch of `clear_road_paths`** (@0x4a5f1).
   *
   * If the engine clears a road that does not have a flag at both ends, that road is the one being
   * DRAWN — and the original then aborts road building in every viewport that has it active. The
   * engine does that itself (the session lives in the state, see {@link roadBuild}); otherwise the
   * abort would be missing when replaying a command log, because `clearRoadPaths` is also called from
   * the tick. `GameState.roadBuildAborted` is thus a pure display signal.
   */
  function applyRoadBuildAbort(): void {
    if (!engineState.roadBuildAborted) return;
    engineState.roadBuildAborted = false;
    // The engine ended the building itself (`clearRoadPaths` @0x4a5f1) — otherwise the abort would be
    // missing when replaying a command log. The signal is only set when a session really ran; what
    // remains here is the DISPLAY.
    barIcons = [barIcons[0], barIcons[1], ...ROAD_BAR_ICONS_LEAVE];
    syncRoadView();
    note('road building cancelled — the route is gone.');
    markEngineMutated(true); // the abort clears the provisional road bits
  }

  /**
   * Recompute the context icons of the two left slots (`FUN_000331a7`) — the three right tabs
   * (overview/statistics/distribution) stay.
   *
   * **When this happens in the original matters for fidelity.** The frame handler has
   * ```
   * if (vp[1] & 4) { vp[1] &= ~4; classify_build_site(); FUN_000331a7(); … }
   * ```
   * — a DIRTY FLAG (`vp[1]` bit 2) processed exactly once and then cleared. It is set where the
   * cursor changes or an action fails. Explicitly NOT per frame: that is why the pressed build icon
   * (`0x17`/`0x11`/`0x12`) written by the bar click into slot 0 survives in the original.
   *
   * Hence a function called at those same places (map click, failed action, applied command) — and
   * NOT an `$effect` on the classification. An effect would have fired every frame through
   * `frameVersion` and immediately overwritten the pressed icon again.
   */
  function refreshContextIcons(col: number, row: number): void {
    const player = engineState.players[buildPlayer];
    if (!player || !player.active) return;
    const site = classifyBuildSite(engineState, player, col, row);
    const next = contextBarState({
      cursorType: site.cursorType,
      possibility: site.possibility,
      // `player+2` (block 130 `flags`); bit 0 switches slot 1 between passive and soil samples.
      playerFlags: player.flags,
      // `vp[1]` bit 7 — during road building the bar shows the toggle instead of the build icons.
      roadBuilding: roadBuild().active,
      // `gs+0x37e` bit 5 — in spectator mode the bar shows two passive symbols and nothing else
      // (@0x331b2, the FIRST test of the routine — it even beats the road-building branch). Every
      // build action is thereby unreachable without needing a reject branch for it.
      specialMode: isSpectatorGame(engineState.header.gameType),
    });
    barIcons = [next.icons[0], next.icons[1], barIcons[2], barIcons[3], barIcons[4]];
    // The same routine sets the marker sprites — one call in the original, a return value here.
    cursorMarkers = next.markers;
    // During road building the other writer of the marker list (`@0x32d49`) writes all six rings.
    if (roadBuild().active) {
      updateRoadMarkers(engineState, player);
      syncRoadView();
    }
  }

  /**
   * Restore the build/map cursor from the save state (`player+0xfc`/`0xfe` == `.DS` blocks 380/382).
   *
   * The original knows NO state "no tile selected": the cursor is a saved field and valid after
   * loading (62 saves, 124 active players, all values inside the map). Kept as `null` instead, a bar
   * tab opens a cursor-related popup without a reference point — and because `mapAcceptsClicks`
   * already hangs on the open screen, that locks the map.
   */
  function restoreCursorFromSave(): void {
    const p = engineState.players[buildPlayer];
    if (!p || !p.active || p.cursorCol >= geo.cols || p.cursorRow >= geo.rows) {
      selected = null;
      return;
    }
    selected = { col: p.cursorCol, row: p.cursorRow };
    refreshContextIcons(p.cursorCol, p.cursorRow);
  }

  /** Popup screens the viewer can already draw. */
  function openScreen(screen: number): boolean {
    if (BUILD_SCREENS.has(screen)) {
      buildMenuScreen = screen;
      soilPopupOpen = false;
      previewOpen = false;
      menuScreen = null;
      objectScreen = null;
      return true;
    }
    if (screen === 0x16) {
      soilPopupOpen = true;
      buildMenuScreen = null;
      previewOpen = false;
      menuScreen = null;
      objectScreen = null;
      return true;
    }
    if (MENU_SCREENS.has(screen) || MAP_FILTER_SCREENS.includes(screen)) {
      menuScreen = screen;
      buildMenuScreen = null;
      soilPopupOpen = false;
      previewOpen = false;
      objectScreen = null;
      return true;
    }
    if (OBJECT_SCREENS.has(screen)) {
      // The subject (`player+0x176`) is set by the caller BEFORE opening — as in the original, where
      // the map branch writes `vp[0x70]` first and `player+0x176` afterwards (@0x2a1cb).
      objectScreen = screen;
      buildMenuScreen = null;
      soilPopupOpen = false;
      previewOpen = false;
      menuScreen = null;
      return true;
    }
    // Screens 1/2 = overview map. On opening, the original sets `vp[0x74]/[0x76] = vp[0x46]/[0x48]`
    // (`FUN_00029d05` @0x29d47, likewise the icon handler) — the overview is thus built around the
    // CENTRE TILE of the view, and its own origin arises from that as `− (0x54, 0x38)`
    // (`mapPreviewOrigin`).
    if (screen === 1 || screen === 2) {
      previewCenter = viewCenterTile();
      previewOpen = true;
      buildMenuScreen = null;
      soilPopupOpen = false;
      menuScreen = null;
      objectScreen = null;
      return true;
    }
    return false;
  }

  /**
   * Icon value that opened the current popup (the PRESSED tab). In the original a second click on an
   * active tab closes the popup (`vp[1]` bit 6 → `FUN_0002827c`) — the decision hangs on the *icon of
   * the clicked slot*, not on the screen: after paging (screen 5→6→7) the tab is still the same.
   * Hence the icon value is remembered here, not the screen.
   */
  let pressedTabIcon = $state<number | null>(null);

  /**
   * **Build helper on?** — `vp[0]` **bit 6** in the original: `ui_draw_viewport` (@0x3756e) calls the
   * overlay routine `FUN_000375ff` exactly when the bit is set. It is toggled by `btc $0x6` @0x27ee5
   * — from the special click on slot 0.
   *
   * **All accesses**, from a raw byte scan of the canonical form over `[0x2800,0x60000)` (a linear
   * `objdump` reading misses @0x4a49b, because it desynchronises at a data table beforehand). TEN
   * places: one reader, one toggle, EIGHT clearers:
   *
   * | Place | Action | here |
   * |---|---|---|
   * | `bt` @0x3758b | `ui_draw_viewport` reads | {@link buildHelper} in the drawing pass |
   * | `btc` @0x27ee5 | special click on slot 0 | toggle below |
   * | `btr` @0x27889 | message icon, only "show" | message strip |
   * | `btr` @0x27f08 | overview icon, **before** the click fork | there + `runPanelAction` |
   * | `btr` @0x280da/@0x28165/@0x28385 | the three popup-opening icon branches | `runPanelAction` |
   * | `btr` @0x28615 | **start road building**, before the flag gate | `runBarCommand` |
   * | `btr` @0x28d51 | found castle, only in the SUCCESS branch | `runBarCommand` |
   * | `btr` @0x4a49b | demolish road, before the gate | `runBarCommand` |
   *
   * The position relative to the gate is NOT uniform and therefore read per site: road building, road
   * demolition and overview clear before their check, castle founding and message only afterwards.
   * No clearer lies in the road-building abort (@0x286dc) — there the bit is clear anyway.
   */
  let buildHelper = $state(false);

  /**
   * The options "fast build click" and "fast map click" — `vp[0x86]` bit 2 respectively bit 1 in the
   * original. They come from the real options byte of the save state (`header.viewOptions[0]`,
   * `.DS`@72), adjustable in the options screen (0x25).
   *
   * `vp[0x86]` itself is not modelled: it is a pure cache of the options byte (reasoning in
   * `engine/view-options.ts`). We are the LEFT window, i.e. half 0.
   */
  const fastBuildClick = $derived.by(() => {
    void frameVersion;
    return hasViewOption(engineState, 0, VIEW_OPTION_FAST_BUILD_CLICK);
  });
  const fastMapClickEnabled = $derived.by(() => {
    void frameVersion;
    return hasViewOption(engineState, 0, VIEW_OPTION_FAST_MAP_CLICK);
  });

  /**
   * Music, volume and SVGA mode are NOT in the save state in the original but global
   * (`gs+0x1cb` bit 1 / `gs+0x3dc` / `gs+0x1c8` bit 0) and come from the configuration file. Our
   * configuration file is `settings/settings.svelte.ts` — the same one the main menu reads. Only that
   * way does an option set there apply in the game and survive a reload.
   *
   * `uiSfx` is NOT an original state but the repurposing of the SVGA box (see
   * `core/options-popup.ts`); `SCREEN_LAYOUT_DEFAULT` stays beside it and documents the original
   * default of the box.
   */
  const uiVolume = $derived(settings.value.volume);
  const uiMusic = $derived(settings.value.music);
  const uiSfx = $derived(settings.value.sfx);

  /**
   * The input device configuration (screen 0x3c) — global in the original as well and from
   * `DEVICE.CFG`, with TWO sets: the effective values `gs+0x3c8..0x3cd` and the working copy
   * `gs+0x2dc..0x2e1` the screen operates on. Kept apart the same way here, otherwise "RAUS" would
   * keep changes the original discards.
   */
  let deviceLive = $state<DeviceOptions>(DEVICE_OPTIONS_DEFAULT);
  let deviceWorking = $state<DeviceOptions>(DEVICE_OPTIONS_DEFAULT);

  const optionsView = $derived.by<OptionsPopupView>(() => {
    void frameVersion;
    return buildOptionsView(engineState, {
      volume: uiVolume,
      music: uiMusic,
      sfx: uiSfx,
    });
  });

  /**
   * Names of the screens the map special click opens (`mapSpecialClickScreen`). Six of them are drawn
   * (see {@link OBJECT_SCREENS}); for the remaining one (0x14) the list makes the message readable
   * instead of showing a bare number.
   */
  const SPECIAL_SCREEN_NAMES: Readonly<Record<number, string>> = {
    0x14: 'attack',
    0x26: 'castle/warehouse',
    0x27: 'mine',
    0x28: 'construction site',
    0x29: 'military building',
    0x2a: 'flag',
    0x2b: 'castle/warehouse — settlers',
    0x2c: 'castle/warehouse — stock in/out',
    0x34: 'building',
  };

  /**
   * Raw type byte of the message currently shown (`vp[0x96]`), `null` = window closed; plus the
   * remembered starting point (`vp[0x1c2]/[0x1c4]`) the arrow leads back to. Declared before
   * `mapAcceptsClicks`, because the window is modal like any popup.
   */
  let messageTypeByte = $state<number | null>(null);
  let messageReturnTo = $state.raw<{ col: number; row: number } | null>(null);

  /**
   * **Message overlay of the bar** (`vp+0x87` plus the arrow clock `vp+0x1c0`, see
   * `message-overlay.ts`). Deliberately a plain object and NOT `$state`: `engineState` is not one
   * either, and the state is only read/written in the frame service. Reactive are the two
   * VISIBILITIES below — they change rarely (the paper blinks with 32 ticks), so the bar is redrawn
   * only then, not per frame. That is exactly the role the bar dirty bit `gs+0x383` bit 1 plays in
   * the original.
   */
  const messageOverlay = createMessageOverlayState();
  let msgNoteVisible = $state(false);
  let msgArrowVisible = $state(false);

  /**
   * The overlay's frame service — `draw_message_overlay` in the original (@0x335ce, call @0xbe22)
   * plus the arrow clock from `frame_timer` (@0xd4ad). `elapsed` are the gameTicks passed since the
   * last call; the original subtracts `gs+0x284` per frame, which sums to the same.
   *
   * Runs with the simulation PAUSED as well (from `flushCommands`, there with `elapsed = 0`): an
   * action can enqueue a message, and without this call sound and paper would stay away until the
   * next tick. The original knows no pause and does not need the place.
   */
  function serviceMessageIndicators(elapsed: number): void {
    const player = engineState.players[buildPlayer];
    if (!player) return;
    const opts = engineState.header.viewOptions[0] ?? 0;
    // The three save clocks belong to the game state (global), not to the window — hence a parameter
    // of their own. Without them the two reminders would never run.
    const sound = serviceMessageOverlay(
      messageOverlay,
      player,
      opts,
      elapsed,
      engineState.saveClocks,
    );
    const shown = messageOverlayDisplay(messageOverlay, player, opts, engineState.gameTick);
    if (msgNoteVisible !== shown.note) msgNoteVisible = shown.note;
    if (msgArrowVisible !== shown.arrow) msgArrowVisible = shown.arrow;
    if (sound !== null) playUiSound(sound);
  }

  /**
   * **Mission end (screen 0x36)** — the index into its step sequence, `null` = window closed. This
   * window is modal as well: the original clears `vp[1]` bit 1 both when drawing a picture
   * (`FUN_0004701c`) and at the exit, so no map click gets through while the screen is up. Declared
   * before `mapAcceptsClicks` so it flows in there.
   */
  let missionEndStep = $state<number | null>(null);
  /** The popup slots of the original — one of them at most is open, see {@link openPopupSlot}. */
  type UiSlot =
    | 'buildMenu'
    | 'soil'
    | 'menu'
    | 'message'
    | 'missionEnd'
    | 'object'
    | 'preview';

  /**
   * **Which popup is open.** The original has exactly ONE popup slot — `vp[0x70]` holds the screen
   * number — so at most one of these can be showing; our seven separate flags are the port's
   * addition, and this is where they come back together.
   *
   * The order is the PAINTING order, and a later entry wins: drawing and click routing then agree
   * about which window is on top without a second list that could drift apart.
   */
  const openPopupSlot = $derived.by((): UiSlot | null => {
    let slot: UiSlot | null = null;
    if (buildMenuScreen !== null) slot = 'buildMenu';
    if (soilPopupOpen) slot = 'soil';
    if (menuScreen !== null) slot = 'menu';
    if (messageTypeByte !== null) slot = 'message';
    if (missionEndStep !== null) slot = 'missionEnd';
    if (objectScreen !== null) slot = 'object';
    if (previewOpen) slot = 'preview';
    return slot;
  });

  /**
   * **Does the map accept clicks?** — `vp[1]` bit 1 in the original. The map click branch checks it
   * first (`@0x29d45: bt $0x1; jz 0x2bff7`): if the bit is clear, the click jumps into the popup
   * click router (@0x2bff7), which subtracts `vp[0x78]/vp[0x7a]` and discards everything outside the
   * popup rectangle. That is the original's modality: with a popup open nothing outside it is
   * possible — only the bar (different branch, `y ≥ vp[0x30]` = 440).
   *
   * The bit is set/cleared exclusively on a screen change: the open path clears it (`vp[1] &= ~2`,
   * right next to `vp[0x70] = screen`), `FUN_0002860b` (close) sets it again. It therefore coincides
   * with "no popup open" — hence derived rather than kept as a second state that could drift apart.
   */
  const mapAcceptsClicks = $derived(openPopupSlot === null);

  /**
   * What the playing field announces itself as. With the popups drawn into the canvas there is no
   * element left that could carry a `role="dialog"`; naming the open window here is the least a
   * screen reader needs to notice that one opened at all.
   */
  const popupLabel = $derived.by((): string => {
    switch (openPopupSlot) {
      case 'buildMenu':
        return st('view.buildMenu');
      case 'soil':
        return st('view.soil');
      case 'message':
        return st('view.message');
      case 'missionEnd':
        return st('view.missionEnd');
      case 'object':
        return st('view.object');
      case 'preview':
        return st('view.overview');
      case 'menu':
        return st('view.controlPanel');
      default:
        return st('view.map');
    }
  });

  /** Close all popups, as on closing in the original (`FUN_0002860b` @0x2860b). */
  function closePopups(): void {
    messageTypeByte = null;
    missionEndStep = null;
    buildMenuScreen = null;
    soilPopupOpen = false;
    previewOpen = false;
    menuScreen = null;
    // The disk menu hangs on `menuScreen`; if the popup is closed another way (bar tab, map click),
    // its session must go with it — otherwise a half-finished save including the name input would
    // lie idle in the state.
    disk = null;
    diskPending = null;
    objectScreen = null;
    buildMenuNote = null;
    pressedTabIcon = null;
    // The pressed button falls back: slots 2..4 to the init values, slots 0/1 derived anew from the
    // classification — in the original `vp[0x62..0x64] = {10,0xc,0xe}` + `vp[1] |= 4`.
    barIcons = controlPanelIconsAfterClose(barIcons);
    if (selected !== null) refreshContextIcons(selected.col, selected.row);
  }

  // --- message window (popup screen 0x33) --------------------------------------------------------

  /**
   * Raw type byte of the message currently shown (`vp[0x96]`), `null` = window closed. The remembered
   * view (`vp[0x1c2]/[0x1c4]`) is the starting point the arrow leads back to.
   */
  /** Faces of the players for the colour field (`gs+0x1d6 + i·4`). */
  const messageFaces = $derived(playerFaces(save.header));

  /**
   * "Click the paper" — `FUN_00027c9a` @0x27c9a: take the oldest message, jump to its map position
   * for types that carry one (bit mask `0x8f3fe`), open screen 0x33. The FIRST time the original
   * remembers the view so the arrow can lead back.
   */
  function showNextMessage(): void {
    const player = engineState.players[buildPlayer];
    if (!player || !player.active) return;
    const types = player.messageTypes as number[];
    const positions = player.messagePositions as number[];
    // Message level filter (`draw_message_overlay` @0x335ce): filtered-out messages are DISCARDED,
    // not hidden — hence before any query of the list.
    pruneFilteredMessages(types, positions, engineState.header.viewOptions[0] ?? 0);
    if ((types[0] ?? 0) === 0) {
      note('no message available.');
      return;
    }
    // The original remembers the starting point only while the arrow is still OFF (`bt $0x3 ; jne`
    // @0x278a0) — across several read messages the first one is thus kept.
    if (!messageOverlay.arrowVisible) messageReturnTo = viewCenterTile();
    const popped = popMessage(types, positions);
    if (popped === null) return;
    if (messageHasPosition(messageType(popped.type))) {
      const col = popped.position % geo.cols;
      const row = (popped.position - col) / geo.cols;
      centerCameraOnTile(col, row);
      selected = { col, row };
      refreshContextIcons(col, row);
    }
    closePopups();
    messageTypeByte = popped.type;
    // @0x278b7/@0x278ce/@0x27910/@0x2791b: arrow on, list marked for re-evaluation, arrow clock set —
    // and the visibilities updated at once (the list has just become shorter).
    noteMessageShown(messageOverlay);
    serviceMessageIndicators(0);
  }

  /** "Click the arrow" — back to the remembered starting point; an open 0x33 closes with it. */
  function returnFromMessage(): void {
    const back = messageReturnTo;
    if (back === null) {
      note('no starting point remembered.');
      return;
    }
    centerCameraOnTile(back.col, back.row);
    messageReturnTo = null;
    messageTypeByte = null;
    note('back to the starting point');
    // @0x2779f/@0x277b3: arrow off, clock to 0.
    noteArrowClicked(messageOverlay);
    serviceMessageIndicators(0);
  }

  /**
   * **Set a recall** — the clock column of the bar (`@0x27947`). The dispatcher only checks the x
   * column; WHICH of the three recall kinds it is depends on the popup screen currently open:
   *
   * ```
   * no popup open (vp[1] bit 1)         → map location,     type 5   @0x27b9e
   * screen 0x1c..0x21 / 0x2d / 0x2e     → distribution menu, type 16 @0x27a1e
   * screen 0x26 / 0x2b / 0x2c           → stock/castle,     type 19  @0x27aee
   * otherwise                           → rejected (sound 4)         @0x27c77
   * ```
   *
   * The time comes from the clicked clock — in TWO different ways: the building branch computes with
   * 8 px rows, the other two with 7 px rows. That is an inconsistency of the original at the same
   * column (details in `message-recall.ts`); the 8 px match the sprite geometry of the five clock
   * faces.
   */
  function openPopupScreen(): number | null {
    if (objectScreen !== null) return objectScreen;
    if (menuScreen !== null) return menuScreen;
    if (buildMenuScreen !== null) return buildMenuScreen;
    if (messageTypeByte !== null) return 0x33;
    if (soilPopupOpen) return 0x16;
    if (previewOpen) return 1;
    return null;
  }

  function setRecallFromClock(dy: number): void {
    const player = engineState.players[buildPlayer];
    if (!player || !player.active) {
      playUiSound(UI_SOUND_REJECT);
      return;
    }
    if (recallQueueFull(player)) {
      // `cmpw $0x40,(%edi) ; je 0x27c77` @0x279b2 — 64 recalls are the maximum.
      playUiSound(UI_SOUND_REJECT);
      note('recall list full (64).');
      return;
    }
    const screen = openPopupScreen();
    const minutes = ['5', '10', '20', '30', '60'];
    let ok = false;
    let what = '';
    if (screen === null) {
      const center = viewCenterTile();
      ok = runCommand({
        kind: 'scheduleRecall',
        player: buildPlayer,
        delayRow: recallClockRow(dy),
        target: { kind: 'map', col: center.col, row: center.row },
      });
      what = 'to this place';
    } else if (recallIsBuildingScreen(screen)) {
      // `player+0x176` is `objectSubject` here (see there) — the index the open building window
      // refers to.
      const target = engineState.buildings[objectSubject];
      if (target) {
        ok = runCommand({
          kind: 'scheduleRecall',
          player: buildPlayer,
          delayRow: recallClockRowEighths(dy),
          target: { kind: 'building', col: target.col, row: target.row },
        });
        what = 'to this warehouse';
      }
    } else {
      const menu = recallMenuIndex(screen);
      if (menu !== null) {
        ok = runCommand({
          kind: 'scheduleRecall',
          player: buildPlayer,
          delayRow: recallClockRow(dy),
          target: { kind: 'menu', index: menu },
        });
        what = 'to this menu';
      }
    }
    if (!ok) {
      playUiSound(UI_SOUND_REJECT);
      note('no recall possible from here.');
      return;
    }
    playUiSound(UI_SOUND_RECALL_SET);
    const row = screen !== null && recallIsBuildingScreen(screen)
      ? recallClockRowEighths(dy)
      : recallClockRow(dy);
    note(`recall ${what} in ${minutes[row] ?? '?'} minutes.`);
    markEngineMutated();
  }



  /** The tick in the window closes the message. */
  function handleMessagePopupClick(x: number, y: number): void {
    // Screen 0x33 has exactly the tick zone; a hit sounds like any popup button (@0x2cd3b).
    if (hitTestPanel(MESSAGE_POPUP_HITBOXES, x, y) === MESSAGE_ACTION_CLOSE) {
      playUiSound(UI_SOUND_PANEL_BUTTON);
      messageTypeByte = null;
    }
  }

  // --- mission end (popup screen 0x36) -----------------------------------------------------------


  /** What the screen reads: game type, winner, campaign level, faces. */
  const missionEndView = $derived<MissionEndView>({
    gameType: renderState.header.gameType,
    // The winner is set **during play** (`stats-recorder.ts`) and must therefore come from the engine
    // state — `save.header` is the state at load time and would always be −1 here.
    winnerIndex: renderState.header.winnerIndex,
    levelSetupIndex: renderState.header.levelSetupIndex,
    faces: messageFaces,
  });

  const missionEndStepList = $derived(missionEndSteps(missionEndView));

  /**
   * **The credits step** (`call 0x38b55` @0x3884a) — not a popup but a full-screen sequence on a
   * 352 × 240 surface of its own with its own palette; data and drawing in `core/end-credits.ts`,
   * sequencing in `EndCreditsView`.
   *
   * It stands in the same step sequence as the pictures, but is **not** drawn by the popup canvas
   * (that would yield the text page a second time, because `drawMissionEndPopup` only knows picture
   * and text) and is **not** advanced by the click: the credits cannot be aborted, their call census
   * contains no key query. They end by themselves and then take the same exit as the last picture.
   *
   * Without an archive (BYOA) there is nothing to show; then the exit follows immediately rather
   * than leaving a black area nobody can click away.
   */
  const missionEndCurrentStep = $derived(
    missionEndStep === null ? undefined : missionEndStepList[missionEndStep],
  );
  const showEndCredits = $derived(
    missionEndCurrentStep?.kind === 'endCredits' && archive !== null,
  );

  /**
   * **Part 0 of `FUN_0000eced`** at the frame boundary: does the screen open now? The original asks
   * this once per frame at the very start of the economy group; here it stands after `runTicks`,
   * where the frame beat is. The difference is a fraction of a frame: the predicate acknowledges
   * `missionEndPending` itself and therefore fires exactly once.
   *
   * `pause_game_clock` (@0x3831d) stands in the renderer of the sequence; here the stopping hangs on
   * `missionEndStep`, see `playing`.
   */
  function openMissionEndIfDue(): void {
    if (missionEndStep !== null) return;
    // `vp[0x72]` = the open popup screen. The lock list (0x17..0x1a disk, 0x22/0x23 end, 0x25 options
    // footer) runs entirely through `menuScreen` here except for 0x23, which is not ported. `0` means
    // "none", as in the original.
    const gate = { roadBuilding: roadBuild().active, currentScreen: menuScreen ?? 0 };
    if (!missionEndScreenDue(engineState, gate)) return;
    // The sink of the renderer that outlives the screen (@0x384f7): the password of the next level
    // into `header.levelPassword`, from where it reaches the menu line. Here and not while drawing,
    // because drawing runs once per frame.
    writeMissionEndPassword(engineState);
    missionEndStep = 0;
  }

  /**
   * The exit (@0x38886 ff.): music/clock back, the passive icon row in BOTH windows, then
   * `vp[0x70] = 0x22` — the "ENDE" dialog. That the original resumes here (`resume_game_clock`
   * @0x3888b) and the renderer of 0x22 stops again right away has no effect: the clock stands in
   * both states.
   */
  function leaveMissionEnd(): void {
    missionEndStep = null;
    barIcons = [...MISSION_END_EXIT_BAR_ICONS];
    // The marker slots `vp+0x65..0x69` get `0xff` in the original (@0x388e6 / @0x38973) — no button
    // is pressed any more. Our model keeps only the one pressed tab of them.
    pressedTabIcon = null;
    menuScreen = MISSION_END_EXIT_SCREEN;
  }

  /**
   * Is the bar showing? During the credits there is NO chrome: the original paints over the whole
   * area and only brings frame and bar back afterwards (`call 0x718a ; call 0x6e50` at the exit).
   * Read by the compositor AND by the click router, so the two cannot disagree about it.
   */
  const barVisible = $derived(uiProvider !== null && !showEndCredits);

  /**
   * THE OPEN POPUP AS A SURFACE — one slot, as in the original.
   *
   * `$derived` and not an effect: painting is a pure function of the state, and the compositor
   * takes the result by identity, so a repaint needs no counter and no flag. Each branch reads only
   * what it needs, which is also what keeps a closed popup from invalidating anything.
   *
   * `null` covers three different cases on purpose — no popup open, no sprites yet, and "the
   * subject is gone" from {@link paintPopup}. Only the last one has a consequence, and it is drawn
   * below where it can be seen.
   */
  const popupSurface = $derived.by((): Framebuffer | null => {
    const draw = uiProvider;
    if (draw === null) return null;
    switch (openPopupSlot) {
      case 'buildMenu': {
        const screen = buildMenuScreen;
        if (screen === null) return null;
        const site = buildSite;
        return paintPopup(
          draw,
          (fb) =>
            drawBuildMenuBody(fb, draw, screen, {
              militaryBlocked: site?.militaryBlocked === true,
              flagBlocked: site?.flagBlocked === true,
              playerColor: buildPlayer,
            }),
          popupPlayerButtons,
        );
      }
      case 'soil': {
        const analysis = soilAnalysis;
        if (analysis === null) return null;
        return paintPopup(draw, (fb) => drawSoilPopup(fb, draw, analysis, uiTextColor));
      }
      case 'menu': {
        const screen = menuScreen;
        if (screen === null) return null;
        void frameVersion; // the statistics show live numbers
        void compareStatsMode;
        void resourceStatsItem;
        return paintPopup(
          draw,
          (fb) =>
            drawMenuBody(fb, draw, screen, {
              stats: {
                state: engineState,
                player: buildPlayer,
                compareMode: compareStatsMode,
                resourceItem: resourceStatsItem,
                paletteColor: palette === null ? undefined : paletteColor,
              },
              settings: settingsView,
              options: optionsView,
              device: deviceWorking,
              barColor: uiBarColor,
              textColor: uiTextColor,
              playerColor: buildPlayer,
              isSettings: (s) => SETTINGS_SCREENS.includes(s),
              isStats: (s) => STATS_SCREENS.includes(s),
              isOptions: (s) => OPTIONS_SCREENS.includes(s),
              isDevice: (s) => s === DEVICE_SCREEN,
              isMapFilter: (s) => MAP_FILTER_SCREENS.includes(s),
              disk,
              isDisk: (s) => DISK_SCREENS.includes(s),
              diskBarColor,
            }),
          popupPlayerButtons,
        );
      }
      case 'message': {
        const typeByte = messageTypeByte;
        if (typeByte === null || palette === null) return null;
        const rgba = palette.rgba;
        return paintPopup(draw, (fb) => {
          drawMessagePopup(fb, draw, {
            typeByte,
            playerFaces: messageFaces,
            palette: rgba,
            textColor: uiTextColor,
          });
        });
      }
      case 'missionEnd': {
        const index = missionEndStep;
        if (index === null) return null;
        const step = missionEndStepList[index];
        // The credits step has no popup — it hangs on the full-screen overlay (`showEndCredits`).
        if (step === undefined || step.kind === 'endCredits') return null;
        const view = missionEndView;
        return paintPopup(
          draw,
          (fb) => {
            drawMissionEndPopup(
              fb,
              draw,
              step,
              view,
              missionEndPassword(view, SETUP_PASSWORD_BYTES),
              uiTextColor,
            );
          },
          popupPlayerButtons,
        );
      }
      case 'object': {
        const screen = objectScreen;
        if (screen === null) return null;
        void frameVersion; // the popups show live data (stocks, garrison)
        return paintPopup(
          draw,
          (fb) =>
            drawObjectPopupBody(fb, draw, screen, objectSubject, {
              state: engineState,
              player: buildPlayer,
              textColor: uiTextColor,
              attachRoad: attachRoadPossible,
            }),
          popupPlayerButtons,
        );
      }
      case 'preview': {
        const data = previewData;
        if (data === null) return null;
        return paintPopup(draw, (fb) => {
          // Marker and window centre are the same field (`vp+0x46/0x48`, respectively the
          // `vp+0x74/0x76` set from it) — while the popup is open the map cannot scroll (modality).
          drawMapPreview(
            fb,
            data,
            {
              centerCol: previewCenter.col,
              centerRow: previewCenter.row,
              cursorCol: previewCenter.col,
              cursorRow: previewCenter.row,
              mode: previewMode,
              buildingFilter: previewFilter,
              playerIndex: buildPlayer,
              viewportSpan: previewSpan,
              tileStep: previewStep,
            },
            draw,
          );
          drawMapPreviewBar(fb, draw, previewMode, previewFilter);
        });
      }
      default:
        return null;
    }
  });

  /**
   * The one case in which painting has a consequence: the special-click window reports that its
   * subject is gone (a razed building, a removed flag), and the original closes the window there.
   * It is an effect and not part of the painting because it writes state.
   */
  $effect(() => {
    if (openPopupSlot === 'object' && uiProvider !== null && popupSurface === null) closePopups();
  });

  /**
   * EVERY click steps on — the screen has no zone table (its cell `@0x2c24e` of the click dispatcher
   * is a bare `ret`) but consumes the clicks in its own wait loops (`FUN_00039335`). After the last
   * step comes the exit.
   */
  function handleMissionEndClick(x: number, y: number): void {
    if (missionEndStep === null) return;
    // During the credits nothing of this is drawn; the condition is the bolt against a click from
    // elsewhere skipping them — the original reads no key in the whole sequence.
    if (showEndCredits) return;
    // The frame-head strip applies here as well: in the original the y<0 branch of the click router
    // lies BEFORE the screen dispatch, which is the only reason this screen's cell is a bare `ret`.
    if (popupPlayerSwitchClick(x, y)) return;
    const next = missionEndStep + 1;
    if (next >= missionEndStepList.length) leaveMissionEnd();
    else missionEndStep = next;
  }

  /**
   * Does the click lie on the control bar? — then it belongs to the bar, no matter which DOM element
   * received it.
   *
   * **Why this is necessary (and at the same time closer to the original).** The original has ONE
   * click dispatcher `FUN_000272d7`: it separates bar and map by the y coordinate alone
   * (`y >= vp[0x30]` = 440). Splitting this across two DOM handlers was the deviation — and it broke
   * on the POINTER CAPTURE: once the right press on the map has called `setPointerCapture()`, the
   * browser delivers all following pointer events **and the mouse events derived from them**
   * (`mousedown`/`mouseup`/`click`) to the capturing element. A left click on the bar therefore never
   * reached the bar handler while the right button was held over the map — and that posture is
   * precisely the special click, so the three branches demanding it were the ones affected.
   *
   * The hit test takes its rectangle from {@link originBoxRect} — the SAME computation that puts the
   * bar on the screen. Drawing and hit test therefore cannot drift apart, which is what the old
   * version got out of measuring the bar's own DOM element.
   */
  function slotPixel(
    clientX: number,
    clientY: number,
    b: { x: number; y: number; width: number; height: number },
    srcW: number,
    srcH: number,
  ): { x: number; y: number } | null {
    const el = host;
    if (el === undefined) return null;
    return boxPixel(
      clientX,
      clientY,
      el.getBoundingClientRect(),
      el.width,
      el.height,
      originBoxRect(b, uiScale, viewportW, viewportH),
      srcW,
      srcH,
    );
  }

  /**
   * The bar's pixel under the given client point, or `null` when it is not on the bar. Coordinates
   * rather than an event: a long press dispatches without one (see {@link dispatchClickAt}).
   */
  function barPixel(clientX: number, clientY: number): { x: number; y: number } | null {
    return barVisible ? slotPixel(clientX, clientY, CONTROL_PANEL_BOUNDS, BAR_WIDTH, BAR_HEIGHT) : null;
  }

  /**
   * A click inside the open popup, routed to the screen that owns it. One entry point, as in the
   * original: `popup_click_router` @0x2bff7 subtracts the popup anchor and dispatches by screen.
   */
  function dispatchPopupClick(slot: UiSlot, x: number, y: number, special: boolean): void {
    switch (slot) {
      case 'buildMenu':
        handleBuildMenuClick(x, y, special);
        return;
      case 'soil':
        handleSoilPopupClick(x, y);
        return;
      case 'menu':
        handleMenuPopupClick(x, y);
        return;
      case 'message':
        handleMessagePopupClick(x, y);
        return;
      case 'missionEnd':
        handleMissionEndClick(x, y);
        return;
      case 'object':
        handleObjectPopupClick(x, y, special);
        return;
      case 'preview':
        handlePreviewClick(x, y, special);
        return;
    }
  }

  /**
   * Click on the bar: original dispatch by ICON VALUE (not by index). If it hits, the icon row
   * rewrites itself as in the original; `screen` opens a popup, `command` sends a command through the
   * same deterministic command layer as every other action.
   *
   * `special` = `vp[1]` bit 3 (right mouse button held) comes from the CALLER, because only it knows
   * all sources; after a pointer capture `e.buttons` alone is no longer reliable.
   */
  function handleBarClick(x: number, y: number, special: boolean): void {
    const slot = hitTestControlPanelButton(x, y, BAR_OFFSET_X, BAR_OFFSET_Y);
    const clickedIcon = slot === null ? null : barIcons[slot];
    // Without a matching click kind `clickControlPanel` returns `null` — as in the original, where
    // the icon branch then simply does not run (demolish icons need the special click).

    // **Message strip** — not an icon slot but a fixed area in the click branch
    // `panel_click_dispatch`; hence before the icon dispatch (see `hitMessagePanelStrip`).
    const strip = hitMessagePanelStrip(x - BAR_OFFSET_X, y - BAR_OFFSET_Y);
    if (strip === 'show') {
      // Three exits with three sounds (`messageStripShowOutcome`, @0x27814 ff.): "nothing to show"
      // sounds like a BUTTON (8) — rejected (4) only when the open screen forbids it. The order of
      // the tests is the original's: list, then road building, then screen; without a message AND a
      // locked screen it therefore sounds 8, not 4.
      const player = engineState.players[buildPlayer];
      const opts = engineState.header.viewOptions[0] ?? 0;
      // Prune first, then ask — `vp[0x87]` bit 0 arises in the overlay in the original, i.e. AFTER
      // the level filter. Without the prune a filtered-out head message would yield "no message"
      // although a visible one waits behind it.
      let hasMessage = false;
      if (player !== null && player !== undefined && player.active) {
        pruneFilteredMessages(player.messageTypes as number[], player.messagePositions as number[], opts);
        hasMessage = hasVisibleMessage(player, opts);
      }
      const outcome = messageStripShowOutcome(hasMessage, roadActive, openPopupScreen() ?? 0);
      if (outcome === 'blocked') {
        playUiSound(UI_SOUND_REJECT);
        note('no message can be opened from this screen.');
        return;
      }
      playUiSound(UI_SOUND_PANEL_BUTTON);
      if (outcome === 'show') {
        // `btr $0x6` @0x27889 — only behind all three gates (list, road building, screen); the two
        // silent respectively rejected exits leave the build helper standing.
        buildHelper = false;
        showNextMessage();
      } else note(roadActive ? 'not possible while building a road.' : 'no message available.');
      return;
    }
    if (strip === 'return') {
      // `bt $0x3` on `vp[0x87]` @0x2776a: without a visible arrow the branch ends on `ret` —
      // SILENT, not rejected.
      if (!msgArrowVisible) return;
      playUiSound(UI_SOUND_PANEL_BUTTON); // @0x2780e
      returnFromMessage();
      return;
    }

    // **Clock column** (recall function) — the second fixed area of the same dispatcher, @0x27350.
    const clockDy = hitRecallClockStrip(x - BAR_OFFSET_X, y - BAR_OFFSET_Y);
    if (clockDy !== null) {
      setRecallFromClock(clockDy);
      return;
    }

    // A special click on a slot-0 icon = **toggle the build helper**. In the original seven icon
    // branches jump to the toggle routine @0x27eb5 when `vp[1]` bit 3 is set; it checks two things
    // (`vp[1]` bit 1 = no popup open, bit 7 = no road-building mode) and then complements `vp[0]`
    // bit 6. Hence BEFORE the icon dispatch: there the same icons demand the plain click.
    if (special && clickedIcon !== null && clickedIcon !== undefined
        && BUILD_HELPER_TOGGLE_ICONS.has(clickedIcon)) {
      if (!mapAcceptsClicks) return; // `bt $0x1` @0x27ebd - no popup open
      if (roadBuild().active) return; // `bt $0x7 ; jne 0x27eff` @0x27ed1 - not in road building
      buildHelper = !buildHelper;
      // Sound **8** @0x27ef1, immediately behind the `btc` — the toggle is therefore NOT silent.
      // Silent is only the *icon* branch that jumps here; the two gates above return without a
      // sound (`ret` @0x27eff).
      playUiSound(UI_SOUND_PANEL_BUTTON);
      note(`build helper ${buildHelper ? 'on' : 'off'} (all possible build sites)`);
      return;
    }

    // **The icon sound** — here and only here, because the original enqueues it at exactly this
    // point: behind the build-helper branch (which is silent, see above) and before every other
    // special path. Hence `0x0a`/`0x13` sound on a special click as well, although something else
    // happens just below — their cascade blocks have no special-click gate before enqueueing.
    if (clickedIcon !== null && clickedIcon !== undefined && CONTROL_BAR_SOUND_ICONS.has(clickedIcon)) {
      playUiSound(UI_SOUND_PANEL_BUTTON);
    }

    // A special click on the OVERVIEW icons (0x0a/0x13) is the bar's only special path of its own:
    // `vp[0xd8] = 0x10` ⇒ the scroll driver calls `FUN_000056d8` = jump to the own castle.
    if (special && (clickedIcon === 0x0a || clickedIcon === 0x13)) {
      // `btr $0x6` @0x27f08 stands **before** the special/normal fork (`bt $0x3` @0x27f1c) and thus
      // applies to both click kinds. `runPanelAction` covers the popup branch, the castle jump here.
      buildHelper = false;
      if (!mapAcceptsClicks) return;
      note(jumpToCastle() ? 'jumped to the castle' : 'no castle present.');
      return;
    }

    const action = clickControlPanel(barIcons, x, y, BAR_OFFSET_X, BAR_OFFSET_Y, special);
    if (action === null) {
      // If the click hits an icon whose branch demands the other click kind, name the reason.
      const hit = clickedIcon === undefined || clickedIcon === null
        ? null
        : CONTROL_PANEL_BUTTON_ACTIONS.get(clickedIcon);
      if (hit && !panelActionMatchesClick(hit, special)) {
        note(hit.click === 'special'
          ? `${hit.label} — special click only (hold the right button, click left).`
          : `${hit.label} — plain click only.`);
      }
      return;
    }

    // Original: clicking the ACTIVE tab again closes the popup instead of reopening it. Hence check
    // this before anything else — after paging as well.
    if (clickedIcon !== null && clickedIcon === pressedTabIcon) {
      closePopups();
      note(`${action.label} — closed`);
      return;
    }
    runPanelAction(action, slot);
  }

  /**
   * The action part of a bar click — a function of its own because the original reaches it by TWO
   * ways: the bar click itself and the fast build click on the map, which calls
   * `FUN_000273d6(vreg0 = 0)`, i.e. "as if slot 0 had been clicked".
   */
  function runPanelAction(action: PanelButtonAction, slot: number | null): void {
    // Icon 0x06 is the original's only TWO-WAY case: at cursor kind 2 (removable flag) it demolishes
    // immediately (`FUN_00048c8a`), otherwise it opens the confirmation popup 0x37 for the building.
    // Hence the cursor kind decides here, not the order of the fields.
    const twoWay = action.command !== undefined && action.screen !== undefined;
    const takeCommand =
      action.command !== undefined &&
      (!twoWay || buildSite?.cursorType === CURSOR_REMOVABLE_FLAG);
    if (takeCommand) {
      note(runBarCommand(action.command!, action.label));
      return;
    }
    // Only AFTER the branch: the original writes the icon row per branch, and the command branch of
    // icon 0x06 writes none (it has slots 0/1 derived anew). All entries with `newIcons` and without
    // `command` reach this line unchanged.
    if (action.newIcons !== undefined) barIcons = [...action.newIcons];
    if (action.screen !== undefined) {
      // **Not** every popup branch clears `vp[0]` bit 6 — only the four that do so in the ASM
      // (@0x27f08 overview, @0x280da statistics, @0x28165 distribution, @0x28385 soil samples). The
      // three build-menu branches (screens 3/4/5) and the demolish confirmation (0x37) leave the
      // build-site markers standing: in the original they stay visible across building. Which branch
      // clears is stated at the table entry (`clearsBuildHelper`), not here.
      if (action.clearsBuildHelper) buildHelper = false;
      if (openScreen(action.screen)) {
        // From now on this slot is the active tab — the click rewrote its icon to the "pressed"
        // variant (`newIcons`), and exactly that one closes again on the next click.
        pressedTabIcon = slot === null ? null : (barIcons[slot] ?? null);
        note(action.label);
      } else {
        note(`${action.label} — screen ${action.screen} is not ported yet.`);
      }
      return;
    }
    note(action.label);
  }

  /** Map the bar's direct actions onto the command layer. */
  function runBarCommand(command: string, label: string): string {
    if (selected === null) return 'select a tile first.';
    const { col, row } = selected;
    let cmd: Command | null = null;
    // **Road-building toggle** (`@0x27490`): the same icon starts and aborts, decided by `vp[1]`
    // bit 6. Both branches write an icon row of their own — hence here and not through `newIcons` of
    // the table entry.
    if (command === 'toggleRoadBuilding') {
      const player = engineState.players[buildPlayer];
      if (!player || !player.active) return 'no player.';
      if (roadBuild().active) {
        runCommand({ kind: 'cancelRoadBuilding', player: buildPlayer });
        barIcons = [barIcons[0], barIcons[1], ...ROAD_BAR_ICONS_LEAVE];
        syncRoadView();
        refreshContextIcons(player.cursorCol, player.cursorRow);
        // The abort CLEARS THE PROVISIONAL ROAD BITS — a real map change.
        markEngineMutated(true);
        return `${label} — aborted`;
      }
      // `btr $0x6` on `vp[0]` @0x28615 — entering the mode CLEARS the build helper, and does so as
      // the very first thing, i.e. BEFORE the flag gate (@0x28637/@0x28643): a refused start clears
      // the build-site markers too. Same order as with road demolition below.
      buildHelper = false;
      // Sets the cursor itself (see the command docs) and computes the allowed directions.
      if (!runCommand({ kind: 'beginRoadBuilding', col, row, player: buildPlayer })) {
        return `${label} — only from a flag.`;
      }
      barIcons = [...ROAD_BAR_ICONS_ENTER];
      syncRoadView();
      markEngineMutated(); // cursor set to the starting flag - the map is still unchanged
      return `${label} — click a neighbouring tile; the bar icon aborts.`;
    }
    if (command === 'demolishRoad') {
      // `action_demolish_road` @0x4a493 starts with `btr $0x6` on `vp[0]` — the build helper display
      // goes OFF, and does so BEFORE the gate, so also when the demolition is refused. (Not to be
      // confused with flag building: that clears bit **7** of the same byte = the cache mark, not the
      // display.)
      buildHelper = false;
      cmd = { kind: 'demolishRoad', col, row, player: buildPlayer };
    }
    else if (command === 'foundCastle') cmd = { kind: 'foundCastle', col, row, player: buildPlayer };
    // Icon `0x06` at cursor kind 2: the original calls the SAME routine as the confirm button of
    // screen 0x37 (`FUN_00048c8a`), not the flag primitive.
    else if (command === 'demolishAtCursor') cmd = { kind: 'demolishAtCursor', col, row, player: buildPlayer };
    else if (command === 'buildFlag') {
      // On flag building name the REAL reason for refusal instead of a blanket "not possible here".
      const reason = buildFlagRejection(engineState, { col, row, player: buildPlayer });
      if (reason !== null) {
        refreshContextIcons(col, row);
        return `${label} — ${reason}`;
      }
      cmd = { kind: 'buildFlag', col, row, player: buildPlayer };
    }
    if (cmd === null) return label;
    const allowed = canApplyCommand(engineState, cmd);
    // **The sounds of the two demolish actions** (`core/ui-sound.ts`). Both original handlers enqueue
    // a sound in EVERY branch — in the failure path as well — and do so before the effect.
    const soundPlayer = engineState.players[buildPlayer];
    if (cmd.kind === 'demolishAtCursor' && soundPlayer) {
      playUiSound(demolishOutcomeSound(demolishOutcomeAt(engineState, soundPlayer, col, row)));
    } else if (cmd.kind === 'demolishRoad') {
      playUiSound(allowed ? UI_SOUND_DEMOLISH_ROAD : UI_SOUND_REJECT);
    } else if (cmd.kind === 'foundCastle') {
      // `action_found_castle` @0x28d0a: the gate is `possibility == 5 && cursorType == 7` — exactly
      // the gate of `canApplyCommand`. Rejection sound 4 @0x28d35, success sound 2 @0x28d5d (and that
      // stands **before** the actual founding, as with the demolish actions).
      // `btr $0x6` @0x28d51 lies here — unlike in road building and road demolition — **behind** the
      // gate, so a rejected founding leaves the build helper display standing.
      if (allowed) buildHelper = false;
      playUiSound(allowed ? UI_SOUND_ACCEPT : UI_SOUND_REJECT);
    }
    // In both cases the original derives the icons again (failure path directly, success path via
    // the dirty bit) — the build site has changed after all.
    if (!allowed) {
      refreshContextIcons(col, row);
      return `${label} — not possible here.`;
    }
    // Success path via the dirty bit: the new cursor kind is only settled once the command has been
    // APPLIED (see `markContextDirty`) — otherwise the cursor would stay on "there is room here"
    // after building a flag instead of switching to "removable flag".
    markContextDirty(col, row);
    enqueueCommand(cmd);
    return `${label} ✓`;
  }

  /**
   * The bar as a SURFACE, not as a canvas of its own: `$derived` rather than an effect, because it
   * is a pure function of the icon row and the two message indicators. The compositor recognises a
   * change by the identity of the framebuffer, so nothing has to be counted or flagged.
   */
  const barSurface = $derived.by((): Framebuffer | null => {
    const draw = uiProvider;
    if (draw === null || !barVisible) return null;
    const fb = createFramebuffer(BAR_WIDTH, BAR_HEIGHT);
    clearFramebuffer(fb, 20, 16, 12);
    drawControlPanelFrame(fb, draw, BAR_OFFSET_X, BAR_OFFSET_Y);
    drawControlPanel(fb, draw, barIcons, BAR_OFFSET_X, BAR_OFFSET_Y);
    // Message overlay last: the two sprites lie over the wooden field of the message column.
    drawMessageIndicators(
      fb,
      draw,
      { note: msgNoteVisible, arrow: msgArrowVisible },
      BAR_OFFSET_X,
      BAR_OFFSET_Y,
    );
    return fb;
  });

  const cols = $derived(save.header.mapCols);
  const rows = $derived(save.header.mapRows);
  /** Map geometry for the torus wrap (masks/neighbour steps). */
  const geo = $derived(mapGeometry(save.header.mapSize));
  /**
   * Highest occurring tile height — determines how many half rows below the window have to be drawn
   * along (height shear pulls high tiles upwards). Once per map.
   */
  const maxHeight = $derived.by(() => {
    let m = 0;
    for (const t of save.mapTiles) if (t.height > m) m = t.height;
    return m;
  });

  // Cross lookup: entity record per slot index. Looks straight into the dense slot arrays of the
  // live state (`engineEntityIndex`) instead of building three fresh `Map`s over all records per
  // frame. Why that is consistent with `renderState` is documented at the function; the only door
  // for state changes beside it is `markEngineMutated`.
  const entityIndex = $derived(engineEntityIndex(engineState));

  const MINERAL_NAMES = ['—', 'Gold', 'Iron', 'Coal', 'Stone'];

  /**
   * Display zoom. The original has none — {@link DEFAULT_ZOOM} is our default, and afterwards the
   * value belongs to the two gestures that write it: the mouse wheel (`onWheel`) and the two-finger
   * pinch (`applyPinch`). A control for it is deliberately not provided. `minZoom` bounds it
   * downwards (whole world in frame), {@link ZOOM_MAX} upwards.
   */
  const DEFAULT_ZOOM = 3;
  /**
   * Upper bound of the zoom. Not to be confused with the 8 of the cursor scale — that one is the
   * limit of the browser's cursor images and has nothing to do with the map.
   */
  const ZOOM_MAX = 8;
  let zoom = $state(DEFAULT_ZOOM);
  /**
   * Camera: scene pixels of the window's top-left corner. **Unbounded** — that is the infinite
   * scrolling (the torus wrap happens while drawing, not by clamping the camera). Kept integral so
   * the pixels stay crisp.
   */
  let camX = $state(0);
  let camY = $state(0);

  let host: HTMLCanvasElement | undefined = $state();
  let viewportW = $state(800);
  let viewportH = $state(500);

  /**
   * Visible section of the main view **in tiles**. One preview pixel is exactly one tile, and a tile
   * is 32 × 20 scene pixels — the shear cancels out (reasoning at `drawViewportRect`).
   */
  const previewSpan = $derived({
    cols: viewportW / zoom / TILE_W,
    rows: viewportH / zoom / TILE_H,
  });

  /**
   * Tiles per preview pixel — an EXTENSION needed only because our view is zoomable: the original
   * always shows 128×128 tiles in the overview map, and from map size 6 (256×128) on that would be
   * less than the visible section. `previewTileStep` caps at "whole map in the window", which is why
   * all campaign maps (size 3) come out at 1 throughout.
   *
   * Drawing AND click read the same value — held in two places, a click would hit a different tile
   * than the one pointed at.
   */
  const previewStep = $derived(
    previewData === null
      ? 1
      : previewTileStep(previewSpan.cols, previewSpan.rows, previewData.cols, previewData.rows),
  );

  /**
   * Scale of the original screen elements (control bar, popups) — the same factor as the map. The map
   * is drawn with `ctx.scale(zoom, zoom)`; with the same `zoom` an original pixel of the bar is as
   * large as one of the map, and the UI keeps its proportion to the image while zooming (in the
   * original the bar is 352 of 640 px = 55 % of the width).
   *
   * Two bounds, both reachability and not a design decision:
   * - **1× downwards** — the UI never gets smaller than its original pixel size, so icons stay
   *   readable and buttons hittable while zooming the map out.
   * - **the window width upwards** — a wider bar would stick out of the window (`overflow: hidden`)
   *   and its outer buttons would no longer be clickable. If the window itself is narrower than the
   *   bar (< 352 px), the lower bound wins.
   */
  const uiScale = $derived(uiScaleFor(zoom, viewportW));

  /**
   * Scale of the pointer — the same factor as the bar ({@link uiScale}, so never below 1×), but
   * rounded to WHOLE steps: a cursor image is scaled hard by the system, fractional factors would
   * blur the 16×16 pixels. {@link CURSOR_MAX_SCALE} clamps upwards (128×128 is the browser limit for
   * cursor images).
   *
   * A derived value of its own so the (expensive) PNG encoding runs only on a STEP change and not on
   * every wheel tick.
   */
  const cursorScale = $derived(Math.max(1, Math.min(CURSOR_MAX_SCALE, Math.round(uiScale))));

  /**
   * The pointer sprite as a drawable image. Built once per SCALE STEP, not per frame: the screen
   * recording asks for it with every image it takes, and building it means two canvases and two
   * draws. `null` while no archive is loaded (BYOA) — the sprite does not exist then.
   */
  const cursorImage = $derived.by<HTMLCanvasElement | null>(() => {
    const draw = uiProvider;
    const s = cursorScale;
    if (draw === null) return null;
    const spr = draw(CURSOR_SPRITE_INDEX);
    return spr === null ? null : buildCursorCanvas(spr, s);
  });

  /**
   * **What a screen recording records**: the one canvas — and the pointer, which it has to supply
   * itself because a CSS cursor is not part of the canvas. It is drawn into the RECORDING's canvas
   * only; on screen the system keeps moving the real one, which cannot lag behind.
   */
  $effect(() =>
    recordings.provide({
      get canvas() {
        // `host` is set before the first frame; the recorder only asks while recording.
        return host as HTMLCanvasElement;
      },
      cursor: () => {
        const img = cursorImage;
        if (!pointerInside || img === null) return null;
        const s = cursorScaleOf(cursorScale);
        return {
          x: Math.round(pointerCanvasX) - CURSOR_HOTSPOT.x * s,
          y: Math.round(pointerCanvasY) - CURSOR_HOTSPOT.y * s,
          image: img,
        };
      },
    }),
  );

  /**
   * Original mouse cursor over the playing field (archive slot `Cursor`, see `mouse-cursor.ts`).
   * Falls back to the browser cursor while no archive is loaded (BYOA).
   */
  const cursorStyle = $derived.by<string | null>(() => {
    const img = cursorImage;
    return img === null ? null : cursorStyleFrom(img, cursorScale);
  });

  /**
   * Smallest sensible zoom: the point at which the WHOLE world is in frame.
   *
   * The map is a torus with the scene period `cols·32 × rows·20`. Zooming out further than the
   * window holds that period only shows repetitions — no information is added while the tile count
   * grows quadratically.
   *
   * `Math.min(…, 1)` makes sure the bound never forces zooming in: if the world already fits at
   * 100 % (small map, large screen), 100 % is the floor.
   */
  const minZoom = $derived(minZoomForWholeMap(viewportW, viewportH, geo));

  /** Visible window in scene pixels (the zoom converts screen into scene pixels). */
  const camera = $derived.by((): Camera => ({
    originX: camX,
    originY: camY,
    width: Math.ceil(viewportW / zoom),
    height: Math.ceil(viewportH / zoom),
  }));

  /**
   * Height of a map position **with torus wrap** — correct for negative coordinates as well (`posOf`
   * masks both axes; the earlier `% rows` broke on negative values). Needed by the camera/hit-test
   * logic; the render path has its own version in `map-frame-render.ts`.
   */
  function heightAt(c: number, r: number): number {
    return renderState.mapTiles[posOf(c, r, geo)].height;
  }

  // Persistent kits (decode/composition caches live across frames): null without an archive. They
  // must NOT be recreated per frame — the passes run on every refresh of a dirty rect and would
  // otherwise decode anew each time.
  //
  // Since the switch to palette indices the kits need **no palette**: they deliver index images,
  // colour arises only when presenting the finished surface. A palette change therefore no longer
  // discards the decode caches.
  const spriteKit = $derived(archive !== null ? buildSpriteKit(archive) : null);
  const roadKit = $derived(archive !== null ? buildRoadKit(archive) : null);
  const borderKit = $derived(archive !== null ? buildBorderKit(archive) : null);

  /**
   * Presents the finished index surface in colour. Persistent like {@link TerrainSurface} and for the
   * same reason: it holds offscreen canvas + `ImageData` across frames. Deliberately **no** `$state` —
   * the render effect mutates it, and a signal here would be an endless loop.
   */
  const presenter = new IndexPresenter();

  /**
   * Retained ground surface (palette indices). Lives across frames; is only shifted and refreshed in
   * the dirty rects. `null` without an archive (then the colour triangles draw).
   *
   * The palette is **not read here** — the surface holds indices, not colours. A palette change
   * therefore deliberately does NOT recreate the instance; the new colour arises when presenting.
   *
   * ⚠️ Two conditions under which `$derived.by` is correct here:
   * 1. **Nothing frame-varying may be read in this body** (camera, `frameVersion`, `renderState`).
   *    Otherwise the instance is recreated every frame and the retained pixels are gone — with no
   *    error message, only as an unexplained performance drop. Everything frame-dependent comes in
   *    as an argument of `render(ctx, cam, input)`.
   * 2. **`TerrainSurface` keeps its state in plain `#` fields, not in runes.** Only therefore is
   *    mutating it from the render `$effect` invisible to reactivity. Were the fields `$state`, the
   *    effect would read and write the same signals ⇒ endless loop.
   */
  const surface = $derived.by(() => {
    const arch = archive;
    if (arch === null) return null;
    return new TerrainSurface(createIndexedSpriteSource(arch));
  });

  /**
   * Reactive mirror of `engineState.territoryVersion`. Needed because `engineState` is a plain object
   * (mutated in place) — a field of it is not tracked. `frameVersion` only serves as the trigger to
   * read again; the VALUE changes only on a real territory recomputation, and identical derived
   * values do not propagate further in Svelte 5.
   */
  const territoryVersion = $derived.by(() => {
    void frameVersion; // re-read per frame / after actions
    return engineState.territoryVersion;
  });

  /**
   * Content version of the surface: when it changes, everything is rebuilt. Contains everything that
   * determines the STATIC image — map changes and the layer switches. NOT `frameVersion` (entities
   * are not in the surface) and not the camera (that is what retention is for). The border stones
   * live in the surface (static road layer), hence the territory counts too — otherwise territory
   * changes from plain ticks would stay invisible.
   */
  const surfaceVersion = $derived(
    `${mapVersion}|${heightUnit}|${showRoads}|${engineDirty}|${territoryVersion}`,
  );

  // Visible canvas per frame. The drawing body itself lives in `map-frame-render.ts` (pure function,
  // no runes): this effect only collects the reactive values and passes them through. All signals
  // are deliberately read **inside** the effect (the object literal does that) so the dependencies
  // stay unchanged.
  $effect(() => {
    const canvas = host;
    if (!canvas) return;
    // Sound gate: only on the first repaint of a new logic frame may the drawing pass enqueue and
    // the queue be serviced. See `lastSoundFrame` above.
    const soundFrame = logicFrame(engineState.gameTick);
    const soundDue = soundFrame !== lastSoundFrame;
    if (soundDue) lastSoundFrame = soundFrame;
    // Ambient sound (`viewport_ambient_audio` @0xef29). In the original the pass enqueues itself;
    // here it lives in the engine because its random draw belongs to the game state — the display
    // only picks up the result. The sound gate suffices as a once-per-frame latch. Deliberately only
    // READ, not reset: writing to the state from this effect would trigger it again.
    if (soundDue && engineState.ambient.sound !== null) {
      enqueueSound(soundQueue, engineState.ambient.sound);
    }
    renderMapFrame({
      canvas,
      viewportW,
      viewportH,
      zoom,
      cam: camera,
      geo,
      maxHeight,
      heightUnit,
      // `renderState` depends (while playing) on `frameVersion` → this effect re-blits per frame.
      renderState,
      engineState,
      palette,
      spriteKit,
      roadKit,
      borderKit,
      animations: animTable,
      entityIndex,
      surface,
      presenter,
      surfaceVersion,
      show: {
        objects: showObjects,
        buildings: showBuildings,
        flags: showFlags,
        serfs: showSerfs,
        roads: showRoads,
      },
      buildHelper,
      buildPlayer,
      selected,
      cursorMarkers,
      cursorRingSprites: roadActive ? roadRingSprites : undefined,
      playerColors: PLAYER_COLORS,
      // Sound sink of the drawing passes (`vp+0x16..0x19` plus the clip frame `vp+0x3e`/`vp+0x40`).
      // The measurements are those of the DRAWN map field in scene pixels, i.e. after the zoom —
      // exactly the space in which the entity pass computes its x/y. The original's map area is
      // 608×432.
      sound: soundDue
        ? {
            queue: soundQueue,
            latches: soundLatches,
            width: camera.width,
            height: camera.height,
            rng: soundMixer.rng,
          }
        : undefined,
    });
    // **The parts of the original screen on top of the map**, in painting order — popup below, bar
    // above it, as in the original, whose exit brings frame and bar back after the window. This has
    // to happen in the SAME pass: `renderMapFrame` re-creates the canvas surface on every frame, so
    // a composition of its own would either be wiped or be left standing on its own.
    const overlay: OverlayLayer[] = [];
    const pop = popupSurface;
    if (pop !== null) {
      overlay.push({ fb: pop, rect: originBoxRect(POPUP_BOUNDS, uiScale, viewportW, viewportH) });
    }
    const bar = barSurface;
    if (bar !== null) {
      overlay.push({
        fb: bar,
        rect: originBoxRect(CONTROL_PANEL_BOUNDS, uiScale, viewportW, viewportH),
      });
    }
    if (overlay.length > 0) {
      metrics.begin('ui');
      const ctx = canvas.getContext('2d');
      if (ctx !== null) composeUiOverlay(ctx, overlay);
      metrics.end('ui');
    }
    // The image is finished — hand it to a running screen recording. Deliberately HERE and not on a
    // clock of its own: the video then has exactly the frames the player saw, and none while the
    // simulation is paused. Costs nothing without a recording.
    recordings.capture();
    // Service after drawing, in the original's order: **first** the duration countdown
    // (`FUN_00061c93`), **then** the drainer (`FUN_00061fe3` → `sound_start`). This runs when muted
    // as well — `play` is a no-op then, but the queue must still be drained, otherwise the
    // Sounds of the first frame up to the user gesture.
    // The timing rule (including the pause case) is in `core/sound.ts` — what remains here is how
    // many original frames the voice countdowns have to catch up: with the simulation running
    // exactly one, while paused as many as really elapsed since the last interaction.
    if (soundServiceDue(soundDue, playing, soundQueue)) {
      const now = performance.now();
      const frames = soundDue
        ? 1
        : Math.min(64, Math.max(1, Math.round((now - lastServiceMs) / ORIGINAL_FRAME_MS)));
      lastServiceMs = now;
      for (let i = 0; i < frames; i++) tickSoundVoices(soundMixer);
      // Two separate statements, not `sfxPlayer?.play(serviceSound(…))`: with optional chaining JS
      // does NOT evaluate the argument when the player is missing — the queue would then stay filled
      // forever without an archive.
      const starts = serviceSound(soundMixer, soundQueue);
      // The tick only mutes the output — `serviceSound` runs above regardless, so the queue is
      // drained and the voice bookkeeping stays the same as with sound.
      if (uiSfx) sfxPlayer?.play(starts);
    }
  });

  /**
   * Centre on the own castle initially (otherwise the map centre) — only when the map changes.
   * **No fitting**: the map is a torus, there is no "see it all".
   */
  $effect(() => {
    void save;
    untrack(() => {
      zoom = DEFAULT_ZOOM;
      // The OWN castle, not the first in the table: the original centres each viewport on the castle
      // of the player it belongs to (`vp+0x82` comparison @0x5360/@0x538f in `place_player_castles`).
      // `player.castleBuilding` (block 388) is unambiguous; the index order is not — if the AI founds
      // first, its castle carries index 1.
      //
      // `castleBuilding` is a SLOT index, and `save.buildingRecords` is a compact list of the
      // occupied slots — unlike the engine's slot-indexed `state.buildings`. A `buildingRecords[own]`
      // would therefore hit an array POSITION: correct only by accident while the table has no holes,
      // and in 19 of 62 real saves it does. Hence search by `index` instead of subscripting.
      const own = save.playerRecords[buildPlayer]?.castleBuilding ?? 0;
      const castle =
        (own !== 0 ? save.buildingRecords.find((b) => b.index === own) : undefined) ??
        save.buildingRecords.find((b) => b.index !== 0 && b.type === 24);
      centerCameraOnTile(castle?.col ?? Math.floor(cols / 2), castle?.row ?? Math.floor(rows / 2));
    });
  });

  // --- mouse handling as in the original: LEFT sets the cursor, RIGHT moves the image ---
  //
  // In the binary the held right click is `vp[1]` **bit 3**: the setter @0x62428 sets it on right
  // down, every bar icon branch and the map click branch check it (polarity per branch →
  // `PanelButtonAction.click`). The scrolling itself is done by `FUN_0000d630` from the accumulated
  // mouse delta `vp[0x10]/vp[0x12]`.
  //
  // **Deliberate deviation**: the original scrolls in TILE steps (32 mouse pixels = 2 columns, the
  // remainder stays in the accumulator, `col -= (rowStep+colStep)>>1` compensates the hex shear) — a
  // consequence of the 8 px VGA latch granularity. We scroll per pixel because the camera can.
  //
  // --- ADDITION (not in the original): grab pan with the MIDDLE button ---
  //
  // The original pan (right, pushing away) is unfamiliar to newcomers, so the customary grab
  // direction exists in addition. It hangs on the **middle** button because that one is **permanently**
  // free: the original knows exactly two buttons — the mouse event record has the fields `edi+8`
  // (left) and `edi+0xc` (right), a third does not exist.
  //
  // **Why not left** (checked, rejected): the left button is *not* idle while dragging in the
  // original — held down it produces REPEAT CLICKS (`vp[0x8a]` counts up, at 0x20/0x30/0x3c one click
  // each fires with a freshly latched position, @0x62534 ff.; from 0x44 clamped to 0x3c ⇒ every 8
  // ticks), and the pointer moves along (it freezes only while the RIGHT button is held, @0x62310 vs.
  // @0x623f5). Left dragging is therefore a chain of clicks along the drag trail — the basis for
  // dragging a road. A left pan would have had to give way again at the latest with road-building
  // mode (`vp[1]` bit 7).
  /**
   * `null` = no drag · `'push'` = **right** button, original direction (the map is pushed away)
   * · `'grab'` = **middle** button, modern grab direction (addition, see the block comment above).
   */
  let dragMode: 'push' | 'grab' | null = null;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  /** Sub-pixel remainders of the pan (like the original's accumulator `vp[0x10]/[0x12]`). */
  let panRestX = 0;
  let panRestY = 0;

  /**
   * **Pan speed of the original pan.** The original scrolls 1:1 in its own pixels — but its image is
   * only `ORIGINAL_SCREEN_W` pixels wide and shown scaled up, while the (captured) mouse delivers one
   * DOS pixel per real pixel: sweeping the screen there takes 320 pixels of hand travel, here the
   * whole viewport width.
   *
   * The correction is exactly that ratio: **same hand travel ⇒ same share of the view** as in the
   * original. The zoom cancels out (camera delta `1/zoom`, view width `viewportW/zoom`), so the
   * factor depends only on the window size — and becomes 1 once the window is as large as the
   * original screen.
   *
   * **Only for the original pan (right).** The grab pan (middle) stays 1:1, otherwise the grabbed
   * point would slide away under the pointer — with direct manipulation 1:1 is the meaning.
   */
  const ORIGINAL_SCREEN_W = 320;
  const pushPanGain = $derived(Math.max(1, viewportW / ORIGINAL_SCREEN_W));
  /** Was the right button held while the left one was pressed? ⇒ special click (`vp[1]` bit 3). */
  let downSpecial = false;
  /**
   * **Track the right button ourselves** instead of reading it from `e.buttons` per event.
   *
   * Once the right press has called `setPointerCapture()`, the left button's `pointerdown` no longer
   * reaches our handler — `downSpecial` and the press point `downX/downY` would go stale, and the
   * drag threshold discarded the click entirely. Reading the button here and the special click from
   * the `click` event is the source that survives a capture; with one canvas for the whole game
   * screen, bar and map are on it anyway.
   */
  let rightDown = false;
  /** Did the left button deliver its `pointerdown` to us? ⇒ is `downX/downY` usable? */
  let sawLeftDown = false;
  /**
   * Did the press start on the control bar? With the bar drawn INTO the map canvas there is no
   * element left that swallows `pointerdown` for it, so dragging away from a bar button would grab
   * the map. The original cannot have this problem — it has no drag — and it scrolls only from the
   * map area (`FUN_0000d630`).
   */
  let downOnBar = false;
  /** Is a **left drag** running (touchpad pan, addition)? See `onPointerMove`. */
  let leftDragging = false;
  /** The viewport itself — for the imperatively attached `click` listener (reasoning there). */
  let viewportEl = $state<HTMLDivElement | null>(null);
  /** Up to this client pixel distance a left press still counts as a click. */
  const DRAG_THRESHOLD = 5;
  /** Press point of the right button (for "clicked rather than dragged") + time of the last click. */
  let rightDownX = 0;
  let rightDownY = 0;
  let lastRightClick = 0;
  /**
   * The original's double-click window in milliseconds. `vp[0x9e]` is set to **12** on the first
   * right click and decremented per frame (≈12.5 fps ⇒ 80 ms); the second click counts at
   * `vp[0x9e] != 0 && vp[0x9e] < 10` — so **after** 2 and **before** 12 frames.
   */
  const DOUBLE_CLICK_MIN_MS = 2 * 80;
  const DOUBLE_CLICK_MAX_MS = 12 * 80;

  /**
   * **Touch: the phases of the surface** (addition — the original knows no touchscreen).
   *
   * One finger keeps behaving like the left button: tap = click, drag = grab pan. On top of that sit
   * the two gestures a tablet has no other way to reach — the two-finger pinch, which the browser
   * would otherwise spend on zooming the *page*, and the long press, the only substitute left for
   * the special click where there is neither a right button nor a keyboard.
   *
   * The phase machine is in `touch-gesture.ts` and takes no part in the reactivity: it is read and
   * written at pointer-move rate. Coordinates handed to it are `offsetX/offsetY`, element pixels —
   * that is what the pinch anchor needs, and it costs no layout.
   */
  let touch = TOUCH_IDLE;
  /**
   * The pointer whose press started the running drag — pan and capture belong to it alone. Without
   * it the second finger of a pinch pulls the map by the whole distance between the fingers: on
   * touch every finger reports `button 0`, so nothing else in the handlers tells them apart.
   */
  let dragPointerId: number | null = null;
  /** Runs while a long press is pending; whether it is really due decides the reducer. */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * What the pinch grabbed at its start: the scene point under the first midpoint, plus zoom and
   * finger distance of that moment. The camera is recomputed from it **absolutely** on every move,
   * so the rounding cannot accumulate and the gesture is exactly reversible.
   */
  let pinchStart: { zoom: number; dist: number; sceneX: number; sceneY: number } | null = null;

  /**
   * **Autoplay gesture**: an `AudioContext` may only run after a user gesture. The first grab on the
   * map is one — hence no separate "sound on" control is needed. Repeated calls are harmless.
   *
   * Both players need this, for different reasons: the effect player creates its context here, the
   * music player noted its start wish when the tick was set and can only honour it now. Hence one
   * place for both instead of two calls that can drift apart.
   */
  function resumeAudio(): void {
    void sfxPlayer?.resume();
    if (uiMusic) void musicPlayer?.start();
  }

  /** A capture is given back only while it is still ours — `pointercancel` has already taken it. */
  function releaseCapture(el: HTMLElement | null, id: number): void {
    if (el !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id);
  }

  /** Ends a running drag, whichever button or finger started it. */
  function endDrag(el: HTMLElement | null): void {
    if (dragPointerId !== null) releaseCapture(el, dragPointerId);
    dragPointerId = null;
    dragMode = null;
    leftDragging = false;
  }

  function clearHold(): void {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  }

  /**
   * **Long press = special click** (see {@link isSpecialModifier}). `TOUCH_HOLD_MS` is the measure
   * of the system for a second action; the original has no holding at all.
   *
   * It fires while the finger is still down, not when it lifts: that puts the answer at the moment
   * of the gesture, and it makes us independent of the question whether the browser still delivers a
   * `click` after a long press whose context menu we suppressed. Either way the trailing click is
   * swallowed by the `spent` phase.
   *
   * The timer needs no cancelling when the press dies (travel, second finger): the reducer answers
   * `null` and nothing happens.
   */
  function armHold(): void {
    clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      const r = touchTick(touch, performance.now(), TOUCH_HOLD_MS);
      touch = r.state;
      if (r.outcome?.kind !== 'hold') return;
      endDrag(viewportEl);
      // The press point is the one the left-button branch recorded — client coordinates, which is
      // what the dispatcher takes.
      dispatchClickAt(downX, downY, true);
    }, TOUCH_HOLD_MS);
  }

  /** Grabs the scene point under the first midpoint; a running drag has to give way. */
  function beginPinch(o: { dist: number; midX: number; midY: number }, el: HTMLElement | null): void {
    clearHold();
    endDrag(el);
    sawLeftDown = false;
    downOnBar = false;
    panRestX = 0;
    panRestY = 0;
    pinchStart = {
      zoom,
      dist: o.dist,
      sceneX: scenePoint(camX, zoom, o.midX),
      sceneY: scenePoint(camY, zoom, o.midY),
    };
  }

  /**
   * Zoom **and** two-finger pan in one step: the scene point grabbed at the start goes back under
   * the current midpoint. `minZoom` is read live rather than snapshotted — the URL bar of a tablet
   * browser and a rotation both change the window in the middle of a gesture.
   *
   * Not gated on `mapAcceptsClicks` or on the bar, exactly like the wheel: the zoom is a display
   * addition and stays available with a popup open. The pan is gated, because there the original has
   * a say (`FUN_0000d630` bails out on a modal popup).
   */
  function applyPinch(o: { dist: number; midX: number; midY: number }): void {
    const start = pinchStart;
    if (start === null) return;
    const next = pinchZoom(start.zoom, start.dist, o.dist, minZoom, ZOOM_MAX);
    camX = anchorCamera(start.sceneX, next, o.midX);
    camY = anchorCamera(start.sceneY, next, o.midY);
    zoom = next;
  }

  function onPointerDown(e: PointerEvent) {
    resumeAudio();
    if (e.pointerType === 'touch') {
      // The very first thing in the handler: two fingers landing in the same frame deliver two
      // `pointerdown`, and the second would otherwise overwrite the click ledger of the first.
      const r = touchDown(touch, e.pointerId, e.offsetX, e.offsetY, performance.now());
      touch = r.state;
      if (r.outcome?.kind === 'pinchStart') {
        beginPinch(r.outcome, e.currentTarget as HTMLElement);
        return;
      }
      // Only a single finger goes on as a left button. Anything else is a further finger or the tail
      // of a gesture, and must not touch the ledger.
      if (r.outcome?.kind === 'holdArmed') armHold();
      else return;
    } else if (touch.phase === 'spent' && touch.down === 0) {
      // A mouse on the same device must not run into the tail of a touch gesture.
      touch = TOUCH_IDLE;
    }
    // Right button (button 2) = original pan. `FUN_0000d630` bails out immediately when `vp[1]`
    // bit 1 is clear — so with a popup open nothing scrolls either. Middle button (button 1) =
    // grab pan (addition); `preventDefault` suppresses the browser autoscroll.
    if (e.button === 2 || e.button === 1) {
      if (e.button === 2) rightDown = true;
      // A press on the bar is not a map drag (see `downOnBar`). The right button still counts as
      // held: that posture IS the special click, and it belongs to the bar button underneath.
      if (barPixel(e.clientX, e.clientY) !== null) return;
      if (!mapAcceptsClicks) return;
      if (e.button === 1) e.preventDefault();
      dragMode = e.button === 2 ? 'push' : 'grab';
      if (e.button === 2) {
        rightDownX = e.clientX;
        rightDownY = e.clientY;
      }
      lastX = e.clientX;
      lastY = e.clientY;
      panRestX = 0;
      panRestY = 0;
      dragPointerId = e.pointerId;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    // Left button: click candidate. `e.buttons` bit 1 = right button held at the same time.
    sawLeftDown = true;
    downOnBar = barPixel(e.clientX, e.clientY) !== null;
    downSpecial = isSpecialModifier(e);
    downX = e.clientX;
    downY = e.clientY;
  }

  /**
   * **Substitute special click for pointing devices without a right button** (addition, not in the
   * original).
   *
   * The original knows exactly one form: left button while the right one is held (`vp[1]` bit 3). On
   * a touchpad that is hard to perform, and on macOS/Safari the system already claims Ctrl+click for
   * the context menu (the browser reports it as `button 2`, so the original way works there anyway).
   * Free — and therefore collision-free — are **Shift** and **Alt**: the map area evaluates no other
   * keys, and neither has a meaning in the original.
   *
   * Deliberately NOT the left double click: that is taken by the fast build click
   * (`viewOptions` bit 2).
   *
   * On a touchscreen none of these exists — no right button, no keyboard. There the substitute is
   * the **long press** ({@link armHold}), which goes through the same dispatcher.
   */
  function isSpecialModifier(e: MouseEvent): boolean {
    return (e.buttons & 2) !== 0 || e.shiftKey || e.altKey;
  }
  function onPointerMove(e: PointerEvent) {
    // Pointer position for the screen recording. `offsetX/offsetY` and not a measured rectangle:
    // the canvas fills the viewport 1:1, so this is already the canvas pixel — and it costs no
    // layout, which matters at pointer-move rate. Only the primary pointer: with two fingers the
    // recorded cursor would otherwise jump back and forth between them.
    if (e.isPrimary) {
      pointerCanvasX = e.offsetX;
      pointerCanvasY = e.offsetY;
      pointerInside = true;
    }
    if (e.pointerType === 'touch') {
      const r = touchMove(touch, e.pointerId, e.offsetX, e.offsetY, DRAG_THRESHOLD);
      touch = r.state;
      if (r.outcome?.kind === 'pinch') {
        applyPinch(r.outcome);
        return;
      }
      // While pinching (a further finger) and in the tail of a gesture nothing pans.
      if (touch.phase === 'pinch' || touch.phase === 'spent') return;
    }
    // **Left drag pans the map** (addition for touchpads, not in the original).
    //
    // Why this is collision-free — proven, not assumed: a left drag past the 5 px threshold is
    // already DISCARDED today (`if (!mapAcceptsClicks || dragged) return;` in the click
    // dispatcher). Direction is `'grab'` like the middle button — on a touchpad one drags the
    // content along, not away.
    if (dragMode === null && sawLeftDown && !downOnBar && (e.buttons & 1) !== 0 && mapAcceptsClicks) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) >= DRAG_THRESHOLD) {
        dragMode = 'grab';
        leftDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        panRestX = 0;
        panRestY = 0;
        dragPointerId = e.pointerId;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
    }
    // The pan belongs to the pointer that started it — see {@link dragPointerId}.
    if (dragMode !== null && dragPointerId === e.pointerId) {
      // **Original direction (`'push'`): the map is PUSHED AWAY, not grabbed** — on both axes.
      // Byte-proven: the input layer adds the raw mouse delta unchanged into the accumulator
      // (`vp[0x10] += dx`, `vp[0x12] += dy` @0x624f5/0x62500) and uses the SAME delta without
      // negation for the pointer position when not scrolling (@0x6235a ff.) ⇒ positive dx provably
      // means "to the right". `FUN_0000d630` then negates the column step at dx ≥ 0 (@0xd88e), the
      // row step at dy ≥ 0 (@0xd8af) and subtracts both from the origin (@0xd8d6 · @0xd8e2/0xd8ed).
      // Sign: `'push'` follows the pointer (original), `'grab'` runs against it. Speed: only the
      // original pan is stretched by {@link pushPanGain}; the remainder stays sub-pixel exact so
      // slow dragging is not swallowed (same role as `vp[0x10]/[0x12]`).
      const s = dragMode === 'push' ? pushPanGain : -1;
      const dx = (s * (e.clientX - lastX)) / zoom + panRestX;
      const dy = (s * (e.clientY - lastY)) / zoom + panRestY;
      const stepX = Math.trunc(dx);
      const stepY = Math.trunc(dy);
      panRestX = dx - stepX;
      panRestY = dy - stepY;
      camX += stepX;
      camY += stepY;
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    // Deliberately NO hit test here: it costs `getBoundingClientRect` (forces layout) plus
    // `windowToTile` on EVERY mouse move, and nothing reads the result. A hover display belongs
    // here and would have to pay that.
  }
  /**
   * Where the pointer is, in canvas pixels — kept only for the screen recording, which has to draw
   * the pointer itself (a CSS cursor is not part of the canvas). `pointerInside` is false while it
   * is outside the window, and then no pointer is drawn.
   */
  let pointerCanvasX = 0;
  let pointerCanvasY = 0;
  let pointerInside = false;

  function onPointerUp(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      const r = touchUp(touch, e.pointerId);
      touch = r.state;
      if (r.outcome?.kind === 'ended') pinchStart = null;
      clearHold();
      if (touch.phase === 'spent') {
        // Tail of a gesture: nothing pans, and the `click` that follows is swallowed in `onClick`.
        endDrag(e.currentTarget as HTMLElement);
        return;
      }
    }
    if (e.button === 2 || e.button === 1) {
      if (e.button === 2) rightDown = false;
      endDrag(e.currentTarget as HTMLElement);
      // Right *clicked* (not dragged) ⇒ double-click detection like `vp[1]` bit 4/5 + `vp[0x9e]`:
      // the second click within the window triggers the fast map click (option `vp[0x86]` bit 1).
      if (e.button === 2 && Math.hypot(e.clientX - rightDownX, e.clientY - rightDownY) < DRAG_THRESHOLD) {
        const now = performance.now();
        const dt = now - lastRightClick;
        if (dt >= DOUBLE_CLICK_MIN_MS && dt <= DOUBLE_CLICK_MAX_MS) {
          lastRightClick = 0;
          if (fastMapClickEnabled) fastMapClick();
        } else {
          lastRightClick = now;
        }
      }
      return;
    }
    // Left button released: end a running left drag. The click is still suppressed by the 5 px
    // threshold in the click dispatcher — nothing extra to do here.
    if (e.button === 0 && leftDragging && dragPointerId === e.pointerId) {
      endDrag(e.currentTarget as HTMLElement);
    }
  }

  /**
   * `pointercancel` — the system took the touch away (switching apps, too many fingers). It carries
   * `button === -1`, so none of the branches above sees it, and the capture is already gone.
   */
  function onPointerCancel(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      touch = touchUp(touch, e.pointerId).state;
      if (touch.phase !== 'pinch') pinchStart = null;
    }
    clearHold();
    if (dragPointerId === e.pointerId) endDrag(e.currentTarget as HTMLElement);
  }

  /**
   * **Map click on the `click` event** — not on the left button's `pointerup`.
   *
   * If the user holds the right button for the special click, its `pointerdown` has already called
   * `setPointerCapture()`; the left button's `pointerdown`/`pointerup` pair then never reaches our
   * handlers, so both the special-click state and the press point for the drag threshold were
   * missing and the click expired silently. The `click` event does arrive and carries the still held
   * right button in `e.buttons`.
   *
   * No drag detection is needed here: a `click` only arises when the left button was pressed AND
   * released — a pure pan grip (right/middle button) produces none.
   */
  /**
   * The `click` listener hangs on the viewport **imperatively**, not as an `onclick` attribute: the
   * a11y rules demand a keyboard twin for `click` on a non-interactive element. A pure pointer
   * surface (drag, zoom, key combination) has no sensible keyboard counterpart, and an empty handler
   * merely to silence the warning would be a sham. The gestures are in the viewport's `aria-label`.
   */
  $effect(() => {
    const el = viewportEl;
    if (el === null) return;
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  });

  /**
   * **WebKit ignores `touch-action` for the pinch.** There the page would keep zooming although our
   * own pointer handlers work fine; the counter is `preventDefault` on the non-standard `gesture*`
   * events. They are absent from the DOM typings, hence imperatively and with `passive: false`.
   *
   * Its limit, plainly: on engines that honour `touch-action` these events never fire, so there this
   * is dead weight — and on WebKit it cannot be checked from here.
   */
  $effect(() => {
    const el = viewportEl;
    if (el === null) return;
    const stop = (ev: Event) => ev.preventDefault();
    const names = ['gesturestart', 'gesturechange', 'gestureend'];
    for (const name of names) el.addEventListener(name, stop, { passive: false });
    return () => {
      for (const name of names) el.removeEventListener(name, stop);
    };
  });

  /** A pending long press must not fire into a component that is already gone. */
  $effect(() => () => clearHold());

  function onClick(e: MouseEvent): void {
    // Autoplay gesture here as well — every click of the game screen arrives here, bar and popup
    // included: there is one canvas and therefore one dispatcher, as in the original.
    resumeAudio();
    // Tail of a touch gesture: a pinch or a long press has already had its say. The phase holds
    // until the next fresh press, because this click arrives AFTER the last finger has left.
    if (touch.phase === 'spent') {
      sawLeftDown = false;
      downSpecial = false;
      downOnBar = false;
      return;
    }
    const special = downSpecial || rightDown || isSpecialModifier(e);
    const dragged = sawLeftDown && Math.hypot(e.clientX - downX, e.clientY - downY) >= DRAG_THRESHOLD;
    sawLeftDown = false;
    downSpecial = false;
    downOnBar = false;
    // A left drag past the threshold is no click — not on the bar, not in the popup, not on the map.
    if (dragged) return;
    dispatchClickAt(e.clientX, e.clientY, special);
  }

  /**
   * **The one click dispatcher of the game screen**, addressed by client coordinates.
   *
   * Not by an event, because the long press has none: it fires from a timer while the finger is
   * still down ({@link armHold}). Going through here is what makes the special click of a touch
   * device take exactly the path of a mouse one — bar, popup and map keep every context rule.
   *
   * **Bar first, then popup, then map** — the y split of the original dispatcher (`FUN_000272d7`:
   * `y >= vp[0x30]` = 440 is the bar). The bar stands BEFORE `mapAcceptsClicks`, because it stays
   * usable with a popup open (own branch).
   */
  function dispatchClickAt(clientX: number, clientY: number, special: boolean): void {
    const onBar = barPixel(clientX, clientY);
    if (onBar !== null) {
      handleBarClick(onBar.x, onBar.y, special);
      return;
    }
    // With a popup open the map takes no clicks (`vp[1]` bit 1 clear). The click goes into the popup
    // router — and expires there even when it lands outside the popup rectangle, which is exactly
    // what @0x2bff7 does after subtracting the anchor.
    const slot = openPopupSlot;
    if (slot !== null) {
      const p = slotPixel(clientX, clientY, POPUP_BOUNDS, POPUP_W, POPUP_H);
      if (p !== null) dispatchPopupClick(slot, p.x, p.y, special);
      return;
    }
    const el = viewportEl;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const t = windowToTile(
      (clientX - rect.left) / zoom,
      (clientY - rect.top) / zoom,
      camera,
      geo,
      heightAt,
      heightUnit,
    );
    // The element pixels come along: the road-building edge scroll checks the click PIXELS against
    // the border of the map area, not the tile.
    mapClick(t.col, t.row, special, clientX - rect.left, clientY - rect.top);
  }

  /**
   * **Edge scroll during road building** — the mask from the click tail (`roadEdgeScroll`,
   * `@0x2ad55`ff) and the consumer turning it into tiles (`scrollCenterTileByEdgeMask`, `@0xd64e`ff).
   * Every direction hit enqueues sound **6**.
   *
   * **The pixel threshold has to be transferred, not copied.** The original checks 24 px from the
   * left/right and 40 px from the top/bottom edge of its **608 × 432** map area ({@link MAP_AREA}).
   * Our window is arbitrarily large, so a fixed pixel count would be a quite different share — at
   * 1600 px width a band of 1.5 % instead of 3.9 %. Hence the click is mapped into the original area.
   *
   * **Two deliberate deviations**, both without observable difference in single-window operation:
   * the original ADDS into `vp+0xd8` (`addw $0x1/$0x2/$0x4/$0x8`, not `or`) and consumes the mask
   * only at the frame boundary, so two clicks in one frame could merge into a direction neither
   * wanted; we evaluate per click. The sound stays identical because the sound queue merges equal
   * numbers.
   */
  function applyRoadEdgeScroll(px: number, py: number): void {
    // `bt $0x0` on `vp[0x86]` @0x2ad67 (click) and @0xd670 (consumer) — the same bit checked twice;
    // once is enough here.
    if (!hasViewOption(engineState, 0, VIEW_OPTION_ROAD_SCROLL)) return;
    if (viewportW <= 0 || viewportH <= 0) return;
    const mask = roadEdgeScroll(
      MAP_AREA.x + (px / viewportW) * MAP_AREA.width,
      MAP_AREA.y + (py / viewportH) * MAP_AREA.height,
      MAP_AREA.width,
      MAP_AREA.height,
    );
    if (mask === 0) return;
    for (const bit of [1, 2, 4, 8]) if ((mask & bit) !== 0) playUiSound(SOUND_EDGE_SCROLL);
    const center = cameraCenterTile(camera, geo, heightAt, heightUnit);
    const next = scrollCenterTileByEdgeMask(center, mask, geo);
    const cam = cameraCenteredOnTile(next.col, next.row, viewportW / zoom, viewportH / zoom);
    camX = cam.originX;
    camY = cam.originY;
  }

  /**
   * Map click as in the original (map branch of `FUN_000272d7`, @0x29d84 ff.):
   *
   * ```
   * if (!fastBuildClick || col != cursorCol || row != cursorRow) {
   *    player[0xfc] = col; player[0xfe] = row; vp[1] |= 4;   // set cursor + dirty bit
   *    if (!special) return;
   *    // special click: FALL-THROUGH into the screen selection
   * } else if (!special) {
   *    return FUN_000273d6(vreg0 = 0);                       // fast build click = slot 0 icon
   * }
   * ```
   *
   * The cursor is therefore set on a special click as well (the original writes it before falling
   * through), and the fast build click only takes effect on the ALREADY selected tile.
   */
  function mapClick(
    col: number,
    row: number,
    special: boolean,
    px: number,
    py: number,
  ): void {
    // **Road building takes precedence** — `bt $0x7,%ax ; jne 0x2a63c` @0x29edb, so before setting
    // the cursor and before the fast build click.
    if (roadBuild().active) {
      const player = engineState.players[buildPlayer];
      if (!player || !player.active) return;
      // Through the command layer so the click appears in the action log — `applyRoadBuildClick` is
      // the same operation as `applyCommand`, only with sound and session information.
      const res = runRoadClick({ kind: 'roadBuildClick', col, row, player: buildPlayer, special });
      // Sound 2 finished · 8 segment appended/taken back · 4 rejected; `null` on a no-op direction
      // (`jne 0x2ae59` — no neighbour tile, so no attempted action).
      if (res.sound !== null) playUiSound(res.sound);
      applyRoadEdgeScroll(px, py);
      selected = { col: player.cursorCol, row: player.cursorRow };
      syncRoadView();
      refreshContextIcons(player.cursorCol, player.cursorRow);
      if (!roadBuild().active) barIcons = [barIcons[0], barIcons[1], ...ROAD_BAR_ICONS_LEAVE];
      // Every segment writes `landscape[0]` of both tiles (as the original does) ⇒ the retained
      // ground/road surface is stale. Without `map = true` the road would appear only once
      // something else changes `surfaceVersion`.
      markEngineMutated(true);
      // The mode swallows EVERY map click (as the original does) and replaces the two left bar
      // icons. Hence the status line always says that road building is running and how to leave it;
      // otherwise an accidentally started mode looks like "the map takes no more clicks".
      note(
        res.finished
          ? 'road built.'
          : res.sound === 4
            ? `road building: no way through here (${roadBuild().segments} segments; the left panel icon cancels).`
            : `road building: ${roadBuild().segments} segments — click a neighbouring tile, the left panel icon cancels.`,
      );
      return;
    }
    const same = selected !== null && selected.col === col && selected.row === row;
    if (!fastBuildClick || !same) {
      selected = { col, row };
      refreshContextIcons(col, row);
      if (!special) {
        // The PLAIN map click sounds (`mov $0x8` @0x29fbc), unless game type 4 has set the gate
        // `gs+0x37e` bit 5. A special click falls through here and sounds NOT — opening a window
        // from the map is silent in the original.
        if (!plainMapClickSilent(engineState.header.gameType)) playUiSound(UI_SOUND_PANEL_BUTTON);
        return;
      }
    } else if (!special) {
      // In spectator mode the fast build click ends as a bare `ret` (`bt $0x5` @0x29f45,
      // `je 0x29f52`) instead of calling `control_bar_slot_click(0)` @0x273d6. Silent, as in the
      // original.
      if (isSpectatorGame(engineState.header.gameType)) return;
      // Fast build click (option `vp[0x86]` bit 2): a second click on the cursor acts like a click
      // on the left bar icon.
      const icon = barIcons[0];
      const action = icon === undefined ? null : CONTROL_PANEL_BUTTON_ACTIONS.get(icon);
      if (action === undefined || action === null) {
        note('fast build click: the left panel icon has no action here.');
        return;
      }
      // The original calls `control_bar_slot_click(slot 0)` here — the SAME routine as a real bar
      // click, including its icon sound (see `CONTROL_BAR_SOUND_ICONS`).
      if (CONTROL_BAR_SOUND_ICONS.has(icon)) playUiSound(UI_SOUND_PANEL_BUTTON);
      runPanelAction(action, 0);
      return;
    }
    // --- special click on the map ---------------------------------------------------------------
    const tile = engineState.mapTiles[posOf(col, row, geo)];
    if (tile === undefined) return;
    const object = tile.object;
    const building =
      object >= 2 && object <= 4 ? (entityIndex.building.get(tile.objIndex) ?? null) : null;
    // The spectator may look into ANY building: the original skips the owner check (`bt $0x5`
    // @0x2a042 ⇒ `jne 0x2a073` for the building, @0x2a18f ⇒ `jne 0x2a1c0` for the flag). The
    // DIRECTION matters — otherwise a foreign building leads into the attack path (@0x2a2f6).
    const owned =
      isSpectatorGame(engineState.header.gameType) ||
      (object === 1
        ? tile.owner === buildPlayer + 1
        : building !== null && building.owner === buildPlayer);
    const screen = mapSpecialClickScreen(
      object,
      building === null
        ? null
        : { type: building.type, constructing: building.constructing, active: building.active },
      owned,
    );
    if (screen === null) {
      note('special click: there is no menu here.');
      return;
    }
    if (screen === 0x14) {
      // The attack branch goes its own way: it writes `player+0x134` (the target), checks three
      // conditions and collects the attackers. If one fails, the original only plays an error sound
      // and opens nothing.
      const attacker = engineState.players[buildPlayer];
      // `&buildings[game[pos] · 0x12]` — the original reaches into the building record, not the
      // render view.
      const target = engineState.buildings[tile.objIndex];
      if (attacker === null || attacker === undefined || target === null || target === undefined) return;
      const prep = runAttackPrepare({ kind: 'prepareAttack', col, row, player: buildPlayer });
      // Of the four failures **one is silent** (`notAttackable` ⇒ bare `ret` @0x2a459); the other
      // three fall onto the same reject tail @0x2a62d. Success sounds **8**.
      if (prep.sound !== null) playUiSound(prep.sound);
      if (!prep.ok) {
        note(ATTACK_PREP_NOTES[prep.reason]);
        return;
      }
      openScreen(0x14);
      note(`attack: ${prep.available} knights available, ${prep.suggestion} suggested.`);
      return;
    }
    // `player+0x176 = game[pos]` — the object index of the clicked tile (flag or building).
    //
    // @0x2a1e6 — the original has TWO branches here and we need one: in spectator mode
    // (`bt $0x5,gs+0x37e`) it writes the index into all four player blocks (@0x2a1f2..@0x2a266),
    // otherwise only into the running one (@0x2a26b). The point of the fourfold write is that the
    // window shows the same object after a player switch.
    //
    // This port keeps `objectSubject` **per viewport** rather than per player, which is equivalent:
    // a variable the switch does not touch has the same value for every player, and that is exactly
    // what the original establishes with four identical stores.
    objectSubject = tile.objIndex;
    objectSubjectPos = { col, row };
    note(openScreen(screen)
      ? `special click → ${SPECIAL_SCREEN_NAMES[screen] ?? `screen ${screen}`}`
      : `special click → screen 0x${screen.toString(16)} (${SPECIAL_SCREEN_NAMES[screen] ?? '?'}) is not ported yet.`);
  }
  function onPointerLeave() {
    // No pointer in the picture once it has left the window (see `pointerInside`).
    pointerInside = false;
  }
  /**
   * Mouse wheel and touchpad pinch (`wheelZoomFactor`); `preventDefault` keeps the page zoom away.
   * A pinch on a real touchscreen does NOT arrive here — it comes as pointer events
   * ({@link applyPinch}).
   */
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    // Lower bound: whole world in frame — below that only repetition would follow.
    const next = Math.max(minZoom, Math.min(ZOOM_MAX, zoom * wheelZoomFactor(e)));
    // Zoom around the cursor: the scene point under the pointer stays put.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    camX = anchorCamera(scenePoint(camX, zoom, mx), next, mx);
    camY = anchorCamera(scenePoint(camY, zoom, my), next, my);
    zoom = next;
  }
</script>

<section class="map">
  <!-- `application` is the right role here and the rule below does not know it: the game screen is
       a canvas that handles mouse and keyboard itself, and the role is what tells a screen reader to
       pass the keys through rather than read the page. The rule only knows the widget roles and
       would have us put a button here. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="viewport"
    bind:this={viewportEl}
    bind:clientWidth={viewportW}
    bind:clientHeight={viewportH}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
    onpointerleave={onPointerLeave}
    onwheel={onWheel}
    oncontextmenu={(e) => e.preventDefault()}
    style:cursor={cursorStyle}
    role="application"
    tabindex="-1"
    aria-label={popupLabel}
  >
    <!-- **The whole game screen is this one canvas.** Bar and popup are not elements of their own
         but are blitted into it, as in the original, which has a single framebuffer: `renderMapFrame`
         draws the map, `composeUiOverlay` puts the parts on top. That is what makes a screenshot and
         a screen recording show the game rather than just the map, and it puts the stacking order
         into the code instead of into the document order. -->
    <canvas bind:this={host}></canvas>
    <!-- Where the keys of the save-game name really arrive: the canvas cannot take a focus, so on a
         phone it cannot bring up a keyboard. -->
    <TextEntryField
      bind:this={entryField}
      active={disk?.nameInput != null}
      onkey={runDiskKey}
    />
    <!-- Our own readout, and the one thing to know about it: it is a DOM layer, so it is NOT in a
         screenshot or a screen recording, which see the canvas alone. It sits before the end
         credits so that those, which take the whole stage, cover it. -->
    <StockOverlay
      view={stockView}
      corner={settings.value.stockCorner}
      opacity={settings.value.stockOpacity}
      perRow={settings.value.stockPerRow}
      scale={uiScale}
    />
    {#if showEndCredits && archive !== null}
      <!-- The end credits (`run_end_credits` @0x38b55): a full-screen sequence on a 352 × 240 surface
           of its own, not abortable, about 75 seconds. It covers the whole game screen because the
           original paints over it with `fill_rect(0, 0, 0x160, 0xf0, 0)`.
           The one part that stays a DOM overlay: it is not a popup IN the game screen but a screen of
           its own, with a clock of its own, and it takes the whole stage — `EndCreditsView` fits
           itself to the window. -->
      <div
        class="stage-box"
        role="dialog"
        tabindex="-1"
        aria-label={st('view.endCredits')}
        onpointerdown={(e) => e.stopPropagation()}
        onpointerup={(e) => e.stopPropagation()}
      >
        <EndCreditsView {archive} onfinished={leaveMissionEnd} music={musicPlayer} volume={uiVolume} />
      </div>
    {/if}
  </div>

</section>

<style>
  /* A screen of its own rather than a popup: it takes the whole stage. Black because the original
     paints the area with colour 0 — and so the map does not show through between mounting and the
     first drawn frame. */
  .stage-box {
    position: absolute;
    inset: 0;
    line-height: 0;
    background: #000;
  }
  /* The map IS the page: it fills the shell stage completely. */
  .map {
    height: 100%;
  }
  .viewport {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #0c0c0c;
    cursor: grab;
    touch-action: none;
  }
  .viewport:active {
    cursor: grabbing;
  }
  /*
   * No focus ring: the viewport is the whole playing field, not one control among several. The
   * keyboard focus while a name is typed sits on the entry field, not here.
   */
  .viewport:focus,
  .viewport:focus-visible {
    outline: none;
  }
  canvas {
    display: block;
    image-rendering: pixelated;
  }
</style>
