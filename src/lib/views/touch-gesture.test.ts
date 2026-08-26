import { describe, expect, it } from 'vitest';
import {
	TOUCH_HOLD_MS,
	TOUCH_IDLE,
	type TouchState,
	touchDown,
	touchMove,
	touchTick,
	touchUp,
} from './touch-gesture.js';

const THRESHOLD = 5;

/** Two fingers down at the given points; returns the state and the start geometry. */
function pinchOf(a: [number, number], b: [number, number]) {
	const first = touchDown(TOUCH_IDLE, 1, a[0], a[1], 0);
	const second = touchDown(first.state, 2, b[0], b[1], 0);
	return second;
}

describe('touchDown', () => {
	it('arms the long press on the first finger and starts no pinch', () => {
		const r = touchDown(TOUCH_IDLE, 1, 10, 20, 1000);
		expect(r.outcome).toEqual({ kind: 'holdArmed' });
		expect(r.state.phase).toBe('hold');
		expect(r.state.down).toBe(1);
	});

	it('starts the pinch on the second finger, with distance and midpoint', () => {
		const r = pinchOf([100, 100], [100, 200]);
		expect(r.state.phase).toBe('pinch');
		expect(r.outcome).toEqual({ kind: 'pinchStart', dist: 100, midX: 100, midY: 150 });
	});

	it('ignores a third finger — re-picking the pair would make the map leap', () => {
		const two = pinchOf([100, 100], [100, 200]);
		const three = touchDown(two.state, 3, 900, 900, 0);
		expect(three.outcome).toBeNull();
		expect(three.state.points.map((p) => p.id)).toEqual([1, 2]);
		expect(three.state.down).toBe(3);
		// And its move does not disturb the geometry either.
		const moved = touchMove(three.state, 3, 950, 950, THRESHOLD);
		expect(moved.outcome).toBeNull();
	});
});

describe('touchMove', () => {
	it('reports distance and midpoint while pinching', () => {
		const two = pinchOf([100, 100], [100, 200]);
		const m = touchMove(two.state, 2, 100, 300, THRESHOLD);
		expect(m.outcome).toEqual({ kind: 'pinch', dist: 200, midX: 100, midY: 200 });
	});

	it('is invariant against a translation of both fingers', () => {
		const a = pinchOf([100, 100], [100, 200]);
		const b = pinchOf([700, 480], [700, 580]);
		expect(a.outcome).toEqual({ kind: 'pinchStart', dist: 100, midX: 100, midY: 150 });
		expect(b.outcome).toEqual({ kind: 'pinchStart', dist: 100, midX: 700, midY: 530 });
	});

	it('ignores an unknown or already released id', () => {
		const two = pinchOf([100, 100], [100, 200]);
		expect(touchMove(two.state, 9, 0, 0, THRESHOLD).outcome).toBeNull();
		const up = touchUp(two.state, 2);
		expect(touchMove(up.state, 2, 500, 500, THRESHOLD).outcome).toBeNull();
	});

	it('drops the long press once the finger travels', () => {
		const one = touchDown(TOUCH_IDLE, 1, 100, 100, 0);
		const still = touchMove(one.state, 1, 102, 103, THRESHOLD);
		expect(still.state.phase).toBe('hold');
		const moved = touchMove(still.state, 1, 100, 120, THRESHOLD);
		expect(moved.state.phase).toBe('none');
		expect(touchTick(moved.state, TOUCH_HOLD_MS * 10, TOUCH_HOLD_MS).outcome).toBeNull();
	});
});

describe('touchTick', () => {
	it('becomes due after the hold time and not before', () => {
		const one = touchDown(TOUCH_IDLE, 1, 100, 100, 1000);
		expect(touchTick(one.state, 1000 + TOUCH_HOLD_MS - 1, TOUCH_HOLD_MS).outcome).toBeNull();
		const due = touchTick(one.state, 1000 + TOUCH_HOLD_MS, TOUCH_HOLD_MS);
		expect(due.outcome).toEqual({ kind: 'hold' });
		expect(due.state.phase).toBe('spent');
	});

	it('never fires once a second finger has arrived', () => {
		const two = pinchOf([100, 100], [100, 200]);
		expect(touchTick(two.state, 1e9, TOUCH_HOLD_MS).outcome).toBeNull();
	});

	it('after firing there is neither a pan nor a click', () => {
		const one = touchDown(TOUCH_IDLE, 1, 100, 100, 0);
		const fired = touchTick(one.state, TOUCH_HOLD_MS, TOUCH_HOLD_MS).state;
		expect(touchMove(fired, 1, 400, 400, THRESHOLD).outcome).toBeNull();
		const up = touchUp(fired, 1);
		expect(up.outcome).toBeNull();
		expect(up.state.phase).toBe('spent');
	});
});

describe('touchUp', () => {
	it('ends the pinch on the first finger that leaves', () => {
		const two = pinchOf([100, 100], [100, 200]);
		const up = touchUp(two.state, 1);
		expect(up.outcome).toEqual({ kind: 'ended' });
		expect(up.state.phase).toBe('spent');
		// The remaining finger neither pans nor starts anything of its own.
		expect(touchMove(up.state, 2, 100, 900, THRESHOLD).outcome).toBeNull();
	});

	it('lets a plain tap through', () => {
		const one = touchDown(TOUCH_IDLE, 1, 100, 100, 0);
		const up = touchUp(one.state, 1);
		expect(up.state.phase).toBe('none');
		expect(up.state.down).toBe(0);
	});

	it('stays spent after the last finger — the click of the browser comes afterwards', () => {
		const two = pinchOf([100, 100], [100, 200]);
		const first = touchUp(two.state, 1);
		const last = touchUp(first.state, 2);
		expect(last.state.down).toBe(0);
		expect(last.state.phase).toBe('spent');
	});

	it('a fresh press clears the spent phase and takes a new baseline', () => {
		const two = pinchOf([100, 100], [100, 200]);
		let s: TouchState = touchUp(touchUp(two.state, 1).state, 2).state;
		const again = touchDown(s, 7, 500, 500, 5000);
		expect(again.outcome).toEqual({ kind: 'holdArmed' });
		expect(again.state.phase).toBe('hold');
		expect(again.state.down).toBe(1);
		s = touchDown(again.state, 8, 500, 700, 5000).state;
		expect(touchMove(s, 8, 500, 800, THRESHOLD).outcome).toEqual({
			kind: 'pinch',
			dist: 300,
			midX: 500,
			midY: 650,
		});
	});

	it('does not start a pinch out of a spent gesture whose finger is still down', () => {
		const one = touchDown(TOUCH_IDLE, 1, 100, 100, 0);
		const fired = touchTick(one.state, TOUCH_HOLD_MS, TOUCH_HOLD_MS).state;
		const second = touchDown(fired, 2, 300, 300, TOUCH_HOLD_MS + 10);
		expect(second.outcome).toBeNull();
		expect(second.state.phase).toBe('spent');
	});
});
