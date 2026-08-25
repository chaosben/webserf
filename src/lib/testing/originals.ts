/**
 * Access to the user's own copy of the original game files, for tests that want to run against
 * real bytes instead of synthetic fixtures (BYOA — nothing of the original ships with this repo).
 *
 * The directories come from the environment (`WEBSERF_ORIGINALS`, `:`-separated), never from a
 * path relative to this repository: a test must not know where the files live on any particular
 * machine, and a fixed path upwards would tie the repository to one checkout layout. Files are
 * looked up by **base name** across all listed directories, so originals and hand-made save games
 * may sit in separate folders.
 *
 * Without the variable every dependent test skips itself — a missing original is not a failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIRS = (process.env['WEBSERF_ORIGINALS'] ?? '')
	.split(':')
	.map((d) => d.trim())
	.filter(Boolean)
	.map((d) => resolve(d));

/** Absolute path of `name` in the first directory that has it, or `null`. */
export function findOriginal(name: string): string | null {
	for (const dir of DIRS) {
		const p = resolve(dir, name);
		if (existsSync(p)) return p;
	}
	return null;
}

/** True if every named file is available — the guard for `describe.runIf` / `it.skipIf`. */
export function hasOriginals(...names: string[]): boolean {
	return names.every((n) => findOriginal(n) !== null);
}

/** Reads `name`, or `null` if it is not available. */
export function readOriginal(name: string): Buffer | null {
	const p = findOriginal(name);
	return p === null ? null : readFileSync(p);
}

/** Reads `name` as a detached `ArrayBuffer`, or `null` if it is not available. */
export function readOriginalBuffer(name: string): ArrayBuffer | null {
	const raw = readOriginal(name);
	if (raw === null) return null;
	return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}
