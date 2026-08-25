/**
 * Overview minimap — port of the original's minimap builder (`FUN_0000af12` @0xaf12).
 *
 * The original keeps a one-byte-per-tile minimap (a palette index per tile) in an arena of its own
 * (`gs+0x8c`), computed from the landscape tuples (`gs+0x24` = our {@link MapTile}s). That minimap is
 * the data source of the **overview map** (popup screen 1/2, `FUN_00042637`).
 *
 * **Byte-exact algorithm** (`FUN_0000af12`): per minimap pixel `(mx, my)`
 *   1. hex shear of the column: `hexcol = ((my >> 1) + mx) & (cols-1)` (the same isometric shear as in
 *      the main map renderer — every row is offset by `row/2`),
 *   2. terrain base colour: `base = TERRAIN_COLOR[terrainUp]` (16-entry table `@0xb0ac`, u16),
 *   3. height shading: `shade = height(down) - height(right) + 8` (neighbour heights of the tile),
 *   4. palette index: `SHADE_LUT[base + shade]` (136-byte table `@0xb0cc`).
 *
 * Both tables are transcribed from the original binary; the resulting byte is an index into the game
 * palette (the same one as for the game sprites).
 *
 * The minimap is stored **block-interleaved** — exactly like `gs+0x8c`: 16x16-pixel blocks, block
 * `(bc, br)` at byte offset `((br << S) | bc)*256`, row-major inside a block (`py*16 + px`), where
 * `S = log2(cols) - 4`. That way the original's window blitter reads the blocks as contiguous 256-byte
 * runs.
 */

import type { MapTile } from './types.js';
import type { Framebuffer } from './ui-render.js';

/**
 * Terrain base colour table (`@0xb0ac`, 16 x u16), indexed by the up triangle's terrain type
 * (`terrainUp`, 0..15). The value is a base offset into {@link SHADE_LUT}. (0..3 = water levels,
 * 4..7 grass, 8..10/11..13/14..15 further terrain classes.)
 */
export const TERRAIN_COLOR: readonly number[] = [
  0, 85, 102, 119, 17, 17, 17, 17, 34, 34, 34, 51, 51, 51, 68, 68,
];

/**
 * Shading LUT (`@0xb0cc`, 136 bytes), indexed by `base + shade` (`base` from {@link TERRAIN_COLOR},
 * `shade = height(down) - height(right) + 8`). The value is the minimap tile's final palette index.
 */
export const SHADE_LUT: readonly number[] = [
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
  8, 31, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18,
  17, 16, 63, 63, 62, 61, 61, 60, 59, 59, 58, 57, 57, 56, 55, 55,
  54, 53, 53, 61, 61, 60, 60, 59, 59, 58, 57, 56, 55, 54, 53, 52,
  51, 50, 49, 48, 47, 47, 46, 46, 45, 44, 43, 42, 41, 40, 39, 38,
  37, 36, 35, 34, 33, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
  10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 11, 11, 11,
  11, 11, 11, 11, 11, 11, 11, 11,
];

/** Integer base-2 logarithm (expects a true power of two > 0). */
function log2(n: number): number {
  let s = 0;
  while (n > 1) {
    n >>= 1;
    s++;
  }
  return s;
}

/**
 * Block-interleaved byte offset of a minimap pixel `(mx, my)` — identical to the memory layout of
 * `gs+0x8c`: 16x16 blocks, block `(mx>>4, my>>4)` at `((br << S) | bc)*256`, row-major inside.
 * `colShift = log2(cols)`, `S = colShift - 4`.
 */
export function minimapOffset(mx: number, my: number, colShift: number): number {
  const S = colShift - 4;
  const bc = mx >> 4;
  const br = my >> 4;
  return (((br << S) | bc) << 8) + (my & 15) * 16 + (mx & 15);
}

/**
 * Builds the overview minimap (1 byte = palette index per tile) from the landscape data — a byte-exact
 * port of `FUN_0000af12`. The result is **block-interleaved** like `gs+0x8c` (length `cols*rows`).
 *
 * `mapTiles` is row-major (`pos = my*cols + mx`); `cols`/`rows` must be powers of two >= 16 (original
 * map geometry). Neighbours wrap **toroidally** (like the original's byte masks). `base + shade` is
 * clamped defensively to the LUT range — on valid maps the index stays inside `[0, 135]` anyway.
 */
export function buildMinimap(mapTiles: readonly MapTile[], cols: number, rows: number): Uint8Array {
  const colShift = log2(cols);
  const colMask = cols - 1;
  const rowMask = rows - 1;
  const out = new Uint8Array(cols * rows);
  for (let my = 0; my < rows; my++) {
    const downRow = (my + 1) & rowMask;
    for (let mx = 0; mx < cols; mx++) {
      const hexcol = ((my >> 1) + mx) & colMask;
      const tile = mapTiles[my * cols + hexcol]!;
      // Neighbour heights: right (same row, hexcol+1) and down (row+1, same hexcol).
      const hRight = mapTiles[my * cols + ((hexcol + 1) & colMask)]!.height;
      const hDown = mapTiles[downRow * cols + hexcol]!.height;
      const shade = hDown - hRight + 8;
      let idx = TERRAIN_COLOR[tile.terrainUp]! + shade;
      if (idx < 0) idx = 0;
      else if (idx >= SHADE_LUT.length) idx = SHADE_LUT.length - 1;
      out[minimapOffset(mx, my, colShift)] = SHADE_LUT[idx]!;
    }
  }
  return out;
}

/** Reads the palette index of a minimap pixel `(mx, my)` from the block-interleaved buffer. */
export function minimapPixel(minimap: Uint8Array, mx: number, my: number, cols: number): number {
  return minimap[minimapOffset(mx, my, log2(cols))]!;
}

// --- 8x8 block window (build popup screen 1/2, `FUN_00042637`) ------------------------------

/** Edge length of the preview window in 16x16 blocks (original loop `vreg4/vreg5 = 7`, 8 passes). */
export const MINIMAP_WINDOW_BLOCKS = 8;
/** Drawing origin of the window inside the popup (original `+8/+9`, the usual (8,9) frame margin). */
export const MINIMAP_WINDOW_X = 8;
export const MINIMAP_WINDOW_Y = 9;

/**
 * Writes a palette-indexed pixel opaquely into the framebuffer (with clipping) — the pixel primitive
 * of the original's map renderers (`FUN_000009a0`).
 */
export function plotPaletteIndex(
  fb: Framebuffer,
  x: number,
  y: number,
  palIndex: number,
  palette: Uint8Array | Uint8ClampedArray,
): void {
  if (x < 0 || y < 0 || x >= fb.width || y >= fb.height) return;
  const src = palIndex * 4;
  const o = (y * fb.width + x) * 4;
  fb.rgba[o] = palette[src]!;
  fb.rgba[o + 1] = palette[src + 1]!;
  fb.rgba[o + 2] = palette[src + 2]!;
  fb.rgba[o + 3] = 255;
}

/**
 * Draws the **8x8 block map preview window** of the build selection for large buildings (popup screen
 * 1/2) — a byte-exact port of the base renderer `FUN_00042637`. Blits a 128x128 window from the
 * {@link buildMinimap} minimap centred on `(centerCol, centerRow)` (tile coordinates of the window
 * centre, original `vp+0x74`/`vp+0x76`), **wrapped toroidally** and with the **hex shear on the
 * vertical wrap** (original: `startBlockCol += rowsBlocks/2` on the row wrap). Each block is a
 * contiguous 256-byte run (16x16 palette indices).
 *
 * Overlays (ownership/roads/buildings/border) and the cursor marker are **not** part of this routine —
 * as in the original they live in routines of their own (`map-preview.ts`). `(ox, oy)` shifts the whole
 * window.
 */
export function drawMinimapWindow(
  fb: Framebuffer,
  minimap: Uint8Array,
  palette: Uint8Array | Uint8ClampedArray,
  cols: number,
  rows: number,
  centerCol: number,
  centerRow: number,
  ox = 0,
  oy = 0,
): void {
  const colMask = cols - 1;
  const rowMask = rows - 1;
  const colsBlocks = cols >> 4;
  const rowsBlocks = rows >> 4;

  // Window anchor: centre minus fixed centring offsets (original 0x38/0x54), hex shear, then /16.
  const r = (centerRow - 0x38) & rowMask;
  const startCol = (centerCol - (r >> 1) - 0x54) & colMask;
  let blockCol0 = startCol >> 4;
  let blockRow = r >> 4;

  for (let sr = 0; sr < MINIMAP_WINDOW_BLOCKS; sr++) {
    let blockCol = blockCol0;
    for (let sc = 0; sc < MINIMAP_WINDOW_BLOCKS; sc++) {
      const srcOffset = ((blockRow << (log2(cols) - 4)) | blockCol) << 8;
      const sx = sc * 16 + MINIMAP_WINDOW_X + ox;
      const sy = sr * 16 + MINIMAP_WINDOW_Y + oy;
      for (let py = 0; py < 16; py++) {
        for (let px = 0; px < 16; px++) {
          plotPaletteIndex(fb, sx + px, sy + py, minimap[srcOffset + py * 16 + px]!, palette);
        }
      }
      blockCol += 1;
      if (blockCol === colsBlocks) blockCol = 0;
    }
    blockRow += 1;
    if (blockRow === rowsBlocks) {
      blockRow = 0;
      blockCol0 = (blockCol0 + (rowsBlocks >> 1)) % colsBlocks; // hex shear on the vertical wrap
    }
  }
}

/**
 * Renders the full minimap as an RGBA image (`cols x rows` pixels, one per tile) through the given game
 * palette (256 x RGBA, a 1024-byte array indexed by `index*4`).
 */
export function renderMinimapRGBA(
  minimap: Uint8Array,
  cols: number,
  rows: number,
  palette: Uint8Array | Uint8ClampedArray,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(cols * rows * 4);
  for (let my = 0; my < rows; my++) {
    for (let mx = 0; mx < cols; mx++) {
      const pi = minimapPixel(minimap, mx, my, cols);
      const src = pi * 4;
      const dst = (my * cols + mx) * 4;
      rgba[dst] = palette[src]!;
      rgba[dst + 1] = palette[src + 1]!;
      rgba[dst + 2] = palette[src + 2]!;
      rgba[dst + 3] = 255;
    }
  }
  return rgba;
}

// --- 4x4 block window, doubled magnification (zoom, `FUN_00042859`) ------------------------------

/** Edge length of the zoom window in 16x16 blocks (original loop `vreg4/vreg5 = 3`, 4 passes). */
export const MINIMAP_ZOOM_BLOCKS = 4;

/**
 * Draws the **zoom base image** of the overview map — a port of `FUN_00042859` @0x42859, the twin of
 * {@link drawMinimapWindow} in the zoom branch of the preview dispatcher (`FUN_000422eb`).
 *
 * Differences from the 1x renderer, all byte-verified: the window anchor subtracts **`(0x24, 0x18)`**
 * instead of `(0x54, 0x38)` from the centre (48 columns / 32 rows further in — exactly the middle of
 * the 1x cut-out), **4x4** instead of 8x8 blocks are walked, and every minimap sample is written as a
 * **2x2 pixel** (`put_pixel` four times per sample, `x += 2` / `y += 2`). The result is again a
 * 128x128 image, but showing only a quarter of the area.
 *
 * Toroidal wrap and the **hex shear on the row wrap** (`+ rowsBlocks/2`) are identical to the 1x
 * renderer. The **half-tile offset** of the hex rows is not carried by this renderer but by the
 * post-processing step `applyZoomHexOffset` (`FUN_00042a98`) at the end of the zoom branch.
 */
export function drawMinimapWindowZoom(
  fb: Framebuffer,
  minimap: Uint8Array,
  palette: Uint8Array | Uint8ClampedArray,
  cols: number,
  rows: number,
  centerCol: number,
  centerRow: number,
  ox = 0,
  oy = 0,
): void {
  const colMask = cols - 1;
  const rowMask = rows - 1;
  const colsBlocks = cols >> 4;
  const rowsBlocks = rows >> 4;

  const r = (centerRow - 0x18) & rowMask;
  const startCol = (centerCol - (r >> 1) - 0x24) & colMask;
  let blockCol0 = startCol >> 4;
  let blockRow = r >> 4;

  for (let sr = 0; sr < MINIMAP_ZOOM_BLOCKS; sr++) {
    let blockCol = blockCol0;
    for (let sc = 0; sc < MINIMAP_ZOOM_BLOCKS; sc++) {
      const srcOffset = ((blockRow << (log2(cols) - 4)) | blockCol) << 8;
      // Block origin: the original computes `(index ^ 3) << 5` because its loops count backwards —
      // read ascending that is simply 32 pixels per block.
      const sx = sc * 32 + MINIMAP_WINDOW_X + ox;
      const sy = sr * 32 + MINIMAP_WINDOW_Y + oy;
      for (let py = 0; py < 16; py++) {
        for (let px = 0; px < 16; px++) {
          const v = minimap[srcOffset + py * 16 + px]!;
          const x = sx + px * 2;
          const y = sy + py * 2;
          plotPaletteIndex(fb, x, y, v, palette);
          plotPaletteIndex(fb, x, y + 1, v, palette);
          plotPaletteIndex(fb, x + 1, y + 1, v, palette);
          plotPaletteIndex(fb, x + 1, y, v, palette);
        }
      }
      blockCol += 1;
      if (blockCol === colsBlocks) blockCol = 0;
    }
    blockRow += 1;
    if (blockRow === rowsBlocks) {
      blockRow = 0;
      blockCol0 = (blockCol0 + (rowsBlocks >> 1)) % colsBlocks;
    }
  }
}

// --- Shrunk window (AN EXTENSION, not an original renderer) -------------------------------------

/**
 * Draws the preview window **shrunk**: one image point shows `tileStep x tileStep` tiles, so the 128er
 * window covers `128*tileStep` tiles.
 *
 * **This is an extension** with no counterpart in the original — its preview dispatcher (@0x422eb)
 * calls exactly two base renderers, `0x42637` (1x) and `0x42859` (zoom 2x), and both zoom **in**. It
 * becomes necessary only through our freely zoomable main view: there the visible cut-out can grow
 * beyond 128 tiles, and then the "overview" map showed less than the view it is meant to survey.
 * {@link drawMinimapWindow} and {@link drawMinimapWindowZoom} stay **untouched** — those two are
 * accepted pixel-exactly against the captures.
 *
 * Sampling is **nearest neighbour** (one sample per block, no averaging): the terrain is broad, and the
 * main view shrinks its index surface the same way. The origin arrives here — unlike in the two
 * original renderers — as a **window origin in tile coordinates** (`mapPreviewOrigin`), because the
 * overlays need the same one and the two sides would otherwise drift apart.
 *
 * The **hex shear already sits in the minimap** (`buildMinimap` stores pixel `(mx, my)` as tile
 * `(my>>1 + mx, my)`), so it is only taken back out of the origin here and not tracked per row.
 */
export function drawMinimapWindowShrunk(
  fb: Framebuffer,
  minimap: Uint8Array,
  palette: Uint8Array | Uint8ClampedArray,
  cols: number,
  rows: number,
  originCol: number,
  originRow: number,
  tileStep: number,
  size = 128,
  ox = 0,
  oy = 0,
): void {
  const colMask = cols - 1;
  const rowMask = rows - 1;
  // Minimap x of the window origin: the shear that `mapPreviewOrigin` folds in, taken back out.
  const mx0 = (originCol - (originRow >> 1)) & colMask;
  const my0 = originRow & rowMask;
  for (let j = 0; j < size; j++) {
    const myAbs = my0 + j * tileStep;
    // **Shear on the row wrap**, exactly as in {@link drawMinimapWindow} (`blockCol0 +=
    // rowsBlocks/2`): the map grid is a torus with `B = (rows/2, rows)`, so one row period further down
    // the same tile sits `rows/2` columns over. Without this term the renderer would NOT coincide with
    // the original at `tileStep 1` — and that is what a test checks.
    const shear = Math.floor(myAbs / rows) * (rows >> 1);
    const my = myAbs & rowMask;
    for (let i = 0; i < size; i++) {
      const mx = (mx0 + shear + i * tileStep) & colMask;
      plotPaletteIndex(
        fb,
        MINIMAP_WINDOW_X + ox + i,
        MINIMAP_WINDOW_Y + oy + j,
        minimapPixel(minimap, mx, my, cols),
        palette,
      );
    }
  }
}
