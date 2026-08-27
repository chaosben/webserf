/**
 * Mission end (popup screen 0x36) - renderer `FUN_0003831d`. Pauses the clock, fades the music out,
 * shows a small sequence of pictures and finally opens the quit dialog (screen 0x22).
 *
 * In the original this is ONE routine with three interspersed wait loops, and every wait loop is a
 * step boundary - hence the step model here. The clicks do NOT go through the zone router: the
 * walker cell of this screen is a bare `ret`, so the screen consumes its clicks itself and ANY click
 * on the area advances a step. That is why this module has no zone table.
 *
 * The pictures come from the `ArtBox` bank, entries 24..37: exactly 14 of them at 128x144 each, which
 * is the popup's inner area, so a picture REPLACES the window content. The code uses exactly those 14
 * values, none left over.
 *
 * The password shown after a won campaign mission is the one for the NEXT mission: the index is
 * `gs[0x356] + 6` while the current mission uses `+ 5`. At level 30 there is none - record 36 does not
 * exist, the sound parameter table begins there.
 *
 * What the port keeps differently: the mood value lives in the step instead of a game-struct slot, the
 * password is returned instead of overwriting a string literal, and the face table is passed in. The
 * original's SECOND sink for those eight characters — the campaign password buffer the main menu shows
 * — is not written here but by the engine when this screen becomes due, because this module runs once
 * per frame while that write is state. The end credits are a full-screen sequence, not a popup
 * renderer, and live in their own module; only the branch into them is here. The SVGA branch is
 * deliberately never reproduced.
 */

import { campaignFollowUpPassword } from './player-setup.js';
import { endCreditsDue } from './end-credits.js';
import {
  blitSprite,
  drawPanelIcon,
  drawPanelText,
  faceIcon,
  panelX,
  panelY,
  tileBackground,
  type Framebuffer,
  type SpriteProvider,
} from './ui-render.js';
import { t } from './language.js';

/** Popup screen number of the mission end. */
export const MISSION_END_SCREEN = 0x36;

/** Screen the exit requests (`vp[0x70] = 0x22` @0x389d2) — the quit dialog. */
export const MISSION_END_EXIT_SCREEN = 0x22;

/**
 * Bar icons the exit writes into **both** viewports (`gs+0x7c` and `gs+0x78`, each `+0x60..0x64`,
 * @0x388a4 ff. / @0x38931 ff.). It is the row where all three menu tabs carry their **passive** form
 * (9/0xb/0xd instead of 0xa/0xc/0xe) — after the game ends nothing is clickable. The marker slots
 * `+0x65..0x69` get `0xff` (@0x388e6 ff. / @0x38973 ff.).
 */
export const MISSION_END_EXIT_BAR_ICONS: readonly number[] = [0, 7, 9, 0xb, 0xd];

/** Background tile of the text step (`draw_popup_background(0x81)` @0x3838b). */
export const MISSION_END_BG_ICON = 0x81;

/** The winner's face (`draw_panel_icon(col 6, row 0x3c)` @0x383c9). */
export const MISSION_END_FACE_POS = { col: 6, row: 0x3c } as const;

/**
 * Our archive entry of the first `ArtBox` picture. The original blits the **absolute** sprite
 * `mood + 0x19`; our entry is `sprite − 1`.
 */
export const ART_BOX_ENTRY_BASE = 0x18;

/** Number of occupied `ArtBox` entries (24..37) — the upper bound of all mood values. */
export const ART_BOX_COUNT = 14;

// The character table lives with the setup records because the main menu needs it too (there it is
// checked against rather than displayed from). Only re-exported here.
export { PASSWORD_CHARS, PASSWORD_LENGTH } from './player-setup.js';

// Level from which there is no follow-up password (`cmpw $0x1e` @0x384c4) — the same threshold from
// which the end credits run (@0x38826). Defined with the setup records.
export { LAST_CAMPAIGN_LEVEL } from './player-setup.js';

/**
 * Extra picture per campaign level (`DAT_00038867` @0x38867, 31 bytes for levels 0..30). `-1`
 * (`0xff`) means "none" — the original tests with `js` @0x38808 and thus reads the value **signed**.
 * Only every third level has a picture; level 0 shows picture 0, level 30 the last one (0xd) and then
 * the credits.
 */
export const LEVEL_MOOD: readonly number[] = [
  0x00, 0x03, -1, -1, 0x04, -1, -1, 0x05, -1, -1, 0x06, -1, -1, 0x07, -1, -1, 0x08, -1, -1, 0x09,
  -1, -1, 0x0a, -1, -1, 0x0b, -1, -1, 0x0c, -1, 0x0d,
];

/** Game type (`gs+0x352`) — the values this screen distinguishes. */
export const GAME_TYPE_CAMPAIGN = 0;
export const GAME_TYPE_TRAINING = 1;
/** Two-player splitscreen: only here can player 1 be a *human* winner (@0x3834e). */
export const GAME_TYPE_TWO_PLAYER = 3;
/** Custom player settings — this game type shows **no** mood picture (@0x3832a). */
export const GAME_TYPE_CUSTOM = 4;

/** Which text variant the screen shows. */
export type MissionEndBranch =
  /** Campaign won — five lines plus password (@0x38402). */
  | 'campaignWon'
  /** Campaign lost — five lines (@0x38593). */
  | 'campaignLost'
  /** Training goal reached — five lines (@0x38644). */
  | 'training'
  /** Free play: the "leading unassailably" message — **four** lines (@0x386e4). */
  | 'lead';

/** First line of the `lead` variant per winner slot (@0x386f5 / @0x3870a / @0x3871d / @0x38730). */
export const LEAD_COLOR_LINES: readonly string[] = [
  '   DIE BLAUEN',
  '   DIE ROTEN',
  ' DIE VIOLETTEN',
  '   DIE GELBEN',
];

/** One drawn text line: column and row from `draw_popup_panel_text(vreg0, vreg1)`. */
export interface MissionEndLine {
  readonly text: string;
  readonly col: number;
  readonly row: number;
}

const CAMPAIGN_WON_LINES: readonly MissionEndLine[] = [
  { text: '  GRATULATION', col: 0, row: 0x04 },
  { text: 'IHRE FEINDE SIND', col: 0, row: 0x10 },
  { text: 'CHANCENLOS. SIE', col: 0, row: 0x1a },
  { text: '  HABEN DIESE', col: 0, row: 0x24 },
  { text: 'MISSION GEWONNEN', col: 0, row: 0x2e },
];

const CAMPAIGN_LOST_LINES: readonly MissionEndLine[] = [
  { text: 'LEIDER HAT SICH', col: 0, row: 0x06 },
  { text: '  EINER IHRER', col: 0, row: 0x10 },
  { text: 'GEGNER IN DIESER', col: 0, row: 0x1a },
  { text: '    MISSION', col: 0, row: 0x24 },
  { text: ' DURCHGESETZT.', col: 0, row: 0x2e },
];

const TRAINING_LINES: readonly MissionEndLine[] = [
  { text: '  GUT GEMACHT.', col: 0, row: 0x04 },
  { text: ' SIE HABEN IHR', col: 0, row: 0x10 },
  { text: ' ZIEL IN DIESEM', col: 0, row: 0x1a },
  { text: ' TRAININGSSPIEL', col: 0, row: 0x24 },
  { text: '   ERREICHT.', col: 0, row: 0x2e },
];

/** Lines 2..4 of the `lead` variant; line 1 comes from {@link LEAD_COLOR_LINES}. */
const LEAD_TAIL_LINES: readonly MissionEndLine[] = [
  { text: ' SIEDLER LIEGEN', col: 0, row: 0x10 },
  { text: ' UNEINHOLBAR IN', col: 0, row: 0x1a },
  { text: '    FUEHRUNG.', col: 0, row: 0x24 },
];

/** Caption above the password (`draw_popup_panel_text(0, 0x7e)` @0x3854f). */
export const PASSWORD_LABEL: MissionEndLine = {
  text: ' NEUES PASSWORT:',
  col: 0,
  row: 0x7e,
};

/** Position of the password itself (`draw_popup_panel_text(4, 0x87)` @0x3856e). */
export const PASSWORD_POS = { col: 4, row: 0x87 } as const;

/** The slice of game state this screen reads. */
export interface MissionEndView {
  /** `gs+0x352`. */
  readonly gameType: number;
  /** `gs+0x5e` — winner slot. */
  readonly winnerIndex: number;
  /** `gs+0x356` — campaign level; only the campaign reads it. */
  readonly levelSetupIndex: number;
  /** Face bytes of the four slots (`gs+0x1d6 + 4·slot`), e.g. from `playerFaces()`. */
  readonly faces: readonly (number | null | undefined)[];
}

/**
 * Which text variant applies (@0x383df / @0x383f2 / @0x38636): the campaign splits by winner, the
 * training game has only one version, everything else is the lead message.
 */
export function missionEndBranch(gameType: number, winnerIndex: number): MissionEndBranch {
  if (gameType === GAME_TYPE_CAMPAIGN) {
    return winnerIndex === 0 ? 'campaignWon' : 'campaignLost';
  }
  if (gameType === GAME_TYPE_TRAINING) return 'training';
  return 'lead';
}

/** The text lines of a variant, in drawing order. */
export function missionEndLines(view: MissionEndView): readonly MissionEndLine[] {
  switch (missionEndBranch(view.gameType, view.winnerIndex)) {
    case 'campaignWon':
      return CAMPAIGN_WON_LINES;
    case 'campaignLost':
      return CAMPAIGN_LOST_LINES;
    case 'training':
      return TRAINING_LINES;
    case 'lead': {
      // The cascade @0x386fe..@0x38736 compares against 0/1/2 in turn; anything above (slot 3)
      // falls onto the last colour line. There is no winner beyond 3.
      const color = LEAD_COLOR_LINES[view.winnerIndex] ?? LEAD_COLOR_LINES[3]!;
      return [{ text: color, col: 0, row: 0x06 }, ...LEAD_TAIL_LINES];
    }
  }
}

/**
 * Mood picture of the **first** step (@0x38334 ff.), or `null` for game type
 * {@link GAME_TYPE_CUSTOM}, which shows none.
 *
 * Picture 1 exists only in the two-player game: there winner 1 is human too, so the ending is
 * neither a victory (0) nor a defeat against the AI (2).
 */
export function missionEndMood(gameType: number, winnerIndex: number): number | null {
  if (gameType === GAME_TYPE_CUSTOM) return null;
  if (winnerIndex === 0) return 0;
  if (gameType === GAME_TYPE_TWO_PLAYER && winnerIndex === 1) return 1;
  return 2;
}

/**
 * Extra picture of the last step (@0x387cc ff.): only on a won campaign, and only if the level has
 * one. `-1` in the table means none.
 */
export function missionEndBonusMood(view: MissionEndView): number | null {
  if (view.gameType !== GAME_TYPE_CAMPAIGN || view.winnerIndex !== 0) return null;
  const raw = LEVEL_MOOD[view.levelSetupIndex];
  if (raw === undefined || raw < 0) return null;
  return raw;
}

/**
 * The follow-up mission's password as an 8-character string, or `null` if there is none (other game
 * type, not won, or last level).
 *
 * `records` are the first {@link PASSWORD_LENGTH} bytes per setup record — table `@0x61442`, record
 * `level + 6`.
 *
 * The decoding itself lives with the setup records, because the original's loop has a **second sink**
 * besides the text on this screen: it writes the same eight characters into the campaign password
 * buffer, and that one is written from the engine (see `engine/economy.ts`). One function, so display
 * and stored value cannot drift apart.
 */
export function missionEndPassword(
  view: MissionEndView,
  records: readonly (readonly number[] | undefined)[],
): string | null {
  return campaignFollowUpPassword(view, records);
}

/** One step of the sequence; every click advances to the next. */
export type MissionEndStep =
  /** An `ArtBox` picture over the whole window area (`FUN_0004701c`). */
  | { readonly kind: 'picture'; readonly artBox: number }
  /** The text page with face and, if any, password. */
  | { readonly kind: 'message' }
  /**
   * **The end credits** (`call 0x38b55` @0x3884a) — not popup content but a full-screen sequence on
   * the 352 x 240 area; data and drawing in `core/end-credits.ts`. It appears here because the
   * original calls it at exactly this point of the sequence: after the last picture and **before**
   * returning to the menu.
   */
  | { readonly kind: 'endCredits' };

/**
 * The step sequence of this game ending, in order. Every wait loop of the original
 * (`FUN_00039335`) is a boundary between two entries.
 */
export function missionEndSteps(view: MissionEndView): readonly MissionEndStep[] {
  const steps: MissionEndStep[] = [];
  const mood = missionEndMood(view.gameType, view.winnerIndex);
  if (mood !== null) steps.push({ kind: 'picture', artBox: mood });
  steps.push({ kind: 'message' });
  const bonus = missionEndBonusMood(view);
  if (bonus !== null) steps.push({ kind: 'picture', artBox: bonus });
  // `cmpw $0x1e,gs[0x356]` @0x38826 then `call 0x38b55` @0x3884a: on the **last** campaign level the
  // full-screen credits follow (`core/end-credits.ts`). The SVGA branch above it (@0x38839) brackets
  // it in two `toggle_screen_layout` calls — moot here, we have one UI set.
  if (endCreditsDue(view.levelSetupIndex)) steps.push({ kind: 'endCredits' });
  return steps;
}

/**
 * Draws **one** step (port of the drawing part of `FUN_0003831d`).
 *
 * A picture step replaces the window area completely; the text step layers background, winner face,
 * text lines and the password if any.
 */
export function drawMissionEndPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  step: MissionEndStep,
  view: MissionEndView,
  password: string | null,
  textColor: readonly [number, number, number],
): void {
  // The credits have **no** popup content: they are a full-screen sequence on the 352 x 240 area
  // (`core/end-credits.ts`). Without this branch the step would fall into the text path below and
  // show the message a second time.
  if (step.kind === 'endCredits') return;
  if (step.kind === 'picture') {
    // `blit_sprite_topleft(8, 9, mood + 0x19)` — absolute archive index, top-left, no pivot.
    const sprite = provider(ART_BOX_ENTRY_BASE + step.artBox);
    if (sprite) blitSprite(fb, sprite, panelX(0), panelY(0));
    return;
  }
  tileBackground(fb, provider, MISSION_END_BG_ICON);
  // Face byte to icon: `FUN_0003952c`, the same mapping as in the message window and the colour
  // legend. An unoccupied slot has no face and gets the empty icon.
  const face = view.faces[view.winnerIndex] ?? 0;
  drawPanelIcon(
    fb,
    provider,
    faceIcon(face),
    MISSION_END_FACE_POS.col,
    MISSION_END_FACE_POS.row,
  );
  for (const line of missionEndLines(view)) {
    drawPanelText(fb, provider, t(line.text), line.col, line.row, textColor);
  }
  if (password !== null) {
    drawPanelText(fb, provider, t(PASSWORD_LABEL.text), PASSWORD_LABEL.col, PASSWORD_LABEL.row, textColor);
    drawPanelText(fb, provider, password, PASSWORD_POS.col, PASSWORD_POS.row, textColor);
  }
}
