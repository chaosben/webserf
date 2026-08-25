/**
 * Draw one frame of the map view — as a pure function, so the order of the passes stays readable
 * without Svelte and a check can run it against a different backend. The passes themselves live in
 * `core/`; what is here is only their order, the canvas context and the zoom transform.
 *
 * With archive and palette everything runs over an index surface (one byte per pixel as in the
 * original); without both, only the fallback's colour triangles remain in free RGB. Both at once is
 * impossible — free RGB cannot be written into a palette surface.
 */
import { blitSprite } from '../core/draw-target.js';
import { buildCursorMarkers } from '../core/cursor-marker-layer.js';
import { buildSiteOverlay } from '../core/build-site-overlay.js';
import { buildWindowFrame, type WindowFrame } from '../core/window-frame.js';
import { IndexBlitter } from '../core/index-target.js';
import type { IndexPresenter } from './index-presenter.js';
import {
  drawEntityLayer,
  type EntityIndex,
  type EntitySoundSink,
  type EntitySpriteKit,
} from '../core/entity-layer.js';
import { drawRoadLayer } from '../core/road-layer.js';
import { drawBorderLayer } from '../core/border-layer.js';
import {
  buildColorTriangles,
  buildEntityMarkers,
  type ColorTriangle,
  type EntityMarker,
} from '../core/map-fallback.js';
import type { TerrainSurface } from './terrain-surface.js';
import { metrics } from './render-metrics.js';
import { entityAnchorAll, type Camera } from '../core/viewport-camera.js';
import { CURSOR_MARKER_BASE, type CursorMarkerPair } from '../core/ui-render.js';
import { posOf, type MapGeometry } from '../core/engine/position.js';
import type { AnimationTable } from '../core/animation-parser.js';
import type { IndexedSprite } from '../core/sprite-indexed.js';
import type { GameState } from '../core/engine/state.js';
import type { Palette, SaveGameState } from '../core/types.js';

/** What of a tile may be drawn. */
export interface LayerToggles {
  readonly objects: boolean;
  readonly buildings: boolean;
  readonly flags: boolean;
  readonly serfs: boolean;
  readonly roads: boolean;
}

export interface MapFrameInput {
  readonly canvas: HTMLCanvasElement;
  readonly viewportW: number;
  readonly viewportH: number;
  readonly zoom: number;

  readonly cam: Camera;
  readonly geo: MapGeometry;
  readonly maxHeight: number;
  readonly heightUnit: number;
  readonly renderState: SaveGameState;
  /** Only for the build helper (player record). */
  readonly engineState: GameState;

  readonly palette: Palette | null;
  readonly spriteKit: EntitySpriteKit<IndexedSprite> | null;
  readonly roadKit: ((maskIndex: number, groundIndex: number) => IndexedSprite | null) | null;
  readonly borderKit: ((borderIndex: number) => IndexedSprite | null) | null;
  readonly animations: AnimationTable | null;
  /** Do not build here — the index is needed outside as well. */
  readonly entityIndex: EntityIndex;
  readonly surface: TerrainSurface | null;
  readonly presenter: IndexPresenter;
  /** When it changes, the surface is rebuilt completely. */
  readonly surfaceVersion: string;

  readonly show: LayerToggles;
  readonly buildHelper: boolean;
  readonly buildPlayer: number;
  readonly selected: { readonly col: number; readonly row: number } | null;
  readonly cursorMarkers: CursorMarkerPair | null;
  /**
   * Set individually while building a road (`@0x33170`); otherwise `undefined` ⇒
   * {@link cursorMarkers} applies.
   */
  readonly cursorRingSprites?: readonly number[];
  readonly playerColors: readonly (readonly [number, number, number])[];
  /**
   * Sound sink. It hangs here because the original enqueues the effect sounds inside the drawing
   * passes: what is not drawn does not sound.
   */
  readonly sound?: EntitySoundSink;
}

const rgbCss = (c: readonly [number, number, number]): string => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Ground substitute without archive. */
export function fillColorTriangles(
  ctx: CanvasRenderingContext2D,
  tris: readonly ColorTriangle[],
): void {
  for (const tri of tris) {
    ctx.beginPath();
    ctx.moveTo(tri.points[0].x, tri.points[0].y);
    ctx.lineTo(tri.points[1].x, tri.points[1].y);
    ctx.lineTo(tri.points[2].x, tri.points[2].y);
    ctx.closePath();
    ctx.fillStyle = rgbCss(tri.color);
    ctx.fill();
  }
}

/** Entity substitute without sprites. */
export function fillMarkers(
  ctx: CanvasRenderingContext2D,
  markers: readonly EntityMarker[],
): void {
  ctx.lineWidth = 1;
  for (const m of markers) {
    ctx.fillStyle = rgbCss(m.color);
    ctx.fillRect(m.x, m.y, m.w, m.h);
    if (m.stroke) {
      ctx.strokeStyle = '#000';
      ctx.strokeRect(m.x, m.y, m.w, m.h);
    }
  }
}

/** Return value: did the sprite path run? Diagnosis only — the fallback is set here itself. */
export function renderMapFrame(input: MapFrameInput): boolean {
  const {
    canvas,
    viewportW,
    viewportH,
    zoom,
    cam,
    geo,
    maxHeight,
    heightUnit,
    renderState: rs,
    engineState,
    palette: pal,
    spriteKit: kit,
    roadKit: roads,
    borderKit: borders,
    animations,
    entityIndex,
    surface: surf,
    presenter,
    surfaceVersion,
    show,
    buildHelper,
    buildPlayer,
    selected,
    cursorMarkers,
    cursorRingSprites,
    playerColors,
  } = input;

  metrics.begin('frame');
  // The assignment RE-CREATES the drawing surface (free memory, allocate, clear) even when the
  // dimensions did not change. Whether that is expensive is for measurement to say.
  metrics.begin('resize');
  canvas.width = viewportW;
  canvas.height = viewportH;
  metrics.end('resize');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    metrics.end('frame');
    return false;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0c0c0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const frame = buildWindowFrame(cam, geo, maxHeight);

  /**
   * **Splitting the zoom between index surface and canvas.**
   *
   * `surfaceScale` is the scale the index surface is built at, `canvasScale` what the output canvas
   * adds on top; their product is always `zoom`.
   *
   * - **Zoomed in (`zoom ≥ 1`)**: `surfaceScale = 1`, `canvasScale = zoom`. The surface is
   *   then SMALLER than the window and the GPU magnifies for free. All pixel-exact checks
   *   measure here; this path stays byte for byte unchanged.
   *   path stays byte for byte unchanged.
   * - **Zoomed out (`zoom < 1`)**: `surfaceScale = zoom`, `canvasScale = 1` — the surface is as
   *   large as the **window**, not as the scene section. Before, `window / zoom` pixels were
   *   computed and then scaled down; at 23 % zoom that is 95 % waste (measured: 31.7 instead of
   *   1.68 million pixels per frame).
   */
  const surfaceScale = Math.min(1, zoom);
  const canvasScale = zoom / surfaceScale;

  /** With torus wrap: `posOf` masks both axes, a `% rows` would break on negative values. */
  const heightAt = (c: number, r: number): number => rs.mapTiles[posOf(c, r, geo)].height;

  ctx.save();
  ctx.scale(canvasScale, canvasScale);

  /** Part of the static ground surface, hence in index space. */
  const roadLayer = (target: IndexBlitter, f: WindowFrame): void => {
    if (show.roads && roads !== null) {
      drawRoadLayer(target, f, { tiles: rs.mapTiles, geo, heightUnit, tile: roads });
    }
    if (borders !== null) {
      drawBorderLayer(target, f, { tiles: rs.mapTiles, geo, heightUnit, sprite: borders });
    }
  };

  let drewSprites = false;

  // Sprite path only with archive AND palette — without a palette there is no index surface.
  if (pal !== null && kit !== null && surf !== null) {
    drewSprites = true;
    const target = presenter.surfaceFor(cam.width * surfaceScale, cam.height * surfaceScale);
    metrics.note(target.width, target.height, zoom);
    metrics.begin('terrain');
    surf.render(
      target,
      cam,
      {
        geo,
        tiles: rs.mapTiles,
        heightUnit,
        maxHeight,
        version: surfaceVersion,
        overlay: (blitter, _scam, sframe) => roadLayer(blitter, sframe),
      },
      surfaceScale,
    );
    metrics.end('terrain');

    // The sprite layers still compute in SCENE coordinates; the blitter scales down as it writes.
    const blitter = new IndexBlitter(target, surfaceScale);
    metrics.begin('entities');
    const hitMarkers = drawEntityLayer(blitter, frame, {
      state: rs,
      geo,
      heightUnit,
      kit,
      animations,
      index: entityIndex,
      show: {
        objects: show.objects,
        buildings: show.buildings,
        flags: show.flags,
        serfs: show.serfs,
      },
      sound: input.sound,
      // Visibility counters of the ambient sounds: counted unconditionally in the original, because
      // only the next frame tick reads them.
      ambient: engineState.ambient,
    });
    metrics.end('entities');
    metrics.begin('overlays');
    // Before the selector, so its symbol stays on top (order as in `ui_draw_viewport`).
    if (buildHelper) {
      const player = engineState.players[buildPlayer];
      if (player && player.active) {
        for (const m of buildSiteOverlay({
          state: engineState,
          player,
          frame,
          heightUnit,
          windowHeight: Math.ceil(viewportH / zoom),
        })) {
          blitSprite(blitter, kit.sprite(CURSOR_MARKER_BASE + m.sprite, 'transparent'), m.x, m.y);
        }
      }
    }
    // Via `entityAnchorAll`, so the markers repeat with the map when zooming out.
    if (selected !== null) {
      const h = heightAt(selected.col, selected.row);
      for (const a of entityAnchorAll(selected.col, selected.row, h, cam, geo, 64, heightUnit)) {
        for (const m of buildCursorMarkers({
          anchor: a,
          col: selected.col,
          row: selected.row,
          heightAt,
          markers: cursorMarkers,
          ringSprites: cursorRingSprites,
          heightUnit,
        })) {
          blitSprite(blitter, kit.sprite(CURSOR_MARKER_BASE + m.sprite, 'transparent'), m.x, m.y);
        }
      }
    }
    // Hit markers of the fights — the window's last layer in the original.
    for (const m of hitMarkers) {
      blitSprite(blitter, kit.sprite(CURSOR_MARKER_BASE + m.sprite, 'transparent'), m.x, m.y);
    }
    metrics.end('overlays');

    // Colour is produced here, INSIDE the zoom transform — that keeps the zoom on the canvas.
    presenter.present(ctx, target, pal);
  } else {
    // Without archive/palette: colour triangles straight to the screen; roads, border stones and
    // sprites fall away because they need the index space.
    ctx.save();
    ctx.scale(surfaceScale, surfaceScale);
    fillColorTriangles(ctx, buildColorTriangles(frame, { tiles: rs.mapTiles, geo, heightUnit }));
    ctx.restore();
  }

  // Markers only for categories without real sprites. They compute in scene coordinates, so they
  // need the surface scale on top of the canvas scale (product == zoom).
  const noSprites = !drewSprites;
  ctx.save();
  ctx.scale(surfaceScale, surfaceScale);
  fillMarkers(
    ctx,
    buildEntityMarkers({
      state: rs,
      geo,
      heightUnit,
      cam,
      playerColors,
      show: {
        flags: noSprites || !show.flags,
        serfs: noSprites || !show.serfs,
        buildings: noSprites || !show.buildings,
      },
    }),
  );
  ctx.restore();
  ctx.restore();
  metrics.end('frame');
  return drewSprites;
}
