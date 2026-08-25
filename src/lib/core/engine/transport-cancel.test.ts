import { describe, it, expect } from 'vitest';
import { cancelTransportOnDelete } from './transport-cancel.js';
import type { GameState, Flag, Inventory, Player, Serf } from './state.js';

/**
 * The delete cleanup `cancel_transport_on_delete` (`FUN_000178f0`).
 *
 * The shared network tail `@0x17a52` is covered by `inventory-mode.test.ts`; what matters here is the
 * SERF CASCADE before it, which is what distinguishes this routine from the two single passes: it
 * clears both classes, and exactly once per serf (@0x179a0-0x17a2b).
 */
function makeState(serfs: (Serf | null)[]): GameState {
  const flag = {
    index: 3,
    owner: 0,
    resourceSlots: new Array(8).fill(-1),
    slotDir: new Array(8).fill(-1),
    slotDest: new Array(8).fill(0),
    scheduled: new Array(6).fill(false),
    scheduledSlot: new Array(6).fill(0),
    hasResources: false,
  } as unknown as Flag;
  const inv = {
    index: 0,
    owner: 0,
    outQueue: [
      { type: -1, dest: 0 },
      { type: -1, dest: 0 },
    ],
  } as unknown as Inventory;
  return {
    serfs: [null, ...serfs],
    flags: [null, null, null, flag],
    inventories: [inv],
    players: [{ slot: 0, flagPriority: new Array(26).fill(1) } as unknown as Player],
  } as unknown as GameState;
}

/** `state`, `serf[0xb]`, `serf[0xc]` (Ziel 7), `serf[0xf]`. */
function serf(state: number, b: number, dest: number, f = 0): Serf {
  return { index: 1, type: 0, state, stateData: [b, dest & 0xff, dest >> 8, 0, f] } as unknown as Serf;
}

describe('cancel_transport_on_delete — Serf-Kaskade', () => {
  it('cancels walking serfs with `serf[0xb] = 0xfe` (branch 1)', () => {
    const s = serf(2, 0x83, 7); // Walking, Bit 7 gesetzt
    const st = makeState([s]);
    cancelTransportOnDelete(st, 7);
    expect(s.stateData[0]).toBe(0xfe);
    expect(s.stateData[1]).toBe(0);
  });

  it('takes only the destination from goods carriers, not the good (branch 2)', () => {
    const s = serf(3, 0x0a, 7); // transporting, carrying good 10
    const st = makeState([s]);
    cancelTransportOnDelete(st, 7);
    expect(s.stateData[1]).toBe(0);
    expect(s.stateData[0]).toBe(0x0a); // `serf[0xb]` bleibt — nur Zweig 1 schreibt 0xfe
  });

  it('clears BOTH classes in one pass - what sets this routine apart from the single passes', () => {
    const walker = serf(2, 0x83, 7);
    const carrier = serf(3, 0x0a, 7);
    const st = makeState([walker, carrier]);
    cancelTransportOnDelete(st, 7);
    expect(walker.stateData[0]).toBe(0xfe);
    expect(carrier.stateData[1]).toBe(0);
  });

  it('a foreign destination stays untouched', () => {
    const s = serf(2, 0x83, 9);
    const st = makeState([s]);
    cancelTransportOnDelete(st, 7);
    expect(s.stateData[0]).toBe(0x83);
    expect(s.stateData[1]).toBe(9);
  });

  it('bit 7 clear => branch 1 does not apply; the serf falls through into branch 2 (`jns` @0x179a8)', () => {
    // State 2 is none of the goods states, so falling through means: no effect at all.
    const walker = serf(2, 0x03, 7);
    // State 3 is a goods state, so the same fall-through hits it.
    const carrier = serf(3, 0x03, 7);
    const st = makeState([walker, carrier]);
    cancelTransportOnDelete(st, 7);
    expect(walker.stateData[0]).toBe(0x03);
    expect(walker.stateData[1]).toBe(7); // untouched
    expect(carrier.stateData[1]).toBe(0); // Zweig 2 hat gegriffen
  });

  it('Zustand 5: `serf[0xf]` entscheidet, welcher Zweig greift (2 → Siedler, 0xd → Ware)', () => {
    const leavingSerf = serf(5, 0x83, 7, 2);
    const leavingRes = serf(5, 0x83, 7, 0x0d);
    const leavingNeither = serf(5, 0x83, 7, 5);
    const st = makeState([leavingSerf, leavingRes, leavingNeither]);
    cancelTransportOnDelete(st, 7);
    expect(leavingSerf.stateData[0]).toBe(0xfe);
    expect(leavingRes.stateData[0]).toBe(0x83); // Zweig 2: `serf[0xb]` bleibt
    expect(leavingRes.stateData[1]).toBe(0);
    expect(leavingNeither.stateData[1]).toBe(7); // weder noch
  });

  it('runs the shared network tail too (the flag`s resource slot is released)', () => {
    const st = makeState([]);
    const flag = st.flags[3]!;
    flag.resourceSlots[4] = 9;
    flag.slotDir[4] = 2;
    flag.slotDest[4] = 7;
    flag.scheduled[2] = true;
    flag.scheduledSlot[2] = 4;
    cancelTransportOnDelete(st, 7);
    expect(flag.slotDest[4]).toBe(0);
    expect(flag.slotDir[4]).toBe(-1);
    expect(flag.hasResources).toBe(true);
    expect(flag.scheduled[2]).toBe(false); // no further slot in direction 2
  });
});
