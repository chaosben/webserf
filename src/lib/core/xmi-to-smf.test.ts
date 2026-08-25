import { describe, it, expect } from 'vitest';
import { parseXmi, xmiToSmf, buildSmf, xmiDurationSec } from './xmi-to-smf.js';
import { readOriginal } from '../testing/originals.js';

function loadOrigFile(name: string): Uint8Array | null {
  const raw = readOriginal(name);
  return raw === null ? null : new Uint8Array(raw);
}

// ---------------------------------------------------------------------------
// Synthetic XMI bytes — hand-built, deterministic, no dependency on original files.
// ---------------------------------------------------------------------------

function makeChunk(id: string, payload: Uint8Array): Uint8Array {
  if (id.length !== 4) throw new Error('chunk id muss 4 Zeichen lang sein');
  const padded = payload.byteLength + (payload.byteLength & 1);
  const out = new Uint8Array(8 + padded);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  out[4] = (payload.byteLength >>> 24) & 0xff;
  out[5] = (payload.byteLength >>> 16) & 0xff;
  out[6] = (payload.byteLength >>> 8) & 0xff;
  out[7] = payload.byteLength & 0xff;
  out.set(payload, 8);
  return out;
}

function makeContainer(id: 'FORM' | 'CAT ', subType: string, children: Uint8Array[]): Uint8Array {
  if (subType.length !== 4) throw new Error('subType muss 4 Zeichen lang sein');
  let total = 4;
  for (const c of children) total += c.byteLength;
  const payload = new Uint8Array(total);
  for (let i = 0; i < 4; i++) payload[i] = subType.charCodeAt(i);
  let p = 4;
  for (const c of children) {
    payload.set(c, p);
    p += c.byteLength;
  }
  return makeChunk(id, payload);
}

function makeInfo(trackCount: number): Uint8Array {
  return makeChunk('INFO', new Uint8Array([trackCount & 0xff, (trackCount >>> 8) & 0xff]));
}

function makeTimb(entries: ReadonlyArray<{ patch: number; bank: number }>): Uint8Array {
  const payload = new Uint8Array(2 + entries.length * 2);
  payload[0] = entries.length & 0xff;
  payload[1] = (entries.length >>> 8) & 0xff;
  for (let i = 0; i < entries.length; i++) {
    payload[2 + i * 2] = entries[i]!.patch;
    payload[3 + i * 2] = entries[i]!.bank;
  }
  return makeChunk('TIMB', payload);
}

function makeEvnt(eventBytes: ReadonlyArray<number>): Uint8Array {
  return makeChunk('EVNT', new Uint8Array(eventBytes));
}

/**
 * Wraps EVNT (and optionally further sub-chunks) as a complete, well-formed XMI:
 * FORM XDIR INFO CAT XMID FORM XMID [TIMB] EVNT
 */
function makeSettlersStyleXmi(
  eventBytes: ReadonlyArray<number>,
  opts: { trackCount?: number; timb?: ReadonlyArray<{ patch: number; bank: number }> } = {},
): Uint8Array {
  const subChunks: Uint8Array[] = [];
  if (opts.timb) subChunks.push(makeTimb(opts.timb));
  subChunks.push(makeEvnt(eventBytes));

  const xdir = makeContainer('FORM', 'XDIR', [makeInfo(opts.trackCount ?? 1)]);
  const xmidForm = makeContainer('FORM', 'XMID', subChunks);
  const cat = makeContainer('CAT ', 'XMID', [xmidForm]);

  const out = new Uint8Array(xdir.byteLength + cat.byteLength);
  out.set(xdir, 0);
  out.set(cat, xdir.byteLength);
  return out;
}

function vlq(value: number): number[] {
  if (value === 0) return [0];
  const stack: number[] = [];
  let v = value;
  stack.push(v & 0x7f);
  v >>>= 7;
  while (v > 0) {
    stack.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return stack.reverse();
}

// ---------------------------------------------------------------------------
// Tests: Parser
// ---------------------------------------------------------------------------

describe('parseXmi — Container-Layout', () => {
  it('akzeptiert FORM XDIR + CAT XMID + FORM XMID + EVNT', () => {
    const xmi = makeSettlersStyleXmi([
 // Delta 0, Note-On Kanal 1, Note 60, Velocity 100, Duration 0
      0x00,
      0x91,
      60,
      100,
      0x00,
    ]);
    const parsed = parseXmi(xmi);
    expect(parsed.trackCount).toBe(1);
    expect(parsed.events.length).toBeGreaterThan(0);
  });

  it('reads trackCount from INFO', () => {
    const xmi = makeSettlersStyleXmi([], { trackCount: 3 });
    expect(parseXmi(xmi).trackCount).toBe(3);
  });

  it('toleriert TIMB-Chunk (ignoriert ihn)', () => {
    const xmi = makeSettlersStyleXmi([], {
      timb: [
        { patch: 0, bank: 0 },
        { patch: 1, bank: 2 },
      ],
    });
    const parsed = parseXmi(xmi);
    expect(parsed.trackCount).toBe(1);
    expect(parsed.events.length).toBe(0);
  });

  it('handles padding for an odd-sized chunk', () => {
 // Odd-length payload (1 byte = a single delta 0 = means nothing, but the chunk is valid
 // anyway). The trailing pad byte must be skipped cleanly.
    const xmi = makeSettlersStyleXmi([0x00]);
    expect(() => parseXmi(xmi)).not.toThrow();
  });

  it('throws for a chunk that overruns the container', () => {
 // Hand-built broken IFF: the chunk header claims 999 bytes, the buffer holds 0.
    const bad = new Uint8Array(8);
    bad[0] = 'F'.charCodeAt(0);
    bad[1] = 'O'.charCodeAt(0);
    bad[2] = 'R'.charCodeAt(0);
    bad[3] = 'M'.charCodeAt(0);
    bad[4] = 0;
    bad[5] = 0;
    bad[6] = 0x03;
    bad[7] = 0xe7; // 999
    expect(() => parseXmi(bad)).toThrow();
  });
});

describe('parseXmi — Event-Stream', () => {
  it('sums several delta bytes into the absolute time', () => {
    const xmi = makeSettlersStyleXmi([
 // delta = 50 + 70 = 120, then controller change
      50,
      70,
      0xb1,
      0x07,
      127,
    ]);
    const parsed = parseXmi(xmi);
    const cc = parsed.events.find((e) => (e.status & 0xf0) === 0xb0);
    expect(cc).toBeDefined();
    expect(cc!.time).toBe(120);
    expect(cc!.data1).toBe(0x07);
    expect(cc!.data2).toBe(127);
  });

  it('zerlegt Note-On + Duration in Note-On + synthetisches Note-Off', () => {
    const xmi = makeSettlersStyleXmi([
      0x00,
      0x90,
      60,
      100,
      ...vlq(48), // Duration 48 Ticks
    ]);
    const parsed = parseXmi(xmi);
    const noteOns = parsed.events.filter((e) => (e.status & 0xf0) === 0x90);
    expect(noteOns).toHaveLength(2);
    expect(noteOns[0]!.time).toBe(0);
    expect(noteOns[0]!.data2).toBe(100);
    expect(noteOns[1]!.time).toBe(48);
    expect(noteOns[1]!.data2).toBe(0);
  });

  it('parses the VLQ duration correctly for multi-byte values', () => {
 // VLQ 0x81 0x00 = 128
    const xmi = makeSettlersStyleXmi([0x00, 0x90, 60, 100, 0x81, 0x00]);
    const parsed = parseXmi(xmi);
    const noteOff = parsed.events.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 === 0);
    expect(noteOff).toHaveLength(1);
    expect(noteOff[0]!.time).toBe(128);
  });

  it('extrahiert Tempo-Meta (FF 51 03) als µs/Beat', () => {
 // 500000 µs = 0x07A120 → 07 A1 20
    const xmi = makeSettlersStyleXmi([0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]);
    const parsed = parseXmi(xmi);
    expect(parsed.tempoMicrosPerBeat).toBe(0x07a120);
  });

  it('falls back to DEFAULT_TEMPO (500000) when no tempo is present', () => {
    const xmi = makeSettlersStyleXmi([]);
    expect(parseXmi(xmi).tempoMicrosPerBeat).toBe(500_000);
  });

  it('reads a program change (status C0) with only one data byte', () => {
    const xmi = makeSettlersStyleXmi([0x00, 0xc1, 42]);
    const parsed = parseXmi(xmi);
    const pc = parsed.events.find((e) => (e.status & 0xf0) === 0xc0);
    expect(pc).toBeDefined();
    expect(pc!.data1).toBe(42);
    expect(pc!.data2).toBe(0);
  });

  it('wirft bei Sysex/Escape (F0/F7)', () => {
    const xmi = makeSettlersStyleXmi([0x00, 0xf0]);
    expect(() => parseXmi(xmi)).toThrow(/Sysex|Escape/);
  });

  it('sorts events by time, then by insertion order', () => {
 // Two note-ons of different duration — the later is overtaken by the earlier, but the
 // original note-ons must stay in insertion order at time=0.
    const xmi = makeSettlersStyleXmi([
      0x00,
      0x91,
      60,
      100,
      ...vlq(100), // Note-Off bei 100
      0x00,
      0x91,
      64,
      100,
      ...vlq(50), // Note-Off bei 50
    ]);
    const parsed = parseXmi(xmi);
    const times = parsed.events.map((e) => e.time);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    }
  });

  it('computes totalTicks from the last event', () => {
    const xmi = makeSettlersStyleXmi([0x00, 0x91, 60, 100, ...vlq(240)]);
    const parsed = parseXmi(xmi);
    expect(parsed.totalTicks).toBe(240);
  });

  it('xmiDurationSec accounts for the 120 Hz tick rate', () => {
    const xmi = makeSettlersStyleXmi([0x00, 0x91, 60, 100, ...vlq(240)]);
    const parsed = parseXmi(xmi);
    expect(xmiDurationSec(parsed)).toBeCloseTo(240 / 120, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: SMF-Writer
// ---------------------------------------------------------------------------

describe('xmiToSmf / buildSmf', () => {
  it('writes a valid MThd header (type 0, 1 track)', () => {
    const xmi = makeSettlersStyleXmi([0x00, 0x91, 60, 100, ...vlq(48)]);
    const smf = xmiToSmf(xmi);
    expect(String.fromCharCode(...smf.slice(0, 4))).toBe('MThd');
 // size (4..8) = 6
    expect(smf[7]).toBe(6);
 // format (8..10) = 0
    expect((smf[8]! << 8) | smf[9]!).toBe(0);
 // ntrks (10..12) = 1
    expect((smf[10]! << 8) | smf[11]!).toBe(1);
 // division > 0
    const division = (smf[12]! << 8) | smf[13]!;
    expect(division).toBeGreaterThan(0);
  });

  it('schreibt MTrk-Header direkt nach MThd', () => {
    const smf = xmiToSmf(makeSettlersStyleXmi([0x00, 0x91, 60, 100, ...vlq(48)]));
    expect(String.fromCharCode(...smf.slice(14, 18))).toBe('MTrk');
 // MTrk-Size kommt als BE-u32
    const trkSize =
      ((smf[18]! << 24) | (smf[19]! << 16) | (smf[20]! << 8) | smf[21]!) >>> 0;
    expect(trkSize).toBeGreaterThan(0);
    expect(smf.byteLength).toBe(14 + 8 + trkSize);
  });

  it('appends end-of-track automatically when it is missing', () => {
    const smf = xmiToSmf(makeSettlersStyleXmi([0x00, 0x91, 60, 100, ...vlq(48)]));
 // Letzte 3 Bytes sollen FF 2F 00 sein
    expect(smf[smf.byteLength - 3]).toBe(0xff);
    expect(smf[smf.byteLength - 2]).toBe(0x2f);
    expect(smf[smf.byteLength - 1]).toBe(0x00);
  });

  it('uses division = tempo * 3 / 25000', () => {
    const tempo = 500_000;
    const xmi = makeSettlersStyleXmi([
      0x00,
      0xff,
      0x51,
      0x03,
      (tempo >>> 16) & 0xff,
      (tempo >>> 8) & 0xff,
      tempo & 0xff,
    ]);
    const smf = buildSmf(parseXmi(xmi));
    const division = (smf[12]! << 8) | smf[13]!;
    expect(division).toBe(60); // 500000 * 3 / 25000
  });

  it('a program change in the track has only one data byte', () => {
    const smf = xmiToSmf(makeSettlersStyleXmi([0x00, 0xc1, 42]));
 // Search for 0xC1 inside the MTrk area
    const trkStart = 22;
    let foundAt = -1;
    for (let i = trkStart; i < smf.byteLength; i++) {
      if (smf[i] === 0xc1) {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThan(0);
    expect(smf[foundAt + 1]).toBe(42);
 // Right after it comes either the next event's delta or FF 2F 00 (end-of-track).
    expect(smf[foundAt + 2]).toBe(0x00);
  });
});

// ---------------------------------------------------------------------------
// Fixture tests against original files (only when present)
// ---------------------------------------------------------------------------

describe('parseXmi / xmiToSmf — against the original *.XMI', () => {
  for (const name of ['ADLINTRO.XMI', 'MPUINTRO.XMI']) {
    const raw = loadOrigFile(name);
    if (raw === null) {
      it.skip(`${name} (file missing — test skipped)`, () => {});
      continue;
    }

    it(`${name}: parses, has note-ons, has tempo`, () => {
      const parsed = parseXmi(raw);
      expect(parsed.events.length).toBeGreaterThan(0);
      const noteOns = parsed.events.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
      expect(noteOns.length).toBeGreaterThan(10);
      expect(parsed.tempoMicrosPerBeat).toBeGreaterThan(0);
    });

    it(`${name}: SMF starts with MThd and contains MTrk`, () => {
      const smf = xmiToSmf(raw);
      expect(String.fromCharCode(...smf.slice(0, 4))).toBe('MThd');
      expect(String.fromCharCode(...smf.slice(14, 18))).toBe('MTrk');
    });

    it(`${name}: SMF ends with FF 2F 00`, () => {
      const smf = xmiToSmf(raw);
      expect(smf[smf.byteLength - 3]).toBe(0xff);
      expect(smf[smf.byteLength - 2]).toBe(0x2f);
      expect(smf[smf.byteLength - 1]).toBe(0x00);
    });
  }
});
