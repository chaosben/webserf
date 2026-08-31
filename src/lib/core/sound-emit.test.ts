import { describe, it, expect } from 'vitest';
import { mapGeometry } from './engine/position.js';
import { Rng } from './engine/rng.js';
import { createSoundQueue, SOUND_NONE, type SoundQueue } from './sound.js';
import {
  buildingPosByte1,
  createSoundLatches,
  emitBuildingSound,
  emitFightSound,
  emitSerfSound,
  type BuildingSoundCtx,
  type SerfSoundCtx,
  type SoundLatches,
} from './sound-emit.js';
import type { BuildingRecord, SerfRecord } from './types.js';

const GEO = mapGeometry(3);
const seed = [0x0380, 0xeea7, 0x6b11] as const;

function bld(over: Partial<BuildingRecord> = {}): BuildingRecord {
  return {
    index: 7,
    col: 10,
    row: 20,
    type: 15,
    typeName: '',
    owner: 0,
    constructing: false,
    progress: 0,
    flag: 0,
    firstKnight: 0,
    active: true,
    burning: false,
    holder: true,
    serfRequested: false,
    threatLevel: 0,
    playingSfx: false,
    stock: [
      { available: 0, requested: 0 },
      { available: 0, requested: 0 },
    ],
    ...over,
  } as unknown as BuildingRecord;
}

function srf(over: Partial<SerfRecord> = {}): SerfRecord {
  return {
    index: 3,
    owner: 0,
    type: 0,
    typeName: '',
    sound: false,
    animation: 0,
    counter: 0,
    col: 1,
    row: 1,
    tick: 0,
    state: 1,
    stateName: '',
    stateData: [0, 0, 0, 0, 0],
    ...over,
  } as unknown as SerfRecord;
}

function bCtx(tick: number, latches: SoundLatches, q: SoundQueue, rng = new Rng(seed)): BuildingSoundCtx {
  return { queue: q, latches, height: 432, tick, rng, geo: GEO };
}
function sCtx(latches: SoundLatches, q: SoundQueue): SerfSoundCtx {
  return { queue: q, latches, width: 608, height: 432 };
}
const first = (q: SoundQueue): number => q.slots[0]!;

describe('map object pass — only the five sounding types', () => {
  it('mill: phase 0 of 4 sounds exactly ONCE, the latch holds', () => {
    const l = createSoundLatches();
    // (tick >> 4) & 3 == 0 holds for ticks 0..15 — two frames in the original.
    const q1 = createSoundQueue();
    emitBuildingSound(bCtx(0, l, q1), bld({ type: 15 }), 100);
    expect(first(q1)).toBe(0x42);
    const q2 = createSoundQueue();
    emitBuildingSound(bCtx(8, l, q2), bld({ type: 15 }), 100);
    expect(first(q2)).toBe(SOUND_NONE); // latch still set
    // Phase != 0 unlatches, after which it sounds again.
    const q3 = createSoundQueue();
    emitBuildingSound(bCtx(16, l, q3), bld({ type: 15 }), 100);
    expect(first(q3)).toBe(SOUND_NONE);
    const q4 = createSoundQueue();
    emitBuildingSound(bCtx(64, l, q4), bld({ type: 15 }), 100);
    expect(first(q4)).toBe(0x42);
  });

  it('mill without `active` stays silent', () => {
    const q = createSoundQueue();
    emitBuildingSound(bCtx(0, createSoundLatches(), q), bld({ type: 15, active: false }), 100);
    expect(first(q)).toBe(SOUND_NONE);
  });

  it('smelter: phase 0 without a latch test, phase 7 with — two strikes per eight frames', () => {
    for (const type of [18, 23]) {
      const l = createSoundLatches();
      const q0 = createSoundQueue();
      emitBuildingSound(bCtx(0, l, q0), bld({ type }), 100);
      expect(first(q0)).toBe(0x3e); // Phase 0
      const q1 = createSoundQueue();
      emitBuildingSound(bCtx(0, l, q1), bld({ type }), 100);
      expect(first(q1)).toBe(0x3e); // Phase 0 erneut: KEIN Riegel-Test
      const q2 = createSoundQueue();
      emitBuildingSound(bCtx(8 * 3, l, q2), bld({ type }), 100);
      expect(first(q2)).toBe(SOUND_NONE); // Phase 3 entriegelt
      const q3 = createSoundQueue();
      emitBuildingSound(bCtx(8 * 7, l, q3), bld({ type }), 100);
      expect(first(q3)).toBe(0x3e); // phase 7 with an open latch
      const q4 = createSoundQueue();
      emitBuildingSound(bCtx(8 * 7, l, q4), bld({ type }), 100);
      expect(first(q4)).toBe(SOUND_NONE); // phase 7 again: now the latch bites
    }
  });

  it('a mine sounds only while the miner is underground', () => {
    const q = createSoundQueue();
    // playingSfx == false => silent, whatever the phase
    for (let t = 0; t < 256; t++) {
      emitBuildingSound(bCtx(t, createSoundLatches(), q), bld({ type: 6, playingSfx: false }), 100);
    }
    expect(first(q)).toBe(SOUND_NONE);
  });

  it('mine: phase offset from the position — two mines have shifted time windows', () => {
    const a = bld({ index: 1, type: 6, playingSfx: true, col: 10, row: 20 });
    const b = bld({ index: 2, type: 6, playingSfx: true, col: 10, row: 21 });
    expect(buildingPosByte1(a, GEO)).not.toBe(buildingPosByte1(b, GEO));

    /** Ticks at which the sound succeeds — with ONE continuous random stream per building. */
    const hitsOf = (x: BuildingRecord): number[] => {
      const rng = new Rng(seed);
      const hits: number[] = [];
      for (let t = 0; t < 256; t++) {
        const q = createSoundQueue();
        emitBuildingSound(bCtx(t, createSoundLatches(), q, rng), x, 100);
        if (q.slots[0] === 0x26) hits.push(t);
      }
      return hits;
    };
    /** The phase window: `((tick + byte1) & 0xff) >> 3 & 7 == 0` — independent of the RNG. */
    const windowOf = (x: BuildingRecord): number[] => {
      const b1 = buildingPosByte1(x, GEO);
      const w: number[] = [];
      for (let t = 0; t < 256; t++) if ((((t + b1) & 0xff) >> 3 & 7) === 0) w.push(t);
      return w;
    };

    const [wa, wb] = [windowOf(a), windowOf(b)];
    expect(wa).not.toEqual(wb); // the offset takes effect
    expect(wa).toHaveLength(32); // 8 of 64 ticks, so 32 over 256
    // Every hit lies inside the window (chance can only suppress further, never add) ...
    const ha = hitsOf(a);
    expect(ha.length).toBeGreaterThan(0);
    expect(ha.every((t) => wa.includes(t))).toBe(true);
    // ... and ~61 % of the window ticks succeed (40000/65536).
    expect(ha.length).toBeGreaterThan(wa.length * 0.4);
    expect(ha.length).toBeLessThanOrEqual(wa.length);
  });

  it('pig farm: the probability grows with the number of pigs', () => {
    const count = (pigs: number): number => {
      let n = 0;
      const rng = new Rng(seed);
      for (let i = 0; i < 400; i++) {
        const q = createSoundQueue();
        const b = bld({ type: 14, stock: [{ available: 0, requested: 0 }, { available: 0, requested: pigs }] } as never);
        emitBuildingSound(bCtx(0, createSoundLatches(), q, rng), b, 100);
        if (q.slots[0] === 0x3c) n++;
      }
      return n;
    };
    expect(count(0)).toBe(0);
    const one = count(1);
    const eight = count(8);
    expect(one).toBeGreaterThan(0);
    expect(eight).toBeGreaterThan(one * 3);
  });

  it('burning building: phase 3 of the burn countdown', () => {
    // Type 12 (farm) has no sound of its own — so the test measures only the fire branch.
    const l = createSoundLatches();
    const q = createSoundQueue();
    // (firstKnight >> 3) & 3 == 3  ⇒  e.g. 0x18..0x1f
    emitBuildingSound(bCtx(0, l, q), bld({ type: 12, burning: true, firstKnight: 0x18 }), 100);
    expect(first(q)).toBe(0x54);
    const q2 = createSoundQueue();
    emitBuildingSound(bCtx(0, l, q2), bld({ type: 12, burning: true, firstKnight: 0x18 }), 100);
    expect(first(q2)).toBe(SOUND_NONE); // Riegel
    const q3 = createSoundQueue();
    emitBuildingSound(bCtx(0, l, q3), bld({ type: 12, burning: true, firstKnight: 0x10 }), 100);
    expect(first(q3)).toBe(SOUND_NONE); // Phase 2 entriegelt
  });

  it('the fire branch runs BEFORE the type branch, not instead of it', () => {
    // The fire branch ends in `FUN_00034a70`, which calls `FUN_00034eb0` @0x34eb0 — the same
    // dispatcher as usual. So a burning mill keeps grinding on screen.
    const q = createSoundQueue();
    emitBuildingSound(bCtx(0, createSoundLatches(), q), bld({ type: 15, burning: true, firstKnight: 0x10 }), 100);
    expect([...q.slots].filter((s) => s !== SOUND_NONE)).toEqual([0x42]); // mill sound, fire phase 2

    // And the quirk that follows: both branches share `building[5]` bit 3. When the fire branch
    // enqueues 0x54 (phase 3) it sets the very latch the mill branch checks right after.
    const q2 = createSoundQueue();
    emitBuildingSound(bCtx(0, createSoundLatches(), q2), bld({ type: 15, burning: true, firstKnight: 0x18 }), 100);
    expect([...q2.slots].filter((s) => s !== SOUND_NONE)).toEqual([0x54]); // 0x42 vom Riegel gesperrt
  });

  it('non-sounding types stay silent (farm/butcher/sawmill/forester/warehouse)', () => {
    for (const type of [12, 13, 17, 9, 10, 11, 20, 24]) {
      const q = createSoundQueue();
      for (let t = 0; t < 64; t++) {
        emitBuildingSound(bCtx(t, createSoundLatches(), q), bld({ type, playingSfx: true }), 100);
      }
      expect(first(q)).toBe(SOUND_NONE);
    }
  });

  it('clip: nothing is enqueued below the map area', () => {
    const q = createSoundQueue();
    emitBuildingSound(bCtx(0, createSoundLatches(), q), bld({ type: 15 }), 432);
    expect(first(q)).toBe(SOUND_NONE);
  });
});

describe('serf pass — one-shot latches and the per-type sign gates', () => {
  /**
   * The last parameter is the **frame body byte** (`vreg2` at the type dispatcher @0x25df5), not the
   * animation index `serf[1]` — the type routines compare only that byte (`cmpb $0xb3,0x8(%edi)`
   * @0x262e4).
   */
  const emit = (ctx: SerfSoundCtx, serf: SerfRecord, sprite: number): void =>
    emitSerfSound(ctx, serf, 10, 10, sprite);

  it('sawmill worker: saw sound once per phase, unlatched afterwards', () => {
    const l = createSoundLatches();
    const q1 = createSoundQueue();
    emit(sCtx(l, q1), srf({ type: 6 }), 0xb3);
    expect(first(q1)).toBe(0x2b);
    const q2 = createSoundQueue();
    emit(sCtx(l, q2), srf({ type: 6 }), 0xb7);
    expect(first(q2)).toBe(SOUND_NONE); // 0xb7 tests the latch
    const q3 = createSoundQueue();
    emit(sCtx(l, q3), srf({ type: 6 }), 0x90);
    expect(first(q3)).toBe(SOUND_NONE); // entriegelt
    const q4 = createSoundQueue();
    emit(sCtx(l, q4), srf({ type: 6 }), 0xb7);
    expect(first(q4)).toBe(0x2b); // jetzt wieder
  });

  it('the gate reads the FRAME byte, not serf[1] — otherwise it would sound per state, not per frame', () => {
    // The same serf (animation index 0xb3), two consecutive frames of the animation.
    const l = createSoundLatches();
    const s = srf({ type: 6, animation: 0xb3 });
    const qTonal = createSoundQueue();
    emit(sCtx(l, qTonal), s, 0xb3); // the frame carries the strike
    expect(first(qTonal)).toBe(0x2b);
    const qQuiet = createSoundQueue();
    emit(sCtx(l, qQuiet), s, 0xb4); // next frame of the same animation
    expect(first(qQuiet)).toBe(SOUND_NONE);
  });

  it('the sailor requires frame < 0x80, the digger >= 0x80 — exactly inverted', () => {
    const qs = createSoundQueue();
    emit(sCtx(createSoundLatches(), qs), srf({ type: 1, state: 3 }), 0x03);
    expect(first(qs)).toBe(0x40);
    const qs2 = createSoundQueue();
    emit(sCtx(createSoundLatches(), qs2), srf({ type: 1, state: 3 }), 0x83);
    expect(first(qs2)).toBe(SOUND_NONE);

    const qd = createSoundQueue();
    emit(sCtx(createSoundLatches(), qd), srf({ type: 2 }), 0x83);
    expect(first(qd)).toBe(0x32);
    const qd2 = createSoundQueue();
    emit(sCtx(createSoundLatches(), qd2), srf({ type: 2 }), 0x03);
    expect(first(qd2)).toBe(SOUND_NONE);
  });

  it('the sailor sounds only in states 3 / 26 / 27', () => {
    for (const state of [3, 26, 27]) {
      const q = createSoundQueue();
      emit(sCtx(createSoundLatches(), q), srf({ type: 1, state }), 0x03);
      expect(first(q)).toBe(0x40);
    }
    const q = createSoundQueue();
    emit(sCtx(createSoundLatches(), q), srf({ type: 1, state: 5 }), 0x03);
    expect(first(q)).toBe(SOUND_NONE);
  });

  it('the fisher has NO latch — he enqueues in every frame of the band', () => {
    const l = createSoundLatches();
    for (let i = 0; i < 5; i++) {
      const q = createSoundQueue();
      emit(sCtx(l, q), srf({ type: 11 }), 0x85);
      expect(first(q)).toBe(0x36);
    }
    // The four exempted frame bytes stay silent.
    for (const sprite of [0x80, 0x87, 0x88, 0x8f]) {
      const q = createSoundQueue();
      emit(sCtx(l, q), srf({ type: 11 }), sprite);
      expect(first(q)).toBe(SOUND_NONE);
    }
  });

  it('lumberjack: fall sound 0x22 only together with the axe sound and at a small counter', () => {
    const q = createSoundQueue();
    emit(sCtx(createSoundLatches(), q), srf({ type: 5, counter: 0x10 }), 0x85);
    expect([...q.slots].filter((s) => s !== SOUND_NONE).sort()).toEqual([0x20, 0x22]);
    // counter too large => axe only
    const q2 = createSoundQueue();
    emit(sCtx(createSoundLatches(), q2), srf({ type: 5, counter: 0x40 }), 0x85);
    expect([...q2.slots].filter((s) => s !== SOUND_NONE)).toEqual([0x20]);
    // serf[0xe] != 0 => axe only
    const q3 = createSoundQueue();
    emit(
      sCtx(createSoundLatches(), q3),
      srf({ type: 5, counter: 0x10, stateData: [0, 0, 0, 1, 0] }),
      0x85,
    );
    expect([...q3.slots].filter((s) => s !== SOUND_NONE)).toEqual([0x20]);
  });

  it('lumberjack: with a closed latch and frame 0x86 the fall sound drops out TOO', () => {
    const l = createSoundLatches();
    const q1 = createSoundQueue();
    emit(sCtx(l, q1), srf({ type: 5, counter: 0x10 }), 0x85);
    expect(q1.slots[0]).toBe(0x20);
    const q2 = createSoundQueue();
    emit(sCtx(l, q2), srf({ type: 5, counter: 0x10 }), 0x86);
    expect([...q2.slots]).toEqual([SOUND_NONE, SOUND_NONE, SOUND_NONE, SOUND_NONE]);
  });

  it('toolmaker and geologist each have TWO pairs with different sounds', () => {
    const pairs: readonly [number, number, number][] = [
      [18, 0x83, 0x2a],
      [18, 0x87, 0x24],
      [20, 0x8c, 0x1a],
      [20, 0x83, 0x2e],
    ];
    for (const [type, sprite, sound] of pairs) {
      const q = createSoundQueue();
      emit(sCtx(createSoundLatches(), q), srf({ type }), sprite);
      expect(first(q)).toBe(sound);
    }
  });

  it('types without a sound routine stay silent (transporter, knight, generic)', () => {
    for (const type of [0, 4, 21, 22, 23, 24, 25, 26]) {
      const q = createSoundQueue();
      for (let sprite = 0; sprite < 256; sprite++) {
        emit(sCtx(createSoundLatches(), q), srf({ type }), sprite);
      }
      expect(first(q)).toBe(SOUND_NONE);
    }
  });
});

describe('fight: one sound per blow', () => {
  const fighter = (pose: number, counter: number, state = 0x30): SerfRecord =>
    srf({ type: 22, state, counter, stateData: [0, 0, pose, 0, 0] });

  it('sounds in the counter window [8, 0x18) and again only after unlatching', () => {
    const l = createSoundLatches();
    const q1 = createSoundQueue();
    emitFightSound(sCtx(l, q1), fighter(2, 10), 10, 10);
    expect(first(q1)).toBe(0x12);
    const q2 = createSoundQueue();
    emitFightSound(sCtx(l, q2), fighter(2, 12), 10, 10);
    expect(first(q2)).toBe(SOUND_NONE); // derselbe Schlag
    // Outside the window it unlatches (`btr $0x7` @0x26d74) ...
    const q3 = createSoundQueue();
    emitFightSound(sCtx(l, q3), fighter(2, 0x40), 10, 10);
    expect(first(q3)).toBe(SOUND_NONE);
    // ... so the NEXT strike sounds again. Without that branch it would stay silent forever.
    const q4 = createSoundQueue();
    emitFightSound(sCtx(l, q4), fighter(2, 10), 10, 10);
    expect(first(q4)).toBe(0x12);
  });

  it('the pose picks the sound; pose 2 sounds like 0x12 (0x0e is unreachable in the original)', () => {
    for (const [pose, sound] of [
      [0, 0x0a],
      [1, 0x16],
      [2, 0x12],
      [3, 0x16],
      [4, 0x0a],
    ] as const) {
      const q = createSoundQueue();
      emitFightSound(sCtx(createSoundLatches(), q), fighter(pose, 10), 10, 10);
      expect(first(q)).toBe(sound);
    }
  });

  it('only the attacker states 48/60 sound — so a strike sounds once, not twice', () => {
    for (const state of [0x30, 0x3c]) {
      const q = createSoundQueue();
      emitFightSound(sCtx(createSoundLatches(), q), fighter(1, 10, state), 10, 10);
      expect(first(q)).toBe(0x16);
    }
    for (const state of [49, 61]) {
      const q = createSoundQueue();
      emitFightSound(sCtx(createSoundLatches(), q), fighter(1, 10, state), 10, 10);
      expect(first(q)).toBe(SOUND_NONE);
    }
  });

  it('a state change does NOT unlatch (in the original it exits without a `btr`)', () => {
    const l = createSoundLatches();
    const q1 = createSoundQueue();
    emitFightSound(sCtx(l, q1), fighter(1, 10), 10, 10);
    expect(first(q1)).toBe(0x16);
    emitFightSound(sCtx(l, createSoundQueue()), fighter(1, 10, 49), 10, 10);
    expect(l.serf.has(3)).toBe(true);
  });
});
