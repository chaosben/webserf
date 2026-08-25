import { describe, it, expect } from 'vitest';
import { directionStep, transporterOnRoadStep, singleBitDir, flagSearchDir, findNearestInventory, walkingWaiting, arrivalCleanup } from './serf-movement.js';
import { COUNTER_FROM_ANIMATION } from './serf-tables.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import type { GameState, Serf, Tile } from './state.js';

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

/** Minimal state with an empty map; the caller sets the relevant tiles + serfs. */
function makeState(): GameState {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  return { geo, gameTick: 1000, mapTiles, serfs: [] as (Serf | null)[] } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number }): Serf {
  return {
    counter: 0,
    tick: 0,
    animation: 0,
    state: 2,
    col: 0,
    row: 0,
    stateData: [0, 0, 0, 0, 0],
    ...over,
  } as unknown as Serf;
}

describe('singleBitDir', () => {
  it('a single bit -> direction; 0 or several bits -> null', () => {
    expect(singleBitDir(0b000001)).toBe(Direction.Right);
    expect(singleBitDir(0b000010)).toBe(Direction.DownRight);
    expect(singleBitDir(0b000100)).toBe(Direction.Down);
    expect(singleBitDir(0b001000)).toBe(Direction.Left);
    expect(singleBitDir(0b010000)).toBe(Direction.UpLeft);
    expect(singleBitDir(0b100000)).toBe(Direction.Up);
    expect(singleBitDir(0)).toBeNull();
    expect(singleBitDir(0b000011)).toBeNull();
    expect(singleBitDir(0b101000)).toBeNull();
  });
});

describe('directionStep — free step', () => {
  it('Right on flat ground: serf moved, occupancy/field_0xe/counter byte-exact', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(11, 20, geo);
    state.mapTiles[here] = tile({ serfIndex: 7 });
    state.mapTiles[next] = tile({ serfIndex: 0 });
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 100, animation: 99 });
    state.serfs[7] = serf;

    const res = directionStep(state, serf, Direction.Right);

    expect([serf.col, serf.row]).toEqual([11, 20]);
    expect(state.mapTiles[here].serfIndex).toBe(0);
    expect(state.mapTiles[next].serfIndex).toBe(7);
    expect(serf.stateData[3]).toBe(Direction.Left); // field_0xe = reverse of Right
    // Animation index 4 (= 4 + 9*0 + dH0); budget = COUNTER_FROM_ANIMATION[4]
    const budget = COUNTER_FROM_ANIMATION[4];
    expect(serf.counter).toBe(100 + budget); // no overflow -> 'continue'
    expect(res).toBe('continue');
    expect(serf.animation).toBe(99); // unchanged on 'continue'
  });

  it('counter overflow -> the tick ends on the tile (animation set, stop)', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(11, 20, geo);
    state.mapTiles[here] = tile({ serfIndex: 7 });
    state.mapTiles[next] = tile({ serfIndex: 0 });
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 0xffff });
    state.serfs[7] = serf;

    const res = directionStep(state, serf, Direction.Right);

    expect(res).toBe('stop');
    expect(serf.animation).toBe(4); // myAnim
    expect(serf.counter).toBe((0xffff + COUNTER_FROM_ANIMATION[4]) & 0xffff);
  });

  it('the height difference enters the animation index', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(10, 21, geo);
    state.mapTiles[here] = tile({ height: 3, serfIndex: 7 });
    state.mapTiles[next] = tile({ height: 5, serfIndex: 0 });
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 0xffff });
    state.serfs[7] = serf;

    directionStep(state, serf, Direction.Down);
    // Down (dir2), dH = +2 -> anim = 4 + 9*2 + 2 = 24
    expect(serf.animation).toBe(24);
    expect(serf.stateData[3]).toBe(Direction.Up); // reverse of Down
  });
});

describe('directionStep — blocked', () => {
  it('dir 3..5 with an occupied target tile: wait (no step)', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(9, 20, geo);
    state.mapTiles[here] = tile({ serfIndex: 7 });
    state.mapTiles[next] = tile({ serfIndex: 3 });
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 500 });
    state.serfs[7] = serf;

    const res = directionStep(state, serf, Direction.Left);

    expect(res).toBe('blocked');
    expect([serf.col, serf.row]).toEqual([10, 20]); // not moved
    expect(serf.counter).toBe(0x7f);
    expect(serf.animation).toBe(0x51 + Direction.Left); // 0x54 — still facing Left
    expect(serf.stateData[3]).toBe((0xfa + Direction.Left) & 0xff); // waiting marker 0xfd
  });

  it('the waiting animation depends on the direction: 0x51 + dir for all six', () => {
    // In the binary: mov $0x51..$0x56,%al in the six direction routines.
    for (const dir of [0, 1, 2, 3, 4, 5]) {
      const state = makeState();
      const here = posOf(10, 20, geo);
      const next = neighbor(here, dir, geo);
      state.mapTiles[here] = tile({ serfIndex: 7 });
      state.mapTiles[next] = tile({ serfIndex: 8 });
      const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 500 });
      // Not swappable (facing wrong) -> dir 0..2 end up in the waiting branch too.
      state.serfs[7] = serf;
      state.serfs[8] = mkSerf({ index: 8, state: 2, stateData: [0, 0, 0, 0, 0] });

      expect(directionStep(state, serf, dir)).toBe('blocked');
      expect(serf.animation).toBe(0x51 + dir);
    }
  });

  it('dir 0..2, occupied by a NON-swappable serf: wait', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(11, 20, geo); // Right
    state.mapTiles[here] = tile({ serfIndex: 7 });
    state.mapTiles[next] = tile({ serfIndex: 8 });
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 500 });
    // The other serf faces the wrong way (field_0xe != -3) -> no swap.
    const other = mkSerf({ index: 8, col: 11, row: 20, state: 2, stateData: [0, 0, 0, 0, 0] });
    state.serfs[7] = serf;
    state.serfs[8] = other;

    const res = directionStep(state, serf, Direction.Right);
    expect(res).toBe('blocked');
    expect(serf.stateData[3]).toBe(0xfa); // waiting marker for Right
  });
});

describe('directionStep — transporter swap (dir 0..2)', () => {
  it('Right against a head-on blocked transporter: both swap tiles', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(11, 20, geo);
    state.mapTiles[here] = tile({ serfIndex: 7 });
    state.mapTiles[next] = tile({ serfIndex: 8 });
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 100 });
    // Partner: field_0xe = dir-3 = -3 (0xfd), state 3 (Transporting) -> swappable.
    const other = mkSerf({ index: 8, col: 11, row: 20, state: 3, stateData: [0, 0, 0, 0xfd, 0] });
    state.serfs[7] = serf;
    state.serfs[8] = other;

    const res = directionStep(state, serf, Direction.Right);

    expect(res).toBe('continue');
    // Positions swapped:
    expect([serf.col, serf.row]).toEqual([11, 20]);
    expect([other.col, other.row]).toEqual([10, 20]);
    expect(state.mapTiles[next].serfIndex).toBe(7);
    expect(state.mapTiles[here].serfIndex).toBe(8);
    // field_0xe: self = reverse direction (Left), partner = my direction (Right).
    expect(serf.stateData[3]).toBe(Direction.Left);
    expect(other.stateData[3]).toBe(Direction.Right);
    // Partner animation = 4 + 9*(dir+3) - dH = 31 (dH0); budget accordingly.
    expect(other.animation).toBe(31);
    expect(other.counter).toBe(COUNTER_FROM_ANIMATION[31]);
    // Own animation (the swapping side) = 4 + 9*(dir+6) = 58.
    expect(serf.counter).toBe(100 + COUNTER_FROM_ANIMATION[58]);
  });
});

describe('transporterOnRoadStep — field_0xf survives the step', () => {
  it('preserves field_0xf on a road step (unlike directionStep, the transporter step does NOT clear it)', () => {
    // Straight road, `next` is NOT a flag -> transporterOnRoadStep enters the directionStep branch.
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(11, 20, geo); // no flag object
    state.mapTiles[here] = tile({ serfIndex: 7, paths: 0b001001 });
    state.mapTiles[next] = tile({ serfIndex: 0, paths: 0b001001 });
    const serf = mkSerf({ index: 7, state: 3, col: 10, row: 20, counter: 100, stateData: [0, 0, 0, 0, 2] }); // field_0xf = 2
    state.serfs[7] = serf;

    const res = transporterOnRoadStep(state, serf, Direction.Right);

    expect([serf.col, serf.row]).toEqual([11, 20]); // walked
    expect(serf.stateData[4]).toBe(2); // field_0xf PRESERVED (the idle counter accumulates over steps)
    expect(res).not.toBe('blocked');
  });

  it('counter check: directionStep (the walking variant) clears field_0xf on a successful step', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(11, 20, geo);
    state.mapTiles[here] = tile({ serfIndex: 7 });
    state.mapTiles[next] = tile({ serfIndex: 0 });
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 100, stateData: [0, 0, 0, 0, 2] });
    state.serfs[7] = serf;

    directionStep(state, serf, Direction.Right);

    expect(serf.stateData[4]).toBe(0); // directionStep clears field_0xf (correct for the walking wait counter)
  });
});

describe('flagSearchDir — shortest-path BFS across the flag network', () => {
  // Small flag network: 1 -Right-> 2 -Down-> 4 ; 1 -Down-> 3 (dead end).
  function flag(conns: (readonly [number, 'flag' | 'building', number])[]): unknown {
    const connections: ({ kind: 'flag' | 'building'; index: number } | null)[] = [null, null, null, null, null, null];
    for (const [dir, kind, index] of conns) connections[dir] = { kind, index };
    // `endpointDirs[dir]` == land road (`flag[4]` bit dir). In real save games `flag[3]` and
    // `flag[4]` are always set together for flag-to-flag roads and neither is set on a building
    // link — which is what this derivation reproduces. Water roads are set explicitly per test.
    const endpointDirs = connections.map((c) => c?.kind === 'flag');
    return { connections, endpointDirs };
  }
  function netState(): GameState {
    const s = makeState();
    const flags: (unknown | null)[] = [];
    flags[1] = flag([[Direction.Right, 'flag', 2], [Direction.Down, 'flag', 3]]);
    flags[2] = flag([[Direction.Left, 'flag', 1], [Direction.Down, 'flag', 4]]);
    flags[3] = flag([[Direction.Up, 'flag', 1]]);
    flags[4] = flag([[Direction.Up, 'flag', 2]]);
    (s as unknown as { flags: unknown[] }).flags = flags;
    return s;
  }

  it('a direct neighbour -> its direction', () => {
    expect(flagSearchDir(netState(), 1, 2)).toBe(Direction.Right);
    expect(flagSearchDir(netState(), 1, 3)).toBe(Direction.Down);
  });

  it('two hops -> the start direction of the shortest path (1->2->4 => Right)', () => {
    expect(flagSearchDir(netState(), 1, 4)).toBe(Direction.Right);
  });

  it('an unreachable target -> null', () => {
    expect(flagSearchDir(netState(), 1, 99)).toBeNull();
  });

  it('a building endpoint is not expanded (kind !== flag)', () => {
    const s = makeState();
    const flags: (unknown | null)[] = [];
    flags[1] = flag([[Direction.UpLeft, 'building', 5]]);
    (s as unknown as { flags: unknown[] }).flags = flags;
    expect(flagSearchDir(s, 1, 5)).toBeNull();
  });
});

describe('findNearestInventory — the nearest inventory flag in the network (FUN_00044703)', () => {
  // Network: 1 -Right-> 2 -Down-> 4 (inventory) ; 1 -Down-> 3. From start 1, flag 4 is the nearest.
  function flag(acceptsSerfs: boolean, conns: (readonly [number, 'flag' | 'building', number])[]): unknown {
    const connections: ({ kind: 'flag' | 'building'; index: number } | null)[] = [null, null, null, null, null, null];
    for (const [dir, kind, index] of conns) connections[dir] = { kind, index };
    const endpointDirs = connections.map((c) => c?.kind === 'flag'); // see above
    return { connections, endpointDirs, acceptsSerfs };
  }
  function netState(inv: number): GameState {
    const s = makeState();
    const flags: (unknown | null)[] = [];
    flags[1] = flag(inv === 1, [[Direction.Right, 'flag', 2], [Direction.Down, 'flag', 3]]);
    flags[2] = flag(inv === 2, [[Direction.Left, 'flag', 1], [Direction.Down, 'flag', 4]]);
    flags[3] = flag(inv === 3, [[Direction.Up, 'flag', 1]]);
    flags[4] = flag(inv === 4, [[Direction.Up, 'flag', 2]]);
    (s as unknown as { flags: unknown[] }).flags = flags;
    return s;
  }

  it('finds the nearest reachable inventory flag (BFS, 2 hops)', () => {
    expect(findNearestInventory(netState(4), 1)).toBe(4);
  });

  it('the start flag is itself an inventory -> itself', () => {
    expect(findNearestInventory(netState(1), 1)).toBe(1);
  });

  it('the nearer inventory flag wins (1 hop over 2 hops)', () => {
    // Both 2 (1 hop) and 4 (2 hops) are inventories -> 2 wins.
    const s = makeState();
    const flags: (unknown | null)[] = [];
    flags[1] = flag(false, [[Direction.Right, 'flag', 2], [Direction.Down, 'flag', 3]]);
    flags[2] = flag(true, [[Direction.Left, 'flag', 1], [Direction.Down, 'flag', 4]]);
    flags[3] = flag(false, [[Direction.Up, 'flag', 1]]);
    flags[4] = flag(true, [[Direction.Up, 'flag', 2]]);
    (s as unknown as { flags: unknown[] }).flags = flags;
    expect(findNearestInventory(s, 1)).toBe(2);
  });

  it('no inventory reachable -> null', () => {
    expect(findNearestInventory(netState(0), 1)).toBeNull();
  });
});

describe('walkingWaiting — re-orientation when came<0', () => {
  it('below the threshold: a step towards came+6, wait_counter cleared by the move', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(10, 21, geo); // Down == 2
    state.mapTiles[here] = tile({ serfIndex: 7 });
    state.mapTiles[next] = tile({ serfIndex: 0 });
    // came = -4 -> desired direction (came+6)&7 = 2 (Down); wait_counter (F_F) = 0.
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 100, stateData: [0, 0, 0, 0xfc, 0] });
    state.serfs[7] = serf;

    const res = walkingWaiting(state, serf);

    expect(res).toBe('continue');
    expect([serf.col, serf.row]).toEqual([10, 21]); // walked one step Down
    expect(serf.stateData[4]).toBe(0); // wait_counter cleared by directionStep
    expect(serf.stateData[3]).toBe(Direction.Up); // new field_0xe = reverse of Down
  });

  it('blocked (target tile occupied, dir 3..5): no step, wait_counter keeps counting up', () => {
    const state = makeState();
    const here = posOf(10, 20, geo);
    const next = posOf(9, 20, geo); // Left = 3
    state.mapTiles[here] = tile({ serfIndex: 7 });
    state.mapTiles[next] = tile({ serfIndex: 8 }); // occupied
    // came = -3 -> direction (came+6)&7 = 3 (Left); F_F starts at 2.
    const serf = mkSerf({ index: 7, col: 10, row: 20, counter: 100, stateData: [0, 0, 0, 0xfd, 2] });
    state.serfs[7] = serf;

    const res = walkingWaiting(state, serf);

    expect(res).toBe('blocked');
    expect([serf.col, serf.row]).toEqual([10, 20]); // no step
    expect(serf.stateData[4]).toBe(3); // wait_counter incremented (2->3); a block does not clear it
  });
});

describe('arrivalCleanup (arrival_cleanup @0x20cf0) — all branches', () => {
  /** State with flag/building arrays; only the fields the cleanup touches. */
  function cleanupState(): GameState {
    const st = makeState() as unknown as {
      flags: unknown[];
      buildings: unknown[];
    } & GameState;
    st.flags = [null];
    st.buildings = [null];
    return st;
  }
  function mkFlag(index: number): Record<string, unknown> {
    return {
      index,
      length: [0, 0, 0, 0, 0, 0],
      otherEndDir: [0, 0, 0, 0, 0, 0],
      connections: [null, null, null, null, null, null],
    };
  }

  it('dir1 = -2 => Lost (25) with a backwards spiral, without the tail', () => {
    const st = cleanupState();
    const serf = mkSerf({ index: 1, state: 2, counter: 99, stateData: [0xfe, 7, 0, 0, 0] });
    arrivalCleanup(st, serf);
    expect(serf.state).toBe(25);
    expect(serf.stateData[0]).toBe(1); // field_0xb = 1 -> spiral runs backwards (@0x20909)
    expect(serf.counter).toBe(0);
    expect(serf.stateData[1]).toBe(7); // dest survives — the tail did NOT run
  });

  it('dir1 = -1 => the building request is cleared; the bit was set => no decrement', () => {
    const st = cleanupState();
    const bld = { index: 3, type: 11, hasInventory: false, constructing: false,
      serfRequested: true, stock: [{ available: 2, requested: 3 }, { available: 0, requested: 0 }] };
    const flag = mkFlag(5);
    flag.connections = [null, null, null, null, { kind: 'building', index: 3 }, null];
    (st as unknown as { flags: unknown[] }).flags[5] = flag;
    (st as unknown as { buildings: unknown[] }).buildings[3] = bld;
    const serf = mkSerf({ index: 1, state: 2, stateData: [0xff, 5, 0, 0, 0] });

    arrivalCleanup(st, serf);

    expect(bld.serfRequested).toBe(false);
    expect(bld.stock[0]).toEqual({ available: 2, requested: 3 }); // unchanged
    expect(serf.state).toBe(2); // no state change
    expect(serf.stateData.slice(0, 3)).toEqual([0xfe, 0, 0]); // tail @0x2091c
  });

  it('dir1 = -1, the bit was CLEAR => bld[8] decremented as a byte', () => {
    const st = cleanupState();
    const bld = { index: 3, type: 11, hasInventory: false, constructing: false,
      serfRequested: false, stock: [{ available: 2, requested: 3 }, { available: 0, requested: 0 }] };
    const flag = mkFlag(5);
    flag.connections = [null, null, null, null, { kind: 'building', index: 3 }, null];
    (st as unknown as { flags: unknown[] }).flags[5] = flag;
    (st as unknown as { buildings: unknown[] }).buildings[3] = bld;
    arrivalCleanup(st, mkSerf({ index: 1, state: 2, stateData: [0xff, 5, 0, 0, 0] }));
    expect(bld.stock[0]).toEqual({ available: 2, requested: 2 });
  });

  // The guard is the BYTE, not the type: `cmpb $0xff,0x8(%ebx)` @0x20836 — hence the real marker
  // `0xff` on the building rather than a stand-in on `type === 24`.
  it('dir1 = -1 at an inventory building => no decrement (`cmpb $0xff` @0x20836)', () => {
    const st = cleanupState();
    const bld = { index: 3, type: 24, hasInventory: true, constructing: false,
      serfRequested: false, stock: [{ available: 0xf, requested: 0xf }, { available: 0xf, requested: 0xf }] };
    const flag = mkFlag(5);
    flag.connections = [null, null, null, null, { kind: 'building', index: 3 }, null];
    (st as unknown as { flags: unknown[] }).flags[5] = flag;
    (st as unknown as { buildings: unknown[] }).buildings[3] = bld;
    arrivalCleanup(st, mkSerf({ index: 1, state: 2, stateData: [0xff, 5, 0, 0, 0] }));
    expect(bld.stock[0]).toEqual({ available: 0xf, requested: 0xf }); // the marker stays untouched
  });

  // The counter check: the same castle WITHOUT the marker (byte 0xfe, which occurs in real save
  // games) is decremented — the type alone does not protect it.
  it('dir1 = -1 at a castle WITHOUT the marker (byte 0xfe) => decrement', () => {
    const st = cleanupState();
    const bld = { index: 3, type: 24, hasInventory: true, constructing: false,
      serfRequested: false, stock: [{ available: 0xf, requested: 0xe }, { available: 0xf, requested: 0xf }] };
    const flag = mkFlag(5);
    flag.connections = [null, null, null, null, { kind: 'building', index: 3 }, null];
    (st as unknown as { flags: unknown[] }).flags[5] = flag;
    (st as unknown as { buildings: unknown[] }).buildings[3] = bld;
    arrivalCleanup(st, mkSerf({ index: 1, state: 2, stateData: [0xff, 5, 0, 0, 0] }));
    expect(bld.stock[0]).toEqual({ available: 0xf, requested: 0xd }); // 0xfe - 1 == 0xfd
  });

  it('dir1 = 0..5 => serf_requested cleared at BOTH road ends', () => {
    const st = cleanupState();
    const near = mkFlag(5);
    const far = mkFlag(9);
    near.connections = [{ kind: 'flag', index: 9 }, null, null, null, null, null];
    (near.otherEndDir as number[])[Direction.Right] = Direction.Left;
    (near.length as number[])[Direction.Right] = 0x80 | 0x12;
    (far.length as number[])[Direction.Left] = 0x80 | 0x12;
    (st as unknown as { flags: unknown[] }).flags[5] = near;
    (st as unknown as { flags: unknown[] }).flags[9] = far;

    arrivalCleanup(st, mkSerf({ index: 1, state: 2, stateData: [Direction.Right, 5, 0, 0, 0] }));

    expect((near.length as number[])[Direction.Right]).toBe(0x12);
    expect((far.length as number[])[Direction.Left]).toBe(0x12);
  });

  it('dir1 = 6 (geologist) => only the tail, no flag touched', () => {
    const st = cleanupState();
    const flag = mkFlag(5);
    (flag.length as number[])[0] = 0x80;
    (st as unknown as { flags: unknown[] }).flags[5] = flag;
    const serf = mkSerf({ index: 1, state: 2, counter: 42, stateData: [6, 5, 0, 0, 0] });

    arrivalCleanup(st, serf);

    expect((flag.length as number[])[0]).toBe(0x80); // untouched
    expect(serf.stateData.slice(0, 3)).toEqual([0xfe, 0, 0]);
    expect(serf.counter).toBe(0);
  });
});
