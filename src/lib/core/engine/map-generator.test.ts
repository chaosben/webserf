import { describe, it, expect } from 'vitest';
import {
  OBJECT_SPREAD_GROUP_SIZES,
  createMapGenBuffer,
  decorateMapSteps,
  generateMap,
  generateMapSteps,
} from './map-generator.js';
import { MAP_GEN_BAR, MENU_AREA, MENU_ORIGIN } from '../main-menu.js';
import { Rng } from './rng.js';

const SEED: readonly [number, number, number] = [0xcec9, 0x00f1, 0xe8e4];

/** Run the generation once and collect the step widths of its progress reports. */
function weights(mapSize = 3): number[] {
  const rng = new Rng([SEED[0], SEED[1], SEED[2]]);
  const steps = generateMapSteps(SEED, mapSize, () => () => rng.next());
  const out: number[] = [];
  let r = steps.next();
  while (!r.done) {
    out.push(r.value);
    r = steps.next();
  }
  return out;
}

describe('map generation progress reports', () => {
  /**
   * Eleven reports in the frame `FUN_00007874` (@0x78e2 .. @0x79af), with the stage-10 subchain
   * `FUN_000094f8` (@0x9506 .. @0x9642) spliced in at ninth position.
   */
  it('reports 26 times in exactly the original order', () => {
    expect(weights()).toEqual([
      // frame up to stage 9
      1, 1, 3, 4, 3, 1, 1, 5, 1,
      // stage 10 (`FUN_000094f8`)
      2, 1, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      // gold total and minimap
      1, 1,
    ]);
  });

  it('reports the same sequence regardless of map size', () => {
    // The bar hangs off the generator's structure, not off the number of tiles.
    expect(weights(6)).toEqual(weights(3));
  });

  /**
   * The segment count is not chosen: 26 reports sum to 40, and `16 + 40 * 8` is exactly the right
   * edge of the menu area.
   */
  it('its sum fills exactly the width of the menu area', () => {
    const total = weights().reduce((a, b) => a + b, 0);
    expect(total).toBe(MAP_GEN_BAR.segments);
    expect(MAP_GEN_BAR.x).toBe(MENU_AREA.x);
    expect(MAP_GEN_BAR.x + total * MAP_GEN_BAR.segmentWidth).toBe(MENU_AREA.x + MENU_AREA.width);
  });

  /**
   * The last report sits BEHIND `build_minimap` (@0x799c * @0x79a1 * @0x79af): during the most
   * expensive final preparation the bar stands at 39 of 40, and the last segment coincides with the
   * screen change. The port hangs its own setup (game state + map view) there and relies on exactly
   * this split.
   */
  it('holds the last segment back for the final preparation', () => {
    const w = weights();
    expect(w[w.length - 1]).toBe(1);
    expect(w.slice(0, -1).reduce((a, b) => a + b, 0)).toBe(MAP_GEN_BAR.segments - 1);
  });

  /** The bar sits in the dark strip above the button row (icon row 0x30). */
  it('lies inside the menu area and above the button row', () => {
    expect(MAP_GEN_BAR.y).toBeGreaterThan(MENU_AREA.y);
    expect(MAP_GEN_BAR.y + MAP_GEN_BAR.height).toBeLessThan(MENU_ORIGIN.y + 0x30);
  });

  it('splits the fifteen spreaders into 2*2*2*4*5 like the original', () => {
    expect(OBJECT_SPREAD_GROUP_SIZES).toEqual([2, 2, 2, 4, 5]);
    expect(OBJECT_SPREAD_GROUP_SIZES.reduce((a, b) => a + b, 0)).toBe(15);
  });

  /**
   * A report draws no random number and does not touch the buffer (`FUN_00007a63` only writes
   * `gs+0x188`), so the stepwise run must yield the same map as the straight one - otherwise the
   * result would depend on the display.
   */
  it('does not change the map (stepwise == straight)', () => {
    const a = generateMap(SEED, 3, (s) => {
      const rng = new Rng([s[0], s[1], s[2]]);
      return () => rng.next();
    });
    const rng = new Rng([SEED[0], SEED[1], SEED[2]]);
    const steps = generateMapSteps(SEED, 3, () => () => rng.next());
    let r = steps.next();
    while (!r.done) r = steps.next();
    expect(Array.from(r.value.bytes)).toEqual(Array.from(a.bytes));
  });

  it('reports fifteen times in stage 10, summing to 18', () => {
    const buf = createMapGenBuffer(3);
    const rng = new Rng([SEED[0], SEED[1], SEED[2]]);
    const seen = [...decorateMapSteps(buf, () => rng.next())];
    expect(seen).toHaveLength(15);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(18);
  });
});
