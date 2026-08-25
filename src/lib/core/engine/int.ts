/**
 * Integer wraparound helpers for the deterministic tick engine.
 *
 * The original computes much of the game logic in **16-bit registers** (game tick, `serf.tick`,
 * `serf.counter`, RNG state). A JavaScript `number` is a 64-bit float, so without explicit masking
 * `counter -= delta` would not wrap on underflow the way the original does.
 */

/** Mask to unsigned 16 bits (0..65535). */
export function u16(x: number): number {
  return x & 0xffff;
}

/** u16 addition with wraparound. */
export function addU16(a: number, b: number): number {
  return (a + b) & 0xffff;
}

/** u16 subtraction with wraparound (underflow wraps to 0xffff, as in the x86 register). */
export function subU16(a: number, b: number): number {
  return (a - b) & 0xffff;
}

/** Interpret as a signed 16-bit number (-32768..32767). */
export function i16(x: number): number {
  return (x << 16) >> 16;
}

/** Interpret as a signed 8-bit number (-128..127), for signed union bytes such as `field_0xe`. */
export function i8(x: number): number {
  return (x << 24) >> 24;
}

/** 16-Bit-Rotation nach rechts um 1 (x86 `ror r16,1`). */
export function ror16(x: number): number {
  return ((x >>> 1) | (x << 15)) & 0xffff;
}

/** 16-Bit-Rotation nach links um 1 (x86 `rol r16,1`). */
export function rol16(x: number): number {
  return ((x << 1) | (x >>> 15)) & 0xffff;
}
