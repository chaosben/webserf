/**
 * Which icon of the UI bank stands for which good and which profession.
 *
 * OUR OWN ADDITION — the original never needs this mapping as a function, because every screen
 * that shows goods or professions carries its icons in a fixed layout table. The stock overview
 * lists a FREELY CHOSEN subset, so it needs the mapping the other way round: type -> icon.
 *
 * For goods there is a formula. For serfs there is none, so the mapping is DERIVED from two of the
 * original's tables instead of being copied out by hand: `PROFESSION_STATS_LAYOUT[i]` and
 * `PROFESSION_STATS_SLOTS[i]` describe the same cell of the gauge grid (`col` differs by two, `row`
 * is equal), so the icon at position `i` belongs to the serf type at position `i`. Copying the
 * pairs out would work today and go stale silently the moment either table is touched.
 */
import { CASTLE_POPUP_NUMBERS, resourceIcon } from '../core/building-popup.js';
import { PROFESSION_STATS_LAYOUT, PROFESSION_STATS_SLOTS } from '../core/stats-popup.js';

/** Serf type of the unemployed settler — a number in the corner of screen 0x13, not a gauge. */
export const SETTLER_SERF_TYPE = 21;

/**
 * Its icon. It is the one layout entry of screen 0x13 that has no gauge slot, and therefore the one
 * that cannot come out of the pairing below; the test pins it against the table so it stays a
 * quotation rather than a guess.
 */
export const SETTLER_ICON = 0x82;

/** Bank-relative icon of a good (`UI_ICON_BASE` still has to be added to reach the archive slot). */
export function goodIcon(resourceType: number): number {
  return resourceIcon(resourceType);
}

const SERF_ICON_BY_TYPE = new Map<number, number>(
  PROFESSION_STATS_SLOTS.map((slot, i) => [slot.type, PROFESSION_STATS_LAYOUT[i]!.icon]),
);
SERF_ICON_BY_TYPE.set(SETTLER_SERF_TYPE, SETTLER_ICON);

/** Bank-relative icon of a serf type; `null` for the types the original never draws. */
export function serfIcon(serfType: number): number | null {
  return SERF_ICON_BY_TYPE.get(serfType) ?? null;
}

/** The 26 goods in the column order of the original's warehouse window. */
export const GOOD_ORDER: readonly number[] = CASTLE_POPUP_NUMBERS.map((slot) => slot.resource);

/**
 * The professions in the order of screen 0x13 — carriers and knights, then raw materials, then
 * food, and the unemployed settlers last, where the original puts their number too.
 *
 * Missing on purpose, and not to be "completed": type 4 (the internal duplicate entry that the
 * population sum of screen 0x12 skips as well) and type 27 ("dead", not a profession).
 */
export const SERF_ORDER: readonly number[] = [
  ...PROFESSION_STATS_SLOTS.map((slot) => slot.type),
  SETTLER_SERF_TYPE,
];
