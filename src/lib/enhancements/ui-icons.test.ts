import { describe, it, expect } from 'vitest';
import {
  GOOD_ORDER,
  SERF_ORDER,
  SETTLER_ICON,
  SETTLER_SERF_TYPE,
  goodIcon,
  serfIcon,
} from './ui-icons.js';
import { RESOURCE_ICON_BASE, knightRankIcon } from '../core/building-popup.js';
import { PROFESSION_STATS_LAYOUT, PROFESSION_STATS_SLOTS } from '../core/stats-popup.js';
import { RESOURCE_TYPE_NAMES, SERF_TYPE_NAMES } from '../core/save-parser.js';

/**
 * The whole serf mapping rests on ONE property of the original's tables: entry `i` of the layout
 * and slot `i` of the gauge list describe the same cell. If that ever stops holding, every
 * profession in the overview gets the wrong picture — and nothing else in the tree would notice.
 */
describe('the pairing the serf mapping is derived from', () => {
  it('has one layout entry per gauge slot, in the same cell', () => {
    expect(PROFESSION_STATS_LAYOUT.length).toBeGreaterThan(PROFESSION_STATS_SLOTS.length);
    for (let i = 0; i < PROFESSION_STATS_SLOTS.length; i++) {
      const slot = PROFESSION_STATS_SLOTS[i]!;
      const item = PROFESSION_STATS_LAYOUT[i]!;
      expect(item.col + 2, `slot ${i}`).toBe(slot.col);
      expect(item.row, `slot ${i}`).toBe(slot.row);
    }
  });

  it('quotes the settler icon from the table rather than inventing it', () => {
    // The one layout entry without a gauge slot — it is what the number in the corner belongs to.
    expect(PROFESSION_STATS_LAYOUT[PROFESSION_STATS_SLOTS.length]!.icon).toBe(SETTLER_ICON);
  });
});

describe('goodIcon', () => {
  it('is the resource type shifted by the bank offset', () => {
    for (let t = 0; t < RESOURCE_TYPE_NAMES.length; t++) {
      expect(goodIcon(t)).toBe(RESOURCE_ICON_BASE + t);
    }
  });
});

describe('serfIcon', () => {
  /**
   * `knightRankIcon` is written from a different place in the original and knows nothing about the
   * gauge tables. That the two agree is the independent check that the pairing above was read the
   * right way round — an off-by-one would break exactly here.
   */
  it('agrees with the knight formula for all five ranks', () => {
    for (let type = 22; type <= 26; type++) {
      expect(serfIcon(type), SERF_TYPE_NAMES[type]).toBe(knightRankIcon(type));
    }
  });

  it('covers every listed profession and nothing else', () => {
    for (const type of SERF_ORDER) expect(serfIcon(type), SERF_TYPE_NAMES[type]).not.toBeNull();
    // 4 = the internal duplicate, 27 = "dead": the original draws neither.
    expect(serfIcon(4)).toBeNull();
    expect(serfIcon(27)).toBeNull();
    expect(serfIcon(99)).toBeNull();
  });

  it('gives every profession its own icon', () => {
    const icons = SERF_ORDER.map((t) => serfIcon(t));
    expect(new Set(icons).size).toBe(SERF_ORDER.length);
  });
});

describe('display order', () => {
  it('lists every good exactly once', () => {
    expect([...GOOD_ORDER].sort((a, b) => a - b)).toEqual(
      RESOURCE_TYPE_NAMES.map((_, i) => i),
    );
  });

  it('lists every serf type except the duplicate and the dead', () => {
    expect([...SERF_ORDER].sort((a, b) => a - b)).toEqual(
      SERF_TYPE_NAMES.map((_, i) => i).filter((i) => i !== 4 && i !== 27),
    );
  });

  it('puts the settlers last, where the original puts their number', () => {
    expect(SERF_ORDER.at(-1)).toBe(SETTLER_SERF_TYPE);
  });
});
