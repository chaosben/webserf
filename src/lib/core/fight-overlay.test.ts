import { describe, expect, it } from 'vitest';
import {
  HIT_MARKER_CAPACITY,
  HIT_MARKER_REACHABLE,
  fightPartnerIndex,
  fightPartnerVisible,
  hitMarkerOffset,
  hitMarkerTableIndex,
  isFightPose,
} from './fight-overlay.js';
import type { SerfRecord } from './types.js';

/**
 * The constants come from the binary (sprite band @0x26b5e, offset table @0x25a65, sprite ramp
 * @0x26ef0). A pure table port is largely blind to unit tests, so these pin exactly the places where
 * a misreading would show: band bounds, the two strike poses, where the table index comes from, and
 * the counter ramp.
 *
 * The table values themselves are verified against the original data; a unit test can only pin the
 * indices they are read at. The cases below therefore use the two ENDS of each half - a table shifted
 * by one slot changes those first.
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
    // Its own animation would stay 0x93 -> (9,5); the opponent's 0xa0 is entry 13 -> (7,5).
    const m = hitMarkerOffset(withOver({ animation: 0x93, stateData: [0, 0, 4, 0, 0] }), partner);
    expect(m).toMatchObject({ dx: 7 - 16, dy: -5 });
  });

  it('reads both ends of the pose-4 half of the table', () => {
    const at = (anim: number) =>
      hitMarkerOffset(withOver({ animation: 0x93, stateData: [0, 0, 4, 0, 0] }), withOver({ animation: anim }));
    // 0x9d is the first reachable opponent animation, 0xa3 the last.
    expect(at(0x9d)).toMatchObject({ dx: 5 - 16, dy: -5 });
    expect(at(0xa3)).toMatchObject({ dx: 5 - 16, dy: -8 });
  });

  it('draws nothing on the unreachable zero slots', () => {
    // Pose 4 with opponent animations 0xa4..0xa6: those pairs exist only for other poses, so the
    // original never indexes there. The zero offset would put the marker on the fighter's ankles.
    for (const anim of [0xa4, 0xa5, 0xa6]) {
      const serf = withOver({ animation: 0x93, stateData: [0, 0, 4, 0, 0] });
      const opp = withOver({ animation: anim });
      expect(hitMarkerTableIndex(serf, opp)).toBe(anim - 0x93);
      expect(HIT_MARKER_REACHABLE.has(anim - 0x93)).toBe(false);
      expect(hitMarkerOffset(serf, opp)).toBeNull();
    }
  });

  it('separates the reachable index from the drawing decision', () => {
    // Outside the gates there is no index at all; inside, the index is the raw table position.
    expect(hitMarkerTableIndex(withOver({ counter: 0x20 }), partner)).toBeNull();
    expect(hitMarkerTableIndex(withOver({ animation: 0x99 }), partner)).toBe(6);
    expect([...HIT_MARKER_REACHABLE].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16,
    ]);
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
