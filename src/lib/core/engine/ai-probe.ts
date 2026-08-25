/**
 * The AI's map probing - `FUN_0005c54a`, the most important routine of the whole AI subsystem: steady
 * state calls it 7 out of 8 ticks, and in state 0 it finds the castle site.
 *
 * It picks a random tile 32 times and checks two things:
 * - branch A: the tile is mine (without a castle: belongs to nobody), free of objects and paths =>
 *   classify the build site and record a building candidate if something fits.
 * - branch B: the tile belongs to somebody else and carries a finished, active military building at
 *   threat level 3 => record an attack candidate if own land is in reach.
 *
 * Both branches leave immediately, so at most ONE candidate arises per call.
 *
 * The RANDOM CONSUMPTION is why this module had to be ported first: per round the routine draws two
 * values at the head, before any test runs, and rotates the first so its high half contributes real
 * bits on large maps. Without those draws the random stream of the whole game is wrong - and since the
 * AI sweep's random gate depends on it, so is the frame rotation.
 *
 * Both branches call the same surroundings survey and then their own evaluator, and neither chain
 * touches the random stream.
 *
 * The three cheap tile tests are a PREFILTER, not a criterion: owner, object class and paths are
 * checked again by the classifier, so a tile failing one of them falls through anyway. The prefilter
 * only saves the original the classifier's spiral. Reproduced because it is in the binary.
 *
 * The type mask per build possibility lives in `ai-candidates.ts`, where its consumer is.
 */
import type { GameState, Player } from './state.js';
import { u16 } from './int.js';
import { colOf, rowOf, posOf, decodePackedPos, encodePackedPos } from './position.js';
import type { MapGeometry } from './position.js';
import { spiralPos } from './spiral.js';
import { tilesPerRound } from './map-growth.js';
import {
  OBJECT_CLASS,
  CURSOR_CLEAR_BY_FLAG,
  classifyBuildSite,
  persistBuildSiteBits,
} from './build-site.js';
import { aiSurveySurroundings } from './ai-survey.js';
import { aiRecordAttackTargets, aiRecordBuildSite } from './ai-candidates.js';

/**
 * The position formula of the probe, @0x5c5ab..@0x5c5be:
 *
 * ```
 * 5c5ab call rng_next        # r1 -> low 16 bits of vreg7
 *       rorl $0x10, vreg7    # swap the halves, r1 moves up
 * 5c5b4 call rng_next        # r2 -> low 16 bits
 * 5c5b9 mov 0x34(%edi),%ebx  # gs
 * 5c5bc mov (%ebx),%eax      # gs[0] — the map mask
 * 5c5be and %eax,0x1c(%edi)  # vreg7 &= gs[0]
 * 5c5c1 mov 0x24(%edi),%ebx  # map base
 * 5c5c4 add 0x1c(%edi),%ebx  # + vreg7, so vreg7 is a BYTE OFFSET
 * 5c5c7 mov 0x1(%ebx),%al    # landscape byte 1 of the tile addressed that way
 * ```
 *
 * **`gs[0]` is not `(tileCount - 1) << 2`.** The map block is **row interleaved**: per row come first
 * `cols` landscape tuples of 4 B, then `cols` game tuples of 4 B. The row stride is therefore
 * `cols * 8`, not `cols * 4` — a byte offset carries the row at `rowShift + 1` with a **gap bit** in
 * between. The packed record position has exactly the same shape and is byte-verified.
 *
 * So the mask is `((rowMask << (rowShift+1)) | colMask) << 2` — `0x7efc` on 64x64, not `0x3ffc`. The
 * naive `(v >>> 2) & (tileCount-1)` reads the row from bits 8..13 instead of 9..14; both agree only
 * when seven consecutive bits are equal, i.e. in **2 of 128** cases, so it probes a different tile in
 * **98.4 %** of rounds — different candidate lists, different castle site, different build order.
 *
 * Reproduced in the original's three steps: mask, decode as a byte offset (`decodePackedPos`, the same
 * function that decodes record positions), and convert back to our canonical tile index.
 */
export function probeMask(geo: MapGeometry): number {
  return encodePackedPos(geo.colMask, geo.rowMask, geo);
}

export function probePosition(r1: number, r2: number, geo: MapGeometry): number {
  const off = ((((r1 << 16) | r2) >>> 0) & probeMask(geo)) >>> 0;
  const cr = decodePackedPos(off, geo);
 // `off` can never be `0xffffffff` (the mask clears the low two bits), so never `null`.
  return cr === null ? 0 : posOf(cr.col, cr.row, geo);
}

/** `mov $0x101` @0x5c8b? — counter of the reach spiral; the `jae` convention makes it 258 positions. */
const REACH_POSITIONS = 0x101 + 1;
/** `add $0x1c` on the spiral table — seven u32 entries skipped: centre plus ring 1. */
const REACH_FIRST_INDEX = 7;

/** `bld[4] & 0xfc` of the four military types. The mask keeps bit 7, so a site under construction falls through. */
const MILITARY_TYPES: readonly number[] = [11, 21, 22, 24]; // 0x2c, 0x54, 0x58, 0x60 >> 2

/** `bld[5] & 0x13 == 0x13` — threat level 3 (bits 0/1) AND active (bit 4). */
function isBorderMilitary(bld: { type: number; constructing: boolean; threatLevel: number; active: boolean }): boolean {
  if (bld.constructing) return false; // the 0xfc mask keeps bit 7, so no comparison matches
  if (!MILITARY_TYPES.includes(bld.type)) return false;
  return bld.threatLevel === 3 && bld.active;
}

/**
 * One probing pass. Returns whether a candidate was found — in the original the difference between the
 * two writing exits and the end of the loop. The caller does not need it; the test harnesses measure
 * against it.
 */
export function aiProbeMap(state: GameState, player: Player): boolean {
  const geo = state.geo;
 // `vreg6 = (gs[0x21c] << 3) - 1` @0x5c554. `gs+0x21c` is the tile count per growth round and
 // serves here as the probing budget.
  const budget = u16(u16(tilesPerRound(geo) << 3) - 1);
 // `vreg3 = (player.index + 4) << 5`, and **0** when `player+2` bit 0 is clear (no castle),
 // @0x5c562..@0x5c58f. Our tile owner is 1-based (0 = nobody).
  const hasCastle = (player.flags & 1) !== 0;
  const wantOwner = hasCastle ? player.slot + 1 : 0;

  for (let round = budget; ; round = u16(round - 1)) {
 // The two draws come BEFORE any test — that is the core of the random consumption.
    const r1 = state.rng.next(); // @0x5c5ab
    const r2 = state.rng.next(); // @0x5c5b4, after `rorl $0x10`
    const pos = probePosition(r1, r2, geo);
    const tile = state.mapTiles[pos];

    if (tile !== undefined) {
      if (tile.owner === wantOwner) {
 // Branch A: build site.
 // `objClass[object] != 0` => skip (@0x5c5f8); `paths & 0x3f != 0` => skip (@0x5c60c).
        if ((OBJECT_CLASS[tile.object] ?? 0) === 0 && (tile.paths & 0x3f) === 0) {
          const col = colOf(pos, geo);
          const row = rowOf(pos, geo);
 // `call 0x31fc9` @0x5c64c — the prologue zeroes `cursorType`/`possibility`, sets `build`
 // bit 1 and classifies the PROBED position, not the player cursor.
          const site = classifyBuildSite(state, player, col, row);
 // The classifier writes the two `player+3` bits **itself and unconditionally** — its prologue
 // begins `mov 0x30(%edi),%esi ; add $0x3,%esi ; mov (%esi),%al ; bts $0x1,%ax ;
 // mov %al,(%esi)` (@0x31fcc..@0x31fd6, same sequence at the second entry @0x32075). The write
 // back therefore belongs **here** and not in the accepting branch: a rejected probe tile leaves
 // its bits behind in the original too, and those bits filter the project mask right afterwards
 // (`bt $0x0`/`bt $0x1` @0x5c744/@0x5c75f).
          persistBuildSiteBits(player, site);
 // `cmpb $0x5,(%edi) ; jb` @0x5c671 — type >= 5 means the tile is free; `or %al,%al ; je`
 // @0x5c68e — possibility != 0.
          if (site.cursorType >= CURSOR_CLEAR_BY_FLAG && site.possibility !== 0) {
            player.cursorCol = col; // `mov %ax,0xfc(%ebx)` @0x5c6d8
            player.cursorRow = row; // `mov %ax,0xfe(%ebx)` @0x5c6e6
 // Survey (@0x5c783 `call 0x606d2`), evaluation and recording (@0x5c796 `call 0x5d945`) —
 // `aiRecordBuildSite` builds the project mask from the same possibility (@0x5c716).
            aiRecordBuildSite(state, player, site.possibility);
            return true; // the writing exit @0x5c9aa
          }
        }
      } else if (tile.owner !== 0) {
 // Branch B: attack target.
 // `jns` @0x5c7c0 on bit 7 of the owner byte: foreign land only if it has an owner at all. Then
 // object 2..4 == building (`cmpb $0x2,(%edi) ; jb` @0x5c7d5 / `cmpb $0x5,(%edi) ; jae`
 // @0x5c7de).
        if (tile.object >= 2 && tile.object < 5) {
          const bld = state.buildings[tile.objIndex];
          if (bld !== undefined && bld !== null && isBorderMilitary(bld)) {
 // 258 spiral positions from ring 2 around the BUILDING tile, looking for own land. Here the
 // original compares against the own owner **without** the castle special case (@0x5c8c?:
 // `vreg3 = (index+4) << 5`, no bit test in front).
            const own = player.slot + 1;
            const center = posOf(bld.col, bld.row, geo);
            for (let i = 0; i < REACH_POSITIONS; i++) {
              const p = spiralPos(center, REACH_FIRST_INDEX + i, geo);
              if (state.mapTiles[p]?.owner !== own) continue;
              player.cursorCol = colOf(pos, geo); // @0x5c968 — the PROBED tile, not the target
              player.cursorRow = rowOf(pos, geo); // @0x5c976
 // `mov $0x0 ; mov %al,0x101(%ebx)` @0x5c91b — the build possibility is **cleared**. Our
 // model does not carry it as a player field (the engine recomputes it on every cursor
 // change), so the value goes straight into the survey, where the 0 selects the `else`
 // branch — a different level plan AND a different "own land" comparison than in branch A.
              const survey = aiSurveySurroundings(state, player, 0); // `call 0x606d2` @0x5c980
 // `call 0x5cc57` @0x5c985 — the nine attack-target predicates. Free of random draws; they
 // record up to nine candidates and use no project mask.
              aiRecordAttackTargets(player, survey);
              return true; // the writing exit @0x5c9aa
            }
          }
        }
      }
    }

 // `subw $0x1,0x18(%edi) ; jae 0x5c5a9` @0x5c9d0 — the body runs for round = budget..0, so
 // `budget + 1` times; only the underflow ends it.
    if (round === 0) return false;
  }
}
