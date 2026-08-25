import { describe, it, expect } from 'vitest';
import { freeWalkingBody, freeWalkingCommon } from './serf-free-walking.js';
import { mapGeometry, posOf } from './position.js';
import type { GameState, Serf, Tile } from './state.js';

const geo = mapGeometry(3);
function tile(over: Partial<Tile> = {}): Tile {
  return {
    height: 0,
    terrainUp: 8,
    terrainDown: 8,
    object: 0,
    owner: 0,
    paths: 0,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: 0,
    ...over,
  } as unknown as Tile;
}
function makeState(): GameState {
  const mapTiles = Array.from({ length: geo.tileCount }, () => tile());
  return { geo, gameTick: 1000, mapTiles, serfs: [] as (Serf | null)[] } as unknown as GameState;
}
function mkSerf(over: Partial<Serf> & { index: number; type: number }): Serf {
  return {
    counter: 0xffff, // i16 < 0 == expired, so the body runs
    tick: 0,
    animation: 0,
    state: 16,
    col: 20,
    row: 20,
    stateData: [0, 0, 0, 0, 0],
    ...over,
  } as unknown as Serf;
}

describe('serf-free-walking — forward movement towards the target', () => {
  it('target 2 tiles east, open terrain -> a step towards it (dist_col decremented)', () => {
    const state = makeState();
    const here = posOf(20, 20, geo);
    state.mapTiles[here] = tile({ serfIndex: 5 });
 // dist_col=2 (F 0xb), dist_row=0; flags=0.
    const serf = mkSerf({ index: 5, type: 20, col: 20, row: 20, stateData: [2, 0, 0, 0, 0] });
    state.serfs[5] = serf;

    freeWalkingBody(state, serf);

    expect(serf.state).toBe(16); // still under way
 // dist_col reduced by 1 (one step nearer the target).
    expect((serf.stateData[0] << 24) >> 24).toBe(1);
 // The serf has moved (no longer registered on the start tile).
    expect(state.mapTiles[here].serfIndex).toBe(0);
  });

  it('an impassable neighbour towards the target -> evade, never step into the block', () => {
    const state = makeState();
    const here = posOf(20, 20, geo);
    state.mapTiles[here] = tile({ serfIndex: 5 });
 // Block the tile to the right (the target) with an impassable rock (object 72).
    state.mapTiles[posOf(21, 20, geo)] = tile({ object: 72 });
    const serf = mkSerf({ index: 5, type: 20, col: 20, row: 20, stateData: [2, 0, 0, 0, 0] });
    state.serfs[5] = serf;

    freeWalkingBody(state, serf);

 // The serf must NOT have walked onto the rock tile.
    expect([serf.col, serf.row]).not.toEqual([21, 20]);
  });
});

describe('serf-free-walking — arrival handover (dest_reached)', () => {
  it('geologist at the target (empty tile) -> SamplingGeoSpot (43)', () => {
    const state = makeState();
    const here = posOf(20, 20, geo);
    state.mapTiles[here] = tile({ object: 0, serfIndex: 5 });
 // Target reached: dist 0,0, flags=8 (BIT3); neg_dist1=5 (!= -128, outbound).
    const serf = mkSerf({ index: 5, type: 20, col: 20, row: 20, stateData: [0, 0, 5, 0, 8] });
    state.serfs[5] = serf;

    freeWalkingBody(state, serf);

    expect(serf.state).toBe(43);
    expect(serf.animation).toBe(141);
  });

  it('geologist back at its own flag -> LookingForGeoSpot (42)', () => {
    const state = makeState();
    const here = posOf(20, 20, geo);
 // Flag (object 1) inside own territory (owner = serf.owner+1 = 1).
    state.mapTiles[here] = tile({ object: 1, owner: 1, serfIndex: 5 });
 // Return trip finished: flags=8, neg_dist1=-128 (0x80), neg_dist2=0.
    const serf = mkSerf({ index: 5, type: 20, owner: 0, col: 20, row: 20, stateData: [0, 0, 0x80, 0, 8] });
    state.serfs[5] = serf;

    freeWalkingBody(state, serf);

    expect(serf.state).toBe(42);
  });

  it('the geologist target is no longer free (an object on it) -> return marker (neg_dist1 = -128)', () => {
    const state = makeState();
    const here = posOf(20, 20, geo);
    state.mapTiles[here] = tile({ object: 8, serfIndex: 5 }); // a tree stands there now
    const serf = mkSerf({ index: 5, type: 20, col: 20, row: 20, stateData: [0, 0, 5, 0, 8] });
    state.serfs[5] = serf;

    freeWalkingBody(state, serf);

    expect(serf.state).toBe(16); // stays FreeWalking
    expect((serf.stateData[2] << 24) >> 24).toBe(-128); // neg_dist1 = -128 (return trip)
  });
});

describe('serf-free-walking — the waiting branch of the open-field knight (state 53)', () => {
 /**
  * The branch @0x1dae5 (forward path) applies ONLY to state 53 and ONLY to the last step: if the
  * target is exactly one tile away, that tile is not blocked but occupied by a serf, the knight
  * stays put (`animation = 0x52` @0x1dc8a, `counter = 0x7f` @0x1dc92) instead of looking for an
  * evasive direction. Further away it walks around the obstacle like any free walker (@0x1dca1).
  *
  * `dist` = remaining column delta; at `dist == 1` the eastern tile is the TARGET, at `dist == 3`
  * merely a tile on the way.
  */
  function blockedScenario(opts: { state: number; dist: number; negDist1?: number }) {
    const state = makeState();
    const here = posOf(20, 20, geo);
    const east = posOf(21, 20, geo);
    state.mapTiles[here] = tile({ serfIndex: 5 });
    state.mapTiles[east] = tile({ serfIndex: 9 }); // occupied but passable
    const serf = mkSerf({
      index: 5,
      type: 22, // Knight0
      col: 20,
      row: 20,
      state: opts.state,
      stateData: [opts.dist, 0, opts.negDist1 ?? 0, 0, 0],
    });
    state.serfs[5] = serf;
    state.serfs[9] = mkSerf({ index: 9, type: 22, col: 21, row: 20, state: 70 });
    freeWalkingCommon(state, serf);
    return { state, serf, here };
  }

  it('state 53, target tile (last step) occupied -> stay put (anim 82, counter 0x7f)', () => {
    const { serf, state, here } = blockedScenario({ state: 53, dist: 1 });
    expect(serf.animation).toBe(82);
    expect(serf.counter).toBe(0x7f);
    expect(serf.state).toBe(53);
    expect([serf.col, serf.row]).toEqual([20, 20]); // no step
    expect(state.mapTiles[here].serfIndex).toBe(5);
    expect((serf.stateData[0] << 24) >> 24).toBe(1); // target delta unchanged
  });

  it('the same last step in state 16 -> NO waiting branch, the serf evades', () => {
    const { serf, here, state } = blockedScenario({ state: 16, dist: 1 });
    expect(state.mapTiles[here].serfIndex).toBe(0); // start tile left
    expect(serf.animation).not.toBe(82);
  });

  it('state 53 with neg_dist1 == -128 -> the waiting branch does NOT apply (cmpb $0x80,0xd @0x1daf5)', () => {
    const { serf } = blockedScenario({ state: 53, dist: 1, negDist1: 0x80 });
    expect(serf.animation).not.toBe(82);
  });

 /**
  * A knight whose target is still three tiles away must NOT wait in front of an occupied tile on
  * the way — otherwise following attackers block each other for good and never slide into a
  * waiting position that becomes free.
  */
  it('state 53, target FURTHER than one step -> no waiting, an evasive direction', () => {
    const { serf, here, state } = blockedScenario({ state: 53, dist: 3 });
    expect(state.mapTiles[here].serfIndex).toBe(0); // start tile left
    expect(serf.animation).not.toBe(82);
  });
});

/**
 * The deadlock brake (@0x1db34..@0x1dc85): a waiting open-field knight clears the way on the tenth
 * attempt.
 */
describe('deadlockBrake', () => {
 /** Knight (53) at (20,20), target one tile east, where `other` stands on a flag. */
  function blocked(otherState: number, onFlag = true): { state: GameState; knight: Serf; other: Serf } {
    const state = makeState();
    const here = posOf(20, 20, geo);
    const np = posOf(21, 20, geo);
    state.mapTiles[here] = tile({ height: 8, serfIndex: 5 });
    state.mapTiles[np] = tile({
      height: 8,
      serfIndex: 6,
      object: onFlag ? 1 : 0,
      objIndex: onFlag ? 1 : 0,
    });
    const knight = mkSerf({ index: 5, type: 22, state: 53, col: 20, row: 20, stateData: [1, 0, 0, 0, 0] });
    const other = mkSerf({ index: 6, type: 0, state: otherState, col: 21, row: 20, stateData: [0, 0, 0, 0, 0] });
    state.serfs[5] = knight;
    state.serfs[6] = other;
    (state as unknown as { flags: unknown[] }).flags = [null, null];
    return { state, knight, other };
  }

  it('counts nine attempts up without doing anything', () => {
    const { state, knight, other } = blocked(3);
    for (let i = 0; i < 9; i++) freeWalkingCommon(state, knight);
    expect(knight.stateData[3] & 0xff).toBe(9);
    expect(other.state).toBe(3);
    expect(knight.animation).toBe(82); // it waits every time regardless
  });

  it('turns the blocking transporter into Lost on the tenth attempt and resets the counter', () => {
    const { state, knight, other } = blocked(3);
    for (let i = 0; i < 10; i++) freeWalkingCommon(state, knight);
    expect(other.state).toBe(25); // Lost
    expect(knight.stateData[3] & 0xff).toBe(0);
  });

  it('does not fire on a blocker that is neither Walking (2) nor Transporting (3)', () => {
    const { state, knight, other } = blocked(1);
    for (let i = 0; i < 30; i++) freeWalkingCommon(state, knight);
    expect(other.state).toBe(1);
    expect(knight.stateData[3] & 0xff).toBe(0); // the counter does not even start
  });

  it('leaves a transporter without a flag underneath alone (@0x1db83) — the counter still runs', () => {
    const { state, knight, other } = blocked(3, false);
    for (let i = 0; i < 12; i++) freeWalkingCommon(state, knight);
    expect(other.state).toBe(3);
    expect(knight.stateData[3] & 0xff).toBe(2); // reset at 10 => the brake DID run
  });
});

describe('serf-free-walking — the stonecutter reaches its rock (@0x1e7e5)', () => {
 /**
  * The transition stores `counter >> 2` as a WORD over `serf+0xe..0xf` (`mov %ax,0xe(%ebx)`,
  * `66 89 43 0e`) and thereby clears `flags`. State 23 reads the same place back as a word
  * (`mov 0xe(%ebx),%ax` @0x1c2a1) and uses it as the approach threshold.
  *
  * The bug this catches: as a byte store the high byte of the free-walking `flags` survives
  * (typically 8 == the 'target reached' marker), the threshold is 0x800 too large, the comparison
  * `thresh >= counter` hits immediately — and the stonecutter runs through its chopping animation
  * 0x7b in a single tick instead of showing it.
  */
  it('stores `neg_dist2` as a WORD and clears `flags` in doing so', () => {
    const state = makeState();
    const here = posOf(20, 20, geo);
    const stone = posOf(19, 19, geo); // UpLeft of (20,20)
    state.mapTiles[here] = tile({ serfIndex: 5 });
    state.mapTiles[stone] = tile({ object: 72 }); // rock pile (72..79)
 // `flags` (index 4) carries 8 — exactly the value that survives in a real run.
    const serf = mkSerf({
      index: 5,
      type: 7, // stonecutter
      col: 20,
      row: 20,
      stateData: [0, 0, 0, 0, 8],
    });
    state.serfs[5] = serf;

    freeWalkingBody(state, serf);

    expect(serf.state).toBe(23); // StoneCutting
    expect(serf.stateData[2]).toBe(0); // neg_dist1 = 0 -> approach phase
 // The threshold is exactly `counter >> 2` — and the high byte is ZEROED.
    expect(serf.stateData[3]).toBe((serf.counter >> 2) & 0xff);
    expect(serf.stateData[4]).toBe(((serf.counter >> 2) >> 8) & 0xff);
    expect(serf.stateData[4]).toBe(0);
 // Discrimination: with a byte store the 8 would stand here and the threshold be 0x800 too large.
    const thresh = serf.stateData[3] | (serf.stateData[4] << 8);
    expect(thresh).toBeLessThan(serf.counter); // otherwise the comparison fires immediately
    expect(thresh).toBeGreaterThan(0);
  });
});
