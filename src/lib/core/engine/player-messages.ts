/**
 * **A player's message list** — port of `add_player_message` @0x18234.
 *
 * The original keeps 64 slots per player: a **type column** (`player+0x1df4`, one byte each) and a
 * **position column** (`+0x40`, u32 each, encoded map position). The type column is **prefix
 * packed**: a message always goes into the first slot with type 0, and the consumer clears only the
 * type byte when displaying it, so the position stays behind as a residual.
 *
 * ```
 * bts $0x3, player[2]  // flags bit 3 = "new message" wake bit — UNCONDITIONAL
 * p = player + 0x1df4
 * i = 0 ; while (p[i] != 0) { i++ ; if (i == 0x40) return }   // list full -> only the wake bit stays
 * p[i] = type ; *(u32*)(p + i*4 + 0x40) = position
 * ```
 *
 * The wake bit is set **before** the slot search, so it is set even when the list is full and the
 * message is dropped. It is one-sided: the consumer acknowledges it without emptying the list, which
 * is why read messages stay in place.
 */

import type { Player } from './state.js';

/** Message slots per player (`cmpw $0x40` @0x182a1). */
export const PLAYER_MESSAGE_SLOTS = 64;

/** `flags` bit 3 — the "new message queued" wake bit (`bts $0x3` @0x1826e). */
export const PLAYER_FLAG_MESSAGE_PENDING = 1 << 3;

/**
 * Queue a message for the player. `pos` is the **linear** map position (`row*cols + col`) as
 * everywhere else in the engine model.
 *
 * Returns `true` if a slot was free. The wake bit is set either way, even when the list is full.
 */
export function addPlayerMessage(player: Player, type: number, pos: number): boolean {
  player.flags |= PLAYER_FLAG_MESSAGE_PENDING;

 // Prefix packing: `messageTypes` holds exactly the used slots, so appending *is* the free slot.
  const types = player.messageTypes as number[];
  const positions = player.messagePositions as number[];
  if (types.length >= PLAYER_MESSAGE_SLOTS) return false;
  types.push(type & 0xff);
  positions.push(pos);
  return true;
}
