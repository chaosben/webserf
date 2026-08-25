import { describe, expect, it } from 'vitest';
import {
  AI_GENERIC_RESERVE,
  AI_SHIFT_COOLDOWN,
  AI_SHIFT_DURATION,
  OCCUPATION_COST,
  OCCUPATION_TABLE,
  PLAYER_FLAG_STRONG_ATTACK,
  TOOL_DEMAND_EMPTY,
  TOOL_PRIORITY_SCALE,
  aiDistributionPolicy,
  aiMilitaryPolicy,
  castleGarrisonTarget,
  chooseOccupationLevel,
} from './ai-policy.js';
import type { GameState, Inventory, Player } from './state.js';

function player(over: Partial<Player> = {}): Player {
  return {
    slot: 1,
    index: 1,
    active: true,
    flags: 0xc0, // aktiv + KI
    serfCount: new Array<number>(27).fill(0),
    completedBuildingCount: new Array<number>(23).fill(0),
    incompleteBuildingCount: new Array<number>(23).fill(0),
    aiIdleSerfs: new Array<number>(27).fill(0),
    aiStockpile: new Array<number>(26).fill(0),
    toolPriority: new Array<number>(9).fill(0),
    knightOccupation: [0x10, 0x21, 0x32, 0x43],
    foodDistribution: new Array<number>(4).fill(0),
    planksDistribution: new Array<number>(3).fill(0),
    steelDistribution: new Array<number>(2).fill(0),
    coalDistribution: new Array<number>(3).fill(0),
    wheatDistribution: new Array<number>(2).fill(0),
    knightMenuValue: 0,
    knightShiftTimer: 0,
    aiOccupationCap: 16,
    aiAttackStrongChance: 0,
    aiKnightOccupationLevel: 0,
    aiKnightTotal: 0,
    aiShiftCooldown: 0,
    aiTimer562: 0,
    totalLandScore: 0x800,
    ...over,
  } as unknown as Player;
}

/** A state with a fixed random value and without buildings/stocks. */
function state(rng: number, over: Partial<GameState> = {}): GameState {
  return {
    header: { maxBuildingIndex: 0, maxSerfIndex: 0 },
    buildings: [],
    serfs: [],
    inventories: [],
    rng: { next: () => rng },
    ...over,
  } as unknown as GameState;
}

describe('AI policy — tables', () => {
  it('the occupation table has 16 rows of 4 bytes', () => {
    expect(OCCUPATION_TABLE).toHaveLength(16);
    expect(OCCUPATION_TABLE.every((r) => r.length === 4)).toBe(true);
  });

  it('the cost tables end on the garrison capacities 3/6/12', () => {
    expect(OCCUPATION_COST.map((t) => t[4])).toEqual([3, 6, 12]);
  });
});

describe('AI policy — garrison target', () => {
  it('the curve has three stages and is capped at 99', () => {
    expect(castleGarrisonTarget(0)).toBe(3);
    expect(castleGarrisonTarget(68)).toBe(20); // (68>>2)+3 — the first stage
    // The second stage starts at 0x1e and is idempotent at exactly 30: (30>>1)+15 == 30.
    expect(castleGarrisonTarget(108)).toBe(30);
    expect(castleGarrisonTarget(200)).toBe(41); // (53>>1)+15 — visible here
    expect(castleGarrisonTarget(400)).toBe(58); // ((103>>1)+15 == 66) >= 0x32 => (66>>1)+25
    expect(castleGarrisonTarget(2000)).toBe(99); // cap
    expect(castleGarrisonTarget(65535)).toBe(99);
  });

  it('it rises monotonically', () => {
    let prev = 0;
    for (let k = 0; k < 2000; k += 7) {
      const v = castleGarrisonTarget(k);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('AI policy — level search', () => {
  const empty = [0, 1, 2].map(() => [0, 0, 0, 0]);

  it('without military buildings the most expensive row fits — level 16', () => {
    expect(chooseOccupationLevel(empty, 0)).toBe(16);
  });

  it('with buildings the level drops until the supply suffices', () => {
    // Nine huts at the highest threat level: row 0 costs 9*3 == 27.
    const counts = [[0, 0, 0, 9], [0, 0, 0, 0], [0, 0, 0, 0]];
    expect(chooseOccupationLevel(counts, 27)).toBe(16);
    // Rows 0..11 all start with value 4 (cost 3) — only row 12 has 3 (cost 2).
    expect(chooseOccupationLevel(counts, 26)).toBe(4);
    expect(chooseOccupationLevel(counts, 18)).toBe(4);
    expect(chooseOccupationLevel(counts, 17)).toBe(1); // rows 13/14 also cost 18
    expect(chooseOccupationLevel(counts, 9)).toBe(1); // row 15: value 1 => cost 1 => 9
    expect(chooseOccupationLevel(counts, 8)).toBe(0); // even the cheapest row does not fit
  });

  it('a fortress costs four times a hut', () => {
    const hut = [[0, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0]];
    const fort = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]];
    expect(chooseOccupationLevel(hut, 3)).toBe(16);
    expect(chooseOccupationLevel(fort, 3)).toBeLessThan(16);
    expect(chooseOccupationLevel(fort, 12)).toBe(16);
  });
});

describe('AI policy — the military policy as a whole', () => {
  it('the attack style follows the random roll against the character trait', () => {
    const p1 = player({ aiAttackStrongChance: 30000 });
    aiMilitaryPolicy(state(29999), p1);
    expect(p1.flags & PLAYER_FLAG_STRONG_ATTACK).toBe(PLAYER_FLAG_STRONG_ATTACK);
    const p2 = player({ aiAttackStrongChance: 30000, flags: 0xc0 | PLAYER_FLAG_STRONG_ATTACK });
    aiMilitaryPolicy(state(30000), p2);
    expect(p2.flags & PLAYER_FLAG_STRONG_ATTACK).toBe(0);
  });

  it('block 554 carries the UNCAPPED level, the nibbles the capped one', () => {
    // No military building => level 16; cap 5 => row 11 == [4,1,0,0].
    const p = player({ aiOccupationCap: 5 });
    aiMilitaryPolicy(state(0), p);
    expect(p.aiKnightOccupationLevel).toBe(16);
    expect(p.knightOccupation).toEqual([0x00, 0x00, 0x10, 0x43]);
  });

  it('level 0 writes four zero nibbles — the original reads past the table', () => {
    // A fortress at the highest threat level and not a single knight => no row fits. The roll MUST
    // be >= maxBuildingIndex, otherwise the bitmap advance (@0x54af2) kicks in and the fortress is
    // not counted at all — which is the case in the test below.
    const p = player();
    const bld = { owner: 1, type: 22, constructing: false, threatLevel: 3 };
    const st = state(3, {
      header: { maxBuildingIndex: 2, maxSerfIndex: 0 },
      buildings: [null, bld],
    } as unknown as Partial<GameState>);
    aiMilitaryPolicy(st, p);
    expect(p.aiKnightOccupationLevel).toBe(0);
    expect(p.knightOccupation).toEqual([0, 0, 0, 0]);
  });

  it('the bitmap advance truncates the count — original defect @0x54ae3/@0x54af2', () => {
    // The same fortress, but the roll underflows in the FIRST iteration (`subw $0x1` on 0 sets the
    // borrow, `jae` @0x54ae8 falls through). From slot 1 on the original tests the occupancy of slot
    // 8 instead of slot 0 — and slot 8 is outside the table here, hence free. Consequence: no
    // military building counted => level 16 instead of 0.
    const bld = { owner: 1, type: 22, constructing: false, threatLevel: 3 };
    const fixture = {
      header: { maxBuildingIndex: 2, maxSerfIndex: 0 },
      buildings: [null, bld],
    } as unknown as Partial<GameState>;
    const pUnderflow = player();
    aiMilitaryPolicy(state(0, fixture), pUnderflow);
    expect(pUnderflow.aiKnightOccupationLevel).toBe(16);

    // Counter check — the same situation with slot 8 occupied: the advance is then inconsequential,
    // which is how every real save game with maxBuildingIndex > 8 looks.
    const pSlot8 = player();
    const occupied = Array.from({ length: 9 }, (_, i) => (i === 1 ? bld : i === 8 ? bld : null));
    aiMilitaryPolicy(
      state(0, {
        header: { maxBuildingIndex: 2, maxSerfIndex: 0 },
        buildings: occupied,
      } as unknown as Partial<GameState>),
      pSlot8,
    );
    expect(pSlot8.aiKnightOccupationLevel).toBe(0);
  });

  it('construction sites do not count — the mask keeps bit 7', () => {
    const p = player();
    const site = { owner: 1, type: 22, constructing: true, threatLevel: 3 };
    const st = state(0, {
      header: { maxBuildingIndex: 2, maxSerfIndex: 0 },
      buildings: [null, site],
    } as unknown as Partial<GameState>);
    aiMilitaryPolicy(st, p);
    expect(p.aiKnightOccupationLevel).toBe(16); // as if the fortress were not there
  });

  it('the knight sum lands in block 556 and feeds the target', () => {
    const p = player();
    for (let r = 22; r <= 26; r++) p.serfCount[r] = 10;
    aiMilitaryPolicy(state(0), p);
    expect(p.aiKnightTotal).toBe(50);
    expect(p.knightMenuValue).toBe(castleGarrisonTarget(50));
  });

  it('the shift change only starts with a free cooldown — and sets three fields', () => {
    const make = (over: Partial<Player>): Player => {
      const p = player(over);
      p.aiIdleSerfs[26] = 5; // strong knights in the stock
      p.serfCount[22] = 20; // knights in the field
      return p;
    };
    const p = make({});
    aiMilitaryPolicy(state(0), p);
    expect(p.knightShiftTimer).toBe(AI_SHIFT_DURATION);
    expect(p.aiShiftCooldown).toBe(AI_SHIFT_COOLDOWN);
    expect(p.flags & (1 << 2)).not.toBe(0);
    expect(p.flags & (1 << 4)).not.toBe(0);
    // With a running cooldown nothing happens (the tick counts it down, not this routine).
    const blocked = make({ aiShiftCooldown: 500 });
    aiMilitaryPolicy(state(0), blocked);
    expect(blocked.knightShiftTimer).toBe(0);
    expect(blocked.aiShiftCooldown).toBe(500);
  });

  it('enough military buildings prevent the shift change', () => {
    const p = player();
    p.aiIdleSerfs[26] = 1;
    p.serfCount[22] = 2;
    p.completedBuildingCount[21] = 40; // many fortresses => the weighted sum beats both measures
    aiMilitaryPolicy(state(0), p);
    expect(p.knightShiftTimer).toBe(0);
  });

  it('recruiting only happens if the settler reserve survives', () => {
    const inv = (generic: number): Inventory => ({
      owner: 1, genericCount: generic,
      resources: Object.assign(new Array<number>(26).fill(0), { 24: 99, 25: 99 }),
    } as unknown as Inventory);
    // Exactly at the reserve: 10 free settlers, 10 weapon pairs => nobody would be left.
    const p = player();
    const st = state(0, { inventories: [inv(AI_GENERIC_RESERVE)] } as unknown as Partial<GameState>);
    aiMilitaryPolicy(st, p);
    expect(p.serfCount[22]).toBe(0); // nothing recruited (recruitKnights finds no serf anyway)
    // Below the reserve: no attempt at all.
    const few = player();
    const st2 = state(0, { inventories: [inv(3)] } as unknown as Partial<GameState>);
    aiMilitaryPolicy(st2, few);
    expect(few.serfCount[22]).toBe(0);
  });
});

describe('AI policy — distribution sliders', () => {
  it('empty stock: all nine tool sliders on the replacement target', () => {
    const p = player();
    aiDistributionPolicy(p);
    const want = (TOOL_DEMAND_EMPTY * TOOL_PRIORITY_SCALE) & 0xffff;
    expect(p.toolPriority).toEqual(new Array<number>(9).fill(want));
  });

  it('at maximum tool shortage the boatbuilder gets nothing', () => {
    const p = player();
    aiDistributionPolicy(p);
    expect(p.planksDistribution[1]).toBe(0);
    expect(p.planksDistribution[0]).toBeLessThan(0xffff);
  });

  it('plenty of tools: all sliders 0, planks entirely to construction', () => {
    const p = player();
    for (let r = 15; r <= 23; r++) p.aiStockpile[r] = 50;
    p.aiStockpile[8] = 20; // boats
    aiDistributionPolicy(p);
    expect(p.toolPriority).toEqual(new Array<number>(9).fill(0));
    expect(p.planksDistribution[0]).toBe(0xffff);
    expect(p.planksDistribution[1]).toBe(0);
  });

  it('the weaponsmith coal is a constant 45000', () => {
    const p = player();
    aiDistributionPolicy(p);
    expect(p.coalDistribution[2]).toBe(45000);
  });

  it('the knight occupation drives steel and gold', () => {
    // The branch is only visible when the tool shortage is LARGE: the slider is the maximum of the
    // occupation wish and the inverted tool demand. With a full tool stock the latter is 0xffff and
    // covers everything — which is why an empty stock is used here.
    const full = player({ knightOccupation: [0, 0, 0, 0x43] });
    aiDistributionPolicy(full);
    expect(full.steelDistribution[1]).toBe(0xf); // fully occupied => only the tool remainder
    const thin = player({ knightOccupation: [0, 0, 0, 0x10] });
    aiDistributionPolicy(thin);
    expect(thin.steelDistribution[1]).toBe(60000);
    const none = player({ knightOccupation: [0, 0, 0, 0x00] });
    aiDistributionPolicy(none);
    expect(none.steelDistribution[1]).toBe(0xffff); // the default branch
  });

  it('plenty of steel switches the gold smelter to maximum', () => {
    const p = player({ knightOccupation: [0, 0, 0, 0x43] });
    p.aiStockpile[11] = 10; // steel
    aiDistributionPolicy(p);
    expect(p.coalDistribution[1]).toBe(0xffff);
    expect(p.foodDistribution[3]).toBeLessThanOrEqual(p.coalDistribution[1]!);
  });

  it('food decides between pig farm and mill', () => {
    const hungry = player();
    aiDistributionPolicy(hungry);
    expect(hungry.wheatDistribution[1]).toBe(0xffff); // without food: wheat to the mill
    const fed = player();
    fed.aiStockpile[0] = 40; // fish
    fed.aiStockpile[2] = 40; // meat
    fed.aiStockpile[5] = 40; // bread
    aiDistributionPolicy(fed);
    expect(fed.wheatDistribution[0]).toBe(0xffff); // well fed: wheat to the pig farm
  });

  it('the land size is clamped to [0x400, 0xfff]', () => {
    const small = player({ totalLandScore: 0 });
    small.aiStockpile[15] = 1; // one shovel so the curve applies
    aiDistributionPolicy(small);
    const huge = player({ totalLandScore: 0xffff });
    huge.aiStockpile[15] = 1;
    aiDistributionPolicy(huge);
    // Land 4 => (4>>2)+1-1 == 1; land 15 => (15>>2)+1-1 == 3.
    expect(small.toolPriority[0]).toBe(TOOL_PRIORITY_SCALE);
    expect(huge.toolPriority[0]).toBe((3 * TOOL_PRIORITY_SCALE) & 0xffff);
  });
});
