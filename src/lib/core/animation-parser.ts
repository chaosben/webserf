/**
 * Parser for the in-archive animation table (`Animation` asset = entry index 1).
 *
 * Format (Big-Endian!), empirisch verifiziert:
 *
 *   u32 BE  size                  // == own data size (sanity check)
 *   u32 BE  offsets[N]            // offsets of the N animations, relative to the start AFTER `size`
 *   AnimationFrame[ ]             // pro Frame 3 Bytes: u8 sprite, i8 x, i8 y
 *
 *   Frame-Anzahl einer Animation = (next_offset - own_offset) / 3
 *   For the last animation: difference to the end of the buffer.
 *
 * **Self-describing**: the count `N` need not be hard-coded — it follows from the first offset,
 * which points at the end of the offset table (= start of the frame data): `N = offsets[0] / 4`.
 * The original has N = 200, but variants may differ.
 *
 * **Big-endian**: every other field in the archive is little-endian — only this table is BE.
 */

import type { PaArchive } from './pa-parser.js';

/** Eine einzelne Phase einer Animation. */
export interface AnimationFrame {
  /** Sprite index (u8), relative into a serf sprite range (mapped by the renderer). */
  readonly sprite: number;
  /** Horizontale Pivot-Verschiebung (signed). */
  readonly x: number;
  /** Vertikale Pivot-Verschiebung (signed). */
  readonly y: number;
}

/** The complete animation table; the count is `animations.length`. */
export interface AnimationTable {
  readonly animations: readonly (readonly AnimationFrame[])[];
}

/** Expected TOC index of the animation table (entry 1, DOS index 2). */
export const ANIMATION_ARCHIVE_INDEX = 1;

/**
 * Parses the animation table from a raw TOC entry. The number of animations is derived from the
 * first offset — no hard-coded 200. Throws when the size header, the first offset or the offset
 * consistency does not hold.
 */
export function parseAnimationTable(raw: Uint8Array): AnimationTable {
  if (raw.byteLength < 8) {
    throw new Error(
      `parseAnimationTable: file too small for the header (${raw.byteLength} bytes, at least 8 expected).`,
    );
  }

  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  // 1. Size header (BE) — must equal the total size.
  const declaredSize = dv.getUint32(0, false);
  if (declaredSize !== raw.byteLength) {
    throw new Error(
      `parseAnimationTable: size header ${declaredSize} does not match the file length ${raw.byteLength}.`,
    );
  }

  // 2. Derive the number of animations from the first offset — the offset table ends where the
  //    frame data begins.
  const firstOffset = dv.getUint32(4, false);
  if (firstOffset < 4 || firstOffset % 4 !== 0) {
    throw new Error(
      `parseAnimationTable: first offset ${firstOffset} is not a valid table end marker (must be >= 4 and a multiple of 4).`,
    );
  }

  const tableStart = 4;
  const tailStart = tableStart; // offsets are relative to the start after the 4-byte size header
  const count = firstOffset / 4;

  if (raw.byteLength < tableStart + count * 4) {
    throw new Error(
      `parseAnimationTable: data too small for ${count} animations (${raw.byteLength} bytes, ${tableStart + count * 4} expected).`,
    );
  }

  // 3. Offset-Tabelle (BE) lesen.
  const offsets: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = dv.getUint32(tableStart + i * 4, false);
  }

  // 4. Per animation: derive the frame count from the difference to the next offset,
  //    Frames als (sprite, x, y) lesen.
  const tailLength = raw.byteLength - tailStart;
  const animations: AnimationFrame[][] = new Array(count);

  for (let i = 0; i < count; i++) {
    const start = offsets[i]!;
    const end = i + 1 < count ? offsets[i + 1]! : tailLength;

    if (start > end || end > tailLength || (end - start) % 3 !== 0) {
      throw new Error(
        `parseAnimationTable: animation ${i} has inconsistent offsets (start=${start}, end=${end}, tail=${tailLength}).`,
      );
    }

    const frameCount = (end - start) / 3;
    const frames: AnimationFrame[] = new Array(frameCount);
    for (let j = 0; j < frameCount; j++) {
      const off = tailStart + start + j * 3;
      frames[j] = {
        sprite: dv.getUint8(off),
        x: dv.getInt8(off + 1),
        y: dv.getInt8(off + 2),
      };
    }
    animations[i] = frames;
  }

  return { animations };
}

/** Convenience: reads and parses the table from a `PaArchive`. */
export function loadAnimationTable(archive: PaArchive): AnimationTable {
  const raw = archive.getRaw(ANIMATION_ARCHIVE_INDEX);
  if (!raw) {
    throw new Error(
      `loadAnimationTable: entry ${ANIMATION_ARCHIVE_INDEX} is undefined in the archive.`,
    );
  }
  return parseAnimationTable(raw);
}
