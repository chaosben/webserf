import { describe, it, expect } from 'vitest';
import { ENHANCEMENTS, enhancementFor, enhancementTabFor } from './registry.js';
import { SHELL_TABLES } from '../shell/i18n.js';

const ALL_TABS = ENHANCEMENTS.flatMap((e) => e.tabs);

describe('enhancements registry', () => {
  it('holds something at all', () => {
    // Without this line the checks below would pass on an empty list — a check that cannot fail is
    // worse than no check.
    expect(ENHANCEMENTS.length).toBeGreaterThan(0);
    expect(ALL_TABS.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * Ids stay unique across ALL enhancements even though each has a strip of its own: that is what
   * makes the switch-over fallback work without any reset code.
   */
  it('gives every tab an id of its own, across all enhancements', () => {
    const ids = ALL_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ENHANCEMENTS.map((e) => e.id)).size).toBe(ENHANCEMENTS.length);
  });

  it('names every enhancement and every tab with a key both languages know', () => {
    for (const enh of ENHANCEMENTS) {
      expect(Object.keys(SHELL_TABLES.en), enh.id).toContain(enh.labelKey);
      expect(Object.keys(SHELL_TABLES.de), enh.id).toContain(enh.labelKey);
      for (const tab of enh.tabs) {
        expect(Object.keys(SHELL_TABLES.en), tab.id).toContain(tab.labelKey);
      }
    }
  });

  it('gives every enhancement at least one tab, and every tab a body', () => {
    for (const enh of ENHANCEMENTS) {
      expect(enh.tabs.length, enh.id).toBeGreaterThan(0);
      for (const tab of enh.tabs) expect(typeof tab.panel, tab.id).toBe('function');
    }
  });
});

describe('enhancementFor', () => {
  it('finds a known enhancement', () => {
    expect(enhancementFor('stock')).toBe(ENHANCEMENTS[0]);
  });

  it('falls back to the first one', () => {
    expect(enhancementFor('nonsense')).toBe(ENHANCEMENTS[0]);
    expect(enhancementFor(null)).toBe(ENHANCEMENTS[0]);
  });
});

describe('enhancementTabFor', () => {
  it('finds a known tab of that enhancement', () => {
    const enh = ENHANCEMENTS[0]!;
    const wanted = enh.tabs[enh.tabs.length - 1]!;
    expect(enhancementTabFor(enh, wanted.id)).toBe(wanted);
  });

  /**
   * The panel falls back to the first tab when it marks one. Returning something else here would
   * show tab one marked and an empty body.
   */
  it('falls back to the first tab, exactly as the panel marks it', () => {
    const enh = ENHANCEMENTS[0]!;
    expect(enhancementTabFor(enh, 'nonsense')).toBe(enh.tabs[0]);
    expect(enhancementTabFor(enh, null)).toBe(enh.tabs[0]);
  });

  /**
   * THE case that happens on every switch: the remembered id belongs to the enhancement one just
   * left. Without the fallback the panel would render an empty body — which is why there is no
   * reset code anywhere.
   */
  it('lands on the new first tab when the remembered id belongs to another enhancement', () => {
    const foreign = ALL_TABS.find((t) => !ENHANCEMENTS[0]!.tabs.includes(t));
    const enh = ENHANCEMENTS[0]!;
    // With only one enhancement registered, an invented foreign id serves the same purpose.
    expect(enhancementTabFor(enh, foreign?.id ?? 'other.tab')).toBe(enh.tabs[0]);
  });
});
