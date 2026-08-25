/**
 * The **window frame** shared by all drawing passes of the map window.
 *
 * A frame is: the visible half rows (`map-viewport.ts`) plus the sub-tile remainder of the fine
 * scroll. Every pass takes its positions from it — ground, roads, entities, colour triangles.
 *
 * ## Why the position must come FROM THE TRAVERSAL
 *
 * Positions may come **only** from the running counters of the traversal (`xOffset + k*32`, `i*20`),
 * never from `col/row` through the camera. Reason: when the window is larger than one map period the
 * traversal visits the **same** tile several times (it wraps on). From `col/row` the position would
 * be the same every time; the result is a picture in which the ground repeats while
 * buildings/roads/serfs stick once in the middle. That is what {@link tileAnchor} is for.
 *
 * Passes iterating over entity **records** (instead of the traversal) have no running counter — they
 * need `viewport-camera.entityAnchorAll`.
 *
 * ## Two row origins, not one — {@link ENTITY_ROW_BIAS}
 *
 * The original draws the map in **two separate passes with their own bookkeeping**, and their row
 * origins are **not equal**. The difference is exactly 1 pixel.
 *
 * ## Load-bearing assumption
 *
 * **Every half row carries exactly one map row, and no tile appears in two half rows.** Only for that
 * reason may the entity passes simply walk the half rows (otherwise everything would be drawn twice
 * and serfs would lie over buildings of the same row). The half-row sequence is therefore already the
 * original's row painter order.
 */

import { ENTITY_ROW_BIAS, TILE_H, TILE_W } from './map-render.js';
import { buildHalfRows, viewportSpan, type HalfRow } from './map-viewport.js';
import { cameraScroll, type Camera } from './viewport-camera.js';
import type { MapGeometry } from './engine/position.js';

export interface WindowFrame {
  readonly halfRows: readonly HalfRow[];
  /** Sub-tile remainder of the fine scroll in x — subtract it from every position. */
  readonly pixelX: number;
  readonly pixelY: number;
}

/**
 * Builds the frame for a camera position.
 *
 * `maxHeight` is the tallest tile height on the map; it determines the half-row margin downwards (the
 * height shear pulls tall tiles up, so their triangles must be drawn from further below). Too small
 * => gaps at the lower window edge.
 */
export function buildWindowFrame(
  cam: Camera,
  geo: MapGeometry,
  maxHeight: number,
): WindowFrame {
  // **Two half rows BEFORE the window** — otherwise the topmost image row is partly missing.
  //
  // A down triangle of row `r` sits at `r*20 + 20 - 4m` and its mask pivot reaches to `-40`
  // (`terrain-surface.MASK_TOP_REACH`); at `m = 0` it therefore draws down to `r*20 + 21`, i.e. 21 px
  // below the row boundary and thus into the window, which only starts at `(r+1)*20`. Starting the
  // traversal at the first visible row leaves those commands out. That shows only when the fine
  // scroll remainder is 0 (`originY % 20 === 0`) — in the view that is the clipped window edge, but on
  // the WORLD-anchored surface it is the y seam in the middle of the image: single pixels stayed at
  // index 0 and were drawn black.
  //
  // Two, not one: `buildHalfRows` always starts with `kind: 'up'`, so the half-row parity (and with it
  // the x offset 0/-16) hangs on the start row; an offset of **two** rows leaves it unchanged.
  // `cameraScroll` then yields the same `pixelX/pixelY` (the shear cancels: two rows higher is exactly
  // one column further left), so the compensation is solely the `LEAD_HALF_ROWS * TILE_H` added to
  // `pixelY`.
  const lead = LEAD_HALF_ROWS * TILE_H;
  const scroll = cameraScroll({ ...cam, originY: cam.originY - lead });
  const span = viewportSpan(cam.width, cam.height + lead, maxHeight);
  return {
    halfRows: buildHalfRows(scroll, geo, span),
    pixelX: scroll.pixelX,
    pixelY: scroll.pixelY + lead,
  };
}

/** Half rows above the window — see {@link buildWindowFrame}. */
export const LEAD_HALF_ROWS = 2;

/**
 * **Flat** tile anchor in window pixels: half row `i`, tile `k` within that half row.
 *
 * Flat means without the height lift — every pass brings its own, because they differ: the ground
 * lifts per triangle apex, everything standing *on* the tile by `height * heightUnit`.
 */
export function tileAnchor(
  frame: WindowFrame,
  i: number,
  k: number,
): { x: number; y: number } {
  return {
    x: frame.halfRows[i]!.xOffset + k * TILE_W - frame.pixelX,
    y: i * TILE_H - frame.pixelY,
  };
}

/**
 * Tile anchor for the **screen group** (objects/buildings/flags/serfs/markers) — like
 * {@link tileAnchor} but {@link ENTITY_ROW_BIAS} lower.
 *
 * The counterpart for passes over entity **records** is `viewport-camera.entityAnchorAll`; it carries
 * the same offset.
 */
export function entityAnchor(
  frame: WindowFrame,
  i: number,
  k: number,
): { x: number; y: number } {
  const flat = tileAnchor(frame, i, k);
  return { x: flat.x, y: flat.y + ENTITY_ROW_BIAS };
}
