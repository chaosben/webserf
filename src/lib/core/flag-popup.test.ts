import { describe, it, expect } from 'vitest';
import {
  FLAG_POPUP_ACTIONS,
  FLAG_POPUP_BG_ICON,
  FLAG_POPUP_EXIT_COL,
  FLAG_POPUP_EXIT_ROW,
  FLAG_POPUP_FLAG_BASE,
  FLAG_POPUP_GEOLOGIST_COL,
  FLAG_POPUP_GEOLOGIST_ROW,
  FLAG_POPUP_HITBOXES,
  FLAG_POPUP_HITBOXES_VIEW_ONLY,
  FLAG_POPUP_ROAD_ICON,
  FLAG_POPUP_ROAD_ICON_CARRIER,
  FLAG_POPUP_ROAD_ROSE,
  drawFlagPopup,
  flagPopupAction,
} from './flag-popup.js';
import { UI_ICON_BASE, UI_OBJECT_BASE, createFramebuffer } from './ui-render.js';
import type { DecodedSprite } from './types.js';

/**
 * Flag window (screen 0x2a) — the tables are byte transcriptions (`@0x3b3be` road wreath, `@0x2c7ea`
 * click zones). Both are checked through the order of the sprite requests: which icon per direction,
 * and that the carrier state switches it.
 */
describe('flag-popup — screen 0x2a (resource transport)', () => {
  const sprite = {
    width: 2,
    height: 2,
    offsetX: 0,
    offsetY: 0,
    deltaX: 0,
    deltaY: 0,
    pixels: new Uint8ClampedArray(16).fill(255),
  } as unknown as DecodedSprite;

  function render(
    paths: readonly boolean[],
    transporters: readonly boolean[],
    opts: { playerColor?: number; attachRoad?: boolean } = {},
  ): number[] {
    const asked: number[] = [];
    const provider = (entry: number) => {
      asked.push(entry);
      return sprite;
    };
    const fb = createFramebuffer(144, 160);
    drawFlagPopup(fb, provider, { paths, transporters }, { ...opts, textColor: [115, 179, 67] });
    return asked;
  }

  const none = [false, false, false, false, false, false];

  it('road wreath: one symbol per road, a carrier switches 0xdc -> 0x120', () => {
    // Direction 3 (Left) only, without a carrier.
    let asked = render([false, false, false, true, false, false], none);
    expect(asked).toContain(UI_ICON_BASE + FLAG_POPUP_ROAD_ICON);
    expect(asked).not.toContain(UI_ICON_BASE + FLAG_POPUP_ROAD_ICON_CARRIER);

    // The same direction WITH a carrier => only the carrier symbol.
    asked = render([false, false, false, true, false, false], [false, false, false, true, false, false]);
    expect(asked).toContain(UI_ICON_BASE + FLAG_POPUP_ROAD_ICON_CARRIER);
    expect(asked).not.toContain(UI_ICON_BASE + FLAG_POPUP_ROAD_ICON);

    // Without roads not a single road symbol (the wreath hangs on `flag+3` alone).
    asked = render(none, [true, true, true, true, true, true]);
    expect(asked).not.toContain(UI_ICON_BASE + FLAG_POPUP_ROAD_ICON);
    expect(asked).not.toContain(UI_ICON_BASE + FLAG_POPUP_ROAD_ICON_CARRIER);
  });

  it('the road wreath sits on the six positions of table @0x3b3be', () => {
    // The wreath is a hexagon around the flag: three rows (24/44/64), mirrored left/right.
    expect(FLAG_POPUP_ROAD_ROSE).toHaveLength(6);
    expect(FLAG_POPUP_ROAD_ROSE[5]).toEqual({ col: 9, row: 24 }); // Up
    expect(FLAG_POPUP_ROAD_ROSE[4]).toEqual({ col: 5, row: 24 }); // UpLeft
    expect(FLAG_POPUP_ROAD_ROSE[3]).toEqual({ col: 3, row: 44 }); // Left
    expect(FLAG_POPUP_ROAD_ROSE[2]).toEqual({ col: 5, row: 64 }); // Down
    expect(FLAG_POPUP_ROAD_ROSE[1]).toEqual({ col: 9, row: 64 }); // DownRight
    expect(FLAG_POPUP_ROAD_ROSE[0]).toEqual({ col: 11, row: 44 }); // Right
    // Opposite directions are point symmetric about the flag column (8) — Up vs. Down and so on.
    for (const [a, b] of [[5, 2], [4, 1], [3, 0]]) {
      expect(FLAG_POPUP_ROAD_ROSE[a]!.col + FLAG_POPUP_ROAD_ROSE[b]!.col).toBe(14);
    }
  });

  it('the flag comes from the object bank in the player colour (0x80 + 4*colour)', () => {
    for (const color of [0, 1, 2, 3]) {
      const asked = render(none, none, { playerColor: color });
      expect(asked).toContain(UI_OBJECT_BASE + FLAG_POPUP_FLAG_BASE + 4 * color);
    }
  });

  it('background, geologist and exit are always drawn, demolish only on request', () => {
    const withoutRaze = render(none, none);
    expect(withoutRaze.filter((e) => e === UI_ICON_BASE + FLAG_POPUP_BG_ICON).length).toBeGreaterThan(0);
    expect(withoutRaze).toContain(UI_ICON_BASE + 0x1c); // geologist
    expect(withoutRaze).toContain(UI_ICON_BASE + 0x3c); // exit
    expect(withoutRaze).not.toContain(UI_ICON_BASE + 0x135);

    expect(render(none, none, { attachRoad: true })).toContain(UI_ICON_BASE + 0x135);
  });

  it('the click zones cover geologist and exit; `viewOnly` leaves only the exit', () => {
    // Geologist: icon (col 7, row 0x64) -> drawing pixels (64, 109).
    expect(flagPopupAction(64, 109)).toMatchObject({ kind: 'callGeologist' });
    // Exit: (col 14, row 0x80) -> (120, 137).
    expect(flagPopupAction(120, 137)).toMatchObject({ kind: 'close' });
    // The demolish zone only when the symbol is drawn.
    expect(flagPopupAction(64, 60)).toMatchObject({ kind: 'attachRoad' });
    expect(flagPopupAction(64, 60, { attachRoadShown: false })).toBeNull();
    // `gs+0x37e` bit 5 => display only.
    expect(flagPopupAction(64, 109, { viewOnly: true })).toBeNull();
    expect(flagPopupAction(120, 137, { viewOnly: true })).toMatchObject({ kind: 'close' });
    // Empty area.
    expect(flagPopupAction(20, 20)).toBeNull();
  });

  it('every zone has a handler; zones sit on their icons', () => {
    for (const h of [...FLAG_POPUP_HITBOXES, ...FLAG_POPUP_HITBOXES_VIEW_ONLY]) {
      expect(FLAG_POPUP_ACTIONS.get(h.action)).toBeDefined();
      expect(h.x1).toBeLessThanOrEqual(0x7f);
      expect(h.y1).toBeLessThanOrEqual(0x8f);
    }
    // Zone corner == icon corner (click space == col*8 / row) for the two always-drawn symbols.
    const corner = (a: number) => FLAG_POPUP_HITBOXES.find((h) => h.action === a)!;
    expect(corner(0xc2).x0).toBe(FLAG_POPUP_GEOLOGIST_COL * 8);
    expect(corner(0xc2).y0).toBe(FLAG_POPUP_GEOLOGIST_ROW);
    expect(corner(0x27).x0).toBe(FLAG_POPUP_EXIT_COL * 8);
    expect(corner(0x27).y0).toBe(FLAG_POPUP_EXIT_ROW);
  });
});
