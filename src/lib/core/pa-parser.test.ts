import { describe, it, expect } from 'vitest';
import { PaArchive } from './pa-parser.js';
import { readOriginal } from '../testing/originals.js';

const loadOrigFile = (name: string): Buffer | null => readOriginal(name);

function makeMinimalArchive(entries: { size: number; offset: number }[], payloadBytes = 64): Uint8Array {
  // Header (8) + TOC (n*8) + Payload
  const tocSize = entries.length * 8;
  const total = 8 + tocSize + payloadBytes;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, total, true);
  dv.setUint32(4, entries.length, true);
  entries.forEach((e, i) => {
    dv.setUint32(8 + i * 8, e.size, true);
    dv.setUint32(8 + i * 8 + 4, e.offset, true);
  });
  return buf;
}

describe('PaArchive.parse — synthetic', () => {
  it('rejects a buffer smaller than 8 bytes', () => {
    expect(() => PaArchive.parse(new Uint8Array(4))).toThrow(/too small/);
  });

  it('rejects a TPWM-compressed file', () => {
    const buf = new Uint8Array(16);
    buf.set([0x54, 0x50, 0x57, 0x4d]); // "TPWM"
    expect(() => PaArchive.parse(buf)).toThrow(/TPWM/);
  });

  it('rejects an inconsistent file_size field', () => {
    const buf = makeMinimalArchive([{ size: 0, offset: 0 }], 64);
    new DataView(buf.buffer).setUint32(0, 999, true); // falsch
    expect(() => PaArchive.parse(buf)).toThrow(/file_size/);
  });

  it('rejects entry_count = 0', () => {
    const buf = makeMinimalArchive([], 0);
    expect(() => PaArchive.parse(buf)).toThrow(/entry_count/);
  });

  it('rejects entries that reach past the end of the file', () => {
    const buf = makeMinimalArchive([{ size: 1000, offset: 8 + 8 + 1 }], 16);
    expect(() => PaArchive.parse(buf)).toThrow(/past the end of the file/);
  });

  it('parses a valid synthetic file', () => {
    const buf = makeMinimalArchive([
      { size: 0, offset: 0 },           // undefiniert
      { size: 16, offset: 8 + 8 * 2 },  // valid entry right after the TOC
    ], 32);
    const arch = PaArchive.parse(buf);
    expect(arch.entries.length).toBe(2);
    expect(arch.entries[0]!.offset).toBe(0);
    expect(arch.entries[1]!.offset).toBe(24);
    expect(arch.getRaw(0)).toBeNull();
    expect(arch.getRaw(1)?.byteLength).toBe(16);
  });

  it('getRaw throws on an out-of-range index', () => {
    const buf = makeMinimalArchive([{ size: 0, offset: 0 }], 8);
    const arch = PaArchive.parse(buf);
    expect(() => arch.getRaw(99)).toThrow(RangeError);
  });
});

describe('PaArchive.parse — DOS load TOC fixup (block replication)', () => {
  // Builds an archive with `count` entries; every used entry points at a unique 1-byte slot in the
  // payload (offset = payloadStart + index), so copies are recognisable by their offset.
  function makeArchiveWithEntries(count: number, definedIdx: number[]): PaArchive {
    const payloadStart = 8 + count * 8;
    const buf = new Uint8Array(payloadStart + count + 16);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, buf.length, true);
    dv.setUint32(4, count, true);
    const defined = new Set(definedIdx);
    for (let i = 0; i < count; i++) {
      const off = defined.has(i) ? payloadStart + i : 0;
      dv.setUint32(8 + i * 8, defined.has(i) ? 1 : 0, true); // size
      dv.setUint32(8 + i * 8 + 4, off, true); // offset
    }
    return PaArchive.parse(buf);
  }

  it('replicates the serf head blocks (48x from 3449, entry[0] -> [1..5])', () => {
    // Only the block starts 3449 + k*6 are used.
    const leaders = Array.from({ length: 48 }, (_, k) => 3449 + k * 6);
    const arch = makeArchiveWithEntries(3800, leaders);
    for (const src of leaders) {
      const srcOff = arch.entries[src]!.offset;
      expect(srcOff).not.toBe(0);
      for (let d = 1; d <= 5; d++) {
        expect(arch.entries[src + d]!.offset).toBe(srcOff); // dir1..5 erben dir0
        expect(arch.entries[src + d]!.size).toBe(1);
      }
    }
  });

  it('replicates the three extra groups (3761-3763->3764-3766, 1351->1362-1367, 1601->1612-1617)', () => {
    const arch = makeArchiveWithEntries(3800, [3761, 3762, 3763, 1351, 1601]);
    // Group 2: shifted in parallel by 3
    for (let d = 0; d < 3; d++)
      expect(arch.entries[3764 + d]!.offset).toBe(arch.entries[3761 + d]!.offset);
    // Group 3: 1351 → 1362..1367
    for (let d = 0; d < 6; d++)
      expect(arch.entries[1362 + d]!.offset).toBe(arch.entries[1351]!.offset);
    // Group 4: 1601 → 1612..1617
    for (let d = 0; d < 6; d++)
      expect(arch.entries[1612 + d]!.offset).toBe(arch.entries[1601]!.offset);
  });

  it('leaves entries outside the fixup ranges untouched', () => {
    // Ordinary serf heads (~3227) sit before 3449 -> no replication.
    const arch = makeArchiveWithEntries(3800, [3227, 3228, 100, 3737]);
    expect(arch.entries[3228]!.offset).not.toBe(arch.entries[3227]!.offset);
    expect(arch.entries[101]!.offset).toBe(0); // 100 used, 101 stays empty
    expect(arch.entries[3738]!.offset).toBe(0); // 3737 used, 3738 (past the block end) stays empty
  });

  it('is a no-op for archives that are too small (not a complete sprite pack)', () => {
    const arch = makeArchiveWithEntries(1400, [1351]); // < 3767 -> no fixup
    for (let d = 0; d < 6; d++) expect(arch.entries[1362 + d]!.offset).toBe(0);
  });
});

describe.runIf(loadOrigFile('SPAD.PA') !== null)('PaArchive.parse — Original SPAD.PA', () => {
  it('parses the archive and has 4000 entries', () => {
    const buf = loadOrigFile('SPAD.PA')!;
    const arch = PaArchive.parse(buf);
    expect(arch.entries.length).toBe(4000);
  });

  it('entry 0 looks like a 640x200 full-screen picture (solid)', () => {
    const buf = loadOrigFile('SPAD.PA')!;
    const arch = PaArchive.parse(buf);
    const e0 = arch.entries[0]!;
    expect(e0.offset).toBe(32008);                            // 8 (Header) + 4000*8 (TOC)
    expect(e0.size).toBe(128010);                             // 640*200 + 10
    const raw = arch.getRaw(0)!;
    expect(raw.byteLength).toBe(128010);
    // Sprite header at bytes 0..9 — width/height/offsets are the reliable markers.
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    expect(dv.getUint16(2, true)).toBe(640);    // width
    expect(dv.getUint16(4, true)).toBe(200);    // height
    expect(dv.getInt16(6, true)).toBe(0);       // offset_x
    expect(dv.getInt16(8, true)).toBe(0);       // offset_y
    // Solid encoding check: size - 10 == width * height
    expect(raw.byteLength - 10).toBe(640 * 200);
  });

  it('no entry reaches past the end of the file', () => {
    const buf = loadOrigFile('SPAD.PA')!;
    const arch = PaArchive.parse(buf);
    for (const e of arch.entries) {
      if (e.offset === 0) continue;
      expect(e.offset + e.size).toBeLessThanOrEqual(buf.byteLength);
    }
  });

  it('has a majority of defined slots', () => {
    const buf = loadOrigFile('SPAD.PA')!;
    const arch = PaArchive.parse(buf);
    const defined = arch.entries.filter((e) => e.offset !== 0).length;
    expect(defined).toBeGreaterThan(arch.entries.length / 2);
  });
});
