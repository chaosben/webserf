/**
 * FreeWalking (serf state 16) — movement across terrain, away from the roads. This is the shared
 * walking logic of **every** field worker: geologist, fisherman, lumberjack, forester, stonecutter,
 * farmer all walk here to their work spot and switch into their working state on arrival.
 *
 * Ported from `serf_state_16_FreeWalking` @0x1d2eb; the direction tables are taken straight from the
 * executable.
 *
 * ## Direction tables
 *
 * `FUN_00007ae7` builds an eight-neighbour table of **byte offsets**: 4 = Right, 8 = DownRight,
 * 12 = Down, 16 = Left, 20 = UpLeft, 24 = Up (plus 0x1c = UpRight, 0x20 = DownLeft). The forward and
 * edge tables @0x1efb2 store those offsets, so **our `Direction` is `offset / 4 - 1`**. The
 * `dir_index` computation (sign and magnitude of dist_col/row) sits +12 shifted in the binary; after
 * converting, all three tables work out exactly.
 *
 * ## The union (`stateData`, all i8)
 *
 * `dist_col` = 0xb, `dist_row` = 0xc, `neg_dist1` = 0xd, `neg_dist2` = 0xe, `flags` = 0xf.
 * `dist_col/row` is the signed remaining offset to the target; `neg_dist1/2` is the remembered target
 * delta, where -128 means "on the way back"; `flags` holds the obstacle-edge state (bits 0..2 the edge
 * direction index plus one, bit 3 a left-hand edge, bits 4..7 an edge counter).
 */

import { i8, i16 } from './int.js';
import { COUNTER_FROM_ANIMATION } from './serf-tables.js';
import { posOf, colOf, rowOf, neighbor, oppositeDir, Direction } from './position.js';
import type { GameState, Serf, Flag } from './state.js';
import { setLostState } from './road-teardown.js';

// Union field indices (stateData index = field offset - 0xb).
const DIST_COL = 0; // 0xb
const DIST_ROW = 1; // 0xc
const NEG_DIST1 = 2; // 0xd
const NEG_DIST2 = 3; // 0xe
const FLAGS = 4; // 0xf

const gd = (serf: Serf, idx: number): number => i8(serf.stateData[idx]);
const sd = (serf: Serf, idx: number, value: number): void => {
  serf.stateData[idx] = value & 0xff;
};
/**
 * **A 16-bit store into the union** — for the places where the original writes a word (`66 89 43 xx`)
 * and thereby covers **two** union bytes. A byte store at the same spot leaves the high byte of the
 * previous state standing, which is a silent bug wherever the consumer reads the field as a word (see
 * the stonecutter transition @0x1e7e5).
 *
 * A raw scan finds `66 89 43 0e` **38 times**, eleven of them in the serf machine — ten write genuine
 * u16 fields, and exactly **one** (@0x1e7e5) writes a value that looks like a byte. A single case, not
 * a class.
 */
const setWord = (serf: Serf, idx: number, value: number): void => {
  serf.stateData[idx] = value & 0xff;
  serf.stateData[idx + 1] = (value >> 8) & 0xff;
};

// Serf states.
const S_WALKING = 2;
const S_READY_TO_ENTER = 6;
const S_FREE_WALKING = 16;
/** 53 KnightFreeWalking — shares the locomotion with 16 but has a waiting branch of its own. */
const S_KNIGHT_FREE_WALKING = 53;
const S_LOGGING = 17;
const S_PLANTING = 20;
const S_STONECUTTING = 23;
const S_LOST = 25;
const S_FREE_SAILING = 27;
const S_FISHING = 32;
const S_FARMING = 34;
const S_LOOKING_FOR_GEO_SPOT = 42;
const S_SAMPLING_GEO_SPOT = 43;
const S_KNIGHT_OCCUPY_ENEMY = 52;

// Serf types.
const T_LUMBERJACK = 5;
const T_STONECUTTER = 7;
const T_FORESTER = 8;
const T_FISHER = 11;
const T_FARMER = 14;
const T_GEOLOGIST = 20;
const T_KNIGHT_MIN = 22;
const T_KNIGHT_MAX = 26;

/**
 * `dir_forward[12][6]` — direction preferences per target sector (`dir_index` 0..11), from
 * @0x1efb2 + 96.
 */
const DIR_FORWARD: readonly (readonly number[])[] = [
  [5, 4, 0, 3, 1, 2],
  [4, 5, 3, 0, 2, 1],
  [4, 3, 5, 2, 0, 1],
  [3, 4, 2, 5, 1, 0],
  [3, 2, 4, 1, 5, 0],
  [2, 3, 1, 4, 0, 5],
  [2, 1, 3, 0, 4, 5],
  [1, 2, 0, 3, 5, 4],
  [1, 0, 2, 5, 3, 4],
  [0, 1, 5, 2, 4, 3],
  [0, 5, 1, 4, 2, 3],
  [5, 0, 4, 1, 3, 2],
];

/**
 * Edge-following table @0x1efb2 — **one** table of 12 rows of 8 bytes (6 directions plus 2 padding).
 * Rows 0..5 are right-handed, 6..11 left-handed.
 *
 * The original indexes it with **one** computation (@0x1d336/@0x1d344 and @0x1b024/@0x1b032):
 * `row = (flags & 8) ? (flags & 7) + 5 : (flags & 7) - 1`. That is why this is one table and not two:
 * the halves share the index space at the seam, and the sailor makes use of it — for him `flags & 7`
 * can be 0 with bit 3 set (he has no `dest_reached` branch), which lands on row **5**, the last
 * *right*-handed one.
 *
 * {@link DIR_FORWARD} follows immediately at @0x1f012, so the row count 12 is bounded by the next
 * symbol rather than guessed.
 */
const DIR_EDGE: readonly (readonly number[])[] = [
  [2, 1, 0, 5, 4, 3],
  [3, 2, 1, 0, 5, 4],
  [4, 3, 2, 1, 0, 5],
  [5, 4, 3, 2, 1, 0],
  [0, 5, 4, 3, 2, 1],
  [1, 0, 5, 4, 3, 2],
  [4, 5, 0, 1, 2, 3],
  [5, 0, 1, 2, 3, 4],
  [0, 1, 2, 3, 4, 5],
  [1, 2, 3, 4, 5, 0],
  [2, 3, 4, 5, 0, 1],
  [3, 4, 5, 0, 1, 2],
];

/**
 * `dir_from_offset[(dx + 1) + 3 * (dy + 1)]`, -1 meaning none — maps a one-step delta in
 * {-1, 0, 1} squared onto the hex direction that produces it.
 */
const DIR_FROM_OFFSET: readonly number[] = [4, 5, -1, 3, -1, 0, -1, 2, 1];

/**
 * Impassable map objects (`map_space_from_obj[obj] > Semipassable`): buildings and their flag
 * neighbours, water trees, stones and sandstone, water stones. Everything else is passable.
 */
const IMPASSABLE = new Set<number>([
  2, 3, 4, 28, 29, 30, 31, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 88, 89,
]);

/** `can_pass_map_pos` — is the map object on this tile passable? */
function canPass(state: GameState, pos: number): boolean {
  return !IMPASSABLE.has(state.mapTiles[pos].object);
}

/** A water tile: both triangles are water terrain 0..3. */
function isWaterTile(state: GameState, pos: number): boolean {
  const t = state.mapTiles[pos];
  return t.terrainUp <= 3 && t.terrainDown <= 3;
}

/** `is_in_water` — the tile lies fully in the water, so there is no way ashore. */
function isInWater(state: GameState, pos: number): boolean {
  const geo = state.geo;
  return (
    isWaterTile(state, pos) &&
    isWaterTile(state, neighbor(pos, Direction.UpLeft, geo)) &&
    state.mapTiles[neighbor(pos, Direction.Left, geo)].terrainDown <= 3 &&
    state.mapTiles[neighbor(pos, Direction.Up, geo)].terrainUp <= 3
  );
}

/** Is the tile taken by a serf? */
function hasSerf(state: GameState, pos: number): boolean {
  return state.mapTiles[pos].serfIndex !== 0;
}

/** `counter_from_animation[anim]` as u16. */
function cfa(anim: number): number {
  return (
    (anim >= 0 && anim < COUNTER_FROM_ANIMATION.length ? COUNTER_FROM_ANIMATION[anim] : 0) & 0xffff
  );
}

/** `get_walking_animation(dH, dir, switchPos)` = `4 + dH + 9·(dir + (switchPos && dir<3 ? 6 : 0))`. */
function walkingAnim(dH: number, dir: number, switchPos: boolean): number {
  const d = dir + (switchPos && dir < 3 ? 6 : 0);
  return (4 + dH + 9 * d) & 0xff;
}

/** Passable terrain — land, or open water when sailing. The caller has already checked for serfs. */
function passableTerrain(state: GameState, pos: number, water: boolean): boolean {
  if (water) return state.mapTiles[pos].object === 0;
  return !isInWater(state, pos) && canPass(state, pos);
}

/**
 * `start_walking(dir, slope, changePos)` — one step across terrain: animation `4 + 9 * dir + dH`,
 * `counter += (slope * cfa[anim]) >> 5`, and the serf onto the neighbouring tile.
 */
function startWalking(
  state: GameState,
  serf: Serf,
  dir: number,
  slope: number,
  changePos: boolean,
): void {
  const geo = state.geo;
  const pos = posOf(serf.col!, serf.row!, geo);
  const np = neighbor(pos, dir, geo);
  const dH = state.mapTiles[np].height - state.mapTiles[pos].height;
  const anim = walkingAnim(dH, dir, false);
  serf.animation = anim;
  serf.counter = (serf.counter + (((slope * cfa(anim)) >> 5) & 0xffff)) & 0xffff;
  if (changePos) {
    state.mapTiles[pos].serfIndex = 0;
    state.mapTiles[np].serfIndex = serf.index;
  }
  serf.col = colOf(np, geo);
  serf.row = rowOf(np, geo);
}

/** The dx/dy step delta of a direction. */
function dirDx(dir: number): number {
  return (dir < 3 ? 1 : -1) * (dir % 3 < 2 ? 1 : 0);
}
function dirDy(dir: number): number {
  return (dir < 3 ? 1 : -1) * (dir % 3 > 0 ? 1 : 0);
}

/**
 * `handle_serf_free_walking_switch_on_dir` — a usable direction was found: shrink the remaining delta,
 * walk, and on reaching (0, 0) set the marker `flags = BIT(3)`.
 *
 * **The sailor does not set that marker.** The land and water copies of the direction table are
 * otherwise identical; the land entry has `subb $0x1,0xb(%ebx) ; jne ... ; movb $0x8,0xf(%ebx)`
 * (@0x1ed37 ff.), the water entry only the decrement (@0x1b4fe). That fits the sailor's missing
 * `dest_reached` branch: a sailor arrives by finding land beneath him, not by his remaining delta
 * reaching zero.
 */
function switchOnDir(state: GameState, serf: Serf, dir: number, water = false): void {
  sd(serf, DIST_COL, gd(serf, DIST_COL) - dirDx(dir));
  sd(serf, DIST_ROW, gd(serf, DIST_ROW) - dirDy(dir));
  startWalking(state, serf, dir, 32, true);
  if (!water && gd(serf, DIST_COL) === 0 && gd(serf, DIST_ROW) === 0) {
    sd(serf, FLAGS, 8); // BIT(3) — the target-reached marker
  }
}

/** `is_waiting` — is the serf blocked, and in which direction? Used for swapping two serfs. */
function isWaiting(serf: Serf): { waiting: boolean; dir: number } {
  if ((serf.state === S_WALKING || serf.state === 3 || serf.state === 14) && gd(serf, 3) < 0) {
    // Transporting = 3, Delivering = 14; `s.walking.dir` is field_0xe.
    return { waiting: true, dir: (gd(serf, 3) + 6) & 7 };
  }
  if (
    (serf.state === S_FREE_WALKING || serf.state === 53 || serf.state === 22) &&
    serf.animation === 82
  ) {
    const dx = gd(serf, DIST_COL);
    const dy = gd(serf, DIST_ROW);
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      const d = DIR_FROM_OFFSET[dx + 1 + 3 * (dy + 1)];
      return { waiting: true, dir: d };
    }
    return { waiting: true, dir: -1 };
  }
  return { waiting: false, dir: -1 };
}

/** `switch_waiting` — release the waiting serf in direction `dir`, preparing the swap. */
function switchWaiting(serf: Serf, dir: number): boolean {
  if ((serf.state === S_WALKING || serf.state === 3 || serf.state === 14) && gd(serf, 3) < 0) {
    sd(serf, 3, oppositeDir(dir)); // field_0xe
    return true;
  }
  if (
    (serf.state === S_FREE_WALKING || serf.state === 53 || serf.state === 22) &&
    serf.animation === 82
  ) {
    sd(serf, DIST_COL, gd(serf, DIST_COL) - dirDx(dir));
    sd(serf, DIST_ROW, gd(serf, DIST_ROW) - dirDy(dir));
    if (gd(serf, DIST_COL) === 0 && gd(serf, DIST_ROW) === 0) sd(serf, FLAGS, 8);
    return true;
  }
  return false;
}

/**
 * `handle_serf_free_walking_switch_with_other` — no free tile, so swap places with a neighbouring serf
 * waiting in the opposite direction. With no partner, the waiting animation 82.
 */
function switchWithOther(state: GameState, serf: Serf): void {
  const geo = state.geo;
  const pos = posOf(serf.col!, serf.row!, geo);
  let dir = -1;
  let other: Serf | null = null;
  for (let i = 0; i < 6; i++) {
    const np = neighbor(pos, i, geo);
    if (hasSerf(state, np)) {
      const o = state.serfs[state.mapTiles[np].serfIndex];
      if (o) {
        const w = isWaiting(o);
        if (w.waiting && w.dir === oppositeDir(i) && switchWaiting(o, w.dir)) {
          dir = i;
          other = o;
          break;
        }
      }
    }
  }
  if (dir >= 0 && other) {
    sd(serf, DIST_COL, gd(serf, DIST_COL) - dirDx(dir));
    sd(serf, DIST_ROW, gd(serf, DIST_ROW) - dirDy(dir));
    if (gd(serf, DIST_COL) === 0 && gd(serf, DIST_ROW) === 0) sd(serf, FLAGS, 8);
    const np = neighbor(pos, dir, geo);
    state.mapTiles[pos].serfIndex = other.index;
    state.mapTiles[np].serfIndex = serf.index;
    const dHo =
      state.mapTiles[pos].height - state.mapTiles[posOf(other.col!, other.row!, geo)].height;
    other.animation = walkingAnim(dHo, oppositeDir(dir), true);
    const dH = state.mapTiles[np].height - state.mapTiles[pos].height;
    serf.animation = walkingAnim(dH, dir, true);
    other.counter = cfa(other.animation);
    serf.counter = cfa(serf.animation);
    other.col = colOf(pos, geo);
    other.row = rowOf(pos, geo);
    serf.col = colOf(np, geo);
    serf.row = rowOf(np, geo);
  } else {
    serf.animation = 82;
    serf.counter = cfa(82);
  }
}

/** Reverting the target delta when the last step turns out to be impassable. */
function revertOrLost(serf: Serf): void {
  if (gd(serf, NEG_DIST1) !== -128) {
    sd(serf, DIST_COL, gd(serf, DIST_COL) + gd(serf, NEG_DIST1));
    sd(serf, DIST_ROW, gd(serf, DIST_ROW) + gd(serf, NEG_DIST2));
    sd(serf, NEG_DIST1, 0);
    sd(serf, NEG_DIST2, 0);
    sd(serf, FLAGS, 0);
  } else {
    serf.state = S_LOST;
    sd(serf, NEG_DIST1, 0);
    serf.counter = 0;
  }
}

/**
 * `find_inventory` — the homecoming test of a serf on his way back, inlined in the FreeWalking handler
 * (`serf_state_16_FreeWalking` @0x1d2eb, branch from @0x1e3c0 on). **Three** conditions, all needed:
 *
 * ```
 * if (landscape[pos] < 0)                       bit 7 = a flag stands on the tile
 *   flag = &flags[game[pos] * 0x46]
 *   if ((flag[4] & 0x3f) != 0)                  the flag has at least ONE road endpoint
 *     if ((landscape[pos+1] & 0xe0) == ((serf[0] & 3) + 4) << 5)   own land
 *       serf[10] = 2 (Walking); serf[0xb] = -2; serf[0xc..0xf] = 0; counter = 0; return
 * serf[10] = 0x19 (25 = Lost); serf[0xb] = 0; counter = 0
 * ```
 *
 * The middle condition is what makes a flag a way home. It reads `flag[4]` (`endpointDirs`), not
 * `flag[3]` (`paths`) and certainly not the tile: the three are not the same. The tile additionally
 * carries the road to the flag's own building (bit 4), which neither flag byte holds; and a boat road
 * sets `paths` but not `endpointDirs` — a walker cannot get home across water.
 */
function findInventory(state: GameState, serf: Serf): void {
  const pos = posOf(serf.col!, serf.row!, state.geo);
  const tile = state.mapTiles[pos];
  const flag = tile.object === 1 ? state.flags[tile.objIndex] : null;
  if (
    flag != null &&
    flag.endpointDirs.some(Boolean) && // `flag[4] & 0x3f` — without a road the flag is no way home
    tile.owner === serf.owner + 1
  ) {
    serf.state = S_WALKING;
    sd(serf, 0, 0xfe); // field_0xb = dir1
    sd(serf, 1, 0); // field_0xc = dest
    sd(serf, 2, 0);
    sd(serf, 3, 0); // field_0xe = dir
    serf.counter = 0;
    return;
  }
  serf.state = S_LOST;
  sd(serf, NEG_DIST1, 0);
  serf.counter = 0;
}

/**
 * `drop_resource` (@0x1d1f9) — the returning field worker puts his load into the **first free** resource
 * slot of the flag on his current tile. `resPlus1` is the raw resource value, type + 1.
 *
 * It scans **all 8** slots; with none free the resource is **lost** and the player production counter
 * is **not** raised — a deliberate divergence from state 13 DropResourceOut, which always writes into
 * a slot <= 7.
 */
function dropResource(state: GameState, serf: Serf, resPlus1: number): void {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  const flag = state.flags[state.mapTiles[pos].objIndex];
  if (!flag) return;
  let i = 0;
  while (i < 8 && flag.resourceSlots[i] !== -1) i++;
  if (i >= 8) return; // flag full: the resource is lost, and no player increment
  const res = (resPlus1 & 0x1f) - 1;
  flag.resourceSlots[i] = res;
  flag.slotDir[i] = ((resPlus1 >> 5) & 7) - 1; // -1 (DirectionNone) for every res < 32
  flag.slotDest[i] = 0;
  flag.hasResources = true;
  const player = state.players[serf.owner];
  if (player) {
    const rc = player.resourceCount as number[];
    if (res >= 0 && res < rc.length && rc[res] !== 0xff) rc[res] = (rc[res] + 1) & 0xff;
  }
}

/**
 * `handle_serf_free_walking_state_dest_reached` — arrived at the target spot: a type-dependent
 * transition into the working state, or back into the inventory. Animation constants of the working
 * states come from the original (Logging 116, Planting 121, Fishing 131/132, Farming 135/136,
 * SamplingGeoSpot 141).
 *
 * On the way back (`neg_dist1 == -128`): `neg_dist2 < 0` goes to `find_inventory`; otherwise the load
 * is dropped at the building flag (only for `neg_dist2 > 0` — a forester carries nothing) and the serf
 * goes to ReadyToEnter(6).
 *
 * The original calls `stepInToBuilding` inline here, so entry can happen in the same tick; our
 * ReadyToEnter handler does it in the next one, at most one tick later.
 */
function destReached(state: GameState, serf: Serf): void {
  const geo = state.geo;
  const pos = posOf(serf.col!, serf.row!, geo);
  if (gd(serf, NEG_DIST1) === -128 && gd(serf, NEG_DIST2) < 0) {
    findInventory(state, serf);
    return;
  }
  const obj = state.mapTiles[pos].object;
  const returning = gd(serf, NEG_DIST1) === -128;
  const toReadyToEnter = (): void => {
    serf.state = S_READY_TO_ENTER;
    sd(serf, 0, 0); // field_B
    serf.counter = 0;
  };
  const restoreDelta = (): void => {
    sd(serf, DIST_COL, gd(serf, NEG_DIST1));
    sd(serf, DIST_ROW, gd(serf, NEG_DIST2));
  };
  const spotGone = (): void => {
    sd(serf, NEG_DIST1, -128);
    sd(serf, NEG_DIST2, 0);
    sd(serf, FLAGS, 0);
    serf.counter = 0;
  };

  switch (serf.type) {
    case T_LUMBERJACK:
      if (returning) {
        if (gd(serf, NEG_DIST2) > 0) dropResource(state, serf, 7); // Lumber (6)+1
        toReadyToEnter();
      } else {
        restoreDelta();
        if (obj >= 8 && obj <= 23) {
          serf.state = S_LOGGING;
          sd(serf, NEG_DIST1, obj < 16 ? -1 : 0);
          sd(serf, NEG_DIST2, 0);
          serf.animation = 116;
          serf.counter = cfa(116);
        } else spotGone();
      }
      break;
    case T_STONECUTTER:
      if (returning) {
        if (gd(serf, NEG_DIST2) > 0) dropResource(state, serf, 10); // Stone (9)+1
        toReadyToEnter();
      } else {
        restoreDelta();
        const up = neighbor(pos, Direction.UpLeft, geo);
        const uobj = state.mapTiles[up].object;
        if (!hasSerf(state, up) && uobj >= 72 && uobj <= 79) {
          serf.counter = 0;
          startWalking(state, serf, Direction.UpLeft, 32, true);
          serf.state = S_STONECUTTING;
          // A WORD, not a byte (`mov %ax,0xe(%ebx)` @0x1e7e5): the original stores `counter >> 2` as
          // u16 across `serf+0xe..0xf` and thereby **clears `flags`** (0xf). State 23 depends on it —
          // its approach phase reads a word too (@0x1c2a1) and compares it as a threshold against the
          // counter. A left-over high byte (typically `flags = 8` from free walking) makes the
          // threshold 0x800 too large, the comparison hits at once, and the stonecutter skips his
          // whole hacking animation.
          setWord(serf, NEG_DIST2, serf.counter >> 2);
          sd(serf, NEG_DIST1, 0);
        } else spotGone();
      }
      break;
    case T_FORESTER:
      if (returning) {
        toReadyToEnter();
      } else {
        restoreDelta();
        if (obj === 0) {
          serf.state = S_PLANTING;
          sd(serf, NEG_DIST2, 0);
          serf.animation = 121;
          serf.counter = cfa(121);
        } else spotGone();
      }
      break;
    case T_FISHER:
      if (returning) {
        if (gd(serf, NEG_DIST2) > 0) dropResource(state, serf, 1); // Fish (0)+1
        toReadyToEnter();
      } else {
        restoreDelta();
        let a = -1;
        if ((state.mapTiles[pos].paths & 0x3f) === 0) {
          if (
            state.mapTiles[pos].terrainDown <= 3 &&
            state.mapTiles[neighbor(pos, Direction.UpLeft, geo)].terrainUp >= 4
          ) {
            a = 132;
          } else if (
            state.mapTiles[neighbor(pos, Direction.Left, geo)].terrainDown <= 3 &&
            state.mapTiles[neighbor(pos, Direction.Up, geo)].terrainUp >= 4
          ) {
            a = 131;
          }
        }
        if (a < 0) spotGone();
        else {
          serf.state = S_FISHING;
          sd(serf, NEG_DIST1, 0);
          sd(serf, NEG_DIST2, 0);
          sd(serf, FLAGS, 0);
          serf.animation = a;
          serf.counter = cfa(a);
        }
      }
      break;
    case T_FARMER:
      if (returning) {
        if (gd(serf, NEG_DIST2) > 0) dropResource(state, serf, 4); // Wheat (3)+1
        toReadyToEnter();
      } else {
        restoreDelta();
        if (obj === 110 || (obj >= 121 && obj <= 126)) {
          serf.animation = 136;
          sd(serf, NEG_DIST1, 1);
          serf.counter = cfa(136);
        } else if (obj === 0 && (state.mapTiles[pos].paths & 0x3f) === 0) {
          serf.animation = 135;
          sd(serf, NEG_DIST1, 0);
          serf.counter = cfa(135);
        } else {
          spotGone();
          break;
        }
        serf.state = S_FARMING;
        sd(serf, NEG_DIST2, 0);
      }
      break;
    case T_GEOLOGIST:
      if (returning) {
        if (state.mapTiles[pos].object === 1 && state.mapTiles[pos].owner === serf.owner + 1) {
          serf.state = S_LOOKING_FOR_GEO_SPOT;
          serf.counter = 0;
        } else {
          serf.state = S_LOST;
          sd(serf, NEG_DIST1, 0);
          serf.counter = 0;
        }
      } else {
        restoreDelta();
        if (obj === 0) {
          serf.state = S_SAMPLING_GEO_SPOT;
          sd(serf, NEG_DIST1, 0);
          serf.animation = 141;
          serf.counter = cfa(141);
        } else spotGone();
      }
      break;
    default:
      if (serf.type >= T_KNIGHT_MIN && serf.type <= T_KNIGHT_MAX) {
        if (returning) findInventory(state, serf);
        else {
          serf.state = S_KNIGHT_OCCUPY_ENEMY;
          serf.counter = 0;
        }
      } else {
        findInventory(state, serf);
      }
      break;
  }
}

/**
 * `handle_free_walking_follow_edge` — feel along the edge of an obstacle, right- or left-handed
 * depending on `flags` bit 3. `true` means handled (common ends), `false` falls back to the forward
 * search.
 */
function followEdge(state: GameState, serf: Serf, water: boolean): boolean {
  const geo = state.geo;
  const pos = posOf(serf.col!, serf.row!, geo);
  const flags = gd(serf, FLAGS) & 0xff;
  // The original's row computation, unchanged: `(flags & 7) + 5` or `(flags & 7) - 1` into ONE
  // 12-row table (@0x1d336/@0x1d344, sailor @0x1b024/@0x1b032). See {@link DIR_EDGE}.
  const dirIndex = (flags & 8) !== 0 ? (flags & 7) + 5 : (flags & 7) - 1;

  const d1 = gd(serf, DIST_COL);
  const d2 = gd(serf, DIST_ROW);
  // Target only one step away?
  if (!water && Math.abs(d1) <= 1 && Math.abs(d2) <= 1) {
    const d = DIR_FROM_OFFSET[d1 + 1 + 3 * (d2 + 1)];
    if (d > -1) {
      const np = neighbor(pos, d, geo);
      if (!canPass(state, np)) {
        // Blocked (`bt $0x6` @0x1d471 => @0x1d481): revert, or become lost.
        revertOrLost(serf);
        if (gd(serf, FLAGS) === 0 && serf.state === S_FREE_WALKING) {
          serf.animation = 82;
          serf.counter = cfa(82);
        }
        return true;
      }
      // Not blocked but occupied: the free-field knight WAITS (@0x1d501) — the counterpart to
      // @0x1dae5 in the forward path, here without the deadlock breaker: `cmpb $0x35,0xa(%ebx)`
      // (state 53 only), `cmpb $0x80,0xd(%ebx)`, serf on the target tile => `serf[0xf] = 0` @0x1d52a,
      // `animation = 0x52` @0x1d532, `counter = 0x7f` @0x1d53a. Again only for the LAST step;
      // otherwise edge following continues normally (@0x1d549).
      if (
        serf.state === S_KNIGHT_FREE_WALKING &&
        gd(serf, NEG_DIST1) !== -128 &&
        hasSerf(state, np)
      ) {
        sd(serf, FLAGS, 0);
        serf.animation = 82;
        serf.counter = 0x7f;
        return true;
      }
    }
  }

  // Reachable are 0..11 (`flags & 7` is always `dir + 1`, i.e. 1..6). With a corrupted 7 the original
  // would index row 12, which in the image is already {@link DIR_FORWARD}`[0]`.
  const row = DIR_EDGE[dirIndex] ?? DIR_FORWARD[0]!;
  let i0 = -1;
  let dir = -1;
  for (let i = 0; i < 6; i++) {
    const cand = row[i];
    const np = neighbor(pos, cand, geo);
    if (passableTerrain(state, np, water) && !hasSerf(state, np)) {
      dir = cand;
      i0 = i;
      break;
    }
  }

  if (i0 > -1) {
    const upper = ((flags >> 4) & 0xf) + i0 - 2;
    if (i0 < 2 && upper < 0) {
      sd(serf, FLAGS, 0);
      switchOnDir(state, serf, dir, water);
      return true;
    }
    // On land only: when the upper counter overflows the original starts over (`flags = 0`, `jmp` to
    // the forward search @0x1d629). The sailor has no such branch — his `jae` has displacement **0**
    // (@0x1b10c `73 00`), so the jump falls into the normal case and the overflowed upper half stays.
    // Hence the 8-bit arithmetic below.
    if (!water && i0 > 2 && upper > 15) {
      sd(serf, FLAGS, 0);
      return false; // falls back to the forward search
    }
    // `serf[0xf] += (i0-2) << 4 ; &= 0xf8 ; |= dir+1` as 8-bit arithmetic, so the sailor branch wraps
    // exactly as the original does. On land this is identical to `(upper << 4) | ...`, because both
    // overflow cases have already branched away there.
    sd(serf, FLAGS, (((flags + ((i0 - 2) << 4)) & 0xf8) | (dir + 1)) & 0xff);
    switchOnDir(state, serf, dir, water);
    return true;
  }
  sd(serf, FLAGS, flags & 0xf8);
  sd(serf, FLAGS, gd(serf, FLAGS) & ~0x8);
  if (water) {
    // Sailor: no free neighbouring tile means WAIT (@0x1b150). He has no tile swap with an oncoming
    // serf (@0x1d670 -> `switch_with_other`).
    serf.animation = 82;
    serf.counter = 0x7f;
    return true;
  }
  switchWithOther(state, serf);
  return true;
}

/** Target sector `dir_index` (0..11) from the remaining delta (dist_col/row). */
function forwardDirIndex(d1: number, d2: number): number {
  if (d1 < 0) {
    if (d2 < 0) {
      if (-d2 < -d1) return -2 * d2 < -d1 ? 3 : 2;
      return -d2 < -2 * d1 ? 1 : 0;
    }
    return d2 >= -d1 ? 5 : 4;
  }
  if (d2 < 0) return -d2 >= d1 ? 11 : 10;
  if (d2 < d1) return 2 * d2 < d1 ? 9 : 8;
  return d2 < 2 * d1 ? 7 : 6;
}

/**
 * Deadlock breaker (@0x1db34..@0x1dc85) — on the TENTH attempt the waiting free-field knight clears
 * the blocking transporter out of the way.
 *
 * Precondition in the caller (@0x1dae5 ff.): state 53, `neg_dist1 != -128`, and a serf on the target
 * tile. Everything else goes to the evasion search @0x1dca1; the breaker itself always ends in the
 * waiting animation @0x1dc8a — it does not replace the waiting, it comes before it.
 *
 * Branch inventory (every entry is code below):
 *   @0x1db37 `cmpb $0x2,0xa(%ebx)` other.state == 2 (Walking)      -> counter
 *   @0x1db40 `cmpb $0x3,0xa(%ebx)` other.state == 3 (Transporting) -> counter, else @0x1dc8a (wait)
 *   @0x1db4d `addb $0x1,0xe(%ebx)` self.neg_dist2 += 1
 *   @0x1db54 `cmpb $0xa,0xe(%ebx)` != 10 -> @0x1dc8a (wait)
 *   @0x1db5e self.neg_dist2 = 0
 *   @0x1db6f other.state != 3 -> @0x1dc85 (straight to `set_lost_state`)
 *   @0x1db7f `landscape[np]` bit 7 clear (no flag) -> @0x1dc8a, NOT lost
 *   @0x1db8c other.flags == 0xff -> @0x1dc85
 *   @0x1dbec/@0x1dc54 both road ends: `length[dir] -= 1`, clear the carrier bit at `(... & 0xf) == 0`
 *   @0x1dc85 `call 0x4af66` == {@link setLostState} on the OTHER serf (slot 0x30 @0x1db69)
 */
function deadlockBrake(state: GameState, serf: Serf, np: number): void {
  const other = state.serfs[state.mapTiles[np].serfIndex];
  if (!other) return; // the caller checked `hasSerf`; a slot gap behaves like "no transporter"
  if (other.state !== 2 && other.state !== 3) return; // @0x1db44 -> wait only

  sd(serf, NEG_DIST2, gd(serf, NEG_DIST2) + 1); // @0x1db4d, byte addition
  if ((serf.stateData[NEG_DIST2] & 0xff) !== 0xa) return; // @0x1db58 -> wait only
  sd(serf, NEG_DIST2, 0); // @0x1db63

  if (other.state === 3) {
    // A transporter on a segment: first strike him from the road bookkeeping, then make him lost.
    // @0x1db83 no flag on the tile means wait only. The original tests bit 7 of landscape byte 0; our
    // parser masks `paths` with 0x3f, so that bit does not exist in the model. `object == 1` is
    // equivalent — verified against the original data as an exact iff, in both directions.
    if (state.mapTiles[np].object !== 1) return;
    if ((other.stateData[FLAGS] & 0xff) === 0xff) {
      setLostState(state, other);
      return;
    } // @0x1db90
    let dir = i8(other.stateData[NEG_DIST2]); // other[0xe] = carrier direction
    if (dir < 0) dir += 6; // @0x1dba9
    const flag = state.flags[state.mapTiles[np].objIndex];
    if (flag) {
      releaseCarrier(flag, dir);
      const conn = flag.connections[dir];
      const far = conn && conn.kind === 'flag' ? state.flags[conn.index] : null;
      if (far) releaseCarrier(far, flag.otherEndDir[dir]); // @0x1dc23 opposite direction, @0x1dc54
    }
  }
  setLostState(state, other); // @0x1dc85
}

/** `length[dir] -= 1` with byte underflow like `subb`; at a carrier count of 0 clear the carrier bit. */
function releaseCarrier(flag: Flag, dir: number): void {
  if (dir < 0 || dir > 5) return;
  flag.length[dir] = (flag.length[dir] - 1) & 0xff;
  if ((flag.length[dir] & 0xf) === 0) flag.transporters[dir] = false;
}

/**
 * `handle_free_walking_common` — one movement decision: target reached? follow the edge of an obstacle?
 * otherwise a forward step towards the target (preferred direction, then alternatives; with no way
 * through, a swap).
 *
 * Reused by state 53 KnightFreeWalking, but NOT identical: the body (@0x1d725 plus edge following from
 * @0x1d350) is the same, yet the blocking case of the LAST step has its own branch for state 53
 * (`cmpb $0x35` @0x1dae8 in the forward path, @0x1d504 in edge following). Knight arrival is covered in
 * {@link destReached}.
 */
export function freeWalkingCommon(state: GameState, serf: Serf, water = false): void {
  const flags = gd(serf, FLAGS) & 0xff;
  // On land only: `andb $0x7 ; je 0x1e490` @0x1d344/@0x1d347. The sailor body has just
  // `andb $0x7 ; addb $0x5` there (@0x1b032) — no `dest_reached`, and it is unreachable for him
  // anyway: his `switch_on_dir` never sets the marker `flags = 8`.
  if (!water && (flags & 8) !== 0 && (flags & 7) === 0) {
    destReached(state, serf);
    return;
  }
  // The original's three-way branch: the forward search runs ONLY at `flags == 0`. With bit 3 set it
  // always goes to edge following — for the sailor even when the lower three bits are zero (he lands
  // on row 5 of {@link DIR_EDGE} via `0 + 5`).
  if ((flags & 8) !== 0 || (flags & 7) !== 0) {
    if (followEdge(state, serf, water)) return;
  }

  const geo = state.geo;
  const pos = posOf(serf.col!, serf.row!, geo);
  const d1 = gd(serf, DIST_COL);
  const d2 = gd(serf, DIST_ROW);
  const dirIndex = forwardDirIndex(d1, d2);
  const row = DIR_FORWARD[dirIndex];

  // Try the preferred direction directly.
  const dir0 = row[0];
  const np0 = neighbor(pos, dir0, geo);
  if (passableTerrain(state, np0, water) && !hasSerf(state, np0)) {
    switchOnDir(state, serf, dir0, water);
    return;
  }

  // Target only one step away (block @0x1da5d, reached from the six-neighbour cascade @0x1d944).
  if (!water && Math.abs(d1) <= 1 && Math.abs(d2) <= 1) {
    const d = DIR_FROM_OFFSET[d1 + 1 + 3 * (d2 + 1)];
    if (d > -1) {
      const np = neighbor(pos, d, geo);
      if (!canPass(state, np)) {
        // Blocked (`bt $0x6` @0x1da65 => @0x1da71): revert, or become lost.
        revertOrLost(serf);
        return;
      }
      // Not blocked but occupied: the free-field knight WAITS where he stands (@0x1dae5).
      // `cmpb $0x35,0xa(%ebx)` (state 53 only), `cmpb $0x80,0xd(%ebx)` (`neg_dist1 != -128`),
      // `mov 0x2(%ebx),%ax` (serf on the target tile) => waiting animation `0x52` @0x1dc8a,
      // `counter = 0x7f` @0x1dc92. The branch applies to the LAST step only; with the target further
      // away the knight looks for an evasion direction like any free walker (@0x1dca1).
      if (
        serf.state === S_KNIGHT_FREE_WALKING &&
        gd(serf, NEG_DIST1) !== -128 &&
        hasSerf(state, np)
      ) {
        deadlockBrake(state, serf, np);
        serf.animation = 82; // @0x1dc8a — waiting animation, where ALL branches converge
        serf.counter = 0x7f; // @0x1dc92
        return;
      }
    }
  }

  // Alternative directions (row[1..5]).
  let i0 = -1;
  let dir = -1;
  for (let i = 0; i < 5; i++) {
    const cand = row[1 + i];
    const np = neighbor(pos, cand, geo);
    if (passableTerrain(state, np, water) && !hasSerf(state, np)) {
      dir = cand;
      i0 = i;
      break;
    }
  }
  if (i0 < 0) {
    if (water) {
      // Sailor: wait here too instead of swapping (@0x1b434). Unlike in edge following, the flags stay
      // untouched.
      serf.animation = 82;
      serf.counter = 0x7f;
      return;
    }
    switchWithOther(state, serf);
    return;
  }
  const edge = (dirIndex ^ i0) & 1;
  const upper = ((i0 / 2) | 0) + 1;
  sd(serf, FLAGS, ((upper << 4) | (edge << 3) | (dir + 1)) & 0xff);
  switchOnDir(state, serf, dir, water);
}

/**
 * Handler body for state 16 FreeWalking. The caller has already run the tick prologue (`advance`); one
 * movement decision per iteration while the counter has expired (i16 < 0) and the serf stays in the
 * state — the multi-step budget the original gets from reloading the counter.
 */
export function freeWalkingBody(state: GameState, serf: Serf): void {
  let guard = 0;
  while (i16(serf.counter) < 0 && serf.state === S_FREE_WALKING && guard++ < 64) {
    if (serf.col === null || serf.row === null) return;
    freeWalkingCommon(state, serf);
  }
}

/**
 * Handler body for state 27 FreeSailing (@0x1afa3) — terrain walking across WATER. In the binary it is
 * a second, separate copy of the land body (@0x1d2eb); the two differ in exactly five places, and an
 * instruction diff over both bodies finds no others:
 *
 * | # | land | water | in the port |
 * |---|---|---|---|
 * | 1 | passability: `is_in_water` plus the blocked bit on landscape byte 0 (@0x1d853) | `object == 0` on byte 3 (@0x1b345) | `passableTerrain(water)` |
 * | 2 | the "target one step away" pre-check (@0x1d350 / @0x1d894) | absent (@0x1b038 / @0x1b37c) | `if (!water ...)` |
 * | 3 | `dest_reached` at `flags == 8` (@0x1d347) | absent — and `switch_on_dir` never sets the marker (@0x1b4fe against @0x1ed37) | `freeWalkingCommon(water)` |
 * | 4 | edge overflow returns to the forward search (@0x1d621) | `jae` with displacement 0 (@0x1b10c), no jump back | `if (!water ...)`, 8-bit addition |
 * | 5 | no free tile => `switch_with_other` (@0x1d670 / @0x1d894) | waiting animation `0x52`, `counter = 0x7f` (@0x1b150 / @0x1b434) | `if (water ...)` |
 *
 * The water test at the head of the loop is the sixth peculiarity and belongs here because the original
 * re-evaluates it BEFORE EVERY STEP: the locomotion tail jumps back to @0x1afdb, behind the tick gate
 * and in front of the test. With the blocked bit of his own tile clear (@0x1afea `bt $0x6`) the sailor
 * has land beneath him — then `counter = 0`, state 25 Lost and `field_0xb = 0` (@0x1aff6..@0x1b010).
 * That is his only exit; there is no "target reached" as for the walker.
 */
export function freeSailingBody(state: GameState, serf: Serf): void {
  let guard = 0;
  while (i16(serf.counter) < 0 && serf.state === S_FREE_SAILING && guard++ < 64) {
    if (serf.col === null || serf.row === null) return;
    if (!state.mapTiles[posOf(serf.col, serf.row, state.geo)].blocked) {
      serf.counter = 0;
      serf.state = S_LOST;
      sd(serf, 0, 0); // field_0xb = 0, spiral search forwards
      return;
    }
    freeWalkingCommon(state, serf, true);
  }
}

/**
 * Handler body for state 22 StoneCutterFreeWalking (@0x1d137) — the stonecutter's variant of terrain
 * walking. Before every movement decision: if the UpLeft tile carries a stone object (`0x48..0x4f`) and
 * is free of serfs, the spot counts as reached — the remaining distance is folded into
 * `neg_dist1/neg_dist2`, `dist_col/row` go to 0 and `flags = 8`, so the next `freeWalkingCommon` runs
 * `dest_reached` and moves on to StoneCutting(23). Otherwise a normal terrain step.
 */
export function stoneCutterFreeWalkingBody(state: GameState, serf: Serf): void {
  let guard = 0;
  while (i16(serf.counter) < 0 && serf.state === 22 && guard++ < 64) {
    if (serf.col === null || serf.row === null) return;
    const geo = state.geo;
    const pos = posOf(serf.col, serf.row, geo);
    const up = neighbor(pos, Direction.UpLeft, geo);
    const uobj = state.mapTiles[up].object;
    if (state.mapTiles[up].serfIndex === 0 && uobj >= 0x48 && uobj <= 0x4f) {
      sd(serf, NEG_DIST1, (gd(serf, NEG_DIST1) + gd(serf, DIST_COL)) & 0xff);
      sd(serf, NEG_DIST2, (gd(serf, NEG_DIST2) + gd(serf, DIST_ROW)) & 0xff);
      sd(serf, DIST_COL, 0);
      sd(serf, DIST_ROW, 0);
      sd(serf, FLAGS, 8);
    }
    freeWalkingCommon(state, serf);
  }
}
