/**
 * Flames of a burning building. `draw_building` tests the burn bit BEFORE the type dispatcher and
 * branches; that branch enqueues the fire sound (in `sound-emit.ts`), draws the building through the
 * SAME dispatcher as the normal case - so a burning building looks as it always does, it does not
 * shrink - and lays the flames on top, which is what lives here.
 *
 * The animation phase comes from the burn countdown, with an `xor 7` that reverses the direction
 * because the countdown falls, so the flames run forwards. Every further flame of the same building
 * starts three phases later, so they do not all flicker in step.
 *
 * **The countdown is advanced by the drawing pass, once per drawn frame** (@0x34a90/@0x34aa3): the
 * branch stamps `building[0xe] = gameTick` and subtracts the elapsed ticks from `building[0xa]`. The
 * tick driver does the very same delta step and, because both sites stamp, they are idempotent
 * together — for a visible building the drawing pass consumes the delta, for an off-screen one the
 * driver does. The game tick grows by 8 per frame, so `(countdown >> 3) & 7` steps by exactly one per
 * frame: eight flame frames in eight frames.
 *
 * Deliberate deviation, and the reason {@link effectiveBurnCountdown} exists: our renderer must not
 * write game state (it is decoupled from the logic clock and may run more than once per logic frame),
 * so it reproduces that subtraction READ-ONLY at every read instead of storing it. Reading the stored
 * counter alone is wrong even though the counter is delta based: the driver only visits a building once
 * per rotation cycle, so the stored value stands still for seconds while the drawn phase must not.
 *
 * The flame table has one entry per building type, each a relative offset to a list of triples
 * `(size, dx, dy)` terminated by a byte with bit 7 set; `dx`/`dy` are signed and `size` selects between
 * two flame sizes, eight frames each, in the marker bank. The anchor is the same as the building's,
 * because both blit primitives add the same offset.
 *
 * Construction sites index by type, UNLESS the site is still nearly empty - then index 0, the small
 * three-flame set. The mask strips the construction bit afterwards, so a more advanced shell burns like
 * the finished building.
 */

import { CURSOR_MARKER_BASE } from './ui-render.js';

/** First flame sprite in the marker bank (@0x34b6a: `sprite = 0x88 + size + phase`). */
export const FLAME_SPRITE_BASE = 0x88;

/** Progress threshold below which a construction site takes flame set 0 (@0x34b2b). */
export const FLAME_SITE_PROGRESS = 16000;

/** A placed flame: archive index and offset relative to the building anchor. */
export interface PlacedFlame {
  readonly idx: number;
  readonly dx: number;
  readonly dy: number;
}

// prettier-ignore
/**
 * `@0x34c3f` resolved byte for byte: per building type the triples `[size, dx, dy]` in drawing order.
 * Type 7 (iron mine) and type 8 (gold mine) share **the same** offset (147) in the binary — the
 * repetition here is the resolved pointer equality, not a copy mistake.
 */
const FLAME_LAYOUT: readonly (readonly (readonly [number, number, number])[])[] = [
  /*  0 None          @0x34c71 */ [[0,  -8,   2], [8,   0,   4], [0,   8,   2]],
  /*  1 Fisher        @0x34c7b */ [[0,  -8, -10], [0,   4, -12], [8,  -8,   4], [8,   7,   4], [0,  -2,   8]],
  /*  2 Lumberjack    @0x34c8b */ [[0,   3, -13], [0,  -8, -10], [8,   9,   3], [8,  -6,   3]],
  /*  3 Boatbuilder   @0x34c98 */ [[0,  -1, -12], [8,  -8,  11], [8,   7,   5]],
  /*  4 Stonecutter   @0x34ca2 */ [[0,   6, -14], [0,  -9, -11], [8,  -8,   5], [8,   6,   5]],
  /*  5 StoneMine     @0x34caf */ [[8,  -4, -40], [8,  -8, -15], [8,   3, -14], [8,  -9,   4], [8,   6,   5]],
  /*  6 CoalMine      @0x34cbf */ [[8,  -4, -40], [8,  -1, -18], [8,  -8, -15], [8,   6,   2], [8,   0,   8], [8,  -8,   9]],
  /*  7 IronMine      @0x34cd2 */ [[8,  -4, -40], [8,  -2, -19], [8,  -9, -14], [8,  -8,   2], [8,   6,   2], [0,  -4,   8]],
  /*  8 GoldMine      @0x34cd2 */ [[8,  -4, -40], [8,  -2, -19], [8,  -9, -14], [8,  -8,   2], [8,   6,   2], [0,  -4,   8]],
  /*  9 Forester      @0x34ce5 */ [[0,   8, -11], [0,  -6,  -8], [8,  -8,   4], [8,   6,   4]],
  /* 10 Warehouse     @0x34cf2 */ [[0,  -2, -25], [0,   6, -17], [0,  -9, -16], [8, -21,   1], [8,  21,   2], [0,  15,  18], [0, -16,  10], [8,  -8,  15], [8,   5,  15]],
  /* 11 Hut           @0x34d0e */ [[0,   0, -11], [8,  -8,   5], [8,   8,   5]],
  /* 12 Farm          @0x34d18 */ [[8,  22,  -2], [8,   7,  -5], [8,  -3,  -1], [8, -23,   0], [8, -12,   4], [0,  25,   5], [0,  21,  13], [0, -17,   8], [0, -10,  15], [0,  -2,  15]],
  /* 13 Butcher       @0x34d37 */ [[8, -15,   3], [8,  20,   3], [8,   7,   3], [8,  -4,   3]],
  /* 14 PigFarm       @0x34d44 */ [[8,   0,  -2], [8,  22,   1], [8,  15,   5], [8, -20,  -1], [8, -11,   3], [0,  20,  12], [0, -16,   7], [0, -12,  14]],
  /* 15 Mill          @0x34d5d */ [[0,   7, -33], [0,   5, -20], [8,  -2, -24], [8,  -6,   1], [8,   4,   2], [0,  -3,   6]],
  /* 16 Baker         @0x34d70 */ [[0, -15, -16], [0,  -4, -19], [0,   3, -16], [8, -13,   2], [8,  -9,   7], [8,   6,   7], [0,  17,   1]],
  /* 17 Sawmill       @0x34d86 */ [[0,   7, -19], [0,  -1, -14], [0,  16, -13], [0,   5,  -8], [8,  14,   4], [0,  10,   9], [0, -17,   8], [8, -11,  10], [8,  -1,  12]],
  /* 18 SteelSmelter  @0x34da2 */ [[0,   5, -19], [0,  16, -16], [8, -14,   2], [8, -10,   5], [8,  15,   5], [8,   2,   5]],
  /* 19 ToolMaker     @0x34db5 */ [[8,   7, -19], [0, -11, -17], [0,  -4, -11], [0,  12, -10], [8, -20,   0], [8, -15,   7], [8,   1,   7], [8,  15,   7]],
  /* 20 WeaponSmith   @0x34dce */ [[8, -15,   1], [8, -10,   3], [8,  20,   3], [8,   5,   3]],
  /* 21 Tower         @0x34ddb */ [[0,  -6, -30], [0,   7, -14], [8, -11,  -3], [0,  -8,   4], [8,   9,   5], [8,  -4,   5]],
  /* 22 Fortress      @0x34dee */ [[0,  -3, -30], [0, -15, -26], [0,  21, -29], [0, -13, -17], [8,   4, -11], [8,  -2,  -6], [8, -22,   0], [8, -17,   8], [8,  20,   1], [8,  10,   8], [8,   4,  13], [8, -11,  15]],
  /* 23 GoldSmelter   @0x34e13 */ [[0, -15, -20], [0,  10, -22], [0,  -3, -25], [0,  -8, -10], [0,   7, -10], [0, -13,   2], [8,  -8,   5], [8,   6,   5], [0,  16,   6]],
  /* 24 Castle        @0x34e2f */ [[0,  11, -46], [0, -19, -42], [8,   1, -27], [8,  10, -13], [0,  -7, -24], [8, -16,  -6], [0, -23,   4], [8,  -2,   0], [8,  12,  12], [8, -14,  17], [8,  -4,  19], [0,  13,  19]],
];

/** Number of entries in the flame table (building types 0..24). */
export const FLAME_LAYOUT_COUNT = FLAME_LAYOUT.length;

/**
 * The countdown a drawn frame sees: the stored `building[0xa]` minus the ticks elapsed since the last
 * step, i.e. @0x34a98/@0x34aa3 without their two writes. `null` means burnt out — the original clamps
 * the counter to 0 and RETURNS (@0x34ab3), so that frame draws neither flames nor building body; only
 * the tick driver ends the fire, which may be up to one rotation cycle later.
 *
 * `stamp` is `building[0xe]`, and it is stamped with the LIVE game tick. Pass the same clock: in a
 * snapshot that is `header.tick`, which mirrors it. Two names, one clock — mixing them in would look
 * right and be off by however far the save has run.
 *
 * `stamp === null` is the one case the port cannot resolve: for a warehouse or castle the decoded
 * record spends byte 14 on the inventory link, so a burning one loaded straight from a file arrives
 * without its stamp. Falling back to the stored counter costs at most one rotation cycle of animation,
 * because the tick driver stamps it again on its first visit. Measured: 0 of 74 saved states contain a
 * burning inventory building, so this is a fallback, not a path.
 */
export function effectiveBurnCountdown(
  stored: number,
  stamp: number | null,
  tick: number,
): number | null {
  const cd = stored & 0xffff;
  if (stamp === null) return cd;
  const elapsed = (tick - stamp) & 0xffff;
  if (elapsed > cd) return null;
  return cd - elapsed;
}

/**
 * The flames of a burning building, in drawing order (above the building body).
 *
 * `burnCountdown` is the value a drawn frame sees, i.e. the result of
 * {@link effectiveBurnCountdown} — not the stored `building[0xa]`. `progress` and `constructing` only
 * select the flame set.
 */
export function burningFlames(
  type: number,
  burnCountdown: number,
  constructing: boolean,
  progress: number,
): PlacedFlame[] {
  const early = constructing && (progress & 0xffff) < FLAME_SITE_PROGRESS;
  const layout = FLAME_LAYOUT[early ? 0 : type];
  if (layout === undefined) return [];
  let phase = (((burnCountdown & 0xffff) >> 3) & 7) ^ 7;
  const out: PlacedFlame[] = [];
  for (const [size, dx, dy] of layout) {
    out.push({ idx: CURSOR_MARKER_BASE + FLAME_SPRITE_BASE + size + phase, dx, dy });
    phase = (phase + 3) & 7;
  }
  return out;
}
