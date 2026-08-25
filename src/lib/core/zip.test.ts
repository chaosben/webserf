import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { buildZip, buildZipDeflated, crc32, readZip, ZipError } from './zip.js';

/** Incompressible bytes (xorshift32) — stands in for the payload of a PNG. */
const noise = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
};

const pattern = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7) & 0xff;
  return b;
};

/** Is an `unzip` available? The sharpest test of the writer is a FOREIGN reader. */
const hasUnzip = (): boolean => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('zip — CRC-32', () => {
  it('hits the known check values', () => {
    // The two standard vectors of the polynomial; without them the table would just be "some table".
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('zip — write and read back', () => {
  it('takes names, lengths and contents through the round trip', async () => {
    const big = pattern(87128); // the size of a real save game
    const zip = buildZip([
      { name: 'ARCHIV.DS', data: new Uint8Array(160).fill(0x41), modifiedAt: 1_700_000_000_000 },
      { name: 'SAVE0.DS', data: big, modifiedAt: 1_700_000_100_000 },
      { name: 'SAVE9.DS', data: new Uint8Array(0), modifiedAt: 1_700_000_200_000 },
    ]);
    const back = await readZip(zip);
    expect(back.map((e) => e.name)).toEqual(['ARCHIV.DS', 'SAVE0.DS', 'SAVE9.DS']);
    expect(back[1]!.data).toEqual(big);
    expect(back[2]!.data).toHaveLength(0);
  });

  it('keeps the timestamp accurate to two seconds', async () => {
    // The format stores seconds in steps of two -- more is not possible, and the check says exactly
    // that instead of claiming an accuracy that does not exist.
    const stamp = new Date(2026, 7, 21, 13, 29, 44).getTime();
    const back = await readZip(buildZip([{ name: 'A.DS', data: pattern(9), modifiedAt: stamp }]));
    expect(Math.abs(back[0]!.modifiedAt - stamp)).toBeLessThanOrEqual(2000);
  });

  it('reads an empty package', async () => {
    expect(await readZip(buildZip([]))).toEqual([]);
  });
});

describe('zip — archives produced elsewhere', () => {
  it('unpacks method 8 (deflate)', async () => {
    // Built with `node:zlib`, i.e. a FOREIGN deflate. `buildZipDeflated` produces method 8 itself by
    // now, but with the runtime implementation -- an archive from a third source is checked against
    // our own reader only here.
    const raw = pattern(20000);
    const comp = deflateRawSync(raw, { level: 9 });
    const zip = deflateZip('SAVE3.DS', raw, comp);
    const back = await readZip(zip);
    expect(back[0]!.name).toBe('SAVE3.DS');
    expect(back[0]!.data).toEqual(raw);
  });

  it('rejects a corrupted checksum', async () => {
    const raw = pattern(500);
    const zip = deflateZip('SAVE3.DS', raw, deflateRawSync(raw));
    const view = new DataView(zip.buffer);
    // Flip one bit of the checksum in the central directory.
    const cdAt = zip.length - 22 - (46 + 8);
    view.setUint32(cdAt + 16, (view.getUint32(cdAt + 16, true) ^ 1) >>> 0, true);
    await expect(readZip(zip)).rejects.toThrow(ZipError);
  });

  it('rejects what is not a package', async () => {
    await expect(readZip(new Uint8Array(4))).rejects.toThrow(ZipError);
    await expect(readZip(pattern(4096))).rejects.toThrow(ZipError);
  });
});

/** Read the method of a single-file archive from the central directory. */
const methodOf = (zip: Uint8Array, nameLen: number): number =>
  new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint16(
    zip.length - 22 - (46 + nameLen) + 10,
    true,
  );

describe('zip — writing compressed', () => {
  /** Well compressible, and in the way our real payloads are: lots of repetition. */
  const jsonish = (n: number): Uint8Array =>
    new TextEncoder().encode('{"height":0,"owner":0,"paths":0},'.repeat(n));

  it('does the round trip and carries method 8 while doing it', async () => {
    const raw = jsonish(2000);
    const zip = await buildZipDeflated([{ name: 'state.json', data: raw, modifiedAt: 1_700_000_000_000 }]);
    expect(methodOf(zip, 10)).toBe(8);
    const back = await readZip(zip);
    expect(back[0]!.name).toBe('state.json');
    expect(back[0]!.data).toEqual(raw); // byte-identical -- that is the whole promise
  });

  it('really saves something (otherwise the whole branch would be decoration)', async () => {
    const raw = jsonish(4000);
    const small = await buildZipDeflated([{ name: 'state.json', data: raw, modifiedAt: 0 }]);
    const large = buildZip([{ name: 'state.json', data: raw, modifiedAt: 0 }]);
    // The bound is coarse on purpose: measured is a factor of ~50, checked is "much smaller" -- a
    // tighter number would wobble with every zlib version without saying more.
    expect(small.length * 5).toBeLessThan(large.length);
  });

  it('leaves already compressed data alone', async () => {
    // A PNG is deflate-compressed; a second pass makes it BIGGER. The writer has to notice that per
    // entry -- without this check `screen.png` would grow unnoticed in the report.
    //
    // The payload is a PRNG stream and NOT `deflateRawSync(pattern(...))`: that was the first attempt
    // and it failed, because `pattern` is so regular that its deflate stream shrinks a second time.
    // A real PNG behaves like noise.
    const dense = noise(40000);
    const zip = await buildZipDeflated([{ name: 'screen.png', data: dense, modifiedAt: 0 }]);
    expect(methodOf(zip, 10)).toBe(0);
    expect((await readZip(zip))[0]!.data).toEqual(new Uint8Array(dense));
  });

  it('stays a readable package without `CompressionStream`', async () => {
    // If the runtime capability is missing, a large package should result and not an error: for a bug
    // report a large package is always better than none.
    const g = globalThis as { CompressionStream?: unknown };
    const saved = g.CompressionStream;
    delete g.CompressionStream;
    try {
      const raw = jsonish(100);
      const zip = await buildZipDeflated([{ name: 'state.json', data: raw, modifiedAt: 0 }]);
      expect(methodOf(zip, 10)).toBe(0);
      expect((await readZip(zip))[0]!.data).toEqual(raw);
    } finally {
      g.CompressionStream = saved;
    }
  });

  it('packs an empty package and an empty entry', async () => {
    expect(await readZip(await buildZipDeflated([]))).toEqual([]);
    const back = await readZip(await buildZipDeflated([{ name: 'empty.json', data: new Uint8Array(0), modifiedAt: 0 }]));
    expect(back[0]!.data).toHaveLength(0);
  });
});

describe('zip — against a foreign `unzip`', () => {
  it.skipIf(!hasUnzip())('produces an archive that `unzip -t` checks without errors', () => {
    // The actual proof: our own reader could make the same mistake as the writer. A foreign tool
    // cannot.
    const dir = mkdtempSync(join(tmpdir(), 'siedler-zip-'));
    const file = join(dir, 'p.zip');
    const big = pattern(87128);
    writeFileSync(
      file,
      buildZip([
        { name: 'ARCHIV.DS', data: new Uint8Array(160).fill(0x41), modifiedAt: 1_700_000_000_000 },
        { name: 'SAVE0.DS', data: big, modifiedAt: 1_700_000_100_000 },
      ]),
    );
    expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toContain('No errors');
    execFileSync('unzip', ['-q', file, '-d', join(dir, 'out')]);
    expect(new Uint8Array(readFileSync(join(dir, 'out', 'SAVE0.DS')))).toEqual(big);
  });

  it.skipIf(!hasUnzip())('produces an archive `unzip` extracts when COMPRESSED too', async () => {
    // Same reason, and for the deflate branch it weighs more: there are two lengths in the header
    // (compressed and uncompressed), and whoever swaps them still gets intact data from their own
    // reader -- a foreign extractor does not.
    const dir = mkdtempSync(join(tmpdir(), 'siedler-zipz-'));
    const file = join(dir, 'p.zip');
    const json = new TextEncoder().encode('{"a":0,"b":0,"c":0},'.repeat(3000));
    const png = noise(20000); // like a PNG: incompressible, stays "stored"
    writeFileSync(
      file,
      await buildZipDeflated([
        { name: 'state.json', data: json, modifiedAt: 1_700_000_000_000 },
        { name: 'screen.png', data: png, modifiedAt: 1_700_000_100_000 },
      ]),
    );
    expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toContain('No errors');
    execFileSync('unzip', ['-q', file, '-d', join(dir, 'out')]);
    expect(new Uint8Array(readFileSync(join(dir, 'out', 'state.json')))).toEqual(json);
    expect(new Uint8Array(readFileSync(join(dir, 'out', 'screen.png')))).toEqual(new Uint8Array(png));
  });
});

/** A single-file archive with method 8 — by hand, so the deflate branch is testable. */
function deflateZip(name: string, raw: Uint8Array, comp: Uint8Array): Uint8Array {
  const n = new TextEncoder().encode(name);
  const out = new Uint8Array(30 + n.length + comp.length + 46 + n.length + 22);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(8, 8, true);
  v.setUint32(14, crc32(raw), true);
  v.setUint32(18, comp.length, true);
  v.setUint32(22, raw.length, true);
  v.setUint16(26, n.length, true);
  out.set(n, 30);
  out.set(comp, 30 + n.length);
  const cd = 30 + n.length + comp.length;
  v.setUint32(cd, 0x02014b50, true);
  v.setUint16(cd + 4, 20, true);
  v.setUint16(cd + 6, 20, true);
  v.setUint16(cd + 10, 8, true);
  v.setUint16(cd + 12, 0x6a00, true);
  v.setUint16(cd + 14, 0x5d15, true);
  v.setUint32(cd + 16, crc32(raw), true);
  v.setUint32(cd + 20, comp.length, true);
  v.setUint32(cd + 24, raw.length, true);
  v.setUint16(cd + 28, n.length, true);
  v.setUint32(cd + 42, 0, true);
  out.set(n, cd + 46);
  const eocd = cd + 46 + n.length;
  v.setUint32(eocd, 0x06054b50, true);
  v.setUint16(eocd + 8, 1, true);
  v.setUint16(eocd + 10, 1, true);
  v.setUint32(eocd + 12, 46 + n.length, true);
  v.setUint32(eocd + 16, cd, true);
  return out;
}
