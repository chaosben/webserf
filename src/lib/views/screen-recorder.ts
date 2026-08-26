/**
 * **VIDEOAUFNAHME DER SPIELOBERFLÄCHE** — the browser edge behind the recording bus.
 *
 * It records the ONE canvas the game screen lives on. That this is possible at all is the point of
 * composing bar and popup into the map canvas: a recording of a single canvas now shows the game
 * rather than only the map.
 *
 * THREE THINGS ARE NOT OBVIOUS HERE:
 *
 * 1. **`captureStream(0)` plus `requestFrame()`, not a frame rate.** The clone draws one image per
 *    LOGIC frame (~12.5/s, as in the original) and, while the simulation is paused, only on demand.
 *    A stream with its own rate would resample that: it would invent frames during a pause and drop
 *    some while running. Asking for the frame where the image is actually finished keeps the video
 *    at exactly the pace the player saw.
 * 2. **The recording has a canvas of its own, and that is not a convenience.** The pointer has to be
 *    in the video (without it a video shows popups opening for no visible reason) but must not be on
 *    screen, where the system moves the real one and a drawn one would lag a frame behind. Doing
 *    both in the visible canvas was tried and is WRONG: drawing the pointer, asking for the frame
 *    and putting the pixels back within one task assumes `requestFrame()` reads the canvas there and
 *    then — it does not, the browser takes the content when it finishes the image, by which time the
 *    pointer is gone again. Measured by its result: no pointer in the video.
 *    Reading the visible canvas back is also what made recording expensive. `getImageData` is a trip
 *    from the graphics card into main memory that stalls the drawing pipeline, and repeated readback
 *    is the signal for a browser to drop acceleration for that canvas altogether — which slows the
 *    whole game picture, not just the recording. So the recording composes into its OWN canvas: one
 *    blit of the finished image, the pointer on top, and the stream hangs off that canvas.
 * 3. **The file is written WHILE recording.** The chunks go straight to a file the user picked, so a
 *    long session does not grow in memory. Where the file-system access API is missing (Firefox),
 *    the chunks are collected and handed over as a download at the end — same result, bounded by
 *    memory.
 */

/** Is there a file picker to write into, or does this browser need the download fallback? */
export const fileStreamingSupported = (): boolean =>
  typeof globalThis !== 'undefined' && 'showSaveFilePicker' in globalThis;

/**
 * Container and codec, best first — and **VP8 before VP9 on purpose**: VP9 is encoded in software
 * here and costs noticeably more CPU, while its advantage is small for what this records (pixel art,
 * little motion, ~12.5 images per second). The recording must not make the game it records stutter.
 * Safari has no WebM at all and takes MP4. `isTypeSupported` is the only honest test — the lists in
 * the wild are out of date.
 */
const MIME_CANDIDATES = [
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm',
  'video/mp4',
] as const;

/**
 * Target bit rate. Deliberately generous: at ~12.5 images per second this is far more than pixel art
 * on a mostly static screen needs, and the encoder undershoots it on its own — but a panning map at
 * a large window is the case that must not turn to mush, because that is what gets reported.
 */
const VIDEO_BITS_PER_SECOND = 6_000_000;

/** How often the recorder hands over a chunk. Smaller = less to lose if the tab dies. */
const CHUNK_MS = 1000;

/**
 * The mouse pointer as the recording wants it: the ready-made image and its top left corner in
 * canvas pixels. The corner may lie outside — the canvas clips by itself, and nothing has to be put
 * back, so there is no clipping arithmetic here.
 */
export interface RecordingCursor {
  readonly x: number;
  readonly y: number;
  readonly image: CanvasImageSource;
}

export interface RecordingTarget {
  /** The canvas the game screen lives on. */
  readonly canvas: HTMLCanvasElement;
  /** The pointer for the NEXT frame, or `null` when it is outside the window. */
  readonly cursor?: () => RecordingCursor | null;
}

/** What a finished recording turned into. */
export interface RecordingResult {
  readonly fileName: string;
  /** Set when the browser could not stream into a file and the data came back in memory. */
  readonly blob: Blob | null;
  readonly bytes: number;
  readonly frames: number;
}

interface Sink {
  write(chunk: Blob): Promise<void>;
  close(): Promise<RecordingResult>;
}

interface FsWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FsSaveHandle {
  readonly name: string;
  createWritable(): Promise<FsWritable>;
}

/**
 * File name of a recording. Sortable, and it says what it is without being opened.
 *
 * The still picture uses the same builder with `png`: two name builders would be two truths, and a
 * video and the picture taken next to it should sort together.
 */
export function recordingFileName(now: Date, ext = 'webm'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `webserf-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`
  );
}

/**
 * The canvas as a PNG.
 *
 * `toBlob` rather than `toDataURL`: at a large window the data URI is a base64 string of several
 * megabytes that a preview would then hold for as long as it is shown. `null` instead of throwing
 * when the context is gone — a missing picture is better than a broken screen.
 */
export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** The first container this browser can actually produce, or `null` if it can record nothing. */
export function pickMimeType(
  supported: (t: string) => boolean = (t) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
): string | null {
  for (const t of MIME_CANDIDATES) if (supported(t)) return t;
  return null;
}

/** Writes into a file the user picked. Nothing is kept in memory. */
async function fileSink(fileName: string): Promise<Sink | null> {
  const pick = (globalThis as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<FsSaveHandle>;
  }).showSaveFilePicker;
  if (pick === undefined) return null;
  let handle: FsSaveHandle;
  try {
    handle = await pick({
      suggestedName: fileName,
      types: [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
    });
  } catch {
    // Cancelled in the picker — not an error, but there is nothing to record into.
    return null;
  }
  const writable = await handle.createWritable();
  let bytes = 0;
  // The writes have to be serialised: `ondataavailable` fires again while the previous write is
  // still running, and two overlapping writes into one stream interleave.
  let queue: Promise<void> = Promise.resolve();
  return {
    write(chunk) {
      bytes += chunk.size;
      queue = queue.then(() => writable.write(chunk));
      return queue;
    },
    async close() {
      await queue;
      await writable.close();
      return { fileName: handle.name, blob: null, bytes, frames: 0 };
    },
  };
}

/** Fallback: collect and hand over at the end. */
function memorySink(fileName: string, mimeType: string): Sink {
  const chunks: Blob[] = [];
  let bytes = 0;
  return {
    async write(chunk) {
      chunks.push(chunk);
      bytes += chunk.size;
    },
    async close() {
      return { fileName, blob: new Blob(chunks, { type: mimeType }), bytes, frames: 0 };
    },
  };
}

/**
 * One image for the recording: the finished game picture, the pointer on top.
 *
 * A function of its own because it is the one piece here that can go visibly wrong and is not
 * reachable from a browser test. Two things it must do and a test can hold it to: the pointer goes
 * on top of the picture, not under it, and **the visible canvas is only ever read, never written**.
 *
 * The black fill runs only when the source does not cover the target: the recording keeps the size
 * it started with, so a window shrunk mid-recording would otherwise leave the previous image
 * standing around the edge.
 */
export function composeRecordingFrame(
  dest: CanvasRenderingContext2D,
  destWidth: number,
  destHeight: number,
  source: HTMLCanvasElement,
  cursor: RecordingCursor | null,
): void {
  if (source.width < destWidth || source.height < destHeight) {
    dest.fillStyle = '#000';
    dest.fillRect(0, 0, destWidth, destHeight);
  }
  dest.drawImage(source, 0, 0);
  if (cursor !== null) dest.drawImage(cursor.image, cursor.x, cursor.y);
}

export class ScreenRecorder {
  #recorder: MediaRecorder | null = null;
  #track: CanvasCaptureMediaStreamTrack | null = null;
  #sink: Sink | null = null;
  #target: RecordingTarget | null = null;
  /** The canvas the stream hangs off — never in the DOM, see the module header. */
  #dest: HTMLCanvasElement | null = null;
  #destCtx: CanvasRenderingContext2D | null = null;
  #frames = 0;

  get recording(): boolean {
    return this.#recorder !== null;
  }

  get frames(): number {
    return this.#frames;
  }

  /**
   * Starts recording. MUST be called from a user gesture — the file picker needs one.
   * `false` = the user cancelled the picker or this browser cannot record.
   */
  async start(target: RecordingTarget, fileName: string): Promise<boolean> {
    if (this.#recorder !== null) return false;
    const mimeType = pickMimeType();
    if (mimeType === null) return false;
    const source = target.canvas as HTMLCanvasElement | undefined;
    if (source === undefined || source.width === 0 || source.height === 0) return false;
    // The size is fixed here and stays: a video whose resolution changes mid-stream is a special
    // case for players. A window enlarged during the recording is cropped, a shrunk one gets a black
    // edge (see `composeRecordingFrame`).
    const dest = document.createElement('canvas');
    dest.width = source.width;
    dest.height = source.height;
    const destCtx = dest.getContext('2d');
    if (destCtx === null) return false;
    destCtx.imageSmoothingEnabled = false;
    const stream = dest.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    if (track === undefined) return false;
    const sink = (await fileSink(fileName)) ?? memorySink(fileName, mimeType);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) void sink.write(e.data);
    };
    this.#recorder = recorder;
    this.#track = track;
    this.#sink = sink;
    this.#target = target;
    this.#dest = dest;
    this.#destCtx = destCtx;
    this.#frames = 0;
    recorder.start(CHUNK_MS);
    return true;
  }

  /**
   * Hands one finished image to the stream. Called at the END of the drawing pass — the canvas holds
   * exactly what the player is about to see.
   */
  capture(): void {
    const track = this.#track;
    const target = this.#target;
    const dest = this.#dest;
    const destCtx = this.#destCtx;
    if (track === null || target === null || dest === null || destCtx === null) return;
    this.#frames += 1;
    composeRecordingFrame(
      destCtx,
      dest.width,
      dest.height,
      target.canvas,
      target.cursor?.() ?? null,
    );
    track.requestFrame();
  }

  /** Ends the recording and closes the file. */
  async stop(): Promise<RecordingResult | null> {
    const recorder = this.#recorder;
    const sink = this.#sink;
    if (recorder === null || sink === null) return null;
    const frames = this.#frames;
    this.#recorder = null;
    this.#track = null;
    this.#sink = null;
    this.#target = null;
    this.#dest = null;
    this.#destCtx = null;
    this.#frames = 0;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    const result = await sink.close();
    return { ...result, frames };
  }
}
