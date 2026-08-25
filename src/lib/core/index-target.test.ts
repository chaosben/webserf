import { describe, it, expect } from 'vitest';
import {
  IndexBlitter,
  SHADE_BIT,
  createIndexSurface,
  fillIndexSurface,
  indexSurfaceToRgba,
} from './index-target.js';
import type { IndexedSprite } from './sprite-indexed.js';
import type { Palette } from './types.js';

function sprite(
  width: number,
  height: number,
  indices: number[],
  opaque: number[],
  shade = false,
): IndexedSprite {
  return {
    width,
    height,
    offsetX: 0,
    offsetY: 0,
    deltaX: 0,
    deltaY: 0,
    indices: new Uint8Array(indices),
    opaque: new Uint8Array(opaque),
    shade,
  };
}

describe('IndexBlitter', () => {
  it('writes indices and leaves non-opaque pixels alone', () => {
    const s = createIndexSurface(4, 2);
    fillIndexSurface(s, 5);
    new IndexBlitter(s).blit(sprite(2, 1, [9, 10], [1, 0]), 1, 0);
    expect([...s.data]).toEqual([5, 9, 5, 5, 5, 5, 5, 5]);
  });

  it('shadow sprites set bit 7 in the TARGET instead of drawing', () => {
    // The core of it: `dst |= 0x80` — the target value survives, it is only moved into the dark half
    // of the palette. A shadow carries no colour of its own.
    const s = createIndexSurface(3, 1);
    s.data.set([4, 20, 100]);
    new IndexBlitter(s).blit(sprite(3, 1, [0, 0, 0], [1, 0, 1], true), 0, 0);
    expect([...s.data]).toEqual([4 | SHADE_BIT, 20, 100 | SHADE_BIT]);
  });

  it('the shadow is idempotent (overlapping twice stays equally dark)', () => {
    const s = createIndexSurface(1, 1);
    s.data.set([30]);
    const b = new IndexBlitter(s);
    const shadow = sprite(1, 1, [0], [1], true);
    b.blit(shadow, 0, 0);
    b.blit(shadow, 0, 0);
    expect(s.data[0]).toBe(30 | SHADE_BIT);
  });

  it('clips at the surface edge instead of overflowing', () => {
    const s = createIndexSurface(2, 2);
    new IndexBlitter(s).blit(sprite(3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9], Array(9).fill(1)), -1, -1);
    // Only sprite pixel (1,1) lands on (0,0), (2,1)->(1,0), (1,2)->(0,1), (2,2)->(1,1)
    expect([...s.data]).toEqual([5, 6, 8, 9]);
  });

  it('setClip restricts to a rectangle and can be taken back', () => {
    const s = createIndexSurface(4, 1);
    const b = new IndexBlitter(s);
    b.setClip({ x0: 1, y0: 0, x1: 3, y1: 1 });
    b.blit(sprite(4, 1, [1, 2, 3, 4], [1, 1, 1, 1]), 0, 0);
    expect([...s.data]).toEqual([0, 2, 3, 0]);
    b.setClip(null);
    b.blit(sprite(4, 1, [7, 7, 7, 7], [1, 1, 1, 1]), 0, 0);
    expect([...s.data]).toEqual([7, 7, 7, 7]);
  });

  // The third primitive of the original (`0x600` -> worker `0x646e4`): writes only over target pixels
  // carrying a required index. The already drawn ground therefore provides the mask — water waves
  // appear exactly on water (index 8) and nowhere else.
  it('blitOverIndex writes only over the required target index', () => {
    const s = createIndexSurface(4, 1);
    s.data.set([8, 5, 8, 5]);
    new IndexBlitter(s).blitOverIndex(sprite(4, 1, [13, 13, 13, 13], [1, 1, 1, 1]), 0, 0, 8);
    expect([...s.data]).toEqual([13, 5, 13, 5]);
  });

  it('blitOverIndex discards the source byte instead of shifting it', () => {
    // The worker advances both pointers (`inc %esi ; inc %edi` @0x6490c) — a sprite with differing
    // bytes must not slide itself into the matching pixels.
    const s = createIndexSurface(4, 1);
    s.data.set([5, 5, 8, 8]);
    new IndexBlitter(s).blitOverIndex(sprite(4, 1, [1, 2, 3, 4], [1, 1, 1, 1]), 0, 0, 8);
    expect([...s.data]).toEqual([5, 5, 3, 4]);
  });

  it('blitOverIndex leaves non-opaque pixels alone even over a matching target', () => {
    const s = createIndexSurface(3, 1);
    s.data.set([8, 8, 8]);
    new IndexBlitter(s).blitOverIndex(sprite(3, 1, [13, 13, 13], [1, 0, 1]), 0, 0, 8);
    expect([...s.data]).toEqual([13, 8, 13]);
  });

  it('blitPartial draws only the lower piece (building under construction)', () => {
    const s = createIndexSurface(1, 4);
    new IndexBlitter(s).blit(sprite(1, 4, [1, 2, 3, 4], [1, 1, 1, 1]), 0, 0);
    fillIndexSurface(s, 0);
    new IndexBlitter(s).blitPartial(sprite(1, 4, [1, 2, 3, 4], [1, 1, 1, 1]), 0, 0, 0.5);
    expect([...s.data]).toEqual([0, 0, 3, 4]);
  });
});

describe('IndexBlitter — scale', () => {
  /** A 4x4 sprite whose indices reveal the source column (1..4 per row). */
  const quad = (): IndexedSprite => sprite(4, 4, [
    1, 2, 3, 4,
    1, 2, 3, 4,
    5, 6, 7, 8,
    5, 6, 7, 8,
  ], new Array(16).fill(1));

  it('scale 1 changes nothing about the previous path', () => {
    const a = createIndexSurface(4, 4);
    const b = createIndexSurface(4, 4);
    new IndexBlitter(a).blit(quad(), 0, 0);
    new IndexBlitter(b, 1).blit(quad(), 0, 0);
    expect([...b.data]).toEqual([...a.data]);
  });

  it('half scale writes a quarter of the pixels and samples', () => {
    const s = createIndexSurface(4, 4);
    new IndexBlitter(s, 0.5).blit(quad(), 0, 0);
    // 4x4 -> 2x2 in the top left corner; sampled are source column/row 0 and 2.
    expect([...s.data.subarray(0, 4)]).toEqual([1, 3, 0, 0]);
    expect([...s.data.subarray(4, 8)]).toEqual([5, 7, 0, 0]);
    expect([...s.data.subarray(8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('the position comes from the SCENE edge, not from the sprite width', () => {
    // Two sprites at x=0 and x=4 have to sit next to each other without gap or overlap at half scale:
    // edges 0,2,4 instead of round(4*0.5) twice from the same place.
    const s = createIndexSurface(4, 1);
    const b = new IndexBlitter(s, 0.5);
    b.blit(sprite(4, 1, [1, 1, 1, 1], [1, 1, 1, 1]), 0, 0);
    b.blit(sprite(4, 1, [2, 2, 2, 2], [1, 1, 1, 1]), 4, 0);
    expect([...s.data]).toEqual([1, 1, 2, 2]);
  });

  it('a sprite does not vanish even when zoomed far out', () => {
    const s = createIndexSurface(4, 4);
    new IndexBlitter(s, 0.1).blit(quad(), 0, 0);
    expect(s.data[0]).toBe(1);
  });

  it('transparent source pixels stay transparent', () => {
    const s = createIndexSurface(2, 2);
    fillIndexSurface(s, 9);
    new IndexBlitter(s, 0.5).blit(sprite(4, 4, new Array(16).fill(3), new Array(16).fill(0)), 0, 0);
    expect([...s.data]).toEqual([9, 9, 9, 9]);
  });

  it('clips at small scale too', () => {
    const s = createIndexSurface(4, 4);
    const b = new IndexBlitter(s, 0.5);
    b.setClip({ x0: 1, y0: 0, x1: 2, y1: 1 });
    b.blit(quad(), 0, 0);
    expect([...s.data.subarray(0, 4)]).toEqual([0, 3, 0, 0]);
  });

  it('the shadow ORs at small scale too', () => {
    const s = createIndexSurface(2, 2);
    fillIndexSurface(s, 5);
    const shade: IndexedSprite = { ...sprite(4, 4, new Array(16).fill(0), new Array(16).fill(1)), shade: true };
    new IndexBlitter(s, 0.5).blit(shade, 0, 0);
    expect([...s.data]).toEqual([5 | SHADE_BIT, 5 | SHADE_BIT, 5 | SHADE_BIT, 5 | SHADE_BIT]);
  });

  it('setOffset verschiebt jede Position', () => {
    const s = createIndexSurface(4, 2);
    const b = new IndexBlitter(s);
    b.setOffset(2, 1);
    b.blit(sprite(1, 1, [7], [1]), 0, 0);
    expect(s.data[1 * 4 + 2]).toBe(7);
  });
});

describe('indexSurfaceToRgba', () => {
  const palette = ((): Palette => {
    const rgba = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      rgba[i * 4] = i;
      rgba[i * 4 + 1] = 255 - i;
      rgba[i * 4 + 2] = (i * 2) & 0xff;
      rgba[i * 4 + 3] = 255;
    }
    return { rgba } as Palette;
  })();

  it('looks up every index in the palette and is opaque throughout', () => {
    const s = createIndexSurface(2, 1);
    s.data.set([3, 200]);
    const out = indexSurfaceToRgba(s, palette);
    expect([...out.slice(0, 4)]).toEqual([3, 252, 6, 255]);
    expect([...out.slice(4, 8)]).toEqual([200, 55, 144, 255]);
  });

  it('writes into a supplied buffer (reused per frame)', () => {
    const s = createIndexSurface(1, 1);
    s.data.set([7]);
    const buf = new Uint8ClampedArray(4);
    expect(indexSurfaceToRgba(s, palette, buf)).toBe(buf);
    expect([...buf]).toEqual([7, 248, 14, 255]);
  });

  // There are two paths: one u32 store per pixel (little endian, 4-byte alignment) and the byte path
  // as a fallback. They MUST deliver the same bytes -- otherwise the speed-up would be a colour change,
  // and one that only shows on some machines.
  it('the fast and the slow path deliver the same bytes', () => {
    const s = createIndexSurface(37, 11);
    for (let i = 0; i < s.data.length; i++) s.data[i] = (i * 31 + 7) & 0xff;

    const fast = indexSurfaceToRgba(s, palette, new Uint8ClampedArray(s.data.length * 4));
    // Offset 1 is not on the 4-byte boundary -- that forces the byte path.
    const raw = new ArrayBuffer(s.data.length * 4 + 4);
    const slow = new Uint8ClampedArray(raw, 1, s.data.length * 4);
    indexSurfaceToRgba(s, palette, slow);

    expect(slow.byteOffset % 4).not.toBe(0);
    expect([...slow]).toEqual([...fast]);
  });

  it('the darkened form of an index is the same entry with bit 7', () => {
    // Safety net against confusing OR with addition: `20 | 0x80` is 148, not 0x94 + something.
    const s = createIndexSurface(1, 1);
    s.data.set([20 | SHADE_BIT]);
    const out = indexSurfaceToRgba(s, palette);
    expect(out[0]).toBe(148);
  });
});
