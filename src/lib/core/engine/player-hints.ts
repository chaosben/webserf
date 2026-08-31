/**
 * **The tutorial hint generator** — `FUN_000111b2`, called per player from `FUN_00011171` @0xfc3e,
 * the third head call of the resource distribution tick.
 *
 * > Its Ghidra name (`return_held_materials`) describes only the tail. Returning the parked building
 * > reserve is one of two exits of a 424-instruction routine whose purpose is the **five hint
 * > messages** of the opening phase.
 *
 * Order per player (the original's — the blocks fall through into each other):
 *
 * 1. If the player is not active (`flags` bit 6), return at once (exit @0x111c6).
 * 2. `inv` = the castle inventory (`player+0x108` == `castleInventory`).
 * 3. If `messageFlags` **bit 0** is set ("hints done"), return at once (@0x11211 -> @0x11751).
 *    Note that this jump goes to the **`ret`**, not to the return tail — with hints done there is
 *    **no** material return any more.
 * 4. **Hint A "out of planks"** (bit 1) and **hint B "out of stone"** (bit 2): when the respective
 *    stock in the castle runs to 0, the bit is set, `hintReturnDelay = 2`, and — **only if the other
 *    hint has not been shown yet** — message `0x0a` is queued.
 * 5. **The material return**: count `hintReturnDelay` down; **on the transition to 0** give the
 *    parked `heldPlanks`/`heldStone` back to the castle inventory — each only if its hint has been
 *    shown and the value is not 0.
 * 6. **Hints C/D/E** (bits 3/4/5) via the three `messageBuildingSlots`: if the building noted there
 *    is finished **or** fully supplied with building material, the bit is set and the slot cleared.
 *    The three blocks are **byte-identical** in the binary (179 B each, 0 differing bytes after
 *    normalising slot displacement and bit number), hence one loop over three pairs here instead of a
 *    thrice-copied body.
 * 7. **Completion**: once bits 3, 4 **and** 5 are set, bit 0 is set (hints off for good); if A or B
 *    was shown, bit 6 is cleared and message `0x0b` queued; then bits 1/2 are cleared and the reserve
 *    returned **unconditionally**.
 *
 * `messageFlags` bit 6 is a pure display marker of the message chain (set when triggering A/B,
 * cleared on completion) — it has no reader of its own in this routine.
 */

import type { GameState, Building, Inventory, Player } from './state.js';
import { addPlayerMessage } from './player-messages.js';
import { u16 } from './int.js';

/** `flags` bit 6 == player slot active (@0x111ba `bt $0x6`). */
const PLAYER_FLAG_ACTIVE = 1 << 6;

/** Bit layout of `messageFlags` (`player+0x163`). */
const HINT_DONE = 0; // bit 0 — hints off for good
const HINT_NO_PLANKS = 1; // bit 1 — "out of planks" shown
const HINT_NO_STONE = 2; // bit 2 — "out of stone" shown
const HINT_PENDING = 6; // bit 6 — display marker of the message chain

/** Resource indices of the two building materials (`inv+0x14` == res 7, `inv+0x18` == res 9). */
const RES_PLANK = 7;
const RES_STONE = 9;

/** Message types: `0x0a` for hint A/B (@0x11283/@0x1131e), `0x0b` on completion (@0x116bb). */
const MSG_MATERIAL_HINT = 0x0a;
const MSG_HINTS_DONE = 0x0b;

/** Value `hintReturnDelay` is set to (@0x112a4/@0x1133f `mov $0x2,%ax`). */
const RETURN_DELAY = 2;

/**
 * The three building hints as (bit, slot) pairs — three byte-identical blocks in the binary:
 * bit 3 <-> `messageBuildingSlots[0]` (@0x113f5, first lumberjack), bit 4 <-> `[1]` (@0x114a8,
 * sawmill),
 * Bit 5 ↔ `[2]` (@0x1155b, Steinmetz).
 */
const BUILDING_HINTS: readonly { bit: number; slot: number; addr: string }[] = [
  { bit: 3, slot: 0, addr: '0x113f5' },
  { bit: 4, slot: 1, addr: '0x114a8' },
  { bit: 5, slot: 2, addr: '0x1155b' },
];

const bitSet = (flags: number, bit: number): boolean => ((flags >> bit) & 1) !== 0;

/** Hint generator for all four player slots (== `FUN_00011171` @0x11171). */
export function updateAllPlayerHints(state: GameState): void {
  for (let slot = 0; slot < 4; slot++) {
    const player = state.players[slot];
    if (player) updatePlayerHints(state, player);
  }
}

/** One player pass (== `return_held_materials` @0x111b2). */
export function updatePlayerHints(state: GameState, player: Player): void {
  // @0x111c4 `jne 0x111c7` / @0x111c6 `ret` — inactive slot.
  if ((player.flags & PLAYER_FLAG_ACTIVE) === 0) return;

  // @0x111ca: inv = gs->inventories + player[0x108] * 0x78. In the original the pointer is always
  // valid; here the slot can be empty before the castle is founded.
  const inv = state.inventories[player.castleInventory] ?? null;
  if (!inv) return;

  // @0x11211 `jne 0x11751` — jumps to the `ret`, NOT to the return tail: with the hints done
  // nothing is returned any more either.
  if (bitSet(player.messageFlags, HINT_DONE)) return;

  materialHint(player, inv, HINT_NO_PLANKS, HINT_NO_STONE, RES_PLANK); // @0x11217
  materialHint(player, inv, HINT_NO_STONE, HINT_NO_PLANKS, RES_STONE); // @0x112b2
  returnHeldMaterialsAfterDelay(player, inv); // @0x1134d
  for (const h of BUILDING_HINTS) buildingHint(state, player, h.bit, h.slot); // @0x113f5/@0x114a8/@0x1155b
  finishHints(player, inv); // @0x1160e
}

/**
 * **Hint A / B** (@0x11217 and @0x112b2, structurally the same): when the building material in the
 * castle runs to 0, the hint is ticked off and the return delay set. The message itself appears
 * **only if the other of the two hints has not been shown yet** (@0x1126a/@0x11305) — so if planks
 * *and* stone run out in the same pass, only one message appears.
 */
function materialHint(
  player: Player,
  inv: Inventory,
  ownBit: number,
  otherBit: number,
  res: number,
): void {
  if (bitSet(player.messageFlags, ownBit)) return; // already shown
  if (inv.resources[res] !== 0) return; // material still available
  player.messageFlags |= 1 << ownBit; // `bts`
  if (!bitSet(player.messageFlags, otherBit)) {
    player.messageFlags |= 1 << HINT_PENDING; // @0x11277/@0x11312 `bts $0x6`
    // @0x1129f/@0x1133a `call 0x18234` with vreg0 = type, vreg1 = 0 (position), vreg2 = player[0]
    addPlayerMessage(player, MSG_MATERIAL_HINT, 0);
  }
  player.hintReturnDelay = RETURN_DELAY;
}

/**
 * **The material return after the delay** (@0x1134d..@0x113f5). The countdown is only decremented
 * when it is not 0, and the return happens **exactly on the transition to 0** (@0x11363 `subw $0x1` +
 * @0x1136b `jne`). Two further conditions per material: its hint must have been shown and the parked
 * value must not be 0.
 */
function returnHeldMaterialsAfterDelay(player: Player, inv: Inventory): void {
  if (player.hintReturnDelay === 0) return; // @0x1135a `je 0x113f5`
  player.hintReturnDelay = u16(player.hintReturnDelay - 1);
  if (player.hintReturnDelay !== 0) return; // @0x1136b `jne 0x113f5`

  if (bitSet(player.messageFlags, HINT_NO_PLANKS) && player.heldPlanks !== 0) {
    inv.resources[RES_PLANK] = u16(inv.resources[RES_PLANK] + player.heldPlanks);
    player.heldPlanks = 0;
  }
  if (bitSet(player.messageFlags, HINT_NO_STONE) && player.heldStone !== 0) {
    inv.resources[RES_STONE] = u16(inv.resources[RES_STONE] + player.heldStone);
    player.heldStone = 0;
  }
}

/**
 * **Hint C / D / E** (three byte-identical blocks): the hint about the building noted in
 * `messageBuildingSlots` counts as done as soon as the building is **finished** or its building
 * material has been **fully delivered**.
 *
 * The second condition is a **byte** computation on the packed stock bytes and must not be
 * simplified to `available[0] + available[1]`:
 * `((bld[8] + bld[9]) >> 4) == (bld[0x10] + bld[0x11])`, both sums as `u8` (@0x11458..@0x11482).
 * `bld[8]` is `(available << 4) | requested`, so the byte sum carries from the `requested` nibbles
 * into the upper half and `shrb` cuts off at the top. Reproduced exactly like that.
 */
function buildingHint(state: GameState, player: Player, bit: number, slot: number): void {
  if (bitSet(player.messageFlags, bit)) return; // @0x1140a — already done
  const index = player.messageBuildingSlots[slot];
  if (index === 0) return; // @0x11420 — no building noted
  const bld = state.buildings[index] ?? null;
  if (!bld) return; // in the original the pointer is always valid

  // @0x11456 `jns 0x11484` — bit 7 of bld[4] is `constructing`; a FINISHED building ticks the hint
  // off directly, without the material computation.
  if (bld.constructing && !stockComplete(bld)) return; // @0x11482 `jne 0x114a8`

  player.messageFlags |= 1 << bit; // @0x1148f `bts`
  (player.messageBuildingSlots as number[])[slot] = 0; // @0x114a1
}

/** `((bld[8] + bld[9]) >> 4) == (bld[0x10] + bld[0x11])`, both sums as u8 (see `buildingHint`). */
function stockComplete(bld: Building): boolean {
  const raw = (slotByte(bld, 0) + slotByte(bld, 1)) & 0xff;
  const max = bld.stockMaximum ? (bld.stockMaximum[0] + bld.stockMaximum[1]) & 0xff : 0;
  return (raw >> 4) === max;
}

/** Packed stock byte `bld+8`/`bld+9`: high nibble available, low nibble requested. */
function slotByte(bld: Building, slot: 0 | 1): number {
  const st = bld.stock[slot];
  if (!st) return 0;
  return (((st.available & 0xf) << 4) | (st.requested & 0xf)) & 0xff;
}

/**
 * **Completion** (@0x1160e..@0x1174b): only once all three building hints are done are the hints
 * switched off for good. If A or B was shown, the completion message `0x0b` follows (and bit 6
 * falls). Then bits 1/2 are cleared and the reserve returned **unconditionally** — here without the
 * `!= 0` tests of the delay block (@0x1170a..@0x1174b).
 */
function finishHints(player: Player, inv: Inventory): void {
  // Three `je 0x11751` in a row (@0x11623/@0x1163e/@0x11659) — any missing bit ends the routine.
  if (!bitSet(player.messageFlags, 3)) return;
  if (!bitSet(player.messageFlags, 4)) return;
  if (!bitSet(player.messageFlags, 5)) return;

  player.messageFlags |= 1 << HINT_DONE; // @0x1166a `bts $0x0`

  // @0x1168b `jne 0x116a4` / @0x116a2 `je 0x116dc` — the completion message only if A OR B ran.
  if (bitSet(player.messageFlags, HINT_NO_PLANKS) || bitSet(player.messageFlags, HINT_NO_STONE)) {
    player.messageFlags &= ~(1 << HINT_PENDING) & 0xff; // @0x116af `btr $0x6`
    addPlayerMessage(player, MSG_HINTS_DONE, 0); // @0x116d7
  }

  player.messageFlags &= ~(1 << HINT_NO_PLANKS) & 0xff; // @0x116e7 `btr $0x1`
  player.messageFlags &= ~(1 << HINT_NO_STONE) & 0xff; // @0x116fe `btr $0x2`

  inv.resources[RES_PLANK] = u16(inv.resources[RES_PLANK] + player.heldPlanks); // @0x11722
  player.heldPlanks = 0; // @0x1172b
  inv.resources[RES_STONE] = u16(inv.resources[RES_STONE] + player.heldStone); // @0x11742
  player.heldStone = 0; // @0x1174b
}
