/**
 * Glue between file selection, the IndexedDB cache and the game views.
 *
 * The three palette entries are not a matter of taste: the archive holds exactly three 768-byte
 * entries (2 = game, 3996 = artwork/end credits, 3997 = opening credits). Which screen uses which
 * one is decided by the screen itself, not by its caller.
 */
import { PaArchive } from '../core/pa-parser.js';
import { parseInArchivePalette } from '../core/pal-parser.js';
import type { Palette } from '../core/types.js';

export const IN_ARCHIVE_PALETTE_INDICES: readonly number[] = [2, 3996, 3997];

/** Palette of the game interface; every other screen brings its own. */
export const GAME_PALETTE_INDEX = 2;

export function extractInArchivePalettes(loaded: PaArchive): Record<number, Palette> {
	const out: Record<number, Palette> = {};
	for (const tocIndex of IN_ARCHIVE_PALETTE_INDICES) {
		if (tocIndex >= loaded.entries.length) continue;
		let raw: Uint8Array | null;
		try {
			raw = loaded.getRaw(tocIndex);
		} catch {
			continue;
		}
		if (raw === null || raw.byteLength !== 768) continue;
		try {
			out[tocIndex] = parseInArchivePalette(raw);
		} catch {
			// Wrong size or not palette data — ignore quietly.
		}
	}
	return out;
}

/** Filename an original installation uses. */
export function looksLikeArchive(name: string): boolean {
	return name.toUpperCase().endsWith('.PA');
}
