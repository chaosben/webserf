import { describe, it, expect } from 'vitest';
import {
  updateKnightMorale,
  updateAllKnightMorale,
  MORALE_BASE,
  MORALE_NO_GOLD,
} from './knight-morale.js';
import type { GameState, Player } from './state.js';

/**
 * `update_knight_morale` (@0x11793) - the special cases that do not occur in real saves, above all
 * the castle balance, which is 0 everywhere there.
 */

function makeState(
  over: {
    stockGold?: number;
    militaryGold?: number;
    mapGoldTotal?: number;
    moraleFactor?: number;
    castleBalance?: number;
    ownScore?: number;
    otherScore?: number;
  } = {},
): { state: GameState; player: Player; other: Player } {
  const mk = (slot: number, score: number, balance: number): Player =>
    ({
      slot,
      active: true,
      goldAccumulator: 0,
      militaryGoldAccumulator: 0,
      militaryGoldCapacity: 0,
      goldDeposited: 0,
      goldMorale: 0,
      militaryStrengthRatio: 0,
      castleCaptureBalance: balance,
      totalMilitaryScore: score,
    }) as unknown as Player;

  const player = mk(0, over.ownScore ?? 100, over.castleBalance ?? 0);
  player.goldAccumulator = over.stockGold ?? 0;
  player.militaryGoldAccumulator = over.militaryGold ?? 0;
  player.militaryGoldCapacity = 7;
  const other = mk(1, over.otherScore ?? 100, 0);

  const state = {
    header: {
      mapGoldTotal: over.mapGoldTotal ?? 1000,
      mapGoldMoraleFactor: over.moraleFactor ?? 20460,
    },
    players: [player, other, null, null],
  } as unknown as GameState;
  return { state, player, other };
}

describe('update_knight_morale — goldDeposited', () => {
  it('sums warehouse and military gold', () => {
    const { state, player } = makeState({ stockGold: 250, militaryGold: 19 });
    updateKnightMorale(state, player);
    expect(player.goldDeposited).toBe(269);
  });

  it('clamps at 0xffff (`cmpl $0x10000` @0x117ae)', () => {
    const { state, player } = makeState({ stockGold: 0x20000, militaryGold: 5 });
    updateKnightMorale(state, player);
    expect(player.goldDeposited).toBe(0xffff);
  });
});

describe('update_knight_morale — goldMorale', () => {
  it('is a fixed 0x1000 when the map has no gold', () => {
    const { state, player } = makeState({ mapGoldTotal: 0, stockGold: 5 });
    updateKnightMorale(state, player);
    expect(player.goldMorale).toBe(MORALE_NO_GOLD);
  });

  it('is the bare base 1024 without own gold', () => {
    const { state, player } = makeState({ stockGold: 0, militaryGold: 0 });
    updateKnightMorale(state, player);
    expect(player.goldMorale).toBe(MORALE_BASE);
  });

  it('reproduces a real save: 18 of 1868 at factor 20480 => 1221', () => {
    const { state, player } = makeState({
      militaryGold: 18,
      mapGoldTotal: 1868,
      moraleFactor: 20480,
    });
    updateKnightMorale(state, player);
    expect(player.goldDeposited).toBe(18);
    expect(player.goldMorale).toBe(1221);
  });

  it('caps the share: more gold than the map holds changes nothing', () => {
    const a = makeState({ stockGold: 1000, mapGoldTotal: 1000, moraleFactor: 20480 });
    updateKnightMorale(a.state, a.player);
    const b = makeState({ stockGold: 5000, mapGoldTotal: 1000, moraleFactor: 20480 });
    updateKnightMorale(b.state, b.player);
    expect(b.player.goldMorale).toBe(a.player.goldMorale);
    // The ceiling is NOT 0x1000 - that is the no-gold-on-the-map special case. With the real factor
    // 20480 the maximum is around `1024 + 20480`.
    expect(a.player.goldMorale).toBeGreaterThan(MORALE_NO_GOLD);
    expect(a.player.goldMorale).toBeLessThanOrEqual(MORALE_BASE + 20480);
  });
});

describe('update_knight_morale: castle balance (0 in every real save)', () => {
  it('raises morale by 1024 per captured castle', () => {
    const a = makeState({ castleBalance: 0 });
    updateKnightMorale(a.state, a.player);
    const b = makeState({ castleBalance: 2 });
    updateKnightMorale(b.state, b.player);
    expect(b.player.goldMorale).toBe(a.player.goldMorale + 2 * 1024);
  });

  it('clamps the bonus at 0xffff on overflow', () => {
    const { state, player } = makeState({ castleBalance: 60, stockGold: 900, mapGoldTotal: 1000 });
    updateKnightMorale(state, player);
    expect(player.goldMorale).toBe(0xffff);
  });

  it('zieht bei verlorenem Schloss 0x3ff ab', () => {
    const a = makeState({ castleBalance: 0, stockGold: 900, mapGoldTotal: 1000 });
    updateKnightMorale(a.state, a.player);
    const b = makeState({ castleBalance: -1, stockGold: 900, mapGoldTotal: 1000 });
    updateKnightMorale(b.state, b.player);
    expect(b.player.goldMorale).toBe(a.player.goldMorale - 0x3ff);
  });

  it('does not drop below 1 on deduction (not to 0)', () => {
    const { state, player } = makeState({ castleBalance: -1, stockGold: 0, mapGoldTotal: 1000 });
    updateKnightMorale(state, player);
    expect(player.goldMorale).toBe(1); // 0x400 − 0x3ff = 1, aber auch bei Unterlauf bleibt es 1
  });
});

describe('update_knight_morale: strength ratio', () => {
  it('is 0 without an own military score', () => {
    const { state, player } = makeState({ ownScore: 0 });
    updateKnightMorale(state, player);
    expect(player.militaryStrengthRatio).toBe(0);
  });

  it('is 0 without opponents', () => {
    const { state, player } = makeState({ otherScore: 0 });
    updateKnightMorale(state, player);
    expect(player.militaryStrengthRatio).toBe(0);
  });

  it('is 0xffff on clear superiority', () => {
    const { state, player } = makeState({ ownScore: 5000, otherScore: 10, stockGold: 900 });
    updateKnightMorale(state, player);
    expect(player.militaryStrengthRatio).toBe(0xffff);
  });

  it('grows with the own score', () => {
    const a = makeState({ ownScore: 100, otherScore: 400, stockGold: 500 });
    updateKnightMorale(a.state, a.player);
    const b = makeState({ ownScore: 200, otherScore: 400, stockGold: 500 });
    updateKnightMorale(b.state, b.player);
    expect(b.player.militaryStrengthRatio).toBeGreaterThan(a.player.militaryStrengthRatio);
  });
});

describe('update_knight_morale — Reset', () => {
  it('nullt alle drei Akkumulatoren', () => {
    const { state, player } = makeState({ stockGold: 42, militaryGold: 7 });
    updateKnightMorale(state, player);
    expect(player.goldAccumulator).toBe(0);
    expect(player.militaryGoldAccumulator).toBe(0);
    expect(player.militaryGoldCapacity).toBe(0);
  });

  it('a second pass without new inflow yields the base morale', () => {
    const { state, player } = makeState({ stockGold: 500, mapGoldTotal: 1000 });
    updateKnightMorale(state, player);
    const first = player.goldMorale;
    updateKnightMorale(state, player);
    expect(first).toBeGreaterThan(MORALE_BASE);
    expect(player.goldMorale).toBe(MORALE_BASE);
    expect(player.goldDeposited).toBe(0);
  });

  it('runs over all occupied player slots', () => {
    const { state, player, other } = makeState({ stockGold: 8 });
    other.goldAccumulator = 3;
    updateAllKnightMorale(state);
    expect(player.goldDeposited).toBe(8);
    expect(other.goldDeposited).toBe(3);
  });
});
