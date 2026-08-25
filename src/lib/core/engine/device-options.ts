/**
 * Input device configuration - the state behind the device screen (screen 0x3c): joystick or serial
 * mouse, with the hardware parameters that go with it. The confirm button writes them to `DEVICE.CFG`.
 *
 * It is easy to mistake for a priority list, because its seven action thunks share a common preamble
 * with the priority screens and only branch apart on the screen number.
 *
 * | Field | Working copy | Live value | Default | Displayed |
 * |---|---|---|---|---|
 * | device (0 joystick, 1 Microsoft, 2 Mousesystems) | `gs+0x2dc` | `gs+0x3c8` | 0 | the heading |
 * | joystick tolerance | `gs+0x2dd` | `gs+0x3c9` | 0x19 = 25 | number at the bottom |
 * | joystick speed (u16) | `gs+0x2de` | `gs+0x3ca` | 0x1000 | high byte = 16 |
 * | COM port | `gs+0x2e0` | `gs+0x3cc` | 2 | number at the top |
 * | IRQ number | `gs+0x2e1` | `gs+0x3cd` | 3 | number at the bottom |
 *
 * The screen works exclusively on the working copy; the options popup fills it from the live values
 * when opening, and only the confirm button writes back. "RAUS" therefore discards every change - that
 * falls out of the two-buffer structure rather than being an invention.
 *
 * Deliberately not reproduced: the confirm button's four side effects are all DOS hardware (pointer
 * globals, mouse driver reinit, mirroring music and SVGA into the file fields, writing `DEVICE.CFG`).
 * A browser has none of that, so the values stay state and control nothing.
 *
 * A second writer of the same values is the keyboard, whose `+`/`-` keys change the speed during play
 * with the SAME limits as the screen - an independent confirmation of the clamps.
 *
 * The setting belongs to the RIGHT screen half, and that is not decoration: the input routine serves
 * the two split-screen halves one after the other, and only the second branches on the device at all
 * (the left half always uses the system mouse). The five fields are therefore global, unlike the
 * per-half view options, and still only take effect on the right.
 *
 * Still open: whether the joystick uses speed and tolerance at all. The screen shows the two numbers
 * only in the joystick face, but the joystick reader does not touch those globals while the mouse
 * reader reads them six times. Label and consumer are at odds; irrelevant for the port, which passes
 * the values to nothing, hence the neutral name `set_pointer_speed_params`.
 */

/** Joystick (`gs+0x3c8 == 0`) — the default; @0x4e7f asks only about this case. */
export const DEVICE_MODE_JOYSTICK = 0;
/** Serial mouse, Microsoft protocol. */
export const DEVICE_MODE_MICROSOFT = 1;
/** Serial mouse, Mouse Systems protocol. */
export const DEVICE_MODE_MOUSESYSTEMS = 2;
/** The toggle counts up and wraps to 0 at this value (`cmpb $0x3` @0x2f1a9). */
export const DEVICE_MODE_COUNT = 3;

/** The five values of one configuration set (working copy as well as live values). */
export interface DeviceOptions {
  /** `0x2dc`/`0x3c8` — 0 joystick, 1 Microsoft mouse, 2 Mouse Systems mouse. */
  readonly mode: number;
  /** `0x2dd`/`0x3c9` — joystick tolerance (dead zone), 10..75. */
  readonly tolerance: number;
  /** `0x2de`/`0x3ca` — joystick speed as u16; the high byte is what is displayed. */
  readonly speed: number;
  /** `0x2e0`/`0x3cc` — COM port of the serial mouse, 1..4. */
  readonly comPort: number;
  /** `0x2e1`/`0x3cd` — IRQ number of the serial mouse, 2..7. */
  readonly irq: number;
}

/** Factory setting — the branch without `DEVICE.CFG` (@0x2dd5 ... @0x2e09). */
export const DEVICE_OPTIONS_DEFAULT: DeviceOptions = {
  mode: DEVICE_MODE_JOYSTICK,
  tolerance: 0x19,
  speed: 0x1000,
  comPort: 2,
  irq: 3,
};

/**
 * Limits of the four numbers, exactly in the shape of the original: the decrement branches test the
 * **lower bound including the step** (`cmpb $0xb; jb ret`, so only from 11 does it count down to 10),
 * the increment branches test `< upper bound`. Written as pairs so the asymmetry stays visible and
 * nobody smooths it into a `clamp`.
 */
export const JOYSTICK_SPEED_STEP = 0x100;
/** `cmpw $0x1ff` @0x2f349 — below this the speed stays put. */
export const JOYSTICK_SPEED_DEC_FLOOR = 0x1ff;
/** `cmpw $0x4000` @0x2f36a — from here it grows no further. */
export const JOYSTICK_SPEED_INC_CEIL = 0x4000;
/** `cmpb $0xb` @0x2f38b. */
export const JOYSTICK_TOLERANCE_DEC_FLOOR = 0x0b;
/** `cmpb $0x4b` @0x2f3a2. */
export const JOYSTICK_TOLERANCE_INC_CEIL = 0x4b;
/** `cmpb $0x2` @0x2f3bf. */
export const COM_PORT_DEC_FLOOR = 2;
/** `cmpb $0x4` @0x2f3dc. */
export const COM_PORT_INC_CEIL = 4;
/** `cmpb $0x3` @0x2f3f9. */
export const IRQ_DEC_FLOOR = 3;
/** `cmpb $0x7` @0x2f410. */
export const IRQ_INC_CEIL = 7;

/** The screen's two number rows — which fields they drive depends on the device. */
export type DeviceRow = 0 | 1;

/**
 * Advance the device — `addb $0x1` followed by `cmpb $0x3` (@0x2f19f). An equality test rather than
 * `% 3` on purpose: for a value outside 0..2 (from a foreign `DEVICE.CFG`) the original behaves
 * exactly as written here.
 */
export function cycleDeviceMode(mode: number): number {
  const next = (mode + 1) & 0xff;
  return next === DEVICE_MODE_COUNT ? 0 : next;
}

/** Is the screen currently showing the joystick values? (`gs+0x2dc == 0`, @0x2f333.) */
export function isJoystickMode(mode: number): boolean {
  return mode === DEVICE_MODE_JOYSTICK;
}

function step(value: number, delta: -1 | 1, decFloor: number, incCeil: number, size: number): number {
  if (delta === -1) return value >= decFloor ? value - size : value;
  return value < incCeil ? value + size : value;
}

/**
 * A click on one of the four `-`/`+` buttons. Which field is hit is decided by the **device value**,
 * exactly as in the original, which branches once at @0x2f333 and then runs two mirrored cascades of
 * four.
 */
export function stepDeviceValue(
  options: DeviceOptions,
  row: DeviceRow,
  delta: -1 | 1,
): DeviceOptions {
  if (isJoystickMode(options.mode)) {
    if (row === 0) {
      const speed = step(
        options.speed,
        delta,
        JOYSTICK_SPEED_DEC_FLOOR,
        JOYSTICK_SPEED_INC_CEIL,
        JOYSTICK_SPEED_STEP,
      );
      return { ...options, speed };
    }
    const tolerance = step(
      options.tolerance,
      delta,
      JOYSTICK_TOLERANCE_DEC_FLOOR,
      JOYSTICK_TOLERANCE_INC_CEIL,
      1,
    );
    return { ...options, tolerance };
  }
  if (row === 0) {
    const comPort = step(options.comPort, delta, COM_PORT_DEC_FLOOR, COM_PORT_INC_CEIL, 1);
    return { ...options, comPort };
  }
  const irq = step(options.irq, delta, IRQ_DEC_FLOOR, IRQ_INC_CEIL, 1);
  return { ...options, irq };
}

/**
 * The displayed speed is the **high byte** of the u16 (`mov 0x2de,%ax; shr $8` in the renderer,
 * @0x3b48c ff.), which is why the button steps by `0x100` and the display by 1.
 */
export function joystickSpeedDisplay(speed: number): number {
  return (speed >> 8) & 0xff;
}

/**
 * Confirm — the working copy becomes the live values (@0x2f1ea...@0x2f246, field by field). The
 * three hardware side effects of the same handler are not reproduced, see the module head.
 */
export function commitDeviceOptions(working: DeviceOptions): DeviceOptions {
  return { ...working };
}

/** Fill the working copy from the live values — what zone `0xf5` of the options popup does (@0x2d5ec). */
export function loadDeviceWorkingCopy(live: DeviceOptions): DeviceOptions {
  return { ...live };
}
