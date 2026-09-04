/**
 * The movement engine, "one step along the road" — a bit-exact port.
 *
 * A walking or carrying serf moves tile by tile along the roads. Per triggered tick it may cover
 * **several tiles**, as long as its counter budget lasts. At each tile the **remaining path mask**
 * (`paths` without the "where from" bit `field_0xe`) determines the next direction uniquely.
 *
 * - Direction dispatch by remaining path mask: jump table `@0x20a70` (8-byte stride, index = mask).
 *   A single-bit mask selects a direction routine; mask 0 or several bits go to `FUN_00020cf0` (the
 *   arrival cleanup).
 * - The six direction routines: Right `0x20cff`, DownRight `0x20eb0`, Down `0x21063`, Left `0x21216`,
 *   UpLeft `0x212ac`, Up `0x2133e`. Only Right/DownRight/Down (dir 0..2) perform the **carrier swap**
 *   (meeting a carrier blocked head-on, the two exchange tiles); Left/UpLeft/Up (3..5) only **wait**
 *   when the target tile is occupied.
 *
 * Constants, extracted identically from all six routines:
 * - **Walking animation index** `anim = 4 + 9*d + dH`, with `dH` the height difference target minus
 *   start. Walking freely: `d = dir`. Swap, self: `d = dir+6`. Swap, partner: `d = dir+3` and `dH`
 *   negated. (Right: free `+4`, swap self `+0x3a`, partner `0x1f`; +9 per direction.)
 * - **Counter budget** per leg = `counter_from_animation[anim]`, added onto `serf.counter`. If the
 *   u16 addition overflows this tick is done (`animation = anim`), otherwise the next tile follows in
 *   the same tick.
 * - **"Where from" marker** `field_0xe`: after a step the opposite direction `(dir+3)%6`; blocked
 *   `0xfa + dir` (signed `-6+dir`). The swap partner gets `field_0xe = dir`.
 * - Blocked: `counter = 0x7f`, `animation = 0x51 + dir` (a **per-direction** waiting animation — the
 *   waiting serf keeps looking the way it wants to go), `field_0xe = 0xfa + dir`.
 */

import { i8 } from './int.js';
import { COUNTER_FROM_ANIMATION } from './serf-tables.js';
import { posOf, colOf, rowOf, neighbor, oppositeDir, type MapGeometry } from './position.js';
import { cancelWalkingRequest } from './road-teardown.js';
import type { GameState, Serf, Flag } from './state.js';

// Union byte indices (field offset - 0xb = stateData index).
const F_B = 0; // field_0xb
const F_C = 1; // field_0xc (low byte; u16 together with F_C+1)
const F_E = 3; // field_0xe ("where from" direction / wait marker, signed)
const F_F = 4; // field_0xf

function setByte(serf: Serf, idx: number, value: number): void {
  serf.stateData[idx] = value & 0xff;
}

/** Result of a directional step: this tick is done, continue with the next tile, or blocked. */
export type StepResult = 'stop' | 'continue' | 'blocked';

/**
 * Waiting animation when the target tile is occupied — **one per direction**, `0x51 + dir`: Right
 * `mov $0x51,%al` @0x20e4f · DownRight `0x52` @0x21002 · Down `0x53` @0x211b5 · Left `0x54` @0x2124b ·
 * UpLeft `0x55` @0x212dd · Up `0x56` @0x2136f. The waiting serf keeps facing the way of its next
 * step instead of staring right.
 */
const ANIM_WAIT_BASE = 0x51;

/** `counter_from_animation[anim]` with an index guard (out of range yields 0, never in practice). */
function counterFor(anim: number): number {
  return (anim >= 0 && anim < COUNTER_FROM_ANIMATION.length ? COUNTER_FROM_ANIMATION[anim] : 0) & 0xffff;
}

/**
 * **The pure movement primitive** — take one step in direction `dir`. On success it sets
 * `serf.col/row` to the neighbouring tile and updates the tile occupancy (`serfIndex`), `field_0xe`
 * (the opposite direction) and `serf.counter` (+= leg budget). Returns:
 * - `'stop'` — counter budget spent, this tick ends on this tile (`animation` set).
 * - `'continue'` — budget left, the caller should handle the next tile.
 * - `'blocked'` — target tile occupied and no swap possible: waiting animation, no step.
 *
 * **It deliberately does NOT touch `field_0xf`.** The pixel movement of walking and transporting is
 * the same in the original, but it hangs on two different step routines: the **walking** step
 * (`change_direction` @0x2098b, here `directionStep`) zeroes `serf+0xf` on the success path, while the
 * **transporter** step (`serf_state_03` @0x2142b, inlined per direction) has the same movement
 * **without** that reset. Hence the reset lives outside: walking calls `directionStep` (with reset),
 * the transporter calls `moveStep` directly (without) — the two separate routines mirrored, with no
 * correcting wrapper.
 */
export function moveStep(state: GameState, serf: Serf, dir: number): StepResult {
  const geo: MapGeometry = state.geo;
  if (serf.col === null || serf.row === null) return 'blocked';
  const oldPos = posOf(serf.col, serf.row, geo);
  const next = neighbor(oldPos, dir, geo);
  const occupant = state.mapTiles[next].serfIndex;
  const dH = state.mapTiles[next].height - state.mapTiles[oldPos].height;

  let myAnim: number;
  if (occupant === 0) {
 // Zielkachel frei → hinbewegen.
    state.mapTiles[oldPos].serfIndex = 0;
    myAnim = 4 + 9 * dir + dH;
    setByte(serf, F_E, oppositeDir(dir));
  } else if (dir <= 2) {
 // dir 0..2: carrier swap if the target tile holds a carrier blocked head-on.
    const other = state.serfs[occupant];
    const otherCame = other ? i8(other.stateData[F_E]) : 0;
    if (!other || otherCame !== dir - 3 || (other.state !== 2 && other.state !== 3)) {
      serf.counter = 0x7f;
      serf.animation = (ANIM_WAIT_BASE + dir) & 0xff;
      setByte(serf, F_E, 0xfa + dir);
      return 'blocked';
    }
 // Swap: the other moves onto my old tile, I move onto the target tile.
    other.col = colOf(oldPos, geo);
    other.row = rowOf(oldPos, geo);
    state.mapTiles[oldPos].serfIndex = occupant;
    myAnim = 4 + 9 * (dir + 6) + dH;
    const otherAnim = 4 + 9 * (dir + 3) - dH;
    setByte(serf, F_E, oppositeDir(dir));
    setByte(other, F_E, dir);
    other.animation = otherAnim & 0xff;
    other.counter = counterFor(otherAnim);
  } else {
 // dir 3..5: no swap — an occupied target tile means waiting.
    serf.counter = 0x7f;
    serf.animation = (ANIM_WAIT_BASE + dir) & 0xff;
    setByte(serf, F_E, 0xfa + dir);
    return 'blocked';
  }

 // Shared ending (free walk and swap alike): put the serf on the target tile, book the budget.
  serf.col = colOf(next, geo);
  serf.row = rowOf(next, geo);
  state.mapTiles[next].serfIndex = serf.index;
  const budget = counterFor(myAnim);
  const before = serf.counter;
  const sum = before + budget;
  serf.counter = sum & 0xffff;
  if (sum > 0xffff) {
    serf.animation = myAnim & 0xff;
    return 'stop';
  }
  return 'continue';
}

/**
 * **The walking step** `change_direction` (`FUN_0002098b` @0x2098b): the movement primitive
 * `moveStep` plus `field_0xf = 0` **on the success path** (free walk as well as successful swap), but
 * **not** on the blocked path. The transporter (`serf_state_03`) calls `moveStep` directly and leaves
 * `field_0xf` alone.
 */
export function directionStep(state: GameState, serf: Serf, dir: number): StepResult {
  const r = moveStep(state, serf, dir);
  if (r !== 'blocked') setByte(serf, F_F, 0);
  return r;
}

/**
 * Remaining path mask -> a single direction. Exactly one set bit gives that direction (0..5); zero
 * or more than one gives `null` (the original then jumps into the arrival cleanup, `FUN_00020cf0`).
 */
export function singleBitDir(mask: number): number | null {
  const m = mask & 0x3f;
  if (m === 0 || (m & (m - 1)) !== 0) return null;
  return 31 - Math.clz32(m);
}

/**
 * `arrival_cleanup` (@0x20cf0, body reached by the tail jump `jmp 0x207ba`) — the **terminal ending
 * of a walking serf when no next step can be determined**. It books its pending request back and
 * turns itself towards home.
 *
 * **Exactly two call paths in the original**, both located rather than assumed:
 * 1. **Dead end** — the jump table of the remaining path mask `@0x20a70`: 58 of its 64 slots jump
 *    here, namely all but the six single-bit masks (those go to the direction routines).
 * 2. **Failed flag network search** — `js 0x2078e` @0x20505 (search result `gs+0x276` negative); the
 *    block @0x2078e only restores the saved registers and **falls through** to 0x207ba. The only
 *    inflow there.
 *
 * Sequence (two exits, both writing):
 * - `counter = 0` (@0x20cf0 — only via path 1; path 2 arrives without it, and both exits set it
 *   anyway).
 * - Book the pending request back: {@link cancelWalkingRequest} — the same instruction block as in
 *   `set_lost_state`.
 * - **`dir1 <= -2` gives its own exit @0x20901**: state 25 (Lost), **`field_0xb = 1`**, `counter = 0`,
 *   **without** the tail. The `1` sends the Lost handler's spiral search **backwards** (index 258 ->
 *   1 instead of 1 -> 258).
 *   *Precondition, established from the routine itself:* its own tail sets `field_0xb = -2`. A serf
 *   whose job was cancelled here therefore walks home with `-2`; if it fails **again** (a second dead
 *   end or a second failed search), this branch applies — "cannot even get home, so it is lost". The
 *   other writers of `field_0xb = -2` with state 2 are `find_inventory` (@0x1ecf7/@0x1ecef),
 *   `FUN_00019156` (@0x19165/@0x19177) and the **generic resupply** of `send_serf_to_flag`
 *   (@0x12909) — all of them send off a settler who carries no request, which is exactly why this
 *   branch may drop him instead of booking one back.
 * - Otherwise the **tail @0x2091c**: `field_0xb = 0xfe` (dir1 = -2), `field_0xc = 0` (dest = 0),
 *   `counter = 0`.
 */
export function arrivalCleanup(state: GameState, serf: Serf): void {
  serf.counter = 0; // @0x20cf0
  if (cancelWalkingRequest(state, serf) === 'lost') {
    serf.state = 25; // Lost (@0x20901)
    setByte(serf, F_B, 1); // spiral search backwards
    serf.counter = 0;
    return;
  }
 // tail @0x2091c
  setByte(serf, F_B, 0xfe);
  setByte(serf, F_C, 0);
  setByte(serf, F_C + 1, 0);
  serf.counter = 0;
}

/** True when a flag stands on this tile (the original tests bit 7 of the paths byte). */
export function tileHasFlag(state: GameState, pos: number): boolean {
  return state.mapTiles[pos].object === 1;
}

/**
 * Flag network BFS (shortest path through the flag network) — determines at a **transit flag** the
 * first step direction towards the destination flag `destFlagIdx`. Ported from the walking handler
 * (`serf_state_02` @0x2004e ff. and the shared `change_direction` variant @0x2098b):
 * `new_flag_search` (`FUN_0001303f`, which hands out a search generation) plus a double-buffered
 * frontier BFS over the endpoint pointers `flag+0x24+dir*4`; every neighbour reached remembers the
 * **start direction** (search_dir), and once the destination flag is marked its search_dir gives the
 * first direction.
 *
 * We use **local scratch** (a `visited` set plus a `searchDir` map) instead of the transient flag
 * search fields (`flag+0`/`flag+2`) — functionally equivalent and without side effects on the oracle.
 * Direction iteration runs **descending 5 -> 0** (the original tests the endpoints +0x38...+0x24), so
 * ties between equally long paths break identically. Neighbours only through
 * `connections[dir].kind === 'flag'` (the UpLeft building endpoint is not expanded). Returns the
 * first direction 0..5, or `null` when the search failed (the caller then does the dead-end cleanup).
 *
 * **Land roads only** (`mov 0x4(%ebx),%al` @0x205af, then six doublings plus `jns`). The survey of all
 * nine network traversals is at {@link landNeighborFlag}.
 */
export function flagSearchDir(state: GameState, fromFlagIdx: number, destFlagIdx: number): number | null {
  const src = state.flags[fromFlagIdx];
  if (!src) return null;
  const searchDir = new Map<number, number>();
  const visited = new Set<number>([fromFlagIdx]);
  let frontier: number[] = [];
 // Initial frontier: the directly connected neighbour flags, each tagged with its start direction.
  for (let dir = 5; dir >= 0; dir--) {
    const conn = src.endpointDirs[dir] ? src.connections[dir] : null; // `flag[4]` bit dir — land roads only
    if (conn && conn.kind === 'flag' && !visited.has(conn.index)) {
      if (conn.index === destFlagIdx) return dir; // the destination is a direct neighbour
      visited.add(conn.index);
      searchDir.set(conn.index, dir);
      frontier.push(conn.index);
    }
  }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const fIdx of frontier) {
      const f = state.flags[fIdx];
      if (!f) continue;
      const startDir = searchDir.get(fIdx)!;
      for (let dir = 5; dir >= 0; dir--) {
        const conn = f.endpointDirs[dir] ? f.connections[dir] : null; // dito
        if (conn && conn.kind === 'flag' && !visited.has(conn.index)) {
          if (conn.index === destFlagIdx) return startDir;
          visited.add(conn.index);
          searchDir.set(conn.index, startDir);
          next.push(conn.index);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * `find_nearest_inventory` (`FUN_00044703` @0x44703) — find the **nearest reachable inventory flag**
 * in the network, starting from `fromFlagIdx` (a flag with the `acceptsSerfs` bit set = `flag+0x42`
 * bit 7 = a flag at a warehouse or castle that accepts serfs). Returns the flag index, or `null` when
 * none is reachable.
 *
 * Used by the walking handler when a carrier is sent home (`field_0xf < 0` at the end of a transport
 * gives walking with `field_0xc = 0`): the serf walks back **over the road network** to the nearest
 * warehouse — the "surplus carrier returns to the castle" case, not free walking and not a
 * surroundings search.
 *
 * Like {@link flagSearchDir}: double-buffered frontier BFS, direction iteration **descending 5 -> 0**
 * (matching the endpoint pointers +0x38...+0x24, so ties break identically), neighbours only through
 * `connections[dir].kind === 'flag'`. The start flag itself is tested first (`LAB_00044a01`).
 */
export function findNearestInventory(state: GameState, fromFlagIdx: number): number | null {
  const src = state.flags[fromFlagIdx];
  if (!src) return null;
  if (src.acceptsSerfs) return fromFlagIdx; // the start flag has an inventory itself (LAB_00044a01)
  const visited = new Set<number>([fromFlagIdx]);
  let frontier: number[] = [fromFlagIdx];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const fIdx of frontier) {
      const f = state.flags[fIdx];
      if (!f) continue;
      for (let dir = 5; dir >= 0; dir--) {
        const conn = f.endpointDirs[dir] ? f.connections[dir] : null; // `flag[4]` bit dir, @0x4481f
        if (!conn || conn.kind !== 'flag' || visited.has(conn.index)) continue;
        const nf = state.flags[conn.index];
        if (nf && nf.acceptsSerfs) return conn.index; // nearest warehouse found
        visited.add(conn.index);
        next.push(conn.index);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The waiting / re-orientation branch of walking (`came < 0`, `field_0xe` negative) —
 * `serf_state_02` @0x20114 ff. The serf wants the intention it remembered when blocked, `came + 6`,
 * and tries the step again. Before that `field_0xf` (the wait counter) is incremented; **only above a
 * threshold** does a loop detection run: follow the chain of waiting serfs (at most 99), and if a
 * cycle leads back to the serf's own index, dodge in the **opposite** direction. Otherwise a
 * `change_direction` (== `directionStep`) towards `came + 6`.
 *
 * **The threshold, read from the binary:** the original tests `landscape[pos] < 0 ? 10 : 50` — so **at
 * a flag from wait_counter >= 10, otherwise >= 50**. Note the order: it is the flag case that gets the
 * *lower* threshold. `wait_counter` is not zeroed by hand — the successful step (`directionStep`) sets
 * `field_0xf = 0`, while a blockade leaves it standing, as in the original.
 */
export function walkingWaiting(state: GameState, serf: Serf): StepResult {
  if (serf.col === null || serf.row === null) return 'stop';
 // field_0xf (wait_counter) ++
  const wc = (serf.stateData[F_F] + 1) & 0xff;
  setByte(serf, F_F, wc);
  const pos = posOf(serf.col, serf.row, state.geo);
  const threshold = tileHasFlag(state, pos) ? 10 : 50;
  let dir = (i8(serf.stateData[F_E]) + 6) & 7; // the direction wanted
  if (wc >= threshold) {
 // Loop detection along the chain of waiting serfs.
    let p = pos;
    let d = dir;
    for (let i = 0; i < 99; i++) {
      p = neighbor(p, d, state.geo);
      const occ = state.mapTiles[p].serfIndex;
      if (occ === 0) break;
      if (occ === serf.index) {
 // Cycle -> dodge in the opposite direction.
        return directionStep(state, serf, oppositeDir(d));
      }
      const other = state.serfs[occ];
      if (!other || (other.state !== 2 && other.state !== 3)) break;
      const oc = i8(other.stateData[F_E]);
      if (oc >= 0) break;
      const nd = (oc + 6) & 7;
      if (nd === oppositeDir(d)) break;
      d = nd;
    }
 // No cycle found: wait_counter = 0, direction back to the serf's own intention.
    setByte(serf, F_F, 0);
    dir = (i8(serf.stateData[F_E]) + 6) & 7;
  }
  return directionStep(state, serf, dir);
}

/**
 * The transporter's step along a road (`FUN_00021bc3` family, @0x21bc3) — like `directionStep` but
 * with an **idle transition** in front of it. Before taking the step the original asks: does the
 * target tile hold a **flag**, is the carrier **empty** (`field_0xb == 0`) and `field_0xf >= 0`, and
 * is nothing scheduled at that flag in the opposite direction (`!scheduled[rev]`)? Then it sets the
 * turn-around animation (`0x6e + field_0xe`), `field_0xe -= 6`, `counter = 0x3f` and:
 * - **at most 1 carrier** serves this side (`length[rev] & 0xf < 2`) **and** nothing is scheduled at
 *   the other end of the segment -> it **becomes `IdleOnPath` (66)**: it sits down on the road
 *   (`field_0xb = rev`, `field_0xc = flagIndex*70` as u32, which overwrites `field_0xe/0xf`; the low
 *   byte of `tick` becomes `field_0xe`; the tile's serf slot is cleared). Sitting down in the middle
 *   rather than shuttling.
 * - **2 or more carriers** -> `field_0xf++`; above 3 one carrier is taken out of service
 *   (`length[rev] -= 1` at both ends, `field_0xf = -1`, so the next flag visit turns it into
 *   walking).
 * - otherwise (the other end is scheduled) only the turn-around animation, no idling.
 * If the idle test does not fire (target tile has no flag / loaded / `field_0xf < 0` /
 * `scheduled[rev]`) a normal `directionStep` follows — with `scheduled` it walks onto the flag to
 * pick the resource up.
 *
 * (State 0x42 = 66; the low nibble of `length[dir]` is the carrier count; `flag+0x3c+dir` bit 7 is
 * `scheduled`, bits 3-5 `otherEndDir`; `flag+0x24+dir*4` is the endpoint.)
 */
export function transporterOnRoadStep(state: GameState, serf: Serf, dir: number): StepResult {
  const geo: MapGeometry = state.geo;
  if (serf.col === null || serf.row === null) return 'blocked';
  const pos = posOf(serf.col, serf.row, geo);
  const next = neighbor(pos, dir, geo);

  if (tileHasFlag(state, next) && serf.stateData[F_B] === 0 && i8(serf.stateData[F_F]) >= 0) {
    const flagIdx = state.mapTiles[next].objIndex;
    const flag = state.flags[flagIdx];
    const rev = oppositeDir(dir);
    if (flag && !flag.scheduled[rev]) {
      serf.counter = 0x3f;
      const cameE = i8(serf.stateData[F_E]);
      serf.animation = (cameE + 0x6e) & 0xff;
      setByte(serf, F_E, cameE - 6); // field_0xe -= 6
      const count = flag.length[rev] & 0xf;
      if (count < 2) {
        const conn = flag.connections[rev];
        const otherFlag = conn && conn.kind === 'flag' ? state.flags[conn.index] : null;
        const otherDir = flag.otherEndDir[rev];
        if (otherFlag && !otherFlag.scheduled[otherDir]) {
 // -> IdleOnPath: sit down on the road.
          serf.tick = (serf.tick & 0xff00) | (serf.stateData[F_E] & 0xff);
          setByte(serf, F_B, rev);
          const off = (flagIdx * 70) & 0xffff; // field_0xc as u32 = flagIndex*70 (the save's offset)
          setByte(serf, F_C, off & 0xff);
          setByte(serf, F_C + 1, (off >> 8) & 0xff);
          serf.stateData[3] = 0; // field_0xe — overwritten by the u32 write to field_0xc
          serf.stateData[4] = 0; // field_0xf
          state.mapTiles[pos].serfIndex = 0;
          serf.state = 66; // IdleOnPath
        }
 // otherwise the other end is scheduled: no idling, only the turn-around animation
      } else {
 // 2 or more carriers on this side: wait counter; above 3 take one out of service.
        const wc = (serf.stateData[F_F] + 1) & 0xff;
        setByte(serf, F_F, wc);
        if (wc > 3) {
          setByte(serf, F_F, 0);
          if ((flag.length[rev] & 0xf) > 1) {
            flag.length[rev] = (flag.length[rev] - 1) & 0xff;
            const conn = flag.connections[rev];
            const otherFlag = conn && conn.kind === 'flag' ? state.flags[conn.index] : null;
            const otherDir = flag.otherEndDir[rev];
            if (otherFlag) otherFlag.length[otherDir] = (otherFlag.length[otherDir] - 1) & 0xff;
            setByte(serf, F_F, 0xff); // wait_counter = -1
          }
        }
      }
      return 'stop';
    }
  }
 // Transporter movement through the primitive `moveStep` (without the `field_0xf` reset) — the
 // transporter step (`serf_state_03` @0x2142b, inlined per direction) does not zero `serf+0xf`,
 // unlike walking's `change_direction`. That is how the overcrowding counter accumulates over the
 // shuttle steps up to the shedding threshold (> 3).
  return moveStep(state, serf, dir);
}

// ---- Picking up and dropping resources at a flag (transporting) ----

/** Rebuild the raw resource slot byte (`flag+0xc+i`) from the decoded fields. */
function rawSlot(flag: Flag, i: number): number {
  const res = flag.resourceSlots[i]; // -1 = empty
  if (res < 0) return 0;
  return (((flag.slotDir[i] + 1) & 7) << 5) | ((res + 1) & 0x1f);
}
/** Write the raw slot byte back, split into `resourceSlots`/`slotDir`. */
function setRawSlot(flag: Flag, i: number, b: number): void {
  flag.resourceSlots[i] = (b & 0x1f) - 1;
  flag.slotDir[i] = ((b >> 5) & 7) - 1;
}

/**
 * `prioritize_pickup(flag, dir, owner)` — schedule the next resource to be collected in direction
 * `dir`. Over the eight resource slots only those whose direction tag is `(dir+1)` (bits 5-7 of the
 * slot byte) count; the one with the highest `player.flag_prio[res]` wins. Sets
 * `flag.scheduled[dir]`/`scheduledSlot[dir]` (`flag[0x3c+dir] &= 0x78`, then possibly
 * `|= 0x80 | bestSlot`).
 */
function prioritizePickup(state: GameState, flag: Flag, dir: number, owner: number): void {
  const player = state.players[owner];
  const prio = player ? player.flagPriority : null;
  let best = 0;
  let bestSlot = -1;
  for (let i = 0; i < 8; i++) {
    const b = rawSlot(flag, i);
    if (b !== 0 && ((b >> 5) & 7) === dir + 1) {
      const res = (b & 0x1f) - 1;
      const p = prio ? prio[res] : 0;
      if (best < p) {
        best = p;
        bestSlot = i;
      }
    }
  }
  flag.scheduled[dir] = false;
  flag.scheduledSlot[dir] = 0;
  if (bestSlot >= 0) {
    flag.scheduled[dir] = true;
    flag.scheduledSlot[dir] = bestSlot;
  }
}

/**
 * `transporter_move_to_flag` (shared, inlined in states 03 and 14) — at the flag **pick up** a
 * resource (empty carrier), **swap** (loaded plus a resource scheduled) or **drop off** (loaded,
 * nothing scheduled). Afterwards `prioritizePickup` schedules the next collection for this direction.
 * The closing `change_direction(dir)` (the step back over the segment) happens in the caller.
 *
 * Serf union: `field_0xb` = the raw resource nibble (resource + 1, 0 = empty), `field_0xc` (u16) = the
 * destination flag.
 */
export function transporterMoveToFlag(state: GameState, serf: Serf): void {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  const flag = state.flags[state.mapTiles[pos].objIndex];
  if (!flag) return;
  const dir = i8(serf.stateData[F_E]);
  if (dir < 0 || dir > 5) return;

  if (flag.scheduled[dir]) {
    const slot = flag.scheduledSlot[dir];
    setByte(serf, F_F, 0);
    if (serf.stateData[F_B] === 0) {
 // empty carrier -> pick the resource up
      const b = rawSlot(flag, slot);
      setRawSlot(flag, slot, 0);
      setByte(serf, F_B, b & 0x1f);
      serf.stateData[F_C] = flag.slotDest[slot] & 0xff;
      serf.stateData[F_C + 1] = (flag.slotDest[slot] >> 8) & 0xff;
    } else {
 // loaded -> swap (old resource down, new one up)
      flag.hasResources = true;
      const b = rawSlot(flag, slot);
      setRawSlot(flag, slot, serf.stateData[F_B]);
      const oldDest = flag.slotDest[slot];
      flag.slotDest[slot] = serf.stateData[F_C] | (serf.stateData[F_C + 1] << 8);
      setByte(serf, F_B, b & 0x1f);
      serf.stateData[F_C] = oldDest & 0xff;
      serf.stateData[F_C + 1] = (oldDest >> 8) & 0xff;
    }
    prioritizePickup(state, flag, dir, serf.owner);
  } else if (serf.stateData[F_B] !== 0) {
 // nothing scheduled but loaded -> drop into the first free slot
    for (let i = 0; i < 8; i++) {
      if (rawSlot(flag, i) === 0) {
        flag.hasResources = true;
        setRawSlot(flag, i, serf.stateData[F_B]);
        flag.slotDest[i] = serf.stateData[F_C] | (serf.stateData[F_C + 1] << 8);
        setByte(serf, F_B, 0);
        break;
      }
    }
  }
}
