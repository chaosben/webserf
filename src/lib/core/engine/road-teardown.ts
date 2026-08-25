/**
 * Tearing down the road and flag network — port of @0x4a528 / @0x4a90f / @0x4a9e8 (clearing the map
 * path bits) plus @0x4980e (demolishing a flag).
 *
 * Two operations, both idempotent, because the owner recolour may call them many times over:
 * - {@link clearRoadPaths}: walk the (at most two) roads leaving a tile TILE BY TILE, clearing the
 *   `paths` bits up to the far flag, and tidy that flag's record bits for the reverse direction.
 * - {@link demolishFlag}: remove a flag completely — clear its roads, cancel serf destinations, return
 *   resources, clear the map object and free the flag slot.
 */
import { Direction, oppositeDir, neighbor, posOf } from './position.js';
// Runtime cycle with `road-building.ts`, which takes `isRoadSegmentClearable`/`lengthToCategory` from
// here: the two call each other only at runtime, mirroring the mutual `call`s of the original.
import { cancelRoadBuilding } from './road-building.js';
import { hasInventoryMarker } from './building-tables.js';
import { i8 } from './int.js';
import type { GameState, Flag, Serf } from './state.js';

/** @0x4a188: transporters per road length category 0..7. */
export const CARRIERS_PER_CATEGORY = [1, 2, 3, 4, 6, 8, 11, 15] as const;

/**
 * @0x2bbc1 — road length in steps to a length CATEGORY IN THE HIGH NIBBLE (`0x00`/`0x10`/.../`0x70`).
 * The category indexes {@link CARRIERS_PER_CATEGORY} and is the high nibble of the flag's `length[dir]`
 * byte; the low nibble holds the transporter count.
 */
export function lengthToCategory(steps: number): number {
  if (steps > 0x17) return 0x70;
  if (steps > 0x11) return 0x60;
  if (steps > 0x0c) return 0x50;
  if (steps < 10) {
    if (steps > 6) return 0x30;
    if (steps < 6) return steps < 4 ? 0x00 : 0x10;
    return 0x20; // steps == 6
  }
  return 0x40; // 10..12
}

/**
 * @0x4a478, 27 entries: resource type 0..26 to WHICH OF THE TWO STOCK SLOTS of the destination building
 * is returned (0 = `bld+8`, 1 = `bld+9`); `-1` means do not decrement at all.
 *
 * The table picks the SLOT, not a counter: `bld+8` and `bld+9` are each a nibble pair (high =
 * available, low = requested), and the original decrements the same byte end in both cases
 * (`subb $0x1` @0x4a456 / @0x4a45f). See {@link cancelTransitResource}.
 */
export const RES_STOCK_CATEGORY = [
  -1, 0, 0, 0, 0, 0, 0, 1, 0, -1, 1, 1, 1, 0, 1, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
] as const;

/**
 * @0x4a398 — cancel a resource in transit. Two parts:
 *
 * 1. GOLD VANISHES FROM THE WORLD (@0x4a39c/@0x4a3a2): for gold ore (14) or a gold bar (15),
 *    `mapGoldTotal` counts down by one — unconditionally, before any destination check. That is not
 *    bookkeeping trivia: the value is the denominator of knight morale, so a cancelled gold delivery
 *    RAISES the morale value of every remaining bar.
 * 2. Return it at the destination building (flag `dest`, endpoint towards UpLeft): decrement the stock
 *    slot chosen by {@link RES_STOCK_CATEGORY} — except for warehouse(10) and castle(24), which keep no
 *    stock nibbles.
 *
 * `resType` is the raw resource byte; its low five bits index the table.
 *
 * The decrement runs on the WHOLE byte (`subb $0x1` @0x4a456/@0x4a45f), i.e. on the low nibble, with a
 * borrow from the high nibble when `requested == 0` — see {@link decrementStockByte}. It does not clamp
 * at 0, and neither does the original.
 */
export function cancelTransitResource(state: GameState, resType: number, destFlagIdx: number): void {
  const res = resType & 0x1f;
 // Part 1, the gold branch. It runs before everything else and regardless of whether there is a target.
  if (res === 14 || res === 15) state.header.mapGoldTotal = (state.header.mapGoldTotal - 1) >>> 0;
  returnTransitResourceToStock(state, resType, destFlagIdx);
}

/**
 * @0x4a3af — the SECOND ENTRY POINT of the same routine: the return part only, without the gold branch.
 * Not a device of the port but an address the original jumps to itself: `call 0x4a3af` appears at two
 * places (state 52 @0x16ef0 and @0x4c669), while the seven other callers use `call 0x4a398`.
 *
 * The difference is substantive: whoever enters here takes NO gold out of the world. On a capture the
 * resource merely changes owner and stays on the flag; it is not destroyed.
 */
export function returnTransitResourceToStock(
  state: GameState,
  resType: number,
  destFlagIdx: number,
): void {
  const res = resType & 0x1f;
  const cat = RES_STOCK_CATEGORY[res];
  if (cat == null || cat < 0) return;
  if (destFlagIdx === 0) return;
  const destFlag = state.flags[destFlagIdx];
  if (!destFlag || !destFlag.hasBuilding) return;
  const conn = destFlag.connections[Direction.UpLeft];
  if (!conn || conn.kind !== 'building') return;
  const bld = state.buildings[conn.index];
  if (!bld || bld.type === 10 || bld.type === 24) return; // warehouse/castle keep no stock nibbles
  const slot = bld.stock[cat];
  if (slot) decrementStockByte(slot);
}

/**
 * Return the reservation a walking serf holds — the shared body of `set_lost_state` (@0x4af98) and
 * `arrival_cleanup` (@0x207ba).
 *
 * The block stands TWICE in the binary. That it is the same computation is measured, not asserted: an
 * instruction diff over both copies (mnemonic plus operands, jump targets blanked, the serf pointer slot
 * `0x30(%edi)` normalised against `0x24(%edi)`) is identical across the FIRST 98 INSTRUCTIONS, up to and
 * including the `jmp` to the tail (`0x208ff` against `0x4b0dd`). Only after that do the two callers
 * diverge — which is exactly what the return value expresses.
 *
 * `field_0xb` (`dir1`) says what was reserved:
 * - `<= -2` (`addb $0x1` + `js`, @0x4afae / @0x207d0): nothing to return — the serf was already on his
 *   way home (`-2` means "to the nearest stock"). Returns `'lost'`; the CALLER decides which
 *   `field_0xb` he enters state 25 with.
 * - `-1`: the target is the BUILDING at the destination flag (`flag+0x34`, the UpLeft connection).
 *   Clear `bld+5` bit 7 there, and decrement `bld+8` ONLY IF that bit was clear before (`setb` on the
 *   old value, @0x4b00b / @0x2082d).
 * - `0..5` other than `6`: the target is a ROAD at the flag, so clear the `serf_requested` bit of the
 *   length byte at BOTH ends (`flag[6+d]` and, via `otherEndDir`, the far flag's `[6+d2]`).
 * - `6` (geologist): nothing.
 */
export function cancelWalkingRequest(state: GameState, serf: Serf): 'lost' | 'done' {
  const dest = serf.stateData[1] | (serf.stateData[2] << 8); // field_0xc (u16)
  const d = i8(serf.stateData[0]);
  if (d < -1) return 'lost';
  if (d === -1) {
    const flag = state.flags[dest];
    const conn = flag?.connections[Direction.UpLeft];
    const bld = conn?.kind === 'building' ? state.buildings[conn.index] : null;
    if (bld) {
      const wasRequested = bld.serfRequested;
      bld.serfRequested = false;
      if (!wasRequested && !hasInventoryMarker(bld)) decrementStockByte(bld.stock[0]);
    }
  } else if (d !== 6) {
    const flag = state.flags[dest];
    if (flag) {
      flag.length[d] &= 0x7f;
      const conn = flag.connections[d];
      const other = conn?.kind === 'flag' ? state.flags[conn.index] : null;
      if (other) other.length[flag.otherEndDir[d]] &= 0x7f;
    }
  }
  return 'done';
}

/**
 * @0x4af66 — make a serf lose his errand: he becomes `Lost` (25) or `LostSailor` (26), and everything
 * reserved for him is returned.
 *
 * Two branches, strictly by state:
 *
 * (a) State 2 (Walking) — the serf was heading for an errand nobody expects any more:
 *     {@link cancelWalkingRequest}. Its `<= -2` exit leads to the SAME tail as everything else here
 *     (`jmp 0x4b11b`: state 25, `field_0xb = 0`), unlike in `arrival_cleanup`, where it has its own tail
 *     with `field_0xb = 1`.
 *
 * (b) All other states (here 3 Transporting / 14 Delivering): if he carries a resource
 *     (`field_0xb != 0`) it is cancelled at the destination building; a SAILOR (type 1) ends as 26 and
 *     KEEPS `field_0xb`.
 */
export function setLostState(state: GameState, serf: Serf): void {
  const dest = serf.stateData[1] | (serf.stateData[2] << 8); // field_0xc (u16)
  if (serf.state === 2) {
    cancelWalkingRequest(state, serf);
  } else {
    if (serf.stateData[0] !== 0) cancelTransitResource(state, serf.stateData[0], dest);
    if (serf.type === 1) {
      serf.state = 26; // LostSailor — `field_0xb` stays (@0x4b0f6)
      return;
    }
  }
  serf.state = 25; // Lost
  serf.stateData[0] = 0;
}

/*
 * The guard before the decrement — `cmpb $0xff,0x8(bld)` @0x4b014 (and @0x20836) — is
 * {@link hasInventoryMarker}, and it reads the REAL byte.
 *
 * A castle can carry `0xfe` there, which is NOT a marker, so it does get decremented. That value comes
 * from @0x1c914 `subb $0x1,0x8(%ebx)`, the deregistration of a passing engaged knight
 * (`decrementWalkingKnightGarrison`). That place is ungated: the original checks no marker there and so
 * destroys it on a castle itself.
 */

/**
 * `dec byte ptr [bld+8]` on the PACKED nibble pair: normally one requested resource less. At
 * `requested == 0` the byte borrows from the high nibble (`available`) — the original does not clamp,
 * it is plain byte arithmetic, so the port reproduces it.
 */
function decrementStockByte(slot: { available: number; requested: number }): void {
  const b = (((slot.available & 0xf) << 4) | (slot.requested & 0xf)) - 1;
  slot.available = (b >> 4) & 0xf;
  slot.requested = b & 0xf;
}

/**
 * @0x4b604 — wake the idle transporter on this tile TO THE FLAG: the first live serf on `pos` whose
 * state is one of {66, 67, 69} becomes 68 (WakeAtFlag); one already in 68 stays. Serfs in other states
 * do not count as a hit and the search continues — that is the difference to {@link wakeCarrierOnPath},
 * which wakes to 69.
 *
 * Callers first test the idle-serf marker of the game layer (byte 1, bit 7) as a shortcut; our tile
 * model does not keep that cache, and scanning the serfs is equivalent.
 */
export function wakeCarrierAtFlag(state: GameState, pos: number): void {
  for (const serf of state.serfs) {
    if (!serf || serf.col === null || serf.row === null) continue;
    if (posOf(serf.col, serf.row, state.geo) !== pos) continue;
    if (serf.state === 68) return;
    if (serf.state === 66 || serf.state === 67 || serf.state === 69) {
      serf.state = 68;
      return;
    }
  }
}

/**
 * The two serf blocks that `walk_road_clear`/`road_endpoint_cleanup` run on EVERY tile of the removed
 * road (@0x4a971..@0x4a9e3 and the same sequence in the loop body from @0x4aa5b):
 *
 * 1. wake the idle transporter ({@link wakeCarrierAtFlag}),
 * 2. make an ACTIVE transporter lose his errand (state 3 Transporting / 2 Walking, at the flag also 14
 *    Delivering) via {@link setLostState}.
 *
 * `guardDir` is the direction comparison against `field_0xe`: at the ENDS (start tile and far flag) only
 * the transporter of THIS road may be caught, because other roads meet there. On the tiles in between
 * there is no other road, and the original does not check (`null`).
 *
 * `wake` is off at the far flag: the loop breaks before the wake block (@0x4aa9b `js`), and the endpoint
 * block only runs the transporter part. Start tile and intermediate tiles do wake.
 */
function loseCarriersOnTile(
  state: GameState,
  pos: number,
  guardDir: Direction | null,
  allowDelivering: boolean,
  wake: boolean,
): void {
  const tile = state.mapTiles[pos];
  if (wake) wakeCarrierAtFlag(state, pos);
  if (tile.serfIndex === 0) return;
  const serf = state.serfs[tile.serfIndex];
  if (!serf) return;
  const active = serf.state === 3 || serf.state === 2 || (allowDelivering && serf.state === 14);
  if (!active) return;
  if (guardDir !== null) {
    let cd = i8(serf.stateData[3]); // field_0xe, walking direction
    if (cd < 0) cd += 6;
    if (cd !== guardDir) return;
  }
  setLostState(state, serf);
}

/**
 * Cleanup bits at the far endpoint of a road just removed (@0x4a9e8, endpoint block): the flag at
 * `flagPos` loses its connection in direction `backDir`, the reverse of the road's course.
 *
 * The `serf_requested` branch is the second transporter case of a teardown: if a transporter had just
 * been REQUESTED for this road (bit 7 of the length byte), he is still on his way and knows nothing of
 * it. The original searches the whole serf table for him and CLEARS HIS TARGET (`field_0xb = 0xfe`,
 * `field_0xc = 0`) — the same "target gone" marking as on a flag demolition. He walks on to the next
 * flag and decides anew there.
 */
function endpointCleanup(state: GameState, flagPos: number, backDir: Direction): void {
  const tile = state.mapTiles[flagPos];
  const flagIdx = tile.objIndex;
  const flag = state.flags[flagIdx];
  if (!flag) return;
  flag.paths[backDir] = false; // flag+3 &= ~(1<<d)
 // The original leaves `flag+0x24+d*4` standing — without the `paths` bit nobody reads it any more. We
 // null the pointer anyway, so no reference to a removed flag survives in the model.
  flag.connections[backDir] = null;
  flag.transporters[backDir] = false; // flag+5 &= ~(1<<d)
  flag.endpointDirs[backDir] = false; // flag+4 &= ~(1<<d)
  const lengthByte = flag.length[backDir];
  flag.length[backDir] = lengthByte & 0x7f; // clear the `serf_requested` bit
  if ((lengthByte & 0x80) !== 0) cancelRequestedCarrier(state, flagIdx, backDir);
 // `flag+0x3c+d &= 0x78` — bits 3..6 stay (`otherEndDir` plus the unused bit 6); cleared are the
 // SCHEDULING (bit 7) and its slot (bits 0..2), so the scheduler can no longer find a pickup across the
 // removed road.
  flag.scheduled[backDir] = false;
  flag.scheduledSlot[backDir] = 0;
 // Release the resource slots with `slotDir == backDir`.
  for (let i = 0; i < flag.slotDir.length; i++) {
    if (flag.slotDir[i] === backDir) {
      flag.slotDir[i] = -1;
      flag.hasResources = true;
    }
  }
}

/**
 * The full serf scan from the `serf_requested` branch of {@link endpointCleanup} (@0x4aacf ff.): the
 * transporter requested for THIS road is still on his way, so his target is cleared.
 *
 * He is recognised by TWO fields — `field_0xc` == this flag AND `field_0xb` == the direction of the
 * removed road — plus a state filter (2 Walking, 1 IdleInStock, 15 ReadyToLeaveInventory, and 5/7 with
 * exit reason `field_0xf == 2`), i.e. exactly the stations between "requested" and "arrived on the
 * road".
 *
 * `field_0xb = 0xfe` is the target-gone marking (the same as in {@link cancelSerfsToFlag}): the walking
 * handler sees it at the next flag and decides anew there, instead of walking into a target that no
 * longer exists.
 */
function cancelRequestedCarrier(state: GameState, flagIdx: number, dir: Direction): void {
  for (const serf of state.serfs) {
    if (!serf) continue;
    const dest = serf.stateData[1] | (serf.stateData[2] << 8); // field_0xc
    if (dest !== flagIdx) continue;
    if (i8(serf.stateData[0]) !== dir) continue; // field_0xb
    const st = serf.state;
    const match =
      st === 1 || st === 2 || st === 0xf || ((st === 5 || st === 7) && serf.stateData[4] === 2);
    if (!match) continue;
    serf.stateData[0] = 0xfe;
    serf.stateData[1] = 0;
    serf.stateData[2] = 0;
  }
}

/**
 * Walk a road from `startPos` in direction `dir`, clearing the `paths` bits tile by tile until a flag
 * tile (`object == 1`) is reached, then {@link endpointCleanup}. @0x4a90f plus @0x4a9e8; bends are
 * followed via the one remaining set bit.
 *
 * THE ROAD TAKES ITS TRANSPORTERS WITH IT ({@link loseCarriersOnTile}) — the original clears not only
 * the bits on each tile but the serfs on them: idle ones are woken, walking ones lose their errand.
 * Without that part a transporter would be left standing on a road that no longer exists.
 */
function walkRoad(state: GameState, startPos: number, dir: Direction): void {
  const geo = state.geo;
  let pos = startPos;
  let d = dir;
 // Start tile: direction guard, because two roads meet here and `clearRoadPaths` walks both.
  loseCarriersOnTile(state, startPos, dir, false, true);
  for (let guard = 0; guard < 4096; guard++) {
    state.mapTiles[pos].paths &= ~(1 << d); // clear the outgoing bit of the current tile
    const next = neighbor(pos, d, geo);
    const back = oppositeDir(d);
    state.mapTiles[next].paths &= ~(1 << back); // clear the reverse bit of the tile entered
    if (state.mapTiles[next].object === 1) {
 // Far flag: the guard is the reverse direction, so only someone walking into THIS road; Delivering
 // counts too, and nothing is woken (the original's loop breaks before the wake block).
      loseCarriersOnTile(state, next, back, true, false);
      endpointCleanup(state, next, back);
      return;
    }
 // Follow the bend: on an intermediate tile exactly one path bit remains, the continuation.
    const rem = state.mapTiles[next].paths;
    if (rem === 0) return; // dead end without a flag, which should not occur
    let nd = 0;
    while (nd < 6 && !(rem & (1 << nd))) nd++;
    loseCarriersOnTile(state, next, null, false, true); // intermediate tile: no guard
    pos = next;
    d = nd as Direction;
  }
}

/**
 * The side-effect-free road follower (`road_reaches_flag` @0x2b33b, recursive in the original): take one
 * step from `pos` in `dir`, then follow the road until a FLAG is reached.
 *
 * - Flag reached (`object & 0x7f == 1`) => `true`.
 * - Dead end (no path bit left after clearing the reverse bit) => `false`.
 *
 * It is the read-only twin of {@link walkRoad}: same step geometry, but it does not write the tile and
 * computes on a copy of the path bits.
 *
 * One deliberate divergence: the loop is bounded by the tile count. A road without a flag at both ends
 * is impossible in the original (roads only ever run between flags), and the original would recurse
 * forever on such input; in the browser that would hang rather than crash.
 */
function roadReachesFlag(state: GameState, pos: number, dir: Direction): boolean {
  const geo = state.geo;
  let p = pos;
  let d = dir;
  for (let guard = 0; guard <= geo.tileCount; guard++) {
    p = neighbor(p, d, geo);
    const t = state.mapTiles[p];
    if (t.object === 1) return true; // `cmpb $0x1` on `object & 0x7f`
    const rest = t.paths & 0x3f & ~(1 << oppositeDir(d)); // clear the reverse bit on the COPY
    if (rest === 0) return false;
    let nd = 0;
    while (nd < 6 && !(rest & (1 << nd))) nd++;
    d = nd as Direction;
  }
  return false;
}

/**
 * The gate before clearing (`road_bounded_by_flags` @0x2b203, returning 0 = yes / -1 = no): can the road
 * at this tile be followed to a flag in BOTH directions?
 *
 * - `paths == 0` => no (@0x2b252).
 * - LOWEST set bit `d1` (ascending) and HIGHEST `d2` (descending from 5); `d1 == d2`, i.e. only one path
 *   bit => no (@0x2b29e).
 * - both walks must reach a flag (@0x2b2ac/@0x2b2c3, each `js`).
 *
 * The direction choice differs from the clearing below: highest bit here, the NEXT one from `d1 + 1`
 * there (with the 4-to-5 special case). For the usual two-bit tiles the two coincide.
 */
export function isRoadSegmentClearable(state: GameState, col: number, row: number): boolean {
  const pos = posOf(col, row, state.geo);
  const paths = state.mapTiles[pos].paths & 0x3f;
  if (paths === 0) return false;
  let d1 = 0;
  while (d1 < 6 && !(paths & (1 << d1))) d1++;
  let d2 = 5;
  while (d2 >= 0 && !(paths & (1 << d2))) d2--;
  if (d1 === d2) return false;
  return roadReachesFlag(state, pos, d1 as Direction) && roadReachesFlag(state, pos, d2 as Direction);
}

/**
 * @0x4a528 — clear the (at most two) roads leaving a tile: find the first and the next set path
 * direction and walk each via {@link walkRoad}. The viewport dirty flags of the original are a pure
 * rendering side effect and are left out.
 *
 * The gate `road_bounded_by_flags` ({@link isRoadSegmentClearable}) sits INSIDE here in the original,
 * not at the caller (`call 0x2b203; jns` @0x4a5e6). When it fails the original clears NOTHING and
 * instead cancels the road building session in every viewport that has one (`vp[1]` bit 7, @0x4a5f1
 * ff.). That is what the branch is for: the only situation in which a road does not have a flag at both
 * ends is the road currently being drawn.
 *
 * The ENGINE performs that cancel, not the interface layer — `clearRoadPaths` is also called from the
 * tick (territory recolour, knight capture), and a cancel that only the interface layer performs would
 * be missing when a command log is replayed, so the replayed state would drift.
 * `GameState.roadBuildAborted` stays the signal for the DISPLAY and is only set when a session really
 * ended.
 */
export function clearRoadPaths(state: GameState, col: number, row: number): void {
  if (!isRoadSegmentClearable(state, col, row)) {
 // `jns 0x4a829` -> cancel road building per viewport with `vp[1]` bit 7, @0x4a5f1
    for (const p of state.players) {
      if (p === null || !state.roadBuild[p.slot]?.active) continue;
      cancelRoadBuilding(state, p);
      state.roadBuildAborted = true;
    }
    return;
  }
  const pos = posOf(col, row, state.geo);
  const paths = state.mapTiles[pos].paths;
  if (paths === 0) return;
  let d1 = 0;
  while (d1 < 6 && !(paths & (1 << d1))) d1++;
  let d2 = d1 + 1;
  while (d2 < 6 && !(paths & (1 << d2))) d2++;
  if (d2 === 4 && paths & (1 << 5)) d2 = 5; // special case: skip the building direction 4
  if (d1 < 6) walkRoad(state, pos, d1 as Direction);
  if (d2 < 6) walkRoad(state, pos, d2 as Direction);
}

/**
 * Cancel every serf whose target (`+0xc`) is the flag being demolished and who is in a walking or
 * transporting state: `+0xb = 0xfe`, `+0xc = 0`, so the serf looks for a new target. Full scan, @0x4980e.
 */
function cancelSerfsToFlag(state: GameState, flagIdx: number): void {
  for (const serf of state.serfs) {
    if (!serf) continue;
    const st = serf.state;
    const walkish = st === 1 || st === 2 || st === 0xf;
    const transp = (st === 5 || st === 7) && serf.stateData[4] === 2;
    if (!walkish && !transp) continue;
    const dest = serf.stateData[1] | (serf.stateData[2] << 8); // +0xc as u16
    if (dest !== flagIdx) continue;
    serf.stateData[0] = 0xfe; // +0xb
    serf.stateData[1] = 0; // +0xc low
    serf.stateData[2] = 0; // +0xc high
  }
}

/** Free a flag slot (@0x4502f): null the slot and pull `maxIndex` back if it was the highest one. */
function freeFlagSlot(state: GameState, index: number): void {
  state.flags[index] = null;
  const meta = state.blockMeta.flags;
  if (index + 1 === meta.maxIndex) {
    let m = meta.maxIndex - 1;
    while (m > 0 && state.flags[m - 1] === null) m -= 1;
    meta.maxIndex = m;
  }
}

/** Result of a road trace: step count, transporters on the segment, far flag and reverse direction. */
export interface RoadTrace {
  steps: number;
  carriers: number[];
  farIdx: number;
  farDir: Direction;
}

/**
 * @0x4b14b / @0x4b260 — walk a road from the flag tile `flagPos` in direction `dir` and collect ALL
 * transporters of the segment into ONE list, in walking order (the original builds exactly that list at
 * @0x4a348+8 with the counter at +2):
 * - actively transporting ones (state 3 as long as `field_0xf != -1`; at the far flag also 14
 *   Delivering) — found via `tile.serfIndex`, and given `field_0xf = 0`;
 * - IDLE transporters on a ROAD tile (@0x4b713): they do NOT occupy `tile.serfIndex`, so they are found
 *   by position; state 66/67/69 becomes 69 (WokeOnPath), and they go into the list too.
 *
 * An idle transporter on the START FLAG TILE (@0x4b604) becomes 68 (WakeAtFlag) and does NOT go into the
 * list — he is handled by his own state handler.
 *
 * Direction guards at both flag ends: only ACTIVE transporters whose walking direction `field_0xe`
 * (normalised to 0..5) equals the segment direction, otherwise transporters of other roads would be
 * counted at a junction.
 */
export function traceRoadCarriers(
  state: GameState,
  flagPos: number,
  dir: Direction,
  restingByPos: Map<number, number>,
): RoadTrace {
  const geo = state.geo;
  const carriers: number[] = [];
 // Wake an idle transporter by position and collect him (@0x4b713, road tile -> 69 WokeOnPath).
  const wakeOnPath = (p: number): void => {
    const si = restingByPos.get(p);
    if (si === undefined) return;
    const serf = state.serfs[si];
    if (serf && (serf.state === 66 || serf.state === 67 || serf.state === 69)) {
      serf.state = 69;
      carriers.push(si);
    }
  };
 // Collect an active transporter from `tile.serfIndex` (`field_0xf = 0`, optional direction guard).
  const collectActive = (p: number, guardDir: Direction | null, allowDelivering: boolean): void => {
    const si = state.mapTiles[p].serfIndex;
    if (si <= 0) return;
    const serf = state.serfs[si];
    if (!serf) return;
    let ok = false;
    if (serf.state === 3 && i8(serf.stateData[4]) !== -1) ok = true; // Transporting, not already out
    else if (allowDelivering && serf.state === 14) ok = true; // Delivering at the far end
    if (!ok) return;
    if (guardDir !== null) {
      let cd = i8(serf.stateData[3]); // field_0xe, walking direction
      if (cd < 0) cd += 6;
      if (cd !== guardDir) return;
    }
    serf.stateData[4] = 0; // field_0xf = 0
    carriers.push(si);
  };
 // Start flag tile: an idle transporter becomes 68 (WakeAtFlag) and does NOT enter the list; an active
 // one is collected.
  {
    const si = restingByPos.get(flagPos);
    if (si !== undefined) {
      const serf = state.serfs[si];
      if (serf && (serf.state === 66 || serf.state === 67 || serf.state === 69)) serf.state = 68;
    }
    collectActive(flagPos, dir, false);
  }
  let pos = flagPos;
  let d = dir;
  let steps = 0;
  for (let guard = 0; guard < 4096; guard++) {
    const next = neighbor(pos, d, geo);
    steps += 1;
    const back = oppositeDir(d);
    if (state.mapTiles[next].object === 1) {
      collectActive(next, back, true); // ferne Flaggenkachel (Guard = Gegenrichtung, Delivering erlaubt)
      return { steps, carriers, farIdx: state.mapTiles[next].objIndex, farDir: back };
    }
    wakeOnPath(next); // wake the idle transporter on the intermediate tile (69) and list him
    collectActive(next, null, false); // active transporter on the intermediate tile, no guard
    const rem = state.mapTiles[next].paths & ~(1 << back) & 0x3f;
    if (rem === 0) return { steps, carriers, farIdx: 0, farDir: 0 as Direction };
    let nd = 0;
    while (nd < 6 && !(rem & (1 << nd))) nd++;
    pos = next;
    d = nd as Direction;
  }
  return { steps, carriers, farIdx: 0, farDir: 0 as Direction };
}

/**
 * @0x4b713 — wake an idle transporter on a ROAD tile, as a routine of its own. The
 * {@link traceRoadCarriers} walk has the same step embedded but additionally collects him into its list;
 * here he is only woken.
 *
 * The original scans the serf table in index order and takes the FIRST serf on the tile: state 66/67
 * becomes 69 (WokeOnPath), state 68 aborts without a change, state 69 is done. Other states do not count
 * as a hit and the search continues.
 *
 * The original caller first tests the idle-serf marker of the game layer (byte 1, bit 7) as a shortcut.
 * Our tile model does not keep that cache — it is verified at the byte as exactly equivalent to "a serf
 * in state 66..69 stands here", so the gate is pure acceleration.
 */
export function wakeCarrierOnPath(state: GameState, pos: number): void {
  for (const serf of state.serfs) {
    if (!serf || serf.col === null || serf.row === null) continue;
    if (posOf(serf.col, serf.row, state.geo) !== pos) continue;
    if (serf.state === 66 || serf.state === 67) {
      serf.state = 69;
      return;
    }
    if (serf.state === 68 || serf.state === 69) return;
  }
}

/** Index every idle transporter (state 66/67/69) by map position — they do not occupy `tile.serfIndex`. */
export function indexRestingCarriers(state: GameState): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < state.serfs.length; i++) {
    const s = state.serfs[i];
    if (!s || s.col === null || s.row === null) continue;
    if (s.state === 66 || s.state === 67 || s.state === 69) m.set(posOf(s.col, s.row, state.geo), i);
  }
  return m;
}

/**
 * Retarget the serfs that were aimed at the two MERGED endpoint segments (@0x49dbb): every walking or
 * transporting serf whose target `+0xc` is one of the two far endpoints AND whose direction field `+0xb`
 * is the end direction there gets "look for a new target" (`+0xb = 0xfe`, `+0xc = 0`). This is the actual
 * reordering of the transporters after a merge: they drop their old segment target and re-aim on the new,
 * longer road. Same state filter as {@link cancelSerfsToFlag}.
 */
function retargetSerfsToEndpoints(
  state: GameState,
  fA: number,
  dA: Direction,
  fB: number,
  dB: Direction,
): void {
  for (const serf of state.serfs) {
    if (!serf) continue;
    const st = serf.state;
    const walkish = st === 1 || st === 2 || st === 0xf;
    const transp = (st === 5 || st === 7) && serf.stateData[4] === 2;
    if (!walkish && !transp) continue;
    const dest = serf.stateData[1] | (serf.stateData[2] << 8); // +0xc as u16
    const dir = serf.stateData[0]; // +0xb
    if (!((dest === fA && dir === dA) || (dest === fB && dir === dB))) continue;
    serf.stateData[0] = 0xfe; // +0xb: look for a new target
    serf.stateData[1] = 0; // +0xc low
    serf.stateData[2] = 0; // +0xc high
  }
}

/**
 * Merge the two road segments of a THROUGH FLAG being demolished into one (@0x4980e, merge block). Both
 * segments are walked by {@link traceRoadCarriers}, which measures the length and collects the active
 * transporters; the two far flags are then linked directly to each other (connection, `otherEndDir`,
 * combined length category, transporter bit). The road tiles are KEPT — no path bits are cleared.
 * `dirA`/`dirB` are the first and last path direction of the flag.
 *
 * Combined length: `lengthToCategory(stepsA + stepsB)` in the high nibble; the low nibble is the number of
 * transporters KEPT, `min(existing, required)`, with `required` from {@link CARRIERS_PER_CATEGORY}.
 *
 * Ejecting the surplus (@0x49da0): if the merged road needs FEWER transporters than the trace found, the
 * surplus ones are ejected in order (segment A's list first, then B's) — the two branches of the binary:
 * - ACTIVE (state 3) -> `field_0xf = 0xff` -> at the next flag contact, walking without a target, i.e. the
 *   way back through the road network to the nearest inventory (`find_nearest_inventory`); a carried
 *   resource is returned via {@link cancelTransitResource}. This is the "walks back to the castle" case.
 * - WOKEN IDLE (69) -> 68 (WakeAtFlag) -> next tick: claim the tile, Lost(25), FreeWalking(16). That is
 *   the "road pulled out from under him" case (off-road), NOT the ordinary merge case.
 * Afterwards the serfs are retargeted ({@link retargetSerfsToEndpoints}).
 *
 * On the length byte: the low nibble (transporter count) is DYNAMIC — it grows over the ticks while the
 * road requests new transporters. Only the CATEGORY (high nibble, from the geometry) and the topology are
 * statically verifiable; the exact count depends on the tick, so a value immediately after the demolition
 * must not be compared one-to-one against a state many ticks later.
 *
 * Idle transporters are WOKEN by the tracer — on a road tile to 69 (WokeOnPath, entering the list and the
 * count), on the demolished flag tile itself to 68 (WakeAtFlag, outside the list). An orphan whose home is
 * the demolished flag is thereby woken by position and gets a valid home from his current segment the next
 * time he rests, so no dangling pointer is needed.
 */
function mergeRoads(
  state: GameState,
  flag: Flag,
  flagPos: number,
  dirA: Direction,
  dirB: Direction,
): void {
  const connA = flag.connections[dirA];
  const connB = flag.connections[dirB];
  if (!connA || connA.kind !== 'flag' || !connB || connB.kind !== 'flag') return; // building endpoint: no merge
  const restingByPos = indexRestingCarriers(state);
  const tA = traceRoadCarriers(state, flagPos, dirA, restingByPos);
  const tB = traceRoadCarriers(state, flagPos, dirB, restingByPos);
  const farA = state.flags[tA.farIdx];
  const farB = state.flags[tB.farIdx];
  if (!farA || !farB) return;
  const atA = tA.farDir; // reverse direction at far flag A, pointing back at the through flag
  const atB = tB.farDir;
 // Far flag A now points straight at B and vice versa; `paths[atA]`/`[atB]` stay set, the road remains.
  farA.connections[atA] = { kind: 'flag', index: tB.farIdx };
  farA.otherEndDir[atA] = atB;
  farB.connections[atB] = { kind: 'flag', index: tA.farIdx };
  farB.otherEndDir[atB] = atA;
  const category = lengthToCategory(tA.steps + tB.steps);
 // The transporter count comes from the trace: {@link traceRoadCarriers} collects woken (idle -> 69) AND
 // active (3/14) transporters of both segments into ONE list, exactly the original's counter at
 // @0x4a348+2. Because the idle ones are counted too, the merged road does NOT look transporter-less, so
 // no superfluous transporter is requested.
  const existing = tA.carriers.length + tB.carriers.length;
  const required = CARRIERS_PER_CATEGORY[category >> 4];
  const kept = Math.min(existing, required); // the stored low nibble, @0x49e30
  farA.length[atA] = (category | kept) & 0xff;
  farB.length[atB] = (category | kept) & 0xff;
  farA.transporters[atA] = existing > 0;
  farB.transporters[atB] = existing > 0;
 // Ejecting the surplus (@0x49da0): if the merged road needs fewer transporters than are present, the
 // surplus ones go in order (segment A's list first, then B) — exactly the two branches of the binary:
 // - state 69 (WokeOnPath) -> 68 (WakeAtFlag) -> the next tick claims the tile -> Lost(25) ->
 //   FreeWalking(16). That is the off-road case, the road pulled out from under him.
 // - otherwise (active, state 3) -> `field_0xf = 0xff`: at the next flag contact the transport handler
 //   turns him into walking without a target, i.e. back through the road network to the nearest
 //   inventory; a carried resource is returned at its destination.
  let surplus = existing - required;
  for (const si of [...tA.carriers, ...tB.carriers]) {
    if (surplus <= 0) break;
    surplus -= 1;
    const serf = state.serfs[si];
    if (!serf) continue;
    if (serf.state === 69) {
      serf.state = 68; // WokeOnPath -> WakeAtFlag -> Lost -> FreeWalking
      continue;
    }
    serf.stateData[4] = 0xff; // -1: at the next flag contact, walking without a target
    const carried = serf.stateData[0]; // field_0xb, the carried resource as a raw 1-based byte
    if (carried !== 0) {
      const dest = serf.stateData[1] | (serf.stateData[2] << 8); // field_0xc as u16
      cancelTransitResource(state, carried, dest);
      serf.stateData[0] = 0;
    }
  }
 // Retarget the walking and transporting serfs that aimed at the two far endpoints.
  retargetSerfsToEndpoints(state, tA.farIdx, atA, tB.farIdx, atB);
}

/**
 * @0x4980e — remove a flag from the world. Same case distinction as the original:
 * - two or more roads -> {@link mergeRoads}: a through flag, the two roads merge and the road tiles stay.
 * - one road -> {@link walkRoad}: a dead end, clear the remaining road.
 * - no road -> just remove it.
 * Then: cancel serf targets, return resources, clear the map object (the path bits stay, only the flag
 * marker goes) and free the flag slot.
 *
 * In the lost-tile context the flags are already road-less when this is called, because the neighbours'
 * `clearRoadPaths` ran first, so the no-road branch applies; the merge branch only fires on a MANUAL flag
 * demolition.
 */
export function demolishFlag(state: GameState, flagIdx: number, col: number, row: number): void {
  const flag = state.flags[flagIdx];
  if (!flag) return;
  const pos = posOf(col, row, state.geo);
  const tile = state.mapTiles[pos];

  const roadDirs: Direction[] = [];
  for (let d = 0; d < 6; d++) if (flag.paths[d]) roadDirs.push(d as Direction);
  if (roadDirs.length >= 2) {
    mergeRoads(state, flag, pos, roadDirs[0], roadDirs[roadDirs.length - 1]); // first and last direction
  } else if (roadDirs.length === 1) {
    walkRoad(state, pos, roadDirs[0]); // clear the dead end
  }

 // Return the flag's resource slots to their destination buildings.
  for (let i = 0; i < flag.resourceSlots.length; i++) {
    const t = flag.resourceSlots[i];
    if (t >= 0) cancelTransitResource(state, t + 1, flag.slotDest[i]);
  }

  cancelSerfsToFlag(state, flagIdx);

 // Clear the map object — the path bits STAY (on a merge the tile becomes through road).
  tile.object = 0; // object byte &= 0x80
  tile.objIndex = 0;
  tile.serfIndex = 0;

  freeFlagSlot(state, flagIdx);
}
