/**
 * Bus of the shift-change assistant: the current light, and the way back to the game view.
 *
 * The game view owns the game state and the command path. It registers here while mounted and hands
 * over how to start a shift change — the same command the knight menu's button issues — and refreshes
 * the light on every logic frame. The overlay only shows the light and calls {@link start}.
 */
import type { GameState, Player } from '../core/engine/state.js';
import { shiftLight, type ShiftLight } from './knight-shift-advisor.js';

class KnightShiftAssistantBus {
  light = $state<ShiftLight>('red');
  /** Is a game view mounted that can start a shift change? */
  present = $state(false);

  #start: (() => void) | null = null;

  /** Register a game view. Returns the unregister function — fits straight into an `$effect`. */
  provide(start: () => void): () => void {
    this.#start = start;
    this.present = true;
    return () => {
      this.#start = null;
      this.present = false;
      this.light = 'red';
    };
  }

  /** Called by the game view once per logic frame. */
  refresh(state: GameState, player: Player | null | undefined): void {
    const next = player != null && player.active ? shiftLight(state, player) : 'red';
    if (next !== this.light) this.light = next;
  }

  /** Start a shift change — whatever the light says; it advises, it does not lock. */
  start(): void {
    this.#start?.();
  }
}

export const knightShiftAssistant = new KnightShiftAssistantBus();
