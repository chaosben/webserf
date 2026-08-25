import { describe, it, expect } from 'vitest';
import type { DecodedSprite } from './types.js';
import {
  UI_ICON_BASE,
  UI_OBJECT_BASE,
  FONT_FIRST_GLYPH,
  GLYPH_ORDER,
  GLYPH_ENTRY,
  GLYPH_ADVANCE,
  panelX,
  panelY,
  createFramebuffer,
  clearFramebuffer,
  blitSprite,
  blitSpriteNoPivot,
  blitForBank,
  drawText,
  drawLayout,
  drawPanelIcon,
  tileBackground,
  MINE_PANEL_LAYOUT,
  SMALL_BUILDING_LAYOUT,
  POPUP_SCREENS,
  POPUP_FRAME,
  POPUP_PLAYER_BUTTONS,
  drawPopupPlayerButtons,
  hitPopupPlayerButton,
  drawPopupScreen,
  drawPopupFrame,
  UI_PANELBUTTON_BASE,
  CONTROL_PANEL_BOUNDS,
  POPUP_BOUNDS,
  POPUP_CLICK_ANCHOR,
  UI_SCREEN,
  CONTROL_PANEL_BUTTON_COUNT,
  CONTROL_PANEL_START_X,
  CONTROL_PANEL_STRIDE,
  CONTROL_PANEL_Y,
  CONTROL_PANEL_DEFAULT_ICONS,
  controlPanelIconsAfterClose,
  mapSpecialClickScreen,
  CONTROL_PANEL_FRAME,
  CONTROL_PANEL_FRAME_SMALL,
  CONTROL_PANEL_SMALL_ORIGIN,
  SCREEN_BORDER_SMALL,
  SCREEN_BORDER_SMALL_SPLIT,
  drawScreenChromeSmall,
  CONTROL_PANEL_BUTTON_ACTIONS,
  contextBarState,
  CURSOR_MARKER_BASE,
  CURSOR_MARKER_FLAG,
  CURSOR_MARKER_NONE,
  CURSOR_MARKER_ROAD_NEW,
  drawPanelButton,
  drawControlPanel,
  drawControlPanelFrame,
  hitTestControlPanelButton,
  clickControlPanel,
  hitTest,
  hitTestPanel,
  PANEL_CLICK_ORIGIN_X,
  PANEL_CLICK_ORIGIN_Y,
  highlightHitRect,
  MINE_PANEL_HITBOXES,
  MINE_PANEL_ACTIONS,
  mapPreviewBarIcons,
  drawMapPreviewBar,
  MAP_PREVIEW_BAR_COLS,
  MAP_PREVIEW_BAR_ROW,
  MAP_PREVIEW_FLAG_BIT3,
  strokeRect,
  type Framebuffer,
  type SpriteProvider,
} from './ui-render.js';

/** Text colour as in the original (palette index 0x1f of the game palette). */
const TEXT = [115, 179, 67] as const;

/** Builds a single-colour, fully opaque test sprite. */
function solidSprite(w: number, h: number, r = 10, g = 20, b = 30): DecodedSprite {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return { width: w, height: h, offsetX: 0, offsetY: 0, deltaX: 0, deltaY: 0, pixels };
}

/** Read pixel (r,g,b,a) at (x,y). */
function px(fb: Framebuffer, x: number, y: number): [number, number, number, number] {
  const o = (y * fb.width + x) * 4;
  return [fb.rgba[o]!, fb.rgba[o + 1]!, fb.rgba[o + 2]!, fb.rgba[o + 3]!];
}

describe('sprite bank constants (off-by-one atlas-1)', () => {
  it('icon bank 0x366=870 is entry 869, object bank 0x4e2=1250 is 1249', () => {
    expect(UI_ICON_BASE).toBe(869);
    expect(UI_OBJECT_BASE).toBe(1249);
  });
});

describe('font glyph mapping', () => {
  it('has exactly 44 glyphs from entry 749', () => {
    expect(GLYPH_ORDER.length).toBe(44);
    expect(GLYPH_ENTRY.size).toBe(44);
    expect(FONT_FIRST_GLYPH).toBe(749);
  });

  it('maps letters, digits and punctuation to the read-off entries', () => {
    expect(GLYPH_ENTRY.get('A')).toBe(749);
    expect(GLYPH_ENTRY.get('Z')).toBe(774);
    expect(GLYPH_ENTRY.get('Ä')).toBe(775);
    expect(GLYPH_ENTRY.get('Ö')).toBe(776);
    expect(GLYPH_ENTRY.get('Ü')).toBe(777);
    expect(GLYPH_ENTRY.get('0')).toBe(778);
    expect(GLYPH_ENTRY.get('9')).toBe(787);
    expect(GLYPH_ENTRY.get('.')).toBe(788);
    expect(GLYPH_ENTRY.get('-')).toBe(789);
    expect(GLYPH_ENTRY.get(':')).toBe(790);
    expect(GLYPH_ENTRY.get('?')).toBe(791);
    expect(GLYPH_ENTRY.get('%')).toBe(792);
  });

  it('has no space glyph, only advance', () => {
    expect(GLYPH_ENTRY.has(' ')).toBe(false);
  });
});

describe('panel coordinate convention', () => {
  it('col*8+8 / row+9', () => {
    expect(panelX(0)).toBe(8);
    expect(panelX(2)).toBe(24);
    expect(panelX(14)).toBe(120);
    expect(panelY(0)).toBe(9);
    expect(panelY(77)).toBe(86);
  });
});

describe('Framebuffer + blitSprite', () => {
  it('clearFramebuffer fills opaque', () => {
    const fb = createFramebuffer(4, 4);
    clearFramebuffer(fb, 1, 2, 3);
    expect(px(fb, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(px(fb, 3, 3)).toEqual([1, 2, 3, 255]);
  });

  it('blits opaque pixels and respects framebuffer bounds (clipping)', () => {
    const fb = createFramebuffer(4, 4);
    // place the 3x3 sprite so that it overruns to the right and bottom
    blitSprite(fb, solidSprite(3, 3, 100, 110, 120), 2, 2);
    expect(px(fb, 2, 2)).toEqual([100, 110, 120, 255]);
    expect(px(fb, 3, 3)).toEqual([100, 110, 120, 255]);
    // (4,4) does not exist - no crash, (0,0) untouched
    expect(px(fb, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('skips transparent pixels (alpha < 128)', () => {
    const s = solidSprite(2, 1, 200, 0, 0);
    s.pixels[0 * 4 + 3] = 0; // first pixel transparent
    const fb = createFramebuffer(2, 1);
    clearFramebuffer(fb, 5, 5, 5);
    blitSprite(fb, s, 0, 0);
    expect(px(fb, 0, 0)).toEqual([5, 5, 5, 255]); // unchanged
    expect(px(fb, 1, 0)).toEqual([200, 0, 0, 255]); // set
  });

  it('maskColor colours the silhouette instead of the raw RGB', () => {
    const fb = createFramebuffer(1, 1);
    blitSprite(fb, solidSprite(1, 1, 9, 9, 9), 0, 0, [255, 128, 0]);
    expect(px(fb, 0, 0)).toEqual([255, 128, 0, 255]);
  });

  it('adds the archive pivot, like the blit worker @0x63fda/@0x63fde', () => {
    const s = { ...solidSprite(1, 1, 7, 7, 7), offsetX: -1, offsetY: -1 };
    const fb = createFramebuffer(3, 3);
    blitSprite(fb, s, 2, 2);
    // The pivot pulls the pixel from (2,2) to (1,1) - that is what turns the 10x10 shadow sprite
    // into a one-pixel outline around the 8x8 glyph at the same nominal place.
    expect(px(fb, 1, 1)).toEqual([7, 7, 7, 255]);
    expect(px(fb, 2, 2)).toEqual([0, 0, 0, 0]);
  });
});

describe('drawText', () => {
  const provider: SpriteProvider = (entry) =>
    // every glyph is an 8x8 opaque square so placement and advance can be measured
    entry >= FONT_FIRST_GLYPH && entry < FONT_FIRST_GLYPH + 44 ? solidSprite(8, 8, entry & 0xff, 0, 0) : null;

  it('places glyphs with an 8 px advance and skips spaces', () => {
    const fb = createFramebuffer(48, 8);
    drawText(fb, provider, 'A B', 0, 0, TEXT);
    // 'A' at x=0, ' ' skipped (no sprite), 'B' at x=16
    expect(px(fb, 0, 0)[3]).toBe(255); // A drawn
    expect(px(fb, 8, 0)).toEqual([0, 0, 0, 0]); // space column empty
    expect(px(fb, 16, 0)[3]).toBe(255); // B drawn
    expect(GLYPH_ADVANCE).toBe(8);
  });

  it('colours text via maskColor', () => {
    const fb = createFramebuffer(8, 8);
    drawText(fb, provider, 'A', 0, 0, [12, 34, 56]);
    expect(px(fb, 0, 0)).toEqual([12, 34, 56, 255]);
  });
});

describe('drawLayout', () => {
  it('draws sprite base+icon at panelX/panelY', () => {
    const seen: { entry: number; x: number }[] = [];
    const provider: SpriteProvider = (entry) => {
      seen.push({ entry, x: -1 });
      return solidSprite(1, 1);
    };
    const fb = createFramebuffer(160, 160);
    drawLayout(fb, provider, [{ icon: 5, col: 2, row: 8 }], UI_OBJECT_BASE);
    expect(seen[0]!.entry).toBe(UI_OBJECT_BASE + 5);
    // pixel at (panelX(2), panelY(8)) = (24, 17) is set
    expect(px(fb, panelX(2), panelY(8))[3]).toBe(255);
  });
});

/**
 * The two blit primitives and their bank.
 *
 * Object bank graphics carry a sprite pivot (on the map they sit around their foot point), UI bank
 * graphics do not - and the original has two primitives for that: `0x290` adds the pivot
 * (`add 0x6(%esi),%bx` @0x63b59), `0x790` zeroes it beforehand (@0x7f4/@0x7ff).
 */
describe('blit primitive per bank (pivot)', () => {
  /** Sprite with a pivot, as the object bank building graphics carry it. */
  const pivoted = (): DecodedSprite => ({ ...solidSprite(2, 2), offsetX: -16, offsetY: -20 });

  it('blitSprite applies the pivot (map convention, `call 0x290` to @0x63b59)', () => {
    const fb = createFramebuffer(64, 64);
    blitSprite(fb, pivoted(), 40, 40);
    expect(px(fb, 40 - 16, 40 - 20)[3]).toBe(255);
    expect(px(fb, 40, 40)[3]).toBe(0);
  });

  it('blitSpriteNoPivot ignores it (UI convention, `call 0x790` zeroes @0x7f4/@0x7ff)', () => {
    const fb = createFramebuffer(64, 64);
    blitSpriteNoPivot(fb, pivoted(), 40, 40);
    expect(px(fb, 40, 40)[3]).toBe(255);
    expect(px(fb, 40 - 16, 40 - 20)[3]).toBe(0);
  });

  it('blitSpriteNoPivot leaves the passed sprite unchanged (the original restores it)', () => {
    const s = pivoted();
    blitSpriteNoPivot(createFramebuffer(64, 64), s, 40, 40);
    expect([s.offsetX, s.offsetY]).toEqual([-16, -20]);
  });

  it('the bank picks the primitive: object bank pivot-free, icon bank with pivot', () => {
    expect(blitForBank(UI_OBJECT_BASE)).toBe(blitSpriteNoPivot);
    expect(blitForBank(UI_ICON_BASE)).toBe(blitSprite);
  });

  it('drawLayout of the object bank sets the pixel at the layout position, not pivot-shifted', () => {
    const provider: SpriteProvider = () => pivoted();
    const fb = createFramebuffer(160, 160);
    drawLayout(fb, provider, [{ icon: 5, col: 4, row: 40 }], UI_OBJECT_BASE);
    expect(px(fb, panelX(4), panelY(40))[3]).toBe(255);
    expect(px(fb, panelX(4) - 16, panelY(40) - 20)[3]).toBe(0);
  });

  it('drawPanelIcon draws the same line (object bank pivot-free)', () => {
    const provider: SpriteProvider = () => pivoted();
    const fb = createFramebuffer(160, 160);
    drawPanelIcon(fb, provider, 5, 4, 40, UI_OBJECT_BASE);
    expect(px(fb, panelX(4), panelY(40))[3]).toBe(255);
  });
});

describe('tileBackground', () => {
  it('tiles the icon over the 8x9 grid (col 0..14 step 2, row 0..128 step 16)', () => {
    const provider: SpriteProvider = (entry) =>
      entry === UI_ICON_BASE + 0x83 ? solidSprite(16, 16) : null;
    const fb = createFramebuffer(160, 160);
    tileBackground(fb, provider, 0x83);
    // all 72 tile corners set (8 columns x 9 rows)
    for (let row = 0; row <= 128; row += 16) {
      for (let col = 0; col <= 14; col += 2) {
        expect(px(fb, panelX(col), panelY(row))[3]).toBe(255);
      }
    }
  });
});

describe('MINE_PANEL_LAYOUT (box 3 data)', () => {
  it('has 4 mine previews with the verified coordinates', () => {
    expect(MINE_PANEL_LAYOUT).toHaveLength(4);
    expect(MINE_PANEL_LAYOUT.map((i) => i.icon)).toEqual([0xa3, 0xa4, 0xa5, 0xa6]);
    expect(MINE_PANEL_LAYOUT[0]).toEqual({ icon: 0xa3, col: 2, row: 8 });
    expect(MINE_PANEL_LAYOUT[3]).toEqual({ icon: 0xa6, col: 10, row: 77 });
  });
});

describe('popup screens (table driven)', () => {
  it('SMALL_BUILDING_LAYOUT: 7 economy buildings from table @0x3d10b', () => {
    expect(SMALL_BUILDING_LAYOUT).toHaveLength(7);
    expect(SMALL_BUILDING_LAYOUT.map((i) => i.icon)).toEqual([0xab, 0xa9, 0xa8, 0xaa, 0xa7, 0xbc, 0xae]);
    expect(SMALL_BUILDING_LAYOUT[0]).toEqual({ icon: 0xab, col: 10, row: 13 });
  });

  it('POPUP_SCREENS knows screen 3 (mines) and 4 (economy)', () => {
    expect(POPUP_SCREENS.get(3)?.layout).toBe(MINE_PANEL_LAYOUT);
    expect(POPUP_SCREENS.get(4)?.layout).toBe(SMALL_BUILDING_LAYOUT);
  });

  it('drawPopupScreen: known screen returns true and draws the layout, unknown returns false', () => {
    const provider: SpriteProvider = () => solidSprite(16, 16);
    const fb = createFramebuffer(160, 176);
    expect(drawPopupScreen(fb, provider, 4)).toBe(true);
    // first economy building preview (icon 0xab, col 10 / row 13) is set
    expect(px(fb, panelX(10), panelY(13))[3]).toBe(255);
    expect(drawPopupScreen(fb, provider, 99)).toBe(false);
  });

  it('POPUP_FRAME: 4 frame parts (659..662) at the original positions', () => {
    expect(POPUP_FRAME.map((f) => f.entry)).toEqual([659, 660, 661, 662]);
    expect(POPUP_FRAME).toEqual([
      { entry: 659, x: 0, y: 0 },
      { entry: 660, x: 0, y: 153 },
      { entry: 661, x: 0, y: 9 },
      { entry: 662, x: 136, y: 9 },
    ]);
  });

  it('drawPopupFrame blits the 4 parts top-left (with ox/oy offset)', () => {
    const asked: number[] = [];
    const provider: SpriteProvider = (e) => {
      asked.push(e);
      return solidSprite(8, 8);
    };
    const fb = createFramebuffer(160, 176);
    drawPopupFrame(fb, provider);
    expect(asked).toEqual([659, 660, 661, 662]);
    // top bar at (0,0) is set
    expect(px(fb, 0, 0)[3]).toBe(255);
    // right bar at (136,9) is set
    expect(px(fb, 136, 9)[3]).toBe(255);
  });
});

describe('build popup screen 2 - map preview control bar (FUN_000424ad)', () => {
  it('mapPreviewBarIcons: page arrow states (slot 2) byte-exact', () => {
    // page == 0 gives 0x132; page > 0 gives 0x131; page < 0 gives 5 with bit 3 set, else 6
    expect(mapPreviewBarIcons(0, 0)[2]).toBe(0x132);
    expect(mapPreviewBarIcons(0, 1)[2]).toBe(0x131);
    expect(mapPreviewBarIcons(0, -1)[2]).toBe(6); // bit 3 clear
    expect(mapPreviewBarIcons(MAP_PREVIEW_FLAG_BIT3, -1)[2]).toBe(5); // bit 3 set
  });

  it('mapPreviewBarIcons: slot 0 = flags&3, slots 1/3/4 depend on flags', () => {
    // all relevant bits clear gives the default icons
    expect(mapPreviewBarIcons(0, 0)).toEqual([0, 4, 0x132, 8, 0x5c]);
    // all relevant bits set (0x3f) gives active icons; page > 0 keeps slot 2 = 0x131
    expect(mapPreviewBarIcons(0x3f, 1)).toEqual([3, 3, 0x131, 7, 0x5b]);
    // slot 0 mirrors only bits 0-1
    expect(mapPreviewBarIcons(0x02, 0)[0]).toBe(2);
    expect(mapPreviewBarIcons(0x01, 0)[0]).toBe(1);
  });

  it('drawMapPreviewBar: 5 icons from the icon bank at cols {0,4,8,0xc,0xe}, row 0x80 (y=137)', () => {
    const asked: number[] = [];
    const provider: SpriteProvider = (e) => {
      asked.push(e);
      return solidSprite(8, 8);
    };
    const fb = createFramebuffer(160, 176);
    drawMapPreviewBar(fb, provider, 0, 0);
    // icon bank entries = UI_ICON_BASE + [0,4,0x132,8,0x5c]
    expect(asked).toEqual([0, 4, 0x132, 8, 0x5c].map((i) => UI_ICON_BASE + i));
    // first slot (col 0) is panelX(0)=8, panelY(0x80)=137
    expect(px(fb, panelX(0), panelY(MAP_PREVIEW_BAR_ROW))[3]).toBe(255);
    // page arrow slot (col 8) is panelX(8)=72
    expect(px(fb, panelX(8), panelY(MAP_PREVIEW_BAR_ROW))[3]).toBe(255);
  });

  it('MAP_PREVIEW_BAR_COLS/ROW: original constants', () => {
    expect(MAP_PREVIEW_BAR_COLS).toEqual([0, 4, 8, 0xc, 0xe]);
    expect(MAP_PREVIEW_BAR_ROW).toBe(0x80);
    expect(panelY(MAP_PREVIEW_BAR_ROW)).toBe(137);
  });
});

describe('control bar (PanelButton bank)', () => {
  it('binary layout constants (full screen 640x480, from FUN_000061bf/FUN_00005982)', () => {
    expect(UI_PANELBUTTON_BASE).toBe(1749);
    expect(CONTROL_PANEL_BUTTON_COUNT).toBe(5);
    expect(CONTROL_PANEL_START_X).toBe(208); // panel[0x6a] = 0xd0
    expect(CONTROL_PANEL_STRIDE).toBe(48); // panel[0xa0] = 0x30
    expect(CONTROL_PANEL_Y).toBe(444); // panel[0x30]+4 = 0x1bc
    expect([...CONTROL_PANEL_DEFAULT_ICONS]).toEqual([0, 7, 10, 12, 14]); // panel[0x60..0x64]
  });

  it('drawPanelButton blits the PanelButton entry (bank + icon) at (x,y)', () => {
    let asked = -1;
    const provider: SpriteProvider = (e) => {
      asked = e;
      return solidSprite(32, 32);
    };
    const fb = createFramebuffer(64, 64);
    drawPanelButton(fb, provider, 14, 0, 0);
    expect(asked).toBe(UI_PANELBUTTON_BASE + 14);
    expect(px(fb, 0, 0)[3]).toBe(255);
  });

  it('drawControlPanel blits 5 buttons top-left at start x + i*stride, constant y', () => {
    const asked: number[] = [];
    const provider: SpriteProvider = (e) => {
      asked.push(e);
      return solidSprite(32, 32);
    };
    // framebuffer large enough for absolute full-screen coordinates
    const fb = createFramebuffer(640, 480);
    drawControlPanel(fb, provider);
    expect(asked).toEqual(CONTROL_PANEL_DEFAULT_ICONS.map((ic) => UI_PANELBUTTON_BASE + ic));
    // first button: top left corner at (208, 444)
    expect(px(fb, CONTROL_PANEL_START_X, CONTROL_PANEL_Y)[3]).toBe(255);
    expect(px(fb, CONTROL_PANEL_START_X - 1, CONTROL_PANEL_Y)[3]).toBe(0);
    // fifth button starts at 208 + 4*48 = 400
    expect(px(fb, CONTROL_PANEL_START_X + 4 * CONTROL_PANEL_STRIDE, CONTROL_PANEL_Y)[3]).toBe(255);
  });

  it('drawControlPanel: (ox,oy) shifts all button positions', () => {
    const provider: SpriteProvider = () => solidSprite(32, 32);
    const fb = createFramebuffer(640, 80);
    drawControlPanel(fb, provider, CONTROL_PANEL_DEFAULT_ICONS, 0, -400);
    // button 1 ends up at (208, 444-400 = 44)
    expect(px(fb, CONTROL_PANEL_START_X, CONTROL_PANEL_Y - 400)[3]).toBe(255);
  });

  it('CONTROL_PANEL_FRAME: 20 blits from DAT_00007036, emblem 1785 twice (left/right)', () => {
    expect(CONTROL_PANEL_FRAME).toHaveLength(20);
    expect(CONTROL_PANEL_FRAME.filter((f) => f.entry === 1785)).toHaveLength(2);
    // emblem positions byte-exact: left x=144, right x=456, both y=440
    const emblems = CONTROL_PANEL_FRAME.filter((f) => f.entry === 1785);
    expect(emblems.map((e) => e.x).sort((a, b) => a - b)).toEqual([144, 456]);
    expect(emblems.every((e) => e.y === 440)).toBe(true);
    // all frame entries in the FrameBottom group (1779..1804)
    expect(CONTROL_PANEL_FRAME.every((f) => f.entry >= 1779 && f.entry <= 1804)).toBe(true);
  });

  it('POPUP_BOUNDS: click anchor from the machine code minus frame width, above the bar', () => {
    // The anchor `vp[0x78]/vp[0x7a]` (248/270) is the content corner; the drawing surface starts one
    // frame width (8,9) earlier. Both must match exactly, else either the image or the hit test moves.
    expect(POPUP_CLICK_ANCHOR.x - POPUP_BOUNDS.x).toBe(8);
    expect(POPUP_CLICK_ANCHOR.y - POPUP_BOUNDS.y).toBe(9);
    // the free interior of the frame is the 128x144 content area
    expect(POPUP_BOUNDS.width - 2 * 8).toBe(128);
    expect(POPUP_BOUNDS.height - 9 - 7).toBe(144);
    // lies inside the screen and above the control bar (original: 19 px gap)
    expect(POPUP_BOUNDS.x).toBeGreaterThanOrEqual(0);
    expect(POPUP_BOUNDS.x + POPUP_BOUNDS.width).toBeLessThanOrEqual(UI_SCREEN.width);
    expect(POPUP_BOUNDS.y + POPUP_BOUNDS.height).toBe(CONTROL_PANEL_BOUNDS.y - 19);
  });

  it('CONTROL_PANEL_BOUNDS encloses frame and buttons exactly (the overlay cut-out)', () => {
    const b = CONTROL_PANEL_BOUNDS;
    expect(b).toEqual({ x: 144, y: 440, width: 352, height: 40 });
    // no frame sprite starts left of or above the bounds ...
    expect(CONTROL_PANEL_FRAME.every((f) => f.x >= b.x && f.y >= b.y)).toBe(true);
    // ... and the right/bottom edge coincides with the last sprite: right emblem (40 px) at x=456
    // gives 496; bottom strip (4 px high) at y=476 gives 480.
    expect(b.x + b.width).toBe(456 + 40);
    expect(b.y + b.height).toBe(476 + 4);
    // the five 32x32 buttons lie entirely inside
    const lastButtonX = CONTROL_PANEL_START_X + (CONTROL_PANEL_BUTTON_COUNT - 1) * CONTROL_PANEL_STRIDE;
    expect(CONTROL_PANEL_START_X).toBeGreaterThanOrEqual(b.x);
    expect(lastButtonX + 32).toBeLessThanOrEqual(b.x + b.width);
    expect(CONTROL_PANEL_Y).toBeGreaterThanOrEqual(b.y);
    expect(CONTROL_PANEL_Y + 32).toBeLessThanOrEqual(b.y + b.height);
  });

  it('drawControlPanelFrame blits every frame sprite top-left at (x+ox, y+oy)', () => {
    const asked: number[] = [];
    const provider: SpriteProvider = (e) => {
      asked.push(e);
      return solidSprite(8, 8);
    };
    const fb = createFramebuffer(640, 480);
    drawControlPanelFrame(fb, provider);
    expect(asked).toHaveLength(20);
    // left emblem (entry 1785) at (144, 440) is set
    expect(px(fb, 144, 440)[3]).toBe(255);
    expect(px(fb, 143, 440)[3]).toBe(0);
  });
});

describe('control bar - click navigation (byte-exact from FUN_000272d7)', () => {
  it('hitTestControlPanelButton: button centres hit index 0..4', () => {
    // centres = start x + i*48 + 16, middle y of the button row
    const cy = 444 + 16;
    for (let i = 0; i < 5; i++) {
      expect(hitTestControlPanelButton(208 + i * 48 + 16, cy)).toBe(i);
    }
  });

  it('hitTestControlPanelButton: gap between buttons and outside give null', () => {
    const cy = 444 + 16;
    // gap between button 0 (up to 240) and button 1 (from 256): x=248
    expect(hitTestControlPanelButton(248, cy)).toBeNull();
    // left of the first button
    expect(hitTestControlPanelButton(200, cy)).toBeNull();
    // right of the fifth button (208+5*48 = 448)
    expect(hitTestControlPanelButton(450, cy)).toBeNull();
    // y outside the band [444,475]
    expect(hitTestControlPanelButton(224, 440)).toBeNull();
    expect(hitTestControlPanelButton(224, 480)).toBeNull();
  });

  it('hitTestControlPanelButton respects the (ox,oy) preview offset', () => {
    // preview offset oy=-428: button 0 at y 444-428=16
    expect(hitTestControlPanelButton(208 + 16, 16, 0, -428)).toBe(0);
  });

  it('clickControlPanel: default row {0,7,10,12,14} switches screen and rewrites icons', () => {
    const def = [0, 7, 10, 12, 14];
    const cy = 444 + 16;
    // button 2 (icon 0x0a=10) opens screen 1
    const a2 = clickControlPanel(def, 208 + 2 * 48 + 16, cy);
    expect(a2?.screen).toBe(1);
    expect(a2?.newIcons).toEqual([0, 7, 0x13, 0xb, 0xd]);
    // button 3 (icon 0x0c=12) opens screen 8
    expect(clickControlPanel(def, 208 + 3 * 48 + 16, cy)?.screen).toBe(8);
    // button 4 (icon 0x0e=14) opens screen 0x24
    expect(clickControlPanel(def, 208 + 4 * 48 + 16, cy)?.screen).toBe(0x24);
    // buttons 0/1 (icons 0/7 are passive) do nothing
    expect(clickControlPanel(def, 208 + 16, cy)).toBeNull();
    expect(clickControlPanel(def, 208 + 48 + 16, cy)).toBeNull();
  });

  it('CONTROL_PANEL_BUTTON_ACTIONS: mine icon 0x02 opens screen 3 (mine panel)', () => {
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x02)?.screen).toBe(3);
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x17)?.screen).toBe(3); // active variant
  });

  it('CONTROL_PANEL_BUTTON_ACTIONS: the three direct actions without a popup', () => {
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x01)?.command).toBe('buildFlag');
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x05)?.command).toBe('foundCastle');
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x0f)?.command).toBe('demolishRoad');
    // none of these three opens a popup
    for (const icon of [0x01, 0x05, 0x0f]) {
      expect(CONTROL_PANEL_BUTTON_ACTIONS.get(icon)?.screen).toBeUndefined();
    }
  });

  it('CONTROL_PANEL_BUTTON_ACTIONS: icon 0x06 is the only two-way entry', () => {
    // `FUN_00048c8a` for cursor type 2, else screen 0x37 - and the original writes the icon row
    // `{0,7,9,0xb,0xd}` only on the popup branch (@0x2937c ff.).
    const a = CONTROL_PANEL_BUTTON_ACTIONS.get(0x06);
    expect(a?.command).toBe('demolishAtCursor');
    expect(a?.screen).toBe(0x37);
    expect(a?.newIcons).toEqual([0, 7, 9, 0xb, 0xd]);
    // no other entry carries both
    const twoWay = [...CONTROL_PANEL_BUTTON_ACTIONS].filter(
      ([, v]) => v.command !== undefined && v.screen !== undefined,
    );
    expect(twoWay.map(([k]) => k)).toEqual([0x06]);
  });
});

// --- context icons (FUN_000331a7) ------------------------------------------------------------

describe('click kind: special click vs. plain click (vp[1] bit 3)', () => {
  const cy = 444 + 16;
  const at = (slot: number): number => 208 + slot * 48 + 16;

  it('demolish icons only run on a special click (if (!bit3) return)', () => {
    for (const icon of [0x06, 0x0f]) {
      expect(CONTROL_PANEL_BUTTON_ACTIONS.get(icon)?.click).toBe('special');
      const icons = [icon, 7, 10, 12, 14];
      expect(clickControlPanel(icons, at(0), cy, 0, 0, false)).toBeNull();
      expect(clickControlPanel(icons, at(0), cy, 0, 0, true)).not.toBeNull();
    }
  });

  it('all other action icons only run on a plain click (if (!bit3) { ... })', () => {
    for (const icon of [0x0a, 0x0c, 0x0e, 0x02, 0x03, 0x04, 0x08, 0x01, 0x05]) {
      expect(CONTROL_PANEL_BUTTON_ACTIONS.get(icon)?.click).toBe('normal');
      const icons = [icon, 7, 10, 12, 14];
      expect(clickControlPanel(icons, at(0), cy, 0, 0, false)).not.toBeNull();
      expect(clickControlPanel(icons, at(0), cy, 0, 0, true)).toBeNull();
    }
  });

  it('soil analysis is the only branch without a bit 3 test, so both click kinds work', () => {
    for (const icon of [0x10, 0x16]) {
      expect(CONTROL_PANEL_BUTTON_ACTIONS.get(icon)?.click).toBe('any');
      const icons = [0, icon, 10, 12, 14];
      expect(clickControlPanel(icons, at(1), cy, 0, 0, false)?.screen).toBe(0x16);
      expect(clickControlPanel(icons, at(1), cy, 0, 0, true)?.screen).toBe(0x16);
    }
  });

  it('the default is the plain click (callers that know no click kind)', () => {
    expect(clickControlPanel([0x0a, 7, 10, 12, 14], at(0), cy)).not.toBeNull();
    expect(clickControlPanel([0x06, 7, 10, 12, 14], at(0), cy)).toBeNull();
  });

  it('only the map icons document their own special-click path', () => {
    const withNote = [...CONTROL_PANEL_BUTTON_ACTIONS.entries()]
      .filter(([, a]) => a.specialNote !== undefined)
      .map(([icon]) => icon);
    expect(withNote.sort((a, b) => a - b)).toEqual([0x0a, 0x13]);
  });
});

describe('mapSpecialClickScreen (map special click, FUN_000272d7 @0x29d84)', () => {
  const done = (type: number) => ({ type, constructing: false });

  it('own flag gives 0x2a, a foreign one gives nothing', () => {
    expect(mapSpecialClickScreen(1, null, true)).toBe(0x2a);
    expect(mapSpecialClickScreen(1, null, false)).toBeNull();
  });

  it('a building under construction gives 0x28 (site), regardless of type', () => {
    expect(mapSpecialClickScreen(2, { type: 11, constructing: true }, true)).toBe(0x28);
    expect(mapSpecialClickScreen(3, { type: 17, constructing: true }, true)).toBe(0x28);
  });

  it('type encoding type<<2: castle/warehouse 0x26, military 0x29, mines 0x27, rest 0x34', () => {
    expect(mapSpecialClickScreen(4, done(24), true)).toBe(0x26); // 24<<2 = 0x60
    expect(mapSpecialClickScreen(3, done(10), true)).toBe(0x26); // 10<<2 = 0x28
    expect(mapSpecialClickScreen(2, done(11), true)).toBe(0x29); // hut  0x2c
    expect(mapSpecialClickScreen(3, done(21), true)).toBe(0x29); // tower 0x54
    expect(mapSpecialClickScreen(3, done(22), true)).toBe(0x29); // fortress 0x58
    for (const t of [5, 6, 7, 8]) expect(mapSpecialClickScreen(2, done(t), true)).toBe(0x27);
    expect(mapSpecialClickScreen(2, done(2), true)).toBe(0x34); // lumberjack
    expect(mapSpecialClickScreen(3, done(17), true)).toBe(0x34); // sawmill
  });

  it('a foreign attack target gives screen 0x14 (the castle too), anything else gives nothing', () => {
    // the type chain of the attack branch @0x2a43d: 0x2c, 0x54, 0x58 and 0x60
    expect(mapSpecialClickScreen(2, done(11), false)).toBe(0x14); // hut
    expect(mapSpecialClickScreen(3, done(21), false)).toBe(0x14); // tower
    expect(mapSpecialClickScreen(3, done(22), false)).toBe(0x14); // fortress
    expect(mapSpecialClickScreen(4, done(24), false)).toBe(0x14); // castle - can be attacked
    expect(mapSpecialClickScreen(3, done(17), false)).toBeNull(); // sawmill - cannot
    expect(mapSpecialClickScreen(3, done(10), false)).toBeNull(); // warehouse - cannot
    // A foreign construction site neither: the comparison masks with 0xfc, the construction bit
    // stays and 0x2c|0x80 matches none of the four values.
    expect(mapSpecialClickScreen(2, { type: 11, constructing: true }, false)).toBeNull();
  });

  it('a warehouse needs `bld+5` bit 4 (active), the castle does not', () => {
    // @0x2a1b9: a finished warehouse that has not been put into service has no window.
    expect(mapSpecialClickScreen(3, { type: 10, constructing: false, active: false }, true)).toBeNull();
    expect(mapSpecialClickScreen(3, { type: 10, constructing: false, active: true }, true)).toBe(0x26);
    expect(mapSpecialClickScreen(4, { type: 24, constructing: false, active: false }, true)).toBe(0x26);
  });

  it('tiles without a flag or building give nothing', () => {
    for (const obj of [0, 5, 72, 127]) expect(mapSpecialClickScreen(obj, null, true)).toBeNull();
  });
});

describe('controlPanelIconsAfterClose (FUN_0002860b @0x2860b)', () => {
  it('resets slots 2..4 to the init values and leaves 0/1 alone', () => {
    // As in the original: the open path writes all five, closing writes only
    // vp[0x62..0x64] = {10, 0xc, 0xe}; slots 0/1 come from the dirty-bit path afterwards.
    expect(controlPanelIconsAfterClose([0x11, 7, 9, 0xb, 0xd])).toEqual([0x11, 7, 10, 0xc, 0xe]);
  });

  it('turns the pressed variants back into the plain ones', () => {
    // On opening the click table writes 0x13/0x14/0x15 into slots 2/3/4 (active tab); the close
    // path writes 0x0a/0x0c/0x0e - the same icons unpressed. That is the visible button release.
    expect(controlPanelIconsAfterClose([0, 7, 0x13, 0xb, 0xd])).toEqual([0, 7, 0x0a, 0x0c, 0x0e]);
    expect(controlPanelIconsAfterClose([0, 7, 9, 0x14, 0xd])).toEqual([0, 7, 0x0a, 0x0c, 0x0e]);
    expect(controlPanelIconsAfterClose([0, 7, 9, 0xb, 0x15])).toEqual([0, 7, 0x0a, 0x0c, 0x0e]);
    // counter-check that the pairs really belong together (table from FUN_000272d7)
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x13)?.screen).toBe(
      CONTROL_PANEL_BUTTON_ACTIONS.get(0x0a)?.screen,
    );
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x14)?.screen).toBe(
      CONTROL_PANEL_BUTTON_ACTIONS.get(0x0c)?.screen,
    );
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x15)?.screen).toBe(
      CONTROL_PANEL_BUTTON_ACTIONS.get(0x0e)?.screen,
    );
  });

  it('the written-back values are the last three default icons', () => {
    // evidence that the three constants of the close path match the panel init
    expect(CONTROL_PANEL_DEFAULT_ICONS.slice(2)).toEqual([10, 0xc, 0xe]);
    expect(controlPanelIconsAfterClose(CONTROL_PANEL_DEFAULT_ICONS)).toEqual([
      ...CONTROL_PANEL_DEFAULT_ICONS,
    ]);
  });
});

describe('contextBarState (FUN_000331a7)', () => {
  const base = { cursorType: 0, possibility: 0, playerFlags: 1, roadBuilding: false, specialMode: false };
  const at = (cursorType: number, possibility: number, patch = {}) =>
    contextBarState({ ...base, cursorType, possibility, ...patch });

  it('slot 0 is the build possibility', () => {
    // Free tile (type 7): possibility 1..5 lands unchanged as the icon of slot 0. That is why the
    // click actions 0x01 (flag), 0x02..0x04 (mine/small/large) and 0x05 (castle) apply.
    for (const p of [1, 2, 3, 4, 5]) expect(at(7, p).icons[0]).toBe(p);
    for (const p of [2, 3, 4]) expect(at(5, p).icons[0]).toBe(p);
    expect(at(3, 4).icons[0]).toBe(4);
  });

  it('the click table covers every slot 0 icon produced this way', () => {
    // Sharpest cross-check: producer (FUN_000331a7) and consumer (FUN_000273d6) must match.
    // Icon 0 is the passive value (no entry).
    const produced = new Set<number>();
    for (let t = 0; t <= 7; t++) {
      for (let p = 0; p <= 5; p++) {
        produced.add(at(t, p).icons[0]);
        produced.add(at(t, p, { playerFlags: 0 }).icons[1]);
      }
    }
    // 0 and 7 are the two passive values (emblem/filler) - deliberately without an action
    produced.delete(0);
    produced.delete(7);
    expect(produced.size).toBeGreaterThan(7); // enough real icons must remain for this to mean anything
    for (const icon of produced) {
      expect(CONTROL_PANEL_BUTTON_ACTIONS.has(icon), `icon 0x${icon.toString(16)} without action`).toBe(true);
    }
  });

  it('type 5 below possibility 2 falls into the nothing-possible branch (jump into the type 0 block)', () => {
    expect(at(5, 1)).toEqual(at(0, 0));
    expect(at(5, 0)).toEqual(at(0, 0));
    expect(at(5, 2).icons).toEqual([2, 7]);
  });

  it('marker symbols: possibility + 0x2e gives flag/mine/house/castle', () => {
    expect(at(7, 1).markers?.primary).toBe(CURSOR_MARKER_FLAG); // 0x2f
    expect(at(7, 2).markers?.primary).toBe(0x30);
    expect(at(7, 3).markers?.primary).toBe(0x31);
    expect(at(7, 4).markers?.primary).toBe(0x32);
  });

  it('type 7 clamps the castle to the castle marker, else it would show the road symbol', () => {
    // possibility 5 + 0x2e = 0x33 = the road symbol; the -1 in the machine code prevents exactly that
    expect(at(7, 5).markers?.primary).toBe(0x32);
    expect(CURSOR_MARKER_ROAD_NEW).toBe(0x33);
    // type 6 does not have the clamp
    expect(at(6, 5).markers?.primary).toBe(0x33);
  });

  it('the second marker is the flag of the building, unless the flag is already the first', () => {
    expect(at(7, 3).markers?.secondary).toBe(CURSOR_MARKER_FLAG);
    expect(at(7, 1).markers?.secondary).toBe(CURSOR_MARKER_NONE);
    expect(at(6, 1).markers?.secondary).toBe(CURSOR_MARKER_NONE);
    // types 3 (building) and 5 set it unconditionally to none
    expect(at(3, 4).markers?.secondary).toBe(CURSOR_MARKER_NONE);
    expect(at(5, 4).markers?.secondary).toBe(CURSOR_MARKER_NONE);
  });

  it('flag under the cursor: road symbol, slot 1 only demolishes a removable flag', () => {
    expect(at(1, 0)).toEqual({ icons: [8, 7], markers: { primary: 0x33, secondary: 0x21 } });
    expect(at(2, 0)).toEqual({ icons: [8, 6], markers: { primary: 0x33, secondary: 0x21 } });
  });

  it('road under the cursor: slot 1 demolishes the road; with a possibility it also places a flag', () => {
    expect(at(4, 0)).toEqual({ icons: [0, 0xf], markers: { primary: 0x34, secondary: 0x21 } });
    expect(at(4, 3)).toEqual({ icons: [1, 0xf], markers: { primary: 0x2f, secondary: 0x21 } });
  });

  it('player.flags bit 0 switches slot 1 between passive (7) and soil analysis (0x10)', () => {
    expect(at(0, 0, { playerFlags: 1 }).icons[1]).toBe(7);
    expect(at(0, 0, { playerFlags: 0 }).icons[1]).toBe(0x10);
    expect(at(7, 3, { playerFlags: 0 }).icons[1]).toBe(0x10);
    // type 6 does not depend on that bit
    expect(at(6, 3, { playerFlags: 0 }).icons[1]).toBe(7);
  });

  it('the two early exits leave the markers untouched', () => {
    expect(contextBarState({ ...base, specialMode: true })).toEqual({ icons: [0, 7], markers: null });
    expect(contextBarState({ ...base, roadBuilding: true })).toEqual({ icons: [0x18, 0], markers: null });
    // the special mode takes precedence over road building (order of the tests in the original)
    expect(contextBarState({ ...base, specialMode: true, roadBuilding: true }).icons).toEqual([0, 7]);
  });

  it('in spectator mode no action is reachable, for any cursor type', () => {
    // The original locks nothing out, it leaves the control away. So this checks not the icon
    // number but that the two symbols of the bar do not occur in the action table at all.
    for (const cursorType of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const possibility of [0, 1, 2, 3, 4, 5]) {
        const { icons } = contextBarState({ ...base, cursorType, possibility, specialMode: true });
        expect(icons).toEqual([0, 7]);
        for (const icon of icons) expect(CONTROL_PANEL_BUTTON_ACTIONS.has(icon)).toBe(false);
      }
    }
    // Counter-check: without the bit the castle icon with its action stands right there. Without
    // this line the loop above would be green even if `contextBarState` never returned anything else.
    const open = contextBarState({ ...base, cursorType: 7, possibility: 5, specialMode: false });
    expect(open.icons[0]).toBe(0x05);
    expect(CONTROL_PANEL_BUTTON_ACTIONS.get(0x05)?.command).toBe('foundCastle');
  });

  it('during road building no demolish icon is reachable, for any cursor type', () => {
    // The early exit overwrites both left slots, including the two destructive icons (0x0f demolish
    // road for type 4, 0x06 demolish for types 2/3). That is original behaviour and explains why an
    // accidentally started road build looks like demolishing has stopped working.
    for (const cursorType of [1, 2, 3, 4, 5, 6, 7]) {
      const icons = contextBarState({ ...base, cursorType, possibility: 1, roadBuilding: true }).icons;
      expect(icons).toEqual([0x18, 0]);
      expect(icons).not.toContain(0x0f);
      expect(icons).not.toContain(0x06);
    }
    // without road building they are where they belong - otherwise the loop above tests nothing
    expect(contextBarState({ ...base, cursorType: 4, possibility: 0 }).icons[1]).toBe(0x0f);
    expect(contextBarState({ ...base, cursorType: 2, possibility: 0 }).icons[1]).toBe(0x06);
  });

  it('marker bank: the original adds 0x140, our entry is one lower', () => {
    expect(CURSOR_MARKER_BASE + CURSOR_MARKER_FLAG).toBe(366); // checked at the pixel: flag
    expect(CURSOR_MARKER_BASE + CURSOR_MARKER_NONE).toBe(352); // dot
  });
});

describe('hitTest (click to action)', () => {
  const rects = [
    { action: 5, x0: 16, x1: 48, y0: 8, y1: 72 },
    { action: 9, x0: 10, x1: 26, y0: 114, y1: 134 },
  ];

  it('returns the action of the first matching rectangle (bounds inclusive)', () => {
    expect(hitTest(rects, 16, 8)).toBe(5); // top left corner inclusive
    expect(hitTest(rects, 48, 72)).toBe(5); // bottom right corner inclusive
    expect(hitTest(rects, 32, 40)).toBe(5); // centre
    expect(hitTest(rects, 18, 120)).toBe(9); // second rectangle
  });

  it('returns null outside all rectangles', () => {
    expect(hitTest(rects, 0, 0)).toBeNull();
    expect(hitTest(rects, 15, 40)).toBeNull(); // just left of x0=16
    expect(hitTest(rects, 49, 40)).toBeNull(); // just right of x1=48
  });
});

describe('MINE_PANEL_HITBOXES (box 3 click zones, byte-verified)', () => {
  it('5 rectangles: actions 5-9 with the decoded coordinates', () => {
    expect(MINE_PANEL_HITBOXES.map((r) => r.action)).toEqual([5, 6, 7, 8, 9]);
    expect(MINE_PANEL_HITBOXES[0]).toEqual({ action: 5, x0: 16, x1: 48, y0: 8, y1: 72 });
    expect(MINE_PANEL_HITBOXES[4]).toEqual({ action: 9, x0: 10, x1: 26, y0: 114, y1: 134 });
  });

  it('a click on each of the 4 mine zones hits the matching build choice (action == building type)', () => {
    // centres of the four mine icons give actions 5..8 (stone/coal/iron/gold)
    expect(hitTest(MINE_PANEL_HITBOXES, 32, 40)).toBe(5);
    expect(hitTest(MINE_PANEL_HITBOXES, 80, 40)).toBe(6);
    expect(hitTest(MINE_PANEL_HITBOXES, 48, 109)).toBe(7);
    expect(hitTest(MINE_PANEL_HITBOXES, 96, 109)).toBe(8);
    expect(MINE_PANEL_ACTIONS[5]).toBe('stone mine');
    expect(MINE_PANEL_ACTIONS[8]).toBe('gold mine');
    expect(MINE_PANEL_ACTIONS[9]).toBe('build flag');
  });
});

describe('hitTestPanel (drawing pixels to action, with the (8,9) offset)', () => {
  it('converts drawing pixels into the rectangle space (minus origin)', () => {
    expect(PANEL_CLICK_ORIGIN_X).toBe(8);
    expect(PANEL_CLICK_ORIGIN_Y).toBe(9);
    // The top left mine is drawn at drawing pixels ~ (16..56, 17..81); its centre ~ (40, 49) must
    // hit action 5 (rectangle space 32,40 == drawing 40,49).
    expect(hitTestPanel(MINE_PANEL_HITBOXES, 32 + 8, 40 + 9)).toBe(5);
    expect(hitTestPanel(MINE_PANEL_HITBOXES, 96 + 8, 109 + 9)).toBe(8);
  });

  it('is consistent with hitTest once the origin is subtracted', () => {
    for (const p of [[24, 17], [72, 81], [48, 95]] as const) {
      expect(hitTestPanel(MINE_PANEL_HITBOXES, p[0], p[1])).toBe(
        hitTest(MINE_PANEL_HITBOXES, p[0] - 8, p[1] - 9),
      );
    }
  });
});

describe('highlightHitRect', () => {
  it('outlines the rectangle shifted by the origin offset (drawing pixels)', () => {
    const fb = createFramebuffer(160, 176);
    highlightHitRect(fb, { action: 5, x0: 16, x1: 48, y0: 8, y1: 72 }, [255, 255, 0]);
    // corner at (16+8, 8+9) = (24, 17) is set
    expect(px(fb, 24, 17)).toEqual([255, 255, 0, 255]);
    expect(px(fb, 48 + 8, 72 + 9)).toEqual([255, 255, 0, 255]);
    // not set at the unshifted byte corner (16,8)
    expect(px(fb, 16, 8)).toEqual([0, 0, 0, 0]);
  });
});

describe('strokeRect', () => {
  it('draws only the outline (corners set, interior empty)', () => {
    const fb = createFramebuffer(6, 6);
    strokeRect(fb, 1, 1, 4, 4, [255, 0, 0]);
    expect(px(fb, 1, 1)).toEqual([255, 0, 0, 255]); // corner
    expect(px(fb, 4, 4)).toEqual([255, 0, 0, 255]); // corner
    expect(px(fb, 2, 1)).toEqual([255, 0, 0, 255]); // top edge
    expect(px(fb, 2, 2)).toEqual([0, 0, 0, 0]); // interior untouched
  });
});

describe('screen chrome of the 352 set', () => {
  it('covers exactly the area outside the menu area', () => {
    // the arithmetic is the actual test: 2*16*200 + 320*8 + 352*40 == 352*240 - 320*192
    const border = 2 * 16 * 200 + 320 * 8;
    const bar = 352 * 40;
    expect(border + bar).toBe(352 * 240 - 320 * 192);
    expect(border + bar).toBe(23040);
  });

  it('carries the three border sprites at the original positions', () => {
    expect(SCREEN_BORDER_SMALL).toEqual([
      { entry: 599, x: 0, y: 0 }, // left, 16x200
      { entry: 600, x: 336, y: 0 }, // right, 16x200
      { entry: 601, x: 16, y: 0 }, // top, 320x8
    ]);
    // the separator is conditional (`gs+0x37e` bit 2) and therefore not in the list
    expect(SCREEN_BORDER_SMALL_SPLIT).toEqual({ entry: 602, x: 160, y: 8 });
  });

  it('draws the three border sprites, the bar frame and the five buttons', () => {
    const seen: { entry: number; x: number; y: number }[] = [];
    const provider: SpriteProvider = (entry) => {
      seen.push({ entry, x: 0, y: 0 });
      return null; // drawing itself is not the point here, only what is requested
    };
    const fb = createFramebuffer(352, 240);
    drawScreenChromeSmall(fb, provider);
    const entries = seen.map((s) => s.entry);
    // border first, in the original's order (left, right, top)
    expect(entries.slice(0, 3)).toEqual([599, 600, 601]);
    // the split screen separator is absent unless requested
    expect(entries).not.toContain(602);
    // then the bar frame, then the five buttons from the PanelButton bank
    expect(entries).toContain(1785);
    expect(entries.slice(-5)).toEqual(
      CONTROL_PANEL_DEFAULT_ICONS.map((i) => UI_PANELBUTTON_BASE + i),
    );
  });

  it('adds the split screen separator only on request', () => {
    const entries: number[] = [];
    const fb = createFramebuffer(352, 240);
    drawScreenChromeSmall(fb, (e) => (entries.push(e), null), { splitScreen: true });
    expect(entries).toContain(602);
  });

  it('puts the buttons on the columns of the bar table', () => {
    // The five top strips of the table stand at 64/112/160/208/256 - the button origin must sit on
    // the first column, 4 px below the bar edge.
    const tops = CONTROL_PANEL_FRAME_SMALL.filter(
      (f) => f.y === 200 && f.entry >= 1786 && f.entry <= 1794 && f.entry % 2 === 0,
    ).map((f) => f.x);
    expect(tops).toEqual([64, 112, 160, 208, 256]);
    expect(CONTROL_PANEL_SMALL_ORIGIN.x).toBe(tops[0]);
    expect(CONTROL_PANEL_SMALL_ORIGIN.y).toBe(204);
    expect(tops[1]! - tops[0]!).toBe(CONTROL_PANEL_STRIDE);
  });

  it('is entry for entry the 640 table, shifted by (144, 240)', () => {
    expect(CONTROL_PANEL_FRAME_SMALL).toHaveLength(CONTROL_PANEL_FRAME.length);
    CONTROL_PANEL_FRAME_SMALL.forEach((f, i) => {
      const big = CONTROL_PANEL_FRAME[i]!;
      expect({ entry: f.entry, x: f.x + 144, y: f.y + 240 }).toEqual({
        entry: big.entry,
        x: big.x,
        y: big.y,
      });
    });
  });
});

describe('player switch in the frame head (spectator mode)', () => {
  it('four 8 px buttons, sprite pairs 4 apart (`addw $0x4`)', () => {
    expect(POPUP_PLAYER_BUTTONS.map((b) => b.x)).toEqual([0x10, 0x28, 0x60, 0x78]);
    expect(POPUP_PLAYER_BUTTONS.every((b) => b.y === 1)).toBe(true);
    expect(POPUP_PLAYER_BUTTONS.map((b) => b.entry)).toEqual([669, 670, 671, 672]);
    POPUP_PLAYER_BUTTONS.forEach((b) => expect(b.entryCurrent - b.entry).toBe(4));
  });

  it('the zones sit exactly under the sprites, offset by one frame width', () => {
    // The hit test works from the content anchor, the blit from the frame area; the difference must
    // be the established (8, 9) offset, else button and zone point at different places.
    const dx = POPUP_CLICK_ANCHOR.x - POPUP_BOUNDS.x;
    POPUP_PLAYER_BUTTONS.forEach((b) => {
      expect(hitPopupPlayerButton(b.x - dx, -1)).toBe(b.slot);
      expect(hitPopupPlayerButton(b.x - dx + 7, -8)).toBe(b.slot);
    });
  });

  it('the gaps between the buttons and everything outside the strip do nothing', () => {
    for (const x of [0, 7, 16, 31, 40, 87, 96, 111, 120, 127]) {
      expect(hitPopupPlayerButton(x, -1)).toBeNull();
    }
    expect(hitPopupPlayerButton(8, 0)).toBeNull(); // y == 0 is already the content
    expect(hitPopupPlayerButton(8, -9)).toBeNull(); // `addw $0x8 ; js` - one row too high
    expect(hitPopupPlayerButton(-1, -1)).toBeNull();
    expect(hitPopupPlayerButton(0x80, -1)).toBeNull();
  });

  it('draws only active slots and highlights the window\'s own', () => {
    const drawn: number[] = [];
    const provider = (entry: number): DecodedSprite | null => {
      drawn.push(entry);
      return null; // the blit itself is not what is under test here
    };
    const fb = createFramebuffer(144, 160);
    drawPopupPlayerButtons(fb, provider, {
      active: [true, false, true, true],
      current: 2,
    });
    expect(drawn).toEqual([669, 671 + 4, 672]);
  });
});
