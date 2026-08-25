/**
 * The recall function - the queue in the player block (`player+0x1f34`). A player can send himself a
 * delayed message: it calls him back after a set time either to a particular place in the world or
 * into a particular menu or warehouse, with the five clocks selecting 5, 10, 20, 30 or 60 minutes.
 *
 * 64 entries of 8 bytes, each `{ u32 remaining, u32 payload }`, with the occupied count in
 * `player+0x172`. The sum of the three message fields adds up exactly to the end of the block
 * (`7796 + 64 + 256 + 512 == 8628`), which pins base and length.
 *
 * The payload is a UNION, distinguished by sign and by bit 0 - exactly how the consumer reads it:
 *
 * | Payload | Message type | Meaning |
 * |---|---|---|
 * | negative | 16 with parameter | recall into a distribution menu |
 * | odd | 19, position = payload without bit 0 | recall to a warehouse or castle |
 * | otherwise | 5 | recall to a place on the map |
 *
 * Those three types are exactly the ones the level filter switches via bit 0 of the control options,
 * and the icon table of type 16 has eight entries - as many menus as the writer's screen cascade
 * allows.
 *
 * No data evidence is possible here: no available save holds a recall, so the field meanings rest on
 * the code plus a round trip through the production port. Side effect: the parser addition is neutral
 * for the oracle.
 *
 * The consumer subtracts the tick difference since the last frame per call, which makes the table work
 * out to the manual's five times at 100 Hz.
 *
 * Why the engine and not the drawing pass (the same question as in `ambient-sound.ts`, with the other
 * answer): the original calls the consumer from `draw_message_overlay`, but its input is only a clock -
 * no visibility counter, no clip rectangle - and its effect is game state. Placed in the renderer,
 * display and headless run would diverge. The original's gates also enforce exactly one pass per frame.
 */

import { addPlayerMessage, PLAYER_MESSAGE_SLOTS } from './player-messages.js';
import { decodePackedPos, encodePackedPos, posOf, type MapGeometry } from './position.js';
import type { GameState, Player } from './state.js';

/** Ein FIFO-Eintrag: `{ u32 Restzeit, u32 Nutzlast }` (`player+0x1f34 + i·8`). */
export interface RecallEntry {
  /** Remaining time in game ticks; the frame pass subtracts the frame length. */
  remaining: number;
  /** Raw payload as a **signed** i32 — the union from the module head. */
  payload: number;
}

/** Number of FIFO slots (`cmpw $0x40,(%edi)` @0x279b2 — full means rejected). */
export const RECALL_SLOTS = PLAYER_MESSAGE_SLOTS;

/**
 * The FIFO is kept as a **full 64-slot table plus a counter**, not as a list of the occupied
 * entries — unlike the message list next to it, which is prefix packed.
 *
 * That is not a matter of style: at one point the original's consumer is **not** equivalent to
 * "remove an element". When an entry expires the counter is always decremented, but shifting the
 * following entries up is skipped if the loop budget runs out in the process
 * (`subw $0x1,vreg3 ; jb 0x3374b` @0x336f5). On the **first** expiry of a frame this only affects the
 * last entry and is harmless; on the **second** the rearmost entry silently drops out of the list
 * while the already processed one stays. A `splice` list could not express this — with table plus
 * counter the loop is a literal transcription and needs no equivalence argument at all.
 */
export function emptyRecallQueue(): RecallEntry[] {
  return Array.from({ length: RECALL_SLOTS }, () => ({ remaining: 0, payload: 0 }));
}

/**
 * The five delays in game ticks — the original's table, stored **twice** byte-identically
 * (@0x27ada for the menu and building recall, @0x27c86 for the map recall). At 100 Hz
 * `[30000, 60000, 120000, 180000, 360000]` are exactly 5 / 10 / 20 / 30 / 60 minutes, digit for
 * digit the manual's list.
 */
export const RECALL_DELAY_TICKS: readonly number[] = [30000, 60000, 120000, 180000, 360000];

/**
 * Which of the five clocks a click hits — **rows of 7 px** (`cmpw $0x7/$0xe/$0x15/$0x1c` @0x27a54
 * ff. for the menu recall, @0x27bb2 ff. for the map recall). `dy` is the click relative to the top
 * edge of the panel `vp[0x30]`.
 */
export function recallClockRow(dy: number): number {
  if (dy < 0x07) return 0;
  if (dy < 0x0e) return 1;
  if (dy < 0x15) return 2;
  if (dy < 0x1c) return 3;
  return 4;
}

/**
 * The same for the **building** recall — there the original computes `dy >> 3`, i.e. **rows of
 * 8 px** (`shrw $0x3,0x4(%edi)` @0x27b02, then doubled twice as a byte offset into the table).
 *
 * Against {@link recallClockRow} that is a genuine **inconsistency of the original** on the same
 * column of clocks: for `dy` 28..31 the 7 px arithmetic gives row 4 (60 min), the 8 px arithmetic
 * row 3 (30 min). Reproduced rather than smoothed over. Clamping is unnecessary and would not be
 * original either: the zone is only entered for `dy` 0..39 (panel height), so `dy >> 3` is provably
 * in 0..4.
 */
export function recallClockRowEighths(dy: number): number {
  return dy >> 3;
}

/**
 * Screen -> menu index 1..8 for the **menu** recall, or `null` if this screen allows none.
 *
 * The cascade @0x279df: `< 0x1c` rejected · `0x1c..0x21` menu · `0x26` building · `0x22..0x2a`
 * rejected · `0x2b/0x2c` building · `0x2d/0x2e` menu · `>= 0x2f` rejected. The index is
 * `screen - 0x1b`, and if that is `>= 7`, a further `- 0xb` (@0x27a1e...@0x27a2a) — so 1..6 for the
 * first six and 7..8 for `0x2d`/`0x2e`. Those are exactly the **eight distribution sub-screens**, and
 * `MESSAGE_MENU_ICONS` has exactly eight entries as independent confirmation.
 */
export function recallMenuIndex(screen: number): number | null {
  if (screen < 0x1c) return null;
  if (screen < 0x22) return screen - 0x1b;
  if (screen < 0x2d) return null; // 0x26/0x2b/0x2c are building recalls, see recallIsBuildingScreen
  if (screen < 0x2f) return screen - 0x1b - 0x0b;
  return null;
}

/** Does this screen carry a **building** recall? (`je 0x27aee` @0x279f6 · `jb 0x27aee` @0x27a0c) */
export function recallIsBuildingScreen(screen: number): boolean {
  return screen === 0x26 || screen === 0x2b || screen === 0x2c;
}

/** Is the queue full? Then the original rejects (`je 0x27c77`, sound 4). */
export function recallQueueFull(player: Player): boolean {
  return player.recallCount >= RECALL_SLOTS;
}

/**
 * Append an entry — the body shared by the three writers (`player[0x172] += 1`, slot = the **old**
 * counter value, `slot*8 + 0x1f34`). Returns `false` if the queue was full; the original tests that
 * before appending and ends with the rejection sound.
 */
export function pushRecall(player: Player, remaining: number, payload: number): boolean {
  if (player.recallCount >= RECALL_SLOTS) return false;
  const slot = player.recallCount;
  player.recallCount = slot + 1;
  const entry = (player.recallQueue as RecallEntry[])[slot]!;
  entry.remaining = remaining >>> 0;
  entry.payload = payload | 0;
  return true;
}

/**
 * **Recall to a place on the map** (type 5) — @0x27b9e, the branch without an open popup (`bt $0x1,
 * vp[1]` @0x279c4 set). The payload is the **packed** position of the view's centre tile
 * (`(vp[0x48] << gs[0x30]) + vp[0x46]`, then `*4` via two `x += x` @0x27c4f...@0x27c58), the same
 * encoding as in the serf and building records, whose shift is `gs[0x30] == rowShift + 1`. It is
 * divisible by 4, so bit 0 is clear and the consumer reads type 5.
 */
export function scheduleMapRecall(
  player: Player,
  col: number,
  row: number,
  delayRow: number,
  geo: MapGeometry,
): boolean {
  const delay = RECALL_DELAY_TICKS[delayRow] ?? RECALL_DELAY_TICKS[0]!;
  return pushRecall(player, delay, encodePackedPos(col, row, geo));
}

/**
 * **Recall into a distribution menu** (type 16 with parameter) — @0x27a1e. Payload = `-index`
 * (`neg` @0x27a3b), index from {@link recallMenuIndex}.
 */
export function scheduleMenuRecall(player: Player, menuIndex: number, delayRow: number): boolean {
  const delay = RECALL_DELAY_TICKS[delayRow] ?? RECALL_DELAY_TICKS[0]!;
  return pushRecall(player, delay, -menuIndex);
}

/**
 * **Recall to a warehouse or castle** (type 19) — @0x27aee. The original takes the building via
 * `player+0x176` (the index the open building popup refers to), computes `index * 0x12 + gs[0x9c]`,
 * reads its packed position and sets **bit 0** (`bts $0x0` @0x27b78) — that bit is the type marker,
 * which the consumer clears again.
 */
export function scheduleBuildingRecall(
  player: Player,
  col: number,
  row: number,
  delayRow: number,
  geo: MapGeometry,
): boolean {
  const delay = RECALL_DELAY_TICKS[delayRow] ?? RECALL_DELAY_TICKS[0]!;
  return pushRecall(player, delay, encodePackedPos(col, row, geo) | 1);
}

/**
 * Payload -> `{ message type, position }` (@0x33688...@0x336d8). The position is brought into the
 * **linear** form used everywhere else in the engine; the original passes the packed number straight
 * to `add_player_message`, and that is exactly the number our parser turns into the linear form on
 * load. For the menu recall the "position" is the menu index (1..8) and is never read — the linear
 * conversion yields 0 there, exactly what the parser would make of the stored byte.
 */
export function decodeRecallPayload(
  payload: number,
  geo: MapGeometry,
): { type: number; pos: number } {
  let value = payload | 0;
  let type = 5;
  if (value < 0) {
    value = -value;
    // 16-bit arithmetic as in the original (`subw`/`shlw`/`addw` @0x336cc...@0x336d4); what gets
    // stored is the low byte — `add_player_message` writes a byte column.
    type = ((((value - 1) << 5) + 0x10) & 0xffff) & 0xff;
  } else if ((value & 1) !== 0) {
    value = value & ~1;
    type = 0x13;
  }
  const decoded = decodePackedPos(value >>> 0, geo);
  const pos = decoded === null ? 0 : posOf(decoded.col, decoded.row, geo);
  return { type, pos };
}

/**
 * **The consumer** (@0x3363c...@0x33745) — once per frame, for every active player.
 *
 * Subtracts `delta` from every entry's remaining time. When an entry expires (remaining was smaller
 * than `delta`) it becomes a message: type and position from the payload, `add_player_message`,
 * `player[0x172] -= 1`, and the following entries shift up.
 *
 * The bookkeeping is the original's: `budget` starts at `count - 1` and is decremented once per
 * pass, but **twice** in the firing branch (@0x336f5 and @0x3372f) — a processed entry therefore
 * costs two units. On firing the index does **not** advance; after the shift the loop continues at
 * the same place (`jae 0x3367a` @0x33734), so the entry that moved up is still processed in the
 * **same** frame, as long as the budget lasts.
 *
 * The shifting loop provably does **not** read past the table. At the loop head
 * `budget == n - 1 - i - 2f` (n = count at the start, i = advance steps, f = entries already fired);
 * the highest source index is `i + budget + 1 == n - 2f` and therefore <= 63.
 *
 * **An original defect, reproduced faithfully.** If the budget runs out exactly on firing, the
 * counter drops (@0x336ed) but the shift is skipped. On the **first** expiry of a frame this is
 * harmless — there `i == n - 1`, the processed entry is the last one, and lowering the counter
 * removes exactly it. From the **second** on `i < count - 1`: the already processed entry stays (with
 * an underflowed, i.e. practically infinite, remaining time) and the entry behind it drops out of the
 * list with the counter. Reachable only when two recalls come due within one frame and at least one
 * more is waiting behind them.
 */
export function advanceRecallQueue(player: Player, delta: number, geo: MapGeometry): void {
  const queue = player.recallQueue as RecallEntry[];
  if (player.recallCount === 0) return;

  let budget = (player.recallCount - 1) & 0xffff;
  let i = 0;
  for (;;) {
    const entry = queue[i]!;
    const before = entry.remaining;
    entry.remaining = (before - delta) >>> 0;
    if (before >= delta) {
      // `jae 0x3373c` — no expiry: next entry.
      i += 1;
      if (budget === 0) return;
      budget -= 1;
      continue;
    }
    const { type, pos } = decodeRecallPayload(entry.payload, geo);
    addPlayerMessage(player, type, pos);
    player.recallCount -= 1;
    // `subw $0x1,vreg3 ; jb 0x3374b` — budget exhausted: the shift does NOT happen. On the first
    // expiry of a frame that is harmless (it was the last entry); from the second on the rearmost
    // entry drops out of the list with the lowered counter. Original behaviour.
    if (budget === 0) return;
    budget -= 1;
    let k = budget; // vreg5 = vreg3 (the value AFTER the first decrement)
    let j = i;
    for (;;) {
      const dst = queue[j]!;
      const src = queue[j + 1]!;
      dst.remaining = src.remaining;
      dst.payload = src.payload;
      j += 1;
      if (k === 0) break;
      k -= 1;
    }
    if (budget === 0) return;
    budget -= 1;
  }
}

/**
 * The frame pass over all active players. In the original it sits in
 * `draw_message_overlay_all_viewports` (@0x335ad), whose call in the frame loop comes **after** the
 * statistics recorder (`call 0xc100` @0xbe18, `call 0x335ad` @0xbe22) — the same place where
 * `tick.ts` calls this pass.
 */
export function advanceRecallQueues(state: GameState, delta: number): void {
  for (const player of state.players) {
    if (player === null || !player.active) continue;
    advanceRecallQueue(player, delta, state.geo);
  }
}
