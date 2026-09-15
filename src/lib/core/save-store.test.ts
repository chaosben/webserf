/**
 * THE ONE DECISION OF THE SAVE STORE THAT CAN BE CHECKED WITHOUT A BROWSER.
 *
 * The store itself needs IndexedDB and is not driven here. {@link isPermissionLoss} is, because it
 * looks at nothing but the name of the error — and it carries the difference between "saving
 * failed, try again" and "the folder is gone and has to be granted again", which is what decides
 * whether the folder is let go of and the mark on the rail appears.
 */
import { describe, expect, it } from 'vitest';
import { isPermissionLoss } from './save-store.js';

describe('isPermissionLoss', () => {
  it('knows the two names a browser uses for a withdrawn grant', () => {
    expect(isPermissionLoss(new DOMException('no', 'NotAllowedError'))).toBe(true);
    expect(isPermissionLoss(new DOMException('no', 'SecurityError'))).toBe(true);
  });

  it('leaves genuine failures alone', () => {
    // A full disk or a missing file must keep its own error code — letting go of the folder there
    // would turn a passing trouble into a detached folder.
    expect(isPermissionLoss(new DOMException('gone', 'NotFoundError'))).toBe(false);
    expect(isPermissionLoss(new DOMException('full', 'QuotaExceededError'))).toBe(false);
    expect(isPermissionLoss(new Error('boom'))).toBe(false);
  });

  it('survives what a `catch` can actually hand it', () => {
    expect(isPermissionLoss(null)).toBe(false);
    expect(isPermissionLoss(undefined)).toBe(false);
    expect(isPermissionLoss('NotAllowedError')).toBe(false);
  });
});
