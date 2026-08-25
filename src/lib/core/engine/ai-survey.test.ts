import { describe, it, expect } from 'vitest';
import {
  AI_SURVEY_SLOTS,
  AI_SURVEY_START_WEIGHT,
  SURVEY_FOREIGN_LAND,
  SURVEY_FREE_LAND,
  SURVEY_OWN_LAND,
  SURVEY_PATHS,
  SURVEY_TERRAIN_HIGH,
  SURVEY_TERRAIN_LOW,
  SURVEY_WATER,
  SURVEY_BUILDING_BASE,
  aiSurveySurroundings,
  surveyStagePlan,
} from './ai-survey.js';
import { Direction, mapGeometry, neighbor, posOf } from './position.js';
import type { GameState, Player, Tile } from './state.js';

/**
 * The AI surroundings survey (`FUN_000606d2` + its six scan routines).
 *
 * What is testable with synthetic data — and it is exactly what real save games do NOT show: the
 * ring geometry around a single marked tile, the weight sequence, the early return of the flag head,
 * the snapshot semantics and the owner quirk of the `else` branch.
 */

const MAP_SIZE = 3;
const GEO = mapGeometry(MAP_SIZE);

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
  } as Tile;
}

/** Only the fields the survey touches. */
function makeState(): GameState {
  return {
    geo: GEO,
    mapTiles: Array.from({ length: GEO.tileCount }, () => tile()),
    buildings: [],
  } as unknown as GameState;
}

/** Set the building table — `GameState.buildings` is `readonly`, tests need write access. */
function setBuildings(st: GameState, list: unknown[]): void {
  (st as { buildings: unknown[] }).buildings = list;
}

function makePlayer(col: number, row: number, slot = 0): Player {
  return { slot, cursorCol: col, cursorRow: row, flags: 0 } as unknown as Player;
}

const CENTER_COL = 32;
const CENTER_ROW = 32;

/**
 * The tiles of the ring with radius `r` around the centre, in the original's order.
 *
 * Deliberate limit: this walk mirrors the port. If the direction order or the DownRight start step
 * were wrong, both would be wrong and these tests would stay green (that side is pinned against the
 * binary elsewhere, @0x60f33/@0x61067). What these tests carry is the ASSIGNMENT of weight to ring
 * and the feature selection per scan — for that a walk agreeing with the port suffices.
 */
function ringTiles(r: number): number[] {
  let pos = posOf(CENTER_COL, CENTER_ROW, GEO);
  const out: number[] = [];
  for (let ring = 0; ring < r; ring++) {
    pos = neighbor(pos, Direction.DownRight, GEO);
    out.length = 0;
    for (let dir = Direction.Up as number; dir >= Direction.Right; dir--) {
      for (let step = 0; step <= ring; step++) {
        pos = neighbor(pos, dir as Direction, GEO);
        out.push(pos);
      }
    }
  }
  return out;
}

describe('ai-survey: ring geometry and weights', () => {
  it('visits exactly 6*(ring+1) tiles per ring', () => {
    for (const r of [1, 2, 3, 5]) expect(ringTiles(r)).toHaveLength(6 * r);
  });

  it('the land sum is a pure function of the rings — 4992 at 12, 6840 at 18', () => {
 // Every visited tile counts with its weight into exactly one of the three land slots, so the sum
 // depends only on ring count and weight sequence, not on the map.
    const st = makeState();
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    for (const [poss, want] of [[2, 4992], [3, 4992], [4, 6840], [5, 6840]] as const) {
      const t = aiSurveySurroundings(st, p, poss).tables[0] as number[];
      const sum = t[SURVEY_OWN_LAND]! + t[SURVEY_FREE_LAND]! + t[SURVEY_FOREIGN_LAND]!;
      expect(sum, `possibility ${poss}`).toBe(want);
 // Computed analytically: sum of 6*(r+1)*(18-r) over the rings of the plan.
      const rings = surveyStagePlan(poss).reduce((n, s) => n + s.count + 1, 0);
      let analytic = 0;
      for (let r = 0; r < rings; r++) analytic += 6 * (r + 1) * (AI_SURVEY_START_WEIGHT - r);
      expect(sum).toBe(analytic);
    }
  });

  it('weights the innermost ring with 18 and each further one 1 less', () => {
 // Mark a single tile per ring as foreign land: the counter is then exactly its weight — the only
 // place where the weight SEQUENCE becomes directly visible.
    for (const r of [1, 2, 3, 4]) {
      const st = makeState();
      const target = ringTiles(r)[0] as number;
      st.mapTiles[target] = tile({ owner: 4 }); // slot 3 => never 'own' for player 0
      const p = makePlayer(CENTER_COL, CENTER_ROW);
      const t = aiSurveySurroundings(st, p, 5).tables[0] as number[];
      expect(t[SURVEY_FOREIGN_LAND], `ring ${r}`).toBe(AI_SURVEY_START_WEIGHT - (r - 1));
    }
  });
});

describe('ai-survey: the snapshot semantics of the four tables', () => {
  it('three stages => snapshot 1 == final state; four stages => not', () => {
    const st = makeState();
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    for (const poss of [2, 3]) {
      const tab = aiSurveySurroundings(st, p, poss).tables;
      expect(tab[1], `possibility ${poss}`).toEqual(tab[0]);
    }
    for (const poss of [4, 5]) {
      const tab = aiSurveySurroundings(st, p, poss).tables;
      expect(tab[1], `possibility ${poss}`).not.toEqual(tab[0]);
    }
  });

  it('the snapshots grow monotonically outwards: T3 <= T2 <= T1 <= T0', () => {
    const st = makeState();
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    const tab = aiSurveySurroundings(st, p, 5).tables as number[][];
    for (let i = 0; i < AI_SURVEY_SLOTS; i++) {
      expect(tab[3]![i]).toBeLessThanOrEqual(tab[2]![i]!);
      expect(tab[2]![i]).toBeLessThanOrEqual(tab[1]![i]!);
      expect(tab[1]![i]).toBeLessThanOrEqual(tab[0]![i]!);
    }
  });

  it('possibility 1 fills NO snapshot (there is no copy step there)', () => {
    const st = makeState();
 // Terrain such that the flag head fails and the ring walk really runs.
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    const tab = aiSurveySurroundings(st, p, 1).tables as number[][];
    expect(tab[1]!.every((x) => x === 0)).toBe(true);
    expect(tab[2]!.every((x) => x === 0)).toBe(true);
    expect(tab[3]!.every((x) => x === 0)).toBe(true);
  });
});

describe('ai-survey: the flag head', () => {
  it('returns BEFORE the first ring on success — table 0 carries only slot 37 = 100', () => {
    const st = makeState();
 // Success path of the non-water branch: cursor not water on top, neighbour UpLeft not water in
 // either triangle, and the tile right of it not water on top either.
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    const t = aiSurveySurroundings(st, p, 1).tables[0] as number[];
    expect(t[SURVEY_PATHS]).toBe(100);
    expect(t.filter((x) => x !== 0)).toHaveLength(1);
  });

  it('does not enter the head at all for lower triangle terrain 8..10', () => {
    const st = makeState();
    const start = posOf(CENTER_COL, CENTER_ROW, GEO);
    st.mapTiles[start] = tile({ terrainDown: 9 });
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    const t = aiSurveySurroundings(st, p, 1).tables[0] as number[];
 // No head result, but the ring walk over three rings.
    expect(t[SURVEY_PATHS]).toBe(0);
    const sum = t[SURVEY_OWN_LAND]! + t[SURVEY_FREE_LAND]! + t[SURVEY_FOREIGN_LAND]!;
    expect(sum).toBe(6 * 1 * 18 + 6 * 2 * 17 + 6 * 3 * 16); // 108 + 204 + 288
  });

  it('writes -1 on failure and then walks the rings', () => {
    const st = makeState();
 // Neighbour UpLeft is water in the lower triangle => the non-water branch breaks.
    const up = neighbor(posOf(CENTER_COL, CENTER_ROW, GEO), Direction.UpLeft, GEO);
    st.mapTiles[up] = tile({ terrainDown: 1 });
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    const t = aiSurveySurroundings(st, p, 1).tables[0] as number[];
 // -1 from the head, plus the road count of the rings (0 here, no roads are set).
    expect(t[SURVEY_PATHS]).toBe(-1);
    expect(t[SURVEY_WATER]).toBeGreaterThan(0); // the water tile lies in ring 1
  });
});

describe('ai-survey: what the individual scans count', () => {
  it('`full` (possibility 5) does NOT count buildings, `objectsPaths` (possibility 2) does', () => {
 // `FUN_00060a3a` jumps over the object block when it hits a building.
    const st = makeState();
    const target = ringTiles(1)[0] as number;
    st.mapTiles[target] = tile({ object: 2, objIndex: 1 });
    setBuildings(st, [null, { type: 11, constructing: false }]);
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    const hutSlot = SURVEY_BUILDING_BASE + 11;
    expect((aiSurveySurroundings(st, p, 5).tables[0] as number[])[hutSlot]).toBe(0);
    expect((aiSurveySurroundings(st, p, 2).tables[0] as number[])[hutSlot]).toBe(18);
  });

  it('`full` counts NO roads either — only `objectsPaths`/`objectsPathsMeadow` do', () => {
    const st = makeState();
    const target = ringTiles(1)[0] as number;
    st.mapTiles[target] = tile({ paths: 0x01 });
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    expect((aiSurveySurroundings(st, p, 5).tables[0] as number[])[SURVEY_PATHS]).toBe(0);
    expect((aiSurveySurroundings(st, p, 2).tables[0] as number[])[SURVEY_PATHS]).toBe(18);
  });

  it('`objectsFinished` (the else branch) counts FINISHED buildings only', () => {
    const st = makeState();
    const target = ringTiles(1)[0] as number;
    st.mapTiles[target] = tile({ object: 2, objIndex: 1 });
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    const hutSlot = SURVEY_BUILDING_BASE + 11;
    setBuildings(st, [null, { type: 11, constructing: true }]);
    expect((aiSurveySurroundings(st, p, 0).tables[0] as number[])[hutSlot]).toBe(0);
    setBuildings(st, [null, { type: 11, constructing: false }]);
    expect((aiSurveySurroundings(st, p, 0).tables[0] as number[])[hutSlot]).toBe(18);
 // Possibility 2 does include the construction site (mask 0x7c without a sign test).
    setBuildings(st, [null, { type: 11, constructing: true }]);
    expect((aiSurveySurroundings(st, p, 2).tables[0] as number[])[hutSlot]).toBe(18);
  });

  it('only `full` counts the two terrain classes (4..7 and 11..14)', () => {
    const st = makeState();
    const p = makePlayer(CENTER_COL, CENTER_ROW);
 // Base terrain is 5 everywhere => every visited tile falls into the lower class.
    const t5 = aiSurveySurroundings(st, p, 5).tables[0] as number[];
    expect(t5[SURVEY_TERRAIN_LOW]).toBe(6840);
    expect(t5[SURVEY_TERRAIN_HIGH]).toBe(0);
    const t2 = aiSurveySurroundings(st, p, 2).tables[0] as number[];
    expect(t2[SURVEY_TERRAIN_LOW]).toBe(0);
 // Counter check for the upper class.
    for (const tl of st.mapTiles) tl.terrainDown = 12;
    const t5b = aiSurveySurroundings(st, p, 5).tables[0] as number[];
    expect(t5b[SURVEY_TERRAIN_LOW]).toBe(0);
    expect(t5b[SURVEY_TERRAIN_HIGH]).toBe(6840);
  });

  it('only `full` counts minerals, and separated by kind', () => {
    const st = makeState();
    const ring = ringTiles(1);
    st.mapTiles[ring[0] as number] = tile({ mineral: 3 }); // coal
    st.mapTiles[ring[1] as number] = tile({ mineral: 1 }); // gold
    const p = makePlayer(CENTER_COL, CENTER_ROW);
    const t = aiSurveySurroundings(st, p, 5).tables[0] as number[];
    expect(t[SURVEY_PATHS + 3]).toBe(18);
    expect(t[SURVEY_PATHS + 1]).toBe(18);
    expect((aiSurveySurroundings(st, p, 2).tables[0] as number[])[SURVEY_PATHS + 3]).toBe(0);
  });
});

describe('ai-survey: the owner quirk of the else branch', () => {
  it('on an unowned cursor the else branch counts slot 0 land as own', () => {
 // Branch B of the probe calls with possibility 0; there the comparison value comes from the owner
 // BITS of the cursor tile without the 'has owner' test. On unowned land those bits are 0 — which is
 // the bit pattern of player slot 0.
    const st = makeState();
    const target = ringTiles(1)[0] as number;
    st.mapTiles[target] = tile({ owner: 1 }); // slot 0
 // The cursor itself stays unowned. The player is slot 2, so it does NOT match.
    const p = makePlayer(CENTER_COL, CENTER_ROW, 2);
    const t = aiSurveySurroundings(st, p, 0).tables[0] as number[];
    expect(t[SURVEY_OWN_LAND]).toBe(18);
    expect(t[SURVEY_FOREIGN_LAND]).toBe(0);
 // With possibility 1..5 the same tile counts as foreign (compared against slot 2).
    const t2 = aiSurveySurroundings(st, p, 2).tables[0] as number[];
    expect(t2[SURVEY_OWN_LAND]).toBe(0);
    expect(t2[SURVEY_FOREIGN_LAND]).toBe(18);
  });
});
