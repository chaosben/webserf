/**
 * **Demolish confirmation (popup screen 0x37)** — renderer `FUN_00038219` @0x38219, click zones
 * `@0x2c6f6`.
 *
 * The window is the second path of control-bar icon `0x06` (demolish). Its branch (the
 * `icon_dispatch` @0x2925a chain) decides **after the build-site classification**:
 *
 * ```
 * if (!(vp[1] & 8)) return;                 // special click only (manual p. 44)
 * classify_build_site()
 * if (player[0x100] == 2) return FUN_00048c8a();   // cursor type 2 = flag -> demolish IMMEDIATELY
 * vp[0x70] = 0x37                                  // otherwise: this window
 * ```
 *
 * A flag therefore vanishes without asking, a **building** only after the confirm button is
 * clicked. That button is the only action of the window that does anything.
 *
 * ## Zones (`@0x2c6f6`, 5-byte entries `{action, x0, x1, y0, y1}`, `0xFF`-terminated)
 *
 * | Action | Rectangle | Handler | Effect |
 * |---|---|---|---|
 * | `0x27` | 112..127 x 128..143 | `@0x2827c` | close only (a copy of `close_popup_restore_bar`) |
 * | `0xfe` | 56..71 x 45..60 | `@0x2d648` | **`FUN_00048c8a`** (demolish), then the same close |
 *
 * The two rectangles coincide exactly with the two drawn buttons (`col*8 = x0`, `row = y0`) — which
 * is also the proof that the parameter order of `draw_panel_icon` here is `(col, row, icon)` and not
 * the other way round.
 */

import {
  drawPanelIcon,
  drawPanelText,
  hitTestPanel,
  tileBackground,
  type Framebuffer,
  type HitRect,
  type SpriteProvider,
} from './ui-render.js';
import { t } from './language.js';

/** Popup screen number of the demolish confirmation. */
export const DEMOLISH_SCREEN = 0x37;

/** Background tile (`draw_popup_background(0x13a)`) — the same as the message window's. */
export const DEMOLISH_BG_ICON = 0x13a;

/** "RAUS" button at the bottom right (`draw_panel_icon(col 0xe, row 0x80, icon 0x3c)`). */
export const DEMOLISH_CLOSE_ICON = { icon: 0x3c, col: 0xe, row: 0x80 } as const;

/** Confirm button in the middle of the window (`draw_panel_icon(col 7, row 0x2d, icon 0x120)`). */
export const DEMOLISH_CONFIRM_ICON = { icon: 0x120, col: 7, row: 0x2d } as const;

/**
 * The four text lines with their row positions (`draw_popup_panel_text(col 0, row ...)`). The
 * spacing is **not** even: the confirm button sits between line 2 and line 3.
 */
export const DEMOLISH_LINES: readonly { readonly text: string; readonly row: number }[] = [
  { text: '     ABRISS:', row: 0x0a },
  { text: 'KLICKEN SIE HIER', row: 0x1e },
  { text: 'WENN SIE SICHER', row: 0x3c },
  { text: '      SIND', row: 0x4e },
];

/** Action id of the confirm button (`FUN_00048c8a` + close). */
export const DEMOLISH_ACTION_CONFIRM = 0xfe;
/** Action id of the exit button (close only). */
export const DEMOLISH_ACTION_CLOSE = 0x27;

/** Click zones `@0x2c6f6`, in table order. */
export const DEMOLISH_HITBOXES: readonly HitRect[] = [
  { action: DEMOLISH_ACTION_CLOSE, x0: 112, x1: 127, y0: 128, y1: 143 },
  { action: DEMOLISH_ACTION_CONFIRM, x0: 56, x1: 71, y0: 45, y1: 60 },
];

/** Draws the demolish confirmation (port of `FUN_00038219`). */
export function drawDemolishPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  textColor: readonly [number, number, number],
): void {
  tileBackground(fb, provider, DEMOLISH_BG_ICON);
  drawPanelIcon(fb, provider, DEMOLISH_CLOSE_ICON.icon, DEMOLISH_CLOSE_ICON.col, DEMOLISH_CLOSE_ICON.row);
  drawPanelIcon(fb, provider, DEMOLISH_CONFIRM_ICON.icon, DEMOLISH_CONFIRM_ICON.col, DEMOLISH_CONFIRM_ICON.row);
  for (const l of DEMOLISH_LINES) drawPanelText(fb, provider, t(l.text), 0, l.row, textColor);
}

/** Click on the demolish confirmation -> action id (`null` = no zone hit). */
export function clickDemolishPopup(drawX: number, drawY: number): number | null {
  return hitTestPanel(DEMOLISH_HITBOXES, drawX, drawY);
}
