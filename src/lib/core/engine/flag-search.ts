/**
 * The search generations of the flag network. All nine network searches of the original draw a number
 * here and mark the flags they reach with it (`flag[0]`, `flag+2` alongside), so a flag counts as
 * visited when its `searchNum` equals the current number — nothing is cleared between searches. The
 * marks are part of the saved state: in every save the original wrote, the highest `searchNum` of any
 * flag equals the counter at `.DS`@98.
 *
 * A module of its own because searches in the flag scheduler, the serf movement and the AI use it,
 * and those modules import each other.
 */
import type { GameState } from './state.js';
import { u16 } from './int.js';

/**
 * `new_flag_search` `FUN_0001303f` @0x1303f — draw a new search generation. If the counter overflows it
 * is raised a second time and **all** flag marks are cleared (@0x1309e..@0x130bb). The routine also
 * zeroes the queue toggle `gs+0x270` (@0x130ea); the port keeps its BFS levels as arrays and has no
 * toggle to reset.
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

/**
 * Level cap shared by all nine network searches (`$0x3e2` in each of them, e.g. @0x4c054 in the demand
 * BFS): the count of fresh flags starts at −1 and the level ends once it reaches 994, so a level stops
 * after 995 fresh flags. Out of reach on every map of the corpus (at most 224 flags); kept because the
 * original has it.
 */
export const FLAG_BFS_LEVEL_BUDGET = 995;

