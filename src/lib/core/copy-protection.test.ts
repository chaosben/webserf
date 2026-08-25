import { describe, expect, it } from 'vitest';
import {
  COPY_PROTECTION_CELL_SYMBOL,
  COPY_PROTECTION_CLICKS,
  COPY_PROTECTION_SYMBOLS,
  COPY_PROTECTION_SYMBOL_BASE,
  COPY_PROTECTION_SYMBOL_SPRITE,
  COPY_PROTECTION_TEXTS,
  drawCopyProtection,
  initialCopyProtectionState,
  copyProtectionCell,
  copyProtectionClick,
  copyProtectionCode,
  copyProtectionCommands,
  copyProtectionEchoPos,
  copyProtectionPageText,
  copyProtectionSymbolEntry,
  copyProtectionTask,
  copyProtectionWorldText,
} from './copy-protection.js';
import { MENU_AREA, type MenuTarget } from './main-menu.js';

describe('Kopierschutz-Bildschirm — Gitter', () => {
  it('maps click points onto cells 0..19, row base 10', () => {
    expect(copyProtectionCell(16, 44)).toBe(0);
    expect(copyProtectionCell(47, 75)).toBe(0); // dieselbe 32er-Zelle
    expect(copyProtectionCell(48, 44)).toBe(1);
    expect(copyProtectionCell(304, 44)).toBe(9);
    expect(copyProtectionCell(16, 76)).toBe(10);
    expect(copyProtectionCell(304, 107)).toBe(19);
  });

  it('rejects everything outside the verified bounds', () => {
    expect(copyProtectionCell(15, 44)).toBeNull(); // js @0xb6d0
    expect(copyProtectionCell(0x150, 44)).toBeNull(); // jns @0xb6d7
    expect(copyProtectionCell(16, 43)).toBeNull(); // above the grid row
    expect(copyProtectionCell(16, 108)).toBeNull(); // jae $0x40 @0xb6c2
  });

  it('agrees with the character table: 16 symbols, 4 empty cells', () => {
    // The sharpest test of the module — it ties THREE independent original tables together: the
    // character table @0x4c46, the cell table @0xb8b7 and the sprite table @0xb8cb.
    const drawn = new Map(COPY_PROTECTION_SYMBOLS.map((s) => [`${s.x},${s.y}`, s.entry]));
    let checked = 0;
    for (let cell = 0; cell < 20; cell++) {
      const x = 16 + (cell % 10) * 32;
      const y = cell < 10 ? 44 : 76;
      const symbol = COPY_PROTECTION_CELL_SYMBOL[cell];
      if (symbol === null) {
        expect(drawn.has(`${x},${y}`)).toBe(false);
        continue;
      }
      expect(copyProtectionSymbolEntry(symbol)).toBe(drawn.get(`${x},${y}`));
      checked++;
    }
    expect(checked).toBe(16);
    expect(COPY_PROTECTION_CELL_SYMBOL.filter((s) => s === null)).toHaveLength(4);
  });

  it('is a permutation: 16 ids, 16 distinct sprites', () => {
    expect(new Set(COPY_PROTECTION_SYMBOL_SPRITE).size).toBe(16);
    expect(new Set(COPY_PROTECTION_SYMBOLS.map((s) => s.entry)).size).toBe(16);
    for (const s of COPY_PROTECTION_SYMBOLS) {
      expect(s.entry).toBeGreaterThanOrEqual(COPY_PROTECTION_SYMBOL_BASE);
      expect(s.entry).toBeLessThan(COPY_PROTECTION_SYMBOL_BASE + 16);
    }
  });
});

describe('Kopierschutz-Bildschirm — Aufgabe', () => {
  it('derives page and half from the high word of rng * 0x10c', () => {
    expect(copyProtectionTask(0)).toEqual({ page: 2, half: 'OBEN' });
    expect(copyProtectionTask(0xffff)).toEqual({ page: 135, half: 'UNTEN' });
    // The whole range stays in 2..135 — exactly the length of the answer table (134 pages).
    const pages = new Set<number>();
    const halves = new Set<string>();
    for (let r = 0; r <= 0xffff; r += 7) {
      const t = copyProtectionTask(r);
      pages.add(t.page);
      halves.add(t.half);
    }
    expect(Math.min(...pages)).toBe(2);
    expect(Math.max(...pages)).toBe(135);
    expect(pages.size).toBe(134);
    expect(halves).toEqual(new Set(['OBEN', 'UNTEN']));
  });

  it('composes the page number without a leading zero', () => {
    expect(copyProtectionPageText(2)).toBe('SEITE  2');
    expect(copyProtectionPageText(9)).toBe('SEITE  9');
    expect(copyProtectionPageText(20)).toBe('SEITE 20');
    expect(copyProtectionPageText(99)).toBe('SEITE 99');
    expect(copyProtectionPageText(100)).toBe('SEITE 100');
    expect(copyProtectionPageText(135)).toBe('SEITE 135');
  });

  it('puts the world-size digit into byte 0x17 of the template', () => {
    expect(copyProtectionWorldText(3)).toBe('SPIELWELT: BIS GROESSE 3');
    expect(copyProtectionWorldText(8)).toBe('SPIELWELT: BIS GROESSE 8');
    expect(copyProtectionWorldText(8)).toHaveLength(COPY_PROTECTION_TEXTS.world.length);
  });
});

describe('Kopierschutz-Bildschirm — Kommandos', () => {
  const task = { page: 20, half: 'OBEN' } as const;

  it('draws background, then symbols, then text', () => {
    const cmds = copyProtectionCommands({ task });
    const firstText = cmds.findIndex((c) => c.kind === 'text');
    const lastIcon = cmds.map((c) => c.kind).lastIndexOf('icon');
    expect(firstText).toBeGreaterThan(0);
    expect(lastIcon).toBeLessThan(firstText); // without the echo row it ends with text
    expect(cmds.filter((c) => c.kind === 'icon')).toHaveLength(8 * 24 + 16);
  });

  it('keeps everything inside the menu area', () => {
    for (const c of copyProtectionCommands({ task, picked: [0, 1, 2] })) {
      const w = c.kind === 'text' ? c.text.length * 8 : 32;
      expect(c.x).toBeGreaterThanOrEqual(MENU_AREA.x);
      expect(c.x + w).toBeLessThanOrEqual(MENU_AREA.x + MENU_AREA.width);
      expect(c.y).toBeGreaterThanOrEqual(MENU_AREA.y);
      expect(c.y).toBeLessThan(MENU_AREA.y + MENU_AREA.height);
    }
  });

  it('puts the page/half text and the echo row into the gap of the grid', () => {
    // Cells 3..6 of the top row are empty — there and only there the text sits.
    const gap = { x0: 16 + 3 * 32, x1: 16 + 7 * 32, y0: 42, y1: 76 };
    const cmds = copyProtectionCommands({ task, picked: [0, 1, 2] });
    const inGap = cmds.filter(
      (c) => c.x >= gap.x0 - 16 && c.x < gap.x1 && c.y >= gap.y0 && c.y < gap.y1,
    );
    expect(inGap.some((c) => c.kind === 'text' && c.text.startsWith('SEITE'))).toBe(true);
    // `' OBEN '` with the spaces — the original builds the word from its blank template @0xba78 via
    // the `addb` chain @0xb54e, so the padding is part of the data.
    expect(inGap.some((c) => c.kind === 'text' && c.text === ' OBEN ')).toBe(true);
    // Only symbol sprites count — the background tiles are everywhere.
    const echo = inGap.filter(
      (c) =>
        c.kind === 'icon' &&
        c.icon >= COPY_PROTECTION_SYMBOL_BASE &&
        c.icon < COPY_PROTECTION_SYMBOL_BASE + 16,
    );
    expect(echo).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(copyProtectionEchoPos(i)).toEqual({ x: 128 + i * 32, y: 42 });
  });

  it('switches the mission line at the verified threshold 3', () => {
    const line = (maxWorld: number): string =>
      copyProtectionCommands({ task, maxWorld })
        .filter((c) => c.kind === 'text')
        .map((c) => (c.kind === 'text' ? c.text : ''))
        .find((t) => t.startsWith('MISSIONEN')) ?? '';
    expect(line(2)).toBe(COPY_PROTECTION_TEXTS.missionsShort);
    expect(line(3)).toBe(COPY_PROTECTION_TEXTS.missionsOk);
    expect(line(8)).toBe(COPY_PROTECTION_TEXTS.missionsOk);
  });

  it('blits icons with ABSOLUTE archive indices (iconBase 0)', () => {
    // The background comes from the icon bank (`FUN_0004f33b` adds 0x366), the symbols do not
    // (`FUN_00004bfb` calls the blit primitive directly) — so the module builds both absolute.
    const calls: string[] = [];
    const target: MenuTarget = {
      icon: (e, x, y) => calls.push(`icon ${e} ${x},${y}`),
      glyph: () => {},
      fill: () => {},
    };
    drawCopyProtection(target, { task }, () => undefined);
    // First tile: wrap start 0x125 on the bottom row => 0x365 + 0x125 = 1162.
    expect(calls[0]).toBe('icon 1162 296,192');
    expect(calls).toContain(`icon ${COPY_PROTECTION_SYMBOLS[0].entry} 16,44`);
  });
});

describe('Kopierschutz-Bildschirm — Bedienung', () => {
  it('collects three symbols and ends afterwards', () => {
    let st = initialCopyProtectionState(0);
    let r = copyProtectionClick(st, 16, 44); // Zelle 0 → Symbol 0x0f
    expect(r.done).toBe(false);
    expect(r.state.picked).toEqual([0x0f]);
    r = copyProtectionClick(r.state, 48, 44); // Zelle 1 → 0x0d
    expect(r.done).toBe(false);
    r = copyProtectionClick(r.state, 80, 44); // Zelle 4 → 0x04
    expect(r.done).toBe(true);
    expect(r.state.picked).toEqual([0x0f, 0x0d, 0x04]);
    // First click = most significant nibble (`shlw $0x4` before the `or`).
    expect(copyProtectionCode(r.state.picked)).toBe(0xfd4);
  });

  it('ignores a click outside the grid', () => {
    // @0xb663 ff.: back to the loop head, i.e. a no-op.
    const st = initialCopyProtectionState(0);
    const r = copyProtectionClick(st, 0, 0);
    expect(r.done).toBe(false);
    expect(r.state.picked).toEqual([]);
  });

  it('treats the four text cells like a click beside the grid', () => {
    const st = initialCopyProtectionState(0);
    for (const cell of [3, 4, 5, 6]) {
      const r = copyProtectionClick(st, 16 + cell * 32, 44);
      expect(r.state.picked).toEqual([]);
      expect(r.done).toBe(false);
    }
  });

  it('verlangt genau drei Klicks', () => {
    expect(COPY_PROTECTION_CLICKS).toBe(3);
    expect(copyProtectionCode([])).toBe(0);
    expect(copyProtectionCode([1, 2, 3])).toBe(0x123);
  });
});
