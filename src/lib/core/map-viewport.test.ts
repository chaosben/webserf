import { describe, expect, it } from 'vitest';
import {
  DOWN_ROW_X_UNITS,
  FIRST_HALF_ROW_Y,
  buildHalfRows,
  downRowTileCount,
  tileX,
  upRowTileCount,
  viewportSpan,
} from './map-viewport.js';
import { TILE_H, TILE_W } from './map-render.js';
import { colOf, mapGeometry, rowOf } from './engine/position.js';

const geo = mapGeometry(3); // 64x64, like all original saves

describe('viewportSpan', () => {
  it('nUp == nDown (the odd tileWidth makes sure of it)', () => {
    for (const w of [320, 640, 1280, 1920]) {
      const span = viewportSpan(w, 480);
      expect(upRowTileCount(span), `width ${w}`).toBe(downRowTileCount(span));
      expect(span.tileWidth % 2, `width ${w}`).toBe(1);
    }
  });

  it('TILE ALIGNED it is 21 tiles at 640 px = exactly the 84-byte descriptor', () => {
    // Counter-check against the original: its window is tile aligned (`ViewportScroll`), 21 tile
    // pointers x 4 B = 0x54. Ours is deliberately ONE tile above — the price of pixel-smooth
    // scrolling, and this calculation makes the difference explicit.
    const tileAligned = Math.ceil(640 / TILE_W) + 1; // without the sub-tile margin
    expect(tileAligned).toBe(21);
    expect(tileAligned * 4).toBe(0x54);
    expect(upRowTileCount(viewportSpan(640, 480))).toBe(tileAligned + 1);
  });

  it('the up row covers the width despite its -16 px offset', () => {
    // The reason for the odd `tileWidth`: otherwise 16 px are missing on the right. The reach must
    // also cover the sub-tile remainder (up to TILE_W-1) — otherwise a strip at the right edge
    // stays uncovered (measured, see the `viewportSpan` docs).
    for (const w of [320, 640, 1280, 1920]) {
      const span = viewportSpan(w, 480);
      const reach = upRowTileCount(span) * TILE_W - TILE_W / 2;
      expect(reach, `width ${w}`).toBeGreaterThanOrEqual(w + TILE_W - 1);
    }
  });

  it('the half-row count follows the height range, not a fixed value', () => {
    // The range `maxHeight*4` must fit into half rows, otherwise the lower edge stays black. On a
    // flat map correspondingly fewer are allowed.
    const flat = viewportSpan(640, 480, 0).halfRows;
    const hilly = viewportSpan(640, 480, 31).halfRows;
    expect(hilly - flat).toBe(Math.ceil((31 * 4) / TILE_H));
    // And the safe default equals the maximum.
    expect(viewportSpan(640, 480).halfRows).toBe(hilly);
  });

  it('the field of view grows linearly with the window size (apart from the constant margins)', () => {
    const a = viewportSpan(640, 480, 0);
    const b = viewportSpan(1280, 960, 0);
    expect(downRowTileCount(b)).toBeGreaterThan(downRowTileCount(a) * 1.8);
    expect(b.halfRows).toBeGreaterThan(a.halfRows * 1.8);
  });
});

describe('buildHalfRows — structure', () => {
  const span = viewportSpan(640, 480);
  const rows = buildHalfRows({ col: 10, row: 20 }, geo, span);

  it('yields exactly `halfRows` half rows, alternating up/down starting with up', () => {
    expect(rows).toHaveLength(span.halfRows);
    expect(rows[0]!.kind).toBe('up');
    expect(rows[1]!.kind).toBe('down');
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.kind, `half row ${i}`).toBe(i % 2 === 0 ? 'up' : 'down');
    }
  });

  it('y starts at -4 and grows per half row by the triangle row height', () => {
    expect(rows[0]!.y).toBe(FIRST_HALF_ROW_Y);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.y - rows[i - 1]!.y).toBe(TILE_H);
    }
  });

  it('the xOffset of the original bookkeeping alternates 0 / -16 px (half a tile)', () => {
    // Note: this is NOT the triangle position — `terrainTriangle` provides that from the source
    // tile (see the module docs; verified against the original data).
    expect(rows[0]!.xOffset).toBe(0);
    expect(rows[1]!.xOffset).toBe(DOWN_ROW_X_UNITS * 8);
    expect(rows[1]!.xOffset).toBe(-TILE_W / 2);
  });

  it('tile count per half row follows nUp/nDown', () => {
    expect(rows[0]!.tiles).toHaveLength(upRowTileCount(span));
    expect(rows[1]!.tiles).toHaveLength(downRowTileCount(span));
  });

  it('tileX counts in whole tile widths from the row xOffset', () => {
    expect(tileX(rows[0]!, 0)).toBe(0);
    expect(tileX(rows[0]!, 3)).toBe(3 * TILE_W);
    expect(tileX(rows[1]!, 0)).toBe(-TILE_W / 2);
  });
});

describe('buildHalfRows — traversal', () => {
  const span = viewportSpan(640, 480);

  it('the first tile is the scroll position', () => {
    const rows = buildHalfRows({ col: 7, row: 9 }, geo, span);
    expect(colOf(rows[0]!.tiles[0]!, geo)).toBe(7);
    expect(rowOf(rows[0]!.tiles[0]!, geo)).toBe(9);
  });

  it('within a half row it goes column by column to the right, row constant', () => {
    const rows = buildHalfRows({ col: 5, row: 5 }, geo, span);
    const t = rows[0]!.tiles;
    for (let k = 0; k < t.length; k++) {
      expect(colOf(t[k]!, geo), `tile ${k}`).toBe((5 + k) & geo.colMask);
      expect(rowOf(t[k]!, geo), `tile ${k}`).toBe(5);
    }
  });

  it('half-row starts: alternating down and down-right => every two rows row+2, col+1', () => {
    const rows = buildHalfRows({ col: 12, row: 30 }, geo, span);
    const startCol = (i: number) => colOf(rows[i]!.tiles[0]!, geo);
    const startRow = (i: number) => rowOf(rows[i]!.tiles[0]!, geo);
    for (let i = 0; i + 1 < rows.length; i++) {
      const dCol = (startCol(i + 1) - startCol(i)) & geo.colMask;
      const dRow = (startRow(i + 1) - startRow(i)) & geo.rowMask;
      expect(dRow, `half row ${i}→${i + 1}`).toBe(1);
      // up→down = down (col unchanged); down→up = down-right (col+1)
      expect(dCol, `half row ${i}→${i + 1}`).toBe(rows[i]!.kind === 'up' ? 0 : 1);
    }
    // Over two half rows: row+2, col+1 — that is the shear compensation
    // (2 rows x 16 px offset = 32 px = one tile width).
    expect((startRow(2) - startRow(0)) & geo.rowMask).toBe(2);
    expect((startCol(2) - startCol(0)) & geo.colMask).toBe(1);
  });
});

describe('buildHalfRows — one map row per half row (load-bearing assumption of the entity passes)', () => {
  // The entity layers (objects/buildings/serfs) simply walk the half rows. That is only correct
  // when no tile occurs in two half rows — otherwise everything would be drawn twice (and serfs
  // laid over buildings twice).
  const span = viewportSpan(640, 480);

  it('no tile appears in two half rows', () => {
    const rows = buildHalfRows({ col: 12, row: 12 }, geo, span);
    const seen = new Set<number>();
    for (const r of rows) {
      for (const p of r.tiles) {
        expect(seen.has(p), `tile ${p} twice`).toBe(false);
        seen.add(p);
      }
    }
    expect(seen.size).toBe(rows.reduce((n, r) => n + r.tiles.length, 0));
  });

  it('every half row lies entirely in ONE map row, ascending', () => {
    const rows = buildHalfRows({ col: 12, row: 12 }, geo, span);
    for (let i = 0; i < rows.length; i++) {
      const rs = new Set(Array.from(rows[i]!.tiles, (p) => rowOf(p, geo)));
      expect(rs.size, `half row ${i} spreads over several rows`).toBe(1);
      expect([...rs][0]).toBe((12 + i) & geo.rowMask);
    }
  });
});

describe('buildHalfRows — torus wrap (the "infinite scrolling")', () => {
  const span = viewportSpan(640, 480);

  it('a wrap past the last column stays in the same row', () => {
    // The core of the original mechanism: the gap bit of the in-RAM position catches the overflow
    // and the mask gs[0] clears it -> column 0 of the SAME row.
    const rows = buildHalfRows({ col: 60, row: 17 }, geo, span);
    const t = rows[0]!.tiles;
    for (let k = 0; k < t.length; k++) {
      expect(rowOf(t[k]!, geo), `tile ${k} after the wrap`).toBe(17);
      expect(colOf(t[k]!, geo)).toBe((60 + k) & 63);
    }
    // The seam lies inside the window: column 63 -> 0.
    const cols = Array.from(t, (p) => colOf(p, geo));
    expect(cols).toContain(63);
    expect(cols).toContain(0);
  });

  it('a wrap past the last row continues at the top', () => {
    const rows = buildHalfRows({ col: 3, row: 62 }, geo, span);
    const startRows = rows.map((r) => rowOf(r.tiles[0]!, geo));
    expect(startRows[0]).toBe(62);
    expect(startRows[1]).toBe(63);
    expect(startRows[2]).toBe(0); // past the edge
  });

  it('every scroll position yields only valid map positions', () => {
    for (const [col, row] of [
      [0, 0],
      [63, 63],
      [63, 0],
      [0, 63],
      [31, 47],
    ] as const) {
      const rows = buildHalfRows({ col, row }, geo, span);
      for (const r of rows) {
        for (const p of r.tiles) {
          expect(p, `Scroll (${col},${row})`).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThan(geo.tileCount);
        }
      }
    }
  });

  it('scrolling across the whole map lands back at the starting image', () => {
    const a = buildHalfRows({ col: 9, row: 9 }, geo, span);
    const b = buildHalfRows({ col: 9 + geo.cols, row: 9 + geo.rows }, geo, span);
    for (let i = 0; i < a.length; i++) {
      expect(Array.from(b[i]!.tiles), `half row ${i}`).toEqual(Array.from(a[i]!.tiles));
    }
  });

  it('a negative scroll (up/left past the edge) is valid and wraps', () => {
    const rows = buildHalfRows({ col: -2, row: -1 }, geo, span);
    expect(colOf(rows[0]!.tiles[0]!, geo)).toBe(62);
    expect(rowOf(rows[0]!.tiles[0]!, geo)).toBe(63);
  });
});

describe('buildHalfRows — centring offset (vp[0x4a]/0x4c, in TILES)', () => {
  it('shifts the start tile by whole tiles', () => {
    const span = viewportSpan(640, 480);
    const rows = buildHalfRows(
      { col: 10, row: 10, centerOffsetCol: 1, centerOffsetRow: 2 },
      geo,
      span,
    );
    expect(colOf(rows[0]!.tiles[0]!, geo)).toBe(9);
    expect(rowOf(rows[0]!.tiles[0]!, geo)).toBe(8);
  });
});

describe('viewport coverage', () => {
  it('covers every screen row and draws no tile twice within a half row', () => {
    const span = viewportSpan(640, 480);
    const rows = buildHalfRows({ col: 20, row: 20 }, geo, span);
    for (const r of rows) {
      expect(new Set(Array.from(r.tiles)).size, 'no duplicates within the half row').toBe(
        r.tiles.length,
      );
    }
    // Together the half rows cover at least the window height.
    const last = rows[rows.length - 1]!;
    expect(last.y + TILE_H).toBeGreaterThanOrEqual(480);
  });
});
