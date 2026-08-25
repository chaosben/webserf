import { describe, it, expect } from 'vitest';
import {
  HUMAN_FACE,
  SETUP_OPPONENT_FACES,
  HUMAN_FACE_2,
  playerFaces,
  setupRecordIndex,
} from './player-setup.js';

const header = (gameType: number, mission: number, level: number) => ({
  gameType,
  missionSetupIndex: mission,
  levelSetupIndex: level,
});

describe('player-setup — Setup-Record-Index', () => {
  it('game type 0 computes with +5, everything else with -1', () => {
    expect(setupRecordIndex(0, 99, 30)).toBe(35); // @124 + 5, the other field stays a leftover
    expect(setupRecordIndex(0, 99, 1)).toBe(6);
    expect(setupRecordIndex(1, 1, 99)).toBe(0); //  @122 − 1
    expect(setupRecordIndex(2, 12, 99)).toBe(11);
  });
});

describe('player-setup — Gesichter', () => {
  it('the human always has the same face', () => {
    expect(HUMAN_FACE).toBe(0x0c);
    for (const level of [1, 15, 30]) expect(playerFaces(header(0, 0, level))[0]).toBe(HUMAN_FACE);
  });

  it('returns the opponents of the record; 0 means "slot empty"', () => {
    // Record 11 (Spieltyp 0, Level 6): drei Spieler.
    expect(playerFaces(header(0, 0, 6))).toEqual([0x0c, 3, 5, 0]);
    // record 35 (level 30): one opponent.
    expect(playerFaces(header(0, 0, 30))).toEqual([0x0c, 11, 0, 0]);
    // Record 0 (game type 1, mission 1): no opponent.
    expect(playerFaces(header(1, 1, 0))).toEqual([0x0c, 0, 0, 0]);
  });

  it('outside the table nothing is known — four `null`, no invented face', () => {
    expect(playerFaces(header(0, 0, 999))).toEqual([null, null, null, null]);
    expect(playerFaces(header(1, 0, 0))).toEqual([null, null, null, null]); // Index −1
  });

  // --- free play: the faces come from the menu columns (`.DS`@144) ----------------------------

  const menu = {
    face: [3, 5, 7, 9] as const,
    intelligence: [0, 0, 0, 0] as const,
    supply: [0, 0, 0, 0] as const,
    reproduction: [0, 0, 0, 0] as const,
    humanSupply: [0, 0] as const,
    humanReproduction: [0, 0] as const,
  };
  const freeHeader = (gameType: number) => ({ ...header(gameType, 0, 0), menuSetup: menu });

  it('demo (game type 4) takes ALL FOUR slots from the menu — there is no human', () => {
    expect(playerFaces(freeHeader(4))).toEqual([3, 5, 7, 9]);
  });

  it('free play with one human sets slot 0 to the literal 0x0c', () => {
    expect(playerFaces(freeHeader(2))).toEqual([HUMAN_FACE, 5, 7, 9]);
  });

  it('two humans (game type 3): slot 0 and slot 1 are literals', () => {
    expect(playerFaces(freeHeader(3))).toEqual([HUMAN_FACE, HUMAN_FACE_2, 7, 9]);
  });

  it('without `menuSetup` NOTHING is guessed — not even the setup record', () => {
    // The bug: without the menu branch a free game fell back to `missionSetupIndex - 1` and showed
    // the opponents of a campaign mission it is not playing at all.
    expect(playerFaces(header(4, 1, 1))).toEqual([null, null, null, null]);
  });

  it('occupied slots are always a prefix, and the opponent numbers rise', () => {
    // Structural property of the table: no hole (a 0 before a non-0) — that is what allows reading
    // "face != 0" as slot occupancy, the way the original does.
    for (const [i, row] of SETUP_OPPONENT_FACES.entries()) {
      for (let k = 0; k < 2; k++) {
        if (row[k] === 0) expect(row.slice(k + 1), `Record ${i}`).toEqual([0, 0].slice(0, 2 - k));
        else if (row[k + 1] !== 0) expect(row[k + 1]!, `Record ${i}`).toBeGreaterThan(row[k]!);
      }
    }
  });

  it('the table covers both index branches', () => {
    expect(SETUP_OPPONENT_FACES).toHaveLength(36); // Mission 1..30 → 0..29, Level 1..30 → 6..35
    // The first six records have no opponents.
    expect(SETUP_OPPONENT_FACES.slice(0, 6).every((r) => r.every((v) => v === 0))).toBe(true);
    // Opponent numbers are 1..11 — eleven characters besides the human (0x0c).
    const numbers = [...new Set(SETUP_OPPONENT_FACES.flat().filter((v) => v !== 0))].sort(
      (a, b) => a - b,
    );
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(Math.max(...numbers)).toBeLessThan(HUMAN_FACE);
  });
});
