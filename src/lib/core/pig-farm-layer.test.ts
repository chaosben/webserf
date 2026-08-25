import { describe, it, expect } from 'vitest';
import { PIG_ANIM_BYTES, pigFarmCount, pigFarmPigs } from './pig-farm-layer.js';
import { CURSOR_MARKER_BASE } from './ui-render.js';
import type { BuildingRecord } from './types.js';

/**
 * The **table values** are checked against the original binary elsewhere; here is only the logic
 * around them (thresholds, order, wrap) that a unit test can hold usefully.
 */
const farm = (count: number): BuildingRecord =>
  ({
    stock: [
      { available: 0, requested: 0 },
      { available: (count >> 4) & 0xf, requested: count & 0xf },
    ],
  }) as unknown as BuildingRecord;

describe('pig farm — the eight places', () => {
  it('`building[9]` is read as a plain number, not as a nibble pair', () => {
    expect(pigFarmCount(farm(5))).toBe(5);
    expect(pigFarmCount(farm(0))).toBe(0);
  });

  it('the thresholds are {1..8}, so the number of animals equals the count, clamped above', () => {
    for (let n = 0; n <= 8; n++) expect(pigFarmPigs(n, 0)).toHaveLength(n);
    expect(pigFarmPigs(9, 0)).toHaveLength(8);
    expect(pigFarmPigs(255, 0)).toHaveLength(8);
  });

  it('drawing order is back to front (dy monotonically increasing)', () => {
    const ys = pigFarmPigs(8, 0).map((p) => p.dy);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys).toEqual([6, 8, 8, 11, 13, 14, 17, 19]);
  });

  it('every place has its OWN phase offset — the animals do not move in lockstep', () => {
 // Over a full pass through the table no pair of places may show the same sprite throughout.
    const equalAlways = new Set<string>();
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) equalAlways.add(`${a}:${b}`);
    for (let tick = 0; tick < PIG_ANIM_BYTES * 8; tick += 8) {
      const pigs = pigFarmPigs(8, tick);
      for (let a = 0; a < 8; a++) {
        for (let b = a + 1; b < 8; b++) {
          if (pigs[a]!.idx !== pigs[b]!.idx) equalAlways.delete(`${a}:${b}`);
        }
      }
    }
    expect([...equalAlways]).toEqual([]);
  });

  it('sprites live in the marker bank 0xa2..0xad', () => {
    for (let tick = 0; tick < PIG_ANIM_BYTES * 8; tick += 8) {
      for (const p of pigFarmPigs(8, tick)) {
        expect(p.idx - CURSOR_MARKER_BASE).toBeGreaterThanOrEqual(0xa2);
        expect(p.idx - CURSOR_MARKER_BASE).toBeLessThanOrEqual(0xad);
      }
    }
  });

  it('the table index wraps (the phase offset is added BEFORE the mask)', () => {
 // Offset 0x140 (place 5) runs past 0x100; the mask 0xfe brings it back into range.
    const a = pigFarmPigs(8, 0);
    const b = pigFarmPigs(8, PIG_ANIM_BYTES * 8); // exactly one table length further
    expect(b.map((p) => p.idx)).toEqual(a.map((p) => p.idx));
  });
});
