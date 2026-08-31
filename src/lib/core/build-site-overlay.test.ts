import { describe, it, expect } from 'vitest';
import { buildSiteMarkerSprite } from './build-site-overlay.js';
import {
  CURSOR_MARKER_BUILD_BASE,
  CURSOR_MARKER_FLAG,
  CURSOR_MARKER_ROAD_NEW,
} from './ui-render.js';
import type { BuildSite } from './engine/build-site.js';

/** Minimal BuildSite — the symbol choice reads only `cursorType` and `possibility`. */
const site = (cursorType: number, possibility: number): BuildSite =>
  ({ cursorType, possibility, levelingHeight: 0 }) as BuildSite;

describe('buildSiteMarkerSprite (FUN_0003789d)', () => {
  it('cursor types 0..3 show nothing', () => {
    for (let type = 0; type <= 3; type++) {
      for (let m = 0; m <= 5; m++) expect(buildSiteMarkerSprite(site(type, m))).toBe(0);
    }
  });

  it('type 4 (on a road): flag symbol, but only when possibility != 0', () => {
    expect(buildSiteMarkerSprite(site(4, 0))).toBe(0);
    for (let m = 1; m <= 5; m++) expect(buildSiteMarkerSprite(site(4, m))).toBe(CURSOR_MARKER_FLAG);
  });

  it('types 5..7: possibility + 0x2e, with the clamp 5 -> 4', () => {
    for (const type of [5, 6, 7]) {
      expect(buildSiteMarkerSprite(site(type, 0))).toBe(0);
      for (let m = 1; m <= 4; m++) {
        expect(buildSiteMarkerSprite(site(type, m))).toBe(m + CURSOR_MARKER_BUILD_BASE);
      }
      // Possibility 5 (castle) would fall onto the road symbol, so it is clamped to the castle.
      expect(buildSiteMarkerSprite(site(type, 5))).toBe(4 + CURSOR_MARKER_BUILD_BASE);
      expect(buildSiteMarkerSprite(site(type, 5))).not.toBe(CURSOR_MARKER_ROAD_NEW);
    }
  });

  it('the clamp applies to EVERY type >= 5 here (not only type 7 as in contextBarState)', () => {
    // The difference is read from the binary, not assumed: `FUN_0003789d` only checks `m == 5`.
    expect(buildSiteMarkerSprite(site(5, 5))).toBe(0x32);
    expect(buildSiteMarkerSprite(site(6, 5))).toBe(0x32);
    expect(buildSiteMarkerSprite(site(7, 5))).toBe(0x32);
  });
});
