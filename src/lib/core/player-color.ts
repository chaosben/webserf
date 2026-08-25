/**
 * Player colours: the four team ramps of the palette and the composition helpers around them.
 *
 * ## The original recolours nothing
 *
 * The palette holds **four ramps of four** at 64..79, one player colour each from light to dark. Team
 * colour arises from that in two ways, neither of them per-pixel arithmetic:
 * - **serf torso**: the sprite carries *only* the team region (raw bytes across the whole bank are 0
 *   and 1 exclusively); the decode offset places it on the owner's ramp, the rest of the body comes
 *   from the arm sprite. See `serf-sprites.buildTorsoIndexed`.
 * - **flag**: the archive holds **four pre-baked variants**, one per player colour. See
 *   `flag-sprites.flagSpriteOffset`.
 *
 * The RGBA functions below (`recolorMaskImage`, `stickSprite`) are a **second-hand reconstruction**
 * and are no longer used by the map renderer; they only serve the asset viewer, which shows sprites
 * without a game context. Their approach (difference of two colour variants -> region -> luminance
 * shading) does **not** model what the original does.
 */

import type { IndexedSprite } from './sprite-indexed.js';
import type { DecodedSprite } from './types.js';

/**
 * Default player colours (RGB) per player slot 0..3 — from the original (cyan/red/magenta/yellow).
 *
 * They are **exactly** the head entries of the four palette ramps below (distance 0 to
 * `palette[64/72/68/76]`) — not a coincidence, but the same fact expressed in RGB.
 */
export const PLAYER_COLORS_RGB: readonly (readonly [number, number, number])[] = [
  [0x00, 0xe3, 0xe3],
  [0xcf, 0x63, 0x63],
  [0xdf, 0x7f, 0xef],
  [0xef, 0xef, 0x8f],
];

// --- team colouring in palette index space -------------------------------------------------------

/**
 * First team ramp in the game palette and its length.
 *
 * The palette holds **four ramps of four** at 64..79, one player colour each from light to dark:
 * `64..67` cyan, `68..71` magenta, `72..75` red, `76..79` yellow.
 */
export const TEAM_RAMP_FIRST = 64;
export const TEAM_RAMP_LEN = 4;

// NOTHING is recoloured: the serf torso is DECODED with the ramp base (its raw bytes are only 0..3,
// see `buildTorsoIndexed`), and the flag exists in four pre-baked variants in the archive (see
// `flagSpriteOffset`). Remapping indices 64..67 onto the owner's ramp would be wrong: the four flag
// variants are drawn separately and do not derive from one another.

/**
 * Ramp base per player slot 0..3 — the order is **not** ascending but cyan/red/magenta/yellow like
 * {@link PLAYER_COLORS_RGB}.
 */
export const PLAYER_RAMP_BASE: readonly number[] = [64, 72, 68, 76];

/**
 * Index variant of {@link stickSprite}: `top` overwrites `base` where it is opaque. Size and pivot
 * come from `base`, **the delta from `top`** — as in the original.
 */
export function stickIndexed(base: IndexedSprite, top: IndexedSprite): IndexedSprite {
  const indices = new Uint8Array(base.indices);
  const opaque = new Uint8Array(base.opaque);
  const w = Math.min(base.width, top.width);
  const h = Math.min(base.height, top.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ti = y * top.width + x;
      if (top.opaque[ti] === 0) continue;
      const bi = y * base.width + x;
      indices[bi] = top.indices[ti]!;
      opaque[bi] = 1;
    }
  }
  return {
    width: base.width,
    height: base.height,
    offsetX: base.offsetX,
    offsetY: base.offsetY,
    deltaX: top.deltaX,
    deltaY: top.deltaY,
    indices,
    opaque,
    shade: false,
  };
}

/** Perceived luminance (original weights from `make_alpha_mask`). */
function luminance(r: number, g: number, b: number): number {
  return 0.21 * r + 0.72 * g + 0.07 * b;
}

/**
 * Combines an image sprite with its colour-variant version into a team-coloured sprite.
 *
 * @param image   sprite in colour variant A (supplies shape, luminance shading and the fixed pixels)
 * @param variant sprite in colour variant B (only to find the recolourable region by pixel difference)
 * @param rgb     target player colour
 *
 * Both sprites must have the same dimensions. Differing opaque pixels -> player colour (shaded);
 * remaining opaque pixels -> `image` unchanged; transparent pixels stay transparent.
 */
export function recolorMaskImage(
  image: DecodedSprite,
  variant: DecodedSprite,
  rgb: readonly [number, number, number],
): DecodedSprite {
  const { width, height, offsetX, offsetY, deltaX, deltaY } = image;
  const n = width * height;
  const px = image.pixels;
  const vx = variant.pixels;
  const out = new Uint8ClampedArray(n * 4);

  // Pass 1: mark the recolourable region (pixel difference) and find the maximum luminance in it.
  const isTeam = new Uint8Array(n);
  let maxLum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (px[o + 3] === 0) continue;
    if (px[o] !== vx[o] || px[o + 1] !== vx[o + 1] || px[o + 2] !== vx[o + 2] || px[o + 3] !== vx[o + 3]) {
      isTeam[i] = 1;
      const l = luminance(px[o], px[o + 1], px[o + 2]);
      if (l > maxLum) maxLum = l;
    }
  }

  // Pass 2: write.
  const [pr, pg, pb] = rgb;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = px[o + 3];
    if (a === 0) {
      out[o + 3] = 0;
      continue;
    }
    if (isTeam[i] === 1) {
      // brightest region pixel -> factor 1; darker ones proportionally (255 - maxLum + lum)/255.
      const l = luminance(px[o], px[o + 1], px[o + 2]);
      const f = (255 - maxLum + l) / 255;
      out[o] = pr * f;
      out[o + 1] = pg * f;
      out[o + 2] = pb * f;
      out[o + 3] = 255;
    } else {
      out[o] = px[o];
      out[o + 1] = px[o + 1];
      out[o + 2] = px[o + 2];
      out[o + 3] = a;
    }
  }

  return { width, height, offsetX, offsetY, deltaX, deltaY, pixels: out };
}

/**
 * Sticks a sprite (`top`) onto a base sprite (`base`): where `top` is opaque the base pixel is
 * replaced (original `stick` semantics). Both share the origin (top left); parts of `top` reaching
 * beyond are ignored. Size and pivot come from `base`, **the delta from `top`** — as in the original,
 * where `stick` adopts the sticker's delta. For a serf that means the head attachment vector (delta)
 * of the finished torso is the one of the arms stuck on.
 */
export function stickSprite(base: DecodedSprite, top: DecodedSprite): DecodedSprite {
  const out = new Uint8ClampedArray(base.pixels);
  const w = Math.min(base.width, top.width);
  const h = Math.min(base.height, top.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ti = (y * top.width + x) * 4;
      if (top.pixels[ti + 3] === 0) continue;
      const bi = (y * base.width + x) * 4;
      out[bi] = top.pixels[ti];
      out[bi + 1] = top.pixels[ti + 1];
      out[bi + 2] = top.pixels[ti + 2];
      out[bi + 3] = top.pixels[ti + 3];
    }
  }
  return {
    width: base.width,
    height: base.height,
    offsetX: base.offsetX,
    offsetY: base.offsetY,
    deltaX: top.deltaX,
    deltaY: top.deltaY,
    pixels: out,
  };
}
