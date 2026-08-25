import { describe, it, expect } from 'vitest';
import { probePosition, probeMask } from './ai-probe.js';
import { mapGeometry, colOf, rowOf } from './position.js';

/**
 * Map probing of the AI (`FUN_0005c54a`) - only what synthetic data can check.
 *
 * The position is a BYTE offset: the row sits at `rowShift + 1`, so there is a GAP BIT in between
 * (a row of the map block is `cols * 8` bytes wide, since each row holds the landscape tuples first
 * and the game tuples after). A flat `(v >>> 2) & (tileCount - 1)` is therefore wrong; the
 * derivation is at the head of `probePosition`.
 */

describe('ai-probe: position formula', () => {
  const small = mapGeometry(3); // 64x64 = 4096 tiles
  const large = mapGeometry(7); // 256x256 = 65536 tiles

  it('the mask is the original one - with the gap bit', () => {
    // `gs[0]` == `((rowMask << (rowShift+1)) | colMask) << 2`.
    expect(probeMask(small)).toBe(0x7efc); // 64x64: row in bits 9..14, column in 2..7, bit 8 empty
    expect(probeMask(large)).toBe(0x7fbfc); // 256x256: ((255 << 9) | 255) << 2
    // Counter-check: a flat mask would have no gap bit.
    expect(probeMask(small)).not.toBe((small.tileCount - 1) << 2);
  });

  it('always lies inside the map', () => {
    for (const [r1, r2] of [[0, 0], [0xffff, 0xffff], [0x1234, 0x5678], [0, 0xffff]] as const) {
      for (const geo of [small, large]) {
        const pos = probePosition(r1, r2, geo);
        expect(pos).toBeGreaterThanOrEqual(0);
        expect(pos).toBeLessThan(geo.tileCount);
      }
    }
  });

  it('decodes column and row where the original does', () => {
    // Byte offset 4 == column 1, row 0.
    expect(colOf(probePosition(0, 4, small), small)).toBe(1);
    expect(rowOf(probePosition(0, 4, small), small)).toBe(0);
    // The bottom two bits drop out (the mask clears them).
    expect(probePosition(0, 5, small)).toBe(probePosition(0, 4, small));
    // One row on is `cols * 8` == 512 bytes away, NOT 256.
    expect(rowOf(probePosition(0, 512, small), small)).toBe(1);
    expect(colOf(probePosition(0, 512, small), small)).toBe(0);
    // And bit 8 (value 256) is the gap: it must move nothing.
    expect(probePosition(0, 256, small)).toBe(probePosition(0, 0, small));
  });

  it('the first draw contributes once the map is large enough', () => {
    // `r1` starts at bit 16, the topmost row bit of 64x64 is bit 14 - there its contribution
    // vanishes either way, so the check uses the size on which it demonstrably counts.
    const differing = [0, 0x0f0f, 0xffff, 0x4321].filter(
      (r2) => probePosition(0x0000, r2, large) !== probePosition(0x0003, r2, large),
    );
    expect(differing.length).toBe(4);
  });

  it('the flat formula differs in almost every case', () => {
    const flat = (r1: number, r2: number, geo: typeof small) =>
      (((r1 << 16) | r2) >>> 2) & (geo.tileCount - 1);
    let equal = 0;
    const total = 4096;
    for (let i = 0; i < total; i++) {
      const r2 = (i * 7919) & 0xffff;
      if (probePosition(0, r2, small) === flat(0, r2, small)) equal += 1;
    }
    // Agreement only when seven consecutive bits match => 2 out of 128.
    expect(equal / total).toBeLessThan(0.05);
  });
});
