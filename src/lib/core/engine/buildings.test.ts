import { describe, it, expect } from 'vitest';
import { updateBuildings, demolishBuilding } from './buildings.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import type { GameState, Building, Flag, Player, Tile, Serf } from './state.js';

/**
 * `LAB_000132e2` phase B — material request priority: `prio = fill<8 ? (base8>>fill) : 0` with
 * `base8 = slider>>8` or 0xff, gated on holder + not constructing, per building type its own
 * slot/slider.
 */
function bld(over: Partial<Building> = {}): Building {
  return {
    index: 1,
    type: 15, // Mill
    owner: 0,
    flag: 1,
    holder: true,
    constructing: false,
    burning: false,
    stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
    stockMaximum: [0, 0],
    ...over,
  } as unknown as Building;
}
function flag(): Flag {
  return { index: 1, stockPriority: [0, 0], bldFlags: 0, bld2Flags: 0 } as unknown as Flag;
}
function player(over: Partial<Player> = {}): Player {
  return {
    foodDistribution: [0, 0, 0, 0],
    planksDistribution: [0, 0, 0],
    steelDistribution: [0, 0],
    coalDistribution: [0, 0, 0],
    wheatDistribution: [0, 0],
    ...over,
  } as unknown as Player;
}
function state(b: Building, f: Flag, p: Player): GameState {
  return { buildings: [null, b], flags: [null, f], players: [p] } as unknown as GameState;
}

describe('updateBuildings — phase B material demand priority', () => {
  it('Mill (Wheat, Slot 0): prio = (wheat_mill>>8) >> fill', () => {
    const f = flag();
 // wheat_mill = 0xB300 -> >>8 = 0xB3 = 179; fill = avail+req = 2 -> 179>>2 = 44
    const b = bld({ type: 15, stock: [{ available: 1, requested: 1 }, { available: 0, requested: 0 }] });
    updateBuildings(state(b, f, player({ wheatDistribution: [0, 0xb300] })));
    expect(f.stockPriority[0]).toBe(179 >> 2);
    expect(f.stockPriority[1]).toBe(0); // the mill does not touch slot 1
  });

  it('sawmill (lumber, slot 1): base is the constant 0xff, no slider', () => {
    const f = flag();
 // fill = 3 -> 0xff>>3 = 31
    const b = bld({ type: 17, stock: [{ available: 0, requested: 0 }, { available: 2, requested: 1 }] });
    updateBuildings(state(b, f, player()));
    expect(f.stockPriority[1]).toBe(0xff >> 3);
    expect(f.stockPriority[0]).toBe(0); // sawmill slot 0 untouched
  });

  it('steel smelter: slot 0 = coal_steelsmelter slider, slot 1 = 0xff (iron)', () => {
    const f = flag();
    const b = bld({
      type: 18,
      stock: [{ available: 0, requested: 0 }, { available: 1, requested: 0 }],
    });
    updateBuildings(state(b, f, player({ coalDistribution: [0xff00, 0, 0] })));
    expect(f.stockPriority[0]).toBe(0xff >> 0); // coal fill 0 -> 0xff
    expect(f.stockPriority[1]).toBe(0xff >> 1); // iron fill 1 -> 0x7f
  });

  it('fill >= 8 -> priority 0 (slot full)', () => {
    const f = flag();
    const b = bld({ type: 15, stock: [{ available: 5, requested: 3 }, { available: 0, requested: 0 }] });
    updateBuildings(state(b, f, player({ wheatDistribution: [0, 0xff00] })));
    expect(f.stockPriority[0]).toBe(0);
  });

  it('unoccupied (holder=false) -> phase B does not run', () => {
    const f = flag();
    f.stockPriority[0] = 7; // pre-existing value survives
    const b = bld({ type: 15, holder: false, stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }] });
    updateBuildings(state(b, f, player({ wheatDistribution: [0, 0xff00] })));
    expect(f.stockPriority[0]).toBe(7);
  });

  it('under construction -> production demand does not run', () => {
    const f = flag();
    const b = bld({ type: 7, constructing: true, stock: [{ available: 0, requested: 3 }, { available: 0, requested: 0 }] });
    updateBuildings(state(b, f, player({ foodDistribution: [0, 0, 0xff00, 0] })));
    expect(f.stockPriority[0]).toBe(0);
  });

  it('non-production building (e.g. lumberjack) -> no input demand', () => {
    const f = flag();
    const b = bld({ type: 2 }); // lumberjack (no input)
    updateBuildings(state(b, f, player()));
    expect(f.stockPriority[0]).toBe(0);
    expect(f.stockPriority[1]).toBe(0);
  });
});

/**
 * `LAB_000132e2` head branch — construction material demand (`FUN_000138ed` @0x138ed). Slot 0 =
 * planks (slider `planksDistribution[0]`), slot 1 = stone (0xff); `prio = (base>>fill) [>>2 if
 * !holder] & 0xfe`, gated on `fill<8 && fill != stockMaximum[slot]` and `constructing && progress != 0`.
 */
describe('updateBuildings — construction material demand (head branch)', () => {
  it('coal mine under construction (holder=false, stockMax=[5,0]): planks demanded, stone not', () => {
    const f = flag();
 // Coal mine (type 6) under construction: needs planks (stockMax[0]=5), no stone (stockMax[1]=0).
    const b = bld({
      type: 6,
      constructing: true,
      progress: 1,
      holder: false,
      stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
      stockMaximum: [5, 0],
    });
    updateBuildings(state(b, f, player({ planksDistribution: [0xff00, 0, 0] })));
 // Planks: base=0xff, fill=0 -> 0xff>>0=255, !holder -> >>2=63, &0xfe=62
    expect(f.stockPriority[0]).toBe(62);
 // Stone: fill=0 == stockMax[1]=0 -> no demand
    expect(f.stockPriority[1]).toBe(0);
  });

  it('hut under construction (holder=false, stockMax=[1,1]): planks AND stone demanded', () => {
    const f = flag();
    const b = bld({
      type: 11,
      constructing: true,
      progress: 1,
      holder: false,
      stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
      stockMaximum: [1, 1],
    });
    updateBuildings(state(b, f, player({ planksDistribution: [0xff00, 0, 0] })));
    expect(f.stockPriority[0]).toBe(62); // planks via the slider
    expect(f.stockPriority[1]).toBe(62); // stone: 0xff>>0=255, >>2=63, &0xfe=62
  });

  it('occupied construction site (holder=true): no >>2 throttling', () => {
    const f = flag();
    const b = bld({
      type: 11,
      constructing: true,
      progress: 1,
      holder: true,
      stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
      stockMaximum: [1, 1],
    });
    updateBuildings(state(b, f, player({ planksDistribution: [0xff00, 0, 0] })));
    expect(f.stockPriority[0]).toBe(0xff & 0xfe); // 0xff>>0=255, no >>2, &0xfe=254
    expect(f.stockPriority[1]).toBe(254);
  });

  it('material full (fill == stockMaximum) -> priority 0', () => {
    const f = flag();
    const b = bld({
      type: 11,
      constructing: true,
      progress: 1,
      holder: true,
      stock: [{ available: 1, requested: 0 }, { available: 0, requested: 1 }], // fill 1/1
      stockMaximum: [1, 1],
    });
    updateBuildings(state(b, f, player({ planksDistribution: [0xff00, 0, 0] })));
    expect(f.stockPriority[0]).toBe(0);
    expect(f.stockPriority[1]).toBe(0);
  });

  it('fill > 0: priority drops with the fill level (>> fill)', () => {
    const f = flag();
    const b = bld({
      type: 11,
      constructing: true,
      progress: 1,
      holder: true,
      stock: [{ available: 2, requested: 0 }, { available: 0, requested: 0 }], // fill slot0=2
      stockMaximum: [5, 5],
    });
    updateBuildings(state(b, f, player({ planksDistribution: [0xff00, 0, 0] })));
    expect(f.stockPriority[0]).toBe((0xff >> 2) & 0xfe); // 63&0xfe = 62
  });

  it('progress == 0 (still levelling) -> priority untouched', () => {
    const f = flag();
    f.stockPriority[0] = 9; // pre-existing
    const b = bld({
      type: 11,
      constructing: true,
      progress: 0,
      holder: false,
      stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
      stockMaximum: [1, 1],
    });
    updateBuildings(state(b, f, player({ planksDistribution: [0xff00, 0, 0] })));
    expect(f.stockPriority[0]).toBe(9);
  });
});

/**
 * Razing a building. Pinned to the byte deltas of a real demolition of forester hut #48 (type 9,
 * owner 0) at (22,4): pos == 278, flag tile (DownRight) == 343.
 */
describe('razing a building', () => {
  const GEO = mapGeometry(3); // 64×64
  const COL = 22, ROW = 4;
  const POS = posOf(COL, ROW, GEO); // 278
  const FLAG_POS = neighbor(POS, Direction.DownRight, GEO); // 343

  function tile(over: Partial<Tile> = {}): Tile {
    return {
      height: 0, terrainUp: 0, terrainDown: 0, object: 0, owner: 0, paths: 0,
      blocked: false, mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0, ...over,
    } as Tile;
  }
  function forester(over: Partial<Building> = {}): Building {
    return {
      index: 48, type: 9, owner: 0, flag: 71, col: COL, row: ROW,
      holder: true, constructing: false, burning: false, playingSfx: false,
      firstKnight: 399, progress: 0, level: 4970,
      stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
      stockMaximum: null, ...over,
    } as unknown as Building;
  }
  function razeState(b: Building, gameTick: number): { state: GameState; f: Flag; p: Player } {
    const f = {
      index: 71, hasBuilding: true, hasResources: false, acceptsSerfs: false, acceptsResources: false,
      connections: [null, null, null, null, { kind: 'building', index: 48 }, null],
      paths: [false, false, false, true, true, true], transporters: [false, false, false, false, false, false],
 // `flag[4]` == land-road bits: for flag-to-flag roads always set together with `paths`, never on
 // the building link (dir 4).
      endpointDirs: [false, false, false, true, false, true],
      length: [0, 0, 0, 0, 0, 0], otherEndDir: [0, 0, 0, 0, 0, 0],
      resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1], slotDir: [-1, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
    } as unknown as Flag;
    const p = {
      totalBuildingScore: 80, totalMilitaryScore: 142,
      completedBuildingCount: new Array(23).fill(0), incompleteBuildingCount: new Array(23).fill(0),
    } as unknown as Player;
    p.completedBuildingCount[8] = 1; // type 9 -> index 8
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    mapTiles[POS] = tile({ object: 2, objIndex: 48, paths: 2, blocked: true, owner: 1 });
    mapTiles[FLAG_POS] = tile({ object: 1, objIndex: 71, paths: 56, owner: 1 }); // bits 3,4,5
    const buildings: (Building | null)[] = new Array(76).fill(null); // dense, no holes
    buildings[48] = b;
 // Holder serf #399 (the building's worker/knight) — ejected on demolition (ejectHolderSerfs).
    const serfs: (Serf | null)[] = new Array(400).fill(null);
    serfs[399] = {
      index: 399, owner: 0, type: 8, col: COL, row: ROW, tick: 0, state: 19,
      animation: 0, counter: 0, sound: false, stateData: [0, 0, 0, 0, 0],
    } as unknown as Serf;
    const state = {
      buildings, serfs, flags: [], inventories: [], players: [p], mapTiles, geo: GEO, gameTick,
 // `mapGoldTotal` is the map gold counter (gs+0x4c), which the demolition adjusts.
      header: { mapGoldTotal: 1000 },
      blockMeta: {
        buildings: { recordSize: 18, maxIndex: 76 },
        flags: { recordSize: 70, maxIndex: 72 },
        inventories: { recordSize: 120, maxIndex: 0 },
      },
    } as unknown as GameState;
    (state.flags as (Flag | null)[])[71] = f;
    return { state, f, p };
  }

  it('demolishBuilding — the byte-exact pre-to-burning deltas', () => {
    const b = forester();
    const { state, f, p } = razeState(b, 43508); // demolition tick
    demolishBuilding(state, b);
 // Building record
    expect(b.burning).toBe(true);
    expect(b.firstKnight).toBe(0x7ff); // countdown init
    expect(b.level).toBe(43508); // burn tick == gameTick
    expect(b.holder).toBe(false);
 // Score (type 9: BUILDING_SCORE=2)
    expect(p.totalBuildingScore).toBe(78);
    expect(p.completedBuildingCount[8]).toBe(0);
    expect(p.totalMilitaryScore).toBe(142); // untouched
 // Flag detached
    expect(f.hasBuilding).toBe(false);
    expect(f.acceptsSerfs).toBe(false);
    expect(f.connections[Direction.UpLeft]).toBeNull();
 // Tile road bits
    expect(state.mapTiles[POS].paths).toBe(0); // 2 & ~2
    expect(state.mapTiles[FLAG_POS].paths).toBe(40); // 56 & ~16
 // The object still stands here; it only disappears in the finale
    expect(state.mapTiles[POS].object).toBe(2);
    expect(state.mapTiles[POS].blocked).toBe(true);
 // Holder serf ejected: it is not the tile occupant (tile.serfIndex==0) -> EscapeBuilding (28).
 // (In the real save it drifts on to FreeWalking(16) over 1348 ticks; the immediate state is 28.)
    expect(state.serfs[399]?.state).toBe(28);
  });

  it('tail end: a flag left without roads is removed too (@0x49742-@0x497a7)', () => {
    const b = forester();
    const { state, f } = razeState(b, 43508);
 // The flag hangs on the building ONLY (road bit UpLeft) — after the demolition it has no roads.
    state.mapTiles[FLAG_POS].paths = 1 << Direction.UpLeft;
    (f.paths as boolean[]) = [false, false, false, false, true, false];
    demolishBuilding(state, b);
    expect(state.mapTiles[FLAG_POS].paths).toBe(0); // condition `paths & 0x3f == 0`
 // demolish_flag ran: tile object cleared + slot released.
    expect(state.mapTiles[FLAG_POS].object).toBe(0);
    expect(state.mapTiles[FLAG_POS].objIndex).toBe(0);
    expect(state.flags[71]).toBeNull();
  });

  it('...but NOT while the flag still has a road (the counter case)', () => {
    const b = forester();
    const { state } = razeState(b, 43508); // tile paths 56 -> 40 after the demolition, != 0
    demolishBuilding(state, b);
    expect(state.mapTiles[FLAG_POS].paths).toBe(40);
    expect(state.mapTiles[FLAG_POS].object).toBe(1); // the flag stays
    expect(state.flags[71]).not.toBeNull();
  });

  it('...and not when there is no flag on the tile at all (`object & 0x7f == 1`)', () => {
    const b = forester();
    const { state } = razeState(b, 43508);
    state.mapTiles[FLAG_POS].paths = 1 << Direction.UpLeft;
    state.mapTiles[FLAG_POS].object = 0; // no flag object
    demolishBuilding(state, b);
    expect(state.flags[71]).not.toBeNull();
  });

  it('ejectHolderSerfs on a garrison chain: the tile occupant -> Lost(25), the rest -> EscapeBuilding(28)', () => {
 // Hut (type 11) with 2 knights in the garrison chain firstKnight #399 -> serf[0xe]=#398.
    const b = forester({ type: 11, active: true, firstKnight: 399 });
    const { state } = razeState(b, 43508);
 // #399 is the visible occupant of the building tile -> Lost(25).
    state.mapTiles[POS].serfIndex = 399;
    (state.serfs as (Serf | null)[])[399] = {
      index: 399, owner: 0, type: 24, col: COL, row: ROW, tick: 0, state: 70,
      animation: 0, counter: 6000, sound: false, stateData: [0, 0, 0, 398 & 0xff, (398 >> 8) & 0xff],
    } as unknown as Serf; // serf[0xe] (next knight) = stateData[3..4] = 398
 // #398 does not occupy a tile pointing at it -> EscapeBuilding(28).
    (state.serfs as (Serf | null)[])[398] = {
      index: 398, owner: 0, type: 24, col: COL, row: ROW, tick: 0, state: 70,
      animation: 0, counter: 6000, sound: false, stateData: [0, 0, 0, 0, 0],
    } as unknown as Serf;
    demolishBuilding(state, b);
    expect(state.serfs[399]?.state).toBe(25); // tile occupant -> Lost
    expect(state.serfs[399]?.stateData[0]).toBe(0); // serf[0xb] = 0 in the Lost case
    expect(state.serfs[398]?.state).toBe(28); // inside the building -> EscapeBuilding
  });

  it('guard: already burning -> no-op', () => {
    const b = forester({ burning: true, firstKnight: 500 });
    const { state, p } = razeState(b, 43508);
    demolishBuilding(state, b);
    expect(b.firstKnight).toBe(500); // countdown unchanged
    expect(p.totalBuildingScore).toBe(80); // no second deduction
  });

  it('a building under construction: incompleteBuildingCount instead of the score', () => {
    const b = forester({ constructing: true });
    const { state, p } = razeState(b, 43508);
    p.incompleteBuildingCount[8] = 1;
    demolishBuilding(state, b);
    expect(p.incompleteBuildingCount[8]).toBe(0);
    expect(p.totalBuildingScore).toBe(80); // no score deduction for a shell
    expect(p.completedBuildingCount[8]).toBe(1); // untouched
  });

  it('countdown + finale: the building disappears, tile cleared, slot released', () => {
    const b = forester({ burning: true, firstKnight: 1, level: 100, holder: false });
    const { state } = razeState(b, 100);
 // Tick 101: elapsed 1, countdown 1 -> 0 (no underflow)
    state.gameTick = 101;
    updateBuildings(state);
    expect(state.buildings[48]).not.toBeNull();
    expect(b.firstKnight).toBe(0);
 // Tick 102: elapsed 1, old countdown 0 < 1 -> finale
    state.gameTick = 102;
    updateBuildings(state);
    expect(state.buildings[48]).toBeNull(); // slot released
    expect(state.mapTiles[POS].object).toBe(0);
    expect(state.mapTiles[POS].blocked).toBe(false);
    expect(state.mapTiles[POS].objIndex).toBe(0);
 // bld#48 is not the highest (maxIndex 76) -> maxIndex unchanged
    expect(state.blockMeta.buildings.maxIndex).toBe(76);
  });

  it('demolishing a military building retracts the territory', () => {
 // Hut (type 11, military, active) at (22,4); its footprint belongs to P0 (owner tile = 1). After
 // the demolition it is `burning`, so it is out of the influence and its land becomes unclaimed.
    const b = forester({ type: 11, active: true });
    const { state } = razeState(b, 43508);
 // Mark the footprint as P0 land (centre + near ring).
    for (const [dc, dr] of [[0, 0], [1, 1], [-1, 0], [0, -1]] as const) {
      const t = state.mapTiles[posOf((COL + dc) & 63, (ROW + dr) & (state.geo.rowMask), state.geo)];
      t.owner = 1;
    }
    expect(state.mapTiles[POS].owner).toBe(1);
    demolishBuilding(state, b);
    expect(b.burning).toBe(true);
    expect(state.mapTiles[POS].owner).toBe(0); // land retracted (no other military buildings)
  });

  it('finale on the highest slot: maxBuildingIndex follows', () => {
    const b = forester({ index: 75, burning: true, firstKnight: 0, level: 100, holder: false });
    const { state } = razeState(b, 100);
 // Put b in slot 75, empty slot 48; maxIndex = 76
    (state.buildings as (Building | null)[])[48] = null;
    (state.buildings as (Building | null)[])[75] = b;
    (state.buildings as (Building | null)[])[40] = forester({ index: 40 }); // next occupied one below
    state.blockMeta.buildings.maxIndex = 76;
    state.gameTick = 101; // elapsed 1, old countdown 0 < 1 -> finale
    updateBuildings(state);
    expect(state.buildings[75]).toBeNull();
    expect(state.blockMeta.buildings.maxIndex).toBe(41); // highest occupied (40) + 1
  });
});

describe('updateBuildings — phase A (request_serf), grouped into the driver (FUN_000130f2)', () => {
 // request_serf is the head of the per-type handler, so part of updateBuildings — frame boundary only.
  it('runs phase A ONLY on the frame boundary', () => {
    const f = { index: 1, stockPriority: [0, 0], bldFlags: 0, bld2Flags: 0, endpointDirs: [false, false, false, false, false, false], connections: [null, null, null, null, null, null] } as unknown as Flag;
    const b = bld({ type: 15, holder: false, constructing: false }); // mill, unoccupied -> requests a worker
    const st = { buildings: [null, b], flags: [null, f], players: [player()], inventories: [], serfs: [], rotation: 0 } as unknown as GameState;
 // No frame boundary -> phase A does not run.
    updateBuildings(st, false);
    expect(b.serfRequestFailed).toBeFalsy();
 // Frame boundary -> phase A: no inventory reachable (flag without connections) -> serfRequestFailed.
    updateBuildings(st, true);
    expect(b.serfRequestFailed).toBe(true);
  });
});
