import { describe, expect, it } from 'vitest';
import {
  OPTIONS_EXIT_ICON,
  OPTIONS_FRAME_ICONS,
  OPTIONS_LABELS_BOTTOM,
  OPTIONS_LABELS_TOP,
  OPTIONS_MESSAGE_POS,
  OPTIONS_MESSAGE_SLOT_LEFT,
  OPTIONS_MESSAGE_SLOT_RIGHT,
  OPTIONS_MESSAGE_TEMPLATE,
  OPTIONS_MUSIC_CHECK_POS,
  OPTIONS_POPUP_HITBOXES,
  OPTIONS_SCREENS,
  OPTIONS_SFX_CHECK_POS,
  OPTIONS_SFX_LABEL_BOX,
  drawMenuPopup,
  OPTIONS_VOLUME_MINUS,
  OPTIONS_VOLUME_PLUS,
  OPTION_CHECKBOXES,
  QUIT_POPUP_HITBOXES,
  QUIT_POPUP_LABELS,
  clickMenuPopup,
  clickOptionsPopup,
  optionsMessageLine,
  optionsPopupAction,
  optionsPopupHitboxes,
} from './options-popup.js';
import {
  VIEW_OPTION_FAST_BUILD_CLICK,
  VIEW_OPTION_FAST_MAP_CLICK,
  VIEW_OPTION_ROAD_SCROLL,
} from './engine/view-options.js';
import {
  PANEL_CLICK_ORIGIN_X,
  PANEL_CLICK_ORIGIN_Y,
  POPUP_BOUNDS_SMALL,
  createFramebuffer,
  panelX,
  panelY,
  type SpriteProvider,
} from './ui-render.js';
import type { DecodedSprite } from './types.js';

/** Text colour as in the original (palette index 0x1f of the game palette). */
const TEXT = [115, 179, 67] as const;

describe('screen 0x25 — layout against the click table', () => {
  it('covers every clickable element with a zone at its top-left corner', () => {
    // The evidence in the original is a bijection: `zone.x0 == col*8`, `zone.y0 == row`.
    const spots = [
      { name: 'RAUS', col: OPTIONS_EXIT_ICON.col, row: OPTIONS_EXIT_ICON.row, action: 0xb0 },
      ...OPTION_CHECKBOXES.map((c) => ({ name: `checkbox ${c.mask}/${c.side}`, ...c })),
      { name: 'Musik', ...OPTIONS_MUSIC_CHECK_POS, action: 0xfa },
      { name: 'SFX (SVGA in the original)', ...OPTIONS_SFX_CHECK_POS, action: 0xfb },
      { name: 'volume -', col: OPTIONS_VOLUME_MINUS.col, row: OPTIONS_VOLUME_MINUS.row, action: 0xfc },
      { name: 'volume +', col: OPTIONS_VOLUME_PLUS.col, row: OPTIONS_VOLUME_PLUS.row, action: 0xfd },
    ];
    for (const s of spots) {
      const zone = OPTIONS_POPUP_HITBOXES.find((z) => z.action === s.action);
      expect(zone, s.name).toBeDefined();
      expect(zone!.x0, `${s.name} x`).toBe(s.col * 8);
      expect(zone!.y0, `${s.name} y`).toBe(s.row);
    }
  });

  it('puts the two message zones on the two replaced characters of the line', () => {
    const left = OPTIONS_POPUP_HITBOXES.find((z) => z.action === 0xb7)!;
    const right = OPTIONS_POPUP_HITBOXES.find((z) => z.action === 0xb8)!;
    expect(left.x0).toBe((OPTIONS_MESSAGE_POS.col + OPTIONS_MESSAGE_SLOT_LEFT) * 8);
    expect(right.x0).toBe((OPTIONS_MESSAGE_POS.col + OPTIONS_MESSAGE_SLOT_RIGHT) * 8);
    expect(left.y0).toBe(OPTIONS_MESSAGE_POS.row);
    expect(right.y0).toBe(OPTIONS_MESSAGE_POS.row);
  });

  it('has 14 zones, all action ids distinct', () => {
    expect(OPTIONS_POPUP_HITBOXES).toHaveLength(14);
    expect(new Set(OPTIONS_POPUP_HITBOXES.map((z) => z.action)).size).toBe(14);
  });

  it('leaves the middle free for the exit button between the frame fillers', () => {
    expect(OPTIONS_FRAME_ICONS).toHaveLength(12);
    const cols = [...new Set(OPTIONS_FRAME_ICONS.map((i) => i.col))].sort((a, b) => a - b);
    expect(cols).toEqual([0, 2, 4, 10, 12, 14]);
    expect(OPTIONS_EXIT_ICON.col).toBe(7);
  });

  it('lists the six checkboxes column by column: left bits 0/1/2, then right', () => {
    expect(OPTION_CHECKBOXES.map((c) => c.side)).toEqual([0, 0, 0, 1, 1, 1]);
    const masks = [VIEW_OPTION_ROAD_SCROLL, VIEW_OPTION_FAST_MAP_CLICK, VIEW_OPTION_FAST_BUILD_CLICK];
    expect(OPTION_CHECKBOXES.slice(0, 3).map((c) => c.mask)).toEqual(masks);
    expect(OPTION_CHECKBOXES.slice(3).map((c) => c.mask)).toEqual(masks);
    // Rows equal in pairs, columns 0 (left) and 14 (right).
    for (let i = 0; i < 3; i++) {
      expect(OPTION_CHECKBOXES[i]!.row).toBe(OPTION_CHECKBOXES[i + 3]!.row);
      expect(OPTION_CHECKBOXES[i]!.col).toBe(0);
      expect(OPTION_CHECKBOXES[i + 3]!.col).toBe(0xe);
    }
  });
});

describe('message row', () => {
  it('inserts the two levels into the 16-character template', () => {
    expect(OPTIONS_MESSAGE_TEMPLATE).toHaveLength(16);
    expect(optionsMessageLine([0x39, 0x39])).toBe('3 MITTEILUNGEN 3');
    expect(optionsMessageLine([0x25, 0x39])).toBe('1 MITTEILUNGEN 3');
    expect(optionsMessageLine([0x00, 0x20])).toBe('0 MITTEILUNGEN 1');
  });

  it('leaves the template untouched (the original patches its data string)', () => {
    optionsMessageLine([0x39, 0x39]);
    expect(OPTIONS_MESSAGE_TEMPLATE).toBe('  MITTEILUNGEN  ');
  });
});

describe('action resolution', () => {
  it('maps every zone id to an effect', () => {
    for (const z of [...OPTIONS_POPUP_HITBOXES, ...QUIT_POPUP_HITBOXES]) {
      expect(optionsPopupAction(z.action), `action 0x${z.action.toString(16)}`).not.toBeNull();
    }
  });

  it('hits the right effect from drawing pixels', () => {
    const at = (screen: number, col: number, row: number) =>
      clickOptionsPopup(screen, col * 8 + PANEL_CLICK_ORIGIN_X, row + PANEL_CLICK_ORIGIN_Y);
    expect(at(0x25, OPTION_CHECKBOXES[1]!.col, OPTION_CHECKBOXES[1]!.row)).toEqual({
      kind: 'toggle',
      side: 0,
      mask: VIEW_OPTION_FAST_MAP_CLICK,
      label: 'left side',
    });
    expect(at(0x25, OPTIONS_VOLUME_PLUS.col, OPTIONS_VOLUME_PLUS.row)).toEqual({
      kind: 'volume',
      delta: 1,
    });
    expect(at(0x25, OPTIONS_VOLUME_MINUS.col, OPTIONS_VOLUME_MINUS.row)).toEqual({
      kind: 'volume',
      delta: -1,
    });
    expect(at(0x25, 7, 0)).toEqual({ kind: 'close' });
    // Yes / no on text row 0x2d of screen 0x22.
    expect(at(0x22, 1, 0x2d)).toEqual({ kind: 'quitConfirm' });
    expect(at(0x22, 11, 0x2d)).toEqual({ kind: 'quitCancel' });
  });

  it('returns null outside every zone and for foreign screens', () => {
    expect(clickOptionsPopup(0x25, 60, 100)).toBeNull(); // middle, no zone
    expect(clickOptionsPopup(0x24, 8, 9)).toBeNull();
    expect(optionsPopupHitboxes(0x24)).toEqual([]);
  });

  it('reports the right checkbox as the SFX switch and leads to device screen 0x3c', () => {
    // The body of `FUN_0003b3e6` shows JOYSTICK / MAUS MODUS / COM-PORT / IRQ.
    expect(optionsPopupAction(0xfb)).toEqual({ kind: 'sfx' });
    expect(optionsPopupAction(0xf5)).toEqual({
      kind: 'screen',
      screen: 0x3c,
      label: 'input device',
    });
  });
});

describe('screen 0x22 — QUIT', () => {
  it('has four text lines and two zones on the answer row', () => {
    expect(QUIT_POPUP_LABELS).toHaveLength(4);
    expect(QUIT_POPUP_HITBOXES).toHaveLength(2);
    const answers = QUIT_POPUP_LABELS[3]!;
    expect(answers.text).toContain('JA');
    expect(answers.text).toContain('NEIN');
    for (const z of QUIT_POPUP_HITBOXES) {
      expect(z.y0).toBe(answers.row);
      expect(z.y1).toBe(answers.row + 7); // text row 8 pixels high
    }
  });
});

describe('screen list', () => {
  it('carries exactly the two footer screens', () => {
    expect([...OPTIONS_SCREENS].sort()).toEqual([0x22, 0x25]);
    expect(optionsPopupHitboxes(0x25)).toBe(OPTIONS_POPUP_HITBOXES);
    expect(optionsPopupHitboxes(0x22)).toBe(QUIT_POPUP_HITBOXES);
  });

  it('draws the labels in renderer order', () => {
    expect(OPTIONS_LABELS_TOP.map((l) => l.row)).toEqual([0x02, 0x0b, 0x1c, 0x25, 0x30, 0x39, 0x44, 0x4d]);
    expect(OPTIONS_LABELS_BOTTOM.map((l) => l.text)).toEqual([
      'MUSIK',
      '   SFX',
      ' LAUT-',
      'STAERKE:',
    ]);
  });

  /**
   * The one deliberate deviation from the original must stay **bounded**: our SFX line must not leave
   * the rectangle the two original lines `'  SVGA'` / `'  MODE'` occupy. Exactly that rectangle is
   * excluded from the pixel comparison — were the label outside it, the deviation would silently be
   * larger than documented.
   */
  it('keeps the SFX label inside the rectangle of the two original lines', () => {
    const sfx = OPTIONS_LABELS_BOTTOM.find((l) => l.text.includes('SFX'));
    expect(sfx).toBeDefined();
    const x0 = sfx!.col * 8;
    expect(x0).toBeGreaterThanOrEqual(OPTIONS_SFX_LABEL_BOX.x);
    expect(x0 + sfx!.text.length * 8).toBeLessThanOrEqual(
      OPTIONS_SFX_LABEL_BOX.x + OPTIONS_SFX_LABEL_BOX.width,
    );
    expect(sfx!.row).toBeGreaterThanOrEqual(OPTIONS_SFX_LABEL_BOX.y);
    expect(sfx!.row + 8).toBeLessThanOrEqual(OPTIONS_SFX_LABEL_BOX.y + OPTIONS_SFX_LABEL_BOX.height);
    // And the checkbox next to it stays in its original place — the deviation is the lettering, not
    // the geometry.
    expect(OPTIONS_SFX_CHECK_POS).toEqual({ col: 0xe, row: 0x6a });
  });
});


/**
 * **The popup over the menu area.** What is checked is not the image (the capture tools do that) but
 * the one property that belongs to the composition: the result lands **at the position from
 * `POPUP_BOUNDS_SMALL`** and nowhere else. That offset is exactly where a port can silently be off —
 * the content would look right, only shifted by a few pixels.
 */
describe('drawMenuPopup — position on the menu area', () => {
  /** Covers every entry with a 1x1 pixel; that way every drawn pixel is opaque. */
  const provider: SpriteProvider = () =>
    ({
      width: 1,
      height: 1,
      offsetX: 0,
      offsetY: 0,
      deltaX: 0,
      deltaY: 0,
      pixels: new Uint8ClampedArray([200, 100, 50, 255]),
    }) as DecodedSprite;
  const view = {
    viewOptions: [0x39, 0x39] as [number, number],
    volume: 75,
    music: true,
    sfx: true,
  };

  it('draws exclusively inside POPUP_BOUNDS_SMALL', () => {
    const fb = createFramebuffer(352, 240);
    expect(drawMenuPopup(fb, provider, 0x25, view, { textColor: TEXT })).toBe(true);
    let outside = 0;
    let inside = 0;
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 352; x++) {
        if (fb.rgba[(y * 352 + x) * 4 + 3] === 0) continue;
        const within =
          x >= POPUP_BOUNDS_SMALL.x &&
          x < POPUP_BOUNDS_SMALL.x + POPUP_BOUNDS_SMALL.width &&
          y >= POPUP_BOUNDS_SMALL.y &&
          y < POPUP_BOUNDS_SMALL.y + POPUP_BOUNDS_SMALL.height;
        if (within) inside++;
        else outside++;
      }
    }
    expect(outside).toBe(0);
    // And the screen is opaque — the precondition for a block blit to place it correctly over the
    // background at all (measured against a capture with 23040 pixels).
    expect(inside).toBe(POPUP_BOUNDS_SMALL.width * POPUP_BOUNDS_SMALL.height);
  });

  it('draws nothing and reports false for a foreign screen', () => {
    const fb = createFramebuffer(352, 240);
    expect(drawMenuPopup(fb, provider, 0x24, view, { textColor: TEXT })).toBe(false);
    expect(fb.rgba.every((v) => v === 0)).toBe(true);
  });
});

/**
 * **Drawing and hitting as ONE chain.** The elements live in the module as `{col, row}`, are drawn
 * with `panelX/panelY` (`+8/+9`), placed with `POPUP_BOUNDS_SMALL` and hit through `hitTestPanel`
 * (`-8/-9`). Each of these four places is checked on its own — the bug arises only when **chaining**
 * them, and that is exactly how it arose: the interaction layer subtracted the frame offset a second
 * time, the dialog stayed mute, and **no** existing check fired (the zone table was right, the image
 * was right, only the path in between was not).
 *
 * The check therefore takes the **drawn** point of every control and demands that it hits that
 * control's zone. It does not check the tables (the binary guards do that) but the chain.
 *
 * The final test subtracts the frame offset a second time and demands that the point then misses
 * **every** element — otherwise the chain would also be satisfiable with a wrong offset and the
 * check above would say nothing.
 */
describe('clickMenuPopup — the drawn point hits its own zone', () => {
  /** Control -> expected effect, in drawing columns/rows as in the renderer. */
  const controls: readonly { name: string; col: number; row: number; want: unknown }[] = [
    ...OPTION_CHECKBOXES.map((c) => ({
      name: `checkbox 0x${c.action.toString(16)}`,
      col: c.col,
      row: c.row,
      want: {
        kind: 'toggle',
        side: c.side,
        mask: c.mask,
        label: c.side === 0 ? 'left side' : 'right side',
      },
    })),
    { name: 'music', ...OPTIONS_MUSIC_CHECK_POS, want: { kind: 'music' } },
    { name: 'SFX', ...OPTIONS_SFX_CHECK_POS, want: { kind: 'sfx' } },
    { name: 'volume -', col: OPTIONS_VOLUME_MINUS.col, row: OPTIONS_VOLUME_MINUS.row, want: { kind: 'volume', delta: -1 } },
    { name: 'volume +', col: OPTIONS_VOLUME_PLUS.col, row: OPTIONS_VOLUME_PLUS.row, want: { kind: 'volume', delta: 1 } },
    { name: 'RAUS', col: OPTIONS_EXIT_ICON.col, row: OPTIONS_EXIT_ICON.row, want: { kind: 'close' } },
  ];

  /** The point where the renderer starts this element — in pixels of the 352 x 240 area. */
  const drawnPoint = (col: number, row: number) => ({
    x: POPUP_BOUNDS_SMALL.x + panelX(col),
    y: POPUP_BOUNDS_SMALL.y + panelY(row),
  });

  it('hits every control of screen 0x25', () => {
    for (const c of controls) {
      const p = drawnPoint(c.col, c.row);
      expect(clickMenuPopup(0x25, p.x, p.y), c.name).toEqual(c.want);
    }
  });

  it('is null next to the popup and on an empty spot inside it', () => {
    expect(clickMenuPopup(0x25, POPUP_BOUNDS_SMALL.x - 1, POPUP_BOUNDS_SMALL.y + 40)).toBeNull();
    expect(clickMenuPopup(0x25, 0, 0)).toBeNull();
    // Middle of the screen — a label, no zone.
    expect(clickMenuPopup(0x25, POPUP_BOUNDS_SMALL.x + 60, POPUP_BOUNDS_SMALL.y + 100)).toBeNull();
  });

  it('misses EVERY element with the frame offset subtracted twice', () => {
    let survivors = 0;
    for (const c of controls) {
      const p = drawnPoint(c.col, c.row);
      const wrong = clickOptionsPopup(
        0x25,
        p.x - POPUP_BOUNDS_SMALL.x - PANEL_CLICK_ORIGIN_X,
        p.y - POPUP_BOUNDS_SMALL.y - PANEL_CLICK_ORIGIN_Y,
      );
      if (JSON.stringify(wrong) === JSON.stringify(c.want)) survivors++;
    }
    expect(survivors).toBe(0);
  });
});
