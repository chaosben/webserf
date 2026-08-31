import { describe, it, expect } from 'vitest';
import { samplingGeoSpot, lookingForGeoSpot } from './serf-geologist.js';
import { mapGeometry, posOf } from './position.js';
import { Rng } from './rng.js';
import type { GameState, Serf, Tile } from './state.js';

const geo = mapGeometry(3);
function tile(over: Partial<Tile> = {}): Tile {
  return {
    height: 0,
    terrainUp: 8,
    terrainDown: 8,
    object: 0,
    owner: 0,
    paths: 0,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: 0,
    ...over,
  } as unknown as Tile;
}
/** Four player slots as in a real save: the find is reported to the owner (@0x19005). */
function players() {
  return Array.from({ length: 4 }, () => ({
    flags: 0,
    messageTypes: [] as number[],
    messagePositions: [] as number[],
  }));
}
function makeState(fill: (t: Tile) => Tile = (t) => t): GameState {
  const mapTiles = Array.from({ length: geo.tileCount }, () => fill(tile()));
  return {
    geo,
    gameTick: 1000,
    mapTiles,
    players: players(),
    serfs: [] as (Serf | null)[],
    rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number; type: number }): Serf {
  return {
    counter: 0,
    tick: 0,
    animation: 0,
    state: 43,
    col: 20,
    row: 20,
    owner: 0,
    stateData: [0, 0, 0, 0, 0],
    ...over,
  } as unknown as Serf;
}

describe('serf-geologist — SamplingGeoSpot (43)', () => {
  it('large iron deposit -> sign 0x72 set, sampling animation, then FreeWalking back', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ mineral: 2, resourceAmount: 15 }); // iron, large (12 or more)
    const serf = mkSerf({ index: 5, type: 20, stateData: [0, 0, 0, 0, 0] }); // neg_dist1=0

    samplingGeoSpot(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x72);
    expect(serf.animation).toBe(0x8e);
    expect(serf.state).toBe(16); // FreeWalking (way back)
    expect((serf.stateData[2] << 24) >> 24).toBe(-128); // neg_dist1 = −128
  });

  it('small coal deposit (<12) → sign variant 0x75', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ mineral: 3, resourceAmount: 5 }); // coal, small
    const serf = mkSerf({ index: 5, type: 20, stateData: [0, 0, 0, 0, 0] });

    samplingGeoSpot(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x75);
  });

  /**
   * The find is reported (`call 0x18234` @0x19005); type = `12 + ((sign - 0x70) >> 1)`.
   */
  it('reports the find to the owner - type 12..15 per mineral, position = the tile', () => {
    // All four minerals, both size variants: the size must NOT change the type.
    for (const [mineral, amount, expectedType] of [
      [1, 15, 12], // gold, large
      [1, 5, 12], // gold, small  → the same type
      [2, 11, 13], // iron, small (sign 0x73 == 115)
      [3, 20, 14], // coal
      [4, 3, 15], // stone
    ] as const) {
      const state = makeState();
      const pos = posOf(20, 20, geo);
      state.mapTiles[pos] = tile({ mineral, resourceAmount: amount });
      const serf = mkSerf({ index: 5, type: 20, owner: 1, stateData: [0, 0, 0, 0, 0] });

      samplingGeoSpot(state, serf);

      const p = state.players[1]!;
      expect(p.messageTypes, `mineral ${mineral}/${amount}`).toEqual([expectedType]);
      expect(p.messagePositions).toEqual([pos]);
      expect(p.flags & 0x08).toBe(0x08); // wake-up flag "new message"
      // The owner gets it, nobody else.
      expect(state.players[0]!.messageTypes).toEqual([]);
    }
  });

  it('does NOT report when a sign of the same kind is already nearby', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ mineral: 2, resourceAmount: 15 });
    // An iron sign on the first spiral neighbour (equal under `&0x7e` => duplicate).
    state.mapTiles[posOf(21, 20, geo)] = tile({ object: 0x73 });
    const serf = mkSerf({ index: 5, type: 20, stateData: [0, 0, 0, 0, 0] });

    samplingGeoSpot(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x72); // the sign is set anyway
    expect(state.players[0]!.messageTypes).toEqual([]); // but no message
  });

  it('no mineral -> the nothing-found sign 0x78, then back', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    const serf = mkSerf({ index: 5, type: 20, stateData: [0, 0, 0, 0, 0] });

    samplingGeoSpot(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x78);
    expect(serf.state).toBe(16);
    expect((serf.stateData[2] << 24) >> 24).toBe(-128);
  });

  it('tick not elapsed -> no-op (the counter only counts down)', () => {
    const state = makeState();
    const serf = mkSerf({ index: 5, type: 20, tick: 900, counter: 5000, stateData: [0, 0, 0, 0, 0] });
    samplingGeoSpot(state, serf); // delta=100 < counter 5000 -> not elapsed
    expect(serf.state).toBe(43); // unchanged
    expect(serf.counter).toBe(4900);
  });
});

describe('serf-geologist — LookingForGeoSpot (42)', () => {
  it('mountains all around -> spot found -> FreeWalking with mirrored neg_dist', () => {
    const state = makeState((t) => {
      t.terrainUp = 12; // tundra (mountains)
      t.terrainDown = 12;
      return t;
    });
    const serf = mkSerf({ index: 5, type: 20, state: 42, stateData: [0, 0, 0, 0, 0] });

    lookingForGeoSpot(state, serf);

    expect(serf.state).toBe(16); // FreeWalking to the spot
    // neg_dist1 = −dist_col, neg_dist2 = −dist_row (normalised against -0).
    const distCol = (serf.stateData[0] << 24) >> 24;
    const distRow = (serf.stateData[1] << 24) >> 24;
    expect((serf.stateData[2] << 24) >> 24).toBe(-distCol + 0);
    expect((serf.stateData[3] << 24) >> 24).toBe(-distRow + 0);
    // Some spot other than the centre must have been chosen at all.
    expect(distCol !== 0 || distRow !== 0).toBe(true);
  });

  it('no mountains -> back into the network after 8 attempts (Walking, dir1=-2)', () => {
    const state = makeState(); // all grass
    const serf = mkSerf({ index: 5, type: 20, state: 42, stateData: [0, 0, 0, 0, 0] });

    lookingForGeoSpot(state, serf);

    expect(serf.state).toBe(2); // Walking
    expect((serf.stateData[0] << 24) >> 24).toBe(-2); // dir1 = −2
  });

  it('two existing signs -> area explored -> back into the network', () => {
    const state = makeState((t) => {
      t.object = 0x72; // mineral signs everywhere
      return t;
    });
    const serf = mkSerf({ index: 5, type: 20, state: 42, stateData: [0, 0, 0, 0, 0] });

    lookingForGeoSpot(state, serf);

    expect(serf.state).toBe(2); // Walking (aborted after 2 signs)
    expect((serf.stateData[0] << 24) >> 24).toBe(-2);
  });
});
