/**
 * **Attack window (popup screens 0x14 and 0x15)** — renderers `FUN_0003f729` @0x3f729 and
 * `FUN_0003f8dd` @0x3f8dd, click zones `@0x2cc21` (walker `@0x2c3cb`, the same table for **both**
 * screens).
 *
 * The last of the seven special-click screens and the only one with real actions: the player chooses
 * **how many knights** attack and sends them off. The displayed values are filled beforehand by the
 * attack preparation (`engine/attack.ts`).
 *
 * **Screen 0x15 is the same screen.** Its renderer only redraws the chosen number: four spaces with
 * `gs+0x1ca` bit 4 set (text then paints its own background and thereby erases the old number),
 * followed by the new number. That is why all counting buttons switch to 0x15 instead of redrawing
 * the whole window. Our renderer rebuilds every frame completely, so 0x15 is just another draw of
 * 0x14 ({@link ATTACK_POPUP_REDRAW_SCREEN}).
 */

import {
  drawLayout,
  drawPanelIcon,
  drawPanelNumber,
  hitTestPanel,
  panelX,
  panelY,
  blitSpriteNoPivot,
  tileBackground,
  UI_ICON_BASE,
  UI_OBJECT_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';

/** Background tile of this window (`draw_popup_background(0x83)`) — **not** the 0x138 of the others. */
export const ATTACK_POPUP_BG_ICON = 0x83;

/** Screen the counting buttons switch to in the original (partial redraw). */
export const ATTACK_POPUP_REDRAW_SCREEN = 0x15;

/**
 * **Scenery around the target** — first part of the table `@0x3f961`, 10 triples `(object, col, row)`,
 * `-1` terminated, drawn with `draw_popup_object_sprite` (i.e. from the **object** bank). These are
 * map objects (trees, rocks) — the landscape the target building stands in.
 */
// prettier-ignore
export const ATTACK_POPUP_SCENERY: readonly LayoutItem[] = [
  { icon: 0x00, col: 2, row: 0x21 }, { icon: 0x0a, col: 6, row: 0x1e },
  { icon: 0x07, col: 10, row: 0x21 }, { icon: 0x0c, col: 14, row: 0x1e },
  { icon: 0x0e, col: 2, row: 0x24 }, { icon: 0x02, col: 6, row: 0x27 },
  { icon: 0x0b, col: 10, row: 0x24 }, { icon: 0x04, col: 12, row: 0x27 },
  { icon: 0x08, col: 8, row: 0x2a }, { icon: 0x0f, col: 12, row: 0x2a },
];

/**
 * **Buttons** — second part of the same table, from `@0x3f99f`, with `draw_panel_icon` (icon bank):
 * four presets in a row, below them -/+, then 'ANGRIFF' (wide) and 'RAUS'.
 */
// prettier-ignore
export const ATTACK_POPUP_BUTTONS: readonly LayoutItem[] = [
  { icon: 0xd8, col: 1, row: 0x50 }, { icon: 0xd9, col: 5, row: 0x50 },
  { icon: 0xda, col: 9, row: 0x50 }, { icon: 0xdb, col: 13, row: 0x50 },
  { icon: 0xdc, col: 4, row: 0x70 }, { icon: 0xdd, col: 10, row: 0x70 },
  { icon: 0xde, col: 0, row: 0x80 }, { icon: 0x3c, col: 14, row: 0x80 },
];

/**
 * Sprite and row of the **target building**, by coded type (`@0x3f78e`):
 * ```
 * cmpw $0x2c -> row 0x32, sprite 0xab      // hut
 * cmpw $0x54 -> row 0x20, sprite 0x9e      // tower
 * cmpw $0x58 -> row 0x11, sprite 0x98      // fortress
 * else       -> row 0,    sprite 0xb2      // castle
 * ```
 * Always in **column 0** — the width rule of the other windows does not apply here.
 */
export function attackPopupTargetSprite(codedType: number): { sprite: number; row: number } {
  if (codedType === 0x2c) return { sprite: 0xab, row: 0x32 };
  if (codedType === 0x54) return { sprite: 0x9e, row: 0x20 };
  if (codedType === 0x58) return { sprite: 0x98, row: 0x11 };
  return { sprite: 0xb2, row: 0 };
}
export const ATTACK_POPUP_TARGET_COL = 0;

/** The four band numbers below the preset buttons (`(1|5|9|0xd, 0x60)`). */
export const ATTACK_POPUP_BAND_COLS: readonly number[] = [1, 5, 9, 0xd];
export const ATTACK_POPUP_BAND_ROW = 0x60;

/**
 * The **chosen number**: column 7, row 0x74. Before it the original erases four spaces from column 6
 * (`gs+0x1ca` bit 4 = text paints its own background) — moot for a fully rebuilt frame.
 */
export const ATTACK_POPUP_CHOICE_COL = 7;
export const ATTACK_POPUP_CHOICE_ROW = 0x74;

/**
 * Click zones `@0x2cc21` — `0xff` terminated, in table order. The 'ANGRIFF' button is **four columns
 * wide** with `0x00..0x1f`, every other one is a single column.
 */
export const ATTACK_POPUP_HITBOXES: readonly HitRect[] = [
  { action: 0x4a, x0: 0x20, x1: 0x2f, y0: 0x70, y1: 0x7f },
  { action: 0x4b, x0: 0x50, x1: 0x5f, y0: 0x70, y1: 0x7f },
  { action: 0x4c, x0: 0x00, x1: 0x1f, y0: 0x80, y1: 0x8f },
  { action: 0x4d, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
  { action: 0xd3, x0: 0x08, x1: 0x17, y0: 0x50, y1: 0x67 },
  { action: 0xd4, x0: 0x28, x1: 0x37, y0: 0x50, y1: 0x67 },
  { action: 0xd5, x0: 0x48, x1: 0x57, y0: 0x50, y1: 0x67 },
  { action: 0xd6, x0: 0x68, x1: 0x77, y0: 0x50, y1: 0x67 },
];

/**
 * What a click triggers — the action ids via the handler table `@0x2cd66`:
 *
 * | id | handler | effect |
 * |---|---|---|
 * | `0x4a` | `FUN_000314f6` | one knight fewer |
 * | `0x4b` | `FUN_0003164d` | one more (up to available, at most 100) |
 * | `0x4c` | `FUN_0003169c` | **launch the attack** |
 * | `0x4d` | `FUN_0002860b` | close the window |
 * | `0xd3`..`0xd6` | `FUN_0003152b`/`31560`/`31595`/`315f1` | preset: sum of the first 1..4 bands |
 */
export type AttackPopupAction =
  | { readonly kind: 'decrement'; readonly action: number }
  | { readonly kind: 'increment'; readonly action: number }
  | { readonly kind: 'launch'; readonly action: number }
  | { readonly kind: 'close'; readonly action: number }
  | { readonly kind: 'preset'; readonly action: number; readonly bands: number };

/** Click in **drawing pixels** -> action or `null`. */
export function attackPopupAction(drawX: number, drawY: number): AttackPopupAction | null {
  const action = hitTestPanel(ATTACK_POPUP_HITBOXES, drawX, drawY);
  if (action === null) return null;
  if (action === 0x4a) return { kind: 'decrement', action };
  if (action === 0x4b) return { kind: 'increment', action };
  if (action === 0x4c) return { kind: 'launch', action };
  if (action === 0x4d) return { kind: 'close', action };
  return { kind: 'preset', action, bands: action - 0xd3 + 1 };
}

/**
 * **Draw screen 0x14** — `FUN_0003f729`:
 *
 * ```
 * draw_popup_background(0x83)
 * table @0x3f961 part 1 -> draw_popup_object_sprite (scenery)
 * target = &buildings[player[0x134] · 0x12]
 * (sprite, row) = by (target[4] & 0xfc)
 * draw_popup_object_sprite(0, row, sprite)
 * table @0x3f961 part 2 -> draw_panel_icon (buttons)
 * draw_popup_number(1,   0x60, player[0x12a])      // band 0
 * draw_popup_number(5,   0x60, player[0x12c])      // band 1
 * draw_popup_number(9,   0x60, player[0x12e])      // band 2
 * draw_popup_number(0xd, 0x60, player[0x130])      // band 3
 * gs[0x1ca] |= 0x10 ; draw_popup_panel_text(6, 0x74, "    ") ; gs[0x1ca] &= 0xef
 * draw_popup_number(7, 0x74, player[0x136])        // the chosen number
 * ```
 *
 * The renderer walks the two-part table with **one** pointer: after the `-1` of the first part it
 * draws the target building and then calls `draw_popup_icon_layout`, which continues right there.
 */
export function drawAttackPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  view: {
    /** Coded type of the target (`bld[4] & 0xfc`). */
    readonly targetCodedType: number;
    /** `attackingKnights[0..3]` — knights that can be spared per distance band. */
    readonly bands: readonly number[];
    /** `knightsAttacking` — the chosen number. */
    readonly chosen: number;
  },
): void {
  tileBackground(fb, provider, ATTACK_POPUP_BG_ICON);
  drawLayout(fb, provider, ATTACK_POPUP_SCENERY, UI_OBJECT_BASE);

  const target = attackPopupTargetSprite(view.targetCodedType);
  const spr = provider(UI_OBJECT_BASE + target.sprite);
  if (spr) blitSpriteNoPivot(fb, spr, panelX(ATTACK_POPUP_TARGET_COL), panelY(target.row));

  drawLayout(fb, provider, ATTACK_POPUP_BUTTONS, UI_ICON_BASE);

  ATTACK_POPUP_BAND_COLS.forEach((col, i) => {
    drawPanelNumber(fb, provider, view.bands[i] ?? 0, col, ATTACK_POPUP_BAND_ROW);
  });
  drawPanelNumber(fb, provider, view.chosen, ATTACK_POPUP_CHOICE_COL, ATTACK_POPUP_CHOICE_ROW);
}

/** Only the two footer buttons (for callers that place the frame themselves). */
export function drawAttackPopupFooter(fb: Framebuffer, provider: SpriteProvider): void {
  for (const it of ATTACK_POPUP_BUTTONS.slice(6)) {
    drawPanelIcon(fb, provider, it.icon, it.col, it.row);
  }
}
