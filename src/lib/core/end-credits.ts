/**
 * The end credits - `run_end_credits` @0x38b55, the full-screen sequence after winning the last
 * campaign level. Not a popup: the routine paints over the whole 352 x 240 area and runs about 1500
 * frames before returning to the main menu (109 held, 628 travelling, 31 held, then the closing text
 * over 729 frames with the music fading out).
 *
 * Four things a rebuild gets wrong:
 *
 * 1. It scrolls SIDEWAYS. The scroll routine passes the running value as x, not y, so it is 0x13a
 *    COLUMNS. The image is 640 wide and the area 352, so the travel passes exactly once over the whole
 *    image width.
 * 2. During the hold phase the original does NOT blit the image, and it is visible anyway: the
 *    negative-row branch jumps past the blit, and since there is no per-frame `fill_rect` the screen
 *    keeps the image's end position plus the 21 text lines. A port without retention must therefore
 *    DRAW that content although the original blits nothing - hence the two quantities `column` (what
 *    is passed) and `visibleColumn` (what stands).
 * 3. Two decoration sprites ride WITH the image: their position is relative to the travelling image
 *    origin, so they belong to the motif, not to the screen. During the hold phase they sit far
 *    outside and invisible, although the routine keeps blitting them.
 * 4. The credits bring their own palette - in-archive entry 3996 - and restore the game palette at the
 *    end. That assigns the third in-archive palette: opening credits 3997, game and menu 2, end
 *    credits 3996. Fittingly all four sprites used here live in the art bank.
 *
 * No capture comparison is possible: the credits require winning level 30.
 */
import { drawMenuCommands, type MenuCommand, type MenuTarget } from './main-menu.js';
import { LAST_CAMPAIGN_LEVEL } from './player-setup.js';
import { MUSIC_ARCHIVE_ENDING, MUSIC_ARCHIVE_GAME } from './music.js';
import { t } from './language.js';

/** In-archive palette of the credits — `mov $0xf9d` @0x2540 (called @0x38bc6), DOS 3997 = entry 3996 ("art"). */
export const END_CREDITS_PALETTE_ENTRY = 3996;

/** Palette restored at the end — `mov $0x3` @0x2530 (called @0x38f62) = entry 2 ("game"). */
export const END_CREDITS_PALETTE_AFTER = 2;

/**
 * Music track of the credits (`mov $0xf98` @0x38b71) and the track it switches back to at the end
 * (`mov $0xf96` @0x38f7e). Both numbers belong to `core/music.ts`; these are alias names at their
 * point of use, so one value does not get two sources.
 */
export const END_CREDITS_MUSIC_ENTRY = MUSIC_ARCHIVE_ENDING;
export const END_CREDITS_MUSIC_AFTER = MUSIC_ARCHIVE_GAME;

/**
 * **Volume the credits start at** — `mov $0x64,%ax` @0x38b80, i.e. **100**.
 *
 * A constant, not derived from the user setting: the credits start the track and set the volume
 * themselves (`call 0x2080` @0x38b8a) *without* reading `gs+0x3dc`; only at the end (@0x38f90) does
 * the original fetch the user value again. 100 is **one above** the slider's maximum 99
 * (`VOLUME_MAX`), which makes the intent explicit — our player clamps there, meaning the same:
 * full volume.
 */
export const END_CREDITS_MUSIC_VOLUME = 0x64;

/** The travelling image: `vreg2 = 1` @0x39050, DOS index 1 = entry 0 (640 x 200). */
export const END_CREDITS_IMAGE_ENTRY = 0;

/** Image origin: `x = 0x10 − column`, `y = 0x14` (@0x39044/@0x39048). */
export const END_CREDITS_IMAGE_Y = 0x14;
export const END_CREDITS_IMAGE_X0 = 0x10;

/** Last travelled column — `cmpw $0x13a` @0x38c23. */
export const END_CREDITS_LAST_COLUMN = 0x13a;

/** Frames per phase — `mov $0x6d` @0x38bdb · `mov $0x1f` @0x38c2b · `mov $0x2d9` @0x38edc. */
export const END_CREDITS_HOLD_BEFORE = 0x6d;
export const END_CREDITS_HOLD_AFTER = 0x1f;
export const END_CREDITS_HOLD_END = 0x2d9;

/** Timer per frame: `cmpw $0x5` @0x38fe5 + `jb` @0x38fea — a frame waits for 5 ticks of `gs[0x208]`. */
export const END_CREDITS_FRAME_TICKS = 5;

/**
 * Decoration 1 — sprite sequence from table @0x3914d, index `(counter & 0x3f) >> 1`
 * (@0x39099/@0x390af), sprite `DOS(tab[i] + 5)` = entry `tab[i] + 4`. The second half of the table
 * is constantly `1`, so the animation runs only in the first half of the 64-cycle and then rests.
 */
// prettier-ignore
export const END_CREDITS_DECO1_TABLE: readonly number[] = [
  1, 2, 2, 1, 0, 3, 4, 4, 4, 3, 0, 5, 6, 6, 5, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

/** Decoration 1: sprite base (`addw $0x5` @0x390c0) and position relative to the image origin. */
export const END_CREDITS_DECO1 = { base: 5 - 1, dx: 0x8e, dy: 0x4e } as const;

/** Decoration 2: 7 frames (`cmpw $0x7` @0x39105) from DOS `0xf` (@0x3911c), position @0x39121/@0x39126. */
export const END_CREDITS_DECO2 = { base: 0xf - 1, frames: 7, dx: 0x1fa, dy: 10 } as const;

/** Text colour — `mov $0x1f` @0x37bff in `FUN_00037bad` (like the menu, unlike the opening credits). */
export const END_CREDITS_TEXT_COLOR = 0x1f;

/**
 * Text origin of the **fourth** wrapper of the same font loop: `x = ((col − 0x28) << 3) + 0x10`,
 * `y = row + 0xe` (@0x37bc0..@0x37bcf). All 21 calls pass `col = 0x28`, so x is constantly `0x10` —
 * the column exists in the original but is unused.
 */
export const END_CREDITS_ORIGIN = { colBase: 0x28, x: 0x10, y: 0xe } as const;

/** One line of the closing text. */
export interface EndCreditsLine {
  /** Eighth-column (`vreg0` before `call 0x37bad`) — `0x28` in all 21 calls. */
  readonly col: number;
  /** Pixel row (`vreg1`). */
  readonly row: number;
  /** Address of the string in the binary — the join key for verification. */
  readonly addr: number;
  readonly text: string;
}

/**
 * The 21 lines of the closing text, in call order (`col`, `row`, pointer per `call 0x37bad`
 * @0x38c49..@0x38ed7). Line spacing is 9 — **except** between `0x5b` and `0x6a`, where the original
 * inserts a paragraph break (15 instead of 9).
 */
export const END_CREDITS_LINES: readonly EndCreditsLine[] = [
  { col: 0x28, row: 0x0a, addr: 0x3916d, text: 'DIE SONNE GEHT AUF UEBER' },
  { col: 0x28, row: 0x13, addr: 0x39186, text: 'DEM SIEDLERLAND. SCHON' },
  { col: 0x28, row: 0x1c, addr: 0x3919d, text: 'VOR STUNDEN BEGANNEN DIE' },
  { col: 0x28, row: 0x25, addr: 0x391b6, text: 'ERSTEN VOEGEL ZU SINGEN.' },
  { col: 0x28, row: 0x2e, addr: 0x391cf, text: 'BALD WERDEN ALLE IHRE' },
  { col: 0x28, row: 0x37, addr: 0x391e5, text: 'UNTERTANEN WIEDER DEM' },
  { col: 0x28, row: 0x40, addr: 0x391fb, text: 'UEBLICHEN TAGEWERK NACH-' },
  { col: 0x28, row: 0x49, addr: 0x39214, text: 'GEHEN UND DER LAST, ABER' },
  { col: 0x28, row: 0x52, addr: 0x3922d, text: 'AUCH DEN KLEINEN FREUDEN' },
  { col: 0x28, row: 0x5b, addr: 0x39246, text: 'DES ALLTAGS FROEHNEN.' },
  { col: 0x28, row: 0x6a, addr: 0x3925c, text: 'MIT DER SICHEREN GE-' },
  { col: 0x28, row: 0x73, addr: 0x39271, text: 'WISSHEIT DAS RICH-' },
  { col: 0x28, row: 0x7c, addr: 0x39284, text: 'TIGE ZU TUN SCHIEBEN' },
  { col: 0x28, row: 0x85, addr: 0x39299, text: 'SIE DIE BEINE AUS' },
  { col: 0x28, row: 0x8e, addr: 0x392ab, text: 'DEM BETT. SIE LEHNEN' },
  { col: 0x28, row: 0x97, addr: 0x392c0, text: 'SICH AUS DEM FENSTER' },
  { col: 0x28, row: 0xa0, addr: 0x392d5, text: 'IN DIE KUEHLE MORGEN-' },
  { col: 0x28, row: 0xa9, addr: 0x392eb, text: 'LUFT UND ATMEN TIEF' },
  { col: 0x28, row: 0xb2, addr: 0x392ff, text: 'DURCH. SIE HABEN ES' },
  { col: 0x28, row: 0xbb, addr: 0x39313, text: 'BEWIESEN: SIE SIND' },
  { col: 0x28, row: 0xc4, addr: 0x39326, text: 'DER HERRSCHER.' },
];

/** Frame counts of the four phases — summed in {@link END_CREDITS_FRAMES}. */
export const END_CREDITS_PHASE_FRAMES = {
  holdBefore: END_CREDITS_HOLD_BEFORE,
  pan: 2 * END_CREDITS_LAST_COLUMN,
  holdAfter: END_CREDITS_HOLD_AFTER,
  holdEnd: END_CREDITS_HOLD_END,
} as const;

/** Total length of the sequence in frames (109 + 628 + 31 + 729). */
export const END_CREDITS_FRAMES =
  END_CREDITS_PHASE_FRAMES.holdBefore
  + END_CREDITS_PHASE_FRAMES.pan
  + END_CREDITS_PHASE_FRAMES.holdAfter
  + END_CREDITS_PHASE_FRAMES.holdEnd;

/** What a frame shows — the output of {@link endCreditsFrame}. */
export interface EndCreditsFrame {
  /**
   * The column the original **passes** to the frame body — `null` for the hold phase, where it
   * sends `-1` and therefore blits **no** image (`vreg0 < 0`, `jns` @0x39010).
   */
  readonly column: number | null;
  /**
   * The column that **stands** on screen — still `0x13a` during the hold phase.
   *
   * **That difference is the whole point of the hold phase.** The original has no per-frame
   * `fill_rect`: the screen keeps what was last on it, i.e. the image in its end position **plus**
   * the 21 text lines. Our caller has no retention, so the port must draw exactly that content
   * actively — otherwise the text would stand on black.
   */
  readonly visibleColumn: number;
  /** Image origin `x = 0x10 − visibleColumn` — the decorations hang off it too. */
  readonly imageX: number;
  /** Archive entry of the decoration-1 sprite. */
  readonly deco1Entry: number;
  /** Archive entry of the decoration-2 sprite. */
  readonly deco2Entry: number;
  /** Are the 21 text lines drawn yet? (From the hold phase onwards.) */
  readonly text: boolean;
  /**
   * Volume this frame sets (`cmpw $0x64` @0x38ef2), otherwise `null` — it **falls** from 99 towards
   * 0, fading out the credits music over the last 100 frames.
   */
  readonly volume: number | null;
}

/**
 * The state of frame `n` (0-based). Pure function.
 *
 * The three counters keep running across **all** phases, not per phase: `vreg5` (decoration 1) and
 * `vreg6` (decoration 2) are incremented in `FUN_00038fa8` **after** the image branch
 * (@0x39094/@0x39100), i.e. in every frame, including the hold phase.
 */
export function endCreditsFrame(n: number): EndCreditsFrame {
  const p = END_CREDITS_PHASE_FRAMES;
  let column: number | null;
  if (n < p.holdBefore) column = 0; // phase 1: 109 x column 0
  else if (n < p.holdBefore + p.pan) column = (n - p.holdBefore) >> 1; // phase 2: each column twice
  else if (n < p.holdBefore + p.pan + p.holdAfter) column = END_CREDITS_LAST_COLUMN;
  else column = null; // phase 4: `vreg0 = -1`, no image blit

  // The hold branch computes `x = 0x10 − 0x13a` (@0x39012..@0x39022) and takes the decorations
  // along — so the flag lands at `−298 + 0x1fa = 208`, i.e. **inside** the picture and keeps
  // animating over the text. (The other decoration sits at −156, outside.)
  const visibleColumn = column ?? END_CREDITS_LAST_COLUMN;
  const imageX = END_CREDITS_IMAGE_X0 - visibleColumn;

  // `vreg5 += 1 ; &= 0x3f` **before** the read (@0x39094/@0x39099), so frame 0 already uses index 1.
  const d1 = ((n + 1) & 0x3f) >> 1;
  const deco1Entry = END_CREDITS_DECO1.base + (END_CREDITS_DECO1_TABLE[d1] ?? 0);
  // `vreg6 += 1 ; if (== 7) vreg6 = 0` (@0x39100..@0x39111) — same order.
  const deco2Entry = END_CREDITS_DECO2.base + ((n + 1) % END_CREDITS_DECO2.frames);

  // **The volume ramp fades OUT, not in.** The hold phase is a **down** counter in the original:
  // `mov $0x2d9,0x1c(%edi)` @0x38edc, then per frame `if (0x1c(%edi) < 0x64)
  // setVolume(0x1c(%edi))` (@0x38ef2/@0x38f03) and `subw $0x1,0x1c(%edi) ; jae`
  // (@0x38f08/@0x38f0d). The volume *is* the counter value and runs from 99 to 0 over the last 100
  // frames.
  //
  // The counter is `holdEnd − k`; our `k` only reaches `holdEnd − 1`, because this port's phase
  // lengths are the immediates (729) while the original runs the loop once more (`subw` **after**
  // the body, 730 frames). The last port frame therefore ends at volume 1 rather than 0 — one frame
  // before the end, after which the caller switches screens.
  const holdEndStart = p.holdBefore + p.pan + p.holdAfter;
  const counter = p.holdEnd - (n - holdEndStart);
  const volume = column === null && counter < 100 ? counter : null;
  return { column, visibleColumn, imageX, deco1Entry, deco2Entry, text: column === null, volume };
}

/** Eighth-column to area pixel (`((col − 0x28) << 3) + 0x10`). */
export const endCreditsX = (col: number): number =>
  ((col - END_CREDITS_ORIGIN.colBase) << 3) + END_CREDITS_ORIGIN.x;

/** Pixel row to area pixel (`row + 0xe`). */
export const endCreditsY = (row: number): number => row + END_CREDITS_ORIGIN.y;

/**
 * One frame as a **command stream** — same shape as the opening credits (`creditsCommands`), so both
 * run through `drawMenuCommands` and the shadow/colour logic exists once.
 *
 * Order literally as in the original: image (except in the hold phase, see module header), then the
 * two decoration sprites, then — once the travel is done — the 21 text lines.
 */
export function endCreditsCommands(frame: EndCreditsFrame): MenuCommand[] {
  const out: MenuCommand[] = [
    // `fill_rect(0, 0, 0x160, 0xf0, 0)` — `call 0x930` @0x38bc1. The original does it ONCE before
    // the loop; we do it per frame because our caller has no screen retention. Visually identical
    // except in the hold phase, which is the one place the original keeps something we must
    // reproduce — hence `text` keeps drawing there and the image does not.
    { kind: 'bar', x: 0, y: 0, w: 0x160, h: 0xf0, color: 0 },
  ];
  // The image stands in EVERY phase — during the hold phase because the original screen keeps it
  // (see {@link EndCreditsFrame.visibleColumn}). `frame.column === null` means "the original does
  // not blit here", not "there is nothing to see here".
  out.push({ kind: 'icon', icon: END_CREDITS_IMAGE_ENTRY, x: frame.imageX, y: END_CREDITS_IMAGE_Y });
  out.push({
    kind: 'icon', icon: frame.deco1Entry,
    x: frame.imageX + END_CREDITS_DECO1.dx, y: END_CREDITS_IMAGE_Y + END_CREDITS_DECO1.dy,
  });
  out.push({
    kind: 'icon', icon: frame.deco2Entry,
    x: frame.imageX + END_CREDITS_DECO2.dx, y: END_CREDITS_IMAGE_Y + END_CREDITS_DECO2.dy,
  });
  if (frame.text) {
    for (const l of END_CREDITS_LINES) {
      out.push({ kind: 'text', text: t(l.text), x: endCreditsX(l.col), y: endCreditsY(l.row) });
    }
  }
  return out;
}

/**
 * Draws **one** frame of the credits onto the 352 x 240 area.
 *
 * `iconBase: 0` as in the opening credits — the sprite indices here are **absolute** (DOS index
 * minus one), not bank relative like the menu icons.
 */
export function drawEndCredits(
  target: MenuTarget,
  frame: EndCreditsFrame,
  glyph: (ch: string) => number | undefined,
): void {
  drawMenuCommands(target, endCreditsCommands(frame), glyph, {
    iconBase: 0,
    textColor: END_CREDITS_TEXT_COLOR,
  });
}

/**
 * **Trigger** — `cmpw $0x1e,gs[0x356]` @0x38824: the credits run only if the mission just finished
 * was the **last** campaign level (30). The SVGA branch above it (@0x38839) brackets the call in two
 * `toggle_screen_layout` calls and is moot here (no second UI set).
 *
 * The threshold is the **same** as the follow-up password's (`cmpw $0x1e` @0x384c4,
 * {@link LAST_CAMPAIGN_LEVEL}) — two comparisons in the binary, one constant here: two numbers with
 * the same meaning drift apart eventually.
 */
export function endCreditsDue(levelSetupIndex: number): boolean {
  return levelSetupIndex === LAST_CAMPAIGN_LEVEL;
}

/**
 * **The credits cannot be aborted** — shown by absence, not by omission.
 *
 * The opening credits abort on the left mouse button: their wait routine reads the inverted key
 * state at `0x1f56` (see `core/credits.ts`). The credits frame body (`FUN_00038fa8`,
 * @0x38fa8..@0x3914c) touches **none** of the three key addresses; it does exactly three things:
 * wait for 5 timer ticks (@0x38fc8..@0x38fea, `cmpw $0x5`), blit, present. The same absence holds
 * for the frame @0x38b55..@0x38f51.
 *
 * So the sequence runs once from start to end — {@link END_CREDITS_FRAMES} frames, about 75 seconds
 * at 100 Hz — and a click does nothing.
 *
 * **And it ends rather than wrapping.** The opening credits jump back to the start with `je 0x45f8`;
 * here the last loop is followed by the cleanup part (@0x38f0f: area black, palette back, music
 * back) and a `ret` @0x38fa7. What comes after belongs to the caller: @0x3885b draws menu frame and
 * bar (`call 0x718a ; call 0x6e50`, the pair that occurs five times in the binary), then the
 * **shared** exit of the mission-end routine @0x38886 sets `vp[0x70] = 0x22`, the quit dialog. For
 * the port: after the last frame do the same as after the last picture step.
 */
export interface EndCreditsState {
  /** Frame index in `[0, END_CREDITS_FRAMES)`; after the end it stays on the last one. */
  readonly frame: number;
  /** Timer ticks consumed within the current frame. */
  readonly elapsed: number;
  /** Has the sequence finished? The caller then leaves it. */
  readonly done: boolean;
}

export function initialEndCreditsState(): EndCreditsState {
  return { frame: 0, elapsed: 0, done: false };
}

/**
 * Advances the sequence by `ticks` timer ticks.
 *
 * Each frame stands {@link END_CREDITS_FRAME_TICKS} ticks. The loop instead of an `if` is required,
 * not caution: our clock comes from the wall clock, and a throttled background tab delivers jumps
 * over many frames — the original cannot jump, we can. A skipped frame is harmless (the decoration
 * phase is a function of `n`), but the **duration** must not be lost, otherwise the credits would
 * run faster in the background than on screen.
 *
 * At the end `frame` stays on the last frame and `done` is set: the picture must not disappear
 * before the caller switches screens.
 */
export function advanceEndCredits(state: EndCreditsState, ticks: number): EndCreditsState {
  if (state.done) return state;
  let frame = state.frame;
  let elapsed = state.elapsed + Math.max(0, ticks);
  while (elapsed >= END_CREDITS_FRAME_TICKS) {
    elapsed -= END_CREDITS_FRAME_TICKS;
    frame += 1;
    if (frame >= END_CREDITS_FRAMES) {
      return { frame: END_CREDITS_FRAMES - 1, elapsed: 0, done: true };
    }
  }
  return { frame, elapsed, done: false };
}
