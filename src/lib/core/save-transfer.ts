/**
 * **Moving save games in and out** — the part of import/export that needs no store.
 *
 * There are two ways in and out, with different purposes:
 *
 * 1. **A single slot** as `SAVEn.DS` — the file DOSBox reads too: download it, drop it into a game
 *    directory, load it in the original. And back the other way.
 * 2. **The whole bundle** as a ZIP with exactly the eleven original files (`ARCHIV.DS` +
 *    `SAVE0..9.DS`), for moving to another machine or browser.
 *
 * **The name is the real problem.** A `.DS` file does **not** carry its name — it lives in
 * `ARCHIV.DS`, separate from the data. So importing a single save has no name, and
 * {@link slotNameFromFileName} derives one from the file name; whoever downloaded it before gets
 * their name back as long as they did not rename the file.
 *
 * **Two deliberate decisions in that derivation:**
 *
 * - **Only characters the original's font can draw.** The font bank has 44 glyphs (`GLYPH_ORDER` in
 *   `ui-render.ts`): `A-Z`, `AOU` umlauts, `0-9`, `.` `-` `:` `?` `%` — no space, which only feeds.
 *   Anything else would show as a gap in the disk menu.
 * - **Umlauts are transliterated anyway** (`Ae` -> `AE`), although glyphs exist for them: which
 *   **byte** the original's keyboard input writes for them is not verified — the font order only says
 *   a glyph exists, not which code points at it (the DOS character set is not Latin-1). A guessed byte
 *   would sit permanently in a file the original also reads; transliteration costs nothing.
 */

import { ARCHIV_SLOT_COUNT, ARCHIV_SLOT_SIZE } from './archiv-parser.js';
import { parseSaveGame } from './save-parser.js';
import {
  ARCHIV_FILE_NAME,
  archivEntry,
  fabricatedSlotName,
  saveFileName,
  type SaveSlotRecord,
} from './save-slots.js';
import { buildZip, readZip, type ZipEntry } from './zip.js';

/** Length of an index entry's name field (14 bytes). */
const NAME_LENGTH = 14;

/** Suggested file name of the bundle. */
export const SAVE_PACKAGE_FILE_NAME = 'siedler-saves.zip';

/** Characters the original's font has a glyph for — umlauts excluded, see module head. */
const DRAWABLE = /[A-Z0-9.\-:?% ]/;

/** What `String.prototype.toUpperCase` does not handle: the German special characters. */
const TRANSLITERATE: Readonly<Record<string, string>> = {
  Ä: 'AE',
  Ö: 'OE',
  Ü: 'UE',
  ß: 'SS',
  ẞ: 'SS',
};

/**
 * Derives a slot name from a file name: path and extension off, upper case, reduced to the drawable
 * characters, cut to 14 places. The result is **unpadded** and may be empty — {@link namedArchivEntry}
 * decides what applies then.
 */
export function slotNameFromFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // Only strip the extension when something precedes it -- `.DS` alone would end up empty.
  const stem = dot > 0 ? base.slice(0, dot) : base;
  let out = '';
  for (const ch of stem.toUpperCase()) {
    const mapped = TRANSLITERATE[ch] ?? ch;
    for (const m of mapped) out += DRAWABLE.test(m) ? m : ' ';
  }
  // Collapse runs of spaces: each costs one of the 14 places and shows nothing.
  return out.replace(/ {2,}/g, ' ').trim().slice(0, NAME_LENGTH);
}

/**
 * An index entry with this name and the used flag set. An empty name becomes
 * {@link fabricatedSlotName} — the same fallback the directory layer uses for a file without an index
 * entry, so there are not two different ones.
 */
export function namedArchivEntry(name: string, slot: number): Uint8Array {
  const text = (name.trim() === '' ? fabricatedSlotName(slot) : name)
    .slice(0, NAME_LENGTH)
    .padEnd(NAME_LENGTH, ' ');
  const e = new Uint8Array(ARCHIV_SLOT_SIZE);
  for (let j = 0; j < NAME_LENGTH; j++) e[j] = text.charCodeAt(j) & 0xff;
  e[14] = 0xff;
  e[15] = 1;
  return e;
}

/**
 * Checks whether these bytes are a loadable save. Returns the error **message** or `null` on success —
 * the parser checks its layout sum against the file size, so this is more than a look at the first
 * bytes.
 */
export function saveGameRejection(data: Uint8Array): string | null {
  try {
    parseSaveGame(data);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Builds the bundle: the index plus every occupied `SAVEn.DS`. The index comes **along** because
 * without it the names would be lost — it is the only place they live.
 */
export function buildSavePackage(index: Uint8Array, slots: readonly SaveSlotRecord[]): Uint8Array {
  const entries: ZipEntry[] = [{ name: ARCHIV_FILE_NAME, data: index, modifiedAt: 0 }];
  for (const s of slots) {
    if (s.data === null) continue;
    entries.push({ name: saveFileName(s.index), data: s.data, modifiedAt: s.savedAt });
  }
  return buildZip(entries);
}

/** A read bundle: the slots it held plus what was left over (for display only). */
export interface SavePackage {
  readonly slots: readonly SaveSlotRecord[];
  /** Was an `ARCHIV.DS` included? Without it the names are fabricated. */
  readonly hadIndex: boolean;
  /** Files in the bundle that are not a slot — ignored, but named. */
  readonly ignored: readonly string[];
}

/**
 * Reads a bundle. Throws `ZipError` on a broken archive; **individual** unreadable saves do not throw
 * — they are missing from `slots` and listed in `ignored`, because a bundle of ten should not fail on
 * one.
 *
 * File names are matched **case and path insensitively**: some packers put everything into a
 * subdirectory, and DOS tools like lower case.
 */
export async function readSavePackage(bytes: Uint8Array): Promise<SavePackage> {
  const files = await readZip(bytes);
  const byName = new Map<string, ZipEntry>();
  const ignored: string[] = [];
  for (const f of files) {
    const base = (f.name.split(/[/\\]/).pop() ?? '').toUpperCase();
    if (base === ARCHIV_FILE_NAME || /^SAVE[0-9]\.DS$/.test(base)) byName.set(base, f);
    else ignored.push(f.name);
  }
  const index = byName.get(ARCHIV_FILE_NAME);
  const hadIndex =
    index !== undefined && index.data.length === ARCHIV_SLOT_COUNT * ARCHIV_SLOT_SIZE;
  const slots: SaveSlotRecord[] = [];
  for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
    const f = byName.get(saveFileName(i));
    if (f === undefined) continue;
    if (saveGameRejection(f.data) !== null) {
      ignored.push(f.name);
      continue;
    }
    // The bundle's index may list a slot as free whose file came along. The file wins -- as in the
    // directory layer, where an existing file is the proof.
    const entry = hadIndex ? archivEntry(index!.data, i) : namedArchivEntry('', i);
    if ((entry[15] ?? 0) === 0) entry[15] = 1;
    slots.push({ index: i, entry, data: f.data, savedAt: f.modifiedAt });
  }
  return { slots, hadIndex, ignored };
}
