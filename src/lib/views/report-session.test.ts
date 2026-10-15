import { describe, it, expect } from 'vitest';
import {
  REPORT_ACTION_LIMIT,
  advanceReportSession,
  newReportSession,
  recordReportAction,
} from './report-session.js';
import type { SaveGameState } from '../core/types.js';

const source = { header: { tick: 7 } } as unknown as SaveGameState;

describe('report session — what makes a bug report replayable', () => {
  it('stamps every action with the ticks run since the source, not only the u16 game tick', () => {
    const s = newReportSession(source);
    recordReportAction(s, 65530, { kind: 'buildFlag', col: 1, row: 2 } as { kind: string }, true);
    advanceReportSession(s, 8);
    advanceReportSession(s, 8);
    // gameTick has wrapped here; `elapsed` keeps counting.
    recordReportAction(s, 10, { kind: 'launchAttack', player: 0 } as { kind: string }, false);
    expect(s.actions).toEqual([
      { tick: 65530, elapsed: 0, kind: 'buildFlag', detail: { col: 1, row: 2 }, applied: true },
      { tick: 10, elapsed: 16, kind: 'launchAttack', detail: { player: 0 }, applied: false },
    ]);
    expect(s.elapsed).toBe(16);
    expect(s.source).toBe(source);
  });

  it('counts what falls out of the log instead of dropping it silently', () => {
    const s = newReportSession(source);
    for (let i = 0; i < REPORT_ACTION_LIMIT + 3; i++) recordReportAction(s, i, { kind: 'x' }, true);
    expect(s.actions.length).toBe(REPORT_ACTION_LIMIT);
    expect(s.dropped).toBe(3);
    expect(s.actions[0]!.tick).toBe(3);
  });
});
