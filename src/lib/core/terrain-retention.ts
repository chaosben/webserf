/**
 * Retention of the ground surface: what to keep and what to refill while scrolling (pure).
 *
 * ## Why not like the original
 *
 * The original keeps a **command list** per half row and works through it **every frame** —
 * `FUN_00033dcc` hangs in the frame loop on a single gate (`uiLayoutFlags` bit 3, "game view
 * visible"), with no dirty or scroll test, and `FUN_00036b12` blits every list entry. What is
 * retained there are the **lists, not the pixels**: it saves determining mask/texture per triangle,
 * not the drawing.
 *
 * Here that is the cheap part — building the whole command list costs 0.11 ms at 640 x 480, 0.42 ms
 * at 1920 x 1080, 1.46 ms at 3840 x 2160. The blits are expensive (over 28000 per frame at 4K). The
 * original model would optimise the 0.1 ms share and leave the expensive one untouched; on a 486
 * that was right, since every pixel was CPU work and a full-screen surface could not be shifted
 * cheaply. With an offscreen canvas and GPU blit the cost model is inverted.
 *
 * Hence: **keep pixels.** Not scrolling, a frame costs one blit; scrolling, a self-copy plus the
 * newly entering strips. The command list is rebuilt **completely** and filtered against the dirty
 * rects — at 0.1 ms of build time the original's strip bookkeeping is needless complexity.
 *
 * ## Why the refresh MUST be clipped
 *
 * The ground triangles **overlap** (127 % area coverage, see `map-viewport.ts`), so painter order is
 * semantically relevant. It is therefore *not* enough to draw only the "new" tiles inside a dirty
 * rect: an overlapping neighbour that lies outside and is not redrawn would then be missing on top.
 * The correct way is to **clip to the rect and draw all intersecting commands in original order**.
 * Then the order inside the rect is right and the result is identical to a full rebuild — which the
 * self-check exploits (full rebuild == one dirty rect over the whole surface).
 */

/** Rectangle in window pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * What to do for the new scroll position.
 *
 * `shift` is the displacement of the **kept content** in pixels, not the camera's: if the camera
 * moves right, the content moves left and `shift.dx` is negative. `null` means "no usable overlap" —
 * the surface is refilled completely.
 *
 * `dirty` are **disjoint** rectangles to refill. Scrolling along one axis gives one, diagonally two
 * (a full strip across, one in the remainder).
 */
export interface RetentionPlan {
  readonly shift: { readonly dx: number; readonly dy: number } | null;
  readonly dirty: readonly Rect[];
}

/**
 * Plans the transition from `prev` to `cur` (both **scene** coordinates of the window origin, i.e.
 * `Camera.originX/Y`). `prev === null` means "surface is empty", so everything is new.
 *
 * The displacement is rounded to whole pixels because an image surface can only be copied
 * integrally; subpixel fine scrolling belongs to the blit **onto** the screen, not to retention.
 */
export function planRetention(
  prev: { readonly x: number; readonly y: number } | null,
  cur: { readonly x: number; readonly y: number },
  width: number,
  height: number,
): RetentionPlan {
  const full: RetentionPlan = { shift: null, dirty: [{ x: 0, y: 0, w: width, h: height }] };
  if (prev === null || width <= 0 || height <= 0) return full;

  const dx = Math.round(prev.x - cur.x);
  const dy = Math.round(prev.y - cur.y);
  if (dx === 0 && dy === 0) return { shift: { dx: 0, dy: 0 }, dirty: [] };
  // No overlap left (jump, map change, very fast scrolling) — not worth keeping.
  if (Math.abs(dx) >= width || Math.abs(dy) >= height) return full;

  const dirty: Rect[] = [];

  // Vertical strip: the column newly entering in x, over the full height.
  if (dx > 0) dirty.push({ x: 0, y: 0, w: dx, h: height });
  else if (dx < 0) dirty.push({ x: width + dx, y: 0, w: -dx, h: height });

  // Horizontal strip: the row newly entering in y — only over the x range the vertical strip does
  // NOT already cover, so the rects stay disjoint.
  if (dy !== 0) {
    const x = dx > 0 ? dx : 0;
    const w = width - Math.abs(dx);
    if (w > 0) {
      if (dy > 0) dirty.push({ x, y: 0, w, h: dy });
      else dirty.push({ x, y: height + dy, w, h: -dy });
    }
  }

  return { shift: { dx, dy }, dirty };
}

/** Do two rectangles intersect (touching at an edge does not count)? */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Does `r` intersect at least one of the rectangles? */
export function intersectsAny(r: Rect, rects: readonly Rect[]): boolean {
  for (const o of rects) if (rectsIntersect(r, o)) return true;
  return false;
}

/** Total area of the dirty rects in pixels — the measure of what a scroll step really costs. */
export function dirtyArea(plan: RetentionPlan): number {
  let a = 0;
  for (const r of plan.dirty) a += r.w * r.h;
  return a;
}

/**
 * Tile fields the **kept ground surface** reads — the input of {@link groundSignature}.
 *
 * Exactly five, and the list is surveyed rather than asserted: `terrain-commands` needs `height` +
 * `terrainUp/terrainDown`, `road-layer` additionally `paths`, `border-layer` additionally `owner`.
 * Everything else on a tile (`object`, `objIndex`, `serfIndex`, `mineral`, `resourceAmount`,
 * `blocked`) belongs to layers drawn **fresh every frame** and must be absent here — otherwise every
 * growing tree would rebuild the whole surface.
 */
export interface GroundTileData {
  readonly height: number;
  readonly terrainUp: number;
  readonly terrainDown: number;
  readonly paths: number;
  readonly owner: number;
}

/**
 * Fingerprint of all tile fields the kept ground surface depends on.
 *
 * ## Why this exists
 *
 * Retention keeps pixels across frames and refreshes only the **dirty rects of scrolling**. Its
 * documented correctness condition was "identical to a full rebuild" — and that held only under an
 * assumption nobody had written down: *the map does not change*. It does change constantly from the
 * simulation (the AI lays roads, a digger raises terrain, a conquest recolours territory) — measured
 * on a real save: 15 road-bit, 8 height and 6 object changes in 10000 ticks without a single
 * command. With the camera standing still, a new road stayed invisible until something else rebuilt
 * the surface.
 *
 * ## Why a signature and not a counter
 *
 * A `mapRevision` counter in the engine would be cheaper but would have to be maintained at 113
 * write sites in ~20 modules — the same duplication trap that produced two other bugs the same day.
 * A signature derived from the content cannot forget a future write site.
 *
 * Cost, measured: 0.017 ms at 4096 tiles (64x64), 1.06 ms at 131072 (512x256, the largest free-play
 * size). Hence the call belongs on the **logic frame** (12.5/s) and not on the repaint, where the
 * large map would be expensive. A rebuild of the surface still only happens when something really
 * changed.
 */
export function groundSignature(tiles: readonly GroundTileData[]): number {
  let a = 0x811c9dc5;
  for (let i = 0; i < tiles.length; i++) {
    a = (Math.imul(a ^ groundTileWord(tiles[i]!), 16777619) | 0) >>> 0;
  }
  return a;
}

/**
 * The five ground-relevant fields of ONE tile packed into a single value.
 *
 * `paths` 6 bits · `height` 5 · `terrainUp` 4 · `terrainDown` 4 · `owner` 3 = **22 bits, hence
 * collision-free**. That is why {@link diffGroundRows} is **exact** rather than "probably right"
 * like a hash: equal value iff equal five fields.
 *
 * Adding a field here changes all consumers at once (global signature, row diff, guard) — which is
 * why the packing exists once and not three times.
 */
export function groundTileWord(t: GroundTileData): number {
  return (
    (t.paths & 0x3f) |
    ((t.height & 0x1f) << 6) |
    ((t.terrainUp & 0xf) << 11) |
    ((t.terrainDown & 0xf) << 15) |
    ((t.owner & 0x7) << 19)
  );
}

/**
 * Not a valid {@link groundTileWord} (which uses 22 bits) — so a freshly allocated buffer differs in
 * EVERY tile and the first pass builds everything.
 *
 * A zero would **not** do that: a tile with `paths 0, height 0, terrain 0/0, owner 0` is possible,
 * and in an empty buffer it would count as "unchanged" and stay undrawn.
 */
export const GROUND_WORD_NONE = 0xffffffff;

/**
 * Result of {@link diffGroundRows}: the changed tile rows with their column bounds.
 *
 * The three arrays are **parallel** (entry `i` belongs to row `rows[i]`). The column bounds are per
 * row and not global, because the refresh derives the strip's x extent from them: a global hull
 * would already be nearly the whole map width for two far-apart changes.
 */
export interface GroundRowDiff {
  /** Changed rows, ascending. */
  readonly rows: number[];
  /** Smallest changed column of that row. */
  readonly colLo: number[];
  /** Largest changed column of that row. */
  readonly colHi: number[];
}

/**
 * Which tile ROWS changed since the last call, and in which COLUMNS? Updates `words` as it goes.
 *
 * ## Why rows, and why exact
 *
 * The world-anchored ground surface recomposes row **strips** (see `views/terrain-surface.ts`), so
 * the question it must answer is "which rows", not "did anything change". A hash over bands of 32
 * rows would answer it too coarsely: on the largest map (512x256, world surface 84 MB) one changed
 * tile then costs **130 ms**, because an eighth of the surface is redrawn. The word table names the
 * one row.
 *
 * ## Why columns too
 *
 * A **full width** strip still costs 32 ms on that map, because all 512 columns are recomposed for
 * one changed tile. The column bounds turn the strip into a rectangle, and they cost nothing here:
 * the loop runs over every tile anyway.
 *
 * The buffer holds `cols · rows` entries (512 KB on the largest map) and is compared and updated **in
 * the same loop**: one pass instead of hashing plus comparing, and no second buffer for the previous
 * state.
 */
export function diffGroundRows(
  tiles: readonly GroundTileData[],
  cols: number,
  rows: number,
  words: Uint32Array,
): GroundRowDiff {
  const out: GroundRowDiff = { rows: [], colLo: [], colHi: [] };
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let lo = -1;
    let hi = -1;
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      const w = groundTileWord(tiles[i]!);
      if (words[i] !== w) {
        words[i] = w;
        if (lo < 0) lo = c;
        hi = c;
      }
    }
    if (lo >= 0) {
      out.rows.push(r);
      out.colLo.push(lo);
      out.colHi.push(hi);
    }
  }
  return out;
}

/**
 * One contiguous refresh area: rows `[r0, r1)` and the enclosing column bounds of all changes in it.
 */
export interface GroundRun {
  readonly r0: number;
  readonly r1: number;
  readonly colLo: number;
  readonly colHi: number;
}

/**
 * Merges ascending row indices into half-open runs `[r0, r1)`, bridging gaps up to `gap`; the column
 * bounds are united per run.
 *
 * Bridging is not cosmetic: because of the height offset a row's scene strip is a good eight rows
 * tall, so two nearby runs would compose **the same pixels twice**. Merging more coarsely is always
 * allowed (only slower), more finely is not — the same holds for the columns.
 */
export function mergeRowRuns(diff: GroundRowDiff, gap: number): GroundRun[] {
  const out: { r0: number; r1: number; colLo: number; colHi: number }[] = [];
  for (let i = 0; i < diff.rows.length; i++) {
    const r = diff.rows[i]!;
    const lo = diff.colLo[i]!;
    const hi = diff.colHi[i]!;
    const last = out[out.length - 1];
    if (last !== undefined && r - last.r1 <= gap) {
      last.r1 = r + 1;
      if (lo < last.colLo) last.colLo = lo;
      if (hi > last.colHi) last.colHi = hi;
    } else {
      out.push({ r0: r, r1: r + 1, colLo: lo, colHi: hi });
    }
  }
  return out;
}
