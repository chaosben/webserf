/**
 * **A minimal ZIP writer and reader** — just enough for the two packages the application builds: the
 * save-game bundle and the bug report.
 *
 * **Why hand-written and not a package.** The format part is small: three record kinds with fixed
 * fields plus CRC-32. Compression itself is the runtime's job (`CompressionStream`), so a packer
 * dependency would be larger than this module and gain nothing.
 *
 * **There are two writers, and the difference is intent, not optimisation:**
 *
 *  - {@link buildZip} — synchronous, "stored" only. For the **save bundle**: the contents are meant
 *    to land unchanged in a DOSBox directory, and that path may stay synchronous.
 *  - {@link buildZipDeflated} — asynchronous, compresses **per entry**. For the **bug report**, whose
 *    `state.json` is largely repetition and shrinks by roughly an order of magnitude.
 *
 * The second one is async because `CompressionStream` is — that is the only reason, and why the
 * first one stays instead of merging both.
 *
 * **Per entry the smaller result wins.** A PNG is already deflate-compressed; packing it a second
 * time makes it bigger. So the writer compares and falls back to "stored" — measurable on the report,
 * not mere caution.
 *
 * **Both are read** — "stored" and "deflate" — because a user may repack the bundle with the
 * operating system. Unpacking uses `DecompressionStream('deflate-raw')`; if it is missing the reader
 * says so instead of returning garbage.
 *
 * **Reading goes through the central directory**, not the local headers. The trap: with flag bit 3
 * set, size and checksum are 0 in the local header and only follow **behind** the data (data
 * descriptor). The central directory always carries the values.
 *
 * Deliberately unsupported: ZIP64, encryption, multi-part archives. The reader reports them.
 */

/** One file in the package. `modifiedAt` is Unix ms; 0 == no timestamp. */
export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly modifiedAt: number;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_SIZE = 22;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3, the polynomial ZIP demands). The table is built on first call. */
export function crc32(data: Uint8Array): number {
  if (crcTable === null) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    crcTable = t;
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Time and date in MS-DOS form, as ZIP carries them: seconds in steps of two, year from 1980. Both
 * are **local** time without a zone — a property of the format, so a package travelling across zones
 * shows different times. Irrelevant for our sync, which uses the store's timestamps, not the package.
 */
function dosStamp(ms: number): { time: number; date: number } {
  const d = new Date(ms > 0 ? ms : Date.now());
  const year = Math.max(1980, d.getFullYear()) - 1980;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Counterpart to {@link dosStamp}: MS-DOS time/date back to Unix ms (local time). */
function fromDosStamp(time: number, date: number): number {
  const day = date & 0x1f;
  const month = (date >> 5) & 0xf;
  const year = 1980 + (date >> 9);
  if (day === 0 || month === 0) return 0; // unset — do not guess
  return new Date(
    year,
    month - 1,
    day,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  ).getTime();
}

/** An entry whose payload is final — the writer does not touch it again. */
interface Packed {
  readonly name: Uint8Array;
  /** What goes into the file: either the raw data or its deflate stream. */
  readonly payload: Uint8Array;
  readonly method: number;
  readonly crc: number;
  /** Length of the **uncompressed** data — the format carries it separately. */
  readonly size: number;
  readonly modifiedAt: number;
}

/** Take the raw data without compression. */
function packStored(e: ZipEntry, name: Uint8Array): Packed {
  return {
    name,
    payload: e.data,
    method: METHOD_STORED,
    crc: crc32(e.data),
    size: e.data.length,
    modifiedAt: e.modifiedAt,
  };
}

/**
 * **Record building lives in one place.** Both writers differ only in the payload they hand over —
 * with their own header fields the deflate branch would be a second chance to get an offset wrong,
 * and such a bug only shows up in a foreign unpacker.
 */
function writeZip(packed: readonly Packed[]): Uint8Array {
  let size = EOCD_SIZE;
  for (const p of packed) {
    size += 30 + p.name.length + p.payload.length; // lokaler Kopf + Name + Daten
    size += 46 + p.name.length; // Verzeichnis-Eintrag
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const u16 = (at: number, v: number) => view.setUint16(at, v, true);
  const u32 = (at: number, v: number) => view.setUint32(at, v >>> 0, true);

  const offsets: number[] = [];
  let at = 0;
  for (const p of packed) {
    const { time, date } = dosStamp(p.modifiedAt);
    offsets.push(at);
    u32(at, LOCAL_SIG);
    u16(at + 4, 20); // required version 2.0 — covers "stored" and "deflate"
    u16(at + 6, 0); // no flags: no data descriptor, no encryption
    u16(at + 8, p.method);
    u16(at + 10, time);
    u16(at + 12, date);
    u32(at + 14, p.crc);
    u32(at + 18, p.payload.length);
    u32(at + 22, p.size);
    u16(at + 26, p.name.length);
    u16(at + 28, 0);
    out.set(p.name, at + 30);
    out.set(p.payload, at + 30 + p.name.length);
    at += 30 + p.name.length + p.payload.length;
  }

  const cdStart = at;
  for (let i = 0; i < packed.length; i++) {
    const p = packed[i]!;
    const { time, date } = dosStamp(p.modifiedAt);
    u32(at, CENTRAL_SIG);
    u16(at + 4, 20); // erzeugende Version
    u16(at + 6, 20);
    u16(at + 8, 0);
    u16(at + 10, p.method);
    u16(at + 12, time);
    u16(at + 14, date);
    u32(at + 16, p.crc);
    u32(at + 20, p.payload.length);
    u32(at + 24, p.size);
    u16(at + 28, p.name.length);
    u16(at + 30, 0); // extra
    u16(at + 32, 0); // Kommentar
    u16(at + 34, 0); // disk number
    u16(at + 36, 0); // interne Attribute
    u32(at + 38, 0); // externe Attribute
    u32(at + 42, offsets[i]!);
    out.set(p.name, at + 46);
    at += 46 + p.name.length;
  }

  u32(at, EOCD_SIG);
  u16(at + 4, 0);
  u16(at + 6, 0);
  u16(at + 8, packed.length);
  u16(at + 10, packed.length);
  u32(at + 12, at - cdStart);
  u32(at + 16, cdStart);
  u16(at + 20, 0);
  return out;
}

/** Build a package from the entries — **uncompressed**, in the given order. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  return writeZip(entries.map((e) => packStored(e, enc.encode(e.name))));
}

/**
 * Build a package and **compress** every entry where it pays off (see module head).
 *
 * Without `CompressionStream` a pure "stored" package results instead of an error: bigger, but
 * complete and readable — for a bug report a large package is always
 * besser als keines.
 */
export async function buildZipDeflated(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const Ctor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  const packed: Packed[] = [];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const stored = packStored(e, name);
    if (Ctor === undefined || e.data.length === 0) {
      packed.push(stored);
      continue;
    }
    const deflated = await deflateRaw(e.data, Ctor);
    // Only take it when it really is smaller — see module head (PNG).
    packed.push(
      deflated.length < e.data.length ? { ...stored, payload: deflated, method: METHOD_DEFLATE } : stored,
    );
  }
  return writeZip(packed);
}

async function deflateRaw(data: Uint8Array, Ctor: typeof CompressionStream): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new Ctor('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Error while reading a package — the message is meant for the user. */
export class ZipError extends Error {}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (Ctor === undefined)
    throw new ZipError('This browser cannot unpack compressed archives — store the files uncompressed.');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new Ctor('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a package. Throws {@link ZipError} with a displayable message — the caller never gets a
 * half-read list.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (bytes.length < EOCD_SIZE) throw new ZipError('Not a ZIP file (too short).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Search the end-of-directory record from the back: it may be followed by a comment of up to
  // 65535 bytes, so it is not necessarily at the last position.
  let eocd = -1;
  for (let i = bytes.length - EOCD_SIZE; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP file (no end-of-directory record).');
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new ZipError('ZIP64 archives are not supported.');

  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_SIG)
      throw new ZipError('The ZIP directory is damaged.');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const csize = view.getUint32(at + 20, true);
    const usize = view.getUint32(at + 24, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if ((flags & 1) !== 0) throw new ZipError(`"${name}" is encrypted.`);
    if (name.endsWith('/')) continue; // directory entry, carries no data
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_SIG)
      throw new ZipError(`"${name}" points outside the file.`);
    // The local header has its own name and extra length; only those say where the data starts.
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataAt + csize > bytes.length) throw new ZipError(`"${name}" is truncated.`);
    const raw = bytes.subarray(dataAt, dataAt + csize);
    let data: Uint8Array;
    if (method === METHOD_STORED) data = new Uint8Array(raw);
    else if (method === METHOD_DEFLATE) data = await inflateRaw(raw);
    else throw new ZipError(`"${name}" uses an unsupported compression (method ${method}).`);
    if (data.length !== usize) throw new ZipError(`"${name}" has an unexpected length.`);
    if (crc32(data) !== crc) throw new ZipError(`"${name}" is corrupt (checksum mismatch).`);
    out.push({ name, data, modifiedAt: fromDosStamp(time, date) });
  }
  return out;
}
