/**
 * Subsystem 6 — military: the **defence garrison** (knights idling on guard in military buildings).
 *
 * States 70/71/72/75 (DefendingHut/Tower/Fortress/Castle, `@0x1fb4d`/`@0x1fba6` family) are thin
 * dispatchers: rank = `serf.type - 22`, they load the per-building promotion threshold from an
 * overlapping packed table (`@0x1fc1c` region) and jump through `@0x1fc40` into the **rank-specific**
 * guard handler (`@0x1fce8`/`@0x1fd95`/`@0x1fe42`/`@0x1feef` for ranks 0..3).
 *
 * **The rank-4 handler `@0x1ff9c` is a bare `ret`**: a Knight4 in a garrison is a no-op — no tick
 * prologue, frozen. That is also what keeps a promotion from overflowing into type 27 (Dead).
 *
 * Ranks 0..3 run the tick prologue; without an underflow they are done. On underflow a re-arm loop
 * spends one RNG roll per iteration: below the threshold it promotes and sets `counter = 6000`,
 * otherwise it adds 6000 and stops as soon as that addition wraps in u16.
 *
 * Promotion is rare (< 0.4 % per re-arm in a hut, <= 6 % for castle rank 0) and RNG-driven, so the
 * concrete choice cannot be reproduced against a capture; the deterministic part can.
 */

import { addU16, subU16, u16, i16 } from './int.js';
import type { GameState, Serf, Player, Building } from './state.js';
import { setSerfType } from './state.js';
import { posOf, colOf, rowOf, neighbor, Direction, DIR_DELTA } from './position.js';
import { spiralPos } from './spiral.js';
import { BUILDING_SCORE } from './building-tables.js';
import { COUNTER_FROM_ANIMATION } from './serf-tables.js';
import { freeSerf } from './economy.js';
import {
  dispatchSerf,
  blockedWaitOut,
  stepOutToFlagMove,
  beginExitAnimation,
  beginEnterAnimation,
  setUnionU16,
  unionU16,
} from './serf-machine.js';
import { addPlayerMessage } from './player-messages.js';
import { freeWalkingCommon } from './serf-free-walking.js';
import { recomputeTerritory } from './territory.js';
import { demolishBuilding } from './buildings.js';
import { cancelTransportOnDelete } from './transport-cancel.js';
import { clearRoadPaths, returnTransitResourceToStock } from './road-teardown.js';

const KNIGHT0 = 22; // serf type Knight0 (rank = type - 22)
const MAX_RANK = 4; // Knight4 (type 26) — the rank-4 handler is a no-op
const REARM = 6000; // 0x1770 — re-arm increment of the guard counter
const REARM_WRAP = 0xe890; // the loop stops as soon as `counter += 6000` wraps in u16

/** `counter_from_animation[anim]` as u16 — for the slope move in state 56. */
function cfa(anim: number): number {
  return (anim >= 0 && anim < COUNTER_FROM_ANIMATION.length ? COUNTER_FROM_ANIMATION[anim] : 0) & 0xffff;
}

// Combat decision core, read off `KnightPrepareAttacking` @0x182e5. Pure functions; the state machine
// around them (45 puts both fighters into 48/49, calls this, books the loser) lives further down.

const STRENGTH_BASE = 0x400; // base strength of Knight0, doubled per rank (0x400 << rank)
const HOME_MORALE = 0x1000; // full morale on own land — the home advantage

/** Knight rank 0..4 from the serf type byte: `((b & 0x7c) >> 2) - 0x16`. */
export function knightRank(typeByte: number): number {
  return ((typeByte & 0x7c) >> 2) - KNIGHT0;
}

/**
 * Effective combat strength: `(base * morale) >> 16`, with morale being `0x1000` on own land and the
 * gold morale `player+0x184` on enemy or neutral ground. Both factors are u16 and the original keeps
 * the high word of the 32-bit product.
 */
export function knightStrength(rank: number, isHomeTile: boolean, goldMorale: number): number {
  const basis = u16(STRENGTH_BASE << rank);
  const moral = isHomeTile ? HOME_MORALE : u16(goldMorale);
  return Math.trunc((basis * moral) / 0x10000);
}

/**
 * Duel outcome: `total = u16(strA + strB)`, `roll = (total * rng) >> 16`, and the **attacker wins on
 * `roll < strA`** — so `P(win) = strA / (strA + strB)`. Pure; the booking is `applyDuelLoss`.
 */
export function attackerWinsDuel(strengthAtt: number, strengthDef: number, rngValue: number): boolean {
  const total = u16(strengthAtt + strengthDef);
  const roll = Math.trunc((total * u16(rngValue)) / 0x10000);
  return roll < strengthAtt;
}

/**
 * Booking the loser: `militaryScore -= 1 << loserRank` and `serfCount[loserRank + 22] -= 1` on the
 * loser's owner. `serfCount` is only decremented when positive — the original decrements
 * unconditionally, but our cached census must not go negative.
 */
export function applyDuelLoss(player: Player | null | undefined, loserRank: number): void {
  if (player == null) return;
  player.totalMilitaryScore -= 1 << loserRank;
  const type = KNIGHT0 + loserRank;
  if (player.serfCount[type] > 0) player.serfCount[type] -= 1;
}

/**
 * Promotion threshold per building type and rank — `P(promotion) = threshold / 65536` per re-arm.
 *
 * The table `@0x1fc1c` is one **halving series** `4000 2000 1000 500 250 125 62 31 0`, and the four
 * bases are shifted views into it (hut `0x1fc2c[r*4]`, tower `0x1fc24[r*4]`, fortress `0x1fc20[r*4]`,
 * castle `0x1fc1c[r*8]`). The steepest view `0x1fc1c[r*4]` belongs to no guard state at all but to
 * knight training in a stock, where the values sit as immediates (`STOCK_TRAINING_THRESHOLD`).
 */
const DEFEND_THRESHOLD: Readonly<Record<number, readonly number[]>> = {
  70: [250, 125, 62, 31, 0], // DefendingHut
  71: [1000, 500, 250, 125, 62], // DefendingTower
  72: [2000, 1000, 500, 250, 125], // DefendingFortress
  75: [4000, 1000, 250, 62, 0], // DefendingCastle
};

/**
 * Promoting a knight — in the binary a **75-byte block** that is literally the same in two places: the
 * guard handler (`@0x1fd2f`) and knight training in a stock (`@0x1f811`), 0 differing instructions.
 * Hence one helper; the bodies around it stay separate because their exits differ.
 */
export function promote(state: GameState, serf: Serf, rang: number): void {
  setSerfType(serf, KNIGHT0 + rang + 1);
  const player = state.players[serf.owner];
  if (player === null || player === undefined) return;
  if (player.serfCount[KNIGHT0 + rang] > 0) player.serfCount[KNIGHT0 + rang] -= 1;
  player.serfCount[KNIGHT0 + rang + 1] += 1;
 // The score delta is the weight of the OLD rank: +1/+2/+4/+8 for ranks 0..3 (@0x1fce8 family).
  player.totalMilitaryScore += 1 << rang;
}

/** Shared guard-idle body for ranks 0..3; rank 4 is a no-op (bare `ret`). */
function defendingGarrison(state: GameState, serf: Serf, thresholds: readonly number[]): void {
  const rang = serf.type - KNIGHT0;
  if (rang < 0 || rang >= MAX_RANK) return; // rank-4 handler is a bare `ret` => frozen

  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (oldCounter >= delta) return; // no underflow

  const threshold = thresholds[rang];
  for (;;) {
    if (state.rng.next() < threshold) {
      promote(state, serf, rang);
      serf.counter = REARM;
      return;
    }
    const before = serf.counter;
    serf.counter = addU16(before, REARM);
    if (before >= REARM_WRAP) return; // the addition wrapped
  }
}

export const defendingHut = (state: GameState, serf: Serf): void =>
  defendingGarrison(state, serf, DEFEND_THRESHOLD[70]);
export const defendingTower = (state: GameState, serf: Serf): void =>
  defendingGarrison(state, serf, DEFEND_THRESHOLD[71]);
export const defendingFortress = (state: GameState, serf: Serf): void =>
  defendingGarrison(state, serf, DEFEND_THRESHOLD[72]);
export const defendingCastle = (state: GameState, serf: Serf): void =>
  defendingGarrison(state, serf, DEFEND_THRESHOLD[75]);

// The duel path of the attack chain (states 45/47/48/49/50/51). The animation frames themselves are
// pure rendering, but their RNG consumption is reproduced exactly — otherwise the stream desyncs.

const ST_KNIGHT_ATTACKING = 0x30; // 48
const ST_KNIGHT_DEFENDING = 0x31; // 49
const ST_KNIGHT_VICTORY = 0x32; // 50
const ST_KNIGHT_DEFEAT = 0x33; // 51
const ST_KNIGHT_PREPARE_DEFENDING = 0x2f; // 47
const ST_KNIGHT_ENGAGING = 0x2c; // 44 (re-engage after a win)
const ST_KNIGHT_PREPARE_ATTACKING = 0x2d; // 45 (`mov $0x2d` @0x17f6d-Familie)
const ST_KNIGHT_LEAVE_FOR_FIGHT = 0x2e; // 46 — the defender leaving
const ST_ENTERING_BUILDING = 4;
const SERF_DEAD = 27;
// Open-field combat. 60/61 have NO handlers of their own — they use 48/49 (the `serf.state == 60`
// branch in `knightAttacking`); 49/61 are no-ops, the attacker's handler drives the defender.
const ST_KNIGHT_ENGAGE_DEFENDING_FREE = 0x36; // 54
const ST_KNIGHT_ENGAGE_ATTACKING_FREE = 0x37; // 55
const ST_KNIGHT_ENGAGE_ATTACKING_FREE_JOIN = 0x38; // 56
const ST_KNIGHT_PREPARE_ATTACKING_FREE = 0x39; // 57
const ST_KNIGHT_PREPARE_DEFENDING_FREE = 0x3a; // 58
const ST_KNIGHT_PREPARE_DEFENDING_FREE_WAIT = 0x3b; // 59
const ST_WALKING = 2; // a walking knight — the target of the open-field scan
const ST_KNIGHT_ATTACKING_FREE = 0x3c; // 60 — the open-field discriminator in the 48/60 resolution
const ST_KNIGHT_DEFENDING_FREE = 0x3d; // 61
const ST_KNIGHT_ATTACKING_VICTORY_FREE = 0x3e; // 62
const ST_KNIGHT_DEFENDING_VICTORY_FREE = 0x3f; // 63
const ST_KNIGHT_ATTACKING_FREE_WAIT = 0x40; // 64
const ST_KNIGHT_FREE_WALKING = 0x35; // 53
const ST_LOST = 0x19; // 25 — a winner with no further opponents reorients

// Strike sequence table @0x18782 — 8 blocks of 16, 0xff ends a sequence. Indexed by `serf[0xb]`,
// whose start value is `rng() & 0x70` (a block start) and which then advances by one per round.
const STRIKE_SEQ: readonly number[] = [
  1, 2, 4, 2, 0, 2, 4, 2, 1, 0, 2, 2, 3, 0, 0, 255,
  3, 2, 2, 3, 0, 4, 1, 3, 2, 4, 2, 2, 3, 0, 0, 255,
  2, 1, 4, 3, 2, 2, 2, 3, 0, 3, 1, 2, 0, 2, 0, 255,
  2, 1, 3, 2, 4, 2, 3, 0, 0, 4, 2, 0, 2, 1, 0, 255,
  3, 1, 0, 2, 2, 1, 0, 2, 4, 2, 2, 3, 0, 0, 255, 0,
  3, 1, 2, 3, 4, 2, 1, 2, 0, 2, 4, 0, 2, 0, 255, 0,
  2, 1, 2, 4, 2, 3, 0, 2, 4, 3, 2, 0, 0, 255, 0, 0,
  1, 4, 3, 2, 2, 1, 2, 0, 0, 4, 3, 0, 255, 0, 0, 0,
];
// Group sizes per `dir` @0x18d48 and animation pair bytes @0x18d4d — index `(GRP[dir] * rng) >> 16`.
// High nibble is the attacker frame, low nibble the defender frame.
const GRP: readonly number[] = [10, 11, 14, 11, 10];
const ANIM_PAIR: readonly (readonly number[])[] = [
  [0x18, 0x23, 0x29, 0x38, 0x43, 0x48, 0x53, 0x59, 0x64, 0x79],
  [0x1a, 0x28, 0x2a, 0x39, 0x49, 0x4a, 0x58, 0x68, 0x6a, 0x78, 0x7a],
  [0x11, 0x12, 0x17, 0x21, 0x22, 0x26, 0x27, 0x62, 0x66, 0x67, 0x71, 0x72, 0x76, 0x77],
  [0x82, 0x85, 0x86, 0x87, 0x93, 0x94, 0xa1, 0xa2, 0xa4, 0xa6, 0xa7],
  [0x32, 0x34, 0x35, 0x46, 0x81, 0x83, 0x84, 0x92, 0x95, 0x97],
];

/** The opponent of a fighter (`serf[0xe]`, a u16 in `stateData[3..4]`). */
function combatDefender(state: GameState, serf: Serf): Serf | null {
  const idx = serf.stateData[3] | (serf.stateData[4] << 8);
  return idx > 0 ? (state.serfs[idx] ?? null) : null;
}

/** Morale of a fighter on his tile: `0x1000` on own land, otherwise the gold morale. */
function combatMorale(state: GameState, serf: Serf): number {
  const pos = posOf(serf.col ?? 0, serf.row ?? 0, state.geo);
  const tileOwner = state.mapTiles[pos].owner; // 1-based, 0 = nobody
  if (tileOwner === serf.owner + 1) return 0x1000;
  const p = state.players[serf.owner];
  return p ? p.goldMorale : 0;
}

/**
 * State 45 `KnightPrepareAttacking` @0x182e5 — the **combat decision**. It waits until the defender is
 * in state 47, driving him through the dispatcher meanwhile; then attacker to 48, defender to 49, the
 * strength-weighted roll, the loser booking and the animation seed.
 */
export const knightPrepareAttacking = (state: GameState, serf: Serf): void => {
  const defender = combatDefender(state, serf);
  if (defender == null) return;
  if (defender.state !== ST_KNIGHT_PREPARE_DEFENDING) {
    dispatchSerf(state, defender); // drive the defender on until he has taken his stand (47)
    return;
  }
  serf.state = ST_KNIGHT_ATTACKING; // 48
  defender.state = ST_KNIGHT_DEFENDING; // 49
  defender.counter = 0;
  serf.counter = 0;
  serf.tick = state.gameTick;
  decideDuel(state, serf, defender);
};

/** Strength from rank and an already resolved morale. */
function strengthWith(rank: number, moral: number): number {
  return Math.trunc((u16(STRENGTH_BASE << rank) * u16(moral)) / 0x10000);
}

/**
 * The duel decision — the core of state 45 @0x182e5 **and** state 57 @0x1cdfb, byte-identical. Rolls,
 * books the loser, seeds the animation sequence, and stores the outcome in `serf[0xc]` on the attacker.
 */
function decideDuel(state: GameState, attacker: Serf, defender: Serf): void {
  const rangAtt = attacker.type - KNIGHT0;
  const rangDef = defender.type - KNIGHT0;
  const strengthAtt = strengthWith(rangAtt, combatMorale(state, attacker));
  const strengthDef = strengthWith(rangDef, combatMorale(state, defender));
  const attackerWins = attackerWinsDuel(strengthAtt, strengthDef, state.rng.next());
  attacker.stateData[1] = attackerWins ? 1 : 0; // serf[0xc] = outcome
  const loser = attackerWins ? defender : attacker;
  const loserRank = attackerWins ? rangDef : rangAtt;
  applyDuelLoss(state.players[loser.owner], loserRank);
  attacker.stateData[0] = state.rng.next() & 0x70; // serf[0xb] = start index of the strike sequence
}

/** State 47 `KnightPrepareDefending` @0x1876d — trivial: set the waiting animation. */
export const knightPrepareDefending = (_state: GameState, serf: Serf): void => {
  serf.counter = 0;
  serf.animation = 0x54;
};

/** State 49 `KnightDefending` @0x18d9d — a no-op; state 48 drives the defender along. */
export const knightDefending = (_state: GameState, _serf: Serf): void => {
 /* an empty `ret` in the original */
};

/**
 * State 48 `KnightAttacking` @0x18802 — the strike animation of both fighters plus the resolution. On
 * underflow a round loop walks the strike sequence, spending two `rng()` per round (animation pair and
 * counter increment). At the end of the sequence the loser becomes Dead and the two states split into
 * Victory (50) and Defeat (51).
 */
export const knightAttacking = (state: GameState, serf: Serf): void => {
  const defender = combatDefender(state, serf);
  if (defender == null) return;
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) {
    defender.counter = serf.counter; // keep the defender's counter in step
    return;
  }
  for (;;) {
    const seq = STRIKE_SEQ[serf.stateData[0] & 0x7f];
    if (seq & 0x80) break; // 0xff ends the sequence
    serf.stateData[0] = (serf.stateData[0] + 1) & 0xff;
    const dir = serf.stateData[1] === 0 ? 4 - seq : seq; // a winning defender mirrors the pose
    serf.stateData[2] = dir; // serf[0xd]
    const idx = Math.trunc((GRP[dir] * state.rng.next()) / 0x10000);
    const animByte = ANIM_PAIR[dir][idx];
 // @0x18cf8/@0x18d07 add 0x92 and 0x9c as bytes. Writing this as `- 0x6e` / `- 0x64` is identical
 // mod 256 but no longer matches the instructions, which is what the constants audit checks against.
    serf.animation = ((animByte >> 4) + 0x92) & 0xff;
    defender.animation = ((animByte & 0xf) + 0x9c) & 0xff;
    const inc = (state.rng.next() & 0x18) + 0x48;
    const sum = serf.counter + inc;
    serf.counter = sum & 0xffff;
    if (sum > 0xffff) {
      defender.counter = serf.counter; // the counter wrapped — the round resumes next tick
      return;
    }
  }
 // End of the sequence. The resolution branches on state 60 (open field) against 48 (at a building).
  const isFree = serf.state === ST_KNIGHT_ATTACKING_FREE;
  if (serf.stateData[1] === 0) {
 // The attacker lost.
    if (isFree) {
 // The winning defender goes to 63, his `serf[0xe]` pointing at the dead attacker so that 63 frees
 // him. The attacker's tile passes to the defender.
      const pos = posOf(serf.col ?? 0, serf.row ?? 0, state.geo);
      state.mapTiles[pos].serfIndex = serf.stateData[3] | (serf.stateData[4] << 8); // the defender
      defender.animation = 0xb4;
      defender.counter = 0;
      defender.stateData[3] = serf.index & 0xff; // defender[0xe] = the attacker
      defender.stateData[4] = (serf.index >> 8) & 0xff;
      defender.state = ST_KNIGHT_DEFENDING_VICTORY_FREE; // 63
    } else {
 // At a building the winning defender walks back in (@0x18a1c) — the same entry arithmetic as state
 // 06, but **without** the free check and **without** clearing the source tile, where the dead
 // attacker stays. `serf[0xb] = 0xff` marks him as not returning to a stock, so he rejoins the
 // garrison instead.
      const flagPos = posOf(defender.col ?? 0, defender.row ?? 0, state.geo);
      const bldTile = neighbor(flagPos, Direction.UpLeft, state.geo);
      beginEnterAnimation(state, defender, flagPos, bldTile);
      defender.stateData[0] = 0xff;
    }
    serf.animation = (serf.type + 0x98) & 0xff;
    serf.counter = 0xff;
    serf.state = ST_KNIGHT_DEFEAT; // 51
    setSerfType(serf, SERF_DEAD);
  } else {
 // The attacker won.
    if (isFree) {
 // The winner takes over his opponent's combat fields, which carry the queue of further open-field
 // attackers, and goes to 62. `serf[0xe]` still points at the dead defender.
      serf.stateData[0] = defender.stateData[2]; // serf[0xb] = opp[0xd]
      serf.stateData[1] = defender.stateData[3]; // serf[0xc] = opp[0xe]
      serf.stateData[2] = defender.stateData[4]; // serf[0xd] = opp[0xf]
    }
    defender.animation = (defender.type + 0x93) & 0xff;
    defender.counter = 0xff;
    setSerfType(defender, SERF_DEAD);
    defender.tick = state.gameTick;
    serf.animation = 0xa8;
    serf.counter = 0;
    if (isFree) {
      serf.state = ST_KNIGHT_ATTACKING_VICTORY_FREE; // 62
    } else {
      serf.state = ST_KNIGHT_VICTORY; // 50
 // The fallen defender is deregistered at the building (@0x18994): `bld[8] -= 1`, so the **lower**
 // nibble (`requested`), not `available`. That closes the booking of his sortie —
 // `engageDefendedBuilding` had computed `bld[8] -= 0xf` (available - 1, requested + 1, "replacement
 // expected"); now that he is dead the building no longer expects him back. Inventory buildings are
 // excluded (`bld[8] != 0xff`).
      const bldTile = neighbor(posOf(serf.col ?? 0, serf.row ?? 0, state.geo), Direction.UpLeft, state.geo);
      const bld = state.buildings[state.mapTiles[bldTile].objIndex];
      if (bld != null && !bld.hasInventory) {
        const raw = (((bld.stock[0].available & 0xf) << 4) | (bld.stock[0].requested & 0xf)) - 1;
        bld.stock[0] = { available: (raw >> 4) & 0xf, requested: raw & 0xf };
      }
    }
  }
};

/**
 * State 50 `KnightAttackingVictory` @0x18d9e — the winner waits out the loser's death animation, frees
 * him and returns to 44, to engage the next defender or occupy the building.
 */
export const knightAttackingVictory = (state: GameState, serf: Serf): void => {
  const defender = combatDefender(state, serf);
  if (defender == null) return;
  const delta = subU16(state.gameTick, defender.tick);
  defender.tick = state.gameTick;
  const oldCounter = defender.counter;
  defender.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return; // the defender is still dying
  freeSerf(state, defender);
  serf.stateData[3] = 0; // serf[0xe] = 0
  serf.stateData[4] = 0;
  serf.state = ST_KNIGHT_ENGAGING; // 44
  serf.tick = state.gameTick;
  serf.counter = 0;
};

/**
 * State 51 `KnightAttackingDefeat` @0x18e5a — the dead attacker plays out his death animation, then
 * clears his tile and frees himself.
 */
export const knightAttackingDefeat = (state: GameState, serf: Serf): void => {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return; // still dying
  const pos = posOf(serf.col ?? 0, serf.row ?? 0, state.geo);
  state.mapTiles[pos].serfIndex = 0;
  freeSerf(state, serf);
};

// Open-field combat resolution — states 62/63/64 @0x1ceee/@0x1cff0/@0x1d0cd. The fight itself runs
// through `knightAttacking`/`knightDefending` (60/61 reuse 48/49, see the `isFree` branch above);
// these three handlers clean up afterwards.

/**
 * State 62 `KnightAttackingVictoryFree` @0x1ceee — the open-field winner waits out the loser's death
 * animation, frees him and goes to 64. The shift through `serf[0xb..0xd]` runs a queue of further
 * open-field attackers; `serf[0xf]` says whether one is left.
 */
export const knightAttackingVictoryFree = (state: GameState, serf: Serf): void => {
  const loser = combatDefender(state, serf);
  if (loser == null) return;
  const delta = subU16(state.gameTick, loser.tick);
  loser.tick = state.gameTick;
  const oldCounter = loser.counter;
  loser.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return; // the loser is still dying
  freeSerf(state, loser);
  if (serf.stateData[0] === 0) {
    serf.stateData[4] = 0; // no further attackers
  } else {
    serf.stateData[0] = serf.stateData[1]; // the queue moves up
    serf.stateData[1] = serf.stateData[2];
    serf.stateData[2] = 0;
    serf.stateData[3] = 0;
    serf.stateData[4] = 1; // another opponent waits
  }
  serf.state = ST_KNIGHT_ATTACKING_FREE_WAIT; // 64
  serf.animation = 0xb3;
  serf.counter = 0x7f;
  serf.tick = state.gameTick;
};

/**
 * State 63 `KnightDefendingVictoryFree` @0x1cff0 — the open-field defender who won: frees the dead
 * attacker and returns to 53. It tolerates the attacker already being gone, because state 51 shares the
 * same counter with this one and whichever runs first does the freeing.
 */
export const knightDefendingVictoryFree = (state: GameState, serf: Serf): void => {
  const loser = combatDefender(state, serf); // the dead attacker
  if (loser != null) {
    const delta = subU16(state.gameTick, loser.tick);
    loser.tick = state.gameTick;
    const oldCounter = loser.counter;
    loser.counter = subU16(oldCounter, delta);
    if (delta <= oldCounter) return; // the loser is still dying
    freeSerf(state, loser);
  }
  serf.stateData[2] = 0;
  serf.stateData[3] = 0;
  serf.stateData[4] = 0;
  serf.state = ST_KNIGHT_FREE_WALKING; // 53
  serf.animation = 0xb3;
  serf.counter = 0;
  serf.tick = state.gameTick;
};

/**
 * State 64 `KnightAttackingFreeWait` @0x1d0cd — the open-field winner waits briefly, then goes to 53 for
 * the next attacker or to 25 (Lost) if none is left.
 */
export const knightAttackingFreeWait = (state: GameState, serf: Serf): void => {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return;
  serf.counter = 0;
  if (serf.stateData[4] === 0) {
    serf.state = ST_LOST; // 25
  } else {
    serf.stateData[4] = 0;
    serf.state = ST_KNIGHT_FREE_WALKING; // 53
  }
};

// The open-field engage chain — state 53 @0x1c460 (scan and engage) plus 54..59
// (@0x1c96d/@0x1c9af/@0x1ca0d/@0x1cdfb/@0x1cea0/@0x1ceed). It brings two knights in the field together;
// **state 57 is the open-field twin of 45** and shares `decideDuel`.
//
// The locomotion tail of state 53 (`FUN_0001d725` + `FUN_0001d350`) is **byte-identical** to state 16
// FreeWalking, hence the reuse of `freeWalkingCommon`.

/**
 * State 53 `KnightFreeWalking` @0x1c460 — scans the six neighbours for an enemy that is either an
 * open-field knight (state 53) or a knight merely walking past (types 22..26 in state 2). On engaging,
 * this serf becomes the defender (54) and the neighbour the attacker (55); a walking knight is also
 * booked out of his garrison. With no enemy adjacent the serf just walks on.
 */
export const knightFreeWalking = (state: GameState, serf: Serf): void => {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return;

  const geo = state.geo;
  const pos = posOf(serf.col ?? 0, serf.row ?? 0, geo);
  for (let dir = 0; dir < 6; dir++) {
    const enemyPos = neighbor(pos, dir, geo);
    const nbIdx = state.mapTiles[enemyPos].serfIndex;
    if (nbIdx === 0) continue;
    const nb = state.serfs[nbIdx];
    if (nb == null || nb.owner === serf.owner) continue;
    const nbFree = nb.state === ST_KNIGHT_FREE_WALKING;
    const nbWalkingKnight = nb.type >= KNIGHT0 && nb.type <= KNIGHT0 + MAX_RANK && nb.state === ST_WALKING;
    if (!nbFree && !nbWalkingKnight) continue;
 // Passability guard (`LAB_0001c80b`/`LAB_0001c88f`): the battleground is the **Left neighbour of the
 // enemy**. If it is blocked (paths byte bit 6), there is no engage at all — the scan ENDS and the
 // knight walks on; the original falls through to the locomotion entry and skips the remaining
 // neighbours rather than trying the next one.
    if (state.mapTiles[neighbor(enemyPos, Direction.Left, geo)].blocked) break;
    if (nbFree) {
      serf.stateData[3] = nb.stateData[0]; // self[0xe] = nb[0xb]
      serf.stateData[4] = nb.stateData[1]; // self[0xf] = nb[0xc]
      serf.stateData[2] = 1;
    } else {
 // The passing knight is booked out of the garrison he was heading for.
      decrementWalkingKnightGarrison(state, nb);
      serf.stateData[2] = 0;
    }
    serf.state = ST_KNIGHT_ENGAGE_DEFENDING_FREE; // 54
    serf.animation = 99;
    serf.counter = 0xff;
    nb.stateData[2] = dir; // nb[0xd] = direction
    nb.stateData[3] = serf.index & 0xff; // nb[0xe] = this serf
    nb.stateData[4] = (serf.index >> 8) & 0xff;
    nb.state = ST_KNIGHT_ENGAGE_ATTACKING_FREE; // 55
    return;
  }
 // No adjacent enemy, so the serf walks. The tick prologue already ran above; the multi-step budget
 // works through the counter, as in state 16.
  let guard = 0;
  while (i16(serf.counter) < 0 && serf.state === ST_KNIGHT_FREE_WALKING && guard++ < 64) {
    if (serf.col === null || serf.row === null) return;
    freeWalkingCommon(state, serf);
  }
};

/**
 * Booking an engaged walking knight out of the garrison he was heading for — `building+8 -= 1` at the
 * building that hangs off his destination flag (`nb[0xc]`, direction UpLeft). `building+8` is the
 * garrison counter `(available << 4) | requested`.
 *
 * **Untested for the inventory marker, and that is the original's doing, not an omission here.** There
 * is **no** `cmpb $0xff` before the `subb $0x1` @0x1c914, unlike at the nine places that protect the
 * marker. If the flag belongs to a **castle**, this line destroys its marker (`0xff` becomes `0xfe`) —
 * and a real save shows exactly that. Adding a marker test here would "tidy up" a documented effect.
 */
function decrementWalkingKnightGarrison(state: GameState, nb: Serf): void {
  const flagIndex = (nb.stateData[1] | (nb.stateData[2] << 8)) & 0xffff;
  const flag = state.flags[flagIndex];
  if (!flag) return;
  const c = flag.connections[Direction.UpLeft];
  if (!c || c.kind !== 'building') return;
  const bld = state.buildings[c.index];
  if (!bld || !bld.stock[0]) return;
  const raw = (((bld.stock[0].available & 0xf) << 4) | (bld.stock[0].requested & 0xf)) & 0xff;
  const dec = (raw - 1) & 0xff;
  bld.stock[0] = { available: (dec >> 4) & 0xf, requested: dec & 0xf };
}

/** State 54 `KnightEngageDefendingFree` @0x1c96d — waiting; the attacker (56) comes and fetches him. */
export const knightEngageDefendingFree = (state: GameState, serf: Serf): void => {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return;
  serf.counter = serf.counter & 0xff;
};

/** State 55 `KnightEngageAttackingFree` @0x1c9af — after the tick prologue, on to 56. */
export const knightEngageAttackingFree = (state: GameState, serf: Serf): void => {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return;
  serf.state = ST_KNIGHT_ENGAGE_ATTACKING_FREE_JOIN; // 56
  serf.animation = 0xa7;
  const old = serf.counter;
  serf.counter = addU16(old, 0xbf);
  if (old < 0xff41) serf.counter = 0;
};

/**
 * State 56 `KnightEngageAttackingFreeJoin` @0x1ca0d — the attacker goes to 57 and pulls the defender
 * onto the battle tile as state 58. The defender's move is one step in the engage direction, with the
 * walking animation `4 + 9 * dir + heightDelta` (the six bases 4/0xd/0x16/0x1f/0x28/0x31 come from the
 * `serf[0xd] << 3` switch).
 */
export const knightEngageAttackingFreeJoin = (state: GameState, serf: Serf): void => {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return;
  serf.state = ST_KNIGHT_PREPARE_ATTACKING_FREE; // 57
  serf.animation = 0xa8;
  serf.counter = 0;
  const defender = combatDefender(state, serf);
  if (defender == null) return;
  defender.state = ST_KNIGHT_PREPARE_DEFENDING_FREE; // 58

  const dir = serf.stateData[2] & 0xff; // serf[0xd], 0..5
  if (dir > 5 || defender.col === null || defender.row === null) {
    defender.tick = state.gameTick;
    return;
  }
  const geo = state.geo;
  const oldPos = posOf(defender.col, defender.row, geo);
  const newPos = neighbor(oldPos, dir, geo);
  const [dc, dr] = DIR_DELTA[dir];
  defender.stateData[0] = (defender.stateData[0] - dc) & 0xff; // remaining distance follows along
  defender.stateData[1] = (defender.stateData[1] - dr) & 0xff;
  state.mapTiles[oldPos].serfIndex = 0;
  const dH = state.mapTiles[newPos].height - state.mapTiles[oldPos].height;
  const slope = (4 + 9 * dir + dH) & 0xff;
  defender.col = colOf(newPos, geo);
  defender.row = rowOf(newPos, geo);
  defender.animation = slope;
  defender.counter = (cfa(slope) - 1) & 0xffff;
  defender.tick = state.gameTick;
};

/**
 * State 57 `KnightPrepareAttackingFree` @0x1cdfb — the **open-field twin of state 45**. It waits until
 * the defender is in 59, driving him meanwhile, then 60/61 and `decideDuel`.
 */
export const knightPrepareAttackingFree = (state: GameState, serf: Serf): void => {
  const defender = combatDefender(state, serf);
  if (defender == null) return;
  if (defender.state !== ST_KNIGHT_PREPARE_DEFENDING_FREE_WAIT) {
    dispatchSerf(state, defender); // drive the defender on (58 to 59)
    return;
  }
  serf.state = ST_KNIGHT_ATTACKING_FREE; // 60
  defender.state = ST_KNIGHT_DEFENDING_FREE; // 61
  defender.counter = 0;
  serf.counter = 0;
  serf.tick = state.gameTick;
  decideDuel(state, serf, defender);
};

/** State 58 `KnightPrepareDefendingFree` @0x1cea0 — after the tick prologue, on to 59. */
export const knightPrepareDefendingFree = (state: GameState, serf: Serf): void => {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return;
  serf.counter = 0;
  serf.state = ST_KNIGHT_PREPARE_DEFENDING_FREE_WAIT; // 59
};

/** State 59 `KnightPrepareDefendingFreeWait` @0x1ceed — an empty `ret`; 57 moves him on to 61. */
export const knightPrepareDefendingFreeWait = (): void => {
 /* no-op */
};

// Occupying a building — states 44 @0x17f6d and 52 @0x16700: the 44-to-52 transition, the transfer of
// ownership (score and counters), the owner flip of building and flag, the garrison marker and the
// winner moving in (state 4). The territory recolour at the end of @0x16700 is `recomputeTerritory`.
//
// OPEN: the exact end state of firstKnight/holder and the entry slope animation (both rendering), and
// eliminating a player whose castle falls.

const ST_KNIGHT_OCCUPY = 0x34; // 52
const BUILDING_TYPE_CASTLE = 24;

/**
 * First spiral index of the **second** ring. The original reads the table from `gs[0xc4] + 0x1c`
 * (@0x16ca8) — four-byte entries, hence index 7, which skips the centre and ring 1 (indices 1..6 are
 * exactly the six {@link DIR_DELTA} neighbours).
 */
const SPIRAL_RING2_FIRST = 7;
/**
 * Length of the second ring. `movw $0xb` @0x16c92 with `subw $0x1` / `jae` @0x16d21 runs 11, 10, ... 0
 * and only stops on the underflow, so **12** passes, not 11 — which is exactly the length of ring 2 in
 * the hex grid, and `SPIRAL_PATTERN[7..18]` are those 12 positions.
 */
const SPIRAL_RING2_COUNT = 12;
/** `cmpw $0x2` @0x16cda / `cmpw $0x5` @0x16ce0 — object values 2/3/4 (small, large, castle). */
const OBJECT_BUILDING_FIRST = 2;
const OBJECT_BUILDING_LAST = 4;

/**
 * **Burning the surroundings after a capture** — @0x16c78..@0x16d27, the tail of the non-castle branch
 * of state 52.
 *
 * Whoever takes an enemy military building burns down the buildings in the **second ring** around it.
 * The centre is the building tile: the original computes `serf[4] + gs[0x14]`, and `gs+0x14` is the
 * "one row up, one column left" delta == UpLeft. The knight stands on the flag and the building always
 * hangs UpLeft of it.
 *
 * ```
 * centre = serf.pos + UpLeft                        // @0x16c78..@0x16c8f
 * for (i = 7; i < 19; i++) {                        // base +0x1c, 12 rounds (@0x16c92/@0x16d21)
 *   p = (centre + spiral[i]) & posMask              // @0x16cb1..@0x16cc8
 *   if ((landscape[p+3] & 0x7f) - 2 > 2) continue   // @0x16cda/@0x16ce0
 *   demolish_building(col(p), row(p))               // @0x16d1c
 * }
 * ```
 *
 * **The burning is owner-blind**, and that is read rather than overlooked: the only condition in the
 * loop is the object range, and the head of `demolish_building` @0x48eb8 tests only `bt $0x5` (already
 * burning) and then the building type. One's own building in ring 2 burns along. Rare in practice,
 * because ring 2 around an enemy military building is usually enemy ground — but not impossible.
 *
 * It runs **before** the footprint owner writes and the recolour. The order does not matter here (the
 * loop reads no owners), but staying close to the original is cheaper than arguing why.
 */
function burnSurroundingRing(state: GameState, center: number): void {
  for (let i = SPIRAL_RING2_FIRST; i < SPIRAL_RING2_FIRST + SPIRAL_RING2_COUNT; i++) {
    const p = spiralPos(center, i, state.geo);
    const object = state.mapTiles[p].object;
    if (object < OBJECT_BUILDING_FIRST || object > OBJECT_BUILDING_LAST) continue;
    const bld = state.buildings[state.mapTiles[p].objIndex];
    if (bld) demolishBuilding(state, bld); // @0x16d1c
  }
}
const MILITARY_TYPES: ReadonlySet<number> = new Set([11, 21, 22, 24]); // hut/tower/fortress/castle

/** The tick prologue; true means the counter has not run out yet and the handler is done. */
function tickProlog(state: GameState, serf: Serf): boolean {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  return delta <= oldCounter;
}

/** The building UpLeft of the knight's flag — a building always hangs UpLeft of its flag. */
function buildingAtEngagedFlag(state: GameState, serf: Serf): { bld: Building; pos: number } | null {
  const geo = state.geo;
  const serfPos = posOf(serf.col ?? 0, serf.row ?? 0, geo);
  const bldPos = neighbor(serfPos, Direction.UpLeft, geo);
  const tile = state.mapTiles[bldPos];
  if (tile.object < 2 || tile.object > 4) return null;
  const bld = state.buildings[tile.objIndex];
  return bld == null ? null : { bld, pos: bldPos };
}

/**
 * State 44 `KnightEngagingBuilding` @0x17f6d — the winner stands at the target flag. If the enemy
 * military building still has a garrison he queues up for the next duel; if it is **empty** he moves on
 * to occupying it (52).
 */
export const knightEngagingBuilding = (state: GameState, serf: Serf): void => {
  if (tickProlog(state, serf)) return;

  const hit = buildingAtEngagedFlag(state, serf);
  if (
    hit != null &&
 // `bld[4] & 0xfc` in {0x2c,0x54,0x58,0x60} (@0x17fb1): the mask leaves bit 7 standing, so a building
 // **under construction** matches no comparison value. For the four types `type << 2` is exactly that
 // set, which makes the decoded form equivalent. The original does **not** test for fire here.
    MILITARY_TYPES.has(hit.bld.type) &&
    !hit.bld.constructing &&
    hit.bld.owner !== serf.owner &&
    hit.bld.firstKnight !== 0
  ) {
    engageDefendedBuilding(state, serf, hit.bld, hit.pos);
    return;
  }
 // Empty, or not an enemy military building at all — start occupying.
  serf.state = ST_KNIGHT_OCCUPY; // 52
  serf.animation = 0xb3;
  serf.counter = 0x7f;
  serf.tick = state.gameTick;
};

/**
 * The **failure tail** of state 52 (@0x16a13) — three stores, no call to `set_lost_state`.
 *
 * **Every** failure of the routine ends here rather than in a silent `ret`: no building on the tile
 * (@0x16762/@0x1676c), the building is burning (@0x167bf), not a military or castle type (@0x167e8),
 * one's own **castle** (@0x16871), and one's own building already **full** (@0x168bd). A `return` at
 * those spots leaves a knight whose target burned down standing on the flag tile forever.
 */
function occupyLost(serf: Serf): void {
  serf.state = 25; // Lost
  serf.stateData[0] = 0;
  serf.counter = 0;
}

/**
 * The **absolute** garrison capacity per military type (@0x16876 / @0x16882 / @0x1688e). This is
 * **not** the target occupancy of the knight menu (`MILITARY_OCCUPANCY`) but the hard limit: a knight
 * following up fills to the brim regardless of the setting. The **castle** is deliberately missing —
 * its branch falls through to @0x16a13.
 */
const OCCUPY_CAPACITY: ReadonlyMap<number, number> = new Map([
  [11, 3], // hut      (bld[4] & 0xfc == 0x2c)
  [21, 6], // tower    (0x54)
  [22, 12], // fortress (0x58)
]);

/**
 * **A knight following up** — the `je 0x16852` branch of state 52. It applies as soon as the target
 * building **already belongs** to the knight: exactly the situation of the second, third, ... wave of
 * an attack after the first one captured it.
 *
 * ```
 * capacity = {0x2c:3, 0x54:6, 0x58:12}[bld[4] & 0xfc]      // otherwise @0x16a13 (Lost)
 * if ((bld[8] & 0xf) + ((bld[8] & 0xf0) >> 4) >= capacity)  -> @0x16a13
 * game[flagPos].serf = 0 ; bld[8] += 1 ; <entry> ; serf[0xb] = 0xff
 * ```
 *
 * The entry arithmetic is byte-identical to {@link beginEnterAnimation} — in the binary the **third**
 * copy of the same block, next to state 06 and the combat resolution 48. The only differences are the
 * `serf[0xb] = 0xff` @0x16a08 and that it does **not** check whether the building tile is free (the
 * predecessor is already inside).
 *
 * `bld[8] += 1` counts him as **requested**; on arrival `knightGarrisonEnter` turns the nibble pair
 * with `+= 0x0f` into "one more present, one fewer on the way". The height of the occupation flag
 * hangs off exactly that.
 */
function reinforceOwnBuilding(state: GameState, serf: Serf, bld: Building, bldPos: number): void {
  const capacity = OCCUPY_CAPACITY.get(bld.type);
  if (capacity === undefined) return occupyLost(serf); // one's own castle (@0x16871)
  const s0 = bld.stock[0];
  const filled = (s0.available & 0xf) + (s0.requested & 0xf);
  if (filled >= capacity) return occupyLost(serf); // `jae 0x16a13` @0x168bd
  if (serf.col === null || serf.row === null) return;

  const here = posOf(serf.col, serf.row, state.geo);
  state.mapTiles[here].serfIndex = 0; // @0x168d3
  const raw = (((s0.available & 0xf) << 4) | (s0.requested & 0xf)) + 1; // `addb $0x1,0x8` @0x1699c
  bld.stock[0] = { available: (raw >> 4) & 0xf, requested: raw & 0xf };
  beginEnterAnimation(state, serf, here, bldPos);
  serf.stateData[0] = 0xff; // @0x16a08
}

/**
 * State 52 `KnightOccupyEnemyBuilding` @0x16700 — the winner occupies the captured building.
 *
 * The routine has **two** branches at the owner comparison (`cmp %al,0x8(%edi) ; je 0x16852` @0x1680a):
 * a foreign building means capture (below), one's **own** means {@link reinforceOwnBuilding}.
 */
export const knightOccupyEnemyBuilding = (state: GameState, serf: Serf): void => {
  if (tickProlog(state, serf)) return;

  const hit = buildingAtEngagedFlag(state, serf);
  if (hit == null) return occupyLost(serf); // @0x16762/@0x1676c
  const { bld, pos: bldPos } = hit;
  if (bld.burning) return occupyLost(serf); // `bt $0x5` @0x167b5
 // @0x167d2..@0x167e8 — the mask keeps bit 7, so a building under construction matches nothing.
  if (!MILITARY_TYPES.has(bld.type) || bld.constructing) return occupyLost(serf);
  if (bld.owner === serf.owner) return reinforceOwnBuilding(state, serf, bld, bldPos);

  if (bld.firstKnight !== 0) {
 // still defended — back to 44
    serf.animation = 0xa7;
    serf.counter = 0xbf;
    serf.state = ST_KNIGHT_ENGAGING; // 44
    serf.tick = state.gameTick;
    return;
  }

 // The two messages, sent @0x16700 before the type split, so for EVERY captured building type: type
 // 2 to the loser with the building's position, type 3 to the winner with his own. In both cases the
 // upper nibble is the attacker's player index — the type-dependent parameter of the message byte.
  const loser = state.players[bld.owner];
  const winner = state.players[serf.owner];
  const attackerParam = (serf.owner & 3) << 5;
  if (loser != null) addPlayerMessage(loser, attackerParam + 2, bldPos);
  if (winner != null) addPlayerMessage(winner, attackerParam + 3, posOf(serf.col ?? 0, serf.row ?? 0, state.geo));

  if (bld.type === BUILDING_TYPE_CASTLE) {
 // A captured **castle** (@0x16b90) is not taken over but burned down: the winner books
 // `castleCaptureBalance += 1` (a permanent morale boost) and then demolishes. The demolition's own
 // castle branch takes the loser's `build` bit 3 and the counter-booking. The knight stays where he
 // is — the branch ends in `ret`.
    serf.counter = 0; // @0x16b3f
    if (winner != null) {
      winner.castleCaptureBalance = ((winner.castleCaptureBalance + 1) << 16) >> 16; // i16
    }
    demolishBuilding(state, bld);
    return;
  }

 // Everything in transit to the building's flag belonged to the old owner and loses its destination
 // here (@0x16bac). In the original this stands **before** the score transfer.
  cancelTransportOnDelete(state, bld.flag);

 // The transfer of ownership, inline @0x16700. The **7** of the land score (`subl $0x7` @0x16c1d /
 // `addl $0x7` @0x16c64) is the building footprint: the tile plus its six hex neighbours, which are
 // written to the new owner further down anyway — the recolour no longer counts them, because by then
 // it sees no owner change there.
  const score = BUILDING_SCORE[bld.type] ?? 0;
  const j = bld.type - 1; // completedBuildingCount is indexed by type - 1
  const oldOwner = state.players[bld.owner];
  const newOwner = state.players[serf.owner];
  if (oldOwner) {
    oldOwner.totalBuildingScore -= score;
    oldOwner.totalLandScore = (oldOwner.totalLandScore - 7) >>> 0; // @0x16c1d
    (oldOwner.completedBuildingCount as number[])[j] -= 1;
  }
  if (newOwner) {
    newOwner.totalBuildingScore += score;
    newOwner.totalLandScore = (newOwner.totalLandScore + 7) >>> 0; // @0x16c64
    (newOwner.completedBuildingCount as number[])[j] += 1;
  }

  burnSurroundingRing(state, bldPos);

  const flag = state.flags[bld.flag];
  if (flag) {
    flag.owner = serf.owner; // @0x16e9b

 // The goods lying on the captured flag lose their destination (@0x16ea8..@0x16efa), eight slots in
 // **descending** order. The entry point is explicitly `0x4a3af`, so **without** the gold deduction:
 // the goods stay where they are and merely change owner, and the resource **type** is untouched.
    for (let i = 7; i >= 0; i--) {
      const res = flag.resourceSlots[i];
      if (res == null || res < 0) continue; // raw byte 0 means empty, which is -1 in our model
      const dest = flag.slotDest[i];
      (flag.slotDest as number[])[i] = 0; // @0x16eeb
      returnTransitResourceToStock(state, res + 1, dest); // the raw byte is type + 1
    }

 // The roads of the captured flag are torn down (@0x16efc..@0x16f92), six directions **descending**,
 // each starting from the **neighbour** tile. `serf[4]` is still the flag tile here — the winner only
 // moves into the building further down. The captured building is left unconnected: its new owner has
 // to attach it to the road network himself.
    const flagPos = posOf(serf.col ?? 0, serf.row ?? 0, state.geo);
    for (let d = 5; d >= 0; d--) {
      if (!flag.paths[d]) continue;
      const np = neighbor(flagPos, d as Direction, state.geo);
      clearRoadPaths(state, colOf(np, state.geo), rowOf(np, state.geo));
    }
  }
  bld.owner = serf.owner; // the type is untouched
  bld.stock[0] = { available: 0, requested: 1 }; // building+8 = 1

 // The winner moves in (state 4).
  const serfPos = posOf(serf.col ?? 0, serf.row ?? 0, state.geo);
  state.mapTiles[serfPos].serfIndex = 0;
  serf.col = colOf(bldPos, state.geo);
  serf.row = rowOf(bldPos, state.geo);
  state.mapTiles[bldPos].serfIndex = serf.index;
  serf.state = ST_ENTERING_BUILDING; // 4
  serf.stateData[0] = 0xff;
  serf.tick = state.gameTick;
 // OPEN: the exact entry slope animation and counter, and the firstKnight/holder wiring.
  serf.counter = 0;

 // **Before** the recolour the original writes the owner byte of the building tile and its six hex
 // neighbours directly to the new owner. That **protects the captured building and its ring** from
 // being seen as an owner LOSS by the recolour and burned down by the lost-tile handler: after the
 // pre-write their old owner already is the new one, so no loss event occurs. Without it the lost-tile
 // handler burns down the building that was just captured. `tile.owner` is 1-based.
  const geo = state.geo;
  const footprint = [
    bldPos,
    neighbor(bldPos, Direction.Right, geo),
    neighbor(bldPos, Direction.DownRight, geo),
    neighbor(bldPos, Direction.Down, geo),
    neighbor(bldPos, Direction.Left, geo),
    neighbor(bldPos, Direction.UpLeft, geo),
    neighbor(bldPos, Direction.Up, geo),
  ];
  for (const p of footprint) state.mapTiles[p].owner = serf.owner + 1;

 // The territory recolour, centred on the building. It re-stamps the influence of every active
 // military building — the captured one now with its new owner — and reassigns `tile.owner` in the
 // 16x16 window, which is what makes the takeover visible.
  recomputeTerritory(state, colOf(bldPos, geo), rowOf(bldPos, geo));

 // The AI loss register (@0x171a3). Right behind the recolour the original tests `player+2` bit 7 of
 // the **old** owner and, for an AI loser, records the map spot in the first free of the eight slots
 // `player+0x1bc`. A slot is free while its u32 is negative, so `row >= 0x8000`. A **human** loser
 // triggers nothing, and with all eight slots taken the entry is dropped (@0x171f5 jumps past the
 // store). The consumer is the AI road-network task, which tries to reattach each recorded spot and
 // clears the slot afterwards.
  if (oldOwner !== undefined && oldOwner !== null && (oldOwner.flags & 0x80) !== 0) {
    const reg = oldOwner.aiLossRegister;
    if (reg !== undefined) {
      for (const slot of reg) {
        if ((slot.row & 0x8000) === 0) continue; // @0x171e6 — occupied
        slot.col = colOf(bldPos, geo); // @0x17238
        slot.row = rowOf(bldPos, geo); // @0x17242
        break;
      }
    }
  }
};

// State 65 KnightLeaveForWalkToFight — the knight steps out of his military building to attack. It is
// the target state of `dispatchAttackers`.

/** Defence state and target occupancy per military type (@0x24622/@0x24636/@0x2464a). */
const SORTIE_RETURN: ReadonlyMap<number, { readonly capacity: number; readonly state: number }> =
  new Map([
    [0x2c, { capacity: 3, state: 0x46 }], // hut      -> 70 DefendingHut
    [0x54, { capacity: 6, state: 0x47 }], // tower    -> 71 DefendingTower
    [0x58, { capacity: 0xc, state: 0x48 }], // fortress -> 72 DefendingFortress
  ]);

/**
 * **State 65 `KnightLeaveForWalkToFight`** @0x24528. No tick prologue — the handler retries stepping out
 * every tick.
 *
 * Preconditions and exit are the **same jump targets** as state 07 ({@link stepOutToFlagMove}
 * @0x2473b, {@link blockedWaitOut} @0x24870); state 65 jumps into exactly those blocks. The difference
 * is **one extra branch**: with a **foreign** serf standing on the flag tile, the knight returns into
 * the garrison instead of waiting.
 *
 * ```
 * if (serfAt(pos) != me && serfAt(pos) != 0)      -> blocked (@0x24870)
 * flag = pos + DownRight
 * if (serfAt(flag) == 0)                          -> step out (@0x2473b), state 5, then 53
 * if (((serfAt(flag)[0] ^ me[0]) & 3) == 0)       -> blocked (own serf in the way)
 * coded = bld[4] & 0x7c                           // 0x7c, NOT 0xfc as in the dispatch
 * (capacity, defState) = {0x2c:(3,70), 0x54:(6,71), 0x58:(12,72)} ; else serf[10] = 0, ret
 * if (capacity != (bld[8] low + bld[8] high)) {   // room left in the garrison
 *   bld[8] += 0x10 ; serf[0xe] = bld[10] ; bld[10] = me ; serf[10] = defState ; ret
 * }
 * -> blocked (@0x24870)
 * ```
 *
 * The return branch sets **neither animation nor counter** — the knight keeps both and carries on in
 * the guard idle with his old counter.
 */
export const knightLeaveForWalkToFight = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const here = posOf(serf.col, serf.row, geo);

  const slotHere = state.mapTiles[here].serfIndex;
  if (slotHere !== serf.index && slotHere !== 0) return blockedWaitOut(serf);

  const flagTile = neighbor(here, Direction.DownRight, geo);
  const occupant = state.mapTiles[flagTile].serfIndex;
  if (occupant === 0) return stepOutToFlagMove(state, serf, here, flagTile);

 // Flag tile taken: an own serf means wait, a foreign one means back into the garrison.
  const other = state.serfs[occupant];
  if (other == null || ((other.owner ^ serf.owner) & 3) === 0) return blockedWaitOut(serf);

  const bld = state.buildings[state.mapTiles[here].objIndex];
  if (bld == null) return blockedWaitOut(serf);
 // Mask 0x7c, not 0xfc: the construction bit is masked out here, so a building under construction
 // does match its type.
  const ret = SORTIE_RETURN.get((bld.type << 2) & 0x7c);
  if (ret === undefined) {
    serf.state = 0; // @0x24619 — not a military building; the original treats this as impossible
    return;
  }
 // No fire test in this branch (@0x2465a goes straight to `bld[8]`); that one is in the dispatch.
  const s0 = bld.stock[0];
  if (ret.capacity === (s0.available & 0xf) + (s0.requested & 0xf)) return blockedWaitOut(serf);

  bld.stock[0] = { available: (s0.available + 1) & 0xf, requested: s0.requested }; // bld[8] += 0x10
  setUnionU16(serf, 0xe, bld.firstKnight); // hook into the garrison list
  bld.firstKnight = serf.index;
  serf.state = ret.state;
};

// State 46 KnightLeaveForFight — the DEFENDER steps out of his building to fight, the counterpart to
// state 65 on the attacker's side.

/**
 * **State 46 `KnightLeaveForFight`** @0x18606. No tick prologue.
 *
 * Two differences from the attacker's exit (state 65) and from state 07:
 * 1. **Blocked here means doing nothing at all.** With a foreign serf on his own tile the routine
 *    returns without effect (`jne 0x1876c` is a bare `ret`) — **no** waiting animation `0x52`.
 * 2. **The target tile is neither checked nor claimed.** The defender clears his building tile and
 *    takes over the flag position but does **not** register there — the attacker is standing on it,
 *    and the fight happens on that one tile.
 *
 * The rest is the shared tail {@link beginExitAnimation}; the follow-up state 47 already sits in
 * `serf[0xf]`, put there by {@link knightEngagingBuilding}.
 */
export const knightLeaveForFight = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const here = posOf(serf.col, serf.row, geo);

  const slotHere = state.mapTiles[here].serfIndex;
  if (slotHere !== serf.index && slotHere !== 0) return; // blocked — no effect, no 0x52

  const flagTile = neighbor(here, Direction.DownRight, geo);
  state.mapTiles[here].serfIndex = 0; // clear only the own tile, do NOT claim the target
  beginExitAnimation(state, serf, here, flagTile);
};

/**
 * **The defender branch of state 44** — @0x17f6d, body @0x17fd4..@0x1819a. The attacker stands at the
 * flag of an **occupied** foreign military building:
 *
 * ```
 * if (bld[0xc] & 1) {                  // progress bit 0 = "attack announced"
 *   bld[0xc] &= 0xfe
 *   add_player_message(((serf[0] & 3) << 5) + 1, bld.pos, bld[4] & 3)
 * }
 * serf[2] = 0 ; serf[10] = 0x2d (45) ; serf[1] = 0xa8
 * if (bld[8] == 0xff) player[bldOwner][0x18c] -= 1   // inventory building
 * else bld[8] -= 0xf                                  // 0xf, NOT 0x10
 * serf[0xe] = lastKnight ; def[10] = 0x2e (46) ; def[0xf] = 0x2f (47)
 * ```
 *
 * Three things that are easy to get wrong:
 * - **`bld[8] -= 0xf`, not `-= 0x10`.** The subtraction lowers the upper nibble (`available`) **and**
 *   raises the lower one (`requested`) — the departing defender asks for a replacement right away.
 * - **The LAST knight of the chain goes**, not the head and **not** the best by rank. Unlike the
 *   dispatch (`takeGarrisonKnight`), `flags` bit 1 plays no part here.
 * - The defender goes to **46**, not straight to 5.
 *
 * **No fire test** — the original does not check `bld[5]` bit 5 in this chain. In a burning building
 * `bld[10]` is repurposed as the burn-down counter, so the original would read it as a knight index: a
 * wild access that does not crash but yields nonsense. The port does **not** emulate that misstep; it
 * bails out when the chain points at a free slot. That is the one deliberate deviation here.
 */
function engageDefendedBuilding(
  state: GameState,
  serf: Serf,
  bld: Building,
  bldPos: number,
): void {
 // A one-shot signal: only the first arriving attacker triggers the message.
  if ((bld.progress & 1) !== 0) {
    bld.progress &= ~1;
    const defender = state.players[bld.owner];
    if (defender != null) addPlayerMessage(defender, ((serf.owner & 3) << 5) + 1, bldPos);
  }

  serf.counter = 0;
  serf.state = ST_KNIGHT_PREPARE_ATTACKING; // 45
  serf.animation = 0xa8;

  if (bld.hasInventory) {
    const owner = state.players[bld.owner];
    if (owner != null) owner.knightMenuCounter = (owner.knightMenuCounter - 1) & 0xffff;
  } else {
    const s0 = bld.stock[0];
    const raw = (((s0.available & 0xf) << 4) | (s0.requested & 0xf)) - 0xf;
    bld.stock[0] = { available: (raw >> 4) & 0xf, requested: raw & 0xf };
  }

 // Walk to the last entry of the chain; `prev` holds the pointer to it.
  let prev = -1; // -1 means the head `bld.firstKnight` itself
  let cur = bld.firstKnight;
  for (;;) {
    const s = state.serfs[cur];
    if (s == null) return; // see the note about burning buildings above
    const next = unionU16(s, 0xe);
    if (next === 0) break;
    prev = cur;
    cur = next;
  }
  if (prev < 0) bld.firstKnight = 0;
  else setUnionU16(state.serfs[prev]!, 0xe, 0);

 // `*(u16*)(serf + 0xe) = def` — on the attacker this deliberately overwrites `serf[0xf]` too.
  setUnionU16(serf, 0xe, cur);
  const def = state.serfs[cur]!;
  def.state = ST_KNIGHT_LEAVE_FOR_FIGHT; // 46
  def.stateData[4] = ST_KNIGHT_PREPARE_DEFENDING; // serf[0xf] = 47 als Folgezustand
}
