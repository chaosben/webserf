import { describe, it, expect } from 'vitest';
import {
  analyzeSoil,
  SOIL_ANALYSIS_MAX,
  SOIL_ANALYSIS_RINGS,
  SOIL_ANALYSIS_RING_SIDES,
} from './soil-analysis.js';
import { mapGeometry, posOf, Direction, neighbor } from './position.js';
import type { GameState, Player, Tile } from './state.js';

const geo = mapGeometry(3); // 64 × 64

function tile(over: Partial<Tile> = {}): Tile {
  return {
    height: 10,
    terrainUp: 5,
    terrainDown: 5,
    object: 0,
    owner: 0,
    paths: 0,
    blocked: false,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: 0,
    ...over,
  };
}

function player(): Player {
  return { slot: 0, index: 0, active: true, analysis: [0, 0, 0, 0] } as unknown as Player;
}

function state(): GameState {
  const mapTiles: Tile[] = [];
  for (let i = 0; i < geo.cols * geo.rows; i++) mapTiles.push(tile());
  return { geo, mapTiles, players: [player()] } as unknown as GameState;
}

function at(st: GameState, col: number, row: number): Tile {
  return st.mapTiles[posOf(col, row, geo)]!;
}

/**
 * Walks the same spiral as the analysis and yields the total weight per tile position (a position can
 * be hit by several rings, since the original's spiral overlaps). Written independently of
 * `analyzeSoil` and used as an expectation generator.
 */
function walkWeights(col: number, row: number): Map<number, number> {
  const weights = new Map<number, number>();
  let pos = posOf(col, row, geo);
  let weight = SOIL_ANALYSIS_RINGS;
  for (let ring = 0; ring < SOIL_ANALYSIS_RINGS; ring++) {
    pos = neighbor(pos, Direction.Right, geo);
    for (const dir of SOIL_ANALYSIS_RING_SIDES) {
      for (let step = 0; step <= ring; step++) {
        weights.set(pos, (weights.get(pos) ?? 0) + weight);
        pos = neighbor(pos, dir, geo);
      }
    }
    weight--;
  }
  return weights;
}

describe('spiral geometry (FUN_0003f42c)', () => {
  it('covers 1800 distinct tiles - each exactly once, ring r holding 6*(r+1) tiles', () => {
    const weights = walkWeights(32, 32);
    let total = 0;
    for (let ring = 0; ring < SOIL_ANALYSIS_RINGS; ring++) total += 6 * (ring + 1);
    expect(total).toBe(1800);
    // No double visits: otherwise there would be fewer positions than visits, i.e. total weights
    // matching no single ring.
    expect(weights.size).toBe(total);
    for (let ring = 0; ring < SOIL_ANALYSIS_RINGS; ring++) {
      const w = SOIL_ANALYSIS_RINGS - ring;
      const count = [...weights.values()].filter((v) => v === w).length;
      expect(count, `ring ${ring}`).toBe(6 * (ring + 1));
    }
  });

  it('the centre itself is never evaluated', () => {
    expect(walkWeights(32, 32).has(posOf(32, 32, geo))).toBe(false);
  });

  it('the first evaluated neighbour is Right of the centre and carries the full weight 24', () => {
    const w = walkWeights(32, 32);
    expect(w.get(posOf(33, 32, geo))).toBeGreaterThanOrEqual(SOIL_ANALYSIS_RINGS);
  });
});

describe('analyzeSoil', () => {
  it('empty map -> all four sums 0 and written into player.analysis', () => {
    const st = state();
    const p = st.players[0]!;
    p.analysis = [7, 7, 7, 7];
    expect(analyzeSoil(st, p, 32, 32)).toEqual([0, 0, 0, 0]);
    expect(p.analysis).toEqual([0, 0, 0, 0]);
  });

  it('a single deposit: sum == (amount · total weight) >> 4 in the right slot', () => {
    for (const mineral of [1, 2, 3, 4]) {
      const st = state();
      const p = st.players[0]!;
      const t = at(st, 33, 32); // the immediate Right neighbour of the centre
      t.mineral = mineral;
      t.resourceAmount = 9;
      const expected = (9 * walkWeights(32, 32).get(posOf(33, 32, geo))!) >>> 4;
      const got = analyzeSoil(st, p, 32, 32);
      expect(got[mineral - 1]).toBe(expected);
      expect(got.reduce((a, b) => a + b, 0)).toBe(expected); // only this slot
    }
  });

  it('tiles with object 1..7 do not count, object 0 and 8 upwards do', () => {
    const run = (object: number): number => {
      const st = state();
      const t = at(st, 33, 32);
      t.mineral = 3;
      t.resourceAmount = 9;
      t.object = object;
      return analyzeSoil(st, st.players[0]!, 32, 32)[2];
    };
    const counted = run(0);
    expect(counted).toBeGreaterThan(0);
    for (let obj = 1; obj <= 7; obj++) expect(run(obj)).toBe(0);
    expect(run(8)).toBe(counted);
    expect(run(72)).toBe(counted);
  });

  it('mineral type 0 with a remaining amount (a fish tile) does not count', () => {
    const st = state();
    const t = at(st, 33, 32);
    t.mineral = 0;
    t.resourceAmount = 31;
    expect(analyzeSoil(st, st.players[0]!, 32, 32)).toEqual([0, 0, 0, 0]);
  });

  it('inner rings weigh more than outer ones', () => {
    const near = state();
    at(near, 33, 32).mineral = 1;
    at(near, 33, 32).resourceAmount = 31;
    const far = state();
    at(far, 32 + 20, 32).mineral = 1;
    at(far, 32 + 20, 32).resourceAmount = 31;
    const a = analyzeSoil(near, near.players[0]!, 32, 32)[0];
    const b = analyzeSoil(far, far.players[0]!, 32, 32)[0];
    expect(a).toBeGreaterThan(b);
  });

  it('the raw sum is capped at 999', () => {
    const st = state();
    for (let row = 0; row < geo.rows; row++) {
      for (let col = 0; col < geo.cols; col++) {
        const t = at(st, col, row);
        t.mineral = 2;
        t.resourceAmount = 31;
      }
    }
    expect(analyzeSoil(st, st.players[0]!, 32, 32)[1]).toBe(SOIL_ANALYSIS_MAX);
  });

  it('wraps toroidally around the map edge (an analysis at (0,0) finds deposits at cols-1)', () => {
    const st = state();
    at(st, geo.cols - 1, 0).mineral = 4;
    at(st, geo.cols - 1, 0).resourceAmount = 20;
    expect(analyzeSoil(st, st.players[0]!, 0, 0)[3]).toBeGreaterThan(0);
  });
});
