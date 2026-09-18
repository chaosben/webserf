/**
 * Keeping the browser's own zoom off the application surface.
 *
 * **WebKit ignores `touch-action` for the pinch.** Everywhere else `touch-action` on the shell root
 * settles it; there the page would keep zooming although our own pointer handlers work fine, and the
 * only counter is `preventDefault` on the non-standard `gesture*` events. They are absent from the
 * DOM typings, hence the cast and the imperative registration with `passive: false`.
 *
 * Its limit, plainly: on engines that honour `touch-action` these events never fire, so there this is
 * dead weight — and on WebKit it cannot be checked from here.
 *
 * ONE PLACE FOR IT. The events bubble, so a listener on the shell covers the game view and the main
 * menu alike; each view keeps its own `touch-action: none`, which is what makes the pinch ITS gesture
 * rather than the page's.
 */

/** The three non-standard WebKit events that carry a pinch. */
const GESTURES = ['gesturestart', 'gesturechange', 'gestureend'] as const;

/** As much of an `EventTarget` as this module uses — so a test needs no DOM. */
export interface ZoomTarget {
  addEventListener(
    type: string,
    listener: (ev: Event) => void,
    options?: unknown,
  ): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
}

/**
 * Swallow the page-zoom gesture on `el` and everything inside it. Returns the teardown, so it fits
 * straight into an `$effect`.
 */
export function blockPageZoom(el: ZoomTarget): () => void {
  const stop = (ev: Event) => ev.preventDefault();
  for (const name of GESTURES)
    el.addEventListener(name, stop, { passive: false });
  return () => {
    for (const name of GESTURES) el.removeEventListener(name, stop);
  };
}
