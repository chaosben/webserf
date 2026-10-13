import { describe, expect, it } from 'vitest';
import {
  canvasPng,
  composeRecordingFrame,
  extensionOf,
  pickMimeType,
  recordingBitrate,
  recordingFileName,
  recordingScale,
  withExtension,
  type RecordingCursor,
} from './screen-recorder.js';

describe('recordingFileName', () => {
  it('is sortable and says what it is', () => {
    expect(recordingFileName(new Date(2026, 7, 25, 9, 4, 3))).toBe('webserf-20260825-090403.webm');
  });

  it('gives a still picture the same name with its own extension', () => {
    // Same builder on purpose: a video and the picture taken beside it sort together.
    expect(recordingFileName(new Date(2026, 7, 25, 9, 4, 3), 'png')).toBe(
      'webserf-20260825-090403.png',
    );
  });
});

describe('canvasPng', () => {
  it('hands the picture through', async () => {
    const blob = new Blob(['x']);
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void, type: string) => {
        expect(type).toBe('image/png');
        cb(blob);
      },
    } as unknown as HTMLCanvasElement;
    expect(await canvasPng(canvas)).toBe(blob);
  });

  it('yields nothing rather than throwing when the canvas gives none', async () => {
    // Both ways a lost context shows up: the callback with `null`, or an exception.
    const empty = { toBlob: (cb: (b: Blob | null) => void) => cb(null) } as unknown as HTMLCanvasElement;
    expect(await canvasPng(empty)).toBeNull();
    const broken = {
      toBlob: () => {
        throw new Error('context lost');
      },
    } as unknown as HTMLCanvasElement;
    expect(await canvasPng(broken)).toBeNull();
  });
});

describe('pickMimeType', () => {
  it('takes the cheapest container the browser can actually produce', () => {
    // VP8 FIRST on purpose — it is the cheaper encode, and the recording must not slow down the
    // game it records (see the candidate list).
    expect(pickMimeType(() => true)).toBe('video/webm;codecs=vp8');
    expect(pickMimeType((t) => !t.includes('vp8'))).toBe('video/webm;codecs=vp9');
    // Safari: no WebM at all.
    expect(pickMimeType((t) => t === 'video/mp4')).toBe('video/mp4');
  });

  it('says so when the browser can record nothing', () => {
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe('composeRecordingFrame', () => {
  /** Records everything that touches a canvas, on either side. */
  function harness(sourceWidth = 200, sourceHeight = 100) {
    const order: string[] = [];
    const dest = {
      set fillStyle(v: string) {
        order.push(`fillStyle ${v}`);
      },
      fillRect: (x: number, y: number, w: number, h: number) => order.push(`fill ${x},${y},${w},${h}`),
      drawImage: (img: { tag?: string }, x: number, y: number, w: number, h: number) =>
        order.push(`draw ${img.tag ?? '?'} ${x},${y} ${w}x${h}`),
    } as unknown as CanvasRenderingContext2D;
    const source = {
      tag: 'screen',
      width: sourceWidth,
      height: sourceHeight,
      getContext: () => {
        order.push('source getContext');
        return null;
      },
      getImageData: () => order.push('source getImageData'),
    } as unknown as HTMLCanvasElement;
    const cursor: RecordingCursor = { x: 10, y: 20, w: 16, h: 24, image: { tag: 'pointer' } as never };
    return { order, dest, source, cursor };
  }

  it('puts the pointer ON the finished picture', () => {
    // The other order hides the pointer under the map.
    const h = harness();
    composeRecordingFrame(h.dest, 200, 100, h.source, h.cursor);
    expect(h.order).toEqual(['draw screen 0,0 200x100', 'draw pointer 10,20 16x24']);
  });

  it('takes the picture alone when the pointer is outside the window', () => {
    const h = harness();
    composeRecordingFrame(h.dest, 200, 100, h.source, null);
    expect(h.order).toEqual(['draw screen 0,0 200x100']);
  });

  it('enlarges picture and pointer by the same whole factor', () => {
    const h = harness();
    composeRecordingFrame(h.dest, 400, 200, h.source, h.cursor, 2);
    expect(h.order).toEqual(['draw screen 0,0 400x200', 'draw pointer 20,40 32x48']);
  });

  it('never touches the visible canvas', () => {
    // The reason the recording has a canvas of its own: reading the game canvas back costs a trip
    // from the graphics card and can cost it its acceleration for good.
    const h = harness();
    composeRecordingFrame(h.dest, 200, 100, h.source, h.cursor);
    expect(h.order.some((step) => step.startsWith('source'))).toBe(false);
  });

  it('blacks out what a shrunk window no longer covers', () => {
    // The recording keeps its starting size, so the previous image would otherwise stand around the
    // edge for the rest of the video.
    const h = harness(120, 60);
    composeRecordingFrame(h.dest, 200, 100, h.source, null);
    expect(h.order).toEqual(['fillStyle #000', 'fill 0,0,200,100', 'draw screen 0,0 120x60']);
  });
});

describe('recordingScale', () => {
  it('leaves the standard recording at the canvas size', () => {
    expect(recordingScale(1600, 900, 1, 'standard')).toBe(1);
  });

  it('gives every game pixel at least 2×2 video pixels in high quality', () => {
    expect(recordingScale(1600, 900, 1, 'high')).toBe(2);
    expect(recordingScale(1600, 900, 1.5, 'high')).toBe(2);
    // Already large enough on the canvas — enlarging would only cost.
    expect(recordingScale(1600, 900, 2, 'high')).toBe(1);
    expect(recordingScale(1600, 900, 2.6, 'high')).toBe(1);
    // A phone with the bar fitted below 1x needs more.
    expect(recordingScale(360, 640, 0.9, 'high')).toBe(3);
  });

  it('gives up the factor rather than going beyond 4K', () => {
    expect(recordingScale(2560, 1440, 1, 'high')).toBe(1);
    expect(recordingScale(1920, 1080, 1, 'high')).toBe(2);
    expect(recordingScale(1921, 1080, 1, 'high')).toBe(1);
  });
});

describe('recordingBitrate', () => {
  it('follows the pixel count from the base window', () => {
    expect(recordingBitrate(1600, 900)).toBe(6_000_000);
    expect(recordingBitrate(3200, 1800)).toBe(24_000_000);
  });

  it('is clamped at both ends', () => {
    expect(recordingBitrate(320, 200)).toBe(2_000_000);
    expect(recordingBitrate(3840, 2160)).toBe(25_000_000);
  });
});

describe('container naming', () => {
  it('names the file after what is in it', () => {
    expect(extensionOf('video/webm;codecs=vp8')).toBe('webm');
    expect(extensionOf('video/mp4')).toBe('mp4');
    expect(withExtension('webserf-20260825-090403.webm', 'mp4')).toBe('webserf-20260825-090403.mp4');
    expect(withExtension('clip', 'webm')).toBe('clip.webm');
  });
});
