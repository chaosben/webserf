/**
 * Map window of the original renderer (pure geometry, backend-independent).
 *
 * The original does **not** draw the whole map but one tile window per frame, scrolling over the
 * torus. This module provides exactly its traversal: the list of visible tiles, grouped by row, with
 * drawing y and x start per half row.
 *
 * ## The procedure (read from the original executable)
 *
 * The descriptor builder `FUN_0000d93a` lays out a list of precomputed tile pointers for every **half
 * row**; the drawing loop (`FUN_00033ff3`) then computes no coordinates at all, it reads pointers:
 *
 * ```
 *   nUp   = (vp[0x20] + 1) >> 1        // tiles of an up half row
 *   nDown = (vp[0x20] + 2) >> 1        // tiles of a down half row
 *   col = (vp[0x46] - vp[0x4a]) & colMask,  row = (vp[0x48] - vp[0x4c]) & rowMask
 *   pos = ((row << shift) + col) * 4                    // byte offset into the tile array
 *   for every half row:
 *     saved = pos
 *     n times:  emit pointer; pos = (pos + 4) & gs[0]   // one tile right, with wrap
 *     pos = (saved + delta) & gs[0]                     // delta = "down" resp. "down-right"
 * ```
 *
 * **The torus wrap sits in the mask `gs[0]`**, and it is row-local: the in-RAM position uses
 * `shift = colSize + 1`, so it has a **gap bit** between the column and row bits, and
 * `gs[0] = (rowMask << (shift+2)) | (colMask << 2)` leaves out exactly that bit. A step past the last
 * column lands in the hole and is masked away, giving column 0 of the **same** row. (Worked through
 * for 64x64: `gs[0] = 0b111111011111100`, hole at bit 8; `(col 63, row 10) + 4` gives
 * `(col 0, row 10)`.) The original arithmetic is therefore **provably equivalent** to the primitives
 * in `engine/position.ts`, which mask col and row separately — hence this module uses those
 * (byte-verified) primitives instead of reproducing the byte-offset encoding.
 *
 * ## Why "down" and "down-right" alternate
 *
 * After every half row it goes one row down — alternately **down** (`gs->field_0xc` = 512 = one row)
 * and **down-right** (`gs->field_0x8` = 516 = row + column). Over two half rows that is `row + 2,
 * col + 1`, which is the **shear compensation**: two rows correspond to 2 x 16 px = 32 px = one tile
 * width. That is why the original needs **no** row-dependent x offset — the x start only alternates
 * between 0 (up) and -16 px (down), the shear itself sits in the tile traversal.
 */

import {
  Direction,
  neighbor,
  posOf,
  type MapGeometry,
} from './engine/position.js';
import { HEIGHT_UNIT, MAX_HEIGHT, TILE_H, TILE_W } from './map-render.js';

/** Tile width in 8-px units (the original's `vreg6` step: +4 gives 32 px). */
export const TILE_W_UNITS = TILE_W / 8;

/** x start of the down half rows in 8-px units (original: `vreg6 = -2`, i.e. -16 px = half a tile). */
export const DOWN_ROW_X_UNITS = -2;

/** y of the first half row (original: `vreg4` starts at -4). */
export const FIRST_HALF_ROW_Y = -4;

/** Window dimensions in tiles — `tileWidth` = `vp[0x20]`, `halfRows` = `vp[0x50]`. */
export interface ViewportSpan {
  /** Tiles of a **full** row; half rows get half of it each (see `nUp`/`nDown`). */
  readonly tileWidth: number;
  /** Number of half rows to draw. */
  readonly halfRows: number;
}

/**
 * Scroll state of the window — `vp[0x46]/0x48` minus the centring offset `vp[0x4a]/0x4c`.
 *
 * **`centerOffsetCol/Row` are TILES, not a pixel fine scroll**: the original sets `vp[0x4a]/0x4c` at
 * viewport setup to small constants (9/8, 6/8, 16/14 = half the window dimensions in tiles).
 * `vp[0x46]/0x48` is therefore the **centre** tile of the view, and this offset converts it back to
 * the top-left corner.
 *
 * Consequence: **the original window is tile-aligned** — there is no sub-tile scrolling of the ground
 * there. That is exactly why the 21 tile pointers of a half row fit into the 84-byte descriptor with
 * no spare column. Pixel-smooth scrolling is **an addition of this port** (see {@link viewportSpan}).
 */
export interface ViewportScroll {
  readonly col: number;
  readonly row: number;
  /** Centring offset in **tiles** (original `vp[0x4a]`), not pixels. */
  readonly centerOffsetCol?: number;
  readonly centerOffsetRow?: number;
}

/**
 * One half row of the window: **which tiles** are to be drawn in this row.
 *
 * `kind` does **not** select the triangle kind. Every half row draws **both** triangles (up *and*
 * down) of its tiles — measured: one triangle kind per half row covers exactly half the window area
 * (609 triangles), both kinds give 1218, and **all 1218** appear in the pixel-verified reference
 * traversal, area coverage 127 %. `kind` only governs the **tile count** (`nUp` vs. `nDown`) and the
 * x offset of the original bookkeeping.
 *
 * A triangle's drawing position comes from its source tile — see `terrainTriangle()` in
 * `map-render.ts`; it is **not** derivable from this half row's `y`/`xOffset`.
 *
 * **Every half row carries exactly ONE map row** (its start row grows by 1 per half row, see
 * `buildHalfRows`). The half-row sequence is therefore already the row painter order over the visible
 * tiles, **without duplicates** — the prerequisite for the entity passes (objects, serfs) simply
 * walking the half rows without drawing anything twice.
 */
export interface HalfRow {
  /** Half-row kind; alternates, starting with `up`. Determines the tile count, **not** the triangle kind. */
  readonly kind: 'up' | 'down';
  /**
   * The original's half-row y (`vreg4`), informational only: -4 + i*20. The actual triangle y follows
   * from the source tile (including height shear), see `terrainTriangle()`.
   */
  readonly y: number;
  /** x offset of the original bookkeeping (0 resp. -16 px) — informational as well, see above. */
  readonly xOffset: number;
  /**
   * Canonical map positions (`row*cols + col`, directly indexable into `mapTiles`) of this half row's
   * tiles, left to right. Length = `nUp` resp. `nDown`.
   */
  readonly tiles: Int32Array;
}

/**
 * How many tiles a pixel viewport holds. `tileWidth` counts tiles of a **full** row, i.e. twice as
 * many as a half row contains — `vp[0x20]` in the original holds the same value.
 *
 * Three margins, each for its own reason, all of them measured against the image resp. via a coverage
 * check:
 *
 * 1. **Half a tile for the up offset.** Up triangles sit at `x = sx - 16`, so an up row reaches 16 px
 *    too short on the right. Hence `tileWidth` is **odd**, giving `nUp == nDown`.
 * 2. **A whole tile in x and y for sub-tile scrolling.** With pixel-smooth scrolling the window origin
 *    is not tile-aligned; everything shifts by up to `TILE_W-1` / `TILE_H-1`. Without this margin a
 *    strip at the **right** edge stayed uncovered (measured: 480 pixels at fine scroll 13/7, all of
 *    them in columns >= 300). **The original does not need this margin** — its window is tile-aligned
 *    (see {@link ViewportScroll}), which is why its 21 tile pointers fit the 84-byte descriptor
 *    exactly. Pixel-smooth scrolling is our addition and costs precisely this one column.
 * 3. **Height shear in y.** A tile of height `h` is pulled up by `4*h`, so tiles from *below* the
 *    window must be drawn too, otherwise the bottom edge stays black over mountains. The margin is
 *    therefore **derived** from `maxHeight` rather than fixed: a constant of 5 half rows (100 px)
 *    covers the campaign saves and leaves a gap at height 31 (= 124 px of lift) — a data-dependent
 *    bug that strikes exactly when nobody thinks of it any more.
 *
 * `maxHeight` may be lowered to the map's actual maximum (computed once per map); the default
 * `MAX_HEIGHT` is the safe upper bound.
 */
export function viewportSpan(
  pixelWidth: number,
  pixelHeight: number,
  maxHeight: number = MAX_HEIGHT,
): ViewportSpan {
  // (1) half a tile for the up offset sits in the odd `tileWidth`; (2) +1 tile for sub-tile scroll.
  const across = Math.ceil((pixelWidth + TILE_W - 1) / TILE_W) + 1;
  // (2) + (3): sub-tile remainder and height lift in half rows, plus one for the one clipped above.
  const lift = maxHeight * HEIGHT_UNIT;
  const halfRows = Math.ceil((pixelHeight + TILE_H - 1 + lift) / TILE_H) + 1;
  return { tileWidth: across * 2 - 1, halfRows };
}

/** Tiles of an up half row (original `field_0x250 = (vp[0x20]+1) >> 1`). */
export function upRowTileCount(span: ViewportSpan): number {
  return (span.tileWidth + 1) >> 1;
}

/** Tiles of a down half row (original `field_0x252 = (vp[0x20]+2) >> 1`). */
export function downRowTileCount(span: ViewportSpan): number {
  return (span.tileWidth + 2) >> 1;
}

/**
 * Builds the window's half rows — the counterpart to `FUN_0000d93a`.
 *
 * Structured deliberately like the original: start tile from the (fine-scroll corrected) scroll
 * offset, then `n` steps right per half row, and between half rows alternately a **down** resp.
 * **down-right** step from the row start. Every step wraps over the torus.
 */
export function buildHalfRows(
  scroll: ViewportScroll,
  geo: MapGeometry,
  span: ViewportSpan,
): HalfRow[] {
  const nUp = upRowTileCount(span);
  const nDown = downRowTileCount(span);

  // Start tile: `col = (vp[0x46] - vp[0x4a]) & colMask`, `row = (vp[0x48] - vp[0x4c]) & rowMask`
  // (the offset is the centring offset in TILES, see `ViewportScroll`). `posOf` masks both axes — the
  // same result as the original's byte-offset mask, just on the canonical position.
  let rowStart = posOf(
    scroll.col - (scroll.centerOffsetCol ?? 0),
    scroll.row - (scroll.centerOffsetRow ?? 0),
    geo,
  );

  const out: HalfRow[] = [];
  let y = FIRST_HALF_ROW_Y;

  for (let i = 0; i < span.halfRows; i++) {
    const isUp = i % 2 === 0;
    const n = isUp ? nUp : nDown;

    const tiles = new Int32Array(n);
    let pos = rowStart;
    for (let k = 0; k < n; k++) {
      tiles[k] = pos;
      pos = neighbor(pos, Direction.Right, geo); // original: `pos = (pos + 4) & gs[0]`
    }

    out.push({
      kind: isUp ? 'up' : 'down',
      y,
      xOffset: isUp ? 0 : DOWN_ROW_X_UNITS * 8,
      tiles,
    });

    // Next half row: one step down from the **row start**. Alternately `down` (`gs->field_0xc`) and
    // `down-right` (`gs->field_0x8`) — together `row+2, col+1` per two half rows, the shear
    // compensation (see module header).
    rowStart = neighbor(rowStart, isUp ? Direction.Down : Direction.DownRight, geo);
    y += TILE_H;
  }

  return out;
}

/**
 * x progress within a half row (pixels), relative to its `xOffset`. The original counts in 8-px units
 * (`vreg6 += 4` per tile); here directly in pixels. **For the original bookkeeping only** — a
 * triangle's drawing position comes from `terrainTriangle()`.
 */
export function tileX(row: HalfRow, indexInRow: number): number {
  return row.xOffset + indexInRow * TILE_W;
}
