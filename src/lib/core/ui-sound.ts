/**
 * Sounds of the control actions - the original's third enqueue variant, `enqueue_sound_priority`
 * @0x3688a: no clip test, the sound comes from `vreg0` and lands in the priority queue unchanged.
 * Unlike the drawing passes (`sound-emit.ts`) there is no visibility argument behind it - a control
 * action always sounds.
 *
 * 89 of its 90 call sites have the same instruction form with the sound number exactly 9 bytes before
 * the `call`, which makes the set of sounds countable, and it is tiny: 0x04 rejected, 0x02 carried
 * out, 0x08 control element hit, plus four one-off numbers. The one exception is the ambient bird,
 * whose number comes from a table.
 *
 * The resulting rule for when an action sounds:
 * 1. Zone or icon hit gives 8, once per click path, right after the zone resolves
 *    ({@link UI_SOUND_PANEL_BUTTON}).
 * 2. Effect gives 2 or 4 ({@link UI_SOUND_ACCEPT} / {@link UI_SOUND_REJECT}), at the end of the action
 *    handler, PER BRANCH - a handler with two exits has two call sites.
 * 3. Some branches are silent, and that is a skipped enqueue rather than an oversight.
 *
 * Careful with the mapping "call site to routine": taking the nearest preceding Ghidra entry puts most
 * of the popup sites outside the body that supposedly contains them, because Ghidra splits long
 * routines. Only CFG reachability from a real entry point is reliable.
 *
 * Ten sites are unreachable without a SECOND HUMAN player: nine screen openers and the disk menu
 * refusal check whether the same screen is already open in the other screen half and only then enqueue
 * a rejection. With the two-player bit clear they jump past the enqueue. Two more sites hang on game
 * type 4 (clearing a player's message list from the top frame strip of a popup) and are deliberately
 * not ported.
 *
 * The two demolish actions sound BEFORE the effect and in every branch - even the failure has a tone.
 * The burning sound does not belong here: the drawing pass of the burning building enqueues it for as
 * long as it burns, and `demolish_building` itself enqueues nothing.
 */

import { isSpectatorGame } from './engine/new-game.js';
import type { DemolishOutcome } from './engine/demolish.js';
import type { BuildMenuClickOutcome } from './engine/build-site.js';

/**
 * Rejected — with 36 call sites the most frequent sound of the game. Not "error" but "the action was
 * not possible": every action handler that returns early enqueues it.
 */
export const UI_SOUND_REJECT = 0x04;

/**
 * Carried out — the counterpart, 25 call sites.
 *
 * {@link UI_SOUND_DEMOLISH_ROAD} and {@link UI_SOUND_RECALL_SET} are the same sound with the same
 * meaning: the original knows no subject-specific tones here, only these two outcomes. The alias
 * names stay because they read better at their site; a new action handler takes this constant.
 */
export const UI_SOUND_ACCEPT = 0x02;

/** Demolish a road (@0x4a4c6) — alias of {@link UI_SOUND_ACCEPT}. */
export const UI_SOUND_DEMOLISH_ROAD = 0x02;

/** Demolish a flag (@0x48ca9). */
export const UI_SOUND_DEMOLISH_FLAG = 0x08;

/** Demolish a building (@0x48e62). */
export const UI_SOUND_DEMOLISH_BUILDING = 0x4c;

/**
 * The sound of every popup button that is hit (@0x2cd3b).
 *
 * It does not sit in a single handler but in the shared zone walker @0x2cc98: that walks the 5-byte
 * entries `{action, x0, x1, y0, y1}` of the screen table and sounds as soon as one hits — only then
 * does it jump into the action table. So an action that does nothing still sounds, a click beside a
 * zone does not. One call site therefore covers all zones of all popup screens.
 *
 * Measured, not estimated: a jump walk from each of the 61 dispatcher slots reaches the zone walker
 * in 54 cases. The seven exceptions are exactly the screens without a zone table (no popup open, the
 * disk menu, the mission end and the joystick calibration). Ten screens reach the walker only after
 * their own pre-check (the slider screens, the flag popup, the stock in/out) — they still sound on a
 * zone hit, while dragging a slider is not a zone hit and stays silent.
 *
 * Rule for the port: exactly once per popup click path, right after the zone resolves and before the
 * action runs — not per branch. The control panel is separate: it has its own set of call sites.
 */
export const UI_SOUND_PANEL_BUTTON = 0x08;

/**
 * Which panel icons sound — the control panel's own group of call sites.
 *
 * `control_bar_slot_click` @0x273d6 is not built like the popup zone walker: there is no shared
 * "hit" point but a cascade of comparisons on the icon value of the clicked slot, and every branch
 * enqueues on its own.
 *
 * The order is the non-obvious part. For nine of the values `bt $0x3` (special click) on `vp[1]`
 * stands BEFORE the enqueue and on a hit jumps into the build-helper toggle @0x27eb5, which is
 * therefore silent — together with 0x05 and 0x00 those are exactly the eleven values of
 * `BUILD_HELPER_TOGGLE_ICONS`. Four values (the map icons) lack that gate, so they sound on a
 * special click too, because their special handling sits behind the sound.
 *
 * Rule for the port: enqueue after the build-helper branch and before all other special paths.
 */
export const CONTROL_BAR_SOUND_ICONS: ReadonlySet<number> = new Set([
  0x01, 0x02, 0x03, 0x04, 0x08, 0x0a, 0x0c, 0x0e,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
]);

/**
 * The message tone (@0x33880), the only call site in the message overlay. It sounds when the wake
 * flag finds a message that passes the level filter — not on enqueueing and not on reading.
 */
export const UI_SOUND_MESSAGE = 0x01;

/**
 * Recall set — in all three writers of the recall function (@0x27ad4, @0x27b98, @0x27c71). If the
 * queue is full or the screen unsuitable, {@link UI_SOUND_REJECT} sounds instead. Alias of
 * {@link UI_SOUND_ACCEPT}.
 */
export const UI_SOUND_RECALL_SET = 0x02;

/**
 * Quit confirmed (@0x2ec6d). Same number as {@link UI_SOUND_DEMOLISH_BUILDING}; those two are the
 * only 0x4c sites in the binary.
 *
 * The button has two exits and only one sounds: with the 60-second counter expired it continues
 * here, otherwise the handler silently opens screen 0x23. "No" sounds {@link UI_SOUND_REJECT} — in
 * the original an aborted dialog is a rejected action.
 */
export const UI_SOUND_QUIT_CONFIRM = 0x4c;

/**
 * The sound of the three build placement bodies (@0x3011e mine, @0x301fa small, @0x302d6 large, plus
 * their shared body @0x303a6) — four exits, two of them silent.
 *
 * The two silent ones are why this is a function and not an `allowed ? 2 : 4` line: the military
 * lock returns from the icon stub with a bare `ret`, and so does a plain click on a building.
 */
export function buildMenuOutcomeSound(outcome: BuildMenuClickOutcome): number | null {
  switch (outcome) {
    case 'blocked': // `ret` @0x300ba — military build locked
    case 'keep': // `ret` @0x3019c — plain click on a building
      return null;
    case 'place': // @0x303a6
    case 'demolish': // @0x30161
      return UI_SOUND_ACCEPT;
    case 'reject': // @0x301e6 / @0x302c2 / @0x30392
      return UI_SOUND_REJECT;
  }
}

/** The sound for the outcome of `demolishAtCursor` — the three branches of `FUN_00048c8a`. */
export function demolishOutcomeSound(outcome: DemolishOutcome): number {
  switch (outcome) {
    case 'flag':
      return UI_SOUND_DEMOLISH_FLAG;
    case 'building':
      return UI_SOUND_DEMOLISH_BUILDING;
    case 'rejected':
      return UI_SOUND_REJECT;
  }
}

/**
 * The plain map click sounds — except in game type 4 (`bt $0x5` on `gs+0x37e` @0x29fa7).
 *
 * The sound sits behind the cursor write and behind the special-click gate (@0x29f98): a special
 * click falls through into the popup selection and does not sound here. Opening a popup from a
 * special click is silent in the original; the only exception is the attack dialog, which has its
 * own sound 8 in its own branch.
 */
export function plainMapClickSilent(gameType: number): boolean {
 // The same bit as {@link isSpectatorGame}, here only under the name of its effect at THIS site.
 // A second `=== 4` would be a second truth.
  return isSpectatorGame(gameType);
}
