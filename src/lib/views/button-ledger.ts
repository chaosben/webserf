/**
 * **What a mouse really delivers.** A pointer fires `pointerdown` only for the FIRST button that
 * goes down and `pointerup` only when the LAST one comes up — and that single `pointerup` names the
 * button released last. Every press and release in between arrives as a `pointermove` carrying a
 * changed `buttons` mask and nothing else.
 *
 * Two consequences a per-button handler cannot see, and both of them decide behaviour:
 * - the special click (right button held, left pressed) produces no `pointerdown` for its left
 *   press, so nothing in the press handlers knows it happened;
 * - the right button coming up is invisible whenever the left one outlives it, so a push-scroll
 *   started by it would keep running and the held-right flag would stay standing.
 *
 * Hence this ledger. It turns two masks into the transitions the handlers need, and it is pure so a
 * whole gesture can be replayed without a browser.
 */

/** `PointerEvent.buttons` bits. */
export const BUTTON_LEFT = 1;
export const BUTTON_RIGHT = 2;
export const BUTTON_MIDDLE = 4;

export interface ButtonTransition {
	readonly rightPressed: boolean;
	/**
	 * The left button went down **on top of** another one. The left button as the first one down is
	 * deliberately not reported: that one arrives as a `pointerdown` and stays a click candidate,
	 * which a drag past the threshold may still discard.
	 */
	readonly leftPressedWhileHeld: boolean;
	readonly rightReleased: boolean;
	readonly middleReleased: boolean;
}

export function buttonTransition(before: number, now: number): ButtonTransition {
	const added = now & ~before;
	const removed = before & ~now;
	return {
		rightPressed: (added & BUTTON_RIGHT) !== 0,
		leftPressedWhileHeld: (added & BUTTON_LEFT) !== 0 && before !== 0,
		rightReleased: (removed & BUTTON_RIGHT) !== 0,
		middleReleased: (removed & BUTTON_MIDDLE) !== 0,
	};
}
