import { describe, it, expect } from 'vitest';
import { classifyEntry, entryKindLabel } from './entry-classifier.js';
import type { PackEntry } from './types.js';

function e(index: number, offset: number, size: number): PackEntry {
  return { index, offset, size };
}

describe('classifyEntry', () => {
  it('empty: offset === 0', () => {
    expect(classifyEntry(e(0, 0, 0))).toBe('empty');
    expect(classifyEntry(e(3999, 0, 999))).toBe('empty');
  });

  it('palette: size === 768', () => {
    expect(classifyEntry(e(2, 100, 768))).toBe('palette');
    expect(classifyEntry(e(3996, 200, 768))).toBe('palette');
    expect(classifyEntry(e(3997, 300, 768))).toBe('palette');
  });

  it('animation: our entry 1 → AssetAnimation', () => {
    expect(classifyEntry(e(1, 100, 30528))).toBe('animation');
  });

  it('sound: our entry 3899..3988 → AssetSound', () => {
    expect(classifyEntry(e(3899, 100, 200))).toBe('sound');
    expect(classifyEntry(e(3950, 100, 200))).toBe('sound');
    expect(classifyEntry(e(3988, 100, 200))).toBe('sound');
  });

  it('music: entries 3989..3997 -> AssetMusic (but the palette check beats 3996/3997)', () => {
    expect(classifyEntry(e(3989, 100, 6000))).toBe('music');
    expect(classifyEntry(e(3995, 100, 6000))).toBe('music');
    // 3996/3997 are 768-byte palettes -> recognised as palettes first
    expect(classifyEntry(e(3996, 100, 768))).toBe('palette');
    expect(classifyEntry(e(3997, 100, 768))).toBe('palette');
  });

  it('sprite: known sprite ranges in the asset registry', () => {
    expect(classifyEntry(e(0, 100, 128010))).toBe('sprite');     // ArtLandscape
    expect(classifyEntry(e(3, 100, 34))).toBe('sprite');         // SerfShadow (Overlay)
    expect(classifyEntry(e(100, 100, 50))).toBe('sprite');       // MapMaskUp/Down range
    expect(classifyEntry(e(320, 100, 50))).toBe('sprite');       // GameObject
    expect(classifyEntry(e(3998, 100, 150))).toBe('sprite');     // Cursor
  });

  it('unknown: special cases (in real archives the size check turns these into palettes)', () => {
    // Entry 0 becomes 'sprite' (slot 1 ArtLandscape) — there is no practical 'unknown' case.
    expect(classifyEntry(e(0, 100, 50))).toBe('sprite');
  });
});

describe('entryKindLabel', () => {
  it('liefert deutsche Kurz-Tags', () => {
    expect(entryKindLabel('sprite')).toBe('Sprite');
    expect(entryKindLabel('palette')).toBe('Palette');
    expect(entryKindLabel('animation')).toBe('Animation');
    expect(entryKindLabel('sound')).toBe('Sound');
    expect(entryKindLabel('music')).toBe('Musik');
    expect(entryKindLabel('empty')).toBe('leer');
    expect(entryKindLabel('unknown')).toBe('unbek.');
  });
});
