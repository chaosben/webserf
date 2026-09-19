/**
 * The SUPPLY POINTERS of the two chain diagrams — statistics screens 0x10 (food chain) and 0x11
 * (merchandise chain), the manual's "supply statistics" (ch. 4.3.3).
 *
 * The original draws them inside a fixed picture: heads, goods, arrows, and between them a needle.
 * The stock overview lists a FREELY CHOSEN subset instead, so each pointer needs to say on its own
 * what it is about. Two pictures are needed for that, because neither half is unique: the gold
 * smelter appears twice (ore and coal) and coal appears three times (gold smelter, steel smelter,
 * weaponsmith).
 *
 * Five receivers take two goods, and their pointers stand SIDE BY SIDE in the tables below — which
 * is why the overview can put the receiver's picture at the head of a group without reordering
 * anything. {@link supplyToKey} is what tells two entries of one group apart from two of different
 * ones; a shared constant is not enough, because three of the five are written out twice.
 *
 * NOTHING HERE IS A HAND-WRITTEN ICON NUMBER. Every entry names a good or a profession, and both
 * the picture and the label fall out of it — through {@link goodIcon}/{@link serfIcon} and the
 * manual legends in `entity-names.ts`. Where a receiver has no legend name of its own (a mine, a
 * smelter, the military buildings, the construction sites) the label comes from our own words, but
 * the picture still comes from the reference.
 *
 * Which picture identifies a receiver follows the original diagram: its worker's head where that is
 * unique, its PRODUCT where two receivers share a head — the miner's head stands four times in the
 * food chain, the smelter's twice in the merchandise chain.
 *
 * Order, bucket and ladder direction are not repeated here: they are taken from the original's own
 * display tables, so the list cannot drift away from the screens it mirrors.
 */
import { FILL_DISPLAY_FOOD, FILL_DISPLAY_INDUSTRY } from '../core/stats-popup.js';
import type { FillDisplay } from '../core/stats-popup.js';
import { st, type ShellKey } from '../shell/i18n.js';
import { goodName, serfName } from './entity-names.js';
import { goodIcon, serfIcon } from './ui-icons.js';

export type SupplyChain = 'food' | 'industry';

/**
 * One half of an entry: what it is, plus an optional word of our own where no legend names it. The
 * icon always comes from the `good`/`serf` reference — a label of our own never brings its own
 * picture.
 */
export type SupplySide =
  | { readonly good: number; readonly key?: ShellKey }
  | { readonly serf: number; readonly key?: ShellKey };

/** What a pointer means: who is waiting, and for what. */
interface SupplyMeaning {
  readonly to: SupplySide;
  readonly good: SupplySide;
}

export interface SupplyPointer extends SupplyMeaning {
  readonly chain: SupplyChain;
  /** Byte offset of the bucket in the original's scratch buffer — the key into `collectFillLevels`. */
  readonly byteSlot: number;
  /**
   * Which of the two needles the original draws, and they do NOT mean the same thing:
   *
   * - `up` — the SUPPLY needle. Its field runs red, yellow, green: the more has arrived the better
   *   (mines, the pig farmer, the military, construction sites).
   * - `down` — the WORKLOAD needle. Its field is red on the left (nothing to do), **green in the
   *   middle** (busy and keeping up) and yellow on the right (overloaded). The ideal is the middle,
   *   not the empty end — a miller buried in grain mills no faster, the sacks just pile up.
   *
   * That is why a row shows the original's needle instead of a percentage: one number cannot say
   * which of the two scales it belongs to.
   *
   * Both ladders run the **same** way even though their two drawers add and subtract: an empty
   * bucket sits at the first icon of its bank, a full one at the last. On the workload needle that
   * means empty is the RED stop and full the yellow one — mirroring that ladder makes every idle
   * building look overloaded.
   */
  readonly ladder: 'up' | 'down';
}

/** Resource types, named where this file needs them to read as prose. */
const PIG = 1;
const HAM = 2;
const WHEAT = 3;
const FLOUR = 4;
const LOG = 6;
const PLANK = 7;
const STONE = 9;
const IRON_ORE = 10;
const STEEL = 11;
const COAL = 12;
const GOLD_ORE = 13;
const GOLD_BAR = 14;

/** Serf types, likewise. */
const BUILDER = 3;
const SAWMILLER = 6;
const PIG_FARMER = 12;
const BUTCHER = 13;
const MILLER = 15;
const BAKER = 16;
const BOAT_BUILDER = 17;
const TOOLMAKER = 18;
const WEAPONSMITH = 19;
const KNIGHT4 = 26;

/**
 * A mine's food supply. The original shows it with this one icon in the mine window as well, so the
 * picture is a quotation; only the word "food" is ours, because the legend names the three foods
 * separately and the bucket counts whichever arrived.
 */
const FOOD: SupplySide = { good: HAM, key: 'enh.stock.supply.food' };

/** Screen 0x10, in the order of its display table. */
const FOOD_CHAIN: readonly SupplyMeaning[] = [
  { to: { serf: MILLER }, good: { good: WHEAT } },
  { to: { serf: BAKER }, good: { good: FLOUR } },
  { to: { serf: PIG_FARMER }, good: { good: WHEAT } },
  { to: { serf: BUTCHER }, good: { good: PIG } },
  { to: { good: GOLD_ORE, key: 'enh.stock.supply.mineGold' }, good: FOOD },
  { to: { good: COAL, key: 'enh.stock.supply.mineCoal' }, good: FOOD },
  { to: { good: IRON_ORE, key: 'enh.stock.supply.mineIron' }, good: FOOD },
  { to: { good: STONE, key: 'enh.stock.supply.mineStone' }, good: FOOD },
];

/** The two smelters share the caster's head, so they are told apart by what they pour. */
const GOLD_SMELTER: SupplySide = { good: GOLD_BAR, key: 'enh.stock.supply.smelterGold' };
const STEEL_SMELTER: SupplySide = { good: STEEL, key: 'enh.stock.supply.smelterSteel' };

/** Screen 0x11, likewise. */
const INDUSTRY_CHAIN: readonly SupplyMeaning[] = [
  { to: GOLD_SMELTER, good: { good: GOLD_ORE } },
  { to: GOLD_SMELTER, good: { good: COAL } },
  { to: STEEL_SMELTER, good: { good: COAL } },
  { to: STEEL_SMELTER, good: { good: IRON_ORE } },
  { to: { serf: SAWMILLER }, good: { good: LOG } },
  { to: { serf: KNIGHT4, key: 'enh.stock.supply.military' }, good: { good: GOLD_BAR } },
  { to: { serf: WEAPONSMITH }, good: { good: COAL } },
  { to: { serf: WEAPONSMITH }, good: { good: STEEL } },
  { to: { serf: TOOLMAKER }, good: { good: STEEL } },
  { to: { serf: TOOLMAKER }, good: { good: PLANK } },
  { to: { serf: BOAT_BUILDER }, good: { good: PLANK } },
  { to: { serf: BUILDER, key: 'enh.stock.supply.sites' }, good: { good: PLANK } },
  { to: { serf: BUILDER, key: 'enh.stock.supply.sites' }, good: { good: STONE } },
];

function join(
  chain: SupplyChain,
  display: readonly FillDisplay[],
  meaning: readonly SupplyMeaning[],
): SupplyPointer[] {
  return display.map((d, i) => {
    const m = meaning[i];
    if (m === undefined) throw new Error(`supply pointer ${chain}[${i}] has no meaning`);
    return { chain, byteSlot: d.byteSlot, ladder: d.ladder, to: m.to, good: m.good };
  });
}

/** All pointers of both chains, food first — this order is also the order of the selection bits. */
export const SUPPLY_POINTERS: readonly SupplyPointer[] = [
  ...join('food', FILL_DISPLAY_FOOD, FOOD_CHAIN),
  ...join('industry', FILL_DISPLAY_INDUSTRY, INDUSTRY_CHAIN),
];

export const SUPPLY_SLOTS = SUPPLY_POINTERS.length;
export const SUPPLY_ORDER: readonly number[] = SUPPLY_POINTERS.map((_, i) => i);

const chainMask = (chain: SupplyChain): number =>
  SUPPLY_POINTERS.reduce((m, p, i) => (p.chain === chain ? m | (1 << i) : m), 0);

/**
 * Which bits belong to which chain. The overview uses them to decide whether a chain has to be
 * collected at all — each run walks every building of the player.
 */
export const SUPPLY_FOOD_MASK = chainMask('food');
export const SUPPLY_INDUSTRY_MASK = chainMask('industry');

/** Bank-relative icon of one half of an entry. */
export function supplyIcon(side: SupplySide): number | null {
  return 'good' in side ? goodIcon(side.good) : serfIcon(side.serf);
}

/**
 * Which pointers share a receiver. Two entries belong together exactly when this matches.
 *
 * Comparing the `to` objects would find only three of the five pairs: the two smelters share one
 * constant, but the weaponsmith, the toolmaker and the construction sites are each written out
 * twice, as equal values in separate literals. The word of our own belongs in the key as well —
 * without it the four mines, which are told apart by their product alone, would still be four
 * groups, but a receiver that later took a second label would silently become one.
 */
export function supplyToKey(index: number): string {
  const p = SUPPLY_POINTERS[index];
  if (p === undefined) return `#${index}`;
  const s = p.to;
  return ('good' in s ? `g${s.good}` : `s${s.serf}`) + `:${s.key ?? ''}`;
}

function sideName(side: SupplySide): string {
  if (side.key !== undefined) return st(side.key);
  return 'good' in side ? goodName(side.good) : serfName(side.serf);
}

/**
 * What is delivered on the left, who waits for it on the right — so a pointer reads as a sentence,
 * in the direction of the original's own arrow: "the farmer delivers grain to the miller" (manual
 * ch. 4.3.3, "the goods are delivered from one profession to another IN THE DIRECTION OF THE
 * ARROW").
 *
 * The sentence belongs to ONE pointer, not to a layout. Where the overview groups by receiver, the
 * receiver's picture is the head of the group and no longer the tail of a sentence; the sentence
 * then sits on the good-and-needle pair, which is still read good first. The picker, which lists
 * pointers one by one, keeps both halves in this order.
 */
const SUPPLY_ARROW = ' → ';

/** Label of a pointer, in the shell's language. */
export function supplyName(index: number): string {
  const p = SUPPLY_POINTERS[index];
  if (p === undefined) return `#${index}`;
  return sideName(p.good) + SUPPLY_ARROW + sideName(p.to);
}

/** Name of the receiver alone — the heading of a group, where the overview draws one. */
export function supplyToName(index: number): string {
  const p = SUPPLY_POINTERS[index];
  if (p === undefined) return `#${index}`;
  return sideName(p.to);
}
