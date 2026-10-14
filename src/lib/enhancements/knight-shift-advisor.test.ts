import { describe, expect, it } from 'vitest';
import { predictShift, shiftLight } from './knight-shift-advisor.js';
import { PLAYER_FLAG_SHIFT_ACTIVE } from '../core/engine/player-settings.js';
import type { GameState, Player } from '../core/engine/state.js';

const KNIGHT0 = 22;
const IDLE_IN_STOCK = 1;
const DEFENDING = 72;

/** A human with full occupation at every threat level: max nibble 4, min 0. */
function player(over: Partial<Player> = {}): Player {
  return {
    index: 0,
    active: true,
    flags: 0x41,
    knightOccupation: [0x40, 0x40, 0x40, 0x40],
    ...over,
  } as unknown as Player;
}

/** A serf whose union byte 0xe/0xf (stateData[3..4]) points at the next knight of the chain. */
function knight(rank: number, next: number, state = DEFENDING): unknown {
  return { owner: 0, type: KNIGHT0 + rank, state, stateData: [0, 0, 0, next & 0xff, next >> 8] };
}

/**
 * One building of `type` with a garrison of the given ranks, plus idle knights in stock. Serf slot 0
 * is the null slot.
 */
function lay(type: number, garrison: number[], stock: number[], p = player()): { st: GameState; p: Player } {
  const serfs: unknown[] = [null];
  const first = garrison.length > 0 ? 1 : 0;
  garrison.forEach((rank, i) => serfs.push(knight(rank, i + 1 < garrison.length ? i + 2 : 0)));
  for (const rank of stock) serfs.push(knight(rank, 0, IDLE_IN_STOCK));
  const bld = { owner: 0, type, constructing: false, threatLevel: 0, firstKnight: first };
  const st = { buildings: [null, bld], serfs, players: [p] } as unknown as GameState;
  return { st, p };
}

describe('shift prediction', () => {
  it('sends home the weakest above the reduced target: a full garrison 12 -> 8', () => {
    const garrison = [4, 0, 3, 1, 2, 4, 0, 3, 1, 2, 4, 4];
    const { st, p } = lay(22, garrison, []);
    expect(predictShift(st, p).leaving).toEqual([0, 0, 1, 1]);
  });

  it('is red when no building would give a knight away', () => {
    // A guard hut at slider max 1: target 1, reduced 1.
    const { st, p } = lay(11, [0], [4, 4], player({ knightOccupation: [0x10, 0x10, 0x10, 0x10] }));
    expect(predictShift(st, p).leaving).toEqual([]);
    expect(shiftLight(st, p)).toBe('red');
  });

  it('is red when the stock holds nobody stronger', () => {
    const { st, p } = lay(11, [2, 2, 2], [2, 1, 0]); // hut 3 -> 2: one rank-2 knight leaves
    expect(shiftLight(st, p)).toBe('red');
  });

  it('does not count an equal rank as an upgrade', () => {
    const { st, p } = lay(11, [3, 3, 3], [3]);
    expect(predictShift(st, p).upgrades).toBe(0);
  });

  it('is yellow, not green, when fewer knights wait than would leave', () => {
    // Tower 6 -> 4: ranks 0 and 2 leave; only one K3 waits.
    const { st, p } = lay(21, [0, 2, 4, 4, 3, 3], [3]);
    expect(predictShift(st, p).upgrades).toBe(1);
    expect(shiftLight(st, p)).toBe('yellow');
  });

  it('is yellow when only some of the leavers get a stronger replacement', () => {
    // Tower 6 -> 4: ranks 0 and 2 leave; the stock has one K3, then a K1.
    const { st, p } = lay(21, [0, 2, 4, 4, 3, 3], [3, 1]);
    const pred = predictShift(st, p);
    expect(pred.leaving).toEqual([0, 2]);
    expect(pred.upgrades).toBe(1);
    expect(shiftLight(st, p)).toBe('yellow');
  });

  it('is green when every leaver gets a stronger replacement', () => {
    const { st, p } = lay(21, [0, 2, 4, 4, 3, 3], [4, 3]);
    expect(shiftLight(st, p)).toBe('green');
  });

  it('is red while a shift change runs', () => {
    const { st, p } = lay(21, [0, 2, 4, 4, 3, 3], [4, 3], player({ flags: 0x41 | PLAYER_FLAG_SHIFT_ACTIVE }));
    expect(shiftLight(st, p)).toBe('red');
  });

  it('ignores foreign buildings, construction sites and other building types', () => {
    for (const over of [{ owner: 1 }, { constructing: true }, { type: 24 }]) {
      const { st, p } = lay(21, [0, 2, 4, 4, 3, 3], [4, 3]);
      Object.assign((st.buildings as unknown[])[1] as object, over);
      expect(shiftLight(st, p)).toBe('red');
    }
  });
});
