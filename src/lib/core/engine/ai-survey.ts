/**
 * The AI's surroundings survey (`FUN_000606d2`): counts what lies around a probed tile, weighted by
 * distance, into four tables of 44 u16 counters each.
 *
 * The four tables are snapshots of ONE continuous spiral walk at growing radius, not four walks:
 * table 3 is the smallest radius, table 0 the accumulator at the end. How many rings a stage covers
 * depends on the build possibility, so with only three stages `table 1 == table 0`.
 *
 * The tables are scratch and therefore returned instead of stored: every call site reads them within
 * eight bytes of the call. The original zeroes only table 0 per call, so at build possibility 1
 * (which takes no snapshot) tables 1..3 still hold the previous run. Zeroing all four is equivalent
 * only because the project mask at possibility 1 admits project 0, whose chain reads table 0 alone.
 *
 * The original walks BYTE offsets and masks with `gs[0]` after each step. Between the column and the
 * row bits sits a gap bit (a row occupies `2*cols` slots, the row-interleaved layout), so a column
 * overflow is discarded instead of carrying into the row - column and row wrap independently, which
 * is what `position.neighbor()` does.
 */
import type { GameState, Player, Tile } from './state.js';
import { i16 } from './int.js';
import { Direction, neighbor, posOf } from './position.js';

/** 88 bytes == 22 u32 (zeroing/copy) == **44 u16** counters per table. */
export const AI_SURVEY_SLOTS = 44;
/** Accumulator plus three snapshots. */
export const AI_SURVEY_TABLES = 4;
/** `mov $0x12,%eax` @0x6078e — weight of the innermost ring. */
export const AI_SURVEY_START_WEIGHT = 0x12;

// ── Counter slots, derived from the write accesses of the six scan routines ────────────────────
/** Byte offset 0 — own land. */
export const SURVEY_OWN_LAND = 0;
/** Byte offset 2 — unowned land. */
export const SURVEY_FREE_LAND = 1;
/** Byte offset 4 — foreign land. */
export const SURVEY_FOREIGN_LAND = 2;
/** Byte offset 6 — terrain class 4..7 (`FUN_00060a3a` only). */
export const SURVEY_TERRAIN_LOW = 3;
/** Byte offset 8 — terrain class 11..14 (`FUN_00060a3a` only). */
export const SURVEY_TERRAIN_HIGH = 4;
/**
 * Byte offset 10 - water, and at the same time the base of the building column (a building of type
 * `t` counts into `SURVEY_BUILDING_BASE + t`). Water and building type 0 therefore share a slot; the
 * original does the same.
 */
export const SURVEY_WATER = 5;
/** See {@link SURVEY_WATER}. Types 1..24 => slots 6..29. */
export const SURVEY_BUILDING_BASE = 5;
/** Byte offset 0x4a — roads (`paths & 0x3f`); in `FUN_00061087` also the head's verdict. */
export const SURVEY_PATHS = 37;
/**
 * Byte offset `0x4a + idx` with `idx = (byte0 & 0xe0) >> 4` => slots 38..41 for gold/iron/coal/stone;
 * `idx == 0` is skipped, so slot 37 stays with the roads.
 *
 * The index is NOT bounded to 1..4: the original reads byte 0 of the game tuple raw, so it runs 0..7
 * and writes into slots 37..44. Reachable through the union - on a flag tile byte 0 holds the low byte
 * of `objIndex`, and unlike a building the flag is not filtered out beforehand. See
 * {@link rawMineralIndex}.
 */
export const SURVEY_MINERAL_BASE = 37;

/**
 * `DAT_000609ba` @0x609ba — 128 bytes, indexed by the tile's **object value** (0..127). The value is a
 * **byte offset** into the counter table; `0` means "does not count", a **negative** value means "a
 * building stands here, classify it by its type".
 *
 */
export const SURVEY_OBJECT_SLOT: readonly number[] = [
  0, 84, -1, -1, -1, 0, 0, 0, 60, 60, 60, 60, 60, 60, 60, 60, // 0x00
  60, 60, 60, 60, 60, 60, 60, 60, 84, 84, 84, 84, 84, 84, 84, 84, // 0x10
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x20
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x30
  0, 0, 0, 0, 0, 0, 0, 0, 64, 64, 64, 64, 64, 64, 64, 64, // 0x40
  84, 84, 0, 0, 0, 0, 0, 0, 84, 84, 84, 84, 84, 84, 84, 84, // 0x50
  84, 0, 84, 84, 84, 84, 0, 84, 84, 84, 84, 84, 84, 84, 84, 0, // 0x60
  66, 66, 68, 68, 70, 70, 72, 72, 86, 84, 84, 84, 84, 84, 84, -1, // 0x70
];

/** Which of the six scan routines a stage runs. */
export type ScanKind =
 /** `FUN_00060f33` — land + water + objects; buildings only when **finished** (`& 0xfc` + sign test). */
  | 'objectsFinished'
 /** `FUN_00060d33` — plus **all** buildings (`& 0x7c`, sites included) and the roads. */
  | 'objectsPaths'
 /** `FUN_00060baa` — plus the meadow test. */
  | 'objectsPathsMeadow'
 /** `FUN_00060a3a` — meadow, minerals and terrain classes, but **no buildings and no roads**. */
  | 'full'
 /** `FUN_00060e98` — the three land counters **only**. */
  | 'landOnly'
 /**
  * `FUN_00061087` — the scan for build possibility **1 == `BUILD_FLAG`** ("only a flag fits here").
  * Its head checks whether the spot can be connected and writes the verdict to slot 37 (100 == yes,
  * -1 == no); then it counts water, land and roads. The mine is possibility **2** and uses
  * `objectsPaths`, not this routine.
  */
  | 'flagSite';

/**
 * What a scan routine counts. In the binary the six routines are the same ring walk with different
 * numbers of blocks in the body, so a feature table replaces six copies of one loop; each row is one
 * `add %ax,OFF(%ebx)`.
 *
 * Two rows are counter-intuitive: `full` counts neither buildings nor roads.
 */
export interface ScanFeatures {
 /** Slots 0/1/2 — `(%ebx)`, `0x2`, `0x4`. */
  readonly land: boolean;
 /** Slot 5 — `0xa(%ebx)`. */
  readonly water: boolean;
 /** The table offset from `SURVEY_OBJECT_SLOT` — `(%ebx,%esi,1)`. */
  readonly objects: boolean;
 /** `0xa(%ebx,%esi,1)`: `none` = no such write, `finished` = mask 0xfc, `all` = 0x7c. */
  readonly buildings: 'none' | 'finished' | 'all';
 /** Slot 31 — `0x3e(%ebx)`. */
  readonly meadow: boolean;
 /** Slot 37 — `0x4a(%ebx)`. */
  readonly paths: boolean;
 /** Slots 38..41 — `0x4a(%ebx,%esi,1)`. */
  readonly minerals: boolean;
 /** Slots 3/4 — `0x6(%ebx)` / `0x8(%ebx)`. */
  readonly terrainClasses: boolean;
 /** `FUN_00061087` only: the water test sits **before** the land test. */
  readonly waterFirst: boolean;
}

export const SCAN_FEATURES: Readonly<Record<ScanKind, ScanFeatures>> = {
  objectsFinished: {
    land: true, water: true, objects: true, buildings: 'finished',
    meadow: false, paths: false, minerals: false, terrainClasses: false, waterFirst: false,
  },
  objectsPaths: {
    land: true, water: true, objects: true, buildings: 'all',
    meadow: false, paths: true, minerals: false, terrainClasses: false, waterFirst: false,
  },
  objectsPathsMeadow: {
    land: true, water: true, objects: true, buildings: 'all',
    meadow: true, paths: true, minerals: false, terrainClasses: false, waterFirst: false,
  },
  full: {
    land: true, water: true, objects: true, buildings: 'none',
    meadow: true, paths: false, minerals: true, terrainClasses: true, waterFirst: false,
  },
  landOnly: {
    land: true, water: false, objects: false, buildings: 'none',
    meadow: false, paths: false, minerals: false, terrainClasses: false, waterFirst: false,
  },
  flagSite: {
    land: true, water: true, objects: false, buildings: 'none',
    meadow: false, paths: true, minerals: false, terrainClasses: false, waterFirst: true,
  },
};

/** Entry address of each scan routine. */
export const SCAN_ADDRESS: Readonly<Record<ScanKind, number>> = {
  objectsFinished: 0x60f33,
  objectsPaths: 0x60d33,
  objectsPathsMeadow: 0x60baa,
  full: 0x60a3a,
  landOnly: 0x60e98,
  flagSite: 0x61087,
};

export interface Stage {
 /** The immediate from the binary; the loop runs `count + 1` rings. */
  readonly count: number;
  readonly scan: ScanKind;
 /**
  * Target table of the copier behind this stage, or `undefined` when none is called.
  * `FUN_00061241` -> 3, `FUN_00061263` -> 2, `FUN_00061285` -> 1. Possibility 1 calls none.
  */
  readonly copyTo?: number;
}

/**
 * The dispatcher @0x607b8..@0x607e7 on `player+0x101` (build possibility), with the stage counters. The
 * comparison order is 3, 2, 4, 1, 5 — irrelevant to the result, but that is how it stands in the binary.
 */
const STAGE_PLAN: Readonly<Record<number, readonly Stage[]>> = {
  1: [{ count: 2, scan: 'flagSite' }], // @0x60993 — no copier
  2: [
    { count: 0, scan: 'objectsPaths', copyTo: 3 },
    { count: 2, scan: 'objectsPaths', copyTo: 2 },
    { count: 7, scan: 'objectsPaths', copyTo: 1 },
  ],
  3: [
    { count: 2, scan: 'objectsPathsMeadow', copyTo: 3 },
    { count: 3, scan: 'objectsPathsMeadow', copyTo: 2 },
    { count: 4, scan: 'objectsPaths', copyTo: 1 },
  ],
  4: [
    { count: 2, scan: 'objectsPathsMeadow', copyTo: 3 },
    { count: 3, scan: 'objectsPathsMeadow', copyTo: 2 },
    { count: 4, scan: 'objectsPaths', copyTo: 1 },
    { count: 5, scan: 'landOnly' },
  ],
  5: [
    { count: 2, scan: 'full', copyTo: 3 },
    { count: 3, scan: 'full', copyTo: 2 },
    { count: 4, scan: 'full', copyTo: 1 },
    { count: 5, scan: 'full' },
  ],
};

/** The `else` branch @0x607e9 — every possibility other than 1..5. */
const STAGE_PLAN_DEFAULT: readonly Stage[] = [
  { count: 1, scan: 'objectsFinished', copyTo: 3 },
  { count: 1, scan: 'objectsFinished', copyTo: 2 },
  { count: 1, scan: 'objectsFinished', copyTo: 1 },
  { count: 2, scan: 'objectsFinished' },
];

/** The stage plan of a build possibility. */
export function surveyStagePlan(possibility: number): readonly Stage[] {
  return STAGE_PLAN[possibility] ?? STAGE_PLAN_DEFAULT;
}

/** A survey's result: `tables[0]` = final total, `tables[1..3]` = the snapshots. */
export interface AiSurvey {
  readonly tables: readonly number[][];
}

/**
 * The mineral counter's index — **raw from byte 0 of the game tuple**, as
 * `mov (%ebx),%al ; andw $0xe0,0x18(%edi) ; shrw $0x4` @0x60b18/@0x60b1d/@0x60b25 does it (shifting by
 * 4 rather than 5 turns the value into a WORD offset, i.e. the slot distance here).
 *
 * At `object` 1..4 byte 0 is not the mineral but the low byte of `objIndex` - our decoded model keeps
 * the two meanings apart, the original does not. Buildings never reach this point, a flag does, so in
 * the original a flag tile also bumps a mineral slot.
 */
function rawMineralIndex(tile: Tile): number {
  if (tile.object >= 1 && tile.object <= 4) return (tile.objIndex & 0xe0) >> 5;
  return tile.mineral;
}

/** Bump a counter. The original works in i16 and does not clamp. */
function bump(table: number[], slot: number, weight: number): void {
 // The original has no such check — it uses fixed offsets. The one path where an offset runs past the
 // end of the table is the mineral block, handled separately in the caller (see
 // {@link SURVEY_MINERAL_BASE}); this check stays as a backstop.
  if (slot < 0 || slot >= AI_SURVEY_SLOTS) return;
  table[slot] = i16((table[slot] ?? 0) + weight);
}

/**
 * The three land counters — byte-identical in five of the six scan routines.
 *
 * The original compares the raw byte: bit 7 is "has an owner". `owner == 0 <=> bit 7 clear` holds in
 * the original data without exception, so the decoded comparison is equivalent.
 */
function countLand(table: number[], tile: Tile, weight: number, wantOwner: number): void {
  if (tile.owner === 0) bump(table, SURVEY_FREE_LAND, weight);
  else if (tile.owner === wantOwner) bump(table, SURVEY_OWN_LAND, weight);
  else bump(table, SURVEY_FOREIGN_LAND, weight);
}

/**
 * Water, or the tile's object.
 *
 * Bit 7 of the object byte is the water marker, exactly equivalent to "at least one water triangle".
 * Our parser does not carry the bit, so the test stands here as a terrain comparison.
 */
function countObject(
  state: GameState,
  table: number[],
  tile: Tile,
  weight: number,
  buildings: ScanFeatures['buildings'],
): void {
  const offset = SURVEY_OBJECT_SLOT[tile.object] ?? 0;
  if (offset === 0) return;
  if (offset > 0) {
    bump(table, offset >> 1, weight);
    return;
  }
 // A building. `full` leaves here with `goto` @0x60b3a and does not count it at all.
  if (buildings === 'none') return;
  const bld = state.buildings[tile.objIndex];
  if (bld === undefined || bld === null) return;
 // `& 0xfc` keeps bit 7 => the following sign test discards sites; `& 0x7c` does not.
  if (buildings === 'finished' && bld.constructing) return;
  bump(table, SURVEY_BUILDING_BASE + bld.type, weight);
}

/** `paths & 0x3f != 0` => slot 37. */
function countPaths(table: number[], tile: Tile, weight: number): void {
  if ((tile.paths & 0x3f) !== 0) bump(table, SURVEY_PATHS, weight);
}

/**
 * The meadow test `landscape[pos+2] == 'U'` (0x55) — both triangles terrain type 5. Runs only when the
 * object does not count at all (`cVar3 == 0`), i.e. in the same `else` as the original.
 */
function countMeadow(table: number[], tile: Tile, weight: number): void {
  if (tile.terrainUp === 5 && tile.terrainDown === 5) bump(table, 31, weight);
}

/**
 * One ring walk with the visitor `visit`. Ring index and weight continue across stages — hence they
 * come in by reference and go back mutated.
 */
function walkRings(
  geo: GameState['geo'],
  cursor: { pos: number; ring: number; weight: number },
  count: number,
  visit: (pos: number, weight: number) => void,
): void {
 // `vreg1` CONTINUES across stages — the routine sets it once at the head. Resetting it per stage
 // would run the outer rings at the wrong place.
 // `do { … } while (orig(vreg5)-- != 0)` => `count + 1` rings.
  for (let stageRound = count; ; stageRound--) {
    cursor.pos = neighbor(cursor.pos, Direction.DownRight, geo); // `gs+0x8` at the ring head
 // `vreg0` = 0x14,0x10,0xc,8,4,0 => directions 5,4,3,2,1,0.
    for (let dir = Direction.Up as number; dir >= Direction.Right; dir--) {
 // `vreg2 = vreg3` => `ring + 1` steps per direction.
      for (let step = cursor.ring; ; step--) {
        cursor.pos = neighbor(cursor.pos, dir as Direction, geo);
        visit(cursor.pos, cursor.weight);
        if (step === 0) break;
      }
    }
    cursor.ring = i16(cursor.ring + 1);
    cursor.weight = i16(cursor.weight - 1);
    if (stageRound === 0) break;
  }
}

/**
 * The head of `FUN_00061087` — it decides **before** the ring walk whether the flag spot can be
 * connected, and writes the verdict to slot 37.
 *
 * - lower terrain triangle 8..10 => the head does not run at all (`jb 0x61160` @0x610a8), slot 37
 *   stays 0.
 * - success (`@0x61146`): slot 37 = **100**, and the routine **returns immediately** (`ret` @0x61154)
 *   — the ring walk is skipped. That is how possibility-1 saves are recognisable in the byte image:
 *   table 0 is empty apart from slot 37 = 100.
 * - failure (`@0x61155`): slot 37 = **0xffff**, then the ring walk runs.
 *
 * The masks are the familiar water tests on the terrain byte: `& 0xc0` tests the upper, `& 0xc` the
 * lower triangle for "not water", `& 0xcc` both.
 *
 * @returns `true` when the routine ends here (success).
 */
function flagSiteHead(state: GameState, table: number[], start: number): boolean {
  const geo = state.geo;
  const tile = state.mapTiles[start];
  if (tile === undefined) return false;
  const down = tile.terrainDown;
  if (down >= 8 && down <= 10) return false; // @0x610a8 — head skipped

  const upIsWater = tile.terrainUp <= 3; // `andb $0xc0` == 0
  const step = state.mapTiles[neighbor(start, Direction.UpLeft, geo)]; // `gs+0x14`
  let hit = false;
  if (upIsWater) {
 // @0x610b9: the neighbour must be water in BOTH triangles, then the tile to its right in the upper
 // triangle as well.
    if (step !== undefined && step.terrainUp <= 3 && step.terrainDown <= 3) {
      const right = state.mapTiles[neighbor(neighbor(start, Direction.UpLeft, geo), Direction.Right, geo)];
      if (right !== undefined && right.terrainUp <= 3) hit = true;
    }
  } else {
 // @0x610fb: the neighbour NOT water in both triangles, then the tile to its right in the upper
 // triangle likewise not.
    if (step !== undefined && step.terrainUp > 3 && step.terrainDown > 3) {
      const right = state.mapTiles[neighbor(neighbor(start, Direction.UpLeft, geo), Direction.Right, geo)];
      if (right !== undefined && right.terrainUp > 3) hit = true;
    }
  }
  if (hit) {
    table[SURVEY_PATHS] = 100; // `mov $0x64` @0x61146, then `ret`
    return true;
  }
  table[SURVEY_PATHS] = i16(0xffff); // `mov $0xffff` @0x61155
  return false;
}

/**
 * Run the surroundings survey and return the four tables.
 *
 * @param possibility The build possibility `player+0x101`. Probe branch A passes the classifier's
 * value, branch B passes **0** (`mov $0x0,%al` @0x5c91b, stored to `player[0x101]` @0x5c920) — that
 * lands in the `else`
 * branch, where the "own land" comparison is different too (see below).
 */
export function aiSurveySurroundings(
  state: GameState,
  player: Player,
  possibility: number,
): AiSurvey {
  const geo = state.geo;
  const tables: number[][] = [];
  for (let t = 0; t < AI_SURVEY_TABLES; t++) tables.push(new Array<number>(AI_SURVEY_SLOTS).fill(0));
  const acc = tables[0] as number[];
 // In the original table 692 sits immediately behind 604 — it is the target of the out-of-bounds
 // write in the mineral block (see {@link SURVEY_MINERAL_BASE}).
  const stray = tables[1] as number[];

 // `vreg1 = player[0xfe] << gs[0x30]; += player[0xfc]` @0x6073c..@0x60767 — the cursor. `gs+0x30` is
 // `rowShift + 1` (the row-interleaved layout), the rest is the byte factor 4; as a tile index that is
 // `posOf(col, row)`.
  const start = posOf(player.cursorCol, player.cursorRow, geo);

  const plan = STAGE_PLAN[possibility] ?? STAGE_PLAN_DEFAULT;

 // `vreg7 = player[0] << 5` @0x6077a — the player index in owner-bit position. In the `else` branch
 // it is `vreg7 = landscape[cursor+1] & 0x60` @0x607e9 instead, i.e. the owner BITS of the cursor tile
 // **without** the bit-7 test: with the cursor on unowned land, player slot 0 counts as "own" land
 // there. That is a quirk of the original, not a simplification.
  let wantOwner = player.slot + 1;
  if (STAGE_PLAN[possibility] === undefined) {
    const cursorTile = state.mapTiles[start];
    const bits = cursorTile === undefined || cursorTile.owner === 0 ? 0 : cursorTile.owner - 1;
    wantOwner = bits + 1;
  }

  const cursor = { pos: start, ring: 0, weight: AI_SURVEY_START_WEIGHT };

  for (const stage of plan) {
    const f = SCAN_FEATURES[stage.scan];

 // `FUN_00061087` checks the flag spot BEFORE the first ring and can end with `ret`. Only this
 // stage's ring walk is then skipped — the caller continues.
    const skipRings = f.waterFirst && flagSiteHead(state, acc, start);

    if (!skipRings) {
      walkRings(geo, cursor, stage.count, (pos, weight) => {
        const tile = state.mapTiles[pos];
        if (tile === undefined) return;
        const water = tile.terrainUp <= 3 || tile.terrainDown <= 3;

 // `FUN_00061087` counts water before land, all others after. The order does not affect the result
 // (different slots) — reproduced because that is how it stands in the binary.
        if (f.waterFirst && water) bump(acc, SURVEY_WATER, weight);
        if (f.land) countLand(acc, tile, weight, wantOwner);
        if (!f.waterFirst && f.water && water) bump(acc, SURVEY_WATER, weight);

        const offset = water ? 0 : (SURVEY_OBJECT_SLOT[tile.object] ?? 0);
        if (f.objects && !water) countObject(state, acc, tile, weight, f.buildings);
 // The meadow test hangs in the `c == 0` branch of the object cascade.
        if (f.meadow && !water && offset === 0) countMeadow(acc, tile, weight);
 // The minerals sit in the non-water branch; the `goto` @0x60b3a skips them when the object is a
 // building (offset < 0).
        if (f.minerals && !water && offset >= 0) {
          const mineralIndex = rawMineralIndex(tile);
          if (mineralIndex !== 0) {
            const slot = SURVEY_MINERAL_BASE + mineralIndex;
            if (slot < AI_SURVEY_SLOTS) bump(acc, slot, weight);
 // Index 7 => byte offset `0x4a + 14 == 0x58` == **slot 0 of the neighbouring table**: in the
 // original the four tables are contiguous (604 + 44*2 == 692), and it writes there without
 // noticing. Reproduced onto `tables[1]` so that a later copier overwrites it exactly as the
 // binary does (in the last stage there is none).
            else stray[0] = i16((stray[0] ?? 0) + weight);
          }
        }
 // The two terrain classes run for EVERY tile — the `goto` lands before them.
        if (f.terrainClasses) {
          const t = tile.terrainDown;
          if (t >= 4 && t <= 7) bump(acc, SURVEY_TERRAIN_LOW, weight);
          else if (t >= 11 && t <= 14) bump(acc, SURVEY_TERRAIN_HIGH, weight);
        }
        if (f.paths) countPaths(acc, tile, weight);
      });
    }

    if (stage.copyTo !== undefined) {
      (tables[stage.copyTo] as number[]).splice(0, AI_SURVEY_SLOTS, ...acc);
    }
  }

  return { tables };
}
