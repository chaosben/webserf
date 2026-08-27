<script lang="ts">
  /**
   * The main menu — interaction layer around `core/main-menu.ts`.
   *
   * Drawn natively onto a 352 × 240 surface and shown scaled as a whole: the original draws the
   * menu in that set, while the rest of the ported UI belongs to 640 × 480. The sprites are drawn
   * for 352 and did not fit converted.
   *
   * There is exactly ONE scale ({@link scale}) — the drawn one. Canvas, hit test and mouse cursor
   * all hang on it; the click computes back through the displayed rectangle and does not know the
   * zoom.
   */
  import { untrack } from 'svelte';
  import { log } from '../shell/log.js';
  import { settings } from '../settings/settings.svelte.js';
  import { PaArchive } from '../core/pa-parser.js';
  import { decodeSprite } from '../core/sprite-decoder.js';
  import {
    GLYPH_ENTRY,
    blitSprite,
    clearFramebuffer,
    createFramebuffer,
    drawScreenChromeSmall,
    fillRect,
  } from '../core/ui-render.js';
  import {
    OPTIONS_SCREENS,
    clickMenuPopup,
    drawMenuPopup,
    type OptionsPopupView,
  } from '../core/options-popup.js';
  import {
    cycleMessageLevel,
    stepVolume,
    toggleOption,
  } from '../core/engine/view-options.js';
  import {
    GAME_TYPE_LEVEL,
    GAME_TYPE_MISSION,
    MENU_KEY_BACKSPACE,
    MENU_KEY_COMMIT,
    MENU_KEY_CURSOR_LEFT,
    MENU_KEY_CURSOR_RIGHT,
    MENU_KEY_DELETE,
    MENU_PANEL_ICON_IDLE,
    MENU_PANEL_ICON_PREVIEW,
    MENU_SURFACE,
    applyMainMenuAction,
    applyMainMenuKey,
    drawMainMenu,
    hitTestMainMenu,
    mainMenuCommands,
    drawMapGenProgress,
    menuPanelIcons,
    startMainMenu,
    traitValueFromClick,
    type CampaignProgress,
    type MainMenuState,
    type MenuTarget,
  } from '../core/main-menu.js';
  import { fitScale, pinchZoom, wheelZoomFactor } from './zoom-gesture.js';
  import { TOUCH_IDLE, touchDown, touchMove, touchUp } from './touch-gesture.js';
  import {
    CREDITS_PALETTE_ENTRY,
    CREDITS_STEPS,
    advanceCredits,
    drawCredits,
    initialCreditsState,
    type CreditsState,
  } from '../core/credits.js';
  import { musicShouldPlay } from '../core/music.js';
  import { MusicPlayer } from './music-player.js';
  import {
    createSoundMixer,
    createSoundQueue,
    enqueueSound,
    serviceSound,
    tickSoundVoices,
  } from '../core/sound.js';
  import { UI_SOUND_PANEL_BUTTON } from '../core/ui-sound.js';
  import { SfxPlayer } from './sfx-player.js';
  import { darkenPalette, parseInArchivePalette } from '../core/pal-parser.js';
  import { SETUP_RECORDS } from '../core/player-setup.js';
  import { Rng } from '../core/engine/rng.js';
  import { CURSOR_MAX_SCALE, CURSOR_SPRITE_INDEX, buildCursorStyle } from './mouse-cursor.js';
  import {
    DISK_RESULT,
    DISK_SCREENS,
    DISK_SCREEN_ARCHIV,
    DISK_SCREEN_LIST,
    DISK_SCREEN_LIST_REDRAW,
    DISK_SCREEN_RESULT,
    applyDiskMenuAction,
    applyDiskMenuKey,
    clickDiskMenuPopup,
    completeDiskOperation,
    drawDiskMenuPopup,
    enterDiskMenu,
    DISK_SLOT_BAR_COLOR_INDEX,
    type DiskMenuState,
  } from '../core/disk-menu.js';
  import { parseSaveGame } from '../core/save-parser.js';
  import type { SaveStore } from '../core/save-store.js';
  import type { DecodedSprite, Palette, SaveGameState } from '../core/types.js';

  let {
    archive = null,
    palette = null,
    onstart,
    intro = true,
    onintroend,
    mapGenProgress = null,
    store = null,
    onload,
    campaign = null,
  }: {
    archive?: PaArchive | null;
    palette?: Palette | null;
    /** Called with the menu state when START was pressed. */
    onstart?: (state: MainMenuState) => void;
    /** Show the opening credits? Off once they have run — the page keeps that (`false` = straight into the menu). */
    intro?: boolean;
    /** The credits are over (they end only by a click, see `handleClick`). */
    onintroend?: () => void;
    /**
     * Progress of the map generation in bar segments (0..40), `null` = nothing being generated. In
     * the original that is `gs+0x188`; whoever draws the bar is the same screen that started the
     * generation — hence the value comes from outside and not from this menu.
     */
    mapGenProgress?: number | null;
    /** The save storage (`core/save-store.ts`); `null` = not opened yet. */
    store?: SaveStore | null;
    /** A save is loaded — A39 → disk menu → "AUSFUEHREN". */
    onload?: (save: SaveGameState, bytes: Uint8Array) => void;
    /**
     * **The campaign progress brought along** (`gs+0x356`/`gs+0x358`/`gs+0x35a`), `null` = initial state.
     *
     * In the original these cells are global memory and survive leaving a game by themselves. This
     * component is rebuilt on return, so the initial value must come from outside; the page holds it.
     * It is read ONCE on construction — what the menu makes of it afterwards (A2/A3, typing a
     * password) is its own.
     *
     * Besides the two numbers it carries the password line (`gs+0x35a`): a won mission fills it with
     * the password of the next level, so the player can write it down. The spread below applies it,
     * which is why {@link CampaignProgress} leaves the key ABSENT when there is none.
     */
    campaign?: CampaignProgress | null;
  } = $props();

  /**
   * Own random stream for rolling the map: the original draws from the game RNG, which does not yet
   * exist here before the game starts. The seed passes on as a number anyway.
   */
  const menuRng = new Rng([0x0380, 0xeea7, 0x6b11]);

  /**
   * The original rolls the seed at program start — it is never `[0,0,0]`.
   *
   * `campaign` is applied **on construction** and ignored afterwards: an `$effect` copying the prop
   * into the state later would overwrite the user's level choice. That suffices because the page
   * rebuilds the component on every switch between game and menu.
   */
  let menu: MainMenuState = $state({
    ...startMainMenu(() => menuRng.next()),
    // `untrack` states the intent rather than silencing a warning: the initial value, exactly once.
    ...(untrack(() => campaign) ?? {}),
  });

  /**
   * Opening credits or menu. The chain runs once per program run — in the browser therefore per
   * page load and not every time this menu appears: leaving a game rebuilds the view, so a purely
   * local flag would be lost. Hence `intro` decides from outside and `introDone` only within one
   * lifetime.
   *
   * Not in between: the copy protection (`core/copy-protection.ts`) — read and checked, but
   * deliberately not wired up, because it is defused in the shipped binary.
   */
  let introDone = $state(false);
  let credits: CreditsState = $state(initialCreditsState());

  /**
   * Wall clock → credits ticks; no logic tick, the credits touch neither state nor randomness. The
   * 100 Hz are an assumption, proven is only the number of wait rounds (see `core/credits.ts`).
   */
  const CREDITS_TICK_MS = 10;
  /** Desired magnification; what of it is drawn stands in {@link scale}. */
  let zoom = $state(3);
  /** 0 means "not measured yet" ⇒ clip nothing. */
  let availWidth = $state(0);
  let availHeight = $state(0);
  let canvas: HTMLCanvasElement | null = $state(null);
  /**
   * The full area — the reference frame of the touch gestures, and the element that keeps the
   * browser's pinch away. Not the canvas: that one is only {@link MENU_SURFACE} × {@link scale}
   * large, so a finger beside it would never reach a handler, and zooming out would shrink it away
   * from under the fingers in the middle of the gesture.
   */
  let viewEl: HTMLDivElement | null = $state(null);

  /**
   * **Touch: the phases of the surface** (addition — the original knows no touchscreen). Only the
   * two-finger pinch is of interest here; the menu has no special click and therefore no long press,
   * and the tap is the ordinary click. Details of the machine: `touch-gesture.ts`.
   */
  let touch = TOUCH_IDLE;
  /** Zoom and finger distance at the start of the pinch — from the DRAWN scale, as {@link zoomBy}. */
  let pinchStart: { scale: number; dist: number } | null = null;
  /** Up to this travel a single finger still counts as standing still. */
  const TOUCH_MOVE_THRESHOLD = 5;

  /**
   * The open popup — `vp[0x70]` in the original, a field of the viewport and not menu state; hence
   * here and not in {@link MainMenuState}. `null` == none open.
   *
   * The `vp[1]` bit 1 cleared by A13 ("the background accepts no more clicks") is not a variable of
   * its own but falls out of `popupScreen !== null`.
   */
  let popupScreen: number | null = $state(null);

  /**
   * The disk menu (A39 "LOAD", screens 0x17..0x1a). It sits **beside** `popupScreen`, because it is
   * not an options screen and has its own state; it is open when neither is `null`.
   */
  let diskScreen: number | null = $state(null);
  let disk: DiskMenuState | null = $state(null);
  /** Is a file operation running? Prevents a second click on "AUSFUEHREN". */
  let diskBusy = false;

  /**
   * State of the options screen. In the original none of it is in the save game (all global, from
   * the configuration file) — which is why the menu can open it without a running game.
   *
   * Our configuration file is the settings store the map view reads as well. This view used to keep
   * its **own** set: what was set here was gone at game start because nobody read it.
   */
  const uiViewOptions = $derived(settings.value.viewOptions);
  const uiVolume = $derived(settings.value.volume);
  const uiMusic = $derived(settings.value.music);
  const uiSfx = $derived(settings.value.sfx);

  /** Text colour of the popup renderers — palette index 31, as in the map view. */
  const uiTextColor = $derived.by<readonly [number, number, number]>(() => {
    const pal = palette;
    if (pal === null) return [255, 255, 255];
    return [pal.rgba[31 * 4] ?? 0, pal.rgba[31 * 4 + 1] ?? 0, pal.rgba[31 * 4 + 2] ?? 0];
  });

  /** Colour of the slot list's selection bar (palette index 0x4c); without a palette no bar. */
  const diskBarColor = $derived.by<readonly [number, number, number] | null>(() => {
    const pal = palette;
    if (pal === null) return null;
    const o = DISK_SLOT_BAR_COLOR_INDEX * 4;
    return [pal.rgba[o] ?? 0, pal.rgba[o + 1] ?? 0, pal.rgba[o + 2] ?? 0];
  });

  const optionsView = $derived<OptionsPopupView>({
    viewOptions: uiViewOptions,
    volume: uiVolume,
    music: uiMusic,
    sfx: uiSfx,
  });

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 8;

  /**
   * The drawn scale: wish value, clipped to the surface. Both directions count — the stage clips
   * what does not fit, so too large a scale would cut off the menu edge. Free of feedback, because
   * `.menu-view` takes its size from its parent and not from its content.
   */
  const scale = $derived(fitScale(zoom, { width: availWidth, height: availHeight }, MENU_SURFACE));

  /**
   * Computes from the drawn scale, not from the wish value: otherwise `zoom` would run up to its
   * upper bound on a limited surface and zooming out would do nothing at first.
   */
  function zoomBy(factor: number): void {
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale * factor));
  }

  /** Sprite provider with cache; fresh on every change of archive or palette. */
  function makeProvider(
    pa: PaArchive,
    pal: Palette,
  ): (entry: number) => DecodedSprite | null {
    const cache = new Map<number, DecodedSprite | null>();
    return (entry: number): DecodedSprite | null => {
      const cached = cache.get(entry);
      if (cached !== undefined) return cached;
      let sprite: DecodedSprite | null = null;
      try {
        const raw = pa.getRaw(entry);
        if (raw !== null) sprite = decodeSprite(raw, pal, { physicalIndex: entry });
      } catch {
        // Empty or unreadable slot — pass over it as silently as the panel does.
      }
      cache.set(entry, sprite);
      return sprite;
    };
  }

  const provider = $derived.by<((entry: number) => DecodedSprite | null) | null>(() =>
    archive === null || palette === null ? null : makeProvider(archive, palette),
  );

  /**
   * The same provider on the **dimmed** palette — the RGBA substitute for the original's
   * `orl $0x80808080` (@0x4f221), by which the main menu shows that a loaded save is waiting for
   * confirmation. Two caches rather than recomputing per pixel: the menu sprites are a handful, and
   * a finished RGBA pixel no longer maps back to a unique palette index (see `MENU_DIM_BIT` in
   * `core/main-menu.ts`).
   */
  const dimProvider = $derived.by<((entry: number) => DecodedSprite | null) | null>(() =>
    archive === null || palette === null ? null : makeProvider(archive, darkenPalette(palette)),
  );

  /**
   * The opening credits run on their OWN palette (evidence in `core/credits.ts`). Under the game
   * palette the picture would match only 23.8 % of its pixels while frame and control bar still
   * fit — the fault would look plausible.
   */
  const creditsAssets = $derived.by<{
    provider: (entry: number) => DecodedSprite | null;
    palette: Palette;
  } | null>(() => {
    if (archive === null) return null;
    const raw = archive.getRaw(CREDITS_PALETTE_ENTRY);
    if (raw === null) return null;
    try {
      const pal = parseInArchivePalette(raw);
      return { provider: makeProvider(archive, pal), palette: pal };
    } catch {
      return null;
    }
  });

  /**
   * Derived rather than kept as its own state: without an archive there is nothing to show, so the
   * menu should stand still. An `$effect` that rewrites a phase would be a self-correcting state.
   */
  const showCredits = $derived(intro && !introDone && creditsAssets !== null);

  /**
   * The player columns come from the RAW bytes of the setup record: `SETUP_RECORDS` carries
   * `[face, supplies, intelligence, …]`, the menu reads the two middle ones the other way round.
   */
  const recordColumns = $derived.by(() => {
    if (menu.gameType > GAME_TYPE_MISSION) return { human: [0, 0] as const, players: [] };
    const idx =
      menu.gameType === GAME_TYPE_LEVEL ? menu.level + 5 : Math.max(menu.mission - 1, 0);
    const rec = SETUP_RECORDS[idx];
    if (rec === undefined) return { human: [0, 0] as const, players: [] };
    const human = [rec.players[0]?.[1] ?? 0, rec.players[0]?.[3] ?? 0] as const;
    const players = rec.players
      .slice(1)
      .map((p) => [p[0], p[2], p[1], p[3]] as readonly [number, number, number, number]);
    return { human, players };
  });

  const commands = $derived(
    mainMenuCommands(menu, recordColumns.human, recordColumns.players),
  );

  $effect(() => {
    const el = canvas;
    const draw = provider;
    const dimDraw = dimProvider;
    const pal = palette;
    const cmds = commands;
    const s = scale;
    const screen = popupScreen;
    const view = optionsView;
    const textColor = uiTextColor;
    const dScreen = diskScreen;
    const dState = disk;
    const dBar = diskBarColor;
    const cAssets = creditsAssets;
    const creditsStep = credits.step;
    const progress = mapGenProgress;
    if (el === null) return;
    const ctx = el.getContext('2d');
    if (ctx === null) return;

    // Fractional scales are allowed; the canvas itself needs whole pixels.
    el.width = Math.max(1, Math.round(MENU_SURFACE.width * s));
    el.height = Math.max(1, Math.round(MENU_SURFACE.height * s));
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, el.width, el.height);

    /** Show the finished 352 × 240 surface scaled — the zoom is pure display. */
    const present = (fb: ReturnType<typeof createFramebuffer>): void => {
      const surface = document.createElement('canvas');
      surface.width = MENU_SURFACE.width;
      surface.height = MENU_SURFACE.height;
      const sctx = surface.getContext('2d');
      if (sctx === null) return;
      const img = sctx.createImageData(fb.width, fb.height);
      img.data.set(fb.rgba);
      sctx.putImageData(img, 0, 0);
      ctx.drawImage(surface, 0, 0, el.width, el.height);
    };

    // The opening credits have their own palette and share only surface and chrome with the menu.
    if (showCredits) {
      if (cAssets === null) return;
      const { provider: cDraw, palette: cPal } = cAssets;
      const rgb = (color: number): [number, number, number] => [
        cPal.rgba[color * 4] ?? 0,
        cPal.rgba[color * 4 + 1] ?? 0,
        cPal.rgba[color * 4 + 2] ?? 0,
      ];
      const fb = createFramebuffer(MENU_SURFACE.width, MENU_SURFACE.height);
      clearFramebuffer(fb, 0, 0, 0);
      const cTarget: MenuTarget = {
        icon(entry, x, y) {
          const sprite = cDraw(entry);
          if (sprite !== null) blitSprite(fb, sprite, x, y);
        },
        glyph(entry, x, y, color) {
          const sprite = cDraw(entry);
          if (sprite !== null) blitSprite(fb, sprite, x, y, rgb(color));
        },
        fill(x, y, w, h, color) {
          fillRect(fb, x, y, w, h, rgb(color));
        },
      };
      drawScreenChromeSmall(fb, cDraw);
      drawCredits(cTarget, creditsStep, (ch) => GLYPH_ENTRY.get(ch));
      present(fb);
      return;
    }

    if (draw === null || pal === null) return;

    // Natively onto a 352×240 framebuffer. Not `putImageData` per sprite: that replaces pixels
    // including alpha and punches holes; `blitSprite` respects transparency.
    const fb = createFramebuffer(MENU_SURFACE.width, MENU_SURFACE.height);
    clearFramebuffer(fb, 0, 0, 0);
    const target: MenuTarget = {
      icon(entry, x, y, dim) {
        const sprite = (dim === true ? (dimDraw ?? draw) : draw)(entry);
        if (sprite !== null) blitSprite(fb, sprite, x, y);
      },
      glyph(entry, x, y, color) {
        const sprite = draw(entry);
        if (sprite === null) return;
        blitSprite(fb, sprite, x, y, [
          pal.rgba[color * 4] ?? 0,
          pal.rgba[color * 4 + 1] ?? 0,
          pal.rgba[color * 4 + 2] ?? 0,
        ]);
      },
      fill(x, y, w, h, color) {
        fillRect(fb, x, y, w, h, [
          pal.rgba[color * 4] ?? 0,
          pal.rgba[color * 4 + 1] ?? 0,
          pal.rgba[color * 4 + 2] ?? 0,
        ]);
      },
    };
    // In the original the chrome is drawn not by the menu but by the layout build — hence here
    // beside `drawMainMenu` rather than inside it.
    // Slot 2 of the control bar shows whether a map preview stands (`vp[0x62]`, see
    // `menuPanelIcons`) — the only bar icon the menu touches.
    drawScreenChromeSmall(fb, draw, { icons: menuPanelIcons(menu) });
    drawMainMenu(target, cmds, (ch) => GLYPH_ENTRY.get(ch));

    // The map generation bar lies ON TOP of the menu: during `FUN_00007874` the original draws only
    // these rectangles and leaves the rest standing (see `drawMapGenProgress`).
    if (progress !== null) drawMapGenProgress(target, progress);

    // Position and frame of the popup live in `drawMenuPopup`, so a check runs the same
    // computation and not its own copy.
    if (screen !== null) drawMenuPopup(fb, draw, screen, view, { textColor });
    // The disk menu sits in the same popup frame at the same place — it cannot be open together
    // with the options screen (each entrance closes the other).
    if (dScreen !== null && dState !== null)
      drawDiskMenuPopup(fb, draw, dScreen, dState, textColor, dBar);

    present(fb);
  });

  /**
   * Mouse position → surface coordinate. Computes straight from the displayed rectangle without
   * knowing the zoom — so the hit is right even when CSS shrinks the canvas further.
   */
  function toSurface(e: MouseEvent): { x: number; y: number } | null {
    const el = canvas;
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.floor(((e.clientX - rect.left) * MENU_SURFACE.width) / rect.width),
      y: Math.floor(((e.clientY - rect.top) * MENU_SURFACE.height) / rect.height),
    };
  }

  /**
   * Click while a popup is open. The zone walker subtracts the frame offset itself; subtracting it
   * here as well is what kept the dialog silent when it was first wired up.
   *
   * A click beside the popup does nothing: the original has no "click outside closes".
   */
  function clickPopup(sx: number, sy: number): void {
    const screen = popupScreen;
    if (screen === null) return;
    const action = clickMenuPopup(screen, sx, sy);
    if (action === null) return;
    // With a popup open, the menu's click chain jumps into the **game's popup router**
    // (`bt $0x1,vp[1]` @0x4f735 on the popup modality, `je` ⇒ `jmp 0x2bff7` @0x4f741) — so it is
    // the same zone walker @0x2cd3b and the same sound as in the map view.
    playUiSounds(UI_SOUND_PANEL_BUTTON);
    switch (action.kind) {
      case 'close':
        popupScreen = null;
        break;
      case 'toggle':
        settings.set(
          'viewOptions',
          action.side === 0
            ? [toggleOption(uiViewOptions[0], action.mask), uiViewOptions[1]]
            : [uiViewOptions[0], toggleOption(uiViewOptions[1], action.mask)],
        );
        break;
      case 'messageLevel':
        settings.set(
          'viewOptions',
          action.side === 0
            ? [cycleMessageLevel(uiViewOptions[0]), uiViewOptions[1]]
            : [uiViewOptions[0], cycleMessageLevel(uiViewOptions[1])],
        );
        break;
      case 'music':
        settings.set('music', !uiMusic);
        break;
      case 'sfx':
        settings.set('sfx', !uiSfx);
        break;
      case 'volume':
        settings.set('volume', stepVolume(uiVolume, action.delta));
        break;
      case 'screen':
        // The device screen hangs on the working copy that only the map view keeps.
        log.warn('menu', `${action.label} — screen 0x${action.screen.toString(16)} is not wired up in the menu.`);
        break;
      default:
        // 0x22 ("ENDE") belongs to the game branch and is not reachable from the menu.
        log.warn('menu', `Action “${action.kind}” belongs to the in-game branch.`);
        break;
    }
  }

  /**
   * **A39 "LOAD"** — open the disk menu in load mode. Screen 0x17 ("LADE ARCHIV…") stands for
   * exactly one frame as in the original: there it reads the index from disk, here it syncs a
   * released folder; without a folder it is a no-op and the screen flashes once.
   */
  async function openDisk(): Promise<void> {
    const st = store;
    if (st === null) {
      log.warn('menu', 'LOAD — save storage is not available.');
      return;
    }
    popupScreen = null;
    diskScreen = DISK_SCREEN_ARCHIV;
    disk = enterDiskMenu(st.archiv, false);
    await st.reconcile();
    if (diskScreen !== DISK_SCREEN_ARCHIV) return; // dazwischen geschlossen
    disk = enterDiskMenu(st.archiv, false);
    diskScreen = DISK_SCREEN_LIST;
  }

  /** Click in the disk menu (surface pixels). The zone walker sounds itself, see `applyDiskMenuAction`. */
  function clickDisk(sx: number, sy: number): void {
    const scr = diskScreen;
    const s0 = disk;
    if (scr === null || s0 === null) return;
    const action = clickDiskMenuPopup(scr, sx, sy);
    if (action === null) return;
    const r = applyDiskMenuAction(s0, action);
    disk = r.state;
        // Here the result already carries the walker sound (`DISK_SOUND_BUTTON`), see `disk-menu.ts`.
    playUiSounds(r.sound);
    switch (r.effect.kind) {
      case 'redraw':
        diskScreen = DISK_SCREEN_LIST_REDRAW;
        break;
      case 'perform':
        void runDisk(r.effect.slot);
        break;
      case 'exitToMenu':
      case 'exitToGame':
        // From the menu both exits lead back here — the game branch is unreachable from here,
        // because `saveMode` is never set in load mode.
        diskScreen = null;
        disk = null;
        break;
      case 'enterLoadedGame':
        // @0x284dd — `0x4f179` is not the game entry but the **stage-1 renderer of the main menu**
        // (its icon table @0x4f29e is byte for byte `MENU_STAGE1_ICONS`). The load success @0x46f20
        // sets `gs+0x1c8` **bit 6** (@0x46f41) beforehand, whereupon the renderer dims the menu
        // area and puts ABBRUCH and START brightly on top. The game is entered only by **A40**, the
        // START button — the save stays parked until the user decides, and A41 does not discard it
        // (the body @0x4fcb4 only clears bit 6).
        diskScreen = null;
        disk = null;
        break;
      default:
        break;
    }
  }

  /** The loaded save with its bytes, until the user dismisses the result window. */
  let pendingSave: { save: SaveGameState; bytes: Uint8Array } | null = null;

  /** The file operation itself — synchronous in the original, asynchronous here. */
  async function runDisk(slot: number): Promise<void> {
    const st = store;
    const s0 = disk;
    if (st === null || s0 === null || diskBusy) return;
    diskBusy = true;
    diskScreen = DISK_SCREEN_RESULT; // @0x46e7b - the original sets the screen BEFORE touching the file
    try {
      const r = await st.load(slot);
      let code = r.code;
      if (code === DISK_RESULT.loaded && r.data !== null) {
        try {
          pendingSave = { save: parseSaveGame(r.data), bytes: r.data };
          // `gs+0x1c8` bit 6 is set by the load success (@0x46f41), which redraws the menu
          // **immediately** (@0x46f4d) — the screen is 0x1a by then. So "GELADEN." already stands
          // in front of a dimmed menu, not the bright one; hence the flag here and not on dismissal.
          // @0x46f85..@0x46f98 — the load success also pulls slot 2 of the control bar along:
          // `gs+0x37e` bit 1 decides between `0x50340` (0x13) and `0x503b3` (0x0a). This is why
          // `panelIcon2` is a stored byte and not derived — it does NOT ask for the game type,
          // while every other writer does.
          menu = {
            ...menu,
            loadedGamePending: true,
            panelIcon2: menu.previewGenerated ? MENU_PANEL_ICON_PREVIEW : MENU_PANEL_ICON_IDLE,
          };
        } catch (err) {
          // Code 7 rather than 6: the file was readable, only its layout does not fit — which is
          // exactly what "KONFIGURATION UNZULAESSIG." means (@0x46ede `jne`).
          code = DISK_RESULT.headerRejected;
          pendingSave = null;
          menu = { ...menu, loadedGamePending: false };
          log.warn('menu', `Slot ${slot} is not a save game we can read: ${String(err)}`);
        }
      }
      disk = completeDiskOperation(s0, code);
    } finally {
      diskBusy = false;
    }
  }

  function handleClick(e: MouseEvent): void {
    // While the map is being generated the menu accepts nothing. In the original that is not a
    // lock but the consequence of the single thread: it runs through without reading input.
    if (mapGenProgress !== null) return;
    // Tail of a touch gesture. It stands before the credits branch on purpose: a pinch must not
    // skip the opening sequence.
    if (touch.phase === 'spent') return;
    // Take focus, so typing works right after "PASSWORT" — `onkeydown` needs it.
    canvas?.focus();
    // The opening credits abort on the LEFT mouse button only (@0x46ba tests `0x1f56`); `onclick`
    // fires only for it anyway.
    resumeAudio();
    if (showCredits) {
      introDone = true;
      onintroend?.();
      return;
    }
    const p = toSurface(e);
    if (p === null) return;
    if (diskScreen !== null) {
      clickDisk(p.x, p.y);
      return;
    }
    if (popupScreen !== null) {
      clickPopup(p.x, p.y);
      return;
    }
    const action = hitTestMainMenu(menu, p.x, p.y);
    if (action === null) return;
    // The sliders take their value from the click height (shared body @0x50931).
    const result = applyMainMenuAction(menu, action, traitValueFromClick(p.y), () =>
      menuRng.next(),
    );
    menu = result.state;
    // The zone walker sounds on EVERY hit (`mov $0x8` @0x4f8b4), the action puts its own sound
    // beside it — see {@link playUiSounds} and `MainMenuResult.sound`.
    playUiSounds(UI_SOUND_PANEL_BUTTON, result.sound, result.extraSound);
    if (result.effect.kind === 'unhandled') {
      log.warn(
        'menu',
        `Action A${result.effect.action} exists in the original but is not ported yet — deliberately without effect rather than silently swallowed.`,
      );
    }
    if (result.effect.kind === 'start') onstart?.(menu);
    // A40 @0x4fc4d — **continue playing**: the button that really enters the parked save. Without
    // one it cannot appear (only `enterLoadedGame` sets the flag), so the `null` branch is
    // unreachable and stays as an assertion.
    if (result.effect.kind === 'resume') {
      const parked = pendingSave;
      pendingSave = null;
      if (parked !== null) onload?.(parked.save, parked.bytes);
      else log.warn('menu', 'A40 — no loaded game is parked; nothing to resume.');
    }
    // A13 @0x4fceb — "EXTRA OPTION" opens screen 0x25.
    if (result.effect.kind === 'options') popupScreen = OPTIONS_SCREENS[1] ?? 0x25;
    if (result.effect.kind === 'load') void openDisk();
    // A39 @0x4fd1c — "LOAD": `vp[1]` btr 1, `vp[0x70] = 0x17`, `gs[0x1c8]` **btr 2** (i.e. load).
    // returns). The counterpart in the browser is a page reload — after which the opening credits
    // run again, just as they do when the original is restarted.
    if (result.effect.kind === 'quit') location.reload();
  }

  /**
   * Key press → character code for `input_buffer_putchar` (@0xd073): printable characters as their
   * code, plus the five special keys `0xfb..0xff`. Without a running entry the handler stays silent
   * and without `preventDefault` — then the keys belong to the browser.
   */
  function handleKey(e: KeyboardEvent): void {
    if (menu.textInput === null) return;
    let code: number | null = null;
    if (e.key === 'ArrowLeft') code = MENU_KEY_CURSOR_LEFT;
    else if (e.key === 'ArrowRight') code = MENU_KEY_CURSOR_RIGHT;
    else if (e.key === 'Backspace') code = MENU_KEY_BACKSPACE;
    else if (e.key === 'Delete') code = MENU_KEY_DELETE;
    else if (e.key === 'Enter') code = MENU_KEY_COMMIT;
    // Escape is an addition: the original has no cancel, and without it an accidentally opened
    // entry could not be left.
    else if (e.key === 'Escape') code = MENU_KEY_COMMIT;
    // With Ctrl/Alt/Meta it is a browser shortcut, not a character.
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
      code = e.key.toUpperCase().charCodeAt(0);
    if (code === null) return;
    e.preventDefault();
    const r = applyMainMenuKey(menu, code);
    menu = r.state;
    // No walker sound: the two closing branches @0x4f39a/@0x4f537 hang on the frame run, not on a
    // zone hit. An ordinary character reports 0 and stays silent.
    playUiSounds(r.sound);
  }

  /**
   * Wheel and touchpad pinch (`wheelZoomFactor`); `preventDefault` keeps the page zoom away. A pinch
   * on a real touchscreen does NOT arrive here — it comes as pointer events ({@link onPointerMove}).
   */
  function handleWheel(e: WheelEvent): void {
    e.preventDefault();
    zoomBy(wheelZoomFactor(e));
  }

  /**
   * **Two-finger zoom.** There is nothing to anchor: the menu has no camera, its surface sits
   * flex-centred on the stage and {@link fitScale} keeps it fitting — so zooming about the centre is
   * inherent here, not a shortcut.
   *
   * `touch-action: none` on this element is what makes the gesture ours at all; without it the
   * browser zooms the page and none of this runs.
   */
  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    const r = touchDown(touch, e.pointerId, e.clientX, e.clientY, performance.now());
    touch = r.state;
    if (r.outcome?.kind === 'pinchStart') pinchStart = { scale, dist: r.outcome.dist };
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    const r = touchMove(touch, e.pointerId, e.clientX, e.clientY, TOUCH_MOVE_THRESHOLD);
    touch = r.state;
    const start = pinchStart;
    if (r.outcome?.kind !== 'pinch' || start === null) return;
    zoom = pinchZoom(start.scale, start.dist, r.outcome.dist, ZOOM_MIN, ZOOM_MAX);
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    const r = touchUp(touch, e.pointerId);
    touch = r.state;
    if (r.outcome?.kind === 'ended') pinchStart = null;
  }

  /**
   * The gesture listeners hang on the container **imperatively**, not as attributes: the a11y rules
   * ask a plain element with pointer handlers for a role, and this one has none to give — the
   * interactive element is the canvas inside it, and a two-finger zoom has no keyboard counterpart
   * that a role would promise.
   *
   * The `gesture*` trio in the same place, for a second reason: **WebKit ignores `touch-action` for
   * the pinch.** There the page would keep zooming although the handlers work fine, and the counter
   * is `preventDefault` on those non-standard events (`passive: false`, absent from the typings).
   * Its limit, plainly: where `touch-action` is honoured they never fire, so there this is dead
   * weight — and on WebKit it cannot be checked from here.
   */
  $effect(() => {
    const el = viewEl;
    if (el === null) return;
    const stop = (ev: Event) => ev.preventDefault();
    const gestures = ['gesturestart', 'gesturechange', 'gestureend'];
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    for (const name of gestures) el.addEventListener(name, stop, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      for (const name of gestures) el.removeEventListener(name, stop);
    };
  });

  /**
   * The pointer hangs on the drawn {@link scale} and rounds to whole steps: the system scales
   * cursor images harshly, fractional factors make them blurry. Its own derived size, so the
   * expensive PNG encoding runs only on a step change.
   */
  const cursorScale = $derived(Math.max(1, Math.min(CURSOR_MAX_SCALE, Math.round(scale))));

  /**
   * The original mouse cursor as a CSS cursor (see `mouse-cursor.ts`) — in the original the frame
   * loop draws it over every screen, not only over the map. As CSS it stays outside the 352 × 240
   * surface and does not distort a pixel comparison. Without an archive it falls back.
   */
  const cursorStyle = $derived.by<string | null>(() => {
    const draw = provider;
    const s = cursorScale;
    if (draw === null) return null;
    const spr = draw(CURSOR_SPRITE_INDEX);
    return spr === null ? null : buildCursorStyle(spr, s);
  });

  /**
   * The music starts with the opening credits, not with the game (@0xb16c lies before
   * `call 0x45f8`), and it is the same single title as there.
   *
   * `$effect` with a cleanup return, because the player holds an `AudioContext` and a WASM synth.
   * Known limit: the map view creates a second one.
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

  $effect(() => {
    const player = musicPlayer;
    if (!musicShouldPlay(player !== null, uiMusic)) {
      player?.stop();
      return;
    }
    void player!.start();
  });

  // --- Interaction sounds (`core/ui-sound.ts`) --------------------------------------------------
  //
  // The menu has no simulation and therefore no logic frame at which the original drains its queue
  // (`soundServiceDue` in `core/sound.ts`). The only producer here is the click, so servicing
  // happens at the click too, with the same catch-up counter `MapView` uses for the **paused**
  // simulation.
  const soundQueue = createSoundQueue();
  /**
   * Four voices plus an own random stream. The seed is **arbitrary** and may be: the stream only
   * feeds the volume spread `base + (random & mask)`, and the three menu sounds have mask **0** in
   * the parameter table (`2 → [64,0,5]`, `4 → [64,0,10]`, `8 → [50,0,7]`), so the drawn value never
   * reaches the output.
   *
   * Not {@link menuRng}: that is the **game** random stream, from which A9/A12 draw the map seed. A
   * draw from it would shift the generated map.
   */
  const soundMixer = createSoundMixer([0x0380, 0xeea7, 0x6b11]);
  /** Picture period of the original in ms (12.5 fps) — only for the catch-up counter, see above. */
  const ORIGINAL_FRAME_MS = 80;
  let lastServiceMs = 0;

  /**
   * `$effect` with a cleanup return, because the player holds an `AudioContext` and sounding
   * voices — the same reason as for {@link musicPlayer}.
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

  $effect(() => {
    sfxPlayer?.setMasterVolume(uiVolume);
  });

  // Switch off ⇒ whatever is sounding stops at once (as in the map view).
  $effect(() => {
    if (!uiSfx) sfxPlayer?.stopAll();
  });

  /**
   * **Enqueue the sounds of ONE click and service the queue ONCE afterwards.**
   *
   * The argument order is the original's: first the zone walker's sound (`mov $0x8` @0x4f8b4 resp.
   * @0x2cd3b), then the action's. Both in one call, because insertion is **sorted** and the
   * servicing hands the slots to the voices in order: `8` then `2` yields `[2, 8]` and thus two
   * voices. Servicing after every enqueue gives a different distribution than the original.
   *
   * `0` means "no sound" ({@link applyMainMenuKey} reports it for every ordinary character) and is
   * dropped. That is not polish: sound 0 has duration 0 in the parameter table, a voice taken by it
   * is never freed by `tickSoundVoices` — and being the **lowest** and therefore most important
   * index, it would then block every further sound.
   */
  function playUiSounds(...sounds: readonly (number | undefined)[]): void {
    let any = false;
    for (const sound of sounds) {
      // `undefined` = this stage has nothing to enqueue; the **0** is something else and is
      // skipped for its own reason, see the doc block above.
      if (sound === undefined || sound === 0) continue;
      enqueueSound(soundQueue, sound);
      any = true;
    }
    if (!any) return;
    const now = performance.now();
    // Catch up as many original pictures as really elapsed — otherwise the voice countdowns never
    // run out and the second click would find all four voices busy.
    const frames = Math.min(64, Math.max(1, Math.round((now - lastServiceMs) / ORIGINAL_FRAME_MS)));
    lastServiceMs = now;
    for (let i = 0; i < frames; i++) tickSoundVoices(soundMixer);
    // Two statements on purpose: with optional chaining JS does not evaluate the argument, so
    // without an archive the queue would stay filled forever.
    const starts = serviceSound(soundMixer, soundQueue);
    if (uiSfx) sfxPlayer?.play(starts);
  }

  /**
   * An `AudioContext` may only run after a user gesture; the gesture here is the first click on the
   * surface. There is deliberately no separate control for it.
   */
  function resumeAudio(): void {
    if (uiMusic) void musicPlayer?.start();
    void sfxPlayer?.resume();
  }

  /**
   * Runs only while the opening credits are visible and hangs on the wall clock: a throttled tab
   * should slow the sequence down, not swallow it.
   */
  $effect(() => {
    if (!showCredits) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number): void => {
      const ticks = Math.floor((now - last) / CREDITS_TICK_MS);
      if (ticks > 0) {
        last += ticks * CREDITS_TICK_MS;
        credits = advanceCredits(credits, ticks);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  });

</script>

<div
  class="menu-view"
  bind:this={viewEl}
  bind:clientWidth={availWidth}
  bind:clientHeight={availHeight}
>
  <!-- `tabindex` only so `onkeydown` fires at all — the original has no focus concept. -->
  <canvas
    bind:this={canvas}
    tabindex="0"
    onclick={handleClick}
    onkeydown={handleKey}
    onwheel={handleWheel}
    style:cursor={cursorStyle}
  ></canvas>

</div>

<style>
  /* Full area: the menu surface sits centred on the stage, without frame and without control bar.
     Zooming is by mouse wheel (`handleWheel`) or two fingers (`onPointerMove`) — there is
     deliberately no control for it.
     `touch-action: none` is not decoration: with Pointer Events it is the ONLY lever against the
     browser's own pinch zoom, and `preventDefault` on a pointer event is none. */
  .menu-view {
    position: relative;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    touch-action: none;
  }
  canvas {
    image-rendering: pixelated;
    /* Only for the first picture, before the measurement — afterwards `scale` fits anyway. */
    max-width: 100%;
    max-height: 100%;
    background: #000;
    cursor: pointer;
  }
  /* No focus ring. The canvas is focusable only so that `onkeydown` fires at all (password entry);
     it is the WHOLE surface and not one control among several, so a ring shows nothing the user
     does not already see. What is removed is the indicator, not the focus. */
  canvas:focus,
  canvas:focus-visible {
    outline: none;
  }
</style>
