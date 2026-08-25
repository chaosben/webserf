/**
 * The AI's road network upkeep - `FUN_0005155b` (slots 7/15 of the subtask table) and its workhorse
 * `FUN_00051d40`. The subtask has two quite different halves, and the second runs only if the first
 * consumed nothing:
 *
 * 1. Work off the loss register: eight slots into which a lost defence writes the place where the AI
 *    had a military building taken from it. For each place the nearest own flag is looked for and the
 *    area reconnected; the slot is cleared afterwards in any case.
 * 2. Continue the flag sweep: walk the map from the stored cursor and offer every own flag to the
 *    attacher.
 *
 * The budget starts at 1000 and is 16-bit SIGNED: a fruitless search costs 50, a failed road build 600,
 * and a successful one sets it to 0 or -1, ending the appointment; in the sweep every visited tile
 * costs 1, so the budget is also the sweep's reach. The register pass runs over all eight slots
 * REGARDLESS, even when the budget goes negative - its loop foot decrements the slot counter, not the
 * budget - and only afterwards does the sign decide whether the sweep starts at all.
 *
 * The reconnecting search runs ring by ring outwards from the loss position and takes the first tile
 * with an own flag. Below ring 8 the road is built straight from the loss position; from ring 8 on the
 * original places an intermediate flag halfway. The halving is torus correct: the distance is
 * normalised over the map masks, pulled back by a whole map if it exceeds half the width, and only then
 * halved arithmetically.
 *
 * The attacher decides how urgently a flag needs another road. A flag with roads in all six directions
 * costs nothing. Otherwise a breadth-first search three levels deep marks every flag reached with the
 * current search generation and counts whether a store is reachable. No store in range means "connect
 * at any price" (no cost ceiling); store reachable means a shortcut only, and a cheap one.
 *
 * The MARKING is the point of that search: the road builder filters target flags by the search
 * generation, so the neighbours just marked drop out as targets. Without it the new connection would
 * point at a flag already two steps away.
 *
 * Three quirks a reimplementation would have "fixed":
 * - The search depth is never counted - the level field is set once, written per dequeued flag and set
 *   to -1 at the end, a dead store. So every marked flag gets `searchDir = 0` and there is no level
 *   numbering, which in turn makes the two order modes filter identically.
 * - The start flag is not marked: it enters the queue raw and keeps its old generation, so over a cycle
 *   it can turn up a second time.
 * - The register pass always clears the slot, even when nothing was found. A loss position gets exactly
 *   one attempt.
 */

import type { GameState, Player } from './state.js';
import { u16 } from './int.js';
import { Direction, colOf, decodePackedPos, encodePackedPos, neighbor, posOf, rowOf } from './position.js';
import { spiralPos } from './spiral.js';
import { classifyBuildSite, persistBuildSiteBits, buildFlag, BUILD_FLAG } from './build-site.js';
import { aiBuildRoads } from './ai-road-builder.js';
import { aiProbeMap } from './ai-probe.js';

/** Slots of the loss register (block 572). */
export const AI_LOSS_SLOTS = 8;
/** Start-Budget eines Termins — `mov $0x3e8,%ax` @0x5155b. */
export const AI_NET_BUDGET = 1000;
/** Rings searched around a loss position for an own flag — `cmpw $0x10` @0x5165b. */
export const AI_NET_SEARCH_RINGS = 16;
/** From this ring on the flag counts as too far and an intermediate flag is placed — `cmpw $0x8` @0x5166c. */
export const AI_NET_NEAR_RINGS = 8;
/** Spiral positions around the midpoint — `mov $0x24` @0x51794, so 37. */
export const AI_NET_MIDPOINT_SPIRAL = 37;
/** Kosten einer erfolglosen Suche — `subw $0x32` @0x51662 / @0x51b1d. */
export const AI_NET_COST_NO_SITE = 50;
/** Kosten eines fehlgeschlagenen Wegebaus — `subw $0x258` @0x5220b. */
export const AI_NET_COST_ROAD_FAILED = 600;
/**
 * Level **budget** of the network breadth-first search — `mov $0x2` @0x51dc4/@0x51dc9.
 *
 * **It is not an abort.** With a non-empty frontier the level foot jumps back to `0x51ddc` (`jns`
 * @0x52097), which lands **behind** the initialisation — so the budget is not renewed, but the search
 * continues. It has exactly two writers (init @0x51dc9, `subw $0x1,0xc(%edi)` @0x5206a); the three
 * other stores to `0xc(%edi)` are epilogue restores (@0x521f1/@0x5222b/@0x52256). The budget therefore
 * controls exactly **two** things: from when the stamp 0xff applies, and from when the store question
 * is asked. **The only end of the search is a level that enqueues nothing** (`or %ax,%ax` + `jns`
 * @0x52094/@0x52097 on `ctx0x4` == enqueues - 1).
 *
 * Reading it as a hard abort after three levels is the obvious mistake and measurably wrong: of 6365
 * unsaturated start flags across 73 saves the original decides in **3949** (62 %) only after *more*
 * than three levels — a port that aborts takes mode -1 there where the original takes mode -2.
 */
export const AI_NET_BFS_BUDGET = 2;
/**
 * Queue limit **of one level** — `cmpw $0x3e2,0x4(%edi)` @0x52058, `jns` @0x5205e.
 *
 * The counter `ctx0x4` carries **enqueues minus one** (`mov $0xffffffff,%eax` @0x51e32 per level,
 * `addw $0x1` @0x51eaf per enqueue), so 994 on it means a count of **995**. And the test sits at the
 * foot of the **flag** iteration, behind the sixth direction block rather than inside the direction
 * loop: a flag that has been started is always enqueued completely.
 *
 * The constant is derivable and therefore not mistakable for a buffer limit: the two queues get `0xfa0`
 * == 4000 bytes each (`addl $0xfa0` @0x3522/@0x3533), holding 1000 four-byte pointers, and one entry
 * adds at most 6 — `994 + 6 == 1000`. Were 994 the real limit, it would read `0x3e8`.
 */
export const AI_NET_BFS_QUEUE_LIMIT = 995;
/** Search stamp per level: 0 until the budget underflows, 0xff afterwards (@0x52071/@0x52076). */
export const AI_NET_STAMP_EARLY = 0;
export const AI_NET_STAMP_LATE = 0xff;
/** Idle professions whose sum opens the sweep gate: transporter (0) and generic (21). */
export const AI_NET_IDLE_TRANSPORTER = 0;
export const AI_NET_IDLE_GENERIC = 21;

/** Ring walk directions: one step DownRight per ring, then the six directions 5..0. */
const RING_DIRS: readonly Direction[] = [
  Direction.Up,
  Direction.UpLeft,
  Direction.Left,
  Direction.Down,
  Direction.DownRight,
  Direction.Right,
];

/** 16-bit signed — the original carries the budget with `subw`/`jns`. */
function i16(v: number): number {
  return (v << 16) >> 16;
}

/**
 * `new_flag_search` `FUN_0001303f` @0x1303f — draw a new search generation. If the counter overflows it
 * is raised a second time and **all** flag marks are cleared (@0x1309e..@0x130bb).
 */
export function newFlagSearch(state: GameState): number {
  state.header.flagSearchCounter = u16(state.header.flagSearchCounter + 1);
  if (state.header.flagSearchCounter === 0) {
    state.header.flagSearchCounter = u16(state.header.flagSearchCounter + 1);
    for (const flag of state.flags) {
      if (flag !== undefined && flag !== null) flag.searchNum = 0;
    }
  }
  return state.header.flagSearchCounter;
}

/** Outcome of an attach attempt — it determines what the budget is charged. */
export type AiConnectResult = 'saturated' | 'built' | 'failed';

/**
 * **The attacher** `FUN_00051d40` @0x51d40 — hook a flag better into the network.
 *
 * Returns `'saturated'` (all six directions taken, @0x52250 — free), `'built'` (road laid, @0x52245 —
 * the appointment ends) or `'failed'` (@0x5220b — costs 600).
 */
export function aiConnectFlag(
  state: GameState,
  player: Player,
  flagIndex: number,
  pos: number,
): AiConnectResult {
  const flag = state.flags[flagIndex];
  // The position comes from the **caller** (`ctx+0`/`ctx+0x4`), not from the record — a flag stores no
  // position of its own in the original.
  if (flag === undefined || flag === null) return 'saturated';

  // @0x51d74 `cmpw $0x3f ; je 0x52250` — nothing to do, and this exit is free.
  let paths = 0;
  for (let d = 0; d < 6; d++) if (flag.paths[d]) paths |= 1 << d;
  if (paths === 0x3f) return 'saturated';

  // ── Breadth-first search over the road network (@0x51ddc..@0x52097) ─────────────────────────────
  // It runs until a level enqueues nothing — NOT for three levels. The budget only decides stamp and
  // store question; see `AI_NET_BFS_BUDGET`. The marks guarantee termination: every flag is enqueued
  // at most once.
  const search = newFlagSearch(state); // `call 0x1303f` @0x51d9e
  let frontier: number[] = [flagIndex]; // @0x51daf — the start flag is NOT marked
  let reachesInventory = false;
  let budget = AI_NET_BFS_BUDGET; // @0x51dc9
  let stamp = AI_NET_STAMP_EARLY; // @0x51dd1
  let earlyInventoryExit = false;

  for (;;) {
    const next: number[] = [];
    for (const idx of frontier) {
      const f = state.flags[idx];
      if (f === undefined || f === null) continue;
      f.searchDir = stamp; // @0x51e48 — 0, and 0xff once the budget underflows
      // Directions 5..0 over the endpoint bits of `flag[4]` (@0x51e5a ff., shifting left).
      for (let dir = 5; dir >= 0; dir--) {
        if (!f.endpointDirs[dir]) continue;
        const con = f.connections[dir];
        // Measured: no building endpoint carries this bit (0 of 3786), so the branch is never a
        // building — it is still checked rather than reading a building record as a flag.
        if (con === null || con.kind !== 'flag') continue;
        const nb = state.flags[con.index];
        if (nb === undefined || nb === null) continue;
        if (u16(nb.searchNum) === search) continue; // @0x51e77 `cmp %ax,0x1c(%edi) ; je`
        if (nb.bldFlags !== undefined && (nb.bldFlags & 0x40) !== 0) reachesInventory = true; // @0x51e85 `bt $0x6`
        nb.searchNum = search; // @0x51e99
        next.push(con.index);
      }
      // @0x52058 — only AFTER all six directions of this flag, and the comparison runs on
      // `enqueues - 1`; the level ends here, the search does not.
      if (next.length >= AI_NET_BFS_QUEUE_LIMIT) break;
    }

    // @0x5206a — level foot.
    budget -= 1;
    if (budget < 0) {
      stamp = AI_NET_STAMP_LATE; // @0x52071/@0x52076 — BEFORE the store question
      // @0x52079..@0x52080 `mov 0x14(%edi),%ax ; or ; jne 0x5210d` — only this exit leads to mode -2.
      // If the frontier runs dry instead it is always mode -1; that the two coincide is structural,
      // not a simplification (the start flag stays unmarked, and `flag[4]` belongs to the edge — 0 of
      // 16344 directed edges are asymmetric, so every level-0 neighbour enqueues it again; across
      // 6365 start flags none ends after two levels).
      if (reachesInventory) {
        earlyInventoryExit = true;
        break;
      }
    }

    if (next.length === 0) break; // @0x52094/@0x52097 `or %ax,%ax ; jns 0x51ddc`
    frontier = next;
  }

  // ── The order for the road builder ─────────────────────────────────────────────────────────────
  player.cursorCol = colOf(pos, state.geo); // @0x521a8
  player.cursorRow = rowOf(pos, state.geo); // @0x521b6
  player.aiRoadJob550 = search;
  if (!earlyInventoryExit) {
    // @0x520b6 ff. — the mode -1 branch does NOT write block 552; it is set only here (@0x520d7).
    player.aiRoadJob552 = 0xc;
    // @0x520b6 — connect at any price.
    player.aiRoadJob570 = 0;
    player.aiRoadJob540 = 0;
    player.aiRoadJob548 = 0xffff;
    player.aiRoadJob542 = 0xffff;
  } else {
    // @0x52126 — only a cheap shortcut.
    player.aiRoadJob570 = 0x64;
    player.aiRoadJob540 = 0x14;
    player.aiRoadJob548 = 0xfffe;
    player.aiRoadJob542 = 0;
  }
  player.build &= ~0x10; // @0x521c5 `btr $0x4` — not a boat road order

  const rc = i16(aiBuildRoads(state, player)); // `call 0x557b2` @0x521d1
  // @0x521d6 `jns 0x52212` — non-negative means the road is down, and then the appointment ends.
  return rc >= 0 ? 'built' : 'failed';
}

/** The nearest own flag around `pos`, searched ring by ring. `null` if none within 16 rings. */
export function aiFindOwnFlagNear(
  state: GameState,
  player: Player,
  pos: number,
): { pos: number; ring: number } | null {
  const geo = state.geo;
  const wantOwner = player.slot + 1;
  // **One single running position** — as in the original (`ctx+0x4` is set at the head and only
  // advanced afterwards). That this makes *no* difference here is measured and has a reason: the six
  // direction vectors sum to (0,0) and every ring runs each direction equally often, so the walk closes
  // exactly and "reset" and "carry on" are the same (0 of 316 start points distinguish them). Unlike
  // `ai-survey.ts`, where the ring counter additionally carries across stages.
  let cur = pos;
  for (let ring = 0; ring < AI_NET_SEARCH_RINGS; ring++) {
    cur = neighbor(cur, Direction.DownRight, geo); // @0x515f1 `add gs+0x8` — one step per ring
    for (const dir of RING_DIRS) {
      // @0x51602 `ctx+0x8 = ctx+0xc` and `subw $0x1 ; jae` => **`ring + 1`** steps per direction.
      for (let step = 0; step <= ring; step++) {
        cur = neighbor(cur, dir, geo);
        const tile = state.mapTiles[cur];
        if (tile === undefined) continue;
        if (tile.object !== 1) continue; // @0x51626 — bit 7 of `landscape[0]`
        if (tile.owner !== wantOwner) continue; // @0x51642
        return { pos: cur, ring };
      }
    }
  }
  return null;
}

/**
 * The torus-correct midpoint between `from` and `to` — @0x51677..@0x5174f. The distance is normalised
 * to half the map width (`cmp gs+0x40 ; jb` @0x516e3) and then halved **arithmetically** (`sarw $1`
 * @0x51721), so the sign is preserved.
 */
export function aiMidpoint(state: GameState, from: number, to: number): number {
  const geo = state.geo;
  let dc = (colOf(to, geo) - colOf(from, geo)) & geo.colMask;
  if (dc >= geo.cols >> 1) dc -= geo.cols;
  let dr = (rowOf(to, geo) - rowOf(from, geo)) & geo.rowMask;
  if (dr >= geo.rows >> 1) dr -= geo.rows;
  return posOf(colOf(from, geo) + (dc >> 1), rowOf(from, geo) + (dr >> 1), geo);
}

/** Issue a road order from the register pass — @0x51985 resp. @0x51b48, byte identical. */
function setLossRoadJob(player: Player, col: number, row: number): void {
  player.cursorCol = col;
  player.cursorRow = row;
  player.aiRoadJob570 = 0;
  player.aiRoadJob540 = 0;
  player.aiRoadJob552 = 0xc;
  player.aiRoadJob548 = 0;
  player.aiRoadJob542 = 0xffff;
  player.build &= ~0x10; // `btr $0x4` @0x519d0 / @0x51bb2
}

/**
 * **The road network upkeep** `FUN_0005155b` @0x5155b. Returns how many roads this appointment laid
 * (the original has no return value; the counter is for tests).
 */
export function aiRoadNetworkTask(state: GameState, player: Player): number {
  const geo = state.geo;
  let budget = AI_NET_BUDGET; // @0x5155b `mov $0x3e8`
  let built = 0;

  // ── Part 1: the loss register (@0x51579) ────────────────────────────────────────────────────────
  for (let slot = 0; slot < AI_LOSS_SLOTS; slot++) {
    const entry = player.aiLossRegister?.[slot];
    if (entry === undefined) break;
    // @0x5157e `or %eax,%eax ; js 0x51bfc` — one free slot ends the WHOLE register pass.
    if ((entry.row & 0x8000) !== 0) break;

    const entryPos = posOf(entry.col, entry.row, geo);
    const found = aiFindOwnFlagNear(state, player, entryPos);

    if (found === null) {
      budget = i16(budget - AI_NET_COST_NO_SITE); // @0x51662
    } else if (found.ring < AI_NET_NEAR_RINGS) {
      // @0x51b27 — the flag is close, build straight from the loss position.
      setLossRoadJob(player, entry.col, entry.row);
      if (i16(aiBuildRoads(state, player)) >= 0) built += 1;
      budget = -1; // @0x51bdc — the appointment is spent
    } else {
      // @0x51677 — intermediate flag halfway along.
      const mid = aiMidpoint(state, entryPos, found.pos);
      let placed: number | null = null;
      for (let i = 0; i < AI_NET_MIDPOINT_SPIRAL; i++) {
        const at = spiralPos(mid, i, geo);
        const col = colOf(at, geo);
        const row = rowOf(at, geo);
        player.cursorCol = col; // @0x517f6
        player.cursorRow = row; // @0x51804
        const site = classifyBuildSite(state, player, col, row); // `call 0x32075` @0x5183f
        persistBuildSiteBits(player, site);
        if (site.cursorType < 4) continue; // @0x51872 `cmpb $0x4,0x100(%ebx) ; jb`
        if (site.possibility < BUILD_FLAG) continue; // @0x51882 `cmpb $0x1,0x101(%ebx) ; jb`
        if (site.flagBlocked) continue; // @0x51897 `bt $0x1,player+3 ; jne`
        buildFlag(state, player, col, row); // `call 0x2899f` @0x518d8
        placed = at;
        break;
      }
      if (placed === null) {
        budget = i16(budget - AI_NET_COST_NO_SITE); // @0x51b1d
      } else {
        // @0x51964 — lay the road from the loss position …
        setLossRoadJob(player, entry.col, entry.row);
        if (i16(aiBuildRoads(state, player)) >= 0) built += 1;
        // … and attach the new intermediate flag as well (@0x51ad9).
        const midTile = state.mapTiles[placed];
        if (midTile !== undefined && midTile.object === 1) {
          if (aiConnectFlag(state, player, midTile.objIndex, placed) === 'built') built += 1;
        }
        budget = -1; // @0x51b03
      }
    }
    // @0x51be4 — the slot is cleared in EVERY case, even after a failure.
    entry.col = 0xffff;
    entry.row = 0xffff;
  }

  // ── Part 2: the flag sweep (@0x51bfc) ───────────────────────────────────────────────────────────
  if (i16(budget) < 0) return built; // @0x51c03 `js 0x51d3d` — spent, without saving the cursor

  const idle = u16(
    (player.aiIdleSerfs[AI_NET_IDLE_TRANSPORTER] ?? 0) + (player.aiIdleSerfs[AI_NET_IDLE_GENERIC] ?? 0),
  );
  if (idle < 2) {
    // @0x51c27 `jb 0x5c54a` — tail call to the probe. Without runners a new road is not worth it.
    aiProbeMap(state, player);
    return built;
  }

  const start = decodePackedPos((player.aiFlagSweepCursor ?? 0) >>> 0, geo);
  let col = start === null ? 0 : start.col;
  let row = start === null ? 0 : start.row;
  const wantOwner = player.slot + 1;
  for (;;) {
    const sweepPos = posOf(col, row, geo);
    const tile = state.mapTiles[sweepPos];
    if (tile !== undefined && tile.object === 1 && tile.owner === wantOwner) {
      // @0x51cf4 — eigene Fahne: anbinden.
      const rc = aiConnectFlag(state, player, tile.objIndex, sweepPos);
      if (rc === 'built') {
        built += 1;
        budget = 0; // @0x52245
      } else if (rc === 'failed') {
        budget = i16(budget - AI_NET_COST_ROAD_FAILED); // @0x5220b
      }
    }
    // @0x51cf9 — one column on; on wrap, one row down.
    col = (col + 1) & geo.colMask;
    if (col === 0) row = (row + 1) & geo.rowMask;
    budget = i16(budget - 1); // @0x51d19
    if (budget < 0) break; // @0x51d1e `jns 0x51c80`
  }
  player.aiFlagSweepCursor = encodePackedPos(col, row, geo) >>> 0; // @0x51d37
  return built;
}
