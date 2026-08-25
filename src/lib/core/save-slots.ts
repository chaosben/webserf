/**
 * **The ten save slots — the logic that needs no storage layer.**
 *
 * The original keeps its saves in eleven files: `ARCHIV.DS` (the 160-byte index, ten entries of 16
 * bytes) and `SAVE0.DS`..`SAVE9.DS`. The clone keeps the same eleven things — only they live in
 * IndexedDB and, when the user grants a directory, as real files as well.
 *
 * Here lives only what is independent of both: the slot arithmetic, assembling the index and the
 * **sync between two stores**. The cut exists for testability — IndexedDB and the file system access
 * API do not exist in the test environment, these functions are plain computation.
 *
 * **The unit of the sync is a slot**, not a file. A slot is a triple of 16 index bytes (name + used
 * flag), the `.DS` bytes and a timestamp — they belong together because the name is part of what the
 * user saved. A sync comparing `ARCHIV.DS` as a **whole** would lose one of two newer slots.
 */

import { ARCHIV_SLOT_COUNT, ARCHIV_SLOT_SIZE } from './archiv-parser.js';
import { tOpaque } from './language.js';

/** File name of the index — the same in the original and in the directory (`0x47012`). */
export const ARCHIV_FILE_NAME = 'ARCHIV.DS';

/**
 * File name of a slot. The original builds it at runtime: the template `"SAVE0.DS"` sits at
 * `0x47009`, and `*(byte *)(template + 4) = slot + 0x30` (@0x3729b / @0x46ea6) swaps the digit. Ten
 * slots fit exactly because `'0' + 9 == '9'` — an eleventh would be `':'`.
 */
export const saveFileName = (slot: number): string => `SAVE${slot}.DS`;

/** A slot as a store knows it. */
export interface SaveSlotRecord {
  /** 0..9. */
  readonly index: number;
  /** The 16 index bytes (14 name + `0xff` + used flag). */
  readonly entry: Uint8Array;
  /** The `.DS` bytes, or `null` when the store knows only the index entry. */
  readonly data: Uint8Array | null;
  /** Unix ms of the last change. `0` == unknown/empty. */
  readonly savedAt: number;
}

/** The 16 index bytes of a slot from a 160-byte index. */
export function archivEntry(archiv: Uint8Array, slot: number): Uint8Array {
  const at = slot * ARCHIV_SLOT_SIZE;
  return archiv.slice(at, at + ARCHIV_SLOT_SIZE);
}

/**
 * A free index entry: the placeholder word, separator `0xff`, flag 0 — **exactly the 16 bytes the
 * original's index reader writes into its buffer ten times** before reading the file over it
 * (@0x46ced). The disk menu draws the **name bytes** of every row, so spaces here would show an empty
 * row instead of the placeholder.
 */
export function emptyArchivEntry(): Uint8Array {
  const e = new Uint8Array(ARCHIV_SLOT_SIZE);
  // In the active language — the original writes the word of its own version into the index, and an
  // `ARCHIV.DS` written here should look right in both versions.
  const name = tOpaque('archivFree');
  for (let j = 0; j < name.length && j < 14; j++) e[j] = name.charCodeAt(j);
  e[14] = 0xff;
  e[15] = 0;
  return e;
}

/** The 160-byte index from ten entries. Missing slots are filled in as free. */
export function assembleArchiv(records: readonly SaveSlotRecord[]): Uint8Array {
  const out = new Uint8Array(ARCHIV_SLOT_COUNT * ARCHIV_SLOT_SIZE);
  for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
    const rec = records.find((r) => r.index === i);
    const e = rec && rec.entry.length === ARCHIV_SLOT_SIZE ? rec.entry : emptyArchivEntry();
    out.set(e, i * ARCHIV_SLOT_SIZE);
  }
  return out;
}

/**
 * The name for a slot whose `.DS` is there but whose index entry is not. Two situations produce it: a
 * file dropped into the directory by hand, and an import without a usable file name. Both should show
 * the same, hence one place rather than two.
 */
export const fabricatedSlotName = (slot: number): string => `SPIEL ${slot}`;

/** Does the entry carry a set used flag? (byte 15) */
export const entryUsed = (entry: Uint8Array): boolean => (entry[15] ?? 0) !== 0;

/** What the sync intends to do with a slot. */
export type SlotSyncAction =
  /** Both sides agree (or both are empty) — nothing to do. */
  | { readonly kind: 'keep'; readonly slot: number }
  /** The slot must be copied from `from` to the other side. */
  | { readonly kind: 'copy'; readonly slot: number; readonly from: 'db' | 'dir' };

export interface ReconcilePlan {
  readonly actions: readonly SlotSyncAction[];
  /** The index that should stand on **both** sides afterwards. */
  readonly archiv: Uint8Array;
}

/**
 * **The sync: per slot the newer version wins.** Where only one side has something, that side wins;
 * where both have something, the larger timestamp; on a **tie** the database wins — not because it
 * matters more, but because a tie means both sides saw the same write, so either choice is equivalent
 * and copying would be pure write load.
 *
 * **Two limits:**
 * 1. The timestamps come from two sources — ours when writing to the database, `File.lastModified`
 *    for the directory. They are comparable as long as the same machine set them. A directory in a
 *    cloud store with a skewed clock can make the wrong slot win; that is not detectable from here.
 * 2. The **content** is not compared. Two different saves with an identical timestamp count as equal.
 *    A byte comparison would mean reading the whole directory on every start.
 */
export function reconcileSlots(
  db: readonly SaveSlotRecord[],
  dir: readonly SaveSlotRecord[],
): ReconcilePlan {
  const actions: SlotSyncAction[] = [];
  const winners: SaveSlotRecord[] = [];
  for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
    const a = db.find((r) => r.index === i && entryUsed(r.entry) && r.data !== null) ?? null;
    const b = dir.find((r) => r.index === i && entryUsed(r.entry) && r.data !== null) ?? null;
    if (a === null && b === null) {
      actions.push({ kind: 'keep', slot: i });
      continue;
    }
    if (a === null) {
      actions.push({ kind: 'copy', slot: i, from: 'dir' });
      winners.push(b!);
      continue;
    }
    if (b === null) {
      actions.push({ kind: 'copy', slot: i, from: 'db' });
      winners.push(a);
      continue;
    }
    if (a.savedAt === b.savedAt) {
      actions.push({ kind: 'keep', slot: i });
      winners.push(a);
      continue;
    }
    const dbWins = a.savedAt > b.savedAt;
    actions.push({ kind: 'copy', slot: i, from: dbWins ? 'db' : 'dir' });
    winners.push(dbWins ? a : b);
  }
  return { actions, archiv: assembleArchiv(winners) };
}
