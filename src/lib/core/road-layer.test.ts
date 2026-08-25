import { describe, expect, it } from 'vitest';
import { drawRoadLayer, type RoadTileData } from './road-layer.js';
import type { Blitter, DrawImage } from './draw-target.js';
import { buildWindowFrame, tileAnchor } from './window-frame.js';
import { tileScene, type Camera } from './viewport-camera.js';
import { mapGeometry, posOf } from './engine/position.js';
import { PATH_GROUND_BASE, PATH_MASK_BASE } from './road-render.js';
import { TILE_W } from './map-render.js';

const geo = mapGeometry(0); // 32 × 16

interface Img extends DrawImage {
  readonly mask: number;
  readonly ground: number;
}

class Recorder implements Blitter<Img> {
  readonly draws: Array<{ mask: number; ground: number; x: number; y: number }> = [];
  blit(image: Img, x: number, y: number): void {
    this.draws.push({ mask: image.mask, ground: image.ground, x, y });
  }
  blitPartial(): void {
    throw new Error('Wege zeichnen nie teilweise');
  }
  blitOverIndex(): void {
    throw new Error('Wege zeichnen nie bedingt');
  }
}

const tileFor = (mask: number, ground: number): Img => ({ width: 32, height: 32, mask, ground });

function makeTiles(
  paths: ReadonlyMap<number, number>,
  heights: ReadonlyMap<number, number> = new Map(),
  terrain: ReadonlyMap<number, { up?: number; down?: number }> = new Map(),
): RoadTileData[] {
  return Array.from({ length: geo.tileCount }, (_, pos) => ({
    height: heights.get(pos) ?? 0,
    terrainUp: terrain.get(pos)?.up ?? 5,
    terrainDown: terrain.get(pos)?.down ?? 5,
    paths: paths.get(pos) ?? 0,
  }));
}

function frameAround(col: number, row: number, width = 320, height = 240) {
  const p = tileScene(col, row);
  const cam: Camera = { originX: p.x - width / 2, originY: p.y - height / 2, width, height };
  return buildWindowFrame(cam, geo, 0);
}

function run(tiles: RoadTileData[], frame: ReturnType<typeof frameAround>, heightUnit = 0): Recorder {
  const rec = new Recorder();
  drawRoadLayer(rec, frame, { tiles, geo, heightUnit, tile: tileFor });
  return rec;
}

describe('drawRoadLayer', () => {
  it('draws a segment exactly ONCE, even though both ends carry a road bit', () => {
    // Tile A has Right (bit 0), neighbour B has Left (bit 3) — the same segment. Only the three
    // forward directions may iterate, otherwise every segment is drawn twice.
    const a = posOf(10, 8, geo);
    const b = posOf(11, 8, geo);
    const rec = run(makeTiles(new Map([[a, 1 << 0], [b, 1 << 3]])), frameAround(10, 8));
    expect(rec.draws).toHaveLength(1);
  });

  it('draws across the column seam too', () => {
    // Segment from the last into the first column.
    const last = posOf(geo.cols - 1, 8, geo);
    const rec = run(makeTiles(new Map([[last, 1 << 0]])), frameAround(geo.cols - 1, 8));
    expect(rec.draws.length).toBeGreaterThanOrEqual(1);
  });

  it('draws across the row seam too', () => {
    const last = posOf(10, geo.rows - 1, geo);
    const rec = run(makeTiles(new Map([[last, 1 << 2]])), frameAround(10, geo.rows - 1));
    expect(rec.draws.length).toBeGreaterThanOrEqual(1);
  });

  it('anchors the Down segment half a tile to the left, the others not', () => {
    const pos = posOf(10, 8, geo);
    const frame = frameAround(10, 8);
    const right = run(makeTiles(new Map([[pos, 1 << 0]])), frame).draws[0]!;
    const down = run(makeTiles(new Map([[pos, 1 << 2]])), frame).draws[0]!;
    expect(down.x).toBe(right.x - TILE_W / 2);
  });

  it('sits 2 px above the tile anchor and follows the segment height', () => {
    const pos = posOf(10, 8, geo);
    const frame = frameAround(10, 8);
    const flat = run(makeTiles(new Map([[pos, 1 << 2]])), frame).draws[0]!;
    // Find the tile's anchor in the traversal (the window can contain it more than once).
    let anchorY = Number.NaN;
    for (let i = 0; i < frame.halfRows.length; i++) {
      const k = Array.from(frame.halfRows[i]!.tiles).indexOf(pos);
      if (k >= 0) {
        anchorY = tileAnchor(frame, i, k).y;
        break;
      }
    }
    expect(flat.y).toBe(anchorY - 2);

    const high = run(
      makeTiles(new Map([[pos, 1 << 2]]), new Map([[pos, 5]])),
      frame,
      4,
    ).draws[0]!;
    expect(high.y).toBe(anchorY - 5 * 4 - 2);
  });

  it('picks mask and ground texture from the road tables, not from the backend', () => {
    const pos = posOf(10, 8, geo);
    const rec = run(makeTiles(new Map([[pos, 1 << 0]])), frameAround(10, 8));
    expect(rec.draws[0]!.mask).toBeGreaterThanOrEqual(PATH_MASK_BASE);
    expect(rec.draws[0]!.ground).toBeGreaterThanOrEqual(PATH_GROUND_BASE);
  });

  it('skips tiles without road bits entirely', () => {
    expect(run(makeTiles(new Map()), frameAround(10, 8)).draws).toHaveLength(0);
  });
});

/**
 * Cross slope + governing terrain per direction — read from `FUN_0000e5cd`/`e6ca`/`e791`, the
 * descriptor offsets resolved against `compute_map_window_tiles` @0xd93a. These tests pin **which
 * neighbour tile** enters the calculation.
 */
describe('drawRoadLayer — Boden-Textur-Auswahl', () => {
  const groundOf = (rec: Recorder) => rec.draws[0]!.ground - PATH_GROUND_BASE;

  it('dir 0 Right: the cross slope uses Up and DownRight, factor 3', () => {
    const a = posOf(10, 8, geo);
    const frame = frameAround(10, 8);
    const paths = new Map([[a, 1 << 0]]);
    // Up 6 higher than DownRight => hDiff2 = +6 => variant 0 (threshold >= 5).
    const up = run(makeTiles(paths, new Map([[posOf(10, 7, geo), 6]])), frame);
    expect(groundOf(up)).toBe(0);
    // DownRight 6 higher => hDiff2 = -6 => variant 2 (threshold < -5).
    const down = run(makeTiles(paths, new Map([[posOf(11, 9, geo), 6]])), frame);
    expect(groundOf(down)).toBe(2);
    // Factor 3, not 4 — chosen to discriminate: with h1 = 2 and Up = 1, 1 - 3*2 = -5 => variant 1,
    // with factor 4 it would be 1 - 8 = -7 => variant 2.
    const sharp = run(
      makeTiles(paths, new Map([[a, 2], [posOf(10, 7, geo), 1]])),
      frame,
    );
    expect(groundOf(sharp)).toBe(1);
  });

  it('dir 1 DownRight: the cross slope uses Right and Down', () => {
    const a = posOf(10, 8, geo);
    const frame = frameAround(10, 8);
    const paths = new Map([[a, 1 << 1]]);
    const right = run(makeTiles(paths, new Map([[posOf(11, 8, geo), 3]])), frame);
    expect(groundOf(right)).toBe(0); // 2·3 = 6 >= 5
    const down = run(makeTiles(paths, new Map([[posOf(10, 9, geo), 3]])), frame);
    expect(groundOf(down)).toBe(2); // 2·(−3) = −6 < −5
  });

  it('dir 2 Down: the second term is DownRight, NOT the segment target Down', () => {
    const a = posOf(10, 8, geo);
    const frame = frameAround(10, 8);
    const paths = new Map([[a, 1 << 2]]);
    // DownRight 6 higher, everything else flat => hDiff2 = +6 => variant 0.
    const dr = run(makeTiles(paths, new Map([[posOf(11, 9, geo), 6]])), frame);
    expect(groundOf(dr)).toBe(0);
    // Counter-check: the same +6 on Down (the segment target) gives 3*(0-6) = -18 => variant 2.
    // The first case therefore flips only because DownRight — not Down — sits in the second term.
    const dn = run(makeTiles(paths, new Map([[posOf(10, 9, geo), 6]])), frame);
    expect(groundOf(dn)).toBe(2);
  });

  it('the governing terrain is a PAIR per direction, not a max over both tiles', () => {
    const a = posOf(10, 8, geo);
    const frame = frameAround(10, 8);
    // dir 0: max(A.terrainDown, Up.terrainUp). A high value in the field that is NOT read
    // (A.terrainUp) must not change the group; the same value in Up.terrainUp must.
    const base = run(makeTiles(new Map([[a, 1 << 0]])), frame);
    expect(groundOf(base)).toBe(1); // Gras (5), flach ⇒ Variante 1

    const ignored = run(
      makeTiles(new Map([[a, 1 << 0]]), new Map(), new Map([[a, { up: 15 }]])),
      frame,
    );
    expect(groundOf(ignored)).toBe(1); // A.terrainUp does NOT contribute for dir 0

    const counts = run(
      makeTiles(new Map([[a, 1 << 0]]), new Map(), new Map([[posOf(10, 7, geo), { up: 15 }]])),
      frame,
    );
    expect(groundOf(counts)).toBe(1 + 6); // Up.terrainUp = snow => +6
  });

  it('dir 1 reads BOTH terrain nibbles of its own tile', () => {
    const a = posOf(10, 8, geo);
    const frame = frameAround(10, 8);
    const withUp = run(
      makeTiles(new Map([[a, 1 << 1]]), new Map(), new Map([[a, { up: 15 }]])),
      frame,
    );
    expect(groundOf(withUp)).toBe(1 + 6);
    // The neighbour (DownRight) does NOT contribute.
    const neighbour = run(
      makeTiles(new Map([[a, 1 << 1]]), new Map(), new Map([[posOf(11, 9, geo), { up: 15 }]])),
      frame,
    );
    expect(groundOf(neighbour)).toBe(1);
  });
});
