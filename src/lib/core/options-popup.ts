/**
 * The footer of the distribution/options menu - the two screens behind "ENDE" and "EXTRA OPTION"
 * (screen 0x24). Both are fully ported here: drawing, click zones, actions.
 *
 * | Screen | Renderer | Click walker | Zones | Content |
 * |---|---|---|---|---|
 * | 0x25 | `FUN_0003b64c` | `FUN_0002c5d4` | `@0x2c7fa`, 14 | control options per screen half, music, volume |
 * | 0x22 | `FUN_0003bd6c` | `FUN_0002c5b8` | `@0x2c841`, 2 | quit confirmation, yes / no |
 *
 * Both renderers resolve through the popup table `LAB_00037fb9 + (screen - 1)*8`, the click tables
 * through `LAB_0002c09e + screen*8` (no off-by-one), the action handlers through `@0x2cd66 + id*8`.
 *
 * Zone `0xf5` of screen 0x25 leads to the device screen (screen 0x3c, `device-popup.ts`): its
 * handler `@0x2d5de` fills that screen's working copy `gs+0x2dc..0x2e1` from the effective values
 * `gs+0x3c8..0x3cd` and opens it.
 *
 * ## Screen 0x25 - what it shows
 *
 * Two columns "LINKE SEITE" / "RECHTE SEITE": the original keeps the control options separately for
 * each of the two split screen players (manual ch. 6.5, p. 113). Per column three check boxes (road
 * build scrolling, fast map click, fast build click) and the message level 0..3; at the bottom,
 * shared, music on/off, the right box and the volume 0..99. State and bit layout:
 * `engine/view-options.ts`.
 *
 * The only deliberate deviation of this module from the original is the right box: the original has
 * the SVGA mode there, the port the sound effects on/off. Rationale, extent and the guard that
 * bounds the deviation: {@link OPTIONS_SFX_CHECK_POS} and {@link OPTIONS_SFX_LABEL_BOX}.
 *
 * The "MITTEILUNGEN" line is one 16-character string in the original (`@0x3bd37`) into which the
 * renderer writes the two level digits at index 0 and 15 before drawing (@0x3b94d / @0x3b9ba). Here
 * it is composed instead - overwriting a constant would be a bug in the port.
 *
 * ## Screen 0x22 - the confirmation dialog
 *
 * Its renderer has three side effects: it pauses the game (`pause_game_clock` `FUN_0003ecb9`: parks
 * `gs+0x1fe` in `gs+0x1fa` and zeroes it - the same pair the "P" key uses), waits a fixed delay
 * (`FUN_00001fd0`) so the opening click does not carry through, and clears `gs+0x1c8` bit 5
 * (`btr $0x5` @0x3be16), which only controls whether drawing continues and is not reproduced here.
 *
 * "NEIN" (`FUN_0002ecb1`) calls `resume_game_clock` (`FUN_0003ecd7`) and closes; "JA"
 * (`FUN_0002ebdb`) leaves the game - it advances the mission number `gs+0x356` (max. 0x1e = 30) and
 * sets the leave bit `gs+0x1c9` bit 2. Since the port has no game frame to leave, "JA" is reported
 * as an action rather than carried out (the state of a half return to the main menu would be
 * invented).
 */
import {
  POPUP_BOUNDS_SMALL,
  composeSmallPopup,
  smallPopupPoint,
  drawLayout,
  drawPanelIcon,
  drawPanelNumber,
  drawPanelText,
  drawPopupFrame,
  hitTestPanel,
  tileBackground,
  UI_ICON_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';
import {
  messageLevel,
  VIEW_OPTION_FAST_BUILD_CLICK,
  VIEW_OPTION_FAST_MAP_CLICK,
  VIEW_OPTION_ROAD_SCROLL,
  type ViewSide,
} from './engine/view-options.js';
import { t } from './language.js';

/** Background tile of both screens (`draw_popup_background(0x136)`). */
export const OPTIONS_POPUP_BG_ICON = 0x136;

/** The confirmation dialog. Its renderer stops the game clock (`pause_game_clock` @0x3bd6c). */
export const QUIT_POPUP_SCREEN = 0x22;

/** The two screen numbers of this module. */
export const OPTIONS_SCREENS: readonly number[] = [QUIT_POPUP_SCREEN, 0x25];

// --- Screen 0x25: EXTRA OPTION -------------------------------------------------------------------

/**
 * Frame fillers: icon `0x137` twelve times in columns 0/2/4/10/12/14 of rows 0 and 8 - the gap in
 * the middle (columns 6/8) leaves room for the exit button. Drawn individually, not through a layout
 * table (the renderer calls `draw_panel_icon` twelve times).
 */
export const OPTIONS_FRAME_ICONS: readonly LayoutItem[] = [
  { icon: 0x137, col: 0, row: 0 },
  { icon: 0x137, col: 2, row: 0 },
  { icon: 0x137, col: 4, row: 0 },
  { icon: 0x137, col: 10, row: 0 },
  { icon: 0x137, col: 12, row: 0 },
  { icon: 0x137, col: 14, row: 0 },
  { icon: 0x137, col: 0, row: 8 },
  { icon: 0x137, col: 2, row: 8 },
  { icon: 0x137, col: 4, row: 8 },
  { icon: 0x137, col: 10, row: 8 },
  { icon: 0x137, col: 12, row: 8 },
  { icon: 0x137, col: 14, row: 8 },
];

/** The exit button (icon `0x3c`) - here top centre, not bottom right as elsewhere. */
export const OPTIONS_EXIT_ICON: LayoutItem = { icon: 0x3c, col: 7, row: 0 };

/** One static text of the screen (order = renderer order). */
export interface OptionsLabel {
  readonly text: string;
  readonly col: number;
  readonly row: number;
}

/** The column heads and the six option labels (`@0x3bd15` .. `@0x3bd0a`). */
export const OPTIONS_LABELS_TOP: readonly OptionsLabel[] = [
  { text: 'LINKE     RECHTE', col: 0, row: 0x02 },
  { text: 'SEITE      SEITE', col: 0, row: 0x0b },
  { text: '  WEGEBAU-', col: 2, row: 0x1c },
  { text: ' SCROLLING', col: 2, row: 0x25 },
  { text: ' SCHNELLER', col: 2, row: 0x30 },
  { text: 'KARTENKLICK', col: 2, row: 0x39 },
  { text: ' SCHNELLER', col: 2, row: 0x44 },
  { text: '  BAUKLICK', col: 2, row: 0x4d },
];

/**
 * The labels of the lower half (`@0x3bd48` .. `@0x3bd63`).
 *
 * A deliberate deviation from the original, see {@link OPTIONS_SFX_CHECK_POS}: the original has two
 * lines `' SVGA'` (col 7, row 0x69) and `' MODE'` (col 7, row 0x72) here. The port draws one line
 * `' SFX'` on the music row (0x6e) instead, because the box next to it switches the sound effects
 * rather than the never-ported 640 x 480 layout. This is the only place where our screen 0x25
 * deviates, and a guard checks exactly that: every difference against the capture must lie inside
 * this box.
 */
export const OPTIONS_LABELS_BOTTOM: readonly OptionsLabel[] = [
  { text: 'MUSIK', col: 2, row: 0x6e },
  { text: '   SFX', col: 7, row: 0x6e },
  { text: ' LAUT-', col: 0, row: 0x7d },
  { text: 'STAERKE:', col: 0, row: 0x86 },
];

/**
 * The rectangle that the two original lines `' SVGA'` / `' MODE'` and our single `' SFX'` line
 * occupy together, in layout space (the same `col`/`row` numbers as the table above). Computed from
 * them rather than estimated: column 7 * 8 px = x 56, six characters of 8 px = 48 px wide; rows 0x69
 * and 0x72 plus 8 px glyph height give y 105 .. 121.
 *
 * When comparing against a framebuffer: `drawPanelText` shifts by the frame
 * (`PANEL_CLICK_ORIGIN_X/_Y` = 8/9), so framebuffer coordinates lie (8, 9) higher.
 */
export const OPTIONS_SFX_LABEL_BOX = { x: 56, y: 0x69, width: 48, height: 0x72 + 8 - 0x69 } as const;

/**
 * Sound effects on by default. Not an original value - the original has no such switch (see
 * {@link OPTIONS_SFX_CHECK_POS}); the default is chosen so the port behaves like the original
 * without being touched. Its counterpart `SCREEN_LAYOUT_DEFAULT` in `engine/view-options.ts` stays
 * and documents what the original does here (`gs+0x3db = 0` @0x2e30, so SVGA off).
 */
export const SFX_DEFAULT = true;

/**
 * The message line: a 16-character template (`@0x3bd37`) that takes the level of the left half at
 * index 0 and that of the right half at index 15.
 */
export const OPTIONS_MESSAGE_TEMPLATE = '  MITTEILUNGEN  ';
export const OPTIONS_MESSAGE_POS = { col: 0, row: 0x58 } as const;
/** The two character positions the renderer overwrites (@0x3b94d / @0x3b9ba). */
export const OPTIONS_MESSAGE_SLOT_LEFT = 0;
export const OPTIONS_MESSAGE_SLOT_RIGHT = 15;

/** Check icons: empty box resp. box with a tick. */
export const OPTIONS_CHECK_ICON_OFF = 0xdc;
export const OPTIONS_CHECK_ICON_ON = 0x120;

/** One option check box: which half, which bit, where. */
export interface OptionCheckbox {
  readonly side: ViewSide;
  readonly mask: number;
  readonly col: number;
  readonly row: number;
  /** Action id of the matching click zone. */
  readonly action: number;
}

/**
 * The six check boxes of the two columns, in the renderer's drawing order (left column top to
 * bottom, then right). The action ids stand next to them because the zone table carries them in the
 * order `b1 b3 b5 b2 b4 b6`.
 */
export const OPTION_CHECKBOXES: readonly OptionCheckbox[] = [
  { side: 0, mask: VIEW_OPTION_ROAD_SCROLL, col: 0, row: 0x1c, action: 0xb1 },
  { side: 0, mask: VIEW_OPTION_FAST_MAP_CLICK, col: 0, row: 0x30, action: 0xb3 },
  { side: 0, mask: VIEW_OPTION_FAST_BUILD_CLICK, col: 0, row: 0x44, action: 0xb5 },
  { side: 1, mask: VIEW_OPTION_ROAD_SCROLL, col: 0xe, row: 0x1c, action: 0xb2 },
  { side: 1, mask: VIEW_OPTION_FAST_MAP_CLICK, col: 0xe, row: 0x30, action: 0xb4 },
  { side: 1, mask: VIEW_OPTION_FAST_BUILD_CLICK, col: 0xe, row: 0x44, action: 0xb6 },
];

/** Music check box (`gs+0x1cb` bit 1). */
export const OPTIONS_MUSIC_CHECK_POS = { col: 0, row: 0x6a } as const;

/**
 * The right box. In the original it is the SVGA mode (`gs+0x1c8` bit 0, `toggle_screen_layout`);
 * position, size and sprites are unchanged from the original.
 *
 * In the port it switches the sound effects. That is an addition to the controls and no
 * reconstruction - justified because the SVGA mode is a second complete UI set (640 x 480) that this
 * port will deliberately never draw, so the box would be permanently dead area, and because the
 * original has no on/off for the effect sounds at all, only the shared volume `gs+0x3dc` (music has
 * its own bit). The deviation is limited to this box and its label and is checked as such, see
 * {@link OPTIONS_SFX_LABEL_BOX}.
 */
export const OPTIONS_SFX_CHECK_POS = { col: 0xe, row: 0x6a } as const;

/** The two volume buttons and the number next to them. */
export const OPTIONS_VOLUME_MINUS: LayoutItem = { icon: 0xdc, col: 0xc, row: 0x7e };
export const OPTIONS_VOLUME_PLUS: LayoutItem = { icon: 0xdd, col: 0xe, row: 0x7e };
export const OPTIONS_VOLUME_POS = { col: 9, row: 0x86 } as const;

// --- Screen 0x22: ENDE ---------------------------------------------------------------------------

/** The four text lines of the confirmation dialog (`@0x3bede` .. `@0x3bf08`). */
export const QUIT_POPUP_LABELS: readonly OptionsLabel[] = [
  { text: '   WOLLEN SIE', col: 0, row: 0x0a },
  { text: '  DIESES SPIEL', col: 0, row: 0x14 },
  { text: '   BEENDEN ?', col: 0, row: 0x1e },
  { text: '  JA       NEIN', col: 0, row: 0x2d },
];

// --- click tables (verbatim) ---------------------------------------------------------------------

/**
 * Screen 0x25 - table `@0x2c7fa`, 14 zones in the form `{action, x0, x1, y0, y1}`. Each of the twelve
 * visible zones covers its element (`x0 == col*8`); `0xf5` sits on the frame fillers at the top
 * right, `0xb0` on the exit button.
 */
export const OPTIONS_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0xb0, x0: 0x38, x1: 0x47, y0: 0x00, y1: 0x0f }, // exit
  { action: 0xb1, x0: 0x00, x1: 0x0f, y0: 0x1c, y1: 0x2b },
  { action: 0xb3, x0: 0x00, x1: 0x0f, y0: 0x30, y1: 0x3f },
  { action: 0xb5, x0: 0x00, x1: 0x0f, y0: 0x44, y1: 0x53 },
  { action: 0xb2, x0: 0x70, x1: 0x7f, y0: 0x1c, y1: 0x2b },
  { action: 0xb4, x0: 0x70, x1: 0x7f, y0: 0x30, y1: 0x3f },
  { action: 0xb6, x0: 0x70, x1: 0x7f, y0: 0x44, y1: 0x53 },
  { action: 0xb7, x0: 0x00, x1: 0x08, y0: 0x58, y1: 0x5f }, // message level, left half
  { action: 0xb8, x0: 0x78, x1: 0x7f, y0: 0x58, y1: 0x5f }, // message level, right half
  { action: 0xfa, x0: 0x00, x1: 0x0f, y0: 0x6a, y1: 0x79 }, // music
  { action: 0xfb, x0: 0x70, x1: 0x7f, y0: 0x6a, y1: 0x79 }, // SVGA mode in the original, SFX here
  { action: 0xfc, x0: 0x60, x1: 0x6f, y0: 0x7e, y1: 0x8d }, // volume -
  { action: 0xfd, x0: 0x70, x1: 0x7f, y0: 0x7e, y1: 0x8d }, // volume +
  { action: 0xf5, x0: 0x58, x1: 0x7f, y0: 0x00, y1: 0x0f }, // to screen 0x3c
];

/** Screen 0x22 - table `@0x2c841`, two zones: yes and no on text row 0x2d. */
export const QUIT_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0xa9, x0: 0x08, x1: 0x27, y0: 0x2d, y1: 0x34 }, // JA
  { action: 0xaa, x0: 0x58, x1: 0x77, y0: 0x2d, y1: 0x34 }, // NEIN
];

// --- actions -------------------------------------------------------------------------------------

export type OptionsPopupAction =
 /**
  * Exit (`0xb0`, `FUN_0002e613`) - close the popup, restore the bar slots
  * (`vp[0x62..0x64] = {10, 0xc, 0xe}`).
  *
  * The handler has two branches: only with `gs+0x1c8` bit 3 set (game running) does the described
  * one apply; without the bit - the screen is reachable from the main menu too - it writes
  * `vp[0x1b8] = 1` and returns there instead.
  */
  | { readonly kind: 'close' }
  /** One check box of the two columns (`0xb1`..`0xb6`) - `gs+0x3d8+side ^= mask`. */
  | { readonly kind: 'toggle'; readonly side: ViewSide; readonly mask: number; readonly label: string }
  /** Advance the message level of one half (`0xb7`/`0xb8`). */
  | { readonly kind: 'messageLevel'; readonly side: ViewSide }
  /** Music on/off (`0xfa`, `FUN_0002d652` - also switches the player). */
  | { readonly kind: 'music' }
 /**
  * The right box (`0xfb`). `toggle_screen_layout` (SVGA) in the original, the sound effects on/off
  * here - see {@link OPTIONS_SFX_CHECK_POS}.
  */
  | { readonly kind: 'sfx' }
  /** Volume +-1 (`0xfc`/`0xfd`), clamped to 0..99. */
  | { readonly kind: 'volume'; readonly delta: -1 | 1 }
  /** On to the device screen (`0xf5` to 0x3c, {@link ./device-popup.ts}). */
  | { readonly kind: 'screen'; readonly screen: number; readonly label: string }
  /** Yes (`0xa9`) - leave the game. Reported, not carried out. */
  | { readonly kind: 'quitConfirm' }
  /** No (`0xaa`) - let the game run on and close. */
  | { readonly kind: 'quitCancel' };

/** Click zones of one of the two screens (empty for any other). */
export function optionsPopupHitboxes(screen: number): readonly HitRect[] {
  if (screen === 0x25) return OPTIONS_POPUP_HITBOXES;
  if (screen === 0x22) return QUIT_POPUP_HITBOXES;
  return [];
}

/** Aktions-ID → Wirkung. */
export function optionsPopupAction(action: number): OptionsPopupAction | null {
  const box = OPTION_CHECKBOXES.find((c) => c.action === action);
  if (box) {
    return {
      kind: 'toggle',
      side: box.side,
      mask: box.mask,
      label: box.side === 0 ? 'left side' : 'right side',
    };
  }
  switch (action) {
    case 0xb0:
      return { kind: 'close' };
    case 0xb7:
      return { kind: 'messageLevel', side: 0 };
    case 0xb8:
      return { kind: 'messageLevel', side: 1 };
    case 0xfa:
      return { kind: 'music' };
    case 0xfb:
      return { kind: 'sfx' };
    case 0xfc:
      return { kind: 'volume', delta: -1 };
    case 0xfd:
      return { kind: 'volume', delta: 1 };
    case 0xf5:
      return { kind: 'screen', screen: 0x3c, label: 'input device' };
    case 0xa9:
      return { kind: 'quitConfirm' };
    case 0xaa:
      return { kind: 'quitCancel' };
    default:
      return null;
  }
}

/** Click in drawing pixels to action (`null` outside all zones). */
export function clickOptionsPopup(
  screen: number,
  drawX: number,
  drawY: number,
): OptionsPopupAction | null {
  const id = hitTestPanel(optionsPopupHitboxes(screen), drawX, drawY);
  if (id === null) return null;
  return optionsPopupAction(id);
}

// --- drawing -------------------------------------------------------------------------------------

/** State screen 0x25 needs for drawing. */
export interface OptionsPopupView {
  /** `header.viewOptions` - control options of the left resp. right screen half. */
  readonly viewOptions: readonly [number, number];
  /** `gs+0x3dc` - volume 0..99. */
  readonly volume: number;
  /** `gs+0x1cb` bit 1 - music on. */
  readonly music: boolean;
 /**
  * The tick of the right box. `gs+0x1c8` bit 0 (SVGA mode) in the original, sound effects on here -
  * see {@link OPTIONS_SFX_CHECK_POS}.
  */
  readonly sfx: boolean;
}

export interface OptionsPopupOptions {
  readonly textColor: readonly [number, number, number];
}

/**
 * The message line with both level digits (template plus two replacements as in the original).
 *
 * The template comes in translated: it is 16 characters long in both languages, so the two digit
 * slots 0 and 15 hold as they are. A `t()` on the *result* would have no effect - the composed line
 * is in no table, which is why the screen stayed German once.
 */
export function optionsMessageLine(viewOptions: readonly [number, number]): string {
  const chars = [...t(OPTIONS_MESSAGE_TEMPLATE)];
  chars[OPTIONS_MESSAGE_SLOT_LEFT] = String(messageLevel(viewOptions[0]));
  chars[OPTIONS_MESSAGE_SLOT_RIGHT] = String(messageLevel(viewOptions[1]));
  return chars.join('');
}

function drawCheckbox(
  fb: Framebuffer,
  provider: SpriteProvider,
  on: boolean,
  col: number,
  row: number,
): void {
  drawPanelIcon(fb, provider, on ? OPTIONS_CHECK_ICON_ON : OPTIONS_CHECK_ICON_OFF, col, row);
}

/** Draw screen 0x25 - `FUN_0003b64c`, element by element in renderer order. */
export function drawOptionsPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  view: OptionsPopupView,
  opts: OptionsPopupOptions,
): void {
  tileBackground(fb, provider, OPTIONS_POPUP_BG_ICON);
  drawLayout(fb, provider, OPTIONS_FRAME_ICONS, UI_ICON_BASE);
  for (const l of OPTIONS_LABELS_TOP) drawPanelText(fb, provider, t(l.text), l.col, l.row, opts.textColor);
  drawPanelText(
    fb,
    provider,
    optionsMessageLine(view.viewOptions),
    OPTIONS_MESSAGE_POS.col,
    OPTIONS_MESSAGE_POS.row,
    opts.textColor,
  );
  drawPanelIcon(fb, provider, OPTIONS_EXIT_ICON.icon, OPTIONS_EXIT_ICON.col, OPTIONS_EXIT_ICON.row);
  for (const box of OPTION_CHECKBOXES) {
    const byte = view.viewOptions[box.side] ?? 0;
    drawCheckbox(fb, provider, (byte & box.mask) !== 0, box.col, box.row);
  }
  for (const l of OPTIONS_LABELS_BOTTOM) {
    drawPanelText(fb, provider, t(l.text), l.col, l.row, opts.textColor);
  }
  drawCheckbox(fb, provider, view.music, OPTIONS_MUSIC_CHECK_POS.col, OPTIONS_MUSIC_CHECK_POS.row);
  drawCheckbox(
    fb,
    provider,
    view.sfx,
    OPTIONS_SFX_CHECK_POS.col,
    OPTIONS_SFX_CHECK_POS.row,
  );
  drawPanelIcon(fb, provider, OPTIONS_VOLUME_MINUS.icon, OPTIONS_VOLUME_MINUS.col, OPTIONS_VOLUME_MINUS.row);
  drawPanelIcon(fb, provider, OPTIONS_VOLUME_PLUS.icon, OPTIONS_VOLUME_PLUS.col, OPTIONS_VOLUME_PLUS.row);
  drawPanelNumber(fb, provider, view.volume, OPTIONS_VOLUME_POS.col, OPTIONS_VOLUME_POS.row);
}

/**
 * Draw screen 0x22 - `FUN_0003bd6c`. The two side effects of the original renderer (pause the game,
 * fixed delay) do not belong in drawing; here the pause hangs on the action that opens the screen.
 */
export function drawQuitPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  opts: OptionsPopupOptions,
): void {
  tileBackground(fb, provider, OPTIONS_POPUP_BG_ICON);
  for (const l of QUIT_POPUP_LABELS) drawPanelText(fb, provider, t(l.text), l.col, l.row, opts.textColor);
}

/** Dispatcher for the two screens (like the original renderer jump). */
export function drawOptionsScreen(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  view: OptionsPopupView,
  opts: OptionsPopupOptions,
): boolean {
  if (screen === 0x25) {
    drawOptionsPopup(fb, provider, view, opts);
    return true;
  }
  if (screen === 0x22) {
    drawQuitPopup(fb, provider, opts);
    return true;
  }
  return false;
}


/**
 * The popup over the menu area - content, frame and placement in one step.
 *
 * Lives here and not in the control layer so that the browser view and the verification run use the
 * same arithmetic: a tool that rebuilds the composition checks its own copy, not the port.
 *
 * Two things the body does not show:
 *
 * - The renderers work in popup-local coordinates, hence the separate 144 x 160 buffer. It then
 * moves as a whole to its place ({@link POPUP_BOUNDS_SMALL}, established at the pixel).
 * - The block blit is admissible because this screen has no transparent places: the capture
 * comparison counts 23040 == 144 * 160 opaque pixels. `blitSprite` still respects alpha and takes
 * care of clipping at the surface edge.
 *
 * Returns `false` when `screen` is none of this module's screens - then nothing was drawn.
 */
export function drawMenuPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  view: OptionsPopupView,
  opts: OptionsPopupOptions,
): boolean {
  return composeSmallPopup(fb, provider, (pop) =>
    drawOptionsScreen(pop, provider, screen, view, opts),
  );
}

/**
 * The click into the popup over the menu area - the inverse of {@link drawMenuPopup} and here for
 * the same reason: position and hit must come from one source.
 *
 * `sx`/`sy` are pixels of the 352 x 240 menu area. Only the popup position is subtracted - the frame
 * offset (8, 9) is already inside {@link clickOptionsPopup} (its `hitTestPanel` shifts the original
 * rectangle coordinates by {@link PANEL_CLICK_ORIGIN_X}/`_Y`). Subtracting it a second time here was
 * the bug that left the dialog dead when it was first wired up: the zones then sit eight pixels off,
 * and since the boxes are 16 px wide one hits partly nothing and partly the neighbour - a failure no
 * test would show.
 *
 * `null` means "no zone", including a click next to the popup. The original has no click-outside to
 * close; the way out is the exit button.
 */
export function clickMenuPopup(
  screen: number,
  sx: number,
  sy: number,
): OptionsPopupAction | null {
  const p = smallPopupPoint(sx, sy);
  return clickOptionsPopup(screen, p.x, p.y);
}
