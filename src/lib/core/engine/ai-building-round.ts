/**
 * The AI's building round (`FUN_00052271`), slot 3 of the subtask table: it walks its own buildings in
 * turn, asks of each whether it is still worth it, and tears down the ones that are not.
 *
 * The frame is small; the weight sits in the handlers behind the jump table, 25 slots indexed by
 * building type. A budget of 501 buildings per appointment, starting at the stored cursor; a slot is
 * visited only when it is occupied, not burning, not under construction and belongs to the player.
 *
 * Two subtleties of the loop foot that get lost when rebuilding it: the comparison is `jb`/`je`, so
 * index `maxBuildingIndex` IS still visited; and the wrap does not jump back but falls through to the
 * store, so an appointment never continues past the map boundary.
 *
 * Of the 25 slots, 15 are one-byte `ret` stubs. Real bodies exist only for the types whose yield
 * depends on their surroundings, plus warehouse and farm:
 *
 * | Type | What is searched for | Positions | Cost |
 * |---|---|---|---|
 * | 1 fisher | tile with a remaining amount (fish) | 64 | 10 |
 * | 2 lumberjack | tree object `0x08..0x17` | 128 | 20 |
 * | 4 stonecutter | stone pile `0x48..0x4f` | 128 | 20 |
 * | 5..8 mines | deposit of its own resource | 32 | 5 |
 * | 9 forester | free meadow (terrain byte `0x55`) | 128 | 20 |
 * | 10 warehouse | - (storage policy) | 258 | 10 |
 * | 12 farm | - (food balance) | - | 0 |
 *
 * A scan that finds nothing demolishes and sets the budget to -1, so an appointment ends immediately
 * after a demolition. The task calls no `rng_next` and therefore does not shift the random stream.
 *
 * The four mine bodies are byte-identical apart from one comparison byte, hence one scan routine with
 * a predicate table.
 *
 * The fisher checks three things, and only the third is obvious: any object or the water bit, then the
 * block marker, then the remaining amount. On real data the two pre-tests are redundant, but they are
 * not trivially so - reproduced rather than simplified away.
 *
 * The farm computes instead of searching: it sums the first six goods of the census and derives an
 * allowed farm count from eight thresholds - the more food, the fewer farms are allowed. Below the
 * lowest threshold nothing happens at all.
 *
 * The warehouse body is the largest and tears down nothing: it is the storage policy. Starting at ring
 * 2 it looks for the first own active military building and then sets the store / accept nothing /
 * empty out marks for goods and serfs, deciding on THAT building's threat level plus a weighted
 * valuation of the stored valuables (a Horner scheme by refinement: gold bar 64 down to boat and stone
 * 4; food, timber and planks do not count). So a warehouse at the front is emptied at 500 points, one
 * in safe hinterland only at 15000.
 *
 * Two things the AI does differently from the human, both evidenced in the instruction stream: it does
 * NOT call the clean-up walks for resource and serf destinations, and its switching depends on a
 * cooldown that blocks after enough switches.
 *
 * The goods eviction is practically unreachable: the pre-check returns -1 while the warehouse flag
 * still accepts, and the error branch sets "store" again - a fixed point the AI cannot leave. The serf
 * branch differs because its pre-check returns the own index. Reproduced, not repaired.
 */
import type { GameState, Player, Building, Inventory } from './state.js';
import { posOf } from './position.js';
import { spiralPos } from './spiral.js';
import { demolishBuilding } from './buildings.js';
import { findNearestResourceInventory } from './flag-update.js';
import { findNearestInventory } from './serf-movement.js';
import { MODE_IN, MODE_STOP, MODE_OUT } from './inventory-mode.js';

/** Budget of one appointment: `mov $0x1f4` @0x52271, with `subw $1`+`js` => **501** visited slots. */
export const AI_ROUND_BUDGET = 500;

/** Cost of one warehouse pass (`subw $0xa` @0x53063/@0x5309c). */
export const AI_ROUND_STOCK_COST = 10;
/** Surcharge per eviction attempt (`subw $0x64` @0x52cf1/@0x52ed8). */
export const AI_ROUND_MODE_COST = 100;

/** Cooldown cap and the two increments: `cmpw $0x2710` / `addw $0x2328` / `$0xbb8`. */
export const AI_ROUND_TIMER_CAP = 0x2710;
export const AI_ROUND_TIMER_STEP_RES = 0x2328;
export const AI_ROUND_TIMER_STEP_SERF = 0xbb8;

// -- The handler table @0x523da -------------------------------------------------------------------

/**
 * What a scan body looks for. `kind` names the one test in which the eight bodies differ; everything
 * else (prologue, spiral walk from index 1, demolition on falling through) is identical.
 */
export type AiScanKind = 'fish' | 'tree' | 'stone' | 'mineral' | 'grass';

export interface AiRoundScan {
  /** Building type == slot in the jump table. */
  readonly type: number;
  /** Entry of the body in the binary (target of the `jmp` in the table slot). */
  readonly entry: number;
  /** Number of spiral positions checked (`mov $0x3f/$0x7f/$0x1f` + 1). */
  readonly positions: number;
  /** Budget deduction at the end of the body (`subw $imm8,0x1c(%edi)`). */
  readonly cost: number;
  readonly kind: AiScanKind;
  /** Only for `kind === 'mineral'`: the comparison byte of the `cmpb` (`(mineral << 5)`). */
  readonly mineralByte?: number;
}

/**
 * The **eight** resource scans, in table order (types 1/2/4/5/6/7/8/9). Kept as **data** so that
 * position count, cost and predicate can be held against the instruction stream per body — with eight
 * hand-written bodies that would not be checkable.
 *
 * It is eight, not seven: the table in the module head folds the four mines into **one** row.
 */
export const AI_ROUND_SCANS: readonly AiRoundScan[] = [
  { type: 1, entry: 0x52523, positions: 64, cost: 10, kind: 'fish' },
  { type: 2, entry: 0x525c8, positions: 128, cost: 20, kind: 'tree' },
  { type: 4, entry: 0x52660, positions: 128, cost: 20, kind: 'stone' },
  { type: 5, entry: 0x526f7, positions: 32, cost: 5, kind: 'mineral', mineralByte: 0x80 },
  { type: 6, entry: 0x52784, positions: 32, cost: 5, kind: 'mineral', mineralByte: 0x60 },
  { type: 7, entry: 0x52811, positions: 32, cost: 5, kind: 'mineral', mineralByte: 0x40 },
  { type: 8, entry: 0x5289e, positions: 32, cost: 5, kind: 'mineral', mineralByte: 0x20 },
  { type: 9, entry: 0x5292b, positions: 128, cost: 20, kind: 'grass' },
];

/**
 * All 25 table slots: jump target in the binary, and whether a real body or a `ret` stub sits there.
 * The stub addresses `0x531e6..0x531f1` lie back to back — twelve individual `c3` bytes.
 */
export const AI_ROUND_DISPATCH: readonly { readonly target: number; readonly stub: boolean }[] = [
  { target: 0x52522, stub: true },   //  0 None
  { target: 0x52523, stub: false },  //  1 Fisher
  { target: 0x525c8, stub: false },  //  2 Lumberjack
  { target: 0x5265f, stub: true },   //  3 Boatbuilder
  { target: 0x52660, stub: false },  //  4 Stonecutter
  { target: 0x526f7, stub: false },  //  5 StoneMine
  { target: 0x52784, stub: false },  //  6 CoalMine
  { target: 0x52811, stub: false },  //  7 IronMine
  { target: 0x5289e, stub: false },  //  8 GoldMine
  { target: 0x5292b, stub: false },  //  9 Forester
  { target: 0x529d8, stub: false },  // 10 Warehouse
  { target: 0x530b6, stub: true },   // 11 Hut
  { target: 0x530b7, stub: false },  // 12 Farm
  { target: 0x531e6, stub: true },   // 13 Butcher
  { target: 0x531e7, stub: true },   // 14 PigFarm
  { target: 0x531e8, stub: true },   // 15 Mill
  { target: 0x531e9, stub: true },   // 16 Baker
  { target: 0x531ea, stub: true },   // 17 Sawmill
  { target: 0x531eb, stub: true },   // 18 SteelSmelter
  { target: 0x531ec, stub: true },   // 19 ToolMaker
  { target: 0x531ed, stub: true },   // 20 WeaponSmith
  { target: 0x531ee, stub: true },   // 21 Tower
  { target: 0x531ef, stub: true },   // 22 Fortress
  { target: 0x531f0, stub: true },   // 23 GoldSmelter
  { target: 0x531f1, stub: true },   // 24 Castle
];

// -- Farm ------------------------------------------------------------------------------------------

/** The six goods the farm body sums (`player+0x39c..0x3a6` == `aiStockpile[0..5]`). */
export const AI_FARM_FOOD_SLOTS: readonly number[] = [0, 1, 2, 3, 4, 5];

/**
 * The threshold cascade @0x5311d..@0x53163, in reading order: `[bound, allowed farms]`. Below the first
 * bound **nothing** happens (`level` stays unset), hence the `null`.
 */
export const AI_FARM_LEVELS: readonly { readonly below: number; readonly level: number | null }[] = [
  { below: 0x1f4, level: null }, // < 500  => return
  { below: 0x258, level: 8 },    // < 600
  { below: 0x2bc, level: 7 },    // < 700
  { below: 0x320, level: 6 },    // < 800
  { below: 0x384, level: 5 },    // < 900
  { below: 0x3e8, level: 4 },    // < 1000
  { below: 0x5dc, level: 3 },    // < 1500
  { below: 0x7d0, level: 2 },    // < 2000
  { below: Infinity, level: 1 }, // otherwise
];

// -- Warehouse -------------------------------------------------------------------------------------

/** Spiral start index of the warehouse scan (`add $0x1c` @0x52a2c => entry 7 == ring 2). */
export const AI_STOCK_SCAN_FIRST = 7;
/** Number of positions checked (`mov $0x101` @0x52a32, with `subw $1`+`jae` => 258). */
export const AI_STOCK_SCAN_POSITIONS = 258;

/**
 * The four military building types the warehouse looks for — as the **raw `bld[4] & 0xfc` pattern**
 * like the original (@0x52b0f..@0x52b24). The mask keeps bit 7, so a building *under construction*
 * matches none of the four values; that is the original's implicit construction test and is deliberately
 * reproduced.
 */
export const AI_STOCK_MILITARY_PATTERNS: readonly number[] = [0x2c, 0x54, 0x58, 0x60];

/**
 * The threshold table @0x52e28 — four rows of four u16, indexed by `threatLevel << 3`. Columns: goods
 * *empty out*, goods *stop*, serfs *empty out*, serfs *stop*.
 *
 * **Layout proof:** `0x52e28 + 4*8 == 0x52e48` == the next code entry (the `modeIn` branch).
 */
export const AI_STOCK_THRESHOLDS: readonly (readonly number[])[] = [
  [15000, 10000, 200, 100],
  [4000, 3000, 200, 100],
  [1000, 600, 200, 100],
  [500, 0, 0, 0],
];

/**
 * The valuation chain @0x52b7d..@0x52ccf, step by step: a number list adds those inventory slots,
 * `'double'` doubles. Kept as a sequence because the **order** carries the weighting (Horner) — as a
 * weight table it could not be checked against the instruction stream.
 */
export const AI_STOCK_SCORE_STEPS: readonly (readonly number[] | 'double')[] = [
  [14],                                  // GoldBar
  'double',
  [24, 25, 13],                          // sword, shield, gold ore
  'double',
  [15, 16, 17, 18, 19, 20, 21, 22, 23],  // the nine tools
  'double',
  [10, 11, 12],                          // iron ore, steel, coal
  'double',
  [8, 9],                                // boat, stone
  'double',
  'double',
];

// -- Helpers ---------------------------------------------------------------------------------------

/** 16-bit saturation like the original's `jb` chain: any overflow clamps to `0xffff`. */
function sat16(v: number): number {
  return v > 0xffff ? 0xffff : v;
}

/**
 * The tile `index` spiral steps around `pos`. The original computes in byte offsets
 * (`pos + gs[0xc4][i]`, masked with `gs+0`); `spiralPos` does the same torus arithmetic.
 */
function scanTile(state: GameState, pos: number, index: number) {
  return state.mapTiles[spiralPos(pos, index, state.geo)];
}

// -- The resource scans ------------------------------------------------------------------------------

/**
 * Byte 0 of the game tuple, **raw** — the way the original reads it (@0x5259c, @0x52752).
 *
 * The tuple is a **union**: only for `object` outside [1,4] does it hold `(mineral << 5) | amount`; if
 * the tile carries a flag or a building, it holds the low byte of the **object index**. Using the
 * decoded view here would never see a building in the ring as a hit. Measured over 897 completed scan
 * buildings: **12 of 83 fisher huts** flip the outcome that way (the original finds something, the
 * decoded view does not — and tears the hut down); no mine flips, but 83 of 297 have such a hit in the
 * ring that is merely masked by a real deposit.
 */
function rawGameByte0(t: { object: number; objIndex: number; mineral: number; resourceAmount: number }): number {
  if (t.object >= 1 && t.object <= 4) return t.objIndex & 0xff;
  return ((t.mineral << 5) | t.resourceAmount) & 0xff;
}

export function aiScanHit(state: GameState, scan: AiRoundScan, pos: number, index: number): boolean {
  const t = scanTile(state, pos, index);
  if (t === undefined) return false;
  switch (scan.kind) {
    case 'fish':
      // @0x5257c `landscape[3] != 0` — the **whole** byte, i.e. object OR water bit. The latter is,
      // across every original save, iff-equivalent to "has a water triangle".
      if (t.object === 0 && !(t.terrainUp <= 3 || t.terrainDown <= 3)) return false;
      if (!t.blocked) return false;                                  // @0x52588 `bt $0x6`
      return rawGameByte0(t) !== 0;                                  // @0x5259c `game[0] != 0` — RAW
    case 'tree':
      // @0x52629/@0x52630: `0x8 <= object < 0x18` (conifers and broadleaf trees).
      return t.object >= 0x08 && t.object < 0x18;
    case 'stone':
      // @0x526c1/@0x526c8: `0x48 <= object < 0x50` (the eight stone pile stages).
      return t.object >= 0x48 && t.object < 0x50;
    case 'mineral':
      // @0x52752/@0x52756: `(game[0] & 0xe0) == mineralByte`.
      return (rawGameByte0(t) & 0xe0) === scan.mineralByte;
    case 'grass':
      // @0x5298a `landscape[0] & 0x7f` — path bits AND block marker must be clear; @0x5299c object
      // free (`landscape[3] & 0x7f`, without the water bit); @0x529aa terrain byte exactly `0x55`.
      if (t.paths !== 0 || t.blocked) return false;
      if (t.object !== 0) return false;
      return ((t.terrainUp << 4) | t.terrainDown) === 0x55;
  }
}

/**
 * One scan body: walk the spiral positions `1..positions` and stop at the first hit. Without a hit the
 * loop falls through and the building is torn down (`call 0x531f2`).
 *
 * Returns the budget deduction. The original subtracts the cost in **both** cases (the success jump
 * lands exactly on the `subw`) and on a demolition sets the budget to -1 beforehand — hence a
 * demolition reports `demolished` and the caller ends the appointment.
 */
function runScan(
  state: GameState, scan: AiRoundScan, bld: Building,
): { readonly cost: number; readonly demolished: boolean } {
  const pos = posOf(bld.col, bld.row, state.geo);
  for (let i = 1; i <= scan.positions; i++) {
    if (aiScanHit(state, scan, pos, i)) return { cost: scan.cost, demolished: false };
  }
  demolishBuilding(state, bld); // @0x531f2 → `demolish_building` @0x48eb8
  return { cost: scan.cost, demolished: true };
}

// -- The farm --------------------------------------------------------------------------------------

/** The census food sum, saturated (@0x530b7..@0x5311a). */
export function aiFarmFoodTotal(player: Player): number {
  let sum = 0;
  for (const slot of AI_FARM_FOOD_SLOTS) sum = sat16(sum + (player.aiStockpile?.[slot] ?? 0));
  return sum;
}

/** The allowed farm count for a food sum; `null` == cascade skipped, do nothing. */
export function aiFarmAllowedCount(food: number): number | null {
  for (const step of AI_FARM_LEVELS) if (food < step.below) return step.level;
  return null;
}

/**
 * `0x530b7` — the farm checks the food balance instead of its surroundings. `completedBuildingCount` is
 * indexed by `type - 1`, and the farm is type 12 => index 11 (`player+0x1a` @0x531c4).
 */
function runFarm(state: GameState, player: Player, bld: Building): boolean {
  const food = aiFarmFoodTotal(player);
  const allowed = aiFarmAllowedCount(food);
  if (allowed === null) return false; // @0x53123 `jb 0x531e5`
  const farms = player.completedBuildingCount?.[11] ?? 0;
  if (allowed >= farms) return false; // @0x531d4 `jae 0x531e5`
  demolishBuilding(state, bld);
  return true;
}

// -- The warehouse ---------------------------------------------------------------------------------

/** The weighted valuation of the stored valuables (@0x52b7d..@0x52ccf). */
export function aiStockScore(inv: Inventory): number {
  let s = 0;
  for (const step of AI_STOCK_SCORE_STEPS) {
    if (step === 'double') { s = sat16(s + s); continue; }
    for (const res of step) s = sat16(s + (inv.resources[res] ?? 0));
  }
  return s;
}

/** Sets the goods mode and flag bit. Without the clean-up walks — the AI demonstrably does not call them. */
function setResourceMode(state: GameState, inv: Inventory, mode: number): void {
  inv.resMode = mode;
  inv.resDir = (inv.resDir & ~0x3) | mode;
  const f = state.flags[inv.flag];
  if (f) f.acceptsResources = mode === MODE_IN; // flag[0x44] Bit 7
}

/** Sets the serf mode and flag bit; likewise without a clean-up walk. */
function setSerfMode(state: GameState, inv: Inventory, mode: number): void {
  inv.serfMode = mode;
  inv.resDir = (inv.resDir & ~0xc) | (mode << 2);
  const f = state.flags[inv.flag];
  if (f) f.acceptsSerfs = mode === MODE_IN; // flag[0x42] Bit 7
}

/** Finds, from ring 2 on, the first own active military building — the trigger of the whole policy. */
export function aiStockFindMilitary(
  state: GameState, player: Player, bld: Building,
): Building | null {
  const pos = posOf(bld.col, bld.row, state.geo);
  for (let i = 0; i < AI_STOCK_SCAN_POSITIONS; i++) {
    const tile = state.mapTiles[spiralPos(pos, AI_STOCK_SCAN_FIRST + i, state.geo)];
    if (tile === undefined) continue;
    // @0x52a7e/@0x52a88: object byte in [2,5) — small/large building or castle.
    if (tile.object < 2 || tile.object >= 5) continue;
    const other = state.buildings[tile.objIndex];
    if (!other) continue;
    if (other.owner !== player.slot) continue;         // @0x52ade
    if (!other.active) continue;                       // @0x52af0 `bt $0x4`
    const pattern = (other.constructing ? 0x80 : 0) | ((other.type & 0x1f) << 2);
    if (!AI_STOCK_MILITARY_PATTERNS.includes(pattern)) continue; // @0x52b0f..@0x52b24
    return other;
  }
  return null;
}

/**
 * `0x529d8` — the storage policy. Returns the budget deduction (the `holder` case costs nothing,
 * because the original returns before the prologue there, @0x529ec).
 */
function runStock(state: GameState, player: Player, bld: Building, slot: number): number {
  if (!bld.holder) return 0;                       // @0x529e0 `bt $0x6,bld[5]`
  const military = aiStockFindMilitary(state, player, bld);
  if (military === null) return AI_ROUND_STOCK_COST;
  const inv = bld.inventoryIndex === null ? null : state.inventories[bld.inventoryIndex];
  const flag = state.flags[bld.flag];
  if (!inv || !flag) return AI_ROUND_STOCK_COST;

  const row = AI_STOCK_THRESHOLDS[military.threatLevel & 3];
  let cost = AI_ROUND_STOCK_COST;

  // -- goods (valuation from @0x52b7d, confluence @0x52e9c) --
  const score = aiStockScore(inv);
  if (score >= row[0]) {
    cost += AI_ROUND_MODE_COST;                    // @0x52cf1
    if (findNearestResourceInventory(state, flag) < 0) {
      setResourceMode(state, inv, MODE_IN);        // @0x52d25 `js 0x52e48`
    } else if ((inv.resMode & 2) !== 0) {
      setResourceMode(state, inv, MODE_OUT);       // @0x52d3d `jne 0x52d65` — already "out"
    } else if (player.aiTimer562 >= AI_ROUND_TIMER_CAP) {
      setResourceMode(state, inv, MODE_STOP);      // @0x52d57 `jae 0x52dd2` — cooldown
    } else {
      // @0x52d5c `addw` — no overflow test, so plain 16-bit arithmetic.
      player.aiTimer562 = (player.aiTimer562 + AI_ROUND_TIMER_STEP_RES) & 0xffff;
      setResourceMode(state, inv, MODE_OUT);
    }
  } else if (score >= row[1]) {
    setResourceMode(state, inv, MODE_STOP);        // @0x52dd0 → 0x52dd2
  } else {
    setResourceMode(state, inv, MODE_IN);          // @0x52dd0 `jb 0x52e48`
  }

  // -- serfs (from @0x52e9c, confluence @0x5304f) --
  const idle = inv.genericCount;
  if (idle >= row[2]) {
    cost += AI_ROUND_MODE_COST;                    // @0x52ed8
    // ORIGINAL DEFECT, reproduced: the hand-over sets `0x24(%edi)` to the flag pointer (@0x52ef1),
    // but `0x44703` reads `(%edi)` (`mov (%edi),%ax` @0x4473b, then `mul $0x46` and `+ gs[0x98]`) —
    // and `(%edi)` carries the outer loop's cursor here, i.e. a BUILDING slot index. Neither in the
    // whole warehouse body nor in `0x44a52..0x44d80` nor in `0x44703..0x44a01` is there a store to
    // `(%edi)`. The contrast proves it is not a misreading: the GOODS search `0x44a52` does read
    // `0x24(%edi)` (@0x44a8a).
    if (findNearestInventory(state, slot) === null) {
      setSerfMode(state, inv, MODE_IN);            // @0x52f0c `js 0x52ffb`
    } else if ((inv.serfMode & 2) !== 0) {
      setSerfMode(state, inv, MODE_OUT);           // @0x52f24 `jne 0x52f4c`
    } else if (player.aiTimer562 >= AI_ROUND_TIMER_CAP) {
      setSerfMode(state, inv, MODE_STOP);          // @0x52f3e `jae 0x52fa5`
    } else {
      player.aiTimer562 = (player.aiTimer562 + AI_ROUND_TIMER_STEP_SERF) & 0xffff; // @0x52f43
      setSerfMode(state, inv, MODE_OUT);
    }
  } else if (idle < row[3]) {
    setSerfMode(state, inv, MODE_IN);              // @0x52ecd `jb 0x52ffb`
  } else {
    setSerfMode(state, inv, MODE_STOP);            // @0x52ed3 `jmp 0x52fa5`
  }

  return cost;
}

// -- The frame -------------------------------------------------------------------------------------

const SCAN_BY_TYPE = new Map(AI_ROUND_SCANS.map((s) => [s.type, s]));

/**
 * `FUN_00052271` — the building round. Walks its own buildings from the stored cursor until the budget
 * runs out or `maxBuildingIndex` is passed.
 *
 * Returns the number of visited (not skipped) buildings — for the tests only.
 */
export function aiBuildingRoundTask(state: GameState, player: Player): number {
  let budget = AI_ROUND_BUDGET;
  let cursor = player.aiBuildingCursor ?? 0;
  let handled = 0;
  const maxIndex = state.header.maxBuildingIndex; // @0x523ac `gs[0x260]`

  for (;;) {
    const bld = state.buildings[cursor];
    // Occupied (@0x52326 bitmap bit), not burning (@0x52339), not building (@0x52350), own (@0x52361).
    if (bld && !bld.burning && !bld.constructing && bld.owner === player.slot) {
      handled++;
      const scan = SCAN_BY_TYPE.get(bld.type);
      if (scan !== undefined) {
        const r = runScan(state, scan, bld);
        budget = r.demolished ? -1 - r.cost : budget - r.cost;
      } else if (bld.type === 10) {
        budget -= runStock(state, player, bld, cursor);
      } else if (bld.type === 12) {
        // The demolition does NOT end the appointment: between `call 0x531f2` and the `ret` there is
        // nothing (@0x531e0..@0x531e5). The original tears down several farms in one appointment and
        // works through the remaining up to 500 slots.
        runFarm(state, player, bld);
      }
      // All remaining types (0, 3, 11, 13..24) are `ret` stubs @0x531e6..@0x531f1 — nothing to do.
    }
    cursor++;
    budget--;
    if (budget < 0) break;              // @0x523a7 `js 0x523c9`
    if (cursor > maxIndex) {            // @0x523b6/@0x523bc: `jb`/`je` => `<=` keeps going
      cursor = 0;                       // @0x523c2 — and the appointment ends here
      break;
    }
  }

  player.aiBuildingCursor = cursor & 0xffff; // @0x523cf
  return handled;
}
