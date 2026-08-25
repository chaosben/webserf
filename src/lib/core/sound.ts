/**
 * Sound queueing and voice assignment.
 *
 * The original has **no** "is the cause of the noise visible?" test. The effect sounds are queued by
 * the **drawing passes themselves** (`sound-emit.ts`); whatever is not drawn queues nothing. This
 * module is the stage after that: a **4-slot priority queue** per viewport, drained once per frame
 * into four **voices**.
 *
 * Backend-free: `serviceSound` returns the sounds to start as data and knows neither Web Audio nor
 * the archive (the same cut as `draw-target.ts` makes for drawing).
 *
 * Original addresses: `enqueue_sound_priority` @0x3688a · `enqueue_sound_if_y_visible` @0x36930 ·
 * `enqueue_sound_if_visible` @0x3693e · drain `FUN_00061fe3` @0x61fe3 · `sound_start` @0x6217a ·
 * duration countdown `FUN_00061c93` @0x61cc8 ff. · parameter table `sfx_param_table` @0x61952.
 */

import { Rng } from './engine/rng.js';

/** Number of voices. Four — exactly the queue's four slots (`sfx_driver_play` `cmp $0x3 ; ja`). */
export const SOUND_VOICES = 4;

/** "No sound" / free voice. Initial value of all four voices (`mov $0xff,%al` @0x44aa ff.). */
export const SOUND_NONE = 0xff;

/**
 * Archive slot of a sound (0-based, the way our parser counts).
 *
 * `sfx_driver_play` @0x20e2/@0x2107 computes `archive + 8·sound + 0x79e0` with `0x79e0 = 8·3899 + 8`.
 * Both readings of `0x79e0` are arithmetically possible; **decided on data**: across the 37 sound
 * indices used in the binary this base hits 37/37 occupied TOC slots, 3898 and 3900 only 4/37 each,
 * 3901 only 27/37 (the SFX bank is full of holes, which is what makes the test sharp).
 */
export const SFX_ARCHIVE_BASE = 3899;

/** Resolves a sound index to its archive slot. */
export const sfxArchiveSlot = (sound: number): number => SFX_ARCHIVE_BASE + sound;

/** One entry of the parameter table. */
export interface SoundParams {
  /** Base volume (byte 0). */
  readonly volume: number;
  /** Random mask on the volume (byte 1) — only 0/7/15/31 in the binary. */
  readonly volumeMask: number;
  /** Duration in service ticks (bytes 2-3, u16). */
  readonly duration: number;
}

/**
 * `sfx_param_table` @0x61952 — 0x180 bytes, stride 4, hence **96 entries**, indexed by the sound
 * index (largest index used in the binary is 0x58 = 88 < 96). 39 entries are occupied.
 *
 * Two occupied entries are reached by none of the 121 call sites: **0x0e** (overwritten by 0x12
 * immediately in the combat branch, see `sound-emit.ts`) and **0x3a** (no known caller — open).
 *
 * For water (0x56) and wind (0x58) the volume is **0**: in the original those two ambient voices
 * write it themselves beforehand, from the number of visible water triangles.
 */
const PARAM_TABLE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [64, 0, 11], [64, 0, 5], [0, 0, 0], // 0x00
  [64, 0, 10], [0, 0, 0], [40, 0, 4], [0, 0, 0], // 0x04
  [50, 0, 7], [0, 0, 0], [40, 15, 11], [0, 0, 0], // 0x08
  [0, 0, 0], [0, 0, 0], [40, 15, 13], [0, 0, 0], // 0x0c
  [0, 0, 0], [0, 0, 0], [40, 15, 11], [0, 0, 0], // 0x10
  [0, 0, 0], [0, 0, 0], [40, 15, 6], [0, 0, 0], // 0x14
  [0, 0, 0], [0, 0, 0], [40, 15, 17], [0, 0, 0], // 0x18
  [40, 15, 5], [0, 0, 0], [20, 15, 7], [0, 0, 0], // 0x1c
  [40, 15, 6], [0, 0, 0], [40, 15, 35], [0, 0, 0], // 0x20
  [20, 15, 5], [0, 0, 0], [35, 15, 4], [0, 0, 0], // 0x24
  [40, 15, 7], [0, 0, 0], [20, 7, 16], [15, 7, 31], // 0x28
  [15, 7, 4], [0, 0, 0], [40, 15, 5], [0, 0, 0], // 0x2c
  [40, 15, 4], [0, 0, 0], [40, 15, 8], [0, 0, 0], // 0x30
  [35, 15, 5], [0, 0, 0], [64, 0, 27], [0, 0, 0], // 0x34
  [0, 0, 0], [0, 0, 0], [40, 15, 7], [0, 0, 0], // 0x38
  [25, 15, 5], [0, 0, 0], [15, 7, 31], [0, 0, 0], // 0x3c
  [20, 15, 39], [0, 0, 0], [15, 7, 22], [0, 0, 0], // 0x40
  [0, 0, 0], [25, 15, 14], [10, 31, 7], [0, 0, 0], // 0x44
  [0, 0, 0], [0, 0, 0], [10, 31, 8], [0, 0, 0], // 0x48
  [35, 15, 23], [0, 0, 0], [10, 31, 11], [0, 0, 0], // 0x4c
  [0, 0, 0], [0, 0, 0], [10, 31, 5], [0, 0, 0], // 0x50
  [10, 15, 47], [0, 0, 0], [0, 0, 122], [0, 0, 0], // 0x54
  [0, 0, 84], [0, 0, 0], [0, 0, 0], [0, 0, 0], // 0x58
  [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], // 0x5c
];

/** Number of parameter-table entries (0x180 / 4). */
export const SFX_PARAM_COUNT = PARAM_TABLE.length;

/**
 * Parameters of a sound, or `null` outside the table.
 *
 * **Deliberate deviation:** the original does not check the bound. With a silent channel *and* an
 * empty queue, `sound_start(0xff)` there runs into a table overflow (index 4·255 = 0x3fc lies behind
 * the 0x180 table, where volume 171 and duration 1 happen to sit) and the archive pointer points
 * past the TOC. The cause is the missing sign test on slot 0 of the drain — slots 1..3 have it.
 * `SOUND_NONE` is the free marker and nothing else, so here it means **silence** rather than
 * reproducing an overflow.
 */
export function soundParams(sound: number): SoundParams | null {
  const row = PARAM_TABLE[sound];
  if (row === undefined) return null;
  return { volume: row[0], volumeMask: row[1], duration: row[2] };
}

// -- The priority queue (per viewport, `vp+0x16..0x19`) ----------------------------------------

/**
 * Four slots sorted ascending by sound index (smaller = more important), `SOUND_NONE` = free.
 * Deliberately mutable and JSON-close (`Uint8Array`) — the queue is display state, not game state,
 * and is refilled every frame.
 */
export interface SoundQueue {
  readonly slots: Uint8Array;
}

export function createSoundQueue(): SoundQueue {
  return { slots: new Uint8Array([SOUND_NONE, SOUND_NONE, SOUND_NONE, SOUND_NONE]) };
}

/** Frees all four slots (`movl $-1, 0x16(vp)` @0x620e6). */
export function resetSoundQueue(q: SoundQueue): void {
  q.slots.fill(SOUND_NONE);
}

/**
 * The shared insertion core of the three queueing routines: sorted insert with shifting, the last
 * slot falls out. **If the sound is already present in the slot examined, nothing happens** — that
 * is the original's built-in de-duplication (20 visible trees produce one bird sound).
 *
 * In the binary all three routines carry their own copy of this cascade; they differ only in the
 * clipping test in front of it (and in which register the sound comes from).
 */
function insertSound(q: SoundQueue, sound: number): void {
  const s = q.slots;
  for (let i = 0; i < SOUND_VOICES; i++) {
    const cur = s[i]!;
    if (sound === cur) return; // already queued
    if (sound < cur) {
      for (let k = SOUND_VOICES - 1; k > i; k--) s[k] = s[k - 1]!;
      s[i] = sound;
      return;
    }
  }
}

/**
 * `enqueue_sound_priority` @0x3688a — **without** clipping test. In the original the user interface
 * (button sounds) and the ambient voices; there the sound sits in `vreg0`.
 */
export function enqueueSound(q: SoundQueue, sound: number): void {
  insertSound(q, sound);
}

/**
 * `enqueue_sound_if_y_visible` @0x36930 — only `y < vp[0x40]` (height of the map area). The map
 * object pass needs no x clip because the column loop already bounds x.
 *
 * The comparison is **unsigned** as in the original, so `y < 0` drops out too.
 */
export function enqueueSoundIfYVisible(q: SoundQueue, y: number, height: number, sound: number): void {
  if ((y & 0xffff) >= (height & 0xffff)) return;
  insertSound(q, sound);
}

/**
 * `enqueue_sound_if_visible` @0x3693e — `x < vp[0x3e]` **and** `y < vp[0x40]` (width/height of the
 * map area, 608x432 in the game screen). The serf pass uses this variant.
 */
export function enqueueSoundIfVisible(
  q: SoundQueue,
  x: number,
  y: number,
  width: number,
  height: number,
  sound: number,
): void {
  if ((x & 0xffff) >= (width & 0xffff)) return;
  if ((y & 0xffff) >= (height & 0xffff)) return;
  insertSound(q, sound);
}

// -- Voice assignment + duration countdown -----------------------------------------------------

/** State of one voice (`gs+0x134 + channel` = sound, `gs+0x12c + 2·channel` = remaining). */
export interface SoundVoice {
  sound: number;
  remaining: number;
}

/** A sound to start — the result of `serviceSound`. */
export interface SoundStart {
  /** Voice 0..3. */
  readonly voice: number;
  /** Sound index (see `sfxArchiveSlot`). */
  readonly sound: number;
  /** Volume `base + (rnd & mask)`, as `sound_start` @0x62242/@0x6224a computes it. */
  readonly volume: number;
}

/**
 * **When is the queue drained?** — the port's timing rule, in one place.
 *
 * In the original this is not a question: the frame routine `@0x61ae9` draws both viewports,
 * distributes the mouse events and then services the queue (`@0x61c62`) — **every** frame, ~12.5/s.
 * There drawing and logic are the same pass, and a paused simulation does not exist.
 *
 * This port differs in two respects and therefore needs a rule:
 * 1. Drawing runs on `requestAnimationFrame` (~60/s). Servicing the queue there would make every
 *    emitting branch sound about five times too often. Hence the **logic frame** (`gameTick >> 3`)
 *    is the gate — the same arithmetic the original uses for its animation phases.
 * 2. The port can **pause** the simulation. Then `gameTick` stands still, the gate from (1) never
 *    fires, and a UI sound (`ui-sound.ts`) would stay in the queue forever.
 *
 * Therefore: while running **only** on the logic frame; while paused, as soon as anything is queued.
 * The **emission** of the drawing passes still hangs on the logic frame alone — with `gameTick`
 * standing still their phase gates are constant, so a mine would otherwise drone endlessly.
 */
export function soundServiceDue(
  logicFrameChanged: boolean,
  playing: boolean,
  queue: SoundQueue,
): boolean {
  if (logicFrameChanged) return true;
  if (playing) return false;
  return queue.slots.some((s) => s !== SOUND_NONE);
}

/**
 * The mixer: four voices plus its **own** random stream.
 *
 * **Deliberate deviation (determinism):** in the original both the sound gates of the drawing passes
 * and the volume spread draw the **game** RNG (`FUN_0004e1e9` is byte-identical to our `Rng` @0x28c54
 * and works on the same three `gs+0x212` words). There that is harmless because drawing and logic are
 * the same frame. Here drawing runs on `requestAnimationFrame`, decoupled from the logic ticks — a
 * shared stream would fold the frame rate into the course of the game and break reproducibility and
 * lockstep. The sound stream is therefore its **own** `Rng` with the same algorithm, seeded from the
 * save. The game logic stays untouched by it.
 */
export interface SoundMixer {
  readonly voices: SoundVoice[];
  readonly rng: Rng;
}

export function createSoundMixer(seed: readonly [number, number, number]): SoundMixer {
  return {
    voices: Array.from({ length: SOUND_VOICES }, () => ({ sound: SOUND_NONE, remaining: 0 })),
    rng: new Rng(seed),
  };
}

/**
 * Duration countdown, once per service call (`FUN_00061c93` @0x61cc8 ff.): every voice with a
 * remaining duration > 0 is decremented; on reaching 0 the voice is reported **free**
 * (`gs[0x134+channel] = 0xff`). A duration of 0 is skipped (`or %ax,%ax ; je`) — that does not occur
 * among the 39 occupied entries (smallest value 4).
 */
export function tickSoundVoices(mixer: SoundMixer): void {
  for (const v of mixer.voices) {
    if (v.remaining === 0) continue;
    v.remaining -= 1;
    if (v.remaining === 0) v.sound = SOUND_NONE;
  }
}

/**
 * The drain (`FUN_00061fe3` @0x61fe3, tail `sound_queue_drain` @0x6205e): distributes the queue's
 * four slots over the four voices and **empties the queue**.
 *
 * Order of business as in the original:
 * 1. The voices are sorted **descending** by their running sound — so the voice with the *least*
 *    important sound comes first (`SOUND_NONE` = silent is the largest value and hence the best
 *    candidate to overwrite). That way no separate bookkeeping is needed.
 * 2. Slot `i` overwrites voice `i` of that order as long as `running >= queued`. Once the condition
 *    breaks the cascade ends (nested `if`s in the original, no `continue`).
 * 3. Slots 1..3 additionally require a real sound (`or %al,%al ; js` — `SOUND_NONE` has the sign bit
 *    set). **Slot 0 does not have this test in the original** — see `soundParams`.
 */
export function serviceSound(mixer: SoundMixer, queue: SoundQueue): SoundStart[] {
  const order = mixer.voices
    .map((v, i) => ({ i, sound: v.sound }))
    .sort((a, b) => b.sound - a.sound || a.i - b.i);

  const starts: SoundStart[] = [];
  for (let k = 0; k < SOUND_VOICES; k++) {
    const queued = queue.slots[k]!;
    const slot = order[k]!;
    if (k > 0 && queued >= 0x80) break; // original: sign test of slots 1..3
    if (queued === SOUND_NONE) break; // slot 0: silence here instead of a table overflow
    if (slot.sound < queued) break; // running sound more important, cascade ends
    const p = soundParams(queued);
    if (p === null) break;
    const volume = p.volume + (mixer.rng.next() & p.volumeMask);
    const voice = mixer.voices[slot.i]!;
    voice.sound = queued;
    voice.remaining = p.duration;
    starts.push({ voice: slot.i, sound: queued, volume });
  }
  resetSoundQueue(queue);
  return starts;
}
