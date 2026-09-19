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
  STOCK_CELL_SPAN,
  STOCK_PER_ROW_DEFAULT,
  STOCK_PER_ROW_MAX,
  STOCK_PER_ROW_MIN,
  SUPPLY_CELL_SPAN,
  gridColumnCount,
  supplyColumnSpan,
  stockRefreshDue,
  type StockSelection,
  type StockView,
} from './stock-overview.js';
import { GOOD_ORDER } from './ui-icons.js';
import type { Building, GameState, Inventory, Player, Serf } from '../core/engine/state.js';
import { fillLadderIcon } from '../core/stats-popup.js';
import {
  SUPPLY_FOOD_MASK,
  SUPPLY_INDUSTRY_MASK,
  SUPPLY_ORDER,
  SUPPLY_POINTERS,
  supplyIcon,
  supplyToKey,
} from './supply-pointers.js';

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
  supply: 0,
  mode: 'idle',
  hideUnusedGoods: false,
  hideUnusedSerfs: false,
  hideUnusedSupply: false,
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

  /**
   * The clamp, and nothing beyond it: that a pointer cell is one and a half goods wide is geometry
   * of the archive, checked where the archive lies, and what it looks like is checked by eye.
   */
  it('never lets a pointer cell reach past the grid', () => {
    for (let perRow = STOCK_PER_ROW_MIN; perRow <= STOCK_PER_ROW_MAX; perRow++) {
      const span = supplyColumnSpan(perRow);
      expect(span).toBeLessThanOrEqual(gridColumnCount(perRow));
      expect(span).toBeGreaterThanOrEqual(STOCK_CELL_SPAN);
      expect(span).toBe(perRow === 1 ? STOCK_CELL_SPAN : SUPPLY_CELL_SPAN);
    }
  });

  /** A pointer is wider than a good — half places exist for that reason alone. */
  it('gives a pointer more room than a good', () => {
    expect(SUPPLY_CELL_SPAN).toBeGreaterThan(STOCK_CELL_SPAN);
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

  it('leaves out what there is none of, but only when asked to', () => {
    const state = gameState([], [inventory(0, { 7: 10 })]);
    const chosen = maskOf([0, 7]); // fish: none in store, planks: ten
    expect(buildStockView(state, player(0), sel({ goods: chosen })).goods).toHaveLength(2);
    const hidden = buildStockView(state, player(0), sel({ goods: chosen, hideUnusedGoods: true }));
    expect(hidden.goods.map((r) => r.type)).toEqual([7]);
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

  it('leaves out professions nobody is, but only when asked to', () => {
    const state = gameState([serf(0, 3, 1)], []);
    const chosen = maskOf([3, 9]); // one builder resting, no miner anywhere
    expect(buildStockView(state, player(0), sel({ serfs: chosen })).serfs).toHaveLength(2);
    const hidden = buildStockView(state, player(0), sel({ serfs: chosen, hideUnusedSerfs: true }));
    expect(hidden.serfs.map((r) => r.type)).toEqual([3]);
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

describe('supply pointers in the view', () => {
  /**
   * The pointers without their grouping — one entry per selected pointer, in the order they are
   * drawn. It keeps an expectation about a single needle about that needle, rather than about the
   * group it happens to sit in.
   */
  const flat = (view: StockView): { index: number; toIcon: number; pointerIcon: number }[] =>
    view.supply.flatMap((g) => g.entries.map((e) => ({ ...e, toIcon: g.toIcon })));

  /** A state whose building walk is counted: `collectFillLevels` reads `header` once per run. */
  function countingState(buildings: (Building | null)[] = []): {
    state: GameState;
    runs: () => number;
  } {
    let runs = 0;
    const header = { maxBuildingIndex: buildings.length };
    const state = {
      serfs: [],
      inventories: [],
      buildings,
      get header() {
        runs += 1;
        return header;
      },
    } as unknown as GameState;
    return { state, runs: () => runs };
  }

  it('collects nothing when no pointer is selected', () => {
    const { state, runs } = countingState();
    expect(buildStockView(state, player(0), sel({ goods: 0 })).supply).toEqual([]);
    expect(runs()).toBe(0);
  });

  /**
   * The two chains are separate runs over all buildings. Selecting one must not pay for the other —
   * that is the whole reason `SUPPLY_FOOD_MASK` exists.
   */
  it('walks only the chain a selected pointer belongs to', () => {
    const foodOnly = countingState();
    buildStockView(foodOnly.state, player(0), sel({ supply: SUPPLY_FOOD_MASK }));
    expect(foodOnly.runs()).toBe(1);

    const industryOnly = countingState();
    buildStockView(industryOnly.state, player(0), sel({ supply: SUPPLY_INDUSTRY_MASK }));
    expect(industryOnly.runs()).toBe(1);

    const both = countingState();
    buildStockView(both.state, player(0), sel({ supply: 1 | (1 << 20) }));
    expect(both.runs()).toBe(2);
  });

  it('shows the needle the statistics screen would show', () => {
    // A mill (type 15) with 3 waiting and 1 booked: the bucket the miller's pointer reads.
    const mill = {
      type: 15,
      owner: 0,
      burning: false,
      constructing: false,
      holder: true,
      progress: 0,
      stock: [
        { available: 3, requested: 1 },
        { available: 0, requested: 0 },
      ],
      stockMaximum: null,
    } as unknown as Building;
    const { state } = countingState([mill]);
    const view = buildStockView(state, player(0), sel({ supply: maskOf([0]) }));
    expect(view.supply.length).toBe(1);
    const p = SUPPLY_POINTERS[0]!;
    expect(view.supply[0]).toEqual({
      first: 0,
      toIcon: supplyIcon(p.to),
      entries: [
        {
          index: 0,
          goodIcon: supplyIcon(p.good),
          // (0x31 & 0xf) + ((0x31 & 0xf0) >> 3) = 7, one contributing building.
          pointerIcon: fillLadderIcon(p.ladder, 7, 1),
        },
      ],
    });
  });

  /**
   * The sharp case of "hide unused", and the reason the filter hangs off `count` rather than off the
   * fill level — the two are one keystroke apart and mean opposite things:
   *
   * - A mill that is there and gets nothing: `count` 1, `sum` 0. That row is the whole point of the
   *   statistic and has to stay.
   * - No mill at all: `count` 0. The row is then about a building the player does not have.
   *
   * The original separates them too, with a sprite of its own — which is why the two expectations
   * below are different icons, and why a filter written on the picture would have hit both.
   */
  it('keeps a starving receiver and drops one that does not exist', () => {
    const starving = {
      type: 15, // mill — pointer 0 of the food chain
      owner: 0,
      burning: false,
      constructing: false,
      holder: true,
      progress: 0,
      stock: [
        { available: 0, requested: 0 },
        { available: 0, requested: 0 },
      ],
      stockMaximum: null,
    } as unknown as Building;

    const withMill = buildStockView(
      countingState([starving]).state,
      player(0),
      sel({ supply: maskOf([0]), hideUnusedSupply: true }),
    );
    expect(flat(withMill).map((r) => r.index)).toEqual([0]);
    expect(flat(withMill)[0]!.pointerIcon).toBe(fillLadderIcon('down', 0, 1));
    expect(fillLadderIcon('down', 0, 1)).not.toBe(fillLadderIcon('down', 0, 0));

    const withoutMill = buildStockView(
      countingState().state,
      player(0),
      sel({ supply: maskOf([0]), hideUnusedSupply: true }),
    );
    expect(withoutMill.supply).toEqual([]);
  });

  /** Hiding is a filter on the result, never a reason to skip a walk — that cannot be known first. */
  it('walks the chain even when everything would be hidden', () => {
    const { state, runs } = countingState();
    buildStockView(state, player(0), sel({ supply: SUPPLY_FOOD_MASK, hideUnusedSupply: true }));
    expect(runs()).toBe(1);
  });

  /**
   * The whole point of the grouping, and its one risk: a receiver that stands twice must not be
   * drawn twice, and two receivers that merely follow each other must not be run together.
   */
  it('gathers the pointers of one receiver and separates two receivers', () => {
    const { state } = countingState();
    // 8/9 are the gold smelter (ore and coal), 10/11 the steel smelter (coal and ore).
    const view = buildStockView(state, player(0), sel({ supply: maskOf([8, 9, 10, 11]) }));
    expect(view.supply.map((g) => g.entries.map((e) => e.index))).toEqual([
      [8, 9],
      [10, 11],
    ]);
    expect(view.supply.map((g) => g.first)).toEqual([8, 10]);
    expect(view.supply[0]!.toIcon).not.toBe(view.supply[1]!.toIcon);
  });

  /**
   * Grouping is a GATHERING of what stands next to each other, never a re-sort: the original's own
   * display tables put the two pointers of a receiver side by side, so both readings have to give
   * the same list. Were that ever untrue the plate would show its rows in an order the statistics
   * screens do not have — and nothing else in the tree would notice.
   */
  it('leaves the order exactly as the original lists it', () => {
    const { state } = countingState();
    const all = buildStockView(state, player(0), sel({ supply: maskOf([...SUPPLY_ORDER]) }));
    expect(flat(all).map((r) => r.index)).toEqual([...SUPPLY_ORDER]);

    // ... and a group is never split, which is the same statement seen from the other side.
    const keys = all.supply.map((g) => supplyToKey(g.first));
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * Hiding takes a group WHOLE or not at all, and that is not a rule this file enforces — it falls
   * out of the original's own chain. The two buckets of a receiver are filled by the same building
   * test (the gold smelter's `match` is 0x5c for both, the weaponsmith's 0x50, and so on down the
   * five), and `count` counts contributing buildings, not their contents. So the two halves of a
   * group are hidden together or not at all, and a heading with one lonely pair under it is a shape
   * that cannot arise. Worth pinning, because the code handles it anyway and a reader will wonder.
   */
  it('hides a receiver whole, never half of one', () => {
    const smelter = {
      type: 23, // gold smelter — pointers 8 (gold ore) and 9 (coal)
      owner: 0,
      burning: false,
      constructing: false,
      holder: true,
      progress: 0,
      stock: [
        { available: 2, requested: 0 }, // coal has arrived
        { available: 0, requested: 0 }, // gold ore has not — and the line stays all the same
      ],
      stockMaximum: null,
    } as unknown as Building;

    const withSmelter = buildStockView(
      countingState([smelter]).state,
      player(0),
      sel({ supply: maskOf([8, 9]), hideUnusedSupply: true }),
    );
    expect(withSmelter.supply.map((g) => g.entries.map((e) => e.index))).toEqual([[8, 9]]);

    const without = buildStockView(
      countingState().state,
      player(0),
      sel({ supply: maskOf([8, 9]), hideUnusedSupply: true }),
    );
    expect(without.supply).toEqual([]);
  });

  it('an empty bucket shows the empty needle of its own ladder', () => {
    const { state } = countingState();
    const view = buildStockView(state, player(0), sel({ supply: maskOf([0, 4]) }));
    expect(flat(view).map((r) => r.pointerIcon)).toEqual([
      fillLadderIcon('down', 0, 0), // miller — workload ladder
      fillLadderIcon('up', 0, 0), //   gold mine — supply ladder
    ]);
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
