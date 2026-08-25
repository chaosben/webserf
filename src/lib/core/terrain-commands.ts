/**
 * Ground drawing of the window as a **command list** (backend independent).
 *
 * The original builds a list of drawing commands per half row and works through it; the land commands
 * are **retained**, i.e. kept across frames and only extended while scrolling. This module produces
 * exactly that list: pure data, no canvas, no WebGL. A backend executes it — swapping the backend is
 * therefore an exchange of the executor, not a rewrite of the drawing logic.
 *
 * ## Position computation — the original's bookkeeping, not `col*32 - row*16`
 *
 * The original computes the screen position **not** from the tile coordinate but from two running
 * counters: `vreg6` counts rightwards in 8 px units inside the half row, `vreg4` counts the half rows
 * downwards. That is why it knows no row-dependent x offset — the shear sits in the tile traversal
 * (`map-viewport.ts`).
 *
 * For the port that is **doubly** valuable:
 * 1. **It is the faithful structure.**
 * 2. **It solves the torus wrap for free.** From a wrapped tile coordinate no scene position could be
 *    derived — behind the seam it would jump half a map. The running counter simply carries on.
 *
 * Both ways agree: for half row `i` (start `col0+floor(i/2)`, `row0+i`) and tile `k` the scene
 * relative position is `(floor(i/2) + k)*32 - i*16`, i.e. `k*32` for even `i` and `k*32 - 16` for odd
 * — exactly the alternating x starts 0 / -16 px of the original bookkeeping.
 *
 * ## Window origin
 *
 * All command coordinates are **window relative**: the origin is the scene position of the start tile
 * (`scroll.col`/`scroll.row` after the fine-scroll correction), so command `(0,0)` belongs to the
 * top-left tile. The backend only adds the fine-scroll pixel remainder.
 */

import { Direction, colOf, neighbor, rowOf, type MapGeometry } from './engine/position.js';
import { HEIGHT_UNIT, TILE_H, TILE_W } from './map-render.js';
import type { HalfRow } from './map-viewport.js';
import { downMaskIndex, groundSpriteForTriangle, upMaskIndex } from './terrain-mask.js';

/**
 * One ground triangle as a drawing command. `maskIndex` + `groundSprite` key the pre-composed image
 * (`terrain-tiles.ts`), `x`/`y` are window-relative pixels **without** the mask's pivot — the backend
 * adds that from the cache entry.
 */
export interface TerrainCommand {
  readonly kind: 'up' | 'down';
  readonly x: number;
  readonly y: number;
  /**
   * Tile COLUMN of the source tile (0..cols-1, i.e. already wrapped).
   *
   * It stands here so a consumer can bound a change **spatially** without rebuilding the traversal:
   * from `x` alone the column is not recoverable (the shear moves x by -16 per half row, and across
   * the seam the same column occurs **twice** in one half row). The consumer is the row refresh of the
   * world surface (`views/terrain-surface.ts`).
   */
  readonly col: number;
  /** Slope mask 0..80 (from `upMaskIndex`/`downMaskIndex`). */
  readonly maskIndex: number;
  /** Archive index of the ground texture. */
  readonly groundSprite: number;
}

/** What the ground build needs from a tile. */
export interface TerrainTileData {
  readonly height: number;
  readonly terrainUp: number;
  readonly terrainDown: number;
}

/**
 * Builds the ground commands for the half rows of the window.
 *
 * Per tile **both** triangles arise (up *and* down) — `HalfRow.kind` does not select the triangle kind
 * but only the tile count and the x start (see the warning on {@link HalfRow}). Corner heights and
 * terrain type are taken source-tile-centred as in `map-render.terrainTriangle`:
 *
 * | kind | apex `m` | `left` | `right` | type | x | y |
 * |---|---|---|---|---|---|---|
 * | `up` | tile | tile-down | tile-down-right | `terrainUp` | `sx - 16` | `i*20 - 4m` |
 * | `down` | tile-down-right | tile | tile-right | `terrainDown` | `sx` | `i*20 - 4m + 20` |
 *
 * Triangles with an impossible slope (height difference outside `[-4,4]`) or without a ground sprite
 * are skipped — as in the verified reference traversal.
 *
 * `heightUnit` allows the flat mode (0); in relief the original value applies.
 *
 * ## The ORDER is semantics, not taste
 *
 * The masks of the ground triangles **overlap** at their edges (they are dithered there), so the
 * drawing order decides which texture a border pixel gets. The original draws **column by column**:
 * the half-row driver `@0xdbc4` runs one column of constant screen x downwards (`vreg0 += 0x14` per
 * triangle, alternating `call draw_ground_triangle_up` @0xde83 and `call draw_ground_triangle_down`
 * @0xdfea) and the outer loop advances to the **right**.
 *
 * Hence the output is ordered by **ascending x**, although the half rows are traversed row by row:
 * for a fixed x at most one triangle can occur per half row (up sits at `sx - 16`, down at `sx`, and
 * `sx` jumps by 32), so the entries of one column arise in ascending half-row order anyway — bundling
 * by x yields exactly the column pass.
 *
 * **Measured at the pixel**, conditioned on "some covering triangle explains the capture at all": the
 * rule "largest x wins" explains **99.87 / 99.87 / 99.88 %** of the overlap pixels in three
 * independent captures, the earlier row order only 94.9 / 94.0 / 92.2 % — and the counter rules land
 * at 69-75 % resp. 12-43 %.
 */
export function buildTerrainCommands(
  halfRows: readonly HalfRow[],
  geo: MapGeometry,
  tiles: readonly TerrainTileData[],
  heightUnit: number = HEIGHT_UNIT,
): TerrainCommand[] {
  /** One list per screen column (x), filled in half-row order (see the module comment). */
  const columns = new Map<number, TerrainCommand[]>();
  const h = (pos: number): number => tiles[pos]!.height;

  for (let i = 0; i < halfRows.length; i++) {
    const row = halfRows[i]!;
    const rowY = i * TILE_H; // running half-row counter (original: `vreg4`)

    for (let k = 0; k < row.tiles.length; k++) {
      const pos = row.tiles[k]!;
      const sx = row.xOffset + k * TILE_W; // running x counter (original: `vreg6`)
      const down = neighbor(pos, Direction.Down, geo);
      const downRight = neighbor(pos, Direction.DownRight, geo);
      const right = neighbor(pos, Direction.Right, geo);

      const col = pos % geo.cols;

      // Up triangle: apex on the tile, base on the row below.
      pushTriangle(
        columns,
        col,
        'up',
        h(pos),
        h(down),
        h(downRight),
        tiles[pos]!.terrainUp,
        sx - TILE_W / 2,
        rowY,
        heightUnit,
      );

      // Down triangle: apex at the bottom right, base on the tile's row.
      pushTriangle(
        columns,
        col,
        'down',
        h(downRight),
        h(pos),
        h(right),
        tiles[pos]!.terrainDown,
        sx,
        rowY + TILE_H,
        heightUnit,
      );
    }
  }

  // Emit the columns from left to right — the original's order.
  const out: TerrainCommand[] = [];
  for (const x of [...columns.keys()].sort((a, b) => a - b)) out.push(...columns.get(x)!);
  return out;
}

/** Checks slope and ground sprite and appends a command if valid (column bucket keyed by x). */
function pushTriangle(
  columns: Map<number, TerrainCommand[]>,
  col: number,
  kind: 'up' | 'down',
  m: number,
  left: number,
  right: number,
  terrain: number,
  x: number,
  baseY: number,
  heightUnit: number,
): void {
  // Flat mode: slope 0 -> flat mask/variant, clean top-down tiling.
  const flat = heightUnit === 0;
  const sm = flat ? 0 : m;
  const sl = flat ? 0 : left;
  const sr = flat ? 0 : right;
  if (sl - sm < -4 || sl - sm > 4 || sr - sm < -4 || sr - sm > 4) return;
  const groundSprite = groundSpriteForTriangle(kind, terrain, sm, sl, sr);
  if (groundSprite === null) return;
  let bucket = columns.get(x);
  if (bucket === undefined) {
    bucket = [];
    columns.set(x, bucket);
  }
  bucket.push({
    kind,
    col,
    x,
    y: baseY - sm * heightUnit,
    maskIndex: kind === 'up' ? upMaskIndex(sm, sl, sr) : downMaskIndex(sm, sl, sr),
    groundSprite,
  });
}

/**
 * Scene position of the window origin — the scene coordinate of the start tile. Only needed when
 * window coordinates have to be brought together with the (unwrapped) scene coordinates of the
 * whole-map passes; the plain window renderer does not need it.
 */
export function windowOrigin(
  startPos: number,
  geo: MapGeometry,
): { x: number; y: number } {
  return {
    x: colOf(startPos, geo) * TILE_W - rowOf(startPos, geo) * (TILE_W / 2),
    y: rowOf(startPos, geo) * TILE_H,
  };
}
