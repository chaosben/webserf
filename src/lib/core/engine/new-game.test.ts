import { describe, expect, it } from 'vitest';
import {
  AI_TRAITS,
  GAME_TYPE,
  HUMAN_INTELLIGENCE,
  ROTATION_WRAP_NO_AI,
  ROTATION_WRAP_WITH_AI,
  createEmptyPlayer,
  deriveGameConstants,
  initPlayers,
  isSpectatorGame,
  resetGameClocks,
  resolveGameSetup,
  setPlayerCastlePos,
  startNewGame,
} from './new-game.js';
import {
  CASTLE_POS_UNSET,
  HUMAN_FACE,
  HUMAN_FACE_2,
  SETUP_RECORDS,
} from '../player-setup.js';
import { plainMapClickSilent } from '../ui-sound.js';
import { mapGeometry } from './position.js';
import type { GameState, Player } from './state.js';

/** Level 30 (record 35) — two players, both castle positions prescribed. */
const LEVEL_30 = { gameType: GAME_TYPE.Level, levelSetupIndex: 30 } as const;

describe('isSpectatorGame — `gs+0x37e` Bit 5', () => {
  it('holds for game type 4 and no other', () => {
    // The setter sits behind `cmpw $0x4,0x352(%ebx)` @0x4fe75 — an EQUALITY, not a threshold.
    // Hence all five game types individually instead of only checking the 4.
    const seen = Object.values(GAME_TYPE).map((t) => [t, isSpectatorGame(t)] as const);
    expect(seen).toEqual([
      [GAME_TYPE.Level, false],
      [GAME_TYPE.Mission, false],
      [GAME_TYPE.FreeOnePlayer, false],
      [GAME_TYPE.FreeTwoPlayers, false],
      [GAME_TYPE.Demo, true],
    ]);
  });

  it('is the same quantity as the sound gate of the plain map click', () => {
    // `plainMapClickSilent` @0x29faf reads the same bit. Two definitions would be two truths — one
    // delegates, and this test pins that.
    for (const t of [0, 1, 2, 3, 4, 5, 255]) {
      expect(plainMapClickSilent(t)).toBe(isSpectatorGame(t));
    }
  });
});

describe('spectator mode: a demo start has no human player', () => {
  it('all occupied slots are AI', () => {
    // The counter check for the control lock: if a slot WERE human, locking the panel would be
    // wrong. Game type 4 sets no human face in `apply_game_setup` — checked here on the state.
    const st = startNewGame({
      gameType: GAME_TYPE.Demo,
      mapSize: 3,
      seed: [1, 2, 3],
      menuPlayers: [
        [9, 1, 2, 3],
        [4, 5, 6, 7],
      ],
    });
    expect(isSpectatorGame(st.header.gameType)).toBe(true);
    const active = st.players.filter((p): p is Player => p !== null && p.active);
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) expect(p.flags & 0x80).not.toBe(0);
  });
});

describe('menuSetup: the menu columns land in the header (`.DS`@144..163)', () => {
  const SETUP = {
    gameType: GAME_TYPE.Demo,
    mapSize: 3,
    seed: [1, 2, 3] as const,
    // `PlayerDescriptor` = [face, supply, intelligence, reproduction] — the record's order.
    menuPlayers: [
      [3, 11, 21, 31],
      [5, 12, 22, 32],
      [7, 13, 23, 33],
      [9, 14, 24, 34],
    ] as const,
    humanSupplies: [15, 16] as const,
    humanReproduction: [28, 29] as const,
  };

  it('carries all four columns and swaps the middle two into the gs order', () => {
    const m = startNewGame(SETUP as never).header.menuSetup;
    expect(m).toBeDefined();
    expect(m!.face).toEqual([3, 5, 7, 9]);
    // The descriptor carries supply BEFORE intelligence, but `gs+0x36e` is intelligence — the two
    // columns must not swap while repacking (else `difficulty` and `aiRate` would be swapped).
    expect(m!.supply).toEqual([11, 12, 13, 14]);
    expect(m!.intelligence).toEqual([21, 22, 23, 24]);
    expect(m!.reproduction).toEqual([31, 32, 33, 34]);
    expect(m!.humanSupply).toEqual([15, 16]);
    expect(m!.humanReproduction).toEqual([28, 29]);
  });

  it('the stored columns explain the derived player fields', () => {
    // `difficulty` comes from the supply column, `reproductionReset` from `(60 - reproduction) * 50`.
    const st = startNewGame(SETUP as never);
    const m = st.header.menuSetup!;
    st.players.forEach((p, slot) => {
      if (!p || !p.active) return;
      expect(p.difficulty).toBe(m.supply[slot]);
      expect(p.reproductionReset).toBe((60 - m.reproduction[slot]!) * 50);
    });
  });

  it('stays `undefined` for level/mission — the original does not load it there', () => {
    expect(startNewGame(LEVEL_30).header.menuSetup).toBeUndefined();
  });
});

describe('resolveGameSetup', () => {
  it('the level branch reads record levelSetupIndex + 5', () => {
    const r = resolveGameSetup(LEVEL_30);
    expect(r.descriptors[0]![0]).toBe(HUMAN_FACE);
    expect(r.descriptors[0]![2]).toBe(HUMAN_INTELLIGENCE);
    expect(r.descriptors[1]).toEqual(SETUP_RECORDS[35]!.players[1]);
    expect(r.castles[0]).toEqual(SETUP_RECORDS[35]!.castles[0]);
    expect(r.mapSize).toBe(3);
  });

  it('the mission branch reads record missionSetupIndex - 1', () => {
    const r = resolveGameSetup({ gameType: GAME_TYPE.Mission, missionSetupIndex: 6 });
    expect(r.descriptors[0]).toEqual(SETUP_RECORDS[5]!.players[0]);
  });

  it('the XOR mask is applied in both branches', () => {
    const lvl = resolveGameSetup(LEVEL_30);
    expect(lvl.mapSeed[0]).toBe(SETUP_RECORDS[35]!.seed[0] ^ 0x5a5a);
    const free = resolveGameSetup({
      gameType: GAME_TYPE.FreeOnePlayer,
      mapSize: 4,
      seed: [0x1111, 0x2222, 0x3333],
    });
    expect(free.mapSeed).toEqual([0x1111 ^ 0x5a5a, 0x2222 ^ 0xa5a5, 0x3333 ^ 0xc3c3]);
    expect(free.mapSize).toBe(4);
  });

  it('free game: slot 0 is the human, slot 1 from the menu, no castle positions', () => {
    const r = resolveGameSetup({
      gameType: GAME_TYPE.FreeOnePlayer,
      mapSize: 3,
      seed: [0, 0, 0],
      menuPlayers: [
        [9, 1, 2, 3],
        [4, 5, 6, 7],
      ],
      humanSupplies: [30, 31],
      humanReproduction: [40, 41],
    });
    expect(r.descriptors[0]).toEqual([HUMAN_FACE, 30, HUMAN_INTELLIGENCE, 40]);
    expect(r.descriptors[1]).toEqual([4, 5, 6, 7]);
    expect(r.castles.every((c) => c[0] === CASTLE_POS_UNSET)).toBe(true);
  });

  it('two humans: slot 1 gets the second face and the same intelligence', () => {
    const r = resolveGameSetup({
      gameType: GAME_TYPE.FreeTwoPlayers,
      mapSize: 3,
      seed: [0, 0, 0],
      menuPlayers: [[9, 1, 2, 3], [4, 5, 6, 7]],
      humanSupplies: [30, 31],
      humanReproduction: [40, 41],
    });
    expect(r.descriptors[1]).toEqual([HUMAN_FACE_2, 31, HUMAN_INTELLIGENCE, 41]);
  });

  it('demo: slot 0 comes from the menu too — there is no human', () => {
    const r = resolveGameSetup({
      gameType: GAME_TYPE.Demo,
      mapSize: 3,
      seed: [0, 0, 0],
      menuPlayers: [[9, 1, 2, 3], [4, 5, 6, 7]],
    });
    expect(r.descriptors[0]).toEqual([9, 1, 2, 3]);
    expect(r.descriptors.some((d) => d[0] === HUMAN_FACE)).toBe(false);
  });

  it('a record that does not exist is an error, not an empty map', () => {
    expect(() => resolveGameSetup({ gameType: GAME_TYPE.Level, levelSetupIndex: 99 })).toThrow();
  });
});

describe('deriveGameConstants', () => {
  it('64x64 with two players yields the values of the original save games', () => {
    const c = deriveGameConstants(mapGeometry(3), [
      [HUMAN_FACE, 5, HUMAN_INTELLIGENCE, 20],
      [11, 20, 40, 20],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(c.serfBudget).toBe(2000); // (64>>5)*(64>>5)*500
    expect(c.populationBase).toBe(250);
    expect(c.populationSpan).toBe(1500);
    expect(c.mapGoldMoraleFactor).toBe(20480);
    expect(c.serviceBudget).toBe(55);
  });

  it('the player count enters span and morale factor linearly', () => {
    const one = deriveGameConstants(mapGeometry(3), [[HUMAN_FACE, 0, HUMAN_INTELLIGENCE, 0]]);
    expect(one.populationSpan).toBe(1750);
    expect(one.mapGoldMoraleFactor).toBe(10240);
    const three = deriveGameConstants(mapGeometry(3), [
      [HUMAN_FACE, 0, HUMAN_INTELLIGENCE, 0],
      [1, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    expect(three.populationSpan).toBe(1250);
    expect(three.mapGoldMoraleFactor).toBe(30720);
  });
});

describe('initPlayers', () => {
  function run(desc: readonly (readonly [number, number, number, number])[]) {
    const players: (Player | null)[] = [null, null, null, null];
    const { rotationWrap } = initPlayers(players, desc);
    return { players, rotationWrap };
  }

  it('the rotation wrap distinguishes with-AI from without', () => {
    expect(run([[HUMAN_FACE, 0, HUMAN_INTELLIGENCE, 0]]).rotationWrap).toBe(ROTATION_WRAP_NO_AI);
    expect(run([[HUMAN_FACE, 0, HUMAN_INTELLIGENCE, 0], [5, 0, 0, 0]]).rotationWrap).toBe(
      ROTATION_WRAP_WITH_AI,
    );
  });

  it('a face < 0x0c sets the AI bit and the character row', () => {
    const { players } = run([[HUMAN_FACE, 0, HUMAN_INTELLIGENCE, 0], [3, 0, 0, 0]]);
    const ai = players[1]!;
    expect(ai.flags & 0x80).toBe(0x80);
    expect(ai.aiOccupationCap).toBe(AI_TRAITS.occupationCap[2]);
    expect(ai.aiHutUrgencyCap).toBe(AI_TRAITS.hutUrgencyCap[2]);
    expect(players[0]!.flags & 0x80).toBe(0);
    expect(players[0]!.aiOccupationCap).toBe(0);
  });

  it('the three descriptor bytes are converted into their fields', () => {
    const { players } = run([[HUMAN_FACE, 17, HUMAN_INTELLIGENCE, 35], [3, 9, 12, 50]]);
    expect(players[0]!.difficulty).toBe(17);
    expect(players[0]!.reproductionReset).toBe((60 - 35) * 50);
    expect(players[0]!.reproductionCounter).toBe((60 - 35) * 50);
    expect(players[0]!.aiRate).toBe(65535); // 40 * 1300 + 13535, exactly the u16 ceiling
    expect(players[1]!.difficulty).toBe(9);
    expect(players[1]!.aiRate).toBe(12 * 1300 + 13535);
    expect(players[1]!.reproductionReset).toBe((60 - 50) * 50);
  });

  it('the build pressure starts saturated, the loss register empty', () => {
    const { players } = run([[HUMAN_FACE, 0, HUMAN_INTELLIGENCE, 0]]);
    expect(players[0]!.aiPressure).toHaveLength(25);
    expect(players[0]!.aiPressure.every((v) => v === 0xffff)).toBe(true);
    expect(players[0]!.aiLossRegister.every((s) => s.col === 0xffff && s.row === 0xffff)).toBe(true);
  });

  it('an unoccupied slot stays fully zeroed', () => {
    const { players } = run([[HUMAN_FACE, 5, HUMAN_INTELLIGENCE, 20]]);
    const empty = players[1]!;
    expect(empty.active).toBe(false);
    expect(empty.flags).toBe(0);
    expect(empty.aiPressure.every((v) => v === 0)).toBe(true);
    expect(empty.toolPriority.every((v) => v === 0)).toBe(true);
    expect(empty.statHistory).toHaveLength(0);
  });

  it('the distribution defaults are set (the same ones the default button applies)', () => {
    const { players } = run([[HUMAN_FACE, 5, HUMAN_INTELLIGENCE, 20]]);
    const p = players[0]!;
    expect(p.toolPriority).toEqual([9825, 65500, 13100, 6550, 13100, 26200, 32750, 45850, 6550]);
    expect(p.foodDistribution).toEqual([13100, 45850, 45850, 65500]);
    expect([...p.flagPriority].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 26 }, (_, i) => i + 1),
    );
    expect(p.knightOccupation).toEqual([0x10, 0x21, 0x32, 0x43]);
    expect(p.contSearchAfterNonOptimalFind).toBe(7);
    expect(p.serfToKnightRate).toBe(20000);
    expect(p.currentSett5Item).toBe(8);
    expect(p.currentSett6Item).toBe(0xf);
    expect(p.knightMenuValue).toBe(3);
    expect(p.messageFlags).toBe(1);
  });
});

describe('setPlayerCastlePos', () => {
  /** A state in which only the players matter — the tile check is done by `foundCastle`. */
  function stateWithPlayer(flags: number): { state: GameState; player: Player } {
    const state = startNewGame({ gameType: GAME_TYPE.Mission, missionSetupIndex: 1 });
    const player = state.players[0]!;
    player.flags = flags;
    return { state, player };
  }

  it('0xff means do nothing — no cursor, no state change, no founding', () => {
    const { state, player } = stateWithPlayer(0x40);
    player.cursorCol = 7;
    player.cursorRow = 8;
    const did = setPlayerCastlePos(state, player, [CASTLE_POS_UNSET, CASTLE_POS_UNSET]);
    expect(did).toBe(false);
    expect(player.cursorCol).toBe(7); // untouched
    expect(player.castleBuilding).toBe(0);
  });

  it('any value from 0x80 up counts as not prescribed (a sign test, not equality)', () => {
    const { state, player } = stateWithPlayer(0x40);
    expect(setPlayerCastlePos(state, player, [0x80, 3])).toBe(false);
    expect(setPlayerCastlePos(state, player, [0xfe, 3])).toBe(false);
  });

  it('an AI with a prescribed position skips its own castle site search', () => {
    const { state, player } = stateWithPlayer(0x40 | 0x80);
    setPlayerCastlePos(state, player, [20, 20]);
    expect(player.aiState).toBe(1);
    expect(player.aiCounter).toBe(0x18);
  });

  it('a human keeps state 0 (it has no AI tick)', () => {
    const { state, player } = stateWithPlayer(0x40);
    setPlayerCastlePos(state, player, [20, 20]);
    expect(player.aiState).toBe(0);
  });
});

describe('startNewGame', () => {
  it('level 30 founds both prescribed castles', () => {
    const st = startNewGame(LEVEL_30);
    const rec = SETUP_RECORDS[35]!;
    for (const slot of [0, 1]) {
      const p = st.players[slot]!;
      expect(p.active).toBe(true);
      const bld = st.buildings[p.castleBuilding];
      expect(bld).toBeTruthy();
      expect(bld!.type).toBe(24);
      expect([bld!.col, bld!.row]).toEqual([rec.castles[slot]![0], rec.castles[slot]![1]]);
    }
    expect(st.rotationWrap).toBe(ROTATION_WRAP_WITH_AI);
  });

  it('without a prescribed position nothing is founded — only the reserved null slot', () => {
    const st = startNewGame({ gameType: GAME_TYPE.Mission, missionSetupIndex: 1 });
    // Exactly ONE entry per store, namely slot 0: the reserved null slot from `resetEntityTables`
    // (@0x76bb). Freshly started original save games carry
    // `maxBuildingIndex == maxFlagIndex == maxSerfIndex == 1` with slot 0 occupied.
    expect(st.buildings.filter(Boolean).map((b) => b!.index)).toEqual([0]);
    expect(st.flags.filter(Boolean).map((f) => f!.index)).toEqual([0]);
    expect(st.serfs.filter(Boolean).map((s2) => s2!.index)).toEqual([0]);
    // Inventories have NO null slot — without a castle the table is empty.
    expect(st.inventories.filter(Boolean)).toHaveLength(0);
    expect(st.mapTiles.every((t) => t.owner === 0)).toBe(true);
  });

  it('the same game start yields the same map twice (deterministic)', () => {
    const a = startNewGame(LEVEL_30);
    const b = startNewGame(LEVEL_30);
    expect(a.mapTiles.map((t) => t.terrainUp)).toEqual(b.mapTiles.map((t) => t.terrainUp));
    expect(a.header.mapGoldTotal).toBe(b.header.mapGoldTotal);
    expect(a.rng.getState()).toEqual(b.rng.getState());
  });

  it('a different seed yields a different map', () => {
    const a = startNewGame(LEVEL_30);
    const b = startNewGame({ gameType: GAME_TYPE.Level, levelSetupIndex: 29 });
    const same = a.mapTiles.filter((t, i) => t.terrainUp === b.mapTiles[i]!.terrainUp).length;
    expect(same).toBeLessThan(a.mapTiles.length * 0.6);
  });

  it('the random stream sits on the advanced state, not on the seed', () => {
    const st = startNewGame(LEVEL_30);
    expect(st.rng.getState()).not.toEqual([...st.header.random]);
  });

  it('the clocks are at 0 — the reset runs AFTER the founding', () => {
    const st = startNewGame(LEVEL_30);
    expect(st.gameTick).toBe(0);
    expect(st.header.statTimer).toBe(0);
    expect(st.header.resourceTimer).toBe(0);
    expect(st.header.playerHistoryIndex).toEqual([0, 0, 0, 0]);
    expect(st.aiPressureAccum).toBe(0);
  });

  it('mission 6 places four finished, occupied military buildings for a non-playing opponent', () => {
    const st = startNewGame({ gameType: GAME_TYPE.Mission, missionSetupIndex: 6 });
    const enemy = st.buildings.filter((b) => b && b.owner === 1);
    expect(enemy).toHaveLength(4);
    expect(enemy.every((b) => !b!.constructing && b!.active && b!.holder)).toBe(true);
    expect(enemy.map((b) => b!.type).sort((a, b) => a - b)).toEqual([0x0b, 0x0b, 0x15, 0x16]);
    expect(st.serfs.filter((s) => s && s.type === 22)).toHaveLength(24);
    // The opponent is not a participant: it carries 'castle founded' but not the active bit.
    expect(st.players[1]!.flags & 1).toBe(1);
    expect(st.players[1]!.active).toBe(false);
    expect(st.players[0]!.knightOccupation).toEqual([0x40, 0x40, 0x40, 0x40]);
    // The building score keeps its start value — the game start does not touch it again.
    expect(st.players[1]!.totalBuildingScore).toBe(0x1d);
    // The land score is a START value: the branch sets 7 (the seven tiles it rewrites itself), and
    // the territory recolour of the four buildings counts on incrementally. Both must agree in the
    // end — that is the evidence the 7 is not accidental.
    const owned = st.mapTiles.filter((t) => t.owner === 2).length;
    expect(st.players[1]!.totalLandScore).toBe(owned);
    expect(owned).toBeGreaterThan(7);
  });

  it('the scenario tiles belong to player 1', () => {
    const st = startNewGame({ gameType: GAME_TYPE.Mission, missionSetupIndex: 6 });
    expect(st.mapTiles.filter((t) => t.owner === 2).length).toBeGreaterThan(100);
    expect(st.mapTiles.filter((t) => t.owner === 1)).toHaveLength(0);
  });
});

describe('the header carries the seed of a free map', () => {
  // Without these two fields a free map is not reproducible. The original stores them for
  // `gameType > 1` (`gs+0x362`/`gs+0x364` -> `.DS`@136/@138).
  const seed: [number, number, number] = [0x4b6b, 0x29d7, 0x21c3];

  it('free game: the raw seed and the world size are in the header', () => {
    const st = startNewGame({ gameType: 2, seed, mapSize: 3, menuPlayers: [[12, 20, 40, 30]] });
    expect(st.header.mapSeed).toEqual(seed);
    expect(st.header.mapSizeChoice).toBe(3);
    // RAW means: before the XOR mask — the RNG start value next to it is the masked one.
    expect(st.header.random).not.toEqual(seed);
  });

  it('level/mission: both fields stay empty, as in the original', () => {
    // For `gameType <= 1` the seed comes from the setup record; the original neither writes nor
    // reloads `gs+0x364` there (`jb 0x48010` @0x47f60).
    const st = startNewGame({ gameType: 0, levelSetupIndex: 1 });
    expect(st.header.mapSeed).toBeUndefined();
    expect(st.header.mapSizeChoice).toBeUndefined();
  });
});

describe('resetGameClocks', () => {
  it('resets all ring heads and clocks to 0', () => {
    const st = startNewGame(LEVEL_30);
    st.gameTick = 4711;
    st.header.statTimer = 9;
    st.header.resourceHistoryIndex = 5;
    st.aiPressureAccum = 3;
    resetGameClocks(st);
    expect(st.gameTick).toBe(0);
    expect(st.header.statTimer).toBe(0);
    expect(st.header.resourceHistoryIndex).toBe(0);
    expect(st.aiPressureAccum).toBe(0);
  });
});

describe('createEmptyPlayer', () => {
  it('returns a record in which every numeric field is 0 (the `memset`)', () => {
    const p = createEmptyPlayer(2);
    expect(p.slot).toBe(2);
    for (const [key, value] of Object.entries(p)) {
      if (key === 'slot') continue;
      if (typeof value === 'number') expect(value, key).toBe(0);
      if (typeof value === 'boolean') expect(value, key).toBe(false);
      if (Array.isArray(value)) {
        for (const v of value.flat(2)) {
          if (typeof v === 'number') expect(v, key).toBe(0);
        }
      }
    }
  });
});
