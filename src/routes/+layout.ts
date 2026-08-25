/**
 * The application is a pure client: assets arrive through the file picker into IndexedDB, and all
 * computation happens in the browser. There is nothing a server could know about — hence no SSR.
 *
 * It is PRERENDERED nonetheless: the single route becomes a static `index.html` that any file
 * server can hand out, which on a Workers/Pages deployment means it never costs a worker
 * invocation. Together with `ssr = false` this is the usual "static shell that hydrates in the
 * browser"; nothing that cannot exist at build time is rendered there.
 *
 * Keeping an adapter still makes sense for later server-side code (multiplayer).
 */
export const ssr = false;
export const prerender = true;
