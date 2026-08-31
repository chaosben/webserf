import { describe, expect, it } from 'vitest';
import {
  CREDITS_BG_ENTRY,
  CREDITS_BG_POS,
  CREDITS_DOUBLE_STEP,
  CREDITS_LOGO_ENTRY,
  CREDITS_LOGO_POS,
  CREDITS_STEPS,
  CREDITS_STEP_TICKS,
  CREDITS_TEXT_COLOR,
  advanceCredits,
  creditsCommands,
  creditsStepTicks,
  creditsX,
  creditsY,
  drawCredits,
  initialCreditsState,
} from './credits.js';
import { MENU_AREA, MENU_TEXT_COLOR, type MenuTarget } from './main-menu.js';

describe('opening credits — grid', () => {
  it('converts eighth-column and pixel row separately', () => {
    // x = col·8 + 0x10, y = row + 0x20 (FUN_00037b48 @0x37b89..@0x37b91).
    expect(creditsX(0)).toBe(16);
    expect(creditsX(4)).toBe(48);
    expect(creditsX(20)).toBe(176);
    expect(creditsY(0)).toBe(32);
    expect(creditsY(10)).toBe(42);
    expect(creditsY(154)).toBe(186);
  });

  it('keeps all 25 text lines inside the menu area', () => {
    for (let i = 0; i < CREDITS_STEPS.length; i++) {
      for (const c of creditsCommands(i)) {
        if (c.kind !== 'text') continue;
        expect(c.x).toBeGreaterThanOrEqual(MENU_AREA.x);
        expect(c.y).toBeGreaterThanOrEqual(MENU_AREA.y);
        expect(c.x + c.text.length * 8).toBeLessThanOrEqual(MENU_AREA.x + MENU_AREA.width);
        expect(c.y + 8).toBeLessThanOrEqual(MENU_AREA.y + MENU_AREA.height);
      }
    }
  });
});

describe('opening credits — commands', () => {
  it('redraws the background first in every step', () => {
    // Every original body starts with `call 0x46f9`, so the text does not accumulate.
    for (let i = 0; i < CREDITS_STEPS.length; i++) {
      const first = creditsCommands(i)[0];
      expect(first).toEqual({
        kind: 'icon',
        icon: CREDITS_BG_ENTRY,
        x: CREDITS_BG_POS.x,
        y: CREDITS_BG_POS.y,
      });
    }
  });

  it('shows the logo card only in the first step', () => {
    const withLogo = CREDITS_STEPS.map((_, i) =>
      creditsCommands(i).some((c) => c.kind === 'icon' && c.icon === CREDITS_LOGO_ENTRY),
    );
    expect(withLogo).toEqual([true, false, false, false, false, false, false, false, false, false]);
    const logo = creditsCommands(0).find((c) => c.kind === 'icon' && c.icon === CREDITS_LOGO_ENTRY);
    expect(logo).toMatchObject({ x: CREDITS_LOGO_POS.x, y: CREDITS_LOGO_POS.y });
  });

  it('leaves the last step empty (FUN_00004a8a == call 0x46f9 ; ret)', () => {
    expect(creditsCommands(CREDITS_STEPS.length - 1)).toHaveLength(1);
  });

  it('returns nothing for an invalid index instead of throwing', () => {
    expect(creditsCommands(-1)).toEqual([]);
    expect(creditsCommands(99)).toEqual([]);
  });
});

describe('opening credits — dwell times', () => {
  it('stands 215 ticks per step — and twice on the play-tester block', () => {
    // `mov $0xd6` + `subw $1`/`jae` => the value 0 is still passed through (@0x46ba/@0x46de).
    expect(CREDITS_STEP_TICKS).toBe(215);
    for (let i = 0; i < CREDITS_STEPS.length; i++) {
      expect(creditsStepTicks(i)).toBe(i === CREDITS_DOUBLE_STEP ? 430 : 215);
    }
    // Exactly ONE step is doubled — the two wait calls @0x4696/@0x469d.
    const doubled = CREDITS_STEPS.filter((_, i) => creditsStepTicks(i) === 430);
    expect(doubled).toHaveLength(1);
  });

  it('loops forever and swallows no step on a large jump', () => {
    const cycle = CREDITS_STEPS.reduce((s, _, i) => s + creditsStepTicks(i), 0);
    let st = initialCreditsState();
    expect(st).toEqual({ step: 0, elapsed: 0 });
    // Step by step once around — the original jumps back with `je 0x45f8` @0x46b3.
    for (let i = 0; i < CREDITS_STEPS.length; i++) {
      expect(st.step).toBe(i);
      st = advanceCredits(st, creditsStepTicks(i));
    }
    expect(st).toEqual({ step: 0, elapsed: 0 });
    // A backgrounded tab delivers one large tick jump at once.
    expect(advanceCredits(initialCreditsState(), cycle)).toEqual({ step: 0, elapsed: 0 });
    expect(advanceCredits(initialCreditsState(), CREDITS_STEP_TICKS * 3).step).toBe(3);
    expect(advanceCredits(initialCreditsState(), CREDITS_STEP_TICKS - 1).step).toBe(0);
  });

  it('ignores negative tick deltas', () => {
    expect(advanceCredits({ step: 2, elapsed: 5 }, -100)).toEqual({ step: 2, elapsed: 5 });
  });
});

describe('opening credits — drawing path', () => {
  /** A recorder instead of a framebuffer: WHAT is drawn matters here, not how it looks. */
  function recorder(): { calls: string[]; target: MenuTarget } {
    const calls: string[] = [];
    return {
      calls,
      target: {
        icon: (e, x, y) => calls.push(`icon ${e} ${x},${y}`),
        glyph: (e, x, y, c) => calls.push(`glyph ${e} ${x},${y} c${c}`),
        fill: (x, y, w, h, c) => calls.push(`fill ${x},${y} ${w}x${h} c${c}`),
      },
    };
  }

  it('blits icons with ABSOLUTE archive indices (iconBase 0)', () => {
    // The menu keeps its icons bank-relative and adds MENU_ICON_BASE itself
    // (`addw $0x366` @0x4f365) — the credits do not.
    const r = recorder();
    drawCredits(r.target, 0, () => undefined);
    expect(r.calls[0]).toBe(`icon ${CREDITS_BG_ENTRY} 16,8`);
    expect(r.calls[1]).toBe(`icon ${CREDITS_LOGO_ENTRY} 144,56`);
  });

  it('draws text in the credits colour, not the menu colour', () => {
    const r = recorder();
    drawCredits(r.target, 1, (ch) => (ch === ' ' ? undefined : 100));
    const glyphs = r.calls.filter((c) => c.startsWith('glyph'));
    expect(glyphs.length).toBeGreaterThan(0);
    expect(CREDITS_TEXT_COLOR).not.toBe(MENU_TEXT_COLOR);
    // Every glyph comes twice: first the shadow (colour 1), then the glyph itself.
    const colors = new Set(glyphs.map((c) => c.slice(c.lastIndexOf('c') + 1)));
    expect(colors).toEqual(new Set(['1', String(CREDITS_TEXT_COLOR)]));
  });

  it('draws the shadow BEFORE the glyph — otherwise the outline eats the edges', () => {
    const r = recorder();
    drawCredits(r.target, 1, () => 100);
    const first = r.calls.find((c) => c.startsWith('glyph'))!;
    expect(first.endsWith('c1')).toBe(true);
  });
});
