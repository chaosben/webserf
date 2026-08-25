/**
 * MEASUREMENT of the draw AND logic path — in the browser, where a Node measurement is blind.
 *
 * An offline profile can measure the same production path but cannot see anything from
 * `putImageData` onwards (there is no canvas in Node), so its numbers are explicitly a LOWER BOUND.
 * That is exactly where the suspicion lies while zooming out: the index surface is `window / zoom`
 * in size, its pixel count grows with 1/zoom², and it is uploaded once and drawn scaled once per
 * frame.
 *
 * THERE IS NO READOUT FOR IT ANY MORE. The measurement runs regardless, because it hangs off the
 * BUG REPORT: "stutters when zooming out" cannot be answered without these numbers, and a reporter
 * cannot supply them afterwards — their machine is the test bench. The report writer puts them into
 * `report.md`.
 *
 * THREE DESIGN DECISIONS:
 *
 * 1. NOT ONLY THE MEDIAN, ALSO THE MAXIMUM. The complaint is "stuttering", and stuttering lives in
 *    the outlier, not in the average: a full ground rebuild at small zoom costs twenty times an idle
 *    frame. A median alone would hide exactly the case we are looking for.
 * 2. NO SVELTE REACTIVITY HERE. The values are produced inside the draw pass; as `$state` every
 *    frame would invalidate the reactivity graph and the probe would sit inside what it measures.
 *    Plain ring buffers instead, summarised by `report()` on demand.
 * 3. ALWAYS ON, NO SWITCH. While the readout existed it switched the measurement on and off; that is
 *    now a trap rather than a saving (whoever calls `disable()` silently empties every future
 *    report). The cost is measured, not estimated: 1.90 µs per frame for all eight phase pairs
 *    (20,000 frames) == 0.012 % of a 16 ms frame.
 */

/**
 * Report order, part 1: THE FRAME in its own order, with the sum `frame` last (a test relies on
 * that).
 */
export const RENDER_PHASES = [
  'resize',
  'terrain',
  'entities',
  'overlays',
  'rgba',
  'upload',
  'scale',
  'frame',
] as const;

/**
 * Part 2: the LOGIC side — a group of its own, because `frame` does not contain it (it runs in the
 * clock callback, the frame is produced afterwards in a Svelte effect).
 *
 * The reason it exists: a report once proved the opposite of what it was meant to prove. After the
 * snapshot decoding was dropped, the whole frame cost 2.6 ms at 15.4 frames/s on the reporter's
 * machine — about 4 % of a core. "Where does the CPU load come from?" was therefore no longer
 * answerable inside the draw path, and about everything else the report had NO number. `pump` is the
 * whole clock callback (ticks + ground signature + sound + message clocks), `logic` only `runTicks`
 * within it — the difference tells whether the simulation or its surroundings cost.
 */
export const LOGIC_PHASES = ['pump', 'logic'] as const;

/** What the report prints, in this order. */
export const REPORT_PHASES = [...RENDER_PHASES, ...LOGIC_PHASES] as const;

export type RenderPhase = (typeof REPORT_PHASES)[number];

/** Description per phase — printed in the report so a number is readable without the source. */
export const PHASE_LABEL: Record<RenderPhase, string> = {
  frame: 'whole frame',
  resize: 'canvas resize',
  terrain: 'ground (retained)',
  entities: 'entities',
  overlays: 'cursor / build helper',
  rgba: 'palette → colour (CPU)',
  upload: 'putImageData',
  scale: 'drawImage (zoom)',
  pump: 'logic pump (whole clock callback)',
  logic: 'runTicks (simulation only)',
};

const CAP = 90;

/**
 * Length of the rate window. It MUST roll: the measurement now runs for the whole session, and
 * "frames per second since load" would be meaningless after half an hour spent in the menu. The
 * report should say what happened most recently.
 */
const RATE_WINDOW_MS = 2000;

class Ring {
  readonly samples = new Float64Array(CAP);
  n = 0;
  /** Total number of measurements, including the ones already pushed out. */
  total = 0;

  push(v: number): void {
    this.samples[this.n % CAP] = v;
    this.n++;
    this.total++;
  }

  reset(): void {
    this.n = 0;
    this.total = 0;
  }

  get count(): number {
    return Math.min(this.n, CAP);
  }

  /** Median and maximum in one pass — the report always needs both. */
  stats(): { median: number; max: number } | null {
    const c = this.count;
    if (c === 0) return null;
    const a = Array.from(this.samples.subarray(0, c)).sort((x, y) => x - y);
    return { median: a[c >> 1]!, max: a[c - 1]! };
  }
}

export interface PhaseStats {
  readonly phase: RenderPhase;
  readonly median: number;
  readonly max: number;
  readonly count: number;
}

export interface RenderMetricsReport {
  readonly phases: readonly PhaseStats[];
  /** Frames drawn per second, over the last rate window. */
  readonly fps: number;
  /** Full ground rebuilds per second (zoom change, size change, signature). */
  readonly rebuildsPerSecond: number;
  /**
   * LOGIC TICKS PER SECOND over the same window. It is the reference for the `logic` phase: a tick
   * of 0.1 ms is one per cent at 100 ticks/s and eight at 800 ticks/s (the speed steps go up to 8x).
   * Without this number the median per call cannot be converted into load.
   */
  readonly ticksPerSecond: number;
  readonly surface: { readonly width: number; readonly height: number } | null;
  readonly zoom: number;
  /**
   * Which presenter did the palette conversion. Without it `rgba`, `upload` and `scale` can no
   * longer be interpreted: on the GPU route they measure something different than on the CPU route
   * (see the module header of `index-presenter.ts`). `null` = none ran (no archive/no palette).
   */
  readonly presenter: 'gpu' | 'cpu' | null;
}

class RenderMetrics {
  #rings = new Map<RenderPhase, Ring>();
  #open = new Map<RenderPhase, number>();
  #windowStart = 0;
  #frames = 0;
  #rebuilds = 0;
  #ticks = 0;
  /** Last COMPLETED window; `null` while none is complete. */
  #rate: { fps: number; rebuildsPerSecond: number; ticksPerSecond: number } | null = null;
  #surface: { width: number; height: number } | null = null;
  #zoom = 1;
  #presenter: 'gpu' | 'cpu' | null = null;

  #ring(phase: RenderPhase): Ring {
    let r = this.#rings.get(phase);
    if (r === undefined) {
      r = new Ring();
      this.#rings.set(phase, r);
    }
    return r;
  }

  reset(): void {
    for (const r of this.#rings.values()) r.reset();
    this.#open.clear();
    this.#frames = 0;
    this.#rebuilds = 0;
    this.#ticks = 0;
    this.#rate = null;
    this.#windowStart = performance.now();
    this.#surface = null;
    this.#presenter = null;
  }

  begin(phase: RenderPhase): void {
    this.#open.set(phase, performance.now());
  }

  end(phase: RenderPhase): void {
    const t0 = this.#open.get(phase);
    if (t0 === undefined) return;
    this.#open.delete(phase);
    const now = performance.now();
    this.#ring(phase).push(now - t0);
    if (phase !== 'frame') return;
    this.#frames++;
    if (now - this.#windowStart >= RATE_WINDOW_MS) {
      this.#rate = this.#ratesSince(now);
      this.#frames = 0;
      this.#rebuilds = 0;
      this.#ticks = 0;
      this.#windowStart = now;
    }
  }

  #ratesSince(now: number): { fps: number; rebuildsPerSecond: number; ticksPerSecond: number } {
    const secs = Math.max(1e-3, (now - this.#windowStart) / 1000);
    return {
      fps: this.#frames / secs,
      rebuildsPerSecond: this.#rebuilds / secs,
      ticksPerSecond: this.#ticks / secs,
    };
  }

  /** A full ground rebuild — the most expensive single item while zooming. */
  countRebuild(): void {
    this.#rebuilds++;
  }

  /**
   * Logic ticks that have just run. Counted are the TICKS, not the calls: `runTicks(gs, 8)` at 8x
   * speed is one call and eight ticks, and the cost hangs off the ticks.
   */
  countTicks(n: number): void {
    this.#ticks += n;
  }

  /** Size of the index surface and the zoom, so the numbers can be put in context. */
  note(width: number, height: number, zoom: number): void {
    this.#surface = { width, height };
    this.#zoom = zoom;
  }

  /**
   * Which route produced the colour. The presenter reports this per frame, because it can fall back
   * for a single oversized surface — so the report shows the route of the LAST frame.
   */
  notePresenter(kind: 'gpu' | 'cpu'): void {
    this.#presenter = kind;
  }

  report(): RenderMetricsReport {
    const phases: PhaseStats[] = [];
    for (const phase of REPORT_PHASES) {
      const r = this.#rings.get(phase);
      const s = r?.stats();
      if (r === undefined || s === null || s === undefined) continue;
      phases.push({ phase, median: s.median, max: s.max, count: r.total });
    }
    // Before the first complete window, the running one — otherwise a short session reports 0.
    const rate = this.#rate ?? this.#ratesSince(performance.now());
    return { phases, ...rate, surface: this.#surface, zoom: this.#zoom, presenter: this.#presenter };
  }
}

export const metrics = new RenderMetrics();
