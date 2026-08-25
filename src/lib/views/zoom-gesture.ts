/**
 * Zoom factor from a `wheel` event — shared by the map and the menu view.
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
