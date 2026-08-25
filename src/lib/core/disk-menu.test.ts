import { describe, it, expect } from 'vitest';
import {
  DISK_ACTION_CLOSE,
  DISK_ACTION_NAME,
  DISK_ACTION_RESULT_CLOSE,
  DISK_ACTION_RUN,
  DISK_ACTION_SLOT0,
  DISK_DEFAULT_NAME,
  DISK_HITBOXES_LIST,
  DISK_HITBOXES_RESULT,
  DISK_LAYOUT_LOAD,
  DISK_LAYOUT_SAVE,
  DISK_NAME_LENGTH,
  DISK_NO_SLOT,
  DISK_RESULT,
  DISK_RESULT_LINES,
  DISK_SLOT_BAR,
  DISK_SLOT_ROW0,
  DISK_SLOT_ROW_STEP,
  applyDiskMenuAction,
  applyDiskMenuKey,
  beginDiskOperation,
  clickDiskList,
  clickDiskResult,
  diskSaveResetsClocks,
  diskSlotLine,
  diskSlotUsed,
  enterDiskMenu,
  isLoadResult,
} from './disk-menu.js';
import { ARCHIV_SLOT_COUNT, ARCHIV_SLOT_SIZE, encodeArchiv, parseArchiv } from './archiv-parser.js';
import { PANEL_CLICK_ORIGIN_X, PANEL_CLICK_ORIGIN_Y, panelY } from './ui-render.js';
import { TEXT_KEY_BACKSPACE, TEXT_KEY_COMMIT } from './text-input.js';

/**
 * What the tables do **not** say: the three gates, the two branches a port loses silently, and the
 * coupling selection bar <-> text row.
 */

const archivWith = (used: readonly number[], names: Record<number, string> = {}): Uint8Array =>
  encodeArchiv(
    Array.from({ length: ARCHIV_SLOT_COUNT }, (_, i) => ({
      index: i,
      name: names[i] ?? `SPIEL ${i}`,
      used: used.includes(i),
    })),
  );

describe('disk-menu — zones and drawing', () => {
  it('puts the ten slot zones exactly on the ten text rows', () => {
  // The renderer writes row i at row = 0x14 + 10i; the zone table has the same y0.
    for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
      const z = DISK_HITBOXES_LIST.find((r) => r.action === DISK_ACTION_SLOT0 + i)!;
      expect(z.y0).toBe(DISK_SLOT_ROW0 + i * DISK_SLOT_ROW_STEP);
      expect(z.y1 - z.y0).toBe(9);
    }
  });

  it('wraps the row glyphs in the selection bar with one pixel of air each', () => {
  // The apparent 8 px offset is none: the text wrapper adds +9 to the row internally.
    for (let i = 0; i < ARCHIV_SLOT_COUNT; i++) {
      const glyphTop = panelY(DISK_SLOT_ROW0 + i * DISK_SLOT_ROW_STEP);
      const barTop = DISK_SLOT_BAR.y0 + i * DISK_SLOT_BAR.dy;
      expect(glyphTop - barTop).toBe(1);
      expect(barTop + DISK_SLOT_BAR.h - (glyphTop + 8)).toBe(1);
    }
  });

  it('covers every button zone with an icon — except zone 79 in load mode', () => {
    const covered = (layout: readonly { icon: number; col: number; row: number }[], a: number) => {
      const z = DISK_HITBOXES_LIST.find((r) => r.action === a)!;
      return layout.some((it) => it.col * 8 === z.x0 && it.row === z.y0);
    };
    for (const a of [DISK_ACTION_CLOSE, DISK_ACTION_NAME, DISK_ACTION_RUN]) {
      expect(covered(DISK_LAYOUT_SAVE, a)).toBe(true);
    }
    expect(covered(DISK_LAYOUT_LOAD, DISK_ACTION_CLOSE)).toBe(true);
    expect(covered(DISK_LAYOUT_LOAD, DISK_ACTION_RUN)).toBe(true);
  // The invisible button: the zone stays, the icon is missing — it becomes ineffective only
  // through the gate INSIDE the action.
    expect(covered(DISK_LAYOUT_LOAD, DISK_ACTION_NAME)).toBe(false);
  });

  it('hits slot 3 and the exit button of the result window in drawing pixels', () => {
    const y = DISK_SLOT_ROW0 + 3 * DISK_SLOT_ROW_STEP + PANEL_CLICK_ORIGIN_Y + 4;
    expect(clickDiskList(40 + PANEL_CLICK_ORIGIN_X, y)).toBe(DISK_ACTION_SLOT0 + 3);
    expect(clickDiskResult(120 + PANEL_CLICK_ORIGIN_X, 136 + PANEL_CLICK_ORIGIN_Y)).toBe(
      DISK_ACTION_RESULT_CLOSE,
    );
    expect(DISK_HITBOXES_RESULT).toHaveLength(1);
  });

  it('gives every result code its rows — code 6 has only one', () => {
    for (const code of Object.values(DISK_RESULT)) {
      expect(DISK_RESULT_LINES.get(code)).toBeDefined();
    }
  // Every error carries its heading plus two rows — code 6 only one (@0x3f2f5 has no second call
  // there, while all other error branches have two).
    expect(DISK_RESULT_LINES.get(DISK_RESULT.readFailed)).toHaveLength(2);
    for (const c of [2, 3, 4, 5, 7]) expect(DISK_RESULT_LINES.get(c)).toHaveLength(3);
    expect(DISK_RESULT_LINES.get(DISK_RESULT.saved)).toHaveLength(3);
  // Codes 3 and 4 show the same rows — the original catches both with a `jb $0x5` branch.
    expect(DISK_RESULT_LINES.get(3)).toEqual(DISK_RESULT_LINES.get(4));
  });

  it('splits the eight codes the way the exit compares them', () => {
  // Action 91 tests against exactly {1,4,6,7} — the four load results.
    expect([0, 1, 2, 3, 4, 5, 6, 7].filter(isLoadResult)).toEqual([1, 4, 6, 7]);
  });
});

describe('disk-menu — choosing a slot and typing a name', () => {
  it('ignores the list while typing is in progress', () => {
    let s = enterDiskMenu(archivWith([0]), true);
    expect(s.selectedSlot).toBe(DISK_NO_SLOT);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 2).state;
    expect(s.selectedSlot).toBe(2);
    s = applyDiskMenuAction(s, DISK_ACTION_NAME).state;
    expect(s.nameInput).not.toBeNull();
  // `bt $0x0` @0x2fa11 — the ten slot bodies return at once while input is running.
    const after = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 5);
    expect(after.state.selectedSlot).toBe(2);
    expect(after.effect.kind).toBe('none');
    expect(after.sound).toBe(8); // the zone walker still sounds — it sounds BEFORE the action
  });

  it('allows no name typing in load mode (the gate sits in the action)', () => {
    let s = enterDiskMenu(archivWith([0, 1]), false);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 1).state;
    const r = applyDiskMenuAction(s, DISK_ACTION_NAME);
    expect(r.effect.kind).toBe('none');
    expect(r.state.nameInput).toBeNull();
  });

  it('needs a selected slot for name input', () => {
    const s = enterDiskMenu(archivWith([]), true);
    expect(applyDiskMenuAction(s, DISK_ACTION_NAME).state.nameInput).toBeNull();
  });

  it('writes every keystroke into the ARCHIV entry itself', () => {
    let s = enterDiskMenu(archivWith([], { 4: 'ALT' }), true);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 4).state;
    s = applyDiskMenuAction(s, DISK_ACTION_NAME).state;
  // The action clears the name AND sets the used flag — before saving.
    expect(diskSlotLine(s.archiv, 4)).toBe(' '.repeat(DISK_NAME_LENGTH));
    expect(diskSlotUsed(s.archiv, 4)).toBe(true);
    for (const ch of 'MEIN SPIEL') s = applyDiskMenuKey(s, ch.charCodeAt(0));
    expect(diskSlotLine(s.archiv, 4)).toBe('MEIN SPIEL    ');
    expect(parseArchiv(s.archiv)[4]!.name).toBe('MEIN SPIEL'.padEnd(14));
  // Neighbouring slots stay untouched — the pointer hits only the slot's 14 bytes.
    expect(s.archiv[3 * ARCHIV_SLOT_SIZE + 15]).toBe(0);
  });

  it('keeps the name on commit and lets the input end', () => {
    let s = enterDiskMenu(archivWith([]), true);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 0).state;
    s = applyDiskMenuAction(s, DISK_ACTION_NAME).state;
    for (const ch of 'AB') s = applyDiskMenuKey(s, ch.charCodeAt(0));
    s = applyDiskMenuKey(s, TEXT_KEY_BACKSPACE);
    expect(diskSlotLine(s.archiv, 0)).toBe('A' + ' '.repeat(13));
    s = applyDiskMenuKey(s, TEXT_KEY_COMMIT);
    expect(s.nameInput).toBeNull();
    expect(diskSlotLine(s.archiv, 0)).toBe('A' + ' '.repeat(13)); // commit erases nothing
  });
});

describe('disk-menu — the operation and its two silent branches', () => {
  it('does nothing without a selected slot (@0x37144)', () => {
    const s = enterDiskMenu(archivWith([0]), true);
    expect(beginDiskOperation(s)[0].kind).toBe('none');
  });

  it('returns BARE on a free slot in load mode (@0x46e78)', () => {
    let s = enterDiskMenu(archivWith([0]), false);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 7).state; // slot 7 is free
    const r = applyDiskMenuAction(s, DISK_ACTION_RUN);
  // No error code, no result screen — only the sound that had already played.
    expect(r.effect.kind).toBe('none');
    expect(r.state.result).toBe(DISK_RESULT.saved); // unchanged
  });

  it('gives a free slot the default name when saving', () => {
    let s = enterDiskMenu(archivWith([]), true);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 9).state;
    const r = applyDiskMenuAction(s, DISK_ACTION_RUN);
    expect(r.effect).toEqual({ kind: 'perform', save: true, slot: 9 });
    expect(diskSlotLine(r.state.archiv, 9)).toBe(DISK_DEFAULT_NAME);
    expect(diskSlotUsed(r.state.archiv, 9)).toBe(true);
    expect(DISK_DEFAULT_NAME).toHaveLength(DISK_NAME_LENGTH);
  });

  it('leaves a named slot alone when saving', () => {
    let s = enterDiskMenu(archivWith([2], { 2: 'ZWEITER VERS' }), true);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 2).state;
    const r = applyDiskMenuAction(s, DISK_ACTION_RUN);
    expect(diskSlotLine(r.state.archiv, 2)).toBe('ZWEITER VERS  ');
  });

  it('loads an occupied slot', () => {
    let s = enterDiskMenu(archivWith([5]), false);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 5).state;
    expect(applyDiskMenuAction(s, DISK_ACTION_RUN).effect).toEqual({
      kind: 'perform',
      save: false,
      slot: 5,
    });
  });
});

describe('disk-menu — the index that saving writes', () => {
 /**
  * **The two producers of the same index must agree.** `encodeArchiv` builds it from a slot list,
  * the disk menu types it straight into the bytes. If the two diverged, a save written here would be
  * invisible in the original — without an error, because the original reads only this index.
  */
  it('writes an index both `parseArchiv` and `encodeArchiv` confirm', () => {
    let s = enterDiskMenu(archivWith([1], { 1: 'ALTER STAND' }), true);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 6).state;
    s = applyDiskMenuAction(s, DISK_ACTION_NAME).state;
    for (const ch of 'NEUER STAND') s = applyDiskMenuKey(s, ch.charCodeAt(0));
    const r = applyDiskMenuAction(s, DISK_ACTION_RUN);
    expect(r.effect).toEqual({ kind: 'perform', save: true, slot: 6 });

  // 160 bytes, ten entries, separator everywhere — the shape the original expects.
    expect(r.state.archiv).toHaveLength(ARCHIV_SLOT_COUNT * ARCHIV_SLOT_SIZE);
    const slots = parseArchiv(r.state.archiv);
    expect(slots[6]).toEqual({ index: 6, name: 'NEUER STAND'.padEnd(14), used: true });
    expect(slots[1]).toEqual({ index: 1, name: 'ALTER STAND'.padEnd(14), used: true });
    expect(slots.filter((x) => x.used)).toHaveLength(2);
  // And byte for byte the same as what the other producer makes from the same list.
    expect(encodeArchiv(slots, { base: r.state.archiv })).toEqual(r.state.archiv);
  });

  it('marks a freshly named slot as used, even without saving', () => {
  // A property of the ORIGINAL, not a convenience: action 79 sets the used flag (@0x2f9ce), long
  // before a file exists.
    let s = enterDiskMenu(archivWith([]), true);
    s = applyDiskMenuAction(s, DISK_ACTION_SLOT0 + 0).state;
    s = applyDiskMenuAction(s, DISK_ACTION_NAME).state;
    expect(parseArchiv(s.archiv)[0]!.used).toBe(true);
  });
});

describe('disk-menu — the two exits', () => {
  it('branches on exit via the same bit 2 that selects the mode', () => {
    expect(applyDiskMenuAction(enterDiskMenu(archivWith([]), true), DISK_ACTION_CLOSE).effect.kind).toBe(
      'exitToGame',
    );
    expect(
      applyDiskMenuAction(enterDiskMenu(archivWith([]), false), DISK_ACTION_CLOSE).effect.kind,
    ).toBe('exitToMenu');
  });

  it('enters the loaded game from the result only on a load code', () => {
    const at = (code: number, save: boolean) =>
      applyDiskMenuAction(
        { ...enterDiskMenu(archivWith([]), save), result: code },
        DISK_ACTION_RESULT_CLOSE,
      ).effect.kind;
    expect(at(DISK_RESULT.loaded, false)).toBe('enterLoadedGame');
    expect(at(DISK_RESULT.openFailed, false)).toBe('enterLoadedGame');
    expect(at(DISK_RESULT.saved, true)).toBe('exitToGame');
    expect(at(DISK_RESULT.writeFailed, true)).toBe('exitToGame');
  });

  it('resets the three clocks only after a successful save', () => {
  // `or %ax,%ax ; jne 0x28530` @0x28501 — the test is against 0, not against "no error".
    expect(diskSaveResetsClocks(DISK_RESULT.saved)).toBe(true);
    for (const c of [1, 2, 3, 4, 5, 6, 7]) expect(diskSaveResetsClocks(c)).toBe(false);
  });
});
