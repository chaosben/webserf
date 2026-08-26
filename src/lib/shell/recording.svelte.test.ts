import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordings } from './recording.svelte.js';
import type { RecordingTarget } from '../views/screen-recorder.js';

/**
 * WATCHDOG FOR THE STILL PICTURE — and above all for its OBJECT URL.
 *
 * The picture is held by the bus, not by the panel, precisely so this is provable without a browser:
 * an object URL that nobody releases keeps a full-window PNG alive, once per opening of the panel.
 * Counting `createObjectURL` against `revokeObjectURL` is the whole point — without the counting the
 * leak would be asserted rather than checked.
 */

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let handedOut: string[] = [];
let revoked: string[] = [];

/** A canvas that yields exactly this picture — or none, as a canvas with a lost context does. */
function canvasYielding(blob: Blob | null): RecordingTarget {
  return {
    canvas: { toBlob: (cb: (b: Blob | null) => void) => cb(blob) } as unknown as HTMLCanvasElement,
  };
}

beforeEach(() => {
  handedOut = [];
  revoked = [];
  URL.createObjectURL = (): string => {
    const url = `blob:still-${handedOut.length}`;
    handedOut.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => void revoked.push(url);
});

afterEach(() => {
  // The bus is a module singleton — one case must not leave a picture behind for the next.
  recordings.clearStill();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe('still picture', () => {
  it('yields nothing while no view is mounted', async () => {
    expect(await recordings.takeStill(new Date())).toBeNull();
    expect(recordings.still).toBeNull();
    expect(handedOut).toEqual([]);
  });

  it('names the picture like a recording and reports its size', async () => {
    const stop = recordings.provide(canvasYielding(new Blob(['0123456789'])));
    const still = await recordings.takeStill(new Date(2026, 7, 25, 9, 4, 3));
    expect(still?.fileName).toBe('webserf-20260825-090403.png');
    expect(still?.bytes).toBe(10);
    expect(still?.url).toBe('blob:still-0');
    expect(recordings.still).toEqual(still);
    stop();
  });

  it('releases the previous URL when a second picture is taken', async () => {
    const stop = recordings.provide(canvasYielding(new Blob(['x'])));
    await recordings.takeStill(new Date());
    await recordings.takeStill(new Date());
    expect(handedOut).toEqual(['blob:still-0', 'blob:still-1']);
    expect(revoked).toEqual(['blob:still-0']);
    expect(recordings.still?.url).toBe('blob:still-1');
    stop();
  });

  it('releases the last URL on clearing and empties the state', async () => {
    const stop = recordings.provide(canvasYielding(new Blob(['x'])));
    await recordings.takeStill(new Date());
    recordings.clearStill();
    expect(revoked).toEqual(['blob:still-0']);
    expect(recordings.still).toBeNull();
    // Clearing twice must not release a URL a second time — the browser then complains about a URL
    // it does not know any more.
    recordings.clearStill();
    expect(revoked).toEqual(['blob:still-0']);
    stop();
  });

  it('keeps the picture it has when the canvas gives none', async () => {
    // A missing picture is better than a blank panel: the old one stays and stays announced.
    const good = recordings.provide(canvasYielding(new Blob(['x'])));
    await recordings.takeStill(new Date());
    good();
    const bad = recordings.provide(canvasYielding(null));
    expect(await recordings.takeStill(new Date())).toBeNull();
    expect(recordings.still?.url).toBe('blob:still-0');
    expect(revoked).toEqual([]);
    bad();
  });
});
