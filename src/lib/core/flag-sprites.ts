/**
 * **Flag sprite lookup** (pure lookups, backend independent) — from the original drawing routine
 * `draw_flag_and_res`.
 *
 * The flag is a four-phase animated sprite in map-object space (`0x80..0x83`) that changes every
 * 8 ticks; the archive holds one pre-drawn set per player colour (see {@link flagSpriteOffset}). On
 * top of that, up to 8 carried resources sit at fixed offsets around the pivot.
 */

import { MAP_OBJECT_BASE, MAP_SHADOW_BASE } from './building-sprites.js';

export { MAP_OBJECT_BASE, MAP_SHADOW_BASE };

/**
 * Base index (0-based) of the carried-resource sprites (GameObject space). DOS index 321 -> 0-based
 * 320; the sprite of a resource type sits at `GAME_OBJECT_BASE + resType`.
 */
export const GAME_OBJECT_BASE = 320;

/** Logical base offset of the flag sprites in map-object space. */
export const FLAG_BASE = 0x80;

/** Flag animation frame 0..3 from the tick (changes every 8 ticks). */
export function flagFrame(tick: number): number {
  return (tick >> 3) & 3;
}

/**
 * Logical offset of the flag sprite for waving frame `f` and `owner`.
 *
 * **The archive holds four pre-drawn sets, one per player colour** (measured from the palette
 * indices of the sprites): `+0x80..0x83` cyan (indices 64..66), `+0x84..0x87` red (72..74),
 * `+0x88..0x8b` magenta (68..70), `+0x8c..0x8f` yellow (76..78). The flag is therefore **not
 * recoloured** — the matching sprite is picked. The order cyan/red/magenta/yellow confirms
 * `PLAYER_RAMP_BASE` a second time, independently.
 *
 * The four sets are drawn separately and cannot be converted into each other (frame 0 has cyan
 * 8/8/12 pixels per brightness step, red 12/4/12) — so a recolouring approach would be wrong.
 */
export function flagSpriteOffset(frame: number, owner: number): number {
  return FLAG_BASE + 4 * (owner & 3) + (frame & 3);
}

/**
 * Offset of the flag's shadow shape mask. The shadow depends on the waving frame only, not on the
 * owner — it carries no colour anyway (`dst |= 0x80`, see `index-target.ts`).
 */
export function flagShadowOffset(frame: number): number {
  return FLAG_BASE + (frame & 3);
}

/**
 * Archive index of a GameObject sprite in the original `draw_game_sprite(i)` space. There index
 * `i` draws sprite `AssetGameObject[i-1]`; here that is `GAME_OBJECT_BASE + i - 1`. The carried
 * Waren, Rauch/Dampf, Baumaterialien, Besatzungsfahnen usw. liegen alle in diesem Raum.
 */
export function gameSprite(index: number): number {
  return GAME_OBJECT_BASE + index - 1;
}

/** Archiv-Index eines getragenen Waren-Sprites (Ressourcentyp 0..25) — Spezialfall `gameSprite(1+res)`. */
export function resourceSprite(resType: number): number {
  return gameSprite(1 + resType);
}

/** Position offsets (dx, dy) of the 8 resource slots relative to the flag pivot. */
// prettier-ignore
export const FLAG_RES_POS: readonly (readonly [number, number])[] = [
  [ 6, -4], [10, -2], [-4, -4], [10,  2],
  [-8, -2], [ 6,  4], [-8,  2], [-4,  4],
];

/** Resource slots drawn BEHIND the flag (0..2). */
export const FLAG_RES_BEHIND: readonly number[] = [0, 1, 2];
/** Resource slots drawn IN FRONT of the flag (3..7). */
export const FLAG_RES_FRONT: readonly number[] = [3, 4, 5, 6, 7];
