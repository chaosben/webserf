/**
 * **"Demolish" at the cursor tile** — port of `FUN_00048c8a` @0x48c8a.
 *
 * The action behind panel icon `0x06` and behind the confirm button of the demolish confirmation
 * (screen 0x37). Both paths call **the same** routine; it reclassifies the build site itself and
 * branches on the cursor type:
 *
 * ```
 * classify_build_site()
 * if (player[0x100] == 2) { sound(8);  vp[1] |= 4; vp[0] &= ~0x80; demolish_flag(x, y);  return }
 * if (player[0x100] != 3) { sound(4);  context_bar_set_icons();                          return }
 * if ((bld[4] & 0xfc) in {0x2c, 0x54, 0x58})       // hut / tower / fortress
 *     for the first 127 spiral positions around the tile:
 *         serf = game[p].serf ; if (serf == 0) continue
 *         if ((serf[0] & 0x7c) in [0x58, 0x6c) && (serf[0] & 3) != player[0]) -> REJECT
 * sound(0x4c); vp[1] |= 4; demolish_building(x, y)
 * ```
 *
 * ## The guard: a military building cannot be torn down while a FOREIGN knight is in range
 *
 * The type test uses mask `0xfc` and therefore **leaves bit 7 standing** — a military building
 * **under construction** matches none of the three values and is demolished unguarded. (The same
 * trap as in the threat-level sweep: five comparison constants are not a type list, the mask is what
 * matters.)
 *
 * Serf types `0x58..0x6b` are `type << 2` for the five knight ranks 22..26; their owner is compared
 * against `player[0]`, which is block offset 128, the **player index**.
 *
 * The sweep scans spiral positions **0..126** (`n = 0x7e`, `subw $1 ; jae`, so the body also runs for
 * `n == 0`, 127 times). It reads the **tile** reference `game[p].serf`; a serf that stands on no tile
 * — the defender in an ongoing duel, for instance — is invisible to the guard. That is original
 * behaviour, not a simplification.
 *
 * **The three sounds (8 / 0x4c / 4)** hang on the three branches and are therefore not a case
 * distinction of their own here: {@link demolishOutcomeAt} yields the branch and the UI layer picks
 * the sound. Queueing happens there too — the queue is window state (`vp+0x16`), not game state, and
 * this module stays free of side effects.
 *
 * **Not reproduced:** the two UI bits (`vp[1] |= 4` = cursor dirty, `vp[0] &= ~0x80` = cache mark of
 * the flag branch) — the UI layer re-derives its context icons after every command anyway.
 */

import type { GameState, Player } from './state.js';
import { posOf, neighbor, Direction } from './position.js';
import { spiralPos } from './spiral.js';
import { CURSOR_BUILDING, CURSOR_REMOVABLE_FLAG, classifyBuildSite } from './build-site.js';
import { demolishBuilding } from './buildings.js';
import { demolishFlag } from './road-teardown.js';

/** Spiral positions scanned by the guard (`n = 0x7e`, the body also runs at 0). */
export const DEMOLISH_GUARD_SPIRAL_LEN = 127;

/**
 * Building types that trigger the guard — `bld[4] & 0xfc in {0x2c, 0x54, 0x58}` = `type << 2` for
 * hut (11), tower (21), fortress (22). The **castle** (24 => 0x60) is not among them.
 */
export const DEMOLISH_GUARDED_TYPES: ReadonlySet<number> = new Set([11, 21, 22]);

/** Serf type range of the guard: `(serf[0] & 0x7c) in [0x58, 0x6c)` = knight ranks 22..26. */
const KNIGHT_MIN = 22;
const KNIGHT_MAX = 26;

/** Outcome of a demolition attempt. */
export type DemolishOutcome = 'flag' | 'building' | 'rejected';

/**
 * Is a knight of **another** player within the first {@link DEMOLISH_GUARD_SPIRAL_LEN} spiral
 * positions around `pos`? (The guard on demolishing a military building.)
 */
export function enemyKnightNearby(state: GameState, pos: number, playerIndex: number): boolean {
  for (let i = 0; i < DEMOLISH_GUARD_SPIRAL_LEN; i++) {
    const idx = state.mapTiles[spiralPos(pos, i, state.geo)]?.serfIndex ?? 0;
    if (idx === 0) continue;
    const serf = state.serfs[idx];
    if (serf == null) continue;
    if (serf.type >= KNIGHT_MIN && serf.type <= KNIGHT_MAX && serf.owner !== playerIndex) return true;
  }
  return false;
}

/**
 * **Which branch** of `FUN_00048c8a` a demolition at this tile takes — classification and the three
 * gates, **without any effect**.
 *
 * The original classifies exactly once and then branches three ways, so the branch lives here in one
 * place and serves all three consumers: the UI gate ({@link canDemolishAtCursor}), the sound, and the
 * execution ({@link demolishAtCursor}).
 */
export function demolishOutcomeAt(
  state: GameState,
  player: Player,
  col: number,
  row: number,
): DemolishOutcome {
  const site = classifyBuildSite(state, player, col, row);
  if (site.cursorType === CURSOR_REMOVABLE_FLAG) {
    return state.mapTiles[posOf(col, row, state.geo)] == null ? 'rejected' : 'flag';
  }
  if (site.cursorType !== CURSOR_BUILDING) return 'rejected';
  const pos = posOf(col, row, state.geo);
  const bld = state.buildings[state.mapTiles[pos]?.objIndex ?? 0];
  if (bld == null) return 'rejected';
  // Mask `0xfc` keeps bit 7 => a military building UNDER CONSTRUCTION is unguarded.
  if (bld.constructing || !DEMOLISH_GUARDED_TYPES.has(bld.type)) return 'building';
  return enemyKnightNearby(state, pos, player.slot) ? 'rejected' : 'building';
}

/**
 * Would {@link demolishAtCursor} demolish anything? The same gates, without the effect. The UI uses
 * it to reject the confirm button or the panel icon instead of playing a rejection sound.
 */
export function canDemolishAtCursor(
  state: GameState,
  player: Player,
  col: number,
  row: number,
): boolean {
  return demolishOutcomeAt(state, player, col, row) !== 'rejected';
}

/**
 * Demolishes at the cursor tile (port of `FUN_00048c8a`). Returns what happened — `'rejected'`
 * corresponds to the original's rejection branch `LAB_00048ea4`.
 */
export function demolishAtCursor(
  state: GameState,
  player: Player,
  col: number,
  row: number,
): DemolishOutcome {
  const outcome = demolishOutcomeAt(state, player, col, row);
  const pos = posOf(col, row, state.geo);
  if (outcome === 'flag') {
    demolishFlag(state, state.mapTiles[pos]!.objIndex, col, row);
  } else if (outcome === 'building') {
    demolishBuilding(state, state.buildings[state.mapTiles[pos]!.objIndex]!);
  }
  return outcome;
}

/**
 * **Special click on a building in the build menu** — branch @0x30161 of the three placement
 * bodies, behind `buildMenuClickOutcome(...) === 'demolish'`.
 *
 * A routine of **its own**, not a variant of {@link demolishAtCursor}: here the original calls
 * `demolish_building` @0x48eb8 directly (`call` @0x30192), so there is neither the cursor-type
 * cascade nor the "foreign knight in range" guard. Afterwards `FUN_00031d5c` runs (`call` @0x30197)
 * and does three things:
 *
 * ```
 * bld[0x10]                          = (byte)gs->pendingBuildType   @0x31d8f
 * landscape[bldPos].paths           |= 0x02                         @0x31d9d  (DownRight -> flag)
 * landscape[bldPos+DownRight].paths |= 0x10                         @0x31db4  (UpLeft -> building)
 * ```
 *
 * Those two path bits are exactly the ones `demolish_building` cleared just before (`andb $0xfd` /
 * `andb $0xef`), so the building-to-flag connection stays while the building burns down. What this is
 * *for*, and why the building type ends up in `stockMaximum[0]`, is open: what stands here is the
 * byte sequence in original order, not an interpretation of it.
 *
 * Returns `false` when there is no building on the tile — impossible in the original, since the
 * caller established cursor type 3; here a safeguard against a stale cursor.
 */
export function demolishForPendingBuild(
  state: GameState,
  col: number,
  row: number,
  pendingType: number,
): boolean {
  const pos = posOf(col, row, state.geo);
  const tile = state.mapTiles[pos] ?? null;
  if (tile === null) return false;
  const bld = state.buildings[tile.objIndex] ?? null;
  if (bld == null) return false;
  demolishBuilding(state, bld);
  // `FUN_00031d5c` @0x31d5c — meaning open, see above.
  bld.stockMaximum = [pendingType & 0xff, bld.stockMaximum?.[1] ?? 0];
  tile.paths |= 1 << Direction.DownRight;
  const flagTile = state.mapTiles[neighbor(pos, Direction.DownRight, state.geo)] ?? null;
  if (flagTile !== null) flagTile.paths |= 1 << Direction.UpLeft;
  return true;
}
