/**
 * KEY PRESSES -> the original's text-input codes.
 *
 * The original reads one byte per key (`input_buffer_putchar` @0xd073): a printable character as
 * its own code, plus the five control values 0xfb..0xff. Both entries of the port need that
 * translation — the main menu (password, map code) and the disk menu (slot name) — so it lives here
 * once, and without a DOM so it can be tested.
 *
 * **Why there are TWO translations for one key.** A physical keyboard reports `keydown` with the
 * character in `key`. An on-screen keyboard usually does not: several of them commit text through
 * an editing event and report `keydown` with `Unidentified` (historically `keyCode` 229). The event
 * both kinds agree on is `beforeinput`, which describes the edit itself rather than the key. So a
 * caller offers both and lets whichever fires first win — a key that `keydown` already handled
 * never reaches `beforeinput`, because cancelling `keydown` cancels the edit it would have caused.
 */

import {
  TEXT_KEY_BACKSPACE,
  TEXT_KEY_COMMIT,
  TEXT_KEY_CURSOR_LEFT,
  TEXT_KEY_CURSOR_RIGHT,
  TEXT_KEY_DELETE,
} from '../core/text-input.js';

/** The parts of a `KeyboardEvent` this translation looks at. */
export interface TextKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** The parts of an `InputEvent` this translation looks at. */
export interface TextEditEvent {
  readonly inputType: string;
  readonly data: string | null;
}

/**
 * A key press, or `null` for one this input does not consume — those stay with the browser, and the
 * caller must not cancel them.
 *
 * `Escape` is an addition of the port: the original has no cancel, and without it an entry opened by
 * accident could not be left. It ends the entry like `Enter` does.
 */
export function textKeyFromKeyDown(e: TextKeyEvent): number | null {
  if (e.key === 'ArrowLeft') return TEXT_KEY_CURSOR_LEFT;
  if (e.key === 'ArrowRight') return TEXT_KEY_CURSOR_RIGHT;
  if (e.key === 'Backspace') return TEXT_KEY_BACKSPACE;
  if (e.key === 'Delete') return TEXT_KEY_DELETE;
  if (e.key === 'Enter' || e.key === 'Escape') return TEXT_KEY_COMMIT;
  // With Ctrl/Alt/Meta it is a browser shortcut, not a character.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
    return e.key.toUpperCase().charCodeAt(0);
  return null;
}

/**
 * The codes an edit stands for. A LIST, because one edit can carry more than one character (paste,
 * or a word an on-screen keyboard commits in one go); empty means "nothing to do".
 *
 * The composition types are in here on purpose: an on-screen keyboard that corrects while typing
 * reports `insertCompositionText`, and in that state it is the only report there is. The original's
 * buffer has no composition, so each character is taken as it arrives.
 */
export function textKeysFromEdit(e: TextEditEvent): readonly number[] {
  switch (e.inputType) {
    case 'deleteContentBackward':
    case 'deleteWordBackward':
    case 'deleteSoftLineBackward':
      return [TEXT_KEY_BACKSPACE];
    case 'deleteContentForward':
    case 'deleteWordForward':
      return [TEXT_KEY_DELETE];
    case 'insertLineBreak':
    case 'insertParagraph':
      return [TEXT_KEY_COMMIT];
    case 'insertText':
    case 'insertReplacementText':
    case 'insertCompositionText':
    case 'insertFromPaste':
      return [...(e.data ?? '')].map((c) => c.toUpperCase().charCodeAt(0));
    default:
      return [];
  }
}
