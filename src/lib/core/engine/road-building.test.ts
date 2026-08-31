import { describe, it, expect } from 'vitest';
import {
  roadSession,
  createRoadBuildingState,
  beginRoadBuilding,
  updateRoadMarkers,
  roadBuildingClick,
  cancelRoadBuilding,
  roadEdgeScroll,
  MARKER_NONE,
  MARKER_BLOCKED,
  MARKER_BACKSTEP,
  MARKER_SLOPE_BASE,
  SOUND_ROAD_DONE,
  SOUND_REJECT,
  SOUND_SEGMENT,
  segmentTerrainBit,
} from './road-building.js';
import { mapGeometry, posOf, neighbor, oppositeDir, Direction } from './position.js';
import type { GameState, Player, Flag, Tile } from './state.js';

/** Synthetic 64x64 map: all grass-5, height 10, owned by player 0 (tile owner 1). */
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
    flags: 1,
    build: 0,
    cursorCol: 10,
    cursorRow: 10,
    completedBuildingCount: new Array(23).fill(0),
    incompleteBuildingCount: new Array(23).fill(0),
    messageFlags: 0,
    messageBuildingSlots: [0, 0, 0],
    ...over,
  } as unknown as Player;
}

function flag(index: number): Flag {
  return {
    index,
    owner: 0,
    hasBuilding: false,
    hasResources: false,
    endpointDirs: [false, false, false, false, false, false],
    paths: [false, false, false, false, false, false],
    connections: [null, null, null, null, null, null],
    resourceSlots: [-1, -1, -1, -1, -1, -1, -1, -1],
    searchNum: 0,
    searchDir: 0,
    transporters: [false, false, false, false, false, false],
    serfRequestFail: false,
    length: [0, 0, 0, 0, 0, 0],
    slotDir: [-1, -1, -1, -1, -1, -1, -1, -1],
    slotDest: [0, 0, 0, 0, 0, 0, 0, 0],
    otherEndDir: [0, 0, 0, 0, 0, 0],
    scheduled: [false, false, false, false, false, false],
    scheduledSlot: [0, 0, 0, 0, 0, 0],
    acceptsSerfs: false,
    acceptsResources: false,
    bldFlags: 0,
    bld2Flags: 0,
    stockPriority: [0, 0],
  } as unknown as Flag;
}

function state(): GameState {
  const mapTiles: Tile[] = [];
  for (let i = 0; i < geo.cols * geo.rows; i++) mapTiles.push(tile());
  return {
    geo,
    mapTiles,
    buildings: [null],
    flags: [null],
    players: [player()],
    roadBuild: [createRoadBuildingState()],
    header: { maxBuildingIndex: 1, maxFlagIndex: 1, warehouseLimit: 361, mapGoldTotal: 1000 },
    blockMeta: { buildings: { maxIndex: 1 }, flags: { maxIndex: 1 } },
  } as unknown as GameState;
}

function at(st: GameState, col: number, row: number): Tile {
  return st.mapTiles[posOf(col, row, geo)];
}

/** Place a flag with index `idx` on (col,row). */
function putFlag(st: GameState, col: number, row: number, idx: number): Flag {
  const f = flag(idx);
  while (st.flags.length <= idx) st.flags.push(null);
  st.flags[idx] = f;
  const t = at(st, col, row);
  t.object = 1;
  t.objIndex = idx;
  return f;
}

/** Column/row of the neighbour in `dir`, in the form the click handler uses. */
function stepTo(col: number, row: number, dir: Direction): [number, number] {
  const np = neighbor(posOf(col, row, geo), dir, geo);
  return [np & (geo.cols - 1), (np >> geo.rowShift) & (geo.rows - 1)];
}

describe('road building — entering the mode (@0x2860d)', () => {
  it('starts only on a flag (cursorType 1 or 2)', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    expect(beginRoadBuilding(st, p)).toBe(false); // free tile
    expect(rb.active).toBe(false);

    putFlag(st, 10, 10, 1);
    expect(beginRoadBuilding(st, p)).toBe(true);
    expect(rb.active).toBe(true);
    expect(rb.segments).toBe(0);
  });
});

describe('road-building — markers + allowed directions (@0x32d49)', () => {
  it('free own surroundings: all six directions allowed, marker = slope 0', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    expect(rb.allowedMask).toBe(0x3f);
    expect(rb.markers).toEqual(new Array(6).fill(MARKER_SLOPE_BASE));
  });

  it('the slope enters the marker: 0x27 + (neighbour height - cursor height)', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    const [c, r] = stepTo(10, 10, Direction.Right);
    at(st, c, r).height = 13;
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    expect(rb.markers[Direction.Right]).toBe(MARKER_SLOPE_BASE + 3);
  });

  it('foreign land and large obstacles block the direction', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    const [fc, fr] = stepTo(10, 10, Direction.Right);
    at(st, fc, fr).owner = 2; // player 1
    const [sc, sr] = stepTo(10, 10, Direction.Down);
    at(st, sc, sr).object = 72; // stone pile → OBJECT_CLASS 2
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    expect(rb.markers[Direction.Right]).toBe(MARKER_BLOCKED);
    expect(rb.markers[Direction.Down]).toBe(MARKER_BLOCKED);
    expect(rb.allowedMask & (1 << Direction.Right)).toBe(0);
    expect(rb.allowedMask & (1 << Direction.Down)).toBe(0);
  });

  it('the cursor path bits only count from the first segment on (vp[0xce] != 0)', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    at(st, 10, 10).paths = 1 << Direction.Right; // real road of the starting flag
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    expect(rb.markers[Direction.Right]).not.toBe(MARKER_BACKSTEP);
    rb.segments = 1;
    updateRoadMarkers(st, p);
    expect(rb.markers[Direction.Right]).toBe(MARKER_BACKSTEP);
    expect(rb.allowedMask & (1 << Direction.Right)).not.toBe(0);
  });
});

describe('road-building — click (@0x2a63c)', () => {
  it('a segment sets both path bits, counts up and moves the cursor along', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    const [c, r] = stepTo(10, 10, Direction.Right);

    const res = roadBuildingClick(st, p, c, r);
    expect(res.sound).toBe(SOUND_SEGMENT);
    expect(rb.segments).toBe(1);
    expect(at(st, 10, 10).paths & (1 << Direction.Right)).not.toBe(0);
    expect(at(st, c, r).paths & (1 << oppositeDir(Direction.Right))).not.toBe(0);
    expect([p.cursorCol, p.cursorRow]).toEqual([c, r]);
  });

  it('a forbidden direction gives sound 4 and changes nothing', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    const [c, r] = stepTo(10, 10, Direction.Right);
    at(st, c, r).owner = 2;
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);

    const res = roadBuildingClick(st, p, c, r);
    expect(res.sound).toBe(SOUND_REJECT);
    expect(rb.segments).toBe(0);
    expect(at(st, 10, 10).paths).toBe(0);
    expect([p.cursorCol, p.cursorRow]).toEqual([10, 10]);
  });

  it('a click on a non-neighbour tile is a no-op without sound', () => {
    const st = state();
    const p = st.players[0]!;
    putFlag(st, 10, 10, 1);
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    expect(roadBuildingClick(st, p, 20, 20)).toEqual({
      sound: null,
      finished: false,
      edgeScroll: 0,
    });
  });

  it('stepping back: the same direction again clears the bits, counts down, sound 8', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    const [c, r] = stepTo(10, 10, Direction.Right);
    roadBuildingClick(st, p, c, r); // forward
    const res = roadBuildingClick(st, p, 10, 10); // back
    expect(res.sound).toBe(SOUND_SEGMENT);
    expect(rb.segments).toBe(0);
    expect(at(st, 10, 10).paths).toBe(0);
    expect(at(st, c, r).paths).toBe(0);
    expect([p.cursorCol, p.cursorRow]).toEqual([10, 10]);
  });
});

describe('road-building — commit (FUN_0002b542)', () => {
  it('a click on a flag links both ends and leaves the mode', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    const a = putFlag(st, 10, 10, 1);
    const [c1, r1] = stepTo(10, 10, Direction.Right);
    const [c2, r2] = stepTo(c1, r1, Direction.Right);
    const b = putFlag(st, c2, r2, 2);

    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    roadBuildingClick(st, p, c1, r1); // one intermediate segment
    const res = roadBuildingClick(st, p, c2, r2); // onto the target flag

    expect(res.sound).toBe(SOUND_ROAD_DONE);
    expect(res.finished).toBe(true);
    expect(rb.active).toBe(false);
    expect(rb.segments).toBe(0);

    // Both ends linked (two pointer writes in the original, @0x2bb62 + @0x2bb70).
    expect(a.paths[Direction.Right]).toBe(true);
    expect(a.connections[Direction.Right]).toEqual({ kind: 'flag', index: 2 });
    expect(a.otherEndDir[Direction.Right]).toBe(Direction.Left);
    expect(b.paths[Direction.Left]).toBe(true);
    expect(b.connections[Direction.Left]).toEqual({ kind: 'flag', index: 1 });
    expect(b.otherEndDir[Direction.Left]).toBe(Direction.Right);
    // Length 2 steps => category 0x00; no transporter bit (the scheduler requests that).
    expect(a.length[Direction.Right]).toBe(0x00);
    expect(b.length[Direction.Left]).toBe(0x00);
    expect(a.transporters[Direction.Right]).toBe(false);
    expect(a.endpointDirs[Direction.Right]).toBe(true);
    // The click branch sets the path bits of the last segment itself (@0x2ac50/@0x2ac6a).
    expect(at(st, c1, r1).paths & (1 << Direction.Right)).not.toBe(0);
    expect(at(st, c2, r2).paths & (1 << Direction.Left)).not.toBe(0);
  });

  it('every EDGE has one kind: `seg(p,dir) == seg(neighbour,opposite)` in all six pairs', () => {
    // An edge is described from two tiles and must yield the same kind both times. Swapping the two
    // triangle masks of one direction (`andb $0xc` @0x2b89a / `andb $0xc0` @0x2b8bb) is invisible in
    // the bytes, since both masks occur anyway, but breaks this invariant immediately.
    const st = state();
    // Mixed terrain, so the check does not pass trivially on all-land.
    for (let i = 0; i < st.mapTiles.length; i++) {
      const t = st.mapTiles[i]!;
      t.terrainUp = (i * 7 + (i >> 4) * 3) % 16;
      t.terrainDown = (i * 5 + (i >> 3)) % 16;
    }
    let water = 0;
    let asym = 0;
    for (let pos = 0; pos < st.mapTiles.length; pos++) {
      for (let d = 0; d < 6; d++) {
        const here = segmentTerrainBit(st, pos, d, geo);
        if (here === 2) water++;
        if (here !== segmentTerrainBit(st, neighbor(pos, d, geo), oppositeDir(d), geo)) asym++;
      }
    }
    expect(asym).toBe(0);
    expect(water).toBeGreaterThan(100); // there are water edges at all
  });

  it('a mixed land/water road fails and tears the mode down', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    const [c1, r1] = stepTo(10, 10, Direction.Right);
    const [c2, r2] = stepTo(c1, r1, Direction.Right);
    putFlag(st, c2, r2, 2);
    // Both triangles of the first edge on water (type <= 3) => one water and one land segment.
    at(st, 10, 10).terrainDown = 1;
    const upOf = neighbor(posOf(10, 10, geo), Direction.Up, geo);
    st.mapTiles[upOf].terrainUp = 1;

    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    roadBuildingClick(st, p, c1, r1);
    const res = roadBuildingClick(st, p, c2, r2);

    expect(res.sound).toBe(SOUND_REJECT);
    expect(res.finished).toBe(false);
    expect(rb.active).toBe(false); // `cancel_road_building` in both cases (@0x2ac95)
    expect(st.flags[2]!.paths[Direction.Left]).toBe(false);
    // The cancellation cleared the provisional bits.
    expect(at(st, c1, r1).paths).toBe(0);
  });
});

describe('road building — cancelling (FUN_000286dc)', () => {
  it('clears all provisional path bits and hides the markers', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);

    const path: Array<[number, number]> = [[10, 10]];
    let cur: [number, number] = [10, 10];
    for (const d of [Direction.Right, Direction.DownRight, Direction.Down]) {
      cur = stepTo(cur[0], cur[1], d);
      path.push(cur);
      roadBuildingClick(st, p, cur[0], cur[1]);
    }
    expect(rb.segments).toBe(3);
    for (const [c, r] of path) expect(at(st, c, r).paths).not.toBe(0);

    cancelRoadBuilding(st, p);
    for (const [c, r] of path) expect(at(st, c, r).paths).toBe(0);
    expect(rb.active).toBe(false);
    expect(rb.segments).toBe(0);
    expect(rb.markers).toEqual(new Array(6).fill(MARKER_NONE));
  });

  /**
   * The teardown walk takes the LOWEST set direction of each tile (`@0x28814`ff). That only works
   * because an intermediate tile of a drawn road carries exactly the two provisional bits: the marker
   * pass allows a step onto a tile that already has roads only if it is a flag, and a flag ends the
   * road. So only the STARTING flag has foreign roads, and it survives.
   */
  it('the real roads of the starting flag survive the cancellation', () => {
    const st = state();
    const p = st.players[0]!;
    const rb = roadSession(st, p);
    putFlag(st, 10, 10, 1);
    at(st, 10, 10).paths = 1 << Direction.Up; // existing road of the starting flag
    beginRoadBuilding(st, p);
    updateRoadMarkers(st, p);
    const [c1, r1] = stepTo(10, 10, Direction.Right);
    const [c2, r2] = stepTo(c1, r1, Direction.Right);
    roadBuildingClick(st, p, c1, r1);
    roadBuildingClick(st, p, c2, r2);
    expect(rb.segments).toBe(2);

    cancelRoadBuilding(st, p);
    expect(at(st, 10, 10).paths).toBe(1 << Direction.Up); // only the provisional Right is gone
    expect(at(st, c1, r1).paths).toBe(0);
    expect(at(st, c2, r2).paths).toBe(0);
  });
});

describe('road building — edge scrolling (@0x2ad55)', () => {
  it('thresholds 0x18 horizontally and 0x28 vertically, mask 1/2/4/8', () => {
    expect(roadEdgeScroll(0x20, 0x100, 608, 432)).toBe(1); // x=0x10 < 0x18
    expect(roadEdgeScroll(600, 0x100, 608, 432)).toBe(2);
    expect(roadEdgeScroll(0x100, 0x20, 608, 432)).toBe(4); // y=0x18 < 0x28
    expect(roadEdgeScroll(0x100, 430, 608, 432)).toBe(8);
    expect(roadEdgeScroll(0x100, 0x100, 608, 432)).toBe(0);
  });
});
