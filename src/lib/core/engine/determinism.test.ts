import { describe, it, expect } from 'vitest';
import type { SaveGameState, SaveGameHeader } from '../types.js';
import { loadState, snapshot } from './state.js';
import { FRAME_TICKS, runTicks } from './tick.js';

/**
 * Determinism contract of the tick engine (the basis for replay, multiplayer lockstep and AI
 * observation): fixed timestep + fixed entity and driver order + the random state as part of the
 * snapshot => the same start and tick count yields a bit-identical state, and snapshot/restore is
 * lossless.
 */
function makeSave(opts: {
  tick?: number;
  random?: [number, number, number];
  serfs?: { index: number; type: number; state: number; counter: number; col: number; row: number; stateData?: number[] }[];
}): SaveGameState {
  const gameTick = opts.tick ?? 1000;
  const serfList = opts.serfs ?? [
    { index: 1, type: 5, state: 3, counter: 100, col: 10, row: 20 },
    { index: 2, type: 5, state: 0, counter: 50, col: 11, row: 20 },
  ];
  const header: SaveGameHeader = {
    viewOptions: [0x39, 0x39],
    gameType: 0,
    tick: gameTick,
    random: opts.random ?? [1, 2, 3],
    rotation: 1,
    flagSearchCounter: 0,
    mapTick: 0,
    mapCounter: 0,
    mapCursorRaw: 0,
    mapDecayCountdown: 0,
    maxFlagIndex: 1,
    maxBuildingIndex: 1,
    maxSerfIndex: 16,
    maxInventoryIndex: 1,
    rotationWrap: 0,
    serfBudget: 100,
    warehouseLimit: 361,
    mapGoldTotal: 0,
    serviceBudget: 55,
    buildingServiceCursor: 0,
    flagServiceCursor: 0,
    playerHistoryIndex: [0, 0, 0, 0],
    playerHistoryCounter: [0, 0, 0],
    resourceHistoryIndex: 0,
    missionSetupIndex: 0,
    levelSetupIndex: 0,
    mapGoldMoraleFactor: 0,
    populationSpan: 1500,
    populationBase: 250,
    statTimer: 0,
    resourceTimer: 0,
    winnerIndex: -1,
    victoryMask: 0,
    missionEndPending: 0,
    mapSize: 3,
    mapCols: 64,
    mapRows: 64,
    tileCount: 4096,
  };
  const serfRecords = serfList.map((s) => ({
    index: s.index,
    type: s.type,
    state: s.state,
    counter: s.counter,
    tick: gameTick,
    animation: 20,
    col: s.col,
    row: s.row,
    owner: 0,
    stateData: s.stateData ?? [0, 0, 0, 0, 0],
  })) as unknown as SaveGameState['serfRecords'];
  // `height` must be > 0: height 0 means unwalkable in the original (water, map edge), and a map that
  // is 0 everywhere does not exist there. The random walk of the lost handler (state 25, @0x1bc7f)
  // draws until it hits a walkable tile, so on such a map it runs forever.
  const mapTiles = Array.from({ length: 4096 }, () => ({
    height: 8,
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
    playerRecords: [] as unknown as SaveGameState['playerRecords'],
    serfs: { recordSize: 16, maxIndex: 16, occupied: serfList.map((s) => s.index) },
    flags: { recordSize: 70, maxIndex: 1, occupied: [] },
    buildings: { recordSize: 18, maxIndex: 1, occupied: [] },
    inventories: { recordSize: 120, maxIndex: 1, occupied: [] },
    buildingRecords: [] as unknown as SaveGameState['buildingRecords'],
    serfRecords,
    flagRecords: [] as unknown as SaveGameState['flagRecords'],
    inventoryRecords: [] as unknown as SaveGameState['inventoryRecords'],
    mapTiles,
    byteLength: 0,
  };
}

describe('Determinismus — RNG im Snapshot', () => {
  it('snapshot() captures and loadState() restores the random state losslessly', () => {
    const s = loadState(makeSave({}));
    s.rng.next();
    s.rng.next();
    s.rng.next();
    const expected = s.rng.getState();

    const snap = snapshot(s);
    expect(snap.header.random).toEqual(expected); // the snapshot carries the random state

    const restored = loadState(snap);
    expect(restored.rng.getState()).toEqual(expected); // Restore stellt ihn her
  });
});

describe('Determinismus — Reproduzierbarkeit', () => {
  it('gleicher Start + gleiche Tick-Zahl → bit-identischer Snapshot', () => {
    const save = makeSave({});
    const a = loadState(save);
    const b = loadState(save);
    runTicks(a, 300);
    runTicks(b, 300);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('a random-consuming handler (geologist 42) is reproducible and does consume randomness', () => {
    // A geologist (type 20) in state 42 (LookingForGeoSpot) draws during the spiral search.
    const mk = () =>
      makeSave({ serfs: [{ index: 1, type: 20, state: 42, counter: 0, col: 20, row: 20 }] });
    const a = loadState(mk());
    const b = loadState(mk());
    // A whole frame: the serf driver runs on the frame boundary, so fewer ticks draw nothing at all.
    runTicks(a, FRAME_TICKS);
    runTicks(b, FRAME_TICKS);
    expect(a.rng.getState()).toEqual(b.rng.getState()); // deterministisch
    expect(a.rng.getState()).not.toEqual([1, 2, 3]); // randomness really was drawn
    expect(snapshot(a)).toEqual(snapshot(b));
  });
});

describe('Determinismus — Snapshot→Restore verlustfrei (Multiplayer-/Replay-Vertrag)', () => {
  it('Snapshot mitten im Lauf, wiederherstellen, weiterrechnen == ununterbrochen', () => {
    const save = makeSave({ serfs: [{ index: 1, type: 20, state: 42, counter: 0, col: 20, row: 20 }] });
    // Ununterbrochen 40 Ticks.
    const straight = loadState(save);
    runTicks(straight, 40);

    // Unterbrochen: 15 Ticks → Snapshot → Restore → 25 Ticks.
    const first = loadState(save);
    runTicks(first, 15);
    const mid = snapshot(first);
    const resumed = loadState(mid);
    runTicks(resumed, 25);

    expect(snapshot(resumed)).toEqual(snapshot(straight));
  });
});
