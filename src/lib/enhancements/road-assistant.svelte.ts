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

  /** The status message that says what to click; it stands exactly as long as its step. */
  #hintId: number | null = null;

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
    this.#hint('enh.assist.road.pickStart');
  }

  /** The start flag is chosen: the next map click is the target. */
  chooseStart(start: TilePoint): void {
    this.start = start;
    this.phase = 'pickTarget';
    this.hover = null;
    this.#hint('enh.assist.road.pickTarget');
  }

  reset(): void {
    this.phase = 'idle';
    this.start = null;
    this.hover = null;
    this.#hint(null);
  }

  /**
   * The step's instruction lives among the status messages and not on the plate: a line that comes
   * and goes with the step would resize the plate and shift every plate stacked in its corner.
   */
  #hint(key: ShellKey | null): void {
    if (this.#hintId !== null) toasts.dismiss(this.#hintId);
    this.#hintId =
      key === null ? null : toasts.push(st(key), { tone: 'info', icon: IconAssistant, ms: Infinity });
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
