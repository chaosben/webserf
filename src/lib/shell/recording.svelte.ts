/**
 * Bus for the screen recording.
 *
 * Same shape as the bug-report and simulation buses: the VIEW knows the canvas and when an image is
 * finished, the SHELL has the button. The view registers a target while it is mounted; the shell
 * starts and stops.
 *
 * WHY THE VIEW HAS TO PUSH FRAMES: the recording runs at the clone's own drawing pace (~12.5 images
 * per second, and none at all while paused), so the stream is asked for a frame exactly where one
 * was produced — see `views/screen-recorder.ts`. {@link capture} is therefore called once per drawn
 * image and is a no-op the rest of the time.
 *
 * NOTHING IS KEPT once a recording ends: it is on disk, and what stays here is only whether it
 * worked and how much came out. The one thing held on to is the STILL PICTURE of the panel's first
 * stage, and only for as long as the panel is open — see {@link RecordingBus.takeStill}.
 */
import {
  ScreenRecorder,
  canvasPng,
  recordingFileName,
  type RecordingResult,
  type RecordingTarget,
} from '../views/screen-recorder.js';

/** A still picture of the game screen, ready to be shown and downloaded. */
export interface RecordingStill {
  /** Object URL — owned by the bus, see {@link RecordingBus.takeStill}. */
  readonly url: string;
  readonly fileName: string;
  readonly bytes: number;
}

class RecordingBus {
  #target: RecordingTarget | null = $state(null);
  readonly #recorder = new ScreenRecorder();

  /** Is a recording running? */
  running = $state(false);
  /** Starting or stopping is in progress — the button must not fire twice. */
  busy = $state(false);
  /** What came out of the last recording. */
  last = $state<RecordingResult | null>(null);
  /** Why it failed, if it did. */
  error = $state<string | null>(null);
  /** The still picture taken when the panel was opened, `null` while there is none. */
  still = $state<RecordingStill | null>(null);

  /**
   * Images handed to the stream so far — the honest progress indicator, and deliberately **not**
   * reactive: it grows once per drawn image, from inside the drawing pass. As `$state` it would
   * invalidate the reactivity graph at exactly the rate it is meant to measure. Whoever displays it
   * polls (see `RecordingPanel`) — the same arrangement the render measurement uses.
   */
  get frameCount(): number {
    return this.#recorder.frames;
  }

  /** Is a view mounted that has something to record? */
  available = $derived(this.#target !== null);

  /** Register. Returns the unregister function — fits straight into an `$effect` return. */
  provide(target: RecordingTarget): () => void {
    this.#target = target;
    return () => {
      if (this.#target === target) this.#target = null;
    };
  }

  /**
   * One finished image. Cheap enough to call unconditionally: without a running recording it does
   * nothing at all.
   */
  capture(): void {
    if (!this.#recorder.recording) return;
    this.#recorder.capture();
  }

  /**
   * A still picture of what is on screen right now. `null` when no view is mounted or the canvas
   * would not give up a picture.
   *
   * THE OBJECT URL BELONGS TO THE BUS: a previous one is released here, the last one in
   * {@link clearStill}. Keeping the whole life cycle in one place makes it provable without a
   * browser — spread across a panel it would not be, and a stray full-window PNG per opening is a
   * real leak.
   */
  async takeStill(now: Date): Promise<RecordingStill | null> {
    const target = this.#target;
    if (target === null) return null;
    const blob = await canvasPng(target.canvas);
    if (blob === null) return null;
    const url = URL.createObjectURL(blob);
    this.#releaseStill();
    this.still = { url, fileName: recordingFileName(now, 'png'), bytes: blob.size };
    return this.still;
  }

  /** Drop the still picture and its object URL. */
  clearStill(): void {
    this.#releaseStill();
    this.still = null;
  }

  #releaseStill(): void {
    const prev = this.still;
    if (prev !== null) URL.revokeObjectURL(prev.url);
  }

  /** Start. MUST run inside a user gesture — the file picker needs one. */
  async start(now: Date): Promise<boolean> {
    const target = this.#target;
    if (target === null || this.busy || this.running) return false;
    this.busy = true;
    this.error = null;
    this.last = null;
    try {
      const started = await this.#recorder.start(target, recordingFileName(now));
      this.running = started;
      // Not an error: cancelling the file picker is a decision, and so is a browser that cannot
      // record at all — but the two have to be told apart.
      if (!started && !recordingSupported()) {
        this.error = 'This browser cannot record the canvas.';
      }
      return started;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.running = false;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Stop and close the file. Hands back the download when the browser could not stream. */
  async stop(): Promise<RecordingResult | null> {
    if (!this.running || this.busy) return null;
    this.busy = true;
    try {
      const result = await this.#recorder.stop();
      this.running = false;
      this.last = result;
      return result;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.running = false;
      return null;
    } finally {
      this.busy = false;
    }
  }
}

/** Can this browser record a canvas at all? */
export function recordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'captureStream' in HTMLCanvasElement.prototype
  );
}

export const recordings = new RecordingBus();
