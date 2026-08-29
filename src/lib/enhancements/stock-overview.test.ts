import { describe, it, expect } from 'vitest';
import {
  GOOD_SLOTS,
  SERF_SLOTS,
  STOCK_GOODS_DEFAULT,
  STOCK_REFRESH_MS,
  STOCK_SERFS_DEFAULT,
  buildStockView,
  idleInStock,
  maskHas,
  maskOf,
  maskToggled,
  STOCK_PER_ROW_DEFAULT,
  STOCK_PER_ROW_MAX,
  STOCK_PER_ROW_MIN,
  stockRefreshDue,
  type StockSelection,
} from './stock-overview.js';
import { GOOD_ORDER } from './ui-icons.js';
import type { GameState, Inventory, Player, Serf } from '../core/engine/state.js';

function player(slot = 0, fields: Partial<Player> = {}): Player {
  return { slot, heldPlanks: 0, heldStone: 0, ...fields } as unknown as Player;
}

function inventory(owner: number, res: Record<number, number>, genericCount = 0): Inventory {
  const resources = Array.from({ length: 26 }, () => 0);
  for (const [k, v] of Object.entries(res)) resources[Number(k)] = v;
  return { owner, resources, genericCount } as unknown as Inventory;
}

function serf(owner: number, type: number, state: number): Serf {
  return { owner, type, state } as unknown as Serf;
}

function gameState(serfs: (Serf | null)[], inventories: (Inventory | null)[]): GameState {
  return { serfs, inventories } as unknown as GameState;
}

const sel = (fields: Partial<StockSelection> = {}): StockSelection => ({
  goods: 0,
  serfs: 0,
  mode: 'idle',
  ...fields,
});

describe('selection masks', () => {
  it('round-trip: what goes in comes out', () => {
    const m = maskOf([0, 7, 25]);
    expect([...Array(26).keys()].filter((i) => maskHas(m, i))).toEqual([0, 7, 25]);
    expect(maskOf([])).toBe(0);
  });

  it('toggling twice is the identity', () => {
    const m = maskOf([3]);
    expect(maskToggled(maskToggled(m, 9), 9)).toBe(m);
    expect(maskHas(maskToggled(m, 3), 3)).toBe(false);
  });

  /**
   * `1 << i` is a SIGNED shift: beyond 30 slots the mask silently turns negative and the settings
   * validator, which insists on a non-negative number, would then drop the stored selection.
   */
  it('stays inside the range the shift and the validator allow', () => {
    expect(SERF_SLOTS).toBeLessThanOrEqual(30);
    expect(GOOD_SLOTS).toBeLessThanOrEqual(30);
    // The FULL selection is the case that would overflow, so it is the one to build.
    for (const [name, slots] of [
      ['goods', GOOD_SLOTS],
      ['serfs', SERF_SLOTS],
    ] as const) {
      const all = maskOf(Array.from({ length: slots }, (_, i) => i));
      expect(all, name).toBeGreaterThan(0);
      expect(all, name).toBe(2 ** slots - 1);
    }
  });

  /**
   * An addition of ours must not stand over the game screen before anyone asked for it — and since
   * the selection IS the switch, "off" means an empty selection. The rule holds for every
   * enhancement, so a new one that ships visible should break a line like this of its own.
   */
  it('starts with nothing selected, which is the readout switched off', () => {
    expect(STOCK_GOODS_DEFAULT).toBe(0);
    expect(STOCK_SERFS_DEFAULT).toBe(0);
  });
});

describe('layout bounds', () => {
  it('offers a row width that spans column and strip', () => {
    expect(STOCK_PER_ROW_MIN).toBe(1);
    expect(STOCK_PER_ROW_MAX).toBeGreaterThan(STOCK_PER_ROW_MIN);
    expect(STOCK_PER_ROW_DEFAULT).toBeGreaterThanOrEqual(STOCK_PER_ROW_MIN);
    expect(STOCK_PER_ROW_DEFAULT).toBeLessThanOrEqual(STOCK_PER_ROW_MAX);
  });
});

/**
 * Since the switch went, this IS the visibility rule: an empty selection has to yield an empty
 * view, and one tick anywhere has to be enough to bring the readout back.
 */
describe('what makes the readout appear', () => {
  it('shows nothing when nothing is selected', () => {
    const state = gameState([serf(0, 3, 1)], [inventory(0, { 7: 10 })]);
    const view = buildStockView(state, player(0), sel());
    expect(view.goods).toEqual([]);
    expect(view.serfs).toEqual([]);
  });

  it('one selected entry on either side is enough', () => {
    const state = gameState([serf(0, 3, 1)], [inventory(0, { 7: 10 })]);
    expect(buildStockView(state, player(0), sel({ goods: maskOf([7]) })).goods).toHaveLength(1);
    expect(buildStockView(state, player(0), sel({ serfs: maskOf([3]) })).serfs).toHaveLength(1);
  });
});

describe('buildStockView — goods', () => {
  it('counts only the own warehouses', () => {
    const state = gameState([], [null, inventory(0, { 7: 10 }), inventory(1, { 7: 100 })]);
    const view = buildStockView(state, player(0), sel({ goods: maskOf([7]) }));
    expect(view.goods).toEqual([{ kind: 'good', type: 7, icon: 0x22 + 7, value: 10 }]);
  });

  it('shows only what is selected, in the original order', () => {
    const state = gameState([], [inventory(0, { 0: 1, 7: 2, 9: 3 })]);
    const view = buildStockView(state, player(0), sel({ goods: maskOf([0, 7, 9]) }));
    // Column order of the warehouse window, not ascending resource type.
    const expected = GOOD_ORDER.filter((t) => [0, 7, 9].includes(t));
    expect(view.goods.map((r) => r.icon - 0x22)).toEqual(expected);
  });

  it('an empty selection yields no rows', () => {
    const state = gameState([], [inventory(0, { 7: 10 })]);
    expect(buildStockView(state, player(0), sel()).goods).toEqual([]);
  });
});

describe('buildStockView — serfs', () => {
  it('counts only own settlers resting in a store', () => {
    const state = gameState(
      [
        null,
        serf(0, 3, 1), // own builder, idle in stock
        serf(0, 3, 5), // own builder, out working
        serf(1, 3, 1), // someone else's
      ],
      [],
    );
    const view = buildStockView(state, player(0), sel({ serfs: maskOf([3]) }));
    expect(view.goods).toEqual([]);
    expect(view.serfs).toEqual([{ kind: 'serf', type: 3, icon: 0x0c, value: 1 }]);
  });

  /**
   * The two modes have to be told apart by something the counting actually does differently — a
   * store with tools and unemployed settlers but NOBODY resting is exactly that case.
   */
  it('separates "resting" from "could be made"', () => {
    const state = gameState([], [inventory(0, { 16: 5 }, 3)]); // 5 hammers, 3 unemployed
    const idle = buildStockView(state, player(0), sel({ serfs: maskOf([3]), mode: 'idle' }));
    const avail = buildStockView(state, player(0), sel({ serfs: maskOf([3]), mode: 'available' }));
    expect(idle.serfs[0]!.value).toBe(0);
    expect(avail.serfs[0]!.value).toBe(3);
  });

  /**
   * The gate that keeps the overlay from costing anything it is not showing: walking the serf table
   * is the expensive half, and an unselected serf list must not walk it at all.
   */
  it('does not touch the serf table when no profession is selected', () => {
    const state = {
      inventories: [inventory(0, { 7: 1 })],
      get serfs(): never {
        throw new Error('the serf table was read although nothing was selected');
      },
    } as unknown as GameState;
    expect(() => buildStockView(state, player(0), sel({ goods: maskOf([7]) }))).not.toThrow();
  });
});

describe('idleInStock', () => {
  it('is phase one of the availability count', () => {
    const state = gameState([serf(0, 9, 1), serf(0, 9, 1), serf(0, 2, 1)], []);
    const buf = idleInStock(state, player(0));
    expect(buf[9]).toBe(2);
    expect(buf[2]).toBe(1);
    expect(buf[3]).toBe(0);
  });
});

describe('stockRefreshDue', () => {
  it('throttles while the simulation runs', () => {
    expect(stockRefreshDue(1000, 900, true)).toBe(false);
    expect(stockRefreshDue(900 + STOCK_REFRESH_MS, 900, true)).toBe(true);
  });

  it('does not throttle while paused — there the user is the only source of change', () => {
    expect(stockRefreshDue(901, 900, false)).toBe(true);
  });

  it('lets the very first set through', () => {
    expect(stockRefreshDue(0, Number.NEGATIVE_INFINITY, true)).toBe(true);
  });
});
