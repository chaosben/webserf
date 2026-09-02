/**
 * Watchdog for the installable application: manifest, its link in the delivered HTML, and the
 * offline worker.
 *
 * Every part of this chain fails SILENTLY. A manifest that is not linked, an icon path that points
 * nowhere, a worker file that is no longer where the framework looks for it — none of that breaks
 * a build, a type check or a page load. It only shows as "the install option is gone" or "offline
 * it is a blank page", months later and on someone else's machine.
 *
 * The checks are therefore written against the two facts the browser actually reads: the file in
 * the static folder, and the HTML that is handed out.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const read = (path: string) => readFileSync(root + path, 'utf8');

const manifest = JSON.parse(read('static/manifest.webmanifest')) as {
	id: string;
	name: string;
	short_name: string;
	start_url: string;
	scope: string;
	display: string;
	theme_color: string;
	background_color: string;
	icons: { src: string; sizes: string; type: string; purpose: string }[];
};

describe('web app manifest', () => {
	it('carries the fields an install prompt requires', () => {
		expect(manifest.name.length).toBeGreaterThan(0);
		expect(manifest.short_name.length).toBeGreaterThan(0);
		// Anything below `standalone` leaves the application in a browser tab.
		expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display);
	});

	it('addresses itself relatively, so the base path does not matter', () => {
		expect(manifest.start_url).toBe('./');
		expect(manifest.scope).toBe('./');
	});

	it('has the two icon sizes the install prompt looks for, and both files exist', () => {
		const sizes = manifest.icons.map((icon) => icon.sizes);
		expect(sizes).toContain('192x192');
		expect(sizes).toContain('512x512');

		for (const icon of manifest.icons) {
			expect(icon.src.startsWith('./')).toBe(true);
			expect(existsSync(root + 'static/' + icon.src.slice(2))).toBe(true);
		}
	});

	it('declares no icon as maskable', () => {
		// The drawing reaches close to the edges: under a maskable crop the figure loses its head.
		// A wrong `maskable` is worse than none — the browser then trusts it and cuts.
		for (const icon of manifest.icons) expect(icon.purpose).toBe('any');
	});

	it('agrees with the colours of the document', () => {
		const html = read('src/app.html');
		expect(html).toContain(`content="${manifest.theme_color}"`);
		expect(manifest.background_color).toBe(manifest.theme_color);
	});
});

describe('delivered HTML', () => {
	const html = read('src/app.html');

	it('links the manifest in the document itself, not from a component', () => {
		// With `ssr = false` a `<svelte:head>` entry exists only after the page has run its
		// JavaScript, while the install criteria are weighed against the loaded document.
		expect(html).toContain('rel="manifest"');
		expect(html).toContain('href="./manifest.webmanifest"');

		const layout = read('src/routes/+layout.svelte');
		expect(layout).not.toContain('rel="manifest"');
	});
});

describe('service worker', () => {
	// The framework registers exactly this path on its own; renaming the file switches the offline
	// mode off without a word.
	const source = read('src/service-worker.ts');

	// TWO views of the same file. The code carries the promises, the comments carry the reasons, and
	// a check on the full text cannot tell one from the other — that is how the old check on
	// `skipWaiting` would have gone green the moment the word appeared in a handler.
	const strip = (text: string) =>
		text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	const code = strip(source);
	const comments = [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map((m) => m[0]).join('\n');

	const count = (text: string, needle: string) => text.split(needle).length - 1;

	/**
	 * `{ type, body }` for every listener, in file order — the body being the text up to the next
	 * listener head. That is only a body because every helper sits ABOVE the first head, which the
	 * first test asserts.
	 *
	 * A pure function of its text, so the sensitivity pass can run it against a mutated copy.
	 */
	function listenersOf(text: string): { type: string; body: string }[] {
		const c = strip(text);
		const heads = [...c.matchAll(/addEventListener\(\s*'(\w+)'/g)];
		return heads.map((head, i) => ({
			type: head[1],
			body: c.slice(head.index ?? 0, i + 1 < heads.length ? (heads[i + 1].index ?? 0) : c.length)
		}));
	}

	const listener = (type: string) => {
		const hit = listenersOf(source).find((l) => l.type === type);
		expect(hit, `no listener for '${type}'`).toBeDefined();
		return hit?.body ?? '';
	};

	/** Which listeners call `skipWaiting()`. */
	const skipWaitingListeners = (text: string) =>
		listenersOf(text)
			.filter((l) => l.body.includes('skipWaiting'))
			.map((l) => l.type);

	/** What the cache-first branch is keyed on — the whole point of decision 3. */
	const cacheFirstKey = (text: string) =>
		/const IMMUTABLE = new Set\((\w+)\)/.exec(strip(text))?.[1] ?? null;

	it('lays its helpers out above its listeners, in the order that makes the split a split', () => {
		// Without this the slicing above is not a slicing: a helper between two heads would be read
		// as part of the earlier handler, and every promise below it would be about the wrong text.
		expect(listenersOf(source).map((l) => l.type)).toEqual([
			'install',
			'activate',
			'message',
			'fetch'
		]);
		expect(code.indexOf('function fromNetwork')).toBeLessThan(code.indexOf('addEventListener'));
		expect(code.indexOf('async function respond')).toBeLessThan(code.indexOf('addEventListener'));
	});

	it('precaches the program files, the static files AND the prerendered page', () => {
		// Leaving out `prerendered` is the classic mistake: everything works until the first
		// offline reload, which then has no document to show.
		// Checked against the spread in the precache list, not against the word: the module names
		// all three groups in its prose as well, and a check on that would stay green after a
		// deletion (measured).
		for (const group of ['build', 'files', 'prerendered']) {
			expect(code).toContain(`...${group}`);
		}
		expect(code).toContain("from '$service-worker'");
		expect(listener('install')).toContain('cache.addAll(PRECACHED)');
	});

	it('names its cache after the build version and clears the older ones', () => {
		expect(source).toContain('webserf-${version}');
		expect(listener('activate')).toContain('caches.delete');
	});

	it('answers from the cache only where the name carries the content', () => {
		// `files` and `prerendered` keep their names across deployments. Serving them cache-first is
		// what used to hide a deployment until the last tab of the old worker was gone.
		//
		// What this does NOT catch: a cache-first read written as `cache.match(request)` inside the
		// network branch. The two counts below only pin the branch that exists.
		expect(cacheFirstKey(source)).toBe('build');
		expect(count(code, 'IMMUTABLE.has(url.pathname)')).toBe(1);
		expect(count(code, 'cache.match(url.pathname)')).toBe(1);
	});

	it('never overwrites a precached path with a runtime response', () => {
		// The cache has to stay the snapshot of ONE deployment. Without this guard the new HTML
		// lands in the OLD worker's cache, and an offline start then runs a document whose hashed
		// chunks that cache never had.
		expect(listener('fetch') + code).toContain('!PRECACHED.includes(url.pathname)');
	});

	it('gives a navigation a deadline so the stored document can step in', () => {
		// Network-first for the document costs nothing when the machine is offline (`fetch` rejects
		// at once) but hangs on a connection that answers neither way.
		expect(code).toContain('NAVIGATION_TIMEOUT');
		expect(code).toContain("request.mode !== 'navigate'");
	});

	it('takes over a running session only where the page asks for it', () => {
		// A session fetches files late, each under a hashed name the next deployment no longer
		// serves. An unconditional takeover therefore takes the sound away and stops the background
		// simulation, silently. Message-driven it is safe, because the page reloads itself with it.
		expect(count(code, 'skipWaiting')).toBe(1);
		expect(skipWaitingListeners(source)).toEqual(['message']);
		expect(count(code, 'clients.claim')).toBe(0);
	});

	it('keeps explaining in prose why there is no unconditional takeover', () => {
		// Against the COMMENTS, not the file: since the call now legitimately exists in a handler, a
		// check on the whole text would be satisfied by the code itself and say nothing.
		expect(comments).toContain('skipWaiting');
		expect(comments).toContain('clients.claim');
	});

	it('stores only same-origin responses', () => {
		expect(code).toContain('url.origin === location.origin');
	});

	it('agrees with the page about the handover message', () => {
		// SvelteKit refuses any project import inside a service worker (only `$service-worker`,
		// `$env/static/public`, `$app/env/public` — it throws at build time). The two halves of this
		// protocol therefore cannot share a module, and this is the only check that holds them
		// together.
		const literal = (text: string) => /const SKIP_WAITING = '(\w+)'/.exec(text)?.[1] ?? null;

		const worker = literal(source);
		const page = literal(read('src/lib/shell/update.svelte.ts'));

		expect(worker).not.toBeNull();
		expect(page).toBe(worker);
	});

	describe('sensitivity', () => {
		// Every promise above is a function of a source string, so the fallback can be staged in
		// memory. A check that cannot go red is not a check.

		it('sees a `skipWaiting()` that moved into the install path', () => {
			const mutated = source.replace(
				'await cache.addAll(PRECACHED);',
				'await cache.addAll(PRECACHED);\n\t\t\tvoid sw.skipWaiting();'
			);
			expect(mutated).not.toBe(source);
			expect(skipWaitingListeners(mutated)).toEqual(['install', 'message']);
		});

		it('sees the cache-first branch widened back to the whole precache list', () => {
			const mutated = source.replace('new Set(build)', 'new Set(PRECACHED)');
			expect(mutated).not.toBe(source);
			expect(cacheFirstKey(mutated)).toBe('PRECACHED');
		});

		it('sees the two halves of the handover message drift apart', () => {
			const literal = (text: string) => /const SKIP_WAITING = '(\w+)'/.exec(text)?.[1] ?? null;
			const bent = read('src/lib/shell/update.svelte.ts').replace(
				"const SKIP_WAITING = 'SKIP_WAITING'",
				"const SKIP_WAITING = 'SKIP_WAIT'"
			);
			expect(literal(bent)).not.toBe(literal(source));
		});
	});
});
