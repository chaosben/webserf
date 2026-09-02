/**
 * Bus for the version that is waiting to take over.
 *
 * Same shape as the recording and simulation buses: the shell has the button, this module knows the
 * service worker. What makes it necessary is a property of the worker (see `service-worker.ts`,
 * decision 2): a new one installs itself and then STAYS in `waiting`, because taking over a running
 * session would pull hashed files out from under it. Without something that notices the waiting
 * worker and offers it, a deployment arrives only once the last tab of the old one is gone — hours,
 * for a game that is left open.
 *
 * NOTHING RELOADS ON ITS OWN. The game state of a running match lives in memory, so an unasked
 * reload loses a match; {@link UpdateBus.reloadOnHandover} is reachable from exactly two places and
 * both hang off {@link UpdateBus.applying}, which only a click sets.
 *
 * WHY THE DEPENDENCIES ARE INJECTED: `reload` and `now`, and the three narrow interfaces below
 * instead of the DOM types. There is no browser in the test run, and the interesting cases are
 * precisely the ones that are painful to reach by hand — a worker that was already waiting before
 * the page loaded, an installation that fails halfway, another window that switches. With the fakes
 * in `update.svelte.test.ts` they are ten lines each.
 *
 * WHAT THE TESTS CANNOT COVER, and what therefore has to be walked through by hand after a change —
 * the dev server has practically no worker, so this needs two consecutive builds:
 *
 *  1. `npm run build:cloudflare && npm run preview`, open the page, LEAVE THE TAB OPEN.
 *  2. Change something, commit, build and preview again.
 *  3. Switch focus away and back in the open tab: dot on the info icon, notice in the panel.
 *  4. Press the button: exactly one reload, and the panel then shows the new commit.
 *  5. Counter-check: the same without pressing anything, just F5 — must show the new version.
 *  6. Counter-check: devtools offline, reload — must still start.
 *  7. Counter-check: first visit in a fresh profile — NO notice.
 */

/**
 * The message that lets the waiting worker take over. The same literal stands in
 * `service-worker.ts`: SvelteKit refuses any project import inside a worker, so the two halves
 * cannot share a module — `pwa.test.ts` holds them together instead.
 */
const SKIP_WAITING = 'SKIP_WAITING';

/**
 * At most one check per this much wall time. Each check that finds something downloads the whole
 * precache list in the background (~1.3 MB), unannounced and possibly mid-game.
 */
export const REFRESH_INTERVAL = 15 * 60 * 1000;

/** For the tab that stays in the foreground for hours and never fires `visibilitychange`. */
const POLL_INTERVAL = 30 * 60 * 1000;

/**
 * How long the handover gets before the page reloads anyway. `controllerchange` is the proper
 * signal; this is so a swallowed message cannot leave the button looking broken.
 */
export const HANDOVER_TIMEOUT = 3000;

/** As much of a `ServiceWorker` as this module uses. */
export interface UpdateWorker {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

/** As much of a `ServiceWorkerRegistration`. */
export interface UpdateRegistration {
  readonly installing: UpdateWorker | null;
  readonly waiting: UpdateWorker | null;
  update(): Promise<unknown>;
  addEventListener(type: 'updatefound', listener: () => void): void;
  removeEventListener(type: 'updatefound', listener: () => void): void;
}

/** As much of a `ServiceWorkerContainer`. */
export interface UpdateContainer {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

/** The two things this module would otherwise take straight from the browser. */
export interface UpdateEnv {
  reload(): void;
  now(): number;
}

/**
 * Exported for the tests, which need a FRESH instance per case: the reload latch below fires once
 * and is never reset — that is the point of a latch, and it makes the singleton unusable as a
 * fixture. The application uses {@link updates}.
 */
export class UpdateBus {
  /** A new version is installed and waiting. */
  ready = $state(false);
  /** The button was pressed and the handover is running. */
  applying = $state(false);
  /**
   * Another window took the new worker into service. This session keeps running on files that the
   * deployment no longer serves — see the caveat in `service-worker.ts`, decision 2.
   */
  switched = $state(false);

  #reg: UpdateRegistration | null = null;
  #container: UpdateContainer | null = null;
  #env: UpdateEnv | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #reloaded = false;
  #lastRefresh = 0;

  /**
   * A first-ever installation has nothing to replace: without a controller this page is not being
   * served by a worker at all, so the files it runs ARE the ones just cached. Offering a restart
   * there would be a notice about nothing.
   */
  #offer(): void {
    const controller = this.#container?.controller;
    if (controller === null || controller === undefined) return;
    this.ready = true;
  }

  #reload(): void {
    if (this.#reloaded) return;
    this.#reloaded = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#env?.reload();
  }

  /**
   * Wire up an existing registration. Returns the teardown, so it fits straight into an `$effect`.
   *
   * FIVE TRIGGERS, and each one covers a case the others miss:
   *
   *  - `waiting` as a SNAPSHOT — the normal case, and the only one that already happens today: an
   *    earlier reload installed the new worker and it has been waiting since. No event fires for a
   *    state that already holds, so a purely event-driven version shows nothing precisely here.
   *  - `installing` as a SNAPSHOT — SvelteKit's own `register()` already starts a check on load,
   *    which can run before this attach; then `updatefound` is missed and only `installing` is left
   *    to see it.
   *  - `updatefound` — the only signal for a version found LATER, in a session that stays open for
   *    hours. On its own it is not enough: it fires at the START of the installation.
   *  - `statechange` — `installed` is the point from which the button means something, `redundant`
   *    (a download cut off mid-`addAll`) has to take the offer back.
   *  - `controllerchange` — confirmation that our own `skipWaiting()` went through, and the only
   *    way to notice that ANOTHER window switched.
   */
  attach(reg: UpdateRegistration, container: UpdateContainer, env: UpdateEnv): () => void {
    this.#reg = reg;
    this.#container = container;
    this.#env = env;

    let watched: UpdateWorker | null = null;
    let onState: (() => void) | null = null;

    const unfollow = () => {
      if (watched !== null && onState !== null) watched.removeEventListener('statechange', onState);
      watched = null;
      onState = null;
    };

    const follow = (worker: UpdateWorker | null) => {
      if (worker === null || worker === watched) return;
      unfollow();
      watched = worker;
      onState = () => {
        if (worker.state === 'installed') this.#offer();
        if (worker.state === 'redundant') {
          this.ready = false;
          unfollow();
        }
      };
      worker.addEventListener('statechange', onState);
      // The state may already be past `installing`: an event only reports a CHANGE.
      onState();
    };

    const onFound = () => follow(reg.installing);

    const onController = () => {
      if (this.applying) {
        this.#reload();
        return;
      }
      this.switched = true;
      this.ready = false;
    };

    if (reg.waiting !== null) this.#offer();
    follow(reg.installing);

    reg.addEventListener('updatefound', onFound);
    container.addEventListener('controllerchange', onController);

    return () => {
      reg.removeEventListener('updatefound', onFound);
      container.removeEventListener('controllerchange', onController);
      unfollow();
      if (this.#timer !== null) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      this.#reg = null;
      this.#container = null;
      this.#env = null;
    };
  }

  /**
   * Look for a new version.
   *
   * READS THE STATE FIRST and only then asks: events are accelerators, not the mechanism. Miss all
   * of them and this still finds a worker that has been waiting all along.
   *
   * `registration.update()` rather than SvelteKit's `version.pollInterval`: that one fetches
   * `_app/version.json`, latches after its first hit and never touches the worker — the notice
   * could appear while `waiting` is empty, and the button would have nobody to write to. This call
   * also PREPARES the change: afterwards the new build sits in the new cache and the reload works
   * even with the network gone.
   */
  refresh(force = false): void {
    const reg = this.#reg;
    const env = this.#env;
    if (reg === null || env === null) return;

    if (reg.waiting !== null) this.#offer();

    const at = env.now();
    if (!force && at - this.#lastRefresh < REFRESH_INTERVAL) return;
    this.#lastRefresh = at;
    void reg.update().catch(() => {});
  }

  /** Hand the session over to the waiting version and reload onto it. Only from a click. */
  apply(): void {
    if (this.#env === null || this.applying) return;

    const worker = this.#reg?.waiting ?? null;
    if (worker === null) {
      // Nothing waiting — most likely another window already switched. A plain reload is then
      // exactly what the button promises.
      this.#reload();
      return;
    }

    this.applying = true;
    worker.postMessage({ type: SKIP_WAITING });

    // The handover is ASYNCHRONOUS. Reloading right away would be served by the old worker, which
    // is still the active one, and the click would look like it did nothing.
    this.#timer = setTimeout(() => this.#reload(), HANDOVER_TIMEOUT);
  }

  /** Watch the browser's worker. Returns the teardown — fits straight into an `$effect`. */
  watch(): () => void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

    const env: UpdateEnv = { reload: () => location.reload(), now: () => Date.now() };
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.refresh();
    };
    const poll = setInterval(onVisible, POLL_INTERVAL);
    document.addEventListener('visibilitychange', onVisible);

    let stopped = false;
    let detach = () => {};

    /*
     * `ready`, not `getRegistration()`: SvelteKit registers the worker itself, on `window.load`.
     * This module runs during hydration and therefore BEFORE that, where `getRegistration()` still
     * answers `undefined`. Registering it here would be a second registration of the same URL.
     *
     * No check of our own on load either — SvelteKit's `register()` already starts one for an
     * existing registration of the same script.
     */
    void navigator.serviceWorker.ready.then((reg) => {
      if (stopped) return;
      detach = this.attach(
        reg as unknown as UpdateRegistration,
        navigator.serviceWorker as unknown as UpdateContainer,
        env
      );
    });

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(poll);
      detach();
    };
  }
}

export const updates = new UpdateBus();
