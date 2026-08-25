import { describe, it, expect } from 'vitest';
import {
  RECALL_DELAY_TICKS,
  RECALL_SLOTS,
  advanceRecallQueue,
  decodeRecallPayload,
  emptyRecallQueue,
  pushRecall,
  recallClockRow,
  recallClockRowEighths,
  recallIsBuildingScreen,
  recallMenuIndex,
  recallQueueFull,
  scheduleBuildingRecall,
  scheduleMapRecall,
  scheduleMenuRecall,
} from './message-recall.js';
import { encodePackedPos, mapGeometry, posOf } from './position.js';
import { loadState, type GameState, type Player } from './state.js';
import { runTicks } from './tick.js';
import type { SaveGameState } from '../types.js';

/**
 * The recall feature (`@0x27947` writer, `@0x3363c` consumer) — what is testable synthetically.
 */

const MAP_SIZE = 3;
const GEO = mapGeometry(MAP_SIZE);

function player(slot: number): Player {
  return {
    slot,
    index: slot,
    active: true,
    flags: 1 << 6,
    build: 0,
    messageTypes: [],
    messagePositions: [],
    recallCount: 0,
    recallQueue: emptyRecallQueue(),
 // What the full tick engine touches in the round trip (recorder, hints, population):
    messageFlags: 0,
    messageBuildingSlots: [0, 0, 0],
    hintReturnDelay: 0,
    heldPlanks: 0,
    heldStone: 0,
    serfCount: new Array(27).fill(0),
    resourceCount: new Array(26).fill(0),
    resourceHistory: Array.from({ length: 26 }, () => new Array(120).fill(0)),
    statHistory: Array.from({ length: 16 }, () => new Array(112).fill(0)),
    completedBuildingCount: new Array(23).fill(0),
    incompleteBuildingCount: new Array(23).fill(0),
    knightOccupation: [0x10, 0x21, 0x32, 0x43],
    totalLandScore: 0,
    totalBuildingScore: 0,
    totalMilitaryScore: 0,
    castleCaptureBalance: 0,
  } as unknown as Player;
}

function save(): SaveGameState {
  const mapTiles = Array.from({ length: GEO.tileCount }, () => ({
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
      cols: GEO.cols,
      rows: GEO.rows,
      tileCount: GEO.tileCount,
    },
    activePlayers: [0],
    playerRecords: [player(0)],
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

describe('recall: the five clocks', () => {
  it('carries the times from the manual — 5/10/20/30/60 minutes at 100 Hz', () => {
    expect(RECALL_DELAY_TICKS).toEqual([30000, 60000, 120000, 180000, 360000]);
    expect(RECALL_DELAY_TICKS.map((t) => t / 6000)).toEqual([5, 10, 20, 30, 60]);
  });

  it('7-px rows: the four thresholds 7/14/21/28', () => {
    expect([0, 6].map(recallClockRow)).toEqual([0, 0]);
    expect([7, 13].map(recallClockRow)).toEqual([1, 1]);
    expect([14, 20].map(recallClockRow)).toEqual([2, 2]);
    expect([21, 27].map(recallClockRow)).toEqual([3, 3]);
    expect([28, 39].map(recallClockRow)).toEqual([4, 4]);
  });

  it('the 8-px rows of the building branch differ at dy 28..31 — an original inconsistency', () => {
 // Both computations sit on the same clock column but divide it differently.
    for (const dy of [28, 29, 30, 31]) {
      expect(recallClockRow(dy)).toBe(4);
      expect(recallClockRowEighths(dy)).toBe(3);
    }
 // Otherwise they agree closely enough that the deviation is exactly this band.
    const differing = Array.from({ length: 40 }, (_, dy) => dy).filter(
      (dy) => recallClockRow(dy) !== recallClockRowEighths(dy),
    );
    expect(differing).toEqual([7, 14, 15, 21, 22, 23, 28, 29, 30, 31]);
  });
});

describe('recall: the screen cascade', () => {
  it('maps the eight distribution screens onto 1..8', () => {
    expect([0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21].map(recallMenuIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([0x2d, 0x2e].map(recallMenuIndex)).toEqual([7, 8]);
  });

  it('rejects everything else', () => {
    for (const s of [0, 1, 0x1b, 0x22, 0x24, 0x25, 0x26, 0x2a, 0x2b, 0x2c, 0x2f, 0x34, 0x37]) {
      expect(recallMenuIndex(s), `screen 0x${s.toString(16)}`).toBeNull();
    }
  });

  it('knows the three building screens', () => {
    expect([0x26, 0x2b, 0x2c].map(recallIsBuildingScreen)).toEqual([true, true, true]);
    expect([0x27, 0x28, 0x29, 0x2a, 0x34].map(recallIsBuildingScreen)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('recall: the payload union', () => {
  it('an even position => type 5 with a map position', () => {
    const packed = encodePackedPos(37, 21, GEO);
    expect(decodeRecallPayload(packed, GEO)).toEqual({ type: 5, pos: posOf(37, 21, GEO) });
  });

  it('bit 0 set => type 19, the bit is cleared before decoding', () => {
    const packed = encodePackedPos(37, 21, GEO);
    expect(decodeRecallPayload(packed | 1, GEO)).toEqual({ type: 0x13, pos: posOf(37, 21, GEO) });
  });

  it('negative => type 16 with the menu index as a 3-bit parameter', () => {
    for (let menu = 1; menu <= 8; menu++) {
      const { type } = decodeRecallPayload(-menu, GEO);
      expect(type & 0x1f, `menu ${menu}`).toBe(16);
      expect(type >> 5, `menu ${menu}`).toBe(menu - 1);
    }
  });
});

describe('recall: the queue', () => {
  it('takes 64 entries and rejects the 65th', () => {
    const p = player(0);
    for (let i = 0; i < RECALL_SLOTS; i++) expect(pushRecall(p, 100, i * 4)).toBe(true);
    expect(recallQueueFull(p)).toBe(true);
    expect(pushRecall(p, 100, 0)).toBe(false);
    expect(p.recallCount).toBe(RECALL_SLOTS);
  });

  it('fires exactly when the remaining time drops below the frame delta', () => {
    const p = player(0);
    pushRecall(p, 16, encodePackedPos(3, 4, GEO));
    advanceRecallQueue(p, 8, GEO);
    expect(p.messageTypes).toEqual([]);
    expect(p.recallQueue[0]!.remaining).toBe(8);
    advanceRecallQueue(p, 8, GEO);
    expect(p.messageTypes).toEqual([]); // 8 - 8 = 0, no underflow yet
    advanceRecallQueue(p, 8, GEO);
    expect(p.messageTypes).toEqual([5]);
    expect(p.messagePositions).toEqual([posOf(3, 4, GEO)]);
    expect(p.recallCount).toBe(0);
  });

  it('moves the following entries up', () => {
    const p = player(0);
    pushRecall(p, 4, encodePackedPos(1, 1, GEO));
    pushRecall(p, 4000, encodePackedPos(2, 2, GEO));
    pushRecall(p, 8000, encodePackedPos(3, 3, GEO));
    advanceRecallQueue(p, 8, GEO);
    expect(p.recallCount).toBe(2);
    expect(p.messageTypes).toEqual([5]);
 // After moving up, the loop continues at the SAME index (`jae 0x3367a` @0x33734), so the entry
 // that moved up is still processed in this frame: 4000 - 8.
    expect(p.recallQueue[0]!.remaining).toBe(3992);
 // The third one is not reached — the budget is exhausted.
    expect(p.recallQueue[1]!.remaining).toBe(8000);
  });

  it('two overflows in one frame: the original defect swallows an entry', () => {
 // On the second firing the budget is exhausted: the counter drops (@0x336ed) but the move-up
 // does NOT happen (`subw $0x1,vreg3 ; jb 0x3374b` @0x336f5). Consequence in the original: the
 // already processed entry stays in slot 0 — with an underflowed, hence practically infinite
 // remaining time — and the entry behind it falls out of the list with the lowered counter.
    const p = player(0);
    pushRecall(p, 4, encodePackedPos(1, 1, GEO));
    pushRecall(p, 4, encodePackedPos(2, 2, GEO));
    pushRecall(p, 9000, encodePackedPos(3, 3, GEO));
    advanceRecallQueue(p, 8, GEO);
    expect(p.messageTypes.length).toBe(2); // both recalls arrived
    expect(p.recallCount).toBe(1);
    expect(p.recallQueue[0]!.remaining).toBe(0xfffffffc); // 4 - 8, u32 underflow
    expect(p.recallQueue[1]!.remaining).toBe(9000); // still there, but outside the counter
  });

  it('does nothing on an empty queue', () => {
    const p = player(0);
    advanceRecallQueue(p, 8, GEO);
    expect(p.messageTypes).toEqual([]);
    expect(p.recallCount).toBe(0);
  });
});

describe('recall: round trip through the real tick engine', () => {
  function state(): GameState {
    return loadState(save());
  }

  it('a 5-minute map recall arrives after ~30000 ticks as a type-5 message', () => {
    const st = state();
    const p = st.players[0]!;
    expect(scheduleMapRecall(p, 12, 34, 0, GEO)).toBe(true);
    runTicks(st, 29000);
    expect(p.messageTypes).toEqual([]);
    runTicks(st, 2000);
    expect(p.messageTypes).toEqual([5]);
    expect(p.messagePositions).toEqual([posOf(12, 34, GEO)]);
 // The alarm bit is set — the overlay picks it up and plays the sound.
    expect(p.flags & (1 << 3)).not.toBe(0);
  });

  it('the menu recall arrives as type 16 with the right parameter', () => {
    const st = state();
    const p = st.players[0]!;
    scheduleMenuRecall(p, 7, 0); // screen 0x2d
    runTicks(st, 30100);
    expect(p.messageTypes.length).toBe(1);
    expect(p.messageTypes[0]! & 0x1f).toBe(16);
    expect(p.messageTypes[0]! >> 5).toBe(6);
  });

  it('the building recall arrives as type 19 with the building position', () => {
    const st = state();
    const p = st.players[0]!;
    scheduleBuildingRecall(p, 5, 6, 0, GEO);
    runTicks(st, 30100);
    expect(p.messageTypes).toEqual([0x13]);
    expect(p.messagePositions).toEqual([posOf(5, 6, GEO)]);
  });

  it('the longest clock fires later than the shortest', () => {
    const st = state();
    const p = st.players[0]!;
    scheduleMapRecall(p, 1, 1, 4, GEO); // 60 minutes
    runTicks(st, 100000);
    expect(p.messageTypes).toEqual([]);
    runTicks(st, 261000);
    expect(p.messageTypes).toEqual([5]);
  });
});
