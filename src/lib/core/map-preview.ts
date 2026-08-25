/**
 * Map preview of the overview map (popup screens 1/2) — the dispatcher @0x422eb with its base
 * renderers, overlays and the build cursor marker.
 *
 * The preview is a **128×128 pixel window** in the popup area (origin `(8, 9)` like every popup
 * content, 1 pixel = 1 tile). The dispatcher reads the mode byte `vp+0xd1` and composes the picture
 * from a **base renderer** plus up to four **overlays**, with the cursor marker last:
 *
 * | bit | effect |
 * |---|---|
 * | 0 | territory dots over the landscape ({@link drawTerritoryDots}) |
 * | 1 | base renderer = **owner map** ({@link drawOwnerMap}) instead of the landscape |
 * | 2 | roads ({@link drawRoadOverlay}) |
 * | 3 | buildings/flags — over the landscape {@link drawBuildingOverlay}, over the owner map {@link drawBuildingOverlayOwnerMap} |
 * | 4 | border lines ({@link drawBorderLines}) |
 * | 5 | double magnification ("magnifier") — **its own set of renderers**, see below |
 *
 * Bits 0/1 together form the display **mode** the manual describes (p. 46) as "landscape /
 * landscape + ownership / ownership".
 *
 * **The magnifier branch** is a **complete second set of routines**, not a scaling: every renderer
 * has a `…Zoom` twin, plus {@link applyZoomHexOffset}, which exists **only** there. It shows 64×64
 * tiles as 2×2 pixel blocks, and its road overlay works **per direction** (four road groups onto the
 * four pixels), so it shows more than its 1× twin.
 *
 * Two ordering details of the dispatcher, both observable: the overlay calls sit **inside** the base
 * branches (hence one building overlay per base), and the half-tile offset runs **before** border
 * lines and cursor marker, which it therefore does not shift.
 *
 * All colours are **palette indices**, exactly as the original writes them into the picture buffer.
 */

import type { MapTile } from './types.js';
import {
  drawMinimapWindow,
  drawMinimapWindowShrunk,
  drawMinimapWindowZoom,
  plotPaletteIndex,
} from './minimap.js';
import { blitSprite, type Framebuffer, type SpriteProvider } from './ui-render.js';
import { gameSprite } from './flag-sprites.js';

// --- Mode bits (`vp+0xd1`) -----------------------------------------------------------------------

/** Bit 0: territory dots over the landscape (landscape base mode only). */
export const PREVIEW_TERRITORY_DOTS = 0x01;
/** Bit 1: base renderer is the plain owner map instead of the landscape. */
export const PREVIEW_OWNER_MAP = 0x02;
/** Bit 2: road overlay. */
export const PREVIEW_ROADS = 0x04;
/** Bit 3: building/flag overlay. */
export const PREVIEW_BUILDINGS = 0x08;
/** Bit 4: border lines (world size). */
export const PREVIEW_BORDERS = 0x10;
/** Bit 5: double magnification — its own set of renderers. */
export const PREVIEW_ZOOM = 0x20;

/** Edge length of the preview window in pixels (= tiles at 1×). */
export const PREVIEW_SIZE = 128;
/** Drawing origin of the window within the popup area. */
export const PREVIEW_X = 8;
export const PREVIEW_Y = 9;

/** Edge length of the magnified section in tiles — 64×64 fit into the same 128×128 pixels. */
export const PREVIEW_ZOOM_TILES = 64;

/** Sprite index of the build cursor marker in game-object space. */
export const PREVIEW_CURSOR_SPRITE = 0x22;

/**
 * The two colours of the marker frame, **read out of sprite `0x22`**: 15×15, pivot `(−7,−7)`, only
 * the border set and dashed like a chequerboard — `(x + y)` even ⇒ 213 (yellow), odd ⇒ 74 (dark red),
 * 28 pixels each. Used by {@link drawViewportRect}, which draws the same frame at a free size.
 */
export const MARKER_COLOR_EVEN = 213;
export const MARKER_COLOR_ODD = 74;

// --- Input data ----------------------------------------------------------------------------------

/** The part of a flag record the building overlay needs. */
export interface PreviewFlag {
  readonly owner: number;
  /** Road per direction 0..5 (byte 3, bits 0..5). */
  readonly paths: readonly boolean[];
  /** Carrier per direction 0..5 (byte 5, bits 0..5). */
  readonly transporters: readonly boolean[];
}

/** The part of a building record the building overlay needs. */
export interface PreviewBuilding {
  readonly owner: number;
  /** Building type 0..24. */
  readonly type: number;
}

/** Map data of the preview (all read-only). */
export interface MapPreviewData {
  /** Tiles, row-major `pos = row·cols + col`. */
  readonly tiles: readonly MapTile[];
  readonly cols: number;
  readonly rows: number;
  /** Block-interleaved overview minimap — the source of the landscape base picture. */
  readonly minimap: Uint8Array;
  /** Game palette as RGBA (256 × 4 bytes). */
  readonly palette: Uint8Array | Uint8ClampedArray;
  /** Flags, addressed **by flag index** (gaps allowed). */
  readonly flags: readonly (PreviewFlag | null | undefined)[];
  /** Buildings, addressed **by building index** (gaps allowed). */
  readonly buildings: readonly (PreviewBuilding | null | undefined)[];
}

/** State of the preview window (the viewport fields it reads). */
export interface MapPreviewView {
  /** Map centre of the window (`vp+0x74` / `vp+0x76`). */
  readonly centerCol: number;
  readonly centerRow: number;
  /**
   * **Centre tile of the main view** (`vp+0x46` / `vp+0x48`) — where the cursor marker points.
   *
   * Not the top-left corner: every consumer computes `vp[0x46] − vp[0x4a]` to get there, and
   * `vp[0x4a]/0x4c` are the **centring offset in tiles** the four viewport inits set. The sprite
   * confirms it too: a **centred** 15×15 frame (pivot `−7,−7`), i.e. roughly the original's view
   * around its centre tile.
   */
  readonly cursorCol: number;
  readonly cursorRow: number;
  /** Mode bits (`vp+0xd1`). */
  readonly mode: number;
  /**
   * Building filter of the overlay (`vp+0x2e`): `< 0` all buildings, `0` **flag mode** (only flags
   * with an unserviced road), `> 0` only this building type.
   */
  readonly buildingFilter: number;
  /** Player whose buildings/flags are shown (`*(short*)vp+0x82`). */
  readonly playerIndex: number;
  /** `gs+0x37e` bit 5: lifts the owner filter of the building overlay, showing every player. */
  readonly showAllPlayers?: boolean;
  /**
   * **Extension beyond the original**: the view in tiles. When set, {@link drawMapPreview} draws a
   * frame of **that** size instead of the 15×15 sprite.
   *
   * Reason: the sprite is a fixed 15×15 frame because the original's view is fixed (the centring
   * offsets above are constants per screen mode). Ours scales and zooms freely — a fixed frame would
   * not be a faithful reproduction there but a false statement about what is currently visible.
   * Without the field the sprite path is unchanged, and the pixel comparison against the original
   * captures runs through it.
   */
  readonly viewportSpan?: { readonly cols: number; readonly rows: number };
  /**
   * **Extension beyond the original**: tiles per preview pixel (power of two, default `1`). At `1`
   * every path is byte-identical to the original, and that is the only value the campaign maps (all
   * size 3) ever produce — so the pixel comparisons stay untouched.
   *
   * Reason: the original **always** shows 128×128 tiles here and only knows the magnifier **inwards**
   * (the dispatcher calls exactly `0x42637` and `0x42859`). From map size 6 (256×128) on that is
   * less than half the world — harmless in the original, whose view is a fixed 19×22 tiles, but wrong
   * with our zoomable view: the overview showed less than the view itself.
   *
   * {@link previewTileStep} picks the value so that the visible section fits.
   */
  readonly tileStep?: number;
}

/** Window origin in tile coordinates (`vp+0x7c` / `vp+0x7e`). */
export interface MapPreviewOrigin {
  readonly col: number;
  readonly row: number;
}

// --- Window origin -------------------------------------------------------------------------------

/**
 * The **block-aligned window origin** from the window centre, as the map icon handler @0x272d7 sets
 * `vp+0x7c` / `vp+0x7e` when opening: centre minus `(0x54, 0x38)`, hex shear out, round down to 16
 * (the block edge), shear of the aligned row back in. `vp+0x7e` is therefore always a multiple of
 * 16 — which the overlays rely on, since their shear counts from row 0 of the window.
 *
 * The landscape base renderer recomputes the same formula from the centre for every frame; both ways
 * give the same origin.
 */
export function mapPreviewOrigin(
  centerCol: number,
  centerRow: number,
  cols: number,
  rows: number,
  tileStep = 1,
): MapPreviewOrigin {
  const colMask = cols - 1;
  const rowMask = rows - 1;
  // With `tileStep > 1` the window covers `128·tileStep` tiles; anchor and block grid grow with it
  // so the window centre stays on the same tile. At 1 this is the original formula character for
  // character (`~15` and `0xfff0` agree for values below 65536).
  const align = ~(16 * tileStep - 1);
  const r = (centerRow - 0x38 * tileStep) & rowMask;
  const c = (centerCol - (r >> 1) - 0x54 * tileStep) & colMask;
  const row = r & align;
  const col = ((c & align) + (row >> 1)) & colMask;
  return { col, row };
}

/**
 * **Extension**: tiles per preview pixel — the smallest power of two at which the visible section
 * fits into the 128er window, capped at "whole map in the window".
 *
 * The cap is why nothing changes for the campaign maps: at 64×64 the world already fits twice at
 * `1`, so the cap is below 1 and the loop never runs. A second step exists only from size 6 on.
 */
export function previewTileStep(
  spanCols: number,
  spanRows: number,
  cols: number,
  rows: number,
): number {
  const need = Math.max(spanCols, spanRows) / PREVIEW_SIZE;
  const cap = Math.max(cols, rows) / PREVIEW_SIZE;
  let step = 1;
  while (step < need && step < cap) step *= 2;
  return step;
}

// --- Base renderer: owner map (@0x42cdf) ---------------------------------------------------------

/**
 * Palette index of the ownership tint. The original reads the height/owner byte raw and adds `+4`
 * for bit 6 and `+8` for bit 5 onto a base. Together those bits are the 2-bit owner field
 * (`owner − 1`, bit 5 = LSB), so the four players land on `base+0`, `base+8`, `base+4`, `base+12`.
 * Without an owner the bits are provably 0, which is why the building overlay never tests the
 * ownership bit at all.
 */
function ownerColor(base: number, owner: number): number {
  if (owner === 0) return base;
  const bits = owner - 1;
  return base + (bits & 1 ? 8 : 0) + (bits & 2 ? 4 : 0);
}

/** Tile at `(col, row)` with toroidal wrap (the original's masks). */
function tileAt(data: MapPreviewData, col: number, row: number): MapTile {
  const c = col & (data.cols - 1);
  const r = row & (data.rows - 1);
  return data.tiles[r * data.cols + c]!;
}

/**
 * Base renderer **owner map** (@0x42cdf): 128×128 tiles, one pixel each, unclaimed land in colour 1,
 * claimed land in the player colour from `0x41` on. The landscape disappears completely.
 *
 * The tile row advances one column per **second** picture row — the map's hex shear, counted from
 * the (always even) window origin.
 */
export function drawOwnerMap(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  tileStep = 1,
): void {
  const { palette } = data;
  for (let j = 0; j < PREVIEW_SIZE; j++) {
    const row = origin.row + j * tileStep;
    // Closed form of the original's step sequence: `col` advances one column every second tile row.
    // At `tileStep == 1` this is tile for tile the original's incremental `if (j & 1) col += 1`.
    const col0 = origin.col + ((j * tileStep) >> 1);
    for (let i = 0; i < PREVIEW_SIZE; i++) {
      const tile = tileAt(data, col0 + i * tileStep, row);
      // Only claimed land gets a player colour; unclaimed land stays index 1.
      const color = tile.owner === 0 ? 1 : ownerColor(0x41, tile.owner);
      plotPaletteIndex(fb, PREVIEW_X + i, PREVIEW_Y + j, color, palette);
    }
  }
}

// --- Overlay: territory dots (@0x42f7c) ----------------------------------------------------------

/**
 * Overlay **territory dots**: samples every second tile on both axes and sets a dot for claimed land
 * on a 2-pixel grid (colour base `0x42`). Over the landscape this gives the manual's "dotted area"
 * of one's own territory.
 */
export function drawTerritoryDots(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  tileStep = 1,
): void {
  const { palette } = data;
  for (let j = 0; j < PREVIEW_SIZE / 2; j++) {
    // The original's row step: once "down-right" + once "down" = 2 rows, 1 column — in closed form
    // `row + 2j` and `col + j`, which is the same shear as `(tile row >> 1)`.
    const row = origin.row + 2 * j * tileStep;
    const col0 = origin.col + j * tileStep;
    for (let i = 0; i < PREVIEW_SIZE / 2; i++) {
      const owner = blockOwner(data, col0 + 2 * i * tileStep, row, tileStep);
      if (owner !== 0) {
        plotPaletteIndex(
          fb,
          PREVIEW_X + 2 * i,
          PREVIEW_Y + 2 * j,
          ownerColor(0x42, owner),
          palette,
        );
      }
    }
  }
}

/**
 * Owner of the `tileStep × tileStep` block at `(col, row)` — the **first** claimed one wins, `0` if
 * none. At `tileStep == 1` exactly the tile itself, hence identical to the original.
 *
 * Why aggregate at all: plain sampling would make three quarters of one's own land disappear at
 * `tileStep 2`. In a shrunk window "somewhere in this block" is the right statement — at the
 * original scale the question does not arise.
 */
function blockOwner(
  data: MapPreviewData,
  col: number,
  row: number,
  tileStep: number,
): number {
  for (let dj = 0; dj < tileStep; dj++) {
    for (let di = 0; di < tileStep; di++) {
      const owner = tileAt(data, col + di, row + dj).owner;
      if (owner !== 0) return owner;
    }
  }
  return 0;
}

// --- Overlay: roads (@0x431fe) -------------------------------------------------------------------

/**
 * Overlay **roads**: one pixel in colour 1 for every tile with at least one road bit. Same tile step
 * sequence (including hex shear) as {@link drawOwnerMap}.
 */
export function drawRoadOverlay(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  tileStep = 1,
): void {
  const { palette } = data;
  for (let j = 0; j < PREVIEW_SIZE; j++) {
    const row = origin.row + j * tileStep;
    const col0 = origin.col + ((j * tileStep) >> 1);
    for (let i = 0; i < PREVIEW_SIZE; i++) {
      // Aggregated like the territory dots: a road is one tile wide and would lose three quarters
      // of itself at `tileStep 2` — a road would turn into sprinkles.
      if (blockHasRoad(data, col0 + i * tileStep, row, tileStep)) {
        plotPaletteIndex(fb, PREVIEW_X + i, PREVIEW_Y + j, 1, palette);
      }
    }
  }
}

/** Does any tile of the `tileStep × tileStep` block carry a road bit? At 1, the tile itself. */
function blockHasRoad(
  data: MapPreviewData,
  col: number,
  row: number,
  tileStep: number,
): boolean {
  for (let dj = 0; dj < tileStep; dj++) {
    for (let di = 0; di < tileStep; di++) {
      if ((tileAt(data, col + di, row + dj).paths & 0x3f) !== 0) return true;
    }
  }
  return false;
}

// --- Overlay: buildings / flags (@0x43afa) -------------------------------------------------------

/** Sets the 2×2 dot of the building overlay (the original draws four single pixels). */
function plotBlock2x2(
  fb: Framebuffer,
  x: number,
  y: number,
  color: number,
  palette: Uint8Array | Uint8ClampedArray,
): void {
  plotPaletteIndex(fb, x, y, color, palette);
  plotPaletteIndex(fb, x, y + 1, color, palette);
  plotPaletteIndex(fb, x + 1, y + 1, color, palette);
  plotPaletteIndex(fb, x + 1, y, color, palette);
}

/**
 * Overlay **buildings / flags**: a 2×2 dot per find, in the owner colour (base `0x40`). The sampled
 * tile row starts one tile "down-right" of the window origin, and the loops run 127×127 so the 2×2
 * dot stays inside the window.
 *
 * The filter `vp+0x2e`:
 * - `< 0` — all buildings (the normal case, the "blue dots"),
 * - `> 0` — only buildings of this type (those under construction count, the type is in the record),
 * - `= 0` — **flag mode**: only flags where an incoming road is **not being serviced**. The original
 *   tests that as `paths XOR transporter` over the six directions — the congestion display of the
 *   manual (p. 117).
 *
 * Without `showAllPlayers` the overlay shows only the own player's objects.
 */
export function drawBuildingOverlay(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
  tileStep = 1,
): void {
  buildingOverlay(fb, data, origin, view, BUILDING_OVERLAY_LANDSCAPE, tileStep);
}

/**
 * The four shapes of the building overlay. The original keeps **four separate routines** for it, and
 * an instruction diff says they differ in exactly these three axes (start tile, tile count/pixel
 * grid, colour) — the rest, the whole filter cascade included, is instruction for instruction
 * identical. Hence one implementation with three parameters and four entry points.
 */
interface BuildingOverlayShape {
  /** @0x43afa starts one tile "down-right" (`+= gs[8]`); the other three do not. */
  readonly startDelta: 0 | 1;
  /** Tiles per axis: 127, 128, or 64 in the magnifier branch. */
  readonly count: number;
  /** Picture pixels per tile: 1 at 1×, 2 in the magnifier. */
  readonly step: 1 | 2;
  /** Over the owner map a **fixed** colour `0x2f`, otherwise the owner colour from `0x40` on. */
  readonly fixedColor: number | null;
}

/** @0x43afa — buildings over the landscape, 1×. */
const BUILDING_OVERLAY_LANDSCAPE: BuildingOverlayShape = {
  startDelta: 1,
  count: PREVIEW_SIZE - 1,
  step: 1,
  fixedColor: null,
};
/** @0x434bb — buildings over the **owner map**, 1×: fixed colour, no start offset, 128 tiles. */
const BUILDING_OVERLAY_OWNER_MAP: BuildingOverlayShape = {
  startDelta: 0,
  count: PREVIEW_SIZE,
  step: 1,
  fixedColor: 0x2f,
};
/** @0x43e62 — buildings over the landscape, magnifier. */
const BUILDING_OVERLAY_LANDSCAPE_ZOOM: BuildingOverlayShape = {
  startDelta: 0,
  count: PREVIEW_ZOOM_TILES - 1,
  step: 2,
  fixedColor: null,
};
/** @0x437b5 — buildings over the owner map, magnifier (colour tail @0x43a65 is `0x2f` as well). */
const BUILDING_OVERLAY_OWNER_MAP_ZOOM: BuildingOverlayShape = {
  startDelta: 0,
  count: PREVIEW_ZOOM_TILES - 1,
  step: 2,
  fixedColor: 0x2f,
};

/**
 * Building overlay over the **owner map** — the same selection as {@link drawBuildingOverlay} but in
 * the fixed colour `0x2f`: on an owner-coloured ground an owner-coloured dot would be invisible.
 */
export function drawBuildingOverlayOwnerMap(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
  tileStep = 1,
): void {
  buildingOverlay(fb, data, origin, view, BUILDING_OVERLAY_OWNER_MAP, tileStep);
}

/**
 * The overlay's decision for **one** tile — the colour if it gets a dot, otherwise `null`. Pulled out
 * so the shrunk window can run the same test over a block of tiles without duplicating it.
 */
function buildingDot(
  data: MapPreviewData,
  view: MapPreviewView,
  shape: BuildingOverlayShape,
  col: number,
  row: number,
): number | null {
  const filter = view.buildingFilter;
  const showAll = view.showAllPlayers === true;
  const tile = tileAt(data, col, row);
  const object = tile.object & 0x7f;
  if (object === 0) return null;
  let show = false;
  if (object === 1) {
    if (filter === 0) {
      const flag = data.flags[tile.objIndex];
      if (flag !== null && flag !== undefined) {
        let unserved = false;
        for (let d = 0; d < 6; d++) {
          if (flag.paths[d] !== flag.transporters[d]) unserved = true;
        }
        show = unserved && (showAll || flag.owner === view.playerIndex);
      }
    }
  } else if (object < 5) {
    if (filter < 0) {
      show = true;
    } else if (filter !== 0) {
      const building = data.buildings[tile.objIndex];
      if (building !== null && building !== undefined && building.type === filter) {
        show = showAll || building.owner === view.playerIndex;
      }
    }
  }
  if (!show) return null;
  return shape.fixedColor ?? ownerColor(0x40, tile.owner);
}

function buildingOverlay(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
  shape: BuildingOverlayShape,
  tileStep = 1,
): void {
  const { palette } = data;
  const base = { col: origin.col + shape.startDelta, row: origin.row + shape.startDelta };
  for (let j = 0; j < shape.count; j++) {
    const row = base.row + j * tileStep;
    // Shear: all four routines test bit 0 of their **backwards** running row counter, so read
    // forwards the column advances after **even** picture rows — in closed form
    // `((tile row + 1) >> 1)`, one row later than in the other overlays.
    const col0 = base.col + (((j * tileStep) + 1) >> 1);
    for (let i = 0; i < shape.count; i++) {
      // The FIRST hit in the block wins. Without aggregating, three quarters of all buildings would
      // be invisible at `tileStep 2` — and the building dots are what the overview map is for.
      let color: number | null = null;
      const col = col0 + i * tileStep;
      for (let dj = 0; dj < tileStep && color === null; dj++) {
        for (let di = 0; di < tileStep && color === null; di++) {
          color = buildingDot(data, view, shape, col + di, row + dj);
        }
      }
      if (color !== null) {
        plotBlock2x2(
          fb,
          PREVIEW_X + i * shape.step,
          PREVIEW_Y + j * shape.step,
          color,
          palette,
        );
      }
    }
  }
}

// --- Magnifier branch (`vp+0xd1` bit 5) ----------------------------------------------------------

/**
 * Window origin of the magnified section. All six zoom overlays compute it identically from the 1×
 * origin: `row + 0x20`, `col + 0x30`, both masked — exactly the centre of the 1× window (32 tiles
 * down and, after taking off the shear of 16, 32 right).
 */
export function mapPreviewZoomOrigin(
  origin: MapPreviewOrigin,
  cols: number,
  rows: number,
): MapPreviewOrigin {
  return { col: (origin.col + 0x30) & (cols - 1), row: (origin.row + 0x20) & (rows - 1) };
}

/**
 * Base renderer **owner map, magnifier** (@0x42e0b) — twin of {@link drawOwnerMap}: 64×64 tiles, each
 * as 2×2 pixels, otherwise identical.
 */
export function drawOwnerMapZoom(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
): void {
  const { palette } = data;
  const zo = mapPreviewZoomOrigin(origin, data.cols, data.rows);
  let col = zo.col;
  let row = zo.row;
  for (let j = 0; j < PREVIEW_ZOOM_TILES; j++) {
    for (let i = 0; i < PREVIEW_ZOOM_TILES; i++) {
      const tile = tileAt(data, col + i, row);
      const color = tile.owner === 0 ? 1 : ownerColor(0x41, tile.owner);
      plotBlock2x2(fb, PREVIEW_X + 2 * i, PREVIEW_Y + 2 * j, color, palette);
    }
    if (j & 1) col += 1;
    row += 1;
  }
}

/**
 * Overlay **territory dots, magnifier** (@0x430a9). Unlike its 1× twin this one samples **every**
 * tile (not every second) and still sets a **single** pixel per find — at double magnification the
 * dots therefore fall on the 2-pixel grid again, so their density on screen stays the same.
 */
export function drawTerritoryDotsZoom(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
): void {
  const { palette } = data;
  const zo = mapPreviewZoomOrigin(origin, data.cols, data.rows);
  let col = zo.col;
  let row = zo.row;
  for (let j = 0; j < PREVIEW_ZOOM_TILES; j++) {
    for (let i = 0; i < PREVIEW_ZOOM_TILES; i++) {
      const tile = tileAt(data, col + i, row);
      if (tile.owner !== 0) {
        plotPaletteIndex(
          fb,
          PREVIEW_X + 2 * i,
          PREVIEW_Y + 2 * j,
          ownerColor(0x42, tile.owner),
          palette,
        );
      }
    }
    if (j & 1) col += 1;
    row += 1;
  }
}

/**
 * Overlay **roads, magnifier** (@0x43305) — the only zoom renderer that shows **more** than its 1×
 * twin rather than merely bigger: the tile's four pixels stand for different road directions, so the
 * original draws **per direction** here instead of just "there is a road".
 *
 * ```
 * bits 5|4|3 (Left/UpLeft/Up) → (x,   y)
 * bit 2      (Down)           → (x,   y+1)
 * bit 0      (Right)          → (x+1, y)
 * bit 1      (DownRight)      → (x+1, y+1)
 * ```
 */
export function drawRoadOverlayZoom(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
): void {
  const { palette } = data;
  const zo = mapPreviewZoomOrigin(origin, data.cols, data.rows);
  let col = zo.col;
  let row = zo.row;
  for (let j = 0; j < PREVIEW_ZOOM_TILES; j++) {
    for (let i = 0; i < PREVIEW_ZOOM_TILES; i++) {
      const paths = tileAt(data, col + i, row).paths & 0x3f;
      if (paths === 0) continue;
      const x = PREVIEW_X + 2 * i;
      const y = PREVIEW_Y + 2 * j;
      if (paths & 0x38) plotPaletteIndex(fb, x, y, 1, palette);
      if (paths & 0x04) plotPaletteIndex(fb, x, y + 1, 1, palette);
      if (paths & 0x01) plotPaletteIndex(fb, x + 1, y, 1, palette);
      if (paths & 0x02) plotPaletteIndex(fb, x + 1, y + 1, 1, palette);
    }
    if (j & 1) col += 1;
    row += 1;
  }
}

/** Overlay **buildings over the landscape, magnifier** (@0x43e62). */
export function drawBuildingOverlayZoom(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
): void {
  buildingOverlay(
    fb,
    data,
    mapPreviewZoomOrigin(origin, data.cols, data.rows),
    view,
    BUILDING_OVERLAY_LANDSCAPE_ZOOM,
  );
}

/** Overlay **buildings over the owner map, magnifier** (@0x437b5). */
export function drawBuildingOverlayOwnerMapZoom(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
): void {
  buildingOverlay(
    fb,
    data,
    mapPreviewZoomOrigin(origin, data.cols, data.rows),
    view,
    BUILDING_OVERLAY_OWNER_MAP_ZOOM,
  );
}

/**
 * **Half-tile offset of the hex rows** (@0x42a98) — the post-processing step that exists **only** in
 * the magnifier branch.
 *
 * The renderers' tile loops can only reproduce the hex shear in **whole** tiles (one column per two
 * map rows). At double magnification a tile is 2 pixels wide, so the offset between two neighbouring
 * map rows is **half** of that — exactly one pixel. The original makes up for it on the finished
 * picture: it shifts every second two-row strip one pixel left and paints the right border column
 * `x = 0x87` in colour 1.
 *
 * The order is observable: the step runs **after** base and overlays but **before** border lines and
 * cursor marker, so those two are not shifted along.
 */
export function applyZoomHexOffset(
  fb: Framebuffer,
  palette: Uint8Array | Uint8ClampedArray,
): void {
  const shift = (y: number): void => {
    for (let dy = 0; dy < 2; dy++) {
      const line = y + dy;
      if (line < 0 || line >= fb.height) continue;
      const row = line * fb.width;
      for (let x = 8; x < 8 + 127; x++) {
        const src = (row + x + 1) * 4;
        const dst = (row + x) * 4;
        fb.rgba[dst] = fb.rgba[src]!;
        fb.rgba[dst + 1] = fb.rgba[src + 1]!;
        fb.rgba[dst + 2] = fb.rgba[src + 2]!;
        fb.rgba[dst + 3] = fb.rgba[src + 3]!;
      }
    }
  };
  let y = PREVIEW_Y;
  for (let k = 0; k < 32; k++) {
    plotPaletteIndex(fb, 0x87, y, 1, palette);
    plotPaletteIndex(fb, 0x87, y + 1, 1, palette);
    // The shift comes BEFORE the two border pixels of these rows — otherwise it would move them.
    shift(y + 2);
    plotPaletteIndex(fb, 0x87, y + 2, 1, palette);
    plotPaletteIndex(fb, 0x87, y + 3, 1, palette);
    y += 4;
  }
}

/**
 * Overlay **border lines, magnifier** (@0x4432e) — like the 1× twin but with doubled spacing, and
 * measured from the magnifier origin.
 */
export function drawBorderLinesZoom(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
): void {
  const { palette, cols, rows } = data;
  const zo = mapPreviewZoomOrigin(origin, cols, rows);
  // Horizontal lines: map row 0, twice as far apart on screen.
  for (let r = ((rows - zo.row) & (rows - 1)) * 2; r < PREVIEW_SIZE; r += rows * 2) {
    const y = PREVIEW_Y + r;
    let color = 0x2f;
    for (let x = PREVIEW_X + PREVIEW_SIZE - 1; x >= PREVIEW_X; x--) {
      plotPaletteIndex(fb, x, y, color, palette);
      color ^= 0x2e;
    }
  }
  // Diagonal lines: map column 0, one column left per two picture rows.
  let c = ((cols - zo.col) & (cols - 1)) * 2;
  for (let j = 0; j < PREVIEW_SIZE / 2; j++) {
    for (let x = c; x < PREVIEW_SIZE; x += cols * 2) {
      plotPaletteIndex(fb, PREVIEW_X + x, PREVIEW_Y + 2 * j, 0x2d, palette);
      plotPaletteIndex(fb, PREVIEW_X + x, PREVIEW_Y + 2 * j + 1, 1, palette);
    }
    c = c === 0 ? cols * 2 - 1 : c - 1;
  }
}

// --- Overlay: border lines (@0x441e1) ------------------------------------------------------------

/**
 * Overlay **border lines**: marks the seams of the "endless" world — dashed horizontal lines on map
 * row 0 and the diagonal lines on map column 0, offset one column per two picture rows. On small
 * worlds both repeat inside the window.
 */
export function drawBorderLines(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  tileStep = 1,
): void {
  const { palette, cols, rows } = data;
  // Periods in preview pixels. At `tileStep == 1` they are `cols`/`rows` and everything below is
  // the original computation character for character; powers of two keep both integral.
  const rowsPx = rows / tileStep;
  const colsPx = cols / tileStep;
  // Horizontal lines: every map row 0 inside the window.
  const r0 = Math.round((((rows - origin.row) & (rows - 1)) / tileStep));
  for (let r = r0; r < PREVIEW_SIZE; r += rowsPx) {
    const y = PREVIEW_Y + r;
    let color = 0x2f;
    for (let x = PREVIEW_X + PREVIEW_SIZE - 1; x >= PREVIEW_X; x--) {
      plotPaletteIndex(fb, x, y, color, palette);
      color ^= 0x2e;
    }
  }
  // Diagonal lines: every map column 0, one column left per two picture rows. Even shrunk the offset
  // stays **one** pixel per iteration: two preview rows are `2·step` tile rows, which is `step` tile
  // columns of shear — exactly one pixel.
  let c = Math.round((((cols - origin.col) & (cols - 1)) / tileStep));
  for (let j = 0; j < PREVIEW_SIZE / 2; j++) {
    for (let x = c; x < PREVIEW_SIZE; x += colsPx) {
      plotPaletteIndex(fb, PREVIEW_X + x, PREVIEW_Y + 2 * j, 0x2d, palette);
      plotPaletteIndex(fb, PREVIEW_X + x, PREVIEW_Y + 2 * j + 1, 1, palette);
    }
    c = c === 0 ? colsPx - 1 : c - 1;
  }
}

// --- Cursor marker (@0x42b8e) --------------------------------------------------------------------

/**
 * Draws the **cursor marker** (sprite `0x22` of the game-object bank) at the player cursor's place
 * inside the preview window.
 *
 * The original measures the cursor against the window **centre** (`origin + (0x60, 0x40)`; the `0x60`
 * includes the hex shear of half the window height), wraps the difference toroidally, takes the row
 * shear out and draws only when both differences lie inside the window — a cursor scrolled away
 * produces no marker at the edge.
 */
export function drawCursorMarker(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
  sprite: SpriteProvider,
  tileStep = 1,
): boolean {
  const at = markerOffset(data, origin, view, tileStep);
  if (at === null) return false;

  const spr = sprite(gameSprite(PREVIEW_CURSOR_SPRITE));
  if (spr === null) return false;
  // `blitSprite` adds the pivot itself, like the original's blit worker (@0x63fda/@0x63fde) — adding
  // it here as well would count it twice.
  blitSprite(fb, spr, PREVIEW_X + at.dx + 0x40, PREVIEW_Y + at.dy + 0x40);
  return true;
}

/**
 * Marker position in the preview window, shared by {@link drawCursorMarker} and
 * {@link drawViewportRect} — `null` when the original omits the marker. `(dx, dy)` are pixel
 * distances from the window centre `(0x40, 0x40)`.
 */
function markerOffset(
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
  tileStep = 1,
): { dx: number; dy: number } | null {
  const { cols, rows } = data;
  const colMask = cols - 1;
  const rowMask = rows - 1;
  const centerCol = (origin.col + 0x60 * tileStep) & colMask;
  const centerRow = (origin.row + 0x40 * tileStep) & rowMask;

  let dy = (view.cursorRow - centerRow) & rowMask;
  if (dy >= rows >> 1) dy -= rows;
  let dx = (view.cursorCol - centerCol - (dy >> 1)) & colMask;
  if (dx >= cols >> 1) dx -= cols;

  // Up to here `dx`/`dy` are tiles; the test below works in **pixels**.
  const px = previewPixelsPerTile(view, tileStep);
  if (px !== 1) {
    dx = Math.round(dx * px);
    dy = Math.round(dy * px);
  }
  if (dx >= 0x38 || dy >= 0x38 || dx + 0x40 < 8 || dy + 0x40 < 8) return null;
  return { dx, dy };
}

/** Preview **pixels per tile**: 2 in the magnifier, `1/tileStep` when shrunk, otherwise 1. */
function previewPixelsPerTile(view: MapPreviewView, tileStep: number): number {
  if (view.mode & PREVIEW_ZOOM) return 2;
  return 1 / tileStep;
}

/**
 * **Extension**: the same marker frame as {@link drawCursorMarker} but sized to the *actually*
 * visible section instead of the sprite's fixed 15×15 (see {@link MapPreviewView.viewportSpan}).
 *
 * **Why an axis-aligned rectangle is right** even though the map is drawn sheared: preview pixel
 * `(i, j)` shows the tile `(origin.col + i + (j >> 1), origin.row + j)`, whose scene position is
 * `x = col·32 − row·16 = const + i·32` and `y = const + j·20`. The shear cancels **exactly**, so the
 * mapping preview pixel → scene pixel is axis-aligned with factors 32 and 20. A rectangle in preview
 * pixels is therefore precisely the rectangle the main view shows — not a parallelogram.
 *
 * The frame is clipped to the window area (zoomed out it can be larger than the window). At
 * `cols == rows == 15` it is pixel-identical to the original sprite.
 */
export function drawViewportRect(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
  span: { readonly cols: number; readonly rows: number },
  tileStep = 1,
): boolean {
  const at = markerOffset(data, origin, view, tileStep);
  if (at === null) return false;

  const scale = previewPixelsPerTile(view, tileStep);
  const w = Math.max(1, Math.round(span.cols * scale));
  const h = Math.max(1, Math.round(span.rows * scale));
  // Like the sprite pivot `−7` at width 15: the centre tile sits in the middle of the frame.
  const x0 = at.dx + 0x40 - ((w - 1) >> 1);
  const y0 = at.dy + 0x40 - ((h - 1) >> 1);

  const put = (lx: number, ly: number): void => {
    const x = x0 + lx;
    const y = y0 + ly;
    if (x < 0 || y < 0 || x >= PREVIEW_SIZE || y >= PREVIEW_SIZE) return;
    const color = (lx + ly) & 1 ? MARKER_COLOR_ODD : MARKER_COLOR_EVEN;
    plotPaletteIndex(fb, PREVIEW_X + x, PREVIEW_Y + y, color, data.palette);
  };
  for (let lx = 0; lx < w; lx++) {
    put(lx, 0);
    put(lx, h - 1);
  }
  for (let ly = 1; ly < h - 1; ly++) {
    put(0, ly);
    put(w - 1, ly);
  }
  return true;
}

// --- Click handling (table @0x2ca6d + handlers from @0x2cd66) ------------------------------------

/**
 * Click rectangles of the map popups (screens 1 **and** 2 share the table), byte-exact from @0x2ca6d.
 * `action` is the index into the handler table from @0x2cd66 (stride 8), which is where the outlier
 * `244` for the magnifier comes from.
 *
 * Coordinates are in **click rectangle space** (drawing pixels − (8, 9)); the five bar fields line up
 * exactly with the control bar's icon columns.
 */
export const MAP_PREVIEW_HITBOXES: readonly { action: number; x0: number; x1: number; y0: number; y1: number }[] = [
  { action: 0, x0: 0, x1: 127, y0: 0, y1: 127 }, // map area
  { action: 1, x0: 0, x1: 31, y0: 128, y1: 143 }, // display mode
  { action: 2, x0: 32, x1: 63, y0: 128, y1: 143 }, // roads
  { action: 3, x0: 64, x1: 95, y0: 128, y1: 143 }, // buildings / back to the normal state
  { action: 4, x0: 96, x1: 111, y0: 128, y1: 143 }, // border lines
  { action: 244, x0: 112, x1: 127, y0: 128, y1: 143 }, // magnifier
];

/** Action ids of the map popup clicks (indices of the original handler table). */
export const MAP_PREVIEW_ACTION = {
  /** Click into the map: sets the cursor and closes the popup (@0x2cd66). */
  GOTO: 0,
  /** Cycle the display mode (@0x2cd6e). */
  MODE: 1,
  /** Roads on/off (@0x2cd76). */
  ROADS: 2,
  /** Buildings on/off, or back to the normal state (@0x2cd7e). */
  BUILDINGS: 3,
  /** Border lines on/off (@0x2cd86). */
  BORDERS: 4,
  /** Magnifier on/off (@0x2fe70). */
  ZOOM: 244,
} as const;

/**
 * Turns a click in the map area into a tile (@0x2cd66): `col = origin + x + (y >> 1)`,
 * `row = origin + y`, both toroidal — exactly the inverse of the display. In magnifier mode the
 * original halves first and adds `0x20`.
 *
 * `(x, y)` are click rectangle coordinates, i.e. 0..127. The original takes the result as the
 * viewport cursor and — outside all-players mode — as the player cursor too.
 */
export function mapPreviewClickToTile(
  origin: MapPreviewOrigin,
  x: number,
  y: number,
  cols: number,
  rows: number,
  zoom = false,
  tileStep = 1,
): { col: number; row: number } {
  let cx = x;
  let cy = y;
  if (zoom) {
    cx = (cx >> 1) + 0x20;
    cy = (cy >> 1) + 0x20;
  }
  // Shrunk window: one click pixel is `tileStep` tiles. Unchanged at 1.
  const col = (origin.col + cx * tileStep + ((cy * tileStep) >> 1)) & (cols - 1);
  const row = (origin.row + cy * tileStep) & (rows - 1);
  return { col, row };
}

/**
 * Applies a bar click to the preview state — the original's toggle handlers:
 * - {@link MAP_PREVIEW_ACTION.MODE}: `mode + 1`, and at `(mode & 3) == 3` both bits are cleared →
 *   the three-way cycle landscape → landscape+ownership → ownership.
 * - {@link MAP_PREVIEW_ACTION.BUILDINGS}: in the normal state (`buildingFilter < 0`) toggle bit 3,
 *   otherwise set bit 3 **and** reset the filter to −1 ("back to the normal state"). The special
 *   click, which opens the building selection instead, hangs on `vp+1` bit 3 and is **not** modelled
 *   here.
 * - the others toggle their bit.
 */
export function applyMapPreviewAction(
  state: { mode: number; buildingFilter: number },
  action: number,
): { mode: number; buildingFilter: number } {
  const { mode, buildingFilter } = state;
  switch (action) {
    case MAP_PREVIEW_ACTION.MODE: {
      const next = (mode + 1) & 0xff;
      return { mode: (next & 3) === 3 ? next & 0xfc : next, buildingFilter };
    }
    case MAP_PREVIEW_ACTION.ROADS:
      return { mode: mode ^ PREVIEW_ROADS, buildingFilter };
    case MAP_PREVIEW_ACTION.BUILDINGS:
      return buildingFilter < 0
        ? { mode: mode ^ PREVIEW_BUILDINGS, buildingFilter }
        : { mode: mode | PREVIEW_BUILDINGS, buildingFilter: -1 };
    case MAP_PREVIEW_ACTION.BORDERS:
      return { mode: mode ^ PREVIEW_BORDERS, buildingFilter };
    case MAP_PREVIEW_ACTION.ZOOM:
      return { mode: mode ^ PREVIEW_ZOOM, buildingFilter };
    default:
      return state;
  }
}

// --- Dispatcher (@0x422eb) -----------------------------------------------------------------------

/**
 * Draws the complete map preview, both branches (1× and magnifier).
 *
 * Order as in the original: base renderer (landscape **or** owner map), then the overlays territory
 * dots (over the landscape only) / roads / buildings, then the border lines, and the cursor marker
 * last.
 */
export function drawMapPreview(
  fb: Framebuffer,
  data: MapPreviewData,
  view: MapPreviewView,
  sprite: SpriteProvider,
): void {
  // The magnifier wins: it is the original control and means "I want detail". Its branch works from
  // the 1× origin, so `tileStep` stays 1 there deliberately.
  const tileStep = view.mode & PREVIEW_ZOOM ? 1 : Math.max(1, view.tileStep ?? 1);
  const origin = mapPreviewOrigin(view.centerCol, view.centerRow, data.cols, data.rows, tileStep);
  if (view.mode & PREVIEW_ZOOM) {
    // **Magnifier branch** — a complete separate set of renderers in the original, not a scaled call
    // of the 1× ones. Then the half-tile offset, and only afterwards lines and cursor: those two are
    // NOT shifted along.
    if (view.mode & PREVIEW_OWNER_MAP) {
      drawOwnerMapZoom(fb, data, origin);
      if (view.mode & PREVIEW_ROADS) drawRoadOverlayZoom(fb, data, origin);
      if (view.mode & PREVIEW_BUILDINGS) drawBuildingOverlayOwnerMapZoom(fb, data, origin, view);
    } else {
      drawMinimapWindowZoom(
        fb,
        data.minimap,
        data.palette,
        data.cols,
        data.rows,
        view.centerCol,
        view.centerRow,
      );
      if (view.mode & PREVIEW_TERRITORY_DOTS) drawTerritoryDotsZoom(fb, data, origin);
      if (view.mode & PREVIEW_ROADS) drawRoadOverlayZoom(fb, data, origin);
      if (view.mode & PREVIEW_BUILDINGS) drawBuildingOverlayZoom(fb, data, origin, view);
    }
    applyZoomHexOffset(fb, data.palette);
    if (view.mode & PREVIEW_BORDERS) drawBorderLinesZoom(fb, data, origin);
    drawMarker(fb, data, origin, view, sprite);
    return;
  }
  // 1× branch. The overlay calls sit **inside** both branches in the original, not after them —
  // visible in the building overlay, which has its own routine per base.
  if (view.mode & PREVIEW_OWNER_MAP) {
    drawOwnerMap(fb, data, origin, tileStep);
    if (view.mode & PREVIEW_ROADS) drawRoadOverlay(fb, data, origin, tileStep);
    if (view.mode & PREVIEW_BUILDINGS) drawBuildingOverlayOwnerMap(fb, data, origin, view, tileStep);
  } else if (tileStep === 1) {
    // Landscape base = @0x42637 (ported as the 8×8 block window); it recomputes the origin from the
    // same centre and yields exactly this window.
    drawMinimapWindow(
      fb,
      data.minimap,
      data.palette,
      data.cols,
      data.rows,
      view.centerCol,
      view.centerRow,
    );
    if (view.mode & PREVIEW_TERRITORY_DOTS) drawTerritoryDots(fb, data, origin);
    if (view.mode & PREVIEW_ROADS) drawRoadOverlay(fb, data, origin);
    if (view.mode & PREVIEW_BUILDINGS) drawBuildingOverlay(fb, data, origin, view);
  } else {
    // Shrunk: the original has no renderer for this (see `MapPreviewView.tileStep`), hence the
    // extension — its block blitter stays untouched.
    drawMinimapWindowShrunk(
      fb,
      data.minimap,
      data.palette,
      data.cols,
      data.rows,
      origin.col,
      origin.row,
      tileStep,
      PREVIEW_SIZE,
    );
    if (view.mode & PREVIEW_TERRITORY_DOTS) drawTerritoryDots(fb, data, origin, tileStep);
    if (view.mode & PREVIEW_ROADS) drawRoadOverlay(fb, data, origin, tileStep);
    if (view.mode & PREVIEW_BUILDINGS) drawBuildingOverlay(fb, data, origin, view, tileStep);
  }
  if (view.mode & PREVIEW_BORDERS) drawBorderLines(fb, data, origin, tileStep);
  drawMarker(fb, data, origin, view, sprite, tileStep);
}

/** Pick the marker variant: original sprite, or a frame at view size (see `viewportSpan`). */
function drawMarker(
  fb: Framebuffer,
  data: MapPreviewData,
  origin: MapPreviewOrigin,
  view: MapPreviewView,
  sprite: SpriteProvider,
  tileStep = 1,
): void {
  if (view.viewportSpan === undefined) drawCursorMarker(fb, data, origin, view, sprite, tileStep);
  else drawViewportRect(fb, data, origin, view, view.viewportSpan, tileStep);
}
