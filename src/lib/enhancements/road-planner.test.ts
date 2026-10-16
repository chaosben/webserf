import { describe, it, expect } from 'vitest';
import { planRoad, roadPlanCommands, roadTargets, stepCounter } from './road-planner.js';
import { startNewGame } from '../core/engine/new-game.js';
import { applyCommand } from '../core/engine/commands.js';
import { createRoadBuildingState } from '../core/engine/road-building.js';
import { mapGeometry, posOf, colOf, rowOf, neighbor, Direction } from '../core/engine/position.js';
import type { GameState, Player, Flag, Tile } from '../core/engine/state.js';

/** Synthetic 64x64 map: grass, height 10, owned by player 0 (tile owner 1). */
const geo = mapGeometry(3);

function tile(): Tile {
  return {
    height: 10,
    terrainUp: 5,
    terrainDown: 5,
    object: 0,
    owner: 1,
    paths: 0,
    blocked: false,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: 0,
  } as Tile;
}

function state(): GameState {
  const mapTiles: Tile[] = [];
  for (let i = 0; i < geo.cols * geo.rows; i++) mapTiles.push(tile());
  const player = {
    slot: 0,
    index: 0,
    active: true,
    flags: 1,
    build: 0,
    cursorCol: 0,
    cursorRow: 0,
  } as unknown as Player;
  return {
    geo,
    mapTiles,
    buildings: [null],
    flags: [null],
    players: [player],
    roadBuild: [createRoadBuildingState()],
  } as unknown as GameState;
}

const at = (st: GameState, col: number, row: number): Tile => st.mapTiles[posOf(col, row, geo)]!;

function putFlag(st: GameState, col: number, row: number): void {
  const idx = st.flags.length;
  st.flags.push({
    index: idx,
    owner: 0,
    paths: [false, false, false, false, false, false],
    endpointDirs: [false, false, false, false, false, false],
    connections: [null, null, null, null, null, null],
  } as unknown as Flag);
  const t = at(st, col, row);
  t.object = 1;
  t.objIndex = idx;
}

/** Two flags four tiles apart on row 10. */
function twoFlags(): GameState {
  const st = state();
  putFlag(st, 10, 10);
  putFlag(st, 14, 10);
  return st;
}

const plan = (st: GameState) => planRoad(st, st.players[0]!, { col: 10, row: 10 }, { col: 14, row: 10 });

describe('road planner', () => {
  it('lays the straight road on flat land', () => {
    const res = plan(twoFlags());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.dirs).toEqual([Direction.Right, Direction.Right, Direction.Right, Direction.Right]);
    expect(res.plan.forward).toBe(4 * stepCounter(Direction.Right, 0));
    expect(res.plan.forward).toBe(res.plan.backward);
    expect(res.plan.tiles.at(-1)).toEqual({ col: 14, row: 10 });
  });

  it('prefers a flat detour to a steep straight road, counting the way back too', () => {
    const st = twoFlags();
    for (const col of [11, 12, 13]) at(st, col, 10).height = 14;
    const res = plan(st);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.dirs.length).toBeGreaterThan(4);
    expect(res.plan.slopes.every((s) => s === 0)).toBe(true);
    const straight =
      2 * (stepCounter(Direction.Right, 4) + stepCounter(Direction.Left, -4)) +
      2 * (stepCounter(Direction.Right, 0) + stepCounter(Direction.Left, 0));
    expect(res.plan.forward + res.plan.backward).toBeLessThan(straight);
  });

  it('keeps off foreign land', () => {
    const st = twoFlags();
    for (let i = 0; i < st.mapTiles.length; i++) {
      const col = i & (geo.cols - 1);
      const row = (i >> geo.rowShift) & (geo.rows - 1);
      const inside = col >= 5 && col <= 20 && row >= 5 && row <= 20;
      if (!inside || col === 12) st.mapTiles[i]!.owner = 0;
    }
    expect(plan(st)).toEqual({ ok: false, reason: 'noRoute' });
  });

  it('does not cross an existing road or a water edge', () => {
    const st = twoFlags();
    at(st, 12, 10).paths = 0b001001; // a road running through
    at(st, 12, 9).terrainUp = 0; // water
    at(st, 12, 9).terrainDown = 0;
    const res = plan(st);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const visited = res.plan.tiles.map((t) => `${t.col},${t.row}`);
    expect(visited).not.toContain('12,10');
  });

  it('refuses when an end is not an own flag, or both ends are the same', () => {
    const st = twoFlags();
    const p = st.players[0]!;
    expect(planRoad(st, p, { col: 20, row: 20 }, { col: 10, row: 10 })).toEqual({
      ok: false,
      reason: 'notOwnFlag',
    });
    expect(planRoad(st, p, { col: 10, row: 10 }, { col: 20, row: 20 })).toEqual({
      ok: false,
      reason: 'notOwnTarget',
    });
    expect(planRoad(st, p, { col: 10, row: 10 }, { col: 10, row: 10 })).toEqual({
      ok: false,
      reason: 'sameFlag',
    });
  });

  it('reads the state and writes nothing', () => {
    const st = twoFlags();
    at(st, 12, 10).height = 13;
    const before = JSON.stringify(st);
    plan(st);
    expect(JSON.stringify(st)).toBe(before);
  });

  it('turns into the clicks a player would make', () => {
    const res = plan(twoFlags());
    if (!res.ok) throw new Error('no plan');
    const cmds = roadPlanCommands(res.plan, 0);
    expect(cmds[0]).toEqual({ kind: 'beginRoadBuilding', col: 10, row: 10, player: 0 });
    expect(cmds.slice(1).map((c) => c.col)).toEqual([11, 12, 13, 14]);
    expect(cmds.every((c) => c.player === 0)).toBe(true);
  });

  it('ends on a road at the quickest spot that takes a flag, with a special click', () => {
    const st = roadOnRow20();
    const res = planRoad(st, st.players[0]!, { col: 15, row: 15 }, { col: 12, row: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.newFlag).toBe(true);
    expect(res.plan.to.row).toBe(20);
    // Next to an end flag no flag fits.
    expect(res.plan.to.col).toBeGreaterThan(11);
    expect(res.plan.to.col).toBeLessThan(19);
    const cmds = roadPlanCommands(res.plan, 0);
    expect(cmds.at(-1)).toMatchObject({ col: res.plan.to.col, row: 20, special: true });
    expect(cmds.slice(1, -1).every((c) => !('special' in c))).toBe(true);
  });

  it('takes an end flag of the clicked road when that is quicker', () => {
    const st = roadOnRow20();
    putFlag(st, 22, 20);
    const res = planRoad(st, st.players[0]!, { col: 22, row: 20 }, { col: 15, row: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.to).toEqual({ col: 20, row: 20 });
    expect(res.plan.newFlag).toBe(false);
  });

  it('lists the end flags and the flag spots of a road, but no tile next to a flag', () => {
    const st = roadOnRow20();
    const targets = roadTargets(st, st.players[0]!, 15, 20)!.map((p) => colOf(p, geo)).sort((a, b) => a - b);
    expect(targets).toContain(10);
    expect(targets).toContain(20);
    expect(targets).not.toContain(11);
    expect(targets).not.toContain(19);
    expect(roadTargets(st, st.players[0]!, 15, 25)).toBeNull();
    // A building's tile carries the path bit to its flag, but is no road.
    at(st, 14, 14).object = 2;
    at(st, 14, 14).paths = 1 << Direction.DownRight;
    expect(roadTargets(st, st.players[0]!, 14, 14)).toBeNull();
  });

  it('refuses a road that is not the player\'s', () => {
    const st = roadOnRow20();
    for (let col = 11; col <= 19; col++) at(st, col, 20).owner = 2;
    expect(planRoad(st, st.players[0]!, { col: 15, row: 15 }, { col: 15, row: 20 })).toEqual({
      ok: false,
      reason: 'notOwnTarget',
    });
  });
});

/** Flags on (10,20) and (20,20), joined by a straight road along row 20. */
function roadOnRow20(): GameState {
  const st = state();
  putFlag(st, 10, 20);
  putFlag(st, 20, 20);
  putFlag(st, 15, 15);
  at(st, 10, 20).paths = 1 << Direction.Right;
  at(st, 20, 20).paths = 1 << Direction.Left;
  for (let col = 11; col <= 19; col++) at(st, col, 20).paths = (1 << Direction.Right) | (1 << Direction.Left);
  return st;
}

describe('road planner on a real game', () => {
  /**
   * A flag the player may build, about `dist` steps from `pos` in direction `dir` — the terrain of
   * the level decides, so the first fitting tile a little further on or to the side is taken.
   */
  function flagAt(st: GameState, pos: number, dir: Direction, dist: number): { col: number; row: number } {
    for (let extra = 0; extra < 4; extra++) {
      let p = pos;
      for (let i = 0; i < dist + extra; i++) p = neighbor(p, dir, st.geo);
      for (const side of [p, neighbor(p, Direction.Down, st.geo), neighbor(p, Direction.Right, st.geo)]) {
        const t = { col: colOf(side, st.geo), row: rowOf(side, st.geo) };
        if (applyCommand(st, { kind: 'buildFlag', ...t, player: 0 })) return t;
      }
    }
    throw new Error('no flag fits');
  }

  it('plants the flag, splits the old road and joins the new one — and needs the special click', () => {
    const st = startNewGame({ gameType: 0, levelSetupIndex: 15 });
    const p = st.players[0]!;
    const castle = st.buildings[p.castleBuilding]!;
    const castleFlag = neighbor(posOf(castle.col, castle.row, st.geo), Direction.DownRight, st.geo);
    const far = flagAt(st, castleFlag, Direction.Left, 6);
    const first = planRoad(st, p, { col: colOf(castleFlag, st.geo), row: rowOf(castleFlag, st.geo) }, far);
    if (!first.ok) throw new Error(first.reason);
    for (const cmd of roadPlanCommands(first.plan, 0)) expect(applyCommand(st, cmd)).toBe(true);

    const mid = first.plan.tiles[3]!;
    const branch = flagAt(st, posOf(mid.col, mid.row, st.geo), Direction.Down, 3);
    const res = planRoad(st, p, branch, mid);
    if (!res.ok) throw new Error(res.reason);
    expect(res.plan.newFlag).toBe(true);

    // Without the special click the last click is refused and the road is not built.
    const plain = structuredClone(st);
    const [begin, ...clicks] = roadPlanCommands(res.plan, 0);
    const cmds = [begin, ...clicks];
    const last = clicks.at(-1)!;
    for (const cmd of cmds.slice(0, -1)) applyCommand(plain, cmd);
    applyCommand(plain, { ...last, special: false });
    expect(plain.mapTiles[posOf(res.plan.to.col, res.plan.to.row, st.geo)]!.object).not.toBe(1);

    const flagsBefore = st.flags.filter(Boolean).length;
    for (const cmd of cmds) expect(applyCommand(st, cmd)).toBe(true);
    const target = st.mapTiles[posOf(res.plan.to.col, res.plan.to.row, st.geo)]!;
    expect(target.object).toBe(1);
    expect(st.flags.filter(Boolean).length).toBe(flagsBefore + 1);
    const flag = st.flags[target.objIndex]!;
    // Three roads meet at the new flag: the two halves of the old road and the new one.
    expect(flag.paths.filter(Boolean).length).toBe(3);
    expect(st.roadBuild[0]!.active).toBe(false);
  });
});

