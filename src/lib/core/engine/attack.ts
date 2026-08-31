/**
 * **Preparing an attack** — port of `FUN_0002ae5a` @0x2ae5a (collect attackers), `FUN_0002b02e`
 * @0x2b02e (evaluate one tile) and the attack branch of the map click (`FUN_00029e16`
 * @0x2a3d0..@0x2a5cf).
 *
 * The original runs this chain when a **special click hits a foreign military building**; it fills five
 * player fields and then opens popup screen **0x14**:
 *
 * | Field | Block offset | Content |
 * |---|---|---|
 * | `attackingBuildings[64]` | 250 | indices of our own military buildings in range |
 * | `attackingBuildingCount` | 424 | how many of them |
 * | `attackingKnights[4]` | 426 | knights that can be spared, grouped by **distance band** |
 * | `totalAttackingKnights` | 434 | sum of the four bands |
 * | `buildingAttacked` | 436 | the enemy building that was clicked |
 * | `knightsAttacking` | 438 | the number **chosen** in the window |
 */

import type { Building, GameState, Player, Serf } from './state.js';
import { neighbor, posOf, colOf, rowOf, Direction } from './position.js';
import { SPIRAL_PATTERN } from './spiral.js';
import { unionU16, setUnionU16 } from './serf-machine.js';

/**
 * The coded type both routines in this file compare against: `bld[4] & 0xfc` (`@0x2a437`, `@0x2b0f9`).
 * The mask **leaves bit 7 standing** — the construction bit. A building **under construction**
 * therefore yields `type<<2 | 0x80` and matches none of the comparison values: construction sites drop
 * out of the attacker collection and are no attack target either.
 *
 * (The other popup renderers mask with `0x7c` and handle the construction bit separately — here it is
 * deliberately part of the comparison.)
 */
export function codedBuildingType(building: {
  readonly type: number;
  readonly constructing: boolean;
}): number {
  return ((building.type << 2) | (building.constructing ? 0x80 : 0)) & 0xfc;
}

/** Coded building types (`bld[4] & 0xfc`) that can be attacked (`@0x2a43d`). */
export const ATTACKABLE_CODED_TYPES: readonly number[] = [0x2c, 0x54, 0x58, 0x60];

/**
 * How many knights the original suggests **at most**, per target building type (`@0x2a52c`): hut 3,
 * tower 6, fortress 12, castle 20.
 */
export function attackSuggestionCap(codedType: number): number {
  if (codedType === 0x2c) return 3;
  if (codedType === 0x54) return 6;
  if (codedType === 0x58) return 0xc;
  return 0x14;
}

/**
 * Range of spiral positions the pre-check scans for **our own land** (`@0x2a4a1`:
 * `esi = gs[0xc4] + 0x1c` = entry 7 of the packed offset table).
 *
 * **It is 258 rounds, not 257.** The counter is `mov $0x101,%ax ; mov %ax,0x8(%edi)`
 * @0x2a4aa/@0x2a4ae, and the loop decrements it **after** the body (`subw $0x1,0x8(%edi)` + `jae`).
 * A do-while with a trailing decrement runs with counter values 257,256,…,1,0 — that is `imm + 1`
 * times, hitting `SPIRAL_PATTERN[7 .. 264]`.
 *
 * The six direct neighbours (1..6) stay out; next to a military building they belong to the enemy
 * anyway.
 */
export const ATTACK_RANGE_FIRST_SPIRAL = 7;
export const ATTACK_RANGE_SPIRAL_COUNT = 0x102;

/** Rings {@link collectAttackers} walks (`cmpw $0x20` — the loop ends when the ring counter hits 32). */
export const ATTACK_COLLECT_RINGS = 0x20;

/**
 * The six sides of a ring in original order, from the `gs` neighbour deltas of the loop: `gs+0xc`
 * (Down), `gs+0x60` (Left), `gs+0x14` (UpLeft), `gs+0x18` (Up), the constant `+4` (Right), `gs+0x8`
 * (DownRight). Each side runs `ring+1` tiles, preceded by one step **Right**.
 */
export const ATTACK_RING_SIDES: readonly Direction[] = [
  Direction.Down,
  Direction.Left,
  Direction.UpLeft,
  Direction.Up,
  Direction.Right,
  Direction.DownRight,
];

/** Length of `attackingBuildings[]` — the original stops at byte length `0x80`. */
export const ATTACK_BUILDING_LIST_MAX = 0x80 / 2;

/**
 * **Mandatory garrison per building and setting** — table `DAT_0002b1f4`, 15 bytes:
 *
 * ```
 * hut       1 1 2 2  3
 * tower     1 2 3 4  6
 * fortress  1 3 6 9 12
 * ```
 *
 * Indexed with `base + setting`, base 0/5/10 per building type and setting =
 * `knightOccupation[threatLevel] & 0xf` (the **minimum** half of the slider, 0..4). That many knights
 * must stay in the building; only the surplus may attack.
 */
// prettier-ignore
export const ATTACK_GARRISON_RESERVE: readonly number[] = [
  1, 1, 2, 2, 3,
  1, 2, 3, 4, 6,
  1, 3, 6, 9, 12,
];

/** Base index into {@link ATTACK_GARRISON_RESERVE} per coded type; `null` = not a military building. */
export function attackReserveBase(codedType: number): number | null {
  if (codedType === 0x2c) return 0; //  hut
  if (codedType === 0x54) return 5; //  tower
  if (codedType === 0x58) return 10; // fortress
  return null;
}

/**
 * **Collect attackers** — `FUN_0002ae5a`. Walks {@link ATTACK_COLLECT_RINGS} rings around `targetPos`,
 * evaluates each tile with {@link collectTile} and finally writes count and sum:
 *
 * ```
 * player[0x12a..0x130] = 0                       // the four bands
 * pos = targetPos ; ring = 0 ; listLen = 0
 * do { pos = pos + Right
 *      for each of the 6 sides: (ring+1)x { collectTile(pos) ; pos = pos + side }
 *      ring++ } while (ring != 0x20)
 * player[0x128] = listLen >> 1                   // byte length => number of buildings
 * player[0x132] = sum of the four bands
 * ```
 *
 * Returns the total (in the original it stays in `vreg4` and the caller uses it as the upper bound of
 * the suggestion).
 */
export function collectAttackers(state: GameState, player: Player, targetPos: number): number {
  const geo = state.geo;
  for (let i = 0; i < 4; i++) player.attackingKnights[i] = 0;
  const list: number[] = [];

  let pos = targetPos;
  for (let ring = 0; ring < ATTACK_COLLECT_RINGS; ring++) {
    pos = neighbor(pos, Direction.Right, geo);
    for (const dir of ATTACK_RING_SIDES) {
      for (let step = 0; step <= ring; step++) {
        collectTile(state, player, list, pos, ring);
        pos = neighbor(pos, dir, geo);
      }
    }
  }

  player.attackingBuildings = list;
  player.attackingBuildingCount = list.length;
  const total =
    player.attackingKnights[0]! +
    player.attackingKnights[1]! +
    player.attackingKnights[2]! +
    player.attackingKnights[3]!;
  player.totalAttackingKnights = total;
  return total;
}

/**
 * Evaluating a single tile — `FUN_0002b02e`:
 *
 * ```
 * if (((landscape[pos*4+1] ^ 0x80) >> 5) != player[0]) ret        // not our own land
 * obj = landscape[pos*4+3] ; if (obj < 2 || obj > 4) ret          // no building on it
 * idx = game[pos]
 * for each entry of the list: if (idx == entry) ret               // already collected
 * base = base(bld[4] & 0xfc) ; no match => ret                    // military buildings only
 * if (listLen == 0x80) ret                                        // list full
 * if (bld[5] bit 5) ret                                           // burning
 * list[listLen] = idx ; listLen += 2
 * reserve = DAT_0002b1f4[base + (knightOccupation[bld[5] & 3] & 0xf)]
 * spare = (bld[8] >> 4) - reserve ; on borrow or 0 ret
 * player[0x12a + 2*(ring >> 3)] += spare
 * ```
 *
 * The `(byte ^ 0x80) >> 5` is the original's raw byte comparison: bit 7 (has owner) is flipped, after
 * which bits 5/6 give the owner index correctly only if bit 7 was set — unowned land yields `4..7` and
 * matches no player index. For the decoded `tile.owner` (1-based, 0 = unowned) that is equivalent.
 */
function collectTile(
  state: GameState,
  player: Player,
  list: number[],
  pos: number,
  ring: number,
): void {
  const tile = state.mapTiles[pos];
  if (tile === undefined) return;
  if (tile.owner !== player.slot + 1) return;
  if (tile.object < 2 || tile.object > 4) return;

  const idx = tile.objIndex;
  if (list.includes(idx)) return;

  const bld = state.buildings[idx];
  if (bld === null || bld === undefined) return;
  const base = attackReserveBase(codedBuildingType(bld));
  if (base === null) return;
  if (list.length === ATTACK_BUILDING_LIST_MAX) return;
  if (bld.burning) return;

  list.push(idx);

  const setting = (player.knightOccupation[bld.threatLevel] ?? 0) & 0xf;
  const reserve = ATTACK_GARRISON_RESERVE[base + setting] ?? 0;
  const free = (bld.stock[0]!.available & 0xf) - reserve;
  if (free <= 0) return;

  const band = ring >> 3;
  player.attackingKnights[band] = (player.attackingKnights[band] ?? 0) + free;
}

/**
 * **Preconditions and opening the attack window** — the attack branch of the map click (`@0x2a3d0`):
 *
 * ```
 * coded = bld[4] & 0xfc ; if (coded not in {0x2c,0x54,0x58,0x60}) ret     // not an attack target
 * if (!(bld[5] bit 4)) rejectSound(4)                                     // target not in service
 * if ((bld[5] & 3) != 3) rejectSound(4)                                   // threat level < 3
 * want = (player[0] + 4) << 5
 * for SPIRAL_PATTERN[7..264]:
 *     if ((landscape[(pos+off)*4+1] & 0xe0) == want) {                    // own land in range
 *         collect_attackers() ; sound(8)
 *         cap = suggestionLimit(targetType)
 *         player[0x136] = min(cap, available)
 *         panel icons = {0, 7, 9, 0xb, 0xd} ; vp[1] &= 0xfd ; vp[0x70] = 0x14
 *         return
 *     }
 * rejectSound(4)
 * ```
 *
 * Returns `null` when the original opens **no** window (with `reason` naming why), otherwise the
 * display values.
 *
 * **The sound belongs to the outcome, and one of the failures is SILENT.** The cascade has exactly
 * three exits: a wrong building type ends in a bare `ret` @0x2a459 with **no** sound — the original
 * does not count a click on a non-attackable building as an attempted action. Not in service
 * (`bt $0x4` @0x2a462), threat level != 3 (`cmpw $0x3` @0x2a480) and no own land in the spiral
 * (`jmp 0x2a62d` @0x2a503) all fall onto the **same** rejection tail and sound **4**. Success sounds
 * **8** (`mov $0x8 ; call 0x3688a` @0x2a516) — the "control hit" sound, **not** the execution sound 2.
 */
export const ATTACK_PREP_SOUND_REJECT = 4;
export const ATTACK_PREP_SOUND_OPEN = 8;

export type AttackPrepResult =
  | {
      readonly ok: false;
      readonly reason: 'notAttackable' | 'inactive' | 'threatLevel' | 'outOfRange';
      /** `null` for `notAttackable` — that branch is silent in the original. */
      readonly sound: number | null;
    }
  | {
      readonly ok: true;
      readonly suggestion: number;
      readonly available: number;
      readonly sound: number;
    };

export function prepareAttack(
  state: GameState,
  player: Player,
  target: Building,
): AttackPrepResult {
  const coded = codedBuildingType(target);
  // Silent: `ret` @0x2a459, still BEFORE the first sound branch.
  if (!ATTACKABLE_CODED_TYPES.includes(coded)) {
    return { ok: false, reason: 'notAttackable', sound: null };
  }
  const reject = ATTACK_PREP_SOUND_REJECT;
  if (!target.active) return { ok: false, reason: 'inactive', sound: reject };
  if ((target.threatLevel & 3) !== 3) return { ok: false, reason: 'threatLevel', sound: reject };

  const geo = state.geo;
  const targetPos = posOf(target.col, target.row, geo);
  let inRange = false;
  for (let i = 0; i < ATTACK_RANGE_SPIRAL_COUNT; i++) {
    const entry = SPIRAL_PATTERN[ATTACK_RANGE_FIRST_SPIRAL + i];
    if (entry === undefined) break; // the pattern has 289 entries, so 7..264 is inside it
    const p = posOf(colOf(targetPos, geo) + entry[0], rowOf(targetPos, geo) + entry[1], geo);
    if (state.mapTiles[p]?.owner === player.slot + 1) {
      inRange = true;
      break;
    }
  }
  if (!inRange) return { ok: false, reason: 'outOfRange', sound: reject };

  player.buildingAttacked = target.index;
  const available = collectAttackers(state, player, targetPos);
  const cap = attackSuggestionCap(coded);
  const suggestion = available < cap ? available : cap;
  player.knightsAttacking = suggestion;
  return { ok: true, suggestion, available, sound: ATTACK_PREP_SOUND_OPEN };
}

// --- The count buttons of the window -------------------------------------------------------------

/** Upper bound `FUN_0003164d` additionally checks (`cmpw $0x64`). */
export const ATTACK_COUNT_LIMIT = 100;

/**
 * **One knight fewer** — `FUN_000314f6`: `if (player[0x136] != 0) player[0x136]--`. Returns `true` when
 * something changed; only then does the original open screen 0x15.
 */
export function attackCountDecrement(player: Player): boolean {
  if (player.knightsAttacking === 0) return false;
  player.knightsAttacking -= 1;
  return true;
}

/**
 * **One knight more** — `FUN_0003164d`: raises the choice while it is neither at the available knights
 * (`player[0x132]`) **nor** at {@link ATTACK_COUNT_LIMIT}.
 */
export function attackCountIncrement(player: Player): boolean {
  if (player.totalAttackingKnights === player.knightsAttacking) return false;
  if (player.knightsAttacking === ATTACK_COUNT_LIMIT) return false;
  player.knightsAttacking += 1;
  return true;
}

/**
 * **Presets** — the four buttons `FUN_0003152b` / `FUN_00031560` / `FUN_00031595` / `FUN_000315f1` set
 * the choice to the **cumulative** sum of the first `bands` distance bands (1..4), i.e. from "only the
 * nearest" to "all".
 */
export function attackCountPreset(player: Player, bands: number): void {
  let sum = 0;
  for (let i = 0; i < bands; i++) sum += player.attackingKnights[i] ?? 0;
  player.knightsAttacking = sum;
}

// --- Launching the attack ------------------------------------------------------------------------

/** Knight state a dispatched attacker moves into (`mov $0x41` @0x31cf7). */
const ST_KNIGHT_LEAVE_FOR_WALK_TO_FIGHT = 0x41; // 65
/** Follow-up state that state 5 jumps to afterwards (`mov $0x35` @0x31cef). */
const ST_KNIGHT_FREE_WALKING = 0x35; // 53

/** UI sound numbers of the attack button (`play_ui_sound`). */
export const ATTACK_SOUND_REJECT = 4;
export const ATTACK_SOUND_CONFIRM = 2;

/**
 * Signed shortest torus offset in one dimension — the calculation the dispatch uses to put the target
 * delta into the knight's union (`@0x31c72..0x31ccd`): `d &= mask`, and if `d >= gs[0x40]` (half the
 * edge length) then `d -= gs[0x1c2]` (the whole edge length).
 */
function wrapDelta(d: number, size: number): number {
  d &= size - 1;
  return d >= size / 2 ? d - size : d;
}

/** How many knights the original dispatches per attack at most — the `player[0x136]` clamp. */
export interface AttackLaunchResult {
  /**
   * The sound the original plays: {@link ATTACK_SOUND_REJECT}, {@link ATTACK_SOUND_CONFIRM} — or
   * **`null`**, because the middle branch is **silent**. With `attackingBuildingCount == 0`,
   * `subw $0x1,vp[0x10] ; jb 0x316ee` @0x316d4 jumps over *both* the sound @0x316e4 **and** the
   * dispatch @0x316e9, straight to the closing jump.
   */
  readonly sound: number | null;
  /**
   * Whether the window closes. With `knightsAttacking == 0` the original returns **before** the closing
   * jump (`ret` @0x316c5), so the window stays open.
   */
  readonly closePopup: boolean;
  /** How many knights were actually dispatched. */
  readonly dispatched: number;
}

/**
 * **Launching the attack** — `attack_launch` @0x3169c, the handler of the attack button (action id
 * `0x4c`, screen 0x14/0x15):
 *
 * ```
 * player = vp[0x82]
 * if (player[0x136] == 0) { play_ui_sound(4) ; ret }   // no knights chosen => window stays open
 * vreg4 = player[0x128] ; subw $1 ; jb => skip         // no attacker buildings => close SILENTLY
 * play_ui_sound(2) ; attack_dispatch_knights()
 * jmp close_popup_reset_bar                            // tail jump @0x316ee
 * ```
 *
 * The two sounds are not a quirk of this button but the **pattern of every control action** in the
 * original: `2` = executed, `4` = rejected. The zone sound `8` of the click walker comes before it and
 * independently.
 *
 * The end is a **tail jump to `@0x285ae`** — the same block the exit button jumps into. Hence this
 * function returns `closePopup` and the UI calls its existing close path instead of duplicating the
 * panel icons.
 */
export function launchAttack(state: GameState, player: Player): AttackLaunchResult {
  if (player.knightsAttacking === 0) {
    return { sound: ATTACK_SOUND_REJECT, closePopup: false, dispatched: 0 };
  }
  if (player.attackingBuildingCount === 0) {
    // `jb 0x316ee` @0x316d9 — past sound AND dispatch onto the closing jump: silent.
    return { sound: null, closePopup: true, dispatched: 0 };
  }
  const dispatched = dispatchAttackers(state, player);
  return { sound: ATTACK_SOUND_CONFIRM, closePopup: true, dispatched };
}

/**
 * **Dispatching the knights** — `FUN_000316f3` @0x316f3, the callee of {@link launchAttack}.
 *
 * Walks the list of our own military buildings filled by {@link collectAttackers} and sends the surplus
 * over the mandatory garrison out of each, until `player[0x136]` (the number chosen in the window) is
 * used up:
 *
 * ```
 * target = buildings[player[0x134]]
 * coded = target[4] & 0xfc ; if (coded not in {0x2c,0x54,0x58,0x60}) ret
 * if (!(target[5] bit 4)) ret                   // not in service
 * if ((target[5] & 3) != 3) ret                 // threat level < 3
 * for i = 0 .. player[0x128]-1:                 // loop end: subw $1 / jae @0x31d27
 *     idx = player[0x7a + 2i]
 *     if (!bitmap[idx]) continue                // slot not occupied
 *     if (bld[5] bit 5) continue                // burning
 *     if (((landscape[pos+1] ^ 0x80) >> 5) != player[0]) continue      // not on our own land
 *     s = serfAt(pos + DownRight)
 *     if (s != 0 && (serfs[s][0] & 3) != player[0]) continue           // stranger on the flag
 *     base = {0x2c:0, 0x54:5, 0x58:10}[bld[4] & 0xfc] ; else continue  // the castle (0x60) sends NONE
 *     reserve = DAT_0002b1f4[base + (knightOccupation[bld[5] & 3] & 0xf)]
 *     surplus = (bld[8] >> 4) - reserve ; if (jb || je) continue       // strictly > 0
 *     while surplus != 0:
 *         knight = strongest/weakest of the garrison list                // player[2] bit 1
 *         unhook from the list ; bld[8] -= 0x10
 *         target[0xc] |= 1                                             // "is under attack"
 *         knight[0xb] = dCol ; [0xc] = dRow ; [0xd] = 0 ; [0xe] = 0 ; [0xf] = 53 ; [10] = 65
 *         if (--player[0x136] == 0) ret
 *         surplus--
 * ```
 *
 * **Not ported, because it is provably dead code**: after the type dispatch the original tests `bld[5]`
 * bit 5 a **second** time (`@0x31968`, this time with `ret` instead of "continue") — same register,
 * same building, and the branch is already excluded by the first test `@0x3181e`.
 */
export function dispatchAttackers(state: GameState, player: Player): number {
  const target = state.buildings[player.buildingAttacked];
  if (target == null) return 0;
  if (!ATTACKABLE_CODED_TYPES.includes(codedBuildingType(target))) return 0;
  if (!target.active) return 0;
  if ((target.threatLevel & 3) !== 3) return 0;

  const geo = state.geo;
  const strongerFirst = (player.flags & 2) !== 0; // player[2] Bit 1 — s. `savegame-format.md`
  let dispatched = 0;

  for (let i = 0; i < player.attackingBuildingCount; i++) {
    const idx = player.attackingBuildings[i];
    if (idx === undefined) break;
    // The original's bitmap test (`gs[0xa8]`, slot occupied) is the `null` slot in this model.
    const bld = state.buildings[idx];
    if (bld == null || bld.col === null || bld.row === null) continue;
    if (bld.burning) continue;

    const bldPos = posOf(bld.col, bld.row, geo);
    if (state.mapTiles[bldPos].owner !== player.slot + 1) continue;

    const occupant = state.mapTiles[neighbor(bldPos, Direction.DownRight, geo)].serfIndex;
    if (occupant !== 0 && (state.serfs[occupant]?.owner ?? -1) !== player.slot) continue;

    const base = attackReserveBase(codedBuildingType(bld));
    if (base === null) continue; // hut/tower/fortress only — the castle sends no knights

    const setting = (player.knightOccupation[bld.threatLevel] ?? 0) & 0xf;
    const reserve = ATTACK_GARRISON_RESERVE[base + setting] ?? 0;
    let surplus = (bld.stock[0].available & 0xf) - reserve;
    if (surplus <= 0) continue;

    while (surplus !== 0) {
      const knight = takeGarrisonKnight(state, bld, strongerFirst);
      if (knight === null) break; // empty list — impossible in the original, surplus > 0

      target.progress |= 1; // target[0xc] bit 0 — read by state 44 KnightEngagingBuilding
      sendKnightToTarget(state, knight, target);
      dispatched += 1;

      player.knightsAttacking -= 1;
      if (player.knightsAttacking === 0) return dispatched;
      surplus -= 1;
    }
  }
  return dispatched;
}

/**
 * Takes the knight matching {@link Player.flags} bit 1 out of a building's garrison list
 * (`@0x31a37..0x31b89`): walk the singly linked list (`building+10` -> `serf[0xe]`) completely,
 * remembering the **weakest** (bit 1 clear, the default) or **strongest** (bit 1 set) rank, then unhook
 * that entry and lower `building+8` by one knight.
 *
 * The comparison is on the raw type byte `serf[0] & 0x7c` (rank*4) — on a tie the **first** one found
 * wins (`jae` = "not better" skips the swap).
 */
function takeGarrisonKnight(state: GameState, bld: Building, strongerFirst: boolean): Serf | null {
  let best = -1;
  // vreg1 start value @0x31a0b/0x31a27: 0 resp. 0xffffffff. Only the **low byte** is compared
  // (`mov 0x4(%edi),%al` @0x31a80/0x31a9d), so 0xff is exactly equivalent to 0xffffffff as a sentinel.
  let bestRank = strongerFirst ? 0 : 0xff;
  for (let cur = bld.firstKnight; cur !== 0; ) {
    const serf = state.serfs[cur];
    if (serf == null) break;
    const rank = (serf.type << 2) & 0x7c;
    if (strongerFirst ? bestRank < rank : rank < bestRank) {
      bestRank = rank;
      best = cur;
    }
    cur = unionU16(serf, 0xe);
  }
  if (best < 0) return null;

  const chosen = state.serfs[best];
  if (chosen == null) return null;

  // Unhook: redirect either the head or the predecessor.
  if (bld.firstKnight === best) {
    bld.firstKnight = unionU16(chosen, 0xe);
  } else {
    let prev = bld.firstKnight;
    for (;;) {
      const p = state.serfs[prev];
      if (p == null) return null;
      const next = unionU16(p, 0xe);
      if (next === best) {
        setUnionU16(p, 0xe, unionU16(chosen, 0xe));
        break;
      }
      prev = next;
      if (prev === 0) return null;
    }
  }

  const s0 = bld.stock[0]; // bld[8] −= 0x10
  bld.stock[0] = { available: (s0.available - 1) & 0xf, requested: s0.requested };
  return chosen;
}

/**
 * Sets an unhooked knight onto the target building (`@0x31b8d..0x31cfe`): put the target delta into the
 * union as a signed tile difference and send it into state 65, with follow-up state 53
 * (`KnightFreeWalking`) — which state 5 fetches from `serf[0xf]` once the exit animation is done.
 *
 * The union afterwards matches the FreeWalking layout
 * (`dist_col`/`dist_row`/`neg_dist1`/`neg_dist2`), with both `neg_dist` at 0.
 */
function sendKnightToTarget(state: GameState, knight: Serf, target: Building): void {
  const geo = state.geo;
  const dCol = wrapDelta((target.col ?? 0) - (knight.col ?? 0), geo.cols);
  const dRow = wrapDelta((target.row ?? 0) - (knight.row ?? 0), geo.rows);
  knight.stateData[0] = dCol & 0xff; // serf[0xb] dist_col
  knight.stateData[1] = dRow & 0xff; // serf[0xc] dist_row
  knight.stateData[2] = 0; //           serf[0xd] neg_dist1
  knight.stateData[3] = 0; //           serf[0xe] neg_dist2
  knight.stateData[4] = ST_KNIGHT_FREE_WALKING; // serf[0xf] follow-up state
  knight.state = ST_KNIGHT_LEAVE_FOR_WALK_TO_FIGHT;
}
