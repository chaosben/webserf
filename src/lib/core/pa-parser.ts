import type { PackEntry } from './types.js';

/**
 * Parser for a `.PA` pack archive.
 *
 * Layout (verified against the original archive):
 *
 *   offset 0:    u32 LE file_size      (== exact file size, a sanity check)
 *   Offset 4:    u32 LE entry_count
 *   Offset 8 ..  entry_count × 8 Bytes TocEntry { u32 size; u32 offset }
 *   ... at each entry's `offset`: 10-byte SpriteHeader + payload
 *
 * Format empirically reverse-engineered and verified against real archives (`SPAD.PA`).
 */
export class PaArchive {
  /** The immutable raw bytes (kept for sprite decoding). */
  readonly data: Uint8Array;
  readonly entries: readonly PackEntry[];

  private constructor(data: Uint8Array, entries: PackEntry[]) {
    this.data = data;
    this.entries = entries;
  }

  static parse(buffer: ArrayBuffer | ArrayBufferView): PaArchive {
    const data = toUint8Array(buffer);

    if (data.byteLength < 8) {
      throw new Error(`PaArchive: file too small (${data.byteLength} bytes).`);
    }

    // Magic check: TPWM-compressed?
    if (
      data[0] === 0x54 /* T */ &&
      data[1] === 0x50 /* P */ &&
      data[2] === 0x57 /* W */ &&
      data[3] === 0x4d /* M */
    ) {
      throw new Error(
        'PaArchive: the file is TPWM-compressed. That variant is not supported (yet) — ' +
          'an installed copy of the game should contain an unpacked archive.',
      );
    }

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const declaredSize = dv.getUint32(0, true);
    const entryCount = dv.getUint32(4, true);

    if (declaredSize !== data.byteLength) {
      throw new Error(
        `PaArchive: the file_size field disagrees (header says ${declaredSize}, file is ${data.byteLength}). ` +
          `the file is probably not a valid PA archive, or damaged.`,
      );
    }

    if (entryCount === 0 || entryCount > 100_000) {
      throw new Error(`PaArchive: implausible entry_count = ${entryCount}.`);
    }

    const tocBytes = entryCount * 8;
    if (8 + tocBytes > data.byteLength) {
      throw new Error(
        `PaArchive: the TOC (${tocBytes} bytes) does not fit into the file (${data.byteLength} bytes).`,
      );
    }

    const entries: PackEntry[] = new Array(entryCount);
    for (let i = 0; i < entryCount; i++) {
      const tocPos = 8 + i * 8;
      const size = dv.getUint32(tocPos, true);
      const offset = dv.getUint32(tocPos + 4, true);

      // offset 0 means "undefined" and is legitimate.
      if (offset !== 0) {
        if (offset + size > data.byteLength) {
          throw new Error(
            `PaArchive: entry ${i} runs past the end of the file (offset=${offset}, size=${size}, file=${data.byteLength}).`,
          );
        }
      }

      entries[i] = { index: i, offset, size };
    }

    applyDosLoadFixup(entries);

    return new PaArchive(data, entries);
  }

  /**
   * The raw bytes of an entry, `null` for an undefined slot (offset 0). The returned view shares
   * memory with `this.data` — do not modify.
   */
  getRaw(index: number): Uint8Array | null {
    const e = this.entries[index];
    if (!e) throw new RangeError(`entry ${index} outside [0, ${this.entries.length}).`);
    if (e.offset === 0) return null;
    return this.data.subarray(e.offset, e.offset + e.size);
  }
}

/**
 * Load-time TOC fixup the original loader applies right after reading the sprite archive: the setup
 * routine calls a fixup procedure immediately after `archive = load(...)` that replicates certain TOC
 * entries, so "empty" file slots point at real sprite data at runtime.
 *
 * Background: for some serf poses (above all the ore-carrying miner heads) only **one** direction is
 * stored in the archive; the fixup replicates the start of the block across the 5 missing direction
 * slots. Without it the head formula `base + direction` lands on an empty slot and the serf would be
 * drawn headless in every direction but 0.
 *
 * Four copy groups (entry = the whole 8-byte TocEntry {size, offset}, via `entry = (byteOffset-8)/8`):
 *   1. 48 blocks from entry 3449, per block entry[0] -> [1..5] (serf head region 3449..3736)
 *   2. entries 3761..3763 -> 3764..3766
 *   3. entry 1351 -> 1362..1367
 *   4. entry 1601 -> 1612..1617
 * Only applied when the archive is large enough (a complete sprite pack), otherwise a no-op.
 */
function applyDosLoadFixup(entries: PackEntry[]): void {
  const MAX_TOUCHED = 3766;
  if (entries.length <= MAX_TOUCHED) return; // not a complete sprite pack -> nothing to do

  const copy = (from: number, to: number): void => {
    const s = entries[from];
    entries[to] = { index: to, offset: s.offset, size: s.size };
  };

  // 1. Serf head blocks: 48 x 6 from 3449, per block the first entry -> the following 5.
  for (let k = 0; k < 48; k++) {
    const src = 3449 + k * 6;
    for (let d = 1; d <= 5; d++) copy(src, src + d);
  }
  // 2. Entries 3761..3763 -> 3764..3766.
  for (let d = 0; d < 3; d++) copy(3761 + d, 3764 + d);
  // 3. Entry 1351 -> 1362..1367.
  for (let d = 0; d < 6; d++) copy(1351, 1362 + d);
  // 4. Entry 1601 -> 1612..1617.
  for (let d = 0; d < 6; d++) copy(1601, 1612 + d);
}

function toUint8Array(buf: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(buf);
}
