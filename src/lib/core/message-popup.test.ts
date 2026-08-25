import { describe, expect, it } from 'vitest';
import {
  MESSAGE_ACTION_CLOSE,
  MESSAGE_LEVEL_BIT,
  MESSAGE_FACE_BOX_COLORS,
  MESSAGE_FACE_BOX_H,
  MESSAGE_FACE_BOX_W,
  MESSAGE_KINDS,
  MESSAGE_MENU_ICONS,
  MESSAGE_PANEL_STRIP,
  MESSAGE_POPUP_HITBOXES,
  drawMessagePopup,
  isMessageStripBlockedScreen,
  messageStripShowOutcome,
  hitMessagePanelStrip,
  messageFaceIcon,
  messageHasPosition,
  messageIsVisible,
  messageParam,
  messageType,
  popMessage,
  pruneFilteredMessages,
} from './message-popup.js';
import {
  UI_OBJECT_BASE,
  createFramebuffer,
  hitTest,
  type Framebuffer,
  type SpriteProvider,
} from './ui-render.js';
import type { DecodedSprite } from './types.js';

/** Text colour as in the original (palette index 0x1f of the game palette). */
const TEXT = [115, 179, 67] as const;

/** One 1x1 sprite per entry whose red channel reveals the entry index. */
function provider(): SpriteProvider {
  return (entry) => {
    const px = new Uint8ClampedArray([entry & 0xff, (entry >> 8) & 0xff, 0, 255]);
    return { width: 1, height: 1, offsetX: 0, offsetY: 0, deltaX: 0, deltaY: 0, pixels: px } as DecodedSprite;
  };
}

function palette(): Uint8Array {
  const p = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    p[i * 4] = i;
    p[i * 4 + 3] = 255;
  }
  return p;
}

const fb = (): Framebuffer => createFramebuffer(144, 160);

/**
 * Provider that yields **only** font glyphs (bank 749..792) — so the image contains nothing but text
 * pixels and the text colour is checkable without layout knowledge. As in the original the glyph
 * sprite is a mask: its own pixels are black (palette index 0).
 */
function glyphOnlyProvider(): SpriteProvider {
  return (entry) =>
    entry >= 749 && entry < 749 + 44
      ? ({
          width: 8,
          height: 8,
          offsetX: 0,
          offsetY: 0,
          deltaX: 0,
          deltaY: 0,
          pixels: new Uint8ClampedArray(8 * 8 * 4).fill(255).map((_, i) => (i % 4 === 3 ? 255 : 0)),
        } as DecodedSprite)
      : null;
}

describe('splitting the type byte', () => {
  it('lower 5 bits = type, upper 3 bits = parameter', () => {
    expect(messageType(0x01)).toBe(1);
    expect(messageParam(0x01)).toBe(0);
    // type 4 with mine kind 3: 3<<5 | 4 = 0x64
    expect(messageType(0x64)).toBe(4);
    expect(messageParam(0x64)).toBe(3);
    expect(messageType(0xff)).toBe(31);
    expect(messageParam(0xff)).toBe(7);
  });
});

describe('MESSAGE_KINDS', () => {
  it('19 types, index 0 is the empty slot', () => {
    expect(MESSAGE_KINDS.length).toBe(20);
    expect(MESSAGE_KINDS[0]).toBeNull();
    for (let t = 1; t <= 19; t++) expect(MESSAGE_KINDS[t], `type ${t}`).not.toBeNull();
  });

  it('every type has at least two text lines and one picture element', () => {
    for (let t = 1; t <= 19; t++) {
      const k = MESSAGE_KINDS[t]!;
      expect(k.lines.length, `type ${t}`).toBeGreaterThanOrEqual(2);
      expect(k.art.kind, `type ${t}`).toBeTruthy();
    }
  });

  it("keeps the original's typo (FERITG)", () => {
    // The text reads like this in the binary; a corrected text would be a silent deviation.
    expect(MESSAGE_KINDS[7]!.lines).toContain('HALLE IST FERITG');
  });
});

describe('messageHasPosition (Bitmaske 0x8f3fe)', () => {
  it('exactly types 1..9, 12..15 and 19', () => {
    const withPos = [];
    for (let t = 0; t < 32; t++) if (messageHasPosition(t)) withPos.push(t);
    expect(withPos).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 19]);
  });

  it('the geological finds carry a position, the emergency-programme messages do not', () => {
    // Cross-check on meaning: a geologist find points at a tile, "emergency programme" is global.
    for (const t of [12, 13, 14, 15]) expect(messageHasPosition(t), `type ${t}`).toBe(true);
    for (const t of [10, 11]) expect(messageHasPosition(t), `type ${t}`).toBe(false);
  });
});

describe('messageFaceIcon (FUN_0003952c)', () => {
  it('0 becomes 0x119, otherwise face + 0x10b', () => {
    expect(messageFaceIcon(0)).toBe(0x119);
    expect(messageFaceIcon(1)).toBe(0x10c);
    expect(messageFaceIcon(0x0c)).toBe(0x117); // human player
  });

  it('the byte is read SIGNED (`movsbw`)', () => {
    // The original has `movsbw`, not `movzbw` — a face >= 0x80 counts as negative.
    expect(messageFaceIcon(0xff)).toBe(0x10b - 1);
  });
});

describe('popMessage (tail of FUN_00027c9a)', () => {
  it('takes the oldest message and shifts the list forward', () => {
    // The port keeps the type column **prefix-packed** (occupied slots only), so the original's
    // terminating write becomes a truncation here rather than a zero byte. See `popMessage`.
    const types = [3, 7, 12];
    const pos = [100, 200, 300];
    expect(popMessage(types, pos)).toEqual({ type: 3, position: 100 });
    expect(types).toEqual([7, 12]);
    expect(pos).toEqual([200, 300]);
  });

  it('leaves a fully read list REALLY empty — otherwise the next message is invisible', () => {
    // Regression: a 0 used to stay in the array. `addPlayerMessage` appends, so the next message
    // landed as `[0, type]` behind a zero, which every reader takes as end of list — after clicking
    // through once no message arrived any more.
    const types = [6];
    const pos = [100];
    popMessage(types, pos);
    expect(types).toEqual([]);
    expect(pos).toEqual([]);
    types.push(3);
    pos.push(42);
    expect(types[0]).toBe(3);
  });

  it('an empty list yields null and changes nothing', () => {
    const types = [0, 0];
    const pos = [0, 0];
    expect(popMessage(types, pos)).toBeNull();
    expect(types).toEqual([0, 0]);
  });

  it('preserves the prefix packing — the invariant measured in the format', () => {
    // Across 78 player blocks: no 0 byte before a non-0. The shifting is the reason.
    const types = [1, 2, 3, 4, 5];
    const pos = [10, 20, 30, 40, 50];
    for (let i = 0; i < 5; i++) {
      popMessage(types, pos);
      expect(types.includes(0), `after ${i + 1} pops`).toBe(false);
      expect(types.length, `after ${i + 1} pops`).toBe(4 - i);
      expect(pos.length).toBe(types.length);
    }
    expect(types).toEqual([]);
  });

  it('returns the position of the popped message, not the next one', () => {
    const types = [9, 1];
    const pos = [4242, 7];
    expect(popMessage(types, pos)!.position).toBe(4242);
  });
});

describe('drawMessagePopup', () => {
  it('draws known types, rejects type 0 and > 19', () => {
    const p = provider();
    const pal = palette();
    expect(drawMessagePopup(fb(), p, { typeByte: 0, playerFaces: [], palette: pal, textColor: TEXT })).toBe(false);
    expect(drawMessagePopup(fb(), p, { typeByte: 20, playerFaces: [], palette: pal, textColor: TEXT })).toBe(false);
    for (let t = 1; t <= 19; t++) {
      expect(
        drawMessagePopup(fb(), p, { typeByte: t, playerFaces: [0xc, 0xb, 0, 0], palette: pal, textColor: TEXT }),
        `type ${t}`,
      ).toBe(true);
    }
  });

  it('the colour box takes the player colour from the parameter', () => {
    const pal = palette();
    for (let player = 0; player < 4; player++) {
      const f = fb();
      // type 1 = attack, colour box at col 6 / row 40 gives pixel (48, 45).
      drawMessagePopup(f, provider(), {
        typeByte: 1 | (player << 5),
        playerFaces: [0xc, 0xb, 0xa, 0x9],
        palette: pal,
        textColor: TEXT,
      });
      const o = (45 * f.width + 48) * 4;
      expect(f.rgba[o], `player ${player}`).toBe(MESSAGE_FACE_BOX_COLORS[player]);
    }
  });

  it('the colour box has the original dimensions (0x30 x 0x48)', () => {
    const f = fb();
    drawMessagePopup(f, provider(), { typeByte: 1, playerFaces: [1], palette: palette(), textColor: TEXT });
    const color = MESSAGE_FACE_BOX_COLORS[0]!;
    const at = (x: number, y: number) => f.rgba[(y * f.width + x) * 4];
    expect(at(48, 45)).toBe(color);
    expect(at(48 + MESSAGE_FACE_BOX_W - 1, 45 + MESSAGE_FACE_BOX_H - 1)).toBe(color);
    expect(at(48 - 1, 45)).not.toBe(color);
    expect(at(48, 45 - 1)).not.toBe(color);
  });

  it('type 4 picks the mine icon via the parameter (0xa3 + kind)', () => {
    // The four mine icons are the same as in the build menu (stone/coal/iron/gold).
    const seen = new Set<number>();
    for (let art = 0; art < 4; art++) {
      const f = fb();
      drawMessagePopup(f, provider(), { typeByte: 4 | (art << 5), playerFaces: [], palette: palette(), textColor: TEXT });
      seen.add(art);
    }
    expect(seen.size).toBe(4);
    expect(MESSAGE_KINDS[4]!.art).toMatchObject({ kind: 'objectIconParam', base: 0xa3 });
  });

  it('type 6 draws hut / tower / fortress, depending on the building class in the parameter', () => {
    // The only branching handler (@0x39949). The parameter comes from `bld[4] & 0x7c`:
    // 0x2c (hut) gives 0, 0x54 (tower) gives 1, otherwise 2.
    const want = [
      { param: 0, icon: 0xab, col: 6 },
      { param: 1, icon: 0x9e, col: 6 },
      { param: 2, icon: 0x98, col: 4 },
      { param: 5, icon: 0x98, col: 4 }, // else branch: anything >= 2 is the fortress
    ];
    for (const w of want) {
      const f = fb();
      drawMessagePopup(f, provider(), { typeByte: 6 | (w.param << 5), playerFaces: [], palette: palette(), textColor: TEXT });
      // The test provider puts the entry index into (r, g); the icon sits at (col*8+8, row+9).
      const o = ((50 + 9) * f.width + (w.col * 8 + 8)) * 4;
      const entry = f.rgba[o]! | (f.rgba[o + 1]! << 8);
      expect(entry, `parameter ${w.param}`).toBe(UI_OBJECT_BASE + w.icon);
    }
    // Discrimination: the three branches really draw different things (otherwise the distinction
    // would have no effect and the test would also pass with the old, single-valued version).
    expect(new Set(want.map((w) => `${w.col}/${w.icon}`)).size).toBe(3);
  });

  it('type 16 picks the menu icon from the table', () => {
    expect(MESSAGE_MENU_ICONS.length).toBe(8);
    expect(MESSAGE_KINDS[16]!.art).toMatchObject({ kind: 'panelIconTable', table: MESSAGE_MENU_ICONS });
  });
});

describe('click', () => {
  it('the whole area closes the window', () => {
    expect(hitTest(MESSAGE_POPUP_HITBOXES, 0, 0)).toBe(MESSAGE_ACTION_CLOSE);
    expect(hitTest(MESSAGE_POPUP_HITBOXES, 127, 143)).toBe(MESSAGE_ACTION_CLOSE);
    expect(hitTest(MESSAGE_POPUP_HITBOXES, 128, 0)).toBeNull();
  });
});

describe('panel strip (entry point)', () => {
  it('upper half shows the message, lower half jumps back', () => {
    const { x, y } = MESSAGE_PANEL_STRIP;
    expect(hitMessagePanelStrip(x + 1, y)).toBe('show');
    expect(hitMessagePanelStrip(x + 6, y + 15)).toBe('show');
    expect(hitMessagePanelStrip(x + 6, y + 28)).toBe('return');
    expect(hitMessagePanelStrip(x + 12, y + 60)).toBe('return');
  });

  it('between the halves lies a dead zone (0x10..0x1b)', () => {
    // Not an oversight in the original: `dy <= 0xf` and `dy > 0x1b` leave 12 rows free.
    const { x, y } = MESSAGE_PANEL_STRIP;
    for (let dy = 0x10; dy <= 0x1b; dy++) {
      expect(hitMessagePanelStrip(x + 6, y + dy), `dy=${dy}`).toBeNull();
    }
  });

  it('is exactly 12 pixels wide and starts EXCLUSIVE', () => {
    const { x, y, width } = MESSAGE_PANEL_STRIP;
    expect(hitMessagePanelStrip(x, y)).toBeNull(); // `<` in the original, not `<=`
    expect(hitMessagePanelStrip(x + 1, y)).toBe('show');
    expect(hitMessagePanelStrip(x + width, y)).toBe('show');
    expect(hitMessagePanelStrip(x + width + 1, y)).toBeNull();
  });

  it('nothing is hit above the strip', () => {
    expect(hitMessagePanelStrip(MESSAGE_PANEL_STRIP.x + 6, MESSAGE_PANEL_STRIP.y - 1)).toBeNull();
  });
});

/**
 * Message level filter (table `DAT_00033bc7`, test `bt` @0x337d6). The levels are the thermometer of
 * the view options: 0 = `0x00`, 1 = `0x20`, 2 = `0x30`, 3 = `0x38` (bits 3..5).
 */
describe('message level filter', () => {
  const LEVEL = [0x00, 0x20, 0x30, 0x38]; // level 0..3 (thermometer bits only)

  it('the table has 20 entries, index 0 is unused', () => {
    expect(MESSAGE_LEVEL_BIT).toHaveLength(20);
    expect(MESSAGE_LEVEL_BIT[0]).toBe(0xff);
    for (let t = 1; t <= 19; t++) expect([0, 3, 4, 5], `type ${t}`).toContain(MESSAGE_LEVEL_BIT[t]);
  });

  it('level 0 shows nothing, level 3 everything (except the bit-0 group)', () => {
    for (let t = 1; t <= 19; t++) {
      expect(messageIsVisible(t, LEVEL[0]!), `type ${t} at level 0`).toBe(false);
      const bit0 = MESSAGE_LEVEL_BIT[t] === 0;
      expect(messageIsVisible(t, LEVEL[3]!), `type ${t} at level 3`).toBe(!bit0);
      expect(messageIsVisible(t, LEVEL[3]! | 1), `type ${t} at level 3 + bit 0`).toBe(true);
    }
  });

  it('level 1 shows EXACTLY the five categories of the manual (p. 114)', () => {
    // "attack, victory, defeat, loss of a building and the emergency programme" — an independent
    // confirmation of the table: 1 attack, 2 fight lost, 3 victory, 9 land AND building lost,
    // 10/11 emergency programme.
    const visible = [];
    for (let t = 1; t <= 19; t++) if (messageIsVisible(t, LEVEL[1]!)) visible.push(t);
    expect(visible).toEqual([1, 2, 3, 9, 10, 11]);
  });

  it('level 2 adds mine/occupation/land loss/geologist — level 3 only the warehouse', () => {
    const at = (lvl: number) => {
      const out = [];
      for (let t = 1; t <= 19; t++) if (messageIsVisible(t, LEVEL[lvl]!)) out.push(t);
      return out;
    };
    expect(at(2)).toEqual([1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
    // The ONLY difference between level 2 and 3 is type 7 (new warehouse). The manual describes
    // level 2 differently (it names occupation + geologist as hidden) — the byte wins.
    expect(at(3).filter((t) => !at(2).includes(t))).toEqual([7]);
  });

  it('the type byte is masked — the parameter in the upper 3 bits does not interfere', () => {
    expect(messageIsVisible(1 | (3 << 5), LEVEL[1]!)).toBe(true);
    expect(messageIsVisible(7 | (7 << 5), LEVEL[2]!)).toBe(false);
  });

  it('pruneFilteredMessages DISCARDS the invisible messages instead of hiding them', () => {
    const types = [7, 12, 1]; // warehouse (bit 3), geologist (bit 4), attack (bit 5)
    const pos = [10, 20, 30];
    expect(pruneFilteredMessages(types, pos, LEVEL[1]!)).toBe(2);
    expect(types).toEqual([1]);
    expect(pos[0]).toBe(30); // the position travels along
  });

  it('stops at the first visible message — later ones are untouched', () => {
    const types = [1, 7, 12, 0];
    const pos = [1, 2, 3, 0];
    expect(pruneFilteredMessages(types, pos, LEVEL[1]!)).toBe(0);
    expect(types).toEqual([1, 7, 12, 0]);
  });

  it('level 0 clears the whole list', () => {
    const types = [1, 2, 3, 9, 0];
    const pos = [1, 2, 3, 4, 0];
    expect(pruneFilteredMessages(types, pos, 0x00)).toBe(4);
    expect(types.every((v) => v === 0)).toBe(true);
  });
});

describe('note strip — the three outcomes (@0x27814 ff.)', () => {
  it('shows when a message is present and nothing intervenes', () => {
    expect(messageStripShowOutcome(true, false, 0)).toBe('show');
  });

  it('sounds like a BUTTON when there is nothing to show, not like a rejection', () => {
    // `if (!(vp[0x87] bit 0)) -> 0x27929` = sound 8, the same tone as a hit button.
    expect(messageStripShowOutcome(false, false, 0)).toBe('nothing');
  });

  it('does nothing in road-building mode (vp[1] bit 7, @0x2782f)', () => {
    expect(messageStripShowOutcome(true, true, 0)).toBe('nothing');
  });

  it('rejects on a blocked screen', () => {
    expect(messageStripShowOutcome(true, false, 0x25)).toBe('blocked');
  });

  it('tests in the original order: list before screen', () => {
    // With no message AND a blocked screen the earlier test wins, giving sound 8, not 4.
    expect(messageStripShowOutcome(false, false, 0x25)).toBe('nothing');
  });
});

describe('note strip — the screen cascade (@0x27852..0x2787b)', () => {
  it('blocks exactly 0x17..0x1a, 0x22..0x23 and 0x25', () => {
    const blocked = [];
    for (let s = 0; s <= 0x3c; s++) if (isMessageStripBlockedScreen(s)) blocked.push(s);
    expect(blocked).toEqual([0x17, 0x18, 0x19, 0x1a, 0x22, 0x23, 0x25]);
  });

  it('lets the neighbours of the bounds through', () => {
    // The bounds are the core of the cascade — 0x16, 0x1b, 0x21, 0x24 and 0x26 must NOT block.
    for (const s of [0x16, 0x1b, 0x21, 0x24, 0x26]) {
      expect(isMessageStripBlockedScreen(s), `screen 0x${s.toString(16)}`).toBe(false);
    }
  });
});

describe('text colour of the message texts', () => {
  // The message window used to draw its texts in BLACK because it did not pass a colour, and
  // `drawPanelText` then blits the raw pixels of the glyph mask. In the original all 19 handlers call
  // the same panel wrapper `0x37c78`, which sets its foreground to 0x1f (@0x37cc6) — the colour is
  // therefore the same for every type and does not come from the caller.
  //
  // Checked via a **sentinel pass**: the pixels that differ between two colour choices are exactly
  // the text pixels. That needs no layout knowledge and rules out a hard-wired colour passing the
  // test. (The naive way, "all drawn pixels", did not work: the colour box of the attack messages is
  // a rectangle fill, not a sprite.)
  const textPixels = (typeByte: number, color: readonly [number, number, number]): number[] => {
    const f = fb();
    drawMessagePopup(f, glyphOnlyProvider(), {
      typeByte,
      playerFaces: [],
      palette: palette(),
      textColor: color,
    });
    return [...f.rgba];
  };

  it('every text pixel carries state.textColor, for all 19 types', () => {
    const OTHER = [7, 11, 13] as const;
    for (let type = 1; type <= 19; type++) {
      const real = textPixels(type, TEXT);
      const sent = textPixels(type, OTHER);
      let drawn = 0;
      let wrong = 0;
      for (let i = 0; i < 144 * 160; i++) {
        const o = i * 4;
        if (real[o] === sent[o] && real[o + 1] === sent[o + 1] && real[o + 2] === sent[o + 2]) continue;
        drawn += 1;
        if (real[o] !== TEXT[0] || real[o + 1] !== TEXT[1] || real[o + 2] !== TEXT[2]) wrong += 1;
      }
      expect(drawn, `type ${type}: colour reaches the glyphs`).toBeGreaterThan(0);
      expect(wrong, `type ${type}: foreign colours in the text pixels`).toBe(0);
    }
  });

  it('a version drawing in black would be distinguishable — the original defect', () => {
    // That was exactly the bug: text in palette index 0. The test records that this shows up in the
    // image — otherwise the colour question would not be checkable.
    const green = textPixels(1, TEXT);
    const black = textPixels(1, [0, 0, 0]);
    let diff = 0;
    for (let i = 0; i < 144 * 160; i++) {
      const o = i * 4;
      if (green[o] !== black[o] || green[o + 1] !== black[o + 1] || green[o + 2] !== black[o + 2]) diff += 1;
    }
    expect(diff).toBeGreaterThan(0);
  });
});
