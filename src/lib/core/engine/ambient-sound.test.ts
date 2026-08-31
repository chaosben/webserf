import { describe, it, expect } from 'vitest';
import { viewportAmbientAudio, createAmbientState } from './ambient-sound.js';
import { Rng } from './rng.js';
import type { GameState } from './state.js';

/**
 * Ambient sounds (`viewport_ambient_audio` @0xef29) - the logic only.
 */

/** Minimal state: the pass only touches `rng` and `ambient`. */
function ctx(seed: [number, number, number] = [1, 2, 3]): GameState {
  return { rng: new Rng(seed), ambient: createAmbientState() } as unknown as GameState;
}

describe('ambient-sound: random draw', () => {
  it('draws even when nothing is visible', () => {
    const st = ctx();
    const before = st.rng.getState().join(',');
    viewportAmbientAudio(st);
    expect(st.rng.getState().join(',')).not.toBe(before);
  });

  it('the stream does NOT depend on the visibility counters', () => {
    // This is what keeps the game state identical when running headless.
    const a = ctx();
    const b = ctx();
    b.ambient.treeObjects = 900;
    b.ambient.waterTiles = 400;
    for (let i = 0; i < 25; i++) {
      viewportAmbientAudio(a);
      viewportAmbientAudio(b);
    }
    expect(a.rng.getState()).toEqual(b.rng.getState());
  });

  it('discards the result of the preceding pass', () => {
    const st = ctx();
    st.ambient.treeObjects = 0x3ff;
    let sawSound = false;
    for (let i = 0; i < 50 && !sawSound; i++) {
      viewportAmbientAudio(st);
      sawSound = st.ambient.sound !== null;
    }
    expect(sawSound).toBe(true);
    st.ambient.treeObjects = 0; // no trees visible any more
    viewportAmbientAudio(st);
    expect(st.ambient.sound).toBeNull();
  });
});

describe('ambient-sound: bird branch', () => {
  it('stays silent without visible trees', () => {
    const st = ctx();
    for (let i = 0; i < 200; i++) {
      viewportAmbientAudio(st);
      expect(st.ambient.sound).toBeNull();
    }
  });

  it('only yields sounds from the four-sound bank 0x46/0x4a/0x4e/0x52', () => {
    const st = ctx();
    st.ambient.treeObjects = 0x3ff;
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      viewportAmbientAudio(st);
      if (st.ambient.sound !== null) seen.add(st.ambient.sound);
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([0x46, 0x4a, 0x4e, 0x52]);
  });

  it('chirps more often the more trees are visible', () => {
    const rate = (trees: number): number => {
      const st = ctx();
      st.ambient.treeObjects = trees;
      let n = 0;
      for (let i = 0; i < 1500; i++) {
        viewportAmbientAudio(st);
        if (st.ambient.sound !== null) n++;
      }
      return n;
    };
    expect(rate(32)).toBeLessThan(rate(600));
  });
});

describe('ambient-sound: water and wind', () => {
  it('water volume is min(n>>3, 0x14) + 2', () => {
    const vol = (tiles: number): number | null => {
      const st = ctx();
      st.ambient.waterTiles = tiles;
      for (let i = 0; i < 300; i++) {
        viewportAmbientAudio(st);
        if (st.ambient.waterVolume !== null) return st.ambient.waterVolume;
      }
      return null;
    };
    expect(vol(8)).toBe(3);
    expect(vol(80)).toBe(12);
    expect(vol(9999)).toBe(0x16); // clamped: 0x14 + 2
  });

  it('without visible water the water volume stays unset', () => {
    const st = ctx();
    for (let i = 0; i < 200; i++) {
      viewportAmbientAudio(st);
      expect(st.ambient.waterVolume).toBeNull();
    }
  });

  it('wind has no counter and yields volume 2 or 3', () => {
    const st = ctx();
    const seen = new Set<number>();
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
      viewportAmbientAudio(st);
      if (st.ambient.windVolume !== null) {
        hits++;
        seen.add(st.ambient.windVolume);
      }
    }
    expect(hits).toBeGreaterThan(0);
    expect([...seen].sort()).toEqual([2, 3]);
  });

  it('neither water nor wind enqueues a sound', () => {
  // The original calls NO `enqueue_sound_priority` in either branch - only the birds are audible.
    const st = ctx();
    st.ambient.waterTiles = 2000;
    st.ambient.treeObjects = 0; // birds off
    for (let i = 0; i < 500; i++) {
      viewportAmbientAudio(st);
      expect(st.ambient.sound).toBeNull();
    }
  });
});
