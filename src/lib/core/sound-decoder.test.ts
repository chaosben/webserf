import { describe, it, expect } from 'vitest';
import { decodeSfx, SFX_SAMPLE_RATE } from './sound-decoder.js';

describe('decodeSfx', () => {
  it('returns the correct number of samples', () => {
    const raw = new Uint8Array(1000);
    const dec = decodeSfx(raw);
    expect(dec.samples.length).toBe(1000);
  });

  it('bias shift: byte 32 -> 0, byte 0 -> -0.25, byte 160 -> +1, byte 255 -> clamped to +1', () => {
    const raw = new Uint8Array([32, 0, 160, 255]);
    const dec = decodeSfx(raw);
    expect(dec.samples[0]).toBeCloseTo(0, 5);
    expect(dec.samples[1]).toBeCloseTo(-0.25, 5);
    expect(dec.samples[2]).toBeCloseTo(1, 5);
    expect(dec.samples[3]).toBe(1);
  });

  it('the default sample rate is 8000 Hz', () => {
    const dec = decodeSfx(new Uint8Array(0));
    expect(dec.sampleRate).toBe(SFX_SAMPLE_RATE);
    expect(SFX_SAMPLE_RATE).toBe(8000);
  });

  it('Dauer = samples / sampleRate', () => {
    const dec = decodeSfx(new Uint8Array(16_000));
    expect(dec.durationSec).toBeCloseTo(2.0, 5);
  });

  it('honours a supplied sample rate', () => {
    const dec = decodeSfx(new Uint8Array(22_050), 22_050);
    expect(dec.sampleRate).toBe(22_050);
    expect(dec.durationSec).toBeCloseTo(1.0, 5);
  });

  it('leerer Eintrag → 0 Samples, 0 Sekunden', () => {
    const dec = decodeSfx(new Uint8Array(0));
    expect(dec.samples.length).toBe(0);
    expect(dec.durationSec).toBe(0);
  });
});
