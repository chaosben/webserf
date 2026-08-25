import { describe, expect, it } from 'vitest';
import {
  AI_CANDIDATE_SLOTS,
  AI_MASK_NO_FLAG,
  AI_MASK_NO_MILITARY,
  AI_PROJECT_COUNT,
  AI_PROJECT_MASK,
  AI_SCORED_PROJECTS,
  aiProjectMask,
  aiRecordAttackTargets,
  aiRecordCandidate,
  aiScoreAndRecord,
} from './ai-candidates.js';
import { AI_ATTACK_COUNT, AI_ATTACK_FIRST, scoreAttackTarget } from './ai-score.js';
import { AI_SURVEY_SLOTS, AI_SURVEY_TABLES, type AiSurvey } from './ai-survey.js';
import type { Player } from './state.js';

function emptyCandidates(): { score: number; col: number; row: number }[][] {
  return Array.from({ length: AI_PROJECT_COUNT }, () =>
    Array.from({ length: AI_CANDIDATE_SLOTS }, () => ({ score: 0, col: 0, row: 0 })));
}

function player(over: Partial<Player> = {}): Player {
  return {
    build: 0, difficulty: 0, cursorCol: 4, cursorRow: 5,
    aiCandidates: emptyCandidates(), ...over,
  } as Player;
}

function survey(set: [number, number, number][] = []): AiSurvey {
  const tables: number[][] = [];
  for (let t = 0; t < AI_SURVEY_TABLES; t++) tables.push(new Array<number>(AI_SURVEY_SLOTS).fill(0));
  for (const [t, s, v] of set) (tables[t] as number[])[s] = v;
  return { tables } as AiSurvey;
}

describe('project mask (`@0x5c9d7`, index possibility - 1)', () => {
  it('possibility 1 allows only the flag, possibility 5 only the castle', () => {
    expect(aiProjectMask(player(), 1)).toBe(1);
    expect(aiProjectMask(player(), 5)).toBe(1 << 24);
  });

  it('possibility 2 allows the four mines (5..8) and the geologist (25)', () => {
    const mask = aiProjectMask(player(), 2);
    for (const mine of [5, 6, 7, 8]) expect(mask & (1 << mine), `mine ${mine}`).not.toBe(0);
    expect(mask & (1 << 25)).not.toBe(0);
    expect(mask & 1).toBe(0); // no flag in the mountains
  });

  it('`build` bit 0 (military locked) removes hut, tower and fortress', () => {
    const open = aiProjectMask(player({ build: 0 }), 4);
    const locked = aiProjectMask(player({ build: 1 }), 4);
    for (const military of [11, 21, 22]) {
      expect(open & (1 << military), `open ${military}`).not.toBe(0);
      expect(locked & (1 << military), `locked ${military}`).toBe(0);
    }
    // ...and ONLY those three — the rest stays untouched.
    expect((open & ~((1 << 11) | (1 << 21) | (1 << 22))) >>> 0).toBe(locked >>> 0);
  });

  it('`build` bit 1 removes the flag', () => {
    expect(aiProjectMask(player({ build: 2 }), 1)).toBe(0);
    expect(aiProjectMask(player({ build: 0 }), 1)).toBe(1);
  });

  it('the two locks are independent and combinable', () => {
    const both = aiProjectMask(player({ build: 3 }), 4);
    expect(both).toBe(((AI_PROJECT_MASK[3] as number) & AI_MASK_NO_MILITARY & AI_MASK_NO_FLAG) >>> 0);
  });

  it('an unknown possibility yields an empty mask (0 does not occur in branch A)', () => {
    expect(aiProjectMask(player(), 0)).toBe(0);
    expect(aiProjectMask(player(), 9)).toBe(0);
  });
});

describe('recorder `FUN_0005dcd0` — eight slots per project', () => {
  it('records into an empty slot', () => {
    const p = player();
    aiRecordCandidate(p, 7, 1234, 3, 9);
    const slots = p.aiCandidates[7] as { score: number; col: number; row: number }[];
    expect(slots.filter((s) => s.score === 1234 && s.col === 3 && s.row === 9)).toHaveLength(1);
  });

  it('overwrites an already known position — WITHOUT comparing scores', () => {
    const p = player();
    aiRecordCandidate(p, 7, 5000, 3, 9);
    aiRecordCandidate(p, 7, 10, 3, 9); // worse, and still taken
    const slots = p.aiCandidates[7] as { score: number; col: number; row: number }[];
    expect(slots.filter((s) => s.col === 3 && s.row === 9)).toHaveLength(1);
    expect(slots.find((s) => s.col === 3 && s.row === 9)?.score).toBe(10);
  });

  it('evicts the weakest slot when the list is full', () => {
    const p = player();
    const slots = p.aiCandidates[7] as { score: number; col: number; row: number }[];
    for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) {
      slots[i] = { score: 1000 + i * 10, col: 20 + i, row: 30 };
    }
    aiRecordCandidate(p, 7, 5000, 60, 61);
    expect(slots.some((s) => s.score === 1000 && s.col === 20)).toBe(false); // the weakest is gone
    expect(slots.filter((s) => s.score === 5000 && s.col === 60 && s.row === 61)).toHaveLength(1);
  });

  it('leaves the list untouched when the new score is weaker than all eight', () => {
    const p = player();
    const slots = p.aiCandidates[7] as { score: number; col: number; row: number }[];
    for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) slots[i] = { score: 9000, col: 20 + i, row: 30 };
    const before = JSON.stringify(slots);
    aiRecordCandidate(p, 7, 100, 60, 61);
    expect(JSON.stringify(slots)).toBe(before);
  });

  it('on a tie of the minimum the LATER slot wins (`jb`, not `jbe`)', () => {
    const p = player();
    const slots = p.aiCandidates[7] as { score: number; col: number; row: number }[];
    for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) slots[i] = { score: 700, col: 20 + i, row: 30 };
    aiRecordCandidate(p, 7, 700, 60, 61);
    expect(slots[AI_CANDIDATE_SLOTS - 1]).toEqual({ score: 700, col: 60, row: 61 });
    expect(slots[0]?.col).toBe(20);
  });

  it('records on a tie with the minimum (`>=`, not `>`)', () => {
    const p = player();
    const slots = p.aiCandidates[7] as { score: number; col: number; row: number }[];
    for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) slots[i] = { score: 700, col: 20 + i, row: 30 };
    aiRecordCandidate(p, 7, 699, 60, 61);
    expect(slots.some((s) => s.col === 60)).toBe(false);
  });

  it('keeps the project lists separate', () => {
    const p = player();
    aiRecordCandidate(p, 7, 1234, 3, 9);
    expect((p.aiCandidates[8] as { score: number }[]).every((s) => s.score === 0)).toBe(true);
  });
});

describe('cascade `FUN_0005d945`', () => {
  it('only records projects whose bit the mask sets', () => {
    const p = player({ cursorCol: 11, cursorRow: 12 });
    // Possibility 1 => only the flag. Empty surroundings => the flag gets 40000.
    const n = aiScoreAndRecord(p, survey(), 1);
    expect(n).toBe(1);
    const flags = p.aiCandidates[0] as { score: number; col: number; row: number }[];
    expect(flags.filter((s) => s.score === 40000 && s.col === 11 && s.row === 12)).toHaveLength(1);
    // No other project was touched.
    for (let pr = 1; pr < AI_PROJECT_COUNT; pr++) {
      expect((p.aiCandidates[pr] as { score: number }[]).every((s) => s.score === 0), `project ${pr}`)
        .toBe(true);
    }
  });

  it('does NOT record projects with score 0 — in unexplored mountains only the geologist', () => {
    const p = player();
    // Possibility 2 (mountains), empty surroundings: without a soil-sample sign every mine is worth
    // 0, while the GEOLOGIST is interesting precisely then. Exactly one record, and it is his.
    expect(aiScoreAndRecord(p, survey(), 2)).toBe(1);
    for (const mine of [5, 6, 7, 8]) {
      expect((p.aiCandidates[mine] as { score: number }[]).every((s) => s.score === 0), `mine ${mine}`)
        .toBe(true);
    }
    expect((p.aiCandidates[25] as { score: number }[]).some((s) => s.score > 0)).toBe(true);
  });

  it('and conversely: with an ore sign the mine becomes a candidate', () => {
    const p = player();
    // Slot 34 == the sign of project 7 (iron mine).
    const n = aiScoreAndRecord(p, survey([[3, 34, 8], [1, 15, 4]]), 2);
    expect(n).toBeGreaterThan(1);
    expect((p.aiCandidates[7] as { score: number }[]).some((s) => s.score > 0)).toBe(true);
  });

  it('uses the player cursor as the position, not a parameter', () => {
    const p = player({ cursorCol: 40, cursorRow: 41 });
    aiScoreAndRecord(p, survey(), 1);
    const flags = p.aiCandidates[0] as { col: number; row: number }[];
    expect(flags.some((s) => s.col === 40 && s.row === 41)).toBe(true);
  });

  it('walks exactly 26 projects — the branch-B ids stay empty', () => {
    const p = player();
    // A mask setting ALL bits may still only reach 0..25.
    const spy = player({ build: 0, cursorCol: 1, cursorRow: 2 });
    aiScoreAndRecord(spy, survey(), 1);
    expect(AI_SCORED_PROJECTS).toBe(26);
    for (let pr = AI_SCORED_PROJECTS; pr < AI_PROJECT_COUNT; pr++) {
      expect((p.aiCandidates[pr] as { score: number }[]).every((s) => s.score === 0)).toBe(true);
    }
  });

  it('is idempotent on the same spot — the recorder overwrites instead of multiplying', () => {
    const p = player({ cursorCol: 11, cursorRow: 12 });
    aiScoreAndRecord(p, survey(), 1);
    aiScoreAndRecord(p, survey(), 1);
    aiScoreAndRecord(p, survey(), 1);
    const flags = p.aiCandidates[0] as { score: number; col: number; row: number }[];
    expect(flags.filter((s) => s.col === 11 && s.row === 12)).toHaveLength(1);
  });
});

describe('branch B: the attack target dispatcher (`FUN_0005cc57`)', () => {
  /** A survey in which all nine target kinds find something. */
  function rich(): AiSurvey {
    const set: [number, number, number][] = [];
    for (const slot of [6, 7, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 28, 32, 33, 34, 35, 36]) {
      for (let t = 0; t < AI_SURVEY_TABLES; t++) set.push([t, slot, 3]);
    }
    return survey(set);
  }

  it('records into rows 26..34, each at most once', () => {
    const p = player({ cursorCol: 9, cursorRow: 8 });
    const n = aiRecordAttackTargets(p, rich());
    expect(n).toBeGreaterThan(0);
    for (let id = AI_ATTACK_FIRST; id < AI_ATTACK_FIRST + AI_ATTACK_COUNT; id++) {
      const filled = (p.aiCandidates[id] as { score: number; col: number; row: number }[])
        .filter((s) => s.score !== 0);
      expect(filled.length, `id ${id}`).toBeLessThanOrEqual(1);
      for (const s of filled) {
        expect(s.col).toBe(9);
        expect(s.row).toBe(8);
      }
    }
  });

  it('leaves the build-site rows 0..25 untouched — there is no project mask', () => {
    const p = player();
    aiRecordAttackTargets(p, rich());
    for (let pr = 0; pr < AI_SCORED_PROJECTS; pr++) {
      expect((p.aiCandidates[pr] as { score: number }[]).every((s) => s.score === 0), `project ${pr}`)
        .toBe(true);
    }
  });

  it('does NOT stop after one record — several ids get through in the same pass', () => {
    const p = player();
    const n = aiRecordAttackTargets(p, rich());
    expect(n).toBeGreaterThan(1);
  });

  it('id 28 hangs on the score of id 27 — not on data of its own', () => {
    // Feed only the gold chain (coal/gold/gold smelter). Id 27 additionally needs steel smelter,
    // toolmaker and wood — without those its score is small, but not 0.
    const goldOnly = survey([[3, 11, 5], [3, 13, 5], [3, 28, 5]]);
    const p = player();
    aiRecordAttackTargets(p, goldOnly);
    const s27 = (p.aiCandidates[27] as { score: number }[]).find((s) => s.score !== 0)?.score ?? 0;
    const s28 = (p.aiCandidates[28] as { score: number }[]).find((s) => s.score !== 0)?.score ?? 0;
    // For 28 the port records exactly `scoreAttackTarget(28, ..., s27)`.
    expect(s28).toBe(scoreAttackTarget(28, goldOnly, s27));
    // And with the value a prologue call would have set it would be a different one.
    expect(s28).not.toBe(scoreAttackTarget(28, goldOnly, 0xffff));
  });

  it('is idempotent on the same spot', () => {
    const p = player({ cursorCol: 3, cursorRow: 3 });
    aiRecordAttackTargets(p, rich());
    aiRecordAttackTargets(p, rich());
    for (let id = AI_ATTACK_FIRST; id < AI_ATTACK_FIRST + AI_ATTACK_COUNT; id++) {
      const filled = (p.aiCandidates[id] as { score: number }[]).filter((s) => s.score !== 0);
      expect(filled.length, `id ${id}`).toBeLessThanOrEqual(1);
    }
  });
});
