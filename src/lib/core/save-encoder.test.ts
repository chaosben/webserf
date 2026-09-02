import { describe, it, expect } from 'vitest';
import type { SaveGameHeader, SaveGameState } from './types.js';
import { encodeSaveGame } from './save-encoder.js';

/**
 * The map-geometry block of the header (offsets 0..65 and 206..209) as **golden vectors**.
 *
 * It is deliberately not a second copy of the formula: the numbers below are what the original
 * itself put into a save of that size. A test that recomputes the expression would only check its
 * own copy of it. Two geometries, because a single one is fittable — a wrong shift width would still
 * match `64x64` and break on `512x256`.
 */
const GOLDEN: readonly {
  readonly label: string;
  readonly mapSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly u32: readonly (readonly [number, number])[];
  readonly u16: readonly (readonly [number, number])[];
}[] = [
  {
    label: '64x64',
    mapSize: 3,
    cols: 64,
    rows: 64,
    u32: [
      [0, 0x7efc],
      [4, 0x4],
      [8, 0x204],
      [12, 0x200],
      [18, 0x7efc],
      [22, 0x7e00],
      [26, 0x7e04],
      [30, 0x2fc],
      [34, 0x200],
      [38, 0x1000],
      [48, 0x100],
      [54, 0x7e00],
      [206, 0xfc],
    ],
    u16: [
      [16, 0xfc],
      [42, 0x7],
      [44, 0x3f],
      [46, 0x3f],
      [52, 0xfc],
      [58, 0x20],
      [60, 0x20],
      [62, 0x40],
      [64, 0x40],
    ],
  },
  {
    label: '512x256',
    mapSize: 8,
    cols: 512,
    rows: 256,
    u32: [
      [0, 0xff7fc],
      [4, 0x4],
      [8, 0x1004],
      [12, 0x1000],
      [18, 0xff7fc],
      [22, 0xff000],
      [26, 0xff004],
      [30, 0x17fc],
      [34, 0x1000],
      [38, 0x20000],
      [48, 0x800],
      [54, 0xff000],
      [206, 0x7fc],
    ],
    u16: [
      [16, 0x7fc],
      [42, 0xa],
      [44, 0x1ff],
      [46, 0xff],
      [52, 0x7fc],
      [58, 0x100],
      [60, 0x80],
      [62, 0x200],
      [64, 0x100],
    ],
  },
];

function makeState(mapSize: number, cols: number, rows: number): SaveGameState {
  const header = {
    viewOptions: [0x39, 0x39],
    gameType: 0,
    tick: 0,
    random: [0, 0, 0],
    rotation: 0,
    flagSearchCounter: 0,
    mapTick: 0,
    mapCounter: 0,
    mapCursorRaw: 0,
    mapDecayCountdown: 0,
    maxFlagIndex: 0,
    maxBuildingIndex: 0,
    maxSerfIndex: 0,
    maxInventoryIndex: 0,
    rotationWrap: 49,
    serfBudget: 0,
    warehouseLimit: 361,
    mapGoldTotal: 0,
    serviceBudget: 0,
    buildingServiceCursor: 0,
    flagServiceCursor: 0,
    playerHistoryIndex: [0, 0, 0, 0],
    playerHistoryCounter: [0, 0, 0],
    resourceHistoryIndex: 0,
    missionSetupIndex: 0,
    levelSetupIndex: 0,
    mapGoldMoraleFactor: 0,
    populationSpan: 0,
    populationBase: 0,
    statTimer: 0,
    resourceTimer: 0,
    winnerIndex: -1,
    victoryMask: 0,
    missionEndPending: 0,
    sessionFlags: 0x0a,
    messageMarks: 0x01,
    mapSize,
    mapCols: cols,
    mapRows: rows,
    tileCount: cols * rows,
  } as SaveGameHeader;
  const mapTiles = Array.from({ length: cols * rows }, () => ({
    height: 0,
    terrainUp: 8,
    terrainDown: 8,
    object: 0,
    owner: 0,
    paths: 0,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: 0,
  })) as unknown as SaveGameState['mapTiles'];
  return {
    header,
    activePlayers: [],
    // No player records: the encoder writes a block per record, and the four empty blocks stay zero
    // as they do in the original for an unused slot. This test is about the header.
    playerRecords: [],
    serfs: { recordSize: 16, maxIndex: 0, occupied: [] },
    flags: { recordSize: 70, maxIndex: 0, occupied: [] },
    buildings: { recordSize: 18, maxIndex: 0, occupied: [] },
    inventories: { recordSize: 120, maxIndex: 0, occupied: [] },
    buildingRecords: [],
    serfRecords: [],
    flagRecords: [],
    inventoryRecords: [],
    mapTiles,
    byteLength: 0,
  } as unknown as SaveGameState;
}

describe('save-encoder — map geometry of the header', () => {
  for (const g of GOLDEN) {
    it(`writes the geometry the original wrote for ${g.label}`, () => {
      const bytes = encodeSaveGame(makeState(g.mapSize, g.cols, g.rows));
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const [off, want] of g.u32) {
        expect(dv.getUint32(off, true), `@${off} (u32)`).toBe(want);
      }
      for (const [off, want] of g.u16) {
        expect(dv.getUint16(off, true), `@${off} (u16)`).toBe(want);
      }
    });
  }

  /**
   * The two sizes above are not just two data points: the whole block is a function of `cols`/`rows`
   * alone, so a wrong shift width or mask cannot match both. This states the dependency directly —
   * without it the golden vectors could in principle be satisfied by a lookup table per map size.
   */
  it('depends on the geometry, not on the map size class', () => {
    const a = encodeSaveGame(makeState(3, 64, 64)).subarray(0, 66);
    // Same size class, different column count: everything derived from `cols` has to move.
    const b = encodeSaveGame(makeState(3, 128, 64)).subarray(0, 66);
    let differing = 0;
    for (let i = 0; i < 66; i++) if (a[i] !== b[i]) differing++;
    expect(differing).toBeGreaterThan(10);
  });

  it('carries the two flag bytes at 66/67', () => {
    const bytes = encodeSaveGame(makeState(3, 64, 64));
    expect(bytes[66]).toBe(0x0a);
    expect(bytes[67]).toBe(0x01);
  });
});
