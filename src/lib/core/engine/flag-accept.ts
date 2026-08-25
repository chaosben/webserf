/**
 * **The two accept bytes of a flag** — `flag+0x42` (`bldFlags`) and `flag+0x44` (`bld2Flags`).
 *
 * Each carries two things in **one** byte: bit 7 = "accepts serfs / resources", the lower bits = the
 * **demand mask** (what the corresponding stock slot of the attached building wants; a construction
 * site carries `0x2` = plank or `0x10` = stone). Our model keeps the same byte **twice** — raw as
 * `bldFlags`/`bld2Flags` and decoded as `acceptsSerfs`/`acceptsResources` — because the parser
 * supplies both and the popup renderers read the booleans.
 *
 * **That duplication is a real trap**: clearing only the **bit** on completion leaves the site's mask
 * (`0x2` / `0x10`) standing, and the resource scheduler reads the mask, not the bit — a finished
 * guard tower then keeps asking for building material.
 *
 * The original writes the **whole byte** at both clearing sites:
 *
 * ```asm
 * ; construction finished (serf state 09)
 * 256ce:  32 c0              xor  %al,%al
 * 256d0:  88 43 42           mov  %al,0x42(%ebx)      ; flag+0x42 = 0
 * 256d6:  32 c0              xor  %al,%al
 * 256d8:  88 43 44           mov  %al,0x44(%ebx)      ; flag+0x44 = 0
 * ; demolition tail FUN_0004968a
 * 496db:  32 c0              xor  %al,%al
 * 496dd:  8b 5f 24           mov  0x24(%edi),%ebx
 * 496e0:  88 43 42           mov  %al,0x42(%ebx)
 * 496e5:  88 43 44           mov  %al,0x44(%ebx)
 * ```
 *
 * **Not every site writes the byte**, and that is not sloppiness but the difference between
 * "reset the state" and "flip a switch". Surveyed over all accesses: the stock in/out menu
 * (`inventory-mode.ts`, six sites) and the AI's warehouse policy (`ai-building-round.ts`, two) use
 * `bts`/`btr $0x7` and leave the mask standing **on purpose**; there the port stays with the
 * booleans. Anything that sets the byte goes through {@link setFlagAcceptByte}, which keeps both
 * halves of the model in one place.
 */
import type { Flag } from './state.js';

/** Which of the two bytes is meant, named after its offset in the flag record. */
export type FlagAcceptByte = 0x42 | 0x44;

/**
 * Writes one accept byte **completely** and derives the decoded bit along with it.
 *
 * There is deliberately no variant that sets only the mask or only the bit: that separation is what
 * made a finished guard tower ask for stones.
 */
export function setFlagAcceptByte(flag: Flag, which: FlagAcceptByte, value: number): void {
  const v = value & 0xff;
  if (which === 0x42) {
    flag.bldFlags = v;
    flag.acceptsSerfs = (v & 0x80) !== 0;
  } else {
    flag.bld2Flags = v;
    flag.acceptsResources = (v & 0x80) !== 0;
  }
}

/**
 * Both bytes to 0 — the step shared by completion (@0x256ce) and the demolition tail (@0x496db),
 * clearing accept bit **and** demand mask.
 */
export function clearFlagAcceptBytes(flag: Flag): void {
  setFlagAcceptByte(flag, 0x42, 0);
  setFlagAcceptByte(flag, 0x44, 0);
}
