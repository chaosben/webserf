/**
 * **Stock in/out: switching a warehouse's mode** (screen 0x2c).
 *
 * The tick next to the resource or serf pictogram sits in one of three places — *stock in* (the
 * default), *accept nothing more*, or *clear everything out*. The lower two are deliberately
 * reachable only by special click; their purpose is an orderly retreat from a threatened warehouse.
 *
 * In the binary these are **six** separate action handlers — `FUN_0002e119` (resources: in),
 * `FUN_0002e166` (stop), `FUN_0002e1f8` (out), `FUN_0002e28a` (serfs: in), `FUN_0002e2d7` (stop),
 * `FUN_0002e369` (evacuate). They are mirrored as six routines rather than merged into one
 * parametrised helper because the original sets its two bits individually per branch (`bts`/`btr`),
 * and that is exactly where they differ.
 *
 * Each handler does three things:
 * 1. set the 2-bit field in the inventory's `res_dir` byte,
 * 2. set or clear the accept bit on the warehouse's **flag** (`flag[0x42]` bit 7 = accepts serfs,
 *    `flag[0x44]` bit 7 = accepts resources),
 * 3. when moving *away* from "accept", clear out everything already on its way to that flag —
 *    `cancelSerfDestinations` (`FUN_000176c0`) or `cancelResourceDestinations` (`FUN_000177e9`).
 *    Those two sweeps have **only** these four call sites in the whole binary.
 *
 * **Not backed by data.** In every save available `res_dir == 0` — the function was never used. The
 * stored values (0/1/**3**, not 0/1/2) and the effect of the sweeps are therefore established from
 * the code alone.
 */

import type { GameState, Flag, Inventory } from './state.js';
import { cancelResourceDestinations, cancelSerfDestinations } from './transport-cancel.js';

/** What the handlers actually store: `btr/btr`, `bts/btr`, `bts/bts` => 0, 1, **3**. */
export const MODE_IN = 0;
export const MODE_STOP = 1;
export const MODE_OUT = 3;

/** Assemble the `res_dir` byte from the two 2-bit fields (bits 0-1 resources, 2-3 serfs). */
function packResDir(inv: Inventory): void {
  inv.resDir = (inv.resDir & ~0xf) | (inv.resMode & 3) | ((inv.serfMode & 3) << 2);
}

/** The warehouse's flag (`inv[2]`) — target of the accept bits and of the sweeps. */
function inventoryFlag(state: GameState, inv: Inventory): Flag | null {
  return state.flags[inv.flag] ?? null;
}

// -- The six handlers ---──────────────────────────────────────────────────────────────────────────

/** `FUN_0002e119` — resources **in** (tick at the top). `btr $0,btr $1` @0x2e126/@0x2e13a. */
export function setResourceModeIn(state: GameState, inv: Inventory): void {
  inv.resMode = MODE_IN;
  packResDir(inv);
  const f = inventoryFlag(state, inv);
  if (f) f.acceptsResources = true; // flag[0x44] `bts $0x7` @0x2e159
}

/** `FUN_0002e166` — **accept no more resources** (tick in the middle). `bts $0,btr $1` @0x2e187/@0x2e19b. */
export function setResourceModeStop(state: GameState, inv: Inventory): void {
  inv.resMode = MODE_STOP;
  packResDir(inv);
  const f = inventoryFlag(state, inv);
  if (!f) return;
  f.acceptsResources = false; // flag[0x44] `btr $0x7` @0x2e1ba
  cancelResourceDestinations(state, inv.flag);
}

/** `FUN_0002e1f8` — resources **out** (tick at the bottom). `bts $0,bts $1`. */
export function setResourceModeOut(state: GameState, inv: Inventory): void {
  inv.resMode = MODE_OUT;
  packResDir(inv);
  const f = inventoryFlag(state, inv);
  if (!f) return;
  f.acceptsResources = false;
  cancelResourceDestinations(state, inv.flag);
}

/** `FUN_0002e28a` — serfs **in** (tick at the top). `btr $2,btr $3`. */
export function setSerfModeIn(state: GameState, inv: Inventory): void {
  inv.serfMode = MODE_IN;
  packResDir(inv);
  const f = inventoryFlag(state, inv);
  if (f) f.acceptsSerfs = true; // flag[0x42] `bts $0x7`
}

/** `FUN_0002e2d7` — **accept no more serfs** (tick in the middle). `bts $2,btr $3`. */
export function setSerfModeStop(state: GameState, inv: Inventory): void {
  inv.serfMode = MODE_STOP;
  packResDir(inv);
  const f = inventoryFlag(state, inv);
  if (!f) return;
  f.acceptsSerfs = false;
  cancelSerfDestinations(state, inv.flag);
}

/** `FUN_0002e369` — **evacuate** the warehouse (tick at the bottom). `bts $2,bts $3`. */
export function setSerfModeOut(state: GameState, inv: Inventory): void {
  inv.serfMode = MODE_OUT;
  packResDir(inv);
  const f = inventoryFlag(state, inv);
  if (!f) return;
  f.acceptsSerfs = false;
  cancelSerfDestinations(state, inv.flag);
}
