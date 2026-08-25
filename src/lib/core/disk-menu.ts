/**
 * The disk menu - screens 0x17 / 0x18 / 0x19 / 0x1a. Renderers `FUN_0003ecec` / `FUN_0003ed81` /
 * `FUN_0003edef` / `FUN_0003f131`, click tables `@0x2cc50` and `@0x2cc92`, actions `@0x28539` /
 * `@0x2f8fc` / `@0x37134` / `@0x2fa06` / `@0x28479`.
 *
 * The four screens are one flow with two modes; which applies is decided by `gs+0x1c8` bit 2 - set
 * means save, clear means load ({@link DiskMenuState.saveMode}).
 *
 * The direction is established three times over, and that was necessary: two Ghidra symbol names
 * point the wrong way. `file_open_write` @0xa00 calls INT 21h/3Dh = OPEN existing (so loading),
 * `file_open_read` @0xa30 calls 3Ch = CREATE (so saving); likewise `0x46dfd` is the ARCHIV writer
 * and `0x46cda` the reader. Established through the INT number, the title string and the result
 * text.
 *
 * ## What is not obvious here
 *
 * 1. The input buffer *is* the ARCHIV entry. Action 79 sets `gs+0x23a` to `gs[0xd8] + slot*16`
 *    (@0x2f8fc) - the user types the index entry itself, and the occupied flag is 1 *before* the
 *    save. That is why this port keeps the 160 raw bytes ({@link DiskMenuState.archiv}) and not a
 *    list of names: only then is the input literally the same as in the original, and only then does
 *    the encoder hit the bytes.
 * 2. In load mode a click on a free slot is a bare `ret` (@0x46e78) - no error code, no result
 *    screen; the button sound has already played. A port that sets code 4 there invents an error.
 * 3. Zone 79 stays in the table without an icon in load mode - an invisible button. It is not inert
 *    because someone left it out but because the action itself tests bit 2. Taking the zone over
 *    without that gate lets a name be typed in load mode.
 * 4. The text of the slot list is opaque (`gs+0x1ca` bit 4, `bt $0x4` @0x37d05 *inside* the drawing
 *    loop): before every glyph a `fill_rect(8x8, colour 0)` runs. The slot names sit on black cells,
 *    not on the wooden ground.
 * 5. The apparent 8 px offset of the selection bar is none. The text wrapper computes `x = col*8 + 8`
 *    and `y = row + 9` internally; row `i` lands at surface `y = 29 + 10i`, and the bar
 *    `28 + 10i .. 37 + 10i` encloses the 8 px glyphs with one pixel of air each.
 * 6. A successful save resets three clocks (@0x28506/@0x28514/@0x28522) - the 60 s gate of the quit
 *    button and the two save reminders (message types 17/18).
 */

import { ARCHIV_SLOT_COUNT, ARCHIV_SLOT_SIZE, parseArchiv } from './archiv-parser.js';
import {
  TEXT_KEY_COMMIT,
  editTextBuffer,
  type TextBuffer,
} from './text-input.js';
import {
  UI_ICON_BASE,
  composeSmallPopup,
  drawLayout,
  drawPanelText,
  fillRect,
  hitTestPanel,
  smallPopupPoint,
  tileBackground,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';
import type { SaveSlot } from './types.js';
import { t } from './language.js';

// --- the four screens ---------------------------------------------------------------------------

/** Screen 0x17 - the archive-loading line, one frame, then on to {@link DISK_SCREEN_LIST}. */
export const DISK_SCREEN_ARCHIV = 0x17;
/** Screen 0x18 - the slot list with the entry step (`FUN_0003ed81`). */
export const DISK_SCREEN_LIST = 0x18;
/** Screen 0x19 - the same list without the entry step (`FUN_0003edef`, shared body `0x3ee71`). */
export const DISK_SCREEN_LIST_REDRAW = 0x19;
/** Screen 0x1a - the result window (`FUN_0003f131`). */
export const DISK_SCREEN_RESULT = 0x1a;

/** Background tile of the three normal screens (`draw_popup_background(0x136)`). */
export const DISK_BG_ICON = 0x136;
/** Background tile of the error result - a different frame (`0x13b` @0x3f1ac). */
export const DISK_BG_ICON_ERROR = 0x13b;

/** Title with bit 2 set (@0x3ee94) - 16 characters, so both titles are equally wide. */
export const DISK_TITLE_SAVE = 'SPIEL SPEICHERN:';
/** Title with bit 2 clear (@0x3eea5) - with four trailing spaces in the original. */
export const DISK_TITLE_LOAD = 'SPIEL LADEN:    ';
/** The single line of screen 0x17 (@0x3ed72). */
export const DISK_ARCHIV_LINE = 'LADE ARCHIV...';

/** Row of the title on all list screens (`vreg1 = 4`). */
export const DISK_TITLE_ROW = 4;
/** Row of the archive-loading line (`vreg1 = 0x14`). */
export const DISK_ARCHIV_ROW = 0x14;

// --- the slot list ------------------------------------------------------------------------------

/** Column of the ten name rows (`vreg0 = 1` in all ten calls). */
export const DISK_SLOT_COL = 1;
/** Row of the first slot (`vreg1 = 0x14`); each further one ten lower. */
export const DISK_SLOT_ROW0 = 0x14;
/** Row spacing of the slots - also the height of a click zone. */
export const DISK_SLOT_ROW_STEP = 10;

/**
 * The selection bar: `fill_rect(x = 0xf, y = slot*10 + 0x1c, w = 0x72, h = 10, colour 0x4c)`
 * (@0x3eecc ff.). The coordinates are surface pixels, not col/row - hence `15` and not `panelX(1)`.
 */
export const DISK_SLOT_BAR = { x: 0xf, y0: 0x1c, dy: 10, w: 0x72, h: 10 } as const;
/** Palette index of the bar (`vreg4 = 0x4c`). */
export const DISK_SLOT_BAR_COLOR_INDEX = 0x4c;

/**
 * Icon layout of the list in save mode (`0x3ee72`). Format `{u16 sprite, u16 col, u16 y}`,
 * terminator `ffff`; drawn by the interpreter `draw_popup_icon_layout` @0x41fe0, which calls
 * `draw_panel_icon` - so the icon bank, not the object bank.
 *
 * The three rectangles of the zone table lie exactly under these icons (`col*8 == x0`, `y == y0`).
 */
export const DISK_LAYOUT_SAVE: readonly LayoutItem[] = [
  { icon: 0x3c, col: 14, row: 0x80 },
  { icon: 0xdf, col: 5, row: 0x80 },
  { icon: 0xe0, col: 0, row: 0x80 },
];
/** Icon layout of the list in load mode (`0x3ee86`) - without the name button. */
export const DISK_LAYOUT_LOAD: readonly LayoutItem[] = [
  { icon: 0x3c, col: 14, row: 0x80 },
  { icon: 0xe1, col: 0, row: 0x80 },
];
/** Icon layout of the result window (`0x3f36e`) - one row, only the exit button. */
export const DISK_LAYOUT_RESULT: readonly LayoutItem[] = [{ icon: 0x3c, col: 14, row: 0x80 }];

// --- actions and click zones ----------------------------------------------------------------

/** Exit from the list (`@0x28539`). */
export const DISK_ACTION_CLOSE = 78;
/** Type a name (`@0x2f8fc`) - effective only in save mode. */
export const DISK_ACTION_NAME = 79;
/** Execute (`@0x37134`) - the disk operation. */
export const DISK_ACTION_RUN = 80;
/** Select slot 0 (`@0x2fa06`); slot `i` is `DISK_ACTION_SLOT0 + i`. */
export const DISK_ACTION_SLOT0 = 81;
/** Exit from the result window (`@0x28479`). */
export const DISK_ACTION_RESULT_CLOSE = 91;

/**
 * Click zones of the list (`@0x2cc50`, 13 entries of 5 bytes `[action, x0, x1, y0, y1]`, bounds
 * inclusive, `0xff`-terminated). The ten slot rows sit at `y0 = 20 + 10i` - exactly the rows the
 * renderer writes.
 */
export const DISK_HITBOXES_LIST: readonly HitRect[] = [
  { action: DISK_ACTION_CLOSE, x0: 112, x1: 127, y0: 128, y1: 143 },
  { action: DISK_ACTION_NAME, x0: 40, x1: 71, y0: 128, y1: 143 },
  { action: DISK_ACTION_RUN, x0: 0, x1: 31, y0: 128, y1: 143 },
  ...Array.from({ length: ARCHIV_SLOT_COUNT }, (_, i) => ({
    action: DISK_ACTION_SLOT0 + i,
    x0: 8,
    x1: 119,
    y0: 20 + 10 * i,
    y1: 29 + 10 * i,
  })),
];

/** Click zone of the result window (`@0x2cc92`) - one, and it coincides with the single icon. */
export const DISK_HITBOXES_RESULT: readonly HitRect[] = [
  { action: DISK_ACTION_RESULT_CLOSE, x0: 112, x1: 127, y0: 128, y1: 143 },
];

// --- the eight result codes -------------------------------------------------------------------

/**
 * `gs+0x240` - the result of the disk operation. The split comes from the exit, not from a guessed
 * table: action 91 compares against exactly `{1, 4, 6, 7}` (@0x28498 ff.) - the four load results;
 * `{0, 2, 3, 5}` are the four save results.
 */
export const DISK_RESULT = {
  /** save, success (`xor %ax,%ax` @0x372ef). */
  saved: 0,
  /** load, success (@0x46f20). */
  loaded: 1,
  /** save: `ARCHIV.DS` cannot be created (@0x37269). */
  archivFailed: 2,
  /** save: file cannot be created (@0x372aa). */
  createFailed: 3,
  /** load: file cannot be opened (@0x46fb9, `else` branch @0x46ec0). */
  openFailed: 4,
  /** save: write error (@0x372fe). */
  writeFailed: 5,
  /** load: read error (@0x46fcd). */
  readFailed: 6,
  /** load: header rejected - the second error path (`jne` @0x46ede, not `js`). */
  headerRejected: 7,
} as const;

/** From this code on the result window uses the error frame (`cmpw $0x2 ; jb` @0x3f131). */
export const DISK_RESULT_ERROR_THRESHOLD = 2;

/**
 * The text lines of the result window per code. Success (0/1) carries three lines, an error two -
 * except code 6, which has only one (the original has no second call there, @0x3f2f5).
 */
export const DISK_RESULT_LINES: ReadonlyMap<number, readonly { text: string; row: number }[]> =
  new Map([
    [
      DISK_RESULT.saved,
      [
        { text: 'DISKMELDUNG:', row: 10 },
        { text: 'SPIELSTAND', row: 0x1e },
        { text: 'GESPEICHERT.', row: 0x28 },
      ],
    ],
    [
      DISK_RESULT.loaded,
      [
        { text: 'DISKMELDUNG:', row: 10 },
        { text: 'SPIELSTAND', row: 0x1e },
        { text: 'GELADEN.', row: 0x28 },
      ],
    ],
    [
      DISK_RESULT.archivFailed,
      [
        { text: 'FEHLERMELDUNG:', row: 0x1e },
        { text: 'KANN KEIN ARCHIV', row: 0x28 },
        { text: 'ANLEGEN.', row: 0x32 },
      ],
    ],
    [
      DISK_RESULT.createFailed,
      [
        { text: 'FEHLERMELDUNG:', row: 0x1e },
        { text: 'KANN DATEI NICHT', row: 0x28 },
        { text: 'OEFFNEN.', row: 0x32 },
      ],
    ],
    [
      DISK_RESULT.openFailed,
      [
        { text: 'FEHLERMELDUNG:', row: 0x1e },
        { text: 'KANN DATEI NICHT', row: 0x28 },
        { text: 'OEFFNEN.', row: 0x32 },
      ],
    ],
    [
      DISK_RESULT.writeFailed,
      [
        { text: 'FEHLERMELDUNG:', row: 0x1e },
        { text: 'DISK VOLL ODER', row: 0x28 },
        { text: 'SCHREIBFEHLER.', row: 0x32 },
      ],
    ],
    [
      DISK_RESULT.readFailed,
      [
        { text: 'FEHLERMELDUNG:', row: 0x1e },
        { text: 'LESEFEHLER.', row: 0x28 },
      ],
    ],
    [
      DISK_RESULT.headerRejected,
      [
        { text: 'FEHLERMELDUNG:', row: 0x1e },
        { text: 'KONFIGURATION', row: 0x28 },
        { text: 'UNZULAESSIG.', row: 0x32 },
      ],
    ],
  ]);

/** Is this code a **load** result? (`{1, 4, 6, 7}`, @0x28498/@0x284a5/@0x284b2/@0x284bf) */
export function isLoadResult(code: number): boolean {
  return code === 1 || code === 4 || code === 6 || code === 7;
}

// ─── State ──────────────────────────────────────────────────────────────────────────────────────

/** No slot selected (`gs+0x1f8 = 0xffff` @0x3edb8, test `-1 < sVar2`). */
export const DISK_NO_SLOT = -1;

/**
 * Four original fields plus the buffer they point into: `gs+0x1c8` bit 2, `gs+0x1f8`, `gs+0x240`,
 * `gs+0x1ca` bit 0 / `gs+0x238`, and `gs+0xd8`.
 */
export interface DiskMenuState {
  /** `gs+0x1c8` bit 2 — set means save. */
  readonly saveMode: boolean;
  /** `gs+0xd8` — the 160 bytes of the `ARCHIV.DS` index itself. */
  readonly archiv: Uint8Array;
  /** `gs+0x1f8` — selected slot, {@link DISK_NO_SLOT} means none. */
  readonly selectedSlot: number;
  /** `gs+0x240` — result of the last operation. */
  readonly result: number;
  /** The running name entry (`gs+0x1ca` bit 0 == `nameInput !== null`). */
  readonly nameInput: TextBuffer | null;
}

/** Name length of a slot (`gs+0x23e = 0xe` @0x2f9d3) — the same 14 bytes as in the index. */
export const DISK_NAME_LENGTH = 0xe;

/**
 * Default name a still free slot gets when **saving** (14 individually written bytes from @0x371b6,
 * then `0xff` and `0x01`). It arises **only** there — name entry blanks the name to spaces instead.
 */
export const DISK_DEFAULT_NAME = ' KEIN NAME    ';

/** Entering the disk menu (screen 0x18, `FUN_0003ed81`): reset selection and entry. */
export function enterDiskMenu(archiv: Uint8Array, saveMode: boolean): DiskMenuState {
  return {
    saveMode,
    archiv: new Uint8Array(archiv),
    selectedSlot: DISK_NO_SLOT,
    result: DISK_RESULT.saved,
    nameInput: null,
  };
}

/** The ten slots as the renderer sees them, derived from {@link DiskMenuState.archiv}. */
export function diskMenuSlots(s: DiskMenuState): SaveSlot[] {
  return parseArchiv(s.archiv);
}

/** A slot's 14 name bytes as a string, **untrimmed** — that is how the original draws it. */
export function diskSlotLine(archiv: Uint8Array, slot: number): string {
  const at = slot * ARCHIV_SLOT_SIZE;
  let out = '';
  for (let j = 0; j < DISK_NAME_LENGTH; j++) {
    const b = archiv[at + j] ?? 0x20;
    out += b === 0 ? ' ' : String.fromCharCode(b);
  }
  return out;
}

/** Occupied flag of a slot (`p[0xf]`, @0x37196 and @0x46e73). */
export const diskSlotUsed = (archiv: Uint8Array, slot: number): boolean =>
  (archiv[slot * ARCHIV_SLOT_SIZE + 15] ?? 0) !== 0;

// ─── Drawing ────────────────────────────────────────────────────────────────────────────────────

/** The title per mode. */
export const diskTitle = (saveMode: boolean): string =>
  saveMode ? DISK_TITLE_SAVE : DISK_TITLE_LOAD;

/** Screen 0x17 (`FUN_0003ecec`) — one frame; the caller then advances to 0x18 (`@0x3ed6a`). */
export function drawDiskArchivScreen(
  fb: Framebuffer,
  provider: SpriteProvider,
  saveMode: boolean,
  textColor: readonly [number, number, number],
): void {
  tileBackground(fb, provider, DISK_BG_ICON);
  drawPanelText(fb, provider, t(diskTitle(saveMode)), 0, DISK_TITLE_ROW, textColor);
  drawPanelText(fb, provider, t(DISK_ARCHIV_LINE), 0, DISK_ARCHIV_ROW, textColor);
}

/**
 * The slot list (`FUN_0003eeb6`) — selection bar, then ten **opaque** name rows.
 *
 * `barColor` comes from the caller out of the archive palette (index
 * {@link DISK_SLOT_BAR_COLOR_INDEX}); without a palette the bar stays undrawn rather than inventing
 * a colour — same approach as the slider.
 */
export function drawDiskSlotList(
  fb: Framebuffer,
  provider: SpriteProvider,
  s: DiskMenuState,
  textColor: readonly [number, number, number],
  barColor: readonly [number, number, number] | null,
): void {
  if (s.selectedSlot >= 0 && barColor) {
    fillRect(
      fb,
      DISK_SLOT_BAR.x,
      DISK_SLOT_BAR.y0 + s.selectedSlot * DISK_SLOT_BAR.dy,
      DISK_SLOT_BAR.w,
      DISK_SLOT_BAR.h,
      barColor,
    );
  }
  for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
    drawPanelText(
      fb,
      provider,
      diskSlotLine(s.archiv, i),
      DISK_SLOT_COL,
      DISK_SLOT_ROW0 + i * DISK_SLOT_ROW_STEP,
      textColor,
      true, // `gs+0x1ca |= 0x10` @0x3eef7 … `&= 0xef` @0x3f11c — opaque text
    );
  }
}

/** Screens 0x18 / 0x19 — the shared body (`0x3ee71`). */
export function drawDiskList(
  fb: Framebuffer,
  provider: SpriteProvider,
  s: DiskMenuState,
  textColor: readonly [number, number, number],
  barColor: readonly [number, number, number] | null,
): void {
  tileBackground(fb, provider, DISK_BG_ICON);
  drawPanelText(fb, provider, t(diskTitle(s.saveMode)), 0, DISK_TITLE_ROW, textColor);
  drawDiskSlotList(fb, provider, s, textColor, barColor);
  drawLayout(fb, provider, s.saveMode ? DISK_LAYOUT_SAVE : DISK_LAYOUT_LOAD, UI_ICON_BASE);
}

/** Screen 0x1a (`FUN_0003f131`) — the result. */
export function drawDiskResult(
  fb: Framebuffer,
  provider: SpriteProvider,
  result: number,
  textColor: readonly [number, number, number],
): void {
  const error = result >= DISK_RESULT_ERROR_THRESHOLD;
  tileBackground(fb, provider, error ? DISK_BG_ICON_ERROR : DISK_BG_ICON);
  // OPEN @0x3f31f — a code >= 8 falls through the last comparison onto the shared tail `0x3f35f`
  // and draws only the error frame with its heading. Unreachable here (the eight codes are the only
  // written values), but modelled anyway.
  for (const l of DISK_RESULT_LINES.get(result) ?? [{ text: 'FEHLERMELDUNG:', row: 0x1e }]) {
    drawPanelText(fb, provider, t(l.text), 0, l.row, textColor);
  }
  drawLayout(fb, provider, DISK_LAYOUT_RESULT, UI_ICON_BASE);
}

/** The four screen numbers of the disk menu, in the order they run. */
export const DISK_SCREENS: readonly number[] = [
  DISK_SCREEN_ARCHIV,
  DISK_SCREEN_LIST,
  DISK_SCREEN_LIST_REDRAW,
  DISK_SCREEN_RESULT,
];

/**
 * **The renderer dispatch** — counterpart of the table `@0x37fb9 + (screen−1)·8`. `false` means
 * "not a disk screen"; the caller then drew nothing.
 *
 * Screens 0x18 and 0x19 share **one** body because in the original they are two entries into one
 * routine (common exit `0x3ee71`). What differs — entering, reading the index, clearing the
 * selection — is state work and lives in {@link enterDiskMenu}, not in drawing.
 */
export function drawDiskScreen(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  s: DiskMenuState,
  textColor: readonly [number, number, number],
  barColor: readonly [number, number, number] | null,
): boolean {
  if (screen === DISK_SCREEN_ARCHIV) {
    drawDiskArchivScreen(fb, provider, s.saveMode, textColor);
    return true;
  }
  if (screen === DISK_SCREEN_LIST || screen === DISK_SCREEN_LIST_REDRAW) {
    drawDiskList(fb, provider, s, textColor, barColor);
    return true;
  }
  if (screen === DISK_SCREEN_RESULT) {
    drawDiskResult(fb, provider, s.result, textColor);
    return true;
  }
  return false;
}

/** The same dispatch as a popup over the 352 x 240 **menu area** (main menu, "LOAD"). */
export function drawDiskMenuPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  s: DiskMenuState,
  textColor: readonly [number, number, number],
  barColor: readonly [number, number, number] | null,
): boolean {
  return composeSmallPopup(fb, provider, (pop) =>
    drawDiskScreen(pop, provider, screen, s, textColor, barColor),
  );
}

// ─── Input ──────────────────────────────────────────────────────────────────────────────────────

/**
 * **The click dispatch** — `vp[0x72]·8` from `0x2c09e`. Screen 0x17 has a bare `ret` there
 * (`0x2c3e7`): it takes **no** input, which is why it only stands for one frame.
 */
export function clickDiskScreen(screen: number, drawX: number, drawY: number): number | null {
  if (screen === DISK_SCREEN_LIST || screen === DISK_SCREEN_LIST_REDRAW)
    return clickDiskList(drawX, drawY);
  if (screen === DISK_SCREEN_RESULT) return clickDiskResult(drawX, drawY);
  return null;
}

/** The same click, but in pixels of the **menu area** (main menu). */
export function clickDiskMenuPopup(screen: number, sx: number, sy: number): number | null {
  const p = smallPopupPoint(sx, sy);
  return clickDiskScreen(screen, p.x, p.y);
}

/** Click on the slot list (screens 0x18/0x19) to an action id. */
export const clickDiskList = (drawX: number, drawY: number): number | null =>
  hitTestPanel(DISK_HITBOXES_LIST, drawX, drawY);

/** Click on the result window (screen 0x1a) to an action id. */
export const clickDiskResult = (drawX: number, drawY: number): number | null =>
  hitTestPanel(DISK_HITBOXES_RESULT, drawX, drawY);

/**
 * What the caller must do after an action. The storage layer is **asynchronous** in the browser
 * where the original makes synchronous DOS calls — hence the operation itself is a *request*
 * ({@link DiskMenuEffect.kind} `'perform'`), while codes and state transitions stay here.
 */
export type DiskMenuEffect =
  /** Nothing to do — every early-return branch of the original. */
  | { readonly kind: 'none' }
  /** Redraw the screen (`vp[0x70] = 0x19`). */
  | { readonly kind: 'redraw' }
  /** Perform the operation, then call {@link completeDiskOperation} with the result code. */
  | { readonly kind: 'perform'; readonly save: boolean; readonly slot: number }
  /** Exit button in save mode: back into the game (@0x28592). */
  | { readonly kind: 'exitToGame' }
  /** Exit button in load mode: back to the main menu (`vp[0x1b8] = 1`, @0x2856c). */
  | { readonly kind: 'exitToMenu' }
  /** The loaded game is entered (`FUN_0004f179`, @0x284dd/@0x2848f). */
  | { readonly kind: 'enterLoadedGame' };

export interface DiskMenuResult {
  readonly state: DiskMenuState;
  readonly effect: DiskMenuEffect;
  /**
   * The zone walker plays sound 8 (`mov $0x8` @0x2cd3b) on **every** hit, before the action runs —
   * even when the action does nothing. Hence it lives here and not inside a branch.
   */
  readonly sound: number;
}

/** Sound "control hit" (`mov $0x8` @0x2cd3b in the zone walker). */
export const DISK_SOUND_BUTTON = 8;

/**
 * Run an action of the list or the result window. The action numbers of the two zone tables are
 * disjoint (78..90 against 91), so no per-table dispatch is needed — just as in the original, where
 * both point at the same action table `@0x2cd66`.
 */
export function applyDiskMenuAction(s: DiskMenuState, action: number): DiskMenuResult {
  const hit = (effect: DiskMenuEffect, state: DiskMenuState = s): DiskMenuResult => ({
    state,
    effect,
    sound: DISK_SOUND_BUTTON,
  });

  // Action 81..90 — select a slot (ten byte-identical copies from `@0x2fa06`, one function here).
  const slot = action - DISK_ACTION_SLOT0;
  if (slot >= 0 && slot < ARCHIV_SLOT_COUNT) {
    // `bt $0x0` @0x2fa11 — while typing, the list does not react.
    if (s.nameInput !== null) return hit({ kind: 'none' });
    return hit({ kind: 'redraw' }, { ...s, selectedSlot: slot });
  }

  switch (action) {
    case DISK_ACTION_NAME:
      return hit(...applyDiskNameAction(s));
    case DISK_ACTION_RUN:
      return hit(...beginDiskOperation(s));
    case DISK_ACTION_CLOSE:
      // @0x28539: resume the clock, then branch on the **same bit 2** that picks the mode.
      return hit(
        { kind: s.saveMode ? 'exitToGame' : 'exitToMenu' },
        s.saveMode ? { ...s, nameInput: null } : s,
      );
    case DISK_ACTION_RESULT_CLOSE:
      // @0x28479: a **load** code enters the loaded game, anything else returns to the game.
      return hit({ kind: isLoadResult(s.result) ? 'enterLoadedGame' : 'exitToGame' });
    default:
      return { state: s, effect: { kind: 'none' }, sound: DISK_SOUND_BUTTON };
  }
}

/**
 * Action 79 `FUN_0002f8fc` — name entry. **Three** gates, all needed: save mode, a selected slot,
 * and no entry already running. It blanks the 14 name bytes to spaces and sets the occupied flag to
 * 1 **before** saving (@0x2f9c8/@0x2f9ce).
 */
function applyDiskNameAction(s: DiskMenuState): [DiskMenuEffect, DiskMenuState] {
  if (!s.saveMode || s.selectedSlot < 0 || s.nameInput !== null) return [{ kind: 'none' }, s];
  const archiv = new Uint8Array(s.archiv);
  const at = s.selectedSlot * ARCHIV_SLOT_SIZE;
  archiv.fill(0x20, at, at + DISK_NAME_LENGTH);
  archiv[at + 14] = 0xff;
  archiv[at + 15] = 1;
  return [
    { kind: 'redraw' },
    { ...s, archiv, nameInput: { text: ' '.repeat(DISK_NAME_LENGTH), cursor: 0 } },
  ];
}

/**
 * Action 80 `FUN_00037134` — the disk operation, **without** the I/O itself.
 *
 * Two early-return branches a port easily loses: `slot < 0` (@0x37144) and — **in load mode only** —
 * a still free slot (`@0x46e78`, bare `ret`: no code, no display).
 */
export function beginDiskOperation(s: DiskMenuState): [DiskMenuEffect, DiskMenuState] {
  if (s.selectedSlot < 0) return [{ kind: 'none' }, s];
  const slot = s.selectedSlot;
  if (!s.saveMode) {
    if (!diskSlotUsed(s.archiv, slot)) return [{ kind: 'none' }, s]; // @0x46e78
    return [{ kind: 'perform', save: false, slot }, s];
  }
  // Saving: end the entry (@0x37165), and a free slot gets the default name.
  let archiv = s.archiv;
  if (!diskSlotUsed(archiv, slot)) {
    archiv = new Uint8Array(archiv);
    const at = slot * ARCHIV_SLOT_SIZE;
    for (let j = 0; j < DISK_NAME_LENGTH; j++) archiv[at + j] = DISK_DEFAULT_NAME.charCodeAt(j);
    archiv[at + 14] = 0xff;
    archiv[at + 15] = 1;
  }
  return [{ kind: 'perform', save: true, slot }, { ...s, archiv, nameInput: null }];
}

/**
 * Take over the result of an operation (`gs+0x240 = code`). The caller then shows
 * {@link DISK_SCREEN_RESULT} — in the original the operation itself sets that (@0x37173/@0x46e7b)
 * before it touches the file.
 */
export function completeDiskOperation(s: DiskMenuState, code: number): DiskMenuState {
  return { ...s, result: code };
}

/**
 * **The three clocks a successful save resets** (@0x28506/@0x28514/@0x28522, in the exit of the
 * result window and only for code 0). Byte for byte the same three that main-menu action A40 sets
 * (`main-menu.MENU_RESUME_CLOCKS`).
 */
export const DISK_SAVE_CLOCKS = {
  /** `gs+0x186` — 6000 ticks (60 s): gate of the quit button. */
  quitGrace: 0x1770,
  /** `gs+0x17e` — 180000 ticks (30 min) until message 17. */
  saveReminder30: 0x2bf20,
  /** `gs+0x182` — 360000 ticks (60 min) until message 18. */
  saveReminder60: 0x57e40,
} as const;

/** Does a successful save reset the clocks? (`or %ax,%ax ; jne 0x28530` @0x28501) */
export const diskSaveResetsClocks = (code: number): boolean => code === DISK_RESULT.saved;

// ─── Name entry ─────────────────────────────────────────────────────────────────────────────────

/**
 * Feed a character into the name entry — the **shared** primitive from `core/text-input.ts` (in the
 * original it is the same routine the main menu uses).
 *
 * What differs is **where** the buffer writes: `gs+0x23a` points straight into the slot's archive
 * entry, so every keystroke writes the index too. On commit (`0xff`) the original clears only bit 0
 * — the typed name **stays**.
 */
export function applyDiskMenuKey(s: DiskMenuState, key: number): DiskMenuState {
  const entry = s.nameInput;
  if (entry === null) return s;
  if (key === TEXT_KEY_COMMIT) return { ...s, nameInput: null };
  const next = editTextBuffer(entry, key);
  if (next === null) return s;
  const archiv = new Uint8Array(s.archiv);
  const at = s.selectedSlot * ARCHIV_SLOT_SIZE;
  for (let j = 0; j < DISK_NAME_LENGTH; j++) archiv[at + j] = next.text.charCodeAt(j) & 0xff;
  return { ...s, archiv, nameInput: next };
}
