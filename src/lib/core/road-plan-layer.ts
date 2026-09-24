/**
 * **The planned road of the road assistant** — an addition of ours with no counterpart in the
 * original; nothing of it enters the game state.
 *
 * The preview is drawn as the road it would become: the road layer is run a second time with these
 * bits in place of the tiles' own, so a planned segment gets exactly the mask, ground texture and
 * position a built one gets. What the player sees is therefore what the build produces.
 */
import { neighbor, oppositeDir, posOf, type Direction, type MapGeometry } from './engine/position.js';

/**
 * Road bits per tile for a plan: both ends of every step, as the commit sets them. The road layer
 * draws each segment once from whichever end holds its forward direction.
 */
export function plannedRoadPaths(
  from: { readonly col: number; readonly row: number },
  dirs: readonly Direction[],
  geo: MapGeometry,
): Map<number, number> {
  const bits = new Map<number, number>();
  let pos = posOf(from.col, from.row, geo);
  for (const d of dirs) {
    const next = neighbor(pos, d, geo);
    bits.set(pos, (bits.get(pos) ?? 0) | (1 << d));
    bits.set(next, (bits.get(next) ?? 0) | (1 << oppositeDir(d)));
    pos = next;
  }
  return bits;
}
