/**
 * Economy and player tick: **serf reproduction** (population growth at the castle).
 *
 * - `updateEconomy` = `FUN_0000ec9d` @0xec9d — the economy update group. Per frame it calls the
 *   round-robin housekeeping (`FUN_0000eced`, below) and the player tick for each of the four player
 *   slots. (Map object growth `FUN_0000f2d5` and the statistics recorder `FUN_0000c100` are modules
 *   of their own.)
 * - `roundRobinServiceReset` = `FUN_0000eced` @0xeced (parts 1 and 2) — the **round-robin
 *   housekeeping**: per frame it visits a rolling window of `serviceBudget` (55) buildings or flags
 *   (cursors `buildingServiceCursor`/`flagServiceCursor`) and **clears their
 *   `serfRequestFailed`/`serfRequestFail` markers**, so a serf request that failed once is retried
 *   later. It stops early once 10 markers that were actually set have been cleared (`vreg2`).
 *   **Frame-paced**, not per game tick: the cursor advances per CALL, not by delta, so it is bound to
 *   the frame cadence — otherwise it would run 8x too fast. **Part 0** of `FUN_0000eced` is the
 *   opener of the mission end screen, see {@link missionEndScreenDue}.
 * - `playerTick` = `FUN_0000f03a` @0xf03a — the per-player tick. Only the **reproduction block** here
 *   (gate `flags` bit 0, tick delta against `reproduction_counter`/`reset`, the `serf_to_knight`
 *   counter feeding `knights_to_spawn`, the spawn loop) **plus** the three score clamps at the head
 *   ({@link clampScoreUnderflow}) — those are **under**flow clamps and they matter, because the port
 *   does subtract score (demolition) — plus the two **AI timers** ({@link tickAiTimers}, `flags`
 *   bit 7, fields `+0x1b0/0x1b2`; measurement shows they only run for AI players).
 * - `spawnSerf` = `FUN_00029a17` @0x29a17 — allocates a new serf (`createSerf`), picks an inventory
 *   (owner match, serfMode not "stop", with sword and shield when `wantKnight`; the first empty one
 *   or the one with the smallest `genericCount`) and sets it up as **generic / IdleInStock**.
 *   `wantKnight` without a matching inventory retries once as generic (the original toggles
 *   `player+0x10e`).
 * - `createSerf` = `FUN_000457dc` @0x457dc — the serf allocator: lowest free slot, budget
 *   (`gs->field_0x48`) -1, high-water mark (`maxSerfIndex`, `gs->field_0x262`) grown along.
 *
 * **Knight conversion — a deliberate slice boundary.** The else branch (`knights_to_spawn > 0`) also
 * calls `spawnSerf` but specialises the new serf to `Knight0` as soon as the chosen inventory has
 * sword and shield. The conversion itself is ported structurally but never fires in the available
 * saves (castle without sword or shield, so every reproduction stays generic). The garrison rotation
 * (castle handler) is a separate subsystem.
 */

import { u16, addU16, subU16 } from './int.js';
import type { GameState, Serf, Inventory, Player } from './state.js';
import { setSerfType } from './state.js';
import { SERF_TYPE_NAMES } from '../save-parser.js';
import { tickKnightShift } from './player-settings.js';
import { mapObjectGrowth } from './map-growth.js';
import { viewportAmbientAudio } from './ambient-sound.js';
import { campaignFollowUpPassword, SETUP_PASSWORD_BYTES } from '../player-setup.js';

const SERF_GENERIC = 21; // serf type 0x15
const SERF_KNIGHT0 = 22; // serf type 0x16
const STATE_IDLE_IN_STOCK = 1;
const RES_SWORD = 24;
const RES_SHIELD = 25;

/**
 * The economy update group (`FUN_0000ec9d`): player tick for all four slots in fixed order (0..3).
 * The fixed order is part of the determinism contract and in particular decides which player gets the
 * lower serf index when two reproduce in the same tick — verified against real saves through the
 * alternating indices of new serfs.
 *
 * **The whole group is frame-paced, the player tick included.** The call chain is closed: the frame
 * loop calls @0xec9d at @0xbdfa and nowhere else, and @0xec9d calls `player_tick_reproduction`
 * @0xf03a four times (@0xecb7/@0xecc7/@0xecd7/@0xece7), one per slot. That matters because two of the
 * blocks inside the player tick are plain `-1` decrements and not tick-delta driven — the knight
 * shift countdown (@0xf0fc) and the two AI countdowns (@0xf0c3/@0xf0dd). Run per tick they are eight
 * times too fast, and the shift change then finishes inside a single sweep of the building driver,
 * which needs 49 frames to reach every building.
 */
export function updateEconomy(state: GameState): void {
  roundRobinServiceReset(state);
 // @0xeca2 `call 0xef29` — the **ambient sounds**. Draws exactly one random value per frame
 // (regardless of what is visible) and must therefore come BEFORE the map growth, otherwise the
 // random stream shifts against the original.
  viewportAmbientAudio(state);
 // @0xeca7 `call 0xf2d5` — the **map growth** (saplings to trees, grain, decay, fish). In the
 // original it sits between the housekeeping (@0xeced) and the player loop. The routine derives its
 // workload from the tick delta anyway.
  mapObjectGrowth(state);
  for (let slot = 0; slot < 4; slot++) {
    const player = state.players[slot];
    if (player !== null) playerTick(state, player);
  }
}

/**
 * Viewport state {@link missionEndScreenDue} needs — reachable through `gs+0x78` in the original,
 * not part of the save state in our model.
 */
export interface MissionEndGate {
 /** `vp[1]` bit 7 — is a road being built right now? */
  readonly roadBuilding: boolean;
 /** `vp[0x72]` — the popup screen currently open (`0` = none). */
  readonly currentScreen: number;
}

/**
 * Screens on which the mission end does **not** pop up (@0xed22..@0xed43). The cascade tests
 * `< 0x17 => yes`, `< 0x1b => no`, `< 0x22 => yes`, `< 0x24 => no`, `== 0x25 => no`, otherwise yes —
 * i.e. exactly the disk dialogs (0x17..0x1a), the two quit screens (0x22/0x23) and the options footer
 * (0x25). All of them are modal questions themselves; the original lets them finish.
 */
export const MISSION_END_BLOCKING_SCREENS: readonly number[] = [
  0x17, 0x18, 0x19, 0x1a, 0x22, 0x23, 0x25,
];

/**
 * **Part 0 of `FUN_0000eced`** @0xeced — the opener of the mission end screen:
 *
 * ```
 * if (gs[0x381] == 0) return                      // @0xecf6 — no end due
 * vp = gs[0x78]
 * if (vp[1] & 0x80) return                        // @0xed0b — not while building a road
 * s = vp[0x72]
 * if (s in {0x17..0x1a, 0x22, 0x23, 0x25}) return // @0xed22..@0xed43
 * gs[0x381] = 0 ; vp[0x70] = 0x36                 // @0xed4a / @0xed57
 * ```
 *
 * Returns `true` when the screen should open now, acknowledging the trigger `missionEndPending` on
 * the way, exactly as the original does before writing `vp[0x70]`. The caller then sets the screen;
 * **who** sets it is the only difference to the original (there the routine writes into the viewport
 * directly, here the engine knows no viewport).
 *
 * Separate from {@link roundRobinServiceReset} because this part **reads** viewport state that the
 * engine model does not carry; in the binary it is the head of the same routine, and the order is
 * preserved as long as the caller asks it on the frame boundary **before** the housekeeping.
 *
 * Three constants of the binary deliberately do not appear here: bit number **7** of the road-building
 * bit (`road-building.ts` carries it), the screen number **0x36** (`mission-end-popup.ts` — the engine
 * knows no screens) and the two **exclusive** cascade bounds `0x1b`/`0x24`, which cannot occur as
 * values at all.
 */
export function missionEndScreenDue(state: GameState, gate: MissionEndGate): boolean {
  if (state.header.missionEndPending === 0) return false;
  if (gate.roadBuilding) return false;
  if (MISSION_END_BLOCKING_SCREENS.includes(gate.currentScreen)) return false;
  state.header.missionEndPending = 0;
  return true;
}

/**
 * **The campaign password of the next level** — the one effect of the mission-end renderer
 * `FUN_0003831d` that outlives its screen.
 *
 * Its loop @0x38518..@0x3854d writes each decoded character to two sinks: the text of the screen
 * (`mov %al,(%ebx)` @0x3853b, into the literal `@0x38a51`) and the buffer `gs+0x35a` (@0x38547), which
 * is at once the main menu's password line and the save field `.DS`@128. The first sink is a return
 * value in the port (`missionEndPassword`), the second is state and therefore written here.
 *
 * Deliberately **not** folded into {@link missionEndScreenDue}: that predicate is part 0 of
 * `FUN_0000eced`, this write belongs to another routine — and the predicate is exercised with a
 * minimal state stub, which would silently run this write on an object without a game type.
 *
 * It has to be called from the tick path, not while drawing: `missionEndPassword` runs once per
 * frame. Once is equivalent to the original's per-redraw write because the value depends only on
 * `levelSetupIndex`, and that changes on leaving (@0x2ec48) — after the screen is gone.
 *
 * The original writes nothing when there is no follow-up password (defeat, level 30, another game
 * type): it jumps past the block and leaves the cell as it was.
 */
export function writeMissionEndPassword(state: GameState): void {
  const password = campaignFollowUpPassword(state.header, SETUP_PASSWORD_BYTES);
  // A record beyond the table cannot occur — the cap `je 0x3879b` catches level 30, and 30 + 6 == 36
  // is the first index the table lacks.
  if (password !== null) state.header.levelPassword = password;
}

const SERVICE_HIT_LIMIT = 10; // `vreg2 = 10`: stop after 10 markers that were actually cleared
// (buildings clear status bit 2 = 0x04 = serfRequestFailed; flags byte[5] bit 7 = 0x80 =
// serfRequestFail — both booleans in the live record, so we set them to false.)

/**
 * Round-robin housekeeping (`FUN_0000eced`, parts 1 and 2). **Frame-paced**: the cursor advances per
 * call, not by tick delta. Clears `serfRequestFailed` (buildings) and `serfRequestFail` (flags) over a
 * rolling window of `serviceBudget` entries from the respective cursor; stops after
 * {@link SERVICE_HIT_LIMIT} real clears, leaving the cursor on the last hit.
 *
 * **Pure, with no gating of its own:** the frame boundary is checked by the caller, because the frame
 * clock belongs to `advanceFrameClock`. Every call sweeps one window; one call per frame.
 */
export function roundRobinServiceReset(state: GameState): void {
  const budget = state.serviceBudget;
  state.buildingServiceCursor = sweepClearBit(
    state.buildings,
    state.header.maxBuildingIndex,
    budget,
    state.buildingServiceCursor,
    (b) => b.serfRequestFailed,
    (b) => {
      b.serfRequestFailed = false;
    },
  );
  state.flagServiceCursor = sweepClearBit(
    state.flags,
    state.header.maxFlagIndex,
    budget,
    state.flagServiceCursor,
    (f) => f.serfRequestFail,
    (f) => {
      f.serfRequestFail = false;
    },
  );
}

/**
 * Work through one round-robin window (the `do/while` core of `FUN_0000eced`). Visits up to
 * `min(budget, maxIndex - cursor)` slots from `cursor`, clears the bit on every occupied slot
 * (unconditionally, as the original applies the raw byte mask), counts real clears and stops after
 * {@link SERVICE_HIT_LIMIT} hits without moving the cursor past that hit. Returns the new cursor
 * (wrapping on the next call when `cursor >= maxIndex`). `null` slots count towards the window (the
 * cursor advances) but not as hits.
 */
function sweepClearBit<T>(
  records: readonly (T | null)[],
  maxIndex: number,
  budget: number,
  cursor: number,
  isSet: (r: T) => boolean,
  clear: (r: T) => void,
): number {
  if (maxIndex === 0) return cursor;
  if (cursor >= maxIndex) cursor = 0; // wrap (== `if (maxIndex <= vreg0) vreg0 = 0`)
  const window = Math.min(budget, maxIndex - cursor);
  let hits = SERVICE_HIT_LIMIT;
  let i = cursor;
  for (let n = 0; n < window; n++) {
    const rec = records[i];
    if (rec !== null && rec !== undefined) {
      const wasSet = isSet(rec);
      clear(rec);
      if (wasSet && --hits === 0) break; // cursor does NOT move past the 10th hit (the break is before vreg0++)
    }
    i++;
  }
  return i;
}

/**
 * **Underflow clamp of the three score fields** (@0xf03a..@0xf088, the same block three times):
 * `if ((u32)value >= 0xffff0000) value = 0`. That is a **lower** bound, not an upper one: the fields
 * are subtracted elsewhere (demolition), wrap below 0 to 0xffff.... as u32, and this block catches
 * them at 0. Without it the value would stay **negative** here — and `knight-morale.ts` reads it with
 * `>>> 0`, turning that into a billion.
 *
 * The block sits **before** the active gate and therefore runs for unoccupied player slots too.
 *
 * **Order as in the original**: `player+0x112` (land), then `0x11a` (military), then `0x116`
 * (buildings). The land field is the count of the player's own tiles, verified against the tile block
 * (124 of 124 players exact); the clamp catches its u32 underflow when a player loses more tiles than
 * he had.
 */
function clampScoreUnderflow(player: Player): void {
  if ((player.totalLandScore >>> 0) >= 0xffff0000) player.totalLandScore = 0; // @0xf03d/@0xf04e
  if ((player.totalMilitaryScore >>> 0) >= 0xffff0000) player.totalMilitaryScore = 0; // @0xf057/@0xf068
  if ((player.totalBuildingScore >>> 0) >= 0xffff0000) player.totalBuildingScore = 0; // @0xf071/@0xf082
}

/**
 * **The two AI countdowns** (@0xf0a5..@0xf0e5) — they run only for AI players (`bt $0x7` @0xf0a5)
 * and only while the value is `!= 0`, so they cannot underflow. `aiShiftCooldown` is the lockout of
 * the knight shift (set to 15000 by the AI military policy), `aiTimer562` is set by the reload sites
 * @0x52d4e/@0x52f35 of the AI building round. Both are maintained together because they are **one**
 * block in the original, and a half-ported block is exactly the kind of gap nobody finds later.
 */
function tickAiTimers(player: Player): void {
  if ((player.flags & (1 << 7)) === 0) return; // `bt $0x7 ; je 0xf0e5` @0xf0a5
  if (player.aiTimer562 !== 0) player.aiTimer562 = u16(player.aiTimer562 - 1); // @0xf0bb/@0xf0c3
  if (player.aiShiftCooldown !== 0) player.aiShiftCooldown = u16(player.aiShiftCooldown - 1); // @0xf0d5/@0xf0dd
}

/**
 * Per-player tick (`FUN_0000f03a`). Order as in the original: gate `flags` **bit 6** (active player,
 * `bt $0x6` @0xf090) -> **AI timers** (bit 7, @0xf0a5) -> **knight shift countdown** (bit 2, @0xf0ed)
 * -> **reproduction block** (bit 0, @0xf16e).
 *
 * Reproduction: the tick delta pulls `reproduction_counter` down, and on underflow the spawn loop
 * runs (adding `reproduction_reset` each round until the u16 carry makes the counter "positive"
 * again).
 *
 * The knight shift countdown does **not** hang on the reproduction gate: it runs while bit 0 is
 * clear too, which is why it stands before that `return` — in the original both blocks have their own
 * `bt` gates.
 */
export function playerTick(state: GameState, player: Player): void {
  clampScoreUnderflow(player); // @0xf03a..@0xf088 — BEFORE the active gate, empty slots included
  if (!player.active) return; // `bt $0x6` @0xf090
  tickAiTimers(player); // bit 7 block @0xf0a5
  tickKnightShift(player); // bit 2 block @0xf0e5
  if ((player.flags & 1) === 0) return; // military/reproduction pace off (no castle)

  const delta = subU16(state.gameTick, player.lastTick);
  player.lastTick = state.gameTick;
  const oldCounter = player.reproductionCounter;
  player.reproductionCounter = subU16(oldCounter, delta);
 // Original: `if (delta <= oldCounter) return` (unsigned) — the counter stays >= 0.
  if (delta <= oldCounter) return;

  do {
 // serf_to_knight_counter += rate (u16); a carry increments knights_to_spawn (clamped at 2).
    const before = player.serfToKnightCounter;
    player.serfToKnightCounter = addU16(before, player.serfToKnightRate);
    const carry = before + player.serfToKnightRate > 0xffff;
    if (carry) {
      player.knightsToSpawn += 1;
      if (player.knightsToSpawn > 2) player.knightsToSpawn = 2;
    }

    if (player.knightsToSpawn === 0) {
      spawnSerf(state, player, false); // plain generic resupply
    } else {
      const spawned = spawnSerf(state, player, true);
 // Conversion: only when the chosen inventory has sword and shield.
      if (spawned !== null && spawned.inv.resources[RES_SWORD] !== 0 && spawned.inv.resources[RES_SHIELD] !== 0) {
        player.knightsToSpawn -= 1;
        specializeKnight(player, spawned.serf, spawned.inv);
      }
    }

 // reproduction_counter += reset; the loop ends as soon as the u16 add carries.
    const c = player.reproductionCounter;
    player.reproductionCounter = addU16(c, player.reproductionReset);
    if (c + player.reproductionReset > 0xffff) break;
  } while (true);
}

/**
 * Create a new serf and place it into an inventory (`FUN_00029a17`). Returns the chosen inventory
 * along with the serf so the caller can check the knight conversion; `null` when no serf could be
 * created (budget, build status, or no matching inventory).
 */
export function spawnSerf(
  state: GameState,
  player: Player,
  wantKnight: boolean,
): { serf: Serf; inv: Inventory } | null {
 // can_spawn: `build` bit 2 (initial castle serfs created) AND the global budget > 0.
  if ((player.build & 4) === 0 || state.serfBudget <= 0) return null;

  const serf = createSerf(state);
  if (serf === null) return null;

  let want = wantKnight;
 // Original: while (true) { look for an inventory; found -> set up; otherwise, with wantKnight,
 // retry as generic (toggling player+0x10e); a generic failure releases the serf }.
  for (;;) {
    const inv = pickInventory(state, player.slot, want);
    if (inv !== null) {
      setupGeneric(state, player, serf, inv);
      return { serf, inv };
    }
    if (!want) break;
    want = false;
  }

  freeSerf(state, serf);
  return null;
}

/** Pick a matching inventory: the first empty one (`genericCount == 0`), else the one with the smallest `genericCount`. */
function pickInventory(state: GameState, owner: number, wantKnight: boolean): Inventory | null {
  let best: Inventory | null = null;
  let bestCount = 0x10000;
  for (const inv of state.inventories) {
    if (inv === null) continue;
    if (inv.owner !== owner) continue; // (char)vreg0 == inv[0]
    if ((inv.serfMode & 1) !== 0) continue; // serfMode „stop" (1) ausgeschlossen; „in"(0)/„out"(2) ok
    if (wantKnight && (inv.resources[RES_SWORD] === 0 || inv.resources[RES_SHIELD] === 0)) continue;
    if (inv.genericCount === 0) return inv; // erstes leeres sofort
    if (inv.genericCount < bestCount) {
      bestCount = inv.genericCount;
      best = inv;
    }
  }
  return best;
}

/** Set up the freshly allocated serf as Generic/IdleInStock in the inventory (`LAB_00029c03`). */
function setupGeneric(state: GameState, player: Player, serf: Serf, inv: Inventory): void {
  const bld = state.buildings[inv.building];
  inv.genericCount += 1; // inv+0x40++
  player.serfCount[SERF_GENERIC] += 1; // player-0x10++ (generic census)

  serf.owner = player.slot; // serf[0] = owner | (Generic<<2)
  setSerfType(serf, SERF_GENERIC);
  serf.sound = false;
  serf.animation = 0;
  serf.counter = 0;
  serf.col = bld ? bld.col : null; // serf.pos = building.pos
  serf.row = bld ? bld.row : null;
  serf.tick = state.gameTick;
  serf.state = STATE_IDLE_IN_STOCK;
  serf.stateData = [0, 0, 0, inv.index & 0xff, (inv.index >> 8) & 0xff]; // field_0xe = inventory index
}

/** Conversion generic -> Knight0: type bits, census, military score, weapons consumed. */
function specializeKnight(player: Player, serf: Serf, inv: Inventory): void {
  setSerfType(serf, SERF_KNIGHT0); // type bits &0x83|0x58 == Knight0
  player.serfCount[SERF_GENERIC] -= 1; // player-0x10--
  player.serfCount[SERF_KNIGHT0] += 1; // player-0xe++
  player.totalMilitaryScore += 1; // player+0x11a++
  inv.resources[RES_SWORD] -= 1;
  inv.resources[RES_SHIELD] -= 1;
  inv.genericCount -= 1; // inv+0x40--
}

/**
 * Serf allocator (`FUN_000457dc` / `create_serf`): occupy the lowest free slot >= 1, budget
 * (`gs->field_0x48`) -1, grow the high-water mark (`maxSerfIndex` == `gs->field_0x262`). The original
 * scans the occupancy bitmap bottom up — `serfs[i] === null` is equivalent (slot 0 reserved). The
 * separate capacity `gs->field_0x25c` is not modelled: the budget always binds first.
 *
 * `start` exists **only** to reserve the null slot at game start (`resetEntityTables` @0x76bb,
 * `call 0x457dc` @0x782e) — the original scans its bitmap from 0, and that first call also consumes
 * **one unit of budget**: across six freshly started original saves `serfBudget` is invariably **1
 * below** `pensum * 500`. During play it is 1.
 */
export function createSerf(state: GameState, start = 1): Serf | null {
  const serfs = state.serfs;
  let idx = start;
  while (idx < serfs.length && serfs[idx] !== null) idx++;
  if (idx >= serfs.length) serfs.push(null);

 // Grow the high-water mark when allocating at the top (`if idx == field_0x262: field_0x262++`).
  if (idx >= state.header.maxSerfIndex) {
    state.header.maxSerfIndex = idx + 1;
    state.blockMeta.serfs.maxIndex = idx + 1;
    if (serfs.length <= idx + 1) serfs.push(null); // top slot stays free (round-trip convention)
  }

  const serf: Serf = {
    index: idx,
    owner: 0,
    type: 0,
    typeName: SERF_TYPE_NAMES[0],
    sound: false,
    animation: 0,
    counter: 0,
    col: null,
    row: null,
    tick: 0,
    state: 0,
    stateData: [0, 0, 0, 0, 0],
  };
  serfs[idx] = serf;
  state.serfBudget = u16(state.serfBudget - 1);
  return serf;
}

/**
 * Release a just-allocated serf (`FUN_0004592e` / `delete_serf`): clear the slot, budget +1, and — if
 * it was the topmost slot — lower the high-water mark over the free slots below. In reproduction this
 * is only reached when no matching inventory exists (never with a castle).
 */
export function freeSerf(state: GameState, serf: Serf): void {
  const idx = serf.index;
  state.serfs[idx] = null;
  state.serfBudget = u16(state.serfBudget + 1);
  if (idx + 1 === state.header.maxSerfIndex) {
    let m = state.header.maxSerfIndex;
    while (m > 0 && state.serfs[m - 1] === null) m -= 1;
    state.header.maxSerfIndex = m;
    state.blockMeta.serfs.maxIndex = m;
  }
}
