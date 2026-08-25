import { describe, expect, it } from 'vitest';
import { WHEEL_STEP, fitScale, wheelDeltaPixels, wheelZoomFactor } from './zoom-gesture.js';

const ev = (deltaY: number, ctrlKey = false, deltaMode = 0) => ({ deltaY, ctrlKey, deltaMode });

describe('wheelZoomFactor', () => {
  it('yields exactly the previous step per wheel notch', () => {
    expect(wheelZoomFactor(ev(-100))).toBeCloseTo(WHEEL_STEP, 10);
    expect(wheelZoomFactor(ev(100))).toBeCloseTo(1 / WHEEL_STEP, 10);
  });

  it('composes: many small deltas == one large one', () => {
    const once = wheelZoomFactor(ev(-60));
    let stepwise = 1;
    for (let i = 0; i < 20; i += 1) stepwise *= wheelZoomFactor(ev(-3));
    expect(stepwise).toBeCloseTo(once, 10);

    const pinchOnce = wheelZoomFactor(ev(-30, true));
    let pinchStepwise = 1;
    for (let i = 0; i < 10; i += 1) pinchStepwise *= wheelZoomFactor(ev(-3, true));
    expect(pinchStepwise).toBeCloseTo(pinchOnce, 10);
  });

  it('reacts far more sensitively to a pinch than to the wheel', () => {
    expect(wheelZoomFactor(ev(-3, true))).toBeGreaterThan(wheelZoomFactor(ev(-3)));
    // A touchpad pinch of ~50 px total travel should zoom noticeably, not by 3 %.
    expect(wheelZoomFactor(ev(-50, true))).toBeGreaterThan(1.6);
    expect(wheelZoomFactor(ev(-50))).toBeLessThan(1.1);
  });

  it('converts lines and pages into pixels', () => {
    expect(wheelDeltaPixels(ev(-3, false, 1))).toBe(-120);
    expect(wheelDeltaPixels(ev(-1, false, 2))).toBe(-400);
    expect(wheelZoomFactor(ev(-3, false, 1))).toBeCloseTo(WHEEL_STEP ** 1.2, 10);
  });

  it('caps single outliers', () => {
    expect(wheelZoomFactor(ev(-5000, true))).toBe(4);
    expect(wheelZoomFactor(ev(5000, true))).toBe(0.25);
  });

  it('does nothing on a zero delta', () => {
    expect(wheelZoomFactor(ev(0))).toBe(1);
    expect(wheelZoomFactor(ev(-0, true))).toBe(1);
  });
});

describe('fitScale', () => {
  const surface = { width: 352, height: 240 };

  it('leaves the requested value alone while it fits', () => {
    expect(fitScale(3, { width: 1200, height: 800 }, surface)).toBe(3);
  });

  it('clips to the tighter of the two directions', () => {
    // Width allows 4x, height only 2x.
    expect(fitScale(8, { width: 1408, height: 480 }, surface)).toBe(2);
    expect(fitScale(8, { width: 704, height: 1200 }, surface)).toBe(2);
  });

  it('goes below 1 when the surface is smaller than the content', () => {
    expect(fitScale(3, { width: 176, height: 240 }, surface)).toBe(0.5);
  });

  it('clips nothing while nothing has been measured', () => {
    expect(fitScale(3, { width: 0, height: 0 }, surface)).toBe(3);
    expect(fitScale(3, { width: 0, height: 240 }, surface)).toBe(1);
  });
});
