/**
 * Deterministic logic tick. `tick(state)` advances the game tick by one unit and calls the subsystem
 * drivers in the exact order of the original frame loop:
 *
 * ```
 * FUN_0000ec9d  economy              economy.ts (+ map-growth, ambient-sound)
 * FUN_0000f787  frame rotation/AI    ai-tick.ts
 * FUN_0004b858  flag goods scheduler flag-update.ts
 * FUN_000130f2  building driver      buildings.ts
 * FUN_0001599e  serf driver          serf-machine.ts
 * FUN_0000c100  statistics recorder  stats-recorder.ts
 * FUN_000335ad  recall queue         message-recall.ts
 * ```
 *
 * The ORDER is semantics, not taste: {@link dispatchFrameRotation} writes the rotation and must run
 * before the flag and building drivers - placed after them, rotation 0 never reaches either and the
 * blocks `[0,32)` starve.
 *
 * The core is fully deterministic: same starting state plus same number of ticks yields a bit-identical
 * successor, RNG included. That rests on a fixed logic timestep (`gameTick` grows by exactly 1, and
 * wall-clock time only decides how many ticks fire per second), a fixed driver order, a fixed entity
 * order, and hence a fixed RNG call sequence. The original instead couples `gameTick` to a wall-clock
 * timer with a variable delta per frame - a deliberate deviation, unsuitable for a reproducible clone.
 *
 * Deliberately not reproduced: the original's 1/16 serf rotation, which is pure CPU load spreading. For
 * accumulating counters it is equivalent to "every serf every tick" thanks to the tick prologue's
 * catch-up. Reproducing it was also measured and made things worse, because serf state in a snapshot is
 * sensitive to counter VALUES and staggering them mismatches the paused snapshot the original wrote.
 *
 * Three consumers run per FRAME, not per tick (the original separates a ~100 Hz tick timer from a
 * ~12.5 fps frame loop): the flag goods scheduler, the round-robin housekeeping and the building worker
 * request. Each processes only the 32-block `rotation` per frame, so every entity comes up once per
 * cycle. Unlike the serf counters this cadence is NOT equivalent to per-tick, because these consumers
 * are event driven - a faster cadence would start a carrier instantly instead of after the original's
 * couple of seconds. The frame phase is stored in the save, so seeding it reproduces it.
 *
 * {@link advanceFrameClock} is the single owner of the sub-frame counter and the rotation, so the three
 * frame consumers are pure and fire guaranteed on the same tick.
 */
import { addU16 } from './int.js';
import type { GameState } from './state.js';
import { dispatchSerf } from './serf-machine.js';
import { updateBuildings } from './buildings.js';
import { updateFlags } from './flag-update.js';
import { updateEconomy } from './economy.js';
import { updateAllKnightMorale } from './knight-morale.js';
import { distributeInventoryGoods } from './inventory-distribute.js';
import { updateAllPlayerHints } from './player-hints.js';
import { recordStats } from './stats-recorder.js';
import { updatePopulationAllowance } from './population.js';
import { advanceRecallQueues } from './message-recall.js';
import { AI_FIRST_ROTATION, runAiEarlyProbe, runAiPhaseSweep } from './ai-tick.js';
import { aiPressureTick } from './ai-pressure.js';

/**
 * Serf iteration driver (`FUN_0001599e`) — every occupied slot, strictly index-ascending, dispatched
 * **every tick**. The fixed order is part of the determinism contract: it pins the RNG call order.
 */
export function updateSerfs(state: GameState): void {
  const { serfs } = state;
  for (let i = 0; i < serfs.length; i++) {
    const serf = serfs[i];
    if (serf !== null) dispatchSerf(state, serf);
  }
}

/** Frame length in game ticks: 1 frame = 8 ticks. */
export const FRAME_TICKS = 8;

/**
 * **The original's frame number** — `gameTick` grows by 8 per frame, so the frame loop runs at
 * ~12.5/s, and this is the number the original builds its animation phases from.
 *
 * It lives here rather than as a `>> 3` at the call site because it has **three** consumers that must
 * agree: the sound pass may enqueue once per frame, the draw pass should draw once per frame, and both
 * must mean the same frame.
 */
export function logicFrame(gameTick: number): number {
  return Math.floor(gameTick / FRAME_TICKS);
}

/**
 * Rotation at which the frame driver branches into the **economy phases** (`subw $0x20 ; jae 0xf8a2`
 * @0xf7bb). Rotations 0..31 belong to the entity blocks, 32..48 to the 17 phases of the table
 * @0xf8b3 — and that length (17 == 49 - 32) confirms the wrap of 49 independently.
 */
const ECONOMY_PHASE_ROTATION = 32;

/**
 * Central frame clock (the rotation advance of `FUN_0000f787`). Counts `frameAccum` up; on reaching the
 * frame length it resets and advances the rotation (wrap at `rotationWrap`, fallback 49). Returns
 * whether this tick is a **frame boundary**. The single owner of `frameAccum` and `rotation`.
 */
export function advanceFrameClock(state: GameState): boolean {
  state.frameAccum += 1;
  if (state.frameAccum < FRAME_TICKS) return false;
  state.frameAccum = 0;
  const wrap = state.rotationWrap > 0 ? state.rotationWrap : 49;
  state.rotation = (state.rotation + 1) % wrap;
  return true;
}

/**
 * **The dispatch half of `advance_frame_rotation`** (`FUN_0000f787`, from `subw $0x20 ; jae` @0xf7bb)
 * — the rest of the routine whose counter half is {@link advanceFrameClock}.
 *
 * **It MUST run before the flag and building drivers.** `call 0xf787` @0xbdff sits immediately before
 * `call 0x4b858` @0xbe04 and `call 0x130f2` @0xbe09, and that is the only way the blocks of
 * **rotation 0** are ever processed: the AI sweep owns the rotation for the rest of its frame and sets
 * it to 0 itself on the wrap (`xor %ax,%ax` @0xfb37). Placed after the two drivers, they see the old
 * rotation in that frame and 1 in the next, so blocks `[0,32)` never come up — a resource on a flag
 * with index < 32 would lie there forever.
 */
function dispatchFrameRotation(state: GameState): void {
  if (state.rotation === ECONOMY_PHASE_ROTATION) {
 // Economy phase 0 of the table @0xf8b3 (index = rotation - 32): the goods distribution tick
 // `FUN_0000fc21`. Its first instruction `call 0x11752` recomputes the morale of all four players
 // and zeroes the gold accumulators. The order below is the call order in its head.
    updateAllKnightMorale(state); // @0xfc21 `call 0x11752`
    updatePopulationAllowance(state); // @0xfc34 `call 0x109b6` — `build` bit 2, the gate of `spawnSerf`
    aiPressureTick(state); // @0xfc39 `call 0x10d0f` — AI build pressure (the time axis of its decisions)
    updateAllPlayerHints(state); // @0xfc3e `call 0x11171` — hint messages + returning the reserve
    distributeInventoryGoods(state); // from @0xfc43 (RNG draw) — the distribution itself
  } else if (state.rotation >= AI_FIRST_ROTATION) {
 // Slots 1..16 of the same table == the four byte-identical player bodies of the AI tick. The
 // sweep **owns the rotation** for the rest of this frame: its reject path advances it itself
 // (`addw $0x1,0x26c` @0xfa0a), falls into the next body, and past the fourth a loop (@0xfb17)
 // burns through to the wrap.
    runAiPhaseSweep(state);
  } else {
 // Rotation 0..31 — the early probing branch @0xf7c5…@0xfc20 (one player per frame, only while
 // the world has fewer than 50 flags).
    runAiEarlyProbe(state);
  }
}

/** Run one deterministic logic tick (mutates `state` in place). */
export function tick(state: GameState): void {
  state.gameTick = addU16(state.gameTick, 1);
  const frameBoundary = advanceFrameClock(state);

 // Subsystem drivers in frame-loop order, one per original routine. Frame-paced parts run only on a
 // boundary; the rotation has already been advanced.
  updateEconomy(state, frameBoundary); // FUN_0000ec9d @0xbdfa — player tick every tick, round robin per frame
  if (frameBoundary) dispatchFrameRotation(state); // rest of FUN_0000f787 @0xbdff
  if (frameBoundary) updateFlags(state); // FUN_0004b858 @0xbe04 — goods scheduler
  if (frameBoundary) updateBuildings(state); // FUN_000130f2 @0xbe09 — includes request_serf phase A

  updateSerfs(state); // FUN_0001599e @0xbe0e
 // FUN_0000c100 — statistics recorder + victory detection. The call sits @0xbe18 right behind the
 // serf driver in the frame loop and gates itself internally on its two interval clocks.
  if (frameBoundary) recordStats(state);
 // FUN_000335ad — the recall half of `draw_message_overlay`, called right behind the recorder
 // (@0xbe22). What it subtracts is `gs+0x284`, the tick difference since the last frame; the
 // original's gates admit exactly one viewport, hence exactly one pass per frame.
  if (frameBoundary) advanceRecallQueues(state, FRAME_TICKS);
 // `add %ax,0x288(%ebx)` @0xd38b — the same frame driver block adds the tick difference to the
 // build-pressure accumulator, which `aiPressureTick` reads and zeroes at rotation 32.
  if (frameBoundary) state.aiPressureAccum = (state.aiPressureAccum + FRAME_TICKS) & 0xffff;
}

/** Run `n` logic ticks in sequence. */
export function runTicks(state: GameState, n: number): void {
  for (let i = 0; i < n; i++) tick(state);
}
