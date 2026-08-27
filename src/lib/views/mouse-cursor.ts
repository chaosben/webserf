/**
 * The original mouse pointer as a CSS cursor.
 *
 * Drawn via CSS instead of into the framebuffer because in a browser the system moves the pointer:
 * a self-drawn cursor would lag the real one by one frame.
 */
import type { DecodedSprite } from '../core/types.js';
import { spriteCanvas } from './sprite-image.js';

/** Registry slot `Cursor` (archive index 3999), 0-based. */
export const CURSOR_SPRITE_INDEX = 3998;

/** The hotspot is not the corner but the point at the centre of the sprite. */
export const CURSOR_HOTSPOT = { x: 8, y: 8 } as const;

/** Browsers reject cursor images larger than 128×128; the sprite is 16×16. */
export const CURSOR_MAX_SCALE = 8;

/** The whole-number scale actually used — a cursor image is scaled hard by the system. */
export const cursorScaleOf = (scale: number): number =>
  Math.max(1, Math.min(CURSOR_MAX_SCALE, Math.floor(scale)));

/**
 * The pointer sprite as a drawable canvas, scaled by whole steps without smoothing.
 *
 * Two consumers: the CSS cursor below, and the screen recording, which draws the pointer into the
 * captured frame because a CSS cursor is not part of the canvas. `null` when there is no 2D context.
 */
export function buildCursorCanvas(sprite: DecodedSprite, scale = 1): HTMLCanvasElement | null {
  return spriteCanvas(sprite, cursorScaleOf(scale));
}

/**
 * The CSS cursor for a pointer canvas that already exists.
 *
 * Separate from {@link buildCursorStyle} because the recording needs the canvas itself: building it
 * once and turning it into a style from there saves the second, identical build per scale step.
 */
export function cursorStyleFrom(canvas: HTMLCanvasElement, scale = 1): string {
  const s = cursorScaleOf(scale);
  const hx = CURSOR_HOTSPOT.x * s;
  const hy = CURSOR_HOTSPOT.y * s;
  // `crosshair` as a fallback in case the browser rejects the data URI (CSP or similar).
  return `url(${canvas.toDataURL('image/png')}) ${hx} ${hy}, crosshair`;
}

/** `null` when there is no 2D context — the browser cursor then stays as it is. */
export function buildCursorStyle(sprite: DecodedSprite, scale = 1): string | null {
  const canvas = buildCursorCanvas(sprite, scale);
  return canvas === null ? null : cursorStyleFrom(canvas, scale);
}
