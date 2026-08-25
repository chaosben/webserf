import { describe, it, expect } from 'vitest';
import { dispatchSerf } from './serf-machine.js';
import { mapGeometry, posOf, neighbor, Direction, oppositeDir } from './position.js';
import { Rng } from './rng.js';
import type { GameState, Serf, Building, Tile, Player } from './state.js';

/**
 * Digging (handler 08, `@0x24b11`): the digger levels the 7 hex tiles around the site to `target_h`.
 * Tested are the deterministic transitions - dig, change height, look for a tile (hit / occupied),
 * walk to it (free / occupied) and finish.
 * State-Union: h_index=0xb (i8), target_h=0xc (u8), dig_pos=0xd (i8), substate=0xe (i8).
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
    type: 11, // Hut
    owner: 0,
    progress: 0,
    holder: true,
    firstKnight: 5,
    level: 5,
    constructing: true,
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
    flags: [null] as unknown,
    players: [player(), null, null, null] as (Player | null)[],
    rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number }): Serf {
  return {
    state: 8,
    counter: 0,
    tick: 999, // delta 1, counter 0 -> underflow, every additive substate carries at once
    animation: 0,
    owner: 0,
    type: 2, // Digger
    col: 20,
    row: 20,
    stateData: [0, 0, 0, 0, 0],
    ...over,
  } as unknown as Serf;
}

describe('Digging (08) — graben (substate > 1)', () => {
  it('h_index gerade → Anim 88, counter += 383', () => {
    const state = makeState();
    // substate 3 → dekrement 2 (>1) → graben
    const serf = mkSerf({ index: 1, stateData: [0, 5, 1, 3, 0] }); // h_index=0, dig_pos=1, substate=3
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.animation).toBe(88);
    expect(serf.stateData[3]).toBe(2); // substate dekrementiert
    expect(serf.counter).toBe((0xffff + 383) & 0xffff);
  });
  it('h_index ungerade → Anim 87', () => {
    const state = makeState();
    const serf = mkSerf({ index: 1, stateData: [1, 5, 1, 3, 0] });
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.animation).toBe(87);
  });
});

describe('Digging (08): change height and return to the centre (substate == 1)', () => {
  it('h_index gerade → Feld +1, dann zur Mitte laufen (dig_pos != 0)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].height = 5;
    const np = neighbor(pos, oppositeDir(6 - 1), geo); // dig_pos 1 -> return direction Down
    state.mapTiles[np].height = 6;
    state.mapTiles[np].serfIndex = 0;
    // substate 2 -> decrement 1 -> change height
    const serf = mkSerf({ index: 1, stateData: [0, 5, 1, 2, 0] }); // h_index=0(gerade), dig_pos=1
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(state.mapTiles[pos].height).toBe(6); // +1
    expect(posOf(serf.col as number, serf.row as number, geo)).toBe(np); // zur Mitte gelaufen
  });
  it('h_index ungerade → Feld −1', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].height = 5;
    const serf = mkSerf({ index: 1, stateData: [1, 5, 1, 2, 0] });
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(state.mapTiles[pos].height).toBe(4); // −1
  });
});

describe('Digging (08) — Feld suchen (substate == 0)', () => {
  it('Treffer am Nachbar-Feld (frei) → hingehen (substate 3)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].height = 5;
    // dig_pos 2 → dekrement 1; h_index 1 → h_diff[1]=1 → h = target_h(5)+1 = 6
    const dir = 6 - 1; // dig_pos is decremented to 1
    const np = neighbor(pos, dir, geo);
    state.mapTiles[np].height = 6;
    state.mapTiles[np].serfIndex = 0;
    // substate 1 → dekrement 0 → suchen
    const serf = mkSerf({ index: 1, stateData: [1, 5, 2, 1, 0] }); // h_index=1, target_h=5, dig_pos=2
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.stateData[3]).toBe(3); // substate = walk-to-spot
    expect(serf.stateData[2]).toBe(1); // dig_pos committed = 1
    expect(posOf(serf.col as number, serf.row as number, geo)).toBe(np); // umgesetzt
  });

  it('hit on the neighbouring tile but OCCUPIED -> wait (counter=127)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].height = 5;
    const np = neighbor(pos, 6 - 1, geo);
    state.mapTiles[np].height = 6;
    state.mapTiles[np].serfIndex = 99; // belegt
    const serf = mkSerf({ index: 1, stateData: [1, 5, 2, 1, 0] });
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.counter).toBe(127);
    expect(serf.stateData[3]).toBe(0); // substate = 0
    expect(serf.animation).toBe(87 - 1); // 87 - dig_pos
    expect(posOf(serf.col as number, serf.row as number, geo)).toBe(pos); // not moved
  });

  it('Treffer am Zentrum (dig_pos 0) → hier graben (substate 2, Anim 87/88)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].height = 6; // == target_h(5) + h_diff[1]=1
    // dig_pos 1 → dekrement 0 (Zentrum); h_index 1 → h = 6
    const serf = mkSerf({ index: 1, stateData: [1, 5, 1, 1, 0] });
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.stateData[3]).toBe(2); // substate = graben
    expect(serf.stateData[2]).toBe(0); // dig_pos = 0
    expect(serf.animation).toBe(87); // h_index ungerade
  });

  it('h_index exhausted -> done_leveling + ReadyToLeave', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].objIndex = 1;
    state.buildings[1] = bld({ progress: 0, holder: true, firstKnight: 5 });
    // dig_pos 0 → dekrement -1 → reset 6, h_index 0 → -1 → done
    const serf = mkSerf({ index: 1, stateData: [0, 5, 0, 1, 0] }); // h_index=0, dig_pos=0
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(state.buildings[1]!.progress).toBe(1);
    expect(state.buildings[1]!.holder).toBe(false);
    expect(state.buildings[1]!.firstKnight).toBe(0);
    expect([5, 7]).toContain(serf.state); // ReadyToLeave → (evtl. sofort) LeavingBuilding
  });
});

describe('Digging (08) — zum Feld gehen (substate < 0, wait-for-serf)', () => {
  it('Nachbar frei → umsetzen (substate 3)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].serfIndex = 1;
    // dig_pos 2 → Richtung 6-2 = 4 (UpLeft)
    const np = neighbor(pos, 4, geo);
    state.mapTiles[np].serfIndex = 0;
    // substate 0 → dekrement -1 → wait-for-serf
    const serf = mkSerf({ index: 1, stateData: [0, 5, 2, 0, 0] });
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.stateData[3]).toBe(3);
    expect(posOf(serf.col as number, serf.row as number, geo)).toBe(np);
    expect(state.mapTiles[np].serfIndex).toBe(1);
    expect(state.mapTiles[pos].serfIndex).toBe(0);
  });

  it('Nachbar besetzt → warten, KEIN Serf-Tausch (counter=127, substate=0)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].serfIndex = 1;
    const np = neighbor(pos, 4, geo);
    state.mapTiles[np].serfIndex = 77;
    const serf = mkSerf({ index: 1, stateData: [0, 5, 2, 0, 0] });
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.counter).toBe(127);
    expect(serf.stateData[3]).toBe(0);
    expect(posOf(serf.col as number, serf.row as number, geo)).toBe(pos); // did not move
  });

  it('dig_pos 0 -> direction Up, raw height delta as the animation', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos].serfIndex = 1;
    state.mapTiles[pos].height = 4;
    const np = neighbor(pos, Direction.Up, geo);
    state.mapTiles[np].height = 6; // dH = 2 → Anim 2 (DIG_ANIM_OUT[0]=0)
    state.mapTiles[np].serfIndex = 0;
    const serf = mkSerf({ index: 1, stateData: [0, 5, 0, 0, 0] }); // dig_pos=0
    state.serfs[1] = serf;
    dispatchSerf(state, serf);
    expect(serf.animation).toBe(2);
    expect(posOf(serf.col as number, serf.row as number, geo)).toBe(np);
  });
});
