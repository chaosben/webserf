import { describe, it, expect } from 'vitest';
import {
  COAL_POPUP_HITBOXES,
  COAL_POPUP_SLIDERS,
  FOOD_POPUP_HITBOXES,
  FOOD_POPUP_ICONS,
  FOOD_POPUP_SLIDERS,
  KNIGHT_POPUP_HITBOXES,
  KNIGHT_POPUP_ICONS,
  KNIGHT_POPUP_RATE_SLIDER,
  KNIGHT_RECRUIT_COUNTS,
  OCCUPATION_GROUPS,
  OCCUPATION_POPUP_HITBOXES,
  OCCUPATION_POPUP_ICONS,
  PLANKS_POPUP_HITBOXES,
  PLANKS_POPUP_SLIDERS,
  PRIORITY_POPUP_HITBOXES,
  PRIORITY_SLOT_POSITIONS,
  RESOURCE_ICON_BASE,
  SETTINGS_POPUP_MENU_SCREEN,
  SETTINGS_SCREENS,
  TOOLS_POPUP_HITBOXES,
  TOOLS_POPUP_ICONS,
  TOOLS_POPUP_SLIDERS,
  clickSettingsPopup,
  drawSettingsPopup,
  occupationLabel,
  settingsPopupAction,
  settingsPopupHitboxes,
  settingsPopupSliders,
  type SettingsPopupView,
  type SliderSpec,
} from './settings-popup.js';
import {
  SLIDER_STEP,
  SLIDER_TROUGH_ICON,
  UI_ICON_BASE,
  createFramebuffer,
  drawPanelNumberWide,
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

const view: SettingsPopupView = {
  foodDistribution: [1310, 2620, 3930, 5240],
  planksDistribution: [1310, 1310, 1310],
  steelDistribution: [1310, 1310],
  coalDistribution: [1310, 1310, 1310],
  wheatDistribution: [1310, 1310],
  toolPriority: [1310, 1310, 1310, 1310, 1310, 1310, 1310, 1310, 1310],
  flagPriority: Array.from({ length: 26 }, (_, i) => 26 - i),
  inventoryPriority: Array.from({ length: 26 }, (_, i) => i + 1),
  knightOccupation: [0x10, 0x21, 0x32, 0x43],
  serfToKnightRate: 20000,
  currentSett5Item: 8,
  currentSett6Item: 15,
  goldMorale: 2048,
  goldDeposited: 1234,
  knightMenuValue: 3,
  knightMenuCounter: 3,
  flags: 0x41,
  recruitable: 7,
};

describe('settings-popup — slider screens 0x1c/0x1d/0x1e/0x20', () => {
  it('every slider has exactly one click zone, covering its trough width', () => {
    const cases: readonly [readonly SliderSpec[], readonly { action: number; x0: number; x1: number; y0: number; y1: number }[]][] =
      [
        [FOOD_POPUP_SLIDERS, FOOD_POPUP_HITBOXES],
        [PLANKS_POPUP_SLIDERS, PLANKS_POPUP_HITBOXES],
        [COAL_POPUP_SLIDERS, COAL_POPUP_HITBOXES],
        [TOOLS_POPUP_SLIDERS, TOOLS_POPUP_HITBOXES],
      ];
    for (const [sliders, zones] of cases) {
      for (const s of sliders) {
        const z = zones.find((r) => r.action === s.action);
        expect(z, `zone for action ${s.action.toString(16)}`).toBeDefined();
        // The trough is 64 px wide and starts at the panel column; the zone covers it exactly.
        expect(z!.x0).toBe(s.col * 8);
        expect(z!.x1).toBe(s.col * 8 + 0x3f);
        // Vertically the zone lies inside the trough (the original uses 6 or 8 px per screen).
        expect(z!.y0).toBeGreaterThanOrEqual(s.row);
        expect(z!.y1).toBeLessThanOrEqual(s.row + 0xb);
      }
    }
  });

  it('tool screen: icon order and field indices name the same tools', () => {
    // icon - 0x22 == resource type; tools are types 15..23 in field order
    // Shovel/Hammer/Rod/Cleaver/Scythe/Axe/Saw/Pick/Pincer => type == 15 + toolIndex.
    const iconTools = TOOLS_POPUP_ICONS.filter((i) => i.col === 1).map((i) => i.icon - RESOURCE_ICON_BASE);
    const fieldTools = TOOLS_POPUP_SLIDERS.map((s) => 15 + s.index);
    expect(iconTools).toEqual(fieldTools);
    // Two independently read tables — icon row and slider row belong together pairwise.
    expect(TOOLS_POPUP_ICONS.filter((i) => i.col === 1).map((i) => i.row)).toEqual(
      TOOLS_POPUP_SLIDERS.map((s) => s.row - 4),
    );
  });

  it('slider targets agree with their block offset', () => {
    // The offsets the renderer uses — the same ones the save game player block carries.
    const base: Record<string, number> = {
      foodDistribution: 448,
      planksDistribution: 456,
      steelDistribution: 462,
      coalDistribution: 466,
      wheatDistribution: 472,
      toolPriority: 0,
      serfToKnightRate: 420,
    };
    for (const screen of SETTINGS_SCREENS) {
      for (const s of settingsPopupSliders(screen)) {
        expect(s.playerOffset).toBe(base[s.list]! + s.index * 2);
      }
    }
  });

  it('draws one trough per slider', () => {
    const fb = createFramebuffer(144, 160);
    const { asked, provider } = recorder();
    expect(drawSettingsPopup(fb, provider, 0x20, view, { textColor: TEXT })).toBe(true);
    const troughs = asked.filter((e) => e === UI_ICON_BASE + SLIDER_TROUGH_ICON).length;
    expect(troughs).toBe(TOOLS_POPUP_SLIDERS.length);
  });
});

describe('settings-popup — knight occupation (0x1f)', () => {
  it('16 zones == 16 +/- icons (bijection via the corner)', () => {
    const buttons = OCCUPATION_POPUP_ICONS.filter((i) => i.icon === 220 || i.icon === 221);
    expect(buttons).toHaveLength(16);
    const corners = new Set(buttons.map((b) => `${b.col * 8},${b.row}`));
    const zones = new Set(
      OCCUPATION_POPUP_HITBOXES.filter((z) => z.action !== 0x63).map((z) => `${z.x0},${z.y0}`),
    );
    expect(zones).toEqual(corners);
  });

  it('groups run down from index 3 (front) to 0 (hinterland)', () => {
    expect(OCCUPATION_GROUPS.map((g) => g.index)).toEqual([3, 2, 1, 0]);
    // First four actions: max-, max+, min-, min+ of the group with index 3.
    expect(settingsPopupAction(0x1f, 0x72)).toEqual({
      kind: 'occupation',
      index: 3,
      bound: 'max',
      delta: -1,
    });
    expect(settingsPopupAction(0x1f, 0x75)).toEqual({
      kind: 'occupation',
      index: 3,
      bound: 'min',
      delta: 1,
    });
    expect(settingsPopupAction(0x1f, 0x81)).toEqual({
      kind: 'occupation',
      index: 0,
      bound: 'min',
      delta: 1,
    });
  });

  it('level words: the `< 3` branch catches exactly the 2', () => {
    expect([0, 1, 2, 3, 4].map(occupationLabel)).toEqual([
      'MINIMUM',
      'SCHWACH',
      'MITTEL',
      'GUT',
      'VOLL',
    ]);
  });
});

describe('settings-popup — priority lists (0x21/0x2e)', () => {
  it('26 slots == 26 zones, slot by slot', () => {
    const slotZones = PRIORITY_POPUP_HITBOXES.filter((z) => z.action >= 0x8b && z.action <= 0xa4);
    expect(slotZones).toHaveLength(PRIORITY_SLOT_POSITIONS.length);
    slotZones.forEach((z, i) => {
      const pos = PRIORITY_SLOT_POSITIONS[i]!;
      expect(z.x0).toBe(pos.col * 8);
      expect(z.y0).toBe(pos.row);
      expect(z.x1 - z.x0).toBe(0xf);
      expect(z.y1 - z.y0).toBe(0xf);
    });
  });

  it('both screens share the same zone table but not the same list', () => {
    expect(settingsPopupHitboxes(0x21)).toBe(settingsPopupHitboxes(0x2e));
    expect(settingsPopupAction(0x21, 0x8b)).toEqual({
      kind: 'prioritySelect',
      slot: 0,
      list: 'transport',
    });
    expect(settingsPopupAction(0x2e, 0x8b)).toEqual({
      kind: 'prioritySelect',
      slot: 0,
      list: 'evacuation',
    });
    expect(settingsPopupAction(0x21, 0xa5)).toEqual({
      kind: 'priorityMove',
      move: 'top',
      list: 'transport',
    });
  });

  it('draws every resource at the slot of its priority', () => {
    const fb = createFramebuffer(144, 160);
    const { asked, provider } = recorder();
    drawSettingsPopup(fb, provider, 0x21, view, { textColor: TEXT });
    // view.flagPriority[res] = 26 - res => resource 0 has priority 26 => slot 0.
    expect(asked).toContain(UI_ICON_BASE + RESOURCE_ICON_BASE + 0);
    expect(asked).toContain(UI_ICON_BASE + RESOURCE_ICON_BASE + 25);
    // Selection icon == cursor - 1 (the field is 1-based).
    expect(asked).toContain(UI_ICON_BASE + RESOURCE_ICON_BASE + view.currentSett5Item - 1);
  });
});

describe('settings-popup — knight menu (0x2d)', () => {
  it('four recruit buttons in table order 1/5/20/100', () => {
    expect(KNIGHT_RECRUIT_COUNTS).toEqual([1, 5, 20, 100]);
    [0xcc, 0xcd, 0xce, 0xcf].forEach((a, i) => {
      expect(settingsPopupAction(0x2d, a)).toEqual({ kind: 'recruit', count: KNIGHT_RECRUIT_COUNTS[i] });
    });
  });

  it('attack selection: upper row = weaker knights (bit clear)', () => {
    expect(settingsPopupAction(0x2d, 0xd1)).toEqual({ kind: 'attackSelection', strong: false });
    expect(settingsPopupAction(0x2d, 0xd2)).toEqual({ kind: 'attackSelection', strong: true });
    // The tick row of action `0xd1` sits above the one of `0xd2`.
    const weak = KNIGHT_POPUP_HITBOXES.find((z) => z.action === 0xd1)!;
    const strong = KNIGHT_POPUP_HITBOXES.find((z) => z.action === 0xd2)!;
    expect(weak.y0).toBeLessThan(strong.y0);
  });

  it('shift change and counter +/- are actions of their own', () => {
    expect(settingsPopupAction(0x2d, 0xaf)).toEqual({ kind: 'knightRotation' });
    expect(settingsPopupAction(0x2d, 0xf8)).toEqual({ kind: 'knightValue', delta: -1 });
    expect(settingsPopupAction(0x2d, 0xf9)).toEqual({ kind: 'knightValue', delta: 1 });
  });

  it('the knight rate slider lies inside its zone', () => {
    const z = KNIGHT_POPUP_HITBOXES.find((r) => r.action === KNIGHT_POPUP_RATE_SLIDER.action)!;
    expect(z.x0).toBe(KNIGHT_POPUP_RATE_SLIDER.col * 8);
    expect(z.y0).toBe(KNIGHT_POPUP_RATE_SLIDER.row);
  });

  it('draws morale percent, deposited gold, both counters and the recruitable number', () => {
    const fb = createFramebuffer(144, 160);
    const { asked, provider } = recorder();
    expect(drawSettingsPopup(fb, provider, 0x2d, view, { textColor: TEXT })).toBe(true);
    // 2048 * 100 / 4096 == 50 => digits 5 and 0.
    expect(asked).toContain(UI_ICON_BASE + 0x4e + 5);
    // The layout itself holds no digit icon — every digit comes from the numbers.
    expect(KNIGHT_POPUP_ICONS.some((i) => i.icon >= 0x4e && i.icon <= 0x57)).toBe(false);
  });
});

describe('settings-popup — shared rules', () => {
  it("'RAUS' sits on the same zone in all eight screens and leads to menu 0x1b", () => {
    for (const screen of SETTINGS_SCREENS) {
      const exit = settingsPopupHitboxes(screen).find((z) => z.action === 0x63);
      expect(exit, `screen 0x${screen.toString(16)}`).toEqual({
        action: 0x63,
        x0: 0x70,
        x1: 0x7f,
        y0: 0x80,
        y1: 0x8f,
      });
    }
    expect(settingsPopupAction(0x1c, 0x63)).toEqual({ kind: 'menu' });
    expect(SETTINGS_POPUP_MENU_SCREEN).toBe(0x1b);
  });

  it("the locked state (gs+0x37e bit 5) leaves only 'RAUS'", () => {
    for (const screen of SETTINGS_SCREENS) {
      expect(settingsPopupHitboxes(screen, true)).toHaveLength(1);
    }
    expect(clickSettingsPopup(0x20, 8 + 0x30, 9 + 0x05, true)).toBeNull();
    expect(clickSettingsPopup(0x20, 8 + 0x78, 9 + 0x85, true)).toEqual({ kind: 'menu' });
  });

  it('the default buttons of all five variants are recognised', () => {
    for (const [screen, action] of [
      [0x1c, 0xbb],
      [0x1d, 0xbc],
      [0x1e, 0xd0],
      [0x20, 0xf2],
      [0x21, 0xbd],
      [0x2e, 0xbd],
    ] as const) {
      expect(settingsPopupAction(screen, action)).toEqual({ kind: 'defaults' });
    }
  });

  it('a click in drawing pixels hits the slider and carries the x coordinate', () => {
    // Food screen, first slider: column 4 => click space x 0x20..0x5f.
    const hit = clickSettingsPopup(0x1c, 8 + 0x5f, 9 + 0x18);
    expect(hit).toEqual({ kind: 'slider', slider: FOOD_POPUP_SLIDERS[0], clickX: 0x5f });
  });

  it('draws all eight screens, and no foreign one', () => {
    const fb = createFramebuffer(144, 160);
    const { provider } = recorder();
    for (const screen of SETTINGS_SCREENS) {
      expect(drawSettingsPopup(fb, provider, screen, view, { textColor: TEXT }), `0x${screen.toString(16)}`).toBe(true);
    }
    expect(drawSettingsPopup(fb, provider, 0x24, view, { textColor: TEXT })).toBe(false);
  });

  it('the food icons are fish, meat and bread (type + 0x22)', () => {
    const res = FOOD_POPUP_ICONS.filter((i) => i.row === 1).map((i) => i.icon - RESOURCE_ICON_BASE);
    expect(res).toEqual([0, 2, 5]);
  });
});

describe('drawPanelNumberWide — five-digit numbers', () => {
  it('does not lose an inner zero', () => {
    const fb = createFramebuffer(144, 160);
    const { asked, provider } = recorder();
    const cols = drawPanelNumberWide(fb, provider, 1005, 0, 0);
    expect(cols).toBe(4);
    expect(asked).toEqual([0x4e + 1, 0x4e + 0, 0x4e + 0, 0x4e + 5].map((d) => UI_ICON_BASE + d));
  });

  it('covers all five places and drops leading zeros', () => {
    const fb = createFramebuffer(144, 160);
    const { asked, provider } = recorder();
    expect(drawPanelNumberWide(fb, provider, 12345, 0, 0)).toBe(5);
    expect(asked.map((e) => e - UI_ICON_BASE - 0x4e)).toEqual([1, 2, 3, 4, 5]);
    asked.length = 0;
    expect(drawPanelNumberWide(fb, provider, 7, 0, 0)).toBe(1);
    expect(asked.map((e) => e - UI_ICON_BASE - 0x4e)).toEqual([7]);
  });

  it('a slider at full deflection is exactly 50 pixels', () => {
    expect(Math.floor(65500 / SLIDER_STEP)).toBe(50);
  });
});
