/**
 * **Flag window (popup screen 0x2a)** — the special click on an own flag.
 *
 * The window's title names its actual purpose: **WARENTRANSPORT** ("goods transport") — it shows the
 * six roads of the flag and for each whether a **carrier** works on it.
 *
 * ## Renderer `FUN_0003b213` (@0x3b213) — read back in the assembly, line by line
 *
 * ```
 * draw_popup_background(0x138)
 * player = vp[0x82]
 * bt $0x7, player[2] ; jne on       // playerFlags bit 7 = AI player => NO icon
 * call 0x4c9b3 ; js on              // return < 0 => no road passes by here
 * draw_panel_icon(7, 0x33, 0x135)   // "attach road"
 * on:
 * draw_popup_object_sprite(8, 0x28, 0x80 + 4*player[0])   // the flag in the player colour
 * flagIndex = player[0x176] ; je close_popup               // <- the window's subject
 * flag = &flags[flagIndex * 0x46]
 * vreg4 = 5 ; esi = 0x3b3be                                // table: 6 x {col u16, row u16}
 * do { col = *esi++ ; row = *esi++
 *   bt vreg4, flag[3] ; je next                            // no road in this direction
 *   icon = 0xdc ; bt vreg4, flag[5] ; je draw ; icon = 0x120   // road with carrier
 *   draw: draw_panel_icon(col, row, icon)
 *   next: } while (--vreg4 >= 0)                           // dir 5 -> 0
 *   draw_popup_panel_text(0, 4, "WARENTRANSPORT:")
 *   draw_panel_icon(7, 0x64, 0x1c)    // geologist
 *   draw_panel_icon(0xe, 0x80, 0x3c)  // exit
 * ```
 *
 * Two things only visible in the assembly: the **polarity** of both tests (`bt`/`setb`/`jne` resp.
 * `js`), and that the road wreath runs **downwards from direction 5** — the table is therefore in the
 * order Up, UpLeft, Left, Down, DownRight, Right.
 *
 * ## Subject: `player+0x176`
 *
 * The window does **not** read the tile under the cursor but its own UI pointer `player+0x176` (flag
 * index; `.DS` block offset **502**). If it is 0 the popup closes itself. Whoever opens the screen
 * must set it — in the original the special-click branch does, here the caller.
 */

import {
  blitSpriteNoPivot,
  drawPanelIcon,
  drawPanelText,
  hitTestPanel,
  panelX,
  panelY,
  tileBackground,
  UI_OBJECT_BASE,
  type Framebuffer,
  type HitRect,
  type SpriteProvider,
} from './ui-render.js';
import { t } from './language.js';

/** Background tile (`draw_popup_background(0x138)`). */
export const FLAG_POPUP_BG_ICON = 0x138;

/** Title and its panel position (`draw_popup_panel_text(0, 4, @0x3b3d6)`). */
export const FLAG_POPUP_TITLE = 'WARENTRANSPORT:';
export const FLAG_POPUP_TITLE_COL = 0;
export const FLAG_POPUP_TITLE_ROW = 4;

/** The flag itself: object bank `0x80 + 4*playerColour`, drawn at column 8 / row 0x28. */
export const FLAG_POPUP_FLAG_BASE = 0x80;
export const FLAG_POPUP_FLAG_COL = 8;
export const FLAG_POPUP_FLAG_ROW = 0x28;

/**
 * Road wreath: panel position per direction, table `@0x3b3be`. The index **is** the direction
 * (0 = Right, 1 = DownRight, 2 = Down, 3 = Left, 4 = UpLeft, 5 = Up); in the binary the table stands
 * in the loop's descending order (5 -> 0).
 */
export const FLAG_POPUP_ROAD_ROSE: readonly { readonly col: number; readonly row: number }[] = [
  { col: 11, row: 44 }, // 0 Right
  { col: 9, row: 64 }, //  1 DownRight
  { col: 5, row: 64 }, //  2 Down
  { col: 3, row: 44 }, //  3 Left
  { col: 5, row: 24 }, //  4 UpLeft
  { col: 9, row: 24 }, //  5 Up
];

/** Road icon without carrier (`0xdc`) and with carrier (`0x120`). */
export const FLAG_POPUP_ROAD_ICON = 0xdc;
export const FLAG_POPUP_ROAD_ICON_CARRIER = 0x120;

/** Geologist icon (icon bank `0x1c`) at column 7 / row 0x64. */
export const FLAG_POPUP_GEOLOGIST_ICON = 0x1c;
export const FLAG_POPUP_GEOLOGIST_COL = 7;
export const FLAG_POPUP_GEOLOGIST_ROW = 0x64;

/**
 * **"Attach road"** (icon bank `0x135`, red breaking arrows) at column 7 / row 0x33 — only under two
 * conditions (see below).
 *
 * The button **attaches a flag to a road running close past it**, not "demolish road" as the icon
 * suggests. The manual says so, and the code matches: the predicate `can_attach_flag_to_road`
 * (@0x4c9b3) requires a **flag** on the cursor tile, then looks for the direction pairs in which the
 * flag has **no** road and checks whether an equally-owned neighbour carries a road "past the corner"
 * there. The worker `FUN_0004ccdf` (@0x4ccdf) has the **same** six-check structure but calls
 * `FUN_0004d460(direction)` per hit — the actual attaching. Success => sound 4 + popup closed
 * (`jmp 0x2827c`), otherwise sound 2 and the window stays (@0x2db25 ff.).
 *
 * Confirmed in the game: at an ordinary through flag the icon does not appear — it really is rare.
 */
export const FLAG_POPUP_ATTACH_ROAD_ICON = 0x135;
export const FLAG_POPUP_ATTACH_ROAD_COL = 7;
export const FLAG_POPUP_ATTACH_ROAD_ROW = 0x33;

/** Exit (icon bank `0x3c`) at column 14 / row 0x80 — as in every popup with an exit. */
export const FLAG_POPUP_EXIT_ICON = 0x3c;
export const FLAG_POPUP_EXIT_COL = 14;
export const FLAG_POPUP_EXIT_ROW = 0x80;

// --- click zones ---------------------------------------------------------------------------------

/**
 * The walker of this screen (`@0x2c63f`, reached via `LAB_0002c09e + 0x2a*8`) picks its table **at
 * runtime**:
 *
 * ```
 * bt $0x5, gs[0x37e] ; je normal
 * esi = 0x2c7e4      // exit only
 * jmp popup_hittest_walker
 * normal:
 * esi = 0x2c7ea      // attach + geologist + exit
 * ```
 *
 * `gs+0x37e` bit 5 is game type 4 (demo); set => the window is display only.
 */
export const FLAG_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0xf7, x0: 0x38, x1: 0x47, y0: 0x33, y1: 0x41 }, // attach road
  { action: 0xc2, x0: 0x38, x1: 0x47, y0: 0x64, y1: 0x73 }, // geologist
  { action: 0x27, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f }, // exit
];

/** Variant with `gs+0x37e` bit 5 set (`@0x2c7e4`): the exit only. */
export const FLAG_POPUP_HITBOXES_VIEW_ONLY: readonly HitRect[] = [
  { action: 0x27, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** What a click in the flag window triggers. */
export type FlagPopupAction =
 /** Exit (`0x27` -> `FUN_0002827c`) — popup closed, panel slots 2..4 restored. */
  | { readonly kind: 'close'; readonly action: number; readonly label: string }
  /**
   * **Send a geologist to this flag** (`0xc2` -> `FUN_0002e4e4`): the handler derives the tile from
   * the player cursor, takes its flag index and calls `FUN_00012370` — "serf type **20** (geologist)
   * to this flag" (`vreg0 = 0x14`, then `FUN_000123d9`).
   */
  | { readonly kind: 'callGeologist'; readonly action: number; readonly label: string }
  /**
   * **Attach a road to this flag** (`0xf7` -> `action_attach_flag_to_road` @0x2db12 ->
   * `FUN_0004ccdf`), drawn only when `can_attach_flag_to_road` (@0x4c9b3) returns >= 0 for the
   * cursor. See {@link FLAG_POPUP_ATTACH_ROAD_ICON}.
   */
  | { readonly kind: 'attachRoad'; readonly action: number; readonly label: string };

/** Action id -> effect (handler table `@0x2cd66 + id*8`). */
export const FLAG_POPUP_ACTIONS: ReadonlyMap<number, FlagPopupAction> = new Map<
  number,
  FlagPopupAction
>([
  [0x27, { kind: 'close', action: 0x27, label: 'exit' }],
  [0xc2, { kind: 'callGeologist', action: 0xc2, label: 'send geologist' }],
  [0xf7, { kind: 'attachRoad', action: 0xf7, label: 'attach road' }],
]);

/** Click zones of the window. `viewOnly` == `gs+0x37e` bit 5. */
export function flagPopupHitboxes(viewOnly = false): readonly HitRect[] {
  return viewOnly ? FLAG_POPUP_HITBOXES_VIEW_ONLY : FLAG_POPUP_HITBOXES;
}

/**
 * Click in **drawing pixels** -> effect, or `null` (no hit). The renderer draws the attach icon only
 * conditionally; `attachRoadShown` hides its zone accordingly — in the original the zone is in the
 * table regardless, but without a drawn icon the player does not hit it on purpose, and the handler
 * re-checks anyway.
 */
export function flagPopupAction(
  drawX: number,
  drawY: number,
  opts: { viewOnly?: boolean; attachRoadShown?: boolean } = {},
): FlagPopupAction | null {
  const id = hitTestPanel(flagPopupHitboxes(opts.viewOnly === true), drawX, drawY);
  if (id === null) return null;
  if (id === 0xf7 && opts.attachRoadShown === false) return null;
  return FLAG_POPUP_ACTIONS.get(id) ?? null;
}

// --- drawing -------------------------------------------------------------------------------------

/** What the renderer needs to know about the flag — the two bytes `flag+3` and `flag+5`. */
export interface FlagPopupSubject {
  /** `flag+3` bits 0..5: road in this direction. */
  readonly paths: readonly boolean[];
  /** `flag+5` bits 0..5: a carrier works on this road. */
  readonly transporters: readonly boolean[];
}

/**
 * Draws the flag window in the original's order. `playerColor` is `player+0`, `attachRoad` the result
 * of the two original conditions — the caller decides, because both sources lie outside this
 * renderer. In the assembly (@0x3b235-@0x3b248):
 *
 * ```
 * al = player[2] ; bt $0x7 ; setb al ; or al,al ; jne done   // bit 7 = AI player => no icon
 * call can_attach_flag_to_road ; js done                     // return NEGATIVE => no icon
 * draw_panel_icon(0x135, column 7, row 0x33)
 * ```
 *
 * `flags` bit 7 == AI player, so the first condition simply means "human player". The second
 * (`can_attach_flag_to_road` @0x4c9b3) requires a **flag on the cursor tile** (`paths` bit 7) and then
 * checks six direction pairs against equally-owned neighbours.
 */
export function drawFlagPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  flag: FlagPopupSubject,
  opts: {
    playerColor?: number;
    attachRoad?: boolean;
    textColor: readonly [number, number, number];
  },
): void {
  tileBackground(fb, provider, FLAG_POPUP_BG_ICON);
  if (opts.attachRoad === true) {
    drawPanelIcon(fb, provider, FLAG_POPUP_ATTACH_ROAD_ICON, FLAG_POPUP_ATTACH_ROAD_COL, FLAG_POPUP_ATTACH_ROAD_ROW);
  }
  // The flag comes from the OBJECT bank (`draw_popup_object_sprite`), not the icon bank.
  const flagSprite = provider(UI_OBJECT_BASE + FLAG_POPUP_FLAG_BASE + 4 * (opts.playerColor ?? 0));
  if (flagSprite) {
    blitSpriteNoPivot(fb, flagSprite, panelX(FLAG_POPUP_FLAG_COL), panelY(FLAG_POPUP_FLAG_ROW));
  }
  for (let dir = 5; dir >= 0; dir--) {
    if (flag.paths[dir] !== true) continue;
    const icon =
      flag.transporters[dir] === true ? FLAG_POPUP_ROAD_ICON_CARRIER : FLAG_POPUP_ROAD_ICON;
    const at = FLAG_POPUP_ROAD_ROSE[dir]!;
    drawPanelIcon(fb, provider, icon, at.col, at.row);
  }
  drawPanelText(
    fb,
    provider,
    t(FLAG_POPUP_TITLE),
    FLAG_POPUP_TITLE_COL,
    FLAG_POPUP_TITLE_ROW,
    opts.textColor,
  );
  drawPanelIcon(fb, provider, FLAG_POPUP_GEOLOGIST_ICON, FLAG_POPUP_GEOLOGIST_COL, FLAG_POPUP_GEOLOGIST_ROW);
  drawPanelIcon(fb, provider, FLAG_POPUP_EXIT_ICON, FLAG_POPUP_EXIT_COL, FLAG_POPUP_EXIT_ROW);
}
