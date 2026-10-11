import { describe, it, expect, afterEach } from 'vitest';
import {
  HELP_ENHANCEMENT_KEYS,
  HELP_GROUP_KEYS,
  HELP_SECTIONS,
  HELP_TABS,
  helpImageEntry,
  helpItemImages,
  HELP_TOOLLESS_SERFS,
  helpSectionForShot,
  normalizeForSearch,
  searchHelp,
  type HelpImage,
} from './help-content.js';
import { HELP_SHOTS, helpShotForScreen } from './help-shots.js';
import { buildHelpScene } from './help-scene.js';
import { ALL_GROUPS, drawerGroups } from './groups.js';
import { ENHANCEMENTS } from '../enhancements/registry.js';
import { ENTITY_NAME_TABLES } from '../enhancements/entity-names.js';
import { CONTROL_PANEL_BUTTON_ACTIONS } from '../core/ui-render.js';
import { PROFESSION_TOOLS } from '../core/engine/serf-request.js';
import { goodName, serfName } from '../enhancements/entity-names.js';
import { SHELL_LANGUAGES, setShellLanguage, detectShellLanguage, st } from './i18n.js';

/**
 * THE GUARD THAT KEEPS THE HELP CURRENT. It does not judge the wording — it checks that nothing the
 * player can meet is missing: a new control-bar icon, enhancement, rail group or building type
 * without a help line breaks the test suite, and so does a sample game that no longer yields the
 * subjects the dialog pictures need.
 */

afterEach(() => setShellLanguage(detectShellLanguage()));

const allItems = () =>
  Object.entries(HELP_SECTIONS).flatMap(([tab, sections]) =>
    sections.flatMap((section) => section.items.map((item) => ({ tab, section, item }))),
  );

const imagesIn = (tab: string): HelpImage[] =>
  (HELP_SECTIONS[tab] ?? []).flatMap((s) => s.items.flatMap((i) => [...helpItemImages(i)]));

const usedKeys = (): Set<string> =>
  new Set(
    allItems().flatMap(({ item }) =>
      item.kind === 'text'
        ? [item.textKey]
        : item.kind === 'control'
          ? [item.labelKey, item.mouseKey, item.touchKey]
          : [],
    ),
  );

/**
 * The pressed variant of a bar icon is a second icon value for the same button
 * (`CONTROL_PANEL_BUTTON_ACTIONS` lists both). The help explains the button once, under its resting
 * icon.
 */
const PRESSED_TO_RESTING: ReadonlyMap<number, number> = new Map([
  [0x13, 0x0a],
  [0x14, 0x0c],
  [0x15, 0x0e],
  [0x17, 0x02],
  [0x11, 0x03],
  [0x12, 0x04],
  [0x16, 0x10],
  [0x18, 0x08],
]);

describe('help covers the game', () => {
  it('has a section list for every tab and only for those', () => {
    expect(Object.keys(HELP_SECTIONS).sort()).toEqual(HELP_TABS.map((t) => t.id).sort());
  });

  it('explains every control-bar button, with its own icon', () => {
    const shown = new Set(imagesIn('bar').flatMap((img) => (img.kind === 'panel' ? [img.icon] : [])));
    for (const icon of CONTROL_PANEL_BUTTON_ACTIONS.keys()) {
      const resting = PRESSED_TO_RESTING.get(icon) ?? icon;
      expect(shown.has(resting), `bar icon 0x${icon.toString(16)}`).toBe(true);
    }
    for (const [pressed, resting] of PRESSED_TO_RESTING) {
      expect(CONTROL_PANEL_BUTTON_ACTIONS.has(pressed)).toBe(true);
      expect(CONTROL_PANEL_BUTTON_ACTIONS.get(pressed)?.screen).toBe(CONTROL_PANEL_BUTTON_ACTIONS.get(resting)?.screen);
    }
  });

  it('has a picture of every dialog a bar button opens', () => {
    for (const [icon, action] of CONTROL_PANEL_BUTTON_ACTIONS) {
      if (action.screen === undefined || action.screen === null) continue;
      expect(helpShotForScreen(action.screen), `screen 0x${action.screen.toString(16)} (icon 0x${icon.toString(16)})`).not.toBeNull();
    }
  });

  it('explains every enhancement in the enhancements tab', () => {
    const keys = new Set((HELP_SECTIONS.enhance ?? []).flatMap((s) => s.items.map((i) => (i.kind === 'text' ? i.textKey : ''))));
    for (const e of ENHANCEMENTS) {
      const key = HELP_ENHANCEMENT_KEYS[e.id];
      expect(key, e.id).toBeDefined();
      expect(keys.has(key!), e.id).toBe(true);
    }
    expect(Object.keys(HELP_ENHANCEMENT_KEYS).sort()).toEqual(ENHANCEMENTS.map((e) => e.id).sort());
  });

  it('explains every rail group', () => {
    const keys = usedKeys();
    for (const g of ALL_GROUPS) {
      const key = HELP_GROUP_KEYS[g.id];
      expect(key, g.id).toBeDefined();
      expect(keys.has(key!), g.id).toBe(true);
    }
    expect(Object.keys(HELP_GROUP_KEYS).sort()).toEqual(ALL_GROUPS.map((g) => g.id).sort());
  });

  it('shows the help on the rail only with an archive', () => {
    expect(drawerGroups(true).some((g) => g.id === 'help')).toBe(true);
    expect(drawerGroups(false).some((g) => g.id === 'help')).toBe(false);
    expect(drawerGroups(true)).toBe(drawerGroups(true));
  });

  it('shows every building type: 1..23 under economy, the castle in the first steps', () => {
    const economy = new Set(imagesIn('economy').flatMap((img) => (img.kind === 'building' ? [img.type] : [])));
    for (let type = 1; type <= 23; type++) expect(economy.has(type), `building ${type}`).toBe(true);
    expect(imagesIn('start').some((img) => img.kind === 'building' && img.type === 24)).toBe(true);
  });

  it('resolves every picture to an archive entry', () => {
    for (const tab of HELP_TABS) {
      for (const img of imagesIn(tab.id)) {
        const entry = helpImageEntry(img);
        expect(entry, JSON.stringify(img)).not.toBeNull();
        expect(entry!).toBeGreaterThan(0);
        expect(entry!).toBeLessThan(4000);
      }
    }
  });

  it('uses every shot, and only shots that exist', () => {
    const ids = new Set(HELP_SHOTS.map((s) => s.id));
    const used = new Set(allItems().flatMap(({ item }) => (item.kind === 'text' && item.shot ? [item.shot] : [])));
    for (const id of used) expect(ids.has(id), id).toBe(true);
    for (const id of ids) {
      expect(used.has(id), id).toBe(true);
      expect(helpSectionForShot(id), id).not.toBeNull();
    }
    expect(ids.size).toBe(HELP_SHOTS.length);
  });

  it('gives each screen to at most one shot', () => {
    const seen = new Map<number, string>();
    for (const shot of HELP_SHOTS) {
      for (const screen of shot.screens) {
        expect(seen.get(screen), `screen 0x${screen.toString(16)}`).toBeUndefined();
        seen.set(screen, shot.id);
      }
    }
  });
});

describe('search', () => {
  it('ignores case, umlauts and ß', () => {
    expect(normalizeForSearch('Mühle')).toBe('muhle');
    expect(normalizeForSearch('Schloß')).toBe('schloss');
  });

  it('finds every section by its own title, in both languages', () => {
    for (const lang of SHELL_LANGUAGES) {
      setShellLanguage(lang);
      for (const tab of HELP_TABS) {
        for (const section of HELP_SECTIONS[tab.id] ?? []) {
          const hits = searchHelp(st(section.titleKey));
          expect(hits.some((h) => h.tab === tab.id && h.section === section.id), `${lang}: ${section.id}`).toBe(true);
        }
      }
    }
  });

  it('finds every building by its original name, in both languages', () => {
    for (const lang of SHELL_LANGUAGES) {
      setShellLanguage(lang);
      ENTITY_NAME_TABLES.buildings[lang].forEach((name, type) => {
        if (name === undefined) return;
        expect(searchHelp(name).length, `${lang}: ${name} (${type})`).toBeGreaterThan(0);
      });
    }
  });

  it('finds nothing for an empty query', () => {
    expect(searchHelp('   ')).toEqual([]);
  });
});

describe('sample game', () => {
  const scene = buildHelpScene();

  it('has the subjects the dialog pictures need', () => {
    expect(scene.state.buildings[scene.castle]?.type).toBe(24);
    expect(scene.state.flags[scene.castleFlag]).toBeTruthy();
    expect(scene.site).not.toBeNull();
    expect(scene.state.buildings[scene.site!]?.constructing).toBe(true);
    expect(scene.guardHut).not.toBeNull();
    expect(scene.soil).toHaveLength(4);
  });

  it('is deterministic', () => {
    const again = buildHelpScene();
    expect(again.site).toBe(scene.site);
    expect(again.guardHut).toBe(scene.guardHut);
    expect(again.state.serfs.filter(Boolean).length).toBe(scene.state.serfs.filter(Boolean).length);
  });

  it('draws every shot (without sprites, so only the subjects are checked)', () => {
    const palette = { rgba: new Uint8Array(256 * 4) } as never;
    for (const shot of HELP_SHOTS) {
      expect(shot.render({ scene, draw: () => null, palette }), shot.id).not.toBeNull();
    }
  });
});

describe('tools of the professions', () => {
  /**
   * The manual's list (German edition p. 63–65, English "tools" list): the engine's request tables
   * have to say the same, so this checks the engine as much as the help. Resources: shovel 15,
   * hammer 16, rod 17, cleaver 18, scythe 19, axe 20, saw 21, pick 22, pincer 23, sword 24, shield 25.
   */
  const MANUAL: ReadonlyMap<number, readonly number[]> = new Map([
    [2, [15]], // Planierer: Schaufel
    [11, [17]], // Fischer: Angel
    [13, [18]], // Fleischer: Fleischerbeil
    [14, [19]], // Farmer: Sense
    [5, [20]], // Holzfäller: Axt
    [6, [21]], // Schreiner: Säge
    [9, [22]], // Minenarbeiter: Pike
    [7, [22]], // Steinbrucharbeiter: Pike
    [3, [16]], // Bauarbeiter: Hammer
    [17, [16]], // Bootsbauer: Hammer
    [20, [16]], // Geologe: Hammer
    [18, [16, 21]], // Schlosser: Hammer und Säge
    [19, [16, 23]], // Schmied: Hammer und Zange
    [22, [24, 25]], // Ritter: Schwert und Schild (p. 89)
  ]);

  it('the engine requests exactly the tools the manual names, each profession once', () => {
    const fromEngine = new Map(PROFESSION_TOOLS.filter((r) => r.tools.length > 0).map((r) => [r.serfType, [...r.tools]]));
    expect(fromEngine.size).toBe(PROFESSION_TOOLS.filter((r) => r.tools.length > 0).length);
    expect(fromEngine).toEqual(new Map([...MANUAL].map(([k, v]) => [k, [...v]])));
  });

  it('lists every profession: with its tools, or among the ones that need none', () => {
    const rows = allItems().flatMap(({ item }) => (item.kind === 'profession' ? [item] : []));
    for (const req of PROFESSION_TOOLS) {
      if (req.tools.length === 0) {
        expect(HELP_TOOLLESS_SERFS, `serf ${req.serfType}`).toContain(req.serfType);
        expect(rows.some((r) => r.serf === req.serfType), `serf ${req.serfType} has no row`).toBe(false);
      } else {
        expect(rows.filter((r) => r.serf === req.serfType).map((r) => r.tools), `serf ${req.serfType}`).toEqual([req.tools]);
      }
    }
    for (const type of HELP_TOOLLESS_SERFS) {
      expect(PROFESSION_TOOLS.find((r) => r.serfType === type)?.tools, `serf ${type}`).toEqual([]);
    }
  });

  it('finds the pincer and the blacksmith in both languages', () => {
    for (const lang of SHELL_LANGUAGES) {
      setShellLanguage(lang);
      for (const query of [goodName(23), serfName(19)]) {
        expect(searchHelp(query).some((h) => h.section === 'professions'), `${lang}: ${query}`).toBe(true);
      }
    }
  });
});

describe('how the economy hangs together', () => {
  // The words a player types when something puzzles them; each must lead to the section that explains it.
  const QUERIES: Record<string, Record<string, string[]>> = {
    de: {
      transport: ['Fahnen Länge', 'Umwege'],
      construction: ['Notprogramm'],
      distribution: ['Balken null'],
      knights: ['Ritter ausbilden', 'Anwerbe'],
      combat: ['Mut Gold', 'Rang verdoppelt'],
      military: ['Schichtwechsel'],
      land: ['Grenze Wachburg'],
      settlers: ['Nachwuchs'],
    },
    en: {
      transport: ['flags length', 'detours'],
      construction: ['emergency program'],
      distribution: ['bar zero'],
      knights: ['training knights', 'recruit'],
      combat: ['morale gold', 'rank doubles'],
      military: ['shift change'],
      land: ['borders garrison'],
      settlers: ['new arrivals'],
    },
  };

  it('finds each topic in both languages', () => {
    for (const lang of SHELL_LANGUAGES) {
      setShellLanguage(lang);
      for (const [section, queries] of Object.entries(QUERIES[lang] ?? {})) {
        for (const query of queries) {
          expect(searchHelp(query).some((h) => h.section === section), `${lang}: ${query}`).toBe(true);
        }
      }
    }
  });
});
