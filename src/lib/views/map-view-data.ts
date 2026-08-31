/**
 * Display packages built from the game state for `MapView.svelte`.
 *
 * Pure functions, so the transformation stays testable without a DOM and without runes; the
 * `$derived` around them lives at the caller, otherwise dependency tracking would be lost.
 */

import { countRecruitable } from '../core/engine/player-settings.js';
import type { EntityIndex } from '../core/entity-layer.js';
import type { BuildingRecord, FlagRecord } from '../core/types.js';
import type { SettingsPopupView } from '../core/settings-popup.js';
import type { OptionsPopupView } from '../core/options-popup.js';
import type { GameState } from '../core/engine/state.js';

/** Data package of the eight distribution sub-screens. */
export function buildSettingsView(state: GameState, playerIndex: number): SettingsPopupView | null {
  const p = state.players[playerIndex];
  if (!p) return null;
  return {
    foodDistribution: p.foodDistribution,
    planksDistribution: p.planksDistribution,
    steelDistribution: p.steelDistribution,
    coalDistribution: p.coalDistribution,
    wheatDistribution: p.wheatDistribution,
    toolPriority: p.toolPriority,
    flagPriority: p.flagPriority,
    inventoryPriority: p.inventoryPriority,
    knightOccupation: p.knightOccupation,
    serfToKnightRate: p.serfToKnightRate,
    currentSett5Item: p.currentSett5Item,
    currentSett6Item: p.currentSett6Item,
    goldMorale: p.goldMorale,
    goldDeposited: p.goldDeposited,
    knightMenuValue: p.knightMenuValue,
    knightMenuCounter: p.knightMenuCounter,
    flags: p.flags,
    recruitable: countRecruitable(state, p),
  };
}

/** Footer of the distribution menu; volume, music and sound are interface state. */
export function buildOptionsView(
  state: GameState,
  ui: { readonly volume: number; readonly music: boolean; readonly sfx: boolean },
): OptionsPopupView {
  return {
    viewOptions: state.header.viewOptions,
    volume: ui.volume,
    music: ui.music,
    sfx: ui.sfx,
  };
}

/**
 * ENTITY INDEX WITHOUT BUILD COST — the draw pass looks buildings, flags and serfs up by their slot
 * index, and that is exactly how they already sit in the live state (`state.serfs[i]`, densely
 * index-addressed like the original's arrays).
 *
 * Building three fresh `Map`s per frame for the same mapping costs 0.14 ms at 821 serfs plus about a
 * thousand entries of garbage — enough to be the second largest item of an otherwise idle frame. The
 * lookup here is an array access.
 *
 * IT IS CONSISTENT WITH `renderState`, not beside it: while paused and untouched the view draws
 * `save`, and `engineState` is exactly its `loadState`; as soon as anything runs, `renderState` is a
 * `snapshot(engineState)` — which passes the same record objects through. Only a mutation OUTSIDE
 * those two routes could pull the views apart, and `markEngineMutated` is the only door for that.
 */
export function engineEntityIndex(state: GameState): EntityIndex {
  // The two casts are the same as in `snapshot()` next door and for the same reason: the live
  // records are `DeepMutable`, which turns a `readonly [A, B]` into an `A[]` — tuple length is no
  // longer guaranteed in the mutable model. Nothing changes about the content (the slots are
  // written in place, never shortened).
  return {
    building: { get: (i) => (state.buildings[i] ?? undefined) as BuildingRecord | undefined },
    flag: { get: (i) => (state.flags[i] ?? undefined) as FlagRecord | undefined },
    serf: { get: (i) => state.serfs[i] ?? undefined },
  };
}
