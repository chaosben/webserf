/**
 * Control options of one screen half - the state behind the options popup (screen 0x25). Two bytes in
 * the save, one per half: `.DS` offset 72/73. The original keeps them per player because split screen
 * puts two players on one machine.
 *
 * | Bit | Mask | Meaning |
 * |---|---|---|
 * | 0 | 0x01 | road-building scroll - the view follows when building near the screen edge |
 * | 1 | 0x02 | fast map click - right double click opens the overview map |
 * | 2 | 0x04 | fast build click - a second click on the cursor equals clicking the build icon |
 * | 3..5 | 0x38 | message level 0..3 as a thermometer |
 * | 6, 7 | - | unused |
 *
 * The byte is read only through the viewport copy `vp+0x86`; a `bt` directly on the master byte
 * appears nowhere. Bit 1 has no `bt` reader at all - the fast map click is tested elsewhere.
 *
 * Bit 0 has two readers, and both are what the manual describes: one checks all four edges after
 * setting the map cursor, ors a direction into an accumulator and sounds at every edge; the other is
 * the consumer in the frame loop that scrolls and clears the accumulator.
 *
 * The message level is UNARY, not a number: bit 5 => level >= 1, bit 4 => >= 2, bit 3 => 3. The
 * renderer reads it from the top and the two click handlers count down in the same order, wrapping
 * from 0 back to 3. The levels are 3 = all messages, 2 = without "building occupied"/geologist, 1 =
 * only the most important, 0 = none.
 *
 * Deliberately not modelled: the viewport copy. It is a pure cache - all of its writers copy from one
 * of the two master bytes and there is no independent writer, so readers may just as well read the
 * master, which is what this port does. The original's twelve toggle routines are unrolled copies
 * differing only in the bit immediate (and, on the right, the viewport indirection), so parametrising
 * by (half, mask) is equivalent rather than a merged special case.
 */
import type { GameState } from './state.js';

/** Road-building scroll (bit 0). */
export const VIEW_OPTION_ROAD_SCROLL = 0x01;
/** Fast map click (bit 1) — right double click opens the overview map. */
export const VIEW_OPTION_FAST_MAP_CLICK = 0x02;
/** Fast build click (bit 2). */
export const VIEW_OPTION_FAST_BUILD_CLICK = 0x04;

/** The three thermometer bits of the message level. */
export const VIEW_OPTION_MESSAGE_MASK = 0x38;
/** Bit 3 — set only at level 3. */
export const VIEW_OPTION_MESSAGE_BIT_HIGH = 0x08;
/** Bit 4 — set from level 2 up. */
export const VIEW_OPTION_MESSAGE_BIT_MID = 0x10;
/** Bit 5 — set from level 1 up. */
export const VIEW_OPTION_MESSAGE_BIT_LOW = 0x20;

/** Highest message level (show everything). */
export const MESSAGE_LEVEL_MAX = 3;

/**
 * **Factory setting of both halves: `0x39`** — road scroll on, both fast clicks off, message level
 * 3. From the default branch of the start routine (`mov $0x39,%al` @0x2e0f for `gs+0x3d8` and @0x2e1a
 * for `gs+0x3d9`; the other branch takes the values from the configuration file).
 *
 * That "fast map click" is **off** by default matches the manual's advice to leave it off if the
 * right mouse button is unreliable.
 *
 * It also pins `.DS` offset 73: **every** available save holds exactly `0x39` there — the right half
 * is never changed in a single-player game and keeps the factory setting. Confirmed on screen as
 * well: in an original capture of the options screen both bytes are `0x39` and our rendering is
 * pixel identical.
 */
export const VIEW_OPTIONS_DEFAULT = 0x39;

/** Screen half: 0 = left (`gs+0x3d8`), 1 = right (`gs+0x3d9`). */
export type ViewSide = 0 | 1;

/**
 * Message level 0..3 from the options byte — the renderer's reading order (@0x3b8e2 ff.), not
 * `>> 3`: the original tests bit 3, then 4, then 5 and takes the first hit.
 */
export function messageLevel(options: number): number {
  if ((options & VIEW_OPTION_MESSAGE_BIT_HIGH) !== 0) return 3;
  if ((options & VIEW_OPTION_MESSAGE_BIT_MID) !== 0) return 2;
  if ((options & VIEW_OPTION_MESSAGE_BIT_LOW) !== 0) return 1;
  return 0;
}

/**
 * A click on the message row — `FUN_0002e8a2` (left) / `FUN_0002e99b` (right): the cascade clears
 * the **highest** set thermometer bit, and if none is set it sets all three. The level therefore runs
 * `3 -> 2 -> 1 -> 0 -> 3`.
 *
 * Written as a bit operation rather than `level` arithmetic on purpose: impossible bit patterns are
 * then preserved and resolved exactly as in the original.
 */
export function cycleMessageLevel(options: number): number {
  if ((options & VIEW_OPTION_MESSAGE_BIT_HIGH) !== 0) return options & ~VIEW_OPTION_MESSAGE_BIT_HIGH;
  if ((options & VIEW_OPTION_MESSAGE_BIT_MID) !== 0) return options & ~VIEW_OPTION_MESSAGE_BIT_MID;
  if ((options & VIEW_OPTION_MESSAGE_BIT_LOW) !== 0) return options & ~VIEW_OPTION_MESSAGE_BIT_LOW;
  return options | VIEW_OPTION_MESSAGE_MASK;
}

/** Options byte of one half (`gs+0x3d8` / `gs+0x3d9`). */
export function viewOptions(state: GameState, side: ViewSide): number {
  return state.header.viewOptions[side] & 0xff;
}

/** Set the options byte of one half (the only writer in this module). */
function setViewOptions(state: GameState, side: ViewSide, value: number): void {
  const [left, right] = state.header.viewOptions;
  const v = value & 0xff;
  state.header.viewOptions = side === 0 ? [v, right] : [left, v];
}

/** Is an option set? (`mask` is one of the `VIEW_OPTION_*` masks.) */
export function hasViewOption(state: GameState, side: ViewSide, mask: number): boolean {
  return (viewOptions(state, side) & mask) !== 0;
}

/**
 * Toggle a tick in the **byte** — the six `btc` handlers
 * (`FUN_0002e6cb`/`e703`/`e768`/`e7a0`/`e805`/`e83d`) in one: `byte ^= mask`.
 *
 * A plain byte function, like {@link cycleMessageLevel}, because the options bytes are **global** in
 * the original (`gs+0x3d8`/`0x3d9`, from the configuration file) and exist **before** any save — the
 * main menu drives the same screen without a `GameState` at hand.
 */
export function toggleOption(options: number, mask: number): number {
  return (options ^ mask) & 0xff;
}

/** {@link toggleOption} on the byte of one half in the save state. */
export function toggleViewOption(state: GameState, side: ViewSide, mask: number): void {
  setViewOptions(state, side, toggleOption(viewOptions(state, side), mask));
}

/** A click on the message row of one half ({@link cycleMessageLevel} on the byte). */
export function cycleViewMessageLevel(state: GameState, side: ViewSide): void {
  setViewOptions(state, side, cycleMessageLevel(viewOptions(state, side)));
}

// --- Music and volume (global, NOT in the save state) --------------------------------------------

/**
 * Clamp limits of the volume `gs+0x3dc`: `-` tests `!= 0` (`FUN_0002dad1`), `+` tests `!= 99`
 * (`cmpw $0x63`, `FUN_0002da8f`). Both handlers then call `FUN_0000c0a1(value, 0x40)`, which passes
 * the value to the mixer (`(value * 0x40) >> 6`, i.e. unchanged).
 */
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 99;

/**
 * Default volume **75** (`mov $0x4b,%ax` @0x2e3b, in the same default branch as
 * {@link VIEW_OPTIONS_DEFAULT}; the configuration branch @0x2edc reads it from the file instead).
 * Music is **on** by default (`gs+0x3da = 1` @0x2e25, from which the start routine sets `gs+0x1cb`
 * bit 1 if a sound driver is present), the SVGA mode **off** (`gs+0x3db = 0` @0x2e30).
 */
export const VOLUME_DEFAULT = 75;
/** Music **on** by default (`gs+0x3da = 1` @0x2e25). */
export const MUSIC_DEFAULT = true;
/** SVGA mode **off** by default (`gs+0x3db = 0` @0x2e30). */
export const SCREEN_LAYOUT_DEFAULT = false;

/** Step the volume by +-1, clamped like the two original handlers. */
export function stepVolume(volume: number, delta: -1 | 1): number {
  if (delta === -1) return volume === VOLUME_MIN ? volume : volume - 1;
  return volume === VOLUME_MAX ? volume : volume + 1;
}
