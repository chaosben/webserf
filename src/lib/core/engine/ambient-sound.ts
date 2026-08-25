/**
 * **Ambient sounds** — `viewport_ambient_audio` (@0xef29) and its worker `FUN_0000ef4a` @0xef4a.
 *
 * The second call in `updateEconomy` (@0xeca2). Three branches — birdsong, water, wind — fed by two
 * **visibility counters** of the last drawing pass.
 *
 * ## What the original actually does (and what a port must NOT "fix")
 *
 * Of the three branches **only the bird branch enqueues a sound** (`call 0x3688a`
 * `enqueue_sound_priority` @0xef9c). Water (@0xefef) and wind (@0xf030) each set a volume byte and
 * put their sound number (0x56 / 0x58) into the return value — but **no** call follows, and the
 * caller @0xef29 discards the return value. Between @0xefef and the next block start there is no
 * `call`, likewise after @0xf030. So in the original one hears **only the birds**; the other two
 * branches merely maintain their volume. Reproduced as is, deliberately not completed.
 *
 * ## The pace, and why the random draw lives here
 *
 * `rng_next` is drawn **once per call** (@0xef5f), right behind the gate and **before** all counter
 * tests. The draw therefore does not depend on anything being visible — and hence not on whether we
 * are drawing at all. That is exactly why this pass lives in the **engine** and not in the drawing
 * pass: the game state (the random stream) evolves identically headless and with a renderer. Only
 * the *sound output* depends on the counters, and that is not game state.
 *
 * ## The counters (renderer -> engine, one frame late)
 *
 * `vp+0x1b4` and `vp+0x1b6` are maintained by the map drawing pass: its head @0x33ded zeroes both
 * (@0x33e08/@0x33e15), then @0x34045 counts every tile with the **water bit** and @0x340b1 every
 * object in the **tree range** (`(obj & 0x7f) - 8 < 0x18`). In the frame loop `updateEconomy`
 * (@0xbdfa) runs **before** the drawing passes (@0xbe1d ff.), so the ambient pass reads the counters
 * of the **previous** frame. Our model does the same: the renderer writes
 * `state.ambient.waterTiles`/`.treeObjects`, the next frame tick reads them.
 *
 * With no renderer running the counters stay 0 — then bird and water branch do nothing while the
 * random draw still happens. That is exactly the original's behaviour for a view without trees and
 * water.
 *
 * Split screen: the original calls the worker for both viewports, but both calls sit behind the
 * "viewport disabled" bit, and in single player the second viewport is disabled and therefore draws no
 * random value. We have exactly one viewport, hence one call.
 */

import type { GameState } from './state.js';

/** Base sound number of the four bird calls (`addw $0x46` @0xef98). */
const BIRD_SOUND_BASE = 0x46;
/** Sound number of the water (`mov $0x56` @0xefef) — **not** enqueued in the original. */
export const AMBIENT_WATER_SOUND = 0x56;
/** Sound number of the wind (`mov $0x58` @0xf030) — **not** enqueued in the original. */
export const AMBIENT_WIND_SOUND = 0x58;
/** Upper bound of the water volume before the base is added (`cmpw $0x14` @0xefc7). */
const WATER_VOLUME_CAP = 0x14;

/**
 * State of the ambient sound pass. **Not a save field** — purely renderer coupling, like
 * `territoryVersion` and `roadBuildAborted`.
 */
export interface AmbientState {
  /** `vp+0x1b4` — visible tiles with the water bit, counted by the drawing pass. */
  waterTiles: number;
  /** `vp+0x1b6` — visible tree objects, counted by the drawing pass. */
  treeObjects: number;
  /** Vom letzten Pass einzureihender Klang (`null` = keiner). Der Renderer holt ihn ab. */
  sound: number | null;
  /** Volume of the water voice (`[gs+0xe8]+0x158` @0xefe9); `null` = not set in this pass. */
  waterVolume: number | null;
  /** Volume of the wind voice (`[gs+0xe8]+0x160` @0xf02a); `null` = not set in this pass. */
  windVolume: number | null;
}

export function createAmbientState(): AmbientState {
  return { waterTiles: 0, treeObjects: 0, sound: null, waterVolume: null, windVolume: null };
}

/**
 * One run of the ambient sound pass for our single viewport.
 *
 * Always draws **exactly one** random value and evaluates the three branches from it. The result
 * lands in `state.ambient`; enqueueing is the display layer's job.
 */
export function viewportAmbientAudio(state: GameState): void {
  const a = state.ambient;
  // Discard the previous pass's result — the original keeps nothing, it enqueues immediately.
  a.sound = null;
  a.waterVolume = null;
  a.windVolume = null;

  // @0xef52 `bt $0x0` — the "viewport disabled" gate. We have exactly one, always active viewport;
  // the original's second call is for the split-screen viewport (see module head).

  const r = state.rng.next(); // @0xef5f — once per call, BEFORE all counter tests

  // -- Birds (@0xef67..@0xef9c) — the only branch that really enqueues a sound.
  if (a.treeObjects !== 0) {
    // @0xef88 `cmp %ax,(%edi)` + @0xef8b `jb`: skipped when treeObjects < (r & 0x3ff), so the more
    // trees are visible the more often it sings.
    if ((r & 0x3ff) <= a.treeObjects) {
      a.sound = BIRD_SOUND_BASE + (r & 0xc); // 0x46 / 0x4a / 0x4e / 0x52
    }
  }

  // -- Water (@0xefa1..@0xeff4) — sets ONLY the volume, enqueues nothing (no `call`).
  if (a.waterTiles !== 0) {
    if ((r & 0xf00) === 0) {
      const v = a.waterTiles >>> 3; // @0xefc3
      a.waterVolume = (v < WATER_VOLUME_CAP ? v : WATER_VOLUME_CAP) + 2; // @0xefc7/@0xefd4
      // @0xefef puts sound number 0x56 into the return value only — the caller discards it.
    }
  }

  // -- Wind (@0xeff6..@0xf035) — no counter, and likewise no enqueue.
  if ((r & 0x3000) === 0) {
    a.windVolume = (r & 1) + 2; // @0xf01a/@0xf01f
    // @0xf030 puts 0x58 into the return value — likewise discarded.
  }
}
