import { describe, it, expect } from 'vitest';
import { castleBuildingHandler } from './castle-garrison.js';
import type { Building, GameState, Inventory, Player, Serf } from './state.js';

/**
 * `castle_building_handler` (@0x14da5) - the mechanics: which serf is chosen, what is booked, and
 * when nothing happens at all.
 */

/** Serf with the chain pointer in union bytes 3/4 (== `serf+0xe`). */
function serf(index: number, type: number, next = 0, state = 75): Serf {
  return {
    index,
    type,
    state,
    counter: 0,
    tick: 0,
    stateData: [0, 0, 0, next & 0xff, (next >> 8) & 0xff],
  } as unknown as Serf;
}

function makeCastle(
  over: {
    /** Garrison chain (serf types, linked from index 100 on). */
    garrison?: number[];
    /** Representatives in the castle stock: type -> serf index. */
    stock?: Partial<Record<number, number>>;
    want?: number;
    have?: number;
    sword?: number;
    shield?: number;
    cooldown?: number;
  } = {},
): { state: GameState; castle: Building; inv: Inventory; player: Player } {
  const serfs: (Serf | null)[] = [null];
  const garrison = over.garrison ?? [];
  garrison.forEach((type, i) => {
    serfs[100 + i] = serf(100 + i, type, i + 1 < garrison.length ? 100 + i + 1 : 0);
  });

  const resources = new Array(26).fill(0);
  resources[24] = over.sword ?? 0;
  resources[25] = over.shield ?? 0;
  const inv: Inventory = {
    index: 0,
    owner: 0,
    resources,
    genericCount: 4,
    serfIndices: new Array(27).fill(0),
  } as unknown as Inventory;
  for (const [type, idx] of Object.entries(over.stock ?? {})) {
    inv.serfIndices[Number(type)] = idx as number;
    serfs[idx as number] = serf(idx as number, Number(type), 0, 1); // IdleInStock
  }

  const castle = {
    index: 1,
    type: 24,
    owner: 0,
    burning: false,
    constructing: false,
    flag: 1,
    col: 10,
    row: 10,
    firstKnight: garrison.length > 0 ? 100 : 0,
    inventoryIndex: 0,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
  } as unknown as Building;

  const player: Player = {
    slot: 0,
    active: true,
    flags: 0x41,
    knightMenuValue: over.want ?? 0,
    knightMenuCounter: over.have ?? garrison.length,
    castleRequestCooldown: over.cooldown ?? 0,
    serfCount: new Array(27).fill(0),
    totalMilitaryScore: 0,
  } as unknown as Player;

  const state = {
    gameTick: 100,
    geo: { cols: 64, rows: 64, colMask: 63, rowMask: 63, rowShift: 6 },
    mapTiles: Array.from({ length: 64 * 64 }, () => ({ serfIndex: 0 })),
    buildings: [null, castle],
    flags: [
      null,
      // `endpointDirs` has to be present: the knight request traverses the land-road network
      // (`flag[4]`, @0x12b7f). No road here, so all false.
      { index: 1, bldFlags: 0x40, endpointDirs: [false, false, false, false, false, false], connections: [null, null, null, null, null, null] },
    ],
    inventories: [inv],
    players: [player, null, null, null],
    serfs,
  } as unknown as GameState;
  return { state, castle, inv, player };
}

function chain(state: GameState, castle: Building): number[] {
  const out: number[] = [];
  for (let i = castle.firstKnight; i !== 0 && out.length < 32; ) {
    const s = state.serfs[i];
    if (!s) break;
    out.push(i);
    i = (s.stateData[3]! | (s.stateData[4]! << 8)) & 0xffff;
  }
  return out;
}

describe('castle_building_handler: too many in the castle (target < actual)', () => {
  it('puts the HEAD of the chain into its own stock and books actual-1', () => {
    const { state, castle, player } = makeCastle({ garrison: [24, 22, 26], want: 2, have: 3 });
    castleBuildingHandler(state, castle);
    expect(player.knightMenuCounter).toBe(2);
    expect(chain(state, castle)).toEqual([101, 102]); // #100 leaves: the head, not the weakest
    const gone = state.serfs[100]!;
    expect(gone.state).toBe(1); // IdleInStock
    expect(gone.stateData[1]).toBe(0); // field_0xc = 0
    expect(gone.stateData[3] | (gone.stateData[4] << 8)).toBe(0); // inventory index
  });
});

describe('castle_building_handler: too few in the castle (target > actual)', () => {
  it('takes the HIGHEST rank out of its own stock', () => {
    const { state, castle, inv, player } = makeCastle({
      garrison: [22],
      stock: { 22: 7, 25: 8 }, // K0 and K3 in the stock
      want: 2,
      have: 1,
    });
    castleBuildingHandler(state, castle);
    expect(castle.firstKnight).toBe(8); // K3, not K0
    expect(state.serfs[8]!.state).toBe(75); // DefendingCastle
    expect(state.serfs[8]!.counter).toBe(6000);
    expect(inv.serfIndices[25]).toBe(0);
    expect(inv.serfIndices[22]).toBe(7); // K0 stays put
    expect(player.knightMenuCounter).toBe(2);
  });

  it('turns a generic plus sword plus shield into a Knight0', () => {
    const { state, castle, inv, player } = makeCastle({
      garrison: [22],
      stock: { 21: 9 },
      want: 2,
      have: 1,
      sword: 3,
      shield: 2,
    });
    castleBuildingHandler(state, castle);
    expect(state.serfs[9]!.type).toBe(22); // Knight0
    expect(state.serfs[9]!.state).toBe(75);
    expect(castle.firstKnight).toBe(9);
    expect(inv.resources[24]).toBe(2);
    expect(inv.resources[25]).toBe(1);
    expect(inv.genericCount).toBe(3);
    expect(player.serfCount[21]).toBe(-1);
    expect(player.serfCount[22]).toBe(1);
    expect(player.totalMilitaryScore).toBe(1);
    expect(player.knightMenuCounter).toBe(2);
  });

  it('clears the generic cache slot even WITHOUT weapons', () => {
    const { state, castle, inv, player } = makeCastle({
      garrison: [22],
      stock: { 21: 9 },
      want: 2,
      have: 1,
      sword: 0,
      shield: 5,
    });
    castleBuildingHandler(state, castle);
    expect(inv.serfIndices[21]).toBe(0); // cleared although no conversion happened
    expect(state.serfs[9]!.type).toBe(21); // still generic
    expect(player.knightMenuCounter).toBe(1);
  });

  it('requests externally only every fifth pass and preserves the inventory marker', () => {
    const { state, castle, player } = makeCastle({ garrison: [22], want: 2, have: 1, cooldown: 2 });
    castleBuildingHandler(state, castle); // 2 -> 1, no request
    expect(player.castleRequestCooldown).toBe(1);
    castleBuildingHandler(state, castle); // 1 -> 0
    expect(player.castleRequestCooldown).toBe(0);
    castleBuildingHandler(state, castle); // 0 => request, reset to 5
    expect(player.castleRequestCooldown).toBe(5);
    // `bld[8] = 0xffff` @0x15062 - the inventory marker as the real byte pair.
    expect(castle.stock[0]).toEqual({ available: 0xf, requested: 0xf });
    expect(castle.stock[1]).toEqual({ available: 0xf, requested: 0xf });
  });
});

describe('castle_building_handler: rank rotation (target == actual)', () => {
  it('swaps the strongest of the garrison for a weaker one from the stock', () => {
    const { state, castle, inv } = makeCastle({
      garrison: [23, 26, 24], // K1, K4, K2 - the strongest sits in the middle
      stock: { 22: 7 }, // one K0 in the stock
      want: 3,
      have: 3,
    });
    castleBuildingHandler(state, castle);
    expect(state.serfs[101]!.type).toBe(22); // the garrison K4 is now a K0
    expect(state.serfs[7]!.type).toBe(26); // the stock K0 is now a K4
    expect(inv.serfIndices[22]).toBe(0); // cache slot cleared (idleInStock refills it)
    expect(chain(state, castle)).toEqual([100, 101, 102]); // nobody moves
  });

  it('does nothing when the strongest of the garrison is already Knight0', () => {
    const { state, castle, inv } = makeCastle({
      garrison: [22, 22],
      stock: { 22: 7 },
      want: 2,
      have: 2,
    });
    castleBuildingHandler(state, castle);
    expect(state.serfs[7]!.type).toBe(22);
    expect(inv.serfIndices[22]).toBe(7); // cache untouched
  });

  it('stops as soon as the next stock rank would no longer be weaker', () => {
    // Garrison max K1 (rank 2): only a K0 would qualify, and there is none.
    const { state, castle, inv } = makeCastle({
      garrison: [23],
      stock: { 23: 7, 24: 8 },
      want: 1,
      have: 1,
    });
    castleBuildingHandler(state, castle);
    expect(state.serfs[100]!.type).toBe(23);
    expect(inv.serfIndices[23]).toBe(7);
    expect(inv.serfIndices[24]).toBe(8);
  });

  it('takes the WEAKEST matching one from the stock, not the first available', () => {
    // Garrison max K4 (rank 5); stock holds K1 and K2, so K1 is taken.
    const { state, castle, inv } = makeCastle({
      garrison: [26],
      stock: { 23: 7, 24: 8 },
      want: 1,
      have: 1,
    });
    castleBuildingHandler(state, castle);
    expect(state.serfs[100]!.type).toBe(23);
    expect(state.serfs[7]!.type).toBe(26);
    expect(inv.serfIndices[23]).toBe(0);
    expect(inv.serfIndices[24]).toBe(8); // K2 stays untouched
  });

  it('does nothing with an empty garrison', () => {
    const { state, castle, inv } = makeCastle({ garrison: [], stock: { 22: 7 }, want: 0, have: 0 });
    castleBuildingHandler(state, castle);
    expect(castle.firstKnight).toBe(0);
    expect(inv.serfIndices[22]).toBe(7);
  });
});
