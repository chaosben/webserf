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
 * Three decisions that are not visible from the code:
 *
 * 1. The cache is named after the build `version`, and `activate` deletes every other cache of
 *    ours. A deployment therefore replaces the stored files instead of accumulating them.
 *
 * 2. There is deliberately no `skipWaiting()`/`clients.claim()`. A session runs for hours and
 *    loads code lazily (the sound synthesis, for one); swapping the files underneath a running
 *    tab would make a later import fetch a chunk that no longer exists. The new worker takes over
 *    once the last tab of the old one is gone.
 *
 * 3. Only same-origin responses are stored. A cross-origin request yields an opaque response whose
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

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	event.respondWith(
		(async () => {
			const url = new URL(event.request.url);
			const cache = await caches.open(CACHE);

			// Precached entries are answered from the cache without asking the network. The hashed
			// program files can do this safely because their name changes with their content.
			if (url.origin === location.origin && PRECACHED.includes(url.pathname)) {
				const hit = await cache.match(url.pathname);
				if (hit) return hit;
			}

			try {
				const response = await fetch(event.request);
				if (url.origin === location.origin && response.status === 200) {
					cache.put(event.request, response.clone());
				}
				return response;
			} catch (error) {
				const hit = await cache.match(event.request);
				if (hit) return hit;

				// A navigation that reaches this point is a reload while offline. The entries of
				// `prerendered` already carry the base path, so the first of them is the shell —
				// building the path by hand would break under a non-empty base.
				if (event.request.mode === 'navigate' && prerendered.length > 0) {
					const shell = await cache.match(prerendered[0]);
					if (shell) return shell;
				}

				throw error;
			}
		})()
	);
});
