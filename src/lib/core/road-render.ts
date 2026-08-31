/**
 * **Road rendering** — sprite choice for one road segment (masked blitting: a `PathMask` shape over
 * a `PathGround` texture), derived from the archive's sprite layout.
 *
 * Verified against the archive: the mask group from {@link PATH_MASK_BASE} holds **exactly 27
 * sprites** = 3 directions x 9 height-difference steps (dir 0/Right: 0..8, width 32; dir 1/DownRight:
 * 9..17, width 16; dir 2/Down: 18..26, width 16), symmetric around `h_diff = 0`. The ground group from
 * {@link PATH_GROUND_BASE} holds **exactly 10 sprites** (32x20 each) = 3 slope variants x {grass,
 * desert, snow} + 1 water. The selection below follows directly from that.
 */

/** Road mask sprite group (type mask), archive index = `PATH_MASK_BASE + maskIndex(0..26)`. */
export const PATH_MASK_BASE = 229;
/** Road ground texture group (type solid), archive index = `PATH_GROUND_BASE + groundIndex(0..9)`. */
export const PATH_GROUND_BASE = 299;

/** Only these 3 "forward" directions carry a drawn segment (Right=0, DownRight=1, Down=2). */
export const ROAD_DIRS = [0, 1, 2] as const;

/**
 * Mask index (0..26) for a segment in direction `dir` (0/1/2) with height difference `h1 - h2`
 * (source minus target height). `mask = clamp(h_diff, -4, 4) + 4 + dir*9` — the mask encodes the
 * segment slope. The clamp keeps the index inside the group for extreme map heights.
 */
export function pathMaskIndex(dir: number, h1: number, h2: number): number {
  let hDiff = h1 - h2;
  if (hDiff < -4) hDiff = -4;
  else if (hDiff > 4) hDiff = 4;
  return hDiff + 4 + dir * 9;
}

/**
 * Ground texture index (0..9) for a segment. `type` is the governing terrain at the segment (0..15:
 * water 0-3, grass 4-7, desert 8-10, tundra 11-13, snow 14-15); `slopeVariant` (0..2) picks the
 * roughness texture. Water -> 9 (its own texture), snow -> +6, desert/tundra -> +3, grass -> +0.
 *
 * From the binary (`FUN_0000e5cd` among others): `type < 4 -> 309`; otherwise `type > 7` and
 * `type < 14` -> `+3`, `type >= 14` -> `+6`. The **border layer** uses different thresholds for the
 * same bank of ten — see
 * `border-layer.borderGroundIndex`.
 */
export function pathGroundIndex(type: number, slopeVariant: number): number {
  if (type <= 3) return 9; // water
  let s = slopeVariant;
  if (type >= 14) s += 6; // snow
  else if (type >= 8) s += 3; // desert/tundra
  return s;
}

/**
 * Slope variant (0..2) from the secondary cross slope `hDiff2`: steeply uphill -> 0, moderate -> 1,
 * steeply downhill -> 2. **Read from the bytes** (`FUN_0000e5cd`/`e6ca`/`e791`, each
 * `if (hDiff2 - 5 < 0) { if (hDiff2 + 5 < 0) -> 302 else -> 301 } else -> 300`). The **computation**
 * of `hDiff2` is direction dependent and lives in `road-layer.ts`.
 */
export function slopeVariant(hDiff2: number): number {
  if (hDiff2 > 4) return 0;
  if (hDiff2 > -6) return 1;
  return 2;
}
