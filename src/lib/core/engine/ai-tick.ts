/**
 * The AI tick frame - the phase loop `@0xf9bb` and the state dispatcher `FUN_00051014`.
 *
 * The four phase slots of the economy table are the four PLAYERS (slots 1..16 are four byte-identical
 * copies of the same body), and they FALL THROUGH into each other: a player that fails the AI, active
 * or random gate bumps the rotation and drops into the next body. So when no AI passes the gate, the
 * original burns through all 16 slots in a single frame and resets the rotation. Progress per frame is
 * data dependent, not constant.
 *
 * What does NOT follow: that a later save's rotation could be recomputed from an earlier one. The DOS
 * frame loop is wall-clock driven, so the frame count between two saves is not a function of the tick
 * delta - a hit counter on the stored rotation measures nothing about the port.
 *
 * The activity rate `player+0x1ae` is a character trait, written once at game start as
 * `intelligence * 1300 + 13535`. Intelligence 40 exhausts the u16 at exactly 65535: the constants are
 * chosen so that "maximally intelligent" means "runs in every frame".
 *
 * The state dispatcher indexes a four-slot jump table on `player+0x1b4`:
 *
 * | State | Job |
 * |---|---|
 * | 0 | search for a castle site and found it |
 * | 1 | settling-in phase: probe only, for 24 ticks |
 * | 2 | steady state: probe on 7 of 8 ticks, a subtask on every 8th |
 * | 3 | bare `ret` - idle |
 */
import type { GameState, Player } from './state.js';
import { u16 } from './int.js';
import { aiProbeMap } from './ai-probe.js';
import { aiCandidateUpkeep } from './ai-candidate-upkeep.js';
import { aiRoadNetworkTask } from './ai-road-network.js';
import { aiBuildingRoundTask } from './ai-building-round.js';
import { AI_CANDIDATE_SLOTS } from './ai-candidates.js';
import { BUILD_CASTLE, classifyBuildSite, persistBuildSiteBits } from './build-site.js';
import { aiSurveySurroundings } from './ai-survey.js';
import { scoreProject } from './ai-score.js';
import { foundCastle } from './founding.js';
import { aiCensus } from './ai-census.js';
import { aiDecideBuild } from './ai-decide.js';
import { aiAttackTask } from './ai-attack-task.js';
import { aiPolicySubtask } from './ai-policy.js';

/** `player+2` bit 7 == AI player (`init_players` sets it at face < 0xc). */
const PLAYER_FLAG_AI = 1 << 7;
/** `player+2` bit 6 == slot occupied. */
const PLAYER_FLAG_ACTIVE = 1 << 6;

/** First phase slot of the player bodies: slot 0 is the goods distribution tick. */
export const AI_FIRST_PHASE_SLOT = 1;
/** Rotation at which the player bodies begin (`32 + AI_FIRST_PHASE_SLOT`). */
export const AI_FIRST_ROTATION = 33;

export const AI_STATE_FOUND_CASTLE = 0;
export const AI_STATE_SETTLE_IN = 1;
export const AI_STATE_RUNNING = 2;
export const AI_STATE_IDLE = 3;

/** `mov $0x18` @0x5c533 / @0x53cb — start of the settling-in countdown. */
export const AI_SETTLE_IN_TICKS = 0x18;

/** `mov $0x514,%ax` @0x6aad / `addw $0x34df,0x8(%edi)` @0x6ac8 — the rate formula's two constants. */
const AI_RATE_FACTOR = 0x514; // 1300
const AI_RATE_BASE = 0x34df; // 13535

/**
 * An AI character's activity rate from its intelligence — `@0x6aad`. In the original the multiplication
 * is 16x16->32 (`mul %cx`) followed by a 16-bit addition; at the highest intelligence 40 that yields
 * exactly 65535, so an overflow is unreachable. We clamp to u16 anyway, because the intelligence comes
 * from data rather than from a guarantee.
 */
export function aiCharacterRate(intelligence: number): number {
  return u16(u16(intelligence * AI_RATE_FACTOR) + AI_RATE_BASE);
}

/** Is this slot an active AI player? (the two `bt` tests at the head of every body) */
function isActiveAi(player: Player | null | undefined): player is Player {
  if (!player) return false;
  return (player.flags & PLAYER_FLAG_AI) !== 0 && (player.flags & PLAYER_FLAG_ACTIVE) !== 0;
}

/**
 * Threshold of the early-probe branch: `cmpw $0x32,0x4(%edi) ; jae 0xf8a1` @0xf7e1 against `gs+0x25e`
 * == `maxFlagIndex` (load site `mov 0x5a(%ebx),%ax ; mov %ax,0x25e(%ebx)` @0x47dd5 — `.DS`@90; the same
 * field is the loop bound of the flag scheduler @0x4b8d3).
 */
const AI_EARLY_PROBE_FLAG_LIMIT = 0x32;

/**
 * **The early-probe branch of the entity rotations** — `advance_frame_rotation` @0xf787, branch
 * `rotation < 32` (@0xf7c5…@0xfc20). It is the counterpart to the phase loop below: as long as the
 * world has **fewer than 50 flags**, in every frame **one** additional player probes the map — which
 * one is `rotation & 3`. So an AI finds its castle site quickly in the opening phase without waiting
 * for its rare phase slot; once the settlement stands the branch dries up on its own.
 *
 * The four bodies @0xfb45/@0xfb7c/@0xfbb3/@0xfbea are copies again and differ only in the `gs` offset
 * of the player pointer (0x64/0x68/0x6c/0x70). The index is `(rotation - 32) & 3`, and because
 * `-32 == 0 (mod 4)` that is the same as `rotation & 3` (`subw $0x20` @0xf7bb affects only the working
 * copy; `gs+0x26c` was already stored @0xf7b4).
 *
 * The gate `gs+0x1fe == 0 => ret` @0xf7c8 is not reproduced, as elsewhere in this module — a halted
 * simulation does not tick here at all.
 */
export function runAiEarlyProbe(state: GameState): void {
  if (state.rotation >= 32) return;
  // `mov 0x25e(%ebx),%ax` @0xf7d6 loads `maxFlagIndex`, NOT the array length: `state.flags` is
  // slot-indexed and densified on load, so it is `maxFlagIndex + 1` long (measured on real saves:
  // 120/119, 170/169, 91/90). With `flags.length` the branch would switch off one slot too early —
  // at `maxFlagIndex == 49` one probe plus its two RNG draws would be lost per frame.
  if (state.header.maxFlagIndex >= AI_EARLY_PROBE_FLAG_LIMIT) return; // `jae 0xf8a1` @0xf7e6
  const player = state.players[state.rotation & 3];
  if (!isActiveAi(player)) return; // the two `bt` tests at the head of every body
  aiProbeMap(state, player); // `call 0x5c54a`
}

/**
 * **The phase loop** — the sweep over the four player bodies including the fall-through and the loop
 * `@0xfb17`. To be called at the frame boundary when `state.rotation >= 33`.
 *
 * Order and number of RNG draws are binding: a draw happens **only** for players carrying both bits,
 * and **once per sweep pass** — with four passes up to the wrap a single AI player therefore gets four
 * chances per frame.
 */
export function runAiPhaseSweep(state: GameState): void {
  const wrap = state.rotationWrap > 0 ? state.rotationWrap : 49;
  // slot = rotation - 32 (1..16); the body belongs to player ((slot - 1) & 3). Slot 1 -> @0xf9bb
  // (player 0), slot 5 -> @0xf9bb again, and so on.
  let slot = state.rotation - 32;
  if (slot < AI_FIRST_PHASE_SLOT) return;
  let index = (slot - AI_FIRST_PHASE_SLOT) & 3;

  for (;;) {
    const player = state.players[index];
    if (isActiveAi(player)) {
      // `call 0x4e1e9` @0xf9ec — the draw happens before the comparison, and also when the gate
      // closes. The comparison is 16-bit (`cmp %ax,0x1c(%edi)` @0xf9fb, `jae` = unsigned).
      if (state.rng.next() < player.aiRate) {
        aiPlayerTick(state, player); // `call 0x51014` @0xfa01 — the rotation stays put
        return;
      }
    }
    state.rotation = u16(state.rotation + 1); // `addw $0x1,0x26c(%ebx)` @0xfa0a
    index += 1;
    if (index < 4) continue; // fall through into the next body
    // Behind the fourth body: @0xfb17.
    if (state.rotation === wrap) {
      state.rotation = 0; // `xor %ax,%ax` @0xfb37
      return;
    }
    index = 0; // `jne 0xf9bb` @0xfb31 — start over
  }
}

/**
 * **The state dispatcher** — `FUN_00051014` @0x51014.
 *
 * The gate `if (gs+0x1fe == 0) return` @0x51017 is not reproduced: `gs+0x1fe` is the global
 * "simulation running" flag (the same test gates the entity drivers at `@0xf7c8`; written only by
 * `@0x40af`/`@0x3ecd0`/`@0x3ece3`), and here a halted simulation does not tick at all — this call is
 * then unreachable.
 */
export function aiPlayerTick(state: GameState, player: Player): void {
  // OPEN @0x51017 — `mov 0x1fe(%ebx),%eax ; or ; je 0x51021`: the original returns without effect
  // when the global "simulation running" flag `gs+0x1fe` is 0. Deliberately not reproduced, see the
  // doc comment above.
  switch (player.aiState) {
    case AI_STATE_FOUND_CASTLE:
      aiFoundCastleState(state, player);
      return;
    case AI_STATE_SETTLE_IN:
      aiSettleInState(state, player);
      return;
    case AI_STATE_RUNNING:
      aiRunningState(state, player);
      return;
    case AI_STATE_IDLE:
      return; // @0x510e0 — bare `ret`
    default:
      // The table @0x51040 has exactly four slots (the stub pattern ends after them); a larger value
      // would come out as a wild jump in the original. It occurs in no save.
      return;
  }
}

/**
 * The castle's project id. The original addresses its candidate list as `player+0x8b4` (@0x5c409,
 * @0x5c4fb) — which is exactly row 24 of the table: `0x434 + 24 * 48 == 0x8b4`. That arithmetic works
 * out exactly and is a second, independent confirmation of the base and stride in `ai-candidates.ts`.
 */
const AI_PROJECT_CASTLE = 24;

/** Bounds of the time ramp in state 0 (`cmpw` @0x5c3ad/@0x5c3b8/@0x5c3c4/@0x5c3d8). */
const RAMP_SILENT_UNTIL = 0x7d0; // 2000
const RAMP_ALWAYS_FROM = 0x2710; // 10000
const RAMP_BAND_1_UNTIL = 0x1770; // 6000  -> mask 0x3f (1 in 64)
const RAMP_BAND_2_UNTIL = 0x2328; // 9000  -> mask 0x1f (1 in 32)

/**
 * **State 0 — search for a castle site** (`@0x5c39b`).
 *
 * The head is a time ramp: before tick 2000 nothing happens, from tick 10000 every pass, and in between
 * a random draw with a mask that depends on game time decides. So the AI founds its castle after a
 * random delay that becomes ever more likely as time passes.
 */
function aiFoundCastleState(state: GameState, player: Player): void {
  aiProbeMap(state, player); // `call 0x5c54a` @0x5c39b — the map probe

  const tick = state.gameTick;
  if (tick < RAMP_SILENT_UNTIL) return; // `jb 0x5c549` @0x5c3b2 — bare `ret`
  if (tick < RAMP_ALWAYS_FROM) {
    // `call 0x4e1e9` @0x5c3bf — drawn only inside the ramp.
    const roll = state.rng.next();
    const mask =
      tick < RAMP_BAND_1_UNTIL ? 0x3f : tick < RAMP_BAND_2_UNTIL ? 0x1f : 0x0f;
    if ((roll & mask) !== 0) return; // `jne 0x5c549` — not this time
  }

  // From @0x5c403: try the eight castle candidates in turn, best first.
  const slots = player.aiCandidates[AI_PROJECT_CASTLE];
  if (slots === undefined) return;

  for (;;) {
    // ── @0x5c403: maximum over the eight 6-byte slots (score, column, row) ──────────────────────
    let best = 0; // ctx[0x04], `mov $0x0` @0x5c419
    let bestIndex = -1; // ctx[0x24] — a pointer in the original, untouched when the maximum is 0
    for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) {
      // `cmp %ax,0x4(%edi) ; jae 0x5c440` @0x5c427 — taken only on a **strictly** greater value, so a
      // slot with score 0 can never win. That is also what terminates the outer loop.
      const score = slots[i]?.score ?? 0;
      if (best < score) {
        best = score;
        bestIndex = i;
      }
    }
    if (best === 0) return; // `or %ax,%ax ; je 0x5c549` @0x5c451 — no candidate left
    const slot = slots[bestIndex];
    if (slot === undefined) return;

    // ── @0x5c457: the candidate is CONSUMED ────────────────────────────────────────────────────
    // Its score drops to 0 so the next round takes the runner-up. The pointer to it survives the three
    // following calls in the scratch field `gs+0x254` (@0x5c45d -> @0x5c4e3).
    slot.score = 0; // `xor %ax,%ax ; mov %ax,(%ebx)` @0x5c469
    player.cursorCol = slot.col; // `mov %ax,0xfc(%ebx)` @0x5c476
    player.cursorRow = slot.row; // `mov %ax,0xfe(%ebx)` @0x5c487

    // `call 0x32075` @0x5c491 — the classifier itself, not the position entry 0x31fc9; the cursor is
    // already set. The original writes the two `player+3` bits along the way.
    const site = classifyBuildSite(state, player, slot.col, slot.row);
    persistBuildSiteBits(player, site);
    // `cmpb $0x5,0x101(%ebx) ; jne 0x5c403` @0x5c499 — only a real castle site counts; otherwise back
    // to the maximum search and on to the next candidate.
    if (site.possibility !== BUILD_CASTLE) continue;

    // `call 0x606d2` @0x5c4a6 — the survey reads the possibility from `player+0x101`, i.e. 5.
    const survey = aiSurveySurroundings(state, player, site.possibility);
    // @0x5c4ab..@0x5c4d8 push the four survey tables (`player+0x1dc/0x234/0x28c/0x2e4`) as arguments;
    // here that is the `survey` object. Then `call 0x60104` @0x5c4db.
    const score = scoreProject(AI_PROJECT_CASTLE, survey, player);

    // ── @0x5c4ec: the comparison is against the score **of the consumed slot** ──────────────────
    // Through @0x5c469 that is 0 right now, so the comparison always holds — the else branch below is
    // structurally unreachable. Evidence that the pointer is the same one: `gs+0x254` has exactly three
    // writer/reader pairs in the whole binary (@0x5407c/@0x542aa, @0x55126/@0x5521e,
    // @0x5c45d/@0x5c4e3), all three save/restore within **one** routine — none of the three intervening
    // calls touches it. The branch is reproduced anyway: it costs nothing, and were the reading wrong
    // its absence would be expensive.
    let found = score >= slot.score; // `cmp %ax,0x1c(%edi) ; jae 0x5c525` @0x5c4f2
    if (!found) {
      // @0x5c4f8: if any other slot beats the freshly computed value, that value is written into the
      // consumed slot (@0x5c400) and the maximum search starts over.
      found = true;
      for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) {
        if (score < (slots[i]?.score ?? 0)) {
          found = false; // `jb 0x5c3f9` @0x5c515
          break;
        }
      }
      if (!found) {
        slot.score = score;
        continue;
      }
    }

    // ── @0x5c525: found ────────────────────────────────────────────────────────────────────────
    // Order as in the original: the state change first, then the founding.
    player.aiState = AI_STATE_SETTLE_IN; // `mov $0x1` @0x5c525
    player.aiCounter = AI_SETTLE_IN_TICKS; // `mov $0x18` @0x5c533
    // `call 0x28dde` @0x5c544 == `found_castle`; it reads the spot from `player+0xfc/0xfe`.
    foundCastle(state, player, player.cursorCol, player.cursorRow, site.levelingHeight, player.difficulty);
    return;
  }
}

/**
 * **State 1 — settling in** (`@0x5c35f`). Probes like the steady state, but also counts a countdown
 * down and switches to the steady state at 0.
 */
function aiSettleInState(state: GameState, player: Player): void {
  aiProbeMap(state, player); // `call 0x5c54a` @0x5c35f
  player.aiCounter = u16(player.aiCounter - 1); // `subw $0x1,0x1b6(%ebx)` @0x5c367
  if (player.aiCounter !== 0) return; // `jne 0x5c39a` @0x5c36f
  player.aiState = AI_STATE_RUNNING; // `mov $0x2` @0x5c371
  player.aiCounter = 0xffff; // `mov $0xffff` @0x5c37f
  // `xor %ax,%ax` @0x5c38d + `mov %ax,0x1b8(%ebx)` @0x5c393 — **the catch-up pressure is zeroed.**
  // `player+0x1b8` is block 568 == {@link Player.aiPressureCatchUp}; without this the settling-in
  // phase's value would keep running in the steady state.
  player.aiPressureCatchUp = 0;
}

/** How many of the 16 slots the subtask table `@0x51121` has. */
export const AI_SUBTASK_SLOTS = 16;

/**
 * **The subtask table `@0x51121`** — 16 slots, stride 8, but only **seven** distinct targets: the
 * schedule is weighted. Kept as data so that it can be checked slot by slot against the binary.
 *
 * The index is `aiCounter & 0x78` — in the original **directly** the byte offset (the mask does not
 * shift bits 3..6 back), i.e. slot `(aiCounter >> 3) & 0xf`.
 */
export const AI_SUBTASK_TABLE: readonly number[] = [
  0x5af31, 0x5ba0c, 0x51221, 0x52271, 0x53a09, 0x5ba0c, 0x51221, 0x5155b,
  0x5325f, 0x5ba0c, 0x51221, 0x51221, 0x53a09, 0x5ba0c, 0x51221, 0x5155b,
];

/** Entry of the census — slots 1/5/9/13, i.e. 4 of 16 appointments. */
export const AI_SUBTASK_CENSUS = 0x5ba0c;

/** Entry of the build decider — slots 2/6/10/11/14, i.e. 5 of 16 appointments (the most frequent). */
export const AI_SUBTASK_DECIDE = 0x51221;

/** Entry of the military/distribution policy — slot 0, i.e. 1 of 16 appointments. */
export const AI_SUBTASK_POLICY = 0x5af31;
/** Slots 4/12 — the attack task `FUN_00053a09`. */
export const AI_SUBTASK_ATTACK = 0x53a09;

/** Slot 8 — the candidate row upkeep `FUN_0005325f`. */
export const AI_SUBTASK_UPKEEP = 0x5325f;

/** Slots 7/15 — the road network extension `FUN_0005155b`. */
export const AI_SUBTASK_ROAD_NET = 0x5155b;

/** Slot 3 — the building round `FUN_00052271`. */
export const AI_SUBTASK_BUILDING_ROUND = 0x52271;

/**
 * **State 2 — steady state** (`@0x510e1`). The counter runs up; its lower three bits decide between a
 * probe (7 of 8 ticks) and a subtask, and for a subtask bits 3..6 pick one of the 16 slots of the table
 * `@0x51121`.
 *
 * The 16 slots point at **seven** distinct bodies, so the schedule is weighted: `0x51221`
 * (slots 2/6/10/11/14) · `0x5ba0c` (1/5/9/13) · `0x53a09` (4/12) · `0x5155b` (7/15) · `0x5af31` (0) ·
 * `0x52271` (3) · `0x5325f` (8).
 */
function aiRunningState(state: GameState, player: Player): void {
  player.aiCounter = u16(player.aiCounter + 1); // `addw $0x1,0x1b6(%ebx)` @0x510e4
  if ((player.aiCounter & 7) !== 0) {
    aiProbeMap(state, player); // `jne 0x5c54a` @0x510fd — 7 of 8 ticks (a tail jump in the original)
    return;
  }
  // @0x51110..@0x5111f — the mask yields the byte offset directly, slot == offset / 8.
  const slot = (player.aiCounter & 0x78) >> 3;
  switch (AI_SUBTASK_TABLE[slot]) {
    case AI_SUBTASK_CENSUS:
      // Slots 1/5/9/13 — the census fills the input tables of every evaluator.
      aiCensus(state, player);
      return;
    case AI_SUBTASK_DECIDE:
      // Slots 2/6/10/11/14 — the build decider. Its return value is `gs+0x27a`; it calls the consumer
      // (`FUN_00054fd9` -> `ai-execute.ts`) itself at its three original sites.
      aiDecideBuild(state, player);
      return;
    case AI_SUBTASK_POLICY:
      // Slot 0 — military and distribution policy: occupation, garrison target, recruiting, all
      // distribution sliders. Draws **one** random number (`call 0x4e1e9` @0x546ea).
      aiPolicySubtask(state, player);
      return;
    case AI_SUBTASK_ATTACK:
      // Slots 4/12 — the attack. It draws up to **two** random numbers (gate @0x53b97 and coin flip
      // @0x53e6d) and on failure ends in a tail jump to the probe, which draws itself.
      aiAttackTask(state, player);
      return;
    case AI_SUBTASK_UPKEEP:
      // Slot 8 — candidate row upkeep: devalue stale build sites and attack targets. Draws **no**
      // random number (the whole range `[0x5325f,0x539e7)` contains no `call 0x4e1e9`), so it does not
      // shift the random stream.
      aiCandidateUpkeep(state, player);
      return;
    case AI_SUBTASK_ROAD_NET:
      // Slots 7/15 — road network extension: reconnect lost spots, then continue the flag sweep. Draws
      // no random number itself, **but can end in a tail call to the probe** (@0x51c27, when fewer than
      // two runners are idle) — and that one draws twice.
      aiRoadNetworkTask(state, player);
      return;
    case AI_SUBTASK_BUILDING_ROUND:
      // Slot 3 — the building round: check own buildings in turn, tear down unproductive ones and set
      // the warehouse menus. Draws **no** random number (the `call` census over `[0x52271,0x5325f)`
      // names only `0x44703`, `0x44a52`, `0x48eb8` and the shared demolition tail `0x531f2`).
      aiBuildingRoundTask(state, player);
      return;
    default:
      return;
  }
}
