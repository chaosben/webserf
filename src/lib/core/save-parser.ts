import type {
  BuildingRecord,
  BuildingStockSlot,
  EntityBlock,
  FlagConnection,
  FlagRecord,
  InventoryOutQueueSlot,
  InventoryRecord,
  MapTile,
  MenuPlayerSetup,
  PlayerRecord,
  SaveGameHeader,
  SaveGameState,
  SerfRecord,
  SerfStateFields,
} from './types.js';
import { PASSWORD_LENGTH } from './player-setup.js';

/** Building type names (index 0..24); order confirmed against `SAVE0.DS`. */
export const BUILDING_TYPE_NAMES: readonly string[] = [
  'None',
  'Fisher',
  'Lumberjack',
  'Boatbuilder',
  'Stonecutter',
  'StoneMine',
  'CoalMine',
  'IronMine',
  'GoldMine',
  'Forester',
  'Warehouse',
  'Hut',
  'Farm',
  'Butcher',
  'PigFarm',
  'Mill',
  'Baker',
  'Sawmill',
  'SteelSmelter',
  'ToolMaker',
  'WeaponSmith',
  'Tower',
  'Fortress',
  'GoldSmelter',
  'Castle',
];

/** Serf type names (index 0..27). */
export const SERF_TYPE_NAMES: readonly string[] = [
  'Transporter',
  'Sailor',
  'Digger',
  'Builder',
  'TransporterInventory',
  'Lumberjack',
  'Sawmiller',
  'Stonecutter',
  'Forester',
  'Miner',
  'Smelter',
  'Fisher',
  'PigFarmer',
  'Butcher',
  'Farmer',
  'Miller',
  'Baker',
  'BoatBuilder',
  'Toolmaker',
  'WeaponSmith',
  'Geologist',
  'Generic',
  'Knight0',
  'Knight1',
  'Knight2',
  'Knight3',
  'Knight4',
  'Dead',
];

/** Serf state names (index 0..76), from the state byte (byte 10). */
export const SERF_STATE_NAMES: readonly string[] = [
  'Null',
  'IdleInStock',
  'Walking',
  'Transporting',
  'EnteringBuilding',
  'LeavingBuilding',
  'ReadyToEnter',
  'ReadyToLeave',
  'Digging',
  'Building',
  'BuildingCastle',
  'MoveResourceOut',
  'WaitForResourceOut',
  'DropResourceOut',
  'Delivering',
  'ReadyToLeaveInventory',
  'FreeWalking',
  'Logging',
  'PlanningLogging',
  'PlanningPlanting',
  'Planting',
  'PlanningStoneCutting',
  'StoneCutterFreeWalking',
  'StoneCutting',
  'Sawing',
  'Lost',
  'LostSailor',
  'FreeSailing',
  'EscapeBuilding',
  'Mining',
  'Smelting',
  'PlanningFishing',
  'Fishing',
  'PlanningFarming',
  'Farming',
  'Milling',
  'Baking',
  'PigFarming',
  'Butchering',
  'MakingWeapon',
  'MakingTool',
  'BuildingBoat',
  'LookingForGeoSpot',
  'SamplingGeoSpot',
  'KnightEngagingBuilding',
  'KnightPrepareAttacking',
  'KnightLeaveForFight',
  'KnightPrepareDefending',
  'KnightAttacking',
  'KnightDefending',
  'KnightAttackingVictory',
  'KnightAttackingDefeat',
  'KnightOccupyEnemyBuilding',
  'KnightFreeWalking',
  'KnightEngageDefendingFree',
  'KnightEngageAttackingFree',
  'KnightEngageAttackingFreeJoin',
  'KnightPrepareAttackingFree',
  'KnightPrepareDefendingFree',
  'KnightPrepareDefendingFreeWait',
  'KnightAttackingFree',
  'KnightDefendingFree',
  'KnightAttackingVictoryFree',
  'KnightDefendingVictoryFree',
  'KnightAttackingFreeWait',
  'KnightLeaveForWalkToFight',
  'IdleOnPath',
  'WaitIdleOnPath',
  'WakeAtFlag',
  'WakeOnPath',
  'DefendingHut',
  'DefendingTower',
  'DefendingFortress',
  'Scatter',
  'FinishedBuilding',
  'DefendingCastle',
  'KnightAttackingDefeatFree',
];

/** Resource type names (index 0..25); `-1` means an empty slot. */
export const RESOURCE_TYPE_NAMES: readonly string[] = [
  'Fish',
  'Pig',
  'Meat',
  'Wheat',
  'Flour',
  'Bread',
  'Lumber',
  'Plank',
  'Boat',
  'Stone',
  'IronOre',
  'Steel',
  'Coal',
  'GoldOre',
  'GoldBar',
  'Shovel',
  'Hammer',
  'Rod',
  'Cleaver',
  'Scythe',
  'Axe',
  'Saw',
  'Pick',
  'Pincer',
  'Sword',
  'Shield',
];

/**
 * Parser for `SAVE*.DS` — an uncompressed RAM dump: header primitives at fixed offsets, then
 * players → map tiles → serfs → flags → buildings → inventories. Every entity class is an
 * occupancy bitmap followed by a fixed count of fixed-size records.
 *
 * A built-in size self-check recomputes the layout and compares it with the file size.
 */

export const PLAYER_COUNT = 4;
export const PLAYER_RECORD_SIZE = 8628;
export const PLAYER_ACTIVE_BYTE = 130; // byte offset in the player block; bit 6 == active
export const PLAYER_ACTIVE_BIT = 6;
// Field offsets in the player block (settings region + score fields).
export const PLAYER_TOOL_PRIO_OFF = 0; // 9x u16 (tool production shares)
export const PLAYER_RESOURCE_COUNT_OFF = 18; // 26x u8 (production accumulator per interval)
export const PLAYER_FLAG_PRIO_OFF = 44; // 26x u8 (transport priority, a permutation of 1..26)
export const PLAYER_SERF_COUNT_OFF = 70; // 27× u16
export const PLAYER_KNIGHT_OCC_OFF = 124; // 4x u8 ((max<<4)|min)
export const PLAYER_INDEX_OFF = 128; // u16
export const PLAYER_COMPLETED_BLD_OFF = 132; // 23x u16
export const PLAYER_INCOMPLETE_BLD_OFF = 178; // 23x u16
export const PLAYER_BUILD_OFF = 131; // u8 (build status bitfield)
export const PLAYER_INVENTORY_PRIO_OFF = 224; // 26x u8 (store priority, a permutation of 1..26)
export const PLAYER_ATTACKING_BLDS_OFF = 250; // 64x u16 (indices of the attacking buildings)
export const PLAYER_CURRENT_SETT5_OFF = 378; // u16 (UI cursor of distribution menu 5, default 8)
export const PLAYER_CURSOR_COL_OFF = 380; // u16 (player+0xfc — build/map cursor, column)
export const PLAYER_CURSOR_ROW_OFF = 382; // u16 (player+0xfe — build/map cursor, row)
export const PLAYER_CASTLE_BUILDING_OFF = 388; // u16 (index of the castle building)
export const PLAYER_CASTLE_FLAG_OFF = 390; // u16 (flag index of the castle)
export const PLAYER_CASTLE_INVENTORY_OFF = 392; // u16 (inventory index of the castle)
export const PLAYER_CONT_SEARCH_OFF = 394; // u16 (cont_search_after_non_optimal_find, default 7)
export const PLAYER_KNIGHTS_TO_SPAWN_OFF = 396; // u16 (knights_to_spawn, range 0..2)
export const PLAYER_ATTACKING_KNIGHTS_OFF = 426; // 4x u16 (sum == total_attacking_knights@434)
export const PLAYER_CURRENT_SETT6_OFF = 476; // u16 (UI cursor of distribution menu 6, default 15)
// 402 (u32, player+0x112) — land score == the number of own map tiles. Kept incrementally: +-1 per
// recoloured tile (@0x46380/@0x463b9), +-7 on capturing a building (@0x16c1d/@0x16c64).
export const PLAYER_LAND_SCORE_OFF = 402; // u32
export const PLAYER_BUILDING_SCORE_OFF = 406; // u32
export const PLAYER_MILITARY_SCORE_OFF = 410; // u32
export const PLAYER_LAST_TICK_OFF = 414; // u16 (== header.tick)
export const PLAYER_REPRO_COUNTER_OFF = 416; // u16
export const PLAYER_REPRO_RESET_OFF = 418; // u16 ((60-reproduction)*50)
export const PLAYER_SERF_KNIGHT_RATE_OFF = 420; // u16
export const PLAYER_SERF_KNIGHT_COUNTER_OFF = 422; // u16
export const PLAYER_ATTACKING_BLD_COUNT_OFF = 424; // u16
export const PLAYER_TOTAL_ATK_KNIGHTS_OFF = 434; // u16
export const PLAYER_KNIGHTS_ATTACKING_OFF = 438; // u16 (player+0x136) — count chosen in the attack popup
export const PLAYER_BUILDING_ATTACKED_OFF = 436; // u16 (index of the enemy building)
export const PLAYER_ANALYSIS_OFF = 440; // 4x u16 [GoldOre, IronOre, Coal, Stone]
export const PLAYER_FOOD_DIST_OFF = 448; // 4x u16 [stone, coal, iron, gold mine]
export const PLAYER_PLANKS_DIST_OFF = 456; // 3x u16 [construction, boat builder, tool maker]
export const PLAYER_STEEL_DIST_OFF = 462; // 2x u16 [tool maker, weapon smith]
export const PLAYER_COAL_DIST_OFF = 466; // 3x u16 [steel smelter, gold smelter, weapon smith]
export const PLAYER_WHEAT_DIST_OFF = 472; // 2x u16 [pig farm, mill]
// i16 (player+0x15e) — castle balance: +1 on capturing an enemy castle (serf state 52, @0x16b90),
// -1 on losing one's own (@0x49504). Sole reader: `updateKnightMorale`.
export const PLAYER_CASTLE_BALANCE_OFF = 478;
export const PLAYER_DIFFICULTY_OFF = 482; // u8 (player+0x162) — difficulty (picks the initial goods)
export const PLAYER_MESSAGE_FLAGS_OFF = 483; // u8 (player+0x163) — bit n = hint message n already shown
export const PLAYER_HELD_PLANKS_OFF = 484; // u8 (player+0x164) — 7 planks parked by the castle founding
export const PLAYER_HELD_STONE_OFF = 485; // u8 (player+0x165) — 2 stones, likewise
export const PLAYER_MESSAGE_BUILDING_OFF = 486; // 3x u16 (player+0x166/0x168/0x16a) — buildings of the pending message
// u16 (player+0x16c) — delay of the material return after a plank/stone hint. Exactly one
// writer/reader: the hint generator sets it to 2 (@0x112a4/@0x1133f) and counts it down (@0x11363);
// on the transition to 0 it returns `heldPlanks`/`heldStone` to the castle inventory.
export const PLAYER_HINT_RETURN_DELAY_OFF = 492;
// u16 (player+0x16e) — serf index of the castle builder. One writer (@0x2965d) and one reader: the
// castle branch of `demolish_building` (@0x49522), which throws him out when the castle is lost.
// Not reset after completion.
export const PLAYER_CASTLE_BUILDER_SERF_OFF = 494;
// u16 (player+0x160) — 5-round throttle for the generic resupply of an emptied store (shared stock
// tail @0x153fc/@0x1540d). Over 124 active players always in 0..5.
export const PLAYER_GENERIC_REQUEST_COOLDOWN_OFF = 480;
// u16 (player+0x170) — remaining countdown of the knight shift; 0 = none running. Set to 1200 by the
// menu button (@0x2dda4) or its AI counterpart (@0x54862), counted down in the player tick (@0xf0f9).
// It drives the three `flags` bits 2/4/5 (see `PLAYER_FLAG_*` in `engine/player-settings.ts`).
export const PLAYER_KNIGHT_SHIFT_TIMER_OFF = 496;
// u16 (player+0x174) — 5-tick throttle of the castle for requesting a knight from a FOREIGN store
// (@0x1503f). Only this one writer/reader.
export const PLAYER_CASTLE_REQUEST_COOLDOWN_OFF = 500;
// u32 (player+0x180) — gold accumulator of the stores. One writer (stock tail @0x1547e), one
// consumer (`update_knight_morale` @0x11793, which zeroes it).
// u32 (player+0x178 / 0x17c) — the two military counterparts, written by `militaryGoldDemand`
// (@0x15949/@0x15955) and zeroed by the same consumer.
export const PLAYER_MILITARY_GOLD_CAP_OFF = 504;
export const PLAYER_MILITARY_GOLD_OFF = 508;
export const PLAYER_GOLD_ACCUMULATOR_OFF = 512;
export const PLAYER_GOLD_MORALE_OFF = 516; // u16 (player+0x184, knight gold morale; base 1024)
// u16 (player+0x186) — relative military strength, computed at the end of `update_knight_morale`.
export const PLAYER_MILITARY_STRENGTH_OFF = 518;
export const PLAYER_GOLD_DEPOSITED_OFF = 520; // u16 (player+0x188, deposited gold — basis of the morale)
export const PLAYER_KNIGHT_MENU_OFF = 522; // 2x u16 (player+0x18a/0x18c, target/actual of the knight menu)
// AI tick (see `engine/ai-tick.ts`). Three u16 in the working-memory prefix:
// 558 player+0x1ae activity rate of the character == intelligence * 1300 + 13535. The random gate of
//     the sweep loop only lets the AI tick through while `rng16 < rate`. Written once at game start
//     (@0x6aad); humans keep the 0xFFFF init.
// 564 player+0x1b4 AI state, index into the 4-slot jump table @0x51040.
// 566 player+0x1b6 counter/phase of that state (meaning differs per state, see the module).
export const PLAYER_AI_RATE_OFF = 558;
export const PLAYER_AI_STATE_OFF = 564;
export const PLAYER_AI_COUNTER_OFF = 566;
// Message system (the bases are in the ASM of `add_player_message` @0x18234: `player+0x1df4` and
// `+0x40` from there).
export const PLAYER_MESSAGE_TYPES_OFF = 7796; // 64x u8, PREFIX-PACKED (no 0 before a non-0)
export const PLAYER_MESSAGE_POS_OFF = 7860; // 64x u32, encoded map position as in the building record
export const PLAYER_MESSAGE_SLOTS = 64;
// Recall queue (the time-delayed self-message). 64 x {u32 remaining time, u32 payload} right behind
// the position column; fill level in block 498. The field sum 7796 + 64 + 256 + 512 == 8628 == block
// size pins base and length. ALL 64 slots are kept, not only the occupied ones — see
// `engine/message-recall.ts`.
//
// Block offsets are `player + 0x80`; 0x172 + 0x80 == 498. Reading the player displacement as a block
// displacement lands in the middle of `attacking_buildings[64]` (250..377).
export const PLAYER_RECALL_COUNT_OFF = 498; // u16 (player+0x172)
export const PLAYER_RECALL_FIFO_OFF = 8116; // 64 x 8 B (player+0x1f34)
// NOT decoded: block 374 (player+0x176) — the building an open building popup refers to. Pure window
// state; the UI layer keeps it as `objectSubject` in `MapView`, and decoding it into the game state
// as well would hold the same value in two places.
//
// AI census (`FUN_0005ba0c`) — three adjacent tables, the input of *all* 25 urgency evaluators:
// block 956 (player+0x33c), 21x u16 — supply ratio per consumer group
// block 998 (player+0x366), 27x u16 — idle settlers per profession (state `IdleInStock`)
// block 1052 (player+0x39c), 26x u16 — goods across all own inventories
// The five AI tables abut without a gap: 956 + 21*2 == 998 · 998 + 27*2 == 1052 ·
// 1052 + 26*2 == 1104 · 1104 + 25*2 == 1154 · 1154 + 25*2 == 1204 · 1204 + 35*48 == 2884.
export const PLAYER_AI_SUPPLY_OFF = 956;
export const PLAYER_AI_SUPPLY_COUNT = 21;
export const PLAYER_AI_IDLE_SERFS_OFF = 998;
export const PLAYER_AI_IDLE_SERFS_COUNT = 27;
export const PLAYER_AI_STOCKPILE_OFF = 1052;
export const PLAYER_AI_STOCKPILE_COUNT = 26;
// AI urgencies (block 1104, player+0x3d0) — 25x u16, one per project. Output of the 25 evaluators
// of the build decider, input of its maximum selection. The decider zeroes slots 0..23 before every
// run (@0x5129d..@0x51316) — slot 24 (the flag) NOT, because the head branch writes it elsewhere.
export const PLAYER_AI_URGENCY_OFF = 1104;
export const PLAYER_AI_URGENCY_COUNT = 25;
// AI build pressure (block 1154, player+0x402) — 25x u16, one per project, plus the catch-up value
// (block 568, player+0x1b8). Both written by the pressure accumulator `FUN_00010d71`; the urgency
// evaluators read them as a factor.
export const PLAYER_AI_PRESSURE_OFF = 1154;
export const PLAYER_AI_PRESSURE_COUNT = 25;
export const PLAYER_AI_PRESSURE_CATCHUP_OFF = 568;
/** Job block of the AI road builder — not contiguous, see `PlayerRecord.aiRoadJob540`. */
export const PLAYER_AI_ROAD_JOB_OFF = [540, 542, 548, 550, 552, 570] as const;
/** Building index the building round resumes at (block 538, u16). */
export const PLAYER_AI_BUILDING_CURSOR_OFF = 538;
/** Flag sweep cursor of the road-network task (block 544, u32, record position encoding). */
export const PLAYER_AI_FLAG_SWEEP_OFF = 544;
/** Loss register (block 572, 8x `{u16 column, u16 row}`; a negative u32 means a free slot). */
export const PLAYER_AI_LOSS_REGISTER_OFF = 572;
export const PLAYER_AI_LOSS_REGISTER_SLOTS = 8;
// Two single fields that only the 25 urgency evaluators read: block 536 is a character trait (cap
// of the hut urgency), block 554 the counter that unlocks the tower/fortress evaluators.
export const PLAYER_AI_OCCUPATION_CAP_OFF = 526;
export const PLAYER_AI_ATTACK_KNIGHT_FACTOR_OFF = 528;
export const PLAYER_AI_ATTACK_CHANCE_FACTOR_OFF = 530;
export const PLAYER_AI_ATTACK_TARGET_MASK_OFF = 532;
export const PLAYER_AI_ATTACK_CHANCE_OFF = 534;
export const PLAYER_AI_HUT_CAP_OFF = 536;
export const PLAYER_AI_OCCUPATION_LEVEL_OFF = 554;
export const PLAYER_AI_KNIGHT_TOTAL_OFF = 556;
export const PLAYER_AI_SHIFT_COOLDOWN_OFF = 560;
export const PLAYER_AI_TIMER562_OFF = 562;
// AI candidate table (block 1204, player+0x434) — 35 projects x 8 slots x 6 B
// {u16 score, u16 column, u16 row}. Written by the recorder `FUN_0005dcd0` (stride 48 == 8 * 6),
// read by AI state 0 (the castle site search). 1204 + 35 * 48 == 2884, exactly the start of the
// statistics history below it.
export const PLAYER_AI_CANDIDATES_OFF = 1204;
export const PLAYER_AI_PROJECTS = 35;
export const PLAYER_AI_CANDIDATE_SLOTS = 8;
// Statistics history, both u8.
export const PLAYER_STAT_HISTORY_OFF = 2884; // [16 modes][112 samples], normalised shares 0..100
export const PLAYER_STAT_MODES = 16;
export const PLAYER_STAT_SAMPLES = 112;
export const PLAYER_RES_HISTORY_OFF = 4676; // [26 goods][120 samples], production per interval
export const PLAYER_RES_TYPES = 26;
export const PLAYER_RES_SAMPLES = 120;
const MAP_TILE_SIZE = 8;

const SERF_RECORD_SIZE = 16;
const FLAG_RECORD_SIZE = 70;
const BUILDING_RECORD_SIZE = 18;
const INVENTORY_RECORD_SIZE = 120;

// Building types with a built-in inventory, see BUILDING_TYPE_NAMES.
const BUILDING_TYPE_STOCK = 10;
const BUILDING_TYPE_CASTLE = 24;

/** Map geometry from the size class (3..10). */
export function mapGeometry(size: number): { cols: number; rows: number; tileCount: number } {
  const colSize = 5 + Math.floor(size / 2);
  const rowSize = 5 + Math.floor((size - 1) / 2);
  const cols = 1 << colSize;
  const rows = 1 << rowSize;
  return { cols, rows, tileCount: cols * rows };
}

export function parseSaveGame(buffer: ArrayBuffer | ArrayBufferView): SaveGameState {
  const data = toUint8Array(buffer);
  if (data.byteLength < 250) {
    throw new Error(`parseSaveGame: file too small (${data.byteLength} bytes).`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cur = new Cursor(dv, data.byteLength);

 // --- header primitives ---
 // 0..65 — the map geometry, a pure function of the column and row count at 62/64. The engine reads
 // it from here and nowhere else on the load path, so the ENCODER has to write it (see
 // `writeMapGeometry`); for our model it is redundant and stays unread.
  cur.skip(66); // 0..65 derivable
  const sessionFlags = cur.u8(); // 66 (gs+0x37e)
  const messageMarks = cur.u8(); // 67 (gs+0x37f)
 // 68 — position cursor of the map growth pass (gs+0x280). A packed u32 position as in the
 // serf/building record; kept raw, because the map geometry is only known from offset 190 on.
  const mapCursorRaw = cur.u32(); // 68 (gs+0x280)
 // 72/73 (gs+0x3d8 / gs+0x3d9) — control options of the left and right screen half. Bit layout:
 // `engine/view-options.ts`.
  const viewOptions: [number, number] = [cur.u8(), cur.u8()];
  const gameType = cur.u16(); // 74
  cur.skip(2); // 76
  const tick = cur.u16(); // 78
 // 80/82 — the two interval clocks of the statistics recorder. It fires when `gameTick - clock`
 // reaches the interval and advances the clock by exactly that interval, which makes the recording
 // phase reproducible. See `engine/stats-recorder.ts`.
  const statTimer = cur.u16(); // 80 (gs+0x20e) — player statistics, interval 1500
  const resourceTimer = cur.u16(); // 82 (gs+0x210) — goods statistics, interval 6000
  const random: [number, number, number] = [cur.u16(), cur.u16(), cur.u16()]; // 84/86/88
  const maxFlagIndex = cur.u16(); // 90
  const maxBuildingIndex = cur.u16(); // 92
  const maxSerfIndex = cur.u16(); // 94
  const rotation = cur.u16(); // 96 — frame rotation counter (gs+0x26c)
  const flagSearchCounter = cur.u16(); // 98
 // 100/102 — map growth (`map_object_growth` @0xf2d5): tick stamp of the last map pass and the
 // remaining counter until the next tile round. Without both the pass starts with a wrong delta
 // after loading.
  const mapTick = cur.u16(); // 100 (gs+0x27c)
  const mapCounter = cur.u16(); // 102 (gs+0x27e)
  const playerHistoryIndex = [cur.u16(), cur.u16(), cur.u16(), cur.u16()]; // 104..111
  const playerHistoryCounter = [cur.u16(), cur.u16(), cur.u16()]; // 112..117
  const resourceHistoryIndex = cur.u16(); // 118
  cur.skip(2); // 120..121 open
 // 122/124 address the same setup record; which field applies is decided by `gameType`: 1 means
 // 122 - 1, 0 means 124 + 5. The load routine fetches each only under its guard, so the other one
 // holds leftovers. See `player-setup.ts`.
  const missionSetupIndex = cur.u16(); // 122 (gs+0x354)
  const levelSetupIndex = cur.u16(); // 124 (gs+0x356)
 // 126 (gs+0x358) — the highest unlocked level, the stop of the level selector. Loaded under the
 // same gate as 124, so only for `gameType == 0`; otherwise a leftover.
  const rawLevelShown = cur.u16(); // 126 (gs+0x358)
  const levelSetupShown = gameType === 0 ? rawLevelShown : undefined;
 // 128..135 (gs+0x35a) — the campaign password. Not an analogous gate to 124/126 but the SAME one:
 // the two loads @0x47f34/@0x47f3d and @0x47f46/@0x47f4f (two dwords) sit inside the very `jne
 // 0x47f55` block @0x47f0d that guards the other two, so with another game type a residue stands here.
 // Read through unchecked, as the original does — a file may carry anything in these eight bytes.
  let rawPassword = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) rawPassword += String.fromCharCode(cur.u8()); // 128..135
  const levelPassword = gameType === 0 ? rawPassword : undefined;
 // 136..143 is loaded only for `gameType > 1`: the map size chosen in the menu and the map seed.
 // For level/mission both come from the setup record and a leftover stands here.
  const rawSizeChoice = cur.u16(); // 136 (gs+0x362)
  const rawSeed = [cur.u16(), cur.u16(), cur.u16()] as const; // 138..143 (gs+0x364/0x366/0x368)
  const mapSizeChoice = gameType > 1 ? rawSizeChoice : undefined;
  const mapSeed: readonly [number, number, number] | undefined =
    gameType > 1 ? (rawSeed as unknown as readonly [number, number, number]) : undefined;
 // 144..163 (gs+0x36a..0x37d) — the player settings of the main menu, loaded only for
 // `gameType > 1` (@0x47f60). The order intelligence(148)/supply(152) is decided at the bytes, not
 // taken from the setup record — there the two middle ones are swapped.
  const menuFace = [cur.u8(), cur.u8(), cur.u8(), cur.u8()] as const; // 144..147
  const menuIntelligence = [cur.u8(), cur.u8(), cur.u8(), cur.u8()] as const; // 148..151
  const menuSupply = [cur.u8(), cur.u8(), cur.u8(), cur.u8()] as const; // 152..155
  const menuReproduction = [cur.u8(), cur.u8(), cur.u8(), cur.u8()] as const; // 156..159
  const menuHumanSupply = [cur.u8(), cur.u8()] as const; // 160/161
  const menuHumanReproduction = [cur.u8(), cur.u8()] as const; // 162/163
  const menuSetup: MenuPlayerSetup | undefined =
    gameType > 1
      ? {
          face: menuFace as unknown as MenuPlayerSetup['face'],
          intelligence: menuIntelligence as unknown as MenuPlayerSetup['intelligence'],
          supply: menuSupply as unknown as MenuPlayerSetup['supply'],
          reproduction: menuReproduction as unknown as MenuPlayerSetup['reproduction'],
          humanSupply: menuHumanSupply as unknown as MenuPlayerSetup['humanSupply'],
          humanReproduction:
            menuHumanReproduction as unknown as MenuPlayerSetup['humanReproduction'],
        }
      : undefined;
 // 164..173 do NOT belong to the menu block: gs+0x172 (u32), gs+0x176 (u32), gs+0x17a (u16), all
 // three loaded without a guard. Meaning open.
  cur.skip(10); // 164..173 open
  const maxInventoryIndex = cur.u16(); // 174
  const serfBudget = cur.u16(); // 176 — serf reproduction budget (gs+0x48)
 // 178 (gs+0x268) — warehouse limit: the build action refuses another warehouse when
 // `finished + under construction + 1 == warehouseLimit`. Derived from the array capacity (361).
  const warehouseLimit = cur.u16(); // 178
  const rotationWrap = cur.u16(); // 180 — rotation wrap (gs+0x286)
 // 182 (gs+0x4a) — span of the population allowance: the share of the land is scaled onto it and
 // together with `populationBase` gives the limit below which a player still gets new settlers
 // (`engine/population.ts`). Observed 1250 / 1500 / 1750 — a game setting, not a constant.
  const populationSpan = cur.u16(); // 182
 // 184 (gs+0x4c) — total gold of the map, summed at map init. Denominator of the knight morale
 // formula; it only drops when gold is lost for good (a built-over tile with no fallback).
  const mapGoldTotal = cur.u32(); // 184..187
 // 188 — decay countdown of the map growth pass (gs+0x28c). Counted down per processed tile and
 // reset to 16 at 0; only object group 0x70..0x78 disappears while it is 0.
  const mapDecayCountdown = cur.u16(); // 188 (gs+0x28c)
  const mapSize = cur.u16(); // 190
 // Round-robin housekeeping (FUN_0000eced): budget plus two rolling cursors. They drive the
 // periodic serfRequestFailed reset.
  const serviceBudget = cur.u16(); // 192 (gs+0x52) — buildings/flags per frame
  const buildingServiceCursor = cur.u16(); // 194 (gs+0x54) — round-robin position, buildings
  const flagServiceCursor = cur.u16(); // 196 (gs+0x56) — round-robin position, flags
 // 198 (gs+0x58) — base of the population allowance: every player may hold that many settlers even
 // without land. 250 in all saves.
  const populationBase = cur.u16(); // 198
  const mapGoldMoraleFactor = cur.u16(); // 200
 // 202/204/205 — the outcome of the game.
  const winnerIndex = cur.i16(); // 202 (gs+0x5e) — winner slot, -1 = none yet
  const victoryMask = cur.u8(); // 204 (gs+0x380) — per player bit `slot` (land) + `slot+4` (military)
  const missionEndPending = cur.u8(); // 205 (gs+0x381) — 0xff means the mission end screen is due
  cur.skip(44); // 206..249 open

  if (mapSize < 3 || mapSize > 10) {
    throw new Error(
      `parseSaveGame: implausible map size ${mapSize} (expected 3..10) — probably not a valid SAVE*.DS.`,
    );
  }

  const { cols, rows, tileCount } = mapGeometry(mapSize);

  const header: SaveGameHeader = {
    sessionFlags,
    messageMarks,
    viewOptions,
    gameType,
    tick,
    random,
    rotation,
    flagSearchCounter,
    mapTick,
    mapCounter,
    mapCursorRaw,
    mapDecayCountdown,
    maxFlagIndex,
    maxBuildingIndex,
    maxSerfIndex,
    maxInventoryIndex,
    rotationWrap,
    serfBudget,
    warehouseLimit,
    mapGoldTotal,
    serviceBudget,
    buildingServiceCursor,
    flagServiceCursor,
    playerHistoryIndex,
    playerHistoryCounter,
    resourceHistoryIndex,
    missionSetupIndex,
    levelSetupIndex,
    levelSetupShown,
    levelPassword,
    mapSizeChoice,
    mapSeed,
    menuSetup,
    mapGoldMoraleFactor,
    populationSpan,
    populationBase,
    statTimer,
    resourceTimer,
    winnerIndex,
    victoryMask,
    missionEndPending,
    mapSize,
    mapCols: cols,
    mapRows: rows,
    tileCount,
  };

 // The map geometry is already needed here because the message positions in the player block carry
 // the same encoded form as building/serf positions.
  const colMask = cols - 1;
  const rowMask = rows - 1;
  const rowShift = 5 + Math.floor(mapSize / 2); // == col_size
  const geo = { colMask, rowMask, rowShift };

 // --- players: 4 fixed-size slots; the active bit is in byte[130] ---
  const playerRecords: PlayerRecord[] = [];
  const activePlayers: number[] = [];
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const base = cur.pos;
    cur.require(PLAYER_RECORD_SIZE, `Player ${i}`);
    const rec = decodePlayer(dv, base, i, geo, cols);
    playerRecords.push(rec);
    if (rec.active) activePlayers.push(i);
    cur.skip(PLAYER_RECORD_SIZE);
  }

 // --- map tiles: tileCount x 8 bytes, row-interleaved (see decodeMapTiles) ---
  cur.require(MAP_TILE_SIZE * tileCount, 'Map-Tiles');
  const mapTilesOffset = cur.pos;
  cur.skip(MAP_TILE_SIZE * tileCount);

 // --- entity blocks: bitmap + fixed-size records ---
  const serfsRead = readEntityBlock(cur, dv, SERF_RECORD_SIZE, maxSerfIndex, 'Serfs');
  const flagsRead = readEntityBlock(cur, dv, FLAG_RECORD_SIZE, maxFlagIndex, 'Flags');
  const buildingsRead = readEntityBlock(
    cur,
    dv,
    BUILDING_RECORD_SIZE,
    maxBuildingIndex,
    'Buildings',
  );
  const inventoriesRead = readEntityBlock(
    cur,
    dv,
    INVENTORY_RECORD_SIZE,
    maxInventoryIndex,
    'Inventories',
  );

 // Decode the building and serf records.
  const buildingRecords: BuildingRecord[] = buildingsRead.block.occupied.map((index) =>
    decodeBuilding(dv, buildingsRead.recordsOffset + index * BUILDING_RECORD_SIZE, index, geo),
  );

  const serfRecords: SerfRecord[] = serfsRead.block.occupied.map((index) =>
    decodeSerf(dv, serfsRead.recordsOffset + index * SERF_RECORD_SIZE, index, geo),
  );

  const flagRecords: FlagRecord[] = flagsRead.block.occupied.map((index) =>
    decodeFlag(dv, flagsRead.recordsOffset + index * FLAG_RECORD_SIZE, index),
  );

  const inventoryRecords: InventoryRecord[] = inventoriesRead.block.occupied.map((index) =>
    decodeInventory(dv, inventoriesRead.recordsOffset + index * INVENTORY_RECORD_SIZE, index),
  );

  const mapTiles = decodeMapTiles(dv, mapTilesOffset, cols, rows);

  return {
    header,
    activePlayers,
    playerRecords,
    serfs: serfsRead.block,
    flags: flagsRead.block,
    buildings: buildingsRead.block,
    inventories: inventoriesRead.block,
    buildingRecords,
    serfRecords,
    flagRecords,
    inventoryRecords,
    mapTiles,
    byteLength: data.byteLength,
  };
}

/**
 * Decodes the map block (`rows * cols`, 8 bytes each) — row-interleaved: per row first `cols`
 * landscape tuples (4 B), then `cols` game/resource tuples (4 B).
 *
 * Tile index == canonical map position `pos = row * cols + col` (== `(row << rowShift) | col`).
 *
 * Landscape tuple: `paths=b0&0x3f`; `height=b1&0x1f`, bit 7 means `owner=((b1>>5)&3)+1`, else 0;
 * `terrainUp=(b2>>4)&0xf`, `terrainDown=b2&0xf`; `object=b3&0x7f`.
 * Game tuple: for `object` in [1,4] (flag/building) `objIndex=u16`, then `serf=u16`; otherwise
 * `mineral=(b>>5)&7` / `resourceAmount=b&0x1f`, a pad byte, `objIndex=0`, then `serf=u16`.
 */
function decodeMapTiles(dv: DataView, base: number, cols: number, rows: number): MapTile[] {
  interface Landscape {
    height: number;
    owner: number;
    terrainUp: number;
    terrainDown: number;
    object: number;
    paths: number;
    blocked: boolean;
  }
  const tiles: MapTile[] = new Array(cols * rows);
  let off = base;
  const land: Landscape[] = new Array(cols);
  for (let y = 0; y < rows; y++) {
    const rowBase = y * cols;
 // Landscape pass (4 B per tile).
    for (let x = 0; x < cols; x++) {
      const b0 = dv.getUint8(off);
      const b1 = dv.getUint8(off + 1);
      const b2 = dv.getUint8(off + 2);
      const b3 = dv.getUint8(off + 3);
      off += 4;
      land[x] = {
        paths: b0 & 0x3f,
        blocked: (b0 & 0x40) !== 0, // paths byte bit 6 = block marker (building/stones/footprint)
        height: b1 & 0x1f,
        owner: (b1 >> 7) & 1 ? ((b1 >> 5) & 3) + 1 : 0,
        terrainUp: (b2 >> 4) & 0x0f,
        terrainDown: b2 & 0x0f,
        object: b3 & 0x7f,
      };
    }
 // Game/resource pass (4 B per tile).
    for (let x = 0; x < cols; x++) {
      const l = land[x];
      let mineral = 0;
      let resourceAmount = 0;
      let objIndex = 0;
      if (l.object >= 1 && l.object <= 4) {
        objIndex = dv.getUint16(off, true);
      } else {
        const rb = dv.getUint8(off);
        mineral = (rb >> 5) & 7;
        resourceAmount = rb & 0x1f;
      }
      const serfIndex = dv.getUint16(off + 2, true);
      off += 4;
      tiles[rowBase + x] = {
        height: l.height,
        terrainUp: l.terrainUp,
        terrainDown: l.terrainDown,
        object: l.object,
        owner: l.owner,
        paths: l.paths,
        blocked: l.blocked,
        mineral,
        resourceAmount,
        objIndex,
        serfIndex,
      };
    }
  }
  return tiles;
}

/**
 * Decodes one player slot (8628 B): the settings region, the two statistics history arrays and the
 * AI tables.
 *
 * @384..386 (cursor kind, build possibility, levelling height) are deliberately not read — the
 * engine recomputes them on every cursor change (`classifyBuildSite`).
 */
function decodePlayer(
  dv: DataView,
  base: number,
  slot: number,
  geo: { colMask: number; rowMask: number; rowShift: number },
  cols: number,
): PlayerRecord {
  const u16s = (off: number, n: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) out.push(dv.getUint16(base + off + j * 2, true));
    return out;
  };

  const u8s = (off: number, n: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) out.push(dv.getUint8(base + off + j));
    return out;
  };

  const index = dv.getUint16(base + PLAYER_INDEX_OFF, true);
  const flags = dv.getUint8(base + PLAYER_ACTIVE_BYTE);
  const active = (flags & (1 << PLAYER_ACTIVE_BIT)) !== 0;

 /**
  * Message list: the type column is prefix-packed, so the list ends at the first type 0. Behind the
  * prefix the position column holds leftovers (the consumer only clears the type byte), so only the
  * occupied slots are read. Positions are converted to the linear form used everywhere else.
  */
  const messages = ((): { types: number[]; positions: number[] } => {
    const types: number[] = [];
    const positions: number[] = [];
    for (let j = 0; j < PLAYER_MESSAGE_SLOTS; j++) {
      const t = dv.getUint8(base + PLAYER_MESSAGE_TYPES_OFF + j);
      if (t === 0) break;
      types.push(t);
      let v = dv.getUint32(base + PLAYER_MESSAGE_POS_OFF + j * 4, true) >>> 2;
      const col = v & geo.colMask;
      v = v >>> (geo.rowShift + 1);
      positions.push((v & geo.rowMask) * cols + col);
    }
    return { types, positions };
  })();

 /**
  * Recall queue: all 64 slots, raw. The payload stays a signed i32 — it is a union (negative menu
  * index / building position with bit 0 / map position) that only the consumer resolves, exactly as
  * in the original.
  */
  const recallQueue = ((): { remaining: number; payload: number }[] => {
    const out: { remaining: number; payload: number }[] = [];
    for (let j = 0; j < PLAYER_MESSAGE_SLOTS; j++) {
      const at = base + PLAYER_RECALL_FIFO_OFF + j * 8;
      out.push({ remaining: dv.getUint32(at, true), payload: dv.getInt32(at + 4, true) });
    }
    return out;
  })();

 /**
  * AI candidates: `[project][slot]` with `{score, col, row}`, all 35 x 8 slots raw. An empty slot is
  * `score == 0`; the position stays behind as a leftover (the same "a RAM dump does not tidy up"
  * pattern as `flag.length[dir]`), which is why nothing is filtered here.
  */
  const aiCandidates = ((): { score: number; col: number; row: number }[][] => {
    const out: { score: number; col: number; row: number }[][] = [];
    for (let p = 0; p < PLAYER_AI_PROJECTS; p++) {
      const slots: { score: number; col: number; row: number }[] = [];
      for (let s = 0; s < PLAYER_AI_CANDIDATE_SLOTS; s++) {
        const at = base + PLAYER_AI_CANDIDATES_OFF + (p * PLAYER_AI_CANDIDATE_SLOTS + s) * 6;
        slots.push({
          score: dv.getUint16(at, true),
          col: dv.getUint16(at + 2, true),
          row: dv.getUint16(at + 4, true),
        });
      }
      out.push(slots);
    }
    return out;
  })();

 // Read a u8 grid [rows][cols] from the statistics history (active players only).
  const u8grid = (off: number, rows: number, cols: number): number[][] => {
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) row.push(dv.getUint8(base + off + r * cols + c));
      grid.push(row);
    }
    return grid;
  };

  return {
    slot,
    index,
    active,
    flags,
    serfCount: u16s(PLAYER_SERF_COUNT_OFF, 27),
    completedBuildingCount: u16s(PLAYER_COMPLETED_BLD_OFF, 23),
    incompleteBuildingCount: u16s(PLAYER_INCOMPLETE_BLD_OFF, 23),
    toolPriority: u16s(PLAYER_TOOL_PRIO_OFF, 9),
    resourceCount: u8s(PLAYER_RESOURCE_COUNT_OFF, 26),
    flagPriority: u8s(PLAYER_FLAG_PRIO_OFF, 26),
    inventoryPriority: u8s(PLAYER_INVENTORY_PRIO_OFF, 26),
    knightOccupation: u8s(PLAYER_KNIGHT_OCC_OFF, 4),
    castleBuilding: dv.getUint16(base + PLAYER_CASTLE_BUILDING_OFF, true),
    castleFlag: dv.getUint16(base + PLAYER_CASTLE_FLAG_OFF, true),
    castleInventory: dv.getUint16(base + PLAYER_CASTLE_INVENTORY_OFF, true),
    build: dv.getUint8(base + PLAYER_BUILD_OFF),
    lastTick: dv.getUint16(base + PLAYER_LAST_TICK_OFF, true),
    reproductionCounter: dv.getUint16(base + PLAYER_REPRO_COUNTER_OFF, true),
    reproductionReset: dv.getUint16(base + PLAYER_REPRO_RESET_OFF, true),
    serfToKnightRate: dv.getUint16(base + PLAYER_SERF_KNIGHT_RATE_OFF, true),
    serfToKnightCounter: dv.getUint16(base + PLAYER_SERF_KNIGHT_COUNTER_OFF, true),
    attackingBuildingCount: dv.getUint16(base + PLAYER_ATTACKING_BLD_COUNT_OFF, true),
    totalAttackingKnights: dv.getUint16(base + PLAYER_TOTAL_ATK_KNIGHTS_OFF, true),
    buildingAttacked: dv.getUint16(base + PLAYER_BUILDING_ATTACKED_OFF, true),
 // attacking_buildings[64]: only the non-zero entries (the buildings actually selected).
    attackingBuildings: u16s(PLAYER_ATTACKING_BLDS_OFF, 64).filter((x) => x !== 0),
    attackingKnights: u16s(PLAYER_ATTACKING_KNIGHTS_OFF, 4),
    knightsAttacking: dv.getUint16(base + PLAYER_KNIGHTS_ATTACKING_OFF, true),
    currentSett5Item: dv.getUint16(base + PLAYER_CURRENT_SETT5_OFF, true),
    cursorCol: dv.getUint16(base + PLAYER_CURSOR_COL_OFF, true),
    cursorRow: dv.getUint16(base + PLAYER_CURSOR_ROW_OFF, true),
    currentSett6Item: dv.getUint16(base + PLAYER_CURRENT_SETT6_OFF, true),
    contSearchAfterNonOptimalFind: dv.getUint16(base + PLAYER_CONT_SEARCH_OFF, true),
    knightsToSpawn: dv.getUint16(base + PLAYER_KNIGHTS_TO_SPAWN_OFF, true),
    analysis: u16s(PLAYER_ANALYSIS_OFF, 4),
    foodDistribution: u16s(PLAYER_FOOD_DIST_OFF, 4),
    planksDistribution: u16s(PLAYER_PLANKS_DIST_OFF, 3),
    steelDistribution: u16s(PLAYER_STEEL_DIST_OFF, 2),
    coalDistribution: u16s(PLAYER_COAL_DIST_OFF, 3),
    wheatDistribution: u16s(PLAYER_WHEAT_DIST_OFF, 2),
    totalLandScore: dv.getUint32(base + PLAYER_LAND_SCORE_OFF, true),
    totalBuildingScore: dv.getUint32(base + PLAYER_BUILDING_SCORE_OFF, true),
    totalMilitaryScore: dv.getUint32(base + PLAYER_MILITARY_SCORE_OFF, true),
    castleCaptureBalance: dv.getInt16(base + PLAYER_CASTLE_BALANCE_OFF, true),
    difficulty: dv.getUint8(base + PLAYER_DIFFICULTY_OFF),
    messageFlags: dv.getUint8(base + PLAYER_MESSAGE_FLAGS_OFF),
    heldPlanks: dv.getUint8(base + PLAYER_HELD_PLANKS_OFF),
    heldStone: dv.getUint8(base + PLAYER_HELD_STONE_OFF),
    messageBuildingSlots: [
      dv.getUint16(base + PLAYER_MESSAGE_BUILDING_OFF, true),
      dv.getUint16(base + PLAYER_MESSAGE_BUILDING_OFF + 2, true),
      dv.getUint16(base + PLAYER_MESSAGE_BUILDING_OFF + 4, true),
    ],
    hintReturnDelay: dv.getUint16(base + PLAYER_HINT_RETURN_DELAY_OFF, true),
    castleBuilderSerf: dv.getUint16(base + PLAYER_CASTLE_BUILDER_SERF_OFF, true),
    genericRequestCooldown: dv.getUint16(base + PLAYER_GENERIC_REQUEST_COOLDOWN_OFF, true),
    knightShiftTimer: dv.getUint16(base + PLAYER_KNIGHT_SHIFT_TIMER_OFF, true),
    castleRequestCooldown: dv.getUint16(base + PLAYER_CASTLE_REQUEST_COOLDOWN_OFF, true),
    militaryGoldCapacity: dv.getUint32(base + PLAYER_MILITARY_GOLD_CAP_OFF, true),
    militaryGoldAccumulator: dv.getUint32(base + PLAYER_MILITARY_GOLD_OFF, true),
    goldAccumulator: dv.getUint32(base + PLAYER_GOLD_ACCUMULATOR_OFF, true),
    goldMorale: dv.getUint16(base + PLAYER_GOLD_MORALE_OFF, true),
    goldDeposited: dv.getUint16(base + PLAYER_GOLD_DEPOSITED_OFF, true),
    militaryStrengthRatio: dv.getUint16(base + PLAYER_MILITARY_STRENGTH_OFF, true),
    knightMenuValue: dv.getUint16(base + PLAYER_KNIGHT_MENU_OFF, true),
    knightMenuCounter: dv.getUint16(base + PLAYER_KNIGHT_MENU_OFF + 2, true),
    aiRate: dv.getUint16(base + PLAYER_AI_RATE_OFF, true),
    aiState: dv.getUint16(base + PLAYER_AI_STATE_OFF, true),
    aiCounter: dv.getUint16(base + PLAYER_AI_COUNTER_OFF, true),
    messageTypes: messages.types,
    messagePositions: messages.positions,
    recallCount: dv.getUint16(base + PLAYER_RECALL_COUNT_OFF, true),
    recallQueue,
    aiCandidates,
    aiSupplyRatio: Array.from({ length: PLAYER_AI_SUPPLY_COUNT }, (_, i) =>
      dv.getUint16(base + PLAYER_AI_SUPPLY_OFF + i * 2, true)),
    aiIdleSerfs: Array.from({ length: PLAYER_AI_IDLE_SERFS_COUNT }, (_, i) =>
      dv.getUint16(base + PLAYER_AI_IDLE_SERFS_OFF + i * 2, true)),
    aiStockpile: Array.from({ length: PLAYER_AI_STOCKPILE_COUNT }, (_, i) =>
      dv.getUint16(base + PLAYER_AI_STOCKPILE_OFF + i * 2, true)),
    aiUrgency: Array.from({ length: PLAYER_AI_URGENCY_COUNT }, (_, i) =>
      dv.getUint16(base + PLAYER_AI_URGENCY_OFF + i * 2, true)),
    aiPressure: Array.from({ length: PLAYER_AI_PRESSURE_COUNT }, (_, i) =>
      dv.getUint16(base + PLAYER_AI_PRESSURE_OFF + i * 2, true)),
    aiPressureCatchUp: dv.getUint16(base + PLAYER_AI_PRESSURE_CATCHUP_OFF, true),
    aiBuildingCursor: dv.getUint16(base + PLAYER_AI_BUILDING_CURSOR_OFF, true),
    aiRoadJob540: dv.getUint16(base + PLAYER_AI_ROAD_JOB_OFF[0], true),
    aiRoadJob542: dv.getUint16(base + PLAYER_AI_ROAD_JOB_OFF[1], true),
    aiRoadJob548: dv.getUint16(base + PLAYER_AI_ROAD_JOB_OFF[2], true),
    aiRoadJob550: dv.getUint16(base + PLAYER_AI_ROAD_JOB_OFF[3], true),
    aiRoadJob552: dv.getUint16(base + PLAYER_AI_ROAD_JOB_OFF[4], true),
    aiRoadJob570: dv.getUint16(base + PLAYER_AI_ROAD_JOB_OFF[5], true),
    aiFlagSweepCursor: dv.getUint32(base + PLAYER_AI_FLAG_SWEEP_OFF, true),
    aiLossRegister: Array.from({ length: PLAYER_AI_LOSS_REGISTER_SLOTS }, (_, i) => ({
      col: dv.getUint16(base + PLAYER_AI_LOSS_REGISTER_OFF + i * 4, true),
      row: dv.getUint16(base + PLAYER_AI_LOSS_REGISTER_OFF + i * 4 + 2, true),
    })),
    aiOccupationCap: dv.getUint16(base + PLAYER_AI_OCCUPATION_CAP_OFF, true),
    aiAttackKnightFactor: dv.getUint16(base + PLAYER_AI_ATTACK_KNIGHT_FACTOR_OFF, true),
    aiAttackChanceFactor: dv.getUint16(base + PLAYER_AI_ATTACK_CHANCE_FACTOR_OFF, true),
    aiAttackTargetMask: dv.getUint16(base + PLAYER_AI_ATTACK_TARGET_MASK_OFF, true),
    aiAttackStrongChance: dv.getUint16(base + PLAYER_AI_ATTACK_CHANCE_OFF, true),
    aiHutUrgencyCap: dv.getUint16(base + PLAYER_AI_HUT_CAP_OFF, true),
    aiKnightOccupationLevel: dv.getUint16(base + PLAYER_AI_OCCUPATION_LEVEL_OFF, true),
    aiKnightTotal: dv.getUint16(base + PLAYER_AI_KNIGHT_TOTAL_OFF, true),
    aiShiftCooldown: dv.getUint16(base + PLAYER_AI_SHIFT_COOLDOWN_OFF, true),
    aiTimer562: dv.getUint16(base + PLAYER_AI_TIMER562_OFF, true),
    statHistory: active ? u8grid(PLAYER_STAT_HISTORY_OFF, PLAYER_STAT_MODES, PLAYER_STAT_SAMPLES) : [],
    resourceHistory: active
      ? u8grid(PLAYER_RES_HISTORY_OFF, PLAYER_RES_TYPES, PLAYER_RES_SAMPLES)
      : [],
  };
}

/** Decodes an 18-byte building record. */
function decodeBuilding(
  dv: DataView,
  base: number,
  index: number,
  geo: { colMask: number; rowMask: number; rowShift: number },
): BuildingRecord {
  const posWord = dv.getUint32(base, true);
  let v = posWord >>> 2;
  const col = v & geo.colMask;
  v = v >>> (geo.rowShift + 1);
  const row = v & geo.rowMask;

  const b4 = dv.getUint8(base + 4);
  const type = (b4 >> 2) & 0x1f;
  const owner = b4 & 3;
  const constructing = (b4 & 0x80) !== 0;

  const b5 = dv.getUint8(base + 5);

  const flag = dv.getUint16(base + 6, true);

 // Stock slots (bytes 8/9), decoded losslessly: the nibbles are always kept, including for the
 // inventory marker 0xff (which becomes {15,15}). The marker is not a mere flag in the original but
 // a computed value: delivery adds 0x0f to the byte (@0x22c74), and only 0xff overflows — that carry
 // IS the branch into the inventory path (@0x22c8a). A collapsed byte cannot carry that arithmetic.
 // Test: `buildingStockByte(bld, k) === 0xff`.
  const stock: [BuildingStockSlot, BuildingStockSlot] = [
    { available: 0, requested: 0 },
    { available: 0, requested: 0 },
  ];
  let hasInventory = type === BUILDING_TYPE_STOCK || type === BUILDING_TYPE_CASTLE;
  for (let i = 0; i < 2; i++) {
    const sb = dv.getUint8(base + 8 + i);
    stock[i] = { available: (sb >> 4) & 0xf, requested: sb & 0xf };
    if (sb === 0xff && i === 0) hasInventory = true;
  }

  const firstKnight = dv.getUint16(base + 10, true);
  const progress = dv.getUint16(base + 12, true);

 // Byte 14 is a union: a u32 inventory offset (/120) for a finished inventory building, else the
 // u16 `level`. Bytes 16/17 carry the stock maxima only while under construction.
  let inventoryIndex: number | null = null;
  let level: number | null = null;
  let stockMaximum: [number, number] | null = null;
  if (hasInventory && !constructing) {
    inventoryIndex = Math.trunc(dv.getUint32(base + 14, true) / INVENTORY_RECORD_SIZE);
  } else {
    level = dv.getUint16(base + 14, true);
    if (constructing) {
      stockMaximum = [dv.getUint8(base + 16), dv.getUint8(base + 17)];
    }
  }

  return {
    index,
    col,
    row,
    type,
    typeName: BUILDING_TYPE_NAMES[type] ?? `Unknown(${type})`,
    owner,
    constructing,
    progress,
    flag,
    firstKnight,
    active: (b5 & 16) !== 0,
    burning: (b5 & 32) !== 0,
    holder: (b5 & 64) !== 0,
    serfRequested: (b5 & 128) !== 0,
    threatLevel: b5 & 3,
    serfRequestFailed: (b5 & 4) !== 0,
    playingSfx: (b5 & 8) !== 0,
    stock,
    hasInventory,
    inventoryIndex,
    level,
    stockMaximum,
  };
}

/**
 * Decodes a 16-byte serf record. The 5 union bytes (11..15) stay raw in `stateData`.
 */
function decodeSerf(
  dv: DataView,
  base: number,
  index: number,
  geo: { colMask: number; rowMask: number; rowShift: number },
): SerfRecord {
  const b0 = dv.getUint8(base);
  const owner = b0 & 3;
  const type = (b0 >> 2) & 0x1f;
  const sound = (b0 & 0x80) !== 0;

  const animation = dv.getUint8(base + 1);
  const counter = dv.getUint16(base + 2, true);

  const pos32 = dv.getUint32(base + 4, true);
  let col: number | null = null;
  let row: number | null = null;
  if (pos32 !== 0xffffffff) {
    let v = pos32 >>> 2;
    col = v & geo.colMask;
    v = v >>> (geo.rowShift + 1);
    row = v & geo.rowMask;
  }

  const tick = dv.getUint16(base + 8, true);
  const state = dv.getUint8(base + 10);

  const stateData = [
    dv.getUint8(base + 11),
    dv.getUint8(base + 12),
    dv.getUint8(base + 13),
    dv.getUint8(base + 14),
    dv.getUint8(base + 15),
  ];

  return {
    index,
    owner,
    type,
    typeName: SERF_TYPE_NAMES[type] ?? `Unknown(${type})`,
    sound,
    animation,
    counter,
    col,
    row,
    tick,
    state,
    stateData,
  };
}

// Serf state indices (order as in SERF_STATE_NAMES). Several states share one layout.
const FREE_WALKING_STATES = new Set([
  16, // FreeWalking
  17, // Logging
  20, // Planting
  22, // StoneCutterFreeWalking
  23, // StoneCutting
  32, // Fishing
  34, // Farming
  43, // SamplingGeoSpot
  53, // KnightFreeWalking
]);
const WORKING_MODE_STATES = new Set([
  24, // Sawing
  25, // Lost (field_B, same 1-byte layout)
  35, // Milling
  36, // Baking
  37, // PigFarming
  38, // Butchering
  39, // MakingWeapon
  40, // MakingTool
  41, // BuildingBoat
]);
const IDLE_ON_PATH_STATES = new Set([66, 67, 68, 69]); // IdleOnPath/WaitIdleOnPath/WakeAtFlag/WakeOnPath
const DEFENDING_STATES = new Set([70, 71, 72, 75]); // DefendingHut/Tower/Fortress/Castle
const ATTACKING_STATES = new Set([44, 45, 59, 76, 48, 50, 55, 56]);

/**
 * Interprets the 5 state-dependent union bytes (11..15) according to `state`. States that are not
 * handled (transient planning/escape states, for instance) yield `{ category: 'none' }` — their raw
 * bytes are in `stateData`.
 */
export function decodeSerfState(dv: DataView, base: number, state: number): SerfStateFields {
  const u8 = (o: number) => dv.getUint8(base + o);
  const i8 = (o: number) => dv.getInt8(base + o);
  const u16 = (o: number) => dv.getUint16(base + o, true);

  if (FREE_WALKING_STATES.has(state)) {
    return {
      category: 'freeWalking',
      distCol: i8(11),
      distRow: i8(12),
      negDist1: i8(13),
      negDist2: i8(14),
      flags: u8(15),
    };
  }
  if (WORKING_MODE_STATES.has(state)) {
    return { category: 'workingMode', mode: u8(11) };
  }
  if (IDLE_ON_PATH_STATES.has(state)) {
    return { category: 'idleOnPath', revDir: u8(11), flag: Math.trunc(u16(12) / FLAG_RECORD_SIZE), fieldE: u8(14) };
  }
  if (DEFENDING_STATES.has(state)) {
    return { category: 'defending', nextKnight: u16(14) };
  }
  if (ATTACKING_STATES.has(state)) {
    return { category: 'attacking', move: u8(11), attackerWon: u8(12), fieldD: u8(13), defIndex: u16(14) };
  }

  switch (state) {
    case 1: // IdleInStock
      return { category: 'idleInStock', invIndex: u16(14) };
    case 2: // Walking
      return { category: 'walking', dir1: i8(11), dest: u16(12), dir: i8(14), waitCounter: u8(15) };
    case 3: // Transporting
    case 14: // Delivering
      return {
        category: 'transporting',
        res: i8(11) - 1,
        dest: u16(12),
        dir: i8(14),
        waitCounter: u8(15),
      };
    case 4: // EnteringBuilding
      return { category: 'enteringBuilding', fieldB: i8(11), slopeLen: u16(12) };
    case 5: // LeavingBuilding
    case 7: // ReadyToLeave
      return {
        category: 'leavingBuilding',
        fieldB: i8(11),
        dest: i8(12),
        dest2: i8(13),
        dir: u8(14),
        nextState: u8(15),
      };
    case 6: // ReadyToEnter
      return { category: 'readyToEnter', fieldB: u8(11) };
    case 8: // Digging
      return { category: 'digging', hIndex: u8(11), targetH: u8(12), digPos: u8(13), substate: u8(14) };
    case 9: // Building
      return { category: 'building', mode: i8(11), bldIndex: u16(12), materialStep: u8(14), counter: u8(15) };
    case 10: // BuildingCastle
      return { category: 'buildingCastle', invIndex: u16(12) };
    case 11: // MoveResourceOut
    case 13: // DropResourceOut
      return { category: 'moveResourceOut', res: u8(11), resDest: u16(12), nextState: u8(15) };
    case 15: // ReadyToLeaveInventory
      return { category: 'readyToLeaveInventory', mode: i8(11), dest: u16(12), invIndex: u16(14) };
    case 29: // Mining
      return { category: 'mining', substate: u8(11), res: i8(13), deposit: u8(14) };
    case 30: // Smelting
      return { category: 'smelting', mode: u8(11), counter: u8(12), type: u8(13) };
    case 65: // KnightLeaveForWalkToFight
      return {
        category: 'leaveForWalkToFight',
        distCol: i8(11),
        distRow: i8(12),
        fieldD: i8(13),
        fieldE: i8(14),
        nextState: u8(15),
      };
    default:
      return { category: 'none' };
  }
}

/**
 * Named view of the five union bytes of a serf — the per-state reading of `stateData`.
 *
 * It is a derivation and therefore deliberately not a field of the record: the state machine writes
 * the raw bytes bit for bit (as does the binary, which reads `mov 0xb(%ebx),%al` and knows no
 * decoded variant), so a stored image would be wrong after the first tick.
 *
 * Call it where a human view is needed (viewers, probes, bug report). The drawing path does not
 * need it — `serfDrawInfo` reads the bytes raw, because the original does too.
 */
export function serfStateFields(serf: { readonly state: number; readonly stateData: readonly number[] }): SerfStateFields {
  for (let i = 0; i < 5; i++) SERF_UNION_SCRATCH.setUint8(11 + i, (serf.stateData[i] ?? 0) & 0xff);
  return decodeSerfState(SERF_UNION_SCRATCH, 0, serf.state);
}

/** 16-byte scratch buffer for {@link serfStateFields} (`decodeSerfState` reads only 11..15). */
const SERF_UNION_SCRATCH = new DataView(new ArrayBuffer(16));


/** Direction UpLeft in the six-direction cycle (Right, DownRight, Down, Left, UpLeft, Up). */
const DIR_UP_LEFT = 4;

/**
 * Decodes a 70-byte flag record (path bits, endpoints, owner, goods slots). Transient
 * search/length/priority fields stay uninterpreted.
 */
function decodeFlag(dv: DataView, base: number, index: number): FlagRecord {
  const searchNum = dv.getUint16(base, true);
  const searchDir = dv.getUint8(base + 2);

  const b3 = dv.getUint8(base + 3);
  const owner = (b3 >> 6) & 3;
  const pathCon = b3 & 0x3f;

  const endpoint = dv.getUint8(base + 4);
  const hasBuilding = ((endpoint >> 6) & 1) !== 0;
  const hasResources = ((endpoint >> 7) & 1) !== 0;

  const transporterByte = dv.getUint8(base + 5);
  const serfRequestFail = ((transporterByte >> 7) & 1) !== 0;

  const paths: boolean[] = [];
  const endpointDirs: boolean[] = [];
  const connections: (FlagConnection | null)[] = [];
  const transporters: boolean[] = [];
  const length: number[] = [];
  const otherEndDir: number[] = [];
  const scheduled: boolean[] = [];
  const scheduledSlot: number[] = [];
  for (let j = 0; j < 6; j++) {
    const hasPath = (pathCon & (1 << j)) !== 0;
    paths.push(hasPath);
    endpointDirs.push((endpoint & (1 << j)) !== 0);
    transporters.push((transporterByte & (1 << j)) !== 0);
    length.push(dv.getUint8(base + 6 + j));
 // Byte 60+dir: bit 7 = scheduled (a resource is waiting), bits 3-5 = opposite direction, bits 0-2 = slot.
    const schedByte = dv.getUint8(base + 60 + j);
    otherEndDir.push((schedByte >> 3) & 7);
    scheduled.push((schedByte & 0x80) !== 0);
    scheduledSlot.push(schedByte & 7);

    const offset = dv.getInt32(base + 36 + j * 4, true);
    if (j === DIR_UP_LEFT && hasBuilding) {
      connections.push({ kind: 'building', index: Math.trunc(offset / BUILDING_RECORD_SIZE) });
    } else if (hasPath && offset >= 0) {
      connections.push({ kind: 'flag', index: Math.trunc(offset / FLAG_RECORD_SIZE) });
    } else {
      connections.push(null);
    }
  }

  const resourceSlots: number[] = [];
  const slotDir: number[] = [];
  const slotDest: number[] = [];
  for (let j = 0; j < 8; j++) {
    const slotByte = dv.getUint8(base + 12 + j);
    resourceSlots.push((slotByte & 0x1f) - 1);
    slotDir.push(((slotByte >> 5) & 7) - 1);
    slotDest.push(dv.getUint16(base + 20 + j * 2, true));
  }

  const bldFlags = dv.getUint8(base + 66);
  const bld2Flags = dv.getUint8(base + 68);

  return {
    index,
    owner,
    hasBuilding,
    hasResources,
    endpointDirs,
    paths,
    connections,
    resourceSlots,
    searchNum,
    searchDir,
    transporters,
    serfRequestFail,
    length,
    slotDir,
    slotDest,
    otherEndDir,
    scheduled,
    scheduledSlot,
    acceptsSerfs: ((bldFlags >> 7) & 1) !== 0,
    acceptsResources: ((bld2Flags >> 7) & 1) !== 0,
 // Raw flag bytes 66/68 (`bld_flags`/`bld2_flags`): bit 7 = acceptsSerfs/Resources (above), bits
 // 0..5 = the demand mask per stock slot (0x42 = slot 0, 0x44 = slot 1) — which good the attached
 // building asks for. Read by the goods scheduler, set on worker entry (@0x23107).
    bldFlags,
    bld2Flags,
    stockPriority: [dv.getUint8(base + 67), dv.getUint8(base + 69)],
  };
}

/**
 * Decodes a 120-byte inventory record (the store of a castle or warehouse). `serfIndices` holds serf
 * indices (0 = none), not counts. The out queue (bytes 58..63) stays uninterpreted.
 */
function decodeInventory(dv: DataView, base: number, index: number): InventoryRecord {
  const owner = dv.getUint8(base);
  const resDir = dv.getUint8(base + 1);
  const flag = dv.getUint16(base + 2, true);
  const building = dv.getUint16(base + 4, true);

  const resources: number[] = [];
  for (let j = 0; j < 26; j++) resources.push(dv.getUint16(base + 6 + j * 2, true));

 // Outgoing queue: 2x type (bytes 58/59, `b-1`) + 2x dest (u16 from byte 60).
  const outQueue: InventoryOutQueueSlot[] = [];
  for (let j = 0; j < 2; j++) {
    outQueue.push({
      type: dv.getUint8(base + 58 + j) - 1,
      dest: dv.getUint16(base + 60 + j * 2, true),
    });
  }

  const genericCount = dv.getUint16(base + 64, true);

  const serfIndices: number[] = [];
  for (let j = 0; j < 27; j++) serfIndices.push(dv.getUint16(base + 66 + j * 2, true));

  return {
    index,
    owner,
    resDir,
    resMode: resDir & 0x3,
    serfMode: (resDir >> 2) & 0x3,
    flag,
    building,
    resources,
    outQueue,
    genericCount,
    serfIndices,
  };
}

/**
 * Reads one entity block: occupancy bitmap, then `maxIndex` records of `recordSize` bytes. Returns
 * the block together with the start offset of the records.
 */
function readEntityBlock(
  cur: Cursor,
  dv: DataView,
  recordSize: number,
  maxIndex: number,
  label: string,
): { block: EntityBlock; recordsOffset: number } {
  const bitmapSize = 4 * Math.floor((maxIndex + 31) / 32);
  cur.require(bitmapSize, `${label}-Bitmap`);
  const bitmapOffset = cur.pos;
  cur.skip(bitmapSize);

  const occupied: number[] = [];
  for (let i = 0; i < maxIndex; i++) {
    const byte = dv.getUint8(bitmapOffset + (i >> 3));
    if ((byte & (1 << (7 - (i & 7)))) !== 0) occupied.push(i);
  }

  cur.require(recordSize * maxIndex, `${label}-Records`);
  const recordsOffset = cur.pos;
  cur.skip(recordSize * maxIndex);

  return { block: { recordSize, maxIndex, occupied }, recordsOffset };
}

/** Sequential read cursor; mirrors the original read order. */
class Cursor {
  pos = 0;
  constructor(
    private readonly dv: DataView,
    private readonly byteLength: number,
  ) {}

  private check(n: number, what: string): void {
    if (this.pos + n > this.byteLength) {
      throw new Error(
        `parseSaveGame: read past the end of the file at ${what} (offset ${this.pos} + ${n} > ${this.byteLength}). ` +
          `The file is probably damaged, or not a valid SAVE*.DS.`,
      );
    }
  }

 /** Throws when the next `n` bytes no longer fit into the file. */
  require(n: number, what: string): void {
    this.check(n, what);
  }

  skip(n: number): void {
    this.check(n, 'skip');
    this.pos += n;
  }

  u8(): number {
    this.check(1, 'u8');
    const v = this.dv.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    this.check(2, 'u16');
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

 /** Signed word — needed for fields whose "empty" is -1 (the winner slot). */
  i16(): number {
    this.check(2, 'i16');
    const v = this.dv.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.check(4, 'u32');
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
}

function toUint8Array(buf: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(buf);
}
