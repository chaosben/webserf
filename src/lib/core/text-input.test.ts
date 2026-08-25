import { describe, it, expect } from 'vitest';
import {
  TEXT_KEY_BACKSPACE,
  TEXT_KEY_CURSOR_LEFT,
  TEXT_KEY_CURSOR_RIGHT,
  TEXT_KEY_DELETE,
  editTextBuffer,
} from './text-input.js';

/**
 * The primitive was pulled **out of** `main-menu.ts` because the original has exactly one
 * (`input_buffer_putchar` @0xd073) and the disk menu is its second caller. That the move leaves the
 * main menu unchanged is covered by its own suite; here are the properties of the primitive itself —
 * above all the two that get lost when rebuilding it.
 */
describe('text-input — the shared input primitive', () => {
  const buf = (text: string, cursor: number) => ({ text, cursor });

  it('accepts nothing at the end of the buffer and does not advance either (@0xd0c2)', () => {
    // The last place is never overwritten — which is why the field is always full width.
    expect(editTextBuffer(buf('ABC', 3), 0x44)).toBeNull();
    expect(editTextBuffer(buf('ABC', 3), TEXT_KEY_CURSOR_RIGHT)).toBeNull();
  });

  it('leads backspace and delete into the same shift loop (@0xd1f3)', () => {
    // From the write position everything moves up by one, the last place becomes a space.
    expect(editTextBuffer(buf('ABCD', 2), TEXT_KEY_DELETE)).toEqual(buf('ABD ', 2));
    // Backspace first steps back by one.
    expect(editTextBuffer(buf('ABCD', 2), TEXT_KEY_BACKSPACE)).toEqual(buf('ACD ', 1));
    expect(editTextBuffer(buf('ABCD', 0), TEXT_KEY_BACKSPACE)).toBeNull(); // @0xd1c4
    expect(editTextBuffer(buf('ABCD', 4), TEXT_KEY_DELETE)).toBeNull(); // @0xd1ab
  });

  it('moves the cursor only inside the buffer', () => {
    expect(editTextBuffer(buf('AB  ', 0), TEXT_KEY_CURSOR_LEFT)).toBeNull();
    expect(editTextBuffer(buf('AB  ', 2), TEXT_KEY_CURSOR_LEFT)).toEqual(buf('AB  ', 1));
    expect(editTextBuffer(buf('AB  ', 2), TEXT_KEY_CURSOR_RIGHT)).toEqual(buf('AB  ', 3));
  });

  it('lets only 1..8 through with `digitsOnly` (@0xd093/@0xd098)', () => {
    expect(editTextBuffer(buf('    ', 0), 0x31, true)).toEqual(buf('1   ', 1));
    expect(editTextBuffer(buf('    ', 0), 0x38, true)).toEqual(buf('8   ', 1));
    expect(editTextBuffer(buf('    ', 0), 0x39, true)).toBeNull();
    expect(editTextBuffer(buf('    ', 0), 0x30, true)).toBeNull();
    expect(editTextBuffer(buf('    ', 0), 0x41, true)).toBeNull();
    // Without the bit the same letter is allowed — the name entry needs it.
    expect(editTextBuffer(buf('    ', 0), 0x41)).toEqual(buf('A   ', 1));
  });

  it('overwrites at the write position instead of inserting', () => {
    expect(editTextBuffer(buf('ABCD', 1), 0x58)).toEqual(buf('AXCD', 2));
  });

  it('ignores the zero key and unknown control characters', () => {
    expect(editTextBuffer(buf('    ', 0), 0)).toBeNull();
    expect(editTextBuffer(buf('    ', 0), 0x80)).toBeNull();
    expect(editTextBuffer(buf('    ', 0), 0xfa)).toBeNull();
  });
});
