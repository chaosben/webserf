/**
 * The construction handler `building_construction_head` - the table branch a building UNDER
 * CONSTRUCTION gets in the driver. It requests the digger and then the builder, and afterwards sets
 * the building-material demand on the site's flag.
 *
 * It exists because the driver indexes its table with `(bld[4] & 0xfc) * 2`, and `& 0xfc` KEEPS bit 7
 * (`constructing`) - so the index is `type + 32 * constructing` and entries 32..56 are a second,
 * complete set of handlers. A site therefore never reaches its type's production handler.
 *
 * ```
 * type  0                            -> ret
 * types 1..9, 11, 15                 -> builder only        (SMALL buildings)
 * types 10, 12..14, 16..23           -> levelling + builder (LARGE buildings)
 * type 24 (castle)                   -> ret (its builder appears at the founding)
 * ```
 *
 * The small body is literally the fall-through tail of the large one: the levelling check ends by
 * jumping into it. Large buildings check at `progress == 0` whether the seven tiles of the site
 * (centre plus six neighbours) already sit at the levelling height; if so `progress` becomes 1 and the
 * digger is skipped.
 *
 * The emergency programme has its readers here. While `messageFlags` bit 6 stands, only the three first
 * buildings of the wood/stone chain get workers at all - and the two branches test that DIFFERENTLY:
 * the digger branch on the building TYPE, the builder branch on the building INDEX against
 * `messageBuildingSlots`, i.e. through the slots remembered at build time. Bits 1 and 2 (out of planks
 * / out of stone) gate the same idea for the MATERIAL in the tail: a site outside the chain requests
 * nothing any more, and for an AI player it is demolished with a probability depending on the build
 * progress.
 *
 * Cadence: the original runs head and tail once per rotation block. The port calls the head
 * rotation-gated for the same reason as the worker request - the serf request and the emergency
 * demolition are EVENTS. The tail is a pure function of the stock level and is additionally called
 * every tick, there without the event part, so the random stream is not consumed 32-fold.
 */
import type { GameState, Building, Player } from './state.js';
import { posOf, neighbor, Direction } from './position.js';
import { sendSerfToFlag, type WorkerRequest } from './serf-request.js';
import { demolishBuilding } from './buildings.js';

/**
 * Building types with a **large** site — read from the table branch 0x138ed and confirmed independently
 * by the build menu's placement stubs (`gs+0x27a = type ; jmp 0x302d6`, twelve of them) and by the data
 * (type 13 carries tile object 3 = LargeBuilding in 33 of 33 real butchers). The castle (24) is **not**
 * among them: its construction slot is a `ret` (@0x14da4).
 */
export const LARGE_CONSTRUCTION_TYPES: ReadonlySet<number> = new Set([
  10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23,
]);

/** Digger: serf type 2, tool shovel (`mov $0x2` @0x13aef, `vreg6 = 0x20` == (15+1)*2). */
const DIGGER_REQUEST: WorkerRequest = { serfType: 2, tools: [15] };
/** Builder: serf type 3, tool hammer (`mov $0x3` @0x13bc1, `vreg6 = 0x22` == (16+1)*2). */
const BUILDER_REQUEST: WorkerRequest = { serfType: 3, tools: [16] };

/** `messageFlags` bit 6 — the emergency programme is running (set/cleared in `player-hints.ts`). */
const HINT_PENDING = 1 << 6;
/** `messageFlags` bit 1 / 2 — "out of planks" / "out of stone" shown. */
const HINT_NO_PLANKS = 1 << 1;
const HINT_NO_STONE = 1 << 2;
/** `flags` bit 7 — AI player (`bt $0x7` @0x13df8). */
const PLAYER_FLAG_AI = 1 << 7;

/**
 * The walk around the site — centre, then six steps, **each relative to the previous one**
 * (@0x13947 `+4` · @0x13974 `+gs[0xc]` · @0x139a3 `+gs[0x60]` · @0x139d6 `+gs[0x14]` ·
 * @0x13a01 `+gs[0x18]` · @0x13a2c `+4`). The gs slots are the direction delta table from `gs+0x4`;
 * `+4` == one column == Right, `gs+0x60` == Left. It visits exactly the centre and its six neighbours.
 *
 * The same step sequence appears a **second** time in the binary, as the levelling WRITER of the castle
 * founding (@0x293ae ff., see `founding.ts`). Two separate routines, one geometry — the code is not
 * shared.
 */
export const LEVEL_WALK: readonly Direction[] = [
  Direction.Right,
  Direction.Down,
  Direction.Left,
  Direction.UpLeft,
  Direction.Up,
  Direction.Right,
];

/**
 * Do all seven site tiles sit at the levelling height? (@0x13929..@0x13a53 — per tile
 * `landscape[pos+1] & 0x1f` against `bld[0xe]`.)
 */
export function buildSiteIsLevel(state: GameState, bld: Building): boolean {
  const target = (bld.level ?? 0) & 0xffff;
  let pos = posOf(bld.col, bld.row, state.geo);
  if ((state.mapTiles[pos]?.height ?? -1) !== target) return false;
  for (const dir of LEVEL_WALK) {
    pos = neighbor(pos, dir, state.geo);
    if ((state.mapTiles[pos]?.height ?? -1) !== target) return false;
  }
  return true;
}

/**
 * **The complete construction handler** (@0x138ed large / @0x13b24 small), called rotation-gated.
 * `index` is the building index (`vreg2`, carried by the driver) — the emergency gates compare it
 * against `messageBuildingSlots`.
 */
export function buildingConstructionHead(state: GameState, bld: Building, index: number): void {
  // Table slots that are only a `ret`: type 0 (@0x138ec) and the castle (@0x14da4).
  if (bld.type === 0 || bld.type === 24) return;

  if (LARGE_CONSTRUCTION_TYPES.has(bld.type) && bld.progress === 0) {
    // `or %ax,%ax ; jne 0x13b24` @0x138f4 — levelling happens only at progress == 0.
    // @0x13905 `andb $0xc0`: with a digger present or on the way there is nothing to do.
    if (bld.holder || bld.serfRequested) return;
    if (buildSiteIsLevel(state, bld)) {
      bld.progress = 1; // @0x13a55 — already level, no digger needed
    } else {
      requestDigger(state, bld);
      return; // @0x13aee / @0x13b23 — the builder comes only after levelling
    }
  }

  // @0x13b24. The return value is the exit 0x13bc0: if the **emergency programme** rejects the
  // builder, the original returns immediately (`bts $0x2 ; ret`) — the material tail does NOT run and
  // the flag's priority bytes stay as they are. Every other path falls through into the tail.
  if (!requestBuilder(state, bld, index)) return;
  constructionDemand(state, bld, index, true); // @0x13bf5 — the shared tail
}

/** Request the digger — `LAB_00013a68`. */
function requestDigger(state: GameState, bld: Building): void {
  if (bld.serfRequestFailed) return; // @0x13a70 `bt $0x2`
  const player = state.players[bld.owner] ?? null;
  if (player !== null && (player.messageFlags & HINT_PENDING) !== 0) {
    // @0x13ac4: `bld[4] & 0x7c` == type << 2 — lumberjack (2), stonecutter (4), sawmill (17) only.
    const coded = (bld.type << 2) & 0x7c;
    if (coded !== 0x08 && coded !== 0x10 && coded !== 0x44) {
      bld.serfRequestFailed = true; // @0x13ae2 `bts $0x2`
      return;
    }
  }
  if (!sendSerfToFlag(state, bld, DIGGER_REQUEST)) bld.serfRequestFailed = true; // @0x13b0d `jns`
}

/**
 * Request the builder — the head of @0x13b24. Returning `false` is the exit @0x13bc0 (emergency
 * rejection), after which the original **leaves** the routine instead of falling into the material
 * tail.
 */
function requestBuilder(state: GameState, bld: Building, index: number): boolean {
  const player = state.players[bld.owner] ?? null;
  // @0x13b51 `andb $0xc4 ; jne 0x13bf5`: occupied / requested / previously failed goes straight into
  // the tail.
  if (bld.holder || bld.serfRequested || bld.serfRequestFailed) return true;
  bld.progress = 1; // @0x13b5a — the small body sets it too (idempotent)
  if (player !== null && (player.messageFlags & HINT_PENDING) !== 0 && !isChainBuilding(player, index, 3)) {
    bld.serfRequestFailed = true; // @0x13bb4 `bts $0x2`, then @0x13bc0 `ret`
    return false;
  }
  if (!sendSerfToFlag(state, bld, BUILDER_REQUEST)) bld.serfRequestFailed = true; // @0x13bdf `jns`
  return true;
}

/**
 * Is `index` one of the **first** chain buildings remembered at build time? `count` says how many of
 * the three slots are checked — the planks branch checks **three** (@0x13b7f/@0x13b8f/@0x13b9f and
 * @0x13c2b ff.), the stone branch only the **first two** (@0x13db9/@0x13dcd).
 */
function isChainBuilding(player: Player, index: number, count: number): boolean {
  for (let i = 0; i < count; i++) {
    if ((player.messageBuildingSlots[i] ?? 0) === index) return true;
  }
  return false;
}

/**
 * **Building material demand** on the site's flag — the tail @0x13bf5 shared by both bodies. Slot 0 is
 * planks (`flag[0x43]`, slider `planksDistribution[0]`), slot 1 is stone (`flag[0x45]`, constant
 * `0xff` — stone has no distribution slider).
 *
 * ```
 * fill = avail + req
 * if (fill < 8 && fill != stockMaximum[slot]):
 *     prio = base >> fill ; if (!holder) prio >>= 2 ; flag[…] = prio & ~1
 * else: flag[…] = 0
 * ```
 *
 * Ahead of each slot sits the **emergency gate**: with the matching hint bit set and the site outside
 * the chain nothing is requested — and for an **AI** player the routine draws a random value and
 * demolishes the site with probability `((~progress) & 0xffff) >> 5` (@0x13cad/@0x13e21: the draw
 * happens **always**, the demolition only on `rand < threshold`). The further the build, the smaller
 * the threshold.
 *
 * **Asymmetry in the original, reproduced verbatim:** the planks branch exempts all **three** chain
 * buildings, the stone branch only lumberjack and sawmill — the **stonecutter** (slot 2) falls into
 * the emergency branch there (@0x13dec `jne` instead of `je`). It looks like an oversight, given that
 * the stonecutter is what supplies the stone; it is not changed.
 *
 * `allowEmergency = false` leaves out exactly the two random branches, for the extra every-tick call.
 */
export function constructionDemand(
  state: GameState,
  bld: Building,
  index: number,
  allowEmergency: boolean,
): void {
  const flag = state.flags[bld.flag];
  if (!flag) return;
  const player = state.players[bld.owner] ?? null;
  const flags = player?.messageFlags ?? 0;

  // Slot 0: planks (@0x13c05). The **success** path of this slot does NOT return, it jumps to the
  // stone block (`jmp 0x13d9b` @0x13d8a) — only the stone slot ends the routine. The single early exit
  // here is the demolition.
  const planksOk =
    (flags & HINT_NO_PLANKS) === 0 || (player !== null && isChainBuilding(player, index, 3));
  if (planksOk) {
    const base = ((player ? (player.planksDistribution[0] ?? 0) : 0) >> 8) & 0xff;
    if (!writeSlotPriority(bld, flag, 0, base)) flag.stockPriority[0] = 0; // @0x13d93
  } else {
    if (allowEmergency && player !== null && (player.flags & PLAYER_FLAG_AI) !== 0) {
      if (emergencyDemolish(state, bld)) return;
    }
    flag.stockPriority[0] = 0; // @0x13d93
  }

  // Slot 1: stone (@0x13d9b).
  if ((flags & HINT_NO_STONE) === 0 || (player !== null && isChainBuilding(player, index, 2))) {
    if (writeSlotPriority(bld, flag, 1, 0xff)) return;
  } else if (
    allowEmergency &&
    player !== null &&
    (player.messageBuildingSlots[2] ?? 0) === index &&
    (player.flags & PLAYER_FLAG_AI) !== 0
  ) {
    if (emergencyDemolish(state, bld)) return;
  }
  flag.stockPriority[1] = 0; // @0x13f01
}

/**
 * The priority computation of one slot. Returns `true` when it applied — in the original the branch
 * that writes `flag[…] = prio` and skips the zero writer.
 */
function writeSlotPriority(
  bld: Building,
  flag: { stockPriority: number[] },
  slot: 0 | 1,
  base: number,
): boolean {
  const st = bld.stock[slot];
  if (!st) return false;
  const fill = (st.available & 0xf) + (st.requested & 0xf);
  const stockMax = bld.stockMaximum ? bld.stockMaximum[slot] : 0;
  if (fill - 8 >= 0 || fill === stockMax) return false;
  let prio = (base >> fill) & 0xff;
  if (!bld.holder) prio >>= 2; // @0x13d7e — an unoccupied site is throttled further
  flag.stockPriority[slot] = prio & 0xfe;
  return true;
}

/**
 * The emergency demolition (@0x13c96 / @0x13e0a). **Always** draws a random value; demolishes when it
 * is below `((~progress) & 0xffff) >> 5`. Returns `true` when it demolished, after which the routine
 * returns immediately.
 */
function emergencyDemolish(state: GameState, bld: Building): boolean {
  const threshold = (~bld.progress & 0xffff) >> 5;
  const r = state.rng.next();
  if (r >= threshold) return false;
  demolishBuilding(state, bld);
  return true;
}
