import { describe, it, expect } from 'vitest';
import {
  classifyBuildSite,
  buildFlag,
  canBuildFlag,
  canPlaceBuilding,
  placeBuilding,
  OBJECT_CLASS,
  CONSTRUCTION_COST,
  CURSOR_NONE,
  CURSOR_FLAG,
  CURSOR_REMOVABLE_FLAG,
  CURSOR_BUILDING,
  CURSOR_PATH,
  CURSOR_CLEAR_BY_FLAG,
  CURSOR_CLEAR_BY_PATH,
  CURSOR_CLEAR,
  BUILD_NONE,
  BUILD_FLAG,
  BUILD_MINE,
  BUILD_SMALL,
  BUILD_LARGE,
  BUILD_CASTLE,
  buildMenuClickOutcome,
  persistBuildSiteBits,
} from './build-site.js';
import { demolishForPendingBuild } from './demolish.js';
import { buildMenuOutcomeSound } from '../ui-sound.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import type { GameState, Building, Flag, Player, Tile } from './state.js';

/**
 * Synthetic 64x64 map: all grass-5 (buildable), height 10, owner = player 0 (tile owner 1). With no
 * further ingredients the classification yields "free tile, large building possible" — each test then
 * changes exactly **one** property and checks the rule that depends on it.
 */
const geo = mapGeometry(3);

function tile(over: Partial<Tile> = {}): Tile {
  return {
    height: 10,
    terrainUp: 5,
    terrainDown: 5,
    object: 0,
    owner: 1,
    paths: 0,
    blocked: false,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: 0,
    ...over,
  };
}

function player(over: Partial<Player> = {}): Player {
  return {
    slot: 0,
    index: 0,
    active: true,
    flags: 1, // bit 0 = castle exists (regular play)
    build: 0,
    completedBuildingCount: new Array(23).fill(0),
    incompleteBuildingCount: new Array(23).fill(0),
    messageFlags: 0,
    messageBuildingSlots: [0, 0, 0],
    ...over,
  } as unknown as Player;
}

function state(over: Partial<GameState> = {}): GameState {
  const mapTiles: Tile[] = [];
  for (let i = 0; i < geo.cols * geo.rows; i++) mapTiles.push(tile());
  return {
    geo,
    mapTiles,
    buildings: [null],
    flags: [null],
    serfs: [],
    inventories: [],
    players: [player()],
    header: { maxBuildingIndex: 1, maxFlagIndex: 1, warehouseLimit: 361, mapGoldTotal: 1000 },
    blockMeta: { buildings: { maxIndex: 1 }, flags: { maxIndex: 1 } },
    ...over,
  } as unknown as GameState;
}

/** Modify the tile at (col,row) in the state. */
function at(st: GameState, col: number, row: number): Tile {
  return st.mapTiles[posOf(col, row, geo)];
}

describe('binary tables', () => {
  it('OBJECT_CLASS maps the occupied object values onto the expected classes', () => {
    expect(OBJECT_CLASS).toHaveLength(128);
    expect(OBJECT_CLASS[0]).toBe(0); // frei
    expect(OBJECT_CLASS[1]).toBe(3); // Flagge
    expect(OBJECT_CLASS[2]).toBe(4); // small building
    expect(OBJECT_CLASS[3]).toBe(5); // large building
    expect(OBJECT_CLASS[4]).toBe(6); // Schloss
    for (let obj = 8; obj <= 27; obj++) expect(OBJECT_CLASS[obj]).toBe(1); // trees
    for (let obj = 72; obj <= 79; obj++) expect(OBJECT_CLASS[obj]).toBe(2); // Stein-Haufen-Stufen
    expect(OBJECT_CLASS[127]).toBe(255); // Endmarke
  });

  it('CONSTRUCTION_COST deckt alle 25 Typen ab (Fortress 5/5, Hut 1/1, Schloss 0/0)', () => {
    expect(CONSTRUCTION_COST).toHaveLength(25);
    expect(CONSTRUCTION_COST[11]).toEqual([1, 1]); // Hut
    expect(CONSTRUCTION_COST[22]).toEqual([5, 5]); // Fortress
    expect(CONSTRUCTION_COST[24]).toEqual([0, 0]); // Castle
  });
});

describe('persistBuildSiteBits — the two `player+3` bits the classifier writes', () => {
  it('sets and clears both bits (@0x3207d/@0x32528, @0x32938/@0x32958)', () => {
    const p = player({ build: 0 });
    persistBuildSiteBits(p, { flagBlocked: true, militaryBlocked: true } as never);
    expect(p.build & 0x3).toBe(0x3);
    persistBuildSiteBits(p, { flagBlocked: false, militaryBlocked: false } as never);
    expect(p.build & 0x3).toBe(0);
  });

  it('leaves the other `build` bits alone (bit 2 = population allowance, bit 3 = has castle)', () => {
    const p = player({ build: 0xfc });
    persistBuildSiteBits(p, { flagBlocked: false, militaryBlocked: true } as never);
    expect(p.build).toBe(0xfd);
  });

  it('passes on exactly what the classification determined', () => {
    const st = state();
    const p = st.players[0]!;
    // Neighbouring flag => no flag can be built here, a military building can.
    at(st, 11, 10).object = 1;
    const site = classifyBuildSite(st, p, 10, 10);
    persistBuildSiteBits(p, site);
    expect(site.flagBlocked).toBe(true);
    expect((p.build & 0x2) !== 0).toBe(true);
    expect((p.build & 0x1) !== 0).toBe(site.militaryBlocked);
  });
});

describe('classifyBuildSite — Cursor-Art', () => {
  it('free grass tile in own territory: clear + large building', () => {
    const st = state();
    const site = classifyBuildSite(st, st.players[0]!, 10, 10);
    expect(site.cursorType).toBe(CURSOR_CLEAR);
    expect(site.possibility).toBe(BUILD_LARGE);
    expect(site.levelingHeight).toBe(10); // all height 10 -> average 10
    expect(site.flagBlocked).toBe(false);
  });

  it('foreign or neutral land: nothing possible', () => {
    const st = state();
    at(st, 10, 10).owner = 2; // belongs to player 1
    expect(classifyBuildSite(st, st.players[0]!, 10, 10)).toMatchObject({
      cursorType: CURSOR_NONE,
      possibility: BUILD_NONE,
    });
    at(st, 10, 10).owner = 0; // niemandem
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_NONE);
  });

  it('without a castle the original demands unclaimed land and reports castle building', () => {
    const st = state();
    const p = player({ flags: 0 }); // bit 0 clear = no castle yet
    st.players[0] = p;
    for (let i = 0; i < st.mapTiles.length; i++) st.mapTiles[i].owner = 0;
    const site = classifyBuildSite(st, p, 10, 10);
    expect(site.cursorType).toBe(CURSOR_CLEAR);
    expect(site.possibility).toBe(BUILD_CASTLE);
    expect(site.levelingHeight).toBe(10);
  });

  it('road on the tile: path — only a flag can be built', () => {
    const st = state();
    at(st, 10, 10).paths = 0x01 | 0x08; // Right + Left
    const site = classifyBuildSite(st, st.players[0]!, 10, 10);
    expect(site.cursorType).toBe(CURSOR_PATH);
    expect(site.possibility).toBe(BUILD_FLAG);
  });

  it('exactly one road towards DownRight or UpLeft: nothing possible (building attach direction)', () => {
    for (const paths of [0x02, 0x10]) {
      const st = state();
      at(st, 10, 10).paths = paths;
      expect(classifyBuildSite(st, st.players[0]!, 10, 10)).toMatchObject({
        cursorType: CURSOR_NONE,
        possibility: BUILD_NONE,
      });
    }
  });

  it('flag on the DownRight tile: ClearByFlag; road there: ClearByPath', () => {
    const st = state();
    const dr = neighbor(posOf(10, 10, geo), Direction.DownRight, geo);
    st.mapTiles[dr].object = 1; // Flagge
    st.mapTiles[dr].objIndex = 1;
    st.flags[1] = { index: 1, paths: [false, false, false, false, false, false] } as unknown as Flag;
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_CLEAR_BY_FLAG);

    const st2 = state();
    st2.mapTiles[neighbor(posOf(10, 10, geo), Direction.DownRight, geo)].paths = 0x01;
    expect(classifyBuildSite(st2, st2.players[0]!, 10, 10).cursorType).toBe(CURSOR_CLEAR_BY_PATH);
  });

  it('building on the tile: building; castle and burning building: nothing', () => {
    const st = state();
    const t = at(st, 10, 10);
    t.object = 2; // small building
    t.objIndex = 1;
    st.buildings[1] = { index: 1, type: 2, owner: 0, burning: false } as unknown as Building;
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_BUILDING);

    st.buildings[1]!.burning = true;
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_NONE);

    t.object = 4; // Schloss
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_NONE);
  });
});

describe('classifyBuildSite — Flaggen-Zweig (entfernbar?)', () => {
  function withFlag(paths: boolean[], endpointDirs: boolean[], connections: unknown[]): GameState {
    const st = state();
    const t = at(st, 10, 10);
    t.object = 1;
    t.objIndex = 1;
    t.paths = paths.reduce((m, v, i) => (v ? m | (1 << i) : m), 0);
    st.flags[1] = { index: 1, paths, endpointDirs, connections } as unknown as Flag;
    return st;
  }

  it('a flag without roads is removable', () => {
    const st = withFlag([false, false, false, false, false, false], [false, false, false, false, false, false], [
      null, null, null, null, null, null,
    ]);
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_REMOVABLE_FLAG);
  });

  it('genau zwei Wege zu verschiedenen Endpunkten: entfernbar (Wege werden zusammengelegt)', () => {
    const st = withFlag(
      [true, false, false, true, false, false],
      [true, false, false, true, false, false],
      [{ kind: 'flag', index: 5 }, null, null, { kind: 'flag', index: 7 }, null, null],
    );
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_REMOVABLE_FLAG);
  });

  it('two roads to the SAME endpoint: not removable', () => {
    const st = withFlag(
      [true, false, false, true, false, false],
      [true, false, false, true, false, false],
      [{ kind: 'flag', index: 5 }, null, null, { kind: 'flag', index: 5 }, null, null],
    );
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_FLAG);
  });

  it('three roads: not removable', () => {
    const st = withFlag(
      [true, false, true, true, false, false],
      [true, false, true, true, false, false],
      [{ kind: 'flag', index: 5 }, null, { kind: 'flag', index: 6 }, { kind: 'flag', index: 7 }, null, null],
    );
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_FLAG);
  });

  it('road without an endpoint bit: not removable', () => {
    const st = withFlag(
      [true, false, false, true, false, false],
      [false, false, false, true, false, false], // the bit for direction 0 is missing
      [{ kind: 'flag', index: 5 }, null, null, { kind: 'flag', index: 7 }, null, null],
    );
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_FLAG);
  });

  it('flag with a building (UpLeft): not removable', () => {
    const st = withFlag([false, false, false, false, true, false], [false, false, false, false, true, false], [
      null, null, null, null, { kind: 'building', index: 1 }, null,
    ]);
    const up = neighbor(posOf(10, 10, geo), Direction.UpLeft, geo);
    st.mapTiles[up].object = 2; // building there
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).cursorType).toBe(CURSOR_FLAG);
  });
});

describe('classifyBuildSite — build possibility', () => {
  it('pure mountain around the map point: mine', () => {
    const st = state();
    // Die sechs Dreiecke um (10,10): Zentrum (up+down), Left(down), UpLeft(up+down), Up(up).
    for (const [c, r] of [[10, 10], [9, 10], [9, 9], [10, 9]] as [number, number][]) {
      at(st, c, r).terrainUp = 12;
      at(st, c, r).terrainDown = 12;
    }
    const site = classifyBuildSite(st, st.players[0]!, 10, 10);
    expect(site.possibility).toBe(BUILD_MINE);
    expect(site.levelingHeight).toBe(0); // the mine branch returns before the levelling maths
  });

  it('one water triangle at the map point: no building, but the flag stays possible', () => {
    const st = state();
    at(st, 10, 10).terrainUp = 0; // Wasser
    // Order of the original: the flag possibility is settled before the terrain class of the six
    // triangles is checked — a water triangle only stops the building.
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).possibility).toBe(BUILD_FLAG);
  });

  it('all six triangles water: nothing at all is possible, not even a flag', () => {
    const st = state();
    for (const [c, r] of [[10, 10], [9, 10], [9, 9], [10, 9]] as [number, number][]) {
      at(st, c, r).terrainUp = 0;
      at(st, c, r).terrainDown = 0;
    }
    expect(classifyBuildSite(st, st.players[0]!, 10, 10)).toMatchObject({
      cursorType: CURSOR_CLEAR,
      possibility: BUILD_NONE,
    });
  });

  it('a neighbouring flag prevents flag building (flagBlocked), a building stays possible', () => {
    const st = state();
    const rp = neighbor(posOf(10, 10, geo), Direction.Right, geo);
    st.mapTiles[rp].object = 1; // Flagge rechts daneben
    st.mapTiles[rp].objIndex = 1;
    st.flags[1] = { index: 1, paths: [false, false, false, false, false, false] } as unknown as Flag;
    const site = classifyBuildSite(st, st.players[0]!, 10, 10);
    expect(site.flagBlocked).toBe(true);
    // Spiral index 1 (Right) is in the flag distance list of the future flag site -> no building.
    expect(site.possibility).toBe(BUILD_NONE);
  });

  it('building right next to it: no building', () => {
    const st = state();
    const up = neighbor(posOf(10, 10, geo), Direction.Up, geo);
    st.mapTiles[up].object = 2;
    st.mapTiles[up].objIndex = 1;
    st.buildings[1] = { index: 1, type: 2, owner: 0, burning: false } as unknown as Building;
    // Here too the flag possibility is settled before the building neighbourhood check.
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).possibility).toBe(BUILD_FLAG);
  });

  it('stone obstacle next to the tile: only a small building', () => {
    const st = state();
    const up = neighbor(posOf(10, 10, geo), Direction.Up, geo);
    st.mapTiles[up].object = 72; // Stein-Haufen (Klasse 2)
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).possibility).toBe(BUILD_SMALL);
  });

  it('not pure grass-5 (a different grass variant): only a small building', () => {
    const st = state();
    at(st, 10, 10).terrainUp = 6; // grass variant 6 — buildable, but not large
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).possibility).toBe(BUILD_SMALL);
  });

  it('too uneven terrain (height span >= 9 in ring 2): only a small building', () => {
    const st = state();
    at(st, 12, 10).height = 20; // a ring-2 tile is much higher
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).possibility).toBe(BUILD_SMALL);
  });

  it('the levelling height is clamped to [max-4, min+4] of the ring-2 terrain', () => {
    const st = state();
    // Raise ring 2 (spiral 7..18) to 16, centre and ring 1 stay 10 -> average 10, min=max=16 -> lo=12.
    for (const [c, r] of [
      [11, 11], [12, 11], [12, 12], [11, 12], [10, 11], [9, 11],
      [12, 10], [11, 9], [10, 8], [9, 8], [8, 9], [8, 10],
    ] as [number, number][]) {
      at(st, c, r).height = 16;
    }
    const site = classifyBuildSite(st, st.players[0]!, 10, 10);
    expect(site.possibility).toBe(BUILD_LARGE);
    expect(site.levelingHeight).toBe(12); // 16-4, not the average 10
  });

  it('a military building in spiral ring 2 sets militaryBlocked', () => {
    const st = state();
    const ring2 = posOf(12, 11, geo); // Spiral-Index 8
    st.mapTiles[ring2].object = 2;
    st.mapTiles[ring2].objIndex = 1;
    st.buildings[1] = { index: 1, type: 11, owner: 0, burning: false } as unknown as Building; // Hut
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).militaryBlocked).toBe(true);

    st.buildings[1]!.type = 2; // lumberjack -> no block
    expect(classifyBuildSite(st, st.players[0]!, 10, 10).militaryBlocked).toBe(false);
  });
});

describe('placeBuilding', () => {
  it('places a small building with flag, tile bits and build material maxima', () => {
    const st = state();
    const p = st.players[0]!;
    const bld = placeBuilding(st, p, 10, 10, 2); // Lumberjack
    expect(bld).not.toBeNull();
    expect(bld!.type).toBe(2);
    expect(bld!.owner).toBe(0);
    expect(bld!.constructing).toBe(true);
    expect(bld!.progress).toBe(1); // small -> no levelling
    expect(bld!.stockMaximum).toEqual([2, 0]);
    expect(bld!.col).toBe(10);
    expect(bld!.row).toBe(10);

    const t = at(st, 10, 10);
    expect(t.object).toBe(2); // SmallBuilding
    expect(t.objIndex).toBe(bld!.index);
    expect(t.blocked).toBe(true);
    expect(t.paths & 0x02).toBe(0x02); // Weg nach DownRight

    const ft = at(st, 11, 11);
    expect(ft.object).toBe(1); // Flagge
    expect(ft.objIndex).toBe(bld!.flag);
    expect(ft.paths & 0x10).toBe(0x10); // Weg nach UpLeft

    const flag = st.flags[bld!.flag]!;
    expect(flag.hasBuilding).toBe(true);
    expect(flag.connections[Direction.UpLeft]).toEqual({ kind: 'building', index: bld!.index });
    expect(p.incompleteBuildingCount[1]).toBe(1); // Index = Typ−1
  });

  it('large building: object value 3, progress 0 and levelling height in the record', () => {
    const st = state();
    const bld = placeBuilding(st, st.players[0]!, 10, 10, 14); // PigFarm
    expect(bld).not.toBeNull();
    expect(bld!.progress).toBe(0); // large -> must be levelled first
    expect(bld!.level).toBe(10);
    expect(at(st, 10, 10).object).toBe(3); // LargeBuilding
    expect(bld!.stockMaximum).toEqual([4, 1]);
  });

  it('uses an existing flag on the DownRight tile instead of creating a new one', () => {
    const st = state();
    const dr = posOf(11, 11, geo);
    st.mapTiles[dr].object = 1;
    st.mapTiles[dr].objIndex = 1;
    st.flags[1] = {
      index: 1,
      owner: 0,
      paths: [false, false, false, false, false, false],
      endpointDirs: [false, false, false, false, false, false],
      connections: [null, null, null, null, null, null],
      stockPriority: [0, 0],
    } as unknown as Flag;
    const before = st.flags.filter(Boolean).length;
    const bld = placeBuilding(st, st.players[0]!, 10, 10, 2);
    expect(bld!.flag).toBe(1);
    expect(st.flags.filter(Boolean).length).toBe(before); // no new flag
    expect(st.flags[1]!.hasBuilding).toBe(true);
  });

  it('a mine only in the mountains, an ordinary building not', () => {
    const st = state();
    for (const [c, r] of [[10, 10], [9, 10], [9, 9], [10, 9]] as [number, number][]) {
      at(st, c, r).terrainUp = 12;
      at(st, c, r).terrainDown = 12;
    }
    expect(canPlaceBuilding(st, st.players[0]!, 10, 10, 2)).toBe(false); // lumberjack
    expect(canPlaceBuilding(st, st.players[0]!, 10, 10, 6)).toBe(true); // Kohlenmine
    const mine = placeBuilding(st, st.players[0]!, 10, 10, 6);
    expect(mine!.progress).toBe(1);
    expect(at(st, 10, 10).object).toBe(2); // a mine counts as a small building
  });

  /** Put mountains around (10,10) so a mine can be built there. */
  function mountainAt10(st: GameState): void {
    for (const [c, r] of [[10, 10], [9, 10], [9, 9], [10, 9]] as [number, number][]) {
      at(st, c, r).terrainUp = 12;
      at(st, c, r).terrainDown = 12;
    }
  }

  it('moves the resource amount of the built-over tile onto the first chain tile (Right)', () => {
    const st = state();
    mountainAt10(st);
    const t = at(st, 10, 10);
    t.mineral = 3; // Kohle
    t.resourceAmount = 7;
    placeBuilding(st, st.players[0]!, 10, 10, 6);
    expect(t.mineral).toBe(0);
    expect(t.resourceAmount).toBe(0);
    const right = at(st, 11, 10); // the first step of the original chain is `+4` == Right
    expect(right.mineral).toBe(3);
    expect(right.resourceAmount).toBe(7);
  });

  it('fills only up to 31 and pushes the rest on to the next chain tile', () => {
    const st = state();
    mountainAt10(st);
    const t = at(st, 10, 10);
    t.mineral = 3;
    t.resourceAmount = 20;
    at(st, 11, 10).mineral = 3; // Right is nearly full already
    at(st, 11, 10).resourceAmount = 25;
    placeBuilding(st, st.players[0]!, 10, 10, 6);
    expect(at(st, 11, 10).resourceAmount).toBe(31); // filled to the maximum
    expect(at(st, 11, 9).mineral).toBe(3); // remainder (20+25-31 = 14) at step 2 == (+1,-1)
    expect(at(st, 11, 9).resourceAmount).toBe(14);
  });

  it('skips tiles with a flag or building and those with a foreign resource type', () => {
    const st = state();
    mountainAt10(st);
    at(st, 10, 10).mineral = 3;
    at(st, 10, 10).resourceAmount = 5;
    at(st, 11, 10).mineral = 2; // foreign type at step 1 -> skipped
    at(st, 11, 10).resourceAmount = 4;
    at(st, 11, 9).object = 2; // building at step 2 (ring-2 tile) -> skipped
    at(st, 11, 9).objIndex = 9;
    placeBuilding(st, st.players[0]!, 10, 10, 6);
    expect(at(st, 10, 9).mineral).toBe(3); // only step 3 == Up takes it
    expect(at(st, 10, 9).resourceAmount).toBe(5);
  });

  it('loses gold from the map total when the whole chain is blocked', () => {
    const st = state();
    mountainAt10(st);
    at(st, 10, 10).mineral = 1; // Gold
    at(st, 10, 10).resourceAmount = 20;
    // Block every chain tile except the starting tile itself (step 4) with a foreign type.
    for (const [c, r] of [[11, 10], [11, 9], [10, 9], [10, 11], [11, 11]] as [number, number][]) {
      at(st, c, r).mineral = 3;
      at(st, c, r).resourceAmount = 5;
    }
    const goldBefore = st.header.mapGoldTotal;
    placeBuilding(st, st.players[0]!, 10, 10, 6);
    // Step 4 lands on the starting tile (20+20 = 40 >= 32 -> 31 there, 9 move on),
    // Steps 5 and 6 are blocked -> 9 units of gold are lost for good.
    expect(goldBefore - st.header.mapGoldTotal).toBe(9);
  });

  it('military block: a guard hut in ring 2 prevents a tower, not a lumberjack', () => {
    const st = state();
    const ring2 = posOf(12, 11, geo);
    st.mapTiles[ring2].object = 2;
    st.mapTiles[ring2].objIndex = 1;
    st.buildings[1] = { index: 1, type: 11, owner: 0, burning: false } as unknown as Building;
    expect(canPlaceBuilding(st, st.players[0]!, 10, 10, 21)).toBe(false); // Tower
    expect(canPlaceBuilding(st, st.players[0]!, 10, 10, 2)).toBe(true); // Lumberjack
  });

  it('Lagerhaus-Limit greift', () => {
    const st = state();
    const p = st.players[0]!;
    p.completedBuildingCount[9] = 300; // Typ 10 → Index 9
    p.incompleteBuildingCount[9] = 60;
    st.header.warehouseLimit = 361; // 300 + 60 + 1
    expect(placeBuilding(st, p, 10, 10, 10)).toBeNull();
    st.header.warehouseLimit = 400;
    expect(placeBuilding(st, p, 10, 10, 10)).not.toBeNull();
  });

  it('fills the message slot of the first lumberjack only while hint messages are active', () => {
    const st = state();
    const p = st.players[0]!;
    const bld = placeBuilding(st, p, 10, 10, 2)!;
    expect(p.messageBuildingSlots[0]).toBe(bld.index);

    const st2 = state();
    const p2 = player({ messageFlags: 1 }); // Bit 0 = Hinweise abgeschaltet
    st2.players[0] = p2;
    const bld2 = placeBuilding(st2, p2, 10, 10, 2)!;
    expect(bld2).not.toBeNull();
    expect(p2.messageBuildingSlots[0]).toBe(0);
  });

  it('lehnt unbaubare Kacheln ab (fremdes Land, besetzte Kachel, falscher Typ)', () => {
    const st = state();
    const p = st.players[0]!;
    at(st, 20, 20).owner = 2;
    expect(placeBuilding(st, p, 20, 20, 2)).toBeNull();
    placeBuilding(st, p, 10, 10, 2);
    expect(placeBuilding(st, p, 10, 10, 2)).toBeNull(); // already built on
    expect(placeBuilding(st, p, 30, 30, 0)).toBeNull(); // Typ 0
    expect(placeBuilding(st, p, 30, 30, 99)).toBeNull(); // type out of range
  });
});

describe('buildFlag (action_build_flag @0x2891e → build_flag @0x2899f)', () => {
  it('sets object 1 plus object index and writes the owner into the flag record', () => {
    const st = state();
    const p = st.players[0]!;
    const flag = buildFlag(st, p, 10, 10)!;
    expect(flag).not.toBeNull();
    const t = at(st, 10, 10);
    expect(t.object).toBe(1); // landscape[+3] &= 0x80 | 1
    expect(t.objIndex).toBe(flag.index);
    expect(flag.owner).toBe(p.slot); // flag+3 = owner<<6
    // The record carries NO position (as in the original) and no roads yet.
    expect(flag.paths.every((v) => !v)).toBe(true);
    expect(flag.hasBuilding).toBe(false);
  });

  it('clears the existing map object and moves the tile resources away', () => {
    const st = state();
    const p = st.players[0]!;
    const t = at(st, 12, 12);
    t.object = 74; // Stein-Haufen
    t.mineral = 3; // Kohle
    t.resourceAmount = 5;
    // No flag is possible on an occupied tile (possibility 0) — and the abort happens
    // BEFORE any mutation, so the object stays.
    expect(buildFlag(st, p, 12, 12)).toBeNull();
    expect(t.object).toBe(74); // unangetastet: Abbruch VOR jeder Mutation

    // On a free tile with a mineral deposit the stock is pushed away.
    const free = at(st, 20, 20);
    free.mineral = 3;
    free.resourceAmount = 5;
    const flag = buildFlag(st, p, 20, 20)!;
    expect(flag).not.toBeNull();
    expect(free.mineral).toBe(0);
    expect(free.resourceAmount).toBe(0);
  });

  it('gate: possibility 0 => no; cursor kinds 7, 6 and 4 (road) => yes', () => {
    const st = state();
    const p = st.players[0]!;
    // foreign land => possibility 0
    at(st, 30, 30).owner = 2;
    expect(canBuildFlag(st, p, 30, 30)).toBe(false);
    expect(buildFlag(st, p, 30, 30)).toBeNull();

    // freie Kachel (Art 7)
    expect(classifyBuildSite(st, p, 10, 10).cursorType).toBe(CURSOR_CLEAR);
    expect(canBuildFlag(st, p, 10, 10)).toBe(true);

    // Tile WITH a road (kind 4): allowed — building splits the road (`splitRoadAtFlag`).
    // Only the gate and the flag itself here; the road stub (one bit) makes the split a no-op.
    const road = at(st, 40, 40);
    road.paths = 0x01;
    expect(classifyBuildSite(st, p, 40, 40).cursorType).toBe(CURSOR_PATH);
    expect(canBuildFlag(st, p, 40, 40)).toBe(true);
    const onRoad = buildFlag(st, p, 40, 40);
    expect(onRoad).not.toBeNull();
    expect(road.object).toBe(1);
    expect(road.objIndex).toBe(onRoad!.index);
  });
});

describe('buildMenuClickOutcome — the four exits of the placement bodies', () => {
  /** Put a finished own building on the tile (cursor kind 3). */
  function putBuilding(st: GameState, col: number, row: number, type: number, object = 2): void {
    const t = at(st, col, row);
    t.object = object;
    t.objIndex = 1;
    st.buildings[1] = {
      index: 1, col, row, type, owner: 0, constructing: false, burning: false,
      stockMaximum: [3, 4],
    } as unknown as Building;
  }

  it('free tile on grass: small and large building => place', () => {
    const st = state();
    const p = st.players[0]!;
    expect(classifyBuildSite(st, p, 10, 10).possibility).toBe(BUILD_LARGE);
    expect(buildMenuClickOutcome(st, p, 10, 10, 12, false)).toBe('place'); // farm (large)
    expect(buildMenuClickOutcome(st, p, 10, 10, 2, false)).toBe('place'); // lumberjack (small)
    expect(buildMenuClickOutcome(st, p, 10, 10, 5, false)).toBe('reject'); // Steinmine: braucht Gebirge
  });

  it('military building blocked => blocked, and SILENTLY (sound null)', () => {
    const st = state();
    const p = st.players[0]!;
    p.build |= 1; // `player+3` bit 0 — the classifier leaves it alone if ring 2 is never checked
    // A military building in ring 2 sets it in the original; set directly here plus a ring-2 building,
    // so the classification does not return earlier.
    const st2 = state();
    const p2 = st2.players[0]!;
    const ring2 = neighbor(neighbor(posOf(10, 10, geo), Direction.Up, geo), Direction.Up, geo);
    st2.mapTiles[ring2].object = 2;
    st2.mapTiles[ring2].objIndex = 1;
    st2.buildings[1] = { index: 1, type: 11, owner: 0 } as unknown as Building; // guard hut
    expect(classifyBuildSite(st2, p2, 10, 10).militaryBlocked).toBe(true);
    expect(buildMenuClickOutcome(st2, p2, 10, 10, 21, false)).toBe('blocked'); // Turm
    expect(buildMenuOutcomeSound('blocked')).toBeNull();
    // A NON-military type passes the same block (the gate sits in two icon stubs only).
    expect(buildMenuClickOutcome(st2, p2, 10, 10, 12, false)).not.toBe('blocked');
  });

  it('building on the tile: plain click => keep (silent), special click => demolish', () => {
    const st = state();
    const p = st.players[0]!;
    putBuilding(st, 10, 10, 2); // lumberjack on grass
    const site = classifyBuildSite(st, p, 10, 10);
    expect(site.cursorType).toBe(CURSOR_BUILDING);
    expect(site.possibility).toBe(BUILD_LARGE); // grass-5 surroundings => the large class fits too
    expect(buildMenuClickOutcome(st, p, 10, 10, 12, false)).toBe('keep');
    expect(buildMenuOutcomeSound('keep')).toBeNull();
    expect(buildMenuClickOutcome(st, p, 10, 10, 12, true)).toBe('demolish');
    // Wrong class: a mine demands `possibility == 2` — 4 here => rejected, even on a special click.
    expect(buildMenuClickOutcome(st, p, 10, 10, 5, true)).toBe('reject');
  });

  it('large: the build branch demands EXACTLY 4, the building branch only at least 4', () => {
    // `possibility == 5` (BUILD_CASTLE) is only set by the classifier while the player has NO castle
    // — that is where the two comparisons of the original part ways (`jne` @0x30365 against
    // `jb` @0x302f8).
    const st = state();
    const p = st.players[0]!;
    p.flags = 0; // no castle => BUILD_CASTLE ...
    // ... and then the classifier demands **unowned** land (`wantOwner = 0`, @0x32075): before
    // Before founding no tile belongs to anyone.
    for (const t of st.mapTiles) t.owner = 0;
    expect(classifyBuildSite(st, p, 10, 10).possibility).toBe(BUILD_CASTLE);
    expect(buildMenuClickOutcome(st, p, 10, 10, 12, false)).toBe('reject'); // Bau-Zweig: 5 != 4
    putBuilding(st, 10, 10, 12, 3);
    expect(classifyBuildSite(st, p, 10, 10).possibility).toBe(BUILD_CASTLE);
    expect(buildMenuClickOutcome(st, p, 10, 10, 12, true)).toBe('demolish'); // building branch: 5 >= 4
  });

  it('road on the tile (kind 4): no building => reject', () => {
    const st = state();
    const p = st.players[0]!;
    at(st, 40, 40).paths = 0x01;
    expect(classifyBuildSite(st, p, 40, 40).cursorType).toBe(CURSOR_PATH);
    expect(buildMenuClickOutcome(st, p, 40, 40, 2, false)).toBe('reject');
  });
});

describe('demolishForPendingBuild (Zweig @0x30161 + FUN_00031d5c)', () => {
  it('burns the building down, stamps the type and restores the two road bits', () => {
    const st = state();
    const t = at(st, 10, 10);
    t.object = 2;
    t.objIndex = 1;
    t.paths = 1 << Direction.DownRight;
    const flagTile = st.mapTiles[neighbor(posOf(10, 10, geo), Direction.DownRight, geo)]!;
    flagTile.object = 1;
    flagTile.objIndex = 1;
    flagTile.paths = 1 << Direction.UpLeft;
    st.flags[1] = {
      index: 1, col: 10, row: 11, paths: [false, false, false, false, false, false],
      connections: [null, null, null, null, null, null], resourceSlots: [], slotDir: [],
      hasBuilding: true,
    } as unknown as Flag;
    // `demolish_building` also cleans up the road network (`cancelTransportOnDelete`); the empty
    // serf and inventory tables of the harness suffice — what counts here are the three writes after.
    st.buildings[1] = {
      index: 1, col: 10, row: 10, type: 2, owner: 0, constructing: false, burning: false,
      flag: 1, stockMaximum: [3, 4],
      stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
      progress: 0, holder: false, active: false,
    } as unknown as Building;

    expect(demolishForPendingBuild(st, 10, 10, 17)).toBe(true);
    const bld = st.buildings[1]!;
    expect(bld.burning).toBe(true);
    expect(bld.stockMaximum![0]).toBe(17); // bld+0x10 = pendingBuildType (@0x31dfc)
    // `demolish_building` clears both bits, `FUN_00031d5c` sets them again — net: they stay.
    expect(t.paths & (1 << Direction.DownRight)).not.toBe(0);
    expect(flagTile.paths & (1 << Direction.UpLeft)).not.toBe(0);
  });

  it('with no building on the tile: false, without touching anything', () => {
    const st = state();
    expect(demolishForPendingBuild(st, 10, 10, 17)).toBe(false);
  });
});
