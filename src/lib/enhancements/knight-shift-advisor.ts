/**
 * The shift-change assistant's traffic light: would a shift change put stronger knights into the
 * military buildings right now?
 *
 * The answer is a prediction from the two fixed phases of the original's shift change:
 *
 * - **Phase 1** (177 frames) drops every guard hut, guard tower and garrison to the second half of its
 *   occupancy table, and each sends home its WEAKEST knight until it fits (@0x15707).
 * - **Phase 2** (1023 frames) refills with a falling rank floor, so the stores give their STRONGEST
 *   idle knights first.
 *
 * So the knights that would leave are the weakest `occupancy − reducedTarget` of every garrison, and
 * the knights that would come are the strongest idle ones in stock. Paired weakest-out against
 * strongest-in, every pair where the newcomer outranks the leaver is an upgrade.
 *
 * The light has no tuned number, and its meaning is measured, not assumed — on the original saves,
 * running the shift change against a control run over eight random states each and comparing the
 * garrisons' fighting strength (Σ 2^rank) after 8000 frames:
 * - green: every leaver has a stronger replacement waiting. The only class with a measurable gain
 *   (6 of 6 positive, a few percent).
 * - yellow: some newcomers would be stronger, but not for every leaver — either too few wait, or
 *   some are no better. No measurable gain either way (means scattered around zero), and the
 *   garrisons are thin while the replacements walk in.
 * - red: no newcomer would be stronger, or a shift change is already running.
 *
 * Deliberately not modelled: whether a store is reachable over the road network, and whether a
 * building's exit tile is free (the original waits then). The prediction says what a shift change CAN
 * swap.
 *
 * Not a criterion, although it looks like one: the threat level. In every saved game where a shift
 * change would help, a building at threat level 3 is among those giving knights away — full occupancy
 * is what one sets at the border. Blocking on it would make the light red for good; the help names
 * the cost instead.
 */
import type { GameState, Player } from '../core/engine/state.js';
import { countIdleSerfs } from '../core/engine/ai-census.js';
import { occupancyTargetIn } from '../core/engine/serf-request.js';
import { unionU16 } from '../core/engine/serf-machine.js';
import { PLAYER_FLAG_SHIFT_ACTIVE } from '../core/engine/player-settings.js';

export type ShiftLight = 'green' | 'yellow' | 'red';

/** Serf type of the first knight rank; ranks 0..4 are types 22..26. */
const SERF_KNIGHT0 = 22;

export interface ShiftPrediction {
  /** Ranks of the knights phase 1 would send home, weakest first. */
  readonly leaving: readonly number[];
  /** Ranks of the idle knights in stock, strongest first. */
  readonly waiting: readonly number[];
  /** Pairs in which the newcomer outranks the knight it replaces. */
  readonly upgrades: number;
}

/** Ranks of a building's garrison, following the chain in union bytes 0xe/0xf like the ejection. */
function garrisonRanks(state: GameState, first: number): number[] {
  const ranks: number[] = [];
  for (let idx = first; idx !== 0; ) {
    const s = state.serfs[idx];
    if (s == null) break;
    ranks.push(s.type - SERF_KNIGHT0);
    idx = unionU16(s, 0xe);
  }
  return ranks;
}

export function predictShift(state: GameState, player: Player): ShiftPrediction {
  const leaving: number[] = [];
  for (const bld of state.buildings) {
    if (bld == null || bld.owner !== player.index || bld.constructing) continue;
    const reduced = occupancyTargetIn(state, bld, true);
    if (reduced === null) continue; // not a hut, tower or garrison
    const ranks = garrisonRanks(state, bld.firstKnight).sort((a, b) => a - b);
    leaving.push(...ranks.slice(0, Math.max(0, ranks.length - reduced)));
  }
  leaving.sort((a, b) => a - b);

  const idle = countIdleSerfs(state, player.index);
  const waiting: number[] = [];
  for (let rank = 4; rank >= 0; rank--) {
    for (let i = 0; i < (idle[SERF_KNIGHT0 + rank] ?? 0); i++) waiting.push(rank);
  }

  let upgrades = 0;
  for (let i = 0; i < leaving.length && i < waiting.length; i++) {
    if (waiting[i]! > leaving[i]!) upgrades++;
  }
  return { leaving, waiting, upgrades };
}

export function lightOf(p: ShiftPrediction): ShiftLight {
  if (p.upgrades === 0) return 'red'; // also when nothing would leave
  return p.upgrades === p.leaving.length ? 'green' : 'yellow';
}

export function shiftLight(state: GameState, player: Player): ShiftLight {
  if ((player.flags & PLAYER_FLAG_SHIFT_ACTIVE) !== 0) return 'red';
  return lightOf(predictShift(state, player));
}
