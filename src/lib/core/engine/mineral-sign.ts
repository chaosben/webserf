/**
 * The sign a geologist plants for a deposit — the encoding alone, without the sampling around it.
 *
 * It sits in its own leaf module because two sides need the SAME rule: the geologist
 * (`samplingGeoSpot`, @0x18eac) writes the object onto the map, and the map display can ask what
 * would stand on a tile without anyone having sampled it. Spelling the chain out twice would be
 * right today and drift apart silently.
 *
 * ## The encoding
 * Mineral byte `(mineral<<5) | amount`; object `0x6e + mineral*2 (+1 when amount < 12)` — gold
 * `0x70`/`0x71`, iron `0x72`/`0x73`, coal `0x74`/`0x75`, stone `0x76`/`0x77`, "nothing found"
 * `0x78`. The grade is binary: one large and one small circle, no third step.
 */

/** The sign for "sampled, nothing here" (`0x78`). */
export const MINERAL_SIGN_NOTHING = 0x78;
/** Below this amount the small circle is shown (`cmpw $0xc` in the chain). */
export const MINERAL_SIGN_SMALL_BELOW = 0xc;

const SIGN_BASE = 0x6e;
const SIGN_FIRST = 0x70;
const SIGN_LAST = 0x77;

/**
 * The map object for a deposit, exactly as @0x18eac derives it.
 *
 * **The zero test is on the whole byte, not on the mineral**, and that matters to every caller that
 * is not the geologist: a tile with `mineral == 0` but an amount — which is how FISH are stored —
 * runs through the second branch with `signOff == 0` and yields `0x6e`/`0x6f`, ripe grain, not a
 * sign at all. The original never gets there because a geologist only samples mountain terrain. A
 * caller that walks every tile has to test `mineral !== 0` itself; the quirk stays here because it
 * is what the original computes.
 */
export function mineralSignObject(mineral: number, amount: number): number {
  const mineralByte = ((mineral & 7) << 5) | (amount & 0x1f);
  if (mineralByte === 0) return MINERAL_SIGN_NOTHING;
  let signOff = (mineralByte & 0xe0) >> 4; // = mineral*2
  if ((mineralByte & 0x1f) < MINERAL_SIGN_SMALL_BELOW) signOff += 1; // small deposit
  return (signOff + SIGN_BASE) & 0xff;
}

/**
 * Is this map object one of the four minerals' signs (`0x70..0x77`)?
 *
 * Deliberately WITHOUT `0x78`: the empty sign carries no deposit, so for a reader asking "does the
 * game already show what lies here" it is a no. The geologist's own "area explored" test spans
 * `0x70..0x78` and states that range itself.
 */
export function isMineralSign(object: number): boolean {
  return object >= SIGN_FIRST && object <= SIGN_LAST;
}

/**
 * How many minerals the mountains hold — GOT from the encoding, not written down: each gets two
 * adjacent objects (large and small), and the range `0x70..0x77` is eight wide. Gold, iron, coal,
 * stone, in that order; mineral 0 is "none".
 */
export const MINERAL_COUNT = (SIGN_LAST - SIGN_FIRST + 1) / 2;

/**
 * The LARGE sign of each mineral, in that order — the picture that stands for the deposit itself,
 * for a caller who wants to SHOW the four rather than encode one (the hack switch does).
 */
export const MINERAL_SIGNS_LARGE: readonly number[] = Array.from({ length: MINERAL_COUNT }, (_, i) =>
  mineralSignObject(i + 1, MINERAL_SIGN_SMALL_BELOW),
);
