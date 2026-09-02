import { describe, expect, it } from 'vitest';
import { buildEntityIndex, drawEntityLayer, type EntitySpriteKit } from './entity-layer.js';
import type { Blitter, DrawImage, KitSprite } from './draw-target.js';
import { mapGeometry, posOf } from './engine/position.js';
import { buildWindowFrame } from './window-frame.js';
import { tileScene, type Camera } from './viewport-camera.js';
import { MAP_OBJECT_BASE, MAP_SHADOW_BASE } from './building-sprites.js';
import { WATER_PALETTE_INDEX } from './map-render.js';
import type { SaveGameState } from './types.js';

/**
 * The two properties that keep the repetition bug out: the original's **painter order** (three passes
 * per row) and the **position taken from the traversal**, never recomputed from `col/row`.
 */

// --- recording backend ---------------------------------------------------------------------------

interface Tagged extends DrawImage {
  readonly tag: string;
}

interface Draw {
  readonly tag: string;
  readonly x: number;
  readonly y: number;
}

class Recorder implements Blitter<Tagged> {
  readonly draws: Draw[] = [];
  blit(image: Tagged, x: number, y: number): void {
    this.draws.push({ tag: image.tag, x, y });
  }
  blitPartial(image: Tagged, x: number, y: number): void {
    this.draws.push({ tag: `${image.tag}~`, x, y });
  }
  /** The conditional blit (`0x600`) — the tag carries the required target index. */
  blitOverIndex(image: Tagged, x: number, y: number, overIndex: number): void {
    this.draws.push({ tag: `${image.tag}@${overIndex}`, x, y });
  }
}

function tagged(tag: string): KitSprite<Tagged> {
  return { image: { tag, width: 8, height: 8 }, offsetX: 0, offsetY: 0, deltaX: 0, deltaY: 0 };
}

/** Kit that emits every sprite index as its own tag (torso/head as `serf`). */
const KIT: EntitySpriteKit<Tagged> = {
  sprite: (index, type) => {
    if (index >= MAP_OBJECT_BASE && index < MAP_OBJECT_BASE + 250) return tagged(`obj${index - MAP_OBJECT_BASE}`);
    if (index >= MAP_SHADOW_BASE && index < MAP_SHADOW_BASE + 250) return tagged('shadow');
    return tagged(`${type}${index}`);
  },
  torso: () => tagged('serf'),
  serfShadow: tagged('serfShadow'),
  flag: () => tagged('flag'),
};

// --- minimal state ------------------------------------------------------------------------------

const GEO = mapGeometry(0); // 32 x 16 tiles => scene period 1024 x 320 px

interface TilePatch {
  object?: number;
  objIndex?: number;
  serfIndex?: number;
  height?: number;
  terrainUp?: number;
  terrainDown?: number;
}

function makeState(
  patches: ReadonlyMap<number, TilePatch>,
  records: {
    buildings?: Array<Record<string, unknown>>;
    serfs?: Array<Record<string, unknown>>;
    flags?: Array<Record<string, unknown>>;
  } = {},
): SaveGameState {
  const mapTiles = Array.from({ length: GEO.tileCount }, (_, pos) => ({
    height: 0,
    terrainUp: 5,
    terrainDown: 5,
    paths: 0,
    object: 0,
    objIndex: 0,
    serfIndex: 0,
    owner: 0,
    mineral: 0,
    resourceAmount: 0,
    ...(patches.get(pos) ?? {}),
  }));
  return {
    header: { tick: 0, mapSize: 0, mapCols: GEO.cols, mapRows: GEO.rows, tileCount: GEO.tileCount },
    mapTiles,
    buildingRecords: records.buildings ?? [],
    serfRecords: records.serfs ?? [],
    flagRecords: records.flags ?? [],
    inventoryRecords: [],
    playerRecords: [],
  } as unknown as SaveGameState;
}

/** Finished small building (type 11 guard hut) at `pos`. */
function building(index: number, pos: number): Record<string, unknown> {
  const col = pos % GEO.cols;
  return {
    index,
    col,
    row: (pos - col) / GEO.cols,
    type: 11,
    owner: 0,
    constructing: false,
    active: true,
    playingSfx: false,
    progress: 0,
    firstKnight: 0,
    threatLevel: 0,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
  };
}

/** Walking carrier (state 1) — found through the tile's `serfIndex`. */
function serf(
  index: number,
  state = 1,
  stateData = [0, 0, 0, 0, 0],
  animation = 0,
): Record<string, unknown> {
  return {
    index,
    owner: 0,
    type: 0,
    state,
    animation,
    counter: 0,
    col: 0,
    row: 0,
    stateData,
  };
}

/** A window that safely contains tile `(col,row)`. */
function frameAround(col: number, row: number, width = 320, height = 240) {
  const p = tileScene(col, row);
  const cam: Camera = {
    originX: p.x - width / 2,
    originY: p.y - height / 2,
    width,
    height,
  };
  return { cam, frame: buildWindowFrame(cam, GEO, 0) };
}

/** One frame per animation index, wide enough for the walking animations (`4 + 9*dir + dH`). */
const RUN_ANIMS = Array.from({ length: 0xa0 }, () => [{ sprite: 0, x: 0, y: 0 }]);

function run(state: SaveGameState, frame: ReturnType<typeof frameAround>['frame']): Draw[] {
  const rec = new Recorder();
  drawEntityLayer(rec, frame, {
    state,
    geo: GEO,
    heightUnit: 0,
    kit: KIT,
    animations: { animations: RUN_ANIMS },
    index: buildEntityIndex(state),
  });
  return rec.draws;
}

// --- painter order: three passes PER ROW ---------------------------------------------------------

describe('drawEntityLayer — order', () => {
  it('draws a serf of the SAME row ON TOP of the building (even at a smaller column)', () => {
    // The earlier single pass interleaved object+serf per TILE and thereby pushed a serf with a
    // smaller column behind the building.
    const bldPos = posOf(10, 8, GEO);
    const serfPos = posOf(9, 8, GEO); // same row, smaller column
    const state = makeState(
      new Map([
        [bldPos, { object: 2, objIndex: 1 }],
        [serfPos, { serfIndex: 5 }],
      ]),
      { buildings: [building(1, bldPos)], serfs: [serf(5)] },
    );
    const { frame } = frameAround(10, 8);
    const draws = run(state, frame);
    const bld = draws.findIndex((d) => d.tag.startsWith('obj'));
    const srf = draws.findIndex((d) => d.tag === 'serf');
    expect(bld).toBeGreaterThanOrEqual(0);
    expect(srf).toBeGreaterThan(bld);
  });

  it('draws a serf of the row ABOVE behind the building', () => {
    const bldPos = posOf(10, 8, GEO);
    const serfPos = posOf(10, 7, GEO); // north => earlier row pass
    const state = makeState(
      new Map([
        [bldPos, { object: 2, objIndex: 1 }],
        [serfPos, { serfIndex: 5 }],
      ]),
      { buildings: [building(1, bldPos)], serfs: [serf(5)] },
    );
    const { frame } = frameAround(10, 8);
    const draws = run(state, frame);
    expect(draws.findIndex((d) => d.tag === 'serf')).toBeLessThan(
      draws.findIndex((d) => d.tag.startsWith('obj')),
    );
  });

  it('draws the shaft miner (mining, substate 3, animation 0x7d) BEHIND his building', () => {
    const pos = posOf(10, 8, GEO);
    const state = makeState(new Map([[pos, { object: 2, objIndex: 1, serfIndex: 5 }]]), {
      buildings: [building(1, pos)],
      serfs: [serf(5, 29, [3, 0, 0, 0, 0], 0x7d)],
    });
    const draws = run(state, frameAround(10, 8).frame);
    expect(draws.findIndex((d) => d.tag === 'serf')).toBeLessThan(
      draws.findIndex((d) => d.tag.startsWith('obj')),
    );
  });

  it('draws a non-shaft miner (mining, substate 1, animation 0x62) on top of his building', () => {
    const pos = posOf(10, 8, GEO);
    const state = makeState(new Map([[pos, { object: 2, objIndex: 1, serfIndex: 5 }]]), {
      buildings: [building(1, pos)],
      serfs: [serf(5, 29, [1, 0, 0, 0, 0], 0x62)],
    });
    const draws = run(state, frameAround(10, 8).frame);
    expect(draws.findIndex((d) => d.tag === 'serf')).toBeGreaterThan(
      draws.findIndex((d) => d.tag.startsWith('obj')),
    );
  });

  // The row bias, per direction. `walkingAnim(dH, dir, switch) = 4 + dH + 9*(dir + ...)`: the two
  // directions stepping one row down are registered on the target tile already, so without the bias
  // they would cover the buildings of the row they walk into.
  for (const [name, dir, behind] of [
    ['Right', 0, false],
    ['DownRight', 1, true],
    ['Down', 2, true],
    ['Left', 3, false],
    ['UpLeft', 4, false],
    ['Up', 5, false],
  ] as const) {
    it(`a serf walking ${name} is ${behind ? 'behind' : 'in front of'} the building of its row`, () => {
      const pos = posOf(10, 8, GEO);
      const bldPos = posOf(11, 8, GEO); // same row, one column to the east
      const state = makeState(
        new Map([
          [bldPos, { object: 2, objIndex: 1 }],
          [pos, { serfIndex: 5 }],
        ]),
        { buildings: [building(1, bldPos)], serfs: [serf(5, 1, [0, 0, 0, 0, 0], 4 + 9 * dir)] },
      );
      const draws = run(state, frameAround(10, 8).frame);
      const srf = draws.findIndex((d) => d.tag === 'serf');
      const bld = draws.findIndex((d) => d.tag.startsWith('obj'));
      expect(srf).toBeGreaterThanOrEqual(0);
      expect(bld).toBeGreaterThanOrEqual(0);
      if (behind) expect(srf).toBeLessThan(bld);
      else expect(srf).toBeGreaterThan(bld);
    });
  }
});

// --- positions from the traversal ----------------------------------------------------------------

describe('drawEntityLayer — positions', () => {
  it('draws the same tile SEVERAL times when the window exceeds one map period', () => {
    // Computed from `col/row` through the camera the position would be the same every time — the
    // ground repeated while the building stuck once in the middle.
    const pos = posOf(10, 8, GEO);
    const state = makeState(new Map([[pos, { object: 2, objIndex: 1 }]]), {
      buildings: [building(1, pos)],
    });
    // Window spanning TWO periods (1024 x 320 px) — then every tile repeats, wherever the traversal
    // starts.
    const { frame } = frameAround(10, 8, 2200, 700);
    const bodies = run(state, frame).filter((d) => d.tag.startsWith('obj'));
    expect(bodies.length).toBeGreaterThan(1);
    // And at DIFFERENT places, too.
    expect(new Set(bodies.map((d) => `${d.x},${d.y}`)).size).toBe(bodies.length);
  });

  it('lifts entities by the tile height (heightUnit)', () => {
    const pos = posOf(10, 8, GEO);
    const state = makeState(new Map([[pos, { object: 2, objIndex: 1, height: 7 }]]), {
      buildings: [building(1, pos)],
    });
    const { cam } = frameAround(10, 8);
    const flat = buildWindowFrame(cam, GEO, 0);
    const rec = new Recorder();
    const rec2 = new Recorder();
    const input = {
      state,
      geo: GEO,
      kit: KIT,
      animations: null,
      index: buildEntityIndex(state),
    };
    drawEntityLayer(rec, flat, { ...input, heightUnit: 0 });
    drawEntityLayer(rec2, buildWindowFrame(cam, GEO, 7), { ...input, heightUnit: 4 });
    const a = rec.draws.find((d) => d.tag.startsWith('obj'))!;
    const b = rec2.draws.find((d) => d.tag.startsWith('obj'))!;
    expect(b.y).toBe(a.y - 7 * 4);
  });
});

// --- water branch + object shadow -----------------------------------------------------------------

describe('drawEntityLayer — water branch and the second blit', () => {
  it('a map object gets SHADOW and body at the same spot (`blit_map_object_with_shadow`)', () => {
    const pos = posOf(10, 8, GEO);
    const state = makeState(new Map([[pos, { object: 30 }]])); // 30 == static object (not a tree)
    const { frame } = frameAround(10, 8);
    const draws = run(state, frame);
    const iShadow = draws.findIndex((d) => d.tag === 'shadow');
    const iBody = draws.findIndex((d) => d.tag.startsWith('obj'));
    expect(iShadow).toBeGreaterThanOrEqual(0);
    expect(iShadow).toBeLessThan(iBody); // shadow FIRST (@0x345cf before @0x345f9)
    expect({ x: draws[iShadow]!.x, y: draws[iShadow]!.y }).toEqual({ x: draws[iBody]!.x, y: draws[iBody]!.y });
  });

  it('a water tile gets waves — half a tile left and WITHOUT the height subtraction', () => {
    const pos = posOf(10, 8, GEO);
    // Height 7 on the water tile: the waves must NOT move with it.
    const state = makeState(new Map([[pos, { terrainUp: 2, terrainDown: 2, height: 7, object: 30 }]]));
    const { cam } = frameAround(10, 8);
    const rec = new Recorder();
    drawEntityLayer(rec, buildWindowFrame(cam, GEO, 7), {
      state,
      geo: GEO,
      heightUnit: 4,
      kit: KIT,
      animations: null,
      index: buildEntityIndex(state),
    });
    const wave = rec.draws.find((d) => /^transparent6[2-4][0-9]@/.test(d.tag));
    const body = rec.draws.find((d) => d.tag.startsWith('obj'));
    expect(wave).toBeDefined();
    expect(body).toBeDefined();
    expect(wave!.x).toBe(body!.x - 16); // the missing `+0x10` of the object primitive
    expect(wave!.y).toBe(body!.y + 7 * 4); // the body is lifted, the waves are not
    // ...and through the CONDITIONAL primitive, with the water index as mask (`0x600` -> `0x646e4`).
    expect(wave!.tag.endsWith(`@${WATER_PALETTE_INDEX}`)).toBe(true);
  });

  it('waves go through the conditional primitive, object and shadow do not', () => {
    const pos = posOf(10, 8, GEO);
    const state = makeState(new Map([[pos, { terrainUp: 2, terrainDown: 2, object: 30 }]]));
    const { frame } = frameAround(10, 8);
    const draws = run(state, frame);
    // Exactly one conditional blit on the tile — and that is the wave.
    const conditional = draws.filter((d) => d.tag.includes('@'));
    expect(conditional).toHaveLength(1);
    expect(/^transparent6[2-4][0-9]@8$/.test(conditional[0]!.tag)).toBe(true);
  });

  it('a land tile gets NO waves', () => {
    const pos = posOf(10, 8, GEO);
    const state = makeState(new Map([[pos, { terrainUp: 5, terrainDown: 5, object: 30 }]]));
    const { frame } = frameAround(10, 8);
    expect(run(state, frame).some((d) => /^transparent6[2-4][0-9]@/.test(d.tag))).toBe(false);
  });
});

// --- switches ------------------------------------------------------------------------------------

describe('drawEntityLayer — switches', () => {
  it('leaves disabled categories out', () => {
    const bldPos = posOf(10, 8, GEO);
    const state = makeState(
      new Map([
        [bldPos, { object: 2, objIndex: 1 }],
        [posOf(11, 8, GEO), { serfIndex: 5 }],
      ]),
      { buildings: [building(1, bldPos)], serfs: [serf(5)] },
    );
    const { frame } = frameAround(10, 8);
    const rec = new Recorder();
    drawEntityLayer(rec, frame, {
      state,
      geo: GEO,
      heightUnit: 0,
      kit: KIT,
      animations: { animations: [[{ sprite: 0, x: 0, y: 0 }]] },
      index: buildEntityIndex(state),
      show: { buildings: false, serfs: false },
    });
    expect(rec.draws).toEqual([]);
  });
});

// --- fight extra pass: the opponent stands on the SAME tile --------------------------------------

/**
 * In a fight the tile carries only the attacker, so the defender would stay invisible. The original
 * draws him from the attacker branch (`FUN_00026cc4` -> `FUN_00026d80`) together with the hit marker.
 */
describe('drawEntityLayer — fight (opponent + hit marker)', () => {
  /** Kit tagging the torso by owner — so attacker and defender are distinguishable. */
  const FIGHT_KIT: EntitySpriteKit<Tagged> = { ...KIT, torso: (owner) => tagged(`serf${owner}`) };

  /** Animation table with the real bands: 0x93 = attacker (inside the band), 0x9d = defender. */
  const ANIMS = {
    animations: Array.from({ length: 0xa0 }, (_, a) => [
      { sprite: a === 0x93 ? 0x80 : a === 0x9d ? 0xc0 : 0, x: 0, y: 0 },
    ]),
  };

  /** Knight with full control over animation/counter/union bytes. */
  function knight(
    index: number,
    owner: number,
    over: { state?: number; animation?: number; counter?: number; stateData?: number[]; col?: number; row?: number },
  ): Record<string, unknown> {
    return {
      index,
      owner,
      type: 22, // Knight0
      state: over.state ?? 48,
      animation: over.animation ?? 0x93,
      counter: over.counter ?? 0,
      col: over.col ?? 0,
      row: over.row ?? 0,
      stateData: over.stateData ?? [0, 0, 0, 0, 0],
    };
  }

  /** Attacker #5 (owner 0) and defender #7 (owner 1) at `(10,8)`; only #5 in the tile. */
  function duel(
    attackerOver: Parameters<typeof knight>[2] = {},
    defenderOver: Parameters<typeof knight>[2] = {},
  ) {
    const pos = posOf(10, 8, GEO);
    const state = makeState(new Map([[pos, { serfIndex: 5 }]]), {
      serfs: [
        knight(5, 0, { stateData: [0, 0, 0, 7, 0], col: 10, row: 8, ...attackerOver }),
        knight(7, 1, { state: 49, animation: 0x9d, col: 10, row: 8, ...defenderOver }),
      ],
    });
    const rec = new Recorder();
    const markers = drawEntityLayer(rec, frameAround(10, 8).frame, {
      state,
      geo: GEO,
      heightUnit: 0,
      kit: FIGHT_KIT,
      animations: ANIMS,
      index: buildEntityIndex(state),
    });
    return { draws: rec.draws, markers };
  }

  it('draws the opponent too although the tile points only at the attacker', () => {
    const { draws } = duel();
    const def = draws.findIndex((d) => d.tag === 'serf1');
    const att = draws.findIndex((d) => d.tag === 'serf0');
    expect(def).toBeGreaterThanOrEqual(0);
    // The opponent first — in the original he lands before the own body in the row list.
    expect(def).toBeLessThan(att);
    // Same tile => same drawing point.
    expect(draws[def]).toMatchObject({ x: draws[att]!.x, y: draws[att]!.y });
  });

  it('does NOT draw him while he is leaving his building (state 46)', () => {
    const { draws } = duel({}, { state: 0x2e });
    expect(draws.filter((d) => d.tag === 'serf1')).toEqual([]);
    expect(draws.filter((d) => d.tag === 'serf0')).toHaveLength(1);
  });

  it('draws nothing extra when the serf is outside the fight sprite band', () => {
    // Animation 0x9d yields 0xc0 — the defender bank, outside 0x80..0xbf.
    const { draws, markers } = duel({ animation: 0x9d });
    expect(draws.filter((d) => d.tag === 'serf1')).toEqual([]);
    expect(markers).toEqual([]);
  });

  it('places the hit marker relative to the attacker (table @0x25a65, animation 0x93)', () => {
    const { draws, markers } = duel({ stateData: [0, 0, 0 /* dir */, 7, 0], counter: 0 });
    const att = draws.find((d) => d.tag === 'serf0')!;
    // Entry 0x93 = (9,5); the original computes `x += 9 - 0x10`, `y -= 5`.
    expect(markers).toEqual([{ x: att.x + 9 - 0x10, y: att.y - 5, sprite: 0xc6 + 3 }]);
  });

  it('places no marker in the intermediate poses (direction 1..3)', () => {
    expect(duel({ stateData: [0, 0, 1, 7, 0] }).markers).toEqual([]);
  });
});
