import { describe, expect, it } from 'vitest';
import {
  HIT_MARKER_CAPACITY,
  fightPartnerIndex,
  fightPartnerVisible,
  hitMarkerOffset,
  isFightPose,
} from './fight-overlay.js';
import type { SerfRecord } from './types.js';

/**
 * The constants come from the binary (sprite band @0x26b5e, offset table @0x25a65, sprite ramp
 * @0x26ef0). A pure table port is largely blind to unit tests, so these pin exactly the places where
 * a misreading would show: band bounds, the two strike poses, where the table index comes from, and
 * the counter ramp.
 */

function knight(): SerfRecord {
  return {
    index: 1,
    owner: 0,
    type: 22, // Knight0
    state: 48,
    animation: 0x93,
    counter: 0,
    col: 0,
    row: 0,
    stateData: [0, 0, 0, 0, 0],
  } as unknown as SerfRecord;
}

const withOver = (over: Record<string, unknown>): SerfRecord =>
  ({ ...(knight() as unknown as Record<string, unknown>), ...over }) as unknown as SerfRecord;

describe('isFightPose — the sprite band 0x80..0xbf', () => {
  it('takes exactly the band and only knight types', () => {
    expect(isFightPose(22, 0x7f)).toBe(false);
    expect(isFightPose(22, 0x80)).toBe(true);
    expect(isFightPose(26, 0xbf)).toBe(true);
    expect(isFightPose(22, 0xc0)).toBe(false); // Verteidiger-Bank
    expect(isFightPose(21, 0x80)).toBe(false); // Generic
    expect(isFightPose(27, 0x80)).toBe(false); // Dead
  });
});

describe('fightPartnerIndex — serf[0xe] als u16', () => {
  it('reads union bytes 14/15 together', () => {
    expect(fightPartnerIndex(withOver({ stateData: [0, 0, 0, 0x2c, 0x01] }))).toBe(0x12c);
    expect(fightPartnerIndex(withOver({ stateData: [9, 9, 9, 0, 0] }))).toBe(0);
  });
  it('draws the opponent only outside state 46', () => {
    expect(fightPartnerVisible(withOver({ state: 0x2e }))).toBe(false);
    expect(fightPartnerVisible(withOver({ state: 49 }))).toBe(true);
  });
});

describe('hitMarkerOffset', () => {
  const partner = withOver({ animation: 0xa0 });

  it('returns the entry of its OWN animation for direction 0', () => {
    // Tabelle @0x25a65: 0x93 → (9,5), 0x97 → (11,8).
    expect(hitMarkerOffset(withOver({ animation: 0x93 }), partner)).toMatchObject({ dx: 9 - 16, dy: -5 });
    expect(hitMarkerOffset(withOver({ animation: 0x97 }), partner)).toMatchObject({ dx: 11 - 16, dy: -8 });
  });

  it('returns the entry of the OPPONENT animation for direction 4', () => {
    // Its own animation would stay 0x93 -> (9,5); the opponent's 0xa0 is entry 13 -> (3,8).
    const m = hitMarkerOffset(withOver({ animation: 0x93, stateData: [0, 0, 4, 0, 0] }), partner);
    expect(m).toMatchObject({ dx: 3 - 16, dy: -8 });
  });

  it('stays silent in the in-between poses and outside the animation range', () => {
    for (const dir of [1, 2, 3, 5]) {
      expect(hitMarkerOffset(withOver({ stateData: [0, 0, dir, 0, 0] }), partner)).toBeNull();
    }
    expect(hitMarkerOffset(withOver({ animation: 0x91 }), partner)).toBeNull();
    expect(hitMarkerOffset(withOver({ animation: 0x9c }), partner)).toBeNull(); // the range is half open
  });

  it('stays silent outside the last quarter of the round (counter >= 0x20)', () => {
    expect(hitMarkerOffset(withOver({ counter: 0x1f }), partner)).not.toBeNull();
    expect(hitMarkerOffset(withOver({ counter: 0x20 }), partner)).toBeNull();
  });

  it('runs the four hit sprites 0xc6..0xc9 backwards over the counter', () => {
    // `0xc6 + ((counter >> 3) ^ 3)`: the counter falls, the marker rises.
    expect(hitMarkerOffset(withOver({ counter: 0x18 }), partner)!.sprite).toBe(0xc6);
    expect(hitMarkerOffset(withOver({ counter: 0x10 }), partner)!.sprite).toBe(0xc7);
    expect(hitMarkerOffset(withOver({ counter: 0x08 }), partner)!.sprite).toBe(0xc8);
    expect(hitMarkerOffset(withOver({ counter: 0x00 }), partner)!.sprite).toBe(0xc9);
  });

  it('pins the list capacity of the original', () => {
    expect(HIT_MARKER_CAPACITY).toBe(10); // `if (vp[0x1ae] != 9)`, the counter starts at -1
  });
});
