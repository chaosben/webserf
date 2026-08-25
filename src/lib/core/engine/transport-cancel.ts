/**
 * **Transport cancellation: detach everything on its way to a destination.**
 *
 * The original has one contiguous code block `[0x176c0, 0x17f6c)` with **three** entry points and
 * **one shared tail**. The entries differ only in which serf classes they clear:
 *
 * | Einstieg | Serf-Klasse | Schwanz `@0x17a52` |
 * |---|---|---|
 * | `FUN_000176c0` | laufende Siedler | **nein** (`ret` @0x177e8) |
 * | `FUN_000177e9` | resource carriers | yes (`jmp 0x17a52` @0x178eb) |
 * | `FUN_000178f0` | **both** | yes (fall-through — the tail physically lives in this routine) |
 *
 * Hence four routines here and not one parametrised: the three-way split is the binary's, and the
 * tail is **shared code** there, not a copy.
 *
 * `cancelTransportOnDelete` (`FUN_000178f0`) is the delete cleanup. It has exactly **two** call sites
 * in the whole binary:
 * - `@0x496eb` in the flag detach tail `FUN_0004968a`, where the burn-down path ends up;
 * - `@0x16bac` in `serf_state_52_KnightOccupyEnemyBuilding`, when occupying a captured building,
 *   immediately **before** the score transition.
 *
 * `demolish_flag` (`FUN_0004980e`) does **not** call it; it carries its own inline serf sweep
 * (`@0x49fa1`) — and that one does **not** test `serf[0xb]` for bit 7. The two variants really are
 * different in the original, so the port mirrors both separately.
 */

import type { GameState, Flag, Serf } from './state.js';
import { u16 } from './int.js';

// -- Serf sweep (`FUN_000176c0`) ---───────────────────────────────────────────────────────

/** States whose destination field `serf[0xc]` counts directly (`cmpb` @0x17757/@0x17760/@0x17769). */
const SERF_DEST_STATES = new Set([2, 1, 0x0f]); // Walking, IdleInStock, ReadyToLeaveInventory
/** States that count only via their follow-up state (`cmpb $0x5/$0x7` + `cmpb $0x2, serf[0xf]`). */
const SERF_LEAVING_STATES = new Set([5, 7]); // LeavingBuilding, ReadyToLeave

/**
 * **Detach every serf on its way to this flag** (`FUN_000176c0`).
 *
 * Walks all serf slots and hits those whose destination `serf[0xc]` is the flag, whose `serf[0xb]`
 * has bit 7 set and which are in a matching state. Effect: `serf[0xb] = 0xfe` and destination 0 — the
 * serf picks a new destination on its next move.
 */
export function cancelSerfDestinations(state: GameState, flagIndex: number): void {
  for (const s of state.serfs) {
    if (s == null) continue; // free slot (the original tests its bitmap)
    if (dest(s) !== flagIndex) continue;
    if (((s.stateData[0] ?? 0) & 0x80) === 0) continue; // `serf[0xb] < 0` @0x17748
    if (!matchesSerfState(s)) continue;
    s.stateData[0] = 0xfe;
    setDest(s, 0);
  }
}

function matchesSerfState(s: Serf): boolean {
  if (SERF_DEST_STATES.has(s.state)) return true;
  return SERF_LEAVING_STATES.has(s.state) && (s.stateData[4] ?? 0) === 2;
}

// -- Resource sweep (`FUN_000177e9`) ---─────────────────────────────────────────────────────────

/** Carrier states with a direct destination (`cmpb $0x3/$0xd` @0x17894/@0x1789d). */
const RES_DEST_STATES = new Set([3, 0x0d]); // Transporting, DropResourceOut
/** States that count via their follow-up state (`cmpb $0x5/$0xb` + `cmpb $0xd, serf[0xf]`). */
const RES_LEAVING_STATES = new Set([5, 0x0b]); // LeavingBuilding, MoveResourceOut

/**
 * **Detach every resource on its way to this flag** (`FUN_000177e9`): first cancel the resource
 * carriers, then the shared network sweep {@link clearDestinationFromNetwork}
 * (`jmp 0x17a52` @0x178eb).
 */
export function cancelResourceDestinations(state: GameState, flagIndex: number): void {
  for (const s of state.serfs) {
    if (s == null) continue; // free slot (the original tests its bitmap)
    if (dest(s) !== flagIndex) continue;
    if (!matchesResState(s)) continue;
    setDest(s, 0);
  }
  clearDestinationFromNetwork(state, flagIndex);
}

function matchesResState(s: Serf): boolean {
  if (RES_DEST_STATES.has(s.state)) return true;
  return RES_LEAVING_STATES.has(s.state) && (s.stateData[4] ?? 0) === 0x0d;
}

// -- Delete cleanup (`FUN_000178f0`) ---─────────────────────────────────────────────────────────────

/**
 * **Remove a deleted destination from the whole transport network** (`cancel_transport_on_delete`,
 * `FUN_000178f0` @0x178f0). `flagIndex` is the flag of the disappearing building or warehouse.
 *
 * One serf sweep handling **both** classes in an `else if` cascade (@0x179a0-0x17a2b), then the
 * shared network sweep. The cascade is mirrored deliberately rather than written as two calls to
 * {@link cancelSerfDestinations} + {@link cancelResourceDestinations}: the original decides **per
 * serf** exactly once — the bit 7 test `serf[0xb] < 0` (`jns` @0x179a8) belongs to the serf branch
 * only, and whatever fails it falls through into the resource branch.
 */
export function cancelTransportOnDelete(state: GameState, flagIndex: number): void {
  for (const s of state.serfs) {
    if (s == null) continue; // free slot (the original tests its bitmap)
    if (dest(s) !== flagIndex) continue; // `cmp %ax,0xc(%edi)` @0x17996
    if (((s.stateData[0] ?? 0) & 0x80) !== 0 && matchesSerfState(s)) {
      s.stateData[0] = 0xfe; // @0x179e0
      setDest(s, 0);
    } else if (matchesResState(s)) {
      setDest(s, 0); // @0x17a21 — `serf[0xb]` bleibt stehen
    }
  }
  clearDestinationFromNetwork(state, flagIndex);
}

// ── Der geteilte Schwanz (`@0x17a52`) ─────────────────────────────────────────────────────────────

/**
 * **The shared tail `@0x17a52`** — remove the destination from the network's transport bookkeeping.
 * Two sweeps:
 *
 * 1. **Flags**: every resource slot with this destination is released and the flag marked as having
 *    unscheduled resources. If the slot was already assigned to a direction, the **best remaining
 *    slot is chosen afresh** for that direction — highest `flagPriority` of the owner, on a tie the
 *    lowest slot index, because the original compares strictly with `<`.
 * 2. **Inventories**: the two-slot output queue is purged of entries with this destination and
 *    packed forward.
 *
 * Callers in the binary: {@link cancelResourceDestinations} (via `jmp`) and
 * {@link cancelTransportOnDelete} (per Fall-Through).
 */
export function clearDestinationFromNetwork(state: GameState, flagIndex: number): void {
  for (const f of state.flags) {
    if (f == null) continue;
    // The original walks the eight slots DESCENDING (`vreg6 = 7`, decrement, all 8 visited).
    for (let i = 7; i >= 0; i--) {
      const raw = slotByte(f, i);
      if (raw === 0) continue; // `if (flag[0xc+i] != 0)` — the WHOLE byte, not just the type
      if (f.slotDest[i] !== flagIndex) continue;
      f.slotDest[i] = 0;
      f.hasResources = true; // flag[4] `|= 0x80`
      const dirNib = raw & 0xe0;
      if (dirNib === 0) continue;
      f.slotDir[i] = -1; // `flag[0xc+i] &= 0x1f`
      rescheduleDirection(state, f, dirNib);
    }
  }

  for (const inv of state.inventories) {
    if (inv == null) continue;
    if (inv.outQueue[1]!.dest === flagIndex) inv.outQueue[1]!.type = -1;
    if (inv.outQueue[0]!.dest === flagIndex) {
      inv.outQueue[0]!.type = inv.outQueue[1]!.type;
      inv.outQueue[0]!.dest = inv.outQueue[1]!.dest;
      inv.outQueue[1]!.type = -1;
    }
  }
}

/**
 * Pick the next resource slot to collect for one direction (@0x17910 ff.). The comparison basis is
 * the flag owner's `flagPriority`, indexed in the original as `player - 0x55` with the **raw**
 * resource type (1..26) — that is `flagPriority[type - 1]`, i.e. our `resourceSlots[i]`.
 */
function rescheduleDirection(state: GameState, f: Flag, dirNib: number): void {
  const dir = (dirNib >> 5) - 1;
  const prio = state.players[f.owner]?.flagPriority ?? null;
  let best = 0;
  let bestSlot = -1;
  for (let j = 0; j < 8; j++) {
    const raw = slotByte(f, j);
    if (raw === 0 || (raw & 0xe0) !== dirNib) continue;
    const p = prio?.[f.resourceSlots[j]!] ?? 0;
    if (best < p) {
      best = p;
      bestSlot = j;
    }
  }
  // `flag[0x3c+dir] &= 0x78` (@0x17dfa) clears bit 7 and bits 0..2 and **keeps** bits 3..6.
  // Bits 3..5 are `otherEndDir` (untouched). Bit 6 is not carried by our decoded model — across all
  // available saves it is **never set**, so keeping it is a no-op and nothing is lost.
  f.scheduled[dir] = false;
  f.scheduledSlot[dir] = 0;
  if (bestSlot >= 0) {
    f.scheduled[dir] = true;
    f.scheduledSlot[dir] = bestSlot;
  }
}

// -- Raw byte bridges ---───────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the raw slot byte `flag[0xc + i]` from the decoded fields: bits 0-4 = resource type + 1,
 * bits 5-7 = direction + 1. Needed because the original tests the **whole byte** against 0 and masks
 * the direction nibble — a test on `resourceSlots[i] >= 0` alone would not be the same.
 */
function slotByte(f: Flag, i: number): number {
  return ((f.resourceSlots[i]! + 1) & 0x1f) | (((f.slotDir[i]! + 1) & 7) << 5);
}

/** Ziel-Feld `serf[0xc]` (u16) = `stateData[1..2]`. */
function dest(s: Serf): number {
  return (s.stateData[1] ?? 0) | ((s.stateData[2] ?? 0) << 8);
}

function setDest(s: Serf, value: number): void {
  const v = u16(value);
  s.stateData[1] = v & 0xff;
  s.stateData[2] = (v >> 8) & 0xff;
}
