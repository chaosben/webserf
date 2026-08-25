/**
 * The geologist's soil analysis — port of `FUN_0003f42c` @0x3f42c (the spiral) and `FUN_0003f693`
 * @0x3f693 (evaluating one tile).
 *
 * The original runs it **when the soil sample popup opens** (screen 0x16) and stores four weighted
 * sums in the player record: `player+0x138/0x13a/0x13c/0x13e` = **gold / iron / coal / granite**.
 * The manual describes exactly this: how much of each resource lies in the currently shown section
 * of the map and its immediate surroundings.
 *
 * **Algorithm.** Starting from the cursor a hex spiral runs over {@link SOIL_ANALYSIS_RINGS} rings:
 * one step Right per ring, then six sides (Down, Left, UpLeft, Up, Right, DownRight) of `ring+1`
 * tiles each — 1800 tiles in total. The **ring weight** is `24 - ring`, so the innermost ring counts
 * 24-fold and the outermost once. Per tile `amount * weight` is added to the sum of its mineral
 * (16-bit addition saturating at `0xffff`). Finally each sum is shifted right by
 * {@link SOIL_ANALYSIS_SHIFT} and capped at {@link SOIL_ANALYSIS_MAX}.
 *
 * **Why plain `(col, row)` arithmetic is equivalent.** The original walks **byte offsets** into the
 * landscape arena and masks with `gs+0x0` after every step. That mask is
 * `((cols-1)<<2) | ((rows-1)<<(log2(cols)+3))`: column and row bits sit in **disjoint** bit fields,
 * and the separating bit between them (landscape vs. resource half of a row) is masked away. A
 * masked step therefore wraps each axis on its own, which is exactly `posOf(col+dc, row+dr)`.
 */

import type { GameState, Player } from './state.js';
import { neighbor, posOf, Direction } from './position.js';

/** Number of spiral rings around the cursor (`mov $0x18,%eax` @0x3f4c3). */
export const SOIL_ANALYSIS_RINGS = 24;

/** Saturation value of the 16-bit sum (`mov $0xffff,%ax` @0x3f716). */
export const SOIL_ANALYSIS_SATURATION = 0xffff;

/** Right shift of the raw sum before display (`shrw $0x4`, four blocks from @0x3f5e2). */
export const SOIL_ANALYSIS_SHIFT = 4;

/** Comparison limit of the cap (`cmpw $0x3e8` @0x3f5f0). */
export const SOIL_ANALYSIS_LIMIT = 1000;

/** Value stored when the limit is exceeded (`mov $0x3e7,%ax` @0x3f5f7). */
export const SOIL_ANALYSIS_MAX = 999;

/**
 * The six sides of a spiral ring in original order, from the `gs` neighbour deltas of the loop:
 * `gs+0xc` (Down), `gs+0x60` (Left), `gs+0x14` (UpLeft), `gs+0x18` (Up), constant `+4` (Right),
 * `gs+0x8` (DownRight).
 */
export const SOIL_ANALYSIS_RING_SIDES: readonly Direction[] = [
  Direction.Down,
  Direction.Left,
  Direction.UpLeft,
  Direction.Up,
  Direction.Right,
  Direction.DownRight,
];

/**
 * Object values that keep a tile **out** of the analysis (`cmpw $0x8; jb return` after `andw $0x7f`
 * on the object byte): the original skips every object `1..7`. Of those, 1 = flag and 2..4 =
 * small/large building/castle are known; the meaning of 5..7 is open, so the port takes the raw
 * range without interpreting it.
 */
export const SOIL_ANALYSIS_SKIP_OBJECT_LIMIT = 8;

/**
 * Runs the soil analysis around `(col, row)` and writes the four sums into `player.analysis`
 * (order **gold, iron, coal, granite** = mineral enum 1..4 minus one), returning the same values.
 */
export function analyzeSoil(
  state: GameState,
  player: Player,
  col: number,
  row: number,
): [number, number, number, number] {
  const geo = state.geo;
  const sums: [number, number, number, number] = [0, 0, 0, 0];
  let pos = posOf(col, row, geo);
  let weight = SOIL_ANALYSIS_RINGS;

  for (let ring = 0; ring < SOIL_ANALYSIS_RINGS; ring++) {
    // One step outwards; this tile itself is not evaluated yet.
    pos = neighbor(pos, Direction.Right, geo);
    for (const dir of SOIL_ANALYSIS_RING_SIDES) {
      for (let step = 0; step <= ring; step++) {
        sampleTile(state, sums, pos, weight);
        pos = neighbor(pos, dir, geo);
      }
    }
    weight--;
  }

  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const scaled = sums[i] >>> SOIL_ANALYSIS_SHIFT;
    result[i] = scaled >= SOIL_ANALYSIS_LIMIT ? SOIL_ANALYSIS_MAX : scaled;
    player.analysis[i] = result[i];
  }
  return result;
}

/**
 * One tile (`FUN_0003f693`): occupied tiles and tiles without a mineral drop out, otherwise
 * `amount * weight` goes onto the mineral's sum (saturating).
 *
 * The original tests `byte != 0` on the raw resource byte and then `(byte>>5) - 1` with a borrow
 * abort — together exactly "skip mineral type 0", which also excludes the fish tiles that use the
 * same amount slot without a mineral type.
 */
function sampleTile(
  state: GameState,
  sums: [number, number, number, number],
  pos: number,
  weight: number,
): void {
  const tile = state.mapTiles[pos];
  if (tile === undefined) return;
  if (tile.object !== 0 && tile.object < SOIL_ANALYSIS_SKIP_OBJECT_LIMIT) return;
  if (tile.mineral === 0) return;
  const slot = tile.mineral - 1;
  // The original computes the field address unchecked (`0x138 + 2*t`) and would write into
  // neighbouring fields of the player record for a mineral type > 4. Real saves only ever carry
  // `mineral` in 0..4, so this guard is belt and braces, not original behaviour.
  if (slot > 3) return;
  const sum = sums[slot] + tile.resourceAmount * weight;
  sums[slot] = sum > SOIL_ANALYSIS_SATURATION ? SOIL_ANALYSIS_SATURATION : sum;
}
