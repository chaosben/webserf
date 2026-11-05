import { describe, it, expect } from 'vitest';
import { CORNER_INSET_PX, cornerBottom } from './overlay-place.js';

// A 1000×600 window with a bar 352×40 centred at the bottom.
const W = 1000;
const H = 600;
const BAR = { x: 324, y: 560, w: 352 };
const LIFTED = H - BAR.y + CORNER_INSET_PX;

describe('bottom corners and the control bar', () => {
  it('stay in the corner while they end left of the bar', () => {
    expect(cornerBottom('bl', 300, BAR, W, H)).toBe(CORNER_INSET_PX);
  });

  it('move above the bar once they reach into it', () => {
    expect(cornerBottom('bl', 320, BAR, W, H)).toBe(LIFTED);
    expect(cornerBottom('br', 320, BAR, W, H)).toBe(LIFTED);
  });

  it('stay in the corner while they end right of the bar', () => {
    expect(cornerBottom('br', 300, BAR, W, H)).toBe(CORNER_INSET_PX);
  });

  it('touching the bar edge exactly is not an overlap', () => {
    expect(cornerBottom('bl', BAR.x - CORNER_INSET_PX, BAR, W, H)).toBe(CORNER_INSET_PX);
    expect(cornerBottom('bl', BAR.x - CORNER_INSET_PX + 1, BAR, W, H)).toBe(LIFTED);
    const rightGap = W - (BAR.x + BAR.w) - CORNER_INSET_PX;
    expect(cornerBottom('br', rightGap, BAR, W, H)).toBe(CORNER_INSET_PX);
    expect(cornerBottom('br', rightGap + 1, BAR, W, H)).toBe(LIFTED);
  });

  it('ignore the bar while none is drawn, and an empty column', () => {
    expect(cornerBottom('bl', 900, null, W, H)).toBe(CORNER_INSET_PX);
    expect(cornerBottom('br', 0, BAR, W, H)).toBe(CORNER_INSET_PX);
  });
});
