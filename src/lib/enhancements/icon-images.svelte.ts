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

/** A rendered icon: the picture plus the size it came out at, both in whole pixels. */
export interface IconImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Deliberately a plain `Map` and NOT a reactive one: it is filled lazily, from inside the render
 * pass, the first time a picture is asked for. A reactive map would turn that into a state change
 * while rendering. The reactivity lives in {@link source}, which changes only when the archive does.
 *
 * Keyed by icon AND step, because the same icon is shown at several sizes at once (the dialog at a
 * fixed step, the readout at its own). {@link cacheKey} has to be injective over that pair — a
 * collision would put a neighbour's picture on an entry.
 */
const images = new Map<number, IconImage | null>();

/** The highest step any caller may ask for; the key arithmetic below rests on it. */
export const ICON_SCALE_MAX = 4;

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
  images.clear();
  source = { archive, palette };
  return () => {
    images.clear();
    source = null;
  };
}

/**
 * A bank-relative UI icon, rendered at a WHOLE step — `null` without a source, without a 2D
 * context, or for an empty archive slot. Callers fall back to the plain name then; an icon is never
 * the only carrier of meaning.
 *
 * The step is whole because that is the only factor `spriteCanvas` can blit without resampling. A
 * caller that wants a fractional size takes step 1 and gives the `<img>` an explicit pixel size
 * from {@link IconImage.width} — nearest-neighbour upscaling by the browser, which is what the
 * control bar does on the canvas too, and the reason the size is returned at all: the icons differ
 * in size, so nobody could compute it from the outside.
 */
export function iconImage(bankIcon: number, step = 1): IconImage | null {
  const src = source;
  if (src === null || typeof document === 'undefined') return null;
  const s = Math.max(1, Math.min(ICON_SCALE_MAX, Math.floor(step)));
  const key = cacheKey(bankIcon, s);
  const hit = images.get(key);
  if (hit !== undefined) return hit;
  let image: IconImage | null = null;
  try {
    const entry = UI_ICON_BASE + bankIcon;
    const raw = src.archive.getRaw(entry);
    if (raw !== null) {
      const sprite = decodeSprite(raw, src.palette, { physicalIndex: entry });
      const canvas = spriteCanvas(sprite, s);
      if (canvas !== null) {
        image = {
          url: canvas.toDataURL('image/png'),
          width: canvas.width,
          height: canvas.height,
        };
      }
    }
  } catch {
    // Empty or unreadable slot — the caller shows the name instead.
  }
  images.set(key, image);
  return image;
}

/** Just the picture, for callers that let the layout size it. */
export function iconUrl(bankIcon: number, scale = 1): string | null {
  return iconImage(bankIcon, scale)?.url ?? null;
}
