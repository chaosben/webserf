/**
 * Knight morale - port of `update_knight_morale` (`FUN_00011793`). The manual puts it in one sentence:
 * attack strength = motivation = amount of gold.
 *
 * The engine computes it once per rotation round for each player, from three accumulators the building
 * handlers fill over the course of the round: gold bars in finished own warehouses, gold in occupied
 * military buildings, and that gold's capacity. This routine reads them, derives the two visible
 * quantities and ZEROES all three - which is what makes them accumulators rather than stocks.
 *
 * The pace comes from the frame driver: the phase table entry for rotation 32 is the resource
 * distribution tick, whose very first act is four calls to this routine, one per player. So it runs
 * exactly once per round, after all 32 building blocks have filled their accumulators - and that is why
 * a save holds the FULL sum rather than a thirty-second of it.
 *
 * What is computed:
 * 1. `goldDeposited = min(military gold + warehouse gold, 0xffff)`.
 * 2. `goldMorale`: with no gold on the map a fixed `0x1000`; otherwise the share of the map's gold,
 *    scaled by `mapGoldMoraleFactor` and lifted by the base 1024. The share is capped just below 1 so
 *    that `0x1000` stays the maximum.
 * 3. The castle balance shifts the result permanently: positive adds `value * 1024` (saturating),
 *    negative subtracts `0x3ff` (floor 1).
 * 4. `militaryStrengthRatio`: own military score times display morale, against the sum of the other
 *    players, as a 16-bit fraction - 0 hopeless, `0xffff` superior.
 *
 * The original's 32-bit intermediates come out of 16-bit `mul`/`div`, hence the scaling loops that
 * halve dividend and divisor together until both fit a word. They are reproduced as they are: a clean
 * 64-bit computation would round differently.
 */

import type { GameState, Player } from './state.js';

/** Base morale without any gold deposit (`addw $0x400` @0x11845). */
export const MORALE_BASE = 0x400;
/** Morale on a map without any gold at all (`mov $0x1000` @0x117da). */
export const MORALE_NO_GOLD = 0x1000;
/** Penalty per lost castle (`subw $0x3ff` @0x1186e), lower bound 1 (`mov $0x1` @0x11879). */
export const MORALE_CASTLE_PENALTY = 0x3ff;

/** The four player slots in the order `@0x11752` works through them. */
export function updateAllKnightMorale(state: GameState): void {
  for (const player of state.players) {
    if (player) updateKnightMorale(state, player);
  }
}

/** One player pass (`FUN_00011793`). */
export function updateKnightMorale(state: GameState, player: Player): void {
  const goldSum = (player.militaryGoldAccumulator + player.goldAccumulator) >>> 0;

 // 1. goldDeposited — clamped to 16 bits (`cmpl $0x10000 ; mov $0xffffffff` @0x117ae).
  player.goldDeposited = goldSum >= 0x10000 ? 0xffff : goldSum & 0xffff;

 // 2. goldMorale from the share of the map's gold.
  const mapGold = state.header.mapGoldTotal >>> 0;
  if (mapGold === 0) {
    player.goldMorale = MORALE_NO_GOLD;
  } else {
    let total = mapGold;
    let own = goldSum;
    while (total >= 0x10000) {
      total >>>= 1;
      own >>>= 1;
    }
    if (own >= total) own = total - 1; // force a share below 1 (@0x11800)
 // `rorl $0x10` + 16-bit `div`: (own << 16) / total, guaranteed to fit a word.
    const share = Math.floor((own * 0x10000) / total) & 0xffff;
 // 16x16 `mul` -> 32 bits, of which the HIGH word (`rorl $0x10` @0x11842).
    const scaled = Math.floor((share * (state.header.mapGoldMoraleFactor & 0xffff)) / 0x10000);
    player.goldMorale = (scaled + MORALE_BASE) & 0xffff;
  }

 // 3. Permanent bonus/penalty from the castle balance (@0x11857).
  applyCastleBalance(player);

 // 4. Relative military strength (@0x118b1).
  player.militaryStrengthRatio = militaryStrengthRatio(state, player);

 // 5. Zero the three accumulators (@0x119f8/@0x11a03/@0x11a0e) — that is what makes them accumulators.
  player.militaryGoldAccumulator = 0;
  player.militaryGoldCapacity = 0;
  player.goldAccumulator = 0;
}

/**
 * `player[0x15e] != 0` => shift the morale. Negative: `-0x3ff`, floored at **1** on underflow (not
 * 0 — a morale of 0 would otherwise become possible). Positive: `+ value*1024`, saturating at
 * `0xffff`.
 */
function applyCastleBalance(player: Player): void {
  const balance = player.castleCaptureBalance | 0;
  if (balance === 0) return;
  if (balance < 0) {
    const v = player.goldMorale - MORALE_CASTLE_PENALTY;
    player.goldMorale = v < 0 ? 1 : v & 0xffff;
    return;
  }
 // `shlw $0x8` then `shlw $0x2` — both word shifts, so the bonus itself can overflow.
  const bonus = (balance << 10) & 0xffff;
  const v = player.goldMorale + bonus;
  player.goldMorale = v > 0xffff ? 0xffff : v & 0xffff;
}

/**
 * `player[0x186]` (@0x118b1): own military score times the **display morale** (`goldMorale >> 5`),
 * divided by 128, against the sum of the military scores of **all other** players.
 *
 * The three scaling loops keep both sides in 16 bits; the final halving of the numerator
 * (`shrw $1` @0x11997) is a **word** operation and therefore part of the result, not a detail.
 */
function militaryStrengthRatio(state: GameState, player: Player): number {
  let own = player.totalMilitaryScore >>> 0;
  let morale = (player.goldMorale >>> 5) & 0xffff;
  while (own >= 0x10000) {
    own >>>= 1;
    morale = (morale << 1) & 0xffff;
  }
  own = Math.floor((own * morale) / 0x80) >>> 0; // 16x16 `mul`, then `shrl $0x7`

  let others = 0;
  for (const p of state.players) {
    if (p && p !== player) others = (others + (p.totalMilitaryScore >>> 0)) >>> 0;
  }
  while (own >= 0x10000) {
    own >>>= 1;
    others >>>= 1;
  }
  while (others >= 0x10000) {
    own >>>= 1;
    others >>>= 1;
  }
  own = (own & 0xffff) >>> 1;

  if (own === 0 || others === 0) return 0;
  if (others <= own) return 0xffff;
  return Math.floor((own * 0x10000) / others) & 0xffff;
}
