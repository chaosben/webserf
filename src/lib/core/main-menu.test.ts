import { describe, it, expect } from 'vitest';
import {
  advanceCampaignProgress,
  applyMainMenuAction,
  applyMainMenuKey,
  CAMPAIGN_LEVEL_CAP,
  CAMPAIGN_LEVEL_COUNT,
  drawMainMenu,
  drawMapGenProgress,
  FIRST_CAMPAIGN_RECORD,
  formatMapSeedCode,
  GAME_TYPE_DEMO,
  GAME_TYPE_LEVEL,
  GAME_TYPE_MISSION,
  GAME_TYPE_ONE_PLAYER,
  GAME_TYPE_TWO_PLAYERS,
  generateMenuOpponents,
  hitTestMainMenu,
  HUMAN_INTELLIGENCE,
  initialMainMenuState,
  mainMenuCommands,
  MAP_GEN_BAR,
  MAP_SEED_CODE_LENGTH,
  mapSeedInputCode,
  matchCampaignPassword,
  MENU_AREA,
  MENU_CLICK_AREA,
  MENU_DIM_BIT,
  MENU_PANEL_ICON_IDLE,
  MENU_PANEL_ICON_PREVIEW,
  MENU_PREVIEW_DISCARD_SOUND,
  menuPanelIcons,
  MENU_GLYPH_SHADOW_OFFSET,
  MENU_ICON_CANCEL,
  MENU_ICON_START,
  MENU_INPUT_STAGE,
  MENU_KEY_BACKSPACE,
  MENU_KEY_COMMIT,
  MENU_KEY_CURSOR_LEFT,
  MENU_KEY_DELETE,
  MENU_RESUME_CLOCKS,
  MENU_STAGE1_ICONS,
  MENU_SURFACE,
  MENU_TEXT_COLOR,
  MENU_TEXT_SHADOW_COLOR,
  MENU_TRAIT_MAX,
  MENU_ZONES_LOADED,
  menuBackgroundTiles,
  menuBoxTiles,
  menuColumns,
  menuSeedGroup,
  menuTwoDigits,
  menuX,
  menuY,
  menuZonesFor,
  parseMapSeedCode,
  PASSWORD_BLANK,
  PASSWORD_REJECT,
  SELECTABLE_GAME_TYPES,
  startMainMenu,
  type MenuCommand,
  type MenuTarget,
  type MainMenuState,
} from './main-menu.js';
import { GLYPH_ENTRY } from './ui-render.js';
import { SETUP_PASSWORD_BYTES, decodeSetupPassword } from './player-setup.js';

/**
 * The byte comparison against the original is done by an external probe — it needs the binary and
 * therefore does not run in this suite. What stands here is what is checkable WITHOUT the binary: the
 * invariants of the model and the places where a port error shows as behaviour.
 */
describe('main menu — geometry', () => {
  it('maps eighth-columns and rows onto the same origin', () => {
    expect(menuX(0)).toBe(16);
    expect(menuX(0x27)).toBe(0x27 * 8 + 16);
    expect(menuY(0)).toBe(24);
    expect(menuY(0x60)).toBe(0x60 + 24);
  });

  it('keeps the painted and the clickable area apart', () => {
    // The clickable area starts 16 rows LOWER than the painted one — the title is not clickable.
    expect(MENU_CLICK_AREA.y - MENU_AREA.y).toBe(16);
    expect(MENU_AREA.height - MENU_CLICK_AREA.height).toBe(24);
    // Both lie completely inside the 352×240 surface.
    expect(MENU_AREA.x + MENU_AREA.width).toBeLessThanOrEqual(MENU_SURFACE.width);
    expect(MENU_AREA.y + MENU_AREA.height).toBeLessThanOrEqual(MENU_SURFACE.height);
  });
});

describe('main menu — tiling loops', () => {
  it('tiles the background down to and including row 0 and column 0', () => {
    // The original loops test the value BEFORE the decrement; writing `> 0` loses the last row and
    // the last column.
    const bg = menuBackgroundTiles();
    expect(bg.some((t) => t.row === 0)).toBe(true);
    expect(bg.some((t) => t.col === 0)).toBe(true);
    expect(bg).toHaveLength(24 * 8);
  });

  it('skips 0x121 in the icon cycle', () => {
    const icons = new Set([...menuBackgroundTiles(), ...menuBoxTiles()].map((t) => t.icon));
    expect(icons.has(0x121)).toBe(false);
    expect(icons.size).toBe(5);
  });
});

describe('main menu — click', () => {
  const s = initialMainMenuState();

  it('hits the three buttons of the control strip', () => {
    expect(hitTestMainMenu(s, 16 + 10, 24 + 60)).toBe(38); // START
    expect(hitTestMainMenu(s, 16 + 260, 24 + 60)).toBe(13); // EXTRA OPTION
    expect(hitTestMainMenu(s, 16 + 300, 24 + 60)).toBe(39); // LADEN
  });

  it('returns null outside the clickable area', () => {
    expect(hitTestMainMenu(s, 15, 100)).toBeNull();
    expect(hitTestMainMenu(s, 100, 23)).toBeNull();
    expect(hitTestMainMenu(s, 100, 24 + 168)).toBeNull();
    expect(hitTestMainMenu(s, 16 + 320, 100)).toBeNull();
  });

  it('takes the FIRST matching zone — the tables overlap', () => {
    // A29 (168..199 × 96..159) encloses A30..A32; in the table A28 stands before it and A29 before
    // A30. A hit at x 210 / y 120 lies in A29 AND A30, and A29 comes first.
    const free = { ...s, gameType: GAME_TYPE_ONE_PLAYER };
    const zones = menuZonesFor(free);
    const iA29 = zones.findIndex((z) => z.action === 29);
    const iA30 = zones.findIndex((z) => z.action === 30);
    expect(iA29).toBeLessThan(iA30);
    expect(hitTestMainMenu(free, 16 + 210, 24 + 120)).toBe(30); // A30 liegt NICHT in A29 (x 208>199)
    expect(hitTestMainMenu(free, 16 + 180, 24 + 120)).toBe(29);
  });

  it('has a table of its own per game type', () => {
    const g = (gameType: number) => menuZonesFor({ ...s, gameType });
    expect(g(GAME_TYPE_LEVEL)).toHaveLength(9);
    expect(g(GAME_TYPE_MISSION)).toHaveLength(8);
    expect(g(GAME_TYPE_ONE_PLAYER)).toHaveLength(31);
    expect(g(GAME_TYPE_TWO_PLAYERS)).toHaveLength(27);
    expect(g(GAME_TYPE_DEMO)).toHaveLength(32);
  });

  it('the loaded save hides the game-type zones COMPLETELY', () => {
    // The bit-6 test @0x4f78a stands before every `gameType` query. Checked with the game type that
    // has the most zones — otherwise "3 zones" could also be an accidentally small table.
    const pending = { ...s, gameType: GAME_TYPE_DEMO, loadedGamePending: true };
    expect(menuZonesFor(pending)).toBe(MENU_ZONES_LOADED);
    expect(menuZonesFor(pending)).toHaveLength(3);
    expect(menuZonesFor(pending).map((z) => z.action)).toEqual([11, 40, 41]);
    // A point hitting an action in the demo table (A20, slider slot 0) now hits nothing.
    expect(hitTestMainMenu({ ...s, gameType: GAME_TYPE_DEMO }, 16 + 50, 24 + 120)).toBe(20);
    expect(hitTestMainMenu(pending, 16 + 50, 24 + 120)).toBeNull();
  });

  it('the two buttons of the loaded state lie on the places of START and LADEN', () => {
    const pending = { ...s, loadedGamePending: true };
    expect(hitTestMainMenu(pending, 16 + 10, 24 + 60)).toBe(40); // START-Platz
    expect(hitTestMainMenu(pending, 16 + 300, 24 + 60)).toBe(41); // LADEN-Platz
    expect(hitTestMainMenu(pending, 16 + 4, 24 + 4)).toBe(11); // Beenden-Ecke bleibt
    // The EXTRA-OPTION place (248..279) is dead in the bit-6 state.
    expect(hitTestMainMenu(pending, 16 + 260, 24 + 60)).toBeNull();
    expect(hitTestMainMenu(s, 16 + 260, 24 + 60)).toBe(13);
  });
});

describe('main menu — actions', () => {
  const s = initialMainMenuState();

  it('cycles the game type and skips "2 SPIELER"', () => {
    let g = s.gameType;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(g);
      g = applyMainMenuAction({ ...s, gameType: g }, 0).state.gameType;
    }
    // The original counted 0,1,2,3,4 here (`cmpw $0x5` @0x50c9f); the 3 is deliberately removed.
    expect(seen).toEqual([0, 1, 2, 4, 0, 1]);
    expect(seen).not.toContain(GAME_TYPE_TWO_PLAYERS);
  });

  it('gets out of a loaded game type 3 as well', () => {
    const out = applyMainMenuAction({ ...s, gameType: GAME_TYPE_TWO_PLAYERS }, 0).state.gameType;
    expect(SELECTABLE_GAME_TYPES).toContain(out);
  });

  it('leaves the split-screen wish (A1) ineffective', () => {
    // The second way into two-human mode: `btc $0x0` on `gs+0x37e` @0x50d12 in the original.
    const r = applyMainMenuAction({ ...s, splitscreen: false }, 1);
    expect(r.state.splitscreen).toBe(false);
    expect(applyMainMenuAction({ ...s, splitscreen: true }, 1).state.splitscreen).toBe(true);
    expect(r.effect.kind).toBe('none');
  });

  it('clamps level, mission and map size at their bounds', () => {
    expect(applyMainMenuAction({ ...s, level: 1 }, 3).state.level).toBe(1);
    expect(applyMainMenuAction({ ...s, level: 1, unlockedLevel: 1 }, 2).state.level).toBe(1);
    expect(applyMainMenuAction({ ...s, level: 1, unlockedLevel: 9 }, 2).state.level).toBe(2);
    expect(applyMainMenuAction({ ...s, mission: 6 }, 5).state.mission).toBe(6);
    expect(applyMainMenuAction({ ...s, mission: 1 }, 6).state.mission).toBe(1);
    expect(applyMainMenuAction({ ...s, mapSizeChoice: 1 }, 7).state.mapSizeChoice).toBe(1);
    expect(
      applyMainMenuAction({ ...s, mapSizeChoice: 7, maxMapSize: 7 }, 8).state.mapSizeChoice,
    ).toBe(7);
  });

  it('handles ALL 42 actions — `unhandled` now means "does not exist"', () => {
    const open = [...Array(42).keys()].filter(
      (a) => applyMainMenuAction(s, a, 0).effect.kind === 'unhandled',
    );
    expect(open).toEqual([]);
    // The counter-check: a number outside the range MUST report itself, otherwise the line above
    // would be green even if `unhandled` were no longer reachable at all.
    expect(applyMainMenuAction(s, 42).effect).toEqual({ kind: 'unhandled', action: 42 });
  });

  it('rolls all three seed words with A9 from exactly three draws', () => {
    let n = 0;
    const r = applyMainMenuAction(s, 9, undefined, () => [0x1111, 0x2222, 0x3333][n++]!);
    expect(r.state.seed).toEqual([0x1111, 0x2222, 0x3333]);
    expect(n).toBe(3);
    // Without a random source the seed stays — nothing is invented.
    expect(applyMainMenuAction(s, 9).state.seed).toEqual(s.seed);
  });

  it('reports A11 as "quit" — the top-left corner sets gs+0x1c9 bit 0', () => {
    expect(applyMainMenuAction(s, 11).effect).toEqual({ kind: 'quit' });
  });

  it('transfers the values of the HIGHEST occupied slot with A18', () => {
    const r = applyMainMenuAction(
      {
        ...s,
        face: [12, 3, 4, 0], // slot 3 is empty => slot 2 wins
        intelligence: [40, 1, 2, 3],
        supply: [9, 8, 7, 6],
        reproduction: [5, 4, 3, 2],
      },
      18,
    ).state;
    expect(r.intelligence).toEqual([2, 2, 2, 2]);
    expect(r.supply).toEqual([7, 7, 7, 7]);
    expect(r.reproduction).toEqual([3, 3, 3, 3]);
    expect(r.humanSupply).toEqual([7, 7]);
  });

  // START @0x4fd53 and LADEN @0x4fd0e enqueue sound 2, A13 "EXTRA OPTION" @0x4fceb does NOT: its body
  // is 12 instructions long and contains no `call 0x3688a` — the sound 2 @0x4fcbd before it belongs
  // to A41.
  it('plays sound 2 for START and LADEN, 8 for EXTRA OPTION and everything else', () => {
    expect(applyMainMenuAction(s, 38).sound).toBe(2);
    expect(applyMainMenuAction(s, 39).sound).toBe(2);
    expect(applyMainMenuAction(s, 13).sound).toBe(8);
    expect(applyMainMenuAction(s, 40).sound).toBe(2); // A40 „weiterspielen" @0x4fc4d
    expect(applyMainMenuAction(s, 41).sound).toBe(2); // A41 back to the menu @0x4fcb4
    expect(applyMainMenuAction(s, 12).sound).toBe(2); // A12 „Karte erzeugen" @0x50a41
    expect(applyMainMenuAction(s, 0).sound).toBe(8);
  });

  // A2/A3 @0x50d3b/@0x50d8a and A5/A6 @0x50dc4/@0x50dfe enqueue sound 4 at the limit
  // (@0x50d84/@0x50dbe/@0x50df8/@0x50e32) and change nothing.
  it('rejects at the limit — level and mission with sound 4', () => {
    // Ausgangslage: Stufe 1 == freigeschaltete Grenze 1, Auftrag 1.
    expect(applyMainMenuAction(s, 2).sound).toBe(4); // Stufe hoch, Grenze erreicht
    expect(applyMainMenuAction(s, 2).state.level).toBe(1);
    expect(applyMainMenuAction(s, 3).sound).toBe(4); // level down, already at 1
    expect(applyMainMenuAction(s, 6).sound).toBe(4); // mission down, already at 1
    expect(applyMainMenuAction({ ...s, mission: 6 }, 5).sound).toBe(4); // mission up, already at 6

    // And the other case: where it goes on, only the walker sounds (8) and the value advances by 1.
    const up = applyMainMenuAction({ ...s, level: 3, unlockedLevel: 5 }, 2);
    expect(up.sound).toBe(8);
    expect(up.state.level).toBe(4);
    const down = applyMainMenuAction({ ...s, level: 3, unlockedLevel: 5 }, 3);
    expect(down.sound).toBe(8);
    expect(down.state.level).toBe(2);
    expect(applyMainMenuAction(s, 5).state.mission).toBe(2);
  });

  // The original's asymmetry: A7/A8 (map size) jump PAST the sound at the limit onto their `ret`
  // (@0x50e5e / @0x50e99). Tidying them up sounds wrong in two places.
  it('leaves the map size SILENT at the limit (only walker sound 8)', () => {
    const small = applyMainMenuAction({ ...s, mapSizeChoice: 1 }, 7);
    expect(small.sound).toBe(8);
    expect(small.state.mapSizeChoice).toBe(1);
    const large = applyMainMenuAction({ ...s, mapSizeChoice: 8 }, 8);
    expect(large.sound).toBe(8);
    expect(large.state.mapSizeChoice).toBe(8);
  });

  it('assigns every slider to its field', () => {
    expect(applyMainMenuAction(s, 21, 7).state.intelligence[0]).toBe(7);
    expect(applyMainMenuAction(s, 20, 7).state.supply[0]).toBe(7);
    expect(applyMainMenuAction(s, 22, 7).state.reproduction[0]).toBe(7);
    expect(applyMainMenuAction(s, 36, 7).state.intelligence[3]).toBe(7);
    expect(applyMainMenuAction(s, 14, 7).state.humanSupply[0]).toBe(7);
    expect(applyMainMenuAction(s, 17, 7).state.humanReproduction[1]).toBe(7);
  });
});

describe('main menu — columns and text', () => {
  it('gives the human the intelligence literal instead of a slider', () => {
    const cols = menuColumns({ ...initialMainMenuState(), gameType: GAME_TYPE_ONE_PLAYER });
    expect(cols[0]!.icon).toBe(0x117);
    expect(cols[0]!.values[0]).toBe(HUMAN_INTELLIGENCE);
    // Exactly this literal produces the u16 limit of the AI rate — the reason human players carry
    // 0xFFFF in the save without exception.
    expect(HUMAN_INTELLIGENCE * 1300 + 13535).toBe(65535);
  });

  it('puts the second human on slot 1 in "2 SPIELER"', () => {
    const cols = menuColumns({ ...initialMainMenuState(), gameType: GAME_TYPE_TWO_PLAYERS });
    expect(cols[1]!.icon).toBe(0x118);
  });

  it('reads from the RAW record for level/mission — the same order as the gs arrays', () => {
    // The raw record holds [face, intelligence, supply, reproduction]; the two middle ones are
    // swapped only by `apply_game_setup`. Taking the normalised order here shows the bars swapped.
    const cols = menuColumns({ ...initialMainMenuState(), gameType: GAME_TYPE_LEVEL }, [5, 20], [
      [11, 40, 20, 20],
    ]);
    expect(cols[1]!.values).toEqual([40, 20, 20]);
    expect(cols[0]!.values).toEqual([HUMAN_INTELLIGENCE, 5, 20]);
  });

  it('formats numbers like the original', () => {
    expect(menuTwoDigits(1)).toBe(' 1'); // leading zero -> space
    expect(menuTwoDigits(9)).toBe(' 9');
    expect(menuTwoDigits(10)).toBe('10');
    expect(menuTwoDigits(30)).toBe('30');
    expect(menuSeedGroup(0)).toBe('1111'); // OCTAL from '1', not decimal
    expect(menuSeedGroup(0xfff)).toBe('8888');
  });
});

describe('main menu — drawing', () => {
  it('produces a complete command list and writes it into the sink', () => {
    const icons: number[] = [];
    const bars: number[] = [];
    const boxes: { w: number; h: number; color: number }[] = [];
    const glyphs: number[] = [];
    const glyphCalls: { entry: number; x: number; y: number; color: number }[] = [];
    const target: MenuTarget = {
      icon: (entry) => icons.push(entry),
      glyph: (entry, x, y, color) => {
        glyphs.push(color);
        glyphCalls.push({ entry, x, y, color });
      },
      // `fill` serves TWO things: the slider bars (width 4) and the black character cells of the
      // input fields (8 × 8, `gs+0x1ca` bit 4). Without separating them the test checks both mixed
      // together — which is exactly where it broke when the cells were added.
      fill: (_x, _y, w, h, color) =>
        w === 8 && h === 8 ? boxes.push({ w, h, color }) : bars.push(color),
    };
    const cmds = mainMenuCommands({ ...initialMainMenuState(), gameType: GAME_TYPE_ONE_PLAYER });
    drawMainMenu(target, cmds, () => 749);
    // Background (192) + fixed icons (25) + sign + box (24) + three arrows ×2 + columns.
    expect(icons.length).toBeGreaterThan(240);
    // Three bar colours per occupied column, in the original's order.
    expect(bars.length).toBeGreaterThanOrEqual(3);
    expect(new Set(bars)).toEqual(new Set([0x1e, 0x43, 0x4b]));
    // In the free game these are the four seed groups of four characters — 16 black cells.
    expect(boxes).toHaveLength(16);
    expect(new Set(boxes.map((b) => b.color))).toEqual(new Set([0]));
    // Glyphs do NOT go through `icon` but masked through `glyph` — and TWICE per character: first the
    // shadow in colour 1, then the glyph in 0x1f (`draw_font_string` @0x37cda blits @0x37dce before
    // @0x37e03).
    expect(glyphs.length).toBeGreaterThan(0);
    expect(new Set(glyphs)).toEqual(new Set([MENU_TEXT_SHADOW_COLOR, MENU_TEXT_COLOR]));
    expect(glyphs.filter((c) => c === MENU_TEXT_SHADOW_COLOR)).toHaveLength(glyphs.length / 2);
  });

  it('draws shadow first, then glyph per character — at the same place', () => {
    const calls: { entry: number; x: number; y: number; color: number }[] = [];
    const target: MenuTarget = {
      icon: () => {},
      glyph: (entry, x, y, color) => calls.push({ entry, x, y, color }),
      fill: () => {},
    };
    // Command list directly, so the test does not hang on the whole menu; the glyph resolver returns
    // the same entry for both characters — what is checked is the order, not the font.
    drawMainMenu(target, [{ kind: 'text', text: 'AB', x: 100, y: 50 }], () => 749);
    expect(calls).toEqual([
      { entry: 749 + MENU_GLYPH_SHADOW_OFFSET, x: 100, y: 50, color: MENU_TEXT_SHADOW_COLOR },
      { entry: 749, x: 100, y: 50, color: MENU_TEXT_COLOR },
      { entry: 749 + MENU_GLYPH_SHADOW_OFFSET, x: 108, y: 50, color: MENU_TEXT_SHADOW_COLOR },
      { entry: 749, x: 108, y: 50, color: MENU_TEXT_COLOR },
    ]);
  });

  it('draws the background first — otherwise it covers everything', () => {
    const cmds = mainMenuCommands(initialMainMenuState());
    expect(cmds.slice(0, 192).every((c) => c.kind === 'icon')).toBe(true);
  });
});

describe('map code', () => {
  // The two original captures: seed from the save, digits read off the screen.
  const CAPTURES: ReadonlyArray<readonly [string, [number, number, number], string]> = [
    // The seed was originally noted as coming from one capture slot; that slot has since been
    // overwritten. The same bytes are carried by two other captures — there the world size 8 of the
    // capture also stands in the header.
    ['sied_029 / SAVE4+5.DS', [0x4b6b, 0x29d7, 0x21c3], '3377462471731814'],
    ['sied_032 / SAVE6.DS', [0x2d19, 0x9f5b, 0x3ee1], '2432656681428452'],
  ];

  it.each(CAPTURES)('%s — the display matches the capture digit for digit', (_n, seed, want) => {
    expect(formatMapSeedCode(seed)).toBe(want);
  });

  it('shows only 32 of the 48 seed bits — exactly where the round trip fails', () => {
    // Flip one bit and count whether the display notices. Bits 0..3, 20..27 and 44..47 change
    // nothing — that is the defect, not a test error.
    const base: [number, number, number] = [0, 0, 0];
    const blind: number[] = [];
    for (let bit = 0; bit < 48; bit++) {
      const s: [number, number, number] = [...base];
      s[bit >> 4] ^= 1 << (bit & 15);
      if (formatMapSeedCode(s) === formatMapSeedCode(base)) blind.push(bit);
    }
    expect(blind).toEqual([0, 1, 2, 3, 20, 21, 22, 23, 24, 25, 26, 27, 44, 45, 46, 47]);
  });

  it('reads losslessly — every one of the 48 bits is reachable', () => {
    const seen = new Set<number>();
    for (let i = 0; i < MAP_SEED_CODE_LENGTH; i++) {
      for (const d of ['2', '3', '5']) {
        const code = '1'.repeat(i) + d + '1'.repeat(MAP_SEED_CODE_LENGTH - i - 1);
        const s = parseMapSeedCode(code);
        expect(s).not.toBeNull();
        for (let bit = 0; bit < 48; bit++) if ((s![bit >> 4]! >> (bit & 15)) & 1) seen.add(bit);
      }
    }
    expect(seen.size).toBe(48);
  });

  it('rejects invalid codes instead of storing half a seed', () => {
    expect(parseMapSeedCode('123456781234567')).toBeNull(); // zu kurz
    expect(parseMapSeedCode('1234567812345679')).toBeNull(); // '9' is out of range
    expect(parseMapSeedCode('123456781234567 ')).toBeNull(); // Leerzeichen liegt darunter
  });

  it('A10 opens the input with an empty buffer and a digit filter', () => {
    const r = applyMainMenuAction(initialMainMenuState(), 10);
    expect(r.state.textInput).toEqual({
      field: 'seed',
      text: ' '.repeat(16),
      cursor: 0,
      digitsOnly: true,
    });
  });

  it('types, commits and stores the seed', () => {
    let s = applyMainMenuAction(initialMainMenuState(), 10).state;
    for (const ch of '3377462471731814') s = applyMainMenuKey(s, ch.charCodeAt(0)).state;
    expect(s.textInput!.cursor).toBe(16);
    const done = applyMainMenuKey(s, MENU_KEY_COMMIT);
    expect(done.sound).toBe(2);
    expect(done.state.textInput).toBeNull();
    expect(done.state.seed).toEqual(parseMapSeedCode('3377462471731814'));
  });

  it('leaves the old seed standing when the code is incomplete', () => {
    const before = { ...initialMainMenuState(), seed: [1, 2, 3] as [number, number, number] };
    let s = applyMainMenuAction(before, 10).state;
    s = applyMainMenuKey(s, 0x33).state; // a single digit
    const done = applyMainMenuKey(s, MENU_KEY_COMMIT);
    expect(done.sound).toBe(4);
    expect(done.state.seed).toEqual([1, 2, 3]);
  });

  it('accepts nothing at the end of the buffer and does not advance', () => {
    let s = applyMainMenuAction(initialMainMenuState(), 10).state;
    for (let i = 0; i < 16; i++) s = applyMainMenuKey(s, 0x31).state;
    const full = s.textInput!;
    s = applyMainMenuKey(s, 0x32).state;
    expect(s.textInput).toEqual(full);
  });

  it('filters out characters outside 1..8', () => {
    let s = applyMainMenuAction(initialMainMenuState(), 10).state;
    for (const ch of ['0', '9', 'A', ' ']) s = applyMainMenuKey(s, ch.charCodeAt(0)).state;
    expect(s.textInput!.cursor).toBe(0);
  });

  it('backspace pulls along, delete leaves the cursor', () => {
    let s = applyMainMenuAction(initialMainMenuState(), 10).state;
    for (const ch of '1234') s = applyMainMenuKey(s, ch.charCodeAt(0)).state;
    const back = applyMainMenuKey(s, MENU_KEY_BACKSPACE).state.textInput!;
    expect(back.cursor).toBe(3);
    expect(back.text.slice(0, 4)).toBe('123 ');
    let left = s;
    for (let i = 0; i < 3; i++) left = applyMainMenuKey(left, MENU_KEY_CURSOR_LEFT).state;
    const del = applyMainMenuKey(left, MENU_KEY_DELETE).state.textInput!;
    expect(del.cursor).toBe(1);
    expect(del.text.slice(0, 4)).toBe('134 ');
  });

  it('display ∘ input is an involution — the ping-pong observed on the original', () => {
    // The game replaces a typed code by a second one, and the second one by the first again.
    const C1 = '6355576353382322';
    const C2 = '3343622245615673';
    expect(formatMapSeedCode(parseMapSeedCode(C1)!)).toBe(C2);
    expect(formatMapSeedCode(parseMapSeedCode(C2)!)).toBe(C1);
  });

  it('a typed display code lands in the 32-bit subspace b0==b2 and b3==b5', () => {
    // That is the reason for the involution — and the same statement as "the display carries 32 bits".
    for (const seed of [[0x4b6b, 0x29d7, 0x21c3], [0xaa48, 0x7599, 0x3289], [0x2d19, 0x9f5b, 0x3ee1]] as const) {
      const s = parseMapSeedCode(formatMapSeedCode(seed))!;
      const b = [s[0] & 0xff, s[0] >> 8, s[1] & 0xff, s[1] >> 8, s[2] & 0xff, s[2] >> 8];
      expect(b[0]).toBe(b[2]);
      expect(b[3]).toBe(b[5]);
      expect(s).not.toEqual([...seed]); // and it is NEVER the initial seed
    }
  });

  it('mapSeedInputCode leads back to the seed — where the DISPLAY does not', () => {
    // This is the extension that makes a bug report reproducible on the DOS original: the display of
    // the original loses 16 bits, the input does not. The first seed is that of the two original
    // captures — 512×256, and exactly the map with the stones in the water.
    // Wasser (Fehlerbericht qzbhr6q2).
    for (const seed of [
      [0x4b6b, 0x29d7, 0x21c3],
      [0x2d19, 0x9f5b, 0x3ee1],
      [0x0000, 0x0000, 0x0000],
      [0xffff, 0xffff, 0xffff],
    ] as const) {
      const code = mapSeedInputCode(seed);
      expect(code).toHaveLength(16);
      expect(/^[1-8]{16}$/.test(code)).toBe(true);
      expect(parseMapSeedCode(code)).toEqual([...seed]);
    }
    // And the other direction, so the statement is not merely "some bijection": the DISPLAYED code
    // The code of the same seed leads somewhere else.
    const seed: [number, number, number] = [0x4b6b, 0x29d7, 0x21c3];
    expect(mapSeedInputCode(seed)).not.toBe(formatMapSeedCode(seed));
    expect(parseMapSeedCode(formatMapSeedCode(seed))).not.toEqual(seed);
  });

  it('A12 rolls the opponents from the seed — 20 of 20 bytes against a real save', () => {
    // Original session: seed rolled, then the button beside it pressed, then saved.
    const seed: [number, number, number] = [0x2d19, 0x9f5b, 0x3ee1];
    const g = generateMenuOpponents(seed);
    expect(g.face).toEqual([9, 7, 3, 4]);
    expect(g.intelligence).toEqual([25, 38, 2, 12]);
    expect(g.supply).toEqual([39, 9, 11, 34]);
    expect(g.reproduction).toEqual([6, 25, 24, 13]);
    expect(g.humanSupply).toEqual([33, 8]);
    expect(g.humanReproduction).toEqual([17, 6]);
    const r = applyMainMenuAction({ ...initialMainMenuState(), seed }, 12);
    expect(r.effect).toEqual({ kind: 'preview' });
    expect(r.sound).toBe(2);
    expect(r.state.face).toEqual(g.face);
    expect(r.state.humanReproduction).toEqual(g.humanReproduction);
  });

  it('the rolled values stay within the ranges the sliders allow', () => {
    // Independent confirmation of MENU_TRAIT_MAX: the generator multiplies by 0x29 == 41.
    for (const seed of [[1, 2, 3], [0x4b6b, 0x29d7, 0x21c3], [0xffff, 0xffff, 0xffff]] as const) {
      const g = generateMenuOpponents(seed);
      for (const v of [...g.intelligence, ...g.supply, ...g.reproduction, ...g.humanSupply, ...g.humanReproduction])
        expect(v).toBeLessThanOrEqual(MENU_TRAIT_MAX);
      // 0 is allowed: the tail @0x50c2f switches slots 2/3 off and thereby rolls the player count.
      for (const f of g.face) expect(f === 0 || (f >= 1 && f <= 10)).toBe(true);
      expect(g.face[0]).toBeGreaterThanOrEqual(1); // slots 0/1 are never switched off
      expect(g.face[1]).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('password input', () => {
  const open = () => applyMainMenuAction(initialMainMenuState(), 4);

  it('A4 opens the input with eight spaces and WITHOUT a digit filter', () => {
    const r = open();
    expect(r.state.textInput).toEqual({
      field: 'password',
      text: PASSWORD_BLANK,
      cursor: 0,
      digitsOnly: false,
    });
    // The buffer IS the header field — A4 clears it along.
    expect(r.state.password).toBe(PASSWORD_BLANK);
  });

  it('every key press writes the header field along', () => {
    let s = open().state;
    for (const ch of 'YOKI') s = applyMainMenuKey(s, ch.charCodeAt(0)).state;
    expect(s.password).toBe('YOKI    ');
    expect(s.password).toBe(s.textInput!.text);
  });

  it('accepts letters — the digit filter applies only to the map code', () => {
    let s = open().state;
    for (const ch of 'ABCDEFGH') s = applyMainMenuKey(s, ch.charCodeAt(0)).state;
    expect(s.textInput!.text).toBe('ABCDEFGH');
    expect(s.textInput!.cursor).toBe(8);
  });

  it('recognises each of the 30 campaign passwords and returns its level', () => {
    const seen = new Set<number>();
    for (let level = 1; level <= CAMPAIGN_LEVEL_COUNT; level++) {
      const pw = decodeSetupPassword(SETUP_PASSWORD_BYTES[FIRST_CAMPAIGN_RECORD + level - 1]!);
      expect(matchCampaignPassword(pw)).toBe(level);
      seen.add(level);
    }
    expect(seen.size).toBe(30);
    // Discrimination: the passwords are pairwise different, so the mapping is not trivial.
    const all = new Set(
      [...Array(CAMPAIGN_LEVEL_COUNT).keys()].map((k) =>
        decodeSetupPassword(SETUP_PASSWORD_BYTES[FIRST_CAMPAIGN_RECORD + k]!),
      ),
    );
    expect(all.size).toBe(30);
  });

  it('"START" unlocks level 1, "PASSIVE" level 30', () => {
    for (const [pw, level] of [['START   ', 1], ['PASSIVE ', 30]] as const) {
      let s = open().state;
      for (const ch of pw.trimEnd()) s = applyMainMenuKey(s, ch.charCodeAt(0)).state;
      const done = applyMainMenuKey(s, MENU_KEY_COMMIT);
      expect(done.sound).toBe(2);
      expect(done.state.level).toBe(level);
      expect(done.state.unlockedLevel).toBe(level);
      expect(done.state.textInput).toBeNull();
      expect(done.state.password).toBe(pw);
    }
  });

  it('sets the bound instead of merely raising it — level 20 falls to 3 with the password of 3', () => {
    // @0x4f498 writes gs+0x358 (the bound) to the same value as gs+0x356 (the choice).
    const pw3 = decodeSetupPassword(SETUP_PASSWORD_BYTES[FIRST_CAMPAIGN_RECORD + 2]!);
    let s = applyMainMenuAction({ ...initialMainMenuState(), level: 20, unlockedLevel: 20 }, 4).state;
    for (const ch of pw3.trimEnd()) s = applyMainMenuKey(s, ch.charCodeAt(0)).state;
    const done = applyMainMenuKey(s, MENU_KEY_COMMIT);
    expect(done.state.unlockedLevel).toBe(3);
    expect(done.state.level).toBe(3);
  });

  it('leaves "-FEHLER-" on a wrong password instead of the typo', () => {
    let s = applyMainMenuAction({ ...initialMainMenuState(), level: 4, unlockedLevel: 9 }, 4).state;
    for (const ch of 'FALSCH') s = applyMainMenuKey(s, ch.charCodeAt(0)).state;
    const done = applyMainMenuKey(s, MENU_KEY_COMMIT);
    expect(done.sound).toBe(4);
    expect(done.state.password).toBe(PASSWORD_REJECT);
    expect(done.state.password.length).toBe(8);
    // Level and bound stay untouched — the error branch lies before the two stores.
    expect(done.state.level).toBe(4);
    expect(done.state.unlockedLevel).toBe(9);
  });

  it('records 0..5 carry no password and therefore unlock nothing', () => {
    // They all decode to "OOOOOOOO"; the loop starts only at record 6.
    expect(matchCampaignPassword(decodeSetupPassword(SETUP_PASSWORD_BYTES[0]!))).toBeNull();
    expect(matchCampaignPassword(PASSWORD_BLANK)).toBeNull();
  });

  it('the two fields use the same input but different redraw stages', () => {
    expect(MENU_INPUT_STAGE.password).toBe(5);
    expect(MENU_INPUT_STAGE.seed).toBe(6);
    // And they do not get in each other's way: A10 after A4 switches over completely.
    const s = applyMainMenuAction(open().state, 10).state;
    expect(s.textInput!.field).toBe('seed');
    expect(s.textInput!.text.length).toBe(MAP_SEED_CODE_LENGTH);
  });
});

describe('loaded save — the bit-6 branch', () => {
  const s = initialMainMenuState();
  /** The state the load chain leaves behind (`bts $0x6` @0x46f39). */
  const pending = { ...s, loadedGamePending: true };

  it('starts off', () => {
    expect(s.loadedGamePending).toBe(false);
    expect(menuZonesFor(s)).not.toBe(MENU_ZONES_LOADED);
  });

  it('A40 enters the game and clears the bit', () => {
    const r = applyMainMenuAction(pending, 40);
    expect(r.effect).toEqual({ kind: 'resume' });
    expect(r.state.loadedGamePending).toBe(false);
    expect(r.sound).toBe(2); // sound 2 "executed" (@0x4fc4d), not the router sound 8
    // Afterwards the game-type table applies again.
    expect(menuZonesFor(r.state)).toBe(menuZonesFor(s));
  });

  it('A41 goes back to the menu WITHOUT discarding the loaded save', () => {
    const r = applyMainMenuAction(pending, 41);
    expect(r.effect).toEqual({ kind: 'none' });
    expect(r.state.loadedGamePending).toBe(false);
    expect(r.sound).toBe(2);
    // The body @0x4fcb4 has only two writes (bit 6, redraw stage) — nothing else changes. That is
    // the difference to A40, which sets three clocks.
    expect({ ...r.state, loadedGamePending: true }).toEqual(pending);
  });

  it('the three clocks of A40 are those of a NEW game', () => {
    // Byte proof: the bit-1 branch of the frame loop writes the same three values to the same three
    // Stellen (@0xbc13/@0xbc21/@0xbc2f gegen @0x4fc72/@0x4fc80/@0x4fc8e).
    expect(MENU_RESUME_CLOCKS.quitGrace).toBe(6000);
    expect(MENU_RESUME_CLOCKS.saveReminder30).toBe(180000);
    expect(MENU_RESUME_CLOCKS.saveReminder60).toBe(360000);
    // 100 Hz: 30 respectively 60 minutes, 60 seconds.
    expect(MENU_RESUME_CLOCKS.saveReminder30 / 100 / 60).toBe(30);
    expect(MENU_RESUME_CLOCKS.saveReminder60 / 100 / 60).toBe(60);
    expect(MENU_RESUME_CLOCKS.quitGrace / 100).toBe(60);
  });

  it('A40/A41 work without bit 6 as well — the original does not check it in the body', () => {
    // The bodies have no entry test; they are unreachable only through the zone table. An
    // `if (!loadedGamePending) return` would therefore be an invention.
    expect(applyMainMenuAction(s, 40).effect).toEqual({ kind: 'resume' });
    expect(applyMainMenuAction(s, 41).effect).toEqual({ kind: 'none' });
  });

  it('darkens the whole menu and lays ABBRUCH and START brightly on top', () => {
    // `bt $0x6` @0x4f1d4 ⇒ `orl $0x80808080` over the menu area, then two icons (@0x4f26e /
    // @0x4f28d). The port instead marks every command — equivalent, because no command reaches
    // beyond the area.
    const plain = mainMenuCommands(s);
    const dimmed = mainMenuCommands(pending);
    expect(dimmed).toHaveLength(plain.length + 2);
    expect(dimmed.slice(0, plain.length).every((c) => c.dim === true)).toBe(true);
    expect(plain.every((c) => c.dim !== true)).toBe(true);
    const tail = dimmed.slice(plain.length);
    expect(tail.map((c) => (c.kind === 'icon' ? c.icon : -1))).toEqual([
      MENU_ICON_CANCEL,
      MENU_ICON_START,
    ]);
    expect(tail.every((c) => c.dim !== true)).toBe(true);
    // ABBRUCH sits on the place LADEN otherwise occupies — a replacement, not an addition.
    const load = MENU_STAGE1_ICONS.find((t) => t.icon === 0x13c)!;
    const cancel = tail[0]!;
    const start = tail[1]!;
    expect(cancel.kind === 'icon' && cancel.x).toBe(menuX(load.col));
    expect(cancel.kind === 'icon' && cancel.y).toBe(menuY(load.row));
    expect(start.kind === 'icon' && start.x).toBe(menuX(0));
  });

  it('requests text and fills with the dim bit set', () => {
    // An icon needs the shifted palette (many indices), text and bars only `| 0x80` on their one
    // colour. Checked through a recording sink, not a rebuilt computation — otherwise the test
    // checks its own rebuild.
    const record = (cmds: readonly MenuCommand[]) => {
      const colors: number[] = [];
      const dims: boolean[] = [];
      drawMainMenu(
        {
          icon: (_e, _x, _y, d) => dims.push(d === true),
          glyph: (_e, _x, _y, c) => colors.push(c),
          fill: (_x, _y, _w, _h, c) => colors.push(c),
        },
        cmds,
        (ch) => GLYPH_ENTRY.get(ch),
      );
      return { colors, dims };
    };
    const dark = record(mainMenuCommands(pending));
    expect(dark.colors.length).toBeGreaterThan(0);
    expect(dark.colors.every((c) => (c & MENU_DIM_BIT) !== 0)).toBe(true);
    expect(dark.dims.filter((d) => !d)).toHaveLength(2);
    const bright = record(mainMenuCommands(s));
    expect(bright.colors.every((c) => (c & MENU_DIM_BIT) === 0)).toBe(true);
    expect(bright.dims.every((d) => !d)).toBe(true);
  });
});

describe('A18 — take settings over to the left', () => {
  const s = initialMainMenuState();
  /** A free game with all four slots occupied. */
  const full = {
    ...s,
    gameType: GAME_TYPE_ONE_PLAYER,
    face: [12, 3, 4, 5] as const,
    intelligence: [40, 11, 12, 13] as const,
    supply: [30, 21, 22, 23] as const,
    reproduction: [30, 31, 32, 33] as const,
  } as unknown as typeof s;

  it('takes the HIGHEST occupied slot', () => {
    const r = applyMainMenuAction(full, 18).state;
    expect(r.supply).toEqual([23, 23, 23, 23]);
    expect(r.intelligence).toEqual([13, 13, 13, 13]);
    expect(r.reproduction).toEqual([33, 33, 33, 33]);
    // The two human fields get supply and reproduction — there is no intelligence there.
    expect(r.humanSupply).toEqual([23, 23]);
    expect(r.humanReproduction).toEqual([33, 33]);
  });

  it('advances to slot 2 when slot 3 is empty', () => {
    const r = applyMainMenuAction({ ...full, face: [12, 3, 4, 0] }, 18).state;
    expect(r.supply).toEqual([22, 22, 22, 22]);
    expect(r.intelligence).toEqual([12, 12, 12, 12]);
  });

  it('takes the SECOND HUMAN in "2 SPIELER" — and before slot 1', () => {
    // @0x4fb1d `cmpw $0x3,gs+0x352` stands in the cascade BEFORE the test on face 1. Exactly that
    // branch was missing, which is why the arrow did nothing in "2 SPIELER".
    const two = {
      ...full,
      gameType: GAME_TYPE_TWO_PLAYERS,
      face: [12, 3, 0, 0],
      humanSupply: [30, 17] as const,
      humanReproduction: [30, 41] as const,
    } as unknown as typeof s;
    const r = applyMainMenuAction(two, 18).state;
    expect(r.supply).toEqual([17, 17, 17, 17]);
    expect(r.reproduction).toEqual([41, 41, 41, 41]);
    // Intelligence comes from the literal here, not from slot 1 (which would carry 11).
    expect(r.intelligence).toEqual([HUMAN_INTELLIGENCE, HUMAN_INTELLIGENCE, HUMAN_INTELLIGENCE, HUMAN_INTELLIGENCE]);
    expect(r.humanSupply).toEqual([17, 17]);
  });

  it('takes slot 1 only when it is NOT a two-player game', () => {
    const r = applyMainMenuAction({ ...full, face: [12, 3, 0, 0] }, 18).state;
    expect(r.supply).toEqual([21, 21, 21, 21]);
    expect(r.intelligence).toEqual([11, 11, 11, 11]);
  });

  it('does nothing when no slot is occupied (`ret` @0x4fb7b)', () => {
    const empty = { ...full, face: [12, 0, 0, 0] } as unknown as typeof s;
    expect(applyMainMenuAction(empty, 18).state).toEqual(empty);
  });

  it('draws its three arrows only in the free game', () => {
    const arrows = (gameType: number) =>
      mainMenuCommands({ ...s, gameType }).filter((c) => c.kind === 'icon' && c.icon === 0x134);
    expect(arrows(GAME_TYPE_LEVEL)).toHaveLength(0);
    expect(arrows(GAME_TYPE_MISSION)).toHaveLength(0);
    expect(arrows(GAME_TYPE_ONE_PLAYER)).toHaveLength(3);
    expect(arrows(GAME_TYPE_DEMO)).toHaveLength(3);
    // They lie on the three A18 zones — that is the real proof that the columns are right.
    const zones = menuZonesFor({ ...s, gameType: GAME_TYPE_ONE_PLAYER }).filter((z) => z.action === 18);
    expect(zones).toHaveLength(3);
    for (const z of zones) {
      const cx = ((z.x0 + z.x1) >> 1) + 16;
      expect(arrows(GAME_TYPE_ONE_PLAYER).some((a) => a.kind === 'icon' && a.x <= cx && cx < a.x + 16)).toBe(true);
    }
  });
});

describe('start state', () => {
  it('rolls the map seed and the opponents (program start @0x4098 → @0x4dac)', () => {
    let n = 0;
    const s = startMainMenu(() => [0x1234, 0x5678, 0x9abc, 0x1111, 0x2222][n++] ?? 0x3333);
    expect(s.seed).toEqual([0x1234, 0x5678, 0x9abc]);
    // The seed is NEVER [0,0,0].
    expect(s.seed.some((w) => w !== 0)).toBe(true);
    // And the opponents are generated from it, not the default of the empty state.
    expect(s).toEqual({ ...initialMainMenuState(), seed: s.seed, ...generateMenuOpponents(s.seed) });
  });
});

describe('progress bar of the map generation (`FUN_00007a63` @0x7a63)', () => {
  /** Collect all `fill` calls of a run. */
  function bar(done: number): { x: number; y: number; w: number; h: number; color: number }[] {
    const out: { x: number; y: number; w: number; h: number; color: number }[] = [];
    const target: MenuTarget = {
      icon: () => {},
      glyph: () => {},
      fill: (x, y, w, h, color) => out.push({ x, y, w, h, color }),
    };
    drawMapGenProgress(target, done);
    return out;
  }

  it('paints one rectangle of the original size per segment', () => {
    expect(bar(3)).toEqual([
      { x: 0x10, y: 0x43, w: 8, h: 2, color: 0x48 },
      { x: 0x18, y: 0x43, w: 8, h: 2, color: 0x48 },
      { x: 0x20, y: 0x43, w: 8, h: 2, color: 0x48 },
    ]);
  });

  it('reaches exactly from the left to the right edge of the menu area when full', () => {
    const full = bar(MAP_GEN_BAR.segments);
    expect(full).toHaveLength(MAP_GEN_BAR.segments);
    expect(full[0]?.x).toBe(MENU_AREA.x);
    const last = full[full.length - 1];
    expect((last?.x ?? 0) + (last?.w ?? 0)).toBe(MENU_AREA.x + MENU_AREA.width);
  });

  /** `gs+0x188` can only grow; the clamp protects the caller, not the original. */
  it('draws nothing at 0 and never beyond the right edge', () => {
    expect(bar(0)).toEqual([]);
    expect(bar(-5)).toEqual([]);
    expect(bar(MAP_GEN_BAR.segments + 12)).toHaveLength(MAP_GEN_BAR.segments);
  });
});

describe('main menu — campaign progress (`action_quit_confirm` @0x2ebdb)', () => {
  const h = (gameType: number, winnerIndex: number, level: number, shown?: number) =>
    ({ gameType, winnerIndex, levelSetupIndex: level, levelSetupShown: shown });

  it('touches only the level game type (@0x2ec1d)', () => {
    expect(advanceCampaignProgress(h(1, 0, 3, 9))).toBeNull();
    expect(advanceCampaignProgress(h(2, 0, 3, 9))).toBeNull();
    expect(advanceCampaignProgress(h(4, 0, 3, 9))).toBeNull();
  });

  it('advances only when SLOT 0 has won (@0x2ec29 — `or ax,ax` against −1 and 1..3)', () => {
    expect(advanceCampaignProgress(h(0, -1, 3, 9))).toEqual({ level: 3, unlockedLevel: 9 });
    expect(advanceCampaignProgress(h(0, 1, 3, 9))).toEqual({ level: 3, unlockedLevel: 9 });
    expect(advanceCampaignProgress(h(0, 0, 3, 9))).toEqual({ level: 4, unlockedLevel: 9 });
  });

  it('raises the bound only on a real increase (`jb`/`je` @0x2ec5c/@0x2ec5e)', () => {
    // level+1 == unlocked ⇒ `je` ⇒ leave standing; level+1 > unlocked ⇒ write.
    expect(advanceCampaignProgress(h(0, 0, 8, 9))).toEqual({ level: 9, unlockedLevel: 9 });
    expect(advanceCampaignProgress(h(0, 0, 9, 9))).toEqual({ level: 10, unlockedLevel: 10 });
  });

  it('the cap is an EQUALITY test, not a clamp (@0x2ec3c)', () => {
    expect(advanceCampaignProgress(h(0, 0, CAMPAIGN_LEVEL_CAP, CAMPAIGN_LEVEL_CAP)))
      .toEqual({ level: CAMPAIGN_LEVEL_CAP, unlockedLevel: CAMPAIGN_LEVEL_CAP });
    // One level below does work — otherwise the check above would pass with `>=` as well.
    expect(advanceCampaignProgress(h(0, 0, CAMPAIGN_LEVEL_CAP - 1, CAMPAIGN_LEVEL_CAP))?.level)
      .toBe(CAMPAIGN_LEVEL_CAP);
  });

  it('without `levelSetupShown` the played level applies', () => {
    expect(advanceCampaignProgress(h(0, 0, 4))).toEqual({ level: 5, unlockedLevel: 5 });
  });

  it('the password rides along in every branch — this branch does not touch `gs+0x35a`', () => {
    const pw = (gameType: number, winnerIndex: number, level: number, shown: number) =>
      advanceCampaignProgress({ ...h(gameType, winnerIndex, level, shown), levelPassword: 'STATION ' });
    expect(pw(0, 0, 3, 9)).toEqual({ level: 4, unlockedLevel: 9, password: 'STATION ' });
    expect(pw(0, -1, 3, 9)).toEqual({ level: 3, unlockedLevel: 9, password: 'STATION ' });
    expect(pw(0, 1, 3, 9)).toEqual({ level: 3, unlockedLevel: 9, password: 'STATION ' });
    expect(pw(0, 0, CAMPAIGN_LEVEL_CAP, CAMPAIGN_LEVEL_CAP)).toEqual({
      level: CAMPAIGN_LEVEL_CAP,
      unlockedLevel: CAMPAIGN_LEVEL_CAP,
      password: 'STATION ',
    });
  });

  it('leaves the key ABSENT without a password — a present `undefined` would blank the menu line', () => {
    const p = advanceCampaignProgress(h(0, 0, 3, 9));
    expect(p).not.toBeNull();
    expect('password' in p!).toBe(false);
    // What the menu does with it: the spread must not overwrite the line.
    expect({ ...initialMainMenuState(), ...p! }.password).toBe(initialMainMenuState().password);
  });
});

describe('main menu — map preview (`gs+0x37e` Bit 1, Leisten-Slot 2)', () => {
  const ready = (): MainMenuState => ({
    ...initialMainMenuState(),
    gameType: 2,
    face: [12, 5, 0, 0],
    previewGenerated: true,
    panelIcon2: MENU_PANEL_ICON_PREVIEW,
  });

  it('A12 sets bit and icon (@0x50c6a / @0x50a60)', () => {
    const r = applyMainMenuAction({ ...initialMainMenuState(), gameType: 2 }, 12);
    expect(r.state.previewGenerated).toBe(true);
    expect(r.state.panelIcon2).toBe(MENU_PANEL_ICON_PREVIEW);
  });

  it.each([
    [9, 'roll the seed'],
    [10, 'Karten-Code'],
    [18, 'transfer values'],
    [14, 'Regler'],
    [23, 'face on/off'],
    [19, 'Gesicht weiter'],
  ])('A%i (%s) discards it with sound 0x30 (shared helper 0x50376)', (action, _who) => {
    const r = applyMainMenuAction(ready(), action as number, 20, () => 0x1234);
    expect(r.state.previewGenerated).toBe(false);
    expect(r.state.panelIcon2).toBe(MENU_PANEL_ICON_IDLE);
    expect(r.extraSound).toBe(MENU_PREVIEW_DISCARD_SOUND);
  });

  it('the sound is CONDITIONAL, the icon is not (@0x50381 vs. the fall-through to 0x503b3)', () => {
    const r = applyMainMenuAction({ ...initialMainMenuState(), gameType: 2 }, 14, 20);
    expect(r.extraSound).toBeUndefined();
    expect(r.state.panelIcon2).toBe(MENU_PANEL_ICON_IDLE);
  });

  it('A18 without an occupied slot returns BEFORE the helper (`ret` @0x4fb7b)', () => {
    const r = applyMainMenuAction({ ...ready(), face: [12, 0, 0, 0] }, 18);
    expect(r.state.previewGenerated).toBe(true);
    expect(r.extraSound).toBeUndefined();
  });

  it('A0 resets the icon on the wrap and sets it again at game type 2 (@0x50ca6/@0x50cfb)', () => {
    let s = applyMainMenuAction({ ...ready(), gameType: 4 }, 0).state;
    expect(s.gameType).toBe(0);
    expect(s.panelIcon2).toBe(MENU_PANEL_ICON_IDLE);
    expect(s.previewGenerated).toBe(true); // only the icon, not the bit
    s = applyMainMenuAction(s, 0).state;
    s = applyMainMenuAction(s, 0).state;
    expect(s.gameType).toBe(2);
    expect(s.panelIcon2).toBe(MENU_PANEL_ICON_PREVIEW);
  });

  it('menuPanelIcons embeds slot 2 into the default row', () => {
    expect(menuPanelIcons(initialMainMenuState())).toEqual([0, 7, MENU_PANEL_ICON_IDLE, 12, 14]);
    expect(menuPanelIcons(ready())).toEqual([0, 7, MENU_PANEL_ICON_PREVIEW, 12, 14]);
  });
});
