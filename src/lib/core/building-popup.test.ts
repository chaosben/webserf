import { describe, it, expect } from 'vitest';
import {
  BUILDING_POPUP_BG_ICON,
  MILITARY_POPUP_GOLD_ICON,
  MILITARY_POPUP_KNIGHT_COL,
  MILITARY_POPUP_KNIGHT_COL_STEP,
  MILITARY_POPUP_KNIGHT_COL_WRAP,
  drawMilitaryPopup,
  knightRankIcon,
  militaryPopupSpritePos,
  DISPLAY_ONLY_POPUP_HITBOXES,
  CASTLE_POPUP_HITBOXES,
  CASTLE_POPUP_LAYOUT,
  CASTLE_POPUP_NUMBERS,
  castlePopupAction,
  castlePopupCounts,
  drawCastlePopup,
  SERF_CENSUS_POPUP_HITBOXES,
  SERF_CENSUS_POPUP_LAYOUT,
  SERF_CENSUS_POPUP_NUMBERS,
  SERF_CENSUS_POPUP_NEXT_SCREEN,
  SERF_CENSUS_TOTAL_SLOT,
  SERF_CENSUS_TOTAL_POS,
  drawSerfCensusPopup,
  serfCensusCounts,
  serfCensusPopupAction,
  INVENTORY_MODE_POPUP_LAYOUT,
  INVENTORY_MODE_KNIGHT_LAYOUT,
  INVENTORY_MODE_KNIGHT_NUMBERS,
  INVENTORY_MODE_POPUP_HITBOXES,
  INVENTORY_MODE_POPUP_HITBOXES_LOCKED,
  INVENTORY_MODE_POPUP_NEXT_SCREEN,
  INVENTORY_MODE_RESOURCE_ROWS,
  INVENTORY_MODE_SERF_ROWS,
  INVENTORY_MODE_VALUES,
  inventoryModeKnightCounts,
  inventoryModePopupAction,
  inventoryModeRow,
  resourceIcon,
  STOCK_POPUP_CENTER_COL,
  STOCK_POPUP_EMPTY_ICON,
  STOCK_POPUP_WORKER_ICON,
  drawStockPopup,
  stockPopupGoodsIcons,
  stockPopupRowCols,
  MINE_POPUP_FOOD_ICON,
  MINE_POPUP_HOLDER_ICON_EMPTY,
  MINE_POPUP_HOLDER_ICON_OCCUPIED,
  MINE_SUCCESS_WEIGHTS,
  buildingPopupSpriteCol,
  constructionPopupAction,
  drawConstructionPopup,
  drawMinePopup,
  mineSuccessRate,
} from './building-popup.js';
import { MAP_BUILDING_SPRITE } from './building-sprites.js';
import {
  UI_DIGIT_ICON_BASE,
  UI_ICON_BASE,
  UI_OBJECT_BASE,
  createFramebuffer,
  drawPanelNumber,
  mapSpecialClickScreen,
} from './ui-render.js';
import type { DecodedSprite } from './types.js';

/** Text colour as in the original (palette index 0x1f of the game palette). */
const TEXT = [115, 179, 67] as const;

const sprite = {
  width: 2,
  height: 2,
  offsetX: 0,
  offsetY: 0,
  deltaX: 0,
  deltaY: 0,
  pixels: new Uint8ClampedArray(16).fill(255),
} as unknown as DecodedSprite;

function recorder(): { asked: number[]; provider: (e: number) => DecodedSprite } {
  const asked: number[] = [];
  return { asked, provider: (e: number) => (asked.push(e), sprite) };
}

describe('building-popup — screens 0x28 (construction site) and 0x27 (mine)', () => {
  it('width rule: sprite value 0xc0 or < 0x9e => column 4, otherwise 6', () => {
    expect(buildingPopupSpriteCol(0xc0)).toBe(4); // warehouse
    expect(buildingPopupSpriteCol(0x9d)).toBe(4); // weaponsmith
    expect(buildingPopupSpriteCol(0x98)).toBe(4); // fortress
    expect(buildingPopupSpriteCol(0x9e)).toBe(6); // exactly the boundary
    expect(buildingPopupSpriteCol(0xa7)).toBe(6); // fisher
    // The affected types are exactly the large ones plus the warehouse.
    const wide = MAP_BUILDING_SPRITE.map((v, t) => ({ v, t }))
      .filter(({ v, t }) => t > 0 && buildingPopupSpriteCol(v) === 4)
      .map(({ t }) => t);
    expect(wide).toEqual([10, 12, 13, 14, 19, 20, 22]);
  });

  it('construction site draws background, building sprite and the two-line title', () => {
    const { asked, provider } = recorder();
    drawConstructionPopup(createFramebuffer(144, 160), provider, 12, TEXT); // farm
    expect(asked.filter((e) => e === UI_ICON_BASE + BUILDING_POPUP_BG_ICON).length).toBeGreaterThan(0);
    expect(asked).toContain(UI_OBJECT_BASE + MAP_BUILDING_SPRITE[12]!);
    expect(asked).toContain(UI_ICON_BASE + 0x3c); // exit
  });

  it('construction site: only the exit is clickable (shared table @0x2c7e4)', () => {
    expect(DISPLAY_ONLY_POPUP_HITBOXES).toHaveLength(1);
    expect(constructionPopupAction(120, 137)).toBe(0x27);
    expect(constructionPopupAction(60, 60)).toBeNull();
  });

  it('success rate: weights sum to 100, bit 0 weighs most', () => {
    expect(MINE_SUCCESS_WEIGHTS).toHaveLength(16);
    expect(MINE_SUCCESS_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(100);
    expect(mineSuccessRate(0xffff)).toBe(100); // all 16 trips successful
    expect(mineSuccessRate(0)).toBe(0);
    expect(mineSuccessRate(1)).toBe(10); // bit 0 only
    expect(mineSuccessRate(0x8000)).toBe(1); // bit 15 only
    // Monotone: an additional bit can never lower the rate.
    expect(mineSuccessRate(0b11)).toBe(20);
  });

  it('mine: the food stack splits left (rounded up) / right (rounded down)', () => {
    for (const [food, left, right] of [
      [0, 0, 0],
      [1, 1, 0],
      [3, 2, 1],
      [8, 4, 4],
      [15, 8, 7],
    ] as const) {
      const { asked, provider } = recorder();
      drawMinePopup(createFramebuffer(144, 160), provider, {
        type: 6,
        holder: true,
        food,
        attemptBits: 0,
      }, TEXT);
      const foodIcons = asked.filter((e) => e === UI_ICON_BASE + MINE_POPUP_FOOD_ICON).length;
      expect(foodIcons).toBe(left + right);
    }
  });

  it('mine: the occupied lamp follows `bld+5` bit 6, the rate lands as digit icons', () => {
    let r = recorder();
    drawMinePopup(createFramebuffer(144, 160), r.provider, { type: 6, holder: true, food: 0, attemptBits: 1 }, TEXT);
    expect(r.asked).toContain(UI_ICON_BASE + MINE_POPUP_HOLDER_ICON_OCCUPIED);
    expect(r.asked).not.toContain(UI_ICON_BASE + MINE_POPUP_HOLDER_ICON_EMPTY);
    // Rate 10 => digits '1' and '0'.
    expect(r.asked).toContain(UI_ICON_BASE + UI_DIGIT_ICON_BASE + 1);
    expect(r.asked).toContain(UI_ICON_BASE + UI_DIGIT_ICON_BASE + 0);

    r = recorder();
    drawMinePopup(createFramebuffer(144, 160), r.provider, { type: 6, holder: false, food: 0, attemptBits: 0 }, TEXT);
    expect(r.asked).toContain(UI_ICON_BASE + MINE_POPUP_HOLDER_ICON_EMPTY);
    expect(r.asked).not.toContain(UI_ICON_BASE + MINE_POPUP_HOLDER_ICON_OCCUPIED);
  });
});

describe('building-popup — screen 0x34 (stock)', () => {
  it('the type chain covers exactly the buildings the map branch routes to 0x34', () => {
    // Every type for which `mapSpecialClickScreen` picks screen 0x34 must be in the chain —
    // otherwise the window would close again immediately in the original.
    const routed: number[] = [];
    for (let type = 0; type <= 24; type++) {
      const screen = mapSpecialClickScreen(2, { type, constructing: false, active: true }, true);
      if (screen === 0x34) routed.push(type);
    }
    expect(routed).toEqual([0, 1, 2, 3, 4, 9, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23]);
    // Exactly one has no entry: type 0 — it does not occur on the map.
    const unhandled = routed.filter((t) => stockPopupGoodsIcons(t) === null);
    expect(unhandled).toEqual([0]);
  });

  it('goods per building: coal always in the lower slot, sawmill only in the upper', () => {
    expect(stockPopupGoodsIcons(3)).toEqual({ slot0: 0x29, slot1: -1 }); //  boatbuilder: planks
    expect(stockPopupGoodsIcons(17)).toEqual({ slot0: -1, slot1: 0x28 }); // sawmill: logs
    expect(stockPopupGoodsIcons(18)).toEqual({ slot0: 0x2e, slot1: 0x2c }); // steel smelter
    expect(stockPopupGoodsIcons(23)).toEqual({ slot0: 0x2e, slot1: 0x2f }); // gold smelter
    expect(stockPopupGoodsIcons(20)).toEqual({ slot0: 0x2e, slot1: 0x2d }); // weaponsmith
    // The three coal consumers share the lower slot.
    for (const t of [18, 20, 23]) expect(stockPopupGoodsIcons(t)!.slot0).toBe(0x2e);
    // The fisher and friends consume nothing, but the window still opens.
    for (const t of [1, 2, 4, 9, 12]) expect(stockPopupGoodsIcons(t)).toEqual({ slot0: -1, slot1: -1 });
  });

  it('the goods row is centred on column 7, an empty stock shows ONE placeholder icon', () => {
    expect(stockPopupRowCols(0)).toEqual([STOCK_POPUP_CENTER_COL]); // the `jae` special case
    expect(stockPopupRowCols(1)).toEqual([7]);
    expect(stockPopupRowCols(2)).toEqual([6, 8]);
    expect(stockPopupRowCols(4)).toEqual([4, 6, 8, 10]);
    expect(stockPopupRowCols(8)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    for (const n of [1, 2, 3, 5, 8]) {
      const cols = stockPopupRowCols(n);
      expect(cols).toHaveLength(n);
      // The centre stays 7.
      expect((cols[0]! + cols[cols.length - 1]!) / 2).toBe(STOCK_POPUP_CENTER_COL);
    }
  });

  it('an empty slot draws the placeholder instead of the goods', () => {
    let r = recorder();
    drawStockPopup(createFramebuffer(144, 160), r.provider, {
      type: 18, // steel smelter: coal + iron ore
      holder: true,
      stock0: 3,
      stock1: 0,
    }, TEXT);
    expect(r.asked.filter((e) => e === UI_ICON_BASE + 0x2e)).toHaveLength(3); // 3x coal
    expect(r.asked).not.toContain(UI_ICON_BASE + 0x2c); // no iron ore ...
    expect(r.asked).toContain(UI_ICON_BASE + STOCK_POPUP_EMPTY_ICON); // ... the placeholder instead

    // Both stocked: each kind appears with its count.
    r = recorder();
    drawStockPopup(createFramebuffer(144, 160), r.provider, {
      type: 18,
      holder: true,
      stock0: 2,
      stock1: 5,
    }, TEXT);
    expect(r.asked.filter((e) => e === UI_ICON_BASE + 0x2e)).toHaveLength(2);
    expect(r.asked.filter((e) => e === UI_ICON_BASE + 0x2c)).toHaveLength(5);
  });

  it('worker icon from the table @0x3af13, the placeholder without a worker', () => {
    // The table carries 0xff exactly where another window is responsible.
    const noEntry = STOCK_POPUP_WORKER_ICON.map((v, t) => ({ v, t }))
      .filter(({ v }) => v === 0xff)
      .map(({ t }) => t);
    expect(noEntry).toEqual([0, 5, 6, 7, 8, 10, 11, 21, 22]); // none, 4 mines, warehouse, hut, tower, fortress

    const r = recorder();
    drawStockPopup(createFramebuffer(144, 160), r.provider, { type: 13, holder: true, stock0: 0, stock1: 0 }, TEXT);
    expect(r.asked).toContain(UI_ICON_BASE + 0x15); // butcher

    const r2 = recorder();
    drawStockPopup(createFramebuffer(144, 160), r2.provider, { type: 13, holder: false, stock0: 1, stock1: 0 }, TEXT);
    expect(r2.asked).not.toContain(UI_ICON_BASE + 0x15);
    expect(r2.asked).toContain(UI_ICON_BASE + STOCK_POPUP_EMPTY_ICON);
  });
});

describe('building-popup — screen 0x26 (castle / warehouse)', () => {
  /** The 26 goods icons of the layout table, without the two footer buttons. */
  const goodsItems = CASTLE_POPUP_LAYOUT.filter((it) => it.col === 1 || it.col === 6 || it.col === 11);

  it('layout: 26 goods icons + two buttons, each icon exactly once', () => {
    expect(CASTLE_POPUP_LAYOUT).toHaveLength(28);
    expect(goodsItems).toHaveLength(26);
    const icons = goodsItems.map((it) => it.icon);
    expect(new Set(icons).size).toBe(26);
    // Goods icon == resource type + 0x22, across all 26 types.
    expect([...icons].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 26 }, (_, t) => resourceIcon(t)),
    );
    // The footer: page (0x3d) left, exit (0x3c) right.
    expect(CASTLE_POPUP_LAYOUT[0]).toEqual({ icon: 0x3d, col: 12, row: 0x80 });
    expect(CASTLE_POPUP_LAYOUT[27]).toEqual({ icon: 0x3c, col: 14, row: 0x80 });
  });

  it('each number sits at its icon: column + 2, row + 4', () => {
    expect(CASTLE_POPUP_NUMBERS).toHaveLength(26);
    // Bijection icon <-> number via the resource type — both tables were read independently from
    // the binary (layout triples resp. 26 individual draw calls).
    for (const slot of CASTLE_POPUP_NUMBERS) {
      const item = goodsItems.find((it) => it.icon === resourceIcon(slot.resource));
      expect(item, `resource ${slot.resource}`).toBeDefined();
      expect({ col: slot.col, row: slot.row }).toEqual({ col: item!.col + 2, row: item!.row + 4 });
    }
    expect(new Set(CASTLE_POPUP_NUMBERS.map((s) => s.resource)).size).toBe(26);
  });

  it('the castle adds the parked build reserve to planks and stone', () => {
    const resources = Array.from({ length: 26 }, (_, i) => i);
    const castle = castlePopupCounts({
      isCastle: true,
      active: true,
      resources,
      heldPlanks: 7,
      heldStone: 2,
    });
    expect(castle[7]).toBe(7 + 7); // planks (type 7) + reserve
    expect(castle[9]).toBe(9 + 2); // stone (type 9) + reserve
    expect(castle[6]).toBe(6); // all others unchanged
    // A warehouse has no reserve — even if the fields were set.
    const warehouse = castlePopupCounts({
      isCastle: false,
      active: true,
      resources,
      heldPlanks: 7,
      heldStone: 2,
    });
    expect(warehouse[7]).toBe(7);
    expect(warehouse[9]).toBe(9);
  });

  it('a warehouse not yet in service shows nothing but zeros', () => {
    const counts = castlePopupCounts({
      isCastle: false,
      active: false,
      resources: Array.from({ length: 26 }, () => 42),
      heldPlanks: 0,
      heldStone: 0,
    });
    expect(counts).toEqual(Array.from({ length: 26 }, () => 0));
    // The castle skips this test (it is in service by definition).
    const castle = castlePopupCounts({
      isCastle: true,
      active: false,
      resources: Array.from({ length: 26 }, () => 42),
      heldPlanks: 0,
      heldStone: 0,
    });
    expect(castle.every((v) => v === 42)).toBe(true);
  });

  it('click: exit closes, the second button switches to screen 0x2b', () => {
    expect(castlePopupAction(120, 137)).toEqual({ kind: 'close', action: 0x27 });
    expect(castlePopupAction(104, 137)).toEqual({ kind: 'screen', action: 0xbf, screen: 0x2b });
    expect(castlePopupAction(60, 60)).toBeNull();
    // Every zone sits on its icon (drawing pixels = click space + (8, 9)).
    for (const zone of CASTLE_POPUP_HITBOXES) {
      const item = CASTLE_POPUP_LAYOUT.find((it) => it.col * 8 === zone.x0 && it.row === zone.y0);
      expect(item, `zone 0x${zone.action.toString(16)}`).toBeDefined();
    }
  });

  it('draws all 26 goods icons and the two buttons', () => {
    const { asked, provider } = recorder();
    drawCastlePopup(createFramebuffer(144, 160), provider, {
      isCastle: true,
      active: true,
      resources: Array.from({ length: 26 }, () => 1),
      heldPlanks: 0,
      heldStone: 0,
    });
    for (const it of CASTLE_POPUP_LAYOUT) expect(asked).toContain(UI_ICON_BASE + it.icon);
  });
});

describe('drawPanelNumber — draw_popup_number @0x41de4', () => {
  /** Which digits were drawn, in which order. */
  function digits(value: number): { seq: number[]; cols: number } {
    const { asked, provider } = recorder();
    const cols = drawPanelNumber(createFramebuffer(144, 160), provider, value, 3, 20);
    const seq = asked
      .filter((e) => e >= UI_ICON_BASE + UI_DIGIT_ICON_BASE && e <= UI_ICON_BASE + UI_DIGIT_ICON_BASE + 9)
      .map((e) => e - UI_ICON_BASE - UI_DIGIT_ICON_BASE);
    return { seq, cols };
  }

  it('one, two and three digits — without leading zeros', () => {
    expect(digits(0)).toEqual({ seq: [0], cols: 1 });
    expect(digits(7)).toEqual({ seq: [7], cols: 1 });
    expect(digits(42)).toEqual({ seq: [4, 2], cols: 2 });
    expect(digits(99)).toEqual({ seq: [9, 9], cols: 2 });
    expect(digits(123)).toEqual({ seq: [1, 2, 3], cols: 3 });
    expect(digits(999)).toEqual({ seq: [9, 9, 9], cols: 3 });
  });

  it('the tens zero in 100..109 (the shared drawing path of the original)', () => {
    // A 'smoothed' version fails exactly here: it prints '10' instead of '100'.
    expect(digits(100)).toEqual({ seq: [1, 0, 0], cols: 3 });
    expect(digits(105)).toEqual({ seq: [1, 0, 5], cols: 3 });
    expect(digits(110)).toEqual({ seq: [1, 1, 0], cols: 3 });
  });

  it('from 1000 on, three special icons instead of digits', () => {
    const { asked, provider } = recorder();
    const cols = drawPanelNumber(createFramebuffer(144, 160), provider, 1000, 3, 20);
    expect(cols).toBe(3);
    expect(asked).toEqual([UI_ICON_BASE + 0xd5, UI_ICON_BASE + 0xd6, UI_ICON_BASE + 0xd7]);
  });
});

describe('building-popup — screen 0x29 (military building)', () => {
  it('sprite position: own rule per building (hut / tower / fortress)', () => {
    expect(militaryPopupSpritePos(0xab)).toEqual({ col: 6, row: 0x14 }); // guard hut
    expect(militaryPopupSpritePos(0x9e)).toEqual({ col: 4, row: 6 }); //   tower
    expect(militaryPopupSpritePos(0x98)).toEqual({ col: 4, row: 1 }); //   fortress
  });

  it('knight icon = serf type + 7 (ranks 22..26 => 0x1d..0x21)', () => {
    expect(knightRankIcon(22)).toBe(0x1d);
    expect(knightRankIcon(26)).toBe(0x21);
  });

  it('garrison: one icon per knight, wrapping after three', () => {
    const { asked, provider } = recorder();
    const types = [22, 23, 24, 25, 26, 22, 23];
    drawMilitaryPopup(createFramebuffer(144, 160), provider, { type: 22, gold: 0, knightTypes: types }, TEXT);
    for (const t of types) expect(asked).toContain(UI_ICON_BASE + knightRankIcon(t));
    // Three columns per row: 3 -> 7 -> 11 -> (0xf => wrap).
    expect(MILITARY_POPUP_KNIGHT_COL + 3 * MILITARY_POPUP_KNIGHT_COL_STEP).toBe(
      MILITARY_POPUP_KNIGHT_COL_WRAP,
    );
    // Without knights, not a single rank icon.
    const r2 = recorder();
    drawMilitaryPopup(createFramebuffer(144, 160), r2.provider, { type: 11, gold: 0, knightTypes: [] }, TEXT);
    for (let t = 22; t <= 26; t++) expect(r2.asked).not.toContain(UI_ICON_BASE + knightRankIcon(t));
  });

  it('gold stack like the mine food stack (left rounded up)', () => {
    for (const [gold, count] of [[0, 0], [1, 1], [5, 5], [8, 8]] as const) {
      const { asked, provider } = recorder();
      drawMilitaryPopup(createFramebuffer(144, 160), provider, { type: 22, gold, knightTypes: [] }, TEXT);
      expect(asked.filter((e) => e === UI_ICON_BASE + MILITARY_POPUP_GOLD_ICON).length).toBe(count);
    }
  });
});

describe('screen 0x2b — serf census of a stock (@0x3d997)', () => {
  const idle = (type: number, invIndex: number) =>
    ({ type, state: 1, stateData: [0, 0, 0, invIndex & 0xff, (invIndex >> 8) & 0xff] });

  it('bijection icons <-> numbers: every number sits at icon column+2 / icon row+4', () => {
    // The two tables were read independently (icon layout @0x3e081 as byte triples, the numbers from
    // 26 individual draw_popup_number calls). That they map onto each other without a gap checks
    // both against each other — as with the goods window.
    const serfIcons = SERF_CENSUS_POPUP_LAYOUT.slice(2); // the first two are the buttons
    expect(serfIcons.length).toBe(SERF_CENSUS_POPUP_NUMBERS.length);
    expect(serfIcons.length).toBe(26);
    const numberSlots = new Set(SERF_CENSUS_POPUP_NUMBERS.map((n) => `${n.col},${n.row}`));
    for (const icon of serfIcons) {
      expect(numberSlots.has(`${icon.col + 2},${icon.row + 4}`)).toBe(true);
    }
    // ...and the mapping is a bijection (no two numbers on the same place).
    expect(numberSlots.size).toBe(26);
    expect(new Set(SERF_CENSUS_POPUP_NUMBERS.map((n) => n.serfType)).size).toBe(26);
  });

  it('counts only idle serfs of THIS stock, indexed by profession', () => {
    const serfs = [
      idle(0, 3), idle(0, 3), // 2 transporters in stock 3
      idle(25, 3), //            1 knight3
      idle(0, 4), //             another stock -> does not count
      { type: 0, state: 2, stateData: [0, 0, 0, 3, 0] }, // on the way -> does not count
      null,
    ];
    const counts = serfCensusCounts({ type: 24, burning: false, inventoryIndex: 3 }, serfs)!;
    expect(counts[0]).toBe(2);
    expect(counts[25]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('returns null for burning buildings and non-stock types', () => {
    const serfs = [idle(0, 0)];
    expect(serfCensusCounts({ type: 24, burning: true, inventoryIndex: 0 }, serfs)).toBeNull();
    expect(serfCensusCounts({ type: 11, burning: false, inventoryIndex: 0 }, serfs)).toBeNull();
    // Warehouse and castle both return something — without an `active` test (unlike screen 0x26).
    expect(serfCensusCounts({ type: 10, burning: false, inventoryIndex: 0 }, serfs)).not.toBeNull();
  });

  it('the wide number at the bottom right reads the dead slot and therefore never appears', () => {
    expect(SERF_CENSUS_TOTAL_SLOT).toBe(27); // serf type 27 = dead
    // The counting pass cannot fill this slot: a dead serf is never in state 1.
    const counts = serfCensusCounts({ type: 24, burning: false, inventoryIndex: 0 }, [
      idle(0, 0), idle(26, 0),
    ])!;
    expect(counts[SERF_CENSUS_TOTAL_SLOT]).toBe(0);
    // No digit icon at the position of the wide number.
    const { asked, provider } = recorder();
    drawSerfCensusPopup(createFramebuffer(144, 160), provider, counts);
    const before = asked.length;
    const r2 = recorder();
    const forced = counts.slice();
    forced[SERF_CENSUS_TOTAL_SLOT] = 7; // set artificially => the number IS drawn
    drawSerfCensusPopup(createFramebuffer(144, 160), r2.provider, forced);
    expect(r2.asked.length).toBeGreaterThan(before);
    expect(SERF_CENSUS_TOTAL_POS).toEqual({ col: 11, row: 0x84 });
  });

  it('click zones: exit closes, paging leads to screen 0x2c', () => {
    expect(SERF_CENSUS_POPUP_HITBOXES.length).toBe(2);
    // Coordinates are **drawing pixels** (click origin 8/9), as in the goods window.
    expect(serfCensusPopupAction(120, 137)).toEqual({ kind: 'close', action: 0x27 });
    expect(serfCensusPopupAction(104, 137)).toEqual({
      kind: 'screen',
      action: 0xc0,
      screen: SERF_CENSUS_POPUP_NEXT_SCREEN,
    });
    expect(SERF_CENSUS_POPUP_NEXT_SCREEN).toBe(0x2c);
    expect(serfCensusPopupAction(60, 60)).toBeNull();
    // Every zone covers exactly its button icon (col*8 == x0).
    for (const box of SERF_CENSUS_POPUP_HITBOXES) {
      const icon = SERF_CENSUS_POPUP_LAYOUT.find((l) => l.col * 8 === box.x0 && l.row === box.y0);
      expect(icon).toBeDefined();
    }
  });
});

describe('screen 0x2c — stock in/out (third page)', () => {
  it('bijection: every rank number sits at icon column + 2 / icon row + 4', () => {
    expect(INVENTORY_MODE_KNIGHT_NUMBERS.length).toBe(INVENTORY_MODE_KNIGHT_LAYOUT.length);
    const free = new Set(INVENTORY_MODE_KNIGHT_LAYOUT.map((_, i) => i));
    for (const n of INVENTORY_MODE_KNIGHT_NUMBERS) {
      const i = [...free].find(
        (k) =>
          INVENTORY_MODE_KNIGHT_LAYOUT[k]!.col + 2 === n.col &&
          INVENTORY_MODE_KNIGHT_LAYOUT[k]!.row + 4 === n.row,
      );
      expect(i).toBeDefined();
      free.delete(i!);
    }
    expect(free.size).toBe(0);
    // Rank 4 (the highest symbol 0x21) is at the top, rank 0 (0x1d) at the bottom.
    expect(INVENTORY_MODE_KNIGHT_NUMBERS[0]!.rank).toBe(4);
    expect(INVENTORY_MODE_KNIGHT_LAYOUT[0]!.icon).toBe(0x21);
  });

  it('the tick row depends ONLY on the two bits — 2 and 3 render the same', () => {
    expect(inventoryModeRow(0, INVENTORY_MODE_RESOURCE_ROWS)).toBe(0x10);
    expect(inventoryModeRow(1, INVENTORY_MODE_RESOURCE_ROWS)).toBe(0x20);
    expect(inventoryModeRow(2, INVENTORY_MODE_RESOURCE_ROWS)).toBe(0x30);
    expect(inventoryModeRow(3, INVENTORY_MODE_RESOURCE_ROWS)).toBe(0x30);
    expect(inventoryModeRow(3, INVENTORY_MODE_SERF_ROWS)).toBe(0x70);
    // The writer stores 3 for the lower position, not 2.
    expect(INVENTORY_MODE_VALUES.out).toBe(3);
  });

  it('rank counting walks the garrison list and STOPS at a non-knight', () => {
    const knight = (index: number, type: number, next: number) =>
      ({ index, type, stateData: [0, 0, 0, next & 0xff, (next >> 8) & 0xff] });
    // Chain 3 -> 4 -> 5: K0, K4, K2.
    const serfs = [null, null, null, knight(3, 22, 4), knight(4, 26, 5), knight(5, 24, 0)];
    expect(inventoryModeKnightCounts({ firstKnight: 3 }, serfs)).toEqual([1, 0, 1, 0, 1]);
    // A non-knight (type 21 = generic) in the middle ends the walk — the rest does NOT count.
    const mixed = [null, null, null, knight(3, 22, 4), knight(4, 21, 5), knight(5, 26, 0)];
    expect(inventoryModeKnightCounts({ firstKnight: 3 }, mixed)).toEqual([1, 0, 0, 0, 0]);
    expect(inventoryModeKnightCounts({ firstKnight: 0 }, serfs)).toEqual([0, 0, 0, 0, 0]);
  });

  it('click zones: six ticks + exit + paging back to 0x26', () => {
    expect(INVENTORY_MODE_POPUP_HITBOXES.length).toBe(8);
    expect(INVENTORY_MODE_POPUP_NEXT_SCREEN).toBe(0x26);
    // Drawing pixels = rectangle + (8, 9).
    expect(inventoryModePopupAction(120, 137)).toEqual({ kind: 'close', action: 0x27 });
    expect(inventoryModePopupAction(104, 137)).toEqual({
      kind: 'screen', action: 0xc1, screen: 0x26,
    });
    // Topmost goods tick (y 0x10..0x1f => 25..40 in drawing pixels), column 9 => x 0x48+8 = 80.
    expect(inventoryModePopupAction(80, 30)).toEqual({
      kind: 'mode', action: 0xc3, group: 'resources', value: 0, special: false,
    });
    expect(inventoryModePopupAction(80, 46)).toEqual({
      kind: 'mode', action: 0xc4, group: 'resources', value: 1, special: true,
    });
    expect(inventoryModePopupAction(80, 62)).toEqual({
      kind: 'mode', action: 0xc5, group: 'resources', value: 3, special: true,
    });
    expect(inventoryModePopupAction(80, 94)).toEqual({
      kind: 'mode', action: 0xc6, group: 'serfs', value: 0, special: false,
    });
    expect(inventoryModePopupAction(80, 126)).toEqual({
      kind: 'mode', action: 0xc8, group: 'serfs', value: 3, special: true,
    });
    // Exactly the four lower ticks require the special click (see the manual).
    const specials = INVENTORY_MODE_POPUP_HITBOXES.filter((b) => {
      const a = inventoryModePopupAction(b.x0 + 8, b.y0 + 9);
      return a?.kind === 'mode' && a.special;
    });
    expect(specials.map((b) => b.action)).toEqual([0xc4, 0xc5, 0xc7, 0xc8]);
  });

  it('the locked zone list (`gs+0x37e` bit 5) is the suffix without the ticks', () => {
    expect(INVENTORY_MODE_POPUP_HITBOXES_LOCKED.length).toBe(2);
    expect(INVENTORY_MODE_POPUP_HITBOXES_LOCKED.map((b) => b.action)).toEqual([0x27, 0xc1]);
    expect(inventoryModePopupAction(80, 30, true)).toBeNull();
    expect(inventoryModePopupAction(120, 137, true)).toEqual({ kind: 'close', action: 0x27 });
  });

  it('every tick zone covers exactly its empty tick icon, the buttons their button icon', () => {
    for (const box of INVENTORY_MODE_POPUP_HITBOXES) {
      const icon = INVENTORY_MODE_POPUP_LAYOUT.find(
        (l) => l.col * 8 === box.x0 && l.row === box.y0,
      );
      expect(icon).toBeDefined();
    }
    // The six tick fields are all the empty icon 0xdc in column 9.
    const empties = INVENTORY_MODE_POPUP_LAYOUT.filter((l) => l.icon === 0xdc);
    expect(empties.length).toBe(6);
    expect(empties.every((l) => l.col === 9)).toBe(true);
    expect(empties.map((l) => l.row)).toEqual([
      ...INVENTORY_MODE_RESOURCE_ROWS, ...INVENTORY_MODE_SERF_ROWS,
    ]);
  });
});
