/**
 * LANGUAGE OF THE SHELL — the frame we built ourselves: drop zone, rail, overlays, settings, bug
 * report, save-game list.
 *
 * IT HAS NOTHING TO DO WITH THE GAME LANGUAGE, and that is the most important sentence here. The
 * game language hangs off the ARCHIVE (`core/language.ts`): the original ships one program per
 * language, its strings live in the executable and its signs are images inside the `.PA`, so
 * loading an English archive inevitably yields English menus no matter what the browser says. This
 * file decides only about our own strings, and those follow the BROWSER.
 *
 * A game with a German shell and English original menus is therefore possible — and correct: both
 * sides tell the truth about where they come from.
 *
 * What does NOT belong here:
 * - Strings of the original (menus, popups, messages) — those come from `core/language.ts`.
 * - LOG output (`log.ts`). It goes to the devtools console and is developer output; translated it
 *   would be harder to search and harder to read inside a bug report.
 *
 * THE BROWSER'S LANGUAGE PREFERENCE IS A LIST, not a single language: `navigator.languages` is the
 * same order that appears in the `Accept-Language` header. The first entry we have wins — a user
 * with `['fr', 'de', 'en']` gets German, not English.
 *
 * The language is determined ONCE when this module loads and never changes, so there is nothing
 * reactive here. `setShellLanguage` exists for tests and a possible future switch.
 */

/** What the shell speaks. The order is the fallback order; the last entry is the default. */
export const SHELL_LANGUAGES = ['de', 'en'] as const;
export type ShellLanguage = (typeof SHELL_LANGUAGES)[number];

/** English when the browser asks for nothing we know. */
export const SHELL_FALLBACK: ShellLanguage = 'en';

/**
 * The first requested language we actually have. Compared on the PRIMARY subtag (`de-AT` -> `de`),
 * case-insensitively — browsers spell their tags differently.
 */
export function pickShellLanguage(preferred: readonly string[]): ShellLanguage {
	for (const tag of preferred) {
		const primary = tag.toLowerCase().split('-')[0];
		const hit = SHELL_LANGUAGES.find((l) => l === primary);
		if (hit !== undefined) return hit;
	}
	return SHELL_FALLBACK;
}

/** What the browser asks for. Outside a browser (tests, SSR) the fallback. */
export function detectShellLanguage(): ShellLanguage {
	const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } })
		.navigator;
	if (nav === undefined) return SHELL_FALLBACK;
	const list = nav.languages ?? (nav.language !== undefined ? [nav.language] : []);
	return pickShellLanguage(list);
}

/**
 * The English strings are the TEMPLATE: `ShellKey` is derived from them, so a missing or invented
 * German line is a type error instead of an empty field on screen.
 *
 * `{name}` in a line is a placeholder for {@link st}. If it appears in one language but not the
 * other, the value vanishes silently — hence the test comparing both sides.
 */
const EN = {
	// -- Rail + overlay frame ------------------------------------------------------------------
	'rail.aria': 'Tool groups',
	'group.settings': 'Settings',
	'group.io': 'Import & export',
	'group.bug': 'Report a bug',
	'group.record': 'Record',
	'group.enhance': 'Enhancements',
	'group.info': 'About webserf',
	'overlay.close': 'Close',
	'page.loading': 'Loading…',
	'rail.recording': 'recording',
	'rail.update': 'new version ready',
	'rail.folder': 'save folder needs permission',

	// -- Dropzone ------------------------------------------------------------------------------
	'drop.aria': 'Drop the archive file here',
	'drop.lead': 'Drop your game archive here — or pick a file.',
	'drop.reading': 'Reading the archive…',
	'drop.choose': 'Choose an archive',
	'drop.what':
		'“The Settlers” of 1993 — in your browser. Same rules, same graphics, read straight from the original game files. Your archive and your saved games stay here with you; nothing is uploaded.',
	'drop.need':
		'All that is missing is the graphics archive from your own copy — a single file from any 1993 installation. We would happily bring it along, but the graphics belong to their publisher, and publishers are famously bad at taking a joke.',
	'drop.buy': 'Still available to buy:',
	'drop.buyLink': 'The Settlers History Edition (Ubisoft)',
	/**
	 * THE STORE ADDRESS IS A TRANSLATED VALUE, not a constant with a locale parameter: Ubisoft
	 * serves `/de-de/…` and `/en-us/…` as separate pages, so the wrong one means the wrong language
	 * AND the wrong currency. As a table entry it follows the shell language for free, and a third
	 * shell language brings its own address instead of needing a mapping somewhere else.
	 */
	'link.store': 'https://www.ubisoft.com/en-us/games/the-settlers-history-edition',
	'drop.search': 'Have a dig through that old installation — or let a search engine do the digging:',
	'drop.searchLink': 'search for “{terms}”',
	'assets.badType': 'Unexpected file type: {file} — a .PA file is expected.',
	'assets.unreadable': 'Archive is not readable: {why}',
	'assets.cacheFailed': 'Could not read the cache: {why}',

	// -- Import & export: tabs -----------------------------------------------------------------
	'io.tab.saves': 'Saved games',
	'io.tab.assets': 'Assets',

	// -- Import & export: folder ---------------------------------------------------------------
	'folder.title': 'Save folder',
	'folder.what':
		'A folder keeps a second copy as real ARCHIV.DS / SAVE0..9.DS files, kept in step with this browser — copy them into a DOSBox directory and the original loads them.',
	'folder.unsupported':
		'This browser has no folder access, so the saves live here only — use the download and import buttons above to move them.',
	'folder.attached': 'Attached:',
	'folder.detach': 'Detach the folder',
	'folder.choose': 'Choose a save folder',
	'folder.allow': 'Allow the remembered folder again',
	'folder.renews':
		'The folder is remembered; the next touch asks for its permission again. Some browsers do not keep that permission across a restart.',

	// -- Import & export: archive --------------------------------------------------------------
	'archive.title': 'Archive',
	'archive.none': 'No archive loaded.',
	'archive.info': '{entries} entries, {palettes} palettes, {language} texts.',
	'archive.privacy':
		'The archive stays in this browser and is never uploaded. Removing it drops back to the drop zone; the saved games are untouched.',
	'archive.remove': 'Remove the archive from this browser',
	'lang.de': 'German',
	'lang.en': 'English',

	// -- Saved games ---------------------------------------------------------------------------
	'saves.unavailable': 'Save storage is not available in this browser.',
	'saves.empty': '—',
	'saves.download': 'Download',
	'saves.replace': 'Replace…',
	'saves.delete': 'Delete',
	'saves.confirm': 'Really delete?',
	'saves.import': 'Import…',
	'saves.downloadAll': 'Download all ({count})',
	'saves.importPackage': 'Import a package…',
	'saves.footnote':
		'A single SAVEn.DS is the file the original reads — copy it into a DOSBox game directory and load it there. Its name is not in the file but in ARCHIV.DS, so an imported save is named after its file name. The package keeps the names.',
	'saves.deleteLocal': 'Deleting only affects this browser.',
	'saves.deleteBoth': 'Deleting also removes the file from {folder}.',
	'saves.downloaded': '{file} downloaded ({bytes} bytes).',
	'saves.unreadableSlot': 'Slot {slot} could not be read (code {code}).',
	'saves.nothingSaved': 'There is nothing saved yet.',
	'saves.packed': '{count} save(s) packed into {file}.',
	'saves.deleted': 'Slot {slot} deleted.',
	'saves.deletedButFile':
		'Slot {slot} deleted here, but {file} is still in the folder — it will come back on the next start.',
	'saves.noneInPackage': 'No usable save games in that package.',
	'saves.writeFailed': 'Slot {slot} could not be written (code {code}).',
	'saves.imported': 'Imported slot(s) {which}.',
	'saves.madeUpNames': ' The package had no ARCHIV.DS, so the names are made up.',
	'saves.ignored': ' Ignored: {list}.',
	'saves.notASave': '{file} is not a save game: {why}',
	'saves.importedInto': '{file} imported into slot {slot} as “{name}”.',

	// -- Settings ------------------------------------------------------------------------------
	'set.simulation': 'Simulation',
	'set.pause': 'Pause',
	'set.play': 'Play',
	'set.noGame': 'No game running.',
	'set.running': 'Running at {tps} ticks/s.',
	'set.held': 'Held by an open screen.',
	'set.paused': 'Paused.',
	'set.speed': 'Speed',
	'set.speedNote':
		'Only how many logic ticks run per second of real time changes — the simulation itself keeps counting in ticks, so a game stays reproducible at any speed.',
	'set.interface': 'Interface',
	'set.size': 'Size',
	'set.sizeNote':
		'Applies to this shell — the rail and these panels. The game screen keeps its own size: it follows the control bar, as in the original. The page itself does not zoom, because over the map a pinch means zooming the map.',
	'set.rest': 'Everything else',
	'set.restNote':
		'Sound, music and the control options live on the original “EXTRA OPTION” screen — reachable from the main menu and from the game; this browser remembers whatever you set there.',
	'set.reset': 'Reset to defaults',

	// -- Bug report ----------------------------------------------------------------------------
	'bug.building': 'Building…',
	'bug.build': 'Report and open issue',
	'bug.filed':
		'The report is in your downloads folder, and the issue has opened in a new tab. Drag the file into it before you submit — the checkbox there is a reminder.',
	'bug.where': 'Reports become issues in',
	'bug.intro':
		'A report holds the game state, the recorded actions, a screenshot and a summary. The simulation is paused while this panel is open, so the report describes what you saw.',
	'bug.what': 'What went wrong?',
	'bug.placeholder': 'e.g. carriers keep delivering stone to a finished hut',
	'bug.needGame': 'Start a game first — a report needs a running game.',

	// -- About ---------------------------------------------------------------------------------
	'info.about.title': 'What this is',
	'info.about.what':
		'webserf brings “The Settlers” (Blue Byte, 1993) to the browser: the rules are ported from the original program, the graphics come from your own copy of the game.',
	'info.about.assets':
		'None of the original is bundled here. The archive you loaded stays in your browser, and so do your saved games — nothing is uploaded.',
	'info.source.title': 'Source code',
	'info.source.note':
		'Open source, and issues and pull requests are always welcome. Bug reports from the “Report a bug” screen land in the same place.',
	'update.title': 'New version',
	'update.ready':
		'A newer version has been downloaded and is ready. It takes effect after a restart — which ends a match in progress, because the game state is not saved automatically.',
	'update.switched':
		'Another window has already switched to a newer version. This one is still running on the old files, and parts of it may stop working — sound above all. Restart when it suits you.',
	'update.apply': 'Restart now',
	'toast.update': 'A new version is ready — more under “About webserf”.',
	'toast.dismiss': 'Dismiss',
	'assets.loaded': '{file} loaded',
	'info.build.title': 'Build',
	'info.build.unknown': 'This copy was built without a version stamp.',
	'info.build.modified': 'built with uncommitted changes',
	'info.original.title': 'The original',
	'info.original.note': 'Still on sale — and by far the tidiest way to a copy of the game files:',
	'info.original.link': 'The Settlers History Edition (Ubisoft)',
	'info.legal.title': 'Legal',
	'info.legal.note':
		'“The Settlers” and everything in it belong to Blue Byte / Ubisoft. This here is an independent hobby project with no connection to them — built out of admiration, and out of a slight inability to let 1993 go.',	

	// -- Enhancements: additions of ours with no counterpart in the original --------------------
	// ONE NAMESPACE PER ENHANCEMENT. There will be more than one of them (see `registry.ts`), so
	// anything belonging to a single enhancement is prefixed with its id — `enh.stock.…` here. Only
	// what SHARED code says stays unprefixed: `enh.pick.…` is the icon picker both selection tabs
	// use, `enh.corner.…` is the corner vocabulary any future overlay would reuse. A second
	// enhancement therefore adds `enh.<its id>.…` and collides with nothing.
	'enh.stock.name': 'Stock overview',
	'enh.stock.tab.goods': 'Goods',
	'enh.stock.tab.serfs': 'Settlers',
	'enh.stock.tab.supply': 'Supply',
	'enh.stock.tab.view': 'Display',
	'enh.stock.aria': 'Stock overview',
	'enh.pick.all': 'All',
	'enh.pick.none': 'None',
	'enh.pick.count': '{on} of {all} selected',
	'enh.pick.noIcons': 'Load an archive to see the pictures.',
	// Shared by the three group tabs: each has a switch of its own, because "says nothing right
	// now" means something different in each.
	'enh.stock.hideUnusedNote':
		'Rows that say nothing right now stay out. With everything hidden the plate is empty and ' +
		'disappears.',
	'enh.stock.goods.title': 'Which goods',
	'enh.stock.goods.note':
		'Counted over all your warehouses, plus the building reserve the castle parks at its founding — ' +
		'the same sum the storage statistics show.',
	'enh.stock.goods.hideUnused': 'Hide goods with none in store',
	'enh.stock.serfs.title': 'Which settlers',
	'enh.stock.serfs.mode': 'Count as',
	'enh.stock.serfs.modeIdle': 'Resting in a store',
	'enh.stock.serfs.modeAvailable': 'Could be made',
	'enh.stock.serfs.modeNote':
		'“Could be made” adds the unemployed settlers to every profession whose tool lies in the store. ' +
		'One settler therefore counts in several rows — the question is “how many of these could I ' +
		'have”, not “how would they divide up”.',	
	// The supply pointers of the two chain diagrams (statistics screens 0x10 / 0x11). The receiver
	// and the good it is waiting for come from the manual legends via `entity-names.ts`; only the
	// words below are ours, because no legend names a mine, a smelter or a construction site.
	'enh.stock.serfs.hideUnused': 'Hide professions with nobody',
	'enh.stock.supply.title': 'Which pointers',
	'enh.stock.supply.note':
		'The same pointers the food and merchandise diagrams show. On a consumer the fuller the ' +
		'better; on a processor the middle is ideal — empty means nothing to do, full means it ' +
		'cannot keep up.',
	'enh.stock.supply.hideUnused': 'Hide pointers without a building',
	'enh.stock.supply.hideUnusedNote':
		'A pointer whose building you do not have has nothing to measure.',
	'enh.stock.supply.food': 'Food',
	'enh.stock.supply.mineGold': 'Gold mine',
	'enh.stock.supply.mineCoal': 'Coal mine',
	'enh.stock.supply.mineIron': 'Iron mine',
	'enh.stock.supply.mineStone': 'Stone mine',
	'enh.stock.supply.smelterGold': 'Gold smelter',
	'enh.stock.supply.smelterSteel': 'Steel smelter',
	'enh.stock.supply.military': 'Military buildings',
	'enh.stock.supply.sites': 'Construction sites',
	'enh.stock.view.perRow': 'Entries per row',
	'enh.stock.view.perRowNote':
		'One makes a narrow column, twelve a wide strip. A supply pointer is one and a half entries wide.',
	// Shared by every overlay of ours — see `enhancements/overlay-place.ts`.
	'enh.place.corner': 'Position',
	'enh.place.opacity': 'Opacity',
	'enh.corner.tl': 'Top left',
	'enh.corner.tr': 'Top right',
	'enh.corner.bl': 'Bottom left',
	'enh.corner.br': 'Bottom right',
	'enh.hacks.name': 'Hacks',
	'enh.hacks.tab.list': 'Hacks',
	'enh.hacks.tab.view': 'Display',
	'enh.hacks.title': 'Show',
	'enh.hacks.note': 'Use them via the overlay',
	'enh.hacks.minerals': 'All mineral deposits',
	'enh.hacks.minerals.note':
		'The sign a geologist would plant',
	'enh.assist.name': 'Assistants',
	'enh.assist.tab.list': 'Assistants',
	'enh.assist.tab.view': 'Display',
	'enh.assist.title': 'Show',
	'enh.assist.note': 'Use them via the overlay. They build only with the clicks a player would make.',
	'enh.assist.road': 'Road assistant',
	'enh.assist.road.note': 'The quickest road between two of your flags, built as soon as you click the target',
	'enh.assist.road.plan': 'Road building',
	'enh.assist.road.cancel': 'Cancel',
	'enh.assist.road.pickStart': 'Click the start flag',
	'enh.assist.road.pickTarget': 'Click the target flag',
	'enh.assist.road.summary': '{steps} steps · {time} s there and back',
	'enh.assist.road.notOwnFlag': 'That is not one of your flags.',
	'enh.assist.road.sameFlag': 'Start and target are the same flag.',
	'enh.assist.road.noRoute': 'No road possible — it cannot cross roads, water or foreign land.',
	'enh.assist.road.busy': 'Finish or cancel the road you are building first.',
	'enh.assist.road.failed': 'The road could not be built.',
	'enh.assist.road.built': 'Road built: {steps} steps · {time} s there and back',

	// -- Screen-reader labels for the game surfaces --------------------------------------------
	// These are OURS, not the original's: the original has none. That is why they live here and not
	// with the original strings — and why they have to follow the shell language.
	'record.stillTitle': 'Screenshot',
	'record.stillNote':
		'Taken when this panel opened — map, control bar and any open popup, as they were drawn.',
	'record.stillNone': 'No picture — the game screen gave none.',
	'record.download': 'Download the picture ({size})',
	'record.videoTitle': 'Video',
	'record.intro':
		'Records the game screen as a video — map, control bar, popups and the mouse pointer, exactly ' +
		'as they are drawn. The recording follows the game: while the simulation is paused, no frames ' +
		'are produced.',
	'record.toFile': 'You pick a file first; the video is written into it while recording.',
	'record.toMemory':
		'This browser cannot write while recording, so the video is held in memory and offered as a ' +
		'download at the end. Keep it short.',
	'record.unsupported': 'This browser cannot record a canvas.',
	'record.start': 'Start recording',
	'record.stop': 'Stop recording',
	'record.started': 'Recording started',
	'record.stopped': 'Recording stopped: {frames} frames, {size}',
	'record.progress': 'Recording — {frames} images, about {seconds} s',
	'record.needGame': 'Start a game first — there is nothing to record yet.',
	'record.quality': 'Quality',
	'record.qualityStandard': 'Standard',
	'record.qualityHigh': 'High',
	'record.qualityNote':
		'High keeps the colours of the pixel art clean: the video gets at least two pixels per game pixel. Larger files and more work for the computer while recording.',
	'record.done': '{name} — {frames} images, {size}.',
	'view.map':
		'Map view (left: place cursor, left drag: pull the view, right held: push the view like the original, middle held: grab and pull, right+left or Shift/Alt+left or long press: special click, wheel or two fingers: zoom)',
	'view.buildMenu': 'Build menu',
	'view.soil': 'Soil samples',
	'view.message': 'Message',
	'view.endCredits': 'End credits',
	'view.missionEnd': 'Mission end',
	'view.object': 'Object window',
	'view.overview': 'Overview map',
	'view.controlPanel': 'Control panel',
	// -- Help -----------------------------------------------------------------------------------
	'group.help': 'Help',
	'help.tab.start': 'First steps',
	'help.tab.controls': 'Controls',
	'help.tab.bar': 'The Menu',
	'help.tab.economy': 'Economy',
	'help.tab.devices': 'Several devices',
	'help.tab.enhance': 'Enhancements',
	'help.search.label': 'Search the help',
	'help.search.placeholder': 'Search, e.g. sawmill, geologist, special-click',
	'help.search.none': 'Nothing found for “{query}”.',
	'help.search.count': '{count} hits',
	'help.contents': 'On this page',
	'help.table.action': 'What',
	'help.table.mouse': 'Mouse',
	'help.table.touch': 'Touch',
	'help.table.profession': 'Profession',
	'help.table.tools': 'Tools',
	'help.context': 'This is the window that is open in the game.',
	'help.start.idea.title': 'The idea',
	'help.start.idea': 'You don’t command your serfs. You decide what gets built and where, you connect it all with roads — and the serfs carry, build and work on their own. Grow faster and more efficiently than your rivals: you win once you hold three quarters of the land and of the military strength.',
	'help.start.steps.title': 'Your first steps',
	'help.start.step1': '1. Start a game. In the main menu pick the first level (its password is START) and press START. The Training Games of the original manual are a good way in, too.',
	'help.start.step2': '2. Place your castle on a flat, grassy area with trees and granite nearby. Not sure where it fits? Special-click the leftmost icon of the Menu: the construction help marks every place a castle fits. Then press “construct a castle”.',
	'help.start.step3': '3. Build inside your borders (the black and white poles). Pick a spot: the symbol in the middle of the pointer — and the icon at the lower left of the Menu — tells you what fits there: a flag, a hut, a large building or a mine. Press it and choose from the window.',
	'help.start.step4': '4. Connect every construction site with roads. There is a flag in front of every building; select a flag, press the road icon and lay the road step by step to another flag. Green means flat, red means steep — steep roads are slow. A building without a road gets nothing.',
	'help.start.step5': '5. Wood and stone first: a lumberjack with a forest ranger next to him, a quarryman near the granite, and a sawmill. Every other building is made of wood and stone.',
	'help.start.step6': '6. Grow: a guard hut, guard tower or garrison pushes your borders out as soon as the first knight moves in.',
	'help.start.step7': '7. Then the long chains: fish, meat and bread feed the miners, a geologist finds the riches in the mountains, and gold raises the morale of your knights.',
	'help.start.tips.title': 'Tips',
	'help.start.tip.grid': 'Build your roads like a grid on graph paper, not as a star around the castle — otherwise all merchandise passes in front of the castle.',
	'help.start.tip.close': 'Keep buildings that work together close to each other: the sawmill next to the lumberjack, the windmill next to the farm.',
	'help.start.tip.manual': 'The 1993 manual explains every building and every menu, if you want to go deeper.',
	'help.controls.title': 'Mouse and touch',
	'help.controls.pick': 'Place the pointer, press an icon',
	'help.controls.pick.mouse': 'left click',
	'help.controls.pick.touch': 'tap',
	'help.controls.move': 'Move the screen',
	'help.controls.move.mouse': 'drag with the left button, hold the right button (as in the original), or grab with the middle button',
	'help.controls.move.touch': 'drag with one finger',
	'help.controls.zoom': 'Zoom',
	'help.controls.zoom.mouse': 'mouse wheel or touchpad',
	'help.controls.zoom.touch': 'pinch with two fingers',
	'help.controls.special': 'Special-click',
	'help.controls.special.mouse': 'hold the right button and left-click, or Shift/Alt + left click',
	'help.controls.special.touch': 'press and hold for half a second',
	'help.controls.pause': 'Pause and speed',
	'help.controls.pause.mouse': 'Settings on the rail to the left',
	'help.controls.pause.touch': 'Settings on the rail to the left',
	'help.controls.special.title': 'The special-click',
	'help.controls.special.what': 'The special-click opens the windows behind a flag or building, turns on the construction help, sends the geologist and demolishes. Demolishing always needs it, so nothing burns down by accident.',
	'help.rail.title': 'The rail to the left',
	'help.rail.intro': 'Everything the original did not have sits on the rail at the left edge, as a window over the game.',
	'help.rail.settings': 'Settings: game speed, pause and the size of these windows.',
	'help.rail.io': 'Import & export: your ten saved games, a folder to mirror them into, and the archive.',
	'help.rail.bug': 'Report a bug: packs the game, the last actions and a picture for an issue.',
	'help.rail.record':
		'Record: a screenshot of the game, or a video with the pointer — in high quality the colours of the pixel art stay clean.',
	'help.rail.enhance': 'Enhancements: extras the original never had, each off until you switch it on.',
	'help.rail.info': 'About webserf: what this is, the version, and a new version when one is waiting.',
	'help.rail.help': 'Help: this window. It is there as soon as an archive is loaded.',
	'help.bar.build.title': 'Building',
	'help.bar.flag': 'Place a flag. Flags are the intersections of your roads; six roads can begin at each one.',
	'help.bar.mine': 'Construct a mine — only in the mountains, not in the snow.',
	'help.bar.hut': 'Construct a hut: the small buildings.',
	'help.bar.large': 'Construct a large building. Use the “change page” icon to scroll through all of them; large buildings need level ground, so a leveler goes first.',
	'help.bar.large2': 'The last page of the large buildings.',
	'help.bar.castle': 'Construct a castle — only at the very beginning. It is the only building you get for free.',
	'help.bar.help': 'Special-click the leftmost icon, whatever it shows: the construction help marks every place on the screen where you can build. Special-click it again to turn it off.',
	'help.bar.roads.title': 'Roads, demolition, geologist',
	'help.bar.road': 'Road construction: starts at the selected flag. Each click adds a section, until the road meets another flag.',
	'help.bar.demolishRoad': 'Demolish road — select a road, then special-click this icon. Its transporters go back to the castle.',
	'help.bar.demolish': 'The ruin: select a building or flag, then special-click the ruin to burn it down. A window asks you to confirm.',
	'help.bar.geologist': 'Ground analysis: before your castle stands, it shows the underground riches around the pointer.',
	'help.bar.markers.title': 'The pointer',
	'help.bar.markers': 'The symbol in the middle of the pointer tells you what you can build there: two arrows — nothing; a flag; a hut; a large building (the castle symbol); a mine.',
	'help.bar.menus.title': 'Map, statistics, distribution',
	'help.bar.map': 'The overhead map. Left-click on the map to move the screen there; special-click the map icon to jump back to your castle.',
	'help.bar.stats': 'The statistics: goods in stock, buildings, serfs, production and a comparison with your rivals.',
	'help.bar.settings': 'The distribution menus: who gets food, wood, iron, coal and wheat first, which tools are made, the knights, and — at the bottom — SAVE, END and the extra options.',
	'help.bar.options': 'Extra options: scrolling when building roads, fast map click, fast construction click, how many messages you get, music, sound effects and volume — separately for the left and right side.',
	'help.bar.messages.title': 'Messages',
	'help.bar.message': 'A blinking piece of paper at the lower left of the Menu: something happened. Click it and the message appears, and the screen moves to the place.',
	'help.bar.return': 'The arrow takes you back to where you were before the message.',
	'help.bar.windows.title': 'Windows behind flags and buildings',
	'help.bar.flagWindow': 'Special-click a flag: the merchandise waiting there, and the geologist’s head at the bottom — click it to send a geologist to this flag.',
	'help.bar.siteWindow': 'Special-click a construction site: which building is being built there.',
	'help.eco.materials.title': 'Construction materials',
	'help.eco.wood': 'The lumberjack cuts trees, the sawmill worker turns the tree trunks into wood. A forest ranger plants new trees — without him the forest is soon gone.',
	'help.eco.stone': 'The quarryman breaks stones out of the granite boulders. Large buildings need stones, almost all buildings need wood.',
	'help.eco.food.title': 'Food',
	'help.eco.fish': 'The simplest food. A fisherman needs a lake nearby, and too many fishermen empty it.',
	'help.eco.bread': 'Wheat, flour, bread: the farm needs a lot of free land, but bread pays best.',
	'help.eco.meat': 'The pig farmer feeds the farmer’s wheat to his pigs, the butcher makes meat. Needs less land than bread.',
	'help.eco.mining.title': 'Mines and foundries',
	'help.eco.geologist': 'Place a flag in the mountains, connect it and special-click it: the geologist goes there and plants signs — yellow gold, red iron, black coal, grey granite; a large circle means a lot.',
	'help.eco.mines': 'The mines bring up granite, coal, iron ore and gold ore — as long as their miners get food.',
	'help.eco.smelters': 'The iron foundry makes iron from iron ore and coal, the gold foundry makes gold from gold ore and coal.',
	'help.eco.tools.title': 'Tools, weapons, boats',
	'help.eco.toolmaker': 'The tool maker makes tools from wood and iron. Every new profession needs its tool — which one, the next section says.',
	'help.eco.weapons': 'The blacksmith makes a sword and a shield from iron and coal — together they make a new knight.',
	'help.eco.boats': 'The ship maker builds boats from wood. You only need them for water ways.',
	'help.eco.prof.title': 'Which profession needs which tool',
	'help.eco.prof.intro': 'A new worker is an unemployed settler who picks up his tool in a warehouse. Some professions need two — both have to be in the same warehouse. If a tool is missing, the building stays empty.',
	'help.eco.prof.none': 'These professions need no tool at all.',
	'help.eco.prof.menu': 'In the tools menu you set how often the tool maker makes each tool. A slider at zero means that tool is never made — if you lack pliers for a new blacksmith, push their slider up, and remember to turn it back later.',
	'help.eco.military.title': 'Manning the military buildings',
	'help.eco.buildings': 'A guard hut holds up to three knights, a guard tower six, a garrison twelve. Once the first knight moves in, your land grows.',
	'help.eco.gold': 'Morale comes from your gold: how much of it lies in your castle, warehouses and military buildings, compared with all the gold on the map. Gold being carried does not count. A guard hut takes little gold, a guard tower more, a garrison the most.',
	'help.eco.stock.title': 'Castle and warehouse',
	'help.eco.warehouse': 'The castle is your first store; a warehouse is another one further out. Special-click them to see what lies there.',
	'help.eco.census': 'The serfs waiting in this store, by profession.',
	'help.eco.inventory': 'Three ticks each for goods and serfs: top — the store takes things in; middle — it takes nothing more but still delivers; bottom — it is emptied. What leaves first when emptying, you set in the evacuation menu.',
	'help.eco.stats.title': 'Statistics',
	'help.eco.stockStats': 'All goods together, in all your stores.',
	'help.eco.compare': 'Your land, buildings and military strength against your rivals — over half an hour up to fifty hours. Land counts your fields, buildings count by kind and size, military strength counts your knights by rank and morale; “all together” mixes the three.',
	'help.eco.victory': 'You have won when you hold three quarters of the land and three quarters of the military strength.',
	'help.eco.settlers.title': 'Serfs and new arrivals',
	'help.eco.settlers.birth': 'New serfs keep arriving in your castle and warehouses — in the store where the fewest idle serfs wait. A store that takes in no serfs gets none. How fast they come depends on the reproduction set at the start of the game.',
	'help.eco.settlers.limit': 'How many serfs you may have depends on your land: the larger your share of everybody’s land, the more.',
	'help.eco.settlers.knights': 'Some of the newcomers become knights at once, if a sword and a shield lie in the same store. How many, you set in the knight menu.',
	'help.eco.settlers.empty': 'A warehouse without idle serfs fetches one from a store that has plenty.',
	'help.eco.transport.title': 'Roads, transporters and how goods find their way',
	'help.eco.transport.carriers': 'Every road between two flags has its own transporter. If many goods wait at a long road, more transporters join; when they run out of work, they go back to the store.',
	'help.eco.transport.flag': 'A flag holds at most eight goods. When it is full, the worker waits at the door with his product — production stops. If the transporters cannot keep up, the flag window shows a line instead of a check mark, and goods take detours.',
	'help.eco.transport.route': 'Serfs and goods take the way with the fewest flags — the length of the roads does not count. A long road without a flag in the middle is therefore “shorter” than two short ones. The way is chosen anew at every flag.',
	'help.eco.transport.goal': 'A new good goes to the nearest building that needs it; one further away only gets it if it needs it much more urgently. If nobody needs it — and tools and boats always — it goes to the nearest store.',
	'help.eco.transport.water': 'Serfs only walk on land roads. Water ways carry goods only, rowed by a transporter with a boat. A construction site you can reach only across water never gets a builder.',
	'help.eco.transport.prio': 'Which waiting good a transporter takes first, you set in the merchandise priorities menu. It does not change the way.',
	'help.eco.transport.tip': 'Build plenty of cross connections, more like a grid than a star: then there are detours when a road jams. More flags on a road bring more transporters, but every flag counts when the way is chosen.',
	'help.eco.build.title': 'Building and the emergency program',
	'help.eco.build.steps': 'For a large building a digger first levels the ground, then the builder sets to work. Transporters bring wood and stones from the store. As long as no builder has arrived, a construction site is supplied only after the others.',
	'help.eco.build.emergency': 'At the start the castle keeps back a little wood and a few stones. If construction material runs out, the emergency program starts: only the lumberjack, sawmill and stonecutter are built on until they stand, then everything goes on as before.',
	'help.eco.dist.title': 'Distribution menus',
	'help.eco.dist.bar': 'In the distribution menus you share scarce goods: food among the mines, wood among construction sites, ship maker and tool maker, and likewise iron, coal and wheat (pig farm and mill). The longer the bar, the more a receiver matters to you. One that already has a lot, or has some on the way, becomes less urgent. At zero it gets nothing at all.',
	'help.eco.dist.scarce': 'When a good is scarce, the receiver with the longer bar gets it first. From a store a good is only sent to a receiver that needs it urgently enough — a very short bar lives almost only on fresh goods.',
	'help.eco.mines.empty': 'Miners without food go on strike. When the deposit around a mine runs out, you get a message — then a new mine elsewhere pays off.',
	'help.eco.knights.title': 'Recruiting and training knights',
	'help.eco.knights.recruit': 'A knight is a serf with a sword and a shield from the same store. New knights come three ways: some newcomers become knights at once, the recruit buttons of the knight menu turn idle serfs into knights right away, and if a military building lacks a knight, one is equipped when needed.',
	'help.eco.knights.train': 'Knights get better on their own, without gold — but by chance. Fastest in the castle and the warehouses, slower in a garrison and a guard tower, in a guard hut hardly at all. Every higher rank takes longer than the one before.',
	'help.eco.combat.title': 'Morale and fighting strength',
	'help.eco.combat.strength': 'In a fight rank counts most: every rank doubles a knight’s strength. The stronger knight wins more often, but nothing is certain.',
	'help.eco.combat.defend': 'On their own land knights always fight at full strength. When attacking, their strength depends on their morale.',
	'help.eco.combat.castle': 'If your people capture a castle, their morale rises for good; whoever loses his castle loses morale for good.',
	'help.eco.garrison.fill': 'How many knights a building should hold, you set in the knight menu separately for the border and the hinterland; the lower word says how far a building may be emptied for attacks. If one is missing, the strongest from the store comes; if there are too many, the weakest goes back.',
	'help.eco.garrison.castle': 'The castle keeps as many knights for its protection as you set. It swaps its strong knights for weaker ones from the store, so the strong ones can go to the border.',
	'help.eco.garrison.shift': 'The shift change brings the weak knights home from the buildings and replaces them with the strongest from the stores; it takes about a minute and a half.',
	'help.eco.garrison.attack': 'Only knights from military buildings near the target can attack — the castle never sends any. Whether the weaker or the stronger ones attack, you set in the knight menu.',
	'help.eco.land.title': 'Land and borders',
	'help.eco.land.claim': 'Every military building claims the same amount of land around it as soon as the first knight moves in. Where two borders meet, the stronger building wins: garrison before guard tower before guard hut, and nearness counts.',
	'help.eco.land.lost': 'If you lose land, your buildings on it burn down, roads and flags vanish.',
	'help.eco.land.capture': 'When an attacker captures a military building, the buildings around it burn down — his own too. A captured castle burns down.',
	'help.devices.title': 'Play on several devices',
	'help.devices.idea': 'Give webserf a folder for your saved games and let a sync app (Syncthing, Nextcloud, Dropbox …) keep that folder the same everywhere. Then you stop on your PC and carry on on your tablet.',
	'help.devices.step1': '1. On every device, load your archive once. It stays in that browser; the folder only carries the saved games.',
	'help.devices.step2': '2. Open Import & export → Saved games → Choose a save folder, and pick the synced folder.',
	'help.devices.step3': '3. Save as usual. The game writes ARCHIV.DS and SAVE0..9.DS into the folder.',
	'help.devices.step4': '4. On the other device, let the sync app finish, then open LOAD. The list is read from the folder every time.',
	'help.devices.know.title': 'Good to know',
	'help.devices.newer': 'For each slot the newer saved game wins. Play on one device at a time, and keep the clocks of both devices right.',
	'help.devices.browsers': 'You need Chrome or Edge, on Android too. Firefox and Safari have no folder access — there you move saved games with the download and import buttons.',
	'help.devices.android': 'Android forgets the folder permission after a restart. A mark on the rail tells you; one tap renews it.',
	'help.devices.dosbox': 'They are the original’s own files: copy them into a DOSBox directory and the 1993 game loads them.',
	'help.enh.title': 'Enhancements',
	'help.enh.intro': 'Extras the original never had. Each one is off until you switch it on under Enhancements, and the rules of the game stay untouched.',
	'help.enh.stock': 'Stock overview: a panel over the map with your goods, your serfs and the supply gauges of your chains.',
	'help.enh.hacks': 'Hack “all underground riches”: every deposit shows the sign a geologist would plant — even where no geologist will ever look.',
	'help.enh.assist': 'Road assistant: pick two of your flags, and it builds the fastest road between them, with exactly the clicks you would make.',
	// The invisible field that holds the focus while the original asks for text, so that a phone
	// brings up its keyboard — see `views/TextEntryField.svelte`.
	'view.textEntry': 'Text entry'
} as const;

export type ShellKey = keyof typeof EN;

/** German. Informal address ("du"), the same easy tone as the English table. */
const DE: Record<ShellKey, string> = {
	'rail.aria': 'Werkzeuggruppen',
	'group.settings': 'Einstellungen',
	'group.io': 'Import & Export',
	'group.bug': 'Fehler melden',
	'group.record': 'Aufnehmen',
	'group.enhance': 'Verbesserungen',
	'group.info': 'Über webserf',
	'overlay.close': 'Schließen',
	'page.loading': 'Lädt…',
	'rail.recording': 'Aufnahme läuft',
	'rail.update': 'neue Version bereit',
	'rail.folder': 'Ordner braucht Erlaubnis',

	'drop.aria': 'Archiv-Datei hier ablegen',
	'drop.lead': 'Leg dein Spiel-Archiv hier ab — oder wähl eine Datei aus.',
	'drop.reading': 'Archiv wird gelesen…',
	'drop.choose': 'Archiv auswählen',
	'drop.what':
		'„Die Siedler“ von 1993 — im Browser. Dieselben Regeln, dieselbe Grafik, direkt aus den Dateien des Originals gelesen. Dein Archiv und deine Spielstände bleiben dabei bei dir, hochgeladen wird nichts.',
	'drop.need':
		'Es fehlt nur noch das Grafik-Archiv aus deiner eigenen Kopie — eine einzelne Datei aus einer Installation von 1993. Wir würden sie ja gern mitbringen, aber die Grafiken gehören ihrem Verlag, und Verlage verstehen da bekanntlich wenig Spaß.',
	'drop.buy': 'Noch zu kaufen:',
	'drop.buyLink': 'Die Siedler History Edition (Ubisoft)',
	'link.store': 'https://www.ubisoft.com/de-de/games/the-settlers-history-edition',
	'drop.search': 'Stöber in der alten Installation — oder lass eine Suchmaschine stöbern:',
	'drop.searchLink': 'nach „{terms}“ suchen',
	'assets.badType': 'Unerwarteter Dateityp: {file} — erwartet wird eine .PA-Datei.',
	'assets.unreadable': 'Archiv ist nicht lesbar: {why}',
	'assets.cacheFailed': 'Der Zwischenspeicher ließ sich nicht lesen: {why}',

	'io.tab.saves': 'Spielstände',
	'io.tab.assets': 'Archiv',

	'folder.title': 'Spielstand-Ordner',
	'folder.what':
		'Ein Ordner hält eine zweite Kopie als echte Dateien ARCHIV.DS / SAVE0..9.DS, im Gleichschritt mit diesem Browser — kopier sie in ein DOSBox-Verzeichnis, und das Original lädt sie.',
	'folder.unsupported':
		'Dieser Browser hat keinen Ordner-Zugriff, die Spielstände liegen also nur hier — zum Umziehen dienen die Knöpfe oben.',
	'folder.attached': 'Verknüpft:',
	'folder.detach': 'Ordner lösen',
	'folder.choose': 'Ordner auswählen',
	'folder.allow': 'Gemerkten Ordner wieder erlauben',
	'folder.renews':
		'Der Ordner ist gemerkt; die nächste Berührung fragt erneut nach seiner Erlaubnis. Manche Browser behalten sie über einen Neustart nicht.',

	'archive.title': 'Archiv',
	'archive.none': 'Kein Archiv geladen.',
	'archive.info': '{entries} Einträge, {palettes} Paletten, {language} Texte.',
	'archive.privacy':
		'Das Archiv bleibt in diesem Browser und wird nie hochgeladen. Wird es entfernt, erscheint wieder die Ablagefläche; die Spielstände bleiben unberührt.',
	'archive.remove': 'Archiv aus diesem Browser entfernen',
	'lang.de': 'deutsche',
	'lang.en': 'englische',

	'saves.unavailable': 'In diesem Browser gibt es keine Spielstand-Ablage.',
	'saves.empty': '—',
	'saves.download': 'Herunterladen',
	'saves.replace': 'Ersetzen…',
	'saves.delete': 'Löschen',
	'saves.confirm': 'Wirklich löschen?',
	'saves.import': 'Einlesen…',
	'saves.downloadAll': 'Alle herunterladen ({count})',
	'saves.importPackage': 'Paket einlesen…',
	'saves.footnote':
		'Eine einzelne SAVEn.DS ist die Datei, die das Original liest — in ein DOSBox-Verzeichnis kopieren und dort laden. Der Name des Stands steht nicht in der Datei, sondern in ARCHIV.DS; ein eingelesener Stand wird deshalb nach seinem Dateinamen benannt. Das Paket nimmt die Namen mit.',
	'saves.deleteLocal': 'Löschen betrifft nur diesen Browser.',
	'saves.deleteBoth': 'Löschen entfernt die Datei auch aus {folder}.',
	'saves.downloaded': '{file} heruntergeladen ({bytes} Bytes).',
	'saves.unreadableSlot': 'Platz {slot} ließ sich nicht lesen (Code {code}).',
	'saves.nothingSaved': 'Es ist noch nichts gespeichert.',
	'saves.packed': '{count} Stand/Stände in {file} gepackt.',
	'saves.deleted': 'Platz {slot} gelöscht.',
	'saves.deletedButFile':
		'Platz {slot} ist hier gelöscht, aber {file} liegt weiter im Ordner — beim nächsten Start kommt er zurück.',
	'saves.noneInPackage': 'In diesem Paket ist kein brauchbarer Spielstand.',
	'saves.writeFailed': 'Platz {slot} ließ sich nicht schreiben (Code {code}).',
	'saves.imported': 'Platz/Plätze {which} eingelesen.',
	'saves.madeUpNames': ' Das Paket hatte keine ARCHIV.DS, die Namen sind daher erfunden.',
	'saves.ignored': ' Übergangen: {list}.',
	'saves.notASave': '{file} ist kein Spielstand: {why}',
	'saves.importedInto': '{file} als „{name}“ auf Platz {slot} eingelesen.',

	'set.simulation': 'Simulation',
	'set.pause': 'Pause',
	'set.play': 'Weiter',
	'set.noGame': 'Es läuft kein Spiel.',
	'set.running': 'Läuft mit {tps} Ticks/s.',
	'set.held': 'Von einem offenen Bildschirm angehalten.',
	'set.paused': 'Angehalten.',
	'set.speed': 'Geschwindigkeit',
	'set.speedNote':
		'Es ändert sich nur, wie viele Logik-Ticks je Sekunde wirklicher Zeit laufen — gerechnet wird weiter in Ticks, ein Spiel bleibt also bei jeder Geschwindigkeit reproduzierbar.',
	'set.interface': 'Oberfläche',
	'set.size': 'Größe',
	'set.sizeNote':
		'Gilt für diese Shell — die Leiste und diese Fenster. Die Spielfläche behält ihre eigene Größe: sie folgt der Kontrollleiste, wie im Original. Die Seite selbst zoomt nicht, weil ein Pinch über der Karte „Karte zoomen“ bedeutet.',
	'set.rest': 'Alles andere',
	'set.restNote':
		'Klang, Musik und die Bedien-Optionen liegen auf dem Original-Bildschirm „EXTRA OPTION“ — erreichbar aus dem Hauptmenü und aus dem Spiel; dieser Browser merkt sich, was du dort einstellst.',
	'set.reset': 'Auf Vorgabewerte zurücksetzen',

	'bug.building': 'Wird gebaut…',
	'bug.build': 'Bericht erzeugen und Issue öffnen',
	'bug.filed':
		'Der Bericht liegt in deinem Download-Ordner, das Issue hat sich in einem neuen Tab geöffnet. Zieh die Datei dort hinein, bevor du abschickst — das Kästchen im Issue erinnert dich daran.',
	'bug.where': 'Berichte werden zu Issues in',
	'bug.intro':
		'Ein Bericht enthält den Spielzustand, die aufgezeichneten Aktionen, ein Bild und eine Zusammenfassung. Solange dieses Fenster offen ist, steht die Simulation — der Bericht beschreibt also, was du gesehen hast.',
	'bug.what': 'Was ist schiefgegangen?',
	'bug.placeholder': 'z. B. Träger liefern immer weiter Steine zu einer fertigen Hütte',
	'bug.needGame': 'Starte erst ein Spiel — ein Bericht braucht eine laufende Partie.',

	'info.about.title': 'Was das hier ist',
	'info.about.what':
		'webserf holt „Die Siedler“ (Blue Byte, 1993) in den Browser: Die Regeln stammen aus dem Original-Programm, die Grafik aus deiner eigenen Kopie des Spiels.',
	'info.about.assets':
		'Vom Original ist hier nichts dabei. Dein geladenes Archiv bleibt in deinem Browser, deine Spielstände auch — hochgeladen wird nichts.',
	'info.source.title': 'Quelltext',
	'info.source.note':
		'Offener Quelltext, und über Issues und Pull Requests freuen wir uns jederzeit. Fehlerberichte aus dem Bildschirm „Fehler melden“ landen an derselben Stelle.',
	'update.title': 'Neue Version',
	'update.ready':
		'Eine neuere Fassung ist geladen und liegt bereit. Wirksam wird sie nach einem Neustart — der beendet eine laufende Partie, weil der Spielstand nicht selbsttätig gesichert wird.',
	'update.switched':
		'Ein anderes Fenster ist schon auf eine neuere Fassung umgeschaltet. Diese hier läuft noch auf den alten Dateien; Teile davon können ausfallen, vor allem der Klang. Starte neu, wenn es dir passt.',
	'update.apply': 'Jetzt neu starten',
	'toast.update': 'Eine neue Version liegt bereit — mehr unter „Über webserf“.',
	'toast.dismiss': 'Ausblenden',
	'assets.loaded': '{file} geladen',
	'info.build.title': 'Programmstand',
	'info.build.unknown': 'Diese Fassung wurde ohne Stand-Angabe gebaut.',
	'info.build.modified': 'mit noch nicht eingecheckten Änderungen gebaut',
	'info.original.title': 'Das Original',
	'info.original.note': 'Gibt es noch zu kaufen — und das ist mit Abstand der sauberste Weg zu den Spieldateien:',
	'info.original.link': 'Die Siedler History Edition (Ubisoft)',
	'info.legal.title': 'Rechtliches',
	'info.legal.note':
		'„Die Siedler“ und alles darin gehören Blue Byte / Ubisoft. Dies hier ist ein unabhängiges Hobby-Projekt ohne jede Verbindung dorthin — entstanden aus Bewunderung und aus einer gewissen Unfähigkeit, 1993 loszulassen.',

	// -- Verbesserungen ------------------------------------------------------------------------
	'enh.stock.name': 'Lager-Übersicht',
	'enh.stock.tab.goods': 'Waren',
	'enh.stock.tab.serfs': 'Siedler',
	'enh.stock.tab.supply': 'Versorgung',
	'enh.stock.tab.view': 'Darstellung',
	'enh.stock.aria': 'Lager-Übersicht',	
	'enh.pick.all': 'Alle',
	'enh.pick.none': 'Keine',
	'enh.pick.count': '{on} von {all} ausgewählt',
	'enh.pick.noIcons': 'Lade ein Archiv, um die Bilder zu sehen.',
	'enh.stock.hideUnusedNote':
		'Zeilen, die gerade nichts sagen, bleiben weg. Ist alles ausgeblendet, bleibt die Anzeige leer ' +
		'und verschwindet.',
	'enh.stock.goods.title': 'Welche Waren',
	'enh.stock.goods.note':
		'Gezählt über alle deine Lager, dazu die Bau-Reserve, die das Schloss bei der Gründung ' +
		'zurücklegt — dieselbe Summe, die auch die Lager-Statistik zeigt.',
	'enh.stock.goods.hideUnused': 'Waren ohne Bestand ausblenden',
	'enh.stock.serfs.title': 'Welche Siedler',
	'enh.stock.serfs.mode': 'Gezählt wird',
	'enh.stock.serfs.modeIdle': 'Wer im Lager ruht',
	'enh.stock.serfs.modeAvailable': 'Wer daraus werden könnte',
	'enh.stock.serfs.modeNote':
		'„Wer daraus werden könnte“ rechnet die freien Siedler jedem Beruf zu, dessen Werkzeug im Lager ' +
		'liegt. Ein Siedler zählt damit in mehreren Zeilen — gefragt ist „wie viele davon könnte ich ' +
		'haben“, nicht „wie würden sie sich aufteilen“.',	
	'enh.stock.serfs.hideUnused': 'Berufe ohne Siedler ausblenden',
	'enh.stock.supply.title': 'Welche Zeiger',
	'enh.stock.supply.note':
		'Dieselben Zeiger wie in der Nahrungs- und der Warenkette. Beim Verbraucher gilt: je voller, ' +
		'desto besser. Beim Verarbeiter ist die Mitte ideal — leer heißt, er hat nichts zu tun, voll ' +
		'heißt, er kommt nicht nach.',
	'enh.stock.supply.hideUnused': 'Zeiger ohne Gebäude ausblenden',
	'enh.stock.supply.hideUnusedNote':
		'Ein Zeiger, dessen Gebäude du nicht hast, misst nichts.',
	'enh.stock.supply.food': 'Nahrung',
	'enh.stock.supply.mineGold': 'Goldmine',
	'enh.stock.supply.mineCoal': 'Kohlemine',
	'enh.stock.supply.mineIron': 'Eisenmine',
	'enh.stock.supply.mineStone': 'Steinmine',
	'enh.stock.supply.smelterGold': 'Goldschmelze',
	'enh.stock.supply.smelterSteel': 'Stahlschmelze',
	'enh.stock.supply.military': 'Militärgebäude',
	'enh.stock.supply.sites': 'Baustellen',
	'enh.stock.view.perRow': 'Einträge je Zeile',
	'enh.stock.view.perRowNote':
		'Eins ergibt eine schmale Säule, zwölf einen breiten Streifen. Ein Versorgungs-Zeiger ist anderthalb Einträge breit.',
	'enh.place.corner': 'Position',
	'enh.place.opacity': 'Deckkraft',
	'enh.corner.tl': 'Oben links',
	'enh.corner.tr': 'Oben rechts',
	'enh.corner.bl': 'Unten links',
	'enh.corner.br': 'Unten rechts',
	'enh.hacks.name': 'Hacks',
	'enh.hacks.tab.list': 'Hacks',
	'enh.hacks.tab.view': 'Darstellung',
	'enh.hacks.title': 'Anzeigen',
	'enh.hacks.note':
		'Nutze sie über das Overlay',
	'enh.hacks.minerals': 'Alle Bodenschätze',
	'enh.hacks.minerals.note':
		'Das Schild, das ein Geologe aufstellen würde',
	'enh.assist.name': 'Assistenten',
	'enh.assist.tab.list': 'Assistenten',
	'enh.assist.tab.view': 'Darstellung',
	'enh.assist.title': 'Anzeigen',
	'enh.assist.note':
		'Nutze sie über das Overlay. Sie bauen nur mit den Klicks, die du auch selbst machen würdest.',
	'enh.assist.road': 'Wegebau-Assistent',
	'enh.assist.road.note': 'Der schnellste Weg zwischen zwei deiner Fahnen, gebaut beim Klick auf das Ziel',
	'enh.assist.road.plan': 'Wegebau',
	'enh.assist.road.cancel': 'Abbrechen',
	'enh.assist.road.pickStart': 'Startfahne anklicken',
	'enh.assist.road.pickTarget': 'Zielfahne anklicken',
	'enh.assist.road.summary': '{steps} Schritte · {time} s hin und zurück',
	'enh.assist.road.notOwnFlag': 'Das ist keine deiner Fahnen.',
	'enh.assist.road.sameFlag': 'Start und Ziel sind dieselbe Fahne.',
	'enh.assist.road.noRoute':
		'Kein Weg möglich — er kann keine Wege, kein Wasser und kein fremdes Land kreuzen.',
	'enh.assist.road.busy': 'Beende oder brich zuerst den Wegebau ab, der gerade läuft.',
	'enh.assist.road.failed': 'Der Weg ließ sich nicht bauen.',
	'enh.assist.road.built': 'Weg gebaut: {steps} Schritte · {time} s hin und zurück',
	'record.stillTitle': 'Bildschirmfoto',
	'record.stillNote':
		'Aufgenommen, als dieses Fenster aufging — Karte, Bedienleiste und ein offenes Fenster, so wie sie gezeichnet waren.',
	'record.stillNone': 'Kein Bild — der Spielbildschirm gab keines her.',
	'record.download': 'Bild herunterladen ({size})',
	'record.videoTitle': 'Video',
	'record.intro':
		'Nimmt den Spielbildschirm als Video auf — Karte, Bedienleiste, Fenster und Mauszeiger, genau ' +
		'so, wie sie gezeichnet werden. Die Aufnahme folgt dem Spiel: solange die Simulation ' +
		'angehalten ist, entstehen keine Bilder.',
	'record.toFile': 'Du wählst zuerst eine Datei; das Video wird während der Aufnahme hineingeschrieben.',
	'record.toMemory':
		'Dieser Browser kann während der Aufnahme nicht schreiben, das Video liegt darum im Speicher ' +
		'und kommt am Ende als Download. Halte es kurz.',
	'record.unsupported': 'Dieser Browser kann keinen Canvas aufnehmen.',
	'record.start': 'Aufnahme starten',
	'record.stop': 'Aufnahme beenden',
	'record.started': 'Aufnahme läuft',
	'record.stopped': 'Aufnahme beendet: {frames} Bilder, {size}',
	'record.progress': 'Aufnahme läuft — {frames} Bilder, etwa {seconds} s',
	'record.needGame': 'Starte zuerst ein Spiel — es gibt noch nichts aufzunehmen.',
	'record.quality': 'Qualität',
	'record.qualityStandard': 'Standard',
	'record.qualityHigh': 'Hoch',
	'record.qualityNote':
		'Hoch hält die Farben der Pixelgrafik sauber: das Video bekommt mindestens zwei Pixel je Spielpixel. Größere Dateien und mehr Arbeit für den Rechner während der Aufnahme.',
	'record.done': '{name} — {frames} Bilder, {size}.',
	'view.map':
		'Kartenansicht (links: Zeiger setzen, links ziehen: Ansicht nachziehen, rechts halten: Ansicht schieben wie im Original, mittlere Taste halten: greifen und ziehen, rechts+links oder Umschalt/Alt+links oder langes Drücken: Spezialklick, Rad oder Zwei-Finger: Lupe)',
	'view.buildMenu': 'Bau-Menü',
	'view.soil': 'Bodenproben',
	'view.message': 'Mitteilung',
	'view.endCredits': 'Abspann',
	'view.missionEnd': 'Missions-Ende',
	'view.object': 'Objekt-Fenster',
	'view.overview': 'Übersichtskarte',
	'view.controlPanel': 'Bedienleiste',
	// -- Help -----------------------------------------------------------------------------------
	'group.help': 'Hilfe',
	'help.tab.start': 'Erste Schritte',
	'help.tab.controls': 'Steuerung',
	'help.tab.bar': 'Das Menu',
	'help.tab.economy': 'Wirtschaft',
	'help.tab.devices': 'Mehrere Geräte',
	'help.tab.enhance': 'Verbesserungen',
	'help.search.label': 'Hilfe durchsuchen',
	'help.search.placeholder': 'Suchen, z. B. Sägewerk, Geologe, Spezialklick',
	'help.search.none': 'Nichts gefunden für „{query}“.',
	'help.search.count': '{count} Treffer',
	'help.contents': 'Auf dieser Seite',
	'help.table.action': 'Was',
	'help.table.mouse': 'Maus',
	'help.table.touch': 'Touch',
	'help.table.profession': 'Beruf',
	'help.table.tools': 'Werkzeug',
	'help.context': 'Das ist das Fenster, das gerade im Spiel offen ist.',
	'help.start.idea.title': 'Die Idee',
	'help.start.idea': 'Du steuerst deine Siedler nicht direkt. Du bestimmst, was wo gebaut wird, verbindest alles mit Wegen — und die Siedler tragen, bauen und arbeiten von selbst. Wachse schneller und geschickter als deine Gegner: gewonnen hast du, sobald dir drei Viertel des Landes und der Kampfstärke gehören.',
	'help.start.steps.title': 'Deine ersten Schritte',
	'help.start.step1': '1. Starte ein Spiel. Wähl im Hauptmenü die erste Stufe (ihr Passwort ist START) und drück START. Auch die Trainingsspiele aus dem Original-Handbuch sind ein guter Einstieg.',
	'help.start.step2': '2. Setz dein Schloß auf ebenes Grasland mit Bäumen und Granit in der Nähe. Unsicher, wo es passt? Spezialklick auf das linke Symbol im Menu: die Bau-Hilfsfunktion zeigt alle Plätze, auf die ein Schloß passt. Dann drück „Schloß bauen“.',
	'help.start.step3': '3. Bau innerhalb deiner Grenze (die weiß/schwarzen Pfosten). Wähl eine Stelle: das Symbol in der Mitte des Zeigers — und links unten im Menu — zeigt dir, was dort passt: eine Fahne, eine Hütte, ein großes Gebäude oder eine Mine. Drück es und such dir im Fenster etwas aus.',
	'help.start.step4': '4. Schließ jede Baustelle mit Wegen an. Vor jedem Gebäude steht eine Fahne; wähl eine Fahne, drück das Wegebau-Symbol und leg den Weg Stück für Stück bis zu einer anderen Fahne. Grün ist eben, rot ist steil — steile Wege sind langsam. Ein Gebäude ohne Weg bekommt nichts.',
	'help.start.step5': '5. Zuerst Holz und Stein: eine Holzfällerhütte mit einer Forsthütte daneben, einen Steinbruch am Granit und ein Sägewerk. Alle anderen Gebäude bestehen aus Holz und Steinen.',
	'help.start.step6': '6. Wachse: eine Wachhütte, ein Wachturm oder eine Wachburg schiebt deine Grenze hinaus, sobald der erste Ritter einzieht.',
	'help.start.step7': '7. Dann die langen Ketten: Fisch, Fleisch und Brot ernähren die Bergleute, ein Geologe findet die Bodenschätze im Gebirge, und Gold hebt den Mut deiner Ritter.',
	'help.start.tips.title': 'Tips',
	'help.start.tip.grid': 'Bau deine Wege wie ein Gitter auf Karopapier, nicht als Stern ums Schloß — sonst läuft jede Ware am Schloß vorbei.',
	'help.start.tip.close': 'Stell Gebäude, die zusammenarbeiten, nah zusammen: das Sägewerk neben die Holzfällerhütte, die Mühle neben die Farm.',
	'help.start.tip.manual': 'Das Handbuch von 1993 erklärt jedes Gebäude und jedes Menu, wenn du tiefer einsteigen willst.',
	'help.controls.title': 'Maus und Touch',
	'help.controls.pick': 'Zeiger setzen, Symbol drücken',
	'help.controls.pick.mouse': 'Linksklick',
	'help.controls.pick.touch': 'Tippen',
	'help.controls.move': 'Bildausschnitt verschieben',
	'help.controls.move.mouse': 'links ziehen, rechte Taste halten (wie im Original) oder mit der mittleren Taste greifen',
	'help.controls.move.touch': 'mit einem Finger ziehen',
	'help.controls.zoom': 'Zoomen',
	'help.controls.zoom.mouse': 'Mausrad oder Touchpad',
	'help.controls.zoom.touch': 'mit zwei Fingern spreizen',
	'help.controls.special': 'Spezialklick',
	'help.controls.special.mouse': 'rechte Taste halten und links klicken, oder Umschalt/Alt + Linksklick',
	'help.controls.special.touch': 'eine halbe Sekunde lang drücken',
	'help.controls.pause': 'Pause und Tempo',
	'help.controls.pause.mouse': 'Einstellungen in der Leiste links',
	'help.controls.pause.touch': 'Einstellungen in der Leiste links',
	'help.controls.special.title': 'Der Spezialklick',
	'help.controls.special.what': 'Der Spezialklick öffnet die Fenster hinter einer Fahne oder einem Gebäude, schaltet die Bau-Hilfsfunktion ein, schickt den Geologen los und reißt ab. Abreißen geht nur mit ihm — so brennt nichts aus Versehen ab.',
	'help.rail.title': 'Die Leiste links',
	'help.rail.intro': 'Alles, was das Original nicht hatte, liegt in der Leiste am linken Rand, als Fenster über dem Spiel.',
	'help.rail.settings': 'Einstellungen: Spieltempo, Pause und die Größe dieser Fenster.',
	'help.rail.io': 'Import & Export: deine zehn Spielstände, ein Ordner, in den sie gespiegelt werden, und das Archiv.',
	'help.rail.bug': 'Fehler melden: packt Spielstand, die letzten Aktionen und ein Bild für ein Issue zusammen.',
	'help.rail.record':
		'Aufnehmen: ein Bildschirmfoto vom Spiel oder ein Video mit Mauszeiger — in hoher Qualität bleiben die Farben der Pixelgrafik sauber.',
	'help.rail.enhance': 'Verbesserungen: Extras, die das Original nie hatte, jedes aus, bis du es einschaltest.',
	'help.rail.info': 'Über webserf: was das hier ist, der Programmstand und eine neue Version, wenn eine bereitliegt.',
	'help.rail.help': 'Hilfe: dieses Fenster. Es ist da, sobald ein Archiv geladen ist.',
	'help.bar.build.title': 'Bauen',
	'help.bar.flag': 'Fahne setzen. Fahnen sind die Kreuzungen deiner Wege; an jeder können sechs Wege beginnen.',
	'help.bar.mine': 'Bergmine bauen — nur im Gebirge, nicht im Schnee.',
	'help.bar.hut': 'Hütte bauen: die kleinen Gebäude.',
	'help.bar.large': 'Großes Gebäude bauen. Mit dem „Umblättern“-Symbol siehst du alle; große Gebäude brauchen ebenen Boden, darum kommt zuerst ein Planierer.',
	'help.bar.large2': 'Die letzte Seite der großen Gebäude.',
	'help.bar.castle': 'Schloß bauen — nur ganz am Anfang. Es ist das einzige Gebäude, das du geschenkt bekommst.',
	'help.bar.help': 'Spezialklick auf das linke Symbol, egal was es gerade zeigt: die Bau-Hilfsfunktion markiert jede Stelle im Bild, auf der du bauen kannst. Ein zweiter Spezialklick schaltet sie wieder aus.',
	'help.bar.roads.title': 'Wege, Abriß, Geologe',
	'help.bar.road': 'Wegebau: beginnt an der gewählten Fahne. Jeder Klick setzt ein Stück, bis der Weg eine andere Fahne erreicht.',
	'help.bar.demolishRoad': 'Weg abreißen — wähl einen Weg, dann Spezialklick auf dieses Symbol. Seine Träger gehen zurück ins Schloß.',
	'help.bar.demolish': 'Die Ruine: wähl ein Gebäude oder eine Fahne, dann Spezialklick auf die Ruine, um es abzubrennen. Ein Fenster fragt nach.',
	'help.bar.geologist': 'Bodenproben: bevor dein Schloß steht, zeigt es die Bodenschätze rund um den Zeiger.',
	'help.bar.markers.title': 'Der Zeiger',
	'help.bar.markers': 'Das Symbol in der Mitte des Zeigers zeigt, was du dort bauen kannst: zwei Pfeile — nichts; eine Fahne; eine Hütte; ein großes Gebäude (das Burg-Symbol); eine Mine.',
	'help.bar.menus.title': 'Landkarte, Statistiken, Verteilung',
	'help.bar.map': 'Die Landkarte. Ein Linksklick in die Karte verschiebt den Bildausschnitt dorthin; ein Spezialklick auf das Kartensymbol springt zurück zu deinem Schloß.',
	'help.bar.stats': 'Die Statistiken: Lagerbestand, Gebäude, Siedler, Produktion und der Vergleich mit deinen Gegnern.',
	'help.bar.settings': 'Die Verteilungsmenus: wer zuerst Nahrung, Holz, Eisen, Kohle und Korn bekommt, welche Werkzeuge gemacht werden, die Ritter — und unten SICHERN, ENDE und die Extra-Optionen.',
	'help.bar.options': 'Extra-Optionen: Wegebau-Scrolling, schneller Kartenklick, schneller Bauklick, wie viele Mitteilungen du bekommst, Musik, Klangeffekte und Lautstärke — getrennt für die linke und rechte Seite.',
	'help.bar.messages.title': 'Mitteilungen',
	'help.bar.message': 'Ein blinkendes Blatt Papier links unten im Menu: es ist etwas passiert. Klick darauf, dann erscheint die Mitteilung und der Bildausschnitt springt an die Stelle.',
	'help.bar.return': 'Der Pfeil bringt dich dahin zurück, wo du vor der Mitteilung warst.',
	'help.bar.windows.title': 'Fenster hinter Fahnen und Gebäuden',
	'help.bar.flagWindow': 'Spezialklick auf eine Fahne: die Waren, die dort warten, und unten der Geologenkopf — ein Klick darauf schickt einen Geologen zu dieser Fahne.',
	'help.bar.siteWindow': 'Spezialklick auf eine Baustelle: welches Gebäude dort entsteht.',
	'help.eco.materials.title': 'Baumaterial',
	'help.eco.wood': 'Der Holzfäller fällt Bäume, der Schreiner im Sägewerk macht aus den Baumstämmen Bauholz. Ein Förster pflanzt neue Bäume — ohne ihn ist der Wald bald weg.',
	'help.eco.stone': 'Der Steinmetz schlägt Bausteine aus den Granitfelsen. Große Gebäude brauchen Steine, fast alle Gebäude brauchen Holz.',
	'help.eco.food.title': 'Nahrungsmittel',
	'help.eco.fish': 'Das einfachste Nahrungsmittel. Ein Fischer braucht einen See in der Nähe, und zu viele Fischer fischen ihn leer.',
	'help.eco.bread': 'Korn, Mehl, Brot: die Farm braucht viel freies Land, aber Brot bringt am meisten.',
	'help.eco.meat': 'Der Schweinebauer füttert seine Schweine mit dem Korn der Farm, der Schlachter macht Schinken daraus. Braucht weniger Land als Brot.',
	'help.eco.mining.title': 'Minen und Schmelzen',
	'help.eco.geologist': 'Setz eine Fahne ins Gebirge, schließ sie an und gib ihr einen Spezialklick: der Geologe geht hin und steckt Schilder — gelb Gold, rot Eisen, schwarz Kohle, grau Granit; ein großer Kreis heißt viel.',
	'help.eco.mines': 'Die Minen fördern Granit, Kohle, Eisenerz und Golderz — solange ihre Bergleute zu essen haben.',
	'help.eco.smelters': 'Die Eisenschmelze macht aus Eisenerz und Kohle Roheisen, das Goldschmelzhaus aus Golderz und Kohle Goldbarren.',
	'help.eco.tools.title': 'Werkzeuge, Waffen, Boote',
	'help.eco.toolmaker': 'Der Schlosser macht aus Bauholz und Roheisen Werkzeuge. Jeder neue Beruf braucht sein Werkzeug — welches, steht im nächsten Abschnitt.',
	'help.eco.weapons': 'Der Schmied macht aus Roheisen und Kohle Schwert und Schild — zusammen ergeben sie einen neuen Ritter.',
	'help.eco.boats': 'Die Bootswerft baut aus Bauholz Ruderboote. Die brauchst du nur für Wasserwege.',
	'help.eco.prof.title': 'Welcher Beruf welches Werkzeug braucht',
	'help.eco.prof.intro': 'Ein neuer Arbeiter ist ein arbeitsloser Siedler, der sich im Lager sein Werkzeug holt. Manche Berufe brauchen zwei — beide müssen im selben Lager liegen. Fehlt eines, bleibt das Gebäude leer.',
	'help.eco.prof.none': 'Diese Berufe brauchen gar kein Werkzeug.',
	'help.eco.prof.menu': 'Im Werkzeug-Menu legst du fest, wie oft der Schlosser welches Werkzeug herstellt. Steht ein Balken auf null, wird dieses Werkzeug nie gemacht — fehlt dir eine Zange für den neuen Schmied, zieh ihren Balken hoch und stell ihn später wieder zurück.',
	'help.eco.military.title': 'Besetzung der Militärgebäude',
	'help.eco.buildings': 'Eine Wachhütte fasst bis zu drei Ritter, ein Wachturm sechs, eine Wachburg zwölf. Sobald der erste Ritter einzieht, wächst dein Land.',
	'help.eco.gold': 'Den Mut bestimmt dein Gold: wie viele Goldbarren in Schloß, Lagern und Militärgebäuden liegen, verglichen mit allem Gold der Karte. Gold, das gerade getragen wird, zählt nicht. Eine Wachhütte nimmt wenig Gold auf, ein Wachturm mehr, eine Wachburg am meisten.',
	'help.eco.stock.title': 'Schloß und Lager',
	'help.eco.warehouse': 'Das Schloß ist dein erstes Lager; ein Lager ist ein weiteres, weiter draußen. Ein Spezialklick zeigt, was darin liegt.',
	'help.eco.census': 'Die Siedler, die in diesem Lager warten, nach Beruf.',
	'help.eco.inventory': 'Je drei Haken für Waren und Siedler: oben wird eingelagert, in der Mitte nimmt das Lager nichts mehr an, liefert aber weiter aus, unten wird es geräumt. Was beim Räumen zuerst hinausgeht, legst du im Warenfluchtmenu fest.',
	'help.eco.stats.title': 'Statistiken',
	'help.eco.stockStats': 'Alle Waren zusammen, in all deinen Lagern.',
	'help.eco.compare': 'Dein Landbesitz, deine Gebäude und deine Kampfstärke gegen die Gegner — über eine halbe Stunde bis fünfzig Stunden. Landbesitz zählt deine Felder, Gebäude zählen nach Art und Größe, die Kampfstärke deine Ritter nach Rang und Mut; „alles zusammen“ mischt die drei.',
	'help.eco.victory': 'Gewonnen hast du, wenn du drei Viertel des Landes und drei Viertel der Kampfstärke hältst.',
	'help.eco.settlers.title': 'Siedler und Nachwuchs',
	'help.eco.settlers.birth': 'Neue Siedler kommen regelmäßig im Schloß und in den Lagern an — in dem Lager, in dem die wenigsten untätigen warten. Ein Lager, das keine Siedler aufnimmt, bekommt keine. Wie schnell sie kommen, hängt von der Fortpflanzung ab, die beim Spielstart eingestellt ist.',
	'help.eco.settlers.limit': 'Wie viele Siedler du haben darfst, hängt an deinem Land: je größer dein Anteil am Land aller Spieler, desto mehr.',
	'help.eco.settlers.knights': 'Ein Teil der Neuen wird gleich Ritter, wenn Schwert und Schild im selben Lager liegen. Wie viele, stellst du im Ritter-Menu ein.',
	'help.eco.settlers.empty': 'Ein Lager ohne untätige Siedler holt sich einen aus einem Lager, das genug hat.',
	'help.eco.transport.title': 'Wege, Träger und wie Waren ihren Weg finden',
	'help.eco.transport.carriers': 'Jeder Weg zwischen zwei Fahnen hat seinen eigenen Träger. Warten an einem langen Weg viele Waren, kommen weitere Träger dazu; haben sie nichts mehr zu tun, gehen sie zurück ins Lager.',
	'help.eco.transport.flag': 'An einer Fahne haben höchstens acht Waren Platz. Ist sie voll, wartet der Arbeiter mit seiner Ware vor der Tür — die Produktion steht. Kommen die Träger nicht hinterher, zeigt das Fahnen-Fenster einen Strich statt eines Hakens, und die Waren nehmen Umwege.',
	'help.eco.transport.route': 'Siedler und Waren nehmen den Weg mit den wenigsten Fahnen — die Länge der Wege zählt nicht. Ein langer Weg ohne Fahne in der Mitte ist also „kürzer“ als zwei kurze. Entschieden wird an jeder Fahne neu.',
	'help.eco.transport.goal': 'Eine neue Ware geht zum nächsten Gebäude, das sie braucht; ein weiter entferntes bekommt sie nur, wenn es sie deutlich dringender braucht. Braucht sie niemand — und Werkzeuge und Boote immer —, kommt sie ins nächste Lager.',
	'help.eco.transport.water': 'Siedler gehen nur über Landwege. Wasserwege tragen nur Waren, gerudert von einem Träger mit Boot. Eine Baustelle, die du nur über Wasser erreichst, bekommt nie einen Bauarbeiter.',
	'help.eco.transport.prio': 'Welche wartende Ware ein Träger zuerst mitnimmt, legst du bei den Warenprioritäten fest. Den Weg ändern sie nicht.',
	'help.eco.transport.tip': 'Bau viele Querverbindungen, eher ein Gitter als einen Stern: dann gibt es bei Stau Umwege. Mehr Fahnen auf einem Weg bringen mehr Träger, aber jede Fahne zählt bei der Wegwahl.',
	'help.eco.build.title': 'Bauen und das Notprogramm',
	'help.eco.build.steps': 'Für ein großes Gebäude ebnet zuerst ein Planierer den Platz, dann baut der Bauarbeiter. Bauholz und Steine bringen die Träger aus dem Lager. Solange noch kein Bauarbeiter da ist, wird eine Baustelle erst nach den anderen beliefert.',
	'help.eco.build.emergency': 'Am Anfang hält das Schloß etwas Bauholz und ein paar Steine zurück. Geht das Baumaterial aus, wird das Notprogramm eingeleitet: nur Holzfäller, Sägewerk und Steinmetz werden weitergebaut, bis sie stehen, danach geht alles weiter wie vorher.',
	'help.eco.dist.title': 'Verteilungsmenus',
	'help.eco.dist.bar': 'In den Verteilungsmenus teilst du knappe Waren auf: Nahrung auf die Minen, Bauholz auf Baustellen, Bootswerft und Schlosser, ebenso Roheisen, Kohle und Korn (Schweinezucht und Mühle). Je länger der Balken, desto wichtiger ist dir ein Abnehmer. Wer schon viel hat oder Ware unterwegs hat, wird weniger dringend. Auf null bekommt er gar nichts.',
	'help.eco.dist.scarce': 'Ist eine Ware knapp, bekommt sie der Abnehmer mit dem längeren Balken zuerst. Aus dem Lager wird nur an einen Abnehmer geliefert, der sie dringend genug braucht — ein sehr kurzer Balken lebt fast nur von frischer Ware.',
	'help.eco.mines.empty': 'Bergleute ohne Nahrung streiken. Ist das Vorkommen um eine Mine erschöpft, bekommst du eine Meldung — dann lohnt eine neue Mine an anderer Stelle.',
	'help.eco.knights.title': 'Ritter anwerben und ausbilden',
	'help.eco.knights.recruit': 'Ein Ritter ist ein Siedler mit Schwert und Schild aus demselben Lager. Neue Ritter entstehen auf drei Wegen: ein Teil der Neuen wird gleich Ritter, mit den Anwerbe-Knöpfen im Ritter-Menu machst du untätige Siedler sofort zu Rittern, und fehlt einem Militärgebäude ein Ritter, wird bei Bedarf einer ausgerüstet.',
	'help.eco.knights.train': 'Ritter werden von selbst besser, ganz ohne Gold — aber nach Zufall. Am schnellsten im Schloß und in den Lagern, langsamer in Wachburg und Wachturm, in der Wachhütte fast gar nicht. Jeder höhere Rang dauert länger als der vorige.',
	'help.eco.combat.title': 'Mut und Kampfstärke',
	'help.eco.combat.strength': 'Im Kampf zählt vor allem der Rang: jeder Rang verdoppelt die Stärke eines Ritters. Der Stärkere gewinnt öfter, sicher ist aber nichts.',
	'help.eco.combat.defend': 'Auf eigenem Land kämpfen Ritter immer mit voller Kraft. Beim Angriff hängt ihre Kraft am Mut.',
	'help.eco.combat.castle': 'Erobert dein Volk ein Schloß, steigt sein Mut dauerhaft; wer sein Schloß verliert, verliert dauerhaft Mut.',
	'help.eco.garrison.fill': 'Wie viele Ritter in einem Gebäude sitzen sollen, stellst du im Ritter-Menu getrennt für Grenze und Hinterland ein; das untere Wort sagt, wie weit ein Gebäude für Angriffe geleert werden darf. Fehlt einer, kommt der stärkste aus dem Lager; sitzen zu viele drin, geht der schwächste zurück.',
	'help.eco.garrison.castle': 'Im Schloß bleiben so viele Ritter zum Schutz, wie du einstellst. Es tauscht seine starken gegen schwächere aus dem Lager, damit die Starken an die Grenze können.',
	'help.eco.garrison.shift': 'Der Schichtwechsel holt die schwachen Ritter aus den Gebäuden und ersetzt sie durch die stärksten aus den Lagern; das dauert etwa anderthalb Minuten.',
	'help.eco.garrison.attack': 'Angreifen können nur Ritter aus Militärgebäuden in der Nähe des Ziels — das Schloß schickt nie welche. Ob die schwächeren oder die stärkeren angreifen, stellst du im Ritter-Menu ein.',
	'help.eco.land.title': 'Land und Grenzen',
	'help.eco.land.claim': 'Jedes Militärgebäude beansprucht rundum gleich viel Land, sobald der erste Ritter einzieht. Wo zwei Grenzen aufeinandertreffen, setzt sich das stärkere Gebäude durch: Wachburg vor Wachturm vor Wachhütte, und Nähe zählt.',
	'help.eco.land.lost': 'Verlierst du Land, brennen deine Gebäude darauf nieder, Wege und Fahnen verschwinden.',
	'help.eco.land.capture': 'Erobert ein Angreifer ein Militärgebäude, brennen die Gebäude rundherum ab — auch seine eigenen. Ein erobertes Schloß brennt nieder.',
	'help.devices.title': 'Auf mehreren Geräten spielen',
	'help.devices.idea': 'Gib webserf einen Ordner für deine Spielstände und lass eine Sync-App (Syncthing, Nextcloud, Dropbox …) diesen Ordner überall gleich halten. Dann hörst du am PC auf und spielst am Tablet weiter.',
	'help.devices.step1': '1. Lade auf jedem Gerät einmal dein Archiv. Es bleibt in diesem Browser; der Ordner trägt nur die Spielstände.',
	'help.devices.step2': '2. Öffne Import & Export → Spielstände → Ordner auswählen und wähl den synchronisierten Ordner.',
	'help.devices.step3': '3. Sichere wie gewohnt. Das Spiel schreibt ARCHIV.DS und SAVE0..9.DS in den Ordner.',
	'help.devices.step4': '4. Lass auf dem anderen Gerät die Sync-App fertig werden, dann öffne LADEN. Die Liste wird jedes Mal aus dem Ordner gelesen.',
	'help.devices.know.title': 'Gut zu wissen',
	'help.devices.newer': 'Je Platz gewinnt der neuere Spielstand. Spiel immer nur auf einem Gerät, und halt die Uhren beider Geräte richtig.',
	'help.devices.browsers': 'Du brauchst Chrome oder Edge, auch auf Android. Firefox und Safari haben keinen Ordner-Zugriff — dort ziehst du Spielstände mit Herunterladen und Einlesen um.',
	'help.devices.android': 'Android vergisst die Ordner-Erlaubnis nach einem Neustart. Eine Markierung in der Leiste sagt es dir; ein Tipp erneuert sie.',
	'help.devices.dosbox': 'Es sind die Dateien des Originals: kopier sie in ein DOSBox-Verzeichnis, und das Spiel von 1993 lädt sie.',
	'help.enh.title': 'Verbesserungen',
	'help.enh.intro': 'Extras, die das Original nie hatte. Jedes ist aus, bis du es unter Verbesserungen einschaltest, und die Spielregeln bleiben unberührt.',
	'help.enh.stock': 'Lager-Übersicht: eine Anzeige über der Karte mit deinen Waren, deinen Siedlern und den Versorgungs-Zeigern deiner Ketten.',
	'help.enh.hacks': 'Hack „Alle Bodenschätze“: jedes Vorkommen zeigt das Schild, das ein Geologe aufstellen würde — auch dort, wo nie ein Geologe hinschaut.',
	'help.enh.assist': 'Wegebau-Assistent: wähl zwei deiner Fahnen, und er baut den schnellsten Weg dazwischen, mit genau den Klicks, die du machen würdest.',
	'view.textEntry': 'Texteingabe'
};

const TABLES: Readonly<Record<ShellLanguage, Readonly<Record<ShellKey, string>>>> = { de: DE, en: EN };

let active: ShellLanguage = detectShellLanguage();

export const shellLanguage = (): ShellLanguage => active;

/**
 * Set the language. For tests and a possible future switch — in normal operation it is decided when
 * this module loads. Also sets `lang` on the root element so screen readers and the browser's
 * hyphenation know what they are looking at.
 */
export function setShellLanguage(lang: ShellLanguage): void {
	active = lang;
	const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
	if (doc !== undefined) doc.documentElement.lang = lang;
}

setShellLanguage(active);

/** One shell string. `{name}` placeholders are filled from `params`. */
export function st(key: ShellKey, params?: Readonly<Record<string, string | number>>): string {
	const text = TABLES[active][key];
	if (params === undefined) return text;
	return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
		const v = params[name];
		return v === undefined ? whole : String(v);
	});
}


/** Test-only access to the tables themselves. */
export const SHELL_TABLES = TABLES;
