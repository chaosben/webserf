/**
 * WHICH COMMIT IS RUNNING — the build-time constant `vite.config.ts` substitutes, and its reading.
 *
 * The value is MEASURED at build time from the repository this folder is, not configured: unlike
 * the repository address in `project.ts` there is nothing to decide here, and a hand-kept version
 * number beside it would be a second truth that goes stale on its own.
 *
 * TWO CASES COST THE DISPLAY ITS LINK, and both are the point of this module rather than an
 * afterthought:
 *
 *  - NO COMMIT (a copy built without git history). The interface says so. A build that cannot name
 *    its origin must not invent one.
 *  - A DIRTY TREE (the development server, an unfinished change). The code running is then not that
 *    commit, so a link to it on the forge would show something else than what is on screen. The
 *    hash still helps — it says which commit this is a change ON TOP OF — but it is marked and not
 *    linked.
 *
 * Everything is a pure function over a {@link BuildInfo}, defaulting to this build's, so both cases
 * can be tested; bound to the constant alone they would only be reachable by rebuilding.
 */

import { PROJECT_URL } from './project.js';

export interface BuildInfo {
	/** Full 40-character hash, or `null` when the build could not read one. */
	readonly commit: string | null;
	/** Committer date of that commit, ISO 8601. */
	readonly commitDate: string | null;
	/** Whether the working tree held uncommitted changes when this was built. */
	readonly dirty: boolean;
}

/** What this build was made from. */
export const BUILD: BuildInfo = __BUILD_INFO__;

/** The hash as it is shown and spoken about — the first seven characters. */
export function shortCommit(info: BuildInfo = BUILD): string | null {
	return info.commit === null ? null : info.commit.slice(0, 7);
}

/** The commit's page on the forge, or `null` when it would not describe this build (see above). */
export function commitUrl(info: BuildInfo = BUILD): string | null {
	if (info.commit === null || info.dirty) return null;
	return `${PROJECT_URL}/commit/${info.commit}`;
}

/** Just the day of the commit — the ISO date without its time, which nobody needs on screen. */
export function commitDay(info: BuildInfo = BUILD): string | null {
	return info.commitDate === null ? null : info.commitDate.slice(0, 10);
}

/**
 * The date written the way the reader's language writes it. Returns `null` when there is no date,
 * so the caller decides what to put in its place.
 */
export function commitDateText(lang: string, info: BuildInfo = BUILD): string | null {
	if (info.commitDate === null) return null;
	const at = new Date(info.commitDate);
	if (Number.isNaN(at.getTime())) return null;
	return new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(at);
}

/**
 * One line naming the build, for bug reports. English and ISO-dated on purpose: report text is read
 * by whoever fixes the bug, not by whoever filed it, and it must stay comparable between reports —
 * so it follows neither the shell language nor a locale's date order.
 */
export function buildStamp(info: BuildInfo = BUILD): string {
	const short = shortCommit(info);
	if (short === null) return 'unknown';
	const day = commitDay(info);
	const inside = [day, info.dirty ? 'modified' : null].filter((x) => x !== null).join(', ');
	const suffix = inside === '' ? '' : ` (${inside})`;
	return `${short}${info.dirty ? '+' : ''}${suffix}`;
}
