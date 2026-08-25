import { describe, expect, it } from 'vitest';
import {
  COM_PORT_INC_CEIL,
  DEVICE_MODE_JOYSTICK,
  DEVICE_MODE_MICROSOFT,
  DEVICE_MODE_MOUSESYSTEMS,
  DEVICE_OPTIONS_DEFAULT,
  IRQ_INC_CEIL,
  JOYSTICK_SPEED_INC_CEIL,
  JOYSTICK_SPEED_STEP,
  JOYSTICK_TOLERANCE_INC_CEIL,
  commitDeviceOptions,
  cycleDeviceMode,
  isJoystickMode,
  joystickSpeedDisplay,
  loadDeviceWorkingCopy,
  stepDeviceValue,
  type DeviceOptions,
} from './device-options.js';

const JOY: DeviceOptions = DEVICE_OPTIONS_DEFAULT;
const MOUSE: DeviceOptions = { ...DEVICE_OPTIONS_DEFAULT, mode: DEVICE_MODE_MICROSOFT };

describe('device switch', () => {
  it('cycles joystick -> Microsoft -> Mousesystems -> joystick (`cmpb $0x3` @0x2f1a9)', () => {
    expect(cycleDeviceMode(DEVICE_MODE_JOYSTICK)).toBe(DEVICE_MODE_MICROSOFT);
    expect(cycleDeviceMode(DEVICE_MODE_MICROSOFT)).toBe(DEVICE_MODE_MOUSESYSTEMS);
    expect(cycleDeviceMode(DEVICE_MODE_MOUSESYSTEMS)).toBe(DEVICE_MODE_JOYSTICK);
  });

  it('tests equality with 3, not modulo - a foreign value keeps walking', () => {
    // A foreign `DEVICE.CFG` can carry a value above 2; the original does NOT wrap then, because
    // `cmpb $0x3` only catches the 3.
    expect(cycleDeviceMode(7)).toBe(8);
  });

  it('only device 0 is the joystick (`@0x4e7f` asks for exactly that)', () => {
    expect(isJoystickMode(DEVICE_MODE_JOYSTICK)).toBe(true);
    expect(isJoystickMode(DEVICE_MODE_MICROSOFT)).toBe(false);
    expect(isJoystickMode(DEVICE_MODE_MOUSESYSTEMS)).toBe(false);
  });
});

describe('Werkseinstellung (Zweig ohne DEVICE.CFG, @0x2dd5…@0x2e09)', () => {
  it('Joystick, Toleranz 25, Geschwindigkeit 0x1000, COM 2, IRQ 3', () => {
    expect(DEVICE_OPTIONS_DEFAULT).toEqual({
      mode: 0,
      tolerance: 0x19,
      speed: 0x1000,
      comPort: 2,
      irq: 3,
    });
  });

  it('the displayed value is the high byte of the speed - 16 from the factory', () => {
    expect(joystickSpeedDisplay(DEVICE_OPTIONS_DEFAULT.speed)).toBe(16);
  });
});

describe('joystick face: the two numbers and their limits', () => {
  it('the speed moves in steps of 0x100', () => {
    expect(stepDeviceValue(JOY, 0, 1).speed).toBe(0x1100);
    expect(stepDeviceValue(JOY, 0, -1).speed).toBe(0x0f00);
  });

  it('nach oben bei 0x4000 (`cmpw $0x4000` @0x2f36a)', () => {
    const at = { ...JOY, speed: JOYSTICK_SPEED_INC_CEIL - JOYSTICK_SPEED_STEP };
    expect(stepDeviceValue(at, 0, 1).speed).toBe(JOYSTICK_SPEED_INC_CEIL);
    expect(stepDeviceValue({ ...JOY, speed: JOYSTICK_SPEED_INC_CEIL }, 0, 1).speed).toBe(
      JOYSTICK_SPEED_INC_CEIL,
    );
  });

  it('nach unten erst ab 0x1ff (`cmpw $0x1ff` @0x2f349) — 0x100 bleibt stehen', () => {
    // The limit is deliberately NOT symmetric: at 0x100 the original refuses the step, even though
    // 0x000 would be representable. A `clamp(0, 0x4000)` would behave differently here.
    expect(stepDeviceValue({ ...JOY, speed: 0x0100 }, 0, -1).speed).toBe(0x0100);
    expect(stepDeviceValue({ ...JOY, speed: 0x0200 }, 0, -1).speed).toBe(0x0100);
  });

  it('the tolerance runs 10..75 (`cmpb $0xb` / `cmpb $0x4b`)', () => {
    expect(stepDeviceValue({ ...JOY, tolerance: 0x0a }, 1, -1).tolerance).toBe(0x0a);
    expect(stepDeviceValue({ ...JOY, tolerance: 0x0b }, 1, -1).tolerance).toBe(0x0a);
    expect(stepDeviceValue({ ...JOY, tolerance: JOYSTICK_TOLERANCE_INC_CEIL }, 1, 1).tolerance).toBe(
      JOYSTICK_TOLERANCE_INC_CEIL,
    );
    expect(
      stepDeviceValue({ ...JOY, tolerance: JOYSTICK_TOLERANCE_INC_CEIL - 1 }, 1, 1).tolerance,
    ).toBe(JOYSTICK_TOLERANCE_INC_CEIL);
  });

  it('in the joystick face the buttons do not touch COM port and IRQ', () => {
    const after = stepDeviceValue(stepDeviceValue(JOY, 0, 1), 1, 1);
    expect(after.comPort).toBe(JOY.comPort);
    expect(after.irq).toBe(JOY.irq);
  });
});

describe('mouse face: same buttons, different fields (@0x2f333)', () => {
  it('the upper button now serves the COM port 1..4', () => {
    expect(stepDeviceValue({ ...MOUSE, comPort: 1 }, 0, -1).comPort).toBe(1);
    expect(stepDeviceValue({ ...MOUSE, comPort: 2 }, 0, -1).comPort).toBe(1);
    expect(stepDeviceValue({ ...MOUSE, comPort: COM_PORT_INC_CEIL }, 0, 1).comPort).toBe(
      COM_PORT_INC_CEIL,
    );
  });

  it('the lower button serves the IRQ number 2..7', () => {
    expect(stepDeviceValue({ ...MOUSE, irq: 2 }, 1, -1).irq).toBe(2);
    expect(stepDeviceValue({ ...MOUSE, irq: 3 }, 1, -1).irq).toBe(2);
    expect(stepDeviceValue({ ...MOUSE, irq: IRQ_INC_CEIL }, 1, 1).irq).toBe(IRQ_INC_CEIL);
  });

  it('in the mouse face speed and tolerance stay untouched', () => {
    const after = stepDeviceValue(stepDeviceValue(MOUSE, 0, 1), 1, 1);
    expect(after.speed).toBe(MOUSE.speed);
    expect(after.tolerance).toBe(MOUSE.tolerance);
  });

  it('Mousesystems bedient dieselben Felder wie Microsoft', () => {
    const ms = { ...MOUSE, mode: DEVICE_MODE_MOUSESYSTEMS };
    expect(stepDeviceValue(ms, 0, 1).comPort).toBe(ms.comPort + 1);
  });
});

describe('working copy and effective values', () => {
  it('changes stay in the working copy until confirmed', () => {
    const working = stepDeviceValue(loadDeviceWorkingCopy(JOY), 0, 1);
    expect(working.speed).not.toBe(JOY.speed);
    expect(JOY.speed).toBe(0x1000); // the effective values are untouched
    expect(commitDeviceOptions(working).speed).toBe(working.speed);
  });

  it('the working copy is its own set, not a shared pointer', () => {
    const live = { ...JOY };
    const working = stepDeviceValue(loadDeviceWorkingCopy(live), 1, 1);
    expect(live.tolerance).toBe(JOY.tolerance);
    expect(working.tolerance).toBe(JOY.tolerance + 1);
  });
});
