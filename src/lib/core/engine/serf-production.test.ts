import { describe, it, expect } from 'vitest';
import { dispatchSerf } from './serf-machine.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import type { GameState, Serf, Building, Tile, Flag, Player } from './state.js';

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
    type: 17,
    owner: 0,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
    inventoryIndex: null,
    ...over,
  } as unknown as Building;
}
function flag(freeSlots = true): Flag {
  return {
    index: 1,
    resourceSlots: freeSlots ? [-1, -1, -1, -1, -1, -1, -1, -1] : [0, 1, 2, 3, 4, 5, 6, 7],
    slotDir: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
    hasResources: false,
  } as unknown as Flag;
}
function player(): Player {
  return { index: 0, resourceCount: new Array(26).fill(0) } as unknown as Player;
}
function makeState(): GameState {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  return {
    geo,
    gameTick: 1000,
    mapTiles,
    serfs: [null] as (Serf | null)[],
    buildings: [null, bld()] as (Building | null)[],
    flags: [null, flag()] as (Flag | null)[],
    players: [player(), null, null, null] as (Player | null)[],
  } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number; state: number }): Serf {
  return {
    counter: 0,
    tick: 0,
    animation: 0,
    owner: 0,
    col: 20,
    row: 20,
    stateData: [0, 0, 0, 0, 0],
    ...over,
  } as unknown as Serf;
}

describe('serf-production — Sawing (24) single duration', () => {
  it('phase A: timber (stock[1]) present → consume it, set anim/duration, phase B', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ stock: [{ available: 0, requested: 0 }, { available: 3, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 24, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.stock[1].available).toBe(2); // one timber consumed
    expect(serf.stateData[0]).toBe(0xff); // phase B
    expect(serf.animation).toBe(0x7c);
    expect(serf.counter).toBe(0x93f);
    expect(state.mapTiles[pos].serfIndex).toBe(1); // registered on the tile
  });

  it('phase A: no timber -> wait (no mutation)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 24, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(0); // stays in phase A
    expect(serf.state).toBe(24);
  });

  it('phase B: tick not elapsed -> only the counter goes down', () => {
    const state = makeState();
    const serf = mkSerf({ index: 1, state: 24, tick: 900, counter: 5000, stateData: [0xff, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf); // delta 100 < 5000

    expect(serf.state).toBe(24);
    expect(serf.counter).toBe(4900);
  });

  it('phase B: elapsed → pick up the plank, production stat++, MoveResourceOut', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, serfIndex: 1 });
    // Flag (DownRight) with a free slot so that leaving succeeds.
    const flagTile = neighbor(pos, Direction.DownRight, geo);
    state.mapTiles[flagTile] = tile({ objIndex: 1 });
    const serf = mkSerf({ index: 1, state: 24, tick: 900, counter: 5, stateData: [0xff, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf); // delta 100 > 5 → elapsed

    expect(serf.stateData[0]).toBe(8); // carried resource = plank+1
    expect(serf.stateData[4]).toBe(0xd); // follow-up state DropResourceOut
    expect(state.players[0]!.resourceCount[7]).toBe(1); // plank(7) production +1
    expect(state.mapTiles[pos].serfIndex).toBe(0); // tile free
    expect([5, 11]).toContain(serf.state); // LeavingBuilding (exit) or MoveResourceOut (blocked)
  });
});

describe('serf-production — Butchering (38) single duration', () => {
  it('phase A: pig (stock[0]) → consume it, anim 0x8c/duration 0x5ff', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 13, stock: [{ available: 2, requested: 0 }, { available: 0, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 38, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.stock[0].available).toBe(1);
    expect(serf.animation).toBe(0x8c);
    expect(serf.counter).toBe(0x5ff);
  });

  it('phase B elapsed → pick up the meat (res+1=3) + stat++', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, serfIndex: 1 });
    const flagTile = neighbor(pos, Direction.DownRight, geo);
    state.mapTiles[flagTile] = tile({ objIndex: 1 });
    const serf = mkSerf({ index: 1, state: 38, tick: 900, counter: 5, stateData: [0xff, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(3); // meat+1
    expect(state.players[0]!.resourceCount[2]).toBe(1); // meat(2) production +1
  });
});

describe('serf-production — multi-step processors', () => {
  function withFlag(): { state: GameState; pos: number } {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, serfIndex: 1 });
    state.mapTiles[neighbor(pos, Direction.DownRight, geo)] = tile({ objIndex: 1 });
    return { state, pos };
  }

  it('Baking (36) phase A: consume flour (stock[0]), step 1, anim 0x8a', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 16, stock: [{ available: 2, requested: 0 }, { available: 0, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 36, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.stock[0].available).toBe(1);
    expect(serf.stateData[0]).toBe(1);
    expect(serf.animation).toBe(0x8a);
    expect(serf.counter).toBe(0x2ff);
  });

  it('Baking (36) last step (2→3) → bread (res+1=6), active off', () => {
    const { state, pos } = withFlag();
    state.buildings[1] = bld({ type: 16, active: true });
    const serf = mkSerf({ index: 1, state: 36, tick: 900, counter: 5, stateData: [2, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(6); // bread+1
    expect(state.buildings[1]!.active).toBe(false);
    expect(state.players[0]!.resourceCount[5]).toBe(1); // Bread(5)
    void pos;
  });

  it('Milling (35) phase A: active bit + consume wheat, step 1', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 15, active: false, stock: [{ available: 1, requested: 0 }, { available: 0, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 35, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.active).toBe(true);
    expect(state.buildings[1]!.stock[0].available).toBe(0);
    expect(serf.stateData[0]).toBe(1);
    expect(serf.animation).toBe(0x89);
  });

  it('Milling (35) step 3 -> the miller is briefly visible (tile occupied, counter 0x17f)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1, serfIndex: 0 });
    state.buildings[1] = bld({ type: 15, active: true });
    const serf = mkSerf({ index: 1, state: 35, tick: 900, counter: 5, stateData: [2, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf); // 2→3

    expect(serf.stateData[0]).toBe(3);
    expect(state.mapTiles[pos].serfIndex).toBe(1); // registered again
    expect(serf.counter).toBe(0x17f);
    expect(serf.state).toBe(35); // stays in Milling
  });

  it('Milling (35) last step (4→5) → flour (res+1=5)', () => {
    const { state } = withFlag();
    state.buildings[1] = bld({ type: 15, active: true });
    const serf = mkSerf({ index: 1, state: 35, tick: 900, counter: 5, stateData: [4, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(5); // flour+1
    expect(state.buildings[1]!.active).toBe(false);
    expect(state.players[0]!.resourceCount[4]).toBe(1); // Flour(4)
  });

  it('Smelting (30) phase A: consume two inputs (ore + coal), active, field_0xc=0x14', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 18, active: false, stock: [{ available: 2, requested: 0 }, { available: 3, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 30, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.active).toBe(true);
    expect(state.buildings[1]!.stock[0].available).toBe(1);
    expect(state.buildings[1]!.stock[1].available).toBe(2);
    expect(serf.stateData[0]).toBe(0xff);
    expect(serf.stateData[1]).toBe(0x14);
    expect(serf.animation).toBe(0x82); // steel (field_0xd==0)
  });

  it('Smelting (30) phase A gold smelter (field_0xd≠0) → anim 0x81', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 23, stock: [{ available: 1, requested: 0 }, { available: 1, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 30, stateData: [0, 0, 1, 0, 0] }); // field_0xd=1
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.animation).toBe(0x81);
  });

  it('Smelting (30) countdown finished (field_0xc=0) → steel (0xc)', () => {
    const { state } = withFlag();
    state.buildings[1] = bld({ type: 18, active: true });
    const serf = mkSerf({ index: 1, state: 30, tick: 900, counter: 5, stateData: [0xff, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(0xc); // steel+1
    expect(state.buildings[1]!.active).toBe(false);
    expect(state.players[0]!.resourceCount[11]).toBe(1); // Steel(11)
  });

  it('Smelting (30) gold (field_0xd≠0) at the end → gold bar (0xf)', () => {
    const { state } = withFlag();
    state.buildings[1] = bld({ type: 23, active: true });
    const serf = mkSerf({ index: 1, state: 30, tick: 900, counter: 5, stateData: [0xff, 0, 1, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(0xf); // gold bar+1
    expect(state.players[0]!.resourceCount[14]).toBe(1); // GoldBar(14)
  });

  it('MakingWeapon (39) sword cycle phase A: consume coal+steel, step 1', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 20, playingSfx: false, active: false, stock: [{ available: 2, requested: 0 }, { available: 2, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 39, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.stock[0].available).toBe(1);
    expect(state.buildings[1]!.stock[1].available).toBe(1);
    expect(state.buildings[1]!.active).toBe(true);
    expect(serf.stateData[0]).toBe(1);
    expect(serf.animation).toBe(0x8f);
  });

  it('MakingWeapon (39) shield cycle phase A (playingSfx): NO consumption', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 20, playingSfx: true, stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 39, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(1); // starts despite the empty stock (the material went into the sword cycle)
    expect(serf.animation).toBe(0x8f);
  });

  it('MakingWeapon (39) finish (6->7): sword (0x19), playingSfx toggles to true', () => {
    const { state } = withFlag();
    state.buildings[1] = bld({ type: 20, active: true, playingSfx: false });
    const serf = mkSerf({ index: 1, state: 39, tick: 900, counter: 5, stateData: [6, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(0x19); // sword+1
    expect(state.buildings[1]!.playingSfx).toBe(true); // bit toggled
    expect(state.buildings[1]!.active).toBe(false);
    expect(state.players[0]!.resourceCount[24]).toBe(1); // Sword(24)
  });

  it('MakingWeapon (39) finish in the shield cycle (playingSfx) → shield (0x1a)', () => {
    const { state } = withFlag();
    state.buildings[1] = bld({ type: 20, active: true, playingSfx: true });
    const serf = mkSerf({ index: 1, state: 39, tick: 900, counter: 5, stateData: [6, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(0x1a); // shield+1
    expect(state.buildings[1]!.playingSfx).toBe(false); // toggled back
    expect(state.players[0]!.resourceCount[25]).toBe(1); // Shield(25)
  });
});
