/**
 * WHERE THE PIECES OF THE ORIGINAL SCREEN SIT IN OUR WINDOW — in numbers.
 *
 * The original draws bar and popup into ONE framebuffer at fixed pixel positions inside its
 * 640 x 480 screen. Our window is freely sized, so the arrangement has to be anchored: the screen is
 * centred horizontally, flush with the bottom, and every part shares one scale. That way the parts
 * keep their positions RELATIVE TO EACH OTHER, which is what the original layout actually encodes
 * (the popup is 8 px left of centre and 19 px above the bar, not centred).
 *
 * WHY THIS IS A MODULE OF ITS OWN: three consumers need the same rectangle — the compositor that
 * blits the part, the hit test that turns a click into a source pixel, and the scale of the mouse
 * pointer. Anything computed twice can drift apart; here it cannot.
 *
 * Everything is rounded to whole pixels: the parts are blitted unsmoothed, and a fractional
 * destination would resample a pixel-art surface.
 */

import { CONTROL_PANEL_BOUNDS, UI_SCREEN } from '../core/ui-render.js';

/** A rectangle in canvas pixels, origin top left. */
export interface BoxRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A part of the original screen: position and size within {@link UI_SCREEN}. */
export interface OriginBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Scale of the original screen inside the window.
 *
 * Never below 1x, never wider than the window — and the window wins. It follows the zoom so the
 * interface grows with the map; the 1x floor keeps icons readable and buttons hittable while the map
 * is zoomed out; the bar is the widest part, so its width against the window is the ceiling.
 *
 * THE ORDER OF THE TWO BOUNDS IS THE POINT. A window narrower than the bar's 352 px is a phone, not
 * an edge case, and there the floor and the ceiling contradict each other. Letting the floor win
 * means the bar sticks out of a window with `overflow: hidden` — its outer buttons are then not
 * merely small but unreachable. So the ceiling wins and the bar is fitted instead: below 1x its
 * pixels are resampled, which costs sharpness, while the alternative costs the buttons.
 */
export function uiScaleFor(zoom: number, viewportW: number): number {
  return Math.min(viewportW / CONTROL_PANEL_BOUNDS.width, Math.max(1, zoom));
}

/**
 * Rectangle of a part in canvas pixels.
 *
 * The horizontal anchor is the CENTRE of the part, not its left edge: only then does the offset
 * from the screen centre stay exact at any window width.
 */
export function originBoxRect(
  b: OriginBounds,
  uiScale: number,
  viewportW: number,
  viewportH: number,
): BoxRect {
  const w = Math.round(b.width * uiScale);
  const h = Math.round(b.height * uiScale);
  const dx = Math.round((b.x + b.width / 2 - UI_SCREEN.width / 2) * uiScale);
  const bottom = Math.round((UI_SCREEN.height - (b.y + b.height)) * uiScale);
  return {
    x: Math.round(viewportW / 2 + dx - w / 2),
    y: viewportH - bottom - h,
    w,
    h,
  };
}

/**
 * Client coordinates to a pixel of the part's own surface, or `null` outside it.
 *
 * `hostRect` is the visible canvas as the browser lays it out, `hostW`/`hostH` its backing store —
 * the two differ as soon as CSS scales the canvas, and a hit test that ignores that is off by that
 * factor.
 */
export function boxPixel(
  clientX: number,
  clientY: number,
  hostRect: { left: number; top: number; width: number; height: number },
  hostW: number,
  hostH: number,
  box: BoxRect,
  srcW: number,
  srcH: number,
): { x: number; y: number } | null {
  if (hostRect.width <= 0 || hostRect.height <= 0 || box.w <= 0 || box.h <= 0) return null;
  const cx = (clientX - hostRect.left) * (hostW / hostRect.width);
  const cy = (clientY - hostRect.top) * (hostH / hostRect.height);
  const rx = cx - box.x;
  const ry = cy - box.y;
  if (rx < 0 || ry < 0 || rx >= box.w || ry >= box.h) return null;
  return {
    x: Math.min(srcW - 1, Math.floor((rx * srcW) / box.w)),
    y: Math.min(srcH - 1, Math.floor((ry * srcH) / box.h)),
  };
}
