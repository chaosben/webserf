import { describe, expect, it } from 'vitest';
import {
  MESSAGE_LEVEL_MAX,
  VIEW_OPTIONS_DEFAULT,
  VIEW_OPTION_FAST_BUILD_CLICK,
  VIEW_OPTION_FAST_MAP_CLICK,
  VIEW_OPTION_MESSAGE_MASK,
  VIEW_OPTION_ROAD_SCROLL,
  VOLUME_DEFAULT,
  VOLUME_MAX,
  VOLUME_MIN,
  cycleMessageLevel,
  cycleViewMessageLevel,
  hasViewOption,
  messageLevel,
  stepVolume,
  toggleOption,
  toggleViewOption,
  viewOptions,
  type ViewSide,
} from './view-options.js';
import type { GameState } from './state.js';

/** Minimal state: the module only reads and writes `header.viewOptions`. */
function stateWith(left: number, right: number): GameState {
  return { header: { viewOptions: [left, right] } } as unknown as GameState;
}

describe('Options-Byte: Bit-Belegung', () => {
  it('the factory setting 0x39 is road-building scrolling plus message level 3', () => {
    // `mov $0x39,%al` @0x2e0f/@0x2e1a, and the value of the right half in every real save.
    expect(VIEW_OPTIONS_DEFAULT & VIEW_OPTION_ROAD_SCROLL).toBe(VIEW_OPTION_ROAD_SCROLL);
    expect(VIEW_OPTIONS_DEFAULT & VIEW_OPTION_FAST_MAP_CLICK).toBe(0);
    expect(VIEW_OPTIONS_DEFAULT & VIEW_OPTION_FAST_BUILD_CLICK).toBe(0);
    expect(messageLevel(VIEW_OPTIONS_DEFAULT)).toBe(MESSAGE_LEVEL_MAX);
  });

  it('the message level is read from the top (bit 3, then 4, then 5)', () => {
    expect(messageLevel(0x00)).toBe(0);
    expect(messageLevel(0x20)).toBe(1);
    expect(messageLevel(0x30)).toBe(2);
    expect(messageLevel(0x38)).toBe(3);
    // The read order, not `>> 3`: a set bit 3 wins over missing lower bits.
    expect(messageLevel(0x08)).toBe(3);
    expect(messageLevel(0x10)).toBe(2);
  });

  it('the real saves decode to the observed levels', () => {
    // The four byte values that occur in real saves.
    expect(messageLevel(0x3d)).toBe(3);
    expect(messageLevel(0x25)).toBe(1);
    expect(messageLevel(0x3f)).toBe(3);
    expect(messageLevel(0x39)).toBe(3);
    expect(0x3f & VIEW_OPTION_FAST_MAP_CLICK).toBe(VIEW_OPTION_FAST_MAP_CLICK);
    expect(0x39 & VIEW_OPTION_FAST_BUILD_CLICK).toBe(0);
  });
});

describe('Meldungs-Stufe weiterschalten', () => {
  it('cycles 3 -> 2 -> 1 -> 0 -> 3 and leaves the other bits alone', () => {
    let v = 0x39; // Stufe 3 + Wegebau-Scrolling
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(messageLevel(v));
      v = cycleMessageLevel(v);
      expect(v & ~VIEW_OPTION_MESSAGE_MASK).toBe(0x01); // road-building bit untouched
    }
    expect(seen).toEqual([3, 2, 1, 0, 3]);
  });

  it('cleans up an impossible pattern exactly like the original', () => {
    // `0x08` (bit 3 alone) does not occur in real saves; the cascade still clears bit 3 first.
    expect(cycleMessageLevel(0x08)).toBe(0x00);
    expect(cycleMessageLevel(0x10)).toBe(0x00);
  });
});

describe('toggling on the byte', () => {
  // The plain byte form exists because the option bytes are GLOBAL in the original (`gs+0x3d8/0x3d9`)
  // and exist before any save game - the main menu serves the same screen without
 // einen `GameState`. Der Zustands-Wrapper darunter muss dasselbe tun.
  it('flips exactly the mask and stays inside the byte', () => {
    expect(toggleOption(0x39, VIEW_OPTION_FAST_MAP_CLICK)).toBe(0x39 ^ VIEW_OPTION_FAST_MAP_CLICK);
    expect(toggleOption(toggleOption(0x39, 0x04), 0x04)).toBe(0x39);
    expect(toggleOption(0xff, 0x80)).toBe(0x7f);
    // No overflow past the byte boundary, even with an over-wide mask.
    expect(toggleOption(0x00, 0x100)).toBe(0x00);
  });
});

describe('toggling on the state', () => {
  it('hits exactly the addressed half', () => {
    const s = stateWith(0x39, 0x39);
    toggleViewOption(s, 0, VIEW_OPTION_FAST_BUILD_CLICK);
    expect(viewOptions(s, 0)).toBe(0x3d);
    expect(viewOptions(s, 1)).toBe(0x39);
    toggleViewOption(s, 1, VIEW_OPTION_FAST_MAP_CLICK);
    expect(viewOptions(s, 0)).toBe(0x3d);
    expect(viewOptions(s, 1)).toBe(0x3b);
  });

  it('is an XOR (clicking twice restores the starting value)', () => {
    const s = stateWith(0x39, 0x39);
    for (const side of [0, 1] as ViewSide[]) {
      for (const mask of [
        VIEW_OPTION_ROAD_SCROLL,
        VIEW_OPTION_FAST_MAP_CLICK,
        VIEW_OPTION_FAST_BUILD_CLICK,
      ]) {
        toggleViewOption(s, side, mask);
        expect(hasViewOption(s, side, mask)).toBe(mask === VIEW_OPTION_ROAD_SCROLL ? false : true);
        toggleViewOption(s, side, mask);
        expect(viewOptions(s, side)).toBe(0x39);
      }
    }
  });

  it('advances the message level separately per half', () => {
    const s = stateWith(0x39, 0x39);
    cycleViewMessageLevel(s, 0);
    expect(messageLevel(viewOptions(s, 0))).toBe(2);
    expect(messageLevel(viewOptions(s, 1))).toBe(3);
  });
});

describe('volume', () => {
  it('starts at 75 and clamps at 0 and 99', () => {
    expect(VOLUME_DEFAULT).toBe(75);
    expect(stepVolume(VOLUME_MIN, -1)).toBe(VOLUME_MIN);
    expect(stepVolume(VOLUME_MIN, 1)).toBe(1);
    expect(stepVolume(VOLUME_MAX, 1)).toBe(VOLUME_MAX);
    expect(stepVolume(VOLUME_MAX, -1)).toBe(VOLUME_MAX - 1);
  });
});
