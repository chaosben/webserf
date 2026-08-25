/**
 * **The AI's build executor** — `FUN_00054fd9` @0x54fd9 (541 instructions, 2 exits, 31 branches). This
 * is where the AI stops computing and **starts building**: the build decider names a task, the executor
 * looks up the best recorded candidate for it, checks it and puts a flag, a mine or a building into the
 * world.
 *
 * ```
 * head    : task -> build form (gs+0x24a) + possibility MASK (gs+0x24c) + candidate ROW
 * select  : maximum over the row's 8 slots, consume (score 0), set the cursor,
 *           classify_build_site, check against mask + military block — else next candidate
 * score   : surroundings survey + single evaluation of the row (`FUN_0005816d`)
 * exit    : flag | geologist (mine) | building, each followed by a ROAD-BUILD JOB
 * ```
 *
 * **Four things are not obvious here.**
 *
 * 1. **`gs+0x27a` first carries the task, then the candidate ROW.** The head rewrites the field (`0`
 *    for the flag @0x55016, `25` for the geologist @0x55048) — exactly the conversion
 *    {@link AI_TASK_TO_CANDIDATE_ROW} performs. The port takes the task as a parameter and converts
 *    locally instead of keeping a second model of that original field.
 *
 * 2. **The re-scan @0x55233 is structurally unreachable.** It compares against `*bestSlot` — and the
 *    score there was set to 0 two blocks earlier, so `score >= 0` is always true and `jae 0x55289`
 *    always taken. The port reproduces it anyway: it costs nothing, and were the reading wrong its
 *    absence would be expensive.
 *
 * 3. **The flag lands on the tile *below* the building**, and the stored cursor kind still applies to
 *    the building tile. That is why at kind 6 ("clear, but a road touches the flag tile") the original
 *    forces the kind to **4** (@0x5550d) — only then does `build_flag` split the road. A freshly
 *    classifying call would see 6 there and leave the road; hence {@link buildFlagRecord} takes the
 *    kind as a parameter.
 *
 * 4. **The four road-builder calls are not equivalent.** Both flag exits discard its result
 *    (`jmp 0x5579f` onto the `ret`, @0x55339/@0x5539a) — the flag stays even without a road. The
 *    geologist and building exits check it and **tear down** when no road came about
 *    (@0x555a0/@0x5575a). The return value is `player+0x19e` (block 542); the road builder zeroes it
 *    per road laid (@0x56e78), otherwise the preset `0xffff` remains.
 */
import type { GameState, Player } from './state.js';
import { u16 } from './int.js';
import { posOf } from './position.js';
import {
  classifyBuildSite,
  persistBuildSiteBits,
  placeBuilding,
  buildFlagRecord,
  CURSOR_CLEAR,
  CURSOR_CLEAR_BY_FLAG,
  CURSOR_PATH,
  CURSOR_CLEAR_BY_PATH,
} from './build-site.js';
import { demolishBuilding } from './buildings.js';
import { attachFlagToRoad } from './road-attach.js';
import { demolishFlag } from './road-teardown.js';
import { aiSurveySurroundings } from './ai-survey.js';
import { AI_ATTACK_FIRST, scoreAttackTarget, scoreProject } from './ai-score.js';
import { sendGeologistToFlag } from './serf-request.js';
import { aiBuildRoads } from './ai-road-builder.js';

/** Task "send a geologist" (`mov $0x18,%ax` @0x51273) — urgency slot 23. */
export const AI_TASK_GEOLOGIST = 24;
/** Task "place a flag" (`mov $0x19,%ax` @0x5123f) — urgency slot 24. */
export const AI_TASK_FLAG = 25;

/** This routine itself — the address the call sites in `ai-decide.ts` name it by. */
export const AI_EXECUTOR = 0x54fd9;

/**
 * **Task -> row of the candidate table.** The head rewrites `gs+0x27a` before addressing the row: flag
 * to 0 (`xor %ax,%ax` @0x55016), geologist to 25 (`mov $0x19,%ax` @0x55048), everything else stays
 * (building type == row). The two numberings are the reason this conversion exists at all: in the task
 * numbering 24 is the geologist and 25 the flag; in the candidate numbering 0 is the flag, 24 the
 * castle and 25 the geologist.
 */
export function AI_TASK_TO_CANDIDATE_ROW(task: number): number {
  if (task === AI_TASK_FLAG) return 0;
  if (task === AI_TASK_GEOLOGIST) return 25;
  return task;
}

/**
 * `mov $0x3ff7400,%eax` @0x54ff3 — the bit set of tasks that need a **large** footprint: bits
 * `{10, 12, 13, 14, 16..25}`. For building tasks 1..23 this is **bit for bit** the `LARGE_TYPES` table
 * in `build-site.ts` — an independent confirmation of it (the mill, 15, is **not** large in either).
 * The extra bits 24/25 are geologist and flag, which the head handles separately.
 */
export const AI_LARGE_TASK_SET = 0x3ff7400;

/** `mov $0x18,%al` @0x54fe1 — default mask: possibility 3 (small) **or** 4 (large). */
export const AI_MASK_SMALL_OR_LARGE = 0x18;
/** `mov $0x10,%al` @0x5506f — possibility 4 (large footprint) only. */
export const AI_MASK_LARGE = 0x10;
/** `mov $0x4,%al` @0x55084 / @0x5505e — possibility 2 (mountains => mine) only. */
export const AI_MASK_MINE = 0x4;
/** `mov $0x2,%al` @0x5502b — possibility 1 (flag) only. */
export const AI_MASK_FLAG = 0x2;

/** `cmpw $0x9470,0x1c(%edi)` @0x552d1 — score threshold of the flag branch. */
export const AI_FLAG_ATTACH_THRESHOLD = 38000;

/** `cmpl $0x1000,(%edi)` @0x5566e / `mov $0xfff,%ax` @0x55676 — clamp of the catch-up pressure. */
export const AI_CATCHUP_LAND_CLAMP = 0xfff;
/** `addw $0x3000,(%edi)` @0x5568c — base of the same computation. */
export const AI_CATCHUP_BASE = 0x3000;

/** The AI road builder — ported in {@link ./ai-road-builder.ts}, see point 4 in the module head. */
export const AI_ROAD_BUILDER = 0x557b2;

/**
 * `mov $0x7,%eax` @0x550db / @0x55268 — the candidate selection's loop counter. With `subw $0x1 ; jae`
 * it runs 7 down to -1, i.e. **8** passes = the 8 slots of a row.
 */
export const AI_CANDIDATE_SLOTS = 8;

/**
 * **Build form and mask are LOCAL, not in the `GameState`** — although the original stores them in
 * `gs+0x24a` and `gs+0x24c` (@0x55090/@0x5509d) and reads them back twice (@0x55296/@0x55497).
 *
 * That is evidenced, not convenient: the two addresses are **shared scratch fields** (19 and 16
 * accesses from ten routines, among them @0x1bc53, @0x2b5ff — and the road builder itself overwrites
 * them @0x558a4/@0x558b2), so a named field would mislead. And between the write and the **last**
 * read-back the executor calls only the classifier (0x32075), the survey (0x606d2) and the evaluation
 * (0x5e…) — none of which is in the writer list, so locality holds.
 */
export const AI_FORM_SCRATCH = { sizeClass: 0x24a, mask: 0x24c } as const;

/** The three tasks `build` bit 0 ("military blocked") forbids (@0x551b1/@0x551c2/@0x551d3). */
const AI_MILITARY_TASKS: readonly number[] = [0xb, 0x15, 0x16];

/**
 * **The jump table of the evaluation dispatcher** `FUN_0005816d` @0x5818b — as a list of project ids in
 * table order. The dispatcher computes `row * 8` and jumps (`shlw $0x3` @0x5817a,
 * `lea 0x5818b,%esi` @0x5817e); the table has **34** occupied slots.
 *
 * **It is COMPACTED around the castle slot, and that is evidenced at the byte.** Its targets are row by
 * row the evaluators of ids `{0..23}` and then `{25..34}` — the castle id 24, whose evaluator is
 * `FUN_00060104`, does **not** appear (24 + 10 == 34 slots). Evidence from the other side: the cascade
 * `FUN_0005d945` pairs `call 0x60104` with `mov $0x18` (24, @0x5dc99) and `call 0x5ffca` with
 * `mov $0x19` (25, @0x5dcba), and the branch-B recorder pairs 0x5cd15…0x5d85b with
 * `mov $0x1a`…`$0x22` (26..34, @0x5cc5e ff.).
 *
 * **Consequence — a quirk of the original, not a simplification:** the executor uses the *same* number
 * to address the candidate table (where 24 is the castle and 25 the geologist, evidenced through
 * `0x434 + 24*48 == 0x8b4` and `+ 25*48 == 0x8e4`) **and** this dispatcher. For rows 0..23 both
 * numberings agree; from 24 on they drift apart by one. The geologist row 25 therefore lands on the
 * evaluator of id **26** (branch B), the castle row 24 on the geologist's. The table is reproduced, not
 * the intent.
 */
export const AI_SINGLE_SCORE_DISPATCH: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
  25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
];

/** What the head @0x54fd9..@0x55089 makes of the task. */
export interface AiBuildForm {
  /** `gs+0x24a` — 2 small, 3 large, 0 geologist/mine, -1 flag. */
  readonly sizeClass: number;
  /** `gs+0x24c` — bit mask of the permitted build possibilities. */
  readonly mask: number;
  /** The candidate table row the executor works through. */
  readonly row: number;
}

/**
 * The head: task -> build form. Byte for byte the cascade @0x54fff..@0x55089.
 *
 * The geologist needs a **founded castle** (`flags` bit 0, @0x55034). Without one, task 24 falls into
 * the same branch as a large building — row 24 of the candidate table is the **castle** row and the
 * mask demands a large footprint. That is the castle site search; its consumer is state 0 (see
 * `ai-tick.ts`), and this branch is the route through the scheduler.
 */
export function aiBuildForm(player: Player, task: number): AiBuildForm {
  if (((AI_LARGE_TASK_SET >>> task) & 1) === 0) {
    // @0x55078/@0x5507e — the four mines 5..8 (stone/coal/iron/gold) want mountains.
    const mask = task >= 5 && task < 9 ? AI_MASK_MINE : AI_MASK_SMALL_OR_LARGE;
    return { sizeClass: 2, mask, row: task };
  }
  if (task < AI_TASK_GEOLOGIST) {
    return { sizeClass: 3, mask: AI_MASK_LARGE, row: task }; // @0x55067
  }
  if (task === AI_TASK_FLAG) {
    // `mov $0xffffffff,%eax` @0x55023 — the flag's build form is the only NEGATIVE one, and its sign
    // is exactly what separates the flag exit from mine and building (@0x552a0 `jns`).
    return { sizeClass: -1, mask: AI_MASK_FLAG, row: AI_TASK_TO_CANDIDATE_ROW(task) }; // @0x55016
  }
  if ((player.flags & 0x1) === 0) {
    return { sizeClass: 3, mask: AI_MASK_LARGE, row: task }; // @0x55034 => @0x55067, row 24
  }
  return { sizeClass: 0, mask: AI_MASK_MINE, row: AI_TASK_TO_CANDIDATE_ROW(task) }; // @0x55048
}

/** A candidate slot as the selection returns it. */
interface Chosen {
  readonly slot: number;
  readonly score: number;
}

/**
 * Maximum over the row's **8** slots (@0x550ea..@0x55111). On a tie the **earlier** slot wins
 * (`cmp %ax,0x4(%edi) ; jae` overwrites only on a strictly greater value) — the opposite convention to
 * the recorder in `ai-candidates.ts`, where the later slot wins.
 */
function pickBestCandidate(player: Player, row: number): Chosen | null {
  const slots = player.aiCandidates[row];
  if (slots === undefined) return null;
  let best = 0;
  let bestSlot = -1;
  for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) {
    const score = slots[i]?.score ?? 0;
    if (best < score) {
      best = score;
      bestSlot = i;
    }
  }
  if (best === 0) return null; // @0x5511a je — the routine's one bare exit
  return { slot: bestSlot, score: best };
}

/**
 * The building branch's catch-up pressure bonus (@0x55663..@0x556ae):
 * `0x3000 - 2*min(landScore, 0xfff)`, accumulated into block 568 with saturation at `0xffff`.
 *
 * The direction matches the field (see `ai-pressure.ts`): **much** land => **small** bonus. At
 * `land >= 0x1800` the term would go negative — the clamp to `0xfff` prevents exactly that, so the term
 * stays in `[0x1002, 0x3000]`.
 */
export function aiApplyBuildCatchUp(player: Player): void {
  // `cmpl $0x1000,(%edi) ; jb` @0x5566e — the comparison is against 0x1000, the clamp is to 0xfff;
  // `> 0xfff` is the same predicate as `!(< 0x1000)`.
  const land = player.totalLandScore >= AI_CATCHUP_LAND_CLAMP + 1
    ? AI_CATCHUP_LAND_CLAMP
    : player.totalLandScore;
  const term = u16(AI_CATCHUP_BASE - u16(land + land));
  const sum = player.aiPressureCatchUp + term;
  player.aiPressureCatchUp = sum > 0xffff ? 0xffff : sum; // `jae` ⇒ 0xffff @0x556a0
}

/** Set the five job fields in one go — exactly one assignment per exit. */
function writeRoadJob(
  player: Player,
  b540: number,
  b542: number,
  b548: number,
  b552: number,
  b570: number,
): void {
  player.aiRoadJob540 = b540;
  player.aiRoadJob542 = b542;
  player.aiRoadJob548 = b548;
  player.aiRoadJob552 = b552;
  player.aiRoadJob570 = b570;
}

/**
 * `bts $0x4` @0x552e6 / `btr $0x4` @0x55346/@0x55594/@0x5574e — `build` **bit 4**. It is set at
 * **exactly one** place in the whole binary (the flag branch with score < 38000) and cleared at seven;
 * its **three readers all sit in the AI road builder** (`bt $0x4` @0x570f8, @0x574ad, @0x57880).
 * Meaning: **bit 4 == water-road job** — over land the ring walk dies at once because the build-site
 * branch skips the productivity mark ({@link ./ai-road-builder.ts}).
 */
function setRoadJobBit(player: Player, on: boolean): void {
  player.build = on ? (player.build | 0x10) & 0xff : player.build & ~0x10 & 0xff;
}

/**
 * The **first word of a tile's game layer** — `mov (%ebx),%ax` @0x55629; the original reads it raw and
 * treats it as a flag index.
 *
 * Our tile model has the four bytes decoded, so the word is **rebuilt** here:
 *
 * | Case | Bytes 0..1 | in the model |
 * |---|---|---|
 * | `object` 1..4 (flag/building) | the index itself | `objIndex` |
 * | else | `(mineral << 5) \| resourceAmount`, then the pad byte | computed |
 *
 * Of the pad byte **only bit 7** is known: the idle-serf marker, proven at the byte to be equivalent to
 * "a serf in state 66..69 stands here" (53 saves, 5301 markers, 0 counter-examples) — see
 * `wakeCarrierOnPath`. It is therefore derived from the serf table; nothing is known about bits 0..6 of
 * the pad byte and they are carried as 0.
 *
 * A set bit 7 makes the index >= 0x8000 and thus unusable — in the original exactly as here.
 */
function gameWordAt(state: GameState, tile: { object: number; objIndex: number; mineral: number; resourceAmount: number }, pos: number): number {
  if (tile.object >= 1 && tile.object <= 4) return tile.objIndex;
  let word = ((tile.mineral & 7) << 5) | (tile.resourceAmount & 0x1f);
  for (const serf of state.serfs) {
    if (!serf || serf.col === null || serf.row === null) continue;
    if (serf.state < 66 || serf.state > 69) continue;
    if (posOf(serf.col, serf.row, state.geo) !== pos) continue;
    word |= 0x8000;
    break;
  }
  return word;
}

/** Move the cursor one tile down-right — `(col+1) & gs[0x32]`, `(row+1) & gs[0x34]`. */
function stepCursorDownRight(state: GameState, player: Player, delta: number): void {
  const geo = state.geo;
  player.cursorCol = u16(player.cursorCol + delta) & geo.colMask;
  player.cursorRow = u16(player.cursorRow + delta) & geo.rowMask;
}

/**
 * **The executor.** `task` is the decider's return value (1..25); the port carries it as a parameter
 * because the original stores it in `gs+0x27a` — the same field the human's build menu writes to (see
 * point 1 in the module head).
 */
export function aiExecuteBuildTask(state: GameState, player: Player, task: number): void {
  const form = aiBuildForm(player, task);
  const geo = state.geo;

  // --- Selection: try the row's candidates until one passes the checks -------------------------
  let score = 0;
  let cursorType = 0;
  for (;;) {
    const chosen = pickBestCandidate(player, form.row);
    if (chosen === null) return; // @0x5511a — nothing (left) recorded
    const slots = player.aiCandidates[form.row]!;
    const slot = slots[chosen.slot]!;

    // @0x5512c: consume. That makes the loop finite — a zeroed slot never becomes the maximum again
    // — and it is why the re-scan below cannot fire.
    player.cursorCol = slot.col; // @0x5513f
    player.cursorRow = slot.row; // @0x55150
    slot.score = 0;

    const site = classifyBuildSite(state, player, player.cursorCol, player.cursorRow); // @0x5515a
    persistBuildSiteBits(player, site);
    cursorType = site.cursorType;

    if (site.cursorType < CURSOR_CLEAR_BY_FLAG) continue; // @0x55162 `cmpb $0x5 ; jb`
    if (((form.mask >>> site.possibility) & 1) === 0) continue; // @0x5518b `bt %cx,%ax ; je`
    // @0x5519a: `build` bit 0 = military blocked => skip hut/tower/fortress.
    if ((player.build & 0x1) !== 0 && AI_MILITARY_TASKS.includes(form.row)) continue;

    const survey = aiSurveySurroundings(state, player, site.possibility); // @0x551e1
    // @0x55216 `call 0x5816d` — the dispatcher. It jumps through the **compacted** table, so the row
    // is not the id: see {@link AI_SINGLE_SCORE_DISPATCH}.
    const project = AI_SINGLE_SCORE_DISPATCH[form.row];
    if (project === undefined) return; // row past the table — in the original a jump into nowhere
    // Ids 26..34 are the branch-B predicates (`0x5cd15`…`0x5d85b`). Only the **geologist row 25** =>
    // id 26 is reached here: `aiBuildForm` produces rows 0..25, rows 26..34 never arrive. Id 26 starts
    // with `call 0x5c9eb` and sets the score to `0xffff` itself, so the carry from `0x1c(%edi)` is
    // irrelevant to it and passing 0 is provably equivalent. Only id 28 computes on the carry (see
    // {@link scoreAttackTarget}); it is unreachable from here, and **if** it ever became reachable the
    // 0 would be wrong — hence this note rather than a silent constant.
    score = project >= AI_ATTACK_FIRST
      ? scoreAttackTarget(project, survey, 0)
      : scoreProject(project, survey, player);

    // @0x5522d — the unreachable re-scan (point 2 in the module head). `slot.score` is 0 right now, so
    // the comparison `score >= 0` is always true; the body stays as evidence that it was read.
    if (slot.score > score) {
      let found = false;
      for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) {
        if ((slots[i]?.score ?? 0) > score) {
          found = true;
          break;
        }
      }
      if (!found) break; // @0x55287 => @0x55289
      slot.score = score; // @0x557a0, then back to @0x550a3
      continue;
    }
    break;
  }

  if (score === 0) return; // @0x55290/@0x55292 — the bare exit

  // --- Exit 1: the flag (@0x552a6) -------------------------------------------------------------
  if (form.sizeClass < 0) {
    // In the original the score survives the call on its own stack (@0x552a7/@0x552c2).
    buildFlagRecord(state, player, player.cursorCol, player.cursorRow, cursorType); // @0x552bc
    if (score < AI_FLAG_ATTACH_THRESHOLD) {
      attachFlagToRoad(state, player.cursorCol, player.cursorRow); // @0x552d9
      setRoadJobBit(player, true);
      writeRoadJob(player, 0, 0xffff, 0, 0, 0);
    } else {
      setRoadJobBit(player, false);
      writeRoadJob(player, 0, 0xffff, 6, 0, 0);
    }
    // @0x55334/@0x55395: the road builder. Both flag exits do **not** check its result
    // (`jmp 0x5579f` onto the `ret`) — the flag stays even when no road comes about.
    aiBuildRoads(state, player);
    return;
  }

  // --- Shared job preamble for mine and building (@0x5539f) ------------------------------------
  // Only four of the five fields; 548 stays and is set at the exit.
  player.aiRoadJob570 = 0; // @0x5539f
  player.aiRoadJob540 = 0; // @0x553ac
  player.aiRoadJob542 = 0xffff; // @0x553b9
  player.aiRoadJob552 = 0xc; // @0x553c7

  // @0x553d5: kind 7 (fully clear) skips the block. Kind 5 (clear, flag adjacent) only when the flag
  // tile is **road-free**; otherwise the same branch as for kind 6 applies.
  let skipShortJob = cursorType === CURSOR_CLEAR;
  if (!skipShortJob && cursorType === CURSOR_CLEAR_BY_FLAG) {
    // @0x553f1..@0x55469: the road bits of the tile **down-right** — that is where the flag lands.
    const pos = posOf(
      u16(player.cursorCol + 1) & geo.colMask,
      u16(player.cursorRow + 1) & geo.rowMask,
      geo,
    );
    // `andb $0x3f,(%edi) ; je 0x55494` — the six road bits only, not the block or flag markers.
    if (((state.mapTiles[pos]?.paths ?? 0) & 0x3f) === 0) skipShortJob = true;
  }
  if (!skipShortJob) {
    player.aiRoadJob542 = 0; // @0x5546b
    player.aiRoadJob570 = 0x1e; // @0x55478
    player.aiRoadJob540 = 0xc; // @0x55486
  }

  // --- Exit 2: the geologist (@0x554ab) --------------------------------------------------------
  if (form.sizeClass === 0) {
    stepCursorDownRight(state, player, 1); // @0x554ab/@0x554d3
    if (cursorType >= CURSOR_CLEAR_BY_PATH) {
      // @0x5550d: kind 6 => force to 4 so that `build_flag` splits the road (point 3 above).
      const flagCursorType = cursorType === CURSOR_CLEAR_BY_PATH ? CURSOR_PATH : cursorType;
      buildFlagRecord(state, player, player.cursorCol, player.cursorRow, flagCursorType); // @0x5551a
      if (attachFlagToRoad(state, player.cursorCol, player.cursorRow)) {
        // @0x55524 `js` — `attach_flag_to_road` returns its result in the flags: `vreg3` is -1
        // ("nothing attached", @0x4cd9f) and becomes 0 after an attachment (@0x4ce8b).
        player.aiRoadJob570 = 0x32; // @0x55526
        player.aiRoadJob540 = 8;
        player.aiRoadJob542 = 0;
      }
      player.aiRoadJob548 = 0; // @0x5554f
      // @0x5555c: 540 != 0 => clamp to 8, otherwise set 552 = 8 instead.
      if (player.aiRoadJob540 !== 0) player.aiRoadJob540 = 8;
      else player.aiRoadJob552 = 8;
      setRoadJobBit(player, false); // @0x55594
      // @0x555a0: the road builder. On a negative result (block 542) the original tears the
      // just-placed flag down again.
      if (((aiBuildRoads(state, player) << 16) >> 16) < 0) {
        const tile = state.mapTiles[posOf(player.cursorCol, player.cursorRow, geo)];
        if (tile !== undefined && tile.object === 1) {
          demolishFlag(state, tile.objIndex, player.cursorCol, player.cursorRow); // @0x555c5
        }
        return;
      }
    }
    // @0x555cf..@0x55657: request a geologist to the cursor tile's flag (`call 0x12370` @0x55659 ==
    // `request_serf_to_flag`, serf type 0x14, target state 0x22 — the same chain as the human's
    // geologist button; the whole binary has only **two** call sites of that routine, @0x2e589 for the
    // human and this one).
    //
    // **The original does NOT check whether a flag stands there.** It simply reads the first word of
    // the game layer (`mov (%ebx),%ax` @0x55629) and computes the record pointer from it
    // (`mov $0x46,%ax` @0x5562f, `mul %cx` @0x55639). With a flag on the tile that is its index;
    // without one it is the resource byte plus the pad byte — an **arbitrary, small** index, and the
    // geologist is sent to an entirely different flag. A `tile.object === 1` guard here would be an
    // invention and would suppress exactly these requests.
    const geoPos = posOf(player.cursorCol, player.cursorRow, geo);
    const tile = state.mapTiles[geoPos];
    if (tile !== undefined) sendGeologistToFlag(state, gameWordAt(state, tile, geoPos));
    return;
  }

  // --- Exit 3: the building (@0x55663) ---------------------------------------------------------
  aiApplyBuildCatchUp(player);
  placeBuilding(state, player, player.cursorCol, player.cursorRow, form.row); // @0x556b1
  stepCursorDownRight(state, player, 1); // @0x556b6
  if (attachFlagToRoad(state, player.cursorCol, player.cursorRow)) {
    player.aiRoadJob570 = 0x46; // @0x55710
    player.aiRoadJob540 = 0xc;
    player.aiRoadJob542 = 0;
  }
  player.aiRoadJob548 = 0; // @0x55739
  setRoadJobBit(player, false); // @0x5574e
  // @0x5575a: the road builder; on a negative result the just-placed building falls again.
  if (((aiBuildRoads(state, player) << 16) >> 16) < 0) {
    // The failure path @0x55761..@0x55796 computes the cursor offset by (-1,-1) **in the context
    // only** and does NOT write it back into the player record:
    //
    //   55764  mov 0xfc(%ebx),%ax   ; 5576b  mov %ax,(%edi)
    //   5576e  subw $0x1,(%edi)     ; 55779  and %ax,(%edi)     with %ax == gs+0x32 (colMask)
    //   5577f  mov 0xfe(%ebx),%ax   ; 55786  mov %ax,0x4(%edi)
    //   5578a  subw $0x1,0x4(%edi)  ; 55796  and %ax,0x4(%edi)  with %ax == gs+0x34 (rowMask)
    //
    // So `player+0xfc`/`0xfe` stay on the flag tile. Writing them back would drift the stored cursor
    // by (-1,-1) after every failed road build (blocks 380/382 in the save).
    const dcol = u16(player.cursorCol - 1) & geo.colMask;
    const drow = u16(player.cursorRow - 1) & geo.rowMask;
    const tile = state.mapTiles[posOf(dcol, drow, geo)];
    // OPEN @0x5579a — `0x48eb8` does NOT check the tile's object: it reads the game word, takes it
    // times 18 as the building base and tests only `bld[5]` bit 5. With no building there (e.g.
    // because `placeBuilding` was refused at the warehouse cap and its result is checked nowhere), the
    // original tears down whatever building the nonsense index points at. That is not reproducible in
    // our model — an index outside the table is `undefined`, not a readable byte — hence the object
    // test here. A deliberate deviation, not an oversight.
    if (tile !== undefined && tile.object >= 2 && tile.object <= 4) {
      const bld = state.buildings[tile.objIndex];
      if (bld) demolishBuilding(state, bld); // @0x5579a
    }
  }
}
