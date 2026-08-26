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
 * It follows the zoom so the interface grows with the map, but never below 1x (a bar at 0.5x would
 * be unreadable) and never wider than the window — the bar is the widest part, so it sets the upper
 * bound. When the window is narrower than the bar, the upper bound wins and the bar is clipped
 * rather than shrunk.
 */
export function uiScaleFor(zoom: number, viewportW: number): number {
  return Math.max(1, Math.min(zoom, viewportW / CONTROL_PANEL_BOUNDS.width));
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
