import { describe, it, expect } from 'vitest';
import {
  AI_IDLE_SERF_SLOTS,
  AI_STOCKPILE_SLOTS,
  AI_SUPPLY_SLOTS,
  SUPPLY_CAP_DEFAULT,
  SUPPLY_CAP_HUT,
  SUPPLY_CAP_TOWER,
  SUPPLY_SLOT_SITE_PLANKS,
  SUPPLY_SLOT_SITE_STONES,
  SUPPLY_TABLE,
  aiCensus,
  supplyOfStock,
  supplyRatio,
} from './ai-census.js';
import { AI_URGENCY_SLOTS } from './ai-decide.js';
import type { Building, GameState, Inventory, Player, Serf } from './state.js';

/**
 * The AI census (`FUN_0005ba0c`) — the parts testable with synthetic data: the two formulas, the
 * three passes and the special cases.
 */
const geo = { cols: 64, rows: 64, tileCount: 4096, colShift: 6, rowShift: 6 };

function player(over: Partial<Player> = {}): Player {
  return {
    slot: 0,
    index: 0,
    heldPlanks: 0,
    heldStone: 0,
    aiSupplyRatio: new Array(AI_SUPPLY_SLOTS).fill(0),
    aiIdleSerfs: new Array(AI_IDLE_SERF_SLOTS).fill(0),
    aiStockpile: new Array(AI_STOCKPILE_SLOTS).fill(0),
    aiUrgency: new Array(AI_URGENCY_SLOTS).fill(0),
    ...over,
  } as unknown as Player;
}

function building(over: Partial<Building> = {}): Building {
  return {
    index: 1,
    owner: 0,
    type: 6, // Kohlebergwerk — Slot 2, Stock-Byte 8
    constructing: false,
    stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
    stockMaximum: null,
    ...over,
  } as unknown as Building;
}

function state(over: Partial<GameState> = {}): GameState {
  return {
    geo,
    buildings: [null],
    serfs: [null],
    inventories: [null],
    players: [player()],
    ...over,
  } as unknown as GameState;
}

describe('ai census: the two formulas', () => {
  it('supply counts present goods twice and requested ones once (>> 3, not >> 4)', () => {
    expect(supplyOfStock(0, 0)).toBe(0);
    expect(supplyOfStock(0, 3)).toBe(3); // requested only
    expect(supplyOfStock(3, 0)).toBe(6); // present only => doubled
    expect(supplyOfStock(2, 1)).toBe(5);
    expect(supplyOfStock(8, 0)).toBe(16); // a full stock == the default capacity
  });

  it('equality yields 0xffff, which also covers 0/0', () => {
    // Necessary, not convenient: 65536 does not fit into 16 bits.
    expect(supplyRatio(16, 16)).toBe(0xffff);
    expect(supplyRatio(0, 0)).toBe(0xffff);
  });

  it('otherwise a 16-bit fraction', () => {
    expect(supplyRatio(1, 16)).toBe(4096); // 1/16
    expect(supplyRatio(5, 16)).toBe(20480); // 5/16
    expect(supplyRatio(8, 16)).toBe(32768); // 1/2
    expect(supplyRatio(1, 3)).toBe(21845); // truncated like `div`
  });

  it('the three capacities are twice the military gold capacities 2/4/8', () => {
    expect(SUPPLY_CAP_HUT).toBe(4);
    expect(SUPPLY_CAP_TOWER).toBe(8);
    expect(SUPPLY_CAP_DEFAULT).toBe(16);
  });
});

describe('ai census: the type table', () => {
  it('covers 17 types with 21 contributions; the primary producers contribute nothing', () => {
    const types = SUPPLY_TABLE.map((c, t) => [t, c.length] as const).filter(([, n]) => n > 0);
    expect(types).toHaveLength(17);
    expect(SUPPLY_TABLE.reduce((s, c) => s + c.length, 0)).toBe(21);
    // Fisher(1)/lumberjack(2)/stonecutter(4)/forester(9)/farm(12) have no input goods;
    // warehouse(10) and castle(24) are not consumers.
    for (const t of [0, 1, 2, 4, 9, 10, 12, 24]) expect(SUPPLY_TABLE[t]).toHaveLength(0);
  });

  it('the four double-slot types take stock byte 8 first, then 9', () => {
    for (const t of [18, 19, 20, 23]) {
      const c = SUPPLY_TABLE[t]!;
      expect(c).toHaveLength(2);
      expect(c[0]!.stock).toBe(8);
      expect(c[1]!.stock).toBe(9);
    }
  });

  it('hut, tower and fortress share slot 5 but not the capacity', () => {
    expect(SUPPLY_TABLE[11]![0]).toEqual({ slot: 5, stock: 9, capacity: SUPPLY_CAP_HUT });
    expect(SUPPLY_TABLE[21]![0]).toEqual({ slot: 5, stock: 9, capacity: SUPPLY_CAP_TOWER });
    expect(SUPPLY_TABLE[22]![0]).toEqual({ slot: 5, stock: 9, capacity: SUPPLY_CAP_DEFAULT });
  });
});

describe('ai census: the building pass', () => {
  it('a fully stocked mine yields 0xffff, an empty one 0', () => {
    const p = player();
    const full = state({
      players: [p],
      buildings: [null, building({ stock: [{ available: 8, requested: 0 }, { available: 0, requested: 0 }] })],
    });
    aiCensus(full, p);
    expect(p.aiSupplyRatio[2]).toBe(0xffff);

    const p2 = player();
    const empty = state({ players: [p2], buildings: [null, building()] });
    aiCensus(empty, p2);
    expect(p2.aiSupplyRatio[2]).toBe(0);
  });

  it('with no building of that group it is 0xffff (0/0), not 0', () => {
    const p = player();
    aiCensus(state({ players: [p] }), p);
    expect(p.aiSupplyRatio.every((v) => v === 0xffff)).toBe(true);
  });

  it('foreign buildings do not count', () => {
    const p = player();
    aiCensus(state({
      players: [p],
      buildings: [null, building({ owner: 1, stock: [{ available: 8, requested: 0 }, { available: 0, requested: 0 }] })],
    }), p);
    expect(p.aiSupplyRatio[2]).toBe(0xffff); // 0/0, not 8/8
  });

  it('two buildings of the same group sum both sides', () => {
    const p = player();
    aiCensus(state({
      players: [p],
      buildings: [
        null,
        building({ stock: [{ available: 8, requested: 0 }, { available: 0, requested: 0 }] }),
        building({ index: 2, stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }] }),
      ],
    }), p);
    expect(p.aiSupplyRatio[2]).toBe(supplyRatio(16, 32)); // 32768 == half supplied
  });

  it('a building site lands in slots 19/20, with capacity from the stock maxima', () => {
    const p = player();
    aiCensus(state({
      players: [p],
      buildings: [null, building({
        constructing: true,
        type: 11, // the type is irrelevant in the construction branch: there is no dispatcher
        stock: [{ available: 2, requested: 1 }, { available: 0, requested: 0 }],
        stockMaximum: [4, 3],
      })],
    }), p);
    expect(p.aiSupplyRatio[SUPPLY_SLOT_SITE_PLANKS]).toBe(supplyRatio(5, 8)); // (1 + 2·2) / (2·4)
    expect(p.aiSupplyRatio[SUPPLY_SLOT_SITE_STONES]).toBe(supplyRatio(0, 6));
    // ...and NOT in slot 5, even though the type is a hut.
    expect(p.aiSupplyRatio[5]).toBe(0xffff);
  });
});

describe('ai census: serf and goods passes', () => {
  const serf = (over: Partial<Serf> = {}): Serf =>
    ({ index: 1, owner: 0, type: 5, state: 1, ...over }) as unknown as Serf;

  it('counts only own serfs in state IdleInStock, by type', () => {
    const p = player();
    aiCensus(state({
      players: [p],
      serfs: [
        null,
        serf({ type: 5 }),
        serf({ index: 2, type: 5 }),
        serf({ index: 3, type: 9 }),
        serf({ index: 4, type: 5, state: 2 }), // other state
        serf({ index: 5, type: 5, owner: 1 }), // foreign
      ],
    }), p);
    expect(p.aiIdleSerfs[5]).toBe(2);
    expect(p.aiIdleSerfs[9]).toBe(1);
    expect(p.aiIdleSerfs.reduce((a, b) => a + b, 0)).toBe(3);
  });

  const inv = (resources: number[], owner = 0): Inventory =>
    ({ index: 1, owner, resources } as unknown as Inventory);

  it('sums the goods over all own inventories', () => {
    const p = player();
    const a = new Array(26).fill(0); a[3] = 10;
    const b = new Array(26).fill(0); b[3] = 5; b[20] = 7;
    aiCensus(state({
      players: [p],
      inventories: [null, inv(a), inv(b), inv(new Array(26).fill(99), 1)],
    }), p);
    expect(p.aiStockpile[3]).toBe(15);
    expect(p.aiStockpile[20]).toBe(7);
    expect(p.aiStockpile[0]).toBe(0); // the foreign inventory does not count
  });

  it('saturates at 0xffff instead of wrapping', () => {
    const p = player();
    const big = new Array(26).fill(0); big[1] = 60000;
    aiCensus(state({ players: [p], inventories: [null, inv(big), inv(big)] }), p);
    expect(p.aiStockpile[1]).toBe(0xffff);
  });

  // The two stores @0x5c258/@0x5c26d add onto `player+0x3d0`, the cursor left behind by the 26
  // clearing rounds, i.e. onto the URGENCY table, not onto the stockpile.
  it('the parked building reserve goes into the urgency, NOT into the stockpile', () => {
    const p = player({ heldPlanks: 7, heldStone: 2 });
    const res = new Array(26).fill(0); res[7] = 3;
    aiCensus(state({ players: [p], inventories: [null, inv(res)] }), p);
    expect(p.aiStockpile[7]).toBe(3); // the warehouse only
    expect(p.aiStockpile[9]).toBe(0);
    expect(p.aiUrgency[7]).toBe(7); // @0x5c258 `add %ax,0xe(%ebx)`
    expect(p.aiUrgency[9]).toBe(2); // @0x5c26d `add %ax,0x12(%ebx)`
  });

  it('the reserve addition is an `add`, not a `mov`: it sums onto the old value', () => {
    const p = player({ heldPlanks: 7, heldStone: 2 });
    p.aiUrgency[7] = 100;
    p.aiUrgency[9] = 4095;
    aiCensus(state({ players: [p], inventories: [null] }), p);
    expect(p.aiUrgency[7]).toBe(107);
    expect(p.aiUrgency[9]).toBe(4097);
  });
});
