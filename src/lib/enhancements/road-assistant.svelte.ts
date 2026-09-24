/**
 * Bus of the road assistant: which step it is in, and the route under the pointer.
 *
 * The plate over the game view starts and cancels it; the game view owns the game state, the map
 * clicks and the command path, and builds the road the moment the target flag is clicked. It
 * registers here while mounted — the same pattern as `shell/simulation.svelte.ts` — so the plate
 * only shows when there is a map to build on.
 *
 * Nothing here is persisted and nothing reaches the game state: `hover` is a preview, and a road
 * becomes real only through the commands the view issues on the click.
 */
import type { RoadPlan, RoadPlanRefusal, TilePoint } from './road-planner.js';
import { st, type ShellKey } from '../shell/i18n.js';
import { toasts, type ToastTone } from '../shell/toasts.svelte.js';
import IconAssistant from '~icons/material-symbols-light/brightness-auto';

export type RoadAssistPhase = 'idle' | 'pickStart' | 'pickTarget';

class RoadAssistantBus {
  phase = $state<RoadAssistPhase>('idle');
  /** The chosen start flag, from `pickTarget` on. */
  start = $state.raw<TilePoint | null>(null);
  /** The route to the flag under the pointer, in `pickTarget` — a preview only. */
  hover = $state.raw<RoadPlan | null>(null);
  /** Is a game view mounted that can build? */
  present = $state(false);

  /** Register a game view. Returns the unregister function — fits straight into an `$effect`. */
  provide(): () => void {
    this.present = true;
    return () => {
      this.present = false;
      this.reset();
    };
  }

  /** Start picking: the next map click chooses the start flag. */
  begin(): void {
    this.phase = 'pickStart';
    this.start = null;
    this.hover = null;
  }

  reset(): void {
    this.phase = 'idle';
    this.start = null;
    this.hover = null;
  }

  /** A refusal or an outcome goes to the shell's status messages, with the assistants' icon. */
  say(key: ShellKey, tone: ToastTone, params?: Readonly<Record<string, string | number>>): void {
    toasts.push(st(key, params), { tone, icon: IconAssistant });
  }
}

export const roadAssistant = new RoadAssistantBus();

/** The words for a refusal of the planner — spelled out, so every key is found where it is used. */
export const ROAD_REFUSAL_TEXT: Readonly<Record<RoadPlanRefusal, ShellKey>> = {
  notOwnFlag: 'enh.assist.road.notOwnFlag',
  sameFlag: 'enh.assist.road.sameFlag',
  noRoute: 'enh.assist.road.noRoute',
};
