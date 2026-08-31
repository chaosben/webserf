/**
 * Converter: XMI (Miles Extended MIDI, IFF based) -> Standard MIDI File (SMF) type 0.
 *
 * Enough for the game's XMI files (music in the asset archive, intro XMIs on disk). Not for arbitrary
 * XMIs — multi-FORM containers are merged, and some meta events are carried over without being
 * interpreted.
 *
 * Format in brief:
 *
 *   container: IFF style 4-byte id + u32 BE size + payload (padded to an even length).
 *     FORM <type>{INFO,TIMB,EVNT,...}
 *     CAT  <type>{FORM,...}                  (concatenation of equal sub types)
 *
 *   INFO (2 bytes): u16 LE track_count.
 *   TIMB (2 + n*2 bytes): u16 LE count, then count x (u8 patch, u8 bank).
 *
 *   EVNT: stream of delta bytes + MIDI events.
 *     delta:         bytes without the high bit (0x00..0x7F), summed until the next status.
 *     channel event: status byte (>= 0x80, < 0xF0).
 *       0x80,0xA0,0xB0,0xE0 -> 2 data bytes
 *       0xC0,0xD0           -> 1 data byte
 *       0x90 (note on)      -> 2 data bytes + VLQ note duration
 *                              -> synthetic note off (note on vel=0) at time+duration.
 *     meta event:    0xFF type len data — tempo (0x51) is kept as the timing reference.
 *
 *   XMI tick rate: fixed 120 Hz. In the SMF this is rebuilt via MThd `division = tempo*3/25000` plus
 *   an embedded tempo meta event, so a synth gets the same wall clock.
 *
 *   Default tempo if the file supplies none: 500000 us/beat (120 BPM, the SMF default).
 */

const DEFAULT_TEMPO = 500_000;
const XMI_TICK_HZ = 120;
const MICROSECONDS_PER_SECOND = 1_000_000;

export interface XmiMidiEvent {
  /** Absolute time in XMI ticks (120 Hz). */
  readonly time: number;
  /** Stable order for events at the same time. */
  readonly index: number;
  /** MIDI status byte (including the channel nibble). */
  readonly status: number;
  /** First data byte (pitch / controller number / program / meta sub type ...). */
  readonly data1: number;
  /** Second data byte (velocity / controller value / meta length). 0 if absent. */
  readonly data2: number;
  /** Meta events only (status 0xFF): the `data2` payload bytes. */
  readonly metaBytes?: Uint8Array;
}

export interface ParsedXmi {
  /** Track count from the INFO chunk (informational; all tracks are merged into one). */
  readonly trackCount: number;
  /** First tempo from FF 51 03 as us/beat. */
  readonly tempoMicrosPerBeat: number;
  /** Event list sorted by time, then by insertion order. */
  readonly events: readonly XmiMidiEvent[];
  /** Last tick position — the length of the piece. */
  readonly totalTicks: number;
}

/** Reads an IFF container and all MIDI events in it. */
export function parseXmi(input: Uint8Array | ArrayBuffer | ArrayBufferView): ParsedXmi {
  const bytes = toUint8(input);
  const ctx: ParseCtx = {
    events: [],
    nextIndex: 0,
    trackCount: 1,
    tempoMicrosPerBeat: 0,
  };
  walkChunks(bytes, 0, bytes.byteLength, ctx);

  const events = ctx.events.slice().sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return a.index - b.index;
  });

  const totalTicks = events.length === 0 ? 0 : events[events.length - 1]!.time;

  return {
    trackCount: ctx.trackCount,
    tempoMicrosPerBeat: ctx.tempoMicrosPerBeat || DEFAULT_TEMPO,
    events,
    totalTicks,
  };
}

/**
 * Direct path from XMI bytes to a standard MIDI file (type 0, one track). The result can be fed to a
 * software synth as is.
 */
export function xmiToSmf(input: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  return buildSmf(parseXmi(input));
}

/** Wall-clock duration of a parsed XMI stream, in seconds. */
export function xmiDurationSec(parsed: ParsedXmi): number {
  return parsed.totalTicks / XMI_TICK_HZ;
}

// ---------------------------------------------------------------------------
// IFF walker
// ---------------------------------------------------------------------------

interface ParseCtx {
  events: XmiMidiEvent[];
  nextIndex: number;
  trackCount: number;
  /** us/beat, 0 = none seen yet. */
  tempoMicrosPerBeat: number;
}

function walkChunks(bytes: Uint8Array, start: number, end: number, ctx: ParseCtx): void {
  let p = start;
  while (p < end) {
    if (p + 8 > end) {
      throw new Error(`XMI: chunk header does not fit (offset ${p}, end ${end}).`);
    }
    const id = readId(bytes, p);
    const size = readU32BE(bytes, p + 4);
    const dataStart = p + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > end) {
      throw new Error(
        `XMI: chunk '${id}' at offset ${p} exceeds its container (size=${size}, ` +
          `dataEnd=${dataEnd}, containerEnd=${end}).`,
      );
    }

    handleChunk(id, bytes, dataStart, dataEnd, ctx);

    // IFF chunks pad to an even length.
    const advance = 8 + size + (size & 1);
    p += advance;
  }
}

function handleChunk(
  id: string,
  bytes: Uint8Array,
  dataStart: number,
  dataEnd: number,
  ctx: ParseCtx,
): void {
  switch (id) {
    case 'FORM':
    case 'CAT ': {
      // The first 4 bytes are the sub type (e.g. "XDIR", "XMID"); skip it and treat the rest as
      // nested chunks.
      if (dataEnd - dataStart < 4) {
        throw new Error(`XMI: '${id}' without a sub type.`);
      }
      walkChunks(bytes, dataStart + 4, dataEnd, ctx);
      return;
    }
    case 'INFO': {
      const size = dataEnd - dataStart;
      if (size === 2) {
        ctx.trackCount = readU16LE(bytes, dataStart);
      }
      return;
    }
    case 'TIMB': {
      // Patch/bank list — not interpreted here; the synth handles it via program changes.
      return;
    }
    case 'EVNT': {
      parseEvents(bytes, dataStart, dataEnd, ctx);
      return;
    }
    default:
      // Ignore unknown chunks (RBRN for branch points and the like) — the game does not use them.
      return;
  }
}

// ---------------------------------------------------------------------------
// EVNT stream
// ---------------------------------------------------------------------------

function parseEvents(bytes: Uint8Array, start: number, end: number, ctx: ParseCtx): void {
  let p = start;
  let time = 0;

  while (p < end) {
    const byte = bytes[p++]!;

    if ((byte & 0x80) === 0) {
      time += byte;
      continue;
    }

    const status = byte;
    const high = status & 0xf0;

    switch (high) {
      case 0x80: // note off
      case 0xa0: // polyphonic aftertouch
      case 0xb0: // controller
      case 0xe0: {
        // pitch bend
        const d1 = readByte(bytes, p++, end);
        const d2 = readByte(bytes, p++, end);
        ctx.events.push({
          time,
          index: ctx.nextIndex++,
          status,
          data1: d1,
          data2: d2,
        });
        break;
      }
      case 0x90: {
        // note on + XMI note duration (VLQ).
        const note = readByte(bytes, p++, end);
        const velocity = readByte(bytes, p++, end);
        ctx.events.push({
          time,
          index: ctx.nextIndex++,
          status,
          data1: note,
          data2: velocity,
        });
        const vlq = readVlq(bytes, p, end);
        p = vlq.next;
        ctx.events.push({
          time: time + vlq.value,
          index: ctx.nextIndex++,
          status,
          data1: note,
          data2: 0, // vel=0 == note off in the MIDI running-status convention
        });
        break;
      }
      case 0xc0: // program change
      case 0xd0: {
        // channel pressure
        const d1 = readByte(bytes, p++, end);
        ctx.events.push({
          time,
          index: ctx.nextIndex++,
          status,
          data1: d1,
          data2: 0,
        });
        break;
      }
      case 0xf0: {
        if (status !== 0xff) {
          throw new Error(
            `XMI: status byte 0x${status.toString(16).toUpperCase()} (sysex/escape) ` +
              `is not supported.`,
          );
        }
        const metaType = readByte(bytes, p++, end);
        const metaLen = readByte(bytes, p++, end);
        if (p + metaLen > end) {
          throw new Error(
            `XMI: meta event 0x${metaType.toString(16).toUpperCase()} too long ` +
              `(len=${metaLen}, remaining=${end - p}).`,
          );
        }
        const payload = bytes.slice(p, p + metaLen);
        p += metaLen;

        if (metaType === 0x51 && ctx.tempoMicrosPerBeat === 0 && metaLen === 3) {
          ctx.tempoMicrosPerBeat = (payload[0]! << 16) | (payload[1]! << 8) | payload[2]!;
        }

        ctx.events.push({
          time,
          index: ctx.nextIndex++,
          status: 0xff,
          data1: metaType,
          data2: metaLen,
          metaBytes: payload,
        });
        break;
      }
      default:
        throw new Error(
          `XMI: unknown status byte 0x${status.toString(16).toUpperCase()} at offset ${p - 1}.`,
        );
    }
  }
}

// ---------------------------------------------------------------------------
// SMF writer
// ---------------------------------------------------------------------------

export function buildSmf(parsed: ParsedXmi): Uint8Array {
  const division = Math.max(
    1,
    Math.floor((parsed.tempoMicrosPerBeat * XMI_TICK_HZ) / MICROSECONDS_PER_SECOND),
  );
  // Derivation: synth tick rate = division * 1e6 / tempo ticks per second. Target = 120 Hz.
  // => division = tempo * 120 / 1e6 (identical to the formula tempo*3/25000).

  const track = encodeTrack(parsed.events);

  const out = new Uint8Array(14 + 8 + track.byteLength);
  let p = 0;
  p = writeAscii(out, p, 'MThd');
  p = writeU32BE(out, p, 6);
  p = writeU16BE(out, p, 0); // SMF Type 0
  p = writeU16BE(out, p, 1); // 1 track
  p = writeU16BE(out, p, division);

  p = writeAscii(out, p, 'MTrk');
  p = writeU32BE(out, p, track.byteLength);
  out.set(track, p);
  return out;
}

function encodeTrack(events: readonly XmiMidiEvent[]): Uint8Array {
  const chunks: number[][] = [];
  let lastTime = 0;
  let sawEndOfTrack = false;

  for (const ev of events) {
    const delta: number[] = [];
    encodeVlq(ev.time - lastTime, delta);
    lastTime = ev.time;

    if (ev.status === 0xff) {
      const meta: number[] = [];
      meta.push(0xff, ev.data1);
      encodeVlq(ev.data2, meta);
      if (ev.metaBytes) {
        for (let i = 0; i < ev.metaBytes.byteLength; i++) meta.push(ev.metaBytes[i]!);
      }
      chunks.push([...delta, ...meta]);
      if (ev.data1 === 0x2f) sawEndOfTrack = true;
      continue;
    }

    const high = ev.status & 0xf0;
    if (high === 0xc0 || high === 0xd0) {
      chunks.push([...delta, ev.status, ev.data1]);
    } else {
      chunks.push([...delta, ev.status, ev.data1, ev.data2]);
    }
  }

  if (!sawEndOfTrack) {
    // FF 2F 00 — end-of-track meta. Required for a valid SMF.
    chunks.push([0x00, 0xff, 0x2f, 0x00]);
  }

  // Flatten into a Uint8Array.
  let total = 0;
  for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) buf[p++] = c[i]!;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function readByte(bytes: Uint8Array, p: number, end: number): number {
  if (p >= end) throw new Error('XMI: unexpected end while parsing an event.');
  return bytes[p]!;
}

function readU16LE(bytes: Uint8Array, p: number): number {
  return bytes[p]! | (bytes[p + 1]! << 8);
}

function readU32BE(bytes: Uint8Array, p: number): number {
  // >>> 0 -> unsigned for values > 2^31.
  return (
    ((bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!) >>> 0
  );
}

function readId(bytes: Uint8Array, p: number): string {
  return String.fromCharCode(bytes[p]!, bytes[p + 1]!, bytes[p + 2]!, bytes[p + 3]!);
}

interface VlqResult {
  readonly value: number;
  readonly next: number;
}

function readVlq(bytes: Uint8Array, p: number, end: number): VlqResult {
  let value = 0;
  let next = p;
  for (;;) {
    if (next >= end) throw new Error('XMI: unexpected end while parsing a VLQ.');
    const b = bytes[next++]!;
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return { value, next };
    if (next - p > 4) {
      // VLQs longer than 4 bytes are not allowed in an SMF.
      throw new Error('XMI: VLQ exceeds 4 bytes.');
    }
  }
}

function encodeVlq(value: number, out: number[]): void {
  if (value < 0) throw new Error(`SMF: negative delta value ${value}.`);
  if (value === 0) {
    out.push(0);
    return;
  }
  const stack: number[] = [];
  let v = value;
  stack.push(v & 0x7f);
  v >>>= 7;
  while (v > 0) {
    stack.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]!);
}

function writeAscii(out: Uint8Array, p: number, s: string): number {
  for (let i = 0; i < s.length; i++) out[p++] = s.charCodeAt(i);
  return p;
}

function writeU16BE(out: Uint8Array, p: number, v: number): number {
  out[p++] = (v >>> 8) & 0xff;
  out[p++] = v & 0xff;
  return p;
}

function writeU32BE(out: Uint8Array, p: number, v: number): number {
  out[p++] = (v >>> 24) & 0xff;
  out[p++] = (v >>> 16) & 0xff;
  out[p++] = (v >>> 8) & 0xff;
  out[p++] = v & 0xff;
  return p;
}

function toUint8(input: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}
