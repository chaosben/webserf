import { describe, it, expect } from 'vitest';
import { TickScheduler, DEFAULT_TICKS_PER_SECOND, MAX_CATCH_UP_MS } from './scheduler.js';

describe('TickScheduler — feststufiger Akkumulator', () => {
  it('Default-Geschwindigkeit = 100 ticks/s (DOS-Timer-Rate, am Original gemessen)', () => {
    expect(DEFAULT_TICKS_PER_SECOND).toBe(100);
  });

  it('yields the expected tick count for an exact multiple', () => {
    const s = new TickScheduler(100, 100); // 10 ms per tick, hoher Cap (Cap separat getestet)
    expect(s.pump(100)).toBe(10);
  });

  it('carries the remainder (less than one tick) into the accumulator', () => {
    const s = new TickScheduler(100); // 10 ms per tick
    expect(s.pump(15)).toBe(1); // 1 Tick, 5 ms Rest
    expect(s.pump(5)).toBe(1); // Rest + 5 ms = 10 ms → 1 Tick
  });

  it('returns 0 for a delta that is too small', () => {
    const s = new TickScheduler(100);
    expect(s.pump(3)).toBe(0);
    expect(s.pump(0)).toBe(0);
    expect(s.pump(-10)).toBe(0);
  });

  it('kappt bei maxTicksPerPump (Todesspirale-Schutz)', () => {
    const s = new TickScheduler(100, 8); // 10 ms per tick, Cap 8
    expect(s.pump(1000)).toBe(8); // 100 ticks due -> capped at 8
  });

  it('without a fixed cap the limit is the catch-up window', () => {
    const s = new TickScheduler(100); // 10 ms per tick
    // A standstill of a minute may catch up at most MAX_CATCH_UP_MS.
    expect(s.pump(60_000)).toBe((100 * MAX_CATCH_UP_MS) / 1000);
  });

  it('the catch-up window grows with the speed', () => {
    // Why the window is in time rather than in ticks: with a coarse clock (a throttled background tab,
    // around 1 s) the cap must NOT slow the simulation - a one-second delta has to pass in full.
    const s = new TickScheduler(100);
    expect(s.pump(1000)).toBe(100); // 1 s between clock ticks -> the full 100 ticks, not capped
    s.setSpeed(400); // 4x
    s.reset();
    expect(s.pump(1000)).toBe(400);
    expect(s.pump(60_000)).toBe((400 * MAX_CATCH_UP_MS) / 1000);
  });

  it('reset empties the accumulator', () => {
    const s = new TickScheduler(100);
    s.pump(9); // 9 ms Rest
    s.reset();
    expect(s.pump(9)).toBe(0); // ohne Reststand: 9 ms < 10 ms
  });

  it('setSpeed changes the rate', () => {
    const s = new TickScheduler(100);
    s.setSpeed(50); // 20 ms/Tick
    expect(s.pump(100)).toBe(5);
  });
});
