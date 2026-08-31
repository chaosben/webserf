import { describe, it, expect } from 'vitest';
import {
  ARCHIV_FILE_NAME,
  archivEntry,
  assembleArchiv,
  emptyArchivEntry,
  entryUsed,
  reconcileSlots,
  saveFileName,
  type SaveSlotRecord,
} from './save-slots.js';
import { ARCHIV_FREE_NAME, ARCHIV_SLOT_COUNT, ARCHIV_SLOT_SIZE, parseArchiv } from './archiv-parser.js';

const rec = (index: number, name: string, savedAt: number): SaveSlotRecord => {
  const entry = new Uint8Array(ARCHIV_SLOT_SIZE);
  entry.fill(0x20, 0, 14);
  for (let j = 0; j < Math.min(14, name.length); j++) entry[j] = name.charCodeAt(j);
  entry[14] = 0xff;
  entry[15] = 1;
  return { index, entry, data: new Uint8Array([index]), savedAt };
};

describe('save-slots — file names and index', () => {
  it('builds the slot names like the original (digit at position 4)', () => {
    // The original patches `*(template + 4) = slot + 0x30`; ten slots fit exactly.
    expect(saveFileName(0)).toBe('SAVE0.DS');
    expect(saveFileName(9)).toBe('SAVE9.DS');
    expect(ARCHIV_FILE_NAME).toBe('ARCHIV.DS');
  });

  it('assembles a complete 160-byte index and fills gaps as empty', () => {
    const a = assembleArchiv([rec(3, 'DRITTER', 1), rec(7, 'SIEBTER', 2)]);
    expect(a).toHaveLength(ARCHIV_SLOT_COUNT * ARCHIV_SLOT_SIZE);
    const slots = parseArchiv(a);
    expect(slots[3]).toEqual({ index: 3, name: 'DRITTER'.padEnd(14), used: true });
    expect(slots[7]).toEqual({ index: 7, name: 'SIEBTER'.padEnd(14), used: true });
    expect(slots.filter((s) => s.used)).toHaveLength(2);
    // Every entry carries the separator constant — the empty ones too.
    for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) expect(a[i * ARCHIV_SLOT_SIZE + 14]).toBe(0xff);
  });

  it('cuts one entry out without sharing the index', () => {
    const a = assembleArchiv([rec(5, 'FUENF', 1)]);
    const e = archivEntry(a, 5);
    expect(entryUsed(e)).toBe(true);
    e[15] = 0; // a copy, not a view
    expect(entryUsed(archivEntry(a, 5))).toBe(true);
    expect(entryUsed(emptyArchivEntry())).toBe(false);
  });

  it('gives a free entry the free-slot placeholder, not spaces', () => {
    // The used flag alone is not enough: the disk menu draws the NAME bytes of every line, so an
    // entry of spaces shows up as an empty line. The original's index reader fills its buffer with
    // exactly this sequence before reading (@0x46ced).
    const e = emptyArchivEntry();
    expect(String.fromCharCode(...e.subarray(0, 14))).toBe(ARCHIV_FREE_NAME);
    expect(e[14]).toBe(0xff);
    expect(e[15]).toBe(0);
    // And through `assembleArchiv`, the path on which the database index is built.
    const slots = parseArchiv(assembleArchiv([rec(2, 'ZWEI', 5)]));
    expect(slots[2]).toEqual({ index: 2, name: 'ZWEI'.padEnd(14), used: true });
    expect(slots.filter((sl) => !sl.used).every((sl) => sl.name === ARCHIV_FREE_NAME)).toBe(true);
  });
});

describe('save-slots — reconciling two stores', () => {
  it('lets the newer version win per slot', () => {
    const plan = reconcileSlots(
      [rec(0, 'DB NEUER', 200), rec(1, 'DB ALT', 100)],
      [rec(0, 'DIR ALT', 100), rec(1, 'DIR NEUER', 200)],
    );
    expect(plan.actions[0]).toEqual({ kind: 'copy', slot: 0, from: 'db' });
    expect(plan.actions[1]).toEqual({ kind: 'copy', slot: 1, from: 'dir' });
    const slots = parseArchiv(plan.archiv);
    expect(slots[0]!.name).toBe('DB NEUER'.padEnd(14));
    expect(slots[1]!.name).toBe('DIR NEUER'.padEnd(14));
  });

  it('copies a slot only one side has — in both directions', () => {
    const plan = reconcileSlots([rec(2, 'NUR DB', 1)], [rec(4, 'NUR DIR', 1)]);
    expect(plan.actions[2]).toEqual({ kind: 'copy', slot: 2, from: 'db' });
    expect(plan.actions[4]).toEqual({ kind: 'copy', slot: 4, from: 'dir' });
    expect(parseArchiv(plan.archiv).filter((s) => s.used).map((s) => s.name)).toEqual([
      'NUR DB'.padEnd(14),
      'NUR DIR'.padEnd(14),
    ]);
  });

  it('does nothing on a tie — otherwise every start would be write load', () => {
    const plan = reconcileSlots([rec(0, 'GLEICH', 500)], [rec(0, 'GLEICH', 500)]);
    expect(plan.actions[0]).toEqual({ kind: 'keep', slot: 0 });
    expect(parseArchiv(plan.archiv)[0]!.name).toBe('GLEICH'.padEnd(14));
  });

  it('treats two empty stores as identical', () => {
    const plan = reconcileSlots([], []);
    expect(plan.actions.every((a) => a.kind === 'keep')).toBe(true);
    expect(parseArchiv(plan.archiv).some((s) => s.used)).toBe(false);
  });

  it('ignores an entry without data and one without the used flag', () => {
    // An index entry without a file is not a slot — otherwise a stale record would beat a real save.
    const ghost: SaveSlotRecord = { ...rec(0, 'GEIST', 999), data: null };
    const free: SaveSlotRecord = { ...rec(1, 'FREI', 999) };
    free.entry[15] = 0;
    const plan = reconcileSlots([ghost, free], [rec(0, 'ECHT', 1), rec(1, 'ECHT2', 1)]);
    expect(plan.actions[0]).toEqual({ kind: 'copy', slot: 0, from: 'dir' });
    expect(plan.actions[1]).toEqual({ kind: 'copy', slot: 1, from: 'dir' });
    expect(parseArchiv(plan.archiv)[0]!.name).toBe('ECHT'.padEnd(14));
  });
});
