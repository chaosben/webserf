import { describe, expect, it } from 'vitest';
import {
	PINCH_MIN_DIST,
	WHEEL_STEP,
	anchorCamera,
	fitScale,
	pinchZoom,
	scenePoint,
	wheelDeltaPixels,
	wheelZoomFactor,
} from './zoom-gesture.js';

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

describe('scenePoint / anchorCamera', () => {
	// The wheel handler used to carry this expression itself. The test pins the expression TREE, not
	// just the value: `Math.round(cam + p * (1 / zoom - 1 / next))` is the same in algebra and not in
	// floating point, so a later "simplification" has to fail here rather than in a screenshot.
	const old = (cam: number, zoom: number, next: number, p: number) => {
		const scene = cam + p / zoom;
		return Math.round(scene - p / next);
	};
	const cases: ReadonlyArray<[number, number, number, number]> = [
		[0, 3, 3 * 1.15, 400],
		[-137, 1 / 3, 0.29, 913],
		[512, 2.5, 1.25, 0],
		[1, 2, 1, 1], // lands exactly on .5
		[0, 1, 0.8, 1], // rounds to -0
		[123456, 7.75, 8, 601],
	];

	it('reproduces the wheel arithmetic bit for bit', () => {
		for (const [cam, zoom, next, p] of cases) {
			// `toBe` is Object.is, so a -0 that turned into 0 counts as a failure.
			expect(anchorCamera(scenePoint(cam, zoom, p), next, p)).toBe(old(cam, zoom, next, p));
		}
	});

	it('leaves the camera where it was when the zoom does not change', () => {
		for (const [cam, zoom, , p] of cases) {
			expect(anchorCamera(scenePoint(cam, zoom, p), zoom, p)).toBe(Math.round(cam));
		}
	});

	it('keeps the grabbed scene point under the anchor, up to the rounding', () => {
		let cam = 250;
		let zoom = 1.5;
		for (let i = 0; i < 200; i += 1) {
			const p = ((i * 37) % 900) + 3;
			const next = 0.2 + ((i * 13) % 70) / 10;
			const scene = scenePoint(cam, zoom, p);
			cam = anchorCamera(scene, next, p);
			zoom = next;
			expect(Math.abs(scenePoint(cam, zoom, p) - scene)).toBeLessThanOrEqual(0.5);
		}
	});
});

describe('pinchZoom', () => {
	const BIG = 200;

	it('is the plain ratio of the finger distances', () => {
		expect(pinchZoom(3, BIG, BIG, 0.1, 8)).toBe(3);
		expect(pinchZoom(3, BIG, 2 * BIG, 0.1, 8)).toBe(6);
		expect(pinchZoom(3, BIG, BIG / 2, 0.1, 8)).toBe(1.5);
	});

	it('is symmetric: out and back is the value it started from', () => {
		expect(pinchZoom(pinchZoom(3, BIG, 2 * BIG, 0.1, 8), 2 * BIG, BIG, 0.1, 8)).toBeCloseTo(3, 12);
	});

	it('clamps at both ends', () => {
		expect(pinchZoom(3, BIG, 100 * BIG, 0.1, 8)).toBe(8);
		// The floor lifts a 1 px distance to PINCH_MIN_DIST, so the ratio is 0.24 — the clamp has to
		// bind above that to be tested at all.
		expect(pinchZoom(3, BIG, 1, 0.5, 8)).toBe(0.5);
	});

	it('survives two fingers on the same spot', () => {
		expect(pinchZoom(3, 0, 0, 0.1, 8)).toBe(3);
		expect(Number.isFinite(pinchZoom(3, 0, BIG, 0.1, 8))).toBe(true);
	});

	it('floors the baseline instead of exploding — and stays the identity while doing so', () => {
		// Without the floor a 2 px baseline would multiply by a hundred over a normal spread.
		expect(pinchZoom(1, 2, 2, 0.1, 1000)).toBe(1);
		expect(pinchZoom(1, 2, BIG, 0.1, 1000)).toBe(BIG / PINCH_MIN_DIST);
	});

	it('is NOT the wheel curve — that is the documented difference', () => {
		expect(pinchZoom(1, BIG, 1.5 * BIG, 0.1, 8)).toBe(1.5);
		expect(wheelZoomFactor({ deltaY: -100, ctrlKey: true, deltaMode: 0 })).not.toBeCloseTo(1.5, 2);
	});

	it('takes the DRAWN scale as its base, so a surface-limited zoom does not run up', () => {
		const surface = { width: 352, height: 240 };
		// Wish 8x, but the surface only allows 2x.
		const drawn = fitScale(8, { width: 704, height: 1200 }, surface);
		expect(drawn).toBe(2);
		expect(pinchZoom(drawn, BIG, BIG / 2, 1, 8)).toBe(1);
	});
});

describe('pinch camera', () => {
	const scene = { x: 300, y: 120 };

	it('does not slide while the zoom is clamped and the midpoint stands still', () => {
		const first = anchorCamera(scene.x, 8, 400);
		for (const dist of [500, 900, 4000]) {
			const next = pinchZoom(8, 200, dist, 0.5, 8);
			expect(next).toBe(8);
			expect(anchorCamera(scene.x, next, 400)).toBe(first);
		}
	});

	it('follows the fingers 1:1 while the zoom is clamped', () => {
		const next = pinchZoom(8, 200, 4000, 0.5, 8);
		expect(anchorCamera(scene.x, next, 400 + 16) - anchorCamera(scene.x, next, 400)).toBe(-16 / next);
	});

	it('returns to the exact start on a round trip', () => {
		const startZoom = 3;
		const startDist = 210;
		const mid = { x: 411, y: 233 };
		const cam0 = { x: 700, y: 400 };
		const grabbed = { x: scenePoint(cam0.x, startZoom, mid.x), y: scenePoint(cam0.y, startZoom, mid.y) };
		let zoom = startZoom;
		let cam = cam0;
		for (const [dist, m] of [
			[600, { x: 300, y: 100 }],
			[90, { x: 800, y: 600 }],
			[startDist, mid],
		] as ReadonlyArray<[number, { x: number; y: number }]>) {
			zoom = pinchZoom(startZoom, startDist, dist, 0.5, 8);
			cam = { x: anchorCamera(grabbed.x, zoom, m.x), y: anchorCamera(grabbed.y, zoom, m.y) };
		}
		expect(zoom).toBe(startZoom);
		expect(cam).toEqual({ x: Math.round(cam0.x), y: Math.round(cam0.y) });
	});
});
