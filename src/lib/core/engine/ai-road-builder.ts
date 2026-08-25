/**
 * The AI's road builder (`FUN_000557b2` plus three helpers) - connects the flag or building it has
 * just placed to the road network: a 19x19 cost grid around the cursor, a Dijkstra variant for the
 * cheapest connections to all reachable own flags and possible flag sites, then lay the best one. It
 * can build several roads in one call.
 *
 * | Address | Role | here |
 * |---|---|---|
 * | `0x557b2` | frame: grid, search, selection, build loop | {@link aiBuildRoads} |
 * | `0x577d9` | classification of one grid cell | {@link classifyRoadCell} |
 * | `0x56f72` | lay the chosen road | {@link layRoad} |
 * | `0x57614` | fetch the path's top 3 bits and apply the step | {@link popPathDir} |
 *
 * Four things are not obvious:
 *
 * 1. The buffer offsets are a layout proof and therefore stand as constants: all five tables sit in
 *    one block and every boundary works out exactly. The 63 target slots are not a round number but
 *    follow from the two id counters (flags `0x40..0x4f`, sites `0x50..0x7e`).
 * 2. The path is a number in base 8, not an array: per step the direction is appended at the bottom as
 *    a digit 1..6, 64 bits => at most 21 steps, which is exactly the number of search rounds. It is
 *    read from the TOP, and for that the original shifts the path left by one first - `64 - 1 == 63 ==
 *    3*21`, and only then do the digits sit on the 3-bit boundaries. Without that shift one reads
 *    digits across the boundaries.
 * 3. Two places are original defects. The fourth water test of the boat-road chain loads its byte into
 *    one register and masks another, which is zero there, so the check has no effect. And the cost
 *    stamps for forester and farm compare a mask that KEEPS the owner bits, so they only ever stamp
 *    for player 0.
 * 4. `build` bit 4 is the boat-road order, and two independent places say so: in the cell classifier
 *    only a water tile is passable when the bit is set (and only that branch sets the productivity
 *    mark, so over land the ring walk dies immediately), and the road layer sets the endpoint bit
 *    `flag[4]` only when the bit is CLEAR - which is the bit the interactive road builder clears for
 *    boat roads.
 *
 * Without a counterpart here: the original marks tiles for redraw (our renderer redraws every frame)
 * and aliases the candidate list over the no-longer-needed cost grid.
 */
import type { Flag, GameState, Player } from './state.js';
import { DIR_DELTA, Direction, colOf, neighbor, oppositeDir, posOf, rowOf } from './position.js';
import {
  BUILD_FLAG,
  CURSOR_CLEAR,
  CURSOR_PATH,
  classifyBuildSite,
  buildFlagRecord,
  persistBuildSiteBits,
} from './build-site.js';
import { attachFlagToRoad } from './road-attach.js';
import { lengthToCategory } from './road-teardown.js';
import { linkRoadEnd } from './road-building.js';

// --- Grid geometry and buffer layout -------------------------------------------------------------

/** Edge length of the cost grid — from the cell strides `0x13`/`0x14` (@0x55911/@0x55939). */
export const RB_GRID_W = 19;
/** Cells of the grid. */
export const RB_GRID_CELLS = RB_GRID_W * RB_GRID_W; // 361
/** Centre cell == cursor (`mov $0xb4,%ax` @0x558c5). */
export const RB_GRID_CENTER = 180;
/** Rings the cell classification walks at most (`cmpw $0x8,0xc(%edi)` @0x55a4a). */
export const RB_MAX_RING = 8;

/** Smallest target id; `0x40..0x4f` are **existing flags** (`mov $0x40,%ax` @0x5589d). */
export const RB_ID_FLAG_BASE = 0x40;
/** `0x50..0x7e` are **possible flag sites** (`mov $0x50,%ax` @0x558ab). */
export const RB_ID_SITE_BASE = 0x50;
/** Upper bound of both counters; `0x7f` also marks the centre cell (`mov $0x7f,%al` @0x55a55). */
export const RB_ID_LIMIT = 0x7f;
/** Target slots == `0x7f - 0x40`; the buffer boundaries below work out exactly to it. */
export const RB_TARGETS = RB_ID_LIMIT - RB_ID_FLAG_BASE; // 63

/** The original's buffer offsets (`gs+0xbc`) — kept as evidence, see point 1 in the module head. */
export const RB_OFF_KIND = 0x000;
export const RB_OFF_POS = 0x16c;
export const RB_OFF_BEST = 0x710;
export const RB_OFF_PATH = 0x9e2;
export const RB_OFF_TARGET_COST = 0xbda;
export const RB_BUFFER_SIZE = 0xc5a;
/** Candidate list (overwrites the grid) and its path column (@0x56c75). */
export const RB_OFF_CANDIDATE_PATH = 0x100;

/** Capacity of **one** search queue in the original: 4000 B / 12 B per entry (`gs+0xb4`/`0xb8`). */
export const RB_QUEUE_CAPACITY = Math.floor(4000 / 12); // 333

/** Rounds of the search (`mov $0x15,%ax` @0x56077). */
export const RB_SEARCH_ROUNDS = 0x15;

/** Base cost per step (`addw $0x3` @0x560d0). */
export const RB_STEP_BASE = 3;
/** Surcharge on the six neighbours of the new flag (`addb $0x1e` @0x55a76). */
export const RB_CENTER_NEIGHBOUR_PENALTY = 0x1e;
/** Upper bound of all cost values — above it a cell counts as impassable (`cmpb $0x3f`). */
export const RB_COST_MAX = 0x3f;

/**
 * Ring order of the cell classification: **one** step to the right, then `ring+1` steps in each of
 * these six directions (@0x558d3…@0x55a37). The cell stride follows from it (`+1` Right, `+19` Down,
 * `-1` Left, `-20` UpLeft, `-19` Up, `+20` DownRight).
 */
export const RB_RING_DIRS: readonly Direction[] = [
  Direction.Down,
  Direction.Left,
  Direction.UpLeft,
  Direction.Up,
  Direction.Right,
  Direction.DownRight,
];

/** Cell stride of a direction in the 19-column grid. */
function cellStep(dir: Direction): number {
  const [dc, dr] = DIR_DELTA[dir];
  return dr * RB_GRID_W + dc;
}

// --- The two cost stamps (`0x56e98` / `0x56ec9`) -------------------------------------------------

/**
 * Hex distance in the original's skewed coordinates: equal signs => `max`, otherwise the sum. Here it
 * is only the **value law** of the two stamp tables, not a path metric.
 */
export function rbHexDistance(dx: number, dy: number): number {
  if (dx >= 0 === dy >= 0) return Math.max(Math.abs(dx), Math.abs(dy));
  return Math.abs(dx) + Math.abs(dy);
}

/**
 * Cost stamp of a working radius: `min(9, 10 - distance)` inside the radius, 0 outside.
 *
 * This is **not** derived but measured against both original tables: 218 of 218 bytes agree
 * (`0x56e98` 7x7 radius 3 = farm, `0x56ec9` 13x13 radius 6 = forester).
 */
export function rbStamp(width: number): Int8Array {
  const r = (width - 1) / 2;
  const out = new Int8Array(width * width);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const d = rbHexDistance(x - r, y - r);
      out[y * width + x] = d <= r ? Math.min(9, 10 - d) : 0;
    }
  }
  return out;
}

/** Farm (type 12, large building) — `lea 0x56e98` @0x55d0e, width 7 (`mov $0x7,%eax` @0x55d17). */
export const RB_STAMP_FARM_W = 7;
/** Forester (type 9, small building) — `lea 0x56ec9` @0x55c80, width 13 (`mov $0xd` @0x55c89). */
export const RB_STAMP_FORESTER_W = 13;

/** `(bld[4] & 0x3f)` of the forester (`cmpb $0x24` @0x55c61) — includes owner 0, see point 3b. */
export const RB_STAMP_FORESTER_KEY = 0x24;
/** `(bld[4] & 0x3f)` of the farm (`cmpb $0x30` @0x55cef). */
export const RB_STAMP_FARM_KEY = 0x30;

/**
 * Window in which the original searches for stamping buildings: grid coordinates **-6..24**, anchored
 * 15 tiles left/above the cursor (`subw $0xf` @0x55b6f) — grid coordinate 9 is the cursor, so
 * -6 == cursor-15.
 *
 * The two counters start at -6 (`mov $0xfffffffa,%eax` @0x55be5 and @0x55bf3) and the loop feet are
 * `addw $0x1,(%edi) ; cmpw $0x19,(%edi) ; jne 0x55bfa` (@0x55f22..@0x55f2a) and the same on
 * `0x4(%edi)` (@0x55f47..@0x55f51). That is an **equality abort**, not a `jb`: the body runs for all
 * counter values -6..24, i.e. **31** per axis, and 0x19 is the abort value.
 *
 * That the 24 is really needed hangs on the stamp's clipping test: a 13x13 forester stamp at
 * `gx = 24` has `x0 = 18` and still touches the 19x19 grid. With too short a window, foresters and
 * farms would not stamp 10-15 tiles right of and below the cursor, grid columns 13..18 would be up to
 * 9 too cheap, and the AI would lay roads through working areas.
 *
 * Written as the abort value rather than as a span so the `jne` convention stays visible in the code.
 */
export const RB_STAMP_SCAN_FROM = -6;
export const RB_STAMP_SCAN_END = 0x19; // abort on equality => -6..24, 31 values

/**
 * `DAT_00003fd7` (128 B, `gs+0xc8`): object byte `& 0x7f` -> class. The road builder rejects a tile
 * when the class is **> 1** (`cmpb $0x1` @0x57af9). Verbatim from the binary.
 */
export const RB_OBJECT_CLASS: readonly number[] = [
  0x00, 0x03, 0x04, 0x05, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
  0x02, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
  0x01, 0x00, 0x01, 0x01, 0x01, 0x01, 0x00, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0xff,
];

// --- State of one road-building round ------------------------------------------------------------

/** A path as a 64-bit number in base 8 (see point 2 in the module head). */
export interface RbPath {
  hi: number;
  lo: number;
}

interface RbQueueEntry {
  cost: number;
  cell: number;
  hi: number;
  lo: number;
}

/** The cost grid with its side tables — the five regions of the original buffer. */
export interface RbGrid {
 /** `[0x000]` cost or target id per cell; `0xff` == not scored. */
  readonly kind: Uint8Array;
 /** `[0x16c]` map position per cell. */
  readonly pos: Int32Array;
 /** `[0x710]` best cost so far per cell. */
  readonly best: Uint16Array;
 /** `[0xbda]` cost per target slot (`id - 0x40`). */
  readonly targetCost: Uint16Array;
 /** `[0x9e2]` path per target slot. */
  readonly targetHi: Uint32Array;
  readonly targetLo: Uint32Array;
 /** Peak fill level of a search queue — diagnostics against {@link RB_QUEUE_CAPACITY}. */
  peakQueue: number;
}

function createGrid(): RbGrid {
  return {
    kind: new Uint8Array(RB_GRID_CELLS).fill(0xff),
    pos: new Int32Array(RB_GRID_CELLS),
    best: new Uint16Array(RB_GRID_CELLS).fill(0xffff),
    targetCost: new Uint16Array(RB_TARGETS),
    targetHi: new Uint32Array(RB_TARGETS),
    targetLo: new Uint32Array(RB_TARGETS),
    peakQueue: 0,
  };
}

const u16 = (v: number): number => v & 0xffff;

// --- Phase 1a: classify one grid cell (`FUN_000577d9`) -------------------------------------------

/** Running id counters of the cell classification (`gs+0x24a` / `gs+0x24c`). */
interface RbIdCounters {
  flag: number;
  site: number;
}

/**
 * The terrain byte as the original reads it. It masks `landscape[2]` and treats **0 as water**
 * (terrain type <= 3 has bits 2/3 clear) — the same convention as the interactive road builder.
 */
function terrainByte(state: GameState, pos: number): number {
  const t = state.mapTiles[pos];
  return ((t.terrainUp & 0xf) << 4) | (t.terrainDown & 0xf);
}

/**
 * Boat-road test of the order mode (@0x578b0…@0x57935). Four checks in the original, the **fourth has
 * no effect** (point 3a in the module head) — it stands here as a comment in its place so the branch
 * does not count as overlooked.
 */
function waterPassable(state: GameState, pos: number, geo: GameState['geo']): boolean {
  if ((terrainByte(state, pos) & 0xcc) !== 0) return false; // @0x578bc
  const left = neighbor(pos, Direction.Left, geo);
  if ((terrainByte(state, left) & 0x0c) !== 0) return false; // @0x578ed
  const leftUp = neighbor(left, Direction.Up, geo);
  if ((terrainByte(state, leftUp) & 0xcc) !== 0) return false; // @0x57910
 // Fourth check @0x57931: `andb $0xc0,0x18(%edi)` on a register that is **0** from the test above —
 // the byte of the tile `leftUp + Right` lands in `vreg7` and is never checked.
  return true;
}

/** Owner bits of the tile as in the original: `(landscape[1] & 0x60) >> 5` with bit 7 as the gate. */
function ownedBy(state: GameState, pos: number, slot: number): boolean {
  return state.mapTiles[pos].owner === slot + 1;
}

/**
 * Classifies **one** grid cell (`FUN_000577d9`). Writes `grid.kind[cell]` and `grid.pos[cell]` and
 * returns `true` when the cell became passable — that is the signal with which the ring walk decides
 * whether to expand further outwards.
 */
export function classifyRoadCell(
  state: GameState,
  player: Player,
  grid: RbGrid,
  ids: RbIdCounters,
  cell: number,
  pos: number,
  ring: number,
): boolean {
  grid.pos[cell] = pos;
  const geo = state.geo;

 // Only score when **at least one** of the six neighbours is an ordinary cost value (six
 // `cmpb $0x40 ; jb` @0x577e3…@0x57823). Otherwise the cell stays `0xff`.
  const nb = [-1, -RB_GRID_W, -RB_GRID_W - 1, 1, RB_GRID_W, RB_GRID_W + 1];
  let reachable = false;
  for (const d of nb) {
    const i = cell + d;
    if (i >= 0 && i < RB_GRID_CELLS && grid.kind[i] < RB_ID_FLAG_BASE) {
      reachable = true;
      break;
    }
  }
  if (!reachable) return false;

  const tile = state.mapTiles[pos];
  if (tile.owner === 0) return false; // `jns 0x5815d` @0x57845 — unowned land
  if (!ownedBy(state, pos, player.slot)) return false; // @0x5785f

  const paths = tile.paths & 0x3f;
  const hasFlag = tile.object === 1;

  if (hasFlag) {
 // --- existing flag: record as a target unless the order filter excludes it
    let excluded = false;
    const mode = (player.aiRoadJob548 << 16) >> 16;
    if (mode < 0) {
 // @0x57cde: filtering happens only in a negative order mode.
      const flag = state.flags[tile.objIndex];
      let accept = false;
      if (mode !== -1 && flag && (flag.searchDir & 0xff) !== 0) accept = true; // @0x57d82/@0x57d8e
      if (!accept && flag && u16(flag.searchNum) === player.aiRoadJob550) excluded = true; // @0x57d9e
    }
    if (!excluded && ids.flag !== RB_ID_SITE_BASE) {
      grid.kind[cell] = ids.flag; // @0x57dc4
      ids.flag += 1;
    }
    return false;
  }

  if ((player.build & 0x10) !== 0) {
 // --- order mode (AI): only free tiles, plus boat roads and new flag sites
    if (paths !== 0) return false; // @0x57894
    if ((tile.object & 0x7f) !== 0) return false; // @0x578aa
    if (waterPassable(state, pos, geo)) {
      grid.kind[cell] = 2; // @0x57937
      return true;
    }
    if (ring > 2) {
 // @0x57951 `cmpw $0x3 ; jb` — flag sites only from ring 3 on. That is reachable only if the
 // rings got that far over **water**: this branch jumps to `0x5815d` and does **not** set the
 // productivity mark (@0x57ad8), see point 4 in the module head.
      const site = classifyBuildSite(state, player, colOf(pos, geo), rowOf(pos, geo));
      persistBuildSiteBits(player, site);
      if (
        (site.cursorType === CURSOR_CLEAR || site.cursorType === CURSOR_PATH) &&
        site.possibility === BUILD_FLAG &&
        !site.flagBlocked &&
        ids.site !== RB_ID_LIMIT
      ) {
        grid.kind[cell] = ids.site; // @0x57a1e
        ids.site += 1;
      }
    }
    return false;
  }

 // --- ordinary mode (no order): the grid carries terrain costs
  if ((tile.paths & 0x40) !== 0) return false; // `bt $0x6` @0x57ae7 — block marker
  const obj = tile.object & 0x7f;
  if (obj !== 0 && RB_OBJECT_CLASS[obj] > 1) return false; // @0x57af9

  if (paths !== 0) {
 // On an existing road: interesting only as a flag site, and only in a non-negative order mode
 // (`jns` @0x57b5e).
    if (((player.aiRoadJob548 << 16) >> 16) >= 0) {
      const site = classifyBuildSite(state, player, colOf(pos, geo), rowOf(pos, geo));
      persistBuildSiteBits(player, site);
      if (
        site.cursorType === CURSOR_PATH &&
        site.possibility === BUILD_FLAG &&
        !site.flagBlocked &&
        ids.site !== RB_ID_LIMIT
      ) {
        grid.kind[cell] = ids.site; // @0x57c8e
        ids.site += 1;
      }
    }
    return false;
  }

  const site = classifyBuildSite(state, player, colOf(pos, geo), rowOf(pos, geo));
  persistBuildSiteBits(player, site);
  if (site.cursorType < 5) {
    grid.kind[cell] = terrainCost(state, player, pos, geo); // LAB_00057f5e
  } else if (site.possibility < 2) {
    grid.kind[cell] = terrainCost(state, player, pos, geo); // @0x57f56 `jb LAB_00057f5e`
  } else if (site.possibility < 4) {
    grid.kind[cell] = site.possibility < 3 ? 0x14 : 3; // @0x5811d / @0x5812f
  } else {
    grid.kind[cell] = 0x14; // @0x58147
  }
  return true;
}

/**
 * Terrain base cost of a free tile (`LAB_00057f5e`): **0** if this tile and its UpLeft neighbour are
 * not water *and* the ring of six steps belongs entirely to us, **3** if only the water condition
 * holds, otherwise **4**.
 *
 * The water condition is the **marker in bit 7 of the `object` byte** (`cmpb ; jns` @0x57f66) — our
 * model does not carry it as a field because it is derivable from the terrain, so it is computed here.
 */
function terrainCost(
  state: GameState,
  player: Player,
  pos: number,
  geo: GameState['geo'],
): number {
  const water = (p: number): boolean => {
    const t = state.mapTiles[p];
    return t.terrainUp <= 3 || t.terrainDown <= 3;
  };
  if (water(pos)) return 4; // @0x58105
  const upLeft = neighbor(pos, Direction.UpLeft, geo);
  if (water(upLeft)) return 4; // @0x57f7a
 // Six steps from UpLeft: Right, DownRight, Down, Left, UpLeft (@0x57fa8…@0x580d1).
  let p = upLeft;
  if (!ownedBy(state, p, player.slot)) return 3;
  for (const d of [
    Direction.Right,
    Direction.DownRight,
    Direction.Down,
    Direction.Left,
    Direction.UpLeft,
  ]) {
    p = neighbor(p, d, geo);
    if (!ownedBy(state, p, player.slot)) return 3;
  }
  return 0; // @0x580f0
}

// --- Phase 1: build the cost grid ----------------------------------------------------------------

/**
 * Builds the 19x19 cost grid around the cursor: ring walk with early abort, surcharge on the six
 * neighbours of the new flag, then the cost stamps of the own foresters and farms.
 *
 * **The ring walk computes two of its six directions in 16 bits — and that is provably equivalent to
 * `neighbor()`.** It looks like a behavioural deviation ("from map size 6 on the carry is lost"), so
 * the reasoning stands here to keep the question from being asked twice. What the binary does:
 *
 * - right step: `addw $0x4,0x8(%edi)` @0x558fc, then `mov (%ebx),%ax` @0x55904 +
 * `and %ax,0x8(%edi)` @0x55907 — 16-bit addition **and** 16-bit masking.
 * - left step: `mov 0x60(%ebx),%ax` @0x55958 + `add %ax,0x8(%edi)` @0x5595c, then
 * `mov (%ebx),%ax` @0x55963 + `and %ax,0x8(%edi)` @0x55966 — likewise.
 * - the down step next to them is 32-bit (`mov 0xc(%ebx),%eax` @0x55927 + `add %eax,0x8(%edi)`
 * @0x5592a) — because its stride reaches the row bits and does not fit into 16 bits.
 *
 * Why the narrowing costs nothing, in three steps, all at the byte:
 *
 * 1. **The column stride lies entirely in the lower word.** `gs+0x60` arises as `(-4) & column mask`
 * (`subl $0x4,0xc(%edi)` @0x7cc4, `and %eax,0xc(%edi)` @0x7cca) and is stored as a **word**
 * (`mov %ax,0x60(%ebx)` @0x7cf2). On the largest map (size 8, 512 columns) that is `0x7fc`; the
 * right delta is `4`.
 * 2. **No carry can escape the lower word.** The packed position is
 * `((row << (column bits+1)) | column) << 2` — column in bits 2..10, **gap bit 11**, row from bit 12.
 * The gap bit is clear before every step (the previous masking does exactly that), so the lower word
 * is at most `0xf7fc`, and `0xf7fc + 0x7fc == 0xfff8` — bit 16 is never reached. The column's carry
 * lands in the gap bit, and the mask clears it.
 * 3. **Masking above bit 15 is a no-op.** The row bits reach up to bit
 * `column bits+2+row bits-1` (size 8: bit 19), and the mask has **all** bits set there; above that
 * the value never carries a bit. So the 16-bit masking leaves exactly what the 32-bit masking would.
 *
 * The narrowing is therefore not an original defect but a saving: `addw`/`andw` are equivalent here
 * because the gap bit lies **below** bit 16 (`column bits + 2 <= 11` for all eight map sizes).
 */
export function buildRoadGrid(state: GameState, player: Player): RbGrid {
  const geo = state.geo;
  const grid = createGrid();
  const ids: RbIdCounters = { flag: RB_ID_FLAG_BASE, site: RB_ID_SITE_BASE };

  const center = posOf(player.cursorCol, player.cursorRow, geo);
  grid.kind[RB_GRID_CENTER] = 0; // @0x558d0
  grid.pos[RB_GRID_CENTER] = center;

  let cell = RB_GRID_CENTER;
  let pos = center;
  for (let ring = 0; ring < RB_MAX_RING; ring++) {
    let productive = false;
 // One step right onto the start of the ring (@0x558d3).
    pos = neighbor(pos, Direction.Right, geo);
    cell += 1;
    for (const dir of RB_RING_DIRS) {
      const step = cellStep(dir);
      for (let i = 0; i <= ring; i++) {
        if (classifyRoadCell(state, player, grid, ids, cell, pos, ring)) productive = true;
        pos = neighbor(pos, dir, geo);
        cell += step;
      }
    }
    if (!productive) break; // `jns` @0x55a41 — a ring without a passable cell ends the walk
  }

 // Block the centre cell, make its six neighbours more expensive (@0x55a55…@0x55b50).
  grid.kind[RB_GRID_CENTER] = RB_ID_LIMIT;
  for (const off of [1, RB_GRID_W + 1, RB_GRID_W, -1, -RB_GRID_W - 1, -RB_GRID_W]) {
    const i = RB_GRID_CENTER + off;
    const v = grid.kind[i];
    if ((v << 24) >> 24 < 0) continue; // `jns` — `0xff` stays untouched
    const sum = v + RB_CENTER_NEIGHBOUR_PENALTY;
    grid.kind[i] = sum > RB_COST_MAX ? RB_COST_MAX : sum;
  }

  applyWorkAreaStamps(state, player, grid);
  return grid;
}

/**
 * Stamps the working areas of the own foresters (13x13) and farms (7x7) additively into the grid
 * (@0x55be5…@0x55f51). Takes effect **only for player 0** — see point 3b in the module head.
 */
function applyWorkAreaStamps(state: GameState, player: Player, grid: RbGrid): void {
  const geo = state.geo;
  const forester = rbStamp(RB_STAMP_FORESTER_W);
  const farm = rbStamp(RB_STAMP_FARM_W);
  const anchor = posOf(player.cursorCol - 0xf, player.cursorRow - 0xf, geo);

  let rowPos = anchor;
  for (let gy = RB_STAMP_SCAN_FROM; gy !== RB_STAMP_SCAN_END; gy++) {
    let pos = rowPos;
    for (let gx = RB_STAMP_SCAN_FROM; gx !== RB_STAMP_SCAN_END; gx++) {
      const tile = state.mapTiles[pos];
      const object = tile.object & 0x7f;
      if (object === 2 || object === 3) {
        const bld = state.buildings[tile.objIndex];
        if (bld) {
 // Raw byte `bld[4]` reproduced: owner in bits 0/1, type from bit 2.
          const raw = (bld.owner & 3) | ((bld.type & 0x1f) << 2);
          const key = object === 2 ? RB_STAMP_FORESTER_KEY : RB_STAMP_FARM_KEY;
          if ((raw & 0x3f) === key && (raw & 3) === player.slot) {
            stampAt(grid, gx, gy, object === 2 ? forester : farm, object === 2 ? 13 : 7);
          }
        }
      }
      pos = neighbor(pos, Direction.Right, geo);
    }
    rowPos = neighbor(rowPos, Direction.Down, geo);
  }
}

/**
 * Applies a stamp centred at `(gx,gy)` in grid coordinates — clipped to the grid (`FUN_00055d1f`, the
 * four boundary tests @0x55d47…@0x55d9c). Adds only onto cells that carry a cost value (`< 0x40`) and
 * clamps at `0x3f`.
 */
function stampAt(grid: RbGrid, gx: number, gy: number, stamp: Int8Array, width: number): void {
  const r = (width - 1) / 2;
  let x0 = gx - r;
  let y0 = gy - r;
  let x1 = gx + r;
  let y1 = gy + r;
  let sx = 0;
  let sy = 0;
  if (x0 < 0) {
    sx = -x0;
    x0 = 0;
  }
  if (y0 < 0) {
    sy = -y0;
    y0 = 0;
  }
  if (x1 > RB_GRID_W - 1) x1 = RB_GRID_W - 1;
  if (y1 > RB_GRID_W - 1) y1 = RB_GRID_W - 1;
  if (x0 > RB_GRID_W - 1 || y0 > RB_GRID_W - 1 || x1 < 0 || y1 < 0) return;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cell = y * RB_GRID_W + x;
      const v = grid.kind[cell];
      if (v >= RB_ID_FLAG_BASE) continue; // `cmpb $0x40 ; jae` @0x55de9
      const sum = v + stamp[(y - y0 + sy) * width + (x - x0 + sx)];
      grid.kind[cell] = sum > RB_COST_MAX ? RB_COST_MAX : sum;
    }
  }
}

// --- Phase 2: the search (`@0x55f5b`…`@0x56c2f`) -------------------------------------------------

/** Slope surcharge of a step: `|dh| <= 1` => 0, 2 => +1, 3 => +3, from 4 => +8 (@0x561ac…@0x561cb). */
export function rbSlopePenalty(dh: number): number {
  const d = Math.abs(dh);
  if (d < 2) return 0;
  if (d === 2) return 1;
  if (d === 3) return 3;
  return 8;
}

/** Append a direction digit at the bottom of the path (digits 1..6). */
function appendDir(hi: number, lo: number, dirCode: number): RbPath {
  return {
    hi: (((hi << 3) | (lo >>> 29)) >>> 0) as number,
    lo: (((lo << 3) >>> 0) + dirCode) >>> 0,
  };
}

/**
 * Runs the search. Two queues in alternation (`gs+0xb4`/`gs+0xb8`, switch `gs+0x270`), at most
 * {@link RB_SEARCH_ROUNDS} rounds, aborting as soon as a round enqueues nothing.
 */
export function runRoadSearch(state: GameState, grid: RbGrid): void {
  let current: RbQueueEntry[] = [{ cost: 0xffff, cell: RB_GRID_CENTER, hi: 0, lo: 0 }];
  let rounds = RB_SEARCH_ROUNDS;

  for (;;) {
    const next: RbQueueEntry[] = [];
    for (const entry of current) {
 // Skip orphaned entries: only one that is still the best of its cell expands
 // (`cmp ; jne` @0x560cb).
      if (entry.cost !== grid.best[entry.cell]) continue;
      const cost = u16(entry.cost + RB_STEP_BASE); // @0x560d0 — the start (0xffff) becomes 2
      const shifted = appendDir(entry.hi, entry.lo, 0);

      for (let dir = 0; dir < 6; dir++) {
        const step = cellStep(dir as Direction);
        const nbCell = entry.cell + step;
        if (nbCell < 0 || nbCell >= RB_GRID_CELLS) continue;
        const kind = grid.kind[nbCell];
        if (kind >= RB_ID_LIMIT) continue; // `cmpb $0x7f ; jae`
        if (cost >= grid.best[nbCell]) continue; // `jae`
        const here = grid.pos[entry.cell];
        const there = grid.pos[nbCell];
        const dh = (state.mapTiles[there].height & 0x1f) - (state.mapTiles[here].height & 0x1f);
        const newCost = u16(u16(cost + kind) + rbSlopePenalty(dh));
        if (newCost >= grid.best[nbCell]) continue; // @0x561d5
        grid.best[nbCell] = newCost;
        const path = appendDir(shifted.hi, shifted.lo, dir + 1);
        if (kind < RB_ID_FLAG_BASE) {
          next.push({ cost: newCost, cell: nbCell, hi: path.hi, lo: path.lo });
        } else {
          const slot = kind - RB_ID_FLAG_BASE;
          grid.targetCost[slot] = newCost;
          grid.targetHi[slot] = path.hi;
          grid.targetLo[slot] = path.lo;
        }
      }
    }
    if (next.length > grid.peakQueue) grid.peakQueue = next.length;
    rounds -= 1;
    if (rounds === 0 || next.length === 0) break;
    current = next;
  }
}

// --- Phase 3: the candidate list (`@0x56c44`…`@0x56d1f`) -----------------------------------------

/** One entry of the candidate list: scored cost, "needs a new flag", path. */
export interface RbCandidate {
  cost: number;
  needsFlag: boolean;
  hi: number;
  lo: number;
}

/**
 * Compacts the 63 target slots into the candidate list.
 *
 * **Two peculiarities, both evidenced at the byte:** the target **id** is subtracted from the cost
 * (`sub %ax,(%edi)` @0x56ca0 with `ax` == the running id `0x40..0x7e`), so later targets get a
 * discount; and a target that first needs a **new flag** (id >= `0x50`) becomes half as expensive
 * again (`shrw $1` + `add` @0x56cb1).
 */
export function collectRoadCandidates(grid: RbGrid): RbCandidate[] {
  const out: RbCandidate[] = [];
  for (let slot = 0; slot < RB_TARGETS; slot++) {
    const raw = grid.targetCost[slot];
    if (raw === 0) continue; // `je` @0x56c92
    const id = RB_ID_FLAG_BASE + slot;
    let cost = u16(raw - id);
    let needsFlag = false;
    if (id >= RB_ID_SITE_BASE) {
      cost = u16(cost + (cost >>> 1));
      needsFlag = true;
    }
    out.push({ cost, needsFlag, hi: grid.targetHi[slot], lo: grid.targetLo[slot] });
  }
  return out;
}

// --- Path arithmetic (`FUN_00057614` / `FUN_00061ad2`) -------------------------------------------

/** Shift the 64-bit path left by 1 — the alignment from point 2 in the module head. */
export function rbAlignPath(path: RbPath): RbPath {
  return {
    hi: (((path.hi << 1) | (path.lo >>> 31)) >>> 0) as number,
    lo: (path.lo << 1) >>> 0,
  };
}

/**
 * Counts the steps of a path (@0x56dd0…@0x56e03). The original shifts the path once unobserved and
 * then in groups of three until a 1 falls out at the top; the counter starts at `0x16` == 21 + 1. The
 * three-fold unrolling absorbs the bit length of the top digit, which is why the result is **exactly**
 * the step count.
 */
export function pathSteps(path: RbPath): number {
  let { hi, lo } = path;
  const shift = (): boolean => {
    const carry = (hi & 0x80000000) !== 0;
    hi = (((hi << 1) | (lo >>> 31)) >>> 0) as number;
    lo = (lo << 1) >>> 0;
    return carry;
  };
  shift(); // @0x56dd0 — first step without a check
  let counter = 0x16;
 // The original has no abort condition: on an **empty** path it loops forever. The case is
 // unreachable (a candidate carries cost > 0, hence at least one step); the bound of 64 here is more
 // than twice the 22 rounds the original ever needs.
  for (let guard = 0; guard < 64; guard++) {
    counter -= 1;
    if (shift()) return u16(counter);
    if (shift()) return u16(counter);
    if (shift()) return u16(counter);
  }
  return u16(counter);
}

/**
 * Fetches the top direction digit from the path and applies the step (`FUN_00057614`). Returns `dir`
 * and `last` == "that was the final digit". Leading zero groups are skipped (`je 0x57614` @0x57671).
 */
export function popPathDir(path: RbPath): { dir: Direction; last: boolean } | null {
  for (;;) {
    if (path.hi === 0 && path.lo === 0) return null; // an endless loop in the original
    let digit = 0;
    for (let bit = 4; bit >= 1; bit >>= 1) {
      if ((path.hi & 0x80000000) !== 0) digit += bit;
      path.hi = (((path.hi << 1) | (path.lo >>> 31)) >>> 0) as number;
      path.lo = (path.lo << 1) >>> 0;
    }
    if (digit === 0) continue;
    return { dir: (digit - 1) as Direction, last: path.hi === 0 && path.lo === 0 };
  }
}

// --- Phase 4a: lay the road (`FUN_00056f72`) -----------------------------------------------------

/**
 * Lays the chosen road. Returns `-1` on failure (the original sets `vreg7 = -1` and leaves the sign in
 * the flag — the caller tests with `js`), otherwise 0.
 *
 * Three sections: (1) **pre-walk** the path and abort if any intermediate tile already carries roads;
 * (2) if required, build a **new flag** at the target; (3) lay the road bits and link both flags.
 */
export function layRoad(
  state: GameState,
  player: Player,
  path: RbPath,
  needsFlag: boolean,
  chosenCost: number,
): number {
  const geo = state.geo;
  const start = posOf(player.cursorCol, player.cursorRow, geo);

 // (1) Pre-walk — @0x56ff6. **The order is semantics**: the `js` @0x56ffd stands *before* the road
 // test @0x5700a, and `FUN_00057614` reports exhaustion only after applying the step. The **last**
 // tile is therefore never tested — it is the target flag and naturally carries roads. A port that
 // tests it too never lays a road.
  const walk = rbAlignPath(path);
  let probe = start;
  for (;;) {
    const step = popPathDir(walk);
    if (!step) break;
    probe = neighbor(probe, step.dir, geo);
    if (step.last) break; // `js 0x5701b` @0x56ffd
    if ((state.mapTiles[probe].paths & 0x3f) !== 0) return -1; // @0x57010
  }
  const endPos = probe;

 // (2) New flag at the target — @0x5709e.
  if (needsFlag) {
    const savedCol = player.cursorCol;
    const savedRow = player.cursorRow;
    const col = colOf(endPos, geo);
    const row = rowOf(endPos, geo);
    const site = classifyBuildSite(state, player, col, row);
    persistBuildSiteBits(player, site);
    let ok = false;
    if (site.cursorType === CURSOR_PATH) {
 // @0x57112: an ordinary flag on an existing road.
      if (site.possibility !== 0 && !site.flagBlocked) {
        buildFlagRecord(state, player, col, row, site.cursorType);
        ok = true;
      }
    } else if (
      (player.build & 0x10) !== 0 &&
      site.cursorType === CURSOR_CLEAR &&
      site.possibility !== 0 &&
      !site.flagBlocked
    ) {
 // @0x57155: in order mode the flag may also go into the open and is attached to existing roads
 // right away.
      buildFlagRecord(state, player, col, row, site.cursorType);
      attachFlagToRoad(state, col, row);
      ok = true;
    }
    player.cursorCol = savedCol;
    player.cursorRow = savedRow;
    if (!ok) return -1; // LAB_000571bb
  }

 // (3) Order bookkeeping — @0x57266.
  const mode = (player.aiRoadJob548 << 16) >> 16;
  if (mode <= 0) {
    if (player.aiRoadJob570 === 0) {
      const doubled = u16(chosenCost + chosenCost);
      player.aiRoadJob570 = doubled > 0x45 ? 0x46 : doubled; // @0x5729b
    }
    if (player.aiRoadJob540 === 0) player.aiRoadJob540 = player.aiRoadJob552; // @0x57302
  } else {
    player.aiRoadJob548 = u16(player.aiRoadJob548 - 1); // @0x5727f
    if (player.aiRoadJob548 === 0) {
      player.aiRoadJob570 = 0x46; // @0x57294
      player.aiRoadJob540 = 10; // @0x572a2
    }
  }

 // (4) Lay the road bits — @0x57320.
  const lay = rbAlignPath(path);
  const startFlagIdx = state.mapTiles[start].objIndex;
  let prev = start;
  let steps = 0;
  let firstDir: Direction | null = null;
  let lastBackDir: Direction = Direction.Right;
  for (;;) {
    const step = popPathDir(lay);
    if (!step) break;
    const here = neighbor(prev, step.dir, geo);
    if (firstDir === null) firstDir = step.dir;
    steps += 1;
    state.mapTiles[prev].paths |= 1 << step.dir; // @0x57346
    const back = oppositeDir(step.dir);
    state.mapTiles[here].paths |= 1 << back; // @0x57373
    lastBackDir = back;
    prev = here;
    if (step.last) break;
  }
  if (firstDir === null) return -1; // empty path — unreachable in the original (cost > 0)

 // (5) Link both flags — @0x57410…@0x5759c.
  const endFlagIdx = state.mapTiles[prev].objIndex;
  const a: Flag | null = state.flags[startFlagIdx] ?? null;
  const b: Flag | null = state.flags[endFlagIdx] ?? null;
  if (!a || !b) return -1;
  const category = lengthToCategory(steps);
  const endpoint = (player.build & 0x10) === 0; // `bt $0x4` @0x574ad — see point 4 in the module head
  linkRoadEnd(a, firstDir, b.index, lastBackDir, !endpoint, category);
  linkRoadEnd(b, lastBackDir, a.index, firstDir, !endpoint, category);
  return 0;
}

// --- Phase 4: the frame (`FUN_000557b2`) ---------------------------------------------------------

/**
 * **Entry point.** Builds as many roads as the order block's two thresholds allow and returns
 * `player.aiRoadJob542` — the field by which the executor recognises whether a road was laid.
 */
export function aiBuildRoads(state: GameState, player: Player): number {
  const grid = buildRoadGrid(state, player);
  runRoadSearch(state, grid);
  const candidates = collectRoadCandidates(grid);

  for (;;) {
 // Find the smallest candidate; zeroed entries are used up (@0x56d45).
    let best = -1;
    let bestCost = 0xffff;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.cost === 0) continue;
      if (c.cost < bestCost) {
        bestCost = c.cost;
        best = i;
      }
    }
    if (best < 0) return player.aiRoadJob542; // `js 0x56e8a`
 // Upper bound: `aiRoadJob570` (`jae 0x56e8a` @0x56da7).
    if (player.aiRoadJob570 !== 0 && bestCost >= player.aiRoadJob570) return player.aiRoadJob542;

    const chosen = candidates[best];
 // Detour test: `aiRoadJob540` times the step count (@0x56db0…@0x56e22).
    if (player.aiRoadJob540 !== 0) {
      const steps = pathSteps({ hi: chosen.hi, lo: chosen.lo });
      if (u16(player.aiRoadJob540 * steps) <= bestCost) {
        chosen.cost = 0; // @0x56e24 — discard the candidate and choose again
        continue;
      }
    }

    chosen.cost = 0; // @0x56e40
    const rc = layRoad(state, player, { hi: chosen.hi, lo: chosen.lo }, chosen.needsFlag, bestCost);
    if (rc >= 0) player.aiRoadJob542 = 0; // @0x56e78
  }
}
