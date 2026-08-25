/**
 * Serf state machine — dispatch plus handlers, ported bit-exact from the DOS original.
 *
 * Original: the driver `FUN_0001599e` iterates the serfs and calls `FUN_00016246` per serf, which
 * jumps through `serf->state` (byte +10) into a 76-slot jump table (`LAB_00016266`, stride 8). Every
 * active handler starts with the same **tick prologue**:
 *
 * ```
 * delta = gameTick - serf.tick; serf.tick = gameTick;
 * old = serf.counter; serf.counter -= delta;
 * if (delta <= old) return; // not elapsed yet
 * // otherwise the counter underflowed => run the state body (animation reset / transition)
 * ```
 *
 * The **union bytes** (`serf.stateData[0..4]` == record bytes 11..15 == field offsets `0xb..0xf`) are
 * read as u8 or u16 depending on `state` — exactly as the binary addresses the C `union`.
 *
 * **Size of the table:** the DOS jump table has exactly **76 entries (0..75)**; the last (`@0x164be`)
 * belongs to 75 DefendingCastle, behind it are zero bytes. The original therefore knows no state
 * **76**; the name `KnightAttackingDefeatFree` in `SERF_STATE_NAMES` comes from clone nomenclature and
 * has no counterpart here. Every entry of the table is ported.
 */
import { addU16, subU16, i8, i16 } from './int.js';
import type { GameState, Serf, Building, Inventory } from './state.js';
import { setSerfType } from './state.js';
import { posOf, colOf, rowOf, neighbor, oppositeDir, Direction } from './position.js';
import { SPIRAL_PATTERN, spiralPos } from './spiral.js';
import { COUNTER_FROM_ANIMATION, ROAD_BUILDING_SLOPE, slopeIndex } from './serf-tables.js';
import { BUILD_PROGRESS_STEP, BUILD_MATERIAL_NEED, BUILDING_SCORE, buildingStockByte } from './building-tables.js';
import {
  directionStep,
  moveStep,
  transporterOnRoadStep,
  singleBitDir,
  arrivalCleanup,
  tileHasFlag,
  transporterMoveToFlag,
  flagSearchDir,
  findNearestInventory,
  walkingWaiting,
} from './serf-movement.js';
import { freeSailingBody, freeWalkingBody, stoneCutterFreeWalkingBody } from './serf-free-walking.js';
import { lookingForGeoSpot, samplingGeoSpot } from './serf-geologist.js';
import {
  defendingHut,
  defendingTower,
  defendingFortress,
  defendingCastle,
  knightPrepareAttacking,
  knightPrepareDefending,
  knightAttacking,
  knightDefending,
  knightAttackingVictory,
  knightAttackingDefeat,
  knightEngagingBuilding,
  knightOccupyEnemyBuilding,
  knightAttackingVictoryFree,
  knightDefendingVictoryFree,
  knightAttackingFreeWait,
  knightFreeWalking,
  knightEngageDefendingFree,
  knightEngageAttackingFree,
  knightEngageAttackingFreeJoin,
  knightPrepareAttackingFree,
  knightPrepareDefendingFree,
  knightPrepareDefendingFreeWait,
  knightLeaveForWalkToFight,
  knightLeaveForFight,
  promote,
} from './serf-military.js';
import {
  notifyTerritoryLosers,
  recomputeTerritory,
  snapshotTerritoryScores,
  updateThreatLevel,
} from './territory.js';
import { addPlayerMessage } from './player-messages.js';

/**
 * "Military building occupied" (`addw $0x6` @0x23f48); the upper 3 bits carry the building class
 * 0/1/2 = hut/tower/fortress (`cmpw $0x2c` / `cmpw $0x54` @0x23f1f/@0x23f25).
 */
const MSG_BUILDING_OCCUPIED = 6;
import {
  sawing,
  butchering,
  baking,
  milling,
  smelting,
  makingWeapon,
  makingTool,
  pigFarming,
  buildingBoat,
  mining,
} from './serf-production.js';
import {
  logging,
  planningLogging,
  planningPlanting,
  planting,
  planningStoneCutting,
  stoneCutting,
  planningFishing,
  fishing,
  planningFarming,
  farming,
} from './serf-field-work.js';
import { clearFlagAcceptBytes, setFlagAcceptByte } from './flag-accept.js';

// ---- Union byte access (field offset 0xb..0xf -> stateData[0..4]) ----

/** Read a u8 from a union byte (field offset 0xb..0xf). */
export function unionU8(serf: Serf, off: number): number {
  return serf.stateData[off - 0xb];
}
/** Write a u8 into a union byte. */
export function setUnionU8(serf: Serf, off: number, value: number): void {
  serf.stateData[off - 0xb] = value & 0xff;
}
/** Read a little-endian u16 from two union bytes at a field offset. */
export function unionU16(serf: Serf, off: number): number {
  const i = off - 0xb;
  return serf.stateData[i] | (serf.stateData[i + 1] << 8);
}
/** Write a little-endian u16 into two union bytes at a field offset. */
export function setUnionU16(serf: Serf, off: number, value: number): void {
  const i = off - 0xb;
  serf.stateData[i] = value & 0xff;
  serf.stateData[i + 1] = (value >> 8) & 0xff;
}

/**
 * The shared tick prologue. Pulls `serf.counter` down by the delta elapsed since `serf.tick` and
 * carries `serf.tick` along. Returns `true` when the counter **underflowed** (time is up, the handler
 * should run its body), `false` while it still has to wait.
 */
export function advance(serf: Serf, gameTick: number): boolean {
  const delta = subU16(gameTick, serf.tick);
  serf.tick = gameTick;
  const old = serf.counter;
  serf.counter = subU16(old, delta);
  return delta > old; // unsigned underflow == elapsed
}

/** Leaving animation "wait" (blocked: the target tile is occupied). */
const ANIM_WAIT_OUT = 0x52;

/**
 * `@0x24870` — the **shared "blocked" exit** of leaving: wait animation `0x52`, counter 0. The state
 * stays put and the next tick tries to leave again. In the original this is a jump label several
 * leaving routines jump into (07, 11, 15, 65), hence a primitive here rather than a copy per handler.
 */
export function blockedWaitOut(serf: Serf): void {
  serf.animation = ANIM_WAIT_OUT;
  serf.counter = 0;
}

/**
 * `@0x2473b` — the **shared leaving block**: moves the serf from the building tile to the flag tile
 * (`here` -> `flagTile`), leaving animation `anim = dHeight + 0xd`, counter
 * `= (counter_from_animation[anim] * (0x1f ^ slope[bldType])) >> 5`, state -> 5 (LeavingBuilding).
 *
 * A jump target of its own in the original: `serf_state_07 @0x246e9` falls into it,
 * `serf_state_65 @0x24528` **jumps** into it (`je 0x2473b`). Both callers check the preconditions
 * themselves — the block assumes `flagTile` is free.
 *
 * It does **not** set the follow-up state (`serf[0xf]`); the caller brings that along (for state 65 the
 * attack dispatch has already set it to 53).
 */
export function stepOutToFlagMove(
  state: GameState,
  serf: Serf,
  here: number,
  flagTile: number,
): void {
  state.mapTiles[here].serfIndex = 0;
  state.mapTiles[flagTile].serfIndex = serf.index;
  beginExitAnimation(state, serf, here, flagTile);
}

/**
 * The **arithmetic tail** of leaving that every leaving variant shares: take over the position, set the
 * leaving animation `anim = dHeight + 0xd`, the counter
 * `= (counter_from_animation[anim] * (0x1f ^ slope[bldType])) >> 5`, `tick`, state -> 5.
 *
 * Separate from {@link stepOutToFlagMove} because **state 46** (`KnightLeaveForFight`, `@0x18606`)
 * needs exactly this part but does **not** register the serf on the target tile: the attacker already
 * stands there, and both are meant to stand on the same tile for the fight.
 */
export function beginExitAnimation(
  state: GameState,
  serf: Serf,
  here: number,
  dest: number,
): void {
  const geo = state.geo;
  serf.col = colOf(dest, geo);
  serf.row = rowOf(dest, geo);
  const anim = state.mapTiles[dest].height - state.mapTiles[here].height + 0xd;
  serf.animation = anim & 0xff;
  const base = COUNTER_FROM_ANIMATION[anim] ?? 0;
  const bld = state.buildings[state.mapTiles[here].objIndex];
  const slope = ROAD_BUILDING_SLOPE[slopeIndex(bld?.type ?? 0, bld?.constructing ?? false)];
  serf.counter = ((base * (0x1f ^ slope)) >> 5) & 0xffff;
  serf.tick = state.gameTick;
  serf.state = 5; // LeavingBuilding
}

/**
 * `stepOutToFlag` — one step from the building to its flag (direction **DownRight**), a shared
 * primitive of several handlers (07/11/15/...). From `serf_state_07 @0x246e9`: own or empty slot at the
 * location **and** a free flag tile -> {@link stepOutToFlagMove}, otherwise {@link blockedWaitOut}.
 */
export function stepOutToFlag(state: GameState, serf: Serf): void {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const here = posOf(serf.col, serf.row, geo);
  const slot = state.mapTiles[here].serfIndex;
  if (slot === serf.index || slot === 0) {
    const flagTile = neighbor(here, Direction.DownRight, geo);
    if (state.mapTiles[flagTile].serfIndex === 0) {
      stepOutToFlagMove(state, serf, here, flagTile);
      return;
    }
  }
  blockedWaitOut(serf);
}

/** Wait animation "before entering" (blocked: the building tile is occupied). */
const ANIM_WAIT_IN = 0x55;

/**
 * `stepInToBuilding` — counterpart to `stepOutToFlag`: one step from the flag into the building
 * (direction **UpLeft**), a shared primitive (06/13/...). From `serf_state_06 @0x22e7d`:
 * - building tile free -> move the serf, anim `= dHeight + 0x28`, `counter = counter_from_animation[anim]`
 * (the walking duration, as when leaving), plus the interior path length
 * `field_0xc = (counter_from_animation[anim] * slope[bld]) >> 5` (**raw** slope, no `0x1f^`),
 * state -> 4 (EnteringBuilding).
 * - blocked -> wait animation `0x55`, counter 0.
 */
export function stepInToBuilding(state: GameState, serf: Serf): void {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const here = posOf(serf.col, serf.row, geo);
  const bldTile = neighbor(here, Direction.UpLeft, geo);
  if (state.mapTiles[bldTile].serfIndex === 0) {
    state.mapTiles[here].serfIndex = 0;
    beginEnterAnimation(state, serf, here, bldTile);
    return;
  }
  serf.animation = ANIM_WAIT_IN;
  serf.counter = 0;
}

/**
 * The **arithmetic tail of entering**: occupy the target tile, take over the position, anim
 * `= dHeight + 0x28`, `counter = counter_from_animation[anim]` (the walking duration), the interior
 * path length `field_0xc = (counter_from_animation[anim] * slope[bldType]) >> 5` (**raw** slope, no
 * `0x1f ^`), `tick`, state -> 4.
 *
 * Unlike leaving (`@0x2473b`) the original does **not** share this block as a jump target — it stands
 * twice in the binary: in `serf_state_06 @0x22e7d` and inline in the fight resolution
 * `serf_state_48 @0x18802` (there for the victorious defender walking back into the building). Since it
 * is **pure arithmetic with no behavioural difference**, the port shares it; the real differences stay
 * at the call sites:
 * - state 06 checks whether the building tile is free and **clears the source tile**.
 * - the fight resolution checks **nothing** and clears **nothing** (the dead attacker lies on the source
 * tile) and additionally sets `serf[0xb] = 0xff` — state 06 does not.
 */
export function beginEnterAnimation(
  state: GameState,
  serf: Serf,
  here: number,
  bldTile: number,
): void {
  const geo = state.geo;
  state.mapTiles[bldTile].serfIndex = serf.index;
  serf.col = colOf(bldTile, geo);
  serf.row = rowOf(bldTile, geo);
  const anim = state.mapTiles[bldTile].height - state.mapTiles[here].height + 0x28;
  serf.animation = anim & 0xff;
  const base = COUNTER_FROM_ANIMATION[anim] ?? 0;
  serf.counter = base & 0xffff; // walking duration (`serf_state_06` @0x22e7d: `counter = base`)
  const bld = state.buildings[state.mapTiles[bldTile].objIndex];
  const slope = ROAD_BUILDING_SLOPE[slopeIndex(bld?.type ?? 0, bld?.constructing ?? false)];
  setUnionU16(serf, 0xc, ((base * slope) >> 5) & 0xffff); // interior path length (field_0xc)
  serf.tick = state.gameTick;
  serf.state = 4; // EnteringBuilding
}

// ---- Delivering a resource into the building (shared by 03 Transporting and 14 Delivering) ----

/** `counter_from_animation[anim]` as u16, index-guarded. */
function cfa(anim: number): number {
  return (anim >= 0 && anim < COUNTER_FROM_ANIMATION.length ? COUNTER_FROM_ANIMATION[anim] : 0) & 0xffff;
}

/**
 * Add an animation budget onto the counter (already reduced by the tick delta). Returns `true` when the
 * u16 addition overflows — the original ends the tick then (`if (CARRY2(...)) return`).
 */
export function addCounter(serf: Serf, add: number): boolean {
  const sum = serf.counter + (add & 0xffff);
  serf.counter = sum & 0xffff;
  return sum > 0xffff;
}

/**
 * The raw stock byte (`bld+8`/`bld+9`) of a building slot. Read from the byte itself, because the
 * original compares `cmpb $0xff` against it — a derived test such as "has an inventory" answers a
 * different question and diverges whenever the marker is not exactly `0xff` (a castle with byte `0xfe`
 * occurs).
 */
function rawStock(bld: Building, k: number): number {
  return buildingStockByte(bld, k);
}
function writeStock(bld: Building, k: number, raw: number): void {
  bld.stock[k] = { available: (raw >> 4) & 0xf, requested: raw & 0xf };
}

/**
 * One pass of the delivery loop (`serf_state_14` @0x22b9d, also inline in 03): book the carried
 * resource at the target building (UpLeft of the flag tile), then set the return animation, toggle
 * `field_0xf` and charge **half** the animation budget.
 * - `res != 0` -> `field_0xb = 0` (the resource leaves the carrier even if the building is burning); if
 * the building is not burning, pick the matching stock slot (`res==7 || (res>=9 && res!=13)` -> `bld+9`,
 * else `bld+8`; `res` is the raw resource value = type+1) and book `+0x0f` (net: available+1,
 * requested-1). **The carry is the branch**: only on the marker `0xff` does `+0x0f` overflow
 * (@0x22c74/@0x22c84 `addb $0xf` + `jae`), and the carry branch @0x22c8a books into the inventory
 * counter `resources[type]` (clamp 50000) and **restores the marker** (@0x22c91). The port tests
 * `> 0xf0` instead of the carry — equivalent, because `0xf1..0xff` only occur as markers (the nibble
 * arithmetic cannot reach them: `requested` grows in steps of 1, `available` in steps of 0x10).
 * - return anim `0xd - (animation - 0x5d)`, `field_0xf = ~field_0xf`, `counter += cfa[anim] >> 1`.
 *
 * Returns `true` when the counter overflowed (tick done).
 */
function deliverStep(state: GameState, serf: Serf): boolean {
  if (serf.col !== null && serf.row !== null) {
    const pos = posOf(serf.col, serf.row, state.geo);
    const bpos = neighbor(pos, Direction.UpLeft, state.geo);
    const bld = state.buildings[state.mapTiles[bpos].objIndex];
    const res = unionU8(serf, 0xb);
    if (res !== 0) {
      setUnionU8(serf, 0xb, 0);
      if (bld && !bld.burning) {
        const k = res === 7 || (res >= 9 && res !== 13) ? 1 : 0;
        const old = rawStock(bld, k);
        if (old > 0xf0) {
          if (bld.inventoryIndex !== null) {
            const inv = state.inventories[bld.inventoryIndex];
            if (inv) {
              const type = res - 1;
              inv.resources[type] = Math.min(50000, inv.resources[type] + 1);
            }
          }
        } else {
          writeStock(bld, k, (old + 0xf) & 0xff);
        }
      }
    }
  }
  const anim = (0xd - (serf.animation - 0x5d)) & 0xff;
  serf.animation = anim;
  setUnionU8(serf, 0xf, ~unionU8(serf, 0xf));
  return addCounter(serf, cfa(anim) >> 1);
}

/**
 * The shared body of the road carrier states **03 Transporting** (@0x2142b) and **14 Delivering**
 * (@0x22b9d), after the tick prologue. The DOS binary shares the whole code here; only the entry
 * differs (03 starts in the road walk, 14 continues the delivery loop).
 *
 * `resuming` = `true`: entry from handler 14 straight into the delivery loop (the serf stands at the
 * flag, `field_0xf` says "at the building" (0) or "return done" (!= 0)).
 *
 * Road walk (`resuming=false`): `field_0xe < 0` -> step towards `field_0xe+6` (`change_direction`);
 * on road -> remaining path mask -> single direction -> `directionStep`; at a flag -> the flag branch
 * (runner handover / delivery / shuttle). After `transporter_move_to_flag` and after the delivery loop
 * both fall into `change_direction` (the step back across the segment); a `'continue'` walks the next
 * tile within the same tick (multi-tile budget), as in the original (tail jump into the direction
 * routine).
 */
function transportBody(state: GameState, serf: Serf, resuming: boolean): void {
  let delivering = resuming;
  for (let guard = 0; guard < 128; guard++) {
    if (delivering) {
 // Delivery loop: "return done" (field_0xf != 0) -> back to Transporting plus the flag epilogue.
      if (i8(unionU8(serf, 0xf)) !== 0) {
        setUnionU8(serf, 0xf, 0);
        serf.state = 3;
        delivering = false;
        transporterMoveToFlag(state, serf);
 // Transporter step (serf_state_03 inline) -> `moveStep` without resetting `field_0xf`.
        const r = moveStep(state, serf, i8(serf.stateData[0xe - 0xb]));
        if (r !== 'continue') return;
        continue;
      }
 // otherwise "at the building" -> one delivery step.
      if (deliverStep(state, serf)) return;
      continue;
    }

 // --- road walk ---
    if (serf.col === null || serf.row === null) return;
    const came = i8(serf.stateData[0xe - 0xb]);
    if (came < 0) {
 // Turnaround/hesitation step (serf_state_03 inline, case `came+6`) -> `moveStep` without resetting
 // `field_0xf`, so the overcrowding counter is not cleared on the way back.
      const r = moveStep(state, serf, came + 6);
      if (r !== 'continue') return;
      continue;
    }
    const pos = posOf(serf.col, serf.row, state.geo);
    if (!tileHasFlag(state, pos)) {
      const mask = (state.mapTiles[pos].paths & 0x3f) & ~(1 << came);
      const dir = singleBitDir(mask);
      if (dir === null) {
        arrivalCleanup(state, serf);
        return;
      }
 // Transporter step WITH the idle transition (settles into the road instead of shuttling).
      const r = transporterOnRoadStep(state, serf, dir);
      if (r !== 'continue') return;
      continue;
    }

 // --- at a flag ---
 // (a) marked "become a runner" (field_0xf < 0) -> transition to Walking.
    if (i8(unionU8(serf, 0xf)) < 0) {
      serf.state = 2;
      setUnionU8(serf, 0xf, 0);
      setUnionU8(serf, 0xb, 0xfe);
      setUnionU16(serf, 0xc, 0);
      serf.counter = 0;
      return;
    }
 // (b) loaded and the destination is this flag -> enter the delivery loop (approach anim `0x5d+dH`).
    const carried = unionU8(serf, 0xb);
    if (carried !== 0 && unionU16(serf, 0xc) === state.mapTiles[pos].objIndex) {
      serf.state = 14;
      setUnionU8(serf, 0xf, 0);
      const bpos = neighbor(pos, Direction.UpLeft, state.geo);
      const anim = (0x5d + (state.mapTiles[bpos].height - state.mapTiles[pos].height)) & 0xff;
      serf.animation = anim;
      if (addCounter(serf, cfa(anim))) return;
      delivering = true;
      continue;
    }
 // (c) shuttle: pick up / swap / drop the resource, then turn around across the segment
 // (serf_state_03 inline -> `moveStep` without resetting `field_0xf`).
    transporterMoveToFlag(state, serf);
    const r = moveStep(state, serf, i8(serf.stateData[0xe - 0xb]));
    if (r !== 'continue') return;
    continue;
  }
}

type SerfHandler = (state: GameState, serf: Serf) => void;

/**
 * The 76-slot handler table (index == `serf.state`), all slots 0..75 like the original's jump table
 * `@0x16266`. The `| null` stays: it carries the defensive case of a state **outside** 0..75, which no
 * original save contains.
 */
const HANDLERS: (SerfHandler | null)[] = new Array(76).fill(null);

// 00 Null — empty handler (`ret`; does NOT touch counter or tick).
HANDLERS[0] = () => {};

/**
 * 01 IdleInStock — the serf rests in the stock (`serf_state_01 @0x1f59e`). No tick prologue: it NEVER
 * touches `counter`/`tick`, so a resting serf stays frozen. **But the handler is not a pure no-op:** in
 * the "stay idle" case it **registers** the serf as the representative of its type in the inventory
 * (`serfIndices[type] = index`, == the DOS type handler `FUN_0001f64e`: `inv[0x42+type*2] = serfIndex`,
 * unconditionally). That registration keeps `serfIndices` current so `request_serf` finds and
 * dispatches the matching generic or worker.
 *
 * ## The two branches
 *
 * ```
 * inv = inventories[serf[0xe]]                        // RAW union bytes, @0x1f5a1
 * if (!(inv[1] & 0x8)) goto register                  // bt $0x3 @0x1f5d8 — serf mode "eject"
 * if (inv[0x4a] >= 3) goto register                   // cmpw $0x3 @0x1f5e7 — at most 3 at a time
 * if (inv[0x42 + type*2] == own index) inv[...] = 0   // @0x1f607 — I was the representative
 * serf[0xb] = 0xfd ; inv[0x4a] += 1                   // @0x1f61b/@0x1f626
 * jmp 0x243f5                                         // sets state 15 and runs it IMMEDIATELY
 * register: jmp *(0x1f64e + type*8)                   // type jump table, 27 slots
 * ```
 *
 * The gate is **bit 3** of the `res_dir` byte, so `serfMode` 2 **and** 3 pass — and the value actually
 * stored by the "eject serfs" control is 3. A test against a single value is dead code, and with it
 * state 73 `Scatter` becomes unreachable, whose only producer is the `0xfd` (= -3) below.
 *
 * `serfs_out` = `inv+0x4a` == `serfIndices[4]` (the same slot `flag-update.ts` uses as its dispatch
 * counter — type 4 `TransporterInventory` therefore has no representative cache). The `+1` here is
 * subtracted again by state 15 on **success**; it only persists while the serf is blocked in the exit.
 * The counter measures "how many are stuck leaving", not "how many are out" — hence the limit of 3.
 *
 * ## The type jump table is NOT uniform (@0x1f64e, 27 slots, **7** distinct targets)
 *
 * | Type | Target | what stands there |
 * |---|---|---|
 * | 0..9, 11..21 | `@0x1f7a6` | `serfIndices[type] = own index` |
 * | **10 Smelter** | `@0x1f7bd` | **a bare `ret`** — the smelter is *not* registered |
 * | 22..25 Knight0..3 | `@0x1f7be`...`@0x1fa5e` | ageing plus promotion ({@link trainKnightInStock}) |
 * | **26 Knight4** | `@0x1fb3e` | **only** `serfIndices[26] = ...` — top rank, nothing to promote |
 *
 * The type 10 slot really is a single `ret` directly behind the general body's own `ret`. The practical
 * consequence: `serfIndices[10]` is the representative by which `request_serf` recognises a FINISHED
 * smelter, so registering him would send him off directly where the original has to take a generic plus
 * tools.
 */
const idleInStock: SerfHandler = (state, serf) => {
 // `inventories[serf[0xe]]` — the **raw** union bytes as in the original (@0x1f5a1 reads
 // `mov 0xe(%ebx),%ax` unconditionally). A decoded view would go stale while ticking.
  const inv = state.inventories?.[unionU16(serf, 0xe)];
  if (!inv) return;
 // `bt $0x3` on `inv[1]` @0x1f5d8 — bit 3 is the upper bit of `serfMode`, so it hits 2 AND 3.
  const outMode = (inv.serfMode & 2) !== 0;
  const serfsOut = inv.serfIndices[4]; // inv+0x4a
  if (!outMode || serfsOut >= SERFS_OUT_LIMIT) {
    registerIdleSerf(state, inv, serf);
    return;
  }
 // -- eject (@0x1f5ee..@0x1f62b) --
 // The representative cache is only cleared if it is HIM (@0x1f607): another resting serf of the same
 // type stays registered.
  if (inv.serfIndices[serf.type] === serf.index) inv.serfIndices[serf.type] = 0;
  setUnionU8(serf, 0xb, EJECT_MARKER);
  inv.serfIndices[4] = addU16(serfsOut, 1);
 // `jmp 0x243f5` — the preamble sets state 15 and falls into its body, still within THIS tick.
  serf.state = 15;
  HANDLERS[15]!(state, serf);
};
HANDLERS[1] = idleInStock; // IdleInStock (registration / eject)

/** `cmpw $0x3,0x4a(%ebx)` @0x1f5e7 — at most this many hang in the exit at once. */
const SERFS_OUT_LIMIT = 3;

/**
 * `serf[0xb] = 0xfd` @0x1f61b — the eject marker (-3). State 15 turns it into the follow-up state
 * `0x49` = 73 `Scatter`; this is its **only** source in the original.
 */
const EJECT_MARKER = 0xfd;

/** The one serf type the registration table skips (slot `@0x1f69e` = a bare `ret`). */
const SERF_TYPE_SMELTER = 10;

/**
 * The registration side of the type jump table `@0x1f64e` (see the head of {@link idleInStock}): the 26
 * slots pointing at the general body `@0x1f7a6`, **plus** the exception for type 10. For the knights it
 * is the *shared* exit of their five own bodies.
 */
function registerIdleSerf(state: GameState, inv: Inventory, serf: Serf): void {
  if (serf.type === SERF_TYPE_SMELTER) return; // @0x1f7bd — a bare `ret`
  const rank = serf.type - SERF_KNIGHT0;
  if (rank >= 0 && rank < STOCK_TRAINING_THRESHOLD.length) {
    trainKnightInStock(state, inv, serf, rank); // @0x1f7be/@0x1f89e/@0x1f97e/@0x1fa5e
    return;
  }
 // @0x1f7a6 (types 0..9, 11..21) and @0x1fb3e (type 26 Knight4) — two bodies, the same single line:
 // Knight4 is the top rank, does not age and does not draw, so only the registration remains.
  inv.serfIndices[serf.type] = serf.index;
}

/** Serf type Knight0; a knight's rank is `type - 22` (Knight0..4 = types 22..26). */
const SERF_KNIGHT0 = 22;

/**
 * Promotion thresholds of knight **training in the stock** (rank 0..3) — `P = threshold/65536` per
 * re-arm round, so about 6.1 / 3.1 / 1.5 / 0.8 %: the chance **halves per rank**.
 *
 * In the binary they are **immediates** in the four body copies (`cmpw $0xfa0` @0x1f809 ·
 * `$0x7d0` @0x1f8e9 · `$0x3e8` @0x1f9c9 · `$0x1f4` @0x1faa9) — unlike the guard states, which **read**
 * the same numbers from the packed table `@0x1fc1c` (`serf-military.ts` `DEFEND_THRESHOLD`).
 * Numerically these are exactly its first four entries (`0x1fc1c[r*4]`), the steepest step of the
 * halving series `4000 2000 1000 500 250 125 62 31` — the stock promotes faster than guard duty does.
 */
const STOCK_TRAINING_THRESHOLD: readonly number[] = [4000, 2000, 1000, 500];

/** `mov $0x1770` @0x1f85c / `addw $0x1770` @0x1f883 — re-arm step of the training counter. */
const TRAINING_REARM = 0x1770;
/** `addw $0x1770` @0x1f883 carries iff the old counter >= `0x10000 - 0x1770`; then `jae` ends the loop. */
const TRAINING_REARM_WRAP = 0xe890;

/**
 * Knight **training in the stock** — the four rank bodies `@0x1f7be` / `@0x1f89e` / `@0x1f97e` /
 * `@0x1fa5e` of the registration table (see the head of {@link idleInStock}). A knight resting in the
 * stock ages and rises in rank over time; the original does that right here, in the "nothing to do"
 * state, not in a training subsystem of its own.
 *
 * ```
 * delta = gameTick - serf[8] ; serf[8] = gameTick ; serf[2] -= delta   // @0x1f7be..@0x1f7ef
 * if (no underflow) { inv[0x6e + rank*2] = index ; return }            // @0x1f7f3 not taken
 * for (;;) {
 *   if (rng_next() < threshold[rank]) {                                // @0x1f804/@0x1f809
 *     serf[0] += 4 ; player[0x11a] += 1<<rank                          // @0x1f814 / @0x1f845
 *     serfCount[22+rank]-- ; serfCount[23+rank]++                      // @0x1f84f / @0x1f857
 *     serf[2] = 0x1770 ; inv[old] = 0 ; inv[new] = index ; return      // @0x1f85c/@0x1f867/@0x1f871
 *   }
 *   serf[2] += 0x1770                                                  // @0x1f883
 *   if (carry) { inv[0x6e + rank*2] = index ; return }                 // @0x1f889 not taken
 * }
 * ```
 *
 * **The promotion block is byte-identical to the guard idle handler** (`@0x1f811..0x1f85c` against
 * `@0x1fd2f`, 75 bytes, 0 differing instructions), which is why the port calls the same `promote()`
 * helper. The *bodies* stay separate because their three exits differ: on guard duty all end in a bare
 * `ret` (there is no inventory there), in the stock **every** exit maintains the representative cache
 * `inv.serfIndices` — on promotion it is moved from the old rank to the new one (`inv[old] = 0`
 * **before** `inv[new] = index`, @0x1f867/@0x1f871).
 *
 * The counter `serf[2]` is saved state, so training continues across saves. It draws from the **RNG** on
 * every underflow, so a resting knight shifts the random stream.
 */
function trainKnightInStock(state: GameState, inv: Inventory, serf: Serf, rank: number): void {
  if (!advance(serf, state.gameTick)) {
    inv.serfIndices[serf.type] = serf.index; // @0x1f7f5 — refresh the cache, then `ret` @0x1f803
    return;
  }
  const threshold = STOCK_TRAINING_THRESHOLD[rank]!;
  for (;;) {
    if (state.rng.next() < threshold) {
      const oldType = serf.type;
      promote(state, serf, rank); // @0x1f811..0x1f85b — the shared 75-byte block
      serf.counter = TRAINING_REARM; // @0x1f85c
      inv.serfIndices[oldType] = 0; // @0x1f867 — the old rank loses its representative
      inv.serfIndices[serf.type] = serf.index; // @0x1f871
      return;
    }
    const before = serf.counter;
    serf.counter = addU16(before, TRAINING_REARM); // @0x1f883
    if (before >= TRAINING_REARM_WRAP) {
 // `addw` carried => `jae` @0x1f889 **not** taken: maintain the cache and leave (@0x1f88f).
      inv.serfIndices[serf.type] = serf.index;
      return;
    }
  }
}

/**
 * The shared tile-occupy tail of 66/67 (`@0x16582`/`@0x165df`): if his own road tile is free the carrier
 * claims it and becomes **Transporting (3)** (empty: `field_0xb=0`, `field_0xf=0`, `counter=0`,
 * `tick=now`). Otherwise he stays in `state` (67 WaitIdleOnPath) and tries again next tick.
 */
function idleOnPathClaimTile(state: GameState, serf: Serf): void {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (state.mapTiles[pos].serfIndex === 0) {
    state.mapTiles[pos].serfIndex = serf.index;
    serf.state = 3; // Transporting
    serf.tick = state.gameTick;
    serf.counter = 0;
    setUnionU8(serf, 0xb, 0);
    setUnionU8(serf, 0xf, 0);
  }
}

/**
 * `serf_state_66_IdleOnPath` (@0x16546) — the carrier resting on a road checks **every tick** (NO tick
 * prologue) whether a resource is to be picked up on his segment. `field_0xb` = `rev` (direction towards
 * the "home" end, 0..5), `field_0xc` (u32) = byte offset of the home flag (`flagIndex*70`), the low byte
 * of `tick` = the stored `came` direction (left there when he sat down).
 * - If a pickup is scheduled at the home end in direction `rev` (`flag.scheduled[rev]`, DOS byte
 * `flag[0x3c+rev]` bit 7) -> wake up towards home: `field_0xe = (tick_low + 6)` (restores the original
 * `came` direction).
 * - Otherwise check the **other** end of the segment (`flag.connections[rev]` with
 * `flag.otherEndDir[rev]`): scheduled there -> wake up towards it (`field_0xe = rev-3 (+6 if rev<3)` =
 * `oppositeDir(rev)`). Nothing scheduled -> keep resting (return).
 * Then `state = 67` (WaitIdleOnPath) and immediately `idleOnPathClaimTile`.
 */
function idleOnPath(state: GameState, serf: Serf): void {
  if (serf.col === null || serf.row === null) return;
  const rev = serf.stateData[0] & 0x7; // field_0xb (0..5)
  const flagOff =
    (serf.stateData[1] | (serf.stateData[2] << 8) | (serf.stateData[3] << 16) | (serf.stateData[4] << 24)) >>> 0;
  const flag = state.flags?.[(flagOff / 70) | 0];
  if (!flag) return;
  if (flag.scheduled[rev]) {
    setUnionU8(serf, 0xe, (i8(serf.tick & 0xff) + 6) & 0xff); // came = the home direction
  } else {
    const conn = flag.connections[rev];
    const otherFlag = conn && conn.kind === 'flag' ? state.flags[conn.index] : null;
    const otherDir = flag.otherEndDir[rev];
    if (!otherFlag || !otherFlag.scheduled[otherDir]) return; // nothing scheduled -> keep resting
    setUnionU8(serf, 0xe, (rev - 3 + (rev < 3 ? 6 : 0)) & 0xff);
  }
  serf.state = 67; // WaitIdleOnPath
  idleOnPathClaimTile(state, serf);
}
HANDLERS[66] = idleOnPath;

/**
 * `serf_state_67_WaitIdleOnPath` (@0x165df) — a woken carrier whose tile was still occupied: try to claim
 * the tile again every tick (-> Transporting) until it is free. No tick prologue.
 */
HANDLERS[67] = idleOnPathClaimTile;

/**
 * `serf_state_69_WakeOnPath` (@0x166b6) — a carrier woken on the road (for instance by a road merge when a
 * flag is torn down): walking direction `field_0xe` = the **highest set path direction** of his tile,
 * then, if the tile is free, claim it and become **Transporting (3)**. Otherwise he stays WaitIdleOnPath
 * (67) and retries next tick. That is how a previously resting carrier starts moving again after a merge
 * and, when he next rests, finds a valid home flag from his current segment (repairing the dangling home
 * pointer by itself).
 */
HANDLERS[69] = (state, serf) => {
  serf.state = 67; // WaitIdleOnPath (default if the tile is occupied)
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  const paths = state.mapTiles[pos].paths & 0x3f;
  let came = 5;
  while (came > 0 && (paths & (1 << came)) === 0) came--; // highest set path direction (DOS: 5 -> 0)
  setUnionU8(serf, 0xe, came);
  idleOnPathClaimTile(state, serf); // free -> Transporting (3), otherwise 67
};

/**
 * `serf_state_68_WakeAtFlag` (@0x16640) — a carrier woken on a flag tile (the carrier resting on a flag
 * about to be torn down, or one ejected as surplus by a road merge, 69 -> 68): if his tile is free he
 * claims it and becomes **Lost (25)**, or **LostSailor (26)** if he is a sailor (type 1). If the tile is
 * occupied he stays 68 and retries next tick. No tick prologue. From there Lost looks for the nearest own
 * flag and walks home via FreeWalking.
 */
HANDLERS[68] = (state, serf) => {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (state.mapTiles[pos].serfIndex !== 0) return; // tile occupied -> next tick
  state.mapTiles[pos].serfIndex = serf.index; // claim it
  serf.tick = state.gameTick;
  serf.counter = 0;
  if (serf.type === 1) {
    serf.state = 26; // LostSailor
  } else {
    serf.state = 25; // Lost
    setUnionU8(serf, 0xb, 0);
  }
};

/**
 * `FUN_0001be02` (@0x1be02) — transition Lost/LostSailor -> **FreeWalking (16)** (knights, types 22..26,
 * -> 53 KnightFreeWalking): `neg_dist1 = -128` (0x80, the "home to the stock" sentinel),
 * `neg_dist2 = -1`, `flags = 0`, `counter = 0`. `dist_col`/`dist_row` (field_0xb/0xc) have already been
 * set by the caller to the delta towards the target; FreeWalking walks there and homes via
 * `findInventory` (neg_dist1 == -128).
 */
function lostToFreeWalking(serf: Serf): void {
  serf.state = serf.type >= 22 && serf.type <= 26 ? 53 : 16;
  setUnionU8(serf, 0xd, 0x80); // neg_dist1 = -128
  setUnionU8(serf, 0xe, 0xff); // neg_dist2 = -1
  setUnionU8(serf, 0xf, 0); // flags = 0
  serf.counter = 0;
}

/**
 * `serf_state_25_Lost` (@0x1b9f2) — a disoriented serf (a carrier whose road was deleted under him, say)
 * looks for a destination and then goes into FreeWalking (home to the nearest stock). Two phases:
 * 1. **Spiral search** over the map pattern (`SPIRAL_PATTERN` = `gs+0x80`, from index 1 forwards or from
 * 258 backwards depending on `field_0xb`): find the **nearest own flag with roads** and set its spiral
 * delta as the destination (`dist_col/row`).
 * 2. If the spiral finds none -> **random walk** (`rng`): draw random (dcol,drow) at a growing radius
 * until an empty, walkable (height > 0), own tile is hit (or the radius is exhausted).
 * Then {@link lostToFreeWalking}. Tick-gated through {@link advance}.
 */
HANDLERS[25] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const pos = posOf(serf.col, serf.row, geo);
  const ownerMatch = (tpos: number): boolean => {
    const o = state.mapTiles[tpos].owner; // 1-based (0 = no owner)
    return o !== 0 && o - 1 === serf.owner;
  };
 // Phase 1: spiral search for the nearest own flag with roads.
 // **258** passes, not 257: the counter starts at `0x101` and the loop ends with `subw $0x1 ; jae`
 // (@0x1bace/@0x1bc04), so the body also runs for counter value 0. Forwards that is spiral index
 // 1..258, backwards 258..1 (start `+0x204` bytes = index 258, step -2 @0x1ba81).
  const forward = i8(serf.stateData[0]) === 0; // field_0xb == 0 -> forwards, otherwise backwards
  for (let k = 0; k < 258; k++) {
    const idx = forward ? 1 + k : 258 - k;
    const tpos = spiralPos(pos, idx, geo);
    const t = state.mapTiles[tpos];
 // The original reads `flag[4] & 0x3f` (@0x1bbb0/@0x1bbc6), **not** the tile: the tile additionally
 // carries bit 4 for the path to its own building. The two tests differ exactly for building flags
 // with no road connection at all — the ones a Lost serf must not be sent to.
    const fl = t.object === 1 ? state.flags[t.objIndex] : null;
    if (fl != null && fl.endpointDirs.some(Boolean) && ownerMatch(tpos)) {
      setUnionU8(serf, 0xb, SPIRAL_PATTERN[idx][0] & 0xff); // dist_col = spiral delta col
      setUnionU8(serf, 0xc, SPIRAL_PATTERN[idx][1] & 0xff); // dist_row = spiral delta row
      lostToFreeWalking(serf);
      return;
    }
  }
 // Phase 2: random walk at a growing radius for an empty, walkable, own tile.
 // The counter `v0` is a **16-bit word** (@0x1bc7f `subw $0x1` with `jae`); the radius switch hangs on
 // the **borrow**, so it happens when `v0` was `0` BEFORE the decrement, not after. On exhaustion
 // (`v1 == 0x3f`) the original writes `-1` (@0x1bc8c) and restarts at the small radius; the "radius
 // exhausted" test is `or %ax,%ax ; js` @0x1bd9d, i.e. the sign of the **word**.
  const bcol = colOf(pos, geo);
  const brow = rowOf(pos, geo);
  let v0 = 10;
  let v1 = 0xf;
  let v3 = 8;
  let dcol = 0;
  let drow = 0;
 // Unbounded, as in the original: with **no** empty walkable tile in range the loop draws forever. On
 // a real map that cannot happen (height 0 is only water and border); synthetic test maps therefore
 // have to carry a height > 0.
  for (;;) {
    let tpos: number;
    do {
      do {
        if (v0 === 0) {
          if (v1 === 0x3f) {
            v0 = 0xffff; // `mov $0xffffffff` — only the word matters for `subw`/`or %ax,%ax`
            v1 = 0xf;
            v3 = 8;
          } else {
            v0 = 0x13;
            v1 = (v1 * 2 + 1) & 0xffff;
            v3 = (v3 * 2) & 0xffff;
          }
        } else {
          v0 = (v0 - 1) & 0xffff;
        }
        const r = state.rng.next();
        dcol = (r & v1) - v3; // low byte & mask - offset
        drow = ((r >> 8) & v1) - v3; // high byte & mask - offset
        tpos = posOf(bcol + dcol, brow + drow, geo);
      } while ((state.mapTiles[tpos].object & 0x7f) !== 0); // until empty (object == 0)
    } while ((state.mapTiles[tpos].height & 0x1f) === 0); // until height > 0
    if (((v0 << 16) >> 16) < 0) break; // radius exhausted -> take the last delta
    if (ownerMatch(tpos)) break; // own tile -> accept
  }
  setUnionU8(serf, 0xb, dcol & 0xff);
  setUnionU8(serf, 0xc, drow & 0xff);
  lostToFreeWalking(serf);
};

/**
 * `serf_state_26_LostSailor` (@0x1b6fb) — the disoriented **sailor**. Same purpose as
 * {@link HANDLERS.25 Lost} (find a destination and set off), but a **routine of its own** with four
 * differences, all read in the ASM:
 *
 * 1. **Forwards only.** The spiral search always starts at index 1 (`gs[0x80] + 2` @0x1b77d) and counts
 * up; the `field_0xb` branch "backwards from 258" (@0x1ba74 ff.) does not exist here.
 * 2. **Random walk without a growing radius.** Fixed mask `0x1f` and fixed offset `0x10`
 * (@0x1b8fb..@0x1b90a), so uniform in -16..+15, repeated until the target tile is **empty**
 * (`object & 0x7f == 0` @0x1b985). **No** height test and **no** owner test — the land walker checks
 * both.
 * 3. **No knight branch.** The exit is not {@link lostToFreeWalking} (which sends knights to 53) but its
 * own tail @0x1b9c7: **state 27 FreeSailing**, `neg_dist1 = -128`, `neg_dist2 = -1`, `flags = 0`,
 * `counter = 0`.
 * 4. The flag condition is the same as for Lost (`flag[4] & 0x3f != 0` @0x1b890/@0x1b8a6 plus own land),
 * so the sailor also looks for a **connected** own flag.
 */
HANDLERS[26] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const pos = posOf(serf.col, serf.row, geo);

 // Phase 1: spiral search for the nearest own flag connected to the road network.
  for (let idx = 1; idx <= 258; idx++) {
    const tpos = spiralPos(pos, idx, geo);
    const t = state.mapTiles[tpos];
    const fl = t.object === 1 ? state.flags[t.objIndex] : null;
    if (fl == null || !fl.endpointDirs.some(Boolean)) continue;
    const o = t.owner;
    if (o === 0 || o - 1 !== serf.owner) continue;
    setUnionU8(serf, 0xb, SPIRAL_PATTERN[idx][0] & 0xff);
    setUnionU8(serf, 0xc, SPIRAL_PATTERN[idx][1] & 0xff);
    lostSailorToFreeSailing(serf);
    return;
  }

 // Phase 2: uniform random draw until an **empty** tile is hit.
  const bcol = colOf(pos, geo);
  const brow = rowOf(pos, geo);
  let dcol = 0;
  let drow = 0;
  for (let guard = 0; guard < 4096; guard++) {
    const r = state.rng.next();
    dcol = (r & 0x1f) - 0x10;
    drow = ((r >> 8) & 0x1f) - 0x10;
    if ((state.mapTiles[posOf(bcol + dcol, brow + drow, geo)].object & 0x7f) === 0) break;
  }
  setUnionU8(serf, 0xb, dcol & 0xff);
  setUnionU8(serf, 0xc, drow & 0xff);
  lostSailorToFreeSailing(serf);
};

/**
 * The tail of state 26 (@0x1b9c7) — literally {@link lostToFreeWalking} but with state **27** instead of
 * 16/53. A function of its own because it is one in the binary and the knight branch is missing here.
 */
function lostSailorToFreeSailing(serf: Serf): void {
  serf.state = 27; // FreeSailing
  setUnionU8(serf, 0xd, 0x80); // neg_dist1 = -128 ("home to the stock")
  setUnionU8(serf, 0xe, 0xff); // neg_dist2 = -1
  setUnionU8(serf, 0xf, 0); // flags = 0
  serf.counter = 0;
};

/**
 * 27 FreeSailing (`serf_state_27_FreeSailing @0x1afa3`) — the water copy of the terrain walk. Tick gate,
 * then {@link freeSailingBody}; the water test at the loop head is documented there.
 */
HANDLERS[27] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  freeSailingBody(state, serf);
};

/**
 * `serf_state_28_EscapeBuilding` (@0x1af49) — the **waiting state of a serf thrown out of his building**
 * who does not have a tile of his own yet. It arises on demolition or burning: the holder ejection
 * (`FUN_00048eb8`) puts every occupant who is **not** the visible tile occupant into 28 — several serfs
 * then share the same position, but `game[pos].serf` can only point at one.
 *
 * The handler has **no tick gate**: it checks every pass whether its tile has become free. If so it
 * claims it and becomes **25 Lost** (walking home from there); otherwise it stays put
 * (`b0 52` anim / `b0 19` state / `mov %ax,0x8(%ebx)` tick @0x1af6c..0x1af9b).
 */
HANDLERS[28] = (state, serf) => {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (state.mapTiles[pos].serfIndex !== 0) return; // tile still occupied -> keep waiting
  state.mapTiles[pos].serfIndex = serf.index;
  serf.animation = ANIM_WAIT_OUT; // 0x52
  serf.counter = 0;
  serf.state = 25; // Lost
  setUnionU8(serf, 0xb, 0); // spiral direction "forwards"
  serf.tick = state.gameTick;
};

/**
 * `serf_state_73_Scatter` (@0x1be4d) — a serf who had to leave his stock is **scattered into the
 * landscape**: he draws a random destination at least 8 tiles away and walks there freely.
 *
 * The state is reached **indirectly**: `serf_state_15_ReadyToLeaveInventory` sets the follow-up state
 * `serf[0xf] = 0x49` on the eject marker `field_0xb == -3`, and state 5 (LeavingBuilding) takes it over
 * after the leaving animation.
 *
 * **Where the `-3` comes from:** exactly one place sets it — the eject branch of
 * `serf_state_01_IdleInStock` (entry @0x1f59e, gate @0x1f5e4: `bt $0x3` on `inv[1]`, so serf mode
 * "eject", plus `inv+0x4a < 3`), see {@link idleInStock}.
 *
 * The draw (`@0x1beaf` loop): one RNG word per round, `dx = spread(r & 0xf)`,
 * `dy = spread((r >> 8) & 0xf)` with `spread(v) = v - 8 >= 0 ? v : v - 15` (so
 * `dx,dy` in `[-15,-8] u [8,15]`, `subw $0x8 ; jns ; +8 / -7` @0x1becc). A draw is rejected while the
 * target tile carries an **object** (`landscape[3] & 0x7f != 0`) or its **height is 0**
 * (`landscape[1] & 0x1f == 0`, i.e. water or border). The delta is then the FreeWalking destination; the
 * tail is the same as for Lost ({@link lostToFreeWalking}), inline in the original rather than a call.
 * The binary tests the knight bounds on the **raw type byte** (`andb $0x7c` + `cmpb $0x58/$0x6c`
 * @0x1bfc6..0x1bfd3); across all 32 possible type values that is exactly "type 22..26", so equivalent to
 * the decoded comparison.
 *
 * The original parks the intermediates (base column/row, drawn delta) in the scratch fields
 * `gs+0x24a..0x24f` rather than registers — pure scratch within this one call, hence locals here.
 */
HANDLERS[73] = (state, serf) => {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const baseCol = serf.col;
  const baseRow = serf.row;
  const spread = (v: number): number => (v - 8 >= 0 ? v : v - 15);
  let dcol = 0;
  let drow = 0;
  for (let guard = 0; guard < 4096; guard++) {
    const r = state.rng.next();
    dcol = spread(r & 0xf);
    drow = spread((r >> 8) & 0xf);
    const tpos = posOf(baseCol + dcol, baseRow + drow, geo);
    if ((state.mapTiles[tpos].object & 0x7f) !== 0) continue; // tile occupied
    if ((state.mapTiles[tpos].height & 0x1f) === 0) continue; // height 0 -> not walkable
    break;
  }
  setUnionU8(serf, 0xb, dcol & 0xff); // dist_col
  setUnionU8(serf, 0xc, drow & 0xff); // dist_row
  lostToFreeWalking(serf);
};

// 05 LeavingBuilding — wait out the leaving animation, then switch to the remembered follow-up state.
// `serf_state_05 @0x2439e`: on expiry `counter=0; state=serf[0xf]; serf[0xf]=0`.
HANDLERS[5] = (_state, serf) => {
  if (!advance(serf, _state.gameTick)) return;
  serf.counter = 0;
  serf.state = unionU8(serf, 0xf);
  setUnionU8(serf, 0xf, 0);
};

/**
 * `requested_serf_reached` — the building accepts the arriving requested serf (`serf_state_02` @0x2337c
 * ff): set the **holder** bit (`bld[5] |= 0x40`); if a serf was requested (`bld[5]` bit 7
 * `serfRequested`), set `firstKnight = serfIndex` and clear the bit.
 */
function requestedSerfReached(bld: Building, serfIndex: number): void {
  bld.holder = true;
  if (bld.serfRequested) {
    bld.firstKnight = serfIndex;
    bld.serfRequested = false;
  }
}

/**
 * Arrival handover at the destination (`dest == current flag`) — `serf_state_02` @0x2337c..@0x232b6,
 * three cases by `field_0xb` (dir1):
 * - **dir1 >= 0, != 6 -> become a carrier**: `complete_serf_request` at both ends of the segment
 * (`length[dir]`: clear bit 7, +1), state 3 (Transporting), `field_0xe = dir1` (carrier direction),
 * `field_0xb = 0` (no resource), `field_0xf = 0`, then `transporter_move_to_flag` +
 * `change_direction` (the approach across the segment).
 * - **dir1 == 6 -> LookingForGeoSpot (42)** (geologist), counter 0.
 * - **dir1 < 0 -> enter the building**: `requested_serf_reached` (holder/firstKnight), state 6
 * (ReadyToEnter), then `stepInToBuilding` — tile free -> entry (state 4), occupied -> wait anim `0x55`
 * and ReadyToEnter stays (retry next tick).
 */
function walkingDestReached(state: GameState, serf: Serf, flagIdx: number): void {
  if (serf.col === null || serf.row === null) return;
  const dir1 = i8(unionU8(serf, 0xb));
  if (dir1 >= 0) {
    if (dir1 === 6) {
      serf.state = 42; // LookingForGeoSpot
      serf.counter = 0;
      return;
    }
 // Become a carrier.
    const flag = state.flags[flagIdx];
    if (flag) {
      const otherDir = flag.otherEndDir[dir1];
      const conn = flag.connections[dir1];
      const otherFlag = conn && conn.kind === 'flag' ? state.flags[conn.index] : null;
      flag.length[dir1] = ((flag.length[dir1] & 0x7f) + 1) & 0xff;
      if (otherFlag) otherFlag.length[otherDir] = ((otherFlag.length[otherDir] & 0x7f) + 1) & 0xff;
    }
    serf.state = 3; // Transporting
    setUnionU8(serf, 0xe, dir1);
    setUnionU8(serf, 0xb, 0);
    setUnionU8(serf, 0xf, 0);
    transporterMoveToFlag(state, serf);
    moveStep(state, serf, dir1); // transporter step (serf_state_03 inline), no field_0xf reset
    return;
  }
 // The original does **not** branch further here: the arrival handover @0x20262 tests `serf[0xb]` only
 // for its sign (`or %al,%al ; jns 0x20304`) and in the negative branch reads `serf[4]` right away
 // (@0x20273). The second test `addb $0x1 ; js` belongs to {@link arrivalCleanup} (@0x207d0).
  const bldTile = neighbor(posOf(serf.col, serf.row, state.geo), Direction.UpLeft, state.geo);
  const bld = state.buildings[state.mapTiles[bldTile].objIndex];
  if (bld) requestedSerfReached(bld, serf.index);
  serf.state = 6; // ReadyToEnter
  stepInToBuilding(state, serf); // free -> entry (4); occupied -> wait anim, stays 6
}

/**
 * 02 Walking — a serf walks along the roads to his destination (`serf_state_02_Walking @0x1ff9d`).
 * Tick gate; on expiry a **multi-tile loop** (the original tail-calls step -> on road/flag -> step until
 * the counter overflows). Per iteration:
 * - **Not oriented** (`field_0xe < 0`): `walkingWaiting` — wait counter plus loop detection, then another
 * step in the remembered intent.
 * - **On the road** (no flag): remaining path mask (`paths` without the "came from" bit) -> single
 * direction -> `directionStep`. Dead end (no single bit) -> `arrivalCleanup`.
 * - **At a flag**: check `dest` (`field_0xc`) against this tile's flag. Destination **reached** ->
 * arrival handover. `dest == 0` ("go home"): find the nearest stock in the road network
 * (`find_nearest_inventory`) and set it as the destination. Otherwise a **transit flag** ->
 * `flagSearchDir` (shortest-path BFS) picks the next direction -> `directionStep`. A failed search ->
 * `arrivalCleanup`.
 */
HANDLERS[2] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  for (let guard = 0; guard < 64; guard++) {
    if (serf.col === null || serf.row === null) return;
    const came = i8(serf.stateData[0xe - 0xb]);
    if (came < 0) {
 // Not oriented -> wait / re-orient.
      if (walkingWaiting(state, serf) !== 'continue') return;
      continue;
    }
    const pos = posOf(serf.col, serf.row, state.geo);
    if (!tileHasFlag(state, pos)) {
 // On the road: remaining path mask -> single direction.
      const mask = (state.mapTiles[pos].paths & 0x3f) & ~(1 << came);
      const dir = singleBitDir(mask);
      if (dir === null) {
        arrivalCleanup(state, serf); // dead end
        return;
      }
      if (directionStep(state, serf, dir) !== 'continue') return;
      continue;
    }
 // At a flag.
    const flagIdx = state.mapTiles[pos].objIndex;
    const dest = serf.stateData[0xc - 0xb] | (serf.stateData[0xd - 0xb] << 8);
    if (dest === flagIdx) {
 // Destination reached -> arrival handover (become a carrier / geologist / enter the building).
      walkingDestReached(state, serf, flagIdx);
      return;
    }
    if (dest === 0) {
 // The "go home" carrier (field_0xf < 0 -> Walking with field_0xc = 0): find the nearest stock in the
 // road network (`find_nearest_inventory` @0x44703), set it as the destination and walk there.
      const inv = findNearestInventory(state, flagIdx);
      if (inv === null) {
 // No reachable stock (`js` on the return value @0x2022d) — its own tail @0x2022f, **not** the
 // dead-end cleanup: `serf[0xa] = 0x19` (Lost), `serf[0xb] = 1` (spiral search backwards),
 // `serf[2] = 0`. A cleanup here would leave the serf in Walking with `dest = 0`, searching in vain
 // every tick.
        serf.state = 25;
        setUnionU8(serf, 0xb, 1);
        serf.counter = 0;
        return;
      }
      setUnionU16(serf, 0xc, inv); // dest = the inventory flag found -> loop again
      continue;
    }
 // Transit flag -> the shortest-path BFS picks the next direction.
    const dir = flagSearchDir(state, flagIdx, dest);
    if (dir === null) {
      arrivalCleanup(state, serf); // search failed
      return;
    }
    if (directionStep(state, serf, dir) !== 'continue') return;
    continue;
  }
};

/**
 * 03 Transporting — a road carrier moves across his segment (`serf_state_03_Transporting @0x2142b`).
 * Tick gate, then the shared `transportBody` (entering in the road walk). At the end of the segment (a
 * flag) he picks up, drops or swaps resources (`transporter_move_to_flag` + `prioritize_pickup`), or
 * switches into the delivery loop (-> state 14) when the resource belongs to the target building.
 */
HANDLERS[3] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  transportBody(state, serf, false);
};

// ==== Serf types (byte 0 bits 2..6), as far as the EnteringBuilding dispatch needs them ====
const ST_TRANSPORTER = 0;
const ST_SAILOR = 1;
const ST_DIGGER = 2;
const ST_BUILDER = 3;
const ST_TRANSPORTER_INV = 4;
const ST_LUMBERJACK = 5;
const ST_SAWMILLER = 6;
const ST_STONECUTTER = 7;
const ST_FORESTER = 8;
const ST_MINER = 9;
const ST_SMELTER = 10;
const ST_FISHER = 11;
const ST_PIGFARMER = 12;
const ST_BUTCHER = 13;
const ST_FARMER = 14;
const ST_MILLER = 15;
const ST_BAKER = 16;
const ST_BOATBUILDER = 17;
const ST_TOOLMAKER = 18;
const ST_WEAPONSMITH = 19;
const ST_GEOLOGIST = 20;
const ST_GENERIC = 21;

const BUILDING_TYPE_STEEL_SMELTER = 18;
const BUILDING_TYPE_STONE_MINE = 5;

/**
 * Two-phase building-material buildings (the builder's entry sets `material_step` bit 7 and anim 100
 * instead of 98). The bit table `@0x4a0400` lies in the **data segment**, not in the code, so the type
 * list is a structural hypothesis still to be confirmed against behaviour.
 */
const BUILDER_TWO_PHASE = new Set([10, 17, 19, 22]); // Warehouse, Sawmill, ToolMaker, Fortress

/** Mineral deposit per mine building type (StoneMine..GoldMine -> 4..1), table `@0x24336` = `04 03 02 01`. */
const MINE_DEPOSIT = [4, 3, 2, 1] as const;

/**
 * `enter_inventory` (the `-2` branches of all type handlers plus sailor/generic): the serf returns to the
 * stock -> **IdleInStock (1)**. Serf tile freed, `field_0xe = inventoryIndex`, `field_0xc = 0`,
 * `field_0xb = 0`.
 */
function enterInventory(state: GameState, serf: Serf, bldTile: number, bld: Building): void {
  state.mapTiles[bldTile].serfIndex = 0;
  setUnionU16(serf, 0xe, bld.inventoryIndex ?? 0);
  setUnionU16(serf, 0xc, 0);
  setUnionU8(serf, 0xb, 0);
  serf.state = 1; // IdleInStock
}

/**
 * Sets the building flag's fields on the first entry of a production worker (`field_0xb != 0`). The
 * original writes the flag bytes `0x42..0x45` (`bld_flags`/`stockPriority0`/`bld2_flags`/
 * `stockPriority1`); the **low bits** of `bld_flags`/`bld2_flags` are the resource routing mask (which
 * resource the building requests), bit 7 is `acceptsSerfs`/`acceptsResources`. Bit 7 is 0 for every
 * production worker.
 */
function firstTimeStockFlag(
  flag: ReturnType<typeof getFlag>,
  b66: number,
  b68: number,
  b67?: number,
  b69?: number,
): void {
  if (!flag) return;
 // On entry the original writes the WHOLE flag byte (`mov [ebx+0x42|0x44],al`): bit 7 =
 // acceptsSerfs/Resources, bits 0..5 = the material request mask. The resource scheduler reads the raw
 // low bits, the popups read the bit — `flag-accept.ts` keeps both halves together.
  setFlagAcceptByte(flag, 0x42, b66);
  setFlagAcceptByte(flag, 0x44, b68);
  if (b67 !== undefined) flag.stockPriority[0] = b67;
  if (b69 !== undefined) flag.stockPriority[1] = b69;
}

/** The building's flag (DownRight of the building = `bld.flag`). */
function getFlag(state: GameState, bld: Building) {
  return state.flags[bld.flag];
}

/**
 * 04 EnteringBuilding — the serf walks from the flag into the building
 * (`serf_state_04_EnteringBuilding @0x2301e`). Tick prologue; **arrived inside** when the counter
 * underflows OR `counter <= field_0xc` (the interior path length set by `stepInToBuilding`). Then, for a
 * valid non-burning building, `counter = field_0xc` and the **type-dependent handover**
 * (`FUN_00023107[serf.type * 8]` -> jump table @0x23107):
 *
 * - `field_0xb == -2` (for almost every type): `enter_inventory` -> IdleInStock (return to the stock).
 * - otherwise, per serf type, a switch into the work state with the first-entry setup
 * (`field_0xb != 0`): activate the building (miner), initial stock (pig farmer), flag bytes.
 *
 * A burning or invalid building -> **Lost (25)**.
 */
HANDLERS[4] = (state, serf) => {
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const old = serf.counter;
  serf.counter = subU16(old, delta);
  const underflow = delta > old;
  const fieldC = unionU16(serf, 0xc);
  if (!underflow && i16(fieldC) - i16(serf.counter) < 0) return; // still walking inwards
  if (serf.col === null || serf.row === null) return;
  const bldTile = posOf(serf.col, serf.row, state.geo);
  const bldIdx = state.mapTiles[bldTile].objIndex;
  const bld = bldIdx !== 0 ? state.buildings[bldIdx] : null;
  if (!bld || bld.burning) {
 // Invalid or burning building -> Lost.
    serf.state = 25;
    setUnionU8(serf, 0xb, 0);
    serf.counter = 0;
    return;
  }
  serf.counter = fieldC; // counter = field_0xc before the type handover
  enteringBuildingDispatch(state, serf, bldTile, bld);
};

/**
 * Type dispatch of the EnteringBuilding handover — the 22 handlers of the jump table `@0x23107` (stride
 * 8). `fieldB` = `field_0xb`: `-2` = return to the stock, `!= 0` = first entry (building/flag setup),
 * `0` = re-entry (a field worker coming back).
 */
function enteringBuildingDispatch(state: GameState, serf: Serf, bldTile: number, bld: Building): void {
  const fieldB = i8(unionU8(serf, 0xb));
  const firstTime = fieldB !== 0; // -2 is handled separately per branch above

  switch (serf.type) {
    case ST_TRANSPORTER:
 // The carrier becomes the flag's inventory carrier (FUN_0002325f).
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      firstTimeStockFlag(getFlag(state, bld), 0xc0, 0x80); // the flag accepts serfs and resources
      serf.state = 12; // WaitForResourceOut
      serf.counter = 0x3f;
      setSerfType(serf, ST_TRANSPORTER_INV);
      return;

    case ST_SAILOR: // FUN_000233b9 — always enter_inventory
      return enterInventory(state, serf, bldTile, bld);

    case ST_DIGGER: // FUN_00023450 — level the ground, target handler 08 Digging
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      serf.state = 8; // Digging
      setUnionU8(serf, 0xb, 0xf); // h_index = 15
      setUnionU8(serf, 0xc, (bld.level ?? 0) & 0xff); // target_h = building.level
      setUnionU8(serf, 0xd, 6); // dig_pos = 6
      setUnionU8(serf, 0xe, 1); // substate = 1
      return; // NO map serf clear (the digger stays visible)

    case ST_BUILDER: // FUN_000234d3
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      serf.state = 9; // Building
      serf.animation = 98; // 0x62
      serf.counter = 0x7f;
      setUnionU8(serf, 0xb, 1); // mode = 1
      setUnionU16(serf, 0xc, state.mapTiles[bldTile].objIndex); // bld_index
      setUnionU8(serf, 0xe, 0); // material_step = 0
      if (BUILDER_TWO_PHASE.has(bld.type)) {
        setUnionU8(serf, 0xe, 0x80); // material_step |= BIT(7)
        serf.animation = 100; // 0x64
      }
      return; // NO map serf clear

    case ST_TRANSPORTER_INV: // FUN_0002359d — always -> WaitForResourceOut
      state.mapTiles[bldTile].serfIndex = 0;
      serf.state = 12;
      serf.counter = 0x3f;
      return;

    case ST_LUMBERJACK: // FUN_000235c8 → PlanningLogging
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      serf.state = 18;
      return;

    case ST_SAWMILLER: // FUN_000235f4 → Sawing
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      if (firstTime) firstTimeStockFlag(getFlag(state, bld), 0x00, 0x20, undefined, 0x00);
      serf.state = 24;
      setUnionU8(serf, 0xb, 0); // sawing.mode = 0
      return;

    case ST_STONECUTTER: // FUN_00023690 → PlanningStoneCutting
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      serf.state = 21;
      return;

    case ST_FORESTER: // FUN_000236bc → PlanningPlanting
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      serf.state = 19;
      return;

    case ST_MINER: // FUN_00024193 → Mining
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
 // Stone mine -> player hint flag (player+0x163 |= 0x20): not modelled, a no-op here.
      if (firstTime) {
        bld.active = true; // bld[5] |= 0x10 (start_activity)
        bld.playingSfx = false; // bld[5] &= 0xf7 (stop_playing_sfx)
        firstTimeStockFlag(getFlag(state, bld), 0x01, 0x00, 0x00);
      }
      serf.state = 29;
      setUnionU8(serf, 0xb, 0); // mining.substate = 0
      setUnionU8(serf, 0xc, 0); // mining.res = 0
      setUnionU8(serf, 0xd, 0);
      setUnionU8(serf, 0xe, MINE_DEPOSIT[bld.type - BUILDING_TYPE_STONE_MINE] ?? 0); // deposit
      return;

    case ST_SMELTER: // FUN_000236e8 → Smelting
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
 // Steel (SteelSmelter -> smelting.type 0) versus gold (-> -1). Byte 4 & 0xfc == 0x48.
      setUnionU8(serf, 0xd, bld.type === BUILDING_TYPE_STEEL_SMELTER ? 0 : 0xff);
      if (firstTime) {
        const b68 = bld.type === BUILDING_TYPE_STEEL_SMELTER ? 0x02 : 0x01;
        firstTimeStockFlag(getFlag(state, bld), 0x04, b68, 0x00, 0x00);
      }
      serf.state = 30;
      setUnionU8(serf, 0xb, 0); // smelting.mode = 0
      return;

    case ST_FISHER: // FUN_00023800 → PlanningFishing
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      serf.state = 31;
      return;

    case ST_PIGFARMER: // FUN_0002382c → PigFarming
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      if (firstTime) {
        setByte9(bld, 1); // set_initial_res_in_stock(1, 1) — one initial pig
        firstTimeStockFlag(getFlag(state, bld), 0x10, 0x00, 0x00);
        serf.state = 37;
        setUnionU8(serf, 0xb, 0); // pigfarming.mode = 0
      } else {
        serf.state = 37;
        setUnionU8(serf, 0xb, 6); // pigfarming.mode = 6
        serf.counter = 0;
      }
      return;

    case ST_BUTCHER: // FUN_00023928 → Butchering
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      if (firstTime) firstTimeStockFlag(getFlag(state, bld), 0x08, 0x00, 0x00);
      serf.state = 38;
      setUnionU8(serf, 0xb, 0);
      return;

    case ST_FARMER: // FUN_000239c4 → PlanningFarming
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      serf.state = 33;
      return;

    case ST_MILLER: // FUN_000239f0 → Milling
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      if (firstTime) firstTimeStockFlag(getFlag(state, bld), 0x10, 0x00, 0x00);
      serf.state = 35;
      setUnionU8(serf, 0xb, 0);
      return;

    case ST_BAKER: // FUN_00023a8c → Baking
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      if (firstTime) firstTimeStockFlag(getFlag(state, bld), 0x20, 0x00, 0x00);
      serf.state = 36;
      setUnionU8(serf, 0xb, 0);
      return;

    case ST_BOATBUILDER: // FUN_00023b28 → BuildingBoat
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      if (firstTime) firstTimeStockFlag(getFlag(state, bld), 0x02, 0x00, 0x00);
      serf.state = 41;
      setUnionU8(serf, 0xb, 0);
      return;

    case ST_TOOLMAKER: // FUN_00023bc4 → MakingTool
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      if (firstTime) firstTimeStockFlag(getFlag(state, bld), 0x02, 0x04, 0x00, 0x00);
      serf.state = 40;
      setUnionU8(serf, 0xb, 0);
      return;

    case ST_WEAPONSMITH: // FUN_00023cb0 → MakingWeapon
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      state.mapTiles[bldTile].serfIndex = 0;
      if (firstTime) firstTimeStockFlag(getFlag(state, bld), 0x04, 0x04, 0x00, 0x00);
      serf.state = 39;
      setUnionU8(serf, 0xb, 0);
      return;

    case ST_GEOLOGIST: // FUN_000232f2
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld);
      serf.state = 42; // LookingForGeoSpot (the original says this should never be reached)
      serf.counter = 0;
      return; // NO map serf clear

    case ST_GENERIC: {
 // FUN_00023312 — no -2 branch: always enter_inventory plus genericCount++ (serf_come_back).
      state.mapTiles[bldTile].serfIndex = 0;
      const inv = bld.inventoryIndex !== null ? state.inventories[bld.inventoryIndex] : null;
      if (inv) inv.genericCount += 1; // inv[0x40] += 1
      setUnionU16(serf, 0xe, bld.inventoryIndex ?? 0);
      setUnionU16(serf, 0xc, 0);
      serf.state = 1; // IdleInStock
      setUnionU8(serf, 0xb, 0);
      return;
    }

    default:
 // Knights (types 22..26) -> the military garrison entry (serf_state_04 case 0xc95 @0x2301e).
      if (serf.type < 22 || serf.type > 26) return; // non-knights without a handler (digger etc.)
      if (fieldB === -2) return enterInventory(state, serf, bldTile, bld); // return to the stock
      knightGarrisonEnter(state, serf, bldTile, bld);
      return;
  }
}

/**
 * Knight garrison entry — the knight branch (case 0xc95) of
 * `serf_state_04_EnteringBuilding @0x2301e`:
 * - **The knight vanishes from the map**: `game[serfPos].serf = 0`. The serf still carries `pos` on the
 * building tile, but the tile no longer points at him, and the drawing hangs on exactly that. It holds
 * in **every** real save: of 70 defenders in `SAVE0.DS`, **none** stands on a tile pointing at him.
 * - Insert the knight at the head of the garrison list: `serf[0xe] = building.firstKnight` (the old
 * head), `building.firstKnight = serf.index`.
 * - **Castle / inventory building** (`building+8 == 0xff`, `hasInventory`): -> DefendingCastle (75),
 * `counter=6000`. OPEN: `player+0x18c++` (the castle knight counter) is not modelled.
 * - **Hut/Tower/Fortress**: garrison count `building+8 += 0x0f` (nibble byte), state by type
 * (hut -> 70 / tower -> 71 / fortress -> 72), `counter=6000`. On **first occupation** (`!active`):
 * `active=true` **and** a territory recolour.
 *
 * The original sequence is linear, with no branch in between (no `call`/`j*` between @0x23f67 and
 * @0x240a4):
 *
 * 1. `bts $0x4,bld[5]` @0x23ef4 — activate (only if inactive before, `bt` @0x23edc).
 * 2. **Message 6 "military building occupied"** @0x23f62, parameter = the building class from
 * `bld[4] & 0x7c` (`cmpw $0x2c` = hut => 0, `cmpw $0x54` = tower => 1, otherwise fortress => 2),
 * position and owner from the **building** (`bld[0]`, `bld[4] & 3`).
 * 3. The flag accept bytes (flag+0x42/0x44/0x45).
 * 4. A score **snapshot** of all four players @0x240b0/@0x240c2, then the recolour, then
 * `notifyTerritoryLosers` (x4) — message 8/9 to everyone who lost land or buildings by it.
 */
function knightGarrisonEnter(state: GameState, serf: Serf, bldTile: number, bld: Building): void {
  state.mapTiles[bldTile].serfIndex = 0; // the knight is inside -> the tile releases him
 // Insert at the head of the garrison list.
  setUnionU16(serf, 0xe, bld.firstKnight);
  bld.firstKnight = serf.index;

  if (bld.hasInventory) {
 // OPEN: player+0x18c++ (castle knight counter) is not modelled.
    serf.state = 75;
    serf.counter = 6000;
    return;
  }

 // Garrison count: building+8 += 0x0f (nibble byte available<<4|requested).
  const s0 = bld.stock[0];
  const raw = (((s0.available & 0xf) << 4) | (s0.requested & 0xf)) + 0x0f;
  bld.stock[0] = { available: (raw >> 4) & 0xf, requested: raw & 0xf };

  serf.state = bld.type === 11 ? 70 : bld.type === 21 ? 71 : 72; // hut / tower / fortress
  serf.counter = 6000;

  if (!bld.active) {
    bld.active = true; // bld[5] |= 0x10 (start_activity) @0x23ef4
    if (bld.col !== null && bld.row !== null) {
      const bldPos = posOf(bld.col, bld.row, state.geo);
 // Message 6 "military building occupied" (@0x23f62) — class from the building type.
      const owner = state.players[bld.owner & 3];
      if (owner) {
        const cls = bld.type === 11 ? 0 : bld.type === 21 ? 1 : 2; // hut / tower / fortress
        addPlayerMessage(owner, MSG_BUILDING_OCCUPIED + (cls << 5), bldPos);
      }
 // Flag accept bytes @0x23fc4..@0x23fd9 — the **gold** demand of the military building:
 //   mov $0x0,%al ; mov %al,0x42(%ebx)   ; no serf acceptance, no slot 0 demand
 //   mov $0x8,%al ; mov %al,0x44(%ebx)   ; bit 3 == GoldBar (DEMAND_TABLE[14])
 //   xor %al,%al  ; mov %al,0x45(%ebx)   ; priority off, `militaryGoldDemand` sets it anew
 // Without these three the flag keeps the construction mask `0x10` (== bit 4 == **stone**), and as
 // soon as `militaryGoldDemand` raises the priority the scheduler sends stone instead of gold bars —
 // booked into the gold nibble of the finished building.
      const gflag = state.flags[bld.flag];
      if (gflag) {
        setFlagAcceptByte(gflag, 0x42, 0x00);
        setFlagAcceptByte(gflag, 0x44, 0x08);
        gflag.stockPriority[1] = 0;
      }
 // Snapshot -> recolour -> who lost? (@0x240b0..@0x2417f)
      const before = snapshotTerritoryScores(state);
      recomputeTerritory(state, bld.col, bld.row);
      const serfPos = serf.col !== null && serf.row !== null ? posOf(serf.col, serf.row, state.geo) : bldPos;
      notifyTerritoryLosers(state, before, serf.owner, serfPos);
    }
  }
}

/**
 * 14 Delivering — the return state after "resource at the target building"
 * (`serf_state_14_Delivering @0x22b9d`). Tick gate, then the shared `transportBody` entering at the
 * delivery loop: it drops the carried resource into the building (UpLeft) and returns to the flag via
 * the `field_0xf` leg toggle (-> state 3).
 */
HANDLERS[14] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  transportBody(state, serf, true);
};

/**
 * 16 FreeWalking — movement across terrain away from the roads (`serf_state_16_FreeWalking @0x1d2eb`),
 * the shared walking logic of every field worker (geologist, fisher, lumberjack, forester, stonecutter,
 * farmer). Tick gate, then `freeWalkingBody`. Tables in `serf-free-walking.ts`.
 */
HANDLERS[16] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  freeWalkingBody(state, serf);
};

// 42 LookingForGeoSpot / 43 SamplingGeoSpot — geologist-specific (serf-geologist.ts).
// 42 has NO tick gate (it runs at once), 43 pulls its own tick prologue.
HANDLERS[42] = lookingForGeoSpot;
HANDLERS[43] = samplingGeoSpot;

// 45/47/48/49/50/51 the duel path of the attack chain (serf-military.ts); 44 engage + 52 occupation follow.
HANDLERS[45] = knightPrepareAttacking;
HANDLERS[47] = knightPrepareDefending;
HANDLERS[48] = knightAttacking;
HANDLERS[49] = knightDefending;
HANDLERS[50] = knightAttackingVictory;
HANDLERS[51] = knightAttackingDefeat;
HANDLERS[44] = knightEngagingBuilding;
HANDLERS[52] = knightOccupyEnemyBuilding;
// Open-field fight: 60/61 reuse 48/49 (the `isFree` branch resolves into 62/63).
HANDLERS[60] = knightAttacking; // KnightAttackingFree
HANDLERS[61] = knightDefending; // KnightDefendingFree (no-op, driven by the attacker)
HANDLERS[62] = knightAttackingVictoryFree;
HANDLERS[63] = knightDefendingVictoryFree;
HANDLERS[64] = knightAttackingFreeWait;
// Open-field engage chain: scan/engage (53) plus handshake (54..59).
HANDLERS[53] = knightFreeWalking;
HANDLERS[54] = knightEngageDefendingFree;
HANDLERS[55] = knightEngageAttackingFree;
HANDLERS[56] = knightEngageAttackingFreeJoin;
HANDLERS[57] = knightPrepareAttackingFree;
HANDLERS[58] = knightPrepareDefendingFree;
HANDLERS[59] = knightPrepareDefendingFreeWait;

// 46 KnightLeaveForFight — the DEFENDER leaving for the fight (serf-military.ts). No tick gate;
// blocked means no effect (no wait animation), and the target tile is not occupied.
HANDLERS[46] = knightLeaveForFight;

// 65 KnightLeaveForWalkToFight — the dispatched attacker leaving (serf-military.ts). No tick gate:
// the original reads `serf[4]` right away and retries the exit every tick.
HANDLERS[65] = knightLeaveForWalkToFight;

// 70/71/72/75 the defending garrison (knight guard idle, serf-military.ts). Rank 4 is a no-op (frozen).
HANDLERS[70] = defendingHut;
HANDLERS[71] = defendingTower;
HANDLERS[72] = defendingFortress;
HANDLERS[75] = defendingCastle;

// 22 StoneCutterFreeWalking — the stonecutter's terrain walk variant (serf-free-walking.ts).
HANDLERS[22] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  stoneCutterFreeWalkingBody(state, serf);
};

// ==== 08 Digging — the digger levels the building site ====
//
// `serf_state_08_Digging` (@0x24b11). The digger levels the 7 hex tiles around the site (the tile plus
// its 6 neighbours) to `target_h` (= `building.level`): he looks for a tile whose height is exactly
// `target_h + h_diff[h_index]`, walks there, raises or lowers it by 1 towards the target, returns to the
// centre and works `h_index` down from 15 (target offset +-8 ... +-1). Once `h_index` is exhausted the
// site is level (`done_leveling`) and the digger leaves the building.
//
// State union: h_index=0xb (i8, 15 -> -1), target_h=0xc (u8, 0..31), dig_pos=0xd (i8, 6 -> 0),
// substate=0xe (i8). The handler is a `while(counter<0)` loop decrementing substate per iteration:
// < 0 = walk to the tile (wait for serf), 0 = look for a new tile, 1 = change the height and return to
// the centre, > 1 = dig.
//
// **Two spots where the obvious reading is wrong:**
// 1. On an occupied target tile the wait-for-serf branch does **only** `counter=127; substate=0; return`
//    — there is **no** serf swap (`@0x24cb3`).
// 2. If the search hits a matching but **occupied** neighbour spot -> `counter = 127` (not
//    `counter_from_animation[anim]`; `@0x24e7e`), `animation = 87 - dig_pos`.
//
// Tables extracted byte-exact from the binary:
// - `DIG_H_DIFF` (@0x2526d) — target height offset per h_index 0..15.
// - `DIG_ANIM_OUT` (@0x25266) — walk anim offset to the dig spot, per dig_pos:
//   `anim = dHeight + tab[dig_pos]` (= `4 + 9*(6-dig_pos)` for dig_pos >= 1; dig_pos 0 = the raw height
//   delta -> vertical climb anim 0..15). Equals `start_walking(6-dig_pos, 32, 1)`, since
//   `(32*cfa)>>5 == cfa`.
// - `DIG_ANIM_BACK` (@0x2525f) — return anim offset to the centre after the height change, per dig_pos:
//   `anim = dHeight + tab[dig_pos]` (= `4 + 9*reverse(6-dig_pos)`).
const DIG_H_DIFF = [-1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8];
const DIG_ANIM_OUT = [0, 49, 40, 31, 22, 13, 4];
const DIG_ANIM_BACK = [0, 22, 13, 4, 49, 40, 31];

const DIG_H_INDEX = 0xb;
const DIG_TARGET_H = 0xc;
const DIG_POS = 0xd;
const DIG_SUBSTATE = 0xe;

/**
 * Site levelled -> `Building::done_leveling` (`progress=1`, `holder=false`, `firstKnight=0`) plus the serf
 * into ReadyToLeave (`field_B=-2`, `dest=0`, `dir=0`, `next_state=Walking`) and leave at once. The
 * original calls `handle_serf_ready_to_leave` inline (`@0x24d02`); mirrored here via `stepOutToFlag`.
 */
function digDoneLeveling(state: GameState, serf: Serf, pos: number): void {
  const bld = state.buildings[state.mapTiles[pos].objIndex];
  if (bld) {
    bld.progress = 1;
    bld.holder = false;
    bld.firstKnight = 0;
  }
  setUnionU8(serf, 0xb, 0xfe); // field_B = -2
  setUnionU16(serf, 0xc, 0); // dest = 0
  setUnionU8(serf, 0xe, 0); // dir = 0
  setUnionU8(serf, 0xf, 2); // next_state = Walking
  serf.state = 7; // ReadyToLeave
  stepOutToFlag(state, serf);
}

/** One movement/animation step (move the serf tile, set the anim, charge the counter). */
function digMove(state: GameState, serf: Serf, pos: number, np: number, anim: number): boolean {
  const geo = state.geo;
  state.mapTiles[pos].serfIndex = 0;
  state.mapTiles[np].serfIndex = serf.index;
  serf.col = colOf(np, geo);
  serf.row = rowOf(np, geo);
  serf.animation = anim & 0xff;
  return addCounter(serf, cfa(anim & 0xff)); // true -> u16 overflow, tick done
}

/**
 * Search for the next tile to level (`serf_state_08` "looking for place", `@0x24ce0`). Iterates `dig_pos`
 * 6 -> 0 (then `h_index`-1, `dig_pos`=6) until a tile with a matching target height is found. Returns
 * `'return'` (tick done / handler leaves) or `'continue'` (carry on in the main loop).
 */
function digLookForSpot(state: GameState, serf: Serf, pos: number): 'return' | 'continue' {
  const geo = state.geo;
  let digPos = i8(unionU8(serf, DIG_POS)) - 1; // 0x24ce0: dig_pos -= 1
  let hIndex = i8(unionU8(serf, DIG_H_INDEX));
  const targetH = unionU8(serf, DIG_TARGET_H);
  for (;;) {
 // Find a valid target height for (dig_pos, h_index) (0x24ced/0x251fd do-while).
    let h = 0;
    for (;;) {
      if (digPos < 0) {
        digPos = 6;
        hIndex -= 1;
        if (hIndex < 0) {
          setUnionU8(serf, DIG_POS, digPos);
          setUnionU8(serf, DIG_H_INDEX, hIndex);
          digDoneLeveling(state, serf, pos);
          return 'return';
        }
      }
      h = targetH + DIG_H_DIFF[hIndex];
      if (h >= 0 && h < 32) break;
      digPos = -1; // h invalid -> next h_index (reset dig_pos)
    }
 // Check the map height at dig_pos (jump table 3).
    const commit = (): void => {
      setUnionU8(serf, DIG_POS, digPos);
      setUnionU8(serf, DIG_H_INDEX, hIndex);
    };
    if (digPos === 0) {
      if (state.mapTiles[pos].height !== h) {
        digPos -= 1; // 0x24ce0: miss -> keep searching
        continue;
      }
      commit();
      setUnionU8(serf, DIG_SUBSTATE, 2); // dig here
      serf.animation = hIndex & 1 ? 87 : 88;
      return addCounter(serf, 383) ? 'return' : 'continue';
    }
    const dir = 6 - digPos;
    const np = neighbor(pos, dir, geo);
    if (state.mapTiles[np].height !== h) {
      digPos -= 1;
      continue;
    }
    if (state.mapTiles[np].serfIndex !== 0) {
 // Spot matches but is occupied -> wait (counter=127, not cfa[anim]).
      commit();
      setUnionU8(serf, DIG_SUBSTATE, 0);
      serf.animation = (87 - digPos) & 0xff;
      serf.counter = 127;
      return 'return';
    }
    commit();
    setUnionU8(serf, DIG_SUBSTATE, 3);
    const anim = state.mapTiles[np].height - state.mapTiles[pos].height + DIG_ANIM_OUT[digPos];
    return digMove(state, serf, pos, np, anim) ? 'return' : 'continue';
  }
}

/** 08 Digging — the handler body (`while(counter<0)` loop). */
HANDLERS[8] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  for (;;) {
    const substate = i8(unionU8(serf, DIG_SUBSTATE)) - 1;
    setUnionU8(serf, DIG_SUBSTATE, substate);
    const pos = posOf(serf.col, serf.row, geo);
    if (substate < 0) {
 // wait for serf: walk to the (neighbour) tile; occupied -> wait (NO swap).
      const digPos = i8(unionU8(serf, DIG_POS));
      const dir = digPos === 0 ? Direction.Up : 6 - digPos;
      const np = neighbor(pos, dir, geo);
      if (state.mapTiles[np].serfIndex !== 0) {
        serf.counter = 127;
        setUnionU8(serf, DIG_SUBSTATE, 0);
        return;
      }
      setUnionU8(serf, DIG_SUBSTATE, 3);
      const anim = state.mapTiles[np].height - state.mapTiles[pos].height + DIG_ANIM_OUT[digPos];
      if (digMove(state, serf, pos, np, anim)) return;
      continue;
    }
    if (substate === 0) {
      if (digLookForSpot(state, serf, pos) === 'return') return;
      continue;
    }
    if (substate === 1) {
 // Change the height at the current tile, then return to the centre.
      const hIndex = i8(unionU8(serf, DIG_H_INDEX));
      state.mapTiles[pos].height = (state.mapTiles[pos].height + (hIndex & 1 ? -1 : 1)) & 0x1f;
      const digPos = i8(unionU8(serf, DIG_POS));
      if (digPos === 0) {
        setUnionU8(serf, DIG_SUBSTATE, 1); // centre: stay put (no counter add)
        continue;
      }
      const dir = oppositeDir(6 - digPos);
      const np = neighbor(pos, dir, geo);
      const anim = state.mapTiles[np].height - state.mapTiles[pos].height + DIG_ANIM_BACK[digPos];
      if (digMove(state, serf, pos, np, anim)) return;
      continue;
    }
 // substate > 1: dig
    const hIndex = i8(unionU8(serf, DIG_H_INDEX));
    serf.animation = hIndex & 1 ? 87 : 88;
    if (addCounter(serf, 383)) return;
  }
};


// 06 ReadyToEnter — no tick gate; tries to enter the building at once. Body == stepInToBuilding.
HANDLERS[6] = stepInToBuilding;

// 07 ReadyToLeave — no tick gate; tries to leave for the flag at once. Body == stepOutToFlag.
HANDLERS[7] = stepOutToFlag;

/**
 * `serf_state_74_FinishedBuilding` (@0x246bb) — the **waiting state of the finished builder**: he has put
 * the building up and wants out, but the flag tile is occupied. The handler checks exactly that one
 * condition and **falls through into state 07** when the tile is free (without a jump in the original:
 * the body ends at `mov $0x7,%al ; mov %al,0xa(%ebx)` @0x246e1 right before `serf_state_07 @0x246e9`).
 *
 * Without a handler a builder whose flag tile was occupied at the moment of completion stays in the
 * building forever — the building is finished and the serf drops out of the economy.
 */
export function finishedBuilding(state: GameState, serf: Serf): void {
  if (serf.col === null || serf.row === null) return;
  const flagTile = neighbor(posOf(serf.col, serf.row, state.geo), Direction.DownRight, state.geo);
  if (state.mapTiles[flagTile].serfIndex !== 0) return; // flag tile occupied -> stay in 74
  serf.state = 7; // ReadyToLeave
  stepOutToFlag(state, serf); // fall-through @0x246e9
}

HANDLERS[74] = finishedBuilding;

/**
 * The body of `serf_state_11` (@0x248db): one step to the flag, but **only** if the target flag has at
 * least one free resource slot (the binary tests `flag+0xc..0x13` for `== 0`, i.e. `resourceSlots == -1`).
 * Otherwise blocked (anim `0x52`, counter 0). Also used as the leaving tail of handler 12, where the
 * state has already been set to 11 before the call.
 */
export function moveResourceOutStep(state: GameState, serf: Serf): void {
  if (serf.col === null || serf.row === null) return;
  const flagTile = neighbor(posOf(serf.col, serf.row, state.geo), Direction.DownRight, state.geo);
  const flag = state.flags[state.mapTiles[flagTile].objIndex];
  const hasFreeSlot = flag ? flag.resourceSlots.some((s) => s === -1) : false;
  if (!hasFreeSlot) {
    serf.animation = ANIM_WAIT_OUT;
    serf.counter = 0;
    return;
  }
  stepOutToFlag(state, serf);
}

// 11 MoveResourceOut — carries a resource to the flag (a retry state; no tick gate).
HANDLERS[11] = moveResourceOutStep;

// 12 WaitForResourceOut — a building worker waits inside the inventory until its out queue carries a
// resource, picks it up and leaves with it (`serf_state_12 @0x1f4aa`). Its own tick gate: while
// `counter != 0` it counts down (on expiry `counter = 0`), at `counter == 0` the body runs every tick
// (polling). Body: fetch the inventory of the building on his own tile; only if `serfIndices[4]`
// (u16 @inv+0x4a) == 0 AND `outQueue[0]` is occupied, pick up the resource (`field_0xb` = the **raw**
// queue type = `type+1`, `field_0xc` = dest), advance the queue by one slot, `field_0xf = 13`
// (DropResourceOut as the follow-up state after leaving), `state = 11`, then try the leaving step.
HANDLERS[12] = (state, serf) => {
  if (serf.counter !== 0) {
    const delta = subU16(state.gameTick, serf.tick);
    serf.tick = state.gameTick;
    const old = serf.counter;
    serf.counter = subU16(old, delta);
    if (delta <= old) return; // not elapsed yet -> keep waiting
    serf.counter = 0;
  }
  if (serf.col === null || serf.row === null) return;
  const here = posOf(serf.col, serf.row, state.geo);
  const bld = state.buildings[state.mapTiles[here].objIndex];
  if (!bld || bld.inventoryIndex === null) return;
  const inv = state.inventories[bld.inventoryIndex];
  if (!inv) return;
  if (inv.serfIndices[4] !== 0) return; // inv+0x4a != 0 -> no output right now
  const rawType0 = (inv.outQueue[0].type + 1) & 0xff; // the raw queue byte value (0 == empty)
  if (rawType0 === 0) return; // queue empty
 // Pick up the resource (raw type plus destination) and advance the queue (slot0 <- slot1, clear slot1).
  setUnionU8(serf, 0xb, rawType0);
  setUnionU16(serf, 0xc, inv.outQueue[0].dest);
  inv.outQueue[0].type = inv.outQueue[1].type;
  inv.outQueue[0].dest = inv.outQueue[1].dest;
  inv.outQueue[1].type = -1;
  setUnionU8(serf, 0xf, 0xd); // follow-up state after LeavingBuilding = 13 DropResourceOut
  serf.state = 0xb; // MoveResourceOut (stays if the exit is blocked)
  moveResourceOutStep(state, serf);
};

// 13 DropResourceOut — arrived at the flag: drop the resource into the first free flag slot and step
// back into the building (`serf_state_13 @0x22d5d`). Find the first free slot i in [0..7] (stopping at
// the first `raw==0`; if 0..6 are taken -> i=7). Write the slot (the raw `field_0xb` as a whole byte ->
// `resourceSlots[i]=(b&0x1f)-1`, `slotDir[i]=((b>>5)&7)-1`), `slotDest[i]=field_0xc`,
// `hasResources=true`, `field_0xb=0`, `state=6`, then enter the building (== stepInToBuilding).
HANDLERS[13] = (state, serf) => {
  if (serf.col === null || serf.row === null) return;
  const flagTile = posOf(serf.col, serf.row, state.geo);
  const flag = state.flags[state.mapTiles[flagTile].objIndex];
  if (!flag) return;
  let i = 0;
  while (i < 7 && flag.resourceSlots[i] !== -1) i++;
  const b = unionU8(serf, 0xb);
  flag.resourceSlots[i] = (b & 0x1f) - 1;
  flag.slotDir[i] = ((b >> 5) & 7) - 1;
  flag.slotDest[i] = unionU16(serf, 0xc);
  flag.hasResources = true;
  setUnionU8(serf, 0xb, 0);
  serf.state = 6; // ReadyToEnter
  stepInToBuilding(state, serf);
};

/**
 * Counter update of the additive multi-step processing loops (mining, making tool, pig farming, building
 * boat). Adds `add` (u16) and returns `true` if **no overflow** occurred (the original does
 * `if (CARRY2) return;`, i.e. another loop pass while the counter stays "negative"), `false` otherwise
 * (the counter passed 0, so the loop ends and waits).
 */
export function addCounterContinue(serf: Serf, add: number): boolean {
  const sum = serf.counter + add;
  serf.counter = sum & 0xffff;
  return sum <= 0xffff; // no carry -> dispatch again
}

/** Byte 9 of the building record as a **full counter** (boat build step / pig count) — both use byte 9 as
 * a 0..15 counter with the high nibble 0. Reconstructed from the two stock nibbles. */
export function rawByte9(bld: Building): number {
  return ((bld.stock[1].available << 4) | bld.stock[1].requested) & 0xff;
}
export function setByte9(bld: Building, v: number): void {
  bld.stock[1].available = (v >> 4) & 0xf;
  bld.stock[1].requested = v & 0xf;
}

// In-building production plus mining (handler bodies in `serf-production.ts`; only the wiring here).
// 24 Sawing · 38 Butchering · 36 Baking · 35 Milling · 30 Smelting · 39 MakingWeapon ·
// 40 MakingTool · 37 PigFarming · 41 BuildingBoat · 29 Mining.
HANDLERS[24] = sawing;
HANDLERS[38] = butchering;
HANDLERS[36] = baking;
HANDLERS[35] = milling;
HANDLERS[30] = smelting;
HANDLERS[39] = makingWeapon;
HANDLERS[40] = makingTool;
HANDLERS[37] = pigFarming;
HANDLERS[41] = buildingBoat;
HANDLERS[29] = mining;

// Field work plus the planning searches (handler bodies in `serf-field-work.ts`; only the wiring here).
HANDLERS[18] = planningLogging;
HANDLERS[19] = planningPlanting;
HANDLERS[21] = planningStoneCutting;
HANDLERS[31] = planningFishing;
HANDLERS[33] = planningFarming;
HANDLERS[17] = logging;
HANDLERS[20] = planting;
HANDLERS[32] = fishing;
HANDLERS[34] = farming;
HANDLERS[23] = stoneCutting;

// 15 ReadyToLeaveInventory — a serf leaves his inventory (castle/warehouse) for the flag
// (`serf_state_15 @0x243fd`). Preconditions: his own tile free (`serfIndex==0`, the serf is still inside
// the inventory) AND the flag tile (DownRight) free. Special case `field_0xb == 0xff` (-1): if the
// destination (`field_0xc`, a flag index) carries a building whose tile is occupied -> blocked.
// Otherwise: book the inventory (`field_0xe`, u16) with `serfIndices[4]-=1`, low byte of `field_0xe` = 0,
// `field_0xf = 0x49` if `field_0xb == 0xfd` else 2, then leave DownRight -> state 5 (counter formula as
// in stepOutToFlag).
HANDLERS[15] = (state, serf) => {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const here = posOf(serf.col, serf.row, geo);
  const flagTile = neighbor(here, Direction.DownRight, geo);
  const blocked = () => {
    serf.animation = ANIM_WAIT_OUT;
    serf.counter = 0;
  };
  if (state.mapTiles[here].serfIndex !== 0 || state.mapTiles[flagTile].serfIndex !== 0) {
    blocked();
    return;
  }
  if (unionU8(serf, 0xb) === 0xff) {
    const destFlag = state.flags[unionU16(serf, 0xc)];
    if (destFlag && destFlag.hasBuilding) {
      const conn = destFlag.connections[Direction.UpLeft];
      if (conn && conn.kind === 'building') {
        const b = state.buildings[conn.index];
        if (b && b.col !== null && b.row !== null) {
          if (state.mapTiles[posOf(b.col, b.row, geo)].serfIndex !== 0) {
            blocked();
            return;
          }
        }
      }
    }
  }
  const inv = state.inventories[unionU16(serf, 0xe)];
  if (inv) inv.serfIndices[4] = subU16(inv.serfIndices[4], 1);
  setUnionU8(serf, 0xe, 0); // only the low byte of field_0xe (the binary writes undefined1)
  setUnionU8(serf, 0xf, unionU8(serf, 0xb) === 0xfd ? 0x49 : 2);
 // Leave DownRight (the preconditions are already checked above).
  state.mapTiles[here].serfIndex = 0;
  state.mapTiles[flagTile].serfIndex = serf.index;
  serf.col = colOf(flagTile, geo);
  serf.row = rowOf(flagTile, geo);
  const anim = state.mapTiles[flagTile].height - state.mapTiles[here].height + 0xd;
  serf.animation = anim & 0xff;
  const base = COUNTER_FROM_ANIMATION[anim] ?? 0;
  const bld = state.buildings[state.mapTiles[here].objIndex]; // the building on the (old) inventory tile
  const slope = ROAD_BUILDING_SLOPE[slopeIndex(bld?.type ?? 0, bld?.constructing ?? false)];
  serf.counter = ((base * (0x1f ^ slope)) >> 5) & 0xffff;
  serf.tick = state.gameTick;
  serf.state = 5; // LeavingBuilding
};

// ---- 09 Building — raise the structure until it is finished (serf_state_09_Building @0x25335) ----

/** Wait/work setup before requesting material (LAB_0002537d): mode 1, anim by the leg toggle. */
function buildRequestSetup(serf: Serf): void {
  setUnionU8(serf, 0xb, 1);
  serf.animation = i8(unionU8(serf, 0xe)) < 0 ? 100 : 0x62;
}

/**
 * Consume one building material from the building's stock (the material branch of serf_state_09). Which
 * material the current step needs is given by the bit mask `BUILD_MATERIAL_NEED` (bit `field_0xe & 0xf`:
 * 0 = plank / stock slot 0, 1 = stone / stock slot 1). If the slot is empty the serf goes into the
 * **wait branch** (LAB_000254b4: counter up by `0x100`, clamped to `0xff` where applicable) and the
 * handler ends (`'wait'`). Otherwise: book off 1 unit plus 1 stockMaximum, `field_0xe++`,
 * `field_0xf = 8` (8 work iterations), mode `0xff` (working) -> `'consumed'`.
 */
function consumeBuildMaterial(state: GameState, serf: Serf): 'consumed' | 'wait' {
  const bld = state.buildings[unionU16(serf, 0xc)];
  if (!bld) return 'consumed';
  const need = BUILD_MATERIAL_NEED[bld.type] ?? 0;
  const matStep = unionU8(serf, 0xe) & 0xf;
  const k = ((need >> matStep) & 1) === 0 ? 0 : 1; // 0 = plank (bld+8), 1 = stone (bld+9)
  if (bld.stock[k].available === 0) {
 // LAB_000254b4 — material missing: poll slowly.
    const old = serf.counter;
    serf.counter = (old + 0x100) & 0xffff;
    if (old < 0xff00) serf.counter = 0xff;
    return 'wait';
  }
  bld.stock[k] = { available: bld.stock[k].available - 1, requested: bld.stock[k].requested };
  if (bld.stockMaximum) bld.stockMaximum[k] = (bld.stockMaximum[k] - 1) & 0xff;
  setUnionU8(serf, 0xe, unionU8(serf, 0xe) + 1);
  setUnionU8(serf, 0xf, 8);
  setUnionU8(serf, 0xb, 0xff); // mode "working" (i8 < 0)
  return 'consumed';
}

/**
 * Completing a building (the build progress overflowed), from serf_state_09 @0x25335: `progress=0`,
 * clear `holder`/`firstKnight`, **clear `constructing`** (bld[4] bit 7); reset the building flag's accept
 * bytes; update the player's build score and building counters; the builder leaves for the flag
 * (state 74 -> 7 -> stepOutToFlag).
 *
 * **The union value `bld+0xe` changes meaning here** — from the site's levelling height to the finished
 * building's **flag pointer**:
 *
 * ```
 * 25606 mov 0x6(%ebx),%ax     ; ax = bld[6] = flag index
 * 2560d mov $0x46,%ax -> cx   ; 0x46 == 70 == flag record size
 * 25617 mul %cx               ; index * 70
 * 25628 mov 0x98(%ebx),%eax   ; gs+0x98 == base of the flag array
 * 2562e add %eax,(%edi)
 * 25635 mov %eax,0xe(%ebx)    ; bld+0xe = &flag[index], right before the 0x2c/0x54/0x58 gate
 * ```
 *
 * In the save the address stands **base-relative**, so `flagIndex * 70`, and that holds without
 * exception across every finished building of original saves. Omitting the store is visible: a `.DS`
 * written by us then carries the **levelling height** there, and the original reads it as a flag pointer
 * (`militaryGoldDemand` @0x1590c).
 *
 * Not covered here:
 * - `inventoryIndex` stays untouched (null while under construction).
 * - Military buildings (hut/tower/fortress) get their **threat level** on completion
 * ({@link updateThreatLevel}, `FUN_00046abd`, gated on `bld[4]&0x7c` in `{0x2c,0x54,0x58}`) — the only
 * direct call in the whole binary besides founding the castle. The building only claims land on
 * **occupation** (where `knightGarrisonEnter` triggers the territory recolour).
 */
/** `mov $0x46,%ax` @0x2560d — the size of a flag record; the union pointer is `index * 70`. */
const FLAG_RECORD_SIZE = 70;

function completeBuilding(state: GameState, serf: Serf, bld: Building): void {
  bld.progress = 0;
  bld.holder = false; // bld[5] &= 0xbf
  bld.firstKnight = 0; // bld[10] = 0
  bld.constructing = false; // bld[4] &= 0x7f
 // `mov %eax,0xe(%ebx)` @0x25635 — from here the union carries the flag pointer (base-relative
 // `flagIndex * 70`), no longer the levelling height.
  bld.level = (bld.flag * FLAG_RECORD_SIZE) & 0xffff;
  if (bld.type === 11 || bld.type === 21 || bld.type === 22) updateThreatLevel(state, bld);
  const flag = state.flags[bld.flag];
 // The WHOLE byte, not just bit 7 (@0x256ce/@0x256d6 `xor %al,%al ; mov %al,0x42|0x44(%ebx)`) — the
 // bit takes the site's demand MASK with it (`0x2` plank / `0x10` stone). Left standing, the finished
 // building keeps asking for material. See `flag-accept.ts`.
  if (flag) clearFlagAcceptBytes(flag);
  const player = state.players[bld.owner];
  if (player) {
    player.totalBuildingScore += BUILDING_SCORE[bld.type] ?? 0; // player+0x116
    const j = bld.type - 1; // array index j <-> type j+1 (castle = 24 builds through state 10)
    if (j >= 0 && j < player.incompleteBuildingCount.length) {
      (player.incompleteBuildingCount as number[])[j] -= 1;
      (player.completedBuildingCount as number[])[j] += 1;
    }
  }
 // The serf leaves for the flag: remember follow-up state 2 (Walking), set state 74 and jump into its
 // handler (`jmp 0x246bb` @0x25768). If the flag tile is occupied he stays in 74 and retries next pass
 // — that is what {@link finishedBuilding} exists for.
  setUnionU16(serf, 0xc, 0);
  setUnionU8(serf, 0xb, 0xfe);
  setUnionU8(serf, 0xe, 0);
  setUnionU8(serf, 0xf, 2);
  serf.counter = 0;
  serf.state = 74; // 0x4a
  finishedBuilding(state, serf);
}

/**
 * `serf_state_10_BuildingCastle` (@0x2582d) — the **castle** builds itself unlike any other building: no
 * material, no per-stage site progress, just a time counter. The castle builder created at the founding
 * (type 4, `create_founding_serfs` @0x295e6) sits in the castle and adds `(gameTick - serf.tick) << 7`
 * to `building.progress` per pass; the **u16 overflow** is the end of construction
 * (`add %ax,0xc(%ebx) ; jae` @0x258c7 — only the carry branches off).
 *
 * He finds the castle not through a building reference but through his **inventory**: `serf[0xc]` (u16)
 * is the inventory index, `inventory.building` the castle. That is a different union slot from
 * `IdleInStock` (which uses `serf[0xe]`) — both from `create_founding_serfs` (`mov %ax,0xc(%ebx)` with
 * `player+0x108` == `castleInventory`).
 *
 * On completion: state -> **12 WaitForResourceOut** (the builder becomes the castle's stock
 * transporter), his tile is released, `constructing` cleared (`andb $0x7f,0x4`) and `firstKnight` zeroed
 * (`bld[0xa] = 0`). **No** build score and **no** building counter, unlike {@link completeBuilding} — the
 * castle has counted since the founding.
 *
 * No tick gate: the handler uses `serf.tick` as a timestamp, not as a counter.
 */
HANDLERS[10] = (state, serf) => {
  const now = state.gameTick & 0xffff;
  const delta = subU16(now, serf.tick);
  serf.tick = now;
  const inv = state.inventories[unionU16(serf, 0xc)];
  if (!inv) return;
  const bld = state.buildings[inv.building];
  if (!bld) return;
  const sum = (bld.progress & 0xffff) + ((delta << 7) & 0xffff);
  bld.progress = sum & 0xffff;
  if (sum <= 0xffff) return; // no carry -> keep building
  serf.state = 12; // WaitForResourceOut
  if (serf.col !== null && serf.row !== null) {
    state.mapTiles[posOf(serf.col, serf.row, state.geo)].serfIndex = 0;
  }
  bld.constructing = false; // bld[4] &= 0x7f
  bld.firstKnight = 0; // bld[10] = 0
};

/**
 * 09 Building — the builder raises the structure (`serf_state_09_Building @0x25335`). Tick gate, then the
 * `do` loop (several iterations per tick, bounded by the counter budget):
 * - **Working** (`field_0xb` i8 < 0): `building.progress += BUILD_PROGRESS_STEP[type*2+phase]` (phase 1
 * when `i16(progress) < 0`). A u16 overflow -> `completeBuilding`. Otherwise `field_0xf--`; at 0 request
 * new material.
 * - **Material** (`field_0xb >= 0`): consume the matching material from the building's stock
 * (`consumeBuildMaterial`) or wait.
 * - **Animation tail**: RNG -> anim `0x66+(rng&3)` (+4 on the leg toggle `field_0xe<0`), counter +=
 * `counter_from_animation[anim]`; an overflow ends the tick.
 */
HANDLERS[9] = (state, serf) => {
  if (!advance(serf, state.gameTick)) return;
  for (let guard = 0; guard < 256; guard++) {
    const mode = i8(unionU8(serf, 0xb));
    let doMaterial: boolean;
    if (mode < 0) {
 // Working: advance the build progress.
      const bld = state.buildings[unionU16(serf, 0xc)];
      if (!bld) return;
      const pi = bld.type * 2 + (i16(bld.progress) < 0 ? 1 : 0);
      const step = BUILD_PROGRESS_STEP[pi] ?? 0;
      const oldP = bld.progress;
      bld.progress = (oldP + step) & 0xffff;
      if (oldP + step > 0xffff) {
        completeBuilding(state, serf, bld);
        return;
      }
      const f = (i8(unionU8(serf, 0xf)) - 1) & 0xff;
      setUnionU8(serf, 0xf, f);
      if (f === 0) {
        buildRequestSetup(serf);
        doMaterial = true;
      } else {
        doMaterial = false;
      }
    } else {
      if (mode === 0) buildRequestSetup(serf);
      doMaterial = true;
    }
    if (doMaterial && consumeBuildMaterial(state, serf) === 'wait') return;
 // Animation tail (RNG -> anim -> counter budget).
    const r = state.rng.next();
    let a = ((r & 3) + 0x66) & 0xff;
    if (i8(unionU8(serf, 0xe)) < 0) a = (a + 4) & 0xff;
    serf.animation = a;
    if (addCounter(serf, cfa(a))) return;
  }
};

/**
 * The defensive case for a state **outside** 0..75: only the tick prologue, so a visible serf animates
 * on the spot instead of freezing, with no state transition. Unreachable through the table (all 76 slots
 * are filled); the original dispatcher `@0x16246` does not mask the index at all and would jump into
 * foreign code there.
 */
function animateOnly(serf: Serf, gameTick: number): void {
  const delta = subU16(gameTick, serf.tick);
  serf.tick = gameTick;
  serf.counter = subU16(serf.counter, delta);
}

/** Dispatch a serf through his `state` (== `FUN_00016246`). */
export function dispatchSerf(state: GameState, serf: Serf): void {
  const handler = serf.state >= 0 && serf.state < HANDLERS.length ? HANDLERS[serf.state] : null;
  if (handler !== null) handler(state, serf);
  else animateOnly(serf, state.gameTick);
}
