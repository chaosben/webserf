/**
 * **A bug report does not carry the map, but its recipe plus the deviations.**
 *
 * The reason is a measurement: `state.json` **is** essentially the tile table — 0.88 MB at 64x64,
 * **18.72 MB** at 512x256 (18.63 MB of it `mapTiles`). Nobody drags such a file into an issue.
 *
 * **The recipe is in the report itself.** Every save carries its map seed: for free play as
 * `header.mapSeed` (`.DS`@138), for level and mission as the setup record index (@124/@122) whose
 * seed lives in {@link SETUP_RECORDS}. The generator is byte-verified, so the map is reproducible —
 * and what the game changed on it is little.
 *
 * **Measured** (diff against the generated map, gzip): 512x256 barely played **1 KB** against 491 KB.
 *
 * **Lossless by construction.** **All** eleven tile fields are compared and whatever does not match
 * goes into the diff. A bad baseline therefore costs space, never information — `restore(reduce(x))
 * === x` holds regardless of how good the baseline is. That is the reason for this cut: a
 * reconstruction that had to *decide* which fields are derivable would silently lose something when
 * it got that wrong.
 *
 * **So the diff is its own guard**: {@link MapDiff.stats} names the deviations per field. If that
 * number grows for a freshly started game, the generator is broken.
 *
 * **Deliberately not derived:** `owner` (from the military buildings) and the entity indices. On a
 * heavily played map those are about two thirds of the diff entries — but the diff is small with
 * them too, and every further derived layer is another place where the report could gloss over its
 * own reconstruction. They appear in `stats` and are thus visible should it ever get tight.
 *
 * **If the baseline fails** (unknown game type, missing seed, generator throws),
 * {@link reduceReportState} returns the tiles unchanged (`kind: 'full'`). A report that does not come
 * into being because of an optimisation would be the worst outcome.
 */

import type { MapTile, SaveGameHeader, SaveGameState } from './types.js';
import { GAME_TYPE, resolveGameSetup } from './engine/new-game.js';
import { generateMap, mapByteOffset } from './engine/map-generator.js';
import { Rng } from './engine/rng.js';

/**
 * The eleven tile fields with their code in the diff. The codes are short because they appear once
 * per deviation; keep them **stable**, or an old report reads wrong.
 */
const FIELDS = [
  ['h', 'height'],
  ['t', 'terrainUp'],
  ['d', 'terrainDown'],
  ['o', 'object'],
  ['w', 'owner'],
  ['p', 'paths'],
  ['b', 'blocked'],
  ['m', 'mineral'],
  ['r', 'resourceAmount'],
  ['x', 'objIndex'],
  ['s', 'serfIndex'],
] as const satisfies readonly (readonly [string, keyof MapTile])[];

type FieldCode = (typeof FIELDS)[number][0];

/**
 * How many fields per tile are compared. It lives here rather than as a literal in the report because
 * it is the **reference size** of the diff count: field deviations are counted, and `tiles x fields`
 * is the set they are a fraction of.
 */
export const MAP_FIELD_COUNT = FIELDS.length;

/** One deviation: tile index, field code, value in the report (`blocked` as 0/1). */
export type MapDiffEntry = readonly [number, FieldCode, number];

/** The map as recipe + deviations. */
export interface MapDiff {
  readonly kind: 'seed-diff';
  /** Tile count the diff was built against — if it does not match, the diff is not applied. */
  readonly tiles: number;
  readonly diff: readonly MapDiffEntry[];
  /** Deviations per field. Not for rebuilding — for the reader. */
  readonly stats: Readonly<Record<string, number>>;
}

/** Fallback: the tiles unchanged when no baseline could be built. */
export interface MapVerbatim {
  readonly kind: 'full';
  readonly tiles: readonly MapTile[];
  /** Why nothing better was possible — it appears in the report so it is noticed. */
  readonly reason: string;
}

/** The save as a report carries it: everything as parsed, only the map reduced. */
export type ReportState = Omit<SaveGameState, 'mapTiles'> & {
  readonly map: MapDiff | MapVerbatim;
};

/**
 * The generated map as a tile table — the same field split as in the parser (`decodeMapTiles`), only
 * on the generator buffer instead of the file.
 *
 * Both splits must agree or the diff blows up. That is not secured by shared code (the layers differ)
 * but by measurement: on an **unplayed** save the diff must be near zero.
 */
function baselineTiles(header: SaveGameHeader): MutableTile[] {
  const seedSetup =
    header.gameType >= 2
      ? { gameType: header.gameType, seed: header.mapSeed, mapSize: header.mapSize }
      : {
          gameType: header.gameType,
          missionSetupIndex: header.missionSetupIndex,
          levelSetupIndex: header.levelSetupIndex,
        };
  if (header.gameType >= 2 && header.mapSeed === undefined) {
    throw new Error('free play without mapSeed in the header');
  }
  const resolved = resolveGameSetup(seedSetup);
  const buf = generateMap(resolved.mapSeed, header.mapSize, (s) => {
    const rng = new Rng([s[0] ?? 0, s[1] ?? 0, s[2] ?? 0]);
    return () => rng.next();
  });
  const { cols, rows } = buf.geo;
  if (cols !== header.mapCols || rows !== header.mapRows) {
    throw new Error(
      `generated map ${cols}x${rows} does not match the save ${header.mapCols}x${header.mapRows}`,
    );
  }
  const tiles: MutableTile[] = new Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const off = mapByteOffset(buf, col, row);
      const b0 = buf.bytes[off] ?? 0;
      const b1 = buf.bytes[off + 1] ?? 0;
      const b2 = buf.bytes[off + 2] ?? 0;
      const b3 = buf.bytes[off + 3] ?? 0;
      const object = b3 & 0x7f;
      const g = buf.layerOffset + off;
      // For object 1..4 the game layer carries the entity index, otherwise mineral + amount — the
      // same case distinction as in the parser.
      const isEntity = object >= 1 && object <= 4;
      const rb = buf.bytes[g] ?? 0;
      tiles[row * cols + col] = {
        height: b1 & 0x1f,
        terrainUp: (b2 >> 4) & 0x0f,
        terrainDown: b2 & 0x0f,
        object,
        owner: (b1 >> 7) & 1 ? ((b1 >> 5) & 3) + 1 : 0,
        paths: b0 & 0x3f,
        blocked: (b0 & 0x40) !== 0,
        mineral: isEntity ? 0 : (rb >> 5) & 7,
        resourceAmount: isEntity ? 0 : rb & 0x1f,
        objIndex: isEntity ? ((buf.bytes[g] ?? 0) | ((buf.bytes[g + 1] ?? 0) << 8)) : 0,
        serfIndex: (buf.bytes[g + 2] ?? 0) | ((buf.bytes[g + 3] ?? 0) << 8),
      };
    }
  }
  return tiles;
}

/** Writable view of a tile — the baseline is built and then patched. */
type MutableTile = { -readonly [K in keyof MapTile]: MapTile[K] };

const numOf = (t: MapTile, key: keyof MapTile): number => {
  const v = t[key];
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
};

/** Diffs the map against the generated one. Never throws — in doubt the tiles come along. */
export function reduceMapTiles(header: SaveGameHeader, tiles: readonly MapTile[]): MapDiff | MapVerbatim {
  let base: MutableTile[];
  try {
    base = baselineTiles(header);
  } catch (err) {
    return { kind: 'full', tiles, reason: err instanceof Error ? err.message : String(err) };
  }
  if (base.length !== tiles.length) {
    return { kind: 'full', tiles, reason: `tile count ${base.length} instead of ${tiles.length}` };
  }
  const diff: MapDiffEntry[] = [];
  const stats: Record<string, number> = {};
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const b = base[i];
    if (t === undefined || b === undefined) continue;
    for (const [code, key] of FIELDS) {
      const v = numOf(t, key);
      if (v !== numOf(b, key)) {
        diff.push([i, code, v]);
        stats[key] = (stats[key] ?? 0) + 1;
      }
    }
  }
  return { kind: 'seed-diff', tiles: tiles.length, diff, stats };
}

/** Restores the map. Throws when the baseline does not match the diff. */
export function restoreMapTiles(header: SaveGameHeader, map: MapDiff | MapVerbatim): MapTile[] {
  if (map.kind === 'full') return map.tiles.map((t) => ({ ...t }));
  const tiles = baselineTiles(header);
  if (tiles.length !== map.tiles) {
    throw new Error(`baseline has ${tiles.length} tiles, the diff expects ${map.tiles}`);
  }
  const byCode = new Map<string, keyof MapTile>(FIELDS.map(([c, k]) => [c, k]));
  for (const [i, code, value] of map.diff) {
    const key = byCode.get(code);
    const t = tiles[i];
    if (key === undefined) throw new Error(`unknown field code '${code}' in the map diff`);
    if (t === undefined) throw new Error(`map diff names tile ${i} outside the map`);
    if (key === 'blocked') t.blocked = value !== 0;
    else t[key] = value;
  }
  return tiles;
}

/** Reduces a save for a report. */
export function reduceReportState(state: SaveGameState): ReportState {
  const { mapTiles, ...rest } = state;
  return { ...rest, map: reduceMapTiles(state.header, mapTiles) };
}

/** And back — the counterpart used when evaluating a report. */
export function restoreReportState(report: ReportState): SaveGameState {
  const { map, ...rest } = report;
  return { ...rest, mapTiles: restoreMapTiles(report.header, map) };
}
