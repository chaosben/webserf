/**
 * Soil analysis popup (screen 0x16) — layout, text scale, click zone.
 *
 * Renderer `FUN_0003ea6e` @0x3ea6e (popup render table `@0x37fb9`, entry `(0x16-1)*8`):
 *
 * ```
 * draw_popup_background(0x81)                  # FUN_00042019, tiled background
 * draw_popup_layout(@0x3ec93)                  # FUN_00041fe0 -> icon bank +0x366 (FUN_00034981)
 * player = vp[0x82]; soil_analysis(player)     # FUN_0003f42c, see engine/soil-analysis.ts
 * text "  BODENPROBEN:"      @ (col 0, row 0x1e) — the indent is part of the text
 * text level(2 * gold)       @ (col 3, row 0x36)
 * text level(1 * iron)       @ (col 3, row 0x4a)
 * text level(coal >> 1)      @ (col 3, row 0x5e)
 * text level(2 * granite)    @ (col 3, row 0x72)
 * ```
 *
 * The **weighting of the display** (gold x2, iron x1, coal /2, granite x2) sits in the renderer, not
 * in the analysis — the same raw sum is judged differently per resource.
 *
 * The text primitive is `FUN_00037c78` (panel surface, `x = col*8+8`, `y = row+9`, foreground palette
 * index 0x1f, **no** shadow) -> `drawPanelText` here. Unlike the build popups the icons come from the
 * **icon bank** `+0x366` ({@link UI_ICON_BASE}), because `FUN_00041fe0` blits via `FUN_00034981`.
 */

import {
  drawLayout,
  drawPanelText,
  hitTestPanel,
  tileBackground,
  UI_ICON_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';
import { t } from './language.js';

/** Screen number (`vp[0x70]`/`vp[0x72]`) of the soil analysis popup. */
export const SOIL_POPUP_SCREEN = 0x16;

/** Background tile of this popup (`mov $0x81,%ax; call 0x42019`) — not the grass tile 0x83. */
export const SOIL_POPUP_BG_ICON = 0x81;

/**
 * Icon layout `@0x3ec93` (int16 triples `{icon, col, row}`, negatively terminated): head symbol, the
 * four resource symbols in the order gold/iron/coal/granite, and the exit symbol.
 */
export const SOIL_POPUP_LAYOUT: readonly LayoutItem[] = [
  { icon: 28, col: 7, row: 10 },
  { icon: 47, col: 1, row: 50 },
  { icon: 44, col: 1, row: 70 },
  { icon: 46, col: 1, row: 90 },
  { icon: 43, col: 1, row: 110 },
  { icon: 60, col: 14, row: 128 },
];

/**
 * Title of the popup (`@0x3ec1c`) at panel position (0, 0x1e).
 *
 * **The two leading spaces belong to it.** The original draws the string at **column 0**
 * (`lea 0x3ec1c,%esi` @0x3ea9e, then `mov $0x0` into the column and `mov $0x1e` into the row) — the
 * indent lives in the text, not in the position. Trimming it would move the title two characters to
 * the left, and it would also break the language lookup: the English wording has no indent.
 */
export const SOIL_POPUP_TITLE = '  BODENPROBEN:';
export const SOIL_POPUP_TITLE_COL = 0;
export const SOIL_POPUP_TITLE_ROW = 0x1e;

/**
 * Lower bounds of the rating levels (`FUN_0003eb71` @0x3eb71): the first entry applies to exactly 0,
 * after that `value < bound` decides.
 */
export const SOIL_LEVEL_THRESHOLDS: readonly number[] = [100, 180, 240, 300, 400, 500, 600, 800];

/** Rating texts in level order (strings `@0x3ec2b`ff). */
export const SOIL_LEVEL_LABELS: readonly string[] = [
  'UNAUFFINDBAR',
  'MINIMAL',
  'SEHR WENIG',
  'WENIG',
  'UNTER MITTEL',
  'DURCHSCHNITT',
  'UEBER MITTEL',
  'VIEL',
  'SEHR VIEL',
  'EXTREM VIEL',
];

/** Rating text for an (already weighted) display value — `FUN_0003eb71`. */
export function soilLevelLabel(value: number): string {
  if (value === 0) return SOIL_LEVEL_LABELS[0]!;
  for (let i = 0; i < SOIL_LEVEL_THRESHOLDS.length; i++) {
    if (value < SOIL_LEVEL_THRESHOLDS[i]!) return SOIL_LEVEL_LABELS[i + 1]!;
  }
  return SOIL_LEVEL_LABELS[SOIL_LEVEL_LABELS.length - 1]!;
}

/**
 * One row of the popup: analysis slot (0 = gold ... 3 = granite), the renderer's display weighting and
 * the panel row of the text. `weigh` maps the raw sum onto the rated value.
 */
export interface SoilRow {
  readonly slot: number;
  readonly name: string;
  readonly row: number;
  readonly weigh: (raw: number) => number;
}

/** The four rows in original order (gold x2, iron x1, coal /2, granite x2). */
export const SOIL_POPUP_ROWS: readonly SoilRow[] = [
  { slot: 0, name: 'gold', row: 0x36, weigh: (v) => v * 2 },
  { slot: 1, name: 'iron', row: 0x4a, weigh: (v) => v },
  { slot: 2, name: 'coal', row: 0x5e, weigh: (v) => v >>> 1 },
  { slot: 3, name: 'granite', row: 0x72, weigh: (v) => v * 2 },
];

/** Panel column of the four rating texts (`mov $0x3,%eax`). */
export const SOIL_POPUP_VALUE_COL = 3;

/**
 * Click zones `@0x2cc4a` (thunk `0x2c3d9` of the click table `@0x2c09e`, entry `0x16*8`): a single
 * zone at the bottom right — the exit symbol.
 */
export const SOIL_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0xf6, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/**
 * Action id of the exit zone. The original handler (`@0x2cd66 + 0xf6*8` -> `FUN_00028408`) closes the
 * popup (`vp[0x72] = 0`) and resets panel slots 2..4 to `{0x0a, 0x0c, 0x0e}`.
 */
export const SOIL_POPUP_ACTION_EXIT = 0xf6;

/** Icon row the exit handler writes back into slots 2..4 of the control panel. */
export const SOIL_POPUP_EXIT_ICONS: readonly number[] = [0x0a, 0x0c, 0x0e];

/** Click in drawing pixels -> action id (only the exit zone) or `null`. */
export function soilPopupAction(drawX: number, drawY: number): number | null {
  return hitTestPanel(SOIL_POPUP_HITBOXES, drawX, drawY);
}

/**
 * Draws the soil analysis popup: tiled background, icon layout, title and the four rated texts.
 * `analysis` are the four raw sums from `analyzeSoil` (gold/iron/coal/granite); the display weighting
 * is done by this routine, as in the original.
 */
export function drawSoilPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  analysis: readonly number[],
  textColor: readonly [number, number, number],
): void {
  tileBackground(fb, provider, SOIL_POPUP_BG_ICON);
  drawLayout(fb, provider, SOIL_POPUP_LAYOUT, UI_ICON_BASE);
  drawPanelText(
    fb,
    provider,
    t(SOIL_POPUP_TITLE),
    SOIL_POPUP_TITLE_COL,
    SOIL_POPUP_TITLE_ROW,
    textColor,
  );
  for (const r of SOIL_POPUP_ROWS) {
    const label = soilLevelLabel(r.weigh(analysis[r.slot] ?? 0));
    drawPanelText(fb, provider, t(label), SOIL_POPUP_VALUE_COL, r.row, textColor);
  }
}
