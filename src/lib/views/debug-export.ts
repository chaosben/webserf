/**
 * Build the debug report — as a **ZIP package in the browser** that the reporter downloads and
 * attaches to a GitHub issue themselves: save game as JSON, action log, a markdown note and a PNG
 * of the map.
 *
 * **There is deliberately no endpoint**, and not merely out of convenience: GitHub has **no API for
 * attachments** — an issue created server-side cannot carry `state.json` and `screen.png`. Only the
 * reporter can drag the file in. A server route would therefore buy nothing and cost a rate limiter,
 * a folder boundary and the question what of all this belongs in a public repository; without one
 * the application is fully static. See `shell/project.ts`.
 *
 * **The save game comes along shrunk** (`core/report-state.ts`): the map as a seed reference plus
 * deviations instead of a tile table. Without that the package would be around 18 MB at 512x256 —
 * a size nobody attaches to an issue.
 *
 * The log belongs with it because the engine is deterministic: from one state anything can be
 * computed forwards, but which clicks led there cannot be reconstructed. It is replayed from the
 * SOURCE state named in `report.md` — `state.json` is the result, the log the way there.
 *
 * A second state ("before/after") is deliberately missing: it would contain nothing that cannot be
 * computed from the first.
 */
import { FRAME_TICKS } from '../core/engine/tick.js';
import { mapSeedInputCode } from '../core/main-menu.js';
import { PHASE_LABEL, REPORT_PHASES, type RenderMetricsReport } from './render-metrics.js';
import type { SaveGameState } from '../core/types.js';
// A serf record carries no state name — the name belongs to the number and is resolved here.
import { SERF_STATE_NAMES } from '../core/save-parser.js';
import { MAP_FIELD_COUNT, reduceReportState } from '../core/report-state.js';
import { buildZipDeflated } from '../core/zip.js';
import { newReportId, reportName } from './report-name.js';
import { ISSUE_NOTE_LIMIT, newIssueUrl } from '../shell/project.js';
import { buildStamp } from '../shell/build-info.js';

export interface RecordedAction {
  readonly tick: number;
  readonly kind: string;
  readonly detail: Record<string, unknown>;
  /** `false` when the engine rejected it — often exactly the interesting case. */
  readonly applied: boolean;
}

/** Display state the save game does not contain. */
export interface DebugViewContext {
  readonly camX: number;
  readonly camY: number;
  readonly zoom: number;
  readonly viewportW: number;
  readonly viewportH: number;
  readonly popupScreen: number | null;
  readonly previewOpen: boolean;
  readonly roadBuilding: boolean;
  readonly playing: boolean;
  readonly barIcons: readonly (number | undefined)[];
  readonly marked: { col: number; row: number } | null;
}

export interface DebugReportInput {
  readonly note: string;
  readonly state: SaveGameState;
  readonly actions: readonly RecordedAction[];
  readonly view: DebugViewContext;
  readonly screenshotDataUrl: string | null;
  readonly sourceFile?: string;
  /**
   * Drawing cost, measured on the REPORTER's machine. It is here because "stutters when zooming
   * out" is the only class of fault that can NOT be recomputed from save and action log: it hangs
   * on their machine and their window size. Asking does not help — by the time the answer arrives
   * the situation is gone.
   */
  readonly render?: RenderMetricsReport;
}

/**
 * The finished package. **No network involved** — what comes out is what the reporter downloads,
 * and the id is the package's. Where the report goes is their decision.
 */
export interface DebugReport {
  /** Id of the report (`k7m2q9xf`) — it appears in the file name and in the issue title. */
  readonly id: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** Pre-filled issue link — the reporter still has to attach the package themselves. */
  readonly issueUrl: string;
  /** Display only: how large the package turned out. */
  readonly size: number;
}

/** What stands on the marked tile — building, serf, flag. */
function describeTile(state: SaveGameState, col: number, row: number): string[] {
  const pos = row * state.header.mapCols + col;
  const t = state.mapTiles[pos];
  if (t === undefined) return [`Tile (${col},${row}) is outside the map.`];
  const out: string[] = [
    `- tile (${col},${row}) — object ${t.object}, owner ${t.owner}, height ${t.height}, ` +
      `terrain ${t.terrainUp}/${t.terrainDown}, paths 0x${t.paths.toString(16)}${t.blocked ? ' (blocked)' : ''}`,
  ];
  if (t.mineral > 0 || t.resourceAmount > 0) {
    out.push(`- mineral: type ${t.mineral}, amount left ${t.resourceAmount}`);
  }
  const bld = state.buildingRecords.find((b) => b.col === col && b.row === row);
  if (bld) {
    out.push(
      `- building #${bld.index} ${bld.typeName} (type ${bld.type}), player ${bld.owner}` +
        `${bld.constructing ? `, UNDER CONSTRUCTION (progress ${bld.progress})` : ', finished'}` +
        `${bld.burning ? ', BURNING' : ''}` +
        `, holder=${bld.holder}, serfRequested=${bld.serfRequested}, serfRequestFailed=${bld.serfRequestFailed}` +
        `, stock=[${bld.stock[0].available}/${bld.stock[0].requested}, ${bld.stock[1].available}/${bld.stock[1].requested}]` +
        `, stockMax=${bld.stockMaximum ? `[${bld.stockMaximum[0]},${bld.stockMaximum[1]}]` : 'null'}` +
        `, flag=#${bld.flag}, firstKnight=#${bld.firstKnight}`,
    );
  }
  if (t.object === 1) {
    const flag = state.flagRecords.find((f) => f.index === t.objIndex);
    if (flag) {
      out.push(
        `- flag #${flag.index}, player ${flag.owner}, paths [${flag.paths.map((p) => (p ? 1 : 0)).join('')}]` +
          `, building=${flag.hasBuilding}, resources=[${flag.resourceSlots.join(',')}]` +
          `, priority=[${flag.stockPriority.join(',')}]`,
      );
    }
  }
  if (t.serfIndex !== 0) {
    const serf = state.serfRecords.find((s) => s.index === t.serfIndex);
    if (serf) {
      out.push(
        `- serf #${serf.index} ${serf.typeName} (type ${serf.type}), player ${serf.owner}` +
          `, state ${serf.state} ${SERF_STATE_NAMES[serf.state] ?? ''}, anim ${serf.animation}, counter ${serf.counter}` +
          `, union [${serf.stateData.join(',')}]`,
      );
    }
  }
  return out;
}

/**
 * Which route the palette conversion took. It stands in the first line because `rgba`, `upload` and
 * `scale` measure **different things** on the GPU route than on the CPU route — without this note
 * the table below is not comparable between two reports.
 */
function presenterLabel(p: 'gpu' | 'cpu' | null): string {
  if (p === 'gpu') return 'GPU (WebGL2, self-test passed)';
  if (p === 'cpu') return 'CPU (no WebGL2, or self-test failed)';
  return 'no presenter ran';
}

/** Whole milliseconds: 8000/99.7 == 80.24 is not a budget with two decimals. */
function budgetLabel(budget: number): string {
  return `${Math.round(budget)} ms`;
}

/**
 * Time budget of ONE picture in ms — the threshold above which a frame really missed one.
 *
 * **Not 16 ms.** The 16 belonged here while drawing happened on repaint; the drawing pass now hangs
 * on the **logic frame** and runs only 12.5 times a second at 1x — so the budget is 80 ms, and it
 * shrinks with game speed (at 8x it is 10). A fixed value therefore flagged every frame above 16 ms
 * at 1x as a missed picture although five times as much time is available.
 *
 * It is derived from the **logic** rate and explicitly not from `fps`: `fps` itself drops with
 * expensive pictures, so a budget computed from it would be circular and always met. The logic rate
 * hangs on the wall clock and the speed control, not on the drawing cost.
 */
function frameBudgetMs(ticksPerSecond: number): number {
  // Without a rate (session without a completed window) assume 1x rather than the old 16 — too
  // tight a default produces false reports, too wide a one only a missing hint.
  return ticksPerSecond > 0 ? (1000 * FRAME_TICKS) / ticksPerSecond : 1000 * FRAME_TICKS / 100;
}

/**
 * Drawing cost as a report section. Outlier before median, because stutter lives in the outlier —
 * a frame above {@link frameBudgetMs} has missed a picture, and that one is the complaint.
 */
function renderCostLines(r: RenderMetricsReport): string[] {
  const ms = (v: number): string => (v < 10 ? v.toFixed(2) : v.toFixed(1));
  const px =
    r.surface === null
      ? 'surface unknown'
      : `surface ${r.surface.width}×${r.surface.height} = ${((r.surface.width * r.surface.height) / 1e6).toFixed(2)} M px`;
  const budget = frameBudgetMs(r.ticksPerSecond);
  const out = [
    '',
    '## Drawing cost (reporter\'s machine, rolling window)',
    '',
    `- ${px} · zoom ${Math.round(r.zoom * 100)} % · ${r.fps.toFixed(1)} frames/s · ` +
      `${r.rebuildsPerSecond.toFixed(1)} full ground rebuilds/s · ` +
      `${r.ticksPerSecond.toFixed(0)} logic ticks/s · colour: ${presenterLabel(r.presenter)}`,
  ];
  if (r.phases.length === 0) {
    out.push('- (no measurement — no drawing pass ran)');
  } else {
    // List ALL phases, including those without a measurement. A phase dropped for want of one is
    // indistinguishable in the report from "costs nothing", and that is the most expensive kind of
    // gap because it looks like a result.
    const measured = new Map(r.phases.map((p) => [p.phase, p]));
    for (const phase of REPORT_PHASES) {
      const p = measured.get(phase);
      out.push(
        p === undefined
          ? `- ${PHASE_LABEL[phase]}: not measured (never ran in this session)`
          : `- ${PHASE_LABEL[phase]}: outlier ${ms(p.max)} ms · median ${ms(p.median)} ms ` +
              `(n ${p.count})${p.max > budget ? `  ⟵ above ${budgetLabel(budget)} (budget)` : ''}`,
      );
    }
  }
  out.push(
    '',
    '`putImageData` and `drawImage` are the two items no measurement outside the browser can see —',
    'they only appear here. `logic pump` is the whole clock callback (ticks + ground signature +',
    'sound + message clocks), `runTicks` only the simulation within it; **load = median × rate**, and',
    'the rates are in the first line. **Pausing** the simulation (including the pause this report',
    'window causes) distorts none of it: the ring buffers hold 90 samples and the rates come from the',
    'last completed window — the numbers describe the last second before the freeze. `not measured`',
    'means that phase never ran in the whole session.',
    'On the **GPU** route three lines measure something else: `putImageData` is the texture upload',
    '(one byte per pixel), `palette → colour` only the queueing of the draw call, and the wait for',
    'the GPU lands in `drawImage`.',
    `The **budget** per frame is ${budgetLabel(budget)} and not 16 ms: drawing hangs on the logic` +
      ` frame (${FRAME_TICKS} ticks), so at ${r.ticksPerSecond.toFixed(0)} logic ticks/s it runs` +
      ` ${(r.ticksPerSecond / FRAME_TICKS).toFixed(1)} times a second — it shrinks with game speed` +
      ` (at 8× it is 10 ms).`,
  );
  return out;
}

/** The readable part of the report. */
function buildReport(input: DebugReportInput, id: string): string {
  const { state, view } = input;
  const h = state.header;
  const map = reduceReportState(state).map;
  const lines: string[] = [
    `# Debug report ${id}`,
    '',
    `> ${input.note.trim().length > 0 ? input.note.trim() : '(no note)'}`,
    '',
    '## State',
    '',
    // WHICH CODE PRODUCED THIS. Without it a report cannot be matched to a state of the source, and
    // "that was fixed weeks ago" is not decidable — the one fact about the report that comes from
    // neither the save game nor the recorded actions.
    `- build: ${buildStamp()}`,
    `- source: ${input.sourceFile ?? 'unknown'}`,
    `- gameTick ${h.tick} · rotation ${h.rotation}/${h.rotationWrap} · RNG [${h.random.join(', ')}]`,
    `- map ${h.mapCols}×${h.mapRows} (mapSize ${h.mapSize}) · active players [${state.activePlayers.join(', ')}]`,
    // The seed is the line that makes a report about the MAP checkable: terrain, minerals, objects
    // and the opponents all follow from it. Only present in free play (for level/mission it sits in
    // the setup record, i.e. in the level number one line above). The input code stands next to it
    // because the original's DISPLAYED code is defective and leads to a different map — see
    // `core/main-menu.mapSeedInputCode`.
    ...(h.mapSeed === undefined
      ? []
      : [
          `- map seed [${h.mapSeed.map((v) => `0x${v.toString(16)}`).join(', ')}]` +
            ` · world size ${h.mapSizeChoice ?? h.mapSize}` +
            ` · type in as ${mapSeedInputCode(h.mapSeed).replace(/(.{4})(?=.)/g, '$1 ')}`,
        ]),
    `- serfs ${state.serfRecords.length} · flags ${state.flagRecords.length} · ` +
      `buildings ${state.buildingRecords.length} (${state.buildingRecords.filter((b) => b.constructing).length} under construction, ` +
      `${state.buildingRecords.filter((b) => b.burning).length} burning) · inventories ${state.inventoryRecords.length}`,
    '',
    '## Marked spot',
    '',
  ];
  if (view.marked === null) lines.push('- (no tile marked)');
  else lines.push(...describeTile(state, view.marked.col, view.marked.row));
  lines.push(
    '',
    '## Display state (not part of the save game)',
    '',
    `- camera (${view.camX}, ${view.camY}) · zoom ${Math.round(view.zoom * 100)} % · window ${view.viewportW}×${view.viewportH}`,
    `- popup ${view.popupScreen === null ? 'none' : `0x${view.popupScreen.toString(16)}`} · ` +
      `map view ${view.previewOpen ? 'open' : 'closed'} · road building ${view.roadBuilding ? 'active' : 'off'} · ` +
      `simulation ${view.playing ? 'running' : 'paused'}`,
    `- panel icons [${view.barIcons.map((i) => (i === undefined ? '—' : `0x${i.toString(16)}`)).join(', ')}]`,
  );
  if (input.render !== undefined) lines.push(...renderCostLines(input.render));
  lines.push(
    '',
    '## Actions since loading',
    '',
  );
  if (input.actions.length === 0) lines.push('- (none)');
  else {
    for (const a of input.actions) {
      lines.push(
        `- tick ${a.tick}: \`${a.kind}\` ${JSON.stringify(a.detail)}${a.applied ? '' : '  ⟵ REJECTED'}`,
      );
    }
  }
  lines.push(
    '',
    '## Map',
    '',
    // The tile table is NOT in the report — it is regenerated from the seed. These numbers are the
    // guard for that: if the diff grows large for a freshly started game, the generator is broken.
    // Without this line the reconstruction would be a claim.
    ...(map.kind === 'full'
      ? [`- tiles are in the report **unshrunk** — no basis could be built: ${map.reason}`]
      : [
          // FIELD deviations are counted, not tiles — one tile can carry several. The reference is
          // therefore `tiles x fields`; a percentage against the tile count can exceed 100 and says
          // nothing.
          `- generated from the seed: ${map.diff.length} field deviations` +
            ` over ${map.tiles} tiles x ${MAP_FIELD_COUNT} fields` +
            ` (${((100 * map.diff.length) / Math.max(1, map.tiles * MAP_FIELD_COUNT)).toFixed(2)} % of the field values)`,
          `- per field: ${Object.entries(map.stats)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} ${v}`)
            .join(', ') || '(none)'}`,
        ]),
    '',
    '## Replaying',
    '',
    '```ts',
    "const state = loadState(restoreReportState(JSON.parse(readFileSync('state.json', 'utf8'))));",
    'runTicks(state, 1000);',
    '```',
    '',
    '`state.json` carries the map as a seed reference plus deviations (`core/report-state.ts`);',
    '`restoreReportState` rebuilds it. The round trip is lossless — whatever does not match the',
    'generated map is in the diff.',
    '',
    '`actions.json` holds the same commands machine-readable. Replay from the **source** named above,',
    'not from `state.json` (the actions happened before it): for each entry advance to its `tick`,',
    'then `applyCommand`. Not included are input actions that do not go through the command layer yet.',
    '',
  );
  return lines.join('\n');
}

/**
 * Build the package — **compressed** (see `core/zip.ts`). It is async only because
 * `CompressionStream` is; the call path (panel → bus → view) already was.
 *
 * The gain is measured and not small: even after the map diff, `state.json` is largely repetition
 * (JSON field names, zeros) and shrinks by roughly an order of magnitude. `screen.png` stays
 * "stored" — it is already deflate-compressed, and the writer notices that itself.
 */
export async function buildDebugReport(
  input: DebugReportInput,
  now = new Date(),
): Promise<DebugReport> {
  const id = newReportId();
  const report = buildReport(input, id);
  const at = now.getTime();
  const entries: { name: string; data: Uint8Array; modifiedAt: number }[] = [
    { name: 'report.md', data: utf8(report), modifiedAt: at },
    { name: 'state.json', data: utf8(JSON.stringify(reduceReportState(input.state))), modifiedAt: at },
    { name: 'actions.json', data: utf8(JSON.stringify(input.actions, null, 2)), modifiedAt: at },
  ];
  if (input.screenshotDataUrl !== null) {
    const comma = input.screenshotDataUrl.indexOf(',');
    if (comma > 0) {
      entries.push({
        name: 'screen.png',
        data: base64Bytes(input.screenshotDataUrl.slice(comma + 1)),
        modifiedAt: at,
      });
    }
  }
  const bytes = await buildZipDeflated(entries);
  const fileName = `${reportName(id, stamp(now), input.note)}.zip`;
  const url = newIssueUrl(issueTitle(input, id), issueBody(input, id, fileName));
  return { id, fileName, bytes, size: bytes.length, issueUrl: url };
}

/**
 * Body of the prefilled issue: what the reporter WROTE, the attachment box, and a short fingerprint.
 *
 * Deliberately NOT the whole of `report.md`: the same prose lies in the package, and it would bury
 * the one sentence a human typed.
 *
 * TWO PARTS ARE THERE ON PURPOSE, both because of the same fault: the file never gets attached, and
 * that only becomes apparent after the issue has been submitted, when no hint in this application
 * can reach the reporter any more.
 *
 *  - The BOX is the only reminder that survives into the created issue: an unticked box is still
 *    visible there afterwards, for the reporter and for whoever reads the issue. It stands at top
 *    level and not inside a quote, otherwise GitHub renders it but does not let anyone tick it.
 *  - The FINGERPRINT makes a report without its file at least triageable. Without it an unattached
 *    report says no more than "it stutters".
 */
export function issueBody(input: DebugReportInput, id: string, fileName: string): string {
  const h = input.state.header;
  const trimmed = input.note.trim();
  const note =
    trimmed.length > ISSUE_NOTE_LIMIT ? `${trimmed.slice(0, ISSUE_NOTE_LIMIT)}\n…` : trimmed;
  const lines = [
    note.length > 0 ? note : '_(no description)_',
    '',
    `- [ ] \`${fileName}\` attached — drag the file into this issue`,
    '',
    'The package holds the save game, the recorded actions, the screenshot and the render timings.',
    'Without it only the fingerprint below is available.',
    '',
    '### Fingerprint',
    '',
    `- report \`${id}\` · source ${input.sourceFile ?? 'unknown'} · build \`${buildStamp()}\``,
    `- gameTick ${h.tick} · map ${h.mapCols}×${h.mapRows} (mapSize ${h.mapSize})` +
      ` · active players [${input.state.activePlayers.join(', ')}]`,
  ];
  // The seed is the line that makes a report about the MAP checkable, and it is the one fact of the
  // fingerprint that cannot be guessed from anything else. Free play only — for level and mission
  // the map follows from the setup record. Same reasoning as in `report.md`.
  if (h.mapSeed !== undefined) {
    lines.push(
      `- map seed [${h.mapSeed.map((v) => `0x${v.toString(16)}`).join(', ')}]` +
        ` · type in as ${mapSeedInputCode(h.mapSeed).replace(/(.{4})(?=.)/g, '$1 ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** base64 → bytes. `atob` returns characters with code points 0..255, so it reads byte-wise. */
function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** Issue title: the note shortened to one line, with the id behind it. */
export function issueTitle(input: DebugReportInput, id: string): string {
  const first = input.note.split('\n')[0]?.trim() ?? '';
  const short = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return short === '' ? `Bug report ${id}` : `${short} (${id})`;
}

/** Timestamp in the file name — the same shape the former endpoint handed out. */
export function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Name and id of the package live in `report-name.ts` (pure string work, no dependencies) and are
// re-exported here so callers have one address.
export {
  debugSlug,
  newReportId,
  REPORT_ID_LENGTH,
  reportIdOf,
  reportName,
  type RandomBytes,
} from './report-name.js';
