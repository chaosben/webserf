import { describe, expect, it } from 'vitest';
import {
  AI_CATCHUP_LIMIT,
  AI_CATCHUP_MASK,
  AI_PRESSURE_COUNT,
  AI_PRESSURE_SHIFT,
  aiPressurePlayer,
  aiPressureTick,
} from './ai-pressure.js';
import type { GameState, Player } from './state.js';

function player(over: Partial<Player> = {}): Player {
  return {
    flags: 0xc0, // KI + aktiv
    totalLandScore: 0,
    totalBuildingScore: 0,
    aiPressure: new Array<number>(AI_PRESSURE_COUNT).fill(0),
    aiPressureCatchUp: 0,
    ...over,
  } as Player;
}

describe('build pressure counters', () => {
  it('grow per interval by their own rate, at DIFFERENT speeds', () => {
    const p = player();
    aiPressurePlayer(p, 400);
    // Rate x2 (counter 10 == hut) against x1/16 (counter 2 == boatbuilder).
    expect(p.aiPressure[10]).toBe(800);
    expect(p.aiPressure[2]).toBe(25);
    expect(p.aiPressure[4]).toBe(200); // ×1/2
    expect(p.aiPressure[1]).toBe(100); // ×1/4
    expect(p.aiPressure[0]).toBe(50); // ×1/8
  });

  it('saturate at 0xffff instead of overflowing', () => {
    const p = player({ aiPressure: new Array<number>(AI_PRESSURE_COUNT).fill(0xfff0) });
    aiPressurePlayer(p, 400);
    expect(p.aiPressure.every((v) => v === 0xffff)).toBe(true);
  });

  it('saturate exactly, not one step early', () => {
    const p = player({ aiPressure: new Array<number>(AI_PRESSURE_COUNT).fill(0) });
    (p.aiPressure as number[])[0] = 0xffff - 50; // counter 0 has rate x1/8 => +50
    aiPressurePlayer(p, 400);
    expect(p.aiPressure[0]).toBe(0xffff);
  });

  it('the doubling is 16-bit (`add %ax,%ax` in the original)', () => {
    const p = player();
    aiPressurePlayer(p, 0x9000); // x2 overflows: 0x12000 & 0xffff == 0x2000
    expect(p.aiPressure[10]).toBe(0x2000);
  });

  it('the halving cascade truncates step by step, not in one go', () => {
    const p = player();
    // 31 >> 1 == 15, >> 1 == 7, >> 1 == 3, >> 1 == 1 — dieselbe Folge wie im Original.
    aiPressurePlayer(p, 31);
    expect(p.aiPressure[4]).toBe(15); // ×1/2
    expect(p.aiPressure[1]).toBe(7); // ×1/4
    expect(p.aiPressure[0]).toBe(3); // ×1/8
    expect(p.aiPressure[2]).toBe(1); // ×1/16
  });

  it('the rate table has 25 entries and several distinct values', () => {
    expect(AI_PRESSURE_SHIFT).toHaveLength(AI_PRESSURE_COUNT);
    expect(new Set(AI_PRESSURE_SHIFT).size).toBeGreaterThanOrEqual(4);
  });
});

describe('Das Tor: nur KI-Spieler, nur aktive Slots', () => {
  it('leaves a human player untouched', () => {
    const p = player({ flags: 0x40 }); // active but not AI
    aiPressurePlayer(p, 400);
    expect(p.aiPressure.every((v) => v === 0)).toBe(true);
  });

  it('leaves an inactive AI slot untouched', () => {
    const p = player({ flags: 0x80 }); // AI bit but not active
    aiPressurePlayer(p, 400);
    expect(p.aiPressure.every((v) => v === 0)).toBe(true);
  });
});

describe('Nachhol-Druck', () => {
  it('decays by the interval length and clamps at 0 on underflow', () => {
    const p = player({ aiPressureCatchUp: 1000 });
    aiPressurePlayer(p, 400);
    expect(p.aiPressureCatchUp).toBe(600);
    aiPressurePlayer(p, 5000);
    expect(p.aiPressureCatchUp).toBe(0);
  });

  it('stays at the decayed value without a building score (no division by 0)', () => {
    const p = player({ aiPressureCatchUp: 1000, totalBuildingScore: 0, totalLandScore: 500 });
    aiPressurePlayer(p, 400);
    expect(p.aiPressureCatchUp).toBe(600);
  });

  it('rises on DENSELY built land (little land per building score), not the other way round', () => {
    // The direction is the opposite of the intuitive one: `q = land*128/buildings` is large with a
    // lot of land, and `q ^ 0x3ff` turns that into a small value. This test caught the wrong
    // Deutung im ersten Modul-Kopf aufgedeckt.
    const dicht = player({ totalLandScore: 1000, totalBuildingScore: 900 });
    const weitlaeufig = player({ totalLandScore: 1000, totalBuildingScore: 200 });
    aiPressurePlayer(dicht, 10);
    aiPressurePlayer(weitlaeufig, 10);
    expect(dicht.aiPressureCatchUp).toBeGreaterThan(weitlaeufig.aiPressureCatchUp);
  });

  it('stops applying once the quotient reaches the limit', () => {
    // q = (land << 7) / building >= 0x400 => no raise.
    const land = 1000;
    const building = Math.floor((land << 7) / AI_CATCHUP_LIMIT); // q exactly at the limit
    const p = player({ totalLandScore: land, totalBuildingScore: building });
    aiPressurePlayer(p, 0);
    expect(p.aiPressureCatchUp).toBe(0);
  });

  it('is only RAISED, never lowered', () => {
    // A high old value the computation does not reach survives. That needs a LARGE q (much land per
    // building): q == 1000 => (1000 ^ 1023) << 6 == 1472, far below the old value.
    const p = player({ aiPressureCatchUp: 0xff00, totalLandScore: 1000, totalBuildingScore: 128 });
    aiPressurePlayer(p, 0);
    expect(p.aiPressureCatchUp).toBe(0xff00);
  });

  it('the inversion is a XOR over 10 bits, not a negation', () => {
    // With q == 0 (no land) the value is (0 ^ 0x3ff) << 6 == the top of the scale.
    const p = player({ totalLandScore: 0, totalBuildingScore: 100 });
    aiPressurePlayer(p, 0);
    expect(p.aiPressureCatchUp).toBe((AI_CATCHUP_MASK << 6) & 0xffff);
  });
});

describe('the head closes the interval', () => {
  function state(players: (Player | null)[]): GameState {
    return { players, aiPressureAccum: 0, aiPressureLast: 0 } as GameState;
  }

  it('saves the interval length and clears the accumulator', () => {
    const st = state([player(), null, null, null]);
    st.aiPressureAccum = 777;
    aiPressureTick(st);
    expect(st.aiPressureLast).toBe(777);
    expect(st.aiPressureAccum).toBe(0);
  });

  it('computes with the SAVED length, not the newly started one', () => {
    const p = player();
    const st = state([p, null, null, null]);
    st.aiPressureAccum = 400;
    aiPressureTick(st);
    expect(p.aiPressure[4]).toBe(200); // 400 >> 1
    // A second pass without new accumulator growth adds nothing.
    aiPressureTick(st);
    expect(p.aiPressure[4]).toBe(200);
  });

  it('runs over all four slots', () => {
    const ps = [player(), player(), player(), player()];
    const st = state(ps);
    st.aiPressureAccum = 400;
    aiPressureTick(st);
    for (const p of ps) expect(p.aiPressure[4]).toBe(200);
  });
});
