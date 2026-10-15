/**
 * **What a bug report needs to be replayable**: the state the session started from, every command
 * applied since, and the elapsed ticks.
 *
 * One session belongs to one source state. A save loaded in the disk menu starts a new one — the
 * commands before it were applied to another world, and mixing them in makes the log unreplayable
 * without anyone noticing.
 *
 * `elapsed` exists because `gameTick` is a u16 and wraps every 65536 ticks (about 11 minutes). A log
 * stamped only with `gameTick` leaves the gap between two entries to be guessed, and a gap of a whole
 * turn is invisible.
 */
import type { SaveGameState } from '../core/types.js';
import type { RecordedAction } from './debug-export.js';

/**
 * Upper bound of the log. A truncated log is worthless for replaying, so the bound is generous and
 * an overflow is COUNTED rather than dropped silently — the report then says it cannot be replayed.
 */
export const REPORT_ACTION_LIMIT = 20000;

export interface ReportSession {
  /** The state the session started from, untouched — `loadState` clones it. */
  readonly source: SaveGameState;
  readonly actions: RecordedAction[];
  /** Ticks run since `source`. */
  elapsed: number;
  /** Entries lost to {@link REPORT_ACTION_LIMIT}; non-zero means the log cannot be replayed. */
  dropped: number;
}

export function newReportSession(source: SaveGameState): ReportSession {
  return { source, actions: [], elapsed: 0, dropped: 0 };
}

/** Book `n` ticks — called where the simulation advances, after `runTicks`. */
export function advanceReportSession(session: ReportSession, n: number): void {
  session.elapsed += n;
}

export function recordReportAction(
  session: ReportSession,
  gameTick: number,
  cmd: { readonly kind: string },
  applied: boolean,
): void {
  const { kind, ...detail } = cmd as { kind: string } & Record<string, unknown>;
  session.actions.push({ tick: gameTick, elapsed: session.elapsed, kind, detail, applied });
  if (session.actions.length > REPORT_ACTION_LIMIT) {
    session.actions.shift();
    session.dropped++;
  }
}
