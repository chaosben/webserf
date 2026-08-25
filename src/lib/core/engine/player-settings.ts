/**
 * **State changes of the eight distribution/option screens** — port of the action handlers behind the
 * click zones in `settings-popup.ts`.
 *
 * | Effect | Original |
 * |---|---|
 * | set a slider | handler prologue `subb $col*8` + shared body @0x2f89f |
 * | defaults | `FUN_0002bdf0` / `2be2c` / `2be76` / `2bec0` / `2bc4a` / `2bd1d` |
 * | knight occupation +- | @0x2f5e3 (max-), @0x2f638 (max+), @0x2f681 (min-), @0x2f6c6 (min+) |
 * | pick a priority slot | @0x2ee7c (transport) / @0x2eedd (retreat) |
 * | move a priority | @0x2ef18 (top), 2efae (up), 2f057 (down), 2f100 (bottom) |
 * | recruit the unemployed | `FUN_0002df33` |
 * | attack selection | @0x2e0a5 (`btr $1`) / @0x2e0df (`bts $1`) on `flags` |
 * | counter +- | @0x2de5c / @0x2de8f, clamped to 1..99 |
 * | **shift change** | @0x2dda4 -> {@link startKnightShift} / {@link tickKnightShift} |
 *
 * The shift-change button does **not** need the castle handler @0x14da5, which swaps knight ranks
 * between building and warehouse: that routine runs continuously, gated on
 * `knightMenuValue == knightMenuCounter`, and has nothing to do with the button. The button works
 * solely through the three states below — the two halves of the actual work live in the ejection
 * branch of the military handlers and in the rank floor of the knight request (both in
 * `serf-request.ts`).
 */
import { SLIDER_MAX_PIXELS, SLIDER_STEP } from '../ui-render.js';
import type { SliderSpec, PriorityKind, PriorityMove } from '../settings-popup.js';
import type { GameState, Inventory, Player, Serf } from './state.js';
import { setSerfType } from './state.js';
import { unionU16 } from './serf-machine.js';

const STATE_IDLE_IN_STOCK = 1;
const SERF_GENERIC = 21;
const SERF_KNIGHT0 = 22;
const RES_SWORD = 24;
const RES_SHIELD = 25;
/** Number of resource/priority entries (`0x1a` loop counter in every priority handler). */
const PRIORITY_COUNT = 26;

// --- Sliders -------------------------------------------------------------------------------------

/**
 * Pixel position of a click on a slider -> value. The original does it in two steps: the handler first
 * subtracts `col * 8` (its prologue, e.g. `subb $0x20` for column 4), the shared body @0x2f89f then
 * subtracts 7, and only **afterwards** checks the borrow and clamps:
 *
 * ```
 * subb $0x7,(%edi) ; jae ok ; vreg0 = 0 ; jmp mul     // borrow => 0
 * ok:  cmpb $0x33,(%edi) ; jb ok2 ; vreg0 = 0x32      // cap 50
 * ok2: movsbw (%edi),%ax
 * mul: vreg0 *= 0x51e
 * ```
 */
export function sliderValueFromClick(slider: SliderSpec, clickX: number): number {
  const local = (clickX - slider.col * 8) & 0xff; // handler prologue
  const after = local - 7; // shared body
  const px = after < 0 ? 0 : after >= SLIDER_MAX_PIXELS + 1 ? SLIDER_MAX_PIXELS : after;
  return (px * SLIDER_STEP) & 0xffff;
}

/**
 * Write a slider value into its target field. Takes only the **identity** (target list + index) rather
 * than the whole {@link SliderSpec}, so the command layer can name a slider without carrying the
 * layout fields along.
 */
export function writeSliderValue(
  player: Player,
  slider: Pick<SliderSpec, 'list' | 'index'>,
  value: number,
): void {
  if (slider.list === 'serfToKnightRate') {
    player.serfToKnightRate = value;
    return;
  }
  player[slider.list][slider.index] = value;
}

/** Apply a slider click (prologue + body + store, like one original handler). */
export function applySliderClick(player: Player, slider: SliderSpec, clickX: number): void {
  writeSliderValue(player, slider, sliderValueFromClick(slider, clickX));
}

// --- Defaults ------------------------------------------------------------------------------------

/**
 * The original defaults per screen, byte-exact from the setter routines. The values of the three
 * resource screens and the tool screen are **independently confirmed**: an untouched player in a real
 * save carries exactly these 14 + 9 numbers.
 */
export const SETTINGS_DEFAULTS: {
  readonly food: readonly number[];
  readonly planks: readonly number[];
  readonly steel: readonly number[];
  readonly coal: readonly number[];
  readonly wheat: readonly number[];
  readonly tools: readonly number[];
  readonly flagPriority: readonly number[];
  readonly inventoryPriority: readonly number[];
} = {
  // FUN_0002bdf0: player+0x140..0x146
  food: [13100, 45850, 45850, 65500],
  // FUN_0002be2c: player+0x148..0x150 (three plank and two steel targets in ONE routine)
  planks: [65500, 3275, 19650],
  steel: [45850, 65500],
  // FUN_0002be76: player+0x152..0x15a
  coal: [32750, 65500, 52400],
  wheat: [65500, 32750],
  // FUN_0002bec0: player-0x80.. (block 0..16), in field order
  tools: [9825, 65500, 13100, 6550, 13100, 26200, 32750, 45850, 6550],
  // FUN_0002bc4a: block 44.. — "wood first, gold last" (manual p. 105): plank 26, lumber 22, gold ore 1
  flagPriority: [
    20, 5, 19, 3, 4, 18, 22, 26, 6, 25, 21, 24, 23, 1, 2, 14, 15, 9, 10, 8, 12, 11, 13, 7, 17, 16,
  ],
  // FUN_0002bd1d: block 224.. — "save gold before wheat" (p. 107): gold bar 26, gold ore 25, wheat 1
  inventoryPriority: [
    5, 3, 6, 1, 2, 4, 7, 8, 9, 10, 12, 13, 11, 25, 26, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 23,
  ],
};

/** The screen's default button (each routine writes exactly its own fields). */
export function applySettingsDefaults(player: Player, screen: number): boolean {
  switch (screen) {
    case 0x1c:
      player.foodDistribution = [...SETTINGS_DEFAULTS.food];
      return true;
    case 0x1d:
      player.planksDistribution = [...SETTINGS_DEFAULTS.planks];
      player.steelDistribution = [...SETTINGS_DEFAULTS.steel];
      return true;
    case 0x1e:
      player.coalDistribution = [...SETTINGS_DEFAULTS.coal];
      player.wheatDistribution = [...SETTINGS_DEFAULTS.wheat];
      return true;
    case 0x20:
      player.toolPriority = [...SETTINGS_DEFAULTS.tools];
      return true;
    case 0x21:
      player.flagPriority = [...SETTINGS_DEFAULTS.flagPriority];
      return true;
    case 0x2e:
      player.inventoryPriority = [...SETTINGS_DEFAULTS.inventoryPriority];
      return true;
    default:
      return false;
  }
}

// --- Knight occupation ---------------------------------------------------------------------------

/**
 * A `-`/`+` on one occupation level. The byte is `(max<<4)|min`; each of the four handlers tests
 * **one** condition and otherwise does nothing (the original does not even redraw then, hence
 * `false`):
 *
 * - `max-`: nothing when `max == min` (manual p. 100: the upper setting cannot go below the lower).
 * - `max+`: nothing when `(b & 0xf0) == 0x40`, i.e. `max == 4`.
 * - `min-`: nothing when `min == 0`.
 * - `min+`: nothing when `max == min`.
 */
export function adjustKnightOccupation(
  player: Player,
  index: number,
  bound: 'max' | 'min',
  delta: -1 | 1,
): boolean {
  const b = player.knightOccupation[index];
  if (b === undefined) return false;
  const min = b & 0xf;
  const max = (b >> 4) & 0xf;
  if (bound === 'max') {
    if (delta < 0) {
      if (max === min) return false;
      player.knightOccupation[index] = b - 0x10;
    } else {
      if ((b & 0xf0) === 0x40) return false;
      player.knightOccupation[index] = b + 0x10;
    }
  } else if (delta < 0) {
    if (min === 0) return false;
    player.knightOccupation[index] = b - 1;
  } else {
    if (max === min) return false;
    player.knightOccupation[index] = b + 1;
  }
  return true;
}

// --- Priority lists ------------------------------------------------------------------------------

function priorityList(player: Player, kind: PriorityKind): number[] {
  return kind === 'transport' ? player.flagPriority : player.inventoryPriority;
}

function setPriorityCursor(player: Player, kind: PriorityKind, value: number): void {
  if (kind === 'transport') player.currentSett5Item = value;
  else player.currentSett6Item = value;
}

function priorityCursor(player: Player, kind: PriorityKind): number {
  return kind === 'transport' ? player.currentSett5Item : player.currentSett6Item;
}

/**
 * Click on a priority slot: `slot` 0 is the **highest** priority, i.e. value 26. The original looks for
 * the resource with that value and stores its **1-based** index as the cursor (`player+0xfa` /
 * `+0x15c`) — an unbounded `while` loop that always finds one, because the list is always a
 * permutation of 1..26. We check the bound anyway.
 */
export function selectPriorityItem(player: Player, kind: PriorityKind, slot: number): boolean {
  const wanted = PRIORITY_COUNT - slot;
  const list = priorityList(player, kind);
  const i = list.indexOf(wanted);
  if (i < 0) return false;
  setPriorityCursor(player, kind, i + 1);
  return true;
}

/**
 * Move the selected resource — four original variants:
 *
 * - `top`: `list[sel] = 27`, then `-1` on every larger value (the 27 becomes 26 itself).
 * - `bottom`: `list[sel] = 0`, then `+1` on every value `<= old` (the 0 becomes 1).
 * - `up`/`down`: **swap** with the neighbouring value; do nothing when already at 26 or 1.
 */
export function movePriorityItem(player: Player, kind: PriorityKind, move: PriorityMove): boolean {
  const list = priorityList(player, kind);
  const sel = priorityCursor(player, kind) - 1;
  const old = list[sel];
  if (old === undefined) return false;

  switch (move) {
    case 'top': {
      list[sel] = PRIORITY_COUNT + 1;
      for (let i = 0; i < PRIORITY_COUNT; i++) if (list[i]! > old) list[i]! -= 1;
      return true;
    }
    case 'bottom': {
      list[sel] = 0;
      for (let i = 0; i < PRIORITY_COUNT; i++) if (list[i]! <= old) list[i]! += 1;
      return true;
    }
    case 'up':
    case 'down': {
      const limit = move === 'up' ? PRIORITY_COUNT : 1;
      if (old === limit) return false;
      const want = move === 'up' ? old + 1 : old - 1;
      const j = list.indexOf(want);
      if (j < 0) return false;
      list[j] = old;
      list[sel] = want;
      return true;
    }
  }
}

// --- Knight menu ---------------------------------------------------------------------------------

/** Attack selection: `flags` bit 1 — set means the **stronger** knights attack (manual p. 101). */
export function setAttackSelection(player: Player, strong: boolean): void {
  player.flags = strong ? player.flags | 0x02 : player.flags & ~0x02;
}

// --- Shift change --------------------------------------------------------------------------------

/**
 * `flags` bit 2 — **a shift change is running.** The only reader is the countdown in the player tick
 * (`bt $0x2` @0xf0ed); it is set by the menu button (`bts` @0x2ddb8) and the AI counterpart
 * (@0x54862), and cleared by the countdown itself (`btr` @0xf122).
 */
export const PLAYER_FLAG_SHIFT_ACTIVE = 1 << 2;
/**
 * `flags` bit 4 — **lowered target occupancy** (phase 1). Read by the three military handlers
 * (`bt $0x4` @0x1555f/@0x155e3/@0x15667), which then index the consistently smaller second half of
 * their occupancy table, so the buildings are over-occupied and give knights away.
 */
export const PLAYER_FLAG_REDUCED_OCCUPANCY = 1 << 4;
/**
 * `flags` bit 5 — **rank floor on the knight request** (phase 2). The only reader is `request_serf`
 * (`bt $0x5` @0x124ea): it replaces the type parameter with `-((knightShiftTimer >> 8) + 1)`, from
 * which the request derives a minimum rank.
 */
export const PLAYER_FLAG_RANK_FLOOR = 1 << 5;

/** Start value of the countdown (`movw $0x4b0` @0x2ddc7 and @0x54871). */
export const KNIGHT_SHIFT_DURATION = 1200;
/** Switch point phase 1 -> phase 2 (`cmpw $0x3ff` @0xf133). */
export const KNIGHT_SHIFT_PHASE2_AT = 0x3ff;

/**
 * **Trigger a shift change** — `FUN_0002dda4` (button in the second knight menu, action `0xaf`; the AI
 * counterpart @0x54862 is the same three steps). The button itself moves no knight at all; it only
 * sets the three states at which the already running passes change their behaviour:
 *
 * 1. `flags` bit 2 (`bts $0x2`) — "a shift change is running", so the player tick counts down at all.
 * 2. `flags` bit 4 (`bts $0x4`) — phase 1: lowered target occupancy.
 * 3. `player+0x170 = 1200` — the clock.
 *
 * The manual (p. 101) describes exactly the effect of these three switches: one or more knights leave
 * every fully occupied building for the nearest warehouse, and replacements come out of the warehouse
 * — the **weakest** are sent back, the **strongest** are sent as replacements. The two halves live in
 * two different places of the engine: the sending back in the ejection branch of the military handlers
 * (@0x15707, which looks for the **lowest** rank in the garrison), the sending out in the rank floor
 * of the request (bit 5).
 *
 * Clicking again during a running shift change resets the clock and switches back to phase 1 — the
 * original checks nothing (`bts` is idempotent), so neither does the port.
 */
export function startKnightShift(player: Player): void {
  player.flags |= PLAYER_FLAG_SHIFT_ACTIVE | PLAYER_FLAG_REDUCED_OCCUPANCY;
  player.knightShiftTimer = KNIGHT_SHIFT_DURATION;
}

/**
 * **The countdown** — the bit-2 block of the player tick (@0xf0e5). Runs only with bit 2 set and moves
 * the shift change through its two phases:
 *
 * ```
 * subw $1, player[0x170]                       // @0xf0fc
 * if (result == 0)        { btr $5 ; btr $2 }  // @0xf10e/@0xf122 — done
 * else if (value == 0x3ff) { btr $4 ; bts $5 } // @0xf146/@0xf15a — phase 1 -> phase 2
 * ```
 *
 * **Phase 1** (lowered occupancy, the buildings give knights away) therefore lasts 1200 -> 1023 =
 * **177** ticks and **phase 2** (normal targets, but only high ranks out of the warehouse) the
 * remaining **1023**. The order matters: the test against `0x3ff` sees the **already decremented**
 * value.
 */
export function tickKnightShift(player: Player): void {
  if ((player.flags & PLAYER_FLAG_SHIFT_ACTIVE) === 0) return;
  player.knightShiftTimer = (player.knightShiftTimer - 1) & 0xffff;
  if (player.knightShiftTimer === 0) {
    player.flags &= ~(PLAYER_FLAG_RANK_FLOOR | PLAYER_FLAG_SHIFT_ACTIVE);
  } else if (player.knightShiftTimer === KNIGHT_SHIFT_PHASE2_AT) {
    player.flags &= ~PLAYER_FLAG_REDUCED_OCCUPANCY;
    player.flags |= PLAYER_FLAG_RANK_FLOOR;
  }
}

/** `-`/`+` on the counter `player+0x18a`, clamped to 1..99 (`cmpw $0x1` / `cmpw $0x63`). */
export function adjustKnightMenuValue(player: Player, delta: -1 | 1): boolean {
  if (delta < 0) {
    if (player.knightMenuValue === 1) return false;
    player.knightMenuValue -= 1;
  } else {
    if (player.knightMenuValue === 99) return false;
    player.knightMenuValue += 1;
  }
  return true;
}

/** All warehouses of the player, in slot-index order, the way the original walks them. */
function ownInventories(state: GameState, player: Player): Inventory[] {
  const out: Inventory[] = [];
  for (const inv of state.inventories) if (inv !== null && inv.owner === player.slot) out.push(inv);
  return out;
}

/**
 * "At most recruitable" — the number at the top right of the knight menu. The original sums
 * `min(inv+0x40, inv[sword], inv[shield])` per warehouse, i.e. free settlers **and** weapon pairs in
 * the **same** warehouse (@0x3ca4a).
 */
export function countRecruitable(state: GameState, player: Player): number {
  let total = 0;
  for (const inv of ownInventories(state, player)) {
    let n = inv.genericCount;
    if (inv.resources[RES_SWORD]! < n) n = inv.resources[RES_SWORD]!;
    if (inv.resources[RES_SHIELD]! < n) n = inv.resources[RES_SHIELD]!;
    total += n;
  }
  return total;
}

/**
 * **Recruit the unemployed directly** (`FUN_0002df33`) — the four buttons 1/5/20/100. Walks the serf
 * slots from the bottom and turns every idle generic into a knight 0, as long as its warehouse holds
 * sword **and** shield:
 *
 * ```
 * for every live serf i < maxSerfIndex:
 *   state == 1 (IdleInStock) ; owner == player ; (type<<2) == 0x54 (generic)
 *   inv = inventories[serf[0xe]] ; inv[sword] != 0 ; inv[shield] != 0
 *   inv[sword]-- ; inv[shield]-- ; inv+0x40-- ; inv+0x6c = 0
 *   serf[0] = owner | 0x58                      // knight 0, clearing the sound bit on the way
 *   serfCount[generic]-- ; serfCount[knight0]++ ; totalMilitaryScore++
 *   stop once `limit` is reached
 * ```
 *
 * Returns how many were made (the original plays a sound only for > 0).
 */
export function recruitKnights(state: GameState, player: Player, limit: number): number {
  let made = 0;
  const max = state.header.maxSerfIndex;
  for (let i = 0; i < max && made < limit; i++) {
    const serf: Serf | null = state.serfs[i] ?? null;
    if (serf === null) continue;
    if (serf.state !== STATE_IDLE_IN_STOCK) continue;
    if (serf.owner !== player.slot) continue;
    if (serf.type !== SERF_GENERIC) continue;
    // `inv = inventories[serf[0xe]]` — the **raw** union bytes, like the original. A decoded view
    // would be wrong here, because the engine only ever writes the union bytes (for example
    // `releaseCastleKnight`, which puts a knight into a warehouse with `state = 1` and
    // `serf[0xe] = invIndex`).
    const inv = state.inventories[unionU16(serf, 0xe)] ?? null;
    if (inv === null) continue;
    if (inv.resources[RES_SWORD] === 0 || inv.resources[RES_SHIELD] === 0) continue;

    inv.resources[RES_SWORD] -= 1;
    inv.resources[RES_SHIELD] -= 1;
    inv.genericCount -= 1;
    inv.serfIndices[SERF_GENERIC] = 0; // inv+0x6c = 0 — drop the cached generic pointer
    setSerfType(serf, SERF_KNIGHT0);
    serf.sound = false; // `serf[0] &= 3` clears bit 7 as well
    player.serfCount[SERF_GENERIC] -= 1;
    player.serfCount[SERF_KNIGHT0] += 1;
    player.totalMilitaryScore += 1;
    made += 1;
  }
  return made;
}
