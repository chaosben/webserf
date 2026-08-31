import { describe, expect, it } from 'vitest';
import {
  SOIL_LEVEL_LABELS,
  SOIL_LEVEL_THRESHOLDS,
  SOIL_POPUP_ACTION_EXIT,
  SOIL_POPUP_BG_ICON,
  SOIL_POPUP_HITBOXES,
  SOIL_POPUP_LAYOUT,
  SOIL_POPUP_ROWS,
  SOIL_POPUP_SCREEN,
  drawSoilPopup,
  soilLevelLabel,
  soilPopupAction,
} from './soil-popup.js';
import { UI_ICON_BASE, createFramebuffer, panelX, panelY } from './ui-render.js';
import type { DecodedSprite } from './types.js';

/** Text colour as in the original (palette index 0x1f of the game palette). */
const TEXT = [115, 179, 67] as const;

function recordingProvider(): { provider: (e: number) => DecodedSprite; entries: number[] } {
  const entries: number[] = [];
  const sprite: DecodedSprite = {
    width: 1,
    height: 1,
    offsetX: 0,
    offsetY: 0,
    deltaX: 0,
    deltaY: 0,
    pixels: new Uint8ClampedArray([255, 255, 255, 255]),
  };
  return {
    provider: (e: number) => {
      entries.push(e);
      return sprite;
    },
    entries,
  };
}

describe('rating scale (FUN_0003eb71)', () => {
  it('exactly one level more than thresholds', () => {
    expect(SOIL_LEVEL_LABELS).toHaveLength(SOIL_LEVEL_THRESHOLDS.length + 2);
  });

  it('0 is the lowest level, 1 is already the next one', () => {
    expect(soilLevelLabel(0)).toBe('UNAUFFINDBAR');
    expect(soilLevelLabel(1)).toBe('MINIMAL');
  });

  it('hits every threshold exactly (the lower edge belongs to the next level)', () => {
    const expected = [
      [99, 'MINIMAL'],
      [100, 'SEHR WENIG'],
      [179, 'SEHR WENIG'],
      [180, 'WENIG'],
      [239, 'WENIG'],
      [240, 'UNTER MITTEL'],
      [299, 'UNTER MITTEL'],
      [300, 'DURCHSCHNITT'],
      [399, 'DURCHSCHNITT'],
      [400, 'UEBER MITTEL'],
      [499, 'UEBER MITTEL'],
      [500, 'VIEL'],
      [599, 'VIEL'],
      [600, 'SEHR VIEL'],
      [799, 'SEHR VIEL'],
      [800, 'EXTREM VIEL'],
      [1998, 'EXTREM VIEL'],
    ] as const;
    for (const [value, label] of expected) expect(soilLevelLabel(value), `${value}`).toBe(label);
  });
});

describe('display weighting (renderer FUN_0003ea6e)', () => {
  it('gold ×2, iron ×1, coal ÷2, granite ×2', () => {
    const [gold, iron, coal, stone] = SOIL_POPUP_ROWS;
    expect(gold!.weigh(100)).toBe(200);
    expect(iron!.weigh(100)).toBe(100);
    expect(coal!.weigh(101)).toBe(50);
    expect(stone!.weigh(100)).toBe(200);
  });

  it('rows are in original order and on the original lines', () => {
    expect(SOIL_POPUP_ROWS.map((r) => r.slot)).toEqual([0, 1, 2, 3]);
    expect(SOIL_POPUP_ROWS.map((r) => r.row)).toEqual([0x36, 0x4a, 0x5e, 0x72]);
  });

  it('the same raw sum is rated differently per mineral', () => {
    // 250 → gold 500 'VIEL', iron 250 'UNTER MITTEL', coal 125 'SEHR WENIG'.
    expect(soilLevelLabel(SOIL_POPUP_ROWS[0]!.weigh(250))).toBe('VIEL');
    expect(soilLevelLabel(SOIL_POPUP_ROWS[1]!.weigh(250))).toBe('UNTER MITTEL');
    expect(soilLevelLabel(SOIL_POPUP_ROWS[2]!.weigh(250))).toBe('SEHR WENIG');
  });
});

describe('layout + click', () => {
  it('six icons: head, four minerals, exit', () => {
    expect(SOIL_POPUP_LAYOUT.map((i) => i.icon)).toEqual([28, 47, 44, 46, 43, 60]);
    // The four mineral symbols sit in the same column, 20 px apart each.
    const rows = SOIL_POPUP_LAYOUT.slice(1, 5).map((i) => i.row);
    expect(rows).toEqual([50, 70, 90, 110]);
    expect(new Set(SOIL_POPUP_LAYOUT.slice(1, 5).map((i) => i.col)).size).toBe(1);
  });

  it('every mineral symbol sits directly above its text', () => {
    for (let i = 0; i < 4; i++) {
      const icon = SOIL_POPUP_LAYOUT[i + 1]!;
      expect(SOIL_POPUP_ROWS[i]!.row - icon.row).toBe(4);
    }
  });

  it('the only click zone covers the exit symbol', () => {
    expect(SOIL_POPUP_HITBOXES).toHaveLength(1);
    const exit = SOIL_POPUP_LAYOUT[5]!;
    const box = SOIL_POPUP_HITBOXES[0]!;
    expect(box.action).toBe(SOIL_POPUP_ACTION_EXIT);
    // The icon's drawing position lies inside the zone (offset by the click origin).
    expect(soilPopupAction(panelX(exit.col), panelY(exit.row))).toBe(SOIL_POPUP_ACTION_EXIT);
    expect(soilPopupAction(panelX(exit.col) - 1, panelY(exit.row))).toBeNull();
  });

  it('a click outside the zone returns null', () => {
    expect(soilPopupAction(0, 0)).toBeNull();
    expect(soilPopupAction(64, 64)).toBeNull();
  });
});

describe('drawSoilPopup', () => {
  it('tiles background 0x81 and draws every layout icon from the icon bank', () => {
    const fb = createFramebuffer(144, 160);
    const { provider, entries } = recordingProvider();
    drawSoilPopup(fb, provider, [0, 0, 0, 0], TEXT);
    expect(entries).toContain(UI_ICON_BASE + SOIL_POPUP_BG_ICON);
    for (const item of SOIL_POPUP_LAYOUT) expect(entries).toContain(UI_ICON_BASE + item.icon);
  });

  it('the screen number is 0x16', () => {
    expect(SOIL_POPUP_SCREEN).toBe(0x16);
  });
});
