import { describe, expect, it } from 'vitest';
import { buildColorTriangles, buildEntityMarkers } from './map-fallback.js';
import { buildWindowFrame } from './window-frame.js';
import { tileScene, wrapLattice, type Camera } from './viewport-camera.js';
import { mapGeometry, posOf } from './engine/position.js';
import { TILE_H, TILE_W } from './map-render.js';
import type { SaveGameState } from './types.js';

const geo = mapGeometry(0); // 32 × 16

function tiles(heights: ReadonlyMap<number, number> = new Map()) {
  return Array.from({ length: geo.tileCount }, (_, pos) => ({
    height: heights.get(pos) ?? 0,
    terrainUp: 5,
    terrainDown: 8,
  }));
}

function cam(col: number, row: number, width = 320, height = 240): Camera {
  const p = tileScene(col, row);
  return { originX: p.x - width / 2, originY: p.y - height / 2, width, height };
}

describe('buildColorTriangles', () => {
  it('liefert zwei Dreiecke je sichtbarer Kachel', () => {
    const c = cam(10, 8);
    const frame = buildWindowFrame(c, geo, 0);
    const visible = frame.halfRows.reduce((n, r) => n + r.tiles.length, 0);
    expect(buildColorTriangles(frame, { tiles: tiles(), geo, heightUnit: 0 })).toHaveLength(visible * 2);
  });

  it('builds the diamond corners from ONE anchor plus fixed deltas (seam safe)', () => {
    // Four separate camera queries could pick different torus repetitions at the seam and stretch
    // the triangle across half the picture. So: the edge lengths stay the same everywhere.
    const frame = buildWindowFrame(cam(geo.cols - 1, geo.rows - 1), geo, 0);
    for (const tri of buildColorTriangles(frame, { tiles: tiles(), geo, heightUnit: 0 })) {
      const [a, b, c] = tri.points;
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        expect(Math.abs(p.x - q.x)).toBeLessThanOrEqual(TILE_W);
        expect(Math.abs(p.y - q.y)).toBeLessThanOrEqual(TILE_H);
      }
    }
  });

  it('shifts the corners by the neighbour heights (relief) and not in flat mode', () => {
    const pos = posOf(10, 9, geo); // neighbour below (10,8)
    const withHeight = tiles(new Map([[pos, 6]]));
    const frame = buildWindowFrame(cam(10, 8), geo, 6);
    const flat = buildColorTriangles(frame, { tiles: withHeight, geo, heightUnit: 0 });
    const relief = buildColorTriangles(frame, { tiles: withHeight, geo, heightUnit: 4 });
    expect(relief.some((t, i) => t.points.some((p, j) => p.y !== flat[i]!.points[j]!.y))).toBe(true);
  });
});

// --- Marker --------------------------------------------------------------------------------------

function makeState(records: Partial<Record<'buildingRecords' | 'serfRecords' | 'flagRecords', unknown[]>>, patch: ReadonlyMap<number, Record<string, number>> = new Map()): SaveGameState {
  return {
    header: { tick: 0, mapCols: geo.cols, mapRows: geo.rows, tileCount: geo.tileCount },
    mapTiles: Array.from({ length: geo.tileCount }, (_, pos) => ({
      height: 0,
      terrainUp: 5,
      terrainDown: 5,
      paths: 0,
      object: 0,
      objIndex: 0,
      serfIndex: 0,
      ...(patch.get(pos) ?? {}),
    })),
    buildingRecords: records.buildingRecords ?? [],
    serfRecords: records.serfRecords ?? [],
    flagRecords: records.flagRecords ?? [],
  } as unknown as SaveGameState;
}

const COLORS: readonly [number, number, number][] = [
  [1, 2, 3],
  [4, 5, 6],
];

describe('buildEntityMarkers', () => {
  it('draws only the enabled categories', () => {
    const pos = posOf(10, 8, geo);
    const state = makeState(
      { buildingRecords: [{ index: 1, col: 10, row: 8, type: 11, owner: 0 }] },
      new Map([[pos, { object: 2, objIndex: 1 }]]),
    );
    const base = { state, geo, heightUnit: 0, cam: cam(10, 8), playerColors: COLORS };
    expect(
      buildEntityMarkers({ ...base, show: { flags: false, serfs: false, buildings: false } }),
    ).toHaveLength(0);
    expect(
      buildEntityMarkers({ ...base, show: { flags: false, serfs: false, buildings: true } }),
    ).toHaveLength(1);
  });

  it('makes the castle larger than a hut', () => {
    const mk = (type: number) =>
      buildEntityMarkers({
        state: makeState({ buildingRecords: [{ index: 1, col: 10, row: 8, type, owner: 0 }] }),
        geo,
        heightUnit: 0,
        cam: cam(10, 8),
        playerColors: COLORS,
        show: { flags: false, serfs: false, buildings: true },
      })[0]!;
    expect(mk(24).w).toBeGreaterThan(mk(11).w);
  });

  it('repeats markers when zooming out beyond one map period', () => {
    // Markers run over entity RECORDS, not over the traversal — hence `entityAnchorAll`. Without
    // all repetitions the marker would stick in the middle while the ground repeats.
    const { ax, by } = wrapLattice(geo);
    const markers = buildEntityMarkers({
      state: makeState({ buildingRecords: [{ index: 1, col: 10, row: 8, type: 11, owner: 0 }] }),
      geo,
      heightUnit: 0,
      cam: { originX: 0, originY: 0, width: ax * 2, height: by * 2 },
      playerColors: COLORS,
      show: { flags: false, serfs: false, buildings: true },
    });
    expect(markers.length).toBeGreaterThan(1);
    expect(new Set(markers.map((m) => `${m.x},${m.y}`)).size).toBe(markers.length);
  });

  it('takes the owner colour and outlines buildings only', () => {
    const state = makeState(
      {
        buildingRecords: [{ index: 1, col: 10, row: 8, type: 11, owner: 1 }],
        flagRecords: [{ index: 2, owner: 0 }],
      },
      new Map([[posOf(11, 8, geo), { object: 1, objIndex: 2 }]]),
    );
    const markers = buildEntityMarkers({
      state,
      geo,
      heightUnit: 0,
      cam: cam(10, 8),
      playerColors: COLORS,
      show: { flags: true, serfs: false, buildings: true },
    });
    const bld = markers.find((m) => m.stroke)!;
    const flag = markers.find((m) => !m.stroke)!;
    expect(bld.color).toEqual(COLORS[1]);
    expect(flag.color).toEqual(COLORS[0]);
  });
});
