/**
 * **The population allowance** — `FUN_000109b6` @0x109b6 (distribution) and `FUN_00010b2c` @0x10b2c
 * (the decision per player), the second head call of the resource distribution tick (@0xfc34).
 *
 * The land score of **all** active players is taken as a whole; each gets his share of it, scaled to
 * `populationSpan`, plus the base `populationBase`. If his serf count is below that, `build` **bit 2**
 * is set, otherwise cleared.
 *
 * **Why this cannot be skipped**: `build` bit 2 has exactly **one** reader, `spawn_serf` @0x29a5d.
 * Without this routine the bit would keep its saved value forever (set, in every real save) and the
 * population would grow only against `serfBudget`, never against the land owned.
 *
 * Its own module rather than part of the statistics recorder: in the binary these are separate
 * routines with a separate job, and only the call site is shared.
 */
import type { GameState, Player } from './state.js';

/** `player+2` bit 6 == slot occupied (`bt $0x6` at the four test sites). */
const PLAYER_FLAG_ACTIVE = 1 << 6;

/** `build` bit 2 == "may still gain serfs" (`bts $0x2` @0x10ce8 / `btr $0x2` @0x10cfd). */
export const BUILD_MAY_SPAWN = 1 << 2;

/**
 * **The distribution** — `FUN_000109b6` @0x109b6.
 *
 * ```
 * per slot with `player+2` bit 6:  count += 1 ; mask |= 1<<slot ; total += player+0x112
 * if (count > gs[0x48]) return                   // cmp @0x10a98 — see below
 * shift = 0 ; while (total > 0xffff) { total >>= 1 ; shift += 1 }
 * per set mask bit:  FUN_00010b2c(player)
 * ```
 *
 * **That guard has no effect in the original** and is reproduced anyway: it compares the **number of
 * active players** (1..4) against `gs+0x48`, the global serf budget (1179..1403 in real saves), and
 * only continues when `count <= budget` — practically always. It would bite only at a budget below 4,
 * i.e. a map where no serf may be born at all.
 */
export function updatePopulationAllowance(state: GameState): void {
  let count = 0;
  let mask = 0;
  let total = 0;
  for (let slot = 0; slot < 4; slot++) {
    const p = state.players[slot];
    if (!p || (p.flags & PLAYER_FLAG_ACTIVE) === 0) continue;
    count += 1;
    mask |= 1 << slot;
    total = (total + (p.totalLandScore >>> 0)) >>> 0;
  }
  if (count > (state.serfBudget & 0xffff)) return; // @0x10a98 — im Original faktisch nie

  let shift = 0;
  while (total > 0xffff) {
    total = total >>> 1;
    shift += 1;
  }
  for (let slot = 0; slot < 4; slot++) {
    if ((mask & (1 << slot)) === 0) continue;
    applyPopulationAllowance(state, state.players[slot]!, total, shift);
  }
}

/**
 * **The decision per player** — `FUN_00010b2c` @0x10b2c.
 *
 * ```
 * own = player+0x112
 * if (own != 0) {
 *   own >>= shift
 *   if ((short)own == (short)total)  allowance = gs[0x4a]      // holds everything => full span
 *   else                             allowance = ((own<<16) / total * gs[0x4a]) >> 16
 * } else allowance = 0
 * allowance += gs[0x58]
 * population = sum of player.serfCount[0..26]                   // 27 words from player-0x3a
 * player+3 bit 2 = (population < allowance)
 * ```
 *
 * The share is computed as a **16-bit fraction**: divide `own << 16` by `total` (the quotient is the
 * share in 1/65536), multiply by the span and keep the upper word. The "holds everything" special
 * case avoids the division because `(own<<16)/total` would overflow there.
 *
 * The population is the **cached** census `serfCount`, not the serf table — the original sums 27
 * words, not records.
 */
export function applyPopulationAllowance(
  state: GameState,
  player: Player,
  total: number,
  shift: number,
): void {
  const span = state.header.populationSpan & 0xffff;
  let allowance = 0;
  const own = player.totalLandScore >>> 0;
  if (own !== 0) {
    const scaled = own >>> shift;
    if ((scaled & 0xffff) === (total & 0xffff)) {
      allowance = span; // @0x10b4d — the special case without division
    } else {
      const frac = Math.floor(((scaled & 0xffff) * 0x10000) / (total & 0xffff)) & 0xffff;
      allowance = Math.floor((frac * span) / 0x10000) & 0xffff;
    }
  }
  allowance = (allowance + (state.header.populationBase & 0xffff)) & 0xffff;

  let population = 0;
  for (let i = 0; i < 27; i++) population = (population + (player.serfCount[i] ?? 0)) & 0xffff;

  if (population < allowance) player.build |= BUILD_MAY_SPAWN; // @0x10ce8
  else player.build &= ~BUILD_MAY_SPAWN & 0xff; // @0x10cfd
}
