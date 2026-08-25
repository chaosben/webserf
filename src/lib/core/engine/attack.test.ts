import { describe, it, expect } from 'vitest';
import {
  ATTACKABLE_CODED_TYPES,
  ATTACK_COLLECT_RINGS,
  ATTACK_COUNT_LIMIT,
  ATTACK_GARRISON_RESERVE,
  ATTACK_RING_SIDES,
  attackCountDecrement,
  attackCountIncrement,
  attackCountPreset,
  attackReserveBase,
  attackSuggestionCap,
  codedBuildingType,
  dispatchAttackers,
  launchAttack,
  ATTACK_SOUND_CONFIRM,
  ATTACK_SOUND_REJECT,
  ATTACK_PREP_SOUND_OPEN,
  ATTACK_PREP_SOUND_REJECT,
  prepareAttack,
} from './attack.js';
import type { Building, GameState, Player, Serf, Tile } from './state.js';
import { mapGeometry, posOf } from './position.js';

function player(fields: Partial<Player> = {}): Player {
  return {
    attackingKnights: [0, 0, 0, 0],
    knightsAttacking: 0,
    totalAttackingKnights: 0,
    ...fields,
  } as unknown as Player;
}

describe('attack — coded type (mask 0xfc)', () => {
  it('a construction site matches no comparison value', () => {
    // Finished hut: 11<<2 = 0x2c, so attackable and an attacker candidate.
    expect(codedBuildingType({ type: 11, constructing: false })).toBe(0x2c);
    expect(ATTACKABLE_CODED_TYPES).toContain(0x2c);
    expect(attackReserveBase(0x2c)).toBe(0);
    // The same hut under construction: bit 7 stays in the mask.
    const site = codedBuildingType({ type: 11, constructing: true });
    expect(site).toBe(0xac);
    expect(ATTACKABLE_CODED_TYPES).not.toContain(site);
    expect(attackReserveBase(site)).toBeNull();
  });

  it('only hut, tower and fortress give up knights — the castle does not', () => {
    expect(attackReserveBase(0x2c)).toBe(0); //  hut
    expect(attackReserveBase(0x54)).toBe(5); //  tower
    expect(attackReserveBase(0x58)).toBe(10); // fortress
    expect(attackReserveBase(0x60)).toBeNull(); // castle — does not join an attack
    // It can be attacked, though.
    expect(ATTACKABLE_CODED_TYPES).toContain(0x60);
  });

  it('suggestion cap per target', () => {
    expect(attackSuggestionCap(0x2c)).toBe(3);
    expect(attackSuggestionCap(0x54)).toBe(6);
    expect(attackSuggestionCap(0x58)).toBe(12);
    expect(attackSuggestionCap(0x60)).toBe(20); // castle
  });
});

describe('attack — mandatory garrison', () => {
  it('15 values, rising monotonically per building with the slider setting', () => {
    expect(ATTACK_GARRISON_RESERVE).toHaveLength(15);
    for (const base of [0, 5, 10]) {
      const row = ATTACK_GARRISON_RESERVE.slice(base, base + 5);
      expect(row[0]).toBe(1); // lowest setting: one always stays
      for (let i = 1; i < 5; i++) expect(row[i]!).toBeGreaterThanOrEqual(row[i - 1]!);
    }
    // The highest setting equals the capacity: hut 3, tower 6, fortress 12.
    expect([4, 9, 14].map((i) => ATTACK_GARRISON_RESERVE[i])).toEqual([3, 6, 12]);
  });
});

describe('attack — shape of the ring walk', () => {
  it('six sides in original order, 32 rings', () => {
    expect(ATTACK_COLLECT_RINGS).toBe(32);
    // Down, Left, UpLeft, Up, Right, DownRight — from the deltas of the loop.
    expect(ATTACK_RING_SIDES).toEqual([2, 3, 4, 5, 0, 1]);
  });
});

describe('attack — the counter buttons of the window', () => {
  it('fewer: stops at 0 and reports whether anything changed', () => {
    const p = player({ knightsAttacking: 2 });
    expect(attackCountDecrement(p)).toBe(true);
    expect(p.knightsAttacking).toBe(1);
    expect(attackCountDecrement(p)).toBe(true);
    expect(p.knightsAttacking).toBe(0);
    expect(attackCountDecrement(p)).toBe(false); // no screen change in the original
    expect(p.knightsAttacking).toBe(0);
  });

  it('more: up to the available knights', () => {
    const p = player({ knightsAttacking: 1, totalAttackingKnights: 3 });
    expect(attackCountIncrement(p)).toBe(true);
    expect(attackCountIncrement(p)).toBe(true);
    expect(p.knightsAttacking).toBe(3);
    expect(attackCountIncrement(p)).toBe(false);
    expect(p.knightsAttacking).toBe(3);
  });

  it('more: additionally capped hard at 100', () => {
    const p = player({ knightsAttacking: ATTACK_COUNT_LIMIT, totalAttackingKnights: 500 });
    expect(attackCountIncrement(p)).toBe(false);
    expect(p.knightsAttacking).toBe(ATTACK_COUNT_LIMIT);
  });

  it('preset n = sum of the first n distance bands', () => {
    const p = player({ attackingKnights: [2, 3, 0, 5] });
    attackCountPreset(p, 1);
    expect(p.knightsAttacking).toBe(2);
    attackCountPreset(p, 2);
    expect(p.knightsAttacking).toBe(5);
    attackCountPreset(p, 3);
    expect(p.knightsAttacking).toBe(5);
    attackCountPreset(p, 4);
    expect(p.knightsAttacking).toBe(10);
  });
});

// --- Sending them off: launchAttack (@0x3169c) + dispatchAttackers (@0x316f3) --------------------

const geo = mapGeometry(3);

function tile(over: Record<string, number> = {}): Tile {
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

/** Garrison knight. `col/row` is the building tile — knights inside carry its position. */
function knight(index: number, rank: number, next: number): Serf {
  return {
    index,
    type: 22 + rank,
    owner: 0,
    state: 70,
    col: 10,
    row: 10,
    counter: 0,
    tick: 0,
    animation: 0,
    // Union: `serf[0xe]` (index 3) = next knight of the garrison list.
    stateData: [0, 0, 0, next & 0xff, (next >> 8) & 0xff],
  } as unknown as Serf;
}

/**
 * Setup: target = foreign hut @(30,30) (in service, threat level 3). One own hut @(10,10) with
 * `ranks.length` knights in its garrison; mandatory garrison via `knightOccupation[0]`.
 */
function launchState(ranks: readonly number[], occupation = 0): {
  state: GameState;
  player: Player;
  src: Building;
  target: Building;
} {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  const srcPos = posOf(10, 10, geo);
  mapTiles[srcPos] = tile({ owner: 1, object: 2, objIndex: 1 });
  const tgtPos = posOf(30, 30, geo);
  mapTiles[tgtPos] = tile({ owner: 2, object: 2, objIndex: 2 });

  const serfs: (Serf | null)[] = [null];
  ranks.forEach((r, i) => serfs.push(knight(i + 1, r, i + 2 <= ranks.length ? i + 2 : 0)));

  const src = {
    index: 1,
    type: 11, // hut
    owner: 0,
    constructing: false,
    active: true,
    burning: false,
    threatLevel: 0,
    col: 10,
    row: 10,
    firstKnight: ranks.length > 0 ? 1 : 0,
    progress: 0,
    stock: [{ available: ranks.length, requested: 0 }, { available: 0, requested: 0 }],
  } as unknown as Building;
  const target = {
    index: 2,
    type: 11,
    owner: 1,
    constructing: false,
    active: true,
    burning: false,
    threatLevel: 3,
    col: 30,
    row: 30,
    firstKnight: 0,
    progress: 0,
    stock: [{ available: 1, requested: 0 }, { available: 0, requested: 0 }],
  } as unknown as Building;

  const player = {
    slot: 0,
    index: 0,
    flags: 0,
    knightOccupation: [occupation, 0, 0, 0],
    attackingBuildings: [1],
    attackingBuildingCount: 1,
    attackingKnights: [0, 0, 0, 0],
    totalAttackingKnights: 0,
    buildingAttacked: 2,
    knightsAttacking: 0,
  } as unknown as Player;

  const state = {
    geo,
    gameTick: 1000,
    mapTiles,
    buildings: [null, src, target],
    serfs,
    players: [player, null, null, null],
  } as unknown as GameState;
  return { state, player, src, target };
}

describe('attack — launching an attack (attack_launch @0x3169c)', () => {
  it('with no knights chosen: error sound, the window stays OPEN', () => {
    const { state, player } = launchState([0, 0, 0, 0]);
    player.knightsAttacking = 0;
    const res = launchAttack(state, player);
    // @0x316b7: `mov $0x4` + play_ui_sound, then `ret` BEFORE the closing jump to 0x285ae.
    expect(res).toEqual({ sound: ATTACK_SOUND_REJECT, closePopup: false, dispatched: 0 });
  });

  it('with no attacking building: close SILENTLY, no dispatch', () => {
    const { state, player } = launchState([0, 0]);
    player.knightsAttacking = 2;
    player.attackingBuildingCount = 0; // `subw $1` on 0, so `jb` skips the call
    const res = launchAttack(state, player);
    // `jb 0x316ee` @0x316d9 jumps over both the enqueue @0x316e4 and the dispatch @0x316e9.
    expect(res).toEqual({ sound: null, closePopup: true, dispatched: 0 });
  });

  it('with knights and an attacking building: success sound', () => {
    const { state, player } = launchState([0, 0, 0, 0]);
    player.knightsAttacking = 1;
    const res = launchAttack(state, player);
    // @0x316db: `mov $0x2` + play_ui_sound, THEN `call 0x316f3` (dispatch), then the closing jump.
    expect(res.sound).toBe(ATTACK_SOUND_CONFIRM);
    expect(res.closePopup).toBe(true);
  });
});

describe('attack — sending knights off (dispatchAttackers @0x316f3)', () => {
  it('sends only the surplus above the mandatory garrison', () => {
    // Four knights, setting 0 -> reserve = ATTACK_GARRISON_RESERVE[0] = 1 -> surplus 3.
    const { state, player, src } = launchState([0, 0, 0, 0]);
    player.knightsAttacking = 99;
    expect(dispatchAttackers(state, player)).toBe(3);
    expect(src.stock[0].available).toBe(1);
    expect(player.knightsAttacking).toBe(96);
  });

  it('stops at the chosen count — even in the middle of a building', () => {
    const { state, player, src } = launchState([0, 0, 0, 0]);
    player.knightsAttacking = 2;
    expect(dispatchAttackers(state, player)).toBe(2);
    expect(player.knightsAttacking).toBe(0); // @0x31d12: `subw $1` ⇒ 0 ⇒ `ret`
    expect(src.stock[0].available).toBe(2); // one knight of the surplus stayed
  });

  it('a higher mandatory garrison releases fewer', () => {
    // Setting 4 -> reserve = ATTACK_GARRISON_RESERVE[4] = 3 -> surplus 1.
    const { state, player } = launchState([0, 0, 0, 0], 4);
    player.knightsAttacking = 99;
    expect(dispatchAttackers(state, player)).toBe(1);
  });

  it('default (flags bit 1 clear): the WEAKEST go', () => {
    const { state, player, src } = launchState([4, 0, 2]); // reserve 1 -> two go
    player.knightsAttacking = 99;
    dispatchAttackers(state, player);
    // The strongest stays (rank 4, serf 1); ranks 0 and 2 are sent off.
    expect(src.firstKnight).toBe(1);
    expect(state.serfs[2]!.state).toBe(0x41);
    expect(state.serfs[3]!.state).toBe(0x41);
    expect(state.serfs[1]!.state).toBe(70);
  });

  it('flags bit 1 set: the STRONGEST go', () => {
    const { state, player, src } = launchState([4, 0, 2]);
    player.flags |= 2;
    player.knightsAttacking = 99;
    dispatchAttackers(state, player);
    // The weakest stays (rank 0, serf 2).
    expect(src.firstKnight).toBe(2);
    expect(state.serfs[1]!.state).toBe(0x41);
    expect(state.serfs[3]!.state).toBe(0x41);
    expect(state.serfs[2]!.state).toBe(70);
  });

  it('sets state 65 with follow-up state 53 and the target delta', () => {
    const { state, player, target } = launchState([0, 0]);
    player.knightsAttacking = 1;
    dispatchAttackers(state, player);
    const gone = state.serfs.find((s) => s?.state === 0x41)!;
    expect(gone.stateData[4]).toBe(0x35); // serf[0xf] = 53 KnightFreeWalking
    expect(gone.stateData[2]).toBe(0); //    serf[0xd] = 0
    expect(gone.stateData[3]).toBe(0); //    serf[0xe] = 0 (list link overwritten)
    // The knight still stands in the building (10,10); target (30,30) -> delta (+20,+20).
    expect((gone.stateData[0] << 24) >> 24).toBe(20);
    expect((gone.stateData[1] << 24) >> 24).toBe(20);
    expect(target.progress & 1).toBe(1); // target[0xc] bit 0 — 'is under attack'
  });

  it('the target delta is computed the short way across the map edge', () => {
    const { state, player, target } = launchState([0, 0]);
    target.col = 2; // from col 10, +56 is the long and -8 the short way (64 columns)
    player.knightsAttacking = 1;
    dispatchAttackers(state, player);
    const gone = state.serfs.find((s) => s?.state === 0x41)!;
    expect((gone.stateData[0] << 24) >> 24).toBe(-8);
  });

  it('the castle sends no knights', () => {
    const { state, player, src } = launchState([0, 0, 0, 0]);
    (src as { type: number }).type = 24; // castle -> coded 0x60 -> no reserve base
    player.knightsAttacking = 99;
    expect(dispatchAttackers(state, player)).toBe(0);
  });

  it('burning buildings and ones blocked by a foreign serf stay out', () => {
    {
      const { state, player, src } = launchState([0, 0, 0, 0]);
      (src as { burning: boolean }).burning = true;
      player.knightsAttacking = 99;
      expect(dispatchAttackers(state, player)).toBe(0);
    }
    {
      // A foreign serf on the flag tile (DownRight of the building) blocks the exit.
      const { state, player } = launchState([0, 0, 0, 0]);
      const flag = posOf(11, 11, geo);
      state.mapTiles[flag] = tile({ serfIndex: 9 });
      state.serfs[9] = { index: 9, type: 0, owner: 1, stateData: [0, 0, 0, 0, 0] } as unknown as Serf;
      player.knightsAttacking = 99;
      expect(dispatchAttackers(state, player)).toBe(0);
    }
  });

  it('target preconditions: not in service / threat level < 3 -> nothing', () => {
    {
      const { state, player, target } = launchState([0, 0, 0, 0]);
      (target as { active: boolean }).active = false;
      player.knightsAttacking = 99;
      expect(dispatchAttackers(state, player)).toBe(0);
    }
    {
      const { state, player, target } = launchState([0, 0, 0, 0]);
      (target as { threatLevel: number }).threatLevel = 2;
      player.knightsAttacking = 99;
      expect(dispatchAttackers(state, player)).toBe(0);
    }
  });
});

// --- Opening the window: prepareAttack (@0x2a43d ff., the map special click) --------------------

describe('attack — opening the window (prepareAttack)', () => {
  /**
   * Place an own tile within range. RING 2, not ring 1: the search starts at spiral index 7
   * (`ATTACK_RANGE_FIRST_SPIRAL`) and therefore skips the target tile AND its six direct
   * neighbours — a tile at (31,30) would never be found.
   */
  function withLandNearTarget(state: GameState): void {
    const near = posOf(32, 30, geo); // spiral entry [2,0]
    const t = state.mapTiles[near];
    if (t !== undefined) (t as { owner: number }).owner = 1;
  }

  it('a wrong building type is SILENT — bare `ret` @0x2a459', () => {
    const { state, player, target } = launchState([0]);
    (target as { type: number }).type = 12; // farm: none of the four comparison values
    const res = prepareAttack(state, player, target);
    expect(res.ok).toBe(false);
    // The one failure without a sound: the original does not count the click as an attempted action.
    expect(res.sound).toBeNull();
  });

  it('not in service -> sound 4', () => {
    const { state, player, target } = launchState([0]);
    (target as { active: boolean }).active = false;
    const res = prepareAttack(state, player, target);
    expect(res).toMatchObject({ ok: false, reason: 'inactive', sound: ATTACK_PREP_SOUND_REJECT });
  });

  it('threat level != 3 -> sound 4', () => {
    const { state, player, target } = launchState([0]);
    (target as { threatLevel: number }).threatLevel = 1;
    const res = prepareAttack(state, player, target);
    expect(res).toMatchObject({ ok: false, reason: 'threatLevel', sound: ATTACK_PREP_SOUND_REJECT });
  });

  it('no own land within range -> sound 4', () => {
    const { state, player, target } = launchState([0]);
    // The own hut is 20 tiles away — outside the 257 spiral positions.
    const res = prepareAttack(state, player, target);
    expect(res).toMatchObject({ ok: false, reason: 'outOfRange', sound: ATTACK_PREP_SOUND_REJECT });
  });

  it('success -> sound 8 (control hit), NOT the execution sound 2', () => {
    const { state, player, target } = launchState([2, 2, 1]);
    withLandNearTarget(state);
    const res = prepareAttack(state, player, target);
    expect(res.ok).toBe(true);
    expect(res.sound).toBe(ATTACK_PREP_SOUND_OPEN);
    expect(ATTACK_PREP_SOUND_OPEN).not.toBe(ATTACK_SOUND_CONFIRM);
    expect(player.buildingAttacked).toBe(target.index);
  });

  it('the two sounds are the surveyed 4 and 8', () => {
    expect(ATTACK_PREP_SOUND_REJECT).toBe(ATTACK_SOUND_REJECT);
    expect(ATTACK_PREP_SOUND_OPEN).toBe(8);
  });
});
