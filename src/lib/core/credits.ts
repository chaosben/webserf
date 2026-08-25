/**
 * **The intro before the main menu** — the credits sequence the original shows after program start,
 * before it goes to the menu.
 *
 * Original: `FUN_000045f8` @0x45f8, called from the screen setup `FUN_0000b155` @0xb155, and that in
 * turn exactly once — from the **program start** @0x4093. The re-entry @0x409d jumps past it, so the
 * intro runs only the first time:
 *
 * ```
 * 407a: call 0x718a ; screen frame    the same pair as for the main menu
 * 407f: call 0x6e50 ; control panel
 * 4089: call 0xb154 ; 1 byte: ret
 * 4093: call 0xb155 ; <- music + THIS sequence
 * 4098: jmp 0x4dac ; roll the map seed
 * 409d: call 0x40a7 ; <- re-entry: jumps past both
 * ```
 *
 * **Four things are not obvious here:**
 *
 * **1. A palette of its own.** The intro runs on the in-archive palette **3997**, not on the game
 * palette 2 that draws the main menu and all the remaining UI (see {@link CREDITS_PALETTE_ENTRY}).
 * That is established at the pixel and is not a derivation — and it does **not** show on plain
 * inspection, because frame and panel look identical under both palettes.
 *
 * **2. Every step redraws the background.** All ten blocks begin with `call 0x46f9`, so the text does
 * not accumulate; each step replaces the previous one.
 *
 * **3. The last text block stands twice as long.** After "SPIELETESTER" the instruction stream has
 * **two** wait calls in a row (@0x4696 and @0x469d) with no drawing in between — see
 * {@link creditsStepTicks}.
 *
 * **4. Only the LEFT mouse button aborts.** The wait routine reads `0x1f56` and aborts on **0**; the
 * three mouse buttons sit **inverted** at `0x1f56`/`0x1f58`/`0x1f5a` (`0` = pressed, `0xffff` = free —
 * the bit cascade @0x659ea...@0x65a17, initialised @0x65c2c). The right button is loaded along
 * (`vreg3`) but **not** tested.
 *
 * The drawing path is the same as in the menu: the same font loop `draw_font_string` @0x37cda, only a
 * third wrapper in front of it. Hence this module yields {@link MenuCommand}s and draws via
 * `drawMenuCommands` — a second copy of the shadow logic would drift.
 */
import { drawMenuCommands, type MenuCommand, type MenuTarget } from './main-menu.js';
import { t } from './language.js';

/**
 * **The intro's in-archive palette** — entry 3997 (shown in the UI as "archive #3998 (intro)").
 *
 * Decided at the pixel, not derived: in two original captures the background sprite
 * {@link CREDITS_BG_ENTRY} matches **16640 of 16640** pixels exactly under this palette, only 3963
 * (23.8 %) under game palette 2 and **not a single one** under art palette 3996.
 *
 * **Why this is easy to miss:** the wooden frame (sprite 599) matches 100 % under palette 2 **and**
 * 3997. An intro in the wrong palette would have correct chrome and a wrong picture — "looks right" is
 * no evidence here.
 */
export const CREDITS_PALETTE_ENTRY = 3997;

/**
 * Background image (320 x 192) at the corner of the menu area — `FUN_000046f9` @0x46f9 sets
 * `vreg0 = 0x10`, `vreg1 = 8`, `vreg2 = 0x28` and calls `blit_sprite_topleft`.
 *
 * `0x28` is the **DOS** index; our entries are 0-based (`dos_index = ours + 1`), hence entry 39. The
 * dimensions 320 x 192 are exactly `MENU_AREA`.
 */
export const CREDITS_BG_ENTRY = 0x28 - 1;

/** Position of the background image — `(0x10, 8)`, the same corner as `MENU_AREA`. */
export const CREDITS_BG_POS = { x: 0x10, y: 8 } as const;

/** Publisher logo card (64 x 96) — `vreg2 = 0x29` in `FUN_00004722` @0x4722, i.e. entry 40. */
export const CREDITS_LOGO_ENTRY = 0x29 - 1;

/** Position of the logo card — `mov $0x90,%ax` / `vreg1 = 0x38` @0x4722, i.e. (144, 56). */
export const CREDITS_LOGO_POS = { x: 0x90, y: 0x38 } as const;

/**
 * Text colour of the intro — palette index **47**, set in `FUN_00037b48` @0x37b48
 * (`ctx->vreg4 = 0x2f`), the third wrapper of the font loop.
 *
 * **Not** the menu's `0x1f`: under palette {@link CREDITS_PALETTE_ENTRY} 0x2f is white and 0x1f green.
 * (Under the game palette it would be the other way round — one more reason to look at both together.)
 */
export const CREDITS_TEXT_COLOR = 0x2f;

/**
 * Origin of the text grid — `x = col*8 + 0x10`, `y = row + 0x20` (`shl $3` + `add $0x10` resp.
 * `add $0x20` in `FUN_00037b48`).
 *
 * That distinguishes it from the two known wrappers of the same loop: the menu computes `row + 0x18`,
 * the game panel `col*8 + 8` / `row + 9`. The column is an **eighth** column, the row a **pixel**
 * value — the same asymmetry as in the menu.
 */
export const CREDITS_ORIGIN = { x: 0x10, y: 0x20 } as const;

/** Eighth column to surface pixel. */
export const creditsX = (col: number): number => col * 8 + CREDITS_ORIGIN.x;

/** Pixel row to surface pixel. */
export const creditsY = (row: number): number => row + CREDITS_ORIGIN.y;

/** One text line of an intro step. */
export interface CreditsLine {
  /** Eighth column (`vreg0` before the `call 0x37b48`). */
  readonly col: number;
  /** Pixel row (`vreg1`). */
  readonly row: number;
  readonly text: string;
}

/** One step of the sequence — a full picture that stands for {@link creditsStepTicks} ticks. */
export interface CreditsStep {
  /** Address of the original routine — the join key for the guard. */
  readonly addr: number;
  /** Additionally shows the publisher logo card (the first step only). */
  readonly logo?: true;
  readonly lines: readonly CreditsLine[];
}

/**
 * **The ten steps**, in the order of the `call` chain in `FUN_000045f8` @0x45f8.
 *
 * They stand as **data** rather than ten functions so the guard can hold address, column, row and
 * string of every line against the instruction stream. With 25 lines a hand-written comparison would
 * not be one.
 *
 * The last step has no lines — `FUN_00004a8a` @0x4a8a consists of exactly `call 0x46f9 ; ret` and thus
 * shows the bare landscape.
 */
export const CREDITS_STEPS: readonly CreditsStep[] = [
  { addr: 0x4722, logo: true, lines: [] },
  {
    addr: 0x4750,
    lines: [
      { col: 4, row: 10, text: 'PROGRAMM UND IDEE:' },
      { col: 4, row: 19, text: 'VOLKER WERTICH' },
      { col: 4, row: 28, text: 'ALEXANDER JORIAS' },
      { col: 4, row: 37, text: 'INGO FRICK' },
    ],
  },
  {
    addr: 0x47d2,
    lines: [
      { col: 20, row: 20, text: 'GRAFIK:' },
      { col: 20, row: 29, text: 'CHRISTOPH WERNER' },
    ],
  },
  {
    addr: 0x4816,
    lines: [
      { col: 4, row: 30, text: 'MUSIK UND' },
      { col: 4, row: 39, text: 'SOUNDEFFEKTE:' },
      { col: 4, row: 48, text: 'HAIKO RUTTMANN' },
    ],
  },
  {
    addr: 0x4879,
    lines: [
      { col: 20, row: 50, text: 'ONGAME-MUSIK AMIGA:' },
      { col: 20, row: 59, text: 'MARKUS KLUDZUWEIT' },
    ],
  },
  {
    addr: 0x48bd,
    lines: [
      { col: 4, row: 60, text: 'PRODUZENT:' },
      { col: 4, row: 69, text: 'THOMAS HERTZLER' },
    ],
  },
  {
    addr: 0x4901,
    lines: [
      { col: 20, row: 80, text: 'ANLEITUNG:' },
      { col: 20, row: 89, text: 'VOLKER WERTICH UND' },
      { col: 20, row: 98, text: 'STEFAN PIASECKI' },
    ],
  },
  {
    addr: 0x4964,
    lines: [
      { col: 4, row: 90, text: 'INTRO:' },
      { col: 4, row: 99, text: 'INGO FRICK' },
    ],
  },
  {
    addr: 0x49a8,
    lines: [
      { col: 20, row: 100, text: 'SPIELETESTER:' },
      { col: 20, row: 109, text: 'MATTHIAS BEST' },
      { col: 20, row: 118, text: 'FRANK GRIMM' },
      { col: 20, row: 127, text: 'RALF SCHITTKOWSKI' },
      { col: 20, row: 136, text: 'ALEXANDER SPERLING' },
      { col: 20, row: 145, text: 'BIRGIT KRAUSE' },
      { col: 20, row: 154, text: 'MICHAEL PASSMANN' },
    ],
  },
  { addr: 0x4a8a, lines: [] },
];

/**
 * Standing time of a step in timer ticks — `FUN_000046ba` @0x46ba loads `mov $0xd6,%ax` (@0x46ba) and
 * counts down with `subw $0x1` + `jae` (@0x46de/@0x46e3), so it runs from 0xd6 down to and including 0
 * ⇒ **215** passes of `busy_wait_timer(1)`.
 *
 * **OPEN — the timer's rate.** `busy_wait_timer` @0x1fd0 waits on the counter `0x2628`, kept by an
 * interrupt routine outside the game segment; the PIT divisor is chosen at runtime as the **minimum
 * over the registered timer slots** (@0x62909...@0x6292f) and is therefore not a constant in the
 * binary. The port assumes the 100 Hz of the other clocks — at 18.2 Hz every block would stand 11.8 s,
 * which does not match the observed sequence. That is plausibility, not proof, which is why the
 * **count** lives here and the conversion at the caller.
 */
export const CREDITS_STEP_TICKS = 0xd6 + 1;

/**
 * The step index after which the original waits **a second time** without redrawing: @0x4696 and
 * @0x469d sit immediately after one another, with only the abort test in between. The "SPIELETESTER"
 * block — the longest — therefore stands twice as long.
 */
export const CREDITS_DOUBLE_STEP = 8;

/** Standing time of step `index` in timer ticks. */
export function creditsStepTicks(index: number): number {
  return index === CREDITS_DOUBLE_STEP ? CREDITS_STEP_TICKS * 2 : CREDITS_STEP_TICKS;
}

/** State of the running sequence. */
export interface CreditsState {
  /** Index into {@link CREDITS_STEPS}. */
  readonly step: number;
  /** Ticks consumed in the current step. */
  readonly elapsed: number;
}

export function initialCreditsState(): CreditsState {
  return { step: 0, elapsed: 0 };
}

/**
 * Advances the sequence by `ticks`. Runs **endlessly** — at the end the original jumps back to the
 * start with `je 0x45f8` (@0x46b3); the sequence is left only via the left mouse button, and that is
 * the input layer's business.
 */
export function advanceCredits(state: CreditsState, ticks: number): CreditsState {
  let { step, elapsed } = state;
  elapsed += Math.max(0, ticks);
  // A loop rather than an `if`: on a large tick jump (background tab) no step may be lost — the
  // original cannot jump, we can.
  for (let guard = 0; guard < CREDITS_STEPS.length * 4; guard++) {
    const need = creditsStepTicks(step);
    if (elapsed < need) break;
    elapsed -= need;
    step = (step + 1) % CREDITS_STEPS.length;
  }
  return { step, elapsed };
}

/**
 * The drawing commands of a step — background, the logo card if any, then the text lines.
 *
 * The order is the original's: every block calls `FUN_000046f9` (background) **first** and blits only
 * afterwards. The `icon` entries carry **absolute** archive indices — unlike the menu, which keeps its
 * icons bank-relative and adds `MENU_ICON_BASE` itself (`addw $0x366` @0x4f365). That is why
 * {@link drawCredits} draws with `iconBase: 0`.
 */
export function creditsCommands(index: number): MenuCommand[] {
  const step = CREDITS_STEPS[index];
  if (step === undefined) return [];
  const out: MenuCommand[] = [
    { kind: 'icon', icon: CREDITS_BG_ENTRY, x: CREDITS_BG_POS.x, y: CREDITS_BG_POS.y },
  ];
  if (step.logo === true) {
    out.push({
      kind: 'icon',
      icon: CREDITS_LOGO_ENTRY,
      x: CREDITS_LOGO_POS.x,
      y: CREDITS_LOGO_POS.y,
    });
  }
  for (const l of step.lines) {
    out.push({ kind: 'text', text: t(l.text), x: creditsX(l.col), y: creditsY(l.row) });
  }
  return out;
}

/**
 * Draws one intro step — the same font loop as the menu, only with the three parameters of the credits
 * wrapper `FUN_00037b48`: absolute icon indices, text colour {@link CREDITS_TEXT_COLOR}, shadow on.
 *
 * It lives here rather than in the component so the verification run calls **this** function instead of
 * rebuilding the composition — a rebuilt checker only checks its own copy.
 */
export function drawCredits(
  target: MenuTarget,
  index: number,
  glyph: (ch: string) => number | undefined,
): void {
  drawMenuCommands(target, creditsCommands(index), glyph, {
    iconBase: 0,
    textColor: CREDITS_TEXT_COLOR,
  });
}
