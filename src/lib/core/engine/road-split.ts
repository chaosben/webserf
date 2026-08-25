/**
 * **Splitting a road** — port of `FUN_0004d9ed` (@0x4d9ed) + `FUN_0004de24` (@0x4de24), the
 * counterpart to the merge in `road-teardown.ts`: there two halves fuse into one road, here a road is
 * split into two halves at a **newly placed flag**.
 *
 * Two triggers:
 * - `build_flag` (@0x2899f, at the end): `if (player[0x100] == 4) FUN_0004d9ed(player[0xfc],
 *   player[0xfe])` — a flag placed **in the middle of a road** (cursor type 4).
 * - `place_building` (@0x2a1e6 family, same body per building type): `if (player[0x100] == 6)`
 *   `FUN_0004d9ed((col+1) & gs[0x32], (row+1) & gs[0x34])` — the **DownRight** tile, where the
 *   building's flag lands, lies on a road (cursor type 6).
 *
 * ## `FUN_0004d9ed`
 *
 * ```
 * paths = landscape[pos*4] & 0x3f
 * dirA  = first set bit ; dirB = next set bit above dirA
 * if (dirB == 4 && (paths & 0x20)) dirB = 5              // @0x4dae5 (cmpw $4 / btl $5 / mov $5)
 * traceA = trace_road_from_flag(pos, dirA) -> buffer DAT_0004a348
 * traceB = trace_road_from_flag(pos, dirB) -> buffer DAT_0004a370
 * <restrict the carrier request to ONE half>
 * newFlag = flags[game[pos*4]]                           // the flag just built
 * FUN_0004de24(newFlag, dirA, traceA) ; FUN_0004de24(newFlag, dirB, traceB)
 * ```
 *
 * The bit scan is unbounded in the original (`bt`/`jne` loop) — it relies on a road tile carrying
 * **two** path bits. We stop above 5 defensively; the `dirB == 4 -> 5` special rule is taken
 * verbatim even though it can only bite from three path bits upwards.
 *
 * **Buffer layout** (`DAT_0004a348`/`DAT_0004a370`, filled by `trace_road_from_flag`) == our
 * {@link RoadTrace}: `+0` steps, `+2` carrier count, `+4` far flag, `+6` opposite direction there,
 * `+8...` the carrier indices in walking order.
 */
import { Direction, posOf } from './position.js';
import { i8 } from './int.js';
import {
  CARRIERS_PER_CATEGORY,
  cancelTransitResource,
  indexRestingCarriers,
  lengthToCategory,
  traceRoadCarriers,
  type RoadTrace,
} from './road-teardown.js';
import type { Flag, GameState } from './state.js';

/**
 * Link one road half to the new flag — `FUN_0004de24` (@0x4de24), field by field:
 *
 * ```
 * new[3]        |= 1 << dir                  // pathCon
 * new[4]        &= ~(1 << dir) ; if (far[4] & (1 << farDir)) new[4] |= 1 << dir
 * far[5]        &= ~(1 << farDir) ; new[5] &= ~(1 << dir)      // transporter bits
 * new[6+dir]     = 0 ; far[6+farDir] &= 0x80 ; if (that != 0) new[6+dir] = 0x80
 * new[0x3c+dir]  = (... & 0xc7) | farDir << 3 ; far[0x3c+farDir] = (... & 0xc7) | dir << 3
 * new[0x24+dir*4] = &far ; far[0x24+farDir*4] = &new
 * cat = road_length_to_category(buffer[0]) ; new[6+dir] |= cat ; far[6+farDir] |= cat
 * want = carriers_per_category[cat >> 4] ; if (new[6+dir] & 0x80) want--
 * ```
 *
 * Then the **surplus ejection** and the carrier count in the low nibble, identical to the merge
 * (`FUN_0004980e`): `min(want, present)` are kept, the surplus ejected in order (state 69 -> 68;
 * otherwise `field_0xf = 0xff` plus booking the carried resource back).
 *
 * Mind the order on the far flag's `length` byte: it is masked to bit 7 **first** (length and carrier
 * count of the old, undivided road fall away) and read **afterwards**, to transfer the carrier
 * request to the new flag.
 */
export function linkRoadHalf(
  state: GameState,
  newFlag: Flag,
  newIdx: number,
  dir: Direction,
  trace: RoadTrace,
): void {
  const far = state.flags[trace.farIdx];
  if (!far) return;
  const farDir = trace.farDir;

  newFlag.paths[dir] = true;
  newFlag.endpointDirs[dir] = far.endpointDirs[farDir]!;
  far.transporters[farDir] = false;
  newFlag.transporters[dir] = false;

  newFlag.length[dir] = 0;
  far.length[farDir] = far.length[farDir]! & 0x80; // drop the remains of the old road
  if (far.length[farDir] !== 0) newFlag.length[dir] = 0x80; // take over the carrier request

  newFlag.otherEndDir[dir] = farDir;
  far.otherEndDir[farDir] = dir;
  newFlag.connections[dir] = { kind: 'flag', index: trace.farIdx };
  far.connections[farDir] = { kind: 'flag', index: newIdx };

  const category = lengthToCategory(trace.steps);
  newFlag.length[dir] = (newFlag.length[dir]! | category) & 0xff;
  far.length[farDir] = (far.length[farDir]! | category) & 0xff;

  let required = CARRIERS_PER_CATEGORY[category >> 4]!;
  if ((newFlag.length[dir]! & 0x80) !== 0) required -= 1; // one carrier has already been requested

  const existing = trace.carriers.length;
  if (existing === 0) return;
  let kept = existing;
  if (required < existing) {
    kept = required;
    let surplus = existing - required;
    for (const si of trace.carriers) {
      if (surplus <= 0) break;
      surplus -= 1;
      const serf = state.serfs[si];
      if (!serf) continue;
      if (serf.state === 69) {
        serf.state = 68; // WokeOnPath → WakeAtFlag (→ Lost → FreeWalking)
        continue;
      }
      serf.stateData[4] = 0xff; // field_0xf = -1 => at the next flag: head back to the warehouse
      const carried = serf.stateData[0]!; // field_0xb (getragene Ware, roher Byte-Wert)
      if (carried !== 0) {
        const dest = serf.stateData[1]! | (serf.stateData[2]! << 8); // field_0xc
        cancelTransitResource(state, carried, dest);
        serf.stateData[0] = 0;
      }
    }
  }
  if ((kept & 0xff) !== 0) {
    newFlag.transporters[dir] = true;
    far.transporters[farDir] = true;
    newFlag.length[dir] = (newFlag.length[dir]! | kept) & 0xff;
    far.length[farDir] = (far.length[farDir]! | kept) & 0xff;
  }
}

/**
 * Only **one** of the two halves may keep the undivided road's **carrier request**
 * (`FUN_0004d9ed` @0x4dbc2 ff.). If the far end of half B carries an open request (`length[farDir]`
 * bit 7), the carrier already **on its way** is looked for: a serf whose destination (`field_0xc`)
 * plus destination direction (`field_0xb`) points at one of the two far ends and which is in an
 * approach state (1/2/0x0f, or 5/7 with `field_0xf == 2`).
 *
 * Found for end **A** (or not at all), **B** loses the request; found for **B**, **A** loses it. The
 * original picks the buffer of the *other* half for this (`field_0x28 = bufB; if (vreg1) field_0x28 =
 * bufA`) and clears bit 7 there.
 *
 * **A byte quirk, reproduced verbatim** (@0x4d859): the flag `vreg1` is set to 0 **inside** the loop,
 * and only *after* the slot's occupancy test has passed. If the loop runs through without finding a
 * matching state, the value of the **last occupied slot examined** therefore survives — i.e. 1 if
 * that one pointed at end B but was in the wrong state. There is a `break` only on a state hit.
 *
 * The same sequence appears **inline twice** in the original: in `FUN_0004d9ed` (split) and in
 * `FUN_0004d460` (attach road). Both are identical, hence one routine for both callers.
 */
export function transferRoadSerfRequest(
  state: GameState,
  traceA: RoadTrace,
  traceB: RoadTrace,
): void {
  const farB = state.flags[traceB.farIdx];
  if (!farB) return;
  if ((farB.length[traceB.farDir]! & 0x80) === 0) return;

  let foundAtB = false;
  for (const serf of state.serfs) {
    if (!serf) continue; // unbelegter Slot: `vreg1` bleibt unangetastet
    foundAtB = false;
    const dest = serf.stateData[1]! | (serf.stateData[2]! << 8); // field_0xc
    const dir = i8(serf.stateData[0]!); // field_0xb
    if (dest === traceA.farIdx && dir === traceA.farDir) foundAtB = false;
    else if (dest === traceB.farIdx && dir === traceB.farDir) foundAtB = true;
    else continue;
    const st = serf.state;
    const walking = st === 1 || st === 2 || st === 0x0f;
    const transporting = (st === 5 || st === 7) && serf.stateData[4] === 2;
    if (walking || transporting) break;
  }

  const loser = foundAtB ? traceA : traceB;
  const flag = state.flags[loser.farIdx];
  if (!flag) return;
  flag.length[loser.farDir] = flag.length[loser.farDir]! & 0x7f;
}

/**
 * Split the road at tile `col/row` — `FUN_0004d9ed`. Requires that the new flag is **already** there
 * (`tile.object === 1`, `tile.objIndex` = its index) and that the tile carries path bits; that is
 * exactly what the two callers set up (`buildFlag` type 4, `placeBuilding` type 6).
 */
export function splitRoadAtFlag(state: GameState, col: number, row: number): void {
  const geo = state.geo;
  const pos = posOf(col, row, geo);
  const tile = state.mapTiles[pos];
  if (tile === undefined) return;
  const paths = tile.paths & 0x3f;

  let dirA = 0;
  while (dirA < 6 && (paths & (1 << dirA)) === 0) dirA += 1;
  let dirB = dirA + 1;
  while (dirB < 6 && (paths & (1 << dirB)) === 0) dirB += 1;
  if (dirB === 4 && (paths & 0x20) !== 0) dirB = 5; // @0x4dae5, verbatim
  if (dirA > 5 || dirB > 5) return; // unreachable in the original (a road tile has two bits)

  const restingByPos = indexRestingCarriers(state);
  const traceA = traceRoadCarriers(state, pos, dirA as Direction, restingByPos);
  const traceB = traceRoadCarriers(state, pos, dirB as Direction, restingByPos);
  if (traceA.farIdx === 0 || traceB.farIdx === 0) return; // Trace ins Nichts (defensiv)

  transferRoadSerfRequest(state, traceA, traceB);

  const newIdx = tile.objIndex;
  const newFlag = state.flags[newIdx];
  if (!newFlag) return;
  linkRoadHalf(state, newFlag, newIdx, dirA as Direction, traceA);
  linkRoadHalf(state, newFlag, newIdx, dirB as Direction, traceB);
}
