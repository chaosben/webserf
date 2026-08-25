import { describe, it, expect } from 'vitest';
import {
  aiCharacterRate,
  aiPlayerTick,
  runAiPhaseSweep,
  AI_FIRST_ROTATION,
  AI_SETTLE_IN_TICKS,
  AI_STATE_FOUND_CASTLE,
  AI_STATE_IDLE,
  AI_STATE_RUNNING,
  AI_STATE_SETTLE_IN,
} from './ai-tick.js';
import { Rng } from './rng.js';
import { mapGeometry, posOf } from './position.js';
import type { GameState, Player } from './state.js';

/**
 * The AI tick frame — what is testable with synthetic data: order and number of RNG draws, the
 * fall-through of the sweep, the burn-through loop and the state transitions.
 */

const AI = 0xc0; // bit 7 (AI) + bit 6 (active)
const HUMAN = 0x40; // bit 6 only

/** Empty candidate table as the parser delivers it: 35 projects x 8 slots. */
export function emptyAiCandidates(): { score: number; col: number; row: number }[][] {
  return Array.from({ length: 35 }, () =>
    Array.from({ length: 8 }, () => ({ score: 0, col: 0, row: 0 })),
  );
}

function player(flags: number, over: Partial<Player> = {}): Player {
  return {
    flags,
    build: 0,
    difficulty: 30,
    cursorCol: 0,
    cursorRow: 0,
    aiRate: 0xffff,
    aiState: AI_STATE_RUNNING,
    aiCounter: 0,
    aiCandidates: emptyAiCandidates(),
 // The build decider (slots 2/6/10/11/14) reads and writes these tables.
    aiUrgency: new Array<number>(25).fill(0),
    aiPressure: new Array<number>(25).fill(0),
    aiPressureCatchUp: 0,
    aiIdleSerfs: new Array<number>(27).fill(0),
    aiStockpile: new Array<number>(26).fill(0),
    aiSupplyRatio: new Array<number>(21).fill(0),
    incompleteBuildingCount: new Array<number>(23).fill(0),
    completedBuildingCount: new Array<number>(23).fill(0),
    serfCount: new Array<number>(27).fill(0),
 // Slot 0 (the military/distribution policy) writes these fields.
    knightOccupation: [0x10, 0x21, 0x32, 0x43],
    toolPriority: new Array<number>(9).fill(0),
    foodDistribution: new Array<number>(4).fill(0),
    planksDistribution: new Array<number>(3).fill(0),
    steelDistribution: new Array<number>(2).fill(0),
    coalDistribution: new Array<number>(3).fill(0),
    wheatDistribution: new Array<number>(2).fill(0),
    aiOccupationCap: 16,
    aiAttackStrongChance: 0,
    aiKnightOccupationLevel: 0,
    aiKnightTotal: 0,
    aiShiftCooldown: 0,
    aiTimer562: 0,
    knightMenuValue: 0,
    knightShiftTimer: 0,
    messageFlags: 0,
    messageBuildingSlots: [0, 0, 0],
    totalLandScore: 0,
    ...over,
  } as unknown as Player;
}

/**
 * Only the fields the sweep, the dispatcher and the probe touch. `mapTiles` stays EMPTY: the probe
 * then finds nothing (every tile is `undefined`) and burns its full number of random draws — exactly
 * what the draw counts below need.
 */
function state(players: (Player | null)[], rotation: number, seed = 1): GameState {
  return {
    players,
    rotation,
    rotationWrap: 49,
    gameTick: 0,
    rng: new Rng([seed, 2, 3]),
    geo: mapGeometry(3),
    mapTiles: [],
    buildings: [],
 // Empty but present: every eighth tick of the running state walks serfs and inventories (the
 // census, slots 1/5/9/13), and slot 0 walks the buildings, which needs `header.maxBuildingIndex`.
    serfs: [],
    inventories: [],
    header: { maxBuildingIndex: 0, maxSerfIndex: 0 },
  } as unknown as GameState;
}

/** Random draws of one probe pass on the empty map: 32 rounds x 2. */
const PROBE_DRAWS = 64;

describe('ai-tick: character rate', () => {
  it('computes intelligence * 1300 + 13535', () => {
    expect(aiCharacterRate(10)).toBe(26535);
    expect(aiCharacterRate(20)).toBe(39535);
    expect(aiCharacterRate(38)).toBe(62935);
  });

  it('exhausts the u16 with exactly 65535 at the highest intelligence 40', () => {
    expect(aiCharacterRate(40)).toBe(0xffff);
  });
});

describe('ai-tick: the phase loop', () => {
  it('draws NO random for non-AI players and burns through to the wrap', () => {
    const st = state([player(HUMAN), player(HUMAN), null, null], AI_FIRST_ROTATION);
    const before = st.rng.getState().join(',');
    runAiPhaseSweep(st);
 // No AI player => no draw (the two `bt` sit BEFORE the `call rng_next`).
    expect(st.rng.getState().join(',')).toBe(before);
 // ...and the rotation ends on 0, not on 34.
    expect(st.rotation).toBe(0);
  });

  it('runs on the first active AI player and leaves the rotation there', () => {
    const ai = player(AI, { aiState: AI_STATE_IDLE });
    const st = state([player(HUMAN), ai, null, null], AI_FIRST_ROTATION);
    runAiPhaseSweep(st);
 // Slot 1 (rotation 33) belongs to player 0 (human) => +1, falls through to player 1 (AI) => runs.
    expect(st.rotation).toBe(AI_FIRST_ROTATION + 1);
  });

  it('gives a single AI player four chances per frame (four sweep passes)', () => {
 // Rate 0 => the gate always closes (`rng16 >= 0` always holds), but the draw still happens.
    const ai = player(AI, { aiRate: 0 });
    const st = state([player(HUMAN), ai, null, null], AI_FIRST_ROTATION);
    const rngBefore = st.rng.getState().join(',');
    runAiPhaseSweep(st);
    expect(st.rng.getState().join(',')).not.toBe(rngBefore);
    expect(st.rotation).toBe(0); // burnt through
 // Four draws: the loop runs from rotation 33 to the wrap 49, which is four sweeps.
    const check = new Rng([1, 2, 3]);
    for (let i = 0; i < 4; i++) check.next();
    expect(st.rng.getState().join(',')).toBe(check.getState().join(','));
  });

  it('does not enter at all for a rotation below the AI range', () => {
    const st = state([player(AI), null, null, null], 32);
    runAiPhaseSweep(st);
    expect(st.rotation).toBe(32);
  });
});

describe('ai-tick: state transitions', () => {
  it('state 3 is idle (a bare ret)', () => {
    const p = player(AI, { aiState: AI_STATE_IDLE, aiCounter: 7 });
    const st = state([p], 0);
    aiPlayerTick(st, p);
    expect(p.aiCounter).toBe(7);
    expect(p.aiState).toBe(AI_STATE_IDLE);
  });

  it('state 1 counts down and switches to the running state on reaching 0', () => {
    const p = player(AI, { aiState: AI_STATE_SETTLE_IN, aiCounter: AI_SETTLE_IN_TICKS });
    const st = state([p], 0);
    for (let i = 0; i < AI_SETTLE_IN_TICKS - 1; i++) aiPlayerTick(st, p);
    expect(p.aiState).toBe(AI_STATE_SETTLE_IN);
    expect(p.aiCounter).toBe(1);
    aiPlayerTick(st, p);
    expect(p.aiState).toBe(AI_STATE_RUNNING);
    expect(p.aiCounter).toBe(0xffff);
  });

  it('state 2 counts UP and hits a subtask every eighth tick', () => {
    const p = player(AI, { aiState: AI_STATE_RUNNING, aiCounter: 0xffff });
    const st = state([p], 0);
    let subtasks = 0;
    for (let i = 0; i < 64; i++) {
      aiPlayerTick(st, p);
      if ((p.aiCounter & 7) === 0) subtasks++;
    }
    expect(subtasks).toBe(8);
  });

 /** How many draws a single tick in state 0 consumes at this gameTick. */
  const drawsInFoundState = (tick: number): number => {
    const p = player(AI, { aiState: AI_STATE_FOUND_CASTLE });
    const st = state([p], 0);
    st.gameTick = tick;
    aiPlayerTick(st, p);
    const ref = new Rng([1, 2, 3]);
    let n = 0;
    while (ref.getState().join() !== st.rng.getState().join() && n < 500) { ref.next(); n++; }
    return n;
  };

  it('state 0 probes BEFORE the ramp — below tick 2000 only the probe draws happen', () => {
 // The original calls `0x5c54a` at the head (@0x5c39b) and checks the time only afterwards, so
 // 'nothing happens before tick 2000' does not mean 'no random draw'.
    expect(drawsInFoundState(1999)).toBe(PROBE_DRAWS);
  });

  it('the ramp draws exactly ONE more within 2000..9999, none above', () => {
    expect(drawsInFoundState(2000)).toBe(PROBE_DRAWS + 1);
    expect(drawsInFoundState(5999)).toBe(PROBE_DRAWS + 1);
    expect(drawsInFoundState(9999)).toBe(PROBE_DRAWS + 1);
    expect(drawsInFoundState(10000)).toBe(PROBE_DRAWS);
  });
});

/**
 * The founding branch `@0x5c457` — state 0 takes the best of the eight castle candidates, consumes
 * it and founds there if the spot really is a castle site. The structural cases on a synthetic map:
 * the candidate is consumed, an unsuitable spot pulls in the next candidate, the loop terminates,
 * and a castle really stands at the end.
 */
describe('ai-tick: state 0 founds — @0x5c457', () => {
  const GEO = mapGeometry(3);

 /** A map on which the classification yields `BUILD_CASTLE`: unowned, flat grass. */
  function foundingState(): GameState {
    const mapTiles = Array.from({ length: GEO.tileCount }, () => ({
      height: 10, terrainUp: 5, terrainDown: 5, object: 0, owner: 0, paths: 0,
      blocked: false, mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0,
    }));
    const p = player(AI, {
      aiState: AI_STATE_FOUND_CASTLE,
      flags: AI, // bit 0 clear == no castle yet => the classification yields BUILD_CASTLE
      slot: 0,
      index: 0,
      serfCount: new Array(27).fill(0),
      castleBuilding: 0,
      castleFlag: 0,
      castleInventory: 0,
    });
    return {
      header: { maxSerfIndex: 1, maxFlagIndex: 1, maxBuildingIndex: 1, maxInventoryIndex: 0 },
      geo: GEO,
      gameTick: 20000, // above the ramp => every pass does work
      serfBudget: 1999,
      rotation: 0,
      rotationWrap: 49,
      rng: new Rng([1, 2, 3]),
      serfs: [null, null],
      flags: [null, null],
      buildings: [null, null],
      inventories: [null],
      mapTiles,
      players: [p],
      blockMeta: {
        serfs: { recordSize: 16, maxIndex: 1 },
        flags: { recordSize: 70, maxIndex: 1 },
        buildings: { recordSize: 18, maxIndex: 1 },
        inventories: { recordSize: 120, maxIndex: 0 },
      },
    } as unknown as GameState;
  }

 /** Put a castle candidate into slot `i`. */
  function candidate(p: Player, i: number, score: number, col: number, row: number): void {
    const slot = p.aiCandidates[24][i];
    slot.score = score;
    slot.col = col;
    slot.row = row;
  }

  it('the castle candidate row is exactly `player+0x8b4`', () => {
 // 0x434 == base of the table, 48 B per project — the arithmetic works out exactly.
    expect(0x434 + 24 * 48).toBe(0x8b4);
  });

  it('without candidates nothing happens — state 0 remains', () => {
    const st = foundingState();
    const p = st.players[0]!;
    aiPlayerTick(st, p);
    expect(p.aiState).toBe(AI_STATE_FOUND_CASTLE);
    expect(st.buildings.filter(Boolean)).toHaveLength(0);
  });

  it('a candidate on a castle site is founded, consumed, and switches to state 1', () => {
    const st = foundingState();
    const p = st.players[0]!;
    candidate(p, 3, 5000, 20, 20);
    aiPlayerTick(st, p);

    expect(p.aiState).toBe(AI_STATE_SETTLE_IN);
    expect(p.aiCounter).toBe(AI_SETTLE_IN_TICKS);
    expect(p.cursorCol).toBe(20);
    expect(p.cursorRow).toBe(20);
    expect(p.aiCandidates[24][3].score).toBe(0); // @0x5c469 — the candidate is consumed
    const castle = st.buildings.filter(Boolean);
    expect(castle).toHaveLength(1);
    expect(castle[0]!.type).toBe(24);
    expect(castle[0]!.col).toBe(20);
    expect(castle[0]!.row).toBe(20);
  });

  it('an unsuitable candidate is consumed without founding', () => {
    const st = foundingState();
    const p = st.players[0]!;
 // Foreign land => the classification does not yield BUILD_CASTLE (without a castle the original
 // demands UNOWNED land).
    st.mapTiles[posOf(20, 20, GEO)].owner = 2;
    candidate(p, 0, 5000, 20, 20);
    aiPlayerTick(st, p);

    expect(p.aiState).toBe(AI_STATE_FOUND_CASTLE);
    expect(p.aiCandidates[24][0].score).toBe(0);
    expect(st.buildings.filter(Boolean)).toHaveLength(0);
  });

  it('after an unsuitable candidate the same round pulls in the next best (@0x5c4a0)', () => {
    const st = foundingState();
    const p = st.players[0]!;
    st.mapTiles[posOf(20, 20, GEO)].owner = 2; // the better spot is unsuitable
    candidate(p, 0, 9000, 20, 20);
    candidate(p, 5, 4000, 30, 30); // the weaker one is valid
    aiPlayerTick(st, p);

    expect(p.aiState).toBe(AI_STATE_SETTLE_IN);
    const castle = st.buildings.filter(Boolean);
    expect(castle).toHaveLength(1);
    expect(castle[0]!.col).toBe(30);
    expect(p.aiCandidates[24][0].score).toBe(0); // both consumed
    expect(p.aiCandidates[24][5].score).toBe(0);
  });

  it('eight unsuitable candidates end after eight rounds, not in an endless loop', () => {
    const st = foundingState();
    const p = st.players[0]!;
    for (let i = 0; i < 8; i++) {
      const col = 20 + i;
      st.mapTiles[posOf(col, 20, GEO)].owner = 2;
      candidate(p, i, 1000 + i, col, 20);
    }
    aiPlayerTick(st, p);

    expect(p.aiState).toBe(AI_STATE_FOUND_CASTLE);
    expect(p.aiCandidates[24].every((s) => s.score === 0)).toBe(true);
    expect(st.buildings.filter(Boolean)).toHaveLength(0);
  });
});
