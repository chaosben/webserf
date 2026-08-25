import { describe, expect, it } from 'vitest';
import {
  CONTROL_BAR_SOUND_ICONS,
  UI_SOUND_ACCEPT,
  UI_SOUND_DEMOLISH_ROAD,
  UI_SOUND_PANEL_BUTTON,
  UI_SOUND_RECALL_SET,
  UI_SOUND_REJECT,
  demolishOutcomeSound,
  plainMapClickSilent,
} from './ui-sound.js';

describe('ui-sound — the sound set of the original', () => {
  it('across all 90 call sites there are only these three roles', () => {
    expect(UI_SOUND_REJECT).toBe(4);
    expect(UI_SOUND_ACCEPT).toBe(2);
    expect(UI_SOUND_PANEL_BUTTON).toBe(8);
  });

  it('the two special names are aliases, not sounds of their own', () => {
    // They only carry their call site in the name — the meaning is "executed".
    expect(UI_SOUND_DEMOLISH_ROAD).toBe(UI_SOUND_ACCEPT);
    expect(UI_SOUND_RECALL_SET).toBe(UI_SOUND_ACCEPT);
  });

  it('demolishing has its own sounds, the failure does not', () => {
    expect(demolishOutcomeSound('rejected')).toBe(UI_SOUND_REJECT);
    expect(demolishOutcomeSound('flag')).not.toBe(UI_SOUND_REJECT);
    expect(demolishOutcomeSound('building')).not.toBe(demolishOutcomeSound('flag'));
  });
});

describe('ui-sound: gate of the plain map click (gs+0x37e bit 5)', () => {
  it('only game type 4 makes it silent', () => {
    // The bit is set only at `cmpw $0x4,0x352(%ebx)` @0x4fe75; 0 = free game and
    // 1 = campaign are the types our parser loads.
    expect(plainMapClickSilent(4)).toBe(true);
    for (const t of [0, 1, 2, 3, 5]) expect(plainMapClickSilent(t)).toBe(false);
  });
});

describe('ui-sound — the control-bar icons that sound', () => {
  it('17 values, taken from the cascade', () => {
    expect(CONTROL_BAR_SOUND_ICONS.size).toBe(17);
  });

  it('the two demolish icons do NOT sound here — their handler sounds itself', () => {
    expect(CONTROL_BAR_SOUND_ICONS.has(0x06)).toBe(false);
    expect(CONTROL_BAR_SOUND_ICONS.has(0x0f)).toBe(false);
  });

  it('and neither do the two silent values 0x05/0x00', () => {
    expect(CONTROL_BAR_SOUND_ICONS.has(0x05)).toBe(false);
    expect(CONTROL_BAR_SOUND_ICONS.has(0x00)).toBe(false);
  });
});
