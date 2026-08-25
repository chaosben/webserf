/**
 * Serf sprite selection (pure lookups, backend independent) — reconstructed from the original
 * render procedure (`serf_get_body` + `draw_row_serf`).
 *
 * Pipeline per serf:
 *   frame  = animationTable[serf.animation][serf.counter >> 3]   -> { sprite (=t), x, y }
 *   body   = serfBody(type, state, t, ...)                       -> 16-bit body code (< 0 = do not draw)
 *   hi/lo  = (body>>8), (body&0xff)                              -> torso + head index via INDEX1/INDEX2
 *
 * The torso is team-coloured and the separate arms are glued on; the head sits relative to the torso
 * delta, and below everything a uniform shadow (index 0).
 *
 * Deliberate simplification: the sound branches of the original are dropped (no audio in the map
 * render). Resource- and free-walking-specific carrying poses come from the state fields but fall
 * back to the default work/walk pose on unknown values.
 */

import type { IndexedSprite } from './sprite-indexed.js';
import type { DecodedSprite, SerfRecord } from './types.js';

// --- asset base indices (0-based; spaIndex - 1) ---
/** Serf torso (transparent, colorOffset 64/72 for the two team-colour variants). */
export const SERF_TORSO_BASE = 2499;
/** Serf arms (transparent) — separate, glued onto the torso. */
export const SERF_ARMS_BASE = 1849;
/** Serf head (transparent). */
export const SERF_HEAD_BASE = 3149;
/** Serf shadow (overlay), always index 0. */
export const SERF_SHADOW_BASE = 3;

/** color_offset values of the two torso colour variants. */
export const TORSO_COLOR_OFFSET_A = 64;
export const TORSO_COLOR_OFFSET_B = 72;

// --- relevant serf state indices (order as in SERF_STATE_NAMES) ---
const STATE_TRANSPORTING = 3;
const STATE_LEAVING_BUILDING = 5;
const STATE_BUILDING_CASTLE = 10;
const STATE_DROP_RESOURCE_OUT = 13;
const STATE_DELIVERING = 14;
const STATE_FREE_WALKING = 16;
const STATE_STONE_CUTTING = 23;
const STATE_LOST_SAILOR = 26;
const STATE_FREE_SAILING = 27;
const STATE_MINING = 29;
const STATE_IDLE_ON_PATH = 66;

// --- resource type indices (0-based) for the carrying poses ---
const RES_STONE = 9;
const RES_IRON_ORE = 10;
const RES_STEEL = 11;
const RES_COAL = 12;
const RES_GOLD_ORE = 13;
const RES_SHOVEL = 15;
const RES_HAMMER = 16;
const RES_ROD = 17;
const RES_CLEAVER = 18;
const RES_SCYTHE = 19;
const RES_AXE = 20;
const RES_SAW = 21;
const RES_PICK = 22;
const RES_PINCER = 23;
const RES_SWORD = 24;

// prettier-ignore
const TRANSPORTER_TYPE: readonly number[] = [
  0, 0x3000, 0x3500, 0x3b00, 0x4100, 0x4600, 0x4b00, 0x1400,
  0x700, 0x5100, 0x800, 0x1c00, 0x1d00, 0x1e00, 0x1a00, 0x1b00,
  0x6800, 0x6d00, 0x6500, 0x6700, 0x6b00, 0x6a00, 0x6600, 0x6900,
  0x6c00, 0x5700, 0x5600, 0, 0, 0, 0, 0,
];

// prettier-ignore
const SAILOR_TYPE: readonly number[] = [
  0, 0x3100, 0x3600, 0x3c00, 0x4200, 0x4700, 0x4c00, 0x1500,
  0x900, 0x7700, 0xa00, 0x2100, 0x2200, 0x2300, 0x1f00, 0x2000,
  0x6e00, 0x6f00, 0x7000, 0x7100, 0x7200, 0x7300, 0x7400, 0x7500,
  0x7600, 0x5f00, 0x6000, 0, 0, 0, 0, 0,
];

// Torso/head base per upper body byte (pairs {torso, head}; head < 0 = no head).
// prettier-ignore
export const INDEX1: readonly number[] = [
  0, 0, 48, 6, 96, -1, 48, 24,
  240, -1, 48, 30, 248, -1, 48, 12,
  48, 18, 96, 306, 96, 300, 48, 54,
  48, 72, 48, 36, 0, 48, 272, -1,
  48, 60, 264, -1, 48, 42, 280, -1,
  48, 66, 96, 312, 500, 600, 48, 318,
  48, 78, 0, 84, 48, 90, 48, 96,
  48, 102, 48, 108, 48, 114, 96, 324,
  96, 330, 96, 336, 96, 342, 96, 348,
  48, 354, 48, 360, 48, 366, 48, 372,
  48, 378, 48, 384, 504, 604, 509, -1,
  48, 120, 288, -1, 288, 420, 48, 126,
  48, 132, 96, 426, 0, 138, 304, -1,
  48, 390, 48, 144, 96, 432, 48, 198,
  510, 608, 48, 204, 48, 402, 48, 150,
  96, 438, 48, 156, 312, -1, 320, -1,
  48, 162, 48, 168, 96, 444, 0, 174,
  513, -1, 48, 408, 48, 180, 96, 450,
  0, 186, 520, -1, 48, 414, 48, 192,
  96, 456, 328, -1, 48, 210, 344, -1,
  48, 6, 48, 6, 48, 216, 528, -1,
  48, 534, 48, 528, 48, 288, 48, 282,
  48, 222, 533, -1, 48, 540, 48, 546,
  48, 552, 48, 558, 48, 564, 96, 468,
  96, 462, 48, 570, 48, 576, 48, 582,
  48, 396, 48, 228, 48, 234, 48, 240,
  48, 246, 48, 252, 48, 258, 48, 264,
  48, 270, 48, 276, 96, 474, 96, 480,
  96, 486, 96, 492, 96, 498, 96, 504,
  96, 510, 96, 516, 96, 522, 96, 612,
  144, 294, 144, 588, 144, 594, 144, 618,
  144, 624, 401, 294, 352, 297, 401, 588,
  352, 591, 401, 594, 352, 597, 401, 618,
  352, 621, 401, 624, 352, 627, 450, -1,
  192, -1,
];

// Torso-/Kopf-Feinindex je unterem Body-Byte (Paare {torsoAdd, headAdd}).
// prettier-ignore
export const INDEX2: readonly number[] = [
  0, 0, 1, 0, 2, 0, 3, 0,
  4, 0, 5, 0, 6, 0, 7, 0,
  8, 1, 9, 1, 10, 1, 11, 1,
  12, 1, 13, 1, 14, 1, 15, 1,
  16, 2, 17, 2, 18, 2, 19, 2,
  20, 2, 21, 2, 22, 2, 23, 2,
  24, 3, 25, 3, 26, 3, 27, 3,
  28, 3, 29, 3, 30, 3, 31, 3,
  32, 4, 33, 4, 34, 4, 35, 4,
  36, 4, 37, 4, 38, 4, 39, 4,
  40, 5, 41, 5, 42, 5, 43, 5,
  44, 5, 45, 5, 46, 5, 47, 5,
  0, 0, 1, 0, 2, 0, 3, 0,
  4, 0, 5, 0, 6, 0, 2, 0,
  0, 1, 1, 1, 2, 1, 3, 1,
  4, 1, 5, 1, 6, 1, 2, 1,
  0, 2, 1, 2, 2, 2, 3, 2,
  4, 2, 5, 2, 6, 2, 2, 2,
  0, 3, 1, 3, 2, 3, 3, 3,
  4, 3, 5, 3, 6, 3, 2, 3,
  0, 0, 1, 0, 2, 0, 3, 0,
  4, 0, 5, 0, 6, 0, 7, 0,
  8, 0, 9, 0, 10, 0, 11, 0,
  12, 0, 13, 0, 14, 0, 15, 0,
  16, 0, 17, 0, 18, 0, 19, 0,
  20, 0, 21, 0, 22, 0, 23, 0,
  24, 0, 25, 0, 26, 0, 27, 0,
  28, 0, 29, 0, 30, 0, 31, 0,
  32, 0, 33, 0, 34, 0, 35, 0,
  36, 0, 37, 0, 38, 0, 39, 0,
  40, 0, 41, 0, 42, 0, 43, 0,
  44, 0, 45, 0, 46, 0, 47, 0,
  48, 0, 49, 0, 50, 0, 51, 0,
  52, 0, 53, 0, 54, 0, 55, 0,
  56, 0, 57, 0, 58, 0, 59, 0,
  60, 0, 61, 0, 62, 0, 63, 0,
  64, 0,
];

/** Serf type indices (order as in `types.ts`). */
const TYPE_TRANSPORTER = 0;
const TYPE_SAILOR = 1;
const TYPE_DIGGER = 2;
const TYPE_BUILDER = 3;
const TYPE_TRANSPORTER_INVENTORY = 4;
const TYPE_LUMBERJACK = 5;
const TYPE_SAWMILLER = 6;
const TYPE_STONECUTTER = 7;
const TYPE_FORESTER = 8;
const TYPE_MINER = 9;
const TYPE_SMELTER = 10;
const TYPE_FISHER = 11;
const TYPE_PIGFARMER = 12;
const TYPE_BUTCHER = 13;
const TYPE_FARMER = 14;
const TYPE_MILLER = 15;
const TYPE_BAKER = 16;
const TYPE_BOATBUILDER = 17;
const TYPE_TOOLMAKER = 18;
const TYPE_WEAPONSMITH = 19;
const TYPE_GEOLOGIST = 20;
const TYPE_GENERIC = 21;
const TYPE_KNIGHT0 = 22;
const TYPE_KNIGHT4 = 26;
const TYPE_DEAD = 27;

/** Input for `serfBody` — filled from the serf header and the raw union bytes 11..15. */
export interface SerfBodyContext {
  readonly type: number;
  readonly state: number;
  /** Animation frame sprite code `t` (0..255). */
  readonly animSprite: number;
  /**
   * Carried resource — **union byte 11 raw and signed** (1-based, 0 = nothing).
   * Ungated: which state may carry is decided by the type branch below, as in the original.
   */
  readonly delivery: number;
  readonly negDist1: number;
  readonly negDist2: number;
  readonly leavingNextState: number;
  readonly leavingFieldB: number;
  readonly miningRes: number;
}

function isCarryFreeWalk(c: SerfBodyContext): boolean {
  return c.state === STATE_FREE_WALKING && c.negDist1 === -128 && c.negDist2 === 1;
}
function isDropOut(c: SerfBodyContext): boolean {
  return c.state === STATE_LEAVING_BUILDING && c.leavingNextState === STATE_DROP_RESOURCE_OUT;
}

/**
 * Translates a serf into its 16-bit body code (port of `serf_get_body`, without sound).
 * Returns `< 0` when the serf is not drawn (e.g. idle on a path / inside the castle build).
 */
export function serfBody(c: SerfBodyContext): number {
  let t = c.animSprite;
  const st = c.state;
  const type = c.type;

  if (type === TYPE_TRANSPORTER || type === TYPE_GENERIC) {
    if (st === STATE_IDLE_ON_PATH) return -1;
    if ((st === STATE_TRANSPORTING || st === STATE_DELIVERING) && c.delivery !== 0) {
      t += TRANSPORTER_TYPE[c.delivery] ?? 0;
    }
  } else if (type === TYPE_SAILOR) {
    if (
      (st === STATE_TRANSPORTING && c.delivery === 0) ||
      st === STATE_LOST_SAILOR ||
      st === STATE_FREE_SAILING
    ) {
      t += 0x200;
    } else if (st === STATE_TRANSPORTING) {
      t += SAILOR_TYPE[c.delivery] ?? 0;
    } else {
      t += 0x100;
    }
  } else if (type === TYPE_DIGGER) {
    t += t < 0x80 ? 0x300 : 0x380;
  } else if (type === TYPE_BUILDER) {
    t += t < 0x80 ? 0x500 : 0x580;
  } else if (type === TYPE_TRANSPORTER_INVENTORY) {
    if (st === STATE_BUILDING_CASTLE) return -1;
    t += TRANSPORTER_TYPE[c.delivery] ?? 0;
  } else if (type === TYPE_LUMBERJACK) {
    if (t < 0x80) t += isCarryFreeWalk(c) ? 0x1000 : 0xb00;
    else t += 0xe80;
  } else if (type === TYPE_SAWMILLER) {
    if (t < 0x80) t += isDropOut(c) ? 0x1700 : 0xc00;
    else t += 0x1580;
  } else if (type === TYPE_STONECUTTER) {
    if (t < 0x80) {
      t += isCarryFreeWalk(c) || (st === STATE_STONE_CUTTING && c.negDist1 === 2) ? 0x1200 : 0xd00;
    } else t += 0x1280;
  } else if (type === TYPE_FORESTER) {
    t += t < 0x80 ? 0xe00 : 0x1080;
  } else if (type === TYPE_MINER) {
    if (t < 0x80) {
      let res = -1;
      if (st === STATE_MINING) res = c.miningRes - 1;
      else if (isDropOut(c)) res = c.leavingFieldB - 1;
      if (res === RES_STONE) t += 0x2700;
      else if (res === RES_IRON_ORE) t += 0x2500;
      else if (res === RES_COAL) t += 0x2600;
      else if (res === RES_GOLD_ORE) t += 0x2400;
      else t += 0x1800;
    } else t += 0x2a80;
  } else if (type === TYPE_SMELTER) {
    if (t < 0x80) {
      if (isDropOut(c)) t += c.leavingFieldB === 1 + RES_STEEL ? 0x2900 : 0x2800;
      else t += 0x1900;
    } else t += 0x2980;
  } else if (type === TYPE_FISHER) {
    if (t < 0x80) t += isCarryFreeWalk(c) ? 0x2f00 : 0x2c00;
    else t += c.negDist2 === 1 ? 0x2d80 : 0x2c80;
  } else if (type === TYPE_PIGFARMER) {
    if (t < 0x80) t += isDropOut(c) ? 0x3400 : 0x3200;
    else t += 0x3280;
  } else if (type === TYPE_BUTCHER) {
    if (t < 0x80) t += isDropOut(c) ? 0x3a00 : 0x3700;
    else t += 0x3780;
  } else if (type === TYPE_FARMER) {
    if (t < 0x80) t += isCarryFreeWalk(c) ? 0x4000 : 0x3d00;
    else if (c.negDist1 === 0) t += 0x3d80;
    else t += 0x3e80;
  } else if (type === TYPE_MILLER) {
    if (t < 0x80) t += isDropOut(c) ? 0x4500 : 0x4300;
    else t += 0x4380;
  } else if (type === TYPE_BAKER) {
    if (t < 0x80) t += isDropOut(c) ? 0x4a00 : 0x4800;
    else t += 0x4880;
  } else if (type === TYPE_BOATBUILDER) {
    if (t < 0x80) t += isDropOut(c) ? 0x5000 : 0x4e00;
    else t += 0x4e80;
  } else if (type === TYPE_TOOLMAKER) {
    if (t < 0x80) {
      if (isDropOut(c)) {
        const res = c.leavingFieldB - 1;
        if (res === RES_SHOVEL) t += 0x5a00;
        else if (res === RES_HAMMER) t += 0x5b00;
        else if (res === RES_ROD) t += 0x5c00;
        else if (res === RES_CLEAVER) t += 0x5d00;
        else if (res === RES_SCYTHE) t += 0x5e00;
        else if (res === RES_AXE) t += 0x6100;
        else if (res === RES_SAW) t += 0x6200;
        else if (res === RES_PICK) t += 0x6300;
        else if (res === RES_PINCER) t += 0x6400;
        else t += 0x5800;
      } else t += 0x5800;
    } else t += 0x5880;
  } else if (type === TYPE_WEAPONSMITH) {
    if (t < 0x80) {
      if (isDropOut(c)) t += c.leavingFieldB === 1 + RES_SWORD ? 0x5500 : 0x5400;
      else t += 0x5200;
    } else t += 0x5280;
  } else if (type === TYPE_GEOLOGIST) {
    t += t < 0x80 ? 0x3900 : 0x4c80;
  } else if (type >= TYPE_KNIGHT0 && type <= TYPE_KNIGHT4) {
    const k = type - TYPE_KNIGHT0;
    if (t < 0x80) t += 0x7800 + 0x100 * k;
    else if (t < 0xc0) t += 0x7cd0 + 0x200 * k;
    else t += 0x7d90 + 0x200 * k;
  } else if (type === TYPE_DEAD) {
    t += 0x8700;
  } else {
    return -1;
  }

  return t;
}

/**
 * Splits a body code into torso and head sprite index (port of `draw_row_serf`).
 * Returns `null` when the code lies outside the lookup ranges (defensive).
 */
export function bodyToSprites(body: number): { torso: number; head: number } | null {
  const hi = ((body >> 8) & 0xff) * 2;
  const lo = (body & 0xff) * 2;
  if (hi + 1 >= INDEX1.length || lo + 1 >= INDEX2.length) return null;
  let torso = INDEX1[hi];
  let head = INDEX1[hi + 1];
  torso += INDEX2[lo];
  if (head >= 0) head += INDEX2[lo + 1];
  return { torso, head };
}

/** Draw info for one serf: sprite indices + frame pixel offset, or `null` (do not draw). */
export interface SerfDrawInfo {
  readonly torso: number;
  readonly head: number;
  readonly dx: number;
  readonly dy: number;
  /**
   * Raw frame sprite code `t` from the animation table, **before** the type-dependent offsets of
   * {@link serfBody}. The original branches on its band rather than on the serf state in several
   * places — among them the fight pass (`fight-overlay.isFightPose`, `0x80 <= t < 0xc0`).
   */
  readonly animSprite: number;
}

/** Minimal slice of the animation table that `serfDrawInfo` needs. */
export interface AnimationLike {
  readonly animations: readonly (readonly { readonly sprite: number; readonly x: number; readonly y: number }[])[];
}

/**
 * Torso/head sprite + frame offset for one serf, from the animation table and its raw union bytes.
 * `null` = do not draw (no frame / body code `< 0` / outside the lookup range).
 *
 * `animPhaseOffset` drives the **animation in place**: the body is taken from the frame advanced by
 * that many phases, while the **position offset (`dx/dy`) stays anchored to the stored phase** — the
 * serf moves its limbs but does not slide off its tile (real movement would be simulation).
 */
export function serfDrawInfo(
  serf: SerfRecord,
  anim: AnimationLike,
  animPhaseOffset = 0,
): SerfDrawInfo | null {
  const table = anim.animations[serf.animation];
  if (table === undefined || table.length === 0) return null;
  let phase = serf.counter >> 3;
  if (phase < 0) phase = 0;
  if (phase >= table.length) phase = table.length - 1;
  const posFrame = table[phase]; // position anchored to the stored phase
  const len = table.length;
  // The original counts `counter` DOWN (frame = counter>>3), so the animation plays in descending
  // index order (high index = start, 0 = end). Hence the progress is subtracted — otherwise the
  // animation would run backwards (sawmill: the log would grow instead of shrink).
  const bodyPhase = animPhaseOffset === 0 ? phase : (((phase - animPhaseOffset) % len) + len) % len;
  const frame = table[bodyPhase]; // body sprite from the advancing phase

  /**
   * **The five union bytes 11..15 raw** — exactly the original's view, which knows no decoded
   * variant: `serf_get_body` reads the bytes one by one and puts the state test next to them (often
   * even AFTER them, see below).
   *
   * | here | byte | original |
   * |---|---|---|
   * | {@link delivery} | 11 | `mov 0xb(%ebx),%al` @0x25f84 (carrier) / @0x26074 (sailor) |
   * | `leavingFieldB` | 11 | `mov 0xb(%ebx),%al` @0x26523 · `cmpb $0xc,0xb(%ebx)` @0x26564 |
   * | `negDist1` | 13 | `cmpb $0x80,0xd(%ebx)` @0x262a6 · `cmpb $0x2,0xd(%ebx)` @0x2641f |
   * | `miningRes` | 13 | `mov 0xd(%ebx),%al` @0x264c6 |
   * | `negDist2` | 14 | `cmpb $0x1,0xe(%ebx)` @0x262af (gated) · @0x265bc (**ungated**) |
   * | `leavingNextState` | 15 | `cmpb $0xd,0xf(%ebx)` @0x2651a ff. |
   *
   * **Why raw and not via a decoded state view**: the original has two kinds of read site, and the
   * second cannot be expressed through a state category —
   * - **gated**: the carry walk `[0xd]==0x80 && [0xe]==1 && [0xa]==0x10` (@0x262a6..@0x262b8; the
   *   state test comes LAST there) and the stonecutter `[0xa]==0x17 && [0xd]==2` (@0x26416);
   * - **ungated**: the fisher tests `[0xe]==1` (@0x265bc) and the farmer `[0xd]==0` (@0x266e8) in the
   *   `t >= 0x80` band **without any state test**. Through a decoded view both bytes would be 0
   *   outside the free-walking states — a condition the original does not have.
   *
   * The sign matters: state 12 `WaitForResourceOut` carries `0xff` in byte 11, with which the
   * original indexes one word BEFORE the table (0x25b68) and finds `0x0000` there — the same zero
   * our out-of-range field access yields.
   */
  const u8 = (i: number): number => serf.stateData?.[i] ?? 0;
  const i8 = (i: number): number => (u8(i) << 24) >> 24;
  const delivery = i8(0);
  const leavingFieldB = i8(0);
  const negDist1 = i8(2);
  const miningRes = i8(2);
  const negDist2 = i8(3);
  const leavingNextState = u8(4);

  const body = serfBody({
    type: serf.type,
    state: serf.state,
    animSprite: frame.sprite,
    delivery,
    negDist1,
    negDist2,
    leavingNextState,
    leavingFieldB,
    miningRes,
  });
  if (body < 0) return null;
  const sprites = bodyToSprites(body);
  if (sprites === null) return null;
  // Constant vertical correction for active serfs: after the height offset the original subtracts
  // another **2px** from the serf screen y (`sub [serf_y], 2` right after `- 4*height`, BEFORE adding
  // the animation y). Without it every active serf sits 2px too low; most visible on the worker
  // inside a building, whose lowest body row would cover the window sill.
  const dy = posFrame.y - SERF_Y_CORRECTION;
  return { torso: sprites.torso, head: sprites.head, dx: posFrame.x, dy, animSprite: frame.sprite };
}

/** Constant vertical subtraction of the original serf drawing (`sub serf_y, 2` after `- 4*height`). */
export const SERF_Y_CORRECTION = 2;

// --- idle carriers on paths — own wobble animation instead of serf_get_body ---
// (Original `draw_serf_row`, the `map->get_idle_serf(pos)` branch.) The save does NOT store the
// idle_serf bit; the resting carriers are the IdleOnPath serf records (states 66..69) carrying their
// resting position. Body and offset are derived from tick and path here.

// prettier-ignore
const IDLE_ARR_1: readonly number[] = [
  0x240, 0x40, 0x380, 0x140, 0x300, 0x80, 0x180, 0x200,
  0, 0x340, 0x280, 0x100, 0x1c0, 0x2c0, 0x3c0, 0xc0,
];

// prettier-ignore
const IDLE_ARR_2: readonly number[] = [
  0x8800, 0x8800, 0x8800, 0x8800, 0x8801, 0x8802, 0x8803, 0x8804,
  0x8804, 0x8804, 0x8804, 0x8804, 0x8803, 0x8802, 0x8801, 0x8800,
  0x8800, 0x8800, 0x8800, 0x8800, 0x8801, 0x8802, 0x8803, 0x8804,
  0x8805, 0x8806, 0x8807, 0x8808, 0x8809, 0x8808, 0x8809, 0x8808,
  0x8809, 0x8807, 0x8806, 0x8805, 0x8804, 0x8804, 0x8804, 0x8804,
  0x28, 0x29, 0x2a, 0x2b, 0x4, 0x5, 0xe, 0xf,
  0x10, 0x11, 0x1a, 0x1b, 0x23, 0x25, 0x26, 0x27,
  0x8800, 0x8800, 0x8800, 0x8800, 0x8801, 0x8802, 0x8803, 0x8804,
  0x8803, 0x8802, 0x8801, 0x8800, 0x8800, 0x8800, 0x8800, 0x8800,
  0x8801, 0x8802, 0x8803, 0x8804, 0x8804, 0x8804, 0x8804, 0x8804,
  0x8805, 0x8806, 0x8807, 0x8808, 0x8809, 0x8807, 0x8806, 0x8805,
  0x8804, 0x8803, 0x8802, 0x8802, 0x8802, 0x8802, 0x8801, 0x8800,
  0x8800, 0x8800, 0x8800, 0x8801, 0x8802, 0x8803, 0x8803, 0x8803,
  0x8803, 0x8804, 0x8804, 0x8804, 0x8805, 0x8806, 0x8807, 0x8808,
  0x8809, 0x8808, 0x8809, 0x8808, 0x8809, 0x8807, 0x8806, 0x8805,
  0x8803, 0x8803, 0x8803, 0x8802, 0x8802, 0x8801, 0x8801, 0x8801,
];

// prettier-ignore
const IDLE_ARR_3: readonly number[] = [
  0, 0, 0, 0, 0, 0, -2, 1, 0, 0, 2, 2, 0, 5, 0, 0,
  0, 0, 0, 3, -2, 2, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0,
  0, 0, -1, 2, -2, 1, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0,
  1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, -1, 2, -2, 1, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0,
  1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

/** Idle carrier states (resting on a path / waking up). */
export function isIdlePathState(state: number): boolean {
  return state >= 66 && state <= 69;
}

/**
 * States in which the serf works INSIDE a building (drawn in the window, position constant from the
 * animation table). Indices as in `SERF_STATE_NAMES`.
 *
 * For these states the original draws **no ground shadow**: it would land on the building wall and
 * paint over the window frame. Verified against the original (smelter in the window) — comparing two
 * original states with and without a worker shows only the worker's body, no wall shadow. Carriers
 * and walkers on the ground keep their shadow.
 */
const IN_BUILDING_WORK_STATES: ReadonlySet<number> = new Set([
  24, // Sawing
  29, // Mining
  30, // Smelting
  34, // Milling
  35, // Baking
  36, // PigFarming
  37, // Butchering
  38, // MakingWeapon
  39, // MakingTool
  40, // BuildingBoat
]);

/** true when the serf works inside a building in this state -> draw **no** ground shadow. */
export function worksInsideBuilding(state: number): boolean {
  return IN_BUILDING_WORK_STATES.has(state);
}

/** Draw info for a resting carrier (body code + pixel offset relative to the tile vertex). */
export function idleSerfInfo(
  serfType: number,
  posIndex: number,
  paths: number,
  tick: number,
): { body: number; dx: number; dy: number } {
  if (serfType === TYPE_SAILOR) {
    return { body: 0x203, dx: 0, dy: 0 };
  }
  const body = IDLE_ARR_2[((tick + IDLE_ARR_1[posIndex & 0xf]) >> 3) & 0x7f];
  const p = (paths & 0x3f) * 2;
  return { body, dx: IDLE_ARR_3[p], dy: IDLE_ARR_3[p + 1] };
}

/**
 * Builds the finished torso sprite **in palette index space** — the original's way.
 *
 * The torso sprite carries **only the team region**: across the whole bank (469 sprites, 5181 opaque
 * pixels) only the raw bytes **0 and 1** occur. The decode offset maps them straight onto the
 * owner's ramp; the rest of the body comes from the **arm** sprite (bank 1849.., raw bytes 1..228,
 * no offset), which is glued on top.
 *
 * So there is **nothing to recolour** here — an RGB path would have to decode the torso twice
 * (offsets 64 and 72) and recover the team region from the pixel difference, only because it cannot
 * see the indices.
 */
export function buildTorsoIndexed(
  torsoIdx: number,
  rampBase: number,
  decode: (idx: number, colorOffset: number) => IndexedSprite | null,
  stick: (base: IndexedSprite, top: IndexedSprite) => IndexedSprite,
): IndexedSprite | null {
  const torso = decode(SERF_TORSO_BASE + torsoIdx, rampBase);
  if (torso === null) return null;
  const arms = decode(SERF_ARMS_BASE + torsoIdx, 0);
  return arms === null ? torso : stick(torso, arms);
}

/**
 * RGBA variant of {@link buildTorsoIndexed}: two colour variants of the torso -> mask -> player
 * colour, then the separate arms glued on. `decode`, `recolor` and `stick` are callbacks so this
 * module stays pure.
 */
export function buildTorso(
  torsoIdx: number,
  rgb: readonly [number, number, number],
  decode: (idx: number, colorOffset: number) => DecodedSprite | null,
  recolor: (a: DecodedSprite, b: DecodedSprite, rgb: readonly [number, number, number]) => DecodedSprite,
  stick: (base: DecodedSprite, top: DecodedSprite) => DecodedSprite,
): DecodedSprite | null {
  const a = decode(SERF_TORSO_BASE + torsoIdx, TORSO_COLOR_OFFSET_A);
  const b = decode(SERF_TORSO_BASE + torsoIdx, TORSO_COLOR_OFFSET_B);
  if (a === null || b === null) return null;
  let torso = recolor(a, b, rgb);
  const arms = decode(SERF_ARMS_BASE + torsoIdx, 0);
  if (arms !== null) torso = stick(torso, arms);
  return torso;
}
