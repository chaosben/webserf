import { describe, it, expect } from 'vitest';
import { cancelSerfDestinations, clearDestinationFromNetwork } from './transport-cancel.js';
import {
  MODE_IN,
  MODE_OUT,
  MODE_STOP,
  setResourceModeIn,
  setResourceModeOut,
  setResourceModeStop,
  setSerfModeIn,
  setSerfModeOut,
  setSerfModeStop,
} from './inventory-mode.js';
import type { GameState, Flag, Inventory, Player, Serf } from './state.js';

/**
 * Mode switching of a warehouse (screen 0x2c, `FUN_0002e119`..`FUN_0002e369` plus the clearing passes
 * `FUN_000176c0` / `FUN_000177e9` and their shared tail `@0x17a52`).
 *
 * Layout: warehouse with inventory #0 at flag #7. A second flag #3 has resource slots targeting the
 * warehouse flag, and a transporter is on its way with the same destination.
 */
function makeState(): {
  state: GameState;
  inv: Inventory;
  invFlag: Flag;
  otherFlag: Flag;
} {
  const invFlag = {
    index: 7,
    owner: 0,
    acceptsSerfs: true,
    acceptsResources: true,
    resourceSlots: new Array(8).fill(-1),
    slotDir: new Array(8).fill(-1),
    slotDest: new Array(8).fill(0),
    scheduled: new Array(6).fill(false),
    scheduledSlot: new Array(6).fill(0),
    hasResources: false,
  } as unknown as Flag;

  // Flagge #3: drei Waren, alle in Richtung 2 eingeplant, Slot 1 zeigt aufs Lager.
  const otherFlag = {
    index: 3,
    owner: 0,
    acceptsSerfs: true,
    acceptsResources: true,
    resourceSlots: [4, 9, 2, -1, -1, -1, -1, -1],
    slotDir: [2, 2, 2, -1, -1, -1, -1, -1],
    slotDest: [11, 7, 11, 0, 0, 0, 0, 0],
    scheduled: [false, false, true, false, false, false],
    scheduledSlot: [0, 0, 1, 0, 0, 0],
    hasResources: false,
  } as unknown as Flag;

  const inv: Inventory = {
    index: 0,
    owner: 0,
    resDir: 0,
    resMode: MODE_IN,
    serfMode: MODE_IN,
    flag: 7,
    outQueue: [
      { type: 3, dest: 7 },
      { type: 5, dest: 12 },
    ],
  } as unknown as Inventory;

  // flagPriority: resource 9 highest, then 2, then 4.
  const flagPriority = new Array(26).fill(1);
  flagPriority[4] = 5;
  flagPriority[9] = 20;
  flagPriority[2] = 9;
  const player = { slot: 0, flagPriority } as unknown as Player;

  // Transporter #5 carries (state 3) to the warehouse; walker #6 walks there (state 2).
  const carrier = { index: 5, type: 0, state: 3, stateData: [0x80, 7, 0, 0, 0] } as unknown as Serf;
  const walker = { index: 6, type: 21, state: 2, stateData: [0x83, 7, 0, 0, 0] } as unknown as Serf;

  const state = {
    serfs: [null, null, null, null, null, carrier, walker],
    flags: [null, null, null, otherFlag, null, null, null, invFlag],
    inventories: [inv],
    players: [player],
  } as unknown as GameState;
  return { state, inv, invFlag, otherFlag };
}

describe('Screen 0x2c — Waren-Modus', () => {
  it('stock-in sets mode 0 and the accept bit of the flag without clearing', () => {
    const { state, inv, invFlag, otherFlag } = makeState();
    invFlag.acceptsResources = false;
    setResourceModeIn(state, inv);
    expect(inv.resMode).toBe(MODE_IN);
    expect(inv.resDir & 3).toBe(0);
    expect(invFlag.acceptsResources).toBe(true);
    // No clearing pass in this branch: the transporter keeps its destination.
    expect(state.serfs[5]!.stateData[1]).toBe(7);
    expect(otherFlag.slotDest[1]).toBe(7);
  });

  it('stop writes the 1, clears the accept bit and clears the network', () => {
    const { state, inv, invFlag, otherFlag } = makeState();
    setResourceModeStop(state, inv);
    expect(inv.resMode).toBe(MODE_STOP);
    expect(invFlag.acceptsResources).toBe(false);
    // The transporter (state 3) loses its destination but NOT its `serf[0xb]`; only the serf pass sets 0xfe.
    expect(state.serfs[5]!.stateData[1]).toBe(0);
    expect(state.serfs[5]!.stateData[0]).toBe(0x80);
    // The walker (state 2) belongs to the serf pass and stays untouched here.
    expect(state.serfs[6]!.stateData[1]).toBe(7);
    // A resource slot with that destination is released.
    expect(otherFlag.slotDest[1]).toBe(0);
    expect(otherFlag.slotDir[1]).toBe(-1);
    expect(otherFlag.hasResources).toBe(true);
  });

  it('stock-out writes the 3, not the 2', () => {
    const { state, inv } = makeState();
    setResourceModeOut(state, inv);
    expect(inv.resMode).toBe(MODE_OUT);
    expect(inv.resMode).toBe(3);
    expect(inv.resDir & 3).toBe(3);
  });
});

describe('Screen 0x2c — Siedler-Modus', () => {
  it('serf-in sets the accept bit without clearing', () => {
    const { state, inv, invFlag } = makeState();
    invFlag.acceptsSerfs = false;
    setSerfModeIn(state, inv);
    expect(inv.serfMode).toBe(MODE_IN);
    expect(invFlag.acceptsSerfs).toBe(true);
    expect(state.serfs[6]!.stateData[1]).toBe(7);
  });

  it('stop cancels walking serfs with `serf[0xb] = 0xfe`', () => {
    const { state, inv, invFlag } = makeState();
    setSerfModeStop(state, inv);
    expect(inv.serfMode).toBe(MODE_STOP);
    expect(inv.resDir).toBe(MODE_STOP << 2);
    expect(invFlag.acceptsSerfs).toBe(false);
    expect(state.serfs[6]!.stateData[0]).toBe(0xfe);
    expect(state.serfs[6]!.stateData[1]).toBe(0);
    // The resource carrier belongs to the other pass and stays untouched.
    expect(state.serfs[5]!.stateData[1]).toBe(7);
  });

  it('serf-out writes the 3 and also clears', () => {
    const { state, inv } = makeState();
    setSerfModeOut(state, inv);
    expect(inv.serfMode).toBe(MODE_OUT);
    expect(state.serfs[6]!.stateData[0]).toBe(0xfe);
  });

  it('bit 7 of `serf[0xb]` is the condition: without it nothing is cancelled', () => {
    const { state } = makeState();
    state.serfs[6]!.stateData[0] = 0x03; // Bit 7 klar
    cancelSerfDestinations(state, 7);
    expect(state.serfs[6]!.stateData[0]).toBe(0x03);
    expect(state.serfs[6]!.stateData[1]).toBe(7);
  });
});

describe('Geteilter Netz-Lauf @0x17a52', () => {
  it('picks the slot with the highest flagPriority for the freed direction', () => {
    const { state, otherFlag } = makeState();
    // Slot 1 (resource 9, highest priority) drops out, leaving slot 0 (resource 4, prio 5) and
    // Slot 2 (Ware 2, prio 9) in Richtung 2 — Slot 2 muss gewinnen.
    clearDestinationFromNetwork(state, 7);
    expect(otherFlag.scheduled[2]).toBe(true);
    expect(otherFlag.scheduledSlot[2]).toBe(2);
  });

  it('on a tie the lowest slot index wins (strict `<` in the original)', () => {
    const { state, otherFlag } = makeState();
    const prio = state.players[0]!.flagPriority as number[];
    prio[4] = 9; // resource 4 (slot 0) tied with resource 2 (slot 2)
    clearDestinationFromNetwork(state, 7);
    expect(otherFlag.scheduledSlot[2]).toBe(0);
  });

  it('without a remaining slot in that direction the scheduling is cleared', () => {
    const { state, otherFlag } = makeState();
    otherFlag.resourceSlots[0] = -1;
    otherFlag.slotDir[0] = -1;
    otherFlag.resourceSlots[2] = -1;
    otherFlag.slotDir[2] = -1;
    clearDestinationFromNetwork(state, 7);
    expect(otherFlag.scheduled[2]).toBe(false);
    expect(otherFlag.scheduledSlot[2]).toBe(0);
  });

  it('packs the outgoing queue of the inventory to the front', () => {
    const { state, inv } = makeState();
    clearDestinationFromNetwork(state, 7); // Slot 0 zeigt aufs Ziel
    expect(inv.outQueue[0]!.type).toBe(5);
    expect(inv.outQueue[0]!.dest).toBe(12);
    expect(inv.outQueue[1]!.type).toBe(-1);
  });

  it('empties only the second slot when just that one points at the destination', () => {
    const { state, inv } = makeState();
    inv.outQueue[0]!.dest = 12;
    inv.outQueue[1]!.dest = 7;
    clearDestinationFromNetwork(state, 7);
    expect(inv.outQueue[0]!.type).toBe(3);
    expect(inv.outQueue[1]!.type).toBe(-1);
  });
});
