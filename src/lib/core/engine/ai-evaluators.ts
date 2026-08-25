/**
 * The AI's 25 urgency evaluators (`0x5831b`..`0x5af30`), the input of the maximum selection in the
 * build decider. Each answers, for one project, how urgent it is right now and writes
 * `aiUrgency[slot]`.
 *
 * They live in one module because they do in the binary: the 25 bodies lie back to back, each ending
 * exactly at the next one's entry, and share not a single address. What they have in common is not
 * code but a small calculation vocabulary - {@link mulHigh}, {@link clampMax}, {@link satSub},
 * {@link ratioUrgency}, {@link satAdd}. What an evaluator has individually are its gates (which staff,
 * which tool, which upstream works) and its curve constants; those stand as tables ({@link AI_RAMPS},
 * {@link AI_RATIOS}) so they can be held number by number against the binary.
 *
 * Four things are not obvious, all reproduced rather than repaired:
 *
 * 1. `FUN_0005b88b` is defective and scores ONE candidate slot instead of eight. It is an eight-fold
 *    unrolled loop written WITHOUT displacements, so all 16 loads read the same slot; the sister
 *    function next to it reads 0/6/0xc/0x12. Result: `slot[0].score & ~1`, see
 *    {@link candidateTopPair}.
 * 2. The curve cascade underflows. {@link rampUrgency} has the same shape everywhere, but the
 *    constants are not continuous: for the lumberjack, band 2 subtracts more than the value can hold,
 *    so the urgency jumps to maximal in the middle of a range with plenty of timber.
 * 3. The pair evaluators leave a score in the register when there is no partner. Fisher and pig farm
 *    compute a shared urgency and split it across two slots; if only their own row has candidates the
 *    code falls past the splitting block and the tail multiplies by the candidate average instead. The
 *    mirrored case is correct, and the asymmetry is the same in both, so it is a pattern.
 * 4. The mines' overflow guards test one bit instead of "any bit above", and their clamp sits just
 *    below that bit, so the guard never fires.
 *
 * Number model: everything is 16-bit like the original. Where the original writes `0xffffffff` on
 * overflow the port carries `0xffff` - the upper half is never read.
 */
import type { GameState, Player } from './state.js';
import { u16 } from './int.js';

// -- Operators ------------------------------------------------------------------------------------

/** Upper 16 bits of a 16x16 product (`mul %cx` + `rorl $0x10`) — in 18 of the 25 bodies. */
export function mulHigh(a: number, b: number): number {
  return Math.floor((u16(a) * u16(b)) / 0x10000) & 0xffff;
}

/** `min(v, limit)` — in the original `cmpw`/`jb` + `mov $limit`; in 17 bodies. */
export function clampMax(v: number, limit: number): number {
  return v > limit ? limit : v;
}

/** Saturating 16-bit addition: carry => `0xffff` (`add` + `jae` -> `mov $0xffffffff`). */
export function satAdd(a: number, b: number): number {
  const sum = u16(a) + u16(b);
  return sum > 0xffff ? 0xffff : sum;
}

/** Saturating 16-bit subtraction: underflow => `0` (`sub` + `jae` -> `mov $0`). */
export function satSub(a: number, b: number): number {
  return u16(a) < u16(b) ? 0 : u16(a) - u16(b);
}

/**
 * Saturating decrement — the shape `cmpw $0x0,<field> ; jne ; subw $0x1 ; jae ; movl $0` with which
 * stonecutter and stone mine trim their staff by one when a mine type is missing entirely.
 */
function satDec(v: number): number {
  return v === 0 ? 0 : u16(v - 1);
}

/**
 * One band of the curve: applies for `v < limit`, yields `~(v << shift) + bias`.
 *
 * The shape comes from the intent "the more there is, the smaller the urgency": `v << shift` spreads
 * the small input range across the whole word, `~` reverses the direction, `bias` joins the band to the
 * lower bound of the previous one. It is perfectly continuous only where the author chose it so — see
 * point 2 in the module head.
 */
export interface AiRampBand {
  readonly limit: number;
  readonly shift: number;
  readonly bias: number;
}

/** Evaluate the curve: the first band with `v < limit` wins, otherwise 0. */
export function rampUrgency(v: number, bands: readonly AiRampBand[]): number {
  for (const band of bands) {
    if (v < band.limit) return u16(u16(~u16(v << band.shift)) + band.bias);
  }
  return 0;
}

/**
 * Parameters of the second shared curve {@link ratioUrgency} — it occurs in 9 bodies and answers "is my
 * processing capacity enough for the supply?".
 */
export interface AiRatioShape {
  /** Right shift of the 32-bit numerator before the division (`shrl $num` on `have << 16`). */
  readonly num: number;
  /** Shift in the surplus branch. */
  readonly shift: number;
  /** Bias in the surplus branch. */
  readonly bias: number;
}

/**
 * **Capacity against supply.** If `have` does not cover `demand`, the urgency is the inverted ratio (the
 * scarcer, the higher); if it does, it falls to 0 across a short remaining range.
 *
 * ```
 * have < demand : ~( ((have << 16) >> num) / demand )
 * otherwise     : d = have - demand ; d < 0x10 ? ~(d << shift) + bias : 0
 * ```
 *
 * The 32-bit numerator arises in the original via `rorl $0x10` + zeroing the lower word + `shrl` —
 * hence `have << 16` and not `have`.
 */
export function ratioUrgency(demand: number, have: number, shape: AiRatioShape): number {
  if (u16(have) < u16(demand)) {
    if (demand === 0) return 0; // unreachable in the original (there is no have < 0)
    const numerator = (u16(have) * 0x10000) / Math.pow(2, shape.num);
    return u16(~u16(Math.floor(numerator / u16(demand))));
  }
  const rest = u16(have) - u16(demand);
  if (rest >= 0x10) return 0;
  return u16(u16(~u16(rest << shape.shift)) + shape.bias);
}

// -- Access to the counters of the player block ----------------------------------------------------
//
// The evaluators address them through fixed displacements: completed buildings from `player+0x4`,
// sites from `player+0x32`, each u16 and both indexed by **building type - 1**. `done`/`site` take the
// type so the port stays readable: `done(p, BLD.CoalMine)` instead of `completedBuildingCount[5]`.

/** Building types as the counters index them (type - 1 == array index). */
const BLD = {
  Fisher: 1, Lumberjack: 2, Boatbuilder: 3, Stonecutter: 4, StoneMine: 5, CoalMine: 6,
  IronMine: 7, GoldMine: 8, Forester: 9, Warehouse: 10, Hut: 11, Farm: 12, Butcher: 13,
  PigFarm: 14, Mill: 15, Baker: 16, Sawmill: 17, SteelSmelter: 18, Toolmaker: 19,
  WeaponSmith: 20, Tower: 21, Fortress: 22, GoldSmelter: 23,
} as const;

/** Resource indices of the {@link Player.aiStockpile} table. */
const RES = {
  Fish: 0, Pig: 1, Meat: 2, Wheat: 3, Flour: 4, Bread: 5, Lumber: 6, Plank: 7, Boat: 8,
  Stone: 9, IronOre: 10, Steel: 11, Coal: 12, GoldOre: 13, GoldBar: 14, Shovel: 15,
  Hammer: 16, Rod: 17, Cleaver: 18, Scythe: 19, Axe: 20, Saw: 21, Pick: 22, Pincer: 23,
  Sword: 24, Shield: 25,
} as const;

/** Serf types of the {@link Player.aiIdleSerfs} table. */
const SRF = {
  Transporter: 0, Sailor: 1, Digger: 2, Builder: 3, Lumberjack: 5, Sawmiller: 6,
  Stonecutter: 7, Forester: 8, Miner: 9, Smelter: 10, Fisher: 11, PigFarmer: 12,
  Butcher: 13, Farmer: 14, Miller: 15, Baker: 16, BoatBuilder: 17, Toolmaker: 18,
  WeaponSmith: 19, Geologist: 20, Generic: 21, Knight0: 22,
} as const;

/** `completedBuildingCount[type - 1]` — in the original `player+0x4 + 2*(type-1)`. */
const done = (p: Player, type: number): number => p.completedBuildingCount?.[type - 1] ?? 0;
/** `incompleteBuildingCount[type - 1]` — in the original `player+0x32 + 2*(type-1)`. */
const site = (p: Player, type: number): number => p.incompleteBuildingCount?.[type - 1] ?? 0;
/** Completed plus under construction — the most frequent quantity of the whole family. */
const both = (p: Player, type: number): number => u16(done(p, type) + site(p, type));
/** Goods stock across all own inventories. */
const stock = (p: Player, res: number): number => p.aiStockpile?.[res] ?? 0;
/** Idle serfs per profession. */
const idle = (p: Player, srf: number): number => p.aiIdleSerfs?.[srf] ?? 0;
/** Supply ratio per consumer group. */
const supply = (p: Player, group: number): number => p.aiSupplyRatio?.[group] ?? 0;
/** Build pressure of the project — every evaluator reads exactly its own. */
const pressure = (p: Player, slot: number): number => p.aiPressure?.[slot] ?? 0;

/** The four mines in the order the evaluators sum them. */
const MINES = [BLD.StoneMine, BLD.CoalMine, BLD.IronMine, BLD.GoldMine] as const;

/** Sum of the four mines' sites (`0x3a`+`0x3c`+`0x3e`+`0x40`, plain 16-bit additions). */
function mineSites(p: Player): number {
  let n = 0;
  for (const m of MINES) n = u16(n + site(p, m));
  return n;
}

/**
 * The "large" sites as the lumberjack and stonecutter evaluators sum them — identical to `LARGE_TYPES`
 * in `build-site.ts`, which confirms the offset reading independently.
 */
const LARGE_SITES = [
  BLD.StoneMine, BLD.CoalMine, BLD.IronMine, BLD.GoldMine, BLD.Warehouse, BLD.Farm, BLD.Butcher,
  BLD.PigFarm, BLD.Mill, BLD.Baker, BLD.Sawmill, BLD.SteelSmelter, BLD.Toolmaker, BLD.WeaponSmith,
  BLD.Tower, BLD.GoldSmelter,
] as const;

/** The "small" sites — the rest, likewise congruent with `build-site.ts`. */
const SMALL_SITES = [
  BLD.Fisher, BLD.Lumberjack, BLD.Boatbuilder, BLD.Stonecutter, BLD.Forester, BLD.Hut,
] as const;

// -- Candidate scores ------------------------------------------------------------------------------

/**
 * **Average score of the eight candidate slots of a project row** — `FUN_0005b7e4` @0x5b7e4.
 *
 * The original sums the eight u16 in one word and counts the carries alongside (`addw` + `jae` ->
 * `addw $0x1,0x18(%edi)`); at the end `rorl $0x10` @0x5b87c shifts the carry counter up, adds in 32
 * bits and divides by 8 (`shrl $0x3` @0x5b886) — i.e. an ordinary 32-bit sum.
 */
export function candidateAverage(player: Player, row: number): number {
  const slots = player.aiCandidates?.[row];
  if (slots === undefined) return 0;
  let sum = 0;
  for (const slot of slots) sum += slot?.score ?? 0;
  return (sum >>> 3) & 0xffff;
}

/**
 * **"Mean of the best two scores" of a row** — `FUN_0005b88b` @0x5b88b, used by the four mine
 * evaluators.
 *
 * **This is defective in the original** (point 1 in the module head): the eight-fold unrolled loop reads
 * its value **16 times without a displacement** (`mov (%ebx),%ax`), i.e. eight times the same slot 0,
 * while `FUN_0005b7e4` next to it advances `0x6`/`0xc`/`0x12`… The arithmetic itself is intact —
 * largest value into `vreg7`, second largest into `vreg6`, finally `(vreg7 >> 1) + (vreg6 >> 1)`
 * (@0x5b9fb..@0x5ba07). With eight equal inputs that gives `slot[0].score` with bit 0 cleared.
 */
export function candidateTopPair(player: Player, row: number): number {
  const first = player.aiCandidates?.[row]?.[0]?.score ?? 0;
  if (first === 0) return 0;
  return u16((first >>> 1) + (first >>> 1));
}

// -- Curve tables ----------------------------------------------------------------------------------

/**
 * The curves of the evaluators that use {@link rampUrgency} — the key is the address of the original
 * routine, so every band can be held against the binary individually.
 */
export const AI_RAMPS: Readonly<Record<number, readonly AiRampBand[]>> = {
  // fisher, curve from `cmpw $0x20,(%edi)` @0x58602: `shlw $8`+`shlw $2` / `shlw $8`+self-0x4000 / `shlw $8`+0x7001
  0x58395: [
    { limit: 0x20, shift: 10, bias: 0 },
    { limit: 0x50, shift: 9, bias: -0x4000 },
    { limit: 0x70, shift: 8, bias: 0x7001 },
  ],
  // lumberjack @0x58b16 — band 2 underflows from v == 0x60, see point 2 in the module head.
  0x58833: [
    { limit: 0x40, shift: 9, bias: 0 },
    { limit: 0x70, shift: 9, bias: -0x4000 },
    { limit: 0x90, shift: 8, bias: -0x6fff },
  ],
  // boat builder @0x58c2b — two fixed values instead of bands, hence only the third band here.
  0x58ba8: [{ limit: 8, shift: 10, bias: 0x2800 }],
  // stonecutter @0x58e6d
  0x58c89: [
    { limit: 0x10, shift: 11, bias: 0 },
    { limit: 0x40, shift: 9, bias: -0x6000 },
    { limit: 0x140, shift: 5, bias: 0x2801 },
  ],
  // weapon smith @0x5a7b9
  0x5a723: [
    { limit: 0x40, shift: 9, bias: 0 },
    { limit: 0x100, shift: 7, bias: -0x6000 },
    { limit: 0x500, shift: 3, bias: 0x2801 },
  ],
};

/** The parameters of the ratio curve per evaluator (9 bodies). */
export const AI_RATIOS: Readonly<Record<number, AiRatioShape>> = {
  0x59656: { num: 2, shift: 8, bias: 0x1001 }, // warehouse
  0x59b2a: { num: 2, shift: 7, bias: 0x801 }, // butcher
  0x59c88: { num: 2, shift: 7, bias: 0x801 }, // pig farm
  0x5a04c: { num: 2, shift: 7, bias: 0x801 }, // bakery
  0x5a177: { num: 2, shift: 7, bias: 0x801 }, // sawmill
  0x5a316: { num: 2, shift: 7, bias: 0x801 }, // steel smelter
  0x5a928: { num: 1, shift: 7, bias: 0x801 }, // watchtower
  0x5acab: { num: 2, shift: 7, bias: 0x801 }, // gold smelter
};

// -- The 25 evaluators -----------------------------------------------------------------------------

/**
 * **Flag urgency** — `FUN_0005831b` @0x5831b, slot 24 (task 25).
 *
 * ```
 * (idle transporters + idle generics) < 3       -> nothing            @0x58335
 * average of the 8 candidate scores == 0        -> nothing            @0x58351
 * urgency = (56000 * pressure[24]) >> 16                              @0x58356…@0x5838a
 * ```
 *
 * The average is **only a gate** here, not a factor: the flag always gets the same base number 56000
 * and scales with the pressure alone. That fits its role — a flag is cheap, all that matters is
 * *whether* a spot is known.
 */
export function aiFlagUrgency(_state: GameState, player: Player): void {
  const workforce = u16(idle(player, SRF.Transporter) + idle(player, SRF.Generic));
  if (workforce < 3) return; // `cmpw $0x3,(%edi) ; jae` @0x58335 — else `ret` @0x5833b
  // Row 0 of the candidate table: `add $0x434,%esi` @0x5833f — the base without an offset.
  if (candidateAverage(player, 0) === 0) return; // `or %ax,%ax ; je 0x5833b` @0x58351
  // Target field `mov %ax,0x400(%ebx)` @0x5838a, and `0x3d0 + 24 * 2 == 0x400` — slot 24.
  player.aiUrgency[24] = mulHigh(56000, pressure(player, 24));
}

/**
 * **Geologist urgency** — `FUN_0005ae48` @0x5ae48, slot 23 (task 24).
 *
 * Two preconditions, depending on whether a geologist already rests in a stock:
 *
 * ```
 * an idle geologist exists:
 *   (transporters + generics) < 2                             -> nothing   @0x5ae71
 * no idle geologist (so train one):
 *   (totalLandScore >> 7) + 3 < serfCount[geologist]           -> nothing   @0x5ae92
 *   no hammer in stock                                        -> nothing   @0x5aea4
 *   no generics                                               -> nothing   @0x5aeb6
 *   (generics + transporters) < 3                             -> nothing   @0x5aec9
 * urgency = (min(average, 14999) * 4 * pressure[23]) >> 16
 * ```
 *
 * The land rule limits the number of geologists to `land/128 + 3` — more area, more prospecting. The
 * hammer is the geologist's tool; without it no generic can be retrained.
 *
 * **The clamp is evidenced by data**: `min(., 14999) * 4` caps the urgency at **59996**, and the
 * highest value of this slot stored in any original save is **59995**.
 */
export function aiGeologistUrgency(_state: GameState, player: Player): void {
  const idleTransporters = idle(player, SRF.Transporter);
  const idleGenerics = idle(player, SRF.Generic);
  if (idle(player, SRF.Geologist) !== 0) {
    // `je 0x5ae79` @0x5ae55 — a geologist is resting, only walking staff is needed.
    if (u16(idleTransporters + idleGenerics) < 2) return; // `cmpw $0x2` @0x5ae71
  } else {
    // Train one: upper bound from the land, then tool and staff.
    const allowance = u16((player.totalLandScore >>> 7) + 3); // `shrl $0x7` @0x5ae84 + `addw $0x3`
    if (allowance < (player.serfCount[20] ?? 0)) return; // `cmp %ax,(%edi) ; jb` @0x5ae92
    if (stock(player, RES.Hammer) === 0) return; // @0x5aea4
    if (idleGenerics === 0) return; // @0x5aeb6
    if (u16(idleGenerics + idleTransporters) < 3) return; // `jae 0x5aecc` @0x5aec9
  }
  // Row 25 (geologist): `add $0x8e4,%esi` @0x5aecf — and `0x434 + 25 * 48 == 0x8e4`. The arithmetic
  // works out exactly and pins base, stride and row number in one go.
  const avg = candidateAverage(player, 25);
  const clamped = avg >= 15000 ? 14999 : avg; // `cmpw $0x3a98` @0x5aee5 + `mov $0x3a97`
  // Target field `mov %ax,0x3fe(%ebx)` @0x5af26, and `0x3d0 + 23 * 2 == 0x3fe` — slot 23.
  player.aiUrgency[23] = mulHigh(u16(clamped << 2), pressure(player, 23));
}

/**
 * **Fisher, with the farm riding on top** — `FUN_00058395` @0x58395, slots 0 and 11. At 326
 * instructions the largest of the family, because it draws the whole **food balance**.
 *
 * ```
 * per mine (stone/coal/iron/gold):
 *   n = completed + under construction
 *   need  += (min(n, 0x1fff) * 8 * supply[group]) >> 16              @0x583d9 ff.
 *   mines += n
 * have = need + fish + meat + bread
 *        + pig    if a butcher exists                                @0x5855f
 *        + flour  if a bakery exists                                 @0x5857a
 *          + wheat if a mill exists as well                          @0x58595
 * mines < 8 => have *= 2 ; < 4 => *= 2 ; < 2 => *= 2                 @0x585b6
 * have = satSub(have, min(mines, 0x1fff) * 8)
 * urgency = curve(have)
 * ```
 *
 * The food chain is **correctly staged in domain terms**: pigs only count as food once a butcher
 * exists, wheat only with a mill *and* a bakery. And the doubling at few mines turns the urgency down
 * — whoever has hardly any mines hardly needs food.
 *
 * **Not obvious:** the first three mine contributions are added **plainly**; the first carry check
 * appears only at the fourth (`jb 0x585af` @0x58529). The port does the same.
 */
export function aiFisherUrgency(_state: GameState, player: Player): void {
  let need = 0;
  let mines = 0;
  for (let i = 0; i < MINES.length; i++) {
    const n = both(player, MINES[i]);
    mines = u16(mines + n);
    // supply group 1..4 == the four mines (`0x33e`/`0x340`/`0x342`/`0x344`).
    const term = mulHigh(u16(clampMax(n, 0x1fff) << 3), supply(player, i + 1));
    need = i < 3 ? u16(need + term) : satAdd(need, term); // see module head: saturating only from the 4th
  }
  let food = satAdd(need, stock(player, RES.Fish));
  food = satAdd(food, stock(player, RES.Meat));
  food = satAdd(food, stock(player, RES.Bread));
  if (done(player, BLD.Butcher) !== 0) food = satAdd(food, stock(player, RES.Pig));
  if (done(player, BLD.Baker) !== 0) {
    food = satAdd(food, stock(player, RES.Flour));
    if (done(player, BLD.Mill) !== 0) food = satAdd(food, stock(player, RES.Wheat));
  }
  if (mines < 8) {
    food = u16(food + food);
    if (mines < 4) {
      food = u16(food + food);
      if (mines < 2) food = u16(food + food);
    }
  }
  food = satSub(food, u16(clampMax(mines, 0x1fff) << 3));
  const urgency = rampUrgency(food, AI_RAMPS[0x58395] ?? []);
  // Split across fisher (row 1) and farm (row 12) — `add $0x464,%esi` @0x58664 and
  // `add $0x674,%esi` @0x58680; `0x434 + 1 * 48 == 0x464`, `0x434 + 12 * 48 == 0x674`.
  const own = splitPairUrgency(player, urgency, 1, 12, 11);
  // tail @0x587af: fisher staff against its own sites.
  const crew = u16(clampMax(idle(player, SRF.Generic), stock(player, RES.Rod))
    + idle(player, SRF.Fisher));
  if (crew <= site(player, BLD.Fisher)) return; // `sub`/`jae` @0x587f9 — else `ret`
  player.aiUrgency[0] = mulHigh(own, pressure(player, 0));
}

/**
 * Splitting a shared urgency across an **evaluator pair** — the block that stands verbatim identical in
 * fisher (@0x586c3) and pig farm (@0x59e4f).
 *
 * The better of the two candidate rows gets the full urgency, the weaker one a proportionally reduced
 * value (`(smaller << 16) / larger`, then `mulHigh` with the urgency). The partner slot is written
 * **raw** — without the pressure factor; only its own evaluator applies that later (farm @0x59a91,
 * mill @0x59fd1).
 *
 * @returns what is left for the **own** slot. In the partnerless case that is the candidate average of
 * the own row instead of the urgency — point 3 in the module head.
 */
function splitPairUrgency(
  player: Player, urgency: number, ownRow: number, mateRow: number, mateSlot: number,
): number {
  const ownAvg = candidateAverage(player, ownRow);
  const mateAvg = candidateAverage(player, mateRow);
  if (ownAvg === 0) {
    // Only the partner has candidates: it gets everything, the own slot nothing.
    player.aiUrgency[mateSlot] = mateAvg !== 0 ? urgency : 0;
    return 0;
  }
  if (mateAvg === 0) {
    // Only the own row has candidates. The original zeroes the partner here and leaves the
    // **average** in the register (`vreg1` was never overwritten) — see the module head.
    player.aiUrgency[mateSlot] = 0;
    return ownAvg;
  }
  if (mateAvg === ownAvg) {
    player.aiUrgency[mateSlot] = urgency;
    return urgency;
  }
  if (mateAvg < ownAvg) {
    player.aiUrgency[mateSlot] = mulHigh(Math.floor((mateAvg * 0x10000) / ownAvg), urgency);
    return urgency;
  }
  player.aiUrgency[mateSlot] = urgency;
  return mulHigh(Math.floor((ownAvg * 0x10000) / mateAvg), urgency);
}

/**
 * **Lumberjack** — `FUN_00058833` @0x58833, slot 1.
 *
 * ```
 * staff = min(generics, axes) + idle lumberjacks
 * staff <= lumberjack sites                                  -> nothing    @0x5887d
 * no lumberjack (completed + sites == 0)  => urgency = 0xffff              @0x58896
 * have = timber + planks
 *      + (min(boat builders, 0x1fff)*8 * supply[0])  >> 16
 *      + (min(tool makers, 0x1fff)*8 * supply[11]) >> 16
 * need = 4*(tool makers completed + fortress sites)
 *      + 2*(boat builders completed + sum of large sites)
 *      + sum of small sites
 * urgency = curve(satSub(have, need))
 * ```
 *
 * The need is a **plank estimate**: a fortress under construction devours the most, large buildings
 * count double, small ones once. That the two groups hit exactly `LARGE_TYPES`/the rest from
 * `build-site.ts` is independent evidence for the offset reading.
 *
 * **The special case "no lumberjack" is the only fixed `0xffff` of the whole family** — without timber
 * the economy stops; that is the one real emergency.
 */
export function aiLumberjackUrgency(_state: GameState, player: Player): void {
  const crew = u16(clampMax(idle(player, SRF.Generic), stock(player, RES.Axe))
    + idle(player, SRF.Lumberjack));
  if (crew <= site(player, BLD.Lumberjack)) return; // @0x5887d
  if (both(player, BLD.Lumberjack) === 0) {
    player.aiUrgency[1] = 0xffff; // `mov $0xffff,%ax` @0x58896
    return;
  }
  let have = satAdd(stock(player, RES.Lumber), stock(player, RES.Plank));
  have = satAdd(have, mulHigh(u16(clampMax(done(player, BLD.Boatbuilder), 0x1fff) << 3),
    supply(player, 0)));
  have = satAdd(have, mulHigh(u16(clampMax(done(player, BLD.Toolmaker), 0x1fff) << 3),
    supply(player, 11)));
  let need = satAdd(done(player, BLD.Toolmaker), site(player, BLD.Fortress));
  need = satAdd(need, need);
  need = satAdd(need, done(player, BLD.Boatbuilder));
  for (const t of LARGE_SITES) need = satAdd(need, site(player, t));
  need = satAdd(need, need);
  for (const t of SMALL_SITES) need = satAdd(need, site(player, t));
  // NO base offset here. @0x58af8 is `66 01 47 04  add %ax,0x4(%edi)`, i.e. the LAST summand of the
  // small sites (`incomplete[10]`, hut, displacement 0x46 == 0x32 + 2*10), followed only by the carry
  // branch `jae 0x58b06` @0x58afc and the difference `sub %ax,(%edi)` @0x58b0a. A base of 8 occurs in
  // NO encoding anywhere in the body `[0x58833,0x58ba8)` (searched mechanically), and it does not come
  // from a register either: every `add %ax,0x4(%edi)` is preceded by a `mov <disp>(%ebx),%ax`. It
  // cannot come from the caller — `0x4(%edi)` is set by a `mov` @0x58972. The base belongs to the
  // STONECUTTER (`addw $0x8,0x4(%edi)` @0x58e4e), where it does stand.
  player.aiUrgency[1] = mulHigh(rampUrgency(satSub(have, need), AI_RAMPS[0x58833] ?? []),
    pressure(player, 1));
}

/**
 * **Boat builder** — `FUN_00058ba8` @0x58ba8, slot 2. The only evaluator with **fixed** steps instead
 * of a curve, and the only one that adjusts something else on the side.
 *
 * ```
 * staff = min(generics, hammers) + idle boat builders
 * staff <= boat builder sites                                -> nothing    @0x58bf2
 * boats == 0 => 35000 / boats < 2 => 20000 / boats < 8 => curve / else 0
 * planksDistribution[1] = urgency                                          @0x58c50
 * ```
 *
 * The write to `planksDistribution[1]` is the **boat builder's plank priority** — the AI sets the
 * distribution slider to the same value it computes as urgency. That is also the third independent
 * piece of evidence that slot 2 is the boat builder: `0x14a` is the plank distribution's second entry.
 */
export function aiBoatbuilderUrgency(_state: GameState, player: Player): void {
  const crew = u16(clampMax(idle(player, SRF.Generic), stock(player, RES.Hammer))
    + idle(player, SRF.BoatBuilder));
  if (crew <= site(player, BLD.Boatbuilder)) return; // @0x58bf2
  const boats = stock(player, RES.Boat);
  let urgency: number;
  if (boats === 0) urgency = 35000; // `mov $0x88b8,%ax` @0x58c07
  else if (boats < 2) urgency = 20000; // `mov $0x4e20,%ax` @0x58c19
  else urgency = rampUrgency(boats, AI_RAMPS[0x58ba8] ?? []);
  if (player.planksDistribution !== undefined) player.planksDistribution[1] = urgency; // @0x58c50
  player.aiUrgency[2] = mulHigh(urgency, pressure(player, 2));
}

/**
 * **Stonecutter** — `FUN_00058c89` @0x58c89, slot 3.
 *
 * ```
 * staff = min(generics, picks)
 * no completed coal mine => staff-- (saturating)                        @0x58cbe
 * no completed iron mine => staff-- (saturating)                        @0x58cd0
 * open mine sites beyond the idle miners are deducted from the staff    @0x58d15
 * staff += idle stonecutters
 * staff <= stonecutter sites                                -> nothing  @0x58d53
 * need = 2*(2*fortress sites + sum of large sites)
 *      + stone mine sites + hut sites + 8
 * urgency = curve(satSub(stone, need))
 *         * min(average(row 4), 0x3ff)*64                     @0x58efd (`mul %cx`)
 * ```
 *
 * The staff calculation is the interesting part: the stonecutter **competes with the mines for picks
 * and miners**, hence the two decrements and the deduction of the open mine sites.
 */
export function aiStonecutterUrgency(_state: GameState, player: Player): void {
  let crew = clampMax(idle(player, SRF.Generic), stock(player, RES.Pick));
  if (done(player, BLD.CoalMine) === 0) crew = satDec(crew); // @0x58cbe
  if (done(player, BLD.IronMine) === 0) crew = satDec(crew); // @0x58cd0
  const openMines = mineSites(player);
  if (idle(player, SRF.Miner) <= openMines) {
    crew = satSub(crew, u16(openMines - idle(player, SRF.Miner))); // @0x58d15
  }
  crew = u16(crew + idle(player, SRF.Stonecutter));
  if (crew <= site(player, BLD.Stonecutter)) return; // @0x58d53
  let need = satAdd(site(player, BLD.Fortress), site(player, BLD.Fortress));
  for (const t of LARGE_SITES) {
    if (t === BLD.StoneMine || t === BLD.CoalMine || t === BLD.IronMine || t === BLD.GoldMine) {
      continue; // the mines are not part of the large group here, see below
    }
    need = satAdd(need, site(player, t));
  }
  need = satAdd(need, need);
  need = satAdd(need, site(player, BLD.StoneMine)); // `0x3a` — the ONLY mine, and added plainly
  need = satAdd(need, site(player, BLD.Hut));
  need = satAdd(need, 8);
  let urgency = rampUrgency(satSub(stock(player, RES.Stone), need), AI_RAMPS[0x58c89] ?? []);
  // Row 4 (stonecutter): `add $0x4f4,%esi` @0x58ed0, and `0x434 + 4 * 48 == 0x4f4`.
  urgency = mulHigh(urgency, u16(clampMax(candidateAverage(player, 4), 0x3ff) << 6));
  player.aiUrgency[3] = mulHigh(urgency, pressure(player, 3));
}

/**
 * The mine demand that stone mine..gold mine build in common — identical to the stonecutter's demand
 * (@0x58f99 and @0x58d4d are the same arithmetic), hence a helper.
 */
function stoneDemand(player: Player): number {
  let need = satAdd(site(player, BLD.Fortress), site(player, BLD.Fortress));
  for (const t of LARGE_SITES) {
    if (t === BLD.StoneMine || t === BLD.CoalMine || t === BLD.IronMine || t === BLD.GoldMine) continue;
    need = satAdd(need, site(player, t));
  }
  need = satAdd(need, need);
  need = satAdd(need, site(player, BLD.StoneMine));
  need = satAdd(need, site(player, BLD.Hut));
  return satAdd(need, 8);
}

/**
 * The shared staff gate of the four mine evaluators (@0x58f50 ff. and siblings).
 *
 * @returns `null` when the evaluator has to bail out, otherwise the number of free miners beyond the
 * open mine sites.
 */
function minerCrew(player: Player, requireCoal: boolean, requireIron: boolean): number | null {
  let crew = clampMax(idle(player, SRF.Generic), stock(player, RES.Pick));
  const openCutters = site(player, BLD.Stonecutter);
  if (idle(player, SRF.Stonecutter) <= openCutters) {
    crew = satSub(crew, u16(openCutters - idle(player, SRF.Stonecutter)));
  }
  crew = u16(crew + idle(player, SRF.Miner));
  if (requireCoal && done(player, BLD.CoalMine) === 0) {
    if (crew === 0) return null; // `subw $0x1 ; jae` — at 0 the original bails out here
    crew = u16(crew - 1);
  }
  if (requireIron && done(player, BLD.IronMine) === 0) {
    if (crew === 0) return null;
    crew = u16(crew - 1);
  }
  const open = mineSites(player);
  if (crew <= open) return null;
  return u16(crew - open);
}

/**
 * **Stone mine** — `FUN_00058f40` @0x58f40, slot 4. The only mine evaluator with two exits: if the
 * stone stock does not cover the open sites, the score is **scaled up**; if it does, the stock is
 * subtracted.
 *
 * ```
 * score = topPair(row 5)
 * stone < need => min(score, 0xfef) * 16                         @0x59132
 * otherwise    => satSub(min(score, 7999), stone*16) * 8         @0x59148
 * ```
 */
export function aiStoneMineUrgency(_state: GameState, player: Player): void {
  if (minerCrew(player, true, true) === null) return;
  // Row 5 (stone mine): `add $0x524,%esi` @0x59004, and `0x434 + 5 * 48 == 0x524`.
  const score = candidateTopPair(player, 5);
  const need = stoneDemand(player);
  let value: number;
  if (stock(player, RES.Stone) < need) {
    value = u16(clampMax(score, 0xfef) << 4); // @0x59132
  } else {
    value = u16(satSub(clampMax(score, 7999), u16(stock(player, RES.Stone) << 4)) << 3);
  }
  player.aiUrgency[4] = mulHigh(value, pressure(player, 4));
}

/**
 * **Coal mine** — `FUN_000591a8` @0x591a8, slot 5.
 *
 * ```
 * score = min(topPair(row 6), 7999)
 * score = satSub(score, coal * 4) * 8            @0x59291 (`sub %ax,(%edi)`)
 * ```
 *
 * The overflow guard after it (`(old << 2) < 0` @0x592a1) is **unreachable**: the clamp 7999 ==
 * `0x1f3f` sits below the tested bit `0x2000`. It stands in the port because it stands in the original
 * — point 4 in the module head.
 */
export function aiCoalMineUrgency(_state: GameState, player: Player): void {
  if (minerCrew(player, false, true) === null) return;
  // Row 6 (coal mine): `add $0x554,%esi` @0x59257, `0x434 + 6 * 48 == 0x554`.
  let value = clampMax(candidateTopPair(player, 6), 7999);
  value = satSub(value, u16(stock(player, RES.Coal) << 2));
  const before = value;
  value = u16(value << 3);
  if ((before & 0x2000) !== 0) value = 0xffff; // unreachable, see above
  player.aiUrgency[5] = mulHigh(value, pressure(player, 5));
}

/** **Iron mine** — `FUN_000592dc` @0x592dc, slot 6. Like the coal mine, with iron ore * 8. */
export function aiIronMineUrgency(_state: GameState, player: Player): void {
  if (minerCrew(player, true, false) === null) return;
  // Row 7 (iron mine): `add $0x584,%esi` @0x5938b, `0x434 + 7 * 48 == 0x584`.
  let value = clampMax(candidateTopPair(player, 7), 7999);
  value = satSub(value, u16(stock(player, RES.IronOre) << 3));
  const before = value;
  value = u16(value << 3);
  if ((before & 0x2000) !== 0) value = 0xffff; // unreachable, see above
  player.aiUrgency[6] = mulHigh(value, pressure(player, 6));
}

/**
 * **Gold mine** — `FUN_00059410` @0x59410, slot 7. The only one that requires **both** other ore works,
 * and it clamps to `0x7f7` so the shift by 5 does not overflow.
 */
export function aiGoldMineUrgency(_state: GameState, player: Player): void {
  if (minerCrew(player, true, true) === null) return;
  // Row 8 (gold mine): `add $0x5b4,%esi` @0x594d2, `0x434 + 8 * 48 == 0x5b4`.
  let value = clampMax(candidateTopPair(player, 8), 0x7f7);
  value = satSub(value, stock(player, RES.GoldOre));
  const before = value;
  value = u16(value << 5);
  if ((before & 0x800) !== 0) value = 0xffff; // unreachable (clamp 0x7f7 < 0x800)
  player.aiUrgency[7] = mulHigh(value, pressure(player, 7));
}

/**
 * **Forester** — `FUN_00059552` @0x59552, slot 8. The evaluator with the clearest domain logic: it
 * compares **lumberjacks against foresters** and replants when too much is being felled.
 *
 * ```
 * staff = generics + idle foresters ; <= forester sites      -> nothing   @0x59580
 * logs  = lumberjacks (completed + sites)
 * frst  = foresters   (completed + sites)
 * frst < logs => urgency = min(average(row 9), 1999) * 32                 @0x59612
 * frst == 0   => urgency = 0                                             @0x595ce
 * otherwise   => (((logs << 16) - 1) / frst) >> 5                        @0x595ea
 * ```
 *
 * The last branch is a ratio "how many lumberjacks per forester" — the more, the more urgent.
 */
export function aiForesterUrgency(_state: GameState, player: Player): void {
  const crew = u16(idle(player, SRF.Generic) + idle(player, SRF.Forester));
  if (crew <= site(player, BLD.Forester)) return; // @0x59580
  const loggers = u16(site(player, BLD.Lumberjack) + done(player, BLD.Lumberjack));
  const foresters = u16(site(player, BLD.Forester) + done(player, BLD.Forester));
  let value: number;
  if (foresters < loggers) {
    // Row 9 (forester): `add $0x5e4,%esi` @0x595fd, `0x434 + 9 * 48 == 0x5e4`.
    value = u16(clampMax(candidateAverage(player, 9), 1999) << 5);
  } else if (foresters === 0) {
    player.aiUrgency[8] = 0; // `je 0x59624` @0x595ce, straight to the target field
    return;
  } else if (loggers !== 0) {
    value = (Math.floor((loggers * 0x10000 - 1) / foresters) & 0xffff) >>> 5;
  } else {
    value = 0; // `vreg0` is == loggers == 0 here
  }
  player.aiUrgency[8] = mulHigh(value, pressure(player, 8));
}

/**
 * **Warehouse** — `FUN_00059656` @0x59656, slot 9. Estimates the **transport load** from the building
 * stock and holds it against the existing warehouses.
 *
 * ```
 * load = 2*(mines + smelters + tool maker + weapon smith, completed and sites)
 *      +   (all other production buildings, completed and sites)              @0x596a0
 * planks > 0x4f  => load = (load >> 4) + 4                                    @0x5984c
 * planks < 0x28  => load < 0x20 => 0 / load < 0x40 => ((load-0x20) >> 3) + 2  @0x5987d
 * otherwise      => load = (load >> 4) + 2
 * urgency = min(ratio(load, warehouses), 0xfeaf)                              @0x59915
 * ```
 *
 * The plank staging is a **build brake**: with little timber the AI does not want to start a warehouse
 * unless the load really is high.
 */
export function aiWarehouseUrgency(_state: GameState, player: Player): void {
  if (idle(player, SRF.Generic) <= site(player, BLD.Warehouse)) return; // @0x59677
  const heavy = [BLD.StoneMine, BLD.CoalMine, BLD.IronMine, BLD.GoldMine, BLD.SteelSmelter,
    BLD.Toolmaker, BLD.WeaponSmith, BLD.GoldSmelter] as const;
  let load = 0;
  for (const t of heavy) load = u16(load + site(player, t) + done(player, t));
  load = satAdd(load, load); // x2 `add %ax,(%edi)` @0x5971b
  const light = [BLD.Fisher, BLD.Lumberjack, BLD.Boatbuilder, BLD.Stonecutter, BLD.Farm,
    BLD.Butcher, BLD.PigFarm, BLD.Mill, BLD.Baker, BLD.Sawmill] as const;
  for (const t of light) {
    load = satAdd(load, site(player, t));
    load = satAdd(load, done(player, t));
  }
  const planks = stock(player, RES.Plank);
  if (planks > 0x4f) load = u16((load >>> 4) + 4); // @0x5984c
  // `mov $0x0,%eax` @0x59887 + `mov %eax,(%edi)` @0x5988c set the load to 0 and then fall THROUGH to
  // `mov 0x30(%edi),%ebx` @0x5988e — no `jmp`, no `ret`, no `call`. That 0x5988e is an instruction
  // boundary is shown independently by the three `jmp 0x5988e` @0x59854/@0x59877/@0x59885; the
  // routine's only two `ret` are @0x59677 and @0x5995b. Returning here would be a third exit that does
  // not exist in the binary. With load 0, `jae 0x598e5` @0x598ab always holds and the surplus branch
  // yields `min(0x1000 - 256*warehouses, 0xfeaf)`, i.e. 4096 with no warehouse. That is reachable
  // structurally: at the start of a game the load is 0 and `planks < 0x28` is the normal case.
  else if (planks < 0x28 && load < 0x20) load = 0;
  else if (planks < 0x28 && load < 0x40) load = u16(((load - 0x20) >>> 3) + 2);
  else load = u16((load >>> 4) + 2);
  const capacity = u16(site(player, BLD.Warehouse) + done(player, BLD.Warehouse));
  const value = clampMax(ratioUrgency(load, capacity, AI_RATIOS[0x59656] as AiRatioShape), 0xfeaf);
  player.aiUrgency[9] = mulHigh(value, pressure(player, 9));
}

/** The shared military staff gate of hut, watchtower and fortress (@0x5995f ff.). */
function knightCrew(player: Player): number | null {
  let crew = clampMax(idle(player, SRF.Generic), stock(player, RES.Sword));
  crew = clampMax(crew, stock(player, RES.Shield));
  for (let rank = 0; rank < 5; rank++) crew = u16(crew + idle(player, SRF.Knight0 + rank));
  const open = u16(site(player, BLD.Hut) + site(player, BLD.Tower) + site(player, BLD.Fortress));
  return crew <= open ? null : crew;
}

/**
 * **Guard hut** — `FUN_0005995c` @0x5995c, slot 10. The only evaluator whose upper bound is a
 * **character trait**: `aiHutUrgencyCap` (observed 60000/63000/64000) clamps the result, so an
 * aggressive opponent may push for huts harder than a peaceful one.
 */
export function aiHutUrgency(_state: GameState, player: Player): void {
  if (knightCrew(player) === null) return;
  // Row 11 (hut): `add $0x644,%esi` @0x59a14, `0x434 + 11 * 48 == 0x644`.
  let value = clampMax(candidateAverage(player, 11), 0x3fff);
  value = u16(value + value);
  value = u16(value + value); // x4 @0x59a3a
  if (player.aiHutUrgencyCap <= value) value = player.aiHutUrgencyCap; // @0x59a46/@0x59a55
  player.aiUrgency[10] = mulHigh(value, pressure(player, 10));
}

/**
 * **Farm** — `FUN_00059a91` @0x59a91, slot 11. No arithmetic of its own: it takes what the fisher
 * evaluator put into its slot, checks **its** staff and applies the pressure factor. If the staff gate
 * fails, the slot is explicitly **zeroed** — otherwise the fisher's raw value would stand as urgency.
 */
export function aiFarmUrgency(_state: GameState, player: Player): void {
  const crew = u16(clampMax(idle(player, SRF.Generic), stock(player, RES.Scythe))
    + idle(player, SRF.Farmer));
  if (crew <= site(player, BLD.Farm)) {
    player.aiUrgency[11] = 0; // `mov %ax,0x3e6(%ebx)` @0x59ae3
    return;
  }
  player.aiUrgency[11] = mulHigh(player.aiUrgency[11] ?? 0, pressure(player, 11));
}

/**
 * **Butcher** — `FUN_00059b2a` @0x59b2a, slot 12: slaughter capacity against pig supply, plus a base
 * from the pig stock (every pig in store wants processing).
 */
export function aiButcherUrgency(_state: GameState, player: Player): void {
  const crew = u16(clampMax(idle(player, SRF.Generic), stock(player, RES.Cleaver))
    + idle(player, SRF.Butcher));
  if (crew <= site(player, BLD.Butcher)) return; // @0x59b76
  const pigFarms = u16(done(player, BLD.PigFarm) + site(player, BLD.PigFarm));
  const capacity = u16(clampMax(u16(done(player, BLD.Butcher) + site(player, BLD.Butcher)),
    0x3fff) << 2);
  const value = ratioUrgency(pigFarms, capacity, AI_RATIOS[0x59b2a] as AiRatioShape);
  const pigs = u16(clampMax(stock(player, RES.Pig), 0x1ff) << 7);
  player.aiUrgency[12] = mulHigh(satAdd(pigs, value), pressure(player, 12));
}

/**
 * **Pig farm, with the mill riding on top** — `FUN_00059c88` @0x59c88, slots 13 and 14. The second
 * evaluator pair (the splitting block stands verbatim as in the fisher).
 *
 * ```
 * staff = generics + idle pig farmers ; <= sites            -> nothing   @0x59cb6
 * farms = min(farm completed + sites, 0x3fff) ; == 0        -> nothing   @0x59cdf
 * offer = farms*4 + ((wheat + 0x20) >> 6)
 * need  = 12*(mill completed + sites) + 3*(pig farm completed + sites)
 * value = min(wheat, 0x1ff)*128 + ratio(offer, need)
 * ```
 *
 * Wheat counts **twice**: once coarsely as a supply bonus (`>> 6`) and once as a base (`<< 7`). That is
 * not a liberty of the port — they are two separate blocks in the original (@0x59ce9 and @0x59e1e).
 */
export function aiPigFarmUrgency(_state: GameState, player: Player): void {
  const crew = u16(idle(player, SRF.Generic) + idle(player, SRF.PigFarmer));
  if (crew <= site(player, BLD.PigFarm)) return; // @0x59cb6
  const farms = clampMax(u16(done(player, BLD.Farm) + site(player, BLD.Farm)), 0x3fff);
  if (farms === 0) return; // `jne 0x59ce2` @0x59cdf
  let offer = u16(farms << 2);
  const wheatBoost = (satAdd(stock(player, RES.Wheat), 0x20)) >>> 6;
  offer = satAdd(offer, wheatBoost);
  let need = u16(done(player, BLD.Mill) + site(player, BLD.Mill));
  need = satAdd(need, need); // x2
  const quad = satAdd(need, need); // x4
  need = satAdd(satAdd(quad, quad), quad); // x12 — @0x59d23..@0x59d5c
  const pigFarms = u16(done(player, BLD.PigFarm) + site(player, BLD.PigFarm));
  need = satAdd(need, satAdd(satAdd(pigFarms, pigFarms), pigFarms)); // + 3x @0x59d63..@0x59d9c
  let value = ratioUrgency(offer, need, AI_RATIOS[0x59c88] as AiRatioShape);
  value = satAdd(u16(clampMax(stock(player, RES.Wheat), 0x1ff) << 7), value);
  // Split across pig farm (row 14) and mill (row 15): `add $0x6d4,%esi` @0x59e4f and
  // `add $0x704,%esi` @0x59e6b; `0x434 + 14 * 48 == 0x6d4`, `0x434 + 15 * 48 == 0x704`.
  const own = splitPairUrgency(player, value, 14, 15, 14);
  player.aiUrgency[13] = mulHigh(own, pressure(player, 13));
}

/**
 * **Mill** — `FUN_00059fd1` @0x59fd1, slot 14. The pig farm's partner tail, built like the farm: staff
 * gate, then the pressure factor on the raw value.
 */
export function aiMillUrgency(_state: GameState, player: Player): void {
  const crew = u16(idle(player, SRF.Generic) + idle(player, SRF.Miller));
  if (crew <= site(player, BLD.Mill)) {
    player.aiUrgency[14] = 0; // @0x5a005
    return;
  }
  player.aiUrgency[14] = mulHigh(player.aiUrgency[14] ?? 0, pressure(player, 14));
}

/** **Bakery** — `FUN_0005a04c` @0x5a04c, slot 15: baking capacity against mills, base from flour. */
export function aiBakerUrgency(_state: GameState, player: Player): void {
  const crew = u16(idle(player, SRF.Generic) + idle(player, SRF.Baker));
  if (crew <= site(player, BLD.Baker)) return; // @0x5a07a
  const mills = u16(done(player, BLD.Mill) + site(player, BLD.Mill));
  const bakers = u16(done(player, BLD.Baker) + site(player, BLD.Baker));
  const value = ratioUrgency(mills, bakers, AI_RATIOS[0x5a04c] as AiRatioShape);
  const flour = u16(clampMax(stock(player, RES.Flour), 0x1ff) << 7);
  player.aiUrgency[15] = mulHigh(satAdd(flour, value), pressure(player, 15));
}

/**
 * **Sawmill** — `FUN_0005a177` @0x5a177, slot 16. Its supply is "lumberjacks plus a coarse timber
 * stock", its capacity **three times** the sawmills — one sawmill processes more than one lumberjack
 * delivers.
 */
export function aiSawmillUrgency(_state: GameState, player: Player): void {
  const crew = u16(clampMax(idle(player, SRF.Generic), stock(player, RES.Saw))
    + idle(player, SRF.Sawmiller));
  if (crew <= site(player, BLD.Sawmill)) return; // @0x5a1c3
  let offer = u16(done(player, BLD.Lumberjack) + site(player, BLD.Lumberjack));
  offer = satAdd(offer, satAdd(stock(player, RES.Lumber), 0x20) >>> 5); // @0x5a1c4
  const mills = u16(done(player, BLD.Sawmill) + site(player, BLD.Sawmill));
  const capacity = satAdd(satAdd(mills, mills), mills); // x3 @0x5a220..@0x5a23a
  let value = ratioUrgency(offer, capacity, AI_RATIOS[0x5a177] as AiRatioShape);
  value = satAdd(u16(clampMax(stock(player, RES.Lumber), 0x1ff) << 7), value);
  player.aiUrgency[16] = mulHigh(value, pressure(player, 16));
}

/**
 * **Steel smelter** — `FUN_0005a316` @0x5a316, slot 17. Its "supply" is the **bottleneck** between coal
 * and iron mines, averaged with the ore stock:
 *
 * ```
 * offer = (min(coal mines, iron mines) + (min(iron ore, coal) >> 4) + 1) >> 1   @0x5a38a
 * ```
 *
 * Both smelter kinds share the same staff (smelters) and the same site gate.
 */
export function aiSteelSmelterUrgency(_state: GameState, player: Player): void {
  const crew = u16(idle(player, SRF.Generic) + idle(player, SRF.Smelter));
  const open = u16(site(player, BLD.SteelSmelter) + site(player, BLD.GoldSmelter));
  if (crew <= open) return; // @0x5a34f
  const coal = both(player, BLD.CoalMine);
  const iron = both(player, BLD.IronMine);
  let offer = clampMax(coal, iron);
  const ore = clampMax(stock(player, RES.IronOre), stock(player, RES.Coal)) >>> 4;
  offer = u16(u16(u16(offer + ore) + 1) >>> 1);
  const capacity = u16(done(player, BLD.SteelSmelter) + site(player, BLD.SteelSmelter));
  let value = ratioUrgency(offer, capacity, AI_RATIOS[0x5a316] as AiRatioShape);
  value = satAdd(u16(clampMax(stock(player, RES.IronOre), 0x3ff) << 6), value);
  player.aiUrgency[17] = mulHigh(value, pressure(player, 17));
}

/**
 * **Tool maker** — `FUN_0005a4b3` @0x5a4b3, slot 18. The only evaluator that reads the **player's tool
 * sliders**: the base value is the **maximum** over `toolPriority[0..8]` (`player-0x80`..`-0x70`) —
 * whatever the human needs most urgently drives the AI too.
 *
 * With no tool maker yet, that maximum stands. Otherwise it is weighted by a material factor:
 *
 * ```
 * material = min(planks, steel) + min(lumberjacks, iron mines)*16
 *          - (tool makers completed + sites)*64                          @0x5a6a6
 * factor   = min(material, 0xf) * 4096                     @0x5a6bd, @0x5a6cc/@0x5a6d1
 * ```
 */
export function aiToolmakerUrgency(_state: GameState, player: Player): void {
  let crew = clampMax(idle(player, SRF.Generic), stock(player, RES.Saw));
  crew = u16(clampMax(crew, stock(player, RES.Hammer)) + idle(player, SRF.Toolmaker));
  if (crew <= site(player, BLD.Toolmaker)) return; // @0x5a51d
  let value = 0;
  for (const prio of player.toolPriority ?? []) value = value < prio ? prio : value; // max @0x5a534
  if (both(player, BLD.Toolmaker) !== 0) {
    let material = clampMax(stock(player, RES.Plank), stock(player, RES.Steel));
    const chain = clampMax(both(player, BLD.Lumberjack), both(player, BLD.IronMine));
    material = u16(material + u16(chain << 4));
    material = satSub(material, u16(both(player, BLD.Toolmaker) << 6));
    const factor = u16(u16(clampMax(material, 0xf) << 8) << 4);
    value = mulHigh(value, factor);
  }
  player.aiUrgency[18] = mulHigh(value, pressure(player, 18));
}

/**
 * **Weapon smith** — `FUN_0005a723` @0x5a723, slot 19. Two factors: a curve over the **weapon stock**
 * (the bottleneck between swords and shields) and a material factor like the tool maker's, here with a
 * base of 4000.
 */
export function aiWeaponSmithUrgency(_state: GameState, player: Player): void {
  let crew = clampMax(idle(player, SRF.Generic), stock(player, RES.Pincer));
  crew = u16(clampMax(crew, stock(player, RES.Hammer)) + idle(player, SRF.WeaponSmith));
  if (crew <= site(player, BLD.WeaponSmith)) return; // @0x5a78d
  const weapons = clampMax(stock(player, RES.Sword), stock(player, RES.Shield));
  let value = rampUrgency(weapons, AI_RAMPS[0x5a723] ?? []);
  let material = u16(clampMax(stock(player, RES.Steel), stock(player, RES.Coal)) + 7);
  const chain = clampMax(both(player, BLD.CoalMine), both(player, BLD.IronMine));
  material = u16(material + u16(chain << 3));
  material = satSub(material, u16(both(player, BLD.WeaponSmith) << 4));
  const factor = u16(u16(u16(clampMax(material, 0xf) << 8) << 4) + 4000); // @0x5a8d5
  value = mulHigh(value, factor);
  player.aiUrgency[19] = mulHigh(value, pressure(player, 19));
}

/**
 * **Watchtower, with the fortress riding on top** — `FUN_0005a928` @0x5a928, slots 20 and 21. The third
 * evaluator pair, but **built differently** from the other two: it splits nothing, writes the partner
 * slot with the **raw** value (@0x5ab58) and multiplies only for itself.
 *
 * ```
 * aiKnightOccupationLevel < 8                               -> nothing   @0x5a92b
 * staff (knight gate) ; <= military sites                   -> nothing   @0x5a9ea
 * economy  = sum of completed production buildings + min(warehouses, 0x1fff)*8   @0x5aa78
 * military = min((fortresses + 1)*2 + towers, 0x7ff) * 8                         @0x5aacc
 * value    = ratio(economy, military)
 * ```
 *
 * In domain terms: the more economy stands behind the border, the more urgently it needs solid cover.
 */
export function aiTowerUrgency(_state: GameState, player: Player): void {
  if (player.aiKnightOccupationLevel < 8) return; // `cmpw $0x8` @0x5a92b
  if (knightCrew(player) === null) return;
  const economy = [BLD.StoneMine, BLD.CoalMine, BLD.IronMine, BLD.GoldMine, BLD.Farm, BLD.Butcher,
    BLD.PigFarm, BLD.Baker, BLD.Sawmill, BLD.SteelSmelter, BLD.Toolmaker, BLD.WeaponSmith,
    BLD.GoldSmelter] as const;
  let value = 0;
  for (const t of economy) value = u16(value + done(player, t));
  value = satAdd(value, u16(clampMax(done(player, BLD.Warehouse), 0x1fff) << 3));
  let military = u16(done(player, BLD.Fortress) + 1);
  military = satAdd(military, military);
  military = satAdd(military, done(player, BLD.Tower));
  military = u16(clampMax(military, 0x7ff) << 3);
  const urgency = ratioUrgency(value, military, AI_RATIOS[0x5a928] as AiRatioShape);
  player.aiUrgency[21] = urgency; // partner slot RAW — @0x5ab58
  player.aiUrgency[20] = mulHigh(urgency, pressure(player, 20));
}

/**
 * **Fortress** — `FUN_0005ab96` @0x5ab96, slot 21. The watchtower's partner tail, with the **higher**
 * unlock value: `aiKnightOccupationLevel >= 10` instead of 8.
 */
export function aiFortressUrgency(_state: GameState, player: Player): void {
  if (player.aiKnightOccupationLevel < 10) return; // `cmpw $0xa` @0x5ab99
  if (knightCrew(player) === null) {
    player.aiUrgency[21] = 0; // @0x5ac5e
    return;
  }
  player.aiUrgency[21] = mulHigh(player.aiUrgency[21] ?? 0, pressure(player, 21));
}

/**
 * **Gold smelter** — `FUN_0005acab` @0x5acab, slot 22. Built like the steel smelter, with gold mines
 * instead of iron mines and gold ore as the base.
 */
export function aiGoldSmelterUrgency(_state: GameState, player: Player): void {
  const crew = u16(idle(player, SRF.Generic) + idle(player, SRF.Smelter));
  const open = u16(site(player, BLD.SteelSmelter) + site(player, BLD.GoldSmelter));
  if (crew <= open) return; // @0x5ace4
  const coal = both(player, BLD.CoalMine);
  const gold = both(player, BLD.GoldMine);
  let offer = clampMax(coal, gold);
  const ore = clampMax(stock(player, RES.GoldOre), stock(player, RES.Coal)) >>> 4;
  offer = u16(u16(u16(offer + ore) + 1) >>> 1);
  const capacity = u16(done(player, BLD.GoldSmelter) + site(player, BLD.GoldSmelter));
  let value = ratioUrgency(offer, capacity, AI_RATIOS[0x5acab] as AiRatioShape);
  value = satAdd(u16(clampMax(stock(player, RES.GoldOre), 0x3ff) << 6), value);
  player.aiUrgency[22] = mulHigh(value, pressure(player, 22));
}
