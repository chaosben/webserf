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

	// The module explains the two calls it deliberately omits, so the check has to look at the code
	// rather than at the prose about it.
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

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
	});

	it('names its cache after the build version and clears the older ones', () => {
		expect(source).toContain('webserf-${version}');
		expect(source).toContain('caches.delete');
	});

	it('does not take over a running session', () => {
		// A session runs for hours and imports code lazily. Swapping the files underneath it makes
		// a later import ask for a chunk that the new deployment no longer has.
		expect(code).not.toContain('skipWaiting');
		expect(code).not.toContain('clients.claim');
		// ... and the prose must keep saying why, so the next reader does not "fix" it back in.
		expect(source).toContain('skipWaiting');
	});

	it('stores only same-origin responses', () => {
		expect(source).toContain('url.origin === location.origin');
	});
});
