import { describe, it, expect } from 'vitest';
import { Rng } from './engine/rng.js';
import {
  createSoundMixer,
  createSoundQueue,
  enqueueSound,
  enqueueSoundIfVisible,
  enqueueSoundIfYVisible,
  serviceSound,
  sfxArchiveSlot,
  soundServiceDue,
  soundParams,
  SFX_PARAM_COUNT,
  SOUND_NONE,
  tickSoundVoices,
} from './sound.js';

const seed = [0x0380, 0xeea7, 0x6b11] as const;

describe('priority queue (@0x3688a)', () => {
  it('sorts ascending and evicts the worst slot', () => {
    const q = createSoundQueue();
    for (const s of [0x40, 0x20, 0x54, 0x1a, 0x2b]) enqueueSound(q, s);
    // Five sounds, four slots: the largest (0x54) drops out.
    expect([...q.slots]).toEqual([0x1a, 0x20, 0x2b, 0x40]);
  });

  it('does NOT enqueue an already present sound twice (the original deduplication)', () => {
    const q = createSoundQueue();
    enqueueSound(q, 0x46);
    for (let i = 0; i < 20; i++) enqueueSound(q, 0x46); // 20 visible trees
    expect([...q.slots]).toEqual([0x46, SOUND_NONE, SOUND_NONE, SOUND_NONE]);
  });

  it('a less important sound only fills free slots', () => {
    const q = createSoundQueue();
    enqueueSound(q, 0x10);
    enqueueSound(q, 0x50);
    expect([...q.slots]).toEqual([0x10, 0x50, SOUND_NONE, SOUND_NONE]);
  });
});

describe('clip tests of the two map variants', () => {
  it('the y variant (@0x36930) discards below the map area', () => {
    const q = createSoundQueue();
    enqueueSoundIfYVisible(q, 432, 432, 0x26);
    expect([...q.slots]).toEqual([SOUND_NONE, SOUND_NONE, SOUND_NONE, SOUND_NONE]);
    enqueueSoundIfYVisible(q, 431, 432, 0x26);
    expect(q.slots[0]).toBe(0x26);
  });

  it('unsigned comparison: a negative y drops out as well', () => {
    const q = createSoundQueue();
    enqueueSoundIfYVisible(q, -1, 432, 0x26);
    expect(q.slots[0]).toBe(SOUND_NONE);
  });

  it('the xy variant (@0x3693e) checks both axes', () => {
    const q = createSoundQueue();
    enqueueSoundIfVisible(q, 608, 10, 608, 432, 0x20);
    enqueueSoundIfVisible(q, 10, 432, 608, 432, 0x20);
    expect(q.slots[0]).toBe(SOUND_NONE);
    enqueueSoundIfVisible(q, 607, 431, 608, 432, 0x20);
    expect(q.slots[0]).toBe(0x20);
  });
});

describe('parameter table (@0x61952)', () => {
  it('has 96 entries — the 0x180 bytes at stride 4', () => {
    expect(SFX_PARAM_COUNT).toBe(96);
  });

  it('carries the spread mask only with the four original values', () => {
    const masks = new Set<number>();
    for (let s = 0; s < SFX_PARAM_COUNT; s++) {
      const p = soundParams(s);
      if (p !== null && (p.volume !== 0 || p.duration !== 0)) masks.add(p.volumeMask);
    }
    expect([...masks].sort((a, b) => a - b)).toEqual([0, 7, 15, 31]);
  });

  it('water and wind have base volume 0 (a runtime value of the ambient voices)', () => {
    expect(soundParams(0x56)?.volume).toBe(0);
    expect(soundParams(0x58)?.volume).toBe(0);
    // a fixed sound does not
    expect(soundParams(0x26)?.volume).toBe(35);
  });

  it('0x0e and 0x3a are populated without being reachable in the binary', () => {
    // The fight branch overwrites 0x0e with 0x12 right away; 0x3a has no known caller.
    expect(soundParams(0x0e)).toEqual({ volume: 40, volumeMask: 15, duration: 13 });
    expect(soundParams(0x12)).toEqual({ volume: 40, volumeMask: 15, duration: 11 });
    expect(soundParams(0x3a)).not.toBeNull();
  });

  it('SOUND_NONE lies outside the table (an overflow in the original, silence here)', () => {
    expect(soundParams(SOUND_NONE)).toBeNull();
  });
});

describe('archive mapping', () => {
  it('sound 0 lands on the first occupied SFX slot 3899+0', () => {
    expect(sfxArchiveSlot(0)).toBe(3899);
    expect(sfxArchiveSlot(0x26)).toBe(3899 + 0x26);
  });
});

describe('voice allocation (@0x61fe3)', () => {
  it('distributes across free voices and empties the queue', () => {
    const m = createSoundMixer(seed);
    const q = createSoundQueue();
    enqueueSound(q, 0x26);
    enqueueSound(q, 0x40);
    const starts = serviceSound(m, q);
    expect(starts.map((s) => s.sound)).toEqual([0x26, 0x40]);
    expect([...q.slots]).toEqual([SOUND_NONE, SOUND_NONE, SOUND_NONE, SOUND_NONE]);
  });

  it('an empty queue starts nothing (no table overflow as in the original)', () => {
    const m = createSoundMixer(seed);
    expect(serviceSound(m, createSoundQueue())).toEqual([]);
  });

  it('overwrites the voice holding the LEAST important running sound', () => {
    const m = createSoundMixer(seed);
    m.voices[0]!.sound = 0x10; // important
    m.voices[0]!.remaining = 50;
    m.voices[1]!.sound = 0x60; // unimportant
    m.voices[1]!.remaining = 50;
    m.voices[2]!.sound = 0x20;
    m.voices[2]!.remaining = 50;
    m.voices[3]!.sound = 0x30;
    m.voices[3]!.remaining = 50;
    const q = createSoundQueue();
    enqueueSound(q, 0x2b);
    const starts = serviceSound(m, q);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.voice).toBe(1); // 0x60 was the largest running value
    expect(m.voices[1]!.sound).toBe(0x2b);
  });

  it('leaves a more important running sound alone', () => {
    const m = createSoundMixer(seed);
    for (const v of m.voices) {
      v.sound = 0x10;
      v.remaining = 50;
    }
    const q = createSoundQueue();
    enqueueSound(q, 0x40); // less important than everything running
    expect(serviceSound(m, q)).toEqual([]);
  });

  it('volume = base + (random & mask), inside the mask bounds', () => {
    const m = createSoundMixer(seed);
    const p = soundParams(0x26)!;
    for (let i = 0; i < 40; i++) {
      m.voices.forEach((v) => {
        v.sound = SOUND_NONE;
        v.remaining = 0;
      });
      const q = createSoundQueue();
      enqueueSound(q, 0x26);
      const [s] = serviceSound(m, q);
      expect(s!.volume).toBeGreaterThanOrEqual(p.volume);
      expect(s!.volume).toBeLessThanOrEqual(p.volume + p.volumeMask);
    }
  });

  it('consumes exactly one draw of its OWN stream per started sound', () => {
    // Determinism guard: the sound randomness must not touch the game RNG (see `sound.ts`). Checked
    // against a fresh stream with the same seed — after one start the mixer stream must be exactly
    // one draw further.
    const m = createSoundMixer(seed);
    const reference = new Rng(seed);
    const q = createSoundQueue();
    enqueueSound(q, 0x26);
    serviceSound(m, q);
    reference.next();
    expect(m.rng.next()).toBe(reference.next());
  });
});

describe('duration countdown (@0x61cc8)', () => {
  it('frees the voice once the duration has run out', () => {
    const m = createSoundMixer(seed);
    const q = createSoundQueue();
    enqueueSound(q, 0x26); // duration 4
    serviceSound(m, q);
    expect(m.voices[0]!.remaining).toBe(4);
    for (let i = 0; i < 3; i++) tickSoundVoices(m);
    expect(m.voices[0]!.sound).toBe(0x26);
    tickSoundVoices(m);
    expect(m.voices[0]!.sound).toBe(SOUND_NONE);
    expect(m.voices[0]!.remaining).toBe(0);
  });

  it('a free voice stays untouched', () => {
    const m = createSoundMixer(seed);
    tickSoundVoices(m);
    expect(m.voices.every((v) => v.sound === SOUND_NONE && v.remaining === 0)).toBe(true);
  });
});

describe('service cadence of the queue (port addition: paused simulation)', () => {
  it('while the simulation runs, the logic frame decides alone', () => {
    const q = createSoundQueue();
    expect(soundServiceDue(true, true, q)).toBe(true);
    expect(soundServiceDue(false, true, q)).toBe(false);
    enqueueSound(q, 0x4c);
    // Do NOT service in between even with a sound waiting: that would drop the competition with the
    // sounds of the drawing pass, which the original settles within the same frame.
    expect(soundServiceDue(false, true, q)).toBe(false);
  });

  it('while the simulation is paused, it services as soon as the queue holds something', () => {
    const q = createSoundQueue();
    // The failure case: `gameTick` stands still, the logic gate never fires — without this rule the
    // UI sound would stay queued forever.
    expect(soundServiceDue(false, false, q)).toBe(false); // empty => nothing to do
    enqueueSound(q, 0x4c);
    expect(soundServiceDue(false, false, q)).toBe(true);
  });

  it('once emptied, a paused run is quiet again (no servicing on every repaint)', () => {
    const q = createSoundQueue();
    const mixer = createSoundMixer([1, 2, 3]);
    enqueueSound(q, 0x4c);
    expect(serviceSound(mixer, q).map((s) => s.sound)).toEqual([0x4c]);
    expect(soundServiceDue(false, false, q)).toBe(false);
  });
});
