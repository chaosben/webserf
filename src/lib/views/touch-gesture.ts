/**
 * The touch phases of a pointer surface: two-finger pinch, long press, and the "spent" tail that
 * swallows what a multi-finger gesture leaves behind.
 *
 * **A reducer and not a class**, on purpose: the state lives in a plain `let` of a component, and
 * this shape makes it visible at the call site that it is not reactive — a field of a class instance
 * invites a later `$state`, which would then re-render at pointer-move rate.
 *
 * **Time and thresholds come in as parameters.** That is what makes the long press decidable without
 * a timer in the test: the caller keeps one `setTimeout` which merely asks {@link touchTick} whether
 * the press is due. A press cancelled by travel or by a second finger therefore needs no
 * bookkeeping at all — the tick answers `null`.
 *
 * **Coordinates are unit-agnostic.** Distance and midpoint *deltas* are invariant against a
 * translation, so client or element pixels both work; only an absolute midpoint used as a zoom
 * anchor has to be in the coordinates of the surface it anchors.
 */

/** A tracked finger. */
export interface TouchPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/**
 * - `none` — nothing special; a single finger behaves like the left button (tap, drag).
 * - `hold` — one finger down and not yet moved: candidate for the long press.
 * - `pinch` — two fingers tracked; the surface zooms and pans, nothing else.
 * - `spent` — a gesture has happened. Until the next **fresh** press nothing pans and no click
 *   counts. It deliberately survives the last finger lifting: the browser delivers a `click` after
 *   that, and it must not act.
 */
export type TouchPhase = 'none' | 'hold' | 'pinch' | 'spent';

export interface TouchState {
  readonly phase: TouchPhase;
  /** The tracked fingers in arrival order, at most two. */
  readonly points: readonly TouchPoint[];
  /** How many fingers are down — untracked extras included, so `spent` knows when to let go. */
  readonly down: number;
  /** Press point and time of the single finger while the phase is `hold`. */
  readonly holdX: number;
  readonly holdY: number;
  readonly holdAt: number;
}

export type TouchOutcome =
  /** A single finger went down: the caller may arm its timer. */
  | { readonly kind: 'holdArmed' }
  /** The press became due. Where it happened is the caller's own business (see the module head). */
  | { readonly kind: 'hold' }
  | { readonly kind: 'pinchStart'; readonly dist: number; readonly midX: number; readonly midY: number }
  | { readonly kind: 'pinch'; readonly dist: number; readonly midX: number; readonly midY: number }
  /** A pinch ended. The phase stays `spent` until a fresh press. */
  | { readonly kind: 'ended' }
  | null;

export interface TouchResult {
  readonly state: TouchState;
  readonly outcome: TouchOutcome;
}

/** The long press of the system, in milliseconds. The original knows no holding at all. */
export const TOUCH_HOLD_MS = 500;

export const TOUCH_IDLE: TouchState = {
  phase: 'none',
  points: [],
  down: 0,
  holdX: 0,
  holdY: 0,
  holdAt: 0,
};

function geometry(points: readonly TouchPoint[]): { dist: number; midX: number; midY: number } {
  const [a, b] = points as readonly [TouchPoint, TouchPoint];
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
  };
}

export function touchDown(state: TouchState, id: number, x: number, y: number, now: number): TouchResult {
  // A spent gesture holds on until every finger is up — a finger arriving meanwhile stays ignored,
  // otherwise a long press followed by a second finger would start zooming out of the blue.
  if (state.phase === 'spent' && state.down > 0) {
    return { state: { ...state, down: state.down + 1 }, outcome: null };
  }
  const base = state.phase === 'spent' ? TOUCH_IDLE : state;
  if (base.points.length === 0) {
    return {
      state: { phase: 'hold', points: [{ id, x, y }], down: base.down + 1, holdX: x, holdY: y, holdAt: now },
      outcome: { kind: 'holdArmed' },
    };
  }
  if (base.points.length === 1) {
    const points = [base.points[0] as TouchPoint, { id, x, y }] as const;
    const g = geometry(points);
    return {
      state: { ...base, phase: 'pinch', points, down: base.down + 1 },
      outcome: { kind: 'pinchStart', ...g },
    };
  }
  // A third finger changes nothing: re-picking the pair would move the baseline and make the map leap.
  return { state: { ...base, down: base.down + 1 }, outcome: null };
}

export function touchMove(
  state: TouchState,
  id: number,
  x: number,
  y: number,
  moveThreshold: number,
): TouchResult {
  const i = state.points.findIndex((p) => p.id === id);
  if (i < 0) return { state, outcome: null };
  const points = state.points.map((p, k) => (k === i ? { id, x, y } : p));
  if (state.phase === 'hold') {
    const moved = Math.hypot(x - state.holdX, y - state.holdY) >= moveThreshold;
    return { state: { ...state, phase: moved ? 'none' : 'hold', points }, outcome: null };
  }
  if (state.phase === 'pinch') {
    return { state: { ...state, points }, outcome: { kind: 'pinch', ...geometry(points) } };
  }
  return { state: { ...state, points }, outcome: null };
}

/**
 * Also the answer for `pointercancel` — up and cancel differ only in what the *caller* does with a
 * pointer capture, not in the phase.
 */
export function touchUp(state: TouchState, id: number): TouchResult {
  const down = Math.max(0, state.down - 1);
  const i = state.points.findIndex((p) => p.id === id);
  if (i < 0) return { state: { ...state, down }, outcome: null };
  const points = state.points.filter((p) => p.id !== id);
  if (state.phase === 'pinch') {
    return { state: { ...state, phase: 'spent', points, down }, outcome: { kind: 'ended' } };
  }
  // A plain tap: the phase falls back so the click that follows counts.
  const phase: TouchPhase = state.phase === 'spent' ? 'spent' : 'none';
  return { state: { ...state, phase, points, down }, outcome: null };
}

export function touchTick(state: TouchState, now: number, holdMs: number): TouchResult {
  if (state.phase !== 'hold' || state.down !== 1) return { state, outcome: null };
  if (now - state.holdAt < holdMs) return { state, outcome: null };
  return { state: { ...state, phase: 'spent' }, outcome: { kind: 'hold' } };
}
