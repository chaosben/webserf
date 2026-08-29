/**
 * **The main menu** — `fullscreen_menu_dispatch` @0x4e29f and its click chain @0x4f6f0/@0x4f7fe.
 *
 * State, layout and click resolution; the drawing itself is done by {@link mainMenuCommands} as a pure
 * command list, so the backend stays exchangeable (the same pattern as `terrain-commands.ts`).
 *
 * ## Three things that are NOT obvious here
 *
 * **1. The menu lives on a different surface than the game.** `draw_popup_icon` @0x4f336
 * unconditionally sets `DAT_00003eb7` — the **352 × 240** surface —, while the entire rest of the
 * ported UI set (`ui-render.ts`: `UI_SCREEN`, `POPUP_BOUNDS`, `MAP_AREA`) belongs to the 640 × 480
 * set. Its constants do NOT apply here. A second, independent proof of the same number: the darkening
 * loop @0x4f1f5 skips 16 bytes per row, ors 20 × 16 and skips 16 again — step width 352, start offset
 * `0xb00 == 8 · 352`.
 *
 * **2. `vp[0x1b8]` are redraw STAGES, not screens.** The jump table @0x4e2ea holds seven entries, but
 * they call one another: 2 = frame + content, 3 = frame only, 4 = content only. The port redraws per
 * frame and therefore needs only stage 1 — the other six are a DOS optimisation.
 *
 * **3. Click x and drawing x share an origin but not a unit.** Both measure from surface x 16; the
 * drawing however computes in EIGHTH-COLUMNS (`col · 8 + 16`), the zone tables stand in PIXELS.
 * Reading the zones as columns hits nothing.
 */

import { Rng } from './engine/rng.js';
import { deriveMapSeed } from './engine/map-generator.js';
import {
  FIRST_CAMPAIGN_RECORD,
  PASSWORD_CHARS,
  SETUP_PASSWORD_BYTES,
  decodeSetupPassword,
} from './player-setup.js';
import {
  TEXT_KEY_BACKSPACE,
  TEXT_KEY_COMMIT,
  TEXT_KEY_CURSOR_LEFT,
  TEXT_KEY_CURSOR_RIGHT,
  TEXT_KEY_DELETE,
  editTextBuffer,
} from './text-input.js';
import { t } from './language.js';
import { UI_SOUND_PANEL_BUTTON, UI_SOUND_REJECT } from './ui-sound.js';

// ─── geometry ────────────────────────────────────────────────────────────────────────────────────

/** The drawing surface of the menu (`DAT_00003eb7`, `toggle_screen_layout` @0x2d717: `0x160 × 0xf0`). */
export const MENU_SURFACE = { width: 352, height: 240 } as const;

/**
 * Origin of all menu coordinates (`draw_popup_icon` @0x4f336: `addw $0x10,x` / `addw $0x10,y` +
 * `addw $0x8,y`). Identical for icons AND text (`draw_popup_string` @0x37c5b: `+0x10` / `+0x18`).
 */
export const MENU_ORIGIN = { x: 16, y: 24 } as const;

/** Eighth-column → surface pixel (`x <<= 3 ; x += 0x10`). */
export const menuX = (col: number): number => col * 8 + MENU_ORIGIN.x;
/** Row → surface pixel (`y += 0x10 ; y += 0x8`). One row is ONE pixel. */
export const menuY = (row: number): number => row + MENU_ORIGIN.y;

/**
 * The PAINTED menu area: surface x 16..336, surface y 8..200 (320 × 192). Computed from the darkening
 * loop @0x4f1f5 — 192 rows from row `0xb00 / 352 == 8`, per row 16 + 320 + 16.
 */
export const MENU_AREA = { x: 16, y: 8, width: 320, height: 192 } as const;

/**
 * The CLICKABLE area (gate @0x4f753 ff.): 320 × 168 from (16, 24). The topmost 16 rows of the painted
 * area (the title lettering) and the lowest 8 are deliberately NOT clickable.
 */
export const MENU_CLICK_AREA = { x: 16, y: 24, width: 320, height: 168 } as const;

/** Icon bank base of the menu (`addw $0x366,icon` @0x4f365) — the same as in the game. */
export const MENU_ICON_BASE = 0x366 - 1;

/** Text colour (`mov $0x1f,%eax` @0x37c64) — palette index 31. */
export const MENU_TEXT_COLOR = 0x1f;

/**
 * **Shadow colour of the menu text** — palette index 1 (i.e. black).
 *
 * This is the only difference between the two wrappers of the same drawing loop `draw_font_string`
 * @0x37cda, and it decides whether a shadow arises at all:
 *
 * | | `draw_popup_string` @0x37c16 (menu) | `draw_popup_panel_text` @0x37c78 (game panel) |
 * |---|---|---|
 * | origin | `col·8 + 0x10` / `row + 0x18` | `col·8 + 8` / `row + 9` |
 * | text colour `ctx+0x10` | `mov $0x1f` @0x37c64 | `mov $0x1f` @0x37cc6 |
 * | shadow `ctx+0x14` | **`mov $0x1` @0x37c6c** | `mov $0x0` @0x37cce |
 *
 * The loop tests `ctx+0x14` against zero (`mov 0x14(%edi),%ax ; or ; je 0x37dfd` @0x37da0) — in the
 * game panel the shadow blit is therefore skipped.
 */
export const MENU_TEXT_SHADOW_COLOR = 1;

/**
 * Distance between glyph and shadow sprite in the bank: `0x329 − 0x2ed` (`addw $0x329,0x8(%edi)`
 * @0x37dce against `addw $0x2ed,0x8(%edi)` @0x37e03).
 *
 * The 60 is at the same time the bank width `Font` ↔ `FontShadow` — both banks have the same 44 of 60
 * slots occupied. The shadow lies at the SAME place as the glyph and is a 10 × 10 sprite of its own
 * with pivot `(-1, -1)`, i.e. a one-pixel outline around the 8 × 8 glyph — not a displaced second
 * print. (Rebuilding it as an offset finds none: over all 25 offsets within ±2 the best explains 152
 * of 355 pixels.)
 */
export const MENU_GLYPH_SHADOW_OFFSET = 0x329 - 0x2ed;

/**
 * Fill colour of the character cell when `gs+0x1ca` bit 4 is set (`mov $0x0,%eax` @0x37d52) — palette
 * index 0, i.e. black. That is the background of the input fields.
 */
export const MENU_BOXED_TEXT_COLOR = 0;

// ─── state ───────────────────────────────────────────────────────────────────────────────────────

/** The five game types (`gs+0x352`, strings @0x4f14e/@0x4f158/@0x4f162). */
export const GAME_TYPE_LEVEL = 0;
export const GAME_TYPE_MISSION = 1;
export const GAME_TYPE_ONE_PLAYER = 2;
export const GAME_TYPE_TWO_PLAYERS = 3;
export const GAME_TYPE_DEMO = 4;

/**
 * **Deliberate deviation from the original**: the two-human mode cannot be selected. The original has
 * two ways into it, and both set the same bit 2 of `gs+0x37e` (@0x4fde6) — game type 3 ("2 SPIELER")
 * and the split-screen wish A1 (`btc $0x0`, effective at game types 0..2). Both need a second viewport
 * with its own bar and its own cursor, which this port does not have.
 *
 * Removed is ONLY the way there: A0 skips the 3, A1 is ineffective. Everything describing the state
 * stays — zone table `0x505cf`, the column branches in {@link menuColumns}, `resolveGameSetup` —,
 * because a save with `gameType 3` must remain loadable and the byte evidence checkable.
 */
export const SELECTABLE_GAME_TYPES: readonly number[] = [
  GAME_TYPE_LEVEL,
  GAME_TYPE_MISSION,
  GAME_TYPE_ONE_PLAYER,
  GAME_TYPE_DEMO,
];

/**
 * The complete menu state. The field names follow what the game DERIVES from it (`init_players`), not
 * the setup record — that one holds the two middle ones the other way round.
 */
export interface MainMenuState {
  /** `gs+0x352` — 0..4. */
  readonly gameType: number;
  /** `gs+0x356` — chosen level (1 .. {@link unlockedLevel}). */
  readonly level: number;
  /** `gs+0x358` — highest unlocked level. */
  readonly unlockedLevel: number;
  /** `gs+0x354` — chosen mission (1..6). */
  readonly mission: number;
  /** `gs+0x35a..0x361` — eight characters, padded with spaces. */
  readonly password: string;
  /** `gs+0x362` — map size 1..{@link maxMapSize}. */
  readonly mapSizeChoice: number;
  /** `gs+0x30c & 0xf` — the largest map selectable in the menu. */
  readonly maxMapSize: number;
  /** `gs+0x364/0x366/0x368` — the map seed as three u16. */
  readonly seed: readonly [number, number, number];
  /** `gs+0x36a + slot` — face per slot; `0` = unoccupied. */
  readonly face: readonly [number, number, number, number];
  /** `gs+0x36e + slot` — intelligence per slot. */
  readonly intelligence: readonly [number, number, number, number];
  /** `gs+0x372 + slot` — supply per slot. */
  readonly supply: readonly [number, number, number, number];
  /** `gs+0x376 + slot` — reproduction per slot. */
  readonly reproduction: readonly [number, number, number, number];
  /** `gs+0x37a`/`0x37b` — supply of the two human players. */
  readonly humanSupply: readonly [number, number];
  /** `gs+0x37c`/`0x37d` — reproduction of the two human players. */
  readonly humanReproduction: readonly [number, number];
  /** `gs+0x37e` bit 0 — split-screen wish (effective only at `gameType < 3`). */
  readonly splitscreen: boolean;
  /** The running text input, `null` if none — see {@link MenuTextInput}. */
  readonly textInput: MenuTextInput | null;
  /**
   * `gs+0x1c8` **bit 6** — a save is loaded and waiting for the user's confirmation.
   *
   * The bit has exactly ONE setter in the whole binary: `bts $0x6` @0x46f39, on the success path of
   * the load chain (result code 1 in `gs+0x240`). While it stands, the menu does two things — it
   * DARKENS ITSELF (`orl $0x80808080` over the 191 rows from `+0xb00`, branch @0x4f1de) and it uses a
   * ZONE TABLE OF ITS OWN with three zones (@0x4f794 → {@link MENU_ZONES_LOADED}). It is cleared only
   * by the two buttons of that table, A40 and A41.
   */
  readonly loadedGamePending: boolean;
  /**
   * `gs+0x37e` **bit 1** — "a map preview has been generated and stands".
   *
   * **The survey.** Bit 1 has exactly SIX accesses in the whole binary: one `bts` @0x50c6a (the tail
   * of {@link generateMenuOpponents}, i.e. A12), one `btr` @0x503a7 in the shared helper `0x50376`,
   * and four `bt` — @0x50381 (the same helper), @0x50cef (A0), @0x65f0 (menu rebuild), @0x46f85 (load
   * success). All four readers do the same: they write {@link panelIcon2}.
   *
   * **What for.** The six call sites of the helper are exactly the actions that change an INPUT OF THE
   * GENERATION: the seed (A9, A10) and the four player columns (the 16 sliders through their shared
   * body @0x50978, the face switches @0x509d0/@0x50a3b, A18 @0x4fc47). They discard the standing
   * preview — with a sound, see there.
   *
   * Menu and game use the same viewport object (`gs+0x78`), and slot 2 means "the overview map stands"
   * in both. In the menu the overview map IS the map preview.
   */
  readonly previewGenerated: boolean;
  /**
   * `vp[0x62]` — the icon of SLOT 2 of the control bar, the only one the menu touches.
   *
   * In the original it is viewport state and not a `gs` field; this port keeps it in the menu state,
   * because it has no menu viewport object. It is a STORED byte in the original as well:
   * `previewGenerated && gameType >= 2` matches it everywhere except at the load success (@0x46f85
   * does not ask the game type), and there a derived value would be wrong.
   *
   * The values are {@link MENU_PANEL_ICON_IDLE} and {@link MENU_PANEL_ICON_PREVIEW}.
   */
  readonly panelIcon2: number;
}

/**
 * Slot 2 of the bar in the IDLE state (`mov $0xa` @0x503d0) — the same value
 * `CONTROL_PANEL_DEFAULT_ICONS` in `ui-render.ts` carries as its init value.
 */
export const MENU_PANEL_ICON_IDLE = 0x0a;

/** Slot 2 with a standing preview (`mov $0x13` @0x5035d) — the pressed counterpart. */
export const MENU_PANEL_ICON_PREVIEW = 0x13;

/**
 * The sound with which a standing preview is discarded (`mov $0x30` @0x5038e → `0x3688a`).
 *
 * Its peculiarity is the CONDITION: the helper sounds only when bit 1 really was set — a slider
 * without a standing preview stays silent.
 */
export const MENU_PREVIEW_DISCARD_SOUND = 0x30;

/**
 * The five icons of the bar below the menu — `CONTROL_PANEL_DEFAULT_ICONS` with slot 2 from the menu
 * state. The menu does not touch the other four.
 */
export function menuPanelIcons(s: MainMenuState): number[] {
  return [0, 7, s.panelIcon2, 12, 14];
}

/**
 * **Which field the input is serving.** The original has NO field of its own for this: the two openers
 * request different REDRAW STAGES (`vp+0x1b8` — A4 the 5 "only the password line" @0x50f52, A10 the 6
 * "only the text block" @0x50fed), `fullscreen_menu_dispatch` copies the requested stage into
 * `vp+0x1ba` (@0x4e2c1), and the two evaluating branches of the frame pass test exactly that copy
 * (`cmpw $0x5` @0x4f39d respectively `cmpw $0x6` @0x4f53a).
 *
 * The field identity therefore IS the redraw stage. The port holds it as a value of its own because it
 * knows no partial redraw stages (it always draws stage 1) — the mapping stands in
 * {@link MENU_INPUT_STAGE} so the connection stays checkable.
 */
export type MenuInputField = 'password' | 'seed';

/** Field → redraw stage requested by the original. */
export const MENU_INPUT_STAGE: Readonly<Record<MenuInputField, number>> = { password: 5, seed: 6 };

/**
 * **The running text input.** Four fields in the original: `gs+0x23a` points at the buffer, `gs+0x23e`
 * holds its length, `gs+0x238` the write position, and `gs+0x1ca` bit 0 says "input active", bit 2
 * "digits only". The port holds the string itself instead of pointer + length; bit 0 is
 * `textInput !== null`, bit 1 ("changed") is pure redraw bookkeeping of the DOS renderer and is
 * dropped.
 *
 * Not obvious: the two fields have DIFFERENT buffer natures. The map code writes into a 16-byte block
 * of its own (`0x51004`), the password DIRECTLY INTO `gs+0x35a` (@0x50f03) — i.e. into exactly the
 * header field the save stores at @128. Hence this port writes every key press of the password input
 * through to {@link MainMenuState.password}.
 */
export interface MenuTextInput {
  /** Which field — see {@link MenuInputField}. */
  readonly field: MenuInputField;
  /** The buffer — ALWAYS as long as the field, padded with spaces. */
  readonly text: string;
  /** `gs+0x238` — write position `0..text.length`; at the end the buffer accepts nothing. */
  readonly cursor: number;
  /** `gs+0x1ca` bit 2 — only `'1'..'8'` are accepted (@0xd093/@0xd098). */
  readonly digitsOnly: boolean;
}

/**
 * **The campaign progress** — the two fields a won level advances.
 *
 * They are the same `gs+0x356`/`gs+0x358` that {@link MainMenuState.level} and
 * {@link MainMenuState.unlockedLevel} hold; they lie here together because the GAME screen writes them
 * and the menu reads them.
 */
export interface CampaignProgress {
  /** `gs+0x356` — the level offered next. */
  readonly level: number;
  /** `gs+0x358` — the highest unlocked level. */
  readonly unlockedLevel: number;
  /**
   * `gs+0x35a` — the eight characters of the password line. In the original this is the very cell
   * {@link MainMenuState.password} holds, so it travels with the two numbers; the mission end filled it
   * with the password of the level that follows the one just won.
   *
   * **Absent** rather than `undefined` when the game carried none: the menu applies this object with a
   * spread, and a present key would overwrite the line with nothing.
   */
  readonly password?: string;
}

/**
 * **The cap of the campaign** — `cmpw $0x1e,(%edi)` @0x2ec38.
 *
 * An EQUALITY test, not a clamp: if the level stands exactly at 30, nothing is raised. The difference
 * is not observable in the real game (30 is also the last level), but it is the original — with `>=`
 * an invention would stand here. The end credits trigger checks the same 30 (`LAST_CAMPAIGN_LEVEL`).
 */
export const CAMPAIGN_LEVEL_CAP = 0x1e;

/**
 * **Unlock a won level** — the middle block of `action_quit_confirm` @0x2ebdb, i.e. the button
 * "ENDE → JA".
 *
 * ```
 * 2ec13  if (gs[0x352] != 0)  → end       ; only the level game type
 * 2ec22  if (gs[0x5e]  != 0)  → end       ; only if SLOT 0 has won (−1 = nobody)
 * 2ec2e  t = gs[0x356]
 * 2ec38  if (t == 0x1e)       → end       ; cap, see CAMPAIGN_LEVEL_CAP
 * 2ec3e  t += 1 ; gs[0x356] = t
 * 2ec52  u = gs[0x358]
 * 2ec59  if (t <= u)          → end       ; `jb` AND `je` — only a real increase writes
 * 2ec66  gs[0x358] = t
 * ```
 *
 * **This is the only place in the whole binary that raises the progress.** Surveyed over all accesses
 * to the two fields: `gs+0x356` has five writers — the program init (@0xb41d, to 1), this branch,
 * loading (@0x47f19), the password hit (@0x4f4a5) and the level choice A2/A3 (@0x50d61) —, `gs+0x358`
 * four, and the MISSION END (screen 0x36) is under none: it only READS the level. The campaign
 * therefore does not advance when the victory window is clicked away but only on leaving — which is
 * consistent, because the exit of the mission end leads exactly to the "ENDE" dialog.
 *
 * The caller passes the HEADER OF THE RUNNING GAME, not the menu state: in the original they are the
 * same cells (loading writes them), in the port menu and game are separate, and what counts is the
 * game that is ending.
 *
 * @returns `null` for a game type other than "level" — then the original does not touch the two cells
 * at all, and the caller's menu state stays. Otherwise the pair that applies afterwards.
 */
export function advanceCampaignProgress(header: {
  readonly gameType: number;
  readonly winnerIndex: number;
  readonly levelSetupIndex: number;
  readonly levelSetupShown?: number;
  readonly levelPassword?: string;
}): CampaignProgress | null {
  if (header.gameType !== GAME_TYPE_LEVEL) return null; // @0x2ec1d
  const level = header.levelSetupIndex;
  // Without the second value, the level played is the highest we can prove.
  const unlockedLevel = header.levelSetupShown ?? level;
  // The password rides along in EVERY branch, including defeat and the cap: this branch does not touch
  // `gs+0x35a` at all (surveyed — @0x2ec2b..@0x2ec6c has no access to it), the only writer for a won
  // level is the mission end, and it has already run. Passing the unchanged field on is what "the cell
  // keeps its value" means once menu and game are two states instead of one.
  const password = header.levelPassword === undefined ? {} : { password: header.levelPassword };
  if (header.winnerIndex !== 0) return { level, unlockedLevel, ...password }; // @0x2ec29
  if (level === CAMPAIGN_LEVEL_CAP) return { level, unlockedLevel, ...password }; // @0x2ec3c
  const next = level + 1;
  // `jb` @0x2ec5c and `je` @0x2ec5e — the bound is only raised on a real increase.
  return {
    level: next,
    unlockedLevel: next > unlockedLevel ? next : unlockedLevel,
    ...password,
  };
}

/**
 * **The menu fields a LOADED save overwrites** — the second half of `savegame_load_header` @0x47ba8,
 * `.DS`@74/122/124/126/128/136/138/144..163 → `gs+0x352`..`gs+0x37d`.
 *
 * The original keeps the menu selection and the running game in the SAME cells, so loading a save is
 * at the same time a write into the main menu: after it the menu shows the game type, the level with
 * its password, the map size, the seed and the four opponent columns of the loaded game. In this port
 * menu and game are two states, which is why the write has to be repeated here — without it the menu
 * behind the "GELADEN." window still shows what stood there before the load.
 *
 * **The three gates read the LOADED game type**, not the one the menu had: `gs+0x352` is written
 * unconditionally @0x47d67, and all three tests below happen after it.
 *
 * ```
 * 47d67  gs[0x352] = buf[0x4a]                      ; always
 * 47ee5  if (gs[0x352] == 1)  gs[0x354] = buf[0x7a] ; mission
 * 47f03  if (gs[0x352] == 0)  gs[0x356] = buf[0x7c] ; level
 *                             gs[0x358] = buf[0x7e] ; unlocked
 *                             gs[0x35a] = buf[0x80] ; password, 8 bytes
 * 47f58  if (gs[0x352] >= 2)  gs[0x362] = buf[0x88] ; map size
 *                             gs[0x364] = buf[0x8a] ; seed, 3 u16
 *                             gs[0x36a] = buf[0x90] ; face      \
 *                             gs[0x36e] = buf[0x94] ; intelligence > four u32, one per slot
 *                             gs[0x372] = buf[0x98] ; supply     /
 *                             gs[0x376] = buf[0x9c] ; reproduction
 *                             gs[0x37a] = buf[0xa0] ; supply of the two humans
 *                             gs[0x37c] = buf[0xa2] ; reproduction of the two humans
 * ```
 *
 * The parser applies exactly the same gates, so the optional header fields are present precisely in
 * the branch that reads them; the fallbacks below are for the type checker, not for a case the
 * original knows.
 *
 * NOT part of this: `gs+0x37e` (split-screen wish, `gs+0x1c8` bit 6) — the load chain touches neither.
 * Bit 6 is set by the SUCCESS path (@0x46f39) and is {@link MainMenuState.loadedGamePending}, which
 * the caller sets beside this.
 */
export function menuFieldsFromLoadedSave(header: {
  readonly gameType: number;
  readonly missionSetupIndex: number;
  readonly levelSetupIndex: number;
  readonly levelSetupShown?: number;
  readonly levelPassword?: string;
  readonly mapSizeChoice?: number;
  readonly mapSeed?: readonly [number, number, number];
  readonly menuSetup?: {
    readonly face: readonly [number, number, number, number];
    readonly intelligence: readonly [number, number, number, number];
    readonly supply: readonly [number, number, number, number];
    readonly reproduction: readonly [number, number, number, number];
    readonly humanSupply: readonly [number, number];
    readonly humanReproduction: readonly [number, number];
  };
}): Partial<MainMenuState> {
  const gameType = header.gameType;
  if (gameType === GAME_TYPE_MISSION) {
    return { gameType, mission: header.missionSetupIndex }; // @0x47eed
  }
  if (gameType === GAME_TYPE_LEVEL) {
    const level = header.levelSetupIndex;
    return {
      gameType,
      level,
      unlockedLevel: header.levelSetupShown ?? level,
      ...(header.levelPassword === undefined ? {} : { password: header.levelPassword }),
    };
  }
  // @0x47f60 `jb` — game types 2..4 share the free-play block.
  const m = header.menuSetup;
  return {
    gameType,
    ...(header.mapSizeChoice === undefined ? {} : { mapSizeChoice: header.mapSizeChoice }),
    ...(header.mapSeed === undefined ? {} : { seed: header.mapSeed }),
    ...(m === undefined
      ? {}
      : {
          face: m.face,
          intelligence: m.intelligence,
          supply: m.supply,
          reproduction: m.reproduction,
          humanSupply: m.humanSupply,
          humanReproduction: m.humanReproduction,
        }),
  };
}

/**
 * {@link menuFieldsFromLoadedSave} applied — the whole menu state after a load.
 *
 * A standing text input is ended, and that is a decision rather than a reading: in the original the
 * password input has NO buffer of its own, it writes straight into `gs+0x35a` (@0x50f03) — the very
 * cell the load overwrites. This port holds a copy in {@link MenuTextInput.text}, so an input left
 * running would go on showing what was typed before the load and write it back on the next key.
 */
export function applyLoadedSaveToMenu(
  state: MainMenuState,
  header: Parameters<typeof menuFieldsFromLoadedSave>[0],
): MainMenuState {
  return { ...state, ...menuFieldsFromLoadedSave(header), textInput: null };
}

/**
 * The state with which the original enters the menu. The slider defaults are deliberately NOT
 * guessed: they stand as menu values in no init routine we have read — hence the values of the first
 * setup record (level 1) stand here, which the menu shows immediately anyway.
 */
export function initialMainMenuState(): MainMenuState {
  return {
    gameType: GAME_TYPE_LEVEL,
    level: 1,
    unlockedLevel: 1,
    mission: 1,
    password: 'START   ',
    mapSizeChoice: 3,
    // The upper bound is a runtime value in the original (`gs+0x30c & 0xf` @0x50e65), not a literal.
    // 8 is proven at two independent places: the captures carry `mapSize 8` (512 × 256), and the
    // service-budget table @0x7eb3 has exactly eight usable entries (index 9 falls into foreign data).
    maxMapSize: 8,
    seed: [0, 0, 0],
    textInput: null,
    face: [12, 0, 0, 0],
    intelligence: [40, 0, 0, 0],
    supply: [30, 0, 0, 0],
    reproduction: [30, 0, 0, 0],
    humanSupply: [30, 30],
    humanReproduction: [30, 30],
    splitscreen: false,
    loadedGamePending: false,
    previewGenerated: false,
    panelIcon2: MENU_PANEL_ICON_IDLE,
  };
}

/**
 * **The state at program start** — `jmp 0x4dac` @0x4098, immediately before `new_game_init`.
 *
 * The original rolls THREE values into the map seed there (@0x4db8/@0x4dce/@0x4de4) and then calls
 * the opponent generator (`call 0x50a6b` @0x4dee) — the same chain as button A12, only without a
 * screen. The seed is therefore NEVER `[0,0,0]` when the menu first appears.
 *
 * Re-entering the menu from a running game (`0x409d`) does NOT do that — it jumps straight to
 * `new_game_init`. The roll happens exactly once, at the start of the program.
 */
export function startMainMenu(rng: () => number): MainMenuState {
  const s = initialMainMenuState();
  const seed: [number, number, number] = [rng() & 0xffff, rng() & 0xffff, rng() & 0xffff];
  return { ...s, seed, ...generateMenuOpponents(seed) };
}

// ─── tile tables ─────────────────────────────────────────────────────────────────────────────────

/** An icon placement in menu coordinates (eighth-column, row). */
export interface MenuIcon {
  readonly icon: number;
  readonly col: number;
  readonly row: number;
}

/**
 * The wrap rule of both tiling loops: the icon index runs DOWNWARDS and jumps from `0x121` to `0x126`
 * (@0x4ecad in the frame, @0x420d5 in the background). Five tiles in the cycle:
 * `0x122 0x126 0x125 0x124 0x123`.
 */
const nextTileIcon = (icon: number): number => (icon - 1 === 0x121 ? 0x126 : icon - 1);

/**
 * **Background tiling** (`FUN_000420a5`) — the underlay of the whole menu area.
 *
 * Two peculiarities lost when rebuilding: the loops test the value BEFORE the decrement
 * (`while (7 < prev)` respectively `while (4 < prev)`) and therefore run down to and including 0; and
 * drawing goes through `FUN_0004f33b` — that is `draw_popup_icon` WITHOUT its first instruction, so
 * the row only gets `+8` instead of `+24`.
 */
export function menuBackgroundTiles(): MenuIcon[] {
  const out: MenuIcon[] = [];
  let icon = 0x125;
  for (let row = 0xb8; ; row -= 8) {
    for (let col = 0x23; ; col -= 5) {
      out.push({ icon, col, row });
      if (!(col > 4)) break;
    }
    icon = nextTileIcon(icon);
    if (!(row > 7)) break;
  }
  return out;
}

/** Row offset of the background tiles: `+8` instead of `+24`, because `FUN_0004f33b` enters. */
export const menuBackgroundY = (row: number): number => row + 8;

/**
 * **The tile box of the control strip** (`draw_menu_box_frame` @0x4ec8e) — 6 rows × 4 columns behind
 * "MISSION/PASSWORT" respectively "KARTEN-GROESSE".
 */
export function menuBoxTiles(): MenuIcon[] {
  const out: MenuIcon[] = [];
  let icon = 0x122;
  for (let row = 0x50; row !== 0x20; row -= 8) {
    for (let col = 0x19; col !== 5; col -= 5) out.push({ icon, col, row });
    icon = nextTileIcon(icon);
  }
  return out;
}

/** The button START (`mov $0x10a` @0x4f28d) — column 0 of the button row. */
export const MENU_ICON_START = 0x10a;
/**
 * The button ABBRUCH (`mov $0x11c` @0x4f26e). It occurs ONLY in the state "loaded save waiting" and
 * sits there on the place of LADEN (`0x13c`, column 0x24) — the two buttons of that state are
 * therefore START (resume, A40) and ABBRUCH (back to the menu, A41), exactly the two zones of
 * {@link MENU_ZONES_LOADED}.
 */
export const MENU_ICON_CANCEL = 0x11c;
/** Row of both buttons of the loaded state (`mov $0x30` @0x4f266 / @0x4f285). */
export const MENU_LOADED_ROW = 0x30;
/** Column of ABBRUCH (`mov $0x24` @0x4f25f) — the place LADEN otherwise occupies. */
export const MENU_LOADED_CANCEL_COL = 0x24;

/**
 * **The fixed icon table of stage 1** (`DAT_0004f29e`, `{i16 icon, u16 col, u16 row}` up to a negative
 * icon). Four player columns of five icons each plus the three buttons and the two title graphics.
 */
export const MENU_STAGE1_ICONS: readonly MenuIcon[] = [
  { icon: 0xfb, col: 0x00, row: 0x58 },
  { icon: 0xfc, col: 0x00, row: 0xa0 },
  { icon: 0xfd, col: 0x00, row: 0x60 },
  { icon: 0xfe, col: 0x05, row: 0x60 },
  { icon: 0xff, col: 0x09, row: 0x60 },
  { icon: 0xfb, col: 0x0a, row: 0x58 },
  { icon: 0xfc, col: 0x0a, row: 0xa0 },
  { icon: 0xfd, col: 0x0a, row: 0x60 },
  { icon: 0xfe, col: 0x0f, row: 0x60 },
  { icon: 0xff, col: 0x13, row: 0x60 },
  { icon: 0xfb, col: 0x14, row: 0x58 },
  { icon: 0xfc, col: 0x14, row: 0xa0 },
  { icon: 0xfd, col: 0x14, row: 0x60 },
  { icon: 0xfe, col: 0x19, row: 0x60 },
  { icon: 0xff, col: 0x1d, row: 0x60 },
  { icon: 0xfb, col: 0x1e, row: 0x58 },
  { icon: 0xfc, col: 0x1e, row: 0xa0 },
  { icon: 0xfd, col: 0x1e, row: 0x60 },
  { icon: 0xfe, col: 0x23, row: 0x60 },
  { icon: 0xff, col: 0x27, row: 0x60 },
  { icon: MENU_ICON_START, col: 0x00, row: 0x30 }, // START
  { icon: 0x10b, col: 0x1f, row: 0x30 }, // EXTRA OPTION
  { icon: 0x13c, col: 0x24, row: 0x30 }, // LADEN
  { icon: 0x11b, col: 0x00, row: 0x00 }, // Titel-Schriftzug
  { icon: 0x13d, col: 0x00, row: 0x00 }, // Titel-Zusatz
];

// ─── player columns ──────────────────────────────────────────────────────────────────────────────

/**
 * A column descriptor as `FUN_0004e3d2` builds it into the table @0x4ea77: SIX BYTES — `u16 icon`,
 * `u8 kind`, then three value bytes.
 *
 * The three values are `[intelligence, supply, reproduction]` across ALL game types. For the human
 * player the first is the literal `0x28` (== 40) — exactly the value from which `init_players`
 * computes the u16 limit 65535 of the AI rate. With level/mission the three come from the RAW bytes
 * of the setup record, in the same order; the two middle ones are swapped only by `apply_game_setup`.
 */
export interface MenuColumn {
  readonly icon: number;
  readonly kind: number;
  readonly values: readonly [number, number, number];
}

/** Icon of an empty slot (`mov $0x119`) respectively base of an occupied one (`face + 0x10b`). */
export const MENU_FACE_ICON_EMPTY = 0x119;
export const MENU_FACE_ICON_BASE = 0x10b;

/** The intelligence literal of the human player (`mov $0x28`). */
export const HUMAN_INTELLIGENCE = 0x28;

/**
 * **The three columns of the take-over arrows** (A18) — eighth-columns 15/25/35 on row `0x60`. The
 * original draws the plate `0xfe` descending (@0x4e3d2 ff.) and the arrow `0x134` ascending; the
 * order has no effect, because the three do not overlap.
 */
export const MENU_TRANSFER_COLUMNS: readonly number[] = [0x0f, 0x19, 0x23];

/**
 * Build the four column descriptors (first pass of `FUN_0004e3d2`).
 *
 * `recordPlayers` are the RAW quadruples of the setup record (`[face, intelligence, supply,
 * reproduction]`) for slots 1..3 and `recordHuman` the two bytes at `rec+0x0e/0x0f` — both used only
 * when `gameType <= 1`.
 */
export function menuColumns(
  s: MainMenuState,
  recordHuman: readonly [number, number] = [0, 0],
  recordPlayers: readonly (readonly [number, number, number, number])[] = [],
): MenuColumn[] {
  const out: MenuColumn[] = [];
  for (let slot = 0; slot < 4; slot++) {
    if (slot === 0 && s.gameType !== GAME_TYPE_DEMO) {
      // Human player. `kind` distinguishes alone/second/split screen (@0x4e51f ff.).
      const kind = s.gameType === GAME_TYPE_TWO_PLAYERS ? 0 : s.splitscreen ? 2 : 0;
      const v =
        s.gameType <= GAME_TYPE_MISSION
          ? ([recordHuman[0], recordHuman[1]] as const)
          : ([s.humanSupply[0], s.humanReproduction[0]] as const);
      out.push({ icon: 0x117, kind, values: [HUMAN_INTELLIGENCE, v[0], v[1]] });
      continue;
    }
    if (slot === 1 && s.gameType === GAME_TYPE_TWO_PLAYERS) {
      out.push({
        icon: 0x118,
        kind: 1,
        values: [HUMAN_INTELLIGENCE, s.humanSupply[1], s.humanReproduction[1]],
      });
      continue;
    }
    if (s.gameType <= GAME_TYPE_MISSION) {
      const rec = recordPlayers[slot - 1];
      const face = rec?.[0] ?? 0;
      out.push(
        face === 0
          ? { icon: MENU_FACE_ICON_EMPTY, kind: 5, values: [0, 0, 0] }
          : { icon: face + MENU_FACE_ICON_BASE, kind: 5, values: [rec![1], rec![2], rec![3]] },
      );
      continue;
    }
    const face = s.face[slot] ?? 0;
    out.push(
      face === 0
        ? { icon: MENU_FACE_ICON_EMPTY, kind: 4, values: [0, 0, 0] }
        : {
            icon: face + MENU_FACE_ICON_BASE,
            kind: 3,
            values: [s.intelligence[slot]!, s.supply[slot]!, s.reproduction[slot]!],
          },
    );
  }
  return out;
}

/** Eighth-column of column `slot` (`vreg4` runs 0, 10, 20, 30). */
export const menuColumnBase = (slot: number): number => slot * 10;

/**
 * The three slider bars of a column: x offset IN PIXELS from `slot·80`, colour, and which of the
 * three values is drawn. Order and colours stand so in the body (@0x4e5f0 ff.); the bar grows upwards
 * from surface y 180 and is 4 px wide.
 */
export const MENU_BAR_LAYOUT: readonly { readonly dx: number; readonly color: number }[] = [
  { dx: 74, color: 0x1e }, // values[0] — Intelligenz
  { dx: 68, color: 0x43 }, // values[1] — Vorrat
  { dx: 80, color: 0x4b }, // values[2] — Fortpflanzung
];

/** Baseline of the slider bars in surface pixels (`vreg1 = 0xb4 − value`). */
export const MENU_BAR_BASELINE = 0xb4;

// ─── click zones ─────────────────────────────────────────────────────────────────────────────────

/** A click zone: action + rectangle in the click area (PIXELS, inclusive on both sides). */
export interface MenuZone {
  readonly action: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

const z = (action: number, x0: number, x1: number, y0: number, y1: number): MenuZone => ({
  action,
  x0,
  x1,
  y0,
  y1,
});

/** The three zones shared by all game types (in exactly this order, see @0x503e9). */
const COMMON: readonly MenuZone[] = [
  z(13, 248, 279, 48, 79), // EXTRA OPTION
  z(39, 288, 319, 48, 79), // LADEN
  z(38, 0, 31, 48, 79), // START
  z(11, 0, 7, 0, 7), // Ecke oben links
  z(0, 40, 71, 48, 79), // Spielart weiterschalten
];

/** The slider and face zones of slots 1..3 (identical in all free game types). */
const SLOTS_123: readonly MenuZone[] = [
  z(28, 208, 231, 96, 111),
  z(29, 168, 199, 96, 159),
  z(30, 208, 215, 112, 159),
  z(31, 216, 223, 112, 159),
  z(32, 224, 231, 112, 159),
  z(33, 288, 311, 96, 111),
  z(34, 248, 279, 96, 159),
  z(35, 288, 295, 112, 159),
  z(36, 296, 303, 112, 159),
  z(37, 304, 311, 112, 159),
  z(18, 120, 127, 96, 111),
  z(18, 200, 207, 96, 111),
  z(18, 280, 287, 96, 111),
];

/** The map zones of the free game (size, seed, preview). */
const FREE_MAP: readonly MenuZone[] = [
  z(7, 160, 169, 48, 57),
  z(8, 160, 183, 58, 79),
  z(9, 184, 199, 48, 58),
  z(10, 208, 239, 48, 79),
  z(12, 184, 199, 59, 79),
];

/**
 * **The zone table of the loaded save** (`0x50821`, three rows). It replaces the game-type table
 * completely while {@link MainMenuState.loadedGamePending} stands — in the original the bit-6 test
 * @0x4f78a wins BEFORE any `gameType` query.
 *
 * The two buttons sit on the same row as START and LADEN of the ordinary table (y 48..79): A40 left
 * on the START place, A41 right on the LADEN place. The quit corner A11 is unchanged — one can also
 * get out of the state by leaving the program.
 */
export const MENU_ZONES_LOADED: readonly MenuZone[] = [
  z(11, 0, 7, 0, 7), // Ecke oben links (Programm verlassen)
  z(40, 0, 31, 48, 79), // links: weiterspielen
  z(41, 288, 311, 48, 79), // right: back to the menu
];

/**
 * **The six zone tables** (`0x503e9`, `0x50445`, `0x50497`, `0x505cf`, `0x506df`, `0x50821`). They lie
 * back to back in the binary — each ends exactly at the entry of the next; the guard checks that and
 * thereby pins base, row width and row count of all six.
 *
 * The order WITHIN a table is semantics: the router takes the FIRST matching zone (@0x4f874 ff.), and
 * several zones overlap (e.g. A29 encloses A30..A32).
 */
export const MENU_ZONES: ReadonlyMap<number, readonly MenuZone[]> = new Map([
  [GAME_TYPE_LEVEL, [...COMMON, z(1, 48, 71, 96, 111), z(2, 224, 239, 48, 63), z(3, 224, 239, 64, 79), z(4, 152, 215, 68, 75)]],
  [GAME_TYPE_MISSION, [...COMMON, z(1, 48, 71, 96, 111), z(5, 208, 223, 48, 63), z(6, 208, 223, 64, 79)]],
  [
    GAME_TYPE_ONE_PLAYER,
    [
      ...COMMON,
      z(1, 48, 71, 96, 111),
      ...FREE_MAP,
      z(14, 48, 55, 112, 159),
      z(15, 64, 71, 112, 159),
      z(23, 128, 151, 96, 111),
      z(24, 88, 119, 96, 159),
      z(25, 128, 135, 112, 159),
      z(26, 136, 143, 112, 159),
      z(27, 144, 151, 112, 159),
      ...SLOTS_123,
    ],
  ],
  [
    GAME_TYPE_TWO_PLAYERS,
    [
      ...COMMON,
      ...FREE_MAP,
      z(14, 48, 55, 112, 159),
      z(15, 64, 71, 112, 159),
      z(16, 128, 135, 112, 159),
      z(17, 144, 151, 112, 159),
      ...SLOTS_123,
    ],
  ],
  [
    GAME_TYPE_DEMO,
    [
      ...COMMON,
      ...FREE_MAP,
      z(19, 8, 39, 96, 159),
      z(20, 48, 55, 112, 159),
      z(21, 56, 63, 112, 159),
      z(22, 64, 71, 112, 159),
      z(23, 128, 151, 96, 111),
      z(24, 88, 119, 96, 159),
      z(25, 128, 135, 112, 159),
      z(26, 136, 143, 112, 159),
      z(27, 144, 151, 112, 159),
      ...SLOTS_123,
    ],
  ],
]);

/**
 * **Table choice** (@0x4f77f). A function because it is one in the original: first the bit-6 test
 * (`bt $0x6` @0x4f78a), and only if that fails does `gameType` decide. The order is semantics — a
 * loaded save hides the game-type zones completely.
 */
export function menuZonesFor(state: MainMenuState): readonly MenuZone[] {
  if (state.loadedGamePending) return MENU_ZONES_LOADED;
  return MENU_ZONES.get(state.gameType) ?? MENU_ZONES.get(GAME_TYPE_DEMO)!;
}

/**
 * **Resolve a click.** `(sx, sy)` are surface coordinates of the 352 × 240 surface. Returns the action
 * number or `null`.
 *
 * The gate computes in two steps (`y −= 8`, later `y −= 0x10`); together that is the origin (16, 24)
 * — and the test `y < 0xc0` BEFORE the second subtraction is redundant against `y < 0xa8`, but it
 * stands in the original and is therefore reproduced.
 */
export function hitTestMainMenu(state: MainMenuState, sx: number, sy: number): number | null {
  const x = sx - MENU_ORIGIN.x;
  const y0 = sy - 8;
  if (x < 0 || y0 < 0 || x >= 0x140 || y0 >= 0xc0) return null;
  const y = y0 - 0x10;
  if (y < 0 || y >= 0xa8) return null;
  for (const zone of menuZonesFor(state)) {
    if (x >= zone.x0 && x <= zone.x1 && y >= zone.y0 && y <= zone.y1) return zone.action;
  }
  return null;
}

// ─── the map code ────────────────────────────────────────────────────────────────────────────────

/** Length of the map code in characters (`gs+0x23e = 0x10` @0x50fb1). */
export const MAP_SEED_CODE_LENGTH = 16;

/**
 * **The map code as the original DISPLAYS it** (@0x4ef50, four calls of the digit helper @0x4eff8).
 * Four groups of four digits, each digit three bits, characters `'1'..'8'`.
 *
 * **The display is defective, and that is reproduced here deliberately.** It loads the seed with
 * 16/32-bit accesses (i.e. little-endian), while {@link parseMapSeedCode} stores it byte-wise and
 * BIG-ENDIAN. Per group the two bytes involved are therefore swapped:
 *
 * ```
 * should:  b0 ++ b1_hi   b1_lo ++ b2   b3 ++ b4_hi   b4_lo ++ b5   (48 bits, lossless)
 * is:      b1 ++ b0_hi   b2_lo ++ b1   b4 ++ b3_hi   b5_lo ++ b4
 * ```
 *
 * Consequence: of 48 bits only 32 appear — `b1` and `b4` twice instead. **A displayed code therefore
 * does not lead back to the same map**, although the manual (pp. 111–112) promises exactly that.
 *
 * Verified against two original captures: 32 of 32 digits exact.
 */
export function formatMapSeedCode(seed: readonly [number, number, number]): string {
  // Deliberately only one line: the renderer draws the four groups via `menuSeedGroups` anyway, and
  // two implementations of the same formula drift apart eventually.
  return menuSeedGroups(seed).join('');
}

/**
 * **The map code as the original READS it** (@0x4f5bb). Two rounds of eight characters each fill a
 * 24-bit accumulator from bit 23 downwards (`bts` @0x4f604/@0x4f623/@0x4f642); each accumulator is
 * stored BIG-ENDIAN into three bytes (@0x4f672 ff. respectively @0x4f6a1 ff.).
 *
 * Unlike {@link formatMapSeedCode} this direction is LOSSLESS — all 48 bits are set. The defect sits
 * in the display alone.
 *
 * Returns `null` when the length is wrong or a character lies outside `'1'..'8'` (@0x4f5e3 `jb` and
 * @0x4f5ed `jae` both go to the error exit @0x4f6e0).
 */
export function parseMapSeedCode(code: string): [number, number, number] | null {
  if (code.length !== MAP_SEED_CODE_LENGTH) return null;
  const bytes: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    let acc = 0;
    for (let i = 0; i < 8; i++) {
      const d = code.charCodeAt(pass * 8 + i) - 0x31;
      if (d < 0 || d >= 8) return null;
      acc = (acc << 3) | d;
    }
    bytes.push((acc >> 16) & 0xff, (acc >> 8) & 0xff, acc & 0xff);
  }
  return [
    bytes[0]! | (bytes[1]! << 8),
    bytes[2]! | (bytes[3]! << 8),
    bytes[4]! | (bytes[5]! << 8),
  ];
}

/**
 * **The inverse of {@link parseMapSeedCode}** — which 16 digits have to be typed for the original to
 * get exactly this seed? **No original counterpart**: the original never goes this way, for output it
 * has only {@link formatMapSeedCode} — and that is defective (32 of 48 bits).
 *
 * The reason it exists here anyway: it is the ONLY way to hand a seed back to the original. Whoever
 * wants to reproduce a map cannot copy the displayed code — it leads to a DIFFERENT map because of
 * the display defect. This digit sequence does lead back, because the input is lossless.
 *
 * The decomposition is the input form read backwards: three bytes big-endian per round into a 24-bit
 * word, from that eight 3-bit digits from the top.
 */
export function mapSeedInputCode(seed: readonly [number, number, number]): string {
  const bytes = [seed[0]! & 0xff, seed[0]! >> 8, seed[1]! & 0xff, seed[1]! >> 8, seed[2]! & 0xff, seed[2]! >> 8];
  let out = '';
  for (let pass = 0; pass < 2; pass++) {
    const acc = (bytes[pass * 3]! << 16) | (bytes[pass * 3 + 1]! << 8) | bytes[pass * 3 + 2]!;
    for (let i = 7; i >= 0; i--) out += String.fromCharCode(0x31 + ((acc >> (i * 3)) & 7));
  }
  return out;
}

// ─── the opponents from the seed ─────────────────────────────────────────────────────────────────

/**
 * **Roll the four opponents (and the two human defaults) from the map seed** — the tail of A12
 * (@0x50acb to @0x50c76). The manual (p. 112) promises it: all data of the game world AND of the
 * opponents depend on the number combination and the world size.
 *
 * **Why this is easy to miss:** the seed copy before it ends on `xorw $0xc3c3,0x216(%ebx)` — and its
 * immediate bytes are `c3 c3`. In a misaligned disassembler window those look like two `ret`, and
 * then this block seems to be a routine of its own without callers. In fact A12 falls through here.
 *
 * Twenty draws of the same random that also generates the map (`deriveMapSeed` applies the same XOR
 * mask). The scaling is the original form `(random · n) >> 16`:
 *
 * | Field | Draw | Formula | Range |
 * |---|---|---|---|
 * | face | 1 | `((r · 10) >> 16) + 1` (@0x50b03 `addb $0x1`) | 1..10 |
 * | intelligence · supply · reproduction | 2..4 | `(r · 0x29) >> 16` | 0..40 |
 *
 * That confirms from a second, independent source what the click body @0x50931 says:
 * {@link MENU_TRAIT_MAX} is 40, and the face cycle runs 1..10.
 *
 * The slots run BACKWARDS (counter 3 → 0, `subw $0x1` + `jae` @0x50ba9), then two rounds for the
 * human players (@0x50bb3, counter 1).
 */
export function generateMenuOpponents(seed: readonly [number, number, number]): {
  face: [number, number, number, number];
  intelligence: [number, number, number, number];
  supply: [number, number, number, number];
  reproduction: [number, number, number, number];
  humanSupply: [number, number];
  humanReproduction: [number, number];
} {
  const rng = new Rng(deriveMapSeed(seed));
  const scaled = (n: number): number => ((rng.next() * n) >>> 16) & 0xff;
  const face: [number, number, number, number] = [0, 0, 0, 0];
  const intelligence: [number, number, number, number] = [0, 0, 0, 0];
  const supply: [number, number, number, number] = [0, 0, 0, 0];
  const reproduction: [number, number, number, number] = [0, 0, 0, 0];
  for (let slot = 3; slot >= 0; slot--) {
    face[slot] = (scaled(10) + 1) & 0xff;
    intelligence[slot] = scaled(MENU_TRAIT_MAX + 1);
    supply[slot] = scaled(MENU_TRAIT_MAX + 1);
    reproduction[slot] = scaled(MENU_TRAIT_MAX + 1);
  }
  const humanSupply: [number, number] = [0, 0];
  const humanReproduction: [number, number] = [0, 0];
  for (let slot = 1; slot >= 0; slot--) {
    humanSupply[slot] = scaled(MENU_TRAIT_MAX + 1);
    humanReproduction[slot] = scaled(MENU_TRAIT_MAX + 1);
  }
  // Tail @0x50c2f — the NUMBER OF PLAYERS is rolled along by setting slots to face 0 (== empty). The
  // branching is asymmetric and easy to miss: if the first test hits, the code FALLS THROUGH to the
  // second write, so BOTH slots go out.
  //   (r & 7) == 0  ⇒ slot 2 AND slot 3 empty   (two players)
  //   else (r & 3) == 0 ⇒ only slot 3 empty     (three players)
  if ((rng.next() & 7) === 0) {
    face[2] = 0;
    face[3] = 0;
  } else if ((rng.next() & 3) === 0) {
    face[3] = 0;
  }
  return { face, intelligence, supply, reproduction, humanSupply, humanReproduction };
}

// ─── actions ─────────────────────────────────────────────────────────────────────────────────────

/** What a click triggered, as far as it does not merely change the state. */
export type MainMenuEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'start' }
  | { readonly kind: 'load' }
  | { readonly kind: 'options' }
  | { readonly kind: 'quit' }
  /** A12 — request the map preview (screen `0x13` of the second viewport). */
  | { readonly kind: 'preview' }
  /**
   * A40 — **enter the loaded save**. In the original that is not an action of its own but a wish to
   * the frame loop: `bts $0x3` on `gs+0x1c9` (@0x4fc9f). Its dispatcher @0xbd61 then switches the
   * panel on (`gs+0x1c8` bit 3), the menu rebuild off (bit 4) and jumps to `0x55ec`.
   */
  | { readonly kind: 'resume' }
  | { readonly kind: 'unhandled'; readonly action: number };

/**
 * **The three clocks A40 sets** (@0x4fc72/@0x4fc80/@0x4fc8e) — in exactly this order `gs+0x186`,
 * `gs+0x17e`, `gs+0x182`.
 *
 * They are NOT menu state but game state, and the port holds none of them. They stand here as
 * constants regardless, because they are the whole content of the A40 body.
 *
 * The proof that they are the same three a NEW game sets is a byte comparison — the bit-1 branch of
 * the frame loop writes the same values to the same three places (@0xbc13/@0xbc21/@0xbc2f). A40 does
 * it inline, because its own frame-loop branch (bit 3, @0xbd61) does NOT set them.
 */
export const MENU_RESUME_CLOCKS = {
  /** `gs+0x186` — 6000 ticks (60 s). Gate of the confirmation button "leave the game". */
  quitGrace: 0x1770,
  /** `gs+0x17e` — 180000 ticks (30 min) until message 17. */
  saveReminder30: 0x2bf20,
  /** `gs+0x182` — 360000 ticks (60 min) until message 18. */
  saveReminder60: 0x57e40,
} as const;

export interface MainMenuResult {
  readonly state: MainMenuState;
  readonly effect: MainMenuEffect;
  /**
   * The sound the ACTION ITSELF enqueues.
   *
   * The original has two stages here, and they are independent: the zone walker enqueues `8` on EVERY
   * hit (`mov $0x8` @0x4f8b4, immediately before the jump into the action table), and afterwards the
   * action may enqueue something of its own. Most do not — hence {@link UI_SOUND_PANEL_BUTTON} stands
   * here for "the action is silent".
   *
   * Playing both is right and not doubled: the priority queue inserts SORTED AND DEDUPLICATED
   * (`insertSound` in `core/sound.ts`) — `8` then `2` becomes `[2, 8]`, `8` then `8` stays `[8]`.
   */
  readonly sound: number;
  /**
   * A THIRD sound, enqueued by the shared helper `0x50376`: {@link MENU_PREVIEW_DISCARD_SOUND} when a
   * standing map preview is discarded. It does not replace {@link sound} but stands beside it — the
   * helper runs AFTER the action body, and the queue takes both.
   */
  readonly extraSound?: number;
}

/**
 * **The range of a slider is 0..40** — not 0..99. The shared body @0x50931 clamps the click height to
 * `0..0x28` and mirrors it (`neg ; add $0x28`). That `0x28 == 40` is also the intelligence literal of
 * the human is no coincidence: his bar always stands at the limit.
 */
export const MENU_TRAIT_MAX = 0x28;

const clampTrait = (v: number): number => (v < 0 ? 0 : v > MENU_TRAIT_MAX ? MENU_TRAIT_MAX : v);

const withAt = <T,>(arr: readonly T[], i: number, v: T): T[] => {
  const out = [...arr];
  out[i] = v;
  return out;
};

/**
 * **Apply an action.** The slider actions (14..17, 20..22, 25..27, 30..32, 35..37) share a common
 * body @0x50931 in the original, which turns the CLICK HEIGHT into a new value; this port takes the
 * value directly (`value`) instead, because the height is already known at the hit test.
 *
 * **All 42 actions of the original are handled here** — `unhandled` from now on means "this number
 * does not exist", not "not read yet".
 */
export function applyMainMenuAction(
  s: MainMenuState,
  action: number,
  value?: number,
  rng?: () => number,
): MainMenuResult {
  const keep = (state: MainMenuState): MainMenuResult =>
    ({ state, effect: { kind: 'none' }, sound: UI_SOUND_PANEL_BUTTON });
  /**
   * **A reject branch at the limit** — the state stays, and the action enqueues `4` IN ADDITION to
   * the walker sound.
   *
   * Exactly FOUR actions have it: A2/A3 (level) @0x50d84/@0x50dbe and A5/A6 (mission)
   * @0x50df8/@0x50e32. The two neighbours A7/A8 (map size, @0x50e38/@0x50e62) look the same but jump
   * PAST the sound onto the shared tail — they are silent at the limit. That is the original's
   * asymmetry, not sloppiness of this port; tidying it up sounds wrong in two places.
   */
  const reject = (): MainMenuResult => ({ state: s, effect: { kind: 'none' }, sound: UI_SOUND_REJECT });
  /**
   * **The shared helper `0x50376`** — it hangs on the tail of six call sites and does exactly two
   * things: if bit 1 stands, it enqueues {@link MENU_PREVIEW_DISCARD_SOUND} (@0x5038e) and clears the
   * bit (@0x503a7); then it FALLS THROUGH to `0x503b3` and sets slot 2 to
   * {@link MENU_PANEL_ICON_IDLE} — that part is UNCONDITIONAL.
   *
   * The six places are A9 (@0x50eed), A10 (@0x50ffe), A18 (@0x4fc47), the shared slider body
   * (@0x50978, 16 actions), the face switch (@0x509d0) and the face cycle (@0x50a3b). All six change
   * an input of the generation.
   */
  const discard = (state: MainMenuState): MainMenuResult => ({
    state: { ...state, previewGenerated: false, panelIcon2: MENU_PANEL_ICON_IDLE },
    effect: { kind: 'none' },
    sound: UI_SOUND_PANEL_BUTTON,
    ...(s.previewGenerated ? { extraSound: MENU_PREVIEW_DISCARD_SOUND } : {}),
  });

  switch (action) {
    // A0 @0x50c8f — cycle the game type, in the original with a wrap at 5. The port skips the 3, see
    // {@link SELECTABLE_GAME_TYPES}; an unknown game type lands on the first.
    case 0: {
      const i = SELECTABLE_GAME_TYPES.indexOf(s.gameType);
      const next = SELECTABLE_GAME_TYPES[(i + 1) % SELECTABLE_GAME_TYPES.length] ?? GAME_TYPE_LEVEL;
      // Two icon writers in the body, and they are not symmetric: on the WRAP to the level game type
      // @0x50ca6 resets slot 2 (`t == 5` ⇒ `call 0x503b3`), and when the new game type is **2** and a
      // preview stands, @0x50cfb sets it to "pressed". Between 3 and 4 nobody writes at all.
      // OFFEN @0x50cb5 — after the wrap the original jumps to game type **2** when
      // `gs+0x30c & 0xf < 3`. Our wrap goes over {@link SELECTABLE_GAME_TYPES}, and `maxMapSize` is
      // 8 — the branch cannot fire here.
      const wrapped = i + 1 >= SELECTABLE_GAME_TYPES.length;
      const panelIcon2 = wrapped
        ? MENU_PANEL_ICON_IDLE
        : next === GAME_TYPE_ONE_PLAYER && s.previewGenerated
          ? MENU_PANEL_ICON_PREVIEW
          : s.panelIcon2;
      return keep({ ...s, gameType: next, panelIcon2 });
    }
    // A1 @0x50d12 — split-screen wish (`btc $0x0` on gs+0x37e). Ineffective, see
    // {@link SELECTABLE_GAME_TYPES}: it is the second way into two-human mode.
    case 1:
      return keep(s);
    // A2/A3 @0x50d3b/@0x50d8a — level, against the unlocked bound respectively 1. The limit is an
    // EQUALITY test in the original (`cmp %ax,(%edi) ; je` @0x50d52 respectively `cmpw $0x1`
    // @0x50d8d), not a clamp: it rejects and changes nothing — see {@link reject}.
    case 2:
      return s.level === s.unlockedLevel ? reject() : keep({ ...s, level: s.level + 1 });
    case 3:
      return s.level === 1 ? reject() : keep({ ...s, level: s.level - 1 });
    // A5/A6 @0x50dc4/@0x50dfe — mission 1..6, likewise (`cmpw $0x6` / `cmpw $0x1`).
    case 5:
      return s.mission === 6 ? reject() : keep({ ...s, mission: s.mission + 1 });
    case 6:
      return s.mission === 1 ? reject() : keep({ ...s, mission: s.mission - 1 });
    // A7/A8 @0x50e38/@0x50e62 — map size. An equality test here as well, but WITHOUT a sound at the
    // limit (see {@link reject}); hence the clamp stays as the shorter form.
    case 7:
      return keep({ ...s, mapSizeChoice: Math.max(s.mapSizeChoice - 1, 1) });
    case 8:
      return keep({ ...s, mapSizeChoice: Math.min(s.mapSizeChoice + 1, s.maxMapSize) });
    // A9 @0x50e9d — **roll the map**: three draws of the game random into gs+0x364/0x366/0x368. The
    // called routine @0x4e1e9 is a copy of `rng_next` (it reads the same gs+0x212/0x214/0x216 ==
    // `random[0..2]`), hence the same stream as in the game. Without `rng` the seed stays — the
    // caller has to bring it.
    case 9: {
      if (rng === undefined) return keep(s);
      const a = rng() & 0xffff;
      const b = rng() & 0xffff;
      const c = rng() & 0xffff;
      // A new seed invalidates the standing preview — tail @0x50eed.
      return discard({ ...s, seed: [a, b, c] });
    }
    // A10 @0x50f64 — **type a map code**: write position to 0, buffer to 16 spaces (four
    // `mov $0x20202020` @0x50f86..@0x50fa6), length 16 (@0x50fb1), `gs+0x1ca` bit 0 (active) AND
    // bit 2 (digits only, @0x50fca/@0x50fe1). Exactly that bit 2 explains why the code is octal.
    case 10:
      // The tail @0x50ffe is the shared helper, NOT the game start.
      return discard({
        ...s,
        textInput: { field: 'seed', text: ' '.repeat(MAP_SEED_CODE_LENGTH), cursor: 0, digitsOnly: true },
      });
    // A4 @0x50ef3 — **type a password**: write position to 0 (@0x50ef9), buffer to `gs+0x35a`
    // (@0x50f03 — the header field itself, see {@link MenuTextInput}), eight spaces, length 8
    // (@0x50f2d), `gs+0x1ca` bit 0 (@0x50f46). **Bit 2 is NOT set here** — unlike with the map code
    // all characters are allowed.
    case 4:
      return keep({
        ...s,
        password: PASSWORD_BLANK,
        textInput: { field: 'password', text: PASSWORD_BLANK, cursor: 0, digitsOnly: false },
      });
    // A12 @0x50a41 — **generate map and opponents from the seed**: sound 2, redraw stage 4, then
    // @0x50340 (sets slot 2 of the control bar to its PRESSED icon `0x13`; it is NOT a screen number)
    // and @0x50a6b (seed into `gs+0x212/0x214/0x216`, ored with the same masks as
    // `apply_game_setup`) …
    //
    // …and then FALLS THROUGH to @0x50acb, which rolls the four opponents and the two human defaults
    // from the same seed (see {@link generateMenuOpponents}).
    case 12:
      // @0x50a60 sets slot 2 to "pressed", and the tail @0x50c6a sets bit 1 — the preview stands.
      // The two belong together: the bit remembers it, the icon shows it.
      return {
        state: {
          ...s,
          ...generateMenuOpponents(s.seed),
          previewGenerated: true,
          panelIcon2: MENU_PANEL_ICON_PREVIEW,
        },
        effect: { kind: 'preview' },
        sound: 2,
      };
    // A11 @0x50c77 — the small corner top left sets `gs+0x1c9` bit 0, and the frame loop reads
    // exactly that as **leave the program** (@0xbbdb).
    case 11:
      return { state: s, effect: { kind: 'quit' }, sound: 8 };
    // A18 @0x4faaf — transfer the values of the HIGHEST OCCUPIED slot to the left. The routine takes
    // no parameter: all three buttons between the columns do the same.
    //
    // The source is a FOUR-STAGE cascade, and its third branch is easy to miss:
    //   @0x4fab2  face slot 3 ≠ 0  ⇒ slot 3
    //   @0x4fae9  face slot 2 ≠ 0  ⇒ slot 2
    //   @0x4fb1d  `cmpw $0x3,gs+0x352` ⇒ **the SECOND HUMAN** (`gs+0x37b`/`0x37d`), intelligence as
    //             the literal `mov $0x28` @0x4fb32 — it wins BEFORE slot 1, because slot 1 is not an
    //             AI slot at all in game type "2 SPIELER"
    //   @0x4fb50  face slot 1 ≠ 0  ⇒ slot 1
    //   otherwise `ret` @0x4fb7b — nothing occupied, nothing to do
    case 18: {
      const pick = (): { int: number; sup: number; rep: number } | null => {
        for (const i of [3, 2] as const)
          if ((s.face[i] ?? 0) !== 0)
            return { int: s.intelligence[i]!, sup: s.supply[i]!, rep: s.reproduction[i]! };
        if (s.gameType === GAME_TYPE_TWO_PLAYERS)
          return { int: HUMAN_INTELLIGENCE, sup: s.humanSupply[1]!, rep: s.humanReproduction[1]! };
        if ((s.face[1] ?? 0) !== 0)
          return { int: s.intelligence[1]!, sup: s.supply[1]!, rep: s.reproduction[1]! };
        return null;
      };
      const src = pick();
      if (src === null) return keep(s);
      // The call @0x4fc47 goes to `0x50376`, and that is NOT a tail of A18 but the helper shared by
      // six actions — see {@link discard}. A18 overwrites the four player columns, i.e. an input of
      // the generation.
      return discard({
        ...s,
        intelligence: [src.int, src.int, src.int, src.int],
        supply: [src.sup, src.sup, src.sup, src.sup],
        reproduction: [src.rep, src.rep, src.rep, src.rep],
        humanSupply: [src.sup, src.sup],
        humanReproduction: [src.rep, src.rep],
      });
    }
    // A13 @0x4fceb — "EXTRA OPTION": `vp[1]` btr 1 (popup modality), `vp[0x70] = 0x25`. It is SILENT
    // — 12 instructions in `0x4fceb..0x4fd0d`, no `call 0x3688a` —, so only the zone walker sounds.
    // The sound 2 @0x4fcbd lies BEFORE the entry and belongs to A41, not to A13: the action bodies do
    // not lie in action order in the binary — the mapping comes from the jump table @0x4f8df
    // (8-byte slots, `e9 rel32`), not from the neighbourhood.
    case 13:
      return { state: s, effect: { kind: 'options' }, sound: UI_SOUND_PANEL_BUTTON };
    // A38 @0x4fd53 and A39 @0x4fd0e — START and LADEN, both with sound 2 ("carried out", @0x4fd5c
    // respectively @0x4fd17). A39's entry is the SOUND HEAD: it falls through to @0x4fd1c, where
    // `vp[0x70] = 0x17` and `gs[0x1c8]` btr 2 ("load instead of save") stand. @0x4fd1c itself is not
    // a table entry.
    case 38:
      return { state: s, effect: { kind: 'start' }, sound: 2 };
    case 39:
      return { state: s, effect: { kind: 'load' }, sound: 2 };
    // A40 @0x4fc4d — **resume play**: clear bit 6 (@0x4fc5e), set the three clocks
    // (@0x4fc72/@0x4fc80/@0x4fc8e, see {@link MENU_RESUME_CLOCKS}) and ask the frame loop to enter
    // the game (`bts $0x3` on `gs+0x1c9` @0x4fc9f). This is the button that really enters the loaded
    // save — until then it merely lies there (see {@link MainMenuState.loadedGamePending}).
    //
    // **The port sets the three clocks elsewhere**, and that is not a leftover: `loadState`
    // (`engine/state.ts`) sets `saveClocks` to exactly these three values while building the state.
    // Observably that is the same, because no simulation runs between loading and A40 — and it could
    // not be done here, because A40 has no game state in hand in this port.
    case 40:
      return { state: { ...s, loadedGamePending: false }, effect: { kind: 'resume' }, sound: 2 };
    // A41 @0x4fcb4 — **back to the menu**: clear bit 6 (@0x4fcc5) and request redraw stage 1
    // (`vp[0x1b8] = 1` @0x4fce0). Nothing else stands in the body — in particular the loaded save is
    // NOT discarded; it stays loaded and unused.
    case 41:
      return { state: { ...s, loadedGamePending: false }, effect: { kind: 'none' }, sound: 2 };
    default:
      break;
  }

  // Faces: two DIFFERENT buttons per slot — on/off (@0x509a6) and cycle (@0x50a0c).
  const cycleSlot = FACE_CYCLE_ACTIONS.get(action);
  if (cycleSlot !== undefined) {
    const next = cycleFace(s.face[cycleSlot] ?? 0);
    // Tail @0x50a3b — a different face is a different opponent.
    return discard({
      ...s,
      face: withAt(s.face, cycleSlot, next) as unknown as MainMenuState['face'],
    });
  }
  const toggleSlot = FACE_TOGGLE_ACTIONS.get(action);
  if (toggleSlot !== undefined) {
    const next = toggleFace(s.face[toggleSlot] ?? 0);
    return discard({ // Schwanz @0x509d0
      ...s,
      face: withAt(s.face, toggleSlot, next) as unknown as MainMenuState['face'],
    });
  }

  // Sliders. Without `value` there is nothing to do — the caller knows the click height.
  const trait = TRAIT_ACTIONS.get(action);
  if (trait) {
    // Without `value` there is nothing to do. The helper deliberately stays OFF here: in the original
    // it lies behind the write (@0x50978), and without a click height the body never gets there.
    if (value === undefined) return keep(s);
    const v = clampTrait(value);
    const [field, slot] = trait;
    // All 16 sliders run through the same body in the original, and its tail @0x50978 is the helper —
    // a moved slider discards the preview.
    if (field === 'humanSupply')
      return discard({ ...s, humanSupply: withAt(s.humanSupply, slot, v) as unknown as MainMenuState['humanSupply'] });
    if (field === 'humanReproduction')
      return discard({
        ...s,
        humanReproduction: withAt(s.humanReproduction, slot, v) as unknown as MainMenuState['humanReproduction'],
      });
    return discard({ ...s, [field]: withAt(s[field], slot, v) } as MainMenuState);
  }

  return { state: s, effect: { kind: 'unhandled', action }, sound: 8 };
}

// ─── the code input ──────────────────────────────────────────────────────────────────────────────

// The five key identifiers belong to the shared input primitive (`core/text-input.ts`) — in the
// original the keyboard evaluation is ONE routine and the main menu is only one of its two callers.
// They stand here as aliases because the menu interaction knows them under these names.
export const MENU_KEY_CURSOR_LEFT = TEXT_KEY_CURSOR_LEFT;
export const MENU_KEY_CURSOR_RIGHT = TEXT_KEY_CURSOR_RIGHT;
export const MENU_KEY_BACKSPACE = TEXT_KEY_BACKSPACE;
export const MENU_KEY_DELETE = TEXT_KEY_DELETE;
export const MENU_KEY_COMMIT = TEXT_KEY_COMMIT;

export interface MainMenuKeyResult {
  readonly state: MainMenuState;
  /** Sound the original enqueues: **2** code accepted, **4** rejected, **0** none. */
  readonly sound: number;
}

/**
 * **Feed a character into the input** — `input_buffer_putchar` @0xd073, together with the two
 * completion branches of the frame pass (@0x4f39a password, @0x4f537 map code), which evaluate the
 * buffer once the write position has gone negative.
 *
 * The routine is the SAME for both fields in the original; they are distinguished only when
 * evaluating, via the redraw stage (see {@link MenuInputField}).
 *
 * Not obvious, three times: **at the end of the buffer the input accepts nothing more** and does not
 * advance either (`cmp %ax,0x4(%edi) ; je` @0xd0c2). **On an invalid code the old seed stays**: the
 * parser stores its bytes only after all 16 characters (@0x4f672), the error exit @0x4f6e0 lies
 * before that. And a WRONG password leaves not the typo but the eight bytes `-FEHLER-`.
 */
export function applyMainMenuKey(s: MainMenuState, key: number): MainMenuKeyResult {
  const entry = s.textInput;
  if (entry === null || key === 0) return { state: s, sound: 0 }; // @0xd075 `or %al,%al ; jne`
  const put = (text: string, cursor: number): MainMenuKeyResult => ({
    // With the password the buffer IS the header field itself — every key press writes it along.
    state: {
      ...s,
      ...(entry.field === 'password' ? { password: text } : {}),
      textInput: { ...entry, text, cursor },
    },
    sound: 0,
  });

  if (key === MENU_KEY_COMMIT) {
    // @0xd25e ff. — clear bit 0 and bit 2, write position to 0xffff. The responsible frame branch
    // sees the negative position and evaluates: success ⇒ sound 2, error ⇒ sound 4.
    //
    // The two early returns of the original (`je 0x4f534` @0x4f3c0 "nothing changed" and
    // `jns 0x4f534` @0x4f3f8 "write position not negative yet") have no counterpart as code here: the
    // port evaluates only when the commit key arrives — exactly the situation in which both tests
    // pass. They are modelled, not skipped.
    if (entry.field === 'password') return commitCampaignPassword(s, entry.text);
    const seed = parseMapSeedCode(entry.text);
    if (seed === null) return { state: { ...s, textInput: null }, sound: 4 };
    return { state: { ...s, textInput: null, seed }, sound: 2 };
  }
  // Everything else is the shared buffer handling — the same routine the disk menu uses.
  const next = editTextBuffer(entry, key, entry.digitsOnly);
  if (next === null) return { state: s, sound: 0 };
  return put(next.text, next.cursor);
}

/** Empty password buffer — eight spaces (`mov $0x20202020` ×2, @0x50f18/@0x50f22). */
export const PASSWORD_BLANK = '        ';

/**
 * What stands in the buffer after a WRONG password: eight individually written bytes
 * `2d 46 45 48 4c 45 52 2d` (@0x4f4dc..@0x4f52e). The original therefore does not show the typo but
 * an error message in the place of the input.
 */
export const PASSWORD_REJECT = '-FEHLER-';

// The first setup record with a password (`add $0xd8` == 6 · 0x24, @0x4f41e) is a property of the
// setup table and lives with it; re-exported because the check loop below is the other reader.
export { FIRST_CAMPAIGN_RECORD } from './player-setup.js';

/**
 * Number of records checked (`mov $0x1d,%eax` @0x4f430, then `subw $0x1 ; jae` ⇒ 30 rounds). Agrees
 * with `mission-end-popup.LAST_CAMPAIGN_LEVEL` (`cmpw $0x1e` @0x384c4) — two different instructions
 * in two different routines naming the same campaign length.
 */
export const CAMPAIGN_LEVEL_COUNT = 30;

/**
 * **Assign a typed password to a level** (loop @0x4f437..@0x4f4c8). The original walks the records
 * from the sixth on, decodes eight bytes each via {@link PASSWORD_CHARS} and compares character by
 * character (`cmp %al,0x8(%edi) ; jne` @0x4f479); the first hit wins.
 *
 * The level falls out of the REMAINING COUNT: `ax = -counter + 0x1e` (@0x4f488/@0x4f48e).
 */
export function matchCampaignPassword(typed: string): number | null {
  for (let k = 0; k < CAMPAIGN_LEVEL_COUNT; k++) {
    const bytes = SETUP_PASSWORD_BYTES[FIRST_CAMPAIGN_RECORD + k];
    if (bytes !== undefined && decodeSetupPassword(bytes) === typed) return k + 1;
  }
  return null;
}

/**
 * **Completion of the password input.** Not obvious: the success branch writes the found level into
 * BOTH fields — `gs+0x358` (the unlocked bound, @0x4f498) and `gs+0x356` (the chosen level,
 * @0x4f4a5). A password therefore SETS the bound, it does not merely raise it: typing the password of
 * level 3 while level 20 is unlocked leaves you at 3.
 */
function commitCampaignPassword(s: MainMenuState, typed: string): MainMenuKeyResult {
  const level = matchCampaignPassword(typed);
  if (level === null)
    return { state: { ...s, textInput: null, password: PASSWORD_REJECT }, sound: 4 };
  return { state: { ...s, textInput: null, password: typed, level, unlockedLevel: level }, sound: 2 };
}

/**
 * **Cycle the face** (shared body @0x50a0c): an UNOCCUPIED slot stays unoccupied (`or %al,%al ; je`
 * @0x50a11 — the routine then does nothing at all), otherwise `face + 1` with wrap `11 ⇒ 1`
 * (`cmpb $0xb` @0x50a1e). There are therefore TEN faces, and the 0 is not a state of the cycle but
 * "slot off".
 */
const cycleFace = (face: number): number => (face === 0 ? 0 : face + 1 === 11 ? 1 : face + 1);

/**
 * **Slot on/off** (shared body @0x509a6): a plain toggle — occupied ⇒ 0, empty ⇒ 1. This is NOT the
 * same button as the face change; conflating the two makes it impossible to switch a slot off.
 */
const toggleFace = (face: number): number => (face === 0 ? 1 : 0);

/** Action → slot of the face cycle (A19 is the demo special case for slot 0). */
const FACE_CYCLE_ACTIONS: ReadonlyMap<number, number> = new Map([
  [19, 0],
  [24, 1],
  [29, 2],
  [34, 3],
]);

/** Action → slot of the on/off switch. */
const FACE_TOGGLE_ACTIONS: ReadonlyMap<number, number> = new Map([
  [23, 1],
  [28, 2],
  [33, 3],
]);

type TraitField = 'intelligence' | 'supply' | 'reproduction';

/**
 * Action → which field it adjusts. The mapping is taken FROM THE HANDLER HEADS
 * (`add $0x36e/$0x372/$0x376 + slot,%esi`), not inferred from the arrangement in the picture.
 */
const TRAIT_ACTIONS: ReadonlyMap<number, readonly [TraitField | 'humanSupply' | 'humanReproduction', number]> =
  new Map([
    [14, ['humanSupply', 0]],
    [15, ['humanReproduction', 0]],
    [16, ['humanSupply', 1]],
    [17, ['humanReproduction', 1]],
    [20, ['supply', 0]],
    [21, ['intelligence', 0]],
    [22, ['reproduction', 0]],
    [25, ['supply', 1]],
    [26, ['intelligence', 1]],
    [27, ['reproduction', 1]],
    [30, ['supply', 2]],
    [31, ['intelligence', 2]],
    [32, ['reproduction', 2]],
    [35, ['supply', 3]],
    [36, ['intelligence', 3]],
    [37, ['reproduction', 3]],
  ]);

/**
 * **Click height → slider value**, verbatim from the shared body @0x50931:
 *
 * ```
 * y -= 0x74 ; if (borrow) y = 0        // below 116 ⇒ 0
 * if (y >= 0x29) y = 0x28              // above 156 ⇒ 40
 * y = -y ; y += 0x28                   // mirror: up = large
 * ```
 *
 * `surfaceY` is the surface coordinate; the computation runs on the CLICK coordinate, i.e.
 * `surfaceY − 24`. The usable range is therefore surface y 140..180.
 */
export function traitValueFromClick(surfaceY: number): number {
  let y = surfaceY - MENU_ORIGIN.y - 0x74;
  if (y < 0) y = 0;
  if (y >= 0x29) y = 0x28;
  return MENU_TRAIT_MAX - y;
}

// ─── drawing ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A drawing command in surface pixels.
 *
 * `text` carries a flag `boxed`: if set, an 8 × 8 cell with palette index 0 is filled BEFORE EVERY
 * glyph. In the original that is not a text attribute but `gs+0x1ca` bit 4 — `draw_menu_string`
 * @0x37c16 tests it per character (`bt $0x4` @0x37d05) and then calls `fill_rect(x, y, 8, 8, 0)`
 * (@0x37d5c). Exactly three places of the menu set it: the password line (@0x4eb3a), the seed input
 * block (@0x4ec1b) and each of the four seed groups (@0x4f08c) — the black fields are therefore
 * PERMANENT, not only while typing.
 *
 * The port carries this as a flag on the command instead of a state bit, because it needs no bit 3:
 * its counterpart `gs+0x1ca` bit 3 is cleared and set around the same three calls but has NO READER
 * in the whole binary.
 */
export type MenuCommand =
  | {
      readonly kind: 'icon';
      readonly icon: number;
      readonly x: number;
      readonly y: number;
      readonly dim?: boolean;
    }
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly x: number;
      readonly y: number;
      readonly boxed?: boolean;
      readonly dim?: boolean;
    }
  | {
      readonly kind: 'bar';
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly color: number;
      readonly dim?: boolean;
    };

/**
 * **The darkening mask of the original** — `orl $0x80808080` (@0x4f221 ff., four double words per
 * round). It ors the PALETTE INDEX of the target pixel, like the object shadow of the map; the upper
 * half of the palette is the darkened lower half.
 *
 * Why `dim` hangs on the COMMANDS and is not a rectangle operation on the target: the original works
 * on an index framebuffer, our menu surface is RGBA — there the index of a pixel is lost, and a
 * reverse lookup RGB→index is not unique (measured: 7 of the 83 colours of the menu area are
 * ambiguous when darkened, affecting 28910 of 61440 pixels, black among them). A command with `dim`
 * instead draws with `index | 0x80` from the start.
 *
 * That is provably the same image, because (a) `| 0x80` is per pixel and idempotent, (b) no blit of
 * the menu reads the target value (only transparent blits, glyphs and fills — unlike shadow and waves
 * of the map), and (c) not a single command reaches beyond the darkened rectangle: 0 of 1341 over all
 * five game types. Without (c) a clip rectangle would be needed.
 */
export const MENU_DIM_BIT = 0x80;

/** Two digits from a number < 100; a leading zero becomes a space (`FUN_0004f0d9`). */
export function menuTwoDigits(value: number): string {
  let v = value;
  let tens = 0;
  while (v > 9) {
    v -= 10;
    tens++;
  }
  return (tens === 0 ? ' ' : String(tens)) + String(v);
}

/**
 * Four OCTAL digits from `'1'` upwards out of a 12-bit value (`FUN_0004eff8`). The seed therefore
 * appears in the menu as a digit sequence 1..8, not decimal.
 */
export function menuSeedGroup(value12: number): string {
  const d = (n: number) => String.fromCharCode(0x31 + n);
  return d((value12 >> 9) & 7) + d((value12 >> 6) & 7) + d((value12 >> 3) & 7) + d(value12 & 7);
}

/**
 * The four displayed seed groups (`draw_menu_box_frame` @0x4ef7d ff.). The choice of bits is
 * reproduced VERBATIM: it overlaps and leaves bits out — that is how it stands in the original, and
 * the reason is at {@link formatMapSeedCode}.
 */
export function menuSeedGroups(seed: readonly [number, number, number]): string[] {
  const d0 = (seed[0] | (seed[1] << 16)) >>> 0;
  const d1 = (seed[1] | (seed[2] << 16)) >>> 0;
  return [
    menuSeedGroup((seed[0] >>> 4) & 0xfff),
    menuSeedGroup((d0 >>> 8) & 0xfff),
    menuSeedGroup((d1 >>> 12) & 0xfff),
    menuSeedGroup(seed[2] & 0xfff),
  ];
}

/**
 * A typed 16-digit code in the same four groups of four. During the input (A10) the original shows
 * NOT the seed but its input buffer: stage 6 @0x4eb8b reads the 12-byte block @0x51004 in steps of
 * four and draws it into the same four lines.
 */
export function menuSeedGroupsOfCode(code: string): string[] {
  const padded = code.padEnd(MAP_SEED_CODE_LENGTH, ' ').slice(0, MAP_SEED_CODE_LENGTH);
  return [0, 4, 8, 12].map((i) => padded.slice(i, i + 4));
}

/** The game-type heading (`DAT_0004f14e/f158/f162`). */
/**
 * **Three lines into which the original patches digits**, with `-` as the placeholder, as they stand
 * in the binary (@0x4f118, @0x4f144, @0x4f16f). The port fills them via {@link fillMenuDigits} so the
 * FOREIGN-LANGUAGE template is used and not one assembled here: `'GROESSE:-'` is `'MAPSIZE:-'` in
 * English, and the associated first line `'KARTEN-'` is a single space there — the two-line German
 * label becomes one line.
 */
export const MENU_TEXT_MISSION_LEVEL = 'MISSION: --.LEVEL';
export const MENU_TEXT_TUTORIAL_LEVEL = '--. LEVEL';
export const MENU_TEXT_MAPSIZE = 'GROESSE:-';

/** Replaces the `-` placeholders of the template with the digits, in order. */
export function fillMenuDigits(template: string, digits: string): string {
  let k = 0;
  return template.replace(/-/g, (m) => (k < digits.length ? digits[k++]! : m));
}

const GAME_TYPE_LABEL: ReadonlyMap<number, string> = new Map([
  [GAME_TYPE_ONE_PLAYER, '1 SPIELER'],
  [GAME_TYPE_TWO_PLAYERS, '2 SPIELER'],
  [GAME_TYPE_DEMO, 'DEMO'],
]);

/**
 * **The complete command list of stage 1** — background, fixed icons, control strip, game-type texts
 * and the four player columns, in the original's order.
 */
export function mainMenuCommands(
  s: MainMenuState,
  recordHuman?: readonly [number, number],
  recordPlayers?: readonly (readonly [number, number, number, number])[],
): MenuCommand[] {
  const out: MenuCommand[] = [];
  const icon = (i: number, col: number, row: number) =>
    out.push({ kind: 'icon', icon: i, x: menuX(col), y: menuY(row) });
  const text = (label: string, col: number, row: number) =>
    out.push({ kind: 'text', text: t(label), x: menuX(col), y: menuY(row) });
  /**
   * Text with black-filled cells — `gs+0x1ca` bit 4, see {@link MenuCommand}. WITHOUT `t()`: only
   * inputs stand here (password, map code), no labels.
   */
  const boxedText = (value: string, col: number, row: number) =>
    out.push({ kind: 'text', text: value, x: menuX(col), y: menuY(row), boxed: true });

  // 1. Background (row offset of its own, see menuBackgroundY).
  for (const t of menuBackgroundTiles())
    out.push({ kind: 'icon', icon: t.icon, x: menuX(t.col), y: menuBackgroundY(t.row) });

  // 2. Fixed icon table of stage 1.
  for (const t of MENU_STAGE1_ICONS) icon(t.icon, t.col, t.row);

  // 3. Control strip: game-type sign, tile box, texts.
  icon(0x104 + s.gameType, 5, 0x30);
  for (const t of menuBoxTiles()) icon(t.icon, t.col, t.row);

  if (s.gameType === GAME_TYPE_LEVEL) {
    const lv = menuTwoDigits(s.level);
    text(fillMenuDigits(t(MENU_TEXT_MISSION_LEVEL), lv), 10, 0x34);
    text('PASSWORT:', 10, 0x44);
    // The password line is drawn by @0x4ea8f, and that sets bit 4 — eight black cells.
    boxedText(s.password, 0x13, 0x44);
    icon(0xed, 0x1c, 0x30);
    icon(0xf0, 0x1c, 0x40);
  } else if (s.gameType === GAME_TYPE_MISSION) {
    text('TRAININGSSPIEL:', 10, 0x34);
    text(fillMenuDigits(t(MENU_TEXT_TUTORIAL_LEVEL), menuTwoDigits(s.mission)), 0xc, 0x44);
    icon(0xed, 0x1a, 0x30);
    icon(0xf0, 0x1a, 0x40);
  } else {
    text(GAME_TYPE_LABEL.get(s.gameType) ?? 'DEMO', 10, 0x30);
    text('KARTEN-', 10, 0x3e);
    text(
      fillMenuDigits(t(MENU_TEXT_MAPSIZE), String.fromCharCode(0x30 + s.mapSizeChoice)),
      10,
      0x48,
    );
    icon(0x109, 0x14, 0x30);
    // The four seed groups are drawn by `FUN_0004eff8`, and that sets bit 4 (@0x4f08c) — four black
    // cells each. While an input runs (A10), the block shows the BUFFER instead of the seed: the
    // original opener points `gs+0x23a` at the 12-byte block @0x51004, which stage 6 draws.
    const typing = s.textInput?.field === 'seed' ? s.textInput.text : null;
    const groups = typing === null ? menuSeedGroups(s.seed) : menuSeedGroupsOfCode(typing);
    const rows = [0x2e, 0x37, 0x40, 0x49];
    groups.forEach((g, i) => boxedText(g, 0x1a, rows[i]!));
  }

  // 4. **The three take-over arrows** (@0x4e3d2, the first six drawing calls of the content pass).
  //    They stand between the columns and belong to A18 — the three zones lie exactly on them.
  //
  //    Two peculiarities lost when rebuilding: the plate `0xfe` is drawn AGAIN although it already
  //    stands in the stage-1 table (the content pass also runs alone as stage 4 and has to cover the
  //    old arrow) — and the arrow `0x134` is added ONLY in the free game (`cmpw $0x1 ; jbe`
  //    @0x4e3fe). With level and mission there is nothing to take over, because the values come from
  //    the setup record.
  for (const col of MENU_TRANSFER_COLUMNS) icon(0xfe, col, 0x60);
  if (s.gameType > GAME_TYPE_MISSION) for (const col of MENU_TRANSFER_COLUMNS) icon(0x134, col, 0x60);

  // 5. The four player columns.
  const cols = menuColumns(s, recordHuman, recordPlayers);
  cols.forEach((c, slot) => {
    const base = menuColumnBase(slot);
    icon(c.icon, base + 1, 0x60);
    icon(0x11a, base + 6, 0x60);
    // The kind icon: `kind < 5`, and for the FIRST column additionally `kind < 3` (@0x4e5a4).
    if (c.kind < 5 && (c.kind < 3 || slot !== 0)) {
      icon(c.kind === 4 ? 0x11f : 0x100 + c.kind, base + 6, 0x60);
    }
    MENU_BAR_LAYOUT.forEach((bar, i) => {
      const h = c.values[i] ?? 0;
      if (h === 0) return;
      out.push({
        kind: 'bar',
        x: base * 8 + bar.dx,
        y: MENU_BAR_BASELINE - h,
        w: 4,
        h,
        color: bar.color,
      });
    });
  });

  // 6. **The loaded save is waiting** (`bt $0x6` on `gs+0x1c8` @0x4f1d4). The original darkens the
  //    whole menu area here (`orl $0x80808080` over x 16..335 / y 8..199 — the 352 bytes per row
  //    arise as 16 + 20·16 + 16, see {@link MENU_DIM_BIT}) and then lays TWO icons brightly on top:
  //    ABBRUCH on the place of LADEN (@0x4f26e) and START once more (@0x4f28d). Together with
  //    {@link MENU_ZONES_LOADED} those are exactly the two operable buttons.
  if (s.loadedGamePending) {
    const dimmed = out.map((c) => ({ ...c, dim: true }) as MenuCommand);
    out.length = 0;
    out.push(...dimmed);
    icon(MENU_ICON_CANCEL, MENU_LOADED_CANCEL_COL, MENU_LOADED_ROW);
    icon(MENU_ICON_START, 0x00, MENU_LOADED_ROW);
  }

  return out;
}

/**
 * The sink {@link drawMainMenu} writes into. Deliberately NOT a {@link Blitter}: the menu draws onto
 * its own 352 × 240 surface and needs neither the pivot convention of the map nor its image type.
 */
export interface MenuTarget {
  /**
   * An archive sprite at surface pixel `(x, y)`. `dim` demands it DARKENED, i.e. with `index | 0x80`
   * per pixel (see {@link MENU_DIM_BIT}) — in practice the same sprite decoded with a palette shifted
   * by {@link MENU_DIM_BIT}. A target ignoring `dim` shows the state "loaded save waiting" without
   * darkening.
   */
  icon(entry: number, x: number, y: number, dim?: boolean): void;
  /**
   * A FONT GLYPH — unlike an icon it is filled as a MASK in a fixed colour. `draw_popup_string` sets
   * `mov $0x1f,%eax` (@0x37c64) for that, i.e. palette index 31; the glyph sprites themselves carry a
   * different colour. Blitting glyphs like icons gives text in the wrong colour.
   */
  glyph(entry: number, x: number, y: number, color: number): void;
  /** A filled rectangle (the slider bars, `fill_rect` with a palette index). */
  fill(x: number, y: number, w: number, h: number, color: number): void;
}

/**
 * What a caller of the drawing loop brings along. In the original these are NOT properties of the
 * loop but of the wrapper before it: the menu layout adds the icon base itself (`addw $0x366,icon`
 * @0x4f365), and text colour and shadow are set by the respective wrapper before `draw_font_string`
 * @0x37cda. Hence parameters here and not constants in the body — the opening credits
 * (`core/credits.ts`) are a THIRD such wrapper.
 */
export interface MenuDrawOptions {
  /** Added to every `icon` index. Menu: {@link MENU_ICON_BASE}; credits: 0. */
  readonly iconBase?: number;
  /** Palette index of the glyph mask. Menu: {@link MENU_TEXT_COLOR}. */
  readonly textColor?: number;
  readonly glyphAdvance?: number;
}

/**
 * Draw a command list. `glyph` maps a character to its archive entry — the caller brings
 * `GLYPH_ENTRY` from `ui-render.ts` so this module need not know the font.
 *
 * The shadow handling stands ONLY here, because in the original it stands only in one place as well
 * (`draw_font_string`). A second copy for the opening credits would hold exactly until one of the two
 * is touched.
 */
export function drawMenuCommands(
  target: MenuTarget,
  commands: readonly MenuCommand[],
  glyph: (ch: string) => number | undefined,
  opts: MenuDrawOptions = {},
): void {
  const iconBase = opts.iconBase ?? MENU_ICON_BASE;
  const textColor = opts.textColor ?? MENU_TEXT_COLOR;
  const glyphAdvance = opts.glyphAdvance ?? 8;
  for (const cmd of commands) {
    // For text and fill, or-ing the COLOUR suffices — they are single-coloured, and `| 0x80` on the
    // palette index is exactly what the original does to the target pixel. Only an icon carries many
    // indices and therefore needs the shifted palette in the target.
    const dimBit = cmd.dim === true ? MENU_DIM_BIT : 0;
    if (cmd.kind === 'icon') {
      target.icon(iconBase + cmd.icon, cmd.x, cmd.y, cmd.dim === true);
    } else if (cmd.kind === 'text') {
      let cx = cmd.x;
      for (const ch of cmd.text) {
        // The black cell comes BEFORE the glyph and unconditionally — the original checks neither
        // the character nor whether a glyph exists (`bt $0x4` @0x37d05 stands before the table
        // lookup, which follows only at @0x37d96). A space gets a cell too, and that is what makes
        // the input field visible as an area.
        if (cmd.boxed === true) target.fill(cx, cmd.y, 8, 8, MENU_BOXED_TEXT_COLOR | dimBit);
        const entry = glyph(ch);
        if (entry !== undefined) {
          // Shadow first, then the glyph on top — the order stands in the instruction stream
          // (@0x37dce before @0x37e03) and is not arbitrary: the outline would otherwise eat the
          // glyph at its edges.
          target.glyph(
            entry + MENU_GLYPH_SHADOW_OFFSET,
            cx,
            cmd.y,
            MENU_TEXT_SHADOW_COLOR | dimBit,
          );
          target.glyph(entry, cx, cmd.y, textColor | dimBit);
        }
        cx += glyphAdvance;
      }
    } else {
      target.fill(cmd.x, cmd.y, cmd.w, cmd.h, cmd.color | dimBit);
    }
  }
}

/**
 * Draw the main menu — {@link drawMenuCommands} with the menu defaults (icon base
 * {@link MENU_ICON_BASE}, text colour {@link MENU_TEXT_COLOR}).
 */
export function drawMainMenu(
  target: MenuTarget,
  commands: readonly MenuCommand[],
  glyph: (ch: string) => number | undefined,
  glyphAdvance = 8,
): void {
  drawMenuCommands(target, commands, glyph, { glyphAdvance });
}

// ─── progress bar of the map generation ──────────────────────────────────────────────────────────

/**
 * **The bar that grows over the menu on START** — `FUN_00007a63` @0x7a63, the only display routine of
 * the map generation.
 *
 * It counts in `gs+0x188` (exactly three accesses in the whole game segment: zeroing @0x7a5b,
 * reading @0x7a7f, incrementing @0x7ac4) and paints ONE rectangle per count:
 *
 * ```
 * x = 16 + 8·i   @0x7a89/@0x7a8d      y = 67   @0x7a91
 * w = 8          @0x7a99             h = 2     @0x7aa1     colour 0x48 @0x7aa9
 * ```
 *
 * One call draws `n` rectangles in a row and presents ONCE (`call 0x44d7e` @0x7ae1) — that is why the
 * bar jumps by the step width and not by one segment.
 *
 * **The segment count is not set but falls out**: the 26 messages of the generation sum to 40, and
 * `16 + 40·8 == 336` is exactly the right edge of the menu area.
 *
 * The bar lies in the dark strip between the line "BY VOLKER WERTICH" and the button row; the menu
 * stays up during the generation (START @0x4fd53 draws nothing, it only sets `gs+0x1c9` bit 1, and
 * `new_game_init` clears the screen only AFTER the generator).
 */
export const MAP_GEN_BAR = {
  /** `addw $0x10,(%edi)` @0x7a8d — left edge, identical to that of the menu area. */
  x: 0x10,
  /** `mov $0x43,%eax` @0x7a91. */
  y: 0x43,
  /** `shlw $0x3` @0x7a89 respectively `mov $0x8,%eax` @0x7a99 — step width AND width. */
  segmentWidth: 8,
  /** `mov $0x2,%eax` @0x7aa1. */
  height: 2,
  /** `mov $0x48,%eax` @0x7aa9 — a muted red in the game palette. */
  colorIndex: 0x48,
  /** Sum of the 26 messages; see `engine/map-generator.ts`. */
  segments: 40,
} as const;
/**
 * Draw the bar up to `done` segments (`done` == `gs+0x188` after the last message).
 *
 * The original paints each rectangle once and leaves it standing; we redraw the surface every frame
 * and therefore repaint all previous segments. Visibly the same.
 */
export function drawMapGenProgress(target: MenuTarget, done: number): void {
  const n = Math.max(0, Math.min(MAP_GEN_BAR.segments, Math.floor(done)));
  for (let i = 0; i < n; i++) {
    target.fill(
      MAP_GEN_BAR.x + i * MAP_GEN_BAR.segmentWidth,
      MAP_GEN_BAR.y,
      MAP_GEN_BAR.segmentWidth,
      MAP_GEN_BAR.height,
      MAP_GEN_BAR.colorIndex,
    );
  }
}
