import { describe, expect, it } from 'vitest';
import {
  TerrainTileCache,
  composeTerrainTile,
  terrainMaskSprite,
  terrainTileKey,
} from './terrain-tiles.js';
import { MAP_MASK_DOWN_BASE, MAP_MASK_UP_BASE } from './map-render.js';
import type { DecodedSprite } from './types.js';

/** Synthetic sprite with freely set pixels. */
function sprite(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
  offsetX = 0,
  offsetY = 0,
): DecodedSprite {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  return { width, height, offsetX, offsetY, deltaX: 0, deltaY: 0, pixels };
}

/** Mask: top half set (opaque white), bottom empty — 1-bit as in the original. */
const halfMask = (w: number, h: number, offX = 0, offY = 0) =>
  sprite(w, h, (_x, y) => (y < h / 2 ? [255, 255, 255, 255] : [0, 0, 0, 0]), offX, offY);

/** Texture whose colour encodes the source coordinate — makes the tiling checkable. */
const coordTexture = (w: number, h: number) =>
  sprite(w, h, (x, y) => [x, y, 7, 255]);

describe('composeTerrainTile', () => {
  it('takes over mask size and mask pivot', () => {
    const t = composeTerrainTile(halfMask(32, 20, 3, -19), coordTexture(32, 20));
    expect(t.width).toBe(32);
    expect(t.height).toBe(20);
    expect(t.offsetX).toBe(3);
    expect(t.offsetY).toBe(-19);
    expect(t.pixels).toHaveLength(32 * 20 * 4);
  });

  it('tiles the texture MASK-LOCALLY (x % gw, y % gh) — the basis for caching', () => {
    // Textur 8×4, Maske 20×4: Spalte 9 muss Textur-Spalte 1 zeigen, Zeile 3 → Textur-Zeile 3.
    const t = composeTerrainTile(
      sprite(20, 4, () => [255, 255, 255, 255]),
      coordTexture(8, 4),
    );
    const at = (x: number, y: number) => {
      const i = (y * 20 + x) * 4;
      return [t.pixels[i], t.pixels[i + 1]];
    };
    expect(at(0, 0)).toEqual([0, 0]);
    expect(at(9, 1)).toEqual([1, 1]);
    expect(at(17, 3)).toEqual([1, 3]);
  });

  it('alpha comes from the mask; masked-out pixels stay fully transparent', () => {
    const t = composeTerrainTile(halfMask(4, 4), coordTexture(4, 4));
    const alpha = (x: number, y: number) => t.pixels[(y * 4 + x) * 4 + 3];
    expect(alpha(0, 0)).toBe(255);
    expect(alpha(0, 3)).toBe(0);
    // Masked out also means: no colour residue a backend could let shine through.
    const i = (3 * 4 + 0) * 4;
    expect([t.pixels[i], t.pixels[i + 1], t.pixels[i + 2]]).toEqual([0, 0, 0]);
  });

  it('an empty texture yields an empty image rather than a crash', () => {
    const t = composeTerrainTile(halfMask(4, 4), sprite(0, 0, () => [0, 0, 0, 0]));
    expect(t.width).toBe(4);
    expect(Array.from(t.pixels).every((v) => v === 0)).toBe(true);
  });
});

describe('key construction', () => {
  it('up and down masks live in separate banks (the kind is in the mask sprite)', () => {
    expect(terrainMaskSprite('up', 0)).toBe(MAP_MASK_UP_BASE);
    expect(terrainMaskSprite('down', 0)).toBe(MAP_MASK_DOWN_BASE);
    expect(terrainMaskSprite('up', 80)).not.toBe(terrainMaskSprite('down', 0));
  });

  it('the key is collision free over the range of values that can occur', () => {
    const seen = new Set<number>();
    for (const kind of ['up', 'down'] as const) {
      for (let mask = 0; mask < 81; mask++) {
        for (let ground = 259; ground < 259 + 33; ground++) {
          const k = terrainTileKey(terrainMaskSprite(kind, mask), ground);
          expect(seen.has(k), `Kollision bei ${kind}/${mask}/${ground}`).toBe(false);
          seen.add(k);
        }
      }
    }
    expect(seen.size).toBe(2 * 81 * 33);
  });
});

describe('TerrainTileCache', () => {
  /** Counts sprite accesses so cache hits can be shown. */
  function fixture() {
    let spriteCalls = 0;
    let uploads = 0;
    const cache = new TerrainTileCache<string>(
      (index, type) => {
        spriteCalls++;
        if (index === 999) return null; // simulates a missing archive entry
        return type === 'mask' ? halfMask(32, 20, 1, -19) : coordTexture(32, 20);
      },
      (tile) => {
        uploads++;
        return `img:${tile.width}x${tile.height}`;
      },
    );
    return {
      cache,
      counts: () => ({ spriteCalls, uploads }),
    };
  }

  it('composes once per pair and returns the same entry afterwards', () => {
    const { cache, counts } = fixture();
    const a = cache.get('up', 40, 259);
    const b = cache.get('up', 40, 259);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(counts().uploads).toBe(1);
    expect(cache.composedCount).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('trennt Paare nach Maske, Boden UND Dreiecksart', () => {
    const { cache } = fixture();
    cache.get('up', 40, 259);
    cache.get('up', 41, 259);
    cache.get('up', 40, 260);
    cache.get('down', 40, 259);
    expect(cache.composedCount).toBe(4);
  });

  it('passes the mask pivot through (the caller\'s blit anchor)', () => {
    const { cache } = fixture();
    const t = cache.get('down', 12, 259)!;
    expect(t.offsetX).toBe(1);
    expect(t.offsetY).toBe(-19);
    expect(t.image).toBe('img:32x20');
  });

  it('remembers missing sprites negatively — no re-decoding per frame', () => {
    const { cache, counts } = fixture();
    expect(cache.get('up', 40, 999)).toBeNull();
    const after = counts().spriteCalls;
    expect(cache.get('up', 40, 999)).toBeNull();
    expect(counts().spriteCalls).toBe(after);
    expect(cache.composedCount).toBe(0);
  });

  it('clear() verwirft alles', () => {
    const { cache } = fixture();
    cache.get('up', 40, 259);
    cache.clear();
    expect(cache.size).toBe(0);
    cache.get('up', 40, 259);
    expect(cache.composedCount).toBe(1);
  });
});
