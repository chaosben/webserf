/**
 * **Game language** — detection, lookup and the actual hardening: the **coverage**.
 *
 * The value of this file is not in the individual `t()` checks but in the source-tree scan: every
 * layout table of the screens that draw text is walked, and each wording **must** be findable in the
 * English version. A newly added label shows up at once instead of silently staying German — and the
 * same check automatically covers any further language added to the table.
 *
 * The other direction (does the wording stand like that in the binary?) is checked by a tool that
 * needs the original files and therefore cannot live here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AMBIGUOUS_TEXTS,
  FALLBACK_LANGUAGE,
  GAME_LANGUAGES,
  LANGUAGE_FINGERPRINTS,
  LANGUAGE_FINGERPRINT_ENTRIES,
  OPAQUE_TEXTS,
  REFERENCE_LANGUAGE,
  fingerprintBytes,
  gameLanguage,
  languageOfFingerprints,
  setGameLanguage,
  t,
  tAt,
  tOpaque,
} from './language.js';
import { GAME_TEXTS } from './language-texts.js';
import { MESSAGE_AMBIGUOUS_LINE_ADDR, MESSAGE_KINDS, messageLineText } from './message-popup.js';
import { DEMOLISH_LINES } from './demolish-popup.js';
import { SOIL_LEVEL_LABELS, SOIL_POPUP_TITLE } from './soil-popup.js';
import { CREDITS_STEPS } from './credits.js';
import { END_CREDITS_LINES } from './end-credits.js';
import { DISK_ARCHIV_LINE, DISK_RESULT_LINES, DISK_TITLE_LOAD, DISK_TITLE_SAVE } from './disk-menu.js';
import { FLAG_POPUP_TITLE } from './flag-popup.js';
import { OPTIONS_LABELS_BOTTOM, OPTIONS_LABELS_TOP, QUIT_POPUP_LABELS } from './options-popup.js';
import { OCCUPATION_LABELS } from './settings-popup.js';
import { MILITARY_POPUP_TITLE } from './building-popup.js';
import { PASSWORD_LABEL } from './mission-end-popup.js';
import { optionsMessageLine } from './options-popup.js';
import { copyProtectionPageText, copyProtectionWorldText } from './copy-protection.js';
import { MENU_TEXT_MAPSIZE, MENU_TEXT_TUTORIAL_LEVEL, fillMenuDigits } from './main-menu.js';
import { VIEW_OPTIONS_DEFAULT } from './engine/view-options.js';

afterEach(() => setGameLanguage(REFERENCE_LANGUAGE));

describe('game language — detection', () => {
  it('recognises every language by its own fingerprints', () => {
    for (const lang of GAME_LANGUAGES) {
      expect(languageOfFingerprints(LANGUAGE_FINGERPRINTS[lang])).toBe(lang);
    }
  });

  it('recognises it even when only ONE entry matches', () => {
    // Exactly the promise of the survey: a release may have redrawn one sign.
    for (let k = 0; k < LANGUAGE_FINGERPRINT_ENTRIES.length; k++) {
      const only = LANGUAGE_FINGERPRINT_ENTRIES.map((_, i) => (i === k ? LANGUAGE_FINGERPRINTS.de[i]! : 0));
      expect(languageOfFingerprints(only)).toBe('de');
    }
  });

  it('falls back to the fallback language when nothing matches or nothing is there', () => {
    expect(languageOfFingerprints([1, 2, 3, 4, 5])).toBe(FALLBACK_LANGUAGE);
    expect(languageOfFingerprints([null, null, null, null, null])).toBe(FALLBACK_LANGUAGE);
    expect(languageOfFingerprints([])).toBe(FALLBACK_LANGUAGE);
  });

  it('the fingerprints of the languages are pairwise distinct', () => {
    // Without this check a copied line could make two languages look identical.
    for (let k = 0; k < LANGUAGE_FINGERPRINT_ENTRIES.length; k++) {
      const seen = new Set(GAME_LANGUAGES.map((l) => LANGUAGE_FINGERPRINTS[l][k]));
      expect(seen.size).toBe(GAME_LANGUAGES.length);
    }
  });

  it('FNV-1a-32 is the expected hash', () => {
    // Reference computed by hand: FNV-1a over the three bytes 'A','B','C'.
    let h = 0x811c9dc5;
    for (const c of [65, 66, 67]) {
      h ^= c;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    expect(fingerprintBytes(new Uint8Array([65, 66, 67]))).toBe(h);
    expect(fingerprintBytes(new Uint8Array())).toBe(0x811c9dc5);
  });
});

describe('Spielsprache — Nachschlagen', () => {
  it('is the identity in the reference language', () => {
    expect(gameLanguage()).toBe(REFERENCE_LANGUAGE);
    for (const e of GAME_TEXTS) expect(t(e.de)).toBe(e.de);
  });

  it('translates in the foreign language and passes unknown text through', () => {
    setGameLanguage('en');
    expect(t('PASSWORT:')).toBe('PASSWORD:');
    expect(t('SPIEL SPEICHERN:')).toBe('   SAVE  GAME   ');
    expect(t('7 GOLDBARREN')).toBe('7 GOLDBARREN');
    expect(t('')).toBe('');
  });

  it('tAt() goes by the address and reports an unknown one', () => {
    setGameLanguage('en');
    expect(tAt(0x3a340)).toBe(' THIS LOCATION');
    expect(tAt(0x3a36e)).toBe('   THIS MENU');
    expect(tAt(0x3a3d8)).toBe('   THIS STOCK');
    expect(() => tAt(0x123)).toThrow(/no text/);
  });

  it('ambiguous wordings are COMPUTED and not reachable through t()', () => {
    // The set is nowhere written by hand — it falls out of GAME_TEXTS.
    expect([...AMBIGUOUS_TEXTS].sort()).toEqual([' GERUFEN WERDEN', 'DAS NOTPROGRAMM']);
    setGameLanguage('en');
    for (const de of AMBIGUOUS_TEXTS) expect(t(de)).toBe(de);
  });

  it('the texts missing in clear are present for every language', () => {
    for (const lang of GAME_LANGUAGES) {
      const o = OPAQUE_TEXTS[lang];
      expect(o.archivFree).toHaveLength(14);
      expect(o.manualUpper).toHaveLength(6);
      expect(o.manualLower).toHaveLength(6);
    }
    setGameLanguage('en');
    expect(tOpaque('archivFree')).toBe('     FREE     ');
    expect(tOpaque('manualUpper')).toBe(' TOP  ');
  });
});

describe('game language — source tree coverage', () => {
  /**
   * **The actual guard.** It scans `core/` for upper-case literals and demands that each is in
   * `GAME_TEXTS` — or is not, for a **named** reason. A source scan rather than a list of table
   * imports, because half of the layout tables are module private and an export just for a test would
   * give up the encapsulation for nothing.
   */
  const HERE = dirname(fileURLToPath(import.meta.url));

  /** Files whose upper-case literals are not screen texts — with a reason, not as a blanket. */
  const NOT_UI: Record<string, string> = {
    'player-setup.ts': 'the decoded campaign passwords — the setup table is byte-identical in both binaries',
    'xmi-to-smf.ts': 'IFF chunk ids of the XMI format',
    'language.ts': 'the language tables themselves',
    'language-texts.ts': 'the generated table',
    'menu-popup.ts': 'identifiers for the developer console, never drawn',
    'save-slots.ts': 'the file name ARCHIV.DS',
    'archiv-parser.ts': 'the German reference version of the FREI placeholder',
    'copy-protection.ts': 'OBEN/UNTEN are keys; the text comes from OPAQUE_TEXTS',
    'main-menu.ts': 'templates and the password of the first level',
  };

  /**
   * Individual wordings allowed everywhere — each with a reason.
   *
   * `'   SFX'` is **our** deliberate deviation (the never-ported SVGA checkbox became the sound-effect
   * switch): the original has no such text, and "SFX" is spelled the same in both languages. `'DEMO'`
   * and `'ARCHIV.DS'` stand like that in both versions (the game mode label resp. the file name).
   */
  const HARMLESS = new Set(['ARCHIV.DS', 'DEMO', '   SFX']);

  const literal = /'([A-Z][A-Z0-9 .,:!?%-]{2,})'/g;

  it('every upper-case literal in core/ is a known text or has a reason', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(40);
    const known = new Set(GAME_TEXTS.map((e) => e.de));
    const hits: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (NOT_UI[f] !== undefined) continue;
      const src = readFileSync(join(HERE, f), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return; // comments are not texts
        for (const m of line.matchAll(literal)) {
          const s = m[1]!;
          scanned++;
          if (known.has(s) || HARMLESS.has(s)) continue;
          hits.push(`${f}:${i + 1} ${JSON.stringify(s)}`);
        }
      });
    }
    // Without this number an empty hit list would also be achievable with a broken scanner.
    expect(scanned).toBeGreaterThan(100);
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('and the check recognises its own trigger form', () => {
    // Sensitivity: an invented label is not to be found in GAME_TEXTS.
    expect(GAME_TEXTS.some((e) => e.de === 'NEUES LABEL')).toBe(false);
    expect([...'NEUES LABEL'.matchAll(/'([A-Z][A-Z0-9 .,:!?%-]{2,})'/g)]).toHaveLength(0);
    expect([...`'NEUES LABEL'`.matchAll(literal)]).toHaveLength(1);
  });

  it('the exported tables resolve in every language', () => {
    const drawn: [string, string][] = [];
    const add = (where: string, ...texts: readonly string[]) => {
      for (const s of texts) drawn.push([where, s]);
    };
    add('soil', SOIL_POPUP_TITLE, ...SOIL_LEVEL_LABELS);
    add('demolish', ...DEMOLISH_LINES.map((l) => l.text));
    add('credits', ...CREDITS_STEPS.flatMap((s) => s.lines.map((l) => l.text)));
    add('endCredits', ...END_CREDITS_LINES.map((l) => l.text));
    add('disk', DISK_TITLE_SAVE, DISK_TITLE_LOAD, DISK_ARCHIV_LINE);
    for (const [, lines] of DISK_RESULT_LINES) add('disk', ...lines.map((l) => l.text));
    add('flag', FLAG_POPUP_TITLE);
    add('military', MILITARY_POPUP_TITLE);
    add('options', ...[...OPTIONS_LABELS_TOP, ...OPTIONS_LABELS_BOTTOM, ...QUIT_POPUP_LABELS].map((l) => l.text));
    add('settings', ...OCCUPATION_LABELS);
    add('missionEnd', PASSWORD_LABEL.text);
    add('messages', ...MESSAGE_KINDS.flatMap((k) => (k ? [...k.lines] : [])));
    expect(drawn.length).toBeGreaterThan(100);

    const missing: string[] = [];
    for (const lang of GAME_LANGUAGES) {
      if (lang === REFERENCE_LANGUAGE) continue;
      setGameLanguage(lang);
      for (const [where, de] of drawn) {
        if (de.trim() === '') continue;
        if (AMBIGUOUS_TEXTS.has(de)) continue; // those go through tAt(), see below
        if (HARMLESS.has(de)) continue; // own deviations, with a reason above
        if (t(de) === de && !GAME_TEXTS.some((e) => e.de === de && e[lang] === de)) {
          missing.push(`${lang} ${where}: ${JSON.stringify(de)}`);
        }
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});

describe('game language — composed lines', () => {
  /**
   * The port composes four lines from a template plus inserted digits, exactly as the original patches
   * a byte of its template. Applying `t()` to the **result** does nothing: the composed line is in no
   * table and falls back silently to the German wording. Two of them were noticed only in the image,
   * not by a check — hence this test.
   */
  it('translate the TEMPLATE, not the result', () => {
    setGameLanguage('en');
    expect(optionsMessageLine([VIEW_OPTIONS_DEFAULT, VIEW_OPTIONS_DEFAULT])).toContain('MESSAGES');
    expect(copyProtectionWorldText(8)).toContain('MAXIMUM');
    expect(copyProtectionPageText(42)).toBe('PAGE: 42');
    expect(fillMenuDigits(t(MENU_TEXT_MAPSIZE), '5')).toBe('MAPSIZE:5');
    expect(fillMenuDigits(t(MENU_TEXT_TUTORIAL_LEVEL), ' 7')).toBe(' 7. LEVEL');
  });

  it('and keep the digit slots of the template', () => {
    // The slots only hold because both versions are equally long — that is the precondition.
    for (const lang of GAME_LANGUAGES) {
      setGameLanguage(lang);
      expect(optionsMessageLine([VIEW_OPTIONS_DEFAULT, VIEW_OPTIONS_DEFAULT])).toHaveLength(16);
      expect(copyProtectionWorldText(8)).toHaveLength(24);
      // Three digits fill the template; two digits are one place shorter (the hundreds digit is
      // written only at >= 100 — exactly as in the original @0xb4b5).
      expect(copyProtectionPageText(135)).toHaveLength(9);
      expect(copyProtectionPageText(42)).toHaveLength(8);
    }
  });

  it('in the reference language everything keeps the German wording', () => {
    setGameLanguage(REFERENCE_LANGUAGE);
    expect(optionsMessageLine([VIEW_OPTIONS_DEFAULT, VIEW_OPTIONS_DEFAULT])).toContain('MITTEILUNGEN');
    expect(copyProtectionWorldText(8)).toContain('SPIELWELT');
    expect(copyProtectionPageText(42)).toBe('SEITE 42');
  });
});

describe('game language — the multi-line messages', () => {
  it('every ambiguous message line has its address', () => {
    const need: string[] = [];
    MESSAGE_KINDS.forEach((kind, type) => {
      kind?.lines.forEach((line, i) => {
        if (AMBIGUOUS_TEXTS.has(line) && !MESSAGE_AMBIGUOUS_LINE_ADDR.has(`${type}:${i}`)) {
          need.push(`${type}:${i} ${JSON.stringify(line)}`);
        }
      });
    });
    expect(need, need.join('\n')).toEqual([]);
  });

  it('and no address line is left over', () => {
    // Other direction: a stale row in the table would be a silent lie.
    for (const [key] of MESSAGE_AMBIGUOUS_LINE_ADDR) {
      const [type, i] = key.split(':').map(Number) as [number, number];
      const line = MESSAGE_KINDS[type]?.lines[i];
      expect(line, key).toBeDefined();
      expect(AMBIGUOUS_TEXTS.has(line!), `${key} is not ambiguous`).toBe(true);
    }
  });

  it('after resolving no message keeps a German line', () => {
    for (const lang of GAME_LANGUAGES) {
      if (lang === REFERENCE_LANGUAGE) continue;
      setGameLanguage(lang);
      MESSAGE_KINDS.forEach((kind, type) => {
        kind?.lines.forEach((line, i) => {
          const out = messageLineText(type, i, line);
          if (line.trim() === '') return;
          const same = GAME_TEXTS.some((e) => e.de === line && e[lang] === line);
          expect(out !== line || same, `${lang} message ${type} line ${i}: ${JSON.stringify(line)}`).toBe(
            true,
          );
        });
      });
    }
  });

  it('the three recall messages end differently in the foreign language', () => {
    // The reason for the whole address table, pinned down in one place.
    setGameLanguage('en');
    const last = (type: number) => {
      const lines = MESSAGE_KINDS[type]!.lines;
      return messageLineText(type, lines.length - 1, lines[lines.length - 1]!);
    };
    expect([last(5), last(16), last(19)]).toEqual([' THIS LOCATION', '   THIS MENU', '   THIS STOCK']);
  });
});
