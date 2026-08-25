/**
 * **Terrain texture lookup** (pure lookups, backend independent).
 *
 * The original draws every terrain triangle as a ground texture clipped to a height-dependent
 * triangle mask. Which ground texture a triangle gets depends on the terrain type and on the slope
 * (the height differences of the three corners):
 *
 *   maskIndex = 4 + m - left + 9*(4 + m - right)         (Up-Dreieck)
 *   maskIndex = 4 + left - m + 9*(4 + right - m)         (Down-Dreieck)
 *   triVariant = TRI_MASK_{UP|DOWN}[maskIndex]           (0..7, or -1 = invalid / too steep)
 *   groundSprite = TRI_SPR[(type << 3) | triVariant]     (0..32, index into the ground sprites)
 *
 * `m`/`left`/`right` are the heights of the three corners (apex, then the two base corners). In the
 * original the differences always lie in [-4,4]; anything else would be a broken map.
 */

import { MAP_GROUND_BASE } from './map-render.js';

/** Up-triangle mask table (9x9), value = texture variant 0..7 or -1 (invalid). */
// prettier-ignore
export const TRI_MASK_UP: readonly number[] = [
   0,  1,  3,  6,  7, -1, -1, -1, -1,
   0,  1,  2,  5,  6,  7, -1, -1, -1,
   0,  1,  2,  3,  5,  6,  7, -1, -1,
   0,  1,  2,  3,  4,  5,  6,  7, -1,
   0,  1,  2,  3,  4,  4,  5,  6,  7,
  -1,  0,  1,  2,  3,  4,  5,  6,  7,
  -1, -1,  0,  1,  2,  4,  5,  6,  7,
  -1, -1, -1,  0,  1,  2,  5,  6,  7,
  -1, -1, -1, -1,  0,  1,  4,  6,  7,
];

/** Down-Dreieck-Maskentabelle (9×9). */
// prettier-ignore
export const TRI_MASK_DOWN: readonly number[] = [
   0,  0,  0,  0,  0, -1, -1, -1, -1,
   1,  1,  1,  1,  1,  0, -1, -1, -1,
   3,  2,  2,  2,  2,  1,  0, -1, -1,
   6,  5,  3,  3,  3,  2,  1,  0, -1,
   7,  6,  5,  4,  4,  3,  2,  1,  0,
  -1,  7,  6,  5,  4,  4,  4,  2,  1,
  -1, -1,  7,  6,  5,  5,  5,  5,  4,
  -1, -1, -1,  7,  6,  6,  6,  6,  6,
  -1, -1, -1, -1,  7,  7,  7,  7,  7,
];

/** Terrain type (0..15) x texture variant (0..7) -> ground sprite index (0..32). */
// prettier-ignore
export const TRI_SPR: readonly number[] = [
  32, 32, 32, 32, 32, 32, 32, 32, // Water0
  32, 32, 32, 32, 32, 32, 32, 32, // Water1
  32, 32, 32, 32, 32, 32, 32, 32, // Water2
  32, 32, 32, 32, 32, 32, 32, 32, // Water3
   0,  1,  2,  3,  4,  5,  6,  7,  // Grass0
   0,  1,  2,  3,  4,  5,  6,  7,  // Grass1
   0,  1,  2,  3,  4,  5,  6,  7,  // Grass2
   0,  1,  2,  3,  4,  5,  6,  7,  // Grass3
  24, 25, 26, 27, 28, 29, 30, 31, // Desert0
  24, 25, 26, 27, 28, 29, 30, 31, // Desert1
  24, 25, 26, 27, 28, 29, 30, 31, // Desert2
   8,  9, 10, 11, 12, 13, 14, 15, // Tundra0
   8,  9, 10, 11, 12, 13, 14, 15, // Tundra1
   8,  9, 10, 11, 12, 13, 14, 15, // Tundra2
  16, 17, 18, 19, 20, 21, 22, 23, // Snow0
  16, 17, 18, 19, 20, 21, 22, 23, // Snow1
];

/** Mask index of an up triangle from its three corner heights (apex `m`, base `left`/`right`). */
export function upMaskIndex(m: number, left: number, right: number): number {
  return 4 + m - left + 9 * (4 + m - right);
}

/** Maskenindex eines Down-Dreiecks (Spitze unten `m`, obere Ecken `left`/`right`). */
export function downMaskIndex(m: number, left: number, right: number): number {
  return 4 + left - m + 9 * (4 + right - m);
}

/**
 * Ground sprite index (0-based, into the archive ground textures from `MAP_GROUND_BASE`) for one
 * triangle, or `null` when the slope lies outside the valid range (mask -1 / index out of range).
 * `kind` picks the up or down mask table.
 */
export function groundSpriteForTriangle(
  kind: 'up' | 'down',
  type: number,
  m: number,
  left: number,
  right: number,
): number | null {
  const maskIndex = kind === 'up' ? upMaskIndex(m, left, right) : downMaskIndex(m, left, right);
  if (maskIndex < 0 || maskIndex >= 81) return null;
  const variant = (kind === 'up' ? TRI_MASK_UP : TRI_MASK_DOWN)[maskIndex];
  if (variant < 0) return null;
  const sprIndex = (type << 3) | variant;
  if (sprIndex < 0 || sprIndex >= 128) return null;
  return MAP_GROUND_BASE + TRI_SPR[sprIndex];
}
