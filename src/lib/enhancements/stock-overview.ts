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
  FILL_SLOT_BYTES,
  PROFESSION_IDLE_STATE,
  PROFESSION_BUFFER_LENGTH,
  collectFillLevels,
  professionAvailability,
  stockTotals,
} from '../core/engine/stats.js';
import {
  FILL_RULES_FOOD,
  FILL_RULES_INDUSTRY,
  FILL_SLOTS_FOOD,
  FILL_SLOTS_INDUSTRY,
  fillLadderIcon,
} from '../core/stats-popup.js';
import { GOOD_ORDER, SERF_ORDER, goodIcon, serfIcon } from './ui-icons.js';
import {
  SUPPLY_FOOD_MASK,
  SUPPLY_INDUSTRY_MASK,
  SUPPLY_POINTERS,
  supplyIcon,
} from './supply-pointers.js';

/** Selectable goods: resource types 0..25. */
export const GOOD_SLOTS = RESOURCE_TYPE_NAMES.length;
/** Selectable serf types: 0..26 — type 27 ("dead") is not a profession. */
export const SERF_SLOTS = SERF_TYPE_NAMES.length - 1;

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
 * How wide the two cell shapes are, in HALF places — the grid counts halves so that both fit it.
 *
 * All the icons involved are 16 by 16, so the widths are arithmetic: a good or a profession is
 * picture + gap + a two-digit number and comes to about 35 units of scale, a pointer is three
 * pictures with two gaps and comes to about 54. That is 1 : 1.55, and 2 : 3 is the closest whole
 * ratio to it — near enough that a pointer cell stands all but full, and that the row a pointer
 * shares with nothing else leaves at most one good's worth of space.
 *
 * Whole places (1 : 2) would leave a third of every pointer cell empty, and every odd setting would
 * end its pointer rows one place short.
 */
export const STOCK_CELL_SPAN = 2;
export const SUPPLY_CELL_SPAN = 3;

/** Grid columns for a chosen row width. `repeat()` takes no `calc()`, so this comes from here. */
export const gridColumnCount = (perRow: number): number => perRow * STOCK_CELL_SPAN;

/**
 * Half places a pointer cell takes, CLAMPED to the grid.
 *
 * At the narrowest setting the grid has two columns, and a `span 3` would grow an implicit third
 * one — widening the very plate this is meant to keep narrow. One place wide the plate is a column
 * and as wide as its widest cell either way.
 */
export const supplyColumnSpan = (perRow: number): number =>
  Math.min(SUPPLY_CELL_SPAN, gridColumnCount(perRow));

/**
 * THE SIZE IS NOT A SETTING. The readout takes the scale of the control bar below — `uiScaleFor`,
 * a plain `min(zoom, …)` without rounding — so it grows and shrinks with the map exactly as the bar
 * does, steplessly and without anyone choosing anything.
 *
 * A fractional factor survives because the pictures are not re-blitted at it: they are rendered at
 * step 1 and given an explicit, whole-pixel size on the `<img>`, which the browser then scales
 * nearest-neighbour. That is the same treatment the bar gets on the canvas, and the rounding is the
 * same rule as `originBoxRect`.
 *
 * Corner and opacity are not here either — both overlays of ours ask the same two questions, and
 * they are asked once in `overlay-place.ts`.
 */

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
 * Do not preselect a handful of useful goods so the first switch-on is not an empty box: an addition
 * of ours has no business appearing over the game screen before anyone asked for it. That holds for
 * every enhancement, not just this one — see `registry.ts`.
 */
export const STOCK_GOODS_DEFAULT = 0;
export const STOCK_SERFS_DEFAULT = 0;
export const STOCK_SUPPLY_DEFAULT = 0;

// --- the view ---------------------------------------------------------------------------------

export interface StockSelection {
  readonly goods: number;
  readonly serfs: number;
  readonly supply: number;
  readonly mode: StockSerfMode;
  /**
   * Leave out the rows that currently say nothing. One flag per group, because the question is a
   * different one in each — a good nobody has, a profession nobody is, a pointer whose building
   * does not exist — and each switch therefore carries its own wording.
   */
  readonly hideUnusedGoods: boolean;
  readonly hideUnusedSerfs: boolean;
  readonly hideUnusedSupply: boolean;
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

/**
 * One supply pointer. Three pictures instead of a number: who is waiting, for what, and how full
 * the bucket is — the last one being the original's own needle, so the row says the same thing the
 * chain diagram says.
 */
export interface SupplyRow {
  /** Index into {@link SUPPLY_POINTERS} — the key of the row and the bit of the selection. */
  readonly index: number;
  readonly toIcon: number;
  readonly goodIcon: number;
  readonly pointerIcon: number;
}

export interface StockView {
  readonly goods: readonly StockRow[];
  readonly serfs: readonly StockRow[];
  readonly supply: readonly SupplyRow[];
}

function rowsOf(
  kind: 'good' | 'serf',
  order: readonly number[],
  mask: number,
  counts: readonly number[],
  icon: (index: number) => number | null,
  hideUnused: boolean,
): StockRow[] {
  const rows: StockRow[] = [];
  for (const index of order) {
    if (!maskHas(mask, index)) continue;
    const value = counts[index] ?? 0;
    if (hideUnused && value === 0) continue;
    const pic = icon(index);
    if (pic === null) continue;
    rows.push({ kind, type: index, icon: pic, value });
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
 * The selected supply pointers.
 *
 * The two chains are collected SEPARATELY and only when one of their bits is set. Each run walks
 * every building of the player, so an unselected chain must not cost one — and the two runs are not
 * merged into one either: they differ in their type mask (0x7c against 0xfc) and in whether they
 * demand a finished building, so a shared walk would be an invention rather than a port.
 */
function supplyRows(
  state: GameState,
  player: Player,
  mask: number,
  hideUnused: boolean,
): SupplyRow[] {
  const food =
    (mask & SUPPLY_FOOD_MASK) === 0
      ? null
      : collectFillLevels(state, player, FILL_RULES_FOOD, FILL_SLOTS_FOOD, true);
  const industry =
    (mask & SUPPLY_INDUSTRY_MASK) === 0
      ? null
      : collectFillLevels(state, player, FILL_RULES_INDUSTRY, FILL_SLOTS_INDUSTRY, false);

  const rows: SupplyRow[] = [];
  SUPPLY_POINTERS.forEach((p, index) => {
    if (!maskHas(mask, index)) return;
    const slots = p.chain === 'food' ? food : industry;
    if (slots === null) return;
    const slot = slots[p.byteSlot / FILL_SLOT_BYTES] ?? { sum: 0, count: 0 };
    // Left out on `count`, NOT on the fill level. A bucket with contributors that stands at zero is
    // the most important row there is — the buildings are there and they are getting nothing. Only
    // `count === 0` says the receiver does not exist at all, and then the row is about a building
    // the player does not have. (The original tells the two apart as well: its ladder carries a
    // twelfth sprite for "nothing contributes", next to the one for "contributes nothing".)
    if (hideUnused && slot.count === 0) return;
    const toIcon = supplyIcon(p.to);
    const goodIc = supplyIcon(p.good);
    if (toIcon === null || goodIc === null) return;
    rows.push({
      index,
      toIcon,
      goodIcon: goodIc,
      pointerIcon: fillLadderIcon(p.ladder, slot.sum, slot.count),
    });
  });
  return rows;
}

/**
 * The rows to show, in the original's display order.
 *
 * An empty group costs NOTHING: no counting function is called for it. That matters for the serfs,
 * which walk the whole serf table, and for the pointers, which walk all buildings twice.
 *
 * Hiding unused rows does NOT save a walk, and must not be turned into one: whether anything would
 * be left over is not knowable without counting first.
 */
export function buildStockView(state: GameState, player: Player, sel: StockSelection): StockView {
  const goods =
    sel.goods === 0
      ? []
      : rowsOf(
          'good',
          GOOD_ORDER,
          sel.goods,
          stockTotals(state, player),
          goodIcon,
          sel.hideUnusedGoods,
        );
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
          sel.hideUnusedSerfs,
        );
  const supply =
    sel.supply === 0 ? [] : supplyRows(state, player, sel.supply, sel.hideUnusedSupply);
  return { goods, serfs, supply };
}
