/**
 * THE PARTS OF THE ORIGINAL SCREEN INTO THE MAP CANVAS — bar and popup, as the original does it.
 *
 * The original has ONE framebuffer; bar and popup are blitted into it at fixed positions. Keeping
 * them as separate canvases next to the map was an addition of the port, and it cost three things:
 * a screenshot of the game showed only the map, the stacking order was a CSS question rather than a
 * structural one, and there was no single surface to capture.
 *
 * WHY A SCRATCH CANVAS IS STILL NEEDED: the parts are drawn into an RGBA {@link Framebuffer}, and
 * the only way to get one onto a canvas is `putImageData` — which ignores the transform and cannot
 * scale. So the framebuffer goes into a scratch canvas of its own size first, and `drawImage` takes
 * it from there to its scaled destination. The scratch canvases live here and nowhere else; nothing
 * outside this module touches a canvas but the visible one.
 *
 * The map canvas is re-created on every frame (assigning `width` clears it), so the parts have to be
 * composed again on every frame. That is cheap — roughly 110k pixels against the map's millions —
 * but it does mean the caller must compose in the SAME pass that draws the map, not in one of its
 * own.
 */

import type { Framebuffer } from '../core/ui-render.js';
import type { BoxRect } from './ui-layout.js';

/** One part: what to draw, and where it goes in canvas pixels. */
export interface OverlayLayer {
  readonly fb: Framebuffer;
  readonly rect: BoxRect;
}

interface Scratch {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Which framebuffer currently sits in it — see {@link composeUiOverlay}. */
  last: Framebuffer | null;
}

const scratches = new Map<string, Scratch>();

/**
 * Lazily, because there is no `document` while rendering on the server. Keyed by size, so a part of
 * a new size needs no change here.
 */
function scratchFor(w: number, h: number): Scratch | null {
  const key = `${w}x${h}`;
  const found = scratches.get(key);
  if (found !== undefined) return found;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const made: Scratch = { canvas, ctx, last: null };
  scratches.set(key, made);
  return made;
}

/**
 * Blits the parts onto the map canvas, in the given order — the last one ends up on top.
 *
 * `putImageData` is skipped while the framebuffer is the same OBJECT as last time: the painters
 * build a fresh framebuffer whenever the content changes, so identity is an exact "unchanged" test,
 * not a guess.
 */
export function composeUiOverlay(
  ctx: CanvasRenderingContext2D,
  layers: readonly OverlayLayer[],
): void {
  if (layers.length === 0) return;
  ctx.imageSmoothingEnabled = false;
  for (const { fb, rect } of layers) {
    if (rect.w <= 0 || rect.h <= 0) continue;
    const scratch = scratchFor(fb.width, fb.height);
    if (scratch === null) continue;
    if (scratch.last !== fb) {
      const img = scratch.ctx.createImageData(fb.width, fb.height);
      img.data.set(fb.rgba);
      scratch.ctx.putImageData(img, 0, 0);
      scratch.last = fb;
    }
    ctx.drawImage(
      scratch.canvas,
      0,
      0,
      fb.width,
      fb.height,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
    );
  }
}

/** Test seam: drops the scratch canvases so a case starts from nothing. */
export function resetUiOverlayScratch(): void {
  scratches.clear();
}
