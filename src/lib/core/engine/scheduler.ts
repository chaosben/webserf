/**
 * Fixed-step tick scheduler — decouples the **logic** (fixed, deterministic ticks) from the
 * **display** (`requestAnimationFrame`, variable wall clock).
 *
 * The game logic runs on integer ticks; this scheduler only decides **how many** are due per elapsed
 * real time. Determinism survives because the result of a tick depends on the tick count, never on
 * the (float) wall clock.
 *
 * **Default 100/s, measured against the original:** it drives `gameTick` (gs+0x206) from a ~100 Hz
 * timer (logic timer period 10000 us), confirmed by two save-state dumps of a running game — 2976
 * game ticks in ~29.76 s. The separate frame loop (~12.5 fps = 100/8) lives in `flag-update.ts`.
 */

/** Measured against the original: the game tick timer runs at ~100 Hz. */
export const DEFAULT_TICKS_PER_SECOND = 100;

/**
 * How much elapsed real time a **single** `pump` may catch up (ms). Anything beyond is dropped —
 * the guard against a death spiral after a real standstill (standby, blocked thread), which would
 * otherwise make the simulation run for hours to catch up.
 *
 * **A time window, not a piece count.** A fixed count (say 8, sized for ~60 Hz animation frames)
 * silently becomes a speed limit as soon as the clock ticks more slowly: an invisible tab is driven
 * from a worker, and a throttled browser may deliver signals only once a second — a cap of 8 would
 * quietly run the simulation at 8 instead of 100 ticks/s, with nothing to show for it. Two seconds
 * covers the one-second throttle case with room to spare and stays far below what a standby
 * produces.
 */
export const MAX_CATCH_UP_MS = 2000;

export class TickScheduler {
  ticksPerSecond: number;
  private accMs = 0;
  /**
   * Fixed upper bound of ticks due per `pump`. Without one it follows from {@link MAX_CATCH_UP_MS}
   * and the current speed, so it grows with the speed setting instead of becoming a hidden brake at
   * 4x.
   */
  private readonly maxTicksPerPump: number | undefined;

  constructor(ticksPerSecond: number = DEFAULT_TICKS_PER_SECOND, maxTicksPerPump?: number) {
    this.ticksPerSecond = ticksPerSecond;
    this.maxTicksPerPump = maxTicksPerPump;
  }

  /** Current upper bound of ticks due per `pump`. */
  private cap(): number {
    if (this.maxTicksPerPump !== undefined) return this.maxTicksPerPump;
    return Math.max(1, Math.ceil((this.ticksPerSecond * MAX_CATCH_UP_MS) / 1000));
  }

  /** Change the speed; the accumulator is kept. */
  setSpeed(ticksPerSecond: number): void {
    this.ticksPerSecond = ticksPerSecond;
  }

  /** Reset the accumulator, e.g. on resume, to discard time that piled up while paused. */
  reset(): void {
    this.accMs = 0;
  }

  /**
   * Feed in elapsed real time; returns the number of logic ticks due **now**. The remainder (less
   * than one tick) stays in the accumulator. Above {@link cap} the result is capped and the
   * accumulator is emptied.
   */
  pump(deltaMs: number): number {
    if (deltaMs <= 0) return 0;
    this.accMs += deltaMs;
    const msPerTick = 1000 / this.ticksPerSecond;
    let n = Math.floor(this.accMs / msPerTick);
    if (n <= 0) return 0;
    this.accMs -= n * msPerTick;
    const cap = this.cap();
    if (n > cap) {
      n = cap;
      this.accMs = 0;
    }
    return n;
  }
}
