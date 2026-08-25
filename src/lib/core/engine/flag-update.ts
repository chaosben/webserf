/**
 * Flag update / resource scheduler — `FUN_0004b858`, the per-frame routine that schedules waiting
 * resources at a flag. Helpers: `FUN_0004c2bd` (source seeding, ccw order), `FUN_00044a52` (network
 * BFS executor), demand table `DAT_0004b822`.
 *
 * Effect: sets `slotDir` (pickup direction) plus the `scheduled` bit (`flag[0x3c+dir]` bit 7) for a
 * waiting resource. That bit is what wakes the resting IdleOnPath/IdleInStock carrier (handlers
 * 66/67) — without this driver a freshly dropped resource stays unscheduled forever.
 *
 * Deliberate divergence: `otherEndDir` bit 6 is not preserved (the decoded model carries bits 3..5
 * only); the original masks it with `&0x78`, but it is 0 in every observed state.
 *
 * Frame cadence: the original runs two clocks — a ~100 Hz game tick and a ~12.5 fps frame loop with
 * `delta = 8` game ticks per frame. `Flag::update` belongs to the FRAME loop: one block of 32 flags
 * per frame (start index `rotation·32`, wrap `rotationWrap` = 49, only rotations < 32 touch flags).
 * A flag is therefore visited once per wrap cycle (~2 s), and that delay IS the pause before a
 * resting carrier starts moving — the wake handler itself is instant. Scheduling a fresh resource
 * needs two passes: unknown-dest sets `dest`, known-dest sets `scheduled`. Driving this off the
 * game tick instead would run it ~8x too fast.
 */
import type { GameState, Flag, Inventory, Serf } from './state.js';
import { setSerfType } from './state.js';
import { setUnionU8, setUnionU16 } from './serf-machine.js';
import { returnTransitResourceToStock } from './road-teardown.js';

/**
 * Demand table `DAT_0004b822`, indexed `(res+1)*2`. `null` = not routable to a building, inventory
 * only: boat (8) and the tools (15..25). Otherwise `{reqBit, flagByte}` — which bit of which
 * bld_flags byte a demanding building tests.
 */
export const DEMAND_TABLE: ReadonlyArray<{
  reqBit: number;
  flagByte: number;
} | null> = [
  { reqBit: 0, flagByte: 0x42 }, // 0  Fish
  { reqBit: 3, flagByte: 0x42 }, // 1  Pig
  { reqBit: 0, flagByte: 0x42 }, // 2  Meat
  { reqBit: 4, flagByte: 0x42 }, // 3  Wheat
  { reqBit: 5, flagByte: 0x42 }, // 4  Flour
  { reqBit: 0, flagByte: 0x42 }, // 5  Bread
  { reqBit: 5, flagByte: 0x44 }, // 6  Lumber
  { reqBit: 1, flagByte: 0x42 }, // 7  Plank
  null, //                          8  Boat
  { reqBit: 4, flagByte: 0x44 }, // 9  Stone
  { reqBit: 1, flagByte: 0x44 }, // 10 IronOre
  { reqBit: 2, flagByte: 0x44 }, // 11 Steel
  { reqBit: 2, flagByte: 0x42 }, // 12 Coal
  { reqBit: 0, flagByte: 0x44 }, // 13 GoldOre
  { reqBit: 3, flagByte: 0x44 }, // 14 GoldBar
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null, // 15..25 tools
];

/** Only rotations < 32 process flag blocks; 32.. are the economy rotations. */
const FLAG_ROTATIONS = 32;

/**
 * Driver (`FUN_0004b858`): schedules the waiting resources of one 32-flag block. Pure block
 * processor — the frame clock (frameAccum/rotation) belongs to `advanceFrameClock` in `tick.ts`,
 * which calls this only at a frame boundary.
 *
 * The rotation counter is seeded from the saved state (`.DS`@96, wrap `.DS`@180) rather than derived
 * from the game tick: the saved tick is the 100 Hz timer, which keeps running while the save menu
 * pauses the game, so a derived phase would be shifted and we would process other blocks than the
 * original. With ~168 flags only rotations 0..5 touch flags at all — the loop stops once the start
 * index reaches `maxFlagIndex`.
 */
export function updateFlags(state: GameState): void {
  if (state.rotation >= FLAG_ROTATIONS) return; // economy rotation, no flags

  // Block start == `vreg2 = rotation·32`. Blocks without waiting resources are no-ops because
  // flagUpdate gates on hasResources, so no dirty bitmap is needed.
  const { flags } = state;
  const start = state.rotation * 32;
  const end = Math.min(start + 32, flags.length);
  for (let i = start; i < end; i++) {
    const f = flags[i];
    if (f === null) continue;
    flagUpdate(state, f);
  }
}

/** Resource scheduling of a single flag (`Flag::update`). */
function flagUpdate(state: GameState, f: Flag): void {
  // 1. res_waiting[4]: per scheduled slot, record which directions have >0,>1,>2,>3 waiting slots
  // (one bitfield per level). Slots run 7 -> 0 as in the original (@0x4b978..@0x4b9f9); the order is
  // irrelevant here, but the loop variable survives and is used below.
  const resWaiting = [0, 0, 0, 0];
  // The original's `vreg2`: the loop computes `(flag[0xc+slot] >> 5) - 1` as a WORD into the same
  // variable (@0x4b99a, @0x4b9a1) and leaves it there — nothing below writes it. Running 7 -> 0, the
  // value of slot 0 survives, and that is the starting direction of the back-and-forth branch
  // (@0x4bc6c). An empty or unscheduled slot 0 yields `0 - 1 == 0xffff`.
  let lastSlotDirWord = 0xffff;
  for (let j = 7; j >= 0; j--) {
    const rd0 = f.resourceSlots[j] === -1 ? -1 : f.slotDir[j];
    lastSlotDirWord = rd0 >= 0 ? rd0 : 0xffff;
    if (f.resourceSlots[j] === -1) continue;
    const rd = f.slotDir[j];
    if (rd < 0) continue; // dir == None, not scheduled
    for (let k = 0; k < 4; k++) {
      if ((resWaiting[k] & (1 << rd)) === 0) {
        resWaiting[k] |= 1 << rd;
        break;
      }
    }
  }

  // 2. Schedule waiting resources, only if hasResources (flag[4] bit 7). Slots 7 -> 0, and here the
  // order MATTERS: setting `scheduled` affects later slots of the same direction.
  // `waitingCount` counts OCCUPIED slots, including already scheduled ones (`addw $1` @0x4ba87 sits
  // before the scheduled test). It stays 0 when hasResources was clear — the original jumps
  // @0x4ba4e straight into the request and leaves the counter zeroed at @0x4ba3f.
  let waitingCount = 0;
  if (f.hasResources) {
    f.hasResources = false; // endpoint &= ~BIT(7)
    for (let slot = 7; slot >= 0; slot--) {
      if (f.resourceSlots[slot] === -1) continue;
      waitingCount += 1;
      if (f.slotDir[slot] >= 0) continue; // already scheduled
      if (f.slotDest[slot] !== 0) scheduleKnownDest(state, f, slot, resWaiting);
      else scheduleUnknownDest(state, f, slot, lastSlotDirWord);
    }
  }

  // 3. Transporter request per road (`call_transporter`, `FUN_0004c7c4`). Runs per flag regardless
  // of waiting resources and also maintains flag byte 5. `resWaiting[2]` is the demand mask
  // (directions with >= 3 waiting slots); the four masks map onto `gs+0x218..0x21b` in REVERSE.
  requestTransporters(state, f, resWaiting[2], waitingCount);
}

/** 6-bit transporter mask of the flag (`flag[5] & 0x3f`). */
function transporterMask(f: Flag): number {
  let m = 0;
  for (let d = 0; d < 6; d++) if (f.transporters[d]) m |= 1 << d;
  return m;
}

/**
 * Neighbour flag index in direction `dir`, or -1. The raw endpoint pointer `flag+0x24+4·dir` with NO
 * gate — use it for "the other end of this road" only, never to traverse the network: that is what
 * the two gated variants below are for.
 */
export function neighborFlag(f: Flag, dir: number): number {
  const c = f.connections[dir];
  return c && c.kind === 'flag' ? c.index : -1;
}

/**
 * The original has TWO flag networks, and neither of them is `paths`.
 *
 * Every network traversal shares one body: load ONE record byte, double it twice (which discards
 * bits 7 and 6), then test the sign per direction 5 -> 0. The byte decides which network is meant,
 * and a sweep of the whole game region splits them cleanly — nine traversals, five read `flag[4]`,
 * four read `flag[5]`, none reads `flag[3]`.
 *
 * | Init | Byte | Routine | Network |
 * |---|---|---|---|
 * | @0x11f61 | `flag[4]` | `find_inventory_serf_bfs` @0x11a1a | serfs |
 * | @0x12b7f | `flag[4]` | `send_serf_to_flag` @0x12428 | serfs |
 * | @0x205af | `flag[4]` | walking handler (states 2/3) | serfs |
 * | @0x4481f | `flag[4]` | `find_nearest_inventory` @0x44703 | serfs |
 * | @0x51e54 | `flag[4]` | AI road network extension @0x5155b | serfs |
 * | @0x1011f | `flag[5]` | resource distribution tick | resources |
 * | @0x44b4b | `flag[5]` | `find_nearest_inventory_for_resource` @0x44a52 | resources |
 * | @0x4bd66 | `flag[5]` | `flag_update` @0x4b858 (demand BFS) | resources |
 * | @0x4c42a | `flag[5]` | `FUN_0004c341` (source BFS) | resources |
 *
 * `flag[4]` bits 0..5 mean "land road" ({@link Flag.endpointDirs}); `flag[5]` bits 0..5 mean "this
 * road has a carrier" ({@link Flag.transporters}) — on a water road that carrier is the SAILOR,
 * which is why resources cross water and serfs do not.
 *
 * Consequence: a construction site reachable only over a water road never gets a builder. The
 * original needs no build rule for that; the rule emerges from the gate. The manual states it in
 * words (p. 37): water roads matter for goods transport only.
 *
 * Do not invert this: the water road itself carries goods, but every FURTHER road behind it needs
 * its own carrier, and that request runs through {@link landNeighborFlag}. Without a land-reachable
 * warehouse behind the water road that land component is isolated and stays unserved, so no
 * material arrives either.
 */
export function landNeighborFlag(f: Flag, dir: number): number {
  return f.endpointDirs[dir] ? neighborFlag(f, dir) : -1; // `mov 0x4(%ebx),%al` … `jns`
}

/** Neighbour over a road WITH a carrier (`flag[5]` bit `dir`) — the resource network. */
export function servedNeighborFlag(f: Flag, dir: number): number {
  return f.transporters[dir] ? neighborFlag(f, dir) : -1; // `mov 0x5(%ebx),%al` … `jns`
}

/**
 * `schedule_slot_to_known_dest` (@0x4b858 else branch + `FUN_0004c2bd`): source-seeded network search.
 * Seeds neighbour flags in transporter-idle directions (levels from `res_waiting`), each with
 * `search_dir = dir` (ccw 5 -> 0), and looks for the source that reaches `dest`; its starting
 * direction becomes the pickup direction. Unreachable destination: cancel the resource, clear dest,
 * set hasResources again.
 */
function scheduleKnownDest(state: GameState, f: Flag, slot: number, resWaiting: number[]): void {
  const dest = f.slotDest[slot];
  let tr = transporterMask(f);
  const visited = new Set<number>([f.index]); // local scratch instead of a persistent searchNum
  const sources: { flag: number; dir: number }[] = [];

  // Source adder (`FUN_0004c2bd`): directions 5 -> 0; per set bit clear tr[dir] and queue the
  // neighbour, if unvisited, as a source with search_dir = dir.
  const addSources = (bitmap: number): void => {
    for (let dir = 5; dir >= 0; dir--) {
      if ((bitmap & (1 << dir)) === 0) continue;
      tr &= ~(1 << dir);
      const nb = neighborFlag(f, dir);
      if (nb >= 0 && !visited.has(nb)) {
        visited.add(nb);
        sources.push({ flag: nb, dir });
      }
    }
  };

  // Level 0 = idle carrier directions (no waiting slots).
  const idle = (resWaiting[0] ^ 0x3f) & tr;
  if (idle !== 0) addSources(idle);
  // Levels 1..3, each only while tr still has bits left.
  if (tr !== 0) {
    addSources(resWaiting[0] ^ resWaiting[1]);
    if (tr !== 0) addSources(resWaiting[1] ^ resWaiting[2]);
    if (tr !== 0) addSources(resWaiting[2] ^ resWaiting[3]);
    if (tr !== 0) addSources(resWaiting[3]);
  }

  if (sources.length === 0) {
    f.hasResources = true;
    return;
  }

  // BFS from the source set across the flag network; search_dir propagates from the source.
  const dir = searchFromSources(state, sources, dest);
  if (dir === null) {
    // Undeliverable: cancel the resource and let it be rescheduled.
    cancelTransportedResource(state, f.resourceSlots[slot], dest);
    f.slotDest[slot] = 0;
    f.hasResources = true;
    return;
  }
  applyKnownDestFound(state, f, dir, slot);
}

/**
 * Multi-source flag network BFS: finds which source (carrying its `dir` marking) reaches `dest`.
 * Direction iteration 5 -> 0 is the original's tie-break. Returns the source direction or null.
 */
function searchFromSources(
  state: GameState,
  sources: { flag: number; dir: number }[],
  dest: number,
): number | null {
  const searchDir = new Map<number, number>();
  const visited = new Set<number>();
  let frontier: number[] = [];
  for (const s of sources) {
    if (s.flag === dest) return s.dir;
    if (!visited.has(s.flag)) {
      visited.add(s.flag);
      searchDir.set(s.flag, s.dir);
      frontier.push(s.flag);
    }
  }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const fIdx of frontier) {
      const fl = state.flags[fIdx];
      if (!fl) continue;
      const sd = searchDir.get(fIdx)!;
      for (let dir = 5; dir >= 0; dir--) {
        const nb = servedNeighborFlag(fl, dir);
        if (nb < 0 || visited.has(nb)) continue;
        if (nb === dest) return sd;
        visited.add(nb);
        searchDir.set(nb, sd);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * `schedule_known_dest_cb_`: set pickup direction `dir` for `slot`. Not yet scheduled: set
 * `scheduled` plus slot number. Already scheduled: arbitrate by priority, the higher `flag_prio`
 * wins the slot.
 */
function applyKnownDestFound(state: GameState, f: Flag, dir: number, slot: number): void {
  if (!f.scheduled[dir]) {
    f.scheduled[dir] = true;
    f.scheduledSlot[dir] = slot;
  } else {
    const player = state.players[f.owner];
    const prio = player ? player.flagPriority : null;
    const curSlot = f.scheduledSlot[dir];
    const prioOld = prio ? (prio[f.resourceSlots[curSlot]] ?? 0) : 0;
    const prioNew = prio ? (prio[f.resourceSlots[slot]] ?? 0) : 0;
    if (prioNew > prioOld) f.scheduledSlot[dir] = slot;
  }
  f.slotDir[slot] = dir;
}

/** Building at the UpLeft endpoint (dir 4) of a flag, or null. */
function flagBuilding(state: GameState, f: Flag): (typeof state.buildings)[number] | null {
  const c = f.connections[4];
  if (!c || c.kind !== 'building') return null;
  return state.buildings[c.index] ?? null;
}

/**
 * Routable demand BFS (`schedule_slot_to_unknown_dest`, routable branch @0x4b858 + `LAB_0004c0a4`):
 * searches the reachable flag network for the flag whose attached building demands the resource —
 * `flag[flagByte]` bit `reqBit` set AND maximal `flag[flagByte+1]` priority. The priority is set per
 * tick by `LAB_000132e2` phase B, the mask by the worker on entering. `flagByte` 0x42 selects stock
 * slot 0, 0x44 slot 1.
 */
function findDemandingBuilding(
  state: GameState,
  f: Flag,
  reqBit: number,
  flagByte: number,
): { flag: Flag; slot: number } | null {
  const slot = flagByte === 0x42 ? 0 : 1;
  let best: Flag | null = null;
  let bestPrio = 0; // vreg5 starts at 0, so priority must exceed it: phase B writes 0 for no demand
  const consider = (fl: Flag): void => {
    const mask = slot === 0 ? fl.bldFlags : fl.bld2Flags;
    if (((mask >> reqBit) & 1) === 0) return;
    const prio = fl.stockPriority[slot];
    if (bestPrio < prio) {
      bestPrio = prio;
      best = fl;
    }
  };
  const visited = new Set<number>([f.index]);
  let frontier: number[] = [f.index];
  consider(f);
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const fIdx of frontier) {
      const fl = state.flags[fIdx];
      if (!fl) continue;
      for (let dir = 5; dir >= 0; dir--) {
        const nb = servedNeighborFlag(fl, dir);
        if (nb < 0 || visited.has(nb)) continue;
        const nbFlag = state.flags[nb];
        if (!nbFlag) continue;
        visited.add(nb);
        next.push(nb);
        consider(nbFlag);
      }
    }
    frontier = next;
  }
  return best ? { flag: best, slot } : null;
}

/**
 * `schedule_slot_to_unknown_dest` (@0x4b858, sVar4 == 0 branch). Routable resources first try the
 * building demand BFS and, on a hit, route the resource straight to the demanding building. Otherwise
 * the nearest inventory; with none reachable, or when already at the destination, the back-and-forth
 * branch `LAB_0004bc44`.
 */
function scheduleUnknownDest(
  state: GameState,
  f: Flag,
  slot: number,
  seedDirWord: number,
): void {
  const res = f.resourceSlots[slot];
  const demand = res >= 0 && res < DEMAND_TABLE.length ? DEMAND_TABLE[res] : null;
  // The starting direction of the back-and-forth branch is a LEFTOVER of `vreg2` in both cases, but
  // a different one, because the two paths run different distances through the routine:
  //
  // - not routable (`jns 0x4bba2` falls through, `call 0x44a52` @0x4bb46): nothing writes `vreg2`
  //   between the res_waiting loop (@0x4b9a1) and the branch — checked across all of
  //   `[0x4b9f9,0x4bb4b)` — and `0x44a52` saves `vreg2` itself (@0x44a60). So the seed is
  //   `slotDir[0]` as a word.
  // - routable (`call 0x44a52` @0x4c170): the demand BFS overwrites `vreg2` per visited flag with
  //   `flag[5]` (@0x4bd69) and doubles it seven times (@0x4bd6f, @0x4bd75 and the five direction
  //   blocks up to @0x4bfdc; each `jns` jumps to the NEXT doubling, so the chain always completes).
  //   The byte is then `(flag[5] << 7) & 0xff`, whose low three bits are 0 — and only those are read
  //   by `andw $0x7`. The seed is 0 regardless of how the search went.
  const seed = demand !== null ? 0 : seedDirWord;
  if (demand !== null) {
    // routable: find the demanding building with the highest priority (direct delivery)
    const hit = findDemandingBuilding(state, f, demand.reqBit, demand.flagByte);
    if (hit !== null) {
      const destFlag = hit.flag;
      // Consume the priority (`LAB_0004c0a4`): `prio >> 1`, but 0 when bit 0 was clear. Phase B sets
      // the priority with bit 0 cleared, so after routing the slot priority drops to 0 — one resource
      // per priority tick, until `LAB_000132e2` sets it again next tick.
      const oldPrio = destFlag.stockPriority[hit.slot];
      destFlag.stockPriority[hit.slot] = (oldPrio & 1) !== 0 ? oldPrio >> 1 : 0;
      // add_requested_resource: raise the `requested` nibble of the target stock, which is what
      // prevents over-delivery.
      const destBld = flagBuilding(state, destFlag);
      if (destBld) {
        const st = destBld.stock[hit.slot];
        if (st)
          destBld.stock[hit.slot] = {
            available: st.available,
            requested: (st.requested + 1) & 0xff,
          };
      }
      f.slotDest[slot] = destFlag.index;
      f.hasResources = true;
      return;
    }
  }
  const r = findNearestResourceInventory(state, f);
  if (r < 0) {
    // `js 0x4bc2b` @0x4bb4b leads to LAB_0004bc44. The search returns -1 when this flag ACCEPTS the
    // resource itself (@0x44a93) or when no accepting network is reachable. The original then sends
    // the resource one road segment out WITHOUT a destination; it comes back, and only then does the
    // search find a target, because the starting flag is no longer its own. The observed trip
    // "resource walks to the neighbour and back into the castle" is this, and it is original
    // behaviour rather than a port defect.
    moveBackForth(f, slot, seed);
  } else {
    f.slotDest[slot] = r;
    f.hasResources = true;
  }
}

/**
 * `LAB_0004bc44` — one segment out and back. No destination is set; the resource only gets a pickup
 * direction so it leaves the flag at all.
 *
 * The direction choice is NOT "the highest": the original normalises the seed (@0x4bc6c `andw $0x7`,
 * then `if (v > 5) { v -= 6; if (v != 0) v += 2; }`) and counts DOWN with wrap 0 -> 5 until it hits a
 * direction that has a carrier (@0x4bc84..@0x4bca5). Where the seed comes from is documented at the
 * caller: it is a leftover of a virtual register in both cases, and that is the template, not
 * sloppiness of the port.
 *
 * Reachable seeds: 0 (routable), 0..5 (not routable, slot 0 scheduled) and `0xffff & 7 == 7 -> 3`
 * (not routable, slot 0 empty). 6 is unreachable because a direction is at most 5 — the `v == 6`
 * arm of the normalisation is kept anyway because the original has it.
 */
function moveBackForth(f: Flag, slot: number, seedDirWord: number): void {
  const tr = transporterMask(f);
  if (tr === 0) {
    // @0x4bc53: no direction has a carrier, so `flag[4] |= 0x80` and on to the carrier request
    f.hasResources = true;
    return;
  }
  let dir = seedDirWord & 7; // @0x4bc6c
  if (dir > 5) {
    dir -= 6;
    if (dir !== 0) dir += 2;
  }
  while ((tr & (1 << dir)) === 0) {
    // @0x4bc94 `subw $0x1` + `jae`: downwards, and 0 wraps to 5 (@0x4bc9b)
    dir = dir === 0 ? 5 : dir - 1;
  }
  if (!f.scheduled[dir]) {
    f.scheduled[dir] = true;
    f.scheduledSlot[dir] = slot;
  }
  f.slotDir[slot] = dir;
}

/**
 * `find_nearest_inventory_for_resource` (`FUN_00044a52`): network BFS to the nearest flag that
 * accepts resources (`flag[0x44]` bit 7). Returns -1 when the starting flag accepts them itself,
 * which means "already at the destination" and leads to the back-and-forth branch.
 */
export function findNearestResourceInventory(state: GameState, f: Flag): number {
  if (f.acceptsResources) return -1; // start already accepts: at the destination
  const visited = new Set<number>([f.index]);
  let frontier: number[] = [f.index];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const fIdx of frontier) {
      const fl = state.flags[fIdx];
      if (!fl) continue;
      for (let dir = 5; dir >= 0; dir--) {
        const nb = servedNeighborFlag(fl, dir);
        if (nb < 0 || visited.has(nb)) continue;
        const nbFlag = state.flags[nb];
        if (!nbFlag) continue;
        if (nbFlag.acceptsResources) return nb;
        visited.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return -1;
}

/**
 * The target building had booked the resource but is no longer reachable, so give the booking back:
 * `call 0x4a3af` @0x4c669, immediately before `slot_dest = 0` (@0x4c68b) and `flag[4] |= 0x80`
 * (@0x4c698).
 *
 * It is the **second** entry point of the cancel routine — the return part WITHOUT the gold branch:
 * the resource is not destroyed here, it merely loses its destination and is rescheduled, so no gold
 * may leave the world.
 *
 * Without this the destination keeps a phantom `requested` nibble forever, and because the demand
 * tail goes silent as soon as `available + requested == stockMaximum`, a construction site whose
 * material became briefly unreachable never asks again and stalls for good.
 *
 * `res` is the decoded slot type; the routine wants the raw byte, hence `+ 1`.
 */
function cancelTransportedResource(state: GameState, res: number, dest: number): void {
  if (res < 0) return;
  returnTransitResourceToStock(state, res + 1, dest);
}

// ===========================================================================================
// Carrier request (`call_transporter`) + inventory serf dispatch
//
// Ports `FUN_0004c7c4` (trigger per road) + `FUN_00011a1a` (BFS to the inventory) + `FUN_00011e24`
// (eject tail: serf -> state 15 ReadyToLeaveInventory).
// - Demand table `DAT_0004a188 = [1,2,3,4,6,8,11,15]` (carriers per road length category).
// - Eject sets `field_0xb` = road direction, `field_0xc` = target flag, `state` = 0xf, raises the
//   out-dispatch counter `inv+0x4a`, and marks `length[dir]` bit 7 on BOTH ends as a rate limit
//   against re-requesting.
// - Generic specialisation: type becomes Transporter, `serfIndices[Generic]` is cleared,
//   `genericCount` drops, and the player census moves one serf between the two types.
//
// Deliberately not modelled: sustained dispatch needs the idle-serf registration chain. Dispatched
// is the representative registered in `serfIndices[type]`; after the eject that slot is 0, and the
// original refills it when the next serf becomes IdleInStock. Until that chain is ported, each
// inventory yields at most one carrier.
// ===========================================================================================

/** Carriers needed per road length category (`DAT_0004a188` @0x4a188). Index = (len >> 4) & 7. */
const SERF_COUNT_PER_CATEGORY = [1, 2, 3, 4, 6, 8, 11, 15];
const ST_TRANSPORTER = 0;
/** Sailor — a water road is served by this type, not by a walking transporter. */
const ST_SAILOR = 1;
const ST_GENERIC = 21;
/** Resource Boat — `inventory.resources[8]`, `inv+0x16` (6 + 2·8) in the original. */
const RES_BOAT = 8;

/**
 * `call_transporter` trigger (`FUN_0004c7c4`, @0x4c7c4..@0x4c95a): checks per road direction 5 -> 0
 * whether a carrier is missing and starts the inventory search — and maintains flag byte 5 (the
 * transporter mask plus `serfRequestFail`), which in the original is an accumulator of this routine.
 *
 * ```
 * acc    = flag[5]                                              # @0x4c7ef
 * demand = gs[0x219]                                            # directions with >= 3 waiting slots
 * paths  = flag[3] & 0x3f ; if (gs[0x24e] >= 7) paths |= 0x80    # @0x4c810
 * for dir = 5..0:
 *   if !(paths & (1<<dir)): continue
 *   len = flag[6+dir]
 *   if   (len & 0x80)        -> demand? CLEAR : SET_IF_CARRIER   # @0x4c84e/@0x4c906
 *   elif (len & 0xf) == 0    -> REQUEST                          # @0x4c860
 *   elif !demand             -> SET                              # @0x4c870
 *   elif need == count       -> CLEAR                            # @0x4c8ba
 *   else                     -> REQUEST
 *   REQUEST: if (acc & 0x80) -> CLEAR
 *            ok = (flag[4] & (1<<dir)) ? call_transporter : call_sailor   # @0x4c8d7
 *            if (!ok) acc |= 0x80 ; -> CLEAR
 *   CLEAR:          if (paths & 0x80) acc &= ~(1<<dir)  # only with >= 7 occupied slots, @0x4c916
 *   SET_IF_CARRIER: if (len & 0xf) acc |= 1<<dir                 # @0x4c92c
 *   SET:            acc |= 1<<dir                                # @0x4c932
 * flag[5] = acc                                                  # @0x4c94f
 * ```
 *
 * Two things that read wrong at first glance: the demand test is `need != count`, not `count < need`
 * (@0x4c8ba `cmp/je`), and a direction with an open request (`len` bit 7) is not skipped — it falls
 * into the byte-5 branch.
 *
 * The `acc & 0x80` lock branch exists in the original but is practically dead: across 56 states
 * `serfRequestFail` is set on 0 of 5433 flags. It is reproduced anyway because the code has it.
 *
 * The land/water switch hangs on `flag[4]` bit dir: set = land road, so a transporter; clear = water
 * road, so a SAILOR. Applying the land branch to both makes a serf walk across the lake.
 */
function requestTransporters(
  state: GameState,
  f: Flag,
  demand: number,
  waitingCount: number,
): void {
  let acc = f.serfRequestFail ? 0x80 : 0;
  for (let d = 0; d < 6; d++) if (f.transporters[d]) acc |= 1 << d;
  const congested = waitingCount >= 7; // `paths` bit 7 of the original

  for (let dir = 5; dir >= 0; dir--) {
    if (!f.paths[dir]) continue;
    const len = f.length[dir];
    const count = len & 0x0f; // carriers on the road
    const demanded = (demand & (1 << dir)) !== 0;

    let request = false;
    let setBit = false; // SET
    let setBitIfCarrier = false; // SET_IF_CARRIER

    if ((len & 0x80) !== 0) {
      if (!demanded) setBitIfCarrier = true; // else CLEAR
    } else if (count === 0) {
      request = true;
    } else if (!demanded) {
      setBit = true;
    } else if (SERF_COUNT_PER_CATEGORY[(len >> 4) & 7] !== count) {
      request = true;
    }

    if (request && (acc & 0x80) === 0) {
      // Land (`FUN_00011a1a`) vs water (`FUN_00011a81`), switched by `bt %cx,%ax` @0x4c8d7 on
      // `flag[4]` bit dir: set = land road (transporter), clear = water road (sailor). The road
      // builder is the counterpart, clearing the bit for a water road on commit.
      if (!callTransporter(state, f, dir, !f.endpointDirs[dir])) acc |= 0x80;
    }
    if (setBit) acc |= 1 << dir;
    else if (setBitIfCarrier) {
      if (count !== 0) acc |= 1 << dir;
    } else if (congested) acc &= ~(1 << dir); // CLEAR branch
  }

  for (let d = 0; d < 6; d++) f.transporters[d] = (acc & (1 << d)) !== 0;
  f.serfRequestFail = (acc & 0x80) !== 0;
}

/** Inventory of an inventory flag (`has_inventory` = bldFlags bit 6), or null. */
export function flagInventory(state: GameState, f: Flag): Inventory | null {
  if ((f.bldFlags & 0x40) === 0) return null;
  const b = flagBuilding(state, f);
  if (!b || b.inventoryIndex === null || b.inventoryIndex === undefined) return null;
  return state.inventories[b.inventoryIndex] ?? null;
}

/**
 * Can the inventory supply a carrier — either a stored specialist or a generic to specialise?
 *
 * `water` selects the two branches that hang on `vreg4` (@0x11ac1 vs @0x11a75): the land branch reads
 * `serfIndices[0]` (transporter), the water branch `serfIndices[1]` (sailor) and additionally
 * requires a BOAT in stock for the generic fallback. A stored sailor brings his own boat; only the
 * specialisation consumes one.
 */
function inventoryCanSupplyTransporter(state: GameState, inv: Inventory, water: boolean): boolean {
  const t = inv.serfIndices[water ? ST_SAILOR : ST_TRANSPORTER];
  if (t !== 0 && state.serfs[t]?.state === 1) return true;
  if (water && (inv.resources[RES_BOAT] ?? 0) === 0) return false;
  const g = inv.serfIndices[ST_GENERIC];
  return g !== 0 && inv.genericCount > 0 && state.serfs[g]?.state === 1;
}

/**
 * Core of `FUN_00011a1a`: BFS from `f` (directions 5 -> 0) to the nearest inventory flag that can
 * supply a carrier, dispatches him towards `f`/`dir` and marks the road as requested on both ends.
 * Returns success — in the original the sign of the return value, which the caller tests with `js`
 * and turns into `serfRequestFail`.
 *
 * `water` is the ONLY difference between the two original entry points. `0x11a1a` and `0x11a81` are
 * the same routine: the first 0x67 bytes are a byte-identical register frame, and just before it one
 * sets `vreg4 = 0` (@0x11a75) and the other `vreg4 = -1` (@0x11ad8), after which both jump to the
 * same body @0x11ae4. Hence a parameter rather than a second function.
 */
function callTransporter(state: GameState, f: Flag, dir: number, water: boolean): boolean {
  const inv = findInventoryForTransporter(state, f, water);
  if (inv === null) return false;
  if (!dispatchTransporter(state, inv, f, dir, water)) return false;
  markSerfRequested(state, f, dir);
  return true;
}

/** BFS from `f` (5 -> 0) to the first reachable inventory that can supply a carrier. */
function findInventoryForTransporter(state: GameState, f: Flag, water: boolean): Inventory | null {
  const check = (fl: Flag): Inventory | null => {
    const inv = flagInventory(state, fl);
    return inv && inventoryCanSupplyTransporter(state, inv, water) ? inv : null;
  };
  const hit0 = check(f);
  if (hit0) return hit0;
  const visited = new Set<number>([f.index]);
  let frontier: number[] = [f.index];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const fIdx of frontier) {
      const fl = state.flags[fIdx];
      if (!fl) continue;
      for (let dir = 5; dir >= 0; dir--) {
        const nb = landNeighborFlag(fl, dir);
        if (nb < 0 || visited.has(nb)) continue;
        const nbFlag = state.flags[nb];
        if (!nbFlag) continue;
        const hit = check(nbFlag);
        if (hit) return hit;
        visited.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * `FUN_00011e24` eject: sends a carrier out of `inv` (state 15 ReadyToLeaveInventory) towards
 * `roadFlag`/`dir`. Prefers a stored specialist, otherwise specialises a generic.
 *
 * The water branch (`LAB_000121af`, `vreg4 < 0`) differs from the land branch in exactly three
 * bookings: it raises `serfCount[1]` instead of `serfCount[0]`, it subtracts a BOAT, and it sets the
 * type bits to 1 instead of 0. Everything else, including the generic decrement, is shared.
 */
function dispatchTransporter(
  state: GameState,
  inv: Inventory,
  roadFlag: Flag,
  dir: number,
  water: boolean,
): boolean {
  const workerType = water ? ST_SAILOR : ST_TRANSPORTER;
  let serf: Serf | null = null;
  const t = inv.serfIndices[workerType];
  if (t !== 0 && state.serfs[t]?.state === 1) {
    serf = state.serfs[t];
    inv.serfIndices[workerType] = 0;
  } else {
    const g = inv.serfIndices[ST_GENERIC];
    if (g === 0 || inv.genericCount <= 0 || state.serfs[g]?.state !== 1) return false;
    if (water && (inv.resources[RES_BOAT] ?? 0) === 0) return false;
    serf = state.serfs[g];
    inv.serfIndices[ST_GENERIC] = 0;
    inv.genericCount -= 1;
    if (water) inv.resources[RES_BOAT] -= 1; // the new sailor's boat
    setSerfType(serf, workerType);
    const player = inv.owner >= 0 ? state.players[inv.owner] : null;
    if (player) {
      const sc = player.serfCount as number[]; // Player is shallow-readonly; the cells are writable
      sc[ST_GENERIC] = Math.max(0, sc[ST_GENERIC] - 1);
      sc[workerType] = (sc[workerType] + 1) & 0xffff;
    }
  }
  if (!serf) return false;
  setUnionU8(serf, 0xb, dir); // field_0xb = road direction (0..5)
  setUnionU16(serf, 0xc, roadFlag.index); // field_0xc = target flag
  setUnionU16(serf, 0xe, inv.index); // field_0xe = inventory; state 15 decrements it. Survives from
  // IdleInStock anyway, set defensively.
  serf.state = 15; // ReadyToLeaveInventory
  inv.serfIndices[4] = (inv.serfIndices[4] + 1) & 0xffff; // out-dispatch counter (inv+0x4a)
  return true;
}

/** Set `length[dir]` bit 7 (serf_requested) on BOTH road ends, which blocks re-requesting. */
function markSerfRequested(state: GameState, f: Flag, dir: number): void {
  f.length[dir] = (f.length[dir] | 0x80) & 0xff;
  const nb = neighborFlag(f, dir);
  if (nb < 0) return;
  const other = state.flags[nb];
  if (!other) return;
  const od = f.otherEndDir[dir];
  if (od >= 0 && od < 6) other.length[od] = (other.length[od] | 0x80) & 0xff;
}
