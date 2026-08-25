import { describe, expect, it } from 'vitest';
import {
  AI_EMERGENCY_EVALUATORS,
  AI_EVALUATORS,
  AI_GEOLOGIST_THRESHOLD,
  AI_TASK_FLAG,
  AI_TASK_GEOLOGIST,
  AI_TASK_TO_CANDIDATE_ROW,
  AI_URGENCY_CLEAR_SLOTS,
  AI_URGENCY_SLOTS,
  aiCandidateAverage,
  aiDecideBuild,
  aiFlagUrgency,
  aiGeologistUrgency,
  aiMayStartBuilding,
  evaluatorAt,
} from './ai-decide.js';
import type { GameState, Player } from './state.js';
import { Rng } from './rng.js';
import { mapGeometry } from './position.js';

function candidates(rows: Record<number, number[]> = {}): { score: number; col: number; row: number }[][] {
  return Array.from({ length: 35 }, (_, r) =>
    Array.from({ length: 8 }, (_, s) => ({ score: rows[r]?.[s] ?? 0, col: 0, row: 0 })),
  );
}

function player(over: Partial<Player> = {}): Player {
  return {
    aiUrgency: new Array<number>(AI_URGENCY_SLOTS).fill(0),
    aiPressure: new Array<number>(AI_URGENCY_SLOTS).fill(0),
    aiPressureCatchUp: 0,
    aiIdleSerfs: new Array<number>(27).fill(0),
    aiStockpile: new Array<number>(26).fill(0),
    aiCandidates: candidates(),
    completedBuildingCount: new Array<number>(23).fill(0),
    incompleteBuildingCount: new Array<number>(23).fill(0),
    serfCount: new Array<number>(27).fill(0),
    messageFlags: 0,
    messageBuildingSlots: [0, 0, 0],
    totalLandScore: 0,
    ...over,
  } as unknown as Player;
}

/**
 * The decider touches the game state only through the probing branch, so a stub state is enough — but
 * it needs a random stream (the tail jump @0x5126d draws) and an EMPTY map, so probing finds nothing.
 */
function makeState(): GameState {
  return {
    mapTiles: [],
    buildings: [],
    serfs: [],
    inventories: [],
    geo: mapGeometry(3),
    rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
}
const state = makeState();

describe('ai decide: table and numbering', () => {
  it('holds exactly 25 evaluators, 15 in group a and 10 in group b', () => {
    expect(AI_EVALUATORS).toHaveLength(AI_URGENCY_SLOTS);
    expect(AI_EVALUATORS.filter((e) => e.group === 'a')).toHaveLength(15);
    expect(AI_EVALUATORS.filter((e) => e.group === 'b')).toHaveLength(10);
  });

  it('ordnet jedem Slot 0..24 genau einen Bewerter zu (Permutation)', () => {
    const slots = AI_EVALUATORS.map((e) => e.slot).sort((a, b) => a - b);
    expect(slots).toEqual(Array.from({ length: AI_URGENCY_SLOTS }, (_, i) => i));
  });

  it('has exactly three pair evaluators with an extra slot', () => {
    const pairs = AI_EVALUATORS.filter((e) => e.extra !== null);
    expect(pairs.map((e) => [e.slot, e.extra])).toEqual([[0, 11], [13, 14], [20, 21]]);
  });

  it('starts group a with flag and geologist, exactly the two of the head branch', () => {
    const a = AI_EVALUATORS.filter((e) => e.group === 'a');
    expect(a[0]?.addr).toBe(0x5831b);
    expect(a[0]?.slot).toBe(24);
    expect(a[1]?.addr).toBe(0x5ae48);
    expect(a[1]?.slot).toBe(23);
  });

  it('maps task to candidate row: 25 -> 0, 24 -> 25, otherwise unchanged', () => {
    expect(AI_TASK_TO_CANDIDATE_ROW(AI_TASK_FLAG)).toBe(0);
    expect(AI_TASK_TO_CANDIDATE_ROW(AI_TASK_GEOLOGIST)).toBe(25);
    expect(AI_TASK_TO_CANDIDATE_ROW(1)).toBe(1);
    expect(AI_TASK_TO_CANDIDATE_ROW(23)).toBe(23);
  });

  it('names the three emergency evaluators with bit and building slot', () => {
    expect(AI_EMERGENCY_EVALUATORS.map((e) => [e.addr, e.bit, e.hintSlot]))
      .toEqual([[0x58833, 3, 0], [0x5a177, 4, 1], [0x58c89, 5, 2]]);
    expect(evaluatorAt(0x5a177)?.group).toBe('b'); // steht im vollen Satz in Gruppe b
  });
});

describe('ai decide: candidate average', () => {
  it('divides the sum of the eight scores by 8', () => {
    const p = player({ aiCandidates: candidates({ 0: [8, 16, 24, 32, 40, 48, 56, 64] }) });
    expect(aiCandidateAverage(p, 0)).toBe(Math.floor((8 + 16 + 24 + 32 + 40 + 48 + 56 + 64) / 8));
  });

  it('carries beyond 16 bits correctly (the carry counter of the original)', () => {
    const p = player({ aiCandidates: candidates({ 0: new Array<number>(8).fill(65535) }) });
    expect(aiCandidateAverage(p, 0)).toBe(Math.floor((65535 * 8) / 8));
  });

  it('yields 0 for an empty row', () => {
    expect(aiCandidateAverage(player(), 7)).toBe(0);
  });
});

describe('ai decide: flag urgency @0x5831b', () => {
  const base = (over: Partial<Player> = {}) => player({
    aiIdleSerfs: (() => { const a = new Array<number>(27).fill(0); a[0] = 2; a[21] = 1; return a; })(),
    aiCandidates: candidates({ 0: [800, 0, 0, 0, 0, 0, 0, 0] }),
    aiPressure: (() => { const a = new Array<number>(25).fill(0); a[24] = 0xffff; return a; })(),
    ...over,
  });

  it('computes (56000 * pressure) >> 16', () => {
    const p = base();
    aiFlagUrgency(state, p);
    expect(p.aiUrgency[24]).toBe(Math.floor((56000 * 0xffff) / 0x10000));
    expect(p.aiUrgency[24]).toBe(55999);
  });

  it('needs at least three transporters/generics', () => {
    const idle = new Array<number>(27).fill(0);
    idle[0] = 1;
    idle[21] = 1;
    const p = base({ aiIdleSerfs: idle });
    aiFlagUrgency(state, p);
    expect(p.aiUrgency[24]).toBe(0);
  });

  it('needs a known spot; the average is only a GATE, not a factor', () => {
    const p = base({ aiCandidates: candidates() });
    aiFlagUrgency(state, p);
    expect(p.aiUrgency[24]).toBe(0);

    // Half the score gives the same urgency (unlike the geologist).
    const q = base({ aiCandidates: candidates({ 0: [400, 0, 0, 0, 0, 0, 0, 0] }) });
    aiFlagUrgency(state, q);
    expect(q.aiUrgency[24]).toBe(55999);
  });

  it('leaves a stale value UNCHANGED when it bails out (slot 24 is never cleared)', () => {
    const idle = new Array<number>(27).fill(0);
    const p = base({ aiIdleSerfs: idle });
    p.aiUrgency[24] = 4711;
    aiFlagUrgency(state, p);
    expect(p.aiUrgency[24]).toBe(4711);
  });
});

describe('ai decide: geologist urgency @0x5ae48', () => {
  const base = (over: Partial<Player> = {}) => player({
    aiIdleSerfs: (() => { const a = new Array<number>(27).fill(0); a[0] = 1; a[20] = 1; a[21] = 1; return a; })(),
    aiCandidates: candidates({ 25: [8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000] }),
    aiPressure: (() => { const a = new Array<number>(25).fill(0); a[23] = 0xffff; return a; })(),
    ...over,
  });

  it('computes (min(average, 14999) * 4 * pressure) >> 16', () => {
    const p = base();
    aiGeologistUrgency(state, p);
    expect(p.aiUrgency[23]).toBe(Math.floor(((8000 << 2) * 0xffff) / 0x10000));
  });

  it('clamps the average at 14999, so 59995 is the ceiling', () => {
    const p = base({ aiCandidates: candidates({ 25: new Array<number>(8).fill(50000) }) });
    aiGeologistUrgency(state, p);
    expect(p.aiUrgency[23]).toBe(59995);

    // Two different averages above the clamp give the same result.
    const q = base({ aiCandidates: candidates({ 25: new Array<number>(8).fill(60000) }) });
    aiGeologistUrgency(state, q);
    expect(q.aiUrgency[23]).toBe(59995);
  });

  it('needs only two transporters/generics when a geologist is idle', () => {
    const idle = new Array<number>(27).fill(0);
    idle[20] = 1;
    idle[0] = 2;
    const p = base({ aiIdleSerfs: idle });
    aiGeologistUrgency(state, p);
    expect(p.aiUrgency[23]).toBeGreaterThan(0);

    idle[0] = 1;
    const q = base({ aiIdleSerfs: idle });
    aiGeologistUrgency(state, q);
    expect(q.aiUrgency[23]).toBe(0);
  });

  it('without an idle geologist it caps the count at land/128 + 3', () => {
    const idle = new Array<number>(27).fill(0);
    idle[0] = 2;
    idle[21] = 2;
    const stock = new Array<number>(26).fill(0);
    stock[16] = 1; // hammer
    const serfs = new Array<number>(27).fill(0);
    serfs[20] = 4; // four geologists in the game

    // Land 128 => allowance 1+3 = 4 >= 4, so one more is allowed.
    const p = base({ aiIdleSerfs: idle, aiStockpile: stock, serfCount: serfs, totalLandScore: 128 });
    aiGeologistUrgency(state, p);
    expect(p.aiUrgency[23]).toBeGreaterThan(0);

    // serfCount 5 > allowance 4 => no.
    const serfs2 = [...serfs];
    serfs2[20] = 5;
    const q = base({ aiIdleSerfs: idle, aiStockpile: stock, serfCount: serfs2, totalLandScore: 128 });
    aiGeologistUrgency(state, q);
    expect(q.aiUrgency[23]).toBe(0);
  });

  it('without an idle geologist it needs a hammer', () => {
    const idle = new Array<number>(27).fill(0);
    idle[0] = 2;
    idle[21] = 2;
    const p = base({ aiIdleSerfs: idle, aiStockpile: new Array<number>(26).fill(0) });
    aiGeologistUrgency(state, p);
    expect(p.aiUrgency[23]).toBe(0);
  });
});

describe('ai decide: material lock @0x54df9', () => {
  const ready = (over: Partial<Player> = {}) => player({
    aiIdleSerfs: (() => { const a = new Array<number>(27).fill(0); a[3] = 1; a[0] = 1; a[21] = 1; return a; })(),
    aiStockpile: (() => { const a = new Array<number>(26).fill(0); a[7] = 200; a[9] = 200; return a; })(),
    completedBuildingCount: (() => { const a = new Array<number>(23).fill(0); a[9] = 5; return a; })(),
    ...over,
  });

  it('allows building when staff and material suffice', () => {
    expect(aiMayStartBuilding(ready())).toBe(true);
  });

  it('with an idle builder it needs two transporters/generics, without one three plus a hammer', () => {
    const idle = new Array<number>(27).fill(0);
    idle[3] = 1;
    idle[0] = 1;
    expect(aiMayStartBuilding(ready({ aiIdleSerfs: idle }))).toBe(false);

    const idle2 = new Array<number>(27).fill(0);
    idle2[0] = 1;
    idle2[21] = 2;
    const stock = new Array<number>(26).fill(0);
    stock[7] = 200;
    stock[9] = 200;
    stock[16] = 1; // hammer
    expect(aiMayStartBuilding(ready({ aiIdleSerfs: idle2, aiStockpile: stock }))).toBe(true);
    stock[16] = 0;
    expect(aiMayStartBuilding(ready({ aiIdleSerfs: idle2, aiStockpile: stock }))).toBe(false);
  });

  it('takes the SMALLEST of the three limits (intersection, not choice)', () => {
    // Warehouse term: (0 + 3) * 4 = 12; planks 200/4+6 = 56; stones 200/2+8 = 108 => limit 12.
    const comp = new Array<number>(23).fill(0);
    const inc = new Array<number>(23).fill(0);
    inc[0] = 12;
    expect(aiMayStartBuilding(ready({ completedBuildingCount: comp, incompleteBuildingCount: inc })))
      .toBe(true);
    inc[0] = 13;
    expect(aiMayStartBuilding(ready({ completedBuildingCount: comp, incompleteBuildingCount: inc })))
      .toBe(false);
  });

  it('lets planks and stones limit as well', () => {
    const comp = new Array<number>(23).fill(0);
    comp[9] = 50; // warehouse term 212, does not bind
    const stock = new Array<number>(26).fill(0);
    stock[7] = 8; // planks: 8/4 + 6 = 8
    stock[9] = 200;
    const inc = new Array<number>(23).fill(0);
    inc[0] = 8;
    expect(aiMayStartBuilding(ready({
      completedBuildingCount: comp, aiStockpile: stock, incompleteBuildingCount: inc,
    }))).toBe(true);
    inc[0] = 9;
    expect(aiMayStartBuilding(ready({
      completedBuildingCount: comp, aiStockpile: stock, incompleteBuildingCount: inc,
    }))).toBe(false);
  });

  it('sums all 23 site counters, not just the first', () => {
    const inc = new Array<number>(23).fill(0);
    inc[22] = 13;
    expect(aiMayStartBuilding(ready({
      completedBuildingCount: new Array<number>(23).fill(0), incompleteBuildingCount: inc,
    }))).toBe(false);
  });
});

describe('ai decide: the decider @0x51221', () => {
  /** Building allowed, both ported evaluators bail out (empty candidate table). */
  const mainBranch = (over: Partial<Player> = {}) => player({
    aiIdleSerfs: (() => { const a = new Array<number>(27).fill(0); a[3] = 1; a[0] = 5; a[21] = 5; return a; })(),
    aiStockpile: (() => { const a = new Array<number>(26).fill(0); a[7] = 200; a[9] = 200; return a; })(),
    completedBuildingCount: (() => { const a = new Array<number>(23).fill(0); a[9] = 5; return a; })(),
    ...over,
  });

  it('clears slots 0..23 but NOT slot 24', () => {
    const p = mainBranch();
    p.aiUrgency[5] = 9999;
    p.aiUrgency[24] = 7;
    expect(aiDecideBuild(state, p)).toBe(AI_TASK_FLAG);
    expect(p.aiUrgency[5]).toBe(0);
    expect(p.aiUrgency[24]).toBe(7);
    expect(AI_URGENCY_CLEAR_SLOTS).toBe(24);
  });

  it('picks the maximum and returns slot + 1 as the task', () => {
    const p = mainBranch();
    p.aiPressure[24] = 0x8000;
    p.aiUrgency[24] = 4711;
    expect(aiDecideBuild(state, p)).toBe(AI_TASK_FLAG);
    expect(AI_TASK_FLAG).toBe(24 + 1);
  });

  it('halves the pressure counter of the chosen task', () => {
    const p = mainBranch();
    p.aiPressure[24] = 0x8001;
    p.aiUrgency[24] = 4711;
    aiDecideBuild(state, p);
    expect(p.aiPressure[24]).toBe(0x4000); // 0x8001 >>> 1
  });

  it('returns no task and consumes nothing when everything is zero', () => {
    const p = mainBranch();
    p.aiPressure[24] = 0x8000;
    expect(aiDecideBuild(state, p)).toBe(0);
    expect(p.aiPressure[24]).toBe(0x8000);
  });

  it('requires maximum >= catch-up pressure; equality passes', () => {
    const p = mainBranch({ aiPressureCatchUp: 4711 });
    p.aiUrgency[24] = 4711;
    expect(aiDecideBuild(state, p)).toBe(AI_TASK_FLAG);

    const q = mainBranch({ aiPressureCatchUp: 4712 });
    q.aiUrgency[24] = 4711;
    q.aiPressure[24] = 0x8000;
    expect(aiDecideBuild(state, q)).toBe(0);
    expect(q.aiPressure[24]).toBe(0x8000);
  });

  it('takes the FIRST slot on a tie (only a strictly larger value wins)', () => {
    // Slots 23 and 24 equal: 23 comes first => task 24.
    const idle = new Array<number>(27).fill(0);
    idle[3] = 1;
    idle[0] = 5;
    idle[21] = 5;
    idle[20] = 1; // idle geologist
    const p = mainBranch({ aiIdleSerfs: idle });
    // Both evaluators bail out without candidates, so setting the values afterwards is impossible;
    // instead let the geologist compute, so that both slots carry the same value.
    p.aiCandidates = candidates({ 25: new Array<number>(8).fill(50000) });
    p.aiPressure[23] = 0xffff;
    p.aiUrgency[24] = 59995; // stale, equal to the geologist result
    expect(aiDecideBuild(state, p)).toBe(AI_TASK_GEOLOGIST);
  });

  it('head branch: flag before geologist, and the geologist needs 10000', () => {
    const idle = new Array<number>(27).fill(0);
    idle[3] = 1;
    idle[0] = 5;
    idle[21] = 5;
    const inc = new Array<number>(23).fill(0);
    inc[0] = 400; // material lock says no
    const blocked = () => mainBranch({ aiIdleSerfs: idle, incompleteBuildingCount: inc });

    const p = blocked();
    expect(aiMayStartBuilding(p)).toBe(false);
    p.aiUrgency[24] = 1; // stale; the head branch READS the field
    expect(aiDecideBuild(state, p)).toBe(AI_TASK_FLAG);

    const q = blocked();
    q.aiUrgency[23] = AI_GEOLOGIST_THRESHOLD;
    expect(aiDecideBuild(state, q)).toBe(AI_TASK_GEOLOGIST);

    const r = blocked();
    r.aiUrgency[23] = AI_GEOLOGIST_THRESHOLD - 1;
    expect(aiDecideBuild(state, r)).toBe(0);
  });

  it('emergency programme: only the three chain buildings are evaluated', () => {
    // With bit 6 set only the three chain evaluators run; on empty candidate rows they yield 0.
    const p = mainBranch({ messageFlags: 0x40 });
    p.aiUrgency[24] = 4711; // slot 24 is not cleared in the emergency branch either...
    // ...and the flag evaluator does not run there, so the stale value survives and wins.
    expect(aiDecideBuild(state, p)).toBe(AI_TASK_FLAG);
  });
});
