/**
 * Sound emission from the drawing passes.
 *
 * The original does **not** test whether the cause of a noise is visible — the drawing passes queue
 * the sounds themselves, and whatever is not drawn queues nothing. This module mirrors the two passes:
 *
 * - **Map objects** — dispatcher `@0x34ed5`, index = building type. Only mines (5..8), pig farm (14),
 *   mill (15), steel/gold smelter (18/23) and, **before** the type dispatcher, a burning building
 *   (`bt $0x5` @0x34e9e) produce sound. All other types are 16-byte stubs that only set a sprite
 *   number.
 * - **Serfs** — dispatcher `@0x25df7`, index = serf type. 15 of the 28 types produce sound; the
 *   condition differs per type, hence **one function per type** here, as in the binary, rather than a
 *   generalised rule scheme.
 *
 * **The one-shot latch.** Serf sounds are "once per work stroke", not "every frame": the original
 * keeps the latch in `serf[0]` bit 7 (the `sound` bit of the `.DS` record) resp., for mill/smelter/
 * fire, in `building[5]` bit 3. The pattern is: outside the animation window `btr` (unlatch), inside
 * it `bt` (test) -> `bts` (set) -> queue.
 *
 * **Deliberate deviation (determinism):** we keep those latches **here**, not in the record. In the
 * original the drawing pass writes game state; that is harmless there because drawing and logic are
 * the same frame. Here drawing runs on `requestAnimationFrame`, decoupled from the logic ticks — a
 * writing renderer would fold the frame rate into the save and break reproducibility and lockstep.
 * For the same reason the sound randomness draws its own stream (see `sound.ts`, `SoundMixer`).
 * Untouched stays `building[5]` bit 3 where it is **simulation** state (miner underground, sword/shield
 * alternation of the weapon smith) — this module only reads that.
 */

import type { MapGeometry } from './engine/position.js';
import type { Rng } from './engine/rng.js';
import type { BuildingRecord, SerfRecord } from './types.js';
import { enqueueSoundIfVisible, enqueueSoundIfYVisible, type SoundQueue } from './sound.js';

/**
 * The latches of both passes, by entity index. Lives with the viewport, not in the save (see module
 * header). After loading a save it starts empty — harmless, since it only buffers one stroke.
 */
export interface SoundLatches {
  readonly serf: Set<number>;
  readonly building: Set<number>;
}

export function createSoundLatches(): SoundLatches {
  return { serf: new Set(), building: new Set() };
}

// -- Map object pass ---------------------------------------------------------------------------

/** Clip frame of the map object pass: height only (`vp[0x40]`), x is bounded by the column loop. */
export interface BuildingSoundCtx {
  readonly queue: SoundQueue;
  readonly latches: SoundLatches;
  /** Window height of the map area in pixels (`vp+0x40`, 432 in the game screen). */
  readonly height: number;
  /** Game tick (`gs->gameTick`). */
  readonly tick: number;
  /** The sound layer's own random stream. */
  readonly rng: Rng;
  readonly geo: MapGeometry;
}

const MINE_TYPES = new Set([5, 6, 7, 8]);
const PIG_FARM = 14;
const MILL = 15;
const SMELTER_TYPES = new Set([18, 23]);

/**
 * Byte 1 of a building's encoded position word — `building[1]` in the original, used as a **fixed
 * phase offset per mine** so that not all mines sound in step. The position word is
 * `((row << (rowShift+1)) | col) << 2` (see `save-parser.decodeBuilding`).
 */
export function buildingPosByte1(b: BuildingRecord, geo: MapGeometry): number {
  const word = ((((b.row << (geo.rowShift + 1)) | b.col) << 2) >>> 0) & 0xffffffff;
  return (word >>> 8) & 0xff;
}

/** Byte 9 of the record (for the pig farm the plain number of pigs, 0..8). */
const rawByte9 = (b: BuildingRecord): number =>
  ((b.stock[1]!.available << 4) | b.stock[1]!.requested) & 0xff;

/**
 * The map object pass. Order as in the original: **first** the fire branch (`bt $0x5` sits before the
 * type dispatcher), then the type.
 */
export function emitBuildingSound(ctx: BuildingSoundCtx, b: BuildingRecord, y: number): void {
  const latched = (sound: number): void => {
    if (ctx.latches.building.has(b.index)) return; // `bt $0x7`/`bt $0x3`: already sounded
    ctx.latches.building.add(b.index);
    enqueueSoundIfYVisible(ctx.queue, y, ctx.height, sound);
  };
  const always = (sound: number): void => {
    ctx.latches.building.add(b.index);
    enqueueSoundIfYVisible(ctx.queue, y, ctx.height, sound);
  };
  const unlatch = (): void => {
    ctx.latches.building.delete(b.index);
  };

  // Burning building — `@0x34a07`, phase from the burn countdown (`building[0xa]`, the union
  // `firstKnight` here).
  //
  // The fire branch does NOT run *instead of* the type dispatcher: it ends in `FUN_00034a70`, which
  // calls `FUN_00034eb0` @0x34eb0, the **same** dispatcher as the normal case. A burning building runs
  // through its type routine as usual and can queue that sound too. That the latch is the same
  // (`building[5]` bit 3) is an original quirk, not an imprecision of the port: if the fire branch
  // queues 0x54 it thereby blocks e.g. the mill sound in the same frame.
  if (b.burning) {
    if (((b.firstKnight >> 3) & 3) === 3) latched(0x54);
    else unlatch();
  }
  if (b.constructing) return; // construction sites have their own drawing branch without sound

  if (MINE_TYPES.has(b.type)) {
    // `@0x35206` and others: only while the miner is underground (`building[5]` bit 3 — simulation
    // state here, not a latch), phase with offset, then 40000/65536 ~ 61 %.
    if (!b.playingSfx) return;
    const lo = (ctx.tick + buildingPosByte1(b, ctx.geo)) & 0xff;
    if (((lo >> 3) & 7) !== 0) return;
    if (ctx.rng.next() < 40000) enqueueSoundIfYVisible(ctx.queue, y, ctx.height, 0x26);
    return;
  }

  if (b.type === PIG_FARM) {
    // `@0x3584d`: probability **proportional to the number of pigs**. No latch.
    const pigs = rawByte9(b);
    if (pigs === 0) return;
    if ((ctx.rng.next() & 0x7f) < pigs) enqueueSoundIfYVisible(ctx.queue, y, ctx.height, 0x3c);
    return;
  }

  if (b.type === MILL) {
    // `draw_mill_animation` @0x35e50: phase 0 of 4 (changes every 2 frames) — here the latch is
    // **load-bearing**, otherwise it sounds twice.
    if (!b.active) return;
    if (((ctx.tick >> 4) & 3) === 0) latched(0x42);
    else unlatch();
    return;
  }

  if (SMELTER_TYPES.has(b.type)) {
    // `@0x35f7e` / `@0x3635e`: phase 0 **without** latch test, phase 7 with — two strokes per 8 frames.
    if (!b.active) return;
    const phase = (ctx.tick >> 3) & 7;
    if (phase === 0) always(0x3e);
    else if (phase === 7) latched(0x3e);
    else unlatch();
  }
}

// -- Serf pass ---------------------------------------------------------------------------------

/** Clip frame of the serf pass: width **and** height (`vp+0x3e`/`vp+0x40`). */
export interface SerfSoundCtx {
  readonly queue: SoundQueue;
  readonly latches: SoundLatches;
  readonly width: number;
  readonly height: number;
}

/** The shared `bt` branch: queue only if the latch is open. */
function latchedSerf(ctx: SerfSoundCtx, serf: SerfRecord, x: number, y: number, sound: number): void {
  if (ctx.latches.serf.has(serf.index)) return;
  alwaysSerf(ctx, serf, x, y, sound);
}

/** The shared `bts` branch: set the latch and queue, without a test. */
function alwaysSerf(ctx: SerfSoundCtx, serf: SerfRecord, x: number, y: number, sound: number): void {
  ctx.latches.serf.add(serf.index);
  enqueueSoundIfVisible(ctx.queue, x, y, ctx.width, ctx.height, sound);
}

/**
 * The scaffolding that is literally the same in 12 of the 15 type routines: a pair of values over the
 * animation, where one value **tests** the latch and the other only **sets** it; any other value
 * unlatches. (Which value plays which role is read per routine in the binary — see the calls below.)
 */
function animPair(
  ctx: SerfSoundCtx,
  serf: SerfRecord,
  x: number,
  y: number,
  key: number,
  latchedKeys: readonly number[],
  alwaysKeys: readonly number[],
  sound: number,
): void {
  if (latchedKeys.includes(key)) latchedSerf(ctx, serf, x, y, sound);
  else if (alwaysKeys.includes(key)) alwaysSerf(ctx, serf, x, y, sound);
  else ctx.latches.serf.delete(serf.index);
}

/**
 * The serf pass. `animSprite` is the **body byte of the animation frame currently being drawn**, not
 * the animation index `serf[1]` — exactly the value the type dispatcher receives in `vreg2`:
 *
 * ```
 * 25d40  mov 0x1(%ebx),%al        vreg2 = serf[1]           (animation index)
 * 25d6e  mov 0xb0(%gs),%eax       animation table
 * 25d83  add table[anim*4]        pointer to this animation
 * 25d89  mov 0x2(%ebx),%ax ; shrw $0x3 ; x3   frame = serf[2] >> 3, stride 3
 * 25dc4  mov (%ebx),%al ; mov %al,0x8(%edi)   vreg2 = FRAME body byte   <- this one
 * 25df5  jmp *(0x25df7 + type*8)
 * ```
 *
 * The type routines compare this byte (`cmpb $0xb3,0x8(%edi)` @0x262e4 in the sawmill branch), and the
 * same number then gets the bank base added (`+0x1580` resp. `+0x2c80` ...) — so it is the same value
 * `serfBody` processes as `animSprite`. Because it changes **per frame**, the sounds are bound to the
 * visible movement; the animation index changes only per state.
 *
 * The sign gates differ **per type** (the sailor requires `< 0x80`, the worker types `>= 0x80`, the
 * dead one has none) — read per routine in the binary, not guessed.
 */
export function emitSerfSound(
  ctx: SerfSoundCtx,
  serf: SerfRecord,
  x: number,
  y: number,
  animSprite: number,
): void {
  const anim = animSprite & 0xff;
  const high = anim >= 0x80;
  const low3 = anim & 7;
  const sd = serf.stateData;

  switch (serf.type) {
    case 1: // sailor @0x25fe2 — two state blocks, same values, same sound
      if (serf.state === 3 || serf.state === 26 || serf.state === 27) {
        if (high) return; // `js`: skip (the other way round from the workers)
        animPair(ctx, serf, x, y, low3, [4], [3], 0x40);
      }
      return;
    case 2: // digger @0x2613a
      if (!high) return;
      animPair(ctx, serf, x, y, anim, [0x84], [0x83], 0x32);
      return;
    case 3: // builder @0x261a7 — key is `anim & 7`
      if (!high) return;
      animPair(ctx, serf, x, y, low3, [5], [4], 0x28);
      return;
    case 5: {
      // lumberjack @0x2621e — axe 0x20; **in the same frame** additionally the felling sound 0x22,
      // gated on `serf[0xe] == 0` and `serf[2] < 0x40` (@0x26278/@0x26282). Only reachable if 0x20 was
      // actually queued, so the second sound hangs on the same latch.
      if (!high) return;
      const open = !ctx.latches.serf.has(serf.index);
      animPair(ctx, serf, x, y, anim, [0x86], [0x85], 0x20);
      // The felling sound sits in the fall-through **behind** the 0x20 queueing: it is reached exactly
      // when 0x20 was queued too — at `0x85` always (the `bts` branch), at `0x86` only with an open
      // latch (otherwise the `bt` branch jumps past both sounds).
      const emitted20 = anim === 0x85 || (anim === 0x86 && open);
      if (!emitted20) return;
      if ((sd[3] ?? 0) !== 0) return; // serf[0xe] != 0 -> @0x2627d
      if (serf.counter >= 0x40) return; // @0x26282 `cmpw $0x40 ; jae`
      enqueueSoundIfVisible(ctx.queue, x, y, ctx.width, ctx.height, 0x22);
      return;
    }
    case 6: // sawmiller @0x262d4 — saw, four phase pairs
      if (!high) return;
      animPair(ctx, serf, x, y, anim, [0xb7, 0xbf, 0xc7, 0xcf], [0xb3, 0xbb, 0xc3, 0xcb], 0x2b);
      return;
    case 7: // stonecutter @0x2638b
      if (!high) return;
      animPair(ctx, serf, x, y, anim, [0x86], [0x85], 0x1c);
      return;
    case 8: // forester @0x2643b
      if (!high) return;
      animPair(ctx, serf, x, y, anim, [0x87], [0x86], 0x30);
      return;
    case 11: // fisher @0x2658b — the ONLY place without a latch: every frame of the band sounds
      if (!high) return;
      if (anim === 0x80 || anim === 0x87 || anim === 0x88 || anim === 0x8f) return;
      enqueueSoundIfVisible(ctx.queue, x, y, ctx.width, ctx.height, 0x36);
      return;
    case 13: // butcher @0x26643 — only one set of values, all with a latch test
      if (!high) return;
      animPair(ctx, serf, x, y, anim, [0xb2, 0xba, 0xc2, 0xca], [], 0x2c);
      return;
    case 14: // farmer @0x266de — precondition `serf[0xd] != 0` (@0x266e8)
      if (!high) return;
      if ((sd[2] ?? 0) === 0) return;
      animPair(ctx, serf, x, y, anim, [0x84], [0x83], 0x34);
      return;
    case 17: // boat builder @0x26804
      if (!high) return;
      animPair(ctx, serf, x, y, anim, [0x85], [0x84], 0x24);
      return;
    case 18: // tool maker @0x26894 — two pairs: hammer 0x2a and 0x24
      if (!high) return;
      if (anim === 0xb2 || anim === 0x83) animPair(ctx, serf, x, y, anim, [0xb2], [0x83], 0x2a);
      else if (anim === 0xb6 || anim === 0x87) animPair(ctx, serf, x, y, anim, [0xb6], [0x87], 0x24);
      else ctx.latches.serf.delete(serf.index);
      return;
    case 19: // weapon smith @0x269ff
      if (!high) return;
      animPair(ctx, serf, x, y, anim, [0x84], [0x83], 0x1e);
      return;
    case 20: // geologist @0x26aa8 — two pairs: hammer 0x1a and marker 0x2e
      if (!high) return;
      if (anim === 0x8d || anim === 0x8c) animPair(ctx, serf, x, y, anim, [0x8d], [0x8c], 0x1a);
      else if (anim === 0x84 || anim === 0x86 || anim === 0x83)
        animPair(ctx, serf, x, y, anim, [0x84, 0x86], [0x83], 0x2e);
      else ctx.latches.serf.delete(serf.index);
      return;
    case 27: // dead @0x26c5d — **no** sign gate, small animation indices
      animPair(ctx, serf, x, y, anim, [0x02, 0x05], [0x01, 0x04], 0x45);
      return;
    default:
      return;
  }
}

/**
 * The combat sound — one sound **per stroke** (`@0x26cc4`, the gate of the combat extra pass).
 *
 * Only the **attacker** states 48/60 pass (the defender queues nothing, so a stroke sounds once), and
 * only inside the counter window `serf[2]` in [8, 0x18) — mid-stroke. `serf[0xd]` is the **stroke
 * pose** `dir` 0..4 from the sequence table `@0x18782`; the three sounds are variants per pose.
 *
 * **Original quirk, deliberately reproduced:** pose 2 sounds as `0x12` although @0x26d41 first sets
 * `0x0e` — `or $0xe,$0xe` makes the following `je` unreachable, and @0x26d4d overwrites. `0x0e` is
 * therefore unreachable in the whole binary, yet has a parameter entry of its own.
 */
export function emitFightSound(ctx: SerfSoundCtx, serf: SerfRecord, x: number, y: number): void {
  if (serf.state !== 0x30 && serf.state !== 0x3c) return; // @0x26cd4 `jne`: out, without unlatching
  if (serf.counter >= 0x18 || serf.counter < 0x08) {
    // @0x26ce2/@0x26cf0 jump to `@0x26d6f`, and there sits `btr $0x7` — **unlatch**. Without this
    // branch only the first stroke of a duel would sound.
    ctx.latches.serf.delete(serf.index);
    return;
  }
  if (ctx.latches.serf.has(serf.index)) return; // @0x26d01 `jne`: out, without unlatching
  ctx.latches.serf.add(serf.index);
  const pose = serf.stateData[2] ?? 0;
  const sound = pose === 2 ? 0x12 : pose === 0 || pose === 4 ? 0x0a : 0x16;
  enqueueSoundIfVisible(ctx.queue, x, y, ctx.width, ctx.height, sound);
}
