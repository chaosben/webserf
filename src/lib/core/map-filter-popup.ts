/**
 * **The building selection of the map view** (popup screens 0x2f..0x32) — four paged screens on
 * which you pick *what* the building overlay of the overview map should show.
 *
 * | screen | renderer | zone table | actions | content |
 * |---|---|---|---|---|
 * | 0x2f | `@0x3ff88` | `@0x2c701`, 7 | `d7 d8 d9 da` + `ee` | warehouse, tower, hut, fortress + **flag** |
 * | 0x30 | `@0x3ffea` | `@0x2c725`, 9 | `db..e1` | toolmaker ... lumberjack (7) |
 * | 0x31 | `@0x4000a` | `@0x2c753`, 8 | `e2..e7` | pig farm ... baker (6) |
 * | 0x32 | `@0x4002a` | `@0x2c77c`, 8 | `e8..ed` | the four mines + the two smelters |
 *
 * All four share `ef` (**page**) and `f0` (**exit**) as well as the drawing tail `@0x40048` (page
 * icon `0x3d` bottom left, exit `0x3c` bottom right). The four renderers only look independent
 * because a `jmp` at the end inlines the shared tail.
 *
 * Each of the 24 action ids is a thunk `mov $index,%eax ; mov %eax,(%edi) ; jmp 0x2dd31` that sets an
 * index **0..23** and falls into the shared tail `@0x2dd31`:
 *
 * ```
 * vp[0xd1] |= 0x08          // bts $0x3 — building overlay ON
 * vp[0x70] = 1              // back to the map (screen 1)
 * vp[0x2e] = index          // the filter
 * ```
 *
 * `vp+0x2e` is the building/flag filter of the overview map (`map-preview.ts`: `< 0` all buildings,
 * `0` flag mode, `> 0` only this building type) — the same field the third bar icon of the map
 * toggles. The index is therefore the building type enum, with 0 as flag mode.
 *
 * The entry point is the **special click** on the building icon of the map bar: `@0x2fdc4` tests
 * `vp[1]` bit 3 and opens screen 0x2f instead of merely toggling the overlay.
 *
 * The zone-to-type mapping comes from those 24 thunks and matches the independently known
 * sprite-to-type table of the build menu position for position, 23/23; together the 24 indices cover
 * `{0..23}` without a gap, i.e. flag plus all 23 buildable types (the castle is not buildable).
 */

import {
  blitSpriteNoPivot,
  drawLayout,
  drawPanelIcon,
  hitTestPanel,
  panelX,
  panelY,
  tileBackground,
  UI_OBJECT_BASE,
  type Framebuffer,
  type HitRect,
  type LayoutItem,
  type SpriteProvider,
} from './ui-render.js';
import { PREVIEW_BUILDINGS } from './map-preview.js';

/** Background tile of all four pages (`draw_popup_background(0x139)`). */
export const MAP_FILTER_BG_ICON = 0x139;

/** The four screen numbers in paging order. */
export const MAP_FILTER_SCREENS: readonly number[] = [0x2f, 0x30, 0x31, 0x32];

/**
 * Page icon (`0x3d`) and exit (`0x3c`) of the shared tail `@0x40048`. No layout table: the original
 * calls `draw_panel_icon` twice with fixed values there.
 */
export const MAP_FILTER_PAGE_ICON = { icon: 0x3d, col: 0, row: 0x80 } as const;
export const MAP_FILTER_EXIT_ICON = { icon: 0x3c, col: 14, row: 0x80 } as const;

/**
 * The flag preview of screen 0x2f: `sprite = 0x80 + 4*playerColour` at column 4 / row 0x70
 * (`@0x3ff98`..`@0x3ffd5`) — the same stride of 4 as the build menu's flag preview.
 */
export const MAP_FILTER_FLAG_BASE = 0x80;
export const MAP_FILTER_FLAG_COL = 4;
export const MAP_FILTER_FLAG_ROW = 0x70;

// --- layout tables (verbatim, object bank, `{icon, col, row}` up to the negative entry) ----------

/** Screen 0x2f — table `@0x40085`. */
export const MAP_FILTER_LAYOUT_2F: readonly LayoutItem[] = [
  { icon: 0xc0, col: 0, row: 5 }, // warehouse (10)
  { icon: 0xab, col: 2, row: 77 }, // guard hut (11)
  { icon: 0x9e, col: 8, row: 7 }, // tower (21)
  { icon: 0x98, col: 6, row: 69 }, // fortress (22)
];

/** Screen 0x30 — table `@0x4009f`. */
export const MAP_FILTER_LAYOUT_30: readonly LayoutItem[] = [
  { icon: 0x99, col: 0, row: 4 }, // toolmaker (19)
  { icon: 0xa0, col: 8, row: 6 }, // sawmill (17)
  { icon: 0x9d, col: 0, row: 68 }, // weaponsmith (20)
  { icon: 0xa9, col: 8, row: 65 }, // stonecutter (4)
  { icon: 0xae, col: 12, row: 57 }, // boatbuilder (3)
  { icon: 0xaa, col: 4, row: 105 }, // forester (9)
  { icon: 0xa8, col: 8, row: 107 }, // lumberjack (2)
];

/** Screen 0x31 — table `@0x400cb`. */
export const MAP_FILTER_LAYOUT_31: readonly LayoutItem[] = [
  { icon: 0x9b, col: 0, row: 2 }, // pig farm (14)
  { icon: 0x9a, col: 8, row: 3 }, // farm (12)
  { icon: 0xa7, col: 0, row: 61 }, // fisher (1)
  { icon: 0x9c, col: 8, row: 60 }, // butcher (13)
  { icon: 0xbc, col: 4, row: 75 }, // mill (15)
  { icon: 0xa2, col: 8, row: 100 }, // baker (16)
];

/** Screen 0x32 — table `@0x400f1`. */
export const MAP_FILTER_LAYOUT_32: readonly LayoutItem[] = [
  { icon: 0xa3, col: 0, row: 4 }, // stone mine (5)
  { icon: 0xa4, col: 4, row: 4 }, // coal mine (6)
  { icon: 0xa5, col: 8, row: 4 }, // iron mine (7)
  { icon: 0xa6, col: 12, row: 4 }, // gold mine (8)
  { icon: 0xa1, col: 2, row: 90 }, // steel smelter (18)
  { icon: 0x9f, col: 8, row: 90 }, // gold smelter (23)
];

// --- click tables (verbatim, `{action, x0, x1, y0, y1}` up to the `0xff` terminator) --------------

/** Screen 0x2f — table `@0x2c701`, 7 zones. */
export const MAP_FILTER_HITBOXES_2F: readonly HitRect[] = [
  { action: 0xd7, x0: 0x00, x1: 0x3f, y0: 0x00, y1: 0x32 }, // warehouse
  { action: 0xd8, x0: 0x40, x1: 0x6f, y0: 0x00, y1: 0x32 }, // tower
  { action: 0xd9, x0: 0x10, x1: 0x2f, y0: 0x40, y1: 0x5f }, // guard hut
  { action: 0xda, x0: 0x30, x1: 0x6f, y0: 0x3c, y1: 0x82 }, // fortress
  { action: 0xee, x0: 0x19, x1: 0x28, y0: 0x6e, y1: 0x87 }, // flag
  { action: 0xef, x0: 0x00, x1: 0x0f, y0: 0x80, y1: 0x8f }, // page
  { action: 0xf0, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f }, // exit
];

/** Screen 0x30 — table `@0x2c725`, 9 zones. */
export const MAP_FILTER_HITBOXES_30: readonly HitRect[] = [
  { action: 0xdb, x0: 0x00, x1: 0x3f, y0: 0x00, y1: 0x37 }, // toolmaker
  { action: 0xdc, x0: 0x40, x1: 0x5f, y0: 0x00, y1: 0x32 }, // sawmill
  { action: 0xdd, x0: 0x00, x1: 0x3f, y0: 0x40, y1: 0x5f }, // weaponsmith
  { action: 0xde, x0: 0x40, x1: 0x5f, y0: 0x40, y1: 0x5f }, // stonecutter
  { action: 0xdf, x0: 0x60, x1: 0x7f, y0: 0x3c, y1: 0x5f }, // boatbuilder
  { action: 0xe0, x0: 0x20, x1: 0x3f, y0: 0x68, y1: 0x8b }, // forester
  { action: 0xe1, x0: 0x40, x1: 0x5f, y0: 0x68, y1: 0x8b }, // lumberjack
  { action: 0xef, x0: 0x00, x1: 0x0f, y0: 0x80, y1: 0x8f },
  { action: 0xf0, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** Screen 0x31 — table `@0x2c753`, 8 zones. */
export const MAP_FILTER_HITBOXES_31: readonly HitRect[] = [
  { action: 0xe2, x0: 0x00, x1: 0x3f, y0: 0x00, y1: 0x2f }, // pig farm
  { action: 0xe3, x0: 0x40, x1: 0x7f, y0: 0x00, y1: 0x2f }, // farm
  { action: 0xe4, x0: 0x00, x1: 0x1f, y0: 0x38, y1: 0x59 }, // fisher
  { action: 0xe5, x0: 0x20, x1: 0x3f, y0: 0x56, y1: 0x8b }, // mill
  { action: 0xe6, x0: 0x40, x1: 0x7f, y0: 0x38, y1: 0x59 }, // butcher
  { action: 0xe7, x0: 0x40, x1: 0x6f, y0: 0x64, y1: 0x8b }, // baker
  { action: 0xef, x0: 0x00, x1: 0x0f, y0: 0x80, y1: 0x8f },
  { action: 0xf0, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** Screen 0x32 — table `@0x2c77c`, 8 zones. */
export const MAP_FILTER_HITBOXES_32: readonly HitRect[] = [
  { action: 0xe8, x0: 0x00, x1: 0x1f, y0: 0x00, y1: 0x3f }, // stone mine
  { action: 0xe9, x0: 0x20, x1: 0x3f, y0: 0x00, y1: 0x3f }, // coal mine
  { action: 0xea, x0: 0x3d, x1: 0x5f, y0: 0x00, y1: 0x3f }, // iron mine
  { action: 0xeb, x0: 0x60, x1: 0x7f, y0: 0x00, y1: 0x3f }, // gold mine
  { action: 0xec, x0: 0x10, x1: 0x3f, y0: 0x5f, y1: 0x87 }, // steel smelter
  { action: 0xed, x0: 0x40, x1: 0x6f, y0: 0x5f, y1: 0x87 }, // gold smelter
  { action: 0xef, x0: 0x00, x1: 0x0f, y0: 0x80, y1: 0x8f },
  { action: 0xf0, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f },
];

/** Ein Screen dieser Familie. */
export interface MapFilterScreen {
  readonly id: number;
  readonly layout: readonly LayoutItem[];
  readonly hitboxes: readonly HitRect[];
  /** Only screen 0x2f also draws the flag in the player colour. */
  readonly flagPreview: boolean;
}

export const MAP_FILTER_SCREEN_TABLE: ReadonlyMap<number, MapFilterScreen> = new Map([
  [0x2f, { id: 0x2f, layout: MAP_FILTER_LAYOUT_2F, hitboxes: MAP_FILTER_HITBOXES_2F, flagPreview: true }],
  [0x30, { id: 0x30, layout: MAP_FILTER_LAYOUT_30, hitboxes: MAP_FILTER_HITBOXES_30, flagPreview: false }],
  [0x31, { id: 0x31, layout: MAP_FILTER_LAYOUT_31, hitboxes: MAP_FILTER_HITBOXES_31, flagPreview: false }],
  [0x32, { id: 0x32, layout: MAP_FILTER_LAYOUT_32, hitboxes: MAP_FILTER_HITBOXES_32, flagPreview: false }],
]);

// --- Aktionen ------------------------------------------------------------------------------------

/**
 * Action id -> filter index, byte-exact from the 24 thunks `@0x2dc09`..`@0x2dd2a` (each loads
 * `mov $index,%eax` and falls into the shared tail `@0x2dd31`). The index is the building type enum;
 * `0` is flag mode.
 */
export const MAP_FILTER_ACTION_INDEX: ReadonlyMap<number, number> = new Map([
  [0xee, 0], // flag          @0x2dc09
  [0xe4, 1], // fisher        @0x2dc17
  [0xe1, 2], // lumberjack   @0x2dc25
  [0xdf, 3], // boatbuilder     @0x2dc33
  [0xde, 4], // stonecutter      @0x2dc41
  [0xe8, 5], // stone mine      @0x2dc4f
  [0xe9, 6], // coal mine      @0x2dc5d
  [0xea, 7], // iron mine      @0x2dc6b
  [0xeb, 8], // gold mine       @0x2dc79
  [0xe0, 9], // forester        @0x2dc87
  [0xd7, 10], // warehouse     @0x2dc95
  [0xd9, 11], // guard hut     @0x2dca3
  [0xe3, 12], // farm          @0x2dcb1
  [0xe6, 13], // butcher       @0x2dcbc
  [0xe2, 14], // pig farm  @0x2dcc7
  [0xe5, 15], // mill         @0x2dcd2
  [0xe7, 16], // baker        @0x2dcdd
  [0xdc, 17], // sawmill      @0x2dce8
  [0xec, 18], // steel smelter @0x2dcf3
  [0xdb, 19], // toolmaker@0x2dcfe
  [0xdd, 20], // weaponsmith @0x2dd09
  [0xd8, 21], // tower      @0x2dd14
  [0xda, 22], // fortress       @0x2dd1f
  [0xed, 23], // gold smelter  @0x2dd2a
]);

export type MapFilterAction =
  /** One of the 24 selection zones — tail `@0x2dd31`: overlay on, set filter, back to screen 1. */
  | { readonly kind: 'select'; readonly filter: number }
  /** `0xef` (`@0x2dd61`) — next page, ring `0x2f -> 0x30 -> 0x31 -> 0x32 -> 0x2f`. */
  | { readonly kind: 'page'; readonly screen: number }
  /** `0xf0` (`@0x2dd8a`) — exit: filter back to -1, back to screen 1. The overlay mode stays. */
  | { readonly kind: 'close' };

/**
 * Next page — `@0x2dd61`: `s = vp[0x72] + 1 ; if (s == 0x33) s = 0x2f`. The ring is bound to the
 * **current** screen, not to a position in a list.
 */
export function nextMapFilterScreen(screen: number): number {
  const next = screen + 1;
  return next === 0x33 ? 0x2f : next;
}

/** Aktions-ID → Wirkung (`null` bei unbekannter ID). */
export function mapFilterAction(screen: number, action: number): MapFilterAction | null {
  if (action === 0xef) return { kind: 'page', screen: nextMapFilterScreen(screen) };
  if (action === 0xf0) return { kind: 'close' };
  const filter = MAP_FILTER_ACTION_INDEX.get(action);
  return filter === undefined ? null : { kind: 'select', filter };
}

/** Click in drawing pixels -> action (`null` outside all zones or on a foreign screen). */
export function clickMapFilterPopup(
  screen: number,
  drawX: number,
  drawY: number,
): MapFilterAction | null {
  const s = MAP_FILTER_SCREEN_TABLE.get(screen);
  if (s === undefined) return null;
  const id = hitTestPanel(s.hitboxes, drawX, drawY);
  if (id === null) return null;
  return mapFilterAction(screen, id);
}

/** State of the overview map the actions touch (`vp+0xd1` and `vp+0x2e`). */
export interface MapFilterState {
  readonly mode: number;
  readonly buildingFilter: number;
}

/**
 * The shared tail `@0x2dd31` of a selection: **building overlay on** (`bts $0x3` — set, not toggle)
 * and write the filter. Forcing the overlay on is why a selection becomes visible even when the map
 * was previously shown without buildings.
 */
export function applyMapFilterSelection(state: MapFilterState, filter: number): MapFilterState {
  return { mode: state.mode | PREVIEW_BUILDINGS, buildingFilter: filter };
}

/**
 * Exit `@0x2dd8a`: only `vp[0x2e] = 0xffff` and back to screen 1 — the overlay bit stays as it was.
 * The screen is not a dialog with a cancel, it resets the filter.
 *
 * The port writes **-1** instead of `0xffff`: both readers of the field test it **signed**
 * (`or %ax,%ax ; jns` @0x2fddb in the bar handler and @0x42533 in the icon drawer), so the original
 * holds an `i16` there and the substitution is equivalent, not merely convenient.
 */
export function applyMapFilterClose(state: MapFilterState): MapFilterState {
  return { mode: state.mode, buildingFilter: -1 };
}

// --- Zeichnen ------------------------------------------------------------------------------------

/**
 * Draws one of the four pages — `@0x3ff88`/`@0x3ffea`/`@0x4000a`/`@0x4002a` plus the shared tail
 * `@0x40048`, in renderer order: background, (only 0x2f) the flag in the player colour, the building
 * layout, finally the page and exit icons.
 *
 * `playerColor` is `player+0`; the original reads it through the window's player pointer `vp[0x82]`.
 */
export function drawMapFilterPopup(
  fb: Framebuffer,
  provider: SpriteProvider,
  screen: number,
  playerColor = 0,
): boolean {
  const s = MAP_FILTER_SCREEN_TABLE.get(screen);
  if (s === undefined) return false;
  tileBackground(fb, provider, MAP_FILTER_BG_ICON);
  if (s.flagPreview) {
    const spr = provider(UI_OBJECT_BASE + MAP_FILTER_FLAG_BASE + 4 * playerColor);
    if (spr) blitSpriteNoPivot(fb, spr, panelX(MAP_FILTER_FLAG_COL), panelY(MAP_FILTER_FLAG_ROW));
  }
  drawLayout(fb, provider, s.layout, UI_OBJECT_BASE);
  drawPanelIcon(fb, provider, MAP_FILTER_PAGE_ICON.icon, MAP_FILTER_PAGE_ICON.col, MAP_FILTER_PAGE_ICON.row);
  drawPanelIcon(fb, provider, MAP_FILTER_EXIT_ICON.icon, MAP_FILTER_EXIT_ICON.col, MAP_FILTER_EXIT_ICON.row);
  return true;
}
