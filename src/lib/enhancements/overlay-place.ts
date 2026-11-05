/**
 * Where our own overlays sit over the game surface, and how far they show through.
 *
 * Both the stock overview and the hack switches ask exactly these two questions, so they are asked
 * once here. The i18n keys already said as much before this module existed: the corner names are
 * `enh.corner.*` and not `enh.stock.corner.*`.
 *
 * **The SIZE is not among them.** Every overlay of ours takes the scale of the control bar below
 * (`uiScaleFor`) and nothing else, so it grows and shrinks with the map exactly as the bar does —
 * steplessly, and without anyone choosing anything. The one rule that turns that factor into a text
 * size lives in the global stylesheet as `.game-overlay`, so two plates cannot drift apart.
 */
import type { ShellKey } from '../shell/i18n.js';

/** Which corner of the game surface an overlay sits in. */
export const OVERLAY_CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
export type OverlayCorner = (typeof OVERLAY_CORNERS)[number];

/** The name of each corner, for whichever tab offers the choice. */
export const CORNER_LABEL = {
  tl: 'enh.corner.tl',
  tr: 'enh.corner.tr',
  bl: 'enh.corner.bl',
  br: 'enh.corner.br',
} as const satisfies Record<OverlayCorner, ShellKey>;

/**
 * How far the plate shows through — the whole plate with everything on it, not just its backing
 * (`opacity` in the shared `.game-overlay` rule).
 *
 * Not down to zero: an invisible overlay that still swallows nothing would be indistinguishable
 * from a broken one, and the hack plate takes the pointer, so it would swallow clicks unseen.
 */
export const OVERLAY_OPACITY_MIN = 0.2;
export const OVERLAY_OPACITY_MAX = 1;
export const OVERLAY_OPACITY_DEFAULT = 0.8;

/**
 * Distance of every corner from its two window edges, in CSS pixels — a pixel value rather than a
 * `rem`, because {@link cornerBottom} compares it with pixel geometry and the root font size moves
 * with the shell's UI size.
 */
export const CORNER_INSET_PX = 8;

/**
 * The `bottom` offset of a bottom corner, in CSS pixels.
 *
 * The control bar is blitted into the canvas at the bottom centre and is narrower than the window
 * once the window is wide. A corner column therefore only moves up above the bar's top edge when it
 * would reach into the bar's horizontal span; otherwise it keeps its window corner. Lifting it
 * always would waste the space beside the bar on every wide screen.
 *
 * `bar` is the bar in CSS pixels, `null` while no bar is drawn (no archive, end credits).
 * `width` is the column's measured width — it does not depend on the column's height, so the lift
 * cannot feed back into it.
 */
export function cornerBottom(
  corner: 'bl' | 'br',
  width: number,
  bar: { readonly x: number; readonly y: number; readonly w: number } | null,
  viewportW: number,
  viewportH: number,
): number {
  if (bar === null || width <= 0) return CORNER_INSET_PX;
  const overlaps =
    corner === 'bl'
      ? CORNER_INSET_PX + width > bar.x
      : viewportW - CORNER_INSET_PX - width < bar.x + bar.w;
  return overlaps ? viewportH - bar.y + CORNER_INSET_PX : CORNER_INSET_PX;
}
