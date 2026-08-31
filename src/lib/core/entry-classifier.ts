import type { PackEntry } from './types.js';
import { lookupSpaResource } from './spa-resources.js';

/**
 * Content class of a pack entry. Derived from size and index — the data itself carries no type
 * information.
 */
export type EntryKind = 'sprite' | 'palette' | 'animation' | 'sound' | 'music' | 'empty' | 'unknown';

/**
 * Classifies a pack entry.
 *
 * Order of the checks:
 * 1. `offset === 0` → `empty` (undefined slot).
 * 2. `size === 768` → `palette` (in-archive Palette, 256×3 raw RGB).
 *    In the original archive those are the indices 2, 3996, 3997.
 * 3. Look-up in the asset registry by asset name:
 *    - `Animation` → `animation`
 *    - `Sound` → `sound`
 *    - `Music` → `music`
 *    - If `spriteType !== 'unknown'` → `sprite`
 * 4. Otherwise → `unknown`.
 */
export function classifyEntry(entry: PackEntry): EntryKind {
  if (entry.offset === 0) return 'empty';
  if (entry.size === 768) return 'palette';

  const res = lookupSpaResource(entry.index);
  if (res) {
    switch (res.name) {
      case 'Animation': return 'animation';
      case 'Sound':     return 'sound';
      case 'Music':     return 'music';
      default:
        if (res.spriteType !== 'unknown') return 'sprite';
    }
  }
  return 'unknown';
}

/** Short human-readable tag for the UI. */
export function entryKindLabel(kind: EntryKind): string {
  switch (kind) {
    case 'sprite':    return 'Sprite';
    case 'palette':   return 'Palette';
    case 'animation': return 'Animation';
    case 'sound':     return 'Sound';
    case 'music':     return 'Music';
    case 'empty':     return 'empty';
    case 'unknown':   return 'unknown';
  }
}
