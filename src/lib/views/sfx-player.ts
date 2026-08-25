/**
 * Browser playback of the sound effects — the backend side of `core/sound.ts`.
 *
 * Four voices as in the original (`sfx_driver_play` @0x20c0); a new sound replaces the old one on
 * the same voice. An `AudioContext` may only run after a user gesture, so everything before the
 * first `resume()` is silently dropped.
 */

import { decodeSfx, SFX_SAMPLE_RATE } from '../core/sound-decoder.js';
import { sfxArchiveSlot, SOUND_VOICES, type SoundStart } from '../core/sound.js';
import { VOLUME_MAX } from '../core/engine/view-options.js';

/** Only what the player needs from the archive — keeps it testable without one. */
export interface SfxSource {
  getRaw(index: number): Uint8Array | null;
}

/**
 * Denominator of the volume taken from the parameter table (its largest base value is 64). How the
 * DOS driver mapped that onto a real level has not been read — linear is an assumption here.
 */
const SFX_VOLUME_FULL = 64;

interface Voice {
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
}

export class SfxPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly voices: Voice[] = Array.from({ length: SOUND_VOICES }, () => ({
    source: null,
    gain: null,
  }));
  private readonly cache = new Map<number, AudioBuffer>();
  /** Remember once instead of retrying every frame. */
  private readonly missing = new Set<number>();
  private masterVolume = 1;

  constructor(private readonly source: SfxSource) {}

  /** `false` before the first user gesture. */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Call only from a user event; calling it repeatedly is harmless. */
  async resume(): Promise<void> {
    if (this.ctx === null) {
      const Ctor = globalThis.AudioContext;
      if (Ctor === undefined) return; // no Web Audio (e.g. test environment)
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Volume from the options screen (0..99). */
  setMasterVolume(volume0to99: number): void {
    this.masterVolume = Math.max(0, Math.min(VOLUME_MAX, volume0to99)) / VOLUME_MAX;
    if (this.master !== null) this.master.gain.value = this.masterVolume;
  }


  stopAll(): void {
    for (const v of this.voices) this.releaseVoice(v);
  }

  /** A no-op before the first user gesture. */
  play(starts: readonly SoundStart[]): void {
    if (this.ctx === null || this.master === null || this.ctx.state !== 'running') return;
    for (const s of starts) {
      const voice = this.voices[s.voice];
      if (voice === undefined) continue;
      const buffer = this.buffer(s.sound);
      if (buffer === null) continue;
      this.releaseVoice(voice);
      const gain = this.ctx.createGain();
      gain.gain.value = Math.min(1, s.volume / SFX_VOLUME_FULL);
      gain.connect(this.master);
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.onended = (): void => {
        if (voice.source === src) {
          voice.source = null;
          voice.gain = null;
        }
        gain.disconnect();
      };
      voice.source = src;
      voice.gain = gain;
      src.start();
    }
  }

  private releaseVoice(v: Voice): void {
    if (v.source !== null) {
      v.source.onended = null;
      try {
        v.source.stop();
      } catch {
        // already finished
      }
      v.source.disconnect();
      v.source = null;
    }
    if (v.gain !== null) {
      v.gain.disconnect();
      v.gain = null;
    }
  }

  private buffer(sound: number): AudioBuffer | null {
    const hit = this.cache.get(sound);
    if (hit !== undefined) return hit;
    if (this.missing.has(sound) || this.ctx === null) return null;
    const raw = this.source.getRaw(sfxArchiveSlot(sound));
    if (raw === null || raw.byteLength === 0) {
      this.missing.add(sound);
      return null;
    }
    const decoded = decodeSfx(raw);
    const buf = this.ctx.createBuffer(1, decoded.samples.length, SFX_SAMPLE_RATE);
    buf.getChannelData(0).set(decoded.samples);
    this.cache.set(sound, buf);
    return buf;
  }
}
