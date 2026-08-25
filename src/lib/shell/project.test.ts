import { describe, expect, it } from 'vitest';
import { PROJECT_ISSUES_URL, PROJECT_REPO, PROJECT_URL, newIssueUrl } from './project.js';

/**
 * The addresses this application points OUTWARDS to. They are constants, so there is little logic
 * to test — what is tested is the part that can silently go wrong: a link that leaves our own
 * repository, and a store page in the wrong language.
 */
describe('project addresses', () => {
	it('every link stays inside this project', () => {
		expect(PROJECT_REPO).toMatch(/^[\w.-]+\/[\w.-]+$/);
		expect(PROJECT_URL).toBe(`https://github.com/${PROJECT_REPO}`);
		expect(PROJECT_ISSUES_URL.startsWith(`${PROJECT_URL}/`)).toBe(true);
		// A report must never be aimed at someone else's tracker.
		expect(newIssueUrl('t', 'b').startsWith(`${PROJECT_ISSUES_URL}/new?`)).toBe(true);
	});

	it('carries title and body into the prefilled issue', () => {
		const url = new URL(newIssueUrl('a title', 'a body'));
		expect(url.searchParams.get('title')).toBe('a title');
		expect(url.searchParams.get('body')).toBe('a body');
		expect(url.searchParams.get('labels')).toBe('bug');
	});
});
