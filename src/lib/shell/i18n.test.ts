import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	detectShellLanguage,
	pickShellLanguage,
	setShellLanguage,
	SHELL_LANGUAGES,
	SHELL_TABLES,
	shellLanguage,
	st,
	type ShellKey
} from './i18n.js';

/**
 * WATCHDOG FOR THE SHELL LANGUAGE. Three classes of bug that would otherwise only show on screen:
 *
 * 1. A PREFERENCE LIST resolved wrongly — the interesting case is `['fr', 'de']`: we do not know
 *    the first language but we do know the second.
 * 2. A PLACEHOLDER present in one language only. The value then vanishes silently, and only in
 *    that language — the kind of bug you never see while testing, because you work in the other.
 * 3. A KEY nobody uses (left over from a removed panel) or one that does not exist (typo in the
 *    call). The first is dead weight, the second an empty field on screen — the scan below checks
 *    both directions.
 *
 * The type system covers class 3 only halfway: a typo in a call fails to compile, a key without a
 * user never does.
 */

const ROOT = new URL('../../..', import.meta.url).pathname; // app/

/**
 * Every file that could draw translated text — the WHOLE source tree, not just `shell/`: the
 * screen-reader labels of the game surfaces live in `views/`, and a list that only knows `shell/`
 * reports them as orphans. Excluded are `i18n.ts` itself (otherwise every key counts as used
 * through its own definition, see below) and the tests.
 */
function translatableSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				walk(full);
				continue;
			}
			if (e.name === 'i18n.ts' || e.name.endsWith('.test.ts')) continue;
			if (e.name.endsWith('.svelte') || e.name.endsWith('.ts')) out.push(full);
		}
	};
	walk(join(ROOT, 'src'));
	return out;
}

describe('pickShellLanguage', () => {
	it('picks the first known language of the list', () => {
		expect(pickShellLanguage(['de-DE', 'de', 'en-US'])).toBe('de');
		expect(pickShellLanguage(['en-GB'])).toBe('en');
		// The load-bearing case: unknown first, known behind it.
		expect(pickShellLanguage(['fr-FR', 'de'])).toBe('de');
	});

	it('falls back to English', () => {
		expect(pickShellLanguage([])).toBe('en');
		expect(pickShellLanguage(['fr', 'it', 'zh-Hans'])).toBe('en');
	});

	it('is case-insensitive and looks at the primary subtag only', () => {
		expect(pickShellLanguage(['DE-AT'])).toBe('de');
		expect(pickShellLanguage(['de_DE'])).toBe('en'); // an underscore is not a language tag
	});

	it('detectShellLanguage returns the default without a browser', () => {
		// In Node `navigator` has no `languages`; that is exactly the SSR/test case.
		expect(SHELL_LANGUAGES).toContain(detectShellLanguage());
	});
});

describe('tables', () => {
	const keys = Object.keys(SHELL_TABLES.en) as ShellKey[];

	it('hold the same keys in both languages', () => {
		expect(Object.keys(SHELL_TABLES.de).sort()).toEqual(keys.slice().sort());
		expect(keys.length).toBeGreaterThan(50); // coverage: the shell has a lot of text
	});

	it('hold no empty string', () => {
		for (const lang of SHELL_LANGUAGES)
			for (const k of keys) expect(SHELL_TABLES[lang][k].trim().length, `${lang}/${k}`).toBeGreaterThan(0);
	});

	it('hold the same placeholders per line', () => {
		const marks = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).slice().sort();
		for (const k of keys)
			expect(marks(SHELL_TABLES.de[k]), `placeholders in ${k}`).toEqual(marks(SHELL_TABLES.en[k]));
	});

	it('really differ — otherwise one side was copied', () => {
		// Proper nouns and symbols may stay identical. Everything else has to differ, otherwise the
		// translation was not written but copied.
		const same = keys.filter((k) => SHELL_TABLES.de[k] === SHELL_TABLES.en[k]);
		expect(same.length, `identical: ${same.join(', ')}`).toBeLessThan(6);
	});
});

describe('st', () => {
	it('substitutes placeholders', () => {
		setShellLanguage('en');
		expect(st('saves.deleted', { slot: 3 })).toBe('Slot 3 deleted.');
		setShellLanguage('de');
		expect(st('saves.deleted', { slot: 3 })).toBe('Platz 3 gelöscht.');
	});

	it('leaves an unknown placeholder in place instead of blanking it', () => {
		setShellLanguage('en');
		expect(st('saves.deleted', {})).toContain('{slot}');
	});

	it('follows the selected language', () => {
		setShellLanguage('de');
		expect(shellLanguage()).toBe('de');
		expect(st('group.bug')).toBe('Fehler melden');
		setShellLanguage('en');
		expect(st('group.bug')).toBe('Report a bug');
	});
});

describe('outward links in the table', () => {
	/**
	 * `link.store` is an ADDRESS and not a sentence, so the usual "both languages differ" check is
	 * not enough — a wrong locale segment is a page in the wrong language and prices in the wrong
	 * currency, and it looks perfectly fine while testing in the other language. Checked in both
	 * directions, otherwise one fixed URL in both tables would pass.
	 */
	it('sends every shell language to its own store page', () => {
		const urls = SHELL_LANGUAGES.map((l) => SHELL_TABLES[l]['link.store']);
		expect(new Set(urls).size).toBe(SHELL_LANGUAGES.length);
		expect(SHELL_TABLES.de['link.store']).toContain('/de-de/');
		expect(SHELL_TABLES.en['link.store']).toContain('/en-us/');
		for (const u of urls) expect(u.startsWith('https://www.ubisoft.com/')).toBe(true);
	});
});

describe('coverage across the source tree', () => {
	const sources = translatableSources();
	const text = sources.map((f) => readFileSync(f, 'utf8')).join('\n');
	const keys = Object.keys(SHELL_TABLES.en);

	/**
	 * The two directions need DIFFERENT scans, and the reason is the type system:
	 *
	 * - "key does not exist" is already covered by TypeScript (the argument is `ShellKey`, even
	 *   inside a ternary). The scan here is only the belt on top and may therefore be narrow: the
	 *   call shape and the table shape `labelKey: '...'`.
	 * - "key has no user" TypeScript CANNOT see. For that, every string equal to a key counts —
	 *   otherwise indirect uses raise a false alarm, which is exactly what happened on the first
	 *   run (`labelKey: 'io.tab.saves'` and `st(x ? 'lang.de' : 'lang.en')`). The weakness of that
	 *   breadth is stated with it: an accidentally equal string elsewhere would hide a real orphan.
	 *   For names shaped like `saves.confirm` that is unlikely, but it is not a proof.
	 */
	//
	// BOTH QUOTE STYLES COUNT. The source tree is written with single quotes, but an editor's
	// format-on-save can rewrite a file to double quotes — and a scan that only knows one style
	// then reports every key of that file as an orphan. That happened once and cost more time than
	// the two characters here.
	const called = new Set<string>();
	for (const m of text.matchAll(/\bst(?:Split)?\(\s*['"]([^'"]+)['"]/g)) called.add(m[1]!);
	for (const m of text.matchAll(/\blabelKey:\s*['"]([^'"]+)['"]/g)) called.add(m[1]!);

	it('sees the source tree at all', () => {
		// Without this line a wrong path could report "no violations" — a check that cannot fail is
		// worse than no check.
		expect(sources.length).toBeGreaterThan(100);
		expect(called.size).toBeGreaterThan(40);
	});

	it('uses no key that does not exist', () => {
		const unknown = [...called].filter((k) => !keys.includes(k));
		expect(unknown, `unbekannt: ${unknown.join(', ')}`).toEqual([]);
	});

	it('has no key without a user', () => {
		const orphans = keys.filter((k) => !text.includes(`'${k}'`) && !text.includes(`"${k}"`));
		expect(orphans, `ungenutzt: ${orphans.join(', ')}`).toEqual([]);
	});
});
