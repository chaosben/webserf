import { describe, it, expect } from 'vitest';
import { ARCHIV_SLOT_COUNT, ARCHIV_SLOT_SIZE, parseArchiv } from './archiv-parser.js';
import { assembleArchiv, saveFileName, type SaveSlotRecord } from './save-slots.js';
import {
  buildSavePackage,
  namedArchivEntry,
  readSavePackage,
  saveGameRejection,
  slotNameFromFileName,
} from './save-transfer.js';
import { GLYPH_ORDER } from './ui-render.js';
import { buildZip, ZipError } from './zip.js';

/**
 * A size-exact, otherwise empty save — exactly what `parseSaveGame` accepts as valid. Only
 * "loadable or not" matters here, the content does not.
 */
function minimalSave(mapSize = 3): Uint8Array {
  const bm = (n: number) => 4 * Math.floor((n + 31) / 32);
  const cols = 1 << (5 + Math.floor(mapSize / 2));
  const rows = 1 << (5 + Math.floor((mapSize - 1) / 2));
  const total =
    250 + 4 * 8628 + 8 * cols * rows + bm(1) + 16 + bm(1) + 70 + bm(1) + 18 + bm(1) + 120;
  const b = new Uint8Array(total);
  const v = new DataView(b.buffer);
  v.setUint16(90, 1, true); // maxFlagIndex
  v.setUint16(92, 1, true); // maxBuildingIndex
  v.setUint16(94, 1, true); // maxSerfIndex
  v.setUint16(174, 1, true); // maxInventoryIndex
  v.setUint16(190, mapSize, true);
  return b;
}

const record = (index: number, name: string, savedAt: number): SaveSlotRecord => ({
  index,
  entry: namedArchivEntry(name, index),
  data: minimalSave(),
  savedAt,
});

describe('save-transfer — slot name from the file name', () => {
  it('strips path and extension and upper-cases', () => {
    expect(slotNameFromFileName('/downloads/SAVE3.DS')).toBe('SAVE3');
    expect(slotNameFromFileName('C:\\spiele\\mein stand.ds')).toBe('MEIN STAND');
    expect(slotNameFromFileName('erster.vers.DS')).toBe('ERSTER.VERS');
  });

  it('keeps only characters the font has a glyph for', () => {
    // Checked against GLYPH_ORDER, not against a list copied out here — otherwise a change to the
    // font bank would go unnoticed.
    const drawable = new Set([...GLYPH_ORDER, ' ']);
    const out = slotNameFromFileName('a_b+c/d#e!f.DS'.replace('/', '')); // `/` would be a path separator
    for (const ch of out) expect(drawable.has(ch)).toBe(true);
    // Umlauts are transliterated (`ü` -> `UE`), `_` and `&` become a gap, and two gaps in a row
    // collapse into one — so it does not read "UND", it drops out.
    expect(slotNameFromFileName('Mühle_&_Bäcker.DS')).toBe('MUEHLE BAECKER');
  });

  it('truncates to the 14 places of the index field', () => {
    const long = slotNameFromFileName('EIN SEHR LANGER NAME FUER EINEN SLOT.DS');
    expect(long).toHaveLength(14);
    expect(long).toBe('EIN SEHR LANGE');
  });

  it('keeps the name across download and upload', () => {
    // The point of the derivation: `SAVE0.DS` is named after its slot on download, a user renames
    // the file after the save — and exactly that name comes back.
    const entry = namedArchivEntry(slotNameFromFileName('Meine Burg.DS'), 4);
    expect(parseArchiv(assembleArchiv([{ index: 4, entry, data: null, savedAt: 0 }]))[4]).toEqual({
      index: 4,
      name: 'MEINE BURG'.padEnd(14),
      used: true,
    });
  });

  it('falls back to `SPIEL n` for a file name without a usable character', () => {
    const entry = namedArchivEntry(slotNameFromFileName('___.DS'), 7);
    expect(String.fromCharCode(...entry.subarray(0, 14)).trim()).toBe('SPIEL 7');
    expect(entry[14]).toBe(0xff);
    expect(entry[15]).toBe(1);
  });
});

describe('save-transfer: a single save', () => {
  it('accepts a valid save and names the reason for an invalid one', () => {
    expect(saveGameRejection(minimalSave())).toBeNull();
    const why = saveGameRejection(new Uint8Array(1234));
    expect(why).toBeTruthy();
    expect(why).toContain('SAVE');
  });
});

describe('save-transfer — the whole package', () => {
  it('contains exactly the original file names', async () => {
    const slots = [record(0, 'ERSTER', 1_700_000_000_000), record(5, 'FUENFTER', 1_700_000_100_000)];
    const pkg = buildSavePackage(assembleArchiv(slots), slots);
    const read = await readSavePackage(pkg);
    expect(read.hadIndex).toBe(true);
    expect(read.ignored).toEqual([]);
    expect(read.slots.map((s) => s.index)).toEqual([0, 5]);
    // The names come from the packed index — without it they would be lost.
    expect(parseArchiv(assembleArchiv(read.slots))[5]!.name).toBe('FUENFTER'.padEnd(14));
    expect(read.slots[0]!.data).toEqual(slots[0]!.data);
  });

  it('recognises the files lower-cased and in a subfolder too', async () => {
    const zip = buildZip([
      { name: 'siedler/save2.ds', data: minimalSave(), modifiedAt: 1_700_000_000_000 },
      { name: 'siedler/liesmich.txt', data: new Uint8Array([65]), modifiedAt: 0 },
    ]);
    const read = await readSavePackage(zip);
    expect(read.slots.map((s) => s.index)).toEqual([2]);
    expect(read.hadIndex).toBe(false);
    expect(read.ignored).toEqual(['siedler/liesmich.txt']);
    // Without an index the name is invented — the same one as in the directory layer.
    expect(parseArchiv(assembleArchiv(read.slots))[2]!.name).toBe('SPIEL 2'.padEnd(14));
  });

  it('skips an unreadable save instead of discarding the whole package', async () => {
    // A package of ten saves must not fail on one — that is the difference between "one slot is
    // missing" and "the import failed".
    const zip = buildZip([
      { name: 'SAVE0.DS', data: minimalSave(), modifiedAt: 1 },
      { name: 'SAVE1.DS', data: new Uint8Array(999), modifiedAt: 1 },
    ]);
    const read = await readSavePackage(zip);
    expect(read.slots.map((s) => s.index)).toEqual([0]);
    expect(read.ignored).toEqual(['SAVE1.DS']);
  });

  it('accepts a file the packed index lists as free', async () => {
    // Same decision as in the directory layer: the file is the evidence.
    const index = new Uint8Array(ARCHIV_SLOT_COUNT * ARCHIV_SLOT_SIZE);
    const read = await readSavePackage(
      buildZip([
        { name: 'ARCHIV.DS', data: index, modifiedAt: 0 },
        { name: saveFileName(9), data: minimalSave(), modifiedAt: 1 },
      ]),
    );
    expect(read.slots.map((s) => s.index)).toEqual([9]);
    expect(read.slots[0]!.entry[15]).toBe(1);
  });

  it('throws on a broken archive', async () => {
    await expect(readSavePackage(new Uint8Array(100))).rejects.toThrow(ZipError);
  });
});
