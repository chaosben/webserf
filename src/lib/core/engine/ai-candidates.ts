/**
 * Recording the AI's build sites - `FUN_0005d945` (the cascade) and `FUN_0005dcd0` (the recorder), the
 * last step of the recording chain: here the result reaches the game state, and only then does the AI
 * remember where it wants to build.
 *
 * `FUN_0005d945` is not an evaluator but a 26-fold cascade of byte-identical blocks, one per project
 * id: test bit n of the project mask, call evaluator n, and record unless the score is 0. The zero flag
 * the second jump depends on comes from the `or %ax,%ax` right before each evaluator's `ret`, so the
 * score itself is the criterion.
 *
 * The project mask is indexed with `possibility - 1` and is therefore not merely an argument but the
 * DRIVER of the cascade. It confirms three readings independently:
 *
 * | Possibility | Mask | Projects |
 * |---|---|---|
 * | 1 | `0x00000001` | bit 0 only == the flag |
 * | 2 | `0x020001e0` | the four mines plus bit 25 == the geologist |
 * | 3 | `0x00008a1e` | |
 * | 4 | `0x00fffe1e` | |
 * | 5 | `0x01000000` | bit 24 only == the castle |
 *
 * That "mountains" admits exactly the four mines AND id 25 is the proof that 25 is the geologist: he is
 * the only one who belongs in the mountains without being a building. And the first blocking mask
 * clears exactly hut, tower and fortress, the three buildings "military blocked" forbids.
 *
 * The recorder keeps eight slots per project and evicts the weakest. Two subtleties the port has to
 * keep: the position check sits in the SAME pass behind the minimum check, so an already known spot is
 * overwritten whether or not the new value is better; and on a tie for the minimum the LATER slot wins,
 * because the comparison is `>=`.
 *
 * The attack targets (ids 26..34) live in {@link aiRecordAttackTargets}. They have no byte round trip -
 * no stored candidate slot for them ever sits on the stored cursor position - so that branch is checked
 * instruction by instruction and through a round trip on the production port.
 */
import type { GameState, Player } from './state.js';
import type { AiSurvey } from './ai-survey.js';
import { aiSurveySurroundings } from './ai-survey.js';
import {
  AI_ATTACK_COUNT,
  AI_ATTACK_FIRST,
  scoreAttackTarget,
  scoreProject,
} from './ai-score.js';

/** 35 projects (0..24 building types, 25 geologist, 26..34 branch B) x 8 slots x 6 B == 1680 B. */
export const AI_PROJECT_COUNT = 35;
/** `mov $0x7,%eax ; mov %eax,0x4(%edi)` @0x5dd38 — eight passes (7..0 with `jae`). */
export const AI_CANDIDATE_SLOTS = 8;
/** The cascade covers bits 0..25 (`btl $0x19` is the last block, @0x5dcae). */
export const AI_SCORED_PROJECTS = 26;

/** @0x5c9d7, indexed with `possibility - 1`, so index 0 belongs to possibility 1. */
export const AI_PROJECT_MASK: readonly number[] = [
  0x00000001, // possibility 1 — flag
  0x020001e0, // possibility 2 — four mines + geologist
  0x00008a1e, // possibility 3
  0x00fffe1e, // possibility 4
  0x01000000, // possibility 5 — castle
];

/** `andl $0xff9ff7ff` @0x5c750 on `build` bit 0 — removes hut (11), tower (21), fortress (22). */
export const AI_MASK_NO_MILITARY = 0xff9ff7ff;
/** `andl $0xfffffffe` @0x5c76b on `build` bit 1 — removes the flag (bit 0). */
export const AI_MASK_NO_FLAG = 0xfffffffe;

/**
 * The project mask for a build possibility — @0x5c716..@0x5c76f. `build` bit 0 is "military blocked",
 * bit 1 blocks the **flag**. Both are tested as single bits (`bt $0x0`/`bt $0x1` on `player+3`), not
 * as a mask.
 */
export function aiProjectMask(player: Player, possibility: number): number {
  let mask = AI_PROJECT_MASK[possibility - 1] ?? 0;
  if ((player.build & 0x1) !== 0) mask &= AI_MASK_NO_MILITARY;
  if ((player.build & 0x2) !== 0) mask &= AI_MASK_NO_FLAG;
  return mask >>> 0;
}

/**
 * **The recorder** `FUN_0005dcd0` @0x5dcd0 — puts `(score, col, row)` into the project's eight-slot
 * list. Exactly one exit, and it writes: either the score of an already known spot or the weakest
 * slot. If the new value is weaker than all eight, nothing happens.
 */
export function aiRecordCandidate(
  player: Player,
  project: number,
  score: number,
  col: number,
  row: number,
): void {
  const slots = player.aiCandidates[project];
  if (slots === undefined) return;

  let min = 0xffff;
  let weakest = 0;
  for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) {
    const slot = slots[i];
    if (slot === undefined) continue;
 // @0x5dd4e `cmp %ax,0xc(%edi) ; jb` — taken on `min >= score`, so on a tie the LATER slot wins.
    if (min >= slot.score) {
      min = slot.score;
      weakest = i;
    }
 // @0x5dd6d — same spot already recorded? Then overwrite the score and stop; the original does
 // NOT compare whether the new value is better.
    if (slot.col === col && slot.row === row) {
      slot.score = score;
      return;
    }
  }
 // @0x5dd92 `cmp %ax,0x1c(%edi) ; jb` — insert when the new value reaches the weakest.
  if (score < min) return;
  const target = slots[weakest];
  if (target === undefined) return;
  target.score = score;
  target.col = col;
  target.row = row;
}

/**
 * **The cascade** `FUN_0005d945` @0x5d945 — evaluates the probed spot for every project the mask
 * admits and records every hit with a non-zero score. Returns the number of **evaluated projects with
 * a non-zero score**, NOT the number of table entries: `aiRecordCandidate` discards a candidate whose
 * score is below the weakest slot of the row, and that still counts here. The original has no return
 * value at all; the counter serves the tests, and the production caller discards it.
 *
 * The cursor comes from the player, not from parameters: the caller wrote it immediately before
 * (@0x5c6d1..@0x5c6ed) and the recorder reads it from there.
 */
export function aiScoreAndRecord(
  player: Player,
  survey: AiSurvey,
  possibility: number,
): number {
  const mask = aiProjectMask(player, possibility);
  let recorded = 0;
  for (let project = 0; project < AI_SCORED_PROJECTS; project++) {
    if ((mask & (1 << project)) === 0) continue;
    const score = scoreProject(project, survey, player);
    if (score === 0) continue;
    aiRecordCandidate(player, project, score, player.cursorCol, player.cursorRow);
    recorded++;
  }
  return recorded;
}

/**
 * Branch A of the probe from the cursor write on: survey, evaluation, recording — the original's order
 * (@0x5c783 `call 0x606d2`, @0x5c796 `call 0x5d945`). Bundled because that is exactly the sequence the
 * probe needs, and the survey without the evaluation would have no effect.
 */
export function aiRecordBuildSite(
  state: GameState,
  player: Player,
  possibility: number,
): number {
  const survey = aiSurveySurroundings(state, player, possibility);
  return aiScoreAndRecord(player, survey, possibility);
}

/**
 * **Branch B: the nine attack-target predicates** — `FUN_0005cc57` @0x5cc57. The counterpart to the
 * cascade above, for ids 26..34, and the **producer** of the candidate rows the attack task reads as
 * its target selection.
 *
 * The dispatcher has nine byte-identical blocks:
 *
 * ```
 * call <predicate>                              # ends with `or %ax,%ax`
 * je next                                       # score 0 => no candidate
 * mov $n,%eax ; mov %eax,(%edi) ; call 0x5dcd0  # set the id, record
 * next:
 * ```
 *
 * **Two differences from branch A's cascade, both meaningful:**
 *
 * 1. **No project mask.** All nine always run, so one probe can record up to nine candidates, while
 *    branch A is restricted to the build form by the mask.
 * 2. **No exit after recording.** The `je` skips only the recording, not the rest.
 *
 * ## The consequence of the missing prologue call at id 28
 *
 * Because `0x1c(%edi)` (the score) **persists** across the nine calls — the recorder only reads it
 * (`cmp %ax,0x1c(%edi)` @0x5dd92), it never writes it — and id 28 does not reset it to `0xffff`, it
 * continues on the result of id 27. From that follows a sharp, testable statement: **if the tool
 * chain's score was 0, the gold chain's is necessarily 0 too** — the gold chain cannot become a target
 * without the tool chain. The port reproduces this with `carried` rather than repairing it.
 *
 * Returns the number of entries (the original has no return value; the counter serves the tests).
 */
export function aiRecordAttackTargets(player: Player, survey: AiSurvey): number {
  let recorded = 0;
 /** `0x1c(%edi)` across the nine calls. Before the first the value is irrelevant (26 has a prologue). */
  let carried = 0;

  for (let i = 0; i < AI_ATTACK_COUNT; i++) {
    const project = AI_ATTACK_FIRST + i;
    carried = scoreAttackTarget(project, survey, carried);
    if (carried === 0) continue; // `je` @0x5cc5c ff. — only the recording is skipped
    aiRecordCandidate(player, project, carried, player.cursorCol, player.cursorRow);
    recorded++;
  }
  return recorded;
}

/**
 * Branch B from the cursor write on: survey with **build possibility 0** and the nine predicates — the
 * original's order (@0x5c980 `call 0x606d2`, @0x5c985 `call 0x5cc57`). The 0 is not a placeholder but
 * stands so in the binary (`mov $0x0,%al` @0x5c91b, then into `player+0x101`) and selects a different
 * level plan in the survey.
 */
export function aiRecordAttackSite(state: GameState, player: Player): number {
  const survey = aiSurveySurroundings(state, player, 0);
  return aiRecordAttackTargets(player, survey);
}
