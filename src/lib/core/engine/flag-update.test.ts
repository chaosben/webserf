import { describe, it, expect } from 'vitest';
import { updateFlags } from './flag-update.js';
import type { GameState, Flag, Player } from './state.js';

/**
 * Flag resource scheduler (`FUN_0004b858`): known-dest search (sets `scheduled` + `slotDir`, which
 * wakes 66/67), unknown-dest via nearest inventory + move-back-forth, the hasResources gate, and
 * skipping slots that are already scheduled.
 */
function flag(over: Partial<Flag> = {}): Flag {
  return {
    index: 1,
    owner: 0,
    hasBuilding: false,
    hasResources: false,
    acceptsResources: false,
    acceptsSerfs: false,
    bldFlags: 0,
    paths: [false, false, false, false, false, false],
    connections: [null, null, null, null, null, null],
    transporters: [false, false, false, false, false, false],
    scheduled: [false, false, false, false, false, false],
    scheduledSlot: [0, 0, 0, 0, 0, 0],
    otherEndDir: [0, 0, 0, 0, 0, 0],
 // `flag[4]` bits 0..5 — set means land road. Needed here: the transporter request reads the bit
 // and without it would take every road for a water road (sailor instead of transporter).
    endpointDirs: [true, true, true, true, true, true],
    length: [0, 0, 0, 0, 0, 0],
    slotDir: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
    resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
    ...over,
  } as unknown as Flag;
}

function conn(index: number): { kind: 'flag'; index: number } {
  return { kind: 'flag', index };
}

// updateFlags is a pure block processor (the frame clock belongs to advanceFrameClock/tick.ts):
// rotation 0 means block 0 (flag index 0..31), so the flag under test (index 1) is processed.
function makeState(flags: (Flag | null)[], players: (Player | null)[] = [null, null, null, null]): GameState {
  return { flags, players, gameTick: 0, rotation: 0, rotationWrap: 49 } as unknown as GameState;
}

function player(flagPriority: number[]): Player {
  return { flagPriority } as unknown as Player;
}

describe('updateFlags — resource scheduler', () => {
  it('does nothing when hasResources is clear', () => {
    const f = flag({ index: 1, hasResources: false, resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1], slotDest: [5, 0, 0, 0, 0, 0, 0, 0] });
    updateFlags(makeState([null, f]));
    expect(f.slotDir[0]).toBe(-1);
    expect(f.scheduled.some((b) => b)).toBe(false);
  });

  it('known-dest: the neighbour in direction 1 IS the target -> scheduled + slotDir set, hasResources cleared', () => {
 // Target flag #5 hangs off direction 1; a transporter stands there (idle, no waiting slots).
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9 /*Stone*/, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [5, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(5), null, null, null, null],
      transporters: [false, true, false, false, false, false],
    });
    const dest = flag({ index: 5 });
    updateFlags(makeState([null, f, null, null, null, dest]));
    expect(f.slotDir[0]).toBe(1);
    expect(f.scheduled[1]).toBe(true);
    expect(f.scheduledSlot[1]).toBe(0);
    expect(f.hasResources).toBe(false);
  });

  it('known-dest: no transporter -> no sources -> hasResources set again, slotDir unchanged', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [5, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(5), null, null, null, null],
      transporters: [false, false, false, false, false, false],
    });
    const dest = flag({ index: 5 });
    updateFlags(makeState([null, f, null, null, null, dest]));
    expect(f.slotDir[0]).toBe(-1);
    expect(f.scheduled.some((b) => b)).toBe(false);
    expect(f.hasResources).toBe(true);
  });

  it('known-dest: target unreachable -> resource cancelled (dest=0), hasResources set again', () => {
 // Transporter in direction 1 -> neighbour #2 (dead end), target #5 unreachable.
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [5, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(2), null, null, null, null],
      transporters: [false, true, false, false, false, false],
    });
    const dead = flag({ index: 2 });
    updateFlags(makeState([null, f, dead, null, null, null]));
    expect(f.slotDest[0]).toBe(0);
    expect(f.slotDir[0]).toBe(-1);
    expect(f.hasResources).toBe(true);
  });

  it('known-dest unreachable: the booking goes back to the destination building (call 0x4a3af @0x4c669)', () => {
 // Without the return the site keeps a phantom `requested` forever: the demand tail goes silent as
 // soon as available + requested == stockMaximum, so it never asks again and the build stalls.
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [7 /*Plank*/, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [5, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(2), null, null, null, null],
      transporters: [false, true, false, false, false, false],
    });
    const dead = flag({ index: 2 });
    const dest = flag({
      index: 5,
      hasBuilding: true,
      connections: [null, null, null, null, { kind: 'building', index: 3 } as never, null],
    });
    const site = {
      index: 3,
      type: 21,
      stock: [
        { available: 0, requested: 2 },
        { available: 0, requested: 3 },
      ],
      stockMaximum: [2, 3],
    };
    const state = makeState([null, f, dead, null, null, dest]);
    (state as unknown as { buildings: unknown[] }).buildings = [null, null, null, site];
    (state as unknown as { header: { mapGoldTotal: number } }).header = { mapGoldTotal: 384 };
    updateFlags(state);
    expect(f.slotDest[0]).toBe(0);
    expect(site.stock[0]).toEqual({ available: 0, requested: 1 }); // plank slot given back
    expect(site.stock[1]).toEqual({ available: 0, requested: 3 }); // stone untouched
 // Second entry point: the resource only loses its destination, it is not destroyed — no gold leaves
 // the world (@0x4a398 would decrement, @0x4a3af does not).
    expect((state as unknown as { header: { mapGoldTotal: number } }).header.mapGoldTotal).toBe(384);
  });

  it('known-dest: multi-hop — neighbour #2 leads to target #5, the starting direction becomes slotDir', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [5, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, null, conn(2), null, null, null], // direction 2
      transporters: [false, false, true, false, false, false],
    });
 // `mid` needs a transporter on its onward road: the resource search runs over `flag[5]`
 // (`mov 0x5(%ebx),%al` @0x4c42a), not over `paths` — nobody carries on an unstaffed road.
    const mid = flag({ index: 2, connections: [null, conn(5), null, null, null, null], transporters: [false, true, false, false, false, false] });
    const dest = flag({ index: 5 });
    updateFlags(makeState([null, f, mid, null, null, dest]));
    expect(f.slotDir[0]).toBe(2); // the starting direction, not the intermediate one
    expect(f.scheduled[2]).toBe(true);
  });

  it('unknown-dest: the nearest inventory becomes slotDest, hasResources set again, slotDir stays -1', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0], // unknown
      connections: [null, conn(7), null, null, null, null],
      transporters: [false, true, false, false, false, false], // resource network == `flag[5]`, @0x44b4b
    });
    const inv = flag({ index: 7, acceptsResources: true });
    updateFlags(makeState([null, f, null, null, null, null, null, inv]));
    expect(f.slotDest[0]).toBe(7);
    expect(f.slotDir[0]).toBe(-1);
    expect(f.hasResources).toBe(true);
  });

  it('unknown-dest: no inventory reachable but a transporter is there -> move-back-forth (scheduled+slotDir)', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, null, conn(2), null, null, null],
      transporters: [false, false, true, false, false, false],
    });
    const nb = flag({ index: 2 }); // does not accept resources
    updateFlags(makeState([null, f, nb]));
    expect(f.slotDir[0]).toBe(2);
    expect(f.scheduled[2]).toBe(true);
    expect(f.scheduledSlot[2]).toBe(0);
  });

 // ── The start value of the direction search in the move-back-forth branch (LAB_0004bc44) ────
 //
 // The original does NOT pick the highest transporter direction; it counts down from a start value
 // (wrapping 0 -> 5). That start value is a leftover of `vreg2` and differs per path: routable
 // resources arrive via the demand BFS (which clears `vreg2` except for the low three bits, so
 // start 0), non-routable ones directly (start = `slotDir[0]` as a word). Reasoning in
 // `flag-update.ts`.
 //
 // Resource numbers here: 9 = stone (routable), 8 = boat (not routable) — the boat is one of the
 // `null` entries of the demand table and hence the only way to reach the second start value.

  it('move-back-forth, routable: start value 0 makes direction 0 beat the higher 4', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [conn(2), null, null, null, conn(3), null],
      transporters: [true, false, false, false, true, false],
    });
    updateFlags(makeState([null, f, flag({ index: 2 }), flag({ index: 3 })]));
 // A 'highest direction' rule would have picked 4 — this is where the start value separates.
    expect(f.slotDir[0]).toBe(0);
    expect(f.scheduled[0]).toBe(true);
  });

  it('move-back-forth, routable: start value 0 with no transporter there wraps to 5', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, null, null, conn(2), null, conn(3)],
      transporters: [false, false, false, true, false, true],
    });
    updateFlags(makeState([null, f, flag({ index: 2 }), flag({ index: 3 })]));
    expect(f.slotDir[0]).toBe(5);
  });

  it('move-back-forth, not routable (boat), slot 0 unscheduled: 0xffff & 7 gives start 3 -> direction 1', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [8 /* boat — not routable */, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(2), null, null, null, conn(3)],
      transporters: [false, true, false, false, false, true],
    });
    updateFlags(makeState([null, f, flag({ index: 2 }), flag({ index: 3 })]));
 // Start 3 -> downwards 3, 2, 1: direction 1 has a transporter. The highest would have been 5.
    expect(f.slotDir[0]).toBe(1);
    expect(f.scheduled[1]).toBe(true);
  });

  it('move-back-forth, not routable: the start value is slotDir[0] of the ALREADY scheduled slot 0', () => {
    const f = flag({
      index: 1,
      hasResources: true,
 // Slot 0 is scheduled (direction 4) and gets skipped — but its `slotDir` is exactly the leftover
 // the original leaves behind as the start value.
      resourceSlots: [9, -1, 8 /* boat */, -1, -1, -1, -1, -1],
      slotDir: [4, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, null, conn(2), null, conn(4), conn(3)],
      transporters: [false, false, true, false, true, true],
    });
    updateFlags(makeState([null, f, flag({ index: 2 }), flag({ index: 3 }), flag({ index: 4 })]));
 // Start 4 -> a transporter stands there, so 4 (and not 5, the highest).
    expect(f.slotDir[2]).toBe(4);
  });

  it('unknown-dest: no inventory, no transporter -> only hasResources set again (nothing schedulable)', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(2), null, null, null, null],
    });
    const nb = flag({ index: 2 });
    updateFlags(makeState([null, f, nb]));
    expect(f.slotDir[0]).toBe(-1);
    expect(f.scheduled.some((b) => b)).toBe(false);
    expect(f.hasResources).toBe(true);
  });

  it('skips slots that are already scheduled (slotDir >= 0)', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1],
      slotDir: [3, -1, -1, -1, -1, -1, -1, -1], // already direction 3
      slotDest: [5, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(5), null, null, null, null],
      transporters: [false, true, false, false, false, false],
    });
    const dest = flag({ index: 5 });
    updateFlags(makeState([null, f, null, null, null, dest]));
    expect(f.slotDir[0]).toBe(3); // unchanged — not rescheduled
  });

  it('known-dest priority arbitration: the higher priority resource takes over the slot of the direction', () => {
 // Two resources, both bound for #5 via direction 1. Slot 7 (Coal=12) is processed first (7->0),
 // then slot 0 (GoldBar=14). With a higher flag_prio for GoldBar, slot 0 takes over.
    const prio = new Array(26).fill(0);
    prio[12] = 5; // Coal
    prio[14] = 9; // GoldBar (higher)
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [14, -1, -1, -1, -1, -1, -1, 12],
      slotDest: [5, 0, 0, 0, 0, 0, 0, 5],
      connections: [null, conn(5), null, null, null, null],
      transporters: [false, true, false, false, false, false],
    });
    const dest = flag({ index: 5 });
    updateFlags(makeState([null, f, null, null, null, dest], [player(prio), null, null, null]));
    expect(f.scheduled[1]).toBe(true);
    expect(f.scheduledSlot[1]).toBe(0); // GoldBar (slot 0) displaced Coal (slot 7)
    expect(f.slotDir[0]).toBe(1);
    expect(f.slotDir[7]).toBe(1);
  });

  it('processes only the current rotation block (rotation * 32)', () => {
    const mk = () =>
      flag({ index: 1, hasResources: true, resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], connections: [null, conn(7), null, null, null, null], transporters: [false, true, false, false, false, false] });
    const invAt7 = () => flag({ index: 7, acceptsResources: true });
 // Rotation 1 -> block 1 (index 32..63) -> flag #1 not in it -> unchanged.
    const wrongBlock = mk();
    updateFlags({ flags: [null, wrongBlock, null, null, null, null, null, invAt7()], players: [null], rotation: 1, rotationWrap: 49 } as unknown as GameState);
    expect(wrongBlock.slotDest[0]).toBe(0);
    expect(wrongBlock.hasResources).toBe(true);
 // Rotation 0 -> block 0 (index 0..31) -> flag #1 processed.
    const on = mk();
    updateFlags({ flags: [null, on, null, null, null, null, null, invAt7()], players: [null], rotation: 0, rotationWrap: 49 } as unknown as GameState);
    expect(on.slotDest[0]).toBe(7);
  });

  it('processes no flags in economy rotations (rotation >= 32)', () => {
    const f = flag({ index: 1, hasResources: true, resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], connections: [null, conn(7), null, null, null, null], transporters: [false, true, false, false, false, false] });
    const inv = flag({ index: 7, acceptsResources: true });
    updateFlags({ flags: [null, f, null, null, null, null, null, inv], players: [null], rotation: 40, rotationWrap: 49 } as unknown as GameState);
    expect(f.slotDest[0]).toBe(0);
    expect(f.hasResources).toBe(true);
  });

  it('updateFlags skips null slots and processes every occupied one', () => {
    const a = flag({ index: 1, hasResources: true, resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], connections: [conn(3), null, null, null, null, null], transporters: [true, false, false, false, false, false] });
    const invB = flag({ index: 3, acceptsResources: true });
    expect(() => updateFlags(makeState([null, a, null, invB]))).not.toThrow();
    expect(a.slotDest[0]).toBe(3);
  });

 // Building constructor for the routable-demand tests (only the fields the scheduler reads).
  function bld(stock0req: number, stock1req = 0) {
    return { stock: [{ available: 0, requested: stock0req }, { available: 0, requested: stock1req }] } as unknown as NonNullable<GameState['buildings'][number]>;
  }
  function stateWithBld(flags: (Flag | null)[], buildings: (GameState['buildings'][number] | null)[]): GameState {
    return { flags, buildings, players: [null], gameTick: 0, rotation: 0, rotationWrap: 49 } as unknown as GameState;
  }

  it('routable unknown-dest: a fresh resource is routed to the requesting building (priority consumed, requested++)', () => {
 // Coal (res 12) -> DEMAND_TABLE {reqBit 2, flagByte 0x42} = slot 0 (bldFlags/stockPriority[0]).
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [12, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(2), null, null, null, null],
      transporters: [false, true, false, false, false, false], // demand BFS == `flag[5]`, @0x4bd66
    });
 // Flag #2: its building requests Coal (bldFlags bit 2 = 0x04), priority 4 (even, as phase B delivers).
 // UpLeft (dir 4) is the building link, so flagBuilding finds the building for requested++.
    const bconn = (i: number) => ({ kind: 'building' as const, index: i });
    const demand = flag({ index: 2, bldFlags: 0x04, stockPriority: [4, 0], connections: [null, null, null, null, bconn(2), null] });
    const building = bld(0);
    updateFlags(stateWithBld([null, f, demand], [null, null, building]));
    expect(f.slotDest[0]).toBe(2); // straight to the requesting building
    expect(f.hasResources).toBe(true);
    expect(f.slotDir[0]).toBe(-1); // dest set, scheduling follows as known-dest in the next pass
    expect(demand.stockPriority[0]).toBe(0); // priority consumed (4&1==0 -> 0)
    expect(building!.stock[0].requested).toBe(1); // add_requested_resource
  });

  it('routable: the higher priority wins', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [12, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(2), conn(3), null, null, null],
      transporters: [false, true, true, false, false, false],
    });
    const lo = flag({ index: 2, bldFlags: 0x04, stockPriority: [2, 0], connections: [null, null, null, null, conn(2), null] });
    const hi = flag({ index: 3, bldFlags: 0x04, stockPriority: [8, 0], connections: [null, null, null, null, conn(3), null] });
    updateFlags(stateWithBld([null, f, lo, hi], [null, null, bld(0), bld(0)]));
    expect(f.slotDest[0]).toBe(3); // the flag with priority 8, not 2
  });

  it('routable with no requesting building: falls back to the nearest inventory', () => {
    const f = flag({
      index: 1,
      hasResources: true,
      resourceSlots: [12, -1, -1, -1, -1, -1, -1, -1],
      slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
      connections: [null, conn(7), null, null, null, null],
      transporters: [false, true, false, false, false, false],
    });
    const inv = flag({ index: 7, acceptsResources: true });
    updateFlags(stateWithBld([null, f, null, null, null, null, null, inv], [null]));
    expect(f.slotDest[0]).toBe(7); // no demand bit set -> inventory
  });
});

/**
 * `call_transporter` + inventory serf dispatch: if a road lacks a transporter, a generic from the
 * reachable inventory is specialised and sent out (state 1 -> 15, `field_0xb` = direction,
 * `field_0xc` = flag, genericCount decremented, serfCount census, length bit 7).
 */
describe('updateFlags — transporter request (call_transporter)', () => {
  const bcon = (i: number) => ({ kind: 'building' as const, index: i });
  function idleGeneric(over: Record<string, unknown> = {}) {
    return { index: 10, type: 21, state: 1, stateData: [0, 0, 0, 0, 0], col: 25, row: 46, ...over } as unknown as NonNullable<GameState['serfs'][number]>;
  }
  function inventory(over: Record<string, unknown> = {}) {
    return { index: 1, owner: 0, genericCount: 5, serfIndices: new Array(27).fill(0), ...over } as unknown as NonNullable<GameState['inventories'][number]>;
  }
  function castle() {
    return { index: 1, type: 24, inventoryIndex: 1 } as unknown as NonNullable<GameState['buildings'][number]>;
  }
  function withCensus(over: Record<string, unknown> = {}): Player {
    const serfCount = new Array(27).fill(0);
    serfCount[21] = 5;
    return { serfCount, ...over } as unknown as Player;
  }
  function roadFlag(over: Partial<Flag> = {}): Flag {
 // Flag #1 with a road in direction 0 (Right) to inventory flag #2; length[0]=0 (no transporter, bit 7 clear).
    return flag({ index: 1, paths: [true, false, false, false, false, false], length: [0, 0, 0, 0, 0, 0], otherEndDir: [3, 0, 0, 0, 0, 0], connections: [conn(2), null, null, null, null, null], ...over });
  }
  function invFlag(over: Partial<Flag> = {}): Flag {
 // Inventory flag #2 (has_inventory = bldFlags bit 6), building in direction UpLeft (4).
    return flag({ index: 2, bldFlags: 0x40, connections: [null, null, null, null, bcon(1), null], ...over });
  }
  function mk(flags: (Flag | null)[], inv: NonNullable<GameState['inventories'][number]>, serf: NonNullable<GameState['serfs'][number]>, p: Player): GameState {
    const serfs = Array.from({ length: 11 }, (_v, i) => (i === 10 ? serf : null));
    return { flags, buildings: [null, castle()], inventories: [null, inv], players: [p, null, null, null], serfs, gameTick: 0, rotation: 0, rotationWrap: 49 } as unknown as GameState;
  }

  it('dispatches a generic as transporter (state 1 -> 15, specialised + counters)', () => {
    const s = idleGeneric();
    const idx = new Array(27).fill(0);
    idx[21] = 10; // serfIndices[Generic] -> serf #10
    const inv = inventory({ serfIndices: idx });
    const rf = roadFlag();
    const iff = invFlag();
    const p = withCensus();
    updateFlags(mk([null, rf, iff], inv, s, p));
    expect(s.state).toBe(15); // ReadyToLeaveInventory
    expect(s.type).toBe(0); // generic -> transporter
    expect(s.stateData[0]).toBe(0); // field_0xb = road direction 0
    expect(s.stateData[1]).toBe(1); // field_0xc (low) = flag #1
    expect(s.stateData[3]).toBe(1); // field_0xe (low) = inventory #1
    expect(inv.genericCount).toBe(4);
    expect(inv.serfIndices[21]).toBe(0);
    expect(inv.serfIndices[4]).toBe(1); // out-dispatch counter
    expect(p.serfCount[21]).toBe(4);
    expect(p.serfCount[0]).toBe(1);
    expect(rf.length[0] & 0x80).toBe(0x80); // road marked (rate limit)
    expect(iff.length[3] & 0x80).toBe(0x80); // other end (otherEndDir 3) marked
  });

  it('road already requested (length bit 7) -> no dispatch', () => {
    const s = idleGeneric();
    const idx = new Array(27).fill(0);
    idx[21] = 10;
    const inv = inventory({ serfIndices: idx });
    updateFlags(mk([null, roadFlag({ length: [0x80, 0, 0, 0, 0, 0] }), invFlag()], inv, s, withCensus()));
    expect(s.state).toBe(1);
    expect(inv.genericCount).toBe(5);
  });

  it('a stored transporter is preferred (no specialisation)', () => {
    const s = idleGeneric({ index: 10, type: 0 }); // already a transporter
    const idx = new Array(27).fill(0);
    idx[0] = 10; // serfIndices[Transporter] -> serf #10
    const inv = inventory({ serfIndices: idx });
    const p = withCensus();
    updateFlags(mk([null, roadFlag(), invFlag()], inv, s, p));
    expect(s.state).toBe(15);
    expect(inv.serfIndices[0]).toBe(0);
    expect(inv.genericCount).toBe(5); // untouched (no generic consumed)
    expect(p.serfCount[21]).toBe(5); // no census update
  });

  it('no inventory able to deliver is reachable -> no dispatch', () => {
    const s = idleGeneric();
    const inv = inventory({ genericCount: 0, serfIndices: new Array(27).fill(0) }); // empty
    updateFlags(mk([null, roadFlag(), invFlag()], inv, s, withCensus()));
    expect(s.state).toBe(1);
  });

 // --- Water road: sailor instead of transporter (`FUN_00011a81`, switch `flag[4]` bit dir @0x4c8d7) ---

 /**
  * Like {@link roadFlag}, but direction 0 is a water road (`flag[4]` bit 0 clear) to the far flag #3,
  * and direction 1 a staffed land road to inventory flag #2.
  *
  * The land road is not decoration but the precondition: the inventory search of the transporter
  * request runs over `flag[4]` (`mov 0x4(%ebx),%al` @0x11f61) and therefore never enters the water
  * road. That is the topology of the original — the sailor walks over LAND to his water road. If the
  * warehouse hung off the water road alone, no sailor would come.
  */
  function boatRoadFlag(over: Partial<Flag> = {}): Flag {
    return roadFlag({
      endpointDirs: [false, true, true, true, true, true],
      paths: [true, true, false, false, false, false],
      connections: [conn(3), conn(2), null, null, null, null],
      length: [0, 1, 0, 0, 0, 0], // the land road already has a transporter, so only the water road requests
      transporters: [false, true, false, false, false, false],
      otherEndDir: [3, 4, 0, 0, 0, 0],
      ...over,
    });
  }
 /** Far end of the water road (#3) — contributes nothing itself but has to exist. */
  function farFlag(): Flag {
    return flag({ index: 3, paths: [false, false, false, true, false, false], connections: [null, null, null, conn(1), null, null], endpointDirs: [false, false, false, false, false, false] });
  }

  it('a water road specialises a generic into a SAILOR and consumes a boat', () => {
    const s = idleGeneric();
    const idx = new Array(27).fill(0);
    idx[21] = 10;
    const res = new Array(26).fill(0);
    res[8] = 2; // two boats in the warehouse
    const inv = inventory({ serfIndices: idx, resources: res });
    const p = withCensus();
    updateFlags(mk([null, boatRoadFlag(), invFlag(), farFlag()], inv, s, p));
    expect(s.state).toBe(15); // ReadyToLeaveInventory
    expect(s.type).toBe(1); // generic -> sailor, not transporter
    expect(inv.resources[8]).toBe(1); // `inv+0x16 -= 1` @LAB_000121af
    expect(p.serfCount[21]).toBe(4);
    expect(p.serfCount[1]).toBe(1); // `player-0x38` == serfCount[Sailor]
    expect(p.serfCount[0]).toBe(0); // and NOT the transporter counter
  });

  it('water road with no boat in the warehouse -> no dispatch', () => {
    const s = idleGeneric();
    const idx = new Array(27).fill(0);
    idx[21] = 10;
    const inv = inventory({ serfIndices: idx, resources: new Array(26).fill(0) });
    updateFlags(mk([null, boatRoadFlag(), invFlag(), farFlag()], inv, s, withCensus()));
    expect(s.state).toBe(1); // stays in the warehouse
  });

  it('a water road prefers a stored sailor (no boat consumed)', () => {
    const s = idleGeneric({ index: 10, type: 1 }); // already a sailor
    const idx = new Array(27).fill(0);
    idx[1] = 10; // serfIndices[Sailor] -> serf #10
    const res = new Array(26).fill(0);
    res[8] = 2;
    const inv = inventory({ serfIndices: idx, resources: res });
    const p = withCensus();
    updateFlags(mk([null, boatRoadFlag(), invFlag(), farFlag()], inv, s, p));
    expect(s.state).toBe(15);
    expect(inv.serfIndices[1]).toBe(0);
    expect(inv.resources[8]).toBe(2); // he already has his boat
    expect(inv.genericCount).toBe(5);
    expect(p.serfCount[21]).toBe(5); // no census update
  });

  it('the same road as a LAND road yields a transporter (discrimination)', () => {
    const s = idleGeneric();
    const idx = new Array(27).fill(0);
    idx[21] = 10;
    const res = new Array(26).fill(0);
    res[8] = 2;
    const inv = inventory({ serfIndices: idx, resources: res });
    const p = withCensus();
    updateFlags(mk([null, roadFlag(), invFlag()], inv, s, p));
    expect(s.type).toBe(0);
    expect(inv.resources[8]).toBe(2); // a land road consumes no boat
    expect(p.serfCount[0]).toBe(1);
  });

  it('enough transporters on the road (count >= need, no demand) -> no dispatch', () => {
    const s = idleGeneric();
    const idx = new Array(27).fill(0);
    idx[21] = 10;
    const inv = inventory({ serfIndices: idx });
 // length[0] = 1 transporter, category 0 -> need=1 -> count==need, no res_waiting demand.
    updateFlags(mk([null, roadFlag({ length: [0x01, 0, 0, 0, 0, 0] }), invFlag()], inv, s, withCensus()));
    expect(s.state).toBe(1);
  });
});
