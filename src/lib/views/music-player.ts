/**
 * Background music — the browser side of `core/music.ts`.
 *
 * ONE TRACK, LOOPING — that is all the original knows *in game*. The one switch that exists belongs
 * to the END CREDITS (`run_end_credits` @0x38b55 starts DOS 0xf98 and switches back to 0xf96 at the
 * end); {@link MusicPlayer.setTrack} serves that. The track is therefore player state and no longer
 * a constant — which number applies is still decided in `core/music.ts`.
 *
 * Two browser quirks shape the design: an `AudioContext` may only run after a user gesture (`start`
 * before that is a remembered wish), and the FM synth loads WASM plus an instrument bank on demand —
 * which can fail, hence {@link lastError} instead of a throw in the click path.
 */

import { FmPlayer } from '../core/fm-synth.js';
import { MUSIC_ARCHIVE_GAME } from '../core/music.js';
import { xmiToSmf } from '../core/xmi-to-smf.js';
import { VOLUME_MAX } from '../core/engine/view-options.js';

/** Only what the player needs from the archive. */
export interface MusicSource {
  getRaw(index: number): Uint8Array | null;
}

export class MusicPlayer {
  private player: FmPlayer | null = null;
  private loading: Promise<boolean> | null = null;
  private error: string | null = null;
  /** Survives a load that is still running. */
  private wanted = false;
  private volume = 1;
  /** The archive entry that is loaded or being loaded — the parameter of `0x2010` in the original. */
  private track = MUSIC_ARCHIVE_GAME;

  constructor(private readonly source: MusicSource) {}

  /** Error message of the last attempt, or `null`. */
  get lastError(): string | null {
    return this.error;
  }

  get playing(): boolean {
    return this.wanted && this.player?.status.state === 'playing';
  }

  /** Call only from a user event (autoplay policy). */
  async start(): Promise<void> {
    this.wanted = true;
    const ready = await this.ensureLoaded();
    // Between the `await` and here the setting may have been switched off again.
    if (!ready || !this.wanted) return;
    await this.player?.play();
  }

  /** Which track is current (archive entry, 0-based). */
  get currentTrack(): number {
    return this.track;
  }

  /**
   * SWITCH THE TRACK — the counterpart of `call 0x2010` with a different index.
   *
   * The old track is discarded (the synth holds WASM and an instrument bank, so not just a `stop`),
   * the new one is loaded, and if music was playing it continues. The same track twice is a no-op:
   * the original also calls `0x2010` only at the three places where something changes, and
   * reloading mid-piece would be an audible gap.
   */
  async setTrack(entry: number): Promise<void> {
    if (entry === this.track) return;
    this.track = entry;
    const old = this.player;
    this.player = null;
    this.loading = null;
    this.error = null;
    await old?.dispose();
    if (this.wanted) await this.start();
  }

  /** The loaded track stays; only playback ends. */
  stop(): void {
    this.wanted = false;
    this.player?.stop();
  }

  /** 0..99 — the same number as for the sound effects; there is no separate music slider. */
  setVolume(volume0to99: number): void {
    this.volume = Math.max(0, Math.min(VOLUME_MAX, volume0to99)) / VOLUME_MAX;
    this.player?.setVolume(this.volume);
  }

  async dispose(): Promise<void> {
    this.wanted = false;
    const p = this.player;
    this.player = null;
    this.loading = null;
    await p?.dispose();
  }

  /** Load exactly once; `false` when the archive entry or the synth does not cooperate. */
  private ensureLoaded(): Promise<boolean> {
    if (this.loading !== null) return this.loading;
    this.loading = this.load();
    return this.loading;
  }

  private async load(): Promise<boolean> {
    const entry = this.track;
    const raw = this.source.getRaw(entry);
    if (raw === null || raw.byteLength === 0) {
      this.error = `Archive entry ${entry} (music) is empty.`;
      return false;
    }
    try {
      // Convert XMI into a standard MIDI; the synth accepts both, but this route is the proven one.
      const smf = xmiToSmf(raw);
      const player = new FmPlayer();
      await player.loadSong(smf, `Music ${entry}`);
      player.setLoop(true); // in the original the track never ends
      player.setVolume(this.volume);
      this.player = player;
      this.error = null;
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }
}
