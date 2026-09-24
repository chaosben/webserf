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
 * **What "best" means.** The walking time of a carrier who goes the road there AND back: per step
 * the counter a serf pays in `moveStep` (`COUNTER_FROM_ANIMATION[4 + 9·dir + dH]`). One direction
 * alone would be wrong: a steep climb one way is a descent the other, and a carrier walks both.
 */
import type { GameState, Player } from '../core/engine/state.js';
import { posOf, neighbor, oppositeDir, colOf, rowOf, type Direction } from '../core/engine/position.js';
import { neighbourAllowed, segmentTerrainBit } from '../core/engine/road-building.js';
import { lengthToCategory } from '../core/engine/road-teardown.js';
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
  /** The target flag's tile. */
  readonly to: TilePoint;
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
export type RoadPlanRefusal = 'notOwnFlag' | 'sameFlag' | 'noRoute';

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
 * The quickest land road from one own flag to another, or why there is none.
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
  if (!isOwnFlag(state, player, from.col, from.row) || !isOwnFlag(state, player, to.col, to.row)) {
    return { ok: false, reason: 'notOwnFlag' };
  }
  const start = posOf(from.col, from.row, geo);
  const goal = posOf(to.col, to.row, geo);
  if (start === goal) return { ok: false, reason: 'sameFlag' };

  const owner = player.slot + 1;
  const tiles = state.mapTiles;
  const height = (p: number): number => tiles[p]!.height & 0x1f;

  const cost = new Map<number, number>([[start, 0]]);
  const cameBy = new Map<number, Direction>();
  const done = new Set<number>();
  const heap = new MinHeap();
  heap.push(0, start);

  while (heap.size > 0) {
    const [c, pos] = heap.pop();
    if (done.has(pos)) continue;
    done.add(pos);
    if (pos === goal) break;
    const paths = tiles[pos]!.paths & 0x3f;
    const h = height(pos);
    for (let d = 0; d < 6; d++) {
      const dir = d as Direction;
      if ((paths & (1 << dir)) !== 0) continue; // the click would take it as a back step
      const np = neighbor(pos, dir, geo);
      if (done.has(np)) continue;
      const tile = tiles[np]!;
      if (tile.owner !== owner) continue;
      if (np === goal) {
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

  if (!done.has(goal)) return { ok: false, reason: 'noRoute' };

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
      to,
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
 * per step. The last click lands on the target flag, which commits the road.
 */
export function roadPlanCommands(
  plan: RoadPlan,
  player: number,
): [Extract<Command, { kind: 'beginRoadBuilding' }>, ...Extract<Command, { kind: 'roadBuildClick' }>[]] {
  return [
    { kind: 'beginRoadBuilding', col: plan.from.col, row: plan.from.row, player },
    ...plan.tiles.slice(1).map((t) => ({ kind: 'roadBuildClick' as const, col: t.col, row: t.row, player })),
  ];
}

/** Do two plans lay the same road? Compared before building, because the state moves between. */
export function samePlan(a: RoadPlan, b: RoadPlan): boolean {
  return (
    a.from.col === b.from.col &&
    a.from.row === b.from.row &&
    a.dirs.length === b.dirs.length &&
    a.dirs.every((d, i) => d === b.dirs[i])
  );
}
