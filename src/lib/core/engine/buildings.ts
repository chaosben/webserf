/**
 * **Building update driver** — port of `FUN_000130f2`, which runs in the logic group **before** the
 * serf driver. It walks the occupied buildings and dispatches each one:
 * - **not burning** => per-type handler (`LAB_000132e2[type*8]`): requests workers and input goods and
 *   sets a request priority. The actual **production** is done by the worker serf in its own state.
 * - **burning** => burn-down countdown (`bld+10` counter, `bld+0xe` tick stamp), at 0 the finale
 *   (`FUN_00013562`).
 *
 * **Rotation:** the original processes 1/32 of the buildings per sub-tick (`gs->field_0x26c`); this
 * port processes **every** building every logic tick. That is equivalent here because the priority is
 * a pure function of the stock level and the burn counter is delta based. Phase A (`request_serf`) is
 * the exception and stays rotation gated — see {@link updateBuildings}.
 */

import type { GameState, Building, Player, Serf } from './state.js';
import { setSerfType } from './state.js';
import { requestBuildingWorkers } from './serf-request.js';
import { posOf, colOf, rowOf, neighbor, Direction } from './position.js';
import { BUILDING_SCORE } from './building-tables.js';
import { recomputeTerritory } from './territory.js';
import { freeBuildingSlot, freeInventorySlot } from './alloc.js';
import { cancelTransportOnDelete } from './transport-cancel.js';
import { cancelTransitResource, demolishFlag } from './road-teardown.js';
import { constructionDemand } from './building-construction.js';
import { clearFlagAcceptBytes } from './flag-accept.js';

/** Military building types (hut/tower/fortress/castle) — these project territory influence. */
const MILITARY_TYPES = new Set([11, 21, 22, 24]);

/**
 * `LAB_000132e2` **phase B** — material request priority, taken byte for byte from the per-type
 * handlers. For each input stock slot of an **occupied** production building it sets the priority on
 * the building's flag (`flag.stockPriority[slot]` = `flag[0x43|0x45]`):
 *
 * ```
 * fill = stock[slot].available + stock[slot].requested
 * prio = fill < 8 ? ((base8 >> fill) & 0xff) : 0
 * ```
 *
 * `base8` is the high byte of the matching distribution slider; goods without a slider (lumber, flour,
 * pig, iron, gold) use the constant **0xff**. The demand *mask* (which good the slot wants) is set by
 * the worker on entry, not here.
 *
 * **Deliberately not modelled:** the "planks/steel reserved" pre-check (`player[0x163]` bit 1) for the
 * boatbuilder and toolmaker slot 0 — treated here as "not reserved".
 */
interface DemandSlot {
  readonly slot: 0 | 1;
  /** Distribution slider (u16) for this slot, or `undefined` => constant 0xff. */
  readonly slider?: (p: Player) => number;
}
const PHASE_B_DEMAND: ReadonlyMap<number, readonly DemandSlot[]> = new Map([
  [3, [{ slot: 0, slider: (p: Player) => p.planksDistribution[1] }]], // boatbuilder <- plank
  [5, [{ slot: 0, slider: (p: Player) => p.foodDistribution[0] }]], // stone mine <- food
  [6, [{ slot: 0, slider: (p: Player) => p.foodDistribution[1] }]], // coal mine <- food
  [7, [{ slot: 0, slider: (p: Player) => p.foodDistribution[2] }]], // iron mine <- food
  [8, [{ slot: 0, slider: (p: Player) => p.foodDistribution[3] }]], // gold mine <- food
  [13, [{ slot: 0 }]], // butcher <- pig (0xff)
  // OPEN @0x14746 — an original defect, deliberately NOT reproduced. The pig farm reads its player
  // pointer from `ctx+0x30` (`mov 0x30(%edi),%ebx`) **without ever setting it**: its whole body
  // @0x146bf..0x14778 contains no writer of that slot. It therefore computes with whatever player a
  // handler that ran EARLIER left there; the mill next to it does it correctly (@0x14868..@0x14887).
  // Not reproduced because the stale value depends on the entire preceding frame, including the flag
  // and serf passes — a partial emulation would be an invention. Effect: the demand priority of ONE
  // pig farm, no structural difference.
  [14, [{ slot: 0, slider: (p: Player) => p.wheatDistribution[0] }]], // pig farm <- wheat
  [15, [{ slot: 0, slider: (p: Player) => p.wheatDistribution[1] }]], // mill <- wheat
  [16, [{ slot: 0 }]], // baker <- flour (0xff)
  [17, [{ slot: 1 }]], // sawmill <- lumber (0xff, slot 1)
  [18, [{ slot: 0, slider: (p: Player) => p.coalDistribution[0] }, { slot: 1 }]], // steel smelter <- coal + iron(0xff)
  [19, [{ slot: 0, slider: (p: Player) => p.planksDistribution[2] }, { slot: 1, slider: (p: Player) => p.steelDistribution[0] }]], // toolmaker <- plank + steel
  [20, [{ slot: 0, slider: (p: Player) => p.coalDistribution[2] }, { slot: 1, slider: (p: Player) => p.steelDistribution[1] }]], // weaponsmith <- coal + steel
  [23, [{ slot: 0, slider: (p: Player) => p.coalDistribution[1] }, { slot: 1 }]], // gold smelter <- coal + gold(0xff)
]);

/**
 * `LAB_000132e2` **construction branch** (build material demand) — the shared head handler
 * `FUN_000138ed` @0x138ed. The dispatch uses `(bld[4] & 0xfc) * 2`, and `bld[4]` bit 7 (`constructing`)
 * thereby sets the high index bit, so **every building under construction jumps to the shared head**
 * while finished ones go to their production handler.
 *
 * The formula differs from production phase B — hence a handler of its own:
 * ```
 * fill = avail + req
 * if (fill < 8 && fill != stockMaximum[slot]):
 *     prio = base >> fill          // base = (planks>>8)&0xff or 0xff
 *     if (!holder) prio >>= 2      // an unoccupied site is throttled further
 *     flag.stockPriority[slot] = prio & 0xfe
 * else: flag.stockPriority[slot] = 0
 * ```
 * The **`stockMaximum` gate** ties demand to the type's real material need (a coal mine `[5,0]` asks for
 * planks but NO stone; a hut `[1,1]` for both).
 *
 * **Runs only when `progress != 0`** — while still levelling, the original flow never reaches the tail:
 * the large body @0x138ed returns after requesting the digger.
 *
 * The **event** part of the same tail (the emergency demolition, which draws a random value) therefore
 * does NOT run here (`allowEmergency = false`) — it hangs on the rotation-gated
 * {@link buildingConstructionHead}.
 */
function updateConstructionDemand(state: GameState, bld: Building, index: number): void {
  if (bld.progress === 0) return; // still levelling => the head returns before the tail
  constructionDemand(state, bld, index, false);
}

/** Sets the material request priority on the building's flag (phase B, see above). */
function updatePhaseBDemand(state: GameState, bld: Building): void {
  if (bld.constructing) return; // production demand only for FINISHED buildings
  if (!bld.holder) return; // bld[5] & 0x40 — only an occupied building requests
  const spec = PHASE_B_DEMAND.get(bld.type);
  if (spec === undefined) return;
  const flag = state.flags[bld.flag];
  if (!flag) return;
  const player = bld.owner >= 0 ? state.players[bld.owner] : null;
  for (const d of spec) {
    const st = bld.stock[d.slot];
    if (!st) continue;
    const fill = st.available + st.requested;
    let prio = 0;
    if (fill < 8) {
      const base8 = d.slider && player ? (d.slider(player) >> 8) & 0xff : 0xff;
      prio = (base8 >> fill) & 0xff;
    }
    flag.stockPriority[d.slot] = prio;
  }
}

/**
 * Building update driver (`FUN_000130f2`) — the one building routine of the frame loop, between the
 * flag scheduler and the serf driver.
 *
 * **The per-type dispatch itself lives in `serf-request.ts`** (`requestBuildingWorkers`): every ported
 * type handler (military, castle, warehouse) hangs on the request head.
 *
 * **Phase A (`request_serf`) is part of THIS routine** in the original (the head of each per-type
 * handler), not a frame-loop step of its own — hence grouped here and executed **only at the frame
 * boundary**, rotation gated. Calling the whole request block first and the phase B loop afterwards is
 * behaviourally identical to the original's per-building "A then B", because the two are mutually
 * exclusive per building (A gates on `!holder && !serfRequested && !serfRequestFailed`, B on `holder`)
 * and B reads nothing that A writes apart from `bld` itself.
 */
export function updateBuildings(state: GameState, frameBoundary = false): void {
  // Phase A (request_serf) — head of the per-type handler, rotation gated => frame boundary only.
  if (frameBoundary) requestBuildingWorkers(state);
  const { buildings } = state;
  for (let i = 0; i < buildings.length; i++) {
    const bld = buildings[i];
    if (bld === null) continue;
    if (bld.burning) {
      updateBurning(state, bld, i);
      continue;
    }
    if (bld.constructing) updateConstructionDemand(state, bld, i);
    else updatePhaseBDemand(state, bld);
  }
}

// ── Burning down (razing) ────────────────────────────────────────────────────────────────────────
//
// Three phases: the **initiator** `FUN_00048eb8` ({@link demolishBuilding}) sets the burn bit and the
// countdown, transfers the score, detaches the flag and clears the path bits of both tiles; the
// **countdown** in the driver ({@link updateBurning}); the **finale** `FUN_00013562`
// ({@link finishBurn}), which clears the tile object and frees the slot.
//
// The **burning union** reinterprets two building record fields while burning: `firstKnight` (off 10)
// is the countdown, `level` (off 14) the burn tick stamp.
const BURN_DURATION = 0x7ff; // bld+10 = 0x7ff (2047 game ticks)
/** A burning **castle** counts four times as long (`movw $0x1fff` @0x4950c). */
const CASTLE_BURN_DURATION = 0x1fff;

/**
 * Countdown step of a burning building (`FUN_000132a9`): read the old burn tick (`bld+0xe`), set it to
 * `gameTick`, subtract the elapsed ticks from the countdown (`bld+10`); an **underflow** (old countdown
 * < elapsed) triggers the finale.
 *
 * The original is wall-clock paced, so its elapsed value varies; here `gameTick` advances by one per
 * tick, which makes the moment of disappearance deterministic.
 */
function updateBurning(state: GameState, bld: Building, index: number): void {
  const now = state.gameTick & 0xffff;
  const elapsed = (now - ((bld.level ?? now) & 0xffff)) & 0xffff;
  bld.level = now; // bld+0xe = gameTick
  const old = (bld.firstKnight ?? 0) & 0xffff; // bld+10 (countdown)
  bld.firstKnight = (old - elapsed) & 0xffff;
  if (old < elapsed) finishBurn(state, bld, index);
}

/**
 * Ejecting the worker or garrison serfs on demolition — the `if (holder)` block of `FUN_00048eb8`.
 * Called with the **old** `firstKnight` (union field `bld+10`, before the countdown overwrites it).
 *
 * Each serf goes to state **25 Lost** if it is the visible tile occupancy (`serfIndex ==
 * tile.serfIndex`), otherwise to **28 EscapeBuilding** — the difference being whether it stands
 * outside or inside. Military buildings and the castle walk the garrison chain `firstKnight ->
 * serf[0xe]`; a non-military holder is a single worker serf, additionally reset from type 4
 * (TransporterInventory) back to generic.
 */
function ejectHolderSerfs(state: GameState, bld: Building, oldFirstKnight: number): number {
  const geo = state.geo;
  const military = bld.type === 11 || bld.type === 21 || bld.type === 22; // hut/tower/fortress
  const ejectOne = (s: Serf): void => {
    const onTile =
      s.col !== null && s.row !== null && state.mapTiles[posOf(s.col, s.row, geo)].serfIndex === s.index;
    if (onTile) {
      s.state = 25; // Lost — walks home
      s.stateData[0] = 0; // serf[0xb] = 0
    } else {
      s.state = 28; // EscapeBuilding — still inside
    }
  };

  if (!military && bld.type !== 24) {
    // Non-military holder: the single worker serf.
    const s = state.serfs[oldFirstKnight & 0xffff];
    if (s) {
      if (s.type === 4) {
        // TransporterInventory => reset the type nibble (serf+0 &= 0x83; owner and sound stay).
        setSerfType(s, 0);
        s.stateData[0] = 0;
      }
      s.counter = 0; // serf+2 = 0
      ejectOne(s);
    }
    return BURN_DURATION;
  }

  let burnTicks = BURN_DURATION;
  if (bld.type === 24) {
    // ── Castle branch (@0x494e3 `cmpb $0x60` … @0x49522) ──
    // Losing your own castle: clear "has castle", lower the **castle balance** by 1 (the counterpart
    // to the `+1` for capturing a foreign castle in serf state 52), and burn four times as long.
    const owner = state.players[bld.owner];
    if (owner) {
      owner.build &= ~8; // player+3 `btr $0x3` — bit 3 "has castle"
      owner.castleCaptureBalance = ((owner.castleCaptureBalance - 1) << 16) >> 16; // i16
      // The **castle builder** (player+0x16e) is the one serf not in the garrison chain and is
      // ejected separately here — even long after the castle is finished and he works as a warehouse
      // transporter, because the field is never reset on completion.
      const builder = state.serfs[owner.castleBuilderSerf & 0xffff];
      if (owner.castleBuilderSerf !== 0 && builder) {
        setSerfType(builder, 0); // serf+0 &= 0x83
        builder.stateData[0] = 0; // serf[0xb] = 0
        builder.counter = 0; // serf+2 = 0
        ejectOne(builder);
      }
    }
    burnTicks = CASTLE_BURN_DURATION;
  }

  // Garrison chain: firstKnight -> serf[0xe]. Runs for military buildings **and** the castle (the
  // original shares the loop head behind the type dispatch).
  let k = oldFirstKnight & 0xffff;
  let guard = 0;
  while (k !== 0 && guard++ < 4096) {
    const s = state.serfs[k];
    if (!s) break;
    ejectOne(s);
    k = (s.stateData[3] | (s.stateData[4] << 8)) & 0xffff; // serf[0xe] = next knight
  }
  return burnTicks;
}

/**
 * Burn **initiator** `FUN_00048eb8` @0x48eb8 — starts the fire on one's **own** building (manual
 * demolition or loss of territory).
 *
 * Sets the burn bit, clears the two path bits between building and flag, transfers the score, ejects
 * the holder serfs, detaches the flag, empties the stock and starts the countdown. The two tails that
 * are easy to miss: {@link cancelTransportOnDelete} (@0x496eb) and, at the very end, the removal of a
 * flag that is left path-less (@0x49742).
 *
 * The territory recolour (`FUN_00045a30`) sits where the original has it — right after the gold
 * subtraction and **before** the warehouse block, the ejection and the transport cancellation. It is
 * gated exactly as in the binary; see the comment at the call site.
 */
export function demolishBuilding(state: GameState, bld: Building): void {
  if (bld.burning) return; // already burning
  bld.burning = true; // bld+5 |= 0x20

  // Clear the path bits of the building and flag tiles (@0x48fd1/@0x48ff6).
  const pos = posOf(bld.col, bld.row, state.geo);
  state.mapTiles[pos].paths &= ~(1 << Direction.DownRight); // building -> flag (bit 1)
  const flagPos = neighbor(pos, Direction.DownRight, state.geo);
  const flagTile = state.mapTiles[flagPos];
  flagTile.paths &= ~(1 << Direction.UpLeft); // flag -> building (bit 4)

  // ── Gold leaves the world with the building (@0x4903c / @0x49338 / @0x4914e) ──
  // `mapGoldTotal` (gs+0x4c) is the **denominator of knight morale**: how much gold the map still
  // holds at all. If a building that holds gold burns down, it must fall too — otherwise every
  // demolition permanently dilutes the morale of all players. Three cases, and **before** the stock is
  // emptied further down: military buildings and the gold smelter keep their gold in the **high nibble
  // of `bld+9`**, a warehouse or castle in its inventory.
  const goldNibble = bld.stock[1].available & 0xf;
  if (MILITARY_TYPES.has(bld.type) && bld.type !== 24) {
    state.header.mapGoldTotal = (state.header.mapGoldTotal - goldNibble) >>> 0; // @0x49057
  } else if (bld.type === 23) {
    state.header.mapGoldTotal = (state.header.mapGoldTotal - goldNibble) >>> 0; // @0x49361
  }

  // ── Recolour the territory (@0x49035 castle, @0x49066 hut/tower/fortress) ──
  // The building is `burning` now, so it no longer projects influence and its land retreats. Two
  // details that are easy to get wrong:
  //
  //  * The military branch is **gated on the garrison chain** (`mov 0xa(%ebx),%ax ; or %ax,%ax ;
  //    je` @0x4905d): a building that never took a knight also never stamped influence, so there is
  //    nothing to retreat. The castle branch has no such gate.
  //  * The gate reads `bld+0xa` **while it still holds the knight chain**. Further down the same
  //    union becomes the burn countdown, which is never 0 — reading it there would make the gate
  //    always true and silently useless.
  //
  // The call belongs **here**, before the warehouse block and the ejection: the recolour can burn
  // buildings on lost tiles, and those see this building with its stock and flag still attached.
  const knightChain = bld.firstKnight ?? 0;
  if (bld.col !== null && bld.row !== null) {
    if (bld.type === 24 || (MILITARY_TYPES.has(bld.type) && knightChain !== 0)) {
      recomputeTerritory(state, bld.col, bld.row);
    }
  }

  // ── Warehouse/castle: cancel the out queue, subtract the gold, free the inventory slot ──
  // (@0x49070..@0x49168; only when the building is **active**, `bt $0x4` @0x490cd.)
  // The two out-queue slots are tested **nested** in the original: if slot 0 is empty, slot 1 is never
  // looked at (`je 0x49138` @0x49104 skips both). Reproduced faithfully, even though it looks like an
  // original oversight.
  const inv = bld.inventoryIndex != null ? state.inventories[bld.inventoryIndex] : null;
  if (bld.active && (bld.type === 24 || bld.type === 10) && inv) {
    if (inv.outQueue[0].type >= 0) {
      cancelTransitResource(state, inv.outQueue[0].type + 1, inv.outQueue[0].dest);
      if (inv.outQueue[1].type >= 0) {
        cancelTransitResource(state, inv.outQueue[1].type + 1, inv.outQueue[1].dest);
      }
    }
    // `inv+0x20`/`inv+0x22` = `resources[13]`/`resources[14]` = gold ore and gold bars in store.
    state.header.mapGoldTotal =
      (state.header.mapGoldTotal - (inv.resources[13] ?? 0) - (inv.resources[14] ?? 0)) >>> 0;
    freeInventorySlot(state, inv.index); // `call 0x456cd` @0x49163
  } else if (bld.type !== 24 && bld.type !== 10) {
    // The branch @0x49364 that only **non**-inventory types reach: `btr $0x4` on `bld+5`. Warehouse and
    // castle keep their `active` bit — as in the original, whose path never comes past here.
    (bld as { active: boolean }).active = false;
  }

  // Score and counter bookkeeping on the owner.
  const player = state.players[bld.owner];
  if (player) {
    const j = bld.type - 1;
    if (bld.constructing) {
      if (j >= 0 && j < player.incompleteBuildingCount.length) player.incompleteBuildingCount[j] -= 1;
    } else {
      // u32 arithmetic as in the binary (`sub` on a 32-bit field): the value wraps below 0 and is
      // only clamped to 0 by the player tick (`clampScoreUnderflow`, @0xf071).
      player.totalBuildingScore = (player.totalBuildingScore - (BUILDING_SCORE[bld.type] ?? 0)) >>> 0;
      if (bld.type !== 24 && j >= 0 && j < player.completedBuildingCount.length) {
        player.completedBuildingCount[j] -= 1;
      }
    }
  }

  // Ejection: only with `holder` set, and with the OLD firstKnight (union `bld+10`, before the
  // countdown overwrites it below). The return value is the **burn duration**: the original sets
  // `bld[10] = 0x7ff` before the ejection and overwrites it with `0x1fff` in the castle branch
  // (@0x4950c). This port sets `bld[10]` further down and therefore passes the value through.
  const burnTicks = bld.holder ? ejectHolderSerfs(state, bld, bld.firstKnight ?? 0) : BURN_DURATION;

  // Flag detach + transport cancellation — the tail `FUN_0004968a` the ejection falls into
  // (`jmp 0x4968a` @0x4960b/@0x49680). The order matters: the ejection sets the serf states to
  // 0x19/0x1c, so those same serfs **no longer** match in the cancellation.
  const flag = state.flags[bld.flag];
  if (flag) {
    flag.connections[Direction.UpLeft] = null; // flag+0x34 = 0 (UpLeft endpoint to the building)
    flag.hasBuilding = false; // flag+4 &= 0xbf
    // The **whole** byte (@0x496db/@0x496e5), so the demand mask too — otherwise the flag of a
    // demolished building keeps advertising for its material.
    clearFlagAcceptBytes(flag);
  }
  cancelTransportOnDelete(state, bld.flag); // `call 0x178f0` @0x496eb

  bld.holder = false; // bld+5 &= 0xbf
  bld.playingSfx = false; // bld+5 &= 0xf7
  bld.stock[0] = { available: 0, requested: 0 }; // bld+8 = 0
  bld.stock[1] = { available: 0, requested: 0 }; // bld+9 = 0
  bld.firstKnight = burnTicks; // bld+10 (union => countdown), 0x1fff for the castle
  bld.level = state.gameTick & 0xffff; // bld+0xe = gameTick (union => burn tick)

  // **The end of the tail** (@0x49742–@0x497a7): if the building's flag is left **path-less** and
  // still carries its flag object, it goes too. Both tests read the landscape bytes of the flag tile:
  // `paths & 0x3f == 0` (@0x4974d) and `object & 0x7f == 1` (@0x49765). The call
  // `demolish_flag(col+1, row+1)` (@0x49789) hits exactly that tile — it just works in coordinates
  // instead of byte offsets.
  if ((flagTile.paths & 0x3f) === 0 && flagTile.object === 1) {
    demolishFlag(state, flagTile.objIndex, colOf(flagPos, state.geo), rowOf(flagPos, state.geo));
  }
}

/**
 * Burn **finale** `FUN_00013562` @0x13562 — fires when the countdown runs out: clears the tile object
 * and frees the building slot. The flag stays (the initiator already detached it).
 *
 * The original's closing call to `FUN_00032075` is the build-site/cursor classification, which
 * refreshes `player+0x100..0x102` after the map event. That is pure cursor bookkeeping and is not
 * tracked here — this port classifies on demand.
 */
function finishBurn(state: GameState, bld: Building, index: number): void {
  const tile = state.mapTiles[posOf(bld.col, bld.row, state.geo)];
  tile.blocked = false; // paths byte &= 0xbf (block bit 6)
  tile.object = 0; // object byte &= 0x80 (the water bit is not modelled here)
  tile.objIndex = 0;
  freeBuildingSlot(state, index);
}


