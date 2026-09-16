/**
 * THE PERMISSION QUESTION of the folder layer (`views/save-directory.ts`).
 *
 * What is checked is what can be checked in Node and still carries: the distinction
 * `granted` / `denied` / `blocked`. It is the reason the question may hang off the first user
 * gesture without the caller having to know which event types carry one — and without a "no"
 * turning into dialog spam.
 *
 * `grantSaveDirectory` takes its handle as `unknown` and validates it itself, so a stub object is
 * enough. The rest of the module (`showDirectoryPicker`, writing) hangs off browser edges that do
 * not exist here — deliberately not rebuilt, otherwise the test would check its own stub.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { grantSaveDirectory, restoreSaveDirectory, saveDirectoryUsable } from './save-directory.js';

const ROOT = new URL('../../..', import.meta.url).pathname; // app/
const read = (path: string): string => readFileSync(ROOT + path, 'utf8');

/** A handle that looks like a `FileSystemDirectoryHandle` — as far as the module looks. */
function handle(answer: 'granted' | 'denied' | 'throw'): unknown {
  return {
    name: 'SIEDLER',
    getFileHandle: () => Promise.reject(new Error('not used')),
    queryPermission: () => Promise.resolve('prompt' as PermissionState),
    requestPermission: () =>
      answer === 'throw'
        ? Promise.reject(new DOMException('no user activation', 'SecurityError'))
        : Promise.resolve(answer as PermissionState),
  };
}

describe('grantSaveDirectory', () => {
  it('returns the folder with its name once permission is granted', async () => {
    const grant = await grantSaveDirectory(handle('granted'));
    expect(grant.kind).toBe('granted');
    if (grant.kind !== 'granted') return;
    expect(grant.dir.label).toBe('SIEDLER');
  });

  it('separates the user saying NO from the QUESTION being refused', async () => {
    // `denied` == the user refused: do not ask again during this session.
    expect((await grantSaveDirectory(handle('denied'))).kind).toBe('denied');
    // `blocked` == the browser refused the question (no user gesture): nothing was asked at all,
    // so a later attempt is right. If this collapsed into `denied`, the first-gesture renewal
    // would give up forever after one gesture that did not count.
    expect((await grantSaveDirectory(handle('throw'))).kind).toBe('blocked');
  });

  it('treats an unusable handle as NO, not as try-again-later', async () => {
    // No handle, or an environment without `requestPermission`: a second attempt changes nothing,
    // so this must not yield `blocked` — otherwise the renewal would ask on every gesture.
    expect((await grantSaveDirectory(null)).kind).toBe('denied');
    expect((await grantSaveDirectory({ name: 'x' })).kind).toBe('denied');
  });
});

/** A handle whose `getFileHandle` fails with a given `DOMException` name. */
function readingHandle(failure: string): unknown {
  return {
    name: 'SIEDLER',
    getFileHandle: () => Promise.reject(new DOMException('no', failure)),
    queryPermission: () => Promise.resolve('granted' as PermissionState),
    requestPermission: () => Promise.resolve('granted' as PermissionState),
  };
}

describe('reading through a granted folder', () => {
  it('reports a missing file as an empty slot', async () => {
    const dir = await restoreSaveDirectory(readingHandle('NotFoundError'));
    expect(dir).not.toBeNull();
    expect(await dir!.readFile('SAVE0.DS')).toBeNull();
  });

  it('lets a withdrawn permission through instead of swallowing it', async () => {
    // Swallowing it would be worse than throwing: EVERY read fails at once, the folder looks empty,
    // and an empty folder is an instruction to write every occupied slot into it.
    const dir = await restoreSaveDirectory(readingHandle('NotAllowedError'));
    expect(dir).not.toBeNull();
    await expect(dir!.readFile('SAVE0.DS')).rejects.toThrow();
  });
});

describe('saveDirectoryUsable', () => {
  it('separates "needs permission" from "cannot work at all"', () => {
    // Only the first deserves a mark; the second would mark a button with nothing to do.
    expect(saveDirectoryUsable(readingHandle('NotFoundError'))).toBe(true);
    expect(saveDirectoryUsable(null)).toBe(false);
    expect(saveDirectoryUsable({ name: 'x' })).toBe(false);
    expect(saveDirectoryUsable({ name: 'x', getFileHandle: () => {} })).toBe(false);
  });
});

/**
 * WHAT CANNOT BE DRIVEN HERE. `SaveStore` needs IndexedDB and the page needs a browser, so three
 * properties are read out of the source instead. They catch the fall back, not a new route.
 */
describe('the wiring around them', () => {
  it('keeps the permission in this one module', () => {
    // The store must not learn to ask by itself — then there would be two places deciding when a
    // dialog appears, and the session latch below would only cover one of them.
    const store = read('src/lib/core/save-store.ts');
    expect(store).not.toMatch(/queryPermission|requestPermission/);
  });

  it('asks at most once per session, and gates it where the question is asked', () => {
    // The WHOLE condition, not just the name: `saveDirAsked` stands at four places in the page, so a
    // scan for the name alone stays green while the renewal itself has lost its gate — and without
    // the gate every gesture opens a dialog.
    expect(read('src/routes/+page.svelte')).toMatch(
      /if \(handle === null \|\| store === null \|\| saveDirAsked\) return;/
    );
  });

  it('keeps that latch out of the reactive graph', () => {
    // `saveDirAsked` is READ in the effect and SET in its callback. As `$state` it would be a
    // dependency of the very effect that sets it, and the effect would re-run itself. The literal
    // form is the point: an absence check (`not.toMatch(/\$state/)`) would also pass once the
    // variable has been renamed away, and would then prove nothing.
    expect(read('src/routes/+page.svelte')).toMatch(/\blet saveDirAsked = false;/);
  });
});
