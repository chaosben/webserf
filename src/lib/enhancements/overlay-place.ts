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
