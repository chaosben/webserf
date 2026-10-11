/**
 * THE ORIGINAL DIALOGS AS PICTURES for the help — drawn by the same renderers the game uses, from
 * the sample game of `help-scene.ts`. Nothing here is a screenshot or a redrawing: a dialog that
 * changes in the game changes in the help with it.
 *
 * DOM-free on purpose: every shot ends as a `Framebuffer`, so Node can render the whole set (the
 * guard in `help-content.test.ts` does). Turning it into an image is the panel's business.
 */
import { paintPopup, drawBuildMenuBody, drawMenuBody, drawObjectPopupBody, POPUP_W } from '../views/popup-draw.js';
import { buildOptionsView, buildSettingsView } from '../views/map-view-data.js';
import { SLIDER_BAR_COLOR_INDEX, type Framebuffer, type SpriteProvider } from '../core/ui-render.js';
import { SETTINGS_SCREENS } from '../core/settings-popup.js';
import { STATS_SCREENS } from '../core/stats-popup.js';
import { OPTIONS_SCREENS, OPTIONS_POPUP_SCREEN } from '../core/options-popup.js';
import { DEVICE_SCREEN } from '../core/device-popup.js';
import { MAP_FILTER_SCREENS } from '../core/map-filter-popup.js';
import { DISK_SCREENS } from '../core/disk-menu.js';
import { DEMOLISH_SCREEN } from '../core/demolish-popup.js';
import { DEVICE_OPTIONS_DEFAULT } from '../core/engine/device-options.js';
import { drawMessagePopup } from '../core/message-popup.js';
import { drawSoilPopup } from '../core/soil-popup.js';
import { drawMapPreview } from '../core/map-preview.js';
import { drawMapPreviewBar } from '../core/ui-render.js';
import { buildMinimap } from '../core/minimap.js';
import { playerFaces } from '../core/player-setup.js';
import type { Palette } from '../core/types.js';
import type { HelpScene } from './help-scene.js';

type Rgb = readonly [number, number, number];

/** Screen numbers of the original's popup slot (`vp[0x70]`). */
export const HELP_SCREEN = {
  map: 1,
  buildMines: 3,
  buildSmall: 4,
  buildPaged: 5,
  buildLarge: 6,
  buildLarge2: 7,
  statsMenu: 8,
  stock: 0x09,
  compare: 0x0e,
  food: 0x1c,
  settingsMenu: 0x24,
  options: OPTIONS_POPUP_SCREEN,
  castle: 0x26,
  soil: 0x16,
  site: 0x28,
  military: 0x29,
  flag: 0x2a,
  census: 0x2b,
  inventory: 0x2c,
  knights: 0x2d,
  message: 0x33,
  demolish: DEMOLISH_SCREEN,
} as const;

/** "A knight has occupied a new building" — type 6, parameter 0 (guard hut). */
const SAMPLE_MESSAGE = 6;

export interface HelpShotContext {
  readonly scene: HelpScene;
  readonly draw: SpriteProvider;
  readonly palette: Palette;
}

function rgb(palette: Palette, index: number): Rgb {
  const i = index * 4;
  return [palette.rgba[i]!, palette.rgba[i + 1]!, palette.rgba[i + 2]!];
}

/** Text colour of every in-game popup: palette index 31. */
const TEXT_COLOR_INDEX = 31;

function menuShot(ctx: HelpShotContext, screen: number): Framebuffer | null {
  const { scene, draw, palette } = ctx;
  const color = (i: number): Rgb => rgb(palette, i);
  return paintPopup(draw, (fb) =>
    drawMenuBody(fb, draw, screen, {
      stats: {
        state: scene.state,
        player: scene.player,
        compareMode: 0,
        resourceItem: 0,
        paletteColor: color,
      },
      settings: buildSettingsView(scene.state, scene.player),
      options: buildOptionsView(scene.state, { volume: 75, music: true, sfx: true }),
      device: DEVICE_OPTIONS_DEFAULT,
      barColor: color(SLIDER_BAR_COLOR_INDEX),
      textColor: color(TEXT_COLOR_INDEX),
      playerColor: scene.player,
      isSettings: (s) => SETTINGS_SCREENS.includes(s),
      isStats: (s) => STATS_SCREENS.includes(s),
      isOptions: (s) => OPTIONS_SCREENS.includes(s),
      isDevice: (s) => s === DEVICE_SCREEN,
      isMapFilter: (s) => MAP_FILTER_SCREENS.includes(s),
      disk: null,
      isDisk: (s) => DISK_SCREENS.includes(s),
      diskBarColor: null,
    }),
  );
}

function objectShot(ctx: HelpShotContext, screen: number, subject: number | null): Framebuffer | null {
  if (subject === null) return null;
  const { scene, draw, palette } = ctx;
  return paintPopup(draw, (fb) =>
    drawObjectPopupBody(fb, draw, screen, subject, {
      state: scene.state,
      player: scene.player,
      textColor: rgb(palette, TEXT_COLOR_INDEX),
      attachRoad: false,
    }),
  );
}

function buildShot(ctx: HelpShotContext, screen: number): Framebuffer | null {
  const { scene, draw } = ctx;
  return paintPopup(draw, (fb) =>
    drawBuildMenuBody(fb, draw, screen, { militaryBlocked: false, flagBlocked: false, playerColor: scene.player }),
  );
}

function mapShot(ctx: HelpShotContext): Framebuffer | null {
  const { scene, draw, palette } = ctx;
  const s = scene.state;
  const castle = s.buildings[scene.castle];
  if (!castle) return null;
  const data = {
    tiles: s.mapTiles,
    cols: s.geo.cols,
    rows: s.geo.rows,
    minimap: buildMinimap(s.mapTiles, s.geo.cols, s.geo.rows),
    palette: palette.rgba,
    flags: s.flags,
    buildings: s.buildings,
  };
  const mode = 8;
  const filter = -1;
  return paintPopup(draw, (fb) => {
    drawMapPreview(
      fb,
      data,
      {
        centerCol: castle.col,
        centerRow: castle.row,
        cursorCol: castle.col,
        cursorRow: castle.row,
        mode,
        buildingFilter: filter,
        playerIndex: scene.player,
      },
      draw,
    );
    drawMapPreviewBar(fb, draw, mode, filter);
  });
}

function soilShot(ctx: HelpShotContext): Framebuffer | null {
  const { scene, draw, palette } = ctx;
  return paintPopup(draw, (fb) => drawSoilPopup(fb, draw, scene.soil, rgb(palette, TEXT_COLOR_INDEX)));
}

function messageShot(ctx: HelpShotContext): Framebuffer | null {
  const { scene, draw, palette } = ctx;
  return paintPopup(draw, (fb) => {
    drawMessagePopup(fb, draw, {
      typeByte: SAMPLE_MESSAGE,
      playerFaces: playerFaces(scene.state.header),
      palette: palette.rgba,
      textColor: rgb(palette, TEXT_COLOR_INDEX),
    });
  });
}

/** One picture of the help. `screens` is what lets an open dialog in the game find its shot. */
export interface HelpShot {
  readonly id: string;
  readonly screens: readonly number[];
  readonly render: (ctx: HelpShotContext) => Framebuffer | null;
}

export const HELP_SHOTS: readonly HelpShot[] = [
  { id: 'buildMines', screens: [HELP_SCREEN.buildMines], render: (c) => buildShot(c, HELP_SCREEN.buildMines) },
  {
    id: 'buildSmall',
    screens: [HELP_SCREEN.buildSmall, HELP_SCREEN.buildPaged],
    render: (c) => buildShot(c, HELP_SCREEN.buildPaged),
  },
  { id: 'buildLarge', screens: [HELP_SCREEN.buildLarge], render: (c) => buildShot(c, HELP_SCREEN.buildLarge) },
  { id: 'buildLarge2', screens: [HELP_SCREEN.buildLarge2], render: (c) => buildShot(c, HELP_SCREEN.buildLarge2) },
  { id: 'map', screens: [HELP_SCREEN.map], render: mapShot },
  { id: 'statsMenu', screens: [HELP_SCREEN.statsMenu], render: (c) => menuShot(c, HELP_SCREEN.statsMenu) },
  {
    id: 'stock',
    screens: STATS_SCREENS.filter((s) => s !== HELP_SCREEN.compare),
    render: (c) => menuShot(c, HELP_SCREEN.stock),
  },
  { id: 'compare', screens: [HELP_SCREEN.compare], render: (c) => menuShot(c, HELP_SCREEN.compare) },
  {
    id: 'settingsMenu',
    screens: [HELP_SCREEN.settingsMenu, 0x1b],
    render: (c) => menuShot(c, HELP_SCREEN.settingsMenu),
  },
  {
    id: 'food',
    screens: SETTINGS_SCREENS.filter((s) => s !== HELP_SCREEN.knights && s !== 0x2e),
    render: (c) => menuShot(c, HELP_SCREEN.food),
  },
  { id: 'knights', screens: [HELP_SCREEN.knights, 0x2e], render: (c) => menuShot(c, HELP_SCREEN.knights) },
  { id: 'options', screens: OPTIONS_SCREENS, render: (c) => menuShot(c, HELP_SCREEN.options) },
  { id: 'flag', screens: [HELP_SCREEN.flag], render: (c) => objectShot(c, HELP_SCREEN.flag, c.scene.castleFlag) },
  { id: 'site', screens: [HELP_SCREEN.site], render: (c) => objectShot(c, HELP_SCREEN.site, c.scene.site) },
  { id: 'castle', screens: [HELP_SCREEN.castle], render: (c) => objectShot(c, HELP_SCREEN.castle, c.scene.castle) },
  { id: 'census', screens: [HELP_SCREEN.census], render: (c) => objectShot(c, HELP_SCREEN.census, c.scene.castle) },
  {
    id: 'inventory',
    screens: [HELP_SCREEN.inventory],
    render: (c) => objectShot(c, HELP_SCREEN.inventory, c.scene.castle),
  },
  {
    id: 'military',
    screens: [HELP_SCREEN.military],
    render: (c) => objectShot(c, HELP_SCREEN.military, c.scene.guardHut),
  },
  { id: 'soil', screens: [HELP_SCREEN.soil], render: soilShot },
  { id: 'demolish', screens: [HELP_SCREEN.demolish], render: (c) => objectShot(c, HELP_SCREEN.demolish, 0) },
  { id: 'message', screens: [HELP_SCREEN.message], render: messageShot },
];

export type HelpShotId = (typeof HELP_SHOTS)[number]['id'];

export function helpShot(id: string): HelpShot | null {
  return HELP_SHOTS.find((s) => s.id === id) ?? null;
}

/** The shot belonging to an open dialog, if the help has one. */
export function helpShotForScreen(screen: number): HelpShot | null {
  return HELP_SHOTS.find((s) => s.screens.includes(screen)) ?? null;
}

/** Width of every shot — the original popup raster. */
export const HELP_SHOT_WIDTH = POPUP_W;
