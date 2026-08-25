import { describe, it, expect } from 'vitest';
import { SPA_RESOURCES, lookupSpaResource } from './spa-resources.js';

describe('SPA_RESOURCES', () => {
  it('has 36 entries (35 enum slots + the SerfArms addition)', () => {
    expect(SPA_RESOURCES.length).toBe(36);
  });

  it('slot 1 (DOS index 1) is solid with paletteIndex 3996 — ArtLandscape', () => {
    expect(SPA_RESOURCES[1]).toMatchObject({ spaIndex: 1, paletteIndex: 3996, spriteType: 'solid' });
  });

  it('ends with slot 34 (DOS index 3, unknown — the special case for sprite 3)', () => {
    expect(SPA_RESOURCES[34]).toMatchObject({ slot: 34, spaIndex: 3, spriteType: 'unknown' });
  });
});

describe('lookupSpaResource (with the off-by-one)', () => {
 // Mapping: ourEntry N ↔ spaIndex N+1
  it('our entry 0 (640×200 Vollbild) → spaIndex 1 = Solid (ArtLandscape, paletteIndex 3996)', () => {
    const r = lookupSpaResource(0);
    expect(r?.spriteType).toBe('solid');
    expect(r?.paletteIndex).toBe(3996);
  });

  it('our entry 1 → spaIndex 2 = unknown (Animation)', () => {
    expect(lookupSpaResource(1)?.spriteType).toBe('unknown');
    expect(lookupSpaResource(1)?.name).toBe('Animation');
  });

  it('entry 2 -> DOS index 3 = unknown (a palette entry in the archive)', () => {
    expect(lookupSpaResource(2)?.spriteType).toBe('unknown');
  });

  it('our entry 3 → spaIndex 4 = Overlay (SerfShadow)', () => {
    expect(lookupSpaResource(3)?.spriteType).toBe('overlay');
  });

  it('our entry 4..13 → spaIndex 5..14 = Solid', () => {
    expect(lookupSpaResource(4)?.spriteType).toBe('solid');
    expect(lookupSpaResource(13)?.spriteType).toBe('solid');
  });

  it('entries 14..23 -> DOS indices 15..24 = solid with paletteIndex 3996', () => {
    const r = lookupSpaResource(14);
    expect(r?.spriteType).toBe('solid');
    expect(r?.paletteIndex).toBe(3996);
  });

  it('our entry 59..139 → spaIndex 60..140 = Mask', () => {
    expect(lookupSpaResource(59)?.spriteType).toBe('mask');
    expect(lookupSpaResource(139)?.spriteType).toBe('mask');
  });

  it('our entry 320..598 → spaIndex 321..599 = Transparent', () => {
    expect(lookupSpaResource(320)?.spriteType).toBe('transparent');
    expect(lookupSpaResource(598)?.spriteType).toBe('transparent');
  });

  it('our entry 869..1248 (Serfs) → Solid', () => {
    expect(lookupSpaResource(869)?.spriteType).toBe('solid');
    expect(lookupSpaResource(1248)?.spriteType).toBe('solid');
  });

  it('our entry 1499..1748 → Overlay (Schatten)', () => {
    expect(lookupSpaResource(1499)?.spriteType).toBe('overlay');
    expect(lookupSpaResource(1748)?.spriteType).toBe('overlay');
  });

 // Range boundary FrameBottom -> SerfArms at 1849: from there on no entry decodes as solid any
 // more, all of them as transparent RLE.
  it('our entry 1779..1848 → Solid (FrameBottom)', () => {
    expect(lookupSpaResource(1779)?.name).toBe('FrameBottom');
    expect(lookupSpaResource(1848)?.spriteType).toBe('solid');
    expect(lookupSpaResource(1848)?.name).toBe('FrameBottom');
  });

  it('our entry 1849..2498 → Transparent (SerfArms), NICHT solid', () => {
    expect(lookupSpaResource(1849)?.name).toBe('SerfArms');
    expect(lookupSpaResource(1849)?.spriteType).toBe('transparent');
    expect(lookupSpaResource(2498)?.name).toBe('SerfArms');
    expect(lookupSpaResource(2498)?.spriteType).toBe('transparent');
  });

  it('SerfArms has no colorOffset (only the torso is recoloured)', () => {
    expect(lookupSpaResource(1849)?.colorOffset).toBeUndefined();
  });

  it('our entry 2499 → wieder SerfTorso (colorOffset 64)', () => {
    expect(lookupSpaResource(2499)?.name).toBe('SerfTorso');
    expect(lookupSpaResource(2499)?.colorOffset).toBe(64);
  });

  it('our entry 3899..3988 → unknown (Sound-Bereich)', () => {
    expect(lookupSpaResource(3899)?.spriteType).toBe('unknown');
  });

  it('Sound/Music-Slots haben paletteIndex null', () => {
    expect(lookupSpaResource(3899)?.paletteIndex).toBeNull();
    expect(lookupSpaResource(3989)?.paletteIndex).toBeNull();
  });

  it('negativer Index → null', () => {
    expect(lookupSpaResource(-1)).toBeNull();
  });
});
