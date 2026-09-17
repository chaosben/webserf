import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUPPLY_FOOD_MASK,
  SUPPLY_INDUSTRY_MASK,
  SUPPLY_ORDER,
  SUPPLY_POINTERS,
  SUPPLY_SLOTS,
  supplyIcon,
  supplyName,
  type SupplyPointer,
} from './supply-pointers.js';
import {
  FILL_DISPLAY_FOOD,
  FILL_DISPLAY_INDUSTRY,
  FILL_LAYOUT_FOOD,
  FILL_LAYOUT_INDUSTRY,
  FILL_RULES_FOOD,
  FILL_RULES_INDUSTRY,
} from '../core/stats-popup.js';
import { MINE_POPUP_FOOD_ICON, RESOURCE_ICON_BASE } from '../core/building-popup.js';
import { DEMAND_TABLE } from '../core/engine/flag-update.js';
import { SHELL_LANGUAGES, setShellLanguage } from '../shell/i18n.js';
import { goodIcon } from './ui-icons.js';

const forChain = (chain: 'food' | 'industry') => SUPPLY_POINTERS.filter((p) => p.chain === chain);
const rulesOf = (chain: 'food' | 'industry') =>
  chain === 'food' ? FILL_RULES_FOOD : FILL_RULES_INDUSTRY;
const layoutOf = (chain: 'food' | 'industry') =>
  chain === 'food' ? FILL_LAYOUT_FOOD : FILL_LAYOUT_INDUSTRY;

/** The first pair of entries that stand in the given relation — throws rather than skipping. */
function pairWith(rel: (a: SupplyPointer, b: SupplyPointer) => boolean): [number, number] {
  for (let i = 0; i < SUPPLY_SLOTS; i += 1) {
    for (let k = i + 1; k < SUPPLY_SLOTS; k += 1) {
      if (rel(SUPPLY_POINTERS[i]!, SUPPLY_POINTERS[k]!)) return [i, k];
    }
  }
  throw new Error('no such pair — the list no longer needs two pictures per entry');
}

describe('supply pointers — the list mirrors the original screens', () => {
  it('has exactly one entry per display slot of the two screens', () => {
    expect(SUPPLY_SLOTS).toBe(FILL_DISPLAY_FOOD.length + FILL_DISPLAY_INDUSTRY.length);
    expect(SUPPLY_SLOTS).toBe(21);
    expect(SUPPLY_ORDER).toEqual(SUPPLY_POINTERS.map((_, i) => i));
  });

  it('bucket and ladder come from the original display tables, in their order', () => {
    for (const chain of ['food', 'industry'] as const) {
      const display = chain === 'food' ? FILL_DISPLAY_FOOD : FILL_DISPLAY_INDUSTRY;
      expect(forChain(chain).map((p) => [p.byteSlot, p.ladder])).toEqual(
        display.map((d) => [d.byteSlot, d.ladder]),
      );
    }
  });

  it('every bucket is collected by at least one rule of its own chain', () => {
    for (const chain of ['food', 'industry'] as const) {
      const buckets = new Set(rulesOf(chain).map((r) => r.byteSlot));
      for (const p of forChain(chain)) expect(buckets.has(p.byteSlot)).toBe(true);
    }
  });
});

describe('supply pointers — the two pictures', () => {
  it('every icon exists and is one the original diagram of that chain draws', () => {
    for (const p of SUPPLY_POINTERS) {
      const icons = layoutOf(p.chain).map((item) => item.icon);
      for (const side of [p.to, p.good]) {
        const icon = supplyIcon(side);
        expect(icon).not.toBeNull();
        expect(icons).toContain(icon);
      }
    }
  });

  it('the pairs are what tells the entries apart — no two are the same', () => {
    const pairs = SUPPLY_POINTERS.map((p) => `${supplyIcon(p.to)}/${supplyIcon(p.good)}`);
    expect(new Set(pairs).size).toBe(SUPPLY_SLOTS);
  });

  it('receivers that share a worker head are told apart by their product', () => {
    // The miner's head stands for four mines, the caster's for two smelters — those six receivers
    // therefore take a goods icon, every other one a head.
    const byProduct = SUPPLY_POINTERS.filter((p) => 'good' in p.to);
    expect(new Set(byProduct.map((p) => supplyIcon(p.to))).size).toBe(6);
    for (const p of byProduct) expect(supplyIcon(p.to)!).toBeGreaterThanOrEqual(RESOURCE_ICON_BASE);
  });

  it('"food" uses the very icon the original shows a mine its supply with', () => {
    const mine = SUPPLY_POINTERS.find((p) => p.good.key === 'enh.stock.supply.food');
    expect(supplyIcon(mine!.good)).toBe(MINE_POPUP_FOOD_ICON);
  });
});

describe('supply pointers — the delivered good matches the bucket it is read from', () => {
  // Independent source: `DEMAND_TABLE` (`DAT_0004b822`) says through which flag byte a good is
  // requested — 0x42 is stock slot 0 (`bld+8`), 0x44 is slot 1 (`bld+9`). The collecting rule says
  // which of the two bytes it reads. If the pair were wrong, the overview would name a good the
  // bucket does not hold.
  const SLOT_OF_KIND: Record<string, 0 | 1> = {
    stock8: 0,
    norm8: 0,
    stock9: 1,
    norm9: 1,
    gold2: 1,
    gold4: 1,
    gold8: 1,
  };
  const slotOfGood = (res: number): 0 | 1 => (DEMAND_TABLE[res]!.flagByte === 0x42 ? 0 : 1);

  it('every entry names a good that the rule of its bucket reads', () => {
    for (const p of SUPPLY_POINTERS) {
      const good = p.good as { good: number };
      expect('good' in good).toBe(true);
      const rules = rulesOf(p.chain).filter((r) => r.byteSlot === p.byteSlot);
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) {
        expect([p.byteSlot, SLOT_OF_KIND[r.kind]]).toEqual([p.byteSlot, slotOfGood(good.good)]);
      }
    }
  });

  it('all three foods are requested through the same slot, so one word covers them', () => {
    const FISH = 0;
    const HAM = 2;
    const BREAD = 5;
    expect([slotOfGood(FISH), slotOfGood(HAM), slotOfGood(BREAD)]).toEqual([0, 0, 0]);
    expect(goodIcon(HAM)).toBe(MINE_POPUP_FOOD_ICON);
  });
});

describe('supply pointers — labels', () => {
  it('reads in both languages, and every entry differently', () => {
    const before = SHELL_LANGUAGES[0];
    try {
      for (const lang of SHELL_LANGUAGES) {
        setShellLanguage(lang);
        const names = SUPPLY_ORDER.map(supplyName);
        for (const n of names) {
          expect(n).not.toBe('');
          expect(n).not.toContain('#'); // the fallback of `entity-names.ts`
          expect(n).toContain('→');
        }
        expect(new Set(names).size).toBe(SUPPLY_SLOTS);
      }
    } finally {
      setShellLanguage(before);
    }
  });
});

/**
 * A row is a sentence and it runs left to right: what is delivered, who waits for it, how it
 * stands. That is the direction of the original's own arrow — the manual reads its diagram along it
 * ("the farmer delivers grain to the miller", ch. 4.3.3).
 *
 * The label and the pictures say the same thing twice, in two different places. Turn one of them
 * around without the other and the tooltip contradicts the row it belongs to — with no error
 * anywhere, which is what the two tests below are for.
 */
describe('supply pointers — reading direction', () => {
  const HERE = new URL('.', import.meta.url).pathname;
  const read = (name: string) => readFileSync(join(HERE, name), 'utf8');

  it('names the delivered good first and the receiver second', () => {
    const before = SHELL_LANGUAGES[0];
    try {
      setShellLanguage('de');
      expect(supplyName(0)).toBe('Korn → Müller');

      // The same statement without relying on any wording: two entries that share a RECEIVER must
      // differ in the first half and agree in the second, and two that share a GOOD the other way
      // round. Both pairs exist because that is why an entry needs two pictures at all.
      const halves = SUPPLY_ORDER.map((i) => supplyName(i).split(' → '));
      const sameTo = pairWith((a, b) => a.to === b.to && a.good !== b.good);
      const sameGood = pairWith((a, b) => a.good === b.good && a.to !== b.to);
      expect(halves[sameTo[0]]![1]).toBe(halves[sameTo[1]]![1]);
      expect(halves[sameTo[0]]![0]).not.toBe(halves[sameTo[1]]![0]);
      expect(halves[sameGood[0]]![0]).toBe(halves[sameGood[1]]![0]);
      expect(halves[sameGood[0]]![1]).not.toBe(halves[sameGood[1]]![1]);
    } finally {
      setShellLanguage(before);
    }
  });

  /**
   * A SOURCE scan, because the tree has no component tests: it catches the relapse, not a new way
   * of getting it wrong.
   */
  it('draws the pictures in that same order, in the overlay and in the picker', () => {
    const overlay = read('StockOverlay.svelte');
    const good = overlay.indexOf('src={good.url}');
    const to = overlay.indexOf('src={to.url}');
    const needle = overlay.indexOf('src={needle.url}');
    expect(Math.min(good, to, needle), 'the three pictures of a row have moved').toBeGreaterThan(0);
    expect(good).toBeLessThan(to);
    expect(to).toBeLessThan(needle);
    // The row's accessible name sits on the FIRST picture — a reader walks them in document order.
    expect(overlay.slice(good, to)).toContain('alt={name}');

    const picker = read('StockSupplyTab.svelte');
    const first = picker.match(/\n\s*icon=\{\(index\) => sideIcon\(index, '(\w+)'\)\}/);
    expect(first, 'the picker no longer binds its first picture that way').not.toBeNull();
    expect(first![1]).toBe('good');
  });
});

describe('supply pointers — selection bits', () => {
  it('the chain masks split the list without a gap or an overlap', () => {
    expect(SUPPLY_FOOD_MASK & SUPPLY_INDUSTRY_MASK).toBe(0);
    expect(SUPPLY_FOOD_MASK | SUPPLY_INDUSTRY_MASK).toBe(2 ** SUPPLY_SLOTS - 1);
  });

  it('stays inside a safe signed shift', () => {
    // The order is the original's, so a bit cannot move; the count still has to fit `1 << i`.
    expect(SUPPLY_SLOTS).toBeLessThanOrEqual(30);
  });
});
