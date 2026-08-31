import { describe, expect, it } from 'vitest';
import { CONTROL_PANEL_BOUNDS, POPUP_BOUNDS, UI_SCREEN } from '../core/ui-render.js';
import { boxPixel, originBoxRect, uiScaleFor, type BoxRect } from './ui-layout.js';

/**
 * The arrangement as a CSS string — `left: calc(50% + Npx)` on a box shifted by `translateX(-50%)`,
 * plus `bottom`. That formula is the SPECIFICATION {@link originBoxRect} is pinned against, so the
 * numbers can be shown to place the box exactly where the browser would.
 */
function cssArrangementRect(
  b: { x: number; y: number; width: number; height: number },
  s: number,
  vw: number,
  vh: number,
): { left: number; top: number; w: number; h: number } {
  const dx = Math.round((b.x + b.width / 2 - UI_SCREEN.width / 2) * s);
  const bottom = Math.round((UI_SCREEN.height - (b.y + b.height)) * s);
  const w = Math.round(b.width * s);
  const h = Math.round(b.height * s);
  return { left: vw / 2 + dx - w / 2, top: vh - bottom - h, w, h };
}

describe('uiScaleFor', () => {
  it('never drops below 1x, however far the map is zoomed out', () => {
    expect(uiScaleFor(0.08, 1600)).toBe(1);
    expect(uiScaleFor(1, 1600)).toBe(1);
  });

  it('follows the zoom in between', () => {
    expect(uiScaleFor(2.5, 1600)).toBeCloseTo(2.5, 10);
  });

  it('never exceeds the window width — the bar is the widest part', () => {
    // 500 px window: the 352 px bar fits 1.42 times, so that caps a zoom of 4.
    expect(uiScaleFor(4, 500)).toBeCloseTo(500 / CONTROL_PANEL_BOUNDS.width, 10);
  });

  it('lets the lower bound win when the window is narrower than the bar', () => {
    expect(uiScaleFor(4, 200)).toBe(1);
  });
});

describe('originBoxRect', () => {
  it('reproduces the original screen coordinates at 1x in a 640x480 window', () => {
    // The strongest statement available without a capture: with the window equal to the original
    // screen, the anchoring has to be the identity.
    expect(originBoxRect(POPUP_BOUNDS, 1, 640, 480)).toEqual({ x: 240, y: 261, w: 144, h: 160 });
    expect(originBoxRect(CONTROL_PANEL_BOUNDS, 1, 640, 480)).toEqual({
      x: 144,
      y: 440,
      w: 352,
      h: 40,
    });
  });

  it('keeps the parts in their original arrangement relative to each other', () => {
    const s = 3;
    const pop = originBoxRect(POPUP_BOUNDS, s, 1600, 900);
    const bar = originBoxRect(CONTROL_PANEL_BOUNDS, s, 1600, 900);
    // Popup centre 8 px left of the screen centre, popup bottom 19 px above the bar's top edge.
    expect(bar.x + bar.w / 2 - (pop.x + pop.w / 2)).toBeCloseTo(8 * s, 10);
    expect(bar.y - (pop.y + pop.h)).toBe(19 * s);
  });

  it('matches the layout the CSS formula produces, at every window size and scale', () => {
    for (const b of [POPUP_BOUNDS, CONTROL_PANEL_BOUNDS]) {
      for (const [vw, vh] of [
        [640, 480],
        [1600, 900],
        [1279, 733],
        [3801, 1991],
      ]) {
        for (const zoom of [0.08, 1, 1.5, 2, 2.75, 4]) {
          const s = uiScaleFor(zoom, vw);
          const css = cssArrangementRect(b, s, vw, vh);
          const now = originBoxRect(b, s, vw, vh);
          expect(now.w).toBe(css.w);
          expect(now.h).toBe(css.h);
          expect(now.y).toBe(css.top);
          // The only difference is the deliberate rounding of the left edge to a whole pixel.
          expect(Math.abs(now.x - css.left)).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it('is flush with the bottom of the window', () => {
    const bar = originBoxRect(CONTROL_PANEL_BOUNDS, 2, 1000, 700);
    expect(bar.y + bar.h).toBe(700);
  });
});

describe('boxPixel', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  const box: BoxRect = { x: 200, y: 300, w: 288, h: 320 }; // a 144x160 popup at 2x

  /** Client coordinates of a point given in canvas pixels (host laid out 1:1 here). */
  const at = (cx: number, cy: number): [number, number] => [rect.left + cx, rect.top + cy];

  it('maps all four corners of a popup onto the corners of its own surface', () => {
    expect(boxPixel(...at(200, 300), rect, 800, 600, box, 144, 160)).toEqual({ x: 0, y: 0 });
    expect(boxPixel(...at(487, 300), rect, 800, 600, box, 144, 160)).toEqual({ x: 143, y: 0 });
    expect(boxPixel(...at(200, 619), rect, 800, 600, box, 144, 160)).toEqual({ x: 0, y: 159 });
    expect(boxPixel(...at(487, 619), rect, 800, 600, box, 144, 160)).toEqual({ x: 143, y: 159 });
  });

  it('reports a miss outside the box on every side', () => {
    expect(boxPixel(...at(199, 400), rect, 800, 600, box, 144, 160)).toBeNull();
    expect(boxPixel(...at(488, 400), rect, 800, 600, box, 144, 160)).toBeNull();
    expect(boxPixel(...at(300, 299), rect, 800, 600, box, 144, 160)).toBeNull();
    expect(boxPixel(...at(300, 620), rect, 800, 600, box, 144, 160)).toBeNull();
  });

  it('takes a CSS-scaled canvas into account', () => {
    // Same backing store, laid out at half size: a client pixel is worth two canvas pixels.
    const half = { left: 0, top: 0, width: 400, height: 300 };
    expect(boxPixel(100, 150, half, 800, 600, box, 144, 160)).toEqual({ x: 0, y: 0 });
  });

  it('works for the bar as well', () => {
    const bar: BoxRect = { x: 10, y: 500, w: 352, h: 40 };
    expect(boxPixel(...at(10, 500), rect, 800, 600, bar, 352, 40)).toEqual({ x: 0, y: 0 });
    expect(boxPixel(...at(361, 539), rect, 800, 600, bar, 352, 40)).toEqual({ x: 351, y: 39 });
  });

  it('has nothing to say about a window that has not been laid out yet', () => {
    expect(boxPixel(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 800, 600, box, 144, 160)).toBeNull();
  });
});
