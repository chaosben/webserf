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
	'enh.stock.tab.view': 'Display',
	'enh.stock.aria': 'Stock overview',
	'enh.pick.all': 'All',
	'enh.pick.none': 'None',
	'enh.pick.count': '{on} of {all} selected',
	'enh.pick.noIcons': 'Load an archive to see the pictures.',
	'enh.stock.goods.title': 'Which goods',
	'enh.stock.goods.note':
		'Counted over all your warehouses, plus the building reserve the castle parks at its founding — ' +
		'the same sum the storage statistics show.',
	'enh.stock.serfs.title': 'Which settlers',
	'enh.stock.serfs.mode': 'Count as',
	'enh.stock.serfs.modeIdle': 'Resting in a store',
	'enh.stock.serfs.modeAvailable': 'Could be made',
	'enh.stock.serfs.modeNote':
		'“Could be made” adds the unemployed settlers to every profession whose tool lies in the store. ' +
		'One settler therefore counts in several rows — the question is “how many of these could I ' +
		'have”, not “how would they divide up”.',	
	'enh.stock.view.corner': 'Position',
	'enh.stock.view.perRow': 'Entries per row',
	'enh.stock.view.perRowNote': 'One makes a narrow column, twelve a wide strip.',
	'enh.stock.view.opacity': 'Opacity',
	'enh.corner.tl': 'Top left',
	'enh.corner.tr': 'Top right',
	'enh.corner.bl': 'Bottom left',
	'enh.corner.br': 'Bottom right',

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
	'record.progress': 'Recording — {frames} images, about {seconds} s',
	'record.needGame': 'Start a game first — there is nothing to record yet.',
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
	// The invisible field that holds the focus while the original asks for text, so that a phone
	// brings up its keyboard — see `views/TextEntryField.svelte`.
	'view.textEntry': 'Text entry'
} as const;

export type ShellKey = keyof typeof EN;

/** German. Formal address ("Sie"), matching the original manual and the strings in the binary. */
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

	'drop.aria': 'Archiv-Datei hier ablegen',
	'drop.lead': 'Legen Sie Ihr Spiel-Archiv hier ab — oder wählen Sie eine Datei.',
	'drop.reading': 'Archiv wird gelesen…',
	'drop.choose': 'Archiv auswählen',
	'drop.what':
		'„Die Siedler“ von 1993 — im Browser. Dieselben Regeln, dieselbe Grafik, direkt aus den Dateien des Originals gelesen. Ihr Archiv und Ihre Spielstände bleiben dabei bei Ihnen, hochgeladen wird nichts.',
	'drop.need':
		'Es fehlt nur noch das Grafik-Archiv aus Ihrer eigenen Kopie — eine einzelne Datei aus einer Installation von 1993. Wir würden sie ja gern mitbringen, aber die Grafiken gehören ihrem Verlag, und Verlage verstehen da bekanntlich wenig Spaß.',
	'drop.buy': 'Noch zu kaufen:',
	'drop.buyLink': 'Die Siedler History Edition (Ubisoft)',
	'link.store': 'https://www.ubisoft.com/de-de/games/the-settlers-history-edition',
	'drop.search': 'Stöbern Sie in der alten Installation — oder lassen Sie eine Suchmaschine stöbern:',
	'drop.searchLink': 'nach „{terms}“ suchen',
	'assets.badType': 'Unerwarteter Dateityp: {file} — erwartet wird eine .PA-Datei.',
	'assets.unreadable': 'Archiv ist nicht lesbar: {why}',
	'assets.cacheFailed': 'Der Zwischenspeicher ließ sich nicht lesen: {why}',

	'io.tab.saves': 'Spielstände',
	'io.tab.assets': 'Archiv',

	'folder.title': 'Spielstand-Ordner',
	'folder.what':
		'Ein Ordner hält eine zweite Kopie als echte Dateien ARCHIV.DS / SAVE0..9.DS, im Gleichschritt mit diesem Browser — kopieren Sie sie in ein DOSBox-Verzeichnis, und das Original lädt sie.',
	'folder.unsupported':
		'Dieser Browser hat keinen Ordner-Zugriff, die Spielstände liegen also nur hier — zum Umziehen dienen die Knöpfe oben.',
	'folder.attached': 'Verknüpft:',
	'folder.detach': 'Ordner lösen',
	'folder.choose': 'Ordner auswählen',
	'folder.allow': 'Gemerkten Ordner wieder erlauben',

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
		'Eine einzelne SAVEn.DS ist die Datei, die das Original liest — in ein DOSBox-Verzeichnis kopieren und dort laden. Ihr Name steht nicht in der Datei, sondern in ARCHIV.DS; ein eingelesener Stand wird deshalb nach seinem Dateinamen benannt. Das Paket nimmt die Namen mit.',
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
	'set.rest': 'Alles andere',
	'set.restNote':
		'Klang, Musik und die Bedien-Optionen liegen auf dem Original-Bildschirm „EXTRA OPTION“ — erreichbar aus dem Hauptmenü und aus dem Spiel; dieser Browser merkt sich, was Sie dort einstellen.',
	'set.reset': 'Auf Vorgabewerte zurücksetzen',

	'bug.building': 'Wird gebaut…',
	'bug.build': 'Bericht erzeugen und Issue öffnen',
	'bug.filed':
		'Der Bericht liegt in Ihrem Download-Ordner, das Issue hat sich in einem neuen Tab geöffnet. Ziehen Sie die Datei dort hinein, bevor Sie abschicken — das Kästchen im Issue erinnert daran.',
	'bug.where': 'Berichte werden zu Issues in',
	'bug.intro':
		'Ein Bericht enthält den Spielzustand, die aufgezeichneten Aktionen, ein Bild und eine Zusammenfassung. Solange dieses Fenster offen ist, steht die Simulation — der Bericht beschreibt also, was Sie gesehen haben.',
	'bug.what': 'Was ist schiefgegangen?',
	'bug.placeholder': 'z. B. Träger liefern immer weiter Steine zu einer fertigen Hütte',
	'bug.needGame': 'Starten Sie erst ein Spiel — ein Bericht braucht eine laufende Partie.',

	'info.about.title': 'Was das hier ist',
	'info.about.what':
		'webserf holt „Die Siedler“ (Blue Byte, 1993) in den Browser: Die Regeln stammen aus dem Original-Programm, die Grafik aus Ihrer eigenen Kopie des Spiels.',
	'info.about.assets':
		'Vom Original ist hier nichts dabei. Ihr geladenes Archiv bleibt in Ihrem Browser, Ihre Spielstände auch — hochgeladen wird nichts.',
	'info.source.title': 'Quelltext',
	'info.source.note':
		'Offener Quelltext, und über Issues und Pull Requests freuen wir uns jederzeit. Fehlerberichte aus dem Bildschirm „Fehler melden“ landen an derselben Stelle.',
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
	'enh.stock.tab.view': 'Darstellung',
	'enh.stock.aria': 'Lager-Übersicht',	
	'enh.pick.all': 'Alle',
	'enh.pick.none': 'Keine',
	'enh.pick.count': '{on} von {all} ausgewählt',
	'enh.pick.noIcons': 'Laden Sie ein Archiv, um die Bilder zu sehen.',
	'enh.stock.goods.title': 'Welche Waren',
	'enh.stock.goods.note':
		'Gezählt über alle Ihre Lager, dazu die Bau-Reserve, die das Schloss bei der Gründung ' +
		'zurücklegt — dieselbe Summe, die auch die Lager-Statistik zeigt.',
	'enh.stock.serfs.title': 'Welche Siedler',
	'enh.stock.serfs.mode': 'Gezählt wird',
	'enh.stock.serfs.modeIdle': 'Wer im Lager ruht',
	'enh.stock.serfs.modeAvailable': 'Wer daraus werden könnte',
	'enh.stock.serfs.modeNote':
		'„Wer daraus werden könnte“ rechnet die freien Siedler jedem Beruf zu, dessen Werkzeug im Lager ' +
		'liegt. Ein Siedler zählt damit in mehreren Zeilen — gefragt ist „wie viele davon könnte ich ' +
		'haben“, nicht „wie würden sie sich aufteilen“.',	
	'enh.stock.view.corner': 'Position',
	'enh.stock.view.perRow': 'Einträge je Zeile',
	'enh.stock.view.perRowNote': 'Eins ergibt eine schmale Säule, zwölf einen breiten Streifen.',
	'enh.stock.view.opacity': 'Deckkraft',
	'enh.corner.tl': 'Oben links',
	'enh.corner.tr': 'Oben rechts',
	'enh.corner.bl': 'Unten links',
	'enh.corner.br': 'Unten rechts',

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
	'record.progress': 'Aufnahme läuft — {frames} Bilder, etwa {seconds} s',
	'record.needGame': 'Starte zuerst ein Spiel — es gibt noch nichts aufzunehmen.',
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
