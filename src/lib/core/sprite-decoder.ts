import type { DecodedSprite, Palette } from './types.js';
import { lookupSpaResource } from './spa-resources.js';

/**
 * Sprite encoding types for the pixel payloads. The type is NOT stored in the data — the mapping
 * comes from the asset registry (see `spa-resources.ts`).
 */
export type SpriteType = 'solid' | 'transparent' | 'overlay' | 'mask';

export type AutoSpriteType = SpriteType | 'auto';

export interface SpriteHeader {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface DecodeOptions {
  /** Explicit type; `auto` (default) asks the asset registry. */
  readonly type?: AutoSpriteType;
  /**
   * For `transparent`: palette offset added to every index. Default 0; for `SerfTorso` sprites
   * typically 64 (taken from the registry automatically).
   */
  readonly colorOffset?: number;
  /**
   * For `overlay`: the constant that determines ALL fill pixels — colour = `palette[overlayValue]`
   * AND alpha = `overlayValue`. Default `0x80` (palette index 128 = black, alpha 128 = 50 %
   * half shadow) — the original shadow recipe. Overlay payloads consist of pure
   * `(drop, fill)` pairs without per-pixel bytes.
   */
  readonly overlayValue?: number;
  /**
   * For `auto`: the physical sprite index used to look the type up in the asset registry. Without
   * it `auto` falls back to a heuristic (solid when `size-10 == w*h`, otherwise transparent).
   */
  readonly physicalIndex?: number;
}

/** Reads the 10-byte header of a sprite entry. */
export function readSpriteHeader(raw: Uint8Array): SpriteHeader {
  if (raw.byteLength < 10) {
    throw new Error(`readSpriteHeader: entry too small (${raw.byteLength} bytes).`);
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    deltaX: dv.getInt8(0),
    deltaY: dv.getInt8(1),
    width: dv.getUint16(2, true),
    height: dv.getUint16(4, true),
    offsetX: dv.getInt16(6, true),
    offsetY: dv.getInt16(8, true),
  };
}

/** Plausibility check without fixed upper bounds — catches obviously broken headers. */
export function isPlausibleSpriteHeader(h: SpriteHeader): boolean {
  return (
    h.width > 0 && h.width <= 2048 &&
    h.height > 0 && h.height <= 2048 &&
    h.width * h.height <= 4_000_000
  );
}

/** Determines the effective sprite type for `decodeSprite`. */
export function resolveSpriteType(
  type: AutoSpriteType,
  payloadLen: number,
  totalPixels: number,
  physicalIndex?: number,
): SpriteType {
  if (type !== 'auto') return type;
  if (physicalIndex !== undefined) {
    const res = lookupSpaResource(physicalIndex);
    if (res && res.spriteType !== 'unknown') return res.spriteType;
  }
  // Fallback heuristic without the table: solid on an exact payload match, otherwise transparent.
  return payloadLen === totalPixels ? 'solid' : 'transparent';
}

/**
 * Decodes a sprite entry into RGBA pixels.
 *
 * - `solid`: width * height palette index bytes (alpha 255 — index 0 renders as black).
 * - `transparent`: RLE `(drop u8, fill u8, [palIdx u8] × fill)`; `drop` pixels = fully transparent.
 *   An optional `colorOffset` is added to every index (for serf torsos).
 * - `overlay`: RLE `(drop u8, fill u8)` without per-pixel bytes; all fill pixels use
 *   `palette[overlayValue]` as colour and `overlayValue` as alpha (default `0x80`).
 * - `mask`: RLE `(drop u8, fill u8)` without per-pixel bytes; fill pixels are opaque white.
 */
export function decodeSprite(
  raw: Uint8Array,
  palette: Palette,
  options: DecodeOptions = {},
): DecodedSprite {
  const header = readSpriteHeader(raw);
  if (!isPlausibleSpriteHeader(header)) {
    throw new Error(
      `decodeSprite: implausible header w=${header.width} h=${header.height}.`,
    );
  }

  const payload = raw.subarray(10);
  const totalPixels = header.width * header.height;
  const pixels = new Uint8ClampedArray(totalPixels * 4);

  const type = resolveSpriteType(
    options.type ?? 'auto',
    payload.byteLength,
    totalPixels,
    options.physicalIndex,
  );

  // Take `colorOffset` from the asset registry unless the caller set one. Only SerfTorso (slot 28)
  // has a non-zero default.
  let colorOffset = options.colorOffset;
  if (colorOffset === undefined && options.physicalIndex !== undefined) {
    const res = lookupSpaResource(options.physicalIndex);
    colorOffset = res?.colorOffset;
  }
  colorOffset ??= 0;

  switch (type) {
    case 'solid':
      decodeSolid(pixels, payload, palette, totalPixels);
      break;
    case 'transparent':
      decodeTransparentRLE(pixels, payload, palette, totalPixels, colorOffset);
      break;
    case 'overlay':
      decodeOverlayRLE(pixels, payload, palette, totalPixels, options.overlayValue ?? 0x80);
      break;
    case 'mask':
      decodeMaskRLE(pixels, payload, totalPixels);
      break;
  }

  return {
    width: header.width,
    height: header.height,
    offsetX: header.offsetX,
    offsetY: header.offsetY,
    deltaX: header.deltaX,
    deltaY: header.deltaY,
    pixels,
  };
}

function decodeSolid(
  pixels: Uint8ClampedArray,
  payload: Uint8Array,
  palette: Palette,
  totalPixels: number,
) {
  if (payload.byteLength < totalPixels) {
    throw new Error(
      `decodeSprite(solid): payload too small (${payload.byteLength}, expected ${totalPixels}).`,
    );
  }
  const pal = palette.rgba;
  let dst = 0;
  for (let i = 0; i < totalPixels; i++) {
    const idx = payload[i]! * 4;
    pixels[dst++] = pal[idx]!;
    pixels[dst++] = pal[idx + 1]!;
    pixels[dst++] = pal[idx + 2]!;
    pixels[dst++] = 0xff;
  }
}

function decodeTransparentRLE(
  pixels: Uint8ClampedArray,
  payload: Uint8Array,
  palette: Palette,
  totalPixels: number,
  colorOffset: number,
) {
  const pal = palette.rgba;
  const src = payload;
  const srcLen = src.byteLength;

  let sp = 0;
  let pp = 0;
  while (sp < srcLen && pp < totalPixels) {
    const drop = src[sp++]!;
    pp += skip(drop, pp, totalPixels);
    if (sp >= srcLen) break;

    const fill = src[sp++]!;
    for (let i = 0; i < fill; i++) {
      if (sp >= srcLen || pp >= totalPixels) break;
      const palIdx = ((src[sp++]! + colorOffset) & 0xff) * 4;
      const o = pp * 4;
      pixels[o] = pal[palIdx]!;
      pixels[o + 1] = pal[palIdx + 1]!;
      pixels[o + 2] = pal[palIdx + 2]!;
      pixels[o + 3] = 0xff;
      pp++;
    }
  }
}

function decodeOverlayRLE(
  pixels: Uint8ClampedArray,
  payload: Uint8Array,
  palette: Palette,
  totalPixels: number,
  overlayValue: number,
) {
  const pal = palette.rgba;
  const value = overlayValue & 0xff;
  const baseIdx = value * 4;
  const baseR = pal[baseIdx]!;
  const baseG = pal[baseIdx + 1]!;
  const baseB = pal[baseIdx + 2]!;

  const src = payload;
  const srcLen = src.byteLength;

  // Pure (drop, fill) pairs — NO per-pixel bytes. All fill pixels get the same colour
  // palette[value] and alpha = value (the original shadow recipe, value 0x80).
  let sp = 0;
  let pp = 0;
  while (sp < srcLen && pp < totalPixels) {
    const drop = src[sp++]!;
    pp += skip(drop, pp, totalPixels);
    if (sp >= srcLen) break;

    const fill = src[sp++]!;
    for (let i = 0; i < fill; i++) {
      if (pp >= totalPixels) break;
      const o = pp * 4;
      pixels[o] = baseR;
      pixels[o + 1] = baseG;
      pixels[o + 2] = baseB;
      pixels[o + 3] = value;
      pp++;
    }
  }
}

function decodeMaskRLE(
  pixels: Uint8ClampedArray,
  payload: Uint8Array,
  totalPixels: number,
) {
  const src = payload;
  const srcLen = src.byteLength;

  let sp = 0;
  let pp = 0;
  while (sp < srcLen && pp < totalPixels) {
    const drop = src[sp++]!;
    pp += skip(drop, pp, totalPixels);
    if (sp >= srcLen) break;

    const fill = src[sp++]!;
    for (let i = 0; i < fill; i++) {
      if (pp >= totalPixels) break;
      const o = pp * 4;
      pixels[o] = 0xff;
      pixels[o + 1] = 0xff;
      pixels[o + 2] = 0xff;
      pixels[o + 3] = 0xff;
      pp++;
    }
  }
}

/** Shared helper for skipping transparent pixels. */
function skip(count: number, currentPP: number, totalPixels: number): number {
  // The pixel bytes start out 0 (fully transparent), so only the counter advances — no write.
  const remaining = totalPixels - currentPP;
  return Math.min(count, Math.max(0, remaining));
}
