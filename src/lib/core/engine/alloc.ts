/**
 * Slot allocators of the entity arrays — one routine each in the original, one function each here.
 *
 * The original keeps buildings, flags and inventories in dense arrays with an occupancy bitmap.
 * Allocating means: find the lowest free slot, zero the record, and pull the high-water mark
 * (`maxIndex`) along. All three are structurally the same as `create_serf`:
 *
 * | Routine | Adresse | Record |
 * |---|---|---|
 * | `alloc_building` | `FUN_0004514a` | 18 B |
 * | `alloc_flag` | `FUN_00044e68` | 70 B |
 * | `alloc_inventory` | `FUN_000453d7` | 120 B |
 * | `free_building_slot` | `FUN_000452c8` | — |
 *
 * Here "slot occupied" is `array[idx] !== null`; the bitmap only appears on serialisation. Slot 0 is
 * a reserved null slot for buildings, flags and serfs (`start = 1`) but **not** for inventories — the
 * original's array reset does not create one there.
 */

import type { GameState, Building, Flag, Inventory } from './state.js';

/** Niedrigsten freien Slot ≥ `start` in einem dichten Slot-Store finden (wie `create_serf`). */
export function lowestFreeSlot<T>(store: (T | null)[], start = 1): number {
  let idx = start;
  while (idx < store.length && store[idx] !== null) idx++;
  if (idx >= store.length) store.push(null);
  return idx;
}

/** Grow the high-water mark (`maxIndex`) when the allocation happened at the top end. */
export function growMax(
  store: (unknown | null)[],
  idx: number,
  meta: { maxIndex: number },
  setHeader: (v: number) => void,
): void {
  if (idx >= meta.maxIndex) {
    meta.maxIndex = idx + 1;
    setHeader(idx + 1);
    if (store.length <= idx + 1) store.push(null);
  }
}

/**
 * Allocate a building (`alloc_building` @0x4514a): empty 18-byte record.
 *
 * `start` exists **only** to reserve the null slot — `resetEntityTables` @0x76bb calls each allocator
 * once at game start, and the original's scanner begins at 0 (`mov $0x0,0x8(%edi)` @0x45191). During
 * play it is 1.
 */
export function allocBuilding(state: GameState, start = 1): Building {
  const idx = lowestFreeSlot(state.buildings, start);
  const bld: Building = {
    index: idx,
    col: 0,
    row: 0,
    type: 0,
    typeName: 'None',
    owner: 0,
    constructing: false,
    progress: 0,
    flag: 0,
    firstKnight: 0,
    active: false,
    burning: false,
    holder: false,
    serfRequested: false,
    threatLevel: 0,
    serfRequestFailed: false,
    playingSfx: false,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
    hasInventory: false,
    inventoryIndex: null,
    level: null,
    stockMaximum: null,
  };
  state.buildings[idx] = bld;
  growMax(state.buildings, idx, state.blockMeta.buildings, (v) => (state.header.maxBuildingIndex = v));
  return bld;
}

/**
 * Allocate a flag (`alloc_flag` @0x44e68): empty 70-byte record. For `start` see
 * {@link allocBuilding}.
 *
 * **The original's capacity limit is deliberately not reproduced.** There `alloc_flag` fails once
 * `gs+0x258` is reached (`mov 0x258(%ebx),%ax` @0x44edd, `jb` @0x44ee8) — about **16391** records for
 * the observed memory layout (`mov $0x2314` @0x3773, `mov $0x231` @0x37f6). Our array grows instead
 * of failing.
 *
 * For every map up to size 5 the difference is **structurally** unreachable, not merely absent from
 * the data: 16391 slots exceed the 16384 tiles of a 128x128 map, and there can never be more live
 * flags than tiles because `build_flag` occupies the tile's object byte (@0x28a0d/@0x28a17). The
 * other capacities of the same layout: buildings 9576, serfs 64043, inventories 1444 — the serf
 * number is why `serfBudget` always binds before the capacity does.
 */
export function allocFlag(state: GameState, start = 1): Flag {
  const idx = lowestFreeSlot(state.flags, start);
  const flag: Flag = {
    index: idx,
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
  };
  state.flags[idx] = flag;
  growMax(state.flags, idx, state.blockMeta.flags, (v) => (state.header.maxFlagIndex = v));
  return flag;
}

/** Allocate an inventory (`alloc_inventory` @0x453d7): empty 120-byte record. */
export function allocInventory(state: GameState): Inventory {
  const idx = lowestFreeSlot(state.inventories, 0); // inventory slot 0 is real, not a null slot
  const inv: Inventory = {
    index: idx,
    owner: 0,
    resDir: 0,
    resMode: 0,
    serfMode: 0,
    flag: 0,
    building: 0,
    resources: new Array(26).fill(0),
    outQueue: [
      { type: -1, dest: 0 },
      { type: -1, dest: 0 },
    ],
    genericCount: 0,
    serfIndices: new Array(27).fill(0),
  };
  state.inventories[idx] = inv;
  growMax(state.inventories, idx, state.blockMeta.inventories, (v) => (state.header.maxInventoryIndex = v));
  return inv;
}

/**
 * `FUN_000456cd` @0x456cd — frees an **inventory** slot, built like {@link freeBuildingSlot}: the
 * original recovers the index from the pointer (`(ptr - gs[0xf0]) / 0x78`, @0x45702), clears the
 * occupancy bit and pulls `maxInventoryIndex` down when the freed slot was the highest.
 *
 * **No null slot:** inventory index 0 is a real inventory (see {@link allocInventory}), so the
 * shrink loop may run down to 0.
 */
export function freeInventorySlot(state: GameState, index: number): void {
  state.inventories[index] = null;
  const meta = state.blockMeta.inventories;
  if (index + 1 === meta.maxIndex) {
    let m = meta.maxIndex - 1;
    while (m > 0 && state.inventories[m - 1] === null) m -= 1;
    meta.maxIndex = m;
  }
}

/**
 * `free_building_slot` @0x452c8 — frees a building slot and pulls `maxBuildingIndex` down **only**
 * if the freed slot was the highest, counting down to the next occupied one. For a slot in the middle
 * `maxBuildingIndex` stays as it is.
 */
export function freeBuildingSlot(state: GameState, index: number): void {
  state.buildings[index] = null;
  const meta = state.blockMeta.buildings;
  if (index + 1 === meta.maxIndex) {
    let m = meta.maxIndex - 1;
    while (m > 0 && state.buildings[m - 1] === null) m -= 1;
    meta.maxIndex = m;
  }
}
