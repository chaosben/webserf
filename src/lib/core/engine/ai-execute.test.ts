import { describe, expect, it } from 'vitest';
import {
  AI_CANDIDATE_SLOTS,
  AI_CATCHUP_BASE,
  AI_CATCHUP_LAND_CLAMP,
  AI_FLAG_ATTACH_THRESHOLD,
  AI_LARGE_TASK_SET,
  AI_MASK_FLAG,
  AI_MASK_LARGE,
  AI_MASK_MINE,
  AI_MASK_SMALL_OR_LARGE,
  AI_SINGLE_SCORE_DISPATCH,
  AI_TASK_FLAG,
  AI_TASK_GEOLOGIST,
  AI_TASK_TO_CANDIDATE_ROW,
  aiApplyBuildCatchUp,
  aiBuildForm,
  aiExecuteBuildTask,
} from './ai-execute.js';
import { classifyBuildSite } from './build-site.js';
import { aiSurveySurroundings } from './ai-survey.js';
import { scoreProject } from './ai-score.js';
import type { GameState, Player } from './state.js';
import { Rng } from './rng.js';
import { mapGeometry, posOf } from './position.js';

const GEO = mapGeometry(3);

function candidates(): { score: number; col: number; row: number }[][] {
  return Array.from({ length: 35 }, () =>
    Array.from({ length: 8 }, () => ({ score: 0, col: 0, row: 0 })),
  );
}

function player(over: Partial<Player> = {}): Player {
  return {
    slot: 0,
    flags: 0x1, // castle founded — otherwise the geologist task goes into the castle branch
    build: 0,
    cursorCol: 0,
    cursorRow: 0,
    totalLandScore: 0,
    aiPressureCatchUp: 0,
    aiCandidates: candidates(),
    aiRoadJob540: 0,
    aiRoadJob542: 0,
    aiRoadJob548: 0,
    aiRoadJob552: 0,
    aiRoadJob570: 0,
    completedBuildingCount: new Array<number>(23).fill(0),
    incompleteBuildingCount: new Array<number>(23).fill(0),
    difficulty: 0,
    ...over,
  } as unknown as Player;
}

/**
 * A synthetic map: everything belongs to the OPPONENT (owner 2), only `(col,row)` to the player.
 * Exactly that situation gives the flag score 40000 — the survey then sees neither own nor free
 * land (see `scoreFlagProject`), and without roads the road slot is 0 as well.
 */
function lonelyMap(
  col: number,
  row: number,
  terrainUp: number,
  terrainDown: number,
  otherOwner = 2,
): GameState {
  const tiles = Array.from({ length: GEO.cols * GEO.rows }, () => ({
    paths: 0,
    blocked: false,
    height: 10,
    owner: otherOwner,
    terrainUp: 4,
    terrainDown: 4,
    object: 0,
    objIndex: 0,
    serf: 0,
    mineral: 0,
    resourceAmount: 0,
  }));
  for (const t of tiles) {
    t.terrainUp = terrainUp;
    t.terrainDown = terrainDown;
  }
  tiles[posOf(col, row, GEO)]!.owner = 1;
  return {
    mapTiles: tiles,
    buildings: [null],
    flags: [null],
    serfs: [null],
    inventories: [null],
    geo: GEO,
    header: { warehouseLimit: 361, maxFlagIndex: 1, maxBuildingIndex: 1, maxSerfIndex: 1 },
    blockMeta: {
      serfs: { maxIndex: 1 }, flags: { maxIndex: 1 },
      buildings: { maxIndex: 1 }, inventories: { maxIndex: 1 },
    },
    rng: new Rng([1, 2, 3]),
    gameTick: 0,
  } as unknown as GameState;
}

describe('AI build executor — the head', () => {
  it('maps every task onto build form, mask and candidate row', () => {
    const p = player();
    // Small buildings: the 'small or large' mask.
    expect(aiBuildForm(p, 1)).toEqual({ sizeClass: 2, mask: AI_MASK_SMALL_OR_LARGE, row: 1 });
    // The four mines 5..8 want mountains.
    for (const task of [5, 6, 7, 8]) {
      expect(aiBuildForm(p, task)).toEqual({ sizeClass: 2, mask: AI_MASK_MINE, row: task });
    }
    expect(aiBuildForm(p, 9)).toEqual({ sizeClass: 2, mask: AI_MASK_SMALL_OR_LARGE, row: 9 });
    // Large buildings.
    for (const task of [10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23]) {
      expect(aiBuildForm(p, task)).toEqual({ sizeClass: 3, mask: AI_MASK_LARGE, row: task });
    }
    // The mill 15 is NOT large.
    expect(aiBuildForm(p, 15).mask).toBe(AI_MASK_SMALL_OR_LARGE);
    // Flag and geologist.
    expect(aiBuildForm(p, AI_TASK_FLAG)).toEqual({ sizeClass: -1, mask: AI_MASK_FLAG, row: 0 });
    expect(aiBuildForm(p, AI_TASK_GEOLOGIST)).toEqual({ sizeClass: 0, mask: AI_MASK_MINE, row: 25 });
  });

  it('sends the geologist task without a castle into the castle branch (row 24, large area)', () => {
    const p = player({ flags: 0 });
    expect(aiBuildForm(p, AI_TASK_GEOLOGIST)).toEqual({
      sizeClass: 3, mask: AI_MASK_LARGE, row: 24,
    });
  });

  it('has exactly one negative build form — its sign selects the flag exit', () => {
    const p = player();
    const negatives = [];
    for (let task = 1; task <= 25; task++) if (aiBuildForm(p, task).sizeClass < 0) negatives.push(task);
    expect(negatives).toEqual([AI_TASK_FLAG]);
  });

  it('the bitset for tasks 1..23 coincides with LARGE_TYPES', () => {
    const fromBitset = [];
    for (let t = 1; t <= 23; t++) if (((AI_LARGE_TASK_SET >>> t) & 1) !== 0) fromBitset.push(t);
    expect(fromBitset).toEqual([10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it('converts the two special cases into their candidate row', () => {
    expect(AI_TASK_TO_CANDIDATE_ROW(AI_TASK_FLAG)).toBe(0);
    expect(AI_TASK_TO_CANDIDATE_ROW(AI_TASK_GEOLOGIST)).toBe(25);
    for (let t = 1; t <= 23; t++) expect(AI_TASK_TO_CANDIDATE_ROW(t)).toBe(t);
  });
});

describe('AI build executor — the compacted dispatch table', () => {
  it('has 34 slots and omits the castle id 24', () => {
    expect(AI_SINGLE_SCORE_DISPATCH).toHaveLength(34);
    expect(AI_SINGLE_SCORE_DISPATCH).not.toContain(24);
    // Up to 23 row and id are equal, after that they diverge by one.
    for (let row = 0; row <= 23; row++) expect(AI_SINGLE_SCORE_DISPATCH[row]).toBe(row);
    expect(AI_SINGLE_SCORE_DISPATCH[24]).toBe(25);
    expect(AI_SINGLE_SCORE_DISPATCH[25]).toBe(26);
    expect(AI_SINGLE_SCORE_DISPATCH[33]).toBe(34);
  });
});

describe('AI build executor — the catch-up pressure of the building exit', () => {
  it('computes 0x3000 - 2*min(land score, 0xfff)', () => {
    for (const land of [0, 1, 0x800, 0xffe, 0xfff]) {
      const p = player({ totalLandScore: land });
      aiApplyBuildCatchUp(p);
      expect(p.aiPressureCatchUp).toBe(AI_CATCHUP_BASE - 2 * land);
    }
  });

  it('clamps the land score so the term never goes negative', () => {
    for (const land of [0x1000, 0x1800, 0x4000, 0xffff]) {
      const p = player({ totalLandScore: land });
      aiApplyBuildCatchUp(p);
      expect(p.aiPressureCatchUp).toBe(AI_CATCHUP_BASE - 2 * AI_CATCHUP_LAND_CLAMP);
      expect(p.aiPressureCatchUp).toBeGreaterThan(0);
    }
  });

  it('saturates at 0xffff instead of overflowing', () => {
    const p = player({ totalLandScore: 0, aiPressureCatchUp: 0xf000 });
    aiApplyBuildCatchUp(p);
    expect(p.aiPressureCatchUp).toBe(0xffff);
  });
});

/**
 * The FLAG exit is unreachable from real save games (no own tile there yields a score). It is
 * therefore exercised on a synthetic situation: a single own tile inside foreign land, where
 * `scoreFlagProject` gives its 40000.
 */
describe('AI build executor — the flag exit', () => {
  /** Search for the terrain combination that yields possibility 1 (flag only) instead of guessing. */
  function flagSite(): { st: GameState; p: Player; col: number; row: number } | null {
    // The flag is placed DEEP inside own territory: the evaluator rejects as soon as unowned or
    // foreign land lies in the surroundings (@0x5e2ae, slots 1 and 2). Hence `otherOwner = 1`. And
    // `terrainDown` in 8..10 skips the pre-check head (`jb 0x61160` @0x610a8), leaving slot 37 at 0
    // — the only way to the 40000, and every stored original candidate of row 0 carries exactly
    // that value.
    for (const [up, down] of [[4, 9], [9, 9], [4, 8], [4, 10]] as const) {
      const col = 20;
      const row = 20;
      const st = lonelyMap(col, row, up, down, 1);
      const p = player({ cursorCol: col, cursorRow: row });
      const site = classifyBuildSite(st, p, col, row);
      if (site.possibility !== 1 || site.cursorType < 5) continue;
      const survey = aiSurveySurroundings(st, p, site.possibility);
      if (scoreProject(0, survey, p) === 0) continue;
      return { st, p, col, row };
    }
    return null;
  }

  it('places exactly one flag and leaves the road-still-missing marker behind', () => {
    const found = flagSite();
    expect(found).not.toBeNull();
    const { st, p, col, row } = found!;
    const line = p.aiCandidates[0]!;
    line[0]!.score = 40000;
    line[0]!.col = col;
    line[0]!.row = row;

    aiExecuteBuildTask(st, p, AI_TASK_FLAG);

    expect(st.flags.filter((f) => f)).toHaveLength(1);
    expect(st.mapTiles[posOf(col, row, GEO)]!.object).toBe(1);
    // Score 40000 > 38000 => the expensive branch: bit 4 cleared, 548 = 6.
    expect(40000).toBeGreaterThanOrEqual(AI_FLAG_ATTACH_THRESHOLD);
    expect(p.build & 0x10).toBe(0);
    expect(p.aiRoadJob548).toBe(6);
    expect(p.aiRoadJob542).toBe(0xffff);
    expect(line[0]!.score).toBe(0); // consumed
  });

  it('does nothing on an empty candidate row', () => {
    const st = lonelyMap(20, 20, 4, 4);
    const p = player();
    aiExecuteBuildTask(st, p, AI_TASK_FLAG);
    expect(st.flags.filter((f) => f)).toHaveLength(0);
  });

  it('consumes all eight slots when none passes the checks', () => {
    const st = lonelyMap(20, 20, 4, 4); // plain grass => possibility != 1, the mask rejects
    const p = player();
    const line = p.aiCandidates[0]!;
    for (let i = 0; i < AI_CANDIDATE_SLOTS; i++) {
      line[i]!.score = 100 + i;
      line[i]!.col = 20 + i;
      line[i]!.row = 20;
    }
    aiExecuteBuildTask(st, p, AI_TASK_FLAG);
    expect(line.map((s) => s.score)).toEqual(new Array<number>(AI_CANDIDATE_SLOTS).fill(0));
    expect(st.flags.filter((f) => f)).toHaveLength(0);
  });
});

describe('AI build executor — the measured limit of the geologist row', () => {
  it('stays without effect because the compacted table points at id 26 (branch B)', () => {
    // Row 25 => id 26, and `ai-score.ts` carries no chain for that one.
    expect(AI_SINGLE_SCORE_DISPATCH[25]).toBe(26);
    // The terrain combination that yields possibility 2 (mine) is searched for, not guessed.
    let st: GameState | null = null;
    let p: Player | null = null;
    // Own territory all around — the classification as a mine demands it; the flag score is
    // irrelevant here, row 25 is what is under test.
    for (let terrain = 0; terrain <= 15; terrain++) {
      const cand = lonelyMap(20, 20, terrain, terrain, 1);
      const cp = player({ cursorCol: 20, cursorRow: 20 });
      const site = classifyBuildSite(cand, cp, 20, 20);
      if (site.possibility === 2 && site.cursorType >= 5) { st = cand; p = cp; break; }
    }
    expect(st).not.toBeNull();
    const line = p!.aiCandidates[25]!;
    line[0]!.score = 40000;
    line[0]!.col = 20;
    line[0]!.row = 20;
    aiExecuteBuildTask(st!, p!, AI_TASK_GEOLOGIST);
    // The candidate is consumed (the original does that too), but nothing is created.
    expect(line[0]!.score).toBe(0);
    expect(st!.flags.filter((f) => f)).toHaveLength(0);
  });
});
