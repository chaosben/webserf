import { describe, it, expect } from 'vitest';
import {
  MENU_SCREENS,
  SETTINGS_MENU_ACTIONS,
  SETTINGS_MENU_BG_ICON,
  SETTINGS_MENU_HITBOXES,
  SETTINGS_MENU_LAYOUT,
  SETTINGS_MENU_LAYOUT_FOOTER,
  SETTINGS_MENU_NO_FOOTER_HITBOXES,
  STAT_MENU_ACTIONS,
  STAT_MENU_BG_ICON,
  STAT_MENU_HITBOXES,
  STAT_MENU_LAYOUT,
  drawMenuPopup,
  menuPopupAction,
  menuPopupHitboxes,
} from './menu-popup.js';
import { createFramebuffer, hitTest } from './ui-render.js';
import type { DecodedSprite } from './types.js';

/**
 * The tables are byte transcriptions from the binary (`@0x3d1a2`, `@0x3d1ff`, `@0x3d266`, `@0x2cb1c`,
 * `@0x2ca2b`) — the tests pin them against typos and check that the renderer draws both screens
 * completely (background plus every layout icon).
 */
describe('menu-popup — screens 8 and 0x24', () => {
  it('layout tables: length and endpoints as in the binary', () => {
    expect(STAT_MENU_LAYOUT).toHaveLength(10);
    expect(STAT_MENU_LAYOUT[0]).toEqual({ icon: 0x48, col: 1, row: 12 });
    expect(STAT_MENU_LAYOUT[9]).toEqual({ icon: 0x3c, col: 14, row: 0x80 }); // close
    expect(SETTINGS_MENU_LAYOUT).toHaveLength(10);
    expect(SETTINGS_MENU_LAYOUT[0]).toEqual({ icon: 0xe6, col: 1, row: 8 });
    expect(SETTINGS_MENU_LAYOUT[9]).toEqual({ icon: 0x3c, col: 14, row: 0x80 });
    expect(SETTINGS_MENU_LAYOUT_FOOTER).toHaveLength(3);
    // Both menus share the page icon (0x3d) and the close icon (0x3c) at the same spot.
    expect(STAT_MENU_LAYOUT[8]).toEqual(SETTINGS_MENU_LAYOUT[8]);
    expect(STAT_MENU_BG_ICON).toBe(0x81);
    expect(SETTINGS_MENU_BG_ICON).toBe(0x137);
    expect([...MENU_SCREENS]).toEqual([8, 0x1b, 0x24]);
  });

  it('screen 0x1b is the same menu without the footer — the same table 15 bytes on', () => {
    // Original: screen 0x24 takes `@0x2ca2b`, screen 0x1b `@0x2ca3a` — distance 15 == 3 zones of 5
    // bytes, namely the footer (ENDE / EXTRA OPTION / SICHERN). 0x24 runs into 0x1b.
    expect(SETTINGS_MENU_HITBOXES.slice(0, 3).map((z) => z.action)).toEqual([0xac, 0xad, 0xae]);
    expect(SETTINGS_MENU_NO_FOOTER_HITBOXES).toHaveLength(SETTINGS_MENU_HITBOXES.length - 3);
    expect(menuPopupHitboxes(0x1b)).toEqual(SETTINGS_MENU_NO_FOOTER_HITBOXES);
    // Same action ids means same handlers: "RAUS" and paging behave identically.
    expect(menuPopupAction(0x1b, 8 + 0x78, 9 + 0x85)).toEqual(menuPopupAction(0x24, 8 + 0x78, 9 + 0x85));
    // The footer buttons of 0x24 are not clickable in 0x1b.
    expect(menuPopupAction(0x1b, 8 + 0x10, 9 + 0x85)).toBeNull();
  });

  it('click tables: 10 resp. 13 zones, each exactly on one layout icon', () => {
    expect(STAT_MENU_HITBOXES).toHaveLength(10);
    expect(SETTINGS_MENU_HITBOXES).toHaveLength(13);
    // A hit in the first zone yields its action id (rectangle space, without the (8,9) offset).
    expect(hitTest(STAT_MENU_HITBOXES, 0x10, 0x10)).toBe(0x1d);
    // Between the zones (the gap below the top icon row) nothing is hit.
    expect(hitTest(STAT_MENU_HITBOXES, 0x10, 0x30)).toBeNull();

    // The sharpest evidence that the tables belong to THESE screens: zones and layout icons form a
    // bijection over their top-left corner (`click space == col*8 / row`, see module header). That was
    // exactly not the case for the neighbouring tables (screens 9 / 0x25).
    const corners = (items: readonly { col: number; row: number }[]) =>
      new Set(items.map((i) => `${i.col * 8},${i.row}`));
    const zones = (h: readonly { x0: number; y0: number }[]) =>
      new Set(h.map((z) => `${z.x0},${z.y0}`));
    expect(zones(STAT_MENU_HITBOXES)).toEqual(corners(STAT_MENU_LAYOUT));
    expect(zones(SETTINGS_MENU_HITBOXES)).toEqual(
      corners([...SETTINGS_MENU_LAYOUT, ...SETTINGS_MENU_LAYOUT_FOOTER]),
    );

    // All zones lie inside the 128x144 popup rectangle.
    for (const h of [...STAT_MENU_HITBOXES, ...SETTINGS_MENU_HITBOXES]) {
      expect(h.x0).toBeGreaterThanOrEqual(0);
      expect(h.x1).toBeLessThanOrEqual(0x7f);
      expect(h.y1).toBeLessThanOrEqual(0x8f);
      expect(h.x0).toBeLessThanOrEqual(h.x1);
      expect(h.y0).toBeLessThanOrEqual(h.y1);
    }
  });

  it('actions: every zone has a handler, "RAUS" closes, paging crosses the menus', () => {
    for (const h of STAT_MENU_HITBOXES) expect(STAT_MENU_ACTIONS.get(h.action)).toBeDefined();
    for (const h of SETTINGS_MENU_HITBOXES) expect(SETTINGS_MENU_ACTIONS.get(h.action)).toBeDefined();
    expect(STAT_MENU_ACTIONS.size).toBe(STAT_MENU_HITBOXES.length);
    expect(SETTINGS_MENU_ACTIONS.size).toBe(SETTINGS_MENU_HITBOXES.length);

    // The "RAUS" icon (0x3c) sits in both menus at col 14 / row 0x80, drawing pixel (120, 137).
    expect(menuPopupAction(8, 120, 137)).toEqual({ kind: 'close', action: 0x27, label: 'close' });
    expect(menuPopupAction(0x24, 120, 137)).toEqual({
      kind: 'close',
      action: 0x5c,
      label: 'close',
    });
    // The page icon (0x3d, col 12 / row 0x68 -> (104, 113)) opens the other menu each time.
    expect(menuPopupAction(8, 104, 113)).toMatchObject({ kind: 'page', screen: 0x24 });
    expect(menuPopupAction(0x24, 104, 113)).toMatchObject({ kind: 'page', screen: 8 });

    // Not a menu screen, or a click into nothing: no action.
    expect(menuPopupAction(3, 120, 137)).toBeNull();
    expect(menuPopupAction(8, 24, 57)).toBeNull();
  });

  it('draws the background and every layout icon (call count per sprite)', () => {
    const asked: number[] = [];
    const sprite = {
      width: 2, height: 2, offsetX: 0, offsetY: 0, deltaX: 0, deltaY: 0,
      pixels: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255,
        255, 255, 255, 255, 255, 255, 255, 255]),
    } as unknown as DecodedSprite;
    const provider = (entry: number) => {
      asked.push(entry);
      return sprite;
    };
    const fb = createFramebuffer(144, 160);
    drawMenuPopup(fb, provider, 8);
    // Background icon (9x8 tiles) plus 10 layout icons.
    expect(asked.filter((e) => e === 869 + STAT_MENU_BG_ICON).length).toBeGreaterThan(0);
    for (const it of STAT_MENU_LAYOUT) expect(asked).toContain(869 + it.icon);

    asked.length = 0;
    drawMenuPopup(fb, provider, 0x24);
    expect(asked.filter((e) => e === 869 + SETTINGS_MENU_BG_ICON).length).toBeGreaterThan(0);
    for (const it of [...SETTINGS_MENU_LAYOUT, ...SETTINGS_MENU_LAYOUT_FOOTER]) {
      expect(asked).toContain(869 + it.icon);
    }

    asked.length = 0;
    drawMenuPopup(fb, provider, 0x99); // unknown screen: nothing
    expect(asked).toHaveLength(0);
  });
});
