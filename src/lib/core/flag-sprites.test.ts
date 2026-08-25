import { describe, it, expect } from 'vitest';
import {
  MAP_OBJECT_BASE,
  MAP_SHADOW_BASE,
  GAME_OBJECT_BASE,
  FLAG_BASE,
  flagFrame,
  flagSpriteOffset,
  flagShadowOffset,
  resourceSprite,
  FLAG_RES_POS,
  FLAG_RES_BEHIND,
  FLAG_RES_FRONT,
} from './flag-sprites.js';

describe('flag-sprites Konstanten', () => {
  it('re-exports the map object and shadow bases', () => {
    expect(MAP_OBJECT_BASE).toBe(1249);
    expect(MAP_SHADOW_BASE).toBe(1499);
  });
  it('GameObject-Basis 0-basiert 320, Flag-Basis 0x80', () => {
    expect(GAME_OBJECT_BASE).toBe(320);
    expect(FLAG_BASE).toBe(0x80);
  });
});

describe('flagFrame', () => {
  it('wechselt alle 8 Ticks, zyklisch modulo 4', () => {
    expect(flagFrame(0)).toBe(0);
    expect(flagFrame(7)).toBe(0);
    expect(flagFrame(8)).toBe(1);
    expect(flagFrame(16)).toBe(2);
    expect(flagFrame(24)).toBe(3);
    expect(flagFrame(32)).toBe(0);
  });
});

describe('flag Sprite-Offsets', () => {
  it('Bild = 0x80+f, Variante = 0x80+4+f', () => {
    expect(flagSpriteOffset(0, 0)).toBe(0x80);
    expect(flagSpriteOffset(3, 0)).toBe(0x83);
    // One pre-drawn set per player — four frames apart.
    expect(flagSpriteOffset(0, 1)).toBe(0x84);
    expect(flagSpriteOffset(0, 2)).toBe(0x88);
    expect(flagSpriteOffset(0, 3)).toBe(0x8c);
    // The shadow depends on the frame only, not on the owner.
    expect(flagShadowOffset(0)).toBe(0x80);
    expect(flagShadowOffset(3)).toBe(0x83);
  });
  it('masks frame to 0..3', () => {
    expect(flagSpriteOffset(4, 0)).toBe(0x80);
    expect(flagSpriteOffset(5, 1)).toBe(0x85);
  });
});

describe('resourceSprite + Waren-Layout', () => {
  it('Waren-Sprite = GAME_OBJECT_BASE + Ressourcentyp', () => {
    expect(resourceSprite(0)).toBe(320);
    expect(resourceSprite(25)).toBe(345);
  });
  it('8 slot offsets, split into behind and in front of the flag', () => {
    expect(FLAG_RES_POS).toHaveLength(8);
    expect(FLAG_RES_POS[0]).toEqual([6, -4]);
    expect(FLAG_RES_POS[7]).toEqual([-4, 4]);
    expect([...FLAG_RES_BEHIND, ...FLAG_RES_FRONT].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
