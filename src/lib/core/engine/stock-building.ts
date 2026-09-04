/**
 * Warehouse handler and the shared stock tail - `warehouse_building_handler` (`FUN_0001528c`) and
 * `code_r0x0001537e`.
 *
 * The two buildings that carry an inventory, warehouse and castle, each have their own head in the
 * driver table but meet in the same tail: the castle jumps into it at the end, the warehouse falls
 * into it. The tail therefore lives here and is used by the castle garrison too.
 *
 * The warehouse head has two faces, on `bld[5]` bit 4 ("active"): freshly completed it allocates the
 * inventory, links it, sets the `0xFF` stock marker, posts the "new warehouse" message and RETURNS -
 * the tail does not run that frame. Afterwards it requests a carrier when it has none.
 *
 * Two differences to the production branch that are easy to lose when copying: the holder request
 * tests only holder/requested, not `serfRequestFailed`, and a failure sets no error bit. So a
 * warehouse asks again every rotation until a carrier arrives, whereas a production building gives up
 * until the round-robin reset.
 *
 * The tail adds the warehouse's gold bars to `player+0x180` and cleans the FLAG tile. Two things
 * matter there:
 *
 * The gold accumulation is an ACCUMULATOR, not a stock: `player+0x180` has exactly this one writer and
 * is read and zeroed by `update_knight_morale`, where together with the gold inside military buildings
 * it becomes `goldDeposited` and the knight morale. The consumer runs once per rotation round and the
 * tail once per warehouse and round, which is why the save holds the full sum. The second summand
 * comes from the military block, and in the campaign saves the gold sits entirely in military
 * buildings - a morale computed from warehouses alone would be plainly wrong, not slightly off.
 *
 * The flag tile is cleaned because a serf index left standing there, whose serf has long walked on,
 * blocks every further arrival.
 */

import type { GameState, Building, Inventory, Player } from './state.js';
import { allocInventory } from './alloc.js';
import { addPlayerMessage } from './player-messages.js';
import { sendSerfToFlag, type WorkerRequest } from './serf-request.js';
import { neighbor, posOf, Direction } from './position.js';

/** Resource index 14 = gold bar (`inv+0x22`). */
const RES_GOLD_BAR = 14;
/** Serf type 0 (transporter) — a warehouse's carrier (`mov $0x0` @0x15360). */
const SERF_TRANSPORTER = 0;
/** Serf type 21 (generic) — the resupply for an empty warehouse (`mov $0x15` @0x15414). */
const SERF_GENERIC = 21;
/** Reset of the generic resupply countdown `player+0x160` (`mov $0x5` @0x15406). */
const GENERIC_REQUEST_COOLDOWN = 5;
/** Message type 7 = a new warehouse is ready (`mov $0x7` @0x15328). */
const MESSAGE_WAREHOUSE_READY = 7;
/**
 * `inv[1] & 0x0a` — bit 1 of the resource **and** bit 1 of the serf mode. Both fields only ever take
 * the values 0/1/**3**, so the mask hits exactly the "out" state (3). Resupply rests while the
 * warehouse is being emptied anyway.
 */
const RES_DIR_OUT_MASK = 0x0a;

/** The warehouse's carrier request: transporter, no tools (`send_serf_to_flag(0, 0, 0)`). */
const HOLDER_REQUEST: WorkerRequest = { serfType: SERF_TRANSPORTER, tools: [] };
/**
 * Generic resupply: unspecialised serf, no tools (`send_serf_to_flag(0x15, 0, 0)`). The type is not
 * decoration — it selects a separate dispatch tail in the search (`cmpw $0x2a` @0x128cb).
 */
const GENERIC_REQUEST: WorkerRequest = { serfType: SERF_GENERIC, tools: [] };

/** The inventory of a stock building (`bld[0xe]`). */
function stockInventory(state: GameState, bld: Building): Inventory | null {
  if (bld.inventoryIndex === null || bld.inventoryIndex === undefined) return null;
  return state.inventories[bld.inventoryIndex] ?? null;
}

/**
 * Building handler of the warehouse (type 10). First pass: create the inventory and report it.
 * After that: request a carrier while there is none, and fall into the shared tail.
 */
export function warehouseBuildingHandler(state: GameState, bld: Building): void {
  if (!bld.active) {
    activateWarehouse(state, bld);
    return; // @0x1534a — the tail only runs in the next round
  }
  // No `serfRequestFailed` gate and no error bit on failure, unlike production buildings.
  if (!bld.holder && !bld.serfRequested) sendSerfToFlag(state, bld, HOLDER_REQUEST);
  stockBuildingTail(state, bld);
}

/**
 * **Activation** (@0x152a4) — a completed warehouse gets its inventory.
 *
 * The back link on the flag (`flag[0x42] = 0xc0`, "an inventory hangs here") is **not** set here but
 * only when the requested carrier arrives (`enter_building_transporter` @0x2325f). Until then the
 * inventory is invisible to the network search — deliberately so: a warehouse without a carrier
 * accepts nothing.
 */
function activateWarehouse(state: GameState, bld: Building): void {
  const inv = allocInventory(state);
  inv.owner = bld.owner & 3;
  inv.building = bld.index;
  inv.flag = bld.flag;
  bld.inventoryIndex = inv.index;
  // `mov $0xffff,%ax ; mov %ax,0x8(%ebx)` @0x15309/@0x15310 — **both** stock slots become the
  // inventory marker. Not merely a flag: from now on the delivery addition `+0x0f` overflows on this
  // byte, and that carry is the branch into the inventory (@0x22c74 -> @0x22c8a).
  bld.hasInventory = true;
  bld.stock[0] = { available: 0xf, requested: 0xf };
  bld.stock[1] = { available: 0xf, requested: 0xf };
  bld.active = true; // `bts $0x4` @0x1531c
  const player = state.players[bld.owner & 3];
  if (player) {
    addPlayerMessage(player, MESSAGE_WAREHOUSE_READY, posOf(bld.col, bld.row, state.geo));
  }
}

/**
 * The tail shared with the castle (@0x1537e): generic resupply, gold accumulation, cleaning the
 * flag tile. See the module head.
 */
export function stockBuildingTail(state: GameState, bld: Building): void {
  const inv = stockInventory(state, bld);
  const player = state.players[bld.owner & 3] ?? null;

  if (inv !== null && player !== null) {
    requestGenericSupply(state, bld, inv, player);
    player.goldAccumulator = (player.goldAccumulator + inv.resources[RES_GOLD_BAR]!) >>> 0;
  }
  cleanStaleFlagSerf(state, bld);
}

/**
 * Resupply branch (@0x1538d): an occupied, outputting warehouse without a generic asks again,
 * throttled.
 *
 * **The castle runs this too** — it jumps into the tail at @0x1537e and only skips the carrier
 * request. That is safe because `send_serf_to_flag` gives serf type `0x15` a dispatch tail of its
 * own (@0x128d6) which does **not** claim the building's holder slot; for a castle that slot is the
 * head of the garrison chain. See {@link sendSerfToFlag}'s dispatch.
 *
 * Note what is NOT tested here: whether a resupply is already on its way. There is no such gate in
 * the original, so an empty store asks again every six rounds until one arrives.
 */
function requestGenericSupply(
  state: GameState,
  bld: Building,
  inv: Inventory,
  player: Player,
): void {
  if (!bld.holder) return;
  if ((inv.resDir & RES_DIR_OUT_MASK) !== 0) return;
  if (inv.genericCount !== 0) return;
  // `subw $1 ; jae` — it always counts down, but only fires on underflow (counter was 0).
  const cooldown = player.genericRequestCooldown;
  player.genericRequestCooldown = (cooldown - 1) & 0xffff;
  if (cooldown !== 0) return;
  player.genericRequestCooldown = GENERIC_REQUEST_COOLDOWN;
  sendSerfToFlag(state, bld, GENERIC_REQUEST);
}

/**
 * Cleanup branch (@0x15484): if the warehouse's **flag tile** holds a serf index whose serf is no
 * longer there, the slot is cleared.
 */
function cleanStaleFlagSerf(state: GameState, bld: Building): void {
  const geo = state.geo;
  const flagPos = neighbor(posOf(bld.col, bld.row, geo), Direction.DownRight, geo);
  const tile = state.mapTiles[flagPos];
  if (tile === undefined || tile.serfIndex === 0) return;
  const serf = state.serfs[tile.serfIndex];
  if (serf && serf.col !== null && serf.row !== null && posOf(serf.col, serf.row, geo) === flagPos) {
    return;
  }
  tile.serfIndex = 0;
}
