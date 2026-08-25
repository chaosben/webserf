import { describe, expect, it } from 'vitest';
import {
  MAP_FILTER_ACTION_INDEX,
  MAP_FILTER_BG_ICON,
  MAP_FILTER_EXIT_ICON,
  MAP_FILTER_FLAG_BASE,
  MAP_FILTER_PAGE_ICON,
  MAP_FILTER_SCREENS,
  MAP_FILTER_SCREEN_TABLE,
  applyMapFilterClose,
  applyMapFilterSelection,
  clickMapFilterPopup,
  drawMapFilterPopup,
  mapFilterAction,
  nextMapFilterScreen,
} from './map-filter-popup.js';
import {
  BUILD_POPUP_ACTIONS,
  LARGE_LAYOUT_PAGE2,
  LARGE_LAYOUT_PAGE3,
  MINE_LAYOUT,
  SMALL_LAYOUT,
} from './build-popup.js';
import { PREVIEW_BUILDINGS } from './map-preview.js';
import { UI_ICON_BASE, UI_OBJECT_BASE, createFramebuffer } from './ui-render.js';
import type { DecodedSprite } from './types.js';

function recordingProvider(): { provider: (e: number) => DecodedSprite; entries: number[] } {
  const entries: number[] = [];
  const sprite: DecodedSprite = {
    width: 1,
    height: 1,
    offsetX: 0,
    offsetY: 0,
    deltaX: 0,
    deltaY: 0,
    pixels: new Uint8ClampedArray([255, 255, 255, 255]),
  };
  return {
    provider: (e: number) => {
      entries.push(e);
      return sprite;
    },
    entries,
  };
}

/**
 * Sprite -> building type of the object bank. **Not** from this screen, but the mapping the build menu
 * spans (layout tables `@0x3d0f1`ff against the zone tables `@0x2ca8c`ff). Here it is the *independent*
 * counter-check to the 24 action thunks: the same table has to explain both groupings — the build
 * menu's (mines / small / large-2 / large-3) **and** the very differently cut one of the building
 * filter (military+storage / crafts / food / mines+smelters).
 */
const SPRITE_TYPE: ReadonlyMap<number, number> = new Map([
  [0xa3, 5], // stone mine
  [0xa4, 6], // coal mine
  [0xa5, 7], // iron mine
  [0xa6, 8], // gold mine
  [0xab, 11], // hut
  [0xa9, 4], // stonecutter
  [0xa8, 2], // lumberjack
  [0xaa, 9], // forester
  [0xa7, 1], // fisher
  [0xbc, 15], // mill
  [0xae, 3], // boatbuilder
  [0x9c, 13], // butcher
  [0x9d, 20], // weaponsmith
  [0xa1, 18], // steel smelter
  [0xa0, 17], // sawmill
  [0xa2, 16], // baker
  [0x9f, 23], // gold smelter
  [0x9e, 21], // tower
  [0x98, 22], // fortress
  [0x99, 19], // toolmaker
  [0xc0, 10], // warehouse
  [0x9a, 12], // farm
  [0x9b, 14], // pig farm
]);

const typesOf = (icons: readonly number[]): number[] =>
  icons.map((i) => SPRITE_TYPE.get(i) ?? -1).sort((a, b) => a - b);

describe('building filter 0x2f..0x32 — action thunks (`@0x2dc09`..`@0x2dd2a`)', () => {
  it('the 24 indices cover 0..23 without a gap', () => {
    const idx = [...MAP_FILTER_ACTION_INDEX.values()].sort((a, b) => a - b);
    expect(idx).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(MAP_FILTER_ACTION_INDEX.size).toBe(24);
  });

  it('every select zone of the four pages has exactly one thunk, none twice', () => {
    const seen = new Set<number>();
    for (const screen of MAP_FILTER_SCREENS) {
      for (const zone of MAP_FILTER_SCREEN_TABLE.get(screen)!.hitboxes) {
        if (zone.action === 0xef || zone.action === 0xf0) continue;
        expect(MAP_FILTER_ACTION_INDEX.has(zone.action)).toBe(true);
        expect(seen.has(zone.action)).toBe(false);
        seen.add(zone.action);
      }
    }
    expect(seen.size).toBe(24);
  });
});

describe('building filter — zones and layout describe the same buildings', () => {
  it('per page: building types of the zones == building types of the drawn sprites', () => {
    for (const screen of MAP_FILTER_SCREENS) {
      const s = MAP_FILTER_SCREEN_TABLE.get(screen)!;
      const fromZones = s.hitboxes
        .map((z) => MAP_FILTER_ACTION_INDEX.get(z.action))
        .filter((v): v is number => v !== undefined && v !== 0)
        .sort((a, b) => a - b);
      const fromLayout = typesOf(s.layout.map((l) => l.icon));
      expect(fromLayout, `Screen 0x${screen.toString(16)}`).toEqual(fromZones);
    }
  });

  it('the same sprite table also explains the four pages of the build menu', () => {
    // Counter direction: were an entry of the sprite table wrong, it could not match the grouping of
    // the build menu and that of the building filter at the same time.
    const buildTypes = (icons: readonly number[]): number[] => typesOf(icons);
    const zoneTypes = (actions: readonly number[]): number[] =>
      actions
        .map((a) => BUILD_POPUP_ACTIONS.get(a))
        .map((a) => (a && a.kind === 'build' ? a.buildingType : -1))
        .sort((x, y) => x - y);
    expect(buildTypes(MINE_LAYOUT.map((l) => l.icon))).toEqual(zoneTypes([5, 6, 7, 8]));
    expect(buildTypes(SMALL_LAYOUT.map((l) => l.icon))).toEqual(
      zoneTypes([10, 11, 12, 13, 14, 15, 16]),
    );
    expect(buildTypes(LARGE_LAYOUT_PAGE2.map((l) => l.icon))).toEqual(
      zoneTypes([17, 18, 19, 20, 21, 22]),
    );
    expect(buildTypes(LARGE_LAYOUT_PAGE3.map((l) => l.icon))).toEqual(
      zoneTypes([23, 24, 25, 26, 27, 190]),
    );
  });

  it('the four pages together show all 23 buildable types exactly once', () => {
    const all = MAP_FILTER_SCREENS.flatMap((s) =>
      MAP_FILTER_SCREEN_TABLE.get(s)!.layout.map((l) => SPRITE_TYPE.get(l.icon)),
    ).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(all).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it('only screen 0x2f has the flag zone and the flag preview', () => {
    for (const screen of MAP_FILTER_SCREENS) {
      const s = MAP_FILTER_SCREEN_TABLE.get(screen)!;
      const hasFlagZone = s.hitboxes.some((z) => z.action === 0xee);
      expect(hasFlagZone).toBe(screen === 0x2f);
      expect(s.flagPreview).toBe(screen === 0x2f);
    }
  });

  it('every page ends with page-turn and exit at the same place', () => {
    for (const screen of MAP_FILTER_SCREENS) {
      const z = MAP_FILTER_SCREEN_TABLE.get(screen)!.hitboxes.slice(-2);
      expect(z.map((r) => r.action)).toEqual([0xef, 0xf0]);
      expect(z[0]).toEqual({ action: 0xef, x0: 0x00, x1: 0x0f, y0: 0x80, y1: 0x8f });
      expect(z[1]).toEqual({ action: 0xf0, x0: 0x70, x1: 0x7f, y0: 0x80, y1: 0x8f });
    }
  });
});

describe('building filter — actions', () => {
  it('paging is the ring 0x2f -> 0x30 -> 0x31 -> 0x32 -> 0x2f (`@0x2dd61`)', () => {
    expect(nextMapFilterScreen(0x2f)).toBe(0x30);
    expect(nextMapFilterScreen(0x30)).toBe(0x31);
    expect(nextMapFilterScreen(0x31)).toBe(0x32);
    expect(nextMapFilterScreen(0x32)).toBe(0x2f);
  });

  it('maps the three kinds of action', () => {
    expect(mapFilterAction(0x2f, 0xd7)).toEqual({ kind: 'select', filter: 10 });
    expect(mapFilterAction(0x2f, 0xee)).toEqual({ kind: 'select', filter: 0 });
    expect(mapFilterAction(0x31, 0xef)).toEqual({ kind: 'page', screen: 0x32 });
    expect(mapFilterAction(0x31, 0xf0)).toEqual({ kind: 'close' });
    expect(mapFilterAction(0x2f, 0x99)).toBeNull();
  });

  it('a selection turns the building overlay ON (`bts $0x3`), it does not toggle it', () => {
    // The difference is observable: with the overlay off, a selection has to switch it on.
    expect(applyMapFilterSelection({ mode: 0, buildingFilter: -1 }, 7)).toEqual({
      mode: PREVIEW_BUILDINGS,
      buildingFilter: 7,
    });
    expect(applyMapFilterSelection({ mode: 0x1f, buildingFilter: 3 }, 0)).toEqual({
      mode: 0x1f,
      buildingFilter: 0,
    });
  });

  it("'RAUS' only resets the filter and leaves the mode alone (`@0x2dd8a`)", () => {
    expect(applyMapFilterClose({ mode: 0x15, buildingFilter: 12 })).toEqual({
      mode: 0x15,
      buildingFilter: -1,
    });
    expect(applyMapFilterClose({ mode: 0, buildingFilter: 0 })).toEqual({
      mode: 0,
      buildingFilter: -1,
    });
  });
});

/** Drawing pixel of a zone point — `hitTestPanel` subtracts the click origin (8, 9) again. */
const at = (x: number, y: number): [number, number] => [x + 8, y + 9];

describe('building filter — hit test', () => {
  it('hits the corners of the zones', () => {
    expect(clickMapFilterPopup(0x2f, ...at(0x00, 0x00))).toEqual({ kind: 'select', filter: 10 });
    expect(clickMapFilterPopup(0x2f, ...at(0x3f, 0x32))).toEqual({ kind: 'select', filter: 10 });
    expect(clickMapFilterPopup(0x2f, ...at(0x19, 0x6e))).toEqual({ kind: 'select', filter: 0 });
    expect(clickMapFilterPopup(0x32, ...at(0x60, 0x00))).toEqual({ kind: 'select', filter: 8 });
    expect(clickMapFilterPopup(0x32, ...at(0x7f, 0x8f))).toEqual({ kind: 'close' });
    expect(clickMapFilterPopup(0x30, ...at(0x00, 0x80))).toEqual({ kind: 'page', screen: 0x31 });
  });

  it('returns null outside the zones and for foreign screens', () => {
    // Gap between the page-turn and the exit button in the bottom row.
    expect(clickMapFilterPopup(0x2f, ...at(0x40, 0x8f))).toBeNull();
    expect(clickMapFilterPopup(0x33, ...at(0x00, 0x00))).toBeNull();
    expect(clickMapFilterPopup(0x0e, ...at(0x10, 0x10))).toBeNull();
  });

  it('the first matching zone wins — even where two overlap', () => {
    // Screen 0x2f: fortress (0x30..0x6f x 0x3c..0x82) and hut (0x10..0x2f x 0x40..0x5f) are disjoint,
    // and fortress and tower (0x40..0x6f x 0..0x32) do not touch at the edge.
    expect(clickMapFilterPopup(0x2f, ...at(0x40, 0x32))).toEqual({ kind: 'select', filter: 21 });
    expect(clickMapFilterPopup(0x2f, ...at(0x40, 0x3c))).toEqual({ kind: 'select', filter: 22 });
  });
});

describe('drawMapFilterPopup', () => {
  it('draws background, layout, page-turn and exit on every page', () => {
    for (const screen of MAP_FILTER_SCREENS) {
      const fb = createFramebuffer(160, 176);
      const { provider, entries } = recordingProvider();
      expect(drawMapFilterPopup(fb, provider, screen)).toBe(true);
      expect(entries).toContain(UI_ICON_BASE + MAP_FILTER_BG_ICON);
      for (const item of MAP_FILTER_SCREEN_TABLE.get(screen)!.layout) {
        expect(entries).toContain(UI_OBJECT_BASE + item.icon);
      }
      expect(entries).toContain(UI_ICON_BASE + MAP_FILTER_PAGE_ICON.icon);
      expect(entries).toContain(UI_ICON_BASE + MAP_FILTER_EXIT_ICON.icon);
    }
  });

  it('draws the flag in player colour only on screen 0x2f', () => {
    const fb = createFramebuffer(160, 176);
    const { provider, entries } = recordingProvider();
    drawMapFilterPopup(fb, provider, 0x2f, 2);
    expect(entries).toContain(UI_OBJECT_BASE + MAP_FILTER_FLAG_BASE + 8); // 0x80 + 4·2

    const fb2 = createFramebuffer(160, 176);
    const p2 = recordingProvider();
    drawMapFilterPopup(fb2, p2.provider, 0x30, 2);
    expect(p2.entries).not.toContain(UI_OBJECT_BASE + MAP_FILTER_FLAG_BASE + 8);
  });

  it('kennt keinen fremden Screen', () => {
    const fb = createFramebuffer(160, 176);
    const { provider } = recordingProvider();
    expect(drawMapFilterPopup(fb, provider, 0x33)).toBe(false);
  });
});
