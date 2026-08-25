import { describe, it, expect } from 'vitest';
import {
  MESSAGE_ARROW_TICKS,
  MESSAGE_BLINK_MASK,
  MESSAGE_TYPE_SAVE_30MIN,
  MESSAGE_TYPE_SAVE_60MIN,
  createMessageOverlayState,
  hasVisibleMessage,
  messageOverlayDisplay,
  noteArrowClicked,
  noteMessageShown,
  serviceMessageOverlay,
} from './message-overlay.js';
import { PLAYER_FLAG_MESSAGE_PENDING } from './engine/player-messages.js';
import { UI_SOUND_MESSAGE } from './ui-sound.js';
import { hitRecallClockStrip, RECALL_CLOCK_STRIP } from './message-popup.js';
import { clickOptionsPopup } from './options-popup.js';
import {
  VIEW_OPTIONS_DEFAULT,
  VIEW_OPTION_ROAD_SCROLL,
  cycleViewMessageLevel,
  messageLevel,
  viewOptions,
} from './engine/view-options.js';
import type { GameState } from './engine/state.js';

/** Message overlay (`draw_message_overlay` @0x335ce). */

/** All message levels on + bit 0 => nothing is filtered out (factory setting is 0x39). */
const ALL_LEVELS = 0x3f;

function player(types: number[] = [], pending = false) {
  return {
    flags: pending ? PLAYER_FLAG_MESSAGE_PENDING : 0,
    messageTypes: types,
    messagePositions: types.map(() => 0),
  };
}

describe('message overlay: the alarm and the sound', () => {
  it('acknowledges the alarm and plays sound 1 when a visible message is pending', () => {
    const ov = createMessageOverlayState();
    const p = player([1], true);
    expect(serviceMessageOverlay(ov, p, ALL_LEVELS, 8)).toBe(UI_SOUND_MESSAGE);
    expect(p.flags & PLAYER_FLAG_MESSAGE_PENDING).toBe(0);
  });

  it('does not play twice for the same message', () => {
    const ov = createMessageOverlayState();
    const p = player([1], true);
    serviceMessageOverlay(ov, p, ALL_LEVELS, 8);
    expect(serviceMessageOverlay(ov, p, ALL_LEVELS, 8)).toBeNull();
  });

  it('stays silent on an empty list — the alarm fizzles', () => {
    const ov = createMessageOverlayState();
    const p = player([], true);
    expect(serviceMessageOverlay(ov, p, ALL_LEVELS, 8)).toBeNull();
    expect(p.flags & PLAYER_FLAG_MESSAGE_PENDING).toBe(0);
  });

  it('discards filtered messages and then stays silent', () => {
    const ov = createMessageOverlayState();
 // Type 7 (new warehouse) sits on bit 3 - invisible below level 3.
    const p = player([7], true);
    expect(serviceMessageOverlay(ov, p, 0x31, 8)).toBeNull();
    expect(p.messageTypes).toEqual([]);
  });

  it('skips a filtered one and plays for the next', () => {
    const ov = createMessageOverlayState();
    const p = player([7, 1], true);
    expect(serviceMessageOverlay(ov, p, 0x31, 8)).toBe(UI_SOUND_MESSAGE);
    expect(p.messageTypes).toEqual([1]);
  });
});

/**
 * The chain **from the options screen to the overlay**: screen 0x25 sets the message level, and that
 * byte filters note and sound.
 *
 * Driven through the **production path** (click -> action -> setter), not through hand-built option
 * bytes — otherwise the test checks the table instead of the wiring.
 */
describe('message overlay: the level from the options screen', () => {
  /** Type -> thermometer bit, byte-equal to `DAT_00033bc7` @0x33bc7. */
  const TYPE_LEVEL3_ONLY = 7; // bit 3 — new warehouse
  const TYPE_LEVEL2 = 4; // bit 4 — building newly occupied
  const TYPE_LEVEL1 = 1; // bit 5 — attack and the like
  const TYPE_RECALL = 5; // bit 0 — own recall to a map position

  /** "EXTRA OPTION" — the screen holding the message row. */
  const EXTRA_OPTION_SCREEN = 0x25;

  function stateWith(left: number): GameState {
    return { header: { viewOptions: [left, VIEW_OPTIONS_DEFAULT] } } as unknown as GameState;
  }

  /** The click on the message row of the left half, found via the real zone table. */
  function clickMessageRow(state: GameState): void {
    let found = false;
    for (let y = 0; y < 0xd0 && !found; y++) {
      for (let x = 0; x < 0x90 && !found; x++) {
        const action = clickOptionsPopup(EXTRA_OPTION_SCREEN, x, y);
        if (action?.kind === 'messageLevel' && action.side === 0) {
          cycleViewMessageLevel(state, action.side);
          found = true;
        }
      }
    }
    expect(found, 'message row zone found').toBe(true);
  }

  function visibleTypes(opts: number): number[] {
    return [TYPE_LEVEL1, TYPE_LEVEL2, TYPE_LEVEL3_ONLY, TYPE_RECALL].filter((t) =>
      hasVisibleMessage(player([t]), opts),
    );
  }

  it('cycles 3 -> 2 -> 1 -> 0 -> 3 per click and arms the messages accordingly', () => {
    const s = stateWith(VIEW_OPTIONS_DEFAULT);

  // Factory setting: level 3 — everything visible.
    expect(messageLevel(viewOptions(s, 0))).toBe(3);
    expect(visibleTypes(viewOptions(s, 0))).toEqual([
      TYPE_LEVEL1,
      TYPE_LEVEL2,
      TYPE_LEVEL3_ONLY,
      TYPE_RECALL,
    ]);

    clickMessageRow(s);
    expect(messageLevel(viewOptions(s, 0))).toBe(2);
    expect(visibleTypes(viewOptions(s, 0))).toEqual([TYPE_LEVEL1, TYPE_LEVEL2, TYPE_RECALL]);

    clickMessageRow(s);
    expect(messageLevel(viewOptions(s, 0))).toBe(1);
    expect(visibleTypes(viewOptions(s, 0))).toEqual([TYPE_LEVEL1, TYPE_RECALL]);

    clickMessageRow(s);
    expect(messageLevel(viewOptions(s, 0))).toBe(0);

    clickMessageRow(s);
    expect(viewOptions(s, 0)).toBe(VIEW_OPTIONS_DEFAULT);

  // The right half stays untouched — the original keeps both bytes separate.
    expect(viewOptions(s, 1)).toBe(VIEW_OPTIONS_DEFAULT);
  });

  it('level 0 silences note and sound', () => {
    const s = stateWith(VIEW_OPTIONS_DEFAULT);
    clickMessageRow(s);
    clickMessageRow(s);
    clickMessageRow(s);
    const opts = viewOptions(s, 0);

    const ov = createMessageOverlayState();
    const p = player([TYPE_LEVEL1, TYPE_LEVEL2, TYPE_LEVEL3_ONLY], true);
    expect(serviceMessageOverlay(ov, p, opts, 8)).toBeNull();
    expect(p.messageTypes).toEqual([]); // discarded, not hidden
    expect(messageOverlayDisplay(ov, p, opts, 0x60).note).toBe(false);
  });

  /**
   * Original quirk: the shipped table puts the five recall/save types on **bit 0** — the road-building
   * scroll switch, not the thermometer. So the own recall still arrives at level 0; it falls silent
   * only when road-building scrolling is turned off.
   */
  it('lets the own recall through even at level 0 — it hangs on bit 0', () => {
    const s = stateWith(VIEW_OPTIONS_DEFAULT);
    clickMessageRow(s);
    clickMessageRow(s);
    clickMessageRow(s);
    const opts = viewOptions(s, 0);
    expect(messageLevel(opts)).toBe(0);

    expect(visibleTypes(opts)).toEqual([TYPE_RECALL]);
    const ov = createMessageOverlayState();
    const p = player([TYPE_RECALL], true);
    expect(serviceMessageOverlay(ov, p, opts, 8)).toBe(UI_SOUND_MESSAGE);
    expect(p.messageTypes).toEqual([TYPE_RECALL]);

  // Counter-check: without bit 0 it is gone too — the coupling is measured, not claimed.
    const noScroll = opts & ~VIEW_OPTION_ROAD_SCROLL;
    expect(hasVisibleMessage(player([TYPE_RECALL]), noScroll)).toBe(false);
  });
});

describe('message overlay: note and blinking', () => {
  it('shows the note only while a message is pending', () => {
    const ov = createMessageOverlayState();
    expect(messageOverlayDisplay(ov, player([]), ALL_LEVELS, 0x60).note).toBe(false);
    expect(messageOverlayDisplay(ov, player([1]), ALL_LEVELS, 0x60).note).toBe(true);
    expect(messageOverlayDisplay(ov, null, ALL_LEVELS, 0x60).note).toBe(false);
  });

  it('blinks with gameTick & 0x60 — visible for 96 of 128 ticks', () => {
    const ov = createMessageOverlayState();
    const p = player([1]);
    let visible = 0;
    for (let t = 0; t < 128; t++) {
      if (messageOverlayDisplay(ov, p, ALL_LEVELS, t).note) visible++;
    }
    expect(visible).toBe(96);
    expect(MESSAGE_BLINK_MASK).toBe(0x60);
  // The off phase sits at the start of every 128-tick period.
    expect(messageOverlayDisplay(ov, p, ALL_LEVELS, 0).note).toBe(false);
    expect(messageOverlayDisplay(ov, p, ALL_LEVELS, 31).note).toBe(false);
    expect(messageOverlayDisplay(ov, p, ALL_LEVELS, 32).note).toBe(true);
  });

  it('hasVisibleMessage follows the level filter, not just the length', () => {
    expect(hasVisibleMessage(player([7]), 0x31)).toBe(false);
    expect(hasVisibleMessage(player([7]), 0x39)).toBe(true);
  });
});

describe('message overlay: the return arrow', () => {
  it('appears on reading and expires after 2000 ticks', () => {
    const ov = createMessageOverlayState();
    const p = player([1]);
    noteMessageShown(ov);
    expect(ov.arrowVisible).toBe(true);
    expect(ov.arrowTimer).toBe(MESSAGE_ARROW_TICKS);
  // 249 frames of 8 ticks = 1992 — the arrow is still up.
    for (let i = 0; i < 249; i++) serviceMessageOverlay(ov, p, ALL_LEVELS, 8);
    expect(ov.arrowVisible).toBe(true);
    expect(ov.arrowTimer).toBe(8);
    serviceMessageOverlay(ov, p, ALL_LEVELS, 8);
    expect(ov.arrowVisible).toBe(false);
    expect(ov.arrowTimer).toBe(0);
  });

  it('disappears immediately when clicked', () => {
    const ov = createMessageOverlayState();
    noteMessageShown(ov);
    noteArrowClicked(ov);
    expect(ov.arrowVisible).toBe(false);
    expect(ov.arrowTimer).toBe(0);
    expect(messageOverlayDisplay(ov, player([1]), ALL_LEVELS, 0x60).arrow).toBe(false);
  });

  it('restarts the clock on every further message', () => {
    const ov = createMessageOverlayState();
    const p = player([1]);
    noteMessageShown(ov);
    for (let i = 0; i < 100; i++) serviceMessageOverlay(ov, p, ALL_LEVELS, 8);
    expect(ov.arrowTimer).toBe(MESSAGE_ARROW_TICKS - 800);
    noteMessageShown(ov);
    expect(ov.arrowTimer).toBe(MESSAGE_ARROW_TICKS);
  });

  it('reading marks the list for re-evaluation (bit 1)', () => {
    const ov = createMessageOverlayState();
    noteMessageShown(ov);
    expect(ov.needsReview).toBe(true);
  // The service works it off once and filters while doing so — without sound.
    const p = player([7]);
    expect(serviceMessageOverlay(ov, p, 0x31, 0)).toBeNull();
    expect(ov.needsReview).toBe(false);
    expect(p.messageTypes).toEqual([]);
  });
});

describe('clock column: click zone', () => {
  it('hits x in (444, 456] and returns the panel-relative dy', () => {
    const { x, width, y } = RECALL_CLOCK_STRIP;
    expect(hitRecallClockStrip(x, y)).toBeNull(); // `<` in the original, not `<=`
    expect(hitRecallClockStrip(x + 1, y)).toBe(0);
    expect(hitRecallClockStrip(x + width, y + 30)).toBe(30);
    expect(hitRecallClockStrip(x + width + 1, y)).toBeNull();
    expect(hitRecallClockStrip(x + 6, y - 1)).toBeNull();
  });

  it('sits next to the message column, not on it', () => {
  // Message column is x 184..196; the clocks 444..456 — no overlap.
    expect(hitRecallClockStrip(190, 0x1b8)).toBeNull();
  });
});

describe('message-overlay — the two save reminders', () => {
  /**
   * The property one loses when rebuilding this: they fire **exactly once** — the `jns` test keeps a
   * negative clock closed forever, which is why it is NOT clamped to 0.
   */
  const player = () => ({ flags: 0, messageTypes: [] as number[], messagePositions: [] as number[] });

  it('fires exactly once each after 180000 and 360000 ticks', () => {
    const ov = createMessageOverlayState();
    const p = player();
    const clocks = { quitGrace: 0x1770, reminder30: 0x2bf20, reminder60: 0x57e40 };
  // Just before: nothing.
    serviceMessageOverlay(ov, p, 0x39, 0x2bf20 - 1, clocks);
    expect(p.messageTypes).toEqual([]);
  // The zero crossing of the first clock.
    serviceMessageOverlay(ov, p, 0x39, 2, clocks);
    expect(p.messageTypes).toEqual([MESSAGE_TYPE_SAVE_30MIN]);
    expect(clocks.reminder30).toBeLessThan(0);
  // And never again after that — not even over many frames.
    for (let i = 0; i < 50; i++) serviceMessageOverlay(ov, p, 0x39, 1000, clocks);
    expect(p.messageTypes.filter((t) => t === MESSAGE_TYPE_SAVE_30MIN)).toHaveLength(1);
  // The second clock comes later and likewise once.
    serviceMessageOverlay(ov, p, 0x39, 0x57e40, clocks);
    expect(p.messageTypes.filter((t) => t === MESSAGE_TYPE_SAVE_60MIN)).toHaveLength(1);
  });

  it('sets the alarm so that note and sound follow', () => {
    const p = player();
    const clocks = { quitGrace: 0, reminder30: 0, reminder60: 0x57e40 };
    serviceMessageOverlay(createMessageOverlayState(), p, 0x39, 1, clocks);
    expect(p.flags & PLAYER_FLAG_MESSAGE_PENDING).not.toBe(0);
  });

  it('clamps the quit clock to 0 but the two reminders NOT', () => {
  // In the original the difference is the store width: u16 with `jae` clamp against i32 with `jns`.
    const clocks = { quitGrace: 100, reminder30: 100, reminder60: 100 };
    serviceMessageOverlay(createMessageOverlayState(), player(), 0x39, 500, clocks);
    expect(clocks.quitGrace).toBe(0);
    expect(clocks.reminder30).toBe(-400);
  });

  it('runs on unchanged without clocks', () => {
  // The parameter is optional so a caller without game state need not carry anything along.
    const p = player();
    expect(() => serviceMessageOverlay(createMessageOverlayState(), p, 0x39, 1000)).not.toThrow();
    expect(p.messageTypes).toEqual([]);
  });
});
