/**
 * The AI's military and distribution policy - `FUN_0005af31`, slot 0 of the subtask table. Its body is
 * exactly two calls, and because the original has two routines there are two functions here:
 *
 * | Original | here | what |
 * |---|---|---|
 * | `FUN_000546ea` | {@link aiMilitaryPolicy} | attack style, shift change, recruiting, occupation level, castle garrison target |
 * | `FUN_0005af3c` | {@link aiDistributionPolicy} | all 9 tool priorities and all 14 distribution sliders |
 *
 * This is where the AI operates the menus a human sets by hand. All target fields live in the save.
 *
 * Five things are not obvious:
 *
 * 1. The building walk is defective, and the proof is its sibling: the bitmap bit index is set and
 *    tested as `vreg1` but counted down as `vreg7`, where the random number from the routine head still
 *    sits. The census has the same loop and counts correctly - one displacement byte of difference.
 *    The consequence is not "slot 0 is always tested": the bit index stays at 7 while the BYTE pointer
 *    advances, so from some building on the occupancy of slot 8 is tested instead. The truncating half
 *    is reproduced; the counting one (released slots with a stale record) stays impossible here because
 *    `freeBuildingSlot` sets `null`. That is the documented model boundary.
 * 2. Block 554 is written BEFORE the capping, so {@link Player.aiOccupationCap} only trims the chosen
 *    table row, not the stored value. Swapping the two loses every hit on real saves.
 * 3. The three cost tables carry their own proof: the last entry of each is exactly the garrison
 *    capacity 3 / 6 / 12 of hut / tower / fortress, which fixes the mapping table -> building type.
 * 4. The resource indices are not what the field names suggest: the `wheatDistribution` set hangs on
 *    fish + meat + bread, and `0x3b2` is steel, not coal. The coal value at @0x5b66d is a dead store -
 *    overwritten before it is read - and is omitted here rather than kept as a line that does nothing.
 * 5. In the "knights in the field" chain three of four additions check the carry and the doubling does
 *    not. Deliberately reproduced.
 *
 * The 23 distribution sliders are NOT byte-verifiable: their input is the census, which runs only every
 * 32nd AI tick. What carries there is the instruction-stream comparison plus a completeness argument -
 * the body writes exactly 23 player fields, and those are exactly the 23 modelled sliders.
 */
import type { Building, GameState, Inventory, Player } from './state.js';
import { u16 } from './int.js';
import { clampMax, satAdd, satSub } from './ai-evaluators.js';
import { recruitKnights } from './player-settings.js';

/** `flags` bit 1 — "on an attack the stronger knights attack" (`bts $0x1,%ax` @0x5471d). */
export const PLAYER_FLAG_STRONG_ATTACK = 1 << 1;

/** Reload value of the shift-change countdown (`mov $0x4b0` @0x54882) — 1200 ticks. */
export const AI_SHIFT_DURATION = 0x4b0;
/** Cooldown until the next shift change (`mov $0x3a98` @0x54890) — 15000. */
export const AI_SHIFT_COOLDOWN = 0x3a98;

/** Lower bound of free serfs the AI will not recruit (`cmpw $0xa` @0x54997/@0x549a6). */
export const AI_GENERIC_RESERVE = 10;

/** Resource indices {@link aiMilitaryPolicy} reads in the stock (`inv+0x36`/`inv+0x38` @0x54928/@0x54945). */
const RES_SWORD = 24;
const RES_SHIELD = 25;

/** Serf type of the first knight rank — `serfCount[22..26]` are the five ranks. */
const SERF_KNIGHT0 = 22;

/**
 * **The occupation table `@0x54da6`** — 16 rows of 4 bytes, from "expensive" to "cheap". The search
 * runs from row 0 downwards until the row's knight demand fits the supply; the **level** is
 * `16 - row`.
 *
 * Within a row, byte 0 is the **highest** threat level (the loop counts `vreg4` down from 3 while
 * reading forwards — `mov (%ebx),%al` @0x54bfa).
 */
export const OCCUPATION_TABLE: readonly (readonly number[])[] = [
  [4, 4, 4, 4], [4, 4, 4, 3], [4, 4, 4, 2], [4, 4, 3, 2],
  [4, 4, 3, 1], [4, 4, 2, 1], [4, 3, 2, 1], [4, 3, 2, 0],
  [4, 3, 1, 0], [4, 3, 0, 0], [4, 2, 0, 0], [4, 1, 0, 0],
  [3, 1, 0, 0], [2, 1, 0, 0], [2, 0, 0, 0], [1, 0, 0, 0],
];

/**
 * **The three cost tables `@0x54dea`** — knight demand per occupation value 0..4, indexed by the row
 * byte. Order in the binary: `+0` hut (`mov (%ebx,%esi,1),%al` @0x54c32), `+5` tower (@0x54c24), `+10`
 * fortress (@0x54c16).
 *
 * The last entry of each table is the full garrison — 3 / 6 / 12.
 */
export const OCCUPATION_COST: readonly (readonly number[])[] = [
  [1, 1, 2, 2, 3], // hut
  [1, 2, 3, 4, 6], // watchtower
  [1, 3, 6, 9, 12], // fortress
];

/** The three building types of the counting buffer, in the order of the cost tables. */
const MILITARY_TYPES = [11, 21, 22] as const;

/** How many threat levels a building can have (`andw $0x3` @0x54ac2). */
const THREAT_LEVELS = 4;

/**
 * **Tool policy**: per slider the shift with which the land size enters the target stock
 * (`shrw` @0x5af8a/@0x5b073/@0x5b0ef/@0x5b16b/@0x5b1e7/@0x5b263/@0x5b2df/@0x5b35a). Slider 1 (hammer)
 * has **no** shift — its target stock is the land size itself.
 *
 * Order == `toolPriority[0..8]` == resources 15..23 (shovel, hammer, rod, cleaver, scythe, axe, saw,
 * pick, pincer): the menu's slider order is the resource order, so no mapping table is needed.
 */
export const TOOL_LAND_SHIFT: readonly number[] = [2, 0, 2, 3, 2, 2, 3, 1, 3];

/** Resource index of the first tool (shovel) — `player+0x3ba` @0x5af6b. */
const RES_FIRST_TOOL = 15;

/** Target stock when **none** of a tool is present (`mov $0x10` @0x5af77). */
export const TOOL_DEMAND_EMPTY = 0x10;

/** Conversion target stock -> slider value (`mul %cx` with `mov $0xfff` @0x5afb4). */
export const TOOL_PRIORITY_SCALE = 0xfff;

/** Resource indices {@link aiDistributionPolicy} reads from the census. */
const RES = {
  Fish: 0, Meat: 2, Bread: 5, Boat: 8, Stone: 9, IronOre: 10, Steel: 11, GoldOre: 13,
} as const;

/** A 3x4 counting buffer for the military buildings — in the original the scratch pad at `gs+0xbc`. */
type MilitaryCount = number[][];

/**
 * **Attack style, shift change, recruiting, occupation, castle garrison target** — `FUN_000546ea`
 * @0x546ea.
 */
export function aiMilitaryPolicy(state: GameState, player: Player): void {
 // -- attack style: a random roll against the character trait.
 // `call 0x4e1e9` @0x546ea — the draw always happens, whatever the comparison yields.
  const roll = state.rng.next();
  if (roll < player.aiAttackStrongChance) {
    player.flags |= PLAYER_FLAG_STRONG_ATTACK; // `bts $0x1,%ax` @0x5471d
  } else {
    player.flags &= ~PLAYER_FLAG_STRONG_ATTACK; // `btr $0x1,%ax` @0x54707
  }

 // -- shift change: only when neither a cooldown nor a running change.
 // `or %ax,%ax ; jne 0x5489e` @0x54733 and @0x54746.
  if (player.aiShiftCooldown === 0 && player.knightShiftTimer === 0) {
    maybeStartKnightShift(player);
  }

 // -- recruiting: free serfs and weapon pairs across all own stocks.
  recruitFromStock(state, player);

 // -- occupation level and castle garrison target.
 // The roll from @0x546ea still sits in `0x1c(%edi)` while counting and drives the bitmap advance
 // there (module head, point 1) — surveyed: exactly two accesses to that slot in the body.
  const counts = countMilitaryBuildings(state, player, roll);
  let knights = 0; // `mov -0xe(%ebx),%ax` @0x54b0c, dann vier `add %ax,0x1c(%edi)` bis @0x54b3c
  for (let rank = 0; rank < 5; rank++) knights = u16(knights + (player.serfCount[SERF_KNIGHT0 + rank] ?? 0));
  player.aiKnightTotal = knights; // `mov %ax,0x1ac(%ebx)` @0x54b47

  player.knightMenuValue = castleGarrisonTarget(knights); // `mov %ax,0x18a(%ebx)` @0x54b8a

 // Available for the garrisons: everything above the castle target, of that 7/8.
  let available = satSub(knights, player.knightMenuValue); // `sub %ax,0x1c(%edi) ; jae` @0x54b94
  available = u16(available - (available >>> 3)); // `shrw $0x3` @0x54ba9 + `sub` @0x54bb0

  const level = chooseOccupationLevel(counts, available);
  player.aiKnightOccupationLevel = level; // `mov %ax,0x1aa(%ebx)` @0x54cf7 — BEFORE the capping

 // Only now does the character trait cap, and only the row choice.
  const capped = level > player.aiOccupationCap ? player.aiOccupationCap : level; // @0x54d0f
  applyOccupationRow(player, capped);
}

/**
 * The shift-change trigger (`@0x5474f`..`@0x5489e`). Three weighted sums: strong knights in stock,
 * knights in the field, own military buildings — and the change starts only when the buildings fall
 * below **both** knight measures (`jae 0x5489e` @0x5484f and @0x54858).
 */
function maybeStartKnightShift(player: Player): void {
  const idle = (rank: number): number => player.aiIdleSerfs[SERF_KNIGHT0 + rank] ?? 0;
  const count = (rank: number): number => player.serfCount[SERF_KNIGHT0 + rank] ?? 0;

 // strong knights in stock: ((K4*2 + K3)*2 + K2), every step saturating (`jb 0x5478a`).
  let stock = satAdd(idle(4), idle(4)); // `add %ax,(%edi)` @0x5475f
  stock = satAdd(stock, idle(3)); // @0x5476e
  stock = satAdd(stock, stock); // @0x54776
  stock = satAdd(stock, idle(2)); // @0x54785

 // knights in the field: ((K0-idleK0)*2 + K1 - idleK1)*2 + K2 - idleK2.
  let field = u16(count(0) - idle(0)); // @0x54794/@0x547a6
  field = satAdd(field, field); // @0x547ae
  field = satAdd(field, count(1)); // @0x547bb
  field = u16(field - idle(1)); // @0x547cb
  field = u16(field + field); // @0x547cf — **without** an overflow check, see the module head
  field = satAdd(field, count(2)); // @0x547de
  field = u16(field - idle(2)); // @0x547ee

 // military buildings, weighted: ((fortress*2 + tower)*2 + hut)*2.
  const done = (type: number): number => player.completedBuildingCount[type - 1] ?? 0;
  let forts = satAdd(done(22), done(22)); // @0x5480b
  forts = satAdd(forts, done(21)); // @0x54818
  forts = satAdd(forts, forts); // @0x54822
  forts = satAdd(forts, done(11)); // @0x5482f
  forts = satAdd(forts, forts); // @0x54839

  if (forts >= field || forts >= stock) return; // @0x5484f/@0x54858
  player.flags |= 1 << 2; // `bts $0x2,%ax` @0x54862 — a shift change is running
  player.flags |= 1 << 4; // `bts $0x4,%ax` @0x54876 — phase 1
  player.knightShiftTimer = AI_SHIFT_DURATION; // @0x54889
  player.aiShiftCooldown = AI_SHIFT_COOLDOWN; // @0x54897
}

/**
 * Recruiting from the own stocks (`@0x5489e`..`@0x549ce`). Two quantities are counted: the sum of free
 * serfs and the sum of **weapon pairs** per stock (`min(free, swords, shields)` — within the same
 * stock, like `countRecruitable`).
 *
 * Recruiting happens only if {@link AI_GENERIC_RESERVE} free serfs remain afterwards; otherwise the
 * number is trimmed accordingly and at <= 0 nothing is recruited.
 */
function recruitFromStock(state: GameState, player: Player): void {
  let pairs = 0; // vreg4
  let generics = 0; // vreg6
  for (const inv of state.inventories) {
    if (inv === null) continue;
    if (inv.owner !== player.slot) continue; // `cmp %al,(%edi) ; jne 0x54967` @0x5490e
    const free = inv.genericCount; // `mov 0x40(%ebx),%ax` @0x54915
    generics = u16(generics + free); // @0x54921
    let n = free;
    if ((inv.resources[RES_SWORD] ?? 0) <= n) n = inv.resources[RES_SWORD] ?? 0; // @0x54934
    if ((inv.resources[RES_SHIELD] ?? 0) <= n) n = inv.resources[RES_SHIELD] ?? 0; // @0x54951
    pairs = u16(pairs + n); // @0x54963
  }
  if (pairs === 0) return; // `or %ax,%ax` @0x54992, `je 0x549ce`
  if (generics < AI_GENERIC_RESERVE) return; // `cmpw $0xa,0x18(%edi)` @0x54997, `jb 0x549ce`
  let rest = u16(generics - pairs); // @0x549a2
  if (rest < AI_GENERIC_RESERVE) {
 // Below the reserve: trim by the difference (`neg %ax` @0x549b1, `addw $0xa` @0x549b8).
    rest = u16(AI_GENERIC_RESERVE - rest);
    if (pairs < rest) return; // `jb 0x549ce` @0x549c5 — trim larger than the number itself
    pairs = u16(pairs - rest);
    if (pairs === 0) return; // `je 0x549ce` @0x549c7
  }
  recruitKnights(state, player, pairs); // `call 0x2df33` @0x549c9
}

/**
 * The counting buffer of military buildings (`@0x549ce`..`@0x54b09`): 3 types x 4 threat levels. In the
 * original a scratch pad at `gs+0xbc`, first overwritten with 12 u16 zeroes (`mov $0xb` @0x549da, i.e.
 * 12 passes) — exactly 3 x 4 entries.
 */
function countMilitaryBuildings(state: GameState, player: Player, roll: number): MilitaryCount {
  const counts: MilitaryCount = MILITARY_TYPES.map(() => new Array<number>(THREAT_LEVELS).fill(0));
  let max = state.header.maxBuildingIndex;
 // The moving byte pointer (@0x54af2, module head point 1): when the roll underflows, from building
 // `roll + 1` on the occupancy of slot 8 is tested. If that is free the original counts nothing from
 // there — the rest of the loop runs empty. If slot 8 is occupied the advance has no effect, and that
 // is the case in every original save with `max > 8`.
  if (roll < max && (state.buildings[8] ?? null) === null) max = roll + 1;
  for (let i = 0; i < max; i++) {
 // The original's bitmap test @0x54a4f always checks slot 0 until the underflow and therefore always
 // passes — so it also counts released slots with a stale record. Our model holds free slots as
 // `null` and cannot reproduce that side effect.
 //
 // **Omitting the test is bound to ONE precondition**: slot 0 must be occupied, otherwise the
 // original's test does NOT always pass and the routine counts zero buildings while we count all of
 // them — the largest possible deviation. That precondition is established by
 // `new-game.ts::resetEntityTables` (@0x76bb).
    const bld: Building | null = state.buildings[i] ?? null;
    if (bld === null) continue;
    if (bld.owner !== player.slot) continue; // `andw $0x3` @0x54a6f, comparison @0x54a78
    if (bld.constructing) continue; // `andw $0xfc` @0x54a7e keeps bit 7 => sites drop out
    const group = MILITARY_TYPES.indexOf(bld.type as (typeof MILITARY_TYPES)[number]);
    if (group < 0) continue; // `jne 0x54ae3` @0x54a97 — any other type
    counts[group]![bld.threatLevel & 3]! += 1; // `addw $0x1,(%ebx,%esi,1)` @0x54ade
  }
  return counts;
}

/**
 * The castle target from the total knight count (`@0x54b52`..`@0x54b8a`) — a three-stage curve capped
 * at 99. It is the only writer of {@link Player.knightMenuValue} for AI players.
 */
export function castleGarrisonTarget(knights: number): number {
  let v = u16((knights >>> 2) + 3); // `shrw $0x2` @0x54b55, `addw $0x3` @0x54b59
  if (v >= 0x1e) {
    v = u16((v >>> 1) + 0xf); // @0x54b63/@0x54b66
    if (v >= 0x32) v = u16((v >>> 1) + 0x19); // @0x54b70/@0x54b73
  }
  return clampMax(v, 0x63); // `cmpw $0x64` @0x54b77, `mov $0x63` @0x54b7d
}

/**
 * The level search (`@0x54bbd`..`@0x54cf1`): from the most expensive row downwards until the knight
 * demand fits the supply. Returns `16 - row`, i.e. 1..16 — and **0** when no row fits (the counter then
 * underflows and `addw $0x1` @0x54ced turns it into 0).
 */
export function chooseOccupationLevel(counts: MilitaryCount, available: number): number {
  for (let row = 0; row < OCCUPATION_TABLE.length; row++) {
    let need = 0;
    for (let threat = THREAT_LEVELS - 1; threat >= 0; threat--) {
      const occ = OCCUPATION_TABLE[row]![THREAT_LEVELS - 1 - threat]!;
      for (let g = 0; g < MILITARY_TYPES.length; g++) {
 // `mul %cx` @0x54c5a/@0x54c7d/@0x54ca0 — 16-bit; the lower word is stored.
        need = u16(need + u16(counts[g]![threat]! * OCCUPATION_COST[g]![occ]!));
      }
    }
    if (available >= need) return OCCUPATION_TABLE.length - row; // `jae 0x54ce9` @0x54cdb
  }
  return 0;
}

/**
 * The occupation nibbles (`@0x54d1c`..`@0x54da3`): from the row byte `b` comes
 * `(b << 4) | max(0, b + level - 4)` — the maximum on top, the minimum below, falling with decreasing
 * threat.
 *
 * **Level 0 reads past the table**: `0x54da6 + 16*4 == 0x54de6`, and four zero bytes stand there. The
 * port reproduces that (row == four zeroes), because 13 of the 62 AI players stored exactly that state.
 */
function applyOccupationRow(player: Player, level: number): void {
  const row = OCCUPATION_TABLE.length - level;
  const bytes = OCCUPATION_TABLE[row] ?? [0, 0, 0, 0];
  const occ = player.knightOccupation as number[];
  for (let idx = THREAT_LEVELS - 1; idx >= 0; idx--) {
    const b = bytes[THREAT_LEVELS - 1 - idx]!;
    const hi = (b << 4) & 0xff; // `shlb $0x4` @0x54d67 — byte shift
    let lo = (b + idx) & 0xff; // `add %al,0x4(%edi)` @0x54d6d
    lo = lo < 4 ? 0 : lo - 4; // `subb $0x4,0x4(%edi)` @0x54d70, dann `jae`
    if (idx === 3 && hi === 0x30) lo = 1; // @0x54d7b/@0x54d81 — the original's special case
    occ[idx] = lo | hi; // `mov %al,-0x4(%ebx,%esi,1)` @0x54d9b
  }
}

/**
 * **Tool priorities and the 14 distribution sliders** — `FUN_0005af3c` @0x5af3c.
 *
 * The reference quantity is the own land size, clamped to `[0x400, 0xfff]` and shifted by 8 — so 1..15,
 * in practice 4..15 (`cmpl $0x1000` @0x5af47, `cmpw $0x400` @0x5af56, `shrw $0x8` @0x5af64).
 */
export function aiDistributionPolicy(player: Player): void {
  const land = u16(clampMax(Math.max(player.totalLandScore, 0x400), 0xfff) >>> 8);
  const stock = (res: number): number => player.aiStockpile[res] ?? 0;

 // -- The nine tool sliders. Target stock = (land >> shift) + 1 - stock.
  const tools = player.toolPriority as number[];
  let worst = 0;
  for (let t = 0; t < TOOL_LAND_SHIFT.length; t++) {
    const have = stock(RES_FIRST_TOOL + t);
    let demand: number;
    if (have === 0) {
      demand = TOOL_DEMAND_EMPTY; // `mov $0x10` @0x5af77
    } else {
      demand = satSub(u16((land >>> TOOL_LAND_SHIFT[t]!) + 1), have); // @0x5af8a..@0x5afa2
    }
 // The first slider sets the maximum, the rest raise it (@0x5afb0 and `jae` @0x5b021).
    if (t === 0 || worst < demand) worst = demand;
    tools[t] = u16(demand * TOOL_PRIORITY_SCALE); // @0x5afbf/@0x5afd6
  }

  const toolNeed = u16(worst * TOOL_PRIORITY_SCALE); // @0x5b3bf
  const planks = player.planksDistribution as number[];
  const steel = player.steelDistribution as number[];
  const coal = player.coalDistribution as number[];
  const wheat = player.wheatDistribution as number[];
  const food = player.foodDistribution as number[];

  planks[2] = toolNeed; // tool maker — `mov %ax,0x14c(%ebx)` @0x5b3de
  steel[0] = toolNeed; // tool maker — @0x5b3ec

  const inverted = u16(~toolNeed); // `not %ax` @0x5b3f7
  const invertedPlus = satAdd(inverted, 4000); // `addw $0xfa0,0xc(%edi)` @0x5b406, dann `jae`

 // -- The knight occupation of the highest threat level drives steel and gold.
  let steelWant = 0xffff; // @0x5b416 — a preset only the 0x40 branch leaves standing
  let goldWant = 0xffff;
  switch (player.knightOccupation[3]! & 0xf0) { // `andw $0xf0` @0x5b426
    case 0x40:
      steelWant = 0; // @0x5b493 — fully occupied: no extra steel
      break;
    case 0x30:
      steelWant = 30000; // @0x5b47f
      goldWant = 30000; // @0x5b486
      break;
    case 0x20:
      steelWant = 50000; // @0x5b46b
      goldWant = 20000; // @0x5b472
      break;
    case 0x10:
      steelWant = 60000; // @0x5b457
      goldWant = 10000; // @0x5b45e
      break;
    default:
      steelWant = 0xffff; // @0x5b443
      goldWant = 5000; // @0x5b44a
      break;
  }

  steel[1] = steelWant < inverted ? inverted : steelWant; // weapon smith — @0x5b49d/@0x5b4b0
  let goldCoal = goldWant < invertedPlus ? invertedPlus : goldWant; // @0x5b4bb
  if (stock(RES.Steel) >= 10) goldCoal = 0xffff; // `cmpw $0xa` @0x5b4d6
  coal[1] = goldCoal; // gold smelter — @0x5b4eb
  coal[2] = 45000; // weapon smith, constant — `mov $0xafc8` @0x5b4fa
 // steel smelter: the less steel, the higher (`shlw $0x8` @0x5b532, `addw $0x8000` @0x5b537).
  coal[0] = u16((u16(0x7f - clampMax(stock(RES.Steel), 0x7f)) << 8) + 0x8000);

 // -- Food decides between pig farm and mill.
  let foodStock = satAdd(stock(RES.Fish), stock(RES.Meat)); // @0x5b562
  foodStock = satAdd(foodStock, stock(RES.Bread)); // @0x5b571
  let scaled = u16(clampMax(foodStock, 0x7f) << 8); // @0x5b58b
  scaled = u16(scaled + scaled); // @0x5b592
  if (scaled < 0x8000) {
    wheat[1] = 0xffff; // mill — @0x5b5a3
    wheat[0] = u16(scaled + 0x8000); // pig farm — @0x5b5aa/@0x5b5b5
  } else {
    wheat[0] = 0xffff; // @0x5b5c8
    wheat[1] = u16(u16(~scaled) + 0x8000); // @0x5b5d2/@0x5b5e3
  }

 // -- Planks: construction gets everything as long as the tool shortage stays below 0xc000.
  let planksBuild = 0xffff; // @0x5b5ea
  let planksBoat = u16(satSub(8, stock(RES.Boat)) << 8); // @0x5b5f2..@0x5b612
  planksBoat = u16(planksBoat << 3); // @0x5b617 — so x 2048 in total
  if (planks[2]! >= 0xc000) { // `subw $0xc000,(%edi)` @0x5b629, dann `jb`
    planksBoat = 0; // @0x5b630
    const over = u16(u16(planks[2]! - 0xc000) * 2); // @0x5b63b
    planksBuild = u16(~over); // `not %ax` @0x5b641
  }
  planks[0] = planksBuild; // construction — @0x5b655
  planks[1] = planksBoat; // boat builder — @0x5b663

 // -- Mine food. The coal stock @0x5b66d is a dead store (see module head, point 4).
  const iron = stock(RES.IronOre); // @0x5b67a
  const quarter = u16(iron >>> 2); // @0x5b68c
  let demand = u16(u16(iron + iron) - quarter); // @0x5b694/@0x5b69b
  demand = satAdd(demand, stock(RES.GoldOre)); // @0x5b6a9
  const steelHave = stock(RES.Steel); // @0x5b6ba
  demand = u16(demand + u16(steelHave - (steelHave >>> 2))); // @0x5b6d6/@0x5b6de
  let coalFood: number;
  let ironFood: number;
  if (demand >= quarter) { // `jb 0x5b71d` @0x5b6e9
    ironFood = u16(~u16(clampMax(u16(demand - quarter), 0xdb) << 8)); // @0x5b6ee..@0x5b70e
    coalFood = 0xffff; // @0x5b712
  } else {
    coalFood = u16(~u16(clampMax(u16(quarter - demand), 0xdb) << 8)); // @0x5b721..@0x5b73c
    ironFood = 0xffff; // @0x5b73f
  }

  const stoneFood = u16(~u16(clampMax(stock(RES.Stone), 0x17) << 11)); // @0x5b755..@0x5b775
  food[0] = stoneFood; // stone mine — @0x5b780
  if (stoneFood >= 45000) { // `cmpw $0xafc8` @0x5b787
    coalFood = coalFood >>> 1;
    ironFood = ironFood >>> 1;
    if (stoneFood >= 60000) { // `cmpw $0xea60` @0x5b796
      coalFood = coalFood >>> 1;
      ironFood = ironFood >>> 1;
    }
  }
  food[1] = coalFood; // coal mine — @0x5b7ab
  food[2] = ironFood; // iron mine — @0x5b7b9
  food[3] = goldCoal < ironFood ? goldCoal : ironFood; // gold mine — @0x5b7c4/@0x5b7d9
}

/** Slot 0 of the subtask table — `FUN_0005af31` @0x5af31 calls exactly these two routines. */
export function aiPolicySubtask(state: GameState, player: Player): void {
  aiMilitaryPolicy(state, player); // `call 0x546ea` @0x5af31
  aiDistributionPolicy(player); // `call 0x5af3c` @0x5af36
}

/** For the tests only: the inventory view {@link recruitFromStock} uses. */
export type { Inventory };
