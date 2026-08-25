/**
 * Clock source for the logic clock (`tick-clock.ts`).
 *
 * A worker, because browsers throttle timers of a hidden tab and stop `requestAnimationFrame` there
 * entirely — worker timers keep running. How much game time a signal is worth is computed on the
 * main thread from the real elapsed time, so a late signal only costs resolution.
 */

/** Finer than the original's frame period (80 ms). */
const INTERVAL_MS = 20;

// The `tsconfig` only loads DOM types, where `postMessage` is the window variant with a mandatory
// target origin.
const scope = self as unknown as { postMessage(message: unknown): void };

setInterval(() => scope.postMessage(0), INTERVAL_MS);

export {};
