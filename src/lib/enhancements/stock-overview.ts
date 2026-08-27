/**
 * **Stock overview** — what the player has available in their warehouses, as a list the overlay
 * draws over the game surface.
 *
 * OUR OWN ADDITION. The original shows these numbers only inside windows that cover half the map
 * (screens 0x09, 0x12, 0x13); it has no permanent readout, and it never lets you choose what is
 * listed. The counting itself is not reinvented here — it is the original's, taken from
 * `engine/stats.ts`.
 *
 * This module is deliberately free of Svelte and of the settings store: everything that decides
 * WHAT is shown has to be testable, and the tree has no component tests.
 */
import { RESOURCE_TYPE_NAMES, SERF_TYPE_NAMES } from '../core/save-parser.js';
import type { GameState, Player } from '../core/engine/state.js';
import {
  PROFESSION_IDLE_STATE,
  PROFESSION_BUFFER_LENGTH,
  professionAvailability,
  stockTotals,
} from '../core/engine/stats.js';
import { GOOD_ORDER, SERF_ORDER, goodIcon, serfIcon } from './ui-icons.js';

/** Selectable goods: resource types 0..25. */
export const GOOD_SLOTS = RESOURCE_TYPE_NAMES.length;
/** Selectable serf types: 0..26 — type 27 ("dead") is not a profession. */
export const SERF_SLOTS = SERF_TYPE_NAMES.length - 1;

/** Which corner of the game surface the overlay sits in. */
export const STOCK_CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
export type StockCorner = (typeof STOCK_CORNERS)[number];

/**
 * What the serf numbers mean.
 *
 * - `idle` — settlers of that profession currently resting in a warehouse. The literal reading of
 *   "available in the stores".
 * - `available` — what could be MADE of them: the original's screen 0x13, which adds the
 *   unemployed settlers to every profession whose tool lies in the store. One settler therefore
 *   counts several times over; that is the question "how many of these could I have", not "how
 *   would they divide up".
 */
export const STOCK_SERF_MODES = ['idle', 'available'] as const;
export type StockSerfMode = (typeof STOCK_SERF_MODES)[number];

/**
 * How many entries stand side by side before the list wraps — the choice between a narrow column
 * and a wide strip, expressed as a number so both extremes and everything between are reachable.
 */
export const STOCK_PER_ROW_MIN = 1;
export const STOCK_PER_ROW_MAX = 12;
export const STOCK_PER_ROW_DEFAULT = 1;

/**
 * Size of the pictures and numbers, as a whole multiple of the original's own pixels.
 *
 * `auto` follows the game interface, so the readout grows and shrinks with it; a fixed step keeps
 * it put while zooming. Strings rather than a number with 0 as a special value: that way the
 * settings validator stays the one-line `isOneOf` form.
 */
export const STOCK_SCALES = ['auto', '1', '2', '3', '4'] as const;
export type StockScale = (typeof STOCK_SCALES)[number];
export const STOCK_SCALE_MAX = 4;

/** Whole steps only — a fractional factor would interpolate the pixel art into mush. */
export function stockScaleFactor(pref: StockScale, uiScale: number): number {
  if (pref !== 'auto') return Number(pref);
  return Math.max(1, Math.min(STOCK_SCALE_MAX, Math.round(uiScale)));
}

export const STOCK_OPACITY_MIN = 0.2;
export const STOCK_OPACITY_MAX = 1;
export const STOCK_OPACITY_DEFAULT = 0.8;

/**
 * How long one displayed set of numbers stands, in wall-clock milliseconds.
 *
 * At eight times speed the logic frame comes up to a hundred times a second. Recomputing is cheap;
 * rewriting fifty text nodes that often is not, and a number flickering at that rate cannot be read
 * anyway. This is a DISPLAY throttle only — it touches no logic and therefore no determinism.
 */
export const STOCK_REFRESH_MS = 200;

/**
 * `true` when the shown numbers may be replaced.
 *
 * While the simulation is PAUSED there is no throttling: the frame counter then only moves after an
 * action of the user's own, and a stale number right after your own click looks like a fault.
 */
export function stockRefreshDue(now: number, last: number, playing: boolean): boolean {
  return !playing || now - last >= STOCK_REFRESH_MS;
}

// --- selection masks --------------------------------------------------------------------------

/**
 * The selections are BIT MASKS, not index lists: that gives the settings validator a real range
 * check in one line instead of four (array, element type, range, duplicates), and it keeps the
 * store free of arrays, which need their own copy in `fresh()`. Order is not lost either — it never
 * lived in the selection but in {@link GOOD_ORDER} / {@link SERF_ORDER}, which come from the
 * original.
 *
 * Valid up to 30 slots (`1 << i` is signed). Beyond that the mask has to become an array.
 */
export const maskOf = (indices: readonly number[]): number =>
  indices.reduce((m, i) => m | (1 << i), 0);
export const maskHas = (mask: number, index: number): boolean => (mask & (1 << index)) !== 0;
export const maskToggled = (mask: number, index: number): number => mask ^ (1 << index);

/**
 * NOTHING is selected to begin with, and since the selection is the switch, that is the readout
 * switched off.
 *
 * An earlier version started with a handful of useful goods on the grounds that the first switch-on
 * must not show an empty box. That was the wrong trade: an addition of ours has no business
 * appearing over the game screen before anyone asked for it. It holds for every enhancement, not
 * just this one — see `registry.ts`.
 */
export const STOCK_GOODS_DEFAULT = 0;
export const STOCK_SERFS_DEFAULT = 0;

// --- the view ---------------------------------------------------------------------------------

export interface StockSelection {
  readonly goods: number;
  readonly serfs: number;
  readonly mode: StockSerfMode;
}

export interface StockRow {
  readonly kind: 'good' | 'serf';
  /** Resource type or serf type — the caller looks the name up when it shows one. */
  readonly type: number;
  /** Bank-relative UI icon. */
  readonly icon: number;
  /**
   * The original's counters saturate at 65535 rather than wrapping; the number is passed on as the
   * statistics screen shows it.
   */
  readonly value: number;
}

export interface StockView {
  readonly goods: readonly StockRow[];
  readonly serfs: readonly StockRow[];
}

function rowsOf(
  kind: 'good' | 'serf',
  order: readonly number[],
  mask: number,
  counts: readonly number[],
  icon: (index: number) => number | null,
): StockRow[] {
  const rows: StockRow[] = [];
  for (const index of order) {
    if (!maskHas(mask, index)) continue;
    const pic = icon(index);
    if (pic === null) continue;
    rows.push({ kind, type: index, icon: pic, value: counts[index] ?? 0 });
  }
  return rows;
}

/**
 * Settlers resting in the player's own warehouses, per profession — phase one of
 * {@link professionAvailability}, without the retrainable ones added on top.
 */
export function idleInStock(state: GameState, player: Player): number[] {
  const buf = new Array<number>(PROFESSION_BUFFER_LENGTH).fill(0);
  for (const serf of state.serfs) {
    if (serf === null) continue;
    if (serf.state !== PROFESSION_IDLE_STATE) continue;
    if (serf.owner !== player.slot) continue;
    if (serf.type < PROFESSION_BUFFER_LENGTH) buf[serf.type] += 1;
  }
  return buf;
}

/**
 * The rows to show, in the original's display order.
 *
 * An empty half costs NOTHING: neither counting function is called for it. That matters for the
 * serfs, which walk the whole serf table.
 */
export function buildStockView(state: GameState, player: Player, sel: StockSelection): StockView {
  const goods =
    sel.goods === 0
      ? []
      : rowsOf('good', GOOD_ORDER, sel.goods, stockTotals(state, player), goodIcon);
  const serfs =
    sel.serfs === 0
      ? []
      : rowsOf(
          'serf',
          SERF_ORDER,
          sel.serfs,
          sel.mode === 'available'
            ? professionAvailability(state, player)
            : idleInStock(state, player),
          serfIcon,
        );
  return { goods, serfs };
}
