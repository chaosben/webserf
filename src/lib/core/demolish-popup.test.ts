import { describe, it, expect } from 'vitest';
import {
  DEMOLISH_ACTION_CLOSE,
  DEMOLISH_ACTION_CONFIRM,
  DEMOLISH_CLOSE_ICON,
  DEMOLISH_CONFIRM_ICON,
  DEMOLISH_HITBOXES,
  DEMOLISH_LINES,
  DEMOLISH_SCREEN,
  clickDemolishPopup,
} from './demolish-popup.js';
import { PANEL_CLICK_ORIGIN_X, PANEL_CLICK_ORIGIN_Y } from './ui-render.js';

/**
 * The byte comparison against the original binary runs elsewhere — for a table port that is the
 * sharper check. What remains here is what the table does NOT say: that the two zones sit on their
 * buttons and that the click path hits both.
 */
describe('demolish-popup — demolish confirmation (screen 0x37)', () => {
  it('has exactly two zones, each on its drawn button', () => {
    expect(DEMOLISH_SCREEN).toBe(0x37);
    expect(DEMOLISH_HITBOXES).toHaveLength(2);
    for (const [action, icon] of [
      [DEMOLISH_ACTION_CLOSE, DEMOLISH_CLOSE_ICON],
      [DEMOLISH_ACTION_CONFIRM, DEMOLISH_CONFIRM_ICON],
    ] as const) {
      const z = DEMOLISH_HITBOXES.find((r) => r.action === action)!;
      expect(z.x0).toBe(icon.col * 8);
      expect(z.y0).toBe(icon.row);
      expect(z.x1 - z.x0).toBe(15); // 16×16-Knopf
      expect(z.y1 - z.y0).toBe(15);
    }
  });

  it('hits both buttons in drawing pixels and nothing in between', () => {
    const hit = (col: number, row: number): number | null =>
      clickDemolishPopup(col * 8 + PANEL_CLICK_ORIGIN_X + 4, row + PANEL_CLICK_ORIGIN_Y + 4);
    expect(hit(DEMOLISH_CONFIRM_ICON.col, DEMOLISH_CONFIRM_ICON.row)).toBe(DEMOLISH_ACTION_CONFIRM);
    expect(hit(DEMOLISH_CLOSE_ICON.col, DEMOLISH_CLOSE_ICON.row)).toBe(DEMOLISH_ACTION_CLOSE);
    expect(hit(0, 0)).toBeNull(); // Textzeile
    expect(hit(7, 0x70)).toBeNull(); // empty area below the button
  });

  it('puts the confirm button between the second and third text line', () => {
 // That is why the line spacing is uneven (10 / 30 / 60 / 78) — distributing the lines evenly
 // when porting would have pushed them under the button.
    expect(DEMOLISH_LINES.map((l) => l.row)).toEqual([0x0a, 0x1e, 0x3c, 0x4e]);
    expect(DEMOLISH_CONFIRM_ICON.row).toBeGreaterThan(DEMOLISH_LINES[1]!.row);
 // The bottom edge of the button (45+15 = 60) meets the third line exactly.
    expect(DEMOLISH_CONFIRM_ICON.row + 15).toBe(DEMOLISH_LINES[2]!.row);
  });
});
