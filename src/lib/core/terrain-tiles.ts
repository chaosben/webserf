/**
 * Pre-composed ground triangles (backend independent).
 *
 * The original draws a terrain triangle as a **ground texture clipped to a triangle mask**
 * (`terrain-mask.ts`). Done naively that costs three operations per triangle: tile the texture ->
 * mask via `destination-in` -> blit. With 1100 ground triangles in the original field of view (and
 * over 11000 on a modern full screen) that is the dominating item.
 *
 * But the composition depends **only** on the pair `(mask, ground texture)`: the texture is tiled in
 * **mask-local** coordinates (`x % gw`, `y % gh`), not in scene coordinates. So the result is
 * identical per pair, wherever the triangle lies — it can be composed once and drawn as **one** blit
 * afterwards.
 *
 * **Measured** over the full maps of three real saves: theoretically possible are 2 x 81 masks x 33
 * textures = 5346 pairs; in reality **490 distinct pairs** occur, together **1.53 MB** of RGBA
 * (3.2 KiB per pair on average). So the cache converges.
 *
 * Two cross-checks from the same measurement:
 * - Of the 162 mask slots only **122 are occupied** — exactly the 40 missing ones correspond to the
 *   `-1` entries of the slope tables `TRI_MASK_UP`/`TRI_MASK_DOWN` (20 each). Mask bank and slope
 *   tables therefore agree independently of one another.
 * - The masks are **not** all 32 x 20 but 32 x 9 ... 32 x 41 (steep slopes need taller masks) — an
 *   earlier estimate assuming a flat 32 x 20 was 20 % too low (1.20 MB).
 *
 * This module holds the **pure** part (pixel composition + keys) plus a generic cache whose upload
 * step the backend provides — Canvas 2D uploads into a `<canvas>`/`ImageBitmap`, a later WebGL
 * backend into a texture/atlas tile. The composition itself is untouched by that and testable without
 * a DOM.
 */

import type { IndexedSprite } from './sprite-indexed.js';
import type { DecodedSprite } from './types.js';
import { MAP_MASK_DOWN_BASE, MAP_MASK_UP_BASE } from './map-render.js';

/** Number of masks per triangle kind (9 x 9 slope combinations). */
export const TERRAIN_MASK_COUNT = 81;

/**
 * A finished composed ground triangle: RGBA pixels in mask size, plus the **mask's pivot**
 * (`offsetX`/`offsetY` of the mask sprite, negative for down masks). The caller blits at
 * `triangle anchor + pivot`.
 */
export interface ComposedTerrainTile {
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** RGBA, length `width * height * 4`; alpha == the mask's alpha (0 or 255). */
  readonly pixels: Uint8ClampedArray;
}

/**
 * Composes ground texture x triangle mask into a single blit-ready image.
 *
 * The texture is tiled **mask-locally** (`x % ground.width`, `y % ground.height`) — exactly as the
 * verified reference traversal does, and only for that reason the result is position independent and
 * hence cacheable. Taken over are the texture's colour and the **mask's alpha**; the mask is 1-bit
 * (alpha 0 or 255).
 */
export function composeTerrainTile(
  mask: DecodedSprite,
  ground: DecodedSprite,
): ComposedTerrainTile {
  const { width, height } = mask;
  const gw = ground.width;
  const gh = ground.height;
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (gw <= 0 || gh <= 0) {
    return { width, height, offsetX: mask.offsetX, offsetY: mask.offsetY, pixels };
  }

  for (let y = 0; y < height; y++) {
    const gy = y % gh;
    for (let x = 0; x < width; x++) {
      const mi = (y * width + x) * 4;
      const alpha = mask.pixels[mi + 3]!;
      if (alpha === 0) continue; // outside the triangle — stays transparent
      const gi = (gy * gw + (x % gw)) * 4;
      pixels[mi] = ground.pixels[gi]!;
      pixels[mi + 1] = ground.pixels[gi + 1]!;
      pixels[mi + 2] = ground.pixels[gi + 2]!;
      pixels[mi + 3] = alpha;
    }
  }
  return { width, height, offsetX: mask.offsetX, offsetY: mask.offsetY, pixels };
}

/**
 * Archive sprite index of the triangle mask for `(kind, mask index 0..80)`. Up and down masks live in
 * two separate banks (81 entries each).
 */
export function terrainMaskSprite(kind: 'up' | 'down', maskIndex: number): number {
  return (kind === 'up' ? MAP_MASK_UP_BASE : MAP_MASK_DOWN_BASE) + maskIndex;
}

/**
 * Cache key of a composed triangle. Both parts are archive sprite indices; the pair `(mask, texture)`
 * determines the image completely — the triangle kind is already in the mask index, because up and
 * down masks are separate banks.
 */
export function terrainTileKey(maskSprite: number, groundSprite: number): number {
  return maskSprite * 4096 + groundSprite;
}

/** Sprite source: the decoded sprite for an archive index, or `null`. */
export type TerrainSpriteSource = (
  index: number,
  type: 'solid' | 'mask',
) => DecodedSprite | null;

/** A triangle uploaded into the backend: backend image + the mask's blit pivot. */
export interface UploadedTerrainTile<T> {
  readonly image: T;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Lazy cache for pre-composed ground triangles, generic over the backend image `T`.
 *
 * The backend passes two functions: where the sprites come from (`sprites`) and how a composed RGBA
 * image moves into its image format (`upload`). After that `get()` is a plain lookup with first fill —
 * the expensive composition happens once per pair.
 *
 * Missing or broken sprites are memoised as `null` (negative cache), so a defective archive entry is
 * not decoded again every frame.
 */
export class TerrainTileCache<T> {
  #entries = new Map<number, UploadedTerrainTile<T> | null>();
  #composed = 0;

  constructor(
    private readonly sprites: TerrainSpriteSource,
    private readonly upload: (tile: ComposedTerrainTile) => T | null,
  ) {}

  /**
   * Pre-composed triangle for `(kind, mask index, ground sprite)`, or `null` if the sprites involved
   * are missing.
   */
  get(
    kind: 'up' | 'down',
    maskIndex: number,
    groundSprite: number,
  ): UploadedTerrainTile<T> | null {
    const maskSprite = terrainMaskSprite(kind, maskIndex);
    const key = terrainTileKey(maskSprite, groundSprite);
    const hit = this.#entries.get(key);
    if (hit !== undefined) return hit;

    let entry: UploadedTerrainTile<T> | null = null;
    const mask = this.sprites(maskSprite, 'mask');
    const ground = this.sprites(groundSprite, 'solid');
    if (mask !== null && ground !== null) {
      const composed = composeTerrainTile(mask, ground);
      this.#composed++;
      const image = this.upload(composed);
      if (image !== null) {
        entry = { image, offsetX: composed.offsetX, offsetY: composed.offsetY };
      }
    }
    this.#entries.set(key, entry);
    return entry;
  }

  /** Number of known pairs (including those memoised as missing). */
  get size(): number {
    return this.#entries.size;
  }

  /** How often composition really happened — should converge to the number of distinct pairs. */
  get composedCount(): number {
    return this.#composed;
  }

  clear(): void {
    this.#entries.clear();
    this.#composed = 0;
  }
}

// --- indexed variant -----------------------------------------------------------------------------
//
// Sibling of the cache above for the palette-indexed render path (`index-target.ts`). It shares the
// key functions `terrainMaskSprite`/`terrainTileKey` with it — only the composition works on indices
// instead of RGBA. Kept separate because the RGBA path serves the asset viewer, where no palette is
// carried along.

/** Sprite source in indexed form. */
export type IndexedTerrainSpriteSource = (
  index: number,
  type: 'solid' | 'mask',
) => IndexedSprite | null;

/**
 * Composes ground texture x triangle mask in index space: taken over are the **texture's index**
 * (tiled mask-locally) and the **mask's shape**. The pivot comes from the mask.
 *
 * **OPEN @0x6434a — deliberate deviation at the upper clip edge.** The original worker `@0x64270`
 * also tiles the texture mask-locally, but when a triangle is **clipped at the top** it subtracts the
 * number of skipped rows from the texture remainder row `0x1cbc` (@0x6434a) **without** advancing the
 * texture row base `0x1cb4` (`ebx = 0` on both paths to @0x64385). So the texture phase depends on
 * the clip rectangle instead of the triangle there; with a skip >= texture height the pointer even
 * runs out of the sprite. Not reproduced, and that is a decision: our clip rectangle is the **dirty
 * rect** of the retained surface, and reproducing this would make the output depend on the scroll
 * history and break the guard "retained == full rebuild, 0 pixels". Measured cost: it is the **whole**
 * remainder of the four capture pairs in the upper ~20 px, 0.04-0.19 % of the ground area.
 */
export function composeTerrainTileIndexed(
  mask: IndexedSprite,
  ground: IndexedSprite,
): IndexedSprite {
  const { width, height } = mask;
  const gw = ground.width;
  const gh = ground.height;
  const indices = new Uint8Array(width * height);
  const opaque = new Uint8Array(width * height);
  if (gw > 0 && gh > 0) {
    for (let y = 0; y < height; y++) {
      const gy = y % gh;
      for (let x = 0; x < width; x++) {
        const mi = y * width + x;
        if (mask.opaque[mi] === 0) continue; // outside the triangle
        indices[mi] = ground.indices[gy * gw + (x % gw)]!;
        opaque[mi] = 1;
      }
    }
  }
  return {
    width,
    height,
    offsetX: mask.offsetX,
    offsetY: mask.offsetY,
    deltaX: 0,
    deltaY: 0,
    indices,
    opaque,
    shade: false,
  };
}

/** Lazy cache of the pre-composed triangles in index space. */
export class IndexedTerrainTileCache {
  #entries = new Map<number, IndexedSprite | null>();
  #composed = 0;

  constructor(private readonly sprites: IndexedTerrainSpriteSource) {}

  get(kind: 'up' | 'down', maskIndex: number, groundSprite: number): IndexedSprite | null {
    const maskSprite = terrainMaskSprite(kind, maskIndex);
    const key = terrainTileKey(maskSprite, groundSprite);
    const hit = this.#entries.get(key);
    if (hit !== undefined) return hit;

    let entry: IndexedSprite | null = null;
    const mask = this.sprites(maskSprite, 'mask');
    const ground = this.sprites(groundSprite, 'solid');
    if (mask !== null && ground !== null) {
      entry = composeTerrainTileIndexed(mask, ground);
      this.#composed++;
    }
    this.#entries.set(key, entry);
    return entry;
  }

  get size(): number {
    return this.#entries.size;
  }

  get composedCount(): number {
    return this.#composed;
  }

  clear(): void {
    this.#entries.clear();
    this.#composed = 0;
  }
}
