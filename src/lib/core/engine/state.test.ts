import { describe, it, expect } from 'vitest';
import type { SaveGameState, SaveGameHeader } from '../types.js';
import { loadState, snapshot, setSerfType } from './state.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Compact synthetic SaveGameState fixture. */
function makeSave(): SaveGameState {
  const header: SaveGameHeader = {
    viewOptions: [0x39, 0x39],
    gameType: 0,
    tick: 12345,
    random: [0x0380, 0xeea7, 0x6b11],
    rotation: 1,
    flagSearchCounter: 0,
    mapTick: 0,
    mapCounter: 0,
    mapCursorRaw: 0,
    mapDecayCountdown: 0,
    maxFlagIndex: 4,
    maxBuildingIndex: 4,
    maxSerfIndex: 8,
    maxInventoryIndex: 2,
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
    sessionFlags: 0x08,
    messageMarks: 0,
    mapSize: 3,
    mapCols: 64,
    mapRows: 64,
    tileCount: 4096,
    frameAccum: 0,
  };
  const serfRecords = [
    { index: 3, type: 5, counter: 100, tick: 12345, animation: 20, state: 3, col: 10, row: 20 },
    { index: 7, type: 0, counter: 0, tick: 12340, animation: 0, state: 66, col: null, row: null },
  ] as unknown as SaveGameState['serfRecords'];
  const flagRecords = [{ index: 2, owner: 0 }] as unknown as SaveGameState['flagRecords'];
  const buildingRecords = [
    { index: 1, type: 24, owner: 0, col: 25, row: 46 },
  ] as unknown as SaveGameState['buildingRecords'];
  const inventoryRecords = [{ index: 1, owner: 0 }] as unknown as SaveGameState['inventoryRecords'];
  const mapTiles = Array.from({ length: 4096 }, (_v, i) => ({
    height: 0,
    terrainUp: 8,
    terrainDown: 8,
    object: 0,
    owner: 0,
    paths: 0,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: i === 20 * 64 + 10 ? 3 : 0,
  })) as unknown as SaveGameState['mapTiles'];
  const playerRecords = [
    { slot: 0, index: 0, active: true },
    { slot: 1, index: 1, active: true },
    { slot: 2, index: 2, active: false },
    { slot: 3, index: 3, active: false },
  ] as unknown as SaveGameState['playerRecords'];

  return {
    header,
    activePlayers: [0, 1],
    playerRecords,
    serfs: { recordSize: 16, maxIndex: 8, occupied: [3, 7] },
    flags: { recordSize: 70, maxIndex: 4, occupied: [2] },
    buildings: { recordSize: 18, maxIndex: 4, occupied: [1] },
    inventories: { recordSize: 120, maxIndex: 2, occupied: [1] },
    buildingRecords,
    serfRecords,
    flagRecords,
    inventoryRecords,
    mapTiles,
    byteLength: 87128,
  };
}

describe('state — loadState / snapshot', () => {
  it('packs records by .index, not by array position', () => {
    const state = loadState(makeSave());
    expect(state.serfs[3]?.index).toBe(3);
    expect(state.serfs[7]?.index).toBe(7);
    expect(state.serfs[1]).toBeNull();
    expect(state.serfs[0]).toBeNull();
    expect(state.buildings[1]?.type).toBe(24);
  });

  it('takes gameTick and the random seed from the header', () => {
    const state = loadState(makeSave());
    expect(state.gameTick).toBe(12345);
    expect(state.rng.getState()).toEqual([0x0380, 0xeea7, 0x6b11]);
  });

  it('derives the map geometry correctly', () => {
    const state = loadState(makeSave());
    expect(state.geo.cols).toBe(64);
    expect(state.geo.rowShift).toBe(6);
    expect(state.mapTiles.length).toBe(4096);
  });

  it('round trip: snapshot(loadState(save)) is structurally equal to save', () => {
    const save = makeSave();
    expect(snapshot(loadState(save))).toEqual(save);
  });

  it('isoliert Mutationen vom Eingabe-Save (structuredClone)', () => {
    const save = makeSave();
    const state = loadState(save);
    state.serfs[3]!.counter = 999;
    state.gameTick = 99999;
    // the original is unchanged:
    expect(save.serfRecords[0].counter).toBe(100);
    expect(save.header.tick).toBe(12345);
  });
});

/**
 * `typeName` must not go stale: it is a pure derivation of `type`, so a writer that sets only `type`
 * leaves a wrong label in the bug report and in the save game viewer. Nothing else notices - the game
 * state stays correct.
 *
 * The scan is deliberately simple: an assignment to `<anything>.type` in `engine/` is only allowed
 * when the base is demonstrably NOT a serf; everything else must go through {@link setSerfType}.
 */
describe('setSerfType: the display name stays with the type', () => {
  it('sets type AND typeName', () => {
    const serf = { type: 21, typeName: 'Generic' } as { type: number; typeName: string };
    setSerfType(serf as never, 1);
    expect(serf.type).toBe(1);
    expect(serf.typeName).toBe('Sailor');
  });

  it('an unknown type stays recognisable instead of undefined', () => {
    const serf = { type: 0, typeName: 'Transporter' } as { type: number; typeName: string };
    setSerfType(serf as never, 99);
    expect(serf.typeName).toBe('Unknown(99)');
  });

  it('no engine module writes a serf type without setSerfType', () => {
    // Bases that demonstrably are not a serf (building record, an inventory's out queue).
    const NOT_A_SERF = /^(bld|building|b|inv\.outQueue\[[^\]]+\]|outQueue\[[^\]]+\]|slot)$/;
    const dir = dirname(fileURLToPath(import.meta.url));
    const hits: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      // `state.ts` is the ONE allowed place: the helper itself lives there. A file is exempted with
      // a reason rather than the rule being softened.
      if (name === 'state.ts') continue;
      const lines = readFileSync(join(dir, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments (including this rule's own docs)
        for (const m of line.matchAll(/([A-Za-z_$][\w$.[\]]*)\.type\s*=[^=]/g)) {
          if (NOT_A_SERF.test(m[1]!)) continue;
          hits.push(`${name}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
