/**
 * Original UI icons as pictures the DOM can show.
 *
 * Two users that never meet: the overlay over the game surface, and the pickers inside the
 * enhancements dialog. Neither has the archive to hand — the overlay lives in the game view, the
 * pickers in the shell — so the source is registered ONCE, from the page that owns archive and
 * palette anyway. That also means the dialog has its icons in the main menu, where no game view
 * exists.
 *
 * Decoding and drawing happen on first use and are then kept: an icon is a handful of pixels, but
 * a picker lists more than fifty of them and is re-rendered on every click.
 */
import { STOCK_SCALE_MAX } from './stock-overview.js';
import { decodeSprite } from '../core/sprite-decoder.js';
import { UI_ICON_BASE } from '../core/ui-render.js';
import { spriteCanvas } from '../views/sprite-image.js';
import type { PaArchive } from '../core/pa-parser.js';
import type { Palette } from '../core/types.js';

interface Source {
  readonly archive: PaArchive;
  readonly palette: Palette;
}

/**
 * The reactive part, and it has to be the SOURCE itself rather than a counter beside it: a counter
 * is raised with `+= 1`, which READS the state as well as writing it — the registering effect would
 * then depend on what it writes and re-run itself for ever. Assigning `source` is a pure write and
 * creates no such dependency.
 */
let source = $state<Source | null>(null);

/**
 * Deliberately a plain `Map` and NOT a reactive one: it is filled lazily, from inside the render
 * pass, the first time a picture is asked for. A reactive map would turn that into a state change
 * while rendering. The reactivity lives in {@link source}, which changes only when the archive does.
 *
 * Keyed by icon AND step, because the same icon is shown at several sizes at once (the dialog at a
 * fixed step, the readout at whatever the user chose). {@link cacheKey} has to be injective over
 * that pair — a collision would put a neighbour's picture on an entry.
 */
const urls = new Map<number, string | null>();

/** The highest step any caller may ask for; the key arithmetic below rests on it. */
export const ICON_SCALE_MAX = STOCK_SCALE_MAX;

export const cacheKey = (bankIcon: number, scale: number): number =>
  bankIcon * (ICON_SCALE_MAX + 1) + scale;

/**
 * Step of the pickers in the dialog. Fixed rather than settable: there the picture has to be big
 * enough to be recognised while clicking, and that has nothing to do with how the readout over the
 * map is sized.
 */
export const PICKER_ICON_SCALE = 2;

/** Register the source; the returned function unregisters it and fits an `$effect` return. */
export function provideIconSource(archive: PaArchive, palette: Palette): () => void {
  urls.clear();
  source = { archive, palette };
  return () => {
    urls.clear();
    source = null;
  };
}

/**
 * Data URL of a bank-relative UI icon — `null` without a source, without a 2D context, or for an
 * empty archive slot. Callers fall back to the plain name then; an icon is never the only carrier
 * of meaning.
 *
 * The picture is rendered AT the wanted step rather than stretched by CSS afterwards: the icons are
 * about sixteen pixels across, so a `width` in `rem` shrinks them below their own resolution.
 */
export function iconUrl(bankIcon: number, scale = 1): string | null {
  const src = source;
  if (src === null || typeof document === 'undefined') return null;
  const step = Math.max(1, Math.min(ICON_SCALE_MAX, Math.floor(scale)));
  const key = cacheKey(bankIcon, step);
  const hit = urls.get(key);
  if (hit !== undefined) return hit;
  let url: string | null = null;
  try {
    const entry = UI_ICON_BASE + bankIcon;
    const raw = src.archive.getRaw(entry);
    if (raw !== null) {
      const sprite = decodeSprite(raw, src.palette, { physicalIndex: entry });
      url = spriteCanvas(sprite, step)?.toDataURL('image/png') ?? null;
    }
  } catch {
    // Empty or unreadable slot — the caller shows the name instead.
  }
  urls.set(key, url);
  return url;
}
