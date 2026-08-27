/**
 * An archive sprite as a canvas the DOM can show.
 *
 * Two users with nothing else in common: the mouse pointer (which needs a `url(...)` for a CSS
 * cursor) and the enhancement overlays (which need an `<img>` source for the original icons).
 * Hence a module of its own rather than a second copy of the same fifteen lines.
 */
import type { DecodedSprite } from '../core/types.js';

/**
 * Scaled by whole steps and WITHOUT smoothing — the sprites are pixel art, and a browser would
 * otherwise interpolate them into mush. `null` when there is no 2D context.
 *
 * The detour over a helper canvas is what makes the nearest-neighbour step work: `putImageData`
 * ignores every transform, so it cannot scale; only `drawImage` can, and only from a canvas.
 */
export function spriteCanvas(sprite: DecodedSprite, scale = 1): HTMLCanvasElement | null {
  const s = Math.max(1, Math.floor(scale));
  const canvas = document.createElement('canvas');
  canvas.width = sprite.width * s;
  canvas.height = sprite.height * s;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const src = new ImageData(new Uint8ClampedArray(sprite.pixels), sprite.width, sprite.height);
  if (s === 1) {
    ctx.putImageData(src, 0, 0);
    return canvas;
  }
  const tmp = document.createElement('canvas');
  tmp.width = sprite.width;
  tmp.height = sprite.height;
  const tctx = tmp.getContext('2d');
  if (tctx === null) return null;
  tctx.putImageData(src, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}
