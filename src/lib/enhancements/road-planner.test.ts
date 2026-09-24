import { describe, it, expect } from 'vitest';
import { planRoad, roadPlanCommands, stepCounter } from './road-planner.js';
import { createRoadBuildingState } from '../core/engine/road-building.js';
import { mapGeometry, posOf, Direction } from '../core/engine/position.js';
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
    expect(planRoad(st, p, { col: 10, row: 10 }, { col: 20, row: 20 })).toEqual({
      ok: false,
      reason: 'notOwnFlag',
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
});
