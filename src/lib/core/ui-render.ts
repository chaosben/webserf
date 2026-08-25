/**
 * In-game UI renderer (panel / popups) — the original's table-driven drawing engine. It builds every
 * screen from three primitives, reproduced here: sprite blit from an icon bank, a monospaced 8 px
 * bitmap font, and a layout interpreter over tables of `{icon, col, row}` triples.
 *
 * The layouts stay **data** rather than hand-written drawing code, because that is what makes them
 * checkable against the original byte for byte.
 *
 * **Sprite index convention:** the original atlas is 1-based, our archive parser 0-based →
 * `our entry = atlas index − 1`.
 *
 * Works on a plain RGBA framebuffer (DOM-free, hence testable); the Svelte layer copies it onto a
 * canvas.
 */

import type { DecodedSprite } from './types.js';

// --- Sprite banks (0-based archive entry bases; atlas index − 1) ---------------------------------

/** Panel/popup icon bank (small UI icons + background tiles); the original adds `icon + 0x366`. */
export const UI_ICON_BASE = 0x366 - 1; // 869

/** Object bank (building/resource previews shown as panel icons) — same sprite space as map objects. */
export const UI_OBJECT_BASE = 0x4e2 - 1; // 1249

/** First glyph sprite; 44 consecutive 8×8 sprites follow in the order of {@link GLYPH_ORDER}. */
export const FONT_FIRST_GLYPH = 749;

/**
 * Order of the 44 glyphs from {@link FONT_FIRST_GLYPH} on, read off the archive. There is no space
 * glyph — a space and anything unmapped only advance the pen.
 */
export const GLYPH_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789.-:?%';

/** Character → archive entry of its glyph sprite. */
export const GLYPH_ENTRY: ReadonlyMap<string, number> = new Map(
  [...GLYPH_ORDER].map((ch, i) => [ch, FONT_FIRST_GLYPH + i] as const),
);

/** Pen advance of the monospaced font, in pixels. */
export const GLYPH_ADVANCE = 8;

/** The original's default text colour (palette index 31, bright). */
export const DEFAULT_TEXT_COLOR_INDEX = 0x1f;

// --- Panel geometry -----------------------------------------------------------------------------

/** Drawing area of the standard panel. */
export const PANEL_WIDTH = 128;
export const PANEL_HEIGHT = 144;

/** Coordinate convention of the original's icon wrappers; both banks use the same conversion. */
export const panelX = (col: number): number => col * 8 + 8;
export const panelY = (row: number): number => row + 9;

// --- Framebuffer ------------------------------------------------------------------------------

export interface Framebuffer {
  readonly width: number;
  readonly height: number;
  /** RGBA, length = width · height · 4. */
  readonly rgba: Uint8ClampedArray;
}

export function createFramebuffer(width: number, height: number): Framebuffer {
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4) };
}

/** Fills the framebuffer with one opaque colour. */
export function clearFramebuffer(fb: Framebuffer, r: number, g: number, b: number): void {
  const { rgba } = fb;
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
}

/**
 * Alpha-aware sprite blit: source pixels below alpha 128 are skipped, the rest written opaque —
 * the original's masked UI blits. Pixels outside the framebuffer are clipped.
 *
 * With `maskColor` only the silhouette counts and every covered pixel gets that colour — this is
 * how the original tints the font (glyph = mask, colour = text colour).
 *
 * **The archive pivot belongs to the primitive, not to the caller.** The original's blit worker adds
 * it itself before clipping (`add 0x6(%esi),%bx` @0x63fda, `add 0x8(%esi),%cx` @0x63fde).
 *
 * For the UI banks that is without effect, and that is measured rather than assumed: `Font` (0/44),
 * `Icon` (0/318), `PanelButton` (0/25), `Indicator` (0/8) and every frame bank carry no pivot at
 * all. The one exception is `FontShadow` (44/44 with `(-1,-1)`), which needs it.
 */
export function blitSprite(
  fb: Framebuffer,
  sprite: DecodedSprite,
  x: number,
  y: number,
  maskColor?: readonly [number, number, number],
): void {
  const { width: fw, height: fh, rgba } = fb;
  const { width: sw, height: sh, pixels } = sprite;
  x += sprite.offsetX;
  y += sprite.offsetY;
  for (let sy = 0; sy < sh; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= fh) continue;
    for (let sx = 0; sx < sw; sx++) {
      const sp = (sy * sw + sx) * 4;
      if (pixels[sp + 3]! < 128) continue;
      const dx = x + sx;
      if (dx < 0 || dx >= fw) continue;
      const o = (dy * fw + dx) * 4;
      if (maskColor) {
        rgba[o] = maskColor[0];
        rgba[o + 1] = maskColor[1];
        rgba[o + 2] = maskColor[2];
      } else {
        rgba[o] = pixels[sp]!;
        rgba[o + 1] = pixels[sp + 1]!;
        rgba[o + 2] = pixels[sp + 2]!;
      }
      rgba[o + 3] = 255;
    }
  }
}

/**
 * **Blit WITHOUT pivot** — the original's second primitive, `0x790`. Suppressing the pivot is its
 * whole purpose: it calls the same worker as the map-object blit (`call 0x638fc` @0x805) but zeroes
 * `offset_x`/`offset_y` in the sprite header first (@0x7f4/@0x7ff) and restores them afterwards
 * (@0x80d/@0x811).
 *
 * It is needed for the **object bank** ({@link UI_OBJECT_BASE}): building, flag and map-object
 * graphics carry pivots down to (−32, −55) because on the map they sit around their footpoint. In a
 * popup that does not hold — there the graphic belongs at its layout position.
 *
 * Which bank uses which primitive was surveyed, not inferred: exactly three sites add the object
 * bank (`addw $0x4e2,0x8(%edi)`) — @0x345f3 → `call 0x4c0` (map object, pivot applies), @0x34637 →
 * `call 0x790` (this one, the UI) and @0x36a6a → `call 0x530` (the partial construction-site blit).
 * The icon bank has its own two sites, both → `call 0x290`, which adds the pivot — and there it is
 * always 0.
 */
export function blitSpriteNoPivot(
  fb: Framebuffer,
  sprite: DecodedSprite,
  x: number,
  y: number,
  maskColor?: readonly [number, number, number],
): void {
  blitSprite(fb, { ...sprite, offsetX: 0, offsetY: 0 }, x, y, maskColor);
}

/** Decoded sprite for an archive entry, or `null` for an empty/invalid slot. */
export type SpriteProvider = (entry: number) => DecodedSprite | null;

// --- Font ---------------------------------------------------------------------------------------

/**
 * Draws a string with the monospaced 8 px font at `(x, y)`. Each character advances by
 * {@link GLYPH_ADVANCE}; spaces and unmapped characters only advance. The glyph sprite is a **mask**
 * filled with `color` — that is how the original tints text.
 *
 * In the original the colour is **not** an argument: the text wrapper `0x37c78` — the only entry the
 * game popups use — sets it itself and leaves the caller only column, row and pointer.
 *
 * ```asm
 * 37cb9: shlw $0x3,(%edi)                     ; x = col·8
 * 37cbd: addw $0x8,(%edi)                     ; + 8 == panelX
 * 37cc1: addw $0x9,0x4(%edi)                  ; y = row + 9 == panelY
 * 37cc6: mov $0x1f,%eax ; mov %eax,0x10(%edi) ; foreground == DEFAULT_TEXT_COLOR_INDEX
 * 37cce: mov $0x0,%eax  ; mov %eax,0x14(%edi) ; shadow OFF (the menu wrappers set 1)
 * ```
 *
 * `color` is **mandatory on purpose**. The glyph sprites carry palette index 0, so their raw RGB is
 * `(0,0,0)`: an omitted colour does not mean "default", it means **black** — and that is exactly how
 * one caller drew black text on dark green for a year while eighteen sibling calls passed a colour.
 * A required parameter puts the compiler in charge of finding such a gap.
 */
export function drawText(
  fb: Framebuffer,
  provider: SpriteProvider,
  text: string,
  x: number,
  y: number,
  color: readonly [number, number, number],
  opaque = false,
): void {
  let cx = x;
  for (const ch of text) {
    // `gs+0x1ca` bit 4 == opaque text. The test `bt $0x4` @0x37d05 sits INSIDE the character loop
    // and before the glyph lookup, so the cell is filled for every position — spaces and unmapped
    // characters included.
    if (opaque) fillRect(fb, cx, y, GLYPH_ADVANCE, GLYPH_ADVANCE, TEXT_OPAQUE_CELL_COLOR);
    const entry = GLYPH_ENTRY.get(ch);
    if (entry !== undefined) {
      const s = provider(entry);
      if (s) blitSprite(fb, s, cx, y, color);
    }
    cx += GLYPH_ADVANCE;
  }
}

/**
 * Cell colour of opaque text: palette **index 0**, which is always black after the DAC upload (four
 * `xor` @0x25af zero the first entry) — the only possible value, not a guess.
 */
export const TEXT_OPAQUE_CELL_COLOR: readonly [number, number, number] = [0, 0, 0];

/** Text in panel coordinates (col/row); the conversion lives in {@link panelX} / {@link panelY}. */
export function drawPanelText(
  fb: Framebuffer,
  provider: SpriteProvider,
  text: string,
  col: number,
  row: number,
  color: readonly [number, number, number],
  opaque = false,
): void {
  drawText(fb, provider, text, panelX(col), panelY(row), color, opaque);
}

// --- Layout interpreter -------------------------------------------------------------------------

/** One layout entry: bank-relative icon index at panel position (col, row). */
export interface LayoutItem {
  readonly icon: number;
  readonly col: number;
  readonly row: number;
}

/**
 * **The blit primitive of a bank.** In the original the choice hangs on the bank, not on the caller:
 * the icon bank goes through `call 0x290` (pivot added), the object bank through `call 0x790` (pivot
 * zeroed, see {@link blitSpriteNoPivot}). Both couplings are the only ones of their kind in the
 * binary, so the decision belongs here once instead of in every caller.
 */
export function blitForBank(base: number): typeof blitSprite {
  return base === UI_OBJECT_BASE ? blitSpriteNoPivot : blitSprite;
}

/**
 * **One** icon at a panel position. Screens that draw their icons state-dependently instead of from
 * a layout table (flag/building windows) call exactly this.
 */
export function drawPanelIcon(
  fb: Framebuffer,
  provider: SpriteProvider,
  icon: number,
  col: number,
  row: number,
  base = UI_ICON_BASE,
): void {
  const s = provider(base + icon);
  if (s) blitForBank(base)(fb, s, panelX(col), panelY(row));
}

/** First digit icon: `0x4e` is '0', `0x4e + d` the digit `d`. */
export const UI_DIGIT_ICON_BASE = 0x4e;

/** The three icons the original draws **instead of** a number above 999. */
export const UI_NUMBER_OVERFLOW_ICONS: readonly number[] = [0xd5, 0xd6, 0xd7];

/**
 * **Decimal number as a chain of digit icons** — `draw_popup_number` @0x41de4:
 *
 * ```
 * if (999 < v) { draw 0xd5, 0xd6, 0xd7 ; return }
 * if (v < 100) { digit = 0 ; if (v < 10) goto ones
 *   tens: do { digit++ ; v -= 10 } while (v >= 10) }
 * else { do { digit++ ; v -= 100 } while (v >= 100)
 *   draw digit ; col++ ; digit = 0 ; if (v >= 10) goto tens }
 * draw digit ; col++          // reached from BOTH branches
 * ones: draw v ; col++
 * ```
 *
 * The shared tens draw is why `100` prints as `1`,`0`,`0`: after the hundreds `digit` stays 0, and
 * the jump into the tens loop is skipped only when the remainder is below 10. Smoothing this into
 * `if (v >= 10) …` loses exactly that zero.
 *
 * No leading zeros, one panel column per digit. Returns the number of columns drawn — the original
 * makes its caller compute the follow-up position (e.g. the "%" after a percentage).
 */
export function drawPanelNumber(
  fb: Framebuffer,
  provider: SpriteProvider,
  value: number,
  col: number,
  row: number,
): number {
  let v = value & 0xffff;
  let c = col;
  if (v > 999) {
    for (const icon of UI_NUMBER_OVERFLOW_ICONS) drawPanelIcon(fb, provider, icon, c++, row);
    return c - col;
  }
  let digit = 0;
  let drawTens = true;
  if (v < 100) {
    if (v < 10) {
      drawTens = false; // single digit: straight to the ones
    } else {
      do {
        digit += 1;
        v -= 10;
      } while (v >= 10);
    }
  } else {
    do {
      digit += 1;
      v -= 100;
    } while (v >= 100);
    drawPanelIcon(fb, provider, UI_DIGIT_ICON_BASE + digit, c++, row);
    digit = 0; // stays 0 when the remainder is below 10 — that is the middle 0 of "100"
    if (v >= 10) {
      do {
        digit += 1;
        v -= 10;
      } while (v >= 10);
    }
  }
  if (drawTens) drawPanelIcon(fb, provider, UI_DIGIT_ICON_BASE + digit, c++, row);
  drawPanelIcon(fb, provider, UI_DIGIT_ICON_BASE + v, c++, row);
  return c - col;
}

/**
 * **Five-digit decimal** — the original's *second* number primitive (@0x41bfd), used by the knight
 * menu above 999 where {@link drawPanelNumber} only paints `0xd5 0xd6 0xd7`.
 *
 * A plain cascade: enter at the highest place that fits, then fall through. Because every block
 * resets its digit itself, inner zeros come out right (`1005` → `1`,`0`,`0`,`5`) and leading ones
 * never appear — so unlike {@link drawPanelNumber} there is no shared tens path here.
 */
export function drawPanelNumberWide(
  fb: Framebuffer,
  provider: SpriteProvider,
  value: number,
  col: number,
  row: number,
): number {
  let v = value & 0xffff;
  let c = col;
  const cascade = v >= 10000 ? 5 : v >= 1000 ? 4 : v >= 100 ? 3 : v >= 10 ? 2 : 1;
  for (let place = cascade; place >= 2; place--) {
    const p = 10 ** (place - 1);
    let digit = 0;
    while (v >= p) {
      digit += 1;
      v -= p;
    }
    drawPanelIcon(fb, provider, UI_DIGIT_ICON_BASE + digit, c++, row);
  }
  drawPanelIcon(fb, provider, UI_DIGIT_ICON_BASE + v, c++, row);
  return c - col;
}

/**
 * **"+n" icon** behind a number (@0x41bb9). The building statistics writes "2+1" for "2 finished,
 * 1 under construction"; the "+1" is a **single** icon from the row `0xf0 + n`, with one collective
 * icon from 10 on. Zero draws nothing.
 *
 * It goes at the column {@link drawPanelNumber} just left behind, hence the explicit column.
 */
export const UI_INCREMENT_ICON_BASE = 0xf0;
export const UI_INCREMENT_ICON_MANY = 0xfa;
export function drawIncrementIcon(
  fb: Framebuffer,
  provider: SpriteProvider,
  value: number,
  col: number,
  row: number,
): void {
  if ((value & 0xffff) === 0) return;
  const icon = value < 10 ? UI_INCREMENT_ICON_BASE + value : UI_INCREMENT_ICON_MANY;
  drawPanelIcon(fb, provider, icon, col, row);
}

/**
 * **A horizontal band of eight icons** (@0x42146). The 16 px tiles cover the full 128 px popup width;
 * the statistics curves build their background from such bands.
 */
export function drawPanelIconRow(
  fb: Framebuffer,
  provider: SpriteProvider,
  row: number,
  icon: number,
): void {
  for (let col = 0xe; col >= 0; col -= 2) drawPanelIcon(fb, provider, icon, col, row);
}

/** Single pixel — the sibling of {@link fillRect}. Only the curve drawing uses it. */
export function putPixel(
  fb: Framebuffer,
  x: number,
  y: number,
  color: readonly [number, number, number],
): void {
  if (x < 0 || y < 0 || x >= fb.width || y >= fb.height) return;
  const o = (y * fb.width + x) * 4;
  fb.rgba[o] = color[0];
  fb.rgba[o + 1] = color[1];
  fb.rgba[o + 2] = color[2];
  fb.rgba[o + 3] = 255;
}

/** Trough icon of a slider. */
export const SLIDER_TROUGH_ICON = 0xec;
/** Value per bar pixel (`div` @0x3cdbb); 50 · 1310 = 65500 = full deflection. */
export const SLIDER_STEP = 0x51e;
/** Maximum bar length in pixels — the click path clamps to `0x32` (@0x2f8b4). */
export const SLIDER_MAX_PIXELS = 0x32;
/** Bar origin relative to the panel position. */
export const SLIDER_BAR_DX = 0xf;
export const SLIDER_BAR_DY = 0xb;
/** Bar height and palette index of the fill colour (@0x3ce16). */
export const SLIDER_BAR_HEIGHT = 4;
export const SLIDER_BAR_COLOR_INDEX = 0x1e;

/**
 * Filled rectangle — the original primitive `(x, y, w, h, colour)`.
 *
 * The argument roles are **proven**, not guessed: one call site paints four tiles at `(8,9)`,
 * `(0x48,9)`, `(8,0x51)`, `(0x48,0x51)` with identical `w = 0x40`, `h = 0x48` and four colours —
 * 64 × 72 tiles the 128 × 144 popup area exactly, which works out only with this assignment.
 */
export function fillRect(
  fb: Framebuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  color: readonly [number, number, number],
): void {
  for (let yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= fb.height) continue;
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= fb.width) continue;
      const o = (yy * fb.width + xx) * 4;
      fb.rgba[o] = color[0];
      fb.rgba[o + 1] = color[1];
      fb.rgba[o + 2] = color[2];
      fb.rgba[o + 3] = 255;
    }
  }
}

/**
 * **Slider** (@0x3cd8c). The bar is **not** a sprite but a filled rectangle of `value / 0x51e`
 * pixels — 50 at full deflection. Without a palette the bar stays undrawn rather than inventing a
 * colour.
 */
export function drawSlider(
  fb: Framebuffer,
  provider: SpriteProvider,
  col: number,
  row: number,
  value: number,
  barColor?: readonly [number, number, number],
): void {
  drawPanelIcon(fb, provider, SLIDER_TROUGH_ICON, col, row);
  const q = Math.floor((value & 0xffff) / SLIDER_STEP);
  if (q === 0 || barColor === undefined) return;
  fillRect(fb, col * 8 + SLIDER_BAR_DX, row + SLIDER_BAR_DY, q, SLIDER_BAR_HEIGHT, barColor);
}

/**
 * Runs a layout table: every `{icon, col, row}` as sprite `base + icon`. The blit primitive follows
 * from the bank ({@link blitForBank}).
 *
 * The original's interpreter @0x3d0b8 reads three u16 per entry and stops at a negative icon
 * (`js` @0x3d0c9). Its 19 call sites are exactly the screens with building graphics.
 */
export function drawLayout(
  fb: Framebuffer,
  provider: SpriteProvider,
  items: readonly LayoutItem[],
  base: number,
): void {
  const blit = blitForBank(base);
  for (const it of items) {
    const s = provider(base + it.icon);
    if (s) blit(fb, s, panelX(it.col), panelY(it.row));
  }
}

/** Icon of a slot **without** a face (@0x39533). */
export const FACE_ICON_EMPTY = 0x119;
/** Icon of an occupied slot: face byte + `0x10b` (@0x39548). */
export const FACE_ICON_BASE = 0x10b;

/**
 * **Face byte → icon of the UI bank** (@0x3952c). The original tests the **byte** (`or %al,%al`) and
 * then sign-extends it (`movsbw` @0x3953f) — reproduced here rather than quietly treating it as
 * `uint8`.
 *
 * The face itself lives in `gs+0x1d6 + 4·slot`; it is not in the save game but reconstructable from
 * its setup index (`player-setup.ts`). Three screens call this one primitive: the colour legend, the
 * message window and the mission end.
 */
export function faceIcon(face: number): number {
  if ((face & 0xff) === 0) return FACE_ICON_EMPTY;
  return (((face & 0xff) << 24) >> 24) + FACE_ICON_BASE;
}

/** Tiles one background icon over the panel area — the original's 8 × 9 grid. */
export function tileBackground(fb: Framebuffer, provider: SpriteProvider, icon: number): void {
  const s = provider(UI_ICON_BASE + icon);
  if (!s) return;
  for (let row = 128; row >= 0; row -= 16) {
    for (let col = 14; col >= 0; col -= 2) {
      blitSprite(fb, s, panelX(col), panelY(row));
    }
  }
}

// --- Concrete screens (data from the original) --------------------------------------------------

/** Background tile icon of the standard panel. */
export const PANEL_BG_ICON = 0x83;

/**
 * Mine build menu (popup screen 3): four mine previews in a 2×2 grid — stone, coal, iron, gold.
 * Byte-exact from the original table @0x3d0f1.
 */
export const MINE_PANEL_LAYOUT: readonly LayoutItem[] = [
  { icon: 0xa3, col: 2, row: 8 },
  { icon: 0xa4, col: 8, row: 8 },
  { icon: 0xa5, col: 4, row: 77 },
  { icon: 0xa6, col: 10, row: 77 },
];

/**
 * Economy build menu (popup screens 4/5): seven building previews, byte-exact from @0x3d10b. The
 * original hides preview 0xab depending on a player flag (variant @0x3d111); this is the full row.
 */
export const SMALL_BUILDING_LAYOUT: readonly LayoutItem[] = [
  { icon: 0xab, col: 10, row: 13 },
  { icon: 0xa9, col: 2, row: 13 },
  { icon: 0xa8, col: 0, row: 58 },
  { icon: 0xaa, col: 6, row: 56 },
  { icon: 0xa7, col: 12, row: 55 },
  { icon: 0xbc, col: 2, row: 85 },
  { icon: 0xae, col: 10, row: 87 },
];

/** Draws the mine build menu (popup screen 3). */
export function drawMinePanel(fb: Framebuffer, provider: SpriteProvider): void {
  tileBackground(fb, provider, PANEL_BG_ICON);
  drawLayout(fb, provider, MINE_PANEL_LAYOUT, UI_OBJECT_BASE);
}

/** A table-driven popup screen; `id` is the original's `vp[0x70]` screen number. */
export interface PopupScreen {
  readonly id: number;
  readonly title: string;
  readonly layout: readonly LayoutItem[];
}

/**
 * The **table-driven** build menu screens. Screens 1/2 (large buildings) use a different,
 * **map-based** renderer (@0x422eb, the 7×7 buildability preview) and are not in here.
 */
export const POPUP_SCREENS: ReadonlyMap<number, PopupScreen> = new Map([
  [3, { id: 3, title: 'build: mines', layout: MINE_PANEL_LAYOUT }],
  [4, { id: 4, title: 'build: economy buildings', layout: SMALL_BUILDING_LAYOUT }],
]);

/**
 * Draws a table-driven popup screen. `false` means the screen is unknown, and the caller shows a
 * placeholder.
 */
export function drawPopupScreen(
  fb: Framebuffer,
  provider: SpriteProvider,
  screenId: number,
): boolean {
  const screen = POPUP_SCREENS.get(screenId);
  if (screen === undefined) return false;
  tileBackground(fb, provider, PANEL_BG_ICON);
  drawLayout(fb, provider, screen.layout, UI_OBJECT_BASE);
  return true;
}

/**
 * Wooden frame of every popup (144 × 160 surface), byte-exact from @0x757a. The free interior
 * (8,9)..(136,153) = 128 × 144 is exactly the content area.
 */
export const POPUP_FRAME: readonly FrameSprite[] = [
  { entry: 659, x: 0, y: 0 }, // top
  { entry: 660, x: 0, y: 153 }, // bottom
  { entry: 661, x: 0, y: 9 }, // left
  { entry: 662, x: 136, y: 9 }, // right
];

/**
 * The original screen in 640 × 480 full-screen mode — the frame of reference for every absolute
 * position in this module. Anchor this rectangle in the window and the parts keep their original
 * arrangement relative to each other.
 */
export const UI_SCREEN = { width: 640, height: 480 } as const;

/**
 * **The map area within the original screen.**
 *
 * The size sits as `vp[0x3e]/vp[0x40]` in the viewport init of the 640 mode (@0x620f/@0x621a); the
 * origin `(16, 8)` is not in the init but a literal in the consumers (@0x2ad83/@0x2ad86, the edge
 * scroll of road building).
 *
 * Needed wherever an original **pixel** threshold has to be carried over to our freely scaling
 * window: a tile count transfers as is, a pixel bound does not — it has to keep its share of this
 * area.
 */
export const MAP_AREA = { x: 16, y: 8, width: 608, height: 432 } as const;

/**
 * **Where the popup sits in the original** (640 × 480). The 144 × 160 frame surface is at (240, 261).
 *
 * The viewport init writes the **click anchor** `vp[0x78]/vp[0x7a]` = (248, 270) (@0x6298/@0x62a3).
 * That anchor is the **content** corner; the drawing surface starts one frame width earlier — the
 * same (8, 9) offset the hit test uses.
 *
 * Worth knowing: the popup is **not** centred — its middle is 8 px left of the screen centre, and
 * vertically it sits 19 px above the control panel.
 */
export const POPUP_BOUNDS = {
  x: 240,
  y: 261,
  width: 144,
  height: 160,
} as const;

/** Click anchor of the popup content area = {@link POPUP_BOUNDS} + (8, 9). */
export const POPUP_CLICK_ANCHOR = { x: 248, y: 270 } as const;

/**
 * **Where the same popup sits in the 352 × 240 set** — the set the main menu runs on. The frame
 * surface is the **same** 144 × 160, only the screen is smaller; it sits at (104, 24).
 *
 * The small set's viewport init @0x5e23 writes the click anchor (112, 33) (@0x5efc/@0x5f07). That
 * this is the **menu** set's routine and not one of the other five such blocks does not rest on a
 * claim but on three constants of the same body that we know independently: `vp[0x3e]/vp[0x40]` =
 * 320 × 192 == `MENU_AREA`, `vp[0x30]` = 200 == top edge of the small panel, `vp[0x6a]` = 64 == its
 * left edge.
 *
 * Verified at the pixel against an original capture: searching the whole 352 × 240 area finds
 * (104, 24) with **0 deviations out of 23040** opaque pixels — which also confirms the (8, 9) frame
 * offset a second time, as a property of the frame rather than of the screen set.
 *
 * Unlike the large set, the popup here is exactly centred horizontally. Two tables, two decisions.
 */
export const POPUP_BOUNDS_SMALL = {
  x: 104,
  y: 24,
  width: 144,
  height: 160,
} as const;

/** Click anchor in the small set (@0x5efc/@0x5f07) = {@link POPUP_BOUNDS_SMALL} + (8, 9). */
export const POPUP_CLICK_ANCHOR_SMALL = { x: 112, y: 33 } as const;

/**
 * Draws the popup frame (@0x757a, a routine separate from the content). Content and frame share one
 * surface and do not overlap; `(ox, oy)` shifts every part.
 */
export function drawPopupFrame(fb: Framebuffer, provider: SpriteProvider, ox = 0, oy = 0): void {
  for (const f of POPUP_FRAME) {
    const s = provider(f.entry);
    if (s) blitSprite(fb, s, f.x + ox, f.y + oy);
  }
}

// --- Player switch in the frame header (game type 4, "DEMO", only) ------------------------------

/**
 * **The four coloured buttons in a popup's top frame strip** — the spectator mode's player switch
 * (@0x444e3, the popup presenter).
 *
 * It runs only with `gs+0x37e` bit 5 set (`bt $0x5` @0x44518), i.e. exactly at `gameType == 4`. Two
 * gates in front of it return **without any** drawing: `vp[0]` bit 0 and `vp[1]` bit 1 (the popup
 * modality).
 *
 * Per slot it blits an 8×7 sprite when the player carries `flags` bit 6 (active), and takes the
 * **highlighted** variant (`+4`) when the slot is the window's own.
 *
 * **The bank proves the split itself**: entry 668 is empty, 669..676 are **eight** 8×7 sprites, 677
 * is empty again — four players × two states and no more. Their raw bytes carry exactly the four
 * team ramps, which confirms the slot assignment independently of the code's comparison constants.
 *
 * `x`/`y` are coordinates of the **frame** surface, not of the content area. The hit test, however,
 * measures from the **content** anchor like the original — see {@link hitPopupPlayerButton}.
 */
export const POPUP_PLAYER_BUTTONS: readonly {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  readonly entry: number;
  readonly entryCurrent: number;
}[] = [
  { slot: 0, x: 0x10, y: 1, entry: 669, entryCurrent: 673 },
  { slot: 1, x: 0x28, y: 1, entry: 670, entryCurrent: 674 },
  { slot: 2, x: 0x60, y: 1, entry: 671, entryCurrent: 675 },
  { slot: 3, x: 0x78, y: 1, entry: 672, entryCurrent: 676 },
];

/** What the switch needs in order to draw. */
export interface PopupPlayerButtonsView {
  /** `flags` bit 6 per slot — only active players get a button. */
  readonly active: readonly boolean[];
  /** The window's own slot; its button is highlighted. */
  readonly current: number;
}

/** Draws the switch onto the frame surface. Whether game type 4 applies is the caller's decision. */
export function drawPopupPlayerButtons(
  fb: Framebuffer,
  provider: SpriteProvider,
  view: PopupPlayerButtonsView,
  ox = 0,
  oy = 0,
): void {
  for (const b of POPUP_PLAYER_BUTTONS) {
    if (view.active[b.slot] !== true) continue;
    const s = provider(b.slot === view.current ? b.entryCurrent : b.entry);
    if (s) blitSprite(fb, s, b.x + ox, b.y + oy);
  }
}

/**
 * Hit test of the switch — `x`/`y` **relative to the content anchor**, exactly as in the original
 * (@0x2bffe/@0x2c012).
 *
 * The strip sits **above** the content: `y < 0`, and after `addw $0x8` @0x2c02f the result must stay
 * `>= 0` ⇒ `y ∈ [−8, 0)`. In x the four windows are `[8,16)`, `[32,40)`, `[88,96)`, `[112,120)`; the
 * gaps between them return without effect. The zones therefore sit **one frame width left** of the
 * sprites, which confirms the same (8, 9) offset {@link POPUP_CLICK_ANCHOR} carries.
 */
export function hitPopupPlayerButton(x: number, y: number): number | null {
  if (x < 0 || x >= 0x80) return null; // `jns`/`cmpw $0x80` @0x2c001/@0x2c009
  if (y >= 0 || y < -8) return null;
  for (const b of POPUP_PLAYER_BUTTONS) {
    const x0 = b.x - 8; // content-relative: take off the frame width
    if (x >= x0 && x < x0 + 8) return b.slot;
  }
  return null;
}

// --- Build popup screens 1/2 (large buildings) — map preview + control bar ----------------------

/**
 * Row and the five icon columns of the control bar under the map preview (screens 1/2). The preview
 * itself is the only build screen without a static icon layout — it renders a 7×7 map excerpt around
 * the cursor (@0x422eb); only this bar is here, because it needs nothing but the icon bank and the
 * state flags.
 */
export const MAP_PREVIEW_BAR_ROW = 0x80;
export const MAP_PREVIEW_BAR_COLS: readonly number[] = [0, 4, 8, 0xc, 0xe];

/**
 * Bits of the state byte `vp+0xd1`, which drives both the preview overlays and the bar icons.
 */
export const MAP_PREVIEW_FLAG_MODE = 0x03; // bits 0-1 are the slot 0 icon directly
export const MAP_PREVIEW_FLAG_BIT2 = 0x04;
export const MAP_PREVIEW_FLAG_BIT3 = 0x08;
export const MAP_PREVIEW_FLAG_BIT4 = 0x10;
export const MAP_PREVIEW_FLAG_BIT5 = 0x20;

/**
 * The five control bar icons, byte-exact from @0x424ad. `buildingFilter` is the signed `vp+0x2e` —
 * the **building/flag filter** of the overview map (`< 0` all buildings, `0` flag mode, `> 0` only
 * this building type), the same field that filters the building overlay.
 *
 * Slot 0 display mode · slot 1 roads · slot 2 buildings/flags · slot 3 borders · slot 4 magnifier.
 */
export function mapPreviewBarIcons(
  flags: number,
  buildingFilter: number,
): [number, number, number, number, number] {
  const slot0 = flags & MAP_PREVIEW_FLAG_MODE;
  const slot1 = flags & MAP_PREVIEW_FLAG_BIT2 ? 3 : 4;
  let slot2: number;
  if (buildingFilter === 0) slot2 = 0x132;
  else if (buildingFilter > 0) slot2 = 0x131;
  else slot2 = flags & MAP_PREVIEW_FLAG_BIT3 ? 5 : 6;
  const slot3 = flags & MAP_PREVIEW_FLAG_BIT4 ? 7 : 8;
  const slot4 = flags & MAP_PREVIEW_FLAG_BIT5 ? 0x5b : 0x5c;
  return [slot0, slot1, slot2, slot3, slot4];
}

/** Draws the control bar of the map popups (screens 1/2). */
export function drawMapPreviewBar(
  fb: Framebuffer,
  provider: SpriteProvider,
  flags: number,
  buildingFilter: number,
): void {
  const icons = mapPreviewBarIcons(flags, buildingFilter);
  icons.forEach((icon, i) => {
    const s = provider(UI_ICON_BASE + icon);
    if (s) blitSprite(fb, s, panelX(MAP_PREVIEW_BAR_COLS[i]!), panelY(MAP_PREVIEW_BAR_ROW));
  });
}

// --- Control panel (bottom bar) — layout byte-exact from the original ---------------------------

/**
 * PanelButton bank: the round 32×32 navigation buttons of the bottom bar. `icon` is a small mode
 * enum value, **not** an absolute index.
 */
export const UI_PANELBUTTON_BASE = 1749;

/** Number of buttons — the original's drawing loop iterates exactly five times. */
export const CONTROL_PANEL_BUTTON_COUNT = 5;

/**
 * Layout of the button row in the 640 × 480 set, from the original's panel object fields
 * (`panel[0x6a]`, `panel[0xa0]`, `panel[0x30]+4`). Absolute screen pixels, blitted top-left.
 */
export const CONTROL_PANEL_START_X = 0xd0; // 208
export const CONTROL_PANEL_STRIDE = 0x30; // 48
export const CONTROL_PANEL_Y = 0x1b8 + 4; // 444

/**
 * Initial button icons from the panel init (`panel[0x60..0x64]`). In a running game the set is
 * **dynamic**; this is the default right after the panel is built.
 */
export const CONTROL_PANEL_DEFAULT_ICONS: readonly number[] = [0, 7, 10, 12, 14];

/**
 * Icon row **after closing** a popup — the pressed button falling back.
 *
 * Closing (@0x2860b) writes slots **2..4** back to their init values and sets the dirty bit
 * `vp[1] |= 4`, from which the context routine re-derives slots **0/1**. That is why this function
 * leaves 0/1 alone: they come from {@link contextBarState}. (The opening path writes all five.)
 */
export function controlPanelIconsAfterClose(icons: readonly number[]): number[] {
  return [icons[0]!, icons[1]!, ...CONTROL_PANEL_DEFAULT_ICONS.slice(2)];
}

// --- Control panel: the two CONTEXT icons (byte-exact from @0x331a7) ----------------------------

/**
 * Where the **left two** bar icons come from: @0x331a7 writes slots 0 and 1 out of the **build site
 * classification** of the map cursor — slot 0 in several cases as the raw build possibility
 * `player+0x101` itself, without a table. That is why the click dispatch accepts the pairs
 * (0x02/0x17), (0x03/0x11), (0x04/0x12): the small value is the raw possibility, the large one the
 * pressed icon of the same button.
 *
 * The three right-hand slots (map, statistics, distribution) are **not** touched. The routine also
 * sets two entries of the marker sprite list (see {@link CursorMarkerPair}).
 *
 * Jump table (`0x3324e + cursorType·8`): 0→0x3330e, 1→0x33360, 2→0x3338f, 3→0x333be, 4→0x33402,
 * 5→0x33456, 6→0x334aa, 7→0x33515.
 */
export interface ContextBarInput {
  /** Cursor kind `player+0x100` (0..7, see `engine/build-site.ts`). */
  readonly cursorType: number;
  /** Build possibility `player+0x101` (0..5). */
  readonly possibility: number;
  /** `player+2` (`flags`). Only bit 0 is read — meaning open. */
  readonly playerFlags: number;
  /** `panel[1]` bit 7 — road building in progress. */
  readonly roadBuilding: boolean;
  /** `gs[0x37e]` bit 5 — spectator mode (bar reduced to two passive icons). */
  readonly specialMode: boolean;
}

/**
 * Two marker sprites the same routine sets: entry 0 and entry **2** of the seven-record list
 * `panel[0xa4]` (6 bytes each, `{sprite u16, x u16, y u16}`).
 *
 * Identified at the pixel: `0x20` arrows ◄►, `0x21` dot ("nothing"), `0x2f` flag, `0x30` mine,
 * `0x31` house, `0x32` castle, `0x33` "build road", `0x34` "road here".
 *
 * So `possibility + 0x2e` is exactly the symbol row flag/mine/house/castle — and the clamp
 * `0x33 → 0x32` in cursor kind 7 is explained: the castle (possibility 5) would otherwise show the
 * **road** symbol.
 */
export interface CursorMarkerPair {
  /** Record 0 (`panel[0xa4]`). */
  readonly primary: number;
  /** Record 2 (`panel[0xb0]`). */
  readonly secondary: number;
}

export interface ContextBarState {
  /** Slots 0 and 1 of the bar. */
  readonly icons: readonly [number, number];
  /** `null` when the routine returns early — then the markers stay as they are. */
  readonly markers: CursorMarkerPair | null;
}

/** Base of the marker sprite bank: the original adds `0x140`, our index is one lower. */
export const CURSOR_MARKER_BASE = 0x140 - 1; // 319
/** Marker "nothing" (dot) — the resting value of all seven records. */
export const CURSOR_MARKER_NONE = 0x21;
/** Marker "nothing possible here" (arrows ◄►). */
export const CURSOR_MARKER_ARROWS = 0x20;
/** Marker base of the build symbols: `possibility + 0x2e` → flag/mine/house/castle. */
export const CURSOR_MARKER_BUILD_BASE = 0x2e;
/** Marker "build road" == `CURSOR_MARKER_BUILD_BASE + 5`. */
export const CURSOR_MARKER_ROAD_NEW = 0x33;
/** Marker "road here". */
export const CURSOR_MARKER_ROAD_HERE = 0x34;
/** Marker "flag" == `CURSOR_MARKER_BUILD_BASE + 1`. */
export const CURSOR_MARKER_FLAG = 0x2f;

/**
 * Context icons + markers for the current map cursor. The order of the cases follows the jump table
 * (see {@link ContextBarInput}).
 */
export function contextBarState(input: ContextBarInput): ContextBarState {
  const { cursorType, possibility: p } = input;
  // Two early exits — they write ONLY the icons, the markers stay as they are.
  if (input.specialMode) return { icons: [0, 7], markers: null };
  if (input.roadBuilding) return { icons: [0x18, 0], markers: null };

  /** Slot 1 in the "nothing/free" branch: `player.flags` bit 0 switches passive vs. soil probing. */
  const soilOrIdle = (input.playerFlags & 1) !== 0 ? 7 : 0x10;
  const none: ContextBarState = {
    icons: [0, soilOrIdle],
    markers: { primary: CURSOR_MARKER_ARROWS, secondary: CURSOR_MARKER_NONE },
  };

  switch (cursorType) {
    case 0: // nothing possible
      return none;
    case 1: // flag, not removable → build a road from here
      return {
        icons: [8, 7],
        markers: {
          primary: CURSOR_MARKER_ROAD_NEW,
          secondary: CURSOR_MARKER_NONE,
        },
      };
    case 2: // flag, removable → slot 1 = demolish
      return {
        icons: [8, 6],
        markers: {
          primary: CURSOR_MARKER_ROAD_NEW,
          secondary: CURSOR_MARKER_NONE,
        },
      };
    case 3: // building → slot 1 = demolish
      return {
        icons: [p, 6],
        markers: {
          primary: p + CURSOR_MARKER_BUILD_BASE,
          secondary: CURSOR_MARKER_NONE,
        },
      };
    case 4: // road → slot 1 = demolish road; with possibility != 0 a flag can be placed too
      return p !== 0
        ? {
            icons: [1, 0xf],
            markers: {
              primary: CURSOR_MARKER_FLAG,
              secondary: CURSOR_MARKER_NONE,
            },
          }
        : {
            icons: [0, 0xf],
            markers: {
              primary: CURSOR_MARKER_ROAD_HERE,
              secondary: CURSOR_MARKER_NONE,
            },
          };
    case 5: // free, flag adjacent — below possibility 2 the original falls into the "nothing" branch
      if (p < 2) return none;
      return {
        icons: [p, 7],
        markers: {
          primary: p + CURSOR_MARKER_BUILD_BASE,
          secondary: CURSOR_MARKER_NONE,
        },
      };
    case 6: // free, road adjacent
    case 7: {
      // Kinds 6 and 7 differ only in slot 1 and in the castle clamp.
      const icons: readonly [number, number] = [p, cursorType === 7 ? soilOrIdle : 7];
      if (p === 0) {
        return {
          icons,
          markers: {
            primary: CURSOR_MARKER_ARROWS,
            secondary: CURSOR_MARKER_NONE,
          },
        };
      }
      let marker = p + CURSOR_MARKER_BUILD_BASE;
      // Kind 7: the castle (possibility 5) would land on the road symbol → clamp to "castle".
      if (cursorType === 7 && marker === CURSOR_MARKER_ROAD_NEW) marker -= 1;
      return {
        icons,
        // Second marker = the flag belonging to the building — unless marker 1 is the flag itself.
        markers: {
          primary: marker,
          secondary: marker === CURSOR_MARKER_FLAG ? CURSOR_MARKER_NONE : CURSOR_MARKER_FLAG,
        },
      };
    }
    default:
      return none;
  }
}

// --- Special click on the MAP: which screen opens ----------------------------------------------

/**
 * Target screen of a **special click on the map** (`vp[0x70]`), byte-exact from the map branch
 * @0x29d84. It sets the cursor first and falls into this choice when `vp[1]` bit 3 is set (right
 * button held). The decision is made on the tile's **object byte** and, for buildings, on the coded
 * type `building+4 & 0xfc` (= `type << 2`):
 *
 * | tile object | condition | `vp[0x70]` |
 * |---|---|---|
 * | 1 (flag) | own | **0x2a** |
 * | 2..4 (building) | `constructing` | **0x28** |
 * | | castle (`0x60`) / warehouse (`0x28`) | **0x26** |
 * | | military: hut `0x2c`, tower `0x54`, fortress `0x58` | **0x29** |
 * | | mine: `0x14`, `0x18`, `0x1c`, `0x20` | **0x27** |
 * | | everything else | **0x34** |
 *
 * **Foreign** property: the original checks the tile owner bits and takes foreign buildings into the
 * attack path instead of the info screens; a foreign flag does nothing. Hence the `owned` parameter.
 * Which foreign buildings get a window is decided by the type chain of the attack branch @0x2a43d:
 * hut, tower, fortress **and the castle** ⇒ screen `0x14`, everything else nothing. The castle is
 * attackable even though it contributes no knights to an attack itself.
 *
 * The original's owner comparison masks with **`0x60`**, not `0xe0` — it ignores the "has owner" bit.
 * For player 0 unclaimed land therefore counts as own; since a building always stands on claimed
 * land, the case does not arise.
 */
export function mapSpecialClickScreen(
  object: number,
  building: {
    readonly type: number;
    readonly constructing: boolean;
    readonly active?: boolean;
  } | null,
  owned: boolean,
): number | null {
  if (object === 1) return owned ? 0x2a : null;
  if (object < 2 || object > 4) return null;
  if (building === null) return null;
  const coded = building.type << 2;
  const military = coded === 0x2c || coded === 0x54 || coded === 0x58;
  if (!owned) {
    // The attack branch masks with `0xfc` and thereby keeps the construction bit in the comparison:
    // a foreign **construction site** matches none of the four values and opens nothing.
    if (building.constructing) return null;
    return military || coded === 0x60 ? 0x14 : null;
  }
  if (building.constructing) return 0x28;
  // A warehouse only when it is **active** (`bt $0x4, bld[5] ; jnc ret` @0x2a1b9): finished but not
  // yet commissioned, it has no window. The castle skips that check.
  if (coded === 0x28) return building.active === false ? null : 0x26;
  if (coded === 0x60) return 0x26;
  if (military) return 0x29;
  if (coded === 0x14 || coded === 0x18 || coded === 0x1c || coded === 0x20) return 0x27;
  return 0x34;
}

/**
 * Message / return indicators left of the buttons.
 *
 * The four sprites come in pairs — 1781/1783 draw, 1782/1784 are the wooden patches the original
 * erases with. Our renderer rebuilds the bar on every state change, so the erase sprites have no
 * use here. What is visible when is decided by `message-overlay.ts`.
 */
export const UI_PANEL_INDICATOR_X = 0xb8; // 184
export const UI_PANEL_INDICATOR_MSG = 1781; // message pending
export const UI_PANEL_INDICATOR_MSG_Y = 0x1b8 + 4; // 444
export const UI_PANEL_INDICATOR_RETURN = 1783; // return arrow
export const UI_PANEL_INDICATOR_RETURN_Y = 0x1b8 + 0x1c; // 468

/** Draws one 32×32 panel button (icon offset into the bank), top-left at `(x, y)`. */
export function drawPanelButton(
  fb: Framebuffer,
  provider: SpriteProvider,
  icon: number,
  x: number,
  y: number,
): void {
  const s = provider(UI_PANELBUTTON_BASE + icon);
  if (s) blitSprite(fb, s, x, y);
}

/**
 * Draws the five navigation buttons at the original's absolute coordinates. `(ox, oy)` shifts them
 * all (e.g. to place the section in a smaller preview framebuffer).
 *
 * The wooden frame and the two end emblems are **not** part of this loop — they are separate chrome
 * in {@link drawControlPanelFrame} (its own routine in the original); the call order is frame first,
 * buttons on top.
 */
export function drawControlPanel(
  fb: Framebuffer,
  provider: SpriteProvider,
  icons: readonly number[] = CONTROL_PANEL_DEFAULT_ICONS,
  ox = 0,
  oy = 0,
): void {
  icons.forEach((icon, i) => {
    drawPanelButton(
      fb,
      provider,
      icon,
      CONTROL_PANEL_START_X + i * CONTROL_PANEL_STRIDE + ox,
      CONTROL_PANEL_Y + oy,
    );
  });
}

/** One frame sprite of the bar: archive `entry`, blitted top-left at absolute `(x, y)`. */
export interface FrameSprite {
  readonly entry: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Wooden frame + end emblems of the control panel (640 × 480, single player), byte-exact from the
 * original's layout table (int16 triples `{atlasSprite, x, y}`, negative-terminated).
 *
 * The two 8×40 columns are not "end caps" but the bar's two **interactive** columns, at exactly the
 * x values the click dispatch carries as zones (184 and 448, 12 px wide, @0x2731f/@0x27350):
 * - **1779@184** — empty wooden field onto which the message overlay blits the blinking note (1781)
 *   and below it the return arrow (1783).
 * - **1780@448** — the **five clocks of the recall function**, 8 px clock faces with a growing green
 *   sector; the manual (p. 109) reads them top to bottom as 5, 10, 20, 30 and 60 minutes. They are
 *   pure chrome and thus already drawn by this table; the click side is in `engine/message-recall.ts`.
 */
export const CONTROL_PANEL_FRAME: readonly FrameSprite[] = [
  { entry: 1785, x: 144, y: 440 }, // emblem, left
  { entry: 1779, x: 184, y: 440 }, // message column (note + return arrow appear here)
  { entry: 1799, x: 192, y: 440 }, // divider
  { entry: 1786, x: 208, y: 440 }, // button 1, upper strip
  { entry: 1787, x: 208, y: 476 }, // button 1, lower strip
  { entry: 1800, x: 240, y: 440 },
  { entry: 1788, x: 256, y: 440 },
  { entry: 1789, x: 256, y: 476 },
  { entry: 1801, x: 288, y: 440 },
  { entry: 1790, x: 304, y: 440 },
  { entry: 1791, x: 304, y: 476 },
  { entry: 1802, x: 336, y: 440 },
  { entry: 1792, x: 352, y: 440 },
  { entry: 1793, x: 352, y: 476 },
  { entry: 1803, x: 384, y: 440 },
  { entry: 1794, x: 400, y: 440 },
  { entry: 1795, x: 400, y: 476 },
  { entry: 1804, x: 432, y: 440 }, // divider
  { entry: 1780, x: 448, y: 440 }, // the five recall clocks (5/10/20/30/60 min)
  { entry: 1785, x: 456, y: 440 }, // emblem, right
];

/**
 * Bounding rectangle of the bar, derived from the frame table above plus the sprite sizes.
 *
 * Needed because the bar is an **overlay** over the map in the original — the map fills the whole
 * screen and stays visible left and right of it. To draw the bar as its own section, take a
 * framebuffer of this size and `(ox, oy) = (−x, −y)`.
 */
export const CONTROL_PANEL_BOUNDS = {
  x: 144,
  y: 440,
  width: 352,
  height: 40,
} as const;

/** Draws the wooden frame and the two emblems. Call order as in the original: frame, then buttons. */
export function drawControlPanelFrame(
  fb: Framebuffer,
  provider: SpriteProvider,
  ox = 0,
  oy = 0,
  frame: readonly FrameSprite[] = CONTROL_PANEL_FRAME,
): void {
  for (const f of frame) {
    const s = provider(f.entry);
    if (s) blitSprite(fb, s, f.x + ox, f.y + oy);
  }
}

// --- Screen chrome of the 352 × 240 set (border + bar around the main menu) ---------------------

/**
 * **The outer wooden border of the 352 × 240 area** — @0x71ac, branch "small resolution". Three blits
 * with **absolute** archive indices (not icon-bank-relative), read from the ASM at
 * @0x71df/@0x71fe/@0x721d.
 *
 * Confirmed independently at the pixel: searching **all 4000** archive entries against the border
 * positions finds exactly these three, each with **every** opaque pixel matching an original capture.
 *
 * Together with {@link CONTROL_PANEL_FRAME_SMALL} they cover exactly the area **outside** the menu:
 * `2 · 16 · 200 + 320 · 8 + 352 · 40 = 23040 = 352 · 240 − 320 · 192`.
 */
export const SCREEN_BORDER_SMALL: readonly FrameSprite[] = [
  { entry: 599, x: 0, y: 0 }, // left strip 16×200
  { entry: 600, x: 336, y: 0 }, // right strip 16×200
  { entry: 601, x: 16, y: 0 }, // top band 320×8
];

/**
 * The **split-screen divider** (entry 602, 32×192) — the same body draws it only with `gs+0x37e`
 * bit 2 set, i.e. "second human player" (@0x7238).
 *
 * Deliberately a separate constant rather than a fourth row above: it is **conditional**, and in a
 * single-player capture it correspondingly sits nowhere (best fit of the sprite there: 370 of 6144
 * pixels).
 */
export const SCREEN_BORDER_SMALL_SPLIT: FrameSprite = {
  entry: 602,
  x: 160,
  y: 8,
};

/**
 * Wooden frame of the control panel in the **352** set — the table the frame routine walks in the
 * branch "small resolution, one human" (@0x6e95).
 *
 * Measured identity with the 640 table: entry for entry the same sequence as
 * {@link CONTROL_PANEL_FRAME}, shifted by exactly `(−144, −240)`. It still stands here as **its own
 * data**, because in the original it is its own table — a derived shift would drift silently if one
 * of the two ever differed.
 */
export const CONTROL_PANEL_FRAME_SMALL: readonly FrameSprite[] = [
  { entry: 1785, x: 0, y: 200 }, // emblem, left
  { entry: 1779, x: 40, y: 200 }, // message column
  { entry: 1799, x: 48, y: 200 }, // divider
  { entry: 1786, x: 64, y: 200 },
  { entry: 1787, x: 64, y: 236 },
  { entry: 1800, x: 96, y: 200 },
  { entry: 1788, x: 112, y: 200 },
  { entry: 1789, x: 112, y: 236 },
  { entry: 1801, x: 144, y: 200 },
  { entry: 1790, x: 160, y: 200 },
  { entry: 1791, x: 160, y: 236 },
  { entry: 1802, x: 192, y: 200 },
  { entry: 1792, x: 208, y: 200 },
  { entry: 1793, x: 208, y: 236 },
  { entry: 1803, x: 240, y: 200 },
  { entry: 1794, x: 256, y: 200 },
  { entry: 1795, x: 256, y: 236 },
  { entry: 1804, x: 288, y: 200 }, // divider
  { entry: 1780, x: 304, y: 200 }, // the five recall clocks
  { entry: 1785, x: 312, y: 200 }, // emblem, right
];

/**
 * Origin of the **first bar button** in the 352 set. Unlike the 640 set there is no viewport init
 * carrying these literals — they come from two other places plus the picture:
 *
 * - **x = 64**: the upper strips of the five button slots sit at 64 / 112 / 160 / 208 / 256 in
 *   {@link CONTROL_PANEL_FRAME_SMALL}, i.e. the same stride 48 as the 640 set.
 * - **y = 204**: the bar starts at 200 in that same table and the button sits 4 px below — the same
 *   offset {@link CONTROL_PANEL_Y} carries for the 640 set.
 *
 * Confirmed at the pixel: at exactly these five places an original capture shows the icons
 * {@link CONTROL_PANEL_DEFAULT_ICONS}, each with all 1024 opaque pixels exact. That the main menu
 * shows the **init** set is therefore measured, not assumed.
 */
export const CONTROL_PANEL_SMALL_ORIGIN = { x: 64, y: 204 } as const;

/**
 * Draws the **screen chrome** of the 352 set: outer border + bar frame.
 *
 * In the original these are two routines, and they are called **as a pair** — five sites carry
 * `call 0x718a ; call 0x6e50` back to back (program start, game start, layout toggle, end credits).
 * So they run **once when the layout is built**, not per frame; for our renderer, which rebuilds
 * every frame anyway, that is equivalent.
 *
 * The chrome does **not** overlap the menu area `(16, 8)–(336, 200)`, so the drawing order against
 * the menu is free.
 */
export function drawScreenChromeSmall(
  fb: Framebuffer,
  provider: SpriteProvider,
  options: {
    readonly splitScreen?: boolean;
    /** The five button icons `vp[0x60..0x64]`; in the main menu those are the init values. */
    readonly icons?: readonly number[];
  } = {},
): void {
  for (const f of SCREEN_BORDER_SMALL) {
    const s = provider(f.entry);
    if (s) blitSprite(fb, s, f.x, f.y);
  }
  if (options.splitScreen === true) {
    const s = provider(SCREEN_BORDER_SMALL_SPLIT.entry);
    if (s) blitSprite(fb, s, SCREEN_BORDER_SMALL_SPLIT.x, SCREEN_BORDER_SMALL_SPLIT.y);
  }
  drawControlPanelFrame(fb, provider, 0, 0, CONTROL_PANEL_FRAME_SMALL);
  // The buttons are their own routine in the original because their icon set is state — hung onto
  // the same call here, the way the frame loop does it.
  drawControlPanel(
    fb,
    provider,
    options.icons ?? CONTROL_PANEL_DEFAULT_ICONS,
    CONTROL_PANEL_SMALL_ORIGIN.x - CONTROL_PANEL_START_X,
    CONTROL_PANEL_SMALL_ORIGIN.y - CONTROL_PANEL_Y,
  );
}

/**
 * Shows note and return arrow in the message column — the drawing side of `message-overlay.ts`. Call
 * after the frame and the buttons: in the original the sprites lie over the wooden field 1779.
 */
export function drawMessageIndicators(
  fb: Framebuffer,
  provider: SpriteProvider,
  show: { readonly note: boolean; readonly arrow: boolean },
  ox = 0,
  oy = 0,
): void {
  if (show.note) {
    const s = provider(UI_PANEL_INDICATOR_MSG);
    if (s) blitSprite(fb, s, UI_PANEL_INDICATOR_X + ox, UI_PANEL_INDICATOR_MSG_Y + oy);
  }
  if (show.arrow) {
    const s = provider(UI_PANEL_INDICATOR_RETURN);
    if (s) blitSprite(fb, s, UI_PANEL_INDICATOR_X + ox, UI_PANEL_INDICATOR_RETURN_Y + oy);
  }
}

// --- Control panel: click navigation (byte-exact from @0x272d7) ---------------------------------

/**
 * Click band of the button row. The y test is bar-relative `[4, 0x23]` against `panel[0x30]`; the x
 * base is `panel[0x1e0]` (== the buttons' start x), stride `panel[0xa0]`, button width 32.
 */
export const CONTROL_PANEL_CLICK_Y_MIN = 0x1b8 + 4; // 444
export const CONTROL_PANEL_CLICK_Y_MAX = 0x1b8 + 0x23; // 475
export const CONTROL_PANEL_CLICK_X0 = 0xd0; // 208
const CONTROL_PANEL_BUTTON_WIDTH = 0x20; // 32 within the stride of 48

/**
 * If a click `(x, y)` (absolute pixels; `ox/oy` the same preview offset as when drawing) hits one of
 * the five buttons, returns the **button index 0..4**, otherwise `null`. Clicks into the 16 px gap
 * between two buttons are discarded, as is an index above 4.
 */
export function hitTestControlPanelButton(x: number, y: number, ox = 0, oy = 0): number | null {
  const ay = y - oy;
  if (ay < CONTROL_PANEL_CLICK_Y_MIN || ay > CONTROL_PANEL_CLICK_Y_MAX) return null;
  let off = x - ox - CONTROL_PANEL_CLICK_X0;
  if (off < 0) return null;
  let idx = 0;
  while (off >= CONTROL_PANEL_BUTTON_WIDTH) {
    idx++;
    if (off < CONTROL_PANEL_STRIDE) return null; // in the gap between two buttons
    off -= CONTROL_PANEL_STRIDE;
  }
  return idx > 4 ? null : idx;
}

/**
 * What a button click triggers — from the icon dispatch @0x272d7. The handler selects on the **icon
 * value**, not on the index: it sets the target popup screen `vp[0x70]` and rewrites the five button
 * icons. Active/inactive icon pairs open the same screen.
 */
export interface PanelButtonAction {
  /** Target popup screen; `undefined` = special action without a plain screen change. */
  readonly screen?: number;
  /** New button icon row after the click (`panel[0x60..0x64]`). */
  readonly newIcons?: readonly number[];
  /**
   * **Which kind of click triggers the action.** Every icon branch tests `vp[1]` bit 3, which is set
   * while the **right mouse button** is held; "hold right + click left" is the manual's special
   * click (p. 24). The polarity is per branch and taken over literally:
   * - `'normal'` — `if (!bit3) { … }`: only on a plain click (the majority).
   * - `'special'` — `if (!bit3) return; …`: **only** with a special click. Exactly the two
   *   destructive icons `0x06` and `0x0f` — manual p. 44: "demolition only ever with a special
   *   click".
   * - `'any'` — no bit 3 test in the branch (soil probing `0x10`/`0x16`).
   */
  readonly click: 'normal' | 'special' | 'any';
  /**
   * What the **special click** does instead, where the branch has its own path for it. Only the map
   * icons have one: they set `vp[0xd8] = 0x10` (@0x27f28), which the scroll driver reads as bit 4
   * and turns into `goto_own_castle` @0x56d8 — gated on `player[3]` bit 3 ("has a castle").
   */
  readonly specialNote?: string;
  /**
   * Direct game action instead of a popup — the original calls a build/demolish routine that
   * classifies the build site first and acts only on a matching cursor kind/possibility.
   */
  readonly command?:
    'buildFlag' | 'foundCastle' | 'demolishRoad' | 'demolishAtCursor' | 'toggleRoadBuilding';
  /**
   * **Does this branch clear the build helper** (`vp[0]` bit 6)? It belongs here and not on the
   * screen because it is a property of the **icon branch**: of the bit's eight clearing sites only
   * four are bar branches, and the three build-menu branches plus the demolish confirmation
   * explicitly are **not** among them (surveyed: ten accesses in the whole game segment, all
   * accounted for).
   *
   * | icon | screen | `btr $0x6` |
   * |---|---|---|
   * | `0x0a`/`0x13` map | 1 | @0x27f08, **before** the special/normal fork |
   * | `0x0c`/`0x14` statistics | 8 | @0x280da |
   * | `0x0e`/`0x15` distribution | 0x24 | @0x28165 |
   * | `0x10`/`0x16` soil probing | 0x16 | @0x28385 |
   *
   * So a blanket "every popup branch clears it" is wrong: the build menu leaves the markers
   * standing, and getting that wrong meant losing them whenever a building was placed.
   */
  readonly clearsBuildHelper?: true;
  /** Short description of the effect. */
  readonly label: string;
}

/**
 * Icon → action, keyed by the button icon value. Passive icons (0/7/9/0xb/0xd, emblem and fillers)
 * are not in here, so clicking them does nothing.
 */
export const CONTROL_PANEL_BUTTON_ACTIONS: ReadonlyMap<number, PanelButtonAction> = new Map([
  // Map: the only branch with its OWN special-click path (`vp[0xd8] = 0x10`).
  [
    0x0a,
    {
      screen: 1,
      newIcons: [0, 7, 0x13, 0xb, 0xd],
      click: 'normal',
      clearsBuildHelper: true,
      label: 'map (overview)',
      specialNote: 'special click: vp[0xd8] = 0x10 ⇒ jump to own castle (@0x56d8)',
    },
  ],
  [
    0x13,
    {
      screen: 1,
      newIcons: [0, 7, 0x13, 0xb, 0xd],
      click: 'normal',
      clearsBuildHelper: true,
      label: 'map (overview, active)',
      specialNote: 'special click: vp[0xd8] = 0x10 ⇒ jump to own castle (@0x56d8)',
    },
  ],
  [
    0x0c,
    {
      screen: 8,
      newIcons: [0, 7, 9, 0x14, 0xd],
      click: 'normal',
      clearsBuildHelper: true,
      label: 'statistics menu',
    },
  ],
  [
    0x14,
    {
      screen: 8,
      newIcons: [0, 7, 9, 0x14, 0xd],
      click: 'normal',
      clearsBuildHelper: true,
      label: 'statistics menu (active)',
    },
  ],
  [
    0x0e,
    {
      screen: 0x24,
      newIcons: [0, 7, 9, 0xb, 0x15],
      click: 'normal',
      clearsBuildHelper: true,
      label: 'distribution / options menu',
    },
  ],
  [
    0x15,
    {
      screen: 0x24,
      newIcons: [0, 7, 9, 0xb, 0x15],
      click: 'normal',
      clearsBuildHelper: true,
      label: 'distribution / options menu (active)',
    },
  ],
  [
    0x02,
    {
      screen: 3,
      newIcons: [0x17, 7, 9, 0xb, 0xd],
      click: 'normal',
      label: 'build: mines',
    },
  ],
  [
    0x17,
    {
      screen: 3,
      newIcons: [0x17, 7, 9, 0xb, 0xd],
      click: 'normal',
      label: 'build: mines (active)',
    },
  ],
  [
    0x03,
    {
      screen: 4,
      newIcons: [0x11, 7, 9, 0xb, 0xd],
      click: 'normal',
      label: 'build: economy buildings',
    },
  ],
  [
    0x11,
    {
      screen: 4,
      newIcons: [0x11, 7, 9, 0xb, 0xd],
      click: 'normal',
      label: 'build: economy buildings (active)',
    },
  ],
  [
    0x04,
    {
      screen: 5,
      newIcons: [0x12, 7, 9, 0xb, 0xd],
      click: 'normal',
      label: 'build: economy buildings (variant)',
    },
  ],
  [
    0x12,
    {
      screen: 5,
      newIcons: [0x12, 7, 9, 0xb, 0xd],
      click: 'normal',
      label: 'build: economy buildings (variant, active)',
    },
  ],
  // Soil probing: the only branch WITHOUT a bit 3 test — plain and special click do the same.
  [
    0x10,
    {
      screen: 0x16,
      newIcons: [0, 0x16, 9, 0xb, 0xd],
      click: 'any',
      clearsBuildHelper: true,
      label: 'soil probing (geologist)',
    },
  ],
  [
    0x16,
    {
      screen: 0x16,
      newIcons: [0, 0x16, 9, 0xb, 0xd],
      click: 'any',
      clearsBuildHelper: true,
      label: 'soil probing (geologist, active)',
    },
  ],
  // **Road building toggle** (@0x27490): both icons lead into the same branch, and `vp[1]` bit 6
  // decides between starting (@0x2860d) and cancelling (@0x286dc). `newIcons` covers the start case
  // only; the cancel row is written by the command branch, because it depends on the running state.
  [
    0x08,
    {
      command: 'toggleRoadBuilding',
      newIcons: [0x18, 0, 9, 0xb, 0xd],
      click: 'normal',
      label: 'road building',
    },
  ],
  [
    0x18,
    {
      command: 'toggleRoadBuilding',
      newIcons: [0x18, 0, 9, 0xb, 0xd],
      click: 'normal',
      label: 'road building (active)',
    },
  ],
  // Direct actions without a popup. All of them classify the build site first and do nothing on a
  // wrong cursor kind (error sound + icons rewritten).
  [
    0x01,
    {
      command: 'buildFlag',
      click: 'normal',
      label: 'build flag (@0x2891e; kinds 7/6/4 with possibility != 0)',
    },
  ],
  [
    0x05,
    {
      command: 'foundCastle',
      click: 'normal',
      label: 'found castle (@0x28d0a; possibility 5, kind 7)',
    },
  ],
  // The two destructive icons require the SPECIAL CLICK (`if (!bit3) return`) — manual p. 44.
  [
    0x0f,
    {
      command: 'demolishRoad',
      click: 'special',
      label: 'demolish road (@0x4a493; kind 4 only)',
    },
  ],
  // Slot 1 icon for a removable flag or building: cursor kind 2 demolishes at once, otherwise a
  // confirmation popup opens. For kind 2 the branch calls the SAME routine as the confirm button of
  // screen 0x37 (@0x48c8a), not the flag primitive.
  // The original writes `newIcons` **only on the popup path** (@0x2937c ff., after the early return
  // for kind 2) — the flag demolition leaves the bar alone and lets slots 0/1 be re-derived. The
  // caller must therefore apply the row only after the two-way fork.
  [
    0x06,
    {
      screen: 0x37,
      newIcons: [0, 7, 9, 0xb, 0xd],
      command: 'demolishAtCursor',
      click: 'special',
      label: 'demolish (kind 2 → flag at once, otherwise screen 0x37)',
    },
  ],
]);

/**
 * Icon values whose **special click** toggles the build helper (`vp[0]` bit 6).
 *
 * Seven branches of the icon dispatch jump to the same toggle routine @0x27eb5 when `vp[1]` bit 3 is
 * set. Those are exactly the icons that can stand in **slot 0** — including the passive `0x00`
 * ("nothing can be built here"), which is why the gesture always works whatever the left symbol
 * currently shows.
 *
 * The toggle checks two conditions first: `vp[1]` bit 1 (no popup open) and `vp[1]` bit 7 clear (not
 * in road building mode). **A toggle is written with `btc`/`^`, not `bts`/`|`** — searching for the
 * "setter" of a state bit has to cover both patterns.
 */
export const BUILD_HELPER_TOGGLE_ICONS: ReadonlySet<number> = new Set([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x08, 0x11, 0x12, 0x17, 0x18,
]);

/** Does the click kind match the action? (`special` = right button held, `vp[1]` bit 3.) */
export function panelActionMatchesClick(action: PanelButtonAction, special: boolean): boolean {
  if (action.click === 'any') return true;
  return action.click === (special ? 'special' : 'normal');
}

/**
 * Runs a button click against the current icon row. `null` means no button was hit, the icon is
 * passive, or the click kind does not match — the original does nothing in all three cases. The
 * caller applies `action.newIcons` to its own bar state and opens `action.screen`.
 */
export function clickControlPanel(
  icons: readonly number[],
  x: number,
  y: number,
  ox = 0,
  oy = 0,
  special = false,
): PanelButtonAction | null {
  const idx = hitTestControlPanelButton(x, y, ox, oy);
  if (idx === null || idx >= icons.length) return null;
  const action = CONTROL_PANEL_BUTTON_ACTIONS.get(icons[idx]!) ?? null;
  if (action === null) return null;
  return panelActionMatchesClick(action, special) ? action : null;
}

// --- Click → action (hit test) ------------------------------------------------------------------

/**
 * One click rectangle: `action` id plus the inclusive bounding box in panel pixel coordinates. The
 * original's table entry is 5 bytes `{action, x0, x1, y0, y1}`.
 */
export interface HitRect {
  readonly action: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/**
 * Click hit test — the original's generic two-level click engine: one `0xFF`-terminated rectangle
 * list per screen, walked linearly, and the **first** hit (bounds inclusive) wins.
 *
 * `(x, y)` are in **click coordinates**. For a click in drawing/canvas pixels see
 * {@link hitTestPanel}.
 */
export function hitTest(rects: readonly HitRect[], x: number, y: number): number | null {
  for (const r of rects) {
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.action;
  }
  return null;
}

/**
 * **Compose a popup over the menu area** — the 144 × 160 body plus frame, blitted at
 * {@link POPUP_BOUNDS_SMALL}.
 *
 * It lives here rather than at one of the callers because there are **two** of them, and position
 * and click conversion have to come from **one** source: kept twice, a click eventually lands
 * somewhere other than what was drawn.
 *
 * `body` returns `false` when it has nothing to draw — then the area stays untouched.
 */
export function composeSmallPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  body: (pop: Framebuffer) => boolean,
): boolean {
  const pop = createFramebuffer(POPUP_BOUNDS_SMALL.width, POPUP_BOUNDS_SMALL.height);
  clearFramebuffer(pop, 0, 0, 0);
  if (!body(pop)) return false;
  drawPopupFrame(pop, provider);
  blitSprite(
    fb,
    {
      width: pop.width,
      height: pop.height,
      offsetX: 0,
      offsetY: 0,
      deltaX: 0,
      deltaY: 0,
      pixels: pop.rgba,
    },
    POPUP_BOUNDS_SMALL.x,
    POPUP_BOUNDS_SMALL.y,
  );
  return true;
}

/**
 * Menu area pixel → popup pixel. **Only** the popup position is subtracted; the frame offset (8, 9)
 * is already in {@link hitTestPanel}. Subtracting it a second time here is what once made a dialog
 * silently ignore every click.
 */
export const smallPopupPoint = (sx: number, sy: number): { x: number; y: number } => ({
  x: sx - POPUP_BOUNDS_SMALL.x,
  y: sy - POPUP_BOUNDS_SMALL.y,
});

/**
 * Offset between the **click rectangle space** (the original tables are authored in the logical panel
 * grid) and the **drawing pixels** of the icon wrappers. The original keeps two origins — the click
 * anchor `vp[0x78/0x7a]` and the panel drawing surface; the offset is constant:
 * `drawing pixel = rectangle coordinate + (8, 9)`.
 */
export const PANEL_CLICK_ORIGIN_X = 8;
export const PANEL_CLICK_ORIGIN_Y = 9;

/** Hit test for a click in **drawing/canvas pixels**; converts into rectangle space first. */
export function hitTestPanel(
  rects: readonly HitRect[],
  drawX: number,
  drawY: number,
): number | null {
  return hitTest(rects, drawX - PANEL_CLICK_ORIGIN_X, drawY - PANEL_CLICK_ORIGIN_Y);
}

/** Outlines a click rectangle in **drawing pixels** — for highlighting. */
export function highlightHitRect(
  fb: Framebuffer,
  r: HitRect,
  color: readonly [number, number, number],
): void {
  strokeRect(
    fb,
    r.x0 + PANEL_CLICK_ORIGIN_X,
    r.y0 + PANEL_CLICK_ORIGIN_Y,
    r.x1 + PANEL_CLICK_ORIGIN_X,
    r.y1 + PANEL_CLICK_ORIGIN_Y,
    color,
  );
}

/**
 * Click rectangles of the mine build menu, byte-exact from the original table. `action` 5–8 are the
 * building type enum values, `action` 9 is **build flag** (handler @0x2fe96 — the earlier reading
 * "cancel/back" is falsified by the binary). The complete build menu tables are in `build-popup.ts`.
 */
export const MINE_PANEL_HITBOXES: readonly HitRect[] = [
  { action: 5, x0: 16, x1: 48, y0: 8, y1: 72 },
  { action: 6, x0: 64, x1: 96, y0: 8, y1: 72 },
  { action: 7, x0: 32, x1: 64, y0: 77, y1: 141 },
  { action: 8, x0: 80, x1: 112, y0: 77, y1: 141 },
  { action: 9, x0: 10, x1: 26, y0: 114, y1: 134 },
];

/** Action id → meaning in the mine build menu. */
export const MINE_PANEL_ACTIONS: Readonly<Record<number, string>> = {
  5: 'stone mine',
  6: 'coal mine',
  7: 'iron mine',
  8: 'gold mine',
  9: 'build flag',
};

/** Draws a 1 px outline; bounds inclusive, clipped at the framebuffer edge. */
export function strokeRect(
  fb: Framebuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number],
): void {
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= fb.width || y >= fb.height) return;
    const o = (y * fb.width + x) * 4;
    fb.rgba[o] = color[0];
    fb.rgba[o + 1] = color[1];
    fb.rgba[o + 2] = color[2];
    fb.rgba[o + 3] = 255;
  };
  for (let x = x0; x <= x1; x++) {
    put(x, y0);
    put(x, y1);
  }
  for (let y = y0; y <= y1; y++) {
    put(x0, y);
    put(x1, y);
  }
}
