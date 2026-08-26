/**
 * Zoom arithmetic of the pointer surfaces — shared by the map and the menu view.
 *
 * Three concerns, all DOM-free so they can be checked without a browser: the factor of a `wheel`
 * event, the direct factor of a two-finger pinch, and the camera that keeps a given point of the
 * scene under a given pixel while the zoom changes.
 *
 * Exponential rather than a fixed step per event: a mouse wheel delivers few large deltas, a
 * touchpad many small ones. Only `exp(-Δ·k)` composes and feels the same on both. A pinch arrives
 * as a `wheel` with `ctrlKey` — that is how browsers report touchpad pinch — and needs its own
 * sensitivity because its deltas are much smaller.
 */

/** Factor per notch of a classic mouse wheel. */
export const WHEEL_STEP = 1.15;

/** `deltaY` arrives in pixels (0), lines (1) or pages (2) depending on the browser. */
const LINE_PX = 40;
const PAGE_PX = 400;

/** Chrome/Edge report 100 px per notch; both sensitivities are normalised to that. */
const NOTCH_PX = 100;
const WHEEL_K = Math.log(WHEEL_STEP) / NOTCH_PX;
const PINCH_K = 1 / NOTCH_PX;

/** Cap per single event: a delayed frame can deliver a very large delta. */
const MAX_FACTOR = 4;

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
 * > 1 zooms in, < 1 zooms out. The limits belong to the caller (the map has a dynamic lower bound,
 * the menu a fixed one).
 */
export function wheelZoomFactor(e: ZoomWheelEvent): number {
  const px = wheelDeltaPixels(e);
  const factor = Math.exp(-px * (e.ctrlKey ? PINCH_K : WHEEL_K));
  return Math.min(MAX_FACTOR, Math.max(1 / MAX_FACTOR, factor));
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
 * Zoom of a running pinch: **direct**, not the exponential curve of {@link wheelZoomFactor}.
 *
 * A wheel is a rate — it has no state of its own, so only a factor per event composes. A pinch has
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
