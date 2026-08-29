import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SPEED_FACTORS, ticksPerSecondOf } from './settings.svelte.js';

/**
 * The store is a module singleton and reads on import. Every case therefore gets a fresh import
 * with a prepared `localStorage`.
 */
function stubStorage(initial: string | null): Record<string, string> {
	const box: Record<string, string> = {};
	if (initial !== null) box['webserf.settings'] = initial;
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => box[k] ?? null,
		setItem: (k: string, v: string) => void (box[k] = v),
		removeItem: (k: string) => void delete box[k]
	});
	return box;
}

async function load(stored: unknown) {
	const box = stubStorage(stored === undefined ? null : JSON.stringify(stored));
	vi.resetModules();
	const mod = await import('./settings.svelte.js');
	return { settings: mod.settings, defaults: mod.SETTINGS_DEFAULTS, box };
}

describe('settings store', () => {
	beforeEach(() => vi.unstubAllGlobals());

	it('yields the defaults without a stored entry', async () => {
		const { settings, defaults } = await load(undefined);
		expect(settings.value).toEqual(defaults);
	});

	it('accepts valid values and writes them back', async () => {
		const { settings, box } = await load({
			v: 6,
			data: { volume: 12, music: false, sfx: false, speedFactor: 4, viewOptions: [0x25, 0x39] }
		});
		expect(settings.value.volume).toBe(12);
		expect(settings.value.music).toBe(false);
		expect(settings.value.speedFactor).toBe(4);
		expect(settings.value.viewOptions).toEqual([0x25, 0x39]);

		settings.set('sfx', true);
		expect(JSON.parse(box['webserf.settings']!).data.sfx).toBe(true);
	});

	it('discards an unknown version entirely', async () => {
		const { settings, defaults } = await load({ v: 1, data: { volume: 12 } });
		expect(settings.value).toEqual(defaults);
	});

	/**
	 * A stored entry that still carries the fields of a removed panel must not bring them back —
	 * otherwise the shape grows with every removed control, and `reset()` returns something other
	 * than `read()`.
	 */
	it('does not resurrect fields of a removed panel', async () => {
		const { settings } = await load({
			v: 6,
			data: { consoleOpen: true, consoleHeight: 400, logLevel: 'debug', volume: 12 }
		});
		expect(Object.keys(settings.value)).not.toContain('consoleOpen');
		expect(Object.keys(settings.value)).not.toContain('logLevel');
		expect(settings.value.volume).toBe(12); // the valid neighbour survives
	});

	/**
	 * The actual reason for the spelled-out validators: `typeof v === typeof DEFAULTS[k]` lets ANY
	 * object through for `viewOptions` and knows no value ranges. Every case below would pass with
	 * that shortcut — except the one that fails on the type anyway.
	 */
	it.each([
		['volume outside 0..99', { volume: 1000 }, 'volume'],
		['volume not an integer', { volume: 7.5 }, 'volume'],
		['unknown speed', { speedFactor: 3 }, 'speedFactor'],
		['viewOptions as an object', { viewOptions: { 0: 1, 1: 2 } }, 'viewOptions'],
		['viewOptions too short', { viewOptions: [0x39] }, 'viewOptions'],
		['viewOptions not a byte', { viewOptions: [0x39, 300] }, 'viewOptions'],
		['drawer group as a number', { drawerGroup: 7 }, 'drawerGroup'],
		// The stock overview. Every one of these would slip through `typeof v === 'number'` or
		// `=== 'string'` — the shortcut the comment above `CHECK` rules out.
		['a negative goods mask', { stockGoods: -1 }, 'stockGoods'],
		['a fractional goods mask', { stockGoods: 1.5 }, 'stockGoods'],
		['a goods mask past the last good', { stockGoods: 2 ** 26 }, 'stockGoods'],
		['a serf mask past the last profession', { stockSerfs: 2 ** 27 }, 'stockSerfs'],
		['a corner that does not exist', { stockCorner: 'middle' }, 'stockCorner'],
		['an unknown serf mode', { stockSerfMode: 'total' }, 'stockSerfMode'],
		['an opacity outside 0.2..1', { stockOpacity: 5 }, 'stockOpacity'],
		['no entry per row at all', { stockPerRow: 0 }, 'stockPerRow'],
		['more entries per row than offered', { stockPerRow: 13 }, 'stockPerRow'],
		['a fractional row width', { stockPerRow: 1.5 }, 'stockPerRow']
	])('rejects %s', async (_name, data, key) => {
		const { settings, defaults } = await load({ v: 6, data });
		expect(settings.value[key as keyof typeof defaults]).toEqual(
			defaults[key as keyof typeof defaults]
		);
	});

	/**
	 * A field ADDED later must not cost the user their other settings. The reader checks the version
	 * and then validates field by field, so an entry written before the field existed keeps
	 * everything it does carry — which is why adding one needs no version bump. Whoever adds a bump
	 * anyway breaks this line, and that is the point of it.
	 */
	it('loads a stored entry that predates a field and gives that one field its default', async () => {
		const { settings, defaults } = await load({
			v: 6,
			data: { volume: 12, stockCorner: 'br', stockPerRow: 4 }
		});
		expect(settings.value.stockSerfMode).toBe(defaults.stockSerfMode);
		expect(settings.value.volume).toBe(12);
		expect(settings.value.stockCorner).toBe('br');
		expect(settings.value.stockPerRow).toBe(4);
	});

	it('a damaged field costs only itself, not the others', async () => {
		const { settings } = await load({ v: 6, data: { volume: 1000, music: false } });
		expect(settings.value.volume).toBe(75); // default
		expect(settings.value.music).toBe(false); // kept
	});

	it('falls back to the defaults on broken JSON', async () => {
		stubStorage('{nope');
		vi.resetModules();
		const mod = await import('./settings.svelte.js');
		expect(mod.settings.value).toEqual(mod.SETTINGS_DEFAULTS);
	});

	/**
	 * `viewOptions` is an array: a shallow spread of the defaults would share it between all copies,
	 * and the first in-place change would write into the defaults themselves.
	 */
	it('does not share the viewOptions array with the defaults', async () => {
		const { settings, defaults } = await load(undefined);
		expect(settings.value.viewOptions).not.toBe(defaults.viewOptions);
		settings.value.viewOptions[0] = 0x00;
		expect(defaults.viewOptions[0]).toBe(0x39);
		settings.reset();
		expect(settings.value.viewOptions).toEqual([0x39, 0x39]);
	});
});

describe('game speed', () => {
	it('1x is the tick rate measured on the original', () => {
		expect(ticksPerSecondOf(1)).toBe(100);
	});

	it('the steps ascend and include 1x', () => {
		expect(SPEED_FACTORS).toContain(1);
		expect([...SPEED_FACTORS].sort((a, b) => a - b)).toEqual([...SPEED_FACTORS]);
	});

	it('every step yields a whole tick count > 0', () => {
		for (const f of SPEED_FACTORS) {
			const t = ticksPerSecondOf(f);
			expect(Number.isInteger(t)).toBe(true);
			expect(t).toBeGreaterThan(0);
		}
	});
});
