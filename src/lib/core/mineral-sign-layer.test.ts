import { describe, expect, it } from 'vitest';
import { drawMineralSigns, type MineralTileData } from './mineral-sign-layer.js';
import { drawEntityLayer, buildEntityIndex, type EntitySpriteKit } from './entity-layer.js';
import type { Blitter, DrawImage, KitSprite } from './draw-target.js';
import { mapGeometry, posOf } from './engine/position.js';
import { buildWindowFrame, type WindowFrame } from './window-frame.js';
import { tileScene, type Camera } from './viewport-camera.js';
import { MAP_OBJECT_BASE, MAP_SHADOW_BASE } from './building-sprites.js';
import { mineralSignObject } from './engine/mineral-sign.js';
import type { SaveGameState } from './types.js';

// --- recording backend (same idiom as `entity-layer.test.ts`) ------------------------------------

interface Tagged extends DrawImage {
  readonly tag: string;
}
interface Draw {
  readonly tag: string;
  readonly x: number;
  readonly y: number;
}

class Recorder implements Blitter<Tagged> {
  readonly draws: Draw[] = [];
  blit(image: Tagged, x: number, y: number): void {
    this.draws.push({ tag: image.tag, x, y });
  }
  blitPartial(image: Tagged, x: number, y: number): void {
    this.draws.push({ tag: `${image.tag}~`, x, y });
  }
  blitOverIndex(image: Tagged, x: number, y: number, overIndex: number): void {
    this.draws.push({ tag: `${image.tag}@${overIndex}`, x, y });
  }
}

function tagged(tag: string): KitSprite<Tagged> {
  return { image: { tag, width: 8, height: 8 }, offsetX: 0, offsetY: 0, deltaX: 0, deltaY: 0 };
}

/** Object sprites keep their index in the tag, shadows are recognisable as such. */
const spriteOf = (index: number): KitSprite<Tagged> =>
  index >= MAP_SHADOW_BASE ? tagged('shadow') : tagged(`obj${index - MAP_OBJECT_BASE}`);

const GEO = mapGeometry(0); // 32 x 16 tiles => scene period 1024 x 320 px
const HEIGHT_UNIT = 4;

function tiles(patches: ReadonlyMap<number, Partial<MineralTileData>>): MineralTileData[] {
  return Array.from({ length: GEO.tileCount }, (_, pos) => ({
    height: 0,
    object: 0,
    mineral: 0,
    resourceAmount: 0,
    ...(patches.get(pos) ?? {}),
  }));
}

function frameAround(col: number, row: number, width = 320, height = 240): WindowFrame {
  const p = tileScene(col, row);
  const cam: Camera = {
    originX: p.x - width / 2,
    originY: p.y - height / 2,
    width,
    height,
  };
  return buildWindowFrame(cam, GEO, 31);
}

function run(data: MineralTileData[], frame: WindowFrame): Draw[] {
  const rec = new Recorder();
  drawMineralSigns(rec, frame, {
    tiles: data,
    heightUnit: HEIGHT_UNIT,
    tick: 0,
    sprite: spriteOf,
  });
  return rec.draws;
}

describe('drawMineralSigns', () => {
  /**
   * The position test that needs no second calculation: the very sign the pass invents must land
   * where the ENTITY pass puts it when the tile really carries it. That pins the row bias and the
   * height lift against the original path instead of against a number written out here.
   */
  it('lands exactly where the entity pass draws that sign', () => {
    const pos = posOf(10, 8, GEO);
    const frame = frameAround(10, 8);
    const sign = mineralSignObject(1, 20); // gold, large

    const state = {
      header: { tick: 0, mapCols: GEO.cols, mapRows: GEO.rows, tileCount: GEO.tileCount },
      mapTiles: Array.from({ length: GEO.tileCount }, (_, p) => ({
        height: p === pos ? 7 : 0,
        terrainUp: 5,
        terrainDown: 5,
        paths: 0,
        object: p === pos ? sign : 0,
        objIndex: 0,
        serfIndex: 0,
        owner: 0,
        mineral: 0,
        resourceAmount: 0,
      })),
      buildingRecords: [],
      serfRecords: [],
      flagRecords: [],
      inventoryRecords: [],
      playerRecords: [],
    } as unknown as SaveGameState;

    const kit: EntitySpriteKit<Tagged> = {
      sprite: (index) => spriteOf(index),
      torso: () => tagged('serf'),
      serfShadow: tagged('serfShadow'),
      flag: () => tagged('flag'),
    };
    const entityRec = new Recorder();
    drawEntityLayer(entityRec, frame, {
      state,
      geo: GEO,
      heightUnit: HEIGHT_UNIT,
      kit,
      animations: null,
      index: buildEntityIndex(state),
    });
    const body = entityRec.draws.filter((d) => d.tag !== 'shadow');

    const ours = run(tiles(new Map([[pos, { height: 7, mineral: 1, resourceAmount: 20 }]])), frame);

    expect(body.length).toBeGreaterThan(0);
    expect(ours).toEqual(body);
  });

  it('one blit per deposit, and never a shadow', () => {
    const pos = posOf(10, 8, GEO);
    const draws = run(tiles(new Map([[pos, { mineral: 3, resourceAmount: 4 }]])), frameAround(10, 8));

    expect(draws).toHaveLength(1);
    expect(draws[0]!.tag).toBe(`obj${mineralSignObject(3, 4) - 8}`);
    expect(draws.some((d) => d.tag.includes('shadow'))).toBe(false);
  });

  it('draws the small sign below twelve and the large one from twelve on', () => {
    const pos = posOf(10, 8, GEO);
    const frame = frameAround(10, 8);
    const small = run(tiles(new Map([[pos, { mineral: 2, resourceAmount: 11 }]])), frame);
    const large = run(tiles(new Map([[pos, { mineral: 2, resourceAmount: 12 }]])), frame);

    expect(small[0]!.tag).toBe('obj107'); // 0x73 - 8
    expect(large[0]!.tag).toBe('obj106'); // 0x72 - 8
  });

  /**
   * An amount without a mineral is how the original stores FISH — and the sign formula would turn
   * it into ripe grain. The gate sits before the formula, so nothing is drawn.
   */
  it('a fish tile draws nothing', () => {
    const pos = posOf(10, 8, GEO);
    const draws = run(tiles(new Map([[pos, { mineral: 0, resourceAmount: 20 }]])), frameAround(10, 8));
    expect(draws).toEqual([]);
  });

  it('skips a tile that already carries a real sign, but not one carrying a tree', () => {
    const pos = posOf(10, 8, GEO);
    const frame = frameAround(10, 8);

    const withSign = run(
      tiles(new Map([[pos, { mineral: 1, resourceAmount: 5, object: 0x71 }]])),
      frame,
    );
    const withTree = run(tiles(new Map([[pos, { mineral: 1, resourceAmount: 5, object: 10 }]])), frame);

    expect(withSign).toEqual([]);
    expect(withTree).toHaveLength(1);
  });

  it('the empty sign is not a deposit — that tile is still drawn', () => {
    const pos = posOf(10, 8, GEO);
    const draws = run(
      tiles(new Map([[pos, { mineral: 4, resourceAmount: 30, object: 0x78 }]])),
      frameAround(10, 8),
    );
    expect(draws).toHaveLength(1);
  });

  /**
   * Zoomed out the window covers several torus periods, and the ground repeats in them. The signs
   * have to repeat with it — which they do only because the position comes from the traversal.
   */
  it('repeats with the map when the window is wider than one period', () => {
    const pos = posOf(10, 8, GEO);
    const frame = frameAround(10, 8, 2400, 800); // scene period is 1024 x 320
    const draws = run(tiles(new Map([[pos, { mineral: 1, resourceAmount: 20 }]])), frame);

    expect(draws.length).toBeGreaterThan(1);
    const xs = new Set(draws.map((d) => d.x));
    expect(xs.size).toBeGreaterThan(1);
    expect(new Set(draws.map((d) => d.tag))).toEqual(new Set(['obj104'])); // 0x70 - 8
  });

  it('draws nothing on a map without deposits', () => {
    expect(run(tiles(new Map()), frameAround(10, 8))).toEqual([]);
  });
});
