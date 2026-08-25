/**
 * The original mouse pointer as a CSS cursor.
 *
 * Drawn via CSS instead of into the framebuffer because in a browser the system moves the pointer:
 * a self-drawn cursor would lag the real one by one frame.
 */
import type { DecodedSprite } from '../core/types.js';

/** Registry slot `Cursor` (archive index 3999), 0-based. */
export const CURSOR_SPRITE_INDEX = 3998;

/** The hotspot is not the corner but the point at the centre of the sprite. */
export const CURSOR_HOTSPOT = { x: 8, y: 8 } as const;

/** Browsers reject cursor images larger than 128×128; the sprite is 16×16. */
export const CURSOR_MAX_SCALE = 8;

/** `null` when there is no 2D context — the browser cursor then stays as it is. */
export function buildCursorStyle(sprite: DecodedSprite, scale = 1): string | null {
  const s = Math.max(1, Math.min(CURSOR_MAX_SCALE, Math.floor(scale)));
  const canvas = document.createElement('canvas');
  canvas.width = sprite.width * s;
  canvas.height = sprite.height * s;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const src = new ImageData(
    new Uint8ClampedArray(sprite.pixels),
    sprite.width,
    sprite.height,
  );
  if (s === 1) {
    ctx.putImageData(src, 0, 0);
  } else {
    // Nearest neighbour: 1:1 into a helper canvas, then scaled up unsmoothed.
    const tmp = document.createElement('canvas');
    tmp.width = sprite.width;
    tmp.height = sprite.height;
    const tctx = tmp.getContext('2d');
    if (tctx === null) return null;
    tctx.putImageData(src, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }
  const hx = CURSOR_HOTSPOT.x * s;
  const hy = CURSOR_HOTSPOT.y * s;
  // `crosshair` as a fallback in case the browser rejects the data URI (CSP or similar).
  return `url(${canvas.toDataURL('image/png')}) ${hx} ${hy}, crosshair`;
}
