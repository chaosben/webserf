/**
 * Scoring the AI's build sites (`FUN_0005d945`) - 26 evaluators plus three shared sub-evaluators.
 * Second step of the recording chain: the surroundings survey has counted what lies around, here the
 * AI decides what it wants to build there and how good the spot is for it.
 *
 * An evaluator is a factor CHAIN, not a special case: the score starts at `0xffff` (== 1.0) and is
 * multiplied per factor by a 16-bit fraction, built from counter -> clamp -> shift -> optional `not`
 * (turns a bonus into a penalty) -> optional base -> `score = score * factor / 65536`. A score of 0
 * means "no candidate"; on top there are hard vetoes that force 0.
 *
 * The chains stand here as DATA because that is what makes them checkable op by op against the
 * instruction stream. The op ORDER carries meaning: some chains shift BETWEEN two additions and mix
 * tables while doing so, which a flag set `{slots, shift, clamp}` cannot express.
 *
 * Two evaluators are not chains: project 0 (flag) is branching logic with three fixed scores, and
 * project 24 (castle) is a chain plus a branch on the difficulty.
 *
 * Arithmetic conventions, all deliberate:
 * - Everything is 16-bit and overflows. The base additions are chosen so the factor lands just under
 *   1.0, so the overflow is part of the computation. Counters are read UNSIGNED here even though
 *   `ai-survey.ts` carries them as `i16`.
 * - The clamp is unsigned and almost always yields `at - 1`. Almost: project 25 clamps 255 to 24.
 * - Two veto forms: score 0 when the counter is non-zero, and score 0 on underflow. The second also
 *   jumps to the end of the chain, which is equivalent because `0 * x >> 16 == 0`.
 */
import type { Player } from './state.js';
import type { AiSurvey } from './ai-survey.js';
import { SURVEY_FOREIGN_LAND, SURVEY_FREE_LAND, SURVEY_PATHS, SURVEY_WATER } from './ai-survey.js';

/** Op kinds of the factor chain. `acc` is `0x18(%edi)`, `score` the low half word of `0x1c`. */
export const enum ScoreOpKind {
 /** `acc = T[a][b]` */
  Load,
 /** `acc += T[a][b]` */
  Add,
 /** `acc += acc` */
  Double,
 /** `acc <<= a` */
  Shl,
 /** `acc >>= a` */
  Shr,
 /** `if (acc >= a) acc = b` */
  Clamp,
 /** `acc -= a`; remembers the borrow for a following {@link ScoreOpKind.VetoUnderflow}. */
  Sub,
 /** `acc += a` */
  AddImm,
 /** `acc = ~acc` */
  Not,
 /** `score = (score · acc) >> 16` */
  Mul,
 /** `score = 0` when `acc != 0` */
  VetoNonZero,
 /** `score = 0` when the last {@link ScoreOpKind.Sub} borrowed */
  VetoUnderflow,
 /**
  * An instruction that in the original writes to a **different** ctx slot and is therefore inert for
  * the chain: `shlw $0x2,0x14(%edi)` @0x5ddcd — `0x18` was evidently meant. Carried along so that the
  * op sequence stays checkable against the binary without gaps.
  */
  Inert,
 /** `sum = acc` — the second accumulator `0xc(%edi)`, used only by branch B's attack chains. */
  SumStore,
 /** `sum += acc` */
  SumAdd,
 /** `acc = sum` */
  AccFromSum,
 /** `acc += sum` */
  AccAddSum,
}

/** One op as a compact tuple — the table below holds over 900 of them. */
export type ScoreOp = readonly [kind: ScoreOpKind, a: number, b: number];

const L = (table: number, slot: number): ScoreOp => [ScoreOpKind.Load, table, slot];
const A = (table: number, slot: number): ScoreOp => [ScoreOpKind.Add, table, slot];
const DBL: ScoreOp = [ScoreOpKind.Double, 0, 0];
const SHL = (n: number): ScoreOp => [ScoreOpKind.Shl, n, 0];
const SHR = (n: number): ScoreOp => [ScoreOpKind.Shr, n, 0];
const C = (at: number, to: number): ScoreOp => [ScoreOpKind.Clamp, at, to];
const SUB = (c: number): ScoreOp => [ScoreOpKind.Sub, c, 0];
const ADD = (c: number): ScoreOp => [ScoreOpKind.AddImm, c, 0];
const NOT: ScoreOp = [ScoreOpKind.Not, 0, 0];
const MUL: ScoreOp = [ScoreOpKind.Mul, 0, 0];
const VETO_NZ: ScoreOp = [ScoreOpKind.VetoNonZero, 0, 0];
const VETO_UF: ScoreOp = [ScoreOpKind.VetoUnderflow, 0, 0];
const INERT: ScoreOp = [ScoreOpKind.Inert, 0, 0];
const SUM_SET: ScoreOp = [ScoreOpKind.SumStore, 0, 0];
const SUM_ADD: ScoreOp = [ScoreOpKind.SumAdd, 0, 0];
const ACC_SUM: ScoreOp = [ScoreOpKind.AccFromSum, 0, 0];
const ACC_ADD_SUM: ScoreOp = [ScoreOpKind.AccAddSum, 0, 0];

/**
 * Project id == **building type** for 0..24, plus 25 == the geologist. Probe branch B uses the same
 * table with ids 26..34 — the nine attack targets, see {@link ATTACK_CHAINS}.
 */
export const AI_PROJECT_GEOLOGIST = 25;
/** 0..24 building types + 25 geologist + 26..34 from branch B. */
export const AI_PROJECT_COUNT = 35;

/**
 * The factor chains of projects 1..23 and 25, with the shared sub-evaluators (`0x5ddc2`, `0x5e009`,
 * `0x5e194`) **inlined** at their call sites.
 *
 * Projects 0 and 24 are missing here because they branch — see {@link scoreFlagProject} and
 * {@link CASTLE_CHAIN_COMMON}.
 */
export const SCORE_CHAINS: Readonly<Record<number, readonly ScoreOp[]>> = {
 // Project 1 — `0x5e312`
  1: [
    L(1,1), C(2048,2047), SHL(4), NOT, MUL, L(2,2), C(900,899), SHL(6), NOT, MUL, L(1,2), C(1024,1023), SHL(5),
    NOT, MUL, L(3,17), SHL(3), A(2,17), C(128,127), SHL(8), SHL(1), NOT, MUL, L(2,14), C(32,31), SHL(8), SHL(3),
    NOT, MUL, L(3,5), SUB(80), VETO_UF, C(256,255), SHL(8), MUL, L(2,5), C(512,511), SHL(6), ADD(32767), MUL,
    L(1,5), C(1024,1023), SHL(4), ADD(49151), MUL, L(2,6), C(16,15), SHL(8), SHL(4), NOT, MUL,
  ],
 // Project 2 — `0x5e456`
  2: [
    L(1,1), C(2048,2047), SHL(4), NOT, MUL, L(2,2), C(900,899), SHL(6), NOT, MUL, L(1,2), C(1024,1023), SHL(5),
    NOT, MUL, L(3,17), SHL(3), A(2,17), C(128,127), SHL(8), SHL(1), NOT, MUL, L(2,14), C(32,31), SHL(8), SHL(3),
    NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), ADD(60415), MUL, L(3,14), SHL(3), A(2,14), SHL(1), A(1,14),
    C(256,255), SHL(6), ADD(49151), MUL, L(3,7), SHL(3), A(2,7), SHL(1), A(1,7), C(256,255), SHL(6), NOT, MUL,
    L(1,22), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(2,37), C(2000,1999), SHL(5), NOT, MUL, L(2,30),
    C(2048,2047), SHL(5), MUL,
  ],
 // Project 3 — `0x5e65b`
  3: [
    L(1,1), C(2048,2047), SHL(4), NOT, MUL, L(2,2), C(900,899), SHL(6), NOT, MUL, L(1,2), C(1024,1023), SHL(5),
    NOT, MUL, L(3,17), SHL(3), A(2,17), C(128,127), SHL(8), SHL(1), NOT, MUL, L(2,14), C(32,31), SHL(8), SHL(3),
    NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(3), ADD(24575), MUL, L(1,22), C(20,19), SHL(8), SHL(3),
    ADD(24575), MUL,
  ],
 // Project 4 — `0x5e70f`
  4: [
    L(1,1), C(2048,2047), SHL(4), NOT, MUL, L(2,2), C(900,899), SHL(6), NOT, MUL, L(1,2), C(1024,1023), SHL(5),
    NOT, MUL, L(3,17), SHL(3), A(2,17), C(128,127), SHL(8), SHL(1), NOT, MUL, L(2,14), C(32,31), SHL(8), SHL(3),
    NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), ADD(60415), MUL, L(2,32), C(256,255), SHL(8), MUL, L(3,9),
    VETO_NZ, L(2,9), C(32,31), SHL(8), SHL(4), NOT, MUL,
  ],
 // Project 5 — `0x5e81a`
  5: [
    L(1,1), C(4096,4095), SHL(2), NOT, MUL, L(2,2), DBL, DBL, L(1,2), C(8191,8190), SHL(3), NOT, MUL, L(1,15),
    A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(3,36), C(16,15), SHL(8), SHL(4), MUL, L(2,10),
    C(31,30), SHL(8), SHL(3), NOT, MUL,
  ],
 // Project 6 — `0x5e8bb`
  6: [
    L(1,1), C(4096,4095), SHL(2), NOT, MUL, L(2,2), DBL, DBL, L(1,2), C(8191,8190), SHL(3), NOT, MUL, L(1,15),
    A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(3,35), C(16,15), SHL(8), SHL(4), MUL, L(2,11),
    C(31,30), SHL(8), SHL(3), NOT, MUL,
  ],
 // Project 7 — `0x5e95c`
  7: [
    L(1,1), C(4096,4095), SHL(2), NOT, MUL, L(2,2), DBL, DBL, L(1,2), C(8191,8190), SHL(3), NOT, MUL, L(1,15),
    A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(3,34), C(16,15), SHL(8), SHL(4), MUL, L(2,12),
    C(31,30), SHL(8), SHL(3), NOT, MUL,
  ],
 // Project 8 — `0x5e9fd`
  8: [
    L(1,1), C(4096,4095), SHL(2), NOT, MUL, L(2,2), DBL, DBL, L(1,2), C(8191,8190), SHL(3), NOT, MUL, L(1,15),
    A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(3,33), C(16,15), SHL(8), SHL(4), MUL, L(2,13),
    C(31,30), SHL(8), SHL(3), NOT, MUL,
  ],
 // Project 9 — `0x5ea9e`
  9: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(2,14), SHL(4), A(1,14),
    C(256,255), SHL(8), NOT, MUL, L(3,7), SHL(3), A(2,7), SHL(1), A(1,7), C(256,255), SHL(7), ADD(32767), MUL,
    L(3,7), C(15,14), SHL(8), SHL(4), ADD(4095), MUL, L(1,22), C(20,19), SHL(8), SHL(1), ADD(55295), MUL,
    L(2,37), C(1024,1023), SHL(6), NOT, MUL, L(2,30), C(2048,2047), SHL(3), NOT, MUL,
  ],
 // Project 10 — `0x5ec98`
  10: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(2,15), DBL, A(1,15),
    A(1,29), C(30,29), SHL(8), SHL(3), NOT, MUL, L(2,2), DBL, A(2,1), VETO_NZ, L(1,2), DBL, A(1,1), C(511,510),
    SHL(7), NOT, MUL, L(0,2), DBL, A(0,1), C(4096,4095), SHL(4), NOT, MUL,
  ],
 // Project 11 — `0x5edfd`
  11: [
    L(3,1), A(3,2), C(127,126), SHL(8), SHL(1), ADD(511), MUL, L(2,1), A(2,2), C(500,499), SHL(7), ADD(1535),
    MUL, L(3,1), C(100,99), SHL(8), ADD(39935), MUL, L(2,1), C(500,499), SHL(6), ADD(33535), MUL, L(3,16),
    VETO_NZ, L(2,16), C(80,79), SHL(8), NOT, MUL,
  ],
 // Project 12 — `0x5ef9a`
  12: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(3,37), C(500,499), SHL(7),
    NOT, MUL, L(3,31), C(500,499), SHL(7), ADD(1535), MUL, L(2,17), C(30,29), SHL(8), SHL(3), NOT, MUL, L(1,20),
    C(40,39), SHL(8), SHL(1), ADD(45055), MUL, L(1,19), C(40,39), SHL(8), ADD(55295), MUL, L(1,18), A(1,21),
    C(40,39), SHL(6), ADD(62975), MUL,
  ],
 // Project 13 — `0x5f169`
  13: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,19), C(20,19), SHL(8),
    SHL(3), ADD(24575), MUL, L(1,17), C(20,19), SHL(8), SHL(1), ADD(55295), MUL, L(1,18), C(20,19), SHL(8),
    SHL(3), NOT, MUL,
  ],
 // Project 14 — `0x5f25f`
  14: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,17), C(20,19), SHL(8),
    SHL(3), ADD(24575), MUL, L(1,18), C(20,19), SHL(8), SHL(2), ADD(45055), MUL,
  ],
 // Project 15 — `0x5f308`
  15: [
    L(1,1), C(2048,2047), SHL(4), NOT, MUL, L(2,2), C(900,899), SHL(6), NOT, MUL, L(1,2), C(1024,1023), SHL(5),
    NOT, MUL, L(3,17), SHL(3), A(2,17), C(128,127), SHL(8), SHL(1), NOT, MUL, L(2,14), C(32,31), SHL(8), SHL(3),
    NOT, MUL, L(1,15), A(1,29), C(30,29), SHL(8), SHL(2), ADD(34815), MUL, L(1,17), C(20,19), SHL(8), SHL(3),
    ADD(24575), MUL, L(1,21), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,20), C(20,19), SHL(8), SHL(3), NOT,
    MUL,
  ],
 // Project 16 — `0x5f453`
  16: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,20), C(20,19), SHL(8),
    SHL(3), ADD(24575), MUL, L(1,17), C(20,19), SHL(8), SHL(1), ADD(55295), MUL, L(1,21), C(20,19), SHL(8),
    SHL(3), NOT, MUL,
  ],
 // Project 17 — `0x5f549`
  17: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,7), C(20,19), SHL(8),
    SHL(2), ADD(45055), MUL, L(1,14), C(20,19), SHL(8), SHL(1), ADD(55295), MUL, L(1,22), C(20,19), SHL(8),
    SHL(3), NOT, MUL,
  ],
 // Project 18 — `0x5f63f`
  18: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,12), C(26,25), SHL(8),
    SHL(3), ADD(12287), MUL, L(1,11), C(26,25), SHL(8), SHL(3), ADD(12287), MUL, L(2,23), C(20,19), SHL(8),
    SHL(3), NOT, MUL, L(1,24), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,25), C(20,19), SHL(8), SHL(2),
    ADD(45055), MUL,
  ],
 // Project 19 — `0x5f7c8`
  19: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,22), C(18,17), SHL(8),
    SHL(3), ADD(28671), MUL, L(1,23), C(18,17), SHL(8), SHL(3), ADD(28671), MUL, L(2,24), C(20,19), SHL(8),
    SHL(3), NOT, MUL,
  ],
 // Project 20 — `0x5f8bf`
  20: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,11), C(26,25), SHL(8),
    SHL(3), ADD(12287), MUL, L(1,23), C(22,21), SHL(8), SHL(3), ADD(20479), MUL, L(2,25), C(20,19), SHL(8),
    SHL(3), NOT, MUL,
  ],
 // Project 21 — `0x5f9b6`
  21: [
    L(2,2), SHL(2), A(2,1), C(950,949), SHL(6), NOT, MUL, L(0,2), SHL(2), A(0,1), C(4000,3999), SHL(3), NOT,
    MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16), C(110,109), SHL(8), SHL(1),
    ADD(9215), MUL, L(1,15), DBL, A(1,29), A(1,25), A(1,24), A(1,11), A(1,12), A(1,13), DBL, A(1,17), A(1,18),
    A(1,19), A(1,21), A(1,22), A(1,23), A(1,28), A(1,10), DBL, A(1,6), A(1,7), A(1,8), A(1,9), A(1,14), A(1,20),
    C(512,511), SHL(7), MUL,
  ],
 // Project 22 — `0x5fc44`
  22: [
    L(2,2), SHL(2), A(2,1), C(500,499), SHL(7), NOT, MUL, L(0,2), SHL(2), A(0,1), C(3000,2999), SHL(4), NOT,
    MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16), C(50,49), SHL(8), SHL(2),
    ADD(14335), MUL, L(1,15), DBL, A(1,29), A(1,25), A(1,24), A(1,11), A(1,12), A(1,13), DBL, A(1,17), A(1,18),
    A(1,19), A(1,21), A(1,22), A(1,23), A(1,28), A(1,10), DBL, A(1,6), A(1,7), A(1,8), A(1,9), A(1,14), A(1,20),
    C(512,511), SHL(7), MUL,
  ],
 // Project 23 — `0x5fed3`
  23: [
    L(3,2), INERT, A(2,2), SHL(2), A(2,1), C(4000,3999), SHL(4), NOT, MUL, L(0,2), SHL(2), A(0,1),
    C(20000,19999), SHL(1), NOT, MUL, L(3,27), DBL, A(3,26), A(2,27), DBL, A(3,16), A(2,26), DBL, A(2,16),
    C(110,109), SHL(8), ADD(37375), MUL, L(3,17), C(16,15), SHL(8), SHL(4), NOT, MUL, L(2,14), C(32,31), SHL(8),
    SHL(3), NOT, MUL, L(1,15), A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(1,13), C(26,25), SHL(8),
    SHL(3), ADD(12287), MUL, L(1,11), C(26,25), SHL(8), SHL(3), ADD(12287), MUL, L(2,28), C(20,19), SHL(8),
    SHL(3), NOT, MUL,
  ],
 // Project 25 — `0x5ffca`
  25: [
    L(1,1), C(4096,4095), SHL(2), NOT, MUL, L(2,2), DBL, DBL, L(1,2), C(8191,8190), SHL(3), NOT, MUL, L(1,15),
    A(1,29), C(20,19), SHL(8), SHL(2), ADD(45055), MUL, L(3,10), A(3,11), A(3,12), A(3,13), C(64,63), SHL(8),
    SHL(1), NOT, MUL, L(3,33), A(3,34), A(3,35), A(3,36), A(3,43), DBL, A(2,33), A(2,34), A(2,35), A(2,36),
    A(2,43), C(255,24), SHL(8), NOT, MUL,
  ],
};

/**
 * **Project 24 (castle), common part** — `0x60104..0x6053b`. After it the original branches on the
 * difficulty `player+0x162` (block 482, `difficulty`): `>= 15` adds **nothing** more, `8..14` the short
 * segment B, `< 8` the long segment A. So the weaker AI weighs the spot more finely than the strongest,
 * which plays faster and coarser.
 */
export const CASTLE_CHAIN_COMMON: readonly ScoreOp[] = [

  L(0,2), C(950,949), SHL(6), NOT, MUL, L(2,2), C(252,251), SHL(8), NOT, MUL, L(0,3), A(0,4), C(7000,6999),
  SHL(2), ADD(37535), MUL, L(0,5), C(160,159), SHL(7), ADD(45055), MUL, L(1,30), C(2048,2047), SHL(5), MUL,
  L(0,30), C(2048,2047), SHL(4), ADD(32767), MUL, L(2,31), C(2048,2047), SHL(5), MUL, L(0,31), C(6000,5999),
  SHL(2), ADD(41535), MUL, L(1,41), SHR(1), A(1,32), C(255,254), SHL(8), ADD(255), MUL, L(0,41), SHR(1),
  A(0,32), C(1024,1023), SHL(4), ADD(49151), MUL, L(1,32), C(64,63), SHL(8), SHL(2), MUL, L(0,38), C(250,249),
  SHL(8), ADD(1535), MUL, L(0,39), C(250,249), SHL(8), ADD(1535), MUL, L(0,40), C(500,499), SHL(7), ADD(1535),
  MUL, L(0,41), C(100,99), SHL(7), ADD(52735), MUL,
];

/** Extra factors for `difficulty < 8` — `0x6055b..0x6063c`, ends with a `jmp` to the chain end. */
export const CASTLE_CHAIN_EASY: readonly ScoreOp[] = [

  L(2,39), C(63,62), SHL(8), SHL(1), ADD(33279), MUL, L(2,40), C(127,126), SHL(8), ADD(33023), MUL, L(2,5),
  SHL(2), A(1,5), C(255,254), SHL(8), ADD(255), MUL,
];

/** Extra factors for `8 <= difficulty < 15` — `0x60641..0x606c9`, falls through to the chain end. */
export const CASTLE_CHAIN_MEDIUM: readonly ScoreOp[] = [

  L(1,39), C(127,126), SHL(8), ADD(33023), MUL, L(1,40), C(255,254), SHL(7), ADD(32895), MUL,
];

/** `cmpb $0xf,0x162(%ebx)` @0x6053e — from here on there are no extra factors. */
export const CASTLE_DIFFICULTY_HARD = 0xf;
/** `cmpb $0x8,0x162(%ebx)` @0x6054e — from here on only the short segment. */
export const CASTLE_DIFFICULTY_MEDIUM = 0x8;

/** Initial score — `mov $0xffffffff,%eax ; mov %eax,0x1c(%edi)`, used as 16-bit 1.0. */
export const SCORE_START = 0xffff;

/**
 * Evaluate one factor chain. A pure function of the four survey tables; the result is the 16-bit score,
 * `0` == "no candidate".
 */
export function runScoreChain(
  ops: readonly ScoreOp[],
  tables: readonly (readonly number[])[],
  startScore = SCORE_START,
): number {
  let score = startScore & 0xffff;
  let acc = 0;
 /**
  * The second accumulator `0xc(%edi)`. Only branch B uses it — and the **recorder overwrites it**
  * (`mov %eax,0xc(%edi)` @0x5dd45), so no chain may read it beyond its own run. None does: each sets
  * it afresh with {@link ScoreOpKind.SumStore}.
  */
  let sum = 0;
 /** CF of the last `subw` — the underflow veto reads exactly this flag. */
  let borrow = false;

  for (const [kind, a, b] of ops) {
    switch (kind) {
      case ScoreOpKind.Load:
 // Unsigned, like `mov 0xNN(%ebx),%ax`. `ai-survey` carries the counters as i16.
        acc = ((tables[a] as readonly number[])[b] ?? 0) & 0xffff;
        break;
      case ScoreOpKind.Add:
        acc = (acc + (((tables[a] as readonly number[])[b] ?? 0) & 0xffff)) & 0xffff;
        break;
      case ScoreOpKind.Double:
        acc = (acc + acc) & 0xffff;
        break;
      case ScoreOpKind.Shl:
        acc = (acc << a) & 0xffff;
        break;
      case ScoreOpKind.Shr:
        acc = (acc & 0xffff) >>> a;
        break;
      case ScoreOpKind.Clamp:
        if (acc >= a) acc = b;
        break;
      case ScoreOpKind.Sub:
        borrow = acc < a;
        acc = (acc - a) & 0xffff;
        break;
      case ScoreOpKind.AddImm:
        acc = (acc + a) & 0xffff;
        break;
      case ScoreOpKind.Not:
        acc = ~acc & 0xffff;
        break;
      case ScoreOpKind.Mul:
 // `mul %cx` + `rorl $0x10` == the high half word of the 32-bit product.
        score = ((score * acc) >>> 16) & 0xffff;
        break;
      case ScoreOpKind.VetoNonZero:
 // `or %ax,%ax ; je +8` @0x5e7ba — the zeroing runs when the counter is NOT zero.
        if (acc !== 0) score = 0;
        break;
      case ScoreOpKind.VetoUnderflow:
 // `subw $C ; jae +0xf` @0x5e331 — score 0 on underflow. The original also jumps to the chain end;
 // equivalent in effect, because every further factor stays 0.
        if (borrow) score = 0;
        break;
      case ScoreOpKind.Inert:
        break;
      case ScoreOpKind.SumStore:
        sum = acc;
        break;
      case ScoreOpKind.SumAdd:
        sum = (sum + acc) & 0xffff;
        break;
      case ScoreOpKind.AccFromSum:
        acc = sum;
        break;
      case ScoreOpKind.AccAddSum:
        acc = (acc + sum) & 0xffff;
        break;
    }
  }
  return score;
}

/**
 * `0x368 - 0x366 == 2` => index 1 of the "idle settlers per profession" table — the **sailor**.
 * Computed from the displacement, not guessed from the profession.
 */
export const AI_FLAG_SAILOR_SLOT = 1;
/** `0x3ac - 0x39c == 16` => index 8 of the stockpile table — the **boat**. */
export const AI_FLAG_BOAT_SLOT = 8;

/**
 * **Project 0 — the flag** (`0x5e298`). The only evaluator without a factor chain: three fixed scores
 * and six branches. The 40000 appears as such in real saves.
 *
 * ```
 * T0[1] + T0[2] != 0 → 0 # @0x5e2ae — herrenloses ODER fremdes Land liegt an
 * T0[37] == 0 -> 40000 # @0x5e2be — the pre-check head did not run at all
 * T0[37] != 0xffff → 0 # @0x5e2c5 — Kopf war erfolgreich (100) ⇒ nichts zu tun
 * T0[5] < 12 → 0 # @0x5e2cf
 * player[0x368] != 0 → 35000 # @0x5e2de
 * player[0x3ac] != 0 → 35000 # @0x5e2ed
 * sonst → 0
 * ```
 *
 * **The 35000 branch is the landing stage.** The two fields it reads lie **inside the census** —
 * `0x366 + 2 * 1` and `0x39c + 2 * 8`:
 *
 * | ASM | Feld | Index | Bedeutung |
 * |---|---|---|---|
 * | `mov 0x368(%ebx),%ax` @0x5e2d4 | `aiIdleSerfs` (Block 998, Basis `0x366`) | 1 | ruhende **Segler** |
 * | `mov 0x3ac(%ebx),%ax` @0x5e2e3 | `aiStockpile` (Block 1052, Basis `0x39c`) | 8 | **Boote** im Lager |
 *
 * So the branch reads cleanly: much water around (slot 5 >= 12) **and** a sailor or a boat available
 * => a flag for a water road pays off here. Without either the spot is worthless, because nobody could
 * cross the water.
 */
export function scoreFlagProject(survey: AiSurvey, player: Player): number {
  const t0 = survey.tables[0] as readonly number[];
  const at = (slot: number) => (t0[slot] ?? 0) & 0xffff;

 // `mov 0x2(%ebx),%ax` @0x5e29b + `mov 0x4(%ebx),%ax` @0x5e2a6 / `add %ax,0x18(%edi)` @0x5e2aa —
 // byte 2 and byte 4, i.e. slots 1 and 2. Both are read back against the scan body
 // (`FUN_00060baa`): unowned writes byte 2 (@0x60c12), own byte 0 (@0x60c1f), foreign byte 4
 // (@0x60c05). So the condition is "neither unowned nor foreign land around" — a connecting flag deep
 // inside one's own territory.
  if (((at(SURVEY_FREE_LAND) + at(SURVEY_FOREIGN_LAND)) & 0xffff) !== 0) return 0;
  const paths = at(SURVEY_PATHS);
  if (paths === 0) return 40000;
  if (paths !== 0xffff) return 0;
  if (at(SURVEY_WATER) < 12) return 0;
 // `mov 0x368(%ebx),%ax ; or %ax,%ax ; jne` @0x5e2d4 — idle sailors (census, index 1).
  if ((player.aiIdleSerfs[AI_FLAG_SAILOR_SLOT] ?? 0) !== 0) return 35000;
 // `mov 0x3ac(%ebx),%ax ; or %ax,%ax ; je 0x5e307` @0x5e2e3 — boats in store (index 8).
  if ((player.aiStockpile[AI_FLAG_BOAT_SLOT] ?? 0) !== 0) return 35000;
  return 0;
}

/**
 * **Project 24 — the castle** (`0x60104`): common chain, then an extra segment depending on the
 * difficulty. The score **continues** across the segments (the same `0x1c(%edi)`), so the segments are
 * a continuation, not a computation of their own.
 */
export function scoreCastleProject(survey: AiSurvey, player: Player): number {
  const chain = player.difficulty >= CASTLE_DIFFICULTY_HARD
    ? CASTLE_CHAIN_COMMON
    : player.difficulty >= CASTLE_DIFFICULTY_MEDIUM
      ? [...CASTLE_CHAIN_COMMON, ...CASTLE_CHAIN_MEDIUM]
      : [...CASTLE_CHAIN_COMMON, ...CASTLE_CHAIN_EASY];
  return runScoreChain(chain, survey.tables);
}

/**
 * The score of **one** project at the probed spot — the dispatcher over the three shapes (fixed values,
 * chain, chain with a difficulty tail). `0` means "no candidate".
 */
export function scoreProject(project: number, survey: AiSurvey, player: Player): number {
  if (project === 0) return scoreFlagProject(survey, player);
  if (project === 24) return scoreCastleProject(survey, player);
  const chain = SCORE_CHAINS[project];
  if (chain === undefined) return 0; // ids 26..34 (branch B) — see {@link scoreAttackTarget}
  return runScoreChain(chain, survey.tables);
}

// ── Branch B: the nine ATTACK TARGETS (ids 26..34) ─────────────────────────────────────────────

/** First id of branch B. `AI_ATTACK_FIRST .. AI_ATTACK_FIRST + 8` are the nine target kinds. */
export const AI_ATTACK_FIRST = 26;
/** The nine attack predicates. */
export const AI_ATTACK_COUNT = 9;
/**
 * The id whose predicate does **not** call the prologue (`FUN_0005d0f7` @0x5d0f7) — see
 * {@link scoreAttackTarget}.
 */
export const AI_ATTACK_NO_PROLOG = 28;

/**
 * **The shared prologue** `FUN_0005c9eb` @0x5c9eb: it sets the score to `0xffff` and applies five
 * factors that hold for **all** target kinds.
 *
 * The domain reading is independently confirmed: the first three terms are a **penalty** (`NOT`) for
 * the military buildings around, weighted `4*fortress + 4*castle + 2*tower + hut` — exactly their
 * **garrison capacity divided by 3** (12/12/6/3). The more strongly the area is occupied, the less
 * interesting the target. Then a **bonus** for nearby warehouses (weight 8/4/2/1 over the four radii,
 * strongest innermost) and one for own land at the largest radius.
 */
export const ATTACK_PROLOG_CHAIN: readonly ScoreOp[] = [
  L(2,27), A(2,29), DBL, A(2,26), DBL, A(2,16), C(200,199), SHL(8), NOT, MUL,
  L(1,27), A(1,29), DBL, A(1,26), DBL, A(1,16), C(350,349), SHL(7), NOT, MUL,
  L(0,27), A(0,29), DBL, A(0,26), DBL, A(0,16), C(600,599), SHL(6), NOT, MUL,
  L(3,15), DBL, A(2,15), DBL, A(1,15), DBL, A(0,15), C(140,139), SHL(7), ADD(47615), MUL,
  L(0,0), C(900,899), SHL(6), ADD(7935), MUL,
];

/**
 * The nine target chains, ids 26..34.
 *
 * Jede Kette summiert mehrere Vier-Radien-Terme im **zweiten** Akkumulator (`SUM_*`), klemmt
 * **once** and multiplies **once** — unlike the build-site chains, which multiply per factor. The
 * weights are throughout `8*T3 + 4*T2 + 2*T1 + T0`, so the innermost radius counts most.
 *
 * What the slots mean (building type == slot - 5, see `ai-survey.ts`) makes the intent readable:
 *
 * | Id | Slots | Target |
 * |---|---|---|
 * | 26 | coal mine, iron mine, steel smelter, **weaponsmith** | the weapons chain |
 * | 27 | plus toolmaker, lumberjack, forester, sawmill | the tools chain |
 * | 28 | coal mine, gold mine, **gold smelter** | the gold chain |
 * | 29 | fisher, farm, butcher, pig farm, mill, bakery | the food chain |
 * | 30 | lumberjack, stonecutter, forester, stone mine | the building material chain |
 * | 31..34 | Bodenproben-Schild + passende Mine | Gold-/Eisen-/Kohle-/Stein-Vorkommen |
 *
 * Mapping the sign slots 33..36 to gold/iron/coal/stone is not an assumption here: branch A's four
 * mine evaluators already fix it (projects 5..8 read 36/35/34/33), and here every deposit id reads
 * **the same** sign as the mine that builds on it.
 */
export const ATTACK_CHAINS: Readonly<Record<number, readonly ScoreOp[]>> = {
 // Id 26 — `0x5cd15`
  26: [
    L(3,11), DBL, A(2,11), DBL, A(1,11), DBL, A(0,11), SUM_SET,
    L(3,12), DBL, A(2,12), DBL, A(1,12), DBL, A(0,12), SUM_ADD,
    L(3,23), DBL, A(2,23), DBL, A(1,23), DBL, A(0,23), SUM_ADD,
    L(3,25), DBL, A(2,25), DBL, A(1,25), DBL, A(0,25), SUM_ADD,
    ACC_SUM, C(200,199), SHL(8), ADD(14335), MUL,
  ],
 // Id 27 — `0x5ce94`
  27: [
    L(3,11), DBL, A(2,11), DBL, A(1,11), DBL, A(0,11), SUM_SET,
    L(3,12), DBL, A(2,12), DBL, A(1,12), DBL, A(0,12), SUM_ADD,
    L(3,23), DBL, A(2,23), DBL, A(1,23), DBL, A(0,23), SUM_ADD,
    L(3,24), DBL, A(2,24), DBL, A(1,24), DBL, A(0,24), SUM_ADD,
    L(3,7), DBL, A(2,7), DBL, A(1,7), DBL, A(0,7), SUM_ADD,
    L(3,14), DBL, A(2,14), DBL, A(1,14), DBL, A(0,14), SUM_ADD,
    L(3,22), DBL, A(2,22), DBL, A(1,22), DBL, A(0,22), SUM_ADD,
    ACC_SUM, C(400,399), SHL(7), ADD(14335), MUL,
  ],
 // Id 28 — `0x5d0f7` — **without** the prologue call, see {@link scoreAttackTarget}.
  28: [
    L(3,11), DBL, A(2,11), DBL, A(1,11), DBL, A(0,11), SUM_SET,
    L(3,13), DBL, A(2,13), DBL, A(1,13), DBL, A(0,13), SUM_ADD,
    L(3,28), DBL, A(2,28), DBL, A(1,28), DBL, A(0,28), SUM_ADD,
    ACC_SUM, C(200,199), SHL(8), ADD(14335), MUL,
  ],
 // Id 29 — `0x5d225`
  29: [
    L(3,6), DBL, A(2,6), DBL, A(1,6), DBL, A(0,6), SUM_SET,
    L(3,17), DBL, A(2,17), DBL, A(1,17), DBL, A(0,17), SUM_ADD,
    L(3,18), DBL, A(2,18), DBL, A(1,18), DBL, A(0,18), SUM_ADD,
    L(3,19), DBL, A(2,19), DBL, A(1,19), DBL, A(0,19), SUM_ADD,
    L(3,20), DBL, A(2,20), DBL, A(1,20), DBL, A(0,20), SUM_ADD,
    L(3,21), DBL, A(2,21), DBL, A(1,21), DBL, A(0,21), SUM_ADD,
    ACC_SUM, C(400,399), SHL(7), ADD(14335), MUL,
  ],
 // Id 30 — `0x5d43c`
  30: [
    L(3,7), DBL, A(2,7), DBL, A(1,7), DBL, A(0,7), SUM_SET,
    L(3,9), DBL, A(2,9), DBL, A(1,9), DBL, A(0,9), SUM_ADD,
    L(3,14), DBL, A(2,14), DBL, A(1,14), DBL, A(0,14), SUM_ADD,
    L(3,10), DBL, A(2,10), DBL, A(1,10), DBL, A(0,10), SUM_ADD,
    ACC_SUM, C(200,199), SHL(8), ADD(14335), MUL,
  ],
 // Id 31 — `0x5d5bb` — gold: sign 33 + gold mine. Two shifts == `<< 9`.
  31: [
    L(3,33), DBL, A(2,33), DBL, A(1,33), DBL, A(0,33), SUM_SET,
    L(3,13), DBL, A(2,13), DBL, A(1,13), DBL, A(0,13), ACC_ADD_SUM,
    C(125,124), SHL(8), SHL(1), ADD(1535), MUL,
  ],
 // Id 32 — `0x5d69d` — iron: sign 34 + iron mine.
  32: [
    L(3,34), DBL, A(2,34), DBL, A(1,34), DBL, A(0,34), SUM_SET,
    L(3,12), DBL, A(2,12), DBL, A(1,12), DBL, A(0,12), ACC_ADD_SUM,
    C(250,249), SHL(8), ADD(1535), MUL,
  ],
 // Id 33 — `0x5d77c` — coal: sign 35 + coal mine.
  33: [
    L(3,35), DBL, A(2,35), DBL, A(1,35), DBL, A(0,35), SUM_SET,
    L(3,11), DBL, A(2,11), DBL, A(1,11), DBL, A(0,11), ACC_ADD_SUM,
    C(500,499), SHL(7), ADD(1535), MUL,
  ],
 // Id 34 — `0x5d85b` — stone: sign 36 + stone mine + the stone piles (slot 32), and it is the ONLY
 // one to read them from the middle radius alone: `mov 0x40(%ebx),%ax` @0x5d8fb hangs off that single
 // table pointer @0x5d8f8, so there is no four-radius term for it.
  34: [
    L(3,36), DBL, A(2,36), DBL, A(1,36), DBL, A(0,36), SUM_SET,
    L(3,10), DBL, A(2,10), DBL, A(1,10), DBL, A(0,10), ACC_ADD_SUM,
    A(2,32), C(250,249), SHL(8), ADD(1535), MUL,
  ],
};

/**
 * The score of **one** attack target kind at the probed spot.
 *
 * `carried` is the score still standing in `0x1c(%edi)` in the original. For eight of the nine ids it is
 * irrelevant, because their predicate starts with `call 0x5c9eb` and the prologue sets `0x1c(%edi)` to
 * `0xffff`. **Id 28 does not call the prologue** (its body starts with `mov 0x2c(%edi),%ebx` @0x5d0f7
 * while the other eight start with `e8 …`) — so it continues on id 27's score and additionally gets its
 * whole chain as a factor.
 *
 * That is an **original defect**, not intent: eight intact siblings against one exception, and the
 * prologue carries the shared military penalty, which 28 therefore takes twice. The sharp, testable
 * consequence is stated in {@link aiRecordAttackTargets}: the gold chain can only become a target if the
 * tools chain did too.
 */
export function scoreAttackTarget(
  project: number,
  survey: AiSurvey,
  carried: number,
): number {
  const chain = ATTACK_CHAINS[project];
  if (chain === undefined) return 0;
  const start = project === AI_ATTACK_NO_PROLOG
    ? carried
    : runScoreChain(ATTACK_PROLOG_CHAIN, survey.tables);
  return runScoreChain(chain, survey.tables, start);
}
