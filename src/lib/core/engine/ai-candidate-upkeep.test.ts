import { describe, it, expect } from 'vitest';
import { AI_CANDIDATE_BASE, AI_UPKEEP_PASSES } from './ai-candidate-upkeep.js';

/**
 * Upkeep of the candidate rows (`FUN_0005325f`, slot 8) - only the arithmetic of the pass table:
 * it must hit the candidate rows without gaps or overlap. That is why the table stands there as data
 * rather than as seven calls in code.
 */

describe('ai-candidate-upkeep: the seven passes', () => {
  it('every base works out as `0x434 + row * 48`', () => {
    for (const p of AI_UPKEEP_PASSES) {
      expect(AI_CANDIDATE_BASE + p.firstRow * 48).toBe(p.base);
    }
  });

  it('jeder Durchgang umfasst ganze Zeilen', () => {
    for (const p of AI_UPKEEP_PASSES) expect(p.slots % 8).toBe(0);
  });

  it('covers rows 1..23 and 26..34 without gaps or overlap', () => {
    const seen = new Set<number>();
    let doubled = 0;
    for (const p of AI_UPKEEP_PASSES) {
      for (let r = p.firstRow; r < p.firstRow + p.slots / 8; r++) {
        if (seen.has(r)) doubled++;
        seen.add(r);
      }
    }
    expect(doubled).toBe(0);
    const want = [...Array(23).keys()].map((i) => i + 1).concat([...Array(9).keys()].map((i) => i + 26));
    expect([...seen].sort((a, b) => a - b)).toEqual(want);
  });

  it('leaves out rows 0, 24 and 25 - the original does not maintain flag, castle and geologist', () => {
    const seen = new Set<number>();
    for (const p of AI_UPKEEP_PASSES) {
      for (let r = p.firstRow; r < p.firstRow + p.slots / 8; r++) seen.add(r);
    }
    for (const r of [0, 24, 25]) expect(seen.has(r)).toBe(false);
  });

  it('gives exactly the large building types the large body', () => {
    // Repeated independently of `LARGE_TYPES` in `build-site.ts`: the check should show two sources
    // agreeing, not a constant compared with itself.
    const large = new Set([10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    for (const p of AI_UPKEEP_PASSES) {
      if (p.body === 'attack') continue;
      for (let r = p.firstRow; r < p.firstRow + p.slots / 8; r++) {
        expect(p.body).toBe(large.has(r) ? 'large' : 'small');
      }
    }
  });
});
