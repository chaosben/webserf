import { describe, it, expect } from 'vitest';
import {
  defendingHut,
  defendingCastle,
  knightRank,
  knightStrength,
  attackerWinsDuel,
  applyDuelLoss,
  knightPrepareDefending,
  knightDefending,
  knightAttacking,
  knightEngagingBuilding,
  knightOccupyEnemyBuilding,
  knightAttackingVictoryFree,
  knightDefendingVictoryFree,
  knightAttackingFreeWait,
  knightFreeWalking,
  knightEngageAttackingFree,
  knightEngageAttackingFreeJoin,
  knightPrepareDefendingFree,
  knightPrepareAttackingFree,
  knightLeaveForWalkToFight,
  knightLeaveForFight,
} from './serf-military.js';
import type { GameState, Serf, Player, Building, Flag, Tile } from './state.js';
import { mapGeometry, posOf, colOf, rowOf, neighbor, Direction } from './position.js';
import { COUNTER_FROM_ANIMATION } from './serf-tables.js';
import { SERF_TYPE_NAMES } from '../save-parser.js';

/**
 * Tests for the defending garrison (`serf-military.ts`, `FUN_0001fc40` family). The deterministic part
 * (tick idle, `+6000` re-arm, rank 4 no-op) is additionally verified against save-game data; promotion
 * is RNG driven (see module header) and checked here with an RNG stub.
 */
function mkPlayer(over: Partial<{ serfCount: number[]; militaryScore: number }> = {}): Player {
  return {
    slot: 0,
    serfCount: over.serfCount ?? new Array(27).fill(0),
    totalMilitaryScore: over.militaryScore ?? 0,
  } as unknown as Player;
}

function mkState(over: {
  gameTick?: number;
  rngValues?: number[];
  players?: (Player | null)[];
}): { state: GameState; rngCalls: () => number } {
  const vals = over.rngValues ?? [];
  let i = 0;
  const rng = {
    next: () => {
      const v = i < vals.length ? vals[i] : 0xffff; // default: never promote (0xffff >= every threshold)
      i++;
      return v;
    },
  };
  const state = {
    gameTick: over.gameTick ?? 100,
    rng,
    players: over.players ?? [mkPlayer(), null, null, null],
  } as unknown as GameState;
  return { state, rngCalls: () => i };
}

function mkKnight(over: Partial<{ type: number; owner: number; counter: number; tick: number }> = {}): Serf {
  return {
    index: 1,
    type: over.type ?? 22, // Knight0
    typeName: 'Knight0',
    owner: over.owner ?? 0,
    counter: over.counter ?? 100,
    tick: over.tick ?? 100,
  } as unknown as Serf;
}

describe('serf-military — defending garrison (FUN_0001fc40)', () => {
  it('rank 4 (Knight4) is a no-op: counter/tick/type unchanged', () => {
    const { state, rngCalls } = mkState({ gameTick: 500 });
    const s = mkKnight({ type: 26, counter: 6000, tick: 16048 }); // like fixture #232
    defendingHut(state, s);
    expect(s.counter).toBe(6000);
    expect(s.tick).toBe(16048); // NOT updated (bare ret)
    expect(s.type).toBe(26);
    expect(rngCalls()).toBe(0);
  });

  it('no underflow: counter -= delta, tick updated, no RNG', () => {
    const { state, rngCalls } = mkState({ gameTick: 150 });
    const s = mkKnight({ type: 22, counter: 100, tick: 100 }); // delta 50 < counter 100
    defendingHut(state, s);
    expect(s.counter).toBe(50);
    expect(s.tick).toBe(150);
    expect(rngCalls()).toBe(0);
  });

  it('underflow without promotion: one +6000 re-arm (-> 5808)', () => {
    const { state, rngCalls } = mkState({ gameTick: 324, rngValues: [0xffff] }); // delta 224
    const s = mkKnight({ type: 24, counter: 32, tick: 100 }); // Knight2, like #165
    defendingHut(state, s);
 // 32 - 224 = 65344 (u16), + 6000 = 5808 (wrap), before 65344 ≥ 0xe890 → done
    expect(s.counter).toBe(5808);
    expect(s.tick).toBe(324);
    expect(s.type).toBe(24); // no promotion
    expect(rngCalls()).toBe(1);
  });

  it('underflow with promotion (RNG < threshold): rank R -> R+1 plus bookkeeping', () => {
    const player = mkPlayer({ serfCount: (() => { const a = new Array(27).fill(0); a[22] = 3; a[23] = 1; return a; })(), militaryScore: 5 });
    const { state } = mkState({ gameTick: 101, rngValues: [0], players: [player, null, null, null] }); // delta 1, rng 0 < 250
    const s = mkKnight({ type: 22, counter: 0, tick: 100 }); // Knight0 → underflow (0 < 1)
    defendingHut(state, s);
    expect(s.type).toBe(23); // Knight1
    expect(s.counter).toBe(6000);
    expect(player.serfCount[22]).toBe(2); // −1
    expect(player.serfCount[23]).toBe(2); // +1
    expect(player.totalMilitaryScore).toBe(6); // +1 (rank 0 → 1<<0)
  });

  it('promotion rank 2 -> 3: militaryScore += 1<<2 = 4, not a flat +1', () => {
    const player = mkPlayer({ serfCount: (() => { const a = new Array(27).fill(0); a[24] = 2; a[25] = 1; return a; })(), militaryScore: 50 });
    const { state } = mkState({ gameTick: 101, rngValues: [0], players: [player, null, null, null] }); // rng 0 < castle rank-2 threshold 250
    const s = mkKnight({ type: 24, counter: 0, tick: 100 }); // Knight2 → underflow
    defendingCastle(state, s);
    expect(s.type).toBe(25); // Knight3
    expect(player.serfCount[24]).toBe(1); // −1
    expect(player.serfCount[25]).toBe(2); // +1
    expect(player.totalMilitaryScore).toBe(54); // +4 = 1<<2, NOT a flat +1
  });

  it('re-arm loops on a large underflow until the u16 wrap (several RNG rolls)', () => {
    const { state, rngCalls } = mkState({ gameTick: 60000 }); // delta 60000, rng default 0xffff (never promote)
    const s = mkKnight({ type: 22, counter: 5, tick: 0 });
    defendingHut(state, s);
 // 5 - 60000 = 5541 (u16); +6000 per round until 'before' ≥ 0xe890 (59536): 5541,11541,…,59541 → 10 rounds
    expect(rngCalls()).toBe(10);
    expect(s.counter).toBe(5); // 59541 + 6000 = 65541 & 0xffff
  });

  it('building type decides the threshold: same RNG, hut differs from castle', () => {
 // Rank 0: hut threshold 250, castle threshold 4000. RNG 3000 -> hut: no promote (3000 >= 250), castle: promote (3000 < 4000).
    const sHut = mkKnight({ type: 22, counter: 0, tick: 100 });
    defendingHut(mkState({ gameTick: 101, rngValues: [3000] }).state, sHut);
    expect(sHut.type).toBe(22); // hut: no promotion

    const sCastle = mkKnight({ type: 22, counter: 0, tick: 100 });
    defendingCastle(mkState({ gameTick: 101, rngValues: [3000], players: [mkPlayer(), null, null, null] }).state, sCastle);
    expect(sCastle.type).toBe(23); // castle: promoted
  });
});

describe('serf-military — fight resolution core (state 45)', () => {
 // Type byte of a knight with rank r and owner o: (22+r)<<2 | o (serf[0] = owner/type/sound byte).
  const typeByte = (rank: number, owner = 0) => (((22 + rank) << 2) | owner) & 0xff;

  it('knightRank: type byte → rank 0..4', () => {
    expect(knightRank(typeByte(0))).toBe(0);
    expect(knightRank(typeByte(4))).toBe(4);
    expect(knightRank(typeByte(2, 1))).toBe(2); // owner bits do not interfere (mask 0x7c)
  });

  it('knightStrength: base 0x400<<rank, home morale 0x1000 -> base (>>16 with 4096)', () => {
 // At home: (0x400<<rank · 0x1000) >> 16 = (0x400<<rank)/16 = 0x40<<rank.
    expect(knightStrength(0, true, 9999)).toBe(0x40); // 1024·4096>>16 = 64
    expect(knightStrength(1, true, 9999)).toBe(0x80); // doubles per rank
    expect(knightStrength(4, true, 9999)).toBe(0x400);
  });

  it('knightStrength: enemy land uses gold morale (base 1024) instead of 4096', () => {
 // (0x400 · 1042) >> 16 = 1067008 >> 16 = 16.
    expect(knightStrength(0, false, 1042)).toBe(16);
 // Rank 2: (0x1000 · 1042) >> 16 = 4268032>>16 = 65.
    expect(knightStrength(2, false, 1042)).toBe(65);
  });

  it('attackerWinsDuel: roll < strA → attacker wins; exact boundaries', () => {
 // strA=64, strB=64 → total=128. roll=(128·rng)>>16.
 // rng chosen so that roll=63 (<64) -> win: 63 = (128*rng)>>16 -> rng approx 63*65536/128 = 32256.
    expect(attackerWinsDuel(64, 64, 32256)).toBe(true); // roll=63 < 64
    expect(attackerWinsDuel(64, 64, 32768)).toBe(false); // roll=64, not < 64 -> defender
    expect(attackerWinsDuel(64, 64, 0)).toBe(true); // roll=0 < 64
    expect(attackerWinsDuel(64, 64, 0xffff)).toBe(false); // roll≈127 ≥ 64
  });

  it('attackerWinsDuel: the stronger knight wins more often (distribution sanity)', () => {
 // strA=256 (rank 2 at home), strB=64 (rank 0 at home), total=320. Median rng (0x8000) → roll=160 ≥ 256? no → attacker wins.
    expect(attackerWinsDuel(256, 64, 0x8000)).toBe(true);
    let wins = 0;
    for (let r = 0; r < 65536; r += 256) if (attackerWinsDuel(256, 64, r)) wins++;
    expect(wins / 256).toBeGreaterThan(0.75); // ~ strA/total = 256/320 = 0.8
  });

  it('applyDuelLoss: militaryScore −= 1<<loserRank, serfCount[loserRank+22] −= 1', () => {
    const sc = new Array(27).fill(0);
    sc[22] = 5; // Knight0
    sc[24] = 3; // Knight2
    const p = { totalMilitaryScore: 100, serfCount: sc } as unknown as Player;
    applyDuelLoss(p, 0);
    expect(p.totalMilitaryScore).toBe(99); // −(1<<0)
    expect(p.serfCount[22]).toBe(4);
    applyDuelLoss(p, 2);
    expect(p.totalMilitaryScore).toBe(95); // −(1<<2)=−4
    expect(p.serfCount[24]).toBe(2);
  });

  it('applyDuelLoss: is robust for a null player and serfCount==0', () => {
    expect(() => applyDuelLoss(null, 3)).not.toThrow();
    const p = { totalMilitaryScore: 5, serfCount: new Array(27).fill(0) } as unknown as Player;
    applyDuelLoss(p, 0);
    expect(p.totalMilitaryScore).toBe(4); // the score drops anyway
    expect(p.serfCount[22]).toBe(0); // stays 0, does not go negative
  });
});

describe('serf-military — duel path handlers (47/48/49)', () => {
  const mkK = (over: Partial<{ type: number; state: number; counter: number; tick: number; data: number[] }> = {}): Serf =>
    ({
      index: 1,
      type: over.type ?? 22,
      typeName: SERF_TYPE_NAMES[over.type ?? 22],
      owner: 0,
      state: over.state ?? 48,
      counter: over.counter ?? 0,
      tick: over.tick ?? 100,
      col: 4,
      row: 25,
      animation: 0,
      stateData: over.data ?? [0, 0, 0, 0, 0],
    }) as unknown as Serf;

  it('47 KnightPrepareDefending: counter=0, animation=0x54', () => {
    const s = mkK({ state: 47, counter: 999, data: [1, 2, 3, 4, 5] });
    knightPrepareDefending({} as GameState, s);
    expect(s.counter).toBe(0);
    expect(s.animation).toBe(0x54);
  });

  it('49 KnightDefending: no-op', () => {
    const s = mkK({ state: 49, counter: 42, data: [1, 2, 3, 4, 5] });
    const before = JSON.stringify(s);
    knightDefending({} as GameState, s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('48 no underflow: counter -= delta, defender counter in sync, no resolution', () => {
    const defender = mkK({ type: 24, state: 49, counter: 500 });
    const att = mkK({ type: 22, state: 48, counter: 100, tick: 100, data: [0, 0, 0, 5, 0] }); // serf[0xe]=5
    const state = { gameTick: 150, serfs: [null, null, null, null, null, defender], rng: { next: () => 0 } } as unknown as GameState;
    knightAttacking(state, att);
    expect(att.counter).toBe(50); // 100 - 50
    expect(defender.counter).toBe(50); // kept in sync
    expect(att.state).toBe(48); // no resolution
  });

 /**
  * Battle site for the resolution **inside the building**: guard hut @(3,24) with flag @(4,25). Both
  * fighters stand on the flag tile — that is how the original sets up a building fight.
  */
  function duelAtBuilding(): { state: GameState; bld: Building; flagPos: number; bldPos: number } {
    const g = mapGeometry(3);
    const flagPos = posOf(4, 25, g);
    const bldPos = neighbor(flagPos, Direction.UpLeft, g);
    const mapTiles = Array.from({ length: g.tileCount }, () => ({
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
    })) as unknown as GameState['mapTiles'];
    mapTiles[flagPos] = { ...mapTiles[flagPos], object: 1, objIndex: 3, serfIndex: 6, height: 4 };
    mapTiles[bldPos] = { ...mapTiles[bldPos], object: 2, objIndex: 1, serfIndex: 0, height: 6 };
    const bld = {
      index: 1,
      type: 11, // guard hut
      owner: 1,
      constructing: false,
      active: true,
      burning: false,
      hasInventory: false,
      threatLevel: 3,
      col: colOf(bldPos, g),
      row: rowOf(bldPos, g),
      firstKnight: 0,
      progress: 0,
      stock: [
        { available: 1, requested: 1 },
        { available: 0, requested: 0 },
      ],
    } as unknown as Building;
    const state = {
      gameTick: 200,
      geo: g,
      mapTiles,
      buildings: [null, bld],
      serfs: [null, null, null, null, null, null],
      players: [null, null, null, null],
      rng: { next: () => 0 },
    } as unknown as GameState;
    return { state, bld, flagPos, bldPos };
  }

  it('48 resolution, attacker loses: attacker -> Dead(27)+51, defender walks back into the building', () => {
    const { state, flagPos, bldPos } = duelAtBuilding();
    const defender = mkK({ type: 24, state: 49, counter: 0 });
 // stateData[0]=15 → STRIKE_SEQ[15]=0xFF (sequence ends at once); serf[0xc]=0; serf[0xe]=5.
    const att = mkK({ type: 22, state: 48, counter: 0, tick: 100, data: [15, 0, 0, 5, 0] });
    att.index = 6;
    state.serfs[5] = defender;
    state.serfs[6] = att;
    knightAttacking(state, att);

    expect(att.type).toBe(27); // Dead
    expect(att.state).toBe(0x33); // 51 Defeat
    expect(att.counter).toBe(0xff);

 // The victorious defender enters: anim = height delta(+2) + 0x28, counter = walk duration, state 4.
    expect(defender.state).toBe(4);
    expect(defender.stateData[0]).toBe(0xff);
    expect(defender.animation).toBe(0x2a);
    expect(defender.counter).toBe(COUNTER_FROM_ANIMATION[0x2a]);
    expect([defender.col, defender.row]).toEqual([colOf(bldPos, state.geo), rowOf(bldPos, state.geo)]);
    expect(state.mapTiles[bldPos].serfIndex).toBe(defender.index);
 // The source tile is NOT cleared — the dead attacker lies there.
    expect(state.mapTiles[flagPos].serfIndex).toBe(6);
  });

  it('48 resolution, attacker wins: defender -> Dead(27), attacker -> 50, `bld[8] -= 1`', () => {
    const { state, bld } = duelAtBuilding();
    const defender = mkK({ type: 24, state: 49, counter: 0 });
    const att = mkK({ type: 22, state: 48, counter: 0, tick: 100, data: [15, 1, 0, 5, 0] }); // serf[0xc]=1
    att.index = 6;
    state.serfs[5] = defender;
    state.serfs[6] = att;
    knightAttacking(state, att);

    expect(defender.type).toBe(27); // Dead
    expect(att.state).toBe(0x32); // 50 Victory
    expect(att.animation).toBe(0xa8);
    expect(att.counter).toBe(0);
 // Deregistering the fallen defender: 0x11 - 1 = 0x10 => requested 1 -> 0.
    expect(bld.stock[0]).toEqual({ available: 1, requested: 0 });
  });

  it('48 victory at an inventory building leaves `bld[8]` alone', () => {
    const { state, bld } = duelAtBuilding();
    (bld as { hasInventory: boolean }).hasInventory = true;
    const defender = mkK({ type: 24, state: 49, counter: 0 });
    const att = mkK({ type: 22, state: 48, counter: 0, tick: 100, data: [15, 1, 0, 5, 0] });
    att.index = 6;
    state.serfs[5] = defender;
    state.serfs[6] = att;
    knightAttacking(state, att);
    expect(bld.stock[0]).toEqual({ available: 1, requested: 1 });
  });
});

/**
 * Occupation — `knightEngagingBuilding` (44) + `knightOccupyEnemyBuilding` (52). The core
 * is byte-verified against SAVE8→SAVE9 (bld#23 @(27,54): owner 1→0, garrison 3→1, P0 building_score +3).
 */
describe('occupation 44/52 (KnightEngagingBuilding / KnightOccupyEnemyBuilding)', () => {
  const geo = mapGeometry(3);

  function mkOccupyState(bldFirstKnight: number) {
    const flagCol = 10,
      flagRow = 10;
    const flagPos = posOf(flagCol, flagRow, geo);
    const bldPos = neighbor(flagPos, Direction.UpLeft, geo); // the building hangs UpLeft off the flag
    const knight = {
      index: 7,
      type: 26,
      owner: 0,
      state: 0x2c,
      counter: 0,
      tick: 0,
      col: flagCol,
      row: flagRow,
      animation: 0,
      stateData: [0, 0, 0, 0, 0],
    } as unknown as Serf;
    const bld = {
      type: 11, // Hut
      owner: 1,
      firstKnight: bldFirstKnight,
      burning: false,
      active: true, // a captured building was the enemy garrison, so it projects territory
      holder: true,
      flag: 3,
      col: colOf(bldPos, geo),
      row: rowOf(bldPos, geo),
      stock: [
        { available: 0, requested: 3 },
        { available: 0, requested: 0 },
      ],
    } as unknown as Building;
 // Full flag fields: occupation calls `cancelTransportOnDelete` (@0x16bac), which walks the
 // resource slots of every flag.
    const flag = {
      index: 3,
      owner: 1,
      paths: new Array(6).fill(false),
      transporters: new Array(6).fill(false),
      length: new Array(6).fill(0),
      otherEndDir: new Array(6).fill(0),
      stockPriority: [0, 0],
      connections: new Array(6).fill(null),
      hasBuilding: true,
      acceptsSerfs: false,
      acceptsResources: false,
      resourceSlots: new Array(8).fill(-1),
      slotDir: new Array(8).fill(-1),
      slotDest: new Array(8).fill(0),
      scheduled: new Array(6).fill(false),
      scheduledSlot: new Array(6).fill(0),
      hasResources: false,
    } as unknown as Flag;
 // `paths`/`height` matter once the branch reaches `demolishBuilding` (castle case).
    const mapTiles = Array.from({ length: geo.cols * geo.rows }, () => ({
      object: 0,
      objIndex: 0,
      serfIndex: 0,
      owner: 0,
      paths: 0,
      height: 4,
      blocked: false,
    }));
    mapTiles[flagPos] = { object: 1, objIndex: 3, serfIndex: 7, owner: 2, paths: 0x10, height: 4, blocked: false };
    mapTiles[bldPos] = { object: 2, objIndex: 5, serfIndex: 0, owner: 2, paths: 0x02, height: 4, blocked: true };
 // `messageTypes`/`messagePositions` are required: the occupation reports to the loser (type 2) and
 // the winner (type 3). The parser supplies the arrays for every player slot.
    const players = [
      { totalBuildingScore: 100, completedBuildingCount: new Array(23).fill(5), flags: 0, messageTypes: [], messagePositions: [], castleCaptureBalance: 0, build: 0 },
      { totalBuildingScore: 200, completedBuildingCount: new Array(23).fill(5), flags: 0, messageTypes: [], messagePositions: [], castleCaptureBalance: 0, build: 0 },
      null,
      null,
    ] as unknown as (Player | null)[];
    const state = {
      gameTick: 100,
      geo,
      players,
      serfs: [null, null, null, null, null, null, null, knight],
      buildings: [null, null, null, null, null, bld],
      flags: [null, null, null, flag],
      inventories: [],
      mapTiles,
 // The castle case runs into the burn-down (`demolishBuilding` -> recolour -> tile loss ->
 // flag teardown) and therefore needs the slot bookkeeping.
      blockMeta: {
        serfs: { recordSize: 16, maxIndex: 8 },
        flags: { recordSize: 70, maxIndex: 4 },
        buildings: { recordSize: 18, maxIndex: 6 },
        inventories: { recordSize: 120, maxIndex: 0 },
      },
    } as unknown as GameState;
    return { state, knight, bld, flag, players, flagPos, bldPos };
  }

  it('44: empty enemy building -> transition into occupation (state 52)', () => {
    const { state, knight } = mkOccupyState(0);
    knightEngagingBuilding(state, knight);
    expect(knight.state).toBe(0x34); // 52
    expect(knight.animation).toBe(0xb3);
    expect(knight.counter).toBe(0x7f);
  });

 // --- 44: defender branch (@0x17fd4) ---

 /** Build a garrison of `n` knights as a singly linked list starting at serf index 20. */
  function withGarrison(st: GameState, bld: Building, n: number): number[] {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const k = 20 + i;
      idx.push(k);
      st.serfs[k] = {
        index: k,
        type: 22 + i,
        owner: 1,
        state: 70,
        counter: 6000,
        animation: 37,
        col: bld.col,
        row: bld.row,
        stateData: [0, 0, 0, i + 1 < n ? 21 + i : 0, 0],
      } as unknown as Serf;
    }
    bld.firstKnight = idx[0] ?? 0;
    return idx;
  }

  it('44: occupied enemy building -> attacker 45/0xa8/counter 0, defender 46 followed by 47', () => {
    const { state, knight, bld } = mkOccupyState(0);
    bld.stock[0] = { available: 1, requested: 0 };
    const g = withGarrison(state, bld, 1);
    knightEngagingBuilding(state, knight);

    expect(knight.state).toBe(0x2d); // 45 KnightPrepareAttacking
    expect(knight.animation).toBe(0xa8);
    expect(knight.counter).toBe(0);
 // `*(u16*)(serf+0xe) = def` — defender index in the union, the high byte overwrites 0xf.
    expect(knight.stateData[3]).toBe(g[0]);
    expect(knight.stateData[4]).toBe(0);

    const def = state.serfs[g[0]!]!;
    expect(def.state).toBe(0x2e); // 46 KnightLeaveForFight
    expect(def.stateData[4]).toBe(0x2f); // follow-up state 47
    expect(bld.firstKnight).toBe(0);
  });

  it('44: `bld[8] -= 0xf` — available down AND requested up (a replacement is requested)', () => {
    const { state, knight, bld } = mkOccupyState(0);
    bld.stock[0] = { available: 1, requested: 0 }; // Byte 0x10
    withGarrison(state, bld, 1);
    knightEngagingBuilding(state, knight);
    expect(bld.stock[0]).toEqual({ available: 0, requested: 1 }); // 0x10 − 0xf = 0x01
  });

  it('44: the LAST knight of the chain goes, not the head and not by rank', () => {
    const { state, knight, bld } = mkOccupyState(0);
    bld.stock[0] = { available: 3, requested: 0 };
    const g = withGarrison(state, bld, 3); // 20 (K0) → 21 (K1) → 22 (K2)
    knightEngagingBuilding(state, knight);
    const last = g[2]!;
    expect(state.serfs[last]!.state).toBe(0x2e); // the last one fights
    expect(state.serfs[g[0]!]!.state).toBe(70); // the head stays on guard
    expect(bld.firstKnight).toBe(g[0]); // head unchanged
 // the predecessor now points at 0.
    expect(state.serfs[g[1]!]!.stateData[3]).toBe(0);
  });

  it('44: the defender is notified only for the FIRST attacker (progress bit 0)', () => {
    const { state, knight, bld, players, bldPos } = mkOccupyState(0);
    const defender = players[1] as unknown as Player;
    defender.flags = 0;
    (defender as { messageTypes: number[] }).messageTypes = [];
    (defender as { messagePositions: number[] }).messagePositions = [];
    bld.progress = 1; // dispatch signal is set
    bld.stock[0] = { available: 2, requested: 0 };
    withGarrison(state, bld, 2);

    knightEngagingBuilding(state, knight);
    expect(bld.progress & 1).toBe(0); // consumed
    expect(defender.messageTypes).toEqual([1]); // ((owner 0 & 3) << 5) + 1
    expect(defender.messagePositions).toEqual([bldPos]);
    expect(defender.flags & 8).toBe(8); // wake-up flag, bit 3

 // A second attacker produces NO further message.
    const knight2 = { ...knight, index: 8, state: 0x2c, counter: 0, tick: 0 } as unknown as Serf;
    state.serfs[8] = knight2;
    knightEngagingBuilding(state, knight2);
    expect(defender.messageTypes).toEqual([1]);
  });

  it('44: an inventory building lowers player[0x18c] instead', () => {
    const { state, knight, bld, players } = mkOccupyState(0);
    (bld as { hasInventory: boolean }).hasInventory = true;
    (players[1] as unknown as Player).knightMenuCounter = 7;
    bld.stock[0] = { available: 1, requested: 0 };
    withGarrison(state, bld, 1);
    knightEngagingBuilding(state, knight);
    expect((players[1] as unknown as Player).knightMenuCounter).toBe(6);
    expect(bld.stock[0]).toEqual({ available: 1, requested: 0 }); // unchanged
  });

  it('46: the defender steps out — the target tile is NOT occupied (both fight on one tile)', () => {
    const { state, knight, bld, flagPos, bldPos } = mkOccupyState(0);
    bld.stock[0] = { available: 1, requested: 0 };
    const g = withGarrison(state, bld, 1);
    knightEngagingBuilding(state, knight);
    const def = state.serfs[g[0]!]!;

    knightLeaveForFight(state, def);
    expect(def.state).toBe(5); // LeavingBuilding, follow-up state 47 waits in 0xf
    expect(def.stateData[4]).toBe(0x2f);
    expect(state.mapTiles[bldPos].serfIndex).toBe(0); // own tile cleared
    expect(state.mapTiles[flagPos].serfIndex).toBe(7); // attacker stays registered
    expect([def.col, def.row]).toEqual([colOf(flagPos, geo), rowOf(flagPos, geo)]);
  });

  it('46: own tile blocked → no effect (NO waiting animation 0x52)', () => {
    const { state, knight, bld, bldPos } = mkOccupyState(0);
    bld.stock[0] = { available: 1, requested: 0 };
    const g = withGarrison(state, bld, 1);
    knightEngagingBuilding(state, knight);
    const def = state.serfs[g[0]!]!;
    state.mapTiles[bldPos].serfIndex = 999; // foreign serf on the building tile
    def.animation = 37;
    knightLeaveForFight(state, def);
    expect(def.state).toBe(0x2e); // stays 46
    expect(def.animation).toBe(37); // unchanged — no 0x52
  });

  it('52: score transfer + owner flip + garrison=1 + winner moves in (state 4)', () => {
    const { state, knight, bld, flag, players, flagPos, bldPos } = mkOccupyState(0);
    knightOccupyEnemyBuilding(state, knight);

 // score transfer (BUILDING_SCORE[11]=3)
    expect(players[1]!.totalBuildingScore).toBe(197); // old owner −3
    expect(players[0]!.totalBuildingScore).toBe(103); // new owner +3
    expect(players[1]!.completedBuildingCount[10]).toBe(4); // type 11 → index 10, −1
    expect(players[0]!.completedBuildingCount[10]).toBe(6); // +1

 // owner flip on building and flag, type unchanged, garrison marker building+8 = 1
    expect(bld.owner).toBe(0);
    expect(bld.type).toBe(11);
    expect(flag.owner).toBe(0);
    expect(bld.stock[0]).toEqual({ available: 0, requested: 1 });

  // the winner moves in
    expect(knight.state).toBe(4); // EnteringBuilding
    expect(knight.col).toBe(colOf(bldPos, geo));
    expect(knight.row).toBe(rowOf(bldPos, geo));
    expect(state.mapTiles[bldPos].serfIndex).toBe(7);
    expect(state.mapTiles[flagPos].serfIndex).toBe(0);
    expect(knight.stateData[0]).toBe(0xff);
  });

  it('52: building still garrisoned -> back to 44, no transfer', () => {
    const { state, knight, bld, players } = mkOccupyState(42);
    knightOccupyEnemyBuilding(state, knight);
    expect(knight.state).toBe(0x2c); // 44
    expect(bld.owner).toBe(1); // unchanged
    expect(players[0]!.totalBuildingScore).toBe(100); // no transfer
  });

  it('52: capture triggers the territory recolour -> surroundings turn to the winner (owner 1)', () => {
 // After the owner flip the handler calls recomputeTerritory(centre = building col/row). The hut, now
 // owned by P0 and active, projects influence -> core and near ring belong to P0 (tile.owner 1).
    const { state, knight, bldPos } = mkOccupyState(0);
    const bc = colOf(bldPos, geo);
    const br = rowOf(bldPos, geo);
 // Beforehand: a near tile still belongs to the old owner P1 (owner 2), a far one is unclaimed.
    const nearPos = posOf((bc + 1) & geo.colMask, (br + 1) & geo.rowMask, geo);
    const farPos = posOf((bc + 20) & geo.colMask, br, geo);
    state.mapTiles[nearPos].owner = 2;
    state.mapTiles[farPos].owner = 2;

    knightOccupyEnemyBuilding(state, knight);

    expect(state.mapTiles[bldPos].owner).toBe(1); // building tile -> winner P0 (centre)
    expect(state.mapTiles[nearPos].owner).toBe(1); // near ring → P0
    expect(state.mapTiles[farPos].owner).toBe(2); // outside the radius -> unchanged, no recolour
  });

  /**
   * The footprint block @0x16d28..@0x16e46: the building tile and its six hex neighbours go to the
   * winner, and five of them (everything except the building itself and its flag) additionally run
   * through `clearTileRoadsAndFlag` (@0x1725e). Without that half a foreign flag next to the captured
   * building survives on ground that now belongs to the winner — the tile never changes owner, so
   * nothing else would ever remove it.
   */
  describe('52: the footprint teardown (@0x16d28..@0x16e46)', () => {
    /** Plant a free-standing flag of the OLD owner on `pos` and return its slot. */
    function plantFlag(state: GameState, pos: number, index: number): void {
      state.flags[index] = {
        index,
        owner: 1,
        paths: new Array(6).fill(false),
        transporters: new Array(6).fill(false),
        length: new Array(6).fill(0),
        otherEndDir: new Array(6).fill(0),
        stockPriority: [0, 0],
        connections: new Array(6).fill(null),
        hasBuilding: false,
        acceptsSerfs: false,
        acceptsResources: false,
        resourceSlots: new Array(8).fill(-1),
        slotDir: new Array(8).fill(-1),
        slotDest: new Array(8).fill(0),
        scheduled: new Array(6).fill(false),
        scheduledSlot: new Array(6).fill(0),
        hasResources: false,
      } as unknown as Flag;
      state.blockMeta.flags.maxIndex = Math.max(state.blockMeta.flags.maxIndex, index + 1);
      state.mapTiles[pos].object = 1;
      state.mapTiles[pos].objIndex = index;
    }

    it('a foreign flag on a neighbour tile is torn down — the reported case', () => {
      const { state, knight, bldPos } = mkOccupyState(0);
      const leftPos = neighbor(bldPos, Direction.Left, geo);
      plantFlag(state, leftPos, 4);
      knightOccupyEnemyBuilding(state, knight);
      expect(state.flags[4]).toBeNull();
      expect(state.mapTiles[leftPos].object).toBe(0);
      expect(state.mapTiles[leftPos].owner).toBe(1); // and the tile belongs to the winner
    });

    it('all five neighbours outside the flag tile are cleared', () => {
      const { state, knight, bldPos } = mkOccupyState(0);
      const dirs = [Direction.Down, Direction.Left, Direction.Right, Direction.Up, Direction.UpLeft];
      dirs.forEach((d, i) => plantFlag(state, neighbor(bldPos, d, geo), 4 + i));
      knightOccupyEnemyBuilding(state, knight);
      for (let i = 0; i < dirs.length; i++) expect(state.flags[4 + i]).toBeNull();
    });

    it('the captured flag itself SURVIVES and changes owner — the counter direction', () => {
      const { state, knight, flag, flagPos } = mkOccupyState(0);
      knightOccupyEnemyBuilding(state, knight);
      expect(state.flags[3]).toBe(flag);
      expect(state.mapTiles[flagPos].object).toBe(1);
      expect(flag.owner).toBe(0);
    });

    it('a flag one ring further out is out of reach', () => {
      const { state, knight, bldPos } = mkOccupyState(0);
      const farPos = neighbor(neighbor(bldPos, Direction.Left, geo), Direction.Left, geo);
      plantFlag(state, farPos, 4);
      knightOccupyEnemyBuilding(state, knight);
      expect(state.flags[4]).not.toBeNull();
      expect(state.mapTiles[farPos].object).toBe(1);
    });

    it('the owner of all seven footprint tiles goes to the winner', () => {
      const { state, knight, bldPos, flagPos } = mkOccupyState(0);
      knightOccupyEnemyBuilding(state, knight);
      const all = [bldPos, flagPos, ...[
        Direction.Right, Direction.Down, Direction.Left, Direction.UpLeft, Direction.Up,
      ].map((d) => neighbor(bldPos, d, geo))];
      for (const p of all) expect(state.mapTiles[p].owner).toBe(1);
    });
  });

 /**
  * A **castle** is not taken over but burned down (`cmpw $0x60` @0x16b8d). The branch
  * joins the only two writers of the **castle balance** (block 478): `+1` for the winner here,
  * `-1` for the loser in the castle branch of `demolishBuilding`. Both belong to ONE event and
  * affect two different players, which is why they are tested together.
  */
  describe('52: a captured CASTLE (balance pair, block 478)', () => {
    function mkCastleOccupy() {
      const r = mkOccupyState(0);
      r.bld.type = 24; // Castle
      const loser = r.players[1] as unknown as Player;
      const winner = r.players[0] as unknown as Player;
      loser.build = 0xc; // bits 2|3 — "initial serfs created" + "has castle"
      loser.castleBuilderSerf = 0;
      return { ...r, loser, winner };
    }

    it('winner +1 / loser -1, castle burns, `build` bit 3 cleared', () => {
      const { state, knight, bld, loser, winner } = mkCastleOccupy();
      knightOccupyEnemyBuilding(state, knight);
      expect(winner.castleCaptureBalance).toBe(1);
      expect(loser.castleCaptureBalance).toBe(-1);
      expect(bld.burning).toBe(true);
      expect(loser.build & 8).toBe(0); // "has castle" cleared
      expect(loser.build & 4).toBe(4); // bit 2 untouched
    });

    it('burns for 0x1fff instead of 0x7ff ticks', () => {
      const { state, knight, bld } = mkCastleOccupy();
      knightOccupyEnemyBuilding(state, knight);
      expect(bld.firstKnight).toBe(0x1fff);
    });

    it('a hut by contrast is taken over and does not burn at all', () => {
      const { state, knight, bld, loser, winner } = mkCastleOccupy();
      bld.type = 11;
      knightOccupyEnemyBuilding(state, knight);
      expect(bld.burning).toBe(false);
      expect(bld.owner).toBe(0);
      expect(winner.castleCaptureBalance).toBe(0);
      expect(loser.castleCaptureBalance).toBe(0);
    });

    it('both messages: type 2 to the loser (building position), type 3 to the winner', () => {
      const { state, knight, loser, winner, bldPos } = mkCastleOccupy();
      knightOccupyEnemyBuilding(state, knight);
      expect(loser.messageTypes).toEqual([2]); // ((owner 0 & 3) << 5) + 2
      expect(loser.messagePositions).toEqual([bldPos]);
      expect(winner.messageTypes).toEqual([3]);
    });

    it('also throws out the castle builder (block 494)', () => {
      const { state, knight, loser } = mkCastleOccupy();
      const builder = {
        index: 6,
        type: 4,
        owner: 1,
        state: 12,
        counter: 99,
        col: 30,
        row: 30,
        stateData: [1, 0, 0, 0, 0],
      } as unknown as Serf;
      state.serfs[6] = builder;
      loser.castleBuilderSerf = 6;
      knightOccupyEnemyBuilding(state, knight);
      expect(builder.type).toBe(0); // serf+0 &= 0x83
      expect(builder.counter).toBe(0);
      expect(builder.state).toBe(28); // not on his own tile -> EscapeBuilding
      expect(builder.stateData[0]).toBe(0);
    });

    it('with no builder registered nothing extra happens', () => {
      const { state, knight, loser } = mkCastleOccupy();
      loser.castleBuilderSerf = 0;
      expect(() => knightOccupyEnemyBuilding(state, knight)).not.toThrow();
    });
  });

 /**
  * The second branch of state 52 (`je 0x16852` @0x1680d): the target **already** belongs to the
  * knight — the situation of every attack wave after the first. He moves up to the **absolute**
  * capacity (hut 3 / tower 6 / fortress 12, @0x16876/@0x16882/@0x1688e), otherwise he becomes lost.
  * Bytes and round trip: verified against the original data.
  */
  describe('52: attacker moving up into an own building', () => {
    it('moves up: tile free, bld[8] += 1, state 4, field_0xb = 0xff', () => {
      const { state, knight, bld, flagPos, bldPos } = mkOccupyState(0);
      bld.owner = 0; // already belongs to the knight (the first wave captured it)
      bld.stock[0] = { available: 1, requested: 0 };
      knightOccupyEnemyBuilding(state, knight);
      expect(knight.state).toBe(4);
      expect(bld.stock[0]).toEqual({ available: 1, requested: 1 }); // `addb $0x1,0x8`
      expect(state.mapTiles[flagPos].serfIndex).toBe(0);
      expect(state.mapTiles[bldPos].serfIndex).toBe(7);
      expect(knight.stateData[0]).toBe(0xff);
    });

    it('hut full (3 knights) -> lost (25), garrison unchanged', () => {
      const { state, knight, bld } = mkOccupyState(0);
      bld.owner = 0;
      bld.stock[0] = { available: 2, requested: 1 }; // 2 inside + 1 on the way == capacity 3
      knightOccupyEnemyBuilding(state, knight);
      expect(knight.state).toBe(25);
      expect(knight.counter).toBe(0);
      expect(knight.stateData[0]).toBe(0);
      expect(bld.stock[0]).toEqual({ available: 2, requested: 1 });
    });

    it('an own CASTLE has no capacity -> lost (25)', () => {
      const { state, knight, bld } = mkOccupyState(0);
      bld.owner = 0;
      bld.type = 24;
      bld.stock[0] = { available: 1, requested: 0 };
      knightOccupyEnemyBuilding(state, knight);
      expect(knight.state).toBe(25);
    });

    it('a burning target → lost (25) instead of standing still', () => {
      const { state, knight, bld } = mkOccupyState(0);
      bld.burning = true;
      knightOccupyEnemyBuilding(state, knight);
      expect(knight.state).toBe(25);
      expect(bld.owner).toBe(1); // no capture
    });
  });
});

/**
 * Open-field fight resolution — the `isFree` branch of `knightAttacking` (state 60) plus
 * `knightAttackingVictoryFree` (62) / `knightDefendingVictoryFree` (63) / `knightAttackingFreeWait` (64).
 * Read from the bytes at @0x18802 (open-field branches) + @0x1ceee/0x1cff0/0x1d0cd.
 */
describe('open-field fight resolution 60/62/63/64', () => {
  const geo = mapGeometry(3);
  function mkFreeState(serfsList: (Serf | null)[]) {
    return {
      gameTick: 200,
      geo,
      serfBudget: 100,
      header: { maxSerfIndex: 600 },
      blockMeta: { serfs: { maxIndex: 600 } },
      serfs: serfsList,
      mapTiles: Array.from({ length: geo.cols * geo.rows }, () => ({ serfIndex: 0, owner: 0, object: 0, objIndex: 0 })),
      rng: { next: () => 0 },
    } as unknown as GameState;
  }
  const mkK = (over: Partial<{ index: number; type: number; state: number; counter: number; tick: number; data: number[]; col: number; row: number }>): Serf =>
    ({
      index: over.index ?? 1,
      type: over.type ?? 26,
      typeName: SERF_TYPE_NAMES[over.type ?? 26],
      owner: 0,
      state: over.state ?? 0x3c,
      counter: over.counter ?? 0,
      tick: over.tick ?? 100,
      col: over.col ?? 4,
      row: over.row ?? 25,
      animation: 0,
      stateData: over.data ?? [0, 0, 0, 0, 0],
    }) as unknown as Serf;

  it('60 won (isFree): attacker→62, copies the opponent fight values, defender→Dead', () => {
    const defender = mkK({ index: 5, type: 24, state: 61, data: [0, 0, 7, 8, 9] });
    const att = mkK({ index: 1, type: 26, state: 0x3c, tick: 100, data: [15, 1, 0, 5, 0] }); // seq[15]=0xFF, win=1, opp=5
    const state = mkFreeState([null, att, null, null, null, defender]);
    knightAttacking(state, att);
    expect(att.state).toBe(0x3e); // 62
    expect(att.animation).toBe(0xa8);
    expect([att.stateData[0], att.stateData[1], att.stateData[2]]).toEqual([7, 8, 9]); // opp[0xd..0xf] copied
    expect(defender.type).toBe(27); // Dead
  });

  it('60 lost (isFree): attacker→51+Dead, defender→63 (serf[0xe]=attacker), tile→defender', () => {
    const defender = mkK({ index: 5, type: 24, state: 61 });
    const att = mkK({ index: 1, type: 26, state: 0x3c, tick: 100, col: 10, row: 10, data: [15, 0, 0, 5, 0] }); // win=0, opp=5
    const state = mkFreeState([null, att, null, null, null, defender]);
    const attPos = posOf(10, 10, geo);
    knightAttacking(state, att);
    expect(att.state).toBe(0x33); // 51 Defeat
    expect(att.type).toBe(27); // Dead
    expect(defender.state).toBe(0x3f); // 63
    expect(defender.animation).toBe(0xb4);
    expect(defender.stateData[3] | (defender.stateData[4] << 8)).toBe(1); // defender[0xe] = attacker index
    expect(state.mapTiles[attPos].serfIndex).toBe(5); // tile → defender
  });

  it('62 AttackingVictoryFree: loser freed, →64 (with no queue serf[0xf]=0)', () => {
    const loser = mkK({ index: 5, type: 24, state: 61, counter: 0, tick: 100 });
    const victor = mkK({ index: 1, state: 0x3e, tick: 100, data: [0, 0, 0, 5, 0] }); // serf[0xb]=0, serf[0xe]=5
    const state = mkFreeState([null, victor, null, null, null, loser]);
    knightAttackingVictoryFree(state, victor);
    expect(state.serfs[5]).toBeNull(); // delete_serf
    expect(state.serfBudget).toBe(101);
    expect(victor.stateData[4]).toBe(0); // serf[0xf]=0
    expect(victor.state).toBe(0x40); // 64
    expect(victor.counter).toBe(0x7f);
  });

  it('62 with a queue (serf[0xb] != 0): the next one moves up, serf[0xf]=1', () => {
    const loser = mkK({ index: 5, type: 24, state: 61, counter: 0, tick: 100 });
    const victor = mkK({ index: 1, state: 0x3e, tick: 100, data: [3, 7, 0, 5, 0] }); // serf[0xb]=3, serf[0xc]=7
    const state = mkFreeState([null, victor, null, null, null, loser]);
    knightAttackingVictoryFree(state, victor);
    expect(victor.stateData[0]).toBe(7); // serf[0xb] := old serf[0xc] (moved up)
    expect(victor.stateData[1]).toBe(0); // serf[0xc] := old serf[0xd]
    expect(victor.stateData[4]).toBe(1); // serf[0xf]=1 → another opponent
    expect(victor.state).toBe(0x40);
  });

  it('63 DefendingVictoryFree: loser freed, →53', () => {
    const loser = mkK({ index: 5, type: 26, state: 0x33, counter: 0, tick: 100 });
    const victor = mkK({ index: 1, type: 24, state: 0x3f, tick: 100, data: [0, 0, 9, 5, 0] }); // serf[0xe]=5
    const state = mkFreeState([null, victor, null, null, null, loser]);
    knightDefendingVictoryFree(state, victor);
    expect(state.serfs[5]).toBeNull();
    expect(victor.state).toBe(0x35); // 53
    expect([victor.stateData[2], victor.stateData[3], victor.stateData[4]]).toEqual([0, 0, 0]);
  });

  it('63 is robust: loser already gone (deleted by state 51) -> still -> 53, no double free', () => {
    const victor = mkK({ index: 1, type: 24, state: 0x3f, tick: 100, data: [0, 0, 0, 5, 0] });
    const state = mkFreeState([null, victor, null, null, null, null]); // idx 5 already null
    knightDefendingVictoryFree(state, victor);
    expect(victor.state).toBe(0x35); // 53
    expect(state.serfBudget).toBe(100); // no extra free
  });

  it('64 AttackingFreeWait: serf[0xf]=0 → 25 (Lost); serf[0xf]=1 → 53', () => {
    const a = mkK({ index: 1, state: 0x40, counter: 0, tick: 100, data: [0, 0, 0, 0, 0] });
    knightAttackingFreeWait(mkFreeState([null, a]), a);
    expect(a.state).toBe(0x19); // 25 Lost

    const b = mkK({ index: 1, state: 0x40, counter: 0, tick: 100, data: [0, 0, 0, 0, 1] });
    knightAttackingFreeWait(mkFreeState([null, b]), b);
    expect(b.state).toBe(0x35); // 53
    expect(b.stateData[4]).toBe(0);
  });
});

/**
 * Open-field engage chain — state 53 scan/engage + handshake 54/55/56/57/58/59.
 * Byte-verified against the original data (#101 `53→54` anim 99 data[2]=0; #245 `2→55` data[2]=dir data[3]=101).
 */
describe('open-field engage chain 53–59', () => {
  const geo = mapGeometry(3);
  function mkEngageState(serfsList: (Serf | null)[], players?: (Player | null)[]) {
    const mapTiles = Array.from({ length: geo.cols * geo.rows }, () => ({ serfIndex: 0, owner: 0, object: 0, objIndex: 0, height: 0 }));
    return {
      gameTick: 200,
      geo,
      serfBudget: 100,
      header: { maxSerfIndex: 600 },
      blockMeta: { serfs: { maxIndex: 600 } },
      serfs: serfsList,
      mapTiles,
      flags: [],
      buildings: [],
      players: players ?? [null, null, null, null],
      rng: { next: () => 0 },
    } as unknown as GameState;
  }
  const mkK = (over: Partial<{ index: number; type: number; owner: number; state: number; counter: number; tick: number; data: number[]; col: number; row: number; animation: number }>): Serf =>
    ({
      index: over.index ?? 1,
      type: over.type ?? 26,
      typeName: SERF_TYPE_NAMES[over.type ?? 26],
      owner: over.owner ?? 0,
      state: over.state ?? 0x35,
      counter: over.counter ?? 0,
      tick: over.tick ?? 100,
      col: over.col ?? 10,
      row: over.row ?? 10,
      animation: over.animation ?? 0,
      stateData: over.data ?? [0, 0, 0, 0, 0],
    }) as unknown as Serf;

  it('53 scan engages a walking knight (state 2): scanner→54 (anim 99, data[2]=0), neighbour→55 (data[2]=dir, data[3]=scanner)', () => {
    const scanner = mkK({ index: 1, owner: 0, state: 0x35, col: 10, row: 10 });
    const enemy = mkK({ index: 5, owner: 1, type: 26, state: 2, col: 10, row: 11, data: [7, 8, 0, 0, 0] }); // Down (dir 2)
    const state = mkEngageState([null, scanner, null, null, null, enemy]);
    state.mapTiles[posOf(10, 11, geo)].serfIndex = 5;
    knightFreeWalking(state, scanner);
    expect(scanner.state).toBe(0x36); // 54
    expect(scanner.animation).toBe(99);
    expect(scanner.stateData[2]).toBe(0); // walking-knight variant
    expect(enemy.state).toBe(0x37); // 55
    expect(enemy.stateData[2]).toBe(2); // direction Down
    expect(enemy.stateData[3] | (enemy.stateData[4] << 8)).toBe(1); // nb[0xe] = scanner index
  });

  it('53 scan engages an open-field knight (state 53): scanner data[2]=1, self[0xe:0xf]=nb[0xb:0xc]', () => {
    const scanner = mkK({ index: 1, owner: 0, state: 0x35 });
    const enemy = mkK({ index: 5, owner: 1, state: 0x35, col: 11, row: 10, data: [3, 4, 0, 0, 0] }); // Right (dir 0)
    const state = mkEngageState([null, scanner, null, null, null, enemy]);
    state.mapTiles[posOf(11, 10, geo)].serfIndex = 5;
    knightFreeWalking(state, scanner);
    expect(scanner.state).toBe(0x36); // 54
    expect(scanner.stateData[2]).toBe(1); // open-field variant
    expect(scanner.stateData[3]).toBe(3); // self[0xe] = nb[0xb]
    expect(scanner.stateData[4]).toBe(4); // self[0xf] = nb[0xc]
    expect(enemy.state).toBe(0x37); // 55
  });

  it('53 neighbour with the same owner -> no engage (friend untouched, scanner keeps moving)', () => {
 // flags=8 (destination-reached bit) -> the locomotion (reusing freeWalkingCommon) falls into destReached (knight -> 52).
    const scanner = mkK({ index: 1, owner: 0, type: 26, state: 0x35, counter: 0, tick: 100, data: [0, 0, 0, 0, 8] });
    const friend = mkK({ index: 5, owner: 0, state: 2, col: 11, row: 10 }); // same owner
    const state = mkEngageState([null, scanner, null, null, null, friend]);
    state.mapTiles[posOf(11, 10, geo)].serfIndex = 5;
    state.gameTick = 300; // counter expired → scan and locomotion both run
    knightFreeWalking(state, scanner);
    expect(friend.state).toBe(2); // not engaged (same owner is skipped)
    expect(scanner.state).toBe(52); // moves on → destReached (knight branch KnightOccupyEnemy)
  });

  it('53 with no opponent: locomotion via freeWalkingCommon (destination reached → KnightOccupyEnemy 52)', () => {
    const knight = mkK({ index: 1, owner: 0, type: 26, state: 0x35, counter: 0, tick: 100, data: [0, 0, 0, 0, 8] });
    const state = mkEngageState([null, knight]);
    state.gameTick = 300;
    knightFreeWalking(state, knight);
    expect(knight.state).toBe(52); // destReached (knight branch)
  });

  it('53 engages a walking knight -> his target garrison is booked out (building+8 -= 1)', () => {
    const scanner = mkK({ index: 1, owner: 0, state: 0x35, col: 10, row: 10 });
 // Walking knight (state 2), target flag #3 in serf[0xc] (stateData[1]=3, stateData[2]=0).
    const enemy = mkK({ index: 5, owner: 1, type: 26, state: 2, col: 10, row: 11, data: [0, 3, 0, 0, 0] });
    const state = mkEngageState([null, scanner, null, null, null, enemy]);
    state.mapTiles[posOf(10, 11, geo)].serfIndex = 5;
    const bld = { index: 2, stock: [{ available: 0, requested: 3 }, null] } as unknown as Building;
    const mut = state as unknown as { flags: (Flag | null)[]; buildings: (Building | null)[] };
    mut.buildings = [null, null, bld];
 // Flag #3 with building #2 in direction UpLeft (connections[4]).
    mut.flags = [null, null, null, { index: 3, connections: [null, null, null, null, { kind: 'building', index: 2 }, null] } as unknown as Flag];
    knightFreeWalking(state, scanner);
    expect(enemy.state).toBe(0x37); // 55 (engaged)
    expect(bld.stock[0]).toEqual({ available: 0, requested: 2 }); // garrison 3 → 2
  });

  it('53 engage blocked: the battle site (Left of the opponent) is blocked -> no engage, knight keeps moving', () => {
 // flags=8 -> the locomotion falls straight into destReached (knight -> 52), which exposes the "no engage" case.
    const scanner = mkK({ index: 1, owner: 0, type: 26, state: 0x35, counter: 0, tick: 100, col: 10, row: 10, data: [0, 0, 0, 0, 8] });
    const enemy = mkK({ index: 5, owner: 1, state: 0x35, col: 10, row: 11 }); // open-field knight, Down (dir 2)
    const state = mkEngageState([null, scanner, null, null, null, enemy]);
    state.mapTiles[posOf(10, 11, geo)].serfIndex = 5;
 // Battle site = Left neighbour of the opponent (10,11) -> (9,11): block it.
    state.mapTiles[neighbor(posOf(10, 11, geo), Direction.Left, geo)].blocked = true;
    state.gameTick = 300;
    knightFreeWalking(state, scanner);
    expect(enemy.state).toBe(0x35); // NOT engaged (stays an open-field knight)
    expect(scanner.state).not.toBe(0x36); // the scanner is not the defender (54)
    expect(scanner.state).toBe(52); // moves on instead → destReached
  });

  it('55 -> 56 (anim 0xa7, counter reset on overshoot > 0xbf)', () => {
    const s = mkK({ index: 1, state: 0x37, counter: 0, tick: 100 });
    const state = mkEngageState([null, s]);
    state.gameTick = 400; // delta 300 > 0xbf → underflow deep enough → counter = 0
    knightEngageAttackingFree(state, s);
    expect(s.state).toBe(0x38); // 56
    expect(s.animation).toBe(0xa7);
    expect(s.counter).toBe(0);
  });

  it('56 -> 57 and puts the defender (serf[0xe]) -> 58 with a slope move in the engage direction', () => {
    const defender = mkK({ index: 5, state: 0x36, col: 10, row: 10, data: [0, 0, 0, 0, 0] });
 // serf[0xe]=5 (defender), serf[0xd]=0 (engage direction Right).
    const att = mkK({ index: 1, state: 0x38, counter: 0, tick: 100, data: [0, 0, 0, 5, 0] });
    const state = mkEngageState([null, att, null, null, null, defender]);
    state.mapTiles[posOf(10, 10, geo)].serfIndex = 5;
    state.gameTick = 300; // counter expired
    knightEngageAttackingFreeJoin(state, att);
    expect(att.state).toBe(0x39); // 57
    expect(att.animation).toBe(0xa8);
    expect(defender.state).toBe(0x3a); // 58
 // Slope move: dir 0 (Right) -> defender at (11,10), anim = 4 + 9*0 + height delta(0) = 4.
    expect(defender.col).toBe(11);
    expect(defender.row).toBe(10);
    expect(defender.animation).toBe(4);
    expect(defender.stateData[0]).toBe(0xff); // serf[0xb] -= Δcol(1) → -1 & 0xff
    expect(state.mapTiles[posOf(10, 10, geo)].serfIndex).toBe(0); // old slot cleared
  });

  it('58 -> 59 (counter 0)', () => {
    const s = mkK({ index: 1, state: 0x3a, counter: 0, tick: 100 });
    knightPrepareDefendingFree(mkEngageState([null, s]), s);
    expect(s.state).toBe(0x3b); // 59
    expect(s.counter).toBe(0);
  });

  it('57 waits until the defender is in 59; then attacker→60, defender→61, decideDuel (win + bookkeeping)', () => {
    const p1 = { serfCount: (() => { const a = new Array(27).fill(0); a[22] = 5; return a; })(), totalMilitaryScore: 100, goldMorale: 1024 } as unknown as Player;
    const p0 = { serfCount: new Array(27).fill(0), totalMilitaryScore: 50, goldMorale: 4096 } as unknown as Player;
    const defender = mkK({ index: 5, type: 22, owner: 1, state: 0x3b, col: 10, row: 11 }); // K0, in 59
    const att = mkK({ index: 1, type: 26, owner: 0, state: 0x39, col: 10, row: 10, data: [0, 0, 0, 5, 0] }); // K4, serf[0xe]=5
    const state = mkEngageState([null, att, null, null, null, defender], [p0, p1, null, null]);
    knightPrepareAttackingFree(state, att);
    expect(att.state).toBe(0x3c); // 60
    expect(defender.state).toBe(0x3d); // 61
    expect(att.stateData[1]).toBe(1); // outcome: the attacker wins (K4 4096 vs K0 1024)
    expect(p1.serfCount[22]).toBe(4); // loser bookkeeping: −1
    expect(p1.totalMilitaryScore).toBe(99); // −(1<<0)
  });
});

// --- State 65 KnightLeaveForWalkToFight (@0x24528) --------------------------------------------

describe('serf-military — 65 KnightLeaveForWalkToFight (exit to attack)', () => {
  const g = mapGeometry(3);
  const t = (over: Record<string, number> = {}): Tile =>
    ({
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
    }) as unknown as Tile;

 /** Guard hut @(10,20) h5 with one knight inside; flag tile @(11,21) h6. */
  function s65(opts: { flagSerf?: number; flagOwner?: number; garrison?: number; type?: number } = {}) {
    const mapTiles = Array.from({ length: g.tileCount }, () => t());
    const here = posOf(10, 20, g);
    const flag = posOf(11, 21, g);
    mapTiles[here] = t({ height: 5, object: 2, objIndex: 1, serfIndex: 5 });
    mapTiles[flag] = t({ height: 6, object: 1, objIndex: 1, serfIndex: opts.flagSerf ?? 0 });
    const bld = {
      index: 1,
      type: opts.type ?? 11,
      owner: 0,
      constructing: false,
      active: true,
      burning: false,
      threatLevel: 0,
      col: 10,
      row: 20,
      firstKnight: opts.garrison ?? 0,
      progress: 0,
      stock: [{ available: opts.garrison !== undefined ? 1 : 0, requested: 0 }, { available: 0, requested: 0 }],
    } as unknown as Building;
 // The leaving knight: the union already carries the target delta and follow-up state 53.
    const serf = {
      index: 5,
      type: 24,
      owner: 0,
      state: 65,
      col: 10,
      row: 20,
      counter: 0,
      tick: 900,
      animation: 0,
      stateData: [20, 20, 0, 0, 0x35],
    } as unknown as Serf;
    const serfs: (Serf | null)[] = [null, null, null, null, null, serf];
    if (opts.garrison) serfs[opts.garrison] = { index: opts.garrison, type: 22, owner: 0, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
    if (opts.flagSerf) {
      serfs[opts.flagSerf] = {
        index: opts.flagSerf,
        type: 0,
        owner: opts.flagOwner ?? 0,
        stateData: [0, 0, 0, 0, 0],
      } as unknown as Serf;
    }
    const state = { geo: g, gameTick: 1000, mapTiles, buildings: [null, bld], serfs } as unknown as GameState;
    return { state, serf, bld, here, flag };
  }

  it('free flag tile: exits like state 07, state → 5, follow-up state 53 stays', () => {
    const { state, serf, here, flag } = s65();
    knightLeaveForWalkToFight(state, serf);
    expect(serf.state).toBe(5); // LeavingBuilding — picks 53 out of serf[0xf] afterwards
    expect(serf.stateData[4]).toBe(0x35);
    expect([serf.col, serf.row]).toEqual([11, 21]);
    expect(state.mapTiles[here].serfIndex).toBe(0);
    expect(state.mapTiles[flag].serfIndex).toBe(5);
    expect(serf.animation).toBe(14); // Δh(+1) + 0xd — the same shared block @0x2473b
  });

  it('own serf on the flag: wait (anim 0x52), state stays 65', () => {
    const { state, serf } = s65({ flagSerf: 9, flagOwner: 0 });
    knightLeaveForWalkToFight(state, serf);
    expect(serf.state).toBe(65);
    expect(serf.animation).toBe(0x52);
    expect(serf.counter).toBe(0);
  });

  it('a FOREIGN serf on the flag: back into the garrison (-> 70) instead of waiting', () => {
    const { state, serf, bld } = s65({ flagSerf: 9, flagOwner: 1 });
    knightLeaveForWalkToFight(state, serf);
    expect(serf.state).toBe(70); // DefendingHut (@0x2462a: `mov $0x46`)
    expect(bld.firstKnight).toBe(5); // put at the head of the list
    expect(bld.stock[0].available).toBe(1); // bld[8] += 0x10
    expect(serf.animation).toBe(0); // this branch sets neither animation nor counter
  });

  it('tower/fortress lead back into 71/72', () => {
    for (const [type, want] of [
      [21, 71],
      [22, 72],
    ] as const) {
      const { state, serf } = s65({ flagSerf: 9, flagOwner: 1, type });
      knightLeaveForWalkToFight(state, serf);
      expect(serf.state).toBe(want);
    }
  });

  it('full garrison: no way back, so wait', () => {
 // Guard hut, configured capacity 3: with a full garrison the knight stays outside.
    const { state, serf, bld } = s65({ flagSerf: 9, flagOwner: 1 });
    bld.stock[0] = { available: 3, requested: 0 };
    knightLeaveForWalkToFight(state, serf);
    expect(serf.state).toBe(65);
    expect(serf.animation).toBe(0x52);
    expect(bld.firstKnight).toBe(0);
  });

  it('no military building: state 0 (must not happen in the original)', () => {
    const { state, serf } = s65({ flagSerf: 9, flagOwner: 1, type: 12 }); // Farm
    knightLeaveForWalkToFight(state, serf);
    expect(serf.state).toBe(0);
  });
});
