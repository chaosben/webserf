/**
 * Asset registry for `SPA*.PA` pack archives (SPAD German, SPAE English, SPAF French, ...).
 *
 * A range table that maps every physical sprite index onto its logical asset type (sprite encoding,
 * recommended palette, symbolic name). The binary asset data holds NO type information — it has to
 * come from this table, otherwise encoding and palette are not determinable.
 *
 * Every entry starts at `spaIndex` and applies up to the next entry (sorted by `spaIndex`).
 * `spaIndex` follows the archive-internal 1-based indexing.
 */

import type { SpriteType } from './sprite-decoder.js';

export interface SpaResourceEntry {
  /** Slot 0..34 = logical asset type in enum order; 35 is an addition beyond it (see below). */
  readonly slot: number;
  /** Physical start index in the archive (1-based; for our 0-based parser: `spaIndex - 1`). */
  readonly spaIndex: number;
  /** Recommended palette as a 0-based archive entry, or `null` when no palette applies. */
  readonly paletteIndex: number | null;
  /** Sprite encoding. `unknown` = not a sprite (animation, sound, music) or a reserved slot. */
  readonly spriteType: SpriteType | 'unknown';
  /** Symbolic name (slot 0..33) resp. `'special_unused'` for slot 34. */
  readonly name: string;
  /**
   * Optional palette offset added to every palette index of a transparent-encoded sprite. Currently
   * set only for `SerfTorso` (value 64).
   */
  readonly colorOffset?: number;
}

/**
 * Range markers in original order (slots 0..34 correspond to the logical asset enum order).
 *
 * Slot 35 (`SerfArms`) is an **addition beyond the enum order**: the range 1849..2498 (0-based) holds
 * the separate serf arm sprites the map renderer sticks onto the torso (`serf-sprites.ts`,
 * `SERF_ARMS_BASE`). Without this marker the range would fall under `FrameBottom` (solid) and be
 * mis-decoded. Verified against a real archive: all 462 occupied entries of the range consume their
 * payload **exactly** as transparent RLE (covering exactly `w*h` pixels) and **none** as solid;
 * conversely 1779..1848 are solid throughout. Additional structural evidence: the occupancy and gap
 * pattern of 1849..2498 is identical to that of the torso bank 2499..3148 (offset exactly 650 — the
 * distance with which the renderer addresses an arm relative to its torso).
 */
export const SPA_RESOURCES: readonly SpaResourceEntry[] = [
  { slot: 0,  spaIndex: 0,    paletteIndex: null, spriteType: 'unknown',     name: 'None' },
  { slot: 1,  spaIndex: 1,    paletteIndex: 3996, spriteType: 'solid',       name: 'ArtLandscape' },
  { slot: 2,  spaIndex: 2,    paletteIndex: null, spriteType: 'unknown',     name: 'Animation' },
  { slot: 3,  spaIndex: 4,    paletteIndex: 2,    spriteType: 'overlay',     name: 'SerfShadow' },
  { slot: 4,  spaIndex: 5,    paletteIndex: 2,    spriteType: 'solid',       name: 'DottedLines' },
  { slot: 5,  spaIndex: 15,   paletteIndex: 3996, spriteType: 'solid',       name: 'ArtFlag' },
  { slot: 6,  spaIndex: 25,   paletteIndex: 2,    spriteType: 'solid',       name: 'ArtBox' },
  { slot: 7,  spaIndex: 40,   paletteIndex: 3997, spriteType: 'solid',       name: 'CreditsBg' },
  { slot: 8,  spaIndex: 41,   paletteIndex: 3997, spriteType: 'solid',       name: 'Logo' },
  { slot: 9,  spaIndex: 42,   paletteIndex: 2,    spriteType: 'solid',       name: 'Symbol' },
  { slot: 10, spaIndex: 60,   paletteIndex: 2,    spriteType: 'mask',        name: 'MapMaskUp' },
  { slot: 11, spaIndex: 141,  paletteIndex: 2,    spriteType: 'mask',        name: 'MapMaskDown' },
  { slot: 12, spaIndex: 230,  paletteIndex: 2,    spriteType: 'mask',        name: 'PathMask' },
  { slot: 13, spaIndex: 260,  paletteIndex: 2,    spriteType: 'solid',       name: 'MapGround' },
  { slot: 14, spaIndex: 300,  paletteIndex: 2,    spriteType: 'solid',       name: 'PathGround' },
  { slot: 15, spaIndex: 321,  paletteIndex: 2,    spriteType: 'transparent', name: 'GameObject' },
  { slot: 16, spaIndex: 600,  paletteIndex: 2,    spriteType: 'solid',       name: 'FrameTop' },
  { slot: 17, spaIndex: 610,  paletteIndex: 2,    spriteType: 'transparent', name: 'MapBorder' },
  { slot: 18, spaIndex: 630,  paletteIndex: 2,    spriteType: 'transparent', name: 'MapWaves' },
  { slot: 19, spaIndex: 660,  paletteIndex: 2,    spriteType: 'solid',       name: 'FramePopup' },
  { slot: 20, spaIndex: 670,  paletteIndex: 2,    spriteType: 'solid',       name: 'Indicator' },
  { slot: 21, spaIndex: 750,  paletteIndex: 2,    spriteType: 'transparent', name: 'Font' },
  { slot: 22, spaIndex: 810,  paletteIndex: 2,    spriteType: 'transparent', name: 'FontShadow' },
  { slot: 23, spaIndex: 870,  paletteIndex: 2,    spriteType: 'solid',       name: 'Icon' },
  { slot: 24, spaIndex: 1250, paletteIndex: 2,    spriteType: 'transparent', name: 'MapObject' },
  { slot: 25, spaIndex: 1500, paletteIndex: 2,    spriteType: 'overlay',     name: 'MapShadow' },
  { slot: 26, spaIndex: 1750, paletteIndex: 2,    spriteType: 'solid',       name: 'PanelButton' },
  { slot: 27, spaIndex: 1780, paletteIndex: 2,    spriteType: 'solid',       name: 'FrameBottom' },
  { slot: 28, spaIndex: 2500, paletteIndex: 2,    spriteType: 'transparent', name: 'SerfTorso', colorOffset: 64 },
  { slot: 29, spaIndex: 3150, paletteIndex: 2,    spriteType: 'transparent', name: 'SerfHead' },
  { slot: 30, spaIndex: 3880, paletteIndex: 2,    spriteType: 'solid',       name: 'FrameSplit' },
  { slot: 31, spaIndex: 3900, paletteIndex: null, spriteType: 'unknown',     name: 'Sound' },
  { slot: 32, spaIndex: 3990, paletteIndex: null, spriteType: 'unknown',     name: 'Music' },
  { slot: 33, spaIndex: 3999, paletteIndex: 2,    spriteType: 'transparent', name: 'Cursor' },
  { slot: 34, spaIndex: 3,    paletteIndex: null, spriteType: 'unknown',     name: 'special_unused' },
  { slot: 35, spaIndex: 1850, paletteIndex: 2,    spriteType: 'transparent', name: 'SerfArms' },
];

/** Copy sorted by ascending `spaIndex` — the basis for the binary search in the lookup. */
const SORTED: readonly SpaResourceEntry[] = [...SPA_RESOURCES].sort((a, b) => a.spaIndex - b.spaIndex);

/**
 * Finds the resource entry for a sprite index in our (0-based) archive.
 *
 * **Off by one**: in the archive format `spaIndex` is 1-based (entry 0 is discarded as a self
 * reference), our parser returns entries 0..N-1. Mapping: `spaIndex = ourEntryIndex + 1`.
 *
 * Verified:
 *   - our entry 0 (640x200 solid full screen) -> spaIndex 1 = "ArtLandscape"
 *   - our entry 4 (5x2 solid)                 -> spaIndex 5 = "DottedLines"
 *   - our entry 3 (10x6 RLE overlay)          -> spaIndex 4 = "SerfShadow"
 *
 * Returns the entry with the largest `spaIndex <= ourEntryIndex + 1`. Its `spriteType` and
 * `paletteIndex` apply up to the next `spaIndex` (exclusive).
 */
export function lookupSpaResource(ourEntryIndex: number): SpaResourceEntry | null {
  if (ourEntryIndex < 0 || !Number.isFinite(ourEntryIndex)) return null;

  const target = ourEntryIndex + 1;

  let lo = 0;
  let hi = SORTED.length - 1;
  let best: SpaResourceEntry | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = SORTED[mid]!;
    if (e.spaIndex <= target) {
      best = e;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

