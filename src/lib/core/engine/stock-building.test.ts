import { describe, it, expect } from 'vitest';
import { warehouseBuildingHandler, stockBuildingTail } from './stock-building.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import type { Building, Flag, GameState, Inventory, Player, Serf } from './state.js';

/**
 * `warehouse_building_handler` (@0x1528c) and the shared stock tail (@0x1537e) - the mechanics.
 */

const GEO = mapGeometry(3);
const BLD_COL = 20;
const BLD_ROW = 20;
const BLD_POS = posOf(BLD_COL, BLD_ROW, GEO);
const FLAG_POS = neighbor(BLD_POS, Direction.DownRight, GEO);

function makeState(
  over: {
    active?: boolean;
    holder?: boolean;
    serfRequested?: boolean;
    genericCount?: number;
    resDir?: number;
    goldBars?: number;
    cooldown?: number;
  /** Serf index registered on the flag tile. */
    tileSerf?: number;
 /** Does that serf really stand there? */
    tileSerfHere?: boolean;
    inventoryIndex?: number | null;
  } = {},
): { state: GameState; bld: Building; inv: Inventory; player: Player } {
  const resources = new Array(26).fill(0);
  resources[14] = over.goldBars ?? 0;
  const inv: Inventory = {
    index: 0,
    owner: 0,
    resDir: over.resDir ?? 0,
    resMode: 0,
    serfMode: 0,
    flag: 0,
    building: 0,
    resources,
    genericCount: over.genericCount ?? 3,
    serfIndices: new Array(27).fill(0),
  } as unknown as Inventory;

  const bld: Building = {
    index: 3,
    type: 10,
    owner: 0,
    col: BLD_COL,
    row: BLD_ROW,
    flag: 2,
    burning: false,
    constructing: false,
    active: over.active ?? true,
    holder: over.holder ?? true,
    serfRequested: over.serfRequested ?? false,
    hasInventory: over.inventoryIndex !== null,
    inventoryIndex: over.inventoryIndex === undefined ? 0 : over.inventoryIndex,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
  } as unknown as Building;

  const flag2 = {
    index: 2,
    bldFlags: 0,
    endpointDirs: new Array(6).fill(false), // only the building connection, no road
    connections: [null, null, null, null, { kind: 'building', index: 3 }, null],
  } as unknown as Flag;

  const player: Player = {
    slot: 0,
    active: true,
    flags: 0x41,
    genericRequestCooldown: over.cooldown ?? 0,
    goldAccumulator: 0,
    serfCount: new Array(27).fill(0),
    messageTypes: [],
    messagePositions: [],
  } as unknown as Player;

  const mapTiles = Array.from({ length: 64 * 64 }, () => ({ serfIndex: 0 }));
  const serfs: (Serf | null)[] = [null];
  if (over.tileSerf !== undefined) {
    mapTiles[FLAG_POS]!.serfIndex = over.tileSerf;
    const here = over.tileSerfHere ?? true;
    serfs[over.tileSerf] = {
      index: over.tileSerf,
      type: 0,
      state: 1,
      col: here ? BLD_COL + 1 : BLD_COL + 5,
      row: here ? BLD_ROW + 1 : BLD_ROW + 5,
      stateData: [0, 0, 0, 0, 0],
    } as unknown as Serf;
  }

  const state = {
    gameTick: 500,
    rotation: 0,
    geo: GEO,
    mapTiles,
    buildings: [null, null, null, bld],
    flags: [null, null, flag2],
    inventories: [inv],
    players: [player, null, null, null],
    serfs,
    blockMeta: {
      inventories: { maxIndex: 1 },
      buildings: { maxIndex: 4 },
      flags: { maxIndex: 3 },
      serfs: { maxIndex: 1 },
    },
    header: { maxInventoryIndex: 1 },
  } as unknown as GameState;
  return { state, bld, inv, player };
}

describe('warehouse_building_handler — activation', () => {
  it('creates an inventory on the first pass, links it and sends message type 7', () => {
    const { state, bld, player } = makeState({ active: false, inventoryIndex: null });
    warehouseBuildingHandler(state, bld);
    expect(bld.active).toBe(true);
    expect(bld.inventoryIndex).not.toBeNull();
    const inv = state.inventories[bld.inventoryIndex!]!;
    expect(inv.owner).toBe(0);
    expect(inv.building).toBe(3);
    expect(inv.flag).toBe(2);
    expect(bld.hasInventory).toBe(true);
 // `mov $0xffff,%ax ; mov %ax,0x8(%ebx)` @0x15310 — both slots become the inventory marker.
    expect(bld.stock[0]).toEqual({ available: 0xf, requested: 0xf });
    expect(bld.stock[1]).toEqual({ available: 0xf, requested: 0xf });
    expect(player.messageTypes).toEqual([7]);
    expect(player.messagePositions).toEqual([BLD_POS]);
  });

  it('does NOT fall into the tail in the same round (the original returns)', () => {
    const { state, bld, player } = makeState({
      active: false,
      inventoryIndex: null,
      goldBars: 9,
    });
    warehouseBuildingHandler(state, bld);
    expect(player.goldAccumulator).toBe(0);
  });

  it('activates only once - a second pass creates no second inventory', () => {
    const { state, bld } = makeState({ active: false, inventoryIndex: null });
    warehouseBuildingHandler(state, bld);
    const first = bld.inventoryIndex;
    const count = state.inventories.filter(Boolean).length;
    warehouseBuildingHandler(state, bld);
    expect(bld.inventoryIndex).toBe(first);
    expect(state.inventories.filter(Boolean).length).toBe(count);
  });
});

describe('warehouse_building_handler: transporter request', () => {
  it('requests a transporter while there is neither holder nor pending request', () => {
    const { state, bld } = makeState({ holder: false, serfRequested: false });
    warehouseBuildingHandler(state, bld);
    // No delivering neighbour here, so the request fails. What matters is that it does NOT set
    // `serfRequestFailed` - unlike the production branch.
    expect(bld.serfRequestFailed).toBeFalsy();
    expect(bld.serfRequested).toBeFalsy();
  });

  it('does not request when a holder is already there', () => {
    const { state, bld } = makeState({ holder: true });
    warehouseBuildingHandler(state, bld);
    expect(bld.serfRequested).toBeFalsy();
  });
});

describe('stock tail — generic resupply', () => {
  it('counts down and only fires on underflow', () => {
    const { state, bld, player } = makeState({ genericCount: 0, cooldown: 2 });
    stockBuildingTail(state, bld);
    expect(player.genericRequestCooldown).toBe(1);
    stockBuildingTail(state, bld);
    expect(player.genericRequestCooldown).toBe(0);
    stockBuildingTail(state, bld);
    expect(player.genericRequestCooldown).toBe(5);
  });

  it('leaves the counter alone while a generic is still in stock', () => {
    const { state, bld, player } = makeState({ genericCount: 1, cooldown: 3 });
    stockBuildingTail(state, bld);
    expect(player.genericRequestCooldown).toBe(3);
  });

  it('leaves the counter alone when there is no holder', () => {
    const { state, bld, player } = makeState({ genericCount: 0, holder: false, cooldown: 3 });
    stockBuildingTail(state, bld);
    expect(player.genericRequestCooldown).toBe(3);
  });

  it('rests when the warehouse is set to release (mask 0x0a)', () => {
    for (const resDir of [0x02, 0x08, 0x0a]) {
      const { state, bld, player } = makeState({ genericCount: 0, resDir, cooldown: 3 });
      stockBuildingTail(state, bld);
      expect(player.genericRequestCooldown).toBe(3);
    }
  });

  it('keeps running on accept/stop (values 0 and 1, the mask does not match)', () => {
    for (const resDir of [0x00, 0x01, 0x05]) {
      const { state, bld, player } = makeState({ genericCount: 0, resDir, cooldown: 3 });
      stockBuildingTail(state, bld);
      expect(player.genericRequestCooldown).toBe(2);
    }
  });
});

describe('stock tail — gold accumulation', () => {
  it('adds the gold bar stock on EVERY pass (an accumulator, not a level)', () => {
    const { state, bld, player } = makeState({ goldBars: 7 });
    stockBuildingTail(state, bld);
    expect(player.goldAccumulator).toBe(7);
    stockBuildingTail(state, bld);
    expect(player.goldAccumulator).toBe(14);
  });

  it('adds 0 when there is no gold in stock', () => {
    const { state, bld, player } = makeState({ goldBars: 0 });
    stockBuildingTail(state, bld);
    expect(player.goldAccumulator).toBe(0);
  });
});

describe('stock tail: cleaning up the flag tile', () => {
  it('clears the serf slot of the FLAG tile when the serf stands elsewhere', () => {
    const { state, bld } = makeState({ tileSerf: 5, tileSerfHere: false });
    stockBuildingTail(state, bld);
    expect(state.mapTiles[FLAG_POS]!.serfIndex).toBe(0);
  });

  it('leaves the slot alone when the serf really is there', () => {
    const { state, bld } = makeState({ tileSerf: 5, tileSerfHere: true });
    stockBuildingTail(state, bld);
    expect(state.mapTiles[FLAG_POS]!.serfIndex).toBe(5);
  });

  it('clears the slot when the registered serf no longer exists', () => {
    const { state, bld } = makeState({ tileSerf: 5, tileSerfHere: true });
    state.serfs[5] = null;
    stockBuildingTail(state, bld);
    expect(state.mapTiles[FLAG_POS]!.serfIndex).toBe(0);
  });

  it('does not touch the BUILDING tile (the original clears the flag tile)', () => {
    const { state, bld } = makeState({ tileSerf: 5, tileSerfHere: false });
    state.mapTiles[BLD_POS]!.serfIndex = 9;
    stockBuildingTail(state, bld);
    expect(state.mapTiles[BLD_POS]!.serfIndex).toBe(9);
  });
});
