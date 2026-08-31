import { describe, it, expect } from 'vitest';
import { splitRoadAtFlag } from './road-split.js';
import { lengthToCategory } from './road-teardown.js';
import { mapGeometry, posOf, Direction } from './position.js';
import type { GameState, Tile, Flag, Serf } from './state.js';

/**
 * Splitting a road — `FUN_0004d9ed` + `FUN_0004de24`. Synthetic base cases; the field order comes
 * from the disassembly, the length category from the already verified {@link lengthToCategory}.
 */
describe('road-split — FUN_0004d9ed', () => {
  const GEO = mapGeometry(3);
  const R = 1 << Direction.Right; // 1
  const L = 1 << Direction.Left; // 8

  function tile(over: Partial<Tile> = {}): Tile {
    return {
      height: 0, terrainUp: 0, terrainDown: 0, object: 0, owner: 0, paths: 0,
      blocked: false, mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0, ...over,
    } as Tile;
  }
  function flag(index: number, over: Partial<Flag> = {}): Flag {
    return {
      index, owner: 0, hasBuilding: false, hasResources: false, acceptsSerfs: false,
      acceptsResources: false, endpointDirs: [false, false, false, false, false, false],
      paths: [false, false, false, false, false, false],
      connections: [null, null, null, null, null, null],
      transporters: [false, false, false, false, false, false], length: [0, 0, 0, 0, 0, 0],
      otherEndDir: [0, 0, 0, 0, 0, 0],
      scheduled: [false, false, false, false, false, false], scheduledSlot: [0, 0, 0, 0, 0, 0],
      resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
      slotDir: [-1, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], ...over,
    } as unknown as Flag;
  }

  /**
   * Straight road A(10,10) ... B(16,10) = 6 edges, with the new flag N in the middle at (13,10) (as
   * after `build_flag`: object + object index set, the tile's road bits unchanged). Both halves are
   * 3 edges long.
   */
  function splitState(over: { lenA?: number; lenB?: number } = {}): {
    st: GameState;
    A: number;
    B: number;
    N: number;
  } {
    const A = 5, B = 9, N = 7;
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    mapTiles[posOf(10, 10, GEO)] = tile({ object: 1, objIndex: A, paths: R });
    for (const c of [11, 12, 14, 15]) mapTiles[posOf(c, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(13, 10, GEO)] = tile({ object: 1, objIndex: N, paths: R | L });
    mapTiles[posOf(16, 10, GEO)] = tile({ object: 1, objIndex: B, paths: L });
    const flags: (Flag | null)[] = new Array(12).fill(null);
    // Before: A and B are directly connected (6 edges => category 0x20), N is unconnected.
    flags[A] = flag(A, {
      paths: [true, false, false, false, false, false],
      endpointDirs: [true, false, false, false, false, false],
      connections: [{ kind: 'flag', index: B }, null, null, null, null, null],
      otherEndDir: [Direction.Left, 0, 0, 0, 0, 0],
      length: [over.lenA ?? lengthToCategory(6), 0, 0, 0, 0, 0],
    });
    flags[B] = flag(B, {
      paths: [false, false, false, true, false, false],
      endpointDirs: [false, false, false, true, false, false],
      connections: [null, null, null, { kind: 'flag', index: A }, null, null],
      otherEndDir: [0, 0, 0, Direction.Right, 0, 0],
      length: [0, 0, 0, over.lenB ?? lengthToCategory(6), 0, 0],
    });
    flags[N] = flag(N);
    const st = {
      geo: GEO, mapTiles, flags, buildings: [], serfs: [],
      blockMeta: { flags: { recordSize: 70, maxIndex: 12 } },
    } as unknown as GameState;
    return { st, A, B, N };
  }

  it('links both halves to the new flag (connection, reverse direction, road bit)', () => {
    const { st, A, B, N } = splitState();
    splitRoadAtFlag(st, 13, 10);
    const n = st.flags[N]!, a = st.flags[A]!, b = st.flags[B]!;

    // New flag: road to the left towards A, to the right towards B.
    expect(n.paths[Direction.Left]).toBe(true);
    expect(n.paths[Direction.Right]).toBe(true);
    expect(n.connections[Direction.Left]).toEqual({ kind: 'flag', index: A });
    expect(n.connections[Direction.Right]).toEqual({ kind: 'flag', index: B });
    expect(n.otherEndDir[Direction.Left]).toBe(Direction.Right); // at A the way back is to the right
    expect(n.otherEndDir[Direction.Right]).toBe(Direction.Left);

    // The old endpoints now point at the new flag instead of at each other.
    expect(a.connections[Direction.Right]).toEqual({ kind: 'flag', index: N });
    expect(b.connections[Direction.Left]).toEqual({ kind: 'flag', index: N });
    expect(a.otherEndDir[Direction.Right]).toBe(Direction.Left);
    expect(b.otherEndDir[Direction.Left]).toBe(Direction.Right);
  });

  it('recomputes the length category of both halves (3 edges => 0x00, before 6 => 0x20)', () => {
    const { st, A, B, N } = splitState();
    expect(lengthToCategory(6)).toBe(0x20);
    expect(lengthToCategory(3)).toBe(0x00);
    splitRoadAtFlag(st, 13, 10);
    const n = st.flags[N]!, a = st.flags[A]!, b = st.flags[B]!;
    // Without transporters the low nibble stays 0; both ends of a half carry the same value.
    expect(a.length[Direction.Right]).toBe(0x00);
    expect(n.length[Direction.Left]).toBe(0x00);
    expect(b.length[Direction.Left]).toBe(0x00);
    expect(n.length[Direction.Right]).toBe(0x00);
    expect(n.transporters[Direction.Left]).toBe(false);
    expect(n.transporters[Direction.Right]).toBe(false);
  });

  it('takes `endpointDirs` from the far end (the flag[4] bit is copied, not set)', () => {
    const { st, A, B, N } = splitState();
    st.flags[B]!.endpointDirs[Direction.Left] = false; // far side without the bit
    splitRoadAtFlag(st, 13, 10);
    const n = st.flags[N]!;
    expect(n.endpointDirs[Direction.Left]).toBe(true); // taken from A
    expect(n.endpointDirs[Direction.Right]).toBe(false); // taken from B
    expect(st.flags[A]!.endpointDirs[Direction.Right]).toBe(true);
  });

  // Which half is which: `dirA` is the FIRST set road bit — for `R|L` that is Right (towards B),
  // `dirB` = Left (towards A). Without a transporter under way the original lets the SECOND half
  // (`field_0x28 = bufB`) lose the request, so here the side towards A.
  it('leaves an open transporter request with only ONE half (without a walking transporter: not the second)', () => {
    const { st, A, B, N } = splitState({
      lenA: lengthToCategory(6) | 0x80,
      lenB: lengthToCategory(6) | 0x80,
    });
    splitRoadAtFlag(st, 13, 10);
    const n = st.flags[N]!, a = st.flags[A]!, b = st.flags[B]!;
    expect(b.length[Direction.Left] & 0x80).toBe(0x80); // the first half (Right, towards B) keeps it
    expect(n.length[Direction.Right] & 0x80).toBe(0x80); // the new flag takes it over
    expect(a.length[Direction.Right] & 0x80).toBe(0); // the second half (Left, towards A) loses it
    expect(n.length[Direction.Left] & 0x80).toBe(0);
  });

  it('reverses that when a transporter is walking to the far end of the SECOND half', () => {
    const { st, A, B, N } = splitState({
      lenA: lengthToCategory(6) | 0x80,
      lenB: lengthToCategory(6) | 0x80,
    });
    // Approach state 1, destination A (`field_0xc`) + destination direction Right (`field_0xb`, the
    // direction at A back to the new flag) => the transporter belongs to the Left half, so THAT one
    // keeps the request.
    const serf = {
      index: 3, type: 0, state: 1, col: 20, row: 20, animation: 0, counter: 0, tick: 0,
      stateData: [Direction.Right, A & 0xff, (A >> 8) & 0xff, 0, 0],
    } as unknown as Serf;
    (st.serfs as unknown as (Serf | null)[]).push(null, null, null, serf);
    splitRoadAtFlag(st, 13, 10);
    expect(st.flags[A]!.length[Direction.Right] & 0x80).toBe(0x80); // the Left half keeps it
    expect(st.flags[N]!.length[Direction.Left] & 0x80).toBe(0x80);
    expect(st.flags[B]!.length[Direction.Left] & 0x80).toBe(0); // the Right half loses it
  });

  it('touches nothing when the tile does not carry two road bits', () => {
    const { st, A, B, N } = splitState();
    st.mapTiles[posOf(13, 10, GEO)].paths = R; // only one bit
    splitRoadAtFlag(st, 13, 10);
    expect(st.flags[N]!.paths.some((p) => p)).toBe(false);
    expect(st.flags[A]!.connections[Direction.Right]).toEqual({ kind: 'flag', index: B });
  });
});
