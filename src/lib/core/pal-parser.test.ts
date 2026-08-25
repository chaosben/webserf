import { describe, it, expect } from 'vitest';
import { parsePalette, parseInArchivePalette } from './pal-parser.js';
import { PaArchive } from './pa-parser.js';
import { readOriginal } from '../testing/originals.js';

const loadOrigFile = (name: string): Buffer | null => readOriginal(name);

describe('parsePalette (externe .PAL-Datei, VGA 6-bit)', () => {
  it('wirft bei zu kleinem Buffer', () => {
    expect(() => parsePalette(new Uint8Array(10))).toThrow(/too small/);
  });

  it('throws when channel values exceed 63 (not the VGA format)', () => {
    const buf = new Uint8Array(4 + 256 * 3);
    buf[4] = 0x80;
    expect(() => parsePalette(buf)).toThrow(/> 63/);
  });

  it('konvertiert 6-bit zu 8-bit korrekt', () => {
    const buf = new Uint8Array(4 + 256 * 3);
    buf[4] = 0;
    buf[5] = 63;
    buf[6] = 32;
    const pal = parsePalette(buf);
    expect(pal.rgba[0]).toBe(0);
    expect(pal.rgba[1]).toBe(255);
    expect(pal.rgba[2]).toBe(130);
    expect(pal.rgba[3]).toBe(255);
  });

  it('liefert exakt 256*4 Bytes RGBA', () => {
    const buf = new Uint8Array(4 + 256 * 3);
    const pal = parsePalette(buf);
    expect(pal.rgba.byteLength).toBe(256 * 4);
  });

  describe.runIf(loadOrigFile('0.PAL') !== null)('with the original 0.PAL', () => {
    it('parst 0.PAL ohne Fehler', () => {
      const buf = loadOrigFile('0.PAL')!;
      const pal = parsePalette(buf);
      expect(pal.rgba.byteLength).toBe(1024);
      for (let i = 3; i < pal.rgba.byteLength; i += 4) {
        expect(pal.rgba[i]).toBe(0xff);
      }
    });
  });
});

describe('parseInArchivePalette (in-archive Palette, raw 8-bit RGB)', () => {
  it('throws on a wrong size', () => {
    expect(() => parseInArchivePalette(new Uint8Array(100))).toThrow(/768/);
    expect(() => parseInArchivePalette(new Uint8Array(1000))).toThrow(/768/);
  });

  it('parst exakt 768 Bytes als 256×4 RGBA', () => {
    const buf = new Uint8Array(768);
    buf[3] = 0xff; buf[4] = 0xa0; buf[5] = 0x10;
    const pal = parseInArchivePalette(buf);
    expect(pal.rgba.byteLength).toBe(1024);
    expect(pal.rgba[4]).toBe(0xff);
    expect(pal.rgba[5]).toBe(0xa0);
    expect(pal.rgba[6]).toBe(0x10);
    expect(pal.rgba[7]).toBe(0xff);
  });

  it('always forces index 0 to black — the data there never reaches the screen', () => {
    // The upload loop @0x2570 pushes all 256 entries into the DAC and then overwrites entry 0
    // unconditionally with (0,0,0) (four `xor` @0x25af..@0x25b5, then `call 0x646c9`).
    const buf = new Uint8Array(768);
    buf[0] = 0x00; buf[1] = 0x8b; buf[2] = 0x47; // the green that sits at position 0 in the archive
    const pal = parseInArchivePalette(buf);
    expect([pal.rgba[0], pal.rgba[1], pal.rgba[2]]).toEqual([0, 0, 0]);
    expect(pal.rgba[3]).toBe(0xff);
  });

  describe.runIf(loadOrigFile('SPAD.PA') !== null)('from the archive', () => {
    it('extracts the in-archive palette from TOC[2]', () => {
      const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
      const raw = arch.getRaw(2)!;
      expect(raw.byteLength).toBe(768);
      const pal = parseInArchivePalette(raw);
      expect(pal.rgba.byteLength).toBe(1024);
      // Kein Alpha-Slack
      for (let i = 3; i < pal.rgba.byteLength; i += 4) {
        expect(pal.rgba[i]).toBe(0xff);
      }
    });

    it('extracts the in-archive palettes from TOC[3996] and TOC[3997]', () => {
      const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
      const raw3996 = arch.getRaw(3996);
      const raw3997 = arch.getRaw(3997);
      expect(raw3996?.byteLength).toBe(768);
      expect(raw3997?.byteLength).toBe(768);
      expect(() => parseInArchivePalette(raw3996!)).not.toThrow();
      expect(() => parseInArchivePalette(raw3997!)).not.toThrow();
    });
  });
});
