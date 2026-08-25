/**
 * **Karten-Fortschreibung** — `map_object_growth` (`FUN_0000f2d5` @0xf2d5).
 *
 * The pass that keeps the map *alive*: saplings become trees, grain ripens, felled trees rot away,
 * fish breed and migrate. Called as the third instruction of `updateEconomy` (@0xeca7).
 *
 * **Leaving it out does not break anything visibly** — no crash, no broken invariant, just a silent
 * economic death after roughly two hours of game time: saplings stay saplings, seed never ripens,
 * stumps stay put, so lumberjacks find no trees, farmers harvest nothing, and without food the whole
 * chain stops. Only a long run shows it, as the resource counts freeze at a fixed point.
 *
 * ## Pace (@0xf2d5..@0xf338)
 *
 * Tick-delta based like the player tick, so how often it is called does not matter:
 * ```
 * delta = gameTick - mapTick ; mapTick = gameTick
 * mapCounter -= delta ; no underflow => return (@0xf313 `jb` / @0xf315 `ret`)
 * do { count += tilesPerRound ; mapCounter += 20 } while (no overflow)
 * ```
 * `tilesPerRound` is `gs[0x21c]`, built during map init as `(cols >> 5) * (rows >> 5)`
 * (@0x7d84..@0x7dab) — four tiles per 20 ticks on a 64x64 map, scaling with the map size.
 *
 * ## Cursor (@0xf37d..@0xf3a7)
 *
 * The original keeps a **byte offset** into the landscape array in `gs+0x280` and advances it by
 * `0x5c` = 92 bytes = **23 tiles** per tile, masking with `gs[0]` and correcting an overflow into the
 * gap bit by `gs[0xc]` (one row). In our **gapless** encoding `pos = row*cols + col` that is
 * equivalent to `(pos + 23) & (tileCount - 1)`, checked against a reproduction of the original byte
 * arithmetic over **all** start positions rather than assumed.
 *
 * 23 is coprime to 4096, so the cursor covers the whole map.
 */

import { addU16, subU16, u16 } from './int.js';
import type { GameState } from './state.js';
import { neighbor, Direction, type MapGeometry } from './position.js';

/** Refill step of the remainder counter per round (`addw $0x14,0x27e(%ebx)` @0xf32f). */
const COUNTER_REFILL = 20;
/** Cursor step in tiles (`addw $0x5c,(%edi)` @0xf37d — 92 bytes / 4). */
const CURSOR_STEP = 23;
/** Refill value of the decay countdown (`mov $0x10,%ax` @0xf36f). */
const DECAY_RELOAD = 0x10;

/**
 * Tiles per refill round — `gs[0x21c]`, built as `(cols >> 5) * (rows >> 5)` (@0x7d84 `shrw $0x5`
 * twice, @0x7d97 `mul`). Four on a 64x64 map.
 */
export function tilesPerRound(geo: MapGeometry): number {
  return u16((geo.cols >> 5) * (geo.rows >> 5));
}

/**
 * The four directions a fish can migrate in (@0xf40c..@0xf424). The original computes
 * `off = (rng & 0xc) + 4`, then `if (off > 0xb) off += 4`, and uses that as a **byte** index into the
 * direction delta table at `gs+0x4` (4-byte entries, `gs+0x14` == UpLeft == direction 4). The offsets
 * {4, 8, 0x10, 0x14} are therefore directions **1, 2, 4, 5** — Right and Left are excluded. Taken as
 * is, not "completed".
 */
const FISH_DIRS: readonly Direction[] = [
  Direction.DownRight, // off 4
  Direction.Down, // off 8
  Direction.UpLeft, // off 0x10
  Direction.Up, // off 0x14
];

/**
 * Raw cursor value (packed u32 position, `.DS`@68) -> linear tile position, the same encoding as in
 * the serf and building records.
 */
export function decodeMapCursor(raw: number, geo: MapGeometry): number {
  const v = raw >>> 2;
  const col = v & geo.colMask;
  const row = (v >>> (geo.rowShift + 1)) & geo.rowMask;
  return (row << geo.rowShift) | col;
}

/** Inverse of {@link decodeMapCursor}. */
export function encodeMapCursor(pos: number, geo: MapGeometry): number {
  const col = pos & geo.colMask;
  const row = (pos >>> geo.rowShift) & geo.rowMask;
  return (((row << (geo.rowShift + 1)) | col) << 2) >>> 0;
}

/**
 * Advance one object — the jump table `@0xf47d`, index `(object & 0x7f) - 0x53`
 * (`andw $0x7f` @0xf45a, `subw $0x53` @0xf45f, `jb` @0xf464 for anything below).
 *
 * Object values below 0x53 (flags, buildings, grown trees, stones ...) are **not** touched. The
 * table covers 0x53..0x7f; the groups are resolved from the binary, not guessed.
 *
 * Returns the new **raw** object byte — bit 7, the water marker, survives, as in the original, which
 * always masks with `& 0x80` and ors it back in.
 */
export function growObject(rawObject: number, rng: () => number, decayCountdown: number): number {
  const water = rawObject & 0x80;
  const o = rawObject & 0x7f;
  if (o < 0x53) return rawObject;

 // 0x53 — tree stump: disappears with probability 1/4 (@0xf665).
  if (o === 0x53) {
    return (rng() & 3) === 0 ? water : rawObject;
  }
 // 0x54..0x5c — no entry (the table points at the tail @0xf76e).
  if (o <= 0x5c) return rawObject;
 // 0x5d..0x66 — felled tree, any stage => becomes stump 0x53 (@0xf683).
  if (o <= 0x66) return water | 0x53;
 // 0x67 — sapling A => with 1/1024 per visit a broadleaf tree 0x10..0x17 (@0xf69a).
  if (o === 0x67) {
    const r = rng();
    if ((r & 0x300) !== 0) return rawObject;
    return water | (0x10 + (r & 7));
  }
 // 0x68 — sapling B => conifer 0x08..0x0f (@0xf6d4).
  if (o === 0x68) {
    const r = rng();
    if ((r & 0x300) !== 0) return rawObject;
    return water | (0x08 + (r & 7));
  }
 // 0x69..0x6d — grain ripens one stage (@0xf70b).
  if (o <= 0x6d) return water | (o + 1);
 // 0x6e — ripe grain => 0x79 (@0xf716).
  if (o === 0x6e) return water | 0x79;
 // 0x6f — harvested field disappears (@0xf749).
  if (o === 0x6f) return water;
 // 0x70..0x78 — disappears only while the decay countdown is 0 (@0xf754).
  if (o <= 0x78) return decayCountdown === 0 ? water : rawObject;
 // 0x79..0x7d — one stage further (@0xf72a).
  if (o <= 0x7d) return water | (o + 1);
 // 0x7e — => 0x6f (@0xf735).
  if (o === 0x7e) return water | 0x6f;
 // 0x7f — no entry (tail).
  return rawObject;
}

/**
 * Fish branch (@0xf3bc..@0xf458). The original enters it only when **all three** hold: object bit 7
 * (water marker), landscape byte 0 bit 6 (block marker) and a remaining amount other than 0.
 *
 * Below an amount of 10 the fish breed with probability 1/64 (`(rng & 0x3f00) == 0`); afterwards a
 * fish **always** migrates in one of the four directions, provided the target tile also carries the
 * block marker. Note that the original draws **one** RNG value and uses it for both decisions
 * (`FUN_0004e1e9` @0xf3d4, then `vreg7` evaluated twice).
 */
function updateFish(state: GameState, pos: number): void {
  const tile = state.mapTiles[pos]!;
  if (!tile.blocked) return;
  if (tile.resourceAmount === 0) return;

  const r = state.rng.next();
 // `(char)(amount - 10) < 0` — sign test on the byte (@0xf3dd).
  if (((tile.resourceAmount - 10) & 0xff) >= 0x80) {
    if ((r & 0x3f00) === 0) tile.resourceAmount = (tile.resourceAmount + 1) & 0x1f;
  }
  const dir = FISH_DIRS[(r >> 2) & 3]!;
  const np = neighbor(pos, dir, state.geo);
  const target = state.mapTiles[np]!;
  if (!target.blocked) return;
  tile.resourceAmount = (tile.resourceAmount - 1) & 0x1f;
  target.resourceAmount = (target.resourceAmount + 1) & 0x1f;
}

/**
 * One map growth pass. The original runs it once per frame; because it derives its workload from
 * the **tick delta**, how often it is called does not affect the result.
 */
export function mapObjectGrowth(state: GameState): void {
  const h = state.header;
  const delta = subU16(state.gameTick, h.mapTick);
  h.mapTick = u16(state.gameTick);

  const before = h.mapCounter;
  h.mapCounter = subU16(before, delta);
 // @0xf313 `jb` — only an underflow continues; otherwise no round is due yet.
  if (delta <= before) return;

  const perRound = tilesPerRound(state.geo);
  let count = 0;
  for (;;) {
    count = addU16(count, perRound);
    const prev = h.mapCounter;
    h.mapCounter = addU16(prev, COUNTER_REFILL);
    if (prev >= 0x10000 - COUNTER_REFILL) break; // overflow => refilling done (@0xf337 `jae`)
  }

  let pos = decodeMapCursor(h.mapCursorRaw, state.geo);
  const mask = state.geo.tileCount - 1;
  do {
 // Decay countdown: `subw $0x1`, wrapping back to 16 on underflow (@0xf365..@0xf37b).
    const wasZero = h.mapDecayCountdown === 0;
    h.mapDecayCountdown = wasZero ? DECAY_RELOAD : h.mapDecayCountdown - 1;

    pos = (pos + CURSOR_STEP) & mask;
    const tile = state.mapTiles[pos]!;

 // Raw object byte including the water marker. Our model does not carry that marker (it is
 // derivable from the terrain), so it is reconstructed from the terrain here.
    const water = tile.terrainUp <= 3 || tile.terrainDown <= 3;
    if (water) updateFish(state, pos);

 // The 0x70..0x78 branch reads `gs[0x28c]` **after** the decrement and tests it for 0 (@0xf754).
 // After decrementing 0 it holds 0x10 (reloaded), after decrementing 1 it holds 0 — so the branch
 // fires when the counter was **1** before the decrement.
    const decaySeen = h.mapDecayCountdown;
    const grown = growObject(tile.object | (water ? 0x80 : 0), () => state.rng.next(), decaySeen);
    tile.object = grown & 0x7f;

    count = subU16(count, 1);
  } while (count !== 0);

  h.mapCursorRaw = encodeMapCursor(pos, state.geo);
}
