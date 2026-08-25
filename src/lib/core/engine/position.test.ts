import { describe, it, expect } from 'vitest';
import {
  mapGeometry,
  posOf,
  colOf,
  rowOf,
  decodePackedPos,
  encodePackedPos,
  Direction,
  DIR_DELTA,
  oppositeDir,
  neighbor,
} from './position.js';

describe('position — Map-Geometrie + Positions-Codec', () => {
  it('mapGeometry for the standard size 3 (64x64)', () => {
    const geo = mapGeometry(3);
    expect(geo.cols).toBe(64);
    expect(geo.rows).toBe(64);
    expect(geo.rowShift).toBe(6);
    expect(geo.colMask).toBe(0x3f);
    expect(geo.rowMask).toBe(0x3f);
    expect(geo.tileCount).toBe(4096);
  });

  it('posOf/colOf/rowOf sind konsistent', () => {
    const geo = mapGeometry(3);
    for (const [col, row] of [
      [0, 0],
      [25, 46], // Schloss P0 in SAVE0
      [63, 63],
      [7, 47],
    ]) {
      const pos = posOf(col, row, geo);
      expect(pos).toBe(row * geo.cols + col);
      expect(colOf(pos, geo)).toBe(col);
      expect(rowOf(pos, geo)).toBe(row);
    }
  });

  it('posOf wrappt am Torus-Rand', () => {
    const geo = mapGeometry(3);
    expect(colOf(posOf(64, 0, geo), geo)).toBe(0);
    expect(rowOf(posOf(0, 64, geo), geo)).toBe(0);
  });

  it('decodePackedPos inverts encodePackedPos', () => {
    const geo = mapGeometry(3);
    for (const [col, row] of [
      [0, 0],
      [25, 46],
      [63, 63],
    ]) {
      const packed = encodePackedPos(col, row, geo);
      expect(decodePackedPos(packed, geo)).toEqual({ col, row });
    }
  });

  it('decodePackedPos yields null for 0xffffffff (no tile)', () => {
    const geo = mapGeometry(3);
    expect(decodePackedPos(0xffffffff, geo)).toBeNull();
  });
});

describe('position — Hex-Richtungen', () => {
  const geo = mapGeometry(3);

  it('DIR_DELTA holds the 6 verified deltas', () => {
    expect(DIR_DELTA).toEqual([
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
    ]);
  });

  it('oppositeDir is (dir+3)%6', () => {
    expect(oppositeDir(Direction.Right)).toBe(Direction.Left);
    expect(oppositeDir(Direction.DownRight)).toBe(Direction.UpLeft);
    expect(oppositeDir(Direction.Down)).toBe(Direction.Up);
    expect(oppositeDir(Direction.Up)).toBe(Direction.Down);
  });

  it('neighbor schrittweise in jede Richtung', () => {
    const from = posOf(10, 20, geo);
    const cases: [Direction, number, number][] = [
      [Direction.Right, 11, 20],
      [Direction.DownRight, 11, 21],
      [Direction.Down, 10, 21],
      [Direction.Left, 9, 20],
      [Direction.UpLeft, 9, 19],
      [Direction.Up, 10, 19],
    ];
    for (const [dir, c, r] of cases) {
      const p = neighbor(from, dir, geo);
      expect([colOf(p, geo), rowOf(p, geo)]).toEqual([c, r]);
    }
  });

  it('building to flag is DownRight (+1,+1)', () => {
    const castle = posOf(25, 46, geo);
    const flag = neighbor(castle, Direction.DownRight, geo);
    expect([colOf(flag, geo), rowOf(flag, geo)]).toEqual([26, 47]);
    // and seen from the flag the building sits in direction UpLeft
    expect(neighbor(flag, Direction.UpLeft, geo)).toBe(castle);
  });

  it('neighbor wrappt am Torus-Rand', () => {
    const edge = posOf(63, 63, geo);
    expect(colOf(neighbor(edge, Direction.Right, geo), geo)).toBe(0);
    expect(rowOf(neighbor(edge, Direction.Down, geo), geo)).toBe(0);
  });
});
