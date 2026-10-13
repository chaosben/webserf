/**
 * **Sharp bilinear**: enlarging pixel art by a factor that is not a whole number.
 *
 * Nearest-neighbour at a fractional factor makes source pixels alternately one and two device pixels
 * wide — visible as uneven lines and as shimmer while the map scrolls. Smoothing the whole way blurs
 * every pixel. The middle road: enlarge by the integer part with nearest-neighbour, then filter only
 * the remaining factor below 2. The filter then blends across nothing but the one-pixel seam between
 * two enlarged pixels.
 *
 * An integer factor keeps the plain nearest path, byte for byte — that is the path all pixel-exact
 * checks against the original measure.
 *
 * **Below 2 there is no filtering at all.** Without an integer pre-step the filtered remainder blends
 * EVERY pixel with its neighbour, not just a seam — and that is what turns zoomed-out pixel art (where
 * the remaining factor is the screen's 1.25 or 1.5) to mush and takes the game's look with it. Uneven
 * pixel widths at those factors are the lesser evil.
 */

/** The two steps for one scale (device pixels per source pixel). */
export interface SharpSteps {
  /** Integer pre-enlargement, nearest-neighbour. 1 = none. */
  readonly n: number;
  /** Whether the remaining step is filtered. `false` = the exact nearest path. */
  readonly smooth: boolean;
}

/** Tolerance for "integer": a zoom of 2 arrives as 1.9999999 after a few wheel steps. */
const INTEGER_EPS = 1e-6;

/** Below this, nearest-neighbour throughout — see the module header. */
const MIN_FILTERED_SCALE = 2;

export function sharpSteps(scale: number): SharpSteps {
  if (!(scale >= MIN_FILTERED_SCALE)) return { n: 1, smooth: false };
  if (Math.abs(scale - Math.round(scale)) < INTEGER_EPS) return { n: 1, smooth: false };
  return { n: Math.max(1, Math.floor(scale)), smooth: true };
}

/**
 * The last step onto the visible canvas: the whole source to the destination rectangle. Smoothing is
 * switched on only for this one call and back off afterwards — everything drawn after it (markers,
 * the next overlay part) relies on it being off.
 */
export function blitScaled(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  smooth: boolean,
): void {
  if (!smooth) {
    ctx.drawImage(source, dx, dy, dw, dh);
    return;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(source, dx, dy, dw, dh);
  ctx.imageSmoothingEnabled = false;
}
