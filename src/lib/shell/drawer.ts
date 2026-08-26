import type { Component } from 'svelte';
import type { ShellKey } from './i18n.js';

/** One icon group of the left rail. Each group opens an overlay holding its commands. */
export interface DrawerGroup {
	id: string;
	/**
	 * The icon as a component. Icons come from the local `@iconify-json/material-symbols-light`
	 * package and are inlined at build time by `unplugin-icons` — no CDN, nothing fetched at runtime.
	 */
	icon: Component;
	/**
	 * The label as a KEY, not as text: that way it does not depend on when the table is built (a
	 * group list is a module-level `const`), and the source-tree check in `i18n.test.ts` can find it.
	 */
	labelKey: ShellKey;
}

/**
 * A mark on a rail icon — "something is going on in this group, even though its panel is closed".
 *
 * A flag on {@link DrawerGroup} would not work: the group list is a module-level `const` and cannot
 * carry running state. Passing marks separately also keeps the rail free of any knowledge about what
 * is being marked: it draws a dot and reads out the name the mark brings along.
 */
export interface DrawerMark {
	/** {@link DrawerGroup.id} of the marked group. */
	group: string;
	/** What the mark means, appended to the button's name — a nameless dot is not announced. */
	labelKey: ShellKey;
}

/**
 * A tab inside ONE overlay. The group (icon on the left) picks the screen, the tab picks the topic
 * within it — save-game storage and the asset archive are both "import & export" but have nothing
 * to do with each other.
 *
 * Which tab is open is held by the CALLER, not by `OverlayPanel`: only the caller knows the content,
 * and only that way can an action switch the tab along with it. The panel draws the bar and reports
 * clicks.
 */
export interface OverlayTab {
	id: string;
	labelKey: ShellKey;
}
