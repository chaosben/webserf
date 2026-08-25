/**
 * Statistics menu (screen 8) and distribution/options menu (screen 0x24) - the two selection popups of
 * the right-hand panel tabs. In the original both are purely static icon layouts; their contents hang
 * on their sub-screens.
 *
 * | screen | renderer | click walker | zone table |
 * |---|---|---|---|
 * | 8 | `FUN_0003d183` | `FUN_0002c377` | `@0x2cb1c` - 10 zones |
 * | 0x24 | `FUN_0003d23d` | `FUN_0002c412` | `@0x2ca2b` - 13 zones |
 *
 * `draw_popup_icon_layout` walks `{icon, col, row}` triples until a negative icon appears and draws
 * each at `x = col*8 + 8`, `y = row + 9` from the UI icon bank - which is what {@link drawLayout} does.
 * The click walker fetches its zone table WITHOUT off-by-one, unlike the renderer dispatch. Every zone
 * here coincides pixel-exactly with its layout icon.
 *
 * This module only draws the two menu areas; the target screens of the category icons and of the three
 * footer buttons have their own modules. Executed here are the two actions that stay INSIDE these
 * menus: close and page (which opens the other of the two).
 */
import {
  drawLayout,
  hitTestPanel,
  tileBackground,
  UI_ICON_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';

/** Background tile icon of screen 8 (`draw_popup_background(0x81)`). */
export const STAT_MENU_BG_ICON = 0x81;
/** Background tile icon of screen 0x24 (`draw_popup_background(0x137)`). */
export const SETTINGS_MENU_BG_ICON = 0x137;

/** Statistics menu (screen 8) — layout table `@0x3d1a2`. */
export const STAT_MENU_LAYOUT: readonly LayoutItem[] = [
  { icon: 0x48, col: 1, row: 12 },
  { icon: 0x49, col: 6, row: 12 },
  { icon: 0x4d, col: 11, row: 12 },
  { icon: 0x4a, col: 1, row: 0x38 },
  { icon: 0x4c, col: 6, row: 0x38 },
  { icon: 0x4b, col: 11, row: 0x38 },
  { icon: 0x47, col: 1, row: 0x64 },
  { icon: 0x46, col: 6, row: 0x64 },
  { icon: 0x3d, col: 12, row: 0x68 }, // page
  { icon: 0x3c, col: 14, row: 0x80 }, // close
];

/** Distribution/options menu (screen 0x24) — first layout table `@0x3d1ff`. */
export const SETTINGS_MENU_LAYOUT: readonly LayoutItem[] = [
  { icon: 0xe6, col: 1, row: 8 },
  { icon: 0xe7, col: 6, row: 8 },
  { icon: 0xe8, col: 11, row: 8 },
  { icon: 0xea, col: 1, row: 0x30 },
  { icon: 0xeb, col: 6, row: 0x30 },
  { icon: 0x12b, col: 11, row: 0x30 },
  { icon: 0xe9, col: 1, row: 0x58 },
  { icon: 0x12a, col: 6, row: 0x58 },
  { icon: 0x3d, col: 12, row: 0x68 }, // page
  { icon: 0x3c, col: 14, row: 0x80 }, // close
];

/** Distribution/options menu — second layout table `@0x3d266` (the three footer icons). */
export const SETTINGS_MENU_LAYOUT_FOOTER: readonly LayoutItem[] = [
  { icon: 0x11d, col: 4, row: 0x80 },
  { icon: 0x11e, col: 0, row: 0x80 },
  { icon: 0xe0, col: 8, row: 0x80 },
];

/**
 * Click zones of the statistics menu (screen 8) — table `@0x2cb1c`, format `{action, x0, x1, y0, y1}`
 * (byte records, terminated by `0xff`). Coordinates in click-rectangle space (drawing pixels minus
 * (8, 9)); the order is the table's, not the layout's.
 */
export const STAT_MENU_HITBOXES: readonly HitRect[] = [
  { action: 0x1d, x0: 0x08, x1: 0x27, y0: 0x0c, y1: 0x2b },
  { action: 0x1e, x0: 0x30, x1: 0x4f, y0: 0x0c, y1: 0x2b },
  { action: 0x24, x0: 0x58, x1: 0x77, y0: 0x0c, y1: 0x2b },
  { action: 0x23, x0: 0x08, x1: 0x27, y0: 0x38, y1: 0x57 },
  { action: 0x20, x0: 0x30, x1: 0x4f, y0: 0x38, y1: 0x57 },
  { action: 0x21, x0: 0x58, x1: 0x77, y0: 0x38, y1: 0x57 },
  { action: 0x22, x0: 0x08, x1: 0x27, y0: 0x64, y1: 0x83 },
  { action: 0x1f, x0: 0x30, x1: 0x4f, y0: 0x64, y1: 0x83 },
  { action: 0x27, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f }, // "RAUS"
  { action: 0xb9, x0: 0x60, x1: 0x6f, y0: 0x68, y1: 0x77 }, // page
];

/**
 * Click zones of the distribution/options menu (screen 0x24) — table `@0x2ca2b`, same format.
 */
export const SETTINGS_MENU_HITBOXES: readonly HitRect[] = [
  { action: 0xac, x0: 0x00, x1: 0x1f, y0: 0x80, y1: 0x8f }, // ENDE
  { action: 0xad, x0: 0x20, x1: 0x3f, y0: 0x80, y1: 0x8f }, // EXTRA OPTION
  { action: 0xae, x0: 0x40, x1: 0x5f, y0: 0x80, y1: 0x8f }, // SICHERN
  { action: 0x5d, x0: 0x08, x1: 0x27, y0: 0x08, y1: 0x27 },
  { action: 0x5e, x0: 0x30, x1: 0x4f, y0: 0x08, y1: 0x27 },
  { action: 0x5f, x0: 0x58, x1: 0x77, y0: 0x08, y1: 0x27 },
  { action: 0x61, x0: 0x08, x1: 0x27, y0: 0x30, y1: 0x4f },
  { action: 0x62, x0: 0x30, x1: 0x4f, y0: 0x30, y1: 0x4f },
  { action: 0xca, x0: 0x58, x1: 0x77, y0: 0x30, y1: 0x4f },
  { action: 0x60, x0: 0x08, x1: 0x27, y0: 0x58, y1: 0x77 },
  { action: 0xc9, x0: 0x30, x1: 0x4f, y0: 0x58, y1: 0x77 },
  { action: 0x5c, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f }, // "RAUS"
  { action: 0xba, x0: 0x60, x1: 0x6f, y0: 0x68, y1: 0x77 }, // page
];

/**
 * **Screen 0x1b** — the table of screen 0x24 without its first three (footer) zones. In the original
 * this is not a table of its own but the same memory 15 bytes on (`@0x2ca3a` vs. `@0x2ca2b`).
 */
export const SETTINGS_MENU_NO_FOOTER_HITBOXES: readonly HitRect[] = SETTINGS_MENU_HITBOXES.slice(3);

// --- Actions -------------------------------------------------------------------------------------

/**
 * What a click in one of the two menus triggers. All four cases sit in the handler table
 * `@0x2cd66 + id*8` (each cell a `jmp` plus three `nop`).
 */
export type MenuPopupAction =
  /**
   * **Close** ("RAUS", icon 0x3c bottom right). Screen 8 -> `FUN_0002827c`, screen 0x24 ->
   * `FUN_0002820b` — two addresses, **byte-identical body**, the same as closing via the panel tab:
   * `vp[1] &= ~0x40; vp[0x62..0x64] = {10, 0xc, 0xe}; vp[1] |= 2; vp[0x72] = 0; vp[1] |= 4`.
   */
  | { readonly kind: 'close'; readonly action: number; readonly label: string }
  /**
   * **Page** (icon 0x3d, `@0x2db4d` / `@0x2db98`): opens the *other* of the two menus and rewrites
   * panel slots 3/4 so the pressed tab travels along. Screen 8 -> 0x24 (`vp[0x63]=0x0b`,
   * `vp[0x64]=0x15`), screen 0x24 -> 8 (`vp[0x63]=0x14`, `vp[0x64]=0x0d`).
   *
   * The paging branch of screen 8 additionally tests `vp[1]` bit 0 and then goes to screen **0x1b**
   * instead of 0x24 (the same alternative as panel icon 0x0e/0x15). Bit 0 is not modelled here; we
   * take the normal case 0x24.
   */
  | {
      readonly kind: 'page';
      readonly action: number;
      readonly screen: number;
      /** `vp[0x63]` / `vp[0x64]` — panel slots 3 and 4. */
      readonly barSlot3: number;
      readonly barSlot4: number;
      readonly label: string;
    }
  /**
   * A **sub-screen** of another module (statistics, distribution, options, disk). `screen` is the
   * handler's `vp[0x70]` assignment; the caller opens it.
   */
  | {
      readonly kind: 'screen';
      readonly action: number;
      readonly screen: number;
      readonly label: string;
    }
  /**
   * **"SICHERN"** (`0xae`, `@0x2eb39`) — the disk menu in **save** mode: `vp[0x63..0x64] = {0xb, 0xd}`,
   * `vp[1]` **btr 6**, `vp[0x70] = 0x17` and `gs[0x1c8]` **bts 2**.
   *
   * A case of its own rather than `screen`, because two things belong to it that a screen assignment
   * does not express: the mode (bit 2) and a **gate in front** — `gs[0x37e]` bit 2 (second human
   * player) **and** `gs[0x7c][1]` bit 7 give sound 4 (rejected) instead of 2, so saving is blocked in
   * split screen (@0x2eb44/@0x2eb61).
   */
  | { readonly kind: 'saveGame'; readonly action: number; readonly label: string }
  /** A handler that does more than set a screen (quit the game). */
  | { readonly kind: 'other'; readonly action: number; readonly label: string };

/**
 * Action id -> effect for the **statistics menu**. The eight category handlers sit close together
 * (`@0x3105c` ... `@0x310c5`) and each consist of `mov $screen,%ax; mov %ax,0x70(%ebx)`.
 *
 * The original manual (ch. 4.3.1/4.3.2) names four of the eight categories by their position:
 * middle-left = stock, middle-middle = buildings, middle-right = people, bottom-middle = comparison.
 * It does not name the three icons of the top row nor the curve at bottom left — those therefore
 * carry only their screen number.
 */
export const STAT_MENU_ACTIONS: ReadonlyMap<number, MenuPopupAction> = new Map<
  number,
  MenuPopupAction
>([
  [0x1d, { kind: 'screen', action: 0x1d, screen: 0x10, label: 'statistics sub-screen 0x10' }],
  [0x1e, { kind: 'screen', action: 0x1e, screen: 0x11, label: 'statistics sub-screen 0x11' }],
  [0x24, { kind: 'screen', action: 0x24, screen: 0x13, label: 'statistics sub-screen 0x13' }],
  [0x23, { kind: 'screen', action: 0x23, screen: 0x09, label: 'stock statistics' }],
  [0x20, { kind: 'screen', action: 0x20, screen: 0x0a, label: 'building statistics' }],
  [0x21, { kind: 'screen', action: 0x21, screen: 0x12, label: 'people statistics' }],
  [0x22, { kind: 'screen', action: 0x22, screen: 0x0f, label: 'statistics sub-screen 0x0f' }],
  [0x1f, { kind: 'screen', action: 0x1f, screen: 0x0e, label: 'comparison statistics' }],
  [0x27, { kind: 'close', action: 0x27, label: 'close' }],
  [
    0xb9,
    { kind: 'page', action: 0xb9, screen: 0x24, barSlot3: 0x0b, barSlot4: 0x15, label: 'page' },
  ],
]);

/**
 * Action id -> effect for the **distribution/options menu**. The eight category handlers
 * (`@0x30b55` ... `@0x30fae`) first test whether the same screen is already open in the other
 * viewport (`gs+0x37e` bit 6 -> error tone only, as with the soil samples) and then set their screen.
 */
export const SETTINGS_MENU_ACTIONS: ReadonlyMap<number, MenuPopupAction> = new Map<
  number,
  MenuPopupAction
>([
  [0x5d, { kind: 'screen', action: 0x5d, screen: 0x1c, label: 'distribution sub-screen 0x1c' }],
  [0x5e, { kind: 'screen', action: 0x5e, screen: 0x1d, label: 'distribution sub-screen 0x1d' }],
  [0x5f, { kind: 'screen', action: 0x5f, screen: 0x1e, label: 'distribution sub-screen 0x1e' }],
  [0x61, { kind: 'screen', action: 0x61, screen: 0x20, label: 'distribution sub-screen 0x20' }],
  [0x62, { kind: 'screen', action: 0x62, screen: 0x21, label: 'distribution sub-screen 0x21' }],
  [0xca, { kind: 'screen', action: 0xca, screen: 0x2e, label: 'distribution sub-screen 0x2e' }],
  [0x60, { kind: 'screen', action: 0x60, screen: 0x1f, label: 'distribution sub-screen 0x1f' }],
  [0xc9, { kind: 'screen', action: 0xc9, screen: 0x2d, label: 'distribution sub-screen 0x2d' }],
  // Footer: "ENDE" (@0x2eac1) goes to screen 0x22, "EXTRA OPTION" (@0x2eafd) to 0x25, "SICHERN"
  // (@0x2eb39) to **0x17** — all three write `vp[0x63..0x64] = {0xb, 0xd}` beforehand. "SICHERN" IS
  // a screen change (@0x2ebb7 sets `vp[0x70] = 0x17`); its handler only does **more** than that
  // (mode plus split-screen gate).
  [0xac, { kind: 'screen', action: 0xac, screen: 0x22, label: 'ENDE' }],
  [0xad, { kind: 'screen', action: 0xad, screen: 0x25, label: 'EXTRA OPTION' }],
  [0xae, { kind: 'saveGame', action: 0xae, label: 'SICHERN' }],
  [0x5c, { kind: 'close', action: 0x5c, label: 'close' }],
  [
    0xba,
    { kind: 'page', action: 0xba, screen: 8, barSlot3: 0x14, barSlot4: 0x0d, label: 'page' },
  ],
]);

/** Click zones of a menu screen (empty if `screen` is neither of the two menus). */
export function menuPopupHitboxes(screen: number): readonly HitRect[] {
  if (screen === 8) return STAT_MENU_HITBOXES;
  if (screen === 0x24) return SETTINGS_MENU_HITBOXES;
  if (screen === 0x1b) return SETTINGS_MENU_NO_FOOTER_HITBOXES;
  return [];
}

/**
 * Resolves a click (in **drawing pixels**) in one of the two menus: the screen's zone table -> action
 * id -> effect. `null` if the screen is neither menu or the click hits nothing.
 */
export function menuPopupAction(
  screen: number,
  drawX: number,
  drawY: number,
): MenuPopupAction | null {
  const table =
    screen === 8
      ? STAT_MENU_ACTIONS
      : screen === 0x24 || screen === 0x1b
        ? SETTINGS_MENU_ACTIONS
        : null;
  if (table === null) return null;
  const id = hitTestPanel(menuPopupHitboxes(screen), drawX, drawY);
  if (id === null) return null;
  return table.get(id) ?? null;
}

/** Draws the statistics menu (screen 8) — `FUN_0003d183`. */
export function drawStatMenu(fb: Framebuffer, provider: SpriteProvider): void {
  tileBackground(fb, provider, STAT_MENU_BG_ICON);
  drawLayout(fb, provider, STAT_MENU_LAYOUT, UI_ICON_BASE);
}

/** Draws the distribution/options menu (screen 0x24) — `FUN_0003d23d` (both layout tables). */
export function drawSettingsMenu(fb: Framebuffer, provider: SpriteProvider): void {
  tileBackground(fb, provider, SETTINGS_MENU_BG_ICON);
  drawLayout(fb, provider, SETTINGS_MENU_LAYOUT, UI_ICON_BASE);
  drawLayout(fb, provider, SETTINGS_MENU_LAYOUT_FOOTER, UI_ICON_BASE);
}

/**
 * **Screen 0x1b — the same menu without the footer.** Renderer `FUN_0003d1e0`: background `0x137` plus
 * *only* the first layout table. The eight sub-screens return here via "RAUS", and screen 8 pages here
 * when `vp[1]` bit 0 is set.
 *
 * Click table `@0x2ca3a` — which is the **same memory** as that of screen 0x24 (`@0x2ca2b`), just 15
 * bytes later: the three footer zones ("ENDE"/"EXTRA OPTION"/"SICHERN", 3 x 5 bytes) sit in front,
 * after which 0x24 runs into exactly this table. That is why `slice(3)` below is not a truncation but
 * the original's table.
 */
export function drawSettingsMenuNoFooter(fb: Framebuffer, provider: SpriteProvider): void {
  tileBackground(fb, provider, SETTINGS_MENU_BG_ICON);
  drawLayout(fb, provider, SETTINGS_MENU_LAYOUT, UI_ICON_BASE);
}

/** Screens {@link drawMenuPopup} can draw. */
export const MENU_SCREENS: ReadonlySet<number> = new Set([8, 0x1b, 0x24]);

/** Dispatcher for the menu screens (like the original renderer jump). */
export function drawMenuPopup(fb: Framebuffer, provider: SpriteProvider, screen: number): void {
  if (screen === 8) drawStatMenu(fb, provider);
  else if (screen === 0x24) drawSettingsMenu(fb, provider);
  else if (screen === 0x1b) drawSettingsMenuNoFooter(fb, provider);
}
