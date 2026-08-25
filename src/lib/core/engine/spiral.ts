/**
 * The map's hexagonal spiral pattern, generated the way `FUN_000040bd` (@0x40bd) does: per base
 * vector six hex rotations, `pattern[1 + 6*i + j] = rot(base[i], matrix[j])`, with `pattern[0]` the
 * centre. Base vectors and rotation matrices are lifted from the executable
 * (`DAT_00004223` / `DAT_000041f3`).
 *
 * The original also keeps the same positions as packed offsets (`field_0xc4`); we do not need them —
 * {@link spiralPos} derives the neighbour by axis torus wrap, which is what the original's offset
 * masking amounts to.
 *
 * **There are 49 base vectors, not 48.** Both loops are `do { ... } while (pre-- != 0)` and therefore
 * run one round more than their start value (`0x30` -> 49 outer, `5` -> 6 inner). Three independent
 * confirmations: the table ends after `2 + 49*12 = 590` bytes exactly where `FUN_00004471` begins;
 * the allocator reserves `0x49c` = 1180 bytes = `295*4` = `49*6+1` entries; and the 49th vector
 * `[24,16]` is in the dump. The threat-level probes reach index **294** — with 48 vectors the last
 * ring would have been undefined.
 */

import { posOf, colOf, rowOf, type MapGeometry } from './position.js';

/** 49 Basis-Vektoren `(dcol, drow)` — extrahiert aus `DAT_00004223` (jeder 12-Byte-Slot). */
const BASE_VECTORS: readonly (readonly [number, number])[] = [
  [1, 0], [2, 1], [2, 0], [3, 1], [3, 2], [3, 0], [4, 2], [4, 1], [4, 3], [4, 0],
  [5, 2], [5, 3], [5, 1], [5, 4], [5, 0], [6, 3], [6, 2], [6, 4], [6, 1], [6, 5],
  [6, 0], [7, 3], [7, 4], [7, 2], [7, 5], [7, 1], [7, 6], [7, 0], [8, 4], [8, 3],
  [8, 5], [8, 2], [8, 6], [8, 1], [8, 7], [8, 0], [9, 4], [9, 5], [9, 3], [9, 6],
  [9, 2], [9, 7], [9, 1], [9, 0], [16, 0], [16, 8], [24, 0], [24, 8], [24, 16],
];

/** 2×2-Rotationsmatrizen `[m0,m1,m2,m3]` je Hex-Richtung — extrahiert aus `DAT_000041f3`. */
const ROT_MATRIX: readonly (readonly [number, number, number, number])[] = [
  [1, 0, 0, 1],
  [1, 1, -1, 0],
  [0, 1, -1, -1],
  [-1, 0, 0, -1],
  [-1, -1, 1, 0],
  [0, -1, 1, 1],
];

/**
 * The full spiral pattern: index 0 is the centre, then ring by ring outwards, six positions per base
 * vector — 295 entries (`49*6 + 1`).
 */
export const SPIRAL_PATTERN: readonly (readonly [number, number])[] = (() => {
  const pat: [number, number][] = [[0, 0]];
  for (const [c, r] of BASE_VECTORS) {
    for (const [m0, m1, m2, m3] of ROT_MATRIX) {
      pat.push([c * m0 + r * m2, c * m1 + r * m3]);
    }
  }
  return pat;
})();

/**
 * Map position of the `index`-th spiral position relative to `pos`, with torus wrap — the original's
 * `(pos + field_0xc4[index]) & posMask`.
 */
export function spiralPos(pos: number, index: number, geo: MapGeometry): number {
  const [dc, dr] = SPIRAL_PATTERN[index];
  return posOf(colOf(pos, geo) + dc, rowOf(pos, geo) + dr, geo);
}
