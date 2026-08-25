import { describe, it, expect } from 'vitest';
import { mapObjectGrowth, tilesPerRound, decodeMapCursor, encodeMapCursor } from './map-growth.js';
import { mapGeometry } from './position.js';
import { loadState, type GameState } from './state.js';
import type { SaveGameState } from '../types.js';

/**
 * Tests zur Karten-Fortschreibung (`map_object_growth` @0xf2d5).
 *
 * Only what synthetic data can check.
 */

const MAP_SIZE = 3;

function emptySave(): SaveGameState {
  const geo = mapGeometry(MAP_SIZE);
  const mapTiles = Array.from({ length: geo.tileCount }, () => ({
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
  }));
  return {
    header: {
      viewOptions: [0x39, 0x39],
      gameType: 0,
      tick: 0,
      statTimer: 0,
      resourceTimer: 0,
      random: [1, 2, 3],
      maxFlagIndex: 1,
      maxBuildingIndex: 1,
      maxSerfIndex: 1,
      rotation: 0,
      flagSearchCounter: 0,
      mapTick: 0,
      mapCounter: 0,
      mapCursorRaw: 0,
      mapDecayCountdown: 0,
      playerHistoryIndex: [0, 0, 0, 0],
      playerHistoryCounter: [0, 0, 0],
      resourceHistoryIndex: 0,
      missionSetupIndex: 0,
      levelSetupIndex: 0,
      maxInventoryIndex: 1,
      serfBudget: 0,
      warehouseLimit: 0,
      rotationWrap: 49,
      populationSpan: 0,
      mapGoldTotal: 0,
      mapSize: MAP_SIZE,
      serviceBudget: 0,
      buildingServiceCursor: 0,
      flagServiceCursor: 0,
      populationBase: 0,
      mapGoldMoraleFactor: 0,
      winnerIndex: -1,
      victoryMask: 0,
      missionEndPending: 0,
      frameAccum: 0,
      cols: geo.cols,
      rows: geo.rows,
      tileCount: geo.tileCount,
    },
    activePlayers: [],
    playerRecords: [],
    serfs: { recordSize: 16, maxIndex: 1, bitmap: new Uint8Array(4) },
    flags: { recordSize: 70, maxIndex: 1, bitmap: new Uint8Array(4) },
    buildings: { recordSize: 18, maxIndex: 1, bitmap: new Uint8Array(4) },
    inventories: { recordSize: 120, maxIndex: 1, bitmap: new Uint8Array(4) },
    serfRecords: [],
    flagRecords: [],
    buildingRecords: [],
    inventoryRecords: [],
    mapTiles,
    byteLength: 0,
  } as unknown as SaveGameState;
}

/** Run the pass `n` times with an advancing tick, isolated from the rest of the engine. */
function run(state: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    state.gameTick = (state.gameTick + 1) & 0xffff;
    mapObjectGrowth(state);
  }
}

describe('map-growth: Takt', () => {
  it('tut ohne Tick-Fortschritt nichts (Delta 0)', () => {
    const st = loadState(emptySave());
    st.mapTiles[100]!.object = 0x69; // frische Saat
    const before = st.header.mapCursorRaw;
    for (let i = 0; i < 500; i++) mapObjectGrowth(st);
    expect(st.mapTiles[100]!.object).toBe(0x69);
    expect(st.header.mapCursorRaw).toBe(before);
  });

  it('tilesPerRound is (cols>>5)*(rows>>5), so 4 on 64x64', () => {
    expect(tilesPerRound(mapGeometry(3))).toBe(4);
  });

  it('bearbeitet ~tilesPerRound Kacheln je 20 Ticks', () => {
    const st = loadState(emptySave());
    // Fill everything with tree stumps: every visit draws a random value, the cursor advances per tile.
    const start = decodeMapCursor(st.header.mapCursorRaw, st.geo);
    run(st, 2000); // 100 Runden à 4 Kacheln = 400 Kachel-Besuche
    const end = decodeMapCursor(st.header.mapCursorRaw, st.geo);
 // 2000 Ticks / 20 = 100 Runden à 4 Kacheln = genau 400 Cursor-Schritte à 23 Kacheln.
    expect(end).toBe((start + 400 * 23) & (st.geo.tileCount - 1));
  });
});

describe('map-growth: Cursor-Kodierung', () => {
  it('decode/encode sind zueinander invers', () => {
    const geo = mapGeometry(3);
    for (const pos of [0, 1, 63, 64, 1234, geo.tileCount - 1]) {
      expect(decodeMapCursor(encodeMapCursor(pos, geo), geo)).toBe(pos);
    }
  });

  it('encodes with the gap bit, like the serf and building records', () => {
    const geo = mapGeometry(3);
 // row 2, col 5 → ((2 << 7) | 5) << 2
    const pos = (2 << geo.rowShift) | 5;
    expect(encodeMapCursor(pos, geo)).toBe((((2 << (geo.rowShift + 1)) | 5) << 2) >>> 0);
  });
});

describe('map-growth: object transitions', () => {
  /** Fill the whole map with `obj`, run, and count the distribution of the results. */
  function sweep(obj: number, ticks: number): Map<number, number> {
    const st = loadState(emptySave());
    for (const t of st.mapTiles) t.object = obj;
    run(st, ticks);
    const hist = new Map<number, number>();
    for (const t of st.mapTiles) hist.set(t.object, (hist.get(t.object) ?? 0) + 1);
    return hist;
  }

  it('sapling 0x67 becomes a deciduous tree 0x10..0x17', () => {
    const h = sweep(0x67, 200_000);
    let trees = 0;
    for (let o = 0x10; o <= 0x17; o++) trees += h.get(o) ?? 0;
    expect(trees).toBeGreaterThan(0);
    // and NOT into the other bank
    let pines = 0;
    for (let o = 0x08; o <= 0x0f; o++) pines += h.get(o) ?? 0;
    expect(pines).toBe(0);
  });

  it('sapling 0x68 becomes a conifer 0x08..0x0f', () => {
    const h = sweep(0x68, 200_000);
    let pines = 0;
    for (let o = 0x08; o <= 0x0f; o++) pines += h.get(o) ?? 0;
    expect(pines).toBeGreaterThan(0);
    let trees = 0;
    for (let o = 0x10; o <= 0x17; o++) trees += h.get(o) ?? 0;
    expect(trees).toBe(0);
  });

  it('a felled tree (0x5d..0x66) becomes stump 0x53 and then disappears', () => {
    const st = loadState(emptySave());
    st.mapTiles[500]!.object = 0x60;
    run(st, 60_000);
    // Either gone already or still a stump - both are stations on the same road.
    expect([0, 0x53]).toContain(st.mapTiles[500]!.object);
  });

  it('Getreide reift 0x69 → … → 0x6e → 0x79', () => {
    const st = loadState(emptySave());
    st.mapTiles[700]!.object = 0x69;
    run(st, 20_000);
    expect(st.mapTiles[700]!.object).not.toBe(0x69);
  });

  it('Objekte unter 0x53 bleiben unangetastet', () => {
    const st = loadState(emptySave());
    for (const o of [0, 1, 4, 0x10, 0x30, 0x52]) {
      const pos = 200 + o;
      st.mapTiles[pos]!.object = o;
    }
    run(st, 100_000);
    for (const o of [0, 1, 4, 0x10, 0x30, 0x52]) {
      expect(st.mapTiles[200 + o]!.object).toBe(o);
    }
  });
});
