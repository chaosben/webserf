import { describe, expect, it } from 'vitest';
import { blockPageZoom, type ZoomTarget } from './page-zoom.js';

/**
 * The one thing worth pinning here is that the teardown really unregisters: this listener lives on
 * the shell, which outlives every view, so a leak would stack one swallower per mount.
 */
function fakeTarget() {
  const listeners = new Map<string, (ev: Event) => void>();
  const target: ZoomTarget = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  return { target, listeners };
}

describe('blockPageZoom', () => {
  it('claims the three gesture events WebKit sends for a pinch', () => {
    const { target, listeners } = fakeTarget();
    blockPageZoom(target);
    expect([...listeners.keys()].sort()).toEqual([
      'gesturechange',
      'gestureend',
      'gesturestart',
    ]);
  });

  it('cancels the event, which is what keeps the page at scale 1', () => {
    const { target, listeners } = fakeTarget();
    blockPageZoom(target);
    let cancelled = false;
    const fired = {
      preventDefault: () => {
        cancelled = true;
      },
    } as unknown as Event;
    listeners.get('gesturestart')!(fired);
    expect(cancelled).toBe(true);
  });

  it('lets go of all three again', () => {
    const { target, listeners } = fakeTarget();
    blockPageZoom(target)();
    expect(listeners.size).toBe(0);
  });
});
