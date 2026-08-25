/**
 * The probe itself — what is checked is what can be checked without real timing: that an unpaired
 * `end` invents nothing, that the outlier column really shows the outlier (that is why the thing
 * exists), and that the rate window ROLLS.
 *
 * There is no "collects nothing while disabled" case: there is no switch any more (see the module
 * header). The measurement hangs off the bug report, and a switch nobody flips can only do one
 * thing — empty a report.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { metrics, LOGIC_PHASES, RENDER_PHASES, REPORT_PHASES } from './render-metrics.js';

/** A phase pair with a noticeable duration, so the number does not collapse to 0. */
function spend(ms: number): void {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    /* busy */
  }
}

describe('render metrics', () => {
  // Module singleton: without the reset every case would carry the previous one's measurements.
  beforeEach(() => metrics.reset());

  it('records one measurement per pair, with nobody switching anything on', () => {
    for (let i = 0; i < 3; i++) {
      metrics.begin('rgba');
      metrics.end('rgba');
    }
    const p = metrics.report().phases.find((x) => x.phase === 'rgba');
    expect(p?.count).toBe(3);
    expect(p!.max).toBeGreaterThanOrEqual(p!.median);
  });

  it('an `end` without a `begin` invents no measurement', () => {
    metrics.end('upload');
    expect(metrics.report().phases.find((x) => x.phase === 'upload')).toBeUndefined();
  });

  it('`reset` empties the rings again', () => {
    metrics.begin('scale');
    metrics.end('scale');
    metrics.reset();
    expect(metrics.report().phases).toEqual([]);
  });

  it('the maximum shows the outlier, the median does not', () => {
    for (let i = 0; i < 8; i++) {
      metrics.begin('terrain');
      metrics.end('terrain');
    }
    metrics.begin('terrain');
    spend(12);
    metrics.end('terrain');
    const p = metrics.report().phases.find((x) => x.phase === 'terrain')!;
    expect(p.max).toBeGreaterThanOrEqual(10);
    expect(p.median).toBeLessThan(p.max / 2);
  });

  it('counts rebuilds and remembers surface size and zoom', () => {
    metrics.countRebuild();
    metrics.countRebuild();
    metrics.note(640, 480, 0.5);
    const r = metrics.report();
    expect(r.rebuildsPerSecond).toBeGreaterThan(0);
    expect(r.surface).toEqual({ width: 640, height: 480 });
    expect(r.zoom).toBe(0.5);
  });

  /**
   * The actual reason for the rolling window: the measurement now runs across the whole session.
   * Without the cut the rate would be "since load" — halved after two seconds of idling, useless
   * after a minute. What is checked is the class: a rate AFTER the pause must not be dragged down by
   * the time BEFORE it.
   */
  it('the rate refers to the last window, not to the session', () => {
    const frame = (): void => {
      metrics.begin('frame');
      metrics.end('frame');
    };
    // Complete one window (2 s) holding exactly one frame ⇒ the rate is correspondingly low.
    frame();
    spend(2010);
    frame();
    const slow = metrics.report().fps;
    expect(slow).toBeLessThan(2);
    // Then in quick succession: the next completed window has to be clearly higher.
    const t0 = performance.now();
    while (performance.now() - t0 < 2100) frame();
    expect(metrics.report().fps).toBeGreaterThan(slow * 10);
  });

  it('the sum phase comes last — and the logic group behind it', () => {
    expect(RENDER_PHASES[RENDER_PHASES.length - 1]).toBe('frame');
    // `frame` is the sum of the DRAW phases; the logic side runs in the clock callback and is
    // therefore a group of its own, printed behind the frame.
    expect(REPORT_PHASES).toEqual([...RENDER_PHASES, ...LOGIC_PHASES]);
    expect(LOGIC_PHASES.every((p) => !RENDER_PHASES.includes(p as never))).toBe(true);
  });
});
