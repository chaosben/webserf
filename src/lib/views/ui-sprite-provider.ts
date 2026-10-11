/**
 * The decoding sprite source the original's panel and popup renderers draw from.
 *
 * Callers keep the returned function for as long as archive and palette stay the same: it holds the
 * decode cache, and the renderers ask for the same entries dozens of times per picture.
 */
import { decodeSprite } from '../core/sprite-decoder.js';
import type { PaArchive } from '../core/pa-parser.js';
import type { DecodedSprite, Palette } from '../core/types.js';
import type { SpriteProvider } from '../core/ui-render.js';

export function makeUiSpriteProvider(archive: PaArchive, palette: Palette): SpriteProvider {
  const cache = new Map<number, DecodedSprite | null>();
  return (entry: number): DecodedSprite | null => {
    const hit = cache.get(entry);
    if (hit !== undefined) return hit;
    let spr: DecodedSprite | null = null;
    try {
      const raw = archive.getRaw(entry);
      if (raw !== null) spr = decodeSprite(raw, palette, { physicalIndex: entry });
    } catch {
      // Empty or unreadable slot — the renderer skips it.
    }
    cache.set(entry, spr);
    return spr;
  };
}
