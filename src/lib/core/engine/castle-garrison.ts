/**
 * **The castle garrison** — port of `castle_building_handler` (`FUN_00014da5` @0x14da5), the building
 * handler for type 24 in the driver table `@0x132e2`. Unlike the military types (hut, tower,
 * fortress) the castle does **not** fill up from the occupation tables: it holds a target value the
 * player sets.
 *
 * ### The control loop
 *
 * ```
 * player = gs[0x64 + (bld[4] & 3)*4]
 * want = player[0x18a] ; have = player[0x18c]          // @0x14dcd / @0x14dda
 * if (want == have)  -> rank rotation    @0x150ea
 * if (want <  have)  -> give one away    @0x14df0   (fall-through of the `jae`)
 * else               -> take one in      @0x14e9e
 * ```
 *
 * **Which field is which is decided by the loop itself:** only `0x18c` is ever written (`-1` when
 * giving away, `+1` when taking in), so it follows reality and is the **have** value. `0x18a` is only
 * changed by the player through the `-`/`+` buttons of the second knight menu (screen 0x2d, clamped
 * 1..99) and, for AI players, by `FUN_000546ea`.
 *
 * The **manual** names the target value on that very screen: the number below the morale percentage
 * and the gold amount fixes how many knights stay behind to protect the castle in any case.
 *
 * **Backed by data**: `0x18c` matches the length of the castle garrison chain (`bld[10] ->
 * serf[0xe]`) exactly in **121** cases. The three deviations are fresh foundings where the counter
 * still sits at its init value 0 while one or two knights have already moved in — the handler has
 * simply not run there yet. `0x18a` matches the garrison only where the loop has settled (114).
 *
 * ### Slice boundary
 *
 * What stands here are the **three branches**. Afterwards the original jumps into the **stock tail**
 * shared with the warehouse (`jmp 0x1537e` @0x15287) — that lives in `stock-building.ts` because both
 * building types use it, and is called at the end of {@link castleBuildingHandler}.
 */

import type { GameState, Building, Inventory, Player, Serf } from './state.js';
import { setSerfType } from './state.js';
import { unionU16, setUnionU16 } from './serf-machine.js';
import { requestKnightForBuilding } from './serf-request.js';
import { stockBuildingTail } from './stock-building.js';

/** Serf type 21 (generic) — the raw material of the knight conversion. */
const SERF_GENERIC = 21;
/** Serf type 22 (Knight0) — the result of the conversion. */
const SERF_KNIGHT0 = 22;
const RES_SWORD = 24;
const RES_SHIELD = 25;
/** State 1 `IdleInStock` — the released knight waits in the castle's stock. */
const STATE_IDLE_IN_STOCK = 1;
/** Zustand 75 `DefendingCastle` (`mov $0x4b` @0x14ffc / @0x150af). */
const STATE_DEFENDING_CASTLE = 0x4b;
/** Counter of a freshly moved-in knight (`mov $0x1770` @0x150b7). The conversion does **not** set it. */
const ENTER_COUNTER = 6000;
/** Reset of the request countdown `player+0x174` (`mov $0x5` @0x1503f). */
const REQUEST_COOLDOWN = 5;

/** Knight slots of the castle inventory, in the fill branch's order: K4 -> K0 (`inv+0x76 ... 0x6e`). */
const KNIGHT_SLOTS_HIGH_FIRST: readonly number[] = [26, 25, 24, 23, 22];
/**
 * Knight slots in the order of the **rotation**: K0 -> K3 (`inv+0x6e ... 0x74`). What is sought is
 * the weakest stock knight still weaker than the strongest of the garrison, so the cascade ends at K3
 * (a K4 could never be weaker).
 */
const KNIGHT_SLOTS_LOW_FIRST: readonly number[] = [22, 23, 24, 25];

/** Rank 1..5 from the raw type byte (`andw $0x7c ; shrw $0x2 ; subw $0x15` @0x15132). */
function knightRank(serf: Serf): number {
  return (((serf.type << 2) & 0x7c) >> 2) - 0x15;
}

/** The castle's inventory (`bld[0xe]`). */
function castleInventory(state: GameState, bld: Building): Inventory | null {
  return bld.inventoryIndex === null ? null : (state.inventories[bld.inventoryIndex] ?? null);
}

/**
 * Building handler of the castle (type 24). Compares the garrison's target and actual counts and
 * does exactly one of three things depending on the outcome.
 */
export function castleBuildingHandler(state: GameState, bld: Building): void {
  const player = state.players[bld.owner & 3];
  if (player) {
    const want = player.knightMenuValue;
    const have = player.knightMenuCounter;
    if (want === have) rotateCastleRanks(state, bld, player);
    else if (want < have) releaseCastleKnight(state, bld, player);
    else fillCastleGarrison(state, bld, player);
  }
  // `jmp 0x1537e` @0x15287 — the tail shared with the warehouse. It runs on **every** path: between
  // @0x14da5 and @0x15287 the routine has not a single `ret`, all aborts jump to @0x15285.
  stockBuildingTail(state, bld);
}

/**
 * **Too many in the castle** (`want < have`, @0x14df0). The **head** of the garrison chain goes into
 * the castle's stock — not the weakest: the castle *is* its own stock, there is no walking distance
 * and therefore no reason to choose.
 *
 * ```
 * player[0x18c] -= 1
 * s = bld[0xa] ; bld[0xa] = s[0xe]        // unhook the head
 * s[0xa] = 1 (IdleInStock) ; s[0xc] = 0 ; s[0xe] = (inv − gs.inventories) / 0x78
 * ```
 */
function releaseCastleKnight(state: GameState, bld: Building, player: Player): void {
  player.knightMenuCounter = (player.knightMenuCounter - 1) & 0xffff;
  const serf = state.serfs[bld.firstKnight];
  if (!serf) return;
  bld.firstKnight = unionU16(serf, 0xe);
  serf.state = STATE_IDLE_IN_STOCK;
  setUnionU16(serf, 0xc, 0);
  const inv = castleInventory(state, bld);
  setUnionU16(serf, 0xe, inv ? inv.index : 0);
}

/**
 * **Too few in the castle** (`want > have`, @0x14e9e). Three options, in this order:
 *
 * 1. **A knight in the own stock** — cascade `inv+0x76 -> 0x6e` (K4 first, the **strongest**). He is
 *    taken out of the representative cache, hooked into the chain, state 75, counter 6000.
 * 2. **Otherwise a generic plus weapons** — `inv+0x6c`; the cache slot is cleared
 *    **unconditionally**, even when the weapons are missing (`idleInStock` re-enters the
 *    representative on the next pass). With sword **and** shield: type byte `& 0x83 | 0x58` =>
 *    Knight0, census (generic -1 / Knight0 +1), `totalMilitaryScore` +1, weapons and `genericCount`
 *    -1 each.
 * 3. **Otherwise** a 5-tick countdown (`player+0x174`) and then a **knight request to the flag
 *    network** (`send_serf_to_flag` with type parameter `0xffffffff`), i.e. from a *different*
 *    warehouse. Afterwards `bld[8] = 0xffff`: the request tail adds 1 to `bld[8]`, which on an
 *    inventory building would destroy the `0xFF` marker, so the original restores it.
 */
function fillCastleGarrison(state: GameState, bld: Building, player: Player): void {
  const inv = castleInventory(state, bld);
  if (!inv) return;

  for (const slot of KNIGHT_SLOTS_HIGH_FIRST) {
    const idx = inv.serfIndices[slot];
    if (idx === 0) continue;
    inv.serfIndices[slot] = 0;
    const serf = state.serfs[idx];
    if (!serf) return;
    setUnionU16(serf, 0xe, bld.firstKnight);
    serf.state = STATE_DEFENDING_CASTLE;
    serf.counter = ENTER_COUNTER;
    bld.firstKnight = idx;
    player.knightMenuCounter = (player.knightMenuCounter + 1) & 0xffff;
    return;
  }

  const genericIdx = inv.serfIndices[SERF_GENERIC];
  if (genericIdx !== 0) {
    inv.serfIndices[SERF_GENERIC] = 0; // unconditionally, and BEFORE the weapons test
    if (inv.resources[RES_SWORD] !== 0 && inv.resources[RES_SHIELD] !== 0) {
      const serf = state.serfs[genericIdx];
      if (!serf) return;
      player.serfCount[SERF_GENERIC] -= 1;
      player.serfCount[SERF_KNIGHT0] += 1;
      player.totalMilitaryScore += 1;
      player.knightMenuCounter = (player.knightMenuCounter + 1) & 0xffff;
      inv.resources[RES_SWORD] -= 1;
      inv.resources[RES_SHIELD] -= 1;
      inv.genericCount -= 1;
      setSerfType(serf, SERF_KNIGHT0); // `serf[0] &= 0x83 ; |= 0x58` — the type bits only
      serf.state = STATE_DEFENDING_CASTLE;
      setUnionU16(serf, 0xe, bld.firstKnight);
      bld.firstKnight = genericIdx;
      return;
    }
  }

  // Neither a knight nor a usable generic: request from another warehouse, throttled.
  const cooldown = player.castleRequestCooldown;
  player.castleRequestCooldown = (cooldown - 1) & 0xffff;
  if (cooldown !== 0) return;
  player.castleRequestCooldown = REQUEST_COOLDOWN;
  requestKnightForBuilding(state, bld);
  // `bld[8] = 0xffff` (@0x15062) — **restore the inventory marker** that the request tail has just
  // changed (`request_serf` @0x12822 computes `-0x10` on the same byte). This also explains the one
  // save out of 114 that shows a finished castle with byte 8 == 0xFE: it was written between the
  // request and the restore.
  bld.stock[0] = { available: 0xf, requested: 0xf };
  bld.stock[1] = { available: 0xf, requested: 0xf };
}

/**
 * **Full complement** (`want == have`, @0x150ea) — the **rank rotation**. It moves no serf but
 * **swaps two type bytes**:
 *
 * 1. Find the **highest** rank in the garrison chain (`best`, @0x15145 takes when `best < rank`).
 * 2. If `best == 1` (all Knight0) there is nothing to improve -> done (`cmpw $0x1` @0x15169).
 * 3. Find the **lowest** rank in the stock that is still **strictly weaker** than `best`: cascade
 *    K0 -> K3, each preceded by the abort `best == rank+1` (`cmpw $0x2/$0x3/$0x4`). The slot found is
 *    cleared in the representative cache.
 * 4. **Swap the type bytes of the two serfs.**
 *
 * Net effect: the high rank moves into the stock and the low one into the castle garrison. That fits
 * the knight request, which draws stock knights in the order K4 -> K0: the strong ranks stand where
 * they can be sent to the front.
 *
 * The swap covers the **whole byte 0** in the original (owner, type, sound bit). Owner and sound bit
 * are the same on both — both belong to the same player, and the bit is clear at rest — so the type
 * suffices here. (A counterexample would be a stock serf with the sound bit set; it would carry the
 * sound over to its partner. Not observed, and without evidence it is not reproduced.)
 */
function rotateCastleRanks(state: GameState, bld: Building, _player: Player): void {
  if (bld.firstKnight === 0) return;

  let best = 0;
  let bestIdx = 0;
  for (let idx = bld.firstKnight; idx !== 0; ) {
    const serf = state.serfs[idx];
    if (!serf) break;
    const rank = knightRank(serf);
    if (best < rank) {
      best = rank;
      bestIdx = idx;
    }
    idx = unionU16(serf, 0xe);
  }
  if (best === 1) return;

  const inv = castleInventory(state, bld);
  if (!inv) return;
  let stockIdx = 0;
  for (let i = 0; i < KNIGHT_SLOTS_LOW_FIRST.length; i++) {
    const slot = KNIGHT_SLOTS_LOW_FIRST[i]!;
    const idx = inv.serfIndices[slot];
    if (idx !== 0) {
      inv.serfIndices[slot] = 0;
      stockIdx = idx;
      break;
    }
    // Stop as soon as the next stock rank would no longer be weaker than `best`.
    if (best === i + 2) return;
  }
  if (stockIdx === 0) return;

  const garrisonSerf = state.serfs[bestIdx];
  const stockSerf = state.serfs[stockIdx];
  if (!garrisonSerf || !stockSerf) return;
  const t = garrisonSerf.type;
  setSerfType(garrisonSerf, stockSerf.type);
  setSerfType(stockSerf, t);
}
