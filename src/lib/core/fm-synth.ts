/**
 * OPL3/FM player on top of libadlmidi-js (profile `dosbox`).
 *
 * The bank is fixed to the **AIL (SimFarm, Settlers, Serf City)** FM patch bank shipped with Miles
 * Sound System. That gives the sound DOSBox produces when playing the original — same OPL3 emulator
 * code base, same patches.
 *
 * libADLMIDI consumes **XMI directly**, so no detour through an SMF converter.
 */

import { AdlMidi } from 'libadlmidi-js';
import processorUrl from 'libadlmidi-js/dist/libadlmidi.dosbox.processor.js?url';
import wasmUrl from 'libadlmidi-js/dist/libadlmidi.dosbox.core.wasm?url';

/** Original Miles patches, embedded in the WASM. */
export const SETTLERS_BANK_NAME = 'AIL (SimFarm, Settlers, Serf City)';

export type PlayerState =
  | 'idle'
  | 'loading'
  | 'no-song'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'error';

export interface PlayerStatus {
  readonly state: PlayerState;
  readonly bankName: string | null;
  readonly songName: string | null;
  readonly errorMessage: string | null;
}

export class FmPlayer {
  private synth: AdlMidi | null = null;
  private initPromise: Promise<void> | null = null;

  private _state: PlayerState = 'idle';
  private _bankName: string | null = null;
  private _songName: string | null = null;
  private _errorMessage: string | null = null;
  private _duration = 0;
  private _position = 0;
  private hasSong = false;

  private unsubFromSynth: (() => void) | null = null;
  private unsubFromEnd: (() => void) | null = null;

  /** Gain node between worklet and output, see {@link setVolume}. Created on demand. */
  private gainNode: GainNode | null = null;
  /** Remembered volume so a call BEFORE synth initialisation is not lost. */
  private volume = 1;

  private listeners = new Set<(status: PlayerStatus) => void>();

  get status(): PlayerStatus {
    return {
      state: this._state,
      bankName: this._bankName,
      songName: this._songName,
      errorMessage: this._errorMessage,
    };
  }

  get duration(): number {
    return this._duration;
  }

  get currentTime(): number {
    return this._position;
  }

  subscribe(listener: (status: PlayerStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /**
   * Load XMI or MIDI bytes. libADLMIDI detects either automatically from the header.
   */
  async loadSong(bytes: Uint8Array, name: string | null = null): Promise<void> {
    this.setState('loading');
    try {
      await this.ensureReady();
      const buffer = sliceToArrayBuffer(bytes);
      const info = await this.synth!.loadMidi(buffer);
      this._duration = info.duration;
      this._position = 0;
      this._songName = name;
      this.hasSong = true;
      this.recomputeState();
    } catch (err) {
      this.setError(`Could not load song: ${describeError(err)}`);
      throw err;
    }
  }

  async play(): Promise<void> {
    if (!this.synth || !this.hasSong) return;
    const ctx = this.synth.audioContext;
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume();
    }
    this.synth.play();
    this.setState('playing');
  }

  pause(): void {
    if (this.synth && this._state === 'playing') {
      // libADLMIDI has no explicit pause — stop freezes the position.
      this.synth.stop();
      this.setState('paused');
    }
  }

  stop(): void {
    if (this.synth && this.hasSong) {
      this.synth.stop();
      this.synth.seek(0);
      this._position = 0;
      this.recomputeState();
    }
  }

  seek(seconds: number): void {
    if (this.synth) {
      this.synth.seek(seconds);
      this._position = seconds;
      this.notify();
    }
  }

  /**
   * **Loop forever** — for the game's background music, which never ends in the original
   * (`music.ts`: exactly three track starts in the whole binary, none of them a successor).
   *
   * Deliberately the library's own loop rather than restarting at the end: `onPlaybackEnded` +
   * `seek(0)` + `play()` would leave an audible gap, because that round trip goes through the main
   * thread.
   * `setLoopCount(-1)` == unlimited.
   */
  setLoop(enabled: boolean): void {
    if (!this.synth) return;
    this.synth.setLoopEnabled(enabled);
    this.synth.setLoopCount(enabled ? -1 : 0);
  }

  /**
   * **Volume 0..1.** In the original the same number as for the sound effects (`gs+0x3dc`, handed to
   * the driver right after the track start: `call 0x2080` @0x2080).
   *
   * libADLMIDI has no master control, so a `GainNode` sits between worklet and output. That is safe:
   * the library connects its node **exactly once** in `init()` and disconnects it only in `close()` —
   * there is no place that later wires to `destination` again and would open a second, undamped
   * path.
   */
  setVolume(fraction: number): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    this.volume = clamped;
    const gain = this.ensureGain();
    if (gain !== null) gain.gain.value = clamped;
  }

  /** Creates the gain node and splices it in — on first need, remembered afterwards. */
  private ensureGain(): GainNode | null {
    if (this.gainNode !== null) return this.gainNode;
    const ctx = this.synth?.audioContext ?? null;
    const node = this.synth?.node ?? null;
    if (ctx === null || node === null) return null;
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    node.disconnect();
    node.connect(gain);
    gain.connect(ctx.destination);
    this.gainNode = gain;
    return gain;
  }

  async dispose(): Promise<void> {
    this.unsubFromSynth?.();
    this.unsubFromEnd?.();
    this.unsubFromSynth = null;
    this.unsubFromEnd = null;
    try {
      this.synth?.close();
    } catch {
      // ignore
    }
    // After `close()` the worklet node is gone; the gain node must go with it, otherwise the next
    // `ensureGain()` finds a stale gain on the context and the new path would be damped twice.
    this.gainNode?.disconnect();
    this.gainNode = null;
    this.synth = null;
    this.initPromise = null;
    this._bankName = null;
    this._songName = null;
    this._duration = 0;
    this._position = 0;
    this.hasSong = false;
    this.setState('idle');
  }

  // -------------------------------------------------------------------------

  private async ensureReady(): Promise<void> {
    if (this.synth !== null) return;
    if (this.initPromise === null) {
      this.initPromise = this.initSynth();
    }
    await this.initPromise;
  }

  private async initSynth(): Promise<void> {
    const synth = new AdlMidi();
    await synth.init(processorUrl, wasmUrl);
    this.synth = synth;

    this.unsubFromSynth = synth.onPlaybackState((s) => {
      this._position = s.position;
      this._duration = s.duration;
      if (s.atEnd && this._state === 'playing') {
        this.recomputeState();
      }
      this.notify();
    });
    this.unsubFromEnd = synth.onPlaybackEnded(() => {
      this._position = 0;
      this.recomputeState();
    });

    // Look up the bank by NAME rather than id: ids can shift between libadlmidi-js versions.
    const banks = await synth.getEmbeddedBanks();
    const settlers = banks.find((b) => b.name === SETTLERS_BANK_NAME);
    if (settlers === undefined) {
      throw new Error(
        `FM bank "${SETTLERS_BANK_NAME}" is not embedded in the linked libADLMIDI ` +
          `(available: ${banks.length} banks). Check the build profile.`,
      );
    }
    await synth.setBank(settlers.id);
    this._bankName = settlers.name;
  }

  private recomputeState(): void {
    if (this._errorMessage !== null) {
      this.setState('error');
      return;
    }
    if (!this.hasSong) this.setState('no-song');
    else this.setState('ready');
  }

  private setState(state: PlayerState): void {
    if (state !== 'error' && this._errorMessage !== null) {
      this._errorMessage = null;
    }
    this._state = state;
    this.notify();
  }

  private setError(message: string): void {
    this._errorMessage = message;
    this._state = 'error';
    this.notify();
  }

  private notify(): void {
    const snap = this.status;
    for (const l of this.listeners) l(snap);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function sliceToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
