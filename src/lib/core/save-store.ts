/**
 * **The carrier layer of the ten save slots** — the counterpart of the original's eleven files
 * (`ARCHIV.DS` + `SAVE0..9.DS`), and the consumer of `save-encoder.ts` / `save-parser.ts`.
 *
 * Two stores, in this order:
 *
 * 1. **IndexedDB** — always available, the default. One store `slots`, keys 0..9, value
 *    `{entry, data, savedAt}`; the 160-byte index is derived from it ({@link assembleArchiv}) instead
 *    of being kept separately, so there is no second source of truth.
 * 2. **A folder**, if the user grants one (`showDirectoryPicker`). The eleven files live there under
 *    their original names, so they can be copied into a DOS directory and loaded there. On attach and
 *    on every start both sides are reconciled, **per slot the newer version wins**
 *    ({@link reconcileSlots}).
 *
 * **Why the folder sits behind an interface** ({@link SaveDirectory}): the file system access API
 * exists only in some browsers and not at all in the test environment. The interface is three methods
 * wide, so reconciliation is testable without a browser, and a browser without the API loses only
 * this one layer.
 *
 * **The error codes are the original's** (`gs+0x240`, see `disk-menu.ts`): 2 index not writable ·
 * 3 slot not creatable · 4 slot not readable · 5 write aborted · 6 data unreadable · 7 header
 * rejected. The mapping is a **decision** and is stated at each site: a failed I/O is 3/4/5/6, a save
 * the parser rejects is **7** — that is exactly "the file is a save, but not one we can load".
 */

import { openDB, type IDBPDatabase } from 'idb';
import { ARCHIV_SLOT_COUNT, ARCHIV_SLOT_SIZE } from './archiv-parser.js';
import { DISK_RESULT } from './disk-menu.js';
import {
  ARCHIV_FILE_NAME,
  archivEntry,
  assembleArchiv,
  fabricatedSlotName,
  reconcileSlots,
  saveFileName,
  type SaveSlotRecord,
} from './save-slots.js';

const DB_NAME = 'siedler-savegames';
const SLOT_STORE = 'slots';
const META_STORE = 'meta';
const DIR_HANDLE_KEY = 'directory';
const VERSION = 1;

/**
 * A granted folder, reduced to the essentials. The return of {@link readFile} carries the
 * modification timestamp, because without it no reconciliation is possible.
 */
export interface SaveDirectory {
  readFile(name: string): Promise<{ data: Uint8Array; modifiedAt: number } | null>;
  writeFile(name: string, data: Uint8Array): Promise<void>;
  /**
   * Delete a file. **Optional**, because not every environment can — and the consequence is in
   * {@link SaveStore.remove}: without this method the next reconciliation pulls the deleted slot back
   * out of the folder, since a file present there counts as proof.
   */
  removeFile?(name: string): Promise<void>;
  /** Display only — the name the user picked. */
  readonly label: string;
}

interface StoredSlot {
  readonly entry: ArrayBuffer;
  readonly data: ArrayBuffer;
  readonly savedAt: number;
}

const bytes = (b: ArrayBuffer): Uint8Array => new Uint8Array(b);
const buffer = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** What a reconciliation did — for display and for the bug report. */
export interface ReconcileReport {
  readonly toDirectory: readonly number[];
  readonly toDatabase: readonly number[];
  readonly unchanged: readonly number[];
}

export class SaveStore {
  private constructor(
    private readonly db: IDBPDatabase,
    private dir: SaveDirectory | null,
    private index: Uint8Array,
  ) {}

  /** Opens the database and builds the index. The folder is **not** attached here. */
  static async open(): Promise<SaveStore> {
    const db = await openDB(DB_NAME, VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(SLOT_STORE)) d.createObjectStore(SLOT_STORE);
        if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE);
      },
    });
    const store = new SaveStore(db, null, new Uint8Array(0));
    store.index = assembleArchiv(await store.readDatabaseSlots());
    return store;
  }

  /** The 160-byte index — exactly what `gs+0xd8` holds in the original. */
  get archiv(): Uint8Array {
    return this.index;
  }

  /** The attached folder, if there is one (display only). */
  get directoryLabel(): string | null {
    return this.dir?.label ?? null;
  }

  private async readDatabaseSlots(): Promise<SaveSlotRecord[]> {
    const out: SaveSlotRecord[] = [];
    for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
      const v = (await this.db.get(SLOT_STORE, i)) as StoredSlot | undefined;
      if (!v) continue;
      out.push({ index: i, entry: bytes(v.entry), data: bytes(v.data), savedAt: v.savedAt });
    }
    return out;
  }

  private async readDirectorySlots(dir: SaveDirectory): Promise<SaveSlotRecord[]> {
    const archiv = await dir.readFile(ARCHIV_FILE_NAME);
    const out: SaveSlotRecord[] = [];
    for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
      const f = await dir.readFile(saveFileName(i));
      if (!f) continue;
      // If the folder has no index, the slot still counts as occupied — the file is the proof. That
      // is the case "somebody copied SAVEn.DS in by hand", and the original behaves the other way
      // round (it reads **only** the index). Deliberate deviation: a save that is there and does not
      // show up would be inexplicable to the user.
      const entry = archiv ? archivEntry(archiv.data, i) : fabricateEntry(i);
      if ((entry[15] ?? 0) === 0) entry[15] = 1;
      out.push({ index: i, entry, data: f.data, savedAt: f.modifiedAt });
    }
    return out;
  }

  /**
   * Attach a folder and reconcile. The handle is stored in the database so the next start finds it
   * again — the **permission** does not always survive that and then has to be renewed inside a user
   * gesture (see `views/save-directory.ts`).
   */
  async attachDirectory(dir: SaveDirectory, handle?: unknown): Promise<ReconcileReport> {
    this.dir = dir;
    if (handle !== undefined) {
      try {
        await this.db.put(META_STORE, handle, DIR_HANDLE_KEY);
      } catch {
        // A handle that cannot be stored (older browser) only costs the re-recognition.
      }
    }
    return this.reconcile();
  }

  /** Fetch the stored folder handle — the caller checks the permission. */
  async storedDirectoryHandle(): Promise<unknown | null> {
    try {
      return (await this.db.get(META_STORE, DIR_HANDLE_KEY)) ?? null;
    } catch {
      return null;
    }
  }

  /** Forget the folder (the database keeps the saves). */
  async detachDirectory(): Promise<void> {
    this.dir = null;
    await this.db.delete(META_STORE, DIR_HANDLE_KEY);
  }

  /** Reconcile both stores. Without a folder it is a no-op. */
  async reconcile(): Promise<ReconcileReport> {
    const dir = this.dir;
    if (!dir) {
      this.index = assembleArchiv(await this.readDatabaseSlots());
      return { toDirectory: [], toDatabase: [], unchanged: [] };
    }
    const dbSlots = await this.readDatabaseSlots();
    const dirSlots = await this.readDirectorySlots(dir);
    const plan = reconcileSlots(dbSlots, dirSlots);
    const toDirectory: number[] = [];
    const toDatabase: number[] = [];
    const unchanged: number[] = [];
    for (const a of plan.actions) {
      if (a.kind === 'keep') {
        unchanged.push(a.slot);
        continue;
      }
      if (a.from === 'db') {
        const rec = dbSlots.find((r) => r.index === a.slot)!;
        await dir.writeFile(saveFileName(a.slot), rec.data!);
        toDirectory.push(a.slot);
      } else {
        const rec = dirSlots.find((r) => r.index === a.slot)!;
        await this.db.put(
          SLOT_STORE,
          { entry: buffer(rec.entry), data: buffer(rec.data!), savedAt: rec.savedAt },
          a.slot,
        );
        toDatabase.push(a.slot);
      }
    }
    this.index = plan.archiv;
    if (toDirectory.length > 0 || toDatabase.length > 0) {
      await dir.writeFile(ARCHIV_FILE_NAME, this.index);
    }
    return { toDirectory, toDatabase, unchanged };
  }

  /**
   * Save one game. `archiv` are the 160 bytes as the disk menu holds them.
   *
   * The return is the original code: 0 success · 2 index not writable · 5 write error.
   *
   * **A deliberate deviation, with a reason.** The original writes the **whole** index
   * (`mov $0xa0` @0x46e1f) — so if the user named a slot without saving it, that name and its
   * occupied flag land on the disk anyway. On the next load the disk menu shows a slot whose file
   * does not exist; clicking it ends in code **4** ("cannot open file"). That is a defect of the
   * original and we do **not** reproduce it: only the entry of the saved slot becomes permanent here,
   * because an entry without a file is exactly the orphan {@link reconcileSlots} has to discard.
   *
   * Nothing the user can see is lost: the typed name stays in this store's index for the session
   * ({@link archiv} is written below) — only a reload forgets a name without a save. The **folder**,
   * by contrast, then holds exactly the index matching the files present, and that is the one the
   * original reads.
   */
  async save(slot: number, archiv: Uint8Array, data: Uint8Array): Promise<number> {
    const savedAt = Date.now();
    const entry = archivEntry(archiv, slot);
    try {
      await this.db.put(SLOT_STORE, { entry: buffer(entry), data: buffer(data), savedAt }, slot);
    } catch {
      return DISK_RESULT.writeFailed;
    }
    this.index = new Uint8Array(archiv);
    if (this.dir) {
      try {
        await this.dir.writeFile(ARCHIV_FILE_NAME, this.index);
      } catch {
        return DISK_RESULT.archivFailed;
      }
      try {
        await this.dir.writeFile(saveFileName(slot), data);
      } catch {
        return DISK_RESULT.writeFailed;
      }
    }
    return DISK_RESULT.saved;
  }

  /**
   * Load one game. Returns `{ code, data }` — code 1 on success, 4 if nothing is there, 6 if reading
   * fails. **Code 7 is the caller's call**, because "configuration not allowed" is the parser's
   * verdict and not the store's.
   */
  async load(slot: number): Promise<{ code: number; data: Uint8Array | null }> {
    try {
      const v = (await this.db.get(SLOT_STORE, slot)) as StoredSlot | undefined;
      if (v) return { code: DISK_RESULT.loaded, data: bytes(v.data) };
    } catch {
      return { code: DISK_RESULT.readFailed, data: null };
    }
    if (this.dir) {
      try {
        const f = await this.dir.readFile(saveFileName(slot));
        if (f) return { code: DISK_RESULT.loaded, data: f.data };
      } catch {
        return { code: DISK_RESULT.readFailed, data: null };
      }
    }
    return { code: DISK_RESULT.openFailed, data: null };
  }

  /**
   * The occupied slots as the store sees them — for the display and the export bundle
   * (`save-transfer.ts`). The **database** is read, and that is complete: a slot that only lived in
   * the folder was copied here during reconciliation.
   */
  async slots(): Promise<SaveSlotRecord[]> {
    return this.readDatabaseSlots();
  }

  /**
   * Insert a save from outside — the counterpart of {@link save}, except the index entry comes along
   * (on import there is no typed name, see `save-transfer.ts`). The timestamp is **now** and not the
   * source file's: the import is the most recent change to this slot, and that is how the next
   * reconciliation should treat it.
   *
   * Returns as {@link save}: 0 success · 2 index not writable · 5 write error.
   */
  async importSlot(slot: number, entry: Uint8Array, data: Uint8Array): Promise<number> {
    const savedAt = Date.now();
    try {
      await this.db.put(SLOT_STORE, { entry: buffer(entry), data: buffer(data), savedAt }, slot);
    } catch {
      return DISK_RESULT.writeFailed;
    }
    const index = new Uint8Array(this.index);
    index.set(entry.subarray(0, ARCHIV_SLOT_SIZE), slot * ARCHIV_SLOT_SIZE);
    this.index = index;
    if (this.dir) {
      try {
        await this.dir.writeFile(ARCHIV_FILE_NAME, this.index);
      } catch {
        return DISK_RESULT.archivFailed;
      }
      try {
        await this.dir.writeFile(saveFileName(slot), data);
      } catch {
        return DISK_RESULT.writeFailed;
      }
    }
    return DISK_RESULT.saved;
  }

  /**
   * Delete a slot — in the database **and**, if possible, in the folder.
   *
   * Returning `false` means "the file is still in the folder": either the environment cannot delete
   * ({@link SaveDirectory.removeFile} missing) or it failed. That is not a cosmetic difference — on
   * the next start {@link reconcile} pulls the save back from there, and the caller must be able to
   * say so instead of producing a silent reappearance.
   */
  async remove(slot: number): Promise<boolean> {
    await this.db.delete(SLOT_STORE, slot);
    this.index = assembleArchiv(await this.readDatabaseSlots());
    const dir = this.dir;
    if (!dir) return true;
    let gone = true;
    if (typeof dir.removeFile === 'function') {
      try {
        await dir.removeFile(saveFileName(slot));
      } catch {
        gone = false;
      }
    } else {
      gone = false;
    }
    try {
      // The index is written even if the file stayed: it is the view the original reads, and there
      // the slot is free now.
      await dir.writeFile(ARCHIV_FILE_NAME, this.index);
    } catch {
      return false;
    }
    return gone;
  }
}

/** An index entry for a file lying in the folder without an index (see {@link fabricatedSlotName}). */
function fabricateEntry(slot: number): Uint8Array {
  const e = new Uint8Array(ARCHIV_SLOT_SIZE);
  const name = fabricatedSlotName(slot).padEnd(14, ' ');
  for (let j = 0; j < 14; j++) e[j] = name.charCodeAt(j);
  e[14] = 0xff;
  e[15] = 1;
  return e;
}
