import { describe, it, expect } from 'vitest';
import { HACKS, activeHackIds, hackActive, hackOn, hackShown, type Hack } from './hacks.js';
import { SETTINGS_DEFAULTS } from '../settings/settings.svelte.js';
import { SHELL_TABLES } from '../shell/i18n.js';
import { mapObjectSprite } from '../core/map-render.js';

/**
 * The fields of the settings that belong to a HACK, found by their name rather than listed a second
 * time. The capital letter is the boundary: `hack<Id>` and `hackShow<Id>` are a hack's, while
 * `hacksCorner`/`hacksOpacity` are the enhancement's own — `Capitalize` of an id always yields a
 * capital, so the lowercase `s` cannot collide.
 */
const HACK_FIELDS = Object.keys(SETTINGS_DEFAULTS).filter((k) => /^hack[A-Z]/.test(k));

const capitalised = (id: string): string => `${id[0]!.toUpperCase()}${id.slice(1)}`;

describe('hacks registry', () => {
  it('holds something at all', () => {
    // Without this line every check below would pass on an empty list.
    expect(HACKS.length).toBeGreaterThan(0);
  });

  it('gives every hack an id of its own', () => {
    const ids = HACKS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The type binds both keys to the id already; this says the same where a reader sees it — and it
   * is the half that survives a later refactor of the type.
   */
  it('names its settings fields after its id', () => {
    for (const hack of HACKS) {
      expect(hack.showKey, hack.id).toBe(`hackShow${capitalised(hack.id)}`);
      if (hack.kind === 'toggle') expect(hack.key, hack.id).toBe(`hack${capitalised(hack.id)}`);
    }
  });

  /**
   * Every enhancement ships switched off — the rule `registry.ts` states in prose, checked against
   * the defaults instead of trusted. Both halves: no switch in the overlay, and the switch off.
   */
  it('ships every hack switched off', () => {
    for (const hack of HACKS) {
      expect(SETTINGS_DEFAULTS[hack.showKey], hack.id).toBe(false);
      if (hack.kind === 'toggle') expect(SETTINGS_DEFAULTS[hack.key], hack.id).toBe(false);
    }
  });

  /**
   * The other direction, and the one that rots without a check: a `hack…` field nobody claims would
   * be unreachable — persisted, validated, and read by no one.
   */
  it('claims every hack field of the settings', () => {
    const claimed = HACKS.flatMap((h) =>
      h.kind === 'action' ? [h.showKey as string] : [h.showKey as string, h.key as string],
    );
    expect(claimed.sort()).toEqual(HACK_FIELDS.slice().sort());
  });

  /**
   * The overlay draws these instead of the name, so a wrong number is an empty switch — and nothing
   * else would say so: an unknown object simply yields no sprite.
   */
  it('shows only real map objects on its switch', () => {
    for (const hack of HACKS) {
      for (const object of hack.objects ?? []) {
        expect(mapObjectSprite(object, 0), `${hack.id}/${object}`).not.toBeNull();
      }
    }
    // Coverage: at least one hack has to carry pictures, or the loop above proves nothing.
    expect(HACKS.some((h) => (h.objects ?? []).length > 0)).toBe(true);
  });

  it('names every hack with keys both languages know', () => {
    for (const hack of HACKS) {
      for (const lang of ['en', 'de'] as const) {
        expect(Object.keys(SHELL_TABLES[lang]), `${hack.id}/${lang}`).toContain(hack.labelKey);
        expect(Object.keys(SHELL_TABLES[lang]), `${hack.id}/${lang}`).toContain(hack.noteKey);
      }
    }
  });
});

describe('hackActive', () => {
  const hack = HACKS[0]!;
  const on = { ...SETTINGS_DEFAULTS, [hack.showKey]: true, ...(hack.kind === 'toggle' ? { [hack.key]: true } : {}) };

  it('wants both halves', () => {
    expect(hackActive(SETTINGS_DEFAULTS, hack)).toBe(false);
    expect(hackActive(on, hack)).toBe(true);
  });

  /**
   * THE case the second field exists for: switching a hack off in the settings tab must stop it,
   * not merely hide its switch — otherwise it would keep drawing with no way left to reach it.
   */
  it('stops a hack that loses its switch', () => {
    const hidden = { ...on, [hack.showKey]: false };
    expect(hackOn(hidden, hack)).toBe(hack.kind === 'toggle');
    expect(hackShown(hidden, hack)).toBe(false);
    expect(hackActive(hidden, hack)).toBe(false);
    expect(activeHackIds(hidden)).toEqual([]);
  });

  /**
   * An action owns no field, so it is never "in force" afterwards — it happened and is over. Built
   * here rather than shipped: the kind exists so the second one costs an entry, not a redesign.
   */
  it('never counts a one-time action, however it is listed', () => {
    const action = { ...hack, kind: 'action', run: () => {} } as unknown as Hack;
    const listed = { ...SETTINGS_DEFAULTS, [action.showKey]: true };
    expect(hackShown(listed, action)).toBe(true);
    expect(hackOn(listed, action)).toBe(false);
    expect(hackActive(listed, action)).toBe(false);
  });
});

describe('activeHackIds', () => {
  it('lists nothing on the defaults', () => {
    expect(activeHackIds(SETTINGS_DEFAULTS)).toEqual([]);
  });

  it('lists a hack that is listed and on', () => {
    const hack = HACKS[0]!;
    if (hack.kind !== 'toggle') throw new Error('the first hack is expected to be a toggle');
    const settings = { ...SETTINGS_DEFAULTS, [hack.showKey]: true, [hack.key]: true };
    expect(activeHackIds(settings)).toEqual([hack.id]);
  });
});
