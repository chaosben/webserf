import { describe, expect, it } from 'vitest';
import {
	PINCH_MIN_DIST,
	anchorCamera,
	fitScale,
	pinchZoom,
	scenePoint,
	deviceOfStage,
	snapZoom,
	stageOfZoom,
	stageZoomAtOrBelow,
	stepZoomStage,
	wheelStageSteps,
	zoomOfStage,
	wheelDeltaPixels,
} from './zoom-gesture.js';

const ev = (deltaY: number, ctrlKey = false, deltaMode = 0) => ({ deltaY, ctrlKey, deltaMode });

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
	// Reference expression of the anchoring. The test pins the expression TREE, not just the value:
	// `Math.round(cam + p * (1 / zoom - 1 / next))` is the same in algebra and not in floating point,
	// so a "simplification" has to fail here rather than in a screenshot.
	const reference = (cam: number, zoom: number, next: number, p: number) => {
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
			expect(anchorCamera(scenePoint(cam, zoom, p), next, p)).toBe(reference(cam, zoom, next, p));
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

	it('is the direct ratio of the finger distances', () => {
		expect(pinchZoom(1, BIG, 1.5 * BIG, 0.1, 8)).toBe(1.5);
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

describe('zoom stages', () => {
  const DPRS = [1, 1.25, 1.5, 2, 3];
  /** A stage's device factor is a quarter power of two below 1, a whole or half number above. */
  const isStage = (z: number, dpr: number) => {
    const d = z * dpr;
    const whole = (x: number) => Math.abs(x - Math.round(x)) < 1e-9;
    if (d < 1 - 1e-9) return whole(4 * Math.log2(d));
    return whole(2 * d);
  };

  it('maps stages to device factors and back', () => {
    const expected = [0.5, 2 ** -0.5, 2 ** -0.25, 1, 1.5, 2, 2.5, 3, 8];
    [-4, -2, -1, 0, 1, 2, 3, 4, 14].forEach((s, i) => expect(deviceOfStage(s)).toBeCloseTo(expected[i], 12));
    for (const dpr of DPRS) {
      for (let s = -12; s <= 14; s += 1) expect(stageOfZoom(zoomOfStage(s, dpr), dpr)).toBe(s);
    }
  });

  it('rounds by ratio, not by difference', () => {
    // 1.23 is nearer to 1 by difference, but 1.5/1.23 < 1.23/1.
    expect(deviceOfStage(stageOfZoom(1.23, 1))).toBe(1.5);
    expect(deviceOfStage(stageOfZoom(1.22, 1))).toBe(1);
    expect(deviceOfStage(stageOfZoom(1.74, 1))).toBe(2);
    expect(deviceOfStage(stageOfZoom(2.7, 1))).toBe(2.5);
    expect(deviceOfStage(stageOfZoom(0.4, 1))).toBeCloseTo(2 ** -1.25, 12);
  });

  it('only ever yields stages, inside the bounds', () => {
    for (const dpr of DPRS) {
      for (let z = 0.1; z < 9; z += 0.037) {
        const s = snapZoom(z, dpr, 0.3, 8);
        expect(isStage(s, dpr)).toBe(true);
        expect(s).toBeLessThanOrEqual(8 + 1e-9);
      }
    }
  });

  it('keeps the whole world reachable: the lowest stage is at or below the bound', () => {
    for (const dpr of DPRS) {
      for (const min of [0.17, 0.3, 0.5, 0.71, 1]) {
        const lowest = snapZoom(0.01, dpr, min, 8);
        expect(lowest).toBeLessThanOrEqual(min + 1e-9);
        expect(stepZoomStage(lowest, 1, dpr, min, 8)).toBeGreaterThan(min - 1e-9);
      }
    }
  });

  it('steps one stage at a time and stops at the bounds', () => {
    expect(stepZoomStage(3, 1, 1, 0.5, 8)).toBe(3.5);
    expect(stepZoomStage(3.5, 1, 1, 0.5, 8)).toBe(4);
    expect(stepZoomStage(3, -2, 1, 0.5, 8)).toBe(2);
    expect(stepZoomStage(2, -1, 1, 0.5, 8)).toBe(1.5);
    expect(stepZoomStage(1.5, -1, 1, 0.5, 8)).toBe(1);
    expect(stepZoomStage(1, -1, 1, 0.5, 8)).toBeCloseTo(2 ** -0.25, 12);
    expect(stepZoomStage(1, -4, 1, 0.5, 8)).toBeCloseTo(0.5, 12);
    expect(stepZoomStage(0.5, -1, 1, 0.5, 8)).toBeCloseTo(0.5, 12);
    expect(stepZoomStage(8, 1, 1, 0.5, 8)).toBe(8);
    // At 150 %: one stage further is one device pixel more, not one CSS pixel.
    expect(stepZoomStage(2, 1, 1.5, 0.5, 8) * 1.5).toBeCloseTo(3.5, 9);
  });

  it('rounds a fitting scale down, never up', () => {
    expect(stageZoomAtOrBelow(2.9, 1)).toBe(2.5);
    expect(stageZoomAtOrBelow(3, 1)).toBe(3);
    expect(stageZoomAtOrBelow(1.9, 1)).toBe(1.5);
    expect(stageZoomAtOrBelow(0.9, 1)).toBeCloseTo(2 ** -0.25, 12);
    expect(stageZoomAtOrBelow(2.2, 1.25) * 1.25).toBeCloseTo(2.5, 9);
  });
});

describe('wheelStageSteps', () => {
  it('converts lines and pages into pixels', () => {
    expect(wheelDeltaPixels(ev(-3, false, 1))).toBe(-120);
    expect(wheelDeltaPixels(ev(-1, false, 2))).toBe(-400);
  });

  it('turns one wheel notch into exactly one stage', () => {
    expect(wheelStageSteps(0, ev(-100))).toEqual({ steps: 1, rest: 0 });
    expect(wheelStageSteps(0, ev(100))).toEqual({ steps: -1, rest: 0 });
    expect(wheelStageSteps(0, ev(-3, false, 1)).steps).toBe(1);
  });

  it('sums small touchpad deltas until a stage is full', () => {
    let rest = 0;
    let steps = 0;
    for (let i = 0; i < 9; i += 1) {
      const r = wheelStageSteps(rest, ev(-10));
      rest = r.rest;
      steps += r.steps;
    }
    expect(steps).toBe(0);
    const r = wheelStageSteps(rest, ev(-10));
    expect(r.steps).toBe(1);
  });

  it('drops the remainder on a change of direction', () => {
    const half = wheelStageSteps(0, ev(-50));
    expect(half.steps).toBe(0);
    const back = wheelStageSteps(half.rest, ev(50));
    expect(back.rest).toBeLessThan(0);
    expect(back.rest).toBeCloseTo(-0.5, 9);
  });

  it('pinches faster than it scrolls', () => {
    expect(wheelStageSteps(0, ev(-30, true)).steps).toBe(1);
  });
});

describe('the map writes only stages', () => {
  it('has no continuous writer of `zoom` left', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['MapView.svelte', 'MainMenuView.svelte']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/^\s*zoom = (.+)$/gm)) {
        expect(m[1], `${file}: zoom = ${m[1]}`).toMatch(/^(snapZoom|stepZoomStage|next;)/);
      }
    }
  });
});
