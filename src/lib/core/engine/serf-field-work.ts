/**
 * Field work and planning searches — the serf state handlers of the field workers (lumberjack,
 * forester, stonecutter, fisher, farmer).
 *
 * State -> routine: 18 PlanningLogging (@0x1f23f) · 19 PlanningPlanting (@0x1f352) ·
 * 21 PlanningStoneCutting (@0x1c11a) · 31 PlanningFishing (@0x1a574) · 33 PlanningFarming (@0x1a138) ·
 * 17 Logging (@0x1f151) · 20 Planting (@0x1f072) · 32 Fishing (@0x1a408) · 34 Farming (@0x1a03d) ·
 * 23 StoneCutting (@0x1c25f). Shared find epilogue: `planningReadyToLeave`.
 *
 * The counter primitives and the exit step `stepOutToFlag` come from `serf-machine.ts`, which also
 * holds the jump table and dispatch that wire these handlers up.
 */
import type { GameState, Serf } from './state.js';
import { posOf, colOf, rowOf, neighbor, Direction } from './position.js';
import { subU16, i16 } from './int.js';
import { COUNTER_FROM_ANIMATION } from './serf-tables.js';
import { spiralPos, SPIRAL_PATTERN } from './spiral.js';
import { advance, addCounter, addCounterContinue, stepOutToFlag } from './serf-machine.js';

// All of these mutate the map object byte (`landscape[pos+3]`); bit 7 (water marker) is not carried
// in the model, and every value written is < 0x80. Union = FreeWalking view: dist_col(0xb) =
// stateData[0], dist_row(0xc) = [1], neg_dist1(0xd) = [2], neg_dist2(0xe) = [3], flags(0xf) = [4].

/**
 * Shared find epilogue of the planning states (18/19/21/31/33): put the spiral target into the
 * leaving_building union, set state 7 ReadyToLeave and step out immediately. `field_B` is shifted by
 * one because the FreeWalking start lies one tile (DownRight, towards the flag) away from the
 * building.
 */
function planningReadyToLeave(state: GameState, serf: Serf, dist: number, nextState: number): void {
  const [col, row] = SPIRAL_PATTERN[dist];
  serf.stateData[0] = (col - 1) & 0xff;
  serf.stateData[1] = (row - 1) & 0xff;
  serf.stateData[2] = -(col - 1) & 0xff;
  serf.stateData[3] = -(row - 1) & 0xff;
  serf.stateData[4] = nextState & 0xff;
  serf.state = 7; // ReadyToLeave
  stepOutToFlag(state, serf);
}

/** Does the tile have a water triangle? (terrain types 0..3 are water) */
function hasWaterTri(t: { terrainUp: number; terrainDown: number }): boolean {
  return t.terrainUp <= 3 || t.terrainDown <= 3;
}

// 18 PlanningLogging (@0x1f23f) — spiral search for a tree object (8..23).
export const planningLogging = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const geo = state.geo;
  const pos = posOf(serf.col, serf.row, geo);
  for (;;) {
    const dist = ((state.rng.next() >> 2) & 0x7f) + 1;
    const obj = state.mapTiles[spiralPos(pos, dist, geo)].object;
    if (obj >= 8 && obj <= 23) {
      planningReadyToLeave(state, serf, dist, 0x10); // FreeWalking
      return;
    }
    if (!addCounterContinue(serf, 400)) return;
  }
};

// 19 PlanningPlanting (@0x1f352) — Spiral-Suche nach leerem Gras-Feld (Objekt 0, wegfrei, beide Dreiecke
// Grass1 on the tile and its UpLeft neighbour).
export const planningPlanting = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const geo = state.geo;
  const pos = posOf(serf.col, serf.row, geo);
  for (;;) {
    const dist = ((state.rng.next() >> 2) & 0x7f) + 1;
    const dp = spiralPos(pos, dist, geo);
    const t = state.mapTiles[dp];
    const up = state.mapTiles[neighbor(dp, Direction.UpLeft, geo)];
    if (
      (t.paths & 0x3f) === 0 &&
      t.object === 0 &&
      t.terrainUp === 5 &&
      t.terrainDown === 5 &&
      up.terrainUp === 5 &&
      up.terrainDown === 5
    ) {
      planningReadyToLeave(state, serf, dist, 0x10); // FreeWalking
      return;
    }
    if (!addCounterContinue(serf, 700)) return;
  }
};

// 21 PlanningStoneCutting (@0x1c11a) — spiral search for a stone object (72..79) on the UpLeft tile of
// Ziels, Ziel selbst begehbar → ReadyToLeave/**StoneCutterFreeWalking (22)**.
export const planningStoneCutting = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const geo = state.geo;
  const pos = posOf(serf.col, serf.row, geo);
  for (;;) {
    const dist = ((state.rng.next() >> 2) & 0x7f) + 1;
    const dp = spiralPos(pos, dist, geo);
    const uobj = state.mapTiles[neighbor(dp, Direction.UpLeft, geo)].object;
    // can_pass approximation: the target object itself is passable (the original tests byte 0 bit 6).
    if (uobj >= 72 && uobj <= 79 && state.mapTiles[dp].object === 0) {
      planningReadyToLeave(state, serf, dist, 0x16); // StoneCutterFreeWalking (22)
      return;
    }
    if (!addCounterContinue(serf, 100)) return;
  }
};

// 31 PlanningFishing (@0x1a574) — spiral search for a lake shore (empty, road-free tile with a water
// Dreieck neben Land) → ReadyToLeave/FreeWalking.
export const planningFishing = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const geo = state.geo;
  const pos = posOf(serf.col, serf.row, geo);
  for (;;) {
    const dist = ((state.rng.next() >> 2) & 0x3f) + 1;
    const dp = spiralPos(pos, dist, geo);
    const t = state.mapTiles[dp];
    if (t.object === 0 && (t.paths & 0x3f) === 0) {
      const upLeft = state.mapTiles[neighbor(dp, Direction.UpLeft, geo)];
      const left = state.mapTiles[neighbor(dp, Direction.Left, geo)];
      const up = state.mapTiles[neighbor(dp, Direction.Up, geo)];
      if (
        (t.terrainDown <= 3 && upLeft.terrainUp >= 4) ||
        (left.terrainDown <= 3 && up.terrainUp >= 4)
      ) {
        planningReadyToLeave(state, serf, dist, 0x10); // FreeWalking
        return;
      }
    }
    if (!addCounterContinue(serf, 100)) return;
  }
};

// 33 PlanningFarming (@0x1a138) — Spiral-Suche (dist = ((rng>>2)&0x1f)+7) nach einem Acker-Platz: entweder
// an existing field (object 110 or 121..126) OR a free Grass1 tile with no large building in the
// Nachbarn → ReadyToLeave/FreeWalking.
export const planningFarming = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const geo = state.geo;
  const pos = posOf(serf.col, serf.row, geo);
  const notLB = (p: number): boolean => {
    const o = state.mapTiles[p].object;
    return o !== 3 && o !== 4; // no LargeBuilding/Castle
  };
  for (;;) {
    const dist = ((state.rng.next() >> 2) & 0x1f) + 7;
    const dp = spiralPos(pos, dist, geo);
    const t = state.mapTiles[dp];
    const existingField = t.object === 110 || (t.object >= 121 && t.object <= 126);
    let emptyGrass = false;
    if (t.object === 0 && t.terrainUp === 5 && t.terrainDown === 5 && (t.paths & 0x3f) === 0) {
      const left = state.mapTiles[neighbor(dp, Direction.Left, geo)];
      const upLeft = state.mapTiles[neighbor(dp, Direction.UpLeft, geo)];
      const up = state.mapTiles[neighbor(dp, Direction.Up, geo)];
      emptyGrass =
        notLB(neighbor(dp, Direction.Right, geo)) &&
        notLB(neighbor(dp, Direction.DownRight, geo)) &&
        notLB(neighbor(dp, Direction.Down, geo)) &&
        left.terrainDown === 5 &&
        notLB(neighbor(dp, Direction.Left, geo)) &&
        upLeft.terrainUp === 5 &&
        upLeft.terrainDown === 5 &&
        notLB(neighbor(dp, Direction.UpLeft, geo)) &&
        up.terrainUp === 5 &&
        notLB(neighbor(dp, Direction.Up, geo));
    }
    if (existingField || emptyGrass) {
      planningReadyToLeave(state, serf, dist, 0x10); // FreeWalking
      return;
    }
    if (!addCounterContinue(serf, 500)) return;
  }
};

// 17 Logging (@0x1f151) — fell a tree: for 5 frames set the map object to the falling-tree sequence
// (`0x5c + frame`, +5 when `neg_dist1 != 0`, i.e. broadleaf rather than pine), then FreeWalking back.
export const logging = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  for (;;) {
    serf.stateData[3] = (serf.stateData[3] + 1) & 0xff; // neg_dist2 (Frame) += 1
    const frame = serf.stateData[3];
    let obj = (0x5c + frame) & 0xff;
    if (serf.stateData[2] !== 0) obj = (obj + 5) & 0xff; // neg_dist1 != 0 → FelledTree statt FelledPine
    state.mapTiles[pos].object = obj;
    if (frame === 5) break;
    serf.animation = (0x74 + frame) & 0xff;
    if (!addCounterContinue(serf, COUNTER_FROM_ANIMATION[serf.animation] ?? 0)) return;
  }
  serf.stateData[2] = 0x80; // neg_dist1 = -128 (way back)
  serf.stateData[3] = 1; // neg_dist2 = 1
  serf.stateData[4] = 0; // flags
  serf.state = 0x10; // FreeWalking
  serf.counter = 0;
};

// 20 Planting (@0x1f072) — the forester plants a sapling (`0x67 + (rng&1)`) on an empty, road-free tile,
// dann FreeWalking. `neg_dist2`-Toggle: erste Iteration pflanzt, zweite (neg_dist2 != 0) beendet.
export const planting = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  for (;;) {
    if (serf.stateData[3] !== 0) {
      // neg_dist2 != 0 → fertig
      serf.stateData[2] = 0x80;
      serf.stateData[3] = 0;
      serf.stateData[4] = 0;
      serf.state = 0x10;
      serf.counter = 0;
      return;
    }
    serf.animation = 0x7a;
    let obj = 0x67;
    if (state.rng.next() & 1) obj += 1; // NewPine oder NewTree
    const t = state.mapTiles[pos];
    if (t.object === 0 && (t.paths & 0x3f) === 0) t.object = obj;
    serf.stateData[3] = ~serf.stateData[3] & 0xff; // Toggle → 0xff
    if (!addCounterContinue(serf, 0x80)) return;
  }
};

// 32 Fishing (@0x1a408) — the fisher casts: odd `neg_dist1` steps cast (RNG catch against the fish
// stock of the water tile), even ones swing back. A catch sets `neg_dist2 = 1`. Ends at
// Fang oder `flags == 10` → FreeWalking.
export const fishing = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const geo = state.geo;
  for (;;) {
    if (serf.stateData[3] !== 0 || (serf.stateData[4] & 0xff) === 0x0a) {
      serf.stateData[2] = 0x80; // neg_dist1 = -128
      serf.stateData[4] = 0; // flags
      serf.state = 0x10;
      serf.counter = 0;
      return;
    }
    serf.stateData[2] = (serf.stateData[2] + 1) & 0xff; // neg_dist1 += 1
    if ((serf.stateData[2] & 1) === 0) {
      // even: swing back
      serf.animation = (serf.animation - 2) & 0xff;
      if (addCounter(serf, 0x300)) return;
      continue;
    }
    // ungerade → Angel auswerfen
    const pos = posOf(serf.col, serf.row, geo);
    let dir: number;
    if (serf.animation === 0x83) {
      dir = hasWaterTri(state.mapTiles[neighbor(pos, Direction.Left, geo)])
        ? Direction.Left
        : Direction.Down;
    } else {
      dir = hasWaterTri(state.mapTiles[neighbor(pos, Direction.Right, geo)])
        ? Direction.Right
        : Direction.DownRight;
    }
    const ft = state.mapTiles[neighbor(pos, dir, geo)];
    const rawRes = ((ft.mineral & 7) << 5) | (ft.resourceAmount & 0x1f);
    if (rawRes !== 0) {
      if ((state.rng.next() & 0x3f) < rawRes + 4) {
        const dec = (rawRes - 1) & 0xff;
        ft.mineral = (dec >> 5) & 7;
        ft.resourceAmount = dec & 0x1f;
        serf.stateData[3] = 1; // neg_dist2 = 1 + Fish(0)
      }
    }
    serf.stateData[4] = (serf.stateData[4] + 1) & 0xff; // flags += 1
    serf.animation = (serf.animation + 2) & 0xff;
    if (addCounter(serf, 0x80)) return;
  }
};

// 34 Farming (@0x1a03d) — the farmer sows or harvests: `neg_dist1 == 0` sows `0x69` on an empty,
// road-free tile; otherwise harvest (`object + 1`, ripeness sequence with wrap 0x6f->0x79,
// 0x70/0x7f->0x6f). On harvest `neg_dist2 = 1`, so the carried resource is wheat.
export const farming = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return;
  const t = state.mapTiles[posOf(serf.col, serf.row, state.geo)];
  if (serf.stateData[2] === 0) {
    // sow
    if (t.object === 0 && (t.paths & 0x3f) === 0) t.object = 0x69;
  } else {
    // ernten
    serf.stateData[3] = 1; // neg_dist2 = 1
    let b = (t.object + 1) & 0xff;
    if (b === 0x6f) b = 0x79;
    else if (b === 0x70 || b === 0x7f) b = 0x6f;
    t.object = b;
  }
  serf.stateData[2] = 0x80; // neg_dist1 = -128 (way back)
  serf.stateData[4] = 0; // flags
  serf.state = 0x10; // FreeWalking
  serf.counter = 0;
};

// 23 StoneCutting (@0x1c25f) — the stonecutter mines a stone. Two phases via `neg_dist1`: 0 = approach
// (wait until the counter drops below the u16 threshold `neg_dist2|flags<<8`, then cutting anim 0x7b), 1 =
// Abbau (Stein-Objekt dekrementieren `object+1`, bei 0x4f → entfernen; einen Schritt DownRight; neg_dist1
// = 2), 2 = done. The u16 threshold read included.
export const stoneCutting = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  if (serf.stateData[2] === 0) {
    // Anmarsch-Phase
    serf.counter = subU16(serf.counter, delta);
    const thresh = (serf.stateData[3] | (serf.stateData[4] << 8)) & 0xffff;
    if (i16(serf.counter) >= i16(thresh)) return; // Counter >= Schwelle → weiter warten
    serf.counter = subU16(serf.counter, (thresh + 1) & 0xffff);
    serf.stateData[2] = 1; // neg_dist1 = 1
    serf.animation = 0x7b;
    if (addCounter(serf, 0x600)) return;
  } else {
    const old = serf.counter;
    serf.counter = subU16(old, delta);
    if (delta <= old) return; // not yet elapsed
  }
  for (;;) {
    if (serf.stateData[2] !== 1) {
      // neg_dist1 != 1 → fertig
      serf.stateData[2] = 0x80;
      serf.stateData[3] = 1;
      serf.stateData[4] = 0;
      serf.state = 0x10;
      serf.counter = 0;
      return;
    }
    const pos = posOf(serf.col!, serf.row!, geo);
    const flagTile = neighbor(pos, Direction.DownRight, geo);
    if (state.mapTiles[flagTile].serfIndex !== 0) {
      serf.counter = 0; // Feld blockiert → warten
      return;
    }
    const obj = state.mapTiles[pos].object;
    if (obj === 0x4f) state.mapTiles[pos].object = 0; // letzter Stein → entfernen
    else state.mapTiles[pos].object = (obj + 1) & 0xff; // Stein-Haufen verkleinern
    // Schritt DownRight (start_walking).
    state.mapTiles[pos].serfIndex = 0;
    state.mapTiles[flagTile].serfIndex = serf.index;
    serf.col = colOf(flagTile, geo);
    serf.row = rowOf(flagTile, geo);
    const anim = (state.mapTiles[flagTile].height - state.mapTiles[pos].height + 0xd) & 0xff;
    serf.animation = anim;
    const base = COUNTER_FROM_ANIMATION[anim] ?? 0;
    serf.tick = state.gameTick;
    serf.stateData[2] = 2; // neg_dist1 = 2
    if (addCounter(serf, ((base >> 2) * 3) & 0xffff)) return;
  }
};
