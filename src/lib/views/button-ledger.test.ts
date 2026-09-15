import { describe, expect, it } from 'vitest';
import { buttonTransition } from './button-ledger.js';

/**
 * The masks below are the ones a mouse really produces for a special click — right button held,
 * left button clicked — once for each order in which the two are let go. They are the sequence a
 * browser reports, not a model of it: `pointerdown` carries only the first change, `pointerup` only
 * the last, everything between them is a move.
 */
const LEFT_RELEASED_FIRST = [0, 2, 3, 2, 0] as const;
const RIGHT_RELEASED_FIRST = [0, 2, 3, 1, 0] as const;

function replay(masks: readonly number[]): {
	leftWhileHeld: number;
	rightPressed: number;
	rightReleased: number;
	middleReleased: number;
} {
	const n = { leftWhileHeld: 0, rightPressed: 0, rightReleased: 0, middleReleased: 0 };
	for (let i = 1; i < masks.length; i++) {
		const t = buttonTransition(masks[i - 1]!, masks[i]!);
		if (t.leftPressedWhileHeld) n.leftWhileHeld++;
		if (t.rightPressed) n.rightPressed++;
		if (t.rightReleased) n.rightReleased++;
		if (t.middleReleased) n.middleReleased++;
	}
	return n;
}

describe('the special click, whichever button is let go first', () => {
	it('sees the left press exactly once in both orders', () => {
		expect(replay(LEFT_RELEASED_FIRST).leftWhileHeld).toBe(1);
		expect(replay(RIGHT_RELEASED_FIRST).leftWhileHeld).toBe(1);
	});

	it('sees the right button go up exactly once in both orders', () => {
		// The half that keeps a push-scroll from running on: when the left button outlives the right
		// one, the only `pointerup` of the gesture names the LEFT button, so the release of the right
		// one is in the masks and nowhere else.
		expect(replay(LEFT_RELEASED_FIRST).rightReleased).toBe(1);
		expect(replay(RIGHT_RELEASED_FIRST).rightReleased).toBe(1);
	});

	it('reads both orders identically — that is the whole point', () => {
		expect(replay(LEFT_RELEASED_FIRST)).toEqual(replay(RIGHT_RELEASED_FIRST));
	});
});

describe('the ordinary gestures stay ordinary', () => {
	it('leaves a plain left click to the press handler', () => {
		// It arrives as a `pointerdown`, is a click candidate, and a drag past the threshold may still
		// discard it — reporting it here would answer it twice and defeat the threshold.
		expect(replay([0, 1, 0]).leftWhileHeld).toBe(0);
	});

	it('reports a plain right press and release', () => {
		expect(replay([0, 2, 0])).toMatchObject({ rightPressed: 1, rightReleased: 1 });
	});

	it('reports the middle button going up, whoever else is down', () => {
		expect(replay([0, 4, 5, 1, 0]).middleReleased).toBe(1);
	});

	it('says nothing when nothing changed', () => {
		expect(buttonTransition(3, 3)).toEqual({
			rightPressed: false,
			leftPressedWhileHeld: false,
			rightReleased: false,
			middleReleased: false,
		});
	});
});
