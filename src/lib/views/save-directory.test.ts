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
import {
  grantSaveDirectory,
  mayRenewOnGesture,
  restoreSaveDirectory,
  SAVE_DIR_LAPSE_LIMIT,
  saveDirectoryUsable,
} from './save-directory.js';

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
    // Only the first deserves a count and a mark; the second would mark a button with nothing to do.
    expect(saveDirectoryUsable(readingHandle('NotFoundError'))).toBe(true);
    expect(saveDirectoryUsable(null)).toBe(false);
    expect(saveDirectoryUsable({ name: 'x' })).toBe(false);
    expect(saveDirectoryUsable({ name: 'x', getFileHandle: () => {} })).toBe(false);
  });
});

describe('mayRenewOnGesture', () => {
  it('allows exactly one lapse to be answered by itself', () => {
    // The three-way dialog including "allow on every visit" cannot appear on the first pick — it
    // hangs off `requestPermission` for a STORED handle. Asking after the first lapse is therefore
    // the only route to a permanent grant, and a limit of one would withhold it.
    expect(mayRenewOnGesture(0)).toBe(true);
    expect(mayRenewOnGesture(1)).toBe(true);
    expect(mayRenewOnGesture(SAVE_DIR_LAPSE_LIMIT)).toBe(false);
    expect(mayRenewOnGesture(SAVE_DIR_LAPSE_LIMIT + 7)).toBe(false);
  });

  it('asks twice where the permission never survives, and not again', () => {
    // Walk the starts of a browser that hands the permission back every time. Counting is what
    // `openSaves` does: clamp at the limit, and only a `granted` AT STARTUP clears it.
    let lapses = 0;
    const asked: number[] = [];
    for (let start = 1; start <= 6; start++) {
      if (mayRenewOnGesture(lapses)) asked.push(start);
      lapses = Math.min(lapses + 1, SAVE_DIR_LAPSE_LIMIT);
    }
    expect(asked).toEqual([1, 2]);
  });

  it('forgets what it learned as soon as one start comes back granted', () => {
    let lapses = SAVE_DIR_LAPSE_LIMIT;
    expect(mayRenewOnGesture(lapses)).toBe(false);
    lapses = 0; // a start that found the permission still in place
    expect(mayRenewOnGesture(lapses)).toBe(true);
  });
});

/**
 * WHAT CANNOT BE DRIVEN HERE. `SaveStore` needs IndexedDB and the page needs a browser, so three
 * properties are read out of the source instead. They catch the fall back, not a new route.
 */
describe('the wiring around them', () => {
  it('keeps the permission in this one module', () => {
    // The store must not learn to ask by itself — then there would be two places deciding when a
    // dialog appears, and the count would only see one of them.
    const store = read('src/lib/core/save-store.ts');
    expect(store).not.toMatch(/queryPermission|requestPermission/);
  });

  it('drops the lapse count together with the folder', () => {
    // A newly picked folder must not inherit the history of the old one.
    const store = read('src/lib/core/save-store.ts');
    const body = store.slice(store.indexOf('async detachDirectory'));
    const end = body.indexOf('\n  }');
    expect(body.slice(0, end)).toMatch(/DIR_HANDLE_KEY[\s\S]*DIR_LAPSES_KEY/);
  });

  it('gates the gesture renewal on the count', () => {
    // The whole condition, not just the name: the panel names the rule as well, and a scan for the
    // name alone stays green while the renewal itself has lost its gate.
    expect(read('src/routes/+page.svelte')).toMatch(
      /saveDirAsked \|\| !mayRenewOnGesture\(lapses\)/
    );
  });
});
