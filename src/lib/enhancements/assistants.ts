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
 * Unlike a hack an assistant has nothing to switch on: it waits until it is asked. So its one
 * required setting is whether its row stands in the assistants overlay over the game view — and, like
 * every enhancement, it ships without one. An assistant may add OPTIONS of how it works once asked;
 * none of them makes it act unasked. All assistants share ONE overlay: one corner, one opacity.
 */
import type { AssistOptionKey, AssistSettingKey, SettingsShape } from '../settings/settings.svelte.js';
import type { ShellKey } from '../shell/i18n.js';

export interface Assistant {
  readonly id: string;
  /** Its row stands in the assistants overlay. */
  readonly showKey: AssistSettingKey;
  readonly labelKey: ShellKey;
  readonly noteKey: ShellKey;
  /** How it works once asked; listed under its entry. */
  readonly options?: readonly AssistOption[];
}

export interface AssistOption {
  readonly key: AssistOptionKey;
  readonly labelKey: ShellKey;
}

export const ASSISTANTS: readonly Assistant[] = [
  {
    id: 'road',
    showKey: 'assistShowRoad',
    labelKey: 'enh.assist.road',
    noteKey: 'enh.assist.road.note',
    options: [{ key: 'assistRoadChain', labelKey: 'enh.assist.road.chain' }],
  },
  {
    id: 'knightShift',
    showKey: 'assistShowKnightShift',
    labelKey: 'enh.assist.shift',
    noteKey: 'enh.assist.shift.note',
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

/** Does the assistants overlay have at least one row? */
export function anyAssistantShown(settings: SettingsShape): boolean {
  return ASSISTANTS.some((a) => assistantShown(settings, a));
}
