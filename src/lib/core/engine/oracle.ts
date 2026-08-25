/**
 * Differential oracle — entity-by-entity comparison of two game states.
 *
 * The original is the oracle: to falsify a ported state handler, run this engine `N` ticks from a
 * state `A` and compare the result entity by entity with an original state `B` that advanced the same
 * starting point `N` ticks in the real DOS game. The FIRST deviation localises the faulty handler.
 *
 * This module is the pure comparison logic — no IO, JSON-capable inputs. It knows nothing about save
 * files or emulators; a dev runner hands the fixtures in. That keeps the committed code free of
 * original data and testable with synthetic fixtures.
 *
 * Only BEHAVIOUR-DEFINING fields are compared. Deliberately omitted, because they would produce false
 * deviations rather than real state divergence:
 * - derived display strings (`typeName`/`stateName`), which are redundant,
 * - the serf `tick` stamp: only a "last updated" timestamp, staggered by 1/16 rotation in the
 *   original and set to `gameTick` every tick here, so it differs by design and does not affect
 *   progress, since only the delta sum matters,
 * - the transient flag search fields (`searchNum`/`searchDir`), pure BFS scratch.
 */

import type {
  SaveGameState,
  SerfRecord,
  FlagRecord,
  BuildingRecord,
  InventoryRecord,
} from '../types.js';

/** A single differing field (array elements are named `field[i]`). */
export interface FieldDiff {
  readonly field: string;
  readonly a: unknown;
  readonly b: unknown;
}

/** Deviations of one entity, identified by dense slot index. */
export interface EntityDiff {
  readonly index: number;
  readonly diffs: readonly FieldDiff[];
}

/** Comparison summary of one entity class. */
export interface ClassReport {
  /** Slots occupied in A or B (the union). */
  readonly total: number;
  /** Slots occupied in both and equal in every compared field. */
  readonly matched: number;
  /** Slots occupied in both but differing. */
  readonly mismatched: number;
  /** Slots occupied in A only (gone from, or not yet in, the original). */
  readonly onlyInA: number;
  /** Slots occupied in B only. */
  readonly onlyInB: number;
  /** The first `sampleLimit` differing entities, by ascending index, with their field diffs. */
  readonly samples: readonly EntityDiff[];
}

export interface OracleReport {
  readonly tickA: number;
  readonly tickB: number;
  readonly serfs: ClassReport;
  readonly flags: ClassReport;
  readonly buildings: ClassReport;
  readonly inventories: ClassReport;
}

export interface OracleOptions {
  /** Maximum number of differing entities per class in `samples` (default 8). */
  readonly sampleLimit?: number;
}

// ---- Field extractors: record -> flat, comparable plain object ----

function serfFields(s: SerfRecord): Record<string, unknown> {
  return {
    owner: s.owner,
    type: s.type,
    state: s.state,
    animation: s.animation,
    counter: s.counter,
    col: s.col,
    row: s.row,
    stateData: [...s.stateData],
  };
}

function flagFields(f: FlagRecord): Record<string, unknown> {
  return {
    owner: f.owner,
    hasBuilding: f.hasBuilding,
    hasResources: f.hasResources,
    paths: [...f.paths],
    resourceSlots: [...f.resourceSlots],
    slotDir: [...f.slotDir],
    slotDest: [...f.slotDest],
    transporters: [...f.transporters],
    serfRequestFail: f.serfRequestFail,
    length: [...f.length],
    otherEndDir: [...f.otherEndDir],
    scheduled: [...f.scheduled],
    scheduledSlot: [...f.scheduledSlot],
    acceptsSerfs: f.acceptsSerfs,
    acceptsResources: f.acceptsResources,
    stockPriority: [...f.stockPriority],
  };
}

function buildingFields(b: BuildingRecord): Record<string, unknown> {
  return {
    type: b.type,
    owner: b.owner,
    col: b.col,
    row: b.row,
    constructing: b.constructing,
    progress: b.progress,
    flag: b.flag,
    firstKnight: b.firstKnight,
    active: b.active,
    burning: b.burning,
    holder: b.holder,
    serfRequested: b.serfRequested,
    threatLevel: b.threatLevel,
    stock: b.stock.map((s) => [s.available, s.requested]),
    stockMaximum: b.stockMaximum ? [...b.stockMaximum] : null,
    hasInventory: b.hasInventory,
    inventoryIndex: b.inventoryIndex,
    level: b.level,
  };
}

function inventoryFields(inv: InventoryRecord): Record<string, unknown> {
  return {
    owner: inv.owner,
    resMode: inv.resMode,
    serfMode: inv.serfMode,
    flag: inv.flag,
    building: inv.building,
    resources: [...inv.resources],
    outQueue: inv.outQueue.map((q) => [q.type, q.dest]),
    genericCount: inv.genericCount,
    serfIndices: [...inv.serfIndices],
  };
}

// ---- Generischer Feld-Diff ----

/** Zwei extrahierte Feld-Objekte vergleichen; Arrays element-weise als `feld[i]`. */
function diffFields(a: Record<string, unknown>, b: Record<string, unknown>): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const key of Object.keys(a)) {
    const av = a[key];
    const bv = b[key];
    if (Array.isArray(av) && Array.isArray(bv)) {
      const n = Math.max(av.length, bv.length);
      for (let i = 0; i < n; i++) {
        if (!scalarEqual(av[i], bv[i])) out.push({ field: `${key}[${i}]`, a: av[i], b: bv[i] });
      }
    } else if (!scalarEqual(av, bv)) {
      out.push({ field: key, a: av, b: bv });
    }
  }
  return out;
}

/** Scalar equality; one level deep is enough for these fields. */
function scalarEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => scalarEqual(v, b[i]));
  }
  return a === b;
}

/** Index a sparse record list by slot index. */
function byIndex<T extends { index: number }>(records: readonly T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const r of records) m.set(r.index, r);
  return m;
}

/** Compare one entity class. */
function compareClass<T extends { index: number }>(
  recordsA: readonly T[],
  recordsB: readonly T[],
  extract: (r: T) => Record<string, unknown>,
  sampleLimit: number,
): ClassReport {
  const mapA = byIndex(recordsA);
  const mapB = byIndex(recordsB);
  const indices = new Set<number>([...mapA.keys(), ...mapB.keys()]);
  let matched = 0;
  let mismatched = 0;
  let onlyInA = 0;
  let onlyInB = 0;
  const samples: EntityDiff[] = [];

  for (const index of [...indices].sort((x, y) => x - y)) {
    const ra = mapA.get(index);
    const rb = mapB.get(index);
    if (ra && !rb) {
      onlyInA++;
      continue;
    }
    if (!ra && rb) {
      onlyInB++;
      continue;
    }
    // both present
    const diffs = diffFields(extract(ra as T), extract(rb as T));
    if (diffs.length === 0) {
      matched++;
    } else {
      mismatched++;
      if (samples.length < sampleLimit) samples.push({ index, diffs });
    }
  }

  return { total: indices.size, matched, mismatched, onlyInA, onlyInB, samples };
}

/**
 * Compare two game states entity by entity. By convention `a` is this engine's state and `b` the
 * original oracle.
 */
export function diffStates(a: SaveGameState, b: SaveGameState, opts: OracleOptions = {}): OracleReport {
  const sampleLimit = opts.sampleLimit ?? 8;
  return {
    tickA: a.header.tick,
    tickB: b.header.tick,
    serfs: compareClass(a.serfRecords, b.serfRecords, serfFields, sampleLimit),
    flags: compareClass(a.flagRecords, b.flagRecords, flagFields, sampleLimit),
    buildings: compareClass(a.buildingRecords, b.buildingRecords, buildingFields, sampleLimit),
    inventories: compareClass(a.inventoryRecords, b.inventoryRecords, inventoryFields, sampleLimit),
  };
}

/** Compact, human-readable summary of a report, for dev runner output. */
export function formatReport(r: OracleReport): string {
  const line = (name: string, c: ClassReport): string =>
    `${name.padEnd(12)} ${String(c.matched).padStart(5)}/${String(c.total - c.onlyInA - c.onlyInB).padStart(5)} equal` +
    `  · ${c.mismatched} differing` +
    (c.onlyInA ? `  · ${c.onlyInA} only-A` : '') +
    (c.onlyInB ? `  · ${c.onlyInB} only-B` : '');
  const classes: [string, ClassReport][] = [
    ['Serfs', r.serfs],
    ['Flags', r.flags],
    ['Buildings', r.buildings],
    ['Inventories', r.inventories],
  ];
  const lines = [`Tick A=${r.tickA}  B=${r.tickB}`, ...classes.map(([n, c]) => line(n, c))];
  for (const [name, c] of classes) {
    if (c.samples.length === 0) continue;
    lines.push(`  first ${name} deviations:`);
    for (const s of c.samples) {
      const fields = s.diffs.map((d) => `${d.field}: ${JSON.stringify(d.a)}≠${JSON.stringify(d.b)}`).join(', ');
      lines.push(`    #${s.index}  ${fields}`);
    }
  }
  return lines.join('\n');
}
