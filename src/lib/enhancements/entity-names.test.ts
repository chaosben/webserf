import { describe, it, expect, afterEach } from 'vitest';
import {
  ENTITY_NAME_TABLES,
  UNNAMED_SERF_TYPES,
  goodName,
  serfName,
} from './entity-names.js';
import { GOOD_ORDER, SERF_ORDER } from './ui-icons.js';
import { SHELL_LANGUAGES, setShellLanguage, detectShellLanguage } from '../shell/i18n.js';

/**
 * The legends of the two manual editions, quoted in the order they are PRINTED. They are the
 * source of the table; keeping the quotation separate is what makes the table checkable at all —
 * comparing the table against itself would prove nothing.
 */

/** German, third and fourth column, top to bottom — the tool block alone. */
const DE_TOOLS_LEGEND = [
  'Schaufel',
  'Hammer',
  'Angel',
  'Fleischerbeil',
  'Sense',
  'Axt',
  'Säge',
  'Spitzhacke',
  'Zange',
  'Schwert',
  'Schild',
];

/** English, "Resources and Tools", read column-wise. */
const EN_GOODS_LEGEND = [
  'Axe',
  'Boat',
  'Bread',
  "Butcher's Knife",
  'Coal',
  'Fish',
  'Fishing Rod',
  'Flour',
  'Gold',
  'Gold (Ore)',
  'Ham',
  'Hammer',
  'Iron',
  'Iron (Ore)',
  'Pick',
  'Pigs',
  'Pliers',
  'Saw',
  'Scythe',
  'Shield',
  'Shovel',
  'Stones',
  'Sword',
  'Tree Trunks',
  'Wheat',
  'Wood',
];

/** English, "Jobs", read column-wise — without the five ranks, which stand under their own head. */
const EN_JOBS_LEGEND = [
  'Baker',
  'Blacksmith',
  'Butcher',
  'Caster (of Iron)',
  'Construction Worker',
  'Farmer (of Wheat)',
  'Fisherman',
  'Forest Ranger',
  'Geologist',
  'Leveler',
  'Lumberjack',
  'Miller (of Wheat)',
  'Miner',
  'Pig Farmer',
  'Quarryman',
  'Sawmill Worker',
  'Ship Maker',
  'Tool Maker',
  'Transporter (Water Ways)',
  'Transporter (Merchandise)',
];

const EN_RANKS_LEGEND = [
  '2nd Lance Corporal',
  '1st Lance Corporal',
  'Corporal',
  'Lieutenant',
  'Captain',
];
const DE_RANKS_LEGEND = [
  'Gefreiter',
  'Obergefreiter',
  'Unteroffizier',
  'Leutnant',
  'Hauptmann',
];

/** Serf type 21 is in neither legend — the manuals only call them "unemployed" in running text. */
const SETTLER_TYPE = 21;
const KNIGHT_TYPES = [22, 23, 24, 25, 26];

afterEach(() => setShellLanguage(detectShellLanguage()));

describe('entity names', () => {
  /**
   * The point of this pair of checks: a shifted insert on ONE side would otherwise go unnoticed —
   * the affected type would simply carry a neighbour's name, in one language only.
   */
  it('fills both languages for exactly the same indices', () => {
    for (const group of ['goods', 'serfs'] as const) {
      const table = ENTITY_NAME_TABLES[group];
      const filled = (list: readonly (string | undefined)[]): number[] =>
        list.map((v, i) => (v === undefined ? -1 : i)).filter((i) => i >= 0);
      expect(filled(table.de)).toEqual(filled(table.en));
      expect(table.de.length).toBe(table.en.length);
    }
  });

  it('names every entry the overview can list', () => {
    for (const lang of SHELL_LANGUAGES) {
      setShellLanguage(lang);
      for (const type of GOOD_ORDER) expect(goodName(type).length).toBeGreaterThan(0);
      for (const type of SERF_ORDER) expect(serfName(type).length).toBeGreaterThan(0);
    }
  });

  it('leaves exactly the two types the original never shows unnamed', () => {
    const table = ENTITY_NAME_TABLES.serfs;
    const gaps = table.en.map((v, i) => (v === undefined ? i : -1)).filter((i) => i >= 0);
    expect(gaps).toEqual([...UNNAMED_SERF_TYPES].filter((t) => t < table.en.length));
    for (const type of UNNAMED_SERF_TYPES) expect(SERF_ORDER).not.toContain(type);
  });

  it('uses no name twice', () => {
    for (const group of ['goods', 'serfs'] as const) {
      for (const lang of SHELL_LANGUAGES) {
        const names = ENTITY_NAME_TABLES[group][lang].filter((v) => v !== undefined);
        expect(new Set(names).size).toBe(names.length);
      }
    }
  });

  /**
   * The German legend runs in the internal type order once its three unshown types drop out. The
   * tool block is the stretch where that is checkable without trusting the column layout: eleven
   * consecutive names, printed in one run.
   */
  it('carries the German tool block as printed, at types 15..25', () => {
    expect(ENTITY_NAME_TABLES.goods.de.slice(15, 26)).toEqual(DE_TOOLS_LEGEND);
  });

  /**
   * The English legend is sorted the other way — alphabetically — and therefore validates the same
   * mapping a second time, independently of the German column order.
   */
  it('carries exactly the English goods legend', () => {
    const named = ENTITY_NAME_TABLES.goods.en.filter((v) => v !== undefined);
    expect([...named].sort()).toEqual([...EN_GOODS_LEGEND].sort());
    expect(named.length).toBe(EN_GOODS_LEGEND.length);
  });

  it('carries exactly the English jobs legend, plus ranks and the unemployed', () => {
    const named = ENTITY_NAME_TABLES.serfs.en.filter((v) => v !== undefined);
    const expected = [...EN_JOBS_LEGEND, ...EN_RANKS_LEGEND, 'Unemployed'];
    expect([...named].sort()).toEqual([...expected].sort());
    expect(named.length).toBe(expected.length);
  });

  /**
   * That the English legend really is alphabetical is what makes the check above an independent
   * ordering. The one exception is printed as it stands: the two transporters come the other way
   * round.
   */
  it('has an alphabetical English legend, but for the transporter pair', () => {
    expect(EN_GOODS_LEGEND).toEqual([...EN_GOODS_LEGEND].sort());
    const jobs = EN_JOBS_LEGEND.slice(0, -2);
    expect(jobs).toEqual([...jobs].sort());
    expect(EN_JOBS_LEGEND.slice(-2)).toEqual([
      'Transporter (Water Ways)',
      'Transporter (Merchandise)',
    ]);
  });

  it('puts the five ranks on types 22..26, ascending and distinct', () => {
    setShellLanguage('de');
    expect(KNIGHT_TYPES.map(serfName)).toEqual(DE_RANKS_LEGEND);
    setShellLanguage('en');
    expect(KNIGHT_TYPES.map(serfName)).toEqual(EN_RANKS_LEGEND);
    expect(new Set(DE_RANKS_LEGEND).size).toBe(5);
    expect(new Set(EN_RANKS_LEGEND).size).toBe(5);
  });

  it('names the unemployed settler in both languages', () => {
    setShellLanguage('de');
    expect(serfName(SETTLER_TYPE)).toBe('Arbeitslose');
    setShellLanguage('en');
    expect(serfName(SETTLER_TYPE)).toBe('Unemployed');
  });

  it('follows the shell language', () => {
    setShellLanguage('de');
    expect(goodName(7)).toBe('Bauholz');
    setShellLanguage('en');
    expect(goodName(7)).toBe('Wood');
  });

  /** An index outside the table has to stay recognisable rather than turn into a blank. */
  it('falls back visibly for an unknown index', () => {
    expect(goodName(99)).toBe('#99');
    expect(serfName(4)).toBe('#4');
  });
});
