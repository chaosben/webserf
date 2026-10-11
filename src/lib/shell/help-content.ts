/**
 * THE HELP AS DATA — tabs, sections, lines, pictures. No Svelte here, so the guard in
 * `help-content.test.ts` can check the help against the game: every bar icon, every enhancement,
 * every shell group and every building type has to be explained somewhere.
 *
 * WORDING: names follow the original — the German manual and the game texts for German, the English
 * manual for English. Building, good and profession names are not in the text tables at all but come
 * from `enhancements/entity-names.ts`, which quotes the picture legends of both manuals.
 *
 * Every text key is written out as a literal: the orphan check of the i18n test only finds keys it
 * can see in the source.
 */
import type { OverlayTab } from './drawer.js';
import { st, type ShellKey } from './i18n.js';
import { buildingName, goodName, serfName } from '../enhancements/entity-names.js';
import { goodIcon, serfIcon } from '../enhancements/ui-icons.js';
import { UI_ICON_BASE, UI_PANELBUTTON_BASE, CURSOR_MARKER_BASE } from '../core/ui-render.js';
import { MAP_OBJECT_BASE } from '../core/map-render.js';
import { MAP_BUILDING_SPRITE } from '../core/building-sprites.js';
import type { HelpShotId } from './help-shots.js';

export const HELP_TABS: readonly OverlayTab[] = [
  { id: 'start', labelKey: 'help.tab.start' },
  { id: 'controls', labelKey: 'help.tab.controls' },
  { id: 'bar', labelKey: 'help.tab.bar' },
  { id: 'economy', labelKey: 'help.tab.economy' },
  { id: 'devices', labelKey: 'help.tab.devices' },
  { id: 'enhance', labelKey: 'help.tab.enhance' },
];

/** A picture from the archive. Each kind knows its own bank; the panel only asks for the entry. */
export type HelpImage =
  | { readonly kind: 'panel'; readonly icon: number }
  | { readonly kind: 'marker'; readonly marker: number }
  | { readonly kind: 'sprite'; readonly entry: number }
  | { readonly kind: 'building'; readonly type: number }
  | { readonly kind: 'good'; readonly resource: number }
  | { readonly kind: 'serf'; readonly type: number };

export type HelpItem =
  /** A line of text, optionally with pictures in front and an original dialog below. */
  | {
      readonly kind: 'text';
      readonly textKey: ShellKey;
      readonly images?: readonly HelpImage[];
      readonly shot?: HelpShotId;
    }
  /** One row of the controls table. */
  | {
      readonly kind: 'control';
      readonly labelKey: ShellKey;
      readonly mouseKey: ShellKey;
      readonly touchKey: ShellKey;
    };

export interface HelpSection {
  readonly id: string;
  readonly titleKey: ShellKey;
  readonly items: readonly HelpItem[];
}

const b = (type: number): HelpImage => ({ kind: 'building', type });
const g = (resource: number): HelpImage => ({ kind: 'good', resource });
const panel = (icon: number): HelpImage => ({ kind: 'panel', icon });
const marker = (m: number): HelpImage => ({ kind: 'marker', marker: m });

/** Message note and return arrow of the control bar (absolute archive entries). */
export const HELP_MESSAGE_NOTE = 1781;
export const HELP_RETURN_ARROW = 1783;

/** Marker sprites, relative to {@link CURSOR_MARKER_BASE}. */
const MARK = { arrows: 0x20, flag: 0x2f, mine: 0x30, hut: 0x31, large: 0x32, road: 0x33 } as const;

export const HELP_SECTIONS: Readonly<Record<string, readonly HelpSection[]>> = {
  start: [
    {
      id: 'idea',
      titleKey: 'help.start.idea.title',
      items: [{ kind: 'text', textKey: 'help.start.idea' }],
    },
    {
      id: 'steps',
      titleKey: 'help.start.steps.title',
      items: [
        { kind: 'text', textKey: 'help.start.step1' },
        { kind: 'text', textKey: 'help.start.step2', images: [panel(5), b(24)] },
        { kind: 'text', textKey: 'help.start.step3', images: [marker(MARK.flag), marker(MARK.hut), marker(MARK.large), marker(MARK.mine)], shot: 'buildSmall' },
        { kind: 'text', textKey: 'help.start.step4', images: [panel(8)], shot: 'site' },
        { kind: 'text', textKey: 'help.start.step5', images: [b(2), b(9), b(4), b(17)] },
        { kind: 'text', textKey: 'help.start.step6', images: [b(11), b(21), b(22)], shot: 'military' },
        { kind: 'text', textKey: 'help.start.step7', images: [g(0), g(5), g(2)] },
      ],
    },
    {
      id: 'tips',
      titleKey: 'help.start.tips.title',
      items: [
        { kind: 'text', textKey: 'help.start.tip.grid' },
        { kind: 'text', textKey: 'help.start.tip.close' },
        { kind: 'text', textKey: 'help.start.tip.manual' },
      ],
    },
  ],
  controls: [
    {
      id: 'table',
      titleKey: 'help.controls.title',
      items: [
        { kind: 'control', labelKey: 'help.controls.pick', mouseKey: 'help.controls.pick.mouse', touchKey: 'help.controls.pick.touch' },
        { kind: 'control', labelKey: 'help.controls.move', mouseKey: 'help.controls.move.mouse', touchKey: 'help.controls.move.touch' },
        { kind: 'control', labelKey: 'help.controls.zoom', mouseKey: 'help.controls.zoom.mouse', touchKey: 'help.controls.zoom.touch' },
        { kind: 'control', labelKey: 'help.controls.special', mouseKey: 'help.controls.special.mouse', touchKey: 'help.controls.special.touch' },
        { kind: 'control', labelKey: 'help.controls.pause', mouseKey: 'help.controls.pause.mouse', touchKey: 'help.controls.pause.touch' },
      ],
    },
    {
      id: 'special',
      titleKey: 'help.controls.special.title',
      items: [{ kind: 'text', textKey: 'help.controls.special.what', shot: 'demolish' }],
    },
    {
      id: 'rail',
      titleKey: 'help.rail.title',
      items: [
        { kind: 'text', textKey: 'help.rail.intro' },
        { kind: 'text', textKey: 'help.rail.settings' },
        { kind: 'text', textKey: 'help.rail.io' },
        { kind: 'text', textKey: 'help.rail.bug' },
        { kind: 'text', textKey: 'help.rail.record' },
        { kind: 'text', textKey: 'help.rail.enhance' },
        { kind: 'text', textKey: 'help.rail.info' },
        { kind: 'text', textKey: 'help.rail.help' },
      ],
    },
  ],
  bar: [
    {
      id: 'build',
      titleKey: 'help.bar.build.title',
      items: [
        { kind: 'text', textKey: 'help.bar.flag', images: [panel(1)] },
        { kind: 'text', textKey: 'help.bar.mine', images: [panel(2)], shot: 'buildMines' },
        { kind: 'text', textKey: 'help.bar.hut', images: [panel(3)], shot: 'buildSmall' },
        { kind: 'text', textKey: 'help.bar.large', images: [panel(4)], shot: 'buildLarge' },
        { kind: 'text', textKey: 'help.bar.large2', shot: 'buildLarge2' },
        { kind: 'text', textKey: 'help.bar.castle', images: [panel(5)] },
        { kind: 'text', textKey: 'help.bar.help', images: [panel(0)] },
      ],
    },
    {
      id: 'roads',
      titleKey: 'help.bar.roads.title',
      items: [
        { kind: 'text', textKey: 'help.bar.road', images: [panel(8), marker(MARK.road)] },
        { kind: 'text', textKey: 'help.bar.demolishRoad', images: [panel(0x0f)] },
        { kind: 'text', textKey: 'help.bar.demolish', images: [panel(6)], shot: 'demolish' },
        { kind: 'text', textKey: 'help.bar.geologist', images: [panel(0x10)], shot: 'soil' },
      ],
    },
    {
      id: 'markers',
      titleKey: 'help.bar.markers.title',
      items: [
        { kind: 'text', textKey: 'help.bar.markers', images: [marker(MARK.arrows), marker(MARK.flag), marker(MARK.hut), marker(MARK.large), marker(MARK.mine)] },
      ],
    },
    {
      id: 'menus',
      titleKey: 'help.bar.menus.title',
      items: [
        { kind: 'text', textKey: 'help.bar.map', images: [panel(0x0a)], shot: 'map' },
        { kind: 'text', textKey: 'help.bar.stats', images: [panel(0x0c)], shot: 'statsMenu' },
        { kind: 'text', textKey: 'help.bar.settings', images: [panel(0x0e)], shot: 'settingsMenu' },
        { kind: 'text', textKey: 'help.bar.options', shot: 'options' },
      ],
    },
    {
      id: 'messages',
      titleKey: 'help.bar.messages.title',
      items: [
        { kind: 'text', textKey: 'help.bar.message', images: [{ kind: 'sprite', entry: HELP_MESSAGE_NOTE }], shot: 'message' },
        { kind: 'text', textKey: 'help.bar.return', images: [{ kind: 'sprite', entry: HELP_RETURN_ARROW }] },
      ],
    },
    {
      id: 'windows',
      titleKey: 'help.bar.windows.title',
      items: [
        { kind: 'text', textKey: 'help.bar.flagWindow', shot: 'flag' },
        { kind: 'text', textKey: 'help.bar.siteWindow', shot: 'site' },
      ],
    },
  ],
  economy: [
    {
      id: 'materials',
      titleKey: 'help.eco.materials.title',
      items: [
        { kind: 'text', textKey: 'help.eco.wood', images: [b(9), b(2), g(6), b(17), g(7)] },
        { kind: 'text', textKey: 'help.eco.stone', images: [b(4), g(9)] },
      ],
    },
    {
      id: 'food',
      titleKey: 'help.eco.food.title',
      items: [
        { kind: 'text', textKey: 'help.eco.fish', images: [b(1), g(0)] },
        { kind: 'text', textKey: 'help.eco.bread', images: [b(12), g(3), b(15), g(4), b(16), g(5)] },
        { kind: 'text', textKey: 'help.eco.meat', images: [b(14), g(1), b(13), g(2)] },
        { kind: 'text', textKey: 'help.eco.foodMenu', shot: 'food' },
      ],
    },
    {
      id: 'mining',
      titleKey: 'help.eco.mining.title',
      items: [
        { kind: 'text', textKey: 'help.eco.geologist', images: [{ kind: 'serf', type: 20 }] },
        { kind: 'text', textKey: 'help.eco.mines', images: [b(5), b(6), b(7), b(8)] },
        { kind: 'text', textKey: 'help.eco.smelters', images: [b(18), g(11), b(23), g(14)] },
      ],
    },
    {
      id: 'tools',
      titleKey: 'help.eco.tools.title',
      items: [
        { kind: 'text', textKey: 'help.eco.toolmaker', images: [b(19), g(21), g(22)] },
        { kind: 'text', textKey: 'help.eco.weapons', images: [b(20), g(24), g(25)] },
        { kind: 'text', textKey: 'help.eco.boats', images: [b(3), g(8)] },
      ],
    },
    {
      id: 'military',
      titleKey: 'help.eco.military.title',
      items: [
        { kind: 'text', textKey: 'help.eco.buildings', images: [b(11), b(21), b(22)], shot: 'military' },
        { kind: 'text', textKey: 'help.eco.gold', images: [g(14)], shot: 'knights' },
      ],
    },
    {
      id: 'stock',
      titleKey: 'help.eco.stock.title',
      items: [
        { kind: 'text', textKey: 'help.eco.warehouse', images: [b(10), b(24)], shot: 'castle' },
        { kind: 'text', textKey: 'help.eco.census', shot: 'census' },
        { kind: 'text', textKey: 'help.eco.inventory', shot: 'inventory' },
      ],
    },
    {
      id: 'statistics',
      titleKey: 'help.eco.stats.title',
      items: [
        { kind: 'text', textKey: 'help.eco.stockStats', shot: 'stock' },
        { kind: 'text', textKey: 'help.eco.compare', shot: 'compare' },
      ],
    },
  ],
  devices: [
    {
      id: 'sync',
      titleKey: 'help.devices.title',
      items: [
        { kind: 'text', textKey: 'help.devices.idea' },
        { kind: 'text', textKey: 'help.devices.step1' },
        { kind: 'text', textKey: 'help.devices.step2' },
        { kind: 'text', textKey: 'help.devices.step3' },
        { kind: 'text', textKey: 'help.devices.step4' },
      ],
    },
    {
      id: 'know',
      titleKey: 'help.devices.know.title',
      items: [
        { kind: 'text', textKey: 'help.devices.newer' },
        { kind: 'text', textKey: 'help.devices.browsers' },
        { kind: 'text', textKey: 'help.devices.android' },
        { kind: 'text', textKey: 'help.devices.dosbox' },
      ],
    },
  ],
  enhance: [
    {
      id: 'about',
      titleKey: 'help.enh.title',
      items: [
        { kind: 'text', textKey: 'help.enh.intro' },
        { kind: 'text', textKey: 'help.enh.stock' },
        { kind: 'text', textKey: 'help.enh.hacks' },
        { kind: 'text', textKey: 'help.enh.assist' },
      ],
    },
  ],
};

/**
 * Which help line explains which enhancement and which shell group — the guard reads it, so a new
 * entry in the registry or on the rail needs a line here too.
 */
export const HELP_ENHANCEMENT_KEYS: Readonly<Record<string, ShellKey>> = {
  stock: 'help.enh.stock',
  hacks: 'help.enh.hacks',
  assist: 'help.enh.assist',
};

export const HELP_GROUP_KEYS: Readonly<Record<string, ShellKey>> = {
  settings: 'help.rail.settings',
  io: 'help.rail.io',
  bug: 'help.rail.bug',
  record: 'help.rail.record',
  enhance: 'help.rail.enhance',
  info: 'help.rail.info',
  help: 'help.rail.help',
};

/** Archive entry of a help picture. */
export function helpImageEntry(img: HelpImage): number | null {
  switch (img.kind) {
    case 'panel':
      return UI_PANELBUTTON_BASE + img.icon;
    case 'marker':
      return CURSOR_MARKER_BASE + img.marker;
    case 'sprite':
      return img.entry;
    case 'building': {
      const offset = MAP_BUILDING_SPRITE[img.type];
      return offset === undefined || offset === 0 ? null : MAP_OBJECT_BASE + offset;
    }
    case 'good':
      return UI_ICON_BASE + goodIcon(img.resource);
    case 'serf': {
      const icon = serfIcon(img.type);
      return icon === null ? null : UI_ICON_BASE + icon;
    }
  }
}

/** The caption under a picture — the original's name where the original has one. */
export function helpImageCaption(img: HelpImage): string | null {
  switch (img.kind) {
    case 'building':
      return buildingName(img.type);
    case 'good':
      return goodName(img.resource);
    case 'serf':
      return serfName(img.type);
    default:
      return null;
  }
}

/** Every picture of the help with a readable label — for the contact sheet in the workbench. */
export function helpImageEntries(): { entry: number; key: string }[] {
  const out: { entry: number; key: string }[] = [];
  for (const [tab, sections] of Object.entries(HELP_SECTIONS)) {
    for (const section of sections) {
      for (const item of section.items) {
        if (item.kind !== 'text') continue;
        for (const img of item.images ?? []) {
          const entry = helpImageEntry(img);
          out.push({ entry: entry ?? -1, key: `${tab}/${section.id}/${item.textKey}/${img.kind}` });
        }
      }
    }
  }
  return out;
}

// --- Search --------------------------------------------------------------------------------------

/** Case, umlauts and ß do not matter: "muhle" finds "Mühle", "schloss" finds "Schloß". */
export function normalizeForSearch(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export interface HelpHit {
  readonly tab: string;
  readonly section: string;
  /** Index of the line in its section; `null` when only the section title matched. */
  readonly item: number | null;
}

function itemTexts(item: HelpItem): string[] {
  if (item.kind === 'control') return [st(item.labelKey), st(item.mouseKey), st(item.touchKey)];
  const captions = (item.images ?? []).map(helpImageCaption).filter((c): c is string => c !== null);
  return [st(item.textKey), ...captions];
}

/**
 * Every line whose text, picture captions or section title contain all words of the query — in the
 * shell language. A title match lists the section once instead of every line in it.
 */
export function searchHelp(query: string): HelpHit[] {
  const words = normalizeForSearch(query).split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const matches = (texts: readonly string[]): boolean => {
    const hay = normalizeForSearch(texts.join(' '));
    return words.every((w) => hay.includes(w));
  };
  const hits: HelpHit[] = [];
  for (const tab of HELP_TABS) {
    for (const section of HELP_SECTIONS[tab.id] ?? []) {
      if (matches([st(section.titleKey)])) {
        hits.push({ tab: tab.id, section: section.id, item: null });
        continue;
      }
      section.items.forEach((item, i) => {
        if (matches(itemTexts(item))) hits.push({ tab: tab.id, section: section.id, item: i });
      });
    }
  }
  return hits;
}

/** Where a dialog's shot is explained — for opening the help on the dialog that is open in the game. */
export function helpSectionForShot(shot: HelpShotId): { tab: string; section: string } | null {
  for (const tab of HELP_TABS) {
    for (const section of HELP_SECTIONS[tab.id] ?? []) {
      if (section.items.some((item) => item.kind === 'text' && item.shot === shot)) {
        return { tab: tab.id, section: section.id };
      }
    }
  }
  return null;
}
