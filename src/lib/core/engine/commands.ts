/**
 * Player command protocol — the ONE interface through which a move (human player, built-in AI,
 * external AI agent or multiplayer client) changes the game state.
 *
 * - Deterministic and tick-bound: commands are not applied mid-frame but by the caller at a TICK
 *   BOUNDARY, in order. Same starting state plus same command sequence yields the same next state,
 *   which is what makes lockstep and replay possible.
 * - Position-based like the original UI: a command carries `col`/`row`, not volatile object indices.
 *   Position-to-entity resolution happens when applying, against the state as it is THEN.
 * - JSON-capable: plain-data discriminated union, no closures, so it is snapshot- and
 *   network-serialisable.
 * - Validatable before applying: {@link canApplyCommand} checks admissibility without side effects,
 *   both for UI enable/disable and to reject invalid AI or network commands.
 *
 * The actual state changes delegate to the byte-verified engine routines; this module is only the
 * typed dispatch in front of them.
 */

import type { GameState, Inventory, Tile } from './state.js';
import { posOf } from './position.js';
import { clearRoadPaths, demolishFlag } from './road-teardown.js';
import {
  BUILD_CASTLE,
  CURSOR_CLEAR,
  CURSOR_FLAG,
  CURSOR_PATH,
  CURSOR_REMOVABLE_FLAG,
  buildFlag,
  canBuildFlag,
  canPlaceBuilding,
  classifyBuildSite,
  placeBuilding,
} from './build-site.js';
import { foundCastle } from './founding.js';
import { canDemolishAtCursor, demolishAtCursor, demolishForPendingBuild } from './demolish.js';
import { CURSOR_BUILDING } from './build-site.js';
import { attachFlagToRoad, canAttachFlagToRoad } from './road-attach.js';
import {
  adjustKnightMenuValue,
  adjustKnightOccupation,
  applySettingsDefaults,
  movePriorityItem,
  recruitKnights,
  selectPriorityItem,
  setAttackSelection,
  startKnightShift,
  writeSliderValue,
} from './player-settings.js';
import type { PriorityKind, PriorityMove, SliderList } from '../settings-popup.js';
import {
  recallQueueFull,
  scheduleBuildingRecall,
  scheduleMapRecall,
  scheduleMenuRecall,
} from './message-recall.js';
import { cycleViewMessageLevel, toggleViewOption, type ViewSide } from './view-options.js';
import {
  SAVE_CLOCK_QUIT_GRACE,
  SAVE_CLOCK_REMINDER_30MIN,
  SAVE_CLOCK_REMINDER_60MIN,
} from './state.js';
import {
  attackCountDecrement,
  attackCountIncrement,
  attackCountPreset,
  launchAttack,
  prepareAttack,
  type AttackLaunchResult,
  type AttackPrepResult,
} from './attack.js';
import {
  setResourceModeIn,
  setResourceModeOut,
  setResourceModeStop,
  setSerfModeIn,
  setSerfModeOut,
  setSerfModeStop,
} from './inventory-mode.js';
import { sendGeologistToFlag } from './serf-request.js';
import {
  beginRoadBuilding,
  cancelRoadBuilding,
  roadBuildingClick,
  roadSession,
  updateRoadMarkers,
  SOUND_REJECT,
  type RoadClickResult,
} from './road-building.js';

/** A player command. Discriminated union over `kind`; each variant carries its target position. */
export type Command =
  | {
      readonly kind: 'demolishFlag';
      readonly col: number;
      readonly row: number;
    }
  /**
   * Place a building (build popup action, `FUN_00030000` ff). `player` is the slot 0..3,
   * `buildingType` the type 1..24. Admissibility equals the gates of the original handlers: build
   * site classification, military lock, warehouse limit.
   */
  | {
      readonly kind: 'placeBuilding';
      readonly col: number;
      readonly row: number;
      readonly player: number;
      readonly buildingType: number;
    }
  /**
   * Demolish the roads at a tile (control bar icon `0x0f`, `FUN_0004a493`). The original's gate: the
   * build site classification must yield cursor type 4 (road), otherwise just the reject sound.
   */
  | {
      readonly kind: 'demolishRoad';
      readonly col: number;
      readonly row: number;
      readonly player: number;
    }
  /**
   * Place a standalone flag — two triggers in the original with the same gate: control bar icon
   * `0x01` (`action_build_flag` @0x2891e) and the flag symbol of the build menu (`build_flag_action`
   * @0x2fe96, which after the lock check is only `close_popup` plus a jump to the same handler).
   * Gate: possibility != 0 and cursor type 7, 6 or 4.
   *
   * Cursor type 4 (flag onto an existing road) IS admissible — like the original it ends in
   * `build_flag` via the ported road split.
   */
  | {
      readonly kind: 'buildFlag';
      readonly col: number;
      readonly row: number;
      readonly player: number;
    }
  /**
   * Found the castle (control bar icon `0x05`, `FUN_00028d0a`). The original's gate: possibility 5
   * AND cursor type 7 (free tile). `difficulty` selects the initial resource table (`player+0x162`).
   */
  | {
      readonly kind: 'foundCastle';
      readonly col: number;
      readonly row: number;
      readonly player: number;
      readonly difficulty?: number;
    }
  /**
   * Attach a flag to a road passing by (flag popup symbol `0x135`, action `0xf7`, `FUN_0004ccdf`).
   * The gate is the same predicate that decides whether the symbol is drawn at all.
   */
  | {
      readonly kind: 'attachFlagToRoad';
      readonly col: number;
      readonly row: number;
    }
  /**
   * Demolish at the cursor tile (control bar icon `0x06`, or the confirm button of screen 0x37) —
   * `FUN_00048c8a`. The original calls the same routine from BOTH paths, and it classifies itself:
   * cursor type 2 demolishes the flag, type 3 the building (a military building only with no enemy
   * knight in range), everything else is rejected.
   *
   * Not to be confused with `demolishFlag`, which is the primitive `demolish_flag` @0x4980e without
   * classification; this command is the action frame around it.
   */
  | {
      readonly kind: 'demolishAtCursor';
      readonly col: number;
      readonly row: number;
      readonly player: number;
    }
  /**
   * Demolish from the build menu (special click on a building icon while the cursor sits on an own
   * building of the matching build class) — branch @0x30161. `pendingType` is `gs+0x27a`, the type of
   * the clicked icon; the original stores it in `bld+0x10`.
   *
   * Deliberately NOT `demolishAtCursor`: the original calls `demolish_building` directly here, so
   * without the cursor-type cascade and without the knight guard of the demolish action.
   */
  | {
      readonly kind: 'demolishFromBuildMenu';
      readonly col: number;
      readonly row: number;
      readonly player: number;
      readonly pendingType: number;
    }
  /**
   * Start road building (control bar icon `0x18`/`0x08`, @0x2860d). `col`/`row` is the starting flag.
   *
   * The original classifies the CURRENT cursor and relies on the preceding map click having set it.
   * This command carries the position itself and sets the cursor when applying — otherwise the result
   * would depend on state no command in the log explains, and a replayed log could start the road at
   * a different flag.
   */
  | {
      readonly kind: 'beginRoadBuilding';
      readonly col: number;
      readonly row: number;
      readonly player: number;
    }
  /**
   * One map click in road building mode (@0x2a63c). Every click is its own action with its own
   * effect: append a segment, take one back, place a flag on the way (special click), or commit the
   * road at a flag.
   *
   * That is why road building is logged CLICK BY CLICK rather than as a finished road: a special
   * click builds a flag that survives even if the build is cancelled afterwards, and a log that knows
   * only the finished road loses it.
   *
   * The UI layer needs sound and session state of the click, which is what
   * {@link applyRoadBuildClick} is for. {@link applyCommand} calls the same function and discards the
   * extra information — one more call path to the SAME effect, not a second layer.
   */
  | {
      readonly kind: 'roadBuildClick';
      readonly col: number;
      readonly row: number;
      readonly player: number;
      /** `vp[1]` bit 3 — special click (right mouse button): builds flags on the way. */
      readonly special?: boolean;
    }
  /**
   * Cancel road building (same control bar icon, branch @0x286dc) — clears the provisional road bits.
   * No position: the cancel walks the placed segments back from the cursor.
   */
  | { readonly kind: 'cancelRoadBuilding'; readonly player: number }
  // ── Distribution and knight menus (screens 0x1c..0x21, 0x2d/0x2e) ─────────────────────────────
  //
  // All nine are separate original handlers of the popup zone walker and therefore separate commands,
  // kept flat so the action log shows the kind of action in its first column.
  //
  // The GEOMETRY stays in the UI layer: a slider click is pixel -> value -> field in the original,
  // and the command carries only the result, not the click coordinate. Otherwise a replayed log would
  // depend on the layout tables of the windows.
  /** Set a slider (`applySliderClick` body without the pixel arithmetic). `value` is u16. */
  | {
      readonly kind: 'setDistributionValue';
      readonly player: number;
      readonly list: SliderList;
      readonly index: number;
      readonly value: number;
    }
  /** Default button of a distribution screen (`FUN_0002bdf0` ff, own fields per screen). */
  | {
      readonly kind: 'resetDistributionDefaults';
      readonly player: number;
      readonly screen: number;
    }
  /** Select a priority slot (screen 0x1e/0x21). */
  | {
      readonly kind: 'selectPriorityItem';
      readonly player: number;
      readonly list: PriorityKind;
      readonly slot: number;
    }
  /** Move the selected resource within the priority queue. */
  | {
      readonly kind: 'movePriorityItem';
      readonly player: number;
      readonly list: PriorityKind;
      readonly move: PriorityMove;
    }
  /** Knight occupation +/- (`knightOccupation[index]`, upper/lower bound). */
  | {
      readonly kind: 'setKnightOccupation';
      readonly player: number;
      readonly index: number;
      readonly bound: 'max' | 'min';
      readonly delta: -1 | 1;
    }
  /** Castle garrison target +/- (`FUN_0002de5c`/`FUN_0002de8f`, block 522). */
  | {
      readonly kind: 'setCastleGarrisonTarget';
      readonly player: number;
      readonly delta: -1 | 1;
    }
  /** Attack selection (`flags` bit 1): `strong` means the stronger knights attack. */
  | {
      readonly kind: 'setAttackSelection';
      readonly player: number;
      readonly strong: boolean;
    }
  /**
   * Turn idle serfs into knights (`FUN_0002df33`), at most `limit` (1/5/20/100). The UI layer needs
   * the COUNT for sound and message, which is what {@link applyRecruitKnights} is for.
   */
  | {
      readonly kind: 'recruitKnights';
      readonly player: number;
      readonly limit: number;
    }
  /** Start a knight shift (`FUN_0002dda4`: two `flags` bits plus countdown block 496). */
  | { readonly kind: 'startKnightShift'; readonly player: number }
  // ── Warehouse window (screen 0x2c) and flag window (0x2a) ─────────────────────────────────────
  /**
   * Toggle stock in/out of a warehouse — the six handlers `@0x2e119` ff, here as ONE command with the
   * two table indices: `group` selects the row of check marks, `mode` is 0 store / 1 stop / 3 ship
   * out. Those are the values the original really stores, NOT 0/1/2.
   *
   * The warehouse is named by its MAP POSITION, not by inventory index: an index can be reassigned
   * after a demolition, and "warehouse at (12,34)" is readable in the log.
   */
  | {
      readonly kind: 'setInventoryMode';
      readonly col: number;
      readonly row: number;
      readonly player: number;
      readonly group: 'resources' | 'serfs';
      readonly mode: 0 | 1 | 3;
    }
  /**
   * Call a geologist to a flag (`FUN_0002e4e4` -> `request_serf_to_flag`). No `player` field: the
   * routine finds the warehouse via the flag's road network, and ownership follows from that.
   */
  | {
      readonly kind: 'callGeologist';
      readonly col: number;
      readonly row: number;
    }
  // ── Attack window (screen 0x14) ───────────────────────────────────────────────────────────────
  /**
   * Prepare an attack (special click on an enemy military building, @0x2a3f6): writes the target,
   * checks three conditions and collects the reachable attackers. NOT a display-only action — it
   * fills `attackingBuildings`/`totalAttackingKnights` and therefore belongs in the log.
   */
  | {
      readonly kind: 'prepareAttack';
      readonly col: number;
      readonly row: number;
      readonly player: number;
    }
  /**
   * Change the chosen knight count — the six buttons of the window: `dec`/`inc` (`FUN_00031612`/
   * `FUN_0003164d`) and four presets (`bands` 1..4, cumulative distance bands).
   */
  | {
      readonly kind: 'adjustAttackCount';
      readonly player: number;
      readonly mode: 'inc' | 'dec' | 'preset';
      /** Only with `preset`: 1..4. */
      readonly bands?: number;
    }
  /** Launch the attack (`attack_launch` @0x3169c). Sound, window state and count via {@link applyAttackLaunch}. */
  | { readonly kind: 'launchAttack'; readonly player: number }
  // ── Recall function (clock column of the control bar, manual pp. 109-110) ─────────────────────
  /**
   * Queue a recall — the three branches @0x27b9e (map position), @0x27aee (warehouse/castle) and
   * @0x27a1e (distribution menu). WHICH one it is is decided by the open popup screen in the
   * original; that stays UI knowledge, and the command carries the result.
   *
   * `delayRow` is the CLOCK 0..4 (5/10/20/30/60 minutes), not a pixel distance: the original's two
   * different row rasters (7 px and 8 px in the same column) are geometry and belong in the UI layer.
   */
  | {
      readonly kind: 'scheduleRecall';
      readonly player: number;
      readonly delayRow: number;
      readonly target:
        | { readonly kind: 'map'; readonly col: number; readonly row: number }
        | {
            readonly kind: 'building';
            readonly col: number;
            readonly row: number;
          }
        | { readonly kind: 'menu'; readonly index: number };
    }
  // ── View options (`.DS`@72/73, per screen half) ───────────────────────────────────────────────
  /** Toggle an option check mark (`gs+0x3d8`/`0x3d9`, bit mask). */
  | {
      readonly kind: 'setViewOption';
      readonly side: ViewSide;
      readonly mask: number;
    }
  /** Cycle the message level (thermometer bits 3..5) — filters messages by DISCARDING them. */
  | { readonly kind: 'cycleMessageLevel'; readonly side: ViewSide }
  // ── Saving ────────────────────────────────────────────────────────────────────────────────────
  /**
   * Reset the three clocks after a successful save (@0x28506/@0x28514/@0x28522, in the exit of the
   * result window, only when `gs+0x240 == 0`).
   *
   * Why this is a COMMAND rather than an assignment in the UI layer: it is the only state change a
   * save causes at all, and in the original it sits in an action handler — exactly where the command
   * layer sits here. Without that detour a `GameState` mutation would happen outside the action log,
   * and a replayed bug report would fire the two save reminders at a different time.
   *
   * Writing the file itself is NOT a command: it changes no game state.
   */
  | { readonly kind: 'noteGameSaved' }
  // ── Spectator mode ────────────────────────────────────────────────────────────────────────────
  /**
   * Switch to another player's view — the four coloured buttons in the frame head of an open popup
   * (`FUN_0002bf57` @0x2bf57 and its three byte-identical siblings, reachable only with `gs+0x37e`
   * bit 5, i.e. game type 4).
   *
   * Why this is a COMMAND although "view" sounds like display: the switch CLEARS the target player's
   * message list — 16 u32 from `player+0x1df4` (@0x2bf65..@0x2bf72), i.e. the 64 type bytes — and
   * clears `flags` bit 3 (@0x2bf7c). That is game state, and without the command layer it would be
   * missing from a replayed bug report.
   *
   * The branch is gated: only a slot with `flags` bit 6 (active) is accepted (`bt $0x6` @0x2bf5f);
   * otherwise nothing changes and the original plays sound 4 (rejected). The return value of
   * {@link applyCommand} carries exactly that distinction.
   */
  | { readonly kind: 'switchSpectatorPlayer'; readonly slot: number };

/** All supported command kinds (for UI iteration and validation). */
export type CommandKind = Command['kind'];

/** Tile at a position, or `null` when outside the map. */
function tileAt(state: GameState, col: number, row: number): Tile | null {
  if (col < 0 || row < 0 || col >= state.geo.cols || row >= state.geo.rows) return null;
  return state.mapTiles[posOf(col, row, state.geo)] ?? null;
}

/** The inventory of the warehouse or castle at a position, or `null`. */
function inventoryAt(state: GameState, col: number, row: number): Inventory | null {
  const tile = tileAt(state, col, row);
  if (tile === null || tile.object < 2 || tile.object > 4) return null; // no building
  const bld = state.buildings[tile.objIndex];
  if (!bld || bld.inventoryIndex == null) return null;
  return state.inventories[bld.inventoryIndex] ?? null;
}

/**
 * Whether `cmd` is admissible in the current state, WITHOUT changing it. Used both for UI gating and
 * to reject invalid commands when applying.
 */
export function canApplyCommand(state: GameState, cmd: Command): boolean {
  switch (cmd.kind) {
    case 'demolishFlag': {
      const tile = tileAt(state, cmd.col, cmd.row);
      if (tile === null || tile.object !== 1) return false; // no flag on the tile
      const flag = state.flags[tile.objIndex];
      if (!flag) return false;
      // A flag under a building cannot be demolished on its own; the building goes first.
      if (flag.hasBuilding) return false;
      return true;
    }
    case 'placeBuilding': {
      if (tileAt(state, cmd.col, cmd.row) === null) return false;
      const player = state.players[cmd.player];
      if (!player || !player.active) return false;
      return canPlaceBuilding(state, player, cmd.col, cmd.row, cmd.buildingType);
    }
    case 'demolishRoad': {
      const site = siteOf(state, cmd);
      return site !== null && site.cursorType === CURSOR_PATH;
    }
    case 'buildFlag': {
      const site = siteOf(state, cmd);
      if (site === null) return false;
      // Original gate (possibility != 0, type 7/6/4), complete including type 4 (road split).
      const player = state.players[cmd.player]!;
      return canBuildFlag(state, player, cmd.col, cmd.row);
    }
    case 'foundCastle': {
      const site = siteOf(state, cmd);
      return site !== null && site.possibility === BUILD_CASTLE && site.cursorType === CURSOR_CLEAR;
    }
    case 'attachFlagToRoad': {
      if (tileAt(state, cmd.col, cmd.row) === null) return false;
      return canAttachFlagToRoad(state, cmd.col, cmd.row);
    }
    case 'demolishAtCursor': {
      if (tileAt(state, cmd.col, cmd.row) === null) return false;
      const player = state.players[cmd.player];
      if (!player || !player.active) return false;
      return canDemolishAtCursor(state, player, cmd.col, cmd.row);
    }
    // The nine menu actions: the original's zone walker only checks that the zone was hit, the
    // handlers themselves have no gate. So only the player check remains here; where an action can
    // be ineffective, the engine routine reports that through its return value.
    case 'setDistributionValue':
    case 'resetDistributionDefaults':
    case 'selectPriorityItem':
    case 'movePriorityItem':
    case 'setKnightOccupation':
    case 'setCastleGarrisonTarget':
    case 'setAttackSelection':
    case 'recruitKnights':
    case 'startKnightShift': {
      const player = state.players[cmd.player];
      return player !== null && player !== undefined && player.active;
    }
    case 'setInventoryMode': {
      const inv = inventoryAt(state, cmd.col, cmd.row);
      // The original handlers have NO gate (they work on `player+0x176`, the subject of the open
      // window). Only what is structurally necessary is checked here, plus the owner, so a foreign
      // command (AI or network) cannot reach into a warehouse that is not its own.
      return inv !== null && inv.owner === cmd.player;
    }
    case 'callGeologist': {
      const tile = tileAt(state, cmd.col, cmd.row);
      if (tile === null || tile.object !== 1) return false;
      return state.flags[tile.objIndex] != null;
    }
    case 'prepareAttack': {
      const player = state.players[cmd.player];
      if (!player || !player.active) return false;
      const tile = tileAt(state, cmd.col, cmd.row);
      if (tile === null || tile.object < 2 || tile.object > 4) return false;
      // `prepareAttack` checks the original's conditions itself (attackable type, occupied, threat
      // level 3, in range) and distinguishes the failures; only what is checkable without
      // duplicating that cascade stands here.
      return state.buildings[tile.objIndex] != null;
    }
    case 'adjustAttackCount':
    case 'launchAttack': {
      const player = state.players[cmd.player];
      return player !== null && player !== undefined && player.active;
    }
    case 'scheduleRecall': {
      const player = state.players[cmd.player];
      if (!player || !player.active) return false;
      // `cmpw $0x40,(%edi) ; je 0x27c77` @0x279b2 — 64 recalls is the maximum.
      return !recallQueueFull(player);
    }
    case 'setViewOption':
    case 'cycleMessageLevel':
      return cmd.side === 0 || cmd.side === 1;
    case 'noteGameSaved':
      return true;
    case 'switchSpectatorPlayer':
      // `bt $0x6` @0x2bf5f — an ACTIVE slot only; spectator mode itself is the caller's business
      // (the original decides that in the click router, @0x2c023).
      return state.players[cmd.slot]?.active === true;
    case 'beginRoadBuilding': {
      const site = siteOf(state, cmd);
      if (site === null) return false;
      // A road build in progress has to be cancelled first — in the original the same icon at
      // `vp[1]` bit 6 decides which of the two branches runs (@0x27490).
      if (roadSession(state, state.players[cmd.player]!).active) return false;
      // `@0x2864c`: cursor type 1 or 2, otherwise only control bar icons.
      return site.cursorType === CURSOR_FLAG || site.cursorType === CURSOR_REMOVABLE_FLAG;
    }
    case 'roadBuildClick': {
      if (tileAt(state, cmd.col, cmd.row) === null) return false;
      const player = state.players[cmd.player];
      if (!player || !player.active) return false;
      return roadSession(state, player).active;
    }
    case 'cancelRoadBuilding': {
      const player = state.players[cmd.player];
      if (!player || !player.active) return false;
      return roadSession(state, player).active;
    }
    case 'demolishFromBuildMenu': {
      if (tileAt(state, cmd.col, cmd.row) === null) return false;
      const player = state.players[cmd.player];
      if (!player || !player.active) return false;
      // The original only checks the cursor type here (the caller already checked the build class);
      // a burning building falls through inside `demolish_building` (`bt $0x5` @0x48ef7).
      const site = classifyBuildSite(state, player, cmd.col, cmd.row);
      return site.cursorType === CURSOR_BUILDING;
    }
  }
}

/**
 * Build site classification for the gate check, exactly like the original handlers, which call
 * `classify_build_site` before the action. `null` when position or player is invalid.
 *
 * The classification writes to `player+0xfc..0x102` in the original; this port returns the result
 * instead, so the check stays free of side effects.
 */
function siteOf(
  state: GameState,
  cmd: { col: number; row: number; player: number },
): { cursorType: number; possibility: number } | null {
  if (tileAt(state, cmd.col, cmd.row) === null) return null;
  const player = state.players[cmd.player];
  if (!player || !player.active) return null;
  return classifyBuildSite(state, player, cmd.col, cmd.row);
}

/**
 * Why a `buildFlag` command would be rejected, so the UI can name the REAL reason instead of a blanket
 * "not possible here". `null` means admissible.
 *
 * Cursor type 4 (a flag in the middle of a road) is admissible since the road split and needs no
 * special case here any more: the build splits the road as in the original.
 */
export function buildFlagRejection(
  state: GameState,
  cmd: { col: number; row: number; player: number },
): string | null {
  const site = siteOf(state, cmd);
  if (site === null) return 'no valid player or location.';
  const player = state.players[cmd.player]!;
  if (!canBuildFlag(state, player, cmd.col, cmd.row)) return 'no flag possible here.';
  return null;
}

/**
 * Applies `cmd` to `state` in place. Returns `true` when the command was executed, `false` when it was
 * inadmissible in the current state and was discarded. The caller has to invoke it at a tick boundary.
 */
export function applyCommand(state: GameState, cmd: Command): boolean {
  if (!canApplyCommand(state, cmd)) return false;
  switch (cmd.kind) {
    case 'demolishFlag': {
      const tile = tileAt(state, cmd.col, cmd.row)!;
      demolishFlag(state, tile.objIndex, cmd.col, cmd.row);
      return true;
    }
    case 'placeBuilding': {
      const player = state.players[cmd.player]!;
      return placeBuilding(state, player, cmd.col, cmd.row, cmd.buildingType) !== null;
    }
    case 'demolishRoad': {
      clearRoadPaths(state, cmd.col, cmd.row);
      return true;
    }
    case 'buildFlag': {
      const player = state.players[cmd.player]!;
      return buildFlag(state, player, cmd.col, cmd.row) !== null;
    }
    case 'foundCastle': {
      const player = state.players[cmd.player]!;
      // `action_found_castle` @0x28d1e classifies BEFORE founding and passes the levelling height
      // via `player+0x102`; this port passes it as a parameter.
      const site = classifyBuildSite(state, player, cmd.col, cmd.row);
      foundCastle(
        state,
        player,
        cmd.col,
        cmd.row,
        site.levelingHeight,
        cmd.difficulty ?? player.difficulty,
      );
      return true;
    }
    case 'attachFlagToRoad':
      return attachFlagToRoad(state, cmd.col, cmd.row);
    case 'demolishAtCursor': {
      const player = state.players[cmd.player]!;
      return demolishAtCursor(state, player, cmd.col, cmd.row) !== 'rejected';
    }
    case 'demolishFromBuildMenu':
      return demolishForPendingBuild(state, cmd.col, cmd.row, cmd.pendingType);
    case 'beginRoadBuilding': {
      const player = state.players[cmd.player]!;
      // The cursor BEFORE classifying, as in the original's UI layer: there the map click set it,
      // here the command carries it.
      player.cursorCol = cmd.col;
      player.cursorRow = cmd.row;
      if (!beginRoadBuilding(state, player)) return false;
      // The original fills the permitted directions (`vp+0xd0`) in the drawing pass before the first
      // click arrives. Without them every click would be rejected, so it happens here and the command
      // is complete on its own.
      updateRoadMarkers(state, player);
      return true;
    }
    case 'roadBuildClick':
      return applyRoadBuildClick(state, cmd).applied;
    case 'setInventoryMode': {
      const inv = inventoryAt(state, cmd.col, cmd.row)!;
      if (cmd.group === 'resources') {
        if (cmd.mode === 0) setResourceModeIn(state, inv);
        else if (cmd.mode === 1) setResourceModeStop(state, inv);
        else setResourceModeOut(state, inv);
      } else {
        if (cmd.mode === 0) setSerfModeIn(state, inv);
        else if (cmd.mode === 1) setSerfModeStop(state, inv);
        else setSerfModeOut(state, inv);
      }
      return true;
    }
    case 'callGeologist':
      return sendGeologistToFlag(state, tileAt(state, cmd.col, cmd.row)!.objIndex);
    case 'prepareAttack':
      return applyAttackPrepare(state, cmd).applied;
    case 'adjustAttackCount': {
      const player = state.players[cmd.player]!;
      if (cmd.mode === 'inc') return attackCountIncrement(player);
      if (cmd.mode === 'dec') return attackCountDecrement(player);
      attackCountPreset(player, cmd.bands ?? 1);
      return true;
    }
    case 'launchAttack':
      return applyAttackLaunch(state, cmd).applied;
    case 'scheduleRecall': {
      const player = state.players[cmd.player]!;
      const t = cmd.target;
      if (t.kind === 'map') return scheduleMapRecall(player, t.col, t.row, cmd.delayRow, state.geo);
      if (t.kind === 'building') {
        return scheduleBuildingRecall(player, t.col, t.row, cmd.delayRow, state.geo);
      }
      return scheduleMenuRecall(player, t.index, cmd.delayRow);
    }
    case 'setViewOption':
      toggleViewOption(state, cmd.side, cmd.mask);
      return true;
    case 'cycleMessageLevel':
      cycleViewMessageLevel(state, cmd.side);
      return true;
    case 'noteGameSaved':
      state.saveClocks.quitGrace = SAVE_CLOCK_QUIT_GRACE;
      state.saveClocks.reminder30 = SAVE_CLOCK_REMINDER_30MIN;
      state.saveClocks.reminder60 = SAVE_CLOCK_REMINDER_60MIN;
      return true;
    case 'switchSpectatorPlayer': {
      const target = state.players[cmd.slot];
      if (!target || !target.active) return false; // `bt $0x6 ; je` @0x2bf5f — sound 4 at the caller
      // 16 u32 from `player+0x1df4` == the 64 type bytes. The position column stays, as in the
      // original: the clear touches only the type column, and it is inert without a type != 0.
      target.messageTypes.length = 0;
      target.flags &= ~0x08; // `andb $0xf7` @0x2bf7c — the message wake bit
      return true;
    }
    case 'setDistributionValue':
      writeSliderValue(
        state.players[cmd.player]!,
        { list: cmd.list, index: cmd.index },
        cmd.value & 0xffff,
      );
      return true;
    case 'resetDistributionDefaults':
      return applySettingsDefaults(state.players[cmd.player]!, cmd.screen);
    case 'selectPriorityItem':
      return selectPriorityItem(state.players[cmd.player]!, cmd.list, cmd.slot);
    case 'movePriorityItem':
      return movePriorityItem(state.players[cmd.player]!, cmd.list, cmd.move);
    case 'setKnightOccupation':
      return adjustKnightOccupation(state.players[cmd.player]!, cmd.index, cmd.bound, cmd.delta);
    case 'setCastleGarrisonTarget':
      return adjustKnightMenuValue(state.players[cmd.player]!, cmd.delta);
    case 'setAttackSelection':
      setAttackSelection(state.players[cmd.player]!, cmd.strong);
      return true;
    case 'recruitKnights':
      return applyRecruitKnights(state, cmd).applied;
    case 'startKnightShift':
      startKnightShift(state.players[cmd.player]!);
      return true;
    case 'cancelRoadBuilding': {
      cancelRoadBuilding(state, state.players[cmd.player]!);
      return true;
    }
  }
}

/**
 * Prepare an attack and return the full outcome. The original distinguishes four failures, one of
 * which is SILENT (`notAttackable`, a bare `ret` @0x2a459); the UI layer needs the reason for sound
 * and message.
 */
export function applyAttackPrepare(
  state: GameState,
  cmd: Extract<Command, { kind: 'prepareAttack' }>,
): AttackPrepResult & { readonly applied: boolean } {
  if (!canApplyCommand(state, cmd)) {
    return { ok: false, reason: 'notAttackable', sound: null, applied: false };
  }
  const tile = tileAt(state, cmd.col, cmd.row)!;
  const res = prepareAttack(state, state.players[cmd.player]!, state.buildings[tile.objIndex]!);
  return { ...res, applied: res.ok };
}

/**
 * Launch the attack and return the full outcome. `applied` means "knights are on their way": the two
 * abort branches (no knights chosen, sound 4; no attacking building, silent) do not count as applied,
 * even though the second one closes the window.
 */
export function applyAttackLaunch(
  state: GameState,
  cmd: Extract<Command, { kind: 'launchAttack' }>,
): AttackLaunchResult & { readonly applied: boolean } {
  if (!canApplyCommand(state, cmd)) {
    return { sound: null, closePopup: false, dispatched: 0, applied: false };
  }
  const res = launchAttack(state, state.players[cmd.player]!);
  return { ...res, applied: res.dispatched > 0 };
}

/**
 * Recruit and return the count — the same effect as `applyCommand({kind:'recruitKnights', …})`, only
 * without discarding the number. The original decides the sound from it (`or %ax,%ax ; je` @0x2df10:
 * 0 recruits means sound 4, otherwise sound 2), so the UI layer needs it.
 *
 * `applied` is `recruited > 0`: recruiting nothing is the reject branch in the original.
 */
export function applyRecruitKnights(
  state: GameState,
  cmd: Extract<Command, { kind: 'recruitKnights' }>,
): { readonly recruited: number; readonly applied: boolean } {
  if (!canApplyCommand(state, cmd)) return { recruited: 0, applied: false };
  const recruited = recruitKnights(state, state.players[cmd.player]!, cmd.limit);
  return { recruited, applied: recruited > 0 };
}

/**
 * Apply a road building click and return the full outcome — the same operation as
 * `applyCommand({kind:'roadBuildClick', …})`, only without discarding the information the UI layer
 * needs: sound, "road finished" and the segment count for the status line.
 *
 * `applied` answers ONLY the log question "did the engine accept the click?" — a click on a
 * non-adjacent tile (`sound === null`, `jne 0x2ae59`) and a rejected one (`sound === 4`) count as NOT
 * accepted. That is deliberately the action log's view rather than "did any byte change": in the
 * reject branch after a failed commit the original cancels the build, and that then stands in the
 * state as an operation of its own.
 */
export function applyRoadBuildClick(
  state: GameState,
  cmd: Extract<Command, { kind: 'roadBuildClick' }>,
): RoadClickResult & { readonly applied: boolean } {
  if (!canApplyCommand(state, cmd)) {
    return { sound: null, finished: false, edgeScroll: 0, applied: false };
  }
  const player = state.players[cmd.player]!;
  const res = roadBuildingClick(state, player, cmd.col, cmd.row, {
    special: cmd.special === true,
  });
  return { ...res, applied: res.sound !== null && res.sound !== SOUND_REJECT };
}
