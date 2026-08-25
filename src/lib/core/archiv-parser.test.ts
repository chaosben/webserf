import { describe, it, expect } from 'vitest';
import { ARCHIV_FREE_NAME, ARCHIV_SLOT_COUNT, ARCHIV_SLOT_SIZE, encodeArchiv, parseArchiv } from './archiv-parser.js';

/** Builds a 16-byte slot: 14-byte name (space padded) + 0xFF + used flag. */
function makeSlot(name: string, used: boolean): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 14; i++) bytes.push(i < name.length ? name.charCodeAt(i) : 0x20);
  bytes.push(0xff);
  bytes.push(used ? 0x01 : 0x00);
  return bytes;
}

function makeArchiv(slots: Array<[string, boolean]>): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
    const [name, used] = slots[i] ?? ['', false];
    out.push(...makeSlot(name, used));
  }
  return new Uint8Array(out);
}

describe('parseArchiv', () => {
  it('liefert exakt 10 Slots', () => {
    const slots = parseArchiv(makeArchiv([]));
    expect(slots).toHaveLength(ARCHIV_SLOT_COUNT);
  });

  it('decodes name and used flag (pattern from ARCHIV.DS)', () => {
    const data = makeArchiv([
      ['ERSTER VERS', true],
      ['ZWEITER VERS', true],
      ['DRITTER VERS', true],
      ['FREI', false],
    ]);
    const slots = parseArchiv(data);
    expect(slots[0]).toEqual({ index: 0, name: 'ERSTER VERS'.padEnd(14), used: true });
    expect(slots[1]).toEqual({ index: 1, name: 'ZWEITER VERS'.padEnd(14), used: true });
    expect(slots[2]).toEqual({ index: 2, name: 'DRITTER VERS'.padEnd(14), used: true });
 // `makeArchiv` writes the word left-aligned -- the centred placeholder of the original
 // (`ARCHIV_FREE_NAME`) is checked in the encoder tests below.
    expect(slots[3]).toEqual({ index: 3, name: 'FREI'.padEnd(14), used: false });
  });

  it('returns the 14 name characters verbatim, without trimming', () => {
    const slots = parseArchiv(makeArchiv([['ERSTER VERS', true]]));
    expect(slots[0].name).toBe('ERSTER VERS   '); // 14 Zeichen, verbatim -- s. `decodeName`
  });

  it('the slot size is 16 bytes', () => {
    expect(ARCHIV_SLOT_SIZE).toBe(16);
  });

  it('wirft bei zu kleiner Datei', () => {
    expect(() => parseArchiv(new Uint8Array(159))).toThrow();
  });

  it('accepts ArrayBuffer and Uint8Array alike', () => {
    const u8 = makeArchiv([['TEST', true]]);
    const fromBuf = parseArchiv(u8.buffer as ArrayBuffer);
    expect(fromBuf[0].name).toBe('TEST'.padEnd(14));
  });
});

describe('encodeArchiv — the placeholder of free slots', () => {
  it('writes the byte sequence of the index reader into a free slot', () => {
 // `ARCHIV_FREE_NAME` is the sequence `0x46cda` puts into its buffer ten times before reading the
 // file over it. Here it is about the encoder, which must produce it so that an empty slot in the
 // disk menu does not appear as an empty line.
 // als leere Zeile erscheint.
    expect(ARCHIV_FREE_NAME).toBe('     FREI     ');
    expect(ARCHIV_FREE_NAME.length).toBe(14);
    const enc = encodeArchiv([{ index: 0, name: 'BELEGT', used: true }]);
    const back = parseArchiv(enc.buffer as ArrayBuffer);
    expect(back[0]).toEqual({ index: 0, name: 'BELEGT'.padEnd(14), used: true });
    for (let i = 1; i < 10; i++)
      expect(back[i]).toEqual({ index: i, name: ARCHIV_FREE_NAME, used: false });
 // Untrimmed: the five leading spaces are the original's centring.
    const raw = String.fromCharCode(...enc.subarray(ARCHIV_SLOT_SIZE, ARCHIV_SLOT_SIZE + 14));
    expect(raw).toBe(ARCHIV_FREE_NAME);
    expect(enc[ARCHIV_SLOT_SIZE + 14]).toBe(0xff);
    expect(enc[ARCHIV_SLOT_SIZE + 15]).toBe(0x00);
  });

  it('lets a supplied base win for free slots', () => {
 // So the placeholder of a different language build survives when the user brings a real
 // `ARCHIV.DS` — the word lives in the program code, not in the archive.
    const base = new Uint8Array(160);
    base.fill(0x20);
    for (let i = 0; i < 4; i++) base[16 + i] = 'FREE'.charCodeAt(i);
    const enc = encodeArchiv([], { base });
    expect(String.fromCharCode(...enc.subarray(16, 20))).toBe('FREE');
  });
});
