import { describe, expect, it } from 'vitest';
import {
  RB_BUFFER_SIZE,
  RB_GRID_CELLS,
  RB_GRID_CENTER,
  RB_GRID_W,
  RB_ID_FLAG_BASE,
  RB_ID_LIMIT,
  RB_ID_SITE_BASE,
  RB_OFF_BEST,
  RB_OFF_CANDIDATE_PATH,
  RB_OFF_PATH,
  RB_OFF_POS,
  RB_OFF_TARGET_COST,
  RB_RING_DIRS,
  RB_SEARCH_ROUNDS,
  RB_STAMP_FARM_W,
  RB_STAMP_FORESTER_W,
  RB_STAMP_SCAN_FROM,
  RB_TARGETS,
  pathSteps,
  popPathDir,
  rbAlignPath,
  rbHexDistance,
  rbSlopePenalty,
  rbStamp,
  type RbPath,
} from './ai-road-builder.js';
import { DIR_DELTA, Direction } from './position.js';

/** Build a path the way the search does: per step `<<3`, appending the digit `dir+1` at the bottom. */
function makePath(dirs: readonly number[]): RbPath {
  let hi = 0;
  let lo = 0;
  for (const d of dirs) {
    hi = (((hi << 3) | (lo >>> 29)) >>> 0) as number;
    lo = (((lo << 3) >>> 0) + (d + 1)) >>> 0;
  }
  return { hi, lo };
}

function popAll(path: RbPath): number[] {
  const p = { ...path };
  const out: number[] = [];
  for (;;) {
    const s = popPathDir(p);
    if (!s) break;
    out.push(s.dir);
    if (s.last) break;
  }
  return out;
}

describe('AI road builder: buffer layout', () => {
  it('all table boundaries of the original buffer add up exactly', () => {
    expect(RB_GRID_W * RB_GRID_W).toBe(RB_GRID_CELLS);
    expect(RB_OFF_POS + RB_GRID_CELLS * 4).toBe(RB_OFF_BEST);
    expect(RB_OFF_BEST + RB_GRID_CELLS * 2).toBe(RB_OFF_PATH);
    expect(RB_OFF_PATH + RB_TARGETS * 8).toBe(RB_OFF_TARGET_COST);
    expect(RB_OFF_TARGET_COST + RB_TARGETS * 2 + 2).toBe(RB_BUFFER_SIZE);
  });

  it('the 63 target slots follow from the two id counters', () => {
    expect(RB_ID_SITE_BASE - RB_ID_FLAG_BASE).toBe(16); // existing flags
    expect(RB_ID_LIMIT - RB_ID_SITE_BASE).toBe(47); // flag building sites
    expect(RB_TARGETS).toBe(63);
  });

  it('the candidate list fits into the overwritten grid area', () => {
    expect(RB_TARGETS * 4 + 2).toBeLessThanOrEqual(RB_OFF_CANDIDATE_PATH);
  });

  it('the centre cell lies in the middle of a 19x19 grid', () => {
    const r = (RB_GRID_W - 1) / 2;
    expect(r * RB_GRID_W + r).toBe(RB_GRID_CENTER);
    expect(RB_STAMP_SCAN_FROM + 15).toBe(r); // anchor cursor-15 == grid coordinate -6
  });
});

describe('AI road builder: ring walk', () => {
  it('the six ring directions give cell strides of the 19-wide grid', () => {
    const steps = RB_RING_DIRS.map((d) => {
      const [dc, dr] = DIR_DELTA[d];
      return dr * RB_GRID_W + dc;
    });
    expect(steps).toEqual([19, -1, -20, -19, 1, 20]);
  });

  it('a ring closes: it ends where it began, and only the lead step advances', () => {
    // One step right per ring, then (ring+1) times each of the six directions. The six directions
    // sum to 0, so the walk returns to the start of the ring; only the lead step of the next ring
    // moves one cell further out.
    let cell = RB_GRID_CENTER;
    for (let ring = 0; ring < 8; ring++) {
      cell += 1; // lead step
      const start = cell;
      for (const d of RB_RING_DIRS) {
        const [dc, dr] = DIR_DELTA[d];
        cell += (dr * RB_GRID_W + dc) * (ring + 1);
      }
      expect(cell).toBe(start);
    }
    expect(cell).toBe(RB_GRID_CENTER + 8);
  });
});

describe('AI road builder: cost stamps', () => {
  it('the hex distance is the maximum within one quadrant, the sum otherwise', () => {
    expect(rbHexDistance(3, 3)).toBe(3);
    expect(rbHexDistance(-3, -2)).toBe(3);
    expect(rbHexDistance(2, -2)).toBe(4);
    expect(rbHexDistance(0, 0)).toBe(0);
  });

  it('both stamps carry `min(9, 10 - distance)` and 0 outside the radius', () => {
    for (const w of [RB_STAMP_FARM_W, RB_STAMP_FORESTER_W]) {
      const stamp = rbStamp(w);
      const r = (w - 1) / 2;
      expect(stamp[r * w + r]).toBe(9); // centre: clamped
      expect(stamp[r * w + r + 1]).toBe(9); // ring 1: clamped too
      expect(stamp[r * w]).toBe(10 - r); // edge on the axis
      // Outside: the counter-clockwise corner sits at distance 2r.
      expect(stamp[0 * w + (w - 1)]).toBe(0);
    }
  });

  it('the forester stamp reaches twice as far as the farm one', () => {
    expect((RB_STAMP_FORESTER_W - 1) / 2).toBe(2 * ((RB_STAMP_FARM_W - 1) / 2));
  });
});

describe('AI road builder: slope penalty', () => {
  it('a height difference of at most 1 is free, then 1 / 3 / 8', () => {
    expect([0, 1, -1].map(rbSlopePenalty)).toEqual([0, 0, 0]);
    expect([2, -2].map(rbSlopePenalty)).toEqual([1, 1]);
    expect([3, -3].map(rbSlopePenalty)).toEqual([3, 3]);
    expect([4, 10, -31].map(rbSlopePenalty)).toEqual([8, 8, 8]);
  });
});

describe('AI road builder: path as a base-8 number', () => {
  it('64 bits carry exactly the 21 rounds of the search', () => {
    expect(RB_SEARCH_ROUNDS * 3).toBe(63);
    expect(63).toBe(64 - 1); // the single alignment step
  });

  it('pathSteps yields the step count for every length 1..21 and every top digit', () => {
    for (let n = 1; n <= RB_SEARCH_ROUNDS; n++) {
      for (let top = 0; top < 6; top++) {
        const dirs = [top, ...Array.from({ length: n - 1 }, (_, i) => (i * 5 + 1) % 6)];
        expect(pathSteps(makePath(dirs))).toBe(n);
      }
    }
  });

  it('after alignment the directions come back in the order they were laid', () => {
    const dirs = [Direction.Left, Direction.Right, Direction.Up, Direction.DownRight];
    expect(popAll(rbAlignPath(makePath(dirs)))).toEqual(dirs);
  });

  it('WITHOUT the alignment the same path reads wrong', () => {
    const dirs = [3, 0, 5, 1, 2];
    const path = makePath(dirs);
    expect(popAll(rbAlignPath(path))).toEqual(dirs);
    expect(popAll(path)).not.toEqual(dirs);
  });

  it('a 21-step path survives the round trip across the word boundary', () => {
    const dirs = Array.from({ length: 21 }, (_, i) => (i * 4 + 2) % 6);
    const path = makePath(dirs);
    expect(path.hi).toBeGreaterThan(0); // really uses both words
    expect(popAll(rbAlignPath(path))).toEqual(dirs);
    expect(pathSteps(path)).toBe(21);
  });

  it('the empty path yields null (an endless loop in the original)', () => {
    expect(popPathDir({ hi: 0, lo: 0 })).toBeNull();
  });
});
