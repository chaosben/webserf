/**
 * Map render geometry and terrain colours (pure functions, backend independent).
 *
 * The terrain is a triangle grid: every map cell consists of two triangles (up/down) with one
 * terrain type each; every grid vertex has its own height. Dimensions of the original: tile width
 * 32 px, triangle height 20 px, one height step = 4 px offset.
 *
 * Two projection modes through the `heightUnit` parameter:
 * - Flat / top-down (`heightUnit = 0`): `vertexY = row * TILE_H` - the height does not move the
 * vertex, it only shows as colour shading. This is the original's top-down minimap.
 * - Relief (`heightUnit = HEIGHT_UNIT`): `vertexY = row * TILE_H - height * HEIGHT_UNIT` - the
 * oblique look of the main viewport (hills stick up).
 *
 * Projection (unrolled parallelogram, no torus wrap - for the static viewer). Shear direction as in
 * the original: a row shears to the left (negative), so the map is not mirrored against the game.
 * vertexX = col * TILE_W - row * (TILE_W / 2) (+ offsetX, see mapPixelBounds, keeps x >= 0)
 * vertexY = row * TILE_H - height * heightUnit
 */

export const TILE_W = 32;
export const TILE_H = 20;
export const HEIGHT_UNIT = 4;
export const MAX_HEIGHT = 31;

/**
 * The row offset between the ground group and the screen group: 1 pixel down.
 *
 * The original has two map drawing passes with separate row counters:
 *
 * | Group | What | Row origin | Sprite offset | y of half-row `i`, height `h` |
 * |---|---|---|---|---|
 * | ground buffer | ground triangles, roads, border stones | `0x21` = 33 (`FUN_0000dbc4`, `+0x14` per half-row) | `-0x26` = -38 (`FUN_0000de83` up, `FUN_0000dfea` down) | `20i - 4h - 5` |
 * | screen | objects, buildings, flags, serfs, markers | `0xfffffffc` = -4 (`FUN_00033ded` and `@0x376bf`) | - | `20i - 4h - 4` |
 *
 * The ground group is drawn into a retained buffer (`gs+0x108`) and copied into the picture as one
 * rectangle: `copy_back_buffer_to_screen` @0x33d5c, target (0x10, 8), source `(vp[0x4e]+0x10, 0)`.
 * The screen group gets the same window origin `(+0x10, +8)` only in its blit primitives
 * (`blit_map_object_with_shadow` @0x34578, `blit_map_marker_sprite` @0x349c5). The window origin
 * therefore cancels out - the 1 remains, as `(-4) - (33 - 38) = +1`.
 *
 * Our frame keeps one counter (`window-frame.tileAnchor` = `20i`); the ground group sits on it, the
 * screen group (`window-frame.entityAnchor`, `viewport-camera.entityAnchorAll`) that 1 lower. The
 * shared absolute part is left out because our camera origin has no counterpart in the original (it
 * keeps the centre tile `vp+0x46/0x48` plus fine scroll) - a shared shift would be invisible in the
 * picture and would only move the meaning of `camX/camY` and with it `windowToTile`. Only the
 * difference is observable.
 *
 * Measured against captures (three camera positions, 73 objects with >= 90 % coverage): all 73 want
 * `(dx, dy) = (0, +1)` - no outlier, no dependence on image row or object size, so a constant and
 * not a scaling.
 */
export const ENTITY_ROW_BIAS = 1;

/**
 * Screen position of a grid vertex. `heightUnit` controls the height lift: 0 = flat/top-down,
 * HEIGHT_UNIT = relief.
 */
export function vertexScreen(
  col: number,
  row: number,
  height: number,
  heightUnit: number = HEIGHT_UNIT,
): { x: number; y: number } {
  return {
    x: col * TILE_W - row * (TILE_W / 2),
    y: row * TILE_H - height * heightUnit,
  };
}

/**
 * Total size of the unrolled map area in pixels (before zoom). Accounts for the row shear and, in
 * relief, for the maximum height lift so nothing is cut off. With `heightUnit = 0` the top overhang
 * drops out (`offsetY = 0`).
 *
 * `offsetX` compensates the left shear (`- row*TILE_W/2`) so all x stay >= 0 - the caller adds it to
 * every vertex x coordinate (symmetrically to `offsetY` for y).
 */
export function mapPixelBounds(
  cols: number,
  rows: number,
  heightUnit: number = HEIGHT_UNIT,
): { width: number; height: number; offsetX: number; offsetY: number } {
  const width = cols * TILE_W + rows * (TILE_W / 2);
  const offsetX = rows * (TILE_W / 2); // room on the left for the left-sheared rows
  // height: bottom row plus one tile of overhang; the lift can pull vertices upwards
  const offsetY = MAX_HEIGHT * heightUnit; // room above for raised vertices (0 when flat)
  const height = rows * TILE_H + TILE_H + offsetY;
  return { width, height, offsetX, offsetY };
}

/**
 * The two triangles of a cell (col,row) as three screen corner points each. `up` and `down` share
 * the diagonal of the cell rhombus. Heights come from `heightAt(col,row)` (the caller applies the
 * map wrap).
 *
 * Rhombus corners: TL=(col,row) TR=(col+1,row) BL=(col,row+1) BR=(col+1,row+1)
 * up = TL, TR, BR (upper/right half, terrainUp)
 * down = TL, BR, BL (lower/left half, terrainDown)
 */
export function cellTriangles(
  col: number,
  row: number,
  heightAt: (col: number, row: number) => number,
  heightUnit: number = HEIGHT_UNIT,
): {
  up: [Point, Point, Point];
  down: [Point, Point, Point];
} {
  const tl = vertexScreen(col, row, heightAt(col, row), heightUnit);
  const tr = vertexScreen(col + 1, row, heightAt(col + 1, row), heightUnit);
  const bl = vertexScreen(col, row + 1, heightAt(col, row + 1), heightUnit);
  const br = vertexScreen(col + 1, row + 1, heightAt(col + 1, row + 1), heightUnit);
  return { up: [tl, tr, br], down: [tl, br, bl] };
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * One ground triangle as the original draws it: centred on its source tile.
 *
 * Every tile `(col,row)` carries exactly two triangles; the terrain type comes from `terrainUp` resp.
 * `terrainDown` of the *same* tile, the corner heights from it and its neighbours:
 *
 * | Kind | Apex `m` | `left` | `right` | x | y |
 * |---|---|---|---|---|---|
 * | `up` | `(col,row)` | `(col,row+1)` | `(col+1,row+1)` | `sx - 16` | `row*20 - 4*m` |
 * | `down` | `(col+1,row+1)` | `(col,row)` | `(col+1,row)` | `sx` | `row*20 - 4*m + 20` |
 *
 * with `sx = col*32 - row*16`. `m/left/right` go into `groundSpriteForTriangle` and
 * `upMaskIndex`/`downMaskIndex` (`terrain-mask.ts`) exactly like this.
 *
 * Verified: for three window positions all generated tuples (kind, source tile, m, left, right, x,
 * y, ground sprite, mask index) match the pixel-verified column traversal 1218/1218 exactly.
 *
 * Difference to {@link cellTriangles}: this is the original geometry for the mask based texture
 * rendering; `cellTriangles` yields the corner points of the simpler colour triangle preview.
 */
export interface TerrainTriangle {
  readonly kind: 'up' | 'down';
  /** Height of the apex - argument `m` of the mask formulas. */
  readonly m: number;
  readonly left: number;
  readonly right: number;
  /** Blit anchor in scene pixels (without pan/zoom and without mask pivot). */
  readonly x: number;
  readonly y: number;
}

/**
 * The two ground triangles of tile `(col,row)` in original geometry (see {@link TerrainTriangle}).
 * `heightAt` has to apply the map wrap itself.
 */
export function terrainTriangle(
  kind: 'up' | 'down',
  col: number,
  row: number,
  heightAt: (col: number, row: number) => number,
  heightUnit: number = HEIGHT_UNIT,
): TerrainTriangle {
  const sx = col * TILE_W - row * (TILE_W / 2);
  if (kind === 'up') {
    const m = heightAt(col, row);
    return {
      kind,
      m,
      left: heightAt(col, row + 1),
      right: heightAt(col + 1, row + 1),
      x: sx - TILE_W / 2,
      y: row * TILE_H - m * heightUnit,
    };
  }
  const m = heightAt(col + 1, row + 1);
  return {
    kind,
    m,
    left: heightAt(col, row),
    right: heightAt(col + 1, row),
    x: sx,
    y: row * TILE_H - m * heightUnit + TILE_H,
  };
}

/**
 * Is a triangle's slope in the valid range? The original only knows height differences in `[-4,4]`
 * between apex and base corners; anything beyond would be a broken map and is skipped while drawing.
 */
export function triangleSlopeValid(t: TerrainTriangle): boolean {
  return (
    t.left - t.m >= -4 && t.left - t.m <= 4 && t.right - t.m >= -4 && t.right - t.m <= 4
  );
}

/**
 * Inverse of {@link vertexScreen}: finds the nearest map tile `(col,row)` for a point in scene
 * coordinates (before pan/zoom, including the `mapPixelBounds` offsets), or `null` if the point lies
 * too far outside.
 *
 * Forward is `sceneX = col*TILE_W - row*TILE_W/2 + offsetX`, `sceneY = row*TILE_H - h*heightUnit +
 * offsetY`. Flat (`heightUnit = 0`) that is invertible in closed form; in relief `sceneY` depends via
 * `-h*heightUnit` on the per-vertex height. Since the height only pulls the vertex up (`h >= 0`), the
 * true row is never below the flat estimate - so the search runs a few rows down from it (the span
 * covers the maximum lift `MAX_HEIGHT*heightUnit`) and picks the nearest vertex.
 */
export function screenToTile(
  sceneX: number,
  sceneY: number,
  cols: number,
  rows: number,
  heightAt: (col: number, row: number) => number,
  heightUnit: number = HEIGHT_UNIT,
): { col: number; row: number } | null {
  const { offsetX, offsetY } = mapPixelBounds(cols, rows, heightUnit);
  const vx = sceneX - offsetX; // = col*TILE_W - row*TILE_W/2
  const vy = sceneY - offsetY; // = row*TILE_H - h*heightUnit (<= row*TILE_H, since h >= 0)

  const rowFlat = Math.floor(vy / TILE_H);
  const rowSpan = Math.ceil((MAX_HEIGHT * heightUnit) / TILE_H) + 1; // height lift in rows
  const rowLo = rowFlat - 1;
  const rowHi = rowFlat + rowSpan + 1;

  let best: { col: number; row: number } | null = null;
  let bestDist = Infinity;
  for (let row = rowLo; row <= rowHi; row++) {
    if (row < 0 || row >= rows) continue;
    // invert the horizontal shear: col = (vx + row*TILE_W/2) / TILE_W
    const col = Math.round((vx + row * (TILE_W / 2)) / TILE_W);
    if (col < 0 || col >= cols) continue;
    const p = vertexScreen(col, row, heightAt(col, row), heightUnit);
    const dx = p.x + offsetX - sceneX;
    const dy = p.y + offsetY - sceneY;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = { col, row };
    }
  }
  // accept only when the cursor really is near a tile (not in the empty margin)
  return best !== null && bestDist <= TILE_W * TILE_W ? best : null;
}

/**
 * Terrain type names (index 0..15). Water/grass/desert/tundra/snow in variants - the variant encodes
 * transitions and altitude, the base category the look.
 */
export const TERRAIN_NAMES: readonly string[] = [
  'Water0', 'Water1', 'Water2', 'Water3',
  'Grass0', 'Grass1', 'Grass2', 'Grass3',
  'Desert0', 'Desert1', 'Desert2',
  'Tundra0', 'Tundra1', 'Tundra2',
  'Snow0', 'Snow1',
];

/**
 * Base colour per terrain type (RGB) for the colour based renderer. Plausible category colours, not
 * the original palette.
 */
export const TERRAIN_BASE_COLORS: readonly [number, number, number][] = [
  [40, 80, 160], [44, 88, 172], [48, 96, 184], [52, 104, 196], // water 0..3 (deeper to lighter)
  [70, 130, 50], [84, 148, 58], [104, 160, 70], [128, 172, 86], // Grass 0..3
  [196, 178, 120], [206, 190, 132], [216, 200, 146], // Desert 0..2
  [120, 104, 78], [136, 120, 92], [150, 134, 104], // Tundra 0..2
  [216, 220, 228], [236, 240, 246], // Snow 0..1
];

/** RGB colour of a terrain type (0..15), magenta fallback when out of range. */
export function terrainColor(type: number): [number, number, number] {
  return TERRAIN_BASE_COLORS[type] ?? [255, 0, 255];
}

/**
 * Height shading factor (~0.6..1.15) from the height difference to the neighbour, to make the relief
 * visible. `slope = thisHeight - refHeight`; rising towards the viewer means lighter.
 */
export function heightShade(slope: number): number {
  const f = 1 + slope * 0.06;
  return Math.max(0.6, Math.min(1.15, f));
}

/** Applies a shading factor to an RGB colour (clamped to 0..255). */
export function shadeColor(
  rgb: readonly [number, number, number],
  factor: number,
): [number, number, number] {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * factor))),
  ];
}

// --- archive asset base indices (0-based, for the texture/object renderer) ---
/** Ground textures (solid, 33 of them) - sprite index = MAP_GROUND_BASE + texture(0..32). */
export const MAP_GROUND_BASE = 259;
/** Up/down triangle masks (mask, 81 each). */
export const MAP_MASK_UP_BASE = 59;
export const MAP_MASK_DOWN_BASE = 140;
/** Map objects (trees/stones, transparent). */
export const MAP_OBJECT_BASE = 1249;
/** Object shadows (overlay). */
export const MAP_SHADOW_BASE = 1499;
/**
 * Waves on the water (bank `MapWaves`, transparent) - sprite index = `MAP_WAVES_BASE + frame` with
 * `frame` from {@link waterWaveFrame}.
 *
 * The bank occupies archive slots 629..644 (16 sprites, all 48x19 with pivot (0,0)); the reserve
 * 645..658 behind it is empty. That is the structural evidence for the 16 frames of the mask
 * `andw $0xf` @0x36aed: the bank ends exactly at the animation limit, like the object bank at its
 * own (`ANIMATED_OBJECT_LIMIT`).
 */
export const MAP_WAVES_BASE = 629;

/**
 * The palette index of the water surface - and with it the mask the waves fall through.
 *
 * The original's wave primitive (`0x600`, worker `0x646e4`) copies a source byte only when the
 * target pixel carries exactly this index (`mov $0x8,%edx ; cmp %dl,(%edi)`, at both write sites
 * @0x648bc and @0x64903). So it needs no shape variants per shore layout: the mask is the ground
 * already drawn.
 *
 * That 8 is the water colour comes from the archive, not from an interpretation: the water texture
 * (ground slot 32, used by all four water terrain types) is an area of 640 pixels, index 8 without
 * exception, and `Palette[8]` is `(0,0,175)`. The wave sprites carry only the lighter blues
 * 13/224/225/229.
 */
export const WATER_PALETTE_INDEX = 8;

/**
 * The low bits of the landscape base address - the only quantity of the wave phase that is not in
 * the binary.
 *
 * `draw_map_waves` forms the phase offset from the *address* of the tile
 * (`ptr_c == landscapeBase + 4*pos`, `andw $0x3c` @0x36ac7), not from its position. So it depends on
 * `landscapeBase & 0x3c`, and that base comes from the extender's memory layout - a property of the
 * run, not a literal of the program.
 *
 * The value is therefore measured at the pixel, and in two stages, because one is not enough:
 * `landscapeBase & 0x3c` and the game tick of the capture are both unknown, and a fit over both at
 * once has a wrong solution (`0x8`) that also explains 100 % of the water tiles. So first pin the
 * tick on an animation whose formula has no free parameter - the tree animation
 * ({@link mapObjectSprite}, byte-verified) - then check only the 16 residue classes with that tick.
 * The tick is unique (59 of 59 trees), and `0x18` then explains all 70 water tiles at 100 %, the
 * runner-up class 20 %.
 *
 * Stated limit: that is one capture. Were the value different in another run, only the phase
 * distribution across the columns would shift - frame count, rate and position of the waves do not
 * depend on it.
 */
const WAVE_BASE_LOW_BITS = 0x18;

/**
 * Wave frame of a water tile (`draw_map_waves` @0x36a84), step by step:
 *
 * ```
 * @0x36abf vreg2 = ptr_c ; landscape ADDRESS of this tile
 * @0x36ac7 vreg2 &= 0x3c
 * @0x36acc vreg2 += vreg2 ; x2
 * @0x36ad4 vreg2 ^= 0xa8
 * @0x36ada vreg2 += gs->gameTick
 * @0x36ae8 vreg2 >>= 3 ; 16-bit - the carry falls away beforehand
 * @0x36aed vreg2 &= 0xf
 * ```
 *
 * The per-tile offset is why the water does not undulate in unison: neighbouring columns run one
 * frame apart. Since `4*pos & 0x3c == (pos & 0xf) << 2` and the map is at least 16 columns wide, it
 * depends only on `col & 0xf`, not on the row. {@link WAVE_BASE_LOW_BITS} shifts that column
 * sequence cyclically.
 */
export function waterWaveFrame(pos: number, tick: number): number {
  const ptr = (WAVE_BASE_LOW_BITS + 4 * pos) & 0x3c;
  const phase = ((ptr + ptr) ^ 0xa8) & 0xffff;
  return (((phase + tick) & 0xffff) >> 3) & 0xf;
}

/**
 * First real map object in a tile's `object` field (values below are none/flag/building/castle =
 * 0..7). From here on trees (8..31), later stone piles (72..79) and so on - contiguous as an object
 * sprite index. The original subtracts exactly this to get the bank offset (`subb $0x8,0x8(%edi)`
 * @0x34094).
 */
export const MAP_OBJECT_FIRST = 8;

/**
 * Upper bound of the animated object range, as bank offset `object - 8` (`cmpw $0x18` @0x340a7).
 * Covers objects 8..31 - the same limit against which `entity-layer` counts the tree visibility
 * counter `vp+0x1b6` (`addw $0x1,0x1b6(%ebx)` @0x340b1 sits inside this branch), so the two numbers
 * support each other.
 */
const ANIMATED_OBJECT_LIMIT = 0x18;
/** Boundary between the 8-frame and 4-frame bank, as bank offset (`cmpw $0x10` @0x340ea). */
const ANIMATED_OBJECT_SHORT_BANK = 0x10;

/**
 * Returns the (0-based) archive sprite index for the map object of a tile, or `null` when the tile
 * carries no object of its own (none/flag/building are drawn separately). The object sprite space
 * starts at `MAP_OBJECT_BASE` and coincides with `object - 8`.
 *
 * Trees sway: for objects 8..31 the original (branch `@0x340a7` of `draw_map_tile_dispatch`) replaces
 * the bank offset with one computed from the game tick; everything else goes into the same blit
 * unchanged.
 *
 * Three things are not obvious. The low bits of the object byte are not a tree VARIANT but the frame
 * number - the original throws them away and sets them from the tick, so a tree has no lasting look of
 * its own and an animation computed on top of the stored sprite would be wrong. The offset `+ v` sits
 * BEFORE the shift, so it is a fraction of a frame: trees of the same bank run in step and only stagger
 * their change by one tick at the boundary. And the arithmetic is 16-bit throughout, which is not
 * observable here - the truncated carry is a multiple of 8 and vanishes in both masks.
 *
 * The banks: `v` 0..7 and 8..15 with 8 frames each (deciduous/conifer), `v` 16..19 and 20..23 with 4
 * each (palm, water tree). At 100 Hz the frame changes every 16 ticks, so a cycle is 1.28 s resp.
 * 0.64 s.
 *
 * @param tick game tick (`gs+0x206`, `header.tick` here). Mandatory so no call site silently draws
 * the animated range as static.
 */
export function mapObjectSprite(object: number, tick: number): number | null {
  if (object < MAP_OBJECT_FIRST) return null; // `jb 0x34158` @0x34098
  let v = object - MAP_OBJECT_FIRST;
  if (v < ANIMATED_OBJECT_LIMIT) {
    const phase = ((tick + v) & 0xffff) >>> 4; // @0x340dd/@0x340e1/@0x340e5 - 16-bit
    v =
      v < ANIMATED_OBJECT_SHORT_BANK
        ? (v & 0x78) + (phase & 7) // @0x340f1/@0x340f6
        : (v & 0x7c) + (phase & 3); // @0x34105/@0x3410a
  }
  return MAP_OBJECT_BASE + v;
}
