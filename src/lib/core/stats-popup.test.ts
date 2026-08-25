import { describe, it, expect } from 'vitest';
import {
  BUILDING_STAT_PAGES,
  BUILDING_STAT_SCREENS,
  COMPARE_HITBOXES,
  COMPARE_LAYOUT,
  CURVE_RING_LAST,
  CURVE_X_END,
  CURVE_X_START,
  CURVE_Y_BASE,
  FILL_DISPLAY_FOOD,
  FILL_DISPLAY_INDUSTRY,
  FILL_LADDER_DOWN_BASE,
  FILL_LADDER_DOWN_EMPTY,
  FILL_LADDER_THRESHOLDS,
  FILL_LADDER_UP_BASE,
  FILL_LADDER_UP_EMPTY,
  FILL_RULES_FOOD,
  FILL_RULES_INDUSTRY,
  COMPARE_CURVE_ORDER,
  PLAYER_LEGEND_EMPTY_ICON,
  PLAYER_LEGEND_FACE_ICON_BASE,
  PLAYER_LEGEND_HUMAN_FACE,
  PLAYER_LEGEND_QUADRANTS,
  PLAYER_LEGEND_QUADRANT_HEIGHT,
  PLAYER_LEGEND_QUADRANT_WIDTH,
  PROFESSION_GAUGE_LADDER,
  PROFESSION_STATS_LAYOUT,
  PROFESSION_STATS_SLOTS,
  PROFESSION_UNEMPLOYED_TYPE,
  RESOURCE_BAR_BASE_Y,
  RESOURCE_CURVE_COLUMNS,
  RESOURCE_RING_SIZE,
  RESOURCE_SCALE_STEPS,
  RESOURCE_SELECT_ACTION_BASE,
  RESOURCE_SMOOTH_KERNEL,
  RESOURCE_STATS_HITBOXES,
  RESOURCE_STATS_LAYOUT,
  SERF_STATS_LAYOUT,
  SERF_STATS_NUMBERS,
  STATS_FULL_AREA_HITBOXES,
  STATS_SCREENS,
  STOCK_STATS_LAYOUT,
  STOCK_STATS_NUMBERS,
  clickStatsPopup,
  compareAspect,
  compareLevel,
  compareMode,
  drawBuildingStats,
  drawPlayerColorLegend,
  drawStatCurve,
  legendFaceIcon,
  drawResourceBars,
  professionGaugeIcon,
  resourceScaleStep,
  resourceStripeColorIndex,
  smoothResourceHistory,
  fillLadderIcon,
  nextBuildingStatScreen,
  statsPopupAction,
  statsPopupHitboxes,
} from './stats-popup.js';
import { CASTLE_POPUP_LAYOUT, CASTLE_POPUP_NUMBERS } from './building-popup.js';
import { RESOURCE_ICON_BASE } from './settings-popup.js';
import {
  UI_ICON_BASE,
  UI_INCREMENT_ICON_BASE,
  UI_INCREMENT_ICON_MANY,
  createFramebuffer,
  drawIncrementIcon,
} from './ui-render.js';
import type { DecodedSprite } from './types.js';

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

describe('stats-popup — building statistics (0x0a..0x0d)', () => {
  it('the four pages cover every building type 1..23 exactly once', () => {
    const types = BUILDING_STAT_PAGES.flatMap((p) => p.entries.map((e) => e.type));
    expect(types).toHaveLength(23);
    expect([...types].sort((a, b) => a - b)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it('per page as many building sprites as numbers', () => {
    for (const p of BUILDING_STAT_PAGES) {
      expect(p.objects.length, `Screen 0x${p.screen.toString(16)}`).toBe(p.entries.length);
    }
  });

  it('paging cycles 0x0a -> 0x0b -> 0x0c -> 0x0d -> 0x0a', () => {
    expect(BUILDING_STAT_SCREENS).toEqual([0x0a, 0x0b, 0x0c, 0x0d]);
    expect(nextBuildingStatScreen(0x0a)).toBe(0x0b);
    expect(nextBuildingStatScreen(0x0c)).toBe(0x0d);
    expect(nextBuildingStatScreen(0x0d)).toBe(0x0a);
  });

  it('draws completed as a number and under construction as a +n icon next to it', () => {
    const fb = createFramebuffer(144, 160);
    const { asked, provider } = recorder();
    const completed = Array.from({ length: 23 }, () => 0);
    const incomplete = Array.from({ length: 23 }, () => 0);
    completed[10] = 2; // type 11 (guard hut)
    incomplete[10] = 1;
    expect(drawBuildingStats(fb, provider, 0x0a, completed, incomplete)).toBe(true);
    // "2" as a digit icon and "+1" as icon 0xf1.
    expect(asked).toContain(UI_ICON_BASE + 0x4e + 2);
    expect(asked).toContain(UI_ICON_BASE + UI_INCREMENT_ICON_BASE + 1);
    expect(drawBuildingStats(fb, provider, 0x99, completed, incomplete)).toBe(false);
  });

  it('+n icon: 0 draws nothing, from 10 on the collective icon', () => {
    const fb = createFramebuffer(144, 160);
    const a = recorder();
    drawIncrementIcon(fb, a.provider, 0, 0, 0);
    expect(a.asked).toEqual([]);
    const b = recorder();
    drawIncrementIcon(fb, b.provider, 9, 0, 0);
    drawIncrementIcon(fb, b.provider, 10, 0, 0);
    drawIncrementIcon(fb, b.provider, 400, 0, 0);
    expect(b.asked).toEqual([
      UI_ICON_BASE + UI_INCREMENT_ICON_BASE + 9,
      UI_ICON_BASE + UI_INCREMENT_ICON_MANY,
      UI_ICON_BASE + UI_INCREMENT_ICON_MANY,
    ]);
  });
});

describe('stats-popup — stock inventory (0x09)', () => {
  it('shares grid and number slots with the castle window', () => {
    // In the original it is the same table 6 bytes later — the paging button only sits before it.
    expect(CASTLE_POPUP_LAYOUT[0]).toEqual({ icon: 0x3d, col: 12, row: 0x80 });
    expect(STOCK_STATS_LAYOUT).toEqual(CASTLE_POPUP_LAYOUT.slice(1));
    expect(STOCK_STATS_NUMBERS).toBe(CASTLE_POPUP_NUMBERS);
    expect(STOCK_STATS_NUMBERS).toHaveLength(26);
    // The exit button stays in the slice, the paging button does not.
    expect(STOCK_STATS_LAYOUT.some((i) => i.icon === 0x3c)).toBe(true);
    expect(STOCK_STATS_LAYOUT.some((i) => i.icon === 0x3d)).toBe(false);
  });
});

describe('stats-popup — people statistics (0x12)', () => {
  it('26 icons, 26 numbers, every type exactly once — and type 4 not at all', () => {
    expect(SERF_STATS_LAYOUT).toHaveLength(26);
    expect(SERF_STATS_NUMBERS).toHaveLength(26);
    const types = SERF_STATS_NUMBERS.map((s) => s.type);
    expect(new Set(types).size).toBe(26);
    expect(types).not.toContain(4);
    expect(Math.max(...types)).toBe(26);
  });

  it('every number sits two columns right and four rows below its icon', () => {
    SERF_STATS_NUMBERS.forEach((n, i) => {
      const icon = SERF_STATS_LAYOUT[i]!;
      expect(n.col).toBe(icon.col + 2);
      expect(n.row).toBe(icon.row + 4);
    });
  });
});

describe('stats-popup — fill levels (0x10/0x11)', () => {
  it('every display slot has at least one rule and vice versa', () => {
    for (const [rules, display] of [
      [FILL_RULES_FOOD, FILL_DISPLAY_FOOD],
      [FILL_RULES_INDUSTRY, FILL_DISPLAY_INDUSTRY],
    ] as const) {
      const ruleSlots = new Set(rules.map((r) => r.byteSlot));
      const displaySlots = new Set(display.map((d) => d.byteSlot));
      expect(displaySlots).toEqual(ruleSlots);
      for (const s of ruleSlots) expect(s % 6).toBe(0);
    }
  });

  it('ladder: without a building the empty icon, otherwise one step per threshold', () => {
    expect(fillLadderIcon('up', 0, 0)).toBe(FILL_LADDER_UP_EMPTY);
    expect(fillLadderIcon('down', 0, 0)).toBe(FILL_LADDER_DOWN_EMPTY);
    // q = (sum << 4) / count; below the first threshold it stays the base icon.
    expect(fillLadderIcon('up', 1, 1)).toBe(FILL_LADDER_UP_BASE); // q = 16 ≤ 0x16
    expect(fillLadderIcon('down', 1, 1)).toBe(FILL_LADDER_DOWN_BASE);
    // Exactly one threshold crossed.
    expect(fillLadderIcon('up', 2, 1)).toBe(FILL_LADDER_UP_BASE + 1); // q = 32 > 0x16
    expect(fillLadderIcon('down', 2, 1)).toBe(FILL_LADDER_DOWN_BASE - 1);
    // Above the last threshold the highest step (ten steps).
    expect(fillLadderIcon('up', 100, 1)).toBe(FILL_LADDER_UP_BASE + FILL_LADDER_THRESHOLDS.length);
    expect(fillLadderIcon('down', 100, 1)).toBe(
      FILL_LADDER_DOWN_BASE - FILL_LADDER_THRESHOLDS.length,
    );
  });

  it('the thresholds are equidistant (step 0x17)', () => {
    for (let i = 1; i < FILL_LADDER_THRESHOLDS.length; i++) {
      expect(FILL_LADDER_THRESHOLDS[i]! - FILL_LADDER_THRESHOLDS[i - 1]!).toBe(0x17);
    }
  });

  it('military gold has fixed caps 2/4/8 per building kind', () => {
    const gold = FILL_RULES_INDUSTRY.filter((r) => r.kind.startsWith('gold'));
    expect(gold.map((r) => [r.codedType, r.kind])).toEqual([
      [0x2c, 'gold2'], // guard hut
      [0x54, 'gold4'], // watchtower
      [0x58, 'gold8'], // fortress
    ]);
    // All three pay into the same pot.
    expect(new Set(gold.map((r) => r.byteSlot)).size).toBe(1);
  });
});

describe('stats-popup — comparison curves (0x0e)', () => {
  it('mode is (aspect << 2) | time window', () => {
    for (let a = 0; a < 4; a++) {
      for (let l = 0; l < 4; l++) {
        const m = compareMode(a, l);
        expect(compareAspect(m)).toBe(a);
        expect(compareLevel(m)).toBe(l);
      }
    }
    expect(compareMode(2, 3)).toBe(11);
  });

  it('eight selection zones sit on the eight button icons', () => {
    const buttons = COMPARE_LAYOUT.filter((i) => i.row >= 112 && i.col < 12);
    expect(buttons).toHaveLength(8);
    const corners = new Set(buttons.map((b) => `${b.col * 8},${b.row}`));
    const zones = new Set(
      COMPARE_HITBOXES.filter((z) => z.action >= 0x28 && z.action <= 0x2f).map(
        (z) => `${z.x0},${z.y0}`,
      ),
    );
    expect(zones).toEqual(corners);
  });

  it('actions: four aspects, four time windows, back to the menu', () => {
    expect(statsPopupAction(0x0e, 0x28)).toEqual({ kind: 'aspect', aspect: 0 });
    expect(statsPopupAction(0x0e, 0x2b)).toEqual({ kind: 'aspect', aspect: 3 });
    expect(statsPopupAction(0x0e, 0x2c)).toEqual({ kind: 'level', level: 0 });
    expect(statsPopupAction(0x0e, 0x2f)).toEqual({ kind: 'level', level: 3 });
    expect(statsPopupAction(0x0e, 0x25)).toEqual({ kind: 'menu' });
    expect(statsPopupAction(0x0e, 0xf3)).toEqual({ kind: 'screen', screen: 0x35 });
  });

  it('curve: horizontal line at height `0x6c - value`', () => {
    const fb = createFramebuffer(144, 160);
    const samples = Array.from({ length: 112 }, () => 40);
    drawStatCurve(fb, samples, 111, [255, 0, 0]);
    const y = CURVE_Y_BASE - 40;
    const at = (x: number, yy: number) => fb.rgba[(yy * fb.width + x) * 4 + 3];
    expect(at(CURVE_X_START, y)).toBe(255);
    // The loop stops as soon as x reaches 8: on a horizontal curve (no remainder pixel) column 9 is
    // the last one drawn — exactly where the original stops too.
    expect(at(CURVE_X_END + 1, y)).toBe(255);
    expect(at(CURVE_X_END, y)).toBe(0);
    expect(at(CURVE_X_START, y - 1)).toBe(0); // nothing one row above
  });

  it('curve: the ring runs backwards and wraps from 0 to the last sample', () => {
    const fb = createFramebuffer(144, 160);
    // Only sample 0 is high: it must appear exactly one column to the right.
    const samples = Array.from({ length: 112 }, (_, i) => (i === 0 ? 50 : 0));
    drawStatCurve(fb, samples, 2, [255, 0, 0]);
    const at = (x: number, yy: number) => fb.rgba[(yy * fb.width + x) * 4 + 3];
    // Start index 2 => column 0x77 reads index 2, 0x76 reads 1, 0x75 reads 0.
    expect(at(CURVE_X_START - 2, CURVE_Y_BASE - 50)).toBe(255);
    expect(CURVE_RING_LAST).toBe(0x6f); // 112 samples
  });
});

describe('stats-popup — shared rules', () => {
  it('four screens have one zone over the whole area and lead to the menu', () => {
    for (const screen of [0x09, 0x10, 0x11, 0x12]) {
      expect(statsPopupHitboxes(screen)).toBe(STATS_FULL_AREA_HITBOXES);
      expect(clickStatsPopup(screen, 8 + 0x40, 9 + 0x40)).toEqual({ kind: 'menu' });
    }
  });

  it('building pages: exit on the right, paging on the left', () => {
    const hit = clickStatsPopup(0x0b, 8 + 0x04, 9 + 0x84);
    expect(hit).toEqual({ kind: 'page', screen: 0x0c });
    expect(clickStatsPopup(0x0b, 8 + 0x78, 9 + 0x84)).toEqual({ kind: 'menu' });
    // The middle of the area is NOT clickable on these pages.
    expect(clickStatsPopup(0x0b, 8 + 0x40, 9 + 0x40)).toBeNull();
  });

});

describe('stats-popup — resource production curve (screen 0x0f)', () => {
  it('the smoothing kernel is symmetric and sums to 64', () => {
    expect(RESOURCE_SMOOTH_KERNEL).toEqual([...RESOURCE_SMOOTH_KERNEL].reverse());
    expect(RESOURCE_SMOOTH_KERNEL.reduce((a, b) => a + b, 0)).toBe(64);
    // 112 columns + 8 samples of lookback == the ring size. Hence 120 instead of 112 samples.
    expect(RESOURCE_CURVE_COLUMNS + RESOURCE_SMOOTH_KERNEL.length - 1).toBe(RESOURCE_RING_SIZE);
  });

  it('a single sample appears as the kernel profile across nine columns', () => {
    const samples = new Array<number>(RESOURCE_RING_SIZE).fill(0);
    samples[100] = 1;
    // A column's window runs **backwards** from the head: with head 108 the sample sits on the last
    // weight in column 0 and moves column by column to the first.
    const out = smoothResourceHistory(samples, 108);
    const last = RESOURCE_SMOOTH_KERNEL.length - 1;
    RESOURCE_SMOOTH_KERNEL.forEach((_, k) => expect(out[k]).toBe(RESOURCE_SMOOTH_KERNEL[last - k]));
    expect(out[0]).toBe(RESOURCE_SMOOTH_KERNEL[last]);
    expect(out[last + 1]).toBe(0); // after that the sample has left the window
    // No pixel is lost: the profile sums to the kernel sum.
    expect(out.reduce((a, b) => a + b, 0)).toBe(64);
  });

  it('the ring wraps from 0 to 0x77', () => {
    const samples = new Array<number>(RESOURCE_RING_SIZE).fill(0);
    samples[RESOURCE_RING_SIZE - 1] = 1;
    // Head 0 => column 0 reads 0, then 0x77 (= weight[1]).
    expect(smoothResourceHistory(samples, 0)[0]).toBe(RESOURCE_SMOOTH_KERNEL[1]);
  });

  it('scale steps: bounds and full deflection', () => {
    expect(resourceScaleStep(0x40).factor).toBe(0x8000);
    expect(resourceScaleStep(0x41).factor).toBe(0x4000);
    expect(resourceScaleStep(0x1400).factor).toBe(0x199);
    expect(resourceScaleStep(0x1401).factor).toBe(0xa3);
    expect(resourceScaleStep(0xffff).limit).toBeNull();
    // Every step is calibrated so its largest value fills the area. The three factors with a rounded
    // reciprocal (0x666 = 1/20.0006, 0x333, 0x199) stay one pixel below.
    for (const step of RESOURCE_SCALE_STEPS) {
      const max = step.limit === null ? 0x3fc0 : step.limit - 1;
      const height = ((((max * 2) & 0xffff) * step.factor) >>> 16) & 0xffff;
      expect(Math.min(height, 0x40)).toBeGreaterThanOrEqual(0x3f);
    }
    // And the steps mesh without a gap: at every bound exactly the next one takes over.
    RESOURCE_SCALE_STEPS.forEach((step, k) => {
      if (step.limit === null) return;
      expect(resourceScaleStep(step.limit - 1)).toBe(step);
      expect(resourceScaleStep(step.limit)).toBe(RESOURCE_SCALE_STEPS[k + 1]);
    });
  });

  it('stripe colours: 0x4a / 0x48 / 0x4e / 0x4c', () => {
    expect([0, 1, 2, 3].map(resourceStripeColorIndex)).toEqual([0x4a, 0x48, 0x4e, 0x4c]);
  });

  it('bars: 112 columns from 0x77 down to 8, height from the factor', () => {
    const fb = createFramebuffer(144, 160);
    const at = (f: typeof fb, x: number, y: number) => f.rgba[(y * f.width + x) * 4 + 3];
    const values = new Array<number>(RESOURCE_CURVE_COLUMNS).fill(10);
    drawResourceBars(fb, values, RESOURCE_SCALE_STEPS[0]!, () => [255, 0, 0]);
    // Factor 0x8000 => height == value; drawn upwards from 0x48.
    expect(at(fb, 0x77, RESOURCE_BAR_BASE_Y)).toBe(255);
    expect(at(fb, 0x77, RESOURCE_BAR_BASE_Y - 9)).toBe(255);
    expect(at(fb, 0x77, RESOURCE_BAR_BASE_Y - 10)).toBe(0);
    expect(at(fb, 8, RESOURCE_BAR_BASE_Y)).toBe(255); // last column
    expect(at(fb, 7, RESOURCE_BAR_BASE_Y)).toBe(0); //   nothing beyond
  });

  it('bars clamp at 64 pixels', () => {
    const fb = createFramebuffer(144, 160);
    const at = (f: typeof fb, x: number, y: number) => f.rgba[(y * f.width + x) * 4 + 3];
    const values = new Array<number>(RESOURCE_CURVE_COLUMNS).fill(0xff * 64);
    drawResourceBars(fb, values, RESOURCE_SCALE_STEPS[0]!, () => [255, 0, 0]);
    expect(at(fb, 0x77, RESOURCE_BAR_BASE_Y - 63)).toBe(255);
    expect(at(fb, 0x77, RESOURCE_BAR_BASE_Y - 64)).toBe(0);
  });

  it('each of the 26 resources has exactly one zone, and it sits on its icon', () => {
    const selectors = RESOURCE_STATS_HITBOXES.filter((h) => h.action !== 0x25);
    expect(selectors).toHaveLength(26);
    const resources = selectors.map((h) => h.action - RESOURCE_SELECT_ACTION_BASE).sort((a, b) => a - b);
    expect(resources).toEqual(Array.from({ length: 26 }, (_, i) => i));
    for (const zone of selectors) {
      const resource = zone.action - RESOURCE_SELECT_ACTION_BASE;
      const item = RESOURCE_STATS_LAYOUT.find((l) => l.icon === RESOURCE_ICON_BASE + resource);
      expect(item, `resource ${resource} without icon`).toBeDefined();
      expect(item!.col * 8).toBe(zone.x0);
      expect(item!.row).toBe(zone.y0);
    }
  });

  it('a click on a resource cell selects it, exit leads to the menu', () => {
    // Zone of resource 0 in drawing pixels (click + (8, 9)).
    const zone = RESOURCE_STATS_HITBOXES.find((h) => h.action === 0x30)!;
    expect(clickStatsPopup(0x0f, zone.x0 + 8, zone.y0 + 9)).toEqual({ kind: 'resource', resource: 0 });
    expect(clickStatsPopup(0x0f, 0x70 + 8, 0x80 + 9)).toEqual({ kind: 'menu' });
  });
});

describe('stats-popup — profession statistics (screen 0x13)', () => {
  it('gauge scale: 0 left, 3 centre, from 20 on the right stop', () => {
    expect(professionGaugeIcon(0)).toBe(0xbc);
    expect(professionGaugeIcon(3)).toBe(0xc1);
    // 0xc1 is the middle of the eleven gauge icons 0xbc..0xc6.
    expect(0xc1 - 0xbc).toBe(0xc6 - 0xc1);
    expect(professionGaugeIcon(19)).toBe(0xc5);
    expect(professionGaugeIcon(20)).toBe(0xc6);
    expect(professionGaugeIcon(9999)).toBe(0xc6);
    // Nine steps, bounds ascending, only the last one open.
    expect(PROFESSION_GAUGE_LADDER).toHaveLength(9);
    expect(PROFESSION_GAUGE_LADDER.filter((l) => l.limit === null)).toHaveLength(1);
    expect(PROFESSION_GAUGE_LADDER[PROFESSION_GAUGE_LADDER.length - 1]!.limit).toBeNull();
    for (let k = 1; k < PROFESSION_GAUGE_LADDER.length - 1; k++) {
      expect(PROFESSION_GAUGE_LADDER[k]!.limit!).toBeGreaterThan(PROFESSION_GAUGE_LADDER[k - 1]!.limit!);
    }
    // Monotone: more people => never a smaller icon.
    let last = 0;
    for (let n = 0; n < 40; n++) {
      const icon = professionGaugeIcon(n);
      expect(icon).toBeGreaterThanOrEqual(last);
      last = icon;
    }
  });

  it('the 25 slots cover every type except 4 and 21 exactly once', () => {
    const types = PROFESSION_STATS_SLOTS.map((s) => s.type);
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 27 }, (_, i) => i).filter((t) => t !== 4 && t !== PROFESSION_UNEMPLOYED_TYPE),
    );
  });

  it('every slot has its header icon in the same place', () => {
    for (const slot of PROFESSION_STATS_SLOTS) {
      const item = PROFESSION_STATS_LAYOUT.find((l) => l.col === slot.col - 2 && l.row === slot.row);
      expect(item, `slot type ${slot.type} without header`).toBeDefined();
    }
  });

  it('a click anywhere leads back to the menu', () => {
    expect(clickStatsPopup(0x13, 20, 20)).toEqual({ kind: 'menu' });
    expect(statsPopupHitboxes(0x13)).toBe(STATS_FULL_AREA_HITBOXES);
  });
});

describe('stats-popup — dispatcher', () => {
  it('knows all twelve statistics screens', () => {
    expect(STATS_SCREENS).toEqual([
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x35,
    ]);
  });
});

describe('stats-popup — player colour legend (screen 0x35)', () => {
  it('the four quadrants cover the popup area exactly', () => {
    expect(PLAYER_LEGEND_QUADRANTS).toHaveLength(4);
    const w = PLAYER_LEGEND_QUADRANT_WIDTH;
    const h = PLAYER_LEGEND_QUADRANT_HEIGHT;
    const xs = [...new Set(PLAYER_LEGEND_QUADRANTS.map((q) => q.x))].sort((a, b) => a - b);
    const ys = [...new Set(PLAYER_LEGEND_QUADRANTS.map((q) => q.y))].sort((a, b) => a - b);
    expect(xs).toEqual([8, 8 + w]); //          two columns, gapless
    expect(ys).toEqual([9, 9 + h]); //          two rows, gapless
    expect(2 * w).toBe(128); //                 == popup width
    expect(2 * h).toBe(144); //                 == popup height
  });

  it('the colours match the curves, in the same slot assignment', () => {
    PLAYER_LEGEND_QUADRANTS.forEach((q, slot) => {
      const curve = COMPARE_CURVE_ORDER.find((c) => c.slot === slot);
      expect(curve, `slot ${slot} without curve`).toBeDefined();
      expect(q.colorIndex).toBe(curve!.colorIndex);
    });
  });

  it('face byte -> icon: 0 is the empty slot, otherwise +0x10b (signed)', () => {
    expect(legendFaceIcon(0)).toBe(PLAYER_LEGEND_EMPTY_ICON);
    expect(legendFaceIcon(1)).toBe(0x10c);
    expect(legendFaceIcon(PLAYER_LEGEND_HUMAN_FACE)).toBe(0x117);
    // The original reads `movsbw`: 0xff is -1, not 255.
    expect(legendFaceIcon(0xff)).toBe(PLAYER_LEGEND_FACE_ICON_BASE - 1);
  });

  it('draws four colour areas, one known face and no invented one', () => {
    const fb = createFramebuffer(144, 160);
    const { asked, provider } = recorder();
    drawPlayerColorLegend(fb, provider, { faces: [PLAYER_LEGEND_HUMAN_FACE, null, 0, 0] }, (i) => [
      i,
      0,
      0,
    ]);
    const at = (x: number, y: number) => fb.rgba[(y * fb.width + x) * 4];
    // Every quadrant carries its colour, in the corner and in the middle.
    for (const q of PLAYER_LEGEND_QUADRANTS) {
      expect(at(q.x, q.y)).toBe(q.colorIndex);
      expect(at(q.x + PLAYER_LEGEND_QUADRANT_WIDTH - 1, q.y + PLAYER_LEGEND_QUADRANT_HEIGHT - 1)).toBe(
        q.colorIndex,
      );
    }
    // Slot 0 gets its face, the two empty ones the empty icon, slot 1 (unknown) nothing.
    expect(asked).toEqual([
      UI_ICON_BASE + 0x117,
      UI_ICON_BASE + PLAYER_LEGEND_EMPTY_ICON,
      UI_ICON_BASE + PLAYER_LEGEND_EMPTY_ICON,
    ]);
  });

  it('a click anywhere leads back to the comparison curves', () => {
    expect(clickStatsPopup(0x35, 40, 40)).toEqual({ kind: 'screen', screen: 0x0e });
    // ...and the button on the curves opens the legend.
    expect(statsPopupAction(0x0e, 0xf3)).toEqual({ kind: 'screen', screen: 0x35 });
  });
});
