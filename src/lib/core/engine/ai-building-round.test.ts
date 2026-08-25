import { describe, it, expect } from 'vitest';
import {
  AI_FARM_FOOD_SLOTS,
  AI_FARM_LEVELS,
  AI_ROUND_DISPATCH,
  AI_ROUND_SCANS,
  AI_STOCK_SCORE_STEPS,
  AI_STOCK_THRESHOLDS,
  aiFarmAllowedCount,
} from './ai-building-round.js';

describe('building round: table structure (FUN_00052271)', () => {
  it('the jump table has 25 slots, 15 of them `ret` stubs', () => {
    expect(AI_ROUND_DISPATCH).toHaveLength(25);
    expect(AI_ROUND_DISPATCH.filter((d) => d.stub)).toHaveLength(15);
    // Exactly the types without a body of their own: none, boatbuilder, hut and everything from the butcher on.
    const stubTypes = AI_ROUND_DISPATCH.map((d, i) => (d.stub ? i : -1)).filter((i) => i >= 0);
    expect(stubTypes).toEqual([0, 3, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  it('the slot targets grow strictly - the bodies lie back to back', () => {
    for (let i = 1; i < AI_ROUND_DISPATCH.length; i++) {
      expect(AI_ROUND_DISPATCH[i]!.target).toBeGreaterThan(AI_ROUND_DISPATCH[i - 1]!.target);
    }
  });

  it('the eight searchers cover exactly the resource-dependent types', () => {
    expect(AI_ROUND_SCANS.map((s) => s.type)).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);
    // Every searcher type has a real body in the jump table, and the entry points agree.
    for (const s of AI_ROUND_SCANS) {
      expect(AI_ROUND_DISPATCH[s.type]!.stub).toBe(false);
      expect(AI_ROUND_DISPATCH[s.type]!.target).toBe(s.entry);
    }
  });

  it('the four mines differ ONLY in the mineral byte', () => {
    const mines = AI_ROUND_SCANS.filter((s) => s.kind === 'mineral');
    expect(mines).toHaveLength(4);
    expect(new Set(mines.map((m) => m.positions))).toEqual(new Set([32]));
    expect(new Set(mines.map((m) => m.cost))).toEqual(new Set([5]));
    // 0x80/0x60/0x40/0x20 == Mineral 4/3/2/1 == Stein/Kohle/Eisen/Gold.
    expect(mines.map((m) => m.mineralByte! >> 5)).toEqual([4, 3, 2, 1]);
  });
});

describe('building round: farm cascade', () => {
  it('sums exactly the six food goods', () => {
    expect([...AI_FARM_FOOD_SLOTS]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('unter 500 Nahrung passiert nichts', () => {
    expect(aiFarmAllowedCount(0)).toBeNull();
    expect(aiFarmAllowedCount(499)).toBeNull();
  });

  it('more food allows FEWER farms - the cascade falls monotonically', () => {
    const probes = [500, 600, 700, 800, 900, 1000, 1500, 2000, 65535];
    const levels = probes.map((f) => aiFarmAllowedCount(f)!);
    expect(levels).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 1]);
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeLessThanOrEqual(levels[i - 1]!);
  });

  it('the thresholds grow strictly and the first one is the cut-off', () => {
    const finite = AI_FARM_LEVELS.filter((l) => Number.isFinite(l.below));
    expect(finite).toHaveLength(8);
    for (let i = 1; i < finite.length; i++) {
      expect(finite[i]!.below).toBeGreaterThan(finite[i - 1]!.below);
    }
    expect(AI_FARM_LEVELS[0]!.level).toBeNull();
  });
});

describe('building round: warehouse policy', () => {
  it('the valuation chain is a Horner scheme with falling weights', () => {
    const weight = new Map<number, number>();
    let mult = 1;
    for (let i = AI_STOCK_SCORE_STEPS.length - 1; i >= 0; i--) {
      const step = AI_STOCK_SCORE_STEPS[i]!;
      if (step === 'double') { mult *= 2; continue; }
      for (const res of step) weight.set(res, mult);
    }
    // Goldbarren 64 · Waffen/Golderz 32 · Werkzeug 16 · Erz/Stahl/Kohle 8 · Boot/Stein 4.
    expect(weight.get(14)).toBe(64);
    expect(weight.get(24)).toBe(32);
    expect(weight.get(25)).toBe(32);
    expect(weight.get(13)).toBe(32);
    expect(weight.get(15)).toBe(16);
    expect(weight.get(23)).toBe(16);
    expect(weight.get(12)).toBe(8);
    expect(weight.get(9)).toBe(4);
  });

  it('food, timber and planks do not enter at all', () => {
    const counted = new Set(AI_STOCK_SCORE_STEPS.flatMap((s) => (s === 'double' ? [] : [...s])));
    for (const res of [0, 1, 2, 3, 4, 5, 6, 7]) expect(counted.has(res)).toBe(false);
    // ...and everything from the boat on exactly once.
    for (let res = 8; res <= 25; res++) expect(counted.has(res)).toBe(true);
    expect(counted.size).toBe(18);
  });

  it('the thresholds fall with the threat level - the front line clears out', () => {
    for (let col = 0; col < 4; col++) {
      for (let tl = 1; tl < 4; tl++) {
        expect(AI_STOCK_THRESHOLDS[tl]![col]).toBeLessThanOrEqual(AI_STOCK_THRESHOLDS[tl - 1]![col]);
      }
    }
    // Threat level 3 has zero thresholds - there is no accepting left there.
    expect(AI_STOCK_THRESHOLDS[3]!.slice(1)).toEqual([0, 0, 0]);
  });

  it('the clearing threshold is above the stop threshold in every row', () => {
    for (const row of AI_STOCK_THRESHOLDS) {
      expect(row[0]!).toBeGreaterThan(row[1]!);
      expect(row[2]!).toBeGreaterThanOrEqual(row[3]!);
    }
  });
});
