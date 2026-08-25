import { describe, it, expect } from 'vitest';
import {
  PROFESSION_IDLE_STATE,
  RECRUIT_CHAINS,
  SERF_CENSUS_SKIPPED_TYPE,
  collectFillLevels,
  professionAvailability,
  serfCensusTotal,
  stockTotals,
} from './stats.js';
import { FILL_RULES_FOOD, FILL_RULES_INDUSTRY, FILL_SLOTS_INDUSTRY } from '../stats-popup.js';
import type { Building, GameState, Inventory, Player, Serf } from './state.js';

function player(fields: Partial<Player> = {}): Player {
  return {
    slot: 0,
    heldPlanks: 0,
    heldStone: 0,
    serfCount: Array.from({ length: 27 }, () => 0),
    ...fields,
  } as unknown as Player;
}

function inventory(owner: number, res: Record<number, number>): Inventory {
  const resources = Array.from({ length: 26 }, () => 0);
  for (const [k, v] of Object.entries(res)) resources[Number(k)] = v;
  return { owner, resources } as unknown as Inventory;
}

function building(fields: Partial<Building> & { type: number }): Building {
  return {
    owner: 0,
    burning: false,
    constructing: false,
    holder: true,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
    stockMaximum: null,
    ...fields,
  } as unknown as Building;
}

function gameState(buildings: (Building | null)[], inventories: (Inventory | null)[]): GameState {
  return {
    header: { maxBuildingIndex: buildings.length },
    buildings,
    inventories,
  } as unknown as GameState;
}

describe('stats — warehouse totals (screen 0x09)', () => {
  it('sums only own warehouses and adds the parked building reserve', () => {
    const state = gameState(
      [],
      [
        null,
        inventory(0, { 7: 10, 9: 5 }),
        inventory(0, { 7: 3 }),
        inventory(1, { 7: 100 }), // fremd
      ],
    );
    const totals = stockTotals(state, player({ heldPlanks: 7, heldStone: 2 }));
    expect(totals[7]).toBe(10 + 3 + 7); // Bretter + Reserve
    expect(totals[9]).toBe(5 + 2); // Stein + Reserve
    expect(totals[12]).toBe(0);
  });

  it('klemmt bei 65535 statt umzulaufen', () => {
    const state = gameState(
      [],
      [inventory(0, { 0: 60000 }), inventory(0, { 0: 60000 })],
    );
    expect(stockTotals(state, player())[0]).toBe(0xffff);
  });
});

describe('stats — population (screen 0x12)', () => {
  it('skips exactly one entry', () => {
    const serfCount = Array.from({ length: 27 }, () => 1);
    expect(serfCensusTotal(player({ serfCount }))).toBe(26);
    expect(SERF_CENSUS_SKIPPED_TYPE).toBe(4);
    serfCount[SERF_CENSUS_SKIPPED_TYPE] = 99;
    expect(serfCensusTotal(player({ serfCount }))).toBe(26);
  });
});

describe('stats — fill levels (screens 0x10/0x11)', () => {
  it('counts only own, non-burning, finished buildings (screen 0x10)', () => {
    const mill = (fields: Partial<Building>) =>
      building({ type: 15, stock: [{ available: 3, requested: 1 }, { available: 0, requested: 0 }], ...fields });
    const state = gameState(
      [
        mill({}), //                        counts
        mill({ owner: 1 }), //              fremd
        mill({ burning: true }), //         brennt
        mill({ constructing: true }), //    Baustelle
        mill({ holder: false }), //         ohne Arbeiter
      ],
      [],
    );
    const slots = collectFillLevels(state, player(), FILL_RULES_FOOD, 12, true);
    // Only the first contributes: (0x31 & 0xf) + ((0x31 & 0xf0) >> 3) = 1 + 6 = 7.
    expect(slots[0]).toEqual({ sum: 7, count: 1 });
  });

  it('military gold: all three building kinds into one bucket, each with its own ceiling', () => {
    const gold = (type: number, amount: number) =>
      building({
        type,
        constructing: false,
        stock: [
          { available: 0, requested: 0 },
          { available: amount, requested: 0 },
        ],
      });
    // Hut (limit 2 => divisor 4) with 1 gold: ((1 << 4) << 4) / 4 = 64.
    const state = gameState([gold(11, 1)], []);
    const slots = collectFillLevels(state, player(), FILL_RULES_INDUSTRY, FILL_SLOTS_INDUSTRY, false);
    expect(slots[0x1e / 6]).toEqual({ sum: Math.floor(((1 << 4) >> 3) * 16 / 4), count: 1 });
    // Fortress (limit 8 => divisor 16) with the same gold gives a quarter of that.
    const state2 = gameState([gold(22, 1)], []);
    const s2 = collectFillLevels(state2, player(), FILL_RULES_INDUSTRY, FILL_SLOTS_INDUSTRY, false);
    expect(s2[0x1e / 6]!.sum).toBe(Math.floor(slots[0x1e / 6]!.sum / 4));
  });

  it('the gold buckets have NO worker gate, the supply buckets do', () => {
    const hut = building({
      type: 11,
      holder: false,
      stock: [
        { available: 0, requested: 0 },
        { available: 2, requested: 0 },
      ],
    });
    const smelter = building({
      type: 23,
      holder: false,
      stock: [
        { available: 4, requested: 0 },
        { available: 4, requested: 0 },
      ],
    });
    const state = gameState([hut, smelter], []);
    const slots = collectFillLevels(state, player(), FILL_RULES_INDUSTRY, FILL_SLOTS_INDUSTRY, false);
    expect(slots[0x1e / 6]!.count).toBe(1); // gold counts despite the missing worker
    expect(slots[0]!.count).toBe(0); //        gold ore supply does not
    expect(slots[1]!.count).toBe(0); //        coal supply does not
  });

  it('one building can contribute to two buckets', () => {
    const smelter = building({
      type: 18, // steel smelter: coal (bld+8) and iron ore (bld+9)
      stock: [
        { available: 2, requested: 0 },
        { available: 5, requested: 1 },
      ],
    });
    const state = gameState([smelter], []);
    const slots = collectFillLevels(state, player(), FILL_RULES_INDUSTRY, FILL_SLOTS_INDUSTRY, false);
    expect(slots[0x0c / 6]).toEqual({ sum: 4, count: 1 }); // (0x20 & 0xf) + (0x20 >> 3) = 0 + 4
    expect(slots[0x12 / 6]).toEqual({ sum: 11, count: 1 }); // (0x51 & 0xf) + (0x50 >> 3) = 1 + 10
  });
});

describe('stats — profession availability (screen 0x13)', () => {
  function serf(fields: { type: number; state: number; owner?: number }) {
    return { owner: 0, ...fields } as unknown as Serf;
  }
  function withSerfs(serfs: (Serf | null)[], invs: (Inventory | null)[] = []): GameState {
    return { header: { maxBuildingIndex: 0 }, buildings: [], serfs, inventories: invs } as unknown as GameState;
  }

  it('counts only idle serfs of the own player', () => {
    const state = withSerfs([
      null,
      serf({ type: 6, state: PROFESSION_IDLE_STATE }), //          counts
      serf({ type: 6, state: PROFESSION_IDLE_STATE }), //          counts
      serf({ type: 6, state: 2 }), //                              unterwegs
      serf({ type: 6, state: PROFESSION_IDLE_STATE, owner: 1 }), // fremd
    ]);
    expect(professionAvailability(state, player())[6]).toBe(2);
  });

  it('professions without a tool get the free serfs in full', () => {
    const state = withSerfs([], [inventory(0, {})]);
    (state.inventories[0] as unknown as { genericCount: number }).genericCount = 5;
    const avail = professionAvailability(state, player());
    for (const type of [0, 8, 10, 12, 15, 16]) expect(avail[type]).toBe(5);
    expect(avail[2]).toBe(0); // Planierer ohne Schaufel: nichts
  });

  it('clamps every profession to its tool, and two-tool professions to both', () => {
    // 5 free serfs, 2 hammers, 1 pincer, 3 saws.
    const inv = inventory(0, { 16: 2, 23: 1, 21: 3 });
    (inv as unknown as { genericCount: number }).genericCount = 5;
    const avail = professionAvailability(withSerfs([], [inv]), player());
    expect(avail[3]).toBe(2); //  Bauarbeiter: Hammer
    expect(avail[17]).toBe(2); // Bootsbauer:  Hammer
    expect(avail[20]).toBe(2); // Geologe:     Hammer
    expect(avail[19]).toBe(1); // Schmied:     Hammer UND Zange
    expect(avail[6]).toBe(3); //  sawmiller: saw
    expect(avail[18]).toBe(2); // toolmaker: saw AND hammer
  });

  it('knights need sword and shield; the smaller stock wins', () => {
    const inv = inventory(0, { 24: 4, 25: 2 });
    (inv as unknown as { genericCount: number }).genericCount = 9;
    expect(professionAvailability(withSerfs([], [inv]), player())[22]).toBe(2);
  });

  it('every chain restarts from the full stock (no cross-talk)', () => {
    // Without a hammer the scythe chain must not continue from 0.
    const inv = inventory(0, { 19: 7 });
    (inv as unknown as { genericCount: number }).genericCount = 7;
    const avail = professionAvailability(withSerfs([], [inv]), player());
    expect(avail[3]).toBe(0); //  Bauarbeiter ohne Hammer
    expect(avail[14]).toBe(7); // farmer with a scythe is full all the same
  });

  it('several warehouses add up, foreign ones do not', () => {
    const mine = inventory(0, { 20: 3 });
    (mine as unknown as { genericCount: number }).genericCount = 3;
    const other = inventory(1, { 20: 9 });
    (other as unknown as { genericCount: number }).genericCount = 9;
    expect(professionAvailability(withSerfs([], [mine, other]), player())[5]).toBe(3);
  });

  it('saturates at 65535 instead of wrapping', () => {
    const invs = Array.from({ length: 3 }, () => {
      const inv = inventory(0, { 20: 60000 });
      (inv as unknown as { genericCount: number }).genericCount = 60000;
      return inv;
    });
    expect(professionAvailability(withSerfs([], invs), player())[5]).toBe(0xffff);
  });

  it('the clamp chains cover every profession the display shows', () => {
    const covered = new Set<number>();
    for (const chain of RECRUIT_CHAINS) for (const step of chain) for (const t of step.types) covered.add(t);
    // All types 0..20 plus knight rank 0. Missing are type 4 (internal duplicate), 21 (generic) and
    // ranks 1..4, which come from promotion rather than recruitment.
    expect([...covered].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22,
    ]);
  });
});
