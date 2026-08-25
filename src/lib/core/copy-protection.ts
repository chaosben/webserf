/**
 * The copy protection - the screen after the opening credits: the manual symbol challenge with the
 * PROGRAMMINFO footer below it. PROGRAMMINFO is only that footer; the screen itself is the challenge.
 * Original: the body of `FUN_0000b155` behind the credits.
 *
 * The challenge is DISARMED in the shipped binary, at three byte-certain places:
 *
 * | Address | Bytes | Effect |
 * |---|---|---|
 * | @0xb82b | six `nop` right after `cmp %ax,0x14(%edi)` @0xb827 | exactly the width of a `jne rel32` - the failure branch is gone, any input is accepted |
 * | @0xb67e | `0a c0` + two `nop` | the result of the click bit test is discarded - the loop does not wait |
 * | @0xb695 / @0xb6a0 | constants instead of coordinates | no mouse is read |
 *
 * So the three rounds run through on cell 0 without pause, the result is compared and thrown away, and
 * the main menu replaces the screen within microseconds. In this edition it is unreachable - a
 * deliberate disarming by the publisher, not a defect.
 *
 * This module is therefore NOT wired up; it remains as a verified reading of the body. The port
 * reproduces the drawing exactly and runs the click round as the body would without the disarming, but
 * the evaluation stays that of the shipped binary: it does not happen.
 *
 * Four things a rebuild gets wrong:
 *
 * 1. The gap in the symbol grid IS the text field. Of 20 cells four are empty, and exactly there stand
 *    "SEITE nnn" and "OBEN"/"UNTEN" and the click round's echo symbols. Taking the gap for a data
 *    error means drawing 20 symbols and painting over the text.
 * 2. Two text origins on one screen: the four info lines run through the menu wrapper (`row + 0x18`),
 *    "SEITE"/"OBEN" through a third wrapper (`row + 0x20` like the credits, but menu colour).
 * 3. The symbol sprites are `solid`, not `transparent`.
 * 4. The screen runs on the GAME palette - the DAC upload lies before its first output, unlike the
 *    credits, which keep the intro palette.
 *
 * Deliberately not ported: `FUN_00004580` @0x4580, a one-off byte-swap fixup on an archive entry
 * unrelated to this screen (`// OPEN @0xb186`). And the answer table @0xb8db, because the shipped
 * binary does not evaluate it - a port would need it only to rebuild a check the original does not
 * perform (`// OPEN @0xb827`).
 */
import {
  MENU_ICON_BASE,
  MENU_TEXT_COLOR,
  drawMenuCommands,
  menuBackgroundTiles,
  menuBackgroundY,
  menuX,
  menuY,
  type MenuCommand,
  type MenuTarget,
} from './main-menu.js';
import { creditsX, creditsY } from './credits.js';
import { t, tAt, tOpaque } from './language.js';

// ─── Symbol grid ─────────────────────────────────────────────────────────────────────────────────

/**
 * Archive entry of the first symbol sprite. The draw table @0x4c46 holds DOS indices `0x2a..0x39`;
 * our entries are 0-based, so **41..56** (32 x 32 each, `solid`).
 */
export const COPY_PROTECTION_SYMBOL_BASE = 0x2a - 1;

/** One placement from the draw table `DAT_00004c46` (`{i16 sprite, i16 x, i16 y}`). */
export interface CopyProtectionSymbol {
  /** Archive entry, 0-based. */
  readonly entry: number;
  readonly x: number;
  readonly y: number;
}

/**
 * **The 16 symbols**, in the order of table @0x4c46 (terminated by a negative sprite value at
 * 0x4ca6 — the string "PROGRAMMINFO:" starts right behind it at 0x4ca8).
 *
 * `FUN_00004bfb` @0x4bfb draws them, walking the table entry by entry and calling
 * `blit_sprite_topleft` **without** an icon base — unlike the background tiles.
 */
export const COPY_PROTECTION_SYMBOLS: readonly CopyProtectionSymbol[] = [
  { entry: 0x2c - 1, x: 16, y: 44 },
  { entry: 0x30 - 1, x: 16, y: 76 },
  { entry: 0x34 - 1, x: 48, y: 44 },
  { entry: 0x38 - 1, x: 48, y: 76 },
  { entry: 0x2a - 1, x: 80, y: 44 },
  { entry: 0x2e - 1, x: 80, y: 76 },
  { entry: 0x32 - 1, x: 112, y: 76 },
  { entry: 0x36 - 1, x: 144, y: 76 },
  { entry: 0x2b - 1, x: 176, y: 76 },
  { entry: 0x2f - 1, x: 208, y: 76 },
  { entry: 0x33 - 1, x: 240, y: 44 },
  { entry: 0x37 - 1, x: 240, y: 76 },
  { entry: 0x2d - 1, x: 272, y: 44 },
  { entry: 0x31 - 1, x: 272, y: 76 },
  { entry: 0x35 - 1, x: 304, y: 44 },
  { entry: 0x39 - 1, x: 304, y: 76 },
];

/**
 * **Click cell to symbol id** (`DAT_0000b8b7`, reached via `gs+0x118`, 20 bytes).
 *
 * `null` stands for the original byte `0xff`: `js 0xb663` @0x6b703 discards such cells and waits for
 * a new click. They are exactly the four cells holding the text.
 */
export const COPY_PROTECTION_CELL_SYMBOL: readonly (number | null)[] = [
  0x0f, 0x0d, 0x04, null, null, null, null, 0x03, 0x09, 0x0a,
  0x0e, 0x0c, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x08, 0x0b,
];

/**
 * **Symbol id to sprite offset** (`DAT_0000b8cb`, via `gs+0x11c`, 16 bytes). The echo blit computes
 * `sprite = 0x2a + table[id]` (@0xb75b), i.e. `{@link COPY_PROTECTION_SYMBOL_BASE} + offset` in our
 * numbering.
 */
export const COPY_PROTECTION_SYMBOL_SPRITE: readonly number[] = [
  0x01, 0x05, 0x0d, 0x09, 0x00, 0x04, 0x08, 0x0c,
  0x07, 0x03, 0x0b, 0x0f, 0x0e, 0x0a, 0x06, 0x02,
];

/**
 * Geometry of the click grid, from the instruction stream: `subw $0x10` + `shrw $0x5` for the column
 * (@0xb6d9/@0xb6dd) with the bounds `js` at `< 0x10` and `jns` at `>= 0x150` (@0xb6cc/@0xb6d2), and
 * `subw $0x2c` (@0xb6a9) with the two bands `< 0x20` for row 0 and `< 0x40` for row 1
 * (@0xb6b6/@0xb6bd). The row base is **10**, not 1 (`vreg2 = 0` or `10`, then `+ column`).
 */
export const COPY_PROTECTION_GRID = {
  x: 0x10,
  y: 0x2c,
  cell: 32,
  cols: 10,
  rows: 2,
} as const;

/**
 * Click point to cell number 0..19, or `null` outside the grid.
 *
 * Both bounds are tested **signed**; the column bound `0x150` is therefore exclusive, and `x < 0x10`
 * drops out before the shift could go negative.
 */
export function copyProtectionCell(x: number, y: number): number | null {
  const dy = y - COPY_PROTECTION_GRID.y;
  if (dy < 0) return null;
  const row = dy < COPY_PROTECTION_GRID.cell ? 0 : dy < 2 * COPY_PROTECTION_GRID.cell ? 1 : null;
  if (row === null) return null;
  if (x < COPY_PROTECTION_GRID.x || x >= 0x150) return null;
  return row * COPY_PROTECTION_GRID.cols + ((x - COPY_PROTECTION_GRID.x) >> 5);
}

/** Cell number to symbol id, `null` for one of the four text cells. */
export function copyProtectionSymbolAt(cell: number): number | null {
  return COPY_PROTECTION_CELL_SYMBOL[cell] ?? null;
}

/** Symbol id to the archive entry of its sprite (0-based). */
export function copyProtectionSymbolEntry(symbol: number): number {
  return COPY_PROTECTION_SYMBOL_BASE + (COPY_PROTECTION_SYMBOL_SPRITE[symbol] ?? 0);
}

/** Position of the `i`-th echo symbol — `x = (i << 5) + 0x80` @0xb743, `y = 0x2a` @0xb753. */
export const copyProtectionEchoPos = (i: number): { x: number; y: number } => ({
  x: (i << 5) + 0x80,
  y: 0x2a,
});

/** How many symbols the challenge demands (`cmpw $0x3,0x18(%edi)` @0xb799). */
export const COPY_PROTECTION_CLICKS = 3;

// ─── Page number and half ────────────────────────────────────────────────────────────────────────

/** Address of the string template for the page line (@0xba6e) — the pointer @0xb2ae puts in `gs+0x124`. */
export const COPY_PROTECTION_PAGE_TEMPLATE_ADDR = 0xba6e;

/**
 * Which half of the manual page is meant. The two names are **ids**, not the drawn text: the
 * original assembles that from the blank template @0xba78 via an `addb` chain (`' OBEN '`/`' UNTEN'`,
 * English `' TOP  '`/`'BOTTOM'`, see `language.ts` `OPAQUE_TEXTS`). Drawing the id itself puts the
 * line one character off.
 */
export type CopyProtectionHalf = 'OBEN' | 'UNTEN';

/** The task: page number in the manual and which half. */
export interface CopyProtectionTask {
  /** 2..135 — exactly the range the answer table @0xb8db covers. */
  readonly page: number;
  readonly half: CopyProtectionHalf;
}

/**
 * **A random number becomes the task** (@0xb7b0 ff.).
 *
 * The original draws 100 rounds of `rng_next` from the clock seed, multiplies by `0x10c` and takes
 * the **upper** word (`mul` + register swap @0xb44a ff.):
 *
 * ```
 * r    = (rng * 0x10c) >> 16      // 0..267
 * page = (r >> 1) + 2             // 2..135
 * half = (r & 1) ? bottom : top   // `bt $0x0` @0xb7d9
 * ```
 *
 * The manual has 141 pages — the range 2..135 fits, and the answer table is **exactly** that long at
 * 134 · 3 = 402 bytes (it ends at 0xba6c, right before the page template @0xba6e).
 *
 * @param rng random word 0..65535 (in the original the result of the 100 rounds).
 */
export function copyProtectionTask(rng: number): CopyProtectionTask {
  const r = ((rng & 0xffff) * 0x10c) >>> 16;
  return { page: (r >> 1) + 2, half: (r & 1) === 0 ? 'OBEN' : 'UNTEN' };
}

/**
 * The page line as the original assembles it (@0xb4a4 ff.): six template characters, then at most
 * three digits **without** a leading zero — the hundreds digit is written only at >= 100, and the
 * tens digit is a space below 10.
 */
export function copyProtectionPageText(page: number): string {
  let rest = page;
  // The first six characters of the template @0xba6e; both language versions are 9 characters long
  // and leave exactly slots 6..8 for the three digits.
  let out = tAt(COPY_PROTECTION_PAGE_TEMPLATE_ADDR).slice(0, 6);
  let tens = ' ';
  if (rest > 99) {
    rest -= 100;
    out += '1';
    tens = '0';
  }
  if (rest > 9) {
    tens = '0';
    while (rest >= 10) {
      rest -= 10;
      tens = String.fromCharCode(tens.charCodeAt(0) + 1);
    }
  }
  return `${out}${tens}${String.fromCharCode(0x30 + rest)}`;
}

// ─── Footer ──────────────────────────────────────────────────────────────────────────────────────

/**
 * **The largest playable world size** (`gs+0x30c & 0xf`) — in the original **not** from the install,
 * but from free memory: `FUN_00002f69` @0x2f69 doubles `0x7130` bytes while it still fits, counting
 * 1..8. It caps the world-size "+" button in the main menu (@0x51583) and decides the two footer
 * lines of this screen.
 *
 * The browser has no such limit, so the port carries the value as a parameter defaulting to the
 * maximum.
 */
export const COPY_PROTECTION_MAX_WORLD = 8;

/** From this world size on the missions are available (`cmpw $0x3` + `jb` @0xb1fe). */
export const COPY_PROTECTION_MISSION_THRESHOLD = 3;

/** The four fixed strings of the screen, with their original address. */
export const COPY_PROTECTION_TEXTS = {
  /** @0x4d0a, drawn at (4, 1). */
  headline: 'BITTE KLICKEN SIE DIE SYMBOLE AN:',
  /** @0x4ca8, at (13, 100). */
  footer: 'PROGRAMMINFO:',
  /** @0x4cb6, at (2, 120) — when the world size is >= 3. */
  missionsOk: 'MISSIONEN: VERFUEGBAR',
  /** @0x4ccc, otherwise. */
  missionsShort: 'MISSIONEN: NICHT GENUG SPEICHERPLATZ',
  /** @0x4cf1, at (2, 130); byte 0x17 is overwritten with the digit (@0xb245). */
  world: 'SPIELWELT: BIS GROESSE  ',
} as const;

/**
 * The world-size line with the digit inserted — the original patches byte 0x17 of the template.
 *
 * The template arrives **translated**; both versions are 24 characters long, so the digit slot 0x17
 * holds unchanged. A `t()` on the result would be useless — the assembled line is in no table.
 */
export function copyProtectionWorldText(maxWorld: number): string {
  const tmpl = t(COPY_PROTECTION_TEXTS.world);
  return tmpl.slice(0, 0x17) + String.fromCharCode(0x30 + (maxWorld & 0xf)) + tmpl.slice(0x18);
}

// ─── Drawing ─────────────────────────────────────────────────────────────────────────────────────

/** What the screen needs in order to draw. */
export interface CopyProtectionView {
  readonly task: CopyProtectionTask;
  /** `gs+0x30c & 0xf` — see {@link COPY_PROTECTION_MAX_WORLD}. */
  readonly maxWorld?: number;
  /** The symbol ids clicked so far (0..3) for the echo row. */
  readonly picked?: readonly number[];
}

/**
 * The command list of the screen, in the original's order: background, symbols, the four info lines,
 * then the page and half lines, and finally the echo row.
 *
 * All `icon` commands carry **absolute** archive entries — the background tiles get their bank base
 * added here, because the original adds it in `FUN_0004f33b` and not in `FUN_00004bfb`. Hence
 * {@link drawCopyProtection} calls with `iconBase: 0`.
 */
export function copyProtectionCommands(view: CopyProtectionView): MenuCommand[] {
  const maxWorld = view.maxWorld ?? COPY_PROTECTION_MAX_WORLD;
  const out: MenuCommand[] = [];
  for (const t of menuBackgroundTiles()) {
    out.push({ kind: 'icon', icon: MENU_ICON_BASE + t.icon, x: menuX(t.col), y: menuBackgroundY(t.row) });
  }
  for (const s of COPY_PROTECTION_SYMBOLS) out.push({ kind: 'icon', icon: s.entry, x: s.x, y: s.y });

  const text = (col: number, row: number, s: string): void => {
    out.push({ kind: 'text', text: t(s), x: menuX(col), y: menuY(row) });
  };
  text(4, 1, COPY_PROTECTION_TEXTS.headline);
  text(13, 100, COPY_PROTECTION_TEXTS.footer);
  text(
    2,
    120,
    maxWorld >= COPY_PROTECTION_MISSION_THRESHOLD
      ? COPY_PROTECTION_TEXTS.missionsOk
      : COPY_PROTECTION_TEXTS.missionsShort,
  );
  text(2, 130, copyProtectionWorldText(maxWorld));

  // Second origin: the wrapper @0x37ae3 computes `row + 0x20`, like the opening credits.
  out.push({
    kind: 'text',
    text: copyProtectionPageText(view.task.page),
    x: creditsX(0x10),
    y: creditsY(0x0e),
  });
  out.push({
    kind: 'text',
    text: tOpaque(view.task.half === 'OBEN' ? 'manualUpper' : 'manualLower'),
    x: creditsX(0x11),
    y: creditsY(0x18),
  });

  (view.picked ?? []).forEach((symbol, i) => {
    const p = copyProtectionEchoPos(i);
    out.push({ kind: 'icon', icon: copyProtectionSymbolEntry(symbol), x: p.x, y: p.y });
  });
  return out;
}

/** Draws the screen through the same loop as menu and credits. */
export function drawCopyProtection(
  target: MenuTarget,
  view: CopyProtectionView,
  glyph: (ch: string) => number | undefined,
): void {
  drawMenuCommands(target, copyProtectionCommands(view), glyph, {
    iconBase: 0,
    textColor: MENU_TEXT_COLOR,
  });
}

// ─── Input ───────────────────────────────────────────────────────────────────────────────────────

/** State of the click round. */
export interface CopyProtectionState {
  readonly task: CopyProtectionTask;
  /** The symbol ids clicked so far, at most {@link COPY_PROTECTION_CLICKS}. */
  readonly picked: readonly number[];
}

/** Initial state from a random number. */
export function initialCopyProtectionState(rng: number): CopyProtectionState {
  return { task: copyProtectionTask(rng), picked: [] };
}

/** Result of one click. */
export interface CopyProtectionClickResult {
  readonly state: CopyProtectionState;
  /** `true` once the screen ends — in the original after the third valid click. */
  readonly done: boolean;
}

/**
 * One click on the screen.
 *
 * Original (@0xb663 ff., read without the disarming): a cell outside the grid and one of the four
 * text cells jump back to the loop head and change nothing; a valid click shifts the symbol id as a
 * nibble into the accumulator (`shlw $0x4` + `or` @0xb709) and blits the symbol into the echo row.
 * After the third click the comparison happens — and **its result is discarded** (the six NOPs
 * @0xb82b), so the screen ends in any case.
 *
 * The port reproduces exactly that: a click beside the grid is a **no-op**, and `done` reports only
 * "three ids collected".
 */
export function copyProtectionClick(
  state: CopyProtectionState,
  x: number,
  y: number,
): CopyProtectionClickResult {
  const cell = copyProtectionCell(x, y);
  const symbol = cell === null ? null : copyProtectionSymbolAt(cell);
  if (symbol === null) return { state, done: false };
  const picked = [...state.picked, symbol].slice(-COPY_PROTECTION_CLICKS);
  return { state: { ...state, picked }, done: picked.length >= COPY_PROTECTION_CLICKS };
}

/**
 * The numeric value the three clicks form — first click as the most significant nibble (`shlw $0x4`
 * **before** the `or`, @0xb709/@0xb711).
 *
 * It is only formed here, not checked: the answer table deliberately does not appear in the port
 * (`// OPEN @0xb827`, see module header).
 */
export function copyProtectionCode(picked: readonly number[]): number {
  return picked.reduce((acc, s) => ((acc << 4) | (s & 0xf)) & 0xfff, 0);
}
