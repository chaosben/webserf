/**
 * The assistants: additions of ours that DO something on the player's behalf, and the one rule they
 * share — they act only through the commands a player's own clicks produce.
 *
 * That rule is what keeps them "on top" of the original rather than inside it. An assistant reads
 * the game state, works out what to do, and then issues exactly the commands the interaction layer
 * would have issued; the engine cannot tell the two apart, the action log records them like any
 * other, and a replay needs no knowledge of assistants at all. An assistant that wrote the state
 * itself would be a second rule book beside the original's.
 *
 * Unlike a hack an assistant has nothing to switch on: it waits until it is asked. So each has one
 * setting only — whether its plate stands over the game view — and, like every enhancement, ships
 * without one.
 */
import type { AssistSettingKey, SettingsShape } from '../settings/settings.svelte.js';
import type { ShellKey } from '../shell/i18n.js';

export interface Assistant {
  readonly id: string;
  /** Its plate stands over the game view. */
  readonly showKey: AssistSettingKey;
  readonly labelKey: ShellKey;
  readonly noteKey: ShellKey;
}

export const ASSISTANTS: readonly Assistant[] = [
  {
    id: 'road',
    showKey: 'assistShowRoad',
    labelKey: 'enh.assist.road',
    noteKey: 'enh.assist.road.note',
  },
];

export function assistantShown(settings: SettingsShape, assistant: Assistant): boolean {
  return settings[assistant.showKey];
}

/** Is the assistant of this id listed? For the view, which names its assistants by id. */
export function assistantInUse(settings: SettingsShape, id: string): boolean {
  const a = ASSISTANTS.find((x) => x.id === id);
  return a !== undefined && assistantShown(settings, a);
}
