import { describe, it, expect } from 'vitest';
import { FRAME_TICKS, logicFrame } from './tick.js';

/**
 * The original's frame number. It has three consumers that must agree (sound gate, draw cadence,
 * animation phases), which is why it lives in one place.
 */
describe('logicFrame: the original frame number', () => {
  it('changes exactly every FRAME_TICKS gameTicks', () => {
    expect(FRAME_TICKS).toBe(8);
    const changes = [];
    for (let t = 1; t <= 64; t++) if (logicFrame(t) !== logicFrame(t - 1)) changes.push(t);
    expect(changes).toEqual([8, 16, 24, 32, 40, 48, 56, 64]);
  });

  /**
   * At 100 ticks per second (the original rate) this is 12.5 frames per second - the rate at which
   * the original draws, and the reason for the draw cadence in `MapView`.
   */
  it('yields 12.5 frames per second at the original tick rate', () => {
    const TICKS_PER_SECOND = 100;
    expect(TICKS_PER_SECOND / FRAME_TICKS).toBe(12.5);
    expect(logicFrame(TICKS_PER_SECOND) - logicFrame(0)).toBe(12);
  });

  it('starts at 0 and grows monotonically', () => {
    expect(logicFrame(0)).toBe(0);
    expect(logicFrame(7)).toBe(0);
    expect(logicFrame(8)).toBe(1);
    let prev = -1;
    for (let t = 0; t < 5000; t += 3) {
      const f = logicFrame(t);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  /**
   * `gameTick` is u16 and wraps every 65536 ticks, so the counter jumps back to 0. The gate must not
   * get stuck there but see the jump as a new frame, which is why it compares for INEQUALITY rather
   * than for greater.
   */
  it('after the u16 wrap the frame number is small again, and thus unequal to the last one', () => {
    const before = logicFrame(65535);
    const after = logicFrame(0);
    expect(before).toBe(8191);
    expect(after).toBe(0);
    expect(after).not.toBe(before);
  });
});
