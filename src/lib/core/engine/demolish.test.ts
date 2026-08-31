import { describe, it, expect } from 'vitest';
import {
  DEMOLISH_GUARD_SPIRAL_LEN,
  canDemolishAtCursor,
  demolishAtCursor,
  demolishOutcomeAt,
  enemyKnightNearby,
} from './demolish.js';
import {
  UI_SOUND_DEMOLISH_BUILDING,
  UI_SOUND_DEMOLISH_FLAG,
  UI_SOUND_REJECT,
  demolishOutcomeSound,
} from '../ui-sound.js';
import { spiralPos } from './spiral.js';
import { mapGeometry, posOf } from './position.js';
import type { Building, GameState, Player, Serf, Tile } from './state.js';

/**
 * `FUN_00048c8a`. Under test is the GUARD; the razing itself (`demolishBuilding`/`demolishFlag`) is
 * only distinguished here by the return value.
 *
 * The sharp case is a military building UNDER CONSTRUCTION: the original's mask `0xfc` leaves bit 7
 * standing, so such a building is unprotected. Reading the three comparison values as a type list
 * silently adds a lock the original does not have.
 */
const geo = mapGeometry(3); // 64x64

function tile(over: Partial<Tile> = {}): Tile {
  return {
    height: 10, terrainUp: 5, terrainDown: 5, object: 0, owner: 1, paths: 0,
    blocked: false, mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0, ...over,
  };
}

function player(over: Partial<Player> = {}): Player {
  return {
    slot: 0, index: 0, active: true, flags: 1, build: 0,
    completedBuildingCount: new Array(23).fill(0),
    incompleteBuildingCount: new Array(23).fill(0),
    ...over,
  } as unknown as Player;
}

function knight(index: number, owner: number, type = 22): Serf {
  return { index, owner, type, state: 70 } as unknown as Serf;
}

/** Map with a building of `type` at (10,10); `constructing` drives the construction bit. */
function withBuilding(type: number, constructing = false): GameState {
  const mapTiles: Tile[] = [];
  for (let i = 0; i < geo.cols * geo.rows; i++) mapTiles.push(tile());
  const st = {
    geo, mapTiles, flags: [null], players: [player()], serfs: [null], inventories: [], gameTick: 0,
    buildings: [null, {
      index: 1, type, owner: 0, burning: false, constructing, col: 10, row: 10, flag: 0,
      stock: [{ available: 0, requested: 0 }, { available: 0, requested: 0 }],
    } as unknown as Building],
    header: { maxBuildingIndex: 2, maxFlagIndex: 1, warehouseLimit: 361, mapGoldTotal: 1000 },
    blockMeta: { buildings: { maxIndex: 2 }, flags: { maxIndex: 1 } },
  } as unknown as GameState;
  const t = st.mapTiles[posOf(10, 10, geo)]!;
  t.object = 2;
  t.objIndex = 1;
  return st;
}

/** Put a knight of `owner` on the `index`-th spiral position around (10,10). */
function putKnight(st: GameState, spiralIndex: number, owner: number): void {
  const idx = (st.serfs as unknown[]).length;
  (st.serfs as unknown[]).push(knight(idx, owner));
  st.mapTiles[spiralPos(posOf(10, 10, geo), spiralIndex, geo)]!.serfIndex = idx;
}

describe('enemyKnightNearby: the guard on demolishing a military building', () => {
  it('probes exactly 127 spiral positions (0..126)', () => {
    expect(DEMOLISH_GUARD_SPIRAL_LEN).toBe(127);
    const pos = posOf(10, 10, geo);

    const inside = withBuilding(11);
    putKnight(inside, 126, 1);
    expect(enemyKnightNearby(inside, pos, 0)).toBe(true);

    const outside = withBuilding(11);
    putKnight(outside, 127, 1);
    expect(enemyKnightNearby(outside, pos, 0)).toBe(false);
  });

  it('sees only FOREIGN knights', () => {
    const pos = posOf(10, 10, geo);
    const own = withBuilding(11);
    putKnight(own, 5, 0); // own knight
    expect(enemyKnightNearby(own, pos, 0)).toBe(false);

    const foe = withBuilding(11);
    putKnight(foe, 5, 1);
    expect(enemyKnightNearby(foe, pos, 0)).toBe(true);
  });

  it('accepts exactly the knight ranks 22..26', () => {
    const pos = posOf(10, 10, geo);
    for (const [type, want] of [[21, false], [22, true], [26, true], [27, false]] as const) {
      const st = withBuilding(11);
      (st.serfs as unknown[]).push(knight(1, 1, type));
      st.mapTiles[spiralPos(pos, 3, geo)]!.serfIndex = 1;
      expect(enemyKnightNearby(st, pos, 0)).toBe(want);
    }
  });
});

describe('canDemolishAtCursor / demolishAtCursor', () => {
  it('allows an ordinary building even with a foreign knight next to it', () => {
    const st = withBuilding(9); // forester, not a military building
    putKnight(st, 3, 1);
    expect(canDemolishAtCursor(st, st.players[0]!, 10, 10)).toBe(true);
  });

  it('locks hut/tower/fortress while a foreign knight is in range', () => {
    for (const type of [11, 21, 22]) {
      const st = withBuilding(type);
      putKnight(st, 3, 1);
      expect(canDemolishAtCursor(st, st.players[0]!, 10, 10)).toBe(false);
      expect(demolishAtCursor(st, st.players[0]!, 10, 10)).toBe('rejected');
      expect(st.buildings[1]!.burning).toBe(false); // truly nothing happened
    }
  });

  it('lets the same types pass UNDER CONSTRUCTION: mask 0xfc keeps bit 7', () => {
    for (const type of [11, 21, 22]) {
      const st = withBuilding(type, true);
      putKnight(st, 3, 1);
      expect(canDemolishAtCursor(st, st.players[0]!, 10, 10)).toBe(true);
    }
  });

  it('rejects an empty tile (cursor kind neither 2 nor 3)', () => {
    const st = withBuilding(11);
    expect(canDemolishAtCursor(st, st.players[0]!, 20, 20)).toBe(false);
    expect(demolishAtCursor(st, st.players[0]!, 20, 20)).toBe('rejected');
  });
});

/**
 * The three sounds hang on the same three branches; the original enqueues them BEFORE the effect
 * (`mov $0x8/$0x4c/$0x4` @0x48ca9/@0x48e62/@0x48ea4). Tested here is the branch-to-sound coupling.
 */
describe('demolishOutcomeAt + sound', () => {
  it('returns the same branch the execution takes, without changing anything', () => {
    const st = withBuilding(9);
    expect(demolishOutcomeAt(st, st.players[0]!, 10, 10)).toBe('building');
    expect(st.buildings[1]!.burning).toBe(false); // free of side effects
    expect(demolishAtCursor(st, st.players[0]!, 10, 10)).toBe('building');
    expect(st.buildings[1]!.burning).toBe(true);
  });

  it('maps the three branches to the three sounds of the original', () => {
    expect(demolishOutcomeSound('flag')).toBe(UI_SOUND_DEMOLISH_FLAG);
    expect(demolishOutcomeSound('building')).toBe(UI_SOUND_DEMOLISH_BUILDING);
    expect(demolishOutcomeSound('rejected')).toBe(UI_SOUND_REJECT);
  });

  it('a locked military razing sounds like a failure, not like a razing', () => {
    const st = withBuilding(11);
    putKnight(st, 3, 1);
    expect(demolishOutcomeSound(demolishOutcomeAt(st, st.players[0]!, 10, 10)))
      .toBe(UI_SOUND_REJECT);
  });
});
