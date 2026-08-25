/**
 * Entity layer of the map window: map objects, buildings, flags, serfs — backend independent.
 *
 * ## Order: three passes PER ROW
 *
 * The original draws, per row, `draw_serf_row_behind` -> `draw_map_objects_row` -> `draw_serf_row`,
 * all with the same row `pos`. Rows run top to bottom; per row:
 * 1. shaft miners **behind** their building,
 * 2. objects/flags/buildings of that row,
 * 3. ordinary serfs of that row **on top**.
 *
 * So a serf in the SAME row as a building is in front of it, while a serf one row further north is
 * behind it — it was drawn in the earlier row pass and the later building covers it. Drawing serfs
 * as one map-wide top layer is therefore wrong (a northern serf would sit on the building), and so
 * is a single pass interleaving object and serf per *tile* — that pushes a serf with a smaller
 * column of the same row behind the building.
 *
 * The only exception to "serf above building of the same row" are the shaft miners (Mining,
 * substate 3/4/9/10); they belong behind their building, hence sub-pass (1).
 *
 * ## Animation phase
 *
 * Solely the game tick (`header.tick`) or the serf `counter` — no wall clock, no scale factors.
 *
 * ## Positions
 *
 * From the traversal (`window-frame.entityAnchor`), never from `col/row` via the camera — see there.
 */

import { MILL_TYPE, constructionMaterials, millRotationOffset, occupationFlags, productionOverlays } from './building-decor.js';
import { PIG_FARM_TYPE, pigFarmCount, pigFarmPigs } from './pig-farm-layer.js';
import { burningFlames } from './burning-layer.js';
import { MAP_OBJECT_BASE, MAP_SHADOW_BASE, buildingDrawOps } from './building-sprites.js';
import {
  blitSprite,
  blitSpriteOverIndex,
  type Blitter,
  type DrawImage,
  type KitSprite,
} from './draw-target.js';
import type { MapGeometry } from './engine/position.js';
import type { Rng } from './engine/rng.js';
import type { SoundQueue } from './sound.js';
import {
  emitBuildingSound,
  emitFightSound,
  emitSerfSound,
  type SoundLatches,
} from './sound-emit.js';
import {
  FLAG_RES_BEHIND,
  FLAG_RES_FRONT,
  FLAG_RES_POS,
  flagFrame,
  flagShadowOffset,
  resourceSprite,
} from './flag-sprites.js';
import {
  HIT_MARKER_CAPACITY,
  fightPartnerIndex,
  fightPartnerVisible,
  hitMarkerOffset,
  isFightPose,
  type HitMarker,
} from './fight-overlay.js';
import {
  MAP_WAVES_BASE,
  WATER_PALETTE_INDEX,
  TILE_H,
  TILE_W,
  mapObjectSprite,
  waterWaveFrame,
} from './map-render.js';
import {
  SERF_HEAD_BASE,
  SERF_Y_CORRECTION,
  bodyToSprites,
  idleSerfInfo,
  isIdlePathState,
  serfDrawInfo,
  worksInsideBuilding,
} from './serf-sprites.js';
import type { AnimationTable } from './animation-parser.js';
import type { BuildingRecord, FlagRecord, SaveGameState, SerfRecord } from './types.js';
import { entityAnchor, type WindowFrame } from './window-frame.js';

/**
 * What the layer needs in sprites. The backend supplies finished, cached images — team colouring
 * (torso, flag) is sprite composition and belongs in the kit, not in the draw order.
 */
export interface EntitySpriteKit<Img extends DrawImage> {
  sprite(index: number, type: 'transparent' | 'overlay'): KitSprite<Img> | null;
  /** Team-coloured serf torso including arm. */
  torso(owner: number, torsoIndex: number): KitSprite<Img> | null;
  readonly serfShadow: KitSprite<Img> | null;
  /** Flag for wave frame 0..3 and owner — four pre-baked versions, no recolouring. */
  flag(frame: number, owner: number): KitSprite<Img> | null;
}

/**
 * Look up a record by **slot index**, not by array position — the slots have holes. Deliberately
 * only `get`: a `ReadonlyMap` satisfies that, and so does a look into the engine's **dense** slot
 * arrays, which needs to build nothing.
 */
export interface EntityLookup<T> {
  get(index: number): T | undefined;
}

/** Entity records by slot index, not by array position — the slots have holes. */
export interface EntityIndex {
  readonly building: EntityLookup<BuildingRecord>;
  readonly flag: EntityLookup<FlagRecord>;
  readonly serf: EntityLookup<SerfRecord>;
}

/** Which categories get drawn (viewer switches; all on by default). */
export interface EntityLayerToggles {
  readonly objects?: boolean;
  readonly buildings?: boolean;
  readonly flags?: boolean;
  readonly serfs?: boolean;
}

export interface EntityLayerInput<Img extends DrawImage> {
  readonly state: SaveGameState;
  readonly geo: MapGeometry;
  readonly heightUnit: number;
  readonly kit: EntitySpriteKit<Img>;
  /** Without a table active serfs are skipped (idle carriers do not need it). */
  readonly animations: AnimationTable | null;
  readonly index: EntityIndex;
  readonly show?: EntityLayerToggles;
  /**
   * Sound sink. Without it the pass draws as before and enqueues nothing.
   *
   * In the original the **draw pass itself enqueues**; there is no separate "is the source of the
   * sound visible?" test. That is why emission hangs here and not on the tick engine: whatever is
   * not drawn makes no sound.
   */
  readonly sound?: EntitySoundSink;
  /**
   * Visibility counters of the **ambient sounds** (`vp+0x1b4`/`vp+0x1b6`). Without them the pass
   * counts nothing, leaving tools and previews untouched.
   *
   * The original map draw pass keeps them itself: its head @0x33ded clears both
   * (@0x33e08/@0x33e15), then @0x34045 counts every tile with the water bit and @0x340b1 every
   * object in the tree range. They are read only on the **next** frame tick by
   * `viewport_ambient_audio` (`updateEconomy` runs before the draw passes in the frame loop).
   */
  readonly ambient?: AmbientCounters;
}

/** The two counters the draw pass keeps for the ambient sounds. */
export interface AmbientCounters {
  waterTiles: number;
  treeObjects: number;
}

/** Sound context for one draw pass (frame extents = `vp+0x3e`/`vp+0x40`). */
export interface EntitySoundSink {
  readonly queue: SoundQueue;
  readonly latches: SoundLatches;
  /** Width/height of the map area in pixels (608x432 in the game screen). */
  readonly width: number;
  readonly height: number;
  /** The sound layer's own random stream, not the game RNG — see `sound.ts`. */
  readonly rng: Rng;
}

/**
 * Builds the index over the occupied slots of a **parsed** save — three maps, so it costs per call
 * (0.14 ms measured at 821 serfs). The running view therefore uses `engineEntityIndex` in
 * `views/map-view-data.ts`, which looks into the engine's dense slot arrays without building
 * anything; this version stays for tests and previews that have no live state.
 */
export function buildEntityIndex(state: SaveGameState): EntityIndex {
  return {
    building: new Map(state.buildingRecords.map((b) => [b.index, b])),
    flag: new Map(state.flagRecords.map((f) => [f.index, f])),
    serf: new Map(state.serfRecords.map((s) => [s.index, s])),
  };
}

/**
 * Miner entering or leaving the shaft (Mining, substate 3/4/9/10). Belongs BEHIND the building,
 * otherwise the worker animation covers the mine. Substate = `field_0xb` (`stateData[0]`).
 */
function isBehindMiner(serf: SerfRecord): boolean {
  if (serf.state !== 29) return false;
  const sub = serf.stateData[0]!;
  return sub === 3 || sub === 4 || sub === 9 || sub === 10;
}

/**
 * Draws the entity layer and returns the **hit markers** of the fight overlay pass (see
 * `fight-overlay.ts`). The original likewise collects them in a list and draws them only at the end
 * of the window, **after** the map selector (`ui_draw_viewport` -> `FUN_000375a7`) — so the caller
 * must emit them as the last layer.
 */
export function drawEntityLayer<Img extends DrawImage>(
  target: Blitter<Img>,
  frame: WindowFrame,
  input: EntityLayerInput<Img>,
): HitMarker[] {
  const { state, geo, heightUnit, kit, animations, index } = input;
  const sink = input.sound;
  const serfSoundCtx =
    sink === undefined
      ? null
      : { queue: sink.queue, latches: sink.latches, width: sink.width, height: sink.height };
  const buildingSoundCtx =
    sink === undefined
      ? null
      : {
          queue: sink.queue,
          latches: sink.latches,
          height: sink.height,
          tick: state.header.tick,
          rng: sink.rng,
          geo,
        };
  // @0x33e08/@0x33e15 — the head of the map draw pass clears both counters before the run.
  const ambient = input.ambient;
  if (ambient !== undefined) {
    ambient.waterTiles = 0;
    ambient.treeObjects = 0;
  }
  const showObjects = input.show?.objects !== false;
  const showBuildings = input.show?.buildings !== false;
  const showFlags = input.show?.flags !== false;
  const showSerfs = input.show?.serfs !== false;
  const cols = geo.cols;
  const tiles = state.mapTiles;

  const drawSerfSprite = (
    torsoIndex: number,
    headIndex: number,
    owner: number,
    lx: number,
    ly: number,
    shadow = true,
  ): void => {
    if (shadow) blitSprite(target, kit.serfShadow, lx, ly);
    const torso = kit.torso(owner, torsoIndex);
    if (torso === null) return;
    blitSprite(target, torso, lx, ly);
    if (headIndex >= 0) {
      // Empty directional head slots (e.g. ore-carrying miner heads base+1..5) are already mapped
      // onto the block start by the TOC fixup at archive load time — hence a plain lookup, exactly
      // as the original does in its draw code.
      blitSprite(target, kit.sprite(SERF_HEAD_BASE + headIndex, 'transparent'), lx + torso.deltaX, ly + torso.deltaY);
    }
  };

  const hitMarkers: HitMarker[] = [];

  /** Signed tile distance on the torus (columns/rows are powers of two). */
  const wrapDelta = (d: number, n: number): number => {
    const m = ((d % n) + n) % n;
    return m > n / 2 ? m - n : m;
  };

  /**
   * **Fight overlay pass** (`fight-overlay.ts`, `FUN_00026cc4` -> `FUN_00026d80`): the opponent
   * stands on the same tile and is never reached by the tile-driven pass — so it is drawn here,
   * **before** the serf's own body (the original puts it into the row list first). The hit marker
   * goes into the collected list the caller emits as the last layer.
   */
  const drawFightOverlay = (
    serf: SerfRecord,
    animSprite: number,
    bx: number,
    by: number,
    tile: { pos: number; height: number },
  ): void => {
    if (!isFightPose(serf.type, animSprite)) return;
    // Sound first — in the original the gate (state / counter window / latch) sits at the start of
    // `FUN_00026cc4`, before the opponent is looked up.
    if (serfSoundCtx !== null) emitFightSound(serfSoundCtx, serf, bx, by);
    const partner = index.serf.get(fightPartnerIndex(serf));
    if (partner === undefined) return;

    if (hitMarkers.length < HIT_MARKER_CAPACITY) {
      const m = hitMarkerOffset(serf, partner);
      // The original base point already carries the constant `-2` of serf drawing; in our anchor
      // it sits in `info.dy`, hence explicitly here.
      if (m !== null) {
        hitMarkers.push({ x: bx + m.dx, y: by - SERF_Y_CORRECTION + m.dy, sprite: m.sprite });
      }
    }

    if (!fightPartnerVisible(partner) || partner.col === null || partner.row === null) return;
    // The original recomputes the opponent position from ITS `pos`; here via the tile distance to
    // the tile being traversed (0/0 during a fight — the term only carries the torus edge).
    const dcol = wrapDelta(partner.col - (tile.pos & geo.colMask), geo.cols);
    const drow = wrapDelta(partner.row - ((tile.pos >> geo.rowShift) & geo.rowMask), geo.rows);
    const ph = tiles[(partner.row << geo.rowShift) | partner.col]?.height ?? tile.height;
    drawActiveSerf(
      partner,
      bx + TILE_W * dcol - (TILE_W / 2) * drow,
      by + tile.height * heightUnit + TILE_H * drow - ph * heightUnit,
    );
  };

  /**
   * Draw an active serf at `(bx,by)` (pose from `counter>>3`). The tile pass supplies `tile`; for
   * the **opponent** of the fight overlay it is omitted — the opponent is provably never itself in
   * the fight sprite band (see `fight-overlay.ts`), so the original cannot recurse there.
   */
  const drawActiveSerf = (
    serf: SerfRecord,
    bx: number,
    by: number,
    tile?: { pos: number; height: number },
  ): void => {
    if (animations === null) return;
    const info = serfDrawInfo(serf, animations);
    if (info === null) return;
    // The original type routine enqueues its sound before blitting the body, using the **base**
    // position (animation offsets are added only afterwards) and the body byte of the current frame
    // in `vreg2` — not the animation index. The `-2` is already in the original base y (@0x25d30),
    // here it sits in `info.dy` and is applied explicitly.
    if (serfSoundCtx !== null) {
      emitSerfSound(serfSoundCtx, serf, bx, by - SERF_Y_CORRECTION, info.animSprite);
    }
    if (tile !== undefined) drawFightOverlay(serf, info.animSprite, bx, by, tile);
    drawSerfSprite(info.torso, info.head, serf.owner, bx + info.dx, by + info.dy, !worksInsideBuilding(serf.state));
  };

  // Wave frame straight from the game tick ((tick>>3)&3).
  const waveFrame = flagFrame(state.header.tick);

  // Index idle carriers (state 66..69) by tile.
  const idleByPos = new Map<number, SerfRecord>();
  if (showSerfs) {
    for (const serf of state.serfRecords) {
      if (serf.col !== null && serf.row !== null && isIdlePathState(serf.state)) {
        idleByPos.set(serf.row * cols + serf.col, serf);
      }
    }
  }
  const hasIdlePath = idleByPos.size > 0;

  for (let i = 0; i < frame.halfRows.length; i++) {
    const hr = frame.halfRows[i]!;

    // (a) Object/building sub-pass of this row (preceded by the shaft miners, i.e. behind).
    for (let k = 0; k < hr.tiles.length; k++) {
      const pos = hr.tiles[k]!;
      const t = tiles[pos]!;

      const obj = t.object;
      // **Water branch of the tile dispatch** (`draw_map_tile_dispatch` @0x3403c..@0x34056): if the
      // object byte carries the water bit (bit 7), the tile counts for the ambient sounds **and**
      // gets its waves — both **before** the object of the same tile (`je 0x3405c` / `jns 0x3405c`
      // skip exactly this block). Our model does not carry that bit (it is derivable from the
      // terrain), so it is reconstructed here.
      const isWater = t.terrainUp <= 3 || t.terrainDown <= 3;
      if (isWater && ambient !== undefined) ambient.waterTiles++; // @0x34045 `addw $0x1,0x1b4`
      // @0x340b1 — every object in the tree range: after `andb $0x7f`, `obj - 8 < 0x18`.
      if (ambient !== undefined && obj >= 8 && obj <= 0x1f) ambient.treeObjects++;

      // **Idle pre-test — ours, not the original's.** It is pixel-identical: this sub-pass draws
      // exactly three things, each with its own gate — waves `isWater`, the shaft miner
      // `serfIndex`, the object/building/flag `obj`. With none of them present only the anchor
      // arithmetic would remain. The two ambient counters therefore sit **above** the test: the
      // original counts them per tile in the window, regardless of whether it blits anything.
      //
      // Why the original does not need it: it has no zooming out. Here the number of visited tile
      // positions grows with `1/zoom²` and exceeds the map size — at 512x256 and 9 % zoom, 318472
      // positions over 131072 tiles (2.43 torus periods), with drawing needed on only 19.9 % of
      // them. The rest was anchor arithmetic plus two object allocations per tile.
      if (obj === 0 && !isWater && t.serfIndex === 0) continue;

      const flat = entityAnchor(frame, i, k);
      const bx = flat.x;
      const by = flat.y - t.height * heightUnit;

      const activeSerf =
        showSerfs && t.serfIndex > 0 && animations !== null ? index.serf.get(t.serfIndex) : undefined;
      if (activeSerf !== undefined && isBehindMiner(activeSerf)) {
        drawActiveSerf(activeSerf, bx, by, { pos, height: t.height });
      }

      if (isWater) {
        // `draw_map_waves` @0x36a84 computes the window shift **itself** and calls primitive
        // `0x600` directly — so it gets `x = vreg6 << 3` **without** the `+0x10` of
        // `blit_map_object_with_shadow` (@0x34590) and `y = vreg4 + 8` **without** the height
        // subtraction. The waves therefore sit half a tile left of the object anchor and always on
        // the row baseline, independent of tile height.
        //
        // They also pass through a **mask the ground itself provides**: primitive `0x600` (worker
        // `0x646e4`) writes a pixel only where the destination carries the water index. Hence one
        // sprite suffices for every shoreline, and the grass triangle of a shore tile stays clear —
        // blitting unconditionally paints over it.
        blitSpriteOverIndex(
          target,
          kit.sprite(MAP_WAVES_BASE + waterWaveFrame(pos, state.header.tick), 'transparent'),
          bx - TILE_W / 2,
          flat.y,
          WATER_PALETTE_INDEX,
        );
      }
      if (obj === 1) {
        if (!showFlags) continue;
        blitSprite(target, kit.sprite(MAP_SHADOW_BASE + flagShadowOffset(waveFrame), 'overlay'), bx, by);
        const flag = index.flag.get(t.objIndex);
        if (flag === undefined) continue;
        const blitRes = (slot: number): void => {
          const res = flag.resourceSlots[slot]!;
          if (res < 0) return;
          blitSprite(target, kit.sprite(resourceSprite(res), 'transparent'), bx + FLAG_RES_POS[slot]![0], by + FLAG_RES_POS[slot]![1]);
        };
        for (const slot of FLAG_RES_BEHIND) blitRes(slot);
        blitSprite(target, kit.flag(waveFrame, flag.owner), bx, by);
        for (const slot of FLAG_RES_FRONT) blitRes(slot);
      } else if (obj >= 2 && obj <= 4) {
        if (!showBuildings) continue;
        const b = index.building.get(t.objIndex);
        if (b === undefined || b.index === 0 || b.type === 0) continue;
        // `draw_building` @0x34e54 tests the burning bit and branches into the type dispatch
        // **before** it draws — so the sound hangs at the start of this branch.
        if (buildingSoundCtx !== null) emitBuildingSound(buildingSoundCtx, b, by);
        // (1) Waiting construction materials BEHIND the building (only while building): stone =
        //     stock slot 1, planks = stock slot 0 (available).
        //
        // **Two gates, both read from the "under construction" half of the dispatch** (slots
        // `0x34ed5 + type·8 + 0x100`), not from `constructing` alone:
        //  · Only types **1..23** reach the shared body @0x365a4 that draws the materials. Type 0 is
        //    a bare `ret` (@0x35155), and the **castle** (24) has its own routine (@0x3685a) that
        //    never reads bytes 8/9.
        //  · That body first tests `bld[0xc] != 0` (@0x365a7): while the digger works there are no
        //    materials to see, only the pit.
        //
        // Not cosmetic: since its founding the castle carries the **inventory marker** in bytes 8/9
        // (@0x2926a, see `founding.ts`), so its nibbles are `15/15`. Without the type gate every
        // castle site would stack 15 stones and 15 planks.
        if (b.constructing && b.type >= 1 && b.type <= 23 && b.progress !== 0) {
          for (const m of constructionMaterials(b.stock[1]!.available, b.stock[0]!.available)) {
            blitSprite(target, kit.sprite(m.idx, 'transparent'), bx + m.dx, by + m.dy);
          }
        }
        // (2) Body + shadow. Finished, active mill: add the rotation phase onto the offset.
        const millOff = !b.constructing && b.type === MILL_TYPE ? millRotationOffset(state.header.tick, b.active) : 0;
        for (const op of buildingDrawOps(b.type, !b.constructing, b.progress)) {
          const off = op.offset + millOff;
          blitSprite(target, kit.sprite(MAP_SHADOW_BASE + off, 'overlay'), bx, by, op.progress);
          blitSprite(target, kit.sprite(MAP_OBJECT_BASE + off, 'transparent'), bx, by, op.progress);
        }
        // (2b) Flames last — for the body the burning branch calls the **same** type dispatch
        //      (`FUN_00034eb0` @0x34eb0) and only then puts its flames on top (`FUN_00034a70`). A
        //      burning building therefore looks normal including its type decoration; only the
        //      flames are added. The same branch applies to a shell under construction.
        const flames = b.burning
          ? burningFlames(b.type, b.firstKnight, b.constructing, b.progress)
          : null;
        const drawFlames = (): void => {
          if (flames === null) return;
          for (const fl of flames) {
            blitSprite(target, kit.sprite(fl.idx, 'transparent'), bx + fl.dx, by + fl.dy);
          }
        };
        // (3) On top of the finished building: smoke/steam (active production) + occupation flags.
        // The dispatch @0x34ec7 indexes with `building[4] & 0xfc` — that mask keeps **bit 7**, so a
        // construction site lands in a different slot range (+0x100) with its own branch.
        if (b.constructing) {
          drawFlames();
          continue;
        }
        // (3a) The pigs — in the original the tail of `draw_pig_farm` @0x3584d, right after the
        //      building blit (see `pig-farm-layer.ts`).
        if (b.type === PIG_FARM_TYPE) {
          for (const p of pigFarmPigs(pigFarmCount(b), state.header.tick)) {
            blitSprite(target, kit.sprite(p.idx, 'transparent'), bx + p.dx, by + p.dy);
          }
        }
        for (const ov of productionOverlays(b.type, state.header.tick, b.active, b.playingSfx)) {
          blitSprite(target, kit.sprite(ov.idx, 'transparent'), bx + ov.dx, by + ov.dy);
        }
        // Occupation flag only with a knight (`FUN_00034f7d` @0x34f7d gates on Building+10 =
        // firstKnight != 0; flag height from stock[0].available).
        if (b.firstKnight !== 0) {
          for (const occ of occupationFlags(b.type, state.header.tick, b.threatLevel, b.stock[0]!.available)) {
            blitSprite(target, kit.sprite(occ.idx, 'transparent'), bx + occ.dx, by + occ.dy);
          }
        }
        drawFlames();
      } else if (obj >= 8) {
        if (!showObjects) continue;
        // The tick goes along: objects 8..31 (trees) are animated, everything above is static —
        // both the same blit `call 0x34578` @0x34127. Details in `map-render.mapObjectSprite`.
        const oidx = mapObjectSprite(obj, state.header.tick);
        if (oidx !== null) {
          // `blit_map_object_with_shadow` is named for making TWO blits: first the shadow shape
          // mask (`addw $0x5dc` @0x345c9 -> primitive `0x380`), then the body (`addw $0x4e2`
          // @0x345f3 -> `0x4c0`) — with the **same** index, because object and shadow bank are
          // coupled slot for slot (identical gap structure). An overlay is only `dst |= 0x80`, so a
          // missing first blit shows up as a **ground** difference, not an object one.
          blitSprite(target, kit.sprite(MAP_SHADOW_BASE + (oidx - MAP_OBJECT_BASE), 'overlay'), bx, by);
          blitSprite(target, kit.sprite(oidx, 'transparent'), bx, by);
        }
      }
    }

    // (b) Serf sub-pass of the SAME row: idle + active serfs ABOVE the objects/buildings of this
    //     row (but below the buildings of the next, lower rows). Shaft miners were already drawn in
    //     (a), behind their building.
    if (!showSerfs) continue;
    for (let k = 0; k < hr.tiles.length; k++) {
      const pos = hr.tiles[k]!;
      const t = tiles[pos]!;

      // The same idle pre-test as in (a), with this sub-pass's two gates: an idle carrier (lookup
      // in `idleByPos`) or an active serf on the tile. `hasIdlePath` saves the per-tile hash lookup
      // on a map **without** idle carriers — not an edge case: a save with 0 serfs spent 2.61 of
      // 16.74 ms in this sub-pass for nothing at all.
      const idle = hasIdlePath ? idleByPos.get(pos) : undefined;
      if (idle === undefined && t.serfIndex === 0) continue;

      const flat = entityAnchor(frame, i, k);
      const bx = flat.x;
      const by = flat.y - t.height * heightUnit;

      if (idle !== undefined) {
        const info = idleSerfInfo(idle.type, pos, t.paths, state.header.tick);
        const sp = bodyToSprites(info.body);
        if (sp !== null) drawSerfSprite(sp.torso, sp.head, idle.owner, bx + info.dx, by + info.dy);
      }
      const activeSerf = t.serfIndex > 0 && animations !== null ? index.serf.get(t.serfIndex) : undefined;
      if (activeSerf !== undefined && !isBehindMiner(activeSerf)) {
        drawActiveSerf(activeSerf, bx, by, { pos, height: t.height });
      }
    }
  }
  return hitMarkers;
}
