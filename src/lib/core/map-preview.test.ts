import { describe, expect, it } from 'vitest';
import {
  PREVIEW_BORDERS,
  PREVIEW_BUILDINGS,
  PREVIEW_CURSOR_SPRITE,
  PREVIEW_OWNER_MAP,
  PREVIEW_ROADS,
  PREVIEW_TERRITORY_DOTS,
  PREVIEW_X,
  PREVIEW_ZOOM,
  PREVIEW_Y,
  drawBorderLines,
  applyZoomHexOffset,
  drawBuildingOverlay,
  drawBuildingOverlayOwnerMap,
  drawBuildingOverlayOwnerMapZoom,
  drawBuildingOverlayZoom,
  drawCursorMarker,
  drawViewportRect,
  drawMapPreview,
  drawOwnerMap,
  drawOwnerMapZoom,
  drawRoadOverlay,
  drawRoadOverlayZoom,
  drawTerritoryDots,
  MARKER_COLOR_EVEN,
  MARKER_COLOR_ODD,
  MAP_PREVIEW_ACTION,
  MAP_PREVIEW_HITBOXES,
  applyMapPreviewAction,
  mapPreviewClickToTile,
  mapPreviewOrigin,
  mapPreviewZoomOrigin,
  previewTileStep,
  type MapPreviewData,
  type MapPreviewView,
} from './map-preview.js';
import { buildMinimap } from './minimap.js';
import { cameraCenteredOnTile, windowToTile } from './viewport-camera.js';
import { TILE_H, TILE_W } from './map-render.js';
import { mapGeometry } from './engine/position.js';
import { gameSprite } from './flag-sprites.js';
import { createFramebuffer, hitTest, type Framebuffer, type SpriteProvider } from './ui-render.js';
import type { DecodedSprite, MapTile } from './types.js';

const COLS = 64;
const ROWS = 64;
const geoTest = mapGeometry(3); // 64x64, like every original save

/** Centre that puts the window origin exactly on tile (0,0) (see `mapPreviewOrigin`). */
const CENTER_COL = 0x54;
const CENTER_ROW = 0x38;

/** Palette where index `i` appears as red channel `i`, so the index is readable off a pixel. */
function indexPalette(): Uint8Array {
  const p = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    p[i * 4] = i;
    p[i * 4 + 1] = 0;
    p[i * 4 + 2] = 0;
    p[i * 4 + 3] = 255;
  }
  return p;
}

function emptyTile(): MapTile {
  return {
    height: 8,
    terrainUp: 5,
    terrainDown: 5,
    object: 0,
    owner: 0,
    paths: 0,
    blocked: false,
    mineral: 0,
    resourceAmount: 0,
    objIndex: 0,
    serfIndex: 0,
  };
}

function makeData(patch: (col: number, row: number) => Partial<MapTile> = () => ({})): MapPreviewData {
  const tiles: MapTile[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) tiles.push({ ...emptyTile(), ...patch(col, row) });
  }
  return {
    tiles,
    cols: COLS,
    rows: ROWS,
    minimap: buildMinimap(tiles, COLS, ROWS),
    palette: indexPalette(),
    flags: [],
    buildings: [],
  };
}

function makeView(patch: Partial<MapPreviewView> = {}): MapPreviewView {
  return {
    centerCol: CENTER_COL,
    centerRow: CENTER_ROW,
    cursorCol: CENTER_COL,
    cursorRow: CENTER_ROW,
    mode: 0,
    buildingFilter: -1,
    playerIndex: 0,
    ...patch,
  };
}

function fb(): Framebuffer {
  return createFramebuffer(144, 160);
}

/** Read back the palette index at window position `(i, j)` (0..127). */
function px(f: Framebuffer, i: number, j: number): number {
  return f.rgba[((PREVIEW_Y + j) * f.width + PREVIEW_X + i) * 4]!;
}

/** Tile position appearing at `(i, j)` in the window (hex shear from origin (0,0)). */
function tileOf(i: number, j: number): { col: number; row: number } {
  return { col: (i + (j >> 1)) & (COLS - 1), row: j & (ROWS - 1) };
}

describe('mapPreviewOrigin (FUN_000272d7)', () => {
  it('aligns the row to 16 and folds the shear back into the column', () => {
    const o = mapPreviewOrigin(CENTER_COL, CENTER_ROW, COLS, ROWS);
    expect(o).toEqual({ col: 0, row: 0 });
  });

  it('row origin is always a multiple of 16', () => {
    for (let r = 0; r < ROWS; r++) {
      expect(mapPreviewOrigin(0, r, COLS, ROWS).row % 16).toBe(0);
    }
  });

  it('wraps toroidally (centre near the map edge)', () => {
    const o = mapPreviewOrigin(2, 2, COLS, ROWS);
    expect(o.col).toBeGreaterThanOrEqual(0);
    expect(o.col).toBeLessThan(COLS);
    expect(o.row).toBeGreaterThanOrEqual(0);
    expect(o.row).toBeLessThan(ROWS);
  });
});

describe('drawOwnerMap (FUN_00042cdf)', () => {
  const origin = { col: 0, row: 0 };

  it('paints unowned land with index 1', () => {
    const f = fb();
    drawOwnerMap(f, makeData(), origin);
    expect(px(f, 0, 0)).toBe(1);
    expect(px(f, 127, 127)).toBe(1);
  });

  it('gives each player its own colour (0x41 + 8·bit5 + 4·bit6)', () => {
    const expected = [0x41, 0x49, 0x45, 0x4d];
    for (let owner = 1; owner <= 4; owner++) {
      const f = fb();
      drawOwnerMap(f, makeData(() => ({ owner })), origin);
      expect(px(f, 3, 4)).toBe(expected[owner - 1]);
    }
  });

  it('follows the hex shear (column advances every second screen row)', () => {
    const target = { col: 5, row: 3 };
    const f = fb();
    drawOwnerMap(
      f,
      makeData((col, row) => (col === target.col && row === target.row ? { owner: 1 } : {})),
      origin,
    );
    // Screen row 3 shows columns from origin+1, so the tile sits at i = 4.
    expect(tileOf(4, 3)).toEqual(target);
    expect(px(f, 4, 3)).toBe(0x41);
    expect(px(f, 5, 3)).toBe(1);
  });
});

describe('drawTerritoryDots (FUN_00042f7c)', () => {
  it('sets dots on a 2-pixel grid only on owned land (base 0x42)', () => {
    const f = fb();
    drawTerritoryDots(f, makeData(() => ({ owner: 2 })), { col: 0, row: 0 });
    expect(px(f, 0, 0)).toBe(0x4a);
    expect(px(f, 2, 2)).toBe(0x4a);
    // Pixels in between stay untouched (the landscape shows through).
    expect(px(f, 1, 0)).toBe(0);
    expect(px(f, 0, 1)).toBe(0);
  });

  it('leaves unowned land clear', () => {
    const f = fb();
    drawTerritoryDots(f, makeData(), { col: 0, row: 0 });
    expect(px(f, 0, 0)).toBe(0);
  });
});

describe('drawRoadOverlay (FUN_000431fe)', () => {
  it('draws every tile with a road bit in colour 1', () => {
    const f = fb();
    drawRoadOverlay(
      f,
      makeData((col, row) => (col === 10 && row === 6 ? { paths: 0x21 } : {})),
      { col: 0, row: 0 },
    );
    expect(tileOf(7, 6)).toEqual({ col: 10, row: 6 });
    expect(px(f, 7, 6)).toBe(1);
    expect(px(f, 8, 6)).toBe(0);
  });

  it('ignores tiles whose set bits lie outside the road mask', () => {
    const f = fb();
    drawRoadOverlay(f, makeData(() => ({ paths: 0x40 })), { col: 0, row: 0 });
    expect(px(f, 0, 0)).toBe(0);
  });
});

describe('drawBuildingOverlay (FUN_00043afa)', () => {
  // The overlay samples from origin + down-right: screen row j shows tile row row+1+j, column
  // col+1+((j+1)>>1)+i.
  const origin = { col: 0, row: 0 };
  const buildingTile = { col: 6, row: 1 };

  function dataWithBuilding(type: number, owner: number): MapPreviewData {
    const base = makeData((col, row) =>
      col === buildingTile.col && row === buildingTile.row
        ? { object: 2, objIndex: 7, owner: owner + 1 }
        : {},
    );
    const buildings = [];
    buildings[7] = { owner, type };
    return { ...base, buildings };
  }

  it('draws a 2x2 dot in the owner colour (base 0x40)', () => {
    const f = fb();
    drawBuildingOverlay(f, dataWithBuilding(11, 0), origin, makeView());
    expect(px(f, 5, 0)).toBe(0x40);
    expect(px(f, 6, 0)).toBe(0x40);
    expect(px(f, 5, 1)).toBe(0x40);
    expect(px(f, 6, 1)).toBe(0x40);
    expect(px(f, 7, 0)).toBe(0);
  });

  it('filter > 0 shows only buildings of that type', () => {
    const shown = fb();
    drawBuildingOverlay(shown, dataWithBuilding(11, 0), origin, makeView({ buildingFilter: 11 }));
    expect(px(shown, 5, 0)).toBe(0x40);

    const hidden = fb();
    drawBuildingOverlay(hidden, dataWithBuilding(11, 0), origin, makeView({ buildingFilter: 12 }));
    expect(px(hidden, 5, 0)).toBe(0);
  });

  it('filters by player unless all players are shown', () => {
    const hidden = fb();
    drawBuildingOverlay(hidden, dataWithBuilding(11, 1), origin, makeView({ buildingFilter: 11 }));
    expect(px(hidden, 5, 0)).toBe(0);

    const shown = fb();
    drawBuildingOverlay(
      shown,
      dataWithBuilding(11, 1),
      origin,
      makeView({ buildingFilter: 11, showAllPlayers: true }),
    );
    expect(px(shown, 5, 0)).toBe(0x48);
  });

  it('flag mode (filter 0) shows only flags with an unserved road', () => {
    const base = makeData((col, row) =>
      col === buildingTile.col && row === buildingTile.row
        ? { object: 1, objIndex: 4, owner: 1 }
        : {},
    );
    const served = {
      ...base,
      flags: [
        ,
        ,
        ,
        ,
        {
          owner: 0,
          paths: [true, false, false, false, false, false],
          transporters: [true, false, false, false, false, false],
        },
      ],
    } as MapPreviewData;
    const f1 = fb();
    drawBuildingOverlay(f1, served, origin, makeView({ buildingFilter: 0 }));
    expect(px(f1, 5, 0)).toBe(0);

    const unserved = {
      ...base,
      flags: [
        ,
        ,
        ,
        ,
        {
          owner: 0,
          paths: [true, true, false, false, false, false],
          transporters: [true, false, false, false, false, false],
        },
      ],
    } as MapPreviewData;
    const f2 = fb();
    drawBuildingOverlay(f2, unserved, origin, makeView({ buildingFilter: 0 }));
    expect(px(f2, 5, 0)).toBe(0x40);
  });

  it('filter < 0 (the normal case) shows buildings but no flags', () => {
    const base = makeData((col, row) =>
      col === buildingTile.col && row === buildingTile.row
        ? { object: 1, objIndex: 4, owner: 1 }
        : {},
    );
    const f = fb();
    drawBuildingOverlay(f, base, origin, makeView({ buildingFilter: -1 }));
    expect(px(f, 5, 0)).toBe(0);
  });
});

describe('drawBorderLines (FUN_000441e1)', () => {
  it('draws the horizontal seam on map row 0 dashed', () => {
    const f = fb();
    drawBorderLines(f, makeData(), { col: 0, row: 0 });
    // The right edge starts with 0x2f, then alternates with 0x01.
    expect(px(f, 127, 0)).toBe(0x2f);
    expect(px(f, 126, 0)).toBe(0x01);
    expect(px(f, 125, 0)).toBe(0x2f);
    // The map is 64 rows tall, so the seam repeats.
    expect(px(f, 127, 64)).toBe(0x2f);
  });

  it('draws the diagonal seam on map column 0, offset by one every two rows', () => {
    const f = fb();
    drawBorderLines(f, makeData(), { col: 0, row: 0 });
    expect(px(f, 0, 0)).toBe(0x2d);
    expect(px(f, 0, 1)).toBe(0x01);
    // After two screen rows the line moves one column left (here wrapping to 63).
    expect(px(f, 63, 2)).toBe(0x2d);
    expect(px(f, 62, 4)).toBe(0x2d);
  });
});

describe('drawCursorMarker (FUN_00042b8e)', () => {
  const marker: DecodedSprite = {
    width: 2,
    height: 2,
    offsetX: 0,
    offsetY: 0,
    deltaX: 0,
    deltaY: 0,
    pixels: new Uint8ClampedArray([
      9, 9, 9, 255, 9, 9, 9, 255, 9, 9, 9, 255, 9, 9, 9, 255,
    ]),
  };
  const provider: SpriteProvider = (entry) => (entry === gameSprite(PREVIEW_CURSOR_SPRITE) ? marker : null);

  it('puts the marker at the window centre when the cursor is there', () => {
    const f = fb();
    const origin = { col: 0, row: 0 };
    const drawn = drawCursorMarker(
      f,
      makeData(),
      origin,
      makeView({ cursorCol: 0x60, cursorRow: 0x40 }),
      provider,
    );
    expect(drawn).toBe(true);
    expect(f.rgba[((PREVIEW_Y + 0x40) * f.width + PREVIEW_X + 0x40) * 4]).toBe(9);
  });

  it('draws nothing when the cursor lies outside the window', () => {
    // On a 64x64 map no tile is more than 32 away (the window shows it twice); the visibility test
    // only bites on maps larger than the window.
    const big = 256;
    const tiles: MapTile[] = [];
    for (let i = 0; i < big * big; i++) tiles.push(emptyTile());
    const data: MapPreviewData = {
      tiles,
      cols: big,
      rows: big,
      minimap: new Uint8Array(big * big),
      palette: indexPalette(),
      flags: [],
      buildings: [],
    };
    const f = fb();
    const drawn = drawCursorMarker(
      f,
      data,
      { col: 0, row: 0 },
      makeView({ cursorCol: 0x60, cursorRow: 0x40 + 0x39 }),
      provider,
    );
    expect(drawn).toBe(false);
  });

  it('doubles the offset in zoom mode', () => {
    const f = fb();
    const drawn = drawCursorMarker(
      f,
      makeData(),
      { col: 0, row: 0 },
      makeView({ cursorCol: 0x64, cursorRow: 0x40, mode: 0x20 }),
      provider,
    );
    expect(drawn).toBe(true);
    expect(f.rgba[((PREVIEW_Y + 0x40) * f.width + PREVIEW_X + 0x48) * 4]).toBe(9);
  });
});

describe('drawMapPreview (FUN_000422eb)', () => {
  const noSprite: SpriteProvider = () => null;

  it('owner mode replaces the landscape', () => {
    const data = makeData();
    const terrain = fb();
    drawMapPreview(terrain, data, makeView(), noSprite);
    const owner = fb();
    drawMapPreview(owner, data, makeView({ mode: PREVIEW_OWNER_MAP }), noSprite);
    expect(px(owner, 10, 10)).toBe(1);
    expect(px(terrain, 10, 10)).not.toBe(1);
  });

  it('territory dots exist only over the landscape', () => {
    const data = makeData(() => ({ owner: 1 }));
    const dots = fb();
    drawMapPreview(dots, data, makeView({ mode: PREVIEW_TERRITORY_DOTS }), noSprite);
    expect(px(dots, 0, 0)).toBe(0x41 + 1);
    const ownerMap = fb();
    drawMapPreview(
      ownerMap,
      data,
      makeView({ mode: PREVIEW_OWNER_MAP | PREVIEW_TERRITORY_DOTS }),
      noSprite,
    );
    // Pure owner map: 0x41 throughout, no 0x42 dots.
    expect(px(ownerMap, 0, 0)).toBe(0x41);
    expect(px(ownerMap, 2, 2)).toBe(0x41);
  });

  it('switches roads, buildings and border lines on individually', () => {
    const data = makeData((col, row) => (row === 20 && col === 20 ? { paths: 0x01 } : {}));
    const off = fb();
    drawMapPreview(off, data, makeView({ mode: PREVIEW_OWNER_MAP }), noSprite);
    const on = fb();
    drawMapPreview(on, data, makeView({ mode: PREVIEW_OWNER_MAP | PREVIEW_ROADS }), noSprite);
    expect(tileOf(10, 20)).toEqual({ col: 20, row: 20 });
    expect(px(off, 10, 20)).toBe(1);
    expect(px(on, 10, 20)).toBe(1);

    const borders = fb();
    drawMapPreview(borders, data, makeView({ mode: PREVIEW_OWNER_MAP | PREVIEW_BORDERS }), noSprite);
    expect(px(borders, 127, 0)).toBe(0x2f);

    const buildings = fb();
    drawMapPreview(
      buildings,
      data,
      makeView({ mode: PREVIEW_OWNER_MAP | PREVIEW_BUILDINGS }),
      noSprite,
    );
    expect(px(buildings, 127, 0)).toBe(1);
  });
});

describe('click handling (table @0x2ca6d, handlers FUN_0002cd66ff)', () => {
  it('click rectangles cover the map area and the five bar fields without gaps', () => {
    expect(hitTest(MAP_PREVIEW_HITBOXES, 64, 64)).toBe(MAP_PREVIEW_ACTION.GOTO);
    expect(hitTest(MAP_PREVIEW_HITBOXES, 0, 130)).toBe(MAP_PREVIEW_ACTION.MODE);
    expect(hitTest(MAP_PREVIEW_HITBOXES, 40, 130)).toBe(MAP_PREVIEW_ACTION.ROADS);
    expect(hitTest(MAP_PREVIEW_HITBOXES, 70, 143)).toBe(MAP_PREVIEW_ACTION.BUILDINGS);
    expect(hitTest(MAP_PREVIEW_HITBOXES, 100, 128)).toBe(MAP_PREVIEW_ACTION.BORDERS);
    expect(hitTest(MAP_PREVIEW_HITBOXES, 127, 143)).toBe(MAP_PREVIEW_ACTION.ZOOM);
    expect(hitTest(MAP_PREVIEW_HITBOXES, 130, 130)).toBeNull();
  });

  it('a map click is the inverse of the display', () => {
    const origin = { col: 0, row: 0 };
    for (const [i, j] of [
      [0, 0],
      [4, 3],
      [63, 100],
      [127, 127],
    ] as [number, number][]) {
      expect(mapPreviewClickToTile(origin, i, j, COLS, ROWS)).toEqual(tileOf(i, j));
    }
  });

  it('mode click cycles landscape, landscape+owner, owner', () => {
    let s = { mode: 0, buildingFilter: -1 };
    s = applyMapPreviewAction(s, MAP_PREVIEW_ACTION.MODE);
    expect(s.mode & 3).toBe(1);
    s = applyMapPreviewAction(s, MAP_PREVIEW_ACTION.MODE);
    expect(s.mode & 3).toBe(2);
    s = applyMapPreviewAction(s, MAP_PREVIEW_ACTION.MODE);
    expect(s.mode & 3).toBe(0);
  });

  it('mode click leaves the remaining bits alone', () => {
    const s = applyMapPreviewAction(
      { mode: PREVIEW_BORDERS | 2, buildingFilter: -1 },
      MAP_PREVIEW_ACTION.MODE,
    );
    expect(s.mode).toBe(PREVIEW_BORDERS);
  });

  it('roads/borders/zoom toggle their bit', () => {
    const base = { mode: 0, buildingFilter: -1 };
    expect(applyMapPreviewAction(base, MAP_PREVIEW_ACTION.ROADS).mode).toBe(PREVIEW_ROADS);
    expect(applyMapPreviewAction(base, MAP_PREVIEW_ACTION.BORDERS).mode).toBe(PREVIEW_BORDERS);
    expect(applyMapPreviewAction(base, MAP_PREVIEW_ACTION.ZOOM).mode).toBe(0x20);
  });

  it('building click toggles in the normal state and otherwise restores it', () => {
    expect(
      applyMapPreviewAction({ mode: 0, buildingFilter: -1 }, MAP_PREVIEW_ACTION.BUILDINGS),
    ).toEqual({ mode: PREVIEW_BUILDINGS, buildingFilter: -1 });
    expect(
      applyMapPreviewAction({ mode: 0, buildingFilter: 11 }, MAP_PREVIEW_ACTION.BUILDINGS),
    ).toEqual({ mode: PREVIEW_BUILDINGS, buildingFilter: -1 });
  });
});

// --- Zoom branch ----------------------------------------------------------------------------------

describe('mapPreviewZoomOrigin (+0x30 / +0x20)', () => {
  it('sits exactly at the centre of the 1x window, shear included', () => {
    // The sharpest test of the origin arithmetic: the top-left tile of the zoom window must be the
    // one the 1x pass samples at its centre (i=32, j=32). `tileOf` models the 1x pass independently
    // (shear +1 column every second row).
    const zo = mapPreviewZoomOrigin({ col: 0, row: 0 }, COLS, ROWS);
    expect(zo).toEqual(tileOf(32, 32));
    // And with a shifted origin: the offset is constant, the masking toroidal —
    // 60 + 0x30 = 108 -> 44 (mod 64), 50 + 0x20 = 82 -> 18.
    expect(mapPreviewZoomOrigin({ col: 60, row: 50 }, COLS, ROWS)).toEqual({ col: 44, row: 18 });
  });
});

describe('drawOwnerMapZoom (FUN_00042e0b)', () => {
  it('shows the same tiles as the 1x pass at its centre, each as a 2x2 block', () => {
    const data = makeData((col, row) => ({ owner: ((col + row) % 3) + 1 }));
    const zoom = fb();
    drawOwnerMapZoom(zoom, data, { col: 0, row: 0 });
    const plain = fb();
    drawOwnerMap(plain, data, { col: 0, row: 0 });
    let checked = 0;
    for (let j = 0; j < 40; j++) {
      for (let i = 0; i < 40; i++) {
        const want = px(plain, 32 + i, 32 + j);
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          expect(px(zoom, 2 * i + dx, 2 * j + dy)).toBe(want);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(1600);
  });

  it('paints unowned land 1 and owned land from 0x41', () => {
    // The zoom origin is tile (48,32); it appears top-left as a 2x2 block.
    const zo = mapPreviewZoomOrigin({ col: 0, row: 0 }, COLS, ROWS);
    expect(zo).toEqual({ col: 48, row: 32 });
    const data = makeData((col, row) => ({ owner: col === zo.col && row === zo.row ? 1 : 0 }));
    const f = fb();
    drawOwnerMapZoom(f, data, { col: 0, row: 0 });
    expect(px(f, 0, 0)).toBe(0x41);
    expect(px(f, 1, 1)).toBe(0x41);
    expect(px(f, 2, 0)).toBe(1); // neighbouring tile: unowned
  });
});

describe('drawRoadOverlayZoom (FUN_00043305)', () => {
  it('spreads the road directions across the tile\'s four pixels', () => {
    const zo = mapPreviewZoomOrigin({ col: 0, row: 0 }, COLS, ROWS);
    const at = (paths: number) => {
      const data = makeData((col, row) => (col === zo.col && row === zo.row ? { paths } : {}));
      const f = fb();
      drawRoadOverlayZoom(f, data, { col: 0, row: 0 });
      return [px(f, 0, 0), px(f, 1, 0), px(f, 0, 1), px(f, 1, 1)];
    };
    expect(at(0x08)).toEqual([1, 0, 0, 0]); // Up        -> (x,   y)
    expect(at(0x10)).toEqual([1, 0, 0, 0]); // UpLeft    -> (x,   y)
    expect(at(0x20)).toEqual([1, 0, 0, 0]); // Left      -> (x,   y)
    expect(at(0x04)).toEqual([0, 0, 1, 0]); // Down      -> (x,   y+1)
    expect(at(0x01)).toEqual([0, 1, 0, 0]); // Right     -> (x+1, y)
    expect(at(0x02)).toEqual([0, 0, 0, 1]); // DownRight -> (x+1, y+1)
    expect(at(0x3f)).toEqual([1, 1, 1, 1]);
    expect(at(0x00)).toEqual([0, 0, 0, 0]);
  });
});

describe('building overlay: its own colour per base', () => {
  const zo = mapPreviewZoomOrigin({ col: 0, row: 0 }, COLS, ROWS);
  const withBuilding = (col: number, row: number) =>
    makeData((c, r) => (c === col && r === row ? { object: 2, objIndex: 1, owner: 2 } : {}));

  it('owner colour over the landscape (0x40 base), constant 0x2f over the owner map', () => {
    // 1x: the start tile of FUN_00043afa is origin + (1,1), that of FUN_000434bb is the origin.
    const land = fb();
    drawBuildingOverlay(land, withBuilding(1, 1), { col: 0, row: 0 }, makeView());
    expect(px(land, 0, 0)).toBe(0x48); // owner 2 -> 0x40 + 8

    const owner = fb();
    drawBuildingOverlayOwnerMap(owner, withBuilding(0, 0), { col: 0, row: 0 }, makeView());
    expect(px(owner, 0, 0)).toBe(0x2f);
  });

  it('in the zoom branch too: landscape in owner colour, owner map 0x2f', () => {
    const land = fb();
    drawBuildingOverlayZoom(land, withBuilding(zo.col, zo.row), { col: 0, row: 0 }, makeView());
    expect(px(land, 0, 0)).toBe(0x48);

    const owner = fb();
    drawBuildingOverlayOwnerMapZoom(
      owner,
      withBuilding(zo.col, zo.row),
      { col: 0, row: 0 },
      makeView(),
    );
    expect(px(owner, 0, 0)).toBe(0x2f);
  });
});

describe('applyZoomHexOffset (FUN_00042a98)', () => {
  it('shifts every second two-row strip one pixel left', () => {
    const f = fb();
    const pal = indexPalette();
    // Fill every row with a recognisable pattern: pixel index = column within the window.
    for (let j = 0; j < 128; j++) {
      for (let i = 0; i < 128; i++) {
        f.rgba[((PREVIEW_Y + j) * f.width + PREVIEW_X + i) * 4] = i;
        f.rgba[((PREVIEW_Y + j) * f.width + PREVIEW_X + i) * 4 + 3] = 255;
      }
    }
    applyZoomHexOffset(f, pal);
    // Rows 0/1 of each group of four stay, 2/3 move one left.
    expect(px(f, 5, 0)).toBe(5);
    expect(px(f, 5, 1)).toBe(5);
    expect(px(f, 5, 2)).toBe(6);
    expect(px(f, 5, 3)).toBe(6);
    expect(px(f, 5, 4)).toBe(5);
    expect(px(f, 5, 6)).toBe(6);
    // Right edge column (x = 0x87 absolute = window index 127) in colour 1, over all 128 rows.
    for (const j of [0, 1, 2, 3, 64, 127]) expect(px(f, 127, j)).toBe(1);
  });
});

describe('drawMapPreview: dispatch order in the zoom branch', () => {
  it('draws the border lines AFTER the half-tile offset', () => {
    // The offset paints the right edge column (window index 127) entirely in colour 1. The
    // horizontal seam comes afterwards and overwrites it where it lies — in zoom mode on screen row
    // 64 (map row 0 is 32 tiles above the zoom origin, times 2 pixels).
    const data = makeData();
    const f = fb();
    drawMapPreview(f, data, makeView({ mode: PREVIEW_ZOOM | PREVIEW_BORDERS }), () => null);
    expect(px(f, 127, 64)).toBe(0x2f);
    expect(px(f, 126, 64)).toBe(1);
    // Outside the seam the edge column painted by the offset remains.
    expect(px(f, 127, 0)).toBe(1);
    expect(px(f, 127, 63)).toBe(1);
  });
});

/** All set marker pixels (index 213/74) as a set of "x,y". */
function markerPixels(f: Framebuffer): Set<string> {
  const out = new Set<string>();
  for (let j = 0; j < 128; j++) {
    for (let i = 0; i < 128; i++) {
      const v = px(f, i, j);
      if (v === MARKER_COLOR_EVEN || v === MARKER_COLOR_ODD) out.add(`${i},${j}`);
    }
  }
  return out;
}

describe('drawViewportRect (extension: frame in window size)', () => {
  const data = makeData();
  const origin = mapPreviewOrigin(CENTER_COL, CENTER_ROW, COLS, ROWS);

  /**
   * The **real** marker sprite `0x22` as a fixture: 15x15, pivot (−7,−7), only the border set,
   * checkerboard-dashed yellow (palette 213) / dark red (74). Read out of the archive and stored
   * here as data so the test runs without the original archive.
   */
  const markerSprite: DecodedSprite = (() => {
    const px = new Uint8ClampedArray(15 * 15 * 4);
    for (let y = 0; y < 15; y++) {
      for (let x = 0; x < 15; x++) {
        if (x !== 0 && y !== 0 && x !== 14 && y !== 14) continue;
        const p = (y * 15 + x) * 4;
        px[p] = (x + y) % 2 === 0 ? 213 : 74;
        px[p + 3] = 255;
      }
    }
    return { width: 15, height: 15, offsetX: -7, offsetY: -7, deltaX: 0, deltaY: 0, pixels: px };
  })();
  const spriteProvider: SpriteProvider = (entry) =>
    entry === gameSprite(PREVIEW_CURSOR_SPRITE) ? markerSprite : null;

  const bbox = (set: Set<string>) => {
    const pts = [...set].map((k) => k.split(',').map(Number));
    const xs = pts.map((p) => p[0]!);
    const ys = pts.map((p) => p[1]!);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };

  it('at 15x15 pixel-identical to the original sprite — position, shape AND colour', () => {
    // The sharpest test of the extension: at exactly the original sprite's size it must reproduce
    // that sprite's frame. If it does, the generalisation is anchored at the one place where the
    // original makes a statement.
    const view = makeView();
    const a = fb();
    drawCursorMarker(a, data, origin, view, spriteProvider);
    const b = fb();
    drawViewportRect(b, data, origin, view, { cols: 15, rows: 15 });
    expect(markerPixels(b)).toEqual(markerPixels(a));
    for (const key of markerPixels(a)) {
      const [i, j] = key.split(',').map(Number);
      expect(px(b, i!, j!), `Pixel ${key}`).toBe(px(a, i!, j!));
    }
  });

  it('follows the window size: 30x20 gives a 30x20 frame around the same centre', () => {
    const sprite = fb();
    drawCursorMarker(sprite, data, origin, makeView(), spriteProvider);
    const s = bbox(markerPixels(sprite));

    const f = fb();
    drawViewportRect(f, data, origin, makeView(), { cols: 30, rows: 20 });
    const r = bbox(markerPixels(f));
    expect(r.x1 - r.x0 + 1).toBe(30);
    expect(r.y1 - r.y0 + 1).toBe(20);
    // Centre unchanged, only the edge length grows. With an EVEN edge length the centre inevitably
    // lies between two pixels, hence the half-pixel tolerance.
    expect(Math.abs((r.x0 + r.x1) / 2 - (s.x0 + s.x1) / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((r.y0 + r.y1) / 2 - (s.y0 + s.y1) / 2)).toBeLessThanOrEqual(0.5);
  });

  it('only the border is set, the interior stays clear', () => {
    const f = fb();
    drawViewportRect(f, data, origin, makeView(), { cols: 21, rows: 13 });
    expect(markerPixels(f).size).toBe(2 * 21 + 2 * (13 - 2));
  });

  it('the zoom doubles the frame (one pixel is half a tile there)', () => {
    const f = fb();
    drawViewportRect(f, data, origin, makeView({ mode: PREVIEW_ZOOM }), { cols: 10, rows: 8 });
    const r = bbox(markerPixels(f));
    expect(r.x1 - r.x0 + 1).toBe(20);
    expect(r.y1 - r.y0 + 1).toBe(16);
  });

  it('clips to the window area instead of writing beside it', () => {
    const f = fb();
    drawViewportRect(f, data, origin, makeView(), { cols: 400, rows: 300 });
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        const inside =
          x >= PREVIEW_X && x < PREVIEW_X + 128 && y >= PREVIEW_Y && y < PREVIEW_Y + 128;
        if (inside) continue;
        expect(f.rgba[(y * f.width + x) * 4 + 3], `pixel ${x},${y} outside`).toBe(0);
      }
    }
  });

  it('the dispatcher picks the frame only with `viewportSpan`, otherwise the sprite', () => {
    const withSprite = fb();
    drawMapPreview(withSprite, data, makeView(), spriteProvider);
    expect(bbox(markerPixels(withSprite)).x1 - bbox(markerPixels(withSprite)).x0 + 1).toBe(15);

    const withRect = fb();
    drawMapPreview(
      withRect,
      data,
      makeView({ viewportSpan: { cols: 40, rows: 30 } }),
      spriteProvider,
    );
    expect(bbox(markerPixels(withRect)).x1 - bbox(markerPixels(withRect)).x0 + 1).toBe(40);
  });

  it('round trip: clicking the frame centre yields the centre tile again', () => {
    // This ties the input together: what the frame shows, the click must hit.
    for (const [c, r] of [
      [CENTER_COL, CENTER_ROW],
      [CENTER_COL + 9, CENTER_ROW + 6],
      [CENTER_COL - 5, CENTER_ROW - 11],
    ]) {
      const view = makeView({ cursorCol: c! & (COLS - 1), cursorRow: r! & (ROWS - 1) });
      const f = fb();
      expect(drawViewportRect(f, data, origin, view, { cols: 15, rows: 15 })).toBe(true);
      const b = bbox(markerPixels(f));
      const t = mapPreviewClickToTile(origin, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, COLS, ROWS, false);
      expect(t, `tile ${view.cursorCol},${view.cursorRow}`).toEqual({
        col: view.cursorCol,
        row: view.cursorRow,
      });
    }
  });
});

describe('aspect ratio of the viewport frame', () => {
  // The overview shows **one tile per pixel**, and a tile is 32 x 20 scene pixels. x and y are
  // therefore squashed by DIFFERENT factors — the overview cannot preserve the screen's aspect ratio
  // at all (the whole 64x64 world is 2048x1280 scene pixels and is shown as 64x64 pixels). The frame
  // shares that distortion, which is exactly why it marks the right tiles. Expectation: frame aspect
  // == window aspect · 20/32.
  it('is deliberately NOT the window aspect but squashed by 20/32', () => {
    for (const [w, h] of [[640, 480], [1600, 900], [1920, 1080]]) {
      const cols = w! / TILE_W;
      const rows = h! / TILE_H;
      expect(cols / rows).toBeCloseTo((w! / h!) * (TILE_H / TILE_W), 6);
    }
  });

  it('the four frame corners are the four window corners (to within one tile)', () => {
    // The real statement: despite the differing aspect, the frame coincides with what the main view
    // shows. In TILE coordinates the corners are heavily sheared (at 1600x900 top-left and
    // bottom-left lie 42 columns apart) — in preview pixels they still form an axis-aligned
    // rectangle. That is the shear compensation.
    const flat = () => 0;
    const data = makeData();
    for (const [w, h] of [[640, 480], [800, 500], [1600, 900], [320, 192]]) {
      // Centre the view on the tile that sits in the middle of the overview window — then the
      // frame sits unclipped in the centre, and its position is NOT presupposed but read out of the
      // drawn image.
      const origin = mapPreviewOrigin(CENTER_COL, CENTER_ROW, COLS, ROWS);
      const centerTile = {
        col: (origin.col + 0x60) & (COLS - 1),
        row: (origin.row + 0x40) & (ROWS - 1),
      };
      const cam = {
        ...cameraCenteredOnTile(centerTile.col, centerTile.row, w!, h!),
        width: w!,
        height: h!,
      };
      const view = makeView({ cursorCol: centerTile.col, cursorRow: centerTile.row });
      const f = fb();
      expect(
        drawViewportRect(f, data, origin, view, { cols: w! / TILE_W, rows: h! / TILE_H }),
      ).toBe(true);

      const set = [...markerPixels(f)].map((k) => k.split(',').map(Number));
      const xs = set.map((q) => q[0]!);
      const ys = set.map((q) => q[1]!);
      const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
      const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
      expect(x1 - x0 + 1, `${w}x${h} frame width`).toBe(Math.round(w! / TILE_W));
      expect(y1 - y0 + 1, `${w}x${h} frame height`).toBe(Math.round(h! / TILE_H));

      const corners: [number, number, number, number][] = [
        [x0, y0, 0, 0],
        [x1, y0, w! - 1, 0],
        [x0, y1, 0, h! - 1],
        [x1, y1, w! - 1, h! - 1],
      ];
      for (const [rx, ry, wx, wy] of corners) {
        const inRect = mapPreviewClickToTile(origin, rx!, ry!, COLS, ROWS, false);
        const inWindow = windowToTile(wx!, wy!, cam, geoTest, flat, 0);
        const dc = ((inRect.col - inWindow.col + COLS / 2) & (COLS - 1)) - COLS / 2;
        const dr = ((inRect.row - inWindow.row + ROWS / 2) & (ROWS - 1)) - ROWS / 2;
        expect(Math.abs(dc), `${w}x${h} corner (${wx},${wy}) column`).toBeLessThanOrEqual(1);
        expect(Math.abs(dr), `${w}x${h} corner (${wx},${wy}) row`).toBeLessThanOrEqual(1);
      }
    }
  });
});

// --- Downscaled window (extension, `tileStep`) ---------------------------------------------------

describe('previewTileStep', () => {
  // The cap is why nothing changes for the campaign maps.
  it('stays 1 on maps up to 128 tiles ALWAYS, even for a huge viewport', () => {
    for (const [c, r] of [[32, 32], [64, 64], [128, 64], [128, 128]] as const) {
      expect(previewTileStep(9999, 9999, c, r), `${c}x${r}`).toBe(1);
    }
  });

  it('picks the smallest power of two the viewport fits into', () => {
    expect(previewTileStep(60, 44, 256, 128)).toBe(1); // already fits 1:1
    expect(previewTileStep(128, 128, 256, 128)).toBe(1); // exactly full
    expect(previewTileStep(129, 44, 256, 128)).toBe(2);
    expect(previewTileStep(168, 127, 256, 128)).toBe(2);
    expect(previewTileStep(300, 44, 512, 256)).toBe(4);
  });

  it('caps at "whole map in the window"', () => {
    expect(previewTileStep(99999, 99999, 256, 128)).toBe(2);
    expect(previewTileStep(99999, 99999, 512, 256)).toBe(4);
  });
});

describe('mapPreviewOrigin — downscaled', () => {
  it('aligns to the grown block grid and keeps the centre in the window', () => {
    const cols = 256;
    const rows = 128;
    for (const step of [1, 2] as const) {
      for (const [cc, cr] of [[0x54 * 2, 0x38 * 2], [77, 41], [3, 120]] as const) {
        const o = mapPreviewOrigin(cc, cr, cols, rows, step);
        expect(o.row % (16 * step), `grid ${step}`).toBe(0);
        // Tile at the window centre (preview pixel 64/64): origin + 96·step / 64·step.
        const midRow = (o.row + 0x40 * step) & (rows - 1);
        const midCol = (o.col + 0x60 * step) & (cols - 1);
        // The block alignment may be off by at most one grid step; more would be a bug.
        const dr = Math.min((midRow - cr) & (rows - 1), (cr - midRow) & (rows - 1));
        const dc = Math.min((midCol - cc) & (cols - 1), (cc - midCol) & (cols - 1));
        expect(dr, `row ${step}/${cc}/${cr}`).toBeLessThanOrEqual(16 * step);
        expect(dc, `column ${step}/${cc}/${cr}`).toBeLessThanOrEqual(16 * step);
      }
    }
  });
});

describe('overlays downscaled — aggregating instead of sampling', () => {
  const BIG_COLS = 256;
  const BIG_ROWS = 128;
  const STEP = 2;

  function bigData(patch: (col: number, row: number) => Partial<MapTile>): MapPreviewData {
    const tiles: MapTile[] = [];
    for (let row = 0; row < BIG_ROWS; row++) {
      for (let col = 0; col < BIG_COLS; col++) tiles.push({ ...emptyTile(), ...patch(col, row) });
    }
    return {
      tiles,
      cols: BIG_COLS,
      rows: BIG_ROWS,
      minimap: buildMinimap(tiles, BIG_COLS, BIG_ROWS),
      palette: indexPalette(),
      flags: [],
      buildings: [],
    };
  }

  const bigView = (patch: Partial<MapPreviewView> = {}): MapPreviewView => ({
    centerCol: 0x54 * STEP,
    centerRow: 0x38 * STEP,
    cursorCol: 0x54 * STEP,
    cursorRow: 0x38 * STEP,
    mode: 0,
    buildingFilter: -1,
    playerIndex: 0,
    ...patch,
  });

  /**
   * The point: a road is ONE tile wide. Plain sampling at step 2 would show only every fourth one,
   * turning a road into speckles. Hence each of a block's four tiles is checked individually;
   * without aggregating, three of them would fail.
   */
  it('a road is found whichever of the block\'s four tiles it lies on', () => {
    for (let dj = 0; dj < STEP; dj++) {
      for (let di = 0; di < STEP; di++) {
        const origin = mapPreviewOrigin(0x54 * STEP, 0x38 * STEP, BIG_COLS, BIG_ROWS, STEP);
        // Target tile: preview pixel (10, 20) plus the offset inside the block.
        const row = origin.row + 20 * STEP + dj;
        const col = origin.col + ((20 * STEP) >> 1) + 10 * STEP + di;
        const data = bigData((c, r) =>
          c === (col & (BIG_COLS - 1)) && r === (row & (BIG_ROWS - 1)) ? { paths: 0x01 } : {},
        );
        const f = fb();
        drawRoadOverlay(f, data, origin, STEP);
        expect(px(f, 10, 20), `offset ${di}/${dj}`).toBe(1);
      }
    }
  });

  it('a building is found wherever in the block it stands', () => {
    for (let dj = 0; dj < STEP; dj++) {
      for (let di = 0; di < STEP; di++) {
        const origin = mapPreviewOrigin(0x54 * STEP, 0x38 * STEP, BIG_COLS, BIG_ROWS, STEP);
        // The building overlay samples one tile down-right and shears one row later.
        const row = origin.row + 1 + 20 * STEP + dj;
        const col = origin.col + 1 + (((20 * STEP) + 1) >> 1) + 10 * STEP + di;
        const data = bigData((c, r) =>
          c === (col & (BIG_COLS - 1)) && r === (row & (BIG_ROWS - 1))
            ? { object: 2, owner: 1 }
            : {},
        );
        const f = fb();
        drawBuildingOverlay(f, data, origin, bigView(), STEP);
        expect(px(f, 10, 20), `offset ${di}/${dj}`).toBe(0x40);
      }
    }
  });

  it('own land is found wherever in the block it lies', () => {
    for (let dj = 0; dj < STEP; dj++) {
      for (let di = 0; di < STEP; di++) {
        const origin = mapPreviewOrigin(0x54 * STEP, 0x38 * STEP, BIG_COLS, BIG_ROWS, STEP);
        const row = origin.row + 2 * 20 * STEP + dj;
        const col = origin.col + 20 * STEP + 2 * 10 * STEP + di;
        const data = bigData((c, r) =>
          c === (col & (BIG_COLS - 1)) && r === (row & (BIG_ROWS - 1)) ? { owner: 1 } : {},
        );
        const f = fb();
        drawTerritoryDots(f, data, origin, STEP);
        expect(px(f, 2 * 10, 2 * 20), `offset ${di}/${dj}`).toBe(0x42);
      }
    }
  });

  it('the click hits the tile that was shown', () => {
    const origin = mapPreviewOrigin(0x54 * STEP, 0x38 * STEP, BIG_COLS, BIG_ROWS, STEP);
    // Clicking the window centre gives the tile the marker arithmetic treats as the centre.
    const t = mapPreviewClickToTile(origin, 64, 64, BIG_COLS, BIG_ROWS, false, STEP);
    expect(t.row).toBe((origin.row + 0x40 * STEP) & (BIG_ROWS - 1));
    expect(t.col).toBe((origin.col + 0x60 * STEP) & (BIG_COLS - 1));
  });

  it('at step 2 the window covers all 256 columns', () => {
    const origin = mapPreviewOrigin(0x54 * STEP, 0x38 * STEP, BIG_COLS, BIG_ROWS, STEP);
    const seen = new Set<number>();
    for (let j = 0; j < 128; j++) {
      for (let i = 0; i < 128; i++) {
        seen.add((origin.col + ((j * STEP) >> 1) + i * STEP) & (BIG_COLS - 1));
      }
    }
    expect(seen.size).toBe(BIG_COLS);
  });
});
