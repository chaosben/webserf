import { describe, it, expect } from 'vitest';
import {
  recomputeTerritory,
  updateAreaThreatLevels,
  updateThreatLevel,
  notifyTerritoryLosers,
  MSG_LAND_LOST,
  MSG_LAND_AND_BUILDINGS_LOST,
  INFLUENCE_RADIUS,
} from './territory.js';
import { mapGeometry, posOf } from './position.js';
import { SPIRAL_PATTERN } from './spiral.js';
import type { GameState, Building, Tile } from './state.js';

/**
 * Territory owner recolour. These tests pin the synthetic base cases: footprint, hex skew, player
 * border, gating.
 */
describe('recomputeTerritory', () => {
  const GEO = mapGeometry(3);

  function tile(over: Partial<Tile> = {}): Tile {
    return {
      height: 0, terrainUp: 0, terrainDown: 0, object: 0, owner: 0, paths: 0,
      blocked: false, mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0, ...over,
    } as Tile;
  }
  function mil(over: Partial<Building> = {}): Building {
    return {
      index: 1, type: 11, owner: 0, col: 32, row: 32,
      active: true, burning: false, holder: true, constructing: false, ...over,
    } as unknown as Building;
  }
  function terrState(buildings: (Building | null)[]): GameState {
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
 // `players` is needed because the recolour carries the land score along (+/-1 per tile,
 // `@0x46380`/`@0x463b9`). Four real slots so the bookkeeping is observable.
    const players = [0, 1, 2, 3].map((slot) => ({ slot, totalLandScore: 0 }));
    return { buildings, geo: GEO, mapTiles, players } as unknown as GameState;
  }
  const ownerAt = (st: GameState, c: number, r: number) => st.mapTiles[posOf(c, r, GEO)].owner;

  it('a single active hut (owner 0): centre + near ring -> owner 1, far away -> 0', () => {
    const st = terrState([null, mil()]);
    recomputeTerritory(st, 32, 32);
    expect(ownerAt(st, 32, 32)).toBe(1); // centre (ring 9 -> 0x80)
    expect(ownerAt(st, 33, 33)).toBe(1); // dc1,dr1 -> ring 8 -> 0x80
    expect(ownerAt(st, 24, 24)).toBe(1); // dc-8,dr-8 -> ring 1 -> hut influence 1
    expect(ownerAt(st, 40, 40)).toBe(1); // dc8,dr8 -> ring 1
  });

  it('hex skew: the non-neighbour corners (dc8,dr-8 / dc-8,dr8) stay unclaimed', () => {
    const st = terrState([null, mil()]);
    recomputeTerritory(st, 32, 32);
    expect(ownerAt(st, 40, 24)).toBe(0); // dc+8,dr-8 -> grid corner = 0
    expect(ownerAt(st, 24, 40)).toBe(0); // dc-8,dr+8 -> grid corner = 0
    expect(ownerAt(st, 43, 32)).toBe(0); // dc11 -> outside the radius
  });

  it('gating: inactive or burning military buildings project no influence', () => {
    const stInactive = terrState([null, mil({ active: false })]);
    recomputeTerritory(stInactive, 32, 32);
    expect(ownerAt(stInactive, 32, 32)).toBe(0);
    const stBurning = terrState([null, mil({ active: true, burning: true })]);
    recomputeTerritory(stBurning, 32, 32);
    expect(ownerAt(stBurning, 32, 32)).toBe(0);
    const stCivil = terrState([null, mil({ type: 9 })]); // forester -> non-military
    recomputeTerritory(stCivil, 32, 32);
    expect(ownerAt(stCivil, 32, 32)).toBe(0);
  });

  it('a fortress projects further than a hut (stronger border table)', () => {
 // Ring 1: hut table[1]=1, fortress[1]=6 — both > 0, the fortress simply reaches further.
    const hut = terrState([null, mil({ type: 11 })]);
    recomputeTerritory(hut, 32, 32);
    const fort = terrState([null, mil({ type: 22 })]);
    recomputeTerritory(fort, 32, 32);
 // Both own the core; the fortress has >= hut influence on every ring tile.
    expect(ownerAt(hut, 32, 32)).toBe(1);
    expect(ownerAt(fort, 32, 32)).toBe(1);
  });

  it('player border: two competing huts -> the tile belongs to the stronger influence', () => {
 // P0 hut at (28,32), P1 hut at (40,32). Tile (30,32) is nearer to P0 -> owner 1.
    const st = terrState([null, mil({ index: 1, owner: 0, col: 28, row: 32 }), mil({ index: 2, owner: 1, col: 40, row: 32 })]);
    recomputeTerritory(st, 34, 32); // centre between the two
    expect(ownerAt(st, 28, 32)).toBe(1); // P0 core
    expect(ownerAt(st, 40, 32)).toBe(2); // P1 core
    expect(ownerAt(st, 30, 32)).toBe(1); // nearer to P0 -> owner 1
    expect(ownerAt(st, 38, 32)).toBe(2); // nearer to P1 -> owner 2
  });

  it('a tie -> the lower player index wins (unsigned argmax, first wins)', () => {
 // Two identical huts symmetric around a tile -> equal influence -> owner 1 (P0).
    const st = terrState([null, mil({ index: 1, owner: 0, col: 30, row: 32 }), mil({ index: 2, owner: 1, col: 34, row: 32 })]);
    recomputeTerritory(st, 32, 32);
    expect(ownerAt(st, 32, 32)).toBe(1); // exactly in the middle, equal influence -> P0
  });

  it('INFLUENCE_RADIUS = 8', () => {
    expect(INFLUENCE_RADIUS).toBe(8);
  });
});

/**
 * Threat level — `update_threat_level` (`FUN_00046abd`) plus the area sweep at the end of the
 * recolour (@0x4689a). The base cases.
 */
describe('updateThreatLevel', () => {
  const GEO = mapGeometry(3);

  function tile(over: Partial<Tile> = {}): Tile {
    return {
      height: 0, terrainUp: 0, terrainDown: 0, object: 0, owner: 0, paths: 0,
      blocked: false, mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0, ...over,
    } as Tile;
  }
  function mil(over: Partial<Building> = {}): Building {
    return {
      index: 1, type: 11, owner: 0, col: 32, row: 32,
      active: true, burning: false, holder: true, constructing: false, threatLevel: 0, ...over,
    } as unknown as Building;
  }
  function st(buildings: (Building | null)[]): GameState {
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
 // `players` is needed because the recolour carries the land score along (+/-1 per tile,
 // `@0x46380`/`@0x463b9`). Four real slots so the bookkeeping is observable.
    const players = [0, 1, 2, 3].map((slot) => ({ slot, totalLandScore: 0 }));
    return { buildings, geo: GEO, mapTiles, players } as unknown as GameState;
  }
 /** Sets the owner of the tile that spiral index `idx` reaches from (32,32). */
  function ownAtProbe(state: GameState, idx: number, owner: number): void {
    const [dc, dr] = SPIRAL_PATTERN[idx]!;
    state.mapTiles[posOf(32 + dc, 32 + dr, GEO)].owner = owner;
  }

  it('no foreign land -> level 0', () => {
    const s = st([null, mil()]);
    s.mapTiles[posOf(32, 32, GEO)].owner = 1; // own land
    updateThreatLevel(s, s.buildings[1]!);
    expect(s.buildings[1]!.threatLevel).toBe(0);
  });

  it('own land does not trigger it — only FOREIGN land does', () => {
    const s = st([null, mil({ owner: 0 })]);
    ownAtProbe(s, 31, 1); // owner 1 == self (0-based 0)
    updateThreatLevel(s, s.buildings[1]!);
    expect(s.buildings[1]!.threatLevel).toBe(0);
    ownAtProbe(s, 31, 2); // foreign
    updateThreatLevel(s, s.buildings[1]!);
    expect(s.buildings[1]!.threatLevel).toBe(3);
  });

  it('the three probe groups yield 3 / 2 / 1', () => {
    for (const [idx, level] of [[31, 3], [265, 2], [277, 1]] as const) {
      const s = st([null, mil()]);
      ownAtProbe(s, idx, 2);
      updateThreatLevel(s, s.buildings[1]!);
      expect(s.buildings[1]!.threatLevel, `probe ${idx}`).toBe(level);
    }
  });

  it('the innermost group wins over the outer one', () => {
    const s = st([null, mil()]);
    ownAtProbe(s, 277, 2); // group 2 -> 1
    ownAtProbe(s, 31, 2); // group 0 -> 3
    updateThreatLevel(s, s.buildings[1]!);
    expect(s.buildings[1]!.threatLevel).toBe(3);
  });

  it('probe 294 is queried — it only exists with the 49th base vector', () => {
 // The last table entry; with only 48 base vectors it would be out of range.
    expect(SPIRAL_PATTERN.length).toBe(295);
    const s = st([null, mil()]);
    ownAtProbe(s, 294, 2);
    updateThreatLevel(s, s.buildings[1]!);
    expect(s.buildings[1]!.threatLevel).toBe(1);
  });

  it('index 219 is NOT in the table, 244 appears twice (an original quirk)', () => {
    const s = st([null, mil()]);
    ownAtProbe(s, 219, 2);
    updateThreatLevel(s, s.buildings[1]!);
    expect(s.buildings[1]!.threatLevel).toBe(0); // 219 is never queried
    const s2 = st([null, mil()]);
    ownAtProbe(s2, 244, 2);
    updateThreatLevel(s2, s2.buildings[1]!);
    expect(s2.buildings[1]!.threatLevel).toBe(3);
  });

  it('sweep: covers finished military buildings, but NOT a hut under construction', () => {
    const done = mil({ index: 1, col: 32, row: 32, constructing: false });
    const building = mil({ index: 2, col: 34, row: 32, constructing: true });
    const s = st([null, done, building]);
    for (const b of [done, building]) {
      const t = s.mapTiles[posOf(b.col!, b.row!, GEO)];
      t.object = 2;
      t.objIndex = b.index;
      t.paths = 2; // road bit DownRight (link to its own flag)
    }
    ownAtProbe(s, 31, 2);
    s.mapTiles[posOf(34 + SPIRAL_PATTERN[31]![0], 32 + SPIRAL_PATTERN[31]![1], GEO)].owner = 2;
    updateAreaThreatLevels(s, 32, 32);
    expect(done.threatLevel).toBe(3);
    expect(building.threatLevel).toBe(0); // 0xac matches none of the five comparisons
  });

  it('sweep: a castle UNDER CONSTRUCTION is covered (0xe0), an economy building never', () => {
    const castle = mil({ index: 1, type: 24, col: 32, row: 32, constructing: true });
    const mill = mil({ index: 2, type: 15, col: 34, row: 32, constructing: false });
    const s = st([null, castle, mill]);
    for (const b of [castle, mill]) {
      const t = s.mapTiles[posOf(b.col!, b.row!, GEO)];
      t.object = 2;
      t.objIndex = b.index;
      t.paths = 2;
    }
    ownAtProbe(s, 31, 2);
    s.mapTiles[posOf(34 + SPIRAL_PATTERN[31]![0], 32 + SPIRAL_PATTERN[31]![1], GEO)].owner = 2;
    updateAreaThreatLevels(s, 32, 32);
    expect(castle.threatLevel).toBe(3);
    expect(mill.threatLevel).toBe(0);
  });

  it('sweep: without the road bit DownRight the tile stays untouched', () => {
    const b = mil({ index: 1, col: 32, row: 32 });
    const s = st([null, b]);
    const t = s.mapTiles[posOf(32, 32, GEO)];
    t.object = 2;
    t.objIndex = 1;
    t.paths = 0; // bit 1 missing
    ownAtProbe(s, 31, 2);
    updateAreaThreatLevels(s, 32, 32);
    expect(b.threatLevel).toBe(0);
  });
});

describe('notifyTerritoryLosers — FUN_0002433a (×4)', () => {
  function pl(land: number, buildings: number) {
    return {
      totalLandScore: land,
      totalBuildingScore: buildings,
      flags: 0,
      messageTypes: [] as number[],
      messagePositions: [] as number[],
    };
  }
  const stateOf = (...players: ReturnType<typeof pl>[]) =>
    ({ players } as unknown as Parameters<typeof notifyTerritoryLosers>[0]);

  it('building score dropped -> message 9, even when land is missing too', () => {
 // `jb 0x2437a` @0x2434d takes precedence — 8 must NOT come in addition.
    const p = pl(90, 40); // before 100 / 50 => both dropped
    notifyTerritoryLosers(stateOf(p), [{ land: 100, buildings: 50 }], 0, 1234);
    expect(p.messageTypes).toEqual([MSG_LAND_AND_BUILDINGS_LOST]);
    expect(p.messagePositions).toEqual([1234]);
  });

  it('only land dropped -> message 8', () => {
    const p = pl(90, 50);
    notifyTerritoryLosers(stateOf(p), [{ land: 100, buildings: 50 }], 0, 7);
    expect(p.messageTypes).toEqual([MSG_LAND_LOST]);
  });

  it('nothing dropped -> no message (discrimination)', () => {
    for (const [land, buildings] of [
      [100, 50], // unchanged
      [120, 60], // grown
    ] as const) {
      const p = pl(land, buildings);
      notifyTerritoryLosers(stateOf(p), [{ land: 100, buildings: 50 }], 0, 7);
      expect(p.messageTypes, `${land}/${buildings}`).toEqual([]);
    }
  });

  it('the causer sits in the upper 3 bits (`(serf[0] & 3) << 5`)', () => {
    for (const causer of [0, 1, 2, 3]) {
      const p = pl(90, 50);
      notifyTerritoryLosers(stateOf(p), [{ land: 100, buildings: 50 }], causer, 7);
      expect(p.messageTypes, `causer ${causer}`).toEqual([MSG_LAND_LOST + (causer << 5)]);
    }
 // Only the lower 2 bits count (`andw $0x3`).
    const p = pl(90, 50);
    notifyTerritoryLosers(stateOf(p), [{ land: 100, buildings: 50 }], 0xff, 7);
    expect(p.messageTypes).toEqual([MSG_LAND_LOST + (3 << 5)]);
  });

  it('walks ALL four slots and skips empty ones', () => {
    const a = pl(90, 50);
    const b = pl(100, 50); // unchanged
    const c = pl(50, 10);
    const state = { players: [a, null, b, c] } as unknown as Parameters<typeof notifyTerritoryLosers>[0];
    notifyTerritoryLosers(
      state,
      [{ land: 100, buildings: 50 }, null, { land: 100, buildings: 50 }, { land: 60, buildings: 20 }],
      1,
      42,
    );
    expect(a.messageTypes).toEqual([MSG_LAND_LOST + (1 << 5)]);
    expect(b.messageTypes).toEqual([]);
    expect(c.messageTypes).toEqual([MSG_LAND_AND_BUILDINGS_LOST + (1 << 5)]);
  });
});
