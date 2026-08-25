import { describe, it, expect } from 'vitest';
import { canApplyCommand, applyCommand, applyRoadBuildClick, type Command } from './commands.js';
import { mapGeometry, posOf, Direction } from './position.js';
import {
  SAVE_CLOCK_QUIT_GRACE,
  SAVE_CLOCK_REMINDER_30MIN,
  SAVE_CLOCK_REMINDER_60MIN,
  type GameState,
  type Tile,
  type Flag,
} from './state.js';

/**
 * Command layer — the deterministic player/AI/multiplayer interface. The state changes themselves
 * (e.g. `demolishFlag`) are covered elsewhere; pinned here are the position based dispatch and the
 * admissibility check.
 */
describe('commands — command layer', () => {
  const GEO = mapGeometry(3); // 64×64
  const R = 1 << Direction.Right;
  const L = 1 << Direction.Left;

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

  /** Straight road flag A(10,10) —Right— … —Left— flag B(13,10); B also carries a building. */
  function roadState(): GameState {
    const A = 5, B = 9;
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile();
    mapTiles[posOf(10, 10, GEO)] = tile({ object: 1, objIndex: A, paths: R });
    mapTiles[posOf(11, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(12, 10, GEO)] = tile({ paths: R | L });
    mapTiles[posOf(13, 10, GEO)] = tile({ object: 1, objIndex: B, paths: L });
    const flags: (Flag | null)[] = new Array(10).fill(null);
    flags[A] = flag(A, { paths: [true, false, false, false, false, false], connections: [{ kind: 'flag', index: B }, null, null, null, null, null] });
    flags[B] = flag(B, { paths: [false, false, false, true, false, false], hasBuilding: true, connections: [null, null, null, { kind: 'flag', index: A }, null, null] });
    return {
      geo: GEO, mapTiles, flags, buildings: [], serfs: [],
      players: [
        { slot: 0, index: 0, active: true, flags: 1, build: 0, cursorCol: 10, cursorRow: 10 },
      ],
      roadBuild: [{ active: false, segments: 0, allowedMask: 0, markers: [0, 0, 0, 0, 0, 0] }],
      roadBuildAborted: false,
      // `viewOptions` are the two control option bytes `.DS`@72/73 (factory setting 0x39).
      header: { maxFlagIndex: 10, maxBuildingIndex: 1, viewOptions: [0x39, 0x39] },
      blockMeta: { flags: { recordSize: 70, maxIndex: 10 } },
    } as unknown as GameState;
  }

  it('demolishFlag is admissible on a free flag and tears it down', () => {
    const st = roadState();
    const cmd: Command = { kind: 'demolishFlag', col: 10, row: 10 };
    expect(canApplyCommand(st, cmd)).toBe(true);
    expect(applyCommand(st, cmd)).toBe(true);
    expect(st.flags[5]).toBeNull();
    expect(st.mapTiles[posOf(10, 10, GEO)].object).toBe(0);
  });

  it('demolishFlag is INadmissible on a flag under a building (no-op)', () => {
    const st = roadState();
    const cmd: Command = { kind: 'demolishFlag', col: 13, row: 10 };
    expect(canApplyCommand(st, cmd)).toBe(false);
    expect(applyCommand(st, cmd)).toBe(false);
    expect(st.flags[9]).not.toBeNull(); // unchanged
    expect(st.mapTiles[posOf(13, 10, GEO)].object).toBe(1);
  });

  it('demolishFlag is INadmissible on an empty tile (no-op)', () => {
    const st = roadState();
    const cmd: Command = { kind: 'demolishFlag', col: 20, row: 20 };
    expect(canApplyCommand(st, cmd)).toBe(false);
    expect(applyCommand(st, cmd)).toBe(false);
  });

  it('demolishFlag rejects positions outside the map (no-op, no wrap)', () => {
    const st = roadState();
    expect(canApplyCommand(st, { kind: 'demolishFlag', col: -1, row: 10 })).toBe(false);
    expect(canApplyCommand(st, { kind: 'demolishFlag', col: 10, row: 999 })).toBe(false);
  });

  // --- Panel commands: the gate is the build site classification --------------------------------
  // In the original both icons run `classify_build_site` first and do nothing on a wrong cursor
  // type (error sound only). That is what is pinned here.

  /** Like `roadState()`, but with an active player 0 (the classification needs one). */
  function playerState(): GameState {
    const st = roadState();
    (st as unknown as { players: unknown[] }).players = [
      { slot: 0, active: true, difficulty: 30, build: 0, flags: 0 },
    ];
    return st;
  }

  it('demolishRoad only applies on a road tile (cursor type 4)', () => {
    const st = playerState();
    // (11,10) sits in the middle of the road, (20,20) is empty.
    expect(canApplyCommand(st, { kind: 'demolishRoad', col: 11, row: 10, player: 0 })).toBe(true);
    expect(canApplyCommand(st, { kind: 'demolishRoad', col: 20, row: 20, player: 0 })).toBe(false);
    expect(applyCommand(st, { kind: 'demolishRoad', col: 11, row: 10, player: 0 })).toBe(true);
    // The road is cleared — the tile carries no road bits any more.
    expect(st.mapTiles[posOf(11, 10, GEO)].paths).toBe(0);
  });

  it('demolishRoad with an inactive player is a no-op', () => {
    const st = playerState();
    (st.players[0] as { active: boolean }).active = false;
    expect(canApplyCommand(st, { kind: 'demolishRoad', col: 11, row: 10, player: 0 })).toBe(false);
    expect(applyCommand(st, { kind: 'demolishRoad', col: 11, row: 10, player: 0 })).toBe(false);
    expect(st.mapTiles[posOf(11, 10, GEO)].paths).not.toBe(0); // road still there
  });

  it('buildFlag also applies in the middle of a road (cursor type 4) — building it splits the road', () => {
    // Own state: buildable land (grass-5, height 10, tile owner 1 == player slot 0) and a LONG road
    // A(10,10) … B(16,10). The site (13,10) needs distance to both flags — in the original a
    // neighbouring flag forbids any new flag (branch @0x323b6).
    const A = 5, B = 9;
    const mapTiles: Tile[] = [];
    for (let i = 0; i < GEO.tileCount; i++) {
      mapTiles.push(tile({ owner: 1, height: 10, terrainUp: 5, terrainDown: 5 }));
    }
    mapTiles[posOf(10, 10, GEO)] = tile({ owner: 1, height: 10, terrainUp: 5, terrainDown: 5, object: 1, objIndex: A, paths: R });
    for (let c = 11; c <= 15; c++) {
      mapTiles[posOf(c, 10, GEO)] = tile({ owner: 1, height: 10, terrainUp: 5, terrainDown: 5, paths: R | L });
    }
    mapTiles[posOf(16, 10, GEO)] = tile({ owner: 1, height: 10, terrainUp: 5, terrainDown: 5, object: 1, objIndex: B, paths: L });
    const flags: (Flag | null)[] = new Array(10).fill(null);
    flags[A] = flag(A, {
      paths: [true, false, false, false, false, false],
      endpointDirs: [true, false, false, false, false, false],
      connections: [{ kind: 'flag', index: B }, null, null, null, null, null],
    });
    flags[B] = flag(B, {
      paths: [false, false, false, true, false, false],
      endpointDirs: [false, false, false, true, false, false],
      connections: [null, null, null, { kind: 'flag', index: A }, null, null],
    });
    const st = {
      geo: GEO, mapTiles, flags, buildings: [null], serfs: [],
      players: [{ slot: 0, index: 0, active: true, flags: 1, build: 0 }],
      header: { maxFlagIndex: 10 },
      blockMeta: { flags: { recordSize: 70, maxIndex: 10 } },
    } as unknown as GameState;

    // In the original type 4, possibility 'flag only'.
    const cmd: Command = { kind: 'buildFlag', col: 13, row: 10, player: 0 };
    expect(canApplyCommand(st, cmd)).toBe(true);
    expect(applyCommand(st, cmd)).toBe(true);
    const t = st.mapTiles[posOf(13, 10, GEO)];
    expect(t.object).toBe(1); // flag is there
    const fresh = st.flags[t.objIndex];
    expect(fresh).not.toBeNull();
    // The two old flags now point at the new flag rather than at each other.
    expect(st.flags[A]!.connections[Direction.Right]).toEqual({ kind: 'flag', index: t.objIndex });
    expect(st.flags[B]!.connections[Direction.Left]).toEqual({ kind: 'flag', index: t.objIndex });
    // …and the new flag points back in both directions.
    expect(fresh!.connections[Direction.Left]).toEqual({ kind: 'flag', index: A });
    expect(fresh!.connections[Direction.Right]).toEqual({ kind: 'flag', index: B });
  });

  it('foundCastle demands possibility 5 AND type 7 — so not on a road', () => {
    const st = playerState();
    expect(canApplyCommand(st, { kind: 'foundCastle', col: 11, row: 10, player: 0 })).toBe(false);
    expect(applyCommand(st, { kind: 'foundCastle', col: 11, row: 10, player: 0 })).toBe(false);
  });

  /**
   * Road building as a command sequence. The touchstone is not 'a road appears' but REPLAYABILITY:
   * the same command sequence on the same starting state must produce the same end state — otherwise
   * road building is missing from the action log of a bug report.
   */
  describe('road building', () => {
    /** Two flags two tiles apart: A(10,10) … B(13,10), no road between them. */
    function twoFlags(): GameState {
      const A = 5, B = 9;
      const mapTiles: Tile[] = new Array(GEO.tileCount);
      // Own land, grass-5, same height: otherwise the marker pass blocks the directions and the
      // special click would find no buildable spot (terrain 0..3 is water).
      const land = { owner: 1, terrainUp: 5, terrainDown: 5, height: 10 };
      for (let i = 0; i < mapTiles.length; i++) mapTiles[i] = tile(land);
      mapTiles[posOf(10, 10, GEO)] = tile({ ...land, object: 1, objIndex: A });
      mapTiles[posOf(13, 10, GEO)] = tile({ ...land, object: 1, objIndex: B });
      const flags: (Flag | null)[] = new Array(10).fill(null);
      flags[A] = flag(A);
      flags[B] = flag(B);
      return {
        geo: GEO, mapTiles, flags, buildings: [null], serfs: [],
        players: [
          { slot: 0, index: 0, active: true, flags: 1, build: 0, cursorCol: 10, cursorRow: 10 },
        ],
        roadBuild: [{ active: false, segments: 0, allowedMask: 0, markers: [0, 0, 0, 0, 0, 0] }],
        roadBuildAborted: false,
        header: { maxFlagIndex: 10, maxBuildingIndex: 1 },
        blockMeta: { flags: { recordSize: 70, maxIndex: 10 } },
      } as unknown as GameState;
    }

    /** The command sequence 'from A to B in three steps to the right'. */
    const ROAD: readonly Command[] = [
      { kind: 'beginRoadBuilding', col: 10, row: 10, player: 0 },
      { kind: 'roadBuildClick', col: 11, row: 10, player: 0 },
      { kind: 'roadBuildClick', col: 12, row: 10, player: 0 },
      { kind: 'roadBuildClick', col: 13, row: 10, player: 0 },
    ];

    /** What the state carries after a road has been laid. */
    function roadShape(st: GameState) {
      return {
        paths: [10, 11, 12, 13].map((c) => st.mapTiles[posOf(c, 10, GEO)].paths),
        aRight: st.flags[5]!.connections[Direction.Right],
        bLeft: st.flags[9]!.connections[Direction.Left],
        aLength: st.flags[5]!.length[Direction.Right],
        session: { ...st.roadBuild[0]! },
        cursor: [st.players[0]!.cursorCol, st.players[0]!.cursorRow],
      };
    }

    it('beginRoadBuilding only from a flag, and not twice', () => {
      const st = twoFlags();
      // Empty tile: the original takes the branch there that only writes panel icons.
      expect(canApplyCommand(st, { kind: 'beginRoadBuilding', col: 11, row: 10, player: 0 })).toBe(false);
      expect(applyCommand(st, ROAD[0]!)).toBe(true);
      expect(st.roadBuild[0]!.active).toBe(true);
      expect(st.roadBuild[0]!.allowedMask).toBe(0x3f); // the allowed directions are computed
      // A second start is rejected — in the original the same icon is the cancel branch.
      expect(canApplyCommand(st, ROAD[0]!)).toBe(false);
    });

    it('a click without a running road build is rejected', () => {
      const st = twoFlags();
      const click: Command = { kind: 'roadBuildClick', col: 11, row: 10, player: 0 };
      expect(canApplyCommand(st, click)).toBe(false);
      expect(applyRoadBuildClick(st, click).applied).toBe(false);
      expect(st.mapTiles[posOf(11, 10, GEO)].paths).toBe(0);
    });

    it('three clicks lay the road and end the mode', () => {
      const st = twoFlags();
      for (const cmd of ROAD) expect(applyCommand(st, cmd)).toBe(true);
      expect(st.mapTiles[posOf(10, 10, GEO)].paths & R).not.toBe(0);
      expect(st.mapTiles[posOf(13, 10, GEO)].paths & L).not.toBe(0);
      expect(st.flags[5]!.connections[Direction.Right]).toEqual({ kind: 'flag', index: 9 });
      expect(st.flags[9]!.connections[Direction.Left]).toEqual({ kind: 'flag', index: 5 });
      expect(st.roadBuild[0]!.active).toBe(false); // the commit ends the mode (@0x2ac95)
    });

    it('the same command sequence yields the same state — the log is replayable', () => {
      const live = twoFlags();
      const replay = twoFlags();
      for (const cmd of ROAD) applyCommand(live, cmd);
      // Exactly what a bug report does: starting state + `actions.json` passed through as JSON.
      for (const cmd of JSON.parse(JSON.stringify(ROAD)) as Command[]) applyCommand(replay, cmd);
      expect(roadShape(replay)).toEqual(roadShape(live));
    });

    it('the sound distinguishes segment, rejection and completion', () => {
      const st = twoFlags();
      applyCommand(st, ROAD[0]!);
      expect(applyRoadBuildClick(st, ROAD[1]! as never).sound).toBe(8); // segment
      // Non-neighbouring tile: no-op without sound (`jne 0x2ae59`), so not 'applied' either.
      const far = applyRoadBuildClick(st, { kind: 'roadBuildClick', col: 30, row: 30, player: 0 });
      expect(far).toMatchObject({ sound: null, applied: false });
      expect(applyRoadBuildClick(st, ROAD[2]! as never).sound).toBe(8);
      const done = applyRoadBuildClick(st, ROAD[3]! as never);
      expect(done).toMatchObject({ sound: 2, finished: true, applied: true });
    });

    it('cancelRoadBuilding clears the provisional road bits', () => {
      const st = twoFlags();
      applyCommand(st, ROAD[0]!);
      applyCommand(st, ROAD[1]!);
      applyCommand(st, ROAD[2]!);
      expect(st.mapTiles[posOf(11, 10, GEO)].paths).not.toBe(0);
      expect(applyCommand(st, { kind: 'cancelRoadBuilding', player: 0 })).toBe(true);
      // @0x28801: the cancel walks the segments back from the cursor and clears both bits per edge.
      for (const c of [10, 11, 12]) expect(st.mapTiles[posOf(c, 10, GEO)].paths).toBe(0);
      expect(st.roadBuild[0]!.active).toBe(false);
    });

    it('the provisional segments are real map bits — hence logging per CLICK', () => {
      const st = twoFlags();
      applyCommand(st, ROAD[0]!);
      applyCommand(st, ROAD[1]!);
      // The original stores the half-finished road in `landscape[0]` of both tiles
      // (@0x2acfb/@0x2ad15) — there is no side buffer. Logic ticks between two clicks SEE those bits
      // (flag scheduler, renderer, `clearRoadPaths`), so a log that only knows the finished road
      // could not replay a session interleaved with ticks.
      expect(st.mapTiles[posOf(10, 10, GEO)].paths & R).not.toBe(0);
      expect(st.mapTiles[posOf(11, 10, GEO)].paths & L).not.toBe(0);
      // …and the road is not linked yet: that happens on commit.
      expect(st.flags[5]!.connections[Direction.Right]).toBeNull();
    });

    it('a special click places a flag on the way and thereby commits at once (@0x2aa7f)', () => {
      const st = twoFlags();
      // Only the starting flag: the neighbours of a flag are `flagBlocked` (minimum distance), so a
      // special click needs room — (13,10) is three tiles away.
      st.flags[9] = null;
      st.mapTiles[posOf(13, 10, GEO)].object = 0;
      st.mapTiles[posOf(13, 10, GEO)].objIndex = 0;
      applyCommand(st, ROAD[0]!);
      applyCommand(st, ROAD[1]!);
      applyCommand(st, ROAD[2]!);
      const res = applyRoadBuildClick(st, {
        kind: 'roadBuildClick', col: 13, row: 10, player: 0, special: true,
      });
      const t = st.mapTiles[posOf(13, 10, GEO)];
      expect(t.object).toBe(1); // flag built
      expect(st.flags[t.objIndex]).not.toBeNull();
      // Once the flag stands the tile is a road end, so the same click commits (@0x2abf4).
      expect(res).toMatchObject({ finished: true, sound: 2 });
      expect(st.flags[5]!.connections[Direction.Right]).toEqual({ kind: 'flag', index: t.objIndex });
    });
  });

  /**
   * Menu actions as commands. The touchstone is again REPLAYABILITY, not 'the action does
   * something': the same list on the same starting state must produce the same end state — and the
   * list deliberately passes through JSON, as in `actions.json`.
   */
  describe('menu actions', () => {
    /** Player with distribution fields + a warehouse with inventory on (13,10). */
    function menuState(): GameState {
      const st = roadState();
      (st as unknown as { players: unknown[] }).players = [
        {
          slot: 0,
          index: 0,
          active: true,
          difficulty: 30,
          build: 0,
          flags: 0,
          foodDistribution: [0, 0, 0, 0],
          planksDistribution: [0, 0, 0],
          steelDistribution: [0, 0],
          coalDistribution: [0, 0, 0],
          wheatDistribution: [0, 0],
          toolPriority: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          serfToKnightRate: 0,
          knightOccupation: [0x10, 0x21, 0x32, 0x43],
          // The priority lists are always a permutation of 1..26; the original relies on that
          // (`selectPriorityItem` searches without a bound).
          flagPriority: Array.from({ length: 26 }, (_, i) => i + 1),
          inventoryPriority: Array.from({ length: 26 }, (_, i) => i + 1),
          knightMenuValue: 3,
          knightsAttacking: 0,
          totalAttackingKnights: 0,
          attackingKnights: [0, 0, 0, 0],
          attackingBuildingCount: 0,
          serfCount: new Array(27).fill(0),
          recallCount: 0,
          recallQueue: new Array(64).fill(null).map(() => ({ remaining: 0, payload: 0 })),
        },
      ];
      return st;
    }

    /** A mixed command sequence such as operating the menus produces. */
    const SCRIPT: readonly Command[] = [
      { kind: 'setDistributionValue', player: 0, list: 'foodDistribution', index: 2, value: 40000 },
      { kind: 'setDistributionValue', player: 0, list: 'serfToKnightRate', index: 0, value: 12345 },
      { kind: 'setKnightOccupation', player: 0, index: 1, bound: 'min', delta: 1 },
      { kind: 'setCastleGarrisonTarget', player: 0, delta: 1 },
      { kind: 'setAttackSelection', player: 0, strong: true },
      { kind: 'selectPriorityItem', player: 0, list: 'transport', slot: 3 },
      { kind: 'movePriorityItem', player: 0, list: 'transport', move: 'top' },
      { kind: 'resetDistributionDefaults', player: 0, screen: 0x1c },
      { kind: 'startKnightShift', player: 0 },
      { kind: 'cycleMessageLevel', side: 0 },
      { kind: 'setViewOption', side: 1, mask: 1 },
      {
        kind: 'scheduleRecall',
        player: 0,
        delayRow: 2,
        target: { kind: 'map', col: 12, row: 9 },
      },
    ];

    it('all twelve are accepted and take effect', () => {
      const st = menuState();
      for (const cmd of SCRIPT) expect(applyCommand(st, cmd), cmd.kind).toBe(true);
      const p = st.players[0]!;
      expect(p.serfToKnightRate).toBe(12345);
      expect(p.foodDistribution[2]).toBe(13100 + 32750); // overwritten by the defaults button (0x1c)
      expect(p.knightOccupation[1]! & 0xf).toBe(2); // lower bound 1 -> 2
      expect(p.knightMenuValue).toBe(4);
      expect(p.flags & 2).toBe(2); // attack selection 'the stronger ones'
      expect(p.recallCount).toBe(1);
      // Bit 0 (road-build scrolling) is SET in the factory setting 0x39 — the tick box toggles it.
      expect(st.header.viewOptions[1]).toBe(0x38);
    });

    it('the same list yields the same state — the log is replayable', () => {
      const live = menuState();
      const replay = menuState();
      for (const cmd of SCRIPT) applyCommand(live, cmd);
      // Like a bug report: the commands pass through JSON.
      for (const cmd of JSON.parse(JSON.stringify(SCRIPT)) as Command[]) applyCommand(replay, cmd);
      expect(JSON.stringify(replay.players[0])).toEqual(JSON.stringify(live.players[0]));
      expect(JSON.stringify(replay.header.viewOptions)).toEqual(JSON.stringify(live.header.viewOptions));
    });

    it('an inactive player is rejected — by the menu commands too', () => {
      const st = menuState();
      (st.players[0] as { active: boolean }).active = false;
      for (const cmd of SCRIPT) {
        if (cmd.kind === 'setViewOption' || cmd.kind === 'cycleMessageLevel') continue; // no player involved
        expect(canApplyCommand(st, cmd), cmd.kind).toBe(false);
      }
    });

    it('the recall list is full at 64 entries (`cmpw $0x40` @0x279b2)', () => {
      const st = menuState();
      const p = st.players[0]! as unknown as { recallCount: number };
      p.recallCount = 64;
      expect(
        canApplyCommand(st, {
          kind: 'scheduleRecall',
          player: 0,
          delayRow: 0,
          target: { kind: 'menu', index: 3 },
        }),
      ).toBe(false);
    });

    it('setInventoryMode addresses the warehouse at its map position and checks the owner', () => {
      const st = menuState();
      // A warehouse with inventory on (13,10) — the fixture has flag B there, so repurpose the tile:
      // object 3 (large building) with index 1.
      st.mapTiles[posOf(13, 10, GEO)]!.object = 3;
      st.mapTiles[posOf(13, 10, GEO)]!.objIndex = 1;
      (st as unknown as { buildings: unknown[] }).buildings = [
        null,
        { index: 1, col: 13, row: 10, type: 10, owner: 0, inventoryIndex: 1, flag: 9 },
      ];
      (st as unknown as { inventories: unknown[] }).inventories = [
        null,
        {
          index: 1, owner: 0, flag: 9, resMode: 0, serfMode: 0, resDir: 0,
          // The out mode clears the resource destinations of the network
          // (`cancelResourceDestinations`) and reads both out slots of every inventory.
          outQueue: [{ type: -1, dest: 0 }, { type: -1, dest: 0 }],
          resources: new Array(26).fill(0),
          serfIndices: new Array(27).fill(0),
        },
      ];
      const cmd: Command = {
        kind: 'setInventoryMode', col: 13, row: 10, player: 0, group: 'resources', mode: 3,
      };
      expect(canApplyCommand(st, cmd)).toBe(true);
      expect(applyCommand(st, cmd)).toBe(true);
      // Mode 3 == 'move out' (not 2 — the values are verified against the save game bytes).
      expect(st.inventories[1]!.resMode).toBe(3);
      expect(st.inventories[1]!.resDir & 3).toBe(3);
      // A foreign player cannot reach it.
      expect(canApplyCommand(st, { ...cmd, player: 1 })).toBe(false);
    });
  });

  describe('noteGameSaved — the three clocks after a successful save', () => {
    /**
     * A command rather than an assignment in the UI layer, because it is the ONLY state change of a
     * save and lives in an action handler in the original (@0x28506 ff.). Outside the command layer
     * it would be missing from the action log, and a replayed bug report would fire the two save
     * reminders at a different time.
     */
    it('resets all three, no matter how far they had run', () => {
      const st = roadState();
      st.saveClocks = { quitGrace: 0, reminder30: -5, reminder60: 12 };
      expect(canApplyCommand(st, { kind: 'noteGameSaved' })).toBe(true);
      expect(applyCommand(st, { kind: 'noteGameSaved' })).toBe(true);
      expect(st.saveClocks).toEqual({
        quitGrace: SAVE_CLOCK_QUIT_GRACE,
        reminder30: SAVE_CLOCK_REMINDER_30MIN,
        reminder60: SAVE_CLOCK_REMINDER_60MIN,
      });
    });

    it('carries exactly the values the original writes in three places', () => {
      // 180000 / 360000 ticks at 100 Hz == 30 / 60 minutes (message 17 resp. 18), 6000 == 60 s.
      expect(SAVE_CLOCK_REMINDER_30MIN / 6000).toBe(30);
      expect(SAVE_CLOCK_REMINDER_60MIN / 6000).toBe(60);
      expect(SAVE_CLOCK_QUIT_GRACE / 100).toBe(60);
    });

    it('runs unconditionally — a save is always admissible', () => {
      // Here the original only tests the result code, not the game state; checking the code belongs
      // to the caller (`diskSaveResetsClocks`).
      expect(canApplyCommand(roadState(), { kind: 'noteGameSaved' })).toBe(true);
    });
  });

  describe('switchSpectatorPlayer — the switch in the frame header (`FUN_0002bf57`)', () => {
    /** Like {@link roadState}, but with four slots and a filled message list per slot. */
    function spectatorState(): GameState {
      const st = roadState();
      const mk = (slot: number, active: boolean) =>
        ({
          slot,
          index: slot,
          active,
          // Bit 3 == the message alarm, bit 6 == active, bit 7 == AI (demo).
          flags: active ? 0xc8 : 0x00,
          build: 0,
          messageTypes: [6, 6, 7],
          messagePositions: [10, 11, 12],
        }) as unknown as NonNullable<GameState['players'][number]>;
      (st as { players: unknown }).players = [mk(0, true), mk(1, true), mk(2, false), mk(3, true)];
      return st;
    }

    it('empties the message list of the target and clears its message alarm', () => {
      const st = spectatorState();
      const cmd: Command = { kind: 'switchSpectatorPlayer', slot: 1 };
      expect(canApplyCommand(st, cmd)).toBe(true);
      expect(applyCommand(st, cmd)).toBe(true);
      expect(st.players[1]!.messageTypes).toEqual([]);
      expect(st.players[1]!.flags & 0x08).toBe(0);
      // The position column stays — the original eraser only touches the type column.
      expect(st.players[1]!.messagePositions.length).toBe(3);
      // And the other players stay untouched: the switch only acts on the target.
      expect(st.players[0]!.messageTypes.length).toBe(3);
      expect(st.players[0]!.flags & 0x08).not.toBe(0);
    });

    it('an empty slot is rejected and changes nothing (`bt $0x6 ; je`)', () => {
      const st = spectatorState();
      const cmd: Command = { kind: 'switchSpectatorPlayer', slot: 2 };
      expect(canApplyCommand(st, cmd)).toBe(false);
      expect(applyCommand(st, cmd)).toBe(false);
      expect(st.players[2]!.messageTypes.length).toBe(3);
    });

    it('a slot outside 0..3 is rejected as well', () => {
      expect(canApplyCommand(spectatorState(), { kind: 'switchSpectatorPlayer', slot: 7 })).toBe(
        false,
      );
    });
  });
});
