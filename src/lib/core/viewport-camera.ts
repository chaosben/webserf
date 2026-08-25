/**
 * Camera of the map window: scene pixels, tile window and screen, with torus wrap.
 *
 * ## Why the wrap is not trivial here
 *
 * The map is a torus, but its scene projection is sheared. A wrap is therefore not a rectangular
 * modulo but a lattice with two skewed basis vectors:
 *
 * ```
 *   +cols columns  =>  A = (cols*32,        0    )
 *   +rows rows     =>  B = (-rows*16,  rows*20   )
 * ```
 *
 * (A row shears to the left, hence the negative x component of `B`.) A tile therefore has
 * infinitely many scene positions `s + a*A + b*B`; wanted is the one inside the window.
 *
 * That is solvable in closed form because only `B` moves the y axis: first determine `b` from y,
 * then `a` from the corrected x. That is what {@link tileToWindow} does - no search, no iteration.
 *
 * The original does not need this arithmetic because it derives positions from running counters
 * (see `terrain-commands.ts`) and finds objects through precomputed tile pointers. For the port it
 * is still the more honest way: serfs and resources sit between tiles, so their position is a tile
 * anchor plus a pixel delta, and the wrap has to be solvable at pixel level anyway.
 */

import { ENTITY_ROW_BIAS, HEIGHT_UNIT, TILE_H, TILE_W } from './map-render.js';
import type { MapGeometry } from './engine/position.js';
import type { ViewportScroll, ViewportSpan } from './map-viewport.js';

/**
 * Camera state. `originX`/`originY` are the scene coordinates of the top left window corner and may
 * grow or go negative without bound - that is what unlimited scrolling is. `width`/`height` are the
 * window dimensions in pixels (before zoom; zoom stays the backend's business).
 */
export interface Camera {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
}

/** The two lattice basis vectors of the torus in scene pixels (see module comment). */
export function wrapLattice(geo: MapGeometry): {
  ax: number;
  bx: number;
  by: number;
} {
  return {
    ax: geo.cols * TILE_W, // +cols columns
    bx: -geo.rows * (TILE_W / 2), // +rows rows: shear to the left
    by: geo.rows * TILE_H,
  };
}

/** Scene position of a tile anchor on the unrolled map (without height, without wrap). */
export function tileScene(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_W - row * (TILE_W / 2), y: row * TILE_H };
}

/**
 * Window pixel position of a tile anchor - the repetition nearest to the window out of the
 * infinitely many torus copies. `(0,0)` is the top left window corner.
 *
 * Order of resolution: `b` from y (only `B` moves y), then `a` from the x corrected by `b*B`. The
 * reference is the window centre each time, so the chosen repetition is the best one symmetrically.
 */
export function tileToWindow(
  col: number,
  row: number,
  cam: Camera,
  geo: MapGeometry,
): { x: number; y: number } {
  const { ax, bx, by } = wrapLattice(geo);
  const s = tileScene(col, row);

  const b = Math.round((cam.originY + cam.height / 2 - s.y) / by);
  const y = s.y + b * by - cam.originY;
  const sx = s.x + b * bx;
  const a = Math.round((cam.originX + cam.width / 2 - sx) / ax);
  return { x: sx + a * ax - cam.originX, y };
}

/**
 * Drawing anchor of an entity on `(col,row)` including the height lift - and all visible repetitions.
 *
 * {@link tileToWindow} deliberately returns the flat anchor: the ground brings its lift per triangle
 * from that triangle's apex (`terrain-commands.ts`), not from the tile. Everything standing *on* the
 * tile - buildings, flags, trees, serfs - depends on the height of *this* tile instead and is pulled
 * up by `height * heightUnit`. On top of that comes {@link ENTITY_ROW_BIAS}.
 *
 * The right tool for passes iterating over entity *records* (building/flag/serf lists): there is no
 * running counter there from which the repetitions would follow. Passes that walk the half-row
 * traversal must take their position ONLY from the running counters (`window-frame.tileAnchor`) -
 * otherwise they do not repeat with the ground when zoomed far out.
 */
export function entityAnchorAll(
  col: number,
  row: number,
  height: number,
  cam: Camera,
  geo: MapGeometry,
  pad: number,
  heightUnit: number = HEIGHT_UNIT,
): Array<{ x: number; y: number }> {
  // Screen group as in `window-frame.entityAnchor`, including the 1 px offset against the ground
  // group (rationale and byte evidence there under `ENTITY_ROW_BIAS`).
  const lift = height * heightUnit - ENTITY_ROW_BIAS;
  return tileToWindowAll(col, row, cam, geo, pad).map((p) => ({ x: p.x, y: p.y - lift }));
}

/**
 * All window positions of a tile anchor whose `pad` neighbourhood touches the window.
 *
 * {@link tileToWindow} returns only the nearest repetition. That is enough as long as the window is
 * smaller than one map period (`cols*32` resp. `rows*20` pixels). Zoomed far out it is not: the map
 * then repeats within the picture and the same tile has to be drawn several times.
 *
 * The number of repetitions is bounded in practice by {@link minZoomForWholeMap}, but this function
 * caps nothing. In the normal case it returns exactly one element.
 */
export function tileToWindowAll(
  col: number,
  row: number,
  cam: Camera,
  geo: MapGeometry,
  pad: number,
): Array<{ x: number; y: number }> {
  const { ax, bx, by } = wrapLattice(geo);
  const s = tileScene(col, row);
  const out: Array<{ x: number; y: number }> = [];

  // y depends on `b` alone, so the b range follows directly from the window height
  const bLo = Math.ceil((cam.originY - pad - s.y) / by);
  const bHi = Math.floor((cam.originY + cam.height + pad - s.y) / by);
  for (let b = bLo; b <= bHi; b++) {
    const y = s.y + b * by - cam.originY;
    const sx = s.x + b * bx;
    const aLo = Math.ceil((cam.originX - pad - sx) / ax);
    const aHi = Math.floor((cam.originX + cam.width + pad - sx) / ax);
    for (let a = aLo; a <= aHi; a++) out.push({ x: sx + a * ax - cam.originX, y });
  }
  return out;
}

/**
 * Tile scroll for {@link buildHalfRows} from the camera: the tile containing the top left window
 * corner, plus the pixel remainder inside that tile.
 *
 * Inverting {@link tileScene} is closed-form on the flat: `row = floor(y / 20)` and
 * `col = floor((x + row*16) / 32)`. The height shear is deliberately not taken into account - it
 * only moves the drawing y of the triangles, not the tile assignment of the window; the half-row
 * allowance derived from `maxHeight` in `viewportSpan` covers that.
 *
 * No counterpart in the original: its window is tile-aligned and `vp[0x4a]`/`vp[0x4c]` are a
 * centring offset in *tiles*. Pixel-smooth scrolling is our addition and costs the sub-tile
 * allowance in `viewportSpan`.
 */
export function cameraScroll(cam: Camera): ViewportScroll & {
  pixelX: number;
  pixelY: number;
} {
  const row = Math.floor(cam.originY / TILE_H);
  const col = Math.floor((cam.originX + row * (TILE_W / 2)) / TILE_W);
  const anchor = tileScene(col, row);
  return {
    col,
    row,
    pixelX: cam.originX - anchor.x,
    pixelY: cam.originY - anchor.y,
  };
}

/**
 * Centre tile of the view - the port's counterpart to reading `vp+0x46/0x48`.
 *
 * The original holds in `vp+0x46/0x48` not the top left corner of the window but its centre: every
 * consumer computes `vp[0x46] - vp[0x4a]` to get the corner (`compute_map_window_tiles` @0xd93a,
 * `draw_visible_serfs` @0x15ad7, `panel_click_dispatch` @0x272d7, `draw_build_helper_overlay`
 * @0x375ff), and `vp+0x4a/0x4c` is a centring offset in tiles that the four viewport
 * initialisations set as a constant.
 *
 * Here half the window size in scene pixels takes the place of that tile constant, because the view
 * scales and zooms freely.
 */
export function cameraCenterTile(
  cam: Camera,
  geo: MapGeometry,
  heightAt: (col: number, row: number) => number,
  heightUnit: number,
): { col: number; row: number } {
  return windowToTile(cam.width / 2, cam.height / 2, cam, geo, heightAt, heightUnit);
}

/**
 * Inverse of {@link cameraCenterTile}: the camera that puts `(col, row)` in the centre of the window
 * - the counterpart to writing `vp[0x46]/[0x48] = (col, row)`, as the click into the map preview
 * (`map_preview_click_goto` @0x2cd66) and the jump to the castle (`goto_own_castle` @0x56d8) do.
 *
 * Without height lift: `vp+0x46/0x48` is a pure tile coordinate in the original, the relief only
 * moves the drawing y of the triangles.
 */
export function cameraCenteredOnTile(
  col: number,
  row: number,
  width: number,
  height: number,
): { originX: number; originY: number } {
  const p = tileScene(col, row);
  return { originX: Math.round(p.x - width / 2), originY: Math.round(p.y - height / 2) };
}

/**
 * Tile under a window point (hit test). Always returns a tile: on a torus there is no "outside the
 * map", and the nearest tile anchor is at most ~19 px away in the 32 x 20 grid. Returned positions
 * are canonical (already wrapped) and usable directly in `mapTiles`.
 *
 * In relief `sceneY` depends via `-h*4` on the per-tile height, so it is not invertible in closed
 * form. Since height only pulls the anchor upwards (`h >= 0`), the true row never lies above the
 * flat estimate - so a few rows below it are checked.
 *
 * A tie goes to the later row. In relief a raised tile can land exactly on the anchor of another,
 * flat tile (shown in the test: tile (22,22) at height 10 falls exactly on the anchor of (21,20)).
 * Drawing is in painter order, so later rows lie on top - the click must hit the tile the user sees.
 * With a naive `<` a click on a mountain would select the plain behind it.
 */
export function windowToTile(
  wx: number,
  wy: number,
  cam: Camera,
  geo: MapGeometry,
  heightAt: (col: number, row: number) => number,
  heightUnit: number,
): { col: number; row: number } {
  const sceneX = cam.originX + wx;
  const sceneY = cam.originY + wy;

  const rowFlat = Math.floor(sceneY / TILE_H);
  const maxLift = 31 * heightUnit; // maximum height lift in pixels
  const rowHi = rowFlat + Math.ceil(maxLift / TILE_H) + 1;

  let best = { col: 0, row: 0 };
  let bestDist = Infinity;
  for (let row = rowFlat - 1; row <= rowHi; row++) {
    const col = Math.round((sceneX + row * (TILE_W / 2)) / TILE_W);
    const c = ((col % geo.cols) + geo.cols) % geo.cols;
    const r = ((row % geo.rows) + geo.rows) % geo.rows;
    const p = tileScene(col, row);
    const dx = p.x - sceneX;
    const dy = p.y - heightAt(c, r) * heightUnit - sceneY;
    const d = dx * dx + dy * dy;
    if (d <= bestDist) {
      // `<=`: on a tie the later (front) row wins - see the doc above
      bestDist = d;
      best = { col: c, row: r };
    }
  }
  return best;
}

/**
 * Smallest sensible zoom: the point at which the whole world fits into the window.
 *
 * The map is a torus with scene period `cols*32 x rows*20`. If the window holds more than that
 * period, the picture only shows repetitions - no new information, while the tile count grows
 * quadratically.
 *
 * It is the minimum of the two axis ratios, not the maximum. With `min` the window covers at least
 * one period on *both* axes, so the world is fully visible (with some repetition on the wider axis).
 * With `max` there would never be a repetition, but the world would never be fully visible on the
 * other axis - exactly what the user wants to see would be missing.
 *
 * Clamped to `1` so the limit never forces zooming *in*: if the world already fits at 100 % (small
 * map, large screen), 100 % is the floor.
 */
export function minZoomForWholeMap(
  viewportWidth: number,
  viewportHeight: number,
  geo: MapGeometry,
): number {
  const { ax, by } = wrapLattice(geo);
  return Math.min(1, Math.min(viewportWidth / ax, viewportHeight / by));
}

/** Window dimensions in tiles for this camera - a convenience wrapper around `viewportSpan`. */
export function cameraSpan(
  cam: Camera,
  span: (w: number, h: number) => ViewportSpan,
): ViewportSpan {
  return span(cam.width, cam.height);
}

/**
 * Execute the edge scroll - the consumer block of the edge mask `vp+0xd8` in `FUN_0000d630`
 * (`@0xd64e`..`@0xd784`). The mask itself is produced by the road building click
 * ({@link road-building.roadEdgeScroll}); this only says how far the view then moves.
 *
 * ```
 * if (vp[0xd8] == 0) return                                     @0xd65f
 * if (!(vp[0x86] & 1)) return                                   @0xd670   (road build scrolling)
 * if (bit 4)  { goto_own_castle ; vp[0xd8] = 0 ; return }        @0xd680   (special signal, see below)
 * if (bit 0)       vp[0x46] = (vp[0x46] - 2) & gs[0x32]          @0xd6b7   left
 * else if (bit 1)  vp[0x46] = (vp[0x46] + 2) & gs[0x32]          @0xd6e1   right
 * if (bit 2)     { vp[0x46] -= 2 ; vp[0x48] -= 4 }               @0xd709   up
 * else if (bit 3){ vp[0x46] += 2 ; vp[0x48] += 4 }               @0xd74f   down
 * vp[0xd8] = 0
 * ```
 *
 * Two things are not obvious. A vertical step moves the column along (+-2 for +-4 rows) - that is
 * the shear compensation of the hex grid, without which the view would drift sideways while
 * scrolling up and down. And horizontal and vertical are separate `if` chains: left *and* up shifts
 * the column twice (-4 in total), which follows from the order rather than being a typo.
 *
 * Bit 4 (`0x10`) is not a direction but a jump signal: `call 0x56d8` @0xd68c =
 * {@link gotoOwnCastle}, then `vp[0xd8] = 0` and return 1 (@0xd691..@0xd6a7), i.e. without the
 * direction chains below. The carrier is the same, the producer is not: {@link roadEdgeScroll} never
 * sets bit 4 - the special click on the map icon does (`mov $0x10` @0x27f28). So the caller carries
 * the switch: on bit 4 it calls {@link gotoOwnCastle} and not this function at all.
 *
 * Returns the new centre tile (`vp[0x46]/[0x48]`), already wrapped with the map masks.
 */
export function scrollCenterTileByEdgeMask(
  center: { readonly col: number; readonly row: number },
  mask: number,
  geo: MapGeometry,
): { col: number; row: number } {
  let col = center.col;
  let row = center.row;
  if ((mask & 1) !== 0) col -= 2;
  else if ((mask & 2) !== 0) col += 2;
  if ((mask & 4) !== 0) {
    col -= 2;
    row -= 4;
  } else if ((mask & 8) !== 0) {
    col += 2;
    row += 4;
  }
  return { col: col & (geo.cols - 1), row: row & (geo.rows - 1) };
}

/**
 * Jump to the own castle - `goto_own_castle` @0x56d8, the bit 4 branch of the edge scroll routine
 * ({@link scrollCenterTileByEdgeMask}).
 *
 * ```
 * player = vp[0x82]                                              @0x56db   player of THIS window
 * if (!(player[3] & 0x08)) return                                @0x56ec   `build` bit 3 = has castle
 * off  = player[0x104] * 0x12 + gs[0x9c]                         @0x56ff   building record (18 B)
 * raw  = *(u32 *)off                                             @0x5734   bld[0] = packed position
 * col  = (raw & gs[0x3a]) >> 2                                   @0x5740
 * row  = (raw & gs[0x3c]) >> (gs[0x30] + 2)                      @0x574a
 * vp[0x46] = col ; vp[0x48] = row                                @0x576e   centre tile of the view
 * player[0xfc] = vp[0x46] ; player[0xfe] = vp[0x48]              @0x5783   the CURSOR moves along
 * vp[1] |= 0x04                                                  @0x57ad
 * ```
 *
 * Three things are not obvious.
 *
 * The cursor moves along (@0x5783/@0x5794 on `player+0xfc/0xfe`): the jump is not a pure camera
 * move, afterwards the build cursor stands on the castle. So this function writes the cursor itself
 * and only returns the tile for the camera - the caller cannot forget half of it.
 *
 * The gate is `build` bit 3 ("has castle"), not `flags` bit 0 ("castle founded"). The two are almost
 * always equal but not the same: `found_castle` sets `flags` bit 0 and never clears it, while
 * `build` bit 3 is lost with the castle. After losing the castle the original no longer jumps - and
 * does nothing else either, no error sound.
 *
 * The original computes the position without the usual `>> 2` prologue: its masks `gs[0x3a]`/
 * `gs[0x3c]` already sit at the packed place and the shift comes afterwards. The result is the same
 * as with the usual decoding, and since our building record carries `col`/`row` decoded, only the
 * access remains here.
 *
 * The producer of bit 4 is one place, not two: `control_bar_slot_click` @0x27417 branches for icons
 * `0x0a`/`0x13` (map) to @0x27f00, which clears the build helper (`vp[0]` bit 6) at @0x27f08 and
 * tests the special click (`vp[1]` bit 3) at @0x27f1c - only then `vp[0xd8] = 0x10` (@0x27f28),
 * otherwise the branch opens the map. The original consumes the mask in the frame; we evaluate it
 * immediately (the same deliberate deviation already documented for the road build edge scroll).
 *
 * @returns tile for the camera, or `null` if the player has no castle any more.
 */
export function gotoOwnCastle(
  player: { build: number; castleBuilding: number; cursorCol: number; cursorRow: number },
  buildings: readonly ({ readonly col: number; readonly row: number } | null | undefined)[],
  geo: MapGeometry,
): { col: number; row: number } | null {
  if ((player.build & 0x08) === 0) return null; // @0x56ec `bt $0x3` on `player[3]`
  const castle = buildings[player.castleBuilding]; // @0x56ff `player[0x104]`
  if (castle === null || castle === undefined) return null;
  const col = castle.col & (geo.cols - 1); // @0x5740 masks of the original
  const row = castle.row & (geo.rows - 1);
  player.cursorCol = col; // @0x5783 - the cursor moves along, see above
  player.cursorRow = row; // @0x5794
  return { col, row };
}
