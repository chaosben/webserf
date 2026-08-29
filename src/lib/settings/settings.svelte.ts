/**
 * Settings the browser keeps.
 *
 * The split already exists in the original: volume, music and device options live in `DEVICE.CFG`
 * and NOT in the save game — the control options `viewOptions` (`.DS`@72/73) do live in the save.
 *
 * This file is our `DEVICE.CFG` PLUS the control options as a starting value. The addition is
 * deliberate: the options are meant to persist no matter whether they were set from the main menu
 * or from the in-game menu. Without it the main menu's options screen has no effect — it writes
 * into a copy nobody reads when a game starts.
 *
 * The boundary stays clean nonetheless: `viewOptions` here is the STARTING value of a new game, not
 * its state. Once a game runs the save game owns them, and a save loaded later brings its own — the
 * starting value then does not apply. It is persisted again when the in-game options screen changes
 * it.
 */
import {
	MUSIC_DEFAULT,
	VIEW_OPTIONS_DEFAULT,
	VOLUME_DEFAULT,
	VOLUME_MAX,
	VOLUME_MIN
} from '../core/engine/view-options.js';
import { SFX_DEFAULT } from '../core/options-popup.js';
import { DEFAULT_TICKS_PER_SECOND } from '../core/engine/scheduler.js';
import {
	GOOD_SLOTS,
	SERF_SLOTS,
	STOCK_CORNERS,
	STOCK_GOODS_DEFAULT,
	STOCK_OPACITY_DEFAULT,
	STOCK_OPACITY_MAX,
	STOCK_OPACITY_MIN,
	STOCK_PER_ROW_DEFAULT,
	STOCK_PER_ROW_MAX,
	STOCK_PER_ROW_MIN,
	STOCK_SERFS_DEFAULT,
	STOCK_SERF_MODES,
	type StockCorner,
	type StockSerfMode
} from '../enhancements/stock-overview.js';

const KEY = 'webserf.settings';

/**
 * Bump whenever the shape changes; a stored entry of another version then falls back to the
 * defaults. Version 6 == the stock overview without trend arrows and without a size of its own —
 * it follows the control bar.
 *
 * A purely ADDITIVE field needs no bump, and adding one must not take it: the reader checks the
 * version and then validates FIELD BY FIELD, so a stored version 5 entry that predates a new field
 * passes the version gate, fails that field's check and keeps its default. Everything else the user
 * had set survives. A removed or reinterpreted field is the case that does need the bump.
 */
const VERSION = 6;

/**
 * Selectable game speeds as a multiple of the original tick rate (100 ticks/s, measured on the
 * original). The original has no such control; it is an explicit extension and changes ONLY how
 * many logic ticks fall due per second of real time — the logic still counts in ticks, so
 * determinism is preserved.
 */
export const SPEED_FACTORS: readonly number[] = [0.25, 0.5, 1, 2, 4, 8];

export interface SettingsShape {
	/** Drawer group opened last (`null` = collapsed). */
	drawerGroup: string | null;
	/** Multiple of the original tick rate; one of {@link SPEED_FACTORS}. */
	speedFactor: number;
	/** Background music on (original: `gs+0x1cb` bit 1). */
	music: boolean;
	/** Sound effects on — not an original setting. */
	sfx: boolean;
	/** Shared volume 0..99 (original: `gs+0x3dc`). */
	volume: number;
	/** Per-screen-half control options (`.DS`@72/73) as the starting value of a new game. */
	viewOptions: [number, number];

	// -- Stock overview. Our own addition; the original has no permanent readout of this kind. ----
	/**
	 * Which goods it lists — bit i = resource type i. Together with {@link stockSerfs} this IS the
	 * on/off switch: an empty selection shows nothing.
	 */
	stockGoods: number;
	/** Which professions it lists — bit i = serf type i. */
	stockSerfs: number;
	/** Which corner of the game surface it sits in. */
	stockCorner: StockCorner;
	/** What the serf numbers mean: resting in a store, or what could be made of the unemployed. */
	stockSerfMode: StockSerfMode;
	/** How opaque the backing plate is. */
	stockOpacity: number;
	/** How many entries stand side by side — the choice between a column and a strip. */
	stockPerRow: number;
}

const DEFAULTS: SettingsShape = {
	drawerGroup: null,
	speedFactor: 1,
	music: MUSIC_DEFAULT,
	sfx: SFX_DEFAULT,
	volume: VOLUME_DEFAULT,
	viewOptions: [VIEW_OPTIONS_DEFAULT, VIEW_OPTIONS_DEFAULT],
	stockGoods: STOCK_GOODS_DEFAULT,
	stockSerfs: STOCK_SERFS_DEFAULT,
	stockCorner: 'tl',
	stockSerfMode: 'idle',
	stockOpacity: STOCK_OPACITY_DEFAULT,
	stockPerRow: STOCK_PER_ROW_DEFAULT
};

/**
 * Fresh defaults. Not `{ ...DEFAULTS }`: `viewOptions` is an array, and a shallow spread would
 * share it between all copies — the first `set` would write into the defaults.
 */
function fresh(): SettingsShape {
	return { ...DEFAULTS, viewOptions: [...DEFAULTS.viewOptions] as [number, number] };
}

const isByte = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;

/** A selection mask: a non-negative integer below `2 ** slots` — see `stock-overview.ts`. */
const isMask = (v: unknown, slots: number): boolean =>
	typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** slots;

const isOneOf = <T extends string>(v: unknown, values: readonly T[]): v is T =>
	typeof v === 'string' && (values as readonly string[]).includes(v);

/**
 * One validator per field. Deliberately spelled out instead of `typeof v === typeof DEFAULTS[k]`:
 * that shortcut lets ANY object through for `viewOptions` (`typeof [] === 'object'`) and knows no
 * value ranges — a foreign or stale entry could smuggle in a volume of 10^9 or a non-array, and the
 * failure would surface far away from here.
 */
const CHECK: { [K in keyof SettingsShape]: (v: unknown) => v is SettingsShape[K] } = {
	drawerGroup: (v): v is string | null => v === null || typeof v === 'string',
	speedFactor: (v): v is number => typeof v === 'number' && SPEED_FACTORS.includes(v),
	music: (v): v is boolean => typeof v === 'boolean',
	sfx: (v): v is boolean => typeof v === 'boolean',
	volume: (v): v is number =>
		typeof v === 'number' && Number.isInteger(v) && v >= VOLUME_MIN && v <= VOLUME_MAX,
	viewOptions: (v): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isByte),
	stockGoods: (v): v is number => isMask(v, GOOD_SLOTS),
	stockSerfs: (v): v is number => isMask(v, SERF_SLOTS),
	stockCorner: (v): v is StockCorner => isOneOf(v, STOCK_CORNERS),
	stockSerfMode: (v): v is StockSerfMode => isOneOf(v, STOCK_SERF_MODES),
	stockOpacity: (v): v is number =>
		typeof v === 'number' && v >= STOCK_OPACITY_MIN && v <= STOCK_OPACITY_MAX,
	stockPerRow: (v): v is number =>
		typeof v === 'number' &&
		Number.isInteger(v) &&
		v >= STOCK_PER_ROW_MIN &&
		v <= STOCK_PER_ROW_MAX
};

function read(): SettingsShape {
	if (typeof localStorage === 'undefined') return fresh();
	try {
		const raw = localStorage.getItem(KEY);
		if (raw === null) return fresh();
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return fresh();
		const box = parsed as { v?: unknown; data?: unknown };
		// Unknown version: take the defaults instead of guessing.
		if (box.v !== VERSION || typeof box.data !== 'object' || box.data === null) return fresh();
		// Field by field — a foreign file must not smuggle in unknown keys.
		const data = box.data as Record<string, unknown>;
		const out = fresh();
		for (const k of Object.keys(DEFAULTS) as (keyof SettingsShape)[]) {
			const v = data[k];
			if (CHECK[k](v)) (out[k] as unknown) = v;
		}
		return out;
	} catch {
		return fresh();
	}
}

class SettingsStore {
	#value = $state<SettingsShape>(read());

	get value(): SettingsShape {
		return this.#value;
	}

	/** Set a single field and persist it right away. */
	set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]): void {
		this.#value[key] = value;
		this.#persist();
	}

	reset(): void {
		this.#value = fresh();
		this.#persist();
	}

	#persist(): void {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(KEY, JSON.stringify({ v: VERSION, data: this.#value }));
		} catch {
			// Storage full or denied — the session carries on regardless.
		}
	}
}

export const settings = new SettingsStore();
export const SETTINGS_DEFAULTS: Readonly<SettingsShape> = DEFAULTS;

/** Tick rate from the stored multiple (the original runs at 100 ticks per second). */
export function ticksPerSecondOf(factor: number): number {
	return Math.round(DEFAULT_TICKS_PER_SECOND * factor);
}
