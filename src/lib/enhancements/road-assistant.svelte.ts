/**
 * Bus of the road assistant: what it is doing, and the one call only the game view can answer.
 *
 * The plate over the game view operates it; the game view owns the game state, the map clicks and
 * the command path. So the view registers the builder here while it is mounted — the same pattern as
 * `shell/simulation.svelte.ts` — and the plate never touches the state.
 *
 * Nothing here is persisted and nothing reaches the game state: a plan is a proposal, and it becomes
 * real only through the commands the view issues when "build" is pressed.
 */
import type { RoadPlan, RoadPlanRefusal, TilePoint } from './road-planner.js';
import { st, type ShellKey } from '../shell/i18n.js';
import { toasts, type ToastTone } from '../shell/toasts.svelte.js';
import IconAssistant from '~icons/material-symbols-light/brightness-auto';

export type RoadAssistPhase = 'idle' | 'pickStart' | 'pickTarget' | 'preview';

class RoadAssistantBus {
  phase = $state<RoadAssistPhase>('idle');
  /** The chosen start flag, from `pickTarget` on. */
  start = $state.raw<TilePoint | null>(null);
  /** The proposal, in `preview`. */
  plan = $state.raw<RoadPlan | null>(null);
  /** Is a game view mounted that can build? */
  present = $state(false);

  #build: (() => void) | null = null;

  /** Register the builder. Returns the unregister function — fits straight into an `$effect`. */
  provide(build: () => void): () => void {
    this.#build = build;
    this.present = true;
    return () => {
      this.#build = null;
      this.present = false;
      this.reset();
    };
  }

  /** Start picking: the next map click chooses the start flag. */
  begin(): void {
    this.phase = 'pickStart';
    this.start = null;
    this.plan = null;
  }

  reset(): void {
    this.phase = 'idle';
    this.start = null;
    this.plan = null;
  }

  /** A refusal or an outcome goes to the shell's status messages, with the assistants' icon. */
  say(key: ShellKey, tone: ToastTone): void {
    toasts.push(st(key), { tone, icon: IconAssistant });
  }

  build(): void {
    if (this.phase === 'preview') this.#build?.();
  }
}

export const roadAssistant = new RoadAssistantBus();

/** The words for a refusal of the planner — spelled out, so every key is found where it is used. */
export const ROAD_REFUSAL_TEXT: Readonly<Record<RoadPlanRefusal, ShellKey>> = {
  notOwnFlag: 'enh.assist.road.notOwnFlag',
  sameFlag: 'enh.assist.road.sameFlag',
  noRoute: 'enh.assist.road.noRoute',
};
