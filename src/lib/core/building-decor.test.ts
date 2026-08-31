import { describe, it, expect } from 'vitest';
import {
  MILL_TYPE,
  RESOURCE_STONE,
  RESOURCE_PLANK,
  millRotationOffset,
  productionOverlays,
  occupationFlags,
  constructionMaterials,
} from './building-decor.js';
import { gameSprite, resourceSprite, GAME_OBJECT_BASE } from './flag-sprites.js';

describe('gameSprite (GameObject addressing)', () => {
  it('maps the original draw_game_sprite(i) space onto GAME_OBJECT_BASE + i - 1', () => {
    expect(gameSprite(1)).toBe(GAME_OBJECT_BASE);
    expect(gameSprite(128)).toBe(GAME_OBJECT_BASE + 127);
  });

  it('resourceSprite(res) is the special case gameSprite(1 + res)', () => {
    for (let res = 0; res < 26; res++) {
      expect(resourceSprite(res)).toBe(gameSprite(1 + res));
      expect(resourceSprite(res)).toBe(GAME_OBJECT_BASE + res);
    }
  });
});

describe('mill rotation', () => {
  it('returns 0 when the mill is not active', () => {
    for (const t of [0, 16, 100, 1000]) expect(millRotationOffset(t, false)).toBe(0);
  });

  it('runs through 4 phases (changes every 16 ticks)', () => {
    expect(millRotationOffset(0, true)).toBe(0);
    expect(millRotationOffset(15, true)).toBe(0);
    expect(millRotationOffset(16, true)).toBe(1);
    expect(millRotationOffset(32, true)).toBe(2);
    expect(millRotationOffset(48, true)).toBe(3);
    expect(millRotationOffset(64, true)).toBe(0); // wrap
  });

  it('MILL_TYPE is 15', () => {
    expect(MILL_TYPE).toBe(15);
  });
});

describe('production overlays (smoke/steam/lift/rope)', () => {
  it('returns nothing for buildings without an overlay', () => {
    for (const t of [0, 1, 2, 11, 15, 24]) expect(productionOverlays(t, 0, true, true)).toEqual([]);
  });

  it('active overlay only when active', () => {
    expect(productionOverlays(16, 0, false, false)).toEqual([]); // baker inactive
    expect(productionOverlays(16, 0, true, false)).toHaveLength(1);
  });

  it('baker steam: 8-frame cycle every 8 ticks at offset (+5,-21)', () => {
    const f0 = productionOverlays(16, 0, true, false)[0];
    expect(f0.dx).toBe(5);
    expect(f0.dy).toBe(-21);
    expect(f0.idx).toBe(gameSprite(154));
    expect(productionOverlays(16, 8, true, false)[0].idx).toBe(gameSprite(155));
    expect(productionOverlays(16, 8 * 7, true, false)[0].idx).toBe(gameSprite(161));
    expect(productionOverlays(16, 8 * 8, true, false)[0].idx).toBe(gameSprite(154)); // wrap
  });

  it('smelters and weaponsmith share the smoke base 128', () => {
    expect(productionOverlays(18, 0, true, false)[0].idx).toBe(gameSprite(128)); // SteelSmelter
    expect(productionOverlays(20, 0, true, false)[0].idx).toBe(gameSprite(128)); // WeaponSmith
    expect(productionOverlays(23, 0, true, false)[0].idx).toBe(gameSprite(128)); // GoldSmelter
  });

  it('mine active -> lift basket 152 (static), independent of the tick', () => {
    for (const t of [5, 6, 7, 8]) {
      const a = productionOverlays(t, 0, true, false);
      const b = productionOverlays(t, 999, true, false);
      expect(a).toHaveLength(1);
      expect(a[0].idx).toBe(gameSprite(152));
      expect(b[0].idx).toBe(gameSprite(152));
      expect(a[0].dx).toBe(-6);
      expect(a[0].dy).toBe(-39);
    }
  });

  it('mine playingSfx (miner underground) -> rope 153 on the same anchor', () => {
    for (const t of [5, 6, 7, 8]) {
      const rope = productionOverlays(t, 0, false, true);
      expect(rope).toHaveLength(1);
      expect(rope[0].idx).toBe(gameSprite(153));
      expect(rope[0].dx).toBe(-6);
      expect(rope[0].dy).toBe(-39);
    }
  });

  it('mine active AND playingSfx -> both overlays (basket 152 + rope 153)', () => {
    const both = productionOverlays(6, 0, true, true);
    expect(both.map((o) => o.idx)).toEqual([gameSprite(152), gameSprite(153)]);
  });

  it('non-mines ignore playingSfx (no rope)', () => {
    expect(productionOverlays(16, 0, false, true)).toEqual([]); // baker
    expect(productionOverlays(20, 0, false, true)).toEqual([]); // weaponsmith (playingSfx = shield cycle, no rope)
  });
});

describe('occupation flags', () => {
  it('returns nothing for non-military buildings', () => {
    for (const t of [0, 1, 10, 15, 24]) expect(occupationFlags(t, 0, 0, 0)).toEqual([]);
  });

  it('hut: one flag, variant = 4*threatLevel, base 182', () => {
    const f = occupationFlags(11, 0, 0, 0);
    expect(f).toHaveLength(1);
    expect(f[0].idx).toBe(gameSprite(182));
    expect(f[0].dx).toBe(-14);
  });

  it('the threat level shifts the flag variant by 4', () => {
    expect(occupationFlags(11, 0, 1, 0)[0].idx).toBe(gameSprite(182 + 4));
    expect(occupationFlags(11, 0, 3, 0)[0].idx).toBe(gameSprite(182 + 12));
  });

  it('the knight count lifts the flag — lift = ((count<<4) + bias) >> shift', () => {
    // hut `shrw $0x3` => 2 px per knight
    expect(occupationFlags(11, 0, 0, 0)[0].dy).toBe(2);
    expect(occupationFlags(11, 0, 0, 3)[0].dy).toBe(2 - 6);
    // tower `shrw $0x4` => 1 px per knight
    expect(occupationFlags(21, 0, 0, 2)[0].dy).toBe(-18 - 2);
  });

  it('fortress: the left flag rounds DOWN, the right one UP (`addw $0x10` before `shrw $0x5`)', () => {
    for (const [n, left, right] of [
      [0, 0, 0],
      [1, 0, 1],
      [2, 1, 1],
      [3, 1, 2],
      [12, 6, 6],
    ] as const) {
      const f = occupationFlags(22, 0, 0, n);
      expect(f[0].dy).toBe(-21 - left);
      expect(f[1].dy).toBe(-34 - right);
    }
  });

  it('the waving frame changes every 8 ticks (0..3)', () => {
    expect(occupationFlags(11, 0, 0, 0)[0].idx).toBe(gameSprite(182));
    expect(occupationFlags(11, 8, 0, 0)[0].idx).toBe(gameSprite(183));
    expect(occupationFlags(11, 8 * 4, 0, 0)[0].idx).toBe(gameSprite(182)); // wrap
  });

  it('the fortress carries two flags with a phase offset of +2', () => {
    const f = occupationFlags(22, 0, 0, 0);
    expect(f).toHaveLength(2);
    expect(f[0].idx).toBe(gameSprite(182)); // phase 0
    expect(f[1].idx).toBe(gameSprite(182 + 2)); // phase 2
    expect(f[1].dx).toBe(22);
  });
});

describe('construction decor (waiting build materials)', () => {
  it('empty when nothing is waiting', () => {
    expect(constructionMaterials(0, 0)).toEqual([]);
  });

  it('stacks stone (slot 1) and planks (slot 0) at fixed offsets', () => {
    const m = constructionMaterials(2, 1);
    expect(m).toHaveLength(3);
    // stones first
    expect(m[0]).toEqual({ idx: resourceSprite(RESOURCE_STONE), dx: 10, dy: -8 });
    expect(m[1]).toEqual({ idx: resourceSprite(RESOURCE_STONE), dx: 7, dy: -7 });
    // then planks
    expect(m[2]).toEqual({ idx: resourceSprite(RESOURCE_PLANK), dx: 12, dy: -6 });
  });

  it('uses the correct resource indices (stone=9, plank=7)', () => {
    expect(RESOURCE_STONE).toBe(9);
    expect(RESOURCE_PLANK).toBe(7);
  });
});
