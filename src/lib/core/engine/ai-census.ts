/**
 * The AI's census (`FUN_0005ba0c`), one of the seven steady-state subtasks. It is the input of all 25
 * urgency evaluators of the build decider, which is why it had to be ported first: a decider running
 * on empty tables would have no effect.
 *
 * | `player+` | Content | Length |
 * |---|---|---|
 * | `0x33c` | supply ratio per consumer group | 21 x u16 |
 * | `0x366` | idle settlers per profession (`IdleInStock`) | 27 x u16 |
 * | `0x39c` | resources across all own inventories | 26 x u16 |
 *
 * The building pass sums two quantities per building:
 *
 * ```
 * supply   = (stock & 0x0f) + 2 * ((stock & 0xf0) >> 4)   # requested + 2 x available
 * capacity = 2 x holding capacity                          # 16 regular, 4 hut, 8 tower
 * ```
 *
 * The `2 x` on both sides is deliberate: available goods count double, requested ones once, and the
 * capacity is doubled to match, so fully stocked yields exactly 1. The three military capacities
 * 4/8/16 are twice the gold capacities from `knight-morale.ts`.
 *
 * Primary producers (fisher, lumberjack, stonecutter, forester, farm), warehouse and castle are not
 * counted - their table slots point at the loop foot, which is consistent: a business without input
 * goods has no supply. Sites under construction have no type dispatcher at all; they all run into the
 * planks and stone slots, with capacity from the stock maxima.
 *
 * The transfer is a 16-bit fraction, and its equality test is necessary rather than convenient: on
 * equality the result would be 65536 and would not fit. It also covers "no buildings of this group"
 * (0/0), which makes a division by zero unreachable.
 *
 * The parked building reserve lands in the URGENCY table, not in the stockpile: at the two stores the
 * cursor has already moved past the 26 resource slots onto `player+0x3d0`. They are `add`, not `mov`,
 * and functionally inert (the decider zeroes that range before every run and the two evaluators write
 * with `mov`) - but visible in the save state, so the port reproduces them.
 *
 * The pass draws no random numbers.
 */
import type { GameState, Player, Building } from './state.js';
import { u16 } from './int.js';

/** Length of the three tables (`mov $0x14/$0x1a/$0x19` @0x5ba18/@0x5c12c/@0x5c218, one extra pass each). */
export const AI_SUPPLY_SLOTS = 21;
export const AI_IDLE_SERF_SLOTS = 27;
export const AI_STOCKPILE_SLOTS = 26;

/**
 * The three table bases as player offsets (`add $0x33c/$0x366/$0x39c,%esi`
 * @0x5c09f/@0x5c123/@0x5c224). They are here because **other routines reach into the middle of these
 * tables** — the flag evaluator reads `player+0x368` and `player+0x3ac`, and only the difference from
 * the base says which slot that is. Without the constants such an access stays a bare address.
 */
export const AI_SUPPLY_BASE = 0x33c;
export const AI_IDLE_SERFS_BASE = 0x366;
export const AI_STOCKPILE_BASE = 0x39c;

/** Serf state `IdleInStock` — `cmpb $0x1,0xa(%ebx)` @0x5bc1bc. */
const SERF_STATE_IDLE_IN_STOCK = 1;

/** Resource index of planks and stone in the inventory record. */
const RES_PLANK = 7;
const RES_STONE = 9;

/**
 * The two target slots of the reserve addition: `add %ax,0xe(%ebx)` @0x5c258 and `add %ax,0x12(%ebx)`
 * @0x5c26d, base `player+0x3d0` — offset / 2. Constants of their own, because they carry the same
 * numbers as `RES_PLANK`/`RES_STONE` only **by coincidence**: these are slots of the URGENCY table,
 * not resource indices.
 */
const URGENCY_SLOT_HELD_PLANKS = 7;
const URGENCY_SLOT_HELD_STONE = 9;

/**
 * One entry of the type jump table @0x5baf1: which scratch slots a finished building of that type
 * serves, with which stock byte and which (doubled) capacity.
 *
 * Kept as **data** rather than 17 functions, so a guard can hold every entry against the table and the
 * handler bodies in the binary — the same decision as for the evaluation chains in `ai-score.ts`.
 *
 * `stock` is the byte offset in the building record (8 == first stock, 9 == second).
 */
export interface SupplyContribution {
  readonly slot: number;
  readonly stock: 8 | 9;
  readonly capacity: number;
}

/** Capacity constants of the four helpers (`mov $0x10/$0x4/$0x8` @0x5bf5e/@0x5bfc2/@0x5bff4). */
export const SUPPLY_CAP_DEFAULT = 0x10;
export const SUPPLY_CAP_HUT = 0x4;
export const SUPPLY_CAP_TOWER = 0x8;

/**
 * The table @0x5baf1, stride 8, indexed by building type. Missing types (0/1/2/4/9/10/12/24 and
 * everything >= 25) jump to the loop foot @0x5c06d — they contribute nothing.
 *
 * The slot numbers are as in the binary (displacement / 2 of the respective `add %ax,…`); the order is
 * **not** the type order (butcher has slot 7, pig farm 6 — @0x5bd6b/@0x5bd8b), and the weapon smith
 * enters its two slots in the order 14/13 (@0x5be81). Both taken over as they are, because only the
 * slot number matters.
 */
export const SUPPLY_TABLE: readonly (readonly SupplyContribution[])[] = (() => {
  const t: SupplyContribution[][] = Array.from({ length: 32 }, () => []);
  const d = SUPPLY_CAP_DEFAULT;
  t[3] = [{ slot: 0, stock: 8, capacity: d }]; // boat builder @0x5bcac
  t[5] = [{ slot: 1, stock: 8, capacity: d }]; // stone mine @0x5bccb
  t[6] = [{ slot: 2, stock: 8, capacity: d }]; // coal mine @0x5bceb
  t[7] = [{ slot: 3, stock: 8, capacity: d }]; // iron mine @0x5bd0b
  t[8] = [{ slot: 4, stock: 8, capacity: d }]; // gold mine @0x5bd2b
  t[11] = [{ slot: 5, stock: 9, capacity: SUPPLY_CAP_HUT }]; // hut @0x5bd4b
  t[13] = [{ slot: 7, stock: 8, capacity: d }]; // butcher @0x5bd6b
  t[14] = [{ slot: 6, stock: 8, capacity: d }]; // pig farm @0x5bd8b
  t[15] = [{ slot: 8, stock: 8, capacity: d }]; // mill @0x5bdab
  t[16] = [{ slot: 9, stock: 8, capacity: d }]; // bakery @0x5bdcb
  t[17] = [{ slot: 10, stock: 9, capacity: d }]; // sawmill @0x5bdeb
  // The four double-slot buildings call the helper TWICE: first @0x5bf37 (stock byte 8) for the
  // first slot, then @0x5bf69 (byte 9) for the second. Getting both onto byte 9 is only visible when
  // the round trip is measured **per slot**: slot 14 then matches 3 of 51 while its neighbours match
  // 50 of 51, which an overall rate would hide.
  t[18] = [{ slot: 15, stock: 8, capacity: d }, { slot: 16, stock: 9, capacity: d }]; // steel smelter @0x5be0b
  t[19] = [{ slot: 11, stock: 8, capacity: d }, { slot: 12, stock: 9, capacity: d }]; // toolmaker @0x5be46
  t[20] = [{ slot: 14, stock: 8, capacity: d }, { slot: 13, stock: 9, capacity: d }]; // weapon smith @0x5be81
  t[21] = [{ slot: 5, stock: 9, capacity: SUPPLY_CAP_TOWER }]; // tower @0x5bebc
  t[22] = [{ slot: 5, stock: 9, capacity: d }]; // fortress @0x5bedc
  t[23] = [{ slot: 17, stock: 8, capacity: d }, { slot: 18, stock: 9, capacity: d }]; // gold smelter @0x5befc
  return t;
})();

/** Slot of a site's planks and stone (`add %ax,0x26/0x28(%ebx)` @0x5bc7d/@0x5bc98). */
export const SUPPLY_SLOT_SITE_PLANKS = 19;
export const SUPPLY_SLOT_SITE_STONES = 20;

/**
 * The supply value of a stock byte — the shared head of all six helpers (@0x5bf37 ff.):
 * `(b & 0x0f) + ((b & 0xf0) >> 3)`. The second half is **twice** the upper nibble (`>> 3` instead of
 * `>> 4`), i.e. "goods present count double".
 */
export function supplyOfStock(available: number, requested: number): number {
  return u16((requested & 0xf) + ((available & 0xf) << 1));
}

/** One scratch pair: supply (table 1) and capacity (table 2, at `+0x32` in the original). */
interface Scratch {
  supply: number[];
  capacity: number[];
}

function contribute(s: Scratch, slot: number, supply: number, capacity: number): void {
  s.supply[slot] = u16((s.supply[slot] ?? 0) + supply);
  s.capacity[slot] = u16((s.capacity[slot] ?? 0) + capacity);
}

/** Add one building into the scratch area — the body behind the type dispatcher. */
function censusBuilding(s: Scratch, bld: Building): void {
  const stockOf = (byte: 8 | 9): number => {
    const st = bld.stock[byte === 8 ? 0 : 1];
    if (st === undefined) return 0;
    return supplyOfStock(st.available, st.requested);
  };

  if (bld.constructing) {
    // @0x5bc71 — no type dispatcher: every site counts into slot 19 (planks) and 20 (stone), and its
    // capacity is twice the stock maximum (`bld[16]`/`bld[17]`, @0x5c029/@0x5c060).
    const max = bld.stockMaximum ?? [0, 0];
    contribute(s, SUPPLY_SLOT_SITE_PLANKS, stockOf(8), u16((max[0] ?? 0) * 2));
    contribute(s, SUPPLY_SLOT_SITE_STONES, stockOf(9), u16((max[1] ?? 0) * 2));
    return;
  }
  for (const c of SUPPLY_TABLE[bld.type] ?? []) {
    contribute(s, c.slot, stockOf(c.stock), c.capacity);
  }
}

/**
 * The transfer @0x5c0a8: a 16-bit fraction per slot out of the two scratch tables.
 *
 * The equality branch is **necessary**, not convenient: 65536 does not fit in 16 bits. It also covers
 * `0/0`, which makes a division by zero unreachable here.
 */
export function supplyRatio(supply: number, capacity: number): number {
  if (supply === capacity) return 0xffff; // `jne 0x5c0df` @0x5c0d1
  return u16(Math.floor((supply * 0x10000) / capacity)); // `div %cx` @0x5c0f9
}

/**
 * **The census** — rewrites the player's `aiSupplyRatio`, `aiIdleSerfs` and `aiStockpile`. Returns how
 * many buildings/serfs/inventories were included; the original has no return value.
 */
export function aiCensus(state: GameState, player: Player): {
  buildings: number;
  serfs: number;
  inventories: number;
} {
  // Building pass (@0x5ba0c).
  // OPEN @0x5ba59 — `subw $0x1,(%edi) ; jb 0x5c120` skips building pass AND transfer at
  // `maxBuildingIndex == 0`, leaving `aiSupplyRatio` at the previous call's values. Deliberately not
  // reproduced, on two grounds: (a) the value 0 is structurally unreachable — game start reserves
  // slot 0 (`call 0x4514a` @0x7866 raises the counter to 1) and the only shrinking loop stops at the
  // first occupied lower slot (`bt %cx,%ax` @0x453ac, `je 0x4537b` @0x453b5); across 97 saves the
  // minimum is exactly 1. (b) At the reachable floor of 1 the branch is equivalent: the null slot
  // carries type 0 and points at the loop foot @0x5c06d, the equality test @0x5c0d1 does not fire at
  // 0/0, and @0x5c0d3 writes the same 21 x `0xffff` that `supplyRatio(0, 0)` yields below.
  const scratch: Scratch = {
    supply: new Array<number>(AI_SUPPLY_SLOTS).fill(0),
    capacity: new Array<number>(AI_SUPPLY_SLOTS).fill(0),
  };
  let buildings = 0;
  for (const bld of state.buildings) {
    // The original walks the occupancy bitmap `gs+0xa8` up to `gs+0x260` == maxBuildingIndex; our
    // array carries free slots as `null`, which is the same.
    if (bld === null || bld === undefined) continue;
    if (bld.owner !== player.index) continue; // `bld[4] & 3` against `player+0` @0x5bac7
    buildings += 1;
    censusBuilding(scratch, bld);
  }
  const ratios: number[] = [];
  for (let i = 0; i < AI_SUPPLY_SLOTS; i++) {
    ratios.push(supplyRatio(scratch.supply[i] ?? 0, scratch.capacity[i] ?? 0));
  }
  player.aiSupplyRatio = ratios;

  // Serf pass (@0x5c120).
  const idle = new Array<number>(AI_IDLE_SERF_SLOTS).fill(0);
  let serfs = 0;
  for (const serf of state.serfs) {
    if (serf === null || serf === undefined) continue;
    if (serf.state !== SERF_STATE_IDLE_IN_STOCK) continue; // `cmpb $0x1,0xa(%ebx)` @0x5c1bc
    if (serf.owner !== player.index) continue; // `serf[0] & 3` @0x5c1ca
    // `(serf[0] & 0x7c) >> 1` == type * 2 == the byte offset; our model keeps the type decoded.
    if (serf.type < 0 || serf.type >= AI_IDLE_SERF_SLOTS) continue;
    idle[serf.type] = u16((idle[serf.type] ?? 0) + 1);
    serfs += 1;
  }
  player.aiIdleSerfs = idle;

  // Resource pass (@0x5c218).
  const stockpile = new Array<number>(AI_STOCKPILE_SLOTS).fill(0);
  // The parked building reserve does NOT count here — the original adds it at this point onto the
  // URGENCY table (see the module head): `mov 0x164(%ebx),%al` @0x5c24a loads `heldPlanks` and
  // `add %ax,0xe(%ebx)` @0x5c258 adds it with %ebx == player+0x3d0, i.e. `aiUrgency[7] +=
  // heldPlanks`; @0x5c25f/@0x5c26d do the same for `heldStone` -> `aiUrgency[9]`. Functionally inert,
  // but visible in the save state — hence reproduced.
  const urgency = player.aiUrgency.slice();
  urgency[URGENCY_SLOT_HELD_PLANKS] = u16((urgency[URGENCY_SLOT_HELD_PLANKS] ?? 0) + player.heldPlanks);
  urgency[URGENCY_SLOT_HELD_STONE] = u16((urgency[URGENCY_SLOT_HELD_STONE] ?? 0) + player.heldStone);
  player.aiUrgency = urgency;

  let inventories = 0;
  for (const inv of state.inventories) {
    if (inv === null || inv === undefined) continue;
    if (inv.owner !== player.index) continue; // `inv[0]` against player.index @0x5c2de
    inventories += 1;
    // The original walks the resources from 25 downwards; the sum is order independent, and so is
    // the saturation (it clamps per slot, not across slots).
    for (let res = 0; res < AI_STOCKPILE_SLOTS; res++) {
      const sum = (stockpile[res] ?? 0) + (inv.resources[res] ?? 0);
      // `jae 0x5c331` @0x5c320 — on overflow 0xffff instead of wrapping.
      stockpile[res] = sum > 0xffff ? 0xffff : sum;
    }
  }
  player.aiStockpile = stockpile;

  return { buildings, serfs, inventories };
}
