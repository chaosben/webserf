import { describe, it, expect } from 'vitest';
import { dispatchSerf } from './serf-machine.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import { Rng } from './rng.js';
import type { GameState, Serf, Building, Tile, Flag, Player } from './state.js';

/**
 * Random-driven in-building processors: 40 MakingTool, 37 PigFarming, 41 BuildingBoat. Only the
 * deterministic parts are checked (consumption, build steps, byte-9 counter / pig count, handover);
 * the concrete random choice cannot be byte-equal to DOS.
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
    index: 1, type: 19, owner: 0, progress: 0, active: false, playingSfx: false,
    stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
    inventoryIndex: null, ...over,
  } as unknown as Building;
}
function flag(): Flag {
  return {
    index: 1, resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDir: [-1, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], hasResources: false,
  } as unknown as Flag;
}
function player(toolPriority?: number[]): Player {
  return { index: 0, resourceCount: new Array(26).fill(0), toolPriority: toolPriority ?? new Array(9).fill(0) } as unknown as Player;
}
function makeState(toolPriority?: number[]): GameState {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  return {
    geo, gameTick: 1000, mapTiles,
    serfs: [null] as (Serf | null)[],
    buildings: [null, bld()] as (Building | null)[],
    flags: [null, flag()] as (Flag | null)[],
    players: [player(toolPriority), null, null, null] as (Player | null)[],
    rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number; state: number }): Serf {
  return {
    counter: 0, tick: 999, animation: 0, owner: 0, col: 20, row: 20, stateData: [0, 0, 0, 0, 0], ...over,
  } as unknown as Serf;
}
/** Building + occupied serf field + free flag (DownRight) - the standard setup for leaving. */
function place(state: GameState, b: Building): number {
  const pos = posOf(20, 20, geo);
  state.mapTiles[pos] = tile({ objIndex: 1, serfIndex: 1 });
  state.mapTiles[neighbor(pos, Direction.DownRight, geo)] = tile({ objIndex: 1 });
  state.buildings[1] = b;
  return pos;
}

describe('MakingTool (40)', () => {
  it('Phase A: Stahl + Bretter vorhanden → beide verbrauchen, Anim 0x90, Counter 0x5ff', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ stock: [{ available: 2, requested: 0 }, { available: 3, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 40, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.stock[0].available).toBe(1);
    expect(state.buildings[1]!.stock[1].available).toBe(2);
    expect(serf.stateData[0]).toBe(1);
    expect(serf.animation).toBe(0x90);
    expect(serf.counter).toBe(0x5ff);
    expect(state.mapTiles[pos].serfIndex).toBe(1);
  });

  it('phase A: an input is missing -> wait (no mutation)', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ stock: [{ available: 2, requested: 0 }, { available: 0, requested: 0 }] });
    const serf = mkSerf({ index: 1, state: 40, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(0);
    expect(state.buildings[1]!.stock[0].available).toBe(2);
  });

  it('build step: field_0xb counts up (intermediate step, not finished)', () => {
    const state = makeState();
    place(state, bld());
    // counter high so that +0x600 carries at once -> wait after one step.
    const serf = mkSerf({ index: 1, state: 40, tick: 999, counter: 0, stateData: [1, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(2); // one step on, not 4 yet
    expect(serf.state).toBe(40);
  });

  it('field_0xb erreicht 4 → Werkzeug fertig, Produktions-Stat++, Feld frei, Zustand ≠ 40', () => {
    // toolPriority alle 0 → gleichverteilte Wahl; res+1 ∈ [16,24] → resourceCount[15..23].
    const state = makeState();
    place(state, bld());
    const serf = mkSerf({ index: 1, state: 40, tick: 999, counter: 0, stateData: [3, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    const rc = state.players[0]!.resourceCount as number[];
    const produced = rc.slice(15, 24).reduce((a, b) => a + b, 0);
    expect(produced).toBe(1); // exactly one tool (shovel..pincer)
    expect(state.mapTiles[posOf(20, 20, geo)].serfIndex).toBe(0);
    expect(serf.state).not.toBe(40);
  });

  it('weighted choice: only one non-zero tool_prio -> exactly that tool', () => {
    const tp = new Array(9).fill(0);
    tp[3] = 0xffff; // nur Werkzeug-Index 3 (res 15+3 = 18 = Cleaver)
    const state = makeState(tp);
    place(state, bld());
    const serf = mkSerf({ index: 1, state: 40, tick: 999, counter: 0, stateData: [3, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect((state.players[0]!.resourceCount as number[])[18]).toBe(1); // Cleaver (res 18)
  });
});

describe('PigFarming (37)', () => {
  it('Phase A: Getreide vorhanden → verbrauchen, Anim 0x8b, Counter 0x17f', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 14, stock: [{ available: 3, requested: 0 }, { available: 0, requested: 5 }] });
    const serf = mkSerf({ index: 1, state: 37, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.stock[0].available).toBe(2);
    expect(serf.stateData[0]).toBe(1);
    expect(serf.animation).toBe(0x8b);
    expect(serf.counter).toBe(0x17f);
  });

  it('8 Schweine → schlachten: Schwein abziehen, Pig (res+1=2) raustragen', () => {
    const state = makeState();
    // Byte 9 = 8 Schweine (av0, rq8), Modus 6 → Schleife: mode 7 (ungerade) → Schlacht-Entscheidung.
    place(state, bld({ type: 14, stock: [{ available: 0, requested: 0 }, { available: 0, requested: 8 }] }));
    const serf = mkSerf({ index: 1, state: 37, tick: 999, counter: 0, stateData: [6, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    // rawByte9 == 7 (one pig slaughtered)
    const b = state.buildings[1]!;
    expect((b.stock[1].available << 4) | b.stock[1].requested).toBe(7);
    expect(state.players[0]!.resourceCount[1]).toBe(1); // Pig(1)-Produktion +1
    expect(serf.state).not.toBe(37);
  });

  it('breeding: the even mode adds a piglet on a successful roll', () => {
    // 1 Schwein (rq1), Modus 1 → Schleife mode 2 (gerade, Zucht). breeding_prob[1]=6000.
    const state = makeState();
    place(state, bld({ type: 14, stock: [{ available: 0, requested: 0 }, { available: 0, requested: 1 }] }));
    // counter set so that the even mode carries -> wait (one breeding attempt per tick).
    const serf = mkSerf({ index: 1, state: 37, tick: 999, counter: 0, stateData: [1, 0, 0, 0, 0] });
    state.serfs[1] = serf;
    const rng0 = new Rng([1, 2, 3]).next();

    dispatchSerf(state, serf);

    const b = state.buildings[1]!;
    const pigs = (b.stock[1].available << 4) | b.stock[1].requested;
    // rng0 < 6000 => piglet added (2), otherwise unchanged (1).
    expect(pigs).toBe(rng0 < 6000 ? 2 : 1);
    expect(state.mapTiles[posOf(20, 20, geo)].serfIndex).toBe(0); // serf gone (feeding)
  });
});

describe('BuildingBoat (41)', () => {
  it('phase A: planks present -> consume, counter 0, anim 0x92, counter 0x9f', () => {
    const state = makeState();
    const pos = posOf(20, 20, geo);
    state.mapTiles[pos] = tile({ objIndex: 1 });
    state.buildings[1] = bld({ type: 3, stock: [{ available: 4, requested: 0 }, { available: 0, requested: 5 }] });
    const serf = mkSerf({ index: 1, state: 41, stateData: [0, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.buildings[1]!.stock[0].available).toBe(3);
    expect(state.buildings[1]!.stock[1].available).toBe(0); // counter byte 9 reset
    expect(state.buildings[1]!.stock[1].requested).toBe(0);
    expect(serf.stateData[0]).toBe(1);
    expect(serf.animation).toBe(0x92);
    expect(serf.counter).toBe(0x9f);
  });

  it('build step: counter (byte 9) up, anim 0x91', () => {
    const state = makeState();
    place(state, bld({ type: 3 }));
    const serf = mkSerf({ index: 1, state: 41, tick: 999, counter: 0, stateData: [1, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    const b = state.buildings[1]!;
    expect((b.stock[1].available << 4) | b.stock[1].requested).toBe(1); // one build step
    expect(serf.stateData[0]).toBe(2);
    expect(serf.animation).toBe(0x91);
  });

  it('Schritt 9, Flagge frei → Boot (res+1=9) raustragen', () => {
    const state = makeState();
    place(state, bld({ type: 3, stock: [{ available: 0, requested: 0 }, { available: 0, requested: 7 }] }));
    const serf = mkSerf({ index: 1, state: 41, tick: 999, counter: 0, stateData: [8, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(state.players[0]!.resourceCount[8]).toBe(1); // Boat(8)-Produktion +1
    expect(serf.state).not.toBe(41);
  });

  it('step 9 with an occupied flag -> back to step 8, wait', () => {
    const state = makeState();
    const pos = place(state, bld({ type: 3 }));
    // Flaggen-Feld belegt.
    state.mapTiles[neighbor(pos, Direction.DownRight, geo)] = tile({ objIndex: 1, serfIndex: 99 });
    const serf = mkSerf({ index: 1, state: 41, tick: 999, counter: 0, stateData: [8, 0, 0, 0, 0] });
    state.serfs[1] = serf;

    dispatchSerf(state, serf);

    expect(serf.stateData[0]).toBe(8); // wartet weiter
    expect(serf.counter).toBe(0);
    expect(serf.state).toBe(41);
  });
});
