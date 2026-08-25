import { describe, it, expect } from 'vitest';
import { Rng } from './rng.js';

describe('Rng — bit-exakter Original-PRNG (@0x28c54)', () => {
  // Reference vector, computed by hand from the original algorithm for seed [1,2,3] - independent of
  // the code, so it catches transcription and wraparound mistakes.
  //   Zug 1: r=((1+2)^3)=0
  //   Zug 2: Zustand (0,32771,32770) → r=((0+32771)^32770)=1
  //   Zug 3: Zustand (1,16387,32770) → r=((1+16387)^32770)=49158
  it('reproduces the hand-computed reference vector', () => {
    const rng = new Rng([1, 2, 3]);
    expect(rng.next()).toBe(0);
    expect(rng.next()).toBe(1);
    expect(rng.next()).toBe(49158);
  });

  it('the intermediate state is right after the first draw', () => {
    const rng = new Rng([1, 2, 3]);
    rng.next();
    expect(rng.getState()).toEqual([0, 32771, 32770]);
  });

  it('is deterministic: same seed -> same sequence', () => {
    const a = new Rng([0x0380, 0xeea7, 0x6b11]); // realer SAVE0-Seed
    const b = new Rng([0x0380, 0xeea7, 0x6b11]);
    const seqA = Array.from({ length: 32 }, () => a.next());
    const seqB = Array.from({ length: 32 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('alle Ausgaben liegen im u16-Bereich', () => {
    const rng = new Rng([0x0380, 0xeea7, 0x6b11]);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffff);
    }
  });

  it('getState/setState restores the sequence', () => {
    const rng = new Rng([5, 9, 13]);
    for (let i = 0; i < 7; i++) rng.next();
    const saved = rng.getState();
    const expected = Array.from({ length: 10 }, () => rng.next());
    const restored = new Rng([0, 0, 0]);
    restored.setState(saved);
    const actual = Array.from({ length: 10 }, () => restored.next());
    expect(actual).toEqual(expected);
  });
});
