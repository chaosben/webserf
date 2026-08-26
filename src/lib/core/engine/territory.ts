/**
 * **Territory influence recolouring** — port of `FUN_00045a30`, which runs on every military event
 * (military building completed, captured, burnt down). It zeroes a four-player influence buffer,
 * **stamps** a per-type influence pattern for each active, non-burning military building
 * (`FUN_00045b85`) and then assigns every tile to the player with the highest influence
 * (`FUN_00046207`, which writes the owner bits into the landscape byte). `FUN_0004641a` handles tiles
 * that change hands.
 *
 * Influence is a pure function of the building positions, so the original's accumulated incremental
 * state equals a global recompute — that is why this port may recompute a window and still match:
 * a global recompute reproduces **every** one of the 4096 owner cells in the real saves.
 */
import type { Building, GameState } from './state.js';
import { posOf, neighbor, oppositeDir, colOf, rowOf, Direction } from './position.js';
import { demolishBuilding } from './buildings.js';
import { clearRoadPaths, demolishFlag } from './road-teardown.js';
import { spiralPos } from './spiral.js';
import { addPlayerMessage } from './player-messages.js';

/**
 * Influence per building type, `table[ringIndex] -> contribution` (ring 0 = none … 7 = edge of the
 * core; ring 8/9 -> `-1` is the centre marker and locks the influence at 128). Byte data at @0x45f3c
 * (fortress/castle), @0x45f46 (tower), @0x45f50 (hut).
 */
const INFLUENCE_HUT = [0, 1, 2, 4, 7, 12, 18, 29, -1, -1] as const;
const INFLUENCE_TOWER = [0, 3, 5, 8, 11, 15, 22, 30, -1, -1] as const;
const INFLUENCE_FORTRESS = [0, 6, 10, 14, 19, 23, 27, 31, -1, -1] as const; // fortress(22) & castle(24)

function influenceTable(type: number): readonly number[] | null {
  switch (type) {
    case 11: return INFLUENCE_HUT; // hut
    case 21: return INFLUENCE_TOWER; // tower
    case 22: // fortress
    case 24: return INFLUENCE_FORTRESS; // castle
    default: return null; // non-military -> no influence
  }
}

/**
 * 17x17 hex ring index grid (centre [8][8] = 9, falling outwards in hex metric; the zero corners
 * top-right and bottom-left are the non-hex neighbour directions). Byte data @0x45f5a (289 B). The
 * influence of a building on a tile at offset (dc, dr) is `table[RING_GRID[dr+8][dc+8]]`.
 */
// prettier-ignore
const RING_GRID: readonly number[] = [
  1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,
  1,2,2,2,2,2,2,2,2,1,0,0,0,0,0,0,0,
  1,2,3,3,3,3,3,3,3,2,1,0,0,0,0,0,0,
  1,2,3,4,4,4,4,4,4,3,2,1,0,0,0,0,0,
  1,2,3,4,5,5,5,5,5,4,3,2,1,0,0,0,0,
  1,2,3,4,5,6,6,6,6,5,4,3,2,1,0,0,0,
  1,2,3,4,5,6,7,7,7,6,5,4,3,2,1,0,0,
  1,2,3,4,5,6,7,8,8,7,6,5,4,3,2,1,0,
  1,2,3,4,5,6,7,8,9,8,7,6,5,4,3,2,1,
  0,1,2,3,4,5,6,7,8,8,7,6,5,4,3,2,1,
  0,0,1,2,3,4,5,6,7,7,7,6,5,4,3,2,1,
  0,0,0,1,2,3,4,5,6,6,6,6,5,4,3,2,1,
  0,0,0,0,1,2,3,4,5,5,5,5,5,4,3,2,1,
  0,0,0,0,0,1,2,3,4,4,4,4,4,4,3,2,1,
  0,0,0,0,0,0,1,2,3,3,3,3,3,3,3,2,1,
  0,0,0,0,0,0,0,1,2,2,2,2,2,2,2,2,1,
  0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,
];
/** Influence radius in tiles — half the grid edge length. */
export const INFLUENCE_RADIUS = 8;

function ringAt(dc: number, dr: number): number {
  return RING_GRID[(dr + INFLUENCE_RADIUS) * 17 + (dc + INFLUENCE_RADIUS)];
}

/** Signed shortest torus offset in one dimension. */
function wrapDelta(d: number, size: number): number {
  d &= size - 1;
  return d > size / 2 ? d - size : d;
}

/**
 * Owner of a tile from the military influence of all buildings (`FUN_00045b85` + `FUN_00046207`): per
 * player the sum of its buildings' contributions (clamped at `0x7f`; a centre hit `-1` locks it at 128),
 * then the player with the highest influence — on a tie the **lowest** slot wins. Returns 1-based
 * (`owner + 1`), 0 = unclaimed, like `tile.owner`.
 */
function computeTileOwner(state: GameState, tc: number, tr: number): number {
  const { cols, rows } = state.geo;
  const infl = [0, 0, 0, 0];
  const locked = [false, false, false, false];
  const buildings = state.buildings;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b === null || b.col === null || b.row === null) continue;
    const tab = influenceTable(b.type);
    if (tab === null || !b.active || b.burning) continue;
    const dc = wrapDelta(tc - b.col, cols);
    if (dc < -INFLUENCE_RADIUS || dc > INFLUENCE_RADIUS) continue;
    const dr = wrapDelta(tr - b.row, rows);
    if (dr < -INFLUENCE_RADIUS || dr > INFLUENCE_RADIUS) continue;
    const rg = ringAt(dc, dr);
    if (rg === 0) continue;
    const p = b.owner;
    if (locked[p]) continue;
    const c = tab[rg];
    if (c < 0) {
      locked[p] = true;
      infl[p] = 128; // 0x80
    } else {
      const v = infl[p] + c;
      infl[p] = v > 0x7f ? 0x7f : v;
    }
  }
  let best = 0;
  let winner = -1;
  for (let p = 0; p < 4; p++) {
    if (infl[p] > best) {
      best = infl[p];
      winner = p;
    }
  }
  return best === 0 ? 0 : winner + 1;
}

/**
 * **Lost-tile handler** `FUN_0004641a` — runs when a tile loses its owner to a **different** one or to
 * "unclaimed". It handles the lost tile **and its six hex neighbours**: every building on them burns
 * down (the collateral fire on lost border land), and the roads and flags on the lost tile are torn
 * down:
 * - centre is **not** a flag and carries paths -> {@link clearRoadPaths}(centre)
 * - centre **is** a flag -> {@link clearRoadPaths} on every neighbour with a path back to the centre,
 *   then {@link demolishFlag}(centre)
 *
 * Everything must be idempotent, because the recolour visits a tile many times — cleared paths,
 * removed flags and burning buildings are stable fixed points. `object == 1` is equivalent to paths
 * bit 7 (the flag marker).
 */
const NEIGHBOR_DIRS = [
  Direction.Right,
  Direction.DownRight,
  Direction.Down,
  Direction.Left,
  Direction.UpLeft,
  Direction.Up,
] as const;

function lostTileHandler(state: GameState, col: number, row: number): void {
  const geo = state.geo;
  const center = posOf(col, row, geo);
  const centerTile = state.mapTiles[center];
  const centerIsFlag = centerTile.object === 1; // == paths bit 7

  // Centre: demolish the building — and **afterwards** (not "else") clear the paths, unless the tile
  // carries a flag. In the binary these are two **consecutive** blocks (@0x46461, @0x4648b), not an
  // either-or, and the path byte is re-read after the demolition (@0x46474).
  if (centerTile.object >= 2 && centerTile.object <= 4) {
    const bld = state.buildings[centerTile.objIndex];
    if (bld != null && !bld.burning) demolishBuilding(state, bld);
  }
  if (!centerIsFlag && (centerTile.paths & 0x3f) !== 0) {
    clearRoadPaths(state, col, row);
  }

  // Six hex neighbours: demolish buildings; if the centre is a flag, clear the paths pointing at it.
  for (const dir of NEIGHBOR_DIRS) {
    const npos = neighbor(center, dir, geo);
    const ntile = state.mapTiles[npos];
    if (ntile.object >= 2 && ntile.object <= 4) {
      const bld = state.buildings[ntile.objIndex];
      if (bld != null && !bld.burning) demolishBuilding(state, bld);
    }
    if (centerIsFlag && ntile.paths & (1 << oppositeDir(dir))) {
      clearRoadPaths(state, colOf(npos, geo), rowOf(npos, geo));
    }
  }

  // The centre flag goes last.
  if (centerIsFlag) {
    demolishFlag(state, centerTile.objIndex, col, row);
  }
}

/**
 * Recolour the territory around a centre — port of `FUN_00045a30`. Call after every event that changes
 * military influence.
 *
 * **Two phases.** Phase 1 stamps the influence winner of every window tile into a snapshot, phase 2
 * assigns and fires {@link lostTileHandler} on every owner **loss** — **before** the new owner is
 * written (`FUN_00046207`: clear the owner byte, run the handler, set the new owner).
 *
 * **The snapshot is where this differs from the original, and the difference is bounded.** The
 * original computes each winner inline from an influence buffer that is **global** — one block for
 * the whole program, not one per call (`FUN_00045b06` takes its pointer from the game state). A
 * **nested** recolour — the handler burns a military building, that demolition recolours again —
 * therefore overwrites the buffer the outer pass is still reading, while this snapshot survives it.
 * Two measurements say the difference has no observable residue: nesting needs a *garrisoned*
 * military building to fall on a lost tile and was not observed at all over three long runs, and
 * after such a run the owner map still equals a full recompute from all buildings in every one of
 * the 4096 cells.
 *
 * **What must NOT be "fixed": the land score can be credited twice.** The assignment loop reads the
 * owner *before* the handler and ORs the winner in *after* it without reading again, so a tile that
 * a nested pass already handed to the winner is credited a second time. That is the original's own
 * shape (there is no second read between the two), so a nested pass leaves the score one above the
 * tile count. Do not add a re-read here — remove the *cause* of an unwanted nesting instead, as the
 * demolition gate in {@link demolishBuilding} does.
 */
export function recomputeTerritory(state: GameState, centerCol: number, centerRow: number): void {
  const geo = state.geo;
  const R = INFLUENCE_RADIUS;
  const side = 2 * R + 1;
  // Phase 1: the influence winner of every window tile as a fixed snapshot.
  const winners = new Int8Array(side * side);
  for (let dr = -R; dr <= R; dr++) {
    const tr = (centerRow + dr) & geo.rowMask;
    for (let dc = -R; dc <= R; dc++) {
      const tc = (centerCol + dc) & geo.colMask;
      winners[(dr + R) * side + (dc + R)] = computeTileOwner(state, tc, tr);
    }
  }
  // Phase 2: assign; on an owner loss fire the lost-tile handler before setting the new owner.
  for (let dr = -R; dr <= R; dr++) {
    const tr = (centerRow + dr) & geo.rowMask;
    for (let dc = -R; dc <= R; dc++) {
      const tc = (centerCol + dc) & geo.colMask;
      const win = winners[(dr + R) * side + (dc + R)];
      const tile = state.mapTiles[posOf(tc, tr, geo)];
      const old = tile.owner;
      if (old === win) continue;
      if (old !== 0) {
        // Land score of the old owner: `subl $0x1,0x112(%ebx)` @0x46380 — **before** the handler.
        // `tile.owner` is 1-based, the player slot 0-based.
        const loser = state.players[old - 1];
        if (loser) loser.totalLandScore = (loser.totalLandScore - 1) >>> 0;
        tile.owner = 0; // clear the owner byte (`landscape[pos+1] &= 0x1f`)
        lostTileHandler(state, tc, tr);
      }
      tile.owner = win; // win == 0 leaves the tile unclaimed
      if (win !== 0) {
        // `addl $0x1,0x112(%ebx)` @0x463b9 — only for a real new owner (`je 0x463c0` @0x4639d skips
        // the block when the owner byte is 0).
        const winner = state.players[win - 1];
        if (winner) winner.totalLandScore = (winner.totalLandScore + 1) >>> 0;
      }
    }
  }
  updateAreaThreatLevels(state, centerCol, centerRow);
  state.territoryVersion += 1; // not an original field — renderer bookkeeping
}

// --- Threat level of the military buildings ------------------------------------------------------

/**
 * Probe table of the threat level — byte data @0x46c20, three groups of spiral indices separated by
 * `-1` (stored as byte offsets `index * 4` into the position table `gs+0xc4`). The order is descending
 * threat: group 0 => 3, group 1 => 2, group 2 => 1, no hit => 0.
 *
 * **Original quirk, reproduced on purpose:** where group 0's sequence calls for 217, 218, **219**, 220
 * it holds **244** (raw `0x03d0` instead of `0x036c` — one digit off). Index 244 is therefore probed
 * twice and 219 never. A "corrected" value would be a silent deviation.
 */
// prettier-ignore
const THREAT_PROBES: readonly (readonly number[])[] = [
  [ // -> threat 3 (closest ring)
    31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
    121, 122, 123, 124, 125, 126,
    97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108,
    259, 260, 261, 262, 263, 264,
    241, 242, 243, 244, 245, 246,
    217, 218, 244, 220, 221, 222, 223, 224, 225, 226, 227, 228,
    247, 248, 249, 250, 251, 252,
  ],
  [265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276], // -> threat 2
  [277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294], // -> 1
];

/**
 * Threat level of one military building — `update_threat_level` @0x46abd. Probes the three groups from
 * the inside out; the **first** group holding a tile owned by a **foreign** player gives the level
 * (3 = front line … 1 = distant foreign land, 0 = deep inside own territory). Only the low two bits of
 * `building+5` are written (`andb $0xfc` / `or`).
 *
 * The original compares the **raw owner pattern** `(landscape[pos+1] & 0xe0) == ((owner & 3) + 4) << 5`
 * and only enters the comparison with bit 7 set (`js`). On the decoded model that is equivalent to
 * `owner !== 0 && owner !== bld.owner + 1`, because bit 7 == 0 implies bits 5/6 == 0 across every
 * available save (159744 tiles, no counterexample).
 */
export function updateThreatLevel(state: GameState, bld: Building): void {
  if (bld.col === null || bld.row === null) return;
  const geo = state.geo;
  const pos = posOf(bld.col, bld.row, geo);
  const own = bld.owner + 1; // tile.owner is 1-based
  for (let g = 0; g < THREAT_PROBES.length; g++) {
    const level = 3 - g;
    for (const idx of THREAT_PROBES[g]!) {
      const owner = state.mapTiles[spiralPos(pos, idx, geo)].owner;
      if (owner !== 0 && owner !== own) {
        bld.threatLevel = level;
        return;
      }
    }
  }
  bld.threatLevel = 0;
}

/**
 * Threat level of **all** military buildings in the changed area — the tail of the recolour:
 * `redraw_territory_change` @0x4680f falls through into the sweep loop @0x4689a after redrawing.
 *
 * Geometry read from the bytes: start at `(col - 25, row - 25)`, then **25 rows** of growing length
 * 25..49, one step **Down** per row (`gs+0xc`); then `length -= 2`, one step **Right**, and **24 rows**
 * of shrinking length 48..25, one step **DownRight** per row (`gs+0x8`). A tile counts with
 * `object in [2,4]` and its `paths & 2` set — on a building tile that bit is the link to its own flag,
 * which the original uses here as a sanity test.
 *
 * The wide radius is not arbitrary: the outermost probe sits 24 tiles from the building, so every
 * building within that reach of the changed area has to be re-evaluated.
 */
export function updateAreaThreatLevels(state: GameState, centerCol: number, centerRow: number): void {
  const geo = state.geo;
  let col = centerCol - 25;
  let row = centerRow - 25;
  let length = 25;
  const visit = (): void => {
    for (let k = 0; k < length; k++) {
      const tile = state.mapTiles[posOf(col + k, row, geo)];
      if (tile.object < 2 || tile.object > 4 || (tile.paths & 2) === 0) continue;
      const bld = state.buildings[tile.objIndex];
      if (bld === null || bld === undefined) continue;
      // `bld[4] & 0xfc` keeps bit 7 (`constructing`), so this is NOT a plain type test:
      // 0x2c/0x54/0x58/0x60 = hut/tower/fortress/castle **finished**, 0xe0 = castle **under
      // construction**. A hut under construction (0xac) matches nothing and stays unrated until it is
      // finished. (@0x4692a…@0x4694a.)
      const b4 = ((bld.constructing ? 0x80 : 0) | ((bld.type & 0x1f) << 2)) & 0xfc;
      if (b4 === 0x2c || b4 === 0x54 || b4 === 0x58 || b4 === 0x60 || b4 === 0xe0) {
        updateThreatLevel(state, bld);
      }
    }
  };
  for (let i = 0; i < 25; i++) {
    visit();
    length += 1;
    row += 1; // step Down
  }
  length -= 2;
  col += 1; // step Right
  for (let i = 0; i < 24; i++) {
    visit();
    length -= 1;
    col += 1; // step DownRight
    row += 1;
  }
}

/**
 * Full-map recompute check — **pure**, it does not mutate `state`. Recomputes every tile from all
 * military buildings and counts agreements with the stored `tile.owner`; against a real save
 * `mismatched` must be 0. Used by the regression suite, because its four entity classes do not cover
 * `tile.owner`.
 */
export function territoryMatchCount(state: GameState): { matched: number; mismatched: number } {
  const geo = state.geo;
  let matched = 0;
  let mismatched = 0;
  for (let row = 0; row < geo.rows; row++) {
    for (let col = 0; col < geo.cols; col++) {
      const owner = computeTileOwner(state, col, row);
      if (owner === state.mapTiles[posOf(col, row, geo)].owner) matched++;
      else mismatched++;
    }
  }
  return { matched, mismatched };
}

/**
 * The two scores per player slot before a recolour — in the original the snapshot at
 * `gs+0x2bc + slot*8` (`{u32 land, u32 buildings}`), taken @0x240b0/@0x240c2.
 */
export interface TerritoryScoreSnapshot {
  readonly land: number;
  readonly buildings: number;
}

/** Take the snapshot of all four slots (@0x2409x…@0x240cb, once per player). */
export function snapshotTerritoryScores(state: GameState): (TerritoryScoreSnapshot | null)[] {
  return state.players.map((p) =>
    p ? { land: p.totalLandScore >>> 0, buildings: p.totalBuildingScore >>> 0 } : null,
  );
}

/** "Land lost" (`addw $0x8` @0x24374); the upper 3 bits carry the causer. */
export const MSG_LAND_LOST = 8;
/** "Land **and buildings** lost" (`addw $0x9` @0x24389). */
export const MSG_LAND_AND_BUILDINGS_LOST = 9;

/**
 * **Who lost something in the last recolour?** — `FUN_0002433a`, called once per player slot
 * (@0x2410d/@0x24133/@0x24159/@0x2417f) against the snapshot taken before the recolour:
 *
 * ```
 * if      (player[0x116] < before.buildings)  ->  message 9  (land AND buildings)   @0x2434d jb
 * else if (player[0x112] < before.land)       ->  message 8  (land only)            @0x24363 jae ret
 * ```
 *
 * The parameter in the upper 3 bits is the **causer** (`serf[0] & 3` @0x2436c/@0x24381), the position
 * is the causer's tile (`serf[4]` @0x24390). The `else if` is taken verbatim: a player who loses both
 * gets **only** message 9, never 8 as well.
 */
export function notifyTerritoryLosers(
  state: GameState,
  before: readonly (TerritoryScoreSnapshot | null)[],
  causerOwner: number,
  causerPos: number,
): void {
  const param = (causerOwner & 3) << 5;
  for (let slot = 0; slot < state.players.length; slot++) {
    const player = state.players[slot];
    const prev = before[slot];
    if (!player || !prev) continue;
    if ((player.totalBuildingScore >>> 0) < prev.buildings) {
      addPlayerMessage(player, MSG_LAND_AND_BUILDINGS_LOST + param, causerPos);
    } else if ((player.totalLandScore >>> 0) < prev.land) {
      addPlayerMessage(player, MSG_LAND_LOST + param, causerPos);
    }
  }
}
