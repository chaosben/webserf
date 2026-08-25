/**
 * Sprite kits for the map renderer: decodes archive sprites once and hands them out in palette-index
 * form (colour only appears when presenting, see `core/index-target.ts`).
 *
 * A kit has to survive across frames: the draw passes run per frame and per dirty rect — without a
 * cache every movement would be a full decode.
 */

import { loadAnimationTable, type AnimationTable } from '../core/animation-parser.js';
import { MAP_BORDER_BASE } from '../core/border-layer.js';
import { MAP_OBJECT_BASE } from '../core/building-sprites.js';
import type { KitSprite } from '../core/draw-target.js';
import type { EntitySpriteKit } from '../core/entity-layer.js';
import { flagSpriteOffset } from '../core/flag-sprites.js';
import type { PaArchive } from '../core/pa-parser.js';
import { PLAYER_RAMP_BASE, stickIndexed } from '../core/player-color.js';
import { SERF_SHADOW_BASE, buildTorsoIndexed } from '../core/serf-sprites.js';
import { decodeSpriteIndexed, type IndexedSprite } from '../core/sprite-indexed.js';
import { composeTerrainTileIndexed } from '../core/terrain-tiles.js';

/** `null` on a parse error — the application stays usable without animations. */
export function tryLoadAnimationTable(archive: PaArchive): AnimationTable | null {
  try {
    return loadAnimationTable(archive);
  } catch {
    return null;
  }
}

/** Decodes archive sprites into index form, cached by `(type, offset, index)`. */
export function createIndexedSpriteSource(
  archive: PaArchive,
): (index: number, type: 'solid' | 'mask' | 'transparent' | 'overlay', colorOffset?: number) => IndexedSprite | null {
  const cache = new Map<string, IndexedSprite | null>();
  return (index, type, colorOffset = 0) => {
    const key = `${type}:${colorOffset}:${index}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let decoded: IndexedSprite | null = null;
    try {
      const raw = archive.getRaw(index);
      if (raw !== null) {
        decoded = decodeSpriteIndexed(
          raw,
          type === 'transparent' ? { type, colorOffset } : { type },
        );
      }
    } catch {
      decoded = null;
    }
    cache.set(key, decoded);
    return decoded;
  };
}


function kitSprite(s: IndexedSprite | null): KitSprite<IndexedSprite> | null {
  return s === null
    ? null
    : { image: s, offsetX: s.offsetX, offsetY: s.offsetY, deltaX: s.deltaX, deltaY: s.deltaY };
}

export function buildSpriteKit(archive: PaArchive): EntitySpriteKit<IndexedSprite> {
  const decode = createIndexedSpriteSource(archive);

  // THE KEY IS A NUMBER, NOT A STRING — and that is not cosmetics: `sprite()` is called once per
  // blit, which at 9 % zoom on a 512×256 map is about 105,000 times per frame (body plus shadow per
  // map object, plus the waves per water tile). A `${type}:${index}` key costs a string allocation
  // and a hash per blit; measured on a reported state the entity pass was 36 ms instead of 14 ms.
  // The value range is the archive index (0..3999) across two sprite kinds, so a flat table is
  // enough — and `undefined` (never asked for) stays distinguishable from `null` (not in the
  // archive), which the cache relies on.
  const spriteCache: (KitSprite<IndexedSprite> | null | undefined)[] = [];
  const sprite = (index: number, type: 'transparent' | 'overlay'): KitSprite<IndexedSprite> | null => {
    const key = index * 2 + (type === 'overlay' ? 1 : 0);
    const hit = spriteCache[key];
    if (hit !== undefined) return hit;
    const result = kitSprite(decode(index, type));
    spriteCache[key] = result;
    return result;
  };

  // Torso decoded on the owner's colour ramp — no recolouring needed.
  const torsoCache = new Map<string, KitSprite<IndexedSprite> | null>();
  const torso = (owner: number, torsoIndex: number): KitSprite<IndexedSprite> | null => {
    const key = `${owner}:${torsoIndex}`;
    const hit = torsoCache.get(key);
    if (hit !== undefined) return hit;
    const built = buildTorsoIndexed(
      torsoIndex,
      PLAYER_RAMP_BASE[owner] ?? PLAYER_RAMP_BASE[0]!,
      (i, co) => decode(i, 'transparent', co),
      stickIndexed,
    );
    const result = kitSprite(built);
    torsoCache.set(key, result);
    return result;
  };

  // The archive holds four ready-made versions per waving frame, one per player colour.
  const flag = (frame: number, owner: number): KitSprite<IndexedSprite> | null =>
    sprite(MAP_OBJECT_BASE + flagSpriteOffset(frame, owner), 'transparent');

  return { sprite, torso, serfShadow: sprite(SERF_SHADOW_BASE, 'overlay'), flag };
}

/** Road tiles per `(mask, ground)`: texture tiled mask-locally and cut by the mask. */
export function buildRoadKit(
  archive: PaArchive,
): (maskIndex: number, groundIndex: number) => IndexedSprite | null {
  const decode = createIndexedSpriteSource(archive);
  const tiles = new Map<string, IndexedSprite | null>();
  return (maskIndex: number, groundIndex: number): IndexedSprite | null => {
    const key = `${maskIndex}:${groundIndex}`;
    const hit = tiles.get(key);
    if (hit !== undefined) return hit;
    let result: IndexedSprite | null = null;
    const mask = decode(maskIndex, 'mask');
    const ground = decode(groundIndex, 'solid');
    if (mask !== null && ground !== null) {
      // The road pass positions by itself; the mask pivot does not belong in here.
      result = composeTerrainTileIndexed({ ...mask, offsetX: 0, offsetY: 0 }, ground);
    }
    tiles.set(key, result);
    return result;
  };
}

/** Border-stone sprites per bank index 0..9. */
export function buildBorderKit(
  archive: PaArchive,
): (borderIndex: number) => IndexedSprite | null {
  const decode = createIndexedSpriteSource(archive);
  const cache = new Map<number, IndexedSprite | null>();
  return (borderIndex: number): IndexedSprite | null => {
    const hit = cache.get(borderIndex);
    if (hit !== undefined) return hit;
    const image = decode(MAP_BORDER_BASE + borderIndex, 'transparent');
    cache.set(borderIndex, image);
    return image;
  };
}
