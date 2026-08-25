/**
 * Brings the palette-indexed map surface (see `core/index-target.ts`) onto a canvas. Here - and only
 * here - indices become colour.
 *
 * There are two routes. The CPU route converts to RGBA and uploads via `putImageData`; both steps are
 * memory-bandwidth bound and were already exhausted on the CPU by the u32 store. The GPU route turns
 * that into one draw call: the surface goes up as an `R8UI` texture (a quarter of the bytes), the
 * palette as a 256x1 `RGBA8` texture, and a fragment shader looks up per pixel - exactly the operation
 * the original had in hardware, a DAC behind a byte framebuffer. WebGL is used here and nowhere else,
 * because this is the one place where measurement forced it.
 *
 * Pixel identity rests on `texelFetch` for both textures (no filtering, no normalisation, the index
 * arrives as an integer), on alpha being a constant 1 rather than taken from the palette, and on a
 * context without alpha or antialiasing.
 *
 * That still leaves things outside the source: colour-space conversion when a WebGL canvas is drawn
 * into a 2D canvas, driver quirks, `precision` interpretation. So THE ROUTE PROVES ITSELF WHEN
 * CREATED - it draws a 16x16 probe containing all 256 indices exactly once, reads it back and compares
 * byte for byte against the CPU route. One differing pixel and the GPU route stays off permanently, so
 * a driver surprise leads to "correct but slower" rather than to a wrong image.
 *
 * The three measurement points keep their names but measure something else on the GPU route:
 * `putImageData` is the texture upload, `palette -> colour` is only the enqueueing of the draw call,
 * and the actual waiting lands in `drawImage`, because that is what needs the finished surface. The
 * report therefore names the route in use.
 *
 * What is NOT proven here: whether `ctx.drawImage(webglCanvas, ...)` stays on the GPU or makes a round
 * trip through main memory is a browser question. That is what the `drawImage` phase measures; if it
 * rises by more than the saving elsewhere, the next step would be a second, stacked canvas that WebGL
 * draws into directly - not possible today, because the same canvas carries the 2D zoom, the fallback
 * colour triangles and the markers.
 */

import { createIndexSurface, indexSurfaceToRgba, type IndexSurface } from '../core/index-target.js';
import type { Palette } from '../core/types.js';
import { log } from '../shell/log.js';
import { metrics } from './render-metrics.js';

/**
 * Probe image of the self-test: 16x16 pixels, EVERY palette index exactly once. It cannot be smaller
 * without leaving indices unchecked — and a self-test that only looks at a few colours would let
 * through exactly the case it is about (a palette that arrives wrong in places).
 */
export function gpuProbeSurface(): IndexSurface {
  const s = createIndexSurface(16, 16);
  for (let i = 0; i < 256; i++) s.data[i] = i;
  return s;
}

/**
 * Holds a `readPixels` result against the CPU route.
 *
 * `readPixels` counts rows from the BOTTOM, the surface from the top — so the flip belongs in the
 * comparison, and it is the reason the self-test needs an image with distinguishable rows: an
 * upside-down result has to fail.
 *
 * Compared is RGB. The alpha of the drawing buffer says nothing about what ends up on the 2D canvas
 * (`alpha: false` makes the source opaque), while a driver reporting 0 instead of 255 there would
 * otherwise rule the route out for no reason.
 */
export function readbackMatchesCpu(
  readback: Uint8Array,
  surface: IndexSurface,
  palette: Palette,
): boolean {
  const { width: w, height: h } = surface;
  if (readback.length !== w * h * 4) return false;
  const want = indexSurfaceToRgba(surface, palette);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4; // row in the returned buffer (bottom-up)
    const dst = y * w * 4; // row in the surface (top-down)
    for (let x = 0; x < w * 4; x += 4) {
      if (readback[src + x] !== want[dst + x]) return false;
      if (readback[src + x + 1] !== want[dst + x + 1]) return false;
      if (readback[src + x + 2] !== want[dst + x + 2]) return false;
    }
  }
  return true;
}

const VERTEX_SRC = `#version 300 es
void main() {
  // One triangle covering the whole screen — no buffer, no attributes.
  // 0 -> (-1,-1), 1 -> (3,-1), 2 -> (-1,3).
  vec2 p = vec2(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID >> 1) * 4 - 1));
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
// Precision on EVERY declaration: integer samplers have no default in GLSL ES 3.0, and a precision
// statement for sampler types is a place where compilers differ.
precision highp float;
uniform highp usampler2D uIndex;
uniform highp sampler2D uPalette;
uniform highp int uHeight;
out vec4 fragColor;
void main() {
  // gl_FragCoord counts from the bottom, the surface from the top.
  ivec2 p = ivec2(int(gl_FragCoord.x), uHeight - 1 - int(gl_FragCoord.y));
  uint idx = texelFetch(uIndex, p, 0).r;
  // Alpha does NOT come from the palette: the CPU route writes a constant 0xff.
  fragColor = vec4(texelFetch(uPalette, ivec2(int(idx), 0), 0).rgb, 1.0);
}`;

/** The GPU route. Only built through {@link GpuPath.create}, which proves itself. */
class GpuPath {
  private constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly indexTex: WebGLTexture,
    private readonly paletteTex: WebGLTexture,
    private readonly heightLoc: WebGLUniformLocation,
    private readonly maxTexture: number,
  ) {}

  /** Size of the index texture currently allocated (0 = none yet). */
  private w = 0;
  private h = 0;
  /** Palette uploaded last — compared by identity, not by value (it is immutable). */
  private uploaded: Palette | null = null;
  /**
   * Context lost (driver reset, memory pressure, GPU switch). Restoring would be effort for a case
   * that costs nothing: the CPU route produces the same image. Without handling it the map drew
   * BLACK after a reset, and without any error message.
   */
  private lost = false;

  static create(palette: Palette): GpuPath | null {
    let canvas: HTMLCanvasElement;
    try {
      canvas = document.createElement('canvas');
    } catch {
      return null;
    }
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (gl === null) {
      log.info('render', 'no WebGL2 — palette conversion stays on the CPU');
      return null;
    }

    const program = buildProgram(gl);
    if (program === null) return null;
    const indexTex = gl.createTexture();
    const paletteTex = gl.createTexture();
    const heightLoc = gl.getUniformLocation(program, 'uHeight');
    if (indexTex === null || paletteTex === null || heightLoc === null) return null;

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uIndex'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uPalette'), 1);
    // Rows of the index texture are byte-aligned — without this the GPU reads the second row
    // offset for an odd width.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    for (const [unit, tex] of [
      [0, indexTex],
      [1, paletteTex],
    ] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    const path = new GpuPath(
      canvas,
      gl,
      indexTex,
      paletteTex,
      heightLoc,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    );

    canvas.addEventListener('webglcontextlost', () => {
      path.lost = true;
      log.warn('render', 'WebGL context lost — palette conversion falls back to the CPU');
    });

    // The self-test. It runs with the REAL palette, because those exact bytes have to arrive.
    const probe = gpuProbeSurface();
    if (!path.draw(probe, palette, false)) return null;
    const back = new Uint8Array(probe.width * probe.height * 4);
    gl.readPixels(0, 0, probe.width, probe.height, gl.RGBA, gl.UNSIGNED_BYTE, back);
    if (!readbackMatchesCpu(back, probe, palette)) {
      log.warn('render', 'WebGL2 does not produce the same pixels as the CPU — staying on the CPU');
      return null;
    }
    log.info('render', 'palette conversion runs on the GPU (self-test passed)');
    return path;
  }

  /**
   * Draws the surface into its own canvas. `false` means "not drawn" — the caller then has to take
   * the CPU route. That happens in two cases: a lost context, or a surface beyond
   * `MAX_TEXTURE_SIZE`.
   *
   * Tiling for that would be work without a case: the surface is at most window-sized
   * (`surfaceScale = min(1, zoom)`, see `map-frame-render.ts`), and desktop drivers report 16384.
   * Only the lower bound of 2048 guaranteed by the standard sits below a 4K window — and there the
   * CPU simply draws it, correctly and more slowly.
   */
  draw(surface: IndexSurface, palette: Palette, measure = true): boolean {
    const { gl } = this;
    const { width: w, height: h } = surface;
    if (this.lost || w > this.maxTexture || h > this.maxTexture) return false;

    if (measure) metrics.begin('upload');
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    if (this.uploaded !== palette) {
      this.uploaded = palette;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palette.rgba);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    if (this.w !== w || this.h !== h) {
      this.w = w;
      this.h = h;
      this.canvas.width = w;
      this.canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform1i(this.heightLoc, h);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, surface.data);
    if (measure) metrics.end('upload');

    if (measure) metrics.begin('rgba');
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (measure) metrics.end('rgba');
    return true;
  }
}

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const compile = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type);
    if (s === null) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (gl.getShaderParameter(s, gl.COMPILE_STATUS) === true) return s;
    log.warn('render', `shader failed to compile: ${gl.getShaderInfoLog(s) ?? '?'}`);
    return null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  const program = gl.createProgram();
  if (vs === null || fs === null || program === null) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    log.warn('render', `shader program failed to link: ${gl.getProgramInfoLog(program) ?? '?'}`);
    return null;
  }
  // In WebGL2 a draw call needs a bound VAO, even without attributes.
  gl.bindVertexArray(gl.createVertexArray());
  return program;
}

export class IndexPresenter {
  #canvas: HTMLCanvasElement | null = null;
  #ctx: CanvasRenderingContext2D | null = null;
  #image: ImageData | null = null;
  #surface: IndexSurface | null = null;
  #gpu: GpuPath | null = null;
  /** The GPU route is attempted ONCE; a failure is final. */
  #gpuTried = false;

  /**
   * Reused while the size stays the same — otherwise a window-sized buffer would be allocated per
   * frame. It is cleared regardless: the fallback path and the borders do not cover everything.
   */
  surfaceFor(width: number, height: number): IndexSurface {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    if (this.#surface === null || this.#surface.width !== w || this.#surface.height !== h) {
      this.#surface = createIndexSurface(w, h);
    } else {
      this.#surface.data.fill(0);
    }
    return this.#surface;
  }

  /** Draws at `(0,0)`; zoom and pan have been set by the caller as a transform. */
  present(ctx: CanvasRenderingContext2D, surface: IndexSurface, palette: Palette): void {
    const { width, height } = surface;
    if (width <= 0 || height <= 0) return;

    if (!this.#gpuTried) {
      this.#gpuTried = true;
      this.#gpu = GpuPath.create(palette);
    }
    if (this.#gpu !== null && this.#gpu.draw(surface, palette)) {
      metrics.notePresenter('gpu');
      // Within the same task the drawing buffer is still valid (it is only cleared before the next
      // compositing step) — so `drawImage` sees the finished image without `preserveDrawingBuffer`.
      metrics.begin('scale');
      ctx.drawImage(this.#gpu.canvas, 0, 0);
      metrics.end('scale');
      return;
    }
    metrics.notePresenter('cpu');

    if (this.#canvas === null || this.#canvas.width !== width || this.#canvas.height !== height) {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      this.#canvas = c;
      this.#ctx = c.getContext('2d');
      if (this.#ctx !== null) this.#ctx.imageSmoothingEnabled = false;
      this.#image = this.#ctx?.createImageData(width, height) ?? null;
    }
    const own = this.#ctx;
    const image = this.#image;
    if (own === null || image === null || this.#canvas === null) return;

    // Three items, three measurement points — and these are exactly the three an offline profile
    // cannot see: the conversion runs there too, `putImageData` and the scaling `drawImage` do not.
    metrics.begin('rgba');
    indexSurfaceToRgba(surface, palette, image.data as unknown as Uint8ClampedArray);
    metrics.end('rgba');
    metrics.begin('upload');
    own.putImageData(image, 0, 0);
    metrics.end('upload');
    metrics.begin('scale');
    ctx.drawImage(this.#canvas, 0, 0);
    metrics.end('scale');
  }
}
