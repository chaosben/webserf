/**
 * Building popups (special click on an own building).
 *
 * Screens: 0x28 construction site · 0x27 mine · 0x29 military · 0x34 finished building ·
 * 0x26 castle/warehouse.
 *
 * All read their subject from `player+0x176` (building index, `.DS` block offset 502) and close
 * themselves when it is 0 or the building is burning (`bld+5` bit 5).
 */

import {
  blitSpriteNoPivot,
  drawLayout,
  drawPanelIcon,
  drawPanelNumber,
  drawPanelNumberWide,
  drawPanelText,
  hitTestPanel,
  panelX,
  panelY,
  tileBackground,
  UI_ICON_BASE,
  UI_OBJECT_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';
import { MAP_BUILDING_SPRITE } from './building-sprites.js';
import { t } from './language.js';

/**
 * Panel column of the building sprite: 6, except for the wide sprites — 4 (16 px further left).
 * Compared is the sprite value from {@link MAP_BUILDING_SPRITE}, not the building type (@0x3aab2).
 */
export function buildingPopupSpriteCol(spriteValue: number): number {
  return spriteValue === 0xc0 || spriteValue < 0x9e ? 4 : 6;
}

/** Row on which all these popups show their building (`vreg1 = 0x28`). */
export const BUILDING_POPUP_SPRITE_ROW = 0x28;

/** Background tile of all building popups (`draw_popup_background(0x138)`). */
export const BUILDING_POPUP_BG_ICON = 0x138;

/** Exit button — position and icon as in every popup with an exit. */
export const BUILDING_POPUP_EXIT_ICON = 0x3c;
export const BUILDING_POPUP_EXIT_COL = 14;
export const BUILDING_POPUP_EXIT_ROW = 0x80;

/**
 * Draws the building sprite of a popup (`draw_popup_object_sprite`) — same pivot-less blit
 * convention as the build menus.
 */
export function drawBuildingPopupSprite(
  fb: Framebuffer,
  provider: SpriteProvider,
  buildingType: number,
  row: number = BUILDING_POPUP_SPRITE_ROW,
): void {
  const value = MAP_BUILDING_SPRITE[buildingType] ?? 0;
  const spr = provider(UI_OBJECT_BASE + value);
  if (spr) blitSpriteNoPivot(fb, spr, panelX(buildingPopupSpriteCol(value)), panelY(row));
}

// --- Screen 0x28: construction site ---------------------------------------------------------------

/** The two text lines of the construction site (@0x3ab35 / @0x3ab41, `0xff`-terminated). */
export const CONSTRUCTION_POPUP_TITLE: readonly { readonly text: string; readonly col: number; readonly row: number }[] = [
  { text: 'AUFTRAG DER', col: 2, row: 4 },
  { text: 'BAUSTELLE:', col: 2, row: 0xe },
];

/**
 * Click zones of the display-only popups: table @0x2c7e4 — the exit and nothing else.
 *
 * Screens 0x27, 0x28, 0x29 and 0x34 share one walker (@0x2c5f0) and therefore this table.
 */
export const DISPLAY_ONLY_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x27, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** Alias for screen 0x28 (the same shared table). */
export const CONSTRUCTION_POPUP_HITBOXES = DISPLAY_ONLY_POPUP_HITBOXES;

/** Action id of the exit (0x27 — the usual close routine). */
export const CONSTRUCTION_POPUP_ACTION_EXIT = 0x27;

/** Click in drawing pixels to action id (the exit only), or `null`. */
export function constructionPopupAction(drawX: number, drawY: number): number | null {
  return hitTestPanel(CONSTRUCTION_POPUP_HITBOXES, drawX, drawY);
}

/**
 * Draws screen 0x28 (`FUN_0003aa0a`).
 *
 * The popup shows only the build order — no progress, no material.
 */
export function drawConstructionPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  buildingType: number,
  textColor: readonly [number, number, number],
): void {
  tileBackground(fb, provider, BUILDING_POPUP_BG_ICON);
  drawBuildingPopupSprite(fb, provider, buildingType);
  for (const line of CONSTRUCTION_POPUP_TITLE) {
    drawPanelText(fb, provider, t(line.text), line.col, line.row, textColor);
  }
  drawPanelIcon(fb, provider, BUILDING_POPUP_EXIT_ICON, BUILDING_POPUP_EXIT_COL, BUILDING_POPUP_EXIT_ROW);
}

// --- Screen 0x27: mine ---------------------------------------------------------------------------

/**
 * Weights of the success rate (table @0x3a9dc). Their sum is exactly 100, so the rate is directly a
 * percentage; bit 0 weighs most, bit 15 least — the most recent shifts count more.
 */
// prettier-ignore
export const MINE_SUCCESS_WEIGHTS: readonly number[] = [
  10, 10, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 3, 2, 1,
];

/**
 * Success rate of a mine in percent (@0x3a8d0). In a finished building `bld+0xc` is the shift
 * register of the last 16 shifts; in a construction site the same slot is the build progress —
 * which is why this popup only shows finished mines.
 */
export function mineSuccessRate(attemptBits: number): number {
  let sum = 0;
  for (let bit = 15; bit >= 0; bit--) {
    if ((attemptBits & (1 << bit)) !== 0) sum += MINE_SUCCESS_WEIGHTS[bit]!;
  }
  return sum;
}

/** Building types this popup shows at all: the four mines (encoded 0x14/0x18/0x1c/0x20). */
export const MINE_TYPES: readonly number[] = [5, 6, 7, 8];

/** Row of the building sprite here (`vreg1 = 0x3c`) — lower than in the other popups. */
export const MINE_POPUP_SPRITE_ROW = 0x3c;
/** Column of the building sprite (6, without the width rule — mines are all narrow). */
export const MINE_POPUP_SPRITE_COL = 6;

/** Occupancy lamp: 0xdc empty, 0x11 with a miner inside (`bld+5` bit 6). */
export const MINE_POPUP_HOLDER_ICON_EMPTY = 0xdc;
export const MINE_POPUP_HOLDER_ICON_OCCUPIED = 0x11;
export const MINE_POPUP_HOLDER_COL = 10;
export const MINE_POPUP_HOLDER_ROW = 0x4b;

/** Food icon (0x24) and the two stack columns (left 1, right 13). */
export const MINE_POPUP_FOOD_ICON = 0x24;
export const MINE_POPUP_FOOD_COL_LEFT = 1;
export const MINE_POPUP_FOOD_COL_RIGHT = 13;
/** Bottom edge of the stacks (0x5a) and their row spacing (0x10). */
export const MINE_POPUP_FOOD_BASE_ROW = 0x5a;
export const MINE_POPUP_FOOD_ROW_STEP = 0x10;

/** The two text lines (@0x3a9ec / @0x3a9f9) and the percent sign (@0x3aa08). */
export const MINE_POPUP_TITLE: readonly { readonly text: string; readonly col: number; readonly row: number }[] = [
  { text: 'ERFOLGSQUOTE', col: 1, row: 0xe },
  { text: 'DES BERGWERKS:', col: 1, row: 0x18 },
];
export const MINE_POPUP_PERCENT_TEXT = '%';
export const MINE_POPUP_VALUE_COL = 6;
export const MINE_POPUP_VALUE_ROW = 0x26;

/**
 * Draws screen 0x27 (`FUN_0003a6f6`).
 *
 * The percent sign is placed *behind* the number, so its column depends on how many digits the
 * rate has.
 */
export function drawMinePopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  mine: {
    readonly type: number;
    /** `bld+5` bit 6 — miner inside. */
    readonly holder: boolean;
    /** Upper nibble of `bld+8` — food in stock. */
    readonly food: number;
    /** `bld+0xc` — shift register of the last 16 shifts. */
    readonly attemptBits: number;
  },
  textColor: readonly [number, number, number],
): void {
  tileBackground(fb, provider, BUILDING_POPUP_BG_ICON);
  const sprite = MAP_BUILDING_SPRITE[mine.type] ?? 0;
  const spr = provider(UI_OBJECT_BASE + sprite);
  if (spr) blitSpriteNoPivot(fb, spr, panelX(MINE_POPUP_SPRITE_COL), panelY(MINE_POPUP_SPRITE_ROW));
  drawPanelIcon(
    fb,
    provider,
    mine.holder ? MINE_POPUP_HOLDER_ICON_OCCUPIED : MINE_POPUP_HOLDER_ICON_EMPTY,
    MINE_POPUP_HOLDER_COL,
    MINE_POPUP_HOLDER_ROW,
  );
  const food = mine.food & 0xf;
  if (food !== 0) {
    const left = (food + 1) >> 1;
    const right = food >> 1;
    let rowL = MINE_POPUP_FOOD_BASE_ROW - (left << 3);
    let rowR = MINE_POPUP_FOOD_BASE_ROW - (right << 3);
    for (let i = 0; i < left; i++, rowL += MINE_POPUP_FOOD_ROW_STEP) {
      drawPanelIcon(fb, provider, MINE_POPUP_FOOD_ICON, MINE_POPUP_FOOD_COL_LEFT, rowL);
    }
    for (let i = 0; i < right; i++, rowR += MINE_POPUP_FOOD_ROW_STEP) {
      drawPanelIcon(fb, provider, MINE_POPUP_FOOD_ICON, MINE_POPUP_FOOD_COL_RIGHT, rowR);
    }
  }
  const quote = mineSuccessRate(mine.attemptBits);
  let percentCol = 7;
  if (quote >= 100) percentCol += 1;
  if (quote >= 10) percentCol += 1;
  drawPanelText(fb, provider, t(MINE_POPUP_PERCENT_TEXT), percentCol, MINE_POPUP_VALUE_ROW, textColor);
  drawPanelNumber(fb, provider, quote, MINE_POPUP_VALUE_COL, MINE_POPUP_VALUE_ROW);
  for (const line of MINE_POPUP_TITLE) {
    drawPanelText(fb, provider, t(line.text), line.col, line.row, textColor);
  }
  drawPanelIcon(fb, provider, BUILDING_POPUP_EXIT_ICON, BUILDING_POPUP_EXIT_COL, BUILDING_POPUP_EXIT_ROW);
}

// --- Screen 0x29: military building ---------------------------------------------------------------

/**
 * Position of the building sprite in this popup — its own rule (@0x3b03f), not the width rule
 * above.
 */
export function militaryPopupSpritePos(spriteValue: number): { col: number; row: number } {
  if (spriteValue === 0xab) return { col: 6, row: 0x14 }; // hut
  if (spriteValue === 0x9e) return { col: 4, row: 6 }; // tower
  return { col: 4, row: 1 }; // fortress
}

/** The three military building types (encoded 0x2c, 0x54, 0x58). */
export const MILITARY_TYPES: readonly number[] = [11, 21, 22];

/** Gold icon (0x30) and the two stack columns (left 1, right 13), bottom edge 0x20. */
export const MILITARY_POPUP_GOLD_ICON = 0x30;
export const MILITARY_POPUP_GOLD_COL_LEFT = 1;
export const MILITARY_POPUP_GOLD_COL_RIGHT = 13;
export const MILITARY_POPUP_GOLD_BASE_ROW = 0x20;
export const MILITARY_POPUP_GOLD_ROW_STEP = 0x10;

/** Heading (@0x3b208) at column 3 / row 0x3e. */
export const MILITARY_POPUP_TITLE = 'BESETZUNG:';
export const MILITARY_POPUP_TITLE_COL = 3;
export const MILITARY_POPUP_TITLE_ROW = 0x3e;

/** Knight grid (@0x3b1ce): first cell (3, 0x48), wraps at column 0xf — three knights per row. */
export const MILITARY_POPUP_KNIGHT_COL = 3;
export const MILITARY_POPUP_KNIGHT_ROW = 0x48;
export const MILITARY_POPUP_KNIGHT_COL_STEP = 4;
export const MILITARY_POPUP_KNIGHT_COL_WRAP = 0xf;
export const MILITARY_POPUP_KNIGHT_ROW_STEP = 0x12;

/** Icon of a knight: serf type + 7 — ranks 22..26 land on icons 0x1d..0x21. */
export function knightRankIcon(serfType: number): number {
  return serfType + 7;
}

/**
 * Draws screen 0x29 (`FUN_0003af47` + `FUN_0003b16d`) — garrison (one head per knight, rank in the
 * icon) and the stored gold.
 *
 * `knightTypes` are the serf types in chain order; the chain itself (`bld+10` → `serf+0xe`) is
 * walked by the caller here, because it holds the serf records.
 */
export function drawMilitaryPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  garrison: {
    readonly type: number;
    /** Upper nibble of `bld+9` — stored gold. */
    readonly gold: number;
    readonly knightTypes: readonly number[];
  },
  textColor: readonly [number, number, number],
): void {
  tileBackground(fb, provider, BUILDING_POPUP_BG_ICON);
  const sprite = MAP_BUILDING_SPRITE[garrison.type] ?? 0;
  const pos = militaryPopupSpritePos(sprite);
  const spr = provider(UI_OBJECT_BASE + sprite);
  if (spr) blitSpriteNoPivot(fb, spr, panelX(pos.col), panelY(pos.row));

  const gold = garrison.gold & 0xf;
  if (gold !== 0) {
    const left = (gold + 1) >> 1;
    const right = gold >> 1;
    let rowL = MILITARY_POPUP_GOLD_BASE_ROW - (left << 3);
    let rowR = MILITARY_POPUP_GOLD_BASE_ROW - (right << 3);
    for (let i = 0; i < left; i++, rowL += MILITARY_POPUP_GOLD_ROW_STEP) {
      drawPanelIcon(fb, provider, MILITARY_POPUP_GOLD_ICON, MILITARY_POPUP_GOLD_COL_LEFT, rowL);
    }
    for (let i = 0; i < right; i++, rowR += MILITARY_POPUP_GOLD_ROW_STEP) {
      drawPanelIcon(fb, provider, MILITARY_POPUP_GOLD_ICON, MILITARY_POPUP_GOLD_COL_RIGHT, rowR);
    }
  }

  drawPanelText(
    fb,
    provider,
    t(MILITARY_POPUP_TITLE),
    MILITARY_POPUP_TITLE_COL,
    MILITARY_POPUP_TITLE_ROW,
    textColor,
  );
  let col = MILITARY_POPUP_KNIGHT_COL;
  let row = MILITARY_POPUP_KNIGHT_ROW;
  for (const type of garrison.knightTypes) {
    drawPanelIcon(fb, provider, knightRankIcon(type), col, row);
    col += MILITARY_POPUP_KNIGHT_COL_STEP;
    if (col === MILITARY_POPUP_KNIGHT_COL_WRAP) {
      col = MILITARY_POPUP_KNIGHT_COL;
      row += MILITARY_POPUP_KNIGHT_ROW_STEP;
    }
  }
  drawPanelIcon(fb, provider, BUILDING_POPUP_EXIT_ICON, BUILDING_POPUP_EXIT_COL, BUILDING_POPUP_EXIT_ROW);
}

// --- Screen 0x34: stock of a finished building ----------------------------------------------------

/** Row of the building sprite here (`vreg1 = 0x1e`) — higher than in the construction site. */
export const STOCK_POPUP_SPRITE_ROW = 0x1e;

/** The two text lines (@0x3af2b / @0x3af38) at column 1 / rows 4 and 0xe. */
export const STOCK_POPUP_TITLE: readonly { readonly text: string; readonly col: number; readonly row: number }[] = [
  { text: 'LAGERBESTAND', col: 1, row: 4 },
  { text: 'DES GEBAEUDES:', col: 1, row: 0xe },
];

/**
 * Worker icon per building type — table @0x3af13, 24 bytes for types 0..23, `0xff` = no entry.
 * The `0xff` slots are exactly the types that get a different popup (mines, military, warehouse).
 */
// prettier-ignore
export const STOCK_POPUP_WORKER_ICON: readonly number[] = [
  0xff, 0x13, 0x0d, 0x19, 0x0f, 0xff, 0xff, 0xff, 0xff, 0x10, 0xff, 0xff,
  0x16, 0x15, 0x14, 0x17, 0x18, 0x0e, 0x12, 0x1a, 0x1b, 0xff, 0xff, 0x12,
];

/** Position of the worker icon and its placeholder when nobody is inside. */
export const STOCK_POPUP_WORKER_COL = 1;
export const STOCK_POPUP_WORKER_ROW = 0x24;
export const STOCK_POPUP_EMPTY_ICON = 0xdc;

/** Rows of the two goods rows: `bld+9` on top, `bld+8` below. */
export const STOCK_POPUP_ROW_UPPER = 0x5a;
export const STOCK_POPUP_ROW_LOWER = 0x6e;
/** The row is centred on column 7, two columns per good. */
export const STOCK_POPUP_CENTER_COL = 7;
export const STOCK_POPUP_COL_STEP = 2;

/**
 * Kind of good per stock slot — the `cmpw` chain @0x3abe2, indexed by the encoded type.
 * `slot0` belongs to `bld+8`, `slot1` to `bld+9`; `-1` = the slot is not shown.
 *
 * `null` means the original closes the popup. Reachable only for type 0 (no building) — every type
 * the map branch sends to screen 0x34 is in the chain (pinned by a test).
 */
export function stockPopupGoodsIcons(
  buildingType: number,
): { readonly slot0: number; readonly slot1: number } | null {
  switch (buildingType << 2) {
    case 0x0c: return { slot0: 0x29, slot1: -1 }; //   boat builder
    case 0x38: return { slot0: 0x25, slot1: -1 }; //   pig farm
    case 0x34: return { slot0: 0x23, slot1: -1 }; //   butcher
    case 0x3c: return { slot0: 0x25, slot1: -1 }; //   mill
    case 0x40: return { slot0: 0x26, slot1: -1 }; //   bakery
    case 0x44: return { slot0: -1, slot1: 0x28 }; //   sawmill
    case 0x48: return { slot0: 0x2e, slot1: 0x2c }; // steel smelter
    case 0x5c: return { slot0: 0x2e, slot1: 0x2f }; // gold smelter
    case 0x50: return { slot0: 0x2e, slot1: 0x2d }; // weapon smith
    case 0x4c: return { slot0: 0x29, slot1: 0x2d }; // tool maker
    // Consume nothing — the goods rows are skipped and the popup stays open.
    case 0x04: case 0x08: case 0x10: case 0x24: case 0x30:
      return { slot0: -1, slot1: -1 };
    default:
      return null;
  }
}

/**
 * One goods row: `count` icons centred on {@link STOCK_POPUP_CENTER_COL}. With an empty stock the
 * original draws one {@link STOCK_POPUP_EMPTY_ICON} on the centre — not nothing: the loop is
 * `jae`-terminated (@0x3ad3c), so it always runs `n+1` times.
 */
export function stockPopupRowCols(count: number): readonly number[] {
  const n = count === 0 ? 0 : count - 1;
  const cols: number[] = [];
  for (let i = 0, col = STOCK_POPUP_CENTER_COL - n; i <= n; i++, col += STOCK_POPUP_COL_STEP) {
    cols.push(col);
  }
  return cols;
}

/**
 * Draws screen 0x34 (`FUN_0003ab4c` + `FUN_0003ad23`).
 *
 * Shown is the upper nibble of both stock bytes (what is in stock), not what was requested.
 */
export function drawStockPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  building: {
    readonly type: number;
    /** `bld+5` bit 6 — worker inside. */
    readonly holder: boolean;
    /** Upper nibble of `bld+8`. */
    readonly stock0: number;
    /** Upper nibble of `bld+9`. */
    readonly stock1: number;
  },
  textColor: readonly [number, number, number],
): void {
  tileBackground(fb, provider, BUILDING_POPUP_BG_ICON);

  const goods = stockPopupGoodsIcons(building.type);
  if (goods !== null) {
    let row = STOCK_POPUP_ROW_UPPER;
    if (goods.slot1 >= 0) {
      const count = building.stock1 & 0xf;
      const icon = count === 0 ? STOCK_POPUP_EMPTY_ICON : goods.slot1;
      for (const col of stockPopupRowCols(count)) drawPanelIcon(fb, provider, icon, col, row);
      row = STOCK_POPUP_ROW_LOWER;
    }
    if (goods.slot0 >= 0) {
      const count = building.stock0 & 0xf;
      const icon = count === 0 ? STOCK_POPUP_EMPTY_ICON : goods.slot0;
      for (const col of stockPopupRowCols(count)) drawPanelIcon(fb, provider, icon, col, row);
    }
  }

  const worker = building.holder
    ? (STOCK_POPUP_WORKER_ICON[building.type] ?? STOCK_POPUP_EMPTY_ICON)
    : STOCK_POPUP_EMPTY_ICON;
  drawPanelIcon(fb, provider, worker, STOCK_POPUP_WORKER_COL, STOCK_POPUP_WORKER_ROW);

  drawBuildingPopupSprite(fb, provider, building.type, STOCK_POPUP_SPRITE_ROW);
  for (const line of STOCK_POPUP_TITLE) {
    drawPanelText(fb, provider, t(line.text), line.col, line.row, textColor);
  }
  drawPanelIcon(fb, provider, BUILDING_POPUP_EXIT_ICON, BUILDING_POPUP_EXIT_COL, BUILDING_POPUP_EXIT_ROW);
}

// --- Screen 0x26: castle / warehouse --------------------------------------------------------------

/**
 * Icon of a good = resource type + 0x22. Falls out of the castle popup's layout table below: it has
 * exactly one icon per type and the difference is 34 throughout.
 */
export const RESOURCE_ICON_BASE = 0x22;
export function resourceIcon(resourceType: number): number {
  return RESOURCE_ICON_BASE + resourceType;
}

/**
 * Layout table @0x3d8ed — 26 goods icons in three columns plus the two footer buttons (0x3d = on to
 * screen 0x2b, 0x3c = exit).
 *
 * The order of the goods is not the type order but a fixed arrangement by branch of industry.
 */
// prettier-ignore
export const CASTLE_POPUP_LAYOUT: readonly LayoutItem[] = [
  { icon: 0x3d, col: 12, row: 0x80 },
  { icon: 0x28, col: 1, row: 0x00 }, { icon: 0x29, col: 1, row: 0x10 },
  { icon: 0x2a, col: 1, row: 0x20 }, { icon: 0x2b, col: 1, row: 0x30 },
  { icon: 0x2e, col: 1, row: 0x40 }, { icon: 0x2c, col: 1, row: 0x50 },
  { icon: 0x2d, col: 1, row: 0x60 }, { icon: 0x2f, col: 1, row: 0x70 },
  { icon: 0x30, col: 1, row: 0x80 },
  { icon: 0x31, col: 6, row: 0x00 }, { icon: 0x32, col: 6, row: 0x10 },
  { icon: 0x36, col: 6, row: 0x20 }, { icon: 0x37, col: 6, row: 0x30 },
  { icon: 0x35, col: 6, row: 0x40 }, { icon: 0x38, col: 6, row: 0x50 },
  { icon: 0x39, col: 6, row: 0x60 }, { icon: 0x34, col: 6, row: 0x70 },
  { icon: 0x33, col: 6, row: 0x80 },
  { icon: 0x3a, col: 11, row: 0x00 }, { icon: 0x3b, col: 11, row: 0x10 },
  { icon: 0x22, col: 11, row: 0x20 }, { icon: 0x23, col: 11, row: 0x30 },
  { icon: 0x24, col: 11, row: 0x40 }, { icon: 0x25, col: 11, row: 0x50 },
  { icon: 0x26, col: 11, row: 0x60 }, { icon: 0x27, col: 11, row: 0x70 },
  { icon: 0x3c, col: 14, row: 0x80 },
];

/**
 * The 26 number slots — 26 individually written `draw_popup_number` calls in the original
 * (@0x3d3e8); `offset / 2` is the resource type. Taken verbatim in call order, not derived from the
 * layout — the correspondence "icon column + 2, icon row + 4" is pinned by a test.
 */
// prettier-ignore
export const CASTLE_POPUP_NUMBERS: readonly { readonly resource: number; readonly col: number; readonly row: number }[] = [
  { resource: 0x0c / 2, col: 3, row: 0x04 }, { resource: 0x0e / 2, col: 3, row: 0x14 },
  { resource: 0x10 / 2, col: 3, row: 0x24 }, { resource: 0x12 / 2, col: 3, row: 0x34 },
  { resource: 0x18 / 2, col: 3, row: 0x44 }, { resource: 0x14 / 2, col: 3, row: 0x54 },
  { resource: 0x16 / 2, col: 3, row: 0x64 }, { resource: 0x1a / 2, col: 3, row: 0x74 },
  { resource: 0x1c / 2, col: 3, row: 0x84 },
  { resource: 0x1e / 2, col: 8, row: 0x04 }, { resource: 0x20 / 2, col: 8, row: 0x14 },
  { resource: 0x28 / 2, col: 8, row: 0x24 }, { resource: 0x2a / 2, col: 8, row: 0x34 },
  { resource: 0x26 / 2, col: 8, row: 0x44 }, { resource: 0x2c / 2, col: 8, row: 0x54 },
  { resource: 0x2e / 2, col: 8, row: 0x64 }, { resource: 0x24 / 2, col: 8, row: 0x74 },
  { resource: 0x22 / 2, col: 8, row: 0x84 },
  { resource: 0x30 / 2, col: 13, row: 0x04 }, { resource: 0x32 / 2, col: 13, row: 0x14 },
  { resource: 0x00 / 2, col: 13, row: 0x24 }, { resource: 0x02 / 2, col: 13, row: 0x34 },
  { resource: 0x04 / 2, col: 13, row: 0x44 }, { resource: 0x06 / 2, col: 13, row: 0x54 },
  { resource: 0x08 / 2, col: 13, row: 0x64 }, { resource: 0x0a / 2, col: 13, row: 0x74 },
];

/** Click zones @0x2c7a5: the exit and a second button that switches to screen 0x2b. */
export const CASTLE_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x27, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xbf, x0: 0x60, x1: 0x6f, y0: 0x80, y1: 0x8f },
];

/** Target screen of the second button. */
export const CASTLE_POPUP_NEXT_SCREEN = 0x2b;

export type CastlePopupAction =
  | { readonly kind: 'close'; readonly action: number }
  | { readonly kind: 'screen'; readonly action: number; readonly screen: number };

/** Click in drawing pixels to an action, or `null`. */
export function castlePopupAction(drawX: number, drawY: number): CastlePopupAction | null {
  const action = hitTestPanel(CASTLE_POPUP_HITBOXES, drawX, drawY);
  if (action === null) return null;
  return action === 0xbf
    ? { kind: 'screen', action, screen: CASTLE_POPUP_NEXT_SCREEN }
    : { kind: 'close', action };
}

/**
 * The 26 displayed numbers (@0x3d34e/@0x3d3a1).
 *
 * The castle adds the two reserves that the founding parked (`heldPlanks` slot 7, `heldStone`
 * slot 9); an inactive warehouse shows nothing but zeros.
 */
export function castlePopupCounts(building: {
  readonly isCastle: boolean;
  readonly active: boolean;
  readonly resources: readonly number[];
  readonly heldPlanks: number;
  readonly heldStone: number;
}): number[] {
  const buf = new Array<number>(26).fill(0);
  // A finished but not yet activated warehouse shows nothing but zeros.
  if (!building.isCastle && !building.active) return buf;
  if (building.isCastle) {
    buf[7] += building.heldPlanks;
    buf[9] += building.heldStone;
  }
  for (let i = 0; i < 26; i++) buf[i] += building.resources[i] ?? 0;
  return buf;
}

/** Draws screen 0x26 — background, layout table, then the 26 numbers. */
export function drawCastlePopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  building: Parameters<typeof castlePopupCounts>[0],
): void {
  tileBackground(fb, provider, BUILDING_POPUP_BG_ICON);
  drawLayout(fb, provider, CASTLE_POPUP_LAYOUT, UI_ICON_BASE);
  const counts = castlePopupCounts(building);
  for (const slot of CASTLE_POPUP_NUMBERS) {
    drawPanelNumber(fb, provider, counts[slot.resource] ?? 0, slot.col, slot.row);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Screen 0x2b — settlers held in a store (second page of the castle/warehouse popup)
//
// Renderer `FUN_0003d997`. 0x26 leads here, and from here action 0xc0 leads on to screen 0x2c —
// the castle popup is a three-page cycle.
//
// The screen counts which settlers currently sit idle in this store — not what the inventory record
// carries as `serfIndices` (that is only ONE representative per type). The original walks all serfs
// and counts those in state 1 whose inventory is this one.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Icon layout @0x3e081 — the first two entries are the buttons (page 0x3d, exit 0x3c), the other 26
 * the profession symbols.
 */
export const SERF_CENSUS_POPUP_LAYOUT: readonly LayoutItem[] = [
  { icon: 0x3d, col: 12, row: 0x80 }, { icon: 0x3c, col: 14, row: 0x80 },
  { icon: 0x09, col: 1, row: 0x00 }, { icon: 0x0a, col: 1, row: 0x10 },
  { icon: 0x0b, col: 1, row: 0x20 }, { icon: 0x0c, col: 1, row: 0x30 },
  { icon: 0x21, col: 1, row: 0x40 }, { icon: 0x20, col: 1, row: 0x50 },
  { icon: 0x1f, col: 1, row: 0x60 }, { icon: 0x1e, col: 1, row: 0x70 },
  { icon: 0x1d, col: 1, row: 0x80 },
  { icon: 0x0d, col: 6, row: 0x00 }, { icon: 0x0e, col: 6, row: 0x10 },
  { icon: 0x12, col: 6, row: 0x20 }, { icon: 0x0f, col: 6, row: 0x30 },
  { icon: 0x10, col: 6, row: 0x40 }, { icon: 0x11, col: 6, row: 0x50 },
  { icon: 0x19, col: 6, row: 0x60 }, { icon: 0x1a, col: 6, row: 0x70 },
  { icon: 0x1b, col: 6, row: 0x80 },
  { icon: 0x13, col: 11, row: 0x00 }, { icon: 0x14, col: 11, row: 0x10 },
  { icon: 0x15, col: 11, row: 0x20 }, { icon: 0x16, col: 11, row: 0x30 },
  { icon: 0x17, col: 11, row: 0x40 }, { icon: 0x18, col: 11, row: 0x50 },
  { icon: 0x1c, col: 11, row: 0x60 }, { icon: 0x82, col: 11, row: 0x70 },
];

/**
 * The 26 numbers as `(serfType, col, row)`, read from the individually written `draw_popup_number`
 * calls. Every number sits on "icon column + 2 / icon row + 4" — that cross-checks the two
 * independently read tables against each other (pinned by a test).
 */
export const SERF_CENSUS_POPUP_NUMBERS: readonly {
  readonly serfType: number;
  readonly col: number;
  readonly row: number;
}[] = [
  { serfType: 0x00 / 2, col: 3, row: 0x04 }, { serfType: 0x02 / 2, col: 3, row: 0x14 },
  { serfType: 0x04 / 2, col: 3, row: 0x24 }, { serfType: 0x06 / 2, col: 3, row: 0x34 },
  { serfType: 0x34 / 2, col: 3, row: 0x44 }, { serfType: 0x32 / 2, col: 3, row: 0x54 },
  { serfType: 0x30 / 2, col: 3, row: 0x64 }, { serfType: 0x2e / 2, col: 3, row: 0x74 },
  { serfType: 0x2c / 2, col: 3, row: 0x84 },
  { serfType: 0x0a / 2, col: 8, row: 0x04 }, { serfType: 0x0c / 2, col: 8, row: 0x14 },
  { serfType: 0x14 / 2, col: 8, row: 0x24 }, { serfType: 0x0e / 2, col: 8, row: 0x34 },
  { serfType: 0x10 / 2, col: 8, row: 0x44 }, { serfType: 0x12 / 2, col: 8, row: 0x54 },
  { serfType: 0x22 / 2, col: 8, row: 0x64 }, { serfType: 0x24 / 2, col: 8, row: 0x74 },
  { serfType: 0x26 / 2, col: 8, row: 0x84 },
  { serfType: 0x16 / 2, col: 13, row: 0x04 }, { serfType: 0x18 / 2, col: 13, row: 0x14 },
  { serfType: 0x1a / 2, col: 13, row: 0x24 }, { serfType: 0x1c / 2, col: 13, row: 0x34 },
  { serfType: 0x1e / 2, col: 13, row: 0x44 }, { serfType: 0x20 / 2, col: 13, row: 0x54 },
  { serfType: 0x28 / 2, col: 13, row: 0x64 }, { serfType: 0x2a / 2, col: 13, row: 0x74 },
];

/**
 * The slot the original reads for the wide number in the bottom right (`buf[0x36]`, drawn only when
 * non-zero, @0x3e072). `0x36 / 2 = 27` — the buffer slot of serf type 27 (Dead).
 *
 * This number never appears in the original: the counting pass has exactly one increment and only
 * writes `buf[serfType]` for serfs in state 1 (`IdleInStock`), where a "Dead" serf cannot be.
 * Measured over 45 saves: 13703 serfs in state 1, three of type 27 — all in combat states.
 *
 * The port reproduces that instead of "fixing" it: same slot, drawn only when non-zero.
 */
export const SERF_CENSUS_TOTAL_SLOT = 0x36 / 2;

/** Place of the wide number in the bottom right (@0x3e05b/@0x3e062). */
export const SERF_CENSUS_TOTAL_POS = { col: 11, row: 0x84 } as const;

/** The two building types this screen shows anything for (`bld[4] & 0xfc` == 0x28 or 0x60). */
const WAREHOUSE_TYPE = 10;
const CASTLE_TYPE = 24;

/**
 * The counting pass: how many settlers of each profession sit idle in this store?
 *
 * `null` means the original would close the screen (burning, or a type other than warehouse and
 * castle). Otherwise a 28-slot buffer indexed by serf type.
 *
 * Unlike the goods popup this screen has no `active` check — a finished but not yet activated
 * warehouse is counted normally. (The original resolves `bld[0xe]` blindly as an inventory pointer
 * even while the field still holds the levelling height; the port counts nothing there rather than
 * reproducing a wild access.)
 */
export function serfCensusCounts(
  building: { readonly type: number; readonly burning: boolean; readonly inventoryIndex: number | null },
  serfs: readonly ({ readonly type: number; readonly state: number; readonly stateData: readonly number[] } | null)[],
): number[] | null {
  if (building.burning) return null;
  if (building.type !== WAREHOUSE_TYPE && building.type !== CASTLE_TYPE) return null;
  const buf = new Array<number>(28).fill(0);
  const inv = building.inventoryIndex;
  if (inv === null) return buf;
  for (const s of serfs) {
    if (s === null || s.state !== 1) continue; // state 1 = IdleInStock
    const home = (s.stateData[3] ?? 0) | ((s.stateData[4] ?? 0) << 8); // serf[0xe]
    if (home !== inv) continue;
    const t = s.type & 0x1f; // == (serf[0] & 0x7c) >> 2
    if (t < buf.length) buf[t] += 1;
  }
  return buf;
}

/** Draws screen 0x2b. `counts` comes from {@link serfCensusCounts}. */
export function drawSerfCensusPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  counts: readonly number[],
): void {
  tileBackground(fb, provider, BUILDING_POPUP_BG_ICON);
  drawLayout(fb, provider, SERF_CENSUS_POPUP_LAYOUT, UI_ICON_BASE);
  for (const slot of SERF_CENSUS_POPUP_NUMBERS) {
    drawPanelNumber(fb, provider, counts[slot.serfType] ?? 0, slot.col, slot.row);
  }
  // The wide number in the bottom right — never visible in the original, see SERF_CENSUS_TOTAL_SLOT.
  const wide = counts[SERF_CENSUS_TOTAL_SLOT] ?? 0;
  if (wide !== 0) {
    drawPanelNumberWide(fb, provider, wide, SERF_CENSUS_TOTAL_POS.col, SERF_CENSUS_TOTAL_POS.row);
  }
}

/**
 * Click zones @0x2c7b0 — two zones, each congruent with its button icon: 0x27 exit and 0xc0 page on
 * to screen 0x2c, the third page.
 */
export const SERF_CENSUS_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x27, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xc0, x0: 0x60, x1: 0x6f, y0: 0x80, y1: 0x8f },
];

/** Target screen of the page button (third page of the castle popup). */
export const SERF_CENSUS_POPUP_NEXT_SCREEN = 0x2c;

/** Click in drawing pixels to an action, or `null`. */
export function serfCensusPopupAction(drawX: number, drawY: number): CastlePopupAction | null {
  const action = hitTestPanel(SERF_CENSUS_POPUP_HITBOXES, drawX, drawY);
  if (action === null) return null;
  return action === 0xc0
    ? { kind: 'screen', action, screen: SERF_CENSUS_POPUP_NEXT_SCREEN }
    : { kind: 'close', action };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Screen 0x2c — the THIRD page of the castle/store popup: stock in / stock out
//
// Renderer `FUN_0003a3e8`, layout @0x3a698 (+ @0x3a6d6 for the castle only), click zones @0x2c7bb.
// That closes the cycle: 0x26 goods → 0x2b settlers → 0x2c mode → back.
//
// The four lower zones are gated on a special click (`bt $0x3, vp[1]` @0x2e16e — right button held).
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Base layout @0x3a698 — the two pictograms (0x128 goods, 0x129 settlers), six empty check fields
 * and the two buttons.
 */
export const INVENTORY_MODE_POPUP_LAYOUT: readonly LayoutItem[] = [
  { icon: 0x128, col: 4, row: 0x10 }, { icon: 0x129, col: 4, row: 0x50 },
  { icon: 0xdc, col: 9, row: 0x10 }, { icon: 0xdc, col: 9, row: 0x20 },
  { icon: 0xdc, col: 9, row: 0x30 },
  { icon: 0xdc, col: 9, row: 0x50 }, { icon: 0xdc, col: 9, row: 0x60 },
  { icon: 0xdc, col: 9, row: 0x70 },
  { icon: 0x3d, col: 12, row: 0x80 }, { icon: 0x3c, col: 14, row: 0x80 },
];

/** Extra layout @0x3a6d6 — castle only: the five knight rank symbols, K4 on top. */
export const INVENTORY_MODE_KNIGHT_LAYOUT: readonly LayoutItem[] = [
  { icon: 0x21, col: 12, row: 0x10 }, { icon: 0x20, col: 12, row: 0x24 },
  { icon: 0x1f, col: 12, row: 0x38 }, { icon: 0x1e, col: 12, row: 0x4c },
  { icon: 0x1d, col: 12, row: 0x60 },
];

/**
 * The five rank numbers as `(rank, col, row)`; rank 4 is the highest (serf type 26). Each sits on
 * "icon column + 2 / icon row + 4" of its rank symbol — the same cross-check as on 0x26 and 0x2b.
 */
export const INVENTORY_MODE_KNIGHT_NUMBERS: readonly {
  readonly rank: number;
  readonly col: number;
  readonly row: number;
}[] = [
  { rank: 4, col: 14, row: 0x14 }, { rank: 3, col: 14, row: 0x28 },
  { rank: 2, col: 14, row: 0x3c }, { rank: 1, col: 14, row: 0x50 },
  { rank: 0, col: 14, row: 0x64 },
];

/** Serf type of the lowest knight rank; the original compares `type · 4` against 0x58. */
const KNIGHT_TYPE_BASE = 0x58 / 4;

/** Check icon (0x120) and its column (9) — both checks share it. */
export const INVENTORY_MODE_CHECK_ICON = 0x120;
export const INVENTORY_MODE_CHECK_COL = 9;

/** The three check rows per group: goods 0x10/0x20/0x30, settlers 0x50/0x60/0x70. */
export const INVENTORY_MODE_RESOURCE_ROWS: readonly number[] = [0x10, 0x20, 0x30];
export const INVENTORY_MODE_SERF_ROWS: readonly number[] = [0x50, 0x60, 0x70];

/**
 * Which of the three check rows is active? The renderer tests only the two bits, not the value:
 * bit 1 ⇒ bottom, else bit 0 ⇒ middle, else top.
 *
 * Note that the writer stores 3 for "bottom", not 2 (see {@link INVENTORY_MODE_VALUES}); both
 * render the same because only bit 1 counts.
 */
export function inventoryModeRow(mode: number, rows: readonly number[]): number {
  if ((mode >> 1) & 1) return rows[2]!;
  if (mode & 1) return rows[1]!;
  return rows[0]!;
}

/**
 * The chain step of the garrison list: `serf[0xe]` as a u16 from the raw union bytes.
 *
 * Both garrison renderers read this word unconditionally, without checking the serf's state — hence
 * the raw read here. A named decoding of the union would be stale for a living serf (the engine
 * writes the bytes, not the decoding) and would yield a completely different chain.
 */
export function nextGarrisonKnight(serf: { readonly stateData: readonly number[] }): number {
  return (serf.stateData[3] ?? 0) | ((serf.stateData[4] ?? 0) << 8);
}

/**
 * The five rank numbers of the castle. Walks the garrison list from `building.firstKnight`; index 0
 * is K0.
 *
 * Reproduced quirk: a non-knight in the list *breaks* the loop, it is not skipped. A `continue`
 * would be the obvious "improvement" and would yield different numbers for a mixed list.
 */
export function inventoryModeKnightCounts(
  building: { readonly firstKnight: number },
  serfs: readonly ({ readonly type: number; readonly stateData: readonly number[] } | null)[],
): number[] {
  const buf = [0, 0, 0, 0, 0];
  let idx = building.firstKnight;
  // Loop guard: the original has none — a cyclic list would hang there. We stop after at most as
  // many steps as there are serfs (beyond that a slot must have been visited twice).
  for (let guard = 0; idx !== 0 && guard <= serfs.length; guard++) {
    const s = serfs[idx];
    if (!s) break;
    const rank = (s.type & 0x1f) - KNIGHT_TYPE_BASE;
    if (rank < 0) break;
    if (rank < buf.length) buf[rank]! += 1;
    idx = nextGarrisonKnight(s);
  }
  return buf;
}

/** Draws screen 0x2c. `knightCounts` only for the castle, `null` for a warehouse. */
export function drawInventoryModePopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  resMode: number,
  serfMode: number,
  knightCounts: readonly number[] | null,
): void {
  tileBackground(fb, provider, BUILDING_POPUP_BG_ICON);
  drawLayout(fb, provider, INVENTORY_MODE_POPUP_LAYOUT, UI_ICON_BASE);
  if (knightCounts !== null) {
    drawLayout(fb, provider, INVENTORY_MODE_KNIGHT_LAYOUT, UI_ICON_BASE);
    for (const n of INVENTORY_MODE_KNIGHT_NUMBERS) {
      drawPanelNumber(fb, provider, knightCounts[n.rank] ?? 0, n.col, n.row);
    }
  }
  drawPanelIcon(fb, provider, INVENTORY_MODE_CHECK_ICON, INVENTORY_MODE_CHECK_COL,
    inventoryModeRow(resMode, INVENTORY_MODE_RESOURCE_ROWS));
  drawPanelIcon(fb, provider, INVENTORY_MODE_CHECK_ICON, INVENTORY_MODE_CHECK_COL,
    inventoryModeRow(serfMode, INVENTORY_MODE_SERF_ROWS));
}

/**
 * Click zones @0x2c7bb — six check zones plus exit (0x27) and page (0xc1).
 *
 * The walker picks the table by `gs+0x37e` bit 5: when set it takes @0x2c7d9, the same list without
 * the six check zones (a suffix of the same bytes — they share the `0xff` terminator). The bit is
 * set only for game type 4, which also lets the map click skip the ownership check.
 */
export const INVENTORY_MODE_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0xc3, x0: 0x48, x1: 0x57, y0: 0x10, y1: 0x1f },
  { action: 0xc4, x0: 0x48, x1: 0x57, y0: 0x20, y1: 0x2f },
  { action: 0xc5, x0: 0x48, x1: 0x57, y0: 0x30, y1: 0x3f },
  { action: 0xc6, x0: 0x48, x1: 0x57, y0: 0x50, y1: 0x5f },
  { action: 0xc7, x0: 0x48, x1: 0x57, y0: 0x60, y1: 0x6f },
  { action: 0xc8, x0: 0x48, x1: 0x57, y0: 0x70, y1: 0x7f },
  { action: 0x27, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xc1, x0: 0x60, x1: 0x6f, y0: 0x80, y1: 0x8f },
];

/** The zone list with `gs+0x37e` bit 5 set (@0x2c7d9) — the same suffix without the checks. */
export const INVENTORY_MODE_POPUP_HITBOXES_LOCKED: readonly HitRect[] =
  INVENTORY_MODE_POPUP_HITBOXES.slice(6);

/** Target screen of the page button: back to the first page. */
export const INVENTORY_MODE_POPUP_NEXT_SCREEN = 0x26;

/**
 * What a click on screen 0x2c triggers. `special` means the original only carries it out on a
 * special click (`bt $0x3, vp[1]`).
 */
export type InventoryModePopupAction =
  | { readonly kind: 'close'; readonly action: number }
  | { readonly kind: 'screen'; readonly action: number; readonly screen: number }
  | {
      readonly kind: 'mode';
      readonly action: number;
      readonly group: 'resources' | 'serfs';
      readonly value: number;
      readonly special: boolean;
    };

/**
 * The values the six handlers really store — 0, 1, 3, not 0/1/2: each sets its two bits
 * individually (@0x2e126/@0x2e13a, @0x2e187/@0x2e19b, …). The renderer only tests bit 1, so 2 and 3
 * look the same — but the writer stores 3.
 */
export const INVENTORY_MODE_VALUES = { in: 0, stop: 1, out: 3 } as const;

/** Click zone to action. `locked` = `gs+0x37e` bit 5 (game type 4): only exit and page. */
export function inventoryModePopupAction(
  drawX: number,
  drawY: number,
  locked = false,
): InventoryModePopupAction | null {
  const action = hitTestPanel(
    locked ? INVENTORY_MODE_POPUP_HITBOXES_LOCKED : INVENTORY_MODE_POPUP_HITBOXES,
    drawX,
    drawY,
  );
  if (action === null) return null;
  switch (action) {
    case 0x27: return { kind: 'close', action };
    case 0xc1: return { kind: 'screen', action, screen: INVENTORY_MODE_POPUP_NEXT_SCREEN };
    case 0xc3: return { kind: 'mode', action, group: 'resources', value: INVENTORY_MODE_VALUES.in, special: false };
    case 0xc4: return { kind: 'mode', action, group: 'resources', value: INVENTORY_MODE_VALUES.stop, special: true };
    case 0xc5: return { kind: 'mode', action, group: 'resources', value: INVENTORY_MODE_VALUES.out, special: true };
    case 0xc6: return { kind: 'mode', action, group: 'serfs', value: INVENTORY_MODE_VALUES.in, special: false };
    case 0xc7: return { kind: 'mode', action, group: 'serfs', value: INVENTORY_MODE_VALUES.stop, special: true };
    default: return { kind: 'mode', action, group: 'serfs', value: INVENTORY_MODE_VALUES.out, special: true };
  }
}
