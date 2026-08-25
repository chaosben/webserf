/**
 * AI build pressure - `FUN_00010d0f` (head) and `FUN_00010d71` (body per player), called from the
 * goods distribution tick at rotation 32. It is the TIME axis of the AI's build decision: the site
 * evaluation says where a project would be good, this pass says how urgent it has become, and the
 * decider multiplies the two.
 *
 * The head keeps the length of the last interval and starts a new one. `gs+0x288` is counted up in the
 * frame driver by the tick difference per frame, so it is the game time since the last pressure pass
 * and `gs+0x28a` the length of the last completed interval - the reference for every rate below.
 * Neither field is in the save.
 *
 * The catch-up pressure `player+0x1b8` decays with time and is pulled up from the ratio of land to
 * building score. The direction is the OPPOSITE of what a quick reading suggests: `q` is large when
 * much land meets few buildings, and `q ^ 0x3ff` turns that into a small value - so pressure rises on
 * DENSELY built territory. The value is only ever raised, never lowered: a maximum holder with time
 * decay. The build decider reads it as the floor the highest urgency must exceed before anything is
 * built.
 *
 * The 25 counters are 25 byte-identical blocks (source -> add -> saturate at `0xffff`), and their
 * increments are cascaded from the interval length by repeated halving. All 16-bit, overflows
 * included.
 *
 * Counter index and project are a permutation - each evaluator reads exactly one counter:
 *
 * | Counter | Project |
 * |---|---|
 * | 0..22 | building type n + 1 (fisher .. gold smelter) |
 * | 23 | 25 == the geologist |
 * | 24 | 0 == the flag |
 *
 * Building type 24 (castle) has no counter - it is built only once. The rates read accordingly: the
 * fastest two are the guard hut and the geologist, the two things a settling AI needs continuously.
 */
import type { GameState, Player } from './state.js';

/** 25 counters from `player+0x402`; `1154 + 25*2 == 1204` == start of the candidate table. */
export const AI_PRESSURE_COUNT = 25;

/**
 * Increment per counter as a **shift of the interval length**: positive == right shift (`I >> n`),
 * `-1` == doubling (`I + I`). Read from the instruction stream (@0x10e7f ff., 25 blocks).
 *
 * The index is the **counter** index, not the building type — see the module head for the mapping.
 */
export const AI_PRESSURE_SHIFT: readonly number[] = [
  3, 2, 4, 3, 1, 1, 1, 1, 2, 3, -1, 2, 2, 2, 2, 2, 2, 2, 3, 2, 2, 2, 2, -1, 2,
];

/** `cmpw $0x400` @0x10dfb — from this quotient on the catch-up pressure is not raised. */
export const AI_CATCHUP_LIMIT = 0x400;
/** `xorw $0x3ff` @0x10e03 — inversion within 10 bits. */
export const AI_CATCHUP_MASK = 0x3ff;
/** `shll $0x7` @0x10dde — the land score is scaled by 128 before the division. */
export const AI_CATCHUP_NUMERATOR_SHIFT = 7;
/** `shlw $0x6` @0x10e09 — the 10-bit result onto the 16-bit scale. */
export const AI_CATCHUP_RESULT_SHIFT = 6;

/** `bt $0x7,player[2]` — AI player. */
const PLAYER_FLAG_AI = 0x80;
/** `bt $0x6,player[2]` — slot occupied. */
const PLAYER_FLAG_ACTIVE = 0x40;

/**
 * The increments of one interval, in the original's cascaded form: `I>>1` comes from `I`, `I>>2` from
 * `I>>1` and so on (@0x10e44..@0x10e6c), the doubling as `I + I` (@0x10e77). The cascade is equivalent
 * to a direct shift; it is reproduced because it fixes the order of the roundings.
 */
function pressureSteps(interval: number): (shift: number) => number {
  const i = interval & 0xffff;
  const half = i >>> 1;
  const quarter = half >>> 1;
  const eighth = quarter >>> 1;
  const sixteenth = eighth >>> 1;
  const twice = (i + i) & 0xffff;
  return (shift) => {
    switch (shift) {
      case 1: return half;
      case 2: return quarter;
      case 3: return eighth;
      case 4: return sixteenth;
      case -1: return twice;
      default: return i;
    }
  };
}

/**
 * **The body** `FUN_00010d71` — one player's build pressure. Does nothing for non-AI and inactive
 * slots (two separate bit tests, as in the original).
 */
export function aiPressurePlayer(player: Player, interval: number): void {
  if ((player.flags & PLAYER_FLAG_AI) === 0) return; // @0x10d83 → ret @0x10d99
  if ((player.flags & PLAYER_FLAG_ACTIVE) === 0) return; // @0x10d97 → ret @0x10d99

 // Catch-up pressure: time decay, then the rise from land/buildings.
 // `sub %ax,0x1b8(%ebx) ; jae` @0x10dad — an underflow clamps to 0.
  const decayed = (player.aiPressureCatchUp - (interval & 0xffff)) & 0xffff;
  player.aiPressureCatchUp = player.aiPressureCatchUp >= (interval & 0xffff) ? decayed : 0;

  const buildingScore = player.totalBuildingScore & 0xffff;
  if (buildingScore !== 0) { // @0x10dd0 — otherwise no rise at all
 // `shll $0x7` on the 32-bit number, then `div %cx` (32/16). The quotient is 16-bit in the
 // original, so an overflow would be a division exception. The bound below cannot prevent it — it
 // sits BEHIND the division (`div %cx` @0x10df0, `cmpw $0x400,0x4(%edi)` @0x10dfb). What prevents
 // it is the ratio itself: an overflow needs `land >= 512 * buildings`, and in practice it is
 // below 15.
    const q = Math.floor((player.totalLandScore << AI_CATCHUP_NUMERATOR_SHIFT) / buildingScore);
    if (q < AI_CATCHUP_LIMIT) { // @0x10e01
      const value = ((q ^ AI_CATCHUP_MASK) << AI_CATCHUP_RESULT_SHIFT) & 0xffff;
 // `cmp %ax,0x4(%edi) ; jb` @0x10e1c — raise only, never lower.
      if (value >= player.aiPressureCatchUp) player.aiPressureCatchUp = value;
    }
  }

 // The 25 counters: increment with saturation.
  const step = pressureSteps(interval);
  for (let n = 0; n < AI_PRESSURE_COUNT; n++) {
    const sum = (player.aiPressure[n] ?? 0) + step(AI_PRESSURE_SHIFT[n] ?? 0);
 // `add` + `jae` over the saturation: a carry out of the 16-bit word yields the saturation value.
 // The original stores it as a **32-bit** `0xffffffff` at `0x1c(%edi)` (@0x10e2c) but reads only the
 // low half word, so the effective value is `0xffff`.
    player.aiPressure[n] = sum > 0xffff ? 0xffff : sum;
  }
}

/**
 * **The head** `FUN_00010d0f` — closes the running interval and walks all four player slots. The call
 * sits in the goods distribution tick (@0xfc39), so it runs at rotation 32.
 */
export function aiPressureTick(state: GameState): void {
  const interval = state.aiPressureAccum & 0xffff; // @0x10d12
  state.aiPressureLast = interval; // @0x10d1c — gs[0x28a]
  state.aiPressureAccum = 0; // @0x10d29
  for (let slot = 0; slot < 4; slot++) {
    const player = state.players[slot];
 // The original calls the body for ALL four slots; the gate sits in the body, not here.
    if (player) aiPressurePlayer(player, interval);
  }
}
