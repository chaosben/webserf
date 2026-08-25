import { describe, it, expect } from 'vitest';
import {
  TILE_W,
  TILE_H,
  HEIGHT_UNIT,
  vertexScreen,
  mapPixelBounds,
  cellTriangles,
  terrainTriangle,
  triangleSlopeValid,
  TERRAIN_BASE_COLORS,
  TERRAIN_NAMES,
  terrainColor,
  heightShade,
  shadeColor,
  MAP_GROUND_BASE,
  MAP_MASK_UP_BASE,
  MAP_MASK_DOWN_BASE,
  MAP_OBJECT_BASE,
  mapObjectSprite,
  screenToTile,
} from './map-render.js';

describe('vertexScreen', () => {
  it('Ursprung bei (0,0,0)', () => {
    expect(vertexScreen(0, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('move_right (col+1) → x += TILE_W, y gleich', () => {
    const a = vertexScreen(3, 5, 0);
    const b = vertexScreen(4, 5, 0);
    expect(b.x - a.x).toBe(TILE_W);
    expect(b.y - a.y).toBe(0);
  });

  it('move_down (row+1) -> x -= TILE_W/2 (left shear as in the original), y += TILE_H', () => {
    const a = vertexScreen(3, 5, 0);
    const b = vertexScreen(3, 6, 0);
    expect(b.x - a.x).toBe(-TILE_W / 2);
    expect(b.y - a.y).toBe(TILE_H);
  });

  it('height lifts the vertex (y -= height * HEIGHT_UNIT)', () => {
    const flat = vertexScreen(2, 2, 0);
    const high = vertexScreen(2, 2, 10);
    expect(flat.y - high.y).toBe(10 * HEIGHT_UNIT);
  });

  it('top-down mode (heightUnit=0): height does NOT move the vertex', () => {
    const flat = vertexScreen(2, 2, 0, 0);
    const high = vertexScreen(2, 2, 31, 0);
    expect(flat.y).toBe(high.y); // y from row alone
    expect(high.y).toBe(2 * TILE_H);
    // x is identical in both modes (row offset only, no height).
    expect(high.x).toBe(vertexScreen(2, 2, 31).x);
  });
});

describe('mapPixelBounds', () => {
  it('width accounts for the row offset; offsetX compensates the left shear', () => {
    const { width, offsetX } = mapPixelBounds(64, 64);
    expect(width).toBe(64 * TILE_W + 64 * (TILE_W / 2));
    expect(offsetX).toBe(64 * (TILE_W / 2));
    // Leftmost vertex (col 0, row 64) + offsetX lands at x >= 0.
    expect(vertexScreen(0, 64, 0).x + offsetX).toBe(0);
  });

  it('height covers all rows + overhang + height reserve', () => {
    const { height, offsetY } = mapPixelBounds(64, 64);
    expect(offsetY).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(64 * TILE_H);
  });

  it('top-down mode (heightUnit=0): no upper overhang (offsetY=0)', () => {
    const { offsetY, height } = mapPixelBounds(64, 64, 0);
    expect(offsetY).toBe(0);
    expect(height).toBe(64 * TILE_H + TILE_H);
  });
});

describe('cellTriangles', () => {
  it('splits the cell rhombus into up (TL,TR,BR) and down (TL,BR,BL)', () => {
    const flat = () => 0;
    const { up, down } = cellTriangles(0, 0, flat);
    // TL shared, BR shared (the diagonal).
    expect(up[0]).toEqual(down[0]); // TL
    expect(up[2]).toEqual(down[1]); // BR
    // TR = (1,0): x=TILE_W; BL = (0,1): x=-TILE_W/2 (left shear), y=TILE_H.
    expect(up[1]).toEqual({ x: TILE_W, y: 0 });
    expect(down[2]).toEqual({ x: -TILE_W / 2, y: TILE_H });
  });

  it('pulls heights in through heightAt', () => {
    const heightAt = (c: number, r: number) => (c === 1 && r === 1 ? 5 : 0);
    const { up } = cellTriangles(0, 0, heightAt);
    // BR = (1,1,height 5) -> y lifted by 5 * HEIGHT_UNIT.
    expect(up[2].y).toBe(TILE_H - 5 * HEIGHT_UNIT);
  });

  it('top-down mode (heightUnit=0): height does not affect triangle geometry', () => {
    const heightAt = (c: number, r: number) => (c === 1 && r === 1 ? 5 : 0);
    const { up } = cellTriangles(0, 0, heightAt, 0);
    expect(up[2].y).toBe(TILE_H); // BR lies flat on the row despite height 5
  });
});

describe('terrain colours', () => {
  it('16 types, 16 colours, 16 names', () => {
    expect(TERRAIN_BASE_COLORS).toHaveLength(16);
    expect(TERRAIN_NAMES).toHaveLength(16);
  });

  it('terrainColor returns RGB in range, fallback when out of range', () => {
    for (let t = 0; t < 16; t++) {
      const c = terrainColor(t);
      expect(c).toHaveLength(3);
      for (const ch of c) expect(ch).toBeGreaterThanOrEqual(0), expect(ch).toBeLessThanOrEqual(255);
    }
    expect(terrainColor(99)).toEqual([255, 0, 255]);
  });
});

describe('height shading', () => {
  it('flat = neutral (~1.0), rise brighter, fall darker', () => {
    expect(heightShade(0)).toBeCloseTo(1.0, 5);
    expect(heightShade(4)).toBeGreaterThan(1.0);
    expect(heightShade(-4)).toBeLessThan(1.0);
  });

  it('the factor is clamped (0.6..1.15)', () => {
    expect(heightShade(100)).toBeLessThanOrEqual(1.15);
    expect(heightShade(-100)).toBeGreaterThanOrEqual(0.6);
  });

  it('shadeColor clamps to 0..255 and rounds', () => {
    expect(shadeColor([100, 200, 250], 1.15)).toEqual([115, 230, 255]);
    expect(shadeColor([100, 100, 100], 0.6)).toEqual([60, 60, 60]);
  });
});

describe('asset base indices (0-based)', () => {
  it('equal the reference indices minus 1', () => {
    expect(MAP_GROUND_BASE).toBe(259); // dos_index 260
    expect(MAP_MASK_UP_BASE).toBe(59); // dos_index 60
    expect(MAP_MASK_DOWN_BASE).toBe(140); // dos_index 141
  });
});

describe('mapObjectSprite', () => {
  it('returns null for none/flag/building (object < 8)', () => {
    for (const o of [0, 1, 2, 3, 4, 7]) expect(mapObjectSprite(o, 0)).toBeNull();
  });

  it('maps the static range (object >= 32) consecutively from MAP_OBJECT_BASE — tick independent', () => {
    for (const tick of [0, 1, 16, 4711, 0xffff]) {
      // Object 32 == first slot BEHIND the animation. It is empty in the archive (the object bank has
      // structural gaps) — checked here is the range boundary, not a sprite; the caller tolerates a
      // missing one.
      expect(mapObjectSprite(32, tick)).toBe(MAP_OBJECT_BASE + 24);
      expect(mapObjectSprite(72, tick)).toBe(MAP_OBJECT_BASE + 64); // ObjectStone0
      expect(mapObjectSprite(79, tick)).toBe(MAP_OBJECT_BASE + 71); // ObjectStone7
      expect(mapObjectSprite(112, tick)).toBe(MAP_OBJECT_BASE + 104); // soil sign
    }
  });

  // --- tree animation (`@0x340a7..@0x34117`) ---

  it('runs once through the 8-frame bank and back to 0 (object 8, frame change every 16 ticks)', () => {
    for (let frame = 0; frame < 8; frame++)
      expect(mapObjectSprite(8, frame * 16)).toBe(MAP_OBJECT_BASE + frame);
    expect(mapObjectSprite(8, 8 * 16)).toBe(MAP_OBJECT_BASE + 0); // cycle == 128 ticks
    // nothing changes within one frame
    expect(mapObjectSprite(8, 15)).toBe(MAP_OBJECT_BASE + 0);
    expect(mapObjectSprite(8, 16)).toBe(MAP_OBJECT_BASE + 1);
  });

  it('keeps the second 8-frame bank separate (objects 16..23 => base 8)', () => {
    // v = 8, so `phase = (tick + 8) >> 4` — frame `frame` starts at tick 16*frame - 8.
    for (let frame = 0; frame < 8; frame++)
      expect(mapObjectSprite(16, 16 * (frame + 8) - 8)).toBe(MAP_OBJECT_BASE + 8 + frame);
    // the bank never mixes with the first
    for (const tick of [0, 7, 16, 100, 1000]) {
      const v = mapObjectSprite(16, tick)! - MAP_OBJECT_BASE;
      expect(v).toBeGreaterThanOrEqual(8);
      expect(v).toBeLessThanOrEqual(15);
    }
  });

  it('uses only 4 frames in the two upper banks (objects 24..31)', () => {
    for (const [obj, base] of [
      [24, 16],
      [28, 20],
    ] as const) {
      const seen = new Set<number>();
      for (let tick = 0; tick < 256; tick++) seen.add(mapObjectSprite(obj, tick)! - MAP_OBJECT_BASE);
      expect([...seen].sort((a, b) => a - b)).toEqual([base, base + 1, base + 2, base + 3]);
    }
  });

  it('ignores the low bits of the object byte — they ARE the frame number, not a variant', () => {
    // At tick 0 v=0..7 all fall into the same frame => one and the same sprite. That is what makes
    // the stored "tree variant" invisible within a bank.
    for (let obj = 8; obj <= 15; obj++) expect(mapObjectSprite(obj, 0)).toBe(MAP_OBJECT_BASE + 0);
    for (let obj = 16; obj <= 23; obj++) expect(mapObjectSprite(obj, 0)).toBe(MAP_OBJECT_BASE + 8);
  });

  it('adds the object value BEFORE the shift (frame change offset by v ticks)', () => {
    // Discriminates against "leave +v out" and "+v after the shift": at tick 15 object 9 (v=1) has
    // already changed, object 8 (v=0) has not.
    expect(mapObjectSprite(8, 15)).toBe(MAP_OBJECT_BASE + 0);
    expect(mapObjectSprite(9, 15)).toBe(MAP_OBJECT_BASE + 1);
  });
});

describe('screenToTile (inverse of vertexScreen)', () => {
  const cols = 64;
  const rows = 64;
  const flat0 = () => 0;

  // Scene coordinate of a vertex: vertexScreen + mapPixelBounds offsets.
  function scene(col: number, row: number, h: number, heightUnit: number) {
    const { offsetX, offsetY } = mapPixelBounds(cols, rows, heightUnit);
    const p = vertexScreen(col, row, h, heightUnit);
    return { x: p.x + offsetX, y: p.y + offsetY };
  }

  it('flat: round trip for several tiles (sheared rows included)', () => {
    for (const [c, r] of [[0, 0], [10, 0], [0, 20], [25, 46], [63, 63], [30, 10]]) {
      const s = scene(c, r, 0, 0);
      expect(screenToTile(s.x, s.y, cols, rows, flat0, 0)).toEqual({ col: c, row: r });
    }
  });

  it('flat: a point slightly off the vertex hits the same tile', () => {
    const s = scene(25, 46, 0, 0);
    expect(screenToTile(s.x + 3, s.y - 2, cols, rows, flat0, 0)).toEqual({ col: 25, row: 46 });
  });

  it('relief: round trip despite the height offset (tall tile)', () => {
    const heightAt = (c: number, r: number) => (c === 30 && r === 40 ? 25 : 0);
    const s = scene(30, 40, 25, HEIGHT_UNIT);
    expect(screenToTile(s.x, s.y, cols, rows, heightAt, HEIGHT_UNIT)).toEqual({ col: 30, row: 40 });
  });

  it('returns null far outside the map', () => {
    expect(screenToTile(-500, -500, cols, rows, flat0, 0)).toBeNull();
    const { width, height } = mapPixelBounds(cols, rows, 0);
    expect(screenToTile(width + 500, height + 500, cols, rows, flat0, 0)).toBeNull();
  });
});

/**
 * Original ground triangles (source-tile centred). The expected values are the mapping checked
 * against the pixel-verified column traversal (1024/1024 tuples identical).
 */
describe('terrainTriangle', () => {
  // Height field with distinct values so every corner is distinguishable.
  const h = (c: number, r: number) => (c * 7 + r * 3) % 5;

  it('up: apex = own tile, base = (col,row+1) and (col+1,row+1)', () => {
    const t = terrainTriangle('up', 10, 4, h);
    expect(t.m).toBe(h(10, 4));
    expect(t.left).toBe(h(10, 5));
    expect(t.right).toBe(h(11, 5));
  });

  it('down: apex = (col+1,row+1), base = own tile and (col+1,row)', () => {
    const t = terrainTriangle('down', 10, 4, h);
    expect(t.m).toBe(h(11, 5));
    expect(t.left).toBe(h(10, 4));
    expect(t.right).toBe(h(11, 4));
  });

  it('x: up sits half a tile left of the projection, down exactly on it', () => {
    const col = 10, row = 4;
    const sx = col * TILE_W - row * (TILE_W / 2);
    expect(terrainTriangle('up', col, row, h).x).toBe(sx - TILE_W / 2);
    expect(terrainTriangle('down', col, row, h).x).toBe(sx);
  });

  it('y: row y minus the height shear; down one triangle row lower on top', () => {
    const col = 10, row = 4;
    const up = terrainTriangle('up', col, row, h);
    const down = terrainTriangle('down', col, row, h);
    expect(up.y).toBe(row * TILE_H - up.m * HEIGHT_UNIT);
    expect(down.y).toBe(row * TILE_H - down.m * HEIGHT_UNIT + TILE_H);
  });

  it('flat (heightUnit 0) does not lift the vertices', () => {
    const t = terrainTriangle('up', 3, 3, () => 20, 0);
    expect(t.y).toBe(3 * TILE_H);
  });

  it('the two triangles of a tile are offset by 16 px — that is the interlock', () => {
    const flat = () => 0;
    const up = terrainTriangle('up', 6, 6, flat);
    const down = terrainTriangle('down', 6, 6, flat);
    expect(down.x - up.x).toBe(TILE_W / 2);
  });

  it('neighbouring tiles of a row are exactly one tile width apart', () => {
    const flat = () => 0;
    const a = terrainTriangle('up', 6, 6, flat);
    const b = terrainTriangle('up', 7, 6, flat);
    expect(b.x - a.x).toBe(TILE_W);
    expect(b.y).toBe(a.y);
  });

  it('the next row is sheared half a tile to the left', () => {
    const flat = () => 0;
    const a = terrainTriangle('up', 6, 6, flat);
    const b = terrainTriangle('up', 6, 7, flat);
    expect(b.x - a.x).toBe(-TILE_W / 2);
    expect(b.y - a.y).toBe(TILE_H);
  });
});

describe('triangleSlopeValid', () => {
  it('accepts height differences up to +-4', () => {
    for (const d of [-4, -1, 0, 3, 4]) {
      expect(triangleSlopeValid({ kind: 'up', m: 10, left: 10 + d, right: 10, x: 0, y: 0 }), `d=${d}`).toBe(true);
    }
  });

  it('rejects steeper ones (both base corners are checked)', () => {
    expect(triangleSlopeValid({ kind: 'up', m: 10, left: 15, right: 10, x: 0, y: 0 })).toBe(false);
    expect(triangleSlopeValid({ kind: 'up', m: 10, left: 10, right: 5, x: 0, y: 0 })).toBe(false);
  });
});
