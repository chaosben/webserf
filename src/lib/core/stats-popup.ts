/**
 * The twelve statistics screens behind the category icons of the statistics menu (screen 8).
 *
 * | Screen | Renderer | Content |
 * |---|---|---|
 * | 0x09 | `FUN_0003d3fb` | stock: 26 goods, summed over *all* own warehouses |
 * | 0x0a-0x0d | `FUN_0003f9d1` / `fad4` / `fc76` / `fde3` | buildings, four pages, "done + under construction" |
 * | 0x0e | `FUN_000416e8` | comparison curves of all four players |
 * | 0x10 | `FUN_00040117` | fill levels of the food/ore consumers |
 * | 0x11 | `FUN_0004051d` | fill levels of smelters/smithies + military gold |
 * | 0x12 | `FUN_0003db43` | 26 professions + total |
 * | 0x0f | `FUN_00040da7` | goods production curve, 26 goods selectable |
 * | 0x13 | `FUN_0003e12b` | profession pointers per branch |
 *
 * Click model: five screens have a single zone covering the whole area (`@0x2cb4f` / `@0x2cc1b`) that
 * returns to menu 8. The building pages add the page button (`0x26`) cycling 0x0a..0x0d (`@0x31d33`).
 * The comparison curves have eight zones for aspect and time window.
 */
import { CASTLE_POPUP_LAYOUT, CASTLE_POPUP_NUMBERS } from './building-popup.js';
import {
  drawIncrementIcon,
  drawLayout,
  drawPanelIcon,
  drawPanelIconRow,
  drawPanelNumber,
  drawPanelNumberWide,
  faceIcon,
  FACE_ICON_BASE,
  FACE_ICON_EMPTY,
  fillRect,
  hitTestPanel,
  putPixel,
  tileBackground,
  UI_ICON_BASE,
  UI_OBJECT_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';
import type { FillRule } from './engine/stats.js';

/** Background tile of every statistics screen (`draw_popup_background(0x81)`). */
export const STATS_POPUP_BG_ICON = 0x81;
/** Action `0x25` returns to the statistics menu (`vp[0x70] = 8`). */
export const STATS_MENU_SCREEN = 8;

/** The single zone four of the screens have: the whole area (`@0x2cb4f`, `@0x2cc1b`). */
export const STATS_FULL_AREA_HITBOXES: readonly HitRect[] = [
  { action: 0x25, x0: 0x00, x1: 0x7f, y0: 0x00, y1: 0x8f },
];

// --- Screen 0x09: stock ---------------------------------------------------------------------

/**
 * Layout table `@0x3d8f3` is the *same* memory as the castle window's (`@0x3d8ed`), 6 bytes later:
 * that one has one triple more in front (the page button `0x3d`) and then runs into this table. The
 * 26 number positions are identical too - same grid, different numbers (one warehouse vs. all).
 */
export const STOCK_STATS_LAYOUT: readonly LayoutItem[] = CASTLE_POPUP_LAYOUT.slice(1);
export const STOCK_STATS_NUMBERS = CASTLE_POPUP_NUMBERS;

/** Draw screen 0x09; `totals` comes from `stockTotals()`. */
export function drawStockStats(
  fb: Framebuffer,
  provider: SpriteProvider,
  totals: readonly number[],
): void {
  tileBackground(fb, provider, STATS_POPUP_BG_ICON);
  drawLayout(fb, provider, STOCK_STATS_LAYOUT, UI_ICON_BASE);
  for (const slot of STOCK_STATS_NUMBERS) {
    drawPanelNumber(fb, provider, totals[slot.resource] ?? 0, slot.col, slot.row);
  }
}

// --- Screens 0x0a..0x0d: building statistics -------------------------------------------------

/** One building entry of a page: number position + building type. */
export interface BuildingStatEntry {
  readonly col: number;
  readonly row: number;
  readonly type: number;
}

/** One page: object sprites (bank `0x4e2`) + the number entries. */
export interface BuildingStatPage {
  readonly screen: number;
  readonly objects: readonly LayoutItem[];
  readonly entries: readonly BuildingStatEntry[];
}

/**
 * The four pages. The original stores building types as field offsets into `completedBuildingCount`
 * (block 132) resp. `incompleteBuildingCount` (block 178); the two calls are a constant 46 bytes
 * apart. Back-computed: `type = (offset + 0x80 - 132) / 2 + 1`.
 *
 * Across all four pages every type 1..23 occurs exactly once - complete and without duplicates
 * (pinned by a test).
 */
export const BUILDING_STAT_PAGES: readonly BuildingStatPage[] = [
  {
    screen: 0x0a,
    objects: [
      { icon: 192, col: 0, row: 5 },
      { icon: 171, col: 2, row: 77 },
      { icon: 158, col: 8, row: 7 },
      { icon: 152, col: 6, row: 69 },
    ],
    entries: [
      { col: 2, row: 0x69, type: 11 }, // hut
      { col: 10, row: 0x35, type: 21 }, // tower
      { col: 9, row: 0x82, type: 22 }, // fortress
      { col: 4, row: 0x3d, type: 10 }, // warehouse
    ],
  },
  {
    screen: 0x0b,
    objects: [
      { icon: 153, col: 0, row: 4 },
      { icon: 160, col: 8, row: 6 },
      { icon: 157, col: 0, row: 68 },
      { icon: 169, col: 8, row: 65 },
      { icon: 174, col: 12, row: 57 },
      { icon: 170, col: 4, row: 105 },
      { icon: 168, col: 8, row: 107 },
    ],
    entries: [
      { col: 3, row: 0x36, type: 19 }, // toolmaker
      { col: 10, row: 0x30, type: 17 }, // sawmill
      { col: 3, row: 0x5f, type: 20 }, // weaponsmith
      { col: 8, row: 0x5f, type: 4 }, //  Steinmetz
      { col: 12, row: 0x5f, type: 3 }, // boat builder
      { col: 5, row: 0x84, type: 9 }, //  forester
      { col: 9, row: 0x84, type: 2 }, //  lumberjack
    ],
  },
  {
    screen: 0x0c,
    objects: [
      { icon: 155, col: 0, row: 2 },
      { icon: 154, col: 8, row: 3 },
      { icon: 167, col: 0, row: 61 },
      { icon: 156, col: 8, row: 60 },
      { icon: 188, col: 4, row: 75 },
      { icon: 162, col: 8, row: 100 },
    ],
    entries: [
      { col: 3, row: 0x30, type: 14 }, // pig farm
      { col: 11, row: 0x30, type: 12 }, // farm
      { col: 0, row: 0x5c, type: 1 }, //  fisher
      { col: 11, row: 0x57, type: 13 }, // butcher
      { col: 5, row: 0x86, type: 15 }, // mill
      { col: 10, row: 0x86, type: 16 }, // baker
    ],
  },
  {
    screen: 0x0d,
    objects: [
      { icon: 163, col: 0, row: 4 },
      { icon: 164, col: 4, row: 4 },
      { icon: 165, col: 8, row: 4 },
      { icon: 166, col: 12, row: 4 },
      { icon: 161, col: 2, row: 90 },
      { icon: 159, col: 8, row: 90 },
    ],
    entries: [
      { col: 0, row: 0x47, type: 5 }, //  stone mine
      { col: 4, row: 0x47, type: 6 }, //  coal mine
      { col: 8, row: 0x47, type: 7 }, //  iron mine
      { col: 12, row: 0x47, type: 8 }, // gold mine
      { col: 4, row: 0x82, type: 18 }, // steel smelter
      { col: 9, row: 0x82, type: 23 }, // gold smelter
    ],
  },
];

export const BUILDING_STAT_SCREENS: readonly number[] = BUILDING_STAT_PAGES.map((p) => p.screen);

/** The two separately drawn buttons of the building pages (page left, exit right). */
export const BUILDING_STAT_PAGE_BUTTON = { icon: 0x3d, col: 0, row: 0x80 } as const;
export const BUILDING_STAT_EXIT_BUTTON = { icon: 0x3c, col: 0xe, row: 0x80 } as const;

/** Click zones of the building pages - table `@0x2cb55`: exit + page. */
export const BUILDING_STAT_HITBOXES: readonly HitRect[] = [
  { action: 0x25, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0x26, x0: 0x00, x1: 0x0f, y0: 0x80, y1: 0x8f },
];

/** Page handler `@0x31d33`: `s + 1`, and `0x0e` wraps back to `0x0a`. */
export function nextBuildingStatScreen(screen: number): number {
  const next = screen + 1;
  return next === 0x0e ? 0x0a : next;
}

/**
 * Draw one building page. Per entry the count of finished buildings, directly behind it the "+n"
 * icon for those under construction - the "2+1" notation of the manual (p. 80).
 */
export function drawBuildingStats(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  completed: readonly number[],
  incomplete: readonly number[],
): boolean {
  const page = BUILDING_STAT_PAGES.find((p) => p.screen === screen);
  if (!page) return false;
  tileBackground(fb, provider, STATS_POPUP_BG_ICON);
  drawLayout(fb, provider, page.objects, UI_OBJECT_BASE);
  for (const e of page.entries) {
    // Array index j maps to building type j+1.
    const done = completed[e.type - 1] ?? 0;
    const cols = drawPanelNumber(fb, provider, done, e.col, e.row);
    drawIncrementIcon(fb, provider, incomplete[e.type - 1] ?? 0, e.col + cols, e.row);
  }
  drawPanelIcon(
    fb,
    provider,
    BUILDING_STAT_PAGE_BUTTON.icon,
    BUILDING_STAT_PAGE_BUTTON.col,
    BUILDING_STAT_PAGE_BUTTON.row,
  );
  drawPanelIcon(
    fb,
    provider,
    BUILDING_STAT_EXIT_BUTTON.icon,
    BUILDING_STAT_EXIT_BUTTON.col,
    BUILDING_STAT_EXIT_BUTTON.row,
  );
  return true;
}

// --- Screen 0x12: population statistics ------------------------------------------------------

/** Icon table `@0x3e08d`: 26 profession icons in three columns. */
export const SERF_STATS_LAYOUT: readonly LayoutItem[] = [
  { icon: 9, col: 1, row: 0 },
  { icon: 10, col: 1, row: 16 },
  { icon: 11, col: 1, row: 32 },
  { icon: 12, col: 1, row: 48 },
  { icon: 33, col: 1, row: 64 },
  { icon: 32, col: 1, row: 80 },
  { icon: 31, col: 1, row: 96 },
  { icon: 30, col: 1, row: 112 },
  { icon: 29, col: 1, row: 128 },
  { icon: 13, col: 6, row: 0 },
  { icon: 14, col: 6, row: 16 },
  { icon: 18, col: 6, row: 32 },
  { icon: 15, col: 6, row: 48 },
  { icon: 16, col: 6, row: 64 },
  { icon: 17, col: 6, row: 80 },
  { icon: 25, col: 6, row: 96 },
  { icon: 26, col: 6, row: 112 },
  { icon: 27, col: 6, row: 128 },
  { icon: 19, col: 11, row: 0 },
  { icon: 20, col: 11, row: 16 },
  { icon: 21, col: 11, row: 32 },
  { icon: 22, col: 11, row: 48 },
  { icon: 23, col: 11, row: 64 },
  { icon: 24, col: 11, row: 80 },
  { icon: 28, col: 11, row: 96 },
  { icon: 130, col: 11, row: 112 },
];

/**
 * The 26 number slots with their serf type (`serfCount` index), in the renderer's order; each number
 * sits two columns right and four rows below its icon - the same rule as in the castle window. Type
 * 4 does not occur (the internal duplicate), just as in the total.
 */
export const SERF_STATS_NUMBERS: readonly { readonly type: number; readonly col: number; readonly row: number }[] =
  [
    { type: 0, col: 3, row: 0x04 },
    { type: 1, col: 3, row: 0x14 },
    { type: 2, col: 3, row: 0x24 },
    { type: 3, col: 3, row: 0x34 },
    { type: 26, col: 3, row: 0x44 },
    { type: 25, col: 3, row: 0x54 },
    { type: 24, col: 3, row: 0x64 },
    { type: 23, col: 3, row: 0x74 },
    { type: 22, col: 3, row: 0x84 },
    { type: 5, col: 8, row: 0x04 },
    { type: 6, col: 8, row: 0x14 },
    { type: 10, col: 8, row: 0x24 },
    { type: 7, col: 8, row: 0x34 },
    { type: 8, col: 8, row: 0x44 },
    { type: 9, col: 8, row: 0x54 },
    { type: 17, col: 8, row: 0x64 },
    { type: 18, col: 8, row: 0x74 },
    { type: 19, col: 8, row: 0x84 },
    { type: 11, col: 0xd, row: 0x04 },
    { type: 12, col: 0xd, row: 0x14 },
    { type: 13, col: 0xd, row: 0x24 },
    { type: 14, col: 0xd, row: 0x34 },
    { type: 15, col: 0xd, row: 0x44 },
    { type: 16, col: 0xd, row: 0x54 },
    { type: 20, col: 0xd, row: 0x64 },
    { type: 21, col: 0xd, row: 0x74 },
  ];

/** Slot of the total (drawn with the five-digit primitive, and only when > 0). */
export const SERF_STATS_TOTAL_POS = { col: 0xb, row: 0x84 } as const;

/** Draw screen 0x12; `total` comes from `serfCensusTotal()`. */
export function drawSerfStats(
  fb: Framebuffer,
  provider: SpriteProvider,
  serfCount: readonly number[],
  total: number,
): void {
  tileBackground(fb, provider, STATS_POPUP_BG_ICON);
  drawLayout(fb, provider, SERF_STATS_LAYOUT, UI_ICON_BASE);
  for (const slot of SERF_STATS_NUMBERS) {
    drawPanelNumber(fb, provider, serfCount[slot.type] ?? 0, slot.col, slot.row);
  }
  if (total !== 0) {
    drawPanelNumberWide(fb, provider, total, SERF_STATS_TOTAL_POS.col, SERF_STATS_TOTAL_POS.row);
  }
}

// --- Screens 0x10 / 0x11: fill levels --------------------------------------------------------

/** One display slot: stock byte offset, position, and which of the two icon ladders applies. */
export interface FillDisplay {
  readonly byteSlot: number;
  readonly col: number;
  readonly row: number;
  readonly ladder: 'up' | 'down';
}

/** Type chain of screen 0x10 (`@0x40167`..): eight food/ore consumers, each `bld+8`. */
export const FILL_RULES_FOOD: readonly FillRule[] = [
  { codedType: 0x3c, byteSlot: 0x00, kind: 'stock8' }, // mill
  { codedType: 0x40, byteSlot: 0x06, kind: 'stock8' }, // baker
  { codedType: 0x38, byteSlot: 0x0c, kind: 'stock8' }, // pig farm
  { codedType: 0x34, byteSlot: 0x12, kind: 'stock8' }, // butcher
  { codedType: 0x20, byteSlot: 0x18, kind: 'stock8' }, // gold mine
  { codedType: 0x18, byteSlot: 0x1e, kind: 'stock8' }, // coal mine
  { codedType: 0x1c, byteSlot: 0x24, kind: 'stock8' }, // iron mine
  { codedType: 0x14, byteSlot: 0x2a, kind: 'stock8' }, // stone mine
];
export const FILL_SLOTS_FOOD = 12;
export const FILL_DISPLAY_FOOD: readonly FillDisplay[] = [
  { byteSlot: 0x00, col: 10, row: 0x00, ladder: 'down' },
  { byteSlot: 0x06, col: 2, row: 0x00, ladder: 'down' },
  { byteSlot: 0x0c, col: 10, row: 0x20, ladder: 'up' },
  { byteSlot: 0x12, col: 2, row: 0x20, ladder: 'down' },
  { byteSlot: 0x18, col: 10, row: 0x38, ladder: 'up' },
  { byteSlot: 0x1e, col: 10, row: 0x50, ladder: 'up' },
  { byteSlot: 0x24, col: 10, row: 0x68, ladder: 'up' },
  { byteSlot: 0x2a, col: 10, row: 0x80, ladder: 'up' },
];

/** Type chain of screen 0x11: smelters, smithies, sawmill, boat builder and military gold. */
export const FILL_RULES_INDUSTRY: readonly FillRule[] = [
  { codedType: 0x5c, byteSlot: 0x00, kind: 'stock9' }, // gold smelter: gold ore
  { codedType: 0x5c, byteSlot: 0x06, kind: 'stock8' }, // gold smelter: coal
  { codedType: 0x48, byteSlot: 0x0c, kind: 'stock8' }, // steel smelter: coal
  { codedType: 0x48, byteSlot: 0x12, kind: 'stock9' }, // steel smelter: iron ore
  { codedType: 0x44, byteSlot: 0x18, kind: 'stock9' }, // sawmill: logs
  { codedType: 0x2c, byteSlot: 0x1e, kind: 'gold2' }, // hut: gold
  { codedType: 0x54, byteSlot: 0x1e, kind: 'gold4' }, // tower: gold
  { codedType: 0x58, byteSlot: 0x1e, kind: 'gold8' }, // fortress: gold
  { codedType: 0x50, byteSlot: 0x24, kind: 'stock8' }, // weaponsmith: coal
  { codedType: 0x50, byteSlot: 0x2a, kind: 'stock9' }, // weaponsmith: steel
  { codedType: 0x4c, byteSlot: 0x30, kind: 'stock9' }, // toolmaker: steel
  { codedType: 0x4c, byteSlot: 0x36, kind: 'stock8' }, // toolmaker: planks
  { codedType: 0x0c, byteSlot: 0x3c, kind: 'stock8' }, // boat builder: planks
  { codedType: 0x0c, byteSlot: 0x42, kind: 'norm8' },
  { codedType: 0x0c, byteSlot: 0x48, kind: 'norm9' },
];
export const FILL_SLOTS_INDUSTRY = 20;
export const FILL_DISPLAY_INDUSTRY: readonly FillDisplay[] = [
  { byteSlot: 0x00, col: 6, row: 0x00, ladder: 'down' },
  { byteSlot: 0x06, col: 6, row: 0x10, ladder: 'down' },
  { byteSlot: 0x0c, col: 6, row: 0x28, ladder: 'down' },
  { byteSlot: 0x12, col: 6, row: 0x38, ladder: 'down' },
  { byteSlot: 0x18, col: 6, row: 0x50, ladder: 'down' },
  { byteSlot: 0x1e, col: 0xc, row: 0x00, ladder: 'up' },
  { byteSlot: 0x24, col: 0xc, row: 0x14, ladder: 'down' },
  { byteSlot: 0x2a, col: 0xc, row: 0x24, ladder: 'down' },
  { byteSlot: 0x30, col: 0xc, row: 0x38, ladder: 'down' },
  { byteSlot: 0x36, col: 0xc, row: 0x48, ladder: 'down' },
  { byteSlot: 0x3c, col: 0xc, row: 0x5c, ladder: 'down' },
  { byteSlot: 0x42, col: 0xc, row: 0x70, ladder: 'up' },
  { byteSlot: 0x48, col: 0xc, row: 0x80, ladder: 'up' },
];

/**
 * Thresholds of the icon ladder. Both drawers (`FUN_00040bfb` upwards, `FUN_00040cd1` downwards) use
 * the same ten values, only in opposite direction; the step is a constant 0x17.
 */
export const FILL_LADDER_THRESHOLDS: readonly number[] = [
  0x16, 0x2d, 0x44, 0x5b, 0x72, 0x89, 0xa0, 0xb7, 0xce, 0xe5,
];
/** Base icon and empty icon of the two ladders. */
export const FILL_LADDER_UP_BASE = 0xbc;
export const FILL_LADDER_UP_EMPTY = 0xbc + 0xb;
export const FILL_LADDER_DOWN_BASE = 0xd2;
export const FILL_LADDER_DOWN_EMPTY = 0xd2 + 1;

/**
 * Icon of one fill-level slot. Without a contributing building (`count == 0`) the empty icon; else
 * `q = (sum << 4) / count` run through the ladder - `up` counts up from the base icon, `down` counts
 * down from it.
 */
export function fillLadderIcon(ladder: 'up' | 'down', sum: number, count: number): number {
  if (count === 0) return ladder === 'up' ? FILL_LADDER_UP_EMPTY : FILL_LADDER_DOWN_EMPTY;
  const q = Math.floor((sum << 4) / count);
  let steps = 0;
  for (const t of FILL_LADDER_THRESHOLDS) {
    if (q <= t) break;
    steps += 1;
  }
  return ladder === 'up' ? FILL_LADDER_UP_BASE + steps : FILL_LADDER_DOWN_BASE - steps;
}

/** Icon table of screen 0x10 (`@0x403f5`): the diagram of arrows and goods icons. */
export const FILL_LAYOUT_FOOD: readonly LayoutItem[] = [
  { icon: 24, col: 0, row: 0 }, { icon: 180, col: 0, row: 16 }, { icon: 179, col: 0, row: 24 },
  { icon: 178, col: 0, row: 32 }, { icon: 179, col: 0, row: 40 }, { icon: 178, col: 0, row: 48 },
  { icon: 179, col: 0, row: 56 }, { icon: 178, col: 0, row: 64 }, { icon: 179, col: 0, row: 72 },
  { icon: 178, col: 0, row: 80 }, { icon: 179, col: 0, row: 88 }, { icon: 212, col: 0, row: 96 },
  { icon: 177, col: 0, row: 112 }, { icon: 19, col: 0, row: 120 }, { icon: 21, col: 2, row: 48 },
  { icon: 180, col: 2, row: 64 }, { icon: 179, col: 2, row: 72 }, { icon: 212, col: 2, row: 80 },
  { icon: 164, col: 2, row: 96 }, { icon: 164, col: 2, row: 112 }, { icon: 174, col: 4, row: 4 },
  { icon: 174, col: 4, row: 36 }, { icon: 166, col: 4, row: 80 }, { icon: 166, col: 4, row: 96 },
  { icon: 166, col: 4, row: 112 }, { icon: 38, col: 6, row: 0 }, { icon: 35, col: 6, row: 32 },
  { icon: 181, col: 6, row: 64 }, { icon: 36, col: 6, row: 76 }, { icon: 39, col: 6, row: 92 },
  { icon: 34, col: 6, row: 108 }, { icon: 182, col: 6, row: 124 }, { icon: 23, col: 8, row: 0 },
  { icon: 20, col: 8, row: 32 }, { icon: 166, col: 8, row: 64 }, { icon: 171, col: 8, row: 88 },
  { icon: 171, col: 8, row: 104 }, { icon: 166, col: 8, row: 128 }, { icon: 186, col: 12, row: 8 },
  { icon: 17, col: 12, row: 56 }, { icon: 17, col: 12, row: 80 }, { icon: 17, col: 12, row: 104 },
  { icon: 17, col: 12, row: 128 }, { icon: 22, col: 14, row: 0 }, { icon: 37, col: 14, row: 16 },
  { icon: 47, col: 14, row: 56 }, { icon: 46, col: 14, row: 80 }, { icon: 44, col: 14, row: 104 },
  { icon: 43, col: 14, row: 128 },
];

/** Icon table of screen 0x11 (`@0x40919`). */
export const FILL_LAYOUT_INDUSTRY: readonly LayoutItem[] = [
  { icon: 17, col: 0, row: 0 }, { icon: 17, col: 0, row: 24 }, { icon: 17, col: 0, row: 56 },
  { icon: 13, col: 0, row: 80 }, { icon: 17, col: 0, row: 104 }, { icon: 15, col: 0, row: 128 },
  { icon: 47, col: 2, row: 0 }, { icon: 46, col: 2, row: 24 }, { icon: 176, col: 2, row: 40 },
  { icon: 44, col: 2, row: 56 }, { icon: 40, col: 2, row: 80 }, { icon: 43, col: 2, row: 104 },
  { icon: 43, col: 2, row: 128 }, { icon: 170, col: 4, row: 4 }, { icon: 171, col: 4, row: 24 },
  { icon: 173, col: 4, row: 32 }, { icon: 168, col: 4, row: 40 }, { icon: 172, col: 4, row: 60 },
  { icon: 170, col: 4, row: 84 }, { icon: 187, col: 4, row: 108 }, { icon: 164, col: 6, row: 32 },
  { icon: 14, col: 6, row: 96 }, { icon: 165, col: 6, row: 132 }, { icon: 48, col: 8, row: 0 },
  { icon: 18, col: 8, row: 16 }, { icon: 164, col: 8, row: 32 }, { icon: 45, col: 8, row: 40 },
  { icon: 18, col: 8, row: 56 }, { icon: 184, col: 8, row: 80 }, { icon: 41, col: 8, row: 96 },
  { icon: 175, col: 8, row: 112 }, { icon: 165, col: 8, row: 132 }, { icon: 170, col: 10, row: 4 },
  { icon: 185, col: 10, row: 24 }, { icon: 171, col: 10, row: 40 }, { icon: 183, col: 10, row: 48 },
  { icon: 166, col: 10, row: 80 }, { icon: 169, col: 10, row: 96 }, { icon: 166, col: 10, row: 112 },
  { icon: 167, col: 10, row: 132 }, { icon: 33, col: 14, row: 0 }, { icon: 27, col: 14, row: 28 },
  { icon: 26, col: 14, row: 64 }, { icon: 25, col: 14, row: 92 }, { icon: 12, col: 14, row: 120 },
];

/** Draw one of the two fill-level screens; `slots` comes from `collectFillLevels()`. */
export function drawFillStats(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  slots: readonly { readonly sum: number; readonly count: number }[],
): boolean {
  const food = screen === 0x10;
  if (!food && screen !== 0x11) return false;
  tileBackground(fb, provider, STATS_POPUP_BG_ICON);
  drawLayout(fb, provider, food ? FILL_LAYOUT_FOOD : FILL_LAYOUT_INDUSTRY, UI_ICON_BASE);
  for (const d of food ? FILL_DISPLAY_FOOD : FILL_DISPLAY_INDUSTRY) {
    const slot = slots[d.byteSlot / 6] ?? { sum: 0, count: 0 };
    drawPanelIcon(fb, provider, fillLadderIcon(d.ladder, slot.sum, slot.count), d.col, d.row);
  }
  return true;
}

// --- Screen 0x0e: comparison curves ----------------------------------------------------------

/** Background bands: seven rows with `0x84 + level`, then three fixed bands. */
export const COMPARE_BAND_ROWS: readonly number[] = [0, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60];
export const COMPARE_BAND_BASE_ICON = 0x84;
export const COMPARE_FIXED_BANDS: readonly { readonly row: number; readonly icon: number }[] = [
  { row: 0x6c, icon: 0x88 },
  { row: 0x74, icon: 0x81 },
  { row: 0x84, icon: 0x89 },
];

/** Icon table `@0x41b6f`. */
export const COMPARE_LAYOUT: readonly LayoutItem[] = [
  { icon: 88, col: 14, row: 0 },
  { icon: 89, col: 0, row: 100 },
  { icon: 65, col: 8, row: 112 },
  { icon: 66, col: 10, row: 112 },
  { icon: 67, col: 8, row: 128 },
  { icon: 68, col: 10, row: 128 },
  { icon: 69, col: 2, row: 112 },
  { icon: 64, col: 4, row: 112 },
  { icon: 62, col: 2, row: 128 },
  { icon: 63, col: 4, row: 128 },
  { icon: 307, col: 14, row: 112 },
  { icon: 60, col: 14, row: 128 },
];

/** Check icon of the two selection groups and their origins (`+5` cols / `+0x10` rows per bit). */
export const COMPARE_CHECK_ICON = 0x6a;
export const COMPARE_ASPECT_CHECK_ORIGIN = { col: 1, row: 0x74 } as const;
export const COMPARE_LEVEL_CHECK_ORIGIN = { col: 7, row: 0x74 } as const;
export const COMPARE_CHECK_COL_STEP = 5;
export const COMPARE_CHECK_ROW_STEP = 0x10;

/** Three legend icons: `0x5e + 3*level + {0,1,2}` at columns 2 / 6 / 10, row 0x67. */
export const COMPARE_LEGEND_BASE_ICON = 0x5e;
export const COMPARE_LEGEND_COLS: readonly number[] = [2, 6, 10];
export const COMPARE_LEGEND_ROW = 0x67;

/** Curve geometry: x runs from `0x77` *down* to `8`, y = `0x6c - value`, ring of 112 samples. */
export const CURVE_X_START = 0x77;
export const CURVE_X_END = 8;
export const CURVE_Y_BASE = 0x6c;
export const CURVE_RING_LAST = 0x6f;

/** Palette indices of the four player curves, in the original's drawing order (3, 2, 1, 0). */
export const COMPARE_CURVE_ORDER: readonly { readonly slot: number; readonly colorIndex: number }[] = [
  { slot: 3, colorIndex: 0x4c },
  { slot: 2, colorIndex: 0x44 },
  { slot: 1, colorIndex: 0x48 },
  { slot: 0, colorIndex: 0x40 },
];

/** `mode = (aspect << 2) | level` - the field `vp[0xd4]`. */
export const compareMode = (aspect: number, level: number): number => ((aspect & 3) << 2) | (level & 3);
export const compareAspect = (mode: number): number => (mode >> 2) & 3;
export const compareLevel = (mode: number): number => mode & 3;

/**
 * One curve - `FUN_00041a03`, pixel by pixel:
 *
 * ```
 * prev = ring[i--]                          // i wraps from 0 to 0x6f (112 samples)
 * x = 0x77
 * do {
 *   cur = ring[i--] ; d = cur - prev
 *   y = 0x6c - prev ; prev = cur
 *   half = |d| >> 1 ; rest = |d| - half
 *   half+1 pixels in column x, then x--, then `rest` pixels   // y moves with the sign of d
 * } while (x != 8)
 * ```
 *
 * Values are percentages normalised to 0..100, so `y = 0x6c - value` places them between rows 8 and
 * 108. The staircase of `|d|+1` pixels across two columns is what turns 112 samples into a line.
 */
export function drawStatCurve(
  fb: Framebuffer,
  samples: readonly number[],
  startIndex: number,
  color: readonly [number, number, number],
): void {
  let index = startIndex;
  const next = (): number => {
    const v = (samples[index] ?? 0) & 0xff;
    index = index === 0 ? CURVE_RING_LAST : index - 1;
    return v;
  };
  let prev = next();
  let x = CURVE_X_START;
  do {
    const cur = next();
    const d = cur - prev;
    let y = CURVE_Y_BASE - prev;
    prev = cur;
    const step = d < 0 ? 1 : -1;
    const total = Math.abs(d);
    const half = total >> 1;
    const rest = total - half;
    for (let i = 0; i <= half; i++) {
      putPixel(fb, x, y, color);
      y += step;
    }
    x -= 1;
    for (let i = 0; i < rest; i++) {
      putPixel(fb, x, y, color);
      y += step;
    }
  } while (x !== CURVE_X_END);
}

/** Click zones of the comparison curves - table `@0x2cb60`. */
export const COMPARE_HITBOXES: readonly HitRect[] = [
  { action: 0x25, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0x28, x0: 0x10, x1: 0x1f, y0: 0x70, y1: 0x7f },
  { action: 0x29, x0: 0x20, x1: 0x2f, y0: 0x70, y1: 0x7f },
  { action: 0x2a, x0: 0x10, x1: 0x1f, y0: 0x80, y1: 0x8f },
  { action: 0x2b, x0: 0x20, x1: 0x2f, y0: 0x80, y1: 0x8f },
  { action: 0x2c, x0: 0x40, x1: 0x4f, y0: 0x70, y1: 0x7f },
  { action: 0x2d, x0: 0x50, x1: 0x5f, y0: 0x70, y1: 0x7f },
  { action: 0x2e, x0: 0x40, x1: 0x4f, y0: 0x80, y1: 0x8f },
  { action: 0x2f, x0: 0x50, x1: 0x5f, y0: 0x80, y1: 0x8f },
  { action: 0xf3, x0: 0x70, x1: 0x7f, y0: 0x70, y1: 0x7d },
];

/** What a click in the statistics screens triggers. */
export type StatsPopupAction =
  /** Back to the statistics menu (action `0x25`). */
  | { readonly kind: 'menu' }
  /** Page through the building statistics (action `0x26`). */
  | { readonly kind: 'page'; readonly screen: number }
  /** Category of the comparison curves (`0x28`..`0x2b`). */
  | { readonly kind: 'aspect'; readonly aspect: number }
  /** Time window of the comparison curves (`0x2c`..`0x2f`). */
  | { readonly kind: 'level'; readonly level: number }
  /** Resource of the production curve (`0x30`..`0x49`); the original stores `resource + 1` in `vp[0xd6]`. */
  | { readonly kind: 'resource'; readonly resource: number }
  /** Screen change: `0xf3` to the colour legend `0x35`, `0x1f` back to the curves `0x0e`. */
  | { readonly kind: 'screen'; readonly screen: number };

/** Click zones of a statistics screen. */
export function statsPopupHitboxes(screen: number): readonly HitRect[] {
  if (BUILDING_STAT_SCREENS.includes(screen)) return BUILDING_STAT_HITBOXES;
  if (screen === 0x0e) return COMPARE_HITBOXES;
  if (screen === 0x0f) return RESOURCE_STATS_HITBOXES;
  if (screen === 0x35) return PLAYER_LEGEND_HITBOXES;
  if (screen === 0x09 || screen === 0x10 || screen === 0x11 || screen === 0x12 || screen === 0x13) {
    return STATS_FULL_AREA_HITBOXES;
  }
  return [];
}

/** Action id to effect. */
export function statsPopupAction(screen: number, action: number): StatsPopupAction | null {
  if (action === 0x25) return { kind: 'menu' };
  if (action === 0x26) return { kind: 'page', screen: nextBuildingStatScreen(screen) };
  if (action >= 0x28 && action <= 0x2b) return { kind: 'aspect', aspect: action - 0x28 };
  if (action >= 0x2c && action <= 0x2f) return { kind: 'level', level: action - 0x2c };
  if (action >= RESOURCE_SELECT_ACTION_BASE && action <= RESOURCE_SELECT_ACTION_BASE + 0x19) {
    return { kind: 'resource', resource: action - RESOURCE_SELECT_ACTION_BASE };
  }
  if (action === 0xf3) return { kind: 'screen', screen: 0x35 };
  if (action === 0x1f) return { kind: 'screen', screen: 0x0e };
  return null;
}

/** Click in drawing pixels to effect. */
export function clickStatsPopup(
  screen: number,
  drawX: number,
  drawY: number,
): StatsPopupAction | null {
  const action = hitTestPanel(statsPopupHitboxes(screen), drawX, drawY);
  return action === null ? null : statsPopupAction(screen, action);
}

/** Inputs of the comparison curves. */
export interface CompareStatsView {
  /** `vp[0xd4]` - `(aspect << 2) | level`. */
  readonly mode: number;
  /** Ring head per level: `playerHistoryIndex[level]` from the header. */
  readonly ringIndex: readonly number[];
  /** `statHistory` per player slot (`null` = slot inactive), grid `[mode][sample]`. */
  readonly histories: readonly (readonly (readonly number[])[] | null)[];
}

/** Draw screen 0x0e. `color` resolves a palette index to RGB (curves + bands). */
export function drawCompareStats(
  fb: Framebuffer,
  provider: SpriteProvider,
  view: CompareStatsView,
  color?: (paletteIndex: number) => readonly [number, number, number],
): void {
  const level = compareLevel(view.mode);
  for (const row of COMPARE_BAND_ROWS) {
    drawPanelIconRow(fb, provider, row, COMPARE_BAND_BASE_ICON + level);
  }
  for (const b of COMPARE_FIXED_BANDS) drawPanelIconRow(fb, provider, b.row, b.icon);
  drawLayout(fb, provider, COMPARE_LAYOUT, UI_ICON_BASE);

  const aspect = compareAspect(view.mode);
  drawPanelIcon(
    fb,
    provider,
    COMPARE_CHECK_ICON,
    COMPARE_ASPECT_CHECK_ORIGIN.col + ((aspect & 1) !== 0 ? COMPARE_CHECK_COL_STEP : 0),
    COMPARE_ASPECT_CHECK_ORIGIN.row + ((aspect & 2) !== 0 ? COMPARE_CHECK_ROW_STEP : 0),
  );
  drawPanelIcon(
    fb,
    provider,
    COMPARE_CHECK_ICON,
    COMPARE_LEVEL_CHECK_ORIGIN.col + ((level & 1) !== 0 ? COMPARE_CHECK_COL_STEP : 0),
    COMPARE_LEVEL_CHECK_ORIGIN.row + ((level & 2) !== 0 ? COMPARE_CHECK_ROW_STEP : 0),
  );
  COMPARE_LEGEND_COLS.forEach((col, i) => {
    drawPanelIcon(
      fb,
      provider,
      COMPARE_LEGEND_BASE_ICON + level * 3 + i,
      col,
      COMPARE_LEGEND_ROW,
    );
  });

  if (color === undefined) return; // no palette, no curves - rather than inventing colours
  const start = view.ringIndex[level] ?? 0;
  for (const c of COMPARE_CURVE_ORDER) {
    const history = view.histories[c.slot];
    if (!history) continue;
    const samples = history[view.mode];
    if (!samples || samples.length === 0) continue;
    drawStatCurve(fb, samples, start, color(c.colorIndex));
  }
}


// --- Screen 0x0f: goods production curve -----------------------------------------------------

/**
 * Three background bands (`draw_panel_icon_row`) plus the watermark grid above them: the renderer
 * first tiles rows 0x40/0x70/0x80 with the standard tile, then the upper half with a tile that
 * depends on the selected resource (`0x89 + vp[0xd6]`).
 */
export const RESOURCE_STATS_BAND_ROWS: readonly number[] = [0x40, 0x70, 0x80];
/** Watermark tile = `0x89 + (resource + 1)`, i.e. `0x8a + resource`. */
export const RESOURCE_STATS_WATERMARK_BASE = 0x89;
/** Watermark grid: `col = 0xc..0` step -2, `row = 0x30..0` step -0x10. */
export const RESOURCE_STATS_WATERMARK_COLS: readonly number[] = [0xc, 0xa, 8, 6, 4, 2, 0];
export const RESOURCE_STATS_WATERMARK_ROWS: readonly number[] = [0x30, 0x20, 0x10, 0x00];

/** Layout table `@0x41620`: the 26 resource selection icons, two filler tiles and the exit button. */
export const RESOURCE_STATS_LAYOUT: readonly LayoutItem[] = [
  { icon: 0x81, col: 6, row: 0x50 },
  { icon: 0x81, col: 8, row: 0x50 },
  { icon: 0x81, col: 6, row: 0x60 },
  { icon: 0x81, col: 8, row: 0x60 },
  { icon: 0x59, col: 0, row: 0x40 },
  { icon: 0x5a, col: 14, row: 0x00 },
  { icon: 0x28, col: 0, row: 0x4b },
  { icon: 0x29, col: 2, row: 0x4b },
  { icon: 0x2b, col: 4, row: 0x4b },
  { icon: 0x2e, col: 0, row: 0x5b },
  { icon: 0x2c, col: 2, row: 0x5b },
  { icon: 0x2f, col: 4, row: 0x5b },
  { icon: 0x2a, col: 0, row: 0x6b },
  { icon: 0x2d, col: 2, row: 0x6b },
  { icon: 0x30, col: 4, row: 0x6b },
  { icon: 0x3a, col: 7, row: 0x53 },
  { icon: 0x3b, col: 7, row: 0x63 },
  { icon: 0x31, col: 10, row: 0x4b },
  { icon: 0x32, col: 12, row: 0x4b },
  { icon: 0x36, col: 14, row: 0x4b },
  { icon: 0x37, col: 10, row: 0x5b },
  { icon: 0x38, col: 12, row: 0x5b },
  { icon: 0x35, col: 14, row: 0x5b },
  { icon: 0x34, col: 10, row: 0x6b },
  { icon: 0x39, col: 12, row: 0x6b },
  { icon: 0x33, col: 14, row: 0x6b },
  { icon: 0x22, col: 1, row: 0x7d },
  { icon: 0x23, col: 3, row: 0x7d },
  { icon: 0x24, col: 5, row: 0x7d },
  { icon: 0x25, col: 7, row: 0x7d },
  { icon: 0x26, col: 9, row: 0x7d },
  { icon: 0x27, col: 11, row: 0x7d },
  { icon: 0x3c, col: 14, row: 0x80 },
];

/** Click zones `@0x2cb93`: 26 resource selection fields (`0x30`..`0x49`) and exit (`0x25`). */
export const RESOURCE_STATS_HITBOXES: readonly HitRect[] = [
  { action: 0x36, x0: 0x00, x1: 0x0f, y0: 0x4b, y1: 0x5a },
  { action: 0x37, x0: 0x10, x1: 0x1f, y0: 0x4b, y1: 0x5a },
  { action: 0x39, x0: 0x20, x1: 0x2f, y0: 0x4b, y1: 0x5a },
  { action: 0x3c, x0: 0x00, x1: 0x0f, y0: 0x5b, y1: 0x6a },
  { action: 0x3a, x0: 0x10, x1: 0x1f, y0: 0x5b, y1: 0x6a },
  { action: 0x3d, x0: 0x20, x1: 0x2f, y0: 0x5b, y1: 0x6a },
  { action: 0x38, x0: 0x00, x1: 0x0f, y0: 0x6b, y1: 0x7a },
  { action: 0x3b, x0: 0x10, x1: 0x1f, y0: 0x6b, y1: 0x7a },
  { action: 0x3e, x0: 0x20, x1: 0x2f, y0: 0x6b, y1: 0x7a },
  { action: 0x48, x0: 0x38, x1: 0x47, y0: 0x53, y1: 0x62 },
  { action: 0x49, x0: 0x38, x1: 0x47, y0: 0x63, y1: 0x72 },
  { action: 0x3f, x0: 0x50, x1: 0x5f, y0: 0x4b, y1: 0x5a },
  { action: 0x40, x0: 0x60, x1: 0x6f, y0: 0x4b, y1: 0x5a },
  { action: 0x44, x0: 0x70, x1: 0x7f, y0: 0x4b, y1: 0x5a },
  { action: 0x45, x0: 0x50, x1: 0x5f, y0: 0x5b, y1: 0x6a },
  { action: 0x46, x0: 0x60, x1: 0x6f, y0: 0x5b, y1: 0x6a },
  { action: 0x43, x0: 0x70, x1: 0x7f, y0: 0x5b, y1: 0x6a },
  { action: 0x42, x0: 0x50, x1: 0x5f, y0: 0x6b, y1: 0x7a },
  { action: 0x47, x0: 0x60, x1: 0x6f, y0: 0x6b, y1: 0x7a },
  { action: 0x41, x0: 0x70, x1: 0x7f, y0: 0x6b, y1: 0x7a },
  { action: 0x30, x0: 0x08, x1: 0x17, y0: 0x7d, y1: 0x8c },
  { action: 0x31, x0: 0x18, x1: 0x27, y0: 0x7d, y1: 0x8c },
  { action: 0x32, x0: 0x28, x1: 0x37, y0: 0x7d, y1: 0x8c },
  { action: 0x33, x0: 0x38, x1: 0x47, y0: 0x7d, y1: 0x8c },
  { action: 0x34, x0: 0x48, x1: 0x57, y0: 0x7d, y1: 0x8c },
  { action: 0x35, x0: 0x58, x1: 0x67, y0: 0x7d, y1: 0x8c },
  { action: 0x25, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** First selection action; `resource = action - 0x30`, stored as `vp[0xd6] = resource + 1`. */
export const RESOURCE_SELECT_ACTION_BASE = 0x30;

/**
 * The smoothing kernel, read out of the machine code of `FUN_00040da7`:
 * `value(column) = sum over k=0..8 of weight[k] * ring[head - column - k]`.
 *
 * The weights are symmetric and sum to exactly 64; both fall out of the code independently and
 * support the reading. With 112 columns and a look-back of 8 samples one picture covers exactly the
 * 120 ring slots (112 + 8) - which is why `resourceHistory` has 120 samples where `statHistory` has
 * 112.
 */
export const RESOURCE_SMOOTH_KERNEL: readonly number[] = [4, 6, 8, 9, 10, 9, 8, 6, 4];
/** Ring size of `resourceHistory` (wrap `0` to `0x77`). */
export const RESOURCE_RING_SIZE = 0x78;
/** The original draws this many columns (loop counter `0x6f`, so 112 passes). */
export const RESOURCE_CURVE_COLUMNS = 112;

/**
 * One scale step: up to which smoothed maximum it applies, which factor turns values into pixels,
 * which four numbers stand on the right, and how the bar is striped.
 */
export interface ResourceScaleStep {
  /** Upper bound (exclusive) of the smoothed maximum; `null` = last step. */
  readonly limit: number | null;
  /** `height = (value * 2 * factor) >> 16`, then clamped to 64. */
  readonly factor: number;
  /** The four number icons in column 0x0e, rows 0 / 0x10 / 0x20 / 0x30 (top to bottom). */
  readonly labelIcons: readonly number[];
  /** Stripes of the bar from the bottom: `[length, code]`, colour = `0x48 + 2*(code ^ 1)`. */
  readonly stripes: readonly (readonly [number, number])[];
}

/**
 * The eight scale steps (`@0x41412`..`@0x415df` stripes, `@0x415e0`.. number icons). Full deflection
 * (64 pixels) is `64 / (2*factor / 65536)` raw units, i.e. 1 / 2 / 4 / 8 / 20 / 40 / 80 / ~200 goods
 * per sample. The manual (p. 83) calls the window "about 2 hours" and reads one sample as a minute,
 * which matches 120 samples * 1 min.
 *
 * The stripe runs of steps 6 and 7 reach past 64 pixels (80 resp. 85); the drawer clamps at 64 and
 * the rest is never read. Kept verbatim rather than trimmed.
 */
export const RESOURCE_SCALE_STEPS: readonly ResourceScaleStep[] = [
  {
    limit: 0x41,
    factor: 0x8000,
    labelIcons: [0x6e, 0x6d, 0x6c, 0x6b],
    stripes: [[64, 0]],
  },
  {
    limit: 0x81,
    factor: 0x4000,
    labelIcons: [0x70, 0x6f, 0x6e, 0x6c],
    stripes: [[32, 0], [32, 1]],
  },
  {
    limit: 0x101,
    factor: 0x2000,
    labelIcons: [0x72, 0x71, 0x70, 0x6e],
    stripes: [[16, 0], [16, 1], [16, 0], [16, 1]],
  },
  {
    limit: 0x201,
    factor: 0x1000,
    labelIcons: [0x75, 0x74, 0x72, 0x70],
    stripes: [[8, 0], [8, 1], [8, 0], [8, 1], [8, 0], [8, 1], [8, 0], [8, 1]],
  },
  {
    limit: 0x501,
    factor: 0x666,
    labelIcons: [0x78, 0x77, 0x76, 0x73],
    stripes: [[3, 0], [3, 1], [4, 0], [3, 1], [3, 0], [3, 1], [3, 0], [4, 1], [3, 0], [3, 1], [3, 2], [3, 3], [4, 2], [3, 3], [3, 2], [3, 3], [3, 2], [4, 3], [3, 2], [3, 3]],
  },
  {
    limit: 0xa01,
    factor: 0x333,
    labelIcons: [0x7a, 0x79, 0x78, 0x76],
    stripes: [[2, 0], [2, 1], [1, 0], [2, 1], [1, 0], [2, 1], [2, 0], [2, 1], [1, 0], [2, 1], [1, 0], [2, 1], [2, 2], [2, 3], [1, 2], [2, 3], [1, 2], [2, 3], [2, 2], [2, 3], [1, 2], [2, 3], [1, 2], [2, 3], [2, 0], [2, 1], [1, 0], [2, 1], [1, 0], [2, 1], [2, 0], [2, 1], [1, 0], [2, 1], [1, 0], [2, 1], [2, 2], [2, 3], [1, 2], [2, 3], [1, 2], [2, 3], [2, 2], [2, 3], [1, 2], [2, 3], [1, 2], [2, 3]],
  },
  {
    limit: 0x1401,
    factor: 0x199,
    labelIcons: [0x7d, 0x7c, 0x7a, 0x78],
    stripes: [[1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [2, 1], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [2, 1], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [2, 1], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [2, 1], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1], [2, 1], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3], [1, 2], [1, 3]],
  },
  {
    limit: null,
    factor: 0xa3,
    labelIcons: [0x80, 0x7f, 0x7e, 0x7b],
    stripes: [[1, 0], [1, 1], [1, 0], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 1], [1, 2], [1, 3], [1, 2], [1, 1], [1, 0], [1, 1], [1, 2], [1, 3], [1, 2], [1, 1], [1, 0], [1, 1], [1, 2], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 1], [1, 2], [1, 3], [1, 2], [1, 1], [1, 0], [1, 1], [1, 2], [1, 3], [1, 2], [1, 1], [1, 0], [1, 1], [1, 2], [1, 3], [1, 2], [1, 3], [1, 0], [1, 1], [1, 0], [1, 3], [1, 2], [1, 3]],
  },
];

/**
 * Pick the scale step - the cascade `@0x41137`: the first entry whose bound the smoothed maximum
 * does not reach.
 */
export function resourceScaleStep(max: number): ResourceScaleStep {
  for (const step of RESOURCE_SCALE_STEPS) {
    if (step.limit === null || max < step.limit) return step;
  }
  return RESOURCE_SCALE_STEPS[RESOURCE_SCALE_STEPS.length - 1]!;
}

/**
 * Smoothing - the first loop of `FUN_00040da7`. Column `c` starts at ring slot `head - c` and runs
 * eight slots back, each with its weight from {@link RESOURCE_SMOOTH_KERNEL}. The original computes
 * in a 16-bit register (never tight at 255 * 64 = 16320); the ring wraps `0` to `0x77`.
 */
export function smoothResourceHistory(samples: readonly number[], ringIndex: number): number[] {
  const out: number[] = [];
  let head = ((ringIndex % RESOURCE_RING_SIZE) + RESOURCE_RING_SIZE) % RESOURCE_RING_SIZE;
  for (let column = 0; column < RESOURCE_CURVE_COLUMNS; column++) {
    let index = head;
    let sum = 0;
    for (const weight of RESOURCE_SMOOTH_KERNEL) {
      sum = (sum + weight * ((samples[index] ?? 0) & 0xff)) & 0xffff;
      index = index === 0 ? RESOURCE_RING_SIZE - 1 : index - 1;
    }
    out.push(sum);
    head = head === 0 ? RESOURCE_RING_SIZE - 1 : head - 1;
  }
  return out;
}

/** Baseline of the bars; every bar grows upwards from here. */
export const RESOURCE_BAR_BASE_Y = 0x48;
/** Clamp for the bar height (`cmpw $0x41` gives `0x40`). */
export const RESOURCE_BAR_MAX_HEIGHT = 0x40;
/** x runs down from `0x77`; the test is `x != 7` *after* the decrement, so the last column is 8. */
export const RESOURCE_BAR_X_START = 0x77;
export const RESOURCE_BAR_X_END = 7;
/** Stripe colour: `0x48 + 2*(code ^ 1)`, i.e. the four indices `0x4a` / `0x48` / `0x4e` / `0x4c`. */
export const RESOURCE_BAR_COLOR_BASE = 0x48;

/** Stripe code to palette index (`xorw $1` plus doubling, `@0x413cf`). */
export const resourceStripeColorIndex = (code: number): number =>
  RESOURCE_BAR_COLOR_BASE + 2 * ((code ^ 1) & 0xffff);

/**
 * The bar area - the second loop of `FUN_00040da7`. Per column:
 *
 * ```
 * height = ((value * 2) * factor) >> 16     // 32-bit product, high word (`rorl $0x10`)
 * height = min(height, 0x40)
 * y = 0x48 ; height pixels upwards, colour from the stripe stream (restarted per column)
 * ```
 *
 * Because the stream restarts in *every* column, the colour changes sit at the same heights - that
 * is what forms the horizontal rules of the scale.
 */
export function drawResourceBars(
  fb: Framebuffer,
  values: readonly number[],
  step: ResourceScaleStep,
  color: (paletteIndex: number) => readonly [number, number, number],
): void {
  let x = RESOURCE_BAR_X_START;
  let column = 0;
  do {
    const raw = (values[column] ?? 0) & 0xffff;
    column += 1;
    let height = ((((raw * 2) & 0xffff) * step.factor) >>> 16) & 0xffff;
    if (height > RESOURCE_BAR_MAX_HEIGHT) height = RESOURCE_BAR_MAX_HEIGHT;
    if (height !== 0) {
      let y = RESOURCE_BAR_BASE_Y;
      let run = 0;
      let stripe = 0;
      let rgb: readonly [number, number, number] = color(resourceStripeColorIndex(0));
      for (let pixel = 0; pixel < height; pixel++) {
        if (run === 0) {
          const entry = step.stripes[stripe] ?? [RESOURCE_BAR_MAX_HEIGHT, 0];
          stripe += 1;
          run = entry[0];
          rgb = color(resourceStripeColorIndex(entry[1]));
        }
        putPixel(fb, x, y, rgb);
        y -= 1;
        run -= 1;
      }
    }
    x -= 1;
  } while (x !== RESOURCE_BAR_X_END);
}

/** Inputs of the goods production curve. */
export interface ResourceStatsView {
  /** `vp[0xd6] - 1` - the selected resource (0..25). */
  readonly resource: number;
  /** Ring head `resourceHistoryIndex` from the header. */
  readonly ringIndex: number;
  /** The 120 samples of that resource from `resourceHistory`, or `null`. */
  readonly history: readonly number[] | null;
}

/**
 * Draw screen 0x0f. Order as in the original: three bands, layout, watermark, then smoothing,
 * maximum, scale step, the four numbers on the right, bars.
 *
 * The area is covered exactly without tiling the popup background: rows 0x00-0x3f carry the
 * watermark, 0x40-0x4f the first band, 0x50-0x7a the three rows of selection icons (plus the four
 * filler tiles in columns 6/8 that would otherwise stay blank), 0x70-0x8f the two lower bands. The
 * watermark ends at column 0xc, leaving column 0x0e free for the scale numbers.
 */
export function drawResourceStats(
  fb: Framebuffer,
  provider: SpriteProvider,
  view: ResourceStatsView,
  color?: (paletteIndex: number) => readonly [number, number, number],
): void {
  for (const row of RESOURCE_STATS_BAND_ROWS) {
    drawPanelIconRow(fb, provider, row, STATS_POPUP_BG_ICON);
  }
  drawLayout(fb, provider, RESOURCE_STATS_LAYOUT, UI_ICON_BASE);
  const watermark = RESOURCE_STATS_WATERMARK_BASE + view.resource + 1;
  for (const row of RESOURCE_STATS_WATERMARK_ROWS) {
    for (const col of RESOURCE_STATS_WATERMARK_COLS) {
      drawPanelIcon(fb, provider, watermark, col, row);
    }
  }
  const values = view.history === null ? [] : smoothResourceHistory(view.history, view.ringIndex);
  let max = 0;
  for (const v of values) if (v > max) max = v;
  const step = resourceScaleStep(max);
  step.labelIcons.forEach((icon, k) => {
    drawPanelIcon(fb, provider, icon, 0x0e, k * 0x10);
  });
  if (color === undefined) return; // no palette, no bars - rather than inventing colours
  drawResourceBars(fb, values, step, color);
}


// --- Screen 0x13: profession statistics ------------------------------------------------------

/** Layout table `@0x3e9ca`: 25 profession heads, the settler symbol and the exit button. */
export const PROFESSION_STATS_LAYOUT: readonly LayoutItem[] = [
  { icon: 0x09, col: 1, row: 0x00 },
  { icon: 0x0a, col: 1, row: 0x10 },
  { icon: 0x0b, col: 1, row: 0x20 },
  { icon: 0x0c, col: 1, row: 0x30 },
  { icon: 0x21, col: 1, row: 0x40 },
  { icon: 0x20, col: 1, row: 0x50 },
  { icon: 0x1f, col: 1, row: 0x60 },
  { icon: 0x1e, col: 1, row: 0x70 },
  { icon: 0x1d, col: 1, row: 0x80 },
  { icon: 0x0d, col: 6, row: 0x00 },
  { icon: 0x0e, col: 6, row: 0x10 },
  { icon: 0x12, col: 6, row: 0x20 },
  { icon: 0x0f, col: 6, row: 0x30 },
  { icon: 0x10, col: 6, row: 0x40 },
  { icon: 0x11, col: 6, row: 0x50 },
  { icon: 0x19, col: 6, row: 0x60 },
  { icon: 0x1a, col: 6, row: 0x70 },
  { icon: 0x1b, col: 6, row: 0x80 },
  { icon: 0x13, col: 11, row: 0x00 },
  { icon: 0x14, col: 11, row: 0x10 },
  { icon: 0x15, col: 11, row: 0x20 },
  { icon: 0x16, col: 11, row: 0x30 },
  { icon: 0x17, col: 11, row: 0x40 },
  { icon: 0x18, col: 11, row: 0x50 },
  { icon: 0x1c, col: 11, row: 0x60 },
  { icon: 0x82, col: 11, row: 0x70 },
  { icon: 0x3c, col: 14, row: 0x80 },
];

/** One gauge slot of the profession statistics. */
export interface ProfessionSlot {
  readonly type: number;
  readonly col: number;
  readonly row: number;
}

/**
 * The 25 gauge slots: serf type to column/row, in the original's drawing order.
 *
 * Completeness: they cover every type 0..26 except 4 (transporter-in-stock, the internal duplicate
 * that the population sum of screen 0x12 also skips) and 21 (settler - shown as a number at the
 * bottom right). 25 + 2 = 27.
 */
export const PROFESSION_STATS_SLOTS: readonly ProfessionSlot[] = [
  { type:  0, col:  3, row: 0x00 }, // transporter
  { type:  1, col:  3, row: 0x10 }, // sailor
  { type:  2, col:  3, row: 0x20 }, // digger
  { type:  3, col:  3, row: 0x30 }, // builder
  { type: 26, col:  3, row: 0x40 }, // knight4
  { type: 25, col:  3, row: 0x50 }, // knight3
  { type: 24, col:  3, row: 0x60 }, // knight2
  { type: 23, col:  3, row: 0x70 }, // knight1
  { type: 22, col:  3, row: 0x80 }, // knight0
  { type:  5, col:  8, row: 0x00 }, // lumberjack
  { type:  6, col:  8, row: 0x10 }, // sawmiller
  { type: 10, col:  8, row: 0x20 }, // smelter
  { type:  7, col:  8, row: 0x30 }, // stonecutter
  { type:  8, col:  8, row: 0x40 }, // forester
  { type:  9, col:  8, row: 0x50 }, // miner
  { type: 17, col:  8, row: 0x60 }, // boat builder
  { type: 18, col:  8, row: 0x70 }, // toolmaker
  { type: 19, col:  8, row: 0x80 }, // weaponsmith
  { type: 11, col: 13, row: 0x00 }, // fisher
  { type: 12, col: 13, row: 0x10 }, // pig farmer
  { type: 13, col: 13, row: 0x20 }, // butcher
  { type: 14, col: 13, row: 0x30 }, // farmer
  { type: 15, col: 13, row: 0x40 }, // miller
  { type: 16, col: 13, row: 0x50 }, // baker
  { type: 20, col: 13, row: 0x60 }, // geologist
];

/** One step of the gauge ladder: applies for `value < limit` (`null` = last step). */
export interface ProfessionGaugeStep {
  readonly limit: number | null;
  readonly icon: number;
}

/**
 * The gauge ladder - `FUN_0003e902`, read back in the machine code.
 *
 * The manual (p. 85) pins three points of this scale independently: none available puts the needle
 * left in the red (0 gives `0xbc`), three workers make it stand upright (3 gives `0xc1`, the middle
 * of the eleven needle icons `0xbc`..`0xc6`), and twenty or more puts it at the right stop.
 */
export const PROFESSION_GAUGE_LADDER: readonly ProfessionGaugeStep[] = [
  { limit: 1, icon: 0xbc }, //     0     - red area
  { limit: 2, icon: 0xbe }, //     1
  { limit: 3, icon: 0xc0 }, //     2
  { limit: 4, icon: 0xc1 }, //     3     - upright
  { limit: 5, icon: 0xc2 }, //     4
  { limit: 7, icon: 0xc3 }, //     5..6
  { limit: 0x0a, icon: 0xc4 }, // 7..9
  { limit: 0x14, icon: 0xc5 }, // 10..19
  { limit: null, icon: 0xc6 }, // 20+    - right stop
];

/** Needle icon for an availability count. */
export function professionGaugeIcon(count: number): number {
  for (const step of PROFESSION_GAUGE_LADDER) {
    if (step.limit === null || count < step.limit) return step.icon;
  }
  return PROFESSION_GAUGE_LADDER[PROFESSION_GAUGE_LADDER.length - 1]!.icon;
}

/**
 * The number at the bottom right: unemployed settlers. The original reads it as `player - 0x10`,
 * i.e. block offset 112 == `serfCount[21]` - settlers that can still take a new job (manual p. 85).
 */
export const PROFESSION_UNEMPLOYED_TYPE = 21;
export const PROFESSION_UNEMPLOYED_COL = 0x0d;
export const PROFESSION_UNEMPLOYED_ROW = 0x74;

/** Inputs of the profession statistics. */
export interface ProfessionStatsView {
  /** Result of `professionAvailability()`, indexed by serf type. */
  readonly available: readonly number[];
  /** The player's `serfCount[21]`. */
  readonly unemployed: number;
}

/** Draw screen 0x13. */
export function drawProfessionStats(
  fb: Framebuffer,
  provider: SpriteProvider,
  view: ProfessionStatsView,
): void {
  tileBackground(fb, provider, STATS_POPUP_BG_ICON);
  drawLayout(fb, provider, PROFESSION_STATS_LAYOUT, UI_ICON_BASE);
  for (const slot of PROFESSION_STATS_SLOTS) {
    const count = view.available[slot.type] ?? 0;
    drawPanelIcon(fb, provider, professionGaugeIcon(count), slot.col, slot.row);
  }
  drawPanelNumber(
    fb,
    provider,
    view.unemployed,
    PROFESSION_UNEMPLOYED_COL,
    PROFESSION_UNEMPLOYED_ROW,
  );
}

// --- Screen 0x35: player colour legend -------------------------------------------------------

/**
 * The four quadrants of the legend: position (in drawing pixels, taken directly by `fill_rect`),
 * palette index of the player colour, and the panel slot of the face.
 *
 * The four colours are the same as those of the comparison curves and in the same slot assignment
 * (`0x40` / `0x48` / `0x44` / `0x4c` for slots 0..3) - that is exactly the purpose of the window: it
 * says which curve belongs to whom. The four 0x40x0x48 rectangles cover the popup area 128x144 from
 * column 8 / row 9 exactly.
 */
export const PLAYER_LEGEND_QUADRANTS: readonly {
  readonly x: number;
  readonly y: number;
  readonly colorIndex: number;
  readonly faceCol: number;
  readonly faceRow: number;
}[] = [
  { x: 0x08, y: 0x09, colorIndex: 0x40, faceCol: 2, faceRow: 0x04 },
  { x: 0x48, y: 0x09, colorIndex: 0x48, faceCol: 10, faceRow: 0x04 },
  { x: 0x08, y: 0x51, colorIndex: 0x44, faceCol: 2, faceRow: 0x4c },
  { x: 0x48, y: 0x51, colorIndex: 0x4c, faceCol: 10, faceRow: 0x4c },
];
export const PLAYER_LEGEND_QUADRANT_WIDTH = 0x40;
export const PLAYER_LEGEND_QUADRANT_HEIGHT = 0x48;

/** Icon for an empty slot (face byte 0) - see {@link FACE_ICON_EMPTY}. */
export const PLAYER_LEGEND_EMPTY_ICON = FACE_ICON_EMPTY;
/** Icon of an occupied slot: `face byte + 0x10b` - see {@link FACE_ICON_BASE}. */
export const PLAYER_LEGEND_FACE_ICON_BASE = FACE_ICON_BASE;
/**
 * Face byte of the human player. A constant of the game logic, not map content: the new-game and
 * mission initialisation writes `gs+0x1d6 = 0xc` as a literal (twice, for every path except game
 * type 4, where the value comes from the player setting).
 */
export const PLAYER_LEGEND_HUMAN_FACE = 0x0c;

/**
 * Face byte to icon (`FUN_0003952c`). Just a name for {@link faceIcon} - the same original primitive
 * also serves the message window and the mission end, so it lives once in `ui-render.ts`.
 */
export const legendFaceIcon = faceIcon;

/** Click zone `@0x2c6ea`: the whole area, action `0x1f` returns to the comparison curves. */
export const PLAYER_LEGEND_HITBOXES: readonly HitRect[] = [
  { action: 0x1f, x0: 0x00, x1: 0x7f, y0: 0x00, y1: 0x8f },
];

/** Inputs of the legend. */
export interface PlayerLegendView {
  /**
   * Face byte per slot: `0` = slot empty, `null` = unknown - then the slot stays blank rather than
   * inventing a face.
   */
  readonly faces: readonly (number | null)[];
}

/**
 * Draw screen 0x35 - `FUN_000393a4`: four coloured quadrants, each with the face of the player who
 * owns that colour.
 *
 * The face byte is not stored in the savegame - only the start-of-game initialisation writes
 * `gs+0x1d6 + 4*slot`, the `.DS` loader never does. It is reconstructible from the setup index of
 * the save; `playerFaces()` in `player-setup.ts` does that. `faces[slot]` therefore stays
 * three-valued: known byte, `0` for an empty slot, `null` when the setup record lies outside the
 * table.
 */
export function drawPlayerColorLegend(
  fb: Framebuffer,
  provider: SpriteProvider,
  view: PlayerLegendView,
  color: (paletteIndex: number) => readonly [number, number, number],
): void {
  PLAYER_LEGEND_QUADRANTS.forEach((q) => {
    fillRect(
      fb,
      q.x,
      q.y,
      PLAYER_LEGEND_QUADRANT_WIDTH,
      PLAYER_LEGEND_QUADRANT_HEIGHT,
      color(q.colorIndex),
    );
  });
  PLAYER_LEGEND_QUADRANTS.forEach((q, slot) => {
    const face = view.faces[slot];
    if (face === null || face === undefined) return; // unknown - no invented face
    drawPanelIcon(fb, provider, legendFaceIcon(face), q.faceCol, q.faceRow);
  });
}

// --- Dispatcher ---------------------------------------------------------------------------------

/** All screens this module can draw. */
export const STATS_SCREENS: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x35,
];
