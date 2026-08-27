import { describe, it, expect } from 'vitest';
import {
  clearRoadPaths,
  clearTileRoadsAndFlag,
  demolishFlag,
  isRoadSegmentClearable,
  lengthToCategory,
} from './road-teardown.js';
import { mapGeometry, posOf, Direction } from './position.js';
import type { GameState, Tile, Flag } from './state.js';

/**
 * Road/flag network teardown (`FUN_0004a528`/`FUN_0004980e`). These tests pin the synthetic base
 * cases: clearing a continuous road, removing a flag.
 */
describe('road-teardown', () => {
  const GEO = mapGeometry(3); // 64×64
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
      index, owner: 0, hasBuilding: false, hasResources: false, acceptsSerfs: false, acceptsResources: false,
      paths: [false, false, false, false, false, false], connections: [null, null, null, null, null, null],
      transporters: [false, false, false, false, false, false], length: [0, 0, 0, 0, 0, 0],
      otherEndDir: [0, 0, 0, 0, 0, 0], endpointDirs: [false, false, false, false, false, false],
      scheduled: [false, false, false, false, false, false], scheduledSlot: [0, 0, 0, 0, 0, 0],
      resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
      slotDir: [-1, -1, -1, -1, -1, -1, -1, -1], slotDest: [0, 0, 0, 0, 0, 0, 0, 0], ...over,
    } as unknown as Flag;
  }

 /** Straight horizontal road: flag A(10,10) —Right— (11,10) — (12,10) —Left— flag B(13,10). */
  function roadState(): { st: GameState; A: number; B: number } {
    const A = 5, B = 9;
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    mapTiles[posOf(10, 10, GEO)] = tile({ object: 1, objIndex: A, paths: R });
    mapTiles[posOf(11, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(12, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(13, 10, GEO)] = tile({ object: 1, objIndex: B, paths: L });
    const flags: (Flag | null)[] = new Array(10).fill(null);
    flags[A] = flag(A, { paths: [true, false, false, false, false, false], connections: [{ kind: 'flag', index: B }, null, null, null, null, null] });
    flags[B] = flag(B, { paths: [false, false, false, true, false, false], connections: [null, null, null, { kind: 'flag', index: A }, null, null] });
    const st = {
      geo: GEO, mapTiles, flags, buildings: [], serfs: [],
 // Player + road-build sessions: in its not-clearable branch `clearRoadPaths` aborts the running
 // road build (@0x4a5f1) and walks the viewports to do so.
      players: [{ slot: 0, active: true, cursorCol: 10, cursorRow: 10 }],
      roadBuild: [{ active: false, segments: 0, allowedMask: 0, markers: [0, 0, 0, 0, 0, 0] }],
      roadBuildAborted: false,
      blockMeta: { flags: { recordSize: 70, maxIndex: 10 } },
    } as unknown as GameState;
    return { st, A, B };
  }

  const pathAt = (st: GameState, c: number, r: number) => st.mapTiles[posOf(c, r, GEO)].paths;

  it('clearRoadPaths clears a continuous road in both directions + both endpoint records', () => {
    const { st, A, B } = roadState();
    clearRoadPaths(st, 11, 10); // start in the middle of the road
    expect(pathAt(st, 10, 10)).toBe(0);
    expect(pathAt(st, 11, 10)).toBe(0);
    expect(pathAt(st, 12, 10)).toBe(0);
    expect(pathAt(st, 13, 10)).toBe(0);
 // The endpoint flags lose their connection to the cleared road.
    expect(st.flags[A]!.paths[Direction.Right]).toBe(false);
    expect(st.flags[A]!.connections[Direction.Right]).toBeNull();
    expect(st.flags[B]!.paths[Direction.Left]).toBe(false);
    expect(st.flags[B]!.connections[Direction.Left]).toBeNull();
  });

  it('gate `FUN_0002b203`: says yes for a road with flags at both ends', () => {
    const { st } = roadState();
    expect(isRoadSegmentClearable(st, 11, 10)).toBe(true);
    expect(isRoadSegmentClearable(st, 12, 10)).toBe(true);
  });

  it('gate: a stub WITHOUT a flag at its end is NOT cleared (the road-build branch)', () => {
    const { st } = roadState();
 // Replace the far flag B with an ordinary tile, so the road ends in nothing.
    st.mapTiles[posOf(13, 10, GEO)] = tile({ paths: L });
    expect(isRoadSegmentClearable(st, 11, 10)).toBe(false);
    clearRoadPaths(st, 11, 10);
 // Nothing cleared — the original aborts the running road build here instead.
    expect(pathAt(st, 11, 10)).toBe(R | L);
    expect(pathAt(st, 12, 10)).toBe(R | L);
    expect(pathAt(st, 10, 10)).toBe(R);
  });

  it('gate: a tile with only ONE road bit is not cleared (`d1 == d2`)', () => {
    const { st } = roadState();
    st.mapTiles[posOf(11, 10, GEO)] = tile({ paths: R }); // only one direction
    expect(isRoadSegmentClearable(st, 11, 10)).toBe(false);
  });

  it('gate: a tile without a road is not cleared', () => {
    const { st } = roadState();
    expect(isRoadSegmentClearable(st, 40, 40)).toBe(false);
  });

  it('demolishFlag removes the flag (slot freed, tile object gone) and clears its road', () => {
    const { st, A, B } = roadState();
    demolishFlag(st, A, 10, 10);
    expect(st.flags[A]).toBeNull(); // slot released
    expect(st.mapTiles[posOf(10, 10, GEO)].object).toBe(0); // tile object cleared
    expect(st.mapTiles[posOf(10, 10, GEO)].objIndex).toBe(0);
 // The road is cleared up to the far flag B; B loses the connection but survives.
    expect(pathAt(st, 11, 10)).toBe(0);
    expect(pathAt(st, 12, 10)).toBe(0);
    expect(st.flags[B]).not.toBeNull();
    expect(st.flags[B]!.connections[Direction.Left]).toBeNull();
  });

  it('maxFlagIndex follows when the highest slot is released', () => {
    const { st, B } = roadState(); // B=9 is the highest occupied one (maxIndex 10)
    demolishFlag(st, B, 13, 10);
    expect(st.flags[B]).toBeNull();
    expect(st.blockMeta.flags.maxIndex).toBe(6); // highest remaining = A(5) -> +1
  });

 /**
  * Through flag M(12,10) links A(10,10) —Right— M —Right— B(14,10). demolishFlag(M) merges: A and B
  * connected directly, lengths summed, M gone, the road tiles kept (no paths cleared).
  */
  it('demolishFlag of a through flag merges the two roads (road kept)', () => {
    const A = 5, M = 7, Bi = 9;
    const R = 1 << Direction.Right, L = 1 << Direction.Left;
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    mapTiles[posOf(10, 10, GEO)] = tile({ object: 1, objIndex: A, paths: R });
    mapTiles[posOf(11, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(12, 10, GEO)] = tile({ object: 1, objIndex: M, paths: R | L });
    mapTiles[posOf(13, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(14, 10, GEO)] = tile({ object: 1, objIndex: Bi, paths: L });
    const flags: (Flag | null)[] = new Array(10).fill(null);
    flags[A] = flag(A, { paths: [true, false, false, false, false, false], connections: [{ kind: 'flag', index: M }, null, null, null, null, null], otherEndDir: [Direction.Left, 0, 0, 0, 0, 0], length: [1, 0, 0, 0, 0, 0] });
    flags[M] = flag(M, {
      paths: [true, false, false, true, false, false],
      connections: [{ kind: 'flag', index: Bi }, null, null, { kind: 'flag', index: A }, null, null],
      otherEndDir: [Direction.Left, 0, 0, Direction.Right, 0, 0], length: [1, 0, 0, 1, 0, 0],
    });
    flags[Bi] = flag(Bi, { paths: [false, false, false, true, false, false], connections: [null, null, null, { kind: 'flag', index: M }, null, null], otherEndDir: [0, 0, 0, Direction.Left, 0, 0], length: [0, 0, 0, 1, 0, 0] });
 // One idle transporter (state 66) each on the intermediate tiles (11,10) and (13,10). The tracer
 // wakes them (-> 69) and COUNTS them: `existing` = 2 comes from the trace, not from the nibbles.
    const mk = (index: number, col: number) => ({ index, state: 66, col, row: 10, type: 0, stateData: [0, 0, 0, 0, 0] }) as unknown as import('./state.js').Serf;
    const serfs: (import('./state.js').Serf | null)[] = [null, null, null, mk(3, 11), mk(4, 13)];
    const st = { geo: GEO, mapTiles, flags, buildings: [], serfs, blockMeta: { flags: { recordSize: 70, maxIndex: 10 } } } as unknown as GameState;

    demolishFlag(st, M, 12, 10);

    expect(st.flags[M]).toBeNull(); // through flag gone
    expect(st.mapTiles[posOf(12, 10, GEO)].object).toBe(0); // flag object gone
    expect(st.mapTiles[posOf(12, 10, GEO)].paths).toBe(R | L); // but the paths are KEPT (through road)
 // A and B now point at each other directly; combined length = lengthToCategory(2+2 steps = 4) =
 // 0x10 (category) | kept transporters. The trace found 2 (the two idle ones, woken -> 69), target
 // for 0x10 is 2, so kept = 2 and length == 0x12. `existing` comes from the real trace (woken +
 // active) and NOT from the stored nibbles — otherwise the merged road would look transporter-less.
    expect(st.flags[A]!.connections[Direction.Right]).toEqual({ kind: 'flag', index: Bi });
    expect(st.flags[A]!.otherEndDir[Direction.Right]).toBe(Direction.Left);
    expect(st.flags[A]!.length[Direction.Right]).toBe(0x12);
    expect(st.flags[Bi]!.connections[Direction.Left]).toEqual({ kind: 'flag', index: A });
    expect(st.flags[Bi]!.otherEndDir[Direction.Left]).toBe(Direction.Right);
    expect(st.flags[Bi]!.length[Direction.Left]).toBe(0x12);
  });

  it('demolishFlag WAKES idle transporters (state 66) on the merged segments (-> 69 WakeOnPath)', () => {
 // Through flag M(12,10): Left to A(10,10) via (11,10), Right to Bi(14,10) via (13,10). The merge has
 // to wake both idle transporters (-> 69) so they run again — including the one whose home was the
 // demolished flag (found by position, not by the home pointer). `FUN_0004b604`/`FUN_0004b713`.
    const A = 5, M = 7, Bi = 9;
    const R = 1 << Direction.Right, L = 1 << Direction.Left;
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    mapTiles[posOf(10, 10, GEO)] = tile({ object: 1, objIndex: A, paths: R });
    mapTiles[posOf(11, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(12, 10, GEO)] = tile({ object: 1, objIndex: M, paths: R | L });
    mapTiles[posOf(13, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(14, 10, GEO)] = tile({ object: 1, objIndex: Bi, paths: L });
    const flags: (Flag | null)[] = new Array(10).fill(null);
    flags[A] = flag(A, { paths: [true, false, false, false, false, false], connections: [{ kind: 'flag', index: M }, null, null, null, null, null], otherEndDir: [Direction.Left, 0, 0, 0, 0, 0], length: [1, 0, 0, 0, 0, 0] });
    flags[M] = flag(M, { paths: [true, false, false, true, false, false], connections: [{ kind: 'flag', index: Bi }, null, null, { kind: 'flag', index: A }, null, null], otherEndDir: [Direction.Left, 0, 0, Direction.Right, 0, 0], length: [1, 0, 0, 1, 0, 0] });
    flags[Bi] = flag(Bi, { paths: [false, false, false, true, false, false], connections: [null, null, null, { kind: 'flag', index: M }, null, null], otherEndDir: [0, 0, 0, Direction.Left, 0, 0], length: [0, 0, 0, 1, 0, 0] });
 // Idle transporter #3 on (13,10) with home A (survives), #4 on (11,10) with home M (demolished).
    const mk = (index: number, homeFlag: number) => {
      const off = homeFlag * 70;
      return { index, state: 66, col: index === 3 ? 13 : 11, row: 10, type: 0,
        stateData: [Direction.Right, off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, (off >> 24) & 0xff] } as unknown as import('./state.js').Serf;
    };
    const serfs: (import('./state.js').Serf | null)[] = [null, null, null, mk(3, A), mk(4, M)];
    const st = { geo: GEO, mapTiles, flags, buildings: [], serfs, blockMeta: { flags: { recordSize: 70, maxIndex: 10 } } } as unknown as GameState;

    demolishFlag(st, M, 12, 10);

 // Both idle transporters are woken (state 69) — the orphan #4 too (found by position).
    expect(st.serfs[3]!.state).toBe(69);
    expect(st.serfs[4]!.state).toBe(69);
  });

  it('demolishFlag ejects surplus transporters from the merged road (FUN_0004980e)', () => {
 // Longer road A(7,10) … M(10,10) … Bi(12,10): left segment 3 steps (i0@8, i1@9), right segment 2
 // steps (i2@11). Sum 5 steps -> category 0x10 -> target = CARRIERS_PER_CATEGORY[1] = 2. The segments
 // had 3 transporters assigned (length low nibbles 2+1) and 3 active ones (state 3) sit on i0/i1/i2,
 // so assigned 3 > target 2 and exactly ONE is surplus and gets ejected (field_0xf = 0xff).
    const A = 5, M = 7, Bi = 9;
    const R = 1 << Direction.Right, L = 1 << Direction.Left;
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    mapTiles[posOf(7, 10, GEO)] = tile({ object: 1, objIndex: A, paths: R });
    mapTiles[posOf(8, 10, GEO)] = tile({ paths: R | L, serfIndex: 30 }); // i0
    mapTiles[posOf(9, 10, GEO)] = tile({ paths: R | L, serfIndex: 31 }); // i1
    mapTiles[posOf(10, 10, GEO)] = tile({ object: 1, objIndex: M, paths: R | L });
    mapTiles[posOf(11, 10, GEO)] = tile({ paths: R | L, serfIndex: 32 }); // i2
    mapTiles[posOf(12, 10, GEO)] = tile({ object: 1, objIndex: Bi, paths: L });
    const flags: (Flag | null)[] = new Array(10).fill(null);
    flags[A] = flag(A, { paths: [true, false, false, false, false, false], connections: [{ kind: 'flag', index: M }, null, null, null, null, null], otherEndDir: [Direction.Left, 0, 0, 0, 0, 0], length: [1, 0, 0, 0, 0, 0] });
    flags[M] = flag(M, { paths: [true, false, false, true, false, false], connections: [{ kind: 'flag', index: Bi }, null, null, { kind: 'flag', index: A }, null, null], otherEndDir: [Direction.Left, 0, 0, Direction.Right, 0, 0], length: [2, 0, 0, 1, 0, 0] });
    flags[Bi] = flag(Bi, { paths: [false, false, false, true, false, false], connections: [null, null, null, { kind: 'flag', index: M }, null, null], otherEndDir: [0, 0, 0, Direction.Left, 0, 0], length: [0, 0, 0, 1, 0, 0] });
 // Three transporters (state 3); the walking direction field_0xe is uncritical on intermediate tiles.
    const mkCarrier = (index: number) => ({ index, state: 3, col: 0, row: 0, stateData: [0, 0, 0, 0, 0] }) as unknown as import('./state.js').Serf;
    const serfs: (import('./state.js').Serf | null)[] = new Array(33).fill(null);
    serfs[30] = mkCarrier(30); serfs[31] = mkCarrier(31); serfs[32] = mkCarrier(32);
    const st = { geo: GEO, mapTiles, flags, buildings: [], serfs, blockMeta: { flags: { recordSize: 70, maxIndex: 10 } } } as unknown as GameState;

    demolishFlag(st, M, 10, 10);

 // Exactly ONE of the three is ejected (field_0xf == 0xff), two stay (field_0xf == 0).
    const ejected = [30, 31, 32].filter((i) => st.serfs[i]!.stateData[4] === 0xff);
    const kept = [30, 31, 32].filter((i) => st.serfs[i]!.stateData[4] === 0);
    expect(ejected.length).toBe(1);
    expect(kept.length).toBe(2);
 // Length byte: category 0x10 | kept transporters (2) = 0x12.
    expect(st.flags[A]!.length[Direction.Right]).toBe(0x12);
    expect(st.flags[Bi]!.length[Direction.Left]).toBe(0x12);
  });

 // --- Transporters on the demolished road (`walk_road_clear` @0x4a90f, `set_lost_state` @0x4af66) --

 /** Serf stub with the five union bytes (0xb..0xf). */
  function serf(index: number, over: Record<string, unknown> = {}) {
    return {
      index, owner: 0, type: 0, state: 3, animation: 0, counter: 0, tick: 0,
      col: null, row: null, stateData: [0, 0, 0, 0, 0], ...over,
    } as unknown as NonNullable<GameState['serfs'][number]>;
  }

  it('a transporter ON the road loses his job (Lost 25) instead of staying put', () => {
    const { st } = roadState();
 // Transporting carrier on the intermediate tile (12,10) — the original checks no direction there.
    const s = serf(1, { state: 3, col: 12, row: 10, stateData: [0, 0, 0, Direction.Right, 0] });
    st.serfs[1] = s;
    st.mapTiles[posOf(12, 10, GEO)].serfIndex = 1;
    clearRoadPaths(st, 11, 10);
    expect(s.state).toBe(25); // Lost
    expect(s.stateData[0]).toBe(0);
  });

  it('a sailor becomes LostSailor (26) and keeps field_0xb', () => {
    const { st } = roadState();
    const s = serf(1, { state: 3, type: 1, col: 12, row: 10, stateData: [7, 0, 0, Direction.Right, 0] });
    st.serfs[1] = s;
    st.mapTiles[posOf(12, 10, GEO)].serfIndex = 1;
    clearRoadPaths(st, 11, 10);
    expect(s.state).toBe(26);
    expect(s.stateData[0]).toBe(7); // `field_0xb` stays (@0x4b10f jumps past the clearing)
  });

 // At the far flag the original checks the walking direction (`field_0xe` against the reverse of the
 // last step) — other roads cross there and may keep their transporters. The pair below discriminates:
 // same setup, only the walking direction differs.
  const carrierOnFarFlag = (dir: Direction) => {
    const { st } = roadState();
    const s = serf(1, { state: 3, col: 13, row: 10, stateData: [0, 0, 0, dir, 0] });
    st.serfs[1] = s;
    st.mapTiles[posOf(13, 10, GEO)].serfIndex = 1;
    clearRoadPaths(st, 11, 10);
    return s;
  };

  it('at the far flag: whoever walks INTO the demolished road loses his job', () => {
 // The walk reaches the flag with a step to the Right, so the reverse direction is Left.
    expect(carrierOnFarFlag(Direction.Left).state).toBe(25);
  });

  it('at the far flag: the transporter of a FOREIGN road is untouched', () => {
    expect(carrierOnFarFlag(Direction.Right).state).toBe(3);
  });

  it('an idle transporter on the road is woken (68 WakeAtFlag)', () => {
    const { st } = roadState();
    const s = serf(1, { state: 66, col: 12, row: 10 });
    st.serfs[1] = s;
    clearRoadPaths(st, 11, 10);
    expect(s.state).toBe(68);
  });

  it('the REQUESTED transporter loses his destination and turns around at the next flag', () => {
    const { st, A } = roadState();
 // Flag A has requested a transporter for its road to the Right (length byte bit 7).
    st.flags[A]!.length[Direction.Right] = 0x80 | 0x10;
    const s = serf(1, {
      state: 2, // Walking
      col: 20, row: 20, // still far away
      stateData: [Direction.Right, A, 0, 0, 0], // field_0xb = direction, field_0xc = destination flag
    });
    st.serfs[1] = s;
    clearRoadPaths(st, 11, 10);
    expect(s.stateData[0]).toBe(0xfe); // destination-gone marker
    expect(s.stateData[1]).toBe(0); // field_0xc cleared
    expect(st.flags[A]!.length[Direction.Right] & 0x80).toBe(0);
  });

  // --- clearTileRoadsAndFlag (@0x1725e) -------------------------------------------------------

  it('clearTileRoadsAndFlag on a ROAD tile takes the road (the no-flag branch @0x172e3)', () => {
    const { st, A, B } = roadState();
    clearTileRoadsAndFlag(st, 11, 10);
    expect(pathAt(st, 11, 10)).toBe(0);
    expect(pathAt(st, 12, 10)).toBe(0);
    expect(pathAt(st, 10, 10)).toBe(0);
    expect(pathAt(st, 13, 10)).toBe(0);
    // The flags themselves stay — only their roads are gone.
    expect(st.flags[A]).not.toBeNull();
    expect(st.flags[B]).not.toBeNull();
  });

  it('clearTileRoadsAndFlag on a FLAG takes the roads pointing at it AND the flag', () => {
    const { st, A, B } = roadState();
    clearTileRoadsAndFlag(st, 10, 10);
    expect(st.flags[A]).toBeNull();
    expect(st.mapTiles[posOf(10, 10, GEO)].object).toBe(0);
    expect(pathAt(st, 11, 10)).toBe(0);
    expect(st.flags[B]!.paths[Direction.Left]).toBe(false); // the far flag was tidied up too
  });

  it('clearTileRoadsAndFlag on a bare tile does nothing', () => {
    const { st, A, B } = roadState();
    clearTileRoadsAndFlag(st, 30, 30);
    expect(st.flags[A]).not.toBeNull();
    expect(st.flags[B]).not.toBeNull();
    expect(pathAt(st, 11, 10)).toBe(R | L); // road untouched
  });

  it('clearTileRoadsAndFlag is idempotent — the recolour may hit the same tile many times', () => {
    const { st, A } = roadState();
    clearTileRoadsAndFlag(st, 10, 10);
    expect(() => clearTileRoadsAndFlag(st, 10, 10)).not.toThrow();
    expect(st.flags[A]).toBeNull();
  });

  it('lengthToCategory maps the step count onto the original categories (FUN_0002bbc1)', () => {
 // Verified against real save games: 4 steps -> 0x10, 12 steps -> 0x40.
    expect(lengthToCategory(2)).toBe(0x00); // <4
    expect(lengthToCategory(3)).toBe(0x00);
    expect(lengthToCategory(4)).toBe(0x10); // 4..5
    expect(lengthToCategory(6)).toBe(0x20);
    expect(lengthToCategory(9)).toBe(0x30); // 7..9
    expect(lengthToCategory(12)).toBe(0x40); // 10..12
    expect(lengthToCategory(17)).toBe(0x50); // 13..17
    expect(lengthToCategory(23)).toBe(0x60); // 18..23
    expect(lengthToCategory(24)).toBe(0x70); // >= 24
  });
});
