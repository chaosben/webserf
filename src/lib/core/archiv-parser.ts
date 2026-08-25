import type { SaveSlot } from './types.js';

/**
 * Parser for `ARCHIV.DS` — the save slot index.
 *
 * 160 bytes = 10 slots x 16 bytes:
 *
 * offset 0: 14 bytes name (ASCII, space padded)
 * offset 14: 1 byte constant 0xFF (separator)
 * offset 15: 1 byte used flag (0x01 = used, 0x00 = free)
 */
export const ARCHIV_SLOT_COUNT = 10;
export const ARCHIV_SLOT_SIZE = 16;
const NAME_LENGTH = 14;

/**
 * **The name of a free slot — it lives in the program, not in the archive.**
 *
 * The index reader `0x46cda` fills the 160-byte buffer with ten identical entries **before** reading
 * the file: loop counter `mov $0x9` @0x46ce6 (`subw $0x1` + `jae 0x46ced` => ten rounds), and the 16
 * bytes per round stand as `mov $imm,%al` immediates from @0x46ced —
 * `20 20 20 20 20 46 52 45 49 20 20 20 20 20 ff 00`.
 *
 * Two consequences. First: a **missing** `ARCHIV.DS` is not an error — the reader returns -1
 * (@0x46df3) but leaves the buffer alone, so the disk menu shows ten free slots. Second: the word is
 * **not** an archive string but part of the program code, so its language follows the executable, not
 * the asset archive. The English build decodes to `' FREE '` at the same place; both live in
 * `language.ts` under `OPAQUE_TEXTS`, and the constant here is the **German reference form**.
 */
export const ARCHIV_FREE_NAME = '     FREI     ';

export function parseArchiv(buffer: ArrayBuffer | ArrayBufferView): SaveSlot[] {
  const data = toUint8Array(buffer);
  const expected = ARCHIV_SLOT_COUNT * ARCHIV_SLOT_SIZE;

  if (data.byteLength < expected) {
    throw new Error(
      `parseArchiv: file too small (${data.byteLength} bytes, expected at least ${expected}).`,
    );
  }

  const slots: SaveSlot[] = new Array(ARCHIV_SLOT_COUNT);
  for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
    const base = i * ARCHIV_SLOT_SIZE;
    const name = decodeName(data.subarray(base, base + NAME_LENGTH));
    const used = data[base + 15] === 0x01;
    slots[i] = { index: i, name, used };
  }

  return slots;
}

/**
 * The 14 name bytes as ASCII — **verbatim, without trimming**.
 *
 * Trimming here loses information: the encoder pads a name to the left, so a name with a **leading**
 * space could not be restored. The original creates exactly such names — the default name of a freshly
 * written slot is `' KEIN NAME '` (14 individual `mov $imm,%al` from @0x371b6, see `disk-menu.ts`),
 * and the name entry writes at a cursor position, so it can leave spaces in front too.
 *
 * An entry holds 14 **characters**; trimming is a matter of display and belongs there — the original
 * renderer `diskSlotLine` explicitly does **not** trim, because the free placeholder is centred by
 * its spaces.
 */
function decodeName(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function toUint8Array(buf: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(buf);
}

/**
 * Writes the slot list back into the 160 `ARCHIV.DS` bytes — the counter direction to
 * {@link parseArchiv}. Without it a saved game is **invisible** in the original: the disk menu reads
 * only this index, never the directory.
 *
 * A **used** slot gets its 14 name characters, shorter ones padded on the right with spaces — not with
 * NUL (observed: `"ERSTER VERS " ff 01`). Since {@link parseArchiv} returns the bytes **verbatim**,
 * the round trip is exact for every name, including one with leading spaces.
 *
 * A **free** slot carries {@link ARCHIV_FREE_NAME} — the byte sequence the original's index reader
 * produces itself.
 *
 * A supplied `base` takes precedence for free slots, so the placeholder of a **different** language
 * build survives when the user brings a real `ARCHIV.DS`. Without a base the encoder writes the German
 * sequence, the only one verified.
 */
export function encodeArchiv(
  slots: readonly SaveSlot[],
  opts: { readonly base?: Uint8Array | null } = {},
): Uint8Array {
  const out = new Uint8Array(ARCHIV_SLOT_COUNT * ARCHIV_SLOT_SIZE);
  const base = opts.base ?? null;
  for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
    const at = i * ARCHIV_SLOT_SIZE;
    const slot = slots.find((s) => s.index === i);
    const used = slot?.used === true;
    if (used) {
      const name = (slot?.name ?? '').slice(0, NAME_LENGTH);
      for (let j = 0; j < NAME_LENGTH; j++) {
        out[at + j] = j < name.length ? name.charCodeAt(j) & 0xff : 0x20;
      }
    } else if (base && base.length >= at + NAME_LENGTH) {
      out.set(base.subarray(at, at + NAME_LENGTH), at);
    } else {
      for (let j = 0; j < NAME_LENGTH; j++) out[at + j] = ARCHIV_FREE_NAME.charCodeAt(j);
    }
    out[at + 14] = 0xff; // separator constant
    out[at + 15] = used ? 0x01 : 0x00;
  }
  return out;
}
