import { describe, it, expect } from 'vitest';
import { dispatchSerf } from './serf-machine.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import { Rng } from './rng.js';
import { spiralPos } from './spiral.js';
import type { GameState, Serf, Building, Tile, Flag, Player } from './state.js';

/**
 * Field work states (17/20/23/32/34) plus the planning searches (18/19/21/31/33).
 * Only the deterministic parts are checked (map object mutations, transitions, field ripening); the
 * random spot choice cannot be byte-equal to DOS (see `tick.ts`).
 */
const geo = mapGeometry(3);

function tile(over: Partial<Tile> = {}): Tile {
  return {
    height: 0, terrainUp: 8, terrainDown: 8, object: 0, owner: 0, paths: 0,
    mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0, ...over,
  } as unknown as Tile;
}
function bld(over: Partial<Building> = {}): Building {
  return {
    index: 1, type: 2, owner: 0, progress: 0, active: false, playingSfx: false, constructing: false,
    stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }], inventoryIndex: null, ...over,
  } as unknown as Building;
}
function flag(): Flag {
  return {
    index: 1, resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDir: [-1, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], hasResources: false,
  } as unknown as Flag;
}
function makeState(): GameState {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  return {
    geo, gameTick: 1000, mapTiles,
    serfs: [null] as (Serf | null)[],
    buildings: [null, bld()] as (Building | null)[],
    flags: [null, flag()] as (Flag | null)[],
    players: [{ index: 0, resourceCount: new Array(26).fill(0) } as unknown as Player, null, null, null],
    rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number; state: number }): Serf {
  return {
    counter: 0, tick: 999, animation: 0, owner: 0, col: 20, row: 20, stateData: [0, 0, 0, 0, 0], type: 0, ...over,
  } as unknown as Serf;
}

describe('Logging (17)', () => {
  it('frame step: map object becomes a falling tree (pine, neg_dist1=0)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    const serf = mkSerf({ index: 1, state: 17, stateData: [0, 0, 0, 0, 0] }); // neg_dist2=0
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[3]).toBe(1); // neg_dist2 (Frame) hoch
    expect(state.mapTiles[pos].object).toBe(0x5d); // 0x5c + Frame 1 (FelledPine)
    expect(serf.animation).toBe(0x75);
  });

  it('deciduous tree (neg_dist1 != 0): object 5 higher (FelledTree)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    const serf = mkSerf({ index: 1, state: 17, stateData: [0, 0, 0xff, 0, 0] }); // neg_dist1=-1
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x62); // 0x5c + 1 + 5
  });

  it('frame 5 -> FreeWalking (way back)', () => {
    const state = makeState();
    const serf = mkSerf({ index: 1, state: 17, stateData: [0, 0, 0, 4, 0] }); // neg_dist2=4 -> becomes 5
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.state).toBe(16); // FreeWalking
    expect(serf.stateData[2]).toBe(0x80); // neg_dist1 = -128
  });
});

describe('Planting (20)', () => {
  it('leeres wegfreies Feld → Setzling gepflanzt (1. Tick), dann FreeWalking (2. Tick)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    const serf = mkSerf({ index: 1, state: 20, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf); // pflanzt + Toggle neg_dist2 → 0xff, Counter-Carry → return
    expect(state.mapTiles[pos].object).toBeGreaterThanOrEqual(0x67); // NewPine/NewTree gepflanzt
    expect(state.mapTiles[pos].object).toBeLessThanOrEqual(0x68);
    expect(serf.stateData[3]).toBe(0xff); // neg_dist2 getoggelt

    serf.counter = 0;
    serf.tick = state.gameTick - 1; // Prolog: delta 1 > 0 → abgelaufen
    dispatchSerf(state, serf); // neg_dist2 != 0 → fertig
    expect(serf.state).toBe(16); // FreeWalking
    expect(serf.stateData[2]).toBe(0x80);
  });

  it('occupied tile -> no planting (the object stays)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ object: 10 }); // a tree is already there
    const serf = mkSerf({ index: 1, state: 20, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.mapTiles[pos].object).toBe(10); // unchanged
  });
});

describe('Farming (34)', () => {
  it('sowing (neg_dist1=0): seed 0x69 on an empty tile, then FreeWalking', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    const serf = mkSerf({ index: 1, state: 34, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x69); // Seeds0
    expect(serf.state).toBe(16);
    expect(serf.stateData[2]).toBe(0x80);
  });

  it('Ernten (neg_dist1≠0): Feld-Objekt reift weiter, neg_dist2=1 (Ware), FreeWalking', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ object: 0x6a }); // reifendes Feld
    const serf = mkSerf({ index: 1, state: 34, stateData: [0, 0, 1, 0, 0] }); // neg_dist1=1
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x6b); // +1
    expect(serf.stateData[3]).toBe(1); // neg_dist2 = 1 (getragene Ware)
    expect(serf.state).toBe(16);
  });

  it('Ernten Reife-Wrap: 0x6e → 0x79 (b=0x6f → 0x79)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ object: 0x6e });
    const serf = mkSerf({ index: 1, state: 34, stateData: [0, 0, 1, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x79); // 0x6e+1=0x6f → Sonderfall → 0x79
  });

  it('Ernten Reife-Wrap: 0x6f → 0x6f (b=0x70 → 0x6f, Feld abgeerntet)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ object: 0x6f });
    const serf = mkSerf({ index: 1, state: 34, stateData: [0, 0, 1, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.mapTiles[pos].object).toBe(0x6f); // 0x6f+1=0x70 → Sonderfall → 0x6f
  });
});

describe('Fishing (32)', () => {
  it('flags==10 -> stop (FreeWalking)', () => {
    const state = makeState();
    const serf = mkSerf({ index: 1, state: 32, stateData: [0, 0, 0, 0, 0x0a] }); // flags=10
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.state).toBe(16);
    expect(serf.stateData[2]).toBe(0x80);
  });

  it('catch: water tile with fish -> stock -1, neg_dist2=1', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    // Cast direction at anim 0x83 is Left, so the left tile is water with fish.
    const leftTile = neighbor(pos, Direction.Left, geo);
    state.mapTiles[leftTile] = tile({ terrainUp: 2, terrainDown: 2, mineral: 0, resourceAmount: 12 });
    // neg_dist1 even (0) -> becomes 1 (odd == cast); anim 0x83.
    const serf = mkSerf({ index: 1, state: 32, animation: 0x83, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    // A catch happens when rng & 0x3f < 12+4.
    const rng = new Rng([1, 2, 3]);
    rng.next(); // fishing draws exactly one random number on the cast
    // Deterministisch: Fisch gefangen ⇒ Vorrat 11, neg_dist2=1.
    expect(state.mapTiles[leftTile].resourceAmount).toBe(11);
    expect(serf.stateData[3]).toBe(1);
  });
});

describe('StoneCutting (23)', () => {
  it('approach: counter above the threshold -> wait (neg_dist1 stays 0)', () => {
    const state = makeState();
    // neg_dist2=5, flags=0 → Schwelle 5; counter nach Prolog = 9 ≥ 5 → warten.
    const serf = mkSerf({ index: 1, state: 23, tick: 999, counter: 10, stateData: [0, 0, 0, 5, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[2]).toBe(0); // neg_dist1 bleibt 0 (wartet)
    expect(serf.state).toBe(23);
  });

  it('Anmarsch fertig: Counter unter Schwelle → Schneiden beginnt (neg_dist1=1, Anim 0x7b)', () => {
    const state = makeState();
    const serf = mkSerf({ index: 1, state: 23, tick: 999, counter: 3, stateData: [0, 0, 0, 5, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[2]).toBe(1); // neg_dist1 = 1
    expect(serf.animation).toBe(0x7b);
  });

  it('Abbau: Stein-Objekt dekrementiert + Serf einen Schritt DownRight', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ object: 72 }); // Stone0
    const serf = mkSerf({ index: 1, state: 23, tick: 999, counter: 0, stateData: [0, 0, 1, 0, 0] }); // neg_dist1=1
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.mapTiles[pos].object).toBe(73); // Stone0 → Stone1 (weniger Stein)
    const dr = neighbor(pos, Direction.DownRight, geo);
    expect(state.mapTiles[dr].serfIndex).toBe(1); // Serf nach DownRight gesetzt
    expect(serf.stateData[2]).toBe(2); // neg_dist1 = 2
  });

  it('Abbau letzter Stein (0x4f) → Objekt entfernt', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ object: 0x4f }); // Stone7
    const serf = mkSerf({ index: 1, state: 23, tick: 999, counter: 0, stateData: [0, 0, 1, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.mapTiles[pos].object).toBe(0); // entfernt
  });
});

describe('drop_resource (handing goods to the flag on the way back)', () => {
  // A loaded returner (state 16, neg_dist1=-128, neg_dist2>0) reaches the flag (flags=8): the good goes
  // into the first free slot, hasResources, player.resourceCount++, then ReadyToEnter (6).
  function returner(type: number): { state: GameState; serf: Serf; pos: number } {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ object: 1, objIndex: 1 }); // flag #1 on that tile
    // dist_col/row = 0 (arrived), neg_dist1=-128 (way back), neg_dist2=1 (loaded), flags=8 (dest_reached)
    const serf = mkSerf({ index: 1, state: 16, type, col: 20, row: 20, counter: 0, tick: state.gameTick - 1, stateData: [0, 0, 0x80, 1, 8] });
    state.serfs[1] = serf;
    return { state, serf, pos };
  }

  it('lumberjack hands over lumber (6) -> slot 0, hasResources, resourceCount[6]++, state 6', () => {
    const { state, serf } = returner(5);
    dispatchSerf(state, serf);
    const f = state.flags[1]!;
    expect(f.resourceSlots[0]).toBe(6); // Lumber
    expect(f.slotDir[0]).toBe(-1); // DirectionNone
    expect(f.slotDest[0]).toBe(0);
    expect(f.hasResources).toBe(true);
    expect(state.players[0]!.resourceCount[6]).toBe(1);
    expect(serf.state).toBe(6); // ReadyToEnter
  });

  it('Steinmetz→Stone(9), Fischer→Fish(0), Bauer→Wheat(3)', () => {
    for (const [type, res] of [[7, 9], [11, 0], [14, 3]] as const) {
      const { state, serf } = returner(type);
      dispatchSerf(state, serf);
      expect(state.flags[1]!.resourceSlots[0]).toBe(res);
      expect(state.players[0]!.resourceCount[res]).toBe(1);
    }
  });

  it('unloaded (neg_dist2=0) -> no drop, straight to ReadyToEnter', () => {
    const { state, serf } = returner(5);
    serf.stateData[3] = 0; // neg_dist2 = 0
    dispatchSerf(state, serf);
    expect(state.flags[1]!.resourceSlots[0]).toBe(-1); // nichts abgelegt
    expect(state.players[0]!.resourceCount[6]).toBe(0);
    expect(serf.state).toBe(6);
  });

  it('the forester carries nothing -> no drop despite neg_dist2>0', () => {
    const { state, serf } = returner(8); // Forester
    dispatchSerf(state, serf);
    expect(state.flags[1]!.resourceSlots[0]).toBe(-1);
    expect(serf.state).toBe(6);
  });

  it('full flag (all 8 slots taken) -> the good is lost, no resourceCount++', () => {
    const { state, serf } = returner(5);
    state.flags[1]!.resourceSlots = [0, 1, 2, 3, 4, 5, 7, 8]; // all taken (no -1)
    dispatchSerf(state, serf);
    expect(state.players[0]!.resourceCount[6]).toBe(0); // nichts gutgeschrieben
    expect(serf.state).toBe(6);
  });
});

describe('Planning-Suchen (RNG-Spiral)', () => {
  it('PlanningLogging (18): Baum am Spiral-Ziel → ReadyToLeave/LeavingBuilding', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 }); // building at that spot
    state.mapTiles[neighbor(pos, Direction.DownRight, geo)] = tile({ objIndex: 1 }); // Flagge frei
    // Ersten RNG-Wurf vorhersehen → Baum an spiralPos(pos, dist) platzieren.
    const dist = ((new Rng([1, 2, 3]).next() >> 2) & 0x7f) + 1;
    state.mapTiles[spiralPos(pos, dist, geo)] = tile({ object: 10 }); // Baum (8..23)
    const serf = mkSerf({ index: 1, state: 18, tick: 999, counter: 0, type: 5 });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    // gefunden → Austritt eingeleitet (ReadyToLeave 7 blockiert, oder LeavingBuilding 5).
    expect([5, 7]).toContain(serf.state);
    expect(serf.stateData[4]).toBeDefined();
  });

  it('PlanningStoneCutting (21): stone at UpLeft of the spiral target -> next_state StoneCutterFreeWalking(22)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.mapTiles[neighbor(pos, Direction.DownRight, geo)] = tile({ objIndex: 1 });
    const dist = ((new Rng([1, 2, 3]).next() >> 2) & 0x7f) + 1;
    const dp = spiralPos(pos, dist, geo);
    state.mapTiles[dp] = tile({ object: 0 }); // Ziel begehbar
    state.mapTiles[neighbor(dp, Direction.UpLeft, geo)] = tile({ object: 72 }); // Stein
    const serf = mkSerf({ index: 1, state: 21, tick: 999, counter: 0, type: 7 });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect([5, 7]).toContain(serf.state);
    expect(serf.stateData[4]).toBe(0x16); // next_state = 22 (nur bei state 7 sichtbar)
  });
});
