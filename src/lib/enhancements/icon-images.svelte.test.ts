import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_SCALE_MAX, cacheKey, iconUrl, provideIconSource } from './icon-images.svelte.js';
import type { PaArchive } from '../core/pa-parser.js';
import type { Palette } from '../core/types.js';

/** Nothing here decodes: the registration path never touches archive or palette. */
const archive = { getRaw: () => null } as unknown as PaArchive;
const palette = [] as unknown as Palette;

describe('icon source', () => {
  it('answers with nothing while none is registered', () => {
    expect(iconUrl(0x22)).toBeNull();
  });

  it('forgets the pictures again when the source goes', () => {
    const drop = provideIconSource(archive, palette);
    // No 2D context here, so every lookup is a miss — what matters is that it does not throw and
    // that unregistering leaves nothing behind.
    expect(iconUrl(0x22)).toBeNull();
    drop();
    expect(iconUrl(0x22)).toBeNull();
  });
});

/**
 * One icon is shown at several sizes at the same time — a fixed step in the dialog, the chosen one
 * over the map. If two of those pairs shared a key, the dialog would show a neighbour's picture.
 */
describe('picture cache key', () => {
  it('is injective over icon and step', () => {
    const seen = new Set<number>();
    for (let icon = 0; icon < 256; icon++) {
      for (let scale = 1; scale <= ICON_SCALE_MAX; scale++) {
        const key = cacheKey(icon, scale);
        expect(seen.has(key), `collision at icon ${icon}, step ${scale}`).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(256 * ICON_SCALE_MAX);
  });

  it('clamps a step nobody offers instead of inventing a key', () => {
    expect(iconUrl(0x22, 99)).toBeNull(); // no source registered — but no throw either
  });
});

/**
 * **The trap this module fell into, as a rule over the whole class.**
 *
 * These singletons are fed from an `$effect` in a component. Raising a module-level `$state` with
 * `+= 1` READS it as well as writing it — the feeding effect then depends on what it writes and
 * re-runs itself until Svelte's loop guard stops it. A plain assignment is safe; a read-modify-write
 * is not.
 *
 * A behaviour test cannot see this: the suite runs in `node`, where Svelte turns effects into
 * no-ops, so the loop only ever shows in a browser — as a console error, not as a broken screen.
 * Hence a source check.
 */
describe('module singletons fed from an effect', () => {
  const DIRS = ['src/lib/enhancements', 'src/lib/shell'];
  const files = DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.svelte.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(dir, f)),
  );

  it('sees the modules at all', () => {
    // Without this a wrong path would report "no violations" — a check that cannot fail is worse
    // than no check.
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('raises no reactive state by reading it first', () => {
    const bad: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Module-level reactive variables of this file — `let x = $state(...)` / `x = $state(...)`.
      const names = [...text.matchAll(/\b(?:let|const)\s+(\w+)\s*(?::[^=]+)?=\s*\$state[.(<]/g)].map(
        (m) => m[1]!,
      );
      for (const name of names) {
        const rmw = new RegExp(`\\b${name}\\s*(?:\\+\\+|--|[+\\-*/|&^]=)|(?:\\+\\+|--)\\s*\\b${name}\\b`);
        if (rmw.test(text)) bad.push(`${file}: ${name}`);
      }
    }
    expect(bad, `read-modify-write on reactive state: ${bad.join(', ')}`).toEqual([]);
  });
});
