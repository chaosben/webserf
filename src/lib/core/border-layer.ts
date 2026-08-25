/**
 * Border layer of the map window — the boundary stones between two territories, backend free.
 *
 * In the original this is **not a pass of its own** but the `else` branch of the road pass: the driver
 * @0xe1ce walks the half rows and tests the path bit per tile and direction —
 * `if (paths & bit) -> draw road segment else -> test for a border`. Road and border therefore
 * **exclude** each other on an edge: where a road lies it covers the border.
 *
 * The border condition is a raw byte comparison: `(landscapeA[1] ^ landscapeB[1]) & 0xe0 != 0` — the
 * owner bits (5..7) of the two edge tiles differ. On the decoded model that is
 * `tileA.owner !== tileB.owner`, justified by the invariant "bit 7 == 0 => bits 5/6 == 0". **The edge
 * between own land and no man's land is a border too** — bit 7 enters the XOR.
 *
 * The three drawing routines (`FUN_0000e94e` Right, `FUN_0000ea32` DownRight, `FUN_0000eaed` Down) are
 * identical apart from anchor and helper neighbours and pick exactly **10 sprites** from the bank
 * `MapBorder` (DOS index 610 = our 609) — the same structure as `PathGround`: 3 slope variants x
 * {grass, desert/tundra, snow} + 1 water.
 *
 * **The thresholds are NOT those of the road pass** (read at the byte, @0xe94e/@0xea32/@0xeaed against
 * @0xe5cd/@0xe6ca/@0xe791): the border groups tundra differently (`>10` instead of `>7`, `>=15`
 * instead of `>=14`) and switches the slope variant at `>=2 / >=-8` instead of `>=5 / >=-5`. A "same
 * as the road" port would pick the wrong texture on every tundra and most slope segments.
 */

import type { Blitter, DrawImage } from './draw-target.js';
import { posOf, type MapGeometry } from './engine/position.js';
import { ROAD_DIRS } from './road-render.js';
import { tileAnchor, type WindowFrame } from './window-frame.js';

/** Border sprite bank (0-based archive index; DOS index 610 = `MapBorder`). */
export const MAP_BORDER_BASE = 609;

/** Neighbour delta per "forward" direction: 0=Right, 1=DownRight, 2=Down. */
const DIR_DELTA: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * Slope variant (0..2) of the border sprite from the secondary cross fall `hDiff2`. Read at the byte:
 * `if (hDiff2 - 2 < 0) { if (hDiff2 + 8 < 0) 2 else 1 } else 0`.
 */
export function borderSlopeVariant(hDiff2: number): number {
  if (hDiff2 >= 2) return 0;
  if (hDiff2 >= -8) return 1;
  return 2;
}

/**
 * Sprite index (0..9) in the border bank. Read at the byte: water (`type < 4`) -> 9; otherwise
 * `slopeVariant` + {grass 0, desert/tundra +3 (`type > 10`), snow +6 (`type >= 15`)}.
 */
export function borderGroundIndex(type: number, slopeVariant: number): number {
  if (type < 4) return 9; // water
  if (type >= 15) return slopeVariant + 6; // snow
  if (type > 10) return slopeVariant + 3; // desert/tundra
  return slopeVariant;
}

/** What the border layer needs from a tile. */
export interface BorderTileData {
  readonly height: number;
  readonly terrainUp: number;
  readonly terrainDown: number;
  /** Path bits per direction 0..5 (only `& 0x3f` matters). */
  readonly paths: number;
  /** Owner, 1-based (0 = nobody) — as in `MapTile.owner`. */
  readonly owner: number;
}

export interface BorderLayerInput<Img extends DrawImage> {
  readonly tiles: readonly BorderTileData[];
  readonly geo: MapGeometry;
  readonly heightUnit: number;
  /** Yields the border sprite for bank index 0..9 (backend business, cached). `null` => skip. */
  readonly sprite: (borderIndex: number) => Img | null;
}

/**
 * Draws the boundary stones of the visible window. Like the road layer it iterates every tile of the
 * frame and its three "forward" directions, so every edge is handled **exactly once**; the opposite
 * direction comes with the neighbouring tile.
 *
 * **Anchor.** Road and border of a direction are called from **the same** loop with the same
 * `vreg0`/`vreg1` and subtract the same `0x26` from y at the end, so the difference is directly
 * readable: the border sets `x += 15` (Right) resp. `x += 7` (DownRight/Down) and
 * `y = vreg0 - 2*(h1+h2) + C` with `C = -4` (Right) resp. `+6`, where the road takes
 * `y = vreg0 - 4*hy - 2`.
 *
 * The **half-tile offset at Down** does not sit in the drawing routine of the original but in the x
 * start value of the respective sub-loop (`vreg1 += 0x10` between the passes, @0xe22e/@0xe2a0). Our
 * frame has only **one** anchor per tile, which is why the road pass carries it as `-TILE_W/2`; the
 * border must carry it likewise: `x = a.x - 16 + 7 = a.x - 9`. Without that, Down and DownRight
 * boundary stones would lie **pixel-identically on top of each other**.
 *
 * **Cross fall and governing terrain** are the same expressions per direction as in the road pass —
 * the binary uses the same descriptor offsets there. Only the **thresholds** differ (see above).
 */
export function drawBorderLayer<Img extends DrawImage>(
  target: Blitter<Img>,
  frame: WindowFrame,
  input: BorderLayerInput<Img>,
): void {
  const { tiles, geo, heightUnit } = input;
  const at = (c: number, r: number): BorderTileData => tiles[posOf(c, r, geo)]!;
  const h = (c: number, r: number): number => at(c, r).height;

  for (let i = 0; i < frame.halfRows.length; i++) {
    const hr = frame.halfRows[i]!;
    for (let k = 0; k < hr.tiles.length; k++) {
      const pos = hr.tiles[k]!;
      const t = tiles[pos]!;
      const paths = t.paths & 0x3f;
      const col = pos % geo.cols;
      const row = (pos - col) / geo.cols;
      const h1 = t.height;
      let anchor: { x: number; y: number } | null = null;

      for (const dir of ROAD_DIRS) {
        if ((paths & (1 << dir)) !== 0) continue; // a road lies there -> the road pass draws it
        const nc = col + DIR_DELTA[dir]![0];
        const nr = row + DIR_DELTA[dir]![1];
        const nt = at(nc, nr);
        if (t.owner === nt.owner) continue; // same owner bits -> no border
        const h2 = nt.height;

        // Secondary cross fall + governing terrain — per direction as in the binary.
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

        const image = input.sprite(borderGroundIndex(type, borderSlopeVariant(hDiff2)));
        if (image === null) continue;
        anchor ??= tileAnchor(frame, i, k);
        const x = anchor.x + (dir === 0 ? 15 : dir === 1 ? 7 : -9);
        const y = anchor.y - ((h1 + h2) * heightUnit) / 2 + (dir === 0 ? -4 : 6);
        target.blit(image, Math.round(x), Math.round(y));
      }
    }
  }
}
