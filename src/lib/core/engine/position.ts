/**
 * Map position arithmetic.
 *
 * The map is a torus of `cols x rows` tiles. The **canonical map position** is
 * `pos = (row << rowShift) | col` — the index into `mapTiles` and into the original's object array.
 * Serf and building records store a **packed u32 position** (`((row << (rowShift+1)) | col) << 2`),
 * which the save parser already decodes to `col/row`; the codec functions here mirror that encoding.
 *
 * Geometry:
 * ```
 * colSize = 5 + floor(mapSize / 2)          // == rowShift
 * rowSize = 5 + floor((mapSize - 1) / 2)
 * cols = 1 << colSize,  rows = 1 << rowSize
 * ```
 *
 * The six-direction neighbour arithmetic (hex grid) is verified against the original data, see
 * {@link DIR_DELTA}.
 */

export interface MapGeometry {
  readonly mapSize: number;
  readonly cols: number;
  readonly rows: number;
  /** Number of column bits; a map position is `(row << rowShift) | col`. */
  readonly rowShift: number;
  readonly colMask: number;
  readonly rowMask: number;
  readonly tileCount: number;
}

/** Derive the map geometry from the save header's `mapSize`. */
export function mapGeometry(mapSize: number): MapGeometry {
  const colSize = 5 + Math.floor(mapSize / 2);
  const rowSize = 5 + Math.floor((mapSize - 1) / 2);
  const cols = 1 << colSize;
  const rows = 1 << rowSize;
  return {
    mapSize,
    cols,
    rows,
    rowShift: colSize,
    colMask: cols - 1,
    rowMask: rows - 1,
    tileCount: cols * rows,
  };
}

/** Canonical map position from column/row, with torus wrap. */
export function posOf(col: number, row: number, geo: MapGeometry): number {
  return ((row & geo.rowMask) << geo.rowShift) | (col & geo.colMask);
}

/** Column of a map position. */
export function colOf(pos: number, geo: MapGeometry): number {
  return pos & geo.colMask;
}

/** Row of a map position. */
export function rowOf(pos: number, geo: MapGeometry): number {
  return (pos >>> geo.rowShift) & geo.rowMask;
}

/**
 * Decode a packed u32 record position (serf/building) to `{col, row}`, or `null` for
 * `0xffffffff` (= no tile). Same decoding as the save parser.
 */
export function decodePackedPos(
  posWord: number,
  geo: MapGeometry,
): { col: number; row: number } | null {
  if (posWord === 0xffffffff) return null;
  let v = posWord >>> 2;
  const col = v & geo.colMask;
  v = v >>> (geo.rowShift + 1);
  const row = v & geo.rowMask;
  return { col, row };
}

/** Inverse of `decodePackedPos`. */
export function encodePackedPos(col: number, row: number, geo: MapGeometry): number {
  return ((((row & geo.rowMask) << (geo.rowShift + 1)) | (col & geo.colMask)) << 2) >>> 0;
}

// ---- Hex directions + neighbour arithmetic ----

/**
 * The 6 hex directions (order == road bits `paths` bit 0..5 in the map tile / flag record).
 * Opposite direction = `(dir + 3) % 6`.
 */
export enum Direction {
  Right = 0,
  DownRight = 1,
  Down = 2,
  Left = 3,
  UpLeft = 4,
  Up = 5,
}

/**
 * (dcol, drow) per direction. `FUN_00007ae7` lays the eight neighbour offsets into `gs`; the six hex
 * neighbours are Right `+col`, DownRight `+col+row`, Down `+row`, Left `-col`, UpLeft `-col-row`,
 * Up `-row`.
 *
 * Confirmed against real saves: building -> flag is always **DownRight = (+1,+1)** (240 of 240
 * buildings, one transient outlier that had just been captured), i.e. seen from the flag the building
 * hangs at **UpLeft = (-1,-1)**. Note the asymmetry — DownRight is *not* (0,+1).
 */
export const DIR_DELTA: readonly (readonly [number, number])[] = [
  [1, 0], // 0 Right
  [1, 1], // 1 DownRight
  [0, 1], // 2 Down
  [-1, 0], // 3 Left
  [-1, -1], // 4 UpLeft
  [0, -1], // 5 Up
];

/** Opposite direction (180 degrees). */
export function oppositeDir(dir: Direction): Direction {
  return ((dir + 3) % 6) as Direction;
}

/** Neighbour map position in a direction (torus wrap). */
export function neighbor(pos: number, dir: Direction, geo: MapGeometry): number {
  const [dc, dr] = DIR_DELTA[dir];
  return posOf(colOf(pos, geo) + dc, rowOf(pos, geo) + dr, geo);
}
