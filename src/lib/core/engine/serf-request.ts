/**
 * **request_serf phase A**: a building asks for its serf. Two branches of the same driver table
 * `@0x132e2` — production buildings ask for a **worker**, military buildings for a **knight**
 * (garrison refill, second half of this file).
 *
 * Both share the network search {@link walkFlagNetwork}, just as the original has one shared search
 * body `@0x123d9` that the entry points jump into with different type parameters.
 *
 * - **Trigger** (head of each per-type handler `LAB_000132e2[type*8]`): gate `bld[5] & 0xc4 == 0`
 *   (neither `holder` 0x40, `serfRequested` 0x80 nor `serfRequestFailed` 0x04) =>
 *   `request_serf(serfType, tool1, tool2)`. If the request fails, `bld[5] |= 4` so that not every
 *   rotation retries — the round-robin housekeeping (`economy.ts`) clears the bit periodically.
 * - **request_serf** (`FUN_00012428`): flag-network BFS from the building's flag to the nearest
 *   reachable inventory flag whose inventory can supply the worker — either as a **ready** serf of the
 *   type or as a **generic plus tools**.
 *
 * **Rotation gating matters here.** The building driver `FUN_000130f2` processes only the 32-block
 * `rotation*32` per frame. request_serf is an **event**, not an accumulating counter, so it MUST fire
 * rotation gated; running it every tick would dispatch buildings before the original reaches them.
 * That is the opposite of phase B in `buildings.ts`, which is purely fill-level dependent.
 *
 * **A byte-exact oracle match is out of reach by construction**: which generic is dispatched depends on
 * `serfIndices[Generic]`, and that churns with the idle-serf registration. The BFS follows the original
 * in **structure** (nearest reachable inventory, directions 5->0) rather than reproducing its candidate
 * arbitration verbatim.
 */

import type { GameState, Building, Inventory, Player, Serf } from './state.js';
import { setSerfType } from './state.js';
import { landNeighborFlag, flagInventory } from './flag-update.js';
import { posOf } from './position.js';
import { unionU16, setUnionU8, setUnionU16 } from './serf-machine.js';
import { PLAYER_FLAG_RANK_FLOOR, PLAYER_FLAG_REDUCED_OCCUPANCY } from './player-settings.js';
import { castleBuildingHandler } from './castle-garrison.js';
import { warehouseBuildingHandler } from './stock-building.js';
import { buildingConstructionHead } from './building-construction.js';

const SERF_GENERIC = 21;
/** Serf type 22 (Knight0) — what a recruited generic becomes (`orb $0x58` @0x12df7). */
const SERF_KNIGHT0 = 22;
/** Resource 24 = sword (`inv+0x36`), 25 = shield (`inv+0x38`) — the price of one recruit. */
const RES_SWORD = 24;
const RES_SHIELD = 25;
/**
 * A store hands out a generic for the resupply only from **five** upwards (`cmpw $0x5,0x40(%ebx)`
 * @0x128d9, `jb` @0x128de). Below that the search walks on — otherwise two half-empty stores would
 * pass their last settlers back and forth.
 */
const GENERIC_RESUPPLY_MIN = 5;
/** Building type 24 — its own handler (castle garrison), no production worker. */
const BUILDING_CASTLE = 24;
/** Building type 10 — its own handler (warehouse plus the shared stock tail). */
const BUILDING_WAREHOUSE = 10;
const STATE_READY_TO_LEAVE_INVENTORY = 15;
/** State 7 `ReadyToLeave` — the ejected knight steps out of the building (`serf[0xa] = 7`). */
const STATE_READY_TO_LEAVE = 7;
/**
 * **Gold capacity per military type** (`mov $0x2/$0x4/$0x8` @0x1557c / @0x15600 / @0x15684) — in the
 * original the parameter `vreg3` that each of the three handlers sets before the shared tail block.
 */
const MILITARY_GOLD_CAPACITY: Record<number, number> = { 11: 2, 21: 4, 22: 8 };
/** Only rotations < 32 process building blocks (== the building driver `FUN_000130f2`). */
/**
 * The building driver's block scheme, shared with {@link updateBuildings}. `FUN_000130f2` returns at
 * once for rotation >= 32 (`cmpw $0x20 ; jb/ret` @0x130ff..@0x13105) and then walks 32 buildings from
 * `rotation * 32` (`shlw $0x5` @0x13127, counter `0x1f`) — and after those 32 it does **not** stop:
 * the outer loop @0x132c2 adds `0x80` to the bitmap pointer, `0x4800` (== 1024 * 0x12) to the record
 * base and `0x3e0` to the index, so the next batch is `rotation * 32 + 1024`. It repeats until the
 * index passes `maxBuildingIndex` (`cmp 0x260(%ebx)` @0x13174). The driver therefore serves 1/32 of
 * ALL buildings per frame with a stride of 1024, not just the first block.
 *
 * Exported so the driver's two phases cannot drift apart.
 */
export const BUILDING_ROTATIONS = 32;
export const BUILDING_BLOCK_SIZE = 32;
/** Stride of the outer batch loop (`addw $0x3e0` @0x132d5 on an index already advanced by 32). */
export const BUILDING_BATCH_STRIDE = 1024;
const BLOCK_SIZE = BUILDING_BLOCK_SIZE;

/**
 * The index sequence the driver visits this frame — `rotation * 32 .. +31`, then the same window
 * every {@link BUILDING_BATCH_STRIDE} indices, bounded by `limit` (== `maxBuildingIndex`).
 */
export function* buildingDriverBlock(rotation: number, limit: number): Generator<number> {
  if (rotation >= BUILDING_ROTATIONS) return;
  for (let base = rotation * BLOCK_SIZE; base < limit; base += BUILDING_BATCH_STRIDE) {
    const end = Math.min(base + BLOCK_SIZE, limit);
    for (let i = base; i < end; i++) yield i;
  }
}

/** One worker need: which serf type, and which tool resources specialise a generic into it. */
export interface WorkerRequest {
  readonly serfType: number;
  /** Tool resource indices (0..25) a generic needs in order to specialise. */
  readonly tools: readonly number[];
}

/**
 * Worker request per building type, extracted from the per-type handlers (`LAB_000132e2 + type*8`). The
 * tool constant in the original is `(res+1)*2`; here it is the plain resource index (hammer 16, rod 17,
 * cleaver 18, scythe 19, axe 20, saw 21, pick 22, pincer 23). `null` = no production worker.
 */
const WORKER_REQUEST: (WorkerRequest | null)[] = new Array(25).fill(null);
WORKER_REQUEST[1] = { serfType: 11, tools: [17] }; // fisher      -> fisher     + rod
WORKER_REQUEST[2] = { serfType: 5, tools: [20] }; //  lumberjack  -> lumberjack + axe
WORKER_REQUEST[3] = { serfType: 17, tools: [16] }; // boatbuilder -> boatbuilder+ hammer
WORKER_REQUEST[4] = { serfType: 7, tools: [22] }; //  stonecutter -> stonecutter+ pick
WORKER_REQUEST[5] = { serfType: 9, tools: [22] }; //  stone mine  -> miner      + pick
WORKER_REQUEST[6] = { serfType: 9, tools: [22] }; //  coal mine   -> miner      + pick
WORKER_REQUEST[7] = { serfType: 9, tools: [22] }; //  iron mine   -> miner      + pick
WORKER_REQUEST[8] = { serfType: 9, tools: [22] }; //  gold mine   -> miner      + pick
WORKER_REQUEST[9] = { serfType: 8, tools: [] }; //    forester    -> forester
WORKER_REQUEST[12] = { serfType: 14, tools: [19] }; // farm        -> farmer     + scythe
WORKER_REQUEST[13] = { serfType: 13, tools: [18] }; // butcher     -> butcher    + cleaver
WORKER_REQUEST[14] = { serfType: 12, tools: [] }; //   pig farm    -> pig farmer
WORKER_REQUEST[15] = { serfType: 15, tools: [] }; //   mill        -> miller
WORKER_REQUEST[16] = { serfType: 16, tools: [] }; //   baker       -> baker
WORKER_REQUEST[17] = { serfType: 6, tools: [21] }; //  sawmill     -> sawmiller  + saw
WORKER_REQUEST[18] = { serfType: 10, tools: [] }; //   steel smelter-> smelter
WORKER_REQUEST[19] = { serfType: 18, tools: [16, 21] }; // toolmaker   -> toolmaker  + hammer + saw
WORKER_REQUEST[20] = { serfType: 19, tools: [16, 23] }; // weaponsmith -> weaponsmith+ hammer + pincer
WORKER_REQUEST[23] = { serfType: 10, tools: [] }; //   gold smelter-> smelter

/**
 * Rotation-gated phase A driver (a pure block processor). `tick.ts` calls it only at the frame boundary,
 * right after `updateFlags` and with the rotation already set. It processes the 32-building block
 * `rotation*32` (rotation < 32).
 */
export function requestBuildingWorkers(state: GameState): void {
  const { buildings } = state;
  for (const i of buildingDriverBlock(state.rotation, buildings.length)) {
    const bld = buildings[i];
    if (bld === null || bld.burning) continue;
    // The driver jumps through `(bld[4] & 0xfc) * 2` into the stub table @0x132e2 (8 bytes each).
    // `bld[4]` bit 7 == `constructing` survives the mask, so the index is `type + 32*constructing`, and
    // entries 32..56 are a **second** set of handlers: the construction branch. A construction site
    // therefore NEVER reaches its production handler.
    if (bld.constructing) {
      buildingConstructionHead(state, bld, i);
      continue;
    }
    // Military types have their own handlers; they only share the tail @0x1569a.
    if (MILITARY_OCCUPANCY[bld.type] !== undefined && !bld.constructing) {
      militaryBuildingHandler(state, bld);
      continue;
    }
    if (bld.type === BUILDING_CASTLE && !bld.constructing) {
      castleBuildingHandler(state, bld); // own table entry @0x14da5
      continue;
    }
    if (bld.type === BUILDING_WAREHOUSE && !bld.constructing) {
      warehouseBuildingHandler(state, bld); // own table entry @0x1528c
      continue;
    }
    requestWorker(state, bld);
  }
}

/** Phase A trigger for a single building (the `FUN_000132ea` family). */
function requestWorker(state: GameState, bld: Building): void {
  const req = bld.type >= 0 && bld.type < WORKER_REQUEST.length ? WORKER_REQUEST[bld.type] : null;
  if (req === null) return; // no production worker
  // Gate bld[5] & 0xc4: not occupied, not requested, no previous failure.
  if (bld.holder || bld.serfRequested || bld.serfRequestFailed) return;
  const ok = sendSerfToFlag(state, bld, req);
  if (!ok) bld.serfRequestFailed = true; // bld[5] |= 4
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// **Garrison refill** (the military branch of the same driver)
//
// One handler per type — hut `@0x15511`, tower `@0x15595`, fortress `@0x15619` — differing only in
// their occupancy table and score weight, meeting in the shared tail `@0x1569a`. The **castle** (type
// 24) has a completely different handler `@0x14da5` (rank rotation) and does **not** refill.
//
// Head of each handler (read from the assembly, hut):
// ```
// player = gs[0x64 + (bld[4] & 3)*4]
// idx = (player[(bld[5] & 3) - 4] & 0xf0) >> 4   // == knightOccupation[threatLevel], HIGH nibble
// if (player[2] bt 4) idx += 5                   // flags bit 4 => second half of the table
// target = table[idx]
// ```
// (`player` points at block offset 0x80, so `player - 4` == block 124 == `knightOccupation[0]`.)
//
// The second branch of the tail is easy to read backwards: `cmp %ax,(%edi)` compares
// `target - available` and jumps to the **end** on `jae` (target >= available). So it runs only on
// **over**-occupancy and is the ejection the shift change needs.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Target occupancy per military type, indexed by the `max` nibble (0..4), or `max + 5` when `flags` bit
 * 4 is set. Read from the three tables: hut `@0x1558b`, tower `@0x1560f`, fortress `@0x15690`. The
 * maxima 3 / 6 / 12 are the familiar occupancy limits.
 */
const MILITARY_OCCUPANCY: Record<number, readonly number[]> = {
  11: [1, 1, 2, 2, 3, 1, 1, 1, 1, 2], // hut
  21: [1, 2, 3, 4, 6, 1, 1, 2, 3, 4], // tower
  22: [1, 3, 6, 9, 12, 1, 2, 4, 6, 8], // fortress
};

// `flags` bit 4 shifts the table index by 5 into the consistently **smaller** second half: it is
// **phase 1 of the shift change**. It is never set in any saved game, which fits — the phase lasts only
// 177 of 1200 ticks, so its meaning comes from the code, not from data.

/** Inventory knight slots in the order `request_serf` tests them: K4 -> K0. */
const KNIGHT_TYPES_HIGH_FIRST: readonly number[] = [26, 25, 24, 23, 22];

/**
 * Abort constant **after** each rank of {@link KNIGHT_TYPES_HIGH_FIRST} — the four `cmpw` immediates of
 * the knight cascade (`$0xfff6` @0x12650, `$0xfff8` @0x1266f, `$0xfffa` @0x1268e, `$0xfffc` @0x126ad).
 * After K0 there is no further test, hence a value {@link knightRequestRankParam} never produces.
 */
const KNIGHT_RANK_STOP: readonly number[] = [-10, -8, -6, -4, NaN];

/**
 * The **type parameter of a knight request** (`vreg4` in `request_serf`, @0x124b1–@0x1251d). Normally
 * `-1 * 2 = -2`; with `flags` bit 5 set instead `-((knightShiftTimer >> 8) + 1) * 2`, i.e. `-10 / -8 /
 * -6 / -4 / -2` depending on the remaining countdown.
 *
 * Phase 2 of the shift change thereby acts as a **descending rank floor**: just after switching, a
 * store only yields a K4, later K3, K2, K1 and finally any rank — so buildings get the strongest
 * knights as replacements without the refill getting stuck when no high ranks exist.
 *
 * The conversion is deliberately **not** condensed into a rank number: the cascade compares for
 * **equality** against four constants, so a value outside them (with an absurd countdown) admits every
 * rank rather than none. That is what {@link KNIGHT_RANK_STOP} models.
 */
function knightRequestRankParam(player: Player | null): number {
  if (player === null || (player.flags & PLAYER_FLAG_RANK_FLOOR) === 0) return -2;
  return -(((player.knightShiftTimer >> 8) + 1) * 2);
}

/**
 * Target occupancy of a military building, or `null` for non-military types.
 *
 * The index stays within 0..4 because `knightOccupation` satisfies `min <= max <= 4` in every saved
 * game. The original indexes the 10-byte table unchecked; with that invariant the access is provably in
 * bounds.
 */
export function militaryOccupancyTarget(state: GameState, bld: Building): number | null {
  const table = MILITARY_OCCUPANCY[bld.type];
  if (table === undefined) return null;
  const player = state.players[bld.owner];
  if (!player) return null;
  const occ = player.knightOccupation[bld.threatLevel & 3] ?? 0;
  const idx = ((occ >> 4) & 0xf) + ((player.flags & PLAYER_FLAG_REDUCED_OCCUPANCY) !== 0 ? 5 : 0);
  return table[idx] ?? 0;
}

/**
 * Military handler (`@0x15511`/`@0x15595`/`@0x15619` plus the tail `@0x1569a`). It matches the garrison
 * to the target occupancy in **both** directions: below target it requests a knight, above target it
 * ejects the weakest one, and in between (a knight is on the way) it does nothing.
 *
 * Afterwards — on **both** branches (`jmp 0x15901` @0x15702 and @0x1570e) — the tail block
 * {@link militaryGoldDemand}.
 */
export function militaryBuildingHandler(state: GameState, bld: Building): void {
  const target = militaryOccupancyTarget(state, bld);
  if (target === null) return;
  const available = bld.stock[0].available & 0xf;
  const requested = bld.stock[0].requested & 0xf;
  if (available + requested < target) {
    if (!bld.serfRequestFailed) {
      // bld[5] bt 2 / bts 2 — unlike the production branch, the tail block is NOT skipped here.
      if (!requestKnightForBuilding(state, bld)) bld.serfRequestFailed = true;
    }
  } else if (target < available) {
    ejectWeakestKnight(state, bld); // @0x15707
  }
  militaryGoldDemand(state, bld); // `jmp 0x15901`
}

/**
 * **Gold bookkeeping and gold demand of a military building** (`@0x15901`) — the shared tail of both
 * branches above, all of it only for an occupied building (`bld[5] bt 6`):
 *
 * ```
 * flag      = bld[0xe]                          // see below
 * available = (bld[9] & 0xf0) >> 4 ; requested = bld[9] & 0xf
 * player[0x17c] += available                    // gold IN the military buildings (block 508)
 * player[0x178] += capacity                     // gold capacity (block 504)
 * if (available + requested < capacity)
 *     flag[0x45] = ((0xfe >> (available + requested)) + 1) & ~1
 * else flag[0x45] = 0
 * ```
 *
 * The two accumulators are the military half of knight morale; `updateKnightMorale` reads and zeroes
 * them once per rotation round.
 *
 * **In a FINISHED building `bld[0xe]` is the flag pointer**, not the levelling height — the original
 * reads that union differently depending on the construction state. Measured separately over 62 saves:
 * **3116 of 3116** finished buildings hold `flagIndex * 70` there, **527 of 527** under construction a
 * value <= 31. So `+0x45` is `flag[69]` == `stockPriority[1]`.
 *
 * The demand curve halves with every gold bar present (0xfe, 0x80, 0x40, …): an empty military building
 * attracts gold most strongly, a full one not at all.
 */
export function militaryGoldDemand(state: GameState, bld: Building): void {
  if (!bld.holder) return; // `bt $0x6` @0x1590c
  const capacity = MILITARY_GOLD_CAPACITY[bld.type];
  if (capacity === undefined) return;
  const player = state.players[bld.owner & 3];
  const available = bld.stock[1].available & 0xf;
  const requested = bld.stock[1].requested & 0xf;
  if (player) {
    player.militaryGoldAccumulator = (player.militaryGoldAccumulator + available) >>> 0;
    player.militaryGoldCapacity = (player.militaryGoldCapacity + capacity) >>> 0;
  }
  const flag = state.flags[bld.flag];
  if (!flag) return;
  const filled = available + requested;
  // `mov $0xfe,%al ; shrb %cl,(%esi) ; addw $1 ; btr $0` — byte shift, then clear bit 0.
  const prio = filled < capacity ? (((0xfe >> filled) & 0xff) + 1) & ~1 : 0;
  flag.stockPriority[1] = prio & 0xff;
}

/**
 * **Ejecting the weakest knight** (`@0x15707`) — the half of the shift change that lives in the
 * building. Runs only on over-occupancy; **one** knight per call.
 *
 * The order matters. First the **exit must be free**: if a serf stands on the building tile
 * (`game[bld.pos].serf != 0` @0x1575f) the original aborts, otherwise the one stepping out would
 * collide with it. Then the weakest is found by walking the garrison chain `bld[10] -> serf[0xe]` for
 * the **smallest** value of `serf[0] & 0x7c` — the mask leaves the type as `type << 2`, so a smaller
 * value is a lower rank. Then it is unhooked from the chain, and finally the exit is set up
 * (@0x158d0): `field_B = -2` ("back to the store"), `dest = 0` so state 2 finds the nearest store
 * itself, `next_state = 2`, state **7** (ReadyToLeave). State 7 has no tick gate, so the exit begins in
 * the same tick.
 *
 * `bld[8] -= 0x10` is a **byte** subtraction on the nibble pair, i.e. `available - 1`. The original sets
 * neither `tick` nor `counter` — both stay until state 7 sets up the exit animation.
 */
function ejectWeakestKnight(state: GameState, bld: Building): void {
  if (bld.col === null || bld.row === null) return;
  const pos = posOf(bld.col, bld.row, state.geo);
  if (state.mapTiles[pos].serfIndex !== 0) return; // exit occupied (@0x1577f)

  let weakest = 0;
  let weakestRank = 0xff; // `mov $0xff,%al` @0x15798
  let prevIndex = 0; // 0 = the weakest is (still) the head
  let prevOfWeakest = 0;
  for (let idx = bld.firstKnight; idx !== 0; ) {
    const s = state.serfs[idx];
    if (s == null) break;
    const rank = (s.type << 2) & 0x7c;
    if (rank < weakestRank) {
      weakestRank = rank;
      weakest = idx;
      prevOfWeakest = prevIndex;
    }
    prevIndex = idx;
    idx = unionU16(s, 0xe);
  }
  const serf = weakest !== 0 ? state.serfs[weakest] : null;
  if (serf == null) return;

  const next = unionU16(serf, 0xe);
  if (prevOfWeakest === 0) {
    bld.firstKnight = next; // head (@0x1585a)
  } else {
    const prev = state.serfs[prevOfWeakest];
    if (prev == null) return;
    setUnionU16(prev, 0xe, next); // predecessor skips it (@0x158c9)
  }

  setUnionU8(serf, 0xb, 0xfe); // field_B = -2 => "back to the store"
  setUnionU16(serf, 0xc, 0); // dest = 0 => state 2 finds the nearest store itself
  setUnionU8(serf, 0xe, 0); // dir = 0
  setUnionU8(serf, 0xf, 2); // next_state = 2 (walking)
  serf.state = STATE_READY_TO_LEAVE;

  const raw = (((bld.stock[0].available & 0xf) << 4) | (bld.stock[0].requested & 0xf)) - 0x10;
  bld.stock[0] = { available: (raw >> 4) & 0xf, requested: raw & 0xf };
}

/**
 * Requests a knight for the garrison — the knight path of `request_serf` (`@0x127a2..0x12822`). It uses
 * **the same** network search as the worker request but its own availability test and dispatch tail.
 *
 * - **Rank order K4 -> K0** (`inv+0x76 -> 0x74 -> 0x72 -> 0x70 -> 0x6e`), highest rank first, and the
 *   slot alone decides (`or ax,ax` @0x12647 ff.) — the serf's state is not looked at.
 * - **Two-phase, like the worker search.** A store with a knight wins at once. A store with only a
 *   generic **plus sword plus shield** (@0x126df: `inv+0x6c`, `inv+0x36`, `inv+0x38`) is merely
 *   *remembered* and arms the wave budget from `player+0x10a` (@0x1277b); when the budget runs out the
 *   remembered generic is **recruited into a Knight0** (@0x12d8a..@0x12e5f). Without that branch a
 *   settlement whose stores hold weapons but no knight never fills a hut.
 * - **The zero cascade is not rebuilt, and that is a proven equivalence, not a shortcut.** The
 *   original clears the first occupied slot K4 -> K0 (@0x127b8..@0x1281e) instead of the slot it took
 *   from. It is the same slot: the selection above also runs K4 -> K0 and stops at the first occupied
 *   one, so everything above it is empty, and between the hit (@0x127a2) and the cascade nothing
 *   writes to the inventory. The recruiting branch does not run the cascade at all — it only clears
 *   `inv+0x6c`.
 *
 * The tail calls `request_serf` with type parameter `0xffffffff` (`mov $0xffffffff,%eax` @0x156de),
 * meaning "no particular type, any knight". The original has *one* routine `@0x12428` branching
 * internally on that value (`0x14` = geologist, `0xffffffff` = knight, otherwise worker); the port
 * models the three entries as three functions over the same search.
 *
 * The one surprise in the tail: `bld[5]` bit 7 is **cleared** (`btr $0x7`) where the production path
 * *sets* it — `serfRequested` is `false` in the post state even though a knight was dispatched. The
 * serf type is unchanged (it *is* a knight already), so there is no census bookkeeping.
 */
export function requestKnightForBuilding(state: GameState, bld: Building): boolean {
  const rankParam = knightRequestRankParam(state.players[bld.owner] ?? null);
  let hit: { inv: Inventory; serf: Serf; knightType: number } | null = null;
  let recruit: { inv: Inventory; serf: Serf } | null = null;
  // `mov $0xffff,%ax ; mov %ax,0x340(%ebx)` @0x12574 — unlimited until something is remembered.
  let budget = 0xffff;
  walkFlagNetwork(
    state,
    bld.flag,
    (fIdx) => {
      const fl = state.flags[fIdx];
      if (!fl) return false;
      const inv = flagInventory(state, fl);
      if (!inv) return false;
      for (let i = 0; i < KNIGHT_TYPES_HIGH_FIRST.length; i++) {
        const kt = KNIGHT_TYPES_HIGH_FIRST[i]!;
        const idx = inv.serfIndices[kt];
        const s = idx !== 0 ? state.serfs[idx] : null;
        if (s) {
          hit = { inv, serf: s, knightType: kt };
          return true;
        }
        // Rank floor: the original compares the type parameter against a fixed constant after EVERY
        // rank and gives up on this inventory when it matches (@0x12650/@0x1266f/@0x1268e/@0x126ad).
        if (rankParam === KNIGHT_RANK_STOP[i]) return false;
      }
      // @0x126df — no knight here: can this store make one?
      if (recruit !== null) return false; // `gs+0x342 != 0` @0x126cf — one is remembered already
      const g = inv.serfIndices[SERF_GENERIC];
      const gs = g !== 0 ? state.serfs[g] : null;
      if (!gs) return false; // @0x126ea
      if (inv.resources[RES_SWORD] === 0) return false; // @0x126fa
      if (inv.resources[RES_SHIELD] === 0) return false; // @0x1270a
      recruit = { inv, serf: gs }; // `mov %eax,0x344(%ebx)` @0x12719
      budget = state.players[inv.owner]?.contSearchAfterNonOptimalFind ?? 0xffff; // @0x1277b
      return false;
    },
    () => {
      // `subw $0x1,0x340(%ebx)` @0x12cf2 · `je 0x12d71` — one per wave; at 0 the remembered generic
      // is recruited.
      budget = (budget - 1) & 0xffff;
      return budget === 0;
    },
  );

  let inv: Inventory;
  let serf: Serf;
  if (hit !== null) {
    const h = hit as { inv: Inventory; serf: Serf; knightType: number };
    inv = h.inv;
    serf = h.serf;
    // The topmost occupied slot — the same one the original's cascade @0x127b8 clears (see above).
    inv.serfIndices[h.knightType] = 0;
  } else if (recruit !== null) {
    const r = recruit as { inv: Inventory; serf: Serf };
    inv = r.inv;
    serf = r.serf;
    inv.serfIndices[SERF_GENERIC] = 0; // @0x12db1
    inv.genericCount -= 1; // @0x12db8
    inv.resources[RES_SWORD] -= 1; // @0x12dfd
    inv.resources[RES_SHIELD] -= 1; // @0x12e05
    setSerfType(serf, SERF_KNIGHT0); // `andb $0x83 ; orb $0x58` @0x12df1/@0x12df7
    // The census follows the SERF's owner (`serf[0] & 3` @0x12e1d), not the building's.
    const player = state.players[serf.owner & 3];
    if (player) {
      const sc = player.serfCount as number[];
      sc[SERF_GENERIC] = (sc[SERF_GENERIC] - 1) & 0xffff; // `subw $0x1,-0x10(%ebx)` @0x12e48
      sc[SERF_KNIGHT0] = (sc[SERF_KNIGHT0] + 1) & 0xffff; // `addw $0x1,-0xe(%ebx)` @0x12e50
      player.totalMilitaryScore = (player.totalMilitaryScore + 1) >>> 0; // `addl $0x1` @0x12e58
    }
  } else {
    return false;
  }

  // The tail both branches share (@0x12822 resp. @0x12dbd).
  const raw = (((bld.stock[0].available & 0xf) << 4) | (bld.stock[0].requested & 0xf)) + 1;
  bld.stock[0] = { available: (raw >> 4) & 0xf, requested: raw & 0xf };
  bld.serfRequested = false; // `btr $0x7` @0x12831 / @0x12dcc

  const dest = bld.flag;
  serf.stateData = [
    0xff,
    dest & 0xff,
    (dest >> 8) & 0xff,
    inv.index & 0xff,
    (inv.index >> 8) & 0xff,
  ];
  serf.state = STATE_READY_TO_LEAVE_INVENTORY;
  serf.tick = state.gameTick;
  inv.serfIndices[4] = (inv.serfIndices[4] + 1) & 0xffff; // inv+0x4a serfs_out
  return true;
}

/**
 * What an inventory can supply for this need — and **which of the dispatch tails** applies.
 *
 * `resupply` is not a variant of `worker`: for serf type `0x15` the original branches out of the
 * shared test into a tail of its own (`cmpw $0x2a,0x10(%edi)` @0x128cb, `jne 0x12986` for every other
 * type). The three differ in what they cost the store and in what they do to the target building; see
 * {@link dispatchRequestedSerf}.
 */
type Supply = { kind: 'worker' | 'generic' | 'resupply'; serf: Serf };

function inventorySupply(state: GameState, inv: Inventory, req: WorkerRequest): Supply | null {
  // A serf of the type in store? The original tests the slot and nothing else (`or ax,ax` @0x128c2) —
  // in particular not the serf's state.
  const ready = inv.serfIndices[req.serfType];
  if (ready !== 0) {
    const s = state.serfs[ready];
    if (s) {
      if (req.serfType !== SERF_GENERIC) return { kind: 'worker', serf: s };
      // The resupply takes an unspecialised settler out of a store that can spare him.
      if (inv.genericCount < GENERIC_RESUPPLY_MIN) return null; // walk on (@0x128de)
      return { kind: 'resupply', serf: s };
    }
  }
  // Or a generic plus all the tools?
  const g = inv.serfIndices[SERF_GENERIC];
  if (g !== 0 && inv.genericCount > 0) {
    const s = state.serfs[g];
    if (s && req.tools.every((t) => inv.resources[t] > 0)) {
      return { kind: 'generic', serf: s };
    }
  }
  return null;
}

/**
 * **Where the requested serf goes** — in the original the only difference between the two entry points:
 * the dispatch branch tests `vreg4 == 0x28` (serf type 20 = geologist) and then reads `ptr_c` as a
 * **flag** instead of a building (`@0x12a58` resp. `@0x12dbe`).
 */
type RequestTarget =
  | { readonly kind: 'building'; readonly bld: Building }
  | { readonly kind: 'flag'; readonly flagIndex: number };

/**
 * The shared search body of both requests (`FUN_000123d9`; `FUN_00012428` is the same body entered with
 * a building instead of a flag). It walks the flag network from `startFlag` — the flag itself first,
 * then neighbours in directions 5->0 — and returns the inventory that can supply.
 *
 * **Two-phase preference (@0x12a6a).** A store with a **ready** serf of the type wins immediately. A
 * store that only has a **generic plus tools** is merely *remembered* (`gs+0x342/0x344`) and used only
 * if the search finds no ready serf anywhere — a ready worker always beats specialising one, even from
 * further away.
 *
 * **The search budget** (`player+0x10a`, default 7) decides whether specialising happens **at all**,
 * and its granularity is a **wave** of the breadth-first search, not a flag:
 *
 * ```
 * 12574 mov $0xffff,%ax ; mov %ax,0x340(%ebx)  budget := unlimited (start of search)
 * 12588 xor %ax,%ax ; mov %ax,0x342(%ebx)      "nothing remembered"
 * 12af5 mov %eax,0x344(%ebx)                   remembered inventory
 * 12b57 mov 0x10a(%ebx),%ax -> 0x340(%ebx)     budget := player+0x10a (7)
 * 125db mov 0x276(%ebx),%ax ; mov %ax,(%edi)   length of the current wave
 * 12ce5 subw $0x1,(%edi) ; jae 0x125f5         … work through the wave
 * 12cf2 subw $0x1,0x340(%ebx)                  one per WAVE
 * 12cfa je 0x12d71                             at 0: specialise the remembered generic
 * ```
 *
 * `vreg0` is the wave length from `gs+0x276`, the inner loop counts it down, and the budget decrement
 * sits **after** it and before the queue swap (`not gs+0x270` @0x125b3).
 *
 * The initial `0xffff` is why the branch cannot fire into nothing: while nothing is remembered the
 * counter never reaches 0, because the search ends long before.
 *
 * **Not reproduced:** the order WITHIN a wave (the two-queue swap `gs+0xb4`/`gs+0xb8`) — it only decides
 * which of several equivalent stores wins.
 */
function findSerfSupply(
  state: GameState,
  startFlag: number,
  req: WorkerRequest,
): { inv: Inventory; supply: Supply } | null {
  let fallback: { inv: Inventory; supply: Supply } | null = null;
  // `mov $0xffff,%ax ; mov %ax,0x340(%ebx)` @0x12574 — unlimited until something is remembered.
  let budget = 0xffff;
  const check = (fIdx: number): { inv: Inventory; supply: Supply } | null => {
    const fl = state.flags[fIdx];
    if (!fl) return null;
    const inv = flagInventory(state, fl);
    if (!inv) return null;
    const supply = inventorySupply(state, inv, req);
    if (supply === null) return null;
    if (supply.kind === 'worker') return { inv, supply };
    if (fallback === null) {
      fallback = { inv, supply }; // `mov %eax,0x344(%ebx)` @0x12af5
      // `mov 0x10a(%ebx),%ax ; mov %ax,0x340(%ebx)` @0x12b57 — from now on the search is counted.
      const owner = state.flags[startFlag]?.owner ?? 0;
      budget = state.players[owner]?.contSearchAfterNonOptimalFind ?? 0xffff;
    }
    return null;
  };

  let hit: { inv: Inventory; supply: Supply } | null = null;
  walkFlagNetwork(
    state,
    startFlag,
    (fIdx) => {
      const h = check(fIdx);
      if (h === null) return false;
      hit = h;
      return true;
    },
    () => {
      // `subw $0x1,0x340(%ebx)` @0x12cf2 · `je 0x12d71` @0x12cfa — one per wave; at exactly 0 the
      // search stops and the remembered generic is specialised.
      budget = (budget - 1) & 0xffff;
      return budget === 0;
    },
  );
  return hit ?? fallback;
}

/**
 * **The network traversal itself** (`FUN_000123d9`) — the flag first, then neighbours in directions
 * 5->0. `visit` returns `true` to stop the search (a hit).
 *
 * In the original this body is **shared**: worker, geologist and knight requests all jump into it and
 * differ only in the per-inventory availability test and the dispatch tail. The port shares it too
 * rather than copying it per request kind.
 *
 * **Land paths only** (`mov 0x4(%ebx),%al` @0x12b7f, then six doublings plus `jns`): a settler never
 * enters a boat road. A construction site that hangs on a boat road alone therefore never gets a
 * worker — see {@link landNeighborFlag}.
 */
function walkFlagNetwork(
  state: GameState,
  startFlag: number,
  visit: (flagIndex: number) => boolean,
  /**
   * End of a breadth-first **wave** — in the original the point between the drained queue
   * (`subw $0x1,(%edi) ; jae 0x125f5` @0x12ce5) and the swap of the two queues (`not gs+0x270`
   * @0x125b3). Returns `true` to abort.
   */
  onWaveEnd?: () => boolean,
): void {
  if (state.flags[startFlag] === null || state.flags[startFlag] === undefined) return;
  if (visit(startFlag)) return;
  const visited = new Set<number>([startFlag]);
  let frontier: number[] = [startFlag];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const fIdx of frontier) {
      const fl = state.flags[fIdx];
      if (!fl) continue;
      for (let dir = 5; dir >= 0; dir--) {
        const nb = landNeighborFlag(fl, dir);
        if (nb < 0 || visited.has(nb)) continue;
        if (visit(nb)) return;
        visited.add(nb);
        next.push(nb);
      }
    }
    if (onWaveEnd !== undefined && onWaveEnd()) return;
    frontier = next;
  }
}

/**
 * `send_serf_to_flag` (`FUN_00012428`) — the entry with a **building**: request from its flag.
 *
 * Exported because the stock buildings use the same entry with **different** type parameters than the
 * production table above (transporter `0x0` @0x15379, generic resupply `0x15` @0x1542d). In the
 * original it is literally the same `call 0x12428`.
 */
export function sendSerfToFlag(state: GameState, bld: Building, req: WorkerRequest): boolean {
  const found = findSerfSupply(state, bld.flag, req);
  if (found === null) return false;
  dispatchRequestedSerf(state, found.inv, found.supply, req, { kind: 'building', bld });
  return true;
}

/** The geologist is the only serf the original requests to a **flag** (`vreg0 = 0x14`). */
export const GEOLOGIST_REQUEST: WorkerRequest = { serfType: 20, tools: [16] }; // geologist + hammer

/**
 * **Sending a geologist to a flag** — `FUN_00012370` -> `FUN_000123d9`, the entry with a **flag**. The
 * wrapper only sets the parameters and calls the same body:
 *
 * ```
 * ptr_b = vreg9 (the flag) ; vreg0 = 0x14 (serf type 20 = geologist)
 * vreg6 = 0x22 ; vreg7 = 0                    // goods needed
 * call FUN_000123d9
 * ```
 *
 * `vreg6` is the **byte offset of the needed good inside the inventory**: the search tests
 * `inv[4 + vreg6] != 0` and the dispatch subtracts 1 there. `resources[]` starts at `inv+6`, so
 * `vreg6 = 2 + 2*type` and `0x22` is resource **16 = hammer** — matching the founding roster, where
 * each of the two starting geologists consumes a hammer. `vreg7 = 0` means no second good.
 */
export function sendGeologistToFlag(state: GameState, flagIndex: number): boolean {
  const found = findSerfSupply(state, flagIndex, GEOLOGIST_REQUEST);
  if (found === null) return false;
  dispatchRequestedSerf(state, found.inv, found.supply, GEOLOGIST_REQUEST, {
    kind: 'flag',
    flagIndex,
  });
  return true;
}

/**
 * Dispatches the found serf (state 15 ReadyToLeaveInventory) — **three** tails, chosen by the type:
 *
 * ```
 * type == 0x15 (resupply)  @0x128d6 : serfs[21] = 0 ; generic_count--
 *                                     serf[0xb] = 0xfe ; serf[0xc] = bld[6]
 *                                     ===> NO bts $0x7
 * type == 0x14 (geologist) @0x129b2 : serf[0xb] = 6 ; serf[0xc] = flagIndex
 * otherwise                @0x129f6 : bld[5] |= 0x80 ; serf[0xb] = 0xff ; serf[0xc] = bld[6]
 * a specialised generic             : serf[0] = (serf[0] & 0x83) | (type << 2) ; tools ; census
 * all                               : serf[0xa] = 0xf ; inv[0x4a]++            // serfs_out
 * ```
 *
 * **Why the resupply must not set `serfRequested`, and what it costs when it does.** The bit is a
 * claim on the building's `bld[0xa]`: the arrival handover writes the arriving serf's index there
 * (`btr $0x7` @0x202df, then @0x202f1) — and it does so for **whichever** serf with a negative mode
 * reaches the flag first, not for the one that was sent. For a warehouse that slot is the keeper and
 * the mechanism is the point. For a **castle** `bld[0xa]` is the head of the garrison chain, and the
 * chain is gone with it: the knights behind it hang in state 75 and no reader finds them again. The
 * castle asks for a resupply through the very same shared stock tail (`jmp 0x1537e` @0x15287), so
 * this is not a corner case.
 *
 * The mode is `0xfe` rather than `0xff` for the same reason: a resupply settler carries no request,
 * so a dead end on the way must make him *lost* instead of booking a request back
 * (`arrivalCleanup`, `dir1 <= -2` @0x20901).
 */
function dispatchRequestedSerf(
  state: GameState,
  inv: Inventory,
  supply: Supply,
  req: WorkerRequest,
  target: RequestTarget,
): void {
  const serf = supply.serf;
  if (supply.kind === 'resupply') {
    inv.serfIndices[SERF_GENERIC] = 0; // @0x128fa
    inv.genericCount -= 1; // `subw $0x1,0x40(%ebx)` @0x12932 — the store really loses him
  } else if (supply.kind === 'worker') {
    inv.serfIndices[req.serfType] = 0;
  } else {
    // Specialise a generic.
    inv.serfIndices[SERF_GENERIC] = 0;
    inv.genericCount -= 1;
    for (const t of req.tools) inv.resources[t] = Math.max(0, inv.resources[t] - 1);
    setSerfType(serf, req.serfType);
    const player = inv.owner >= 0 ? state.players[inv.owner] : null;
    if (player) {
      const sc = player.serfCount as number[];
      sc[SERF_GENERIC] = Math.max(0, sc[SERF_GENERIC] - 1);
      sc[req.serfType] = (sc[req.serfType] + 1) & 0xffff;
    }
  }
  // `field_0xb` = mode, `field_0xc` = target flag, `field_0xe` = inventory (already correct for a
  // stored serf; the original does not rewrite it here).
  const mode = target.kind === 'flag' ? 6 : supply.kind === 'resupply' ? 0xfe : 0xff;
  const dest = target.kind === 'flag' ? target.flagIndex : target.bld.flag;
  serf.stateData = [
    mode & 0xff,
    dest & 0xff,
    (dest >> 8) & 0xff,
    inv.index & 0xff,
    (inv.index >> 8) & 0xff,
  ];
  serf.state = STATE_READY_TO_LEAVE_INVENTORY;
  serf.tick = state.gameTick;
  inv.serfIndices[4] = (inv.serfIndices[4] + 1) & 0xffff; // inv+0x4a serfs_out
  // Only the two tails that end in @0x12a06 claim the building's holder slot.
  if (target.kind === 'building' && supply.kind !== 'resupply') {
    target.bld.serfRequested = true; // `bts $0x7` @0x12a06
  }
}
