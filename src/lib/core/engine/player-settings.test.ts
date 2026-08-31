import { describe, it, expect } from 'vitest';
import {
  SETTINGS_DEFAULTS,
  adjustKnightMenuValue,
  adjustKnightOccupation,
  applySettingsDefaults,
  applySliderClick,
  KNIGHT_SHIFT_DURATION,
  KNIGHT_SHIFT_PHASE2_AT,
  PLAYER_FLAG_RANK_FLOOR,
  PLAYER_FLAG_REDUCED_OCCUPANCY,
  PLAYER_FLAG_SHIFT_ACTIVE,
  countRecruitable,
  startKnightShift,
  tickKnightShift,
  movePriorityItem,
  recruitKnights,
  selectPriorityItem,
  setAttackSelection,
  sliderValueFromClick,
} from './player-settings.js';
import {
  FOOD_POPUP_SLIDERS,
  KNIGHT_POPUP_RATE_SLIDER,
  TOOLS_POPUP_SLIDERS,
} from '../settings-popup.js';
import { SLIDER_STEP } from '../ui-render.js';
import type { GameState, Inventory, Player, Serf } from './state.js';

function player(fields: Partial<Player> = {}): Player {
  return {
    slot: 0,
    flags: 0x41,
    foodDistribution: [0, 0, 0, 0],
    planksDistribution: [0, 0, 0],
    steelDistribution: [0, 0],
    coalDistribution: [0, 0, 0],
    wheatDistribution: [0, 0],
    toolPriority: Array.from({ length: 9 }, () => 0),
    flagPriority: Array.from({ length: 26 }, (_, i) => 26 - i),
    inventoryPriority: Array.from({ length: 26 }, (_, i) => i + 1),
    knightOccupation: [0x10, 0x21, 0x32, 0x43],
    serfToKnightRate: 0,
    currentSett5Item: 1,
    currentSett6Item: 1,
    knightMenuValue: 3,
    serfCount: Array.from({ length: 27 }, () => 0),
    totalMilitaryScore: 0,
    ...fields,
  } as unknown as Player;
}

function inventory(fields: Partial<Inventory> = {}): Inventory {
  return {
    index: 1,
    owner: 0,
    genericCount: 0,
    resources: Array.from({ length: 26 }, () => 0),
    serfIndices: Array.from({ length: 27 }, () => 0),
    ...fields,
  } as unknown as Inventory;
}

/**
 * Idle generic in stock `invIndex`. The stock index lives in the union bytes `serf[0xe]`
 * (= `stateData[3..4]`), which is where the original reads it and the only place the engine writes.
 * The decoded view is deliberately left out of sync here, so the test notices if anyone reads it again.
 */
function idleGeneric(index: number, invIndex: number): Serf {
  return {
    index,
    owner: 0,
    type: 21,
    typeName: 'Generic',
    sound: true,
    state: 1,
    stateData: [0, 0, 0, invIndex & 0xff, (invIndex >> 8) & 0xff],
  } as unknown as Serf;
}

function gameState(serfs: (Serf | null)[], inventories: (Inventory | null)[]): GameState {
  return {
    header: { maxSerfIndex: serfs.length },
    serfs,
    inventories,
  } as unknown as GameState;
}

describe('player-settings — sliders', () => {
  it('left edge ⇒ 0, right edge ⇒ full deflection 65500', () => {
    const s = FOOD_POPUP_SLIDERS[0]!; // column 4 ⇒ zone x 0x20..0x5f
    expect(sliderValueFromClick(s, 0x20)).toBe(0); // borrow branch
    expect(sliderValueFromClick(s, 0x27)).toBe(0); // exactly the 7px dead zone
    expect(sliderValueFromClick(s, 0x28)).toBe(SLIDER_STEP);
    expect(sliderValueFromClick(s, 0x5f)).toBe(50 * SLIDER_STEP);
    expect(50 * SLIDER_STEP).toBe(65500);
  });

  it('clamps beyond the zone at 50 pixels', () => {
    const s = FOOD_POPUP_SLIDERS[0]!;
    expect(sliderValueFromClick(s, 0x7f)).toBe(50 * SLIDER_STEP);
  });

  it('writes into the field the slider names', () => {
    const p = player();
    applySliderClick(p, TOOLS_POPUP_SLIDERS[2]!, 0x30); // third row ⇒ toolPriority[5]
    expect(p.toolPriority[5]).toBe((0x30 - 0x20 - 7) * SLIDER_STEP);
    expect(p.toolPriority[0]).toBe(0);
    applySliderClick(p, KNIGHT_POPUP_RATE_SLIDER, 0x5f);
    expect(p.serfToKnightRate).toBe(65500);
  });
});

describe('player-settings — defaults', () => {
  it('sets exactly the fields of its screen', () => {
    const p = player();
    expect(applySettingsDefaults(p, 0x1c)).toBe(true);
    expect(p.foodDistribution).toEqual([13100, 45850, 45850, 65500]);
    expect(p.toolPriority[0]).toBe(0); // untouched
    expect(applySettingsDefaults(p, 0x1d)).toBe(true);
    expect(p.planksDistribution).toEqual([65500, 3275, 19650]);
    expect(p.steelDistribution).toEqual([45850, 65500]);
    expect(applySettingsDefaults(p, 0x1f)).toBe(false); // screen without a defaults button
  });

  it('both priority defaults are permutations of 1..26', () => {
    for (const list of [SETTINGS_DEFAULTS.flagPriority, SETTINGS_DEFAULTS.inventoryPriority]) {
      expect([...list].sort((a, b) => a - b)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    }
  });

  it('the defaults match the manual: wood at the top, gold at the bottom, gold before wheat', () => {
    const t = SETTINGS_DEFAULTS.flagPriority;
    expect(t[7]).toBe(26); // planks at the very top
    expect(t[6]).toBe(22); // lumber high up
    expect(Math.min(...t)).toBe(t[13]!); // gold ore at the very bottom
    const e = SETTINGS_DEFAULTS.inventoryPriority;
    expect(e[14]).toBe(26); // gold bars evacuated first
    expect(e[13]).toBe(25); // gold ore next
    expect(e[3]).toBe(1); //  wheat last
  });
});

describe('player-settings — knight occupation', () => {
  it('the target cannot drop below the minimum nor rise above 4', () => {
    const p = player({ knightOccupation: [0x22, 0x40, 0x00, 0x44] });
    expect(adjustKnightOccupation(p, 0, 'max', -1)).toBe(false); // max == min
    expect(adjustKnightOccupation(p, 0, 'min', 1)).toBe(false); // max == min
    expect(adjustKnightOccupation(p, 1, 'max', 1)).toBe(false); // max == 4
    expect(adjustKnightOccupation(p, 2, 'min', -1)).toBe(false); // min == 0
    expect(p.knightOccupation).toEqual([0x22, 0x40, 0x00, 0x44]);
  });

  it('otherwise moves by exactly one step', () => {
    const p = player({ knightOccupation: [0x21, 0x21, 0x21, 0x21] });
    expect(adjustKnightOccupation(p, 0, 'max', 1)).toBe(true);
    expect(p.knightOccupation[0]).toBe(0x31);
    expect(adjustKnightOccupation(p, 1, 'max', -1)).toBe(true);
    expect(p.knightOccupation[1]).toBe(0x11);
    expect(adjustKnightOccupation(p, 2, 'min', -1)).toBe(true);
    expect(p.knightOccupation[2]).toBe(0x20);
    expect(adjustKnightOccupation(p, 3, 'min', 1)).toBe(true);
    expect(p.knightOccupation[3]).toBe(0x22);
  });
});

describe('player settings — priority lists', () => {
  it('a click on a row stores the 1-based resource index as the cursor', () => {
    const p = player(); // flagPriority[i] = 26 − i
    expect(selectPriorityItem(p, 'transport', 0)).toBe(true); // slot 0 ⇒ value 26 ⇒ resource 0
    expect(p.currentSett5Item).toBe(1);
    expect(selectPriorityItem(p, 'transport', 25)).toBe(true); // value 1 ⇒ resource 25
    expect(p.currentSett5Item).toBe(26);
    expect(selectPriorityItem(p, 'evacuation', 0)).toBe(true); // inventoryPriority[i] = i+1
    expect(p.currentSett6Item).toBe(26);
  });

  it('all four moves preserve the permutation', () => {
    for (const move of ['top', 'up', 'down', 'bottom'] as const) {
      const p = player({ currentSett5Item: 10 }); // resource 9 has priority 17
      expect(movePriorityItem(p, 'transport', move)).toBe(true);
      expect([...p.flagPriority].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 26 }, (_, i) => i + 1),
      );
    }
  });

  it('top/bottom set 26 and 1, up/down swap with the neighbour', () => {
    const p = player({ currentSett5Item: 10 }); // value 17
    movePriorityItem(p, 'transport', 'top');
    expect(p.flagPriority[9]).toBe(26);
    expect(p.flagPriority[0]).toBe(25); // the previous 26 moves down

    const q = player({ currentSett5Item: 10 });
    movePriorityItem(q, 'transport', 'bottom');
    expect(q.flagPriority[9]).toBe(1);
    expect(q.flagPriority[25]).toBe(2); // the previous 1 moves up

    const r = player({ currentSett5Item: 10 });
    movePriorityItem(r, 'transport', 'up');
    expect(r.flagPriority[9]).toBe(18);
    expect(r.flagPriority[8]).toBe(17); // swapped with the neighbour
  });

  it('does nothing when the resource is already at the top or bottom', () => {
    const top = player({ currentSett5Item: 1 }); // value 26
    expect(movePriorityItem(top, 'transport', 'up')).toBe(false);
    const bottom = player({ currentSett5Item: 26 }); // value 1
    expect(movePriorityItem(bottom, 'transport', 'down')).toBe(false);
  });
});

describe('player settings — knight menu', () => {
  it('the attack selection toggles only bit 1', () => {
    const p = player({ flags: 0x41 });
    setAttackSelection(p, true);
    expect(p.flags).toBe(0x43);
    setAttackSelection(p, false);
    expect(p.flags).toBe(0x41);
  });

  it('the counter stays between 1 and 99', () => {
    const p = player({ knightMenuValue: 1 });
    expect(adjustKnightMenuValue(p, -1)).toBe(false);
    expect(adjustKnightMenuValue(p, 1)).toBe(true);
    expect(p.knightMenuValue).toBe(2);
    p.knightMenuValue = 99;
    expect(adjustKnightMenuValue(p, 1)).toBe(false);
    expect(p.knightMenuValue).toBe(99);
  });

  it('recruitable == min(idle serfs, swords, shields) per warehouse', () => {
    const a = inventory({ index: 1, genericCount: 5, resources: withRes({ 24: 3, 25: 9 }) });
    const b = inventory({ index: 2, genericCount: 2, resources: withRes({ 24: 9, 25: 9 }) });
    const foreign = inventory({ index: 3, owner: 1, genericCount: 9, resources: withRes({ 24: 9, 25: 9 }) });
    const state = gameState([null], [null, a, b, foreign]);
    expect(countRecruitable(state, player())).toBe(3 + 2);
  });

  it('recruiting converts idle generics and consumes one weapon pair each', () => {
    const inv = inventory({ index: 1, genericCount: 4, resources: withRes({ 24: 2, 25: 5 }) });
    inv.serfIndices[21] = 2;
    const serfs = [null, idleGeneric(1, 1), idleGeneric(2, 1), idleGeneric(3, 1)];
    const state = gameState(serfs, [null, inv]);
    const p = player();

    expect(recruitKnights(state, p, 20)).toBe(2); // only two swords
    expect(serfs[1]!.type).toBe(22);
    expect(serfs[2]!.type).toBe(22);
    expect(serfs[3]!.type).toBe(21);
    expect(serfs[1]!.sound).toBe(false); // `serf[0] &= 3` clears bit 7 as well
    expect(inv.resources[24]).toBe(0);
    expect(inv.resources[25]).toBe(3);
    expect(inv.genericCount).toBe(2);
    expect(inv.serfIndices[21]).toBe(0); // cached generic pointer discarded
    expect(p.serfCount[21]).toBe(-2);
    expect(p.serfCount[22]).toBe(2);
    expect(p.totalMilitaryScore).toBe(2);
  });

  it('respects the button ceiling and skips foreign or busy serfs', () => {
    const inv = inventory({ index: 1, genericCount: 9, resources: withRes({ 24: 9, 25: 9 }) });
    const busy = idleGeneric(2, 1);
    (busy as { state: number }).state = 3; // walking => not recruitable
    const foreign = idleGeneric(3, 1);
    (foreign as { owner: number }).owner = 1;
    const state = gameState([null, idleGeneric(1, 1), busy, foreign], [null, inv]);
    const p = player();
    expect(recruitKnights(state, p, 1)).toBe(1);
    expect(inv.resources[24]).toBe(8);
  });
});

/** Knight shift (`@0x2dda4` + countdown @0xf0e5). The button only sets three states. */
describe('knight shift — trigger and countdown', () => {
  it('sets both bits and the clock', () => {
    const p = player();
    startKnightShift(p);
    expect(p.knightShiftTimer).toBe(KNIGHT_SHIFT_DURATION);
    expect(p.flags & PLAYER_FLAG_SHIFT_ACTIVE).toBeTruthy();
    expect(p.flags & PLAYER_FLAG_REDUCED_OCCUPANCY).toBeTruthy();
    expect(p.flags & PLAYER_FLAG_RANK_FLOOR).toBeFalsy(); // phase 2 only comes later
  });

  it('switches to phase 2 after 177 ticks and ends after 1200', () => {
    const p = player();
    startKnightShift(p);
    const phase1 = KNIGHT_SHIFT_DURATION - KNIGHT_SHIFT_PHASE2_AT;
    for (let t = 0; t < phase1 - 1; t++) tickKnightShift(p);
    expect(p.flags & PLAYER_FLAG_REDUCED_OCCUPANCY).toBeTruthy(); // still phase 1
    tickKnightShift(p);
    expect(p.knightShiftTimer).toBe(KNIGHT_SHIFT_PHASE2_AT);
    expect(p.flags & PLAYER_FLAG_REDUCED_OCCUPANCY).toBeFalsy();
    expect(p.flags & PLAYER_FLAG_RANK_FLOOR).toBeTruthy();

    for (let t = phase1; t < KNIGHT_SHIFT_DURATION - 1; t++) tickKnightShift(p);
    expect(p.flags & PLAYER_FLAG_SHIFT_ACTIVE).toBeTruthy();
    tickKnightShift(p);
    expect(p.knightShiftTimer).toBe(0);
    expect(p.flags & (PLAYER_FLAG_SHIFT_ACTIVE | PLAYER_FLAG_REDUCED_OCCUPANCY | PLAYER_FLAG_RANK_FLOOR)).toBe(0);
  });

  it('does not run at all without bit 2 set', () => {
    const p = player({ knightShiftTimer: 500 });
    tickKnightShift(p);
    expect(p.knightShiftTimer).toBe(500);
  });

  it('a second click resets the clock to phase 1', () => {
    const p = player();
    startKnightShift(p);
    for (let t = 0; t < 300; t++) tickKnightShift(p);
    expect(p.flags & PLAYER_FLAG_RANK_FLOOR).toBeTruthy();
    startKnightShift(p);
    expect(p.knightShiftTimer).toBe(KNIGHT_SHIFT_DURATION);
    expect(p.flags & PLAYER_FLAG_REDUCED_OCCUPANCY).toBeTruthy();
  // The button is a plain `bts` pair and does NOT clear bit 5. Clicking during phase 2 therefore
  // leaves lowered target AND rank floor active together until the countdown reaches 1023 again.
    expect(p.flags & PLAYER_FLAG_RANK_FLOOR).toBeTruthy();
  });
});

function withRes(map: Record<number, number>): number[] {
  const r = Array.from({ length: 26 }, () => 0);
  for (const [k, v] of Object.entries(map)) r[Number(k)] = v;
  return r;
}
