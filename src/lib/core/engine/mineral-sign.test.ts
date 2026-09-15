import { describe, it, expect } from 'vitest';
import {
  MINERAL_COUNT,
  MINERAL_SIGNS_LARGE,
  MINERAL_SIGN_NOTHING,
  MINERAL_SIGN_SMALL_BELOW,
  isMineralSign,
  mineralSignObject,
} from './mineral-sign.js';

/**
 * The table as a unit. The proof that the GEOLOGIST computes the same thing lives in
 * `serf-geologist.test.ts` and runs the real handler over every input; here only the encoding.
 */
describe('mineral-sign', () => {
  it('four minerals in order gold/iron/coal/stone, large before small', () => {
    // Large (amount >= 12) is the even value, small the odd one right behind it.
    for (const [mineral, large] of [
      [1, 0x70],
      [2, 0x72],
      [3, 0x74],
      [4, 0x76],
    ] as const) {
      expect(mineralSignObject(mineral, 31), `mineral ${mineral} large`).toBe(large);
      expect(mineralSignObject(mineral, 1), `mineral ${mineral} small`).toBe(large + 1);
    }
  });

  it('12 is the only grade boundary', () => {
    for (let mineral = 1; mineral <= 4; mineral++) {
      for (let amount = 1; amount <= 31; amount++) {
        const small = mineralSignObject(mineral, amount) % 2 === 1;
        expect(small, `mineral ${mineral}, amount ${amount}`).toBe(amount < MINERAL_SIGN_SMALL_BELOW);
      }
    }
    expect(MINERAL_SIGN_SMALL_BELOW).toBe(12);
  });

  it('every deposit lands in 0x70..0x77', () => {
    for (let mineral = 1; mineral <= 4; mineral++) {
      for (let amount = 1; amount <= 31; amount++) {
        expect(isMineralSign(mineralSignObject(mineral, amount))).toBe(true);
      }
    }
  });

  it('nothing at all -> the empty sign', () => {
    expect(mineralSignObject(0, 0)).toBe(MINERAL_SIGN_NOTHING);
    expect(MINERAL_SIGN_NOTHING).toBe(0x78);
  });

  /**
   * The quirk kept from the original: the zero test is on the whole byte. An amount without a
   * mineral is how fish are stored, and it falls out of the sign range entirely — which is why a
   * caller walking every tile has to gate on the mineral itself.
   */
  it('an amount without a mineral is not a sign', () => {
    for (let amount = 1; amount <= 31; amount++) {
      const object = mineralSignObject(0, amount);
      expect(object, `amount ${amount}`).toBe(amount < MINERAL_SIGN_SMALL_BELOW ? 0x6f : 0x6e);
      expect(isMineralSign(object)).toBe(false);
    }
  });

  it('`isMineralSign` covers the deposits and nothing else', () => {
    expect(isMineralSign(MINERAL_SIGN_NOTHING)).toBe(false); // carries no deposit
    expect(isMineralSign(0x6f)).toBe(false); // ripe grain
    expect(isMineralSign(0x6e)).toBe(false);
    expect(isMineralSign(0)).toBe(false);
    for (let object = 0x70; object <= 0x77; object++) expect(isMineralSign(object)).toBe(true);
  });
});

describe('the four minerals', () => {
  it('fall out of the sign range rather than being written down', () => {
    expect(MINERAL_COUNT).toBe(4); // gold, iron, coal, stone — 0x70..0x77 is two objects each
    expect(MINERAL_SIGNS_LARGE).toEqual([0x70, 0x72, 0x74, 0x76]);
  });

  /**
   * The list is what the overlay switch draws, so a wrong entry would be an empty or foreign
   * picture — checked against the predicate rather than against the numbers above alone.
   */
  it('are large signs, all distinct, all recognised as signs', () => {
    expect(new Set(MINERAL_SIGNS_LARGE).size).toBe(MINERAL_COUNT);
    for (const sign of MINERAL_SIGNS_LARGE) {
      expect(isMineralSign(sign)).toBe(true);
      expect(sign).not.toBe(MINERAL_SIGN_NOTHING);
      // Large, not small: the small one sits one above, and that is the only grade there is.
      expect(MINERAL_SIGNS_LARGE).not.toContain(sign + 1);
    }
  });

  it('are the sign for an amount ON the threshold', () => {
    for (let m = 1; m <= MINERAL_COUNT; m++) {
      expect(mineralSignObject(m, MINERAL_SIGN_SMALL_BELOW)).toBe(MINERAL_SIGNS_LARGE[m - 1]);
      expect(mineralSignObject(m, MINERAL_SIGN_SMALL_BELOW - 1)).toBe(MINERAL_SIGNS_LARGE[m - 1]! + 1);
    }
  });
});
