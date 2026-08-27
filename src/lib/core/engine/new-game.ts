/**
 * Game start - port of the DOS new-game chain (`new_game_init` @0x4df5, else branch).
 *
 * | Original | here |
 * |---|---|
 * | `apply_game_setup` @0x4feae (already runs in the menu) | {@link resolveGameSetup} |
 * | `init_neighbor_deltas` @0x7ae7 (tail from @0x7d6c) | {@link deriveGameConstants} |
 * | `FUN_000076bb` | {@link resetEntityTables} |
 * | `FUN_00007874` | `map-generator.ts` |
 * | `init_players` @0x66e9 | {@link initPlayers} |
 * | `place_player_castles` @0x5000 | {@link placePlayerCastles} |
 * | `set_player_castle_pos` @0x5309 | {@link setPlayerCastlePos} |
 * | `place_scenario_military_building` @0x53e7 | {@link placeScenarioMilitaryBuilding} |
 * | `FUN_0000bb05` | {@link resetGameClocks} |
 *
 * `place_player_castles` does not look for a castle site - it FOUNDS the prescribed ones. Each setup
 * record carries one tile per player; if the column byte is negative nothing happens, and the human
 * places his castle by hand while the AI stays in state 0 and searches for itself. That is why
 * {@link setPlayerCastlePos} gives an AI with a prescribed site the same state and counter as the AI
 * founding state: it skips its own search.
 *
 * The player description is `[face, supply, intelligence, reproduction]`. For the HUMAN player the
 * original writes face and intelligence as literals, and intelligence 40 is chosen so that the AI rate
 * `40 * 1300 + 13535` is exactly 65535, the u16 ceiling - hence humans always carry `0xFF 0xFF` there.
 *
 * The tail of `init_neighbor_deltas` derives four header fields from map size and player count:
 *
 * ```
 * pensum           = (cols >> 5) * (rows >> 5)
 * serfBudget       = pensum * 500                       -> header @176
 * populationBase   = serfBudget >> 3                    -> header @198
 * populationSpan   = serfBudget - populationBase * n    -> header @182
 * goldMoraleFactor = n * 0x2800                         -> header @200
 * serviceBudget    = SERVICE_BUDGET[mapSize]            -> header @192
 * ```
 *
 * Deliberately missing:
 * - `FUN_000057ba` rebuilds the spiral offset table into byte offsets of the current map. This port
 *   keeps the spiral as column/row deltas and is therefore map-size independent.
 * - `warehouseLimit` (header @178) falls out of the DOS memory layout in the original (inventory
 *   capacity being the free heap divided by the record size). That is a machine artefact, not a game
 *   value, so {@link deriveGameConstants} writes the observed constant; the heap dependency stays open.
 * - Window layout and frame graphics, which the UI layer does itself.
 */
import { mapGeometry, posOf, neighbor, Direction, type MapGeometry } from './position.js';
import { u16 } from './int.js';
import { Rng } from './rng.js';
import {
  deriveMapSeed,
  generateMapSteps,
  mapByteOffset,
  sumMapGold,
  type MapGenBuffer,
} from './map-generator.js';
import { loadState, type GameState, type Player, type Tile } from './state.js';
import { foundCastle } from './founding.js';
import { AI_SETTLE_IN_TICKS, AI_STATE_SETTLE_IN } from './ai-tick.js';
import { classifyBuildSite, placeBuilding } from './build-site.js';
import { recomputeTerritory } from './territory.js';
import { SETTINGS_DEFAULTS } from './player-settings.js';
import { growMax, allocBuilding, allocFlag } from './alloc.js';
import { createSerf } from './economy.js';
import {
  SETUP_RECORDS,
  CASTLE_POS_UNSET,
  HUMAN_FACE,
  HUMAN_FACE_2,
  setupRecordIndex,
} from '../player-setup.js';
import { SERF_STATE_NAMES, SERF_TYPE_NAMES, BUILDING_TYPE_NAMES } from '../save-parser.js';
import type { SaveGameHeader, SaveGameState, PlayerRecord, MenuPlayerSetup } from '../types.js';
import { clearFlagAcceptBytes } from './flag-accept.js';
import { VIEW_OPTIONS_DEFAULT } from './view-options.js';

// ── Game types ───────────────────────────────────────────────────────────────────────────────────

/**
 * The five values of `gs+0x352` (`.DS`@74), from the three branches of `apply_game_setup` (`< 2` uses
 * a setup record, `== 3` adds a second human, `== 4` has no human) and the menu string
 * `1 SPIELER · 2 SPIELER · DEMO` @0x4f162.
 */
export const GAME_TYPE = {
  /** Numbered level with password — record `levelSetupIndex + 5`. */
  Level: 0,
  /** Campaign mission — record `missionSetupIndex - 1`. */
  Mission: 1,
  /** Free game, one human. */
  FreeOnePlayer: 2,
  /** Free game, two humans (split screen). */
  FreeTwoPlayers: 3,
  /** Demo — no human player. */
  Demo: 4,
} as const;

/**
 * Spectator game (`gs+0x37e` bit 5). Set only by the game-start initialisation
 * (`cmpw $0x4,0x352(%ebx)` @0x4fe75), so it is a property of the match, not a runtime setting. It is
 * read in 30 places, which fall into three groups:
 *
 * - blocking — the control bar shows only two passive icons (@0x331b2) and the fast build click ends
 *   in a bare `ret` (@0x29f45). No build action is reachable any more; there is no separate
 *   "you may not do that" branch.
 * - permitting — the owner check of the special click is skipped (@0x2a042 buildings, @0x2a18f
 *   flags): the spectator may look into ANY building.
 * - cosmetic — one omitted sound (@0x29faf), different zone tables in eleven popup places and nine
 *   places in the renderer.
 */
export function isSpectatorGame(gameType: number): boolean {
  return gameType === GAME_TYPE.Demo;
}

/**
 * Intelligence literal of the human player (`mov $0x28,%al`). 40 is not arbitrary:
 * `40 · 1300 + 13535 == 65535`, so the AI rate saturates exactly.
 */
export const HUMAN_INTELLIGENCE = 0x28;

/** `[face, supply, intelligence, reproduction]` — the four bytes at `gs+0x1d6 + 4·slot`. */
export type PlayerDescriptor = readonly [number, number, number, number];

/** An empty slot: face 0. Nobody reads the other three bytes then. */
const EMPTY_DESCRIPTOR: PlayerDescriptor = [0, 0, 0, 0];

// ── Setup (apply_game_setup @0x4feae) ────────────────────────────────────────────────────────────

/** Input of the game start — the main menu state in the original. */
export interface NewGameSetup {
  /** `gs+0x352`, see {@link GAME_TYPE}. */
  readonly gameType: number;
  /** Only `gameType == 1`. */
  readonly missionSetupIndex?: number;
  /** Only `gameType == 0`. */
  readonly levelSetupIndex?: number;
  /**
   * Only `gameType == 0` — the highest unlocked level (`gs+0x358`). The game start does not write it;
   * in the original it is simply already there and is saved to `.DS`@126. It belongs in the setup
   * anyway because menu and game are separate states here: without it the running state would not
   * carry the number, and the "QUIT/YES" exit could not raise it. Defaults to
   * {@link levelSetupIndex}, which would unlock only the level being played.
   */
  readonly levelSetupShown?: number;
  /**
   * The campaign password (`gs+0x35a`, `.DS`@128) the menu carried in. The game start does **not**
   * write this cell in the original — it is global memory and simply still holds whatever the menu
   * had — so in the port the menu value must travel along, otherwise the running header would lose it
   * and a save would carry nothing.
   *
   * It is deliberately NOT derived from the level: two original saves prove the two can differ (level
   * 6 with the password of level 29 — typed a password, then paged the level back down; the level
   * choice A2/A3 has no writer for this cell).
   */
  readonly levelPassword?: string;
  /** Only `gameType > 1` (`gs+0x362`); with setup records the size is fixed at 3. */
  readonly mapSize?: number;
  /** Only `gameType > 1` (`gs+0x364..0x368`) — the raw seed BEFORE the XOR mask. */
  readonly seed?: readonly [number, number, number];
  /**
   * Only `gameType > 1`: the four menu columns `gs+0x36a` (face), `0x36e` (intelligence), `0x372`
   * (supply), `0x376` (reproduction). A slot with face 0 stays empty.
   */
  readonly menuPlayers?: readonly PlayerDescriptor[];
  /**
   * Only `gameType` 2 or 3: supply and reproduction of the HUMAN players, in the original the
   * separate fields `gs+0x37a/0x37c` (human 1) and `gs+0x37b/0x37d` (human 2).
   */
  readonly humanSupplies?: readonly [number, number];
  readonly humanReproduction?: readonly [number, number];
  /**
   * View options `gs+0x3d8`/`0x3d9` as a starting value. They are a save-game field (`.DS`@72/73) but
   * global in the original and preloaded from the config file, so a new game inherits whatever the
   * player last set. Without one, the factory default (`mov $0x39,%al` @0x2e0f/@0x2e1a).
   */
  readonly viewOptions?: readonly [number, number];
}

/** Result of {@link resolveGameSetup} — the contents of `gs+0x1d6..0x1f2`. */
export interface ResolvedSetup {
  /** Four player descriptors (`gs+0x1d6 + 4·slot`). */
  readonly descriptors: readonly PlayerDescriptor[];
  /** Four prescribed castle tiles (`gs+0x1e6 + 2·slot`); column >= 0x80 means none. */
  readonly castles: readonly (readonly [number, number])[];
  /** RNG start state of the generator (`gs+0x1ee..0x1f2`, so AFTER the XOR mask). */
  readonly mapSeed: readonly [number, number, number];
  /** Map size (`gs+0x50`, the original routine's return value). */
  readonly mapSize: number;
  /**
   * The RAW seed as it remains in `gs+0x364..0x369`, i.e. before the XOR mask. Only set in the menu
   * branch: with a level or mission the seed comes from the setup record and `apply_game_setup` does
   * not write the field there (the loader does not read it either, `jb 0x48010` @0x47f60). The save
   * game carries it (`.DS`@138), which is the only thing that makes a free map reproducible.
   */
  readonly rawSeed?: readonly [number, number, number];
  /**
   * The world size chosen in the menu (`gs+0x362`, `.DS`@136) — the same number as {@link mapSize},
   * but likewise only set in the menu branch (a leftover with level/mission).
   */
  readonly sizeChoice?: number;
}

/**
 * `apply_game_setup` @0x4feae — turns the game type into player descriptors, castle sites and seed.
 *
 * Three branches as in the original: `gameType < 2` reads the setup record, otherwise everything
 * comes from the menu, where `gameType == 4` (demo) takes slot 0 from the menu too and
 * `gameType == 3` pins slot 1 to the second human. The XOR mask at the end applies to ALL branches.
 */
export function resolveGameSetup(setup: NewGameSetup): ResolvedSetup {
  const descriptors: PlayerDescriptor[] = [
    EMPTY_DESCRIPTOR,
    EMPTY_DESCRIPTOR,
    EMPTY_DESCRIPTOR,
    EMPTY_DESCRIPTOR,
  ];
  let castles: (readonly [number, number])[] = [
    [CASTLE_POS_UNSET, CASTLE_POS_UNSET],
    [CASTLE_POS_UNSET, CASTLE_POS_UNSET],
    [CASTLE_POS_UNSET, CASTLE_POS_UNSET],
    [CASTLE_POS_UNSET, CASTLE_POS_UNSET],
  ];
  let rawSeed: readonly [number, number, number];
  let mapSize: number;

  if (setup.gameType < 2) {
    // ── setup record branch (`cmpw $0x2,0x352` @0x4feb1) ─────────────────────────────────────
    const index = setupRecordIndex(
      setup.gameType,
      setup.missionSetupIndex ?? 0,
      setup.levelSetupIndex ?? 0,
    );
    const rec = SETUP_RECORDS[index];
    if (!rec) {
      throw new Error(
        `game type ${setup.gameType} addresses setup record ${index}, which does not exist`,
      );
    }
    for (let p = 0; p < 4; p++) descriptors[p] = rec.players[p] ?? EMPTY_DESCRIPTOR;
    castles = rec.castles.map((c) => [c[0], c[1]] as const);
    rawSeed = rec.seed;
    mapSize = SETUP_RECORD_MAP_SIZE; // return value 3 of the `gameType < 2` branch
  } else {
    // ── menu branch ──────────────────────────────────────────────────────────────────────────
    const menu = setup.menuPlayers ?? [];
    const supplies = setup.humanSupplies ?? [0, 0];
    const repro = setup.humanReproduction ?? [0, 0];
    for (let p = 0; p < 4; p++) descriptors[p] = menu[p] ?? EMPTY_DESCRIPTOR;

    if (setup.gameType === GAME_TYPE.Demo) {
      // demo: slot 0 is an ordinary menu slot, there is no human
      descriptors[0] = menu[0] ?? EMPTY_DESCRIPTOR;
    } else {
      // otherwise slot 0 is the human: face and intelligence are literals
      descriptors[0] = [HUMAN_FACE, supplies[0], HUMAN_INTELLIGENCE, repro[0]];
    }
    if (setup.gameType === GAME_TYPE.FreeTwoPlayers) {
      // `gameType == 3`: slot 1 is the second human
      descriptors[1] = [HUMAN_FACE_2, supplies[1], HUMAN_INTELLIGENCE, repro[1]];
    }
  // Castle sites stay `0xff` — in a free game everybody places his own.
    rawSeed = setup.seed ?? [0, 0, 0];
    mapSize = setup.mapSize ?? SETUP_RECORD_MAP_SIZE;
  }

  // The two menu fields exist only in the menu branch, see `rawSeed` in {@link ResolvedSetup}.
  const fromMenu = setup.gameType >= 2;
  return {
    descriptors,
    castles,
    mapSeed: deriveMapSeed(rawSeed),
    mapSize,
    ...(fromMenu ? { rawSeed, sizeChoice: mapSize } : {}),
  };
}

/** Map size of the setup records — return literal 3 of the `gameType < 2` branch. */
export const SETUP_RECORD_MAP_SIZE = 3;

// ── Derived constants (init_neighbor_deltas tail @0x7d6c) ────────────────────────────────────────

/**
 * `serviceBudget` per map size — table `@0x7eb3`, indexed by `gs+0x50`. Index 0 still lies inside the
 * code before it and is never read; carried as 0 here.
 */
export const SERVICE_BUDGET: readonly number[] = [0, 16, 30, 55, 90, 150, 220, 350];

/** `warehouseLimit` (header @178) — a memory-layout artefact, see the module header. */
export const WAREHOUSE_LIMIT = 361;

/** The header fields derived from map size and player count. */
export interface GameConstants {
  readonly serfBudget: number;
  readonly populationBase: number;
  readonly populationSpan: number;
  readonly mapGoldMoraleFactor: number;
  readonly serviceBudget: number;
  readonly warehouseLimit: number;
}

/**
 * Tail of `init_neighbor_deltas` (@0x7d6c..@0x7e6e) — the four quantities that tie economy and
 * population to the map. Formulas in the module header; read from the ASM (`mul $0x1f4` @0x7db2,
 * `shrw $0x3` @0x7ddb, `sub %ax,(%edi)` @0x7e5a, `mov $0x2800,%ax` @0x7e67).
 */
export function deriveGameConstants(
  geo: MapGeometry,
  descriptors: readonly PlayerDescriptor[],
): GameConstants {
  const quota = (geo.cols >> 5) * (geo.rows >> 5); // gs+0x21c
  const serfBudget = u16(quota * 500);
  const populationBase = serfBudget >> 3;
  // Counts the four face bytes @0x7df6/@0x7e08/@0x7e1a/@0x7e2c.
  const playerCount = descriptors.filter((d) => (d[0] & 0xff) !== 0).length;
  return {
    serfBudget,
    populationBase,
    populationSpan: u16(serfBudget - u16(populationBase * playerCount)),
    mapGoldMoraleFactor: u16(playerCount * 0x2800),
    serviceBudget: SERVICE_BUDGET[geo.mapSize] ?? 0,
    warehouseLimit: WAREHOUSE_LIMIT,
  };
}

// ── AI character traits (FUN_00006d2b @0x6d2b) ───────────────────────────────────────────────────

/**
 * The six trait tables `@0x6dcc`, `@0x6de2`, `@0x6df8`, `@0x6e0e`, `@0x6e24`, `@0x6e3a` — 11 u16 each,
 * indexed by `face - 1`. They lie back to back with no gap and end exactly at the next function
 * entry: `0x6dcc + 6 · 22 == 0x6e50 == draw_panel_wood_frame`. That pins row and column count in one
 * go without reading any code. Nothing changes them after init.
 */
export const AI_TRAITS = {
  /** `@0x6dcc` -> `player+0x18e` (block 526) — cap of the knight occupation level. */
  occupationCap: [13, 10, 16, 9, 10, 8, 6, 10, 12, 5, 8],
  /** `@0x6de2` -> `player+0x190` (block 528) — knight demand when attacking. */
  attackKnightFactor: [10000, 13000, 16000, 16000, 18000, 20000, 19000, 18000, 30000, 23000, 26000],
  /** `@0x6df8` -> `player+0x192` (block 530) — attack inclination. */
  attackChanceFactor: [10000, 35000, 20000, 27000, 37000, 25000, 40000, 30000, 50000, 35000, 40000],
  /** `@0x6e0e` -> `player+0x194` (block 532) — mask of preferred target kinds. */
  attackTargetMask: [0, 36, 0, 31, 8, 480, 3, 16, 0, 193, 39],
  /** `@0x6e24` -> `player+0x196` (block 534) — inclination to send the stronger knights. */
  attackStrongChance: [0, 30000, 5000, 40000, 50000, 20000, 45000, 35000, 65000, 25000, 30000],
  /** `@0x6e3a` -> `player+0x198` (block 536) — cap of the guard hut urgency. */
  hutUrgencyCap: [60000, 61000, 60000, 65400, 63000, 62000, 65000, 63000, 64000, 64000, 64000],
} as const;

/**
 * `FUN_00006d2b` — set the six traits of an AI character. The only caller is `init_players`, gated on
 * face != 0 AND < 0x0c (`cmpb $0xc` @0x6af5), so a human never gets them.
 */
export function applyAiTraits(player: Player, face: number): void {
  const i = face - 1;
  player.aiOccupationCap = AI_TRAITS.occupationCap[i] ?? 0;
  player.aiAttackKnightFactor = AI_TRAITS.attackKnightFactor[i] ?? 0;
  player.aiAttackChanceFactor = AI_TRAITS.attackChanceFactor[i] ?? 0;
  player.aiAttackTargetMask = AI_TRAITS.attackTargetMask[i] ?? 0;
  player.aiAttackStrongChance = AI_TRAITS.attackStrongChance[i] ?? 0;
  player.aiHutUrgencyCap = AI_TRAITS.hutUrgencyCap[i] ?? 0;
}

// ── init_players @0x66e9 ─────────────────────────────────────────────────────────────────────────

/** Rotation wrap without any AI player (`mov $0x21,%ax` @0x66ff). */
export const ROTATION_WRAP_NO_AI = 0x21;
/** Rotation wrap WITH at least one AI (`mov $0x31,%ax` @0x6818) — the 49 of every original state. */
export const ROTATION_WRAP_WITH_AI = 0x31;

/** Faces BELOW this value are AI characters (`cmpb $0xc` @0x67d9). */
const AI_FACE_LIMIT = HUMAN_FACE;

/**
 * A fully zeroed player record — the `memset` over `player-0x80 .. +0x2133` (0x21b4 bytes == the block
 * size 8628, counter `mov $0x21b3,%ax` @0x6771). Whatever `init_players` does NOT write afterwards
 * stays 0, and this function makes that explicit.
 */
export function createEmptyPlayer(slot: number): Player {
  const zeros = (n: number): number[] => new Array<number>(n).fill(0);
  const record: PlayerRecord = {
    slot,
    index: 0,
    active: false,
    flags: 0,
    build: 0,
    difficulty: 0,
    messageFlags: 0,
    heldPlanks: 0,
    heldStone: 0,
    hintReturnDelay: 0,
    messageBuildingSlots: zeros(3),
    completedBuildingCount: zeros(23),
    incompleteBuildingCount: zeros(23),
    serfCount: zeros(27),
    resourceCount: zeros(26),
    toolPriority: zeros(9),
    flagPriority: zeros(26),
    inventoryPriority: zeros(26),
    knightOccupation: zeros(4),
    totalLandScore: 0,
    totalBuildingScore: 0,
    totalMilitaryScore: 0,
    castleCaptureBalance: 0,
    castleBuilderSerf: 0,
    genericRequestCooldown: 0,
    knightShiftTimer: 0,
    castleRequestCooldown: 0,
    goldAccumulator: 0,
    militaryGoldCapacity: 0,
    militaryGoldAccumulator: 0,
    militaryStrengthRatio: 0,
    goldMorale: 0,
    goldDeposited: 0,
    knightMenuValue: 0,
    knightMenuCounter: 0,
    castleBuilding: 0,
    castleFlag: 0,
    castleInventory: 0,
    lastTick: 0,
    reproductionCounter: 0,
    reproductionReset: 0,
    serfToKnightRate: 0,
    serfToKnightCounter: 0,
    attackingBuildingCount: 0,
    totalAttackingKnights: 0,
    buildingAttacked: 0,
    attackingBuildings: [],
    attackingKnights: zeros(4),
    knightsAttacking: 0,
    currentSett5Item: 0,
    currentSett6Item: 0,
    cursorCol: 0,
    cursorRow: 0,
    contSearchAfterNonOptimalFind: 0,
    knightsToSpawn: 0,
    analysis: zeros(4),
    foodDistribution: zeros(4),
    planksDistribution: zeros(3),
    steelDistribution: zeros(2),
    coalDistribution: zeros(3),
    wheatDistribution: zeros(2),
    messageTypes: [],
    messagePositions: [],
    recallCount: 0,
    recallQueue: Array.from({ length: 64 }, () => ({
      remaining: 0,
      payload: 0,
    })),
    aiRate: 0,
    aiState: 0,
    aiCounter: 0,
    aiCandidates: Array.from({ length: 35 }, () =>
      Array.from({ length: 8 }, () => ({ score: 0, col: 0, row: 0 })),
    ),
    aiSupplyRatio: zeros(21),
    aiIdleSerfs: zeros(27),
    aiStockpile: zeros(26),
    aiUrgency: zeros(25),
    aiPressure: zeros(25),
    aiPressureCatchUp: 0,
    aiBuildingCursor: 0,
    aiRoadJob540: 0,
    aiRoadJob542: 0,
    aiRoadJob548: 0,
    aiRoadJob550: 0,
    aiRoadJob552: 0,
    aiRoadJob570: 0,
    aiFlagSweepCursor: 0,
    aiLossRegister: Array.from({ length: 8 }, () => ({ col: 0, row: 0 })),
    aiOccupationCap: 0,
    aiAttackKnightFactor: 0,
    aiAttackChanceFactor: 0,
    aiAttackTargetMask: 0,
    aiAttackStrongChance: 0,
    aiHutUrgencyCap: 0,
    aiKnightOccupationLevel: 0,
    aiKnightTotal: 0,
    aiShiftCooldown: 0,
    aiTimer562: 0,
    statHistory: [],
    resourceHistory: [],
  };
  return record as Player;
}

/**
 * `init_players` @0x66e9 — build the four player records from the descriptors.
 *
 * Returns the rotation wrap the routine settles on: `0x21` without any AI (@0x66ff), `0x31` as soon as
 * one slot carries an AI face. That every original state shows 49 therefore means "at least one AI".
 *
 * Not obvious: the initialisations at the end are not redundant, because two tables go to `0xffff`
 * rather than 0 — the BUILD PRESSURE (block 1154, 25 × `0xffff` @0x6ba2) starts SATURATED, which is
 * why the AI wants to build immediately, and the loss register (block 572, 8 × `0xffffffff` @0x6c6f)
 * starts empty.
 */
export function initPlayers(
  players: (Player | null)[],
  descriptors: readonly PlayerDescriptor[],
): { rotationWrap: number } {
  let rotationWrap = ROTATION_WRAP_NO_AI; // @0x66ff
  // The gate @0x6710 ("game type 2 and the three opponent slots empty") only writes `gs+0x5e` and
  // `gs+0x381`, and both got the same values two instructions earlier — the branch has no effect, so
  // it is not reproduced here. `newGameHeader` sets those two fields.

  for (let slot = 0; slot < 4; slot++) {
    const desc = descriptors[slot] ?? EMPTY_DESCRIPTOR;
    const player = createEmptyPlayer(slot);
    players[slot] = player;

    const face = desc[0] & 0xff;
    if (face === 0) continue; // `je 0x6c84` @0x67bf — an empty slot stays zeroed

    player.active = true; // `bts $0x6` on `player+2` @0x67cd
    player.flags = 0x40;
    if (face < AI_FACE_LIMIT) {
      player.flags |= 0x80; // `bts $0x7,%ax` @0x67e7 — AI player
      player.aiState = 0; // @0x67f9 — state 0: look for a castle site
      player.aiBuildingCursor = 0; // @0x6806
      player.aiFlagSweepCursor = 0; // @0x6812
      rotationWrap = ROTATION_WRAP_WITH_AI; // @0x6818
    }
    player.index = slot; // @0x682c

    // messageFlags: first 0, then bit 0 — hint messages off (from @0x682f).
    player.messageFlags = 1;
    player.build = 0;
    player.cursorCol = 0;
    player.cursorRow = 0;
    player.contSearchAfterNonOptimalFind = 7; // `mov $0x7,%ax` @0x68b0
    player.knightsToSpawn = 0;
    player.serfToKnightRate = 20000; // `mov $0x4e20,%ax` @0x6914
    player.serfToKnightCounter = 0x8000; // `mov $0x8000,%ax` @0x6922
    player.knightOccupation = [0x10, 0x21, 0x32, 0x43]; // @0x6930..@0x6948

    // The six `default_*` routines (@0x6952..@0x696b) — the same ones the "default" button of the
    // distribution menus calls, hence the same table as in `player-settings.ts`.
    player.foodDistribution = [...SETTINGS_DEFAULTS.food];
    player.planksDistribution = [...SETTINGS_DEFAULTS.planks];
    player.steelDistribution = [...SETTINGS_DEFAULTS.steel];
    player.coalDistribution = [...SETTINGS_DEFAULTS.coal];
    player.wheatDistribution = [...SETTINGS_DEFAULTS.wheat];
    player.toolPriority = [...SETTINGS_DEFAULTS.tools];
    player.flagPriority = [...SETTINGS_DEFAULTS.flagPriority];
    player.inventoryPriority = [...SETTINGS_DEFAULTS.inventoryPriority];

    player.currentSett5Item = 8; // `mov $0x8,%ax` @0x6970
    player.currentSett6Item = 0xf; // `mov $0xf,%ax` @0x697e
    player.knightMenuValue = 3; // `mov $0x3,%ax` @0x69ba — target of the castle garrison
    player.knightMenuCounter = 0;

    // The three descriptor bytes (@0x6a2d..@0x6ad5).
    player.difficulty = desc[1] & 0xff;
    player.reproductionReset = u16((0x3c - ((desc[3] << 24) >> 24)) * 0x32);
    player.reproductionCounter = player.reproductionReset; // @0x6d68 — counter == reload value
    player.aiRate = u16(((desc[2] & 0xff) * 0x514 + 0x34df) & 0xffff);
    if (face !== 0 && face < AI_FACE_LIMIT) applyAiTraits(player, face); // `cmpb $0xc` @0x6af5

    // 25 × `0xffff`: the build pressure starts saturated.
    player.aiPressure = new Array<number>(25).fill(0xffff); // `mov $0xffff,%ax` @0x6ba2
    // 8 × `0xffffffff`: empty loss register (@0x6c6f) — `col`/`row` are the two halves.
    player.aiLossRegister = Array.from({ length: 8 }, () => ({
      col: 0xffff,
      row: 0xffff,
    }));
    // The two history grids are zeroed but present (@0x6bcb/@0x6bf1).
    player.statHistory = Array.from({ length: 16 }, () => new Array<number>(112).fill(0));
    player.resourceHistory = Array.from({ length: 26 }, () => new Array<number>(120).fill(0));
  }
  // OPEN @0x6c9c — the tail of the routine (`bt $0x6` @0x6ca4 on `gs+0x37e` = split screen,
  // `je 0x6d28` skips it) copies SIX fields of player 0 to `gs+0x172..0x17a`: cursorCol, cursorRow,
  // cursorType, buildPossibility, levelingHeight and the `build` byte. That is the parked cursor
  // storage of the second split-screen player and it lives in the save game at `.DS`@164..173; the
  // two mirror routines `FUN_000174ec` / `FUN_000175d6` swap it in and out.
  //
  // Not ported because this clone has one viewport and one player cursor — without split screen the
  // branch never runs in the original either, and across 43 states all six fields are 0.
  return { rotationWrap };
}

// ── place_player_castles @0x5000 ─────────────────────────────────────────────────────────────────

/**
 * `set_player_castle_pos` @0x5309 — found the prescribed castle site of one player.
 *
 * The gate is a SIGN test on the column byte (`or %al,%al` @0x5317, `js 0x53e6` @0x5319): `0xff` means
 * "not prescribed", and then the routine does NOTHING — no cursor, no state change, no founding.
 * That is exactly how the human comes to place his own castle and the AI stays in state 0.
 *
 * The two viewport branches (@0x5360/@0x538f, "if this viewport belongs to the player, centre it on
 * the tile") belong to the UI layer; this clone has one viewport and sets its camera on game start.
 */
export function setPlayerCastlePos(
  state: GameState,
  player: Player,
  pos: readonly [number, number],
): boolean {
  const col = pos[0] & 0xff;
  if ((col & 0x80) !== 0) return false; // `js 0x53e6` @0x5319 — not prescribed
  const row = pos[1] & 0xff;

  player.cursorCol = col; // `mov %ax,0xfc(%ebx)` @0x5336
  player.cursorRow = row; // `mov %ax,0xfe(%ebx)` @0x5344

  // OPEN @0x5360 and @0x538f — the two viewport comparisons that centre the view on the castle. Not
  // ported HERE because the viewport state lives in the UI layer, but the SEMANTICS are reproduced
  // there: the view centres via `player.castleBuilding` on THIS player's castle, not on the first
  // entry of the building table (if the AI founds first its castle is index 1, and without the owner
  // reference the camera would jump to the opponent). The `jne` branch @0x5392 leads to the same
  // exit as the success case.

  if ((player.flags & 0x80) !== 0) {
    // `bt $0x7` @0x53b1 — an AI with a prescribed site skips its own search and goes straight into
    // the settle-in phase, with the same counter value as `aiFoundCastleState`.
    player.aiState = AI_STATE_SETTLE_IN; // `mov $0x1,%ax` @0x53bd
    player.aiCounter = AI_SETTLE_IN_TICKS; // `mov $0x18,%ax` @0x53cb
  }

  // `call 0x32075` @0x53dc + `call 0x28dde` @0x53e1: classify, then found. The classification yields
  // the LEVELLING HEIGHT with which `found_castle` flattens the seven site tiles — without it the
  // castle flag sits askew relative to the castle.
  const site = classifyBuildSite(state, player, col, row);
  foundCastle(state, player, col, row, site.levelingHeight, player.difficulty);
  return true;
}

/** The seven tiles the scenario branch assigns to player 1 — centre plus all six neighbours. */
const SCENARIO_LAND_CENTER: readonly [number, number] = [0x14, 0x1a];

/** Owner bits the scenario branch sets: `& 0x1f` then `| 0xa0`, so owner index 1 == slot 1. */
const SCENARIO_LAND_OWNER = 1;

/** The four preset military buildings of the scenario (`gs+0x27a` and cursor per call). */
const SCENARIO_BUILDINGS: readonly {
  readonly col: number;
  readonly row: number;
  readonly type: number;
}[] = [
  { col: 0x14, row: 0x1a, type: 0x0b }, // @0x5240/@0x524e/@0x525c -> `call 0x53e7` @0x526d — hut
  { col: 0x15, row: 0x21, type: 0x16 }, // @0x5272/@0x5280/@0x528e -> @0x529f — fortress
  { col: 0x19, row: 0x22, type: 0x15 }, // @0x52a4/@0x52b2/@0x52c0 -> @0x52d1 — tower
  { col: 0x1e, row: 0x26, type: 0x0b }, // @0x52d6/@0x52e4/@0x52f2 -> @0x5303 — hut
];

/** Garrison size per scenario building and the state of the knight moving in (@0x5515..@0x555c). */
const SCENARIO_GARRISON: Record<number, { readonly knights: number; readonly serfState: number }> =
  {
    0x0b: { knights: 3, serfState: 0x46 }, // `mov $0x3` @0x5540 / `mov $0x46` @0x5548
    0x15: { knights: 6, serfState: 0x47 }, // `mov $0x6` @0x5554 / `mov $0x47` @0x555c
    0x16: { knights: 12, serfState: 0x48 }, // `mov $0xc` @0x552c / `mov $0x48` @0x5534
  };

/**
 * `place_scenario_military_building` @0x53e7 — place a FINISHED, OCCUPIED military building.
 *
 * Called only from the scenario branch. The flow is the ordinary build (`classify_build_site` +
 * `place_building_record`), but three things are then done by hand that construction would otherwise
 * take hours to do: `bts $0x4` on `bld+5` (active, @0x54b3), `andb $0x7f,0x4` (FINISHED, @0x54c2, the
 * constructing bit drops) and the flag's accept bytes are cleared. Then 3/6/12 knights move in, with
 * the owner bits pinned to player 1 (`mov $0x59,%al` @0x5588), so the scenario cannot be moved to
 * another slot.
 */
export function placeScenarioMilitaryBuilding(
  state: GameState,
  player: Player,
  col: number,
  row: number,
  type: number,
): boolean {
  player.cursorCol = col;
  player.cursorRow = row;
  const bld = placeBuilding(state, player, col, row, type);
  if (!bld) return false; // cannot fail in the original: the map is made for it

  bld.active = true; // `bts $0x4,%ax` on `bld+5` @0x54b3
  bld.constructing = false; // `andb $0x7f,0x4(%ebx)` @0x54c2
  bld.progress = 0;
  // `mov $0x46,%ax ; mul %cx ; add gs+0x98 ; mov %eax,0xe(%ebx)` @0x54d0..@0x54f8 — the same union
  // repurposing as on completion by the builder (@0x25635): from now on that field holds the flag
  // pointer, base-relative `index · 70`.
  bld.level = (bld.flag * 70) & 0xffff;
  // Catch up the construction counters: the building is finished, not under construction.
  player.incompleteBuildingCount[type - 1] = Math.max(
    0,
    (player.incompleteBuildingCount[type - 1] ?? 0) - 1,
  );
  player.completedBuildingCount[type - 1] = (player.completedBuildingCount[type - 1] ?? 0) + 1;

  const flag = state.flags[bld.flag];
  if (flag) {
    clearFlagAcceptBytes(flag); // `mov %al,0x42(%ebx)` @0x5507 · `0x44` @0x550f
  }

  const spec = SCENARIO_GARRISON[type];
  if (!spec) return true; // the scenario has only the three military types
  bld.holder = true;
  for (let i = 0; i < spec.knights; i++) {
    const knight = createScenarioKnight(state, player, bld.col, bld.row, spec.serfState);
    // Garrison chain: the new knight becomes head, the old head his successor (@0x55a4).
    knight.stateData = [0, 0, 0, bld.firstKnight & 0xff, (bld.firstKnight >> 8) & 0xff];
    bld.firstKnight = knight.index;
    bld.stock[0] = {
      available: (bld.stock[0]?.available ?? 0) + 1,
      requested: bld.stock[0]?.requested ?? 0,
    };
  }

  recomputeTerritory(state, col, row); // `call 0x45a30` @0x55e6
  return true;
}

/** A scenario knight (`call 0x457dc` @0x5566 plus the five fields up to @0x558d). */
function createScenarioKnight(
  state: GameState,
  player: Player,
  col: number,
  row: number,
  serfState: number,
) {
  let idx = 1;
  while (state.serfs[idx]) idx++;
  const KNIGHT0 = 22;
  const serf = {
    index: idx,
    owner: player.slot, // literal 0x59 in the original: owner 1, the scenario runs for slot 1 only
    type: KNIGHT0,
    typeName: SERF_TYPE_NAMES[KNIGHT0] ?? String(KNIGHT0),
    sound: false,
    animation: 0,
    counter: 6000, // `mov $0x1770,%ax` @0x557d
    col,
    row,
    tick: state.gameTick,
    state: serfState,
    stateName: SERF_STATE_NAMES[serfState] ?? String(serfState),
    stateData: [0, 0, 0, 0, 0],
  };
  state.serfs[idx] = serf as unknown as NonNullable<GameState['serfs'][number]>;
  growMax(state.serfs, idx, state.blockMeta.serfs, (v) => (state.header.maxSerfIndex = v));
  state.serfBudget = u16(state.serfBudget - 1);
  player.serfCount[KNIGHT0] = (player.serfCount[KNIGHT0] ?? 0) + 1; // `addw $0x1,-0xe(%ebx)` @0x5592
  player.totalMilitaryScore = player.totalMilitaryScore + 1; // `addl $0x1,0x11a(%ebx)` @0x559a
  return state.serfs[idx]!;
}

/**
 * `place_player_castles` @0x5000 — found the prescribed castles.
 *
 * Two parts: {@link setPlayerCastlePos} for all four slots, then a SINGLE conditional branch
 * (`gameType == 1 && missionSetupIndex == 6`, @0x5080/@0x5091) with the hand-written scenario of
 * mission 6: seven tiles go to player 1, who gets a head start (scores 7/29/0, full occupation
 * levels) and four finished, occupied military buildings — but no castle. That is exactly why
 * record 5, which mission 6 addresses, carries no castle positions.
 */
export function placePlayerCastles(
  state: GameState,
  setup: NewGameSetup,
  resolved: ResolvedSetup,
): void {
  state.gameTick = 0; // `xor %ax,%ax ; mov %ax,0x206` @0x5000

  for (let slot = 0; slot < 4; slot++) {
    const player = state.players[slot];
    if (!player) continue;
    setPlayerCastlePos(
      state,
      player,
      resolved.castles[slot] ?? [CASTLE_POS_UNSET, CASTLE_POS_UNSET],
    );
  }

  const isScenario = setup.gameType === GAME_TYPE.Mission && setup.missionSetupIndex === 6;
  if (!isScenario) return; // `jne 0x5308` @0x5088 and @0x5099 — both to the same exit

  // ── @0x50a8: the seven tiles (centre plus six neighbours) go to player 1 ─────────────────────
  const geo = state.geo;
  const center = posOf(SCENARIO_LAND_CENTER[0], SCENARIO_LAND_CENTER[1], geo);
  const ring = [
    center,
    neighbor(center, Direction.Right, geo),
    neighbor(neighbor(center, Direction.Right, geo), Direction.Down, geo),
    neighbor(
      neighbor(neighbor(center, Direction.Right, geo), Direction.Down, geo),
      Direction.Left,
      geo,
    ),
    neighbor(
      neighbor(
        neighbor(neighbor(center, Direction.Right, geo), Direction.Down, geo),
        Direction.Left,
        geo,
      ),
      Direction.UpLeft,
      geo,
    ),
    0,
    0,
  ];
  // The original walks the neighbours as an offset chain (`+4`, `gs+0xc`, `gs+0x60`, `gs+0x14`,
  // `gs+0x18`, `+4`); the last two steps continue from the previous tile.
  ring[5] = neighbor(ring[4], Direction.Up, geo);
  ring[6] = neighbor(ring[5], Direction.Right, geo);
  for (const pos of ring) {
    const tile = state.mapTiles[pos];
    if (tile) tile.owner = SCENARIO_LAND_OWNER + 1; // 7x `andb $0x1f,0x1` + `orb $0xa0,0x1` @0x50e5
  }

  // ── @0x51da: player 0 gets full knight occupation ────────────────────────────────────────────
  const human = state.players[0];
  if (human) human.knightOccupation = [0x40, 0x40, 0x40, 0x40]; // `mov $0x40404040,%eax` @0x51da

  // ── @0x51fd: player 1 as an established opponent ─────────────────────────────────────────────
  const enemy = state.players[1];
  if (!enemy) return; // cannot happen in the original: record 5 occupies slot 1
  enemy.flags |= 1; // `bts $0x0` on `player+2`: "castle founded" — although it has none
  enemy.index = 1; // `mov $0x1,%ax` @0x5204
  enemy.totalLandScore = 7; // `mov $0x7,%eax` @0x520e
  enemy.totalBuildingScore = 0x1d; // @0x521c
  enemy.totalMilitaryScore = 0; // `xor %eax,%eax` @0x522a
  enemy.knightOccupation = [0x44, 0x44, 0x44, 0x44]; // `mov $0x44444444,%eax` @0x5235

  // The original stores the type per call in `gs+0x27a`, a shared scratch field that this port
  // passes as a parameter everywhere.
  for (const b of SCENARIO_BUILDINGS) {
    placeScenarioMilitaryBuilding(state, enemy, b.col, b.row, b.type);
  }
  recomputeTerritory(state, enemy.cursorCol, enemy.cursorRow);
}

// ── FUN_0000bb05 @0xbb05 ─────────────────────────────────────────────────────────────────────────

/**
 * `FUN_0000bb05` @0xbb05 — set every clock and ring head to game start.
 *
 * Eight u16 at `gs+0x320..0x32e` are the statistics ring heads (`playerHistoryIndex[4]`,
 * `playerHistoryCounter[3]`, `resourceHistoryIndex`), plus the game tick, the two interval clocks and
 * the two build-pressure accumulators. `gs+0x20a = gs+0x208` adopts the wall clock as the frame
 * driver's reference point; here the tick clock has its own zero.
 */
export function resetGameClocks(state: GameState): void {
  state.header.playerHistoryIndex = [0, 0, 0, 0]; // the eight u16 from @0xbb05
  state.header.playerHistoryCounter = [0, 0, 0];
  state.header.resourceHistoryIndex = 0;
  state.gameTick = 0;
  state.header.tick = 0;
  state.header.statTimer = 0;
  state.header.resourceTimer = 0;
  state.frameAccum = 0; // `gs+0x284` (frameDelta)
  state.aiPressureAccum = 0; // the two pressure accumulators
  state.aiPressureLast = 0;
}

// ── The frame ────────────────────────────────────────────────────────────────────────────────────

/**
 * Transfer the generated map into the tile model. The generator works on the raw, row-interleaved
 * byte buffer of the original (`map-generator.ts`); here it is decoded once into `Tile` records, with
 * the same bit layout `save-parser.ts` uses for the `.DS` block — the save game IS an image of that
 * buffer.
 */
export function mapBufferToTiles(buf: MapGenBuffer, geo: MapGeometry): Tile[] {
  const tiles: Tile[] = new Array<Tile>(geo.tileCount);
  for (let row = 0; row < geo.rows; row++) {
    for (let col = 0; col < geo.cols; col++) {
      const o = mapByteOffset(buf, col, row);
      const b0 = buf.bytes[o] ?? 0;
      const b1 = buf.bytes[o + 1] ?? 0;
      const b2 = buf.bytes[o + 2] ?? 0;
      const b3 = buf.bytes[o + 3] ?? 0;
      const g0 = buf.bytes[o + buf.layerOffset] ?? 0;
      tiles[row * geo.cols + col] = {
        paths: b0 & 0x3f,
        blocked: (b0 & 0x40) !== 0,
        height: b1 & 0x1f,
        owner: (b1 & 0x80) !== 0 ? ((b1 >> 5) & 3) + 1 : 0,
        terrainUp: (b2 >> 4) & 0xf,
        terrainDown: b2 & 0xf,
        object: b3 & 0x7f,
        mineral: (g0 >> 5) & 7,
        resourceAmount: g0 & 0x1f,
        objIndex: 0,
        serfIndex: 0,
      };
    }
  }
  return tiles;
}

/**
 * The four menu columns as a header field — `undefined` with level/mission, because the original does
 * not load them there (a leftover sits at `.DS`@144 then).
 *
 * The order is NOT that of the setup record: `gs+0x36e` is the INTELLIGENCE and `gs+0x372` the
 * SUPPLY, while the record has those two bytes the other way round. It matters here because
 * {@link PlayerDescriptor} carries the RECORD order, so repacking would otherwise swap them
 * silently.
 */
function menuSetupOf(setup: NewGameSetup): MenuPlayerSetup | undefined {
  if (setup.gameType < 2) return undefined;
  const menu = setup.menuPlayers ?? [];
  const col = (k: 0 | 1 | 2 | 3): readonly [number, number, number, number] => [
    menu[0]?.[k] ?? 0,
    menu[1]?.[k] ?? 0,
    menu[2]?.[k] ?? 0,
    menu[3]?.[k] ?? 0,
  ];
  return {
    face: col(0),
    supply: col(1), //        descriptor byte 1 -> `gs+0x372`
    intelligence: col(2), //  descriptor byte 2 -> `gs+0x36e`
    reproduction: col(3),
    humanSupply: setup.humanSupplies ?? [0, 0],
    humanReproduction: setup.humanReproduction ?? [0, 0],
  };
}

function newGameHeader(
  setup: NewGameSetup,
  resolved: ResolvedSetup,
  geo: MapGeometry,
  consts: GameConstants,
  goldTotal: number,
): SaveGameHeader {
  return {
    viewOptions: [
      setup.viewOptions?.[0] ?? VIEW_OPTIONS_DEFAULT,
      setup.viewOptions?.[1] ?? VIEW_OPTIONS_DEFAULT,
    ], // factory default 0x39 (`mov $0x39,%al` @0x2e0f/@0x2e1a) unless the caller inherits one
    gameType: setup.gameType,
    tick: 0,
    random: [resolved.mapSeed[0], resolved.mapSeed[1], resolved.mapSeed[2]],
    rotation: 0, // `gs+0x26c = 0` in `FUN_000076bb`
    flagSearchCounter: 0, // `gs+0x266 = 0` in `FUN_000076bb`
    mapTick: 0,
    mapCounter: 0,
    mapCursorRaw: 0,
    mapDecayCountdown: 0,
    maxFlagIndex: 0,
    maxBuildingIndex: 0,
    maxSerfIndex: 0,
    maxInventoryIndex: 0,
    rotationWrap: ROTATION_WRAP_NO_AI, // overwritten by `initPlayers`
    serfBudget: consts.serfBudget,
    warehouseLimit: consts.warehouseLimit,
    mapGoldTotal: goldTotal,
    serviceBudget: consts.serviceBudget,
    buildingServiceCursor: 0,
    flagServiceCursor: 0,
    playerHistoryIndex: [0, 0, 0, 0],
    playerHistoryCounter: [0, 0, 0],
    resourceHistoryIndex: 0,
    missionSetupIndex: setup.missionSetupIndex ?? 0,
    levelSetupIndex: setup.levelSetupIndex ?? 0,
    // `gs+0x358` — the same gate as on loading (@0x47f0d): only the level game type carries it.
    levelSetupShown:
      setup.gameType === GAME_TYPE.Level
        ? (setup.levelSetupShown ?? setup.levelSetupIndex ?? 0)
        : undefined,
    // `gs+0x35a` — same gate as @126 on loading (@0x47f0d covers both).
    levelPassword: setup.gameType === GAME_TYPE.Level ? setup.levelPassword : undefined,
    mapGoldMoraleFactor: consts.mapGoldMoraleFactor,
    populationSpan: consts.populationSpan,
    populationBase: consts.populationBase,
    statTimer: 0,
    resourceTimer: 0,
    winnerIndex: -1, // `mov $0xffff,%ax` @0x66e9
    victoryMask: 0,
    missionEndPending: 0, // `mov %al,0x381(%ebx)` @0x66f9
    mapSize: geo.mapSize,
    // The four menu columns (`gs+0x36a..0x37d` -> `.DS`@144..163), which the loader reads for
    // `gameType > 1`. They are the ONLY source of the faces of a free game: `gs+0x1d6` is not in the
    // save and is re-derived from them on every entry into the game screen (@0x561e). Without them
    // the colour legend shows the setup record of a campaign game that is not running.
    menuSetup: menuSetupOf(setup),
    // The two menu fields the original saves for `gameType > 1` (`.DS`@136/@138). Without them a
    // free map is not reproducible, and the menu's map code does not help: its DISPLAY is defective
    // in the original and shows only 32 of the 48 bits (see `formatMapSeedCode`).
    mapSizeChoice: resolved.sizeChoice,
    mapSeed: resolved.rawSeed,
    mapCols: geo.cols,
    mapRows: geo.rows,
    tileCount: geo.tileCount,
    frameAccum: 0,
  } as SaveGameHeader;
}

/**
 * `FUN_000076bb` @0x76bb — the reserved slot 0 of the three entity tables.
 *
 * Every `.DS` the clone exports from a self-started game must have bit 0 SET in the serf, flag and
 * building bitmaps; every state written by the original has it (72/72). Omitting it hits the AI
 * hardest: the reproduced military-policy defect tests bit 7 of byte 0 of the building bitmap for
 * EVERY building, and that bit is slot 0 — clear, and the original's census counts zero buildings
 * while ours counts.
 *
 * The original body, in this order:
 *
 * ```
 * 782e  call 0x457dc        create_serf     => slot 0
 * 7838  mov %al,0xa(%ebx)   serf+0xa = 0    (state)
 * 7840  mov %al,(%ebx)      serf+0   = 0    (owner/type/sound)
 * 7847  mov %al,0x1(%ebx)   serf+1   = 0    (animation)
 * 7850  mov %ax,0x2(%ebx)   serf+2   = 0    (counter)
 * 785c  mov %eax,0x4(%ebx)  serf+4   = 0xffffffff  => "no tile"
 * 7861  call 0x44e68        alloc_flag      => slot 0
 * 7866  call 0x4514a        alloc_building  => slot 0
 * 7870  mov %al,0x4(%ebx)   bld+4    = 0    (type/owner/constructing)
 * 7873  ret
 * ```
 *
 * No `alloc_inventory`, which matches the data: in six freshly started original states
 * `maxInventoryIndex` is 0 with nothing occupied, while serfs, flags and buildings carry
 * `maxIndex == 1` with slot 0 occupied. The field clears are already satisfied by the allocators and
 * stand here as evidence only.
 *
 * The serf call costs one unit of serf budget — independently confirmed: across the same six states
 * `serfBudget` is always 1 BELOW `pensum · 500`, at three different map sizes.
 */
export function resetEntityTables(state: GameState): void {
  createSerf(state, 0); // `call 0x457dc` @0x782e — zeroes the record and spends 1 budget
  allocFlag(state, 0); // `call 0x44e68` @0x7861
  allocBuilding(state, 0); // `call 0x4514a` @0x7866
}

export function* startNewGameSteps(setup: NewGameSetup): Generator<number, GameState, void> {
  const resolved = resolveGameSetup(setup);
  const geo = mapGeometry(resolved.mapSize);
  const consts = deriveGameConstants(geo, resolved.descriptors);

  // `FUN_00007874` — the map. The generator draws two values up front itself.
  //
  // ONE stream, not two: the original loads the seed into `gs+0x212..0x216` (== `random[0..2]`) and
  // map generation advances THAT state, so the game begins on the advanced state rather than on the
  // seed. Hence the generator's end state is adopted into the game RNG below.
  const genRng = new Rng([resolved.mapSeed[0], resolved.mapSeed[1], resolved.mapSeed[2]]);
  const buf = yield* generateMapSteps(
    resolved.mapSeed,
    resolved.mapSize,
    () => () => genRng.next(),
  );
  const goldTotal = sumMapGold(buf); // `FUN_000079cc`

  // The empty entity tables. {@link resetEntityTables} creates the reserved slot 0 after `loadState`
  // has turned this into a state; nothing is occupied yet here.
  const header = newGameHeader(setup, resolved, geo, consts, goldTotal);
  const empty: SaveGameState = {
    header,
    activePlayers: [],
    playerRecords: [],
    serfs: { recordSize: 16, maxIndex: 0, occupied: [] },
    flags: { recordSize: 70, maxIndex: 0, occupied: [] },
    buildings: { recordSize: 18, maxIndex: 0, occupied: [] },
    inventories: { recordSize: 120, maxIndex: 0, occupied: [] },
    serfRecords: [],
    flagRecords: [],
    buildingRecords: [],
    inventoryRecords: [],
    mapTiles: mapBufferToTiles(buf, geo),
    byteLength: 0,
  };
  const state = loadState(empty);

  // `FUN_000076bb` @0x76bb — the reserved slot 0. In the original it runs BEFORE map generation
  // (`call 0x76bb` @0x4e2a, `call 0x7874` @0x4e2f); here afterwards, because our state only comes
  // into existence with the finished map. The order is not observable: the routine touches neither
  // map nor random stream (no `call rng_next` in `[0x76bb,0x7874)`).
  resetEntityTables(state);

  // Adopt the generator's end state: `loadState` seeded the RNG from `header.random`, i.e. from the
  // seed BEFORE generation.
  state.rng.setState(genRng.getState());

 // `init_players` @0x66e9
  const { rotationWrap } = initPlayers(state.players, resolved.descriptors);
  state.rotationWrap = rotationWrap;
  state.header.rotationWrap = rotationWrap;

 // `place_player_castles` @0x5000
  placePlayerCastles(state, setup, resolved);

 // `FUN_0000bb05` @0xbb05
  resetGameClocks(state);
  return state;
}

/** {@link startNewGameSteps} without progress reports — the ordinary path when not drawing. */
export function startNewGame(setup: NewGameSetup): GameState {
  const steps = startNewGameSteps(setup);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/** Only so the building table's name resolution matches the rest of the port. */
export const SCENARIO_BUILDING_NAMES = SCENARIO_BUILDINGS.map((b) => BUILDING_TYPE_NAMES[b.type]);
