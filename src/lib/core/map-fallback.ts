/**
 * Fallback-Darstellung ohne Archiv: Boden als **Farb-Dreiecke**, Entities als **Marker**.
 *
 * Both exist only so a save stays readable without the original assets — they have no counterpart
 * in the original and imitate nothing. The core therefore yields pure geometry plus colour; the
 * backend fills polygons and rectangles.
 *
 * ## Wrap safety of the diamond corners
 *
 * The four corners of a tile diamond come from **one** anchor plus fixed deltas
 * (`(+1,0) -> (+32,0)`, `(0,+1) -> (-16,+20)`, `(+1,+1) -> (+16,+20)`), each minus its own height
 * lift. Four separate camera queries would be wrong at the map seam: adjacent corners could pick
 * different torus repetitions and stretch the triangle across half the picture.
 */

import { heightShade, shadeColor, terrainColor, TILE_H, TILE_W } from './map-render.js';
import { posOf, type MapGeometry } from './engine/position.js';
import { entityAnchorAll, type Camera } from './viewport-camera.js';
import { tileAnchor, type WindowFrame } from './window-frame.js';
import type { SaveGameState } from './types.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ColorTriangle {
  readonly points: readonly [Point, Point, Point];
  readonly color: readonly [number, number, number];
}

/** What the colour triangles need from a tile. */
export interface FallbackTileData {
  readonly height: number;
  readonly terrainUp: number;
  readonly terrainDown: number;
}

export interface ColorTriangleInput {
  readonly tiles: readonly FallbackTileData[];
  readonly geo: MapGeometry;
  readonly heightUnit: number;
}

/** The four diamond corners of a tile from one flat anchor (wrap safe, see module head). */
function corners(
  flat: Point,
  col: number,
  row: number,
  input: ColorTriangleInput,
): { tl: Point; tr: Point; bl: Point; br: Point; h00: number } {
  const { tiles, geo, heightUnit } = input;
  const h = (c: number, r: number): number => tiles[posOf(c, r, geo)]!.height;
  const h00 = h(col, row);
  const ax = flat.x;
  const ay = flat.y - h00 * heightUnit;
  const lift = (v: number): number => (v - h00) * heightUnit;
  return {
    h00,
    tl: { x: ax, y: ay },
    tr: { x: ax + TILE_W, y: ay - lift(h(col + 1, row)) },
    bl: { x: ax - TILE_W / 2, y: ay + TILE_H - lift(h(col, row + 1)) },
    br: { x: ax + TILE_W / 2, y: ay + TILE_H - lift(h(col + 1, row + 1)) },
  };
}

/** Boden-Ersatz: zwei schattierte Dreiecke je sichtbarer Kachel, in Painter-Reihenfolge. */
export function buildColorTriangles(
  frame: WindowFrame,
  input: ColorTriangleInput,
): ColorTriangle[] {
  const { tiles, geo } = input;
  const h = (c: number, r: number): number => tiles[posOf(c, r, geo)]!.height;
  const out: ColorTriangle[] = [];

  for (let i = 0; i < frame.halfRows.length; i++) {
    const hr = frame.halfRows[i]!;
    for (let k = 0; k < hr.tiles.length; k++) {
      const pos = hr.tiles[k]!;
      const col = pos % geo.cols;
      const row = (pos - col) / geo.cols;
      const tile = tiles[pos]!;
      const { tl, tr, bl, br, h00 } = corners(tileAnchor(frame, i, k), col, row, input);
      out.push({
        points: [tl, tr, br],
        color: shadeColor(terrainColor(tile.terrainUp), heightShade(h(col + 1, row + 1) - h00)),
      });
      out.push({
        points: [tl, br, bl],
        color: shadeColor(terrainColor(tile.terrainDown), heightShade(h(col, row + 1) - h00)),
      });
    }
  }
  return out;
}

/** An entity marker: filled rectangle, optionally outlined in black. */
export interface EntityMarker {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: readonly [number, number, number];
  readonly stroke: boolean;
}

/** Which categories are drawn as markers (those without sprites). */
export interface MarkerToggles {
  readonly flags: boolean;
  readonly serfs: boolean;
  readonly buildings: boolean;
}

export interface MarkerInput {
  readonly state: SaveGameState;
  readonly geo: MapGeometry;
  readonly heightUnit: number;
  readonly cam: Camera;
  readonly playerColors: readonly (readonly [number, number, number])[];
  readonly show: MarkerToggles;
}

/**
 * Markers for buildings, flags and serfs.
 *
 * Unlike the window passes this layer iterates over entity **records** (and over the tiles of the
 * whole map), not over the traversal — so there is no loop counter from which the torus repetitions
 * would follow. Hence `entityAnchorAll`: zoomed out beyond one map period the same tile must be
 * drawn several times, otherwise the marker sticks in the middle while the ground repeats.
 */
export function buildEntityMarkers(input: MarkerInput): EntityMarker[] {
  const { state, geo, heightUnit, cam, playerColors, show } = input;
  const cols = geo.cols;
  const tiles = state.mapTiles;
  const out: EntityMarker[] = [];
  const color = (i: number): readonly [number, number, number] =>
    playerColors[i] ?? [255, 255, 255];

  /**
   * All visible repetitions of the **centroid** of the up triangle — the same deltas as in
   * {@link buildColorTriangles}, so the marker sits centred on the tile.
   */
  const centroids = (col: number, row: number): Point[] => {
    const c = ((col % cols) + cols) % cols;
    const r = ((row % geo.rows) + geo.rows) % geo.rows;
    const h = (cc: number, rr: number): number => tiles[posOf(cc, rr, geo)]!.height;
    const h00 = h(c, r);
    const lift = (v: number): number => (v - h00) * heightUnit;
    const dx = (0 + TILE_W + TILE_W / 2) / 3;
    const dy = (0 - lift(h(c + 1, r)) + TILE_H - lift(h(c + 1, r + 1))) / 3;
    return entityAnchorAll(c, r, h00, cam, geo, TILE_W, heightUnit).map((p) => ({
      x: p.x + dx,
      y: p.y + dy,
    }));
  };

  if (show.flags) {
    const flagByIndex = new Map(state.flagRecords.map((f) => [f.index, f]));
    for (let pos = 0; pos < tiles.length; pos++) {
      const t = tiles[pos]!;
      if (t.object !== 1) continue;
      const flag = flagByIndex.get(t.objIndex);
      if (flag === undefined) continue;
      const col = pos % cols;
      for (const p of centroids(col, (pos - col) / cols)) {
        out.push({ x: p.x - 1, y: p.y - 1, w: 2, h: 2, color: color(flag.owner), stroke: false });
      }
    }
  }

  if (show.serfs) {
    // Only the serfs registered per map tile (at most one per tile).
    const byIndex = new Map(state.serfRecords.map((s) => [s.index, s]));
    for (let pos = 0; pos < tiles.length; pos++) {
      const si = tiles[pos]!.serfIndex;
      if (si <= 0) continue;
      const serf = byIndex.get(si);
      if (serf === undefined) continue;
      const col = pos % cols;
      for (const p of centroids(col, (pos - col) / cols)) {
        out.push({ x: p.x, y: p.y, w: 1, h: 1, color: playerColors[serf.owner] ?? [200, 200, 200], stroke: false });
      }
    }
  }

  if (show.buildings) {
    for (const b of state.buildingRecords) {
      if (b.index === 0) continue;
      const size = b.type === 24 ? 7 : b.type >= 21 ? 5 : 4; // castle and fortress larger
      for (const p of centroids(b.col, b.row)) {
        out.push({ x: p.x - size / 2, y: p.y - size, w: size, h: size, color: color(b.owner), stroke: true });
      }
    }
  }

  return out;
}
