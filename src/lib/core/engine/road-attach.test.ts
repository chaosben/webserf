import { describe, it, expect } from 'vitest';
import { attachFlagToRoad, canAttachFlagToRoad } from './road-attach.js';
import { mapGeometry, posOf, Direction } from './position.js';
import type { GameState, Tile, Flag, Serf } from './state.js';

/**
 * Attaching a flag to a passing road — `can_attach_flag_to_road` (@0x4c9b3), `FUN_0004ccdf` and
 * `FUN_0004d460`. Synthetic base cases.
 *
 * Layout of all cases: a road running PAST the flag.
 * ```
 * row  9: A(11,9) -- (12,9) -- (13,9) -- (14,9) -- B(15,9)
 * row 10:              C(13,10)   (the flag, without any road)
 * ```
 * `C + UpLeft` is (12,9), `C + Up` is (13,9); the edge between them is the one the attachment splits,
 * so the hit direction is `d = 4 (UpLeft)`.
 */
describe('road-attach — FUN_0004ccdf / FUN_0004d460', () => {
  const GEO = mapGeometry(3); // 64x64
  const R = 1 << Direction.Right;
  const L = 1 << Direction.Left;
  const A = 5;
  const B = 9;
  const N = 7;

  function tile(over: Partial<Tile> = {}): Tile {
    return {
      height: 0, terrainUp: 0, terrainDown: 0, object: 0, owner: 1, paths: 0,
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

  function scene(): GameState {
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    mapTiles[posOf(11, 9, GEO)] = tile({ object: 1, objIndex: A, paths: R });
    for (const c of [12, 13, 14]) mapTiles[posOf(c, 9, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(15, 9, GEO)] = tile({ object: 1, objIndex: B, paths: L });
    mapTiles[posOf(13, 10, GEO)] = tile({ object: 1, objIndex: N, paths: 0 });

    const flags: (Flag | null)[] = new Array(12).fill(null);
    flags[A] = flag(A, {
      paths: [true, false, false, false, false, false],
      endpointDirs: [true, false, false, false, false, false],
      connections: [{ kind: 'flag', index: B }, null, null, null, null, null],
      otherEndDir: [Direction.Left, 0, 0, 0, 0, 0],
      length: [0x10, 0, 0, 0, 0, 0],
    });
    flags[B] = flag(B, {
      paths: [false, false, false, true, false, false],
      endpointDirs: [false, false, false, true, false, false],
      connections: [null, null, null, { kind: 'flag', index: A }, null, null],
      otherEndDir: [0, 0, 0, Direction.Right, 0, 0],
      length: [0, 0, 0, 0x10, 0, 0],
    });
    flags[N] = flag(N);
    return {
      geo: GEO, mapTiles, flags, buildings: [], serfs: [null],
      blockMeta: { flags: { recordSize: 70, maxIndex: 12 } },
    } as unknown as GameState;
  }

  it('reports the passing road, and nothing once it is attached', () => {
    const st = scene();
    expect(canAttachFlagToRoad(st, 13, 10)).toBe(true);
    expect(attachFlagToRoad(st, 13, 10)).toBe(true);
    expect(canAttachFlagToRoad(st, 13, 10)).toBe(false);
  });

  it('rewrites exactly three tiles (the flag gets both ends, the edge is split)', () => {
    const st = scene();
    attachFlagToRoad(st, 13, 10);
    const DR = 1 << Direction.DownRight;
    const D = 1 << Direction.Down;
    const UL = 1 << Direction.UpLeft;
    const U = 1 << Direction.Up;
    expect(st.mapTiles[posOf(13, 10, GEO)].paths).toBe(UL | U);
    expect(st.mapTiles[posOf(12, 9, GEO)].paths).toBe(L | DR); // -Right, +DownRight
    expect(st.mapTiles[posOf(13, 9, GEO)].paths).toBe(R | D); // -Left, +Down
    // No other tile moves.
    const ref = scene();
    for (let i = 0; i < st.mapTiles.length; i++) {
      if (i === posOf(13, 10, GEO) || i === posOf(12, 9, GEO) || i === posOf(13, 9, GEO)) continue;
      expect(st.mapTiles[i].paths).toBe(ref.mapTiles[i].paths);
    }
  });

  it('hooks both road halves onto the flag (connection plus opposite direction)', () => {
    const st = scene();
    attachFlagToRoad(st, 13, 10);
    const n = st.flags[N]!;
    const a = st.flags[A]!;
    const b = st.flags[B]!;
    expect(n.paths[Direction.UpLeft]).toBe(true);
    expect(n.paths[Direction.Up]).toBe(true);
    expect(n.connections[Direction.UpLeft]).toEqual({ kind: 'flag', index: A });
    expect(n.connections[Direction.Up]).toEqual({ kind: 'flag', index: B });
    expect(n.otherEndDir[Direction.UpLeft]).toBe(Direction.Right); // at A it goes back to the right
    expect(n.otherEndDir[Direction.Up]).toBe(Direction.Left);
    expect(a.connections[Direction.Right]).toEqual({ kind: 'flag', index: N });
    expect(b.connections[Direction.Left]).toEqual({ kind: 'flag', index: N });
    expect(a.otherEndDir[Direction.Right]).toBe(Direction.UpLeft);
    expect(b.otherEndDir[Direction.Left]).toBe(Direction.Up);
  });

  /**
   * `FUN_0004ccdf` does NOT stop after the first hit: it re-reads the flag's path bits and keeps
   * checking the remaining pairs. An attachment in direction `d` sets bits `d` and `d+1` and thereby
   * kills every overlapping pair, so two DISJOINT ones remain possible. Here `(4,5)` and `(1,2)`: a
   * second road runs below the flag, over the edge `(13,11) - (14,11)`.
   */
  function twoRoadScene(): GameState {
    const st = scene();
    const A2 = 3;
    const B2 = 11;
    st.mapTiles[posOf(12, 11, GEO)] = tile({ object: 1, objIndex: A2, paths: R });
    st.mapTiles[posOf(13, 11, GEO)] = tile({ paths: R | L });
    st.mapTiles[posOf(14, 11, GEO)] = tile({ paths: R | L });
    st.mapTiles[posOf(15, 11, GEO)] = tile({ object: 1, objIndex: B2, paths: L });
    st.flags[A2] = flag(A2, {
      paths: [true, false, false, false, false, false],
      endpointDirs: [true, false, false, false, false, false],
      connections: [{ kind: 'flag', index: B2 }, null, null, null, null, null],
      otherEndDir: [Direction.Left, 0, 0, 0, 0, 0],
      length: [0x10, 0, 0, 0, 0, 0],
    });
    st.flags[B2] = flag(B2, {
      paths: [false, false, false, true, false, false],
      endpointDirs: [false, false, false, true, false, false],
      connections: [null, null, null, { kind: 'flag', index: A2 }, null, null],
      otherEndDir: [0, 0, 0, Direction.Right, 0, 0],
      length: [0, 0, 0, 0x10, 0, 0],
    });
    return st;
  }

  it('attaches two disjoint roads in ONE call (the loop does not stop)', () => {
    const st = twoRoadScene();
    expect(attachFlagToRoad(st, 13, 10)).toBe(true);
    const n = st.flags[N]!;
    // Four attachments: (4,5) from the upper road, (1,2) from the lower one.
    expect(n.paths.map((p) => (p ? 1 : 0))).toEqual([0, 1, 1, 0, 1, 1]);
    expect(st.mapTiles[posOf(13, 10, GEO)].paths).toBe(0x36);
    expect(n.connections[Direction.UpLeft]).toEqual({ kind: 'flag', index: A }); // upper road
    expect(n.connections[Direction.Up]).toEqual({ kind: 'flag', index: B });
    expect(n.connections[Direction.DownRight]).toEqual({ kind: 'flag', index: 11 }); // lower road
    expect(n.connections[Direction.Down]).toEqual({ kind: 'flag', index: 3 });
    // Both old edges are split.
    expect(st.mapTiles[posOf(13, 11, GEO)].paths).toBe(L | (1 << Direction.Up));
    expect(st.mapTiles[posOf(14, 11, GEO)].paths).toBe(R | (1 << Direction.UpLeft));
  });

  it('refuses when the neighbour tile belongs to another player', () => {
    const st = scene();
    st.mapTiles[posOf(13, 9, GEO)].owner = 2;
    expect(canAttachFlagToRoad(st, 13, 10)).toBe(false);
    expect(attachFlagToRoad(st, 13, 10)).toBe(false);
  });

  it('refuses when the flag already has a road in one of the two directions', () => {
    const st = scene();
    st.mapTiles[posOf(13, 10, GEO)].paths = 1 << Direction.Up;
    expect(canAttachFlagToRoad(st, 13, 10)).toBe(false);
  });

  it('refuses when there is no flag on the tile at all', () => {
    const st = scene();
    st.mapTiles[posOf(13, 10, GEO)].object = 0;
    expect(canAttachFlagToRoad(st, 13, 10)).toBe(false);
    expect(attachFlagToRoad(st, 13, 10)).toBe(false);
  });

  it('wakes an idle transporter on the split edge (66 -> 69)', () => {
    const st = scene();
    const serf = {
      index: 1, type: 0, state: 66, col: 13, row: 9, animation: 0, counter: 0, tick: 0,
      stateData: [0, 0, 0, 0, 0],
    } as unknown as Serf;
    (st.serfs as unknown as (Serf | null)[]).push(serf);
    attachFlagToRoad(st, 13, 10);
    expect(serf.state).toBe(69);
  });

  it('redirects a walking transporter on the edge from the old to the new direction', () => {
    const st = scene();
    const serf = {
      index: 1, type: 0, state: 2, col: 12, row: 9, animation: 0, counter: 0, tick: 0,
      stateData: [0, 0, 0, Direction.Right, 0], // field_0xe = old direction Right
    } as unknown as Serf;
    (st.serfs as unknown as (Serf | null)[]).push(serf);
    st.mapTiles[posOf(12, 9, GEO)].serfIndex = 1;
    attachFlagToRoad(st, 13, 10);
    expect(serf.stateData[3]).toBe(Direction.DownRight); // new direction = towards the flag
  });

  /**
   * The cleanup pass at the end of `FUN_0004ccdf`: if an endpoint pointer of the flag points at the
   * flag ITSELF after the attachment, that road is razed. This happens when the road taken in is a
   * LOOP passing the flag twice; here a ring without any flag:
   * ```
   * (11,9) -- (12,9) -- (13,9) -- (14,9)      C = (13,10) sits below the upper edge
   *   |                            |
   * (11,10)                      (14,10)
   *   |                            |
   * (11,11) - (12,11) - (13,11) - (14,11)
   * ```
   * After attaching, BOTH halves lead around the ring back to the flag.
   */
  function ringScene(): GameState {
    const D = 1 << Direction.Down;
    const U = 1 << Direction.Up;
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    const set = (c: number, r: number, paths: number): void => {
      mapTiles[posOf(c, r, GEO)] = tile({ paths });
    };
    set(11, 9, R | D);
    set(12, 9, R | L);
    set(13, 9, R | L);
    set(14, 9, D | L);
    set(11, 10, U | D);
    set(14, 10, U | D);
    set(11, 11, U | R);
    set(12, 11, R | L);
    set(13, 11, R | L);
    set(14, 11, U | L);
    mapTiles[posOf(13, 10, GEO)] = tile({ object: 1, objIndex: N, paths: 0 });

    const flags: (Flag | null)[] = new Array(12).fill(null);
    flags[N] = flag(N);
    return {
      geo: GEO, mapTiles, flags, buildings: [], serfs: [null],
      blockMeta: { flags: { recordSize: 70, maxIndex: 12 } },
    } as unknown as GameState;
  }

  it('razes a road that leads back to the flag itself after the attachment', () => {
    const st = ringScene();
    expect(canAttachFlagToRoad(st, 13, 10)).toBe(true);
    attachFlagToRoad(st, 13, 10);

    // The whole ring is gone, including the two freshly set attachments of the flag.
    const ring: [number, number][] = [
      [11, 9], [12, 9], [13, 9], [14, 9], [11, 10], [14, 10], [11, 11], [12, 11], [13, 11], [14, 11],
      [13, 10],
    ];
    for (const [c, r] of ring) {
      expect(`(${c},${r}) paths=${st.mapTiles[posOf(c, r, GEO)].paths}`).toBe(`(${c},${r}) paths=0`);
    }
    expect(st.flags[N]!.paths.some((p) => p)).toBe(false);
  });

  it('knows the second encoding of the direction field (direction - 6)', () => {
    const st = scene();
    const serf = {
      index: 1, type: 0, state: 7, col: 12, row: 9, animation: 0, counter: 0, tick: 0,
      stateData: [0, 0, 0, (Direction.Right - 6) & 0xff, 0],
    } as unknown as Serf;
    (st.serfs as unknown as (Serf | null)[]).push(serf);
    st.mapTiles[posOf(12, 9, GEO)].serfIndex = 1;
    attachFlagToRoad(st, 13, 10);
    expect(serf.stateData[3]).toBe((Direction.DownRight - 6) & 0xff);
  });
});
