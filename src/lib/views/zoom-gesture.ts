/**
 * Zoom arithmetic of the pointer surfaces — shared by the map and the menu view.
 *
 * Four concerns, all DOM-free so they can be checked without a browser: the zoom STAGES (the only
 * zooms that are shown), `wheel` events turned into whole stages, the direct factor of a two-finger
 * pinch, and the camera that keeps a given point of the scene under a given pixel while the zoom
 * changes.
 */

/** `deltaY` arrives in pixels (0), lines (1) or pages (2) depending on the browser. */
const LINE_PX = 40;
const PAGE_PX = 400;

/** Chrome/Edge report 100 px per notch. */
const NOTCH_PX = 100;

/** Only the fields actually used — that keeps the function testable without a DOM. */
export interface ZoomWheelEvent {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
}

export function wheelDeltaPixels(e: ZoomWheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * PAGE_PX;
  return e.deltaY;
}

/**
 * A scale that does not grow beyond the available surface. An edge length of `0` means "not
 * measured yet" and clips nothing — otherwise the first scale would always be 0.
 */
export function fitScale(
  zoom: number,
  avail: { readonly width: number; readonly height: number },
  surface: { readonly width: number; readonly height: number },
): number {
  let s = zoom;
  if (avail.width > 0) s = Math.min(s, avail.width / surface.width);
  if (avail.height > 0) s = Math.min(s, avail.height / surface.height);
  return s;
}

/**
 * The scene coordinate under an element pixel. Element pixel and scene differ by the camera origin
 * and the zoom, one axis at a time — the caller applies it twice.
 */
export function scenePoint(cam: number, zoom: number, p: number): number {
  return cam + p / zoom;
}

/**
 * The camera that puts `scene` under the element pixel `p` at zoom `next`.
 *
 * Together with {@link scenePoint} this is what "zoom about a point" means: read the scene point
 * once, then place it again at the new zoom. Both the wheel and the pinch go through here, and the
 * pinch recomputes the camera **absolutely** on every move from the point it grabbed at the start —
 * so the rounding cannot accumulate, and a gesture that returns to its starting distance returns to
 * the starting camera exactly.
 *
 * The expression is written out rather than factored (`cam + p * (1/zoom - 1/next)` is the same in
 * algebra and not in floating point) because the wheel's result must not change.
 */
export function anchorCamera(scene: number, next: number, p: number): number {
  return Math.round(scene - p / next);
}

/**
 * Below this finger distance the baseline stops shrinking. Without it two fingers landing 2 px
 * apart would give a factor of a hundred over a normal spread; the floor applies to **both**
 * distances, so an unmoved pinch still returns exactly the zoom it started with.
 */
export const PINCH_MIN_DIST = 16;

/**
 * Zoom of a running pinch: **direct**, as a ratio of finger distances.
 *
 * A wheel is a rate — it has no state of its own, so it can only add up deltas. A pinch has
 * a state (the finger distance), and only the direct ratio keeps the fingers on the spot they
 * grabbed. Mixing the two makes the content slide away under them.
 */
export function pinchZoom(
  startZoom: number,
  startDist: number,
  dist: number,
  min: number,
  max: number,
): number {
  const a = Math.max(PINCH_MIN_DIST, startDist);
  const b = Math.max(PINCH_MIN_DIST, dist);
  return Math.min(max, Math.max(min, (startZoom * b) / a));
}

/**
 * **Zoom stages.** The map only shows zooms at which one game pixel is a whole or half number of
 * DEVICE pixels wide. Any other enlargement would have to be filtered, and
 * filtering blurs pixel art.
 *
 * Below 1 nothing is enlarged: the map is thinned out while it is written (nearest sampling), which
 * is sharp at ANY factor. The stages there are only a matter of step width — four per halving, so a
 * wheel notch is about −16 % rather than the jump from 1 to ½.
 *
 * The half stages are drawn UNFILTERED: their pixels are alternately n and n+1 device pixels wide.
 * That is visible but sharp, and the ratio 1:2, 2:3, 3:4 … shrinks as the zoom grows. At 1.5 it is
 * clearly visible; it stays anyway, because without it the step from 1 to 2 doubles the picture.
 *
 * A stage is an integer: `s ≤ 0` means `2^(s/4)` device pixels per game pixel (0 → 1, −1 → 0.84,
 * −4 → ½ …), `s ≥ 0` means `1 + s/2` (1, 1.5, 2, 2.5 …). The zoom is in CSS pixels, so a stage
 * becomes `deviceOfStage(s) / dpr`.
 * Rounding the ZOOM to whole numbers would be the tempting shortcut and is wrong on a screen at
 * 125 % or 150 %: `2 · 1.5` is 3 device pixels, but `2 · 1.25` is 2.5.
 */
export function deviceOfStage(s: number): number {
  return s <= 0 ? 2 ** (s / 4) : 1 + s / 2;
}

/** Slack for `zoom · dpr` products like 2.9999999996 that mean 3. */
const STAGE_EPS = 1e-9;

/** The largest stage whose device factor does not exceed `d`. */
function stageAtOrBelow(d: number): number {
  if (d < 1 - STAGE_EPS) return Math.floor(4 * Math.log2(d) + STAGE_EPS);
  return Math.floor(2 * d + STAGE_EPS) - 2;
}

/**
 * The stage nearest to `zoom`, measured as a RATIO (in log space): 1.4 lies closer to 1 than to 2
 * by difference but not by ratio, and a pinch that has spread the fingers 40 % should move on.
 */
export function stageOfZoom(zoom: number, dpr: number): number {
  const d = zoom * dpr;
  const lo = stageAtOrBelow(d);
  const hi = lo + 1;
  return Math.log(d / deviceOfStage(lo)) <= Math.log(deviceOfStage(hi) / d) ? lo : hi;
}

export function zoomOfStage(s: number, dpr: number): number {
  return deviceOfStage(s) / dpr;
}

/**
 * The largest stage not above `zoom`, as a zoom. For a scale that has to FIT (the menu surface):
 * rounding to the nearest stage could make it larger than the room it was fitted into.
 */
export function stageZoomAtOrBelow(zoom: number, dpr: number): number {
  return zoomOfStage(stageAtOrBelow(zoom * dpr), dpr);
}

/**
 * The stage range for the bounds `min`/`max` (both zooms). The lower one is the largest stage AT OR
 * BELOW `min`, not the first above it: `min` is "the whole world fits", and a stage that stays just
 * short of it would make the whole world unreachable — a little repetition at the edge is the lesser
 * cost.
 */
function stageBounds(dpr: number, min: number, max: number): { lo: number; hi: number } {
  const hi = stageAtOrBelow(max * dpr);
  const lo = Math.min(hi, stageAtOrBelow(min * dpr));
  return { lo, hi };
}

/** `zoom` moved onto the nearest permitted stage. */
export function snapZoom(zoom: number, dpr: number, min: number, max: number): number {
  const { lo, hi } = stageBounds(dpr, min, max);
  return zoomOfStage(Math.min(hi, Math.max(lo, stageOfZoom(zoom, dpr))), dpr);
}

/** `steps` stages away from the stage `zoom` sits on (positive zooms in). */
export function stepZoomStage(
  zoom: number,
  steps: number,
  dpr: number,
  min: number,
  max: number,
): number {
  const { lo, hi } = stageBounds(dpr, min, max);
  return zoomOfStage(Math.min(hi, Math.max(lo, stageOfZoom(zoom, dpr) + steps)), dpr);
}

/**
 * Touchpad pinch pixels per stage. A touchpad pinch arrives as a `wheel` with `ctrlKey` and much
 * smaller deltas than a wheel notch; about 30 px of it is a deliberate small spread, so it is one
 * stage.
 */
const PINCH_STAGE_PX = 30;

/**
 * Wheel events turned into whole stages. A mouse wheel notch (100 px) is exactly one stage; a
 * touchpad delivers many small deltas, which are summed until a stage is full. The remainder is
 * carried by the caller; a change of direction drops it, otherwise turning back would first have to
 * pay off the leftover of the other direction.
 */
export function wheelStageSteps(
  rest: number,
  e: ZoomWheelEvent,
): { readonly steps: number; readonly rest: number } {
  const units = -wheelDeltaPixels(e) / (e.ctrlKey ? PINCH_STAGE_PX : NOTCH_PX);
  const acc = Math.sign(units) !== Math.sign(rest) ? units : rest + units;
  // Ten touchpad deltas of a tenth sum to 0.9999999…, which is a whole stage.
  const steps = Math.trunc(acc + Math.sign(acc) * STAGE_EPS);
  return { steps, rest: acc - steps };
}
