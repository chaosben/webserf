import { describe, expect, it } from 'vitest';
import { MUSIC_ARCHIVE_ENDING, MUSIC_ARCHIVE_GAME, musicShouldPlay } from './music.js';

describe('music — track indices (the asset registry off-by-one)', () => {
  it('keeps the DOS indices 0-based', () => {
    // DOS index 3990 (`mov $0xf96,%ax` @0xb162) and 3992 (@0x38b71); our parser counts from 0.
    expect(MUSIC_ARCHIVE_GAME).toBe(0xf96 - 1);
    expect(MUSIC_ARCHIVE_ENDING).toBe(0xf98 - 1);
  });

  it('keeps the game and end-credits tracks apart', () => {
    expect(MUSIC_ARCHIVE_GAME).not.toBe(MUSIC_ARCHIVE_ENDING);
  });
});

describe('music — the gate is a conjunction (@0x4500 / @0x450f)', () => {
  it('plays only with driver AND option', () => {
    expect(musicShouldPlay(true, true)).toBe(true);
  });

  it('stays silent without a driver, even when the option is on', () => {
    // `if (gs[0x1f5] != 0) -> 0x453f` — the switch itself checks this too (@0x2d6be).
    expect(musicShouldPlay(false, true)).toBe(false);
  });

  it('stays silent without the option ticked', () => {
    expect(musicShouldPlay(true, false)).toBe(false);
  });

  it('stays silent without either', () => {
    expect(musicShouldPlay(false, false)).toBe(false);
  });
});
