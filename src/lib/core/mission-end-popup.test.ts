import { describe, expect, it } from 'vitest';
import {
  ART_BOX_COUNT,
  ART_BOX_ENTRY_BASE,
  GAME_TYPE_CAMPAIGN,
  GAME_TYPE_CUSTOM,
  GAME_TYPE_TRAINING,
  GAME_TYPE_TWO_PLAYER,
  LAST_CAMPAIGN_LEVEL,
  LEAD_COLOR_LINES,
  LEVEL_MOOD,
  MISSION_END_EXIT_BAR_ICONS,
  MISSION_END_EXIT_SCREEN,
  MISSION_END_SCREEN,
  PASSWORD_CHARS,
  PASSWORD_LENGTH,
  missionEndBonusMood,
  missionEndBranch,
  missionEndLines,
  missionEndMood,
  missionEndPassword,
  missionEndSteps,
  drawMissionEndPopup,
  type MissionEndView,
} from './mission-end-popup.js';
import { SETUP_PASSWORD_BYTES } from './player-setup.js';
import { faceIcon, FACE_ICON_BASE, FACE_ICON_EMPTY, createFramebuffer } from './ui-render.js';
import type { DecodedSprite } from './types.js';

function view(over: Partial<MissionEndView> = {}): MissionEndView {
  return {
    gameType: GAME_TYPE_CAMPAIGN,
    winnerIndex: 0,
    levelSetupIndex: 0,
    faces: [0x0c, 1, 0, 0],
    ...over,
  };
}

describe('mission end — text variant', () => {
  it('the campaign splits on the winner (@0x383f2)', () => {
    expect(missionEndBranch(GAME_TYPE_CAMPAIGN, 0)).toBe('campaignWon');
    expect(missionEndBranch(GAME_TYPE_CAMPAIGN, 1)).toBe('campaignLost');
    expect(missionEndBranch(GAME_TYPE_CAMPAIGN, 3)).toBe('campaignLost');
  });

  it('the training game has only one version, everything else is the lead message', () => {
    expect(missionEndBranch(GAME_TYPE_TRAINING, 0)).toBe('training');
    expect(missionEndBranch(GAME_TYPE_TRAINING, 2)).toBe('training');
    expect(missionEndBranch(2, 0)).toBe('lead');
    expect(missionEndBranch(GAME_TYPE_TWO_PLAYER, 1)).toBe('lead');
    expect(missionEndBranch(GAME_TYPE_CUSTOM, 0)).toBe('lead');
  });

  it('three variants have five lines, the lead message only four (@0x386e4)', () => {
    expect(missionEndLines(view()).length).toBe(5);
    expect(missionEndLines(view({ winnerIndex: 1 })).length).toBe(5);
    expect(missionEndLines(view({ gameType: GAME_TYPE_TRAINING })).length).toBe(5);
    expect(missionEndLines(view({ gameType: 2 })).length).toBe(4);
  });

  it('line positions of the campaign variants (first line 0x04 won, 0x06 lost)', () => {
    expect(missionEndLines(view()).map((l) => l.row)).toEqual([0x04, 0x10, 0x1a, 0x24, 0x2e]);
    expect(missionEndLines(view({ winnerIndex: 1 })).map((l) => l.row)).toEqual([
      0x06, 0x10, 0x1a, 0x24, 0x2e,
    ]);
    expect(missionEndLines(view()).every((l) => l.col === 0)).toBe(true);
  });

  it('the lead message names the colour of the winner (cascade @0x386fe)', () => {
    for (let w = 0; w < 4; w++) {
      expect(missionEndLines(view({ gameType: 2, winnerIndex: w }))[0]!.text).toBe(
        LEAD_COLOR_LINES[w],
      );
    }
    // The cascade only compares against 0/1/2; anything above falls onto the last colour.
    expect(missionEndLines(view({ gameType: 2, winnerIndex: 7 }))[0]!.text).toBe(LEAD_COLOR_LINES[3]);
  });
});

describe('mission end — mood pictures', () => {
  it('winner 0 shows picture 0, otherwise picture 2 (@0x38334)', () => {
    expect(missionEndMood(GAME_TYPE_CAMPAIGN, 0)).toBe(0);
    expect(missionEndMood(GAME_TYPE_CAMPAIGN, 1)).toBe(2);
    expect(missionEndMood(GAME_TYPE_TRAINING, 2)).toBe(2);
  });

  it('picture 1 exists ONLY in the two-player game with winner 1 (@0x3834e/@0x3835b)', () => {
    expect(missionEndMood(GAME_TYPE_TWO_PLAYER, 1)).toBe(1);
    expect(missionEndMood(GAME_TYPE_TWO_PLAYER, 2)).toBe(2);
    expect(missionEndMood(2, 1)).toBe(2);
  });

  it('the custom-settings game mode shows no picture at all (@0x3832a)', () => {
    expect(missionEndMood(GAME_TYPE_CUSTOM, 0)).toBeNull();
    expect(missionEndMood(GAME_TYPE_CUSTOM, 2)).toBeNull();
  });

  it('a bonus picture only for a won campaign and only if the level has one', () => {
    expect(missionEndBonusMood(view({ levelSetupIndex: 0 }))).toBe(0);
    expect(missionEndBonusMood(view({ levelSetupIndex: 1 }))).toBe(3);
    expect(missionEndBonusMood(view({ levelSetupIndex: 2 }))).toBeNull(); // table: -1
    expect(missionEndBonusMood(view({ levelSetupIndex: LAST_CAMPAIGN_LEVEL }))).toBe(0x0d);
    expect(missionEndBonusMood(view({ winnerIndex: 1, levelSetupIndex: 1 }))).toBeNull();
    expect(missionEndBonusMood(view({ gameType: GAME_TYPE_TRAINING, levelSetupIndex: 1 }))).toBeNull();
    // Beyond the table (31 entries) there is none — not "something arbitrary".
    expect(missionEndBonusMood(view({ levelSetupIndex: 99 }))).toBeNull();
  });

  it('the table covers levels 0..30 and reads 0xff as -1', () => {
    expect(LEVEL_MOOD.length).toBe(LAST_CAMPAIGN_LEVEL + 1);
    expect(LEVEL_MOOD.filter((v) => v < 0).length).toBe(19);
    expect(Math.max(...LEVEL_MOOD)).toBe(0x0d);
  });

  it('all used picture values lie in the ArtBox bank — and leave no entry unused', () => {
    const used = new Set<number>([0, 1, 2, ...LEVEL_MOOD.filter((v) => v >= 0)]);
    expect(Math.min(...used)).toBe(0);
    expect(Math.max(...used)).toBe(ART_BOX_COUNT - 1);
    expect(used.size).toBe(ART_BOX_COUNT);
    expect(ART_BOX_ENTRY_BASE).toBe(0x18);
  });
});

describe('mission end — step sequence', () => {
  it('won campaign with a bonus picture: picture, text, picture', () => {
    expect(missionEndSteps(view({ levelSetupIndex: 1 }))).toEqual([
      { kind: 'picture', artBox: 0 },
      { kind: 'message' },
      { kind: 'picture', artBox: 3 },
    ]);
  });

  it('level without a bonus picture: picture, text', () => {
    expect(missionEndSteps(view({ levelSetupIndex: 2 }))).toEqual([
      { kind: 'picture', artBox: 0 },
      { kind: 'message' },
    ]);
  });

  it('lost campaign: mourning picture, text', () => {
    expect(missionEndSteps(view({ winnerIndex: 1, levelSetupIndex: 1 }))).toEqual([
      { kind: 'picture', artBox: 2 },
      { kind: 'message' },
    ]);
  });

  it('the custom-settings game mode: only the text', () => {
    expect(missionEndSteps(view({ gameType: GAME_TYPE_CUSTOM }))).toEqual([{ kind: 'message' }]);
  });
});

describe('mission end — password', () => {
  it('shows the password of the NEXT mission (record level + 6)', () => {
    expect(missionEndPassword(view({ levelSetupIndex: 0 }), SETUP_PASSWORD_BYTES)).toBe('START   ');
    expect(missionEndPassword(view({ levelSetupIndex: 1 }), SETUP_PASSWORD_BYTES)).toBe('STATION ');
    expect(missionEndPassword(view({ levelSetupIndex: 23 }), SETUP_PASSWORD_BYTES)).toBe('FOUNTAIN');
    expect(missionEndPassword(view({ levelSetupIndex: 29 }), SETUP_PASSWORD_BYTES)).toBe('PASSIVE ');
  });

  it('on the last level there is none — record 36 does not exist (@0x384c4)', () => {
    expect(missionEndPassword(view({ levelSetupIndex: LAST_CAMPAIGN_LEVEL }), SETUP_PASSWORD_BYTES))
      .toBeNull();
    expect(SETUP_PASSWORD_BYTES.length).toBe(36);
    expect(SETUP_PASSWORD_BYTES[LAST_CAMPAIGN_LEVEL + 6]).toBeUndefined();
  });

  it('no password without a won campaign', () => {
    expect(missionEndPassword(view({ winnerIndex: 1 }), SETUP_PASSWORD_BYTES)).toBeNull();
    expect(missionEndPassword(view({ gameType: GAME_TYPE_TRAINING }), SETUP_PASSWORD_BYTES)).toBeNull();
    expect(missionEndPassword(view({ gameType: 2 }), SETUP_PASSWORD_BYTES)).toBeNull();
  });

  it('always eight characters, all from the character table', () => {
    for (let level = 0; level < LAST_CAMPAIGN_LEVEL; level++) {
      const pw = missionEndPassword(view({ levelSetupIndex: level }), SETUP_PASSWORD_BYTES);
      expect(pw).not.toBeNull();
      expect(pw!.length).toBe(PASSWORD_LENGTH);
      for (const ch of pw!) expect(PASSWORD_CHARS).toContain(ch);
    }
  });

  it('the character table is the scrambled 27, not an alphabet', () => {
    expect(PASSWORD_CHARS.length).toBe(27);
    expect(new Set(PASSWORD_CHARS).size).toBe(27);
    expect(PASSWORD_CHARS).not.toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ ');
  });

  it('all campaign records carry only table indices (anything else would be gibberish)', () => {
    for (let rec = 6; rec < SETUP_PASSWORD_BYTES.length; rec++) {
      for (const b of SETUP_PASSWORD_BYTES[rec]!) expect(b).toBeLessThan(PASSWORD_CHARS.length);
    }
  });
});

describe('mission end — exit and face', () => {
  it('the exit requests the quit dialog (@0x389d2)', () => {
    expect(MISSION_END_SCREEN).toBe(0x36);
    expect(MISSION_END_EXIT_SCREEN).toBe(0x22);
  });

  it('the icon row of the exit carries all three tabs passively (@0x388a4)', () => {
    expect(MISSION_END_EXIT_BAR_ICONS).toEqual([0, 7, 9, 0xb, 0xd]);
  });

  it('face byte -> icon (FUN_0003952c): 0 is empty, otherwise +0x10b signed', () => {
    expect(faceIcon(0)).toBe(FACE_ICON_EMPTY);
    expect(faceIcon(0x0c)).toBe(FACE_ICON_BASE + 0x0c);
    expect(faceIcon(0xff)).toBe(FACE_ICON_BASE - 1);
    expect(faceIcon(0x100)).toBe(FACE_ICON_EMPTY); // the original tests only the byte
  });
});

describe('mission end — the credits step has no popup content', () => {
  /** An opaque 8x8 sprite for every entry, so an attempt to draw becomes visible. */
  const provider = (): DecodedSprite => ({
    width: 8,
    height: 8,
    offsetX: 0,
    offsetY: 0,
    deltaX: 0,
    deltaY: 0,
    pixels: new Uint8ClampedArray(8 * 8 * 4).fill(255),
  });

  function paint(step: Parameters<typeof drawMissionEndPopup>[2]): Uint8ClampedArray {
    const fb = createFramebuffer(144, 160);
    drawMissionEndPopup(fb, provider, step, view({ levelSetupIndex: LAST_CAMPAIGN_LEVEL }), null,
      [255, 255, 255]);
    return fb.rgba.slice();
  }

  it('the text step draws something (counter-check — otherwise the test would be blind)', () => {
    const blank = createFramebuffer(144, 160).rgba;
    expect(paint({ kind: 'message' })).not.toEqual(blank);
  });

  it('the credits step draws NOTHING — it runs as a full-screen sequence', () => {
    const blank = createFramebuffer(144, 160).rgba;
    expect(paint({ kind: 'endCredits' })).toEqual(blank);
  });

  it('... and is the LAST step on the final campaign level', () => {
    const steps = missionEndSteps(view({ levelSetupIndex: LAST_CAMPAIGN_LEVEL }));
    expect(steps.at(-1)).toEqual({ kind: 'endCredits' });
    expect(steps.filter((s) => s.kind === 'endCredits')).toHaveLength(1);
  });
});
