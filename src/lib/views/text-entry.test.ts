import { describe, expect, it } from 'vitest';
import {
  TEXT_KEY_BACKSPACE,
  TEXT_KEY_COMMIT,
  TEXT_KEY_CURSOR_LEFT,
  TEXT_KEY_DELETE,
} from '../core/text-input.js';
import { textKeyFromKeyDown, textKeysFromEdit } from './text-entry.js';

const key = (k: string, mod: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mod,
});

describe('textKeyFromKeyDown', () => {
  it('maps the five control keys', () => {
    expect(textKeyFromKeyDown(key('ArrowLeft'))).toBe(TEXT_KEY_CURSOR_LEFT);
    expect(textKeyFromKeyDown(key('Backspace'))).toBe(TEXT_KEY_BACKSPACE);
    expect(textKeyFromKeyDown(key('Delete'))).toBe(TEXT_KEY_DELETE);
    expect(textKeyFromKeyDown(key('Enter'))).toBe(TEXT_KEY_COMMIT);
    expect(textKeyFromKeyDown(key('Escape'))).toBe(TEXT_KEY_COMMIT);
  });

  it('upper-cases a character, because the font bank has no lower case', () => {
    expect(textKeyFromKeyDown(key('a'))).toBe('A'.charCodeAt(0));
  });

  it('leaves shortcuts and named keys to the browser', () => {
    expect(textKeyFromKeyDown(key('a', { ctrlKey: true }))).toBeNull();
    expect(textKeyFromKeyDown(key('F5'))).toBeNull();
    // What an on-screen keyboard reports instead of the character — the edit event carries it.
    expect(textKeyFromKeyDown(key('Unidentified'))).toBeNull();
  });
});

describe('textKeysFromEdit', () => {
  it('takes the character of an on-screen keyboard', () => {
    expect(textKeysFromEdit({ inputType: 'insertText', data: 'b' })).toEqual(['B'.charCodeAt(0)]);
    expect(textKeysFromEdit({ inputType: 'insertCompositionText', data: 'c' })).toEqual([
      'C'.charCodeAt(0),
    ]);
  });

  it('takes every character of an edit that carries more than one', () => {
    expect(textKeysFromEdit({ inputType: 'insertFromPaste', data: 'ab' })).toEqual([
      'A'.charCodeAt(0),
      'B'.charCodeAt(0),
    ]);
  });

  it('maps the editing kinds to the control codes', () => {
    expect(textKeysFromEdit({ inputType: 'deleteContentBackward', data: null })).toEqual([
      TEXT_KEY_BACKSPACE,
    ]);
    expect(textKeysFromEdit({ inputType: 'deleteContentForward', data: null })).toEqual([
      TEXT_KEY_DELETE,
    ]);
    expect(textKeysFromEdit({ inputType: 'insertLineBreak', data: null })).toEqual([
      TEXT_KEY_COMMIT,
    ]);
  });

  it('ignores what it does not know, rather than inventing a key', () => {
    expect(textKeysFromEdit({ inputType: 'historyUndo', data: null })).toEqual([]);
    expect(textKeysFromEdit({ inputType: 'insertText', data: null })).toEqual([]);
  });
});
