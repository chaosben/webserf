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
 * `(dx, dy)`. Reachable are `n = 0..6` (own animation at direction 0) and `n = 10..16` (opponent's
 * animation at direction 4) — the rest is zero padding of the original table.
 */
// prettier-ignore
const HIT_MARKER_OFFSET: readonly (readonly [number, number])[] = [
  [9, 5], [10, 7], [10, 2], [8, 6], [11, 8], [9, 6], [9, 8], [0, 0], [0, 0], [5, 5],
  [4, 7], [4, 2], [7, 5], [3, 8], [5, 6], [5, 8], [0, 0], [0, 0], [0, 0],
];

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
 * Hit marker for the fighter currently drawn, **relative to his base point** (where the drawing
 * routine stands before the animation offset is added — i.e. including the constant `-2` of the serf
 * drawing). `null` = no hit in this frame.
 */
export function hitMarkerOffset(
  serf: SerfRecord,
  partner: SerfRecord,
): { dx: number; dy: number; sprite: number } | null {
  // Gate order as in the original: animation range of the DRAWN serf (@0x26de7/0x26df4), then the
  // strike pose, then the last quarter of the round.
  if (serf.animation < 0x92 || serf.animation >= 0x9c) return null;
  const dir = serf.stateData[2] ?? 0;
  if (dir !== 0 && dir !== 4) return null;
  if (serf.counter >= 0x20) return null;
  // At direction 4 the table index comes from the opponent (@0x26e5b loads his record).
  const anim = dir === 0 ? serf.animation : partner.animation;
  const entry = HIT_MARKER_OFFSET[(anim - 0x93) & 0xff];
  if (entry === undefined) return null; // outside the original table: do not guess
  return {
    dx: entry[0] - HIT_MARKER_X_BIAS,
    dy: -entry[1],
    sprite: HIT_MARKER_SPRITE + (((serf.counter >> 3) & 0xffff) ^ 3),
  };
}
