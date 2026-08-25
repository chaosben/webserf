/**
 * Message popup (screen 0x33) — port of `FUN_0003954f` and its 19 type handlers.
 *
 * The original collects event messages per player in a list (`add_player_message`, ported in
 * `engine/player-messages.ts`; byte layout in the player block from 7796 on). This screen is its
 * consumer: it shows the oldest message and takes it out of the list.
 *
 * The eight bytes at the dispatch table's slot 0 are the dispatcher's own tail instructions, so type
 * 0 would jump to itself forever. It never occurs, because 0 is the empty list slot; occupied types
 * are 1..19.
 *
 * The upper 3 bits of `vp[0x96]` are a parameter whose meaning depends on the type: player index for
 * the combat/territory messages (1, 2, 3, 8, 9), mine kind for the exhausted mine (4), unused
 * otherwise. In all available saves the parameter is 0, so this split comes from the code, not from
 * the data.
 */

import {
  UI_OBJECT_BASE,
  drawPanelIcon,
  drawPanelText,
  faceIcon,
  tileBackground,
  type Framebuffer,
  type HitRect,
  type SpriteProvider,
} from './ui-render.js';
import { plotPaletteIndex } from './minimap.js';
import { t, tAt } from './language.js';

/** Popup screen number of the message window. */
export const MESSAGE_SCREEN = 0x33;

/** Background tile (`draw_popup_background(0x13a)`). */
export const MESSAGE_BG_ICON = 0x13a;

/** Confirm button in the bottom right. */
export const MESSAGE_OK_ICON = { icon: 0x120, col: 0xe, row: 0x80 } as const;

/** First text row and row spacing (every handler uses `y = 10, 20, 30, …`, `x = 0`). */
export const MESSAGE_TEXT_ROW0 = 10;
export const MESSAGE_TEXT_ROW_STEP = 10;

/**
 * How a handler draws its picture element. Five forms occur; they differ in the icon bank and in
 * whether (and how) the parameter is used.
 */
export type MessageArt =
  /** `FUN_0003a070`: colour box in the player colour plus that player's face. */
  | { readonly kind: 'faceBox'; readonly col: number; readonly row: number }
  /** `draw_panel_icon` (bank +0x366) with a fixed icon. */
  | { readonly kind: 'panelIcon'; readonly col: number; readonly row: number; readonly icon: number }
  /** `FUN_0003460d` (bank +0x4e2) with a fixed icon. */
  | { readonly kind: 'objectIcon'; readonly col: number; readonly row: number; readonly icon: number }
  /** Like `objectIcon`, but `icon = base + parameter` (type 4: the four mines). */
  | { readonly kind: 'objectIconParam'; readonly col: number; readonly row: number; readonly base: number }
  /**
   * `FUN_0003460d` behind a case distinction on the parameter — not only the icon, the column
   * depends on it too (type 6: hut / tower / fortress, @0x39949..@0x399a8). The order of `cases` is
   * that of the original cascade, `otherwise` is its else branch.
   */
  | {
      readonly kind: 'objectIconCases';
      readonly cases: readonly {
        readonly param: number;
        readonly col: number;
        readonly row: number;
        readonly icon: number;
      }[];
      readonly otherwise: { readonly col: number; readonly row: number; readonly icon: number };
    }
  /** `draw_panel_icon` with `icon = table[parameter]` (type 16: which menu is meant). */
  | {
      readonly kind: 'panelIconTable';
      readonly col: number;
      readonly row: number;
      readonly table: readonly number[];
    };

/** Menu icons for message type 16 — the u16 table @0x39ead, indexed by the message parameter. */
export const MESSAGE_MENU_ICONS: readonly number[] = [0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0x12a, 0x12b];

export interface MessageKind {
  /** Text lines from the top; the y position follows from the index. */
  readonly lines: readonly string[];
  readonly art: MessageArt;
}

/**
 * The 19 message types, read from the handlers @0x396cf..@0x3a06f: texts from the `0xff`-terminated
 * strings at @0x3a127, position and icon from the register assignments before each draw call.
 *
 * Index = message type; index 0 is the empty slot and has no handler.
 *
 * The typo "FERITG" in type 7 is in the original and stays.
 */
export const MESSAGE_KINDS: readonly (MessageKind | null)[] = [
  null, // 0 — empty list slot; in the original the dispatcher's own tail
  { lines: [' IHRE SIEDLUNG', 'WIRD ANGEGRIFFEN'], art: { kind: 'faceBox', col: 6, row: 40 } },
  {
    lines: ['  IHRE RITTER', ' HABEN HIER DEN', ' KAMPF VERLOREN'],
    art: { kind: 'faceBox', col: 6, row: 50 },
  },
  { lines: ['SIE HABEN EINEN', ' SIEG ERRUNGEN'], art: { kind: 'faceBox', col: 6, row: 40 } },
  {
    lines: ['DIESEM BERGWERK', '   GEHEN DIE', ' ROHSTOFFE AUS'],
    art: { kind: 'objectIconParam', col: 6, row: 50, base: 0xa3 },
  },
  {
    lines: [' SIE WOLLTEN AN', '  DIESE STELLE', ' GERUFEN WERDEN'],
    art: { kind: 'objectIcon', col: 6, row: 50, icon: 0x90 },
  },
  {
    lines: [' EIN RITTER HAT', '   EIN NEUES', 'GEBAEUDE BESETZT'],
    // The only handler with a case distinction (@0x39949). The parameter is the building class the
    // producer @0x23f1b forms from `bld[4] & 0x7c`: hut ⇒ 0, tower ⇒ 1, otherwise ⇒ 2.
    // Do not merge the branches: the column jumps between them (6/6/4).
    art: {
      kind: 'objectIconCases',
      cases: [
        { param: 0, col: 6, row: 50, icon: 0xab }, // @0x39952 — hut
        { param: 1, col: 6, row: 50, icon: 0x9e }, // @0x39975 — tower
      ],
      otherwise: { col: 4, row: 50, icon: 0x98 }, // @0x39991 — fortress
    },
  },
  {
    lines: ['EINE NEUE LAGER-', 'HALLE IST FERITG'],
    art: { kind: 'objectIcon', col: 4, row: 40, icon: 0xc0 },
  },
  {
    lines: ['  DURCH DIESES', ' NEUE FEINDLICHE', ' GEBAEUDE HABEN', '    SIE LAND', '    VERLOREN'],
    art: { kind: 'faceBox', col: 6, row: 65 },
  },
  {
    lines: [
      '  DURCH DIESES',
      ' NEUE FEINDLICHE',
      ' GEBAEUDE HABEN',
      '    SIE LAND',
      '  UND GEBAEUDE',
      '    VERLOREN',
    ],
    art: { kind: 'faceBox', col: 6, row: 75 },
  },
  {
    lines: [' WEGEN ZUWENIG', 'BAUMATERIAL WIRD', 'DAS NOTPROGRAMM', '  EINGELEITET'],
    art: { kind: 'objectIcon', col: 4, row: 60, icon: 0xc1 },
  },
  {
    lines: ['DAS NOTPROGRAMM', '  WIRD WIEDER', '   ABGESETZT'],
    art: { kind: 'objectIcon', col: 4, row: 40, icon: 0xb2 },
  },
  { lines: ['EIN GEOLOGE HAT', ' GOLD GEFUNDEN'], art: { kind: 'panelIcon', col: 7, row: 40, icon: 0x2f } },
  { lines: ['EIN GEOLOGE HAT', ' EISEN GEFUNDEN'], art: { kind: 'panelIcon', col: 7, row: 40, icon: 0x2c } },
  { lines: ['EIN GEOLOGE HAT', ' KOHLE GEFUNDEN'], art: { kind: 'panelIcon', col: 7, row: 40, icon: 0x2e } },
  { lines: ['EIN GEOLOGE HAT', 'GRANIT GEFUNDEN'], art: { kind: 'panelIcon', col: 7, row: 40, icon: 0x2b } },
  {
    lines: [' SIE WOLLTEN ZU', '  DIESEM MENU', ' GERUFEN WERDEN'],
    // u16 table @0x39ead, indexed by the parameter — which menu is meant.
    art: { kind: 'panelIconTable', col: 6, row: 50, table: MESSAGE_MENU_ICONS },
  },
  {
    lines: [' SIE HABEN VOR', '   30 MINUTEN', ' DAS LETZTE MAL', '  GESPEICHERT'],
    art: { kind: 'panelIcon', col: 7, row: 60, icon: 0x5d },
  },
  {
    lines: [' SIE HABEN VOR', '  EINER STUNDE', ' DAS LETZTE MAL', '  GESPEICHERT'],
    art: { kind: 'panelIcon', col: 7, row: 60, icon: 0x5d },
  },
  {
    lines: [' SIE WOLLTEN ZU', 'ZU DIESEM LAGER', ' GERUFEN WERDEN'],
    art: { kind: 'objectIcon', col: 4, row: 50, icon: 0xc0 },
  },
];

/**
 * Which message types carry a map position — the bit mask @0x27c9a. Set for 1..9, 12..15 and 19;
 * for those the opener jumps the view to the message position.
 */
export const MESSAGE_HAS_POSITION_MASK = 0x8f3fe;

/** Does this message type carry a map position? */
export function messageHasPosition(type: number): boolean {
  if (type < 0 || type > 31) return false;
  return (MESSAGE_HAS_POSITION_MASK & (1 << type)) !== 0;
}

/** Colour base of the colour box per player — the byte table @0x3a123. */
export const MESSAGE_FACE_BOX_COLORS: readonly number[] = [0x40, 0x48, 0x44, 0x4c];

/** Size of the colour box (`vreg2 = 0x30`, `vreg3 = 0x48` before the fill call). */
export const MESSAGE_FACE_BOX_W = 0x30;
export const MESSAGE_FACE_BOX_H = 0x48;

/** Face byte to panel-bank icon — just a name for {@link faceIcon}, which three screens call. */
export const messageFaceIcon = faceIcon;

/** State the popup needs for drawing. */
export interface MessagePopupState {
  /** Raw type byte of the list: lower 5 bits type, upper 3 bits parameter (`vp[0x96]`). */
  readonly typeByte: number;
  /**
   * Faces of the four players (`gs+0x1d6 + i*4`), for the colour-box variant. An empty slot has no
   * face; it counts as face 0 and thus gets icon 0x119.
   */
  readonly playerFaces: readonly (number | null | undefined)[];
  /** Game palette as RGBA (256 x 4 bytes) — only the colour box needs it. */
  readonly palette: Uint8Array | Uint8ClampedArray;
  /**
   * Text colour of the 19 message texts — RGB of palette index 0x1f, because all 19 handlers call
   * the panel text wrapper and that sets its foreground to 0x1f itself (@0x37cc6). Not optional:
   * without a colour {@link drawPanelText} blits the raw glyph pixels, which carry palette index 0.
   */
  readonly textColor: readonly [number, number, number];
}

/** Message type from the raw byte. */
export function messageType(typeByte: number): number {
  return typeByte & 0x1f;
}

/** Type-dependent parameter from the raw byte (upper 3 bits). */
export function messageParam(typeByte: number): number {
  return (typeByte >> 5) & 7;
}

/**
 * Lines whose German wording occurs more than once and is translated differently each time, because
 * the two language versions break the same message across lines differently. That cannot be
 * resolved through the wording, so the key is `type:line` and through it the address in the game
 * segment.
 *
 * `message-popup.test.ts` checks that exactly the ambiguous lines are listed here, so the list
 * cannot go stale when a language is added.
 */
export const MESSAGE_AMBIGUOUS_LINE_ADDR: ReadonlyMap<string, number> = new Map([
  ['5:2', 0x3a340],
  ['10:2', 0x3a289],
  ['11:0', 0x3a2a7],
  ['16:2', 0x3a36e],
  ['19:2', 0x3a3d8],
]);

/** One message line in the active language. */
export function messageLineText(type: number, index: number, de: string): string {
  const addr = MESSAGE_AMBIGUOUS_LINE_ADDR.get(`${type}:${index}`);
  return addr === undefined ? t(de) : tAt(addr);
}

/**
 * Draws the message popup. Returns `false` when the type has no handler (0 or > 19) — in the
 * original that would be a jump into a null table cell, so not a representable state.
 */
export function drawMessagePopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  state: MessagePopupState,
): boolean {
  const type = messageType(state.typeByte);
  const kind = MESSAGE_KINDS[type];
  if (kind === undefined || kind === null) return false;
  const param = messageParam(state.typeByte);

  tileBackground(fb, provider, MESSAGE_BG_ICON);
  drawPanelIcon(fb, provider, MESSAGE_OK_ICON.icon, MESSAGE_OK_ICON.col, MESSAGE_OK_ICON.row);

  kind.lines.forEach((line, i) => {
    const text = messageLineText(type, i, line);
    drawPanelText(fb, provider, text, 0, MESSAGE_TEXT_ROW0 + i * MESSAGE_TEXT_ROW_STEP, state.textColor);
  });

  const art = kind.art;
  if (art.kind === 'faceBox') {
    drawFaceBox(fb, provider, art.col, art.row, param, state.playerFaces, state.palette);
  } else if (art.kind === 'panelIcon') {
    drawPanelIcon(fb, provider, art.icon, art.col, art.row);
  } else if (art.kind === 'panelIconTable') {
    drawPanelIcon(fb, provider, art.table[param & 7]!, art.col, art.row);
  } else if (art.kind === 'objectIcon') {
    drawPanelIcon(fb, provider, art.icon, art.col, art.row, UI_OBJECT_BASE);
  } else if (art.kind === 'objectIconCases') {
    const hit = art.cases.find((c) => c.param === param) ?? art.otherwise;
    drawPanelIcon(fb, provider, hit.icon, hit.col, hit.row, UI_OBJECT_BASE);
  } else {
    drawPanelIcon(fb, provider, art.base + param, art.col, art.row, UI_OBJECT_BASE);
  }
  return true;
}

/**
 * Colour box plus face (`FUN_0003a070`): first a filled rectangle 0x30 x 0x48 in the player colour
 * at `(col*8, row + 5)`, then the face icon at `(col, row)` from the panel bank.
 *
 * The offset +5 and the plain `col*8` are in the original — deliberately not `panelX`/`panelY`,
 * because the fill primitive works directly on the popup surface.
 */
export function drawFaceBox(
  fb: Framebuffer,
  provider: SpriteProvider,
  col: number,
  row: number,
  player: number,
  faces: readonly (number | null | undefined)[],
  palette: Uint8Array | Uint8ClampedArray,
): void {
  const color = MESSAGE_FACE_BOX_COLORS[player & 3]!;
  const x0 = col * 8;
  const y0 = row + 5;
  for (let dy = 0; dy < MESSAGE_FACE_BOX_H; dy++) {
    for (let dx = 0; dx < MESSAGE_FACE_BOX_W; dx++) {
      plotPaletteIndex(fb, x0 + dx, y0 + dy, color, palette);
    }
  }
  drawPanelIcon(fb, provider, messageFaceIcon(faces[player] ?? 0), col, row);
}

/** Click zones (@0x2c6f0): a single zone with action 0xf1 — the confirm button. */
export const MESSAGE_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0xf1, x0: 0, x1: 127, y0: 0, y1: 143 },
];

/** Action id of the confirm button. */
export const MESSAGE_ACTION_CLOSE = 0xf1;

/**
 * The strip on the control panel through which the popup is reachable — not an icon slot but a fixed
 * area in the click dispatcher (@0x272d7): a 12 px wide column whose upper half shows the next
 * message and whose lower half returns to the remembered view.
 *
 * The numbers for the 640 full screen are in `viewport_init_640_full` @0x61bf.
 */
export const MESSAGE_PANEL_STRIP = {
  x: 0xb8,
  width: 0xc,
  y: 0x1b8,
  /** `dy <= 0x0f` means the upper half: next message. */
  showMaxDy: 0x0f,
  /** `dy > 0x1b` means the lower half: back to the remembered view. */
  returnMinDy: 0x1c,
} as const;

/**
 * The second column of the same click dispatch — the five clocks of the recall function. The
 * comparison @0x27350 uses a four pixel lead offset, unlike the message column next to it.
 *
 * The row mapping deliberately is not here: the dispatcher only tests the x column and computes the
 * row in the respective branch, and it does so in two different ways there (7 px versus 8 px rows,
 * see `engine/message-recall.ts`). This returns the panel-relative `dy` and lets the caller choose.
 */
export const RECALL_CLOCK_STRIP = {
  x: 0x1c0 - 4,
  width: 0xc,
  y: 0x1b8,
} as const;

/** Panel-relative `dy` when the click hits the clock column, otherwise `null`. */
export function hitRecallClockStrip(x: number, y: number): number | null {
  const dx = x - RECALL_CLOCK_STRIP.x;
  if (dx <= 0 || dx > RECALL_CLOCK_STRIP.width) return null;
  const dy = y - RECALL_CLOCK_STRIP.y;
  return dy < 0 ? null : dy;
}

/**
 * Screens on which the note is refused — the cascade @0x27852..0x2787b: the disk menu (0x17..0x1a)
 * and the quit/options dialogs 0x22, 0x23 and 0x25, i.e. the screens from which no jump into the
 * game world should be possible.
 *
 * Reachable in the port, because the panel stays operable while a popup is open.
 */
export function isMessageStripBlockedScreen(screen: number): boolean {
  if (screen < 0x17) return false;
  if (screen < 0x1b) return true;
  if (screen < 0x22) return false;
  if (screen < 0x24) return true;
  return screen === 0x25;
}

/**
 * What a click on the upper half of the strip (the note) triggers — three outcomes, each with its
 * own sound.
 *
 * `nothing` is the notable one: the strip sounds like a button even though nothing happens. The
 * refusal sound is only used when the open screen forbids the jump.
 */
export type MessageStripShowOutcome = 'show' | 'nothing' | 'blocked';

export function messageStripShowOutcome(
  hasMessage: boolean,
  roadBuilding: boolean,
  openScreen: number,
): MessageStripShowOutcome {
  if (!hasMessage) return 'nothing'; // @0x27814
  if (roadBuilding) return 'nothing'; // @0x2782f — `vp[1]` bit 7
  if (isMessageStripBlockedScreen(openScreen)) return 'blocked'; // @0x27852 ff.
  return 'show';
}

/** Which half of the panel strip a click hits, or `null`. */
export function hitMessagePanelStrip(x: number, y: number): 'show' | 'return' | null {
  const dx = x - MESSAGE_PANEL_STRIP.x;
  if (dx <= 0 || dx > MESSAGE_PANEL_STRIP.width) return null;
  const dy = y - MESSAGE_PANEL_STRIP.y;
  if (dy < 0) return null;
  if (dy <= MESSAGE_PANEL_STRIP.showMaxDy) return 'show';
  if (dy >= MESSAGE_PANEL_STRIP.returnMinDy) return 'return';
  return null;
}

/**
 * Message level filter — the table @0x33bc7 (20 bytes): message type to bit number in the control
 * options (`.DS`@72/73, see `view-options.ts`). Index 0 is `0xff`, the empty list slot, which is
 * never looked up.
 *
 * Options bits 3..5 are a thermometer (level 0..3), so the table values mean:
 * - 5 — visible from level 1: attack, combat lost, victory, land and buildings lost, emergency on/off
 * - 4 — from level 2: mine exhausted, building occupied, land lost, geologist finds
 * - 3 — level 3 only: new warehouse finished
 * - 0 — tied to bit 0 of the options: the recall messages and the two save reminders
 *
 * Bit 0 carries two meanings, and there is no special case for the value 0: between the table lookup
 * and the `bt` @0x337d6 there is no conditional jump, so the value goes into the bit test unchanged.
 * (For type 0 with value 0xff the CPU tests bit 15 of the 16-bit operand, which is always 0, so the
 * shortcut `bit > 7 ⇒ false` below is behaviourally equal.) The byte tested is `vp+0x86`, the
 * window's copy of the control options; bit 0 of the same byte is the road-building scroll switch.
 */
// prettier-ignore
export const MESSAGE_LEVEL_BIT: readonly number[] = [
  0xff, 5, 5, 5, 4, 0, 4, 3, 4, 5, 5, 5, 4, 4, 4, 4, 0, 0, 0, 0,
];

/**
 * Is a message shown under these control options? `typeByte` is the raw list byte (lower 5 bits are
 * the type), `viewOptions` the options byte of that screen half.
 */
export function messageIsVisible(typeByte: number, viewOptions: number): boolean {
  const type = messageType(typeByte);
  const bit = MESSAGE_LEVEL_BIT[type];
  if (bit === undefined || bit > 7) return false;
  return ((viewOptions >> bit) & 1) !== 0;
}

/**
 * Discards filtered messages — the preamble of the message overlay (loop @0x33780..@0x33880): while
 * the oldest message is invisible under {@link messageIsVisible} it is shifted out of the list and
 * the next one is tested. A filtered message is not merely hidden, it is gone.
 *
 * Returns the number of discarded messages. `message-overlay.ts` calls it in the frame service,
 * before the note state and before {@link popMessage} — the same order as the original.
 */
export function pruneFilteredMessages(
  types: number[],
  positions: number[],
  viewOptions: number,
): number {
  let dropped = 0;
  while ((types[0] ?? 0) !== 0 && !messageIsVisible(types[0]!, viewOptions)) {
    popMessage(types, positions);
    dropped++;
  }
  return dropped;
}

/**
 * Takes the oldest message out of the list — the tail of the opener @0x27c9a: the list is shifted
 * forward by one slot (up to 62 steps, stopping at the first empty successor) and the freed slot is
 * zeroed. That shifting is what enforces the prefix packing of the type column.
 */
export function popMessage(
  types: number[],
  positions: number[],
): { type: number; position: number } | null {
  const type = types[0] ?? 0;
  if (type === 0) return null;
  const position = positions[0] ?? 0;
  for (let i = 0; i < 62; i++) {
    if ((types[i + 1] ?? 0) === 0) {
      truncate(types, positions, i);
      return { type, position };
    }
    types[i] = types[i + 1]!;
    positions[i] = positions[i + 1]!;
  }
  // The original's cap: after 63 steps it terminates at index 62. Whatever was in slot 63 lies
  // behind the terminator afterwards and is lost — with a full list one read costs two entries.
  truncate(types, positions, 62);
  return { type, position };
}

/**
 * The original's terminator (@0x3384e) in our representation: the port keeps the type column
 * prefix-packed, so "type 0 at index i" means "the list is i long".
 *
 * Writing a 0 into the array and leaving its length would be wrong: `addPlayerMessage` appends, so
 * the next message would land behind a zero that every reader takes for the end of the list.
 */
function truncate(types: number[], positions: number[], length: number): void {
  types.length = length;
  positions.length = length;
}
