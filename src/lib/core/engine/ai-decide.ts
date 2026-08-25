/**
 * The AI's build decider - `FUN_00051221`, the most frequent of the subtasks. It answers one question:
 * what do I build next? The result is a task number in `gs+0x27a`, the same field the human's build
 * menu writes; this port carries it as a parameter and return value, because it need not survive a
 * tick.
 *
 * There are TWO numberings for the same thing. The 25 urgency slots carry `task = slot + 1`, so 1..23
 * are building types, 24 is the geologist and 25 the flag; `aiCandidates` counts differently (row 0 =
 * flag, 1..24 = building types, 25 = geologist). The conversion is {@link AI_TASK_TO_CANDIDATE_ROW}.
 *
 * The material gate decides which of two branches runs. The HEAD branch (gate closed) tries the flag,
 * then the geologist above an urgency threshold, and otherwise TAIL-JUMPS into the map probing - the AI
 * keeps exploring instead of wasting the tick. It consumes no build pressure.
 *
 * The MAIN branch zeroes urgencies 0..23 but not slot 24 (the flag). That does not mean only the head
 * path writes it: the main branch calls the flag evaluator first and it keeps its old value only when
 * that evaluator returns through one of its early exits. Then the remaining evaluators run, the maximum
 * is taken (first highest wins), and it must exceed the catch-up pressure before anything is built.
 *
 * Halving the pressure counter afterwards is the CONSUMPTION: whoever built is less urgent for a while.
 * That explains why the flag counter is the only one rarely saturated - only it is drawn down often,
 * and only in the main branch, since the head branch does not halve.
 *
 * The 25 evaluators stand as data in {@link AI_EVALUATORS} so a guard can hold order and slot
 * assignment against the binary; their bodies live in `ai-evaluators.ts` because in the binary they sit
 * contiguously too. Each reads exactly its own pressure counter and writes exactly one urgency, except
 * three pair evaluators that also set the neighbouring slot.
 *
 * Free of random draws with one exception that counts: the tail jump into the probing draws random
 * values, so wiring it up shifts the random stream.
 */
import type { GameState, Player } from './state.js';
import { u16 } from './int.js';
import { aiProbeMap } from './ai-probe.js';
import {
  aiExecuteBuildTask,
  AI_TASK_FLAG,
  AI_TASK_GEOLOGIST,
} from './ai-execute.js';
import {
  aiBakerUrgency, aiBoatbuilderUrgency, aiButcherUrgency, aiCoalMineUrgency, aiFarmUrgency,
  aiFisherUrgency, aiFlagUrgency, aiForesterUrgency, aiFortressUrgency, aiGeologistUrgency,
  aiGoldMineUrgency, aiGoldSmelterUrgency, aiHutUrgency, aiIronMineUrgency, aiLumberjackUrgency,
  aiMillUrgency, aiPigFarmUrgency, aiSawmillUrgency, aiSteelSmelterUrgency, aiStoneMineUrgency,
  aiStonecutterUrgency, aiToolmakerUrgency, aiTowerUrgency, aiWarehouseUrgency,
  aiWeaponSmithUrgency,
} from './ai-evaluators.js';

/** Number of urgency slots (`mov $0x18` @0x5149e, one extra pass because of `subw`+`jae`). */
export const AI_URGENCY_SLOTS = 25;

/**
 * The task numbers and the conversion to the candidate row live in the **executor**, where their byte
 * evidence is (@0x55016/@0x55048). Re-exported here because both sides need them and this avoids an
 * import cycle.
 */
export {
  AI_TASK_GEOLOGIST,
  AI_TASK_FLAG,
  AI_TASK_TO_CANDIDATE_ROW,
  AI_EXECUTOR,
} from './ai-execute.js';

/** Minimum urgency from which the geologist is chosen (`cmpw $0x2710,(%edi)` @0x51268). */
export const AI_GEOLOGIST_THRESHOLD = 10000;

/**
 * **The 25 evaluators in the original's call order.** `group` is the call block: `a` = the first block
 * @0x513c2…@0x51408 (15 of them, the first two being flag and geologist — exactly the ones the head
 * branch also calls individually); `b` = the second block @0x51447…@0x51474 (10 of them), which runs
 * only when a digger is idle or a shovel is in stock. `extra` is the neighbouring slot the three pair
 * evaluators write in addition.
 */
export interface AiEvaluator {
 /** Address of the original routine. */
  readonly addr: number;
 /** Own urgency slot — the one whose pressure counter the routine reads. */
  readonly slot: number;
 /** Additionally written slot (pair evaluators), otherwise `null`. */
  readonly extra: number | null;
 /** Call block. */
  readonly group: 'a' | 'b';
 /** Port, or `null` when open. */
  readonly port: ((state: GameState, player: Player) => void) | null;
}

/**
 * The two head-branch evaluators and the candidate average live with the other 23 in
 * `ai-evaluators.ts`; re-exported here because guards and tests reach them through this module and the
 * decider needs them itself.
 */
export {
  aiFlagUrgency,
  aiGeologistUrgency,
  candidateAverage,
  candidateAverage as aiCandidateAverage,
  mulHigh,
} from './ai-evaluators.js';

/**
 * **Material gate** — `FUN_00054df9` @0x54df9. Returns whether a **building** may be started (0 or -1
 * in `vreg0` in the original, evaluated with `jns` @0x51226).
 *
 * Staff first, then material:
 *
 * ```
 * idle builders present:
 *   (transporters + generics) < 2   -> no   @0x54e22
 * no builders (so one must be trained):
 *   no hammer in stock              -> no   @0x54e3b
 *   no generics                     -> no   @0x54e51
 *   (generics + transporters) < 3   -> no   @0x54e68
 *
 * open  = sum incompleteBuildingCount[0..22]                     @0x54e6e…@0x54f51
 * limit = min( (completedBuildingCount[warehouse] + 3) * 4,      @0x54f54
 *              planks/4 + 6,                                     @0x54f69
 *              stones/2 + 8 )                                    @0x54f93
 * open > limit                      -> no   @0x54fbf
 * ```
 *
 * The three limits are an intersection, not a choice: `jae` @0x54f89/@0x54fb2 overwrites only when the
 * new candidate is **smaller**. More simultaneous sites than planks and stones can supply would block
 * the economy; the warehouse term ties the expansion width to the logistics.
 */
export function aiMayStartBuilding(player: Player): boolean {
  const idleTransporters = player.aiIdleSerfs[0] ?? 0;
  const idleGenerics = player.aiIdleSerfs[21] ?? 0;
  if ((player.aiIdleSerfs[3] ?? 0) !== 0) {
 // `or %ax,%ax ; je 0x54e2e` @0x54e06 — a builder is idle in a warehouse.
    if (u16(idleTransporters + idleGenerics) < 2) return false; // @0x54e22
  } else {
    if ((player.aiStockpile[16] ?? 0) === 0) return false; // hammer — @0x54e3b
    if (idleGenerics === 0) return false; // @0x54e51
    if (u16(idleGenerics + idleTransporters) < 3) return false; // @0x54e68
  }
  let open = 0;
  for (const n of player.incompleteBuildingCount) open = u16(open + n);
  let limit = u16((u16((player.completedBuildingCount[9] ?? 0) + 3)) << 2); // warehouse == index 9
  const byPlanks = u16(((player.aiStockpile[7] ?? 0) >>> 2) + 6);
  if (byPlanks < limit) limit = byPlanks; // `jae 0x54f93` overwrites only on a smaller value
  const byStones = u16(((player.aiStockpile[9] ?? 0) >>> 1) + 8);
  if (byStones < limit) limit = byStones; // @0x54fb2
  return limit >= open; // `cmp %ax,0x4(%edi) ; jb 0x54fcf` @0x54fbf
}

/** Zeroes urgencies 0..23 — slot 24 stays (12 x u32 `89 03`, @0x5129d…@0x51316). */
export const AI_URGENCY_CLEAR_SLOTS = 24;

/**
 * **The decider.** Returns the chosen task 1..25, or `0` when this tick starts nothing. The return
 * value is `gs+0x27a` in the original; its consumer is {@link aiExecuteBuildTask}, wired up at all
 * **three** places.
 */
export function aiDecideBuild(state: GameState, player: Player): number {
  if (!aiMayStartBuilding(player)) {
 // Head branch @0x51228 — no building possible, so flag, geologist or explore.
 //
 // **The branch decides from a STALE field value, and that is the original's doing**: both
 // evaluators *do not write when they bail out*, and the slot is zeroed only in the main branch
 // (24 slots, i.e. 0..23). Byte evidence: between the `call` and the read of the slot there is no
 // store (@0x51228/@0x5122d, @0x51256/@0x5125b). Measured consequence: in **22 of 22** head-branch
 // situations from real saves the decision falls on the old value, because the flag evaluator
 // bails out at the empty candidate row 0.
    aiFlagUrgency(state, player); // `call 0x5831b` @0x51228
    if ((player.aiUrgency[24] ?? 0) !== 0) {
      aiExecuteBuildTask(state, player, AI_TASK_FLAG); // `call 0x54fd9` @0x51250
      return AI_TASK_FLAG;
    }
    aiGeologistUrgency(state, player); // `call 0x5ae48` @0x51256
    if ((player.aiUrgency[23] ?? 0) < AI_GEOLOGIST_THRESHOLD) {
 // `jb 0x5c54a` @0x5126d — tail jump into the map probing, no executor.
      aiProbeMap(state, player);
      return 0;
    }
    aiExecuteBuildTask(state, player, AI_TASK_GEOLOGIST); // `call 0x54fd9` @0x51284
    return AI_TASK_GEOLOGIST;
  }

 // Main branch @0x5128a.
  for (let n = 0; n < AI_URGENCY_CLEAR_SLOTS; n++) player.aiUrgency[n] = 0;

  if ((player.messageFlags & 0x40) !== 0) {
 // **Emergency programme** (`bt $0x6` @0x5132c, set => fall through here): with material short the
 // original evaluates **only** the three chain buildings, each behind its own hint bit and its own
 // building slot, the same ones as in `building-construction.ts`. Neither the flag/geologist
 // evaluator nor the digger check runs: `jmp 0x51479` @0x513bd leads straight to the selection.
    for (const ev of AI_EMERGENCY_EVALUATORS) {
      if ((player.messageFlags & (1 << ev.bit)) !== 0) continue;
      if ((player.messageBuildingSlots[ev.hintSlot] ?? 0) !== 0) continue;
      evaluatorAt(ev.addr)?.port?.(state, player);
    }
  } else {
 // Full set @0x513c2 — group a (15 evaluators, the first two being flag and geologist).
    for (const ev of AI_EVALUATORS) {
      if (ev.group !== 'a') continue;
      ev.port?.(state, player);
    }
    if (aiSecondGroupDue(player)) {
 // @0x51447 — group b (10 evaluators) only with a digger or a shovel.
      for (const ev of AI_EVALUATORS) {
        if (ev.group !== 'b') continue;
        ev.port?.(state, player);
      }
    } else {
 // @0x51431 `mov %ax,0x3e6(%ebx)` and @0x5143e `mov %ax,0x3ea(%ebx)` — otherwise farm and pig farm
 // are zeroed again, which group a may have set.
 // `0x3d0 + 11 * 2 == 0x3e6` · `0x3d0 + 13 * 2 == 0x3ea`.
      player.aiUrgency[11] = 0;
      player.aiUrgency[13] = 0;
    }
  }

 // Maximum @0x514a6 — the **first** highest value wins (`jae` overwrites only on a lower one).
  let best = 0;
  let bestTask = -1; // `mov $0xffffffff,%eax ; mov %eax,0x8(%edi)` @0x51496
  for (let n = 0; n < AI_URGENCY_SLOTS; n++) {
    const value = player.aiUrgency[n] ?? 0;
    if (best < value) {
      best = value;
      bestTask = n + 1; // vreg0 starts at 1 (@0x51479) — the counter IS the task number
    }
  }
  if (bestTask < 0) return 0; // `js 0x5155a` @0x514e1 — every slot 0
  if (best < player.aiPressureCatchUp) return 0; // `jb 0x5155a` @0x514f1

 // Consumption: the pressure counter of the chosen task is halved (@0x51501…@0x5153f; the original
 // computes the address as `2 * task + 0x400` == `0x402 + 2 * slot`).
  const slot = bestTask - 1;
  player.aiPressure[slot] = (player.aiPressure[slot] ?? 0) >>> 1;
  aiExecuteBuildTask(state, player, bestTask); // `call 0x54fd9` @0x51555
  return bestTask;
}

/**
 * **The three emergency evaluators** in original order (@0x5133c/@0x51367/@0x51392) — each with the
 * hint bit in `messageFlags` and the building slot that gate it individually. Different order and
 * different gates than in the full set, hence a table of its own rather than a filter over the big one.
 */
export const AI_EMERGENCY_EVALUATORS: readonly {
  readonly addr: number; readonly bit: number; readonly hintSlot: number;
}[] = [
  { addr: 0x58833, bit: 3, hintSlot: 0 }, // lumberjack — `bt $0x3` @0x51347, player+0x166
  { addr: 0x5a177, bit: 4, hintSlot: 1 }, // sawmill    — `bt $0x4` @0x51372, player+0x168
  { addr: 0x58c89, bit: 5, hintSlot: 2 }, // stonecutter — `bt $0x5` @0x5139d, player+0x16a
];

/** Table entry for an evaluator address. */
export function evaluatorAt(addr: number): AiEvaluator | undefined {
  return AI_EVALUATORS.find((ev) => ev.addr === addr);
}

/**
 * Does the **second** evaluator block run? Only when a digger is idle or a shovel is in stock
 * (`or %ax,%ax ; jne 0x51447` @0x5141a/@0x51429). Without either nothing can be levelled, so no larger
 * building can be started.
 */
function aiSecondGroupDue(player: Player): boolean {
  return (player.aiIdleSerfs[2] ?? 0) !== 0 || (player.aiStockpile[15] ?? 0) !== 0;
}

/**
 * The table. The order is the call order in the binary; a guard reads the `call` targets from
 * @0x513c2…@0x51408 (group a) and @0x51447…@0x51474 (group b) and compares.
 *
 * The names in the comments are the task `slot + 1` in the building-type numbering.
 */
export const AI_EVALUATORS: readonly AiEvaluator[] = [
  { addr: 0x5831b, slot: 24, extra: null, group: 'a', port: aiFlagUrgency },        // flag
  { addr: 0x5ae48, slot: 23, extra: null, group: 'a', port: aiGeologistUrgency },   // geologist
  { addr: 0x58395, slot: 0, extra: 11, group: 'a', port: aiFisherUrgency },         // fisher (+ farm)
  { addr: 0x58833, slot: 1, extra: null, group: 'a', port: aiLumberjackUrgency },   // lumberjack
  { addr: 0x58ba8, slot: 2, extra: null, group: 'a', port: aiBoatbuilderUrgency },  // boat builder
  { addr: 0x58c89, slot: 3, extra: null, group: 'a', port: aiStonecutterUrgency },  // stonecutter
  { addr: 0x58f40, slot: 4, extra: null, group: 'a', port: aiStoneMineUrgency },    // stone mine
  { addr: 0x59410, slot: 7, extra: null, group: 'a', port: aiGoldMineUrgency },     // gold mine
  { addr: 0x591a8, slot: 5, extra: null, group: 'a', port: aiCoalMineUrgency },     // coal mine
  { addr: 0x592dc, slot: 6, extra: null, group: 'a', port: aiIronMineUrgency },     // iron mine
  { addr: 0x59552, slot: 8, extra: null, group: 'a', port: aiForesterUrgency },     // forester
  { addr: 0x5995c, slot: 10, extra: null, group: 'a', port: aiHutUrgency },         // hut
  { addr: 0x59a91, slot: 11, extra: null, group: 'a', port: aiFarmUrgency },        // farm
  { addr: 0x59c88, slot: 13, extra: 14, group: 'a', port: aiPigFarmUrgency },       // pig farm (+ mill)
  { addr: 0x59fd1, slot: 14, extra: null, group: 'a', port: aiMillUrgency },        // mill
  { addr: 0x59656, slot: 9, extra: null, group: 'b', port: aiWarehouseUrgency },    // warehouse
  { addr: 0x59b2a, slot: 12, extra: null, group: 'b', port: aiButcherUrgency },     // butcher
  { addr: 0x5a04c, slot: 15, extra: null, group: 'b', port: aiBakerUrgency },       // bakery
  { addr: 0x5a177, slot: 16, extra: null, group: 'b', port: aiSawmillUrgency },     // sawmill
  { addr: 0x5a316, slot: 17, extra: null, group: 'b', port: aiSteelSmelterUrgency },// steel smelter
  { addr: 0x5a4b3, slot: 18, extra: null, group: 'b', port: aiToolmakerUrgency },   // toolmaker
  { addr: 0x5a723, slot: 19, extra: null, group: 'b', port: aiWeaponSmithUrgency }, // weapon smith
  { addr: 0x5a928, slot: 20, extra: 21, group: 'b', port: aiTowerUrgency },         // tower (+ fortress)
  { addr: 0x5ab96, slot: 21, extra: null, group: 'b', port: aiFortressUrgency },    // fortress
  { addr: 0x5acab, slot: 22, extra: null, group: 'b', port: aiGoldSmelterUrgency }, // gold smelter
];
