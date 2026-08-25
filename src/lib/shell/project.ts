/**
 * WHERE THIS COPY LIVES — repository address, issue tracker, and the links the interface offers
 * outwards.
 *
 * The address is a CONSTANT, not an environment variable. It used to be one (`PUBLIC_ISSUE_REPO`),
 * and that was the wrong shape: this is not deployment configuration but the identity of the
 * project itself — the same value in every copy, in the development server as in a deployment.
 * As a variable it could be unset (silently no reporting route) or misspelled (a link into an
 * error page), so the code carried a whole branch for a value that never actually varies.
 *
 * ## How a bug report reaches the tracker
 *
 * The report is built IN THE BROWSER and DOWNLOADED; the reporter files it as an issue themselves.
 * Three reasons, and the third one is the decisive one:
 *
 *  1. The application stays static — no server writing to disk on request, hence no rate limits or
 *     path guards to maintain.
 *  2. The state of a bug belongs in git. An issue IS repository state; the reporter learns the
 *     outcome from the changelog.
 *  3. GITHUB ATTACHMENTS ONLY EXIST VIA BROWSER UPLOAD — there is no API for them. The issue can
 *     only carry the save game and the screenshot if the reporter drops the file in. A
 *     server-created issue could never attach this report.
 */

/** `owner/name` of the repository this copy belongs to. */
export const PROJECT_REPO = 'chaosben/webserf';

/** Its page — shown in the info screen. */
export const PROJECT_URL = `https://github.com/${PROJECT_REPO}`;

/** The issue list, where a report ends up. */
export const PROJECT_ISSUES_URL = `${PROJECT_URL}/issues`;

/** URL that opens a prefilled issue. */
export function newIssueUrl(title: string, body: string): string {
  const p = new URLSearchParams({ title, body, labels: 'bug' });
  return `${PROJECT_ISSUES_URL}/new?${p.toString()}`;
}

/**
 * The prefilled URL carries the reporter's OWN WORDS plus a short fingerprint, not the report —
 * browsers and servers cap a URL at a few kilobytes, and the report itself is larger (60 KB raw for
 * a long game). It lies in the attached package anyway; repeating it in the body only buried the one
 * sentence a human wrote.
 *
 * What can still grow without bound is the note, because it comes from a text area. It is therefore
 * the only clipped part.
 */
export const ISSUE_NOTE_LIMIT = 4000;
