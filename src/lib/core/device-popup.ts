/**
 * **The device screen** (screen 0x3c) — configure joystick or serial mouse.
 *
 * | renderer | click walker | zones | actions |
 * |---|---|---|---|
 * | `FUN_0003b3e6` | `FUN_0002c307` | `@0x2c6c6`, 7 | `0xa4 0xa3 0xa2 0xa1 0xa0 0x9f 0x9e` |
 *
 * Reached through zone `0xf5` of the options window (screen 0x25, `@0x2d5de`) — the zone that fills
 * the working copy `gs+0x2dc..0x2e1` from the effective values `gs+0x3c8..0x3cd`.
 *
 * What the screen means and which values it holds lives in `engine/device-options.ts`; here are only
 * layout, labels, click zones and the drawing.
 *
 * ## The screen has two faces
 *
 * The renderer branches on the device value of the working copy: at `0` it shows `JOYSTICK` with
 * speed and tolerance, otherwise `MAUS  MODUS:` with the protocol name, COM port and IRQ. The
 * **seven icons are the same in both cases** (the layout table `@0x3b620` is drawn before the
 * branch) — only the labels and the two numbers change, and with them the effect of the four
 * `-`/`+` buttons.
 */

import {
  drawLayout,
  drawPanelNumber,
  drawPanelText,
  hitTestPanel,
  tileBackground,
  UI_ICON_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';
import {
  DEVICE_MODE_MICROSOFT,
  isJoystickMode,
  joystickSpeedDisplay,
  type DeviceOptions,
  type DeviceRow,
} from './engine/device-options.js';
import { t } from './language.js';

/** Background tile (`draw_popup_background(0x136)`) — the same as the options window's. */
export const DEVICE_POPUP_BG_ICON = 0x136;

/** Screen number of this module. */
export const DEVICE_SCREEN = 0x3c;

/**
 * Layout table `@0x3b620`, verbatim in renderer order: device switch, twice `-`/`+`, the confirm
 * button and 'RAUS'. Format as everywhere `(icon, col, row)`, a negative icon terminates.
 */
export const DEVICE_POPUP_LAYOUT: readonly LayoutItem[] = [
  { icon: 0x3d, col: 1, row: 0x10 }, // cycle device
  { icon: 0xdc, col: 1, row: 0x30 }, // upper number -
  { icon: 0xdd, col: 3, row: 0x30 }, // upper number +
  { icon: 0xdc, col: 1, row: 0x50 }, // lower number -
  { icon: 0xdd, col: 3, row: 0x50 }, // lower number +
  { icon: 0xe0, col: 1, row: 0x70 }, // confirm + write DEVICE.CFG
  { icon: 0x3c, col: 14, row: 0x80 }, // exit
];

/** One label of the screen. */
export interface DeviceLabel {
  readonly text: string;
  readonly col: number;
  readonly row: number;
}

/** Position of the two numbers — the same in both faces. */
export const DEVICE_NUMBER_TOP = { col: 10, row: 0x39 } as const;
export const DEVICE_NUMBER_BOTTOM = { col: 10, row: 0x59 } as const;

/** Joystick face: `@0x3b5ca` / `@0x3b5f7` / `@0x3b602`. */
export const DEVICE_LABELS_JOYSTICK: readonly DeviceLabel[] = [
  { text: 'JOYSTICK', col: 4, row: 0x14 },
  { text: 'GESCHWIND.', col: 6, row: 0x30 },
  { text: 'TOLERANZ:', col: 6, row: 0x50 },
];

/** Mouse face: head line `@0x3b5d3`, then the protocol name, then `@0x3b60c` / `@0x3b615`. */
export const DEVICE_LABEL_MOUSE_HEAD: DeviceLabel = { text: 'MAUS  MODUS:', col: 4, row: 0x10 };
/** `@0x3b5e0` for device 1, `@0x3b5ea` otherwise — the line below. */
export const DEVICE_LABEL_MICROSOFT: DeviceLabel = { text: 'MICROSOFT', col: 4, row: 0x19 };
export const DEVICE_LABEL_MOUSESYSTEMS: DeviceLabel = { text: 'MOUSESYSTEMS', col: 4, row: 0x19 };
export const DEVICE_LABELS_MOUSE: readonly DeviceLabel[] = [
  { text: 'COM-PORT', col: 6, row: 0x30 },
  { text: 'IRQ-NUMMER', col: 6, row: 0x50 },
];

// --- click table (verbatim) ----------------------------------------------------------------------

/** Table `@0x2c6c6`, seven zones in the format `{action, x0, x1, y0, y1}`. */
export const DEVICE_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0xa4, x0: 8, x1: 23, y0: 16, y1: 31 }, // cycle device
  { action: 0xa3, x0: 8, x1: 23, y0: 48, y1: 63 }, // upper number -
  { action: 0xa2, x0: 24, x1: 39, y0: 48, y1: 63 }, // upper number +
  { action: 0xa1, x0: 8, x1: 23, y0: 80, y1: 95 }, // lower number -
  { action: 0xa0, x0: 24, x1: 39, y0: 80, y1: 95 }, // lower number +
  { action: 0x9f, x0: 8, x1: 39, y0: 112, y1: 127 }, // confirm
  { action: 0x9e, x0: 112, x1: 127, y0: 128, y1: 143 }, // exit
];

// --- actions -------------------------------------------------------------------------------------

export type DevicePopupAction =
  /** `0xa4` — cycle the device (joystick -> Microsoft -> Mousesystems -> joystick). */
  | { readonly kind: 'cycleMode' }
  /**
   * `0xa3`/`0xa2`/`0xa1`/`0xa0` — one of the two numbers by one step. Which field is meant is decided
   * by the device value only (`stepDeviceValue`), like the single test `@0x2f333` in the original.
   */
  | { readonly kind: 'step'; readonly row: DeviceRow; readonly delta: -1 | 1 }
  /** `0x9f` — apply the working copy; the original also restarts the driver and writes `DEVICE.CFG`. */
  | { readonly kind: 'commit' }
  /** `0x9e` — the exit button (`FUN_0002e613`), discards the working copy. */
  | { readonly kind: 'close' };

/**
 * Action id -> effect. In the original the seven ids are only thunks setting a running index and
 * falling into the shared dispatcher; its cascade `@0x2f196` / `@0x2f328` gives them meaning. The
 * index runs **backwards** relative to the id:
 *
 * | action | `vreg0` | effect |
 * |---|---|---|
 * | `0xa4` | 1 | cycle device (`@0x2f196`) |
 * | `0xa3` | 2 | upper number - |
 * | `0xa2` | 3 | upper number + |
 * | `0xa1` | 4 | lower number - |
 * | `0xa0` | 5 | lower number + |
 * | `0x9f` | 6 | confirm (`@0x2f1cc`) |
 * | `0x9e` | 7 | exit (`@0x2f31d`) |
 */
export function devicePopupAction(action: number): DevicePopupAction | null {
  switch (action) {
    case 0xa4:
      return { kind: 'cycleMode' };
    case 0xa3:
      return { kind: 'step', row: 0, delta: -1 };
    case 0xa2:
      return { kind: 'step', row: 0, delta: 1 };
    case 0xa1:
      return { kind: 'step', row: 1, delta: -1 };
    case 0xa0:
      return { kind: 'step', row: 1, delta: 1 };
    case 0x9f:
      return { kind: 'commit' };
    case 0x9e:
      return { kind: 'close' };
    default:
      return null;
  }
}

/** Click in **drawing pixels** -> action (`null` outside every zone). */
export function clickDevicePopup(drawX: number, drawY: number): DevicePopupAction | null {
  const id = hitTestPanel(DEVICE_POPUP_HITBOXES, drawX, drawY);
  if (id === null) return null;
  return devicePopupAction(id);
}

// --- drawing -------------------------------------------------------------------------------------

export interface DevicePopupOptions {
  readonly textColor: readonly [number, number, number];
}

/**
 * Draw screen 0x3c — `FUN_0003b3e6`, element by element in renderer order: background, the seven
 * icons, then the device-dependent face.
 *
 * `working` is the **working copy** (`gs+0x2dc..0x2e1`), not the effective values — the screen always
 * shows the state that has not been confirmed yet.
 */
export function drawDevicePopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  working: DeviceOptions,
  opts: DevicePopupOptions,
): void {
  tileBackground(fb, provider, DEVICE_POPUP_BG_ICON);
  drawLayout(fb, provider, DEVICE_POPUP_LAYOUT, UI_ICON_BASE);
  const text = (l: DeviceLabel): void => drawPanelText(fb, provider, t(l.text), l.col, l.row, opts.textColor);
  if (isJoystickMode(working.mode)) {
    for (const l of DEVICE_LABELS_JOYSTICK) text(l);
    drawPanelNumber(
      fb,
      provider,
      joystickSpeedDisplay(working.speed),
      DEVICE_NUMBER_TOP.col,
      DEVICE_NUMBER_TOP.row,
    );
    drawPanelNumber(
      fb,
      provider,
      working.tolerance,
      DEVICE_NUMBER_BOTTOM.col,
      DEVICE_NUMBER_BOTTOM.row,
    );
    return;
  }
  text(DEVICE_LABEL_MOUSE_HEAD);
  text(working.mode === DEVICE_MODE_MICROSOFT ? DEVICE_LABEL_MICROSOFT : DEVICE_LABEL_MOUSESYSTEMS);
  for (const l of DEVICE_LABELS_MOUSE) text(l);
  drawPanelNumber(fb, provider, working.comPort, DEVICE_NUMBER_TOP.col, DEVICE_NUMBER_TOP.row);
  drawPanelNumber(fb, provider, working.irq, DEVICE_NUMBER_BOTTOM.col, DEVICE_NUMBER_BOTTOM.row);
}
