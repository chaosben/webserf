/**
 * Map selector - the marker sprites the original places around the clicked tile (`FUN_00015daf`,
 * called by the frame handler when the cursor dirty bit is set).
 *
 * The original keeps a marker list of seven records `{sprite, x, y}`. Record 0 is the cursor tile,
 * records 1..6 its six hex neighbours in exactly the direction order of `DIR_DELTA`:
 *
 * | Record | (dcol, drow) | direction |
 * |---|---|---|
 * | 0 | (0, 0) | cursor |
 * | 1 | (+1, 0) | Right |
 * | 2 | (+1, +1) | DownRight |
 * | 3 | (0, +1) | Down |
 * | 4 | (-1, 0) | Left |
 * | 5 | (-1, -1) | UpLeft |
 * | 6 | (0, -1) | Up |
 *
 * The x/y steps invert to `x_rel = 32*dcol - 16*drow`, `y_extra = 20*drow` - the same shear as the
 * ground pass.
 *
 * Record 2 = DownRight is no accident: that is where a building's flag sits, and the icon setter
 * writes the flag symbol into that record when a building is possible - the second marker shows where
 * the flag would go.
 *
 * Every record carries the height of its OWN tile, which multiplied out is the ordinary tile anchor;
 * the port still computes in the original's deltas so the structure stays comparable.
 *
 * The panel init fills the sprite fields with arrows in the middle and a dot on every neighbour; the
 * icon setter overwrites records 0 and 2.
 *
 * The marker blit adds `+0x10`/`+8` before appending the marker bank, and those two constants are not
 * a marker quirk - the primitive that draws map shadow and map object adds the same ones, so both
 * passes hit the tile centre. Our anchor convention already sits on that point, so the marker must NOT
 * add the offset a second time.
 */

import { DIR_DELTA } from './engine/position.js';
import type { CursorMarkerPair } from './ui-render.js';

/** Sprite value of the centre marker from the panel init (arrows). */
export const CURSOR_MARKER_CENTER = 0x20;
/** Sprite value of the six ring markers from the panel init (dot). */
export const CURSOR_MARKER_RING = 0x21;

/** A finished marker: sprite value (without bank base) and window position. */
export interface CursorMarker {
  /** Sprite value of the record; archive entry = `CURSOR_MARKER_BASE + sprite`. */
  readonly sprite: number;
  readonly x: number;
  readonly y: number;
}

/** Height of a tile (torus wrap is the caller's business). */
export type HeightAt = (col: number, row: number) => number;

export interface CursorMarkerInput {
  /** Anchor of the **cursor tile** in the window, height already subtracted (like `entityAnchorAll`). */
  readonly anchor: { readonly x: number; readonly y: number };
  readonly col: number;
  readonly row: number;
  readonly heightAt: HeightAt;
  /**
   * Sprites for records 0 and 2 from {@link CursorMarkerPair}. `null` => the routine did not touch the
   * list; then the init sprites stay, as in the original, whose two early returns leave the markers.
   */
  readonly markers: CursorMarkerPair | null;
  /**
   * The six ring sprites individually (`vp+0xaa`, stride 6). During **road building** the original
   * rewrites these slots completely (`@0x33170`, markers 0x2c/0x2d/`0x27+slope`) instead of only
   * records 0 and 2 — the same marker list, two different writers. Set takes precedence over
   * {@link markers}; `undefined` => the usual pair behaviour.
   */
  readonly ringSprites?: readonly number[];
  /** Pixels per height step (original 4). */
  readonly heightUnit: number;
}

/** Tile width / half-row height in scene pixels (original 32 / 20). */
const TILE_W = 32;
const HALF_ROW_H = 20;

/**
 * Computes the seven marker records for the cursor tile (port of `FUN_00015daf`).
 *
 * The original's window clamp (`x < 0`, `x >= vp[0x88]`, `y < 0`, `y >= vp[0x40]` => switch the list
 * off via bit 7) is **not** reproduced: it refers to the fixed DOS window area, while ours is the
 * browser surface and the blit backend clips itself. Visible behaviour is the same.
 */
export function buildCursorMarkers(input: CursorMarkerInput): CursorMarker[] {
  const { anchor, col, row, heightAt, markers, ringSprites, heightUnit } = input;
  const h0 = heightAt(col, row);
  const out: CursorMarker[] = [];

  for (let record = 0; record < 7; record++) {
    // Record 0 = cursor, 1..6 = the neighbours in `DIR_DELTA` order.
    const [dcol, drow] = record === 0 ? [0, 0] : DIR_DELTA[record - 1]!;
    const hn = heightAt(col + dcol, row + drow);
    const sprite =
      record === 0
        ? (markers?.primary ?? CURSOR_MARKER_CENTER)
        : (ringSprites?.[record - 1] ??
          (record === 2 ? (markers?.secondary ?? CURSOR_MARKER_RING) : CURSOR_MARKER_RING));
    out.push({
      sprite,
      // No drawing offset: `blit_map_marker_sprite` and the map object blit add the same (+0x10, +8)
      // — already contained in `tileAnchor` (see module head).
      x: anchor.x + TILE_W * dcol - (TILE_W / 2) * drow,
      y: anchor.y + HALF_ROW_H * drow + heightUnit * (h0 - hn),
    });
  }
  return out;
}
