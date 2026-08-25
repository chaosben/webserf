/**
 * The AI's attack task - `FUN_00053a09`, slots 4 and 12 of the subtask table: the point where the AI
 * stops merely recording attack targets and starts sending knights. It is the consumer of the
 * candidate rows 26..34 that branch B of the probe fills.
 *
 * ```
 * 1  probability gate      - superior? else roll, else only probe
 * 2  row maxima            - per target kind the best stored score
 * 3  shortage weighting    - scale the four deposits by OWN need
 * 4  preference mask       - character trait, quadruples preferred kinds
 * 5  pick the target kind  - coin flip: roulette OR maximum
 * 6  find the target tile  - best candidate of the row, filtered and rescored
 * 7  attack                - estimate resistance, count knights, dispatch
 * ```
 *
 * Four things the sequence alone does not show:
 *
 * 1. The superior player does NOT roll - the original jumps past the random draw. For the random
 *    stream that is a difference "chance = maximum, then roll and always win" does not reproduce.
 * 2. The scoring table ends exactly at the function entry, which pins its length and index range
 *    without reading a line of code.
 * 3. The knight weighting skips rank 0: `8*K4 + 8*K3 + 4*K2 + K1`. That only shows when the five
 *    additions with their doublings are read in order; in the decompilation they are a chain of
 *    carry blocks and the structure is invisible.
 * 4. The re-scan in step 6 is structurally unreachable - it compares against a slot zeroed two
 *    instructions earlier, the same shape as the build executor's re-scan. It stands in the port
 *    anyway, as evidence it was read.
 *
 * The task does not dispatch the knights itself but calls the two routines of the HUMAN attack path,
 * merely filling {@link Player.knightsAttacking} itself instead of having it set in the window.
 */
import type { GameState, Player, Building } from './state.js';
import { hasInventoryMarker } from './building-tables.js';
import { u16 } from './int.js';
import { posOf } from './position.js';
import { SPIRAL_PATTERN } from './spiral.js';
import { unionU16, setUnionU16 } from './serf-machine.js';
import { aiProbeMap } from './ai-probe.js';
import { aiSurveySurroundings } from './ai-survey.js';
import { scoreAttackTarget, AI_ATTACK_FIRST } from './ai-score.js';
import {
  ATTACKABLE_CODED_TYPES,
  ATTACK_RANGE_FIRST_SPIRAL,
  ATTACK_RANGE_SPIRAL_COUNT,
  codedBuildingType,
  dispatchAttackers,
  prepareAttack,
} from './attack.js';

/** Candidate row of the first attack target kind (`add $0x914,%esi` @0x53bad, `0x434 + 26 * 48`). */
export const AI_ATTACK_FIRST_ROW = 26;
/** Nine target kinds — weapons, tools, gold, food, building material, and the four deposits. */
export const AI_ATTACK_ROW_COUNT = 9;
/** Eight slots per row (`mov $0x7` @0x53bc9, `subw`+`jae` => 8 passes). */
const SLOTS_PER_ROW = 8;

/**
 * **Scoring table of the probability gate** — `@0x539e7`, 17 x u16, indexed by
 * {@link Player.aiKnightOccupationLevel}. It ends **exactly** at the function entry
 * (`0x539e7 + 34 == 0x53a09`), which pins length and index range in one go.
 */
export const AI_ATTACK_OCCUPATION_TABLE: readonly number[] = [
  500, 700, 1000, 1400, 1900, 2500, 3000, 3500, 4096,
  5000, 7000, 10000, 15000, 21000, 28000, 36000, 45000,
];

/** Saturating 16-bit addition — in the original an `add` + `jb/jae` onto `mov $0xffffffff`. */
const satAdd16 = (a: number, b: number): number => (a + b > 0xffff ? 0xffff : u16(a + b));
/** Saturating 16-bit subtraction — `sub` + `jae`, otherwise `mov $0x0`. */
const satSub16 = (a: number, b: number): number => (a < b ? 0 : u16(a - b));
/** `rorl $0x10` — the high/low word swap with which the original fetches the upper half. */
const ror32_16 = (v: number): number => (((v >>> 16) | (v << 16)) >>> 0);

/** Resource indices the shortage weighting reads (census blocks 1070/1072/1076/1078). */
const RES_STONE = 9;
const RES_IRON_ORE = 10;
const RES_COAL = 12;
const RES_GOLD_ORE = 13;
/** Serf types Knight0..Knight4 — `serfCount` index 22..26 (`player-0xe` … `player-6`). */
const SERF_KNIGHT0 = 22;

/**
 * **Step 1 — the probability gate** (@0x53a09…@0x53ba3). Returns the 32-bit chance; the decision itself
 * is made by the caller, because the superior player **does not roll** (point 1 in the module head) and
 * the random stream depends on that.
 */
export function aiAttackChance(player: Player): number | 'certain' {
  const ratio = player.militaryStrengthRatio;
  if (ratio >= 0x8000) return 'certain'; // `cmpw $0x8000 ; jb` @0x53a16 — the else branch skips the rng

  // @0x53a2b: below 0x2000 halve, above it double spread around 0x2000.
  let v = ratio < 0x2000 ? ratio >>> 1 : u16(u16((ratio - 0x2000) * 2) + 0x1000);

  // @0x53a4a: character/occupation factor from the table before the entry, then `>> 12`.
  const occ = AI_ATTACK_OCCUPATION_TABLE[player.aiKnightOccupationLevel] ?? 0;
  let acc = Math.floor((v * occ) / 0x1000); // `shrl $0x8` + `shrl $0x4` @0x53a8d
  if (acc > 0xffff) acc = 0xffffffff; // `cmpl $0x10000 ; jb` @0x53a93

  // @0x53aa5: the knight weighting. Order matters — see point 3 in the module head.
  const sc = player.serfCount;
  let w = satAdd16(sc[SERF_KNIGHT0 + 4] ?? 0, sc[SERF_KNIGHT0 + 3] ?? 0); // K4 + K3
  w = satAdd16(w, w); // @0x53abc
  if (w !== 0xffff) {
    w = satAdd16(w, sc[SERF_KNIGHT0 + 2] ?? 0); // + K2, @0x53ac9
    if (w !== 0xffff) w = satAdd16(w, w); // @0x53ad3
    if (w !== 0xffff) w = satAdd16(w, w); // @0x53add
    if (w !== 0xffff) w = satAdd16(w, sc[SERF_KNIGHT0 + 1] ?? 0); // + K1, @0x53aea
  }
  // @0x53af8: only a small force dampens — `cmpw $0x100 ; jae` skips otherwise.
  if (w < 0x100) acc = Math.floor((u16(acc) * w) / 0x100);

  // @0x53b1b: the more sluggish the character, the larger the factor (`0xffff - rate`, halved, + 0x8000).
  const pace = u16(u16(u16(0xffff - player.aiRate) >>> 1) + 0x8000);
  let p = (u16(acc) * pace) >>> 0; // `mul %cx` @0x53b45 — full 32 bits
  p = p + p > 0xffffffff ? 0xffffffff : (p + p) >>> 0; // @0x53b55
  p = ror32_16(p); // @0x53b62 — from here the UPPER half counts
  p = (u16(p) * player.aiAttackChanceFactor) >>> 0; // @0x53b75
  p = ror32_16(p); // @0x53b83
  const lo = u16(p) + u16(p); // @0x53b89
  return lo > 0xffff ? 0xffffffff : ((p & 0xffff0000) | lo) >>> 0;
}

/**
 * **Steps 2 to 4** — per target kind the best stored score, weighted by one's own resource shortage and
 * quadrupled by the character's preference (@0x53baa…@0x53e6b).
 *
 * The three shortage formulas read cleanly: an enemy **gold** deposit is worth the more the more coal
 * and the less gold ore I have (without coal I cannot smelt it); for **iron** the same coupling without
 * the halving, for **coal** the other way round. The fourth term (stone) has **no** subtraction — it
 * grows with one's own stone stock (@0x53da4…@0x53db1). That is how it stands in the binary and it is
 * reproduced, not straightened out.
 */
export function aiAttackRowWeights(player: Player): number[] {
  const out: number[] = [];
  for (let r = 0; r < AI_ATTACK_ROW_COUNT; r++) {
    const slots = player.aiCandidates[AI_ATTACK_FIRST_ROW + r] ?? [];
    let max = 0;
    for (let s = 0; s < SLOTS_PER_ROW; s++) {
      const sc = slots[s]?.score ?? 0;
      if (max < sc) max = sc; // `cmp %ax,0x8(%edi) ; jae` @0x53bdf
    }
    out[r] = max;
  }

  const st = player.aiStockpile;
  /**
   * The shared tail of all four terms: **clamp first, then** add the base, then shift and multiply by
   * the row maximum. The order is not arbitrary — in the original `addw $0x32` @0x53c5b sits **behind**
   * `cmpw $0x190` @0x53c4d.
   */
  const scale = (idx: number, need: number, bonus: number, shift: number): void => {
    let n = need > 400 ? 400 : need; // `cmpw $0x190 ; jb` @0x53c4d
    n = u16(u16(n + bonus) << shift);
    const v = Math.floor((n * (out[idx] ?? 0)) / 0x1000); // `shrl $0x8` + `shrl $0x4` @0x53c7e
    out[idx] = v > 0xffff ? 0xffff : v; // `cmpl $0x10000 ; jb` @0x53c84
  };
  const coal = st[RES_COAL] ?? 0;
  const iron = st[RES_IRON_ORE] ?? 0;
  const gold = st[RES_GOLD_ORE] ?? 0;
  // gold deposit (@0x53c1a): coal halved + 100, minus gold ore, clamped, + 50, `<< 6`.
  scale(5, satSub16(satAdd16(coal >>> 1, 100), gold), 50, 6);
  // iron deposit (@0x53c9d): coal + 100, minus iron ore, `<< 6`.
  scale(6, satSub16(satAdd16(coal, 100), iron), 0, 6);
  // coal deposit (@0x53d19): iron ore + gold ore + 50, minus coal, `<< 5`.
  scale(7, satSub16(satAdd16(satAdd16(iron, gold), 50), coal), 0, 5);
  // stone deposit (@0x53da4): only one's own stone stock, clamped to 300, `<< 5`.
  // NO subtraction — the term grows with one's own stock. That is how it stands in the binary.
  scale(8, Math.min(st[RES_STONE] ?? 0, 300), 0, 5);

  // @0x53db8: the preference mask — bit i => quadruple row 26+i with saturation.
  for (let i = 0; i < AI_ATTACK_ROW_COUNT; i++) {
    if (((player.aiAttackTargetMask >>> i) & 1) === 0) continue; // `bt` @0x53de1
    let v = satAdd16(out[i] ?? 0, out[i] ?? 0); // @0x53df9
    if (v !== 0xffff) v = satAdd16(v, v); // @0x53e4a
    out[i] = v;
  }
  return out;
}

/**
 * **Step 5 — pick the target kind** (@0x53e6d…@0x53ff6). A coin flip decides between **roulette**
 * (bit 0 clear) and **maximum** (bit 0 set); `null` means nothing is to be gained.
 *
 * The roulette sums the nine weights; if the sum overflows, **all nine are halved** and it starts over
 * (@0x53f2a) — which is why it is a loop and not a formula.
 */
export function aiAttackPickRow(weights: number[], roll: number): number | null {
  if ((roll & 1) !== 0) {
    // maximum @0x53f9a — the FIRST highest value wins (`jae` skips on a tie).
    let best = 0;
    let bestIdx = 0;
    for (let i = 0; i < AI_ATTACK_ROW_COUNT; i++) {
      const v = weights[i] ?? 0;
      if (best < v) { best = v; bestIdx = i; }
    }
    return best === 0 ? null : AI_ATTACK_FIRST_ROW + bestIdx; // `or %ax,%ax ; je` @0x53fe4
  }
  for (;;) {
    let sum = 0;
    let overflow = false;
    for (let i = 0; i < AI_ATTACK_ROW_COUNT; i++) {
      const v = weights[i] ?? 0;
      if (sum + v > 0xffff) { overflow = true; break; } // `jb` @0x53eb2 — an overflow aborts
      sum = u16(sum + v);
    }
    if (overflow) {
      for (let i = 0; i < AI_ATTACK_ROW_COUNT; i++) weights[i] = (weights[i] ?? 0) >>> 1; // @0x53f2a
      continue;
    }
    if (sum === 0) return null; // @0x53ec9 — nothing to gain, the caller probes
    const pick = ((sum * u16(roll)) >>> 16) & 0xffff; // `mul` + `rorl $0x10` @0x53ed7
    let acc = 0;
    for (let i = 0; i < AI_ATTACK_ROW_COUNT; i++) {
      acc = u16(acc + (weights[i] ?? 0)); // @0x53fc3
      if (pick < acc) return AI_ATTACK_FIRST_ROW + i; // `jb` @0x53fcf
    }
    // All nine used up without passing the mark: the original takes the last index (`vreg3` then
    // stands at 8, @0x53fb1 adds 0x1a). Reachable only at `pick == sum - 1`.
    return AI_ATTACK_FIRST_ROW + AI_ATTACK_ROW_COUNT - 1;
  }
}

/** Result of the target search: the building found, or `null` when the row runs empty. */
interface Target { building: Building; }

/**
 * A candidate slot as the row holds it. `gs+0x254` (the pointer to the just-consumed slot) and
 * `gs+0x27a` (the row) are **shared scratch fields** in the original — carried as parameters here, as
 * in {@link ./ai-execute.ts}.
 */
type Slot = { score: number; col: number; row: number };

/**
 * **Step 6 — the target tile** (@0x53ff9…@0x54312). Takes the row's best candidate, **consumes** it
 * (score to 0) and checks the tile: foreign land, a building on it, an attackable type, occupied and
 * fully threatened, and own land within the attack radius. If one test fails the next candidate is up;
 * if the row is empty the task ends.
 */
function aiAttackFindTarget(state: GameState, player: Player, row: number): Target | null {
  const geo = state.geo;
  for (;;) {
    const slots = player.aiCandidates[row] ?? [];
    let best = 0;
    let bestSlot: Slot | null = null;
    for (let i = 0; i < SLOTS_PER_ROW; i++) {
      const s = slots[i];
      if (s !== undefined && best < s.score) { best = s.score; bestSlot = s; } // `jae` @0x5404a
    }
    if (best === 0 || bestSlot === null) return null; // `or %ax,%ax ; je 0x546d7` @0x5406d — THE exit

    bestSlot.score = 0; // @0x54088 — consumed even when nothing comes of it
    player.cursorCol = bestSlot.col; // @0x54095
    player.cursorRow = bestSlot.row; // @0x540a6

    const pos = posOf(player.cursorCol, player.cursorRow, geo);
    const tile = state.mapTiles[pos];
    if (tile === undefined) continue;
    if (tile.owner === 0) continue; // `jns` @0x54106 — no owner (bit 7 of the height byte clear)
    if (tile.owner === player.slot + 1) continue; // `je` @0x5411d — own land
    if (tile.object < 2 || tile.object > 4) continue; // `jb` @0x54135 / `jae` @0x5413e
    const bld = state.buildings[tile.objIndex];
    if (bld == null) continue;
    player.buildingAttacked = tile.objIndex; // @0x5416d — already HERE, not only at the attack
    // OPEN @0x541c6 — `jne 0x54040` jumps into the BODY of the slot loop, not into its setup @0x53ff9
    // the way all six sibling rejections do (0x54040 has exactly this one predecessor besides its own
    // loop foot @0x54067). On re-entry the counter stands on the object byte (2..3, `mov %al,(%edi)`
    // @0x5412c + `andw $0x7f` @0x5412e), the cursor on the base of the NEXT candidate row (eight times
    // `addl $0x6,0x20(%edi)` @0x5405f, no writer after that), the best value on the old maximum, and
    // `0x24(%edi)` has carried the landscape base `*(gs+0x24)` since @0x540f3/@0x540f6. If one of the
    // 3..4 checked slots of the neighbouring row beats the old best value, the original attacks a
    // target of a FOREIGN target kind; if none beats it, `mov %ax,(%ebx)` @0x54088 zeroes
    // `landscape[0..1]` and the cursor comes from `landscape[2..5]` — producing an unmasked tile offset
    // far beyond the map (`mov 0x1(%ebx),%al` @0x540ff reads foreign memory). This second exit is NOT
    // reproducible in the decoded object model; hence a `continue` here. Reachable but rare: the probe
    // checks the same type (byte-identical block @0x5c80d..@0x5c89e), the candidate upkeep does not
    // (body C @0x53943 checks only the owner and "still carries a building" @0x539c9) — it takes a
    // building replacement on the recorded tile.
    if (!ATTACKABLE_CODED_TYPES.includes(codedBuildingType(bld))) continue; // @0x541b0…@0x541c6
    // @0x541d5 `andb $0x13,0xc(%edi)` + `cmpb $0x13`: fully threatened AND occupied.
    if ((bld.threatLevel & 3) !== 3 || !bld.active) continue;

    if (!aiAttackInRange(state, player, bld, row, bestSlot)) continue;
    return { building: bld };
  }
}

/**
 * Own land within attack range? (@0x541fc…@0x542f6) — the same spiral as the human's attack click
 * (`ATTACK_RANGE_*`), and on a hit the tile is **rescored**.
 */
function aiAttackInRange(
  state: GameState,
  player: Player,
  bld: Building,
  row: number,
  consumed: Slot,
): boolean {
  const geo = state.geo;
  for (let i = 0; i < ATTACK_RANGE_SPIRAL_COUNT; i++) {
    const step = SPIRAL_PATTERN[ATTACK_RANGE_FIRST_SPIRAL + i];
    if (step === undefined) break;
    const p = posOf(
      (bld.col + step[0] + geo.cols) & (geo.cols - 1),
      (bld.row + step[1] + geo.rows) & (geo.rows - 1),
      geo,
    );
    const t = state.mapTiles[p];
    if (t === undefined || t.owner !== player.slot + 1) continue;

    // @0x54244 `andw $0xe0,0x10(%edi)` … the hit. The original sets `player[0x101] = 0` here (build
    // possibility); our model carries the possibility as a parameter of the survey rather than as a
    // player field, so the store is provably equivalent.
    const survey = aiSurveySurroundings(state, player, 0); // `call 0x606d2` @0x5426d
    const project = AI_ATTACK_FIRST + (row - AI_ATTACK_FIRST_ROW); // `call 0x5816d` @0x542a2
    const score = scoreAttackTarget(project, survey, 0);

    // @0x542e4: the unreachable re-scan — the comparison runs against the just-zeroed slot (point 4 in
    // the module head). The body stands as evidence it was read.
    if (consumed.score > score) {
      const slots = player.aiCandidates[row] ?? [];
      for (let k = 0; k < SLOTS_PER_ROW; k++) {
        if ((slots[k]?.score ?? 0) > score) { consumed.score = score; return false; } // @0x546d8
      }
    }
    return true;
  }
  return false;
}

/**
 * **Step 7 — the attack** (@0x54315…@0x546d7). Estimates the resistance from the target's garrison,
 * computes the number of knights to send and calls the two routines of the human attack path.
 *
 * ```
 * resistance = sum of 1 << rank over the target's knight chain       @0x54372
 * castle => *2                                                      @0x54527
 * ((resistance << 14) / goldMorale * aiAttackKnightFactor) >> 16     @0x54534
 * own strength per knight = (totalMilitaryScore << 4) / sum knights  @0x5459f
 * need = ((resistance << 4) / strength) + 1                          @0x545c8
 * need <= available attackers => knightsAttacking = need, dispatch
 * ```
 *
 * The counting walk over the chain **repairs** the garrison count on the way: on hitting a serf that is
 * no (longer a) knight it detaches the chain there and writes the counted length into the upper nibble
 * of `bld[8]` (@0x544d2) — but only when no inventory marker stands there.
 */
function aiAttackExecute(state: GameState, player: Player, bld: Building): void {
  // @0x543ad `call 0x2ae5a` — the task does **not** call `collect_attackers` directly but the common
  // entry of the human attack path. That one checks type, occupation, threat level and range a
  // **second** time (step 6 already checked them) and only then collects. The AI ignores its two return
  // values (proposal, available) — it computes its own need.
  prepareAttack(state, player, bld);

  // @0x54372: count the knight chain. `prev` points at the cell holding the next index.
  let count = 0;
  let weighted = 0;
  let idx = bld.firstKnight;
  let prev: { set: (v: number) => void } = { set: (v) => { bld.firstKnight = v; } };
  while (idx !== 0) {
    const serf = state.serfs[idx];
    const rank = serf == null ? -1 : serf.type - SERF_KNIGHT0;
    if (rank < 0 || rank > 4) {
      // @0x544ac: not a knight — cut the chain here and correct the counter.
      prev.set(0);
      if (!hasInventoryMarker(bld)) bld.stock[0].available = count & 0xf; // @0x544d2
      break;
    }
    count++;
    weighted += 1 << rank; // `shl` @0x544f4
    const cur = serf!;
    prev = { set: (v) => { setUnionU16(cur, 0xe, v); } };
    idx = unionU16(cur, 0xe);
  }

  // @0x54506
  if (codedBuildingType(bld) === 0x60) weighted += weighted; // a castle counts double, @0x54527
  let w = (weighted << 14) >>> 0;
  const morale = player.goldMorale;
  if (morale === 0) return; // a `div` by 0 would be an exception in the original — abort here
  w = Math.floor(w / morale) & 0xffff; // @0x54580
  w = ((w * player.aiAttackKnightFactor) >>> 16) & 0xffff; // @0x54589 + `rorl $0x10`
  if (w === 0) w = 1; // @0x545a7

  let own = (player.totalMilitaryScore << 4) >>> 0; // @0x545af
  const sc = player.serfCount;
  let knights = 0;
  for (let r = 0; r < 5; r++) knights = u16(knights + (sc[SERF_KNIGHT0 + r] ?? 0)); // @0x545c1…
  if (knights === 0) return; // `or %ax,%ax ; je` @0x545de — no knights, no attack

  own = Math.floor(own / knights) & 0xffff; // @0x545ef
  if (own === 0) return; // the same division-by-zero consideration as above
  const need = u16(Math.floor(((w << 4) >>> 0) / own) + 1); // @0x54619
  if (need > player.totalAttackingKnights) return; // `jbe` @0x54658 — more need than attackers present
  player.knightsAttacking = need; // @0x54661
  if (player.attackingBuildingCount === 0) return; // `dec` + `jne` @0x5467b
  dispatchAttackers(state, player); // @0x54683
}

/**
 * **The task.** Returns `true` when an attack was launched; `false` when it probed instead or the row
 * ran empty.
 */
export function aiAttackTask(state: GameState, player: Player): boolean {
  const chance = aiAttackChance(player);
  if (chance !== 'certain') {
    const roll = state.rng.next(); // `call 0x4e1e9` @0x53b97 — ONLY in the non-superior case
    if (!(u16(roll) < u16(chance))) {
      aiProbeMap(state, player); // `jmp 0x5c54a` @0x53ba5 — a tail jump, not a call
      return false;
    }
  }

  const weights = aiAttackRowWeights(player);
  const roll = state.rng.next(); // @0x53e6d — the selection's coin flip
  const row = aiAttackPickRow(weights, roll);
  if (row === null) {
    aiProbeMap(state, player); // @0x53ec9 and @0x53fe4 — both paths end in the probe
    return false;
  }

  // `gs+0x27a` carries the candidate row here — the same shared scratch field as for the build task
  // (@0x53ff2). The port carries it as a parameter, see `ai-execute.ts`.
  const target = aiAttackFindTarget(state, player, row);
  if (target === null) return false; // @0x54030 — the routine's one exit
  aiAttackExecute(state, player, target.building);
  return true;
}
