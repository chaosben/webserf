import { describe, it, expect } from 'vitest';
import {
  buildingConstructionHead,
  buildSiteIsLevel,
  constructionDemand,
  LARGE_CONSTRUCTION_TYPES,
} from './building-construction.js';
import { requestBuildingWorkers } from './serf-request.js';
import type { Building, Flag, GameState, Inventory, Player, Serf } from './state.js';
import { Rng } from './rng.js';
import { posOf, neighbor, Direction } from './position.js';

/**
 * Minimal world for the construction handler: one building site (#1, flag #1) next to a stock (#3,
 * flag #2) with tools and generic serfs. The two flags are directly connected so that the network
 * search of `send_serf_to_flag` reaches the stock.
 */
function makeWorld(over: {
  type?: number;
  progress?: number;
  level?: number;
  holder?: boolean;
  serfRequested?: boolean;
  failed?: boolean;
  /** Heights of the 7 site tiles; by default all == `level`. */
  heights?: number;
  messageFlags?: number;
  messageBuildingSlots?: number[];
  playerFlags?: number;
  /** Tool stock of the warehouse by resource index. */
  tools?: Partial<Record<number, number>>;
  genericCount?: number;
  stock0?: { available: number; requested: number };
  stock1?: { available: number; requested: number };
  stockMaximum?: [number, number];
} = {}): { state: GameState; bld: Building; flag: Flag; inv: Inventory } {
  const level = over.level ?? 7;
  const bld = {
    index: 1,
    type: over.type ?? 6, // coal mine (small)
    flag: 1,
    owner: 0,
    col: 10,
    row: 10,
    burning: false,
    constructing: true,
    active: false,
    holder: over.holder ?? false,
    threatLevel: 0,
    firstKnight: 0,
    progress: over.progress ?? 0,
    level,
    serfRequested: over.serfRequested ?? false,
    serfRequestFailed: over.failed ?? false,
    stock: [
      over.stock0 ?? { available: 0, requested: 0 },
      over.stock1 ?? { available: 0, requested: 0 },
    ],
    stockMaximum: over.stockMaximum ?? [5, 0],
  } as unknown as Building;
  const stock = {
    index: 3,
    type: 10,
    flag: 2,
    owner: 0,
    inventoryIndex: 0,
    burning: false,
    constructing: false,
    active: true,
    holder: true,
    col: 20,
    row: 20,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
  } as unknown as Building;

  const conn = (kind: 'flag' | 'building', index: number) => ({ kind, index });
  const flag1 = {
    index: 1,
    stockPriority: [0, 0],
    resourceSlots: new Array(8).fill(-1),
    slotDir: new Array(8).fill(-1),
    slotDest: new Array(8).fill(0),
    transporters: new Array(6).fill(false),
    otherEndDir: new Array(6).fill(0),
    length: new Array(6).fill(0),
    scheduled: new Array(6).fill(false),
    scheduledSlot: new Array(6).fill(0),
    endpointDirs: [true, false, false, false, false, false], // land road towards Right
    bldFlags: 0,
    connections: [conn('flag', 2), null, null, null, null, null],
  } as unknown as Flag;
  const flag2 = {
    index: 2,
    stockPriority: [0, 0],
    resourceSlots: new Array(8).fill(-1),
    slotDir: new Array(8).fill(-1),
    slotDest: new Array(8).fill(0),
    transporters: new Array(6).fill(false),
    otherEndDir: new Array(6).fill(0),
    length: new Array(6).fill(0),
    scheduled: new Array(6).fill(false),
    scheduledSlot: new Array(6).fill(0),
    endpointDirs: [true, false, false, false, false, false], // land road back towards Right
    bldFlags: 0x40,
    connections: [conn('flag', 1), null, null, null, conn('building', 3), null],
  } as unknown as Flag;

  const resources = new Array(26).fill(0);
  for (const [r, n] of Object.entries(over.tools ?? { 15: 3, 16: 3 })) resources[Number(r)] = n;
  const serfIndices = new Array(27).fill(0);
  serfIndices[21] = 7; // one generic in the stock
  const inv = {
    index: 0,
    owner: 0,
    building: 3,
    flag: 2,
    resMode: 0,
    serfMode: 0,
    resources,
    genericCount: over.genericCount ?? 5,
    serfIndices,
    outQueue: [
      { type: -1, dest: 0 },
      { type: -1, dest: 0 },
    ],
  } as unknown as Inventory;

  const serfs: (Serf | null)[] = [null];
  serfs[7] = {
    index: 7,
    type: 21,
    state: 1,
    counter: 0,
    tick: 0,
    col: 20,
    row: 20,
    stateData: [0, 0, 0, 0, 0],
  } as unknown as Serf;

  const player = {
    slot: 0,
    active: true,
    flags: over.playerFlags ?? 0,
    build: 0,
    messageFlags: over.messageFlags ?? 0,
    messageBuildingSlots: over.messageBuildingSlots ?? [0, 0, 0],
    planksDistribution: [0xff00, 0, 0],
    knightOccupation: [0x10, 0x21, 0x32, 0x43],
    serfCount: new Array(27).fill(0),
    messageTypes: [],
    messagePositions: [],
    // needed by the demolition branch
    incompleteBuildingCount: new Array(23).fill(1),
    completedBuildingCount: new Array(23).fill(0),
    totalBuildingScore: 100,
  } as unknown as Player;

  const geo = { mapSize: 3, cols: 64, rows: 64, colMask: 63, rowMask: 63, rowShift: 6, tileCount: 4096 };
  const h = over.heights ?? level;
  const mapTiles = Array.from({ length: 64 * 64 }, () => ({ serfIndex: 0, height: h, paths: 0 }));

  const state = {
    gameTick: 500,
    rotation: 0,
    frameAccum: 0,
    geo,
    mapTiles,
    rng: new Rng([1, 2, 3]),
    buildings: [null, bld, null, stock],
    flags: [null, flag1, flag2],
    inventories: [inv],
    players: [player, null, null, null],
    serfs,
    header: { maxSerfIndex: 8 },
  } as unknown as GameState;
  return { state, bld, flag: flag1, inv };
}

describe('handler table: a building site NEVER gets its production worker', () => {
  it('a mine under construction requests the builder (type 3), not the miner (type 9)', () => {
    const { state, bld } = makeWorld({ type: 6 });
    requestBuildingWorkers(state);
    expect(bld.serfRequested).toBe(true);
    expect(state.serfs[7]!.type).toBe(3); // builder; the miner only comes once it is finished
  });

  it('the same mine, FINISHED, requests the miner', () => {
    const { state, bld } = makeWorld({ type: 6, tools: { 22: 3 } });
    bld.constructing = false;
    requestBuildingWorkers(state);
    expect(state.serfs[7]!.type).toBe(9); // miner
  });

  it('the castle under construction requests nothing (table slot @0x14da4 is a `ret`)', () => {
    const { state, bld } = makeWorld({ type: 24 });
    requestBuildingWorkers(state);
    expect(bld.serfRequested).toBe(false);
    expect(state.serfs[7]!.type).toBe(21);
  });
});

describe('levelling (large-building body @0x138ed)', () => {
  it('a large building on uneven ground requests the digger (type 2)', () => {
    const { state, bld } = makeWorld({ type: 12, level: 7, heights: 9, progress: 0 });
    buildingConstructionHead(state, bld, 1);
    expect(state.serfs[7]!.type).toBe(2); // digger
    expect(bld.progress).toBe(0); // the builder only follows once levelling is done
  });

  it('an already level site skips the digger and `progress` jumps to 1', () => {
    const { state, bld } = makeWorld({ type: 12, level: 7, heights: 7, progress: 0 });
    buildingConstructionHead(state, bld, 1);
    expect(bld.progress).toBe(1);
    expect(state.serfs[7]!.type).toBe(3); // straight to the builder
  });

  it('a single deviating neighbour tile is enough (all seven are checked)', () => {
    for (let d = 0; d < 6; d++) {
      const { state, bld } = makeWorld({ type: 12, level: 7, heights: 7 });
      const pos = neighbor(posOf(10, 10, state.geo), d as Direction, state.geo);
      (state.mapTiles[pos] as { height: number }).height = 8;
      expect(buildSiteIsLevel(state, bld), `direction ${d}`).toBe(false);
    }
  });

  it('a small building skips the levelling check (fall-through to @0x13b24)', () => {
    const { state, bld } = makeWorld({ type: 6, level: 7, heights: 9, progress: 0 });
    buildingConstructionHead(state, bld, 1);
    expect(state.serfs[7]!.type).toBe(3); // builder, not digger
  });

  it('with a digger present or on its way nothing happens (@0x13905 `andb $0xc0`)', () => {
    const { state, bld } = makeWorld({ type: 12, heights: 9, serfRequested: true });
    buildingConstructionHead(state, bld, 1);
    expect(state.serfs[7]!.type).toBe(21);
  });

  it('the butcher (13) is a LARGE building, so it levels', () => {
    expect(LARGE_CONSTRUCTION_TYPES.has(13)).toBe(true);
    const { state, bld } = makeWorld({ type: 13, level: 7, heights: 9, progress: 0 });
    buildingConstructionHead(state, bld, 1);
    expect(state.serfs[7]!.type).toBe(2);
  });
});

describe('emergency programme (messageFlags bits 6 / 1 / 2)', () => {
  it('bit 6: a site outside the chain gets no builder', () => {
    const { state, bld } = makeWorld({ type: 6, messageFlags: 1 << 6 });
    buildingConstructionHead(state, bld, 1);
    expect(bld.serfRequestFailed).toBe(true);
    expect(state.serfs[7]!.type).toBe(21);
  });

  it('bit 6: a remembered chain building does get one', () => {
    const { state, bld } = makeWorld({
      type: 6,
      messageFlags: 1 << 6,
      messageBuildingSlots: [0, 1, 0], // index 1 == our site
    });
    buildingConstructionHead(state, bld, 1);
    expect(state.serfs[7]!.type).toBe(3);
  });

  it('bit 6 decides the digger by TYPE, not by index', () => {
    // The sawmill (17) is one of the three chain types (`bld[4] & 0x7c` == 0x44) ...
    const saw = makeWorld({ type: 17, heights: 9, messageFlags: 1 << 6 });
    buildingConstructionHead(saw.state, saw.bld, 1);
    expect(saw.state.serfs[7]!.type).toBe(2);
    // ... the mill (15) is not.
    const mill = makeWorld({ type: 16, heights: 9, messageFlags: 1 << 6 });
    buildingConstructionHead(mill.state, mill.bld, 1);
    expect(mill.bld.serfRequestFailed).toBe(true);
    expect(mill.state.serfs[7]!.type).toBe(21);
  });

  it('the emergency refusal of the builder skips the material tail (@0x13bc0 `ret`)', () => {
    const { state, bld, flag } = makeWorld({ type: 6, messageFlags: 1 << 6 });
    flag.stockPriority[0] = 42;
    flag.stockPriority[1] = 43;
    buildingConstructionHead(state, bld, 1);
    expect(flag.stockPriority).toEqual([42, 43]); // untouched
  });

  it('bit 1: plank demand drops to 0 when the site is not part of the chain', () => {
    const { state, bld, flag } = makeWorld({ type: 6, progress: 1, messageFlags: 1 << 1 });
    constructionDemand(state, bld, 1, false);
    expect(flag.stockPriority[0]).toBe(0);
  });

  it('without the emergency programme plank demand is normal', () => {
    const { state, bld, flag } = makeWorld({ type: 6, progress: 1, holder: true });
    constructionDemand(state, bld, 1, false);
    expect(flag.stockPriority[0]).toBe(0xfe); // 0xff00>>8 = 0xff, >>0, & ~1
  });

  it('AI razing: a fresh site (threshold 0x7ff) burns', () => {
    const { state, bld } = makeWorld({
      type: 6,
      progress: 1,
      messageFlags: 1 << 1,
      playerFlags: 1 << 7, // AI
    });
    const before = state.rng.getState();
    constructionDemand(state, bld, 1, true);
    expect(state.rng.getState()).not.toEqual(before);
    expect(bld.burning).toBe(true);
  });

  it('AI razing: an almost finished site (threshold 0) survives, but the random draw still happens', () => {
    const { state, bld } = makeWorld({
      type: 6,
      progress: 0xfff0, // ~progress >> 5 == 0 => `rand >= 0` always true
      messageFlags: 1 << 1,
      playerFlags: 1 << 7,
    });
    const before = state.rng.getState();
    constructionDemand(state, bld, 1, true);
    expect(state.rng.getState()).not.toEqual(before);
    expect(bld.burning).toBe(false);
  });

  it('without `allowEmergency` the random stream stays untouched (every-tick call)', () => {
    const { state, bld } = makeWorld({
      type: 6,
      progress: 1,
      messageFlags: 1 << 1,
      playerFlags: 1 << 7,
    });
    const before = state.rng.getState();
    constructionDemand(state, bld, 1, false);
    expect(state.rng.getState()).toEqual(before);
  });

  it('a HUMAN does not lose the site: no random draw, no razing', () => {
    const { state, bld } = makeWorld({ type: 6, progress: 1, messageFlags: 1 << 1 });
    const before = state.rng.getState();
    constructionDemand(state, bld, 1, true);
    expect(state.rng.getState()).toEqual(before);
    expect(bld.burning).toBe(false);
  });
});

describe('material demand: both slots are written (@0x13d91 is a `jmp`, not a `ret`)', () => {
  it('the success path of slot 0 jumps to slot 1 and writes there too', () => {
    const { state, bld, flag } = makeWorld({
      type: 11, // hut: stockMaximum [1,1], both slots demand
      progress: 1,
      holder: true,
      stockMaximum: [1, 1],
    });
    constructionDemand(state, bld, 1, false);
    expect(flag.stockPriority[0]).toBe(0xfe);
    expect(flag.stockPriority[1]).toBe(0xfe);
  });

  it('`fill == stockMaximum` switches the slot off', () => {
    const { state, bld, flag } = makeWorld({
      type: 6,
      progress: 1,
      holder: true,
      stock0: { available: 5, requested: 0 },
      stockMaximum: [5, 0],
    });
    constructionDemand(state, bld, 1, false);
    expect(flag.stockPriority[0]).toBe(0);
  });
});
