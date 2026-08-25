import { describe, expect, it } from 'vitest';
import { buildTerrainCommands, windowOrigin, type TerrainTileData } from './terrain-commands.js';
import { buildHalfRows, viewportSpan } from './map-viewport.js';
import { TILE_H, TILE_W, terrainTriangle, triangleSlopeValid } from './map-render.js';
import { groundSpriteForTriangle, downMaskIndex, upMaskIndex } from './terrain-mask.js';
import { mapGeometry, posOf } from './engine/position.js';

const geo = mapGeometry(3); // 64x64, like every original save

/** Gentle heights (slopes stay inside the valid [-4,4]) plus alternating terrain types. */
function smoothMap(): TerrainTileData[] {
  const tiles: TerrainTileData[] = [];
  for (let row = 0; row < geo.rows; row++) {
    for (let col = 0; col < geo.cols; col++) {
      tiles.push({
        height: Math.floor(3 * Math.sin(col / 5) + 3 * Math.cos(row / 7)) + 8,
        terrainUp: (col + row) % 16,
        terrainDown: (col * 3 + row) % 16,
      });
    }
  }
  return tiles;
}

const tiles = smoothMap();
const span = viewportSpan(640, 480);

describe('buildTerrainCommands — coverage', () => {
  it('produces BOTH triangles per tile (not one per half-row kind)', () => {
    const rows = buildHalfRows({ col: 10, row: 20 }, geo, span);
    const tileCount = rows.reduce((n, r) => n + r.tiles.length, 0);
    const cmds = buildTerrainCommands(rows, geo, tiles);
    expect(cmds).toHaveLength(tileCount * 2);
    expect(cmds.filter((c) => c.kind === 'up')).toHaveLength(tileCount);
    expect(cmds.filter((c) => c.kind === 'down')).toHaveLength(tileCount);
  });

  it('skips triangles with an impossible slope', () => {
    // A single spike: the neighbourhood around it pushes the height difference past 4.
    const spiky = tiles.map((t, i) => ({ ...t, height: i === posOf(12, 21, geo) ? 31 : 1 }));
    const rows = buildHalfRows({ col: 10, row: 20 }, geo, span);
    const cmds = buildTerrainCommands(rows, geo, spiky);
    const all = rows.reduce((n, r) => n + r.tiles.length, 0) * 2;
    expect(cmds.length).toBeLessThan(all);
    // And exactly the triangles that have the spike as a corner — no more.
    expect(all - cmds.length).toBe(6);
  });
});

describe('buildTerrainCommands — geometry == verified terrainTriangle', () => {
  // The actual correctness proof: the running counters of the original bookkeeping have to deliver
  // the same positions as the pixel-verified formula `col*32 - row*16`. The window deliberately has
  // NO seam, so that `col*32 - row*16` applies at all.
  const scroll = { col: 10, row: 20 };
  const rows = buildHalfRows(scroll, geo, span);
  const origin = windowOrigin(posOf(scroll.col, scroll.row, geo), geo);
  const heightAt = (c: number, r: number) => tiles[posOf(c, r, geo)]!.height;

  /** One command as a comparable key. */
  const key = (c: {
    kind: string;
    x: number;
    y: number;
    maskIndex: number;
    groundSprite: number;
  }): string => `${c.kind}|${c.x}|${c.y}|${c.maskIndex}|${c.groundSprite}`;

  /** Die Erwartung in Halbzeilen-Reihenfolge — daraus fallen beide Tests unten ab. */
  const expected = (): string[] => {
    const out: string[] = [];
    for (const row of rows) {
      for (let k = 0; k < row.tiles.length; k++) {
        const pos = row.tiles[k]!;
        const col = pos % geo.cols;
        const r = (pos - col) / geo.cols;
        for (const kind of ['up', 'down'] as const) {
          const tri = terrainTriangle(kind, col, r, heightAt);
          if (!triangleSlopeValid(tri)) continue;
          const terrain = kind === 'up' ? tiles[pos]!.terrainUp : tiles[pos]!.terrainDown;
          const ground = groundSpriteForTriangle(kind, terrain, tri.m, tri.left, tri.right);
          if (ground === null) continue;
          out.push(
            key({
              kind,
              x: tri.x - origin.x,
              y: tri.y - origin.y,
              maskIndex:
                kind === 'up'
                  ? upMaskIndex(tri.m, tri.left, tri.right)
                  : downMaskIndex(tri.m, tri.left, tri.right),
              groundSprite: ground,
            }),
          );
        }
      }
    }
    return out;
  };

  it('x/y, mask index and ground sprite match command by command (as a set)', () => {
    const got = buildTerrainCommands(rows, geo, tiles).map(key);
    const want = expected();
    expect(want.length).toBeGreaterThan(1000); // a meaningful sample, not just an edge
    expect(got.length).toBe(want.length);
    expect([...got].sort()).toEqual([...want].sort());
  });

  // The order IS semantics: the masks overlap at their dithered edges, so it decides which texture a
  // border pixel gets. The original draws column by column from left to right — measured at the pixel
  // that explains 99.87 % of the overlap pixels against 92-95 % for row order.
  it('emits COLUMN BY COLUMN: x never decreases', () => {
    const cmds = buildTerrainCommands(rows, geo, tiles);
    for (let i = 1; i < cmds.length; i++) {
      expect(cmds[i]!.x, `command ${i}`).toBeGreaterThanOrEqual(cmds[i - 1]!.x);
    }
  });

  it('and inside a column in half-row order (not sorted by y)', () => {
    const got = buildTerrainCommands(rows, geo, tiles);
    const want = expected();
    // Per column the subsequence has to be the same as in half-row order. That rules out sorting by y
    // inside the column — the height shifts y, the band does not.
    const byColGot = new Map<number, string[]>();
    for (const c of got) {
      const l = byColGot.get(c.x) ?? [];
      l.push(key(c));
      byColGot.set(c.x, l);
    }
    const byColWant = new Map<number, string[]>();
    for (const k of want) {
      const x = Number(k.split('|')[1]);
      const l = byColWant.get(x) ?? [];
      l.push(k);
      byColWant.set(x, l);
    }
    expect(byColGot.size).toBe(byColWant.size);
    for (const [x, l] of byColWant) expect(byColGot.get(x), `column x=${x}`).toEqual(l);
  });
});

describe('buildTerrainCommands — torus wrap', () => {
  it('at the seam the positions stay on the lattice (no jump across the map)', () => {
    // From the wrapped tile coordinate the scene position would NOT be derivable (a jump of half the
    // map). The running counters still deliver a gapless lattice.
    const rows = buildHalfRows({ col: 58, row: 58 }, geo, span);
    const cmds = buildTerrainCommands(rows, geo, tiles);
    const xs = [...new Set(cmds.map((c) => c.x))].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!, `gap between x ${xs[i - 1]} and ${xs[i]}`).toBeLessThanOrEqual(
        TILE_W / 2,
      );
    }
    expect(xs[0]).toBeLessThanOrEqual(0);
    expect(xs[xs.length - 1]).toBeGreaterThanOrEqual(640 - TILE_W);
  });

  it('scrolling by a whole map gives identical commands', () => {
    const a = buildTerrainCommands(buildHalfRows({ col: 9, row: 9 }, geo, span), geo, tiles);
    const b = buildTerrainCommands(
      buildHalfRows({ col: 9 + geo.cols, row: 9 + geo.rows }, geo, span),
      geo,
      tiles,
    );
    expect(b).toEqual(a);
  });

  it('only the map content depends on the scroll, the position lattice does not', () => {
    const posKey = (cs: ReturnType<typeof buildTerrainCommands>) =>
      cs.map((c) => `${c.kind}${c.x},${c.y}`).join('|');
    // Flat (heightUnit 0) drops the height shear — then the lattice has to be exactly equal across
    // every scroll position, seam included.
    const flat = (col: number, row: number) =>
      posKey(buildTerrainCommands(buildHalfRows({ col, row }, geo, span), geo, tiles, 0));
    expect(flat(58, 58)).toBe(flat(10, 20));
    expect(flat(0, 0)).toBe(flat(10, 20));
  });
});

describe('buildTerrainCommands — flat mode', () => {
  it('heightUnit 0 => flat mask (index 40) and y on the half-row grid', () => {
    const rows = buildHalfRows({ col: 4, row: 4 }, geo, span);
    const cmds = buildTerrainCommands(rows, geo, tiles, 0);
    expect(cmds.every((c) => c.maskIndex === 40)).toBe(true);
    expect(cmds.every((c) => c.y % TILE_H === 0)).toBe(true);
    expect(cmds.every((c) => c.x % (TILE_W / 2) === 0)).toBe(true);
  });
});

describe('windowOrigin', () => {
  it('is the scene position of the start tile', () => {
    expect(windowOrigin(posOf(10, 20, geo), geo)).toEqual({
      x: 10 * TILE_W - 20 * (TILE_W / 2),
      y: 20 * TILE_H,
    });
  });
});
