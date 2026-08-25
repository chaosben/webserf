/**
 * The message overlay of the control bar - port of `draw_message_overlay` (`FUN_000335ce`). Two things
 * are visible in the message column: the blinking note while a message is pending, and below it the
 * return arrow that brings you back to where you were before reading messages. Plus the message sound.
 *
 * The original has four drawing helpers, two of which blit wood patches to ERASE - they exist only
 * because it draws incrementally into an existing framebuffer. Our renderer rebuilds the bar on every
 * state change, so only "visible or not" counts.
 *
 * Of the five bits in `vp+0x87` only two remain here:
 *
 * | Bit | Meaning | kept |
 * |---|---|---|
 * | 0 | a message is pending | derivable |
 * | 1 | list changed, re-evaluate | yes |
 * | 2 | note is currently drawn (blink phase) | no |
 * | 3 | return arrow visible | yes |
 * | 4 | arrow state changed, redraw | no |
 *
 * Bits 2 and 4 are drawing bookkeeping of an incremental renderer; the blink phase comes straight from
 * `gameTick & 0x60` instead, as in the original. Bit 0 is derivable and deliberately not kept as a
 * second state, because a redundant bit can drift: since {@link pruneFilteredMessages} discards
 * filtered messages from the FRONT, "list not empty" and "the oldest message passes the filter" are
 * the same statement after every prune - and the list only changes through paths that trigger one.
 *
 * The alarm itself is `flags` bit 3 in the player block, i.e. game state: `add_player_message` sets
 * it, this overlay acknowledges it and enqueues sound 1 while doing so, but only if a message survives
 * filtering. On an empty list the original does nothing visible, because the table value for type 0 is
 * `0xff` and the bit test then fails; `messageIsVisible` returns `false` for table values above 7,
 * which gives the same result without a special case.
 *
 * The arrow's clock `vp+0x1c0` runs 2000 game ticks (20 s) from showing a message, is cleared by
 * clicking the arrow, and is counted down by the frame timer alongside the recall queue. The original
 * does this for both viewports; we have one.
 *
 * Two further parts of the original routine live elsewhere: the recall consumer is game state and sits
 * in `engine/message-recall.ts`, and the tail is the bar's icon drawing with a dirty cache, which
 * `drawControlPanel` does anyway.
 *
 * // OPEN @0x2bf90 - `FUN_0002bf57` clears the entire message list of a player and sounds 8. It is
 * // reached not by a table dispatch but by a zone cascade in the popup click router using `jb` with a
 * // 32-bit displacement, which is why searching for `call`/`jmp`/u32 literals does not find it. The
 * // control is a click into the upper frame strip of an open popup, one 8-px column per player, gated
 * // on game type 4. Not ported because that gate has exactly one setter, in the game start
 * // initialisation, so it is unreachable in an ordinary game.
 */

import { messageIsVisible, pruneFilteredMessages } from './message-popup.js';
import { PLAYER_FLAG_MESSAGE_PENDING } from './engine/player-messages.js';
import { UI_SOUND_MESSAGE } from './ui-sound.js';

/** Lifetime of the return arrow in game ticks (`mov $0x7d0,%ax` @0x2791b). */
export const MESSAGE_ARROW_TICKS = 0x7d0;

/**
 * Mask of the blink phase (`andw $0x60,(%edi)` @0x33a37 on `gameTick`): the note is visible while the
 * result is **not** 0 — 96 of 128 ticks, so about 0.96 s on and 0.32 s off at 100 Hz.
 */
export const MESSAGE_BLINK_MASK = 0x60;

/**
 * The three save-reminder clocks as {@link serviceMessageOverlay} needs them — same shape as
 * `GameState.saveClocks`, but its own type so this module need not know the whole game state.
 */
export interface SaveClocks {
  quitGrace: number;
  reminder30: number;
  reminder60: number;
}

/** Message type "saved 30 minutes ago" (`vreg0 = 0x11` @0xd3e3). */
export const MESSAGE_TYPE_SAVE_30MIN = 0x11;
/** Message type "saved an hour ago" (`vreg0 = 0x12` @0xd452). */
export const MESSAGE_TYPE_SAVE_60MIN = 0x12;

/** The part of `vp+0x87` that cannot be derived — viewport state, not game state. */
export interface MessageOverlayState {
  /** Bit 1: after reading a message the list must be re-evaluated. */
  needsReview: boolean;
  /** Bit 3: return arrow visible. */
  arrowVisible: boolean;
  /** `vp+0x1c0`: remaining lifetime of the arrow in game ticks, 0 = none. */
  arrowTimer: number;
}

export function createMessageOverlayState(): MessageOverlayState {
  return { needsReview: false, arrowVisible: false, arrowTimer: 0 };
}

/** A player, as far as this module needs one. */
interface OverlayPlayer {
  flags: number;
  messageTypes: number[];
  messagePositions: number[];
}

/**
 * "Note clicked" — branch @0x27881 of the strip click, **after** `popMessage` has run: switch the
 * arrow on (`bts $0x4` + `bts $0x3` @0x278b7/@0x278ce), remember the view as the starting point
 * (`vp[0x1c2]/[0x1c4]`, the caller's business here) and mark the list for re-evaluation
 * (`bts $0x1` @0x27910), plus the arrow clock.
 *
 * The original switches the arrow on only while it is still **off** (`bt $0x3 ; jne 0x278fc`
 * @0x278a0) — which keeps the first remembered starting point across several read messages. The
 * clock, in contrast, is reset **every time**.
 */
export function noteMessageShown(ov: MessageOverlayState): void {
  ov.arrowVisible = true;
  ov.needsReview = true;
  ov.arrowTimer = MESSAGE_ARROW_TICKS;
}

/** "Arrow clicked" — @0x2779f: arrow off, clock to 0 (`xor %ax,%ax ; mov %ax,vp[0x1c0]` @0x277b3). */
export function noteArrowClicked(ov: MessageOverlayState): void {
  ov.arrowVisible = false;
  ov.arrowTimer = 0;
}

/**
 * The overlay's per-frame service. Runs on the logic frame, as in the original
 * (`draw_message_overlay` sits in the frame loop @0xbe22, the arrow clock in `frame_timer`).
 *
 * `delta` is the frame length in game ticks. Returns the sound to enqueue, or `null`.
 */
export function serviceMessageOverlay(
  ov: MessageOverlayState,
  player: OverlayPlayer,
  viewOptions: number,
  delta: number,
  clocks?: SaveClocks,
): number | null {
  let sound: number | null = null;

  // Branch 1 (@0x3374b): the alarm. Acknowledge, filter, and sound if a message remains.
  if ((player.flags & PLAYER_FLAG_MESSAGE_PENDING) !== 0) {
    player.flags &= ~PLAYER_FLAG_MESSAGE_PENDING;
    pruneFilteredMessages(player.messageTypes, player.messagePositions, viewOptions);
    if (hasVisibleMessage(player, viewOptions)) sound = UI_SOUND_MESSAGE;
  }

  // Branch 2 (@0x338c1): re-evaluation after reading — no sound, only filtering.
  if (ov.needsReview) {
    ov.needsReview = false;
    pruneFilteredMessages(player.messageTypes, player.messagePositions, viewOptions);
  }

  // The two **save reminders** (@0xd3c0 and @0xd42f, the same original routine): i32 clocks in `gs`
  // that fall by the same frame delta and fire **exactly once on the sign change** — afterwards the
  // `jns` test keeps them closed forever, which is why they may stay negative and are NOT clamped to
  // 0. Position 0, recipient is the viewport's player (`vp+0x82`).
  //
  // Three places reset them, as in the original: game start (@0xbc21), main-menu action A40
  // (@0x4fc80) and a successful **save** (@0x28514, see `core/disk-menu.ts`).
  //
  // `clocks` is optional because the caller need not know them: the clocks are global game state
  // while this module is per viewport. Without them only the rest runs.
  const remind = (type: number): void => {
    // `add_player_message(vreg0 = type, vreg1 = 0, vreg2 = player)` — the same prefix packing as
    // everywhere, done directly here rather than via `engine/player-messages.ts`: this module knows
    // only the three player fields that make up the list (see {@link OverlayPlayer}).
    if (player.messageTypes.length >= 64) return;
    player.messageTypes.push(type & 0xff);
    player.messagePositions.push(0);
    player.flags |= PLAYER_FLAG_MESSAGE_PENDING;
  };
  if (clocks) {
    if (clocks.reminder30 >= 0) {
      clocks.reminder30 -= delta;
      if (clocks.reminder30 < 0) remind(MESSAGE_TYPE_SAVE_30MIN);
    }
    if (clocks.reminder60 >= 0) {
      clocks.reminder60 -= delta;
      if (clocks.reminder60 < 0) remind(MESSAGE_TYPE_SAVE_60MIN);
    }
    // The third clock carries no message — it is the gate of the quit button and falls in u16 with a
    // clamp at 0 (`sub ; jae` @0x13110 ff.).
    if (clocks.quitGrace !== 0)
      clocks.quitGrace = clocks.quitGrace <= delta ? 0 : clocks.quitGrace - delta;
  }

  // Branch 3 (@0xd4ad): the arrow clock. The original's `je`/`jae` mean an exact zero crossing also
  // clears the arrow (`sub ; je 0xd4c8` @0xd4c4).
  if (ov.arrowTimer !== 0) {
    if (ov.arrowTimer <= delta) {
      ov.arrowTimer = 0;
      ov.arrowVisible = false;
    } else {
      ov.arrowTimer -= delta;
    }
  }

  return sound;
}

/**
 * Bit 0 derived: is a message pending that the level filter lets through? After a prune this is
 * equivalent to "list not empty"; the filter test stands here anyway so the function says the same
 * **without** a preceding prune.
 */
export function hasVisibleMessage(player: OverlayPlayer, viewOptions: number): boolean {
  const head = player.messageTypes[0] ?? 0;
  return head !== 0 && messageIsVisible(head, viewOptions);
}

/** What is visible in the message column. */
export interface MessageOverlayDisplay {
  /** The blinking note (entry 1781). */
  readonly note: boolean;
  /** The return arrow (entry 1783). */
  readonly arrow: boolean;
}

/**
 * Visibility of both indicators. The note blinks with `gameTick & 0x60` (@0x33a37) — and only while a
 * message is pending at all (bit 0, derived here).
 */
export function messageOverlayDisplay(
  ov: MessageOverlayState,
  player: OverlayPlayer | null,
  viewOptions: number,
  gameTick: number,
): MessageOverlayDisplay {
  const pending = player !== null && hasVisibleMessage(player, viewOptions);
  return {
    note: pending && (gameTick & MESSAGE_BLINK_MASK) !== 0,
    arrow: ov.arrowVisible,
  };
}
