/**
 * The groups of the left rail, in their order. A module of its own so the help's guard can check
 * that every group is explained (`help-content.test.ts`).
 *
 * The help needs a loaded archive — it is made of the original's pictures, and without them it would
 * describe icons nobody can see. That is why it is a function of the archive state, not a constant.
 */
import IconSettings from '~icons/material-symbols-light/settings-outline';
import IconTransfer from '~icons/material-symbols-light/swap-vert';
import IconBug from '~icons/material-symbols-light/bug-report-outline';
import IconRecord from '~icons/material-symbols-light/videocam-outline';
import IconEnhance from '~icons/material-symbols-light/extension-outline';
import IconHelp from '~icons/material-symbols-light/help-outline';
import IconInfo from '~icons/material-symbols-light/info-outline';
import type { DrawerGroup } from './drawer.js';

const BEFORE_HELP: readonly DrawerGroup[] = [
	{ id: 'settings', icon: IconSettings, labelKey: 'group.settings' },
	{ id: 'io', icon: IconTransfer, labelKey: 'group.io' },
	{ id: 'bug', icon: IconBug, labelKey: 'group.bug' },
	{ id: 'record', icon: IconRecord, labelKey: 'group.record' },
	{ id: 'enhance', icon: IconEnhance, labelKey: 'group.enhance' }
];
const HELP: DrawerGroup = { id: 'help', icon: IconHelp, labelKey: 'group.help' };
const INFO: DrawerGroup = { id: 'info', icon: IconInfo, labelKey: 'group.info' };

const WITH_HELP: readonly DrawerGroup[] = [...BEFORE_HELP, HELP, INFO];
const WITHOUT_HELP: readonly DrawerGroup[] = [...BEFORE_HELP, INFO];

/** Every group that can ever stand on the rail. */
export const ALL_GROUPS: readonly DrawerGroup[] = WITH_HELP;

/** The rail for the current state; the same array object as long as the state does not change. */
export function drawerGroups(archiveLoaded: boolean): readonly DrawerGroup[] {
	return archiveLoaded ? WITH_HELP : WITHOUT_HELP;
}
