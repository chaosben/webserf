import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOVER_TIMEOUT,
  REFRESH_INTERVAL,
  UpdateBus,
  type UpdateContainer,
  type UpdateRegistration,
  type UpdateWorker,
} from './update.svelte.js';

/**
 * WATCHDOG FOR THE UPDATE NOTICE — the chain that decides whether a deployment ever reaches an open
 * tab.
 *
 * Every case here is a state of the browser that is expensive to produce by hand and cheap to
 * produce as a fake: a worker that was ALREADY waiting before the page loaded, an installation that
 * dies halfway, a second window that switches. The first case is the important one — it is the
 * normal case in production, and it is exactly the one no event announces.
 *
 * The second thing being checked is a promise about what must NOT happen: the page never reloads on
 * its own. A running match lives in memory, so an unasked reload loses it.
 */

class FakeWorker implements UpdateWorker {
  state = 'installing';
  readonly posted: unknown[] = [];
  #listeners: (() => void)[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(_type: 'statechange', listener: () => void): void {
    this.#listeners.push(listener);
  }

  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.#listeners = this.#listeners.filter((l) => l !== listener);
  }

  /** What the browser does on a state transition: set it, then tell everyone. */
  become(state: string): void {
    this.state = state;
    for (const listener of [...this.#listeners]) listener();
  }

  get watchers(): number {
    return this.#listeners.length;
  }
}

class FakeRegistration implements UpdateRegistration {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  updates = 0;
  #listeners: (() => void)[] = [];

  update(): Promise<unknown> {
    this.updates += 1;
    return Promise.resolve();
  }

  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.#listeners.push(listener);
  }

  removeEventListener(_type: 'updatefound', listener: () => void): void {
    this.#listeners = this.#listeners.filter((l) => l !== listener);
  }

  /** A new version begins to install — `installing` is set BEFORE the event, as in the browser. */
  findUpdate(worker: FakeWorker): void {
    this.installing = worker;
    for (const listener of [...this.#listeners]) listener();
  }
}

class FakeContainer implements UpdateContainer {
  /** A page served by a worker. `null` is the first visit ever. */
  controller: unknown = { id: 'active' };
  #listeners: (() => void)[] = [];

  addEventListener(_type: 'controllerchange', listener: () => void): void {
    this.#listeners.push(listener);
  }

  removeEventListener(_type: 'controllerchange', listener: () => void): void {
    this.#listeners = this.#listeners.filter((l) => l !== listener);
  }

  change(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

let bus: UpdateBus;
let reg: FakeRegistration;
let container: FakeContainer;
let reloads: number;
let clock: number;
/** What the waiting worker names as its build; `null` is a worker that never answers. */
let workerVersion: string | null;
const PAGE_VERSION = 'page-build';

/** A fresh bus per case — the reload latch fires once and is never reset. */
beforeEach(() => {
  vi.useFakeTimers();
  bus = new UpdateBus();
  reg = new FakeRegistration();
  container = new FakeContainer();
  reloads = 0;
  clock = 1_000_000;
  workerVersion = 'next-build';
});

afterEach(() => {
  vi.useRealTimers();
});

const attach = () =>
  bus.attach(reg, container, {
    reload: () => {
      reloads += 1;
    },
    now: () => clock,
    pageVersion: PAGE_VERSION,
    askVersion: () => Promise.resolve(workerVersion),
  });

/** The build question is answered asynchronously; let its promise chain run out. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('noticing a new version', () => {
  it('sees a worker that was already waiting before the page loaded', async () => {
    // THE NORMAL CASE, and the only one that already happens in production today: an earlier reload
    // installed the new worker and it has been waiting ever since. No event fires for a state that
    // already holds, so this is the case a purely event-driven version gets wrong.
    reg.waiting = new FakeWorker();
    reg.waiting.state = 'installed';

    attach();
    await settle();

    expect(bus.ready).toBe(true);
  });

  it('sees an installation that was already running when it attached', async () => {
    // SvelteKit's own `register()` starts a check on load, which can run before this attach — then
    // `updatefound` is missed and only `installing` is left to see it.
    const worker = new FakeWorker();
    reg.installing = worker;

    attach();
    worker.become('installed');
    await settle();

    expect(bus.ready).toBe(true);
  });

  it('sees a version found later in the session', async () => {
    attach();

    const worker = new FakeWorker();
    reg.findUpdate(worker);
    expect(bus.ready).toBe(false); // it only just STARTED installing

    worker.become('installed');
    await settle();
    expect(bus.ready).toBe(true);
  });

  it('says nothing on the very first visit', async () => {
    // Without a controller this page is not served by a worker at all: the files it runs ARE the
    // ones just cached, and a restart would change nothing.
    container.controller = null;
    const worker = new FakeWorker();
    reg.installing = worker;

    attach();
    worker.become('installed');
    await settle();

    expect(bus.ready).toBe(false);
  });

  it('takes the offer back when the installation dies halfway', async () => {
    const worker = new FakeWorker();
    reg.installing = worker;
    attach();
    worker.become('installed');
    await settle();
    expect(bus.ready).toBe(true);

    // `addAll` cut off mid-download. The button would otherwise point at a worker that never comes.
    worker.become('redundant');

    expect(bus.ready).toBe(false);
    expect(worker.watchers).toBe(0);
  });
});

describe('a version already on screen', () => {
  // The document goes network-first: a tab opened after a deployment runs the new build while the
  // old worker still controls it and the new one waits. That is not news.

  it('says nothing and lets the worker take over quietly when the builds match', async () => {
    workerVersion = PAGE_VERSION;
    const worker = new FakeWorker();
    worker.state = 'installed';
    reg.waiting = worker;

    attach();
    await settle();

    expect(bus.ready).toBe(false);
    expect(worker.posted).toEqual([{ type: 'SKIP_WAITING' }]);

    // The takeover reports back like any other — it must neither reload nor read as another window.
    container.change();
    expect(reloads).toBe(0);
    expect(bus.switched).toBe(false);
  });

  it('asks each worker only once, however many triggers report it', async () => {
    workerVersion = PAGE_VERSION;
    const worker = new FakeWorker();
    worker.state = 'installed';
    reg.waiting = worker;

    attach();
    bus.refresh(true);
    bus.refresh(true);
    await settle();

    expect(worker.posted).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('offers the restart when the worker does not answer', async () => {
    // A worker from before the build question existed: the safe side is the notice.
    workerVersion = null;
    reg.waiting = new FakeWorker();
    reg.waiting.state = 'installed';

    attach();
    await settle();

    expect(bus.ready).toBe(true);
    expect(reg.waiting.posted).toEqual([]);
  });

  it('a later window switch is still reported after a quiet takeover', async () => {
    workerVersion = PAGE_VERSION;
    const worker = new FakeWorker();
    worker.state = 'installed';
    reg.waiting = worker;
    attach();
    await settle();
    container.change();

    // The next deployment, taken over by another window.
    container.change();
    expect(bus.switched).toBe(true);
    expect(reloads).toBe(0);
  });
});

describe('handing over', () => {
  it('asks the waiting worker and waits for the handover instead of reloading at once', () => {
    const worker = new FakeWorker();
    worker.state = 'installed';
    reg.waiting = worker;
    attach();

    bus.apply();

    expect(worker.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    // Reloading here would be served by the OLD worker, which is still the active one — the click
    // would look like it did nothing.
    expect(reloads).toBe(0);
    expect(bus.applying).toBe(true);

    container.change();
    expect(reloads).toBe(1);
  });

  it('reloads after the deadline if the handover never reports back, and only once', () => {
    const worker = new FakeWorker();
    worker.state = 'installed';
    reg.waiting = worker;
    attach();

    bus.apply();
    vi.advanceTimersByTime(HANDOVER_TIMEOUT);
    expect(reloads).toBe(1);

    // A late `controllerchange` must not reload a second time.
    container.change();
    expect(reloads).toBe(1);
  });

  it('does not reload when another window switches', async () => {
    const worker = new FakeWorker();
    worker.state = 'installed';
    reg.waiting = worker;
    attach();
    await settle();
    expect(bus.ready).toBe(true);

    // `skipWaiting()` in the other window claims THIS client too. The session keeps running, but on
    // files the deployment no longer serves — so the notice gets sharper and nothing else happens.
    container.change();

    expect(reloads).toBe(0);
    expect(bus.switched).toBe(true);
    expect(bus.ready).toBe(false);
  });

  it('reloads plainly when there is nothing left to hand over', () => {
    attach();

    bus.apply();

    expect(reloads).toBe(1);
    expect(bus.applying).toBe(false);
  });
});

describe('looking for a new version', () => {
  it('asks at most once per window', () => {
    attach();

    bus.refresh();
    bus.refresh();
    expect(reg.updates).toBe(1);

    clock += REFRESH_INTERVAL;
    bus.refresh();
    expect(reg.updates).toBe(2);
  });

  it('finds a waiting worker even without a single event', async () => {
    attach();

    // Events are accelerators, not the mechanism: miss all of them and the next look still finds
    // what has been waiting all along.
    reg.waiting = new FakeWorker();
    reg.waiting.state = 'installed';
    bus.refresh();
    await settle();

    expect(bus.ready).toBe(true);
  });

  it('does nothing at all once detached', () => {
    const detach = attach();
    detach();

    bus.refresh(true);
    bus.apply();

    expect(reg.updates).toBe(0);
    expect(reloads).toBe(0);
  });
});
