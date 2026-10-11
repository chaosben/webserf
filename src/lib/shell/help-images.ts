/**
 * The dialog shots of the help as image URLs. Rendering is DOM-free (`help-shots.ts`); this is only
 * the last step, framebuffer → canvas → PNG, plus a cache.
 *
 * The cache key includes the game language: the dialogs carry the original's text, and that follows
 * the archive. One archive per page, so the archive object itself scopes the cache.
 */
import type { PaArchive } from '../core/pa-parser.js';
import type { Palette } from '../core/types.js';
import { gameLanguage } from '../core/language.js';
import type { Framebuffer } from '../core/ui-render.js';
import { makeUiSpriteProvider } from '../views/ui-sprite-provider.js';
import { helpScene } from './help-scene.js';
import { helpShot } from './help-shots.js';

const caches = new WeakMap<PaArchive, Map<string, string | null>>();
const providers = new WeakMap<PaArchive, ReturnType<typeof makeUiSpriteProvider>>();

function toUrl(fb: Framebuffer): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = fb.width;
  canvas.height = fb.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(fb.rgba), fb.width, fb.height), 0, 0);
  return canvas.toDataURL('image/png');
}

/** PNG data URL of one shot, `null` when the dialog cannot be drawn from the sample game. */
export function helpShotUrl(id: string, archive: PaArchive, palette: Palette): string | null {
  let cache = caches.get(archive);
  if (cache === undefined) {
    cache = new Map();
    caches.set(archive, cache);
  }
  const key = `${gameLanguage()}:${id}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let draw = providers.get(archive);
  if (draw === undefined) {
    draw = makeUiSpriteProvider(archive, palette);
    providers.set(archive, draw);
  }
  const shot = helpShot(id);
  let url: string | null = null;
  try {
    const fb = shot?.render({ scene: helpScene(), draw, palette }) ?? null;
    url = fb === null ? null : toUrl(fb);
  } catch {
    // A broken shot costs its picture, not the help.
  }
  cache.set(key, url);
  return url;
}
