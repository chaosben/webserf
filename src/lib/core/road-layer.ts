/**
 * **Road layer of the map window** — masked sprite blitting, backend free.
 *
 * Per road segment the road ground texture (`PathGround`, solid) is cut by the road mask
 * (`PathMask`, 1-bit) matching the segment slope and blitted at the segment anchor. Which mask and
 * which ground variant apply is computed by `road-render.ts`; composing the two sprites into one
 * image is the backend's job and arrives here as {@link RoadLayerInput.tile}.
 *
 * From the tile's `paths` bits every segment is drawn **exactly once**: only the three "forward"
 * directions Right/DownRight/Down ({@link ROAD_DIRS}) iterate — the counter directions come with the
 * neighbouring tile.
 *
 * Positions come from the traversal (`window-frame.tileAnchor`), not from `col/row` — that is what
 * makes roads run **through the map seams** and repeat with the ground when zooming out.
 *
 * ## Ground texture: cross slope and governing terrain
 *
 * The original's three drawing routines (`FUN_0000e5cd` Right, `FUN_0000e6ca` DownRight,
 * `FUN_0000e791` Down) read their helper neighbours through fixed offsets into the half-row
 * descriptor. Their meaning is resolved against `compute_map_window_tiles` @0xd93a and is
 * **independent of the row parity** — the +-2 bytes in the record layout compensate exactly for the
 * half-column shear:
 *
 * | Offset | `+4` | `-4` | `+0x52` | `+0x56` | `-0x52` |
 * |---|---|---|---|---|---|
 * | Tile | Right | Left | **Down** | **DownRight** | **Up** |
 *
 * From that, per direction (A = tile, B = segment target):
 *
 * | dir | cross slope `hDiff2` | governing terrain |
 * |---|---|---|
 * | 0 Right | `Up.h - DownRight.h - 3*(h1-h2)` | `max(A.terrainDown, Up.terrainUp)` |
 * | 1 DownRight | `2*(Right.h - Down.h)` | `max(A.terrainUp, A.terrainDown)` |
 * | 2 Down | `3*(h1-h2) - Left.h + DownRight.h` | `max(Left.terrainDown, A.terrainUp)` |
 *
 * The factor is **3**, not 4 (`vreg4+vreg4+vreg4` @0xe5cd/@0xe791); direction 2 takes **DownRight**
 * as its second term, not Down; and the terrain type is the direction-specific pair above, not a
 * fourfold max over both tiles. All of this selects the ground texture variant only, never the
 * position of a segment.
 */

import type { Blitter, DrawImage } from './draw-target.js';
import { posOf, type MapGeometry } from './engine/position.js';
import { TILE_W } from './map-render.js';
import {
  PATH_GROUND_BASE,
  PATH_MASK_BASE,
  ROAD_DIRS,
  pathGroundIndex,
  pathMaskIndex,
  slopeVariant,
} from './road-render.js';
import { tileAnchor, type WindowFrame } from './window-frame.js';

/** What the road layer needs from a tile. */
export interface RoadTileData {
  readonly height: number;
  readonly terrainUp: number;
  readonly terrainDown: number;
  /** Road bits per direction 0..5 (only `& 0x3f` matters). */
  readonly paths: number;
}

export interface RoadLayerInput<Img extends DrawImage> {
  readonly tiles: readonly RoadTileData[];
  readonly geo: MapGeometry;
  readonly heightUnit: number;
  /**
   * The image composed from mask and ground texture (backend business, cached). `null` => skip the
   * segment.
   */
  readonly tile: (maskIndex: number, groundIndex: number) => Img | null;
}

/** Neighbour delta per "forward" direction: 0=Right, 1=DownRight, 2=Down. */
const DIR_DELTA: readonly [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
];

export function drawRoadLayer<Img extends DrawImage>(
  target: Blitter<Img>,
  frame: WindowFrame,
  input: RoadLayerInput<Img>,
): void {
  const { tiles, geo, heightUnit } = input;
  const at = (c: number, r: number): RoadTileData => tiles[posOf(c, r, geo)]!;
  const h = (c: number, r: number): number => at(c, r).height;

  for (let i = 0; i < frame.halfRows.length; i++) {
    const hr = frame.halfRows[i]!;
    for (let k = 0; k < hr.tiles.length; k++) {
      const pos = hr.tiles[k]!;
      const t = tiles[pos]!;
      const paths = t.paths & 0x3f;
      if (paths === 0) continue;
      const col = pos % geo.cols;
      const row = (pos - col) / geo.cols;
      const h1 = t.height;
      const a = tileAnchor(frame, i, k); // flat anchor; the lift comes per segment

      for (const dir of ROAD_DIRS) {
        if ((paths & (1 << dir)) === 0) continue;
        const nc = col + DIR_DELTA[dir]![0];
        const nr = row + DIR_DELTA[dir]![1];
        const nt = tiles[posOf(nc, nr, geo)]!;
        const h2 = nt.height;
        // Secondary cross slope + governing terrain — per direction as in the binary (see module head).
        let hDiff2: number;
        let type: number;
        if (dir === 0) {
          hDiff2 = h(col, row - 1) - h(col + 1, row + 1) - 3 * (h1 - h2);
          type = Math.max(t.terrainDown, at(col, row - 1).terrainUp);
        } else if (dir === 1) {
          hDiff2 = 2 * (h(col + 1, row) - h(col, row + 1));
          type = Math.max(t.terrainUp, t.terrainDown);
        } else {
          hDiff2 = 3 * (h1 - h2) - h(col - 1, row) + h(col + 1, row + 1);
          type = Math.max(at(col - 1, row).terrainDown, t.terrainUp);
        }
        const image = input.tile(
          PATH_MASK_BASE + pathMaskIndex(dir, h1, h2),
          PATH_GROUND_BASE + pathGroundIndex(type, slopeVariant(hDiff2)),
        );
        if (image === null) continue;
        // x independent of height, y from the governing segment height minus 2.
        const hy = dir === 0 ? Math.max(h1, h2) : h1;
        const x = a.x + (dir === 2 ? -TILE_W / 2 : 0);
        const y = a.y - hy * heightUnit - 2;
        target.blit(image, Math.round(x), Math.round(y));
      }
    }
  }
}
