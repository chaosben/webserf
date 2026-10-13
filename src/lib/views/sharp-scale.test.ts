import { describe, expect, it } from 'vitest';
import { blitScaled, sharpSteps } from './sharp-scale.js';

describe('sharpSteps', () => {
  it('keeps the exact nearest path for whole factors', () => {
    expect(sharpSteps(1)).toEqual({ n: 1, smooth: false });
    expect(sharpSteps(2)).toEqual({ n: 1, smooth: false });
    expect(sharpSteps(3)).toEqual({ n: 1, smooth: false });
  });

  it('treats a factor a rounding error away from a whole number as whole', () => {
    expect(sharpSteps(1.9999999)).toEqual({ n: 1, smooth: false });
    expect(sharpSteps(2.0000001)).toEqual({ n: 1, smooth: false });
  });

  it('pre-enlarges by the integer part and filters the rest from 2 on', () => {
    expect(sharpSteps(2.5)).toEqual({ n: 2, smooth: true });
    expect(sharpSteps(3.75)).toEqual({ n: 3, smooth: true });
  });

  it('stays nearest below 2 — filtering there would blend every pixel', () => {
    // 1.25 and 1.5 are exactly the screen scalings a zoomed-out map is enlarged by.
    expect(sharpSteps(1.25)).toEqual({ n: 1, smooth: false });
    expect(sharpSteps(1.5)).toEqual({ n: 1, smooth: false });
    expect(sharpSteps(1.99)).toEqual({ n: 1, smooth: false });
    expect(sharpSteps(0.8)).toEqual({ n: 1, smooth: false });
  });

  it('does nothing special for a degenerate scale', () => {
    expect(sharpSteps(0)).toEqual({ n: 1, smooth: false });
    expect(sharpSteps(Number.NaN)).toEqual({ n: 1, smooth: false });
  });
});

describe('blitScaled', () => {
  const ctx = () => {
    const seen: boolean[] = [];
    const c = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'high',
      drawImage: () => seen.push(c.imageSmoothingEnabled),
    };
    return { c: c as unknown as CanvasRenderingContext2D, seen };
  };

  it('draws a whole factor without touching the smoothing state', () => {
    const { c, seen } = ctx();
    blitScaled(c, {} as CanvasImageSource, 0, 0, 10, 10, false);
    expect(seen).toEqual([false]);
  });

  it('filters only the one call and leaves smoothing off afterwards', () => {
    const { c, seen } = ctx();
    blitScaled(c, {} as CanvasImageSource, 0, 0, 10, 10, true);
    expect(seen).toEqual([true]);
    expect(c.imageSmoothingEnabled).toBe(false);
  });
});
