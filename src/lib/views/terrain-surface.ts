/**
 * Retained ground surface — the only place that keeps pixels across frames. Everything that
 * computes (visibility, commands, triangle cache, retention plan) lives backend-free in `core/`;
 * this module runs it.
 *
 * It holds **one palette index per pixel**, not a colour: the original's shadows modify the target
 * pixel (`dst |= 0x80`), which an RGBA buffer cannot reproduce (see `core/index-target.ts`).
 *
 * ## Two anchorings
 *
 * **World space when the map fits** ({@link WORLD_SURFACE_BUDGET_BYTES}). The torus scene period is
 * `cols·32 × rows·20` bytes; it is composed **once** and afterwards only point-sampled into the
 * target per frame. That makes scrolling and zooming as cheap as standing still. Updates are
 * per-rect over `diffGroundRows`: a road laid down redraws a strip, not the world.
 *
 * **Camera space as fallback** (maps above the budget): unchanged window ⇒ copy only · scrolled ⇒
 * self-shift plus clipped refresh of the dirty rects · `version` changed ⇒ full rebuild.
 *
 * Both paths clip and draw **all** intersecting commands in original order, because the ground
 * triangles overlap and the order therefore carries meaning.
 *
 * ## Scale
 *
 * `scale < 1` (zoomed out) point-samples while copying into the target instead of drawing at scene
 * resolution and shrinking afterwards. The ground itself is never blitted scaled — what gets
 * shrunk is the finished picture. That is why arbitrary zoom is possible: independently rounded
 * target rects tore gaps between tiling triangles, whose masks overlap at dithered edges.
 */
import {
  buildTerrainCommands,
  type TerrainCommand,
  type TerrainTileData,
} from '../core/terrain-commands.js';
import {
  IndexedTerrainTileCache,
  type IndexedTerrainSpriteSource,
} from '../core/terrain-tiles.js';
import {
  IndexBlitter,
  createIndexSurface,
  type IndexSurface,
} from '../core/index-target.js';
import { wrapLattice, type Camera } from '../core/viewport-camera.js';
import {
  GROUND_WORD_NONE,
  diffGroundRows,
  intersectsAny,
  mergeRowRuns,
  planRetention,
  type GroundRun,
  type Rect,
} from '../core/terrain-retention.js';
import { buildWindowFrame, type WindowFrame } from '../core/window-frame.js';
import type { MapGeometry } from '../core/engine/position.js';
import type { GroundTileData } from '../core/terrain-retention.js';
import { metrics } from './render-metrics.js';

/**
 * Additional static layers (roads, for instance). They MUST position from the {@link WindowFrame}
 * (`tileAnchor`), not from `col/row` — otherwise they do not repeat with the ground when zooming
 * out.
 */
export type SurfaceOverlay = (
  target: IndexBlitter,
  cam: Camera,
  frame: WindowFrame,
) => void;

/**
 * Upper bound for the world-anchored surface. It covers all eight map sizes of the original: size 8
 * (512×256) has a period of 16384×5120 == exactly 80 MiB and is the largest the game knows, so the
 * camera space is unreachable in practice and stays a check path.
 *
 * Falling back to camera space for the largest map is not thrifty but harmful: that surface is
 * `window / zoom` large, grows with **1/zoom²** and at low zoom exceeds the world period several
 * times over — it then draws the same map more than once and additionally needs a scroll scratch
 * buffer. Only the still frame is cheaper there, by about a millisecond.
 */
export const WORLD_SURFACE_BUDGET_BYTES = 80 << 20;

/** Scene pixels per tile row (`TILE_H`) — local, to keep the render lookup out of this module. */
const TERRAIN_ROW_PITCH = 20;
/** Scene pixels per tile column (`TILE_W`); the shear per row is half of it. */
const TERRAIN_COL_PITCH = 32;

/**
 * How far a ground triangle draws beyond its tile row — **measured against the archive**: the 81
 * masks of bank `MapMaskDown` have a pivot down to `offsetY = −40`, those of `MapMaskUp` reach up
 * to `offsetY + height = 41`.
 *
 * That fixes the height of a refresh strip exactly: a tile of row `r` draws from `r·20 − raise − 40`
 * (down triangle: base line `+20`, pivot `−40`) to `r·20 + 41` (up triangle without raise). The
 * neighbouring row `r−1` is affected too (it reads the changed tile's height), so its `−20` cancels
 * the `+20` of the base line.
 *
 * One tile row of allowance instead is 20 px too short and leaves pixels standing where the height
 * of the row ABOVE the strip changes — visible only in a full-period comparison.
 */
export const MASK_TOP_REACH = 40;
export const MASK_BOTTOM_REACH = 41;

/**
 * How many tile COLUMNS left and right of a change must be recomposed — **1, and that is derived**.
 *
 * A ground triangle reads the heights of `P`, `P.Down`, `P.DownRight` and `P.Right`
 * (`terrain-commands.ts`), so the height of `P` is read by the triangles of columns `{c−1, c}`. The
 * road layer additionally reads `h(c±1, r±1)` and the terrain type of `(c, r−1)` / `(c−1, r)`,
 * which reaches `{c−1, c, c+1}`. No read dependency goes further. The row half of the same
 * dependency is already covered by the strip's height allowance.
 */
const COL_MARGIN = 1;

/**
 * Extra pixels left and right of the command rects.
 *
 * The road and border-stone layers draw at their own anchor (`tileAnchor`), which lies up to half a
 * tile left of the ground triangle. A whole tile width covers both with reserve.
 */
const OVERLAY_MARGIN_X = 32;

/**
 * Up to this gap x intervals are merged, and more than {@link NARROW_MAX_RECTS} rects collapse into
 * their hull. Both are a **cost** trade-off, not a correctness question: every rect costs a full
 * command pass plus an overlay pass, so coarser merging is only wider, never wrong.
 */
const NARROW_MERGE_GAP = 256;
const NARROW_MAX_RECTS = 4;

/**
 * Extra tile columns left and right of the computed scene-x window of the band camera.
 *
 * Two, because a command that reaches into a dirty rect starts at most one tile width beside it and
 * must be drawn in original order (the masks overlap at their dithered edges).
 */
const CAMERA_TILE_MARGIN = 2;

/**
 * Split a scene range `[y0, y1)` into pieces no longer than the period `by` and fold each back into
 * `[0, by)`. The result carries the **period index** per piece.
 *
 * That index is essential: taking y back by `b` periods also means an x offset of `−b·bx`, because
 * the lattice is sheared. Dropping it puts a narrowed refresh `rows·16` pixels off in the wrapped
 * half.
 */
function splitAtPeriod(y0: number, y1: number, by: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  let y = y0;
  while (y < y1) {
    const b = Math.floor(y / by);
    const start = y - b * by;
    const end = Math.min(by, start + (y1 - y));
    out.push([start, end, b]);
    y += end - start;
  }
  return out;
}

/**
 * Point sampling (nearest neighbour) **without** wrap — the camera path.
 *
 * On palette indices this is well defined: an index is picked, not mixed.
 */
function samplePoints(src: IndexSurface, target: IndexSurface, scale: number): void {
  const inv = 1 / scale;
  const { width: tw, height: th, data: dst } = target;
  const { width: sw, height: sh, data } = src;
  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, (y * inv) | 0);
    const row = sy * sw;
    const out = y * tw;
    let fx = 0;
    for (let x = 0; x < tw; x++, fx += inv) {
      dst[out + x] = data[row + Math.min(sw - 1, fx | 0)]!;
    }
  }
}

/**
 * Sample from the **world-anchored** surface, with torus wrap.
 *
 * The wrap is not a rectangular modulo: the lattice is sheared (`A = (ax,0)`, `B = (bx,by)`, see
 * `viewport-camera.ts`). Because **only `B` moves the y axis**, it is solvable per target row — `b`
 * from y, then correct x by `b·bx`.
 */
function sampleWorld(
  world: IndexSurface,
  target: IndexSurface,
  cam: Camera,
  scale: number,
  geo: MapGeometry,
): void {
  const { ax, bx, by } = wrapLattice(geo);
  const inv = 1 / scale;
  const { width: tw, height: th, data: dst } = target;
  const src = world.data;
  const unit = scale === 1;
  for (let y = 0; y < th; y++) {
    const sy = cam.originY + y * inv;
    const b = Math.floor(sy / by);
    let yy = Math.floor(sy - b * by);
    if (yy < 0) yy = 0;
    else if (yy >= by) yy = by - 1;
    const row = yy * ax;
    let sx = cam.originX - b * bx;
    sx -= Math.floor(sx / ax) * ax;
    const out = y * tw;

    if (unit) {
      // Scale 1: row copy in at most three runs. Pixel-wise is about fifteen times as expensive,
      // and zoom >= 1 is the common case.
      let x0 = 0;
      let read = sx | 0;
      while (x0 < tw) {
        const run = Math.min(tw - x0, ax - read);
        dst.set(src.subarray(row + read, row + read + run), out + x0);
        x0 += run;
        read = 0;
      }
      continue;
    }

    for (let x = 0; x < tw; x++) {
      dst[out + x] = src[row + (sx | 0)]!;
      sx += inv;
      if (sx >= ax) sx -= ax;
    }
  }
}

export interface SurfaceInput {
  readonly geo: MapGeometry;
  readonly tiles: readonly TerrainTileData[];
  readonly heightUnit: number;
  /** Sets the half-row allowance of the height shear; too small ⇒ gaps at the bottom edge. */
  readonly maxHeight: number;
  /** Changes ⇒ rebuild the surface completely. */
  readonly version: string;
  readonly overlay?: SurfaceOverlay;
}

export class TerrainSurface {
  #surface: IndexSurface | null = null;
  #blitter: IndexBlitter | null = null;
  #cache: IndexedTerrainTileCache;
  /** `null` = surface invalid. */
  #prev: { x: number; y: number } | null = null;
  #version = '';
  /** Measurement only. */
  #lastBlits = 0;
  /** Scratch buffer for the self-shift. */
  #scratch: Uint8Array | null = null;
  /** World-anchored surface (`ax × by`), `null` = camera space or not built yet. */
  #world: IndexSurface | null = null;
  #worldBlitter: IndexBlitter | null = null;
  /** Packed tile word per tile, so a road laid down does not redraw the whole world. */
  #worldWords: Uint32Array | null = null;
  /** Dimensions {@link #world} was built for — if they change, the content is unusable. */
  #worldKey = '';
  /** Measurement only: strips and tile rows recomposed in the last call. */
  #lastBands = 0;
  #lastRows = 0;
  /** Measurement only: area of the recomposed rects in pixels. */
  #lastDirtyPixels = 0;

  /**
   * `anchor` picks the anchoring. `'auto'` takes world space when the period fits the budget — the
   * production case. `'camera'` forces the fallback path: checks that examine **the retention
   * itself** (self-shift, dirty rects, signature change) must be able to reach it.
   */
  constructor(
    sprites: IndexedTerrainSpriteSource,
    private readonly anchor: 'auto' | 'camera' | 'world' = 'auto',
  ) {
    this.#cache = new IndexedTerrainTileCache(sprites);
  }

  /**
   * Discards the retained pixels, not the sprite cache — in **both** anchorings.
   *
   * Dropping the word table with them is not mere caution: otherwise the world surface would keep
   * its pixels across an explicit discard. That does not show up on its own, because a loaded save
   * changes the tiles anyway and the signatures then take effect.
   */
  invalidate(): void {
    this.#prev = null;
    this.#worldWords = null;
  }

  get lastBlits(): number {
    return this.#lastBlits;
  }

  /** Distinct precomposed triangles in the cache. */
  get cachedTiles(): number {
    return this.#cache.composedCount;
  }

  /** Row strips of the world surface recomposed in the last call (0 = nothing to do). */
  get lastBands(): number {
    return this.#lastBands;
  }

  /**
   * Tile ROWS covered by the strips of the last call — the more honest cost measure. The strip
   * count alone says nothing: a strip can be one row or the whole map.
   */
  get lastRows(): number {
    return this.#lastRows;
  }

  /**
   * Pixel area of the rects recomposed in the last call. It is the measure that makes a cost defect
   * visible: strip count and row count can both be right while the refresh pulls the full map width.
   */
  get lastDirtyPixels(): number {
    return this.#lastDirtyPixels;
  }

  /** Is the world anchoring running? (Otherwise camera space — see the module header.) */
  worldAnchored(geo: MapGeometry): boolean {
    if (this.anchor === 'camera') return false;
    const { ax, by } = wrapLattice(geo);
    return this.anchor === 'world' || ax * by <= WORLD_SURFACE_BUDGET_BYTES;
  }

  /**
   * Bring the surface up to date and put the visible section into `target`.
   *
   * `scale` is the target's scale (1 = scene resolution, < 1 = zoomed out, then it is point-sampled
   * down). `target` is `cam.width·scale × cam.height·scale` accordingly.
   */
  render(target: IndexSurface, cam: Camera, input: SurfaceInput, scale = 1): void {
    this.#lastBands = 0;
    this.#lastRows = 0;
    this.#lastDirtyPixels = 0;
    if (this.worldAnchored(input.geo)) {
      this.#renderWorld(target, cam, input, scale);
      return;
    }
    const w = Math.max(1, Math.ceil(cam.width));
    const h = Math.max(1, Math.ceil(cam.height));

    if (this.#surface === null || this.#surface.width !== w || this.#surface.height !== h) {
      this.#surface = createIndexSurface(w, h);
      this.#blitter = new IndexBlitter(this.#surface);
      this.#scratch = null;
      this.#prev = null; // different dimensions => contents unusable
    }
    if (input.version !== this.#version) {
      this.#version = input.version;
      this.#prev = null;
    }
    const surface = this.#surface;
    const blitter = this.#blitter;
    if (blitter === null) return;

    const cur = { x: cam.originX, y: cam.originY };
    // Without retained pixels the whole surface is redrawn — the most expensive single item, and
    // when zooming it happens on every wheel tick (different dimensions ⇒ content unusable).
    if (this.#prev === null) metrics.countRebuild();
    const plan = planRetention(this.#prev, cur, w, h);

    if (plan.shift !== null && (plan.shift.dx !== 0 || plan.shift.dy !== 0)) {
      this.#shift(surface, plan.shift.dx, plan.shift.dy);
    }

    this.#lastBlits = 0;
    if (plan.dirty.length > 0) {
      this.#fill(surface, blitter, cam, input, plan.dirty);
    }
    this.#prev = cur;

    if (scale === 1 && target.width === w && target.height === h) {
      target.data.set(surface.data);
    } else if (scale === 1) {
      const rows = Math.min(target.height, h);
      const cols = Math.min(target.width, w);
      for (let y = 0; y < rows; y++) {
        target.data.set(surface.data.subarray(y * w, y * w + cols), y * target.width);
      }
    } else {
      samplePoints(surface, target, scale);
    }
  }

  /**
   * World-anchored path: the surface holds **one whole torus period**, is refreshed strip-wise only
   * on a real tile change and is merely sampled per frame. Scrolling then costs as much as standing
   * still, and a mouse-wheel tick costs **no** composition at all.
   */
  #renderWorld(target: IndexSurface, cam: Camera, input: SurfaceInput, scale: number): void {
    const { ax, by } = wrapLattice(input.geo);
    const key = `${ax}x${by}`;
    if (this.#world === null || this.#worldKey !== key) {
      this.#world = createIndexSurface(ax, by);
      this.#worldBlitter = new IndexBlitter(this.#world);
      this.#worldKey = key;
      this.#worldWords = null;
      metrics.countRebuild();
    }
    const world = this.#world;
    const blitter = this.#worldBlitter;
    if (blitter === null) return;

    const { cols, rows } = input.geo;
    if (this.#worldWords === null || this.#worldWords.length !== cols * rows) {
      this.#worldWords = new Uint32Array(cols * rows).fill(GROUND_WORD_NONE);
    }
    const diff = diffGroundRows(
      input.tiles as readonly GroundTileData[],
      cols,
      rows,
      this.#worldWords,
    );

    if (diff.rows.length > 0) {
      // Bridge gaps up to the strip height, otherwise two nearby runs compose the same pixels
      // twice. The height comes from the same computation as in `#composeRows`.
      const liftRows = Math.ceil((input.maxHeight * input.heightUnit) / TERRAIN_ROW_PITCH);
      const runs = mergeRowRuns(diff, liftRows + 2);
      // Cap it: many small runs each pay their raise margin. Once the sum is as large as the map,
      // one pass is cheaper.
      const total = runs.reduce((a, r) => a + (r.r1 - r.r0) + liftRows + 2, 0);
      const plan: readonly GroundRun[] =
        total >= rows ? [{ r0: 0, r1: rows, colLo: 0, colHi: cols - 1 }] : runs;
      this.#lastBands = plan.length;
      this.#lastRows = plan.reduce((a, r) => a + (r.r1 - r.r0), 0);
      this.#lastBlits = 0;
      for (const run of plan) this.#composeRows(world, blitter, input, run);
    }

    sampleWorld(world, target, cam, scale, input.geo);
  }

  /**
   * Recompose the refresh area of a {@link GroundRun}.
   *
   * The affected scene band is taller than the row range itself: a tile is pulled up by up to
   * `maxHeight · heightUnit` pixels and reaches one tile height down. If the band runs over the end
   * of the period it is **split** at the seam — both halves get their own band camera at
   * `originX = 0`, so the x axis keeps the meaning it has in the surface (`tileToWindow` resolves
   * the sheared lattice correctly for any camera).
   *
   * In **x** nothing is computed but filtered: the affected tile columns go in as a set, and
   * `#fill` derives the rects from the commands of those columns. That is the only way that does
   * not model shear and seam a second time (see the module header).
   */
  #composeRows(
    world: IndexSurface,
    blitter: IndexBlitter,
    input: SurfaceInput,
    run: GroundRun,
  ): void {
    const { ax, bx, by } = wrapLattice(input.geo);
    const { cols } = input.geo;
    const lift = input.maxHeight * input.heightUnit;
    let y0 = run.r0 * TERRAIN_ROW_PITCH - lift - MASK_TOP_REACH;
    let y1 = run.r1 * TERRAIN_ROW_PITCH + MASK_BOTTOM_REACH;
    if (y1 - y0 >= by) {
      y0 = 0;
      y1 = by;
    }

    // Column set with torus wrap. If it covers the whole width the filter is dropped — the
    // full-width path is then simpler and cheaper (no second pass).
    const span = run.colHi - run.colLo + 1 + 2 * COL_MARGIN;
    let onlyCols: Set<number> | null = null;
    if (span < cols) {
      onlyCols = new Set<number>();
      for (let c = run.colLo - COL_MARGIN; c <= run.colHi + COL_MARGIN; c++) {
        onlyCols.add(((c % cols) + cols) % cols);
      }
    }

    // Scene-x window of the strip. `x(col,row) = col·32 − row·16` (the same shear `wrapLattice`
    // carries as `bx = −rows·16`), so the minimum is at the smallest column and the LARGEST row.
    // Without this window the refresh costs a base load over the full map width — not for the
    // blits, but for traversal, command build and overlay.
    //
    // It is computed from the rows that DRAW in the strip, not from the changed ones: `#narrow`
    // only picks columns, so the dirty rects span the shear of the whole strip height, and every
    // command reaching into a dirty rect must be in the camera's command set or it is not redrawn.
    const rTop = Math.floor((y0 - MASK_BOTTOM_REACH) / TERRAIN_ROW_PITCH);
    const rBot = Math.ceil((y1 + lift + MASK_TOP_REACH) / TERRAIN_ROW_PITCH);
    const pad = (COL_MARGIN + CAMERA_TILE_MARGIN) * TERRAIN_COL_PITCH;
    const xLo = run.colLo * TERRAIN_COL_PITCH - rBot * (TERRAIN_COL_PITCH / 2) - pad;
    const xHi =
      (run.colHi + 1) * TERRAIN_COL_PITCH - rTop * (TERRAIN_COL_PITCH / 2) + pad;
    const fullWidth = onlyCols === null || xHi - xLo >= ax || y1 - y0 >= by;

    for (const [sa, sb, b] of splitAtPeriod(y0, y1, by)) {
      const h = sb - sa;
      if (h <= 0) continue;
      if (fullWidth) {
        const bandCam: Camera = { originX: 0, originY: sa, width: ax, height: h };
        this.#fill(world, blitter, bandCam, input, [{ x: 0, y: sa, w: ax, h }], 0, sa, onlyCols);
        continue;
      }
      // **This is where the shear is.** The y piece was folded back by `b` periods, so the same
      // tile row sits `−b·bx` pixels offset inside it. Without this term, the half of a strip that
      // crosses the y seam is `rows·16` px off. In x the torus is **not** sheared (`A = (ax, 0)`).
      const shear = -b * bx;
      for (const [xa, xb] of splitAtPeriod(xLo + shear, xHi + shear, ax)) {
        const w = xb - xa;
        if (w <= 0) continue;
        const bandCam: Camera = { originX: xa, originY: sa, width: w, height: h };
        this.#fill(world, blitter, bandCam, input, [{ x: xa, y: sa, w, h }], xa, sa, onlyCols);
      }
    }
  }

  /**
   * Narrow the dirty rects down to the commands of the affected columns.
   *
   * It works with the **actual** command rects (pivot and width from the triangle cache) rather
   * than a computed column position — which is why it holds across the seam and under the shear.
   * The x intervals are merged generously: merging more is always allowed (only slower), and many
   * narrow rects each cost a full command and overlay pass.
   */
  #narrow(
    dirty: readonly Rect[],
    commands: readonly TerrainCommand[],
    onlyCols: ReadonlySet<number>,
    pixelX: number,
    shiftX: number,
  ): Rect[] {
    const spans: [number, number][] = [];
    for (const cmd of commands) {
      if (!onlyCols.has(cmd.col)) continue;
      const t = this.#cache.get(cmd.kind, cmd.maskIndex, cmd.groundSprite);
      if (t === null) continue;
      const x = cmd.x + t.offsetX - pixelX + shiftX;
      spans.push([x - OVERLAY_MARGIN_X, x + t.width + OVERLAY_MARGIN_X]);
    }
    if (spans.length === 0) return [];
    spans.sort((a, b) => a[0] - b[0]);
    // Bridge gaps up to one strip width; below that a separate rect does not pay off.
    const merged: [number, number][] = [];
    for (const [a, b] of spans) {
      const last = merged[merged.length - 1];
      if (last !== undefined && a - last[1] <= NARROW_MERGE_GAP) {
        if (b > last[1]) last[1] = b;
      } else {
        merged.push([a, b]);
      }
    }
    const use =
      merged.length <= NARROW_MAX_RECTS
        ? merged
        : [[merged[0]![0], merged[merged.length - 1]![1]] as [number, number]];

    const out: Rect[] = [];
    for (const r of dirty) {
      for (const [a, b] of use) {
        const x0 = Math.max(r.x, Math.floor(a));
        const x1 = Math.min(r.x + r.w, Math.ceil(b));
        if (x1 > x0) out.push({ x: x0, y: r.y, w: x1 - x0, h: r.h });
      }
    }
    return out;
  }

  /** Byte copy with overlap protection. */
  #shift(surface: IndexSurface, dx: number, dy: number): void {
    const { width: w, height: h, data } = surface;
    if (this.#scratch === null || this.#scratch.length !== data.length) {
      this.#scratch = new Uint8Array(data.length);
    }
    const src = this.#scratch;
    src.set(data);
    data.fill(0);
    const y0 = Math.max(0, dy);
    const y1 = Math.min(h, h + dy);
    const x0 = Math.max(0, dx);
    const x1 = Math.min(w, w + dx);
    if (y0 >= y1 || x0 >= x1) return;
    for (let y = y0; y < y1; y++) {
      const from = (y - dy) * w + (x0 - dx);
      data.set(src.subarray(from, from + (x1 - x0)), y * w + x0);
    }
  }

  /**
   * Draw ground (+ overlays) into the dirty rects, clipped.
   *
   * `shiftX/shiftY` move the output: when building a band of the world surface the positions come
   * relative to the **band** camera while the writing goes into the world surface. The offset sits
   * on the blitter and not in this computation, because the road/border layer blits itself.
   */
  #fill(
    surface: IndexSurface,
    blitter: IndexBlitter,
    cam: Camera,
    input: SurfaceInput,
    dirty: readonly Rect[],
    shiftX = 0,
    shiftY = 0,
    onlyCols: ReadonlySet<number> | null = null,
  ): void {
    const { geo, tiles, heightUnit, maxHeight } = input;
    const frame = buildWindowFrame(cam, geo, maxHeight);
    const commands = buildTerrainCommands(frame.halfRows, geo, tiles, heightUnit);

    const rects =
      onlyCols === null ? dirty : this.#narrow(dirty, commands, onlyCols, frame.pixelX, shiftX);
    if (rects.length === 0) return;
    for (const r of rects) this.#lastDirtyPixels += r.w * r.h;

    blitter.setOffset(shiftX, shiftY);
    // The rects are disjoint (see `terrain-retention.ts`) — clipping once per rect is enough.
    for (const r of rects) {
        // Clear first, so nothing old shows through mask edges.
      const x1 = Math.min(surface.width, r.x + r.w);
      const y1 = Math.min(surface.height, r.y + r.h);
      for (let y = Math.max(0, r.y); y < y1; y++) {
        surface.data.fill(0, y * surface.width + Math.max(0, r.x), y * surface.width + x1);
      }
      blitter.setClip({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
      for (const cmd of commands) {
        const t = this.#cache.get(cmd.kind, cmd.maskIndex, cmd.groundSprite);
        if (t === null) continue;
        // Position relative to the camera; the blitter adds the offset itself. The intersection
        // test needs SURFACE coordinates, i.e. with the offset.
        const x = cmd.x + t.offsetX - frame.pixelX;
        const y = cmd.y + t.offsetY - frame.pixelY;
        if (!intersectsAny({ x: x + shiftX, y: y + shiftY, w: t.width, h: t.height }, rects)) continue;
        blitter.blit(t, x, y);
        this.#lastBlits++;
      }
      input.overlay?.(blitter, cam, frame);
    }
    blitter.setClip(null);
    blitter.setOffset(0, 0);
  }
}
