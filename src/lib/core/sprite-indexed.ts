/**
 * **Palette-indexed** sprite decoding for the map renderer.
 *
 * The original is a palette-indexed VGA renderer: its frame buffer holds **one byte index per pixel**,
 * not a colour. That is not an implementation whim but decisive for fidelity — the original's shadows
 * **modify the target pixel** instead of blending something over it (`dst_index |= 0x80`, see
 * `index-target.ts`). Holding RGBA only cannot reproduce that: the reverse lookup RGB -> index is
 * ambiguous (233 colours over 256 indices; 8 colours — among them black, white and four greys of the
 * building masonry — have several indices with **different** shadows).
 *
 * - `decodeSprite` returns RGBA and serves the asset viewer, the animation view and the UI popups.
 * - `decodeSpriteIndexed` returns indices and serves the map renderer.
 *
 * Both walk the same RLE structure. That they do not drift apart is secured by the test
 * "`palette[indices[i]]` == `pixels[i]` for every opaque pixel" over real archive sprites — that is
 * why the small duplication is defensible.
 *
 * Note that the index decoder needs **no palette**. Colour appears at the very end, in one pass over
 * the finished surface.
 */

import { lookupSpaResource } from './spa-resources.js';
import { readSpriteHeader, resolveSpriteType, type AutoSpriteType } from './sprite-decoder.js';

/**
 * A decoded sprite in palette indices.
 *
 * `indices[i]` is valid only where `opaque[i]` is set — skipped RLE pixels stay 0 in both. There is no
 * alpha of its own: the original knows no partial coverage.
 */
export interface IndexedSprite {
  readonly width: number;
  readonly height: number;
  /** Pivot offset to the drawing anchor (`SpriteHeader.offset_x/y`). */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Attachment vector for parts stuck on top (a serf's head on the torso). */
  readonly deltaX: number;
  readonly deltaY: number;
  /** Palette index per pixel (valid only where `opaque` is set). */
  readonly indices: Uint8Array;
  /** 1 = the pixel is written, 0 = skipped. */
  readonly opaque: Uint8Array;
 /**
   * **Shadow shape mask** instead of an image. An `overlay` sprite carries no colour of its own; the
   * original ORs the target index with `0x80` instead (worker `@0x63d25`). The blitter evaluates this
   * flag — `indices` is meaningless then.
  */
  readonly shade: boolean;
}

export interface IndexedDecodeOptions {
  readonly type?: AutoSpriteType;
  /** For `transparent`: offset applied to every palette index (team ramp, see `player-color.ts`). */
  readonly colorOffset?: number;
  /** For `auto`: physical archive index, used to determine the type via the asset registry. */
  readonly physicalIndex?: number;
}

/** Index given to `mask` sprites — they carry no colour of their own, only a shape. */
export const MASK_INDEX = 0;

export function decodeSpriteIndexed(
  raw: Uint8Array,
  options: IndexedDecodeOptions = {},
): IndexedSprite {
  const header = readSpriteHeader(raw);
  const payload = raw.subarray(10);
  const total = header.width * header.height;
  const indices = new Uint8Array(total);
  const opaque = new Uint8Array(total);

  const type = resolveSpriteType(
    options.type ?? 'auto',
    payload.byteLength,
    total,
    options.physicalIndex,
  );

  let colorOffset = options.colorOffset;
  if (colorOffset === undefined && options.physicalIndex !== undefined) {
    colorOffset = lookupSpaResource(options.physicalIndex)?.colorOffset;
  }
  colorOffset ??= 0;

  switch (type) {
    case 'solid':
      for (let i = 0; i < total && i < payload.byteLength; i++) {
        indices[i] = payload[i]!;
        opaque[i] = 1;
      }
      break;
    case 'transparent':
      runLengths(payload, total, (pp, src, sp) => {
        indices[pp] = (src + colorOffset) & 0xff;
        opaque[pp] = 1;
        return sp;
      });
      break;
    case 'overlay':
      // Only the shape matters — the effect lives in the blitter (`dst |= 0x80`).
      runLengthsNoData(payload, total, (pp) => {
        opaque[pp] = 1;
      });
      break;
    case 'mask':
      runLengthsNoData(payload, total, (pp) => {
        indices[pp] = MASK_INDEX;
        opaque[pp] = 1;
      });
      break;
  }

  return {
    width: header.width,
    height: header.height,
    offsetX: header.offsetX,
    offsetY: header.offsetY,
    deltaX: header.deltaX,
    deltaY: header.deltaY,
    indices,
    opaque,
    shade: type === 'overlay',
  };
}

/** RLE run `(drop, fill, [byte]*fill)` — with a per-pixel byte. */
function runLengths(
  src: Uint8Array,
  total: number,
  write: (pp: number, value: number, sp: number) => number,
): void {
  const len = src.byteLength;
  let sp = 0;
  let pp = 0;
  while (sp < len && pp < total) {
    pp += Math.min(src[sp++]!, Math.max(0, total - pp));
    if (sp >= len) break;
    const fill = src[sp++]!;
    for (let i = 0; i < fill; i++) {
      if (sp >= len || pp >= total) break;
      write(pp, src[sp++]!, sp);
      pp++;
    }
  }
}

/** RLE run `(drop, fill)` without per-pixel bytes (`overlay`/`mask`). */
function runLengthsNoData(src: Uint8Array, total: number, write: (pp: number) => void): void {
  const len = src.byteLength;
  let sp = 0;
  let pp = 0;
  while (sp < len && pp < total) {
    pp += Math.min(src[sp++]!, Math.max(0, total - pp));
    if (sp >= len) break;
    const fill = src[sp++]!;
    for (let i = 0; i < fill; i++) {
      if (pp >= total) break;
      write(pp);
      pp++;
    }
  }
}
