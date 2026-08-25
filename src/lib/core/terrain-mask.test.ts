import { describe, it, expect } from 'vitest';
import {
  TRI_MASK_UP,
  TRI_MASK_DOWN,
  TRI_SPR,
  upMaskIndex,
  downMaskIndex,
  groundSpriteForTriangle,
} from './terrain-mask.js';
import { MAP_GROUND_BASE } from './map-render.js';

describe('Terrain-Maskentabellen', () => {
  it('have the reference sizes (81/81/128)', () => {
    expect(TRI_MASK_UP).toHaveLength(81);
    expect(TRI_MASK_DOWN).toHaveLength(81);
    expect(TRI_SPR).toHaveLength(128);
  });

  it('corner values from the reference', () => {
    expect(TRI_MASK_UP[0]).toBe(0);
    expect(TRI_MASK_UP[80]).toBe(7);
    expect(TRI_MASK_DOWN[0]).toBe(0);
    expect(TRI_MASK_DOWN[80]).toBe(7);
    // Water (types 0..3) is always sprite 32; snow (14/15) is 16..23.
    expect(TRI_SPR[0]).toBe(32);
    expect(TRI_SPR[(4 << 3) | 0]).toBe(0); // Grass-Variante 0
    expect(TRI_SPR[(14 << 3) | 0]).toBe(16); // Snow-Variante 0
  });
});

describe('Maskenindex', () => {
  it('flach (m=left=right) → Index 40, Variante 4 (beide Richtungen)', () => {
    expect(upMaskIndex(10, 10, 10)).toBe(40);
    expect(downMaskIndex(10, 10, 10)).toBe(40);
    expect(TRI_MASK_UP[40]).toBe(4);
    expect(TRI_MASK_DOWN[40]).toBe(4);
  });

  it('matches the formula for a known slope', () => {
    // up: m=12, left=11, right=12 → 4+1 + 9*(4+0) = 5 + 36 = 41.
    expect(upMaskIndex(12, 11, 12)).toBe(41);
  });
});

describe('groundSpriteForTriangle', () => {
  it('flaches Gras → Boden-Sprite-Index relativ zu MAP_GROUND_BASE', () => {
    // Grass0 (Typ 4), flach → Variante 4 → TRI_SPR[36] = 4.
    expect(groundSpriteForTriangle('up', 4, 10, 10, 10)).toBe(MAP_GROUND_BASE + 4);
    expect(groundSpriteForTriangle('down', 4, 10, 10, 10)).toBe(MAP_GROUND_BASE + 4);
  });

  it('flaches Wasser → Sprite 32', () => {
    expect(groundSpriteForTriangle('up', 0, 5, 5, 5)).toBe(MAP_GROUND_BASE + 32);
  });

  it('returns null for an invalid slope (index outside 0..80)', () => {
    // m-left = 10 → erster Term 14, Index 140 ≥ 81.
    expect(groundSpriteForTriangle('up', 4, 20, 10, 10)).toBeNull();
  });

  it('returns null when the mask hits a -1 cell (an error in the original)', () => {
    // m=10,left=9,right=14 → Index 5; TRI_MASK_UP[5] = -1.
    expect(upMaskIndex(10, 9, 14)).toBe(5);
    expect(TRI_MASK_UP[5]).toBe(-1);
    expect(groundSpriteForTriangle('up', 4, 10, 9, 14)).toBeNull();
  });
});
