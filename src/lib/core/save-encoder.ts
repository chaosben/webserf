import type {
  BuildingRecord,
  FlagRecord,
  InventoryRecord,
  MapTile,
  PlayerRecord,
  SaveGameState,
  SerfRecord,
} from './types.js';
import { PASSWORD_LENGTH } from './player-setup.js';
import {
  PLAYER_AI_ATTACK_CHANCE_FACTOR_OFF,
  PLAYER_AI_ATTACK_CHANCE_OFF,
  PLAYER_AI_ATTACK_KNIGHT_FACTOR_OFF,
  PLAYER_AI_ATTACK_TARGET_MASK_OFF,
  PLAYER_AI_BUILDING_CURSOR_OFF,
  PLAYER_AI_CANDIDATES_OFF,
  PLAYER_AI_CANDIDATE_SLOTS,
  PLAYER_AI_COUNTER_OFF,
  PLAYER_AI_FLAG_SWEEP_OFF,
  PLAYER_AI_HUT_CAP_OFF,
  PLAYER_AI_IDLE_SERFS_OFF,
  PLAYER_AI_KNIGHT_TOTAL_OFF,
  PLAYER_AI_LOSS_REGISTER_OFF,
  PLAYER_AI_LOSS_REGISTER_SLOTS,
  PLAYER_AI_OCCUPATION_CAP_OFF,
  PLAYER_AI_OCCUPATION_LEVEL_OFF,
  PLAYER_AI_PRESSURE_CATCHUP_OFF,
  PLAYER_AI_PRESSURE_OFF,
  PLAYER_AI_PROJECTS,
  PLAYER_AI_RATE_OFF,
  PLAYER_AI_ROAD_JOB_OFF,
  PLAYER_AI_SHIFT_COOLDOWN_OFF,
  PLAYER_AI_STATE_OFF,
  PLAYER_AI_STOCKPILE_OFF,
  PLAYER_AI_SUPPLY_OFF,
  PLAYER_AI_TIMER562_OFF,
  PLAYER_AI_URGENCY_OFF,
  PLAYER_ANALYSIS_OFF,
  PLAYER_ATTACKING_BLDS_OFF,
  PLAYER_ATTACKING_BLD_COUNT_OFF,
  PLAYER_ATTACKING_KNIGHTS_OFF,
  PLAYER_BUILDING_ATTACKED_OFF,
  PLAYER_BUILDING_SCORE_OFF,
  PLAYER_BUILD_OFF,
  PLAYER_CASTLE_BALANCE_OFF,
  PLAYER_CASTLE_BUILDER_SERF_OFF,
  PLAYER_CASTLE_BUILDING_OFF,
  PLAYER_CASTLE_FLAG_OFF,
  PLAYER_CASTLE_INVENTORY_OFF,
  PLAYER_CASTLE_REQUEST_COOLDOWN_OFF,
  PLAYER_COAL_DIST_OFF,
  PLAYER_COMPLETED_BLD_OFF,
  PLAYER_CONT_SEARCH_OFF,
  PLAYER_CURRENT_SETT5_OFF,
  PLAYER_CURRENT_SETT6_OFF,
  PLAYER_CURSOR_COL_OFF,
  PLAYER_CURSOR_ROW_OFF,
  PLAYER_DIFFICULTY_OFF,
  PLAYER_FLAG_PRIO_OFF,
  PLAYER_FOOD_DIST_OFF,
  PLAYER_GENERIC_REQUEST_COOLDOWN_OFF,
  PLAYER_GOLD_ACCUMULATOR_OFF,
  PLAYER_GOLD_DEPOSITED_OFF,
  PLAYER_GOLD_MORALE_OFF,
  PLAYER_HELD_PLANKS_OFF,
  PLAYER_HELD_STONE_OFF,
  PLAYER_HINT_RETURN_DELAY_OFF,
  PLAYER_INCOMPLETE_BLD_OFF,
  PLAYER_INDEX_OFF,
  PLAYER_INVENTORY_PRIO_OFF,
  PLAYER_KNIGHTS_ATTACKING_OFF,
  PLAYER_KNIGHTS_TO_SPAWN_OFF,
  PLAYER_KNIGHT_MENU_OFF,
  PLAYER_KNIGHT_OCC_OFF,
  PLAYER_KNIGHT_SHIFT_TIMER_OFF,
  PLAYER_LAND_SCORE_OFF,
  PLAYER_LAST_TICK_OFF,
  PLAYER_MESSAGE_BUILDING_OFF,
  PLAYER_MESSAGE_FLAGS_OFF,
  PLAYER_MESSAGE_POS_OFF,
  PLAYER_MESSAGE_SLOTS,
  PLAYER_MESSAGE_TYPES_OFF,
  PLAYER_MILITARY_GOLD_CAP_OFF,
  PLAYER_MILITARY_GOLD_OFF,
  PLAYER_MILITARY_SCORE_OFF,
  PLAYER_MILITARY_STRENGTH_OFF,
  PLAYER_PLANKS_DIST_OFF,
  PLAYER_RECALL_COUNT_OFF,
  PLAYER_RECALL_FIFO_OFF,
  PLAYER_REPRO_COUNTER_OFF,
  PLAYER_REPRO_RESET_OFF,
  PLAYER_RESOURCE_COUNT_OFF,
  PLAYER_RES_HISTORY_OFF,
  PLAYER_RES_SAMPLES,
  PLAYER_SERF_COUNT_OFF,
  PLAYER_SERF_KNIGHT_COUNTER_OFF,
  PLAYER_SERF_KNIGHT_RATE_OFF,
  PLAYER_STAT_HISTORY_OFF,
  PLAYER_STAT_SAMPLES,
  PLAYER_STEEL_DIST_OFF,
  PLAYER_TOOL_PRIO_OFF,
  PLAYER_TOTAL_ATK_KNIGHTS_OFF,
  PLAYER_WHEAT_DIST_OFF,
} from './save-parser.js';

/**
 * Encoder for `.DS` saves — the reverse of `parseSaveGame`.
 *
 * ## Source
 *
 * The original header writer sits at **@0x470ce** (the decompiler export lists it under the wrong
 * name `savegame_read_header_block` — it *writes*: `buf[y] = gs->x`). Call path: `file_open_write`
 * -> this routine -> `savegame_write_map/serfs/flags/buildings/inventories`.
 *
 * Two properties of that routine determine the whole design:
 *
 * 1. **The header is not a RAM dump.** The routine first zeroes 250 bytes
 *    (`vreg0 = 0xf9 ; do { *ptr_c++ = 0 } while (vreg0-- != 0)`) and then sets field by field up to
 *    `buf[0xce]`+4 == offset 210. **210..249 are exactly zero in every file the original wrote** —
 *    there is no garbage to preserve there.
 * 2. **The player blocks are a RAM dump.** Four `copy_bytes` of `0x21b4` == 8628 bytes to
 *    `ptr_c + 0xfa / 0x22ae / 0x4462 / 0x6616` (== 250 + n·8628), source `gs->playerN - 0x80` each.
 *    That is also the direct evidence for the layout rule "block offset X ==
 *    `player + (X − 0x80)`" — it does not have to be inferred from individual fields.
 *
 * ## Base buffer
 *
 * `opts.base` is typically the file the state was loaded from. Ranges our model does **not** decode
 * are taken from it; without a base they stay 0.
 *
 * That is deliberately a parameter and not a property of the state — only so can it be measured how
 * much our model carries **on its own**: an encoder that silently falls back on the source file
 * delivers a byte-identical round trip without checking a single field.
 */
export interface EncodeOptions {
  /** Raw bytes of the source file. Fills the ranges not yet modelled. */
  readonly base?: Uint8Array | null;
}

const HEADER_SIZE = 250;
const PLAYER_RECORD_SIZE = 8628;
const MAP_TILE_SIZE = 8;
const SERF_RECORD_SIZE = 16;
const FLAG_RECORD_SIZE = 70;
const BUILDING_RECORD_SIZE = 18;
const INVENTORY_RECORD_SIZE = 120;

/** Bitmap length of an entity block (4 bytes per 32 slots, rounded up). */
function bitmapSize(maxIndex: number): number {
  return 4 * Math.floor((maxIndex + 31) / 32);
}

/**
 * Expected file size for a state — the same arithmetic `parseSaveGame` holds against `byteLength` as
 * an integrity check.
 */
export function saveGameByteLength(state: SaveGameState): number {
  const h = state.header;
  return (
    HEADER_SIZE +
    4 * PLAYER_RECORD_SIZE +
    MAP_TILE_SIZE * h.tileCount +
    bitmapSize(h.maxSerfIndex) +
    SERF_RECORD_SIZE * h.maxSerfIndex +
    bitmapSize(h.maxFlagIndex) +
    FLAG_RECORD_SIZE * h.maxFlagIndex +
    bitmapSize(h.maxBuildingIndex) +
    BUILDING_RECORD_SIZE * h.maxBuildingIndex +
    bitmapSize(h.maxInventoryIndex) +
    INVENTORY_RECORD_SIZE * h.maxInventoryIndex
  );
}

class Writer {
  constructor(
    private readonly dv: DataView,
    private pos = 0,
  ) {}
  seek(off: number): void {
    this.pos = off;
  }
  get offset(): number {
    return this.pos;
  }
  u8(v: number): void {
    this.dv.setUint8(this.pos, v & 0xff);
    this.pos += 1;
  }
  u16(v: number): void {
    this.dv.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
  }
  i16(v: number): void {
    this.dv.setInt16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number): void {
    this.dv.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
}

/**
 * Writes the 250-byte header. Order and offsets follow @0x470ce.
 *
 * Not written (stay from the base or 0), with their `gs` offsets from the routine:
 * 0..66    22 fields `gs+0x00..0x42` plus `gs+0x60`, `gs+0x1c2`, `gs+0x1c4`, `gs+0x37e`
 * 67       computed: one flag per viewport (`+1` / `+2`, each `vp[0x87] & 1`)
 * 76       `gs+0x202` — lower half of the u32 whose upper half is `tick` @78
 * 164..173 `gs+0x172/0x176/0x17a` — parked cursor of the second splitscreen player
 * 206..209 `gs+0x10`
 */
function writeHeader(w: Writer, state: SaveGameState): void {
  const h = state.header;

  w.seek(68);
  w.u32(h.mapCursorRaw); // 68  (gs+0x280) — buf[0x44]
  w.u8(h.viewOptions[0]); // 72  (gs+0x3d8)
  w.u8(h.viewOptions[1]); // 73  (gs+0x3d9)
  w.u16(h.gameType); // 74  (gs+0x352)
  // 76 — lower half of `gs+0x202`; not modelled, stays base/0.
  w.seek(78);
  w.u16(h.tick); // 78  (gs+0x204)
  w.u16(h.statTimer); // 80  (gs+0x20e)
  w.u16(h.resourceTimer); // 82  (gs+0x210)
  w.u16(h.random[0]); // 84  (gs+0x212)
  w.u16(h.random[1]); // 86  (gs+0x214)
  w.u16(h.random[2]); // 88  (gs+0x216)
  w.u16(h.maxFlagIndex); // 90
  w.u16(h.maxBuildingIndex); // 92
  w.u16(h.maxSerfIndex); // 94
  w.u16(h.rotation); // 96  (gs+0x26c)
  w.u16(h.flagSearchCounter); // 98  (gs+0x26e)
  w.u16(h.mapTick); // 100 (gs+0x27c)
  w.u16(h.mapCounter); // 102 (gs+0x27e)
  for (let i = 0; i < 4; i++) w.u16(h.playerHistoryIndex[i] ?? 0); // 104..111 (gs+0x320..)
  for (let i = 0; i < 3; i++) w.u16(h.playerHistoryCounter[i] ?? 0); // 112..117
  w.u16(h.resourceHistoryIndex); // 118 (gs+0x32e)
  // 120 (gs+0x21c) — the map geometry's workload. Derivable from `mapSize`, so computed rather than
  // carried: the same expression the game start uses.
  w.u16((h.mapCols >> 5) * (h.mapRows >> 5));
  w.u16(h.missionSetupIndex); // 122 (gs+0x354)
  w.u16(h.levelSetupIndex); // 124 (gs+0x356)
  // 126 (gs+0x358) — the unlocked level. The original writes it **without** a gate (@0x47449) but
  // reads it only for `gameType == 0` (@0x47f0d); our model keeps it under exactly that gate, so it
  // is available for campaign/mission and otherwise stays base/0.
  if (h.levelSetupShown !== undefined) {
    w.seek(126);
    w.u16(h.levelSetupShown);
  }
  // 128..135 (gs+0x35a) — the campaign password. The original writes it WITHOUT a gate (@0x4745a has
  // no branch) but loads it only for `gameType == 0` (@0x47f0d); our model keeps it under exactly that
  // gate, as with @126. Eight bytes, padded with spaces — the buffer of the original is always full
  // (the input blanks it with `mov $0x20202020` ×2, @0x50f18/@0x50f22), and a shorter write would
  // shift @136.
  if (h.levelPassword !== undefined) {
    w.seek(128);
    // Pad first, then write every position: a `|| 0x20` per character would turn a legitimate NUL
    // byte into a space, and one of our own saves carries eight of them there.
    const password = h.levelPassword.padEnd(PASSWORD_LENGTH, ' ');
    for (let i = 0; i < PASSWORD_LENGTH; i++) w.u8(password.charCodeAt(i));
  }

  // 136..143 the original writes **without** a gate (@0x470ce has no branch there) but reads only
  // for `gameType > 1`. Our model keeps both fields under exactly that gate, so for campaign/mission
  // they are unavailable and stay base/0.
  if (h.mapSizeChoice !== undefined) {
    w.seek(136);
    w.u16(h.mapSizeChoice);
  }
  if (h.mapSeed !== undefined) {
    w.seek(138);
    w.u16(h.mapSeed[0]);
    w.u16(h.mapSeed[1]);
    w.u16(h.mapSeed[2]);
  }
  const ms = h.menuSetup;
  if (ms !== undefined) {
    w.seek(144);
    for (let i = 0; i < 4; i++) w.u8(ms.face[i]); // 144..147 (gs+0x36a)
    for (let i = 0; i < 4; i++) w.u8(ms.intelligence[i]); // 148..151 (gs+0x36e)
    for (let i = 0; i < 4; i++) w.u8(ms.supply[i]); // 152..155 (gs+0x372)
    for (let i = 0; i < 4; i++) w.u8(ms.reproduction[i]); // 156..159 (gs+0x376)
    for (let i = 0; i < 2; i++) w.u8(ms.humanSupply[i]); // 160/161 (gs+0x37a)
    for (let i = 0; i < 2; i++) w.u8(ms.humanReproduction[i]); // 162/163 (gs+0x37c)
  }
  // 164..173 — parked cursor of the second splitscreen player; not modelled.

  w.seek(174);
  w.u16(h.maxInventoryIndex); // 174 (gs+0x266)
  w.u16(h.serfBudget); // 176 (gs+0x48)
  w.u16(h.warehouseLimit); // 178 (gs+0x268)
  w.u16(h.rotationWrap); // 180 (gs+0x286)
  w.u16(h.populationSpan); // 182 (gs+0x4a)
  w.u32(h.mapGoldTotal); // 184 (gs+0x4c)
  w.u16(h.mapDecayCountdown); // 188 (gs+0x28c)
  w.u16(h.mapSize); // 190 (gs+0x50)
  w.u16(h.serviceBudget); // 192 (gs+0x52)
  w.u16(h.buildingServiceCursor); // 194 (gs+0x54)
  w.u16(h.flagServiceCursor); // 196 (gs+0x56)
  w.u16(h.populationBase); // 198 (gs+0x58)
  w.u16(h.mapGoldMoraleFactor); // 200 (gs+0x5a)
  w.i16(h.winnerIndex); // 202 (gs+0x5e)
  w.u8(h.victoryMask); // 204 (gs+0x380)
  w.u8(h.missionEndPending); // 205 (gs+0x381)
  // 206..209 (gs+0x10) — not modelled. 210..249 are guaranteed zero in the original.
}

/**
 * Serf states that mean an **idle carrier** on the tile (IdleOnPath / WaitIdleOnPath / WakeAtFlag /
 * WokeOnPath). The encoder needs them because the original keeps a redundant cache in the map block
 * that our model does not carry (see below).
 */
const IDLE_ON_PATH_STATES = new Set([66, 67, 68, 69]);

/** Encodes a map position into the records' packed u32 form (inverse of the parser). */
function encodePos(col: number, row: number, rowShift: number): number {
  return (((row << (rowShift + 1)) | col) << 2) >>> 0;
}

/**
 * Map block: per row first `cols` landscape tuples (4 B), then `cols` game tuples (4 B).
 *
 * **Our parser deliberately does not read three bits** because they are redundant caches in the
 * original — the encoder must reconstruct them, so the round trip checks these three verified
 * equivalences in the **reverse** direction for the first time:
 *
 * - `paths` bit 7 iff `object == 1` (a flag stands here)
 * - `object` bit 7 iff at least one water triangle (`terrainUp <= 3 || terrainDown <= 3`)
 * - game byte 1 bit 7 iff an idle carrier rests on the tile (state 66..69), **bits 0..1 = its
 *   owner** — the byte is not a pure flag but carries the slot too (surveyed over 5997 tiles:
 *   `serf.owner` separates the observed values `0x80`/`0x81` completely, and bit 0 never occurs
 *   without bit 7). Plausibly a drawing cache: the map pass needs the idle carrier's team colour
 *   without searching the serf table.
 *
 * **Measured limit**: with two players "bits 0..1" and "bit 0 only" are indistinguishable. All saves
 * with 3–4 active players are freshly generated and have **0** idle carriers, so the width is not
 * decidable from the bytes; in the binary the reader only tests the sign
 * (`*(char *)(ptr_b + off + 1) < 0`). We write `owner & 3` because `owner` is a 2-bit field in
 * **all** other records (serf byte 0, building byte 4, flag byte 3).
 *
 * If one of the three deviates, it is not the encoder that is wrong but the equivalence.
 */
function writeMapTiles(
  out: Uint8Array,
  dv: DataView,
  base: number,
  state: SaveGameState,
  idleTiles: ReadonlyMap<number, number>,
): void {
  const { mapCols: cols, mapRows: rows } = state.header;
  const tiles = state.mapTiles;
  let off = base;
  for (let y = 0; y < rows; y++) {
    const rowBase = y * cols;
    for (let x = 0; x < cols; x++) {
      const t: MapTile = tiles[rowBase + x];
      const isWater = t.terrainUp <= 3 || t.terrainDown <= 3;
      out[off] = (t.paths & 0x3f) | (t.blocked ? 0x40 : 0) | (t.object === 1 ? 0x80 : 0);
      out[off + 1] = (t.height & 0x1f) | (t.owner > 0 ? (((t.owner - 1) & 3) << 5) | 0x80 : 0);
      out[off + 2] = ((t.terrainUp & 0x0f) << 4) | (t.terrainDown & 0x0f);
      out[off + 3] = (t.object & 0x7f) | (isWater ? 0x80 : 0);
      off += 4;
    }
    for (let x = 0; x < cols; x++) {
      const t: MapTile = tiles[rowBase + x];
      const idleOwner = idleTiles.get(rowBase + x);
      const idle = idleOwner === undefined ? 0 : 0x80 | (idleOwner & 3);
      if (t.object >= 1 && t.object <= 4) {
        dv.setUint16(off, t.objIndex & 0xffff, true);
        out[off + 1] |= idle;
      } else {
        out[off] = (((t.mineral & 7) << 5) | (t.resourceAmount & 0x1f)) & 0xff;
        out[off + 1] = idle;
      }
      dv.setUint16(off + 2, t.serfIndex & 0xffff, true);
      off += 4;
    }
  }
}

/** Occupancy bitmap of an entity block: bit `7-(i&7)` in byte `i>>3`. */
function writeBitmap(out: Uint8Array, base: number, maxIndex: number, occupied: readonly number[]): void {
  out.fill(0, base, base + bitmapSize(maxIndex));
  for (const i of occupied) {
    if (i < 0 || i >= maxIndex) continue;
    out[base + (i >> 3)] |= 1 << (7 - (i & 7));
  }
}

function writeSerf(out: Uint8Array, dv: DataView, at: number, s: SerfRecord, rowShift: number): void {
  out[at] = (s.owner & 3) | ((s.type & 0x1f) << 2) | (s.sound ? 0x80 : 0);
  out[at + 1] = s.animation & 0xff;
  dv.setUint16(at + 2, s.counter & 0xffff, true);
  // `col === null` means no tile; the original stores 0xFFFFFFFF for that (only the null slot 0).
  dv.setUint32(at + 4, s.col === null || s.row === null ? 0xffffffff : encodePos(s.col, s.row, rowShift), true);
  dv.setUint16(at + 8, s.tick & 0xffff, true);
  out[at + 10] = s.state & 0xff;
  for (let i = 0; i < 5; i++) out[at + 11 + i] = s.stateData[i] & 0xff;
}

function writeFlag(out: Uint8Array, dv: DataView, at: number, f: FlagRecord): void {
  dv.setUint16(at, f.searchNum & 0xffff, true);
  out[at + 2] = f.searchDir & 0xff;
  let pathCon = 0;
  for (let j = 0; j < 6; j++) if (f.paths[j]) pathCon |= 1 << j;
  out[at + 3] = ((f.owner & 3) << 6) | pathCon;
  let endpoint = (f.hasBuilding ? 0x40 : 0) | (f.hasResources ? 0x80 : 0);
  for (let j = 0; j < 6; j++) if (f.endpointDirs[j]) endpoint |= 1 << j;
  out[at + 4] = endpoint;
  let transporter = f.serfRequestFail ? 0x80 : 0;
  for (let j = 0; j < 6; j++) if (f.transporters[j]) transporter |= 1 << j;
  out[at + 5] = transporter;
  for (let j = 0; j < 6; j++) out[at + 6 + j] = f.length[j] & 0xff;
  for (let j = 0; j < 8; j++) {
    out[at + 12 + j] = (((f.slotDir[j] + 1) & 7) << 5) | ((f.resourceSlots[j] + 1) & 0x1f);
    dv.setUint16(at + 20 + j * 2, f.slotDest[j] & 0xffff, true);
  }
  for (let j = 0; j < 6; j++) {
    const c = f.connections[j];
    // A missing connection is a **negative** i32 in the original whose exact value our model does
    // not carry (the parser only tests `< 0`). The base stays there — unlike the records themselves
    // this is a real gap, not a derivable quantity.
    if (c) dv.setInt32(at + 36 + j * 4, c.index * (c.kind === 'building' ? BUILDING_RECORD_SIZE : FLAG_RECORD_SIZE), true);
    out[at + 60 + j] = (f.scheduled[j] ? 0x80 : 0) | ((f.otherEndDir[j] & 7) << 3) | (f.scheduledSlot[j] & 7);
  }
  out[at + 66] = f.bldFlags & 0xff;
  out[at + 67] = f.stockPriority[0] & 0xff;
  out[at + 68] = f.bld2Flags & 0xff;
  out[at + 69] = f.stockPriority[1] & 0xff;
}

function writeBuilding(out: Uint8Array, dv: DataView, at: number, b: BuildingRecord, rowShift: number): void {
  dv.setUint32(at, encodePos(b.col, b.row, rowShift), true);
  out[at + 4] = (b.owner & 3) | ((b.type & 0x1f) << 2) | (b.constructing ? 0x80 : 0);
  out[at + 5] =
    (b.threatLevel & 3) |
    (b.serfRequestFailed ? 4 : 0) |
    (b.playingSfx ? 8 : 0) |
    (b.active ? 16 : 0) |
    (b.burning ? 32 : 0) |
    (b.holder ? 64 : 0) |
    (b.serfRequested ? 128 : 0);
  dv.setUint16(at + 6, b.flag & 0xffff, true);
  // Stock nibbles — lossless, including the inventory marker 0xff (`{15,15}`, see parser).
  for (let i = 0; i < 2; i++) out[at + 8 + i] = ((b.stock[i].available & 0xf) << 4) | (b.stock[i].requested & 0xf);
  dv.setUint16(at + 10, b.firstKnight & 0xffff, true);
  dv.setUint16(at + 12, b.progress & 0xffff, true);
  // Byte 14 is a union: u32 inventory offset for a finished inventory building, otherwise u16
  // `level` (and then 16/17 carry the stock maxima while under construction).
  if (b.inventoryIndex !== null) {
    dv.setUint32(at + 14, b.inventoryIndex * INVENTORY_RECORD_SIZE, true);
  } else {
    dv.setUint16(at + 14, (b.level ?? 0) & 0xffff, true);
    if (b.stockMaximum) {
      out[at + 16] = b.stockMaximum[0] & 0xff;
      out[at + 17] = b.stockMaximum[1] & 0xff;
    }
  }
}

function writeInventory(out: Uint8Array, dv: DataView, at: number, v: InventoryRecord): void {
  out[at] = v.owner & 0xff;
  out[at + 1] = v.resDir & 0xff;
  dv.setUint16(at + 2, v.flag & 0xffff, true);
  dv.setUint16(at + 4, v.building & 0xffff, true);
  for (let j = 0; j < 26; j++) dv.setUint16(at + 6 + j * 2, v.resources[j] & 0xffff, true);
  for (let j = 0; j < 2; j++) {
    out[at + 58 + j] = (v.outQueue[j].type + 1) & 0xff;
    dv.setUint16(at + 60 + j * 2, v.outQueue[j].dest & 0xffff, true);
  }
  dv.setUint16(at + 64, v.genericCount & 0xffff, true);
  for (let j = 0; j < 27; j++) dv.setUint16(at + 66 + j * 2, v.serfIndices[j] & 0xffff, true);
}

/**
 * Player block (8628 B per slot, all four). In the original this is a **RAM dump** — four
 * `copy_bytes` in @0x470ce with source `gs->playerN - 0x80`. The encoder must therefore build it
 * field by field from the model; there is no write routine whose order could be mirrored, and
 * whatever is missing here is missing from a save played in this port.
 *
 * The offsets are imported from `save-parser.ts` — the same source the reader uses. A copy here
 * would be a second truth, and with ~60 offsets drift is only a matter of time.
 *
 * Not written (stay base/0) because our model does not carry them:
 * 398..401 · 502..503 — unnamed u16 slots
 * 604..955 — the AI's four **survey tables** (44 u16 each). Scratch data: at all five call sites the
 *            reading block follows within 8 bytes of the call, which is why the parser does not
 *            carry them. For a saved game that means the AI restarts its survey after loading —
 *            the same as an original save enforces.
 */
function writePlayer(out: Uint8Array, dv: DataView, base: number, p: PlayerRecord, geo: { cols: number; rowShift: number }): void {
  const u16 = (off: number, v: number): void => dv.setUint16(base + off, v & 0xffff, true);
  const u32 = (off: number, v: number): void => dv.setUint32(base + off, v >>> 0, true);
  const u8 = (off: number, v: number): void => {
    out[base + off] = v & 0xff;
  };
  const u16s = (off: number, xs: readonly number[]): void => xs.forEach((v, i) => u16(off + i * 2, v));
  const u8s = (off: number, xs: readonly number[]): void => xs.forEach((v, i) => u8(off + i, v));

  u16s(PLAYER_TOOL_PRIO_OFF, p.toolPriority);
  u8s(PLAYER_RESOURCE_COUNT_OFF, p.resourceCount);
  u8s(PLAYER_FLAG_PRIO_OFF, p.flagPriority);
  u16s(PLAYER_SERF_COUNT_OFF, p.serfCount);
  u8s(PLAYER_KNIGHT_OCC_OFF, p.knightOccupation);
  u16(PLAYER_INDEX_OFF, p.index);
  // Byte 130 carries `flags` (bit 6 == active) — the model keeps the whole byte, not just the bit.
  u8(130, p.flags);
  u8(PLAYER_BUILD_OFF, p.build);
  u16s(PLAYER_COMPLETED_BLD_OFF, p.completedBuildingCount);
  u16s(PLAYER_INCOMPLETE_BLD_OFF, p.incompleteBuildingCount);
  u8s(PLAYER_INVENTORY_PRIO_OFF, p.inventoryPriority);
  // The parser keeps `attackingBuildings` **compacted** (non-zero only). The order survives but
  // gaps between occupied slots are lost — so only the prefix is written and the rest left to the
  // base. An attack is rescheduled after loading anyway.
  u16s(PLAYER_ATTACKING_BLDS_OFF, p.attackingBuildings);
  u16(PLAYER_CURRENT_SETT5_OFF, p.currentSett5Item);
  u16(PLAYER_CURSOR_COL_OFF, p.cursorCol);
  u16(PLAYER_CURSOR_ROW_OFF, p.cursorRow);
  u16(PLAYER_CASTLE_BUILDING_OFF, p.castleBuilding);
  u16(PLAYER_CASTLE_FLAG_OFF, p.castleFlag);
  u16(PLAYER_CASTLE_INVENTORY_OFF, p.castleInventory);
  u16(PLAYER_CONT_SEARCH_OFF, p.contSearchAfterNonOptimalFind);
  u16(PLAYER_KNIGHTS_TO_SPAWN_OFF, p.knightsToSpawn);
  u32(PLAYER_LAND_SCORE_OFF, p.totalLandScore);
  u32(PLAYER_BUILDING_SCORE_OFF, p.totalBuildingScore);
  u32(PLAYER_MILITARY_SCORE_OFF, p.totalMilitaryScore);
  u16(PLAYER_LAST_TICK_OFF, p.lastTick);
  u16(PLAYER_REPRO_COUNTER_OFF, p.reproductionCounter);
  u16(PLAYER_REPRO_RESET_OFF, p.reproductionReset);
  u16(PLAYER_SERF_KNIGHT_RATE_OFF, p.serfToKnightRate);
  u16(PLAYER_SERF_KNIGHT_COUNTER_OFF, p.serfToKnightCounter);
  u16(PLAYER_ATTACKING_BLD_COUNT_OFF, p.attackingBuildingCount);
  u16s(PLAYER_ATTACKING_KNIGHTS_OFF, p.attackingKnights);
  u16(PLAYER_TOTAL_ATK_KNIGHTS_OFF, p.totalAttackingKnights);
  u16(PLAYER_BUILDING_ATTACKED_OFF, p.buildingAttacked);
  u16(PLAYER_KNIGHTS_ATTACKING_OFF, p.knightsAttacking);
  u16s(PLAYER_ANALYSIS_OFF, p.analysis);
  u16s(PLAYER_FOOD_DIST_OFF, p.foodDistribution);
  u16s(PLAYER_PLANKS_DIST_OFF, p.planksDistribution);
  u16s(PLAYER_STEEL_DIST_OFF, p.steelDistribution);
  u16s(PLAYER_COAL_DIST_OFF, p.coalDistribution);
  u16s(PLAYER_WHEAT_DIST_OFF, p.wheatDistribution);
  u16(PLAYER_CURRENT_SETT6_OFF, p.currentSett6Item);
  dv.setInt16(base + PLAYER_CASTLE_BALANCE_OFF, p.castleCaptureBalance, true);
  u16(PLAYER_GENERIC_REQUEST_COOLDOWN_OFF, p.genericRequestCooldown);
  u8(PLAYER_DIFFICULTY_OFF, p.difficulty);
  u8(PLAYER_MESSAGE_FLAGS_OFF, p.messageFlags);
  u8(PLAYER_HELD_PLANKS_OFF, p.heldPlanks);
  u8(PLAYER_HELD_STONE_OFF, p.heldStone);
  u16s(PLAYER_MESSAGE_BUILDING_OFF, p.messageBuildingSlots);
  u16(PLAYER_HINT_RETURN_DELAY_OFF, p.hintReturnDelay);
  u16(PLAYER_CASTLE_BUILDER_SERF_OFF, p.castleBuilderSerf);
  u16(PLAYER_KNIGHT_SHIFT_TIMER_OFF, p.knightShiftTimer);
  u16(PLAYER_RECALL_COUNT_OFF, p.recallCount);
  u16(PLAYER_CASTLE_REQUEST_COOLDOWN_OFF, p.castleRequestCooldown);
  u32(PLAYER_MILITARY_GOLD_CAP_OFF, p.militaryGoldCapacity);
  u32(PLAYER_MILITARY_GOLD_OFF, p.militaryGoldAccumulator);
  u32(PLAYER_GOLD_ACCUMULATOR_OFF, p.goldAccumulator);
  u16(PLAYER_GOLD_MORALE_OFF, p.goldMorale);
  u16(PLAYER_MILITARY_STRENGTH_OFF, p.militaryStrengthRatio);
  u16(PLAYER_GOLD_DEPOSITED_OFF, p.goldDeposited);
  u16(PLAYER_KNIGHT_MENU_OFF, p.knightMenuValue);
  u16(PLAYER_KNIGHT_MENU_OFF + 2, p.knightMenuCounter);
  u16(PLAYER_AI_OCCUPATION_CAP_OFF, p.aiOccupationCap);
  u16(PLAYER_AI_ATTACK_KNIGHT_FACTOR_OFF, p.aiAttackKnightFactor);
  u16(PLAYER_AI_ATTACK_CHANCE_FACTOR_OFF, p.aiAttackChanceFactor);
  u16(PLAYER_AI_ATTACK_TARGET_MASK_OFF, p.aiAttackTargetMask);
  u16(PLAYER_AI_ATTACK_CHANCE_OFF, p.aiAttackStrongChance);
  u16(PLAYER_AI_HUT_CAP_OFF, p.aiHutUrgencyCap);
  u16(PLAYER_AI_BUILDING_CURSOR_OFF, p.aiBuildingCursor);
  u16(PLAYER_AI_ROAD_JOB_OFF[0], p.aiRoadJob540);
  u16(PLAYER_AI_ROAD_JOB_OFF[1], p.aiRoadJob542);
  u32(PLAYER_AI_FLAG_SWEEP_OFF, p.aiFlagSweepCursor);
  u16(PLAYER_AI_ROAD_JOB_OFF[2], p.aiRoadJob548);
  u16(PLAYER_AI_ROAD_JOB_OFF[3], p.aiRoadJob550);
  u16(PLAYER_AI_ROAD_JOB_OFF[4], p.aiRoadJob552);
  u16(PLAYER_AI_OCCUPATION_LEVEL_OFF, p.aiKnightOccupationLevel);
  u16(PLAYER_AI_KNIGHT_TOTAL_OFF, p.aiKnightTotal);
  u16(PLAYER_AI_RATE_OFF, p.aiRate);
  u16(PLAYER_AI_SHIFT_COOLDOWN_OFF, p.aiShiftCooldown);
  u16(PLAYER_AI_TIMER562_OFF, p.aiTimer562);
  u16(PLAYER_AI_STATE_OFF, p.aiState);
  u16(PLAYER_AI_COUNTER_OFF, p.aiCounter);
  u16(PLAYER_AI_PRESSURE_CATCHUP_OFF, p.aiPressureCatchUp);
  u16(PLAYER_AI_ROAD_JOB_OFF[5], p.aiRoadJob570);
  for (let i = 0; i < PLAYER_AI_LOSS_REGISTER_SLOTS; i++) {
    u16(PLAYER_AI_LOSS_REGISTER_OFF + i * 4, p.aiLossRegister[i].col);
    u16(PLAYER_AI_LOSS_REGISTER_OFF + i * 4 + 2, p.aiLossRegister[i].row);
  }
  u16s(PLAYER_AI_SUPPLY_OFF, p.aiSupplyRatio);
  u16s(PLAYER_AI_IDLE_SERFS_OFF, p.aiIdleSerfs);
  u16s(PLAYER_AI_STOCKPILE_OFF, p.aiStockpile);
  u16s(PLAYER_AI_URGENCY_OFF, p.aiUrgency);
  u16s(PLAYER_AI_PRESSURE_OFF, p.aiPressure);
  for (let proj = 0; proj < PLAYER_AI_PROJECTS; proj++) {
    for (let slot = 0; slot < PLAYER_AI_CANDIDATE_SLOTS; slot++) {
      const at = PLAYER_AI_CANDIDATES_OFF + (proj * PLAYER_AI_CANDIDATE_SLOTS + slot) * 6;
      const c = p.aiCandidates[proj][slot];
      u16(at, c.score);
      u16(at + 2, c.col);
      u16(at + 4, c.row);
    }
  }
  // The two history arrays are empty for inactive players (the parser reads them only for active
  // ones) — the base/0 stays there, which matches the real byte picture.
  p.statHistory.forEach((row: readonly number[], m: number) => u8s(PLAYER_STAT_HISTORY_OFF + m * PLAYER_STAT_SAMPLES, row));
  p.resourceHistory.forEach((row: readonly number[], r: number) => u8s(PLAYER_RES_HISTORY_OFF + r * PLAYER_RES_SAMPLES, row));
  // Message list: the type column is prefix-packed, so the rest must be **zeroed** — otherwise an
  // old entry would survive behind the prefix and the consumer would read it. The position column
  // the original does NOT clear (it only erases the type byte); there the base residual stays behind
  // the prefix, exactly as in a real save.
  for (let j = 0; j < PLAYER_MESSAGE_SLOTS; j++) {
    u8(PLAYER_MESSAGE_TYPES_OFF + j, j < p.messageTypes.length ? p.messageTypes[j] : 0);
  }
  p.messagePositions.forEach((pos: number, j: number) => {
    const col = pos % geo.cols;
    const row = Math.floor(pos / geo.cols);
    u32(PLAYER_MESSAGE_POS_OFF + j * 4, encodePos(col, row, geo.rowShift));
  });
  for (let j = 0; j < PLAYER_MESSAGE_SLOTS; j++) {
    const at = PLAYER_RECALL_FIFO_OFF + j * 8;
    u32(at, p.recallQueue[j].remaining);
    dv.setInt32(base + at + 4, p.recallQueue[j].payload, true);
  }
}

/**
 * Produces the `.DS` bytes for a game state.
 *
 * Every block is written; whatever the model does not carry stays from `opts.base` resp. 0.
 */
export function encodeSaveGame(state: SaveGameState, opts: EncodeOptions = {}): Uint8Array {
  const size = saveGameByteLength(state);
  const out = new Uint8Array(size);
  const base = opts.base ?? null;
  if (base) {
    // Prefill so the not-yet-modelled ranges survive. Deliberately BEFORE writing: every field the
    // encoder knows overwrites the base afterwards.
    //
    // BUT only as far as the base actually lies at the same place. If the serf block grows (the
    // engine created settlers), every block behind it shifts — passing the base through would then
    // push foreign bytes into the remaining gaps of the flags. Header, player blocks and map are
    // unaffected by the shift (fixed size resp. `tileCount`).
    const invariant = HEADER_SIZE + 4 * PLAYER_RECORD_SIZE + MAP_TILE_SIZE * state.header.tileCount;
    const usable = base.length === size ? size : Math.min(invariant, base.length);
    out.set(base.subarray(0, usable));
  }
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const h = state.header;
  const rowShift = 5 + Math.floor(h.mapSize / 2); // == col_size, as in the parser

  writeHeader(new Writer(dv), state);

  const geo = { cols: h.mapCols, rowShift };
  // By `slot`, not by array position: the parser delivers all four slots in order, the engine
  // (`snapshot`) the NON-NULL records — with an empty slot 0 the two forms would diverge, and
  // invisibly so (the block would be valid, just at the wrong player).
  for (const p of state.playerRecords) {
    writePlayer(out, dv, HEADER_SIZE + p.slot * PLAYER_RECORD_SIZE, p, geo);
  }
  let off = HEADER_SIZE + 4 * PLAYER_RECORD_SIZE;

  // Tiles a carrier rests on, together with its owner — the redundant cache in the map block
  // (see `writeMapTiles`).
  const idleTiles = new Map<number, number>();
  for (const s of state.serfRecords) {
    if (s.col === null || s.row === null) continue;
    if (IDLE_ON_PATH_STATES.has(s.state)) idleTiles.set(s.row * h.mapCols + s.col, s.owner);
  }
  writeMapTiles(out, dv, off, state, idleTiles);
  off += MAP_TILE_SIZE * h.tileCount;

  writeBitmap(out, off, h.maxSerfIndex, state.serfs.occupied);
  const serfsAt = off + bitmapSize(h.maxSerfIndex);
  for (const s of state.serfRecords) writeSerf(out, dv, serfsAt + s.index * SERF_RECORD_SIZE, s, rowShift);
  off = serfsAt + SERF_RECORD_SIZE * h.maxSerfIndex;

  writeBitmap(out, off, h.maxFlagIndex, state.flags.occupied);
  const flagsAt = off + bitmapSize(h.maxFlagIndex);
  for (const f of state.flagRecords) writeFlag(out, dv, flagsAt + f.index * FLAG_RECORD_SIZE, f);
  off = flagsAt + FLAG_RECORD_SIZE * h.maxFlagIndex;

  writeBitmap(out, off, h.maxBuildingIndex, state.buildings.occupied);
  const bldAt = off + bitmapSize(h.maxBuildingIndex);
  for (const b of state.buildingRecords) writeBuilding(out, dv, bldAt + b.index * BUILDING_RECORD_SIZE, b, rowShift);
  off = bldAt + BUILDING_RECORD_SIZE * h.maxBuildingIndex;

  writeBitmap(out, off, h.maxInventoryIndex, state.inventories.occupied);
  const invAt = off + bitmapSize(h.maxInventoryIndex);
  for (const v of state.inventoryRecords) writeInventory(out, dv, invAt + v.index * INVENTORY_RECORD_SIZE, v);

  return out;
}
