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
import { grantSaveDirectory } from './save-directory.js';

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
