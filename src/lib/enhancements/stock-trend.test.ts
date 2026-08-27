import { describe, it, expect } from 'vitest';
import {
  STOCK_TREND_SNAPSHOTS,
  STOCK_TREND_SPANS,
  STOCK_TREND_TICKS,
  TREND_KEY_RANGE,
  TREND_SERF_BASE,
  TREND_STALE_MS,
  createStockTrends,
  stockTrendTicks,
  trendKey,
  trendOf,
} from './stock-trend.js';
import type { StockRow, StockView } from './stock-overview.js';

const GAME = { id: 'game' };
const SEL = { id: 'selection' };

/** A view of goods only — the trend does not care which half a row came from. */
function view(values: Readonly<Record<number, number>>): StockView {
  const goods: StockRow[] = Object.entries(values).map(([type, value]) => ({
    kind: 'good',
    type: Number(type),
    icon: 0,
    value,
  }));
  return { goods, serfs: [] };
}

describe('trendKey', () => {
  /**
   * Exhaustive rather than argued: a collision would put one row's arrow beside another row's
   * number, which looks merely odd and therefore never gets reported.
   */
  it('is injective over every good and every serf type', () => {
    const seen = new Set<number>();
    for (let t = 0; t < TREND_KEY_RANGE.goods; t += 1) seen.add(trendKey('good', t));
    for (let t = 0; t < TREND_KEY_RANGE.serfs; t += 1) seen.add(trendKey('serf', t));
    expect(seen.size).toBe(TREND_KEY_RANGE.goods + TREND_KEY_RANGE.serfs);
  });

  it('keeps every key inside the slot range the tracker allocates', () => {
    for (let t = 0; t < TREND_KEY_RANGE.serfs; t += 1) {
      expect(trendKey('serf', t)).toBeLessThan(TREND_KEY_RANGE.slots);
    }
    // The offset has to clear the goods, otherwise the check above passes by accident.
    expect(TREND_SERF_BASE).toBeGreaterThanOrEqual(TREND_KEY_RANGE.goods);
  });
});

describe('trendOf', () => {
  /** The dead zone is RELATIVE — this is the case that a fixed threshold of 1 would get wrong. */
  it('ignores ten out of four hundred but not one out of three', () => {
    expect(trendOf(410, 400)).toBe(0);
    expect(trendOf(4, 3)).toBe(1);
  });

  it('holds still inside the zone and moves at its edge', () => {
    expect(trendOf(104, 100)).toBe(0);
    expect(trendOf(105, 100)).toBe(1);
    expect(trendOf(95, 100)).toBe(-1);
    expect(trendOf(96, 100)).toBe(0);
  });

  it('treats a first unit as a change when there was nothing', () => {
    expect(trendOf(1, 0)).toBe(1);
    expect(trendOf(0, 0)).toBe(0);
  });
});

describe('stockTrendTicks', () => {
  it('turns off into a window of nothing and every step into game ticks', () => {
    expect(stockTrendTicks('off')).toBe(0);
    for (const span of STOCK_TREND_SPANS) {
      if (span === 'off') continue;
      expect(stockTrendTicks(span), span).toBe(STOCK_TREND_TICKS[span]);
      expect(stockTrendTicks(span), span).toBeGreaterThan(0);
    }
  });

  it('orders the steps as their names promise', () => {
    expect(STOCK_TREND_TICKS.short).toBeLessThan(STOCK_TREND_TICKS.medium);
    expect(STOCK_TREND_TICKS.medium).toBeLessThan(STOCK_TREND_TICKS.long);
  });
});

/**
 * Runs a sequence of stock values through a fresh tracker, one sample every `tickStep` game ticks,
 * and returns the trends of the last sample.
 */
function run(
  values: readonly number[],
  tickStep: number,
  spanTicks: number,
): ReadonlyMap<number, number> {
  const t = createStockTrends();
  let tick = 0;
  let ms = 0;
  let out: ReadonlyMap<number, number> = new Map();
  for (const v of values) {
    out = t.observe({
      game: GAME,
      selection: SEL,
      gameTick: tick & 0xffff,
      nowMs: ms,
      view: view({ 7: v }),
      spanTicks,
    });
    tick += tickStep;
    ms += 200;
  }
  return out;
}

/** Samples enough to fill the ring at the given step, plus a margin. */
const samplesFor = (spanTicks: number, tickStep: number): number =>
  Math.ceil(spanTicks / tickStep) + STOCK_TREND_SNAPSHOTS + 2;

describe('createStockTrends', () => {
  it('claims nothing from a single sample', () => {
    const t = createStockTrends();
    const out = t.observe({
      game: GAME,
      selection: SEL,
      gameTick: 0,
      nowMs: 0,
      view: view({ 7: 100 }),
      spanTicks: 1500,
    });
    expect(out.get(trendKey('good', 7))).toBe(0);
    expect(t.anchorAgeTicks()).toBe(-1);
  });

  it('reports rising, falling and unchanged once the window is full', () => {
    const span = 1500;
    const step = 20;
    const n = samplesFor(span, step);
    const rising = Array.from({ length: n }, (_, i) => 100 + i * 3);
    const falling = Array.from({ length: n }, (_, i) => 1000 - i * 3);
    const flat = Array.from({ length: n }, () => 500);
    const key = trendKey('good', 7);
    expect(run(rising, step, span).get(key)).toBe(1);
    expect(run(falling, step, span).get(key)).toBe(-1);
    expect(run(flat, step, span).get(key)).toBe(0);
  });

  /**
   * THE test for the game-time decision: the same run of tick totals, sampled once at one times
   * speed and once at eight, has to produce the same arrows. On a wall-clock window it does not.
   */
  it('says the same thing at one times speed as at eight', () => {
    const span = STOCK_TREND_TICKS.medium;
    const key = trendKey('good', 7);
    // Same economy either way: the value follows the TICK, not the sample number.
    const at = (tick: number): number => 200 + Math.floor(tick / 40);
    for (const [slowStep, fastStep] of [
      [20, 160],
      [5, 80],
    ]) {
      const slow = Array.from({ length: samplesFor(span, slowStep) }, (_, i) => at(i * slowStep));
      const fast = Array.from({ length: samplesFor(span, fastStep) }, (_, i) => at(i * fastStep));
      expect(run(slow, slowStep, span).get(key)).toBe(1);
      expect(run(fast, fastStep, span).get(key)).toBe(1);
    }
  });

  it('keeps the reference point between seven eighths and one whole window back', () => {
    const span = STOCK_TREND_TICKS.medium;
    const step = 25;
    const t = createStockTrends();
    let tick = 0;
    let ms = 0;
    let checked = 0;
    for (let i = 0; i < samplesFor(span, step) * 2; i += 1) {
      t.observe({
        game: GAME,
        selection: SEL,
        gameTick: tick & 0xffff,
        nowMs: ms,
        view: view({ 7: 100 + i }),
        spanTicks: span,
      });
      const age = t.anchorAgeTicks();
      if (age >= 0) {
        expect(age).toBeGreaterThanOrEqual(Math.floor((span * 7) / 8) - step);
        expect(age).toBeLessThanOrEqual(span + step);
        checked += 1;
      }
      tick += step;
      ms += 200;
    }
    // Without this the loop could have produced no anchor at all and still passed.
    expect(checked).toBeGreaterThan(10);
  });

  it('does not advance while the tick stands still', () => {
    const t = createStockTrends();
    const span = 1500;
    for (let i = 0; i < 200; i += 1) {
      t.observe({
        game: GAME,
        selection: SEL,
        gameTick: 4242,
        nowMs: i * 200,
        view: view({ 7: 100 + i }),
        spanTicks: span,
      });
    }
    // Two hundred samples, no game time: nothing may have accumulated.
    expect(t.anchorAgeTicks()).toBe(-1);
  });

  it('measures across the sixteen bit wrap', () => {
    const span = 1500;
    const step = 40;
    const t = createStockTrends();
    let tick = 0xffff - 200;
    let ms = 0;
    let last: ReadonlyMap<number, number> = new Map();
    for (let i = 0; i < samplesFor(span, step); i += 1) {
      last = t.observe({
        game: GAME,
        selection: SEL,
        gameTick: tick & 0xffff,
        nowMs: ms,
        view: view({ 7: 100 + i * 4 }),
        spanTicks: span,
      });
      tick += step;
      ms += 200;
    }
    expect(last.get(trendKey('good', 7))).toBe(1);
  });

  it('starts over after a gap in the wall clock', () => {
    const span = 1500;
    const step = 40;
    const t = createStockTrends();
    let tick = 0;
    let ms = 0;
    const feed = (n: number, base: number): ReadonlyMap<number, number> => {
      let out: ReadonlyMap<number, number> = new Map();
      for (let i = 0; i < n; i += 1) {
        out = t.observe({
          game: GAME,
          selection: SEL,
          gameTick: tick & 0xffff,
          nowMs: ms,
          view: view({ 7: base + i * 4 }),
          spanTicks: span,
        });
        tick += step;
        ms += 200;
      }
      return out;
    };
    expect(feed(samplesFor(span, step), 100).get(trendKey('good', 7))).toBe(1);
    ms += TREND_STALE_MS * 2;
    expect(feed(1, 5000).get(trendKey('good', 7))).toBe(0);
    expect(t.anchorAgeTicks()).toBe(-1);
  });

  it('starts over when the selection changes', () => {
    const span = 1500;
    const step = 40;
    const t = createStockTrends();
    let tick = 0;
    let ms = 0;
    const feed = (sel: unknown, n: number, base: number): ReadonlyMap<number, number> => {
      let out: ReadonlyMap<number, number> = new Map();
      for (let i = 0; i < n; i += 1) {
        out = t.observe({
          game: GAME,
          selection: sel,
          gameTick: tick & 0xffff,
          nowMs: ms,
          view: view({ 7: base + i * 4 }),
          spanTicks: span,
        });
        tick += step;
        ms += 200;
      }
      return out;
    };
    expect(feed(SEL, samplesFor(span, step), 100).get(trendKey('good', 7))).toBe(1);
    expect(feed({ id: 'other' }, 1, 5000).get(trendKey('good', 7))).toBe(0);
  });

  it('starts over when another game is loaded', () => {
    const span = 1500;
    const step = 40;
    const t = createStockTrends();
    let tick = 0;
    let ms = 0;
    const feed = (game: unknown, n: number, base: number): ReadonlyMap<number, number> => {
      let out: ReadonlyMap<number, number> = new Map();
      for (let i = 0; i < n; i += 1) {
        out = t.observe({
          game,
          selection: SEL,
          gameTick: tick & 0xffff,
          nowMs: ms,
          view: view({ 7: base + i * 4 }),
          spanTicks: span,
        });
        tick += step;
        ms += 200;
      }
      return out;
    };
    expect(feed(GAME, samplesFor(span, step), 100).get(trendKey('good', 7))).toBe(1);
    expect(feed({ id: 'other' }, 1, 5000).get(trendKey('good', 7))).toBe(0);
  });

  it('reports one entry per row and nothing beyond', () => {
    const t = createStockTrends();
    const out = t.observe({
      game: GAME,
      selection: SEL,
      gameTick: 0,
      nowMs: 0,
      view: {
        goods: [{ kind: 'good', type: 7, icon: 0, value: 5 }],
        serfs: [{ kind: 'serf', type: 21, icon: 0, value: 9 }],
      },
      spanTicks: 1500,
    });
    expect([...out.keys()].sort((a, b) => a - b)).toEqual([
      trendKey('good', 7),
      trendKey('serf', 21),
    ]);
  });

  it('holds still for a row that was not listed before', () => {
    const span = 1500;
    const step = 40;
    const t = createStockTrends();
    let tick = 0;
    let ms = 0;
    for (let i = 0; i < samplesFor(span, step); i += 1) {
      t.observe({
        game: GAME,
        selection: SEL,
        gameTick: tick & 0xffff,
        nowMs: ms,
        view: view({ 7: 100 }),
        spanTicks: span,
      });
      tick += step;
      ms += 200;
    }
    // Same selection object, a row the earlier snapshots never carried: no claim about it.
    const out = t.observe({
      game: GAME,
      selection: SEL,
      gameTick: tick & 0xffff,
      nowMs: ms,
      view: view({ 7: 100, 9: 4000 }),
      spanTicks: span,
    });
    expect(out.get(trendKey('good', 9))).toBe(0);
  });

  it('reports nothing at all while the window is off', () => {
    const t = createStockTrends();
    const out = t.observe({
      game: GAME,
      selection: SEL,
      gameTick: 0,
      nowMs: 0,
      view: view({ 7: 100 }),
      spanTicks: 0,
    });
    expect(out.size).toBe(0);
  });
});
