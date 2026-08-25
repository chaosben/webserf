/**
 * **Build helper** — the overlay that shows for the *whole* window what can be built where. Toggled
 * off by another special click.
 *
 * Ported from **`FUN_000375ff`** (@0x375ff) — the outer routine that saves the player's four cursor
 * fields, walks the window from `vp[0x46]/[0x48]` and calls **`FUN_0003789d`** (@0x3789d) per tile for
 * the symbol choice. `ui_draw_viewport` (@0x3756e) calls `FUN_000375ff` exactly when **`vp[0]` bit 6**
 * is set — the state "build helper on". It is toggled with `btc $0x6` @0x27ee5, reachable through the
 * **special click on a slot-0 icon** ({@link BUILD_HELPER_TOGGLE_ICONS}).
 *
 * ## The symbol choice
 *
 * Per visible tile the original sets the **cursor temporarily** to it (`player[0xfc]/[0xfe]`), calls
 * `classify_build_site` and derives the marker sprite from cursor type + build possibility:
 *
 * ```
 * art = player[0x100] ; m = player[0x101]
 * if (art <= 3)              -> 0            // water/building/flag/...: show nothing
 * else if (art == 4)         -> m ? 0x2f : 0 // on a road: flag symbol
 * else /* art 5,6,7 * /      -> m ? ((m == 5 ? 4 : m) + 0x2e) : 0
 * ```
 *
 * The clamp `m == 5 -> 4` is the same as in `contextBarState`, but here for **every** type >= 5 (there
 * only for type 7): possibility 5 ("castle") would otherwise fall onto the road symbol `0x33`, while
 * the castle `0x32` is meant.
 *
 * Moving the cursor temporarily is a quirk of the original — `classify_build_site` takes its arguments
 * through the cursor. Our {@link classifyBuildSite} gets `col/row` directly, so save and restore drop
 * out entirely.
 *
 * ## No cache
 *
 * The original caches the marker bytes in `vp[0xda]` and, with `vp[0]` bit 7 set, only replays them —
 * a classification run over the whole window is expensive on a 386. We recompute every time:
 * `classifyBuildSite` is pure arithmetic, and the state changes while building anyway. Should it ever
 * become too slow, the cache is exactly the place to add.
 */

import { classifyBuildSite, type BuildSite } from './engine/build-site.js';
import { CURSOR_MARKER_BUILD_BASE, CURSOR_MARKER_FLAG } from './ui-render.js';
import { entityAnchor, type WindowFrame } from './window-frame.js';
import type { GameState, Player } from './engine/state.js';

/** One overlay marker: sprite value (without bank base) at a window position. */
export interface BuildSiteMarker {
  readonly sprite: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Marker sprite for a tile — `0` means "show nothing" (the original uses 0 as the empty value, so we
 * do too). The chain from `FUN_0003789d`.
 */
export function buildSiteMarkerSprite(site: BuildSite): number {
  const art = site.cursorType;
  const m = site.possibility;
  if (art <= 3) return 0;
  if (art === 4) return m !== 0 ? CURSOR_MARKER_FLAG : 0;
  if (m === 0) return 0;
  return (m === 5 ? 4 : m) + CURSOR_MARKER_BUILD_BASE;
}

export interface BuildSiteOverlayInput {
  readonly state: GameState;
  readonly player: Player;
  readonly frame: WindowFrame;
  /** Pixels per height step (original 4). */
  readonly heightUnit: number;
  /** Window height in pixels — the original clamps at `vp[0x40]` (`0 <= y < height`). */
  readonly windowHeight: number;
}

/**
 * All overlay markers of the window (port of `FUN_000375ff` + `FUN_0003789d`).
 *
 * As in every pass the positions come from the **traversal** ({@link entityAnchor}), not from
 * `col/row`: otherwise the repetition breaks when zooming out (see `window-frame.ts`). The height
 * shift is the usual one (`y - height * heightUnit`); the original's y clamp is kept because it is
 * visible behaviour (markers disappear at the window edge instead of sticking halfway in).
 */
export function buildSiteOverlay(input: BuildSiteOverlayInput): BuildSiteMarker[] {
  const { state, player, frame, heightUnit, windowHeight } = input;
  const out: BuildSiteMarker[] = [];
  const cols = state.geo.cols;
  for (let i = 0; i < frame.halfRows.length; i++) {
    const hr = frame.halfRows[i]!;
    for (let k = 0; k < hr.tiles.length; k++) {
      const pos = hr.tiles[k]!;
      const tile = state.mapTiles[pos];
      if (tile === undefined) continue;
      const col = pos % cols;
      const row = (pos - col) / cols;
      const sprite = buildSiteMarkerSprite(classifyBuildSite(state, player, col, row));
      if (sprite === 0) continue;
      const flat = entityAnchor(frame, i, k);
      const y = flat.y - tile.height * heightUnit;
      if (y < 0 || y >= windowHeight) continue;
      out.push({ sprite, x: flat.x, y });
    }
  }
  return out;
}
