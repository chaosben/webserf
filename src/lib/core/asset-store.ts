import { openDB, type IDBPDatabase } from 'idb';

/**
 * IndexedDB cache for the archive that was loaded last.
 *
 * Schema: one object store `archives` with the fixed slot key `'current'`, so the content comes back
 * on the next reload without another file picker.
 *
 * Stores the RAW bytes (ArrayBuffer), not the parsed `PaArchive` — that keeps the cache stable
 * across parser changes.
 */

const DB_NAME = 'siedler-asset-viewer';
const ARCHIVE_STORE = 'archives';
const SLOT_KEY = 'current';
const VERSION = 2;

export interface CachedArchive {
  /** Originaler Dateiname (z.B. `SPAD.PA`). */
  readonly name: string;
  /** Raw bytes of the file. */
  readonly data: ArrayBuffer;
  /** Unix timestamp of the cache write. */
  readonly cachedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    // DB version 2: an earlier iteration had a 'soundfonts' store, now obsolete. It is left
    // untouched by the upgrade, because removing it would need another version bump to carry the
    // migration; until then it sits there empty.
    dbPromise = openDB(DB_NAME, VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
          db.createObjectStore(ARCHIVE_STORE);
        }
      },
    });
  }
  return dbPromise;
}

/** Stores an archive in the cache, overwriting the previous entry. */
export async function cacheArchive(name: string, data: ArrayBuffer): Promise<void> {
  const db = await getDB();
  const entry: CachedArchive = { name, data, cachedAt: Date.now() };
  await db.put(ARCHIVE_STORE, entry, SLOT_KEY);
}

/** Returns the archive cached last, or `null` when there is none. */
export async function getCachedArchive(): Promise<CachedArchive | null> {
  const db = await getDB();
  const entry = (await db.get(ARCHIVE_STORE, SLOT_KEY)) as CachedArchive | undefined;
  return entry ?? null;
}

/** Clears the archive cache. */
export async function clearCachedArchive(): Promise<void> {
  const db = await getDB();
  await db.delete(ARCHIVE_STORE, SLOT_KEY);
}
