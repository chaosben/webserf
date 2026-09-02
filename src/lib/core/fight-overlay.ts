/**
 * Fight extra pass of the serf drawing - port of `FUN_00026cc4` and its fall-through `FUN_00026d80`.
 * Two things the original draws in ADDITION when a knight is in a fight: the opponent (`serf[0xe]`),
 * who stands on the same tile and is therefore skipped by the ordinary pass, and the hit marker above
 * the two.
 *
 * The opponent is otherwise invisible because the ordinary pass collects serf indices from the TILES
 * and drops every serf whose tile does not point at him. In a fight only one of the two is in the
 * tile: the defender takes over the attacker's position without registering there. That is why the
 * original calls the SECOND entry point of the same drawing routine for the opponent - the one without
 * the tile check.
 *
 * The gate is the sprite band, not the serf state: `0x80..0xbf` is the fight band, and against the
 * archive's animation table that band separates the two roles of a duel cleanly - the attacker's
 * codes fall inside it, the defender's do not. Two consequences: the extra pass runs exactly once per
 * duel, from the attacker, and it cannot recurse (the drawn opponent is never in the band himself),
 * which is why the port draws the opponent without a recursion brake of its own.
 *
 * The hit marker is emitted only in the two strike moments of the sequence and only in the last quarter
 * of the round. Its offset comes from a table indexed by the animation; at pose direction 0 the own
 * animation counts, at direction 4 that of the OPPONENT. The sprite follows the counter through the
 * four red stages of the marker bank.
 *
 * ## Where the marker sits, and why the table's zeros must never be used
 *
 * A serf sprite spans `[base - 6, base + 1]` vertically (torso, arms and head all share that band in
 * the archive) and the fight animations carry `anim.y = +1`, so the body of a fighter covers
 * `[base - 5, base + 2]`. The table's `dy` of 5..8 therefore puts the marker at head height or above
 * it, `dy = 2` into leg height - and `dy = 0` onto the fighter's ankles. The original never draws it
 * there: {@link HIT_MARKER_OFFSET} has six `(0, 0)` slots and all six are unreachable, because the
 * strike pose `serf[0xd]` and the animation come from the SAME group of the sequence table (pose 0
 * yields attacker animations `0x93..0x99`, pose 4 defender animations `0x9d..0xa3`). A marker on a
 * zero slot is thus not a drawing question but the symptom of a serf whose pose byte and animation
 * have drifted apart - a state the original cannot form. {@link hitMarkerTableIndex} reports the raw
 * index so that can be measured instead of drawn.
 *
 * ## The window origin is NOT applied here
 *
 * `blit_map_marker_sprite` @0x349c5 adds `+0x10` to x, `+8` to y and `+0x140` to the sprite before it
 * blits. The first two are the window origin of the screen group, which this port leaves out
 * everywhere (see `map-render.ENTITY_ROW_BIAS`), so they are left out here too. The `subw $0x10` of
 * the record (@0x26ece) is kept: its base is a SERF coordinate, which already carries the origin, and
 * the subtraction is what places the marker between the two fighters rather than half a tile to their
 * right.
 *
 * The original appends the markers to a list which is worked off AFTER the map selector; the port keeps
 * that split - collect here, draw as the last layer.
 */

import type { SerfRecord } from './types.js';

/** Lower/upper bound of the fight sprite band in the knight branch (@0x26b5e: `jns` / `cmpb $0xc0`). */
const FIGHT_POSE_MIN = 0x80;
const FIGHT_POSE_MAX = 0xc0;

/** Serf type indices of the five knight ranks. */
const TYPE_KNIGHT0 = 22;
const TYPE_KNIGHT4 = 26;

/** State 46 `KnightLeaveForFight` — the opponent is still inside and is not drawn. */
const ST_KNIGHT_LEAVE_FOR_FIGHT = 0x2e;

/** Capacity of the original's marker list (`vp[0x1ae]` runs from -1 to 9). */
export const HIT_MARKER_CAPACITY = 10;

/** First of the four hit sprites in the marker bank (`+ CURSOR_MARKER_BASE`). */
const HIT_MARKER_SPRITE = 0xc6;

/**
 * Offset table of the hit marker (@0x25a65), entry `n` = animation `0x93 + n`, two i16 each
 * `(dx, dy)`. Its length is not a guess: the serf row-bias table begins at `0x25ab5` (`lea` @0x25d48),
 * so the table holds `0x50 / 4 = 20` entries.
 *
 * Reachable are `n = 0..6` (own animation at pose 0) and `n = 10..16` (opponent's animation at pose
 * 4); the six `(0, 0)` slots cannot be reached - see the module head and
 * {@link HIT_MARKER_REACHABLE}.
 */
// prettier-ignore
const HIT_MARKER_OFFSET: readonly (readonly [number, number])[] = [
  [9, 5], [10, 7], [10, 2], [8, 6], [11, 8], [9, 6], [9, 8], [0, 0], [0, 0], [0, 0],
  [5, 5], [4, 7], [4, 2], [7, 5], [3, 8], [5, 6], [5, 8], [0, 0], [0, 0], [0, 0],
];

/**
 * The table indices the strike sequence can actually produce. Derived from the pose/animation
 * coupling, not from the zero pattern: pose 0 indexes with the attacker's animation, pose 4 with the
 * defender's, and both come from the same group of the sequence table.
 */
export const HIT_MARKER_REACHABLE: ReadonlySet<number> = new Set([
  0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16,
]);

/** The `x` subtraction the original applies before storing (@0x26ece `subw $0x10`). */
const HIT_MARKER_X_BIAS = 0x10;

/** A hit marker: window position + sprite value of the marker bank (like `CursorMarker`). */
export interface HitMarker {
  readonly x: number;
  readonly y: number;
  readonly sprite: number;
}

/**
 * Is this serf in a fight pose for which the original calls the extra pass? (Gate from the knight
 * branch: knight type **and** frame sprite code inside the band `0x80..0xbf`.)
 */
export function isFightPose(serfType: number, animSprite: number): boolean {
  return (
    serfType >= TYPE_KNIGHT0 &&
    serfType <= TYPE_KNIGHT4 &&
    animSprite >= FIGHT_POSE_MIN &&
    animSprite < FIGHT_POSE_MAX
  );
}

/** Opponent serf index `serf[0xe]` (u16 over the union bytes 14/15); 0 = no fight. */
export function fightPartnerIndex(serf: SerfRecord): number {
  return (serf.stateData[3] ?? 0) | ((serf.stateData[4] ?? 0) << 8);
}

/** Is the opponent drawn? (Not while leaving the building — @0x26f95 `cmpb $0x2e`.) */
export function fightPartnerVisible(partner: SerfRecord): boolean {
  return partner.state !== ST_KNIGHT_LEAVE_FOR_FIGHT;
}

/**
 * Table index the original would use for the fighter currently drawn, or `null` when no hit falls in
 * this frame. Separate from {@link hitMarkerOffset} because the index is the measurable quantity: it
 * must always land in {@link HIT_MARKER_REACHABLE}, and anything else means the serf's pose byte and
 * animation have drifted apart.
 */
export function hitMarkerTableIndex(serf: SerfRecord, partner: SerfRecord): number | null {
  // Gate order as in the original: animation range of the DRAWN serf (@0x26de7/0x26df4), then the
  // strike pose, then the last quarter of the round.
  if (serf.animation < 0x92 || serf.animation >= 0x9c) return null;
  const dir = serf.stateData[2] ?? 0;
  if (dir !== 0 && dir !== 4) return null;
  if (serf.counter >= 0x20) return null;
  // At pose 4 the table index comes from the opponent (@0x26e5b loads his record).
  const anim = dir === 0 ? serf.animation : partner.animation;
  return (anim - 0x93) & 0xff;
}

/**
 * Hit marker for the fighter currently drawn, **relative to his base point** (where the drawing
 * routine stands before the animation offset is added — i.e. including the constant `-2` of the serf
 * drawing). `null` = no hit in this frame.
 */
export function hitMarkerOffset(
  serf: SerfRecord,
  partner: SerfRecord,
): { dx: number; dy: number; sprite: number } | null {
  const n = hitMarkerTableIndex(serf, partner);
  if (n === null) return null;
  // An index outside the reachable set is not a marker the original would place somewhere else - it
  // is a pose byte that no longer belongs to the animation. Drawing the zero slot would put the
  // marker on the fighter's ankles, so nothing is drawn; `hitMarkerTableIndex` makes the case
  // measurable.
  if (!HIT_MARKER_REACHABLE.has(n)) return null;
  const entry = HIT_MARKER_OFFSET[n]!;
  return {
    dx: entry[0] - HIT_MARKER_X_BIAS,
    dy: -entry[1],
    sprite: HIT_MARKER_SPRITE + (((serf.counter >> 3) & 0xffff) ^ 3),
  };
}
