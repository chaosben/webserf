/**
 * Bus for short status messages over the game surface — the shell's one place to say "done",
 * "could not" or "note that" without a panel of its own.
 *
 * Anything may push; `ToastStack` in the shell shows the list at the top edge of the stage, over
 * whatever the stage holds (drop zone, main menu or map). A message goes by itself after a while —
 * longer the more it matters — or on a click.
 *
 * **Only words for the player belong here.** The texts arrive already translated (`st(...)`); the
 * developer feedback of the game view (`note()` in `MapView`) stays in the console, where it can be
 * filtered, and would be noise over the map.
 *
 * Two rules keep the stack readable. The SAME message again does not stack a second copy but counts
 * up and restarts its clock — a button pressed three times says so once. And the stack is capped:
 * the oldest message gives way, because a message nobody can read any more has done its job.
 */
import type { Component } from 'svelte';

export type ToastTone = 'info' | 'good' | 'warn' | 'error';

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
  /** A picture of its own instead of the tone's; `null` = the tone's. */
  readonly icon: Component | null;
  /** How often the same message came in a row. */
  readonly count: number;
}

export interface ToastOptions {
  readonly tone?: ToastTone;
  readonly icon?: Component | null;
  /** Lifetime in milliseconds; the tone's default otherwise. */
  readonly ms?: number;
}

/** A warning is read more slowly than a confirmation, an error more slowly still. */
export const TOAST_MS: Readonly<Record<ToastTone, number>> = {
  info: 4000,
  good: 4000,
  warn: 6000,
  error: 9000,
};

export const TOAST_LIMIT = 4;

/** Exported for the tests, which need a fresh instance per case; the application uses {@link toasts}. */
export class ToastBus {
  /** Newest first — the stack grows downwards from the top edge. */
  items = $state<Toast[]>([]);

  #next = 1;
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();

  push(text: string, options: ToastOptions = {}): number {
    const tone = options.tone ?? 'info';
    const icon = options.icon ?? null;
    const ms = options.ms ?? TOAST_MS[tone];
    const head = this.items[0];
    if (head !== undefined && head.text === text && head.tone === tone) {
      this.items = [{ ...head, count: head.count + 1 }, ...this.items.slice(1)];
      this.#arm(head.id, ms);
      return head.id;
    }
    const id = this.#next++;
    const next = [{ id, text, tone, icon, count: 1 }, ...this.items];
    for (const gone of next.slice(TOAST_LIMIT)) this.#disarm(gone.id);
    this.items = next.slice(0, TOAST_LIMIT);
    this.#arm(id, ms);
    return id;
  }

  dismiss(id: number): void {
    this.#disarm(id);
    this.items = this.items.filter((t) => t.id !== id);
  }

  clear(): void {
    for (const id of [...this.#timers.keys()]) this.#disarm(id);
    this.items = [];
  }

  #arm(id: number, ms: number): void {
    this.#disarm(id);
    this.#timers.set(
      id,
      setTimeout(() => this.dismiss(id), ms),
    );
  }

  #disarm(id: number): void {
    const t = this.#timers.get(id);
    if (t !== undefined) clearTimeout(t);
    this.#timers.delete(id);
  }
}

export const toasts = new ToastBus();
