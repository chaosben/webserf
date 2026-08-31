/**
 * Deterministic random generator — bit-exact port of `@0x28c54`.
 *
 * The state is three u16 (`gs+0x212/0x214/0x216`), seeded from the save header `random[3]`
 * (`.DS` offsets 84/86/88). Per draw:
 *
 * ```
 * r  = ((s0 + s1) ^ s2) & 0xffff      // return value (= new s0)
 * s2 = (s2 + s1) & 0xffff
 * s1 = ror16(s1 ^ s2)                 // s2 already updated at this point
 * s2 = ror16(s2)
 * s0 = r
 * ```
 *
 * The state is deliberately JSON-serialisable (plain `number[]`) so that `GameState` snapshots are
 * complete — reproducibility, lockstep multiplayer, AI observation.
 */

import { u16, ror16 } from './int.js';

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;

  constructor(seed: readonly [number, number, number]) {
    this.s0 = u16(seed[0]);
    this.s1 = u16(seed[1]);
    this.s2 = u16(seed[2]);
  }

  /** Next 16-bit random value (0..65535). */
  next(): number {
    const r = ((this.s0 + this.s1) ^ this.s2) & 0xffff;
    this.s2 = u16(this.s2 + this.s1);
    this.s1 = ror16((this.s1 ^ this.s2) & 0xffff);
    this.s2 = ror16(this.s2);
    this.s0 = r;
    return r;
  }

  /** Read the current state as a serialisable triple. */
  getState(): [number, number, number] {
    return [this.s0, this.s1, this.s2];
  }

  /** Set the state (snapshot restore). */
  setState(state: readonly [number, number, number]): void {
    this.s0 = u16(state[0]);
    this.s1 = u16(state[1]);
    this.s2 = u16(state[2]);
  }
}
