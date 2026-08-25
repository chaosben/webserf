/**
 * Upkeep of the candidate rows - `FUN_0005325f`, slot 8 of the subtask table.
 *
 * While probing, the AI writes down build sites and attack targets and afterwards reasons only from
 * that list, but the world keeps changing. This subtask walks all recorded spots and zeroes the score
 * of every one that no longer qualifies; the emptied slot is overwritten by the next recording. Without
 * it the AI builds on memories.
 *
 * The frame has not a single branch: it sets up three shared quantities and then calls one of three
 * check bodies seven times, with a pointer to the first candidate row and a slot count. The rows lie
 * contiguously, so a pass simply runs across several of them - the cursor step knows no row boundary.
 *
 * Which row gets which body falls out of the call sites rather than being guessed: body B hits exactly
 * `LARGE_TYPES` without the castle, body A the remaining building types. Rows 0 (flag), 24 (castle) and
 * 25 (geologist) are not maintained at all.
 *
 * | Body | Centre | Surroundings |
 * |---|---|---|
 * | A (small) | own land, object class < 2 | neighbours 1..3 < 3, neighbours 4..6 < 4 |
 * | B (large) | own land, object class < 2 | neighbours 1..6 < 2, ring 2 < 4 |
 * | C (attack) | foreign land, object class >= 4 | - |
 *
 * This is deliberately NOT the full classifier: no terrain, no water, no flag distances, no levelling
 * height. It is a cheap decay check that throws away what is obviously dead; everything finer the
 * executor does again before building. Two consequences one would easily "repair": a candidate with a
 * tree at its centre survives, and in body A three of the six neighbours may carry a flag while the
 * other three may not. The three with the stricter bound are the first three in direction order, and
 * DownRight is the building's future flag site - exactly the rule the classifier knows too.
 *
 * The original computes in byte offsets of the map arrays and steps with masked byte deltas; our model
 * addresses tiles canonically and `spiralPos` does the same torus arithmetic. The delta chain of bodies
 * A/B yields, in order, exactly `SPIRAL_PATTERN[1..6]` and, as a set, `SPIRAL_PATTERN[7..18]`.
 *
 * Likewise the owner comparison: the original holds the raw owner bits against `(index + 4) << 5`.
 * Because "bit 7 clear implies bits 5/6 clear" holds throughout the original data, the decoded
 * comparison is provably equivalent.
 */
import type { GameState, Player } from './state.js';
import { posOf } from './position.js';
import { spiralPos } from './spiral.js';
import { OBJECT_CLASS, CLASS_SMALL_BUILDING } from './build-site.js';
import { AI_CANDIDATE_SLOTS } from './ai-candidates.js';

/** Which of the three check bodies serves a pass. */
export type AiUpkeepBody = 'small' | 'large' | 'attack';

/** One pass: one call site of the frame @0x5325f. */
export interface AiUpkeepPass {
  /** Address of the `call` in the frame. */
  readonly call: number;
  /** Which body is called. */
  readonly body: AiUpkeepBody;
  /** Entry of that body in the binary. */
  readonly entry: number;
  /** `player+X` of the first row, as in the `add $X,%esi` right before the `call`. */
  readonly base: number;
  /** First candidate row (== `(base - 0x434) / 48`). */
  readonly firstRow: number;
  /** Number of slots walked (== the immediate of `mov $n,%eax` **plus 1**). */
  readonly slots: number;
}

/** Base of the candidate table in the player block (`player+0x434`). */
export const AI_CANDIDATE_BASE = 0x434;

/**
 * **The seven passes** of the frame @0x5325f, in original order. Kept as data so that a guard can hold
 * base, count and body target against the instruction stream call site by call site — with seven
 * nearly identical blocks that is the only form in which the assignment stays checkable at all.
 *
 * The row coverage adds up exactly: 1..9, 10, 11, 12..14, 15, 16..23 == **all** building types 1..23,
 * plus 26..34 == all nine attack target kinds.
 */
export const AI_UPKEEP_PASSES: readonly AiUpkeepPass[] = [
  { call: 0x5329f, body: 'small', entry: 0x53341, base: 0x464, firstRow: 1, slots: 72 },
  { call: 0x532b9, body: 'small', entry: 0x53341, base: 0x644, firstRow: 11, slots: 8 },
  { call: 0x532d3, body: 'small', entry: 0x53341, base: 0x704, firstRow: 15, slots: 8 },
  { call: 0x532ed, body: 'large', entry: 0x5350f, base: 0x614, firstRow: 10, slots: 8 },
  { call: 0x53307, body: 'large', entry: 0x5350f, base: 0x674, firstRow: 12, slots: 24 },
  { call: 0x53321, body: 'large', entry: 0x5350f, base: 0x734, firstRow: 16, slots: 64 },
  { call: 0x5333b, body: 'attack', entry: 0x53943, base: 0x914, firstRow: 26, slots: 72 },
];

/** Object class of a tile — `gs+0xc8`, indexed with `landscape[3] & 0x7f`. */
function classAt(state: GameState, pos: number, index: number): number {
  const tile = state.mapTiles[spiralPos(pos, index, state.geo)];
  if (tile === undefined) return 0;
  return OBJECT_CLASS[tile.object] ?? 0;
}

/**
 * Body A @0x53341 — decay check of a **small** build site.
 *
 * Order and bounds byte-exact: centre `< 2` (@0x533c7), then the six neighbours in direction order
 * with `< 3` (@0x533f8, @0x5342b, @0x53462) and `< 4` (@0x53495, @0x534c4, @0x534f1). The last
 * comparison jumps to the loop foot on success (`jb 0x53500`), all others jump to the zeroing on
 * failure (`jae 0x534f7`).
 */
export function aiUpkeepSmallSiteValid(state: GameState, player: Player, pos: number): boolean {
  const center = state.mapTiles[pos];
  if (center === undefined) return false;
  if (center.owner !== player.slot + 1) return false; // @0x533a5 `cmp %ax,0x10(%edi) ; jne`
  if (classAt(state, pos, 0) >= 2) return false; // @0x533c7 `cmpb $0x2 ; jae`
  for (let i = 1; i <= 3; i++) if (classAt(state, pos, i) >= 3) return false;
  for (let i = 4; i <= 6; i++) if (classAt(state, pos, i) >= CLASS_SMALL_BUILDING) return false;
  return true;
}

/**
 * Body B @0x5350f — decay check of a **large** build site.
 *
 * Centre and all six neighbours `< 2` (@0x53595 … @0x536c7), then the whole of ring 2 with `< 4`
 * (@0x536f8 … @0x53925). The original walks the ring as Right · DownRight · 2x Down · 2x Left ·
 * 2x UpLeft · 2x Up · 2x Right; as a set that is exactly `SPIRAL_PATTERN[7..18]`, and since all twelve
 * share the same bound the order does not matter.
 */
export function aiUpkeepLargeSiteValid(state: GameState, player: Player, pos: number): boolean {
  const center = state.mapTiles[pos];
  if (center === undefined) return false;
  if (center.owner !== player.slot + 1) return false; // @0x53573 `cmp %ax,0x10(%edi) ; jne`
  for (let i = 0; i <= 6; i++) if (classAt(state, pos, i) >= 2) return false;
  for (let i = 7; i <= 18; i++) if (classAt(state, pos, i) >= CLASS_SMALL_BUILDING) return false;
  return true;
}

/**
 * Body C @0x53943 — decay check of an **attack target**.
 *
 * Three conditions, all at the centre: the land belongs to somebody (@0x5399f `or %al,%al ; jns` on
 * the raw owner byte), it does **not** belong to the player (@0x539af `je`), and a building still
 * stands there (@0x539c9 `cmpb $0x4 ; jae` — the only comparison of the routine whose success leads
 * **past** the zeroing).
 */
export function aiUpkeepAttackTargetValid(state: GameState, player: Player, pos: number): boolean {
  const tile = state.mapTiles[pos];
  if (tile === undefined) return false;
  if (tile.owner === 0) return false; // bit 7 of the owner byte clear => unclaimed
  if (tile.owner === player.slot + 1) return false; // own territory => not a target
  return (OBJECT_CLASS[tile.object] ?? 0) >= CLASS_SMALL_BUILDING;
}

/** Check one slot — `true` when it stays valid. */
function slotValid(
  state: GameState,
  player: Player,
  body: AiUpkeepBody,
  col: number,
  row: number,
): boolean {
  const pos = posOf(col, row, state.geo);
  if (body === 'attack') return aiUpkeepAttackTargetValid(state, player, pos);
  if (body === 'large') return aiUpkeepLargeSiteValid(state, player, pos);
  return aiUpkeepSmallSiteValid(state, player, pos);
}

/**
 * **The frame** `FUN_0005325f` @0x5325f — walk all recorded spots and devalue the decayed ones. Returns
 * the number of zeroed slots (the original has no return value; the counter serves tests and guards).
 *
 * The frame itself does not branch; its single exit @0x53340 is a bare `ret`.
 */
export function aiCandidateUpkeep(state: GameState, player: Player): number {
  let cleared = 0;
  for (const pass of AI_UPKEEP_PASSES) {
    for (let n = 0; n < pass.slots; n++) {
      const rowIndex = pass.firstRow + Math.floor(n / AI_CANDIDATE_SLOTS);
      const slot = player.aiCandidates[rowIndex]?.[n % AI_CANDIDATE_SLOTS];
      if (slot === undefined) continue;
      if (slot.score === 0) continue; // @0x53347 `or %ax,%ax ; je` — empty slot, nothing to check
      if (slotValid(state, player, pass.body, slot.col, slot.row)) continue;
      slot.score = 0; // @0x534f7 / @0x5392b / @0x539cf `xor %ax,%ax ; mov %ax,(%ebx)`
      cleared += 1;
    }
  }
  return cleared;
}
