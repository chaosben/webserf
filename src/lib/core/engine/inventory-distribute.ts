/**
 * **Goods distribution tick** — `FUN_0000fc21` @0xfc21, phase 0 of the economy phase table `@0xf8b3`
 * (rotation 32). This is the **producer of the out queue**: without it no good ever leaves an
 * inventory, and the consumer chain (serf states 12 -> 11 -> 13) waits for a producer that never runs.
 *
 * Per call one of the three **goods category lists** is chosen, and for each of its 12 entries a
 * two-phase pass runs for each player (3 -> 0):
 *
 * - **Phase A** — walk the player's inventories. An inventory set to "move out" is drained proactively
 *   by `inventoryPriority` (good into the out queue **without** a destination). The others count as
 *   **sources** if they hold the category's good.
 * - **Phase B** — ring-by-ring flooding of the flag network from the source flags. Every flag reached
 *   whose attached building **requests** the category, and whose `stockPriority` beats the source's
 *   best value so far, becomes that source's destination. Per ring the bar grows by 25 % — the
 *   original's distance penalty.
 * - **Delivery** — per source with a destination: clear the destination's `stockPriority`, raise the
 *   target building's `requested` nibble, book the good out of the inventory and queue it with its
 *   destination.
 *
 * ## What gets lost when copying from the decompilation (all re-read in the assembly)
 *
 * 1. **The list choice is RANDOM, not `tick & 7`.** The last call before `andw $0x7,0x1c(%edi)`
 *    @0xfc48 is `call 0x4e1e9`, and that routine is **byte identical** to `rng_next` @0x28c54, only
 *    with the result in `vreg7` instead of `vreg5`. So the `andw` reads **the fresh random value** —
 *    and this tick therefore **draws from the RNG**, shifting the stream for every later consumer.
 * 2. **The flood follows `flag[5]`, not the path bits.** `flag[5]` is the **carrier** mask: a road
 *    without a carrier conducts no goods.
 * 3. **`bld[0xa]` is carried through 250 bytes in the UPPER half of `vreg6`** (`rorl $0x10` @0x1073d)
 *    and fetched back @0x1083d. At the use site the decompilation shows `vreg6 = 0`, i.e. serf index 0
 *    — see the wake-up call below.
 * 4. The entry gate `gs+0x1fe` (@0xfc29) is a global "game is running"; always true here.
 *
 * ## The four calls in the head live in other modules
 *
 * `@0xfc21` calls `0x11752` / `0x109b6` / `0x10d0f` / `0x11171` in that order and only then draws the
 * RNG value `0x4e1e9`. Only the RNG draw is reproduced here; `tick.ts` calls the four routines at the
 * same place in the same order, and the order is semantics because all four see the same frame:
 * `knight-morale.ts`, `population.ts`, `ai-pressure.ts`, `player-hints.ts`.
 */

import type { GameState } from './state.js';
import type { Building, Flag, Inventory, Player } from './state.js';
import { setUnionU8, setUnionU16 } from './serf-machine.js';

/** One entry of a goods category list (3 x u16, `-1` terminates the list). */
export interface CategoryEntry {
  /** Byte offset into the flag accept field: `0x42` = slot 0, `0x44` = slot 1. */
  readonly selector: 0x42 | 0x44;
  /** Bit index of the goods category inside the accept byte (0..5). */
  readonly param1: number;
  /** `res * 2` (byte offset into `resources[]`); **`-1` = the combined food case**. */
  readonly param2: number;
}

const E = (selector: 0x42 | 0x44, param1: number, param2: number): CategoryEntry => ({
  selector,
  param1,
  param2,
});

/**
 * The three lists sit contiguously in the binary in the order C, A, B (`@0x108d8` -> `@0x10920`
 * terminator, `@0x10922` -> `@0x1096a`, `@0x1096c` -> `@0x109b4`). All three hold **the same 12
 * triplets, merely permuted** — so the random choice rotates the order in which goods categories are
 * worked through, and no category starves.
 */
const LIST_A: readonly CategoryEntry[] = [
  E(0x44, 4, 18), // Stone
  E(0x44, 1, 20), // IronOre
  E(0x44, 0, 26), // GoldOre
  E(0x42, 2, 24), // Coal
  E(0x44, 2, 22), // Steel
  E(0x44, 3, 28), // gold bar
  E(0x42, 0, -1), // combined food
  E(0x42, 3, 2), // pig
  E(0x42, 5, 8), // flour
  E(0x42, 4, 6), // wheat
  E(0x44, 5, 12), // lumber
  E(0x42, 1, 14), // plank
];

const LIST_B: readonly CategoryEntry[] = [
  E(0x42, 0, -1), // combined food
  E(0x42, 4, 6), // wheat
  E(0x42, 3, 2), // Pig
  E(0x42, 5, 8), // Flour
  E(0x44, 3, 28), // GoldBar
  E(0x44, 4, 18), // Stone
  E(0x42, 1, 14), // Plank
  E(0x44, 2, 22), // Steel
  E(0x42, 2, 24), // Coal
  E(0x44, 5, 12), // Lumber
  E(0x44, 0, 26), // GoldOre
  E(0x44, 1, 20), // IronOre
];

const LIST_C: readonly CategoryEntry[] = [
  E(0x42, 1, 14), // Plank
  E(0x44, 4, 18), // Stone
  E(0x44, 2, 22), // Steel
  E(0x42, 2, 24), // Coal
  E(0x44, 5, 12), // Lumber
  E(0x44, 1, 20), // iron ore
  E(0x42, 0, -1), // combined food
  E(0x42, 3, 2), // pig
  E(0x42, 5, 8), // flour
  E(0x42, 4, 6), // wheat
  E(0x44, 3, 28), // gold bar
  E(0x44, 0, 26), // gold ore
];

/** Addresses of the three lists. */
export const CATEGORY_LISTS = {
  /** `@0x10922` — chosen when the random value `& 7 == 0`. */
  a: LIST_A,
  /** `@0x1096c` — chosen at `& 7 == 1`. */
  b: LIST_B,
  /** `@0x108d8` — chosen at `& 7 >= 2`, so in 6 of 8 cases. */
  c: LIST_C,
} as const;

/** Upper bound of the source list (`cmpw $0x100` @0xff43) — the source index fits into `flag[2]`. */
const MAX_SOURCES = 0x100;

/** Upper bound of the ring queue (`cmpw $0x3e2` @0x105f9, tested per flag processed). */
const MAX_RING = 0x3e2;

/**
 * Minimum `stockPriority` for a flag to become a delivery target: `cmpb $0x10,flag[sel+1]` + `jb`
 * @0x10196 — the original compares against **16**, not 15. The demand calculation in `buildings.ts`
 * yields `prio = (base8 >> fill) & 0xff`; with `base8 = 0xff` that drops to 15 from fill level 4
 * onwards, below this threshold — so a building with four units already booked stops being supplied.
 */
const MIN_STOCK_PRIORITY = 0x10;

/** Byte offsets of the three food goods in `resources[]` (fish 0, meat 2, bread 5). */
const FOOD_FISH = 0;
const FOOD_MEAT = 4;
const FOOD_BREAD = 10;

/** Raw queue byte (`inv+0x3a`/`0x3b`): `type + 1`, so `0` == empty slot. */
function rawQueueType(inv: Inventory, slot: 0 | 1): number {
  return (inv.outQueue[slot].type + 1) & 0xff;
}

/** Stock slot as a raw byte (`bld+8`/`bld+9`): high nibble available, low nibble requested. */
function packStock(bld: Building, slot: 0 | 1): number {
  return (((bld.stock[slot].available & 0xf) << 4) | (bld.stock[slot].requested & 0xf)) & 0xff;
}

/** One full pass of `FUN_0000fc21` @0xfc21 (without the head calls, which `tick.ts` makes itself). */
export function distributeInventoryGoods(state: GameState): void {
  // @0xfc43 `call 0x4e1e9` == rng_next with the result in vreg7, then @0xfc48 `andw $0x7`.
  // @0xfc4d `subw $0x1` + `jb`/`je`: 0 => list A, 1 => list B, 2..7 => list C.
  const roll = state.rng.next() & 7;
  const list = roll === 0 ? LIST_A : roll === 1 ? LIST_B : LIST_C;

  for (const entry of list) {
    // @0xfca7 `vreg3 = 3`, @0x108cc `subw $0x1 ; jae 0xfcaf` — players 3 -> 0, descending. The
    // original does NOT test whether the player is active; filtering happens solely through the
    // inventory owner. The player record is only needed in the "move out" branch.
    for (let slot = 3; slot >= 0; slot--) {
      const player = state.players[slot] ?? null;
      const sources = collectSources(state, entry, slot, player);
      // @0xff6a `subw $0x1,vreg7 ; jb 0x108c7` — no source, so straight on to the next player.
      if (sources.length === 0) continue;
      const { best, score } = floodForTargets(state, entry, sources);
      deliver(state, entry, sources, best, score);
    }
  }
}

/**
 * **Phase A** (@0xfcaf..@0xff6a) — walk a player's inventories: drain those set to "move out",
 * collect the rest as sources.
 *
 * The iteration follows the original's order: occupancy bitmap byte by byte ascending, and within a
 * byte **bit 7 -> bit 0** — which is exactly the ascending inventory index (`bt` with `vreg6 = 7..0`,
 * the record pointer advancing by `0x78` per bit).
 */
export function collectSources(
  state: GameState,
  entry: CategoryEntry,
  slot: number,
  player: Player | null,
): Inventory[] {
  const sources: Inventory[] = [];
  const n = state.header.maxInventoryIndex;
  // @0xfced `subw $0x1,vreg4 ; jb 0x108c7` — no inventory, nothing to do.
  if (n === 0) return sources;
  const slots = (((n - 1) >> 3) + 1) * 8;

  for (let i = 0; i < slots; i++) {
    const inv = state.inventories[i]; // the bitmap bit means the slot is occupied
    if (!inv) continue;
    if (inv.owner !== slot) continue; // @0xfd2a `cmp %al,vreg3`
    if (rawQueueType(inv, 1) !== 0) continue; // @0xfd36 `inv[0x3b] != 0` ⇒ zweiter Slot belegt

      // @0xfd49 `bt $0x1,inv[1]` — bit 1 of res_dir == "move out". The mode VALUES are 0/1/3 (not
      // 0/1/2), so the bit is tested rather than a value.
    if (((inv.resDir >> 1) & 1) !== 0) {
      if (player) ejectByPriority(inv, player);
      continue; // a "move out" inventory is NOT additionally a source
    }

    if (entry.param2 < 0) {
      // @0xfef2 combined food case: a source as soon as fish OR meat OR bread is present.
      if (
        inv.resources[FOOD_FISH >> 1] === 0 &&
        inv.resources[FOOD_MEAT >> 1] === 0 &&
        inv.resources[FOOD_BREAD >> 1] === 0
      ) {
        continue;
      }
    } else if (inv.resources[entry.param2 >> 1] === 0) {
      continue; // @0xff21 this particular good is missing
    }

    sources.push(inv);
      // @0xff43 `cmpw $0x100 ; je 0xff6a` — list full: stop collecting, carry on with what we have.
    if (sources.length === MAX_SOURCES) break;
  }
  return sources;
}

/**
 * The **"move out" branch** (@0xfd59..@0xfeb1): the good with the **highest** `inventoryPriority`
 * (player block 224, a permutation of 1..26) that is present in the inventory is booked out and queued
 * **without a destination** (`dest = 0`) — the goods scheduler at the flag finds it one later.
 *
 * The candidate loop runs `res = 25 -> 0` and replaces only on **strictly** greater priority
 * (`cmp %al,vreg6 ; jae` @0xfde5); since the priorities are a permutation there are no ties. Priority 0
 * means "nothing found" (@0xfe0e).
 */
function ejectByPriority(inv: Inventory, player: Player): void {
  let bestPrio = 0;
  let bestRes = -1;
  for (let res = 0x19; res >= 0; res--) {
    if (inv.resources[res] === 0) continue; // @0xfdd5
    const prio = player.inventoryPriority[res] ?? 0;
    if (bestPrio < prio) {
      bestPrio = prio;
      bestRes = res;
    }
  }
  if (bestPrio === 0 || bestRes < 0) return;

  inv.resources[bestRes] -= 1; // @0xfe58 `subw $0x1,inv[6 + res*2]`
  // @0xfe63: first free queue slot; `dest` stays 0 (@0xfebd / @0xfe76 `xor %ax,%ax`).
  const target = rawQueueType(inv, 0) === 0 ? 0 : 1;
  inv.outQueue[target].type = bestRes;
  inv.outQueue[target].dest = 0;
}

/**
 * **Phase B** (@0xff6a..@0x1066b) — ring-by-ring flooding of the flag network from the source flags.
 *
 * - `new_flag_search` @0x1303f draws a new search number and marks flags persistently in
 *   `flag[0]`/`flag[2]`. The port deliberately does not carry those two fields and uses a local map
 *   flag -> source index instead. That is equivalent because every search in the original gets its own
 *   number; `flagSearchCounter` (`gs+0x26e`) is therefore not advanced here either.
 * - Neighbour directions run **5 -> 0** over the **carrier** mask `flag[5]`, not the path bits: a road
 *   without a carrier conducts no goods.
 * - A source whose bar has saturated at `0xff` is not expanded any further (@0x10112 `cmpb $0xff`) —
 *   that is the distance cut-off.
 * - After each ring every source's bar grows by `(bar >> 2) + 1`, clamped to `0xff` (@0x1062d): a
 *   target one ring further out has to be roughly 25 % better.
 * - The original's two ring queues are a **double buffer** (`gs+0xb4`/`gs+0xb8`) with a ping-pong bit
 *   `gs+0x270`, inverted per ring @0x100b1. The port keeps two local lists and reassigns them — the bit
 *   is pure buffer management.
 */
export function floodForTargets(
  state: GameState,
  entry: CategoryEntry,
  sources: readonly Inventory[],
): { best: (Flag | null)[]; score: Uint8Array } {
  const n = sources.length;
  const score = new Uint8Array(n); // gs+0xbc+0x800, zeroed @0xffb3
  const best: (Flag | null)[] = new Array<Flag | null>(n).fill(null);
  const srcOf = new Map<number, number>(); // == flag[0] (besucht) + flag[2] (Quell-Index)
  const prioSlot = entry.selector === 0x42 ? 0 : 1;

  // Seeding @0xffbe..@0x1002d: source flag = `inv[2]`, flag record via `gs+0x98 + idx*0x46`.
  let ring: Flag[] = [];
  for (let i = 0; i < n; i++) {
    const f = state.flags[sources[i].flag];
    if (!f) continue; // in the original inv[2] always points at a valid flag
    if (!srcOf.has(f.index)) {
      srcOf.set(f.index, i);
      ring.push(f);
    }
  }

  for (;;) {
    const next: Flag[] = [];
    for (const f of ring) {
      const src = srcOf.get(f.index);
      if (src === undefined) continue;
      // @0x10112 saturated source => do not expand this flag (falls through to the ring test).
      if (score[src] !== 0xff) {
        for (let dir = 5; dir >= 0; dir--) {
          if (!f.transporters[dir]) continue; // flag[5] Bit dir
          const c = f.connections[dir];
        // The original follows the raw pointer `flag[0x24 + 4*dir]`; in direction 4 that can be a
        // BUILDING. A building connection never carries the transporter mask (0 cases across all
        // saves), so the type test is provably equivalent rather than merely defensive.
          if (!c || c.kind !== 'flag') continue;
          const nb = state.flags[c.index];
          if (!nb) continue;
          if (srcOf.has(nb.index)) continue; // @0x10146 `flag[0] == searchNum` => already visited
          srcOf.set(nb.index, src);
          next.push(nb);

      // Accept test @0x1016d..@0x101f8: bit `param1` in the accept byte, `stockPriority > 15`, and
      // better than the source's bar as grown per ring.
          const accept = entry.selector === 0x42 ? nb.bldFlags : nb.bld2Flags;
          const prio = nb.stockPriority[prioSlot];
          if (
            ((accept >> (entry.param1 & 0xf)) & 1) !== 0 &&
            prio >= MIN_STOCK_PRIORITY &&
            score[src] < prio
          ) {
            score[src] = prio;
            best[src] = nb;
          }
        }
      }
      // @0x105f9 `cmpw $0x3e2,vreg4 ; jns` — tested per flag processed (including the skipped ones),
      // `vreg4` == number of queued flags - 1. The original aborts only the INNER loop and keeps
      // flooding with the ring it has.
      if (next.length - 1 >= MAX_RING) break;
    }

    // @0x1061a `js 0x10672` — no new ring, flooding done.
    if (next.length === 0) break;

    // Ageing pass @0x1062d over ALL sources (descending), only where the bar is != 0.
    for (let i = n - 1; i >= 0; i--) {
      const s = score[i];
      if (s === 0) continue;
      const inc = (s >> 2) + 1;
      score[i] = s + inc > 0xff ? 0xff : s + inc;
    }
    ring = next;
  }
  return { best, score };
}

/**
 * **Delivery** (@0x10672..@0x108c1) — per source with a destination found (descending source index).
 *
 * Two details are easy to lose. `flag[selector + 1] = 0` (@0x1070d) clears the destination's
 * `stockPriority` so the same target does not win again immediately, until the building reports its
 * need afresh. And `bld[8]`/`bld[9] += 1` (@0x10722/@0x1072b) is a **byte** addition on the packed
 * stock slot, so an overflow of the `requested` nibble carries into the `available` nibble.
 */
function deliver(
  state: GameState,
  entry: CategoryEntry,
  sources: readonly Inventory[],
  best: readonly (Flag | null)[],
  score: Uint8Array,
): void {
  const prioSlot = entry.selector === 0x42 ? 0 : 1;

  for (let i = sources.length - 1; i >= 0; i--) {
    if (score[i] === 0) continue; // @0x106f2 — no bar means no destination was found
    const tflag = best[i];
    if (!tflag) continue;

    tflag.stockPriority[prioSlot] = 0;

    // @0x10714 `flag[0x34]` == endpoint pointer direction 4 (UpLeft) == the attached building.
    const conn = tflag.connections[4];
    if (!conn || conn.kind !== 'building') continue;
    const bld = state.buildings[conn.index];
    if (!bld) continue;

    bld.stock[prioSlot] = unpackStock((packStock(bld, prioSlot) + 1) & 0xff);

    const dest = bld.flag; // @0x10744
    // @0x10732 + @0x1083d: `bld[0xa]` survives in the upper half of vreg6 until the wake-up call.
    const carrierSerfIndex = bld.firstKnight;

    const inv = sources[i];
    let resOff = entry.param2;
    if (resOff < 0) resOff = pickLargestFood(inv);

    inv.resources[resOff >> 1] -= 1; // @0x107cd
    const resIndex = resOff >> 1; // @0x107d3 `shrw $1` + @0x107d7 `addw $1` == raw type res+1
    const target = rawQueueType(inv, 0) === 0 ? 0 : 1; // @0x107df
    inv.outQueue[target].type = resIndex;
    inv.outQueue[target].dest = dest;

    // @0x1081c `inv[0x4a] != 0` => this inventory is not handing anything out right now.
    if (inv.serfIndices[4] !== 0) continue;
    wakeWaitingCarrier(state, inv, carrierSerfIndex);
  }
}

/**
 * The **direct wake-up call** (@0x10836..@0x108a6) — field for field a **copy** of the canonical state
 * 12 body `serf_state_12` @0x1f556, with **two** deviations that are unambiguous in the assembly and
 * are reproduced here on purpose:
 *
 * 1. **The serf index comes from `bld[0xa]` of the TARGET building**, not from the source inventory.
 *    The value is rotated into the upper half of `vreg6` @0x10732 and fetched back @0x1083d. That makes
 *    no sense semantically — the waiting carrier stands in the source inventory.
 * 2. **`serf[0xc]` receives the literal `0x3c`** (`mov $0x3c,%ax` @0x10874) instead of `inv[0x3c]`
 *    (`mov 0x3c(%ebx),%ax` in the canonical body @0x1f561) — the same instruction with an immediate
 *    instead of a memory operand, the classic look of a slipped copy-paste.
 *
 * Together this is most likely an **original defect**; the binary is what counts, so the port does the
 * same. `cmpb $0xc,0xa(%ebx)` occurs **exactly once** in the whole game region (@0x1085a), so there is
 * no second, correct execution of this block to compare against.
 */
function wakeWaitingCarrier(state: GameState, inv: Inventory, serfIndex: number): void {
  const serf = state.serfs[serfIndex];
  if (!serf) return;
  if (serf.state !== 0x0c) return; // @0x1085a — only a waiting carrier (state 12)

  serf.state = 0x0b; // @0x10860 MoveResourceOut
  setUnionU8(serf, 0xb, rawQueueType(inv, 0)); // @0x1086b `serf[0xb] = inv[0x3a]` (raw type)
  setUnionU16(serf, 0xc, 0x3c); // @0x10874 ORIGINAL: a literal, not `inv[0x3c]` (see above)
  setUnionU8(serf, 0xf, 0x0d); // @0x1087f follow-up state 13 DropResourceOut

  // Advance the queue by one slot (@0x10887..@0x108a6). `outQueue[1].dest` stays behind as a
  // residual — the original clears only the type byte `inv[0x3b]`.
  inv.outQueue[0].type = inv.outQueue[1].type;
  inv.outQueue[0].dest = inv.outQueue[1].dest;
  inv.outQueue[1].type = -1;
}

/**
 * The combined food case in the delivery (@0x1076c..@0x107c3): the **largest** of fish / meat / bread,
 * ties resolved in that order (the comparisons are `jae`/`jb`, so bread wins only on a **strictly**
 * larger stock). Returns the byte offset (0 / 4 / 10), as in the original.
 */
function pickLargestFood(inv: Inventory): number {
  const fish = inv.resources[FOOD_FISH >> 1];
  const meat = inv.resources[FOOD_MEAT >> 1];
  const bread = inv.resources[FOOD_BREAD >> 1];
  if (fish < meat) return meat < bread ? FOOD_BREAD : FOOD_MEAT;
  return fish < bread ? FOOD_BREAD : FOOD_FISH;
}

/** Raw byte -> stock slot (the inverse of `packStock`). */
function unpackStock(raw: number): { available: number; requested: number } {
  return { available: (raw >> 4) & 0xf, requested: raw & 0xf };
}
