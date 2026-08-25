/**
 * **The counting behind the statistics screens** (menu 8) — port of the collection loops. The
 * screens themselves (layouts, zones, drawing) live in `stats-popup.ts`.
 *
 * | Function | Original | For |
 * |---|---|---|
 * | {@link stockTotals} | head of `FUN_0003d3fb` | screen 0x09: resources of all own warehouses |
 * | {@link serfCensusTotal} | sum chain in `FUN_0003db43` | screen 0x12: total population |
 * | {@link collectFillLevels} | `FUN_00040117` / `FUN_0004051d` + `FUN_00040a29`.. | screens 0x10/0x11 |
 *
 * The building and people **counts** need no collecting: `completedBuildingCount`,
 * `incompleteBuildingCount` and `serfCount` are cached player fields that the original reads just as
 * directly.
 */

import type { Building, GameState, Player } from './state.js';

const RESOURCE_COUNT = 26;
/** The `serf_count` entry that screen 0x12's total **skips** (type 4). */
export const SERF_CENSUS_SKIPPED_TYPE = 4;
const RES_PLANK = 7;
const RES_STONE = 9;

/**
 * **Resource totals over all of the player's warehouses** — the head of `FUN_0003d3fb`
 * (screen 0x09):
 *
 * ```
 * 26x buf = 0
 * buf[Plank] += player[0x164] ; buf[Stone] += player[0x165]     // the parked building reserve
 * for every warehouse with owner == player:
 *    for res = 25..0:  buf[res] += inv[res] ; on overflow buf[res] = 0xffff
 * ```
 *
 * The saturation branch is real (a `jnc` jump in the original): the display clamps at 65535 instead
 * of wrapping. The reserve is added in the same way as in the castle popup.
 */
export function stockTotals(state: GameState, player: Player): number[] {
  const buf = new Array<number>(RESOURCE_COUNT).fill(0);
  buf[RES_PLANK] += player.heldPlanks;
  buf[RES_STONE] += player.heldStone;
  for (const inv of state.inventories) {
    if (inv === null || inv.owner !== player.slot) continue;
    for (let res = RESOURCE_COUNT - 1; res >= 0; res--) {
      const sum = buf[res]! + (inv.resources[res] ?? 0);
      buf[res] = sum > 0xffff ? 0xffff : sum;
    }
  }
  return buf;
}

/**
 * **Total population** for screen 0x12: the sum over `serfCount` **without** index
 * {@link SERF_CENSUS_SKIPPED_TYPE} — the original adds 26 of the 27 entries and leaves out exactly
 * that one (type 4 is the internal duplicate entry "carrier in the warehouse").
 */
export function serfCensusTotal(player: Player): number {
  let total = 0;
  for (let t = 0; t < player.serfCount.length; t++) {
    if (t === SERF_CENSUS_SKIPPED_TYPE) continue;
    total = (total + player.serfCount[t]!) & 0xffff;
  }
  return total;
}

// --- Fill levels (screens 0x10 / 0x11) -----------------------------------------------------------

/**
 * How a building pays into its fill-level bucket. Five variants:
 *
 * | Kind | Original | Computation |
 * |---|---|---|
 * | `stock8` | `FUN_00040a29` | only with a worker (`bld+5` bit 6); `(b8 & 0xf) + ((b8 & 0xf0) >> 3)` |
 * | `stock9` | `FUN_00040a53` | same with `bld+9` |
 * | `norm8` | `FUN_00040ab2` | **no** worker gate; the value above `<< 4` divided by `2*bld[0x10]` |
 * | `norm9` | `FUN_00040ad8` | same with `bld+9` / `2*bld[0x11]` |
 * | `gold2/4/8` | `FUN_00040b62/6e/7a` | like `norm9` but with a **fixed** ceiling of 2/4/8 |
 *
 * The divisor is always **twice** the maximum (`add` onto itself), matching the fact that the
 * `available` nibble enters weighted by `>> 3`, i.e. doubled. With divisor 0 the building pays
 * nothing in, not even into the count.
 */
export type FillKind = 'stock8' | 'stock9' | 'norm8' | 'norm9' | 'gold2' | 'gold4' | 'gold8';

/**
 * One entry of a fill-level screen's type chain: encoded type -> bucket + kind of computation.
 * `byteSlot` is the **original byte offset** in the scratch buffer; a bucket is 6 bytes there
 * (u32 sum + u16 count), so `bucket = byteSlot / 6`.
 */
export interface FillRule {
  readonly codedType: number;
  readonly byteSlot: number;
  readonly kind: FillKind;
}

/** Size of a bucket in the original buffer: u32 sum + u16 count. */
export const FILL_SLOT_BYTES = 6;

/** One fill-level bucket: sum of the contributions and number of contributing buildings. */
export interface FillSlot {
  sum: number;
  count: number;
}

/** `(b & 0xf) + ((b & 0xf0) >> 3)` — the weighted stock of one resource slot. */
function weightedStock(b: number): number {
  return (b & 0xf) + ((b & 0xf0) >> 3);
}

const GOLD_LIMIT: Record<string, number> = { gold2: 2, gold4: 4, gold8: 8 };

function contribute(slot: FillSlot, kind: FillKind, bld: Building): void {
  const s0 = bld.stock[0];
  const s1 = bld.stock[1];
  const byte8 = ((s0.available & 0xf) << 4) | (s0.requested & 0xf);
  const byte9 = ((s1.available & 0xf) << 4) | (s1.requested & 0xf);
  const max = bld.stockMaximum;

  if (kind === 'stock8' || kind === 'stock9') {
    if (!bld.holder) return; // `bt $0x6, bld[5]` — without a worker the building does not count
    slot.sum += weightedStock(kind === 'stock8' ? byte8 : byte9);
    slot.count += 1;
    return;
  }

  const value = weightedStock(kind === 'norm8' ? byte8 : byte9);
  let limit: number;
  // `stockMaximum` is only populated for construction sites (verified: 0 on finished buildings), so
  // reading `null` as 0 is exactly what the original sees when it reads those bytes.
  if (kind === 'norm8') limit = max === null ? 0 : max[0];
  else if (kind === 'norm9') limit = max === null ? 0 : max[1];
  else limit = GOLD_LIMIT[kind]!;
  const divisor = limit * 2;
  if (divisor === 0) return; // `jz` — no contribution, not even to the count
  slot.sum += Math.floor((value << 4) / divisor);
  slot.count += 1;
}

/**
 * Walks the player's buildings and fills the chain's buckets. Shared body of the two screens; only
 * the chain and the number of buckets differ.
 *
 * Both original loops run over the occupancy bitmap up to `maxBuildingIndex`, skip **burning**
 * buildings (`bld+5` bit 5) and test `owner == player`. Screen 0x10 masks the type with `0x7c` and
 * additionally requires the building to be **finished** (`bld[4]` as `char` >= 0, i.e. construction
 * bit clear); screen 0x11 masks with `0xfc` — there the construction bit is already part of the
 * comparison value, so construction sites drop out by themselves.
 */
export function collectFillLevels(
  state: GameState,
  player: Player,
  rules: readonly FillRule[],
  slotCount: number,
  requireComplete: boolean,
): FillSlot[] {
  const slots: FillSlot[] = Array.from({ length: slotCount }, () => ({ sum: 0, count: 0 }));
  const mask = requireComplete ? 0x7c : 0xfc;
  for (let i = 0; i < state.header.maxBuildingIndex; i++) {
    const bld = state.buildings[i] ?? null;
    if (bld === null) continue;
    if (bld.burning) continue;
    if (bld.owner !== player.slot) continue;
    if (requireComplete && bld.constructing) continue;
    const coded = ((bld.type << 2) | (bld.constructing ? 0x80 : 0)) & mask;
    for (const rule of rules) {
      if (rule.codedType !== coded) continue;
      const slot = slots[rule.byteSlot / FILL_SLOT_BYTES];
      if (slot) contribute(slot, rule.kind, bld);
    }
  }
  return slots;
}

// --- Profession availability (screen 0x13) ---------------------------------------------------------

/** Serf state "idle in stock" — the only one the profession statistic counts. */
export const PROFESSION_IDLE_STATE = 1;

/**
 * Length of the counting buffer: 27 serf types (0..26) **plus** one slot. The original counts with
 * `buf[serf[0] & 0x7c]`, i.e. by `type << 2` — for type 27 ("dead") it lands one slot past the table,
 * inside its generous scratch area. The port keeps the same slot free instead of filtering the type
 * out; only 0..26 are read.
 */
export const PROFESSION_BUFFER_LENGTH = 28;

/**
 * One step of a recruiting chain: first clamp (if `tool` is set) to the warehouse stock of that
 * tool, then add the value to all listed serf types.
 */
export interface RecruitStep {
  /** Resource index of the tool needed, `null` = none. */
  readonly tool: number | null;
  /** Serf types that pay in after this clamping step. */
  readonly types: readonly number[];
}

const RES_BOAT = 8;
const RES_SHOVEL = 15;
const RES_HAMMER = 16;
const RES_ROD = 17;
const RES_CLEAVER = 18;
const RES_SCYTHE = 19;
const RES_AXE = 20;
const RES_SAW = 21;
const RES_PICK = 22;
const RES_PINCER = 23;
const RES_SWORD = 24;
const RES_SHIELD = 25;

/**
 * **What an idle serf can be turned into** — the clamping chain of `FUN_0003e12b`, read step by
 * step (`mov 0xNN(%ebx),%ax ; cmp ; jb` = unsigned minimum, `add %eax,0xMM(%ebx)` = paying into
 * `type = 0xMM / 4`).
 *
 * Every outer chain starts again from the full `genericCount`; **within** a chain the original keeps
 * clamping cumulatively without resetting — that is how the two-tool professions come about:
 * toolmaker = `min(free, saw, hammer)`, smith = `min(free, hammer, tongs)`,
 * knight = `min(free, sword, shield)`.
 *
 * The assignment matches the original manual in **every** row: digger shovel, fisher rod, butcher
 * cleaver, farmer scythe, lumberjack axe, sawmiller saw, miner and stonecutter pick, builder,
 * boatbuilder and geologist hammer, toolmaker hammer + saw, smith hammer + tongs; some workers
 * (bakers, carriers) need no tool at all.
 */
export const RECRUIT_CHAINS: readonly (readonly RecruitStep[])[] = [
  [{ tool: null, types: [0, 8, 10, 12, 15, 16] }], // carrier, forester, smelter, pig farmer, miller, baker
  [{ tool: RES_SAW, types: [6] }, { tool: RES_HAMMER, types: [18] }], // sawmiller -> toolmaker
  [{ tool: RES_HAMMER, types: [3, 17, 20] }, { tool: RES_PINCER, types: [19] }], // builder/boatbuilder/geologist -> weaponsmith
  [{ tool: RES_SHOVEL, types: [2] }], // digger
  [{ tool: RES_ROD, types: [11] }], // fisher
  [{ tool: RES_CLEAVER, types: [13] }], // butcher
  [{ tool: RES_SCYTHE, types: [14] }], // Farmer
  [{ tool: RES_AXE, types: [5] }], // lumberjack
  [{ tool: RES_PICK, types: [7, 9] }], // stonecutter, miner
  [{ tool: RES_BOAT, types: [1] }], // sailor — a boat instead of a tool
  [{ tool: RES_SWORD, types: [] }, { tool: RES_SHIELD, types: [22] }], // knight rank 0
];

/**
 * **How many people per profession the player can call on directly** — `FUN_0003e12b`
 * (screen 0x13), three phases as in the original:
 *
 * 1. **Count the idle**: every own serf with `state == 1` ("idle in stock") counts for its type.
 * 2. **Add the retrainable**: per warehouse `genericCount` to every profession whose tool lies there
 *    ({@link RECRUIT_CHAINS}). A serf counts for **every** profession it could become — the display
 *    answers "how many of these could I make", not "how would they be split".
 * 3. **Saturate**: the u32 counters clamp at 65535, they do not wrap.
 *
 * The needle value of the display comes from this via the scale in `stats-popup.ts`; the number at
 * the bottom right is the cached player counter `serfCount[21]` (unemployed serfs), which the
 * original reads directly.
 */
export function professionAvailability(state: GameState, player: Player): number[] {
  const buf = new Array<number>(PROFESSION_BUFFER_LENGTH).fill(0);
  for (const serf of state.serfs) {
    if (serf === null) continue;
    if (serf.state !== PROFESSION_IDLE_STATE) continue;
    if (serf.owner !== player.slot) continue;
    const slot = serf.type;
    if (slot < PROFESSION_BUFFER_LENGTH) buf[slot] += 1;
  }
  for (const inv of state.inventories) {
    if (inv === null || inv.owner !== player.slot) continue;
    const generic = inv.genericCount;
    if (generic === 0) continue;
    for (const chain of RECRUIT_CHAINS) {
      let value = generic;
      for (const step of chain) {
        if (step.tool !== null) value = Math.min(value, inv.resources[step.tool] ?? 0);
        for (const type of step.types) buf[type] += value;
      }
    }
  }
  return buf.map((v) => (v > 0xffff ? 0xffff : v));
}
