/**
 * The enhancements and their tabs.
 *
 * An "enhancement" is an addition of ours with no counterpart in the original. There will be more
 * of them, and this list is the reason the page does not have to grow with each one: it contributes
 * a group to the rail ONCE, and everything after that is an entry here.
 *
 * The panel has TWO levels: the enhancements stand in a column on the left, and the tab strip on
 * the right carries the tabs of the open one alone. That is why the strip cannot overflow as the
 * list grows — it never holds more than one enhancement's worth.
 *
 * **Every enhancement ships switched OFF.** An addition of ours has no counterpart in the original,
 * so it must not appear over the game screen until someone asks for it; whoever adds one here gives
 * it a default that shows nothing.
 *
 * Tab ids stay unique across the whole list all the same (`stock.goods`), and the switch-over
 * fallback falls out of that for free: after changing enhancement the remembered id belongs to
 * another one, so {@link enhancementTabFor} lands on the new first tab without any reset code.
 */
import type { Component } from 'svelte';
import type { OverlayTab } from '../shell/drawer.js';
import type { ShellKey } from '../shell/i18n.js';
import StockGoodsTab from './StockGoodsTab.svelte';
import StockSerfsTab from './StockSerfsTab.svelte';
import StockDisplayTab from './StockDisplayTab.svelte';

/** A tab of the enhancements panel, plus the body it shows. */
export interface EnhancementTab extends OverlayTab {
  readonly panel: Component;
}

export interface Enhancement {
  readonly id: string;
  /** Its name in the column on the left. */
  readonly labelKey: ShellKey;
  readonly tabs: readonly EnhancementTab[];
}

export const ENHANCEMENTS: readonly Enhancement[] = [
  {
    id: 'stock',
    labelKey: 'enh.stock.name',
    tabs: [
      { id: 'stock.goods', labelKey: 'enh.tab.goods', panel: StockGoodsTab },
      { id: 'stock.serfs', labelKey: 'enh.tab.serfs', panel: StockSerfsTab },
      { id: 'stock.view', labelKey: 'enh.tab.view', panel: StockDisplayTab },
    ],
  },
];

/** The open enhancement for a remembered id; the first one when it names none of them. */
export function enhancementFor(id: string | null): Enhancement {
  return ENHANCEMENTS.find((e) => e.id === id) ?? ENHANCEMENTS[0]!;
}

/**
 * The open tab WITHIN an enhancement, for a remembered id.
 *
 * The fallback to its first tab is not a nicety: `OverlayPanel` falls back the same way when it
 * marks a tab. If the two disagreed, a foreign id would show tab one marked and an empty body —
 * which is exactly the situation right after switching enhancement.
 */
export function enhancementTabFor(enh: Enhancement, tabId: string | null): EnhancementTab {
  return enh.tabs.find((t) => t.id === tabId) ?? enh.tabs[0]!;
}
