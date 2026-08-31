/**
 * Live game state of the deterministic tick engine.
 *
 * Unlike the parsed `SaveGameState` (readonly, **sparse** by `.index`) the live state is **mutable**
 * and **densely index addressed**: `serfs[i]` is the serf with slot index `i` (slot 0 = the reserved
 * null slot, as in `gs->serfs + idx*16`). That mirrors the original's storage and is at the same time
 * the shared lookup source for the tick loop and the renderer.
 *
 * The state is plain data throughout (isolated from the parser by a deep clone) and serialisable back
 * to a `SaveGameState` through `snapshot()` — the basis for reproducibility, lockstep multiplayer and
 * AI observation.
 */
import type {
  SaveGameState,
  SaveGameHeader,
  SerfRecord,
  FlagRecord,
  BuildingRecord,
  InventoryRecord,
  MapTile,
  PlayerRecord,
  EntityBlock,
} from '../types.js';
import { Rng } from './rng.js';
import { SERF_TYPE_NAMES } from '../save-parser.js';
import { mapGeometry, type MapGeometry } from './position.js';
import { u16 } from './int.js';
import { createAmbientState, type AmbientState } from './ambient-sound.js';

/** Shallow mutable variant of a record (top-level fields writable). */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Deeply mutable variant. Needed for the live records whose inner structures the state machine mutates
 * (flag `resourceSlots`, inventory `outQueue`/`serfIndices` — the parser hands them out `readonly`).
 */
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

/**
 * Live serf: shallow mutable, with **mutable `stateData`** (the five union bytes 11..15). The state
 * machine works bit-exactly on those raw bytes, just as the binary addresses the union as u8/u16
 * depending on `state`. A named view is available through `serfStateFields(serf)` on demand — it is
 * **not** carried in the record, because it would go stale with every tick.
 */
export type Serf = Omit<Mutable<SerfRecord>, 'stateData'> & { stateData: number[] };
export type Flag = DeepMutable<FlagRecord>;
export type Building = DeepMutable<BuildingRecord>;
export type Inventory = DeepMutable<InventoryRecord>;
export type Tile = Mutable<MapTile>;
/** Deeply mutable: the economy tick mutates counter arrays such as `serfCount`. */
export type Player = DeepMutable<PlayerRecord>;

/**
 * **The road-building session of one player** — field by field the original's `vp` slots:
 * {@link active} = `vp[1]` bit 7, {@link segments} = `vp+0xce`, {@link allowedMask} = `vp+0xd0`,
 * {@link markers} = `vp+0xaa` with stride 6.
 *
 * **Why this lives in the game state and not in the UI layer:** road building is the only interaction
 * whose effect accumulates over **several clicks** — each click sets real path bits, may build a flag
 * and moves the cursor. A single click can therefore only be expressed as a command
 * (`commands.ts`) if the session state sits in the state next to it; otherwise `applyCommand` could
 * not resolve it and the action log would be blind to half of the road building.
 *
 * It is also the faithful place: the original keeps the four fields per viewport, and a viewport
 * belongs to a player (split screen = two viewports = two humans).
 *
 * **Not in the save**: the original does not store an in-progress road, so `snapshot()` does not carry
 * it either. A report taken mid-build loses the session; replaying the command log rebuilds it from
 * `beginRoadBuilding`.
 */
export interface RoadBuildingState {
 /** `vp[1]` bit 7 — road-building mode active (bit 6 is popup modality, pure window bookkeeping). */
  active: boolean;
 /** `vp+0xce` — number of segments placed so far. */
  segments: number;
 /** `vp+0xd0` — bit mask of the currently allowed directions. */
  allowedMask: number;
 /** `vp+0xaa`, stride 6 — the six neighbour markers (sprite index). */
  markers: number[];
}

/**
 * The "show nothing" marker — `mov $0x21,%ax` @0x28742 ff (six times in the abort path). It lives here
 * rather than in `road-building.ts` because the fresh state needs it and this file must not import
 * from there (that would create a runtime cycle).
 */
export const MARKER_NONE = 0x21;

/** Fresh road-building state — what `vp` looks like after `cancelRoadBuilding`. */
export function createRoadBuildingState(): RoadBuildingState {
  return {
    active: false,
    segments: 0,
    allowedMask: 0,
    markers: [MARKER_NONE, MARKER_NONE, MARKER_NONE, MARKER_NONE, MARKER_NONE, MARKER_NONE],
  };
}

/** Metadata of an entity block (for lossless snapshot reconstruction). */
interface BlockMeta {
  readonly recordSize: number;
 /** One above the highest index (== `field_0x262` for serfs). Grows when a serf spawns. */
  maxIndex: number;
}

export interface GameState {
 /** Header primitives; `tick`/`random` are mirrored from the engine on `snapshot()`. */
  header: Mutable<SaveGameHeader>;
  readonly geo: MapGeometry;
 /** Live game tick (u16, `gs->field_0x206`). Starts at `header.tick`. */
  gameTick: number;
  readonly rng: Rng;

 /**
  * Frame rotation counter (`gs->field_0x26c`) — the frame loop processes flag block `rotation` per
  * frame. +1 per frame (every 8th game tick), wrapping at {@link rotationWrap}. **Seeded from the
  * save** (the original's load routine restores it too), so our frame phase equals the original's.
  */
  rotation: number;
 /** Rotation wrap (`gs->field_0x286`, observed 49). Seeded from the save, fallback 49. */
  rotationWrap: number;
 /** Sub-frame counter 0..FRAME_TICKS-1 (not an original field): game ticks until the next frame. */
  frameAccum: number;
 /**
  * Change counter of the territory (**not an original field**, pure renderer bookkeeping): +1 on every
  * `recomputeTerritory`. The renderer keeps ground, roads **and border stones** in a retained surface
  * that is only refreshed on a version change — roads change through player commands alone, but the
  * territory also changes inside a running tick (completion, capture, fire). Without this counter the
  * borders would sit stale until the next action.
  */
  territoryVersion: number;

 /**
  * "The road being built has become invalid" (**not an original field**, but the stand-in for a loop
  * this model does not have).
  *
  * `clear_road_paths` @0x4a5e6 clears nothing when the road lacks a flag at **both** ends — and the
  * only situation where that happens is the road currently being **drawn**. Instead of clearing, the
  * original then walks **all viewports** and aborts road building in each one that has it active
  * (@0x4a5f1 ff.). We have exactly one viewport and its session lives in the UI layer, so the engine
  * raises this signal instead; the view clears it after each tick batch.
  */
  roadBuildAborted: boolean;

 /**
  * **Road-building session per player slot** (0..3), see {@link RoadBuildingState}. Not in the save; a
  * loaded game starts without one.
  */
  readonly roadBuild: RoadBuildingState[];

 /**
  * State of the **ambient sounds** (`viewport_ambient_audio` @0xef29) — **not original game state**,
  * but the coupling between renderer and engine: the draw pass fills the two visibility counters
  * (`vp+0x1b4`/`vp+0x1b6`), the engine pass evaluates them and records the sound to enqueue. The
  * pass's random draw does NOT depend on the counters, so headless state stays identical.
  */
  readonly ambient: AmbientState;

 /**
  * **The three save-reminder clocks** (`gs+0x186` / `gs+0x17e` / `gs+0x182`) — **not in the save**: the
  * save routine does not touch them, game start sets them (@0xbc13 ff.), the main menu sets them
  * (@0x4fc72 ff.) and a **successful save** resets them (@0x28506 ff.). A loaded game therefore starts
  * with fresh clocks.
  *
  * `quitGrace` counts down in u16 and carries **no** message — its consumer is the "leave game" button
  * (`gs+0x186 == 0` => screen 0x23 instead of the confirmation). The other two are i32 and fire
  * **exactly once**, at the sign change: afterwards the `jns` test keeps them closed forever, which is
  * why they may stay negative instead of being clamped to 0.
  */
  saveClocks: { quitGrace: number; reminder30: number; reminder60: number };

 /**
  * Global serf reproduction budget (`gs->field_0x48`). The economy tick decrements it per newly
  * created serf; at 0 nothing spawns any more.
  */
  serfBudget: number;

 /**
  * Round-robin housekeeping (`FUN_0000eced`): `serviceBudget` (`gs->field_0x52`) = buildings/flags per
  * frame, the two cursors (`gs->field_0x54`/`0x56`) = rolling positions. The service periodically
  * clears `serfRequestFailed`, which is what retries a failed request.
  */
  serviceBudget: number;
  buildingServiceCursor: number;
  flagServiceCursor: number;

 /** Dense, index-addressed slot stores (slot 0 = reserved null slot; empty slots = null). */
  readonly serfs: (Serf | null)[];
  readonly flags: (Flag | null)[];
  readonly buildings: (Building | null)[];
  readonly inventories: (Inventory | null)[];
 /** Map tiles, dense by position `pos = row*cols + col`. */
  readonly mapTiles: Tile[];
 /** Players by slot 0..3 (inactive slots are kept). */
  readonly players: (Player | null)[];

 /**
  * `gs+0x288` — game time accumulated since the last build-pressure pass. The frame driver adds the
  * tick difference per frame (`add %ax,0x288(%ebx)` @0xd38b), the pressure pass reads and zeroes it.
  * **Not in the save** (no load/store site; the only other occurrence is the zeroing @0xbbc0).
  */
  aiPressureAccum: number;
 /** `gs+0x28a` — length of the last completed interval, the reference for all pressure rates. */
  aiPressureLast: number;

 // Carried for lossless serialisation:
  readonly blockMeta: { serfs: BlockMeta; flags: BlockMeta; buildings: BlockMeta; inventories: BlockMeta };
  readonly byteLength: number;
}

/** Sort a sparse record list into a dense, index-addressed array. */
function densify<T extends { index: number }>(records: readonly T[], size: number): (T | null)[] {
  const arr: (T | null)[] = new Array(size).fill(null);
  for (const r of records) {
    if (r.index >= 0 && r.index < size) arr[r.index] = r;
  }
  return arr;
}

/**
 * Deep copy to isolate mutations from the input `save`. Deliberately **JSON based** rather than
 * `structuredClone`: `SaveGameState` is JSON-capable plain data by contract, and the caller may hand
 * in a reactive proxy that `structuredClone` cannot clone — `JSON` reads straight through it and
 * yields a detached plain object.
 */
function deepClonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** `gs+0x186` — 6000 ticks (60 s), gate of the "leave game" button (@0xbc13/@0x28506). */
export const SAVE_CLOCK_QUIT_GRACE = 0x1770;
/** `gs+0x17e` — 180000 ticks (30 min) until message 17 (@0xbc21/@0x28514/@0x4fc80). */
export const SAVE_CLOCK_REMINDER_30MIN = 0x2bf20;
/** `gs+0x182` — 360000 ticks (60 min) until message 18 (@0xbc2f/@0x28522/@0x4fc8e). */
export const SAVE_CLOCK_REMINDER_60MIN = 0x57e40;

/** Build the mutable live state from a parsed save game (copies every record). */
export function loadState(save: SaveGameState): GameState {
  const clone = deepClonePlain(save);
  const h = clone.header;
  const geo = mapGeometry(h.mapSize);

  const serfSize = h.maxSerfIndex + 1;
  const flagSize = h.maxFlagIndex + 1;
  const buildingSize = h.maxBuildingIndex + 1;
  const inventorySize = h.maxInventoryIndex + 1;

  return {
    header: clone.header as Mutable<SaveGameHeader>,
    geo,
    gameTick: h.tick,
    rng: new Rng(h.random),
    rotation: h.rotation,
    rotationWrap: h.rotationWrap, // the 0 -> 49 fallback happens at the use site, to keep the round trip exact
    frameAccum: h.frameAccum ?? 0,
    territoryVersion: 0,
    roadBuildAborted: false,
    roadBuild: [
      createRoadBuildingState(),
      createRoadBuildingState(),
      createRoadBuildingState(),
      createRoadBuildingState(),
    ],
    ambient: createAmbientState(),
 // As at the original's game start: all three run (@0xbc13/@0xbc21/@0xbc2f).
    saveClocks: {
      quitGrace: SAVE_CLOCK_QUIT_GRACE,
      reminder30: SAVE_CLOCK_REMINDER_30MIN,
      reminder60: SAVE_CLOCK_REMINDER_60MIN,
    },
    serfBudget: h.serfBudget,
    serviceBudget: h.serviceBudget,
    buildingServiceCursor: h.buildingServiceCursor,
    flagServiceCursor: h.flagServiceCursor,
 // Not in the save — the original zeroes both at game start (@0xbbc0) and afterwards writes them only
 // from the frame driver and the pressure pass. A loaded game therefore starts a fresh interval, and
 // the first pressure round after loading sees length 0.
    aiPressureAccum: 0,
    aiPressureLast: 0,
    serfs: densify(clone.serfRecords as Serf[], serfSize),
    flags: densify(clone.flagRecords as unknown as Flag[], flagSize),
    buildings: densify(clone.buildingRecords as unknown as Building[], buildingSize),
    inventories: densify(clone.inventoryRecords as Inventory[], inventorySize),
    mapTiles: clone.mapTiles as Tile[],
    players: buildPlayers(clone.playerRecords as Player[]),
    blockMeta: {
      serfs: { recordSize: clone.serfs.recordSize, maxIndex: clone.serfs.maxIndex },
      flags: { recordSize: clone.flags.recordSize, maxIndex: clone.flags.maxIndex },
      buildings: { recordSize: clone.buildings.recordSize, maxIndex: clone.buildings.maxIndex },
      inventories: { recordSize: clone.inventories.recordSize, maxIndex: clone.inventories.maxIndex },
    },
    byteLength: clone.byteLength,
  };
}

/** Place players by slot 0..3 (the parser hands out all four). */
function buildPlayers(records: readonly Player[]): (Player | null)[] {
  const arr: (Player | null)[] = [null, null, null, null];
  for (const p of records) {
    if (p.slot >= 0 && p.slot < 4) arr[p.slot] = p;
  }
  return arr;
}

/** Non-null records of a dense store in index order (== the parser's convention). */
function sparse<T>(store: readonly (T | null)[]): T[] {
  const out: T[] = [];
  for (const r of store) if (r !== null) out.push(r);
  return out;
}

function blockOf<T extends { index: number }>(store: readonly (T | null)[], meta: BlockMeta): EntityBlock {
  const occupied: number[] = [];
  for (let i = 0; i < store.length; i++) if (store[i] !== null) occupied.push(i);
  return { recordSize: meta.recordSize, maxIndex: meta.maxIndex, occupied };
}

/**
 * Serialise the live state back to a `SaveGameState` (tick and RNG mirrored from the engine). For a
 * freshly loaded state `snapshot(loadState(save))` is structurally equal to `save`.
 */
export function snapshot(state: GameState): SaveGameState {
  const players = sparse(state.players);
  return {
    header: {
      ...state.header,
      tick: u16(state.gameTick),
      random: state.rng.getState(),
      rotation: state.rotation,
      rotationWrap: state.rotationWrap,
      frameAccum: state.frameAccum,
      serfBudget: state.serfBudget,
      serviceBudget: state.serviceBudget,
      buildingServiceCursor: state.buildingServiceCursor,
      flagServiceCursor: state.flagServiceCursor,
 // maxSerfIndex grows in state.header on a serf spawn and is carried over by the spread above.
    },
    activePlayers: players.filter((p) => p.active).map((p) => p.slot),
    playerRecords: players,
    serfs: blockOf(state.serfs, state.blockMeta.serfs),
    flags: blockOf(state.flags, state.blockMeta.flags),
    buildings: blockOf(state.buildings, state.blockMeta.buildings),
    inventories: blockOf(state.inventories, state.blockMeta.inventories),
    buildingRecords: sparse(state.buildings) as unknown as SaveGameState['buildingRecords'],
 // **References, not copies** — as for flags, buildings, inventories and tiles next to it. Do not
 // decode the union bytes per serf here: the renderer takes a snapshot per image, and decoding is
 // 95 % of its cost (0.76 of 0.80 ms at 821 serfs), the largest single item of a frame. Nothing in
 // the drawing path needs it — `serfDrawInfo` reads the bytes raw, like the original.
    serfRecords: sparse(state.serfs),
    flagRecords: sparse(state.flags) as unknown as SaveGameState['flagRecords'],
    inventoryRecords: sparse(state.inventories),
    mapTiles: state.mapTiles,
    byteLength: state.byteLength,
  };
}

/**
 * **Set a serf's type — including its display name.** `typeName` is a pure derivation of `type`, but
 * it sits as a field in the record. Writing only `serf.type` therefore leaves a wrong label behind:
 * the game state stays correct, but **every human view of it lies** — the save viewer and above all
 * the bug report, which prints the name next to the number.
 *
 * Use this helper instead of the double assignment everywhere, so that a type writer cannot forget the
 * name again.
 */
export function setSerfType(serf: Serf, type: number): void {
  serf.type = type;
  serf.typeName = SERF_TYPE_NAMES[type] ?? `Unknown(${type})`;
}
