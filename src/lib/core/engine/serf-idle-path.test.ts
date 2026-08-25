import { describe, it, expect } from 'vitest';
import { dispatchSerf } from './serf-machine.js';
import { mapGeometry, posOf } from './position.js';
import { Rng } from './rng.js';
import type { GameState, Serf, Flag, Tile } from './state.js';

/**
 * IdleOnPath (66, @0x16546) and WaitIdleOnPath (67, @0x165df): with a pickup scheduled on the road
 * segment (`flag.scheduled`) the resting transporter wakes up and becomes Transporting (3). Neither
 * handler has a tick prologue.
 */
const geo = mapGeometry(3);

function tile(over: Partial<Tile> = {}): Tile {
  return { height: 0, terrainUp: 8, terrainDown: 8, object: 0, owner: 0, paths: 0, mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0, ...over } as unknown as Tile;
}
function flag(over: Partial<Flag> = {}): Flag {
  return {
    index: 1,
    scheduled: [false, false, false, false, false, false],
    scheduledSlot: [0, 0, 0, 0, 0, 0],
    otherEndDir: [0, 0, 0, 0, 0, 0],
    connections: [null, null, null, null, null, null],
    length: [0, 0, 0, 0, 0, 0],
    resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
    ...over,
  } as unknown as Flag;
}
function makeState(flags: (Flag | null)[]): GameState {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  return {
    geo,
    gameTick: 1000,
    mapTiles,
    serfs: [null] as (Serf | null)[],
    buildings: [null] as unknown,
    flags,
    players: [null, null, null, null] as unknown,
    rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number }): Serf {
  return {
    state: 66,
    counter: 500,
    tick: 1000,
    animation: 0,
    owner: 0,
    type: 0, // Transporter
    col: 20,
    row: 20,
    stateData: [0, 0, 0, 0, 0],
    ...over,
  } as unknown as Serf;
}

// field_0xc als u32 = flagIndex·70
function flagOffBytes(flagIdx: number): [number, number, number, number] {
  const off = flagIdx * 70;
  return [off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, (off >> 24) & 0xff];
}

describe('IdleOnPath (66) — Weck-Logik', () => {
  it('scheduled[rev] gesetzt → aufwachen zu Transporting (3), field_0xe = tick_low+6', () => {
    const f = flag({ index: 1, scheduled: [false, true, false, false, false, false] }); // rev=1 eingeplant
    const state = makeState([null, f]);
    const [c0, c1, c2, c3] = flagOffBytes(1);
    // rev=1 (field_0xb), field_0xc/u32 = 1*70, tick_low = 251 (=-5) → came = -5+6 = 1
    const serf = mkSerf({ index: 1, tick: (5 << 8) | 251, stateData: [1, c0, c1, c2, c3] });
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].serfIndex = 0; // Kachel frei
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(3); // Transporting
    expect(serf.stateData[3]).toBe(1); // field_0xe = came = -5+6
    expect(serf.stateData[0]).toBe(0); // field_0xb = 0 (leer)
    expect(state.mapTiles[pos].serfIndex).toBe(1); // Kachel geclaimt
    expect(serf.counter).toBe(0);
  });

  it('nichts eingeplant → weiter ruhen (bleibt 66)', () => {
    const f = flag({ index: 1 });
    const state = makeState([null, f]);
    const [c0, c1, c2, c3] = flagOffBytes(1);
    const serf = mkSerf({ index: 1, tick: 251, stateData: [1, c0, c1, c2, c3] });
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(66);
  });

  it('anderes Segment-Ende eingeplant → aufwachen, came = oppositeDir(rev)', () => {
    // Home flag 1, rev=1, connected via conn[1] to flag 2 (otherEndDir[1]=4); scheduled[4] is set there.
    const other = flag({ index: 2, scheduled: [false, false, false, false, true, false] });
    const home = flag({
      index: 1,
      otherEndDir: [0, 4, 0, 0, 0, 0],
      connections: [null, { kind: 'flag', index: 2 }, null, null, null, null] as unknown as Flag['connections'],
    });
    const state = makeState([null, home, other]);
    const [c0, c1, c2, c3] = flagOffBytes(1);
    const serf = mkSerf({ index: 1, tick: 100, stateData: [1, c0, c1, c2, c3] });
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(3);
    expect(serf.stateData[3]).toBe((1 - 3 + 6) & 0xff); // rev<3 → rev-3+6 = 4 = oppositeDir(1)
  });

  it('occupied tile -> becomes WaitIdleOnPath (67), not Transporting', () => {
    const f = flag({ index: 1, scheduled: [false, true, false, false, false, false] });
    const state = makeState([null, f]);
    const [c0, c1, c2, c3] = flagOffBytes(1);
    const serf = mkSerf({ index: 1, tick: 251, stateData: [1, c0, c1, c2, c3] });
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].serfIndex = 99; // belegt
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(67);
    expect(state.mapTiles[pos].serfIndex).toBe(99); // not overwritten
  });
});

describe('WaitIdleOnPath (67)', () => {
  it('Kachel frei → Transporting (3)', () => {
    const state = makeState([null, flag()]);
    const serf = mkSerf({ index: 1, state: 67, stateData: [1, 0, 0, 0, 0] });
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].serfIndex = 0;
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(3);
    expect(state.mapTiles[pos].serfIndex).toBe(1);
  });
  it('Kachel belegt → bleibt 67', () => {
    const state = makeState([null, flag()]);
    const serf = mkSerf({ index: 1, state: 67, stateData: [1, 0, 0, 0, 0] });
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].serfIndex = 99;
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(67);
  });
});
