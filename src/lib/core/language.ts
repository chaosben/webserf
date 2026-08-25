/**
 * **Game language** — which text version of the original applies, and how we know.
 *
 * The original is **one program per language**: `SIED.EXE` (German) and `SETT.EXE` (English) are the
 * same build, only with different text blocks between the code (the first 154918 bytes are identical,
 * the size difference is 3132 bytes). So there is no runtime language switch — the language is a
 * property of the shipped files.
 *
 * For the clone that means the language hangs on the **asset file** the user brings along (BYOA). It
 * is detected by content, not by file name — see `detectArchiveLanguage`. Unknown => **English**,
 * because that is the more widely distributed version.
 *
 * Why resolution happens only at drawing time: our layout tables still carry the **German** wording.
 * It is the reference the tables are checked against at the binary, and it stays readable
 * documentation of the source. Translation happens at the drawing site through `t()`. The tables are
 * `const` and evaluated at import — resolving there would freeze the language before any archive is
 * even loaded.
 *
 * Limit: the German wording is not always unique. Two German lines have **different** English
 * versions depending on the message (`' GERUFEN WERDEN'` three times, `'DAS NOTPROGRAMM'` twice).
 * They are therefore **not** in the wording table but only under their address; whoever needs them
 * takes `tAt()`. The set is not asserted but **computed** from `GAME_TEXTS` (`AMBIGUOUS_TEXTS`) — if a
 * third language arrives it grows by itself.
 */

import type { PaArchive } from './pa-parser.js';
import { GAME_TEXTS, type GameTextEntry } from './language-texts.js';

/** The languages a text version exists for. German is the reference. */
export const GAME_LANGUAGES = ['de', 'en'] as const;
export type GameLanguage = (typeof GAME_LANGUAGES)[number];

/**
 * **The reference language** — the wording our layout tables carry and against which they are checked
 * at the binary. While it is active `t()` is the identity. It is also the initial value: before an
 * archive is loaded there is nothing to draw (no sprites, no text), and an initial value that leaves
 * the tables untouched cannot silently corrupt any text.
 */
export const REFERENCE_LANGUAGE: GameLanguage = 'de';

/**
 * **The fallback language** — what `detectArchiveLanguage` returns when it does not know the archive
 * (German archive => German, otherwise English).
 */
export const FALLBACK_LANGUAGE: GameLanguage = 'en';

// --- detection from the archive content ----------------------------------------------------------

/**
 * **Language detection reads the archive content, not the file name** (the user may rename).
 *
 * `SPAD.PA` (German) and `SPAE.PA` (English) are **the same size** (1282805 bytes) and have a
 * **byte-identical TOC**; of 4000 entries exactly **19** differ — and all 19 lie in the icon bank
 * (870..1249): they are the wooden signs with text drawn into them (`RAUS`/`EXIT`, `SICHERN`/`SAVE`,
 * `0.5 STD.`/`0.5 HRS.`, the title logo ...). The archive contains **no** text as a string; the
 * language sits exclusively in those images.
 *
 * The five entries used here are **measured stable**: between the English full version and the
 * English demo 18 of the 19 language entries are byte-identical — the only exception is the title
 * logo 1152 ("Die Siedler" 1994 against "The Settler's" 1993), and that is precisely why it is **not**
 * among them. Checked against all three archives.
 */
export const LANGUAGE_FINGERPRINT_ENTRIES: readonly number[] = [929, 938, 1093, 1094, 1155];

/** FNV-1a-32 over the raw bytes of the `LANGUAGE_FINGERPRINT_ENTRIES`, in that order. */
export const LANGUAGE_FINGERPRINTS: Readonly<Record<GameLanguage, readonly number[]>> = {
  de: [0xf82b9bfd, 0xbf773b87, 0x69ae2b83, 0xc7a1720e, 0x65f235c8],
  en: [0x826e5a04, 0x91990649, 0x1dc20250, 0x7c963c78, 0x20326805],
};

/** FNV-1a-32 — small, deterministic, without Web Crypto (that is async and out of place here). */
export function fingerprintBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Language of a loaded archive.
 *
 * **One** matching fingerprint suffices: that way detection survives a release in which a single sign
 * was redrawn. If none matches — e.g. `SPAF.PA` (French), for which we have no reference —
 * `FALLBACK_LANGUAGE` applies.
 */
export function detectArchiveLanguage(archive: PaArchive): GameLanguage {
  return languageOfFingerprints(
    LANGUAGE_FINGERPRINT_ENTRIES.map((i) => {
      const raw = archive.getRaw(i);
      return raw === null ? null : fingerprintBytes(raw);
    }),
  );
}

/**
 * The decision alone — separated so it is testable **without an archive**: the unit tests feed the
 * known fingerprints in directly.
 *
 * @param hashes per entry of `LANGUAGE_FINGERPRINT_ENTRIES` its hash, or `null` (slot empty).
 */
export function languageOfFingerprints(hashes: readonly (number | null)[]): GameLanguage {
  for (let k = 0; k < LANGUAGE_FINGERPRINT_ENTRIES.length; k++) {
    const h = hashes[k];
    if (h === null || h === undefined) continue;
    for (const lang of GAME_LANGUAGES) {
      if (LANGUAGE_FINGERPRINTS[lang][k] === h) return lang;
    }
  }
  return FALLBACK_LANGUAGE;
}

// --- the active language -------------------------------------------------------------------------

let active: GameLanguage = REFERENCE_LANGUAGE;

/** The active language. */
export function gameLanguage(): GameLanguage {
  return active;
}

/** Sets the active language (from `detectArchiveLanguage`, once an archive is loaded). */
export function setGameLanguage(lang: GameLanguage): void {
  active = lang;
}

// --- lookup --------------------------------------------------------------------------------------

const BY_ADDR = new Map<number, GameTextEntry>();
for (const e of GAME_TEXTS) BY_ADDR.set(e.addr, e);

/** German wordings translated **differently** per site — reachable only via `tAt()`. */
export const AMBIGUOUS_TEXTS: ReadonlySet<string> = (() => {
  const seen = new Map<string, string>();
  const amb = new Set<string>();
  for (const e of GAME_TEXTS) {
    for (const lang of GAME_LANGUAGES) {
      if (lang === REFERENCE_LANGUAGE) continue;
      const key = `${lang} ${e.de}`;
      const prev = seen.get(key);
      if (prev === undefined) seen.set(key, e[lang]);
      else if (prev !== e[lang]) amb.add(e.de);
    }
  }
  return amb;
})();

const BY_DE = new Map<string, GameTextEntry>();
for (const e of GAME_TEXTS) {
  if (AMBIGUOUS_TEXTS.has(e.de)) continue;
  if (!BY_DE.has(e.de)) BY_DE.set(e.de, e);
}

/**
 * **One text of the original in the active language**, looked up by the German wording.
 *
 * An unknown wording => itself. That is intended: dynamic strings (numbers, slot names, passwords)
 * pass through unchanged, and a newly added label shows up as a German word on an English screen
 * instead of vanishing. Coverage is checked by a scan over the whole source tree.
 */
export function t(de: string): string {
  if (active === REFERENCE_LANGUAGE) return de;
  return BY_DE.get(de)?.[active] ?? de;
}

/** Like `t()`, but by the address in the game segment — for wordings occurring several times. */
export function tAt(addr: number): string {
  const e = BY_ADDR.get(addr);
  if (!e) throw new RangeError(`language: no text at address 0x${addr.toString(16)}.`);
  return e[active];
}

/**
 * **Two texts the original does NOT store in clear** — and which therefore cannot be in `GAME_TEXTS`,
 * which reads `0xff`-terminated strings.
 *
 * - The **placeholder of an empty save slot**: the ARCHIV reader `@0x46cda` fills its 160-byte buffer
 *   before reading with ten identical entries whose 16 bytes stand there as single `mov $imm,%al`
 *   (`@0x46ced` ff.). German `'     FREI     '`, English `'     FREE     '`.
 * - The **manual half** of the copy protection screen: there a blank template is added up into a word
 *   by an `addb` chain (`@0xb54e` upper, `@0xb579` lower half) — evidently so the words cannot be
 *   found by a string search. German `' OBEN '`/`' UNTEN'`, English `' TOP  '`/`'BOTTOM'`.
 */
export const OPAQUE_TEXTS: Readonly<Record<GameLanguage, Readonly<Record<OpaqueTextKey, string>>>> = {
  de: { archivFree: '     FREI     ', manualUpper: ' OBEN ', manualLower: ' UNTEN' },
  en: { archivFree: '     FREE     ', manualUpper: ' TOP  ', manualLower: 'BOTTOM' },
};

export type OpaqueTextKey = 'archivFree' | 'manualUpper' | 'manualLower';

/** One of the `OPAQUE_TEXTS` in the active language. */
export function tOpaque(key: OpaqueTextKey): string {
  return OPAQUE_TEXTS[active][key];
}
