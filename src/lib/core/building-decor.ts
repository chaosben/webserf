/**
 * Building decoration and animation (pure lookups, backend independent). Complements
 * `building-sprites.ts` with the lively details: rotating mill, smoke/steam of active production,
 * waiting building materials at a site and occupation flags on military buildings.
 *
 * All decoration sprites (except the mill, which is a building sprite of its own per rotation phase)
 * live in the game object space and are addressed through `gameSprite()`. The animation frames follow
 * `(tick >> shift) & mask`, so they are reproducible from the running tick.
 */

import { gameSprite, resourceSprite } from './flag-sprites.js';

/** Building type index of the mill (= `MAP_BUILDING_SPRITE` index). */
export const MILL_TYPE = 15;

/** Resource types (index into `RESOURCE_TYPE_NAMES`) of the building materials. */
export const RESOURCE_STONE = 9;
export const RESOURCE_PLANK = 7;

/** A placed decoration sprite: archive index + pixel offset relative to the building anchor. */
export interface DecorSprite {
  readonly idx: number;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Mill rotation offset (0..3) to add to `MAP_BUILDING_SPRITE[MILL_TYPE]` (object AND shadow). Changes
 * every 16 ticks; `0` when the mill is not grinding (then it stands still).
 */
export function millRotationOffset(tick: number, active: boolean): number {
  return active ? (tick >> 4) & 3 : 0;
}

/**
 * Active overlay (smoke/steam, or the mine lift "up") per building type, drawn while the building is
 * `active`. `base` is the sprite index in the original `draw_game_sprite` space, `frames` the cycle
 * length (8 = animated smoke every 8 ticks, 1 = static lift basket of an active mine).
 */
interface ActiveOverlay {
  readonly base: number;
  readonly dx: number;
  readonly dy: number;
  readonly frames: number;
}

// prettier-ignore
const BUILDING_ACTIVE_OVERLAY: Readonly<Record<number, ActiveOverlay>> = {
  5:  { base: 152, dx:  -6, dy: -39, frames: 1 }, // StoneMine – Aufzug-Korb oben
  6:  { base: 152, dx:  -6, dy: -39, frames: 1 }, // CoalMine
  7:  { base: 152, dx:  -6, dy: -39, frames: 1 }, // IronMine
  8:  { base: 152, dx:  -6, dy: -39, frames: 1 }, // GoldMine
  16: { base: 154, dx:   5, dy: -21, frames: 8 }, // Baker – Ofendampf
  18: { base: 128, dx:   6, dy: -32, frames: 8 }, // SteelSmelter
  20: { base: 128, dx: -16, dy: -21, frames: 8 }, // WeaponSmith
  23: { base: 128, dx:  -7, dy: -33, frames: 8 }, // GoldSmelter
};

/**
 * Mine lift "down" (sprite 153 = a 1x16 rope hanging into the shaft) per mine type. Drawn while the
 * mine reports `playingSfx` (byte 5 bit 3) — which is exactly while the miner is **underground** (he
 * disappears from the surface, the rope of his basket stays visible). Same anchor as the basket
 * above, and independent of the `active` overlay (the original draws both from separate bits).
 */
// prettier-ignore
const MINE_ELEVATOR_ROPE: Readonly<Record<number, DecorSprite>> = {
  5: { idx: gameSprite(153), dx: -6, dy: -39 }, // StoneMine
  6: { idx: gameSprite(153), dx: -6, dy: -39 }, // CoalMine
  7: { idx: gameSprite(153), dx: -6, dy: -39 }, // IronMine
  8: { idx: gameSprite(153), dx: -6, dy: -39 }, // GoldMine
};

/**
 * Lively overlay sprites of a finished production building, in drawing order. The gating lives here,
 * not at the caller: the `active` overlay only while `active`, the mine rope only while `playingSfx`.
 * Both conditions are independent — a mine therefore yields 0, 1 or 2 overlays depending on state.
 */
export function productionOverlays(
  type: number,
  tick: number,
  active: boolean,
  playingSfx: boolean,
): DecorSprite[] {
  const out: DecorSprite[] = [];
  const cfg = BUILDING_ACTIVE_OVERLAY[type];
  if (cfg !== undefined && active) {
    const frame = cfg.frames > 1 ? (tick >> 3) & 7 : 0;
    out.push({ idx: gameSprite(cfg.base + frame), dx: cfg.dx, dy: cfg.dy });
  }
  const rope = MINE_ELEVATOR_ROPE[type];
  if (rope !== undefined && playingSfx) out.push(rope);
  return out;
}

/** Sprite base of the occupation flags in the game object space. */
const OCCUPATION_FLAG_BASE = 182;

/**
 * One occupation flag. The vertical lift comes **straight from the garrison byte** `bld[8]` in the
 * original, not from a decoded number: `lift = ((bld[8] & 0xf0) + bias) >> shift`. Since
 * `(bld[8] & 0xf0) == available << 4`, the port mirrors it as `((available << 4) + bias) >> shift` —
 * which also gets the **rounding** right at an odd knight count (fortress, `shift 5`).
 *
 * `phase` is the offset of the waving frame (`((tick >> 3) + phase) & 3`).
 */
interface OccFlag {
  readonly dx: number;
  readonly dy: number;
  readonly bias: number;
  readonly shift: number;
  readonly phase: number;
}

/**
 * Occupation flags per military building, **read at the byte** from the three drawing routines (hut
 * `@0x3575a`, tower `@0x36108`, fortress `@0x361db`). The fortress carries **two** flags with their
 * own offset, phase and **lift** — the right one rounds up (`addw $0x10` before the `shrw $0x5`
 * @0x362fd), the left one down.
 */
// prettier-ignore
const OCCUPATION_FLAG: Readonly<Record<number, readonly OccFlag[]>> = {
  // Hut: `subw $0xe` / `addw $0x2` / `shrw $0x3` (=> 2 px per knight)
  11: [{ dx: -14, dy:   2, bias: 0,    shift: 3, phase: 0 }],
  // Tower: `addw $0xd` / `subw $0x12` / `shrw $0x4` (=> 1 px per knight)
  21: [{ dx:  13, dy: -18, bias: 0,    shift: 4, phase: 0 }],
  // Fortress: `subw $0xc` / `subw $0x15` / `shrw $0x5` and `addw $0x16` / `subw $0x22` / `+0x10 >> 5`
  22: [{ dx: -12, dy: -21, bias: 0,    shift: 5, phase: 0 },
       { dx:  22, dy: -34, bias: 0x10, shift: 5, phase: 2 }],
};

/**
 * Occupation flags of a military building (empty for non-military ones). The flag variant encodes the
 * threat level (`4 * threatLevel`), the waving frame `(tick>>3)&3`, the vertical lift the knight
 * count. The flag is neutral (no team colour) — it shows garrison and threat, not the owner.
 *
 * `knightCount` is the **high nibble** of `bld[8]` (`stock[0].available`) — for a military building
 * the number of knights actually inside. The caller draws only at `firstKnight != 0` (`or %ax,%ax ;
 * jne` @0x35764 and its two counterparts).
 */
export function occupationFlags(
  type: number,
  tick: number,
  threatLevel: number,
  knightCount: number,
): DecorSprite[] {
  const cfgs = OCCUPATION_FLAG[type];
  if (cfgs === undefined) return [];
  const variant = 4 * (threatLevel & 3);
  const nibble = (knightCount & 0xf) << 4; // == bld[8] & 0xf0
  return cfgs.map((cfg) => ({
    idx: gameSprite(OCCUPATION_FLAG_BASE + (((tick >> 3) + cfg.phase) & 3) + variant),
    dx: cfg.dx,
    dy: cfg.dy - ((nibble + cfg.bias) >> cfg.shift),
  }));
}

/**
 * Waiting building materials at a site: stones + planks, each stacked. The count comes from the
 * building stock (`available`) during construction — stones from slot 1, planks from slot 0.
 */
export function constructionMaterials(waitingStone: number, waitingPlank: number): DecorSprite[] {
  const out: DecorSprite[] = [];
  for (let i = 0; i < waitingStone; i++) {
    out.push({ idx: resourceSprite(RESOURCE_STONE), dx: 10 - 3 * i, dy: -8 + i });
  }
  for (let i = 0; i < waitingPlank; i++) {
    out.push({ idx: resourceSprite(RESOURCE_PLANK), dx: 12 - 3 * i, dy: -6 + i });
  }
  return out;
}
