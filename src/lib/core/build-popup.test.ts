import { describe, expect, it } from 'vitest';
import {
  BUILD_POPUP_ACTIONS,
  BUILD_SCREENS,
  FLAG_PREVIEW_BASE,
  LARGE_LAYOUT_PAGE3,
  LARGE_LAYOUT_PAGE3_NO_MILITARY,
  PAGE_ICON,
  SMALL_LAYOUT,
  SMALL_LAYOUT_NO_MILITARY,
  buildPopupAction,
  buildScreenForPossibility,
  drawBuildPopup,
  nextBuildScreen,
} from './build-popup.js';
import { UI_ICON_BASE, UI_OBJECT_BASE, createFramebuffer } from './ui-render.js';
import type { DecodedSprite } from './types.js';

/** Sprite provider that logs every requested entry and returns a 1x1 pixel. */
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

describe('build menu tables (layout vs. click zones)', () => {
  it('every click zone has a known action', () => {
    for (const screen of BUILD_SCREENS.values()) {
      for (const box of screen.hitboxes) {
        expect(BUILD_POPUP_ACTIONS.has(box.action), `Screen ${screen.id}, Aktion ${box.action}`).toBe(
          true,
        );
      }
    }
  });

  it('as many build actions per screen as building icons', () => {
    // Cross-check of two tables decoded independently from the binary (layout @0x3d0f1ff, click
    // zones @0x2ca8cff): the number of build zones must match the number of icons.
    for (const screen of BUILD_SCREENS.values()) {
      const buildActions = screen.hitboxes.filter(
        (b) => BUILD_POPUP_ACTIONS.get(b.action)?.kind === 'build',
      );
      expect(buildActions.length, `Screen ${screen.id}`).toBe(screen.layout.length);
    }
  });

  it('all building types lie in the enum range and appear exactly once', () => {
    const types = [...BUILD_POPUP_ACTIONS.values()]
      .filter((a) => a.kind === 'build')
      .map((a) => (a.kind === 'build' ? a.buildingType : -1));
    for (const t of types) {
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(24);
    }
    expect(new Set(types).size).toBe(types.length);
  });

  it('exactly the three military buildings are marked as such', () => {
    const military = [...BUILD_POPUP_ACTIONS.values()]
      .filter((a) => a.kind === 'build' && a.military)
      .map((a) => (a.kind === 'build' ? a.buildingType : -1))
      .sort((x, y) => x - y);
    expect(military).toEqual([11, 21, 22]); // hut, tower, fortress
  });
});

describe('buildPopupAction (Klick → Wirkung)', () => {
  it('hits the mines of screen 3', () => {
    // Klick-Zone [16,48]×[8,72] liegt in Zeichen-Pixeln bei [24,56]×[17,81].
    expect(buildPopupAction(3, 30, 30)).toEqual({ kind: 'build', buildingType: 5, military: false });
    expect(buildPopupAction(3, 80, 30)).toEqual({ kind: 'build', buildingType: 6, military: false });
    expect(buildPopupAction(3, 50, 100)).toEqual({ kind: 'build', buildingType: 7, military: false });
    expect(buildPopupAction(3, 100, 100)).toEqual({
      kind: 'build',
      buildingType: 8,
      military: false,
    });
  });

  it('recognises flag, page turn and military builds', () => {
    expect(buildPopupAction(3, 20, 130)).toEqual({ kind: 'flag' });
    expect(buildPopupAction(5, 10, 140)).toEqual({ kind: 'page' });
    expect(buildPopupAction(5, 100, 30)).toEqual({ kind: 'build', buildingType: 11, military: true });
    expect(buildPopupAction(7, 100, 110)).toEqual({ kind: 'build', buildingType: 22, military: true });
  });

  it('returns null outside the zones and for non-build screens', () => {
    expect(buildPopupAction(3, 0, 0)).toBeNull();
    expect(buildPopupAction(2, 30, 30)).toBeNull();
  });
});

describe('nextBuildScreen (page-turn handler 0x31e47)', () => {
  it('zyklisiert 5 → 6 → 7 → 5', () => {
    expect(nextBuildScreen(5)).toBe(6);
    expect(nextBuildScreen(6)).toBe(7);
    expect(nextBuildScreen(7)).toBe(5);
  });

  it('leaves screens without a page-turn icon alone', () => {
    expect(nextBuildScreen(3)).toBe(3);
    expect(nextBuildScreen(4)).toBe(4);
  });
});

describe('drawBuildPopup', () => {
  it('draws layout, flag preview in the player colour and page-turn icon', () => {
    const fb = createFramebuffer(160, 176);
    const { provider, entries } = recordingProvider();
    expect(drawBuildPopup(fb, provider, 5, { playerColor: 2 })).toBe(true);
    for (const item of SMALL_LAYOUT) expect(entries).toContain(UI_OBJECT_BASE + item.icon);
    expect(entries).toContain(UI_OBJECT_BASE + FLAG_PREVIEW_BASE + 8); // 0x80 + 4·2
    expect(entries).toContain(UI_ICON_BASE + PAGE_ICON);
  });

  it('hides the military icons when military building is blocked', () => {
    const fb = createFramebuffer(160, 176);
    const { provider, entries } = recordingProvider();
    drawBuildPopup(fb, provider, 5, { militaryBlocked: true });
    expect(entries).not.toContain(UI_OBJECT_BASE + 0xab);
    expect(SMALL_LAYOUT_NO_MILITARY.length).toBe(SMALL_LAYOUT.length - 1);

    const fb2 = createFramebuffer(160, 176);
    const p2 = recordingProvider();
    drawBuildPopup(fb2, p2.provider, 7, { militaryBlocked: true });
    expect(p2.entries).not.toContain(UI_OBJECT_BASE + 0x9e);
    expect(p2.entries).not.toContain(UI_OBJECT_BASE + 0x98);
    expect(LARGE_LAYOUT_PAGE3_NO_MILITARY.length).toBe(LARGE_LAYOUT_PAGE3.length - 2);
  });

  it('omits the flag preview when flag building is blocked', () => {
    const fb = createFramebuffer(160, 176);
    const { provider, entries } = recordingProvider();
    drawBuildPopup(fb, provider, 3, { flagBlocked: true, playerColor: 0 });
    expect(entries).not.toContain(UI_OBJECT_BASE + FLAG_PREVIEW_BASE);
  });

  it('draws the page-turn icon only on the three paged screens', () => {
    for (const [id, expected] of [
      [3, false],
      [4, false],
      [5, true],
      [6, true],
      [7, true],
    ] as [number, boolean][]) {
      const fb = createFramebuffer(160, 176);
      const { provider, entries } = recordingProvider();
      drawBuildPopup(fb, provider, id);
      expect(entries.includes(UI_ICON_BASE + PAGE_ICON), `Screen ${id}`).toBe(expected);
    }
  });

  it('knows no screen outside 3..7', () => {
    const fb = createFramebuffer(160, 176);
    const { provider } = recordingProvider();
    expect(drawBuildPopup(fb, provider, 2)).toBe(false);
  });

  describe('buildScreenForPossibility', () => {
    it('mine (2) opens the mine screen 3', () => {
      expect(buildScreenForPossibility(2)).toBe(3);
    });

    it('small building only (3) opens screen 4 — the one WITHOUT a page-turn icon', () => {
      expect(buildScreenForPossibility(3)).toBe(4);
      expect(BUILD_SCREENS.get(4)?.hasPageIcon).not.toBe(true);
      // The core of the original's gating: from screen 4 there is no path to the large buildings.
      expect(nextBuildScreen(4)).toBe(4);
    });

    it('large building (4) / castle (5) open screen 5 — the one WITH a page-turn icon', () => {
      expect(buildScreenForPossibility(4)).toBe(5);
      expect(buildScreenForPossibility(5)).toBe(5);
      expect(BUILD_SCREENS.get(5)?.hasPageIcon).toBe(true);
    });

    it('nothing buildable (0) / flag only (1) open no build menu', () => {
      expect(buildScreenForPossibility(0)).toBeNull();
      expect(buildScreenForPossibility(1)).toBeNull();
    });

    it('every returned screen exists and the mine selection stays reserved for mines', () => {
      for (const p of [2, 3, 4, 5]) {
        const s = buildScreenForPossibility(p);
        expect(BUILD_SCREENS.has(s!), `possibility ${p}`).toBe(true);
      }
      // On mountains there are only mines, never economy buildings — and vice versa.
      expect(buildScreenForPossibility(2)).not.toBe(4);
      expect(buildScreenForPossibility(3)).not.toBe(3);
    });
  });
});
