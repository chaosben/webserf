import { describe, it, expect } from 'vitest';
import { PLAYER_COLORS_RGB, recolorMaskImage } from './player-color.js';
import type { DecodedSprite } from './types.js';

/** Builds a tiny sprite from a flat RGBA list (width x 1). */
function sprite(rgba: number[]): DecodedSprite {
  return {
    width: rgba.length / 4,
    height: 1,
    offsetX: 3,
    offsetY: -7,
    deltaX: 2,
    deltaY: -1,
    pixels: new Uint8ClampedArray(rgba),
  };
}

describe('PLAYER_COLORS_RGB', () => {
  it('has 4 player colours', () => {
    expect(PLAYER_COLORS_RGB).toHaveLength(4);
    expect(PLAYER_COLORS_RGB[0]).toEqual([0x00, 0xe3, 0xe3]);
    expect(PLAYER_COLORS_RGB[1]).toEqual([0xcf, 0x63, 0x63]);
  });
});

describe('recolorMaskImage', () => {
  it('takes size and pivot from the image sprite', () => {
    const img = sprite([0, 0, 0, 0]);
    const out = recolorMaskImage(img, img, [10, 20, 30]);
    expect(out.width).toBe(1);
    expect(out.offsetX).toBe(3);
    expect(out.offsetY).toBe(-7);
  });

  it('a differing pixel → player colour (brightest region pixel = full colour)', () => {
    // One pixel, differing between image and variant -> recolourable; the only one -> maxLum == lum -> f = 1.
    const img = sprite([0, 200, 200, 255]);
    const variant = sprite([200, 0, 0, 255]);
    const out = recolorMaskImage(img, variant, [100, 50, 25]);
    expect([out.pixels[0], out.pixels[1], out.pixels[2], out.pixels[3]]).toEqual([100, 50, 25, 255]);
  });

  it('an identical pixel stays a fixed image pixel', () => {
    const img = sprite([10, 20, 30, 255]);
    const out = recolorMaskImage(img, img, [100, 50, 25]);
    expect([out.pixels[0], out.pixels[1], out.pixels[2], out.pixels[3]]).toEqual([10, 20, 30, 255]);
  });

  it('a transparent image pixel stays transparent', () => {
    const img = sprite([0, 200, 200, 0]);
    const variant = sprite([200, 0, 0, 0]);
    const out = recolorMaskImage(img, variant, [100, 50, 25]);
    expect(out.pixels[3]).toBe(0);
  });

  it('a darker region pixel is dimmed proportionally to its luminance', () => {
    // Pixel 0: bright (0,227,227) -> full colour; pixel 1: darker (0,100,100) -> dimmed.
    const img = sprite([0, 227, 227, 255, 0, 100, 100, 255]);
    const variant = sprite([227, 0, 0, 255, 100, 0, 0, 255]);
    const out = recolorMaskImage(img, variant, [200, 100, 50]);
    // Pixel 0 = full player colour.
    expect([out.pixels[0], out.pixels[1], out.pixels[2]]).toEqual([200, 100, 50]);
    // Pixel 1 darker than pixel 0 (every channel smaller) but > 0.
    expect(out.pixels[4]).toBeLessThan(out.pixels[0]);
    expect(out.pixels[5]).toBeLessThan(out.pixels[1]);
    expect(out.pixels[4]).toBeGreaterThan(0);
  });
});
