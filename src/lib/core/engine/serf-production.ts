/**
 * In-building production and mining — the serf state handlers a worker runs *inside* a building.
 * Split out of `serf-machine.ts` with unchanged behaviour; the 76-slot jump table and the dispatch
 * stay there and wire these handlers up.
 *
 * State -> routine:
 *   24 Sawing (@0x1c001) / 38 Butchering (@0x198ab) — single duration (`singleDurationProcess`)
 *   35 Milling (@0x19e6e) · 36 Baking (@0x19c97) · 30 Smelting (@0x1a736) · 39 MakingWeapon (@0x196c1)
 *   40 MakingTool (@0x19407) · 37 PigFarming (@0x199c4) · 41 BuildingBoat (@0x19204) — multi-step
 *   29 Mining (@0x1a910) — a sub state machine (`miningSearch`)
 *
 * The shared ending `finishProduction` (the byte-identical tail of 24/30/35/36/38 plus mining and
 * tool making): pick the product up, raise the production statistics, move into MoveResourceOut (11).
 *
 * The counter, stock and union primitives come from `serf-machine.ts`.
 */
import type { GameState, Serf } from './state.js';
import { posOf, neighbor, Direction } from './position.js';
import { spiralPos } from './spiral.js';
import { addPlayerMessage } from './player-messages.js';
import { demolishBuilding } from './buildings.js';

/** `flags` bit 7 — AI player (verified against real saves). */
const PLAYER_FLAG_AI = 1 << 7;
/** "Mine exhausted" (`addw $0x4` @0x1ad64); the upper 3 bits carry the mine kind `type - 5`. */
const MSG_MINE_EXHAUSTED = 4;
import {
  advance,
  setUnionU8,
  setUnionU16,
  addCounterContinue,
  rawByte9,
  setByte9,
  moveResourceOutStep,
} from './serf-machine.js';

/**
 * The shared ending of in-building production (the byte-identical tail of states 24/30/35/36/38):
 * pick the product up, raise the player's production statistics, move into MoveResourceOut (11) and
 * try the first step out. `outResPlus1` is `res + 1`, the carrying convention — the byte the original
 * stores in `serf[0xb]` (8 = plank, 3 = meat).
 */
export function finishProduction(state: GameState, serf: Serf, outResPlus1: number): void {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  state.mapTiles[pos].serfIndex = 0; // ptr_b[pos+2] = 0 (the tile's serf slot is freed)
  setUnionU8(serf, 0xb, outResPlus1);
  setUnionU16(serf, 0xc, 0); // field_0xc/0xd = 0
  setUnionU8(serf, 0xf, 0xd); // follow-up state = 13 DropResourceOut
  // Produktions-Statistik: player.resourceCount[res]++ (clamp 0xff), res = (serf[0xb]&0x1f)−1.
  const player = state.players[serf.owner];
  if (player) {
    const res = (outResPlus1 & 0x1f) - 1;
    const rc = player.resourceCount as number[];
    if (res >= 0 && res < rc.length && rc[res] !== 0xff) rc[res] = (rc[res] + 1) & 0xff;
  }
  serf.state = 0xb; // MoveResourceOut
  moveResourceOutStep(state, serf);
}

/**
 * Single-duration processor `serf_state_24_Sawing` (@0x1c001) / `serf_state_38_Butchering`
 * (@0x198ab):
 * - **Phase A** (`field_0xb == 0`): check one input in the building stock (high nibble) and consume
 *   it; set the work animation and a fixed duration; register the serf on the tile. No input means
 *   waiting (animation unchanged, retried on the next dispatch).
 * - **Phase B** (`field_0xb != 0`): tick gate; when it elapses, carry the product out
 *   (`finishProduction`).
 *
 * No active bit and no multi-step loop — that is what separates sawing and butchering from the
 * multi-step processors milling, baking and smelting.
 */
function singleDurationProcess(
  state: GameState,
  serf: Serf,
  stockSlot: 0 | 1,
  anim: number,
  duration: number,
  outResPlus1: number,
): void {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (serf.stateData[0] === 0) {
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (!bld) return;
    if (bld.stock[stockSlot].available === 0) return; // no input -> wait
    bld.stock[stockSlot].available -= 1;
    setUnionU8(serf, 0xb, 0xff); // ~0 -> phase B
    serf.animation = anim;
    serf.counter = duration;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index; // ptr_b[pos+2] = serfIndex
    return;
  }
  if (!advance(serf, state.gameTick)) return;
  finishProduction(state, serf, outResPlus1);
}

// 24 Sawing (sawmill: lumber `stock[1]` -> plank 8) / 38 Butchering (butcher: pig `stock[0]` -> meat 3).
export const sawing = (state: GameState, serf: Serf): void => singleDurationProcess(state, serf, 1, 0x7c, 0x93f, 8);
export const butchering = (state: GameState, serf: Serf): void => singleDurationProcess(state, serf, 0, 0x8c, 0x5ff, 3);

/**
 * 36 Baking (`serf_state_36_Baking` @0x19c97) — a multi-step processor (flour `stock[0]` ->
 * bread 6). The step counter lives in `field_0xb`: phase A sets it to 1, phase B counts up and
 * finishes at 3. Intermediate steps set the active bit and reload the counter (`+= 0x5dc`, the
 * animation's run-out).
 */
export const baking = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (serf.stateData[0] === 0) {
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (!bld) return;
    if (bld.stock[0].available === 0) return; // no flour -> wait
    bld.stock[0].available -= 1;
    serf.stateData[0] = 1;
    serf.animation = 0x8a;
    serf.counter = 0x2ff;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index;
    return;
  }
  if (!advance(serf, state.gameTick)) return;
  for (;;) {
    serf.stateData[0] = (serf.stateData[0] + 1) & 0xff;
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (serf.stateData[0] === 3) {
      if (bld) bld.active = false;
      finishProduction(state, serf, 6); // Bread
      return;
    }
    if (bld) bld.active = true;
    state.mapTiles[pos].serfIndex = 0;
    const old = serf.counter;
    serf.counter = (serf.counter + 0x5dc) & 0xffff;
    if (old > 0xfa23) return; // counter still high -> next tick
  }
};

/**
 * 35 Milling (`serf_state_35_Milling` @0x19e6e) — a multi-step processor (wheat `stock[0]` ->
 * flour 5) with 5 steps in `field_0xb`. Phase A sets the active bit and step 1. Phase B: at 5 it is
 * done; at 3 the miller is briefly visible (registered on the tile, counter 0x17f); otherwise the
 * tile is freed and the counter reloaded with `+= 0x5dc`.
 */
export const milling = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (serf.stateData[0] === 0) {
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (!bld) return;
    if (bld.stock[0].available === 0) return;
    bld.active = true;
    bld.stock[0].available -= 1;
    serf.stateData[0] = 1;
    serf.animation = 0x89;
    serf.counter = 0x17f;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index;
    return;
  }
  if (!advance(serf, state.gameTick)) return;
  for (;;) {
    serf.stateData[0] = (serf.stateData[0] + 1) & 0xff;
    if (serf.stateData[0] === 5) {
      const bld = state.buildings[state.mapTiles[pos].objIndex];
      if (bld) bld.active = false;
      finishProduction(state, serf, 5); // Flour
      return;
    }
    if (serf.stateData[0] === 3) {
      serf.animation = 0x89;
      state.mapTiles[pos].serfIndex = serf.index;
      serf.counter = 0x17f;
      return;
    }
    state.mapTiles[pos].serfIndex = 0;
    const old = serf.counter;
    serf.counter = (serf.counter + 0x5dc) & 0xffff;
    if (!(old < 0xfa24)) return;
  }
};

/**
 * 30 Smelting (`serf_state_30_Smelting` @0x1a736) — Zwei-Eingang-Verarbeiter (Erz `stock[0]` + Kohle
 * `stock[1]`). `field_0xd` diskriminiert Stahl- (0 → Steel `0xc`, Anim 0x82) vs. Gold-Schmelze
 * (≠0 → GoldBar `0xf`, Anim 0x81). Der Schritt-Countdown liegt in `field_0xc` (0x14 Schritte,
 * Counter-Nachlauf `+= 0x180`).
 */
export const smelting = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (serf.stateData[0] === 0) {
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (!bld) return;
    if (bld.stock[0].available === 0) return; // Erz?
    if (bld.stock[1].available === 0) return; // Kohle?
    bld.active = true;
    bld.stock[0].available -= 1;
    bld.stock[1].available -= 1;
    serf.stateData[0] = 0xff; // ~0 → Phase B
    serf.animation = serf.stateData[2] !== 0 ? 0x81 : 0x82;
    serf.stateData[1] = 0x14; // field_0xc = Schritt-Countdown
    serf.counter = 0x17f;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index;
    return;
  }
  if (!advance(serf, state.gameTick)) return;
  for (;;) {
    const step = serf.stateData[1];
    serf.stateData[1] = (step - 1) & 0xff;
    if (step === 0) {
      const bld = state.buildings[state.mapTiles[pos].objIndex];
      if (bld) bld.active = false;
      finishProduction(state, serf, serf.stateData[2] !== 0 ? 0xf : 0xc); // GoldBar : Steel
      return;
    }
    if (serf.stateData[1] === 0) state.mapTiles[pos].serfIndex = 0;
    const old = serf.counter;
    serf.counter = (serf.counter + 0x180) & 0xffff;
    if (!(old < 0xfe80)) return;
  }
};

/**
 * 39 MakingWeapon (`serf_state_39_MakingWeapon` @0x196c1) — the weaponsmith (coal `stock[0]` plus
 * steel `stock[1]`). One batch of material yields **two** products in alternation: `bld[5]` bit 3
 * (`playingSfx`) switches between sword (0x19, bit clear) and shield (0x1a, bit set). Material is
 * consumed **only in the sword cycle** (bit clear in phase A); the shield cycle produces without
 * consuming. Step counter `field_0xb` runs 1 -> 7 (reload `+= 0x240`), the active bit is set in phase
 * A, cleared on completion, and bit 3 toggled.
 */
export const makingWeapon = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (serf.stateData[0] === 0) {
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (!bld) return;
    if (!bld.playingSfx) {
      // Sword cycle: coal and steel are needed and consumed.
      if (bld.stock[0].available === 0) return;
      if (bld.stock[1].available === 0) return;
      bld.stock[0].available -= 1;
      bld.stock[1].available -= 1;
    }
    bld.active = true;
    serf.stateData[0] = 1;
    serf.animation = 0x8f;
    serf.counter = 0x23f;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index;
    return;
  }
  if (!advance(serf, state.gameTick)) return;
  for (;;) {
    serf.stateData[0] = (serf.stateData[0] + 1) & 0xff;
    if (serf.stateData[0] === 7) {
      const bld = state.buildings[state.mapTiles[pos].objIndex];
      const oldSfx = bld ? bld.playingSfx : false;
      if (bld) {
        bld.active = false;
        bld.playingSfx = !oldSfx; // toggle bit 3 (sword <-> shield)
      }
      finishProduction(state, serf, oldSfx ? 0x1a : 0x19); // Shield : Sword
      return;
    }
    const old = serf.counter;
    serf.counter = (serf.counter + 0x240) & 0xffff;
    if (old > 0xfdbf) return;
  }
};

/**
 * Mineral yield per mineral type in the **res+1** carrying convention (the byte the original stores
 * in `serf[0xd]` and passes on in `serf[0xb]`). Index = mineral type `(byte>>5)&7`: 1 gold -> 14
 * (GoldOre+1), 2 iron -> 11 (IronOre+1), 3 coal -> 13 (Coal+1), 4 stone -> 10 (Stone+1). Taken from
 * the original table `@0x1af44` (`[0xff,14,11,13,10]`).
 */
const MINE_RES_PLUS1 = [0xff, 14, 11, 13, 10] as const;

/**
 * The shared spiral search step of mining substates 4..7 (@0x1ae82): test one random spiral position
 * around the mine. If the mineral type matches (== the deposit in `serf[0xe]`) on an empty or
 * passable tile (`object == 0 || object >= 5`), decrement the deposit (byte `-1`, clearing the whole
 * byte when the amount reaches 0), remember the yield in `serf[0xd]` (res+1) and jump to substate 8.
 * Afterwards `counter += 1000`.
 *
 * The spiral index is `(rng>>2)&0x1f` (the original uses `rng & 0x7c` as a dword offset into the
 * `field_0xc4` table, which is the same indexing as `spiralPos`).
 */
function miningSearch(state: GameState, serf: Serf, pos: number): boolean {
  serf.stateData[0] = (serf.stateData[0] + 1) & 0xff; // substate += 1
  const idx = (state.rng.next() >> 2) & 0x1f;
  const dest = spiralPos(pos, idx, state.geo);
  const t = state.mapTiles[dest];
  const raw = ((t.mineral & 7) << 5) | (t.resourceAmount & 0x1f);
  if (raw !== 0) {
    const mineralType = (raw & 0xe0) >> 5;
    if (mineralType === serf.stateData[3] && ((t.object & 0x7f) === 0 || (t.object & 0x7f) >= 5)) {
      // remove_ground_deposit: lower the byte by 1; when the amount reaches 0, clear the whole byte.
      let dec = (raw - 1) & 0xff;
      if ((dec & 0x1f) === 0) dec = 0;
      t.mineral = (dec >> 5) & 7;
      t.resourceAmount = dec & 0x1f;
      serf.stateData[2] = MINE_RES_PLUS1[mineralType]; // serf[0xd] = res+1
      serf.stateData[0] = 8;
    }
  }
  return addCounterContinue(serf, 1000);
}

/**
 * 29 Mining (`serf_state_29_Mining` @0x1a910) — extracting resources in a mine. A sub state machine
 * over `field_0xb` (`serf[0xb]<<3` indexes the original jump table @0x1a968): food (0 -> 1/2 -> 3),
 * digging (3 -> 4), the spiral search for a deposit (4 -> ... -> 8), taking the yield (8 -> 9 -> 10)
 * and carrying the product out, or starting the cycle over on failure.
 *
 * **The food probability is inverted from what one might expect.** Substate 0 draws a random value
 * and goes into the food check (substate 1) when `(rng&7)==0`, otherwise it skips food (substate 2) —
 * so the miner asks for food in only **1/8** of the cycles. Verified on the raw bytes @0x1aa52
 * (`jne` after `and ax,7`).
 *
 * **RNG limit:** the spiral search (substates 4..7) draws random values, so the *concrete* find
 * matches an original capture only with full RNG parity. The deterministic parts (transitions, food
 * consumption, deposit decrement, `increase_mining`) are checkable against the oracle.
 *
 * **"Mine exhausted" at `progress == 0x8000`** (@0x1ac9c). Order in the original: `bld.active = true`
 * -> test `progress == 0x8000` -> message -> **only then** `shlw $1` (@0x1ad86). It is the test as
 * much as the message that matters; without it `progress` simply keeps shifting.
 *
 * The message type is **4 with the mine kind as parameter**: `andw $0x7c` · `shrw $0x2` · `subw $0x5`
 * · `shlw $0x5` · `addw $0x4`, i.e. `4 + ((buildingType - 5) << 5)`, so 0..3 for
 * stone/coal/iron/gold (type enum 5..8). Arguments: `bld[0]` (position) and `bld[4] & 3` (owner).
 *
 * **The AI branch is ported too** (@0x1acf7 `bt $0x7` on `player+2`): a **computer opponent demolishes
 * its exhausted mine** (`call 0x48eb8`), a human player only gets the message. Both paths join
 * afterwards, so the AI receives the message as well.
 */
export const mining = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  if (!advance(serf, state.gameTick)) return; // Tick-Prolog
  const pos = posOf(serf.col, serf.row, state.geo);
  // Dispatch loop (the original's `while (counter < 0)` over the sub jump table `field_0xb << 3`).
  for (;;) {
    const sub = serf.stateData[0];
    switch (sub) {
      case 0: {
        // Small chance of a food check, otherwise skip it (see the module head).
        const r = state.rng.next();
        serf.stateData[0] = (r & 7) === 0 ? 1 : 2;
        if (addCounterContinue(serf, (r & 0x1ff) + 100)) continue;
        return;
      }
      case 1: {
        // Food check: food in the stock (high nibble) means eat and dig; otherwise wait and retry.
        const bld = state.buildings[state.mapTiles[pos].objIndex];
        if (!bld) return;
        if (bld.stock[0].available !== 0) {
          bld.stock[0].available -= 1;
          serf.stateData[0] = 3;
          state.mapTiles[pos].serfIndex = serf.index;
          serf.animation = 0x7d;
          serf.counter = 0x17f;
          return;
        }
        state.mapTiles[pos].serfIndex = serf.index;
        serf.animation = 0x62;
        const old = serf.counter;
        serf.counter = (old + 0x100) & 0xffff;
        if (old < 0xff00) serf.counter = 0xff;
        return;
      }
      case 2: {
        // Skip food -> dig straight away.
        serf.stateData[0] = 3;
        state.mapTiles[pos].serfIndex = serf.index;
        serf.animation = 0x7d;
        serf.counter = 0x17f;
        return;
      }
      case 3: {
        // Prepare digging: building activity off, digging animation.
        serf.stateData[0] = 4;
        const bld = state.buildings[state.mapTiles[pos].objIndex];
        if (bld) bld.active = false;
        serf.animation = 0x7e;
        if (addCounterContinue(serf, 0x130)) continue;
        return;
      }
      case 4: {
        // Enter the mine (disappear from the tile), sound on, then the shared spiral search (fall-through).
        serf.stateData[0] = 5;
        state.mapTiles[pos].serfIndex = 0;
        const bld = state.buildings[state.mapTiles[pos].objIndex];
        if (bld) bld.playingSfx = true;
        if (miningSearch(state, serf, pos)) continue;
        return;
      }
      case 5:
      case 6:
      case 7: {
        if (miningSearch(state, serf, pos)) continue;
        return;
      }
      case 8: {
        // Found or finished: the serf is visible on the tile again, sound off, handover animation.
        serf.stateData[0] = 9;
        state.mapTiles[pos].serfIndex = serf.index;
        const bld = state.buildings[state.mapTiles[pos].objIndex];
        if (bld) bld.playingSfx = false;
        serf.animation = 0x7f;
        serf.counter = 0x12f;
        return;
      }
      case 9: {
        // increase_mining: advance the building's success history (`progress << 1 | found`).
        serf.stateData[0] = 10;
        const bld = state.buildings[state.mapTiles[pos].objIndex];
        if (bld) {
          bld.active = true; // `bts $0x4,bld[5]` @0x1ac8d
          // `cmpw $0x8000,bld[12] ; jne 0x1ad83` @0x1ac9c — the success history has run empty.
          if (bld.progress === 0x8000) {
            const player = state.players[bld.owner & 3];
            if (player) {
              // AI branch @0x1acf7/@0x1ad39: the computer opponent demolishes its exhausted mine.
              if ((player.flags & PLAYER_FLAG_AI) !== 0) demolishBuilding(state, bld);
              addPlayerMessage(
                player,
                MSG_MINE_EXHAUSTED + (((bld.type - 5) & 7) << 5),
                posOf(bld.col, bld.row, state.geo),
              );
            }
          }
          let prog = (bld.progress << 1) & 0xffff;
          if (serf.stateData[2] !== 0) prog = (prog + 1) & 0xffff;
          bld.progress = prog;
        }
        serf.animation = 0x80;
        if (addCounterContinue(serf, 0x180)) continue;
        return;
      }
      case 10: {
        // Carry the product out — or start the cycle over when the yield was empty.
        state.mapTiles[pos].serfIndex = 0;
        if (serf.stateData[2] === 0) {
          serf.stateData[0] = 0;
          serf.counter = 0;
          return;
        }
        finishProduction(state, serf, serf.stateData[2]);
        return;
      }
      default:
        return;
    }
  }
};

/** Breeding probability per pig count (index 1..7), from the table `@0x19c87`. */
const PIG_BREEDING_PROB = [0, 6000, 8000, 10000, 11000, 12000, 13000, 14000] as const;

/**
 * 40 MakingTool (`serf_state_40_MakingTool` @0x19407) — the toolmaker turns **steel** (`stock[0]`)
 * and **planks** (`stock[1]`) into a tool. Phase A consumes one of each input; phase B counts
 * `field_0xb` 1 -> 4 (fixed build steps, `counter += 0x600`), then makes an **RNG-weighted choice of
 * tool type** over the player's nine `toolPriority` values and hands over (`finishProduction`).
 *
 * **The type choice:** `sum = (sum of toolPriority) >> 4`. With `sum == 0` it is uniform,
 * `res+1 = 0x10 + ((rng*9)>>16)` (the nine tools shovel..pincer, res 15..23). Otherwise weighted:
 * `target = (sum*rng)>>16`, then accumulate `toolPriority` until `(acc>>4) > target` gives the
 * index.
 *
 * **RNG limit:** the type choice draws random values, so it matches an original capture only with
 * full RNG parity; the deterministic parts (consumption, build steps, handover) are checkable.
 */
export const makingTool = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (serf.stateData[0] === 0) {
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (!bld) return;
    if (bld.stock[0].available === 0 || bld.stock[1].available === 0) return; // braucht Stahl + Bretter
    bld.stock[0].available -= 1;
    bld.stock[1].available -= 1;
    serf.stateData[0] = 1;
    serf.animation = 0x90;
    serf.counter = 0x5ff;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index;
    return;
  }
  if (!advance(serf, state.gameTick)) return;
  for (;;) {
    serf.stateData[0] = (serf.stateData[0] + 1) & 0xff;
    if (serf.stateData[0] === 4) break; // Werkzeug fertig
    if (!addCounterContinue(serf, 0x600)) return;
  }
  // RNG-weighted choice of tool type over the nine tool priorities.
  const player = state.players[serf.owner];
  const tp = player ? (player.toolPriority as number[]) : new Array<number>(9).fill(0);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += tp[i] ?? 0;
  sum >>>= 4;
  let chosen: number;
  if (sum === 0) {
    chosen = 0x10 + ((state.rng.next() * 9) >>> 16); // uniform over the nine tools
  } else {
    const target = (sum * state.rng.next()) >>> 16;
    chosen = 0xf;
    let acc = 0;
    let i = 0;
    do {
      chosen += 1;
      acc += tp[i] ?? 0;
      i += 1;
    } while ((acc >>> 4) <= target && i < 9);
  }
  finishProduction(state, serf, chosen); // res+1 = 16..24 (Shovel..Pincer)
};

/**
 * 37 PigFarming (`serf_state_37_PigFarming` @0x199c4) — the pig farm fattens pigs with **wheat**
 * (`stock[0]`). Byte 9 of the building holds the **pig count** (0..8). Phase A consumes one wheat;
 * phase B alternates `field_0xb` between even modes (the serf disappears and may **breed a piglet**
 * with probability `PIG_BREEDING_PROB[pigs]`) and odd ones (the serf is visible). Mode 7 decides:
 * 8 pigs -> slaughter; more than 3 pigs and `(rng*20)>>16 < pigs` -> slaughter; otherwise with
 * `(rng&0xf)!=0` keep fattening (mode 1) or `==0` start a new cycle (mode 0). Slaughtering yields one
 * pig
 * abziehen, `Pig` (res+1=2) raustragen (`finishProduction`).
 *
 * **RNG limit:** breeding and the slaughter decision draw random values, so they are not byte-equal
 * to a capture.
 */
export const pigFarming = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const pos = posOf(serf.col, serf.row, state.geo);
  if (serf.stateData[0] === 0) {
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (!bld) return;
    if (bld.stock[0].available === 0) return; // braucht Getreide
    bld.stock[0].available -= 1;
    serf.stateData[0] = 1;
    serf.animation = 0x8b;
    serf.counter = 0x17f;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index;
    return;
  }
  if (!advance(serf, state.gameTick)) return;
  // Breeding loop: even modes breed, odd modes leave the loop (serf visible / decision).
  for (;;) {
    serf.stateData[0] = (serf.stateData[0] + 1) & 0xff;
    if (serf.stateData[0] & 1) break; // odd -> leave the loop
    state.mapTiles[pos].serfIndex = 0; // the serf disappears (feeding)
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (bld) {
      const pigs = rawByte9(bld);
      if (pigs !== 8 && state.rng.next() < (PIG_BREEDING_PROB[pigs] ?? 0)) {
        setByte9(bld, (pigs + 1) & 0xff); // Ferkel setzen
      }
    }
    if (!addCounterContinue(serf, 0x800)) return;
  }
  // ungerader Modus
  if (serf.stateData[0] !== 7) {
    state.mapTiles[pos].serfIndex = serf.index; // Serf wieder sichtbar
    serf.animation = 0x8b;
    serf.counter = 0x17f;
    return;
  }
  // Modus 7: Schlacht-Entscheidung.
  const bld = state.buildings[state.mapTiles[pos].objIndex];
  if (!bld) return;
  const pigs = rawByte9(bld);
  if (pigs !== 8) {
    if (pigs > 3 && ((state.rng.next() * 0x14) >>> 16) < pigs) {
      setByte9(bld, (pigs - 1) & 0xff); // one pig goes to the butcher
      finishProduction(state, serf, 2); // Pig res+1 = 2
      return;
    }
    if ((state.rng.next() & 0xf) === 0) {
      serf.stateData[0] = 0; // new cycle (waiting for wheat again)
      return;
    }
    serf.stateData[0] = 1; // keep fattening
    serf.animation = 0x8b;
    serf.counter = 0x17f;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index;
    return;
  }
  // 8 Schweine → schlachten
  setByte9(bld, (pigs - 1) & 0xff);
  finishProduction(state, serf, 2); // Pig res+1 = 2
};

/**
 * 41 BuildingBoat (`serf_state_41_BuildingBoat` @0x19204) — the boatbuilder turns **planks**
 * (`stock[0]`) into a boat. Byte 9 of the building is the **build step counter**. Phase A consumes
 * one plank and sets the counter to 0; phase B counts `field_0xb` 1 -> 9 (byte 9 `+1` per step,
 * `counter += 0x580`). At step 9 (boat finished): if the flag tile (DownRight) is occupied, go back
 * to step 8 and wait; otherwise reset the counter and carry the boat (res+1 = 9) out
 * (`finishProduction`).
 */
export const buildingBoat = (state: GameState, serf: Serf): void => {
  if (serf.col === null || serf.row === null) return;
  const geo = state.geo;
  const pos = posOf(serf.col, serf.row, geo);
  if (serf.stateData[0] === 0) {
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (!bld) return;
    if (bld.stock[0].available === 0) return; // braucht Bretter
    bld.stock[0].available -= 1;
    setByte9(bld, 0); // reset the boat progress
    serf.stateData[0] = 1;
    serf.animation = 0x92;
    serf.counter = 0x9f;
    serf.tick = state.gameTick;
    state.mapTiles[pos].serfIndex = serf.index;
    return;
  }
  if (!advance(serf, state.gameTick)) return;
  for (;;) {
    serf.stateData[0] = (serf.stateData[0] + 1) & 0xff;
    if (serf.stateData[0] === 9) break; // Boot fertig
    const bld = state.buildings[state.mapTiles[pos].objIndex];
    if (bld) setByte9(bld, (rawByte9(bld) + 1) & 0xff); // Bauschritt
    serf.animation = 0x91;
    if (!addCounterContinue(serf, 0x580)) return;
  }
  // Boat finished — wait for a free flag, otherwise deliver.
  const flagTile = neighbor(pos, Direction.DownRight, geo);
  if (state.mapTiles[flagTile].serfIndex !== 0) {
    serf.stateData[0] = 8; // back to step 8 -> waits for a free flag
    serf.counter = 0;
    return;
  }
  const bld = state.buildings[state.mapTiles[pos].objIndex];
  if (bld) setByte9(bld, 0); // reset the boat counter
  finishProduction(state, serf, 9); // Boat res+1 = 9
};
