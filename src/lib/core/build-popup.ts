/**
 * Build menu (popup screens 3..7) — layout, click zones and actions, byte-exact from the original.
 *
 * The build menu consists of five screens reached from the control panel:
 *
 * | screen | renderer | content |
 * |---|---|---|
 * | 3 | `FUN_0003ce64` | **mines** (stone/coal/iron/gold) |
 * | 4 | `FUN_0003ced7` | **small buildings** (no page icon) |
 * | 5 | `FUN_0003cf67` | the same selection **as page 1 of 3** (with page icon) |
 * | 6 | `FUN_0003d015` | large buildings, page 2 |
 * | 7 | `FUN_0003d052` | large buildings, page 3 |
 *
 * **A popup click places immediately** — every action handler of the original is a three-liner
 * `gs+0x27a = <building type>; jmp <placement body>`, and the three bodies (`0x3011e` mine /
 * `0x301fa` small / `0x302d6` large) are already ported as `placeBuilding`. So there is **no**
 * intermediate step "remember the type, then click the map": the building appears at the current
 * player cursor, which `classifyBuildSite` has classified beforehand.
 *
 * **Two locks** from the same classification (`player+3`):
 * - bit 0 **military building blocked** -> the military handlers return immediately, and the renderer
 *   takes a layout variant **without** the affected icons (`@0x3d111` / `@0x3d169`).
 * - bit 1 **flag building blocked** -> the flag handler returns and the flag preview is omitted.
 *
 * All click-zone coordinates are in **click-rectangle space** (drawing pixels minus (8, 9)), all
 * layout entries in the `{icon, col, row}` space of the layout interpreter (`FUN_0003d0b8`).
 */

import {
  blitSprite,
  blitSpriteNoPivot,
  drawLayout,
  hitTest,
  panelX,
  panelY,
  tileBackground,
  PANEL_BG_ICON,
  UI_ICON_BASE,
  UI_OBJECT_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';

// --- Layout tables (object bank, `{icon, col, row}` from the original interpreter) ----------------

/** Mines (screen 3) — table `@0x3d0f1`. */
export const MINE_LAYOUT: readonly LayoutItem[] = [
  { icon: 0xa3, col: 2, row: 8 },
  { icon: 0xa4, col: 8, row: 8 },
  { icon: 0xa5, col: 4, row: 77 },
  { icon: 0xa6, col: 10, row: 77 },
];

/** Small buildings (screen 4/5) — table `@0x3d10b`. */
export const SMALL_LAYOUT: readonly LayoutItem[] = [
  { icon: 0xab, col: 10, row: 13 },
  { icon: 0xa9, col: 2, row: 13 },
  { icon: 0xa8, col: 0, row: 58 },
  { icon: 0xaa, col: 6, row: 56 },
  { icon: 0xa7, col: 12, row: 55 },
  { icon: 0xbc, col: 2, row: 85 },
  { icon: 0xae, col: 10, row: 87 },
];

/** Small buildings without the guard hut (military blocked) — table `@0x3d111`. */
export const SMALL_LAYOUT_NO_MILITARY: readonly LayoutItem[] = SMALL_LAYOUT.filter(
  (i) => i.icon !== 0xab,
);

/** Large buildings, page 2 (screen 6) — table `@0x3d137`. */
export const LARGE_LAYOUT_PAGE2: readonly LayoutItem[] = [
  { icon: 0x9c, col: 0, row: 15 },
  { icon: 0x9d, col: 8, row: 15 },
  { icon: 0xa1, col: 0, row: 50 },
  { icon: 0xa0, col: 8, row: 50 },
  { icon: 0xa2, col: 2, row: 100 },
  { icon: 0x9f, col: 10, row: 96 },
];

/** Large buildings, page 3 (screen 7) — table `@0x3d15d`. */
export const LARGE_LAYOUT_PAGE3: readonly LayoutItem[] = [
  { icon: 0x9e, col: 2, row: 99 },
  { icon: 0x98, col: 8, row: 84 },
  { icon: 0x99, col: 0, row: 1 },
  { icon: 0xc0, col: 0, row: 46 },
  { icon: 0x9a, col: 8, row: 1 },
  { icon: 0x9b, col: 8, row: 45 },
];

/** Page 3 without tower/fortress (military blocked) — table `@0x3d169`. */
export const LARGE_LAYOUT_PAGE3_NO_MILITARY: readonly LayoutItem[] = LARGE_LAYOUT_PAGE3.filter(
  (i) => i.icon !== 0x9e && i.icon !== 0x98,
);

/** Page icon of the three large build pages (icon bank `0x3d` at column 0 / row `0x80`). */
export const PAGE_ICON = 0x3d;
export const PAGE_ICON_COL = 0;
export const PAGE_ICON_ROW = 0x80;

/**
 * Base of the flag preview in the object bank. The original draws `0x80 + 4*player colour`
 * (`player+0`) — the same stride of 4 as the map's flag sprites.
 */
export const FLAG_PREVIEW_BASE = 0x80;

// --- Click zones (tables of the click walker, `{action, x0, x1, y0, y1}`) ------------------------

/** Mines (screen 3) — table `@0x2ca8c`. */
export const MINE_HITBOXES: readonly HitRect[] = [
  { action: 5, x0: 16, x1: 48, y0: 8, y1: 72 },
  { action: 6, x0: 64, x1: 96, y0: 8, y1: 72 },
  { action: 7, x0: 32, x1: 64, y0: 77, y1: 141 },
  { action: 8, x0: 80, x1: 112, y0: 77, y1: 141 },
  { action: 9, x0: 10, x1: 26, y0: 114, y1: 134 },
];

/** Small buildings (screen 4) — table `@0x2caab`. */
export const SMALL_HITBOXES: readonly HitRect[] = [
  { action: 10, x0: 16, x1: 48, y0: 13, y1: 41 },
  { action: 11, x0: 80, x1: 112, y0: 13, y1: 39 },
  { action: 12, x0: 0, x1: 32, y0: 58, y1: 81 },
  { action: 13, x0: 48, x1: 80, y0: 56, y1: 81 },
  { action: 14, x0: 96, x1: 128, y0: 55, y1: 84 },
  { action: 15, x0: 16, x1: 48, y0: 92, y1: 137 },
  { action: 9, x0: 58, x1: 74, y0: 108, y1: 128 },
  { action: 16, x0: 80, x1: 112, y0: 87, y1: 139 },
];

/** Small buildings as page 1 (screen 5) — table `@0x2caa6` = screen 4 with the page zone in front. */
export const SMALL_PAGE_HITBOXES: readonly HitRect[] = [
  { action: 28, x0: 0, x1: 15, y0: 129, y1: 143 },
  ...SMALL_HITBOXES,
];

/** Large buildings, page 2 (screen 6) — table `@0x2cad4`. */
export const LARGE_PAGE2_HITBOXES: readonly HitRect[] = [
  { action: 28, x0: 0, x1: 15, y0: 129, y1: 143 },
  { action: 17, x0: 0, x1: 64, y0: 15, y1: 40 },
  { action: 18, x0: 64, x1: 128, y0: 15, y1: 40 },
  { action: 19, x0: 0, x1: 48, y0: 50, y1: 88 },
  { action: 20, x0: 64, x1: 112, y0: 50, y1: 90 },
  { action: 21, x0: 16, x1: 64, y0: 100, y1: 132 },
  { action: 22, x0: 80, x1: 128, y0: 96, y1: 135 },
];

/** Large buildings, page 3 (screen 7) — table `@0x2caf8`. */
export const LARGE_PAGE3_HITBOXES: readonly HitRect[] = [
  { action: 28, x0: 0, x1: 15, y0: 129, y1: 143 },
  { action: 23, x0: 64, x1: 127, y0: 87, y1: 142 },
  { action: 24, x0: 16, x1: 63, y0: 99, y1: 141 },
  { action: 25, x0: 0, x1: 63, y0: 1, y1: 48 },
  { action: 26, x0: 64, x1: 127, y0: 1, y1: 42 },
  { action: 27, x0: 64, x1: 127, y0: 45, y1: 85 },
  { action: 190, x0: 0, x1: 47, y0: 50, y1: 97 },
];

// --- Actions --------------------------------------------------------------------------------------

/** What a click in the build menu triggers. */
export type BuildPopupAction =
  | {
      /** Erect a building at the player cursor (original: `gs+0x27a = type`, then placement body). */
      readonly kind: 'build';
      readonly buildingType: number;
      /** Military building — the handler tests the military lock `player+3` bit 0 first. */
      readonly military: boolean;
    }
  /**
   * **Place a flag** — handler `build_flag_action` (@0x2fe96), all of four steps in the ASM:
   *
   * ```
   * player = vp[0x82]
   * bt $0x1, player[3] ; jz on ; ret     // flag building blocked: NOTHING, the popup stays open
   * on: call 0x28be3                     // close popup + restore panel slots 2..4
   *     jmp  0x2891e                     // tail jump: the same handler as panel icon 0x01
   * ```
   *
   * Two things follow for the caller: the **lock is tested before closing** (with flag building
   * blocked really nothing happens), and the popup closes **before** the build — so also when the gate
   * of `action_build_flag` (possibility != 0, kind 7/6/4) does not hold.
   */
  | { readonly kind: 'flag' }
  /** Page on through the three large build pages (handler `0x31e47`). */
  | { readonly kind: 'page' };

/**
 * Action id -> effect, **byte-exact** from the handler table at `0x2cd66` (each id indexes an 8-byte
 * jump cell; the build handlers load `mov $type,%ax` and jump into one of the three placement bodies).
 * The building types are the original enum 0..24.
 */
export const BUILD_POPUP_ACTIONS: ReadonlyMap<number, BuildPopupAction> = new Map<
  number,
  BuildPopupAction
>([
  [5, { kind: 'build', buildingType: 5, military: false }], // stone mine
  [6, { kind: 'build', buildingType: 6, military: false }], // coal mine
  [7, { kind: 'build', buildingType: 7, military: false }], // iron mine
  [8, { kind: 'build', buildingType: 8, military: false }], // gold mine
  [9, { kind: 'flag' }],
  [10, { kind: 'build', buildingType: 4, military: false }], // stonecutter
  [11, { kind: 'build', buildingType: 11, military: true }], // guard hut
  [12, { kind: 'build', buildingType: 2, military: false }], // lumberjack
  [13, { kind: 'build', buildingType: 9, military: false }], // forester
  [14, { kind: 'build', buildingType: 1, military: false }], // fisher
  [15, { kind: 'build', buildingType: 15, military: false }], // mill
  [16, { kind: 'build', buildingType: 3, military: false }], // boat builder
  [17, { kind: 'build', buildingType: 13, military: false }], // butcher
  [18, { kind: 'build', buildingType: 20, military: false }], // weapon smith
  [19, { kind: 'build', buildingType: 18, military: false }], // steel smelter
  [20, { kind: 'build', buildingType: 17, military: false }], // sawmill
  [21, { kind: 'build', buildingType: 16, military: false }], // baker
  [22, { kind: 'build', buildingType: 23, military: false }], // gold smelter
  [23, { kind: 'build', buildingType: 22, military: true }], // fortress
  [24, { kind: 'build', buildingType: 21, military: true }], // watch tower
  [25, { kind: 'build', buildingType: 19, military: false }], // tool maker
  [26, { kind: 'build', buildingType: 12, military: false }], // farm
  [27, { kind: 'build', buildingType: 14, military: false }], // pig farm
  [28, { kind: 'page' }],
  [190, { kind: 'build', buildingType: 10, military: false }], // warehouse
]);

// --- Screens ---------------------------------------------------------------------------------------

/** One screen of the build menu (layout, click zones and special elements). */
export interface BuildScreen {
  readonly id: number;
  readonly title: string;
  /** Icon layout (object bank). */
  readonly layout: readonly LayoutItem[];
  /** Variant when military building is blocked (`player+3` bit 0); absent if the screen has none. */
  readonly layoutNoMilitary?: readonly LayoutItem[];
  /** Position of the flag preview if the screen shows one (omitted when flag building is blocked). */
  readonly flagPreview?: { readonly col: number; readonly row: number };
  /** Does the screen show the page icon? */
  readonly hasPageIcon: boolean;
  readonly hitboxes: readonly HitRect[];
}

/** The five screens of the build menu. */
export const BUILD_SCREENS: ReadonlyMap<number, BuildScreen> = new Map<number, BuildScreen>([
  [
    3,
    {
      id: 3,
      title: 'build: mines',
      layout: MINE_LAYOUT,
      flagPreview: { col: 2, row: 0x72 },
      hasPageIcon: false,
      hitboxes: MINE_HITBOXES,
    },
  ],
  [
    4,
    {
      id: 4,
      title: 'build: small buildings',
      layout: SMALL_LAYOUT,
      layoutNoMilitary: SMALL_LAYOUT_NO_MILITARY,
      flagPreview: { col: 8, row: 0x6c },
      hasPageIcon: false,
      hitboxes: SMALL_HITBOXES,
    },
  ],
  [
    5,
    {
      id: 5,
      title: 'build: page 1 (small buildings)',
      layout: SMALL_LAYOUT,
      layoutNoMilitary: SMALL_LAYOUT_NO_MILITARY,
      flagPreview: { col: 8, row: 0x6c },
      hasPageIcon: true,
      hitboxes: SMALL_PAGE_HITBOXES,
    },
  ],
  [
    6,
    {
      id: 6,
      title: 'build: page 2 (large buildings)',
      layout: LARGE_LAYOUT_PAGE2,
      hasPageIcon: true,
      hitboxes: LARGE_PAGE2_HITBOXES,
    },
  ],
  [
    7,
    {
      id: 7,
      title: 'build: page 3 (large buildings)',
      layout: LARGE_LAYOUT_PAGE3,
      layoutNoMilitary: LARGE_LAYOUT_PAGE3_NO_MILITARY,
      hasPageIcon: true,
      hitboxes: LARGE_PAGE3_HITBOXES,
    },
  ],
]);

/**
 * Next page of the large build menu — handler `0x31e47`: `screen + 1`, and 8 becomes 5 again. Screens
 * without a page icon (3/4) stay where they are.
 */
export function nextBuildScreen(screen: number): number {
  if (BUILD_SCREENS.get(screen)?.hasPageIcon !== true) return screen;
  const next = screen + 1;
  return next === 8 ? 5 : next;
}

/**
 * Which build screen opens for a build possibility (`player+0x101`).
 *
 * Status: **hypothesis from the manual** — the mapping is described explicitly in the original manual
 * (ch. 2.5), but the triggering byte path is not located yet (see below). The manual says the build
 * function shown at the bottom left follows the cursor symbol, from "place flag" through "build hut"
 * and "build large building" to "build mine", and that the large selection spans several pages
 * reachable via the page symbol.
 *
 * That agrees with the byte-verified icon-to-screen table of the control panel
 * (`CONTROL_PANEL_BUTTON_ACTIONS`): icon 2 -> screen 3 (mines), icon 3 -> screen **4** (small
 * buildings, **without** page icon), icon 4 -> screen **5** (page 1 of 3, **with** page icon). That is
 * exactly where the original hides things: with "only a small building possible" there is no route to
 * the large buildings, because screen 4 has no page icon.
 *
 * **Still open:** which original routine sets the panel's slot-0 icon from `player+0x101`. The panel
 * drawing (`FUN_000335ce`) only blits `panel[0x60..0x64]` (dirty comparison against
 * `panel[0x65..0x69]`) and derives nothing; the click navigation (`FUN_000272d7`) writes the row only
 * on a screen change. Until the setter is located this function stays a hypothesis.
 */
export function buildScreenForPossibility(possibility: number): number | null {
  if (possibility === 2) return 3; // mine
  if (possibility === 3) return 4; // small building only — no paging to the large ones
  if (possibility >= 4) return 5; // large building — page 1 of 3
  return null; // 0 = nothing buildable, 1 = flag only
}

/**
 * Resolves a click (in **drawing pixels**) in the build menu. `null` if the screen is not a build
 * screen or the click hits nothing. The locks are **not** tested here — the original lets the handler
 * run and it aborts itself; the engine (`placeBuilding`) decides again from the cursor classification
 * anyway.
 */
export function buildPopupAction(
  screen: number,
  drawX: number,
  drawY: number,
): BuildPopupAction | null {
  const s = BUILD_SCREENS.get(screen);
  if (s === undefined) return null;
  const action = hitTest(s.hitboxes, drawX - 8, drawY - 9);
  if (action === null) return null;
  return BUILD_POPUP_ACTIONS.get(action) ?? null;
}

/**
 * Draws a build screen: tiled background, icon layout (with the military variant), optional flag
 * preview in the player colour and optional page icon — in the original's order.
 *
 * `militaryBlocked` / `flagBlocked` are the two bits from `player+3` that the cursor classification
 * sets; `playerColor` is `player+0` (colour index for the flag preview).
 */
export function drawBuildPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  opts: { militaryBlocked?: boolean; flagBlocked?: boolean; playerColor?: number } = {},
): boolean {
  const s = BUILD_SCREENS.get(screen);
  if (s === undefined) return false;
  const layout =
    opts.militaryBlocked === true && s.layoutNoMilitary !== undefined ? s.layoutNoMilitary : s.layout;
  tileBackground(fb, provider, PANEL_BG_ICON);
  drawLayout(fb, provider, layout, UI_OBJECT_BASE);
  if (s.flagPreview !== undefined && opts.flagBlocked !== true) {
    const icon = FLAG_PREVIEW_BASE + 4 * (opts.playerColor ?? 0);
    const spr = provider(UI_OBJECT_BASE + icon);
    if (spr) blitSpriteNoPivot(fb, spr, panelX(s.flagPreview.col), panelY(s.flagPreview.row));
  }
  if (s.hasPageIcon) {
    const spr = provider(UI_ICON_BASE + PAGE_ICON);
    if (spr) blitSprite(fb, spr, panelX(PAGE_ICON_COL), panelY(PAGE_ICON_ROW));
  }
  return true;
}
