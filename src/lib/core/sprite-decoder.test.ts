import { describe, it, expect } from 'vitest';
import {
  decodeSprite,
  readSpriteHeader,
  isPlausibleSpriteHeader,
  resolveSpriteType,
} from './sprite-decoder.js';
import { parsePalette } from './pal-parser.js';
import { PaArchive } from './pa-parser.js';
import type { Palette } from './types.js';
import { readOriginal } from '../testing/originals.js';

const loadOrigFile = (name: string): Buffer | null => readOriginal(name);

function makeSpriteEntry(
  w: number,
  h: number,
  payload: Uint8Array,
  dx = 0,
  dy = 0,
  ox = 0,
  oy = 0,
): Uint8Array {
  const buf = new Uint8Array(10 + payload.byteLength);
  const dv = new DataView(buf.buffer);
  dv.setInt8(0, dx);
  dv.setInt8(1, dy);
  dv.setUint16(2, w, true);
  dv.setUint16(4, h, true);
  dv.setInt16(6, ox, true);
  dv.setInt16(8, oy, true);
  buf.set(payload, 10);
  return buf;
}

function makeTestPalette(): Palette {
  // 256 entries — we use idx 0 (black), 1 (red), 2 (green), 3 (blue), 10 (cyan shadow)
  const rgba = new Uint8Array(256 * 4);
  rgba[0] = 0;    rgba[1] = 0;    rgba[2] = 0;    rgba[3] = 255;
  rgba[4] = 255;  rgba[5] = 0;    rgba[6] = 0;    rgba[7] = 255;
  rgba[8] = 0;    rgba[9] = 255;  rgba[10] = 0;   rgba[11] = 255;
  rgba[12] = 0;   rgba[13] = 0;   rgba[14] = 255; rgba[15] = 255;
  // idx 10: cyan (for the overlay tests)
  rgba[40] = 0;   rgba[41] = 200; rgba[42] = 200; rgba[43] = 255;
  return { rgba };
}

describe('readSpriteHeader', () => {
  it('reads the 10 header bytes correctly', () => {
    const raw = makeSpriteEntry(640, 200, new Uint8Array(0), -1, 2, -5, 7);
    const h = readSpriteHeader(raw);
    expect(h.deltaX).toBe(-1);
    expect(h.deltaY).toBe(2);
    expect(h.width).toBe(640);
    expect(h.height).toBe(200);
    expect(h.offsetX).toBe(-5);
    expect(h.offsetY).toBe(7);
  });

  it('throws on fewer than 10 bytes', () => {
    expect(() => readSpriteHeader(new Uint8Array(8))).toThrow(/too small/);
  });
});

describe('isPlausibleSpriteHeader', () => {
  it('accepts the usual sizes', () => {
    expect(isPlausibleSpriteHeader({ deltaX: 0, deltaY: 0, width: 16, height: 16, offsetX: 0, offsetY: 0 })).toBe(true);
    expect(isPlausibleSpriteHeader({ deltaX: 0, deltaY: 0, width: 640, height: 200, offsetX: 0, offsetY: 0 })).toBe(true);
  });
  it('rejects zero dimensions', () => {
    expect(isPlausibleSpriteHeader({ deltaX: 0, deltaY: 0, width: 0, height: 16, offsetX: 0, offsetY: 0 })).toBe(false);
    expect(isPlausibleSpriteHeader({ deltaX: 0, deltaY: 0, width: 16, height: 0, offsetX: 0, offsetY: 0 })).toBe(false);
  });
  it('rejects oversized sprites', () => {
    expect(isPlausibleSpriteHeader({ deltaX: 0, deltaY: 0, width: 5000, height: 5000, offsetX: 0, offsetY: 0 })).toBe(false);
  });
});

describe('resolveSpriteType', () => {
  it('returns an explicit type unchanged', () => {
    expect(resolveSpriteType('solid', 100, 100)).toBe('solid');
    expect(resolveSpriteType('mask', 50, 100)).toBe('mask');
  });

  it('looks `auto` up in the asset registry when a physicalIndex is given', () => {
    // Mapping: our entry N ↔ dos_index N+1
    // our entry 3 → dos_index 4 → Overlay
    expect(resolveSpriteType('auto', 50, 100, 3)).toBe('overlay');
    // our entry 59 → dos_index 60 → Mask
    expect(resolveSpriteType('auto', 50, 100, 59)).toBe('mask');
    // our entry 320 → dos_index 321 → Transparent
    expect(resolveSpriteType('auto', 50, 100, 320)).toBe('transparent');
    // our entry 0 → dos_index 1 → Solid (art_landscape)
    expect(resolveSpriteType('auto', 50, 100, 0)).toBe('solid');
  });

  it('falls back to the heuristic for `auto` without a registry match', () => {
    // our entry 1 → dos_index 2 → Unknown → heuristic fallback
    expect(resolveSpriteType('auto', 100, 100, 1)).toBe('solid'); // payload == w*h → solid
    expect(resolveSpriteType('auto', 50, 100, 1)).toBe('transparent'); // sonst transparent
  });

  it('falls back to the heuristic for `auto` without a physicalIndex', () => {
    expect(resolveSpriteType('auto', 100, 100)).toBe('solid');
    expect(resolveSpriteType('auto', 50, 100)).toBe('transparent');
  });
});

describe('decodeSprite — Solid', () => {
  const palette = makeTestPalette();

  it('renders a 2x2 solid sprite correctly', () => {
    const payload = new Uint8Array([1, 2, 3, 0]);
    const raw = makeSpriteEntry(2, 2, payload);
    const decoded = decodeSprite(raw, palette, { type: 'solid' });
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect([decoded.pixels[0], decoded.pixels[1], decoded.pixels[2], decoded.pixels[3]]).toEqual([255, 0, 0, 255]);
    expect([decoded.pixels[4], decoded.pixels[5], decoded.pixels[6], decoded.pixels[7]]).toEqual([0, 255, 0, 255]);
    expect([decoded.pixels[8], decoded.pixels[9], decoded.pixels[10], decoded.pixels[11]]).toEqual([0, 0, 255, 255]);
    expect([decoded.pixels[12], decoded.pixels[13], decoded.pixels[14], decoded.pixels[15]]).toEqual([0, 0, 0, 255]);
  });

  it('throws on a solid payload that is too small', () => {
    const raw = makeSpriteEntry(4, 4, new Uint8Array(8));
    expect(() => decodeSprite(raw, palette, { type: 'solid' })).toThrow(/payload too small/);
  });
});

describe('decodeSprite — Transparent RLE', () => {
  const palette = makeTestPalette();

  it('decodes (drop=0, fill=2, [1,2]) as 2 visible pixels', () => {
    const payload = new Uint8Array([0, 2, 1, 2]);
    const raw = makeSpriteEntry(2, 1, payload);
    const decoded = decodeSprite(raw, palette, { type: 'transparent' });
    expect([decoded.pixels[0], decoded.pixels[1], decoded.pixels[2], decoded.pixels[3]]).toEqual([255, 0, 0, 255]);
    expect([decoded.pixels[4], decoded.pixels[5], decoded.pixels[6], decoded.pixels[7]]).toEqual([0, 255, 0, 255]);
  });

  it('drop pixels are fully transparent', () => {
    const payload = new Uint8Array([1, 1, 1]);
    const raw = makeSpriteEntry(2, 1, payload);
    const decoded = decodeSprite(raw, palette, { type: 'transparent' });
    expect(decoded.pixels[3]).toBe(0);
    expect([decoded.pixels[4], decoded.pixels[5], decoded.pixels[6], decoded.pixels[7]]).toEqual([255, 0, 0, 255]);
  });

  it('colorOffset is added to the palette index', () => {
    // with offset 9: palIdx 1 -> palette[10] (cyan)
    const payload = new Uint8Array([0, 1, 1]);
    const raw = makeSpriteEntry(1, 1, payload);
    const decoded = decodeSprite(raw, palette, { type: 'transparent', colorOffset: 9 });
    expect([decoded.pixels[0], decoded.pixels[1], decoded.pixels[2]]).toEqual([0, 200, 200]);
  });
});

describe('decodeSprite — Overlay RLE', () => {
  const palette = makeTestPalette();

  it('pure (drop,fill) pairs: every fill pixel = palette[value] with alpha = value', () => {
    // 2 fill pixels, NO per-pixel bytes; value 1 (red in the test palette) -> alpha 1.
    const payload = new Uint8Array([0, 2]);
    const raw = makeSpriteEntry(2, 1, payload);
    const decoded = decodeSprite(raw, palette, { type: 'overlay', overlayValue: 1 });
    expect([decoded.pixels[0], decoded.pixels[1], decoded.pixels[2], decoded.pixels[3]]).toEqual([255, 0, 0, 1]);
    expect([decoded.pixels[4], decoded.pixels[5], decoded.pixels[6], decoded.pixels[7]]).toEqual([255, 0, 0, 1]);
  });

  it('drop pixels stay transparent; fill takes colour and alpha from value', () => {
    // 1 drop transparent, 1 fill; value 10 (cyan in the test palette) -> alpha 10.
    const payload = new Uint8Array([1, 1]);
    const raw = makeSpriteEntry(2, 1, payload);
    const decoded = decodeSprite(raw, palette, { type: 'overlay', overlayValue: 10 });
    expect(decoded.pixels[3]).toBe(0); // erstes Pixel transparent
    expect(decoded.pixels[7]).toBe(10); // fill: Alpha == value
  });

  it('default value 0x80 → alpha 128', () => {
    const payload = new Uint8Array([0, 1]);
    const raw = makeSpriteEntry(1, 1, payload);
    const decoded = decodeSprite(raw, palette, { type: 'overlay' });
    expect(decoded.pixels[3]).toBe(0x80);
  });
});

describe('decodeSprite — Mask RLE', () => {
  const palette = makeTestPalette();

  it('writes opaque white pixels for fill, transparent for drop', () => {
    // 4 pixels: drop=2, fill=2
    const payload = new Uint8Array([2, 2]);
    const raw = makeSpriteEntry(4, 1, payload);
    const decoded = decodeSprite(raw, palette, { type: 'mask' });
    // Pixels 0, 1: transparent
    expect(decoded.pixels[3]).toBe(0);
    expect(decoded.pixels[7]).toBe(0);
    // pixels 2, 3: opaque white
    expect([decoded.pixels[8], decoded.pixels[9], decoded.pixels[10], decoded.pixels[11]]).toEqual([255, 255, 255, 255]);
    expect([decoded.pixels[12], decoded.pixels[13], decoded.pixels[14], decoded.pixels[15]]).toEqual([255, 255, 255, 255]);
  });
});

describe.runIf(loadOrigFile('SPAD.PA') !== null && loadOrigFile('0.PAL') !== null)(
  'decodeSprite — against the original SPAD.PA + 0.PAL',
  () => {
    it('decodes entry 0 (640×200 solid)', () => {
      const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
      const palette = parsePalette(loadOrigFile('0.PAL')!);
      const raw = arch.getRaw(0)!;
      const decoded = decodeSprite(raw, palette, { type: 'solid' });
      expect(decoded.width).toBe(640);
      expect(decoded.height).toBe(200);
      expect(decoded.pixels.byteLength).toBe(640 * 200 * 4);
      let allOpaque = true;
      for (let i = 3; i < decoded.pixels.byteLength; i += 4) {
        if (decoded.pixels[i] !== 0xff) {
          allOpaque = false;
          break;
        }
      }
      expect(allOpaque).toBe(true);
    });

    it('auto mode with physicalIndex decodes at least 80 % of the non-empty entries cleanly', () => {
      const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
      const palette = parsePalette(loadOrigFile('0.PAL')!);
      let total = 0;
      let ok = 0;
      for (const e of arch.entries) {
        const raw = arch.getRaw(e.index);
        if (!raw) continue;
        total++;
        try {
          decodeSprite(raw, palette, { type: 'auto', physicalIndex: e.index });
          ok++;
        } catch {
          /* implausible header — surfaced as an error in the viewer */
        }
      }
      expect(total).toBeGreaterThan(2000);
      expect(ok / total).toBeGreaterThan(0.8);
    });

    it('sprite 3 is an overlay per the registry (mapping: entry 3 <-> DOS index 4)', () => {
      const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
      const palette = parsePalette(loadOrigFile('0.PAL')!);
      const raw = arch.getRaw(3);
      if (!raw) return;
      expect(() => decodeSprite(raw, palette, { type: 'overlay' })).not.toThrow();
    });

    it('sprite 4 is solid per the registry (entry 4 <-> DOS index 5)', () => {
      const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
      const palette = parsePalette(loadOrigFile('0.PAL')!);
      const raw = arch.getRaw(4)!;
      // w=5, h=2 → 10 pixels; size 20 = 10 + 10 (header) → solid match
      const decoded = decodeSprite(raw, palette, { type: 'auto', physicalIndex: 4 });
      expect(decoded.width).toBe(5);
      expect(decoded.height).toBe(2);
    });
  },
);
