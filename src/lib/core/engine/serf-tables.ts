/**
 * Binary tables of the serf state machine, lifted verbatim from the original — data, not logic.
 */

/**
 * `counter_from_animation[anim]` — base counter duration per animation index, 200 u16 entries from
 * `DAT_000258fb`. Handlers scale this base value by the road slope, see {@link ROAD_BUILDING_SLOPE}.
 */
// prettier-ignore
export const COUNTER_FROM_ANIMATION: readonly number[] = [
  511, 447, 383, 319, 255, 319, 511, 767, 1023, 511, 447, 383, 319, 255, 319, 511, 767, 1023, 511, 447,
  383, 319, 255, 319, 511, 767, 1023, 511, 447, 383, 319, 255, 319, 511, 767, 1023, 511, 447, 383, 319,
  255, 319, 511, 767, 1023, 511, 447, 383, 319, 255, 319, 511, 767, 1023, 511, 447, 383, 319, 255, 319,
  511, 767, 1023, 511, 447, 383, 319, 255, 319, 511, 767, 1023, 511, 447, 383, 319, 255, 319, 511, 767,
  1023, 127, 127, 127, 127, 127, 127, 383, 383, 255, 223, 191, 159, 127, 159, 255, 383, 511, 255, 255,
  255, 0, 767, 511, 511, 767, 1023, 639, 639, 1023, 63, 63, 63, 63, 63, 63, 1023, 31, 767, 767, 255,
  191, 127, 1535, 2367, 383, 303, 303, 383, 383, 383, 767, 767, 127, 127, 1471, 1983, 383, 767, 383,
  1535, 783, 63, 575, 1535, 1407, 159, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127,
  127, 127, 127, 127, 127, 127, 127, 127, 191, 7, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 127,
  7, 9, 5, 10, 7, 10, 2, 8, 6, 11, 8, 9, 6, 9, 8, 0, 0, 0, 0, 0,
];

/**
 * `road_building_slope[i]` (`TAB_22fde`) — slope/pace factor, indexed by
 * `type + (constructing ? 32 : 0)`, which is the binary's `(building.byte4 & 0xfc) >> 2`: type in
 * bits 0..4, "under construction" in bit 5. Entries 0..24 are the finished building types, 32..56 the
 * same types **under construction** (factor 1 throughout).
 */
// prettier-ignore
export const ROAD_BUILDING_SLOPE: readonly number[] = [
  5, 18, 18, 15, 18, 22, 22, 22, 22, 18, 16, 18, 1, 10, 1, 15, 15, 16, 15, 15, 10, 15, 20, 15, 18,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

/** Slope table index of a building: `type + (constructing ? 32 : 0)` (== `(byte4 & 0xfc) >> 2`). */
export function slopeIndex(type: number, constructing: boolean): number {
  return type + (constructing ? 32 : 0);
}
