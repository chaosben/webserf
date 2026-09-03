/**
 * Founding the castle at the start of a game — port of the original's founding chain.
 *
 * The chain: new-game init `FUN_00004df5` -> `FUN_00005000` -> per player `FUN_00005309` (start
 * position -> `player+0xfc/+0xfe`) -> **`FUN_00028dde`** (the founding core). The core:
 * 1. Allocates inventory (`FUN_000453d7`), castle building (`FUN_0004514a`), flag (`FUN_00044e68`).
 * 2. Fills the inventory from the **interpolated starting resource table**
 *    ({@link STARTING_RESOURCES}, five difficulty steps chosen by `player+0x162`), then immediately
 *    takes **-7 planks / -2 stone** back out.
 * 3. Places castle (object = Castle) and flag (DownRight neighbour) on the map and links everything.
 * 4. `FUN_00045a30` = {@link recomputeTerritory} (influence recolour around the castle).
 * 5. **`FUN_000295e6`** = a fixed **20-serf roster** (unrolled `spawn_serf` sequence): every
 *    specialised serf consumes its tool or weapons from the inventory stock.
 *
 * Verified against a real before/after pair of saves: a freshly founded castle reproduces **all 26
 * inventory resources exactly** (T3 minus the building reserve minus tool and weapon consumption —
 * no simulation drift, because the serfs stand idle in the stock), the **serf type multiset exactly**
 * (20 serfs, `serfBudget` -20) and the **territory byte for byte** (217 tiles).
 */
import { Direction, neighbor, posOf } from './position.js';
import { LEVEL_WALK } from './building-construction.js';
import { u16 } from './int.js';
import { recomputeTerritory, updateThreatLevel } from './territory.js';
import type { GameState, Building, Flag, Inventory, Serf, Player } from './state.js';
import { allocBuilding, allocFlag, allocInventory, lowestFreeSlot, growMax } from './alloc.js';
import { SERF_TYPE_NAMES } from '../save-parser.js';
import { setFlagAcceptByte } from './flag-accept.js';

const CASTLE = 24;
const STATE_IDLE_IN_STOCK = 1;
const STATE_BUILDING_CASTLE = 10;
const SERF_GENERIC = 21;
const RES_PLANK = 7;
const RES_STONE = 9;

/**
 * Starting resource tables `DAT_00029564`/`2957e`/`29598`/`295b2`/`295cc` (26 bytes each, resource
 * type 0..25). Five difficulty support points; `FUN_00028dde` **interpolates** linearly between the
 * two neighbouring ones using `player+0x162` ({@link foundCastle} `difficulty`): `<10 ->
 * interp(T0,T1)`, `[10,20) -> interp(T1,T2)`, `[20,30) -> interp(T2,T3)`, `[30,40) ->
 * interp(T3,T4)`, `>=40 -> T4`. The fraction is `(difficulty mod 10) * 0x199a / 0x10000`
 * (0x199a = 6554, about 65536/10).
 */
export const STARTING_RESOURCES: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 7, 0, 2, 0, 0, 0, 0, 0, 1, 6, 1, 0, 0, 1, 2, 3, 0, 10, 10],
  [2, 1, 1, 3, 2, 1, 0, 25, 1, 8, 4, 3, 8, 2, 1, 3, 12, 2, 1, 1, 2, 3, 4, 1, 30, 30],
  [3, 2, 2, 10, 3, 1, 0, 40, 2, 20, 12, 8, 20, 4, 2, 5, 20, 3, 1, 2, 3, 4, 6, 2, 60, 60],
  [8, 4, 6, 20, 7, 5, 3, 80, 5, 40, 20, 40, 50, 8, 4, 10, 30, 5, 2, 4, 6, 6, 12, 4, 100, 100],
  [30, 10, 30, 50, 10, 30, 10, 200, 10, 100, 30, 150, 100, 10, 5, 20, 50, 10, 5, 10, 20, 20, 50, 10, 200, 200],
] as const;

/**
 * The fixed founding roster (`FUN_000295e6`, unrolled `spawn_serf` sequence) in creation order.
 * `type` comes from the `*serf = (*serf & 0x83) | typeBits` immediates (`type = (typeBits>>2)&0x1f`).
 * `tools` are the inventory resources the specialisation consumes (`inv+0xNN -= 1`,
 * `resIdx = (0xNN-6)/2`): knight -> sword(24) + shield(25); every profession its tool
 * (digger -> shovel(15), builder/toolmaker/geologist -> hammer(16), fisher -> rod(17),
 * lumberjack -> axe(20), sawmiller/toolmaker -> saw(21), stonecutter/miner -> pick(22)). Generic and
 * the castle builder consume nothing.
 */
interface RosterEntry {
  type: number;
  state: number;
  tools: readonly number[];
  count: number;
}
export const FOUNDING_ROSTER: readonly RosterEntry[] = [
  { type: 4, state: STATE_BUILDING_CASTLE, tools: [], count: 1 }, // TransporterInventory (Schloss-Bauer/Holder)
  { type: SERF_GENERIC, state: STATE_IDLE_IN_STOCK, tools: [], count: 5 }, // Generic ×5 (bleiben im Generic-Pool)
  { type: 22, state: STATE_IDLE_IN_STOCK, tools: [24, 25], count: 3 }, // Knight0 ×3 (Sword+Shield)
  { type: 18, state: STATE_IDLE_IN_STOCK, tools: [16, 21], count: 1 }, // Toolmaker (Hammer+Saw)
  { type: 5, state: STATE_IDLE_IN_STOCK, tools: [20], count: 1 }, // Lumberjack (Axe)
  { type: 6, state: STATE_IDLE_IN_STOCK, tools: [21], count: 1 }, // Sawmiller (Saw)
  { type: 7, state: STATE_IDLE_IN_STOCK, tools: [22], count: 1 }, // Stonecutter (Pick)
  { type: 2, state: STATE_IDLE_IN_STOCK, tools: [15], count: 1 }, // Digger (Shovel)
  { type: 3, state: STATE_IDLE_IN_STOCK, tools: [16], count: 1 }, // Builder (Hammer)
  { type: 11, state: STATE_IDLE_IN_STOCK, tools: [17], count: 1 }, // Fisher (Rod)
  { type: 20, state: STATE_IDLE_IN_STOCK, tools: [16], count: 2 }, // Geologist ×2 (Hammer)
  { type: 9, state: STATE_IDLE_IN_STOCK, tools: [22], count: 2 }, // Miner ×2 (Pick)
] as const;

/** Linearly interpolated starting resources for a difficulty of 0..40+ (`FUN_00028dde`). */
export function startingResources(difficulty: number): number[] {
  const d = Math.max(0, difficulty);
  if (d >= 40) return [...STARTING_RESOURCES[4]]; // original: lo == hi == T4, no interpolation
  const seg = Math.floor(d / 10); // 0..3
  const lo = STARTING_RESOURCES[seg];
  const hi = STARTING_RESOURCES[seg + 1];
  const fracUnits = d - seg * 10; // 0..9
  const frac16 = fracUnits * 0x199a; // 16-bit fraction (0x199a is about 65536/10)
  const out: number[] = [];
  for (let i = 0; i < 26; i++) {
    const prod = (hi[i] - lo[i]) * frac16; // signed
    const round = (prod & 0xffff) >= 0x8000 ? 1 : 0; // original: `if low16 >= 0x8000 -> +1`
    out[i] = lo[i] + (prod >> 16) + round;
  }
  return out;
}

/**
 * Allocate a serf at the castle (`create_serf`) and set it up as a roster serf in the stock.
 *
 * The inventory index sits in a **different** union slot depending on the state, and both are backed
 * by the binary: `IdleInStock` reads it from `serf[0xe]` (`serf_state_01` @0x1f59e), the **castle
 * builder** from `serf[0xc]` (`serf_state_10` @0x2582d; written by `create_founding_serfs` @0x295e6
 * with `mov %ax,0xc(%ebx)` from `player+0x108` == `castleInventory`). A shared slot would not merely
 * be untidy but plainly the wrong value for the castle build.
 */
function createRosterSerf(state: GameState, player: Player, type: number, serfState: number, col: number, row: number, invIndex: number): Serf {
  const idx = lowestFreeSlot(state.serfs);
  const castleBuilder = serfState === STATE_BUILDING_CASTLE;
  const lo = invIndex & 0xff;
  const hi = (invIndex >> 8) & 0xff;
  const serf: Serf = {
    index: idx,
    owner: player.slot,
    type,
    typeName: SERF_TYPE_NAMES[type] ?? String(type),
    sound: false,
    animation: 0,
    counter: 0,
    col,
    row,
    tick: state.gameTick,
    state: serfState,
    stateData: castleBuilder ? [0, lo, hi, 0, 0] : [0, 0, 0, lo, hi],
  };
  state.serfs[idx] = serf;
  growMax(state.serfs, idx, state.blockMeta.serfs, (v) => (state.header.maxSerfIndex = v));
  state.serfBudget = u16(state.serfBudget - 1);
  return serf;
}

/**
 * Found a castle for `player` at `(col,row)` (`FUN_00028dde` + `FUN_000295e6`). `difficulty`
 * (`player+0x162`, default 30) selects and interpolates the starting resource table.
 * `levelingHeight` is `player+0x102`, the levelling height the caller has just determined with
 * `classifyBuildSite`; in the original a `call 0x32075` precedes **every** of the three inflows
 * (player action @0x28d1e, game start @0x53dc, AI @0x5c491).
 */
export function foundCastle(
  state: GameState,
  player: Player,
  col: number,
  row: number,
  levelingHeight: number,
  difficulty = 30,
): { building: Building; flag: Flag; inventory: Inventory } {
  const geo = state.geo;
  const castlePos = posOf(col, row, geo);
  const flagPos = neighbor(castlePos, Direction.DownRight, geo); // the building hangs UpLeft of the flag

 // 1) Records allokieren + verlinken.
  const inventory = allocInventory(state);
  const building = allocBuilding(state);
  const flag = allocFlag(state);

  inventory.owner = player.slot;
  inventory.flag = flag.index;
  inventory.building = building.index;

  building.type = CASTLE;
  building.typeName = 'Castle';
  building.owner = player.slot;
  building.col = col;
  building.row = row;
  building.flag = flag.index;
  building.constructing = true; // under construction (builder in state BuildingCastle)
  building.active = true; // building+5 |= 0x10
  building.holder = true; // building+5 |= 0x40
  building.hasInventory = true;
 // `bld[8] = 0xffff` @0x2926a (right before `player[0x104] = bldIndex` @0x29275) — the **inventory
 // marker**, set at founding time, i.e. already during construction. That is why a castle under
 // construction carries it while a warehouse under construction does not: the warehouse only gets it
 // on activation (@0x15310).
  building.stock[0] = { available: 0xf, requested: 0xf };
  building.stock[1] = { available: 0xf, requested: 0xf };
  building.inventoryIndex = inventory.index;

  flag.owner = player.slot; // flag+3 = owner<<6
  flag.hasBuilding = true;
  flag.connections[Direction.UpLeft] = { kind: 'building', index: building.index };
  setFlagAcceptByte(flag, 0x42, 0xc0); // bit 7 accept + bit 6 "has inventory"
  setFlagAcceptByte(flag, 0x44, 0x80); // bit 7 accept

 // 2) Starting resources (interpolated table) plus the building reserve (`inv+0x14 -= 7`,
 // `inv+0x18 -= 2`). The deducted amount is parked in `player+0x164/0x165` until the first hint
 // messages have run (`FUN_000111b2` gives it back); the castle popup adds it in again when
 // displaying. Verified: after founding those two hold exactly 7 and 2.
  inventory.resources = startingResources(difficulty);
  inventory.resources[RES_PLANK] -= 7;
  inventory.resources[RES_STONE] -= 2;
  player.heldPlanks = 7;
  player.heldStone = 2;

 // ... and **this is what switches the hint chain on**: the six `btr` @0x2912b..@0x2919e clear
 // `messageFlags` bits 0..5, then the three message slots (@0x291b0/@0x291bd/@0x291ca) and the
 // return countdown (@0x291d7) are zeroed. Bits 6/7 are **not** touched.
 //
 // Leaving this block out costs real material: `init_players` sets bit 0 ("hints done", @0x684d),
 // and with bit 0 set `updatePlayerHints` returns immediately (@0x11211 -> `ret`, **not** to the
 // return tail). The player would never get the 7 planks and 2 stones back, and none of the five
 // opening messages would appear. Real before/after saves of one game show it: before founding
 // `messageFlags` is 0x01 with no reserve, after it is **0x00 with 7/2**.
  player.messageFlags &= ~0x3f;
  player.messageBuildingSlots[0] = 0;
  player.messageBuildingSlots[1] = 0;
  player.messageBuildingSlots[2] = 0;
  player.hintReturnDelay = 0;

 // 3) Place castle and flag on the map — and LEVEL the site.
 //
 // The original does both in one walk (@0x29354..@0x294fb): set the centre, write the height, set the
 // path bit, then six steps, writing the height at each. There is **no leveller** for the castle (the
 // build handler is a bare `ret` for type 24, and state 10 `BuildingCastle` does not touch the map) —
 // the seven tiles are flat from the moment of founding.
 //
 // `andb $0xe0,0x1(%ebx)` + `or %al,0x1(%ebx)` are the **only seven** places in the whole game
 // segment that overwrite the height bits masked; everything else changes heights by +-1 (levellers).
 // Without them the castle's flag sits up to two height steps (8 px) away from the castle.
  const level = levelingHeight & 0x1f; // @0x29365 reads `player+0x102` as a word but writes `al`
  const cTile = state.mapTiles[castlePos];
  cTile.object = 4; // Castle — @0x29354 `andb $0x80` (water bit kept) + @0x2935e `orb $0x4`
  cTile.objIndex = building.index;
  cTile.paths |= 0x02; // @0x2938e `bts $0x1` — path DownRight to the flag
  cTile.blocked = true; // @0x293a2 `bts $0x6`
  const fTile = state.mapTiles[flagPos];
  fTile.object = 1; // Flag — @0x29400 `andb $0x80` + @0x2940a `orb $0x1`
  fTile.objIndex = flag.index;
  fTile.paths |= 0x10; // @0x2942a `bts $0x4` — path UpLeft to the building
  let levelPos = castlePos;
  state.mapTiles[levelPos].height = level;
  for (const dir of LEVEL_WALK) {
    levelPos = neighbor(levelPos, dir, geo);
    state.mapTiles[levelPos].height = level;
  }

 // 4) Territory influence around the castle (`FUN_00045a30`).
  recomputeTerritory(state, col, row);

 // 5) The fixed 20-serf roster (`FUN_000295e6`): every specialised serf consumes its tool/weapons.
  let firstSerfIndex = 0;
  for (const entry of FOUNDING_ROSTER) {
    for (let n = 0; n < entry.count; n++) {
      const serf = createRosterSerf(state, player, entry.type, entry.state, col, row, inventory.index);
      if (firstSerfIndex === 0) firstSerfIndex = serf.index;
      if (entry.type === SERF_GENERIC) {
        inventory.genericCount += 1; // generics stay in the stock pool (inv+0x40)
        player.serfCount[SERF_GENERIC] = (player.serfCount[SERF_GENERIC] ?? 0) + 1;
      } else {
        player.serfCount[entry.type] = (player.serfCount[entry.type] ?? 0) + 1;
      }
      for (const res of entry.tools) inventory.resources[res] -= 1; // tool/weapon out of the stock
    }
  }
  building.firstKnight = firstSerfIndex; // building+10 = first roster serf (the castle builder)
 // Only the castle builder is visibly on the map (`mov %ax,0x2(%ebx)` @0x29644 onto its own
 // position); the other 19 roster serfs sit in the stock. Without this registration the castle tile
 // points at no serf, and the state-10 completion that releases it again would run into nothing.
 // Real saves confirm it: the castle tile carries the builder's index.
  state.mapTiles[castlePos].serfIndex = firstSerfIndex;
 // ...and is noted on the player as well (`player+0x16e` @0x29661). Its only reader is the castle
 // branch of the demolition, which ejects him when the castle is lost.
  player.castleBuilderSerf = firstSerfIndex;

 // 6) Player flags and links (`FUN_00028dde`): initial serfs created, has a castle.
  player.build |= 4 | 8; // bit 2 = initial serfs created, bit 3 = has a castle
 // `player+2` (`flags`) bit 0 = **castle founded** (@0x28e37 `bts $0x0`), immediately followed by
 // `player+3` bit 3 ("has castle" in the `build` byte). Among other things this bit switches the
 // geologist icon of the control panel off: the soil display serves the choice of location **before**
 // the castle is built.
  player.flags |= 1;
  player.castleBuilding = building.index;
  player.castleFlag = flag.index;
  player.castleInventory = inventory.index;

 // 7) Threat level of the castle (`update_threat_level` @0x46abd, called @0x2955e right after the
 // recolour). The second and last direct call in the binary — the other sits at build completion.
  updateThreatLevel(state, building);

  return { building, flag, inventory };
}
