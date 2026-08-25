import { describe, expect, it } from 'vitest';
import {
  AI_RAMPS,
  AI_RATIOS,
  aiBoatbuilderUrgency,
  aiFarmUrgency,
  aiFortressUrgency,
  aiHutUrgency,
  aiLumberjackUrgency,
  aiTowerUrgency,
  candidateAverage,
  candidateTopPair,
  clampMax,
  mulHigh,
  rampUrgency,
  ratioUrgency,
  satAdd,
  satSub,
  type AiRampBand,
} from './ai-evaluators.js';
import type { GameState, Player } from './state.js';

/** A player with all-zero tables, so every evaluator gate is closed. */
function player(over: Partial<Player> = {}): Player {
  return {
    index: 1,
    flags: 0x80,
    active: true,
    completedBuildingCount: new Array<number>(23).fill(0),
    incompleteBuildingCount: new Array<number>(23).fill(0),
    aiSupplyRatio: new Array<number>(21).fill(0),
    aiIdleSerfs: new Array<number>(27).fill(0),
    aiStockpile: new Array<number>(26).fill(0),
    aiUrgency: new Array<number>(25).fill(0),
    aiPressure: new Array<number>(25).fill(0xffff),
    aiCandidates: Array.from({ length: 35 }, () => new Array(8).fill(null)),
    toolPriority: new Array<number>(9).fill(0),
    planksDistribution: new Array<number>(3).fill(0),
    aiHutUrgencyCap: 64000,
    aiKnightOccupationLevel: 16,
    serfCount: new Array<number>(27).fill(0),
    totalLandScore: 0,
    ...over,
  } as unknown as Player;
}

const state = {} as GameState;

describe('KI-Bewerter — Operatoren', () => {
  it('mulHigh yields the upper half of the 16x16 product', () => {
    expect(mulHigh(0xffff, 0xffff)).toBe(0xfffe);
    expect(mulHigh(1000, 0x8000)).toBe(500);
    expect(mulHigh(1234, 0xffff)).toBe(1233);
    expect(mulHigh(5, 100)).toBe(0);
  });

  it('satAdd saturates at 0xffff, satSub at 0', () => {
    expect(satAdd(0xfff0, 0x20)).toBe(0xffff);
    expect(satAdd(1, 2)).toBe(3);
    expect(satSub(5, 3)).toBe(2);
    expect(satSub(3, 5)).toBe(0);
  });

  it('clampMax', () => {
    expect(clampMax(10, 5)).toBe(5);
    expect(clampMax(3, 5)).toBe(3);
  });
});

describe('KI-Bewerter — Kennlinien', () => {
  it('the ramp falls band by band and ends at 0', () => {
    const bands = AI_RAMPS[0x58395] as readonly AiRampBand[];
    expect(rampUrgency(0, bands)).toBe(0xffff); // no stock => maximum
    expect(rampUrgency(0x1f, bands)).toBe(0x83ff);
    expect(rampUrgency(0x20, bands)).toBe(0x7fff); // Bandwechsel, praktisch stetig
    expect(rampUrgency(0x70, bands)).toBe(0); // beyond the last band
  });

  it('the lumberjack curve underflows its base value (an original defect)', () => {
    const bands = AI_RAMPS[0x58833] as readonly AiRampBand[];
    expect(rampUrgency(0x5f, bands)).toBe(0x01ff); // falls cleanly up to here
    expect(rampUrgency(0x60, bands)).toBe(0xffff); // `subw $0x4000` on 0x3fff => wrap
    expect(rampUrgency(0x6f, bands)).toBe(0xe1ff);
    expect(rampUrgency(0x70, bands)).toBe(0x2000); // next band, small again
  });

  it('the ratio curve tips at equality', () => {
    const shape = AI_RATIOS[0x59b2a] as { num: number; shift: number; bias: number };
    expect(ratioUrgency(10, 5, shape)).toBeGreaterThan(0x8000); // capacity tight => high
    expect(ratioUrgency(10, 10, shape)).toBe(0x800); // Gleichstand ⇒ Sockel
    expect(ratioUrgency(10, 25, shape)).toBe(128); // surplus 15 => still in the tail band
    expect(ratioUrgency(10, 26, shape)).toBe(0); // surplus 16 => 0
    // Monotonically falling over the tight range.
    let prev = 0x10000;
    for (let have = 1; have < 10; have++) {
      const v = ratioUrgency(10, have, shape);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });
});

describe('AI evaluators — the two candidate functions', () => {
  const p = player({
    aiCandidates: [[
      { score: 1000, col: 0, row: 0 }, { score: 40000, col: 0, row: 0 },
      null, null, null, null, null, null,
    ]],
  } as Partial<Player>);

  it('candidateAverage sums all eight slots and divides by 8', () => {
    expect(candidateAverage(p, 0)).toBe((1000 + 40000) >>> 3);
  });

  it('candidateTopPair yields ONLY slot 0 (the original defect of FUN_0005b88b)', () => {
    // Slot 1 is four times as large and never seen: the unrolled loop reads the same address 16
    // times. Bit 0 is lost because the original halves twice and then adds.
    expect(candidateTopPair(p, 0)).toBe(1000);
    expect(candidateTopPair(player({
      aiCandidates: [[{ score: 12345, col: 0, row: 0 }]],
    } as Partial<Player>), 0)).toBe(12344);
  });

  it('both yield 0 for an empty row', () => {
    expect(candidateAverage(player(), 3)).toBe(0);
    expect(candidateTopPair(player(), 3)).toBe(0);
  });
});

describe('KI-Bewerter — Tore', () => {
  it('the boatbuilder needs staff AND a tool', () => {
    const p = player({ aiIdleSerfs: new Array<number>(27).fill(0) } as Partial<Player>);
    p.aiIdleSerfs[21] = 5; // generics but no hammer
    aiBoatbuilderUrgency(state, p);
    expect(p.aiUrgency[2]).toBe(0);
    p.aiStockpile[16] = 1; // Hammer
    aiBoatbuilderUrgency(state, p);
    expect(p.aiUrgency[2]).toBe(mulHigh(35000, 0xffff)); // no boat => 35000
  });

  it('the boatbuilder sets the plank priority to the same value', () => {
    const p = player();
    p.aiIdleSerfs[21] = 5;
    p.aiStockpile[16] = 1;
    p.aiStockpile[8] = 1; // one boat => 20000
    aiBoatbuilderUrgency(state, p);
    expect(p.planksDistribution[1]).toBe(20000);
    expect(p.aiUrgency[2]).toBe(mulHigh(20000, 0xffff));
  });

  it('without a lumberjack the urgency is maximal: the only fixed 0xffff', () => {
    const p = player();
    p.aiIdleSerfs[21] = 5;
    p.aiStockpile[20] = 5; // axes
    aiLumberjackUrgency(state, p);
    expect(p.aiUrgency[1]).toBe(0xffff);
  });

  it('the hut ceiling is a character trait', () => {
    const base = player({ aiHutUrgencyCap: 64000 } as Partial<Player>);
    base.aiIdleSerfs[21] = 5;
    base.aiStockpile[24] = 5;
    base.aiStockpile[25] = 5;
    base.aiCandidates[11] = [{ score: 60000, col: 0, row: 0 }, null, null, null,
      null, null, null, null] as never;
    aiHutUrgency(state, base);
    const wide = base.aiUrgency[11 - 1];
    const capped = player({ aiHutUrgencyCap: 1000 } as Partial<Player>);
    capped.aiIdleSerfs[21] = 5;
    capped.aiStockpile[24] = 5;
    capped.aiStockpile[25] = 5;
    capped.aiCandidates[11] = base.aiCandidates[11];
    aiHutUrgency(state, capped);
    expect(capped.aiUrgency[10]).toBe(mulHigh(1000, 0xffff));
    expect(wide).not.toBe(capped.aiUrgency[10]);
  });

  it('tower and fortress are gated behind aiKnightOccupationLevel (>= 8 and >= 10)', () => {
    const make = (gate: number): Player => {
      const p = player({ aiKnightOccupationLevel: gate } as Partial<Player>);
      p.aiIdleSerfs[21] = 9;
      p.aiStockpile[24] = 9;
      p.aiStockpile[25] = 9;
      p.completedBuildingCount[9] = 3; // warehouse => economy > 0
      return p;
    };
    const closed = make(7);
    aiTowerUrgency(state, closed);
    expect(closed.aiUrgency[20]).toBe(0);
    const open = make(8);
    aiTowerUrgency(state, open);
    expect(open.aiUrgency[20]).toBeGreaterThan(0);
    // The fortress needs 10; at 8 its slot stays untouched.
    open.aiUrgency[21] = 4242;
    aiFortressUrgency(state, open);
    expect(open.aiUrgency[21]).toBe(4242);
    const fortress = make(10);
    fortress.aiUrgency[21] = 4242;
    aiFortressUrgency(state, fortress);
    expect(fortress.aiUrgency[21]).toBe(mulHigh(4242, 0xffff));
  });

  it('the partner tail CLEARS its slot when its staff is missing', () => {
    // Otherwise the raw value the pair evaluator put there would survive.
    const p = player();
    p.aiUrgency[11] = 5000;
    aiFarmUrgency(state, p); // no farmers, no scythes
    expect(p.aiUrgency[11]).toBe(0);
  });
});
