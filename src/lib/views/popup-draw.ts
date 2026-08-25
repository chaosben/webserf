/**
 * Selecting and drawing the original popups (144×160) as pure functions. The renderers themselves
 * live byte-verified in `core/*-popup.ts`; what is here is the chain and the cascades.
 *
 * "Close" is a return value, not a side effect: several original renderers close their own window
 * when their subject becomes unusable — as pure functions they report that back via
 * {@link PopupPaint}.
 */
import {
  clearFramebuffer,
  createFramebuffer,
  drawPopupFrame,
  drawPopupPlayerButtons,
  type Framebuffer,
  type PopupPlayerButtonsView,
  type SpriteProvider,
} from '../core/ui-render.js';
import { drawBuildPopup } from '../core/build-popup.js';
import { drawMenuPopup } from '../core/menu-popup.js';
import { drawSettingsPopup, type SettingsPopupView } from '../core/settings-popup.js';
import { drawOptionsScreen, type OptionsPopupView } from '../core/options-popup.js';
import { drawDevicePopup } from '../core/device-popup.js';
import { drawDiskScreen, type DiskMenuState } from '../core/disk-menu.js';
import { drawMapFilterPopup } from '../core/map-filter-popup.js';
import { drawAttackPopup } from '../core/attack-popup.js';
import { drawFlagPopup } from '../core/flag-popup.js';
import { DEMOLISH_SCREEN, drawDemolishPopup } from '../core/demolish-popup.js';
import {
  BUILDING_STAT_SCREENS,
  FILL_RULES_FOOD,
  FILL_RULES_INDUSTRY,
  FILL_SLOTS_FOOD,
  FILL_SLOTS_INDUSTRY,
  PROFESSION_UNEMPLOYED_TYPE,
  drawBuildingStats,
  drawCompareStats,
  drawFillStats,
  drawPlayerColorLegend,
  drawProfessionStats,
  drawResourceStats,
  drawSerfStats,
  drawStockStats,
} from '../core/stats-popup.js';
import {
  drawConstructionPopup,
  drawCastlePopup,
  drawSerfCensusPopup,
  serfCensusCounts,
  drawInventoryModePopup,
  inventoryModeKnightCounts,
  nextGarrisonKnight,
  drawMilitaryPopup,
  drawMinePopup,
  drawStockPopup,
} from '../core/building-popup.js';
import {
  collectFillLevels,
  professionAvailability,
  serfCensusTotal,
  stockTotals,
} from '../core/engine/stats.js';
import { playerFaces } from '../core/player-setup.js';
import { codedBuildingType } from '../core/engine/attack.js';
import type { GameState } from '../core/engine/state.js';

/** Raster of every original popup. */
export const POPUP_W = 144;
export const POPUP_H = 160;

/** Background; the frame covers the edges. */
const BG: readonly [number, number, number] = [30, 30, 34];

type Rgb = readonly [number, number, number];

export type PopupPaint =
  /** drawn */
  | 'drawn'
  /** subject gone — the original closes its window here */
  | 'close';

/** If the body reports `'close'`, nothing is drawn. */
export function paintPopup(
  canvas: HTMLCanvasElement,
  draw: SpriteProvider,
  body: (fb: Framebuffer) => PopupPaint | void,
  /**
   * Player switch in the frame header — set in spectator mode (game type 4) only. It comes
   * **after** the frame, as in the original: the popup presenter `FUN_000444e3` blits the top
   * frame sprite 0x294 once more itself and puts the buttons on top before emitting the surface
   * (@0x44578 before @0x4459a).
   */
  playerButtons?: PopupPlayerButtonsView,
): PopupPaint {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return 'drawn';
  const fb = createFramebuffer(POPUP_W, POPUP_H);
  clearFramebuffer(fb, BG[0], BG[1], BG[2]);
  if (body(fb) === 'close') return 'close';
  drawPopupFrame(fb, draw);
  if (playerButtons) drawPopupPlayerButtons(fb, draw, playerButtons);
  const img = ctx.createImageData(fb.width, fb.height);
  img.data.set(fb.rgba);
  ctx.putImageData(img, 0, 0);
  return 'drawn';
}

// --- Build menu (screens 3..7) -------------------------------------------------------------------

export interface BuildMenuView {
  readonly militaryBlocked: boolean;
  readonly flagBlocked: boolean;
  readonly playerColor: number;
}

export function drawBuildMenuBody(
  fb: Framebuffer,
  draw: SpriteProvider,
  screen: number,
  view: BuildMenuView,
): void {
  drawBuildPopup(fb, draw, screen, view);
}

// --- Statistics screens --------------------------------------------------------------------------

export interface StatsView {
  readonly state: GameState;
  readonly player: number;
  readonly compareMode: number;
  readonly resourceItem: number;
  /** `undefined` without a palette ⇒ curves stay uncoloured. */
  readonly paletteColor: ((index: number) => Rgb) | undefined;
}

/** The counting work lives in `engine/stats.ts`. */
export function drawStatsBody(
  fb: Framebuffer,
  draw: SpriteProvider,
  screen: number,
  view: StatsView,
): void {
  const { state, paletteColor } = view;
  const p = state.players[view.player];
  if (!p) return;
  if (screen === 0x09) {
    drawStockStats(fb, draw, stockTotals(state, p));
  } else if (BUILDING_STAT_SCREENS.includes(screen)) {
    drawBuildingStats(fb, draw, screen, p.completedBuildingCount, p.incompleteBuildingCount);
  } else if (screen === 0x0e) {
    drawCompareStats(
      fb,
      draw,
      {
        mode: view.compareMode,
        ringIndex: state.header.playerHistoryIndex,
        histories: state.players.map((q) => (q && q.active ? q.statHistory : null)),
      },
      paletteColor,
    );
  } else if (screen === 0x0f) {
    const history = p.resourceHistory[view.resourceItem] ?? null;
    drawResourceStats(
      fb,
      draw,
      {
        resource: view.resourceItem,
        ringIndex: state.header.resourceHistoryIndex,
        history,
      },
      paletteColor,
    );
  } else if (screen === 0x10) {
    drawFillStats(
      fb,
      draw,
      screen,
      collectFillLevels(state, p, FILL_RULES_FOOD, FILL_SLOTS_FOOD, true),
    );
  } else if (screen === 0x11) {
    drawFillStats(
      fb,
      draw,
      screen,
      collectFillLevels(state, p, FILL_RULES_INDUSTRY, FILL_SLOTS_INDUSTRY, false),
    );
  } else if (screen === 0x12) {
    drawSerfStats(fb, draw, p.serfCount, serfCensusTotal(p));
  } else if (screen === 0x13) {
    drawProfessionStats(fb, draw, {
      available: professionAvailability(state, p),
      unemployed: p.serfCount[PROFESSION_UNEMPLOYED_TYPE] ?? 0,
    });
  } else if (screen === 0x35) {
    // Faces are not in the save; they follow from the setup index. 0 = slot unoccupied.
    if (paletteColor !== undefined) {
      drawPlayerColorLegend(fb, draw, { faces: playerFaces(state.header) }, paletteColor);
    }
  }
}

// --- Menu screens (statistics/distribution menu and their sub-screens) ---------------------------

export interface MenuView {
  readonly stats: StatsView;
  readonly settings: SettingsPopupView | null;
  readonly options: OptionsPopupView;
  readonly device: Parameters<typeof drawDevicePopup>[2];
  readonly barColor: Rgb | undefined;
  readonly textColor: Rgb;
  /** Player colour of the flag preview (screen 0x2f). */
  readonly playerColor: number;
  readonly isSettings: (screen: number) => boolean;
  readonly isStats: (screen: number) => boolean;
  readonly isOptions: (screen: number) => boolean;
  readonly isDevice: (screen: number) => boolean;
  readonly isMapFilter: (screen: number) => boolean;
  /** The disk menu (screens 0x17..0x1a) — `null` when none is open. */
  readonly disk: DiskMenuState | null;
  readonly isDisk: (screen: number) => boolean;
  /**
   * Colour of the slot list's selection bar — palette index **0x4c**, not the 0x1e of the slider.
   * Its own field, because `barColor` is taken and a shared value would paint the wrong bar here
   * without anyone noticing.
   */
  readonly diskBarColor: Rgb | null;
}

export function drawMenuBody(
  fb: Framebuffer,
  draw: SpriteProvider,
  screen: number,
  view: MenuView,
): void {
  if (view.isSettings(screen) && view.settings !== null) {
    drawSettingsPopup(fb, draw, screen, view.settings, {
      barColor: view.barColor,
      textColor: view.textColor,
    });
  } else if (view.isStats(screen)) {
    drawStatsBody(fb, draw, screen, view.stats);
  } else if (view.isOptions(screen)) {
    drawOptionsScreen(fb, draw, screen, view.options, {
      textColor: view.textColor,
    });
  } else if (view.isDevice(screen)) {
    drawDevicePopup(fb, draw, view.device, { textColor: view.textColor });
  } else if (view.isMapFilter(screen)) {
    drawMapFilterPopup(fb, draw, screen, view.playerColor);
  } else if (view.isDisk(screen) && view.disk !== null) {
    drawDiskScreen(fb, draw, screen, view.disk, view.textColor, view.diskBarColor);
  } else {
    drawMenuPopup(fb, draw, screen);
  }
}

// --- Special-click windows (0x14 / 0x2a / 0x28 / 0x27 / 0x29 / 0x26 / 0x2b / 0x2c / rest) --------

export interface ObjectPopupView {
  readonly state: GameState;
  readonly player: number;
  readonly textColor: Rgb;
  readonly attachRoad: boolean;
}

/**
 * Knight chain of a military building (`bld+10` → `serf+0xe`).
 *
 * Walks the RAW union bytes like the original (@0x3b1aa). A stored decoded twin used to lead into
 * the garrison a conqueror had already left (the reason it no longer exists). The loop cap is an
 * addition — the original would hang on a cyclic list.
 */
export function garrisonKnightTypes(state: GameState, firstKnight: number): number[] {
  const types: number[] = [];
  const seen = new Set<number>();
  let idx = firstKnight;
  while (idx !== 0 && !seen.has(idx)) {
    seen.add(idx);
    const serf = state.serfs[idx];
    if (!serf) break;
    types.push(serf.type);
    idx = nextGarrisonKnight(serf);
  }
  return types;
}

export function drawObjectPopupBody(
  fb: Framebuffer,
  draw: SpriteProvider,
  screen: number,
  subject: number,
  view: ObjectPopupView,
): PopupPaint {
  const { state, textColor } = view;
  // The only screen of this family without a subject: it works on the cursor tile.
  if (screen === DEMOLISH_SCREEN) {
    drawDemolishPopup(fb, draw, textColor);
    return 'drawn';
  }
  if (screen === 0x14) {
    // The attack window reads its target from `player+0x134`.
    const attacker = state.players[view.player];
    const target = attacker ? state.buildings[attacker.buildingAttacked] : null;
    if (!attacker || !target) return 'close';
    drawAttackPopup(fb, draw, {
      targetCodedType: codedBuildingType(target),
      bands: attacker.attackingKnights,
      chosen: attacker.knightsAttacking,
    });
    return 'drawn';
  }
  if (screen === 0x2a) {
    const flag = state.flags[subject];
    if (!flag) return 'close';
    // "Attach road" requires `can_attach_flag_to_road` (@0x4c9b3) at the cursor tile.
    drawFlagPopup(fb, draw, flag, {
      playerColor: view.player,
      attachRoad: view.attachRoad,
      textColor,
    });
    return 'drawn';
  }

  const bld = state.buildings[subject];
  if (!bld || bld.burning) return 'close';
  if (screen === 0x28) {
    drawConstructionPopup(fb, draw, bld.type, textColor);
  } else if (screen === 0x27) {
    drawMinePopup(
      fb,
      draw,
      {
        type: bld.type,
        holder: bld.holder,
        food: bld.stock[0].available,
        attemptBits: bld.progress,
      },
      textColor,
    );
  } else if (screen === 0x29) {
    drawMilitaryPopup(
      fb,
      draw,
      {
        type: bld.type,
        gold: bld.stock[1].available,
        knightTypes: garrisonKnightTypes(state, bld.firstKnight),
      },
      textColor,
    );
  } else if (screen === 0x26) {
    // The parked building reserve sits in the player record, not in the inventory (castle only).
    const inv = bld.inventoryIndex === null ? null : state.inventories[bld.inventoryIndex];
    const owner = state.players[bld.owner];
    drawCastlePopup(fb, draw, {
      isCastle: bld.type === 24,
      active: bld.active,
      resources: inv?.resources ?? [],
      heldPlanks: owner?.heldPlanks ?? 0,
      heldStone: owner?.heldStone ?? 0,
    });
  } else if (screen === 0x2b) {
    // Counts over ALL serfs: the inventory record holds only one representative per profession.
    const counts = serfCensusCounts(
      {
        type: bld.type,
        burning: bld.burning,
        inventoryIndex: bld.inventoryIndex,
      },
      state.serfs,
    );
    // `null` == the original closes the window here.
    if (counts === null) return 'close';
    drawSerfCensusPopup(fb, draw, counts);
  } else if (screen === 0x2c) {
    // The original draws the five rank counts only for the castle; for other types it closes.
    const inv = bld.inventoryIndex === null ? null : state.inventories[bld.inventoryIndex];
    if (bld.burning || (bld.type !== 10 && bld.type !== 24) || !inv) return 'close';
    drawInventoryModePopup(
      fb,
      draw,
      inv.resMode,
      inv.serfMode,
      bld.type === 24 ? inventoryModeKnightCounts(bld, state.serfs) : null,
    );
  } else {
    drawStockPopup(
      fb,
      draw,
      {
        type: bld.type,
        holder: bld.holder,
        stock0: bld.stock[0].available,
        stock1: bld.stock[1].available,
      },
      textColor,
    );
  }
  return 'drawn';
}
