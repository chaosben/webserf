import type { Palette } from './types.js';

/**
 * Parses a `.PAL` file.
 *
 * 772 bytes:
 * - 4 byte header (a version tag; observed `00 00 00 01`).
 * - 256 x 3 bytes (R, G, B), each value 0..63 (VGA 6 bit).
 *
 * Conversion 6 bit -> 8 bit: `(v << 2) | (v >> 4)` — an even spread over 0..255 without a visible
 * banding artefact.
 *
 * Every entry gets alpha 255. Transparency is handled in the sprite decoder (index 0 is usually the
 * transparent pixel, but it is NOT marked as such in the palette itself).
 */
export function parsePalette(buffer: ArrayBuffer | ArrayBufferView): Palette {
  const bytes = toUint8Array(buffer);

  if (bytes.byteLength < 4 + 256 * 3) {
    throw new Error(
      `parsePalette: file too small (${bytes.byteLength} bytes, expected >= ${4 + 256 * 3}).`,
    );
  }

  const rgba = new Uint8Array(256 * 4);
  let src = 4; // skip the header
  let dst = 0;
  for (let i = 0; i < 256; i++) {
    const r6 = bytes[src++]!;
    const g6 = bytes[src++]!;
    const b6 = bytes[src++]!;

    // A file that already held 0..255 would be corrupted by the scaling, so reject anything above the
    // documented VGA range instead of guessing.
    if (r6 > 63 || g6 > 63 || b6 > 63) {
      throw new Error(
        `parsePalette: entry ${i} has a channel value > 63 (R=${r6} G=${g6} B=${b6}). ` +
          `The file is probably not a VGA 6-bit palette.`,
      );
    }

    rgba[dst++] = (r6 << 2) | (r6 >> 4);
    rgba[dst++] = (g6 << 2) | (g6 >> 4);
    rgba[dst++] = (b6 << 2) | (b6 >> 4);
    rgba[dst++] = 0xff;
  }

  return { rgba };
}

/**
 * Parses a palette embedded in the asset archive (typically TOC[2], TOC[3996], TOC[3997]).
 *
 * **256 x 3 bytes RGB** in the 8-bit range, WITHOUT the 4-byte header — bytes like `0xFF`, `0xF3`
 * prove it is not the VGA 6-bit format with `<<2` scaling.
 *
 * Exactly 768 bytes long; throws otherwise.
 */
export function parseInArchivePalette(buffer: ArrayBuffer | ArrayBufferView): Palette {
  const bytes = toUint8Array(buffer);

  if (bytes.byteLength !== 768) {
    throw new Error(
      `parseInArchivePalette: expected exactly 768 bytes (256x3 RGB), got ${bytes.byteLength}.`,
    );
  }

  const rgba = new Uint8Array(256 * 4);
  let src = 0;
  let dst = 0;
  for (let i = 0; i < 256; i++) {
    rgba[dst++] = bytes[src++]!;
    rgba[dst++] = bytes[src++]!;
    rgba[dst++] = bytes[src++]!;
    rgba[dst++] = 0xff;
  }

  // **Index 0 is always black on screen** — not a VGA convention but written in the binary: the
  // palette upload loop @0x2570 pushes all 256 entries into the DAC (`cmp $0x100` @0x25a8) and then
  // **unconditionally** sets entry 0 to (0,0,0) — four `xor` @0x25af..@0x25b5, then `call 0x646c9`
  // (the single-entry DAC setter, `out` on 0x3c8/0x3c9). Whatever the data holds at slot 0 never
  // reaches the screen.
  //
  // Without this line every area the original fills with colour 0 comes out in the raw entry's green
  // (`#008b47`) instead of black — visible first in the input fields of the main menu (`gs+0x1ca`
  // bit 4, see `core/main-menu.ts`).
  rgba[0] = 0;
  rgba[1] = 0;
  rgba[2] = 0;
  return { rgba };
}

/**
 * **The darkened version of a palette** — entry `i` gets the colour of `i | 0x80`.
 *
 * The original knows no half transparency and no blending: it ORs the **palette index** of the target
 * pixel (`orl $0x80808080` for the dimmed main menu @0x4f221, `*(byte *)dst |= 0x80` for the map
 * object shadow @0x63d25). The upper half of the palette **is** the darkened lower one: over
 * `i = 0..127`, `palette[i | 0x80]` is darker in 98 cases, and for terrain and object colours the
 * factor is around 0.49.
 *
 * Working on an **index** surface makes this function unnecessary (there it is a `|=`, see
 * `core/index-target.ts`). It exists for RGBA surfaces, where the index of a finished pixel is lost:
 * there one does not darken the result but draws with this palette from the start. For indices
 * >= 0x80 it is the identity — exactly like the `|`.
 */
export function darkenPalette(pal: Palette): Palette {
  const rgba = new Uint8Array(pal.rgba.length);
  for (let i = 0; i < 256; i++) {
    const src = (i | 0x80) * 4;
    const dst = i * 4;
    rgba[dst] = pal.rgba[src] ?? 0;
    rgba[dst + 1] = pal.rgba[src + 1] ?? 0;
    rgba[dst + 2] = pal.rgba[src + 2] ?? 0;
    rgba[dst + 3] = pal.rgba[src + 3] ?? 0xff;
  }
  return { rgba };
}

function toUint8Array(buf: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(buf);
}
