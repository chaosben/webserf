/**
 * THE FOLDER LAYER OF THE SAVE GAMES — the browser edge behind {@link SaveDirectory}.
 *
 * It uses the file-system access API (`showDirectoryPicker`), which does not exist everywhere;
 * {@link saveDirectorySupported} says so, and without it the saves stay in IndexedDB — the clone
 * then loses exactly one layer, not the ability to save.
 *
 * WHY A FOLDER AT ALL: it holds the eleven files under their original names (`ARCHIV.DS`,
 * `SAVE0..9.DS`) and in their original format. A save written that way can be copied into a DOSBox
 * directory and loaded there — the only way to check the encoder against the original, and at the
 * same time what a user expects from "save game".
 *
 * THE PERMISSION IS THE AWKWARD PART, and it has two properties one gets wrong when building this
 * for the first time: the HANDLE survives a restart (it is structured-clonable and lives in
 * IndexedDB), the PERMISSION does not always. `queryPermission` may be called at any time,
 * `requestPermission` ONLY INSIDE A USER GESTURE — a call at startup is refused. Hence this module
 * separates the two routes: {@link restoreSaveDirectory} is silent and returns `null` when asking
 * would be required; {@link pickSaveDirectory} and {@link grantSaveDirectory} need a gesture — the
 * picker a button (it is a choice), the renewal just *any* gesture (it continues a choice already
 * made, see {@link SaveDirectoryGrant}).
 */

import type { SaveDirectory } from '$lib/core/save-store.js';

/** Does this browser have the file-system access API? */
export const saveDirectorySupported = (): boolean =>
  typeof globalThis !== 'undefined' && 'showDirectoryPicker' in globalThis;

interface FsFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(d: Uint8Array<ArrayBufferLike>): Promise<void>; close(): Promise<void> }>;
}
interface FsDirHandle {
  readonly name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry?(name: string): Promise<void>;
  queryPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
}

function wrap(handle: FsDirHandle): SaveDirectory {
  return {
    label: handle.name,
    async readFile(name) {
      try {
        const fh = await handle.getFileHandle(name);
        const f = await fh.getFile();
        return { data: new Uint8Array(await f.arrayBuffer()), modifiedAt: f.lastModified };
      } catch {
        // A missing file is not an error — `NotFoundError` simply means "slot empty". The original
        // agrees: without `ARCHIV.DS` it reads ten free slots (@0x46ced).
        return null;
      }
    },
    async writeFile(name, data) {
      const fh = await handle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(data);
      await w.close();
    },
    // `removeEntry` has been part of the API from the start but is not present in every
    // environment — so the method is only passed on when the handle has it. Without it,
    // `SaveStore.remove` notices and tells the user the file stays in the folder.
    ...(typeof handle.removeEntry === 'function'
      ? {
          async removeFile(name: string) {
            // A file that is already gone is not an error — same reasoning as in `readFile`.
            try {
              await handle.removeEntry!(name);
            } catch (err) {
              if ((err as { name?: string })?.name !== 'NotFoundError') throw err;
            }
          },
        }
      : {}),
  };
}

/** Pick a folder — NEEDS A USER GESTURE. `null` == cancelled. */
export async function pickSaveDirectory(): Promise<{
  dir: SaveDirectory;
  handle: unknown;
} | null> {
  if (!saveDirectorySupported()) return null;
  try {
    const picker = (globalThis as unknown as { showDirectoryPicker(o: unknown): Promise<FsDirHandle> })
      .showDirectoryPicker;
    const handle = await picker.call(globalThis, { id: 'siedler-saves', mode: 'readwrite' });
    return { dir: wrap(handle), handle };
  } catch {
    return null; // cancelling the dialog is an `AbortError`, not a failure.
  }
}

/**
 * Revive a stored handle SILENTLY. Returns `null` when the permission does not (or no longer)
 * hold — then {@link grantSaveDirectory} has to hang off a button, not off this.
 */
export async function restoreSaveDirectory(handle: unknown): Promise<SaveDirectory | null> {
  const h = handle as FsDirHandle | null;
  if (!h || typeof h.getFileHandle !== 'function') return null;
  if (typeof h.queryPermission === 'function') {
    const state = await h.queryPermission({ mode: 'readwrite' });
    if (state !== 'granted') return null;
  }
  return wrap(h);
}

/**
 * How a permission request ended.
 *
 * THE DISTINCTION `denied` ↔ `blocked` IS THE POINT OF THIS TYPE, and it is not cosmetic: `denied`
 * means "the USER said no" — then nothing more may be asked during this session. `blocked` means
 * "the BROWSER refused the question", in practice always because no user gesture was active
 * (`requestPermission` requires one); then nothing was asked at all and a later attempt is right
 * rather than annoying.
 *
 * A caller that does not separate the two has only bad options: keep asking after a no (dialog
 * spam), or give up after a missed gesture window. That is also why the caller does not need to
 * know WHICH event types carry a gesture — with `blocked` it can simply try again.
 */
export type SaveDirectoryGrant =
  | { readonly kind: 'granted'; readonly dir: SaveDirectory }
  | { readonly kind: 'denied' }
  | { readonly kind: 'blocked' };

/**
 * Renew the permission for a stored handle — NEEDS A USER GESTURE.
 *
 * This is also the only place where a browser can show its three-way dialog including "allow on
 * every visit": it only appears on `requestPermission` for a STORED handle, i.e. from the second
 * visit on. On the first pick ({@link pickSaveDirectory}) it structurally cannot appear, and it
 * cannot be requested either — the API has no field for it.
 */
export async function grantSaveDirectory(handle: unknown): Promise<SaveDirectoryGrant> {
  const h = handle as FsDirHandle | null;
  // No handle, or an environment without `requestPermission`: there is nothing to ask here, and a
  // second attempt would not change that — so `denied`, not `blocked`.
  if (!h || typeof h.requestPermission !== 'function') return { kind: 'denied' };
  let state: PermissionState;
  try {
    state = await h.requestPermission({ mode: 'readwrite' });
  } catch {
    return { kind: 'blocked' };
  }
  return state === 'granted' ? { kind: 'granted', dir: wrap(h) } : { kind: 'denied' };
}
