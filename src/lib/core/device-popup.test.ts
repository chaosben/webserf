import { describe, expect, it } from 'vitest';
import {
  DEVICE_POPUP_HITBOXES,
  DEVICE_POPUP_LAYOUT,
  clickDevicePopup,
  devicePopupAction,
} from './device-popup.js';

describe('Screen 0x3c — Klick-Zonen (`@0x2c6c6`)', () => {
  it('lists the seven zones in table order', () => {
    expect(DEVICE_POPUP_HITBOXES.map((z) => z.action)).toEqual([
      0xa4, 0xa3, 0xa2, 0xa1, 0xa0, 0x9f, 0x9e,
    ]);
  });

  it('jede Zone deckt genau ihr Icon (`x0 == col·8`, `y0 == row`)', () => {
    // The layout table @0x3b620 and the zone table @0x2c6c6 are independent in the binary — that
    // they coincide is the test that neither was transcribed wrongly.
    for (const [i, zone] of DEVICE_POPUP_HITBOXES.entries()) {
      const item = DEVICE_POPUP_LAYOUT[i]!;
      expect(zone.x0).toBe(item.col * 8);
      expect(zone.y0).toBe(item.row);
    }
  });

  it('the confirm button is twice as wide as the others', () => {
    const commit = DEVICE_POPUP_HITBOXES.find((z) => z.action === 0x9f)!;
    expect(commit.x1 - commit.x0).toBe(31);
    const other = DEVICE_POPUP_HITBOXES.find((z) => z.action === 0xa4)!;
    expect(other.x1 - other.x0).toBe(15);
  });
});

describe('Screen 0x3c — Aktionen', () => {
  it('maps the seven ids onto the cascade `@0x2f196`/`@0x2f328`', () => {
    expect(devicePopupAction(0xa4)).toEqual({ kind: 'cycleMode' });
    expect(devicePopupAction(0xa3)).toEqual({ kind: 'step', row: 0, delta: -1 });
    expect(devicePopupAction(0xa2)).toEqual({ kind: 'step', row: 0, delta: 1 });
    expect(devicePopupAction(0xa1)).toEqual({ kind: 'step', row: 1, delta: -1 });
    expect(devicePopupAction(0xa0)).toEqual({ kind: 'step', row: 1, delta: 1 });
    expect(devicePopupAction(0x9f)).toEqual({ kind: 'commit' });
    expect(devicePopupAction(0x9e)).toEqual({ kind: 'close' });
  });

  it('knows no foreign id', () => {
    expect(devicePopupAction(0x9d)).toBeNull();
    expect(devicePopupAction(0xa5)).toBeNull();
  });
});

/** Drawing pixel of a zone point — `hitTestPanel` subtracts the click origin (8, 9). */
const at = (x: number, y: number): [number, number] => [x + 8, y + 9];

describe('Screen 0x3c — Treffer-Test', () => {
  it('hits the buttons in both corners', () => {
    expect(clickDevicePopup(...at(8, 16))).toEqual({ kind: 'cycleMode' });
    expect(clickDevicePopup(...at(23, 31))).toEqual({ kind: 'cycleMode' });
    expect(clickDevicePopup(...at(24, 48))).toEqual({ kind: 'step', row: 0, delta: 1 });
    expect(clickDevicePopup(...at(127, 143))).toEqual({ kind: 'close' });
  });

  it('hits nothing beside the buttons', () => {
    expect(clickDevicePopup(...at(7, 16))).toBeNull(); // links vom Umschalter
    expect(clickDevicePopup(...at(8, 32))).toBeNull(); // one row below
    expect(clickDevicePopup(...at(40, 48))).toBeNull(); // right of the plus button
    expect(clickDevicePopup(...at(0, 0))).toBeNull();
  });

  it('the two minus buttons sit above each other and are distinguishable', () => {
    expect(clickDevicePopup(...at(8, 48))).toEqual({ kind: 'step', row: 0, delta: -1 });
    expect(clickDevicePopup(...at(8, 80))).toEqual({ kind: 'step', row: 1, delta: -1 });
  });

  it('the confirm button covers the second column too, the toggle above it does not', () => {
    expect(clickDevicePopup(...at(32, 112))).toEqual({ kind: 'commit' });
    expect(clickDevicePopup(...at(32, 16))).toBeNull();
  });
});
