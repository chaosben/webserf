import { describe, expect, it } from 'vitest';
import {
  AI_ATTACK_COUNT,
  AI_ATTACK_FIRST,
  AI_ATTACK_NO_PROLOG,
  ATTACK_CHAINS,
  ATTACK_PROLOG_CHAIN,
  CASTLE_CHAIN_COMMON,
  CASTLE_CHAIN_EASY,
  CASTLE_CHAIN_MEDIUM,
  CASTLE_DIFFICULTY_HARD,
  CASTLE_DIFFICULTY_MEDIUM,
  SCORE_CHAINS,
  SCORE_START,
  ScoreOpKind,
  runScoreChain,
  scoreCastleProject,
  scoreAttackTarget,
  scoreFlagProject,
  scoreProject,
  type ScoreOp,
} from './ai-score.js';
import { AI_SURVEY_SLOTS, AI_SURVEY_TABLES, type AiSurvey } from './ai-survey.js';
import type { Player } from './state.js';

/** Four empty survey tables; individual slots are filled via `set`. */
function survey(set: [table: number, slot: number, value: number][] = []): AiSurvey {
  const tables: number[][] = [];
  for (let t = 0; t < AI_SURVEY_TABLES; t++) tables.push(new Array<number>(AI_SURVEY_SLOTS).fill(0));
  for (const [t, s, v] of set) (tables[t] as number[])[s] = v;
  return { tables } as AiSurvey;
}

function player(over: Partial<Player> = {}): Player {
 // The two census tables belong to the type and are read by project 0; leaving them out here would
 // contradict the type and make the 35000 branch untestable.
  return { difficulty: 0, aiIdleSerfs: [], aiStockpile: [], ...over } as Player;
}

describe('factor evaluator (the original 16-bit arithmetic)', () => {
  it('multiplies as a 16-bit fraction: factor 0xffff leaves the score practically untouched', () => {
    const ops: ScoreOp[] = [[ScoreOpKind.Load, 0, 0], [ScoreOpKind.Mul, 0, 0]];
 // acc = 0xffff => score = (0xffff * 0xffff) >> 16 == 0xfffe
    expect(runScoreChain(ops, survey([[0, 0, 0xffff]]).tables)).toBe(0xfffe);
  });

  it('factor 0 sets the score to 0 — no candidate', () => {
    const ops: ScoreOp[] = [[ScoreOpKind.Load, 0, 0], [ScoreOpKind.Mul, 0, 0]];
    expect(runScoreChain(ops, survey().tables)).toBe(0);
  });

  it('with no op at all the start value 0xffff remains', () => {
    expect(runScoreChain([], survey().tables)).toBe(SCORE_START);
  });

  it('clamps unsigned and to the table value, not to the threshold', () => {
    const ops: ScoreOp[] = [
      [ScoreOpKind.Load, 0, 0], [ScoreOpKind.Clamp, 16, 15], [ScoreOpKind.Shl, 12, 0],
      [ScoreOpKind.Mul, 0, 0],
    ];
 // 99 => clamped to 15 => 15 << 12 == 0xf000
    const clamped = runScoreChain(ops, survey([[0, 0, 99]]).tables);
    const exact = runScoreChain(ops, survey([[0, 0, 15]]).tables);
    expect(clamped).toBe(exact);
  });

  it('`not` turns a large counter into a small factor (bonus -> penalty)', () => {
    const ops = (invert: boolean): ScoreOp[] => [
      [ScoreOpKind.Load, 0, 0], [ScoreOpKind.Clamp, 32, 31], [ScoreOpKind.Shl, 11, 0],
      ...(invert ? [[ScoreOpKind.Not, 0, 0] as ScoreOp] : []),
      [ScoreOpKind.Mul, 0, 0],
    ];
    const many = survey([[0, 0, 30]]).tables;
    const few = survey([[0, 0, 2]]).tables;
    expect(runScoreChain(ops(false), many)).toBeGreaterThan(runScoreChain(ops(false), few));
    expect(runScoreChain(ops(true), many)).toBeLessThan(runScoreChain(ops(true), few));
  });

  it('computes modulo 2^16 — the base term deliberately overflows', () => {
    const ops: ScoreOp[] = [
      [ScoreOpKind.Load, 0, 0], [ScoreOpKind.AddImm, 0xd7ff, 0], [ScoreOpKind.Mul, 0, 0],
    ];
 // 0x3000 + 0xd7ff == 0x107ff => 0x07ff in 16 bits, i.e. a SMALL factor.
    expect(runScoreChain(ops, survey([[0, 0, 0x3000]]).tables)).toBeLessThan(0x1000);
  });

  it('veto on counter != 0 sets the score to 0, regardless of the factors after it', () => {
    const ops: ScoreOp[] = [
      [ScoreOpKind.Load, 3, 9], [ScoreOpKind.VetoNonZero, 0, 0],
      [ScoreOpKind.Load, 0, 0], [ScoreOpKind.Clamp, 2, 1], [ScoreOpKind.Shl, 15, 0],
      [ScoreOpKind.Mul, 0, 0],
    ];
    expect(runScoreChain(ops, survey([[0, 0, 1]]).tables)).toBeGreaterThan(0);
    expect(runScoreChain(ops, survey([[0, 0, 1], [3, 9, 1]]).tables)).toBe(0);
  });

  it('the underflow veto fires exactly when `sub` borrows', () => {
    const ops: ScoreOp[] = [
      [ScoreOpKind.Load, 3, 5], [ScoreOpKind.Sub, 80, 0], [ScoreOpKind.VetoUnderflow, 0, 0],
      [ScoreOpKind.Clamp, 256, 255], [ScoreOpKind.Shl, 8, 0], [ScoreOpKind.Mul, 0, 0],
    ];
    expect(runScoreChain(ops, survey([[3, 5, 79]]).tables)).toBe(0);
    expect(runScoreChain(ops, survey([[3, 5, 200]]).tables)).toBeGreaterThan(0);
  });

  it('the op ORDER carries meaning: a shift between two additions is a weighting', () => {
    const tables = survey([[3, 17, 1], [2, 17, 8]]).tables;
 // Original form at `0x5e009`: (T3[17] << 3) + T2[17] == 16
    const ordered: ScoreOp[] = [
      [ScoreOpKind.Load, 3, 17], [ScoreOpKind.Shl, 3, 0], [ScoreOpKind.Add, 2, 17],
      [ScoreOpKind.Mul, 0, 0],
    ];
 // Naive flag form: (T3[17] + T2[17]) << 3 == 72 — a DIFFERENT factor.
    const naive: ScoreOp[] = [
      [ScoreOpKind.Load, 3, 17], [ScoreOpKind.Add, 2, 17], [ScoreOpKind.Shl, 3, 0],
      [ScoreOpKind.Mul, 0, 0],
    ];
    expect(runScoreChain(ordered, tables)).not.toBe(runScoreChain(naive, tables));
  });

  it('`Inert` has no effect — the original instruction writes to a different ctx slot', () => {
    const withInert: ScoreOp[] = [
      [ScoreOpKind.Load, 0, 0], [ScoreOpKind.Inert, 0, 0], [ScoreOpKind.Mul, 0, 0],
    ];
    const without: ScoreOp[] = [[ScoreOpKind.Load, 0, 0], [ScoreOpKind.Mul, 0, 0]];
    const t = survey([[0, 0, 1234]]).tables;
    expect(runScoreChain(withInert, t)).toBe(runScoreChain(without, t));
  });
});

describe('project 0 — the flag (branching logic, not a chain)', () => {
  it('unowned OR foreign land blocks — own land alone does NOT block', () => {
 // `mov 0x2(%ebx),%ax` @0x5e29b + `add 0x4(%ebx),%ax` @0x5e2a6 == bytes 2 and 4, i.e. slots 1
 // (unowned) and 2 (foreign). Slot 0 (own land) does not appear here at all — the flag is meant to
 // be placed deep inside own territory. The slot assignment comes from the scan body
 // (`FUN_00060baa`: unowned @0x60c12 byte 2, own @0x60c1f byte 0, foreign @0x60c05 byte 4).
    expect(scoreFlagProject(survey([[0, 1, 1]]), player())).toBe(0);
    expect(scoreFlagProject(survey([[0, 2, 1]]), player())).toBe(0);
    expect(scoreFlagProject(survey([[0, 0, 99]]), player())).toBe(40000);
  });

  it('road slot 0 (the pre-check head did not run) => 40000', () => {
    expect(scoreFlagProject(survey(), player())).toBe(40000);
  });

  it('successful pre-check head (slot 37 == 100) => 0, there is nothing to do', () => {
    expect(scoreFlagProject(survey([[0, 37, 100]]), player())).toBe(0);
  });

  it('failure (0xffff) with too little slot 5 => 0', () => {
    expect(scoreFlagProject(survey([[0, 37, 0xffff], [0, 5, 11]]), player())).toBe(0);
  });

  it('failure with enough slot 5: an idle SAILOR => 35000', () => {
 // `mov 0x368(%ebx),%ax` @0x5e2d4 == `aiIdleSerfs[1]` (base 0x366).
    const withSailor = player({ aiIdleSerfs: [0, 1], aiStockpile: [] });
    expect(scoreFlagProject(survey([[0, 37, 0xffff], [0, 5, 12]]), withSailor)).toBe(35000);
  });

  it('no sailor, but a BOAT in the stock => 35000', () => {
 // `mov 0x3ac(%ebx),%ax` @0x5e2e3 == `aiStockpile[8]` (base 0x39c).
    const withBoat = player({ aiIdleSerfs: [], aiStockpile: [0, 0, 0, 0, 0, 0, 0, 0, 3] });
    expect(scoreFlagProject(survey([[0, 37, 0xffff], [0, 5, 12]]), withBoat)).toBe(35000);
  });

  it('neither sailor nor boat => 0 — nobody would get across the water', () => {
    expect(scoreFlagProject(survey([[0, 37, 0xffff], [0, 5, 12]]), player())).toBe(0);
  });

  it('sailor and boat are useless while slot 5 is below 12 (`cmpw $0xc` @0x5e2ca)', () => {
    const rich = player({ aiIdleSerfs: [0, 5], aiStockpile: [0, 0, 0, 0, 0, 0, 0, 0, 5] });
    expect(scoreFlagProject(survey([[0, 37, 0xffff], [0, 5, 11]]), rich)).toBe(0);
  });
});

describe('project 24 — the castle (chain plus difficulty tail)', () => {
 // T1[30], T2[31] and T1[32] MUST be set: their three factors in the common chain have neither a
 // base term nor `not`, so a counter of 0 drives the score to 0 irrevocably. That is what shows the
 // chain to be a real product chain and not a sum of points.
  const tables = survey([
    [0, 2, 5], [2, 2, 3], [0, 3, 40], [0, 5, 20],
    [1, 30, 100], [2, 31, 100], [1, 32, 20],
    [1, 39, 4], [2, 39, 6], [1, 40, 3], [2, 40, 5], [2, 5, 2], [1, 5, 3],
  ]);

  it('the hardest difficulty gets ONLY the common chain', () => {
    expect(scoreCastleProject(tables, player({ difficulty: CASTLE_DIFFICULTY_HARD })))
      .toBe(runScoreChain(CASTLE_CHAIN_COMMON, tables.tables));
  });

  it('the medium one gets the short segment appended', () => {
    expect(scoreCastleProject(tables, player({ difficulty: CASTLE_DIFFICULTY_MEDIUM })))
      .toBe(runScoreChain([...CASTLE_CHAIN_COMMON, ...CASTLE_CHAIN_MEDIUM], tables.tables));
  });

  it('the easiest one the long segment', () => {
    expect(scoreCastleProject(tables, player({ difficulty: 0 })))
      .toBe(runScoreChain([...CASTLE_CHAIN_COMMON, ...CASTLE_CHAIN_EASY], tables.tables));
  });

  it('the two extra segments really differ — the branch is not inconsequential', () => {
 // Checked in isolation because the common chain already yields 0 for mediocre counters (below);
 // a shared fixture would hide this property.
    expect(CASTLE_CHAIN_EASY).not.toEqual(CASTLE_CHAIN_MEDIUM);
    expect(runScoreChain(CASTLE_CHAIN_EASY, tables.tables))
      .not.toBe(runScoreChain(CASTLE_CHAIN_MEDIUM, tables.tables));
  });

  it('is a PRODUCT: 15 mediocre factors push the score down to 0', () => {
 // Why the castle is rarely a candidate at all — every single factor below ~1.0 scales the score
 // down, and the chain has 15 of them. A sum of points would behave differently.
    expect(runScoreChain(CASTLE_CHAIN_COMMON, tables.tables)).toBe(0);

 // Conversely there is a surrounding for which the castle does score — exactly the one that
 // maximises every factor. It is derived from the chain itself: bonus terms (without `not`) want
 // their counter at the clamp threshold, penalty terms (with `not`) want 0. The point is that
 // neither 'uniformly large' nor 'uniformly small' would do.
    const best = survey();
    {
      let term: ScoreOp[] = [];
      for (const op of CASTLE_CHAIN_COMMON) {
        term.push(op);
        if (op[0] !== ScoreOpKind.Mul) continue;
        const penalty = term.some((o) => o[0] === ScoreOpKind.Not);
        const clamp = term.find((o) => o[0] === ScoreOpKind.Clamp);
        if (!penalty && clamp !== undefined) {
          for (const o of term) {
            if (o[0] === ScoreOpKind.Load || o[0] === ScoreOpKind.Add) {
              (best.tables[o[1]] as number[])[o[2]] = clamp[2];
            }
          }
        }
        term = [];
      }
    }
    expect(runScoreChain(CASTLE_CHAIN_COMMON, best.tables)).toBeGreaterThan(0);
  });
});

describe('scoreProject — the dispatcher', () => {
  it('has chains for 1..23 and 25, but not for the branch-B ids 26..34', () => {
    for (let p = 1; p <= 25; p++) {
      if (p === 24) continue;
      expect(SCORE_CHAINS[p], `project ${p}`).toBeDefined();
    }
    for (let p = 26; p < 35; p++) expect(SCORE_CHAINS[p]).toBeUndefined();
    expect(scoreProject(30, survey(), player())).toBe(0);
  });

  it('forwards 0 and 24 to the special cases', () => {
    expect(scoreProject(0, survey(), player())).toBe(scoreFlagProject(survey(), player()));
    const t = survey([[0, 2, 3]]);
    expect(scoreProject(24, t, player())).toBe(scoreCastleProject(t, player()));
  });

  it('returns 0 for the mines on an empty surrounding — no mine without a soil sample', () => {
    for (const mine of [5, 6, 7, 8]) expect(scoreProject(mine, survey(), player())).toBe(0);
  });

  it('the mines hang on their matching soil-sample sign (slots 36..33 for types 5..8)', () => {
    const sign: Record<number, number> = { 5: 36, 6: 35, 7: 34, 8: 33 };
    for (const [mine, slot] of Object.entries(sign)) {
      const t = survey([[3, slot, 8], [1, 15, 4]]);
      expect(scoreProject(Number(mine), t, player()), `mine ${mine}`).toBeGreaterThan(0);
 // The sign of a DIFFERENT mine does not help.
      const other = survey([[3, slot === 36 ? 33 : 36, 8], [1, 15, 4]]);
      expect(scoreProject(Number(mine), other, player())).toBe(0);
    }
  });
});

describe('branch B — the nine attack targets (`0x5cd15`..`0x5d944`)', () => {
  it('carries all nine ids 26..34', () => {
    for (let id = AI_ATTACK_FIRST; id < AI_ATTACK_FIRST + AI_ATTACK_COUNT; id++) {
      expect(ATTACK_CHAINS[id], `id ${id}`).toBeDefined();
    }
    expect(Object.keys(ATTACK_CHAINS)).toHaveLength(AI_ATTACK_COUNT);
  });

  it('the second accumulator sums terms instead of multiplying per term', () => {
 // `sum = acc ; acc = <other slot> ; sum += acc ; acc = sum` — one multiplication at the end.
    const ops: ScoreOp[] = [
      [ScoreOpKind.Load, 0, 1], [ScoreOpKind.SumStore, 0, 0],
      [ScoreOpKind.Load, 0, 2], [ScoreOpKind.SumAdd, 0, 0],
      [ScoreOpKind.AccFromSum, 0, 0], [ScoreOpKind.Mul, 0, 0],
    ];
 // 3 + 5 == 8; score 0xffff * 8 / 65536 == 7 (rounds down like `mul` + `rorl`).
    expect(runScoreChain(ops, survey([[0, 1, 3], [0, 2, 5]]).tables)).toBe(7);
  });

  it('`acc += sum` is the second combining form (ids 31..34)', () => {
    const ops: ScoreOp[] = [
      [ScoreOpKind.Load, 0, 1], [ScoreOpKind.SumStore, 0, 0],
      [ScoreOpKind.Load, 0, 2], [ScoreOpKind.AccAddSum, 0, 0], [ScoreOpKind.Mul, 0, 0],
    ];
    expect(runScoreChain(ops, survey([[0, 1, 0x1000], [0, 2, 0x1000]]).tables)).toBe(0x1fff);
  });

  it('the prologue penalises military buildings and rewards warehouses', () => {
    const bare = runScoreChain(ATTACK_PROLOG_CHAIN, survey().tables);
    const fortified = runScoreChain(ATTACK_PROLOG_CHAIN, survey([[2, 27, 40], [1, 27, 40]]).tables);
    const stocked = runScoreChain(ATTACK_PROLOG_CHAIN, survey([[3, 15, 10], [2, 15, 10]]).tables);
    expect(fortified).toBeLessThan(bare);
    expect(stocked).toBeGreaterThan(bare);
  });

  it('the military penalty is clamped — it cannot push the score to 0', () => {
 // The three clamps 200/350/600 bound the penalty term; that is why a remainder survives even
 // with absurdly many fortresses around.
    const flooded = runScoreChain(ATTACK_PROLOG_CHAIN,
      survey([[0, 27, 9000], [1, 27, 9000], [2, 27, 9000]]).tables);
    expect(flooded).toBeGreaterThan(0);
  });

  it('eight ids start at the prologue — id 28 starts on the carried value', () => {
    const s = survey([[3, 11, 6], [2, 11, 6], [3, 13, 4], [3, 28, 3]]);
 // For every other id the carried value is irrelevant.
    expect(scoreAttackTarget(26, s, 0)).toBe(scoreAttackTarget(26, s, 0xffff));
    expect(scoreAttackTarget(33, s, 0)).toBe(scoreAttackTarget(33, s, 0xffff));
 // For 28 it is the start value — with 0 the result is necessarily 0.
    expect(scoreAttackTarget(AI_ATTACK_NO_PROLOG, s, 0)).toBe(0);
    expect(scoreAttackTarget(AI_ATTACK_NO_PROLOG, s, 0xffff)).toBeGreaterThan(0);
    expect(scoreAttackTarget(AI_ATTACK_NO_PROLOG, s, 0x8000))
      .toBeLessThan(scoreAttackTarget(AI_ATTACK_NO_PROLOG, s, 0xffff));
  });

  it('the four deposit ids each read their own soil-sample sign', () => {
    const signOf: Record<number, number> = { 31: 33, 32: 34, 33: 35, 34: 36 };
    for (const [id, sign] of Object.entries(signOf)) {
      const withSign = scoreAttackTarget(Number(id), survey([[3, sign, 20], [2, sign, 20]]), 0xffff);
      const without = scoreAttackTarget(Number(id), survey(), 0xffff);
      expect(withSign, `id ${id}`).toBeGreaterThan(without);
 // And the three foreign signs must do nothing.
      for (const other of [33, 34, 35, 36].filter((s) => s !== sign)) {
        expect(scoreAttackTarget(Number(id), survey([[3, other, 20]]), 0xffff), `${id}/${other}`)
          .toBe(without);
      }
    }
  });

  it('`scoreProject` stays 0 for the branch-B ids — they run through `scoreAttackTarget`', () => {
    for (let id = AI_ATTACK_FIRST; id < AI_ATTACK_FIRST + AI_ATTACK_COUNT; id++) {
      expect(scoreProject(id, survey([[3, 11, 9]]), { difficulty: 0 } as Player)).toBe(0);
    }
  });
});
