import { describe, it, expect } from 'vitest';
import type { GameState, Serf, Building, Tile, Inventory } from './state.js';
import { dispatchSerf, unionU16 } from './serf-machine.js';
import { mapGeometry, posOf } from './position.js';
import { Rng } from './rng.js';

/**
 * Four states that are dead ends without a handler — a serf entering one never leaves again:
 *
 * | state | who sets it |
 * |---|---|
 * | 10 BuildingCastle | `foundCastle` |
 * | 28 EscapeBuilding | holder ejection on razing |
 * | 74 FinishedBuilding | `completeBuilding` with an occupied flag tile |
 * | 73 Scatter | state 15 passes `field_0xb == -3` on through state 5; the -3 itself is only set by the
 *   unstocking branch of `idleInStock` (gate @0x1f5e4), i.e. by a warehouse set to "release serfs" |
 */

const geo = mapGeometry(3);

function tile(over: Partial<Tile> = {}): Tile {
  return {
    height: 4,
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

function baseState(over: Partial<GameState> = {}): GameState {
  return {
    geo,
    gameTick: 1000,
    mapTiles: Array.from({ length: geo.tileCount }, () => tile()),
    buildings: [null],
    inventories: [null],
    serfs: [null],
    rng: new Rng([0x0380, 0xeea7, 0x6b11]),
    ...over,
  } as unknown as GameState;
}

// ── 28 EscapeBuilding ───────────────────────────────────────────────────────────────────────────

function escapeState(tileOccupiedBy: number): { state: GameState; serf: Serf; pos: number } {
  const state = baseState();
  const pos = posOf(10, 20, geo);
  state.mapTiles[pos] = tile({ serfIndex: tileOccupiedBy });
  const serf = {
    index: 5,
    state: 28,
    col: 10,
    row: 20,
    counter: 111,
    tick: 900,
    animation: 3,
    stateData: [7, 0, 0, 0, 0],
  } as unknown as Serf;
  state.serfs[5] = serf;
  return { state, serf, pos };
}

describe('28 EscapeBuilding', () => {
  it('free tile: the serf claims it and becomes 25 Lost', () => {
    const { state, serf, pos } = escapeState(0);
    dispatchSerf(state, serf);
    expect(state.mapTiles[pos].serfIndex).toBe(5);
    expect(serf.state).toBe(25);
    expect(serf.animation).toBe(0x52);
    expect(serf.counter).toBe(0);
    expect(serf.stateData[0]).toBe(0); // field_0xb = 0 -> spiral forwards
    expect(serf.tick).toBe(1000);
  });

  it('occupied tile: nothing happens, the serf keeps waiting (no tick gate)', () => {
    const { state, serf, pos } = escapeState(9);
    dispatchSerf(state, serf);
    expect(state.mapTiles[pos].serfIndex).toBe(9);
    expect(serf.state).toBe(28);
    expect(serf.animation).toBe(3);
    expect(serf.counter).toBe(111);
    expect(serf.tick).toBe(900); // the timestamp is only set on the transition
  });

  it('several ejected serfs on the same tile get out one after another', () => {
    const { state, serf, pos } = escapeState(0);
    const second = {
      index: 6,
      state: 28,
      col: 10,
      row: 20,
      counter: 0,
      tick: 900,
      animation: 0,
      stateData: [0, 0, 0, 0, 0],
    } as unknown as Serf;
    state.serfs[6] = second;
    dispatchSerf(state, serf);
    dispatchSerf(state, second);
    expect(serf.state).toBe(25);
    expect(second.state).toBe(28); // tile now taken by #5
    state.mapTiles[pos].serfIndex = 0; // #5 has moved on
    dispatchSerf(state, second);
    expect(second.state).toBe(25);
    expect(state.mapTiles[pos].serfIndex).toBe(6);
  });
});

// ── 73 Scatter ──────────────────────────────────────────────────────────────────────────────────

function scatterState(type: number): { state: GameState; serf: Serf } {
  const state = baseState();
  for (const t of state.mapTiles) (t as { height: number }).height = 4; // walkable everywhere, no object
  const serf = {
    index: 5,
    type,
    owner: 0,
    state: 73,
    col: 32,
    row: 32,
    counter: 55,
    tick: 900,
    animation: 0,
    stateData: [0, 0, 0, 0, 0],
  } as unknown as Serf;
  state.serfs[5] = serf;
  return { state, serf };
}

describe('73 Scatter', () => {
  it('draws a target at least 8 tiles away on both axes', () => {
    for (let run = 0; run < 40; run++) {
      const { state, serf } = scatterState(0);
      state.rng.setState([(0x0380 + run) & 0xffff, 0xeea7, 0x6b11]);
      dispatchSerf(state, serf);
      const dcol = (serf.stateData[0] << 24) >> 24;
      const drow = (serf.stateData[1] << 24) >> 24;
      expect(Math.abs(dcol)).toBeGreaterThanOrEqual(8);
      expect(Math.abs(dcol)).toBeLessThanOrEqual(15);
      expect(Math.abs(drow)).toBeGreaterThanOrEqual(8);
      expect(Math.abs(drow)).toBeLessThanOrEqual(15);
    }
  });

  it('sets the homing tail and goes to 16 FreeWalking', () => {
    const { state, serf } = scatterState(0);
    dispatchSerf(state, serf);
    expect(serf.state).toBe(16);
    expect(serf.stateData[2]).toBe(0x80); // neg_dist1 = -128
    expect(serf.stateData[3]).toBe(0xff); // neg_dist2 = -1
    expect(serf.stateData[4]).toBe(0); // flags
    expect(serf.counter).toBe(0);
  });

  it('knights (types 22..26) land in 53 KnightFreeWalking instead', () => {
    for (const type of [22, 24, 26]) {
      const { state, serf } = scatterState(type);
      dispatchSerf(state, serf);
      expect(serf.state).toBe(53);
    }
    for (const type of [21, 27]) {
      const { state, serf } = scatterState(type);
      dispatchSerf(state, serf);
      expect(serf.state).toBe(16);
    }
  });

  it('skips tiles carrying an object or height 0', () => {
    const { state, serf } = scatterState(0);
    // Make every tile but one unusable.
    const only = posOf(32 + 9, 32 - 11, geo);
    for (let i = 0; i < state.mapTiles.length; i++) {
      if (i !== only) (state.mapTiles[i] as { height: number }).height = 0;
    }
    dispatchSerf(state, serf);
    expect((serf.stateData[0] << 24) >> 24).toBe(9);
    expect((serf.stateData[1] << 24) >> 24).toBe(-11);
  });
});

// ── 74 FinishedBuilding ─────────────────────────────────────────────────────────────────────────

function finishedState(flagOccupiedBy: number): { state: GameState; serf: Serf; here: number; flagTile: number } {
  const state = baseState();
  const here = posOf(10, 20, geo);
  const flagTile = posOf(11, 21, geo); // DownRight
  state.mapTiles[here] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: 5 });
  state.mapTiles[flagTile] = tile({ height: 6, object: 1, objIndex: 1, serfIndex: flagOccupiedBy });
  state.buildings[1] = { index: 1, type: 11, constructing: false } as unknown as Building;
  const serf = {
    index: 5,
    state: 74,
    col: 10,
    row: 20,
    counter: 0,
    tick: 900,
    animation: 0,
    stateData: [0xfe, 0, 0, 0, 2],
  } as unknown as Serf;
  state.serfs[5] = serf;
  return { state, serf, here, flagTile };
}

describe('74 FinishedBuilding', () => {
  it('free flag tile: falls through into 07 and leaves (-> 5 LeavingBuilding)', () => {
    const { state, serf, here, flagTile } = finishedState(0);
    dispatchSerf(state, serf);
    expect(state.mapTiles[here].serfIndex).toBe(0);
    expect(state.mapTiles[flagTile].serfIndex).toBe(5);
    expect(serf.state).toBe(5);
    expect([serf.col, serf.row]).toEqual([11, 21]);
  });

  it('occupied flag tile: stays in 74 - and does get out later', () => {
    const { state, serf, here, flagTile } = finishedState(9);
    dispatchSerf(state, serf);
    expect(serf.state).toBe(74);
    expect(state.mapTiles[here].serfIndex).toBe(5);
    expect(serf.animation).toBe(0); // the state does not touch the animation
    state.mapTiles[flagTile].serfIndex = 0;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(5);
    expect(state.mapTiles[flagTile].serfIndex).toBe(5);
  });
});

// ── 10 BuildingCastle ───────────────────────────────────────────────────────────────────────────

function castleState(progress: number, invIndex = 3): { state: GameState; serf: Serf; castle: Building; pos: number } {
  const state = baseState();
  const pos = posOf(10, 20, geo);
  state.mapTiles[pos] = tile({ object: 4, objIndex: 1, serfIndex: 5 });
  const castle = {
    index: 1,
    type: 24,
    owner: 0,
    constructing: true,
    progress,
    firstKnight: 5,
    holder: true,
  } as unknown as Building;
  state.buildings[1] = castle;
  state.inventories[invIndex] = { index: invIndex, building: 1 } as unknown as Inventory;
  const serf = {
    index: 5,
    type: 4,
    owner: 0,
    state: 10,
    col: 10,
    row: 20,
    counter: 0,
    tick: 900,
    animation: 0,
    stateData: [0, invIndex & 0xff, (invIndex >> 8) & 0xff, 0, 0],
  } as unknown as Serf;
  state.serfs[5] = serf;
  return { state, serf, castle, pos };
}

describe('10 BuildingCastle', () => {
  it('finds the castle via serf[0xc] -> inventory -> building', () => {
    const { serf } = castleState(0, 3);
    expect(unionU16(serf, 0xc)).toBe(3);
  });

  it('adds (gameTick - serf.tick) << 7 to the build progress', () => {
    const { state, serf, castle } = castleState(1000);
    state.gameTick = 950;
    serf.tick = 900;
    dispatchSerf(state, serf);
    expect(castle.progress).toBe(1000 + 50 * 128);
    expect(serf.tick).toBe(950);
    expect(castle.constructing).toBe(true);
  });

  it('u16 overflow finishes the build: state 12, tile freed, constructing/firstKnight cleared', () => {
    const { state, serf, castle, pos } = castleState(0xff00);
    state.gameTick = 910; // delta 10 -> +1280 => overflow
    dispatchSerf(state, serf);
    expect(castle.progress).toBe((0xff00 + 1280) & 0xffff);
    expect(castle.constructing).toBe(false);
    expect(castle.firstKnight).toBe(0);
    expect(state.mapTiles[pos].serfIndex).toBe(0);
    expect(serf.state).toBe(12);
  });

  it('exactly up to 0xffff is NOT yet an overflow', () => {
    const { state, serf, castle } = castleState(0xffff - 128);
    state.gameTick = 901; // delta 1 -> +128
    dispatchSerf(state, serf);
    expect(castle.progress).toBe(0xffff);
    expect(castle.constructing).toBe(true);
    expect(serf.state).toBe(10);
  });

  it('ohne Zeitfortschritt passiert nichts', () => {
    const { state, serf, castle } = castleState(4096);
    state.gameTick = 900;
    dispatchSerf(state, serf);
    expect(castle.progress).toBe(4096);
  });
});
