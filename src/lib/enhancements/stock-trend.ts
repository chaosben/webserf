/**
 * **Trend of the stock overview** — is a number going up or down.
 *
 * OUR OWN ADDITION, and it has to MEASURE, because there is nothing to read: the game keeps no
 * history of stock levels. Its resource curve records production per interval (the accumulator is
 * zeroed after every copy, which is why it fits in a byte), its statistics curves record normalised
 * shares of land, buildings and military strength, and for settlers there is no series at all. The
 * stock itself exists only as a momentary sum over the warehouses. Deriving the arrow from the
 * production curve would answer a different question — "how much was made", not "is there more of
 * it now".
 *
 * Free of Svelte and of the settings store, like `stock-overview.ts` beside it, and for the same
 * reason: the tree has no component tests, so everything that DECIDES has to live out here.
 *
 * The window counts in GAME TICKS, not milliseconds. That is the one decision with a visible
 * consequence:
 *
 * - At eight times speed the economy moves eight times as far per real second. A wall-clock window
 *   would make the same trade look frantic at 8x and flat at 0.25x — the arrow would describe the
 *   speed slider rather than the economy.
 * - While the simulation is PAUSED the wall clock keeps running. A wall-clock window would drain and
 *   the arrow would decay to "unchanged" although nothing happened. In game time it simply stands
 *   still, which is the truth.
 */
import { subU16 } from '../core/engine/int.js';
import { GOOD_SLOTS, SERF_SLOTS, type StockView } from './stock-overview.js';

/** Falling, unchanged, rising. */
export type StockTrend = -1 | 0 | 1;

/**
 * How far back the comparison reaches. `off` is part of the list on purpose: the chosen step IS the
 * switch, the same way the selection is the switch for the readout itself.
 */
export const STOCK_TREND_SPANS = ['off', 'short', 'medium', 'long'] as const;
export type StockTrendSpan = (typeof STOCK_TREND_SPANS)[number];

/**
 * The three windows, in GAME TICKS (the original runs at 100 ticks per second).
 *
 * The first two are the original's own statistics intervals — the rate at which it samples player
 * standings (1500) and resource production (6000). Taking them rather than inventing round numbers
 * keeps the short and medium arrow on the same footing as the game's own curves; the long one is
 * five minutes of game time.
 */
export const STOCK_TREND_TICKS: Readonly<Record<Exclude<StockTrendSpan, 'off'>, number>> = {
  short: 1500,
  medium: 6000,
  long: 30000,
};

/** Ticks the window spans; 0 means off. */
export function stockTrendTicks(span: StockTrendSpan): number {
  return span === 'off' ? 0 : STOCK_TREND_TICKS[span];
}

// --- keys ---------------------------------------------------------------------------------------

/**
 * Goods (0..25) and serf types (0..26) share one number space, so the serfs are offset. A collision
 * here would not crash — it would show one row's arrow beside another row's number, which is the
 * kind of fault nobody reports because it merely looks wrong now and then. The offset is therefore
 * checked exhaustively rather than argued about.
 */
export const TREND_SERF_BASE = 32;

export const trendKey = (kind: 'good' | 'serf', type: number): number =>
  kind === 'good' ? type : TREND_SERF_BASE + type;

/** One slot per possible key. */
const KEY_SLOTS = 64;

// --- the dead zone ------------------------------------------------------------------------------

/**
 * How much has to change before the arrow does — RELATIVE, because three more geologists mean
 * something and three more planks do not. Without a dead zone the arrow flips with every plank
 * carried in or out, and a flickering arrow is worse than none.
 */
export const TREND_THRESHOLD = 0.05;

export function trendOf(now: number, before: number): StockTrend {
  const step = Math.max(1, Math.round(Math.abs(before) * TREND_THRESHOLD));
  const diff = now - before;
  if (diff >= step) return 1;
  if (diff <= -step) return -1;
  return 0;
}

// --- the tracker --------------------------------------------------------------------------------

/**
 * Snapshots kept. The comparison always runs against the OLDEST of them, so the reference point sits
 * between seven eighths and one whole window in the past regardless of speed.
 */
export const STOCK_TREND_SNAPSHOTS = 8;

/**
 * A wall-clock gap this long counts as an interruption and starts over.
 *
 * This is the only case in which the tick difference could lie: a tab in the background does not
 * draw, so it delivers no samples, and after more than 65536 ticks of absence the 16-bit difference
 * would come back falsely small. Four seconds is far below that even at eight times speed (3200
 * ticks) and far above the 200 ms at which samples normally arrive.
 */
export const TREND_STALE_MS = 4000;

export interface StockTrendSample {
  /**
   * Identity of the running game. A different object means a different world, so the measurement
   * starts over; comparing numbers across a loaded save would be nonsense.
   */
  readonly game: unknown;
  /** Identity of the selection — a changed one brings different rows and a changed serf reading. */
  readonly selection: unknown;
  /** The engine's 16-bit tick. Only differences are used, so the wrap does no harm. */
  readonly gameTick: number;
  /** Wall clock, for the interruption check only. */
  readonly nowMs: number;
  readonly view: StockView;
  /** Window in game ticks; 0 or less starts over and reports nothing. */
  readonly spanTicks: number;
}

export interface StockTrends {
  /** Fold the new numbers in and report the trend per row. */
  observe(sample: StockTrendSample): ReadonlyMap<number, StockTrend>;
  /**
   * How many game ticks back the last comparison reached; -1 while there is no reference point yet.
   * For tests — the production path only needs the map.
   */
  anchorAgeTicks(): number;
}

class Tracker implements StockTrends {
  /** Own counter, summed from 16-bit differences, so it does not wrap. */
  #ticks = 0;
  #lastGameTick = -1;
  #lastNowMs = Number.NEGATIVE_INFINITY;
  #game: unknown = undefined;
  #selection: unknown = undefined;
  #span = 0;

  readonly #ring: Float64Array[] = [];
  /** `#ticks` at which each ring slot was written, parallel to `#ring`. */
  readonly #takenAt: number[] = [];
  #head = 0;
  #filled = 0;
  #lastSnapAt = Number.NEGATIVE_INFINITY;
  #anchorAge = -1;

  observe(s: StockTrendSample): ReadonlyMap<number, StockTrend> {
    if (
      s.game !== this.#game ||
      s.selection !== this.#selection ||
      s.spanTicks !== this.#span ||
      s.nowMs - this.#lastNowMs > TREND_STALE_MS
    ) {
      this.#reset(s);
    }
    this.#lastNowMs = s.nowMs;

    if (s.spanTicks <= 0) return new Map();

    if (this.#lastGameTick >= 0) this.#ticks += subU16(s.gameTick, this.#lastGameTick);
    this.#lastGameTick = s.gameTick;

    const cur = this.#current(s.view);

    // Storage cadence is decoupled from display cadence on purpose: samples arrive every 200 ms of
    // wall clock, which is anything from 5 to 160 game ticks depending on speed. A ring holding the
    // whole window would need six thousand entries at "long" and quarter speed; a ring of eight
    // snapshots one eighth of a window apart is the same reference point for a fraction of that.
    const step = Math.max(1, Math.floor(s.spanTicks / STOCK_TREND_SNAPSHOTS));
    if (this.#ticks - this.#lastSnapAt >= step) {
      this.#push(cur);
      this.#lastSnapAt = this.#ticks;
    }

    const out = new Map<number, StockTrend>();
    // Only a full ring gives the window that was asked for. Until then nothing is claimed: reporting
    // against a snapshot a few seconds old while the user asked about five minutes would be a
    // different statement wearing the same arrow.
    const anchor = this.#filled === STOCK_TREND_SNAPSHOTS ? this.#ring[this.#head]! : null;
    this.#anchorAge = anchor === null ? -1 : this.#ticks - this.#takenAt[this.#head]!;
    for (const row of [...s.view.goods, ...s.view.serfs]) {
      const key = trendKey(row.kind, row.type);
      const before = anchor === null ? Number.NaN : anchor[key]!;
      // NaN means the row was not listed back then — the prefilled value distinguishes "absent" from
      // "stood at zero" without a second structure.
      out.set(key, Number.isNaN(before) ? 0 : trendOf(row.value, before));
    }
    return out;
  }

  anchorAgeTicks(): number {
    return this.#anchorAge;
  }

  #reset(s: StockTrendSample): void {
    this.#ticks = 0;
    this.#lastGameTick = -1;
    this.#game = s.game;
    this.#selection = s.selection;
    this.#span = s.spanTicks;
    this.#head = 0;
    this.#filled = 0;
    this.#lastSnapAt = Number.NEGATIVE_INFINITY;
    this.#anchorAge = -1;
  }

  #current(view: StockView): Float64Array {
    const buf = new Float64Array(KEY_SLOTS).fill(Number.NaN);
    for (const row of view.goods) buf[trendKey(row.kind, row.type)] = row.value;
    for (const row of view.serfs) buf[trendKey(row.kind, row.type)] = row.value;
    return buf;
  }

  #push(cur: Float64Array): void {
    if (this.#ring.length < STOCK_TREND_SNAPSHOTS) {
      this.#ring.push(cur.slice());
      this.#takenAt.push(this.#ticks);
    } else {
      this.#ring[this.#head]!.set(cur);
      this.#takenAt[this.#head] = this.#ticks;
    }
    this.#head = (this.#head + 1) % STOCK_TREND_SNAPSHOTS;
    if (this.#filled < STOCK_TREND_SNAPSHOTS) this.#filled += 1;
  }
}

export function createStockTrends(): StockTrends {
  return new Tracker();
}

/** Slots the key space has to cover — spelled out so the test can be exhaustive. */
export const TREND_KEY_RANGE = { goods: GOOD_SLOTS, serfs: SERF_SLOTS, slots: KEY_SLOTS } as const;
