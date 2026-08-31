import { describe, it, expect } from 'vitest';
import type { MapTile } from './types.js';
import {
  TERRAIN_COLOR,
  SHADE_LUT,
  minimapOffset,
  buildMinimap,
  minimapPixel,
  renderMinimapRGBA,
  drawMinimapWindow,
  drawMinimapWindowShrunk,
  MINIMAP_WINDOW_X,
  MINIMAP_WINDOW_Y,
} from './minimap.js';
import { mapPreviewOrigin } from './map-preview.js';
import { createFramebuffer } from './ui-render.js';

/** Minimal MapTile with settable terrainUp/height (rest 0). */
function tile(terrainUp: number, height: number): MapTile {
  return {
    height,
    terrainUp,
    terrainDown: 0,
    object: 0,
    owner: 0,
    paths: 0,
    blocked: false,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: 0,
  };
}

/** Builds a cols x rows map, terrainUp/height per tile from callbacks. */
function makeMap(
  cols: number,
  rows: number,
  terr: (mx: number, my: number) => number,
  h: (mx: number, my: number) => number = () => 0,
): MapTile[] {
  const out: MapTile[] = [];
  for (let my = 0; my < rows; my++) {
    for (let mx = 0; mx < cols; mx++) out.push(tile(terr(mx, my), h(mx, my)));
  }
  return out;
}

describe('minimap tables (byte for byte from the original)', () => {
  it('TERRAIN_COLOR: 16 u16 base colours @0xb0ac', () => {
    expect(TERRAIN_COLOR).toEqual([0, 85, 102, 119, 17, 17, 17, 17, 34, 34, 34, 51, 51, 51, 68, 68]);
  });

  it('SHADE_LUT: 136 bytes @0xb0cc, edges byte exact', () => {
    expect(SHADE_LUT).toHaveLength(136);
    // start: water base colour 0 -> flat = palette 8
    expect(SHADE_LUT.slice(0, 17)).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
    // grass ramp from index 17
    expect(SHADE_LUT[17]).toBe(31);
    expect(SHADE_LUT[25]).toBe(24); // grass flat (base 17 + shade 8)
    // end
    expect(SHADE_LUT[135]).toBe(11);
  });
});

describe('minimapOffset (block interleaved like gs+0x8c)', () => {
  it('cols=64 -> S=2: block (bc,br) at ((br<<2)|bc)*256, inside py*16+px', () => {
    const colShift = 6; // log2(64)
    expect(minimapOffset(0, 0, colShift)).toBe(0);
    expect(minimapOffset(1, 0, colShift)).toBe(1);
    expect(minimapOffset(0, 1, colShift)).toBe(16);
    // Pixel (16,0) → block (1,0) → offset 256
    expect(minimapOffset(16, 0, colShift)).toBe(256);
    // Pixel (0,16) → block (0,1) → offset (1<<2)·256 = 1024
    expect(minimapOffset(0, 16, colShift)).toBe(1024);
    // Pixel (17,16) → block (1,1), inside px=1/py=0 → ((1<<2)|1)·256 + 0·16+1 = 5·256+1 = 1281
    expect(minimapOffset(17, 16, colShift)).toBe(5 * 256 + 1);
  });
});

describe('buildMinimap (port of FUN_0000af12)', () => {
  it('a flat water map (terrainUp 0, height 0) -> palette 8 everywhere', () => {
    const cols = 16;
    const rows = 16;
    const mm = buildMinimap(makeMap(cols, rows, () => 0), cols, rows);
    expect(mm).toHaveLength(cols * rows);
    for (let my = 0; my < rows; my++) {
      for (let mx = 0; mx < cols; mx++) expect(minimapPixel(mm, mx, my, cols)).toBe(8);
    }
  });

  it('flat grass (terrainUp 4, height 0) → base 17 + shade 8 = SHADE_LUT[25] = 24', () => {
    const cols = 16;
    const rows = 16;
    const mm = buildMinimap(makeMap(cols, rows, () => 4), cols, rows);
    expect(minimapPixel(mm, 3, 3, cols)).toBe(24);
  });

  it('height shading: a higher lower neighbour -> brighter index (smaller SHADE_LUT offset)', () => {
    const cols = 16;
    const rows = 16;
    // Tile (my,hexcol) flat; lower neighbour (my+1) higher -> shade = hDown - hRight + 8 > 8.
    // Pick mx so that hexcol is known. For even my: hexcol = (my>>1 + mx) & 15.
    const h = (_mx: number, my: number) => (my === 1 ? 5 : 0); // row 1 higher
    const grass = makeMap(cols, rows, () => 4, h);
    const mm = buildMinimap(grass, cols, rows);
    // Tile in row 0: hDown (row 1) = 5, hRight (row 0) = 0 -> shade = 13 -> base 17+13 = SHADE_LUT[30]
    // Tile in row 5 (both neighbours 0): shade = 8 -> SHADE_LUT[25]
    const shaded = minimapPixel(mm, 4, 0, cols);
    const flat = minimapPixel(mm, 4, 5, cols);
    expect(shaded).toBe(SHADE_LUT[17 + 13]);
    expect(flat).toBe(SHADE_LUT[17 + 8]);
    expect(shaded).not.toBe(flat);
  });

  it('renderMinimapRGBA: maps the palette index through the palette into RGBA (opaque)', () => {
    const cols = 16;
    const rows = 16;
    const mm = buildMinimap(makeMap(cols, rows, () => 0), cols, rows); // all index 8
    const pal = new Uint8Array(256 * 4);
    pal[8 * 4] = 10;
    pal[8 * 4 + 1] = 20;
    pal[8 * 4 + 2] = 200; // index 8 = blue
    const rgba = renderMinimapRGBA(mm, cols, rows, pal);
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([10, 20, 200, 255]);
  });
});

describe('drawMinimapWindow (port of FUN_00042637, 8x8 block window)', () => {
  it('blits the expected blocks including the horizontal toroidal wrap', () => {
    const cols = 32;
    const rows = 32; // 2x2 blocks
    const colShift = 5;
    // Synthetic minimap: every block one colour with value = (br*2 + bc) + 1 (1..4).
    const mm = new Uint8Array(cols * rows);
    for (let my = 0; my < rows; my++) {
      for (let mx = 0; mx < cols; mx++) {
        mm[minimapOffset(mx, my, colShift)] = (my >> 4) * 2 + (mx >> 4) + 1;
      }
    }
    // Palette: index i -> (i,i,i), so the block value is readable from the R channel.
    const pal = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      pal[i * 4] = i;
      pal[i * 4 + 1] = i;
      pal[i * 4 + 2] = i;
    }
    const fb = createFramebuffer(160, 176);
    // cursor = (0x54, 0x38) -> r=0, startCol=0 -> start block (0,0).
    drawMinimapWindow(fb, mm, pal, cols, rows, 0x54, 0x38);
    const R = (bx: number, by: number): number => {
      const x = MINIMAP_WINDOW_X + bx * 16;
      const y = MINIMAP_WINDOW_Y + by * 16;
      return fb.rgba[(y * fb.width + x) * 4]!;
    };
    // Screen block column 0 -> source block 0 (value 1); column 1 -> block 1 (value 2);
    // column 2 -> wraps to block 0 (value 1); column 3 -> block 1 (value 2).
    expect(R(0, 0)).toBe(1);
    expect(R(1, 0)).toBe(2);
    expect(R(2, 0)).toBe(1);
    expect(R(3, 0)).toBe(2);
  });

  it('(ox,oy) shifts the whole window', () => {
    const cols = 16;
    const rows = 16; // 1 block
    const mm = new Uint8Array(cols * rows).fill(7);
    const pal = new Uint8Array(256 * 4);
    pal[7 * 4] = 123;
    const fb = createFramebuffer(200, 200);
    drawMinimapWindow(fb, mm, pal, cols, rows, 0, 0, 5, 6);
    // The first pixel of the window sits at (WINDOW_X+5, WINDOW_Y+6).
    const o = ((MINIMAP_WINDOW_Y + 6) * fb.width + (MINIMAP_WINDOW_X + 5)) * 4;
    expect(fb.rgba[o]).toBe(123);
  });
});

describe('drawMinimapWindowShrunk (extension)', () => {
  /** Palette in which index `i` appears as R channel `i`. */
  const idxPalette = (): Uint8Array => {
    const p = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      p[i * 4] = i;
      p[i * 4 + 3] = 255;
    }
    return p;
  };

  /**
   * The load-bearing test: at `tileStep == 1` the extension renderer MUST deliver the same pixels as
   * the original block blitter. That checks the origin conversion (tile <-> minimap coordinates) AND
   * the shear at the row wrap in one go — without the shear, over 8000 pixels differ on a 64x64 map
   * whose window covers two map heights.
   */
  for (const [cols, rows] of [
    [64, 64],
    [128, 64],
    [256, 128],
  ] as const) {
    it(`matches the original renderer at step 1 (${cols}x${rows})`, () => {
      // MEASUREMENT TRAP: the data must NOT be invariant under a shift by `rows/2` columns, otherwise
      // the test is blind to the wrap shear. Every LINEAR function of `mx` mod 16 (terrain) or mod 32
      // (height) is exactly that — 16 and 32 divide `rows/2`. Hence the coarse blocks (`>> 5`), which
      // do react to a shift.
      const tiles = makeMap(
        cols,
        rows,
        (mx, my) => (((mx >> 5) * 5 + (my >> 4) * 3) & 0xf),
        (mx, my) => (((mx >> 4) * 7 + (my >> 5) * 11) & 0x1f),
      );
      const mm = buildMinimap(tiles, cols, rows);
      const pal = idxPalette();
      for (const [cc, cr] of [
        [0x54, 0x38],
        [17, 25],
        [cols - 3, rows - 7],
      ] as const) {
        const a = createFramebuffer(144, 160);
        const b = createFramebuffer(144, 160);
        drawMinimapWindow(a, mm, pal, cols, rows, cc, cr);
        const o = mapPreviewOrigin(cc, cr, cols, rows, 1);
        drawMinimapWindowShrunk(b, mm, pal, cols, rows, o.col, o.row, 1);
        let diff = 0;
        for (let j = 0; j < 128; j++) {
          for (let i = 0; i < 128; i++) {
            const at = ((MINIMAP_WINDOW_Y + j) * a.width + MINIMAP_WINDOW_X + i) * 4;
            if (a.rgba[at] !== b.rgba[at]) diff++;
          }
        }
        expect(diff, `centre ${cc}/${cr}`).toBe(0);
      }
    });
  }

  it('covers four times the area at step 2 (every second tile)', () => {
    const cols = 256;
    const rows = 128;
    const tiles = makeMap(cols, rows, (mx) => (mx & 1 ? 2 : 8));
    const mm = buildMinimap(tiles, cols, rows);
    const pal = idxPalette();
    const f = createFramebuffer(144, 160);
    const o = mapPreviewOrigin(0x54 * 2, 0x38 * 2, cols, rows, 2);
    drawMinimapWindowShrunk(f, mm, pal, cols, rows, o.col, o.row, 2);
    // Every preview column samples an even minimap column => the same colour everywhere, not the
    // striped pattern. That proves the step size (at step 1 the columns alternated).
    const at = (i: number, j: number): number =>
      f.rgba[((MINIMAP_WINDOW_Y + j) * f.width + MINIMAP_WINDOW_X + i) * 4]!;
    const first = at(0, 0);
    let same = 0;
    for (let i = 0; i < 128; i++) if (at(i, 0) === first) same++;
    expect(same).toBe(128);
  });
});
