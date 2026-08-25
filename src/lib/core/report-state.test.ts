/**
 * **The map diff of a bug report** — two claims, and the second one is the real test.
 *
 * 1. **Lossless**: `restore(reduce(x))` equals `x` field by field. That holds by construction,
 *    even on a bad baseline — it guards, it does not prove.
 * 2. **The baseline lines up**: on an **untouched** save the diff must be near zero. Only that
 *    number shows that {@link baselineTiles} splits the generator bytes the same way the parser
 *    splits the file bytes; the two splits live in different places and share no code. Were one
 *    shifted, (1) and every type check would stay green while reports grew silently huge.
 *
 * The size ratio (raw JSON, full against diff) is asserted too, so a regression shows up as a
 * number rather than only as a failure.
 */
import { describe, expect, it } from 'vitest';
import { parseSaveGame } from './save-parser.js';
import { hasOriginals, readOriginalBuffer } from '../testing/originals.js';
import { reduceMapTiles, reduceReportState, restoreReportState } from './report-state.js';

const load = (name: string) => parseSaveGame(readOriginalBuffer(name)!);

/** Played campaign, played free game, and one **untouched** large map. */
const PLAYED = ['SAVE0.DS', 'SAVE1.DS', 'SAVE2.DS'];
const UNPLAYED = 'freeplay-demo-502-size8.DS';

describe('report map diff', () => {
  for (const name of [...PLAYED, UNPLAYED]) {
    it.skipIf(!hasOriginals(name))(`${name}: round trip is lossless`, () => {
      const save = load(name);
      const back = restoreReportState(reduceReportState(save));
      expect(back.mapTiles.length).toBe(save.mapTiles.length);
      // Field by field rather than one `toEqual`: on 131072 objects the failure output is
      // unreadable and never names the offending tile.
      let firstBad = -1;
      for (let i = 0; i < save.mapTiles.length; i++) {
        const a = save.mapTiles[i]!;
        const b = back.mapTiles[i]!;
        if (
          a.height !== b.height || a.terrainUp !== b.terrainUp || a.terrainDown !== b.terrainDown ||
          a.object !== b.object || a.owner !== b.owner || a.paths !== b.paths ||
          a.blocked !== b.blocked || a.mineral !== b.mineral ||
          a.resourceAmount !== b.resourceAmount || a.objIndex !== b.objIndex ||
          a.serfIndex !== b.serfIndex
        ) {
          firstBad = i;
          break;
        }
      }
      expect(firstBad, `first differing tile: ${firstBad}`).toBe(-1);
      // And the rest of the save must survive too.
      expect(back.header).toEqual(save.header);
      expect(back.serfRecords.length).toBe(save.serfRecords.length);
    });
  }

  it.skipIf(!hasOriginals(UNPLAYED))('untouched map: the diff is vanishingly small', () => {
    const save = load(UNPLAYED);
    const map = reduceMapTiles(save.header, save.mapTiles);
    expect(map.kind).toBe('seed-diff');
    if (map.kind !== 'seed-diff') return;
    // 131072 tiles, of which 471 differ in practice — 434 of them `owner`, because the castle
    // claims land; deliberately not derived. The bound is generous and still sharp: a shifted
    // field split produces differences on the order of the tile count.
    expect(map.diff.length).toBeLessThan(map.tiles / 100);
    // Terrain and height must be essentially exact — they are the core of the generator.
    expect(map.stats['terrainUp'] ?? 0).toBe(0);
    expect(map.stats['terrainDown'] ?? 0).toBe(0);
    expect(map.stats['height'] ?? 0).toBeLessThan(64);
  });

  it.skipIf(!hasOriginals('SAVE0.DS', UNPLAYED))('effect: the diff is orders of magnitude smaller', () => {
    for (const name of ['SAVE0.DS', UNPLAYED]) {
      const save = load(name);
      const full = JSON.stringify(save.mapTiles).length;
      const small = JSON.stringify(reduceMapTiles(save.header, save.mapTiles)).length;
      expect(small, `${name}: ${small} B diff against ${full} B of tiles`).toBeLessThan(full / 5);
    }
  });
});
