import { describe, it, expect } from 'vitest';
import {
  buildDebugReport,
  debugSlug,
  issueTitle,
  newReportId,
  REPORT_ID_LENGTH,
  reportIdOf,
  reportName,
  type DebugReportInput,
  type RandomBytes,
} from './debug-export.js';
import { readZip } from '../core/zip.js';
import { ISSUE_NOTE_LIMIT, PROJECT_REPO } from '../shell/project.js';
import { REPORT_PHASES } from './render-metrics.js';
import type { SaveGameState } from '../core/types.js';

describe('debugSlug — the note must not build a path', () => {
  it('turns a note into a folder short name', () => {
    expect(debugSlug('Mine baut nicht')).toBe('mine-baut-nicht');
    expect(debugSlug('Bodenvorbereiter läuft nicht los!')).toBe('bodenvorbereiter-laeuft-nicht-los');
  });

  it('strips every bit of path syntax', () => {
    // The short name ends up inside a file name — nothing may survive here that could lead out of
    // the target folder.
    for (const evil of ['../../etc/passwd', '/etc/passwd', 'C:\\Windows', '..', './.ssh/id_rsa']) {
      const slug = debugSlug(evil);
      expect(slug, evil).not.toMatch(/[/\\.:]/);
      expect(slug.startsWith('-'), evil).toBe(false);
    }
  });

  it('an empty or purely exotic note yields the fallback name', () => {
    expect(debugSlug('')).toBe('bericht');
    expect(debugSlug(undefined)).toBe('bericht');
    expect(debugSlug('///')).toBe('bericht');
  });

  it('shortens long notes (the folder name stays manageable)', () => {
    expect(debugSlug('a'.repeat(200)).length).toBe(48);
  });
});

/** A minimal but structurally real state — the report reads across all record lists. */
function fakeState(): SaveGameState {
  const tile = {
    height: 7,
    terrainUp: 5,
    terrainDown: 5,
    object: 2,
    owner: 1,
    paths: 0x02,
    blocked: true,
    mineral: 3,
    resourceAmount: 9,
    objIndex: 48,
    serfIndex: 0,
  };
  return {
    header: {
      mapCols: 4,
      mapRows: 2,
      mapSize: 3,
      tick: 43794,
      rotation: 7,
      rotationWrap: 49,
      random: [1, 2, 3],
    },
    activePlayers: [0, 1],
    playerRecords: [],
    serfs: { recordSize: 16, maxIndex: 1, occupied: [] },
    flags: { recordSize: 70, maxIndex: 1, occupied: [] },
    buildings: { recordSize: 18, maxIndex: 1, occupied: [] },
    inventories: { recordSize: 120, maxIndex: 1, occupied: [] },
    buildingRecords: [
      {
        index: 48,
        col: 1,
        row: 0,
        type: 6,
        typeName: 'CoalMine',
        owner: 0,
        constructing: true,
        progress: 0,
        flag: 12,
        firstKnight: 0,
        active: false,
        burning: false,
        holder: false,
        serfRequested: false,
        serfRequestFailed: true,
        threatLevel: 0,
        playingSfx: false,
        stock: [
          { available: 0, requested: 1 },
          { available: 0, requested: 0 },
        ],
        hasInventory: false,
        inventoryIndex: null,
        level: 7,
        stockMaximum: [5, 0],
      },
    ],
    serfRecords: [],
    flagRecords: [],
    inventoryRecords: [],
    mapTiles: [tile, tile, tile, tile, tile, tile, tile, tile],
    byteLength: 0,
  } as unknown as SaveGameState;
}

function input(over: Partial<DebugReportInput> = {}): DebugReportInput {
  return {
    note: 'Mine baut nicht',
    state: fakeState(),
    actions: [{ tick: 100, kind: 'placeBuilding', detail: { col: 1, row: 0 }, applied: true }],
    screenshotDataUrl: null,
    sourceFile: 'SAVE0.DS',
    view: {
      camX: 10,
      camY: 20,
      zoom: 2,
      viewportW: 800,
      viewportH: 500,
      popupScreen: null,
      previewOpen: false,
      roadBuilding: false,
      playing: true,
      barIcons: [1, 2, 3, 4, 5],
      marked: { col: 1, row: 0 },
    },
    ...over,
  };
}

/**
 * Build a report and OPEN THE PACKAGE AGAIN. Deliberately via `readZip` rather than via the input
 * list: that way it is also checked that a readable ZIP comes out and not merely a buffer.
 */
async function filesOf(over: Partial<DebugReportInput> = {}): Promise<Map<string, string>> {
  const report = await buildDebugReport(input(over));
  const out = new Map<string, string>();
  for (const e of await readZip(report.bytes)) out.set(e.name, new TextDecoder().decode(e.data));
  return out;
}

const mdOf = async (over: Partial<DebugReportInput> = {}): Promise<string> =>
  (await filesOf(over)).get('report.md') ?? '';

describe('buildDebugReport — what actually ends up in the package', () => {
  it('names the map seed of a free map — otherwise it cannot be reproduced', async () => {
    // A question about the MAP GENERATOR cannot be answered without the seed: the map could not be
    // regenerated, neither here nor in the original.
    const st = fakeState();
    const md = await mdOf({
      state: {
        ...st,
        header: { ...st.header, gameType: 4, mapSeed: [0x4b6b, 0x29d7, 0x21c3], mapSizeChoice: 8 },
      } as unknown as SaveGameState,
    });
    expect(md).toContain('map seed [0x4b6b, 0x29d7, 0x21c3]');
    expect(md).toContain('world size 8');
    // The INPUT code, not the displayed one: only it leads back to the same map in the original.
    expect(md).toContain('4375 6838 2345 2552');
  });

  it('a campaign or mission game gets no seed line in the report', async () => {
    // There the seed comes from the setup record; a line reading `undefined` would mislead.
    expect(await mdOf()).not.toContain('map seed');
  });

  /**
   * The render costs are the only part of the report that CANNOT be recomputed from the save game
   * and the action log — they hang off the reporter's machine. The measurement has no readout any
   * more, and this is its only consumer: without this case it would silently fall out at the next
   * refactor.
   */
  it('names the reporter render costs — outlier first', async () => {
    const md = await mdOf({
      render: {
        phases: [
          { phase: 'terrain', median: 2.5, max: 26.5, count: 812 },
          { phase: 'frame', median: 8.25, max: 41.2, count: 812 },
          { phase: 'logic', median: 0.08, max: 0.9, count: 4400 },
        ],
        fps: 12.6,
        rebuildsPerSecond: 0.4,
        ticksPerSecond: 100,
        surface: { width: 1884, height: 891 },
        zoom: 0.23,
        presenter: 'gpu',
      },
    });
    expect(md).toContain('surface 1884×891 = 1.68 M px');
    expect(md).toContain('zoom 23 %');
    expect(md).toContain('12.6 frames/s');
    expect(md).toContain('0.4 full ground rebuilds/s');
    // Which route produced the colour belongs on the same line: `rgba`/`upload`/`scale` measure
    // something different on the GPU route than on the CPU route, and without that note the table
    // below is not comparable between two reports.
    expect(md).toContain('colour: GPU');
    // The outlier comes BEFORE the median — that is what the complaint is about. It is NOT flagged
    // here: at 100 logic ticks/s the port draws 12.5 times a second, so the budget is 80 ms and
    // 41.2 ms is half of it. A fixed 16 ms threshold — from the time when drawing happened on every
    // repaint — used to flag an 18.6 ms frame that was five times inside its budget.
    expect(md).toContain('whole frame: outlier 41.2 ms · median 8.25 ms (n 812)');
    expect(md).not.toContain('⟵ above');
    expect(md).toContain('The **budget** per frame is 80 ms and not 16 ms');
    expect(md).toContain('12.5 times a second');
    expect(md).toContain('ground (retained): outlier 26.5 ms');
    // The logic side belongs with it, together with its reference: a median per call cannot be
    // converted into load without the rate (0.08 ms × 100/s == 0.8 %, the same at 800/s == 6.4 %).
    expect(md).toContain('100 logic ticks/s');
    expect(md).toContain('runTicks (simulation only): outlier 0.90 ms · median 0.08 ms (n 4400)');
    // A phase WITHOUT a measurement is named rather than omitted. A report once lacked both logic
    // lines, and because they simply were not there the gap was indistinguishable from "costs
    // nothing" — it looked like a result. (Pausing for the report dialog does not distort the
    // numbers; that is measured.)
    expect(md).toContain('putImageData: not measured (never ran in this session)');
    expect(md).toContain('logic pump (whole clock callback): not measured');
    // And COMPLETELY: exactly one line per phase, measured or not. Without this count a phase
    // added later could silently fall out again — exactly the old bug.
    const rows = md
      .split('\n')
      .filter((l) => l.startsWith('- ') && /: (outlier|not measured)/.test(l));
    expect(rows).toHaveLength(REPORT_PHASES.length);
  });

  /**
   * The opposite direction of the case above, and the actual claim of the threshold: the budget
   * hangs off the GAME SPEED. At 8x the logic runs at 800 ticks/s, drawing happens 100 times a
   * second, the budget is 10 ms — the very same numbers as above are too slow here. Without this
   * case a threshold that NEVER fires would pass just as well.
   */
  it('flags the same numbers at 8x speed — the budget shrinks with it', async () => {
    const md = await mdOf({
      render: {
          phases: [
            { phase: 'terrain', median: 2.5, max: 26.5, count: 812 },
            { phase: 'frame', median: 8.25, max: 41.2, count: 812 },
          ],
          fps: 100,
          rebuildsPerSecond: 0.4,
          ticksPerSecond: 800,
          surface: { width: 1884, height: 891 },
          zoom: 0.23,
        presenter: 'gpu',
      },
    });
    expect(md).toContain('whole frame: outlier 41.2 ms · median 8.25 ms (n 812)  ⟵ above 10 ms (budget)');
    expect(md).toContain('ground (retained): outlier 26.5 ms · median 2.50 ms (n 812)  ⟵ above 10 ms (budget)');
    expect(md).toContain('The **budget** per frame is 10 ms and not 16 ms');
    expect(md).toContain('100.0 times a second');
  });

  it('no cost section without measurements (instead of a table of zeroes)', async () => {
    expect(await mdOf()).not.toContain('Drawing cost');
  });

  it('packs the three text files; without a screenshot no PNG', async () => {
    expect([...(await filesOf()).keys()]).toEqual(['report.md', 'state.json', 'actions.json']);
  });

  it('puts the PNG into the package decoded — not the `data:` header', async () => {
    const report = await buildDebugReport(input({ screenshotDataUrl: 'data:image/png;base64,QUJD' }));
    const entries = await readZip(report.bytes);
    const png = entries.find((e) => e.name === 'screen.png');
    expect(png).toBeDefined();
    // 'QUJD' is base64 for 'ABC' — the package has to hold the BYTES, not the text.
    expect([...(png?.data ?? [])]).toEqual([0x41, 0x42, 0x43]);
  });

  it('the state travels as JSON and can be read back', async () => {
    const state = JSON.parse((await filesOf()).get('state.json') ?? '{}') as SaveGameState;
    expect(state.header.tick).toBe(43794);
    expect(state.buildingRecords[0]!.index).toBe(48);
  });

  it('the map sits in the package as a diff, not as a tile table', async () => {
    // The reason for the whole rework: at 512x256 the table would be 18.6 MB. The fake state here
    // has eight tiles, so what is checked is the SHAPE — that `mapTiles` no longer appears.
    const json = (await filesOf()).get('state.json') ?? '';
    expect(json).not.toContain('"mapTiles"');
    expect(json).toContain('"map"');
  });

  it('the report answers the questions that would otherwise need a follow-up', async () => {
    const md = await mdOf();
    expect(md).toContain('Mine baut nicht');
    expect(md).toContain('SAVE0.DS');
    expect(md).toContain('gameTick 43794');
    // The marked tile is spelled out — building, construction state and the request bits.
    expect(md).toContain('building #48 CoalMine');
    expect(md).toContain('UNDER CONSTRUCTION (progress 0)');
    expect(md).toContain('serfRequestFailed=true');
    // Interface state the save game does not know about.
    expect(md).toContain('zoom 200 %');
    // And how it got there.
    expect(md).toContain('tick 100: `placeBuilding`');
  });

  it('marks rejected commands visibly (often the interesting case)', async () => {
    const md = await mdOf({ actions: [{ tick: 5, kind: 'buildFlag', detail: {}, applied: false }] });
    expect(md).toContain('REJECTED');
  });

  it('the issue link points at this project and carries the report id', async () => {
    // The address is a CONSTANT, not an environment variable — so this is a value check and not an
    // equivalence any more. Two things have to hold: the link goes to OUR issue tracker (a report
    // must never be aimed at someone else's repository), and it names the id, which is the only
    // handle connecting the prose of the issue to the attached package.
    const report = await buildDebugReport(input());
    expect(report.issueUrl).toContain(`https://github.com/${PROJECT_REPO}/issues/new?`);
    expect(report.issueUrl).toContain(encodeURIComponent(report.id));
    // The form of the constant itself: `owner/name`, nothing that could break out of the URL.
    expect(PROJECT_REPO).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it('the issue body carries the note, the attachment box and the fingerprint — not the report', async () => {
    // The body used to be the whole of `report.md`. That was duplication (the same prose is in the
    // package) and it buried the one sentence a human wrote. Both directions are checked, because
    // only the second one would notice a relapse into "just paste everything in".
    const st = fakeState();
    const report = await buildDebugReport(
      input({
        state: {
          ...st,
          header: { ...st.header, gameType: 4, mapSeed: [0x4b6b, 0x29d7, 0x21c3] },
        } as unknown as SaveGameState,
      }),
    );
    const body = new URL(report.issueUrl).searchParams.get('body') ?? '';
    expect(body).toContain('Mine baut nicht');
    // The reminder that survives into the created issue. Top level, so GitHub lets it be ticked.
    expect(body).toContain(`- [ ] \`${report.fileName}\` attached`);
    expect(body).toMatch(/^- \[ \]/m);
    // Fingerprint: what makes an unattached report triageable at all.
    expect(body).toContain(`- report \`${report.id}\``);
    expect(body).toContain('gameTick');
    expect(body).toContain('map seed [0x4b6b');
    // Gegenrichtung: the report's own sections stay out of the URL.
    expect(body).not.toContain('## Marked spot');
    expect(body).not.toContain('# Debug report');
    expect(report.issueUrl.length).toBeLessThan(2000);
  });

  it('a very long note is clipped — a URL does not carry a novel', async () => {
    const report = await buildDebugReport(input({ note: 'x'.repeat(ISSUE_NOTE_LIMIT + 500) }));
    const body = new URL(report.issueUrl).searchParams.get('body') ?? '';
    expect(body).toContain('…');
    expect(body.indexOf('- [ ]')).toBeGreaterThan(ISSUE_NOTE_LIMIT);
    expect(body).not.toContain('x'.repeat(ISSUE_NOTE_LIMIT + 1));
  });

  it('the note lands hardened in the file name', async () => {
    const report = await buildDebugReport(input({ note: '../../weg damit' }));
    expect(report.fileName).toMatch(/^[0-9a-z]{8}-\d{4}-\d{2}-\d{2}-\d{6}-weg-damit\.zip$/);
    expect(reportIdOf(report.fileName)).toBe(report.id);
  });

  it('the issue title carries the note and the id', () => {
    expect(issueTitle(input(), 'k7m2q9xf')).toBe('Mine baut nicht (k7m2q9xf)');
    expect(issueTitle(input({ note: '' }), 'k7m2q9xf')).toBe('Bug report k7m2q9xf');
    // Multi-line note: only the first line, otherwise the title falls apart.
    expect(issueTitle(input({ note: 'kurz\nlang und mehr' }), 'k7m2q9xf')).toBe('kurz (k7m2q9xf)');
  });
});

describe('report ids', () => {
  const stamp = '2026-08-19-134500';
  /** Every byte value 0..255 in order, chunked into id-sized pieces. */
  const sweep = (): string => {
    let out = '';
    for (let i = 0; i < 256; i += REPORT_ID_LENGTH) {
      const chunk: RandomBytes = () =>
        Uint8Array.from({ length: REPORT_ID_LENGTH }, (_, k) => i + k);
      out += newReportId(chunk);
    }
    return out;
  };

  it('reads the id back out of the package name it built itself', () => {
    // The actual point: pattern and assembly must not drift apart — not even for a note that
    // itself looks like a timestamp. Over real ids, so the test does not merely check a hand-
    // written example.
    for (let i = 0; i < 200; i++) {
      const id = newReportId();
      expect(reportIdOf(reportName(id, stamp, 'Mine baut nicht'))).toBe(id);
      expect(reportIdOf(reportName(id, stamp, '2026-08-19-000000-x'))).toBe(id);
      expect(reportIdOf(reportName(id, stamp, undefined))).toBe(id);
    }
  });

  it('ignores foreign names', () => {
    for (const name of [
      'captures',
      '2026-08-19-134500-alt',
      '.git',
      // Old counter-style names are not ours any more — they are too short for an id.
      '0007-2026-08-19-134500-x',
    ]) {
      expect(reportIdOf(name)).toBeNull();
    }
  });

  it('hands out random ids instead of sequential numbers', () => {
    // Why at all: a sequential number is derived from what is already there, jumps back when old
    // reports are cleaned up, and then names two different reports the same.
    const ids = new Set(Array.from({ length: 2000 }, () => newReportId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toHaveLength(REPORT_ID_LENGTH);
  });

  it('uses the alphabet without modulo bias and without confusable characters', () => {
    // 256 is a multiple of 32: across all byte values EVERY character has to come up exactly eight
    // times. With an alphabet that does not divide 256 (26, 36, 62 …) the first ones would win.
    const counts = new Map<string, number>();
    for (const c of sweep()) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect([...counts.values()]).toEqual(Array.from({ length: 32 }, () => 8));
    // i/l/o/u are missing on purpose (1/l, 0/o) — an id gets read aloud and typed back.
    expect([...counts.keys()].sort().join('')).toBe('0123456789abcdefghjkmnpqrstvwxyz');
  });
});
