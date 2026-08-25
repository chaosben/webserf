import { describe, expect, it } from 'vitest';
import { LEAD_HALF_ROWS, buildWindowFrame, entityAnchor, tileAnchor } from './window-frame.js';
import { buildTerrainCommands } from './terrain-commands.js';
import { entityAnchorAll, tileScene, wrapLattice, type Camera } from './viewport-camera.js';
import { mapGeometry } from './engine/position.js';
import { ENTITY_ROW_BIAS, TILE_H, TILE_W } from './map-render.js';

const geo = mapGeometry(3); // 64 × 64
const flatTiles = Array.from({ length: geo.tileCount }, () => ({
  height: 0,
  terrainUp: 5,
  terrainDown: 5,
}));

function cam(x: number, y: number, w = 320, h = 240): Camera {
  return { originX: x, originY: y, width: w, height: h };
}

describe('buildWindowFrame', () => {
  it('sets the sub-tile remainder that shifts the commands into the window', () => {
    const f = buildWindowFrame(cam(13, 7), geo, 0);
    expect(f.pixelX).toBeGreaterThanOrEqual(0);
    expect(f.pixelX).toBeLessThan(TILE_W);
    // In y the remainder carries the lead half rows: the traversal starts above the window (see
    // `buildWindowFrame`), and exactly this addition shifts it back in.
    expect(f.pixelY).toBeGreaterThanOrEqual(LEAD_HALF_ROWS * TILE_H);
    expect(f.pixelY).toBeLessThan((LEAD_HALF_ROWS + 1) * TILE_H);
  });

  it('a larger `maxHeight` => more half rows (height shear from below)', () => {
    const flat = buildWindowFrame(cam(0, 0), geo, 0);
    const steep = buildWindowFrame(cam(0, 0), geo, 31);
    expect(steep.halfRows.length).toBeGreaterThan(flat.halfRows.length);
  });
});

describe('tileAnchor', () => {
  it('is the position calculation the ground commands come from as well', () => {
    // The ground places the up triangle at `sx - 16`, and the backend subtracts the sub-tile
    // remainder. Both have to come from the SAME counter, otherwise ground and entities drift apart.
    const f = buildWindowFrame(cam(90, 50), geo, 0);
    const cmds = buildTerrainCommands(f.halfRows, geo, flatTiles, 0);
    const a = tileAnchor(f, 0, 0);
    // The commands come COLUMN BY COLUMN (overlap semantics, see `terrain-commands.ts`), so the up
    // triangle of (0,0) is not the first of the list. It is found by its position: were the counter
    // wrong, there would be no command there at all.
    const hits = cmds.filter(
      (c) => c.kind === 'up' && c.x - f.pixelX === a.x - TILE_W / 2 && c.y - f.pixelY === a.y,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('advances by exactly one tile width within the half row', () => {
    const f = buildWindowFrame(cam(0, 0), geo, 0);
    expect(tileAnchor(f, 0, 3).x - tileAnchor(f, 0, 2).x).toBe(TILE_W);
    expect(tileAnchor(f, 0, 3).y).toBe(tileAnchor(f, 0, 2).y);
  });

  it('gives every visit of the same tile its own position (repetition when zooming out)', () => {
    // From `col/row` both visits would get the same position.
    const { ax, by } = wrapLattice(geo);
    const f = buildWindowFrame(cam(0, 0, ax * 2, by * 2), geo, 0);
    const hr = f.halfRows.find((r) => new Set(Array.from(r.tiles)).size < r.tiles.length);
    expect(hr, 'no window with repetition — check the test setup').toBeDefined();
    const i = f.halfRows.indexOf(hr!);
    const seen = new Map<number, number>();
    for (let k = 0; k < hr!.tiles.length; k++) {
      const prev = seen.get(hr!.tiles[k]!);
      if (prev !== undefined) {
        expect(tileAnchor(f, i, k).x).not.toBe(tileAnchor(f, i, prev).x);
        return;
      }
      seen.set(hr!.tiles[k]!, k);
    }
    throw new Error('no repeated tile found');
  });

  it('lives in window coordinates: the tile under the camera corner sits near (0,0)', () => {
    const p = tileScene(20, 20);
    const f = buildWindowFrame(cam(p.x, p.y), geo, 0);
    // Half row 0 deliberately sits ABOVE the window (lead, see `buildWindowFrame`) — the first row in
    // the window is `LEAD_HALF_ROWS`. Both are checked so the lead cannot vanish or grow unnoticed.
    const a = tileAnchor(f, LEAD_HALF_ROWS, 0);
    expect(Math.abs(a.x)).toBeLessThanOrEqual(TILE_W);
    expect(Math.abs(a.y)).toBeLessThanOrEqual(TILE_H);
    expect(tileAnchor(f, 0, 0).y).toBe(a.y - LEAD_HALF_ROWS * TILE_H);
  });
});

describe('entityAnchor — the 1 px offset of the screen group', () => {
  // The original draws ground and screen sprites in two passes with different row origins (33 - 38
  // against -4, see `map-render.ENTITY_ROW_BIAS`). Measured against an original capture: 73 of 73
  // objects wanted the same shift (0, +1).

  it('sits exactly ONE pixel below the ground anchor of the same tile, equal in x', () => {
    const f = buildWindowFrame(cam(90, 50), geo, 0);
    const flat = tileAnchor(f, 2, 3);
    const ent = entityAnchor(f, 2, 3);
    expect(ent.x).toBe(flat.x);
    expect(ent.y - flat.y).toBe(1);
  });

  it('is offset by exactly 1 against the ground command of the same tile', () => {
    // The observable fact: ground triangle against object anchor. Breaks as soon as someone puts the
    // screen group back onto `tileAnchor`.
    const f = buildWindowFrame(cam(90, 50), geo, 0);
    const flat = tileAnchor(f, 0, 0);
    // Find the same triangle by its position (column order, see above), not by its list index.
    const up = buildTerrainCommands(f.halfRows, geo, flatTiles, 0).find(
      (c) => c.kind === 'up' && c.x - f.pixelX === flat.x - TILE_W / 2 && c.y - f.pixelY === flat.y,
    )!;
    expect(up, 'no ground command at tile (0,0)').toBeDefined();
    expect(entityAnchor(f, 0, 0).y - (up.y - f.pixelY)).toBe(1);
  });

  it('carries the same offset as the record path `entityAnchorAll`', () => {
    // Two ways to the same tile: through the traversal (ground and object passes) and through the
    // record (serfs, markers). If they diverge, markers drift against buildings.
    const c = cam(90, 50);
    const f = buildWindowFrame(c, geo, 0);
    const pos = f.halfRows[2]!.tiles[3]!;
    const col = pos % geo.cols;
    const row = (pos - col) / geo.cols;
    const viaRecord = entityAnchorAll(col, row, 0, c, geo, TILE_W, 0);
    expect(viaRecord).toContainEqual(entityAnchor(f, 2, 3));
  });

  it('the constant is 1 — the alignment against the capture stands or falls with it', () => {
    expect(ENTITY_ROW_BIAS).toBe(1);
  });
});
