/**
 * The pigs of the pig farm - port of `draw_pig_farm`. A module of its own because it is a routine of
 * its own in the original: the type dispatcher of the map object pass jumps here for type 14, and the
 * routine enqueues the sound (in `sound-emit.ts`), blits building and shadow, and then blits up to
 * eight pigs individually. Only the last part lives here.
 *
 * Every pig has a fixed place relative to the building anchor, a fixed minimum count from which it
 * appears, and a fixed phase offset into the shared animation table, so the animals do not move in
 * lockstep. The order below is the original's and at the same time the drawing order: `dy` grows
 * monotonically, i.e. back to front. The first place has no comparison at all and hangs on the outer
 * "count is non-zero" alone.
 *
 * The animation table is 128 pairs `(sprite, x offset)`, addressed with `((gameTick >> 3) + offset) &
 * 0xfe` - the offset is added BEFORE masking (several of the values run past the table and wrap), and
 * the mask forces an even byte offset, i.e. a whole pair. The second byte is added to x and is unsigned,
 * so a pig only ever wobbles to the right.
 *
 * The anchor is the same point as the building's: the marker blit and the object blit add the same
 * constants, and the only difference is a shift on x that the caller here has already done. So the
 * offsets below are relative to the building anchor unchanged.
 */

import { CURSOR_MARKER_BASE } from './ui-render.js';
import type { BuildingRecord } from './types.js';

/** Building type of the pig farm (slot 14 of the dispatch table @0x34ed5). */
export const PIG_FARM_TYPE = 14;

/**
 * `building[9]` — for the pig farm the **number of pigs**, not a stock nibble pair. Elsewhere the
 * record carries bytes 8/9 as `(available << 4) | requested`; here it is a plain number.
 *
 * Backed by data: across 33 finished pig farms of real saves the **high nibble is always 0** (observed
 * values 1, 4, 5) — the number fits into the low nibble, as the eight places (max. 8) require.
 */
export function pigFarmCount(b: BuildingRecord): number {
  return ((b.stock[1]!.available << 4) | b.stock[1]!.requested) & 0xff;
}

/** A placed pig: archive index and offset relative to the building anchor. */
export interface PlacedPig {
  readonly idx: number;
  readonly dx: number;
  readonly dy: number;
}

/** One place: minimum count, phase offset into the table, fixed offset from the anchor. */
interface PigSlot {
  readonly min: number;
  readonly phase: number;
  readonly dx: number;
  readonly dy: number;
}

// prettier-ignore
/** The eight places in original order (== drawing order, `dy` ascending). */
const PIG_SLOTS: readonly PigSlot[] = [
  { min: 6, phase: 0x8c,  dx:  -2, dy:  6 }, // @0x35918 · @0x35978 · @0x3597c
  { min: 5, phase: 0x118, dx:   8, dy:  8 }, // @0x3599c · @0x359fc · @0x35a00
  { min: 3, phase: 0x1a4, dx: -11, dy:  8 }, // @0x35a20 · @0x35a80 · @0x35a84
  { min: 1, phase: 0x28,  dx:   2, dy: 11 }, // no cmpb — hangs on the outer `!= 0`
  { min: 7, phase: 0xb4,  dx:  -8, dy: 13 }, // @0x35b1e · @0x35b7e · @0x35b82
  { min: 8, phase: 0x140, dx:  13, dy: 14 }, // @0x35ba2 · @0x35c02 · @0x35c06
  { min: 2, phase: 0x1cc, dx:   0, dy: 17 }, // @0x35c26 · (no x term) · @0x35c86
  { min: 4, phase: 0x5a,  dx: -11, dy: 19 }, // @0x35ca6 · @0x35d05 · @0x35d09
];

// prettier-ignore
/**
 * `@0x35d50`, byte for byte: 128 pairs `(sprite, x offset)`. Sprites 0xa2..0xad, offsets 0..4. The
 * line comment names the **pair** index (byte offset = twice that).
 */
const PIG_ANIM: readonly number[] = [
  0xa2, 0, 0xa2, 0, 0xa2, 0, 0xa2, 0, 0xa2, 0, 0xa3, 0, 0xa2, 1, 0xa3, 1, //   0..7
  0xa2, 2, 0xa3, 2, 0xa2, 3, 0xa3, 3, 0xa2, 4, 0xa3, 4, 0xa6, 4, 0xa6, 4, //   8..15
  0xa6, 4, 0xa6, 4, 0xa4, 4, 0xa5, 4, 0xa4, 3, 0xa5, 3, 0xa4, 2, 0xa5, 2, //  16..23
  0xa4, 1, 0xa5, 1, 0xa4, 0, 0xa5, 0, 0xa2, 0, 0xa2, 0, 0xa6, 0, 0xa6, 0, //  24..31
  0xa6, 0, 0xa2, 0, 0xa7, 0, 0xa8, 0, 0xa7, 0, 0xa8, 0, 0xa7, 0, 0xa8, 0, //  32..39
  0xa7, 0, 0xa8, 0, 0xa7, 0, 0xa8, 0, 0xa7, 0, 0xa8, 0, 0xa7, 0, 0xa8, 0, //  40..47
  0xa7, 0, 0xa8, 0, 0xa7, 0, 0xa2, 0, 0xa2, 0, 0xa2, 0, 0xa2, 0, 0xa6, 0, //  48..55
  0xa6, 0, 0xa6, 0, 0xa6, 0, 0xa6, 0, 0xa6, 0, 0xa2, 0, 0xa2, 0, 0xa7, 0, //  56..63
  0xa8, 0, 0xa9, 0, 0xaa, 0, 0xab, 0, 0xac, 0, 0xad, 0, 0xac, 0, 0xad, 0, //  64..71
  0xac, 0, 0xad, 0, 0xac, 0, 0xad, 0, 0xac, 0, 0xad, 0, 0xac, 0, 0xad, 0, //  72..79
  0xac, 0, 0xad, 0, 0xac, 0, 0xab, 0, 0xaa, 0, 0xa9, 0, 0xa8, 0, 0xa7, 0, //  80..87
  0xa2, 0, 0xa2, 0, 0xa2, 0, 0xa2, 0, 0xa3, 0, 0xa2, 1, 0xa3, 1, 0xa2, 1, //  88..95
  0xa3, 2, 0xa2, 2, 0xa3, 2, 0xa7, 2, 0xa8, 2, 0xa7, 2, 0xa8, 2, 0xa7, 2, //  96..103
  0xa8, 2, 0xa7, 2, 0xa8, 2, 0xa7, 2, 0xa8, 2, 0xa7, 2, 0xa8, 2, 0xa7, 2, // 104..111
  0xa8, 2, 0xa7, 2, 0xa2, 2, 0xa2, 2, 0xa6, 2, 0xa6, 2, 0xa6, 2, 0xa6, 2, // 112..119
  0xa4, 2, 0xa5, 2, 0xa4, 1, 0xa5, 1, 0xa4, 0, 0xa5, 0, 0xa2, 0, 0xa2, 0, // 120..127
];

/** Size of the table in bytes (the mask `0xfe` addresses exactly this space). */
export const PIG_ANIM_BYTES = PIG_ANIM.length;

/**
 * The visible pigs of a **finished** pig farm, in drawing order.
 *
 * `count` is `building[9]` (see {@link pigFarmCount}), `tick` the game tick. Empty at `count == 0` —
 * in the original that is the second branch of the routine, which draws only the building.
 */
export function pigFarmPigs(count: number, tick: number): PlacedPig[] {
  if (count === 0) return [];
  const out: PlacedPig[] = [];
  for (const slot of PIG_SLOTS) {
    if (count < slot.min) continue;
    const at = (((tick & 0xffff) >> 3) + slot.phase) & 0xfe;
    out.push({
      idx: CURSOR_MARKER_BASE + PIG_ANIM[at]!,
      dx: slot.dx + PIG_ANIM[at + 1]!,
      dy: slot.dy,
    });
  }
  return out;
}
