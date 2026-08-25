/**
 * Time source of the `TickScheduler` — two clock sources, one clock.
 *
 * While visible it runs on `requestAnimationFrame`, while hidden on a worker tick: browsers stop rAF
 * for a hidden document, and the simulation would otherwise stand still. Across the switch the
 * timestamp keeps running, so the gap arrives as part of the next delta.
 *
 * The browser binding sits behind {@link ClockEnv} so the flow logic is testable without a DOM.
 */

/** `visible === false` means: keep computing, but do not draw. */
export type TickHandler = (deltaMs: number, visible: boolean) => void;

/** Each source returns its own unsubscribe. */
export interface ClockEnv {
  now(): number;
  visible(): boolean;
  onVisibilityChange(callback: () => void): () => void;
  /** Clock source while the document is visible. */
  foreground(callback: () => void): () => void;
  /** Clock source while the document is hidden. */
  background(callback: () => void): () => void;
}

/**
 * Fallback without a worker. The browser throttles it heavily in the background — the simulation
 * then runs coarsely, but it runs, because the delta carries the full elapsed time.
 */
const FALLBACK_INTERVAL_MS = 20;

export function browserClockEnv(): ClockEnv {
  return {
    now: () => performance.now(),
    visible: () => document.visibilityState !== 'hidden',

    onVisibilityChange(callback) {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },

    foreground(callback) {
      let raf = requestAnimationFrame(function loop() {
        callback();
        raf = requestAnimationFrame(loop);
      });
      return () => cancelAnimationFrame(raf);
    },

    background(callback) {
      let stopFallback: (() => void) | null = null;
      const startFallback = (): void => {
        if (stopFallback !== null) return;
        const id = setInterval(callback, FALLBACK_INTERVAL_MS);
        stopFallback = () => clearInterval(id);
      };

      // Created only when going to the background: in normal use there is no second thread.
      let worker: Worker | null = null;
      try {
        worker = new Worker(new URL('./tick-worker.ts', import.meta.url), { type: 'module' });
      } catch {
        worker = null; // no worker available -> fallback
      }

      if (worker === null) {
        startFallback();
      } else {
        const w = worker;
        w.onmessage = () => callback();
        // Load failures arrive asynchronously and would bypass the `try` above.
        w.onerror = () => {
          w.onmessage = null;
          w.terminate();
          startFallback();
        };
      }

      const w = worker;
      return () => {
        if (w !== null) {
          w.onmessage = null;
          w.onerror = null;
          w.terminate();
        }
        stopFallback?.();
        stopFallback = null;
      };
    },
  };
}

/** Returns the unsubscribe function — fits straight into an `$effect` return. */
export function startTickClock(handler: TickHandler, env: ClockEnv = browserClockEnv()): () => void {
  let last = env.now();
  let visible = env.visible();
  let stopSource: (() => void) | null = null;

  const pump = (): void => {
    const now = env.now();
    const delta = now - last;
    last = now;
    handler(delta, visible);
  };

  // `last` is deliberately NOT reset when switching sources: the gap is real game time.
  const attach = (): void => {
    stopSource?.();
    visible = env.visible();
    stopSource = visible ? env.foreground(pump) : env.background(pump);
  };

  attach();
  const stopVisibility = env.onVisibilityChange(attach);

  return () => {
    stopVisibility();
    stopSource?.();
    stopSource = null;
  };
}
