import { describe, it, expect } from 'vitest';
import { startTickClock, type ClockEnv, type TickHandler } from './tick-clock.js';

/**
 * Test environment without a DOM: time, visibility and both clock sources are driven by hand. That
 * is what `ClockEnv` is for — the flow logic of the clock (switching, forming the delta,
 * unsubscribing) is fully checkable even though the test environment is `node`.
 */
class FakeEnv implements ClockEnv {
  time = 0;
  isVisible = true;
  /** How often each source is currently subscribed (has to be 0 everywhere at the end). */
  foregroundActive = 0;
  backgroundActive = 0;

  private visibilityListeners = new Set<() => void>();
  private foregroundTick: (() => void) | null = null;
  private backgroundTick: (() => void) | null = null;

  now(): number {
    return this.time;
  }

  visible(): boolean {
    return this.isVisible;
  }

  onVisibilityChange(callback: () => void): () => void {
    this.visibilityListeners.add(callback);
    return () => this.visibilityListeners.delete(callback);
  }

  foreground(callback: () => void): () => void {
    this.foregroundActive += 1;
    this.foregroundTick = callback;
    return () => {
      this.foregroundActive -= 1;
      this.foregroundTick = null;
    };
  }

  background(callback: () => void): () => void {
    this.backgroundActive += 1;
    this.backgroundTick = callback;
    return () => {
      this.backgroundActive -= 1;
      this.backgroundTick = null;
    };
  }

  /** Advance time and fire the active source once. */
  advance(ms: number): void {
    this.time += ms;
    (this.isVisible ? this.foregroundTick : this.backgroundTick)?.();
  }

  /** Toggle visibility (fires `visibilitychange`, like the browser does). */
  setVisible(value: boolean): void {
    this.isVisible = value;
    for (const listener of [...this.visibilityListeners]) listener();
  }

  get listenerCount(): number {
    return this.visibilityListeners.size;
  }
}

function record(): { handler: TickHandler; calls: Array<[number, boolean]> } {
  const calls: Array<[number, boolean]> = [];
  return { handler: (delta, visible) => calls.push([delta, visible]), calls };
}

describe('startTickClock — clock source by visibility', () => {
  it('uses the frame source while visible and reports `visible`', () => {
    const env = new FakeEnv();
    const { handler, calls } = record();
    const stop = startTickClock(handler, env);

    expect(env.foregroundActive).toBe(1);
    expect(env.backgroundActive).toBe(0);

    env.advance(16);
    expect(calls).toEqual([[16, true]]);

    stop();
  });

  it('switches to the background source once the document is hidden', () => {
    const env = new FakeEnv();
    const { handler, calls } = record();
    const stop = startTickClock(handler, env);

    env.setVisible(false);
    expect(env.foregroundActive).toBe(0); // old source unsubscribed - no double clock
    expect(env.backgroundActive).toBe(1);

    env.advance(20);
    expect(calls).toEqual([[20, false]]); // still ticking, but flagged as not visible

    stop();
  });

  it('loses no time while switching (that is the whole point)', () => {
    const env = new FakeEnv();
    const { handler, calls } = record();
    const stop = startTickClock(handler, env);

    env.advance(16); // one frame in the foreground
    env.time += 500; // tab goes invisible, 500 ms pass in between
    env.setVisible(false);
    env.advance(20); // erstes Hintergrund-Signal

    // The 500 ms between the last signal and the switch sit in the next delta — they are caught
    // up, not dropped. Without that property every switch would lose game time.
    expect(calls).toEqual([
      [16, true],
      [520, false],
    ]);

    stop();
  });

  it('starts directly on the background source while hidden', () => {
    const env = new FakeEnv();
    env.isVisible = false;
    const { handler, calls } = record();
    const stop = startTickClock(handler, env);

    expect(env.backgroundActive).toBe(1);
    expect(env.foregroundActive).toBe(0);
    env.advance(1000); // coarse clock (throttled worker) - the full delta arrives
    expect(calls).toEqual([[1000, false]]);

    stop();
  });

  it('unsubscribes the source AND the visibility listener when stopped', () => {
    const env = new FakeEnv();
    const { handler, calls } = record();
    const stop = startTickClock(handler, env);

    env.setVisible(false);
    env.setVisible(true);
    stop();

    expect(env.foregroundActive).toBe(0);
    expect(env.backgroundActive).toBe(0);
    expect(env.listenerCount).toBe(0);

    // After stopping nothing may get through any more.
    const before = calls.length;
    env.advance(16);
    expect(calls.length).toBe(before);
  });

  it('keeps exactly one source active while toggling back and forth', () => {
    const env = new FakeEnv();
    const { handler } = record();
    const stop = startTickClock(handler, env);

    for (let i = 0; i < 5; i++) {
      env.setVisible(false);
      env.setVisible(true);
    }
    expect(env.foregroundActive).toBe(1);
    expect(env.backgroundActive).toBe(0);

    stop();
  });
});
