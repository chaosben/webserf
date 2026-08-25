/**
 * **The eight sub-screens of the distribution/options menu** (screen 0x24 resp. 0x1b) — the screens
 * behind its eight category icons. All eight are ported here completely: drawing, click zones and
 * actions.
 *
 * | screen | renderer | content (manual's name) |
 * |---|---|---|
 * | 0x1c | `FUN_0003c198` | **food to mines** (4 sliders, "menu 1") |
 * | 0x1d | `FUN_0003c296` | **wood & iron** (3 + 2 sliders, "menu 2") |
 * | 0x1e | `FUN_0003c3b3` | **coal & wheat** (3 + 2 sliders, "menu 3") |
 * | 0x1f | `FUN_0003c4d6` | **knight occupation** per border position (4 x max/min) |
 * | 0x20 | `FUN_0003c6c4` | **tool production** (9 sliders) |
 * | 0x21 | `FUN_0003c865` | **goods transport priority** (26 slots) |
 * | 0x2d | `FUN_0003c9d5` | **knight menu 2**: rate, recruiting, attack choice |
 * | 0x2e | `FUN_0003cc84` | **goods escape priority** (26 slots) |
 *
 * All renderers are resolved via the popup table `LAB_00037fb9 + (screen - 1)*8` (with off-by-one;
 * cross-checked against the already ported cells 8 -> `0x3d183`, 0x14 -> `0x3f729`, 0x24 ->
 * `0x3d23d`, 0x26 -> `0x3d27a`), the click tables via `LAB_0002c09e + screen*8` (without off-by-one).
 *
 * ## Two layout interpreters back to back
 *
 * The three goods screens set **one** table pointer and then call *both* interpreters:
 * `draw_popup_layout` (`FUN_0003d0b8`, object bank) runs to the negative entry, after which
 * `draw_popup_icon_layout` (`FUN_00041fe0`, icon bank) **continues at the same place**. So it is one
 * table with two sections — kept separately here as `objects` + `icons`.
 *
 * ## The slider
 *
 * Trough icon plus filled rectangle, see `drawSlider` in `ui-render.ts`. Value to pixel:
 * `pixel = value / 1310`, `value = pixel * 1310` — full deflection 50 px = 65500. The click path
 * (`@0x2f89f`) computes `pixel = click_x - col*8 - 7`, clamped to 0..50.
 *
 * ## Priority lists (0x21 / 0x2e)
 *
 * Both screens share the **same** click walker (`@0x2c952`) and the same position table `@0x3c96d`;
 * the actions tell them apart by the running screen (`vp[0x72] == 0x21`). The 26 goods icons are not
 * in type order but **on the slot of their priority**: `position = table[26 - prio]`. The default
 * tables confirm the manual exactly — transport: planks 26 / timber 22 at the top, gold ore 1 at the
 * bottom; escape: gold bar 26 / gold ore 25 at the top, wheat 1 at the bottom.
 */
import {
  drawLayout,
  drawPanelIcon,
  drawPanelNumber,
  drawPanelNumberWide,
  drawPanelText,
  drawSlider,
  hitTestPanel,
  tileBackground,
  UI_ICON_BASE,
  UI_OBJECT_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';
import { t } from './language.js';

/** Background tile of all eight screens (`draw_popup_background(0x137)`). */
export const SETTINGS_POPUP_BG_ICON = 0x137;

/** "RAUS" (action `0x63`) does **not** return to the game but to menu **0x1b**. */
export const SETTINGS_POPUP_MENU_SCREEN = 0x1b;

/** Goods icon = resource type + `0x22` (derived from the castle layout table). */
export const RESOURCE_ICON_BASE = 0x22;

// --- Slider description --------------------------------------------------------------------------

/** Target field of a slider in the player block. */
export type SliderList =
  | 'foodDistribution'
  | 'planksDistribution'
  | 'steelDistribution'
  | 'coalDistribution'
  | 'wheatDistribution'
  | 'toolPriority'
  | 'serfToKnightRate';

/**
 * One slider: panel position, action id of its click zone and the target field. `playerOffset` is the
 * **block offset** from which `list`/`index` are derived (the renderer reads `player + (offset -
 * 0x80)`) — carried along as evidence and held against the field offsets in the test.
 */
export interface SliderSpec {
  readonly col: number;
  readonly row: number;
  readonly action: number;
  readonly list: SliderList;
  readonly index: number;
  readonly playerOffset: number;
}

// --- Screen 0x1c: food to mines -----------------------------------------------------------------

/** Object section of table `@0x3c25c` — the four mines. */
export const FOOD_POPUP_OBJECTS: readonly LayoutItem[] = [
  { icon: 163, col: 12, row: 21 },
  { icon: 164, col: 8, row: 41 },
  { icon: 165, col: 4, row: 61 },
  { icon: 166, col: 0, row: 81 },
];
/** Icon section of the same table: fish (34), meat (36), bread (39), "RAUS", default button. */
export const FOOD_POPUP_ICONS: readonly LayoutItem[] = [
  { icon: 34, col: 4, row: 1 },
  { icon: 36, col: 7, row: 1 },
  { icon: 39, col: 10, row: 1 },
  { icon: 60, col: 14, row: 128 },
  { icon: 295, col: 1, row: 8 },
];
export const FOOD_POPUP_SLIDERS: readonly SliderSpec[] = [
  { col: 4, row: 0x15, action: 0x64, list: 'foodDistribution', index: 0, playerOffset: 448 },
  { col: 0, row: 0x29, action: 0x65, list: 'foodDistribution', index: 1, playerOffset: 450 },
  { col: 8, row: 0x72, action: 0x66, list: 'foodDistribution', index: 2, playerOffset: 452 },
  { col: 4, row: 0x85, action: 0x67, list: 'foodDistribution', index: 3, playerOffset: 454 },
];

// --- Screen 0x1d: wood & iron -------------------------------------------------------------------

export const PLANKS_POPUP_OBJECTS: readonly LayoutItem[] = [
  { icon: 186, col: 2, row: 0 },
  { icon: 174, col: 2, row: 41 },
  { icon: 153, col: 8, row: 54 },
  { icon: 157, col: 0, row: 102 },
];
export const PLANKS_POPUP_ICONS: readonly LayoutItem[] = [
  { icon: 41, col: 9, row: 25 },
  { icon: 45, col: 9, row: 119 },
  { icon: 60, col: 14, row: 128 },
  { icon: 295, col: 13, row: 8 },
];
export const PLANKS_POPUP_SLIDERS: readonly SliderSpec[] = [
  { col: 0, row: 0x1a, action: 0x68, list: 'planksDistribution', index: 0, playerOffset: 456 },
  { col: 0, row: 0x24, action: 0x69, list: 'planksDistribution', index: 1, playerOffset: 458 },
  { col: 8, row: 0x2c, action: 0x6a, list: 'planksDistribution', index: 2, playerOffset: 460 },
  { col: 8, row: 0x67, action: 0x6b, list: 'steelDistribution', index: 0, playerOffset: 462 },
  { col: 0, row: 0x82, action: 0x6c, list: 'steelDistribution', index: 1, playerOffset: 464 },
];

// --- Screen 0x1e: coal & wheat ------------------------------------------------------------------

export const COAL_POPUP_OBJECTS: readonly LayoutItem[] = [
  { icon: 161, col: 0, row: 1 },
  { icon: 159, col: 10, row: 0 },
  { icon: 157, col: 4, row: 56 },
  { icon: 188, col: 12, row: 61 },
  { icon: 155, col: 0, row: 101 },
];
export const COAL_POPUP_ICONS: readonly LayoutItem[] = [
  { icon: 46, col: 7, row: 19 },
  { icon: 37, col: 8, row: 101 },
  { icon: 60, col: 14, row: 128 },
  { icon: 295, col: 1, row: 60 },
];
export const COAL_POPUP_SLIDERS: readonly SliderSpec[] = [
  { col: 0, row: 0x27, action: 0x6d, list: 'coalDistribution', index: 0, playerOffset: 466 },
  { col: 8, row: 0x27, action: 0x6e, list: 'coalDistribution', index: 1, playerOffset: 468 },
  { col: 4, row: 0x2f, action: 0x6f, list: 'coalDistribution', index: 2, playerOffset: 470 },
  { col: 0, row: 0x5c, action: 0x70, list: 'wheatDistribution', index: 0, playerOffset: 472 },
  { col: 8, row: 0x76, action: 0x71, list: 'wheatDistribution', index: 1, playerOffset: 474 },
];

// --- Screen 0x20: tool production ---------------------------------------------------------------

/**
 * Icon table `@0x3c821`. The nine tool icons are **not** in field order; their resource types
 * (icon - `0x22`) are shovel, hammer, axe, saw, scythe, pick, pincer, cleaver, rod — exactly the order
 * in which the renderer reads the `toolPriority` indices (0, 1, 5, 6, 4, 7, 8, 3, 2). Two independent
 * tables, the same mapping.
 */
export const TOOLS_POPUP_ICONS: readonly LayoutItem[] = [
  { icon: 49, col: 1, row: 0 },
  { icon: 50, col: 1, row: 16 },
  { icon: 54, col: 1, row: 32 },
  { icon: 55, col: 1, row: 48 },
  { icon: 53, col: 1, row: 64 },
  { icon: 56, col: 1, row: 80 },
  { icon: 57, col: 1, row: 96 },
  { icon: 52, col: 1, row: 112 },
  { icon: 51, col: 1, row: 128 },
  { icon: 60, col: 14, row: 128 },
  { icon: 295, col: 13, row: 8 },
];
export const TOOLS_POPUP_SLIDERS: readonly SliderSpec[] = [
  { col: 4, row: 0x04, action: 0x82, list: 'toolPriority', index: 0, playerOffset: 0 },
  { col: 4, row: 0x14, action: 0x83, list: 'toolPriority', index: 1, playerOffset: 2 },
  { col: 4, row: 0x24, action: 0x84, list: 'toolPriority', index: 5, playerOffset: 10 },
  { col: 4, row: 0x34, action: 0x85, list: 'toolPriority', index: 6, playerOffset: 12 },
  { col: 4, row: 0x44, action: 0x86, list: 'toolPriority', index: 4, playerOffset: 8 },
  { col: 4, row: 0x54, action: 0x87, list: 'toolPriority', index: 7, playerOffset: 14 },
  { col: 4, row: 0x64, action: 0x88, list: 'toolPriority', index: 8, playerOffset: 16 },
  { col: 4, row: 0x74, action: 0x89, list: 'toolPriority', index: 3, playerOffset: 6 },
  { col: 4, row: 0x84, action: 0x8a, list: 'toolPriority', index: 2, playerOffset: 4 },
];

// --- Screen 0x1f: knight occupation -------------------------------------------------------------

/**
 * The five occupation levels as text (`@0x3c624`.., `0xff`-terminated). The renderer picks them via
 * `FUN_0003c5d0`: `0 -> MINIMUM, 1 -> SCHWACH, <3 -> MITTEL, 3 -> GUT, else -> VOLL`.
 */
export const OCCUPATION_LABELS: readonly string[] = [
  'MINIMUM',
  'SCHWACH',
  'MITTEL',
  'GUT',
  'VOLL',
];

/** Text column of both lines (`vreg0 = 8` in `FUN_0003c5d0`). */
export const OCCUPATION_TEXT_COL = 8;
/** Row distance between the target and minimum word (`add $0xb` in `FUN_0003c56c`). */
export const OCCUPATION_MIN_ROW_DELTA = 0xb;

/**
 * The four border-position groups. `index` is the entry in `knightOccupation` — the renderer reads
 * `player - 1 ... - 4`, i.e. **descending** from index 3 (front) to 0 (hinterland).
 */
export interface OccupationGroup {
  readonly index: number;
  readonly textRow: number;
  readonly maxRow: number;
  readonly minRow: number;
}
export const OCCUPATION_GROUPS: readonly OccupationGroup[] = [
  { index: 3, textRow: 0x08, maxRow: 2, minRow: 18 },
  { index: 2, textRow: 0x2a, maxRow: 36, minRow: 52 },
  { index: 1, textRow: 0x4c, maxRow: 70, minRow: 86 },
  { index: 0, textRow: 0x6e, maxRow: 104, minRow: 120 },
];

/** Icon table `@0x3c644`: four border-position pictures + 8 x (`-`, `+`) + "RAUS". */
export const OCCUPATION_POPUP_ICONS: readonly LayoutItem[] = [
  { icon: 226, col: 0, row: 2 },
  { icon: 227, col: 0, row: 36 },
  { icon: 228, col: 0, row: 70 },
  { icon: 229, col: 0, row: 104 },
  { icon: 220, col: 4, row: 2 },
  { icon: 221, col: 6, row: 2 },
  { icon: 220, col: 4, row: 18 },
  { icon: 221, col: 6, row: 18 },
  { icon: 220, col: 4, row: 36 },
  { icon: 221, col: 6, row: 36 },
  { icon: 220, col: 4, row: 52 },
  { icon: 221, col: 6, row: 52 },
  { icon: 220, col: 4, row: 70 },
  { icon: 221, col: 6, row: 70 },
  { icon: 220, col: 4, row: 86 },
  { icon: 221, col: 6, row: 86 },
  { icon: 220, col: 4, row: 104 },
  { icon: 221, col: 6, row: 104 },
  { icon: 220, col: 4, row: 120 },
  { icon: 221, col: 6, row: 120 },
  { icon: 60, col: 14, row: 128 },
];

// --- Screens 0x21 / 0x2e: priority lists --------------------------------------------------------

/**
 * Position table `@0x3c96d`: 26 x `{col, row}` as a **serpentine** (right and down, back left, right
 * again). Slot `i` belongs to priority `26 - i`.
 */
export const PRIORITY_SLOT_POSITIONS: readonly { readonly col: number; readonly row: number }[] = [
  { col: 5, row: 4 },
  { col: 7, row: 6 },
  { col: 9, row: 8 },
  { col: 11, row: 10 },
  { col: 13, row: 12 },
  { col: 13, row: 28 },
  { col: 11, row: 30 },
  { col: 9, row: 32 },
  { col: 7, row: 34 },
  { col: 5, row: 36 },
  { col: 3, row: 38 },
  { col: 1, row: 40 },
  { col: 1, row: 56 },
  { col: 3, row: 58 },
  { col: 5, row: 60 },
  { col: 7, row: 62 },
  { col: 9, row: 64 },
  { col: 11, row: 66 },
  { col: 13, row: 68 },
  { col: 13, row: 84 },
  { col: 11, row: 86 },
  { col: 9, row: 88 },
  { col: 7, row: 90 },
  { col: 5, row: 92 },
  { col: 3, row: 94 },
  { col: 1, row: 96 },
];

/** Icon table `@0x3c947` (screen 0x21) — byte-identical to `@0x3cd66` (screen 0x2e). */
export const PRIORITY_POPUP_ICONS: readonly LayoutItem[] = [
  { icon: 237, col: 1, row: 120 },
  { icon: 238, col: 3, row: 120 },
  { icon: 239, col: 9, row: 120 },
  { icon: 240, col: 11, row: 120 },
  { icon: 295, col: 1, row: 4 },
  { icon: 60, col: 14, row: 128 },
];

/** Panel position of the selection icon (the chosen goods, `draw_panel_icon(6, 0x78, cursor + 0x21)`). */
export const PRIORITY_CURSOR_COL = 6;
export const PRIORITY_CURSOR_ROW = 0x78;

/** The four move buttons in table order (actions `0xa5`..`0xa8`). */
export type PriorityMove = 'top' | 'up' | 'down' | 'bottom';
export const PRIORITY_MOVE_ORDER: readonly PriorityMove[] = ['top', 'up', 'down', 'bottom'];

// --- Screen 0x2d: knight menu 2 -----------------------------------------------------------------

/** Icon table `@0x3cc28`. */
export const KNIGHT_POPUP_ICONS: readonly LayoutItem[] = [
  { icon: 9, col: 2, row: 8 },
  { icon: 29, col: 12, row: 8 },
  { icon: 300, col: 2, row: 28 },
  { icon: 59, col: 7, row: 44 },
  { icon: 130, col: 8, row: 28 },
  { icon: 58, col: 9, row: 44 },
  { icon: 304, col: 3, row: 64 },
  { icon: 303, col: 11, row: 64 },
  { icon: 302, col: 2, row: 84 },
  { icon: 220, col: 6, row: 84 },
  { icon: 220, col: 6, row: 100 },
  { icon: 301, col: 10, row: 84 },
  { icon: 220, col: 3, row: 120 },
  { icon: 221, col: 9, row: 120 },
  { icon: 60, col: 14, row: 128 },
];

export const KNIGHT_POPUP_RATE_SLIDER: SliderSpec = {
  col: 4,
  row: 0xc,
  action: 0xcb,
  list: 'serfToKnightRate',
  index: 0,
  playerOffset: 420,
};

/** The four recruit buttons (actions `0xcc`..`0xcf`) with their upper limit. */
export const KNIGHT_RECRUIT_COUNTS: readonly number[] = [1, 5, 20, 100];

/** Denominator of the morale percentage: `value * 100 / 0x1000` (32-bit division @0x3ca03). */
export const KNIGHT_MORALE_SCALE = 0x1000;

/** Panel positions of the numbers (renderer order). */
export const KNIGHT_MORALE_POS = { col: 6, row: 0x3f } as const;
export const KNIGHT_GOLD_POS = { col: 6, row: 0x49 } as const;
export const KNIGHT_VALUE_POS = { col: 6, row: 0x77 } as const;
export const KNIGHT_COUNTER_POS = { col: 6, row: 0x81 } as const;
export const KNIGHT_RECRUITABLE_POS = { col: 0xc, row: 0x28 } as const;
/** Tick icon of the attack choice and its two rows (`flags` bit 1 clear -> upper row). */
export const KNIGHT_CHECK_ICON = 0x120;
export const KNIGHT_CHECK_COL = 6;
export const KNIGHT_CHECK_ROW_WEAK = 0x54;
export const KNIGHT_CHECK_ROW_STRONG = 0x64;
/** Bounds of the counter `knightMenuValue` adjusted with `-`/`+` (`cmpw $0x1` / `$0x63`). */
export const KNIGHT_VALUE_MIN = 1;
export const KNIGHT_VALUE_MAX = 99;

// --- Click tables (verbatim) --------------------------------------------------------------------

/**
 * With `gs+0x37e` bit 5 set, **all eight** walkers take the same single-zone table `@0x2c857`: only
 * "RAUS". The settings are then locked. Kept here as a table of its own.
 */
export const SETTINGS_POPUP_LOCKED_HITBOXES: readonly HitRect[] = [
  { action: 0x63, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** Screen 0x1c — table `@0x2c85d`. */
export const FOOD_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x64, x0: 0x20, x1: 0x5f, y0: 0x16, y1: 0x1b },
  { action: 0x65, x0: 0x00, x1: 0x3f, y0: 0x2a, y1: 0x2f },
  { action: 0x66, x0: 0x40, x1: 0x7f, y0: 0x73, y1: 0x78 },
  { action: 0x67, x0: 0x20, x1: 0x5f, y0: 0x86, y1: 0x8b },
  { action: 0x63, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xbb, x0: 0x08, x1: 0x17, y0: 0x08, y1: 0x17 },
];

/** Screen 0x1d — Tabelle `@0x2c87c`. */
export const PLANKS_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x68, x0: 0x00, x1: 0x3f, y0: 0x1b, y1: 0x20 },
  { action: 0x69, x0: 0x00, x1: 0x3f, y0: 0x25, y1: 0x2a },
  { action: 0x6a, x0: 0x40, x1: 0x7f, y0: 0x2d, y1: 0x32 },
  { action: 0x6b, x0: 0x40, x1: 0x7f, y0: 0x68, y1: 0x6d },
  { action: 0x6c, x0: 0x00, x1: 0x3f, y0: 0x83, y1: 0x88 },
  { action: 0x63, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xbc, x0: 0x68, x1: 0x77, y0: 0x08, y1: 0x17 },
];

/** Screen 0x1e — Tabelle `@0x2c8a0`. */
export const COAL_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x6d, x0: 0x00, x1: 0x3f, y0: 0x28, y1: 0x2d },
  { action: 0x6e, x0: 0x40, x1: 0x7f, y0: 0x28, y1: 0x2d },
  { action: 0x6f, x0: 0x20, x1: 0x5f, y0: 0x30, y1: 0x35 },
  { action: 0x70, x0: 0x00, x1: 0x3f, y0: 0x5d, y1: 0x62 },
  { action: 0x71, x0: 0x40, x1: 0x7f, y0: 0x77, y1: 0x7c },
  { action: 0x63, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xd0, x0: 0x08, x1: 0x17, y0: 0x3c, y1: 0x4b },
];

/** Screen 0x1f — table `@0x2c8c4`: per group (max-, max+, min-, min+). */
export const OCCUPATION_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x72, x0: 0x20, x1: 0x2f, y0: 0x02, y1: 0x11 },
  { action: 0x73, x0: 0x30, x1: 0x3f, y0: 0x02, y1: 0x11 },
  { action: 0x74, x0: 0x20, x1: 0x2f, y0: 0x12, y1: 0x21 },
  { action: 0x75, x0: 0x30, x1: 0x3f, y0: 0x12, y1: 0x21 },
  { action: 0x76, x0: 0x20, x1: 0x2f, y0: 0x24, y1: 0x33 },
  { action: 0x77, x0: 0x30, x1: 0x3f, y0: 0x24, y1: 0x33 },
  { action: 0x78, x0: 0x20, x1: 0x2f, y0: 0x34, y1: 0x43 },
  { action: 0x79, x0: 0x30, x1: 0x3f, y0: 0x34, y1: 0x43 },
  { action: 0x7a, x0: 0x20, x1: 0x2f, y0: 0x46, y1: 0x55 },
  { action: 0x7b, x0: 0x30, x1: 0x3f, y0: 0x46, y1: 0x55 },
  { action: 0x7c, x0: 0x20, x1: 0x2f, y0: 0x56, y1: 0x65 },
  { action: 0x7d, x0: 0x30, x1: 0x3f, y0: 0x56, y1: 0x65 },
  { action: 0x7e, x0: 0x20, x1: 0x2f, y0: 0x68, y1: 0x77 },
  { action: 0x7f, x0: 0x30, x1: 0x3f, y0: 0x68, y1: 0x77 },
  { action: 0x80, x0: 0x20, x1: 0x2f, y0: 0x78, y1: 0x87 },
  { action: 0x81, x0: 0x30, x1: 0x3f, y0: 0x78, y1: 0x87 },
  { action: 0x63, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** Screen 0x20 — Tabelle `@0x2c91a`. */
export const TOOLS_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x82, x0: 0x20, x1: 0x5f, y0: 0x04, y1: 0x0b },
  { action: 0x83, x0: 0x20, x1: 0x5f, y0: 0x14, y1: 0x1b },
  { action: 0x84, x0: 0x20, x1: 0x5f, y0: 0x24, y1: 0x2b },
  { action: 0x85, x0: 0x20, x1: 0x5f, y0: 0x34, y1: 0x3b },
  { action: 0x86, x0: 0x20, x1: 0x5f, y0: 0x44, y1: 0x4b },
  { action: 0x87, x0: 0x20, x1: 0x5f, y0: 0x54, y1: 0x5b },
  { action: 0x88, x0: 0x20, x1: 0x5f, y0: 0x64, y1: 0x6b },
  { action: 0x89, x0: 0x20, x1: 0x5f, y0: 0x74, y1: 0x7b },
  { action: 0x8a, x0: 0x20, x1: 0x5f, y0: 0x84, y1: 0x8b },
  { action: 0x63, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xf2, x0: 0x68, x1: 0x77, y0: 0x08, y1: 0x17 },
];

/**
 * Screens 0x21 **and** 0x2e — **one** table `@0x2c952` for both (the actions tell them apart by the
 * running screen). The 26 zones `0x8b`..`0xa4` sit exactly on {@link PRIORITY_SLOT_POSITIONS}.
 */
export const PRIORITY_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x8b, x0: 0x28, x1: 0x37, y0: 0x04, y1: 0x13 },
  { action: 0x8c, x0: 0x38, x1: 0x47, y0: 0x06, y1: 0x15 },
  { action: 0x8d, x0: 0x48, x1: 0x57, y0: 0x08, y1: 0x17 },
  { action: 0x8e, x0: 0x58, x1: 0x67, y0: 0x0a, y1: 0x19 },
  { action: 0x8f, x0: 0x68, x1: 0x77, y0: 0x0c, y1: 0x1b },
  { action: 0x90, x0: 0x68, x1: 0x77, y0: 0x1c, y1: 0x2b },
  { action: 0x91, x0: 0x58, x1: 0x67, y0: 0x1e, y1: 0x2d },
  { action: 0x92, x0: 0x48, x1: 0x57, y0: 0x20, y1: 0x2f },
  { action: 0x93, x0: 0x38, x1: 0x47, y0: 0x22, y1: 0x31 },
  { action: 0x94, x0: 0x28, x1: 0x37, y0: 0x24, y1: 0x33 },
  { action: 0x95, x0: 0x18, x1: 0x27, y0: 0x26, y1: 0x35 },
  { action: 0x96, x0: 0x08, x1: 0x17, y0: 0x28, y1: 0x37 },
  { action: 0x97, x0: 0x08, x1: 0x17, y0: 0x38, y1: 0x47 },
  { action: 0x98, x0: 0x18, x1: 0x27, y0: 0x3a, y1: 0x49 },
  { action: 0x99, x0: 0x28, x1: 0x37, y0: 0x3c, y1: 0x4b },
  { action: 0x9a, x0: 0x38, x1: 0x47, y0: 0x3e, y1: 0x4d },
  { action: 0x9b, x0: 0x48, x1: 0x57, y0: 0x40, y1: 0x4f },
  { action: 0x9c, x0: 0x58, x1: 0x67, y0: 0x42, y1: 0x51 },
  { action: 0x9d, x0: 0x68, x1: 0x77, y0: 0x44, y1: 0x53 },
  { action: 0x9e, x0: 0x68, x1: 0x77, y0: 0x54, y1: 0x63 },
  { action: 0x9f, x0: 0x58, x1: 0x67, y0: 0x56, y1: 0x65 },
  { action: 0xa0, x0: 0x48, x1: 0x57, y0: 0x58, y1: 0x67 },
  { action: 0xa1, x0: 0x38, x1: 0x47, y0: 0x5a, y1: 0x69 },
  { action: 0xa2, x0: 0x28, x1: 0x37, y0: 0x5c, y1: 0x6b },
  { action: 0xa3, x0: 0x18, x1: 0x27, y0: 0x5e, y1: 0x6d },
  { action: 0xa4, x0: 0x08, x1: 0x17, y0: 0x60, y1: 0x6f },
  { action: 0xa5, x0: 0x08, x1: 0x17, y0: 0x78, y1: 0x87 },
  { action: 0xa6, x0: 0x18, x1: 0x27, y0: 0x78, y1: 0x87 },
  { action: 0xa7, x0: 0x48, x1: 0x57, y0: 0x78, y1: 0x87 },
  { action: 0xa8, x0: 0x58, x1: 0x67, y0: 0x78, y1: 0x87 },
  { action: 0x63, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xbd, x0: 0x08, x1: 0x17, y0: 0x04, y1: 0x13 },
];

/** Screen 0x2d — Tabelle `@0x2c9f3`. */
export const KNIGHT_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0xaf, x0: 0x50, x1: 0x6f, y0: 0x54, y1: 0x73 },
  { action: 0xcb, x0: 0x20, x1: 0x5f, y0: 0x0c, y1: 0x13 },
  { action: 0xcc, x0: 0x10, x1: 0x1f, y0: 0x1c, y1: 0x2b },
  { action: 0xcd, x0: 0x20, x1: 0x2f, y0: 0x1c, y1: 0x2b },
  { action: 0xce, x0: 0x10, x1: 0x1f, y0: 0x2c, y1: 0x3b },
  { action: 0xcf, x0: 0x20, x1: 0x2f, y0: 0x2c, y1: 0x3b },
  { action: 0xd1, x0: 0x30, x1: 0x3f, y0: 0x54, y1: 0x63 },
  { action: 0xd2, x0: 0x30, x1: 0x3f, y0: 0x64, y1: 0x73 },
  { action: 0xf8, x0: 0x18, x1: 0x27, y0: 0x78, y1: 0x87 },
  { action: 0xf9, x0: 0x48, x1: 0x57, y0: 0x78, y1: 0x87 },
  { action: 0x63, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** The eight screen numbers of this module. */
export const SETTINGS_SCREENS: readonly number[] = [0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x2d, 0x2e];

/** Slider list per screen (empty where the screen has none). */
export function settingsPopupSliders(screen: number): readonly SliderSpec[] {
  switch (screen) {
    case 0x1c:
      return FOOD_POPUP_SLIDERS;
    case 0x1d:
      return PLANKS_POPUP_SLIDERS;
    case 0x1e:
      return COAL_POPUP_SLIDERS;
    case 0x20:
      return TOOLS_POPUP_SLIDERS;
    case 0x2d:
      return [KNIGHT_POPUP_RATE_SLIDER];
    default:
      return [];
  }
}

/**
 * Click zones of a screen. `locked` == `gs+0x37e` bit 5, i.e. only "RAUS"
 * ({@link SETTINGS_POPUP_LOCKED_HITBOXES}).
 */
export function settingsPopupHitboxes(screen: number, locked = false): readonly HitRect[] {
  if (locked) return SETTINGS_POPUP_LOCKED_HITBOXES;
  switch (screen) {
    case 0x1c:
      return FOOD_POPUP_HITBOXES;
    case 0x1d:
      return PLANKS_POPUP_HITBOXES;
    case 0x1e:
      return COAL_POPUP_HITBOXES;
    case 0x1f:
      return OCCUPATION_POPUP_HITBOXES;
    case 0x20:
      return TOOLS_POPUP_HITBOXES;
    case 0x21:
    case 0x2e:
      return PRIORITY_POPUP_HITBOXES;
    case 0x2d:
      return KNIGHT_POPUP_HITBOXES;
    default:
      return [];
  }
}

// --- Actions ------------------------------------------------------------------------------------

/** Which of the two priority lists a screen edits (`vp[0x72] == 0x21` in the original). */
export type PriorityKind = 'transport' | 'evacuation';

export type SettingsPopupAction =
  /** "RAUS" (`0x63`): back to menu {@link SETTINGS_POPUP_MENU_SCREEN}. */
  | { readonly kind: 'menu' }
  /** Slider dragged; `clickX` is the x coordinate in click space. */
  | { readonly kind: 'slider'; readonly slider: SliderSpec; readonly clickX: number }
  /** Default button (`0xbb`/`0xbc`/`0xd0`/`0xf2`/`0xbd`) — sets the original defaults. */
  | { readonly kind: 'defaults' }
  /** Knight occupation, plus or minus. */
  | {
      readonly kind: 'occupation';
      readonly index: number;
      readonly bound: 'max' | 'min';
      readonly delta: -1 | 1;
    }
  /** Priority slot chosen: `slot` 0..25, corresponding to the priority **value** `26 - slot`. */
  | { readonly kind: 'prioritySelect'; readonly slot: number; readonly list: PriorityKind }
  /** Move the selected goods. */
  | { readonly kind: 'priorityMove'; readonly move: PriorityMove; readonly list: PriorityKind }
  /** Turn idle settlers straight into knights, at most `count` (1/5/20/100). */
  | { readonly kind: 'recruit'; readonly count: number }
  /**
   * Attack choice (`flags` bit 1). `strong` = lower row = the **stronger** knights attack; the default
   * is the upper row (bit clear) = the weaker ones attack.
   */
  | { readonly kind: 'attackSelection'; readonly strong: boolean }
  /**
   * Shift-change button (`0xaf`) -> `startKnightShift` (`engine/player-settings.ts`).
   *
   * **It needs no special click** — there is none anywhere on the popup path of the original: the
   * router `popup_click_router` @0x2bff7 jumps via `screen*8` into the screen handler, which only picks
   * the zone table, and the shared **zone walker** `@0x2cc98` compares nothing but `{x0,x1,y0,y1}`;
   * `vp[1]` bit 3 does not appear in it. (That distinguishes the popups from the control panel, where
   * individual icon branches do require the special click.)
   */
  | { readonly kind: 'knightRotation' }
  /** `-`/`+` on the counter {@link KNIGHT_VALUE_POS}. */
  | { readonly kind: 'knightValue'; readonly delta: -1 | 1 };

/** Action ids of the default buttons per screen (`0xbd` serves both 0x21 and 0x2e). */
const DEFAULT_BUTTON_ACTIONS = new Set([0xbb, 0xbc, 0xd0, 0xf2, 0xbd]);

/**
 * Maps an action id to its effect. `screen` is needed only where the same id serves two screens
 * (priority lists) or where the slider comes from the screen table.
 */
export function settingsPopupAction(
  screen: number,
  action: number,
  clickX = 0,
): SettingsPopupAction | null {
  if (action === 0x63) return { kind: 'menu' };
  if (DEFAULT_BUTTON_ACTIONS.has(action)) return { kind: 'defaults' };

  const slider = settingsPopupSliders(screen).find((s) => s.action === action);
  if (slider) return { kind: 'slider', slider, clickX };

  if (action >= 0x72 && action <= 0x81) {
    // 16 zones = 4 groups x (max-, max+, min-, min+); group order as in OCCUPATION_GROUPS.
    const i = action - 0x72;
    const group = OCCUPATION_GROUPS[i >> 2];
    if (!group) return null;
    return {
      kind: 'occupation',
      index: group.index,
      bound: (i & 2) === 0 ? 'max' : 'min',
      delta: (i & 1) === 0 ? -1 : 1,
    };
  }

  const list: PriorityKind = screen === 0x21 ? 'transport' : 'evacuation';
  if (action >= 0x8b && action <= 0xa4) return { kind: 'prioritySelect', slot: action - 0x8b, list };
  if (action >= 0xa5 && action <= 0xa8) {
    const move = PRIORITY_MOVE_ORDER[action - 0xa5];
    return move ? { kind: 'priorityMove', move, list } : null;
  }

  if (action >= 0xcc && action <= 0xcf) {
    const count = KNIGHT_RECRUIT_COUNTS[action - 0xcc];
    return count === undefined ? null : { kind: 'recruit', count };
  }
  if (action === 0xd1) return { kind: 'attackSelection', strong: false };
  if (action === 0xd2) return { kind: 'attackSelection', strong: true };
  if (action === 0xaf) return { kind: 'knightRotation' };
  if (action === 0xf8) return { kind: 'knightValue', delta: -1 };
  if (action === 0xf9) return { kind: 'knightValue', delta: 1 };
  return null;
}

/** Click in **drawing pixels** to action (`null` outside all zones). */
export function clickSettingsPopup(
  screen: number,
  drawX: number,
  drawY: number,
  locked = false,
): SettingsPopupAction | null {
  const action = hitTestPanel(settingsPopupHitboxes(screen, locked), drawX, drawY);
  if (action === null) return null;
  return settingsPopupAction(screen, action, drawX - 8);
}

// --- Drawing ------------------------------------------------------------------------------------

/** State the eight screens need for drawing. */
export interface SettingsPopupView {
  readonly foodDistribution: readonly number[];
  readonly planksDistribution: readonly number[];
  readonly steelDistribution: readonly number[];
  readonly coalDistribution: readonly number[];
  readonly wheatDistribution: readonly number[];
  readonly toolPriority: readonly number[];
  readonly flagPriority: readonly number[];
  readonly inventoryPriority: readonly number[];
  readonly knightOccupation: readonly number[];
  readonly serfToKnightRate: number;
  readonly currentSett5Item: number;
  readonly currentSett6Item: number;
  readonly goldMorale: number;
  readonly goldDeposited: number;
  readonly knightMenuValue: number;
  readonly knightMenuCounter: number;
  readonly flags: number;
  /** Sum of `min(idle settlers, swords, shields)` over the own stocks (engine side). */
  readonly recruitable: number;
}

/** Reads a slider value from the display state. */
export function sliderValue(view: SettingsPopupView, slider: SliderSpec): number {
  if (slider.list === 'serfToKnightRate') return view.serfToKnightRate;
  return view[slider.list][slider.index] ?? 0;
}

/**
 * Word choice of the occupation level — `FUN_0003c5d0` byte-exactly: `0 -> 0, 1 -> 1, < 3 -> 2,
 * == 3 -> 3, else -> 4`. The `< 3` branch catches exactly the 2; anything above 3 (i.e. 4) lands on
 * "VOLL".
 */
export function occupationLabel(level: number): string {
  const idx = level === 0 ? 0 : level === 1 ? 1 : level < 3 ? 2 : level === 3 ? 3 : 4;
  return OCCUPATION_LABELS[idx]!;
}

function drawSliderRow(
  fb: Framebuffer,
  provider: SpriteProvider,
  slider: SliderSpec,
  view: SettingsPopupView,
  barColor?: readonly [number, number, number],
): void {
  drawSlider(fb, provider, slider.col, slider.row, sliderValue(view, slider), barColor);
}

export interface SettingsPopupOptions {
  /** Bar colour (palette index `0x1e`) — without it the bar stays empty instead of being guessed. */
  readonly barColor?: readonly [number, number, number];
  readonly textColor: readonly [number, number, number];
}

/**
 * Draws one of the eight screens. Order per screen as in the original: background, layout table(s),
 * then the state-dependent elements in renderer order.
 */
export function drawSettingsPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  view: SettingsPopupView,
  opts: SettingsPopupOptions,
): boolean {
  if (!SETTINGS_SCREENS.includes(screen)) return false;
  tileBackground(fb, provider, SETTINGS_POPUP_BG_ICON);

  switch (screen) {
    case 0x1c:
    case 0x1d:
    case 0x1e: {
      const [objects, icons] =
        screen === 0x1c
          ? [FOOD_POPUP_OBJECTS, FOOD_POPUP_ICONS]
          : screen === 0x1d
            ? [PLANKS_POPUP_OBJECTS, PLANKS_POPUP_ICONS]
            : [COAL_POPUP_OBJECTS, COAL_POPUP_ICONS];
      drawLayout(fb, provider, objects, UI_OBJECT_BASE);
      drawLayout(fb, provider, icons, UI_ICON_BASE);
      for (const s of settingsPopupSliders(screen)) drawSliderRow(fb, provider, s, view, opts.barColor);
      return true;
    }
    case 0x1f: {
      // Original order: the four word pairs first, then the icon table.
      for (const g of OCCUPATION_GROUPS) {
        const b = view.knightOccupation[g.index] ?? 0;
        drawPanelText(
          fb,
          provider,
          t(occupationLabel((b >> 4) & 0xf)),
          OCCUPATION_TEXT_COL,
          g.textRow,
          opts.textColor,
        );
        drawPanelText(
          fb,
          provider,
          t(occupationLabel(b & 0xf)),
          OCCUPATION_TEXT_COL,
          g.textRow + OCCUPATION_MIN_ROW_DELTA,
          opts.textColor,
        );
      }
      drawLayout(fb, provider, OCCUPATION_POPUP_ICONS, UI_ICON_BASE);
      return true;
    }
    case 0x20: {
      drawLayout(fb, provider, TOOLS_POPUP_ICONS, UI_ICON_BASE);
      for (const s of TOOLS_POPUP_SLIDERS) drawSliderRow(fb, provider, s, view, opts.barColor);
      return true;
    }
    case 0x21:
    case 0x2e: {
      drawLayout(fb, provider, PRIORITY_POPUP_ICONS, UI_ICON_BASE);
      const prio = screen === 0x21 ? view.flagPriority : view.inventoryPriority;
      const cursor = screen === 0x21 ? view.currentSett5Item : view.currentSett6Item;
      for (let res = 0; res < PRIORITY_SLOT_POSITIONS.length; res++) {
        const slot = PRIORITY_SLOT_POSITIONS.length - (prio[res] ?? 0);
        const pos = PRIORITY_SLOT_POSITIONS[slot];
        if (pos) drawPanelIcon(fb, provider, RESOURCE_ICON_BASE + res, pos.col, pos.row);
      }
      // Selection icon: `cursor` is 1-based, so icon == cursor + 0x21 == (cursor - 1) + 0x22.
      drawPanelIcon(
        fb,
        provider,
        RESOURCE_ICON_BASE + cursor - 1,
        PRIORITY_CURSOR_COL,
        PRIORITY_CURSOR_ROW,
      );
      return true;
    }
    case 0x2d: {
      drawLayout(fb, provider, KNIGHT_POPUP_ICONS, UI_ICON_BASE);
      drawSliderRow(fb, provider, KNIGHT_POPUP_RATE_SLIDER, view, opts.barColor);
      const percent = Math.floor((view.goldMorale * 100) / KNIGHT_MORALE_SCALE);
      const cols = drawPanelNumber(fb, provider, percent, KNIGHT_MORALE_POS.col, KNIGHT_MORALE_POS.row);
      drawPanelText(
        fb,
        provider,
        t('%'),
        KNIGHT_MORALE_POS.col + cols,
        KNIGHT_MORALE_POS.row,
        opts.textColor,
      );
      drawPanelNumberWide(fb, provider, view.goldDeposited, KNIGHT_GOLD_POS.col, KNIGHT_GOLD_POS.row);
      drawPanelNumber(fb, provider, view.knightMenuValue, KNIGHT_VALUE_POS.col, KNIGHT_VALUE_POS.row);
      drawPanelNumber(
        fb,
        provider,
        view.knightMenuCounter,
        KNIGHT_COUNTER_POS.col,
        KNIGHT_COUNTER_POS.row,
      );
      drawPanelIcon(
        fb,
        provider,
        KNIGHT_CHECK_ICON,
        KNIGHT_CHECK_COL,
        (view.flags & 2) !== 0 ? KNIGHT_CHECK_ROW_STRONG : KNIGHT_CHECK_ROW_WEAK,
      );
      drawPanelNumber(
        fb,
        provider,
        view.recruitable,
        KNIGHT_RECRUITABLE_POS.col,
        KNIGHT_RECRUITABLE_POS.row,
      );
      return true;
    }
    default:
      return false;
  }
}
