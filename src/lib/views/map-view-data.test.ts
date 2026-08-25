import { describe, expect, it } from 'vitest';
import { buildOptionsView, engineEntityIndex } from './map-view-data.js';
import { buildEntityIndex } from '../core/entity-layer.js';
import { snapshot, type Serf } from '../core/engine/state.js';
import type { GameState } from '../core/engine/state.js';

describe('buildOptionsView', () => {
  it('passes the save-game control options through, with the interface values beside them', () => {
    const state = { header: { viewOptions: [0x3d, 0x39] } } as unknown as GameState;
    expect(buildOptionsView(state, { volume: 40, music: false, sfx: true })).toEqual({
      viewOptions: [0x3d, 0x39],
      volume: 40,
      music: false,
      sfx: true,
    });
  });
});

describe('engineEntityIndex', () => {
  /** Minimal live state: three sparsely filled slot arrays, the way `loadState` builds them. */
  function state(): GameState {
    const serf = (index: number): Serf =>
      ({ index, type: 0, state: 0, stateData: [0, 0, 0, 0, 0] }) as unknown as Serf;
    return {
      // Slot 0 is the reserved null slot, slot 2 a gap — exactly the situation an index by
      // `.index` exists for in the first place.
      serfs: [null, serf(1), null, serf(3)],
      flags: [null, { index: 1 }, null],
      buildings: [null, null, { index: 2 }],
      inventories: [],
      players: [],
      mapTiles: [],
      header: {},
      gameTick: 0,
      rng: { getState: () => [0, 0, 0] },
      blockMeta: {
        serfs: { recordSize: 16, maxIndex: 4 },
        flags: { recordSize: 70, maxIndex: 3 },
        buildings: { recordSize: 18, maxIndex: 3 },
        inventories: { recordSize: 120, maxIndex: 0 },
      },
    } as unknown as GameState;
  }

  it('returns the same record per slot index as an index built over the snapshot', () => {
    const st = state();
    const dense = engineEntityIndex(st);
    const built = buildEntityIndex(snapshot(st));
    for (let i = 0; i < 5; i++) {
      expect(dense.serf.get(i)).toBe(built.serf.get(i));
      expect(dense.flag.get(i)).toBe(built.flag.get(i));
      expect(dense.building.get(i)).toBe(built.building.get(i));
    }
    // And the gaps are gaps, not `null` — the draw pass checks for `undefined`.
    expect(dense.serf.get(2)).toBeUndefined();
  });

  it('sees a newly filled slot without a rebuild — that is the point', () => {
    const st = state();
    const dense = engineEntityIndex(st);
    expect(dense.serf.get(4)).toBeUndefined();
    st.serfs[4] = { index: 4, type: 0, state: 0, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
    expect(dense.serf.get(4)?.index).toBe(4);
  });
});
