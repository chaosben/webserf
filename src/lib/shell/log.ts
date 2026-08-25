/**
 * Application log — output goes to the BROWSER console.
 *
 * Why this file exists instead of calling `console.info` in twenty places:
 *
 * - The CATEGORY survives (`assets`, `engine`, `menu`, `game`, `bug`). In the devtools filter it
 *   plays the role a level selector would; it is a text prefix because that filter matches text.
 * - The call shape stays `log.info(cat, msg)`, so no call site has to change.
 *
 * There is deliberately no ring buffer: the bug report carries the save game and the action log,
 * from which the course of events can be recomputed, so a buffer nobody reads would only leak
 * memory.
 */
class Log {
	/** Fine-grained flow. Only visible in the devtools once "verbose" is enabled — by design. */
	debug(cat: string, msg: string): void {
		console.debug(`[${cat}] ${msg}`);
	}

	info(cat: string, msg: string): void {
		console.info(`[${cat}] ${msg}`);
	}

	warn(cat: string, msg: string): void {
		console.warn(`[${cat}] ${msg}`);
	}

	error(cat: string, msg: string): void {
		console.error(`[${cat}] ${msg}`);
	}
}

export const log = new Log();
