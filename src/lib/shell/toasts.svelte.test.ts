import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastBus, TOAST_LIMIT, TOAST_MS } from './toasts.svelte.js';

describe('toast bus', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the newest first and lets each go after its tone’s time', () => {
    const bus = new ToastBus();
    bus.push('saved', { tone: 'good' });
    bus.push('careful', { tone: 'warn' });
    expect(bus.items.map((t) => t.text)).toEqual(['careful', 'saved']);
    vi.advanceTimersByTime(TOAST_MS.good);
    expect(bus.items.map((t) => t.text)).toEqual(['careful']);
    vi.advanceTimersByTime(TOAST_MS.warn - TOAST_MS.good);
    expect(bus.items).toEqual([]);
  });

  it('counts a repeated message instead of stacking it, and restarts its clock', () => {
    const bus = new ToastBus();
    bus.push('again');
    vi.advanceTimersByTime(TOAST_MS.info - 1);
    bus.push('again');
    expect(bus.items).toHaveLength(1);
    expect(bus.items[0]!.count).toBe(2);
    vi.advanceTimersByTime(TOAST_MS.info - 1);
    expect(bus.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(bus.items).toEqual([]);
  });

  it('keeps the same text with another tone apart', () => {
    const bus = new ToastBus();
    bus.push('x', { tone: 'good' });
    bus.push('x', { tone: 'error' });
    expect(bus.items).toHaveLength(2);
  });

  it('drops the oldest beyond the limit, and its timer with it', () => {
    const bus = new ToastBus();
    for (let i = 0; i <= TOAST_LIMIT; i++) bus.push(`m${i}`);
    expect(bus.items).toHaveLength(TOAST_LIMIT);
    expect(bus.items.at(-1)!.text).toBe('m1');
    expect(vi.getTimerCount()).toBe(TOAST_LIMIT);
  });

  it('dismisses on request', () => {
    const bus = new ToastBus();
    const id = bus.push('bye', { ms: 60000 });
    bus.dismiss(id);
    expect(bus.items).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
