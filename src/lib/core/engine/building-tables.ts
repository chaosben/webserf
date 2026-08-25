/**
 * Binary tables of the building/construction subsystem, lifted verbatim from the original — data,
 * not logic.
 */

/**
 * `build_progress_step` (`TAB_000257ad`) — construction progress increment per building type and
 * phase. The builder (state 09) adds it to `building.progress` per work iteration; when the u16
 * overflows the building is finished. Two entries per type: phase 0 (`progress >= 0`) and phase 1
 * (`progress` with bit 15 set, i.e. negative as i16). Index = `type*2 + phase`.
 */
// prettier-ignore
export const BUILD_PROGRESS_STEP: readonly number[] = [
  //   Phase0 Phase1
  0,    0,     // 0  None (the castle builds via state 10, not 09)
  4096, 4096,  // 1  Fisher
  4096, 4096,  // 2  Lumberjack
  4096, 2048,  // 3  Boatbuilder
  4096, 4096,  // 4  Stonecutter
  2048, 1366,  // 5  StoneMine
  2048, 1366,  // 6  CoalMine
  2048, 1366,  // 7  IronMine
  2048, 1366,  // 8  GoldMine
  4096, 4096,  // 9  Forester
  1366, 1024,  // 10 Warehouse
  4096, 4096,  // 11 Hut
  2048, 1366,  // 12 Farm
  4096, 2048,  // 13 Butcher
  2048, 1366,  // 14 PigFarm
  2048, 2048,  // 15 Mill
  4096, 2048,  // 16 Baker
  2048, 1366,  // 17 Sawmill
  2048, 1366,  // 18 SteelSmelter
  2048, 1024,  // 19 ToolMaker
  4096, 2048,  // 20 WeaponSmith
  2048, 1366,  // 21 Tower
  1024, 683,   // 22 Fortress
  2048, 1366,  // 23 GoldSmelter
  0,    0,     // 24 Castle (builds via state 10 BuildingCastle)
];

/**
 * `build_material_need` (`TAB_0002576d`) — material bitmask per building type: bit `n` says what the
 * `n`-th construction step needs, **0 = plank** (stock slot 0), **1 = stone** (stock slot 1). The
 * builder reads bit `field_0xe & 0xf`.
 *
 * Fortress (22) = 496 = `0b111110000` — four planks, then five stones.
 */
// prettier-ignore
export const BUILD_MATERIAL_NEED: readonly number[] = [
  0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 56, 2, 8, 2, 8, 4, 4, 12, 20, 44, 2, 28, 496, 4, 0,
];

/**
 * `building_score` (`DAT_00003fac`) — build score per building type, added to
 * `player.totalBuildingScore` (`player+0x116`) on completion.
 */
// prettier-ignore
export const BUILDING_SCORE: readonly number[] = [
  0, 2, 2, 2, 2, 5, 5, 5, 5, 2, 10, 3, 6, 4, 6, 5, 4, 7, 7, 9, 4, 8, 15, 6, 20,
];

/** One stock slot of the building record (`bld+8` / `bld+9`) as a decoded nibble pair. */
interface StockSlotView {
  readonly available: number;
  readonly requested: number;
}

/**
 * **The raw byte of a stock slot** — `bld+8` (k=0) or `bld+9` (k=1).
 *
 * The original computes on the *byte*, not on the nibbles: delivery adds `0x0f`
 * (@0x22c74/@0x22c84), road teardown decrements by `1` (@0x4b014 ff.), the garrison request by
 * `0x10` (@0x12822). Porting such a site means seeing the same byte, so the access lives here once
 * instead of as a local `(a << 4) | r` in six places.
 */
export function buildingStockByte(bld: { readonly stock: readonly StockSlotView[] }, k: number): number {
  const s = bld.stock[k];
  if (s === undefined) return 0;
  return (((s.available & 0xf) << 4) | (s.requested & 0xf)) & 0xff;
}

/**
 * **The inventory marker** — plain `cmpb $0xff,0x8(%ebx)` in the original, at **nine** sites
 * (@0x18132 · @0x1898b · @0x1d370 · @0x1d964 · @0x20836 · @0x23e3b · @0x2cccc · @0x4b014 · @0x544a5).
 *
 * It says "this building keeps an inventory, its stock nibbles are not a resource count". Four sites
 * set it (`bld[8] = 0xffff`, i.e. **both** slots): founding the castle (@0x2926a), activating a
 * warehouse (@0x15310), the castle garrison request (@0x15062) and delivery into the inventory
 * (@0x22c91) — the last two *restore* it after ordinary stock arithmetic has changed it.
 *
 * **Why a function and not a field**: the marker is a *value* of the byte, not a side state. As its
 * own field it would go stale on every byte computation — and lie exactly when it matters. This way the byte is
 * the single source.
 */
export function hasInventoryMarker(bld: { readonly stock: readonly StockSlotView[] }): boolean {
  return buildingStockByte(bld, 0) === 0xff;
}
