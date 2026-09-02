/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * Offline shell. SvelteKit registers this file itself in a production build; there is no
 * registration call anywhere in the application.
 *
 * The application is a pure client — the archive and the saved games already live in IndexedDB —
 * so once the program files are cached there is nothing left that needs the network. That is the
 * whole point of the worker: without it an installed application is a window that shows an error
 * page as soon as the machine is offline.
 *
 * Five decisions that are not visible from the code:
 *
 * 1. The cache is named after the build `version`, and `activate` deletes every other cache of
 *    ours. A deployment therefore replaces the stored files instead of accumulating them.
 *
 * 2. There is no UNCONDITIONAL `skipWaiting()`, and no `clients.claim()` at all. A session runs for
 *    hours and fetches files LATE, each under a hashed name that the next deployment no longer
 *    serves: the FM synthesis pulls its WASM and its worklet processor at the first note, the tick
 *    worker is fetched when the tab goes into the background. Swapping the files underneath a
 *    running tab would take the sound away and stop the background simulation, without an error
 *    anywhere. `skipWaiting()` therefore lives in the `message` handler alone — the page asks for
 *    it and reloads itself in the same breath, which is the one moment where the swap costs
 *    nothing. `clients.claim()` is not needed on top of that: the activate step of a
 *    `skipWaiting()` worker claims the clients its predecessor held.
 *
 * 3. Cache-first is allowed only where the NAME CARRIES THE CONTENT, which is `build` and nothing
 *    else. The document and the static folder go network-first with the stored copy as the
 *    fallback. Answered from the cache they would hide a deployment until the last tab of the old
 *    worker is gone — hours, in this application.
 *
 * 4. A runtime write never overwrites a precached path. The cache has to stay the snapshot of ONE
 *    deployment: with a network-first document the new HTML would otherwise land in the old
 *    worker's cache, and an offline start would then run a document whose chunks are missing.
 *
 * 5. Only same-origin responses are stored. A cross-origin request yields an opaque response whose
 *    status reads as 0 and whose size counts fully against the storage quota.
 */

import { build, files, prerendered, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `webserf-${version}`;

/**
 * `build` are the hashed program files, `files` the contents of the static folder, and
 * `prerendered` the pages written at build time — the single route among them. Without that last
 * group an offline reload of the page itself would fail, because the document is not one of the
 * hashed assets.
 */
const PRECACHED = [...build, ...files, ...prerendered];

/**
 * The subset that may be answered without asking the network. A hashed name changes with its
 * content, so a stored copy can never be the wrong one; `files` and `prerendered` keep their names
 * across deployments and are therefore excluded.
 */
const IMMUTABLE = new Set(build);

/**
 * How long a navigation waits for the network before the stored document is handed out. An offline
 * `fetch` rejects at once — this is for the connection that answers neither way.
 */
const NAVIGATION_TIMEOUT = 2500;

/**
 * The message that lets a waiting worker take over. The same literal stands in
 * `lib/shell/update.svelte.ts`: SvelteKit allows the worker no project import, so the two halves
 * cannot share a module and a watchdog has to hold them together instead.
 */
const SKIP_WAITING = 'SKIP_WAITING';

/**
 * `fetch`, except that a navigation gives up after {@link NAVIGATION_TIMEOUT} so the stored
 * document can step in. The pending request keeps a rejection handler of its own — without it a
 * timed-out navigation would leave an unhandled rejection behind.
 */
function fromNetwork(request: Request): Promise<Response> {
	const network = fetch(request);
	if (request.mode !== 'navigate') return network;

	network.catch(() => {});

	return new Promise<Response>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('navigation timed out')), NAVIGATION_TIMEOUT);
		network.then(
			(response) => {
				clearTimeout(timer);
				resolve(response);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});
}

async function respond(event: FetchEvent): Promise<Response> {
	const url = new URL(event.request.url);
	const ours = url.origin === location.origin;
	const cache = await caches.open(CACHE);

	if (ours && IMMUTABLE.has(url.pathname)) {
		const hit = await cache.match(url.pathname);
		if (hit) return hit;
	}

	try {
		const response = await fromNetwork(event.request);
		if (ours && response.status === 200 && !PRECACHED.includes(url.pathname)) {
			cache.put(event.request, response.clone());
		}
		return response;
	} catch (error) {
		const hit = await cache.match(event.request);
		if (hit) return hit;

		// A navigation that reaches this point is a reload without a usable network. The entries of
		// `prerendered` already carry the base path, so the first of them is the shell — building
		// the path by hand would break under a non-empty base.
		if (event.request.mode === 'navigate' && prerendered.length > 0) {
			const shell = await cache.match(prerendered[0]);
			if (shell) return shell;
		}

		throw error;
	}
}

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHED);
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE && key.startsWith('webserf-')) await caches.delete(key);
			}
		})()
	);
});

sw.addEventListener('message', (event) => {
	if ((event.data as { type?: string } | null)?.type === SKIP_WAITING) void sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	event.respondWith(respond(event));
});
