import { describe, expect, it } from 'vitest';
import {
  cameraCenteredOnTile,
  cameraCenterTile,
  cameraScroll,
  tileScene,
  tileToWindow,
  minZoomForWholeMap,
  tileToWindowAll,
  wrapLattice,
  windowToTile,
  scrollCenterTileByEdgeMask,
  gotoOwnCastle,
  type Camera,
} from './viewport-camera.js';
import { HEIGHT_UNIT, TILE_H, TILE_W } from './map-render.js';
import { buildHalfRows, viewportSpan } from './map-viewport.js';
import { tileAnchor } from './window-frame.js';
import { mapGeometry } from './engine/position.js';

const geo = mapGeometry(3); // 64×64
const cam = (originX: number, originY: number, width = 640, height = 480): Camera => ({
  originX,
  originY,
  width,
  height,
});

describe('wrapLattice', () => {
  it('spans the torus with the sheared basis vectors', () => {
    // Only B moves y — the closed-form solution in tileToWindow rests on that.
    expect(wrapLattice(geo)).toEqual({ ax: 64 * TILE_W, bx: -64 * (TILE_W / 2), by: 64 * TILE_H });
  });
});

describe('tileToWindow — without a seam', () => {
  it('is the plain scene difference as long as the tile is inside the window', () => {
    const c = cam(10 * TILE_W - 20 * (TILE_W / 2), 20 * TILE_H);
    expect(tileToWindow(10, 20, c, geo)).toEqual({ x: 0, y: 0 });
    const s = tileScene(13, 22);
    expect(tileToWindow(13, 22, c, geo)).toEqual({
      x: s.x - c.originX,
      y: s.y - c.originY,
    });
  });
});

describe('tileToWindow — torus wrap', () => {
  it('every lattice repetition of a tile gives the same window position', () => {
    // This is the proof of the lattice maths: the tile is its repetitions.
    const c = cam(tileScene(30, 30).x, tileScene(30, 30).y);
    const ref = tileToWindow(32, 33, c, geo);
    for (const [da, db] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [2, -3],
      [-4, 5],
    ] as const) {
      expect(
        tileToWindow(32 + da * geo.cols, 33 + db * geo.rows, c, geo),
        `Wiederholung (${da},${db})`,
      ).toEqual(ref);
    }
  });

  it('across the column seam x continues gaplessly (step 32, no jump)', () => {
    // Naively (`col*32`) column 0 would jump half a map to the left.
    const c = cam(tileScene(58, 20).x, tileScene(58, 20).y);
    const xs: number[] = [];
    for (let k = 0; k < 12; k++) xs.push(tileToWindow((58 + k) % geo.cols, 20, c, geo).x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!, `Naht bei Schritt ${i}`).toBe(TILE_W);
    }
  });

  it('across the row seam y AND the shear of x continue gaplessly', () => {
    const c = cam(tileScene(20, 58).x, tileScene(20, 58).y);
    let prev = tileToWindow(20, 58, c, geo);
    for (let k = 1; k < 12; k++) {
      const cur = tileToWindow(20, (58 + k) % geo.rows, c, geo);
      expect(cur.y - prev.y, `Zeile ${k}`).toBe(TILE_H);
      expect(cur.x - prev.x, `Scherung bei Zeile ${k}`).toBe(-TILE_W / 2);
      prev = cur;
    }
  });

  it('works for arbitrarily far scrolling (unbounded scroll)', () => {
    const base = cam(tileScene(20, 20).x, tileScene(20, 20).y);
    const { ax, bx, by } = wrapLattice(geo);
    // Seven whole map periods on: the image must be identical.
    const far = cam(base.originX + 7 * ax + 3 * bx, base.originY + 3 * by);
    expect(tileToWindow(25, 24, far, geo)).toEqual(tileToWindow(25, 24, base, geo));
  });
});

describe('tileToWindowAll', () => {
  it('gives exactly one repetition in the normal case', () => {
    const c = cam(tileScene(20, 20).x, tileScene(20, 20).y);
    const all = tileToWindowAll(24, 23, c, geo, 32);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(tileToWindow(24, 23, c, geo));
  });

  it('several when zoomed out past one map period — otherwise copies would stay empty', () => {
    const { ax, by } = wrapLattice(geo);
    // Window much larger than one period (the missing zoom cap allows that).
    const c = cam(0, 0, ax * 2 + 100, by * 2 + 100);
    const all = tileToWindowAll(10, 10, c, geo, 0);
    expect(all.length).toBeGreaterThanOrEqual(4);
    // All lie inside the window and are pairwise distinct.
    for (const p of all) {
      expect(p.x).toBeGreaterThanOrEqual(-1);
      expect(p.y).toBeGreaterThanOrEqual(-1);
      expect(p.x).toBeLessThanOrEqual(c.width + 1);
      expect(p.y).toBeLessThanOrEqual(c.height + 1);
    }
    expect(new Set(all.map((p) => `${p.x},${p.y}`)).size).toBe(all.length);
  });

  it('contains the nearest repetition from tileToWindow', () => {
    const c = cam(tileScene(58, 58).x, tileScene(58, 58).y);
    const near = tileToWindow(2, 3, c, geo);
    const all = tileToWindowAll(2, 3, c, geo, TILE_W);
    expect(all).toContainEqual(near);
  });
});

describe('cameraScroll', () => {
  it('finds the tile of the top-left corner, remainder as fine scroll', () => {
    const anchor = tileScene(10, 20);
    const c = cam(anchor.x + 7, anchor.y + 3);
    const s = cameraScroll(c);
    expect(s.col).toBe(10);
    expect(s.row).toBe(20);
    expect(s.pixelX).toBe(7);
    expect(s.pixelY).toBe(3);
  });

  it('fine scroll remainder and tileToWindow are consistent', () => {
    const anchor = tileScene(11, 21);
    const c = cam(anchor.x + 13, anchor.y + 5);
    const s = cameraScroll(c);
    const w = tileToWindow(s.col, s.row, c, geo);
    expect(w).toEqual({ x: -s.pixelX, y: -s.pixelY });
  });

  it('yields whole tiles + remainder in [0,tile) for negative and far scroll too', () => {
    for (const [ox, oy] of [
      [-5000, -3000],
      [123456, 98765],
      [-1, -1],
    ] as const) {
      const s = cameraScroll(cam(ox, oy));
      expect(s.pixelY, `Rest y bei ${oy}`).toBeGreaterThanOrEqual(0);
      expect(s.pixelY).toBeLessThan(TILE_H);
      expect(s.pixelX, `Rest x bei ${ox}`).toBeGreaterThanOrEqual(0);
      expect(s.pixelX).toBeLessThan(TILE_W);
    }
  });
});

describe('windowToTile', () => {
  const flatHeights = () => 0;

  it('is the inverse of tileToWindow on flat ground', () => {
    const c = cam(tileScene(20, 20).x, tileScene(20, 20).y);
    for (const [col, row] of [
      [20, 20],
      [25, 27],
      [31, 22],
    ] as const) {
      const w = tileToWindow(col, row, c, geo);
      expect(windowToTile(w.x, w.y, c, geo, flatHeights, 0), `(${col},${row})`).toEqual({
        col,
        row,
      });
    }
  });

  it('yields wrapped, canonical tiles beyond the seam', () => {
    const c = cam(tileScene(60, 60).x, tileScene(60, 60).y);
    const w = tileToWindow(2, 1, c, geo);
    const hit = windowToTile(w.x, w.y, c, geo, flatHeights, 0);
    expect(hit).toEqual({ col: 2, row: 1 });
  });

  it('accounts for the height lift in the relief', () => {
    // Tile (23,22) at height 10 -> its anchor sits 40 px higher than flat.
    const heights = (col: number, row: number) => (col === 23 && row === 22 ? 10 : 0);
    const c = cam(tileScene(20, 20).x, tileScene(20, 20).y);
    const flat = tileScene(23, 22);
    const w = {
      x: flat.x - c.originX,
      y: flat.y - 10 * HEIGHT_UNIT - c.originY,
    };
    expect(windowToTile(w.x, w.y, c, geo, heights, HEIGHT_UNIT)).toEqual({ col: 23, row: 22 });
  });

  it('on an exact tie the tile in FRONT wins (painter order)', () => {
    // Documented special case: tile (22,22) at height 10 lands exactly on the anchor of (21,20)
    // (both scene position (352,400)). Visible is the one drawn later — row 22.
    const heights = (col: number, row: number) => (col === 22 && row === 22 ? 10 : 0);
    const c = cam(0, 0);
    expect(tileScene(22, 22).y - 10 * HEIGHT_UNIT).toBe(tileScene(21, 20).y);
    expect(tileScene(22, 22).x).toBe(tileScene(21, 20).x);
    expect(windowToTile(352, 400, c, geo, heights, HEIGHT_UNIT)).toEqual({ col: 22, row: 22 });
  });

  it('hits a tile everywhere on the torus — there is no outside', () => {
    const c = cam(0, 0);
    for (const [x, y] of [
      [16, -400],
      [-9999, 12345],
      [0, 0],
    ] as const) {
      const hit = windowToTile(x, y, c, geo, flatHeights, 0);
      expect(hit.col).toBeGreaterThanOrEqual(0);
      expect(hit.col).toBeLessThan(geo.cols);
      expect(hit.row).toBeGreaterThanOrEqual(0);
      expect(hit.row).toBeLessThan(geo.rows);
    }
  });
});

describe('camera == half-row traversal (the seam between the layers)', () => {
  // If `tileToWindow` and the ground commands drift apart by even one pixel, roads, buildings and
  // serfs sit next to the ground. So they are computed against each other directly here: tile `k` of
  // half row `i` must land at `(xOffset + k*32, i*20)`.
  const check = (scrollCol: number, scrollRow: number) => {
    const anchor = tileScene(scrollCol, scrollRow);
    const c = cam(anchor.x, anchor.y);
    const span = viewportSpan(c.width, c.height);
    const rows = buildHalfRows({ col: scrollCol, row: scrollRow }, geo, span);
    let compared = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      for (let k = 0; k < row.tiles.length; k++) {
        const pos = row.tiles[k]!;
        const col = pos % geo.cols;
        const r = (pos - col) / geo.cols;
        expect(tileToWindow(col, r, c, geo), `Halbzeile ${i}, Kachel ${k}`).toEqual({
          x: row.xOffset + k * TILE_W,
          y: i * TILE_H,
        });
        compared++;
      }
    }
    return compared;
  };

  it('agrees in the middle of the map', () => {
    expect(check(20, 20)).toBeGreaterThan(500);
  });

  it('agrees across both seams as well', () => {
    check(58, 20);
    check(20, 58);
    expect(check(58, 58)).toBeGreaterThan(500);
  });
});

describe('minZoomForWholeMap', () => {
  it('is reached when the window holds at least one map period on BOTH axes', () => {
    const { ax, by } = wrapLattice(geo); // 2048 × 1280
    const z = minZoomForWholeMap(1600, 900, geo);
    const c = cam(0, 0, 1600 / z, 900 / z);
    expect(c.width).toBeGreaterThanOrEqual(ax);
    expect(c.height).toBeGreaterThanOrEqual(by);
    // And just barely: one of the two axes sits exactly on the period.
    expect(Math.min(c.width - ax, c.height - by)).toBeLessThan(1);
  });

  it('takes the MINIMUM of the axis ratios — with the maximum the world would never be fully visible', () => {
    const { ax, by } = wrapLattice(geo);
    const [vw, vh] = [1600, 900];
    expect(minZoomForWholeMap(vw, vh, geo)).toBe(Math.min(vw / ax, vh / by));
    // Counter-check: with the maximum one axis would stay below the period.
    const wrong = Math.max(vw / ax, vh / by);
    expect(Math.min(vw / wrong, vh / wrong)).toBeLessThan(Math.max(ax, by));
  });

  it('never forces zooming in: never above 1', () => {
    expect(minZoomForWholeMap(5000, 4000, geo)).toBe(1);
    expect(minZoomForWholeMap(640, 480, geo)).toBeLessThan(1);
  });
});

describe('repetition when zooming out', () => {
  // Symptom: the ground repeats, buildings and roads stick once in the middle. Cause: the entity
  // passes computed from `col/row` (which gives ONE position per tile), the ground from the running
  // counters of the traversal. This test pins down that the traversal visits the same tile several
  // times — and that the counters give distinct positions for those visits.
  const { ax, by } = wrapLattice(geo);
  const big = cam(0, 0, ax * 2, by * 2); // Fenster = zwei Karten-Perioden
  const span = viewportSpan(big.width, big.height);
  const rows = buildHalfRows({ col: 0, row: 0 }, geo, span);

  it('the traversal visits tiles more than once', () => {
    const counts = new Map<number, number>();
    for (const r of rows) for (const p of r.tiles) counts.set(p, (counts.get(p) ?? 0) + 1);
    const repeated = [...counts.values()].filter((n) => n > 1);
    expect(repeated.length).toBeGreaterThan(0);
  });

  it('from the running counters every visit gets its OWN position (from col/row it does not)', () => {
    // First tile occurring twice in the same half row.
    const hr = rows.find((r) => new Set(Array.from(r.tiles)).size < r.tiles.length);
    expect(hr, 'no window with a repetition — check the test setup').toBeDefined();
    const seen = new Map<number, number>();
    let found: { k1: number; k2: number; pos: number } | null = null;
    for (let k = 0; k < hr!.tiles.length; k++) {
      const p = hr!.tiles[k]!;
      const prev = seen.get(p);
      if (prev !== undefined) {
        found = { k1: prev, k2: k, pos: p };
        break;
      }
      seen.set(p, k);
    }
    expect(found).not.toBeNull();
    // Running counters: distinct x — correct. Via `tileAnchor`, i.e. via the PRODUCTION path; a
    // formula recomputed here would not rule the bug out (that is exactly how it arose: verification
    // script and component both computed it wrongly).
    const i = rows.indexOf(hr!);
    const x1 = tileAnchor({ halfRows: rows, pixelX: 0, pixelY: 0 }, i, found!.k1).x;
    const x2 = tileAnchor({ halfRows: rows, pixelX: 0, pixelY: 0 }, i, found!.k2).x;
    expect(x2 - x1).toBe((found!.k2 - found!.k1) * TILE_W);
    expect(x1).not.toBe(x2);
    // From col/row: identical position for both visits — exactly the bug.
    const col = found!.pos % geo.cols;
    const row = (found!.pos - col) / geo.cols;
    expect(tileToWindow(col, row, big, geo)).toEqual(tileToWindow(col, row, big, geo));
  });
});

describe('centre tile of the view (`vp+0x46/0x48`)', () => {
  const flat = () => 0;

  it('really centres: the tile lands in the window CENTRE, not in the corner', () => {
    // The core of the finding. A port reading `vp+0x46` as the top-left corner passes every round
    // trip test (both sides would then be consistently wrong) — it fails only on this statement: the
    // set tile must sit at half the window width/height.
    for (const [w, h] of [[640, 480], [800, 500], [1920, 1080], [320, 192]]) {
      for (const [col, row] of [[10, 10], [33, 7], [0, 0], [63, 63]]) {
        const c = cameraCenteredOnTile(col, row, w, h);
        const p = tileToWindow(col, row, { ...c, width: w, height: h }, geo);
        expect(Math.abs(p.x - w / 2), `Kachel ${col},${row} @${w}×${h}`).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y - h / 2), `Kachel ${col},${row} @${w}×${h}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('Rundlauf: zentrieren → auslesen liefert dieselbe Kachel', () => {
    for (const [w, h] of [[640, 480], [800, 500], [1920, 1080]]) {
      for (const [col, row] of [[10, 10], [33, 7], [0, 0], [63, 63], [1, 62]]) {
        const c = cameraCenteredOnTile(col, row, w, h);
        const back = cameraCenterTile({ ...c, width: w, height: h }, geo, flat, HEIGHT_UNIT);
        expect(back, `Kachel ${col},${row} @${w}×${h}`).toEqual({ col, row });
      }
    }
  });

  it('the corner is NOT the centre — otherwise the test above would be blind', () => {
    // Sensitivity counter-check: at 800x500 corner and centre are 12 columns / 12 rows apart.
    // Exactly that displacement was the observed bug.
    const cam = { ...cameraCenteredOnTile(20, 20, 800, 500), width: 800, height: 500 };
    expect(cameraCenterTile(cam, geo, flat, HEIGHT_UNIT)).toEqual({ col: 20, row: 20 });
    expect(windowToTile(0, 0, cam, geo, flat, HEIGHT_UNIT)).not.toEqual({ col: 20, row: 20 });
  });
});

describe('viewport-camera — Rand-Scroll (Verbraucher-Block @0xd64e ff.)', () => {
  const g = mapGeometry(3); // 64 × 64

  it('waagerecht: ±2 Spalten', () => {
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 1, g)).toEqual({ col: 28, row: 30 });
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 2, g)).toEqual({ col: 32, row: 30 });
  });

  it('vertical movement shifts the COLUMN too — shear compensation of the hex lattice', () => {
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 4, g)).toEqual({ col: 28, row: 26 });
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 8, g)).toEqual({ col: 32, row: 34 });
  });

  it('left AND up shifts the column twice (separate if chains)', () => {
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 1 | 4, g)).toEqual({ col: 26, row: 26 });
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 2 | 8, g)).toEqual({ col: 34, row: 34 });
  });

  it('left and right are exclusive (else-if): 1|2 acts like 1', () => {
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 1 | 2, g)).toEqual({ col: 28, row: 30 });
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 4 | 8, g)).toEqual({ col: 28, row: 26 });
  });

  it('the map masks wrap on the torus', () => {
    expect(scrollCenterTileByEdgeMask({ col: 1, row: 1 }, 1 | 4, g)).toEqual({ col: 61, row: 61 });
    expect(scrollCenterTileByEdgeMask({ col: 63, row: 63 }, 2 | 8, g)).toEqual({ col: 3, row: 3 });
  });

  it('mask 0 moves nothing — bit 4 is not a direction and is ignored here', () => {
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 0, g)).toEqual({ col: 30, row: 30 });
    expect(scrollCenterTileByEdgeMask({ col: 30, row: 30 }, 0x10, g)).toEqual({ col: 30, row: 30 });
  });
});

describe('gotoOwnCastle (@0x56d8) — jump to the own castle', () => {
  const g = mapGeometry(3); // 64×64
  const player = (over: Partial<{ build: number; castleBuilding: number }> = {}) => ({
    build: 0x08, castleBuilding: 2, cursorCol: 11, cursorRow: 12, ...over,
  });
  const buildings = [null, null, { col: 40, row: 33 }];

  it('yields the castle tile and drags the CURSOR along (@0x5783)', () => {
    const p = player();
    expect(gotoOwnCastle(p, buildings, g)).toEqual({ col: 40, row: 33 });
    // The cursor is block 380/382 and has to move along — exactly what the old copy of this
    // computation in the view was missing.
    expect([p.cursorCol, p.cursorRow]).toEqual([40, 33]);
  });

  it('the gate is `build` bit 3, not `flags` bit 0 (@0x56ec) — without a castle NOTHING happens', () => {
    const p = player({ build: 0x04 }); // bit 2 set, bit 3 not
    expect(gotoOwnCastle(p, buildings, g)).toBeNull();
    expect([p.cursorCol, p.cursorRow]).toEqual([11, 12]); // Cursor bleibt stehen
  });

  it('an empty castle slot bails out instead of jumping to tile 0', () => {
    const p = player({ castleBuilding: 1 });
    expect(gotoOwnCastle(p, buildings, g)).toBeNull();
    expect([p.cursorCol, p.cursorRow]).toEqual([11, 12]);
  });

  it('the original map masks wrap (@0x5740/@0x574a)', () => {
    const p = player({ castleBuilding: 2 });
    expect(gotoOwnCastle(p, [null, null, { col: 64 + 5, row: 64 + 7 }], g)).toEqual({ col: 5, row: 7 });
  });
});
