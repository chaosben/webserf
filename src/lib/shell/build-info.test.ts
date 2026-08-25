import { describe, expect, it } from 'vitest';
import {
	BUILD,
	type BuildInfo,
	buildStamp,
	commitDateText,
	commitDay,
	commitUrl,
	shortCommit
} from './build-info.js';
import { PROJECT_URL } from './project.js';

/**
 * WHAT CAN GO WRONG HERE IS NOT ARITHMETIC BUT A CLAIM: a line naming a commit that did not produce
 * the running code. The two cases that must cost the link are therefore driven with a planted
 * {@link BuildInfo} — bound to the real constant they would only be reachable by rebuilding, and a
 * check that cannot fail is worse than none.
 *
 * The real constant is still checked for SHAPE, because that is the half a planted value cannot
 * cover: it proves the substitution in `vite.config.ts` reaches this module at all.
 */

const CLEAN: BuildInfo = {
	commit: '0123456789abcdef0123456789abcdef01234567',
	commitDate: '2026-08-25T14:35:05+02:00',
	dirty: false
};
const DIRTY: BuildInfo = { ...CLEAN, dirty: true };
const NONE: BuildInfo = { commit: null, commitDate: null, dirty: false };

describe('build info of this build', () => {
	it('arrives from the config at all, in the one shape a reader may assume', () => {
		expect(typeof BUILD.dirty).toBe('boolean');
		if (BUILD.commit === null) {
			expect(BUILD.commitDate).toBeNull();
		} else {
			expect(BUILD.commit).toMatch(/^[0-9a-f]{40}$/);
			expect(shortCommit()).toBe(BUILD.commit.slice(0, 7));
			// A date without a commit, or the other way round, means the two git calls disagreed.
			expect(BUILD.commitDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});
});

describe('the link to the commit', () => {
	it('points at this project and at the FULL hash', () => {
		expect(commitUrl(CLEAN)).toBe(`${PROJECT_URL}/commit/${CLEAN.commit}`);
	});

	it('is withheld when the build is not that commit', () => {
		// Both are the reason this module exists — a link here would show other code than the page.
		expect(commitUrl(DIRTY)).toBeNull();
		expect(commitUrl(NONE)).toBeNull();
	});
});

describe('what is shown', () => {
	it('shortens the hash to seven, and has none without a commit', () => {
		expect(shortCommit(CLEAN)).toBe('0123456');
		expect(shortCommit(NONE)).toBeNull();
	});

	it('keeps the day and drops the time', () => {
		expect(commitDay(CLEAN)).toBe('2026-08-25');
		expect(commitDay(NONE)).toBeNull();
	});

	it('writes the date the way the reader’s language writes it', () => {
		const en = commitDateText('en', CLEAN);
		const de = commitDateText('de', CLEAN);
		expect(en).not.toBeNull();
		// Not compared literally: the wording belongs to the platform's Intl data, not to us. What
		// must hold is that the language reaches it — otherwise a fixed locale would slip in unseen.
		expect(de).not.toBe(en);
		expect(commitDateText('en', NONE)).toBeNull();
	});
});

describe('the stamp in a bug report', () => {
	it('names commit and day, ISO and English, so reports stay comparable', () => {
		expect(buildStamp(CLEAN)).toBe('0123456 (2026-08-25)');
	});

	it('marks a build that is not its commit', () => {
		// Without the mark a report from an uncommitted tree would be chased against code that never
		// ran — the expensive kind of wrong.
		expect(buildStamp(DIRTY)).toBe('0123456+ (2026-08-25, modified)');
	});

	it('says unknown rather than inventing an origin', () => {
		expect(buildStamp(NONE)).toBe('unknown');
	});
});
