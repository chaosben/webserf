import { describe, it, expect } from 'vitest';
import { parseAnimationTable, loadAnimationTable } from './animation-parser.js';
import { PaArchive } from './pa-parser.js';
import { readOriginal } from '../testing/originals.js';

const loadOrigFile = (name: string): Buffer | null => readOriginal(name);

/**
 * Builds a valid animation table with `count` animations, all empty (0 frames), plus optionally
 * `extraFrameBytes` of frame data at the end for animation `count-1`.
 */
function makeEmptyTable(count: number, extraFrameBytes = 0): Uint8Array {
  // size = 4 (size-header) + count*4 (offsets) + extraFrameBytes
  const size = 4 + count * 4 + extraFrameBytes;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, size, false); // size-Header (BE)
  // All offsets point at the end of the table = count*4 -> 0 frames per animation
  // (except the last one, which runs to the end of the buffer)
  for (let i = 0; i < count; i++) {
    dv.setUint32(4 + i * 4, count * 4, false);
  }
  return buf;
}

describe('parseAnimationTable — synthetisch', () => {
  it('wirft bei zu kleinem Buffer', () => {
    expect(() => parseAnimationTable(new Uint8Array(4))).toThrow(/too small for the header/);
  });

  it('throws when the size header does not match the file length', () => {
    const buf = new Uint8Array(4 + 200 * 4 + 100);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 999999, false); // falsch
    expect(() => parseAnimationTable(buf)).toThrow(/size header/);
  });

  it('throws when the first offset is invalid (not divisible by 4)', () => {
    const size = 4 + 200 * 4;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, size, false);
    dv.setUint32(4, 7, false); // 7 is not divisible by 4
    expect(() => parseAnimationTable(buf)).toThrow(/first offset/);
  });

  it('parses a minimal valid table with 200 animations (all empty)', () => {
    const buf = makeEmptyTable(200);
    const table = parseAnimationTable(buf);
    expect(table.animations.length).toBe(200);
    for (const anim of table.animations) {
      expect(anim.length).toBe(0);
    }
  });

  it('auto detection: 50 animations (instead of 200) are recognised', () => {
    const buf = makeEmptyTable(50);
    const table = parseAnimationTable(buf);
    expect(table.animations.length).toBe(50);
  });

  it('auto detection: 500 animations (instead of 200) are recognised', () => {
    const buf = makeEmptyTable(500);
    const table = parseAnimationTable(buf);
    expect(table.animations.length).toBe(500);
  });

  it('parses frame data correctly (1 animation with 2 frames)', () => {
    const count = 200;
    const size = 4 + count * 4 + 2 * 3;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, size, false);
    // Animation 0 starts at offset 800 and has 2 frames (6 bytes)
    dv.setUint32(4 + 0 * 4, count * 4, false); // 800
    // Animation 1..199 zeigen ans Ende (= 806)
    for (let i = 1; i < count; i++) {
      dv.setUint32(4 + i * 4, count * 4 + 6, false);
    }
    // 2 frames for animation 0
    const frameBase = 4 + count * 4;
    buf[frameBase + 0] = 42;  // sprite
    buf[frameBase + 1] = 200; // x (= -56 als int8)
    buf[frameBase + 2] = 7;   // y
    buf[frameBase + 3] = 100; // sprite
    buf[frameBase + 4] = 0;   // x
    buf[frameBase + 5] = 250; // y (= -6 als int8)

    const table = parseAnimationTable(buf);
    expect(table.animations[0]!.length).toBe(2);
    expect(table.animations[0]![0]).toEqual({ sprite: 42, x: -56, y: 7 });
    expect(table.animations[0]![1]).toEqual({ sprite: 100, x: 0, y: -6 });
    expect(table.animations[1]!.length).toBe(0);
  });
});

describe.runIf(loadOrigFile('SPAD.PA') !== null)('parseAnimationTable — gegen Original SPAD.PA', () => {
  it('parst Entry #1 (30528 Bytes) als 200-Animationen-Tabelle (Standard-Format)', () => {
    const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
    const table = loadAnimationTable(arch);
    expect(table.animations.length).toBe(200);
  });

  it('frames have plausible sizes (no empty animation, sane frame counts)', () => {
    const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
    const table = loadAnimationTable(arch);
    const nonEmpty = table.animations.filter((a) => a.length > 0).length;
    expect(nonEmpty).toBeGreaterThan(table.animations.length / 2);
    for (const anim of table.animations) {
      expect(anim.length).toBeLessThan(1000);
    }
  });

  it('the first animation has plausible frame data', () => {
    const arch = PaArchive.parse(loadOrigFile('SPAD.PA')!);
    const table = loadAnimationTable(arch);
    const anim0 = table.animations[0]!;
    for (const frame of anim0) {
      expect(frame.x).toBeGreaterThanOrEqual(-128);
      expect(frame.x).toBeLessThanOrEqual(127);
      expect(frame.y).toBeGreaterThanOrEqual(-128);
      expect(frame.y).toBeLessThanOrEqual(127);
    }
  });
});
