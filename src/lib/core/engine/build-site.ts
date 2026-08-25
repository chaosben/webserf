/**
 * **Build-site classification and building placement** — two original routines, here two functions.
 *
 * **1. `FUN_00032075` @0x32075 => {@link classifyBuildSite}** — the cursor classifier. The original
 * runs it on every cursor move and **after every map event** (over 20 call sites, including the burn
 * finale) and writes the result into the player record: `player+0x100` = cursor type, `player+0x101` =
 * build possibility, `player+0x102` = levelling height, plus two bits in `player+3` (`build`): bit 1 =
 * flag building blocked, bit 0 = **military building blocked**. All of that is cursor bookkeeping, so
 * this port computes it **on demand** instead of carrying it per frame.
 *
 * **2. The popup action handlers `FUN_00030000`ff => {@link placeBuilding}** — one entry stub per
 * building type (`gs+0x27a = type`), falling into **one of three** shared bodies that differ only in
 * the required `possibility` and in the object/progress value: mine (`== 2`, object 2, progress 1),
 * small (`>= 3`, object 2, progress 1), large (`== 4`, object 3, progress 0). Military types check
 * `player+3` bit 0 beforehand and then return **silently**. Each body has four exits, two of them
 * without a sound — see {@link buildMenuClickOutcome}.
 *
 * The port is **position based** (`col/row` + type) rather than modal: a command protocol does not
 * need the UI state machine, and the classification is recomputed when applying. That matches the
 * original, which calls `FUN_00032075` afresh before every placement.
 */

import type { GameState, Player, Building, Flag, Tile } from './state.js';
import { posOf, neighbor, Direction, type MapGeometry } from './position.js';
import { spiralPos } from './spiral.js';
import { allocBuilding, allocFlag, freeBuildingSlot } from './alloc.js';
import { splitRoadAtFlag } from './road-split.js';
import { BUILDING_TYPE_NAMES } from '../save-parser.js';
import { setFlagAcceptByte } from './flag-accept.js';

// --- Tables from the binary ----------------------------------------------------------------------

/**
 * Object class table `DAT_00003fd7` (`gs+0xc8`, 128 bytes, index = map object 0..127). The classifier
 * tests **only** this class, never the object value itself: 0 = free, 1 = small obstacle (trees), 2 =
 * large obstacle (stones), 3 = flag, 4 = small building, 5 = large building, 6 = castle. Index 127 =
 * `0xff` (end marker).
 */
// prettier-ignore
export const OBJECT_CLASS: readonly number[] = [
  0, 3, 4, 5, 6, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, // 0..15
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, // 16..31
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 32..47
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 48..63
  0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, // 64..79 (72..79 = stone pile stages)
  2, 2, 1, 0, 0, 0, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, // 80..95
  1, 0, 1, 1, 1, 1, 0, 1, 1, 2, 2, 2, 2, 2, 2, 0, // 96..111
  0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 255, // 112..127
];

/** Object class constants (values of the {@link OBJECT_CLASS} table). */
export const CLASS_FREE = 0;
export const CLASS_FLAG = 3;
export const CLASS_SMALL_BUILDING = 4;
export const CLASS_CASTLE = 6;

/**
 * Building material per type `DAT_00030889` (25 x 2 bytes: planks, stones) — becomes
 * `building+0x10/0x11` (stock maxima, `.DS` bytes 16/17 of the building record) and thereby drives the
 * builder serf's material request.
 */
// prettier-ignore
export const CONSTRUCTION_COST: readonly (readonly [number, number])[] = [
  [0, 0], // 0  None
  [2, 0], // 1  Fisher
  [2, 0], // 2  Lumberjack
  [3, 0], // 3  Boatbuilder
  [2, 0], // 4  Stonecutter
  [4, 1], // 5  StoneMine
  [5, 0], // 6  CoalMine
  [5, 0], // 7  IronMine
  [5, 0], // 8  GoldMine
  [2, 0], // 9  Forester
  [4, 3], // 10 Warehouse
  [1, 1], // 11 Hut
  [4, 1], // 12 Farm
  [2, 1], // 13 Butcher
  [4, 1], // 14 PigFarm
  [3, 1], // 15 Mill
  [2, 1], // 16 Baker
  [3, 2], // 17 Sawmill
  [3, 2], // 18 SteelSmelter
  [3, 3], // 19 ToolMaker
  [2, 1], // 20 WeaponSmith
  [2, 3], // 21 Tower
  [5, 5], // 22 Fortress
  [4, 1], // 23 GoldSmelter
  [0, 0], // 24 Castle
];

/** Military types — they block further military building in spiral ring 2 (`player+3` bit 0). */
const MILITARY_TYPES = new Set([11, 21, 22, 24]);

/**
 * Types placed as a **large** building (object value 3, `progress` 0).
 *
 * Type 13 (butcher) belongs here, which is easy to get wrong — three independent sources agree: the
 * placement stubs of the build menu (`gs+0x27a = type ; jmp 0x302d6`, exactly 12 types jump to the
 * large body), the construction branch of the driver table (`0x132e2 + (32+13)*8` => `0x138ed` =
 * levelling + builder), and the data (33 of 33 butchers in real saves carry tile object 3).
 */
const LARGE_TYPES = new Set([10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
/** Types placed as a **mine** (mountains only, `possibility == 2`). */
const MINE_TYPES = new Set([5, 6, 7, 8]);

// --- Result types --------------------------------------------------------------------------------

/** Cursor type (`player+0x100`) — what this tile can be the subject of at all. */
export const CURSOR_NONE = 0;
/** A flag that **cannot** be removed (building attached, water road, or a path count != 2). */
export const CURSOR_FLAG = 1;
/** A removable flag (0 paths, or exactly 2 paths to different endpoints). */
export const CURSOR_REMOVABLE_FLAG = 2;
/** A building (not burning, not the castle) — demolishable. */
export const CURSOR_BUILDING = 3;
/** Free tile carrying a path. */
export const CURSOR_PATH = 4;
/** Free path-less tile; the DownRight tile already carries a flag (which the building will use). */
export const CURSOR_CLEAR_BY_FLAG = 5;
/** Free path-less tile; the DownRight tile carries a path (a new flag splits it). */
export const CURSOR_CLEAR_BY_PATH = 6;
/** Free path-less tile; DownRight is free too. */
export const CURSOR_CLEAR = 7;

/** Build possibility (`player+0x101`). */
export const BUILD_NONE = 0;
export const BUILD_FLAG = 1;
export const BUILD_MINE = 2;
export const BUILD_SMALL = 3;
export const BUILD_LARGE = 4;
export const BUILD_CASTLE = 5;

/** Result of {@link classifyBuildSite} — the four original outputs in one object. */
export interface BuildSite {
  /** `player+0x100`: `CURSOR_*`. */
  readonly cursorType: number;
  /** `player+0x101`: `BUILD_*`. */
  readonly possibility: number;
  /** `player+0x102`: levelling height of a large building or castle (0 when not determined). */
  readonly levelingHeight: number;
  /** `player+3` bit 1: a neighbouring flag prevents a new flag here. */
  readonly flagBlocked: boolean;
  /** `player+3` bit 0: a military building in spiral ring 2 blocks military building. */
  readonly militaryBlocked: boolean;
}

/**
 * Writes the two `player+3` bits that `classify_build_site` **produces** back into the player record.
 *
 * Bit 1 is set at the routine entry (`bts $0x1` @0x3207d) and cleared where a flag is possible
 * (`btr $0x1` @0x32528). Bit 0 is written **only** in the ring-2 block (`bts $0x0` @0x32938 /
 * `btr $0x0` @0x32958) and otherwise keeps its old value — it is *sticky*, which
 * {@link classifyBuildSite} reproduces by pre-loading it from `player.build`.
 *
 * The classifier is deliberately a **pure** function here. These two bits are the one case where the
 * original feeds the result back as **input**: the AI builds its intent mask straight after
 * classifying from `bt $0x0`/`bt $0x1` on `player+3` (@0x5c744/@0x5c75f). Without this write-back it
 * would read the value from the save game instead of the tile just classified, and bit 0 would have no
 * stickiness at all.
 */
export function persistBuildSiteBits(player: Player, site: BuildSite): void {
  const set = (mask: number, on: boolean): void => {
    player.build = on ? (player.build | mask) & 0xff : player.build & ~mask & 0xff;
  };
  set(0x2, site.flagBlocked);
  set(0x1, site.militaryBlocked);
}

// --- Classifier (`FUN_00032075`) -----------------------------------------------------------------

/**
 * `FUN_00032801` @0x32801 — terrain class of one triangle as an OR bit: grass (4..7) => 0, mountain
 * (11..14) => bit 0, everything else (water 0..3, desert 8..10, snow 15) => bit 1. The caller ORs the
 * six triangles around the map point together: 0 = pure grass (building), 1 = pure mountain (mine),
 * >= 2 = unbuildable.
 */
function terrainClassBit(terrain: number): number {
  if (terrain >= 4 && terrain < 8) return 0;
  if (terrain >= 11 && terrain < 15) return 1;
  return 2;
}

/** Is the triangle **not** water? (Original: `terrain byte & 0xc0` resp. `& 0x0c` != 0.) */
function notWater(terrain: number): boolean {
  return terrain >= 4;
}

/**
 * Classifies the build site at `(col,row)` for `player` — port of `FUN_00032075`.
 *
 * Spiral indices as in {@link spiralPos}: 0 = centre, 1..6 = the six neighbours in direction order,
 * 7..18 = ring 2, 19..36 = ring 3. The order of the tests is the original's and matters, because each
 * one can return early with the state accumulated so far.
 */
export function classifyBuildSite(state: GameState, player: Player, col: number, row: number): BuildSite {
  const geo = state.geo;
  const center = posOf(col, row, geo);
  const sp = (i: number): Tile => state.mapTiles[spiralPos(center, i, geo)];

  // `player+2` bit 0 == "castle founded / regular play". Without a castle the original demands
  // **unowned** land and yields `BUILD_CASTLE` instead of `BUILD_LARGE` at the end.
  const hasCastle = (player.flags & 1) !== 0;
  // Original: `(landscape[1] & 0xe0) == (playerIndex + 4) << 5`; our tile owner is 1-based (0 =
  // nobody), so this is the equivalent comparison.
  const wantOwner = hasCastle ? player.slot + 1 : 0;

  let cursorType = CURSOR_NONE;
  let possibility = BUILD_NONE;
  let levelingHeight = 0;
  let flagBlocked = true; // `player+3 |= 2` at the routine entry
  let militaryBlocked = (player.build & 1) !== 0; // stays as it was if ring 2 is never reached

  const done = (): BuildSite => ({ cursorType, possibility, levelingHeight, flagBlocked, militaryBlocked });

  const t0 = sp(0);
  if (t0.owner !== wantOwner) return done(); // territory
  const cls0 = OBJECT_CLASS[t0.object] ?? 0;

  if (cls0 === CLASS_FLAG) {
    // --- Flag branch (@0x32484): removable or not ---
    cursorType = CURSOR_FLAG;
    // A building at the flag (path UpLeft plus a building there) => not removable.
    if ((t0.paths & 0x10) !== 0 && (OBJECT_CLASS[sp(5).object] ?? 0) >= CLASS_SMALL_BUILDING) return done();
    if ((t0.paths & 0x3f) !== 0) {
      const flag = state.flags[t0.objIndex];
      if (!flag) return done();
      let pathCount = 0;
      let firstEnd: string | null = null;
      for (let dir = 5; dir >= 0; dir--) {
        if (!flag.paths[dir]) continue;
        if (!flag.endpointDirs[dir]) return done(); // a path without the endpoint bit cannot be merged
        pathCount += 1;
        const con = flag.connections[dir];
        const key = con === null ? 'null' : `${con.kind}:${con.index}`;
        if (firstEnd === null) firstEnd = key;
        else if (firstEnd === key) return done(); // both paths lead to the same endpoint
      }
      if (pathCount !== 2) return done(); // only exactly two paths can be merged
    }
    cursorType = CURSOR_REMOVABLE_FLAG;
    return done();
  }

  if (cls0 >= CLASS_SMALL_BUILDING) {
    // --- Building branch (@0x32323) ---
    if (cls0 === CLASS_CASTLE) return done(); // castle: no action
    const bld = state.buildings[t0.objIndex];
    if (!bld || bld.burning) return done(); // burning: no action
    cursorType = CURSOR_BUILDING;
    // falls into the shared tail (the original jumps to @0x32701)
  } else {
    // --- Build branch (@0x323b6): free tile (class 0..2) ---
    const paths = t0.paths & 0x3f;
    if (paths !== 0) {
      // A single path DownRight or UpLeft: nothing possible — that is the building attach direction.
      if (paths === 0x02 || paths === 0x10) return done();
      cursorType = CURSOR_PATH;
    } else {
      const dr = sp(2); // DownRight — where the flag of a building on this tile would sit
      if ((OBJECT_CLASS[dr.object] ?? 0) === CLASS_FLAG) cursorType = CURSOR_CLEAR_BY_FLAG;
      else if ((dr.paths & 0x3f) !== 0) cursorType = CURSOR_CLEAR_BY_PATH;
      else cursorType = CURSOR_CLEAR;
    }

    if ((OBJECT_CLASS[t0.object] ?? 0) !== CLASS_FREE) return done(); // tree or stone in the way

    // The six triangles around the map point: if **all** of them are water, nothing is possible.
    if (
      !notWater(t0.terrainUp) &&
      !notWater(t0.terrainDown) &&
      !notWater(sp(4).terrainDown) &&
      !notWater(sp(5).terrainUp) &&
      !notWater(sp(5).terrainDown) &&
      !notWater(sp(6).terrainUp)
    ) {
      return done();
    }

    // Flag spacing for the tile itself: a neighbouring flag forbids a new flag here.
    let flagNeighbor = false;
    for (let i = 1; i <= 6; i++) {
      if ((OBJECT_CLASS[sp(i).object] ?? 0) === CLASS_FLAG) {
        flagNeighbor = true;
        break;
      }
    }
    if (flagNeighbor) {
      if (cursorType === CURSOR_PATH) return done(); // path plus neighbouring flag => nothing
    } else {
      flagBlocked = false; // `player+3 &= ~2`
      if (hasCastle) {
        possibility = BUILD_FLAG;
        if (cursorType === CURSOR_PATH) return done(); // on a path only the flag is possible
      }
    }

    // Basic building rules.
    for (let i = 1; i <= 6; i++) {
      if ((OBJECT_CLASS[sp(i).object] ?? 0) >= CLASS_SMALL_BUILDING) return done(); // building next door
    }
    if (cursorType !== CURSOR_CLEAR_BY_FLAG) {
      if ((OBJECT_CLASS[sp(2).object] ?? 0) !== CLASS_FREE) return done(); // flag spot occupied
    }
    // Flag spacing of the future flag spot (DownRight): its own neighbourhood.
    for (const i of [7, 8, 14, 1, 3]) {
      if ((OBJECT_CLASS[sp(i).object] ?? 0) === CLASS_FLAG) return done();
    }
    // The building's footprint must not be under water.
    if (!notWater(sp(1).terrainUp)) return done();
    if (!notWater(sp(3).terrainDown)) return done();
    if (!notWater(sp(2).terrainUp)) return done();
    if (!notWater(sp(2).terrainDown)) return done();
  }

  // --- Shared tail (@0x32701) ---
  for (let i = 1; i <= 6; i++) {
    if (sp(i).owner !== wantOwner) return done(); // all six neighbours inside our own territory
  }

  let terr = 0;
  terr |= terrainClassBit(t0.terrainUp);
  terr |= terrainClassBit(t0.terrainDown);
  terr |= terrainClassBit(sp(4).terrainDown);
  terr |= terrainClassBit(sp(5).terrainUp);
  terr |= terrainClassBit(sp(5).terrainDown);
  terr |= terrainClassBit(sp(6).terrainUp);
  if (terr >= 2) return done(); // an unbuildable triangle among them
  if (terr !== 0) {
    if (hasCastle) possibility = BUILD_MINE; // pure mountain => mine (@0x32851)
    return done();
  }
  if (hasCastle) possibility = BUILD_SMALL; // pure grass => at least a small building (@0x32873)

  // Military block: a military building in ring 2 blocks military building (`player+3` bit 0).
  militaryBlocked = false;
  for (let i = 7; i <= 18; i++) {
    const t = sp(i);
    if (t.object < 2 || t.object > 4) continue; // only tiles carrying a building object
    const b = state.buildings[t.objIndex];
    if (b && MILITARY_TYPES.has(b.type)) {
      militaryBlocked = true;
      break;
    }
  }

  // Large buildings: stricter neighbourhood plus pure grass-5 terrain.
  for (let i = 1; i <= 6; i++) {
    const c = OBJECT_CLASS[sp(i).object] ?? 0;
    if (c >= 2 && c !== CLASS_FLAG) return done(); // stone or building next door
  }
  for (let i = 7; i <= 18; i++) {
    if ((OBJECT_CLASS[sp(i).object] ?? 0) > CLASS_SMALL_BUILDING) return done(); // large building in ring 2
  }
  if (t0.terrainUp !== 5 || t0.terrainDown !== 5) return done();
  if (sp(4).terrainDown !== 5) return done();
  if (sp(5).terrainUp !== 5 || sp(5).terrainDown !== 5) return done();
  if (sp(6).terrainUp !== 5) return done();

  // Levelling height: min/max over ring 2 (plus the levelling heights of freshly placed large
  // buildings in ring 3), weighted mean over centre (doubled) and six neighbours, clamped to
  // [max - 4, min + 4].
  let hMin = 31;
  let hMax = 0;
  for (let i = 7; i <= 18; i++) {
    const h = sp(i).height;
    if (h <= hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  for (let i = 19; i <= 36; i++) {
    const t = sp(i);
    if (t.object !== 3) continue; // object value 3 = large building
    const b = state.buildings[t.objIndex];
    if (!b || !b.constructing || b.progress !== 0) continue; // only sites not yet levelled
    const lvl = (b.level ?? 0) & 0xff;
    if (lvl <= hMin) hMin = lvl;
    if (hMax < lvl) hMax = lvl;
  }
  if (hMax - hMin >= 9) return done(); // terrain too uneven

  let sum = 0;
  for (let i = 0; i <= 6; i++) {
    const h = sp(i).height;
    sum += i === 0 ? h + h : h; // centre weighted twice
  }
  let avg = sum >> 3;
  let lo = hMax - 4;
  if (lo < 0) lo = 0;
  const hi = hMin + 4;
  if (avg < lo) avg = lo;
  if (hi < avg) avg = hi;
  if (avg === 0) avg = 1;
  levelingHeight = avg;
  possibility = hasCastle ? BUILD_LARGE : BUILD_CASTLE;
  return done();
}

// --- Moving resources out of the way (`FUN_000308c9` / `FUN_00030a1b`) ---------------------------

/**
 * `FUN_00030a1b` @0x30a1b — tries to deposit `amount` units of resource `type` on `tile`. Target tiles
 * carrying a flag or building (object value 1..4) are skipped. If the type matches (or the tile is
 * empty) it is filled up to the maximum of 31; the remainder moves on. Returns what was not deposited.
 */
function depositResource(tile: Tile, type: number, amount: number): number {
  const obj = tile.object & 0x7f;
  if (obj !== 0 && obj <= 4) return amount; // flag or building: do not deposit
  if (tile.mineral === 0 && tile.resourceAmount === 0) {
    tile.mineral = type;
    tile.resourceAmount = amount;
    return 0;
  }
  if (tile.mineral !== type) return amount; // different type: not here
  const sum = tile.resourceAmount + amount;
  if (sum < 32) {
    tile.resourceAmount = sum;
    return 0;
  }
  tile.resourceAmount = 31;
  return sum - 31;
}

/**
 * Step chain of the resource move — the six byte-delta additions of `FUN_000308c9` (@0x3091e ff.):
 * `+4` (Right), `+gs+0x18` (Up), `+gs+0x60` (Left), `+gs+0xc` (Down), `+gs+0xc` (Down), `+4` (Right).
 * Each step is **relative to the previous target**, so the tiles reached are:
 *
 * `(+1,0) -> (+1,-1) -> (0,-1) -> (0,0) -> (0,+1) -> (+1,+1)`
 *
 * Two quirks a "six neighbours" reimplementation would miss: `(+1,-1)` is **not** a neighbour in the
 * hex grid, and step 4 lands on the **source tile itself** — the remainder is "deposited" there and
 * then overwritten by the object index, so it is lost **without** correcting the total gold sum.
 */
const PUSH_OUT_STEPS: readonly Direction[] = [
  Direction.Right,
  Direction.Up,
  Direction.Left,
  Direction.Down,
  Direction.Down,
  Direction.Right,
];

/**
 * `FUN_000308c9` @0x308c9 — moves the resource amount of a tile that is being built over onto the
 * tiles of the {@link PUSH_OUT_STEPS} chain. If anything is left after all six attempts and it was
 * **gold** (type 1), it is subtracted from the map's total gold (`gs+0x4c`, the denominator of knight
 * morale) — that amount is gone for good.
 */
function pushOutTileResource(state: GameState, pos: number, geo: MapGeometry): void {
  const tile = state.mapTiles[pos];
  const type = tile.mineral;
  let amount = tile.resourceAmount;
  if (type === 0 && amount === 0) return;

  let p = pos;
  for (const dir of PUSH_OUT_STEPS) {
    p = neighbor(p, dir, geo);
    amount = depositResource(state.mapTiles[p], type, amount);
    if (amount === 0) break;
  }
  if (amount !== 0 && type === 1) {
    state.header.mapGoldTotal = state.header.mapGoldTotal - amount; // gs+0x4c
  }
  tile.mineral = 0;
  tile.resourceAmount = 0;
}

// --- Placement (popup action handlers `FUN_00030000`ff) ------------------------------------------

/**
 * Which **build class** a type has, and hence which of the three placement bodies is responsible.
 *
 * The three bodies differ not only in the threshold but in the **comparison**, read from the bytes
 * (the decompilation only shows `if (x != 3)` forms without the sign direction):
 *
 * | Class | Body | Build branch | Building branch (cursor type 3) |
 * |---|---|---|---|
 * | mine | `@0x3011e` | `cmpb $0x2 ; jne` @0x301ad — **exactly** 2 | `cmpb $0x2 ; jne` @0x30140 — exactly 2 |
 * | small | `@0x301fa` | `cmpb $0x3 ; jb` @0x30289 — **at least** 3 | `cmpb $0x3 ; jb` @0x3021c |
 * | large | `@0x302d6` | `cmpb $0x4 ; jne` @0x30365 — **exactly** 4 | `cmpb $0x4 ; jb` @0x302f8 — at least 4 |
 *
 * So the large body tests equality in the build branch and "at least" in the building branch — hence
 * two functions rather than one threshold. The difference only shows at `possibility == 5`
 * (`BUILD_CASTLE`), which {@link classifyBuildSite} sets **only while the player has no castle**.
 */
function buildClass(type: number): 'mine' | 'small' | 'large' {
  if (MINE_TYPES.has(type)) return 'mine';
  return LARGE_TYPES.has(type) ? 'large' : 'small';
}

/** Is the build possibility enough for this type's **build branch**? (`@0x301ad`/`@0x30289`/`@0x30365`) */
function possibilityAllowsBuild(type: number, possibility: number): boolean {
  switch (buildClass(type)) {
    case 'mine':
      return possibility === BUILD_MINE;
    case 'small':
      return possibility >= BUILD_SMALL;
    case 'large':
      return possibility === BUILD_LARGE;
  }
}

/** And for the **building branch** (cursor type 3)? (`@0x30140`/`@0x3021c`/`@0x302f8`) */
function possibilityAllowsDemolish(type: number, possibility: number): boolean {
  switch (buildClass(type)) {
    case 'mine':
      return possibility === BUILD_MINE;
    case 'small':
      return possibility >= BUILD_SMALL;
    case 'large':
      return possibility >= BUILD_LARGE;
  }
}

/**
 * Can `player` place a building of `type` at `(col,row)`? Exactly the gates of the original handlers:
 * military block (tower/fortress only), cursor type in {clear, clearByPath, clearByFlag} and the build
 * possibility. The warehouse limit is checked by {@link placeBuilding} itself — it hangs on the
 * building counter, not on the site.
 */
export function canPlaceBuilding(state: GameState, player: Player, col: number, row: number, type: number): boolean {
  if (type <= 0 || type >= CONSTRUCTION_COST.length) return false;
  const site = classifyBuildSite(state, player, col, row);
  // Military gate of the handler stubs @0x3009a/@0x300d1 (tower/fortress).
  if ((type === 21 || type === 22) && site.militaryBlocked) return false;
  if (
    site.cursorType !== CURSOR_CLEAR &&
    site.cursorType !== CURSOR_CLEAR_BY_PATH &&
    site.cursorType !== CURSOR_CLEAR_BY_FLAG
  ) {
    return false;
  }
  return possibilityAllowsBuild(type, site.possibility);
}

/**
 * Outcome of a click on a **building icon of the build menu** — the four ways out of the three
 * placement bodies. Each carries its sound and whether the popup closes:
 *
 * | Outcome | Sound | Popup | Original |
 * |---|---|---|---|
 * | `blocked` | — **silent** | stays open | `ret` @0x300ba / @0x300f1 (military block in the icon stub) |
 * | `demolish` | 2 | closes | @0x30161: special click on a building of matching class |
 * | `keep` | — **silent** | stays open | `ret` @0x3019c / @0x30278 / @0x30354 (plain click on it) |
 * | `place` | 2 | closes | @0x303a6, the shared body |
 * | `reject` | 4 | cursor type 3: stays open, otherwise closes | @0x301e6 / @0x302c2 / @0x30392 |
 *
 * **The two silent exits are the reason this function exists.** A port that only knows "works / does
 * not work" plays a sound where the original is silent, and closes the popup where the original leaves
 * it standing. Neither shows up in a unit test.
 *
 * Order as in the original: the military block sits **in the icon stub**, hence **before**
 * `classify_build_site`.
 */
export type BuildMenuClickOutcome = 'blocked' | 'demolish' | 'keep' | 'place' | 'reject';

export function buildMenuClickOutcome(
  state: GameState,
  player: Player,
  col: number,
  row: number,
  type: number,
  specialClick: boolean,
): BuildMenuClickOutcome {
  if (type <= 0 || type >= CONSTRUCTION_COST.length) return 'reject';
  const site = classifyBuildSite(state, player, col, row);
  // Military gate of the icon stubs @0x3009a/@0x300d1 — `bt $0x0` on `player+3`, then a bare `ret`.
  if ((type === 21 || type === 22) && site.militaryBlocked) return 'blocked';

  if (site.cursorType === CURSOR_BUILDING) {
    // `cmpb $0x3,0x100` @0x30134/@0x30210/@0x302ec — the building branch, BEFORE `close_popup`.
    if (!possibilityAllowsDemolish(type, site.possibility)) return 'reject';
    return specialClick ? 'demolish' : 'keep';
  }
  if (!possibilityAllowsBuild(type, site.possibility)) return 'reject';
  if (
    site.cursorType !== CURSOR_CLEAR &&
    site.cursorType !== CURSOR_CLEAR_BY_PATH &&
    site.cursorType !== CURSOR_CLEAR_BY_FLAG
  ) {
    return 'reject'; // types 0/1/2/4 — none of the three `cmpb $0x7/$0x6/$0x5` match
  }
  return 'place';
}

// The `demolish` branch itself lives in `demolish.ts` (`demolishForPendingBuild`).

/**
 * Places a building of `type` for `player` at `(col,row)` — port of the shared handler body from
 * @0x303a6. Returns the new building, or `null` when the placement was rejected (site gate, warehouse
 * limit, or no free flag slot).
 *
 * The order is the original's; two steps are easy to get wrong. `alloc_flag` runs **only** when not
 * building onto an existing flag, and if it fails the building slot is handed back via
 * `free_building_slot`. And the resources of the tile being built over must be moved out **before**
 * the object index word is written, because that word overwrites them.
 */
export function placeBuilding(
  state: GameState,
  player: Player,
  col: number,
  row: number,
  type: number,
): Building | null {
  if (!canPlaceBuilding(state, player, col, row, type)) return null;
  const site = classifyBuildSite(state, player, col, row);
  const geo = state.geo;
  const pos = posOf(col, row, geo);
  const flagPos = neighbor(pos, Direction.DownRight, geo);
  const isLarge = LARGE_TYPES.has(type);

  // Warehouse limit (@0x303d7): finished + under construction + 1 == map limit => do not build.
  if (type === 10) {
    const built = player.completedBuildingCount[type - 1] ?? 0;
    const building = player.incompleteBuildingCount[type - 1] ?? 0;
    if (built + building + 1 === state.header.warehouseLimit) return null;
  }

  // Allocate the records.
  const bld = allocBuilding(state);
  const useExistingFlag = site.cursorType === CURSOR_CLEAR_BY_FLAG;
  let flagIndex: number;
  if (useExistingFlag) {
    flagIndex = state.mapTiles[flagPos].objIndex;
    const existing = state.flags[flagIndex];
    if (!existing) {
      freeBuildingSlot(state, bld.index);
      return null;
    }
  } else {
    const flag = allocFlag(state);
    if (!flag) {
      freeBuildingSlot(state, bld.index);
      return null;
    }
    flag.owner = player.slot; // flag+3 = owner<<6
    flagIndex = flag.index;
  }
  const flag = state.flags[flagIndex]!;

  // First-building markers (@0x3043f) — only while `player+0x163` bit 0 is clear.
  if ((player.messageFlags & 1) === 0) {
    const slot = type === 2 ? 0 : type === 17 ? 1 : type === 4 ? 2 : -1;
    if (slot >= 0 && player.messageBuildingSlots[slot] === 0) player.messageBuildingSlots[slot] = bld.index;
  }

  // Fill the building record.
  bld.level = site.levelingHeight; // bld+0xe
  bld.col = col;
  bld.row = row;
  bld.type = type;
  bld.typeName = BUILDING_TYPE_NAMES[type] ?? String(type);
  bld.owner = player.slot;
  bld.constructing = true; // bld+4 |= 0x80
  bld.progress = isLarge ? 0 : 1; // large buildings must be levelled first
  bld.flag = flagIndex;
  const [planks, stones] = CONSTRUCTION_COST[type];
  bld.stockMaximum = [planks, stones]; // bld+0x10/0x11
  player.incompleteBuildingCount[type - 1] = (player.incompleteBuildingCount[type - 1] ?? 0) + 1;

  // Flag side: the building hangs off the flag in direction UpLeft.
  flag.hasBuilding = true; // flag+4 |= 0x40
  flag.connections[Direction.UpLeft] = { kind: 'building', index: bld.index };
  setFlagAcceptByte(flag, 0x42, 2); // flag+0x42 — demand mask plank, accept bit clear
  flag.stockPriority[0] = 0; // flag+0x43
  setFlagAcceptByte(flag, 0x44, 0x10); // flag+0x44 — demand mask stone
  flag.stockPriority[1] = 0; // flag+0x45

  // Map tiles.
  const tile = state.mapTiles[pos];
  pushOutTileResource(state, pos, geo); // move resources out BEFORE writing the object index
  tile.objIndex = bld.index;
  tile.object = isLarge ? 3 : 2; // large / small building
  tile.paths |= 0x02; // path DownRight to the flag
  tile.blocked = true; // paths byte bit 6

  const fTile = state.mapTiles[flagPos];
  fTile.paths |= 0x10; // path UpLeft to the building
  if (!useExistingFlag) {
    pushOutTileResource(state, flagPos, geo);
    fTile.object = 1; // flag
    fTile.objIndex = flagIndex;
  }
  // The building attachment sets **no** flag-record bit — the `|0x10` @0x304ec is on the **tile**
  // (landscape array); in the flag only `flag[4] |= 0x40` (hasBuilding) is set. Decided on data: over
  // **3786 flags with a building** in real saves, neither `flag[3]` bit 4 nor `flag[4]` bit 4 is
  // **ever** set (while flags without a building have both together 444 times). Setting them here
  // would create a phantom path that every direction loop over `flag.paths` counts — carrier request,
  // road teardown, homeward test.

  // If the new flag landed on an existing path (cursor type 6), the original splits it at the
  // **DownRight** tile: `if (player[0x100] == 6) FUN_0004d9ed((col+1) & gs[0x32], (row+1) & gs[0x34])`.
  if (site.cursorType === CURSOR_CLEAR_BY_PATH) {
    splitRoadAtFlag(state, (col + 1) & geo.colMask, (row + 1) & geo.rowMask);
  }
  return bld;
}

// --- Placing a free-standing flag (`action_build_flag` @0x2891e -> `build_flag` @0x2899f) --------

/**
 * Gate of the flag-building handler, from `action_build_flag` (@0x2891e): after classification the
 * **build possibility must be != 0** *and* the cursor type must be **7** (free), **6** (free, path
 * next to it) or **4** (on a path). Otherwise the original builds nothing and only re-derives the
 * panel icons.
 *
 * ```
 * classify_build_site();
 * if (player[0x101] != 0 && (player[0x100] == 7 || == 6 || == 4)) { vp[1] |= 4; build_flag(); }
 * else context_bar_set_icons();
 * ```
 */
export function canBuildFlag(state: GameState, player: Player, col: number, row: number): boolean {
  const site = classifyBuildSite(state, player, col, row);
  if (site.possibility === BUILD_NONE) return false;
  return (
    site.cursorType === CURSOR_CLEAR ||
    site.cursorType === CURSOR_CLEAR_BY_PATH ||
    site.cursorType === CURSOR_PATH
  );
}

/**
 * Places a free-standing flag — `build_flag` (@0x2899f), field by field from the binary:
 *
 * ```
 * alloc_flag();                       // SF => array full, abort without effect
 * flag[3] = (player_index & 3) << 6;  // owner in bits 6..7, pathCon stays 0
 * pos = (player[0xfe] << gs[0x30]) + player[0xfc];
 * landscape[pos*4+3] &= 0x80;  |= 1;  // clear the object (water marker stays), then object 1 = flag
 * landscape[pos*4+0] |= 0x80;         // paths byte bit 7 = "there is a flag here"
 * push_out_tile_resource();           // move the tile's resources — BEFORE the object index word
 * game[pos*4] = flag_index;
 * if (player[0x100] == 4) FUN_0004d9ed(player[0xfc], player[0xfe]);
 * ```
 *
 * Two modelling notes (not deviations): **paths bit 7** is not carried as a field, being verified
 * equivalent to `object === 1`; and the flag stores **no position** in its record, as in the original
 * — it is found through `tile.objIndex`.
 *
 * **The cursor type is a PARAMETER, not reclassified.** The original reads `player[0x100]`, the
 * **stored** result of the last classification. For a human that is the same tile being built on, so
 * reclassifying would be equivalent — but the **AI executor** (`ai-execute.ts`) moves the cursor onto
 * the flag tile beforehand and forces `player[0x100]` from 6 to **4**, precisely so that this branch
 * splits the road. A reclassifying call would see 6 there and leave the road alone.
 */
export function buildFlagRecord(
  state: GameState,
  player: Player,
  col: number,
  row: number,
  cursorType: number,
): Flag | null {
  const geo = state.geo;
  const pos = posOf(col, row, geo);
  const flag = allocFlag(state);
  flag.owner = player.slot; // flag+3 = owner<<6

  const tile = state.mapTiles[pos];
  tile.object = 1; // landscape[+3] &= 0x80 (clear object) | 1 (flag)
  pushOutTileResource(state, pos, geo); // order as in the original: before the object index
  tile.objIndex = flag.index;

  // `if (player[0x100] == 4) FUN_0004d9ed(...)` — a flag on a path splits it.
  if (cursorType === CURSOR_PATH) splitRoadAtFlag(state, col, row);
  return flag;
}

/**
 * The **human path** `action_build_flag` (@0x2891e): classify, check {@link canBuildFlag}, then
 * `build_flag`. Two original routines, two functions — the gate belongs to the caller, not to the
 * primitive: `build_flag` itself checks **nothing** but `alloc_flag` (its only early `ret` @0x289a6
 * hangs on the `jns` after `call 0x44e68`).
 */
export function buildFlag(
  state: GameState,
  player: Player,
  col: number,
  row: number,
): Flag | null {
  const site = classifyBuildSite(state, player, col, row);
  if (!canBuildFlag(state, player, col, row)) return null;
  return buildFlagRecord(state, player, col, row, site.cursorType);
}
