import { describe, it, expect } from 'vitest';
import { SPIRAL_PATTERN, spiralPos } from './spiral.js';
import { mapGeometry, posOf, colOf, rowOf } from './position.js';

describe('spiral: hexagonal pattern', () => {
  it('the centre is (0,0)', () => {
    expect(SPIRAL_PATTERN[0]).toEqual([0, 0]);
  });

  it('the first ring (entries 1..6) is the 6 hex neighbours of the centre', () => {
    // [1,0],[1,1],[0,1],[-1,0],[-1,-1],[0,-1].
    expect(SPIRAL_PATTERN.slice(1, 7)).toEqual([
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
    ]);
  });

  it('covers at least the entries states 42/43 need (0..64)', () => {
    expect(SPIRAL_PATTERN.length).toBeGreaterThan(64);
  });

  it('spiralPos wrappt per Achse (Torus)', () => {
    const geo = mapGeometry(3); // 64×64
    const pos = posOf(0, 0, geo);
    // Entry 4 = [-1,0] -> the column wraps to cols-1, the row stays 0.
    const np = spiralPos(pos, 4, geo);
    expect(colOf(np, geo)).toBe(geo.cols - 1);
    expect(rowOf(np, geo)).toBe(0);
  });
});
