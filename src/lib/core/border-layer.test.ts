import { describe, expect, it } from 'vitest';
import {
  borderGroundIndex,
  borderSlopeVariant,
  drawBorderLayer,
  MAP_BORDER_BASE,
  type BorderTileData,
} from './border-layer.js';
import type { Blitter, DrawImage } from './draw-target.js';
import { buildWindowFrame, tileAnchor } from './window-frame.js';
import { tileScene, type Camera } from './viewport-camera.js';
import { mapGeometry, posOf } from './engine/position.js';

const geo = mapGeometry(0); // 32 × 16

interface Img extends DrawImage {
  readonly index: number;
}

class Recorder implements Blitter<Img> {
  readonly draws: Array<{ index: number; x: number; y: number }> = [];
  blit(image: Img, x: number, y: number): void {
    this.draws.push({ index: image.index, x, y });
  }
  blitPartial(): void {
    throw new Error('border markers never draw partially');
  }
  blitOverIndex(): void {
    throw new Error('border markers never draw conditionally');
  }
}

const spriteFor = (index: number): Img => ({ width: 6, height: 6, index });

function makeTiles(over: ReadonlyMap<number, Partial<BorderTileData>> = new Map()): BorderTileData[] {
  return Array.from({ length: geo.tileCount }, (_, pos) => ({
    height: 0,
    terrainUp: 5,
    terrainDown: 5,
    paths: 0,
    owner: 0,
    ...over.get(pos),
  }));
}

function frameAround(col: number, row: number, width = 320, height = 240) {
  const p = tileScene(col, row);
  const cam: Camera = { originX: p.x - width / 2, originY: p.y - height / 2, width, height };
  return buildWindowFrame(cam, geo, 0);
}

function run(tiles: BorderTileData[], frame: ReturnType<typeof frameAround>, heightUnit = 0): Recorder {
  const rec = new Recorder();
  drawBorderLayer(rec, frame, { tiles, geo, heightUnit, sprite: spriteFor });
  return rec;
}

describe('drawBorderLayer — condition', () => {
  it('same owner -> no border marker', () => {
    // Whole map to one player: no owner difference anywhere.
    const all = new Map(Array.from({ length: geo.tileCount }, (_, p) => [p, { owner: 1 }] as const));
    const rec = run(makeTiles(all), frameAround(10, 8));
    expect(rec.draws).toHaveLength(0);
  });

  it('own land against no-man\'s-land IS a border (bit 7 enters the XOR)', () => {
    const a = posOf(10, 8, geo);
    const rec = run(makeTiles(new Map([[a, { owner: 1 }]])), frameAround(10, 8));
    // Tile A borders owner 0 in all three forward directions.
    expect(rec.draws.length).toBeGreaterThanOrEqual(3);
  });

  it('with a road there the border is NOT drawn (road and border are exclusive)', () => {
    const a = posOf(10, 8, geo);
    const withoutRoad = run(makeTiles(new Map([[a, { owner: 1 }]])), frameAround(10, 8));
    const withRoad = run(makeTiles(new Map([[a, { owner: 1, paths: 0b111 }]])), frameAround(10, 8));
    // A's three forward directions drop out; the NEIGHBOURS' edges onto A remain.
    expect(withRoad.draws.length).toBe(withoutRoad.draws.length - 3);
  });

  it('every edge exactly once — only the three forward directions iterate', () => {
    // A single tile with a foreign owner: each of its 6 edges is handled from one side.
    const a = posOf(10, 8, geo);
    const rec = run(makeTiles(new Map([[a, { owner: 2 }]])), frameAround(10, 8));
    expect(rec.draws).toHaveLength(6);
    // No two edges on the same pixel — this is where it showed that Down must carry the half-tile
    // offset of the road pass as well (otherwise Down and DownRight coincide).
    const keys = new Set(rec.draws.map((d) => `${d.x},${d.y}`));
    expect(keys.size).toBe(6);
  });
});

describe('borderSlopeVariant / borderGroundIndex — NOT the road pass thresholds', () => {
  it('slope switches at >= 2 and >= -8 (road: >= 5 / >= -5)', () => {
    expect(borderSlopeVariant(2)).toBe(0);
    expect(borderSlopeVariant(1)).toBe(1);
    expect(borderSlopeVariant(-8)).toBe(1);
    expect(borderSlopeVariant(-9)).toBe(2);
    // Exactly in the band where road and border differ:
    expect(borderSlopeVariant(3)).toBe(0); // the road would still be variant 1 here
    expect(borderSlopeVariant(-6)).toBe(1); // the road would already be variant 2 here
  });

  it('terrain groups: water < 4, desert/tundra > 10, snow >= 15', () => {
    expect(borderGroundIndex(0, 0)).toBe(9);
    expect(borderGroundIndex(3, 2)).toBe(9);
    expect(borderGroundIndex(4, 1)).toBe(1); // grass
    expect(borderGroundIndex(10, 1)).toBe(1); // 10 is STILL grass (road: already desert)
    expect(borderGroundIndex(11, 1)).toBe(4); // desert/tundra
    expect(borderGroundIndex(14, 0)).toBe(3); // 14 is STILL tundra (road: already snow)
    expect(borderGroundIndex(15, 0)).toBe(6); // snow
  });

  it('covers exactly the 10 sprites of the bank', () => {
    const seen = new Set<number>();
    for (let type = 0; type < 16; type++) {
      for (const v of [0, 1, 2]) seen.add(borderGroundIndex(type, v));
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('MAP_BORDER_BASE is the 0-based archive index of the bank (DOS 610)', () => {
    expect(MAP_BORDER_BASE).toBe(609);
  });
});

describe('drawBorderLayer — anchor', () => {
  it('x offset: Right +15, DownRight +7, Down -9 (half a tile, as in the road pass)', () => {
    const a = posOf(10, 8, geo);
    const frame = frameAround(10, 8);
    const rec = run(makeTiles(new Map([[a, { owner: 1 }]])), frame);
    // Find tile A's anchor in this frame.
    let anchor: { x: number; y: number } | null = null;
    for (let i = 0; i < frame.halfRows.length && anchor === null; i++) {
      const k = frame.halfRows[i]!.tiles.indexOf(a);
      if (k >= 0) anchor = tileAnchor(frame, i, k);
    }
    expect(anchor).not.toBeNull();
    const xs = rec.draws.filter((d) => d.y === anchor!.y - 4).map((d) => d.x);
    expect(xs).toContain(anchor!.x + 15); // Right
    const ys = rec.draws.filter((d) => d.x === anchor!.x + 7).map((d) => d.y);
    expect(ys).toContain(anchor!.y + 6); // DownRight
    const down = rec.draws.filter((d) => d.x === anchor!.x - 9).map((d) => d.y);
    expect(down).toContain(anchor!.y + 6); // Down — half a tile to the left
  });

  it('height: y drops by (h1+h2)*heightUnit/2 — the MEAN edge height, not the max', () => {
    const a = posOf(10, 8, geo);
    const b = posOf(11, 8, geo);
    const frame = frameAround(10, 8);
    let anchor: { x: number; y: number } | null = null;
    for (let i = 0; i < frame.halfRows.length && anchor === null; i++) {
      const k = frame.halfRows[i]!.tiles.indexOf(a);
      if (k >= 0) anchor = tileAnchor(frame, i, k);
    }
    // Look at exactly A's Right edge (x offset +15, y offset -4).
    const rightEdge = (tiles: BorderTileData[]) => {
      const rec = run(tiles, frame, 4);
      return rec.draws.find((d) => d.x === anchor!.x + 15)!;
    };
    const flat = rightEdge(makeTiles(new Map([[a, { owner: 1 }], [b, { owner: 0 }]])));
    const hilly = rightEdge(
      makeTiles(new Map([[a, { owner: 1, height: 4 }], [b, { owner: 0, height: 2 }]])),
    );
    // (4+2)*4/2 = 12 px above flat — "max(h1,h2)" would give 16, "h1" likewise 16.
    expect(flat.y - hilly.y).toBe(12);
  });
});
