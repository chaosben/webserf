import { describe, it, expect } from 'vitest';
import {
  ATTACK_POPUP_BAND_COLS,
  ATTACK_POPUP_BAND_ROW,
  ATTACK_POPUP_BG_ICON,
  ATTACK_POPUP_BUTTONS,
  ATTACK_POPUP_HITBOXES,
  ATTACK_POPUP_SCENERY,
  attackPopupAction,
  attackPopupTargetSprite,
  drawAttackPopup,
} from './attack-popup.js';
import { UI_DIGIT_ICON_BASE, UI_ICON_BASE, UI_OBJECT_BASE, createFramebuffer } from './ui-render.js';
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

describe('attack-popup — screen 0x14/0x15 (attack)', () => {
  it('target building: its own sprite and row per type', () => {
    expect(attackPopupTargetSprite(0x2c)).toEqual({ sprite: 0xab, row: 0x32 }); // hut
    expect(attackPopupTargetSprite(0x54)).toEqual({ sprite: 0x9e, row: 0x20 }); // tower
    expect(attackPopupTargetSprite(0x58)).toEqual({ sprite: 0x98, row: 0x11 }); // fortress
    expect(attackPopupTargetSprite(0x60)).toEqual({ sprite: 0xb2, row: 0 }); //    castle
  });

  it('every button has exactly one click zone (and vice versa)', () => {
    expect(ATTACK_POPUP_BUTTONS).toHaveLength(8);
    expect(ATTACK_POPUP_HITBOXES).toHaveLength(8);
    // Bijection over the top left corner — click space = drawing pixel - (8, 9).
    const corners = new Set(ATTACK_POPUP_BUTTONS.map((b) => `${b.col * 8},${b.row}`));
    const zones = new Set(ATTACK_POPUP_HITBOXES.map((z) => `${z.x0},${z.y0}`));
    expect(zones).toEqual(corners);
    // The attack button is four columns wide, all others one.
    const launch = ATTACK_POPUP_HITBOXES.find((z) => z.action === 0x4c)!;
    expect(launch.x1 - launch.x0 + 1).toBe(32);
    for (const z of ATTACK_POPUP_HITBOXES.filter((z) => z.action !== 0x4c)) {
      expect(z.x1 - z.x0 + 1).toBe(16);
    }
  });

  it('click mapping: minus, plus, attack, exit and the four presets', () => {
    // Drawing pixels = click space + (8, 9).
    expect(attackPopupAction(0x28, 0x79)).toEqual({ kind: 'decrement', action: 0x4a });
    expect(attackPopupAction(0x58, 0x79)).toEqual({ kind: 'increment', action: 0x4b });
    expect(attackPopupAction(0x08, 0x89)).toEqual({ kind: 'launch', action: 0x4c });
    expect(attackPopupAction(0x78, 0x89)).toEqual({ kind: 'close', action: 0x4d });
    // The four presets accumulate: button n => sum of the first n bands.
    for (const [x, bands] of [[0x10, 1], [0x30, 2], [0x50, 3], [0x70, 4]] as const) {
      expect(attackPopupAction(x, 0x59)).toEqual({ kind: 'preset', action: 0xd3 + bands - 1, bands });
    }
    expect(attackPopupAction(70, 20)).toBeNull();
  });

  it('draws backdrop, target, buttons and five numbers', () => {
    const { asked, provider } = recorder();
    drawAttackPopup(createFramebuffer(144, 160), provider, {
      targetCodedType: 0x54,
      bands: [3, 0, 12, 7],
      chosen: 6,
    });
    expect(asked.filter((e) => e === UI_ICON_BASE + ATTACK_POPUP_BG_ICON).length).toBeGreaterThan(0);
    for (const it of ATTACK_POPUP_SCENERY) expect(asked).toContain(UI_OBJECT_BASE + it.icon);
    for (const it of ATTACK_POPUP_BUTTONS) expect(asked).toContain(UI_ICON_BASE + it.icon);
    expect(asked).toContain(UI_OBJECT_BASE + 0x9e); // tower as the target
    // Numbers as digit icons: 3, 0, 1|2, 7 and the choice 6.
    for (const d of [3, 0, 1, 2, 7, 6]) expect(asked).toContain(UI_ICON_BASE + UI_DIGIT_ICON_BASE + d);
  });

  it('the four band numbers sit below their buttons', () => {
    expect(ATTACK_POPUP_BAND_COLS).toEqual([1, 5, 9, 13]);
    const presetCols = ATTACK_POPUP_BUTTONS.slice(0, 4).map((b) => b.col);
    expect(ATTACK_POPUP_BAND_COLS).toEqual(presetCols);
    expect(ATTACK_POPUP_BAND_ROW).toBeGreaterThan(ATTACK_POPUP_BUTTONS[0]!.row);
  });
});
