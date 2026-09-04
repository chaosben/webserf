import { describe, it, expect } from 'vitest';
import {
  requestBuildingWorkers,
  sendGeologistToFlag,
  militaryOccupancyTarget,
  sendSerfToFlag,
  requestKnightForBuilding,
} from './serf-request.js';
import type { GameState, Building, Flag, Inventory, Serf, Player } from './state.js';
import { mapGeometry } from './position.js';

/** 64x64 like every real save game — for the position arithmetic of the stock tail. */
const GEO = mapGeometry(3);

/**
 * request_serf phase A.
 *
 * Setup: lumberjack building #1 (flag #1) — road — inventory flag #2 (warehouse #3, inventory #0 with
 * one idle generic + an axe). request_serf is meant to specialise the generic and send it out.
 */
function conn(kind: 'flag' | 'building', index: number) {
  return { kind, index };
}

function makeState(over: { holder?: boolean; requested?: boolean; failed?: boolean; axe?: number; generic?: number } = {}): {
  state: GameState;
  bld: Building;
  inv: Inventory;
  serf: Serf;
} {
  const bld1 = {
    index: 1,
    type: 2, // Lumberjack
    flag: 1,
    col: 10,
    row: 10,
    burning: false,
    holder: over.holder ?? false,
    serfRequested: over.requested ?? false,
    serfRequestFailed: over.failed ?? false,
  } as unknown as Building;
  const bld3 = {
    index: 3,
    type: 10,
    inventoryIndex: 0,
    burning: false,
    active: true,
    holder: true,
    col: 20,
    row: 20,
  } as unknown as Building;

  const flag1 = {
    index: 1,
    stockPriority: [0, 0],
    bldFlags: 0,
    endpointDirs: [true, false, false, false, false, false], // land road to the Right
    connections: [conn('flag', 2), null, null, null, null, null],
  } as unknown as Flag;
  const flag2 = {
    index: 2,
    stockPriority: [0, 0],
    bldFlags: 0x40, // has_inventory
    endpointDirs: new Array(6).fill(false),
    connections: [null, null, null, null, conn('building', 3), null],
  } as unknown as Flag;

  const resources = new Array(26).fill(0);
  resources[20] = over.axe ?? 2; // axe
  const inv: Inventory = {
    index: 0,
    owner: 0,
    serfMode: 0,
    resources,
    genericCount: over.generic ?? 3,
    serfIndices: new Array(27).fill(0),
  } as unknown as Inventory;
  inv.serfIndices[21] = 5; // generic representative = serf #5

  const serf5 = { index: 5, type: 21, state: 1, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
  const player: Player = { slot: 0, serfCount: new Array(27).fill(0) } as unknown as Player;

  const state = {
    geo: GEO,
    mapTiles: Array.from({ length: 64 * 64 }, () => ({ serfIndex: 0 })),
    gameTick: 500,
    rotation: 0,
    frameAccum: 0,
    buildings: [null, bld1, null, bld3],
    flags: [null, flag1, flag2],
    inventories: [inv],
    players: [player, null, null, null],
    serfs: [null, null, null, null, null, serf5],
  } as unknown as GameState;

  return { state, bld: bld1, inv, serf: serf5 };
}

describe('serf-request — request_serf Phase A', () => {
  it('specialises a generic and sends it to the building (state 15)', () => {
    const { state, bld, inv, serf } = makeState();
    requestBuildingWorkers(state);
    expect(serf.type).toBe(5); // Lumberjack
    expect(serf.state).toBe(15); // ReadyToLeaveInventory
    expect(serf.stateData[0]).toBe(0xff); // field_0xb = -1 -> destination is the building
    expect(serf.stateData[1]).toBe(1); // field_0xc = building flag #1
    expect(inv.genericCount).toBe(2); // −1
    expect(inv.serfIndices[21]).toBe(0); // representative consumed
    expect(inv.resources[20]).toBe(1); // axe consumed
    expect(inv.serfIndices[4]).toBe(1); // serfs_out ++
    expect(bld.serfRequested).toBe(true);
    expect(state.players[0]!.serfCount[21]).toBe(0); // generic census -1, clamped at 0
    expect(state.players[0]!.serfCount[5]).toBe(1); // lumberjack census +1
  });

  it('does not fire when the building is already occupied (holder)', () => {
    const { state, serf, bld } = makeState({ holder: true });
    requestBuildingWorkers(state);
    expect(serf.state).toBe(1);
    expect(bld.serfRequested).toBe(false);
  });

  it('does not fire while a request is already running (serfRequested)', () => {
    const { state, serf } = makeState({ requested: true });
    requestBuildingWorkers(state);
    expect(serf.state).toBe(1);
  });

  it('sets serfRequestFailed when no inventory can deliver (no axe)', () => {
    const { state, serf, bld } = makeState({ axe: 0 });
    requestBuildingWorkers(state);
    expect(serf.state).toBe(1); // no dispatch (a generic without a tool cannot be specialised)
    expect(bld.serfRequested).toBe(false);
    expect(bld.serfRequestFailed).toBe(true);
  });

  it('is pure (no self gating): dispatches regardless of frameAccum — frame gating lives in tick()', () => {
    const { state, serf } = makeState();
    state.frameAccum = 3; // irrelevant here; advanceFrameClock checks the frame boundary
    requestBuildingWorkers(state);
    expect(serf.state).toBe(15); // dispatches anyway (frame gating is centralised in tick.ts)
  });

  it('is a no-op in economy rotations (rotation >= 32)', () => {
    const { state, serf } = makeState();
    state.rotation = 40;
    requestBuildingWorkers(state);
    expect(serf.state).toBe(1);
  });

  it('dispatches a finished worker without consuming a tool', () => {
    const { state, inv, serf } = makeState({ axe: 0 });
 // A finished lumberjack (#5) in the warehouse instead of a generic.
    inv.serfIndices[21] = 0;
    inv.serfIndices[5] = 5;
    serf.type = 5;
    requestBuildingWorkers(state);
    expect(serf.state).toBe(15);
    expect(inv.serfIndices[5]).toBe(0);
    expect(inv.genericCount).toBe(3); // unchanged (no generic consumed)
  });
});

describe('serf-request — geologist to a flag (FUN_00012370 -> FUN_000123d9)', () => {
  it('specialises a generic into a geologist: mode 6, destination is the flag, hammer consumed', () => {
    const { state, inv, serf } = makeState({ axe: 0 });
    inv.resources[16] = 2; // hammer
    const ok = sendGeologistToFlag(state, 1); // starting at flag #1
    expect(ok).toBe(true);
    expect(serf.type).toBe(20); // geologist
    expect(serf.state).toBe(15); // ReadyToLeaveInventory
    expect(serf.stateData[0]).toBe(6); // field_0xb = 6 -> the destination is a FLAG (not -1)
    expect(serf.stateData[1]).toBe(1); // field_0xc = flag #1
    expect(inv.resources[16]).toBe(1); // hammer consumed (inv[4 + 0x22])
    expect(inv.genericCount).toBe(2);
    expect(inv.serfIndices[4]).toBe(1); // serfs_out ++
    expect(state.players[0]!.serfCount[20]).toBe(1); // geologist census +1
 // No building involved: the `bld[5] |= 0x80` of the other branch must not run.
    expect(state.buildings[1]!.serfRequested).toBe(false);
  });

  it('no geologist without a hammer in the warehouse', () => {
    const { state, serf } = makeState({ axe: 0 });
    expect(sendGeologistToFlag(state, 1)).toBe(false);
    expect(serf.state).toBe(1);
  });

  it('a finished geologist in the warehouse is taken without consuming a hammer', () => {
    const { state, inv } = makeState({ axe: 0 });
    inv.resources[16] = 1;
    const geo = { index: 9, type: 20, state: 1, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
    (state.serfs as unknown as (Serf | null)[])[9] = geo;
    inv.serfIndices[20] = 9;
    expect(sendGeologistToFlag(state, 1)).toBe(true);
    expect(geo.state).toBe(15);
    expect(geo.stateData[0]).toBe(6);
    expect(inv.resources[16]).toBe(1); // untouched — only generics need a tool
    expect(inv.genericCount).toBe(3); // the generic stays put
    expect(inv.serfIndices[20]).toBe(0);
  });

  it('a finished serf beats specialising even when it stands further away (two-phase preference)', () => {
 // The warehouse at flag #2 has only a generic + hammer; a second one at flag #3 (one step further)
 // has a finished geologist. The original only remembers the generic and takes the finished one.
    const { state, inv } = makeState({ axe: 0 });
    inv.resources[16] = 1;
    const inv2 = {
      index: 1,
      owner: 0,
      serfMode: 0,
      resources: new Array(26).fill(0),
      genericCount: 0,
      serfIndices: new Array(27).fill(0),
    } as unknown as Inventory;
    inv2.serfIndices[20] = 9;
    (state.inventories as unknown as Inventory[])[1] = inv2;
    const geo = { index: 9, type: 20, state: 1, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
    (state.serfs as unknown as (Serf | null)[])[9] = geo;
    const bld4 = { index: 4, type: 10, inventoryIndex: 1, burning: false, active: true } as unknown as Building;
    (state.buildings as unknown as (Building | null)[])[4] = bld4;
    const flag3 = {
      index: 3,
      stockPriority: [0, 0],
      bldFlags: 0x40,
      endpointDirs: [false, false, false, true, false, false], // land road back to the Left
      connections: [null, null, null, conn('flag', 2), conn('building', 4), null],
    } as unknown as Flag;
    (state.flags as unknown as (Flag | null)[])[3] = flag3;
 // Flag #2 gets an onward road to #3 — as a LAND road, otherwise the request search does not enter
 // it (`flag[4]`, @0x12b7f).
    (state.flags[2] as unknown as Flag).connections = [
      conn('flag', 3), null, null, null, conn('building', 3), null,
    ] as never;
    (state.flags[2] as unknown as Flag).endpointDirs = [true, false, false, false, false, false] as never;

    expect(sendGeologistToFlag(state, 1)).toBe(true);
    expect(geo.state).toBe(15); // the FINISHED geologist sets off …
    expect(inv.resources[16]).toBe(1); // … the hammer in the nearer warehouse stays put
    expect(inv.genericCount).toBe(3);
  });
});

/**
 * Garrison refill (military branch, `@0x15511`/`@0x15595`/`@0x15619` + tail `@0x1569a`).
 *
 * Setup: military building #1 (flag #1) — road — inventory flag #2 (warehouse #3, inventory #0). The
 * warehouse holds different knight ranks depending on the test.
 */
function makeMilitary(
  over: {
    type?: number;
    threatLevel?: number;
 /** `(max << 4) | min` per threat level. */
    occupation?: number[];
    stock0?: { available: number; requested: number };
 /** Serf indices per knight type 22..26 (0 = none). */
    knights?: Partial<Record<number, number>>;
    playerFlags?: number;
    failed?: boolean;
    constructing?: boolean;
 /** Garrison chain `bld[10] -> serf[0xe]`: serf types in chain order. */
    garrison?: number[];
 /** Serf on the building tile (blocks the exit). */
    tileSerf?: number;
    knightShiftTimer?: number;
  } = {},
): { state: GameState; bld: Building; inv: Inventory } {
  const bld1 = {
    index: 1,
    type: over.type ?? 11, // hut
    flag: 1,
    owner: 0,
    col: 10,
    row: 10,
    burning: false,
    constructing: over.constructing ?? false,
    active: true,
    holder: true,
    threatLevel: over.threatLevel ?? 3,
    firstKnight: 0,
    serfRequested: false,
    serfRequestFailed: over.failed ?? false,
    stock: [over.stock0 ?? { available: 1, requested: 0 }, { available: 0, requested: 0 }],
  } as unknown as Building;
  const bld3 = {
    index: 3,
    type: 10,
    inventoryIndex: 0,
    burning: false,
    active: true,
    holder: true,
    col: 20,
    row: 20,
  } as unknown as Building;

  const flag1 = {
    index: 1,
    stockPriority: [0, 0],
    bldFlags: 0,
    endpointDirs: [true, false, false, false, false, false], // land road to the Right
    connections: [conn('flag', 2), null, null, null, null, null],
  } as unknown as Flag;
  const flag2 = {
    index: 2,
    stockPriority: [0, 0],
    bldFlags: 0x40,
    endpointDirs: new Array(6).fill(false),
    connections: [null, null, null, null, conn('building', 3), null],
  } as unknown as Flag;

  const inv: Inventory = {
    index: 0,
    owner: 0,
    serfMode: 0,
    resources: new Array(26).fill(0),
    genericCount: 5,
    serfIndices: new Array(27).fill(0),
  } as unknown as Inventory;
  const serfs: (Serf | null)[] = [null];
  const knights = over.knights ?? { 25: 7 }; // default: a single Knight3 (#7)
  for (const [t, idx] of Object.entries(knights)) {
    inv.serfIndices[Number(t)] = idx as number;
    serfs[idx as number] = {
      index: idx as number,
      type: Number(t),
      state: 1,
      stateData: [0, 0, 0, 0, 0],
    } as unknown as Serf;
  }

 // Garrison chain: serfs from index 100, linked through the union bytes 3/4 (== `serf+0xe`).
  if (over.garrison !== undefined) {
    const base = 100;
    over.garrison.forEach((type, i) => {
      const next = i + 1 < over.garrison!.length ? base + i + 1 : 0;
      serfs[base + i] = {
        index: base + i,
        type,
        state: 70,
        col: 10,
        row: 10,
        counter: 0,
        tick: 0,
        stateData: [0, 0, 0, next & 0xff, (next >> 8) & 0xff],
      } as unknown as Serf;
    });
    bld1.firstKnight = base;
  }

  const player: Player = {
    slot: 0,
    flags: over.playerFlags ?? 0,
    knightShiftTimer: over.knightShiftTimer ?? 0,
    knightOccupation: over.occupation ?? [0x10, 0x21, 0x32, 0x43],
    serfCount: new Array(27).fill(0),
    // The knight recruitment books both of these (@0x12e50 / @0x12e58).
    totalMilitaryScore: 0,
    contSearchAfterNonOptimalFind: 7,
 // A building UNDER CONSTRUCTION runs through `buildingConstructionHead`, which reads these three.
    messageFlags: 0,
    messageBuildingSlots: [0, 0, 0],
    planksDistribution: [0, 0, 0],
  } as unknown as Player;

  const geo = { cols: 64, rows: 64, colMask: 63, rowMask: 63, rowShift: 6 };
  const mapTiles = Array.from({ length: 64 * 64 }, () => ({ serfIndex: 0 }));
  if (over.tileSerf !== undefined) mapTiles[10 * 64 + 10]!.serfIndex = over.tileSerf;

  const state = {
    gameTick: 500,
    rotation: 0,
    frameAccum: 0,
    geo,
    mapTiles,
    buildings: [null, bld1, null, bld3],
    flags: [null, flag1, flag2],
    inventories: [inv],
    players: [player, null, null, null],
    serfs,
  } as unknown as GameState;
  return { state, bld: bld1, inv };
}

/** The garrison chain of a building as serf indices (the same walk the original does). */
function chain(state: GameState, bld: Building): number[] {
  const out: number[] = [];
  for (let i = bld.firstKnight; i !== 0 && out.length < 32; ) {
    const s = state.serfs[i];
    if (!s) break;
    out.push(i);
    i = (s.stateData[3]! | (s.stateData[4]! << 8)) & 0xffff;
  }
  return out;
}

describe('serf-request — garrison refill', () => {
  it('target occupancy from the HIGH nibble of knightOccupation + the type table', () => {
 // Hut, threatLevel 3 -> occupation[3] = 0x43 -> max 4 -> table[4] = 3.
    const { state, bld } = makeMilitary();
    expect(militaryOccupancyTarget(state, bld)).toBe(3);
 // threatLevel 2 -> 0x32 -> max 3 -> table[3] = 2.
    expect(militaryOccupancyTarget(state, { ...bld, threatLevel: 2 } as Building)).toBe(2);
 // Tower with max 4 -> 6; fortress with max 4 -> 12.
    expect(militaryOccupancyTarget(state, { ...bld, type: 21 } as Building)).toBe(6);
    expect(militaryOccupancyTarget(state, { ...bld, type: 22 } as Building)).toBe(12);
 // Non-military (the castle too — it has its own handler) -> null.
    expect(militaryOccupancyTarget(state, { ...bld, type: 24 } as Building)).toBeNull();
    expect(militaryOccupancyTarget(state, { ...bld, type: 2 } as Building)).toBeNull();
  });

  it('flags bit 4 switches to the second, smaller half of the table', () => {
    const { state, bld } = makeMilitary({ playerFlags: 0x10 });
    expect(militaryOccupancyTarget(state, bld)).toBe(2); // table[4+5] instead of [4]
    expect(militaryOccupancyTarget(state, { ...bld, type: 22 } as Building)).toBe(8); // fortress 12 -> 8
  });

  it('requests the HIGHEST rank in the warehouse (K4 down to K0)', () => {
    const { state, inv } = makeMilitary({ knights: { 22: 4, 23: 5, 25: 7 } }); // K0, K1, K3
    requestBuildingWorkers(state);
    expect(state.serfs[7]!.state).toBe(15); // K3 sets off
    expect(inv.serfIndices[25]).toBe(0);
    expect(state.serfs[4]!.state).toBe(1); // K0 stays
    expect(state.serfs[5]!.state).toBe(1); // K1 stays
    expect(inv.serfIndices[22]).toBe(4);
    expect(inv.serfIndices[23]).toBe(5);
  });

  it('books requested in the LOW nibble and clears serfRequested', () => {
    const { state, bld, inv } = makeMilitary({ stock0: { available: 1, requested: 1 } });
    requestBuildingWorkers(state);
 // 0x11 + 1 = 0x12 -> available stays 1, requested 1 -> 2.
    expect(bld.stock[0]).toEqual({ available: 1, requested: 2 });
    expect(bld.serfRequested).toBe(false); // `btr $0x7` — unlike the production path
    expect(state.serfs[7]!.stateData[0]).toBe(0xff); // the destination is a building
    expect(state.serfs[7]!.stateData[1]).toBe(1); // building flag
    expect(state.serfs[7]!.type).toBe(25); // type unchanged — he already IS a knight
    expect(inv.genericCount).toBe(5); // no generic branch for knights
    expect(inv.serfIndices[4]).toBe(1); // serfs_out ++
  });

  it('does not fire when the garrison already meets the target', () => {
 // available 1 + requested 2 == target 3 -> neither request nor ejection (which needs
 // `target < available`, @0x15707): a knight is on his way, the original does nothing here.
    const { state, bld } = makeMilitary({ stock0: { available: 1, requested: 2 } });
    requestBuildingWorkers(state);
    expect(state.serfs[7]!.state).toBe(1);
    expect(bld.stock[0]).toEqual({ available: 1, requested: 2 });
  });

  it('does not fire after a previous failure (serfRequestFailed)', () => {
    const { state } = makeMilitary({ failed: true });
    requestBuildingWorkers(state);
    expect(state.serfs[7]!.state).toBe(1);
  });

  it('sets serfRequestFailed when no warehouse holds a knight', () => {
    const { state, bld } = makeMilitary({ knights: {} });
    requestBuildingWorkers(state);
    expect(bld.serfRequestFailed).toBe(true);
    expect(bld.stock[0]).toEqual({ available: 1, requested: 0 });
  });

  it('does not apply to a military building UNDER CONSTRUCTION (own handler in the original)', () => {
    const { state, bld } = makeMilitary({ constructing: true });
    requestBuildingWorkers(state);
    expect(state.serfs[7]!.state).toBe(1);
    expect(bld.stock[0]).toEqual({ available: 1, requested: 0 });
  });
});

/**
 * Ejecting the weakest knight (`@0x15707`) — the building half of the knight shift.
 *
 * Setup: the target occupancy is 3 (hut, `occupation[3] = 0x43`); with `flags` bit 4 it drops to 2,
 * which makes a garrison of 3 overstaffed.
 */
describe('serf-request — ejection when overstaffed', () => {
  const OVERSTAFFED = {
    stock0: { available: 3, requested: 0 },
    playerFlags: 0x10, // phase 1 -> target 2
    garrison: [24, 22, 25], // K2, K0, K3 — the weakest sits in the MIDDLE
  };

  it('ejects the weakest knight and unlinks him from the chain', () => {
    const { state, bld } = makeMilitary(OVERSTAFFED);
    requestBuildingWorkers(state);
    expect(chain(state, bld)).toEqual([100, 102]); // K0 (#101) is out, order otherwise unchanged
    expect(state.serfs[101]!.state).toBe(7); // ReadyToLeave
    expect(bld.stock[0]).toEqual({ available: 2, requested: 0 }); // `subb $0x10`
  });

  it('sets the exit fields like the tail @0x158d0', () => {
    const { state } = makeMilitary(OVERSTAFFED);
    requestBuildingWorkers(state);
    const s = state.serfs[101]!;
    expect(s.stateData[0]).toBe(0xfe); // field_B = -2 -> back to the warehouse
    expect(s.stateData[1]).toBe(0); // dest = 0 -> find the nearest warehouse himself
    expect(s.stateData[2]).toBe(0);
    expect(s.stateData[3]).toBe(0); // dir
    expect(s.stateData[4]).toBe(2); // next_state = Walking
    expect(s.counter).toBe(0); // the original sets neither counter nor tick
    expect(s.tick).toBe(0);
  });

  it('copes with the weakest at the HEAD of the chain', () => {
    const { state, bld } = makeMilitary({ ...OVERSTAFFED, garrison: [22, 24, 25] });
    requestBuildingWorkers(state);
    expect(bld.firstKnight).toBe(101);
    expect(chain(state, bld)).toEqual([101, 102]);
  });

  it('ejects nobody while a serf stands on the building tile', () => {
    const { state, bld } = makeMilitary({ ...OVERSTAFFED, tileSerf: 55 });
    requestBuildingWorkers(state);
    expect(chain(state, bld)).toEqual([100, 101, 102]);
    expect(bld.stock[0]).toEqual({ available: 3, requested: 0 });
  });

  it('ejects nobody while the garrison does not EXCEED the target', () => {
 // Without bit 4 the target is 3 == available -> neither request nor ejection.
    const { state, bld } = makeMilitary({ ...OVERSTAFFED, playerFlags: 0 });
    requestBuildingWorkers(state);
    expect(chain(state, bld)).toEqual([100, 101, 102]);
    expect(bld.stock[0]).toEqual({ available: 3, requested: 0 });
  });

  it('gives up exactly ONE per pass', () => {
    const { state, bld } = makeMilitary({
      ...OVERSTAFFED,
      stock0: { available: 4, requested: 0 },
      garrison: [26, 22, 23, 25],
    });
    requestBuildingWorkers(state);
    expect(chain(state, bld).length).toBe(3);
    requestBuildingWorkers(state);
    expect(chain(state, bld).length).toBe(2);
    expect(bld.stock[0]).toEqual({ available: 2, requested: 0 });
 // The two strongest remain.
    expect(chain(state, bld).map((i) => state.serfs[i]!.type)).toEqual([26, 25]);
  });
});

/**
 * Rank floor (phase 2, `flags` bit 5 -> `-((timer >> 8) + 1) * 2`). The cascade compares for equality
 * against -10 / -8 / -6 / -4, so a warehouse gives up as soon as the value matches after the
 * respective rank.
 */
describe('serf-request — rank floor of the knight shift', () => {
  const RANK_FLOOR = 0x20;

  it('delivers any rank without bit 5 (K0 if nothing better is there)', () => {
    const { state, inv } = makeMilitary({ knights: { 22: 4 } });
    requestBuildingWorkers(state);
    expect(state.serfs[4]!.state).toBe(15);
    expect(inv.serfIndices[22]).toBe(0);
  });

  it('gives up at a high countdown when only weak ranks are in the warehouse', () => {
 // timer 1023 -> (1023>>8)+1 = 4 -> -8, so it stops after K3; a K0 is not taken.
    const { state } = makeMilitary({
      knights: { 22: 4 },
      playerFlags: RANK_FLOOR,
      knightShiftTimer: 1023,
    });
    requestBuildingWorkers(state);
    expect(state.serfs[4]!.state).toBe(1);
  });

  it('takes a sufficiently high rank at the same countdown', () => {
    const { state } = makeMilitary({
      knights: { 22: 4, 25: 7 }, // K0 + K3
      playerFlags: RANK_FLOOR,
      knightShiftTimer: 1023,
    });
    requestBuildingWorkers(state);
    expect(state.serfs[7]!.state).toBe(15); // K3 goes
    expect(state.serfs[4]!.state).toBe(1); // K0 stays
  });

  it('relaxes the floor as the countdown runs down', () => {
    for (const [timer, takesK0] of [
      [1023, false], // -8  -> down to K3
      [700, false], //  -6  -> down to K2
      [400, false], //  -4  -> down to K1
      [100, true], //   -2  -> everything
    ] as const) {
      const { state } = makeMilitary({
        knights: { 22: 4 },
        playerFlags: RANK_FLOOR,
        knightShiftTimer: timer,
      });
      requestBuildingWorkers(state);
      expect(state.serfs[4]!.state).toBe(takesK0 ? 15 : 1);
    }
  });
});

/**
 * The generic resupply of the shared stock tail — serf type `0x15` leaves `send_serf_to_flag` through
 * a tail of its own (`cmpw $0x2a` @0x128cb).
 *
 * What makes it its own tail matters far beyond bookkeeping: it does **not** set `serfRequested`. That
 * bit is a claim on `bld[0xa]`, and the arrival handover fills the slot with whichever serf with a
 * negative mode reaches the flag first (@0x202f1). For a castle `bld[0xa]` is the head of the garrison
 * chain, and the castle asks for a resupply through this very tail.
 */
describe('serf-request — the generic resupply tail', () => {
  const RESUPPLY = { serfType: 21, tools: [] as number[] };
  const TRANSPORTER = { serfType: 0, tools: [] as number[] };

  /** A store with `generics` unspecialised settlers and one representative serf (#9). */
  function withGenerics(generics: number) {
    const made = makeMilitary({ knights: {} });
    made.inv.genericCount = generics;
    made.inv.serfIndices[21] = 9;
    made.state.serfs[9] = {
      index: 9,
      type: 21,
      state: 1,
      stateData: [0, 0, 0, 0, 0],
    } as unknown as Serf;
    return made;
  }

  it('takes a settler from five upwards and books him out of the store', () => {
    const { state, bld, inv } = withGenerics(5);
    expect(sendSerfToFlag(state, bld, RESUPPLY)).toBe(true);
    expect(inv.genericCount).toBe(4); // `subw $0x1,0x40(%ebx)` @0x12932
    expect(inv.serfIndices[21]).toBe(0);
    expect(inv.serfIndices[4]).toBe(1); // serfs_out
    expect(state.serfs[9]!.state).toBe(15); // ReadyToLeaveInventory
    expect(state.serfs[9]!.type).toBe(21); // he stays a generic — no specialisation
  });

  it('leaves a store with four alone (the search walks on)', () => {
    const { state, bld, inv } = withGenerics(4);
    expect(sendSerfToFlag(state, bld, RESUPPLY)).toBe(false);
    expect(inv.genericCount).toBe(4);
    expect(state.serfs[9]!.state).toBe(1);
  });

  it('sends him with mode 0xfe and does NOT claim the holder slot', () => {
    const { state, bld } = withGenerics(5);
    sendSerfToFlag(state, bld, RESUPPLY);
    expect(state.serfs[9]!.stateData[0]).toBe(0xfe); // `mov $0xfe,%al` @0x12909
    expect(state.serfs[9]!.stateData[1]).toBe(1); // dest = the requesting building's flag
    expect(bld.serfRequested).toBe(false); // no `bts $0x7`
  });

  it('CONTRAST: any other type does claim it, with mode 0xff', () => {
    const { state, bld, inv } = withGenerics(5);
    inv.serfIndices[0] = 8; // a stored transporter
    state.serfs[8] = { index: 8, type: 0, state: 1, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
    expect(sendSerfToFlag(state, bld, TRANSPORTER)).toBe(true);
    expect(bld.serfRequested).toBe(true); // `bts $0x7` @0x12a06
    expect(state.serfs[8]!.stateData[0]).toBe(0xff);
    expect(inv.genericCount).toBe(5); // a stored specialist is not a generic
  });
});

/**
 * Recruiting a generic into a Knight0 — the fallback of the knight request (@0x126df, dispatched at
 * @0x12d8a when the search budget runs out). Without it a settlement whose stores hold weapons but no
 * knight never fills a hut.
 */
describe('serf-request — recruiting a generic into a knight', () => {
  function armed(over: { sword?: number; shield?: number; generic?: boolean } = {}) {
    const made = makeMilitary({ knights: {} });
    made.inv.resources[24] = over.sword ?? 2; // sword
    made.inv.resources[25] = over.shield ?? 2; // shield
    if (over.generic !== false) {
      made.inv.serfIndices[21] = 9;
      made.state.serfs[9] = {
        index: 9,
        type: 21,
        state: 1,
        stateData: [0, 0, 0, 0, 0],
      } as unknown as Serf;
    }
    return made;
  }

  it('turns the generic into a Knight0 and pays sword plus shield', () => {
    const { state, bld, inv } = armed();
    expect(requestKnightForBuilding(state, bld)).toBe(true);
    expect(state.serfs[9]!.type).toBe(22); // `andb $0x83 ; orb $0x58` @0x12df1/@0x12df7
    expect(state.serfs[9]!.state).toBe(15);
    expect(inv.resources[24]).toBe(1);
    expect(inv.resources[25]).toBe(1);
    expect(inv.genericCount).toBe(4);
    expect(inv.serfIndices[21]).toBe(0);
    expect(bld.serfRequested).toBe(false); // `btr $0x7` @0x12dcc — cleared, not set
  });

  it('books the census on the SERF owner and the military score', () => {
    const { state, bld } = armed();
    const player = state.players[0]!;
    requestKnightForBuilding(state, bld);
    expect(player.serfCount[21]).toBe(0xffff); // 0 - 1, u16 like the original
    expect(player.serfCount[22]).toBe(1);
    expect(player.totalMilitaryScore).toBe(1); // `addl $0x1,0x11a(%ebx)` @0x12e58
  });

  it('needs generic AND sword AND shield — each alone blocks it', () => {
    const noShield = armed({ shield: 0 });
    expect(requestKnightForBuilding(noShield.state, noShield.bld)).toBe(false);
    const noSword = armed({ sword: 0 });
    expect(requestKnightForBuilding(noSword.state, noSword.bld)).toBe(false);
    const noGeneric = armed({ generic: false });
    expect(requestKnightForBuilding(noGeneric.state, noGeneric.bld)).toBe(false);
  });

  it('a stored knight always beats recruiting', () => {
    const { state, bld, inv } = armed();
    inv.serfIndices[23] = 7; // a Knight1 in store
    state.serfs[7] = { index: 7, type: 23, state: 1, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
    expect(requestKnightForBuilding(state, bld)).toBe(true);
    expect(state.serfs[7]!.state).toBe(15);
    expect(state.serfs[9]!.type).toBe(21); // the generic is untouched
    expect(inv.resources[24]).toBe(2);
  });
});
