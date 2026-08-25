/**
 * Building sprite choice (pure lookups, backend independent).
 *
 * Every building is drawn from the map object sprite space: a logical offset per building type picks
 * the sprite (`MAP_OBJECT_BASE + offset`) and the matching shadow (`MAP_SHADOW_BASE + offset`).
 * Finished buildings use `MAP_BUILDING_SPRITE`; those under construction go through several phases
 * (cross -> cornerstone/scaffold -> full scaffold + growing building), and the castle is a special
 * case.
 *
 * The "growing in" (progress 0..1) happens while drawing: only the lower `height*progress` rows of the
 * sprite are shown, anchored at the ground — the building grows upwards from below.
 */

import { MAP_OBJECT_BASE, MAP_SHADOW_BASE } from './map-render.js';

export { MAP_OBJECT_BASE, MAP_SHADOW_BASE };

/**
 * Building type (0..24) -> logical sprite offset in the map object space (finished building).
 * Index 0 (none) -> 0 (no sprite). The order matches `BUILDING_TYPE_NAMES`.
 */
// prettier-ignore
export const MAP_BUILDING_SPRITE: readonly number[] = [
  0x00, 0xa7, 0xa8, 0xae, 0xa9,
  0xa3, 0xa4, 0xa5, 0xa6,
  0xaa, 0xc0, 0xab, 0x9a, 0x9c, 0x9b, 0xbc,
  0xa2, 0xa0, 0xa1, 0x99, 0x9d, 0x9e, 0x98, 0x9f, 0xb2,
];

/**
 * Building type (0..23) -> scaffold sprite offset. Only 24 entries — the castle (type 24) has no
 * scaffold entry and is handled separately.
 */
// prettier-ignore
export const MAP_BUILDING_FRAME_SPRITE: readonly number[] = [
  0x00, 0xba, 0xba, 0xba, 0xba,
  0xb9, 0xb9, 0xb9, 0xb9,
  0xba, 0xc1, 0xba, 0xb1, 0xb8, 0xb1, 0xbb,
  0xb7, 0xb5, 0xb6, 0xb0, 0xb8, 0xb3, 0xaf, 0xb4,
];

/** Cross/marker sprite at the start of construction (progress == 0). */
export const BUILD_CROSS = 0x90;
/** Cornerstone sprite in the foundation phase (progress > 0, bit 15 not set). */
export const BUILD_CORNERSTONE = 0x91;
/** Castle sprite (special case under construction: it grows in directly by progress). */
export const CASTLE_SPRITE = 0xb2;

/** Building type index of the castle. */
export const BUILDING_TYPE_CASTLE = 24;

/**
 * One drawing step: logical sprite offset (into the object/shadow space) plus the vertical growth
 * fraction `progress` (0..1, 1 = fully visible). It always stands for shadow (overlay,
 * `MAP_SHADOW_BASE + offset`) AND building (transparent, `MAP_OBJECT_BASE + offset`) at the same
 * offset, both with the same fraction. The ops are drawn in list order.
 */
export interface BuildingDrawOp {
  readonly offset: number;
  readonly progress: number;
}

/** Clamps a growth fraction to [0,1]. */
function clamp01(p: number): number {
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * The drawing steps for a building, depending on completion and construction progress.
 *
 * @param type     building type 0..24 (0 = none -> empty list)
 * @param done     `true` = finished, `false` = under construction
 * @param progress construction progress (u16; bit 15 = "scaffold done, walls going up"), relevant only
 *                 when `!done`
 */
export function buildingDrawOps(type: number, done: boolean, progress: number): BuildingDrawOp[] {
  if (type <= 0 || type >= MAP_BUILDING_SPRITE.length) return [];

  if (done) {
    return [{ offset: MAP_BUILDING_SPRITE[type], progress: 1 }];
  }

  // --- under construction ---
  if (type === BUILDING_TYPE_CASTLE) {
    // Castle: no scaffold, the castle sprite grows in directly by progress.
    return [{ offset: CASTLE_SPRITE, progress: clamp01(progress / 0xffff) }];
  }

  if (progress === 0) {
    // Start of construction: only a cross/marker.
    return [{ offset: BUILD_CROSS, progress: 1 }];
  }

  const frame = MAP_BUILDING_FRAME_SPRITE[type];

  if ((progress & 0x8000) !== 0) {
    // Scaffold done: full scaffold with the finished building growing in above it.
    return [
      { offset: frame, progress: 1 },
      { offset: MAP_BUILDING_SPRITE[type], progress: clamp01((2 * (progress & 0x7fff)) / 0xffff) },
    ];
  }

  // Foundation phase: full cornerstone, and from progress > 1 the scaffold growing in as well.
  const ops: BuildingDrawOp[] = [{ offset: BUILD_CORNERSTONE, progress: 1 }];
  if (progress > 1) {
    ops.push({ offset: frame, progress: clamp01((2 * progress) / 0xffff) });
  }
  return ops;
}
