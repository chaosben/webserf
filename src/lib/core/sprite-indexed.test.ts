import { describe, it, expect } from 'vitest';
import { decodeSpriteIndexed } from './sprite-indexed.js';
import { decodeSprite } from './sprite-decoder.js';
import { parseInArchivePalette } from './pal-parser.js';
import { PaArchive } from './pa-parser.js';
import { PLAYER_RAMP_BASE, stickIndexed } from './player-color.js';
import { flagSpriteOffset } from './flag-sprites.js';
import { composeTerrainTileIndexed } from './terrain-tiles.js';
import type { Palette } from './types.js';
import { hasOriginals, readOriginalBuffer } from '../testing/originals.js';

function makeSpriteEntry(w: number, h: number, payload: Uint8Array, dx = 0, dy = 0, ox = 0, oy = 0): Uint8Array {
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

/** Palette with a distinguishable colour per index. */
function makeTestPalette(): Palette {
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = (i * 3) & 0xff;
    rgba[i * 4 + 1] = (i * 5) & 0xff;
    rgba[i * 4 + 2] = (i * 7) & 0xff;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba } as Palette;
}

describe('decodeSpriteIndexed', () => {
  it('solid: every payload byte is the palette index, everything opaque', () => {
    const raw = makeSpriteEntry(2, 2, new Uint8Array([7, 8, 9, 10]));
    const s = decodeSpriteIndexed(raw, { type: 'solid' });
    expect([...s.indices]).toEqual([7, 8, 9, 10]);
    expect([...s.opaque]).toEqual([1, 1, 1, 1]);
    expect(s.shade).toBe(false);
  });

  it('transparent: (drop, fill, bytes) — skipped pixels stay non-opaque', () => {
    // skip 1, fill 2 (indices 5, 6), then skip 1
    const raw = makeSpriteEntry(4, 1, new Uint8Array([1, 2, 5, 6, 1, 0]));
    const s = decodeSpriteIndexed(raw, { type: 'transparent' });
    expect([...s.opaque]).toEqual([0, 1, 1, 0]);
    expect(s.indices[1]).toBe(5);
    expect(s.indices[2]).toBe(6);
  });

  it('transparent: colorOffset shifts the index (team ramp)', () => {
    const raw = makeSpriteEntry(2, 1, new Uint8Array([0, 2, 0, 1]));
    const base = decodeSpriteIndexed(raw, { type: 'transparent', colorOffset: 0 });
    const red = decodeSpriteIndexed(raw, { type: 'transparent', colorOffset: 72 });
    expect([...base.indices]).toEqual([0, 1]);
    expect([...red.indices]).toEqual([72, 73]);
  });

  it('overlay is a shadow MASK: shade set, no colour of its own', () => {
    const raw = makeSpriteEntry(4, 1, new Uint8Array([1, 2, 1, 0]));
    const s = decodeSpriteIndexed(raw, { type: 'overlay' });
    expect(s.shade).toBe(true);
    expect([...s.opaque]).toEqual([0, 1, 1, 0]);
    // The overlay payload has NO per-pixel bytes — the indices stay unset.
    expect([...s.indices]).toEqual([0, 0, 0, 0]);
  });

  it('mask: pure shape without colour', () => {
    const raw = makeSpriteEntry(3, 1, new Uint8Array([0, 2, 1, 0]));
    const s = decodeSpriteIndexed(raw, { type: 'mask' });
    expect([...s.opaque]).toEqual([1, 1, 0]);
    expect(s.shade).toBe(false);
  });

  it('pivot and delta come from the header', () => {
    const raw = makeSpriteEntry(1, 1, new Uint8Array([1]), -3, 4, -7, 9);
    const s = decodeSpriteIndexed(raw, { type: 'solid' });
    expect([s.deltaX, s.deltaY, s.offsetX, s.offsetY]).toEqual([-3, 4, -7, 9]);
  });

  // The reason two decoders side by side are defensible: they must not drift apart. For every opaque
  // pixel `palette[index]` has to be the colour of the RGBA decoder — otherwise one of them is wrong.
  it('is equivalent to the RGBA decoder (synthetic, all types)', () => {
    const palette = makeTestPalette();
    const cases: Array<{ type: 'solid' | 'transparent' | 'mask'; raw: Uint8Array }> = [
      { type: 'solid', raw: makeSpriteEntry(3, 2, new Uint8Array([1, 2, 3, 200, 201, 202])) },
      { type: 'transparent', raw: makeSpriteEntry(5, 2, new Uint8Array([1, 3, 9, 10, 11, 2, 2, 12, 13])) },
      { type: 'mask', raw: makeSpriteEntry(4, 1, new Uint8Array([1, 2, 1, 0])) },
    ];
    for (const { type, raw } of cases) {
      const rgba = decodeSprite(raw, palette, { type });
      const idx = decodeSpriteIndexed(raw, { type });
      expect(idx.width).toBe(rgba.width);
      expect(idx.height).toBe(rgba.height);
      for (let i = 0; i < idx.indices.length; i++) {
        const opaqueRgba = rgba.pixels[i * 4 + 3]! > 0;
        expect(idx.opaque[i] === 1).toBe(opaqueRgba);
        if (idx.opaque[i] === 0 || type === 'mask') continue; // `mask` carries no colour
        const p = idx.indices[i]! * 4;
        expect(rgba.pixels[i * 4]).toBe(palette.rgba[p]);
        expect(rgba.pixels[i * 4 + 1]).toBe(palette.rgba[p + 1]);
        expect(rgba.pixels[i * 4 + 2]).toBe(palette.rgba[p + 2]);
      }
    }
  });
});

describe('team colouring in index space', () => {
  function sprite(indices: number[]): ReturnType<typeof decodeSpriteIndexed> {
    return {
      width: indices.length,
      height: 1,
      offsetX: 0,
      offsetY: 0,
      deltaX: 0,
      deltaY: 0,
      indices: new Uint8Array(indices),
      opaque: new Uint8Array(indices.map(() => 1)),
      shade: false,
    };
  }

  it('all four ramps are 4 apart and start at 64', () => {
    expect(PLAYER_RAMP_BASE).toEqual([64, 72, 68, 76]);
    for (const b of PLAYER_RAMP_BASE) expect((b - 64) % 4).toBe(0);
  });

  it('stickIndexed takes size and pivot from the base but the delta from the sticker', () => {
    const base = { ...sprite([1, 2, 3]), offsetX: 5, offsetY: 6, deltaX: 0, deltaY: 0 };
    const top = { ...sprite([9, 9]), deltaX: -2, deltaY: 7 };
    top.opaque[1] = 0; // the sticker's second pixel is a hole
    const out = stickIndexed(base, top);
    expect([...out.indices]).toEqual([9, 2, 3]);
    expect([out.offsetX, out.offsetY]).toEqual([5, 6]);
    expect([out.deltaX, out.deltaY]).toEqual([-2, 7]);
  });
});

describe('composeTerrainTileIndexed', () => {
  it('takes the index of the texture and the shape of the mask, tiled mask-locally', () => {
    const mask = {
      width: 4,
      height: 1,
      offsetX: -2,
      offsetY: 3,
      deltaX: 0,
      deltaY: 0,
      indices: new Uint8Array(4),
      opaque: new Uint8Array([1, 1, 0, 1]),
      shade: false,
    };
    const ground = {
      width: 2,
      height: 1,
      offsetX: 0,
      offsetY: 0,
      deltaX: 0,
      deltaY: 0,
      indices: new Uint8Array([40, 41]),
      opaque: new Uint8Array([1, 1]),
      shade: false,
    };
    const t = composeTerrainTileIndexed(mask, ground);
    expect([...t.opaque]).toEqual([1, 1, 0, 1]);
    expect(t.indices[0]).toBe(40);
    expect(t.indices[1]).toBe(41);
    expect(t.indices[3]).toBe(41); // x=3 -> 3 % 2 = 1
    expect([t.offsetX, t.offsetY]).toEqual([-2, 3]); // pivot of the mask
  });
});

// Against the real archive when the user has one (BYOA — nothing of it lives in this repo).
describe.runIf(hasOriginals('SPAD.PA'))('against SPAD.PA', () => {
  it('the index decoder and the RGBA decoder give real sprites the same colour', () => {
    const archive = PaArchive.parse(readOriginalBuffer('SPAD.PA')!);
    const palette = parseInArchivePalette(archive.getRaw(2)!);
    let checked = 0;
    const mismatches: string[] = [];
    for (const index of [0, 300, 610, 1250, 1400, 1900, 2500]) {
      const raw = archive.getRaw(index);
      if (raw === null) continue;
      const rgba = decodeSprite(raw, palette, { physicalIndex: index });
      const idx = decodeSpriteIndexed(raw, { physicalIndex: index });
      if (idx.shade) continue; // shadow masks carry no colour
      // Calling `expect` per pixel costs more than the comparison itself (tens of thousands of calls,
      // which pushed the suite into the 5 s timeout). Collect mismatches, assert once.
      for (let i = 0; i < idx.indices.length; i++) {
        if (idx.opaque[i] === 0) continue;
        const p = idx.indices[i]! * 4;
        if (
          rgba.pixels[i * 4] !== palette.rgba[p] ||
          rgba.pixels[i * 4 + 1] !== palette.rgba[p + 1] ||
          rgba.pixels[i * 4 + 2] !== palette.rgba[p + 2]
        ) {
          mismatches.push(`sprite ${index} pixel ${i}: index ${idx.indices[i]}`);
        }
        checked++;
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(10000);
  });

  it('there are FOUR pre-baked flag variants, one player ramp each', () => {
    // That is why the flag is not recoloured: `flagSpriteOffset` only picks one. At the same time the
    // order of the variants confirms `PLAYER_RAMP_BASE` independently.
    const archive = PaArchive.parse(readOriginalBuffer('SPAD.PA')!);
    for (let owner = 0; owner < 4; owner++) {
      for (let frame = 0; frame < 4; frame++) {
        const s = decodeSpriteIndexed(
          archive.getRaw(1249 + flagSpriteOffset(frame, owner))!,
          { type: 'transparent' },
        );
        const team = new Set<number>();
        for (let i = 0; i < s.indices.length; i++) {
          if (s.opaque[i] === 1 && s.indices[i]! >= 64 && s.indices[i]! < 80) team.add(s.indices[i]!);
        }
        expect(team.size).toBeGreaterThan(0);
        for (const v of team) {
          expect(v).toBeGreaterThanOrEqual(PLAYER_RAMP_BASE[owner]!);
          expect(v).toBeLessThan(PLAYER_RAMP_BASE[owner]! + 4);
        }
      }
    }
  });

  it('the four variants are drawn separately, not convertible into one another', () => {
    // Remapping 64..67 onto the owner's ramp would be wrong: the brightness distribution differs
    // between the variants.
    const archive = PaArchive.parse(readOriginalBuffer('SPAD.PA')!);
    const shades = (owner: number): number[] => {
      const s = decodeSpriteIndexed(
        archive.getRaw(1249 + flagSpriteOffset(0, owner))!,
        { type: 'transparent' },
      );
      const n = [0, 0, 0, 0];
      for (let i = 0; i < s.indices.length; i++) {
        if (s.opaque[i] === 0) continue;
        const v = s.indices[i]! - PLAYER_RAMP_BASE[owner]!;
        if (v >= 0 && v < 4) n[v]!++;
      }
      return n;
    };
    expect(shades(0)).not.toEqual(shades(1));
  });

  it('the torso bank carries ONLY team pixels (raw bytes 0..3)', () => {
    // That is why the decode offset suffices and there is nothing to recolour (see `buildTorsoIndexed`).
    const archive = PaArchive.parse(readOriginalBuffer('SPAD.PA')!);
    let seen = 0;
    for (let i = 2499; i < 2499 + 650; i++) {
      const raw = archive.getRaw(i);
      if (raw === null) continue;
      const s = decodeSpriteIndexed(raw, { type: 'transparent' });
      for (let p = 0; p < s.indices.length; p++) {
        if (s.opaque[p] === 0) continue;
        expect(s.indices[p]).toBeLessThan(4);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(1000);
  });
});
