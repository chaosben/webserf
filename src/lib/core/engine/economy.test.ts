import { describe, it, expect } from 'vitest';
import { updateEconomy, playerTick, spawnSerf } from './economy.js';
import type { GameState, Player, Inventory, Building, Serf } from './state.js';

/** Serf reproduction (`economy.ts`), on minimal fixtures. */

function makeInventory(over: Partial<Inventory> = {}): Inventory {
  return {
    index: 0,
    owner: 0,
    resDir: 0,
    resMode: 0,
    serfMode: 0,
    flag: 0,
    building: 1,
    resources: new Array(26).fill(0),
    outQueue: [],
    genericCount: 5,
    serfIndices: new Array(27).fill(0),
    ...over,
  } as Inventory;
}

function makeBuilding(): Building {
  return { index: 1, col: 25, row: 46 } as unknown as Building;
}

function makePlayer(over: Partial<Player> = {}): Player {
  return {
    slot: 0,
    index: 0,
    active: true,
    flags: 0x41, // Bit0 = Reproduktions-Takt an, Bit6 = aktiv
    build: 0xe, // Bit2 = can_spawn
    serfCount: new Array(27).fill(0),
    completedBuildingCount: [],
    incompleteBuildingCount: [],
    toolPriority: [],
    resourceCount: [],
    flagPriority: [],
    inventoryPriority: [],
    knightOccupation: [],
    castleBuilding: 1,
    castleFlag: 0,
    castleInventory: 0,
    lastTick: 0,
    reproductionCounter: 100,
    reproductionReset: 2000,
    serfToKnightRate: 20000,
    serfToKnightCounter: 0,
    attackingBuildingCount: 0,
    totalAttackingKnights: 0,
    buildingAttacked: 0,
    attackingBuildings: [],
    attackingKnights: [],
    currentSett5Item: 0,
    currentSett6Item: 0,
    contSearchAfterNonOptimalFind: 0,
    knightsToSpawn: 0,
    totalBuildingScore: 0,
    totalMilitaryScore: 0,
    castleCaptureBalance: 0,
    analysis: [],
    foodDistribution: [],
    planksDistribution: [],
    steelDistribution: [],
    coalDistribution: [],
    wheatDistribution: [],
    statHistory: [],
    resourceHistory: [],
    ...over,
  } as unknown as Player;
}

/** Minimal GameState: serf 0 reserved, 1 taken, 2 the free high-water slot; one inventory. */
function makeState(player: Player, inv: Inventory, over: Partial<GameState> = {}): GameState {
  const occupied: Serf = { index: 1, state: 0 } as unknown as Serf;
  return {
    header: { maxSerfIndex: 2 } as unknown as GameState['header'],
    gameTick: 0,
    serfBudget: 100,
    players: [player, null, null, null],
    serfs: [null, occupied, null], // index 2 = free slot (high water)
    inventories: [inv],
    buildings: [null, makeBuilding()],
    blockMeta: { serfs: { recordSize: 16, maxIndex: 2 } } as unknown as GameState['blockMeta'],
    ...over,
  } as unknown as GameState;
}

describe('economy: serf reproduction', () => {
  it('creates a generic in IdleInStock on counter underflow', () => {
    const player = makePlayer({ reproductionCounter: 0, lastTick: 0 });
    const inv = makeInventory({ genericCount: 5 });
    const state = makeState(player, inv);
    state.gameTick = 1; // delta 1 > oldCounter 0 -> one reproduction (reset 2000 -> positive at once)

    playerTick(state, player);

    const newSerf = state.serfs[2];
    expect(newSerf).not.toBeNull();
    expect(newSerf!.type).toBe(21); // Generic
    expect(newSerf!.state).toBe(1); // IdleInStock
    expect(newSerf!.owner).toBe(0);
    expect(newSerf!.col).toBe(25);
    expect(newSerf!.row).toBe(46);
    expect(newSerf!.stateData).toEqual([0, 0, 0, 0, 0]); // field_0xe = inventory index 0
    expect(inv.genericCount).toBe(6);
    expect(player.serfCount[21]).toBe(1);
    expect(state.serfBudget).toBe(99);
    expect(state.header.maxSerfIndex).toBe(3); // high water has grown
  });

  it('spawns nothing without budget (serfBudget 0)', () => {
    const player = makePlayer({ reproductionCounter: 0 });
    const inv = makeInventory();
    const state = makeState(player, inv, { serfBudget: 0 });
    state.gameTick = 1;
    playerTick(state, player);
    expect(state.serfs[2]).toBeNull();
    expect(inv.genericCount).toBe(5);
  });

  it('spawns nothing when flags bit 0 is clear', () => {
    const player = makePlayer({ reproductionCounter: 0, flags: 0x40 });
    const state = makeState(player, makeInventory());
    state.gameTick = 1;
    playerTick(state, player);
    expect(state.serfs[2]).toBeNull();
  });

  it('spawns nothing without can_spawn (build bit 2 clear)', () => {
    const player = makePlayer({ reproductionCounter: 0, build: 0x8 });
    const state = makeState(player, makeInventory());
    state.gameTick = 1;
    playerTick(state, player);
    expect(state.serfs[2]).toBeNull();
  });

  it('returns without underflow (the counter stays non-negative)', () => {
    const player = makePlayer({ reproductionCounter: 100, lastTick: 0 });
    const state = makeState(player, makeInventory());
    state.gameTick = 10; // delta 10 <= 100 -> no reproduction
    playerTick(state, player);
    expect(state.serfs[2]).toBeNull();
    expect(player.reproductionCounter).toBe(90);
  });

  it('Ritter-Zweig: konvertiert zu Knight0 bei Schwert+Schild', () => {
    const player = makePlayer({ knightsToSpawn: 2 });
    const inv = makeInventory({ resources: (() => { const r = new Array(26).fill(0); r[24] = 3; r[25] = 3; return r; })() });
    const state = makeState(player, inv);
    const res = spawnSerf(state, player, true);
    expect(res).not.toBeNull();
    // spawnSerf itself does not convert; checked here is only that want_knight picks the inventory
    // holding sword and shield.
    expect(res!.inv.resources[24]).toBe(3);
    expect(res!.serf.type).toBe(21); // spawnSerf creates a generic; playerTick does the conversion
  });

  it('knight branch without weapons: falls back to generic, knights_to_spawn unchanged', () => {
    const player = makePlayer({ knightsToSpawn: 2, reproductionCounter: 0, lastTick: 0 });
    const inv = makeInventory({ genericCount: 5 }); // no weapons
    const state = makeState(player, inv);
    state.gameTick = 1;
    playerTick(state, player);
    expect(state.serfs[2]).not.toBeNull();
    expect(state.serfs[2]!.type).toBe(21); // stays generic
    expect(player.serfCount[22]).toBe(0); // no Knight0
    expect(player.knightsToSpawn).toBe(2); // unchanged (no conversion)
  });

  it('playerTick converts to Knight0 when the chosen inventory has weapons', () => {
    const player = makePlayer({ knightsToSpawn: 2, reproductionCounter: 0, lastTick: 0 });
    const inv = makeInventory({ resources: (() => { const r = new Array(26).fill(0); r[24] = 2; r[25] = 2; return r; })() });
    const state = makeState(player, inv);
    state.gameTick = 1;
    playerTick(state, player);
    const s = state.serfs[2]!;
    expect(s.type).toBe(22); // Knight0
    expect(player.serfCount[22]).toBe(1);
    expect(player.serfCount[21]).toBe(0); // generic census back down by 1 (net 0)
    expect(player.totalMilitaryScore).toBe(1);
    expect(inv.resources[24]).toBe(1); // sword consumed
    expect(inv.resources[25]).toBe(1); // shield consumed
    expect(player.knightsToSpawn).toBe(1);
  });

  it('skips inventories whose serfMode is stop', () => {
    const player = makePlayer({ reproductionCounter: 0, lastTick: 0 });
    const inv = makeInventory({ serfMode: 1 }); // stop
    const state = makeState(player, inv);
    state.gameTick = 1;
    playerTick(state, player);
    expect(state.serfs[2]).toBeNull(); // no matching inventory -> no spawn
    expect(state.serfBudget).toBe(100); // budget restored (the serf was released)
  });

  it('updateEconomy processes players in slot order (P0 before P1)', () => {
    const p0 = makePlayer({ slot: 0, reproductionCounter: 0, lastTick: 0 });
    const p1 = makePlayer({ slot: 1, reproductionCounter: 0, lastTick: 0 });
    const inv0 = makeInventory({ index: 0, owner: 0, building: 1 });
    const inv1 = makeInventory({ index: 1, owner: 1, building: 2 });
    const occupied: Serf = { index: 1, state: 0 } as unknown as Serf;
    const state = {
      header: { maxSerfIndex: 2 } as unknown as GameState['header'],
      gameTick: 1,
      serfBudget: 100,
      players: [p0, p1, null, null],
      serfs: [null, occupied, null],
      inventories: [inv0, inv1],
      buildings: [null, makeBuilding(), { index: 2, col: 51, row: 42 } as unknown as Building],
      blockMeta: { serfs: { recordSize: 16, maxIndex: 2 } } as unknown as GameState['blockMeta'],
    } as unknown as GameState;

    updateEconomy(state, false); // frameBoundary=false: playerTick only

    // P0 gets the lower index (2), P1 the next one (3).
    expect(state.serfs[2]!.owner).toBe(0);
    expect(state.serfs[3]!.owner).toBe(1);
    expect(state.serfs[3]!.col).toBe(51); // P1's castle
  });

  /**
   * Underflow clamp of the scores (@0xf03a..@0xf088): `if ((u32)v >= 0xffff0000) v = 0` - three times,
   * and BEFORE the active gate.
   */
  describe('clampScoreUnderflow', () => {
    const tickOnly = (p: Player): void => {
      const state = {
        header: {} as unknown as GameState['header'],
        gameTick: 1,
        players: [p, null, null, null],
        serfs: [],
        inventories: [],
        buildings: [],
      } as unknown as GameState;
      playerTick(state, p);
    };

    it('resets an underflowed building score to 0', () => {
      const p = makePlayer({ totalBuildingScore: (0 - 5) >>> 0, lastTick: 1 });
      tickOnly(p);
      expect(p.totalBuildingScore).toBe(0);
    });

    it('resets an underflowed military score to 0', () => {
      const p = makePlayer({ totalMilitaryScore: (0 - 1) >>> 0, lastTick: 1 });
      tickOnly(p);
      expect(p.totalMilitaryScore).toBe(0);
    });

    it('leaves a value just below the threshold alone (0xfffeffff)', () => {
      const p = makePlayer({ totalBuildingScore: 0xfffeffff, lastTick: 1 });
      tickOnly(p);
      expect(p.totalBuildingScore).toBe(0xfffeffff);
    });

    it('runs for an INACTIVE player too (the clamps sit before `bt $0x6` @0xf090)', () => {
      const p = makePlayer({ active: false, flags: 0, totalBuildingScore: (0 - 5) >>> 0 });
      tickOnly(p);
      expect(p.totalBuildingScore).toBe(0);
    });
  });
});
