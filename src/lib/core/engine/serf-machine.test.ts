import { describe, it, expect } from 'vitest';
import type { GameState, Serf, Building, Tile, Flag, Inventory, Player } from './state.js';
import {
  unionU8,
  setUnionU8,
  unionU16,
  setUnionU16,
  advance,
  dispatchSerf,
} from './serf-machine.js';
import { mapGeometry, posOf } from './position.js';
import { Rng } from './rng.js';

function serf(fields: Partial<Serf> & { state: number }): Serf {
  return {
    index: 1,
    counter: 0,
    tick: 0,
    animation: 0,
    stateData: [0, 0, 0, 0, 0],
    ...fields,
  } as unknown as Serf;
}
const gs = (gameTick: number): GameState => ({ gameTick }) as unknown as GameState;

describe('serf-machine — Union-Zugriffe', () => {
  it('u8 lesen/schreiben (Offset 0xb..0xf → stateData[0..4])', () => {
    const s = serf({ state: 0, stateData: [10, 20, 30, 40, 50] });
    expect(unionU8(s, 0xb)).toBe(10);
    expect(unionU8(s, 0xf)).toBe(50);
    setUnionU8(s, 0xd, 99);
    expect(s.stateData[2]).toBe(99);
    setUnionU8(s, 0xb, 0x1ff); // masked to u8
    expect(s.stateData[0]).toBe(0xff);
  });

  it('u16 little-endian lesen/schreiben', () => {
    const s = serf({ state: 0, stateData: [0, 0x34, 0x12, 0, 0] });
    expect(unionU16(s, 0xc)).toBe(0x1234);
    setUnionU16(s, 0xe, 0xabcd);
    expect(s.stateData[3]).toBe(0xcd);
    expect(s.stateData[4]).toBe(0xab);
    expect(unionU16(s, 0xe)).toBe(0xabcd);
  });
});

describe('serf-machine — advance (Tick-Prolog)', () => {
  it('not expired: delta <= counter -> false, counter -= delta', () => {
    const s = serf({ state: 2, counter: 100, tick: 1000 });
    expect(advance(s, 1005)).toBe(false);
    expect(s.counter).toBe(95);
    expect(s.tick).toBe(1005);
  });

  it('abgelaufen: delta > counter → true (Unterlauf)', () => {
    const s = serf({ state: 2, counter: 3, tick: 1000 });
    expect(advance(s, 1005)).toBe(true);
    expect(s.counter).toBe(0xfffe); // subU16(3,5)
  });
});

describe('serf-machine — dispatch', () => {
  it('00 Null: counter and tick untouched', () => {
    const s = serf({ state: 0, counter: 42, tick: 1000 });
    dispatchSerf(gs(1010), s);
    expect(s.counter).toBe(42);
    expect(s.tick).toBe(1000);
  });

  it('05 LeavingBuilding (not expired): only the counter goes down, the state stays', () => {
    const s = serf({ state: 5, counter: 100, tick: 1000, stateData: [0, 0, 0, 0, 2] });
    dispatchSerf(gs(1005), s);
    expect(s.state).toBe(5);
    expect(s.counter).toBe(95);
    expect(s.stateData[4]).toBe(2); // field_0xf unchanged
  });

  it('05 LeavingBuilding (abgelaufen): Wechsel in field_0xf, counter=0, field_0xf=0', () => {
    const s = serf({ state: 5, counter: 3, tick: 1000, stateData: [0, 0, 0, 0, 2] });
    dispatchSerf(gs(1005), s);
    expect(s.state).toBe(2); // gemerkter Folgezustand
    expect(s.counter).toBe(0);
    expect(s.stateData[4]).toBe(0);
  });

  it('unported state: the fallback animates (counter down, no transition)', () => {
    const s = serf({ state: 3, counter: 100, tick: 1000 });
    dispatchSerf(gs(1010), s);
    expect(s.state).toBe(3);
    expect(s.counter).toBe(90);
    expect(s.tick).toBe(1010);
  });
});

// --- Bewegungs-Primitiv: 07 ReadyToLeave (stepOutToFlag) ---

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
/** Minimal GameState for stepOutToFlag: hut(11) @(10,20) h5, flag tile @(11,21) h6. */
function moveState(flagOccupiedBy = 0): { state: GameState; serf: Serf; here: number; flag: number } {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const here = posOf(10, 20, geo);
  const flag = posOf(11, 21, geo); // DownRight
  mapTiles[here] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: 5 });
  mapTiles[flag] = tile({ height: 6, object: 1, objIndex: 1, serfIndex: flagOccupiedBy });
  const buildings: (Building | null)[] = [null, { index: 1, type: 11 } as unknown as Building];
  const serf = { index: 5, state: 7, col: 10, row: 20, counter: 0, tick: 900, animation: 0 } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, serf];
  const state = { geo, gameTick: 1000, mapTiles, buildings, serfs } as unknown as GameState;
  return { state, serf, here, flag };
}

describe('serf-machine — 07 ReadyToLeave / stepOutToFlag', () => {
  it('free flag tile: serf moved, counter and anim byte exact, state -> 5', () => {
    const { state, serf, here, flag } = moveState();
    dispatchSerf(state, serf);
    expect([serf.col, serf.row]).toEqual([11, 21]);
    expect(state.mapTiles[here].serfIndex).toBe(0);
    expect(state.mapTiles[flag].serfIndex).toBe(5);
    expect(serf.animation).toBe(14); // Δh(+1) + 0xd
    expect(serf.counter).toBe(129); // (COUNTER_FROM_ANIMATION[14]=319 * (0x1f^slope[11]=13)) >> 5
    expect(serf.state).toBe(5);
    expect(serf.tick).toBe(1000);
  });

  it('blocked flag tile: waiting animation 0x52, serf stays in the building, state stays 7', () => {
    const { state, serf, here, flag } = moveState(9); // flag tile occupied by serf 9
    dispatchSerf(state, serf);
    expect([serf.col, serf.row]).toEqual([10, 20]);
    expect(state.mapTiles[here].serfIndex).toBe(5);
    expect(state.mapTiles[flag].serfIndex).toBe(9);
    expect(serf.animation).toBe(0x52);
    expect(serf.counter).toBe(0);
    expect(serf.state).toBe(7);
  });
});

// --- Spiegel-Primitiv: 06 ReadyToEnter (stepInToBuilding) ---

/** Serf @(11,21) h6 wants into the building UpLeft @(10,20) h5 (hut 11). */
function enterState(bldOccupiedBy = 0): { state: GameState; serf: Serf; here: number; bld: number } {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const here = posOf(11, 21, geo);
  const bld = posOf(10, 20, geo); // UpLeft of here
  mapTiles[here] = tile({ height: 6, object: 1, objIndex: 3, serfIndex: 6 });
  mapTiles[bld] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: bldOccupiedBy });
  const buildings: (Building | null)[] = [
    null,
    { index: 1, type: 11, constructing: false } as unknown as Building,
  ];
  const serf = { index: 6, state: 6, col: 11, row: 21, counter: 77, tick: 900, animation: 0, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, null, serf];
  const state = { geo, gameTick: 1000, mapTiles, buildings, serfs } as unknown as GameState;
  return { state, serf, here, bld };
}

describe('serf-machine — 06 ReadyToEnter / stepInToBuilding', () => {
  it('free building tile: serf moved, inside walk length in field_0xc, state -> 4', () => {
    const { state, serf, here, bld } = enterState();
    dispatchSerf(state, serf);
    expect([serf.col, serf.row]).toEqual([10, 20]);
    expect(state.mapTiles[here].serfIndex).toBe(0);
    expect(state.mapTiles[bld].serfIndex).toBe(6);
    expect(serf.animation).toBe(39); // Δh(-1) + 0x28
    expect(unionU16(serf, 0xc)).toBe(179); // (COUNTER_FROM_ANIMATION[39]=319 * slope[11]=18) >> 5
    expect(serf.state).toBe(4);
    expect(serf.counter).toBe(319); // walk duration = COUNTER_FROM_ANIMATION[39] (the binary sets counter=base)
  });

  it('blocked building tile: waiting animation 0x55, serf stays, state stays 6', () => {
    const { state, serf, bld } = enterState(3);
    dispatchSerf(state, serf);
    expect([serf.col, serf.row]).toEqual([11, 21]);
    expect(state.mapTiles[bld].serfIndex).toBe(3);
    expect(serf.animation).toBe(0x55);
    expect(serf.counter).toBe(0);
    expect(serf.state).toBe(6);
  });
});

// --- Ritter-Garnisons-Eintritt (serf_state_04 case 0xc95) ---

/**
 * Knight (type 26) in state 4 on the hut tile, entry due (counter <= fieldC). Models the garrison entry
 * case synthetically. Hut P0 @(10,20), not yet `active`.
 */
function garrisonEnterState(): { state: GameState; serf: Serf; bld: Building; here: number } {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const here = posOf(10, 20, geo);
  mapTiles[here] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: 5 });
  const bld = {
    index: 1, type: 11, owner: 0, col: 10, row: 20, flag: 1,
    active: false, burning: false, hasInventory: false, firstKnight: 0,
    stock: [{ available: 0, requested: 1 }, { available: 0, requested: 0 }],
  } as unknown as Building;
  const buildings: (Building | null)[] = [null, bld];
 // The first occupation writes the accept bytes of the building flag (@0x23fc4..@0x23fd9) — up to
 // The flag starts with the build mask, so the test shows that occupation rewrites it to the GOLD
 // mask.
  const flags: (Flag | null)[] = [
    null,
    { index: 1, bldFlags: 0x02, bld2Flags: 0x10, acceptsSerfs: false, acceptsResources: false,
      stockPriority: [126, 254] } as unknown as Flag,
  ];
 // Knight #5: state 4, fieldB(0xb)=0xff (garrison, not warehouse), fieldC(0xc)=0, counter 0 -> entry due.
  const serf = {
    index: 5, type: 26, state: 4, col: 10, row: 20, counter: 0, tick: 1000, animation: 41,
    stateData: [0xff, 0, 0, 5, 0],
  } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, serf];
 // Entering triggers the territory recolour, which also books the land score (+/-1 per tile) and
 // therefore needs real player slots. It additionally enqueues message 6 and reports recolour losers
 // (8/9), so the message columns are needed as well.
  const players = [0, 1, 2, 3].map((slot) => ({
    slot,
    totalLandScore: 0,
    totalBuildingScore: 0,
    flags: 0,
    messageTypes: [] as number[],
    messagePositions: [] as number[],
  }));
  const state = { geo, gameTick: 1000, mapTiles, buildings, serfs, players, flags } as unknown as GameState;
  return { state, serf, bld, here };
}

describe('serf-machine — 04 Ritter-Garnisons-Eintritt (case 0xc95)', () => {
  it('the first knight occupies a fresh hut -> state 70, active, firstKnight, garrison count, territory', () => {
    const { state, serf, bld, here } = garrisonEnterState();
    dispatchSerf(state, serf);
    expect(serf.state).toBe(70); // DefendingHut (Hut→70)
    expect(serf.counter).toBe(6000);
    expect(unionU16(serf, 0xe)).toBe(0); // serf[0xe] = altes firstKnight (0)
    expect(bld.firstKnight).toBe(5); // building.firstKnight = serf.index
    expect(bld.active).toBe(true);
    expect(bld.stock[0]).toEqual({ available: 1, requested: 0 }); // Byte 0x01 + 0x0f = 0x10
    expect(state.mapTiles[here].owner).toBe(1); // territory: hut tile -> P0 (owner 0+1)
 // Accept bytes of the flag (@0x23fc4 `mov $0x0` -> 0x42, @0x23fcc `mov $0x8` -> 0x44, @0x23fd4
 // `xor` -> 0x45): the BUILD mask (plank 0x02 / stone 0x10) gives way to the GOLD mask (bit 3).
    const f = state.flags[1]!;
    expect(f.bldFlags).toBe(0x00);
    expect(f.bld2Flags).toBe(0x08); // Bit 3 == GoldBar (DEMAND_TABLE[14])
    expect(f.acceptsSerfs).toBe(false);
    expect(f.acceptsResources).toBe(false);
    expect(f.stockPriority[1]).toBe(0); // `militaryGoldDemand` sets it again next tick
  });

  it('burning building -> the knight becomes lost (25), no garrison and no territory', () => {
    const { state, serf, bld } = garrisonEnterState();
    bld.burning = true;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(25); // lost (the HANDLERS[4] guard before the dispatch)
    expect(bld.active).toBe(false);
    expect(bld.firstKnight).toBe(0);
  });

 /**
  * Message 6 "military building occupied" (@0x23f62). It used to be missing because the call site
  * als „Angriffs-Register `FUN_00018234`, bewusst OFFEN" abgelegt war — falscher Name, echter Effekt.
  */
  it('the first occupation reports "building occupied" with the building class as the parameter', () => {
 // Discrimination: hut 0, tower 1, everything else (fortress) 2.
    for (const [type, cls] of [
      [11, 0],
      [21, 1],
      [22, 2],
    ] as const) {
      const { state, serf, bld, here } = garrisonEnterState();
      bld.type = type;
      dispatchSerf(state, serf);
      const p = state.players[0]!;
      expect(p.messageTypes, `building type ${type}`).toContain(6 + (cls << 5));
 // The position is the tile of the BUILDING (`bld[0]`), not that of the serf.
      const i = p.messageTypes.indexOf(6 + (cls << 5));
      expect(p.messagePositions[i]).toBe(here);
      expect(p.flags & 0x08).toBe(0x08); // Wecker
    }
  });

  it('a knight moving up reports nothing — the building was already active', () => {
    const { state, serf, bld } = garrisonEnterState();
    bld.active = true; // `bt $0x4,bld[5] ; jne` @0x23edc
    dispatchSerf(state, serf);
    expect(serf.state).toBe(70); // it moves in anyway
    expect(state.players[0]!.messageTypes).toEqual([]);
  });

 /**
  * The loser reporter is wired up (`FUN_0002433a` x4, @0x2410d ff.). All that is checked here is that
  * it **runs** and reports nothing in this situation — nobody loses anything when a fresh hut is
  * Its decision table is tested in `territory.test.ts`.
  * occupied on unowned land.
  */
  it('a first occupation on unowned land reports nothing to any other player', () => {
    const { state, serf } = garrisonEnterState();
    dispatchSerf(state, serf);
    for (const slot of [1, 2, 3]) expect(state.players[slot]!.messageTypes).toEqual([]);
  });
});

// --- Handler 11 MoveResourceOut (stepOutToFlag + freier Flaggen-Waren-Slot) ---

/** Serf(11) @(10,20) h5 in hut(11); flag tile @(11,21) h6, flag #2 with or without a free resource slot. */
function resourceOutState(hasFreeSlot: boolean): { state: GameState; serf: Serf } {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const here = posOf(10, 20, geo);
  const flag = posOf(11, 21, geo);
  mapTiles[here] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: 5 });
  mapTiles[flag] = tile({ height: 6, object: 1, objIndex: 2, serfIndex: 0 });
  const buildings: (Building | null)[] = [null, { index: 1, type: 11, constructing: false } as unknown as Building];
  const slots = hasFreeSlot ? [-1, -1, -1, -1, -1, -1, -1, -1] : [0, 1, 2, 3, 4, 5, 6, 7];
  const flags: (Flag | null)[] = [null, null, { index: 2, resourceSlots: slots } as unknown as Flag];
  const serf = { index: 5, state: 11, col: 10, row: 20, counter: 0, tick: 900, animation: 0 } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, serf];
  const state = { geo, gameTick: 1000, mapTiles, buildings, flags, serfs } as unknown as GameState;
  return { state, serf };
}

describe('serf-machine — 11 MoveResourceOut', () => {
  it('free resource slot: steps out to the flag (like stepOutToFlag), state -> 5', () => {
    const { state, serf } = resourceOutState(true);
    dispatchSerf(state, serf);
    expect([serf.col, serf.row]).toEqual([11, 21]);
    expect(serf.state).toBe(5);
    expect(serf.counter).toBe(129); // same as the handler-07 case (hut, height delta +1)
  });

  it('no free resource slot: blocked (anim 0x52), no step, state stays 11', () => {
    const { state, serf } = resourceOutState(false);
    dispatchSerf(state, serf);
    expect([serf.col, serf.row]).toEqual([10, 20]);
    expect(serf.animation).toBe(0x52);
    expect(serf.counter).toBe(0);
    expect(serf.state).toBe(11);
  });
});

// --- Handler 12 WaitForResourceOut (Inventar-Ausgabe: Ware aufnehmen + austreten) ---

/**
 * Serf(TransporterInventory) in the warehouse(10) building @(10,20) h5, state 12, counter 0 (the body runs
 * immediately). Flag tile @(11,21) h6 free with a free resource slot. Inventory #1 with an optional
 * outgoing resource.
 */
function waitResourceState(queueType: number): { state: GameState; serf: Serf; inv: Inventory } {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const here = posOf(10, 20, geo);
  const flag = posOf(11, 21, geo);
  mapTiles[here] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: 5 });
  mapTiles[flag] = tile({ height: 6, object: 1, objIndex: 2, serfIndex: 0 });
  const buildings: (Building | null)[] = [
    null,
    { index: 1, type: 10, constructing: false, inventoryIndex: 1 } as unknown as Building,
  ];
  const flags: (Flag | null)[] = [
    null,
    null,
    { index: 2, resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1] } as unknown as Flag,
  ];
  const inv = {
    index: 1,
    serfIndices: new Array(27).fill(0),
    outQueue: [
      { type: queueType, dest: 33 },
      { type: -1, dest: 0 },
    ],
  } as unknown as Inventory;
  const inventories: (Inventory | null)[] = [null, inv];
  const serf = { index: 5, state: 12, col: 10, row: 20, counter: 0, tick: 900, animation: 0, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, serf];
  const state = { geo, gameTick: 1000, mapTiles, buildings, flags, inventories, serfs } as unknown as GameState;
  return { state, serf, inv };
}

describe('serf-machine — 12 WaitForResourceOut', () => {
  it('resource in the out queue: pick it up, advance the queue, step out -> state 5', () => {
    const { state, serf, inv } = waitResourceState(4); // Ausgabe-Ware Typ 4
    dispatchSerf(state, serf);
    expect(serf.stateData[0]).toBe(5); // field_0xb = roher Queue-Typ = 4+1
    expect(serf.stateData[3]).toBe(0); // field_0xf-Vorbereitung / (0xd steht in [4])
    expect(unionU16(serf, 0xc)).toBe(33); // destination taken over
    expect(inv.outQueue[0].type).toBe(-1); // Queue vorgeschoben (Slot0 ← Slot1 = leer)
    expect([serf.col, serf.row]).toEqual([11, 21]); // ausgetreten
    expect(serf.state).toBe(5); // LeavingBuilding
    expect(serf.counter).toBe(149); // (COUNTER_FROM_ANIMATION[14]=319 * (0x1f^slope[10]=16 → 15)) >> 5
    expect(unionU8(serf, 0xf)).toBe(0xd); // follow-up state after leaving = 13
  });

  it('empty out queue: nothing happens, state stays 12', () => {
    const { state, serf, inv } = waitResourceState(-1); // no resource
    dispatchSerf(state, serf);
    expect(serf.state).toBe(12);
    expect([serf.col, serf.row]).toEqual([10, 20]);
    expect(inv.outQueue[0].type).toBe(-1);
    expect(serf.stateData[0]).toBe(0); // nothing picked up
  });
});

// --- handler 13 DropResourceOut (drop the resource at the flag and go back inside) ---

/** Serf @(11,21) h6 at flag #2 (all slots free), carries field_0xb=5 (raw)/dest 42; building UpLeft @(10,20). */
function dropResourceState(): { state: GameState; serf: Serf; flag: Flag } {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const here = posOf(11, 21, geo);
  const bld = posOf(10, 20, geo);
  mapTiles[here] = tile({ height: 6, object: 1, objIndex: 2, serfIndex: 6 });
  mapTiles[bld] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: 0 });
  const buildings: (Building | null)[] = [null, { index: 1, type: 11, constructing: false } as unknown as Building];
  const flag = {
    index: 2,
    resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDir: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
    hasResources: false,
  } as unknown as Flag;
  const flags: (Flag | null)[] = [null, null, flag];
  const serf = { index: 6, state: 13, col: 11, row: 21, counter: 0, tick: 900, animation: 0, stateData: [5, 42, 0, 0, 0] } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, null, serf];
  const state = { geo, gameTick: 1000, mapTiles, buildings, flags, serfs } as unknown as GameState;
  return { state, serf, flag };
}

describe('serf-machine — 13 DropResourceOut', () => {
  it('puts the resource into the first free slot, then enters the building -> state 4', () => {
    const { state, serf, flag } = dropResourceState();
    dispatchSerf(state, serf);
    expect(flag.resourceSlots[0]).toBe(4); // (roh 5 & 0x1f) - 1
    expect(flag.slotDir[0]).toBe(-1); // (5>>5 & 7) - 1
    expect(flag.slotDest[0]).toBe(42);
    expect(flag.hasResources).toBe(true);
    expect(serf.stateData[0]).toBe(0); // field_0xb geleert
    expect([serf.col, serf.row]).toEqual([10, 20]); // entered the building
    expect(serf.state).toBe(4); // EnteringBuilding
    expect(serf.counter).toBe(319); // Geh-Dauer = COUNTER_FROM_ANIMATION[39]
    expect(unionU16(serf, 0xc)).toBe(179); // inside walk length (319*18)>>5
  });
});

// --- Handler 15 ReadyToLeaveInventory ---

/** Serf in the inventory building(10) @(10,20) h5 (own tile free), flag tile @(11,21) h6 free; inventory #1. */
function leaveInventoryState(ownTileBlocked = false): { state: GameState; serf: Serf; inv: Inventory } {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const here = posOf(10, 20, geo);
  const flag = posOf(11, 21, geo);
  mapTiles[here] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: ownTileBlocked ? 9 : 0 });
  mapTiles[flag] = tile({ height: 6, object: 1, objIndex: 2, serfIndex: 0 });
  const buildings: (Building | null)[] = [
    null,
    { index: 1, type: 10, constructing: false, inventoryIndex: 1 } as unknown as Building,
  ];
  const inv = { index: 1, serfIndices: new Array(27).fill(0).map((_, i) => (i === 4 ? 5 : 0)) } as unknown as Inventory;
  const inventories: (Inventory | null)[] = [null, inv];
 // field_0xb=3 (not 0xff/0xfd), field_0xe=1 (inventory index)
  const serf = { index: 5, state: 15, col: 10, row: 20, counter: 0, tick: 900, animation: 0, stateData: [3, 0, 0, 1, 0] } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, serf];
  const state = { geo, gameTick: 1000, mapTiles, buildings, inventories, serfs } as unknown as GameState;
  return { state, serf, inv };
}

describe('serf-machine — 15 ReadyToLeaveInventory', () => {
  it('steps out of the inventory to the flag, books serfIndices[4]--, state -> 5', () => {
    const { state, serf, inv } = leaveInventoryState();
    dispatchSerf(state, serf);
    expect(inv.serfIndices[4]).toBe(4); // dekrementiert (war 5)
    expect(serf.stateData[3]).toBe(0); // field_0xe low byte cleared
    expect(serf.stateData[4]).toBe(2); // field_0xf = 2 (field_0xb != 0xfd)
    expect([serf.col, serf.row]).toEqual([11, 21]);
    expect(serf.state).toBe(5); // LeavingBuilding
    expect(serf.animation).toBe(14); // Δh(+1) + 0xd
    expect(serf.counter).toBe(149); // (319 * (0x1f^slope[10]=16 → 15)) >> 5
  });

  it('own tile occupied: blocked (anim 0x52), state stays 15', () => {
    const { state, serf, inv } = leaveInventoryState(true);
    dispatchSerf(state, serf);
    expect([serf.col, serf.row]).toEqual([10, 20]);
    expect(serf.animation).toBe(0x52);
    expect(serf.counter).toBe(0);
    expect(serf.state).toBe(15);
    expect(inv.serfIndices[4]).toBe(5); // not booked
  });
});

// --- Handler 09 Building (Bau: Struktur hochziehen bis fertig) ---

/** Building serf(9) at slot 6 plus a building under construction at slot 1. Optional map/flag/player context. */
function buildingState(over: {
  serf?: Partial<Serf>;
  bld?: Partial<Building>;
  flags?: (Flag | null)[];
  players?: (Player | null)[];
  mapTiles?: Tile[];
}): { state: GameState; serf: Serf; bld: Building } {
  const bld = {
    index: 1,
    type: 2,
    owner: 0,
    constructing: true,
    progress: 0,
    flag: 0,
    holder: true,
    firstKnight: 5,
    burning: false,
    inventoryIndex: null,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
    stockMaximum: [0, 0],
    ...over.bld,
  } as unknown as Building;
  const buildings: (Building | null)[] = [null, bld];
  const serf = {
    index: 6,
    state: 9,
    counter: 3,
    tick: 1000,
    animation: 0,
    col: null,
    row: null,
    stateData: [0, 0, 0, 0, 0],
    ...over.serf,
  } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, null, serf];
  const state = {
    geo,
    gameTick: 1010,
    buildings,
    serfs,
    flags: over.flags ?? [null],
    players: over.players ?? [null, null, null, null],
    mapTiles: over.mapTiles ?? Array.from({ length: geo.tileCount }, () => tile()),
    rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
  return { state, serf, bld };
}

describe('serf-machine — 09 Building', () => {
  it('working: progress += step (type/phase), field_0xf--, no material consumed', () => {
 // field_0xb=0xff (working), field_0xc=1 (bldIndex), field_0xe=0, field_0xf=8; the counter underflows.
    const { state, serf, bld } = buildingState({
      serf: { stateData: [0xff, 1, 0, 0, 8] },
      bld: {
        type: 2, // Lumberjack, Phase 0 → BUILD_PROGRESS_STEP[4] = 4096
        progress: 0,
        stock: [
          { available: 5, requested: 0 },
          { available: 0, requested: 0 },
        ],
        stockMaximum: [5, 0],
      },
    });
    dispatchSerf(state, serf);
    expect(bld.progress).toBe(4096);
    expect(serf.stateData[4]).toBe(7); // field_0xf 8 → 7
    expect(bld.stock[0].available).toBe(5); // working consumes no material
    expect(serf.state).toBe(9);
  });

  it('requesting material (mode 0): consume the matching build material from the stock', () => {
 // field_0xb=0 → Setup (Modus 1) + Material; Hut(11) need=0b10, Schritt 0 → Brett (Slot 0).
    const { state, serf, bld } = buildingState({
      serf: { stateData: [0, 1, 0, 0, 0] },
      bld: {
        type: 11,
        progress: 1,
        stock: [
          { available: 2, requested: 0 },
          { available: 0, requested: 0 },
        ],
        stockMaximum: [1, 1],
      },
    });
    dispatchSerf(state, serf);
    expect(bld.stock[0].available).toBe(1); // 1 Brett verbraucht
    expect(bld.stockMaximum![0]).toBe(0); // stockMaximum ebenfalls -1
    expect(serf.stateData[3]).toBe(1); // field_0xe (Material-Schritt) 0 → 1
    expect(serf.stateData[4]).toBe(8); // field_0xf = 8 Arbeits-Iterationen
    expect(serf.stateData[0]).toBe(0xff); // field_0xb → Arbeiten
    expect(bld.progress).toBe(1); // no progress in the material branch
  });

  it('material missing: waiting branch (counter += 0x100), no progress, mode stays', () => {
    const { state, serf, bld } = buildingState({
      serf: { counter: 3, tick: 1000, stateData: [1, 1, 0, 0, 0] }, // Modus 1
      bld: {
        type: 11,
        progress: 1,
        stock: [
          { available: 0, requested: 0 },
          { available: 0, requested: 0 },
        ],
        stockMaximum: [1, 1],
      },
    });
    dispatchSerf(state, serf); // counter after advance = subU16(3,10) = 65529; +0x100 = 249 (>= 0xff00 -> no clamp)
    expect(serf.counter).toBe(249);
    expect(bld.progress).toBe(1);
    expect(bld.stock[0].available).toBe(0);
    expect(serf.stateData[0]).toBe(1); // field_0xb unchanged
    expect(serf.state).toBe(9);
  });

  it('completion: progress overflow -> constructing/holder cleared, score/counters, flag reset, exit', () => {
    const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
    const here = posOf(10, 20, geo);
    const flagTile = posOf(11, 21, geo); // DownRight
    mapTiles[here] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: 6 });
    mapTiles[flagTile] = tile({ height: 6, object: 1, objIndex: 2, serfIndex: 0 });
    const flag = { index: 2, acceptsSerfs: true, acceptsResources: true } as unknown as Flag;
    const player = {
      slot: 0,
      totalBuildingScore: 100,
      completedBuildingCount: new Array(23).fill(0),
      incompleteBuildingCount: new Array(23).fill(1),
    } as unknown as Player;
    const { state, serf, bld } = buildingState({
      serf: { col: 10, row: 20, counter: 3, tick: 1000, stateData: [0xff, 1, 0, 0, 0] },
      bld: {
        type: 2, // lumberjack; progress 63000 (phase 1) + 4096 -> overflow
        owner: 0,
        flag: 2,
        constructing: true,
        progress: 63000,
        holder: true,
        firstKnight: 5,
        stock: [
          { available: 0, requested: 0 },
          { available: 0, requested: 0 },
        ],
        stockMaximum: [0, 0],
      },
      flags: [null, null, flag],
      players: [player, null, null, null],
      mapTiles,
    });
    dispatchSerf(state, serf);
    expect(bld.constructing).toBe(false);
    expect(bld.progress).toBe(0);
    expect(bld.holder).toBe(false);
    expect(bld.firstKnight).toBe(0);
    expect(player.totalBuildingScore).toBe(102); // + BUILDING_SCORE[2] = 2
    expect(player.completedBuildingCount[1]).toBe(1); // Typ 2 → Array-Index 1
    expect(player.incompleteBuildingCount[1]).toBe(0);
    expect(flag.acceptsSerfs).toBe(false);
    expect(flag.acceptsResources).toBe(false);
 // `mov %eax,0xe(%ebx)` @0x25635 — from completion on the union carries the flag pointer
 // (base-relative `index * 70`) rather than the levelling height of the site. Without this store a
 // save game written by us kept the height there, and the original reads it as a pointer.
    expect(bld.level).toBe(2 * 70);
    expect(serf.state).toBe(5); // ausgetreten (stepOutToFlag → LeavingBuilding)
    expect([serf.col, serf.row]).toEqual([11, 21]);
  });
});

// --- handler 01 IdleInStock (sleep) / 66 IdleOnPath (wake check, rests when nothing is scheduled) ---

describe('serf-machine — 01/66 Sleep', () => {
  it('01 IdleInStock: counter and tick untouched (asleep), state stays 1', () => {
    const s = serf({ state: 1, counter: 123, tick: 1000, stateData: [1, 2, 3, 4, 5] });
    dispatchSerf(gs(1010), s);
    expect(s.counter).toBe(123);
    expect(s.tick).toBe(1000);
    expect(s.state).toBe(1);
    expect(s.stateData).toEqual([1, 2, 3, 4, 5]);
  });

  it('66 IdleOnPath: counter and tick untouched (asleep), state stays 66', () => {
    const s = serf({ state: 66, counter: 77, tick: 900 });
    dispatchSerf(gs(1000), s);
    expect(s.counter).toBe(77);
    expect(s.tick).toBe(900);
    expect(s.state).toBe(66);
  });

  it('01 IdleInStock: registers as serfIndices[type] in the inventory (in mode), without counter or tick', () => {
 // field_0xe = Inventar 0 (stateData[3]=0, [4]=0); Serf-Typ 21 (Generic), state 1.
    const s = serf({ state: 1, type: 21, counter: 50, tick: 500, stateData: [0, 0, 0, 0, 0] });
    const inv = {
      index: 0,
      owner: 0,
      serfMode: 0,
      serfIndices: new Array(27).fill(0),
      genericCount: 3,
    } as unknown as import('./state.js').Inventory;
    const state = { ...gs(510), inventories: [inv] } as unknown as GameState;
    dispatchSerf(state, s);
    expect(inv.serfIndices[21]).toBe(s.index); // registriert
    expect(s.counter).toBe(50); // eingefroren
    expect(s.tick).toBe(500);
    expect(s.state).toBe(1);
  });

  it('01 IdleInStock: type 10 (smelter) is NOT registered (@0x1f7bd = a bare ret)', () => {
    const s = serf({ state: 1, type: 10, counter: 50, tick: 500, stateData: [0, 0, 0, 0, 0] });
    const inv = mkInv({ serfMode: 0 });
    dispatchSerf({ ...gs(510), inventories: [inv] } as unknown as GameState, s);
    expect(inv.serfIndices[10]).toBe(0); // the only exception in the type table
    expect(s.state).toBe(1);
  });

  it('01 IdleInStock: the eviction gate is a BIT test — both 2 and 3 trigger (bt $0x3 @0x1f5d8)', () => {
    for (const mode of [2, 3]) {
 // `col/row = null` => state 15 returns immediately; only the gate matters here.
      const s = serf({ state: 1, type: 21, counter: 50, tick: 500, col: null, row: null, stateData: [0, 0, 0, 0, 0] });
      const inv = mkInv({ serfMode: mode });
      dispatchSerf({ ...gs(510), inventories: [inv] } as unknown as GameState, s);
      expect(s.stateData[0]).toBe(0xfd); // Auswurf-Kennung gesetzt
      expect(inv.serfIndices[4]).toBe(1); // serfs_out += 1
      expect(s.state).not.toBe(1);
    }
  });

  it('01 IdleInStock: modes 0 and 1 do NOT trigger (bit 3 clear)', () => {
    for (const mode of [0, 1]) {
      const s = serf({ state: 1, type: 21, counter: 50, tick: 500, stateData: [0, 0, 0, 0, 0] });
      const inv = mkInv({ serfMode: mode });
      dispatchSerf({ ...gs(510), inventories: [inv] } as unknown as GameState, s);
      expect(s.state).toBe(1);
      expect(inv.serfIndices[21]).toBe(s.index);
      expect(inv.serfIndices[4]).toBe(0);
    }
  });

  it('01 IdleInStock: the throttle holds at serfs_out >= 3 (cmpw $0x3 @0x1f5e7)', () => {
    const s = serf({ state: 1, type: 21, counter: 50, tick: 500, col: null, row: null, stateData: [0, 0, 0, 0, 0] });
    const inv = mkInv({ serfMode: 3 });
    inv.serfIndices[4] = 3;
    dispatchSerf({ ...gs(510), inventories: [inv] } as unknown as GameState, s);
    expect(s.state).toBe(1); // registriert statt ausgelagert
    expect(inv.serfIndices[4]).toBe(3);
    expect(s.stateData[0]).toBe(0);
  });

  it('01 IdleInStock: the representative cache is only cleared if HE is the one (@0x1f607)', () => {
 // (a) he himself is registered => the slot becomes 0
    const mine = serf({ state: 1, type: 21, col: null, row: null, stateData: [0, 0, 0, 0, 0] });
    const invA = mkInv({ serfMode: 3 });
    invA.serfIndices[21] = mine.index;
    dispatchSerf({ ...gs(510), inventories: [invA] } as unknown as GameState, mine);
    expect(invA.serfIndices[21]).toBe(0);
 // (b) SOMEONE ELSE is registered => the slot stays
    const other = serf({ state: 1, type: 21, col: null, row: null, stateData: [0, 0, 0, 0, 0] });
    const invB = mkInv({ serfMode: 3 });
    invB.serfIndices[21] = other.index + 99;
    dispatchSerf({ ...gs(510), inventories: [invB] } as unknown as GameState, other);
    expect(invB.serfIndices[21]).toBe(other.index + 99);
  });

 // --- Ritter-Ausbildung im Lager (@0x1f7be/@0x1f89e/@0x1f97e/@0x1fa5e) ---

  it('01 IdleInStock: Knight4 (type 26) does not age — registration only (@0x1fb3e)', () => {
    const s = serf({ state: 1, type: 26, counter: 4321, tick: 500, owner: 0, stateData: [0, 0, 0, 0, 0] });
    const inv = mkInv({ serfMode: 0 });
    dispatchSerf(trainState(510, inv), s);
    expect(inv.serfIndices[26]).toBe(s.index);
    expect(s.counter).toBe(4321); // frozen — the highest rank has no tick advance
    expect(s.tick).toBe(500);
  });

  it('01 IdleInStock: ranks 0..3 age (the counter runs, the tick follows)', () => {
    for (let r = 0; r < 4; r++) {
      const s = serf({ state: 1, type: 22 + r, counter: 4000, tick: 500, owner: 0, stateData: [0, 0, 0, 0, 0] });
      const inv = mkInv({ serfMode: 0 });
      dispatchSerf(trainState(510, inv), s);
      expect(s.counter).toBe(4000 - 10); // sub %ax,0x2(%ebx) @0x1f7ef
      expect(s.tick).toBe(510);
      expect(inv.serfIndices[22 + r]).toBe(s.index); // the cache is maintained on EVERY exit
      expect(s.type).toBe(22 + r); // no underflow => no draw
    }
  });

  it('01 IdleInStock: promotion on underflow plus a hit (threshold 4000 for rank 0)', () => {
    const s = serf({ state: 1, type: 22, counter: 0, tick: 500, owner: 0, stateData: [0, 0, 0, 0, 0] });
    const inv = mkInv({ serfMode: 0 });
    inv.serfIndices[22] = s.index;
 // RNG stub below the threshold => a guaranteed hit.
    const st = trainState(510, inv, { rngValue: 0 });
    dispatchSerf(st, s);
    expect(s.type).toBe(23); // serf[0] += 4 @0x1f814
    expect(s.counter).toBe(0x1770); // @0x1f85c
    expect(inv.serfIndices[22]).toBe(0); // alten Slot nullen @0x1f867
    expect(inv.serfIndices[23]).toBe(s.index); // neuen setzen @0x1f871
    const p = st.players[0]!;
    expect(p.totalMilitaryScore).toBe(100 + 1); // 1 << rang
    expect(p.serfCount[22]).toBe(9);
    expect(p.serfCount[23]).toBe(1);
  });

  it('01 IdleInStock: miss => +6000 and no rank change (@0x1f883)', () => {
    const s = serf({ state: 1, type: 24, counter: 0, tick: 500, owner: 0, stateData: [0, 0, 0, 0, 0] });
    const inv = mkInv({ serfMode: 0 });
 // Above the threshold (rank 2 draws below 1000) => miss.
    const st = trainState(501, inv, { rngValue: 0xffff });
    dispatchSerf(st, s);
    expect(s.type).toBe(24);
 // counter 0 - delta 1 = 0xffff, then +6000 with carry => 0x176f, the loop breaks.
    expect(s.counter).toBe(0x176f);
    expect(inv.serfIndices[24]).toBe(s.index);
    expect(st.players[0]!.totalMilitaryScore).toBe(100); // untouched
  });

  it('01 IdleInStock: thresholds halve per rank (value 999 only hits ranks 0..2)', () => {
 // 999 < 4000/2000/1000 (ranks 0/1/2) but >= 500 (rank 3) => rank 3 is NOT promoted.
    for (let r = 0; r < 4; r++) {
      const s = serf({ state: 1, type: 22 + r, counter: 0, tick: 500, owner: 0, stateData: [0, 0, 0, 0, 0] });
      const inv = mkInv({ serfMode: 0 });
      dispatchSerf(trainState(501, inv, { rngValue: 999 }), s);
      expect(s.type).toBe(r < 3 ? 23 + r : 25);
    }
  });
});

/** Game state for the training branches: needs `players` (score/census) and `rng`. */
function trainState(gameTick: number, inv: import('./state.js').Inventory, over?: { rngValue: number }): GameState {
  const serfCount = new Array(27).fill(0);
  serfCount[22] = 10;
  return {
    gameTick,
    inventories: [inv],
    players: [{ totalMilitaryScore: 100, serfCount } as unknown as import('./state.js').Player],
    rng: { next: () => over?.rngValue ?? 0x8000 },
  } as unknown as GameState;
}

/** Minimal inventory for the IdleInStock branches. */
function mkInv(over: { serfMode: number }): import('./state.js').Inventory {
  return {
    index: 0,
    owner: 0,
    resMode: 0,
    serfMode: over.serfMode,
    serfIndices: new Array(27).fill(0),
    genericCount: 3,
  } as unknown as import('./state.js').Inventory;
}

// --- 02 Walking: arrival handover (dest_reached) ---

/** Walking serf at flag #1 @(11,21); building UpLeft @(10,20). dest==1 (destination reached). */
function arriveState(over: { dir1: number; bldOccupiedBy?: number; burning?: boolean }): {
  state: GameState;
  serf: Serf;
  bld: number;
} {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const flagPos = posOf(11, 21, geo);
  const bld = posOf(10, 20, geo); // UpLeft
  mapTiles[flagPos] = tile({ height: 6, object: 1, objIndex: 1, serfIndex: 7 });
  mapTiles[bld] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: over.bldOccupiedBy ?? 0 });
  const buildings: (Building | null)[] = [
    null,
    { index: 1, type: 11, constructing: false, burning: over.burning ?? false, holder: false, serfRequested: true, firstKnight: 0, inventoryIndex: 9 } as unknown as Building,
  ];
 // came (F_E) = 0 (orientiert), dest (F_C) = 1 == flagIdx, dir1 (F_B) = over.dir1.
  const serf = {
    index: 7, state: 2, col: 11, row: 21, counter: 0, tick: 900, animation: 0,
    stateData: [over.dir1 & 0xff, 1, 0, 0, 0],
  } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, null, null, serf];
  const state = { geo, gameTick: 1000, mapTiles, buildings, serfs } as unknown as GameState;
  return { state, serf, bld };
}

describe('serf-machine — 02 Walking: arrival handover', () => {
  it('dir1 < 0, building tile free -> enter the building (holder set, state 4)', () => {
    const { state, serf, bld } = arriveState({ dir1: 0xfe }); // -2
    dispatchSerf(state, serf);
    expect(state.buildings[1]!.holder).toBe(true);
    expect(state.buildings[1]!.firstKnight).toBe(7); // serfRequested war true → firstKnight = index
    expect(state.buildings[1]!.serfRequested).toBe(false);
    expect(serf.state).toBe(4); // EnteringBuilding
    expect([serf.col, serf.row]).toEqual([10, 20]); // moved into the hut
    expect(state.mapTiles[bld].serfIndex).toBe(7);
  });

  it('dir1 < 0, building tile occupied -> ReadyToEnter (6) with waiting anim 0x55', () => {
    const { state, serf } = arriveState({ dir1: 0xfe, bldOccupiedBy: 99 });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(6); // ReadyToEnter, wartet
    expect(serf.animation).toBe(0x55);
    expect([serf.col, serf.row]).toEqual([11, 21]); // stays at the flag
  });

  it('dir1 == 6 → LookingForGeoSpot (42), Counter 0', () => {
    const { state, serf } = arriveState({ dir1: 6 });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(42);
    expect(serf.counter).toBe(0);
  });

  it('dir1 (0..5) -> become a carrier: length of both ends +1, state 3', () => {
    const { state, serf } = arriveState({ dir1: 2 }); // Down
 // Flag #1 with a road in direction 2 -> neighbour flag #2, opposite direction 5.
    const otherFlag = { length: [0, 0, 0, 0, 0, 0x81], otherEndDir: [0, 0, 0, 0, 0, 0], connections: [null, null, null, null, null, null], scheduled: [false, false, false, false, false, false], scheduledSlot: [0, 0, 0, 0, 0, 0], resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1], slotDir: [-1, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], hasResources: false } as unknown as Flag;
    const flag1 = { length: [0, 0, 0x80, 0, 0, 0], otherEndDir: [0, 0, 5, 0, 0, 0], connections: [null, null, { kind: 'flag', index: 2 }, null, null, null], scheduled: [false, false, false, false, false, false], scheduledSlot: [0, 0, 0, 0, 0, 0], resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1], slotDir: [-1, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], hasResources: false } as unknown as Flag;
    (state as unknown as { flags: (Flag | null)[] }).flags = [null, flag1, otherFlag];
    dispatchSerf(state, serf);
    expect(serf.state).toBe(3); // Transporting
    expect(flag1.length[2]).toBe(1); // 0x80 -> bit 7 cleared, +1
    expect(otherFlag.length[5]).toBe(2); // 0x81 → 1, +1 = 2
 // field_0xe was set to dir1=2, then the carrier took one step Down via change_direction
 // (Feld frei) → field_0xe = Gegenrichtung reverse(2) = 5 (= „woher").
    expect(serf.stateData[0xe - 0xb]).toBe(5);
    expect([serf.col, serf.row]).toEqual([11, 22]); // einen Schritt Down gelaufen
  });
});

// --- 04 EnteringBuilding ---

/** Serf in the building @(10,20) (inventory #9), inside walk finished. */
function insideState(over: {
  dir1: number;
  burning?: boolean;
  type?: number;
  bldType?: number;
  bldFlag?: number;
  flags?: (Flag | null)[];
  inventories?: (unknown | null)[];
  level?: number | null;
  inventoryIndex?: number | null;
}): { state: GameState; serf: Serf; bld: number } {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const bld = posOf(10, 20, geo);
  mapTiles[bld] = tile({ height: 5, object: 2, objIndex: 1, serfIndex: 7 });
  const buildings: (Building | null)[] = [
    null,
    {
      index: 1,
      type: over.bldType ?? 24,
      burning: over.burning ?? false,
      inventoryIndex: over.inventoryIndex === undefined ? 9 : over.inventoryIndex,
      flag: over.bldFlag ?? 0,
      level: over.level ?? null,
      active: false,
      playingSfx: true,
      stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
    } as unknown as Building,
  ];
 // counter 0, field_0xc 0 → innen angekommen (counter <= field_0xc). dir1 (F_B) = over.dir1.
  const serf = {
    index: 7, type: over.type ?? 5, state: 4, col: 10, row: 20, counter: 0, tick: 900, animation: 0,
    stateData: [over.dir1 & 0xff, 0, 0, 0, 0],
  } as unknown as Serf;
  const serfs: (Serf | null)[] = [null, null, null, null, null, null, null, serf];
  const state = {
    geo, gameTick: 1000, mapTiles, buildings, serfs,
    flags: over.flags ?? [],
    inventories: over.inventories ?? [],
  } as unknown as GameState;
  return { state, serf, bld };
}

describe('serf-machine — 04 EnteringBuilding', () => {
  it('field_0xb == -2 → IdleInStock (1), field_0xe = inventoryIndex, Serf-Feld frei', () => {
    const { state, serf, bld } = insideState({ dir1: 0xfe });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(1); // IdleInStock
    expect(serf.stateData[0xe - 0xb] | (serf.stateData[0xf - 0xb] << 8)).toBe(9); // inventoryIndex
    expect(serf.stateData[0xb - 0xb]).toBe(0); // field_0xb = 0
    expect(state.mapTiles[bld].serfIndex).toBe(0); // serf removed from the tile occupancy
  });

  it('burning building -> lost (25)', () => {
    const { state, serf } = insideState({ dir1: 0xfe, burning: true });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(25); // Lost
    expect(serf.counter).toBe(0);
  });

  it('Lumberjack (Typ 5), field_0xb=0 → PlanningLogging (18), Map-Serf-Feld frei', () => {
    const { state, serf, bld } = insideState({ dir1: 0, type: 5 });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(18);
    expect(state.mapTiles[bld].serfIndex).toBe(0);
  });

  it('Sawmiller (Typ 6) Erst-Eintritt (field_0xb=1) → Sawing (24), Flagge acceptsResources=false', () => {
    const flag = { acceptsSerfs: true, acceptsResources: true, stockPriority: [9, 9] } as unknown as Flag;
    const { state, serf } = insideState({ dir1: 1, type: 6, bldFlag: 3, flags: [null, null, null, flag] });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(24);
    expect(serf.stateData[0]).toBe(0); // sawing.mode = 0
    expect(flag.acceptsResources).toBe(false); // byte68 = 0x20 → Bit7 = 0
    expect(flag.stockPriority[1]).toBe(0); // byte69 = 0
  });

  it('miner (type 9) entering for the first time -> mining (29), building active, deposit correct', () => {
    const flag = { acceptsSerfs: false, acceptsResources: false, stockPriority: [9, 9] } as unknown as Flag;
 // bldType 7 = IronMine → deposit MINE_DEPOSIT[7-5]=MINE_DEPOSIT[2]=2 (Iron).
    const { state, serf } = insideState({ dir1: 1, type: 9, bldType: 7, bldFlag: 3, flags: [null, null, null, flag] });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(29);
    expect(serf.stateData[0]).toBe(0); // substate = 0
    expect(serf.stateData[3]).toBe(2); // field_0xe = deposit = 2 (Iron)
    expect(state.buildings[1]!.active).toBe(true); // start_activity
    expect(state.buildings[1]!.playingSfx).toBe(false); // stop_playing_sfx
  });

  it('Smelter (Typ 10): SteelSmelter → field_0xd=0, GoldSmelter → 0xff', () => {
    const s1 = insideState({ dir1: 0, type: 10, bldType: 18 }); // SteelSmelter
    dispatchSerf(s1.state, s1.serf);
    expect(s1.serf.state).toBe(30);
    expect(s1.serf.stateData[2]).toBe(0); // field_0xd = 0 (Stahl)

    const s2 = insideState({ dir1: 0, type: 10, bldType: 23 }); // GoldSmelter
    dispatchSerf(s2.state, s2.serf);
    expect(s2.serf.stateData[2]).toBe(0xff); // field_0xd = -1 (Gold)
  });

  it('PigFarmer (Typ 12) Erst-Eintritt → PigFarming (37) mode 0, Byte9=1; erneut → mode 6', () => {
    const pfFlag = { acceptsSerfs: false, acceptsResources: false, stockPriority: [0, 0] } as unknown as Flag;
    const first = insideState({ dir1: 1, type: 12, bldType: 14, bldFlag: 3, flags: [null, null, null, pfFlag] });
    dispatchSerf(first.state, first.serf);
    expect(first.serf.state).toBe(37);
    expect(first.serf.stateData[0]).toBe(0); // mode 0
    expect(first.state.buildings[1]!.stock[1]).toEqual({ available: 0, requested: 1 }); // Byte9 = 1

    const again = insideState({ dir1: 0, type: 12, bldType: 14 });
    dispatchSerf(again.state, again.serf);
    expect(again.serf.state).toBe(37);
    expect(again.serf.stateData[0]).toBe(6); // mode 6
  });

  it('Generic (Typ 21) → IdleInStock (1) + genericCount++', () => {
    const inv = { genericCount: 4 };
    const { state, serf, bld } = insideState({ dir1: 0, type: 21, inventoryIndex: 2, inventories: [null, null, inv] });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(1);
    expect(serf.stateData[3]).toBe(2); // field_0xe = inventoryIndex
    expect(inv.genericCount).toBe(5);
    expect(state.mapTiles[bld].serfIndex).toBe(0);
  });

  it('builder (type 3) -> building (9), anim 98 (regular) resp. 100 + material_step bit 7 (two phase)', () => {
    const reg = insideState({ dir1: 1, type: 3, bldType: 11 }); // hut = regular
    dispatchSerf(reg.state, reg.serf);
    expect(reg.serf.state).toBe(9);
    expect(reg.serf.animation).toBe(98);
    expect(reg.serf.stateData[0]).toBe(1); // mode = 1
    expect(reg.serf.stateData[3] & 0x80).toBe(0); // material_step Bit7 clear

    const two = insideState({ dir1: 1, type: 3, bldType: 17 }); // Sawmill = Zwei-Phasen
    dispatchSerf(two.state, two.serf);
    expect(two.serf.animation).toBe(100);
    expect(two.serf.stateData[3] & 0x80).toBe(0x80);
  });

  it('transporter (type 0) at the building -> WaitForResourceOut (12), type -> TransporterInventory (4)', () => {
    const flag = { acceptsSerfs: false, acceptsResources: false, stockPriority: [0, 0] } as unknown as Flag;
    const { state, serf } = insideState({ dir1: 1, type: 0, bldFlag: 3, flags: [null, null, null, flag] });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(12);
    expect(serf.counter).toBe(0x3f);
    expect(serf.type).toBe(4); // TransporterInventory
    expect(flag.acceptsSerfs).toBe(true); // byte66 = 0xc0 → Bit7 = 1
    expect(flag.acceptsResources).toBe(true); // byte68 = 0x80 → Bit7 = 1
  });

  it('Geologist (Typ 20) → LookingForGeoSpot (42), Map-Serf-Feld bleibt', () => {
    const { state, serf, bld } = insideState({ dir1: 0, type: 20 });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(42);
    expect(serf.counter).toBe(0);
    expect(state.mapTiles[bld].serfIndex).toBe(7); // NICHT geleert
  });
});

// --- 26 LostSailor / 27 FreeSailing ---------------------------------------------------------

/**
 * The sailor used to be a stub on a wrongly noted address (`@0x1baa2` lies inside the
 * body of state 25; the jump table names `0x1b6fb`). What is checked here is what sets him apart from
 * the land walker.
 */
function sailorState(over: {
  flagAt?: { col: number; row: number; endpointDirs?: boolean[]; owner?: number };
  blocked?: boolean;
} = {}): { state: GameState; serf: Serf; here: number } {
  const mapTiles = Array.from({ length: geo.tileCount }, () =>
    tile({ height: 5, blocked: over.blocked ?? true } as Partial<Tile>));
  const here = posOf(20, 20, geo);
  const serf = {
    index: 3, type: 1, owner: 0, state: 26, col: 20, row: 20,
    counter: 0, tick: 900, animation: 0, stateData: [0, 0, 0, 0, 0],
  } as unknown as Serf;
  const flags: (Flag | null)[] = [null];
  if (over.flagAt) {
    const p = posOf(over.flagAt.col, over.flagAt.row, geo);
    mapTiles[p] = tile({
      height: 5, object: 1, objIndex: 1, owner: (over.flagAt.owner ?? 0) + 1, blocked: true,
    } as Partial<Tile>);
    flags.push({
      index: 1,
      endpointDirs: over.flagAt.endpointDirs ?? [true, false, false, false, false, false],
    } as unknown as Flag);
  }
  mapTiles[here].serfIndex = 3;
  const state = {
    geo, gameTick: 1000, mapTiles, flags, serfs: [null, null, null, serf],
    buildings: [null], rng: new Rng([1, 2, 3]),
  } as unknown as GameState;
  return { state, serf, here };
}

describe('serf-machine — 26 LostSailor', () => {
  it('takes the nearest own connected flag as the destination and moves to 27', () => {
    const { state, serf } = sailorState({ flagAt: { col: 21, row: 20 } });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(27); // FreeSailing, NICHT 16 FreeWalking
    expect([unionU8(serf, 0xb), unionU8(serf, 0xc)]).toEqual([1, 0]); // Spiral-Delta (+1,0)
    expect(unionU8(serf, 0xd)).toBe(0x80); // neg_dist1 = −128
    expect(unionU8(serf, 0xe)).toBe(0xff);
    expect(unionU8(serf, 0xf)).toBe(0);
    expect(serf.counter).toBe(0);
  });

  it('skips a flag with NO road network connection (flag[4] & 0x3f == 0)', () => {
    const { state, serf } = sailorState({
      flagAt: { col: 21, row: 20, endpointDirs: [false, false, false, false, false, false] },
    });
    dispatchSerf(state, serf);
    expect(serf.state).toBe(27);
    expect([unionU8(serf, 0xb), unionU8(serf, 0xc)]).not.toEqual([1, 0]); // Zufallszweig
  });

  it('skips a foreign flag', () => {
    const { state, serf } = sailorState({ flagAt: { col: 21, row: 20, owner: 1 } });
    dispatchSerf(state, serf);
    expect([unionU8(serf, 0xb), unionU8(serf, 0xc)]).not.toEqual([1, 0]);
  });

  it('ohne Flagge: Zufalls-Delta aus −16..15 (feste Maske 0x1f, Versatz 0x10)', () => {
    const { state, serf } = sailorState();
    dispatchSerf(state, serf);
    expect(serf.state).toBe(27);
    for (const d of [unionU8(serf, 0xb), unionU8(serf, 0xc)]) {
      const v = (d << 24) >> 24;
      expect(v).toBeGreaterThanOrEqual(-16);
      expect(v).toBeLessThanOrEqual(15);
    }
  });

  it('is a knight-free branch — even a knight (type 22) goes to 27, not to 53', () => {
    const { state, serf } = sailorState({ flagAt: { col: 21, row: 20 } });
    serf.type = 22;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(27);
  });
});

describe('serf-machine — 27 FreeSailing', () => {
  it('land under the keel (blocking bit clear) => state 25 lost, field_0xb = 0', () => {
    const { state, serf, here } = sailorState();
    serf.state = 27;
    serf.counter = 0;
    setUnionU8(serf, 0xb, 5);
    state.mapTiles[here] = tile({ height: 5, blocked: false, serfIndex: 3 } as Partial<Tile>);
    state.gameTick = 1010;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(25);
    expect(unionU8(serf, 0xb)).toBe(0);
    expect(serf.counter).toBe(0);
  });

  it('on open water he sails on and changes tile', () => {
    const { state, serf, here } = sailorState();
    serf.state = 27;
    setUnionU8(serf, 0xb, 4); // Ziel vier Spalten weiter
    setUnionU8(serf, 0xd, 0x80);
    state.gameTick = 1010;
    dispatchSerf(state, serf);
    expect(serf.state).toBe(27);
    expect(posOf(serf.col!, serf.row!, geo)).not.toBe(here);
  });
});
