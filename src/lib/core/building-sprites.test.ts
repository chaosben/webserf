import { describe, it, expect } from 'vitest';
import {
  MAP_BUILDING_SPRITE,
  MAP_BUILDING_FRAME_SPRITE,
  BUILD_CROSS,
  BUILD_CORNERSTONE,
  CASTLE_SPRITE,
  BUILDING_TYPE_CASTLE,
  buildingDrawOps,
} from './building-sprites.js';

describe('building sprite tables', () => {
  it('have the reference sizes (25 / 24)', () => {
    expect(MAP_BUILDING_SPRITE).toHaveLength(25);
    expect(MAP_BUILDING_FRAME_SPRITE).toHaveLength(24);
  });

  it('none (type 0) has offset 0 in both tables', () => {
    expect(MAP_BUILDING_SPRITE[0]).toBe(0);
    expect(MAP_BUILDING_FRAME_SPRITE[0]).toBe(0);
  });

  it('distinctive building type offsets', () => {
    expect(MAP_BUILDING_SPRITE[1]).toBe(0xa7); // Fisher
    expect(MAP_BUILDING_SPRITE[10]).toBe(0xc0); // Warehouse
    expect(MAP_BUILDING_SPRITE[11]).toBe(0xab); // Hut
    expect(MAP_BUILDING_SPRITE[22]).toBe(0x98); // Fortress
    expect(MAP_BUILDING_SPRITE[BUILDING_TYPE_CASTLE]).toBe(0xb2); // Castle
    expect(MAP_BUILDING_SPRITE[BUILDING_TYPE_CASTLE]).toBe(CASTLE_SPRITE);
  });

  it('scaffold offsets', () => {
    expect(MAP_BUILDING_FRAME_SPRITE[1]).toBe(0xba); // fisher scaffold
    expect(MAP_BUILDING_FRAME_SPRITE[5]).toBe(0xb9); // stone mine scaffold
    expect(MAP_BUILDING_FRAME_SPRITE[10]).toBe(0xc1); // warehouse scaffold
    expect(MAP_BUILDING_FRAME_SPRITE[22]).toBe(0xaf); // fortress scaffold
  });
});

describe('buildingDrawOps', () => {
  it('none / invalid type -> empty list', () => {
    expect(buildingDrawOps(0, true, 0)).toEqual([]);
    expect(buildingDrawOps(25, true, 0)).toEqual([]);
    expect(buildingDrawOps(-1, false, 0)).toEqual([]);
  });

  it('finished building -> exactly one full op with the finished sprite', () => {
    expect(buildingDrawOps(11, true, 0)).toEqual([{ offset: 0xab, progress: 1 }]);
    // progress is ignored for finished buildings.
    expect(buildingDrawOps(11, true, 12345)).toEqual([{ offset: 0xab, progress: 1 }]);
  });

  it('start of construction (progress 0) -> only the cross sprite', () => {
    expect(buildingDrawOps(11, false, 0)).toEqual([{ offset: BUILD_CROSS, progress: 1 }]);
  });

  it('foundation phase (progress 1) -> corner stone only (scaffold from progress > 1)', () => {
    expect(buildingDrawOps(11, false, 1)).toEqual([{ offset: BUILD_CORNERSTONE, progress: 1 }]);
  });

  it('foundation phase (progress > 1, bit 15 clear) -> corner stone full + scaffold growing in', () => {
    const ops = buildingDrawOps(11, false, 0x1000);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ offset: BUILD_CORNERSTONE, progress: 1 });
    expect(ops[1].offset).toBe(MAP_BUILDING_FRAME_SPRITE[11]);
    expect(ops[1].progress).toBeCloseTo((2 * 0x1000) / 0xffff, 6);
  });

  it('scaffold-done phase (bit 15) -> scaffold full + finished building growing in', () => {
    const progress = 0x8000 | 0x2000; // bit 15 set, lower bits = 0x2000
    const ops = buildingDrawOps(11, false, progress);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ offset: MAP_BUILDING_FRAME_SPRITE[11], progress: 1 });
    expect(ops[1].offset).toBe(MAP_BUILDING_SPRITE[11]);
    expect(ops[1].progress).toBeCloseTo((2 * 0x2000) / 0xffff, 6);
  });

  it('the growth fraction always stays in [0,1] (for any u16 progress)', () => {
    // For a valid u16, 2*(progress & 0x7fff) can never exceed 0xFFFF -> always < 1,
    // but close to 1 at the end of a phase. The clamp01 guard must not break that.
    for (const progress of [0x0001, 0x1000, 0x7fff, 0x8000, 0x8001, 0xbfff, 0xffff]) {
      for (const type of [11, BUILDING_TYPE_CASTLE]) {
        for (const op of buildingDrawOps(type, false, progress)) {
          expect(op.progress).toBeGreaterThanOrEqual(0);
          expect(op.progress).toBeLessThanOrEqual(1);
        }
      }
    }
    // Near the end of the foundation (progress = 0x7fff) the scaffold is almost fully grown.
    const ops = buildingDrawOps(11, false, 0x7fff);
    expect(ops[1].progress).toBeCloseTo((2 * 0x7fff) / 0xffff, 6);
    expect(ops[1].progress).toBeLessThan(1);
  });

  it('castle under construction -> only the castle sprite, growing in via progress/0xFFFF', () => {
    const ops = buildingDrawOps(BUILDING_TYPE_CASTLE, false, 0x8000);
    expect(ops).toHaveLength(1);
    expect(ops[0].offset).toBe(CASTLE_SPRITE);
    expect(ops[0].progress).toBeCloseTo(0x8000 / 0xffff, 6);
  });

  it('finished castle -> full castle sprite', () => {
    expect(buildingDrawOps(BUILDING_TYPE_CASTLE, true, 0)).toEqual([
      { offset: CASTLE_SPRITE, progress: 1 },
    ]);
  });
});
