import { describe, it, expect } from 'vitest';
import { roundRobinServiceReset } from './economy.js';
import type { GameState } from './state.js';

/**
 * The round-robin housekeeping sweep (`FUN_0000eced` parts 1+2, `economy.ts`).
 */
type Bld = { serfRequestFailed: boolean } | null;
type Flg = { serfRequestFail: boolean } | null;

function mkState(over: Partial<{
  frameAccum: number;
  serviceBudget: number;
  buildingServiceCursor: number;
  flagServiceCursor: number;
  buildings: Bld[];
  flags: Flg[];
  maxBuildingIndex: number;
  maxFlagIndex: number;
}> = {}): GameState {
  const buildings = over.buildings ?? [];
  const flags = over.flags ?? [];
  return {
    frameAccum: over.frameAccum ?? 0,
    serviceBudget: over.serviceBudget ?? 55,
    buildingServiceCursor: over.buildingServiceCursor ?? 0,
    flagServiceCursor: over.flagServiceCursor ?? 0,
    buildings,
    flags,
    header: {
      maxBuildingIndex: over.maxBuildingIndex ?? buildings.length,
      maxFlagIndex: over.maxFlagIndex ?? flags.length,
    },
  } as unknown as GameState;
}

const bld = (failed: boolean): Bld => ({ serfRequestFailed: failed });
const flg = (failed: boolean): Flg => ({ serfRequestFail: failed });

describe('roundRobinServiceReset — FUN_0000eced parts 1+2', () => {
  it('does not gate itself: it sweeps regardless of frameAccum - the caller owns the frame gate', () => {
    // frameAccum is irrelevant here; updateEconomy/advanceFrameClock check the frame boundary.
    const s = mkState({ frameAccum: 3, buildings: [bld(true), bld(true)] });
    roundRobinServiceReset(s);
    expect((s.buildings[0] as { serfRequestFailed: boolean }).serfRequestFailed).toBe(false);
    expect(s.buildingServiceCursor).toBe(2);
  });

  it('clears serfRequestFailed across the window and advances the cursor by its width', () => {
    const buildings = [bld(true), bld(true), bld(false), bld(true)];
    const s = mkState({ buildings, serviceBudget: 55 });
    roundRobinServiceReset(s);
    for (const b of buildings) expect((b as { serfRequestFailed: boolean }).serfRequestFailed).toBe(false);
    expect(s.buildingServiceCursor).toBe(4); // window = min(55, 4) = 4
  });

  it('limits the window to serviceBudget (cursor += budget)', () => {
    const buildings = Array.from({ length: 100 }, () => bld(false));
    const s = mkState({ buildings, serviceBudget: 55 });
    roundRobinServiceReset(s);
    expect(s.buildingServiceCursor).toBe(55);
  });

  it('limits the window to the remaining length (maxIndex - cursor)', () => {
    const buildings = Array.from({ length: 100 }, () => bld(false));
    const s = mkState({ buildings, serviceBudget: 55, buildingServiceCursor: 80 });
    roundRobinServiceReset(s);
    expect(s.buildingServiceCursor).toBe(100); // min(55, 100-80) = 20 → 80+20
  });

  it('wraps the cursor to 0 at cursor >= maxIndex', () => {
    const buildings = Array.from({ length: 10 }, () => bld(false));
    const s = mkState({ buildings, serviceBudget: 55, buildingServiceCursor: 10 });
    roundRobinServiceReset(s);
    expect(s.buildingServiceCursor).toBe(10); // wrap→0, then window min(55,10)=10 → 0+10
  });

  it('stops after 10 real clears and leaves the cursor on the 10th hit', () => {
    const buildings = Array.from({ length: 20 }, () => bld(true));
    const s = mkState({ buildings, serviceBudget: 55 });
    roundRobinServiceReset(s);
    // The first 10 are cleared, the cursor stays on index 9 (it stops before advancing).
    for (let i = 0; i < 10; i++) expect((buildings[i] as { serfRequestFailed: boolean }).serfRequestFailed).toBe(false);
    for (let i = 10; i < 20; i++) expect((buildings[i] as { serfRequestFailed: boolean }).serfRequestFailed).toBe(true);
    expect(s.buildingServiceCursor).toBe(9);
  });

  it('counts null slots when advancing the cursor, but not as hits', () => {
    const buildings: Bld[] = [null, bld(true), null];
    const s = mkState({ buildings, serviceBudget: 55 });
    roundRobinServiceReset(s);
    expect((buildings[1] as { serfRequestFailed: boolean }).serfRequestFailed).toBe(false);
    expect(s.buildingServiceCursor).toBe(3); // all 3 slots visited
  });

  it('clears serfRequestFail on flags in the same way', () => {
    const flags = [flg(true), flg(false), flg(true)];
    const s = mkState({ flags, serviceBudget: 55 });
    roundRobinServiceReset(s);
    for (const f of flags) expect((f as { serfRequestFail: boolean }).serfRequestFail).toBe(false);
    expect(s.flagServiceCursor).toBe(3);
  });

  it('is a no-op at maxIndex == 0', () => {
    const s = mkState({ buildings: [], maxBuildingIndex: 0, flags: [], maxFlagIndex: 0 });
    roundRobinServiceReset(s);
    expect(s.buildingServiceCursor).toBe(0);
    expect(s.flagServiceCursor).toBe(0);
  });
});
