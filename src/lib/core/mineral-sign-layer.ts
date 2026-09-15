/**
 * **Mineral signs over the whole map** — an addition of ours, switched on by the "hacks" panel and
 * with no counterpart in the original.
 *
 * It draws, on every tile carrying an underground deposit, the very sign a geologist would plant
 * there: same object, same sprite, same place. What it shows is therefore not invented — the rule
 * comes from `engine/mineral-sign.ts`, the module the geologist himself uses.
 *
 * ## It is a pass of its own, deliberately
 *
 * Nothing in the original drawing path changes: this runs AFTER the entity layer, from the frame
 * renderer, and reads the tiles without writing a byte. Three consequences of that position, all of
 * them intended:
 *
 * * **No shadow.** A shadow blit is `dst |= 0x80` on the target, and running last it would darken
 *   serfs and buildings drawn earlier — a darkening the original never produces, because there the
 *   shadow always precedes the objects of its own row. Leaving it out also halves the blit count,
 *   which is the one real cost lever here. A hacked sign therefore stands lighter-footed than a
 *   real one, and that reads as information: **with** a shadow are the finds the game itself knows.
 * * **A tile already carrying a real sign is skipped** — the entity pass draws that same sprite
 *   there. Real signs decay (the growth pass clears `0x70..0x78`) while the mineral bytes stay, so
 *   over time the work for one tile moves back and forth between the two passes. Same sprite, same
 *   position; the only visible difference is that shadow.
 * * Without an archive there are no sprites and the pass simply shows nothing; the colour-triangle
 *   fallback gets no markers of its own.
 *
 * A tile with a building or a flag never yields a sign, and needs no test for it: there the two
 * deposit bytes are the object index instead, so the mineral reads as zero.
 *
 * ## It shows more than a geologist ever could, and that is the point
 *
 * About a third of all deposits lie on tiles WITHOUT mountain terrain (measured over the original
 * saves: 799 of 1257, 713 of 1142, 670 of 1068 are on mountain). A geologist never reports those —
 * he only samples terrain 11..14. They are mined all the same: the miner's own search
 * (`miningSearch`) is terrain-blind, taking a random one of the 32 nearest spiral positions around
 * the mine and testing nothing but the mineral type and the object on it.
 */

import type { Blitter, DrawImage, KitSprite } from './draw-target.js';
import { blitSprite } from './draw-target.js';
import { isMineralSign, mineralSignObject } from './engine/mineral-sign.js';
import { mapObjectSprite } from './map-render.js';
import { entityAnchor, type WindowFrame } from './window-frame.js';

/** What the pass needs from a tile. */
export interface MineralTileData {
  readonly height: number;
  readonly object: number;
  /** Underground mineral 0..4; 0 = none. */
  readonly mineral: number;
  readonly resourceAmount: number;
}

export interface MineralSignLayerInput<Img extends DrawImage> {
  readonly tiles: readonly MineralTileData[];
  /** Pixels per height step (original 4). */
  readonly heightUnit: number;
  /**
   * Game tick. Signs are static, so it changes nothing here — but `mapObjectSprite` demands it so
   * that no call site draws the animated range as static by accident.
   */
  readonly tick: number;
  /** Transparent sprite by archive index; `null` => skip. */
  readonly sprite: (index: number) => KitSprite<Img> | null;
}

/**
 * Blits a sign onto every visible deposit.
 *
 * It blits instead of returning markers: roughly a third of the visited positions is a hit, and at
 * low zoom the traversal covers a multiple of the map — a marker list would be tens of thousands of
 * allocations per frame.
 *
 * Positions come from the **traversal**, as in every pass: the anchor is `entityAnchor`, lifted by
 * the tile height. Computing them from `col/row` through the camera would make the signs stick in
 * the middle while the ground repeats around them.
 */
export function drawMineralSigns<Img extends DrawImage>(
  target: Blitter<Img>,
  frame: WindowFrame,
  input: MineralSignLayerInput<Img>,
): void {
  const { tiles, heightUnit, tick, sprite } = input;

  for (let i = 0; i < frame.halfRows.length; i++) {
    const hr = frame.halfRows[i]!;
    for (let k = 0; k < hr.tiles.length; k++) {
      const t = tiles[hr.tiles[k]!];
      if (t === undefined || t.mineral === 0) continue; // cheapest test first, and the fish gate
      if (isMineralSign(t.object)) continue; // the game already draws it there
      const index = mapObjectSprite(mineralSignObject(t.mineral, t.resourceAmount), tick);
      if (index === null) continue;
      const flat = entityAnchor(frame, i, k);
      blitSprite(target, sprite(index), flat.x, flat.y - t.height * heightUnit);
    }
  }
}
