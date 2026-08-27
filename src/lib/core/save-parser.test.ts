import { describe, it, expect } from 'vitest';
import { serfStateFields, parseSaveGame, mapGeometry } from './save-parser.js';

// Layout constants (must match save-parser.ts).
const PLAYER_COUNT = 4;
const PLAYER_RECORD_SIZE = 8628;
const MAP_TILE_SIZE = 8;
const SERF = 16;
const FLAG = 70;
const BUILDING = 18;
const INVENTORY = 120;

interface BuildingFx {
  index: number;
  type: number;
  owner: number;
  col: number;
  row: number;
  constructing?: boolean;
  /** Statusbits (Byte 5). */
  statusByte?: number;
  /** Rohe Stock-Bytes (Byte 8/9); 0xFF = Inventar-Marker. */
  stockBytes?: [number, number];
  /** u32 inventory offset (byte 14); read only for a finished inventory building. */
  inventoryOffset?: number;
  /** u16 `level` (byte 14) for non-inventory buildings. */
  level?: number;
  /** Stock maxima (bytes 16/17) — only relevant during construction. */
  stockMaximum?: [number, number];
}

interface SerfFx {
  index: number;
  type: number;
  owner: number;
  sound?: boolean;
  animation?: number;
  counter?: number;
  /** `null` => position word 0xFFFFFFFF (no tile). */
  col: number | null;
  row?: number | null;
  tick?: number;
  state: number;
  stateData?: number[];
}

interface FlagFx {
  index: number;
  owner: number;
  hasBuilding?: boolean;
  hasResources?: boolean;
  /** Road bitmask over 6 directions (bit j = direction j). */
  pathCon?: number;
  /** Endpunkt-Offsets je Richtung (roher int32; -1 ⇒ NULL). */
  endpoints?: number[];
  /** Bis zu 8 Waren-Slot-Ressourcentypen (-1 = leer). */
  resourceSlots?: number[];
  searchNum?: number;
  searchDir?: number;
  /** Carrier bitmask (byte 5, bits 0-5) + serf_request_fail (bit 7). */
  transporterByte?: number;
  /** Bis zu 6 rohe length-Bytes (Byte 6..11). */
  length?: number[];
  /** Up to 8 slot pickup directions (-1 = not scheduled, otherwise 0..5). */
  slotDir?: number[];
  /** Bis zu 8 Slot-Ziele (u16). */
  slotDest?: number[];
  /** Bis zu 6 rohe other_end_dir-Bytes (Byte 60..65). */
  otherEndDirByte?: number[];
  bldFlags?: number;
  bld2Flags?: number;
  /** Stock priorities (bytes 67/69). */
  stockPriority?: [number, number];
}

interface InventoryFx {
  index: number;
  owner: number;
  resDir?: number;
  flag?: number;
  building?: number;
  /** Up to 26 resource counts (index = resource type). */
  resources?: number[];
  /** Bis zu 2 Ausgangs-Slots (type -1 = leer, dest = Ziel-Flagge). */
  outQueue?: { type: number; dest: number }[];
  genericCount?: number;
  /** Bis zu 27 Serf-Indizes je Typ (0 = keiner). */
  serfIndices?: number[];
}

interface PlayerFx {
  slot: number;
  index?: number;
  completedBuildingCount?: number[];
  incompleteBuildingCount?: number[];
  serfCount?: number[];
  totalBuildingScore?: number;
  totalMilitaryScore?: number;
  castleCaptureBalance?: number;
  toolPriority?: number[];
  resourceCount?: number[];
  flagPriority?: number[];
  inventoryPriority?: number[];
  knightOccupation?: number[];
  castleBuilding?: number;
  castleFlag?: number;
  castleInventory?: number;
  build?: number;
  lastTick?: number;
  reproductionCounter?: number;
  reproductionReset?: number;
  serfToKnightRate?: number;
  serfToKnightCounter?: number;
  attackingBuildingCount?: number;
  totalAttackingKnights?: number;
  buildingAttacked?: number;
  /** Non-zero entries in attacking_buildings[64] @250. */
  attackingBuildings?: number[];
  attackingKnights?: number[];
  currentSett5Item?: number;
  currentSett6Item?: number;
  cursorCol?: number;
  cursorRow?: number;
  contSearchAfterNonOptimalFind?: number;
  knightsToSpawn?: number;
  analysis?: number[];
  foodDistribution?: number[];
  planksDistribution?: number[];
  steelDistribution?: number[];
  coalDistribution?: number[];
  wheatDistribution?: number[];
  /** Einzelne Stat-Historie-Zellen setzen: [mode, sample, value]. */
  statCells?: [number, number, number][];
  /** Einzelne Waren-Historie-Zellen setzen: [resource, sample, value]. */
  resourceCells?: [number, number, number][];
}

interface Fixture {
  gameType: number;
  /** Menu player settings `.DS`@144..163 (loaded only for `gameType > 1`). */
  menuBytes?: number[];
  /** Campaign password `.DS`@128..135 (loaded only for `gameType == 0`). */
  password?: string;
  tick: number;
  random: [number, number, number];
  maxFlagIndex: number;
  maxBuildingIndex: number;
  maxSerfIndex: number;
  maxInventoryIndex: number;
  mapSize: number;
  activePlayers: number[];
  players?: PlayerFx[];
  occupiedSerfs: number[];
  serfs?: SerfFx[];
  flags?: FlagFx[];
  buildings: BuildingFx[];
  inventories?: InventoryFx[];
  mapTiles?: MapTileFx[];
}

interface MapTileFx {
  col: number;
  row: number;
  height?: number;
  owner?: number; // 0 = none, otherwise 1..4 (1-based, as in the format)
  terrainUp?: number;
  terrainDown?: number;
  object?: number;
  paths?: number;
  mineral?: number;
  resourceAmount?: number;
  objIndex?: number;
  serfIndex?: number;
}

function bitmapBytes(maxIndex: number): number {
  return 4 * Math.floor((maxIndex + 31) / 32);
}

/** Sets the occupied bit for `i` (same convention as the original). */
function setOccupied(buf: Uint8Array, bitmapOffset: number, i: number): void {
  buf[bitmapOffset + (i >> 3)] |= 1 << (7 - (i & 7));
}

/** Builds a synthetic, size-exact SAVE*.DS buffer. */
function buildSave(fx: Fixture): Uint8Array {
  const { cols, rows, tileCount } = mapGeometry(fx.mapSize);
  void rows;

  const playersBytes = PLAYER_COUNT * PLAYER_RECORD_SIZE;
  const mapBytes = MAP_TILE_SIZE * tileCount;
  const serfBytes = bitmapBytes(fx.maxSerfIndex) + fx.maxSerfIndex * SERF;
  const flagBytes = bitmapBytes(fx.maxFlagIndex) + fx.maxFlagIndex * FLAG;
  const buildingBytes = bitmapBytes(fx.maxBuildingIndex) + fx.maxBuildingIndex * BUILDING;
  const invBytes = bitmapBytes(fx.maxInventoryIndex) + fx.maxInventoryIndex * INVENTORY;

  const total = 250 + playersBytes + mapBytes + serfBytes + flagBytes + buildingBytes + invBytes;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  dv.setUint16(74, fx.gameType, true);
  if (fx.menuBytes) buf.set(fx.menuBytes, 144);
  if (fx.password !== undefined) {
    for (let i = 0; i < 8; i++) buf[128 + i] = fx.password.charCodeAt(i);
  }
  dv.setUint16(78, fx.tick, true);
  dv.setUint16(84, fx.random[0], true);
  dv.setUint16(86, fx.random[1], true);
  dv.setUint16(88, fx.random[2], true);
  dv.setUint16(90, fx.maxFlagIndex, true);
  dv.setUint16(92, fx.maxBuildingIndex, true);
  dv.setUint16(94, fx.maxSerfIndex, true);
  dv.setUint16(174, fx.maxInventoryIndex, true);
  dv.setUint16(190, fx.mapSize, true);

  // Player active bit (byte[130] bit 6 in the respective block).
  for (const p of fx.activePlayers) {
    buf[250 + p * PLAYER_RECORD_SIZE + 130] |= 1 << 6;
  }

  // Optional player block fields at the verified offsets.
  for (const pd of fx.players ?? []) {
    const base = 250 + pd.slot * PLAYER_RECORD_SIZE;
    if (pd.index !== undefined) dv.setUint16(base + 128, pd.index, true);
    const completed = pd.completedBuildingCount ?? [];
    for (let j = 0; j < 23; j++) dv.setUint16(base + 132 + j * 2, completed[j] ?? 0, true);
    const incomplete = pd.incompleteBuildingCount ?? [];
    for (let j = 0; j < 23; j++) dv.setUint16(base + 178 + j * 2, incomplete[j] ?? 0, true);
    const serfCount = pd.serfCount ?? [];
    for (let j = 0; j < 27; j++) dv.setUint16(base + 70 + j * 2, serfCount[j] ?? 0, true);
    const toolPrio = pd.toolPriority ?? [];
    for (let j = 0; j < 9; j++) dv.setUint16(base + 0 + j * 2, toolPrio[j] ?? 0, true);
    const resCount = pd.resourceCount ?? [];
    for (let j = 0; j < 26; j++) dv.setUint8(base + 18 + j, resCount[j] ?? 0);
    const flagPrio = pd.flagPriority ?? [];
    for (let j = 0; j < 26; j++) dv.setUint8(base + 44 + j, flagPrio[j] ?? 0);
    const invPrio = pd.inventoryPriority ?? [];
    for (let j = 0; j < 26; j++) dv.setUint8(base + 224 + j, invPrio[j] ?? 0);
    const knightOcc = pd.knightOccupation ?? [];
    for (let j = 0; j < 4; j++) dv.setUint8(base + 124 + j, knightOcc[j] ?? 0);
    if (pd.castleBuilding !== undefined) dv.setUint16(base + 388, pd.castleBuilding, true);
    if (pd.castleFlag !== undefined) dv.setUint16(base + 390, pd.castleFlag, true);
    if (pd.castleInventory !== undefined) dv.setUint16(base + 392, pd.castleInventory, true);
    if (pd.build !== undefined) dv.setUint8(base + 131, pd.build);
    if (pd.lastTick !== undefined) dv.setUint16(base + 414, pd.lastTick, true);
    if (pd.reproductionCounter !== undefined) dv.setUint16(base + 416, pd.reproductionCounter, true);
    if (pd.reproductionReset !== undefined) dv.setUint16(base + 418, pd.reproductionReset, true);
    if (pd.serfToKnightRate !== undefined) dv.setUint16(base + 420, pd.serfToKnightRate, true);
    if (pd.serfToKnightCounter !== undefined) dv.setUint16(base + 422, pd.serfToKnightCounter, true);
    if (pd.attackingBuildingCount !== undefined)
      dv.setUint16(base + 424, pd.attackingBuildingCount, true);
    if (pd.totalAttackingKnights !== undefined)
      dv.setUint16(base + 434, pd.totalAttackingKnights, true);
    if (pd.buildingAttacked !== undefined) dv.setUint16(base + 436, pd.buildingAttacked, true);
    const atkBlds = pd.attackingBuildings ?? [];
    for (let j = 0; j < atkBlds.length && j < 64; j++) dv.setUint16(base + 250 + j * 2, atkBlds[j], true);
    const atkKnights = pd.attackingKnights ?? [];
    for (let j = 0; j < 4; j++) dv.setUint16(base + 426 + j * 2, atkKnights[j] ?? 0, true);
    if (pd.currentSett5Item !== undefined) dv.setUint16(base + 378, pd.currentSett5Item, true);
    if (pd.cursorCol !== undefined) dv.setUint16(base + 380, pd.cursorCol, true);
    if (pd.cursorRow !== undefined) dv.setUint16(base + 382, pd.cursorRow, true);
    if (pd.currentSett6Item !== undefined) dv.setUint16(base + 476, pd.currentSett6Item, true);
    if (pd.contSearchAfterNonOptimalFind !== undefined)
      dv.setUint16(base + 394, pd.contSearchAfterNonOptimalFind, true);
    if (pd.knightsToSpawn !== undefined) dv.setUint16(base + 396, pd.knightsToSpawn, true);
    const analysis = pd.analysis ?? [];
    for (let j = 0; j < 4; j++) dv.setUint16(base + 440 + j * 2, analysis[j] ?? 0, true);
    const food = pd.foodDistribution ?? [];
    for (let j = 0; j < 4; j++) dv.setUint16(base + 448 + j * 2, food[j] ?? 0, true);
    const planks = pd.planksDistribution ?? [];
    for (let j = 0; j < 3; j++) dv.setUint16(base + 456 + j * 2, planks[j] ?? 0, true);
    const steel = pd.steelDistribution ?? [];
    for (let j = 0; j < 2; j++) dv.setUint16(base + 462 + j * 2, steel[j] ?? 0, true);
    const coal = pd.coalDistribution ?? [];
    for (let j = 0; j < 3; j++) dv.setUint16(base + 466 + j * 2, coal[j] ?? 0, true);
    const wheat = pd.wheatDistribution ?? [];
    for (let j = 0; j < 2; j++) dv.setUint16(base + 472 + j * 2, wheat[j] ?? 0, true);
    if (pd.totalBuildingScore !== undefined) dv.setUint32(base + 406, pd.totalBuildingScore, true);
    if (pd.totalMilitaryScore !== undefined) dv.setUint32(base + 410, pd.totalMilitaryScore, true);
    if (pd.castleCaptureBalance !== undefined) dv.setInt16(base + 478, pd.castleCaptureBalance, true);
    // Statistik-Historie: stat @2884 [16][112], resource @4676 [26][120], beide u8.
    for (const [m, s, v] of pd.statCells ?? []) dv.setUint8(base + 2884 + m * 112 + s, v);
    for (const [r, s, v] of pd.resourceCells ?? []) dv.setUint8(base + 4676 + r * 120 + s, v);
  }

  // Map tiles (row-interleaved: per row cols*4 landscape, then cols*4 game/resource).
  const mapBase = 250 + playersBytes;
  for (const t of fx.mapTiles ?? []) {
    const landOff = mapBase + t.row * cols * 8 + t.col * 4;
    const ownerBits = t.owner && t.owner > 0 ? 0x80 | (((t.owner - 1) & 3) << 5) : 0;
    dv.setUint8(landOff, (t.paths ?? 0) & 0x3f);
    dv.setUint8(landOff + 1, (ownerBits | ((t.height ?? 0) & 0x1f)) & 0xff);
    dv.setUint8(landOff + 2, ((((t.terrainUp ?? 0) & 0x0f) << 4) | ((t.terrainDown ?? 0) & 0x0f)) & 0xff);
    dv.setUint8(landOff + 3, (t.object ?? 0) & 0x7f);
    const gameOff = mapBase + t.row * cols * 8 + cols * 4 + t.col * 4;
    const obj = t.object ?? 0;
    if (obj >= 1 && obj <= 4) {
      dv.setUint16(gameOff, t.objIndex ?? 0, true);
    } else {
      dv.setUint8(gameOff, ((((t.mineral ?? 0) & 7) << 5) | ((t.resourceAmount ?? 0) & 0x1f)) & 0xff);
    }
    dv.setUint16(gameOff + 2, t.serfIndex ?? 0, true);
  }

  // Serf-Bitmap liegt direkt nach Header + Players + Map.
  const serfBitmapOffset = 250 + playersBytes + mapBytes;
  const serfRecordsOffset = serfBitmapOffset + bitmapBytes(fx.maxSerfIndex);
  const serfRowShift = 5 + Math.floor(fx.mapSize / 2);
  for (const i of fx.occupiedSerfs) setOccupied(buf, serfBitmapOffset, i);
  for (const s of fx.serfs ?? []) {
    setOccupied(buf, serfBitmapOffset, s.index);
    const base = serfRecordsOffset + s.index * SERF;
    dv.setUint8(base, ((s.sound ? 0x80 : 0) | ((s.type & 0x1f) << 2) | (s.owner & 3)) & 0xff);
    dv.setUint8(base + 1, s.animation ?? 0);
    dv.setUint16(base + 2, s.counter ?? 0, true);
    const pos =
      s.col === null
        ? 0xffffffff
        : (((((s.row ?? 0) << (serfRowShift + 1)) | s.col) << 2) >>> 0);
    dv.setUint32(base + 4, pos, true);
    dv.setUint16(base + 8, s.tick ?? 0, true);
    dv.setUint8(base + 10, s.state);
    const sd = s.stateData ?? [];
    for (let k = 0; k < 5; k++) dv.setUint8(base + 11 + k, sd[k] ?? 0);
  }

  // Flag block: directly after the serfs.
  const flagBitmapOffset = serfBitmapOffset + serfBytes;
  const flagRecordsOffset = flagBitmapOffset + bitmapBytes(fx.maxFlagIndex);
  for (const f of fx.flags ?? []) {
    setOccupied(buf, flagBitmapOffset, f.index);
    const base = flagRecordsOffset + f.index * FLAG;
    dv.setUint16(base, f.searchNum ?? 0, true);
    dv.setUint8(base + 2, f.searchDir ?? 0);
    dv.setUint8(base + 3, (((f.owner & 3) << 6) | ((f.pathCon ?? 0) & 0x3f)) & 0xff);
    dv.setUint8(base + 4, ((f.hasBuilding ? 1 << 6 : 0) | (f.hasResources ? 1 << 7 : 0)) & 0xff);
    dv.setUint8(base + 5, f.transporterByte ?? 0);
    const len = f.length ?? [];
    for (let j = 0; j < 6; j++) dv.setUint8(base + 6 + j, len[j] ?? 0);
    const eps = f.endpoints ?? [];
    for (let j = 0; j < 6; j++) dv.setInt32(base + 36 + j * 4, eps[j] ?? -1, true);
    // Waren-Slots: Byte 12+j packt type (Bits 0-4) + dir (Bits 5-7); dest als u16 ab Byte 20.
    const slots = f.resourceSlots ?? [];
    const sdir = f.slotDir ?? [];
    const sdest = f.slotDest ?? [];
    for (let j = 0; j < 8; j++) {
      const typeBits = ((slots[j] ?? -1) + 1) & 0x1f;
      const dirBits = (((sdir[j] ?? -1) + 1) & 7) << 5;
      dv.setUint8(base + 12 + j, (typeBits | dirBits) & 0xff);
      dv.setUint16(base + 20 + j * 2, sdest[j] ?? 0, true);
    }
    const oed = f.otherEndDirByte ?? [];
    for (let j = 0; j < 6; j++) dv.setUint8(base + 60 + j, oed[j] ?? 0);
    dv.setUint8(base + 66, f.bldFlags ?? 0);
    dv.setUint8(base + 68, f.bld2Flags ?? 0);
    dv.setUint8(base + 67, f.stockPriority?.[0] ?? 0);
    dv.setUint8(base + 69, f.stockPriority?.[1] ?? 0);
  }

  // Building-Block: nach Serfs + Flags.
  const buildingBitmapOffset = serfBitmapOffset + serfBytes + flagBytes;
  const buildingRecordsOffset = buildingBitmapOffset + bitmapBytes(fx.maxBuildingIndex);
  const rowShift = 5 + Math.floor(fx.mapSize / 2);
  for (const b of fx.buildings) {
    setOccupied(buf, buildingBitmapOffset, b.index);
    const base = buildingRecordsOffset + b.index * BUILDING;
    // Position word: inverse of the decode formula ((row<<(rowShift+1))|col)<<2.
    dv.setUint32(base, (((b.row << (rowShift + 1)) | b.col) << 2) >>> 0, true);
    dv.setUint8(base + 4, ((b.constructing ? 0x80 : 0) | (b.type << 2) | b.owner) & 0xff);
    dv.setUint8(base + 5, b.statusByte ?? 0);
    dv.setUint8(base + 8, b.stockBytes?.[0] ?? 0);
    dv.setUint8(base + 9, b.stockBytes?.[1] ?? 0);
    if (b.inventoryOffset !== undefined) dv.setUint32(base + 14, b.inventoryOffset, true);
    else dv.setUint16(base + 14, b.level ?? 0, true);
    dv.setUint8(base + 16, b.stockMaximum?.[0] ?? 0);
    dv.setUint8(base + 17, b.stockMaximum?.[1] ?? 0);
  }

  // Inventory-Block: letzter Block, nach Buildings.
  const invBitmapOffset = buildingBitmapOffset + buildingBytes;
  const invRecordsOffset = invBitmapOffset + bitmapBytes(fx.maxInventoryIndex);
  for (const inv of fx.inventories ?? []) {
    setOccupied(buf, invBitmapOffset, inv.index);
    const base = invRecordsOffset + inv.index * INVENTORY;
    dv.setUint8(base, inv.owner & 0xff);
    dv.setUint8(base + 1, inv.resDir ?? 0);
    dv.setUint16(base + 2, inv.flag ?? 0, true);
    dv.setUint16(base + 4, inv.building ?? 0, true);
    const res = inv.resources ?? [];
    for (let j = 0; j < 26; j++) dv.setUint16(base + 6 + j * 2, res[j] ?? 0, true);
    const oq = inv.outQueue ?? [];
    for (let j = 0; j < 2; j++) {
      dv.setUint8(base + 58 + j, ((oq[j]?.type ?? -1) + 1) & 0xff);
      dv.setUint16(base + 60 + j * 2, oq[j]?.dest ?? 0, true);
    }
    dv.setUint16(base + 64, inv.genericCount ?? 0, true);
    const si = inv.serfIndices ?? [];
    for (let j = 0; j < 27; j++) dv.setUint16(base + 66 + j * 2, si[j] ?? 0, true);
  }

  return buf;
}

const baseFixture: Fixture = {
  gameType: 0,
  tick: 1234,
  random: [0x0380, 0xeea7, 0x6b11],
  maxFlagIndex: 2,
  maxBuildingIndex: 2,
  maxSerfIndex: 3,
  maxInventoryIndex: 1,
  mapSize: 3,
  activePlayers: [0, 1],
  occupiedSerfs: [0, 2],
  buildings: [
    { index: 0, type: 24, owner: 0, col: 25, row: 46 }, // Castle Spieler 0
    { index: 1, type: 11, owner: 1, col: 51, row: 42 }, // Hut Spieler 1
  ],
};

describe('mapGeometry', () => {
  it('size=3 → 64×64 = 4096 Tiles (verifiziert gegen SAVE0.DS)', () => {
    expect(mapGeometry(3)).toEqual({ cols: 64, rows: 64, tileCount: 4096 });
  });

  it('size=4 → 128×64 = 8192 Tiles', () => {
    expect(mapGeometry(4)).toEqual({ cols: 128, rows: 64, tileCount: 8192 });
  });
});

describe('parseSaveGame — menu player settings (.DS@144..163)', () => {
  /** Four slots with distinguishable values, so a swap shows up. */
  const MENU = [
    11, 12, 13, 14, // 144..147 Gesicht
    21, 22, 23, 24, // 148..151 Intelligenz
    31, 32, 33, 34, // 152..155 Vorrat
    41, 42, 43, 44, // 156..159 Fortpflanzung
    51, 52, // 160/161 supplies of the humans
    61, 62, // 162/163 reproduction of the humans
  ];

  it('dekodiert alle sechs Gruppen bei gameType > 1', () => {
    const state = parseSaveGame(buildSave({ ...baseFixture, gameType: 2, menuBytes: MENU }));
    const m = state.header.menuSetup;
    expect(m).toBeDefined();
    expect(m!.face).toEqual([11, 12, 13, 14]);
    expect(m!.intelligence).toEqual([21, 22, 23, 24]);
    expect(m!.supply).toEqual([31, 32, 33, 34]);
    expect(m!.reproduction).toEqual([41, 42, 43, 44]);
    expect(m!.humanSupply).toEqual([51, 52]);
    expect(m!.humanReproduction).toEqual([61, 62]);
  });

  it('does NOT carry the field when gameType <= 1 — in the original there is a leftover there', () => {
    // The original loads the block only behind `jb 0x48010` @0x47f60. A level/mission game takes its
    // players from the setup record; whatever stands here is meaningless.
    for (const gameType of [0, 1]) {
      const state = parseSaveGame(buildSave({ ...baseFixture, gameType, menuBytes: MENU }));
      expect(state.header.menuSetup).toBeUndefined();
    }
  });

  it('does not shift the following fields (cursor arithmetic)', () => {
    // The actual regression guard: the new read block must not slip the cursor.
    const state = parseSaveGame(buildSave({ ...baseFixture, gameType: 2, menuBytes: MENU }));
    expect(state.header.maxInventoryIndex).toBe(1);
    expect(state.header.mapSize).toBe(3);
  });
});

describe('parseSaveGame — campaign password (.DS@128..135)', () => {
  it('decodes the eight bytes at game type 0', () => {
    const state = parseSaveGame(buildSave({ ...baseFixture, gameType: 0, password: 'PASSIVE ' }));
    expect(state.header.levelPassword).toBe('PASSIVE ');
  });

  it('does NOT carry the field beyond game type 0 — the load gate @0x47f0d covers @128 too', () => {
    for (const gameType of [1, 2, 3, 4]) {
      const state = parseSaveGame(buildSave({ ...baseFixture, gameType, password: 'PASSIVE ' }));
      expect(state.header.levelPassword, `gameType ${gameType}`).toBeUndefined();
    }
  });

  it('reads the bytes through unchecked, as the original does', () => {
    // One of our own saves carries eight NUL bytes there; that must parse, not throw.
    const state = parseSaveGame(buildSave({ ...baseFixture, gameType: 0, password: '\0'.repeat(8) }));
    expect(state.header.levelPassword).toHaveLength(8);
  });
});

describe('parseSaveGame', () => {
  it('reads the header primitives at the verified offsets', () => {
    const state = parseSaveGame(buildSave(baseFixture));
    expect(state.header.gameType).toBe(0);
    expect(state.header.tick).toBe(1234);
    expect(state.header.random).toEqual([0x0380, 0xeea7, 0x6b11]);
    expect(state.header.maxFlagIndex).toBe(2);
    expect(state.header.maxBuildingIndex).toBe(2);
    expect(state.header.maxSerfIndex).toBe(3);
    expect(state.header.maxInventoryIndex).toBe(1);
    expect(state.header.mapSize).toBe(3);
  });

  it('derives the map geometry from mapSize', () => {
    const state = parseSaveGame(buildSave(baseFixture));
    expect(state.header.mapCols).toBe(64);
    expect(state.header.mapRows).toBe(64);
    expect(state.header.tileCount).toBe(4096);
  });

  it('recognises active players by the active bit', () => {
    const state = parseSaveGame(buildSave({ ...baseFixture, activePlayers: [1, 3] }));
    expect(state.activePlayers).toEqual([1, 3]);
  });

  it('reads the occupied bitmap of the serfs correctly', () => {
    const state = parseSaveGame(buildSave({ ...baseFixture, occupiedSerfs: [0, 2] }));
    expect(state.serfs.occupied).toEqual([0, 2]);
    expect(state.serfs.maxIndex).toBe(3);
    expect(state.serfs.recordSize).toBe(16);
  });

  it('dekodiert Building-Records (Typ, Owner, Position)', () => {
    const state = parseSaveGame(buildSave(baseFixture));
    expect(state.buildingRecords).toHaveLength(2);
    const castle = state.buildingRecords[0];
    expect(castle).toMatchObject({
      index: 0,
      type: 24,
      typeName: 'Castle',
      owner: 0,
      col: 25,
      row: 46,
    });
    const hut = state.buildingRecords[1];
    expect(hut).toMatchObject({ index: 1, type: 11, typeName: 'Hut', owner: 1, col: 51, row: 42 });
  });

  it('decodes the building stock union (finished inventory building, construction, stock nibbles)', () => {
    const fx: Fixture = {
      ...baseFixture,
      maxBuildingIndex: 4,
      maxInventoryIndex: 2,
      buildings: [
        // Finished castle with inventory marker (byte 8 = 0xFF) -> inventoryIndex from byte 14 (/120).
        {
          index: 0,
          type: 24,
          owner: 0,
          col: 25,
          row: 46,
          stockBytes: [0xff, 0],
          inventoryOffset: 1 * 120,
        },
        // Hut under construction: stock nibbles + maxima.
        {
          index: 1,
          type: 11,
          owner: 1,
          col: 51,
          row: 42,
          constructing: true,
          stockBytes: [0x21, 0x30], // Slot0 avail=2/req=1, Slot1 avail=3/req=0
          stockMaximum: [8, 4],
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    const castle = state.buildingRecords[0];
    expect(castle.hasInventory).toBe(true);
    expect(castle.inventoryIndex).toBe(1);
    expect(castle.level).toBeNull();
    expect(castle.stockMaximum).toBeNull();

    const hut = state.buildingRecords[1];
    expect(hut.constructing).toBe(true);
    expect(hut.hasInventory).toBe(false);
    expect(hut.stock[0]).toEqual({ available: 2, requested: 1 });
    expect(hut.stock[1]).toEqual({ available: 3, requested: 0 });
    expect(hut.stockMaximum).toEqual([8, 4]);
    expect(hut.inventoryIndex).toBeNull();
  });

  it('building type name falls back to Unknown for an unknown type', () => {
    // type 30 is > 24; (30<<2)|owner would be masked above 0x1f. The name fallback is tested
    // separately against the BUILDING_TYPE_NAMES bounds: types 25..31 fit the 5-bit field.
    const fx = { ...baseFixture, buildings: [{ index: 0, type: 25, owner: 0, col: 1, row: 1 }] };
    const state = parseSaveGame(buildSave(fx));
    expect(state.buildingRecords[0].typeName).toBe('Unknown(25)');
  });

  it('dekodiert Serf-Records (Typ, Owner, State, Position)', () => {
    const fx: Fixture = {
      ...baseFixture,
      maxSerfIndex: 4,
      occupiedSerfs: [],
      serfs: [
        {
          index: 1,
          type: 21,
          owner: 0,
          sound: true,
          animation: 7,
          counter: 0x1234,
          col: 25,
          row: 46,
          tick: 0x0042,
          state: 1,
          stateData: [9, 0, 0, 0, 0],
        },
        { index: 2, type: 24, owner: 1, col: 51, row: 42, state: 70 }, // Knight2, DefendingHut
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    expect(state.serfRecords).toHaveLength(2);
    expect(state.serfRecords[0]).toMatchObject({
      index: 1,
      type: 21,
      typeName: 'Generic',
      owner: 0,
      sound: true,
      animation: 7,
      counter: 0x1234,
      col: 25,
      row: 46,
      tick: 0x0042,
      state: 1,
      stateName: 'IdleInStock',
      stateData: [9, 0, 0, 0, 0],
    });
    expect(state.serfRecords[1]).toMatchObject({
      index: 2,
      type: 24,
      typeName: 'Knight2',
      owner: 1,
      col: 51,
      row: 42,
      state: 70,
      stateName: 'DefendingHut',
    });
  });

  it('decodes the state-dependent serf union fields (stateFields per variant)', () => {
    // stateData = [Byte11, Byte12, Byte13, Byte14, Byte15]; u16-Felder = lo|hi<<8.
    const fx: Fixture = {
      ...baseFixture,
      maxSerfIndex: 10,
      occupiedSerfs: [],
      serfs: [
        // Walking (state 2): dir1=0, dest=5 (Byte12/13), dir=3, waitCounter=7.
        { index: 1, type: 0, owner: 0, col: 1, row: 1, state: 2, stateData: [0, 5, 0, 3, 7] },
        // Transporting (state 3): res = 7-1 = 6 (Lumber), dest=9, dir=2, waitCounter=1.
        { index: 2, type: 0, owner: 0, col: 1, row: 1, state: 3, stateData: [7, 9, 0, 2, 1] },
        // Building (state 9): mode=0, bldIndex=2 (Byte12/13), materialStep=4, counter=5.
        { index: 3, type: 3, owner: 0, col: 1, row: 1, state: 9, stateData: [0, 2, 0, 4, 5] },
        // DefendingHut (state 70): nextKnight = u16 @14 = 8.
        { index: 4, type: 24, owner: 1, col: 1, row: 1, state: 70, stateData: [0, 0, 0, 8, 0] },
        // KnightAttacking (state 48): move=1, attackerWon=1, fieldD=0, defIndex = u16 @14 = 6.
        { index: 5, type: 24, owner: 0, col: 1, row: 1, state: 48, stateData: [1, 1, 0, 6, 0] },
        // IdleOnPath (state 66): revDir=3, flag = u16(Byte12/13)=140 → /70 = 2, fieldE=1.
        { index: 6, type: 0, owner: 0, col: 1, row: 1, state: 66, stateData: [3, 140, 0, 1, 0] },
        // Mining (state 29): substate=2, res(Byte13)=4, deposit(Byte14)=1.
        { index: 7, type: 9, owner: 0, col: 1, row: 1, state: 29, stateData: [2, 0, 4, 1, 0] },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    const byIndex = new Map(state.serfRecords.map((s) => [s.index, serfStateFields(s)]));
    expect(byIndex.get(1)).toEqual({ category: 'walking', dir1: 0, dest: 5, dir: 3, waitCounter: 7 });
    expect(byIndex.get(2)).toEqual({
      category: 'transporting',
      res: 6,
      dest: 9,
      dir: 2,
      waitCounter: 1,
    });
    expect(byIndex.get(3)).toEqual({
      category: 'building',
      mode: 0,
      bldIndex: 2,
      materialStep: 4,
      counter: 5,
    });
    expect(byIndex.get(4)).toEqual({ category: 'defending', nextKnight: 8 });
    expect(byIndex.get(5)).toEqual({
      category: 'attacking',
      move: 1,
      attackerWon: 1,
      fieldD: 0,
      defIndex: 6,
    });
    expect(byIndex.get(6)).toEqual({ category: 'idleOnPath', revDir: 3, flag: 2, fieldE: 1 });
    expect(byIndex.get(7)).toEqual({ category: 'mining', substate: 2, res: 4, deposit: 1 });
  });

  it('serf with position word 0xFFFFFFFF -> col/row null (no tile)', () => {
    const fx: Fixture = {
      ...baseFixture,
      maxSerfIndex: 2,
      occupiedSerfs: [],
      serfs: [{ index: 0, type: 0, owner: 0, col: null, state: 0 }],
    };
    const state = parseSaveGame(buildSave(fx));
    expect(state.serfRecords[0].col).toBeNull();
    expect(state.serfRecords[0].row).toBeNull();
  });

  it('serf type name falls back to Unknown for type > 27', () => {
    const fx: Fixture = {
      ...baseFixture,
      maxSerfIndex: 2,
      occupiedSerfs: [],
      serfs: [{ index: 0, type: 30, owner: 0, col: 1, row: 1, state: 0 }],
    };
    const state = parseSaveGame(buildSave(fx));
    expect(state.serfRecords[0].typeName).toBe('Unknown(30)');
  });

  it('dekodiert Flag-Records (owner, Wege, Endpunkte, Waren-Slots)', () => {
    const fx: Fixture = {
      ...baseFixture,
      maxFlagIndex: 5,
      maxBuildingIndex: 3,
      flags: [
        {
          index: 1,
          owner: 1,
          hasBuilding: true,
          // Roads in direction 0 (-> flag 3) and 4 (UpLeft -> building 2).
          pathCon: (1 << 0) | (1 << 4),
          endpoints: [3 * FLAG, -1, -1, -1, 2 * BUILDING, -1],
          resourceSlots: [6, 9, -1, -1, -1, -1, -1, -1], // lumber, stone, then empty
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    expect(state.flagRecords).toHaveLength(1);
    const flag = state.flagRecords[0];
    expect(flag.index).toBe(1);
    expect(flag.owner).toBe(1);
    expect(flag.hasBuilding).toBe(true);
    expect(flag.paths).toEqual([true, false, false, false, true, false]);
    expect(flag.connections[0]).toEqual({ kind: 'flag', index: 3 });
    expect(flag.connections[4]).toEqual({ kind: 'building', index: 2 });
    expect(flag.connections[1]).toBeNull();
    expect(flag.resourceSlots).toEqual([6, 9, -1, -1, -1, -1, -1, -1]);
  });

  it('flag without a building: the UpLeft road points at a flag, not a building', () => {
    const fx: Fixture = {
      ...baseFixture,
      maxFlagIndex: 5,
      flags: [
        {
          index: 2,
          owner: 0,
          hasBuilding: false,
          pathCon: 1 << 4,
          endpoints: [-1, -1, -1, -1, 4 * FLAG, -1],
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    expect(state.flagRecords[0].connections[4]).toEqual({ kind: 'flag', index: 4 });
  });

  it('decodes the remaining flag fields (carriers, lengths, slot direction/target, other end, stock)', () => {
    const fx: Fixture = {
      ...baseFixture,
      maxFlagIndex: 5,
      maxBuildingIndex: 3,
      flags: [
        {
          index: 1,
          owner: 0,
          hasBuilding: true,
          hasResources: true,
          pathCon: (1 << 0) | (1 << 4),
          endpoints: [3 * FLAG, -1, -1, -1, 2 * BUILDING, -1],
          searchNum: 0x1234,
          searchDir: 2,
          // Carrier on direction 0; serf_request_fail (bit 7) set.
          transporterByte: (1 << 0) | (1 << 7),
          // length[0] = category 3, count 1 = 0x31; Rest 0.
          length: [0x31, 0, 0, 0, 0x11, 0],
          resourceSlots: [9, -1, -1, -1, -1, -1, -1, -1], // Stone in Slot 0
          slotDir: [2, -1, -1, -1, -1, -1, -1, -1],
          slotDest: [7, 0, 0, 0, 0, 0, 0, 0],
          // other_end_dir[0]: Bits 3-5 = Richtung 3 → 3<<3 = 0x18.
          otherEndDirByte: [0x18, 0, 0, 0, 0, 0],
          bldFlags: (1 << 6) | (1 << 7), // has_inventory + accepts_serfs
          bld2Flags: 1 << 7, // accepts_resources
          stockPriority: [5, 9],
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    const f = state.flagRecords[0];
    expect(f.hasResources).toBe(true);
    expect(f.searchNum).toBe(0x1234);
    expect(f.searchDir).toBe(2);
    expect(f.transporters).toEqual([true, false, false, false, false, false]);
    expect(f.serfRequestFail).toBe(true);
    expect(f.length[0]).toBe(0x31);
    expect(f.length[4]).toBe(0x11);
    expect(f.slotDir[0]).toBe(2);
    expect(f.slotDest[0]).toBe(7);
    expect(f.otherEndDir[0]).toBe(3);
    expect(f.acceptsSerfs).toBe(true);
    expect(f.acceptsResources).toBe(true);
    expect(f.stockPriority).toEqual([5, 9]);
  });

  it('decodes player records (index, building counters, serf census, scores)', () => {
    const completed = Array.from({ length: 23 }, (_, j) => (j === 0 ? 2 : j === 5 ? 1 : 0));
    const incomplete = Array.from({ length: 23 }, (_, j) => (j === 3 ? 1 : 0));
    const serfCount = Array.from({ length: 27 }, (_, j) => (j === 0 ? 42 : 0));
    const fx: Fixture = {
      ...baseFixture,
      activePlayers: [0, 1],
      players: [
        {
          slot: 1,
          index: 1,
          completedBuildingCount: completed,
          incompleteBuildingCount: incomplete,
          serfCount,
          totalBuildingScore: 158,
          totalMilitaryScore: 228,
          castleCaptureBalance: 7,
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    expect(state.playerRecords).toHaveLength(4);
    const p1 = state.playerRecords[1];
    expect(p1).toMatchObject({
      slot: 1,
      index: 1,
      active: true,
      totalBuildingScore: 158,
      totalMilitaryScore: 228,
      castleCaptureBalance: 7,
    });
    expect(p1.completedBuildingCount).toHaveLength(23);
    expect(p1.completedBuildingCount[0]).toBe(2); // array index 0 <-> building type 1 (fisher)
    expect(p1.completedBuildingCount[5]).toBe(1);
    expect(p1.incompleteBuildingCount[3]).toBe(1);
    expect(p1.serfCount[0]).toBe(42);
    // Player 0 is active (bit set) but has no fields -> defaults.
    expect(state.playerRecords[0].active).toBe(true);
    expect(state.playerRecords[2].active).toBe(false);
  });

  it('decodes the statistics history arrays (stat @2884 [16][112], resource @4676 [26][120])', () => {
    const fx: Fixture = {
      ...baseFixture,
      activePlayers: [0, 1],
      players: [
        {
          slot: 0,
          statCells: [
            [0, 5, 73], // mode 0, sample 5
            [15, 111, 42], // letzter Modus, letztes Sample
          ],
          resourceCells: [
            [6, 0, 9], // Lumber, sample 0
            [25, 119, 5], // letzte Ware (Shield), letztes Sample
          ],
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    const p0 = state.playerRecords[0];
    expect(p0.statHistory).toHaveLength(16);
    expect(p0.statHistory[0]).toHaveLength(112);
    expect(p0.statHistory[0][5]).toBe(73);
    expect(p0.statHistory[15][111]).toBe(42);
    expect(p0.resourceHistory).toHaveLength(26);
    expect(p0.resourceHistory[6]).toHaveLength(120);
    expect(p0.resourceHistory[6][0]).toBe(9);
    expect(p0.resourceHistory[25][119]).toBe(5);
    // Inactive players: empty history (saves JSON size).
    expect(state.playerRecords[2].active).toBe(false);
    expect(state.playerRecords[2].statHistory).toEqual([]);
    expect(state.playerRecords[2].resourceHistory).toEqual([]);
  });

  it('decodes the settings/priority fields (tool/flag/inventory priority, knight_occupation, castle links)', () => {
    // Flag/inventory priority as a permutation of 1..26 (as the original keeps it).
    const flagPrio = Array.from({ length: 26 }, (_, j) => ((j + 13) % 26) + 1);
    const invPrio = Array.from({ length: 26 }, (_, j) => 26 - j);
    const toolPrio = [9825, 65500, 13100, 6550, 13100, 26200, 32750, 45850, 6550];
    const resCount = Array.from({ length: 26 }, (_, j) => (j === 6 ? 2 : 0));
    const fx: Fixture = {
      ...baseFixture,
      activePlayers: [0, 1],
      players: [
        {
          slot: 0,
          toolPriority: toolPrio,
          resourceCount: resCount,
          flagPriority: flagPrio,
          inventoryPriority: invPrio,
          knightOccupation: [0x10, 0x21, 0x32, 0x43],
          castleBuilding: 1,
          castleFlag: 1,
          castleInventory: 0,
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    const p0 = state.playerRecords[0];
    expect(p0.toolPriority).toEqual(toolPrio);
    expect(p0.resourceCount[6]).toBe(2);
    expect(p0.flagPriority).toEqual(flagPrio);
    expect(p0.inventoryPriority).toEqual(invPrio);
    expect(p0.knightOccupation).toEqual([0x10, 0x21, 0x32, 0x43]);
    expect(p0.castleBuilding).toBe(1);
    expect(p0.castleFlag).toBe(1);
    expect(p0.castleInventory).toBe(0);
    // Invariants with 0 violations in the original: priorities are permutations of 1..26.
    expect([...p0.flagPriority].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 26 }, (_, j) => j + 1),
    );
    expect([...p0.inventoryPriority].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 26 }, (_, j) => j + 1),
    );
    // knight_occupation-Nibbles: min ≤ max ≤ 4.
    for (const b of p0.knightOccupation) {
      expect(b & 0xf).toBeLessThanOrEqual((b >> 4) & 0xf);
      expect((b >> 4) & 0xf).toBeLessThanOrEqual(4);
    }
  });

  it('decodes the remaining military/economy fields (build, reproduction, distribution, attacking_buildings)', () => {
    const fx: Fixture = {
      ...baseFixture,
      tick: 33016,
      activePlayers: [0, 1],
      players: [
        {
          slot: 0,
          build: 0x0e, // Bits 2|3 = Castle-Besitzer
          lastTick: 33016,
          reproductionCounter: 696,
          reproductionReset: 2000, // = (60-20)*50
          serfToKnightRate: 20000,
          serfToKnightCounter: 22208,
          attackingBuildingCount: 14,
          totalAttackingKnights: 4,
          attackingKnights: [0, 2, 0, 2], // Σ == totalAttackingKnights
          buildingAttacked: 49,
          attackingBuildings: [43, 20, 10, 30],
          currentSett5Item: 8,
          currentSett6Item: 15,
          cursorCol: 37,
          cursorRow: 12,
          contSearchAfterNonOptimalFind: 7,
          knightsToSpawn: 2,
          analysis: [0, 0, 0, 0],
          foodDistribution: [13100, 45850, 45850, 65500],
          planksDistribution: [65500, 3275, 19650],
          steelDistribution: [45850, 65500],
          coalDistribution: [32750, 65500, 52400],
          wheatDistribution: [65500, 32750],
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    const p0 = state.playerRecords[0];
    expect(p0.build).toBe(0x0e);
    expect(p0.build & 0x0c).toBe(0x0c); // Castle-Bits gesetzt
    expect(p0.lastTick).toBe(state.header.tick); // verifizierte Gleichheit
    expect(p0.reproductionCounter).toBeLessThan(p0.reproductionReset);
    expect(p0.reproductionReset % 50).toBe(0); // (60-reproduction)*50
    expect(p0.serfToKnightRate).toBe(20000);
    expect(p0.attackingBuildingCount).toBe(14);
    expect(p0.totalAttackingKnights).toBe(4);
    expect(p0.attackingKnights).toEqual([0, 2, 0, 2]);
    // Cross-check invariant (0 violations in the original): sum attacking_knights == total_attacking_knights.
    expect(p0.attackingKnights.reduce((a, b) => a + b, 0)).toBe(p0.totalAttackingKnights);
    expect(p0.currentSett5Item).toBe(8);
    expect(p0.currentSett6Item).toBe(15);
    // Bau-/Karten-Cursor (Block 380/382 == `player+0xfc`/`0xfe`). Pinnt beide Offsets gegeneinander:
    // one u16 off would read the row as the column. The cursor is stored state — the original knows
    // no "no tile selected".
    expect(p0.cursorCol).toBe(37);
    expect(p0.cursorRow).toBe(12);
    expect(p0.contSearchAfterNonOptimalFind).toBe(7);
    expect(p0.knightsToSpawn).toBe(2);
    expect(p0.buildingAttacked).toBe(49);
    expect(p0.attackingBuildings).toEqual([43, 20, 10, 30]); // non-zero entries only
    expect(p0.analysis).toEqual([0, 0, 0, 0]);
    expect(p0.foodDistribution).toEqual([13100, 45850, 45850, 65500]);
    expect(p0.planksDistribution).toEqual([65500, 3275, 19650]);
    expect(p0.steelDistribution).toEqual([45850, 65500]);
    expect(p0.coalDistribution).toEqual([32750, 65500, 52400]);
    expect(p0.wheatDistribution).toEqual([65500, 32750]);
  });

  it('decodes map tiles (row-interleaved): height, terrain, object/index, owner, roads, mineral', () => {
    const fx: Fixture = {
      ...baseFixture,
      mapSize: 3, // 64×64
      maxBuildingIndex: 5,
      mapTiles: [
        // Terrain tile with a mineral (no object).
        {
          col: 1,
          row: 0,
          height: 17,
          terrainUp: 5,
          terrainDown: 4,
          paths: 0b101010,
          mineral: 3, // Coal
          resourceAmount: 12,
        },
        // Building tile (object=2 SmallBuilding) -> objIndex instead of mineral, owner set.
        { col: 3, row: 2, height: 8, object: 2, owner: 2, objIndex: 4, serfIndex: 0 },
        // Flag tile at the end of a row (checks the index arithmetic across rows).
        { col: 63, row: 5, object: 1, owner: 1, objIndex: 9, paths: 0b000111 },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    const cols = state.header.mapCols;
    expect(state.mapTiles).toHaveLength(state.header.tileCount);

    const t1 = state.mapTiles[0 * cols + 1];
    expect(t1).toMatchObject({
      height: 17,
      terrainUp: 5,
      terrainDown: 4,
      paths: 0b101010,
      mineral: 3,
      resourceAmount: 12,
      object: 0,
      owner: 0,
      objIndex: 0,
    });

    const t2 = state.mapTiles[2 * cols + 3];
    expect(t2).toMatchObject({ height: 8, object: 2, owner: 2, objIndex: 4 });
    // For a building or flag no mineral is encoded.
    expect(t2.mineral).toBe(0);
    expect(t2.resourceAmount).toBe(0);

    const t3 = state.mapTiles[5 * cols + 63];
    expect(t3).toMatchObject({ object: 1, owner: 1, objIndex: 9, paths: 0b000111 });

    // Untouched tiles are cleanly zeroed.
    expect(state.mapTiles[10 * cols + 10]).toMatchObject({
      height: 0,
      object: 0,
      owner: 0,
      objIndex: 0,
      serfIndex: 0,
    });
  });

  it('dekodiert Inventory-Records (owner, flag, building, Ressourcen, Serf-Indizes)', () => {
    const resources = Array.from({ length: 26 }, (_, j) => (j === 9 ? 21 : j === 6 ? 3 : 0));
    const serfIndices = Array.from({ length: 27 }, (_, j) => (j === 0 ? 497 : j === 3 ? 15 : 0));
    const fx: Fixture = {
      ...baseFixture,
      maxInventoryIndex: 2,
      maxFlagIndex: 5,
      maxBuildingIndex: 3,
      inventories: [
        {
          index: 1,
          owner: 1,
          resDir: 0b1001, // serfMode=2 (Bits 2-3), resMode=1 (Bits 0-1)
          flag: 2,
          building: 2,
          genericCount: 215,
          resources,
          outQueue: [
            { type: 9, dest: 3 }, // Stone → Flagge 3
            { type: -1, dest: 0 }, // leer
          ],
          serfIndices,
        },
      ],
    };
    const state = parseSaveGame(buildSave(fx));
    expect(state.inventoryRecords).toHaveLength(1);
    const inv = state.inventoryRecords[0];
    expect(inv).toMatchObject({ index: 1, owner: 1, flag: 2, building: 2, genericCount: 215 });
    expect(inv.resMode).toBe(1);
    expect(inv.serfMode).toBe(2);
    expect(inv.resources).toHaveLength(26);
    expect(inv.resources[9]).toBe(21); // Stone
    expect(inv.resources[6]).toBe(3); // Lumber
    expect(inv.outQueue).toHaveLength(2);
    expect(inv.outQueue[0]).toEqual({ type: 9, dest: 3 });
    expect(inv.outQueue[1].type).toBe(-1); // leerer Slot
    expect(inv.serfIndices).toHaveLength(27);
    expect(inv.serfIndices[0]).toBe(497); // gelagerter Transporter, Serf-Index 497
    expect(inv.serfIndices[3]).toBe(15);
  });

  it('byteLength == the size reconstructed from the layout (integrity self-check)', () => {
    const buf = buildSave(baseFixture);
    const state = parseSaveGame(buf);
    // The parser consumes exactly up to the end of the file — otherwise it would have thrown.
    expect(state.byteLength).toBe(buf.byteLength);
  });

  it('throws on an implausible map size', () => {
    const buf = buildSave(baseFixture);
    new DataView(buf.buffer).setUint16(190, 2, true); // < 3
    expect(() => parseSaveGame(buf)).toThrow(/map size/);
  });

  it('wirft bei zu kleiner Datei', () => {
    expect(() => parseSaveGame(new Uint8Array(100))).toThrow(/too small/);
  });

  it('throws when the entity blocks reach beyond the end of the file', () => {
    const buf = buildSave(baseFixture);
    // Raise maxSerfIndex artificially -> the records no longer fit into the file.
    new DataView(buf.buffer).setUint16(94, 9999, true);
    expect(() => parseSaveGame(buf)).toThrow(/past the end of the file|file/);
  });

  it('the result is JSON-serialisable (no closures in the state)', () => {
    const state = parseSaveGame(buildSave(baseFixture));
    expect(() => JSON.stringify(state)).not.toThrow();
    const round = JSON.parse(JSON.stringify(state));
    expect(round.header.maxSerfIndex).toBe(3);
  });
});
