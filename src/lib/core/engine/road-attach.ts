/**
 * Attach a road to a flag - port of `can_attach_flag_to_road` (@0x4c9b3), `FUN_0004ccdf` and the
 * worker `FUN_0004d460`. The flag popup's action: if a road runs close past a flag without touching
 * it, this button ties the flag into the road.
 *
 * The flag sits on `C`. Per direction `d` the triangle `(C, C+d, C+(d+1))` is tested: if `C` has no
 * road in either direction, the neighbour tile read belongs to the same owner and carries the road
 * across the edge opposite the cursor, then `d` is a hit. The original writes the six blocks out
 * individually and reads the edge alternately from one end or the other - {@link ATTACH_PROBE} is
 * that table, not normalised:
 *
 * | `d` | pair mask | tile read | bit tested |
 * |---|---|---|---|
 * | 0 | `0x03` | `C + Right` | 2 = Down |
 * | 1 | `0x06` | `C + Down` | 0 = Right |
 * | 2 | `0x0c` | `C + Left` | 1 = DownRight |
 * | 3 | `0x18` | `C + Left` | 5 = Up |
 * | 4 | `0x30` | `C + Up` | 3 = Left |
 * | 5 | `0x21` | `C + Right` | 4 = UpLeft |
 *
 * Each row is one end of the same edge, and a road edge sets the bit on both tiles, so the two
 * readings are equivalent.
 *
 * The entry gate tests bit 7 of the `paths` byte, the flag marker. Our tile model does not carry that
 * redundant bit; `object === 1` is exactly equivalent throughout the original data.
 *
 * `can_attach_flag_to_road` is free of side effects and answers yes/no. `FUN_0004ccdf` has the same
 * head but calls the worker per hit and re-reads the path bits of `C` after every attachment: an
 * attachment in direction `d` sets bits `d` and `d+1`, so the overlapping following pairs fail by
 * themselves, while several disjoint attachments in one click remain possible. The port therefore also
 * reads `tile.paths` fresh inside the loop. With three roads running past a bare flag, one click makes
 * three attachments - whereupon the third road becomes a loop from the flag to itself and is removed
 * again by {@link razeSelfLoops}.
 */
import { Direction, colOf, neighbor, oppositeDir, posOf, rowOf } from './position.js';
import { clearRoadPaths, indexRestingCarriers, traceRoadCarriers, wakeCarrierOnPath } from './road-teardown.js';
import { linkRoadHalf, transferRoadSerfRequest } from './road-split.js';
import type { GameState } from './state.js';

/** One test block of the original: which neighbour tile is read and which path bit counts there. */
interface AttachProbe {
  /** Direction from `C` to the tile read. */
  readonly readDir: Direction;
  /** Path bit that must be set there (the other end of the edge tested). */
  readonly bit: number;
}

/** The six blocks `@0x4ca85` ff., index = direction `d` of the pair `(d, d+1)`. */
const ATTACH_PROBE: readonly AttachProbe[] = [
  { readDir: Direction.Right, bit: Direction.Down }, // d = 0
  { readDir: Direction.Down, bit: Direction.Right }, // d = 1
  { readDir: Direction.Left, bit: Direction.DownRight }, // d = 2
  { readDir: Direction.Left, bit: Direction.Up }, // d = 3
  { readDir: Direction.Up, bit: Direction.Left }, // d = 4
  { readDir: Direction.Right, bit: Direction.UpLeft }, // d = 5
];

/** Path bit mask of the direction pair `(d, d+1)` — the constants `3/6/0xc/0x18/0x30/0x21`. */
function pairMask(d: number): number {
  return (1 << d) | (1 << ((d + 1) % 6));
}

/**
 * Does one of the six blocks match at tile `col/row`? — `can_attach_flag_to_road` (@0x4c9b3),
 * returning 0 (yes) / -1 (no) in the original. Free of side effects; it also decides whether the
 * renderer draws icon `0x135` at all.
 */
export function canAttachFlagToRoad(state: GameState, col: number, row: number): boolean {
  const geo = state.geo;
  const pos = posOf(col, row, geo);
  const tile = state.mapTiles[pos];
  if (tile === undefined || tile.object !== 1) return false; // entry gate: a flag on the tile
  for (let d = 0; d < 6; d++) {
    if (probeAttachDir(state, pos, tile.paths, tile.owner, d)) return true;
  }
  return false;
}

/** One of the six blocks: pair free, neighbour same owner, edge occupied there. */
function probeAttachDir(
  state: GameState,
  pos: number,
  paths: number,
  owner: number,
  d: number,
): boolean {
  if ((paths & pairMask(d)) !== 0) return false;
  const probe = ATTACH_PROBE[d]!;
  const edge = state.mapTiles[neighbor(pos, probe.readDir, state.geo)];
  if (edge === undefined || edge.owner !== owner) return false;
  return (edge.paths & (1 << probe.bit)) !== 0;
}

/**
 * Tie the flag at tile `col/row` into a road running past — `FUN_0004ccdf`. Returns `true` when at
 * least one attachment was made (the success sound in the original).
 */
export function attachFlagToRoad(state: GameState, col: number, row: number): boolean {
  const geo = state.geo;
  const pos = posOf(col, row, geo);
  const tile = state.mapTiles[pos];
  if (tile === undefined || tile.object !== 1) return false;
  const owner = tile.owner; // read once before the loop (`vreg4`), as in the original

  let attached = false;
  for (let d = 0; d < 6; d++) {
    // `tile.paths` is the tile being mutated — equivalent to re-reading after every attachment.
    if (!probeAttachDir(state, pos, tile.paths, owner, d)) continue;
    attachRoadPair(state, pos, d as Direction);
    attached = true;
  }
  if (!attached) return false;

  razeSelfLoops(state, pos);
  return true;
}

/**
 * After attaching: raze roads that lead from the flag **back to itself** (`FUN_0004ccdf` @0x4d33d
 * ff.). Walks directions **5 down to 0** and, on a self reference, clears the road from the
 * **neighbour** tile (`clear_road_paths`).
 *
 * This happens when the road tied in was a loop that passed the flag twice.
 */
function razeSelfLoops(state: GameState, pos: number): void {
  const geo = state.geo;
  const flagIdx = state.mapTiles[pos]!.objIndex;
  const flag = state.flags[flagIdx];
  if (!flag) return;
  for (let d = 5; d >= 0; d--) {
    if (!flag.paths[d]) continue;
    const conn = flag.connections[d];
    if (!conn || conn.kind !== 'flag' || conn.index !== flagIdx) continue;
    const np = neighbor(pos, d as Direction, geo);
    clearRoadPaths(state, colOf(np, geo), rowOf(np, geo));
  }
}

/**
 * The worker `FUN_0004d460` (@0x4d460, one routine together with the fall-through body @0x4d5e0):
 * hook flag `C` into the edge between `C+d` and `C+(d+1)`.
 *
 * ```
 * C.paths |= (1<<d) | (1<<(d+1))                                  // both connections of the flag
 * A = C + d      : paths &= ~(1<<((d+2)%6))   ; |= 1<<opposite(d)
 * B = C + (d+1)  : paths &= ~(1<<((d+1+4)%6)) ; |= 1<<opposite(d+1)
 * for A and B each: wake a resting carrier + redirect a walking carrier to the new direction
 * trace_road_from_flag(d) / (d+1) ; restrict the carrier request to ONE half
 * link_road_half(d) ; link_road_half(d+1)
 * ```
 *
 * The two cleared bits are the **two ends of the same edge** (A->B and B->A) — the road running past
 * is cut there and rerouted through the flag.
 */
function attachRoadPair(state: GameState, pos: number, d: Direction): void {
  const d1 = d;
  const d2 = ((d + 1) % 6) as Direction;

  const tile = state.mapTiles[pos]!;
  tile.paths |= (1 << d1) | (1 << d2);

  // The old edge runs from `C+d` in direction `(d+2)%6` and from `C+(d+1)` in direction `(d+1+4)%6`;
  // each is replaced by the connection back to the flag (the opposite of the step).
  relinkNeighbor(state, pos, d1, (d1 + 2) % 6);
  relinkNeighbor(state, pos, d2, (d2 + 4) % 6);

  const restingByPos = indexRestingCarriers(state);
  const traceA = traceRoadCarriers(state, pos, d1, restingByPos);
  const traceB = traceRoadCarriers(state, pos, d2, restingByPos);
  if (traceA.farIdx === 0 || traceB.farIdx === 0) return; // Trace ins Nichts (defensiv)

  transferRoadSerfRequest(state, traceA, traceB);

  const flagIdx = tile.objIndex;
  const flag = state.flags[flagIdx];
  if (!flag) return;
  linkRoadHalf(state, flag, flagIdx, d1, traceA);
  linkRoadHalf(state, flag, flagIdx, d2, traceB);
}

/**
 * Rehang one of the two neighbour tiles: clear `oldDir` (the edge to the other neighbour tile), set
 * the connection to the flag, wake a carrier **resting** there and redirect a carrier **walking**
 * there to the new direction.
 *
 * The redirection (@0x4d59d ff.) tests the direction field `+0xe` in **two** encodings, raw on the
 * byte:
 * ```
 * if ((state == 2 || state == 3) && serf[0xe] == oldDir)  serf[0xe] = newDir;
 * else if (serf[0xe] == (byte)(oldDir - 6))               serf[0xe] = (byte)(newDir - 6);
 * ```
 * The second branch also runs for states 2/3 when the first comparison fails — taken verbatim.
 */
function relinkNeighbor(state: GameState, pos: number, step: Direction, oldDir: number): void {
  const geo = state.geo;
  const np = neighbor(pos, step, geo);
  const tile = state.mapTiles[np];
  if (tile === undefined) return;
  const newDir = oppositeDir(step); // == (oldDir+1)%6 for A, (oldDir-1+6)%6 for B

  tile.paths &= ~(1 << oldDir);
  tile.paths |= 1 << newDir;

  wakeCarrierOnPath(state, np);

  const si = tile.serfIndex;
  if (si === 0) return;
  const serf = state.serfs[si];
  if (!serf) return;
  const raw = serf.stateData[3]!; // field_0xe
  if ((serf.state === 2 || serf.state === 3) && raw === oldDir) {
    serf.stateData[3] = newDir;
  } else if (raw === ((oldDir - 6) & 0xff)) {
    serf.stateData[3] = (newDir - 6) & 0xff;
  }
}
