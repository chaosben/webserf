/**
 * Names of goods and professions, as the ORIGINAL calls them.
 *
 * These names exist nowhere in the game itself: on screen those things are always PICTURES, never
 * text, which is why the program files carry no such strings either. The one place the original
 * spells them out is the pictorial legend at the end of its manual — German and English editions
 * each have one, and both are used here verbatim. This table is therefore original DATA, not our
 * own wording; the oddities (`Butcher's Knife`, `Farmer (of Wheat)`, `Gold (Erz)`) stay as printed.
 *
 * The two legends validate the mapping independently, because they are sorted DIFFERENTLY: the
 * German one runs column-wise in the internal type order once the three types it never shows drop
 * out, while the English one is alphabetical. Two orderings that know nothing of each other land on
 * the same sets and pair up without contradiction.
 *
 * One case is in neither legend and is named rather than invented: serf type 21, the settler with
 * no profession. Both manuals call them "unemployed" in running text.
 *
 * The names are for the DIALOG. The readout over the map stays purely pictorial, as the original's
 * screens are — there they serve only `alt`/`title` and the fallback when no archive is loaded.
 */
import { shellLanguage, type ShellLanguage } from '../shell/i18n.js';

type NameTable = Readonly<Record<ShellLanguage, readonly (string | undefined)[]>>;

/**
 * Goods, indexed by resource type.
 *
 * German legend order (top to bottom, third column then fourth): Korn…Goldbarren is types 3..14,
 * Fisch/Schwein/Schinken is 0..2, Schaufel…Schild is 15..25 — the tool block is the internal order
 * character for character, which pins the whole column without having to trust its layout.
 */
const GOOD_NAMES: NameTable = {
  de: [
    'Fisch',
    'Schwein',
    'Schinken',
    'Korn',
    'Mehl',
    'Brot',
    'Baumstamm',
    'Bauholz',
    'Ruderboot',
    'Bausteine',
    'Eisenerz',
    'Roheisen',
    'Kohle',
    'Gold (Erz)',
    'Goldbarren',
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
    'Schild'
  ],
  en: [
    'Fish',
    'Pigs',
    'Ham',
    'Wheat',
    'Flour',
    'Bread',
    'Tree Trunks',
    'Wood',
    'Boat',
    'Stones',
    'Iron (Ore)',
    'Iron',
    'Coal',
    'Gold (Ore)',
    'Gold',
    'Shovel',
    'Hammer',
    'Fishing Rod',
    "Butcher's Knife",
    'Scythe',
    'Axe',
    'Saw',
    'Pick',
    'Pliers',
    'Sword',
    'Shield'
  ]
};

/**
 * Professions, indexed by serf type. Gaps on purpose: type 4 is the internal duplicate entry the
 * original's population sum skips as well, and type 27 ("dead") is not a profession — neither
 * legend lists them, and neither is offered for selection.
 *
 * The five knight ranks stand under their own heading in both legends, in ascending order.
 */
const SERF_NAMES: NameTable = {
  de: [
    'Träger',
    'Fährmann',
    'Planierer',
    'Bauarbeiter',
    undefined,
    'Holzfäller',
    'Schreiner',
    'Steinmetz',
    'Förster',
    'Bergmann',
    'Schmelzer',
    'Fischer',
    'Schweinebauer',
    'Schlachter',
    'Getreidebauer',
    'Müller',
    'Bäcker',
    'Werftarbeiter',
    'Werkzeugmacher',
    'Schmied',
    'Geologe',
    'Arbeitslose',
    'Gefreiter',
    'Obergefreiter',
    'Unteroffizier',
    'Leutnant',
    'Hauptmann'
  ],
  en: [
    'Transporter (Merchandise)',
    'Transporter (Water Ways)',
    'Leveler',
    'Construction Worker',
    undefined,
    'Lumberjack',
    'Sawmill Worker',
    'Quarryman',
    'Forest Ranger',
    'Miner',
    'Caster (of Iron)',
    'Fisherman',
    'Pig Farmer',
    'Butcher',
    'Farmer (of Wheat)',
    'Miller (of Wheat)',
    'Baker',
    'Ship Maker',
    'Tool Maker',
    'Blacksmith',
    'Geologist',
    'Unemployed',
    '2nd Lance Corporal',
    '1st Lance Corporal',
    'Corporal',
    'Lieutenant',
    'Captain'
  ]
};

/** The serf types the legend names — the two gaps above, spelled out for the tests. */
export const UNNAMED_SERF_TYPES: readonly number[] = [4, 27];

/** Both tables, for tests. Production code goes through the two functions. */
export const ENTITY_NAME_TABLES = { goods: GOOD_NAMES, serfs: SERF_NAMES } as const;

function pick(table: NameTable, index: number): string {
  return table[shellLanguage()][index] ?? table.en[index] ?? `#${index}`;
}

/** Display name of a good, in the shell's language. */
export function goodName(resourceType: number): string {
  return pick(GOOD_NAMES, resourceType);
}

/** Display name of a serf type, in the shell's language. */
export function serfName(serfType: number): string {
  return pick(SERF_NAMES, serfType);
}
