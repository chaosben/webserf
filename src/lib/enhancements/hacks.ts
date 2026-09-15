/**
 * The hacks: what they are, and which of their two switches asks what.
 *
 * A "hack" shows or does something the original never offered. They live inside ONE enhancement
 * (see `registry.ts`) rather than each becoming an entry of their own, because the panel would
 * otherwise grow a column no one can read.
 *
 * **Three kinds, and the list says which.** A `toggle` stays on until it is switched off; a `value`
 * holds a number one can dial; an `action` happens once when it is pressed and owns nothing at all —
 * no state to store, nothing to restore on the next start. The overlay draws one control per kind,
 * so a new hack is an entry here and not a change there. Only a toggle can be "in force" later,
 * which is what {@link activeHackIds} reports.
 *
 * Today only the toggle has an instance. The other two are shape, not machinery: the point of this
 * list is that the second and third kind cost an entry rather than a redesign.
 *
 * **The settings tab and the overlay ask different things.** The tab decides which hacks appear in
 * the overlay over the game view; a toggle is then flipped there, where its effect is visible. A
 * hack out of the overlay is out of force as well ({@link hackActive}) — otherwise one could hide a
 * running hack and then have no way to stop it.
 *
 * Adding one is an entry here plus, for a toggle, its two fields in `SettingsShape`; neither the tab
 * nor the overlay needs code per hack.
 *
 * **They all ship switched off**, like every enhancement: an addition of ours must not appear over
 * the game screen until someone asks for it. `hacks.test.ts` checks that against the defaults
 * rather than trusting this sentence.
 */
import { MINERAL_SIGNS_LARGE } from '../core/engine/mineral-sign.js';
import type { HackSettingKey, SettingsShape } from '../settings/settings.svelte.js';
import type { ShellKey } from '../shell/i18n.js';

/**
 * The settings fields belonging to a hack — its id, capitalised, behind `hack` and `hackShow`.
 *
 * The intersection is what makes the keys *checked* rather than freely chosen: a typo misses the
 * template, and `music`/`sfx` miss it too although they are booleans as well. Writing the pair by
 * hand would be right today and wrong the first time someone renames an id.
 */
type OfType<T> = { [K in HackSettingKey]: SettingsShape[K] extends T ? K : never }[HackSettingKey];
type HackBoolKey<Id extends string> = `hack${Capitalize<Id>}` & OfType<boolean>;
type HackNumberKey<Id extends string> = `hack${Capitalize<Id>}` & OfType<number>;
type HackShowKey<Id extends string> = `hackShow${Capitalize<Id>}` & OfType<boolean>;

interface HackBase<Id extends string> {
  readonly id: Id;
  /** Whether it appears in the overlay at all — chosen in the settings tab. */
  readonly showKey: HackShowKey<Id>;
  /** Its name, on the checkbox and in the overlay alike. */
  readonly labelKey: ShellKey;
  /** One sentence on what it does. */
  readonly noteKey: ShellKey;
  /**
   * The MAP OBJECTS that stand for it, drawn in the overlay in place of the name.
   *
   * A picture says what a hack shows better than a line of prose does, and it stays short at any
   * plate size — the name would otherwise set the width of the whole column. It is never the only
   * carrier: without an archive, and for a hack that leaves this empty, the name stands there.
   */
  readonly objects?: readonly number[];
}

/** Stays on until switched off; its state is a settings field. */
export interface ToggleHack<Id extends string = string> extends HackBase<Id> {
  readonly kind: 'toggle';
  readonly key: HackBoolKey<Id>;
}

/**
 * Holds a number one can dial in the overlay.
 *
 * `key` resolves to `never` until `SettingsShape` grows a numeric `hack…` field — so this cannot be
 * instantiated by accident, and the first value hack brings its own field with its own validator.
 */
export interface ValueHack<Id extends string = string> extends HackBase<Id> {
  readonly kind: 'value';
  readonly key: HackNumberKey<Id>;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/**
 * Happens once when pressed.
 *
 * `run` takes nothing on purpose: an entry closes over whatever it needs at definition time. The
 * first action that needs the live game state is the moment to give it a handle — with a caller to
 * shape it, rather than a context type invented ahead of its only user.
 */
export interface ActionHack<Id extends string = string> extends HackBase<Id> {
  readonly kind: 'action';
  readonly run: () => void;
}

export type Hack<Id extends string = string> = ToggleHack<Id> | ValueHack<Id> | ActionHack<Id>;

/** Keeps `Id` narrow so the keys are checked against it. */
const defineHack = <Id extends string>(hack: Hack<Id>): Hack<Id> => hack;

export const HACKS: readonly Hack[] = [
  defineHack({
    kind: 'toggle',
    id: 'minerals',
    key: 'hackMinerals',
    showKey: 'hackShowMinerals',
    labelKey: 'enh.hacks.minerals',
    noteKey: 'enh.hacks.minerals.note',
    objects: MINERAL_SIGNS_LARGE,
  }),
];

/** Does this hack appear in the overlay? */
export function hackShown(settings: SettingsShape, hack: Hack): boolean {
  return settings[hack.showKey];
}

/** Is its switch on? An action has none. Says nothing about reachability — see {@link hackActive}. */
export function hackOn(settings: SettingsShape, hack: Hack): boolean {
  return hack.kind === 'toggle' && settings[hack.key];
}

/** In force: listed AND on. The one rule the render gate and the bug report both read. */
export function hackActive(settings: SettingsShape, hack: Hack): boolean {
  return hackShown(settings, hack) && hackOn(settings, hack);
}

/** The hacks in the overlay, in list order. */
export function shownHacks(settings: SettingsShape): Hack[] {
  return HACKS.filter((h) => hackShown(settings, h));
}

/** Is the toggle of this id in force? For the render gate, which names its hacks by id. */
export function hackInForce(settings: SettingsShape, id: string): boolean {
  const hack = HACKS.find((h) => h.id === id);
  return hack !== undefined && hackActive(settings, hack);
}

/** The ids of the hacks in force — for the bug report, which has to say why the picture differs. */
export function activeHackIds(settings: SettingsShape): string[] {
  return HACKS.filter((h) => hackActive(settings, h)).map((h) => h.id);
}
