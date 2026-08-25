/**
 * What is checked is the SELF-TEST of the GPU route, not the GPU route itself: there is no WebGL in
 * Node, and a mock would be a rebuild that only checks itself. What carries instead is the question
 * "can this self-test fail at all?" — a check that accepts everything is worse than none, because it
 * puts a broken GPU route into service.
 *
 * So both directions: the correct image must be accepted, and each of the three plausible mix-ups
 * rejected (a wrong pixel, an upside-down image, a wrong size).
 */
import { describe, expect, it } from 'vitest';
import { gpuProbeSurface, readbackMatchesCpu } from './index-presenter.js';
import { indexSurfaceToRgba } from '../core/index-target.js';
import type { Palette } from '../core/types.js';

/** A palette where every index is a DIFFERENT colour — otherwise no comparison carries. */
function distinctPalette(): Palette {
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = i;
    rgba[i * 4 + 1] = (i * 7) & 0xff;
    rgba[i * 4 + 2] = (i * 13) & 0xff;
    rgba[i * 4 + 3] = 0x11; // deliberately NOT 0xff: the CPU route ignores the palette alpha
  }
  return { rgba };
}

/** What a correct GPU would have to deliver: the CPU route, flipped row-wise. */
function flip(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(rgba.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  }
  return out;
}

describe('self-test of the GPU presenter', () => {
  it('the probe covers every palette index exactly once', () => {
    const s = gpuProbeSurface();
    expect(s.width * s.height).toBe(256);
    const seen = new Set(s.data);
    expect(seen.size).toBe(256);
  });

  it('accepts the flipped CPU route', () => {
    const s = gpuProbeSurface();
    const pal = distinctPalette();
    const back = flip(indexSurfaceToRgba(s, pal), s.width, s.height);
    expect(readbackMatchesCpu(back, s, pal)).toBe(true);
  });

  it('rejects a single wrong pixel', () => {
    const s = gpuProbeSurface();
    const pal = distinctPalette();
    const back = flip(indexSurfaceToRgba(s, pal), s.width, s.height);
    back[4 * 100 + 1] = (back[4 * 100 + 1]! + 1) & 0xff;
    expect(readbackMatchesCpu(back, s, pal)).toBe(false);
  });

  it('rejects an upside-down image — flipping is the most common mistake', () => {
    const s = gpuProbeSurface();
    const pal = distinctPalette();
    const back = new Uint8Array(indexSurfaceToRgba(s, pal)); // NICHT gespiegelt
    expect(readbackMatchesCpu(back, s, pal)).toBe(false);
  });

  it('rejects a wrong size', () => {
    const s = gpuProbeSurface();
    const pal = distinctPalette();
    expect(readbackMatchesCpu(new Uint8Array(4), s, pal)).toBe(false);
  });

  it('the palette alpha does not matter — the CPU route always writes 0xff', () => {
    const s = gpuProbeSurface();
    const a = distinctPalette();
    const b = distinctPalette();
    b.rgba[3] = 0xff; // a different palette alpha
    const back = flip(indexSurfaceToRgba(s, a), s.width, s.height);
    expect(readbackMatchesCpu(back, s, b)).toBe(true);
    // Counter-check: the CPU route really does write 0xff, not the palette value.
    expect(indexSurfaceToRgba(s, a)[3]).toBe(0xff);
  });
});
