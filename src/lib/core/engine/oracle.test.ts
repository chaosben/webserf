import { describe, it, expect } from 'vitest';
import { diffStates, formatReport } from './oracle.js';
import type {
  SaveGameState,
  SerfRecord,
  FlagRecord,
  BuildingRecord,
  InventoryRecord,
} from '../types.js';

// --- Minimal synthetic fixtures ---

function serf(index: number, over: Partial<SerfRecord> = {}): SerfRecord {
  return {
    index,
    owner: 0,
    type: 0,
    typeName: 'Transporter',
    sound: false,
    animation: 1,
    counter: 100,
    col: 5,
    row: 6,
    tick: 42,
    state: 3,
    stateName: 'Transporting',
    stateData: [0, 0, 0, 0, 0],
    ...over,
  };
}

function flag(index: number, over: Partial<FlagRecord> = {}): FlagRecord {
  return {
    index,
    owner: 0,
    hasBuilding: false,
    hasResources: false,
    endpointDirs: [false, false, false, false, false, false],
    paths: [false, false, false, false, false, false],
    connections: [null, null, null, null, null, null],
    resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
    searchNum: 0,
    searchDir: 0,
    transporters: [false, false, false, false, false, false],
    serfRequestFail: false,
    length: [0, 0, 0, 0, 0, 0],
    slotDir: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
    otherEndDir: [0, 0, 0, 0, 0, 0],
    scheduled: [false, false, false, false, false, false],
    scheduledSlot: [0, 0, 0, 0, 0, 0],
    acceptsSerfs: false,
    acceptsResources: false,
    bldFlags: 0,
    bld2Flags: 0,
    stockPriority: [0, 0],
    ...over,
  };
}

function emptyState(over: Partial<SaveGameState> = {}): SaveGameState {
  const block = { recordSize: 0, maxIndex: 0, occupied: [] as number[] };
  return {
    header: {
      viewOptions: [0x39, 0x39],
      gameType: 0,
      tick: 1000,
      random: [0, 0, 0],
      maxFlagIndex: 0,
      maxBuildingIndex: 0,
      maxSerfIndex: 0,
      rotation: 0,
      flagSearchCounter: 0,
      mapTick: 0,
      mapCounter: 0,
      mapCursorRaw: 0,
      mapDecayCountdown: 0,
      maxInventoryIndex: 0,
      rotationWrap: 0,
      serfBudget: 0,
      warehouseLimit: 361,
      mapGoldTotal: 0,
      serviceBudget: 55,
      buildingServiceCursor: 0,
      flagServiceCursor: 0,
      mapSize: 3,
      mapCols: 64,
      mapRows: 64,
      tileCount: 4096,
      mapGoldMoraleFactor: 0,
      populationSpan: 1500,
    populationBase: 250,
    statTimer: 0,
    resourceTimer: 0,
    winnerIndex: -1,
    victoryMask: 0,
    missionEndPending: 0,
      playerHistoryIndex: [0, 0, 0, 0],
      playerHistoryCounter: [0, 0, 0],
      resourceHistoryIndex: 0,
      missionSetupIndex: 0,
      levelSetupIndex: 0,
    } as SaveGameState['header'],
    activePlayers: [0, 1],
    playerRecords: [],
    serfs: block,
    flags: block,
    buildings: block,
    inventories: block,
    buildingRecords: [],
    serfRecords: [],
    flagRecords: [],
    inventoryRecords: [],
    mapTiles: [],
    byteLength: 0,
    ...over,
  };
}

describe('oracle diffStates', () => {
  it('reports a full match for identical states', () => {
    const a = emptyState({ serfRecords: [serf(1), serf(2)] });
    const b = emptyState({ serfRecords: [serf(1), serf(2)] });
    const r = diffStates(a, b);
    expect(r.serfs.matched).toBe(2);
    expect(r.serfs.mismatched).toBe(0);
    expect(r.serfs.total).toBe(2);
    expect(r.serfs.samples).toHaveLength(0);
  });

  it('locates a differing field on the right entity', () => {
    const a = emptyState({ serfRecords: [serf(1), serf(2, { counter: 100 })] });
    const b = emptyState({ serfRecords: [serf(1), serf(2, { counter: 55 })] });
    const r = diffStates(a, b);
    expect(r.serfs.matched).toBe(1);
    expect(r.serfs.mismatched).toBe(1);
    expect(r.serfs.samples).toHaveLength(1);
    expect(r.serfs.samples[0].index).toBe(2);
    expect(r.serfs.samples[0].diffs).toEqual([{ field: 'counter', a: 100, b: 55 }]);
  });

  it('compares the 5 union bytes element by element', () => {
    const a = emptyState({ serfRecords: [serf(1, { stateData: [1, 2, 3, 4, 5] })] });
    const b = emptyState({ serfRecords: [serf(1, { stateData: [1, 9, 3, 4, 5] })] });
    const r = diffStates(a, b);
    expect(r.serfs.samples[0].diffs).toEqual([{ field: 'stateData[1]', a: 2, b: 9 }]);
  });

  it('ignores the tick stamp and the transient search fields', () => {
    const a = emptyState({
      serfRecords: [serf(1, { tick: 10 })],
      flagRecords: [flag(1, { searchNum: 111, searchDir: 3 })],
    });
    const b = emptyState({
      serfRecords: [serf(1, { tick: 999 })],
      flagRecords: [flag(1, { searchNum: 222, searchDir: 5 })],
    });
    const r = diffStates(a, b);
    expect(r.serfs.mismatched).toBe(0);
    expect(r.flags.mismatched).toBe(0);
  });

  it('counts A-only and B-only slots separately (entity created / vanished)', () => {
    const a = emptyState({ serfRecords: [serf(1), serf(2)] });
    const b = emptyState({ serfRecords: [serf(1), serf(3)] });
    const r = diffStates(a, b);
    expect(r.serfs.matched).toBe(1); // #1
    expect(r.serfs.onlyInA).toBe(1); // #2
    expect(r.serfs.onlyInB).toBe(1); // #3
    expect(r.serfs.total).toBe(3);
  });

  it('caps the sample list at sampleLimit', () => {
    const as: SerfRecord[] = [];
    const bs: SerfRecord[] = [];
    for (let i = 1; i <= 20; i++) {
      as.push(serf(i, { counter: 1 }));
      bs.push(serf(i, { counter: 2 }));
    }
    const r = diffStates(emptyState({ serfRecords: as }), emptyState({ serfRecords: bs }), { sampleLimit: 3 });
    expect(r.serfs.mismatched).toBe(20);
    expect(r.serfs.samples).toHaveLength(3);
    expect(r.serfs.samples.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it('compares flag goods, building progress and inventory stocks', () => {
    const bld: BuildingRecord = {
      index: 1,
      col: 1,
      row: 1,
      type: 11,
      typeName: 'Hut',
      owner: 0,
      constructing: true,
      progress: 0x4000,
      flag: 2,
      firstKnight: 0,
      active: false,
      burning: false,
      holder: false,
      serfRequested: false,
      threatLevel: 0,
      serfRequestFailed: false,
      playingSfx: false,
      stock: [
        { available: 1, requested: 0 },
        { available: 0, requested: 0 },
      ],
      hasInventory: false,
      inventoryIndex: null,
      level: 0,
      stockMaximum: [3, 0],
    };
    const inv: InventoryRecord = {
      index: 1,
      owner: 0,
      resDir: 0,
      resMode: 0,
      serfMode: 0,
      flag: 2,
      building: 1,
      resources: new Array(26).fill(0),
      outQueue: [
        { type: -1, dest: 0 },
        { type: -1, dest: 0 },
      ],
      genericCount: 10,
      serfIndices: new Array(27).fill(0),
    };
    const a = emptyState({
      flagRecords: [flag(1, { resourceSlots: [4, -1, -1, -1, -1, -1, -1, -1], hasResources: true })],
      buildingRecords: [bld],
      inventoryRecords: [inv],
    });
    const b = emptyState({
      flagRecords: [flag(1, { resourceSlots: [7, -1, -1, -1, -1, -1, -1, -1], hasResources: true })],
      buildingRecords: [{ ...bld, progress: 0x8000 }],
      inventoryRecords: [{ ...inv, resources: [...inv.resources.slice(0, 4), 2, ...inv.resources.slice(5)] }],
    });
    const r = diffStates(a, b);
    expect(r.flags.samples[0].diffs).toEqual([{ field: 'resourceSlots[0]', a: 4, b: 7 }]);
    expect(r.buildings.samples[0].diffs).toEqual([{ field: 'progress', a: 0x4000, b: 0x8000 }]);
    expect(r.inventories.samples[0].diffs).toEqual([{ field: 'resources[4]', a: 0, b: 2 }]);
  });

  it('formatReport erzeugt lesbare Zusammenfassung ohne zu werfen', () => {
    const a = emptyState({ serfRecords: [serf(1), serf(2, { counter: 100 })] });
    const b = emptyState({ serfRecords: [serf(1), serf(2, { counter: 55 })] });
    const text = formatReport(diffStates(a, b));
    expect(text).toContain('Serfs');
    expect(text).toContain('#2');
    expect(text).toContain('counter');
  });
});
