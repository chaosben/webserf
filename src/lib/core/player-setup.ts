/**
 * **Who plays in which colour** — the face bytes of the four player slots.
 *
 * The original keeps them in `gs + 0x1d6 + 4*slot` and does **not** store them in the save: only the
 * game-start initialisation (`@0x4feae`) writes them, the load routine never does (checked across
 * every function touching those fields — exactly two writers, both in the game start). They are
 * **reconstructible**, because the same routine derives them from a setup record addressed by two
 * fields of the save:
 *
 * ```
 * record = gameType == 0 ? levelSetupIndex + 5 : missionSetupIndex - 1     // @0x4fed2 / @0x4feee
 * face[0] = 0x0c                                                          // literal @0x4ff21
 * face[1..3] = record[0x10], record[0x14], record[0x18]
 * ```
 *
 * Both formulas and the literal were read back in the assembly (`subw $0x1` / `addw $0x5` /
 * `mov $0xc,%al`, record size `mul $0x24`).
 *
 * Verified against real saves: "face != 0" hits exactly the slots the player block reports as
 * active, over 39 saves without a deviation — among them two with **three** active players and two
 * with `gameType == 1`, so both index branches are covered by data, not only by code.
 */

import type { MenuPlayerSetup } from './types.js';

/** Face byte of the human player — literal of the game-start routine. */
export const HUMAN_FACE = 0x0c;

/** Face byte of the **second** human player — literal of the `gameType == 3` branch of `apply_game_setup`. */
export const HUMAN_FACE_2 = 0x0d;

/**
 * The opponent faces per setup record (index 0..35), slots 1..3. `0` means "slot empty".
 * Records 0..5 have no opponents; from 6 on their count and number rise. Higher records carry no
 * setup data any more and are therefore not listed.
 */
export const SETUP_OPPONENT_FACES: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], //  0
  [0, 0, 0], //  1
  [0, 0, 0], //  2
  [0, 0, 0], //  3
  [0, 0, 0], //  4
  [0, 0, 0], //  5
  [1, 0, 0], //  6
  [2, 3, 0], //  7
  [2, 4, 0], //  8
  [2, 0, 0], //  9
  [3, 4, 0], // 10
  [3, 5, 0], // 11
  [3, 0, 0], // 12
  [4, 6, 0], // 13
  [4, 5, 6], // 14
  [4, 0, 0], // 15
  [5, 7, 0], // 16
  [5, 6, 7], // 17
  [5, 0, 0], // 18
  [6, 8, 0], // 19
  [6, 7, 8], // 20
  [6, 0, 0], // 21
  [7, 8, 9], // 22
  [7, 9, 0], // 23
  [7, 0, 0], // 24
  [8, 9, 0], // 25
  [8, 9, 10], // 26
  [8, 0, 0], // 27
  [9, 10, 0], // 28
  [9, 10, 0], // 29
  [9, 0, 0], // 30
  [10, 0, 0], // 31
  [10, 0, 0], // 32
  [10, 0, 0], // 33
  [11, 0, 0], // 34
  [11, 0, 0], // 35
];

/**
 * Last campaign level (30). The binary compares it against `gs[0x356]` at **two** places:
 * `cmpw $0x1e` @0x384c4 (from here on there is no follow-up password — record 36 does not exist) and
 * @0x38826 (from here on the end credits run). It stands here once so the two readers cannot drift
 * apart.
 */
export const LAST_CAMPAIGN_LEVEL = 0x1e;

/**
 * First setup record that carries a password (`add $0xd8` == 6 · 0x24, @0x4f41e / @0x384e8). The
 * password table therefore begins at `0x61442 + 0xd8 == 0x6151a`, and **record `k` holds the password
 * of level `k + 1`**: record 6 decodes to `'START   '`, the same eight characters the program init
 * writes into the buffer (@0xb432 ff.).
 *
 * A property of the setup table, so it lives here — `main-menu.ts` re-exports it for its own readers.
 */
export const FIRST_CAMPAIGN_RECORD = 6;

/**
 * Character table of the password (`DAT_0004f37f` @0x4f37f, 27 bytes): the byte value of the setup
 * record is the index. Not an alphabet but a scrambling — which is exactly why "the decoded values
 * are words" is evidence and not a triviality.
 *
 * It lives here rather than with the mission-end screen because it has **two** consumers: there the
 * password of the follow-up mission is shown, in the main menu the typed one is held against every
 * record. Both read the same table at the same address.
 */
export const PASSWORD_CHARS = 'OUJFASXNHZEMYCTQKWGLIDVRPB ';

/** Password length (`vreg0 = 7`, `subw $1 ; jae` => 8 passes, @0x38509/@0x38549). */
export const PASSWORD_LENGTH = 8;

/**
 * Decode one record password. The original reads the index signed (`movswl` @0x38527/@0x4f465) and
 * computes **without** a range check; a value beyond the table would be a foreign byte. Here it falls
 * back to the padding character instead of showing an invented number.
 */
export function decodeSetupPassword(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) out += PASSWORD_CHARS[bytes[i] ?? 0] ?? ' ';
  return out;
}

/** `gameType == 0` — the level campaign, the only type that has passwords. */
const GAME_TYPE_LEVEL = 0;

/** What the follow-up password depends on: game type, winner and the level that just ended. */
export interface CampaignOutcome {
  /** `gs+0x352`. */
  readonly gameType: number;
  /** `gs+0x5e` — the winning slot, `-1` = nobody. */
  readonly winnerIndex: number;
  /** `gs+0x356` — the level that was played. */
  readonly levelSetupIndex: number;
}

/**
 * **The password of the FOLLOW-UP level**, or `null` when the original shows none.
 *
 * The loop `@0x38510..@0x3854d` decodes eight bytes of record `levelSetupIndex + FIRST_CAMPAIGN_RECORD`
 * and writes each character to **two** sinks: the display literal `@0x38a51` and the buffer
 * `gs+0x35a`, which is the main menu's password line and the save field `.DS`@128. The running level
 * uses record `levelSetupIndex + 5`, one less — hence the NEXT level's password is shown.
 *
 * The three gates around the loop are part of the answer and therefore live here rather than in the
 * two callers: level campaign (`gs+0x352 == 0`), slot 0 has won (`gs+0x5e == 0`, @0x384c0) and the
 * level is not the last (`je 0x3879b` @0x384c8 — record 36 does not exist, the sound parameter table
 * begins there).
 *
 * `records` comes in rather than being read from {@link SETUP_PASSWORD_BYTES} so a probe can hold the
 * function against bytes taken straight from the binary.
 */
export function campaignFollowUpPassword(
  outcome: CampaignOutcome,
  records: readonly (readonly number[] | undefined)[],
): string | null {
  if (outcome.gameType !== GAME_TYPE_LEVEL || outcome.winnerIndex !== 0) return null;
  if (outcome.levelSetupIndex === LAST_CAMPAIGN_LEVEL) return null; // je 0x3879b
  const record = records[outcome.levelSetupIndex + FIRST_CAMPAIGN_RECORD];
  if (record === undefined) return null;
  return decodeSetupPassword(record);
}

/**
 * The first **eight bytes** of each setup record (index 0..35) — the mission password, encoded as an
 * index into {@link PASSWORD_CHARS}. From the setup table `@0x61442` (record size `0x24`); the
 * mission end reads record `levelSetupIndex + 6`, so it shows the password of the **next** mission.
 *
 * Records 0..5 are empty (`0x00`x8 => `"OOOOOOOO"`) — they carry no campaign level. The comment behind
 * each line is the decoded form; that **words** appear there is the evidence that character table and
 * record layout are right.
 */
export const SETUP_PASSWORD_BYTES: readonly (readonly number[])[] = [
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], //  0  (leer)
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], //  1  (leer)
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], //  2  (leer)
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], //  3  (leer)
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], //  4  (leer)
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], //  5  (leer)
  [0x05, 0x0e, 0x04, 0x17, 0x0e, 0x1a, 0x1a, 0x1a], //  6  'START   '
  [0x05, 0x0e, 0x04, 0x0e, 0x14, 0x00, 0x07, 0x1a], //  7  'STATION '
  [0x01, 0x07, 0x14, 0x0e, 0x0c, 0x1a, 0x1a, 0x1a], //  8  'UNITY   '
  [0x11, 0x04, 0x16, 0x0a, 0x1a, 0x1a, 0x1a, 0x1a], //  9  'WAVE    '
  [0x0a, 0x06, 0x18, 0x00, 0x17, 0x0e, 0x1a, 0x1a], // 10  'EXPORT  '
  [0x00, 0x18, 0x0e, 0x14, 0x00, 0x07, 0x1a, 0x1a], // 11  'OPTION  '
  [0x17, 0x0a, 0x0d, 0x00, 0x17, 0x15, 0x1a, 0x1a], // 12  'RECORD  '
  [0x05, 0x0d, 0x04, 0x13, 0x0a, 0x1a, 0x1a, 0x1a], // 13  'SCALE   '
  [0x05, 0x14, 0x12, 0x07, 0x1a, 0x1a, 0x1a, 0x1a], // 14  'SIGN    '
  [0x04, 0x0d, 0x00, 0x17, 0x07, 0x1a, 0x1a, 0x1a], // 15  'ACORN   '
  [0x0d, 0x08, 0x00, 0x18, 0x18, 0x0a, 0x17, 0x1a], // 16  'CHOPPER '
  [0x12, 0x04, 0x0e, 0x0a, 0x1a, 0x1a, 0x1a, 0x1a], // 17  'GATE    '
  [0x14, 0x05, 0x13, 0x04, 0x07, 0x15, 0x1a, 0x1a], // 18  'ISLAND  '
  [0x13, 0x0a, 0x12, 0x14, 0x00, 0x07, 0x1a, 0x1a], // 19  'LEGION  '
  [0x18, 0x14, 0x0a, 0x0d, 0x0a, 0x1a, 0x1a, 0x1a], // 20  'PIECE   '
  [0x17, 0x14, 0x16, 0x04, 0x13, 0x1a, 0x1a, 0x1a], // 21  'RIVAL   '
  [0x05, 0x04, 0x16, 0x04, 0x12, 0x0a, 0x1a, 0x1a], // 22  'SAVAGE  '
  [0x06, 0x04, 0x16, 0x0a, 0x17, 0x1a, 0x1a, 0x1a], // 23  'XAVER   '
  [0x19, 0x13, 0x04, 0x15, 0x0a, 0x1a, 0x1a, 0x1a], // 24  'BLADE   '
  [0x19, 0x0a, 0x04, 0x0d, 0x00, 0x07, 0x1a, 0x1a], // 25  'BEACON  '
  [0x18, 0x04, 0x05, 0x0e, 0x01, 0x17, 0x0a, 0x1a], // 26  'PASTURE '
  [0x00, 0x0b, 0x07, 0x01, 0x05, 0x1a, 0x1a, 0x1a], // 27  'OMNUS   '
  [0x0e, 0x17, 0x14, 0x19, 0x01, 0x0e, 0x0a, 0x1a], // 28  'TRIBUTE '
  [0x03, 0x00, 0x01, 0x07, 0x0e, 0x04, 0x14, 0x07], // 29  'FOUNTAIN'
  [0x0d, 0x08, 0x01, 0x15, 0x0a, 0x1a, 0x1a, 0x1a], // 30  'CHUDE   '
  [0x0e, 0x17, 0x04, 0x14, 0x13, 0x0a, 0x17, 0x1a], // 31  'TRAILER '
  [0x0d, 0x04, 0x07, 0x0c, 0x00, 0x07, 0x1a, 0x1a], // 32  'CANYON  '
  [0x17, 0x0a, 0x18, 0x17, 0x0a, 0x05, 0x05, 0x1a], // 33  'REPRESS '
  [0x0c, 0x00, 0x10, 0x14, 0x1a, 0x1a, 0x1a, 0x1a], // 34  'YOKI    '
  [0x18, 0x04, 0x05, 0x05, 0x14, 0x16, 0x0a, 0x1a], // 35  'PASSIVE '
];

/** Setup record index from the two save fields. */
export function setupRecordIndex(
  gameType: number,
  missionSetupIndex: number,
  levelSetupIndex: number,
): number {
  return gameType === 0 ? levelSetupIndex + 5 : missionSetupIndex - 1;
}

/**
 * The four face bytes of a save, `0` for an empty slot. `null` per slot means **unknown** — then the
 * display stays blank instead of inventing a face.
 *
 * Two branches, as in `apply_game_setup` @0x4feae itself (`cmpw $0x2,0x352` @0x4feb1):
 *
 * - **level/mission** (`gameType < 2`): from the setup record, slot 0 is the literal `0x0c`.
 * - **free game** (`gameType > 1`): from the **menu columns** the save carries at `.DS`@144..163
 *   ({@link MenuPlayerSetup}). Slot 0 is an ordinary menu slot only in **demo**; otherwise slot 0
 *   (and with `gameType == 3` slot 1 as well) carries the human literals. Without `menuSetup`
 *   everything stays `null` — nothing is guessed.
 *
 * The reconstruction is not speculative: the original recomputes the same way after loading —
 * `FUN_000055ec`, the entry into the game screen, calls `apply_game_setup` on **every** entry
 * (@0x561e), a load included. There are exactly two call sites (@0x561e and @0x4fd61 = START in the
 * menu), both before the first frame.
 */
export function playerFaces(header: {
  readonly gameType: number;
  readonly missionSetupIndex: number;
  readonly levelSetupIndex: number;
  readonly menuSetup?: MenuPlayerSetup;
}): (number | null)[] {
  if (header.gameType > 1) {
    const menu = header.menuSetup;
    if (menu === undefined) return [null, null, null, null];
    const faces: (number | null)[] = [menu.face[0], menu.face[1], menu.face[2], menu.face[3]];
    if (header.gameType !== GAME_TYPE_DEMO) {
      faces[0] = HUMAN_FACE; // `mov $0xc,%al` @0x4ff21
      if (header.gameType === GAME_TYPE_TWO_HUMANS) faces[1] = HUMAN_FACE_2;
    }
    return faces;
  }
  const index = setupRecordIndex(header.gameType, header.missionSetupIndex, header.levelSetupIndex);
  const record = SETUP_OPPONENT_FACES[index];
  if (record === undefined) return [null, null, null, null];
  return [HUMAN_FACE, record[0], record[1], record[2]];
}

/** `gameType == 3` — two human players (split screen). */
const GAME_TYPE_TWO_HUMANS = 3;
/** `gameType == 4` — "DEMO", two AI players and no human; slot 0 comes from the menu. */
const GAME_TYPE_DEMO = 4;

/**
 * **The four player descriptors and the prescribed castle positions** of a setup record — the rest of
 * the same record whose face bytes {@link SETUP_OPPONENT_FACES} and whose password
 * {@link SETUP_PASSWORD_BYTES} already carry.
 *
 * `apply_game_setup` @0x4feae spreads the record over `gs+0x1d6..0x1ed` — **four bytes per player**,
 * and the order in the record differs from the target (the middle two are swapped):
 *
 * ```
 * gs[0x1d6 + 4*p + 0] = face             p=0: literal 0xc      p>0: rec[0x10 + 4*(p-1) + 0]
 * gs[0x1d6 + 4*p + 1] = supplies         p=0: rec[0x0e]        p>0: rec[... + 2]
 * gs[0x1d6 + 4*p + 2] = intelligence     p=0: literal 0x28     p>0: rec[... + 1]
 * gs[0x1d6 + 4*p + 3] = reproduction     p=0: rec[0x0f]        p>0: rec[... + 3]
 * gs[0x1e6 + 2*p]     = castle column,   gs[0x1e7 + 2*p] = castle row   <- rec[0x1c + 2*p]
 * ```
 *
 * `init_players` @0x66e9 derives **`difficulty`** (byte 1 -> `player+0x162`), the **AI rate**
 * `intelligence * 1300 + 13535` (byte 2 -> `player+0x1ae`) and **`reproductionReset`**
 * `(60 - value) * 50` (byte 3 -> `player+0x122`).
 *
 * The two literals of the human player are no accident: `0x28 == 40` yields `40 * 1300 + 13535 ==
 * 65535` in the AI formula — **exactly** the u16 ceiling. That is why human players always carry
 * `0xFF 0xFF` at block 558/559.
 *
 * Verified: (a) the face column reproduces {@link SETUP_OPPONENT_FACES} in **36 of 36** records;
 * (b) the castle positions of records 35/34/31 are **exactly** the castle positions of the three
 * shipped campaign saves (6 of 6 buildings); (c) `difficulty` from byte 1 hits the stored byte in all
 * 62 saves. Records from 36 on carry no setup data any more (the same boundary the password shows).
 */
export interface SetupRecord {
  /** Map seed `rec[8]/[0x0a]/[0x0c]` — the map generator's input (before the XOR mask). */
  readonly seed: readonly [number, number, number];
  /** Per player slot `[face, supplies, intelligence, reproduction]`; face 0 = slot empty. */
  readonly players: readonly (readonly [number, number, number, number])[];
  /** Per player slot `[column, row]` of the prescribed castle; `255` = not prescribed. */
  readonly castles: readonly (readonly [number, number])[];
}

/** The 36 setup records of table `@0x61442` (record size `0x24`). */
export const SETUP_RECORDS: readonly SetupRecord[] = [
  //  0
  {
    seed: [0xd372, 0x5192, 0xf9c2],
    players: [
      [12, 30, 40, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  1
  {
    seed: [0x0a28, 0x763c, 0x1bb5],
    players: [
      [12, 30, 40, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  2
  {
    seed: [0x4e19, 0xd3ce, 0xe017],
    players: [
      [12, 30, 40, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  3
  {
    seed: [0x271b, 0xd849, 0xf2bb],
    players: [
      [12, 30, 40, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  4
  {
    seed: [0x074b, 0x505c, 0x2983],
    players: [
      [12, 30, 40, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  5
  {
    seed: [0x1dd9, 0xa702, 0xfc8a],
    players: [
      [12, 30, 40, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  6
  {
    seed: [0x6d6f, 0xf7f0, 0xc8d4],
    players: [
      [12, 35, 40, 30],
      [1, 5, 10, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  7
  {
    seed: [0x60b9, 0xe728, 0xc484],
    players: [
      [12, 30, 40, 40],
      [2, 15, 12, 30],
      [3, 15, 14, 30],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  8
  {
    seed: [0x12ab, 0x7a4a, 0xe483],
    players: [
      [12, 30, 40, 30],
      [2, 10, 18, 25],
      [4, 10, 18, 25],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  //  9
  {
    seed: [0xacdf, 0xee65, 0x3701],
    players: [
      [12, 25, 40, 40],
      [2, 20, 15, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  // 10
  {
    seed: [0x3b8b, 0xd867, 0xd847],
    players: [
      [12, 30, 40, 30],
      [3, 25, 16, 20],
      [4, 25, 16, 20],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  // 11
  {
    seed: [0x4491, 0x36fb, 0xf9e1],
    players: [
      [12, 30, 40, 30],
      [3, 12, 20, 14],
      [5, 12, 20, 14],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  // 12
  {
    seed: [0xca18, 0x4221, 0x7f96],
    players: [
      [12, 30, 40, 40],
      [3, 30, 22, 30],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  // 13
  {
    seed: [0x88fe, 0xe0db, 0xed5c],
    players: [
      [12, 25, 40, 30],
      [4, 25, 23, 30],
      [6, 25, 24, 30],
      [0, 0, 0, 0],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  // 14
  {
    seed: [0xe9c4, 0x16fe, 0x2ef0],
    players: [
      [12, 25, 40, 40],
      [4, 13, 26, 30],
      [5, 13, 28, 30],
      [6, 13, 30, 30],
    ],
    castles: [
      [255, 255],
      [255, 255],
      [255, 255],
      [255, 255],
    ],
  },
  // 15
  {
    seed: [0x15c2, 0xf9d0, 0x5fb1],
    players: [
      [12, 20, 40, 16],
      [4, 19, 30, 20],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [28, 14],
      [5, 47],
      [255, 255],
      [255, 255],
    ],
  },
  // 16
  {
    seed: [0x9b93, 0x6be1, 0x79c0],
    players: [
      [12, 16, 40, 20],
      [5, 10, 33, 20],
      [7, 13, 34, 20],
      [0, 0, 0, 0],
    ],
    castles: [
      [16, 42],
      [52, 25],
      [23, 12],
      [255, 255],
    ],
  },
  // 17
  {
    seed: [0x4195, 0x7dba, 0xd884],
    players: [
      [12, 23, 40, 27],
      [5, 17, 27, 24],
      [6, 13, 27, 24],
      [7, 13, 27, 24],
    ],
    castles: [
      [53, 13],
      [27, 10],
      [29, 38],
      [15, 32],
    ],
  },
  // 18
  {
    seed: [0x259f, 0xcea6, 0xc000],
    players: [
      [12, 24, 40, 20],
      [5, 30, 20, 20],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [7, 26],
      [2, 10],
      [255, 255],
      [255, 255],
    ],
  },
  // 19
  {
    seed: [0x7d40, 0xc22e, 0x75bf],
    players: [
      [12, 20, 40, 23],
      [6, 16, 28, 20],
      [8, 16, 28, 20],
      [0, 0, 0, 0],
    ],
    castles: [
      [19, 3],
      [55, 7],
      [55, 46],
      [255, 255],
    ],
  },
  // 20
  {
    seed: [0xb1a1, 0x86a6, 0x61c3],
    players: [
      [12, 20, 40, 17],
      [6, 23, 40, 20],
      [7, 20, 37, 20],
      [8, 15, 40, 15],
    ],
    castles: [
      [41, 5],
      [19, 49],
      [58, 52],
      [43, 31],
    ],
  },
  // 21
  {
    seed: [0x5563, 0x46ea, 0xde0c],
    players: [
      [12, 26, 40, 23],
      [6, 29, 28, 40],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [36, 63],
      [14, 15],
      [255, 255],
      [255, 255],
    ],
  },
  // 22
  {
    seed: [0x820e, 0x3971, 0x6058],
    players: [
      [12, 25, 40, 12],
      [7, 17, 29, 10],
      [8, 17, 29, 10],
      [9, 17, 32, 10],
    ],
    castles: [
      [63, 59],
      [29, 24],
      [39, 26],
      [42, 49],
    ],
  },
  // 23
  {
    seed: [0x3b8b, 0xd867, 0xd844],
    players: [
      [12, 25, 40, 40],
      [7, 30, 40, 35],
      [9, 30, 30, 35],
      [0, 0, 0, 0],
    ],
    castles: [
      [15, 0],
      [34, 48],
      [58, 5],
      [255, 255],
    ],
  },
  // 24
  {
    seed: [0xe2c6, 0xc37d, 0xbf32],
    players: [
      [12, 30, 40, 20],
      [7, 20, 40, 20],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [13, 37],
      [32, 34],
      [255, 255],
      [255, 255],
    ],
  },
  // 25
  {
    seed: [0x83fd, 0x045f, 0xbfa4],
    players: [
      [12, 9, 40, 10],
      [8, 16, 40, 22],
      [9, 16, 40, 23],
      [0, 0, 0, 0],
    ],
    castles: [
      [14, 42],
      [62, 1],
      [32, 14],
      [255, 255],
    ],
  },
  // 26
  {
    seed: [0x02f6, 0x2275, 0xa9aa],
    players: [
      [12, 20, 40, 11],
      [8, 22, 30, 13],
      [9, 23, 30, 13],
      [10, 21, 30, 13],
    ],
    castles: [
      [38, 17],
      [32, 51],
      [1, 50],
      [4, 9],
    ],
  },
  // 27
  {
    seed: [0xa775, 0x79db, 0x8732],
    players: [
      [12, 20, 40, 40],
      [8, 25, 36, 40],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [42, 20],
      [48, 47],
      [255, 255],
      [255, 255],
    ],
  },
  // 28
  {
    seed: [0xeefc, 0x9acd, 0x5085],
    players: [
      [12, 5, 40, 11],
      [9, 30, 35, 10],
      [10, 30, 37, 10],
      [0, 0, 0, 0],
    ],
    castles: [
      [53, 1],
      [20, 2],
      [16, 55],
      [255, 255],
    ],
  },
  // 29
  {
    seed: [0xc5c5, 0xfae1, 0x69bc],
    players: [
      [12, 20, 40, 12],
      [9, 25, 30, 10],
      [10, 26, 30, 10],
      [0, 0, 0, 0],
    ],
    castles: [
      [3, 34],
      [47, 41],
      [42, 52],
      [255, 255],
    ],
  },
  // 30
  {
    seed: [0x84ae, 0x70f4, 0x4bc6],
    players: [
      [12, 20, 40, 40],
      [9, 25, 40, 40],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [23, 38],
      [57, 52],
      [255, 255],
      [255, 255],
    ],
  },
  // 31
  {
    seed: [0x8724, 0x56cd, 0x2157],
    players: [
      [12, 20, 40, 30],
      [10, 30, 38, 35],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [29, 11],
      [15, 40],
      [255, 255],
      [255, 255],
    ],
  },
  // 32
  {
    seed: [0x3242, 0x4801, 0xd21f],
    players: [
      [12, 18, 40, 28],
      [10, 25, 39, 40],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [49, 53],
      [14, 53],
      [255, 255],
      [255, 255],
    ],
  },
  // 33
  {
    seed: [0x3f61, 0xd9a4, 0xb4f7],
    players: [
      [12, 20, 40, 40],
      [10, 25, 39, 40],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [44, 39],
      [44, 63],
      [255, 255],
      [255, 255],
    ],
  },
  // 34
  {
    seed: [0xdab2, 0x5453, 0xea3e],
    players: [
      [12, 5, 40, 22],
      [11, 15, 40, 20],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [53, 8],
      [30, 22],
      [255, 255],
      [255, 255],
    ],
  },
  // 35
  {
    seed: [0x319c, 0x22be, 0xc149],
    players: [
      [12, 5, 40, 20],
      [11, 20, 40, 20],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    castles: [
      [25, 46],
      [51, 42],
      [255, 255],
      [255, 255],
    ],
  },
];

/**
 * "Not prescribed" — `place_player_castles` tests the **column** byte as a *signed char*
 * (`or %al,%al ; js` @0x5310) and thus skips every value >= 0x80. The table carries `0xff` there.
 */
export const CASTLE_POS_UNSET = 0xff;

// The record index comes from `setupRecordIndex` above. At game start it applies only for
// `gameType < 2`; beyond that there is no record.
