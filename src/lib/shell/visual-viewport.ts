/**
 * Keeping the shell inside the part of the window that is actually visible.
 *
 * `100dvh` and `width: 100%` measure the LAYOUT viewport. Two things routinely make the visible area
 * smaller than that without touching it: a pinch zoom (which `app.html` and `page-zoom.ts` head off,
 * except on engines where neither bites) and the on-screen keyboard. Whatever the cause, the shell
 * then reaches past the screen — and because it neither scrolls (`html, body { overflow: hidden }`)
 * nor lets the pinch through over the game view, the icon rail and the control bar are not merely
 * off-picture but unreachable until a reload.
 *
 * So the shell is laid on the visible rectangle instead. `position: fixed` without a transformed
 * ancestor is anchored to the LAYOUT viewport, and that is exactly what `offsetLeft`/`offsetTop`
 * count from — a translation by those puts it on the visible area.
 *
 * **It does not scale back.** At a zoom of 2 the shell is laid out in half as many CSS pixels and the
 * browser magnifies it; the map canvas, which is 1:1 with CSS pixels, loses resolution accordingly.
 * That is what "the user magnified it" honestly means. A counter-scale would take exactly that away
 * — and would break the hit test, which works today because `getBoundingClientRect()` and
 * `clientX/Y` share a coordinate system that a pure translation leaves alone.
 *
 * No runes, hence a plain module: there is no state anyone renders from, only one element written to.
 */

/** As much of a `VisualViewport` as this module reads. */
export interface ViewportReading {
  readonly width: number;
  readonly height: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
}

/** Where the shell goes, in whole CSS pixels. */
export interface ShellBox {
  readonly w: number;
  readonly h: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The reading as a box.
 *
 * Rounded to whole pixels, and that is not cosmetic: the browser's own figures are fractional and
 * wobble by half a pixel while a gesture settles, which would be a write per frame forever.
 */
export function shellBoxOf(r: ViewportReading): ShellBox {
  return {
    w: Math.round(r.width),
    h: Math.round(r.height),
    x: Math.round(r.offsetLeft),
    y: Math.round(r.offsetTop),
  };
}

export function sameBox(a: ShellBox | null, b: ShellBox): boolean {
  return a !== null && a.w === b.w && a.h === b.h && a.x === b.x && a.y === b.y;
}

/** The three things this module would otherwise take straight from the browser. */
export interface ViewportEnv {
  read(): ViewportReading;
  /** Every signal that can change the visible area, as one callback. Returns the teardown. */
  subscribe(listener: () => void): () => void;
  /** Coalescing to one write per frame. Returns the cancel. */
  schedule(run: () => void): () => void;
}

/**
 * Follow the visible area, writing each new box to `apply`. Returns the teardown, so it fits straight
 * into an `$effect`.
 *
 * Writes only on a CHANGE. Without that the element would be assigned the same three properties
 * every frame of a gesture, and a resize of the canvas hangs off those.
 */
export function followVisualViewport(
  apply: (box: ShellBox) => void,
  env: ViewportEnv,
): () => void {
  let last: ShellBox | null = null;
  let cancel: (() => void) | null = null;

  const settle = () => {
    cancel = null;
    const box = shellBoxOf(env.read());
    if (sameBox(last, box)) return;
    last = box;
    apply(box);
  };

  const onSignal = () => {
    if (cancel !== null) return;
    cancel = env.schedule(settle);
  };

  settle();
  const unsubscribe = env.subscribe(onSignal);

  return () => {
    unsubscribe();
    cancel?.();
  };
}

/**
 * The browser's visual viewport, or `null` where the API is missing — then nothing is written and the
 * CSS fallback (`width: 100%`, `height: 100dvh`) stands on its own.
 *
 * BOTH events are needed and they are not interchangeable: `resize` reports a changed SIZE (zoom,
 * keyboard, rotation, window), `scroll` a changed OFFSET — panning a zoomed page, and on iOS the
 * keyboard as well, move the visible area without resizing it.
 */
export function visualViewportEnv(): ViewportEnv | null {
  if (typeof window === 'undefined') return null;
  const vv = window.visualViewport;
  if (!vv) return null;
  return {
    read: () => vv,
    subscribe(listener) {
      vv.addEventListener('resize', listener);
      vv.addEventListener('scroll', listener);
      return () => {
        vv.removeEventListener('resize', listener);
        vv.removeEventListener('scroll', listener);
      };
    },
    schedule(run) {
      const id = requestAnimationFrame(run);
      return () => cancelAnimationFrame(id);
    },
  };
}
