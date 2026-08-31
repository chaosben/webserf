/**
 * **Palette-indexed drawing surface** — the backend that lets the map renderer work like the
 * original: one byte per pixel, colour only at the very end.
 *
 * ## Why at all
 *
 * The DOS renderer knows **no semi-transparency**. A shadow is not a blend but an operation on the
 * target pixel: `blit_map_object_with_shadow` @0x34578 sends shadow and object through **two
 * different** primitives (`@0x380` -> worker `@0x63d25`, `@0x4c0` -> `@0x638fc`), and the inner loop
 * of the shadow worker writes no colour but ORs the **target's palette index** — in 1/2/4 pixel
 * steps, which is pure speed:
 *
 * ```
 * *(byte  *)dst |= 0x80;   *(ushort *)dst |= 0x8080;   *(uint *)dst |= 0x80808080;
 * ```
 *
 * The upper half of the palette is the darkened lower half (over `i = 0..127`, `palette[i|0x80]` is
 * darker in 98 cases; for terrain and object colours the factor is about 0.49). That is why an
 * imitation as "50 % alpha over black" *looks* similar — it is the wrong mechanism all the same and
 * produces colours that are **not in the palette** (measured against a capture: of all non-palette
 * pixels 100 % are deviations, while not a single original pixel lies outside the palette).
 *
 * A reverse lookup RGB->index as a shortcut is ruled out: the palette has 233 colours on 256 indices,
 * and **8 colours are ambiguous when darkened** — among them black, white and four greys occurring in
 * building masonry. So the index has to be carried along.
 *
 * ## What this module is
 *
 * A third {@link Blitter} implementation besides Canvas 2D and the RGBA buffer of the tools — the
 * drawing passes (`terrain-commands`, `road-layer`, `border-layer`, `entity-layer`) do **not** change,
 * because they work through the generic image type anyway. Zoom stays out of it: rendering happens in
 * scene resolution, the output canvas does the magnification.
 */

import type { Blitter } from './draw-target.js';
import type { IndexedSprite } from './sprite-indexed.js';
import type { Palette } from './types.js';

/** Bit the shadow sets in the target index (`dst |= 0x80`). */
export const SHADE_BIT = 0x80;

/** A surface of palette indices. */
export interface IndexSurface {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Rectangle in surface coordinates (right/bottom exclusive). */
export interface ClipRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export function createIndexSurface(width: number, height: number): IndexSurface {
  return { width, height, data: new Uint8Array(width * height) };
}

export function fillIndexSurface(surface: IndexSurface, index = 0): void {
  surface.data.fill(index & 0xff);
}

/**
 * Blits {@link IndexedSprite}s into an {@link IndexSurface}.
 *
 * `shade` sprites (archive type `overlay`) write no colour but set {@link SHADE_BIT} in the target
 * index — exactly what the original worker `@0x63d25` does.
 *
 * {@link IndexBlitter.blitOverIndex} reproduces the third primitive: it writes only over target
 * pixels carrying a required index (worker `0x646e4`). Both are the reason the map renderer works
 * indexed — neither could be reproduced in RGBA.
 *
 * ## Scale
 *
 * When zoomed out it would be wasteful to draw in scene resolution and shrink the result afterwards:
 * at 50 % zoom 75 % of the computed pixels are thrown away, at 23 % it is 95 %. With `scale < 1` the
 * blitter writes **directly in screen resolution** and samples the sprite in fixed-point steps.
 *
 * Two things matter about it:
 * - **At `scale === 1` the result is byte for byte the unscaled blit.** All pixel-exact guards
 *   measure exactly there.
 * - **Only SPRITES are shrunk this way, not the ground.** Ground triangles tile (their masks overlap
 *   at dithered edges), and independently rounded target rectangles tore gaps there. The ground is
 *   therefore still produced in scene resolution and shrunk point-wise as a **finished image** (see
 *   `views/terrain-surface.ts`). A sprite does not tile — +-1 px of position is invisible.
 */
export class IndexBlitter implements Blitter<IndexedSprite> {
  #clip: ClipRect;
  readonly #scale: number;
  #offX = 0;
  #offY = 0;

  constructor(private readonly surface: IndexSurface, scale = 1) {
    this.#clip = { x0: 0, y0: 0, x1: surface.width, y1: surface.height };
    this.#scale = scale;
  }

  /**
   * Offset added to **every** blit position.
   *
   * Needed when part of the surface is recomposed with a **shifted** camera (strip build of the
   * world-anchored ground surface): the positions then come relative to the strip, but must be
   * written into the world surface. As a parameter of `#fill` that would not be enough — the road and
   * border layers blit **themselves** and know no offset; through the blitter they inherit it.
   */
  setOffset(dx: number, dy: number): void {
    this.#offX = dx;
    this.#offY = dy;
  }

  /** Restrict the drawing area (for the clipped refresh of the dirty rects). */
  setClip(rect: ClipRect | null): void {
    const { width, height } = this.surface;
    this.#clip =
      rect === null
        ? { x0: 0, y0: 0, x1: width, y1: height }
        : {
            x0: Math.max(0, rect.x0),
            y0: Math.max(0, rect.y0),
            x1: Math.min(width, rect.x1),
            y1: Math.min(height, rect.y1),
          };
  }

  blit(image: IndexedSprite, x: number, y: number): void {
    this.#draw(image, x, y, 0);
  }

  blitPartial(image: IndexedSprite, x: number, y: number, fraction: number): void {
    this.#draw(image, x, y, Math.round(image.height * (1 - fraction)));
  }

  blitOverIndex(image: IndexedSprite, x: number, y: number, overIndex: number): void {
    this.#draw(image, x, y, 0, overIndex & 0xff);
  }

  #draw(image: IndexedSprite, bx0: number, by0: number, yStart: number, overIndex = -1): void {
    const bx = bx0 + this.#offX;
    const by = by0 + this.#offY;
    if (this.#scale !== 1) {
      this.#drawScaled(image, bx, by, yStart, overIndex);
      return;
    }
    const { width: sw, data } = this.surface;
    const { x0, y0, x1, y1 } = this.#clip;
    const { width: iw, height: ih, indices, opaque, shade } = image;

    const yFrom = Math.max(yStart, y0 - by);
    const yTo = Math.min(ih, y1 - by);
    const xFrom = Math.max(0, x0 - bx);
    const xTo = Math.min(iw, x1 - bx);
    if (yFrom >= yTo || xFrom >= xTo) return;

    for (let yy = yFrom; yy < yTo; yy++) {
      let si = yy * iw + xFrom;
      let di = (by + yy) * sw + bx + xFrom;
      for (let xx = xFrom; xx < xTo; xx++, si++, di++) {
        if (opaque[si] === 0) continue;
        // Conditional blit (`0x600` -> worker `0x646e4`): the source byte is discarded if the
        // target pixel does not carry the required index (`cmp %dl,(%edi)` @0x64908/@0x648c1).
        if (overIndex >= 0 && data[di] !== overIndex) continue;
        if (shade) data[di] = data[di]! | SHADE_BIT;
        else data[di] = indices[si]!;
      }
    }
  }

  /**
   * The same blit at a smaller scale: the target rectangle comes from the **scene edges**
   * (`round(bx*s)` to `round((bx+w)*s)`), the source pixels are sampled in 16.16 fixed point.
   *
   * Edges rather than width, because two sprites standing side by side could otherwise fall one pixel
   * apart; at least 1x1, so a serf does not vanish when zoomed far out. `yStart` (the partial
   * construction-site blit) is tested against the **source** row, so a partial and a full blit sit in
   * the same place.
   */
  #drawScaled(image: IndexedSprite, bx: number, by: number, yStart: number, overIndex: number): void {
    const s = this.#scale;
    const { width: sw, data } = this.surface;
    const { x0, y0, x1, y1 } = this.#clip;
    const { width: iw, height: ih, indices, opaque, shade } = image;

    const dx0 = Math.round(bx * s);
    const dy0 = Math.round(by * s);
    const dw = Math.max(1, Math.round((bx + iw) * s) - dx0);
    const dh = Math.max(1, Math.round((by + ih) * s) - dy0);

    const stepX = Math.floor((iw * 65536) / dw);
    const stepY = Math.floor((ih * 65536) / dh);

    const dyFrom = Math.max(dy0, y0);
    const dyTo = Math.min(dy0 + dh, y1);
    const dxFrom = Math.max(dx0, x0);
    const dxTo = Math.min(dx0 + dw, x1);
    if (dyFrom >= dyTo || dxFrom >= dxTo) return;

    for (let dy = dyFrom; dy < dyTo; dy++) {
      const sy = ((dy - dy0) * stepY) >>> 16;
      if (sy < yStart) continue;
      const srcRow = Math.min(ih - 1, sy) * iw;
      const dstRow = dy * sw;
      for (let dx = dxFrom; dx < dxTo; dx++) {
        const si = srcRow + Math.min(iw - 1, ((dx - dx0) * stepX) >>> 16);
        if (opaque[si] === 0) continue;
        const di = dstRow + dx;
        if (overIndex >= 0 && data[di] !== overIndex) continue;
        if (shade) data[di] = data[di]! | SHADE_BIT;
        else data[di] = indices[si]!;
      }
    }
  }
}

/**
 * **Machine byte order.** A `Uint32Array` writes in machine order, whereas the RGBA bytes of a canvas
 * are fixed as `R,G,B,A`. On little endian (everything this runs on) `A<<24 | B<<16 | G<<8 | R` fits;
 * on big endian it does not, and there the byte path stays instead of a guess.
 */
const LITTLE_ENDIAN = (() => {
  const probe = new DataView(new ArrayBuffer(4));
  probe.setUint32(0, 0x01020304, true);
  return probe.getUint8(0) === 0x04;
})();

/**
 * The palette as one word per entry, memoised per palette object. It changes rarely (game, art,
 * credits), whereas the surface is converted every frame — so convert once, not per frame.
 */
const PALETTE_WORDS = new WeakMap<Palette, Uint32Array>();

function paletteWords(palette: Palette): Uint32Array {
  const hit = PALETTE_WORDS.get(palette);
  if (hit !== undefined) return hit;
  const pal = palette.rgba;
  const words = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const p = i * 4;
    words[i] = ((0xff << 24) | (pal[p + 2]! << 16) | (pal[p + 1]! << 8) | pal[p]!) >>> 0;
  }
  PALETTE_WORDS.set(palette, words);
  return words;
}

/**
 * Convert the finished index surface into RGBA — the single point where colour comes into being.
 *
 * `out` may be reused (saves one allocation per frame); its length must be `width * height * 4`.
 *
 * **One word per pixel instead of four bytes.** Byte for byte that is the same content but costs a
 * third: 16 M pixels in 13 instead of 44 ms (factor 3.35). It matters because this function runs over
 * the WHOLE surface every frame and that surface is `window / zoom` large — in one user's browser it
 * was the largest single item of a zoomed-out frame at 87 ms (52 % of it).
 *
 * The byte path remains as a fallback for big endian and for an `out` that does not sit on a 4-byte
 * boundary (`ImageData.data` does, a slice of a foreign buffer not necessarily) — and it is the
 * reference the fast path is checked against.
 */
export function indexSurfaceToRgba(
  surface: IndexSurface,
  palette: Palette,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const n = surface.width * surface.height;
  const rgba = out ?? new Uint8ClampedArray(n * 4);
  const src = surface.data;

  if (LITTLE_ENDIAN && rgba.byteOffset % 4 === 0 && rgba.byteLength >= n * 4) {
    const words = paletteWords(palette);
    const dst = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
    for (let i = 0; i < n; i++) dst[i] = words[src[i]!]!;
    return rgba;
  }

  const pal = palette.rgba;
  for (let i = 0; i < n; i++) {
    const p = src[i]! * 4;
    const o = i * 4;
    rgba[o] = pal[p]!;
    rgba[o + 1] = pal[p + 1]!;
    rgba[o + 2] = pal[p + 2]!;
    rgba[o + 3] = 0xff;
  }
  return rgba;
}
