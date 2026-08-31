import { describe, expect, it } from 'vitest';
import {
  GROUND_WORD_NONE,
  diffGroundRows,
  groundTileWord,
  mergeRowRuns,
  dirtyArea,
  intersectsAny,
  planRetention,
  rectsIntersect,
  type Rect,
} from './terrain-retention.js';

const W = 640;
const H = 480;

/** Do the rects cover the area completely and without overlap? */
function isDisjoint(rects: readonly Rect[]): boolean {
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++)
      if (rectsIntersect(rects[i]!, rects[j]!)) return false;
  return true;
}

describe('planRetention — edge cases', () => {
  it('empty surface => everything is dirty', () => {
    const p = planRetention(null, { x: 100, y: 100 }, W, H);
    expect(p.shift).toBeNull();
    expect(p.dirty).toEqual([{ x: 0, y: 0, w: W, h: H }]);
  });

  it('no scroll => nothing to do (the most common frame)', () => {
    const p = planRetention({ x: 100, y: 100 }, { x: 100, y: 100 }, W, H);
    expect(p.shift).toEqual({ dx: 0, dy: 0 });
    expect(p.dirty).toEqual([]);
    expect(dirtyArea(p)).toBe(0);
  });

  it('jump without overlap => everything dirty instead of a pointless copy', () => {
    expect(planRetention({ x: 0, y: 0 }, { x: W, y: 0 }, W, H).shift).toBeNull();
    expect(planRetention({ x: 0, y: 0 }, { x: 0, y: -H }, W, H).shift).toBeNull();
    expect(planRetention({ x: 0, y: 0 }, { x: 5000, y: 9000 }, W, H).shift).toBeNull();
  });
});

describe('planRetention — scroll directions', () => {
  it('camera right => content left, new strip on the RIGHT', () => {
    const p = planRetention({ x: 100, y: 0 }, { x: 132, y: 0 }, W, H);
    expect(p.shift).toEqual({ dx: -32, dy: 0 });
    expect(p.dirty).toEqual([{ x: W - 32, y: 0, w: 32, h: H }]);
  });

  it('camera left => new strip on the LEFT', () => {
    const p = planRetention({ x: 132, y: 0 }, { x: 100, y: 0 }, W, H);
    expect(p.shift).toEqual({ dx: 32, dy: 0 });
    expect(p.dirty).toEqual([{ x: 0, y: 0, w: 32, h: H }]);
  });

  it('camera down => new strip at the BOTTOM', () => {
    const p = planRetention({ x: 0, y: 0 }, { x: 0, y: 20 }, W, H);
    expect(p.shift).toEqual({ dx: 0, dy: -20 });
    expect(p.dirty).toEqual([{ x: 0, y: H - 20, w: W, h: 20 }]);
  });

  it('camera up => new strip at the TOP', () => {
    const p = planRetention({ x: 0, y: 20 }, { x: 0, y: 0 }, W, H);
    expect(p.shift).toEqual({ dx: 0, dy: 20 });
    expect(p.dirty).toEqual([{ x: 0, y: 0, w: W, h: 20 }]);
  });
});

describe('planRetention — diagonal', () => {
  it('two DISJOINT strips (the horizontal one leaves the vertical one out)', () => {
    const p = planRetention({ x: 0, y: 0 }, { x: 32, y: 20 }, W, H);
    expect(p.shift).toEqual({ dx: -32, dy: -20 });
    expect(p.dirty).toHaveLength(2);
    expect(isDisjoint(p.dirty)).toBe(true);
    expect(p.dirty).toEqual([
      { x: W - 32, y: 0, w: 32, h: H }, // new on the right, full height
      { x: 0, y: H - 20, w: W - 32, h: 20 }, // new at the bottom, without the right column
    ]);
  });

  it('disjoint and inside the surface in all four diagonals', () => {
    for (const [ddx, ddy] of [
      [32, 20],
      [-32, 20],
      [32, -20],
      [-32, -20],
    ] as const) {
      const p = planRetention({ x: 200, y: 200 }, { x: 200 + ddx, y: 200 + ddy }, W, H);
      expect(isDisjoint(p.dirty), `diagonal ${ddx}/${ddy}`).toBe(true);
      for (const r of p.dirty) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(W);
        expect(r.y + r.h).toBeLessThanOrEqual(H);
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
      }
    }
  });

  it('covers exactly the area the shift leaves uncovered', () => {
    // That is the invariant that matters: shifted area + dirty area == the whole window.
    for (const [ddx, ddy] of [
      [32, 0],
      [0, 20],
      [32, 20],
      [-13, -7],
      [-639, 0],
      [1, 479],
    ] as const) {
      const p = planRetention({ x: 500, y: 500 }, { x: 500 + ddx, y: 500 + ddy }, W, H);
      const kept = (W - Math.abs(ddx)) * (H - Math.abs(ddy));
      expect(kept + dirtyArea(p), `shift ${ddx}/${ddy}`).toBe(W * H);
    }
  });
});

describe('planRetention — cost ratio', () => {
  it('one tile step costs only a fraction of the area', () => {
    // The actual reason for the retention: 32 px of scroll touch 5 % of the window.
    const p = planRetention({ x: 0, y: 0 }, { x: 32, y: 0 }, W, H);
    expect(dirtyArea(p) / (W * H)).toBeLessThan(0.06);
  });
});

describe('rect helpers', () => {
  it('rectsIntersect: touching edges do not count as an intersection', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: 9, y: 0, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 0, y: 10, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: -5, y: -5, w: 10, h: 10 })).toBe(true);
  });

  it('intersectsAny picks the commands reaching into a dirty strip', () => {
    const dirty = planRetention({ x: 0, y: 0 }, { x: 32, y: 0 }, W, H).dirty;
    // A triangle whose anchor is on the left but whose sprite reaches into the right strip MUST be
    // drawn along (overlap => painter order, see the module head).
    expect(intersectsAny({ x: W - 40, y: 100, w: 32, h: 20 }, dirty)).toBe(true);
    expect(intersectsAny({ x: 100, y: 100, w: 32, h: 20 }, dirty)).toBe(false);
  });
});

describe('diffGroundRows', () => {
  const tile = (paths: number) => ({ height: 3, terrainUp: 1, terrainDown: 2, paths, owner: 0 });
  const make = (cols: number, rows: number) => Array.from({ length: cols * rows }, () => tile(0));
  const fresh = (n: number) => new Uint32Array(n).fill(GROUND_WORD_NONE);

  it('reports every row over the full width on the FIRST pass', () => {
    const d = diffGroundRows(make(64, 64), 64, 64, fresh(64 * 64));
    expect(d.rows).toHaveLength(64);
    expect(d.rows[0]).toBe(0);
    expect(d.rows[63]).toBe(63);
    expect(d.colLo.every((v) => v === 0)).toBe(true);
    expect(d.colHi.every((v) => v === 63)).toBe(true);
  });

  // Why GROUND_WORD_NONE instead of a zero: a tile whose five fields are all 0 is possible (water at
  // the map edge, no road, no owner). In a zero-filled buffer it would count as "unchanged" and stay
  // UNDRAWN in the first build.
  it('reports a tile whose word is 0 as well', () => {
    const zero = [{ height: 0, terrainUp: 0, terrainDown: 0, paths: 0, owner: 0 }];
    expect(groundTileWord(zero[0]!)).toBe(0);
    expect(diffGroundRows(zero, 1, 1, fresh(1)).rows).toEqual([0]);
    expect(diffGroundRows(zero, 1, 1, new Uint32Array(1)).rows).toEqual([]);
  });

  it('reports nothing once the words have been carried forward', () => {
    const tiles = make(64, 64);
    const words = fresh(64 * 64);
    diffGroundRows(tiles, 64, 64, words);
    expect(diffGroundRows(tiles, 64, 64, words).rows).toEqual([]);
  });

  // A row MUST span all columns. Blocking two-dimensionally would let a change in the right half of
  // the map point at an empty row range, and it would never be redrawn.
  it('covers ALL columns of a row — the last one too, and reports the column', () => {
    for (const col of [0, 31, 32, 63]) {
      const tiles = make(64, 64);
      const words = fresh(64 * 64);
      diffGroundRows(tiles, 64, 64, words);
      tiles[10 * 64 + col] = tile(0x2a);
      const d = diffGroundRows(tiles, 64, 64, words);
      expect(d.rows, `column ${col}`).toEqual([10]);
      expect([d.colLo[0], d.colHi[0]], `column ${col}`).toEqual([col, col]);
    }
  });

  it('reports the affected row, not its band', () => {
    const tiles = make(64, 64);
    const words = fresh(64 * 64);
    diffGroundRows(tiles, 64, 64, words);
    tiles[40 * 64 + 5] = tile(0x11);
    // The earlier 32-row bands would have reported "band 1" here, i.e. 32 rows to redraw — 130 ms for
    // a single tile on the largest map.
    expect(diffGroundRows(tiles, 64, 64, words).rows).toEqual([40]);
  });

  // The column bounds are the second lever: without them the strip was full width (32 ms).
  it('bounds the changed columns of a row, not the ones in between', () => {
    const tiles = make(64, 8);
    const words = fresh(64 * 8);
    diffGroundRows(tiles, 64, 8, words);
    tiles[3 * 64 + 7] = tile(0x1);
    tiles[3 * 64 + 20] = tile(0x1);
    const d = diffGroundRows(tiles, 64, 8, words);
    expect(d.rows).toEqual([3]);
    expect([d.colLo[0], d.colHi[0]]).toEqual([7, 20]);
  });

  it('takes exactly the five fields of the global signature', () => {
    for (const key of ['height', 'terrainUp', 'terrainDown', 'paths', 'owner'] as const) {
      const base = make(8, 4);
      const words = fresh(8 * 4);
      diffGroundRows(base, 8, 4, words);
      const t = base[8]!; // row 1
      base[8] = { ...t, [key]: (t[key] + 1) & 0x7 };
      expect(diffGroundRows(base, 8, 4, words).rows, key).toEqual([1]);
    }
  });

  it('the word is collision free — 22 bits, every field in its place', () => {
    const t = { height: 0x1f, terrainUp: 0xf, terrainDown: 0xf, paths: 0x3f, owner: 0x7 };
    expect(groundTileWord(t)).toBe(0x3fffff);
    expect(groundTileWord({ ...t, paths: 0 })).toBe(0x3fffc0);
    expect(GROUND_WORD_NONE > 0x3fffff).toBe(true);
  });
});

describe('mergeRowRuns', () => {
  const diff = (rows: number[], lo: number[] = rows.map(() => 0), hi = lo) => ({
    rows,
    colLo: lo,
    colHi: hi,
  });
  const shape = (runs: readonly { r0: number; r1: number }[]) => runs.map((r) => [r.r0, r.r1]);

  it('merges only what the gap allows', () => {
    expect(shape(mergeRowRuns(diff([5]), 8))).toEqual([[5, 6]]);
    expect(shape(mergeRowRuns(diff([5, 6, 7]), 8))).toEqual([[5, 8]]);
    // Gap 8 => still merged (14 - 6 == 8), gap 9 => separate.
    expect(shape(mergeRowRuns(diff([5, 14]), 8))).toEqual([[5, 15]]);
    expect(shape(mergeRowRuns(diff([5, 15]), 8))).toEqual([
      [5, 6],
      [15, 16],
    ]);
  });

  // Bridging is mandatory, not cosmetic: because of the height lift the scene strip of a row is
  // several rows tall, so two nearby runs would compose the same pixels twice. Merging more coarsely
  // is allowed, more finely is not.
  it('at gap 0 every row stays its own run', () => {
    expect(shape(mergeRowRuns(diff([1, 2, 4]), 0))).toEqual([
      [1, 3],
      [4, 5],
    ]);
  });

  it('empty stays empty', () => {
    expect(mergeRowRuns(diff([]), 8)).toEqual([]);
  });

  // When merging, the column bounds have to be UNIONED — otherwise the run redraws part of its rows
  // in the wrong place, and that only shows at the pixel.
  it('unions the column bounds of the merged rows', () => {
    const runs = mergeRowRuns(diff([5, 6, 7], [10, 3, 40], [12, 3, 41]), 8);
    expect(runs).toHaveLength(1);
    expect([runs[0]!.colLo, runs[0]!.colHi]).toEqual([3, 41]);
  });

  it('separate runs keep their own column bounds', () => {
    const runs = mergeRowRuns(diff([5, 40], [10, 200], [12, 201]), 8);
    expect(runs).toHaveLength(2);
    expect([runs[0]!.colLo, runs[0]!.colHi]).toEqual([10, 12]);
    expect([runs[1]!.colLo, runs[1]!.colHi]).toEqual([200, 201]);
  });
});
