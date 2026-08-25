/**
 * **Interactive road building** — port of the five original routines.
 *
 * | Original | here |
 * |---|---|
 * | mode entry @0x2860d (from `control_bar_slot_click` @0x27490, icon 0x18/0x08) | {@link beginRoadBuilding} |
 * | direction/marker pass **@0x32d49** | {@link updateRoadMarkers} |
 * | click branch @0x2a63c in `FUN_00029e16` | {@link roadBuildingClick} |
 * | commit `FUN_0002b542` | {@link commitRoad} |
 * | `cancel_road_building` `FUN_000286dc` | {@link cancelRoadBuilding} |
 *
 * **Careful with the addresses:** `FUN_0003205d` is **not** the marker pass but a dispatcher —
 * `bt $0x7,%ax` on `vp[1]` jumps to 0x32d49 when the bit is set, and the fall-through 0x32075 is
 * {@link classifyBuildSite}. Likewise `FUN_0002b542` is **not** `link_road_half` (that is the split
 * variant in `road-split.ts`, which inherits from a distant flag) — the commit writes the flag fields
 * itself.
 *
 * **The provisional road lives in the real map bits.** The original sets `landscape[a][0] |= 1<<dir`
 * and `landscape[b][0] |= 1<<opposite` per segment (@0x2acfb/@0x2ad15), so the ordinary renderer draws
 * the half-finished road with no special path and the abort clears the bits again. A separate buffer
 * would force both renderer and abort to be built differently.
 *
 * **`gs+0x37e` bit 6** (the extra `road_bounded_by_flags` check on a neighbour that carries paths,
 * @0x330e1) is set **only in two-player split screen**: @0x4fdfd clears it, @0x4fe38 sets it only when
 * the player count is < 3 **and** `gs+0x37e` bit 0 is set. In a single-player game it is clear, hence
 * {@link RoadBuildOptions.splitscreen} defaults to `false`.
 */
import type { GameState, Player, Flag, RoadBuildingState } from './state.js';
import { MARKER_NONE } from './state.js';
import { posOf, neighbor, oppositeDir, Direction, type MapGeometry } from './position.js';
import {
  classifyBuildSite,
  buildFlag,
  OBJECT_CLASS,
  CLASS_FLAG,
  CLASS_SMALL_BUILDING,
  CURSOR_FLAG,
  CURSOR_REMOVABLE_FLAG,
} from './build-site.js';
import { isRoadSegmentClearable, lengthToCategory } from './road-teardown.js';

// --- State (the original's `vp` fields) ----------------------------------------------------------

/**
 * The road-building session lives in the **game state** (`GameState.roadBuild[slot]`, see
 * {@link RoadBuildingState}) rather than in the UI layer — only there can a single click be expressed
 * as a command and thus be logged. The functions here fetch it through {@link roadSession}.
 */
export type { RoadBuildingState } from './state.js';
export { createRoadBuildingState } from './state.js';

/** The road-building session of one player (the `vp` of their viewport). */
export function roadSession(state: GameState, player: Player): RoadBuildingState {
  return state.roadBuild[player.slot]!;
}

/** Options that come from global game-mode bits in the original. */
export interface RoadBuildOptions {
  /** `vp[1]` bit 3 — special click (right mouse button). */
  readonly special?: boolean;
  /** `gs+0x37e` bit 6 — set only in two-player split screen (see the module head). */
  readonly splitscreen?: boolean;
}

/**
 * Object class 2 = large obstacle (stones/rocks). `build-site.ts` exports no constant for it; the
 * marker pass tests it directly (`cmpb $0x2` @0x32edc).
 */
const CLASS_LARGE_OBSTACLE = 2;

/** The "show nothing" marker — `mov $0x21,%ax` @0x28742 ff (six times in the abort). */
export { MARKER_NONE } from './state.js';
/** The "not here" marker — `mov $0x2c,%eax` @0x33168. */
export const MARKER_BLOCKED = 0x2c;
/** The "back" marker — `mov $0x2d,%eax` @0x32ea7 (a direction whose path bit is already set). */
export const MARKER_BACKSTEP = 0x2d;
/** Slope marker base — `addw $0x27` @0x33154; index = `0x27 + (neighbour height - cursor height)`. */
export const MARKER_SLOPE_BASE = 0x27;

/** Click sounds (`play_ui_sound` `FUN_0003688a`). */
export const SOUND_ROAD_DONE = 2;
export const SOUND_REJECT = 4;
export const SOUND_EDGE_SCROLL = 6;
export const SOUND_SEGMENT = 8;

/** Panel icons on entering (@0x2865b ff) and on leaving (@0x286f9 ff, from slot 2). */
export const ROAD_BAR_ICONS_ENTER = [0x18, 0x00, 0x09, 0x0b, 0x0d] as const;
export const ROAD_BAR_ICONS_LEAVE = [0x0a, 0x0c, 0x0e] as const;

// --- 1. Mode entry (@0x2860d) --------------------------------------------------------------------

/**
 * **Start road building** — @0x2860d, reached from `control_bar_slot_click` @0x27490 on icon
 * **0x18 or 0x08** with `vp[1]` bit 6 clear. (With bit 6 set the button jumps to 0x286dc =
 * {@link cancelRoadBuilding} instead, so it is a toggle.)
 *
 * ```
 * vp[0] &= ~0x40                                   @0x28615
 * call classify_build_site                         @0x2862f
 * if (player[0x100] != 1 && player[0x100] != 2) { call 0x331a7 ; ret }   @0x28637/@0x28643
 * vp[0x60..0x64] = 18 00 09 0b 0d                  @0x2865b ff
 * vp[1] |= 0x40 ; |= 0x80 ; |= 0x04                @0x2869a/@0x286ae/@0x286c2
 * vp[0xce] = 0                                     @0x286d4
 * ```
 *
 * Returns `false` when the cursor is not on a flag (@0x2864c then takes the branch 0x331a7, which
 * with `gs+0x37e` bit 5 only sets the panel icons — pure display, no effect here).
 */
export function beginRoadBuilding(state: GameState, player: Player): boolean {
  const rb = roadSession(state, player);
  const site = classifyBuildSite(state, player, player.cursorCol, player.cursorRow);
  if (site.cursorType !== CURSOR_FLAG && site.cursorType !== CURSOR_REMOVABLE_FLAG) return false;
  rb.active = true;
  rb.segments = 0;
  rb.allowedMask = 0;
  return true;
}

// --- 2. Allowed directions and markers (@0x32d49) ------------------------------------------------

/**
 * **The six neighbour markers and the mask of allowed directions** — @0x32d49, the bit-7 branch of the
 * dispatcher `FUN_0003205d`.
 *
 * Per direction, in exactly this order:
 * 1. **Owner**, raw at the byte: `(landscape[np][1] & 0xe0) != (playerIndex+4)<<5` =>
 *    {@link MARKER_BLOCKED} (@0x32e84/@0x32e92). Equivalence to the decoded `owner` comparison is
 *    measured (159744 tiles, no counterexample).
 * 2. **Back step**: if path bit `dir` is already set at the **cursor** => {@link MARKER_BACKSTEP} and
 *    **allowed** (@0x32e9c -> @0x32ea7). The cursor bits are read only once a segment stands
 *    (`vp[0xce] != 0`, @0x32e4a) — otherwise the start flag's real roads would count.
 * 3. `OBJECT_CLASS[obj]`: 2 or 4 => blocked, 3 => allowed (@0x32edc ff).
 * 4. Neighbour **without** paths => allowed (@0x32f02).
 * 5. Neighbour **with** paths => classify there (@0x33013): `player[3]` bit 1 set or
 *    `player[0x101] < 1` => blocked; otherwise, with `gs+0x37e` bit 6, also `road_bounded_by_flags`.
 *
 * Allowed => marker `0x27 + (neighbour height - cursor height)` (@0x3313e) and `mask |= 1<<dir`.
 */
export function updateRoadMarkers(
  state: GameState,
  player: Player,
  opts: RoadBuildOptions = {},
): void {
  const rb = roadSession(state, player);
  const geo = state.geo;
  const cursor = posOf(player.cursorCol, player.cursorRow, geo);
  const cursorTile = state.mapTiles[cursor];
  const cursorHeight = cursorTile.height & 0x1f;
  // `vp[0xce] != 0` — before the first segment the back-step mask stays empty (@0x32e4a).
  const cursorPaths = rb.segments !== 0 ? cursorTile.paths & 0x3f : 0;
  let mask = 0;

  for (let dir = 0; dir < 6; dir++) {
    const np = neighbor(cursor, dir as Direction, geo);
    const tile = state.mapTiles[np];
    if (tile.owner !== player.slot + 1) {
      rb.markers[dir] = MARKER_BLOCKED;
      continue;
    }
    if ((cursorPaths & (1 << dir)) !== 0) {
      rb.markers[dir] = MARKER_BACKSTEP;
      mask |= 1 << dir;
      continue;
    }
    if (!neighbourAllowed(state, player, np, opts)) {
      rb.markers[dir] = MARKER_BLOCKED;
      continue;
    }
    rb.markers[dir] = (MARKER_SLOPE_BASE + ((tile.height & 0x1f) - cursorHeight)) & 0xffff;
    mask |= 1 << dir;
  }
  rb.allowedMask = mask;
}

/** Steps 3..5 of the marker pass (@0x32ec1..@0x3313c) for one neighbour tile. */
function neighbourAllowed(
  state: GameState,
  player: Player,
  np: number,
  opts: RoadBuildOptions,
): boolean {
  const geo = state.geo;
  const tile = state.mapTiles[np];
  const cls = OBJECT_CLASS[tile.object & 0x7f];
  if (cls === CLASS_LARGE_OBSTACLE || cls === CLASS_SMALL_BUILDING) return false; // `cmpb $0x2/$0x4`
  if (cls === CLASS_FLAG) return true; // `cmpb $0x3` @0x32ef0
  if ((tile.paths & 0x3f) === 0) return true; // @0x32f02
  const col = colOfPos(np, geo);
  const row = rowOfPos(np, geo);
  const site = classifyBuildSite(state, player, col, row);
  if (site.flagBlocked) return false; // `player[3]` Bit 1 @0x330b8
  if (site.possibility < 1) return false; // `cmpb $0x1 ; jb` @0x330cc
  if (!opts.splitscreen) return true; // `gs+0x37e` Bit 6 @0x330e1
  return isRoadSegmentClearable(state, col, row); // `call 0x2b203 ; js` @0x33117
}

// --- 3. Click (@0x2a63c) -------------------------------------------------------------------------

/** What the click did — the caller turns this into sound and edge scrolling. */
export interface RoadClickResult {
  /** `play_ui_sound` index, or `null` where the original plays no sound (a no-op direction). */
  readonly sound: number | null;
  /** The road was completed (the mode has ended). */
  readonly finished: boolean;
  /** Edge-scroll mask for `vp+0xd8` (1 left, 2 right, 4 up, 8 down). */
  readonly edgeScroll: number;
}

const NO_OP: RoadClickResult = { sound: null, finished: false, edgeScroll: 0 };

/**
 * **Click on the map in road-building mode** — the `vp[1]` bit-7 branch @0x2a63c of `FUN_00029e16`
 * (inlined identically in `panel_click_dispatch`).
 *
 * The direction comes from the cursor deltas (@0x2a684 ff,
 * `dc = (clickCol - cursorCol + 1) & colMask`): `(0,1)->3 · (0,0)->4 · (1,2)->2 · (1,0)->5 · (2,1)->0
 * · (2,2)->1`; anything else is a no-op (`jne 0x2ae59`, no sound).
 *
 * Then:
 * - direction not in `vp[0xd0]` => sound **4** (@0x2a74a).
 * - path bit at the cursor already set => **back step**: `vp[0xce]--`, clear both bits, sound **8**
 *   (@0x2ac9a).
 * - target **without** paths: on a special click possibly build a flag (@0x2aa7f); if a flag stands
 *   afterwards, **commit** — otherwise `vp[0xce]++`, set both bits, sound **8** (@0x2ace9).
 * - target **with** paths: a flag => commit; otherwise only a special click that passes the checks
 *   builds a flag and commits, else sound **4** (@0x2a838 ff).
 * - a successful commit => the **last two** path bits are set by the caller here (@0x2ac50/@0x2ac6a),
 *   then `vp[0xce] = 0`, sound **2** and {@link cancelRoadBuilding} (@0x2ac95).
 *
 * In every non-rejected case the cursor follows to the clicked tile (@0x2ad36).
 */
export function roadBuildingClick(
  state: GameState,
  player: Player,
  col: number,
  row: number,
  opts: RoadBuildOptions = {},
): RoadClickResult {
  const rb = roadSession(state, player);
  const geo = state.geo;
  const dir = clickDirection(player, col, row, geo);
  if (dir < 0) return NO_OP;

  if ((rb.allowedMask & (1 << dir)) === 0) return { sound: SOUND_REJECT, finished: false, edgeScroll: 0 };

  const cursorPos = posOf(player.cursorCol, player.cursorRow, geo);
  const clickPos = posOf(col, row, geo);
  const revDir = oppositeDir(dir as Direction);

  // Back step — `bt %cx,%ax ; jne 0x2ac9a` @0x2a7f9.
  if ((state.mapTiles[cursorPos].paths & (1 << dir)) !== 0) {
    rb.segments -= 1;
    state.mapTiles[cursorPos].paths &= ~(1 << dir) & 0xff;
    state.mapTiles[clickPos].paths &= ~(1 << revDir) & 0xff;
    return finishClick(state, player, col, row, SOUND_SEGMENT, false);
  }

  const target = state.mapTiles[clickPos];
  if ((target.paths & 0x3f) !== 0) {
    // Target tile with paths (@0x2a81e).
    if (target.object !== 1) {
      if (!opts.special) return { sound: SOUND_REJECT, finished: false, edgeScroll: 0 };
      const site = classifyBuildSite(state, player, col, row);
      if (site.possibility < 1 || site.flagBlocked) {
        return { sound: SOUND_REJECT, finished: false, edgeScroll: 0 };
      }
      if (!isRoadSegmentClearable(state, col, row)) {
        return { sound: SOUND_REJECT, finished: false, edgeScroll: 0 };
      }
      buildFlag(state, player, col, row); // `call 0x2899f` @0x2a946
    }
  } else if (opts.special) {
    // Target tile without paths plus a special click => try a flag (@0x2aa7f); failure is harmless.
    const site = classifyBuildSite(state, player, col, row);
    if (site.possibility >= 1 && !site.flagBlocked) buildFlag(state, player, col, row);
  }

  if (state.mapTiles[clickPos].object === 1) {
    // Flag reached => commit (@0x2abf4/@0x2ac0e).
    if (!commitRoad(state, player, clickPos, dir as Direction, rb.segments)) {
      cancelRoadBuilding(state, player);
      return { sound: SOUND_REJECT, finished: false, edgeScroll: 0 };
    }
    state.mapTiles[cursorPos].paths |= 1 << dir; // @0x2ac50
    state.mapTiles[clickPos].paths |= 1 << revDir; // @0x2ac6a
    rb.segments = 0;
    player.cursorCol = col;
    player.cursorRow = row;
    cancelRoadBuilding(state, player);
    return { sound: SOUND_ROAD_DONE, finished: true, edgeScroll: 0 };
  }

  // Place a segment (@0x2ace9).
  rb.segments += 1;
  state.mapTiles[cursorPos].paths |= 1 << dir;
  state.mapTiles[clickPos].paths |= 1 << revDir;
  return finishClick(state, player, col, row, SOUND_SEGMENT, false);
}

/** The shared tail @0x2ad36: move the cursor, recompute the markers, report the edge scroll. */
function finishClick(
  state: GameState,
  player: Player,
  col: number,
  row: number,
  sound: number,
  finished: boolean,
): RoadClickResult {
  player.cursorCol = col;
  player.cursorRow = row;
  updateRoadMarkers(state, player);
  return { sound, finished, edgeScroll: 0 };
}

/**
 * Click delta -> direction (@0x2a684..@0x2a71a). The six valid pairs are exactly the hex neighbours;
 * any other delta is a no-op (`-1`).
 */
function clickDirection(player: Player, col: number, row: number, geo: MapGeometry): number {
  const dc = (col - player.cursorCol + 1) & (geo.cols - 1);
  const dr = (row - player.cursorRow + 1) & (geo.rows - 1);
  if (dc === 0) return dr === 1 ? 3 : dr === 0 ? 4 : -1;
  if (dc === 1) return dr === 2 ? 2 : dr === 0 ? 5 : -1;
  if (dc === 2) return dr === 1 ? 0 : dr === 2 ? 1 : -1;
  return -1;
}

/**
 * Edge scrolling of the click tail (@0x2ad55..@0x2ae1d) — only with `vp[0x86]` bit 0 (road-building
 * scroll). The result is the mask for `vp+0xd8`; every set direction plays sound **6**. Kept separate
 * because it needs window pixels the engine does not know.
 */
export function roadEdgeScroll(
  clickX: number,
  clickY: number,
  viewWidth: number,
  viewHeight: number,
): number {
  let mask = 0;
  const x = clickX - 0x10; // `subw $0x10` @0x2ad82
  const y = clickY - 0x08; // `subw $0x8`  @0x2ad86
  if (x < 0x18) mask |= 1;
  else if (x + 0x18 >= viewWidth) mask |= 2;
  if (y < 0x28) mask |= 4;
  else if (y + 0x28 >= viewHeight) mask |= 8;
  return mask;
}

// --- 4. Commit (`FUN_0002b542`) ------------------------------------------------------------------

/**
 * **Commit the drawn road** — `FUN_0002b542` @0x2b542. Walks **backwards** from the target over the
 * provisional path bits to the start flag and
 * 1. checks the owner raw at **every** tile (`(landscape[1] & 0xe0) != (player+4)<<5` => -1,
 *    @0x2b5b6),
 * 2. classifies each segment through the triangle masks `0xc` / `0xcc` / `0xc0`: mask value **0** means
 *    terrain type <= 3 = **water** => accumulator `|= 2`, otherwise land => `|= 1`,
 * 3. demands a **pure** road at the end: `1` = land only => ordinary road, `2` = water only => boat
 *    road, `3` = mixed => failure (@0x2b8fb/@0x2b90a/`jne 0x2bb7f`),
 * 4. links both flags and returns 0 instead of -1.
 *
 * The linking per end (@0x2b9e3..@0x2bb70):
 * ```
 * flag[3] |= 1<<dir            paths[dir]        = true
 * flag[4] |= 1<<dir            endpointDirs[dir] = true
 * flag[5] &= ~(1<<dir)         transporters[dir] = false
 * if (boat road) flag[4] &= ~(1<<dir)
 * flag[0x3c+dir] = (… & 0xc7) | otherDir<<3       otherEndDir[dir]
 * flag[6+dir] = road_length_to_category(segments + 1)
 * *(u32*)(flag + 0x24 + dir*4) = other flag       connections[dir]
 * ```
 * **Both** endpoint pointers are written (@0x2bb62 *and* @0x2bb70) — the decompilation shows only one,
 * and a port following it would produce one-sidedly linked roads.
 *
 * **No carrier bit**: `flag[5]` is cleared, not set — the carrier is requested later by the flag
 * scheduler.
 */
export function commitRoad(
  state: GameState,
  player: Player,
  clickPos: number,
  lastDir: Direction,
  segments: number,
): boolean {
  const geo = state.geo;
  const wantOwner = player.slot + 1;
  const targetFlagIdx = state.mapTiles[clickPos].objIndex;
  const targetDir = oppositeDir(lastDir); // direction at the target flag (gs[0x24a], @0x2b5f8)

  let pos = clickPos;
  let cameFrom = targetDir;
  let terrain = 0;
  const steps = segments + 1; // `addw $0x1` @0x2b632

  for (let i = 0; i <= steps; i++) {
    if (state.mapTiles[pos].owner !== wantOwner) return false;
    if (i === steps) break;
    // Outgoing directions of this tile minus the one we came from (@0x2b639).
    const outgoing = (state.mapTiles[pos].paths & 0x3f) & ~(1 << cameFrom);
    let next = -1;
    for (let d = 0; d < 6; d++) {
      if ((outgoing & (1 << d)) !== 0) {
        next = d;
        break;
      }
    }
    if (i === 0) next = targetDir; // first step: the edge just clicked
    if (next < 0) return false;
    terrain |= segmentTerrainBit(state, pos, next as Direction, geo);
    pos = neighbor(pos, next as Direction, geo);
    cameFrom = oppositeDir(next as Direction);
  }

  let boat: boolean;
  if (terrain === 1) boat = false;
  else if (terrain === 2) boat = true;
  else return false; // mixed (3) or empty (0) => `mov $0xffffffff` @0x2bb7f

  const startFlagIdx = state.mapTiles[pos].objIndex;
  const startDir = cameFrom; // `gs[0x24c]` @0x2b91c — direction at the start flag
  const a = state.flags[targetFlagIdx];
  const b = state.flags[startFlagIdx];
  if (!a || !b) return false;

  const category = lengthToCategory(steps);
  linkRoadEnd(a, targetDir, b.index, startDir, boat, category);
  linkRoadEnd(b, startDir, a.index, targetDir, boat, category);
  return true;
}

/**
 * Link one flag end — the seven writes from @0x2b9e3..@0x2bb70.
 *
 * The same block appears a second time in the **AI road builder** (@0x57410..@0x5759c), there with a
 * different trigger for the endpoint bit: the interactive road clears it for a **boat road**, the AI
 * road sets it only when `build` bit 4 is clear. Hence the parameter is called `suppressEndpoint` and
 * not `boat` — the caller decides which of the two conditions applies.
 */
export function linkRoadEnd(
  flag: Flag,
  dir: Direction,
  otherIndex: number,
  otherDir: Direction,
  suppressEndpoint: boolean,
  category: number,
): void {
  flag.paths[dir] = true;
  flag.endpointDirs[dir] = !suppressEndpoint;
  flag.transporters[dir] = false;
  flag.otherEndDir[dir] = otherDir;
  flag.length[dir] = category;
  flag.connections[dir] = { kind: 'flag', index: otherIndex };
}

/**
 * Land/water bit of **one** segment (`FUN_0002b655`, six direction branches). Every edge borders one or
 * two triangles; the original masks `landscape[2]` with `0xc` (lower triangle), `0xc0` (upper) or
 * `0xcc` (both) and reads **0 as water** (terrain type <= 3 leaves bits 2/3 clear). Returns 1 = land,
 * 2 = water.
 */
export function segmentTerrainBit(
  state: GameState,
  pos: number,
  dir: Direction,
  geo: MapGeometry,
): number {
  const t = (p: number) => state.mapTiles[p].terrainUp * 16 + state.mapTiles[p].terrainDown;
  const up = (p: number) => (t(p) & 0xc0) !== 0;
  const down = (p: number) => (t(p) & 0x0c) !== 0;
  switch (dir) {
    case Direction.Right: // @0x2b66c `& 0xc` here, else @0x2b677 `+ gs[0x18]` (Up) with `& 0xc0`
      return down(pos) || up(neighbor(pos, Direction.Up, geo)) ? 1 : 2;
    case Direction.DownRight: // `& 0xcc` on the tile itself
      return (t(pos) & 0xcc) !== 0 ? 1 : 2;
    case Direction.Down: // `& 0xc0` here, else `& 0xc` on Left
      return up(pos) || down(neighbor(pos, Direction.Left, geo)) ? 1 : 2;
    case Direction.Left:
      return down(neighbor(pos, Direction.Left, geo)) ||
        up(neighbor(neighbor(pos, Direction.Left, geo), Direction.Up, geo))
        ? 1
        : 2;
    case Direction.UpLeft:
      return (t(neighbor(pos, Direction.UpLeft, geo)) & 0xcc) !== 0 ? 1 : 2;
    default: {
      // Up — **the two masks are the other way round than for `Right`/`Left`**: `andb $0xc,…`
      // @0x2b89a on the **UpLeft** neighbour (lower triangle), then `andb $0xc0,…` @0x2b8bb on **its**
      // Right neighbour (upper triangle).
      //
      // The invariant that pins this: an edge has **one** kind, so
      // `seg(p, d) == seg(neighbour(p,d), opposite(d))` must hold. With the masks the other way round
      // `Down<->Up` breaks it in 26 of 4096 cases.
      const ul = neighbor(pos, Direction.UpLeft, geo);
      return down(ul) || up(neighbor(ul, Direction.Right, geo)) ? 1 : 2;
    }
  }
}

// --- 5. Abort (`FUN_000286dc`) -------------------------------------------------------------------

/**
 * **Abort road building** — `FUN_000286dc` @0x286dc. Resets the window bits, hides the six markers and
 * **clears the provisional path bits**:
 *
 * ```
 * count = vp[0xce] ; if (count == 0) -> only redraw            @0x28799
 * pos = cursor
 * do {                                                          @0x28801
 *   dir = lowest set direction of landscape[pos][0] & 0x3f
 *   next = pos + direction offset
 *   landscape[pos][0]  &= ~(1<<dir)                             @0x288d7
 *   landscape[next][0] &= ~(1<<(dir-3 mod 6))                   @0x288fd
 *   pos = next
 * } while (--count)
 * ```
 *
 * The **lowest** direction suffices because clearing the back edge removes the edge just walked: the
 * intermediate tiles of a drawn road carry exactly two provisional bits, the end tile one.
 */
export function cancelRoadBuilding(state: GameState, player: Player): void {
  const rb = roadSession(state, player);
  const geo = state.geo;
  let count = rb.segments;
  let pos = posOf(player.cursorCol, player.cursorRow, geo);
  while (count > 0) {
    const paths = state.mapTiles[pos].paths & 0x3f;
    let dir = -1;
    for (let d = 0; d < 6; d++) {
      if ((paths & (1 << d)) !== 0) {
        dir = d;
        break;
      }
    }
    if (dir < 0) break; // unreachable in the original — the counter matches the bits
    const next = neighbor(pos, dir as Direction, geo);
    state.mapTiles[pos].paths &= ~(1 << dir) & 0xff;
    state.mapTiles[next].paths &= ~(1 << oppositeDir(dir as Direction)) & 0xff;
    pos = next;
    count -= 1;
  }
  rb.active = false;
  rb.segments = 0;
  rb.allowedMask = 0;
  for (let i = 0; i < 6; i++) rb.markers[i] = MARKER_NONE;
}

// --- Helpers -------------------------------------------------------------------------------------

function colOfPos(pos: number, geo: MapGeometry): number {
  return pos & (geo.cols - 1);
}

function rowOfPos(pos: number, geo: MapGeometry): number {
  return (pos >> geo.rowShift) & (geo.rows - 1);
}
