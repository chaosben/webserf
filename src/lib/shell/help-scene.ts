/**
 * THE SAMPLE GAME behind the pictures of the help: a fixed, deterministic game the original dialogs
 * are drawn from, so the help shows the real windows with plausible numbers whether or not a game is
 * running — and the same pictures every time.
 *
 * It is built the way a player would build it: the game start of a campaign level, then buildings
 * and a road through the command layer, then a fixed number of ticks. No field is set by hand, so
 * an engine change that breaks a dialog's subject shows up here (see `help-content.test.ts`).
 *
 * The level is one whose setup record places the human castle (records 15..35, i.e. level ≥ 10):
 * with a free placement the castle would not exist, and with it half of the dialogs.
 */
import { startNewGame } from '../core/engine/new-game.js';
import { applyCommand, type Command } from '../core/engine/commands.js';
import { runTicks } from '../core/engine/tick.js';
import { posOf, colOf, rowOf, neighbor, Direction } from '../core/engine/position.js';
import type { GameState } from '../core/engine/state.js';
import { planRoad, roadPlanCommands } from '../enhancements/road-planner.js';
import { analyzeSoil } from '../core/engine/soil-analysis.js';

/** Campaign level of the sample game. */
export const HELP_SCENE_LEVEL = 15;
/** Ticks between the first buildings and the pictures — long enough for knights and carriers to settle. */
export const HELP_SCENE_TICKS = 20000;
export const HELP_SCENE_PLAYER = 0;

const LUMBERJACK = 2;
const HUT = 11;
const STONECUTTER = 4;

export interface HelpScene {
  readonly state: GameState;
  readonly player: number;
  readonly castle: number;
  readonly castleFlag: number;
  /** A building still under construction, for the construction window. `null` if none could be placed. */
  readonly site: number | null;
  /** The guard hut, occupied or not, for the military window. */
  readonly guardHut: number | null;
  /** Ground analysis around the castle — taken here, because `analyzeSoil` writes the player record. */
  readonly soil: readonly number[];
}

interface Tile {
  readonly col: number;
  readonly row: number;
}

function flagTile(state: GameState, b: Tile): Tile {
  const pos = neighbor(posOf(b.col, b.row, state.geo), Direction.DownRight, state.geo);
  return { col: colOf(pos, state.geo), row: rowOf(pos, state.geo) };
}

/** The first free site around `centre` (in rings, from radius `from`) that takes `type`. */
function place(state: GameState, centre: Tile, type: number, from: number): number | null {
  const { cols, rows } = state.geo;
  for (let r = from; r <= from + 4; r++) {
    for (let dc = -r; dc <= r; dc++) {
      for (let dr = -r; dr <= r; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        const col = (((centre.col + dc) % cols) + cols) % cols;
        const row = (((centre.row + dr) % rows) + rows) % rows;
        const before = state.buildings.length;
        const cmd: Command = { kind: 'placeBuilding', col, row, player: HELP_SCENE_PLAYER, buildingType: type };
        if (!applyCommand(state, cmd)) continue;
        const idx = state.buildings.findIndex(
          (b, i) => i > 0 && b !== null && b !== undefined && b.col === col && b.row === row,
        );
        return idx > 0 ? idx : before;
      }
    }
  }
  return null;
}

function connect(state: GameState, from: Tile, building: number | null): void {
  if (building === null) return;
  const b = state.buildings[building];
  const player = state.players[HELP_SCENE_PLAYER];
  if (!b || !player) return;
  const res = planRoad(state, player, from, flagTile(state, b));
  if (!res.ok) return;
  for (const cmd of roadPlanCommands(res.plan, HELP_SCENE_PLAYER)) {
    if (!applyCommand(state, cmd)) return;
  }
}

/** Builds the sample game. Pure and deterministic — Node can run it as well as the browser. */
export function buildHelpScene(): HelpScene {
  const state = startNewGame({ gameType: 0, levelSetupIndex: HELP_SCENE_LEVEL });
  const p = state.players[HELP_SCENE_PLAYER]!;
  const castle = state.buildings[p.castleBuilding]!;
  const castleFlag = flagTile(state, castle);

  const lumberjack = place(state, castle, LUMBERJACK, 3);
  connect(state, castleFlag, lumberjack);
  const guardHut = place(state, castle, HUT, 5);
  connect(state, castleFlag, guardHut);

  runTicks(state, HELP_SCENE_TICKS);

  // Placed last and left without a road, so it is still a construction site in the picture.
  const site = place(state, castle, STONECUTTER, 3);
  const soil = analyzeSoil(state, p, castle.col, castle.row);

  return {
    state,
    player: HELP_SCENE_PLAYER,
    castle: p.castleBuilding,
    castleFlag: p.castleFlag,
    site,
    guardHut,
    soil,
  };
}

let cached: HelpScene | null = null;

/** The sample game, built once per page. */
export function helpScene(): HelpScene {
  cached ??= buildHelpScene();
  return cached;
}
