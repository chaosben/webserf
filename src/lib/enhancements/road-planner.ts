/**
 * **Road planner** — the search behind the road assistant. OUR OWN ADDITION, with no counterpart in
 * the original.
 *
 * It only READS the game state. Building is left to the caller, which replays the plan as the
 * player's own road-building clicks; the plan therefore has to contain exactly the steps the
 * interactive road builder would accept, and nothing it would treat differently:
 *
 * - a step is allowed where the marker pass allows it (`neighbourAllowed`, plus the owner test in
 *   front of it) — the same predicate, not a copy of it;
 * - an intermediate tile carries NO path and NO flag. A tile with a path is allowed by the marker
 *   pass, but a plain click on it is rejected (only a special click would build a flag there), and a
 *   flag would end the road;
 * - no step leaves along an edge whose path bit is already set: the click takes that as a BACK STEP,
 *   even at the start flag, where the marker pass does not look;
 * - every edge must be LAND (`segmentTerrainBit`). A mixed road fails the commit, and a pure water
 *   road would need a sailor — both left out here.
 *
 * **A road as the target.** Clicked on a road instead of a flag, the planner takes every tile of that
 * road as a possible end: its two end flags, and each tile in between where the original's special
 * click would plant a flag. The last click of such a plan IS that special click — in road-building
 * mode it builds the flag, splits the old road and commits the new one (@0x2a840 ff., Handbuch S. 35),
 * so no step of its own is needed. The gate of a tile is that click's gate, taken from the same
 * predicates (`classifyBuildSite` possibility and flag lock, `isRoadSegmentClearable`). It is asked
 * BEFORE the new road is drawn; the click asks it again, and a refusal there ends in the caller's
 * ordinary failure path.
 *
 * **What "best" means.** The walking time of a carrier who goes the road there AND back: per step
 * the counter a serf pays in `moveStep` (`COUNTER_FROM_ANIMATION[4 + 9·dir + dH]`). One direction
 * alone would be wrong: a steep climb one way is a descent the other, and a carrier walks both.
 */
import type { GameState, Player } from '../core/engine/state.js';
import { posOf, neighbor, oppositeDir, colOf, rowOf, type Direction } from '../core/engine/position.js';
import { neighbourAllowed, segmentTerrainBit } from '../core/engine/road-building.js';
import { isRoadSegmentClearable, lengthToCategory } from '../core/engine/road-teardown.js';
import { classifyBuildSite, CURSOR_FLAG, CURSOR_REMOVABLE_FLAG } from '../core/engine/build-site.js';
import { COUNTER_FROM_ANIMATION } from '../core/engine/serf-tables.js';
import type { Command } from '../core/engine/commands.js';

export interface TilePoint {
  readonly col: number;
  readonly row: number;
}

export interface RoadPlan {
  /** The start flag's tile. */
  readonly from: TilePoint;
  /** The tile the road ends on: a flag, or the road tile that gets a new flag (`newFlag`). */
  readonly to: TilePoint;
  /** The road ends on an existing road; the last click plants a flag there and splits it. */
  readonly newFlag: boolean;
  /** One direction per step, from `from` to `to`. */
  readonly dirs: readonly Direction[];
  /** Every tile of the road, both flags included (`dirs.length + 1` entries). */
  readonly tiles: readonly TilePoint[];
  /** Height step per road step (`height[next] - height[prev]`). */
  readonly slopes: readonly number[];
  /** Counter ticks from `from` to `to`. */
  readonly forward: number;
  /** Counter ticks back from `to` to `from`. */
  readonly backward: number;
  /** The road-length category the commit will write (`flag.length[dir]` bits 4..6). */
  readonly category: number;
}

/** Why no plan came out — the panel says it in words. */
export type RoadPlanRefusal = 'notOwnFlag' | 'notOwnTarget' | 'sameFlag' | 'noFlagSpot' | 'noRoute';

export type RoadPlanResult =
  | { readonly ok: true; readonly plan: RoadPlan }
  | { readonly ok: false; readonly reason: RoadPlanRefusal };

/** The counter one step costs a walking serf — the lookup `moveStep` makes, with its guard. */
export function stepCounter(dir: Direction, dH: number): number {
  const anim = 4 + 9 * dir + dH;
  return (anim >= 0 && anim < COUNTER_FROM_ANIMATION.length ? COUNTER_FROM_ANIMATION[anim]! : 0) & 0xffff;
}

/**
 * Is `(col,row)` a flag this player can start a road from? The same gate `beginRoadBuilding` applies
 * (cursor type 1 or 2), so a plan never begins where the first command would be refused.
 */
export function isOwnFlag(state: GameState, player: Player, col: number, row: number): boolean {
  const tile = state.mapTiles[posOf(col, row, state.geo)];
  if (tile === undefined || tile.object !== 1 || tile.owner !== player.slot + 1) return false;
  const kind = classifyBuildSite(state, player, col, row).cursorType;
  return kind === CURSOR_FLAG || kind === CURSOR_REMOVABLE_FLAG;
}

/**
 * Can the special click of road building plant a flag on this road tile? The gate of the click
 * branch @0x2a838 ff. (`road-building.ts`), not a copy of it.
 */
function flagSpotOnRoad(state: GameState, player: Player, col: number, row: number): boolean {
  const site = classifyBuildSite(state, player, col, row);
  return site.possibility >= 1 && !site.flagBlocked && isRoadSegmentClearable(state, col, row);
}

/**
 * Every tile a road from elsewhere may end on, for a click on `(col,row)`: an own flag stands for
 * itself; an own road tile stands for its whole road — both end flags plus each tile in between that
 * takes a flag. `null` when the tile is neither.
 */
export function roadTargets(state: GameState, player: Player, col: number, row: number): number[] | null {
  const geo = state.geo;
  const tiles = state.mapTiles;
  const pos = posOf(col, row, geo);
  const tile = tiles[pos];
  if (tile === undefined) return null;
  if (tile.object === 1) return isOwnFlag(state, player, col, row) ? [pos] : null;
  const paths = tile.paths & 0x3f;
  // A building's tile carries the path bit to its flag too (DownRight), but it is no road.
  if (tile.object >= 2 && tile.object <= 4) return null;
  if (paths === 0 || tile.owner !== player.slot + 1) return null;

  const out: number[] = [];
  const consider = (p: number): void => {
    const t = tiles[p]!;
    const c = colOf(p, geo);
    const r = rowOf(p, geo);
    if (t.object === 1 ? isOwnFlag(state, player, c, r) : flagSpotOnRoad(state, player, c, r)) out.push(p);
  };
  consider(pos);
  for (let d = 0; d < 6; d++) {
    if ((paths & (1 << d)) === 0) continue;
    // Walk the road away from the clicked tile up to its end flag. An inner road tile carries
    // exactly two path bits: the one it was entered by, and the way on.
    let dir = d as Direction;
    let p = pos;
    for (let guard = 0; guard < tiles.length; guard++) {
      p = neighbor(p, dir, geo);
      if (p === pos) break;
      consider(p);
      const t = tiles[p]!;
      if (t.object === 1) break;
      const on = (t.paths & 0x3f) & ~(1 << oppositeDir(dir));
      if (on === 0) break;
      dir = (31 - Math.clz32(on & -on)) as Direction;
    }
  }
  return out;
}

/**
 * The quickest land road from an own flag to a target, or why there is none. The target is an own
 * flag, or an own road (see {@link roadTargets}); the plan ends on whichever of its tiles is quickest.
 *
 * Dijkstra over tiles; the owner test confines it to the player's land, so the search stays small
 * even on the largest map. Ties are broken by position, so the same state always yields the same
 * plan.
 */
export function planRoad(
  state: GameState,
  player: Player,
  from: TilePoint,
  to: TilePoint,
): RoadPlanResult {
  const geo = state.geo;
  if (!isOwnFlag(state, player, from.col, from.row)) return { ok: false, reason: 'notOwnFlag' };
  const start = posOf(from.col, from.row, geo);
  const targets = roadTargets(state, player, to.col, to.row);
  if (targets === null) return { ok: false, reason: 'notOwnTarget' };
  const goals = new Set(targets.filter((p) => p !== start));
  if (goals.size === 0) {
    return { ok: false, reason: posOf(to.col, to.row, geo) === start ? 'sameFlag' : 'noFlagSpot' };
  }

  const owner = player.slot + 1;
  const tiles = state.mapTiles;
  const height = (p: number): number => tiles[p]!.height & 0x1f;

  const cost = new Map<number, number>([[start, 0]]);
  const cameBy = new Map<number, Direction>();
  const done = new Set<number>();
  const heap = new MinHeap();
  heap.push(0, start);

  let goal = -1;
  while (heap.size > 0) {
    const [c, pos] = heap.pop();
    if (done.has(pos)) continue;
    done.add(pos);
    if (goals.has(pos)) {
      goal = pos;
      break;
    }
    const paths = tiles[pos]!.paths & 0x3f;
    const h = height(pos);
    for (let d = 0; d < 6; d++) {
      const dir = d as Direction;
      if ((paths & (1 << dir)) !== 0) continue; // the click would take it as a back step
      const np = neighbor(pos, dir, geo);
      if (done.has(np)) continue;
      const tile = tiles[np]!;
      if (tile.owner !== owner) continue;
      if (goals.has(np)) {
        if ((tile.paths & (1 << oppositeDir(dir))) !== 0) continue;
      } else if (tile.object === 1 || (tile.paths & 0x3f) !== 0) {
        continue;
      }
      if (!neighbourAllowed(state, player, np, {})) continue;
      if (segmentTerrainBit(state, pos, dir, geo) !== 1) continue;
      const dH = height(np) - h;
      const next = c + stepCounter(dir, dH) + stepCounter(oppositeDir(dir), -dH);
      const known = cost.get(np);
      if (known !== undefined && known <= next) continue;
      cost.set(np, next);
      cameBy.set(np, dir);
      heap.push(next, np);
    }
  }

  if (goal < 0) return { ok: false, reason: 'noRoute' };

  const dirs: Direction[] = [];
  for (let p = goal; p !== start; ) {
    const d = cameBy.get(p)!;
    dirs.push(d);
    p = neighbor(p, oppositeDir(d), geo);
  }
  dirs.reverse();

  const points: TilePoint[] = [from];
  const slopes: number[] = [];
  let forward = 0;
  let backward = 0;
  let p = start;
  for (const d of dirs) {
    const np = neighbor(p, d, geo);
    const dH = height(np) - height(p);
    slopes.push(dH);
    forward += stepCounter(d, dH);
    backward += stepCounter(oppositeDir(d), -dH);
    points.push({ col: colOf(np, geo), row: rowOf(np, geo) });
    p = np;
  }

  return {
    ok: true,
    plan: {
      from,
      to: { col: colOf(goal, geo), row: rowOf(goal, geo) },
      newFlag: tiles[goal]!.object !== 1,
      dirs,
      tiles: points,
      slopes,
      forward,
      backward,
      category: lengthToCategory(dirs.length),
    },
  };
}

/** Binary min-heap over `(cost, pos)`; `pos` breaks ties so the order is deterministic. */
class MinHeap {
  readonly #cost: number[] = [];
  readonly #pos: number[] = [];

  get size(): number {
    return this.#cost.length;
  }

  push(cost: number, pos: number): void {
    const c = this.#cost;
    const p = this.#pos;
    c.push(cost);
    p.push(pos);
    let i = c.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.#less(i, up)) break;
      this.#swap(i, up);
      i = up;
    }
  }

  pop(): [number, number] {
    const c = this.#cost;
    const p = this.#pos;
    const top: [number, number] = [c[0]!, p[0]!];
    const lastC = c.pop()!;
    const lastP = p.pop()!;
    if (c.length > 0) {
      c[0] = lastC;
      p[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < c.length && this.#less(l, m)) m = l;
        if (r < c.length && this.#less(r, m)) m = r;
        if (m === i) break;
        this.#swap(i, m);
        i = m;
      }
    }
    return top;
  }

  #less(a: number, b: number): boolean {
    const c = this.#cost;
    return c[a]! < c[b]! || (c[a] === c[b] && this.#pos[a]! < this.#pos[b]!);
  }

  #swap(a: number, b: number): void {
    const c = this.#cost;
    const p = this.#pos;
    [c[a], c[b]] = [c[b]!, c[a]!];
    [p[a], p[b]] = [p[b]!, p[a]!];
  }
}

/**
 * The plan as the clicks a player would make: start road building on the start flag, then one click
 * per step. The last click lands on the target flag, which commits the road — or, for a new flag, is
 * the special click that plants it.
 */
export function roadPlanCommands(
  plan: RoadPlan,
  player: number,
): [Extract<Command, { kind: 'beginRoadBuilding' }>, ...Extract<Command, { kind: 'roadBuildClick' }>[]] {
  return [
    { kind: 'beginRoadBuilding', col: plan.from.col, row: plan.from.row, player },
    ...plan.tiles.slice(1).map((t, i, rest) => ({
      kind: 'roadBuildClick' as const,
      col: t.col,
      row: t.row,
      player,
      ...(plan.newFlag && i === rest.length - 1 ? { special: true } : {}),
    })),
  ];
}
