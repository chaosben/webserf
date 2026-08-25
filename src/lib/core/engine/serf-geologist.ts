/**
 * Geologist — the two geologist-specific states: **42 LookingForGeoSpot** (find a mountain spot near
 * the flag) and **43 SamplingGeoSpot** (sample the ground and plant a mineral sign). Walking between
 * flag and spot goes through the shared `FreeWalking` (16) handler.
 *
 * Ported from `serf_state_43_SamplingGeoSpot @0x18eac` and
 * `serf_state_42_LookingForGeoSpot @0x19040`.
 *
 * ## The cycle
 * 42 picks a random spiral position around the flag; if it is an empty mountain tile (terrain 11..14
 * = tundra / lower snow) -> `FreeWalking` there (`dist = spiral coord`, `neg_dist = -coord`). At the
 * spot the geologist enters 43 (via `FreeWalking.dest_reached`, with `neg_dist1 = 0` and `dist` the
 * return vector). 43 samples: with a mineral present a sign object is planted (`0x70..0x77`),
 * otherwise "nothing found" (`0x78`). Then `FreeWalking` back to the flag (`neg_dist1 = -128`), from
 * where 42 looks for the next position — until 42 finds no fresh mountain spot (8 failed attempts) or
 * hits two existing signs, at which point `Walking` (dir1 = -2) takes it back into the network.
 *
 * ## Mineral sign encoding
 * Mineral byte `(mineral<<5)|amount`; sign sprite `0x6e + mineral*2 (+1 if amount < 12)` — gold
 * 0x70/0x71, iron 0x72/0x73, coal 0x74/0x75, stone 0x76/0x77; "empty" = 0x78.
 */

import { i8, subU16 } from './int.js';
import { posOf, neighbor, Direction } from './position.js';
import { SPIRAL_PATTERN, spiralPos } from './spiral.js';
import { addPlayerMessage } from './player-messages.js';
import type { GameState, Serf } from './state.js';

/**
 * Message type of the first geologist find (`addw $0xc,(%edi)` @0x18feb). The four types 12..15 are
 * gold/iron/coal/stone; the level filter puts all four on bit 4, i.e. visible from level 2 on.
 */
const MSG_GEOLOGIST_BASE = 12;

// Union field indices (stateData index = field offset - 0xb).
const DIR1 = 0; // 0xb
const DIST_ROW = 1; // 0xc
const NEG_DIST1 = 2; // 0xd
const NEG_DIST2 = 3; // 0xe
const FLAGS = 4; // 0xf
// (DIST_COL == the DIR1 slot 0xb; dist_col in FreeWalking's view, reused as dir1 by state 42.)

const gd = (serf: Serf, idx: number): number => i8(serf.stateData[idx]);
const sd = (serf: Serf, idx: number, value: number): void => {
  serf.stateData[idx] = value & 0xff;
};

const S_WALKING = 2;
const S_FREE_WALKING = 16;

/** Gebirgs-Terrain (Tundra0..2 + unterer Schnee): Typen 11..14 (`10 < t < 15`). */
function isMountain(terrain: number): boolean {
  return terrain > 10 && terrain < 15;
}

/**
 * `serf_state_43_SamplingGeoSpot @0x18eac` — sample the ground where the geologist stands. On the
 * first pass (`neg_dist1 == 0`) over an empty tile: read the mineral byte, plant the sign object
 * (mineral -> `0x70..0x77` plus the sampling animation; nothing -> `0x78`) and, if no sign of the
 * same kind is among the 59 nearest spiral neighbours, report the find. Then back to `FreeWalking`
 * for the return trip to the flag.
 *
 * **The find is reported** (`call 0x18234` @0x19005 = `add_player_message`). The type comes from the
 * sign just planted (@0x18fdb..@0x18feb): `subw $0x70` · `shrw $1` · `addw $0xc`, i.e.
 * `type = 12 + ((sign - 0x70) >> 1)` = **12..15** for gold/iron/coal/stone — the size variant `+1`
 * drops out in the shift. Arguments are the serf's tile (`serf+4` @0x18ff2) and `serf.owner & 3`
 * (@0x19000).
 */
export function samplingGeoSpot(state: GameState, serf: Serf): void {
 // Tick prologue (as in `advance`): pull the counter down, run the body on underflow.
  const delta = subU16(state.gameTick, serf.tick);
  serf.tick = state.gameTick;
  const oldCounter = serf.counter;
  serf.counter = subU16(oldCounter, delta);
  if (delta <= oldCounter) return; // not elapsed yet

  if (gd(serf, NEG_DIST1) === 0 && serf.col !== null && serf.row !== null) {
    const geo = state.geo;
    const pos = posOf(serf.col, serf.row, geo);
    const tile = state.mapTiles[pos];
    if (tile.object === 0) {
      const mineralByte = ((tile.mineral & 7) << 5) | (tile.resourceAmount & 0x1f);
      if (mineralByte === 0) {
        tile.object = 0x78; // „nichts gefunden"-Schild
      } else {
        const amount = mineralByte & 0x1f;
        let signOff = (mineralByte & 0xe0) >> 4; // = mineral·2
        if (amount < 0xc) signOff += 1; // kleines Vorkommen → +1
        sd(serf, NEG_DIST1, 0xff); // toggle ~0 (beprobt-Marker)
        const sign = (signOff + 0x6e) & 0xff; // 0x70..0x77
        tile.object = sign;
        serf.animation = 0x8e;
 // Scan the 59 nearest spiral neighbours for a sign of the same kind (`&0x7e` = mineral type without size).
        const signType = sign & 0x7e;
        let duplicate = false;
        for (let i = 1; i <= 59; i++) {
          if ((state.mapTiles[spiralPos(pos, i, geo)].object & 0x7e) === signType) {
            duplicate = true;
            break;
          }
        }
        if (!duplicate) {
 // `call 0x18234` @0x19005 — type from the sign, position = the serf's own tile.
          const player = state.players[serf.owner & 3];
          if (player) addPlayerMessage(player, MSG_GEOLOGIST_BASE + ((sign - 0x70) >> 1), pos);
        }
        const old = serf.counter;
        serf.counter = (serf.counter + 0x40) & 0xffff;
        if (old > 0xffbf) return; // the sampling animation continues (state 43 stays)
      }
    }
  }

 // Back to the flag: FreeWalking with the return marker (dist_col/row hold the return vector).
  sd(serf, NEG_DIST1, 0x80); // -128 = on the way back
  sd(serf, NEG_DIST2, 0);
  sd(serf, FLAGS, 0);
  serf.state = S_FREE_WALKING;
  serf.counter = 0;
}

/**
 * `serf_state_42_LookingForGeoSpot @0x19040` — check up to 8 random spiral positions around the
 * flag. The first empty mountain tile (its own or its UpLeft triangle is mountain) -> `FreeWalking`
 * there. Two existing mineral signs (`0x70..0x78`) along the way -> the area counts as explored,
 * give up. No spot found -> `Walking` (dir1 = -2) back into the network.
 *
 * **No tick prologue** — the original checks no counter here, the handler runs immediately.
 *
 * **Limit of verification:** this is RNG driven, and the global RNG is clocked by *all* subsystems,
 * so the *concrete* choice of spot can differ from the original even though every draw here is
 * faithful. Functionally (find a mountain spot, correct transitions) the handler matches.
 */
export function lookingForGeoSpot(state: GameState, serf: Serf): void {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const basePos = posOf(serf.col, serf.row, geo);
  let outer = 7; // 8 attempts (7..0)
  let signBudget = 2; // give up after finding 2 signs
  let foundEntry = -1;

  do {
    const rnd = state.rng.next();
    const entry = ((rnd >> 2) & 0x3f) + 1; // spiral entry 1..64
    const cand = spiralPos(basePos, entry, geo);
    const obj = state.mapTiles[cand].object;
    if (obj === 0) {
      const t = state.mapTiles[cand];
      if (isMountain(t.terrainDown) || isMountain(t.terrainUp)) {
        foundEntry = entry;
        break;
      }
      const up = state.mapTiles[neighbor(cand, Direction.UpLeft, geo)];
      if (isMountain(up.terrainDown) || isMountain(up.terrainUp)) {
        foundEntry = entry;
        break;
      }
    } else if (obj >= 0x70 && obj < 0x79) {
      signBudget -= 1;
      if (signBudget === 0) break;
    }
    outer -= 1;
  } while (outer !== 0);

  if (foundEntry >= 0) {
    const [dc, dr] = SPIRAL_PATTERN[foundEntry];
    sd(serf, DIR1, dc); // dist_col
    sd(serf, DIST_ROW, dr);
    sd(serf, NEG_DIST1, -dc);
    sd(serf, NEG_DIST2, -dr);
    sd(serf, FLAGS, 0);
    serf.state = S_FREE_WALKING;
    serf.tick = state.gameTick;
    return;
  }

 // No mountain spot -> walk back into the network (Walking, dir1 = -2 -> find_inventory).
  sd(serf, DIR1, 0xfe); // dir1 = -2
  sd(serf, DIST_ROW, 0);
  sd(serf, NEG_DIST1, 0);
  sd(serf, NEG_DIST2, 0);
  sd(serf, FLAGS, 0);
  serf.state = S_WALKING;
  serf.counter = 0;
}
