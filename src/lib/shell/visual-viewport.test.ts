import { describe, expect, it } from 'vitest';
import {
  followVisualViewport,
  sameBox,
  shellBoxOf,
  visualViewportEnv,
  type ShellBox,
  type ViewportEnv,
  type ViewportReading,
} from './visual-viewport.js';

/**
 * A viewport that can be moved by hand, plus a frame queue that has to be run on purpose — the two
 * properties worth pinning are both about TIMING: several signals must collapse into one write, and
 * a write must not happen at all when the box is unchanged. A canvas resize hangs off each write.
 */
function fakeEnv(start: ViewportReading) {
  let reading = start;
  const listeners: (() => void)[] = [];
  let queued: (() => void) | null = null;
  const env: ViewportEnv = {
    read: () => reading,
    subscribe(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    schedule(run) {
      queued = run;
      return () => {
        queued = null;
      };
    },
  };
  return {
    env,
    listeners,
    move(next: ViewportReading) {
      reading = next;
    },
    signal() {
      for (const l of [...listeners]) l();
    },
    frame() {
      const run = queued;
      queued = null;
      run?.();
    },
    get pending() {
      return queued !== null;
    },
  };
}

const full: ViewportReading = { width: 360, height: 640, offsetLeft: 0, offsetTop: 0 };

describe('shellBoxOf', () => {
  it('rounds to whole pixels', () => {
    // The browser's own figures are fractional; unrounded they wobble by half a pixel and every
    // frame would count as a change.
    const box = shellBoxOf({ width: 179.5, height: 319.2, offsetLeft: 90.4, offsetTop: 12.6 });
    expect(box).toEqual({ w: 180, h: 319, x: 90, y: 13 });
  });
});

describe('sameBox', () => {
  it('treats "nothing written yet" as different', () => {
    expect(sameBox(null, { w: 1, h: 1, x: 0, y: 0 })).toBe(false);
  });

  it('separates a move from a resize', () => {
    const a: ShellBox = { w: 10, h: 10, x: 0, y: 0 };
    expect(sameBox(a, { w: 10, h: 10, x: 0, y: 0 })).toBe(true);
    expect(sameBox(a, { w: 10, h: 10, x: 1, y: 0 })).toBe(false);
    expect(sameBox(a, { w: 11, h: 10, x: 0, y: 0 })).toBe(false);
  });
});

describe('followVisualViewport', () => {
  it('places the shell straight away, without waiting for a signal', () => {
    const fake = fakeEnv(full);
    const seen: ShellBox[] = [];
    followVisualViewport((b) => seen.push(b), fake.env);
    expect(seen).toEqual([{ w: 360, h: 640, x: 0, y: 0 }]);
  });

  it('collapses a burst of signals into one write', () => {
    const fake = fakeEnv(full);
    const seen: ShellBox[] = [];
    followVisualViewport((b) => seen.push(b), fake.env);
    // A pinch sends resize and scroll several times per frame.
    fake.move({ width: 180, height: 320, offsetLeft: 90, offsetTop: 12 });
    fake.signal();
    fake.signal();
    fake.signal();
    fake.frame();
    expect(seen).toEqual([
      { w: 360, h: 640, x: 0, y: 0 },
      { w: 180, h: 320, x: 90, y: 12 },
    ]);
  });

  it('stays silent when the box has not moved', () => {
    const fake = fakeEnv(full);
    const seen: ShellBox[] = [];
    followVisualViewport((b) => seen.push(b), fake.env);
    fake.signal();
    fake.frame();
    expect(seen).toHaveLength(1);
  });

  it('lets go of the signals and of a frame still queued', () => {
    const fake = fakeEnv(full);
    const stop = followVisualViewport(() => {}, fake.env);
    fake.move({ width: 180, height: 320, offsetLeft: 0, offsetTop: 0 });
    fake.signal();
    expect(fake.pending).toBe(true);
    stop();
    expect(fake.listeners).toHaveLength(0);
    expect(fake.pending).toBe(false);
  });
});

describe('visualViewportEnv', () => {
  it('gives up where the API is missing, leaving the CSS fallback in charge', () => {
    // The test run has no browser, which is exactly the case this branch is for.
    expect(visualViewportEnv()).toBeNull();
  });
});
