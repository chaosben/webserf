/**
 * **The statistics recorder** — `record_player_stat_history` @0xc100, called **every frame** from the
 * frame loop (@0xbe18, between the serf driver and `FUN_00027161`). It gates itself on two interval
 * clocks and does three things:
 *
 * 1. **Player comparison statistics** (interval **1500** ticks == 15 s): four aspects x four time
 *    windows, 112 samples each — the array `statHistory[16][112]`.
 * 2. **Victory detection**: two of the four aspects feed the bit mask `victoryMask`; whoever is above
 *    74 % in **both** wins. In training missions a mission goal takes its place.
 * 3. **Resource production statistics** (interval **6000** ticks == 60 s): 26 resources x 120 samples,
 *    filled from the accumulators `resourceCount[26]`, which are zeroed in the process.
 *
 * **Why the four windows are 0.5 / 2 / 10 / 50 hours** — this follows from the constants and is
 * therefore an independent check on the three reload values: `gameTick` runs at 100/s, so an interval
 * is 15 s. Window 0 = 112 * 15 s = 28 min ~ 0.5 h; window 1 advances every **4th** interval (reload 3)
 * => ~2 h; window 2 every 5th of those (reload 4) => ~10 h; window 3 again every 5th => ~47 h.
 *
 * The time axis lives in the save (`statTimer`/`resourceTimer`, the four ring heads, the three
 * counters and the resource ring head), so the recorder mutates `state.header` directly.
 */
import type { GameState, Player } from './state.js';
import { subU16, addU16 } from './int.js';

/** Interval of the player statistics (`cmpw $0x5dc` @0xc11a, `addw $0x5dc` @0xc133). */
const STAT_INTERVAL = 0x5dc; // 1500

/** Interval of the resource statistics (`cmpw $0x1770` @0xc95d, `addw $0x1770` @0xc966). */
const RESOURCE_INTERVAL = 0x1770; // 6000

/** Samples per time window (`cmpw $0x70` @0xc17f and three more). */
const STAT_SAMPLES = 0x70; // 112

/** Samples of the resource curve (`cmpw $0x78`). */
const RESOURCE_SAMPLES = 0x78; // 120

/**
 * Reload values of the three cascade counters (`mov $0x3` @0xc1b5, `mov $0x4` @0xc20c, `mov $0x4`
 * @0xc25f). Counter `i` drives the step from window `i` to `i + 1`.
 */
const LEVEL_RELOAD: readonly number[] = [3, 4, 4];

/**
 * Byte offset of the aspect in the history array (`vreg4` at the four call sites): 0 / 0x1c0 / 0x380 /
 * 0x540 == aspect * 448, and 448 == 4 windows * 112 samples. Together with the window offsets
 * 0/0x70/0xe0/0x150 that gives `mode = (aspect << 2) | window` — exactly the indexing the comparison
 * curves read back.
 */
const ASPECT_COMBINED = 0; //     @0xc4eb — "everything together"
const ASPECT_LAND = 0x1c0; //     @0xc2cc — land
const ASPECT_BUILDINGS = 0x380; // @0xc312 — buildings
const ASPECT_MILITARY = 0x540; //  @0xc3c8 — military strength

/** Window offsets inside one aspect (`addw $0x70/$0xe0/$0x150`). */
const LEVEL_OFFSET: readonly number[] = [0, 0x70, 0xe0, 0x150];

/**
 * Which bit group of the victory mask an aspect feeds (`vreg7`): `0` => bits 0..3, `1` => bits 4..7,
 * `-1` => none. Only **land** and **military strength** count towards a victory.
 */
const MASK_NONE = -1;
const MASK_LOW = 0;
const MASK_HIGH = 1;

/**
 * Threshold of the victory bits: `cmpb $0x4b,(%edi) ; jb …` — the bit falls at **>= 75** of 100, i.e.
 * "above 74 %". Four comparisons per bit group (@0xcc50/@0xcc6c/@0xcc89/@0xcca6 and
 * @0xccc5/@0xcce1/@0xccfe/@0xcd1b).
 */
const VICTORY_PERCENT = 0x4b; // 75

/** Percent factor of the normalisation (`mov $0x64,%ax` x4). */
const PERCENT = 0x64; // 100

/**
 * Gate of the victory detection: the sum of the building scores of **all four** slots must be
 * `>= 0x32` (`cmpl $0x32,(%edi) ; jb` @0xc833). Until the world is that big nobody wins — which is why
 * real saves carry `victoryMask == 0x11` without the game ending.
 */
const BUILD_SCORE_GATE = 0x32; // 50

/** `gs+0x381 = 0xff` => the mission-end screen is due (`mov $0xff,%al` @0xc882 and others). */
const MISSION_END_PENDING = 0xff;

/**
 * Game type **training game** (`cmpw $0x1,gs[0x352]` @0xc505) — the mission-end screen shows the
 * training text for exactly this value (@0x38636 ff.), while the campaign is game type **0**.
 */
const GAME_TYPE_TRAINING = 1;

/** `player+2` bit 6 == the slot is occupied. */
const PLAYER_FLAG_ACTIVE = 1 << 6;

// ──────────────────────────────────────────────────────────────────────────────────────────────
// compute_military_strength @0xcaab
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * **Military strength of one player** for the statistics — `compute_military_strength` @0xcaab.
 *
 * ```
 * m = (goldMorale >> 1) + 0x800            // shrw / addw $0x800
 * s = militaryScore << 6                   // shll $0x6
 * if (s == 0) return s                     // je 0xcb1b — no military => 0
 * r = (s * m) >> 16                        // 32x16 multiply, keep the upper word
 * return r == 0 ? 1 : r                    // mov $0x1 @0xcb13
 * ```
 *
 * The product can exceed 2^53, so the upper word is assembled from **two** halves exactly as the
 * original does, instead of trusting `Number`.
 *
 * **Not to be confused** with `militaryStrengthRatio` in `knight-morale.ts`: that is the ratio against
 * the other players, this is one player's absolute contribution.
 */
export function computeMilitaryStrength(militaryScore: number, goldMorale: number): number {
  const m = (((goldMorale & 0xffff) >>> 1) + 0x800) & 0xffff;
  const s = (militaryScore << 6) >>> 0;
  if (s === 0) return 0;
  const hi = (s >>> 16) & 0xffff;
  const lo = s & 0xffff;
  // (hi*m) full 32 bits + upper word of (lo*m) — the split at @0xcad5…@0xcb0e.
  const r = ((hi * m + Math.floor((lo * m) / 0x10000)) & 0xffffffff) >>> 0;
  return r === 0 ? 1 : r;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// normalize_stat_values @0xcb1e
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * **Record one aspect** — `normalize_stat_values` @0xcb1e. Normalises the four raw values to 0..100,
 * sets the victory bits from them where applicable and writes the result into **all** due windows.
 *
 * ```
 * sum = v0+v1+v2+v3                        (u32)
 * if (sum == 0) sum += 1                   // jne @0xcb35 — guard the division
 * while (sum >= 0xffff) { all four and sum >>= 1 }   // @0xcb3b..@0xcb59
 * per value:  p = (u16)v * 100 ; if (p != 0) p -= 1 ; v = p / (u16)sum
 * ```
 *
 * The **-1** before the division is not rounding but a cap: without it the only player owning
 * everything would reach 100, with it 99. Only `p == 0` stays 0.
 *
 * Window 0 is always written, then windows 1..3 cascade as far as `deepestLevel` allows (the `jne`
 * chain @0xcdde/@0xce37/@0xce92).
 *
 * Inactive slots are skipped when **writing** (their history is empty); the original writes into their
 * zeroed block, which nobody reads. When **computing** they take part with their 0 — which is what
 * keeps the sum unchanged.
 */
export function normalizeStatValues(
  state: GameState,
  raw: readonly number[],
  aspectOffset: number,
  maskGroup: number,
  deepestLevel: number,
): void {
  const v = [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0].map((x) => x >>> 0);
  let sum = (v[0]! + v[1]! + v[2]! + v[3]!) >>> 0;
  if (sum === 0) sum = 1;
  while (sum >= 0xffff) {
    for (let i = 0; i < 4; i++) v[i] = v[i]! >>> 1;
    sum = sum >>> 1;
  }
  for (let i = 0; i < 4; i++) {
    let p = ((v[i]! & 0xffff) * PERCENT) >>> 0;
    if (p !== 0) p = (p - 1) >>> 0;
    v[i] = Math.floor(p / (sum & 0xffff)) & 0xffff;
  }

  if (maskGroup >= 0) {
    const base = maskGroup === MASK_LOW ? 0 : 4;
    for (let i = 0; i < 4; i++) {
      if ((v[i]! & 0xff) >= VICTORY_PERCENT) {
        state.header.victoryMask = (state.header.victoryMask | (1 << (base + i))) & 0xff;
      }
    }
  }

  const ring = state.header.playerHistoryIndex;
  for (let level = 0; level < 4; level++) {
    if (level > 0 && deepestLevel < level) break; // the `jne` cascade @0xcdde/@0xce37/@0xce92
    const idx = ((ring[level] ?? 0) + aspectOffset + LEVEL_OFFSET[level]!) & 0xffff;
    const mode = Math.floor(idx / STAT_SAMPLES);
    const sample = idx % STAT_SAMPLES;
    for (let slot = 0; slot < 4; slot++) {
      const p = state.players[slot];
      const row = p?.statHistory?.[mode] as number[] | undefined;
      if (row === undefined) continue; // inactive slot — its block is zeroed and never read
      row[sample] = v[slot]! & 0xff;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Ring advance (@0xc16c..@0xc29d)
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * **Advance the four rings** and return how deep the cascade reached (0..3 == `vreg6`).
 *
 * Window 0 advances every interval. Then counter 0 is decremented; if it **borrows** (`subw $1 ; jae`
 * — the old value was 0), window 1 advances, the counter is reloaded, and the same repeats with
 * counter 1 -> window 2 and counter 2 -> window 3.
 *
 * The original tests the borrow, not `== 0`; reproduced as `old === 0`, which is identical because the
 * counter is reloaded right afterwards anyway.
 */
function advanceHistoryRings(state: GameState): number {
  const h = state.header;
  const ring = h.playerHistoryIndex as number[];
  const counter = h.playerHistoryCounter as number[];
  const bump = (level: number): void => {
    let next = ((ring[level] ?? 0) + 1) & 0xffff;
    if (next >= STAT_SAMPLES) next = 0;
    ring[level] = next;
  };

  bump(0);
  let deepest = 0;
  for (let level = 0; level < 3; level++) {
    const old = counter[level] ?? 0;
    counter[level] = (old - 1) & 0xffff;
    if (old !== 0) break; // `jae` — no borrow, the cascade ends here
    deepest = level + 1;
    counter[level] = LEVEL_RELOAD[level]!;
    bump(level + 1);
  }
  return deepest;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Resource history — the shared tail (@0xc95d..@0xcaaa)
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * **Advance the resource production history** — in the binary the tail shared by
 * `record_player_stat_history` and the mission-success block @0xc7c5.
 *
 * The ring head advances by 1 (wrapping at 120), then a loop runs over the **26 resources top down**
 * (`vreg1 = 0x19` downwards): each player's production byte moves into `resourceHistory[i][ring]` and
 * is **reset to 0** — the curve therefore shows production *per interval*, not the stock. That is why
 * the accumulator is a `u8`.
 */
export function recordResourceHistory(state: GameState): void {
  const h = state.header;
  h.resourceTimer = addU16(h.resourceTimer, RESOURCE_INTERVAL);
  let ring = (h.resourceHistoryIndex + 1) & 0xffff;
  if (ring >= RESOURCE_SAMPLES) ring = 0;
  h.resourceHistoryIndex = ring;

  for (let res = 25; res >= 0; res--) {
    for (let slot = 0; slot < 4; slot++) {
      const p = state.players[slot];
      if (!p) continue;
      const acc = (p.resourceCount as number[])[res] ?? 0;
      (p.resourceCount as number[])[res] = 0;
      const row = p.resourceHistory?.[res] as number[] | undefined;
      if (row === undefined) continue;
      row[ring] = acc & 0xff;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Victory detection (@0xc80e..@0xc93e) and mission goals (@0xc4ff..@0xc7c5)
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** Sum of one resource curve over all 120 samples (`FUN_0000c790`, 120 rounds from `vreg1 = 0x77`). */
function sumResourceRow(player: Player, res: number): number {
  const row = player.resourceHistory?.[res];
  if (row === undefined) return 0;
  let s = 0;
  for (let i = 0; i < RESOURCE_SAMPLES; i++) s += row[i] ?? 0;
  return s;
}

/** Sum over several curves (`FUN_0000c797` == the same loop **without** resetting `vreg0`). */
function sumResourceRows(player: Player, resources: readonly number[]): number {
  let s = 0;
  for (const r of resources) s += sumResourceRow(player, r);
  return s;
}

/**
 * **The five training mission goals** (`gs+0x354` == 1..5). All of them look at **player 0** only;
 * every satisfied condition leads to @0xc7c5, where player 0 is declared the winner.
 *
 * | Mission | Goal | Original |
 * |---|---|---|
 * | 1 | one finished **hut, tower, fortress** each | `player+0x18/0x2c/0x2e != 0` |
 * | 2 | sum **stone** > 4 **and** sum **planks** > 4 | `+0x15fc`, `+0x150c`, `cmpw $0x5 ; jb` |
 * | 3 | sum **fish**, **meat**, **bread** each > 4 | `+0x11c4`, `+0x12b4`, `+0x141c` |
 * | 4 | sum **steel** > 4 **and** sum **gold bars** > 4 | `+0x16ec`, `+0x1854` |
 * | 5 | sum(**sword**+**shield**) > 9 **and** sum of all **nine tools** > 9 | `+0x1d04`/`+0x1d7c`, then `+0x18cc`…`+0x1c8c` |
 * | else | **player 1 holds no land** (`player1+0x112 == 0`) | @0xc783 |
 *
 * The resource indices come from the byte offsets of the history rows. The address of the sword
 * summand exists **only in the assembly**: the decompilation shows `(int)&g_clip2 + ptr_c` there,
 * because the immediate `0x1d04` is taken for an address (`add $0x1d04,%esi` @0xc6ae).
 *
 * Mission 1 counts **finished** buildings: the three offsets hit indices 10 / 20 / 21 == types
 * **11 hut / 21 tower / 22 fortress**.
 */
const RES_STONE = 9;
const RES_PLANK = 7;
const RES_FISH = 0;
const RES_MEAT = 2;
const RES_BREAD = 5;
const RES_STEEL = 11;
const RES_GOLDBAR = 14;
const RES_SWORD = 24;
const RES_SHIELD = 25;
/** Shovel..tongs — the nine tools (`+0x18cc` … `+0x1c8c`). */
const RES_TOOLS: readonly number[] = [15, 16, 17, 18, 19, 20, 21, 22, 23];

function missionGoalReached(state: GameState): boolean {
  const p0 = state.players[0];
  if (!p0) return false;
  switch (state.header.missionSetupIndex) {
    case 1: {
      const done = p0.completedBuildingCount;
      return (done[10] ?? 0) !== 0 && (done[20] ?? 0) !== 0 && (done[21] ?? 0) !== 0;
    }
    case 2:
      return sumResourceRow(p0, RES_STONE) > 4 && sumResourceRow(p0, RES_PLANK) > 4;
    case 3:
      return (
        sumResourceRow(p0, RES_FISH) > 4 &&
        sumResourceRow(p0, RES_MEAT) > 4 &&
        sumResourceRow(p0, RES_BREAD) > 4
      );
    case 4:
      return sumResourceRow(p0, RES_STEEL) > 4 && sumResourceRow(p0, RES_GOLDBAR) > 4;
    case 5:
      return (
        sumResourceRows(p0, [RES_SWORD, RES_SHIELD]) > 9 && sumResourceRows(p0, RES_TOOLS) > 9
      );
    default:
      // @0xc783 — any other mission number: won once player 1 holds no land.
      return ((state.players[1]?.totalLandScore ?? 0) >>> 0) === 0;
  }
}

/**
 * **Victory detection in a normal game** (`gs+0x352 != 1`), @0xc80e.
 *
 * ```
 * sum = player[0..3].totalBuildingScore ; if (sum < 0x32) return       // @0xc833
 * if (winner < 0)                        -> whoever holds both bits wins (0x11/0x22/0x44/0x88)
 * else if (winner != 0 && gameType == 0) -> only player 0 can still take over (0x11)
 * ```
 *
 * The second branch looks like an oddity but is unambiguous in the binary (`js` -> first branch,
 * `je` -> `ret`, otherwise second branch): once a winner other than 0 stands, **player 0** may still
 * displace them in a free game. Taken verbatim.
 */
function detectVictory(state: GameState): void {
  const h = state.header;
  let sum = 0;
  for (let slot = 0; slot < 4; slot++) sum += (state.players[slot]?.totalBuildingScore ?? 0) >>> 0;
  if (sum < BUILD_SCORE_GATE) return; // `jb 0xc93e`

  const declare = (slot: number): void => {
    h.winnerIndex = slot;
    h.missionEndPending = MISSION_END_PENDING;
  };
  const both = (slot: number): boolean => {
    const pair = (1 << slot) | (1 << (slot + 4));
    return (h.victoryMask & pair) === pair;
  };

  if (h.winnerIndex < 0) {
    for (let slot = 0; slot < 4; slot++) {
      if (both(slot)) return declare(slot); // @0xc8a4/@0xc8cc/@0xc8f5/@0xc91e
    }
    return;
  }
  if (h.winnerIndex === 0) return; // `je 0xc93e`
  if (h.gameType !== 0) return; // `jne 0xc93e` @0xc85b
  if (both(0)) declare(0); // @0xc86f — the player-0 mask only
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** Raw value of an aspect per slot; inactive slots yield 0 (their block is zeroed). */
function perSlot(state: GameState, pick: (p: Player) => number): number[] {
  const out = [0, 0, 0, 0];
  for (let slot = 0; slot < 4; slot++) {
    const p = state.players[slot];
    if (p) out[slot] = pick(p) >>> 0;
  }
  return out;
}

/**
 * **`record_player_stat_history` @0xc100** — the frame entry. Both halves gate themselves separately,
 * so a frame may trigger neither, one or both.
 *
 * The order of the four aspect recordings is the call order in the binary (land, buildings, military,
 * "everything together"), and it is not cosmetic: the two mask-setting aspects must run **before** the
 * victory detection reads the mask, and `victoryMask` is zeroed at the start (@0xc125).
 *
 * The combined aspect is `((land + military) >> 4) + buildings` (`shrl $0x4` @0xc4db) — the three
 * categories do **not** enter with equal weight; land and military are damped by four bits together,
 * the building score enters in full.
 */
export function recordStats(state: GameState): void {
  const h = state.header;

  if (subU16(state.gameTick, h.statTimer) >= STAT_INTERVAL) {
    h.victoryMask = 0; // @0xc125 — the mask is rebuilt every interval
    h.statTimer = addU16(h.statTimer, STAT_INTERVAL);
    const deepest = advanceHistoryRings(state);

    const land = perSlot(state, (p) => p.totalLandScore);
    normalizeStatValues(state, land, ASPECT_LAND, MASK_LOW, deepest);
    normalizeStatValues(
      state,
      perSlot(state, (p) => p.totalBuildingScore),
      ASPECT_BUILDINGS,
      MASK_NONE,
      deepest,
    );
    const military = perSlot(state, (p) =>
      computeMilitaryStrength(p.totalMilitaryScore, p.goldMorale),
    );
    normalizeStatValues(state, military, ASPECT_MILITARY, MASK_HIGH, deepest);
    const combined = [0, 1, 2, 3].map((slot) => {
      const p = state.players[slot];
      if (!p) return 0;
      return ((((land[slot]! + military[slot]!) >>> 0) >>> 4) + (p.totalBuildingScore >>> 0)) >>> 0;
    });
    normalizeStatValues(state, combined, ASPECT_COMBINED, MASK_NONE, deepest);

    if (h.gameType === GAME_TYPE_TRAINING) {
      // @0xc4ff — training mission: check the goal, but only while no winner stands.
      if (h.winnerIndex < 0 && missionGoalReached(state)) {
        // @0xc7c5: player 0 wins, mission end due. The original then falls into the same resource
        // history tail — hence no `return` here.
        h.winnerIndex = 0;
        h.missionEndPending = MISSION_END_PENDING;
      }
    } else {
      detectVictory(state);
    }
  }

  if (subU16(state.gameTick, h.resourceTimer) >= RESOURCE_INTERVAL) {
    recordResourceHistory(state);
  }
}

/** Active count and slot mask, as `FUN_000109b6` @0x109b6 builds them. */
export function activeSlotMask(state: GameState): { count: number; mask: number } {
  let count = 0;
  let mask = 0;
  for (let slot = 0; slot < 4; slot++) {
    const p = state.players[slot];
    if (p && (p.flags & PLAYER_FLAG_ACTIVE) !== 0) {
      count += 1;
      mask |= 1 << slot;
    }
  }
  return { count, mask };
}
