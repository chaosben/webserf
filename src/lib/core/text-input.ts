/**
 * **The original's text input** — `input_buffer_putchar` @0xd073, the keyboard branch of the frame
 * loop (@0xcf08 -> @0xd075). The original has **exactly one**; it writes into the buffer `gs+0x23a`
 * points at, `gs+0x23e` characters wide, at position `gs+0x238`, and only runs while `gs+0x1ca`
 * bit 0 is set.
 *
 * Hence one module rather than two copies: the main menu points at the map-code block or at
 * `gs+0x35a`, the disk menu at the ARCHIV entry of the selected slot — **which** buffer is meant is
 * the whole difference. What happens to the finished text (parse a seed, look up a password, keep a
 * slot name) belongs to the caller; the original distinguishes that by redraw stage, not in here.
 *
 * Two things are not obvious: **at the end of the buffer the input accepts nothing more** and does
 * not advance either (`cmp %ax,0x4(%edi) ; je` @0xd0c2) — the last place is never overwritten. And
 * **backspace and delete end in the same shift loop** @0xd1f3: from the write position everything
 * moves up by one and the last place becomes a space; backspace first steps back by one.
 */

/** Cursor one place left (`cmpb $0xfc` @0xd0f7). */
export const TEXT_KEY_CURSOR_LEFT = 0xfc;
/** Cursor one place right (`cmpb $0xfb` @0xd12e). */
export const TEXT_KEY_CURSOR_RIGHT = 0xfb;
/** Backspace — step back, then shift the rest (`cmpb $0xfe` @0xd174 -> @0xd1b3). */
export const TEXT_KEY_BACKSPACE = 0xfe;
/** Delete — shift the rest up, the cursor stays (`cmpb $0xfd` @0xd179 -> @0xd182). */
export const TEXT_KEY_DELETE = 0xfd;
/** Finish the input (`cmpb $0xff` @0xd24e). */
export const TEXT_KEY_COMMIT = 0xff;

/** An input buffer: the text (always the full field length) and the write position `gs+0x238`. */
export interface TextBuffer {
  readonly text: string;
  readonly cursor: number;
}

/**
 * Put one character into the buffer. `null` == **unchanged** (every early-return branch of the
 * original); the finish key is handled by the caller, which alone knows what to evaluate.
 *
 * `digitsOnly` is `gs+0x1ca` bit 2 — only the digits 1..8 are accepted (@0xd093 `cmpb $0x31` /
 * @0xd098 `cmpb $0x39`).
 */
export function editTextBuffer(
  buf: TextBuffer,
  key: number,
  digitsOnly = false,
): TextBuffer | null {
  const n = buf.text.length;
  if (key === 0) return null; // @0xd075 `or %al,%al ; jne`
  if (key === TEXT_KEY_CURSOR_LEFT)
    return buf.cursor === 0 ? null : { text: buf.text, cursor: buf.cursor - 1 };
  if (key === TEXT_KEY_CURSOR_RIGHT)
    return buf.cursor === n ? null : { text: buf.text, cursor: buf.cursor + 1 };
  if (key === TEXT_KEY_BACKSPACE || key === TEXT_KEY_DELETE) {
    const at = key === TEXT_KEY_BACKSPACE ? buf.cursor - 1 : buf.cursor;
    if (at < 0 || at >= n) return null; // @0xd1c4 resp. @0xd1ab
    return { text: buf.text.slice(0, at) + buf.text.slice(at + 1) + ' ', cursor: at };
  }
  if (key >= 0x80) return null; // other control characters — @0xd317, not read
  if (digitsOnly && (key < 0x31 || key > 0x38)) return null;
  if (buf.cursor === n) return null; // buffer full — @0xd0c2
  return {
    text: buf.text.slice(0, buf.cursor) + String.fromCharCode(key) + buf.text.slice(buf.cursor + 1),
    cursor: buf.cursor + 1,
  };
}
