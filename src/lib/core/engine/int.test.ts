import { describe, it, expect } from 'vitest';
import { u16, addU16, subU16, i16, ror16, rol16 } from './int.js';

describe('int - u16/i16 wraparound', () => {
  it('u16 masks to 16 bits', () => {
    expect(u16(0)).toBe(0);
    expect(u16(0xffff)).toBe(0xffff);
    expect(u16(0x10000)).toBe(0);
    expect(u16(0x1abcd)).toBe(0xabcd);
  });

  it('addU16 wraps on overflow', () => {
    expect(addU16(0xffff, 1)).toBe(0);
    expect(addU16(0x8000, 0x8000)).toBe(0);
    expect(addU16(40744, 3072)).toBe(43816); // example from SAVE3 -> SAVE4
  });

  it('subU16 wraps on underflow (register semantics)', () => {
    expect(subU16(0, 1)).toBe(0xffff);
    expect(subU16(3, 5)).toBe(0xfffe);
    expect(subU16(43816, 40744)).toBe(3072);
  });

  it('i16 honours the sign bit', () => {
    expect(i16(0)).toBe(0);
    expect(i16(0x7fff)).toBe(32767);
    expect(i16(0x8000)).toBe(-32768);
    expect(i16(0xffff)).toBe(-1);
  });

  it('ror16 rotates right by 1', () => {
    expect(ror16(2)).toBe(1);
    expect(ror16(1)).toBe(0x8000); // bit 0 moves to bit 15
    expect(ror16(0x8006)).toBe(0x4003);
    expect(ror16(5)).toBe(0x8002);
  });

  it('rol16 inverts ror16', () => {
    for (const x of [0, 1, 5, 0x8006, 0xffff, 0x1234]) {
      expect(rol16(ror16(x))).toBe(x & 0xffff);
    }
  });
});
