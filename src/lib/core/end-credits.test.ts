import { describe, expect, it } from 'vitest';
import {
  END_CREDITS_DECO1,
  END_CREDITS_DECO2,
  END_CREDITS_FRAMES,
  END_CREDITS_FRAME_TICKS,
  END_CREDITS_HOLD_BEFORE,
  END_CREDITS_IMAGE_ENTRY,
  END_CREDITS_IMAGE_X0,
  END_CREDITS_LAST_COLUMN,
  END_CREDITS_LINES,
  END_CREDITS_TEXT_COLOR,
  endCreditsCommands,
  endCreditsDue,
  endCreditsFrame,
  endCreditsX,
  endCreditsY,
  advanceEndCredits,
  initialEndCreditsState,
} from './end-credits.js';

const HOLD_END = END_CREDITS_HOLD_BEFORE + 2 * END_CREDITS_LAST_COLUMN + 0x1f;

describe('end credits — phases (run_end_credits @0x38b55)', () => {
  it('phase 1 holds 109 frames on column 0', () => {
    expect(endCreditsFrame(0).column).toBe(0);
    expect(endCreditsFrame(END_CREDITS_HOLD_BEFORE - 1).column).toBe(0);
    expect(endCreditsFrame(0).imageX).toBe(END_CREDITS_IMAGE_X0);
  });

  it('the travel shows every column TWICE (two `call` per round @0x38c0a/@0x38c19)', () => {
    expect(endCreditsFrame(END_CREDITS_HOLD_BEFORE).column).toBe(0);
    expect(endCreditsFrame(END_CREDITS_HOLD_BEFORE + 1).column).toBe(0);
    expect(endCreditsFrame(END_CREDITS_HOLD_BEFORE + 2).column).toBe(1);
    expect(endCreditsFrame(END_CREDITS_HOLD_BEFORE + 3).column).toBe(1);
  });

  it('x = 0x10 - column, the travel ends at -298', () => {
    expect(endCreditsFrame(HOLD_END - 1).column).toBe(END_CREDITS_LAST_COLUMN);
    expect(endCreditsFrame(HOLD_END - 1).imageX).toBe(0x10 - 0x13a);
  });

  it('phase 4 passes -1 but STILL shows the final position', () => {
    const f = endCreditsFrame(HOLD_END);
    expect(f.column).toBeNull(); // the original does not blit here ...
    expect(f.visibleColumn).toBe(END_CREDITS_LAST_COLUMN); // ... it stays visible nonetheless
    expect(f.text).toBe(true);
  });

  it('the text appears only AFTER the travel', () => {
    expect(endCreditsFrame(HOLD_END - 1).text).toBe(false);
    expect(endCreditsFrame(HOLD_END).text).toBe(true);
  });

  // Binding is the down counter: `mov $0x2d9,0x1c(%edi)` @0x38edc, `cmpw $0x64` @0x38ef2,
  // `subw $0x1` @0x38f08 — the volume falls, it does not rise.
  it('the volume fades out over the last 100 frames (`cmpw $0x64` @0x38ef2)', () => {
    expect(endCreditsFrame(HOLD_END).volume).toBeNull();
    // The counter is `holdEnd - k` and must be BELOW 100 (`jae` @0x38ef7) — the first frame with a
    // volume is therefore the 99th from the end, not the 100th.
    const rampFrom = END_CREDITS_FRAMES - 99;
    expect(endCreditsFrame(rampFrom - 1).volume).toBeNull();
    expect(endCreditsFrame(rampFrom).volume).toBe(99);
    expect(endCreditsFrame(END_CREDITS_FRAMES - 1).volume).toBe(1);
  });

  it('the decoration counters keep running in the hold phase too (@0x39094 behind the branch)', () => {
    const a = endCreditsFrame(HOLD_END).deco2Entry;
    const b = endCreditsFrame(HOLD_END + 1).deco2Entry;
    expect(a).not.toBe(b);
    // cycle of 7 (`cmpw $0x7` @0x39105)
    expect(endCreditsFrame(HOLD_END + END_CREDITS_DECO2.frames).deco2Entry).toBe(a);
  });
});

describe('end credits — drawing', () => {
  it('draws ground, picture, two decoration sprites and 21 lines in the hold phase', () => {
    const cmds = endCreditsCommands(endCreditsFrame(HOLD_END));
    expect(cmds[0]).toEqual({ kind: 'bar', x: 0, y: 0, w: 0x160, h: 0xf0, color: 0 });
    const icons = cmds.filter((c) => c.kind === 'icon');
    expect(icons.map((c) => (c as { icon: number }).icon)[0]).toBe(END_CREDITS_IMAGE_ENTRY);
    expect(icons).toHaveLength(3);
    expect(cmds.filter((c) => c.kind === 'text')).toHaveLength(END_CREDITS_LINES.length);
  });

  it('before the text it is the same three sprites but no line', () => {
    const cmds = endCreditsCommands(endCreditsFrame(0));
    expect(cmds.filter((c) => c.kind === 'icon')).toHaveLength(3);
    expect(cmds.filter((c) => c.kind === 'text')).toHaveLength(0);
  });

  it('the decoration follows the travelling picture origin, not the screen', () => {
    const f = endCreditsFrame(END_CREDITS_HOLD_BEFORE + 200);
    const icons = endCreditsCommands(f).filter((c) => c.kind === 'icon') as { x: number; y: number }[];
    expect(icons[1]!.x).toBe(f.imageX + END_CREDITS_DECO1.dx);
    expect(icons[2]!.x).toBe(f.imageX + END_CREDITS_DECO2.dx);
  });

  it('text origin: col 0x28 => x 0x10, row + 0xe (FUN_00037bad @0x37bee ff.)', () => {
    expect(endCreditsX(0x28)).toBe(0x10);
    expect(endCreditsY(0x0a)).toBe(0x18);
    expect(END_CREDITS_TEXT_COLOR).toBe(0x1f);
  });
});

describe('end credits — trigger (@0x38824)', () => {
  it('runs only on the last campaign level', () => {
    expect(endCreditsDue(0x1e)).toBe(true);
    expect(endCreditsDue(0x1d)).toBe(false);
    expect(endCreditsDue(0)).toBe(false);
  });
});

describe('end credits — clock (5 ticks per frame, `cmpw $0x5` @0x38fe5)', () => {
  it('a frame stands for exactly END_CREDITS_FRAME_TICKS ticks', () => {
    let s = initialEndCreditsState();
    for (let i = 0; i < END_CREDITS_FRAME_TICKS - 1; i++) s = advanceEndCredits(s, 1);
    expect(s.frame).toBe(0);
    s = advanceEndCredits(s, 1);
    expect(s.frame).toBe(1);
    expect(s.elapsed).toBe(0);
  });

  it('a large tick jump loses no duration (background tab)', () => {
    const jump = advanceEndCredits(initialEndCreditsState(), 40 * END_CREDITS_FRAME_TICKS);
    expect(jump.frame).toBe(40);
    let step = initialEndCreditsState();
    for (let i = 0; i < 40 * END_CREDITS_FRAME_TICKS; i++) step = advanceEndCredits(step, 1);
    expect(step.frame).toBe(jump.frame);
  });

  it('ends after END_CREDITS_FRAMES and stays on the last picture', () => {
    const s = advanceEndCredits(initialEndCreditsState(), END_CREDITS_FRAMES * END_CREDITS_FRAME_TICKS);
    expect(s.done).toBe(true);
    expect(s.frame).toBe(END_CREDITS_FRAMES - 1);
    // The last frame belongs to the hold phase: text up, picture in its final position.
    expect(endCreditsFrame(s.frame).text).toBe(true);
  });

  it('is a fixed point once finished — no wrap like the intro credits', () => {
    const done = advanceEndCredits(initialEndCreditsState(), END_CREDITS_FRAMES * END_CREDITS_FRAME_TICKS);
    expect(advanceEndCredits(done, 10_000)).toEqual(done);
  });

  it('negative or zero ticks move nothing', () => {
    const s = initialEndCreditsState();
    expect(advanceEndCredits(s, 0)).toEqual(s);
    expect(advanceEndCredits(s, -5)).toEqual(s);
  });
});
