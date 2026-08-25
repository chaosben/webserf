import { describe, it, expect } from 'vitest';
import {
  buildCursorMarkers,
  CURSOR_MARKER_CENTER,
  CURSOR_MARKER_RING,
} from './cursor-marker-layer.js';
import { CURSOR_MARKER_FLAG, CURSOR_MARKER_NONE } from './ui-render.js';
import { DIR_DELTA } from './engine/position.js';

const anchor = { x: 100, y: 200 };
/** Flat map: every tile height 10, so the height term drops out and the deltas stand bare. */
const flat = () => 10;

describe('buildCursorMarkers (FUN_00015daf)', () => {
  it('liefert 7 Records: Cursor + 6 Nachbarn in DIR_DELTA-Reihenfolge', () => {
    const m = buildCursorMarkers({
      anchor,
      col: 20,
      row: 20,
      heightAt: flat,
      markers: null,
      heightUnit: 4,
    });
    expect(m).toHaveLength(7);
 // Record 0 sits EXACTLY on the tile anchor: the (+0x10, +8) of the marker blit is the same one
 // the map object blit adds (@0x34590/94 vs. @0x349d9/dd) — measured against an original capture,
 // where marker and hut share the drawing point.
    expect(m[0]!.x).toBe(anchor.x);
    expect(m[0]!.y).toBe(anchor.y);
 // Records 1..6 sit on the neighbours: x = 32*dcol - 16*drow, y = 20*drow.
    DIR_DELTA.forEach(([dcol, drow], i) => {
      const r = m[i + 1]!;
      expect(r.x - m[0]!.x).toBe(32 * dcol - 16 * drow);
      expect(r.y - m[0]!.y).toBe(20 * drow);
    });
  });

  it('reproduces the delta table exactly (the original cumulative x values)', () => {
    const m = buildCursorMarkers({
      anchor,
      col: 20,
      row: 20,
      heightAt: flat,
      markers: null,
      heightUnit: 4,
    });
 // From the binary: +0x20, -0x10, -0x20, -0x10, +0x10, +0x20 (cumulative from the cursor x)
    expect(m.map((r) => r.x - m[0]!.x)).toEqual([0, 32, 16, -16, -32, -16, 16]);
 // y-Extra: 0, 0, +0x14, +0x14, 0, −0x14, −0x14
    expect(m.map((r) => r.y - m[0]!.y)).toEqual([0, 0, 20, 20, 0, -20, -20]);
  });

  it('reproduces the constellation measured on an original capture', () => {
 // Measured by exact template match against the original picture:
 // main symbol and hut share the drawing point (128, 212), and the six dot markers sit at these
 // offsets relative to it. The y extras beyond 20*drow are multiples of 4 and give exactly the
 // height differences below — so the height term is backed by real pixels.
    const dh = new Map([
      ['-1,-1', 4], // UpLeft is 4 steps higher => -20 - 16
      ['0,-1', 4], // Up ebenso
      ['1,0', 0],
      ['-1,0', 0],
      ['1,1', -2], // DownRight 2 Stufen tiefer ⇒ +20 + 8
      ['0,1', -3], // Down 3 Stufen tiefer ⇒ +20 + 12
    ]);
    const h0 = 12;
    const heightAt = (c: number, r: number): number =>
      h0 + (dh.get(`${c - 20},${r - 20}`) ?? 0);
    const m = buildCursorMarkers({
      anchor: { x: 128, y: 212 },
      col: 20,
      row: 20,
      heightAt,
      markers: null,
      heightUnit: 4,
    });
    expect(m[0]!).toMatchObject({ x: 128, y: 212 });
    expect(m.slice(1).map((r) => [r.x - 128, r.y - 212])).toEqual([
      [32, 0], // Right
      [16, 28], // DownRight
      [-16, 32], // Down
      [-32, 0], // Left
      [-16, -36], // UpLeft
      [16, -36], // Up
    ]);
  });

  it('lifts every tile by its OWN height (4*(h_cursor - h_neighbour))', () => {
 // Only the right neighbour is 3 steps higher, so its marker sits 12 px higher.
    const heightAt = (c: number, r: number): number => (c === 21 && r === 20 ? 13 : 10);
    const m = buildCursorMarkers({
      anchor,
      col: 20,
      row: 20,
      heightAt,
      markers: null,
      heightUnit: 4,
    });
    expect(m[1]!.y - m[0]!.y).toBe(-12); // Right: 4·(10−13)
    expect(m[2]!.y - m[0]!.y).toBe(20); // DownRight unchanged
  });

  it('without a marker pair the init sprites stay (arrows + 6 dots)', () => {
    const m = buildCursorMarkers({
      anchor,
      col: 5,
      row: 5,
      heightAt: flat,
      markers: null,
      heightUnit: 4,
    });
    expect(m.map((r) => r.sprite)).toEqual([
      CURSOR_MARKER_CENTER,
      CURSOR_MARKER_RING,
      CURSOR_MARKER_RING,
      CURSOR_MARKER_RING,
      CURSOR_MARKER_RING,
      CURSOR_MARKER_RING,
      CURSOR_MARKER_RING,
    ]);
  });

  it('puts the marker pair into record 0 and record 2 — and record 2 is DownRight', () => {
    const m = buildCursorMarkers({
      anchor,
      col: 5,
      row: 5,
      heightAt: flat,
      markers: { primary: 0x32, secondary: CURSOR_MARKER_FLAG },
      heightUnit: 4,
    });
    expect(m[0]!.sprite).toBe(0x32); // Haupt-Symbol (hier: Burg)
    expect(m[2]!.sprite).toBe(CURSOR_MARKER_FLAG);
 // Record 2 sits on DownRight (+1,+1) — exactly the tile the building's flag lands on.
    expect(DIR_DELTA[1]).toEqual([1, 1]);
    expect(m[2]!.x - m[0]!.x).toBe(16);
    expect(m[2]!.y - m[0]!.y).toBe(20);
 // The other five stay dots.
    expect([m[1]!.sprite, m[3]!.sprite, m[4]!.sprite, m[5]!.sprite, m[6]!.sprite]).toEqual(
      new Array(5).fill(CURSOR_MARKER_RING),
    );
  });

  it('respektiert heightUnit 0 (flache Top-Down-Ansicht)', () => {
    const heightAt = (c: number): number => (c === 21 ? 31 : 0);
    const m = buildCursorMarkers({
      anchor,
      col: 20,
      row: 20,
      heightAt,
      markers: { primary: CURSOR_MARKER_CENTER, secondary: CURSOR_MARKER_NONE },
      heightUnit: 0,
    });
    expect(m[1]!.y - m[0]!.y).toBe(0); // no height lift
  });
});
