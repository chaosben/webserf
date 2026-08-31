/**
 * Map generator - port of `FUN_00007874`. Deterministic: same seed, same map, tile for tile.
 *
 * The seed comes from the setup record inside the executable for level and mission games, and from the
 * main menu (`.DS`@138) otherwise; in both cases it is XORed with `0x5a5a / 0xa5a5 / 0xc3c3`. The
 * frame then draws TWO values up front before the first stage runs - drop those and the map differs.
 *
 * The map memory is ROW-INTERLEAVED, not `pos << 2`: each row holds its `cols` landscape tuples first
 * and its `cols` game tuples behind them, so the row stride is `cols * 8`. This is the same layout the
 * save game uses, because the save game is a RAM dump.
 *
 * ```
 * byteOffset(col,row) = (row << (rowShift+3)) | (col << 2)   // landscape layer
 * game layer          = that offset + (cols << 2)
 * ```
 *
 * Two consequences one loses when rebuilding this:
 * - A column step past the last column lands in the LAYER bit, which is not part of the overall mask,
 *   so the step wraps back into its OWN row rather than into the next one. That is why
 *   `(offset & colMask) === 0` is a sufficient loop end everywhere.
 * - For the same reason {@link sumMapGold} can use the same ring loop over the game layer.
 *
 * | gs | here | meaning |
 * |---|---|---|
 * | `gs+0x00` | {@link MapGenBuffer.mask} | overall mask |
 * | `gs+0x3a` | {@link MapGenBuffer.colMask} | column mask `(cols-1) << 2` |
 * | `gs+0x0c` | {@link MapGenBuffer.down} | direction Down |
 * | `gs+0x18` | {@link MapGenBuffer.up} | direction Up |
 * | `gs+0x36` | {@link MapGenBuffer.layerOffset} | landscape -> game layer (`cols << 2`) |
 *
 * Eleven stages with a progress report between them; the report is pure UI and draws no random number.
 * After the last stage come the gold sum and building the minimap.
 *
 * | # | original | here |
 * |---|---|---|
 * | 1 | `FUN_00007ec5` | {@link clearMap} |
 * | 2 | `FUN_00007efc` | {@link seedHeights} |
 * | 3 | `FUN_00008000` | {@link refineHeights} |
 * | 4 | `FUN_000082e5` | {@link limitHeightSlopes} |
 * | 5 | `FUN_00008b99` | {@link carveLakes} |
 * | 6 | `FUN_000084aa` | {@link dropToWaterline} |
 * | 7 | `FUN_000089e2` | {@link assignTerrain} |
 * | 8 | `FUN_00008569` | {@link keepLargestLandmass} |
 * | 9 | `FUN_00008508` | {@link compressHeights} |
 * | 10 | `FUN_000094f8` | {@link decorateMap} - itself a sub-pipeline |
 * | 11 | `FUN_0000947a` | {@link markWaterTiles} |
 * | - | `FUN_000079cc` | {@link sumMapGold} |
 *
 * The header field `mapGoldTotal` (@184) is not a pure generation value: building over a gold tile
 * subtracts its remaining amount (@0x309e6).
 */
import { mapGeometry, type MapGeometry } from './position.js';
import { SPIRAL_PATTERN } from './spiral.js';

/** The three mask constants of the seed derivation (`@0x4fe70`..`@0x4fe8c`). */
export const SEED_XOR = [0x5a5a, 0xa5a5, 0xc3c3] as const;

/** Base of the setup table in the executable; record size `0x24`. */
export const SETUP_TABLE_BASE = 0x61442;

/**
 * Water level and largest lake ring — two literals in `FUN_000076bb` (`mov $0x14,%ax` @0x76bb ->
 * `gs+0x44`, `mov $0xe,%ax` @0x76c6 -> `gs+0x46`). They are CONSTANTS, not a game setting: that init
 * routine is their only writer.
 */
export const WATER_LEVEL = 0x14;
/** See {@link WATER_LEVEL}. */
export const LAKE_RING_MAX = 0x0e;

/**
 * The map during generation — a flat byte array as in the original.
 *
 * `bytes` is `tileCount · 8` long and row-interleaved (see the module header). All offsets are byte
 * offsets, and every step goes through {@link wrap}.
 */
export interface MapGenBuffer {
  readonly geo: MapGeometry;
  readonly bytes: Uint8Array;
  /** `gs+0x00` — overall mask (row mask | column mask). */
  readonly mask: number;
  /** `gs+0x3a` — column mask `(cols-1) << 2`. */
  readonly colMask: number;
  /** `gs+0x08` — direction DownRight. */
  readonly downRight: number;
  /** `gs+0x0c` — direction Down. */
  readonly down: number;
  /** `gs+0x10`, or `gs+0x60` in word form — direction Left. */
  readonly left: number;
 /** `gs+0x14` — direction UpLeft. */
  readonly upLeft: number;
 /** `gs+0x18` — direction Up. */
  readonly up: number;
 /** `gs+0x1c` — direction UpRight (`up | right`, @0x7c8a); closes the 3x3 walk of stage 10. */
  readonly upRight: number;
 /** `gs+0x36` — distance landscape layer -> game layer within the row. */
  readonly layerOffset: number;
 /** `gs+0x32` — column mask as a **tile** index (`cols-1`), not as a byte offset. */
  readonly colMaskTiles: number;
 /** `gs+0x34` — row mask as a tile index (`rows-1`). */
  readonly rowMaskTiles: number;
 /**
  * `gs+0x21c` — `(cols >> 5) * (rows >> 5)`, the quantity unit of every stage-10 scatter pass
  * (@0x7c5c..@0x7c74). For 64x64 that is **4**.
  *
  * The same number times 500 is `serfBudget` (@0x7c7e -> header @176), and that `>> 3` is
  * `populationBase` (@0x7c8c -> header @198).
  */
  readonly objectCount: number;
}

/** Allocate the buffer for a map of the given size (all zero, i.e. the state after stage 1). */
export function createMapGenBuffer(mapSize: number): MapGenBuffer {
  const geo = mapGeometry(mapSize);
  const rowMask = (geo.rows - 1) << (geo.rowShift + 3);
  const colMask = (geo.cols - 1) << 2;
  const rowStride = geo.cols << 3;
  const down = rowStride & rowMask;
  const up = -rowStride & rowMask;
  const left = -4 & colMask;
  return {
    geo,
    bytes: new Uint8Array(geo.tileCount * 8),
    mask: rowMask | colMask,
    colMask,
    downRight: down | 4,
    down,
    left,
    upLeft: up | left,
    up,
    upRight: up | 4,
    layerOffset: geo.cols << 2,
    colMaskTiles: geo.cols - 1,
    rowMaskTiles: geo.rows - 1,
    objectCount: (geo.cols >> 5) * (geo.rows >> 5),
  };
}

/** Byte offset of landscape tile `(col,row)` — the address formula from the module header. */
export function mapByteOffset(buf: MapGenBuffer, col: number, row: number): number {
  return (row << (buf.geo.rowShift + 3)) | (col << 2);
}

/** The original torus wrap: `and` against the full mask (32 bit). */
function wrap(buf: MapGenBuffer, offset: number): number {
  return offset & buf.mask;
}

/**
 * The same wrap, but **16 bit** — for the column step the original uses `addw $0x4,(%edi)` +
 * `and %ax,(%edi)` throughout (e.g. @0x833b/@0x8345, @0x7a17/@0x7a21), so only the *low word* of the
 * offset. While `tileCount * 8 <= 65536` (up to `mapSize` 4) both are equivalent; above that the
 * original drops the high bits, and so does this port.
 */
function wrap16(buf: MapGenBuffer, offset: number): number {
  return (offset & ~0xffff) | (offset & buf.mask & 0xffff);
}

/**
 * Build a multiple of the tile stride — in the original a chain of `add`+`and`, because there is no
 * masked shift. The column step runs **16 bit** (@0x7f18..@0x7f66), the row step **32 bit**
 * (@0x7f68..@0x7f7f); the asymmetry is reproduced, not smoothed away.
 */
function doubled(buf: MapGenBuffer, start: number, times: number, wide: boolean): number {
  let v = start;
  for (let i = 0; i < times; i++) v = wide ? wrap(buf, v + v) : wrap16(buf, v + v);
  return v;
}

/**
 * **Stage 1** (`FUN_00007ec5` @0x7ec5) — clear both map layers.
 *
 * The original runs `tileCount` times writing two u32 each (`@0x7ed8`/`@0x7edd`), covering
 * `tileCount * 8` bytes — landscape **and** game layer in one pass.
 */
export function clearMap(buf: MapGenBuffer): void {
  buf.bytes.fill(0);
}

/**
 * **Stage 2** (`FUN_00007efc` @0x7efc) — random heights on a coarse support grid.
 *
 * The stride is **16 tiles** (four doublings from 4 resp. from `gs+0x0c`, @0x7f18..@0x7f7f) in both
 * directions. One random number per support point, clamped to **0xfa** — in ASM
 * `cmpb $0xfb,%al ; jb ; mov $0xfa,%al` (@0x7fb7). Written is **byte 1** of the landscape tile
 * (`mov %al,0x1(%ebx)` @0x7fca), the height/owner byte.
 *
 * Heights are 0..250 here and do **not** fit the later 5 height bits — a later stage scales them down.
 */
export function seedHeights(buf: MapGenBuffer, rng: () => number): void {
  const colStep = doubled(buf, 4, 4, false);
  const rowStep = doubled(buf, buf.down, 4, true);
  let offset = 0;
  do {
    do {
      let h = rng() & 0xff;
      if (h > 0xfa) h = 0xfa;
      buf.bytes[offset + 1] = h;
      offset = wrap(buf, offset + colStep);
    } while ((offset & buf.colMask) !== 0);
    offset = wrap(buf, offset + rowStep);
  } while (offset !== 0);
}

/**
 * Midpoint of two support points plus noise (`FUN_00008277` @0x8277).
 *
 * ```
 * vreg1 = (a + b) >> 1 @0x8277..@0x8287 (16 bit, unsigned)
 * rng ; dx:ax = rng * amplitude ; rorl $0x10 @0x828b..@0x82ab => HIGH word
 * vreg7 = hi - bias + vreg1 @0x82af..@0x82bb
 * negative => 0 (`jns` @0x82c6) ; from 0xfb => 0xfa (@0x82d1)
 * ```
 *
 * **The excursion is asymmetric.** `hi(rng * A)` is uniform in `[0, A)`, `bias` is
 * `hi(A * 0x9999)`, roughly `0.6 * A` — so the random part lies in `[-0.6*A, +0.4*A)` and pulls
 * heights **down**. A symmetric `+/- A/2` (the obvious guess) yields systematically higher maps and
 * therefore too little water.
 *
 * **`a` and `b` are 16 bit although heights are bytes.** The caller puts both into a word register
 * **bytewise** (`mov %al,0x18/0x1c(%edi)`) and this routine reads them as a **word**
 * (`mov 0x18(%edi),%ax`) — the high byte is whatever was in the register before. That matters exactly
 * once per map, see {@link refineHeights}.
 */
function midpoint(a: number, b: number, amplitude: number, bias: number, rng: () => number): number {
  const mid = ((a + b) & 0xffff) >>> 1;
  const noise = ((rng() & 0xffff) * (amplitude & 0xffff)) >>> 16;
  const v = (noise - bias + mid) & 0xffff;
  if ((v & 0x8000) !== 0) return 0; // `or ax,ax ; jns` — negative clamps to 0
  return v >= 0xfb ? 0xfa : v;
}

/**
 * **Stage 3** (`FUN_00008000` @0x8000) — midpoint displacement down to tile resolution.
 *
 * The initial stride is **8 tiles** (three doublings, `@0x8006`..`@0x8036`). The amplitude is
 * `(rng & 0x7f) + 0x80` (@0x803e), i.e. 128..255. Three midpoints per cell — right, down and
 * diagonal — then stride **and** amplitude halve; the loop ends once the column stride reaches 2
 * (@0x82dd), so it runs down to the single tile.
 */
export function refineHeights(buf: MapGenBuffer, rng: () => number): void {
  let colStep = doubled(buf, 4, 3, false);
  let rowStep = doubled(buf, buf.down, 3, true);

 // The amplitude draw lands in vreg7 **in full** (@0x807a -> `mov 0x1c(%edi),%ax` @0x807f); only the
 // low 7 bits are used — the high byte stays behind and becomes part of the first support value below.
  let vreg7 = rng() & 0xffff;
  let amplitude = ((vreg7 & 0x7f) + 0x80) & 0xffff;
 // `imul $0x9999` + `rorl $0x10` (@0x8048..@0x8056) — the high word, roughly 0.6 * amplitude.
  let bias = ((amplitude * 0x9999) >>> 16) & 0xffff;
 // On entry vreg6 holds `gs+0x30` as a **word** (`mov %ax,0x18(%edi)` @0x7f0c, stage 2). For every
 // map size that is <= 255, so the high byte is 0 — the effect above does not bite here.
  let vreg6 = (buf.geo.rowShift + 1) & 0xffff;

  while (colStep !== 2) {
    let offset = 0;
    do {
      do {
 // Both registers only get their **low byte** set (@0x80c8/@0x80fd/@0x8154/@0x81cb).
        vreg6 = (vreg6 & 0xff00) | (buf.bytes[offset + 1] ?? 0);
        const colOnce = wrap16(buf, offset + colStep);
        const right = wrap16(buf, colOnce + colStep);
        const down = wrap(buf, wrap(buf, offset + rowStep) + rowStep);
        const diag = wrap(buf, wrap(buf, right + rowStep) + rowStep);

        vreg7 = (vreg7 & 0xff00) | (buf.bytes[right + 1] ?? 0);
        vreg7 = midpoint(vreg6, vreg7, amplitude, bias, rng);
        buf.bytes[colOnce + 1] = vreg7 & 0xff;

        vreg7 = (vreg7 & 0xff00) | (buf.bytes[down + 1] ?? 0);
        vreg7 = midpoint(vreg6, vreg7, amplitude, bias, rng);
        buf.bytes[wrap(buf, offset + rowStep) + 1] = vreg7 & 0xff;

        vreg7 = (vreg7 & 0xff00) | (buf.bytes[diag + 1] ?? 0);
        vreg7 = midpoint(vreg6, vreg7, amplitude, bias, rng);
        buf.bytes[wrap(buf, colOnce + rowStep) + 1] = vreg7 & 0xff;

        offset = right;
      } while ((offset & buf.colMask) !== 0);
      offset = wrap(buf, wrap(buf, offset + rowStep) + rowStep);
    } while (offset !== 0);

 // Amplitude AND bias halve along with the stride (@0x82c9..@0x82db).
    bias = (bias >>> 1) & 0xffff;
    amplitude = (amplitude >>> 1) & 0xffff;
    rowStep >>>= 1;
    colStep >>>= 1;
  }
}

/**
 * Clamp a neighbour tile's height to `+/- 0x20` around `here`.
 *
 * The body appears **twice byte-identically** in the binary — @0x83c6 and @0x8438, 114 bytes each,
 * **0 differences**. Watcom inlined the same helper at both call sites; here it is one function.
 *
 * ```
 * diff = here - there (16 bit)
 * jns => there <= here : from diff >= 0x21, there = here - 0x20
 * else there > here    : from |diff| >= 0x21, there = here + 0x20
 * every adjustment sets the changed flag (`mov $0xffffffff` @0x83ea/@0x8422)
 * ```
 *
 * The bound is `cmpw $0x21 ; jb` — a difference of **exactly 32 stays**, only 33 is adjusted. Only
 * the low byte is written (`mov %al,0x1(%ebx)`); overflow is practically impossible because the branch
 * only runs for `here < 218` resp. `here > 32` — the byte width is reproduced anyway.
 *
 * @returns whether an adjustment was made
 */
function clampNeighbourHeight(buf: MapGenBuffer, offset: number, here: number): boolean {
  const diff = (here - (buf.bytes[offset + 1] ?? 0)) & 0xffff;
  if ((diff & 0x8000) !== 0) {
    if ((-diff & 0xffff) < 0x21) return false;
    buf.bytes[offset + 1] = (here + 0x20) & 0xff;
    return true;
  }
  if (diff < 0x21) return false;
  buf.bytes[offset + 1] = (here - 0x20) & 0xff;
  return true;
}

/**
 * **Stage 4** (`FUN_000082e5` @0x82e5) — limit slopes.
 *
 * After the displacement neighbouring heights can be arbitrarily far apart. This stage walks the map
 * tile by tile and pulls **three** neighbours to within +/-32 of the current tile: down, down-right,
 * right. The original gets there by a chain of direction steps, not by index arithmetic — `+Down`
 * (@0x8318), `+4` (@0x833b), `+Up` (@0x8368) — and because the last step restores the starting row,
 * the walker then stands on the next column and the loop needs no advance step of its own.
 *
 * The whole pass **repeats** while any adjustment happened (@0x83bf), so the clamping propagates
 * across the map until no difference > 32 is left. One pass does not suffice, because a lowered
 * neighbour may in turn sit too far above its own neighbour.
 *
 * Branch inventory: one `ret` (@0x83c5), reached only via the changed-flag test; both loop exits
 * (@0x839d column, @0x83b2 row) return to the same head. **No `call rng_next`** in the window
 * `[0x82e5, 0x84aa)` — this stage does not shift the random stream.
 */
export function limitHeightSlopes(buf: MapGenBuffer): void {
  let changed: boolean;
  do {
    changed = false;
    let offset = 0;
    do {
      do {
        const here = buf.bytes[offset + 1] ?? 0;

        offset = wrap(buf, offset + buf.down);
        if (clampNeighbourHeight(buf, offset, here)) changed = true;

        offset = wrap16(buf, offset + 4);
        if (clampNeighbourHeight(buf, offset, here)) changed = true;

        offset = wrap(buf, offset + buf.up);
        if (clampNeighbourHeight(buf, offset, here)) changed = true;
      } while ((offset & buf.colMask) !== 0);
      offset = wrap(buf, offset + buf.down);
    } while (offset !== 0);
  } while (changed);
}

/**
 * The six neighbours of a tile — in the **step order of the original**, not as a table.
 *
 * The original walks `+Right`, `+Down`, `+Left`, `+UpLeft`, `+Up`, `+Right` and thereby visits
 * Right, DownRight, Down, Left, UpLeft, Up in turn: each step leads from the *previous* neighbour to
 * the next, because opposite directions cancel (`D + UL == L`). That is why there is no neighbour
 * table anywhere in the binary — and why the ring walk of the lake growth (see {@link ringSteps})
 * uses the same steps in a different order.
 *
 * The step **widths** are reproduced: `+Right` and `+Left` run 16 bit (`addw`/`and %ax`), the rest
 * 32 bit.
 */
function neighbours(buf: MapGenBuffer, pos: number): [number, number, number, number, number, number] {
  const right = wrap16(buf, pos + 4);
  const downRight = wrap(buf, right + buf.down);
  const down = wrap16(buf, downRight + buf.left);
  const left = wrap(buf, down + buf.upLeft);
  const upLeft = wrap(buf, left + buf.up);
  const up = wrap16(buf, upLeft + 4);
  return [right, downRight, down, left, upLeft, up];
}

/** One step of the ring walk: delta and width (`false` == 16 bit). */
interface RingStep {
  readonly delta: number;
  readonly wide: boolean;
}

/**
 * The six edges of a hex ring, in the order of the original
 * (Down, Left, UpLeft, Up, Right, DownRight).
 */
function ringSteps(buf: MapGenBuffer): readonly RingStep[] {
  return [
    { delta: buf.down, wide: true },
    { delta: buf.left, wide: false },
    { delta: buf.upLeft, wide: true },
    { delta: buf.up, wide: true },
    { delta: 4, wide: false },
    { delta: buf.downRight, wide: true },
  ];
}

function step(buf: MapGenBuffer, pos: number, s: RingStep): number {
  return s.wide ? wrap(buf, pos + s.delta) : wrap16(buf, pos + s.delta);
}

/** Centre to `0xff`, its six neighbours to `0xfe` (@0x8e4c..@0x8ef0, unconditional). */
function markLakeCentre(buf: MapGenBuffer, pos: number): void {
  buf.bytes[pos + 1] = 0xff;
  for (const n of neighbours(buf, pos)) buf.bytes[n + 1] = 0xfe;
}

/**
 * Grow a lake around one tile (`FUN_000091cc` @0x91cc).
 *
 * Checks the six neighbours: if one lies **above** the water level (and is not a marker, i.e.
 * `< 0xfe`), abort; if at least one borders an existing lake centre (`0xff`), the tile becomes a
 * centre itself. Painting the neighbours leaves existing centres alone (`if (h != 0xff)` @0x9302 ff.)
 * — unlike {@link markLakeCentre}.
 *
 * @returns whether the tile newly became a centre (the ring flag `vreg9` in the original)
 */
function growLakeAt(buf: MapGenBuffer, pos: number, level: number): boolean {
  let touchesLake = false;
  for (const n of neighbours(buf, pos)) {
    const h = buf.bytes[n + 1] ?? 0;
    if (h < 0xfe) {
      if (h > level) return false;
    } else if (h === 0xff) {
      touchesLake = true;
    }
  }
  if (!touchesLake) return false;
  buf.bytes[pos + 1] = 0xff;
  for (const n of neighbours(buf, pos)) {
    if (buf.bytes[n + 1] !== 0xff) buf.bytes[n + 1] = 0xfe;
  }
  return true;
}

/**
 * Flood one basin (`FUN_00008d7e` @0x8d7e — including the fall-through tail from @0x8ef1, which
 * Ghidra attributes to the same body).
 *
 * First the basin test: if **any** of the six neighbours lies above the water level, the tile is set
 * to `0` and nothing else happens (@0x8e3c) — so `0` is the marker "below water height, but on the
 * shore". Otherwise the tile becomes a centre and the lake grows outward in a spiral while a whole
 * ring still gained something (at most {@link LAKE_RING_MAX} rings).
 *
 * Then a **second** spiral over `LAKE_RING_MAX + 1` rings lowers every marker by 2: `0xff -> 0xfd`,
 * `0xfe -> 0xfc`. Only these two values are read by the caller — the intermediate `0xff`/`0xfe` serve
 * the growth alone, so a freshly flooded tile stays distinguishable from a finished one.
 *
 * The second spiral **always** runs all 15 rings, even if the first aborted early: the original does
 * compute a bound from the ring it reached (around @0x8f01) but immediately overwrites it with
 * `gs+0x46 + 1` — a dead store, reproduced faithfully.
 */
function floodBasin(buf: MapGenBuffer, centre: number, level: number): void {
  for (const n of neighbours(buf, centre)) {
    if ((buf.bytes[n + 1] ?? 0) > level) {
      buf.bytes[centre + 1] = 0;
      return;
    }
  }

  markLakeCentre(buf, centre);
  const steps = ringSteps(buf);

  let pos = centre;
  for (let ring = 0; ; ring++) {
    let grew = false;
    pos = wrap16(buf, pos + 4);
    for (const s of steps) {
      for (let i = 0; i <= ring; i++) {
        if (growLakeAt(buf, pos, level)) grew = true;
        pos = step(buf, pos, s);
      }
    }
    if (!grew || ring + 1 === LAKE_RING_MAX) break;
  }

  pos = centre;
  if ((buf.bytes[pos + 1] ?? 0) > 0xfd) buf.bytes[pos + 1] -= 2;
  for (let ring = 0; ring <= LAKE_RING_MAX; ring++) {
    pos = wrap16(buf, pos + 4);
    for (const s of steps) {
      for (let i = 0; i <= ring; i++) {
        if ((buf.bytes[pos + 1] ?? 0) > 0xfd) buf.bytes[pos + 1] -= 2;
        pos = step(buf, pos, s);
      }
    }
  }
}

/**
 * **Stage 5** (`FUN_00008b99` @0x8b99) — carve the lakes and lift the rest above the waterline.
 *
 * Two passes. The first walks the heights **ascending** from 0 to {@link WATER_LEVEL} and calls
 * {@link floodBasin} for every tile of that height, i.e. from the deepest basin upward. Because
 * flooding replaces heights by markers, each tile is touched at most once: flooded ones then carry
 * `0xfd`/`0xfc`, failed ones `0`, and neither matches a later height.
 *
 * The second pass turns the markers into real heights:
 *
 * | marker | meaning | becomes |
 * |---|---|---|
 * | `0` | below the waterline but on the shore | `level + 1` — i.e. **land** |
 * | `0xfd` | lake centre | `level - 1`, plus fish `rng & 7` in the game layer and `paths` bit 6 |
 * | `0xfc` | lake edge | `level` |
 *
 * Anything above the level is untouched. After this stage the waterline is an **exact** height rather
 * than a threshold, and there is water only where a real basin was.
 *
 * Randomness is drawn **only** for the fish (`call rng_next` @0x8c7b) — the flood algorithm itself is
 * deterministic.
 *
 * Branch inventory: one `ret` (@0x8cfc), reached via `js` @0x8bc4 (negative level => return at once)
 * and via the row exit of the second pass (@0x8cf6).
 */
export function carveLakes(buf: MapGenBuffer, rng: () => number): void {
  const level = WATER_LEVEL;
  if (level < 0) return; // `or %ax,%ax ; js 0x8cfc` @0x8bc1 — constantly false here

  for (let height = 0; height <= level; height++) {
    let offset = 0;
    do {
      do {
        if ((buf.bytes[offset + 1] ?? 0) === height) floodBasin(buf, offset, level);
        offset = wrap16(buf, offset + 4);
      } while ((offset & buf.colMask) !== 0);
      offset = wrap(buf, offset + buf.down);
    } while (offset !== 0);
  }

  let offset = 0;
  do {
    do {
      const marker = buf.bytes[offset + 1] ?? 0;
      if (marker === 0) {
        buf.bytes[offset + 1] = level + 1;
      } else if (marker === 0xfd) {
        buf.bytes[buf.layerOffset + offset] = rng() & 7;
        buf.bytes[offset] = (buf.bytes[offset] ?? 0) | 0x40;
        buf.bytes[offset + 1] = level - 1;
      } else if (marker === 0xfc) {
        buf.bytes[offset + 1] = level;
      }
      offset = wrap16(buf, offset + 4);
    } while ((offset & buf.colMask) !== 0);
    offset = wrap(buf, offset + buf.down);
  } while (offset !== 0);
}

/**
 * Walk every tile, in the torus order of the original (column, then row).
 *
 * This exact loop appears about a dozen times verbatim in the binary; here it is one function,
 * because the stages differ only in the body. The step widths are reproduced: column step 16 bit,
 * row step 32 bit.
 */
function forEachTile(buf: MapGenBuffer, body: (offset: number) => void): void {
  let offset = 0;
  do {
    do {
      body(offset);
      offset = wrap16(buf, offset + 4);
    } while ((offset & buf.colMask) !== 0);
    offset = wrap(buf, offset + buf.down);
  } while (offset !== 0);
}

/**
 * **Stage 6** (`FUN_000084aa` @0x84aa) — move the waterline to 0.
 *
 * Subtracts `level - 1` from **every** height. After {@link carveLakes} that is the lowest height
 * present, so the subtraction cannot underflow: lake centres become 0, lake edges 1, the raised shore
 * 2, real land more. From here on "height 0" means "water" — which {@link keepLargestLandmass} relies
 * on.
 */
export function dropToWaterline(buf: MapGenBuffer): void {
  const drop = WATER_LEVEL - 1;
  forEachTile(buf, (o) => {
    buf.bytes[o + 1] = ((buf.bytes[o + 1] ?? 0) - drop) & 0xff;
  });
}

/**
 * Terrain type from the sum of three corner heights (`FUN_00008b0a` @0x8b0a).
 *
 * A curve with seven thresholds; all values read back from the ASM (@0x8b0a..@0x8b8e). It assigns
 * **only eight** of the sixteen types — the shallow water steps 1..3 and the desert/tundra steps 7..10
 * only appear in stage 10.
 */
function terrainFromHeightSum(sum: number): number {
  const s = sum & 0xffff;
  if (s < 3) return 0;
  if (s < 0x180) return 5;
  if (s < 0x1a0) return 6;
  if (s < 0x1c0) return 0xb;
  if (s < 0x1e0) return 0xc;
  if (s < 0x210) return 0xd;
  if (s < 0x230) return 0xe;
  return 0xf;
}

/**
 * **Stage 7** (`FUN_000089e2` @0x89e2) — give every triangle its terrain type.
 *
 * Each tile carries two triangles, and each is classified from the **sum of its three corner
 * heights**: the upper one from `h(P) + h(Right) + h(DownRight)`, the lower from
 * `h(P) + h(DownRight) + h(Down)`. The original builds both sums with **three** additions instead of
 * six by reusing the shared pair `h(P) + h(DownRight)` — the order is kept here because with 16-bit
 * arithmetic it co-determines the result.
 *
 * Written is **byte 2**: high nibble the lower, low nibble the upper sum.
 */
export function assignTerrain(buf: MapGenBuffer): void {
  forEachTile(buf, (o) => {
    const here = buf.bytes[o + 1] ?? 0;
    const right = wrap16(buf, o + 4);
    const downRight = wrap(buf, right + buf.down);
    const down = wrap16(buf, downRight + buf.left);

    let pair = (here + (buf.bytes[downRight + 1] ?? 0)) & 0xffff;
    const upperSum = ((buf.bytes[right + 1] ?? 0) + pair) & 0xffff;
    pair = (pair + (buf.bytes[down + 1] ?? 0)) & 0xffff;

    buf.bytes[o + 2] = ((terrainFromHeightSum(pair) << 4) | terrainFromHeightSum(upperSum)) & 0xff;
  });
}

/** Clear the visit byte (object byte) of every tile (`FUN_00008995` @0x8995). */
function clearVisitMarks(buf: MapGenBuffer): void {
  forEachTile(buf, (o) => {
    buf.bytes[o + 3] = 0;
  });
}

/**
 * Directions walkable from a tile, as a bitmask (part of `FUN_00008569`, @0x85f5..@0x8676).
 *
 * A hex edge is walkable if one of the two adjacent triangles is land. That is tested on the raw byte:
 * `& 0x0c` for the low nibble, `& 0xc0` for the high one — both are non-zero exactly when the terrain
 * type is >= 4, i.e. **not water**. The six bits stand for Right, DownRight, Down, Left, UpLeft, Up;
 * each triangle hit sets **two** of them, because a triangle borders two edges.
 */
function walkableDirections(buf: MapGenBuffer, pos: number): number {
  let dirs = 0;
  const t0 = buf.bytes[pos + 2] ?? 0;
  if ((t0 & 0x0c) !== 0) dirs |= 0x03;
  if ((t0 & 0xc0) !== 0) dirs |= 0x06;

  const left = wrap16(buf, pos + buf.left);
  if (((buf.bytes[left + 2] ?? 0) & 0x0c) !== 0) dirs |= 0x0c;

  const upLeft = wrap(buf, left + buf.up);
  const tUL = buf.bytes[upLeft + 2] ?? 0;
  if ((tUL & 0xc0) !== 0) dirs |= 0x18;
  if ((tUL & 0x0c) !== 0) dirs |= 0x30;

  const up = wrap16(buf, upLeft + 4);
  if (((buf.bytes[up + 2] ?? 0) & 0xc0) !== 0) dirs |= 0x21;
  return dirs;
}

/**
 * **Stage 8** (`FUN_00008569` @0x8569) — keep only the largest landmass.
 *
 * The map produced so far is an archipelago. This stage finds the first land tile, fills the connected
 * mass from there and checks whether it covers at least a **quarter** of the map (`vreg5 << 2` against
 * `gs+0x2c`, @0x8683). If it is too small, the search continues at the next tile — the already marked
 * mass stays and is not filled again. All land not belonging to the mass found is drowned: height 0
 * and the four adjacent terrain nibbles cleared.
 *
 * The fill is **not** a stack but a repeated sweep: the object byte serves as the visit marker
 * (`0xff` = frontier, then `1` = visited), and the whole map is swept until a round touches nothing
 * new. That is why this is the largest stage at ~1000 bytes — and why it is kept in that shape rather
 * than turned into a queue: the order in which neighbours are marked decides nothing, but the number
 * of rounds is the only termination condition.
 *
 * `OPEN @0x858c` — if the outer search wraps the whole map without finding a mass >= 1/4, the original
 * falls back into the fill at offset 0 (the row exit jumps to `LAB_85c3` instead of ending), i.e. an
 * endless loop for "map practically without land". Here the search aborts instead and the map stays as
 * it is. Practically unreachable, because the water level is 20 out of 250 height steps.
 */
export function keepLargestLandmass(buf: MapGenBuffer): void {
  clearVisitMarks(buf);

  let seed = 0;
  let found = false;
  for (;;) {
    if ((buf.bytes[seed + 1] ?? 0) !== 0) {
      buf.bytes[seed + 3] = 0xff;
      let count = 0;
      let changed: boolean;
      do {
        changed = false;
        forEachTile(buf, (o) => {
          if (((buf.bytes[o + 3] ?? 0) & 0x80) === 0) return;
          count++;
          buf.bytes[o + 3] = -(buf.bytes[o + 3] ?? 0) & 0xff;
          const dirs = walkableDirections(buf, o);
          const steps = [4, buf.downRight, buf.down, buf.left, buf.upLeft, buf.up];
          const wide = [false, true, true, false, true, true];
          for (let d = 0; d < 6; d++) {
            if ((dirs & (1 << d)) === 0) continue;
            const n = wide[d] ? wrap(buf, o + steps[d]!) : wrap16(buf, o + steps[d]!);
            if ((buf.bytes[n + 3] ?? 0) === 0) {
              buf.bytes[n + 3] = 0xff;
              changed = true;
            }
          }
        });
      } while (changed);

      if (count * 4 >= buf.geo.tileCount) {
        found = true;
        break;
      }
    }

    seed = wrap16(buf, seed + 4);
    if ((seed & buf.colMask) !== 0) continue;
    seed = wrap(buf, seed + buf.down);
 // OPEN @0x858c — at `seed == 0` the original falls back into the fill and spins forever; here the
 // search ends. Only reachable on a map almost without land.
    if (seed === 0) break;
  }
  if (!found) return;

  forEachTile(buf, (o) => {
    if ((buf.bytes[o + 1] ?? 0) === 0 || (buf.bytes[o + 3] ?? 0) !== 0) return;
    buf.bytes[o + 1] = 0;
    buf.bytes[o + 2] = 0;
    const left = wrap16(buf, o + buf.left);
    buf.bytes[left + 2] = (buf.bytes[left + 2] ?? 0) & 0xf0;
    const upLeft = wrap(buf, left + buf.up);
    buf.bytes[upLeft + 2] = 0;
    const up = wrap16(buf, upLeft + 4);
    buf.bytes[up + 2] = (buf.bytes[up + 2] ?? 0) & 0x0f;
  });

  clearVisitMarks(buf);
}

/**
 * **Stage 9** (`FUN_00008508` @0x8508) — squeeze heights into the five bits of the save game.
 *
 * `h = (h + 6) >> 3`, with a **signed** addition and an **unsigned** shift: a height near 255
 * overflows the byte and ends at 0. After this stage the values fit `height = b & 0x1f` — until here
 * they were 0..250 and not representable in the save game at all.
 */
export function compressHeights(buf: MapGenBuffer): void {
  forEachTile(buf, (o) => {
    buf.bytes[o + 1] = (((buf.bytes[o + 1] ?? 0) + 6) & 0xff) >>> 3;
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Stage 10 (`FUN_000094f8` @0x94f8) — terrain refinement, vegetation, stones, minerals
//
// The stage is itself a pipeline of 22 calls with progress reports in between; the branch inventory
// names **one** exit and **zero** control-flow branches, so it is straight-line.
//
// **It writes no height at all.** Written are only the terrain byte (+2), the object byte (+3), bit 6
// of the path byte (+0) and the mineral bytes of the game layer. That matters as a statement, because
// height deviations found when comparing against real save games therefore cannot come from this
// stage — they are gameplay (levellers at construction sites), not generation.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Draw a random tile (`FUN_00009c2e` @0x9c2e) — **two** draws, column first, then row.
 *
 * The order is part of the result: swapping it yields a different map from the same seed. Masking uses
 * the tile masks `gs+0x32`/`gs+0x34`, not the byte mask.
 */
function randomTile(buf: MapGenBuffer, rng: () => number): { offset: number; col: number; row: number } {
  const col = rng() & buf.colMaskTiles;
  const row = rng() & buf.rowMaskTiles;
  return { offset: mapByteOffset(buf, col, row), col, row };
}

/**
 * One spiral position around `(col,row)` (`FUN_00009cbb` @0x9cbb, and verbatim `FUN_0000a092`
 * @0xa092 with `rng() & mask` as the index).
 *
 * The original reads two **signed** bytes per index from `gs+0x80` (== `DAT_00004223`) — the same
 * table {@link SPIRAL_PATTERN} reproduces bit for bit — and masks column and row separately against
 * the tile masks, which keeps a ring closed on the torus.
 */
function spiralTile(buf: MapGenBuffer, col: number, row: number, index: number): number {
  const d = SPIRAL_PATTERN[index] ?? [0, 0];
  return mapByteOffset(
    buf,
    (col + (d[0] ?? 0)) & buf.colMaskTiles,
    (row + (d[1] ?? 0)) & buf.rowMaskTiles,
  );
}

/**
 * The twelve probe sites of the terrain smoothing, as `slot * 2 + nibble` (`nibble` 0 = lower/low,
 * 1 = upper/high) in the 3x3 field below.
 *
 * Two tables rather than two cascades, so they can be held against the instruction stream:
 * `FUN_00009914` (@0x9914) applies to the **upper** triangle, `FUN_00009a3d` (@0x9a3d) to the lower.
 * The two sets are **not** mirror images — each omits a different corner (upper slot 2, lower slot 6);
 * that is how it is in the binary and is not straightened out.
 */
const SMOOTH_PROBES_UP: readonly number[] = [0, 1, 3, 6, 7, 8, 11, 12, 14, 15, 16, 17];
/** See {@link SMOOTH_PROBES_UP}. */
const SMOOTH_PROBES_DOWN: readonly number[] = [0, 1, 2, 3, 5, 6, 9, 10, 11, 14, 16, 17];

/**
 * **Terrain smoothing** (`FUN_000096ea` @0x96ea) — every triangle of type `from` that has at least
 * one triangle of type `blocker` in its neighbourhood becomes type `to`.
 *
 * The polarity is the actual statement and exists only in the ASM: `call 0x9914 ; js 0x9895`
 * (@0x986a) skips the assignment when the helper returns **negative** — and negative means "no
 * neighbour has `blocker`". So it writes on **presence**, not on absence. The decompiler output shows
 * the condition here as a flag computed before the call and is therefore useless.
 *
 * Applied repeatedly this yields a gradient eating inward from an edge — exactly how the callers build
 * the water depths and the desert transition.
 *
 * The walk first collects the 3x3 neighbourhood into a scratch buffer (`gs+0x221`, nine bytes),
 * indexed row-wise:
 * ```
 * 0 = (-1,-1) 1 = (0,-1) 2 = (+1,-1)
 * 3 = (-1, 0) 4 = (0, 0) 5 = (+1, 0)
 * 6 = (-1,+1) 7 = (0,+1) 8 = (+1,+1)
 * ```
 */
function smoothTerrain(buf: MapGenBuffer, from: number, blocker: number, to: number): void {
  const cell = new Uint8Array(9);
  forEachTile(buf, (start) => {
    const here = buf.bytes[start + 2] ?? 0;
    if ((here & 0x0f) !== from && (here >>> 4) !== from) return;

 // The walk @0x9741..@0x984c — step widths as in the original (column 16 bit, row 32 bit).
    let p = start;
    cell[4] = buf.bytes[p + 2] ?? 0;
    p = wrap16(buf, p + buf.left);
    cell[3] = buf.bytes[p + 2] ?? 0;
    p = wrap(buf, p + buf.up);
    cell[0] = buf.bytes[p + 2] ?? 0;
    p = wrap16(buf, p + 4);
    cell[1] = buf.bytes[p + 2] ?? 0;
    p = wrap16(buf, p + 4);
    cell[2] = buf.bytes[p + 2] ?? 0;
    p = wrap(buf, p + buf.down);
    cell[5] = buf.bytes[p + 2] ?? 0;
    p = wrap(buf, p + buf.down);
    cell[8] = buf.bytes[p + 2] ?? 0;
    p = wrap16(buf, p + buf.left);
    cell[7] = buf.bytes[p + 2] ?? 0;
    p = wrap16(buf, p + buf.left);
    cell[6] = buf.bytes[p + 2] ?? 0;
    p = wrap(buf, p + buf.upRight); // back to the centre

    const hasBlocker = (probes: readonly number[]): boolean =>
      probes.some((k) => {
        const b = cell[k >> 1] ?? 0;
        return ((k & 1) === 0 ? b & 0x0f : b >>> 4) === blocker;
      });

    if ((buf.bytes[p + 2] ?? 0) >>> 4 === from && hasBlocker(SMOOTH_PROBES_UP)) {
      buf.bytes[p + 2] = ((buf.bytes[p + 2] ?? 0) & 0x0f) | ((to << 4) & 0xf0);
    }
    if (((buf.bytes[p + 2] ?? 0) & 0x0f) === from && hasBlocker(SMOOTH_PROBES_DOWN)) {
      buf.bytes[p + 2] = ((buf.bytes[p + 2] ?? 0) & 0xf0) | (to & 0x0f);
    }
  });
}

/** Is the triangle grass (5) or desert (10)? — the test of `FUN_00009d9b`/`FUN_00009e52`. */
function grassOrDesert(v: number): boolean {
  return v === 5 || v === 10;
}

/**
 * **Place deserts** (`FUN_00009b66` @0x9b66) — {@link MapGenBuffer.objectCount} patches.
 *
 * Per patch up to 200 attempts to find a tile whose terrain byte is **exactly `0x55`** (both triangles
 * grass, `cmpb $0x55` @0x9bae) — a byte comparison, not a nibble test. Then **256** spiral positions
 * are walked (index 255 down to 0, `jae` @0x9c1a includes the 0) and every triangle whose immediate
 * surroundings are already grass or desert is set to desert (10).
 */
function placeDeserts(buf: MapGenBuffer, rng: () => number): void {
  for (let cluster = 0; cluster < buf.objectCount; cluster++) {
    let seed: { offset: number; col: number; row: number } | null = null;
    for (let tries = 0xc8; tries > 0; tries--) {
      const t = randomTile(buf, rng);
      if ((buf.bytes[t.offset + 2] ?? 0) === 0x55) {
        seed = t;
        break;
      }
    }
    if (seed === null) continue;

    for (let index = 0xff; index >= 0; index--) {
      const o = spiralTile(buf, seed.col, seed.row, index);
      const t = buf.bytes[o + 2] ?? 0;
      const both = grassOrDesert(t & 0x0f) && grassOrDesert(t >>> 4);

 // @0x9d9b — upper triangle: additionally Left (lower) and Down (lower).
      if (
        both &&
        grassOrDesert((buf.bytes[wrap16(buf, o + buf.left) + 2] ?? 0) & 0x0f) &&
        grassOrDesert((buf.bytes[wrap(buf, o + buf.down) + 2] ?? 0) & 0x0f)
      ) {
        buf.bytes[o + 2] = ((buf.bytes[o + 2] ?? 0) & 0x0f) | 0xa0;
      }
 // @0x9e52 — lower triangle: additionally Right (upper) and Up (upper). Re-reads the terrain byte,
 // so it sees the assignment just made.
      const t2 = buf.bytes[o + 2] ?? 0;
      if (
        grassOrDesert(t2 & 0x0f) &&
        grassOrDesert(t2 >>> 4) &&
        grassOrDesert((buf.bytes[wrap16(buf, o + 4) + 2] ?? 0) >>> 4) &&
        grassOrDesert((buf.bytes[wrap(buf, o + buf.up) + 2] ?? 0) >>> 4)
      ) {
        buf.bytes[o + 2] = ((buf.bytes[o + 2] ?? 0) & 0xf0) | 0x0a;
      }
    }
  }
}

/**
 * **Desert transition** (`FUN_00009eff` @0x9eff) — the gradient grass -> desert.
 *
 * First the smoothing eats three rings inward from the desert edge (10 -> 7 -> 8 -> 9), then
 * `FUN_00009ff5` resets **all** types 7..9 to grass (@0xa02b/@0xa049, `if (6 < v && v < 10) v = 5`) —
 * so the desert has been **eroded** by three rings. Then the same gradient runs inward from the
 * outside (5 -> 9 -> 8 -> 7) and lays the soft edge.
 *
 * Without the reset it would look like a gradient and be one in the wrong direction; the order is the
 * whole point of the routine.
 */
function desertGradient(buf: MapGenBuffer): void {
  smoothTerrain(buf, 10, 5, 7);
  smoothTerrain(buf, 10, 7, 8);
  smoothTerrain(buf, 10, 8, 9);
  forEachTile(buf, (o) => {
    const t = buf.bytes[o + 2] ?? 0;
    let lo = t & 0x0f;
    let hi = t >>> 4;
    if (lo > 6 && lo < 10) lo = 5;
    if (hi > 6 && hi < 10) hi = 5;
    buf.bytes[o + 2] = ((hi << 4) & 0xf0) | lo;
  });
  smoothTerrain(buf, 5, 10, 9);
  smoothTerrain(buf, 5, 9, 8);
  smoothTerrain(buf, 5, 8, 7);
}

/**
 * **Peak markers** (`FUN_0000a177` @0xa177) — object `0x52` on every mountain top.
 *
 * Condition: own height >= `0x1a` (@0xa1ad) and a local maximum over the six neighbours in canonical
 * order — the first three (Right, DownRight, Down) may be **equal** in height
 * (`jb` @0xa1e2/@0xa20f/@0xa240), the last three (Left, UpLeft, Up) must be **strictly** lower
 * (`jae` @0xa26d/@0xa296/@0xa2bd). The asymmetry breaks ties so a plateau does not get two markers.
 */
function placeMountainCrosses(buf: MapGenBuffer): void {
  forEachTile(buf, (o) => {
    const here = (buf.bytes[o + 1] ?? 0) & 0x1f;
    if (here < 0x1a) return;
    let p = o;
    const heightAt = (): number => (buf.bytes[p + 1] ?? 0) & 0x1f;

    p = wrap16(buf, p + 4);
    if (here < heightAt()) return;
    p = wrap(buf, p + buf.down);
    if (here < heightAt()) return;
    p = wrap16(buf, p + buf.left);
    if (here < heightAt()) return;
    p = wrap(buf, p + buf.upLeft);
    if (here <= heightAt()) return;
    p = wrap(buf, p + buf.up);
    if (here <= heightAt()) return;
    p = wrap16(buf, p + 4);
    if (here <= heightAt()) return;

    buf.bytes[o + 3] = 0x52;
  });
}

/**
 * One job of the general scatter pass {@link placeObjectClusters}.
 *
 * The fifteen jobs are **data**, because in the original they are fifteen byte-identical routines
 * differing only in these seven values (`FUN_0000a300`..`FUN_0000a87f`). That way every value can be
 * held against the instruction stream; as fifteen functions it would not be checkable.
 */
export interface ObjectSpread {
 /** Address of the original routine setting these values. */
  readonly at: number;
 /** Number of patches as a multiple of {@link MapGenBuffer.objectCount}. */
  readonly clusters: number;
 /** `gs+0x230` — mask on the spiral index, determines the scatter radius. */
  readonly spread: number;
 /** `gs+0x234` — lowest allowed terrain type (inclusive). */
  readonly terrainMin: number;
 /** `gs+0x235` — first terrain type **no longer** allowed. */
  readonly terrainMax: number;
 /** `gs+0x236` — object base value. */
  readonly object: number;
 /** `gs+0x237` — mask on the random number added to the base value. */
  readonly variants: number;
 /** `gs+0x232` — attempts per patch. */
  readonly perCluster: number;
}

/**
 * The fifteen scatter jobs in the order of the driver (@0x9557..@0x95d5).
 *
 * They read as a catalogue: deciduous trees dense (x8 patches) and twice more sparsely, conifers on
 * terrain from 4 up (so also on the beach), stones in two sizes, sandstone, tree stumps, single
 * stones, carcasses in the desert, water trees and water stones in the water, palms only in the
 * desert. The terrain windows are the evidence that the object/habitat mapping is right rather than
 * guessed — `0x18` (palm) with `[10,11)` == desert, `0x1c` with `[2,4)` == water.
 */
export const OBJECT_SPREADS: readonly ObjectSpread[] = [
  { at: 0xa300, clusters: 8, spread: 0xff, terrainMin: 5, terrainMax: 7, object: 0x08, variants: 0x0f, perCluster: 10 },
  { at: 0xa36e, clusters: 1, spread: 0x3f, terrainMin: 5, terrainMax: 7, object: 0x08, variants: 0x07, perCluster: 45 },
  { at: 0xa3d2, clusters: 1, spread: 0x3f, terrainMin: 4, terrainMax: 7, object: 0x10, variants: 0x07, perCluster: 30 },
  { at: 0xa436, clusters: 1, spread: 0x7f, terrainMin: 5, terrainMax: 7, object: 0x08, variants: 0x0f, perCluster: 20 },
  { at: 0xa49a, clusters: 1, spread: 0x3f, terrainMin: 5, terrainMax: 7, object: 0x48, variants: 0x07, perCluster: 40 },
  { at: 0xa4fe, clusters: 1, spread: 0xff, terrainMin: 5, terrainMax: 7, object: 0x48, variants: 0x07, perCluster: 15 },
  { at: 0xa562, clusters: 1, spread: 0xff, terrainMin: 5, terrainMax: 7, object: 0x5c, variants: 0x00, perCluster: 2 },
  { at: 0xa5c6, clusters: 1, spread: 0xff, terrainMin: 5, terrainMax: 7, object: 0x50, variants: 0x01, perCluster: 6 },
  { at: 0xa62a, clusters: 1, spread: 0x7f, terrainMin: 2, terrainMax: 4, object: 0x1c, variants: 0x03, perCluster: 50 },
  { at: 0xa68e, clusters: 1, spread: 0xff, terrainMin: 5, terrainMax: 7, object: 0x53, variants: 0x00, perCluster: 5 },
  { at: 0xa6f2, clusters: 1, spread: 0xff, terrainMin: 5, terrainMax: 7, object: 0x54, variants: 0x01, perCluster: 10 },
  { at: 0xa756, clusters: 1, spread: 0x0f, terrainMin: 10, terrainMax: 11, object: 0x56, variants: 0x01, perCluster: 2 },
  { at: 0xa7ba, clusters: 1, spread: 0x7f, terrainMin: 8, terrainMax: 11, object: 0x5a, variants: 0x01, perCluster: 6 },
  { at: 0xa81e, clusters: 1, spread: 0x7f, terrainMin: 0, terrainMax: 3, object: 0x58, variants: 0x01, perCluster: 8 },
  { at: 0xa87f, clusters: 1, spread: 0x3f, terrainMin: 10, terrainMax: 11, object: 0x18, variants: 0x03, perCluster: 6 },
];

/**
 * The five progress groups of the scatter passes (@0x9557..@0x95d5) — 2, 2, 2, 4, 5 jobs, each
 * followed by one progress report. The cut is given as the **binary address of the last job** of each
 * group rather than as an index: that way it hangs on the same number as {@link OBJECT_SPREADS} and
 * does not slip if the table is reordered.
 */
const OBJECT_SPREAD_GROUP_ENDS = [0xa36e, 0xa436, 0xa4fe, 0xa68e, 0xa87f] as const;

/** {@link OBJECT_SPREAD_GROUP_ENDS} applied to {@link OBJECT_SPREADS}. */
const OBJECT_SPREAD_GROUPS = OBJECT_SPREAD_GROUP_ENDS.map((end, i) => {
  const from =
    i === 0 ? 0 : OBJECT_SPREADS.findIndex((s) => s.at === OBJECT_SPREAD_GROUP_ENDS[i - 1]) + 1;
  return OBJECT_SPREADS.slice(from, OBJECT_SPREADS.findIndex((s) => s.at === end) + 1);
});

/**
 * The group sizes as numbers — so a test can check the cut without the table itself becoming
 * public. Expected: `[2, 2, 2, 4, 5]`, sum == {@link OBJECT_SPREADS}.
 */
export const OBJECT_SPREAD_GROUP_SIZES: readonly number[] = OBJECT_SPREAD_GROUPS.map(
  (g) => g.length,
);

/**
 * The terrain test of the scatter passes (`FUN_0000a98d` @0xa98d) — do all six triangles around the
 * map point fit the window `[min, max)`?
 *
 * The walk Left -> Up -> Right -> Down is **net zero**, so the position ends on the starting tile
 * again; the caller relies on exactly that when it writes `+3` afterwards.
 */
function terrainWindowFits(buf: MapGenBuffer, start: number, min: number, max: number): boolean {
  const fits = (v: number): boolean => v >= min && v < max;
  const t0 = buf.bytes[start + 2] ?? 0;
  if (!fits(t0 & 0x0f) || !fits(t0 >>> 4)) return false;

  let p = wrap16(buf, start + buf.left);
  if (!fits((buf.bytes[p + 2] ?? 0) & 0x0f)) return false;
  p = wrap(buf, p + buf.up);
  const t2 = buf.bytes[p + 2] ?? 0;
  if (!fits(t2 & 0x0f) || !fits(t2 >>> 4)) return false;
  p = wrap16(buf, p + 4);
  return fits((buf.bytes[p + 2] ?? 0) & 0x0f);
}

/**
 * **Scatter objects** (`FUN_0000a8e0` @0xa8e0) — the shared body of all fifteen jobs.
 *
 * Per patch up to 100 attempts for the centre, then `perCluster` throws into the spiral around it. A
 * throw only lands if the terrain window fits **and** the tile is still empty (`or %al,%al ; jne`
 * @0xa941) — so an object is never overwritten, and patches may overlap without destroying each
 * other.
 */
function placeObjectClusters(buf: MapGenBuffer, rng: () => number, spec: ObjectSpread): void {
  const total = spec.clusters * buf.objectCount;
  for (let cluster = 0; cluster < total; cluster++) {
    let seed: { offset: number; col: number; row: number } | null = null;
    for (let tries = 100; tries > 0; tries--) {
      const t = randomTile(buf, rng);
      if (terrainWindowFits(buf, t.offset, spec.terrainMin, spec.terrainMax)) {
        seed = t;
        break;
      }
    }
    if (seed === null) continue;

    for (let n = 0; n < spec.perCluster; n++) {
      const o = spiralTile(buf, seed.col, seed.row, rng() & spec.spread);
      if (!terrainWindowFits(buf, o, spec.terrainMin, spec.terrainMax)) continue;
      if ((buf.bytes[o + 3] ?? 0) !== 0) continue;
      buf.bytes[o + 3] = (spec.object + (rng() & spec.variants)) & 0xff;
    }
  }
}

/**
 * **Minerals** (`FUN_0000ac29` @0xac29 with `FUN_0000ad70` @0xad70) — one deposit per patch,
 * thinning out ring by ring.
 *
 * The amount at the centre is `(rng & 0xc) + 8` (@0xac95), i.e. 8/12/16/20, and drops by 4 per ring
 * (`subw $0x4` @0xacc2 ff.). The ring sizes 1, 6, 12, 18, 24, 30 are the hex rings of the spiral and
 * appear as literals in the original.
 *
 * **The sixth ring (30) is unreachable**: the starting amount is at most 20, so after five deductions
 * it is 0 and `je @0xad4a` aborts there. It is reproduced anyway rather than dropped, because a
 * deliberately dead line is cheaper than a silent deviation.
 *
 * Two quirks lost when rebuilding this: the pre-check reads byte **1** of the game layer (@0xac63),
 * not mineral byte 0 — on a fresh map that is 0 everywhere, so the check never binds; and an existing
 * deposit is overwritten if the new amount is **larger** (`jae` @0xada2). Overlapping patches
 * therefore do not add up, they win outright.
 */
function placeMinerals(buf: MapGenBuffer, rng: () => number, type: number, clusters: number): void {
  const game = buf.layerOffset;
  const rings = [1, 6, 12, 18, 24, 30];

  for (let cluster = 0; cluster < clusters; cluster++) {
    let seed: { offset: number; col: number; row: number } | null = null;
    for (let tries = 100; tries > 0; tries--) {
      const t = randomTile(buf, rng);
      if ((buf.bytes[game + t.offset + 1] ?? 0) !== 0) continue;
      if (terrainWindowFits(buf, t.offset, 0x0b, 0x0f)) {
        seed = t;
        break;
      }
    }
    if (seed === null) continue;

    let amount = (rng() & 0x0c) + 8;
    let index = 0;
    for (const ring of rings) {
      for (let n = 0; n < ring; n++) {
        const o = game + spiralTile(buf, seed.col, seed.row, index);
        index++;
        const cur = buf.bytes[o] ?? 0;
        if (cur === 0 || (cur & 0x1f) < amount) buf.bytes[o] = (((type << 5) & 0xff) + amount) & 0xff;
      }
      amount -= 4;
      if (amount === 0) break;
    }
  }
}

/**
 * Blocking class per object type (`DAT_00003fd7`, 128 bytes).
 *
 * Only class >= 2 is handled by {@link thinBlockingObjects} — trees (class 1) are left alone, stones
 * and water objects are thinned out. The four values 3..6 at indices 1..4 belong to
 * flag/building/castle and do not occur during generation.
 */
const OBJECT_BLOCK_CLASS: readonly number[] = [
  0, 3, 4, 5, 6, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 1, 0, 0, 0, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1,
  1, 0, 1, 1, 1, 1, 0, 1, 1, 2, 2, 2, 2, 2, 2, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 255,
];

/**
 * **Thin out blocking objects** (`FUN_0000ade2` @0xade2) — the last sub-stage.
 *
 * An object of class >= 2 may only stay if none of its three **already visited** neighbours (Left,
 * UpLeft, Up) carries the blocking bit; then its own tile gets bit 6 of the path byte. Otherwise the
 * object is cleared — with `andb $0x80` (@0xaed7), which keeps the water marker. The result is a field
 * where two blocking tiles never touch in those directions; without this stage the stone patches would
 * form impassable clumps.
 */
function thinBlockingObjects(buf: MapGenBuffer): void {
  forEachTile(buf, (o) => {
    const obj = (buf.bytes[o + 3] ?? 0) & 0x7f;
    if ((OBJECT_BLOCK_CLASS[obj] ?? 0) < 2) return;

    let p = wrap16(buf, o + buf.left);
    if (((buf.bytes[p] ?? 0) & 0x40) === 0) {
      p = wrap(buf, p + buf.up);
      if (((buf.bytes[p] ?? 0) & 0x40) === 0) {
        p = wrap16(buf, p + 4);
        if (((buf.bytes[p] ?? 0) & 0x40) === 0) {
          buf.bytes[o] = (buf.bytes[o] ?? 0) | 0x40;
          return;
        }
      }
    }
    buf.bytes[o + 3] = (buf.bytes[o + 3] ?? 0) & 0x80;
  });
}

/**
 * **Stage 10** (`FUN_000094f8` @0x94f8) — the driver of the sub-pipeline.
 *
 * A census of the body names **40 `call`**: 25 work steps straight through and 15 progress reports
 * (`0x7a63`) in between. The reports are display only and draw no random number. The order of the work
 * is part of the result, not taste: every sub-stage draws from the same stream.
 *
 * The four mineral calls come in the order coal (x9), iron (x4), gold (x2), stone (x2) — the
 * multipliers explain the ratios seen in original save games.
 *
 * This is the stepwise form; {@link decorateMap} is the draining wrapper around it. Unlike in
 * {@link generateMapSteps}, the report comes **after** its work (@0x94f8 before @0x9506) — the order
 * differs between the two levels in the binary and is reproduced here.
 */
export function* decorateMapSteps(
  buf: MapGenBuffer,
  rng: () => number,
): Generator<number, void, void> {
 // @0x9648 — water depths: 0 becomes 3/2/1, the closer to the shore.
  smoothTerrain(buf, 0, 5, 3);
  smoothTerrain(buf, 0, 3, 2);
  smoothTerrain(buf, 0, 2, 1);
  yield 2; // @0x9506
 // @0x96c1 — shore: grass next to shallow water becomes 4.
  smoothTerrain(buf, 5, 3, 4);
  yield 1; // @0x9519

  placeDeserts(buf, rng);
  yield 1; // @0x952c
  desertGradient(buf);
  yield 3; // @0x953f
  placeMountainCrosses(buf);
  yield 1; // @0x9552

 // The five groups are those of the original (@0x9557..@0x95d5): 2, 2, 2, 4, 5 scatter jobs per
 // report. The cut is made at the binary address of each job, not at a round number.
  for (const group of OBJECT_SPREAD_GROUPS) {
    for (const spec of group) placeObjectClusters(buf, rng, spec);
    yield 1; // @0x956a · @0x9582 · @0x959a · @0x95bc · @0x95e3
  }

  placeMinerals(buf, rng, 3, buf.objectCount * 9); // @0xab8e — coal
  yield 1; // @0x95f6
  placeMinerals(buf, rng, 2, buf.objectCount * 4); // @0xab47 — iron
  yield 1; // @0x9609
  placeMinerals(buf, rng, 1, buf.objectCount * 2); // @0xab01 — gold
  yield 1; // @0x961c
  placeMinerals(buf, rng, 4, buf.objectCount * 2); // @0xabe3 — stone
  yield 1; // @0x962f

  thinBlockingObjects(buf);
  yield 1; // @0x9642
}

/** {@link decorateMapSteps} without progress reports. */
export function decorateMap(buf: MapGenBuffer, rng: () => number): void {
  for (const _ of decorateMapSteps(buf, rng)) {
 // The reports do not matter here; the work happens inside the steps.
  }
}

/**
 * **Stage 11** (`FUN_0000947a` @0x947a) — set the water marker.
 *
 * Sets bit 7 of the object byte if **one** of the two triangles is water (`(t & 0xc0) == 0` or
 * `(t & 0x0c) == 0`). This is the "at least one water triangle" marker of the save game format — and
 * here is its origin: it is not a runtime cache but written once while generating the map. The port
 * does not keep it as a field (it is derivable from the terrain) but must write it during generation,
 * otherwise the byte deviates from the original.
 */
export function markWaterTiles(buf: MapGenBuffer): void {
  forEachTile(buf, (o) => {
    const t = buf.bytes[o + 2] ?? 0;
    if ((t & 0xc0) === 0 || (t & 0x0c) === 0) buf.bytes[o + 3] = (buf.bytes[o + 3] ?? 0) | 0x80;
  });
}

/**
 * Turn the raw seed (setup record or main menu) into the RNG start state — the three `xor` of
 * `apply_game_setup` (@0x4fe70..@0x4fe8c). The result is what the original holds in `gs+0x1ee..0x1f2`.
 */
export function deriveMapSeed(raw: readonly [number, number, number]): [number, number, number] {
  return [
    (raw[0] ^ SEED_XOR[0]) & 0xffff,
    (raw[1] ^ SEED_XOR[1]) & 0xffff,
    (raw[2] ^ SEED_XOR[2]) & 0xffff,
  ];
}

/**
 * The driver (`FUN_00007874` @0x7874) — generate a map from a seed.
 *
 * A **census of all `call` of the driver** names exactly 16 targets and thereby rules out anything
 * unknown happening here: the eleven stages, the eleven progress reports (`0x7a63`), their reset
 * (`0x7a55` — writes only `gs+0x188`), the **two** random pre-draws (`0x4e1e9`, a byte-identical copy
 * of `rng_next`), the gold sum and building the overview map.
 *
 * The two pre-draws are part of the result: the generator does **not** start on the seed itself.
 *
 * **The progress reports belong to the driver, they are not decoration.** They appear as `yield` so
 * the UI layer can draw between two stages — the original bar grows *during* generation, not after.
 * Callers that do not need them use {@link generateMap}. The result is the same either way: a report
 * draws no random number and does not touch the buffer (`FUN_00007a63` writes only `gs+0x188` and
 * paints).
 */
export function* generateMapSteps(
  seed: readonly [number, number, number],
  mapSize: number,
  rngFactory: (seed: readonly [number, number, number]) => () => number,
): Generator<number, MapGenBuffer, void> {
  const buf = createMapGenBuffer(mapSize);
  const rng = rngFactory(seed);
  rng();
  rng(); // @0x78ca/@0x78cf — two pre-draws before the first stage

 // Here the report comes **before** its stage (@0x78e2 before @0x78e7) — the bar shows what has
 // started, not what is finished. In {@link decorateMapSteps} it is the other way round.
  yield 1; // @0x78e2
  clearMap(buf);
  yield 1; // @0x78f5
  seedHeights(buf, rng);
  refineHeights(buf, rng);
  yield 3; // @0x790d
  limitHeightSlopes(buf);
  yield 4; // @0x7920
  carveLakes(buf, rng);
  yield 3; // @0x7933
  dropToWaterline(buf);
  yield 1; // @0x7946
  assignTerrain(buf);
  yield 1; // @0x7959
  keepLargestLandmass(buf);
  yield 5; // @0x796c
  compressHeights(buf);
  yield 1; // @0x797f
  yield* decorateMapSteps(buf, rng);
  markWaterTiles(buf);
 // @0x798e — the original runs the gold sum (`FUN_000079cc`) here; the port pulls it into
 // {@link sumMapGold}, because it belongs in the save game header and not in the buffer.
  yield 1; // @0x799c
 // @0x79a1 — `build_minimap` (`FUN_0000af12`). The port builds the overview map on demand; the
 // report stays anyway, otherwise the bar would never reach its right edge.
  yield 1; // @0x79af
  return buf;
}

/** {@link generateMapSteps} without progress reports — the ordinary path. */
export function generateMap(
  seed: readonly [number, number, number],
  mapSize: number,
  rngFactory: (seed: readonly [number, number, number]) => () => number,
): MapGenBuffer {
  const steps = generateMapSteps(seed, mapSize, rngFactory);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/**
 * **Gold sum** (`FUN_000079cc` @0x79cc) — sum of the remaining amounts of all gold deposits, into
 * `mapGoldTotal` (header @184, `gs+0x4c` @0x7a4f in the original). Tested is the raw byte of the game
 * layer: `(b & 0xe0) == 0x20` (@0x7a07), i.e. mineral type 1 == gold; added is `b & 0x1f`.
 *
 * The original offsets the base once by `gs+0x36` (@0x79da) and then walks the **ordinary** torus —
 * possible only because the game layer lies inside the row (see module header).
 *
 * Useful as an **independent intermediate anchor**: the sum is in the save game, so no individual tile
 * has to be compared.
 */
export function sumMapGold(buf: MapGenBuffer): number {
  let total = 0;
  const base = buf.layerOffset;
  let offset = 0;
  do {
    do {
      const b = buf.bytes[base + offset] ?? 0;
      if ((b & 0xe0) === 0x20) total += b & 0x1f;
      offset = wrap16(buf, offset + 4);
    } while ((offset & buf.colMask) !== 0);
    offset = wrap(buf, offset + buf.down);
  } while (offset !== 0);
  return total;
}
