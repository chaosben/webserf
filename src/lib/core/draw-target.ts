/**
 * Minimal blit backend, so the drawing passes can live **backend free** in `core/`.
 *
 * Road, entity and fallback passes live here and not in the Svelte component so that a verification
 * script calls **the same code** the browser runs. A script that reimplements the calculation only
 * ever checks its own reimplementation: it carries whatever defect the component carries and cannot
 * show it.
 *
 * Two implementations:
 * - browser: a canvas blitter over `HTMLCanvasElement` + `drawImage`.
 * - node: RGBA buffers directly (`DecodedSprite` already satisfies {@link DrawImage}).
 *
 * The interface stays deliberately small. Everything that computes — order, anchors, sprite choice —
 * sits in the passes, not in the backend; a WebGL backend would again be just a third implementation
 * of these methods.
 */

/** An image in the backend. The core knows only its dimensions. */
export interface DrawImage {
  readonly width: number;
  readonly height: number;
}

/**
 * A sprite: image plus the archive's pivot convention. `offsetX/Y` is the offset to the drawing anchor
 * (`SpriteHeader.offset_x/y`), `deltaX/Y` the attachment offset for parts stuck on top (a serf's head
 * on the torso).
 */
export interface KitSprite<Img extends DrawImage> {
  readonly image: Img;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface Blitter<Img extends DrawImage> {
  blit(image: Img, x: number, y: number): void;
  /**
   * Only the **lower** `fraction` (0..1) of the image, in place. The original draws buildings under
   * construction this way: the image grows out of the ground from below.
   */
  blitPartial(image: Img, x: number, y: number, fraction: number): void;
  /**
   * Write only where the **target pixel** already carries the index `overIndex` — the rest of the
   * sprite is discarded.
   *
   * Not a convenience but a third blit **primitive** of the original: the water waves run through
   * `0x600` -> worker `0x646e4`, whose inner loop holds the target byte
   * vergleicht, bevor sie kopiert (`mov $0x8,%edx ; cmp %dl,(%edi) ; je …movsb`, an beiden
   * write sites @0x648bc and @0x64903). The mask is thus provided by the **ground itself**: the water
   * texture is an area of index 8, so the waves appear exactly on water and nowhere else — in
   * particular not on the grass triangle of a shore tile and not on a boat already standing there. An
   * unconditional blit paints over those.
   *
   * Like the shadow (`dst |= 0x80`) this is an **operation on the target**, not an image — it can only
   * be reproduced on a palette-indexed surface (see `index-target.ts`).
   */
  blitOverIndex(image: Img, x: number, y: number, overIndex: number): void;
}

/**
 * Draws a sprite at the anchor `(bx,by)` — the only place that applies the pivot convention.
 * `progress < 1` draws only the lower piece (construction progress).
 */
export function blitSprite<Img extends DrawImage>(
  target: Blitter<Img>,
  sprite: KitSprite<Img> | null,
  bx: number,
  by: number,
  progress = 1,
): void {
  if (sprite === null) return;
  const x = Math.round(bx + sprite.offsetX);
  const y = Math.round(by + sprite.offsetY);
  if (progress >= 1) target.blit(sprite.image, x, y);
  else target.blitPartial(sprite.image, x, y, progress);
}

/**
 * Draws a sprite at the anchor `(bx,by)`, but only over target pixels with index `overIndex` (see
 * {@link Blitter.blitOverIndex}). The pivot applies as in an ordinary blit — the worker adds it
 * (`add 0x6(%esi),%bx` @0x646ea).
 */
export function blitSpriteOverIndex<Img extends DrawImage>(
  target: Blitter<Img>,
  sprite: KitSprite<Img> | null,
  bx: number,
  by: number,
  overIndex: number,
): void {
  if (sprite === null) return;
  target.blitOverIndex(
    sprite.image,
    Math.round(bx + sprite.offsetX),
    Math.round(by + sprite.offsetY),
    overIndex,
  );
}
