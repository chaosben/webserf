import { describe, it, expect } from 'vitest';
import type { SaveGameState, SaveGameHeader } from '../types.js';
import { loadState, snapshot } from './state.js';
import type { GameState } from './state.js';
import { tick, runTicks, updateSerfs, advanceFrameClock } from './tick.js';

function makeSave(overrides?: {
  tick?: number;
  serfs?: { index: number; state: number; counter: number; tick: number }[];
}): SaveGameState {
  const gameTick = overrides?.tick ?? 1000;
  const serfList = overrides?.serfs ?? [
    { index: 1, state: 3, counter: 100, tick: gameTick },
    { index: 2, state: 0, counter: 50, tick: gameTick },
  ];
  const header: SaveGameHeader = {
    viewOptions: [0x39, 0x39],
    gameType: 0,
    tick: gameTick,
    random: [1, 2, 3],
    rotation: 1,
    flagSearchCounter: 0,
    mapTick: 0,
    mapCounter: 0,
    mapCursorRaw: 0,
    mapDecayCountdown: 0,
    maxFlagIndex: 1,
    maxBuildingIndex: 1,
    maxSerfIndex: 8,
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
    ...s,
    type: 5,
    animation: 20,
    col: 10,
    row: 20,
    stateData: [0, 0, 0, 0, 0],
  })) as unknown as SaveGameState['serfRecords'];
  // `height` > 0 means walkable. Height 0 is water or map edge in the original; a map that is
  // unwalkable throughout does not exist there, and the random walk of the lost handler (@0x1bc7f)
  // would draw forever. See the same note in `determinism.test.ts`.
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
    serfs: { recordSize: 16, maxIndex: 8, occupied: serfList.map((s) => s.index) },
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

describe('tick — logic tick', () => {
  it('advances the game tick by 1 (u16 wrap)', () => {
    const state = loadState(makeSave({ tick: 1000 }));
    tick(state);
    expect(state.gameTick).toBe(1001);
    state.gameTick = 0xffff;
    tick(state);
    expect(state.gameTick).toBe(0);
  });

  it('applies the tick prologue to active serfs (counter -= delta)', () => {
    const state = loadState(makeSave({ tick: 1000 }));
    tick(state); // gameTick 1001, delta 1
    expect(state.serfs[1]!.counter).toBe(99);
    expect(state.serfs[1]!.tick).toBe(1001);
  });

  it('leaves serfs in state 0 untouched', () => {
    const state = loadState(makeSave({ tick: 1000 }));
    tick(state);
    expect(state.serfs[2]!.counter).toBe(50); // unchanged
    expect(state.serfs[2]!.tick).toBe(1000);
  });

  it('the counter wraps on underflow (u16, fallback path)', () => {
    // Every entry of the original jump table (0..75) is ported, so the `animateOnly` fallback is only
    // reached by a state byte OUTSIDE the table. It must not stumble there, it just carries the
    // counter on (underflow -> u16 wrap).
    const state = loadState(makeSave({ tick: 1000, serfs: [{ index: 1, state: 90, counter: 0, tick: 1000 }] }));
    tick(state);
    expect(state.serfs[1]!.counter).toBe(0xffff);
  });

  it('updateSerfs consumes the accumulated delta across several ticks', () => {
    const state = loadState(makeSave({ tick: 1000 }));
    runTicks(state, 10);
    expect(state.gameTick).toBe(1010);
    expect(state.serfs[1]!.counter).toBe(90); // 100 - 10
  });

  it('is deterministic: same start and tick count -> identical snapshot', () => {
    const save = makeSave({ tick: 1000 });
    const a = loadState(save);
    const b = loadState(save);
    runTicks(a, 250);
    runTicks(b, 250);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('updateSerfs can be called directly (without running a tick first)', () => {
    const state = loadState(makeSave({ tick: 1000 }));
    state.gameTick = 1005;
    updateSerfs(state);
    expect(state.serfs[1]!.counter).toBe(95); // 100 - 5
  });
});

describe('advanceFrameClock — the central frame clock', () => {
  const mk = (over: Partial<{ frameAccum: number; rotation: number; rotationWrap: number }> = {}) =>
    ({ frameAccum: over.frameAccum ?? 0, rotation: over.rotation ?? 0, rotationWrap: over.rotationWrap ?? 49 } as GameState);

  it('yields a frame boundary every 8 ticks and then advances the rotation by 1', () => {
    const s = mk({ frameAccum: 0, rotation: 5 });
    const boundaries: boolean[] = [];
    for (let i = 0; i < 8; i++) boundaries.push(advanceFrameClock(s));
    // 7 times false, the 8th call is the frame boundary.
    expect(boundaries).toEqual([false, false, false, false, false, false, false, true]);
    expect(s.frameAccum).toBe(0); // reset at the boundary
    expect(s.rotation).toBe(6); // advanced exactly once
  });

  it('wraps the rotation at rotationWrap', () => {
    const s = mk({ frameAccum: 7, rotation: 48, rotationWrap: 49 });
    expect(advanceFrameClock(s)).toBe(true);
    expect(s.rotation).toBe(0); // (48+1) % 49
  });

  it('uses the fallback wrap 49 when rotationWrap == 0', () => {
    const s = mk({ frameAccum: 7, rotation: 48, rotationWrap: 0 });
    advanceFrameClock(s);
    expect(s.rotation).toBe(0);
  });
});
