import { describe, it, expect } from 'vitest';
import { dispatchSerf } from './serf-machine.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import { Rng } from './rng.js';
import { spiralPos } from './spiral.js';
import type { GameState, Serf, Building, Tile, Flag, Player } from './state.js';

/**
 * Mining (handler 29, `@0x1a910`). The substate machine (`field_0xb`) runs food -> digging -> spiral
 * search -> yield -> carrying out. Only the deterministic parts are testable; the *concrete* tile the
 * search finds cannot be byte-equal to DOS (see `tick.ts`).
 */
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
function bld(over: Partial<Building> = {}): Building {
  return {
    index: 1,
    type: 6, // CoalMine
    owner: 0,
    progress: 0,
    active: false,
    playingSfx: false,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
    inventoryIndex: null,
    ...over,
  } as unknown as Building;
}
function flag(): Flag {
  return {
    index: 1,
    resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDir: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
    hasResources: false,
    // The AI razing unhooks the building direction at the flag (`flag+0x34 = 0`).
    connections: [null, null, null, null, null, null],
    paths: 0,
    hasBuilding: true,
    acceptsSerfs: false,
    acceptsResources: false,
  } as unknown as Flag;
}
function player(): Player {
  return {
    index: 0,
    resourceCount: new Array(26).fill(0),
    flags: 0,
    messageTypes: [] as number[],
    messagePositions: [] as number[],
    // The AI branch of the mine-exhausted case calls `demolishBuilding`, which rebooks the score.
    completedBuildingCount: new Array(23).fill(0),
    incompleteBuildingCount: new Array(23).fill(0),
    totalBuildingScore: 0,
    totalMilitaryScore: 0,
  } as unknown as Player;
}
function makeState(fill: (t: Tile) => Tile = (t) => t): GameState {
  const mapTiles = Array.from({ length: geo.tileCount }, () => fill(tile()));
  return {
    geo,
    gameTick: 1000,
    mapTiles,
    serfs: [null] as (Serf | null)[],
    buildings: [null, bld()] as (Building | null)[],
    flags: [null, flag()] as (Flag | null)[],
    inventories: [] as unknown[],
    players: [player(), null, null, null] as (Player | null)[],
    rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number; state: number }): Serf {
  return {
    counter: 0,
    // tick = gameTick-1, counter 0 => the tick prologue runs; post-advance counter = 0xffff => every
    // additive substate carries immediately, so exactly one substate runs per dispatch.
    tick: 999,
    animation: 0,
    owner: 0,
    col: 20,
    row: 20,
    stateData: [0, 0, 0, 0, 0],
    ...over,
  } as unknown as Serf;
}

describe('mining (29) — substate 0, food choice', () => {
  it('(rng&7)==0 goes to substate 1 (food check), otherwise to substate 2 (skip)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    const rngVal = new Rng([1, 2, 3]).next(); // predict the same sequence
    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe((rngVal & 7) === 0 ? 1 : 2);
  });
});

describe('mining (29) — food (substates 1/2)', () => {
  it('substate 1: food in stock is eaten, then substate 3, anim 0x7d, counter 0x17f', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ stock: [{ available: 4, requested: 0 }, { available: 0, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 29, stateData: [1, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.stock[0].available).toBe(3); // one food eaten
    expect(serf.stateData[0]).toBe(3);
    expect(serf.animation).toBe(0x7d);
    expect(serf.counter).toBe(0x17f);
    expect(state.mapTiles[pos].serfIndex).toBe(1);
  });

  it('substate 1: without food it waits (anim 0x62, substate stays 1)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 29, stateData: [1, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(1); // keeps waiting
    expect(serf.animation).toBe(0x62);
    expect(serf.counter).toBe(0xff); // old < 0xff00 => clamped
  });

  it('substate 2: skipping food goes to substate 3, anim 0x7d', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [2, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(3);
    expect(serf.animation).toBe(0x7d);
    expect(serf.counter).toBe(0x17f);
  });
});

describe('mining (29) — digging, search and yield', () => {
  it('substate 3: clears building activity, anim 0x7e, substate 4', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ active: true });
    const serf = mkSerf({ index: 1, state: 29, stateData: [3, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(4);
    expect(state.buildings[1]!.active).toBe(false);
    expect(serf.animation).toBe(0x7e);
  });

  it('search (substate 5): a matching deposit → decrement, yield (res+1), substate 8', () => {
    // The whole map is coal (type 3, amount 5) ⇒ every spiral position matches.
    const state = makeState((t) => ({ ...t, mineral: 3, resourceAmount: 5 }) as Tile);
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, mineral: 3, resourceAmount: 5 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [5, 0, 0, 3, 0] }); // deposit=3 (coal)
    state.serfs[1] = serf;

    // Predict the tile the search will hit (same RNG sequence).
    const idx = (new Rng([1, 2, 3]).next() >> 2) & 0x1f;
    const dest = spiralPos(pos, idx, geo);

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(8);
    expect(serf.stateData[2]).toBe(13); // coal, res+1
    expect(state.mapTiles[dest].resourceAmount).toBe(4); // one unit mined
    expect(state.mapTiles[dest].mineral).toBe(3);
  });

  it('search: an exhausted deposit (amount 1 -> 0) clears the whole mineral byte', () => {
    const state = makeState((t) => ({ ...t, mineral: 3, resourceAmount: 1 }) as Tile);
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, mineral: 3, resourceAmount: 1 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [5, 0, 0, 3, 0] });
    state.serfs[1] = serf;
    const idx = (new Rng([1, 2, 3]).next() >> 2) & 0x1f;
    const dest = spiralPos(pos, idx, geo);

    dispatchSerf(state, serf);

    expect(state.mapTiles[dest].resourceAmount).toBe(0);
    expect(state.mapTiles[dest].mineral).toBe(0); // whole byte cleared
  });

  it('search: a wrong mineral type mines nothing and the substate keeps counting (not 8)', () => {
    // Map carries iron (2), the mine wants coal (3) => no match.
    const state = makeState((t) => ({ ...t, mineral: 2, resourceAmount: 5 }) as Tile);
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, mineral: 2, resourceAmount: 5 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [5, 0, 0, 3, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(6); // +1, nothing found
    expect(serf.stateData[2]).toBe(0); // no yield
  });
});

describe('mining (29) — handover and completion', () => {
  it('substate 8: serf on the tile, sfx off, anim 0x7f, substate 9', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ playingSfx: true });
    const serf = mkSerf({ index: 1, state: 29, stateData: [8, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(9);
    expect(state.mapTiles[pos].serfIndex).toBe(1);
    expect(state.buildings[1]!.playingSfx).toBe(false);
    expect(serf.animation).toBe(0x7f);
    expect(serf.counter).toBe(0x12f);
  });

  it('substate 9: increase_mining (progress<<1 | res found), active on, anim 0x80, substate 10', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ progress: 0x0005 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [9, 0, 13, 0, 0] }); // res found (13)
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(10);
    expect(state.buildings[1]!.active).toBe(true);
    expect(state.buildings[1]!.progress).toBe((0x0005 << 1) | 1); // = 0xb
    expect(serf.animation).toBe(0x80);
  });

  it('substate 9: without yield, progress shifts left without the +1', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ progress: 0x0005 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [9, 0, 0, 0, 0] }); // res == 0
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.progress).toBe(0x0005 << 1); // 0xa, no +1
  });

  /**
   * Mine exhausted (`@0x1ac9c`..`@0x1ad7e`). Message type = `4 + ((buildingType - 5) << 5)`.
   */
  it('substate 9: progress == 0x8000 sends the mine-exhausted message with the mine kind', () => {
    // All four mine types, so the parameter has to move with the type.
    for (const [type, param] of [
      [5, 0], // StoneMine
      [6, 1], // CoalMine
      [7, 2], // IronMine
      [8, 3], // GoldMine
    ] as const) {
      const state = makeState();
      const pos = posOf(20, 20, geo);
      state.mapTiles[pos] = tile({ objIndex: 1 });
      // The message position is `bld[0]`, i.e. the BUILDING's tile, not the serf's.
      state.buildings[1] = bld({ type, progress: 0x8000, col: 20, row: 20 });
      const serf = mkSerf({ index: 1, state: 29, stateData: [9, 0, 0, 0, 0] });
      state.serfs[1] = serf;

      dispatchSerf(state, serf);

      const p = state.players[0]!;
      expect(p.messageTypes, `mine type ${type}`).toEqual([4 + (param << 5)]);
      expect(p.messagePositions).toEqual([pos]);
      // The shift still happens afterwards (`shlw $1` @0x1ad86).
      expect(state.buildings[1]!.progress).toBe((0x8000 << 1) & 0xffff);
      // A human player does NOT lose the mine; razing is the AI branch.
      expect(state.buildings[1]!.burning).toBeFalsy();
    }
  });

  it('substate 9: progress != 0x8000 sends no message', () => {
    for (const progress of [0x4000, 0x8001, 0x7fff, 0x0005]) {
      const state = makeState();
      const pos = posOf(20, 20, geo);
      state.mapTiles[pos] = tile({ objIndex: 1 });
      state.buildings[1] = bld({ progress });
      const serf = mkSerf({ index: 1, state: 29, stateData: [9, 0, 0, 0, 0] });
      state.serfs[1] = serf;

      dispatchSerf(state, serf);

      expect(state.players[0]!.messageTypes, `progress ${progress}`).toEqual([]);
    }
  });

  it('substate 9: the AI razes its exhausted mine but still gets the same message', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 7, progress: 0x8000, col: 20, row: 20, flag: 1 });
    state.players[0]!.flags = 1 << 7; // AI player
    const serf = mkSerf({ index: 1, state: 29, stateData: [9, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.burning).toBe(true); // `call 0x48eb8` @0x1ad39
    expect(state.players[0]!.messageTypes).toEqual([4 + (2 << 5)]); // and the message all the same
  });

  it('substate 10: with yield it finishes production (stat++, tile freed, state != 29)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, serfIndex: 1 });
    const flagTile = neighbor(pos, Direction.DownRight, geo);
    state.mapTiles[flagTile] = tile({ objIndex: 1 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [10, 0, 13, 0, 0] }); // res+1 = 13 (coal)
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.players[0]!.resourceCount[12]).toBe(1); // coal (12) production +1
    expect(state.mapTiles[pos].serfIndex).toBe(0);
    expect(serf.state).not.toBe(29);
    expect([5, 11]).toContain(serf.state);
  });

  it('substate 10: without yield the cycle restarts (substate 0, counter 0)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, serfIndex: 1 });
    const serf = mkSerf({ index: 1, state: 29, stateData: [10, 0, 0, 0, 0] }); // res == 0
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(0);
    expect(serf.counter).toBe(0);
    expect(serf.state).toBe(29);
    expect(state.mapTiles[pos].serfIndex).toBe(0);
  });
});
