import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '../core/ui-render.js';
import { composeUiOverlay, resetUiOverlayScratch, type OverlayLayer } from './ui-overlay.js';

/**
 * There is no canvas in node, so both ends are recorded: what the scratch canvases were asked to do
 * and what was drawn onto the destination.
 */
interface Recorder {
  readonly scratches: { w: number; h: number; puts: number }[];
  readonly draws: { from: { w: number; h: number }; args: number[] }[];
}

let rec: Recorder;
let realDocument: unknown;

function fakeScratchCanvas(): HTMLCanvasElement {
  const self = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const entry = { get w() { return self.width; }, get h() { return self.height; }, puts: 0 };
  rec.scratches.push(entry as unknown as Recorder['scratches'][number]);
  (self as unknown as { getContext: () => unknown }).getContext = () => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {
      entry.puts += 1;
    },
  });
  return self;
}

function destination(): CanvasRenderingContext2D {
  return {
    imageSmoothingEnabled: true,
    drawImage: (src: HTMLCanvasElement, ...args: number[]) => {
      rec.draws.push({ from: { w: src.width, h: src.height }, args });
    },
  } as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  rec = { scratches: [], draws: [] };
  realDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { createElement: () => fakeScratchCanvas() };
  resetUiOverlayScratch();
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
  resetUiOverlayScratch();
});

const layer = (w: number, h: number, x: number, y: number, sx: number): OverlayLayer => ({
  fb: createFramebuffer(w, h),
  rect: { x, y, w: w * sx, h: h * sx },
});

describe('composeUiOverlay', () => {
  it('draws the parts in the given order, each at its own rectangle', () => {
    const popup = layer(144, 160, 500, 200, 2);
    const bar = layer(352, 40, 300, 700, 2);
    composeUiOverlay(destination(), [popup, bar]);
    expect(rec.draws).toHaveLength(2);
    // Popup first, bar second — the later one ends up on top.
    expect(rec.draws[0].from).toEqual({ w: 144, h: 160 });
    expect(rec.draws[1].from).toEqual({ w: 352, h: 40 });
    // Full source rectangle to the destination rectangle, nothing cropped or shifted.
    expect(rec.draws[0].args).toEqual([0, 0, 144, 160, 500, 200, 288, 320]);
    expect(rec.draws[1].args).toEqual([0, 0, 352, 40, 300, 700, 704, 80]);
  });

  it('turns smoothing off — the parts are pixel art and are scaled by whole factors', () => {
    const ctx = destination();
    composeUiOverlay(ctx, [layer(144, 160, 0, 0, 3)]);
    expect(ctx.imageSmoothingEnabled).toBe(false);
  });

  it('keeps one scratch canvas per size, not one per call', () => {
    const a = layer(144, 160, 0, 0, 1);
    const b = layer(144, 160, 0, 0, 2);
    composeUiOverlay(destination(), [a]);
    composeUiOverlay(destination(), [b]);
    expect(rec.scratches).toHaveLength(1);
    expect(rec.scratches[0]).toMatchObject({ w: 144, h: 160 });
  });

  it('uploads a surface again only when it has actually changed', () => {
    const same = layer(144, 160, 0, 0, 1);
    composeUiOverlay(destination(), [same]);
    composeUiOverlay(destination(), [same]);
    expect(rec.scratches[0].puts).toBe(1);
    composeUiOverlay(destination(), [layer(144, 160, 0, 0, 1)]);
    expect(rec.scratches[0].puts).toBe(2);
  });

  it('skips a part that has no area — and touches nothing for an empty list', () => {
    const ctx = destination();
    composeUiOverlay(ctx, [{ fb: createFramebuffer(144, 160), rect: { x: 0, y: 0, w: 0, h: 0 } }]);
    expect(rec.draws).toHaveLength(0);
    // A fresh destination: an empty list must not even touch the drawing state.
    const untouched = destination();
    composeUiOverlay(untouched, []);
    expect(untouched.imageSmoothingEnabled).toBe(true);
  });
});
