/**
 * NAME AND ID OF A REPORT PACKAGE. Pure string work without any dependency — and a separate module
 * for exactly that reason: the report builder reads the build-time environment
 * (`$env/static/public`), which only exists under Vite. Tools that read a report run under plain
 * Node and need only {@link reportIdOf}; living over there, it would drag half the deployment
 * configuration behind it.
 */

// ── Name hardening ────────────────────────────────────────────────────────────────────────────
// The reporter's note goes into the file name. It is hardened even though there is no server it
// could attack: a download name with `/` or a leading `-` is a trap locally too (the browser
// rejects it, the shell reads it as a flag).

/** Note → folder short name. Only `a–z 0–9 -`, so a note cannot build a path. */
export function debugSlug(raw: string | undefined): string {
  const map: Record<string, string> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };
  const s = (raw ?? '')
    .toLowerCase()
    .replace(/[\u00e4\u00f6\u00fc\u00df]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s.length > 0 ? s : 'bericht';
}

/**
 * Alphabet of the report id: digits and lower-case letters WITHOUT the confusable pairs `i/l/1` and
 * `o/0` — an id gets read aloud and typed back.
 *
 * Two reasons it is not `A-Za-z0-9_-`: an id with a leading `-` turns the folder name into a
 * command-line trap (`rm -r -x8f…` reads as a flag), and case distinctions do not survive being
 * read aloud. Length 32 also divides 256, so `byte & 31` is uniform — the usual modulo bias never
 * arises.
 */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 8 characters out of 32 == 40 bits. With a handful of folders a collision is pure theory. */
export const REPORT_ID_LENGTH = 8;

/** Source of randomness — a parameter so a test can supply the bytes. */
export type RandomBytes = (n: number) => Uint8Array;

const cryptoBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * A fresh id. It is RANDOM and explicitly not a counter: a counter has to be derived from what is
 * already there, jumps back when old reports are cleaned up, and then hands the same number to a
 * second, different report.
 */
export function newReportId(random: RandomBytes = cryptoBytes): string {
  const bytes = random(REPORT_ID_LENGTH);
  let out = '';
  for (let i = 0; i < REPORT_ID_LENGTH; i++) out += ID_ALPHABET.charAt((bytes[i] ?? 0) & 31);
  return out;
}

/**
 * Name of a report package, without extension: `<id>-<timestamp>-<shortname>`. Pattern and assembly
 * sit next to each other — and the pattern is built from the same alphabet as the id itself, so
 * that {@link reportIdOf} really does read what {@link reportName} writes.
 */
const REPORT_DIR = new RegExp(
  `^([${ID_ALPHABET}]{${REPORT_ID_LENGTH}})-\\d{4}-\\d{2}-\\d{2}-\\d{6}-`,
);

export function reportName(id: string, stamp: string, note: string | undefined): string {
  return `${id}-${stamp}-${debugSlug(note)}`;
}

/** Id taken from a package name; `null` means "not one of ours". For the evaluation side. */
export function reportIdOf(name: string): string | null {
  return REPORT_DIR.exec(name)?.[1] ?? null;
}
