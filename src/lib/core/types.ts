/**
 * Common types of the core.
 */

/** VGA palette with 256 RGBA entries (4 bytes per entry). */
export interface Palette {
  /** 256 * 4 = 1024 bytes, [R,G,B,A] per entry. */
  readonly rgba: Uint8Array;
}

/** One entry of a .PA pack archive. */
export interface PackEntry {
  readonly index: number;
  /** Offset in the .PA file (bytes). */
  readonly offset: number;
  /** Size in bytes of the data block at `offset`. */
  readonly size: number;
}

/** One slot of `ARCHIV.DS` (the save slot index). */
export interface SaveSlot {
  readonly index: number;
  /**
   * The 14 name characters AS THEY STAND IN THE ENTRY (space-padded, not trimmed). Trimming happens
   * at display time — in the original the padding centres the FREI placeholder, and a name with a
   * leading space (`' KEIN NAME    '`, the default of the save branch) could otherwise not be written
   * back.
   */
  readonly name: string;
  /** Occupied flag (last byte of the 16-byte slot: 0x01 = taken, 0x00 = free). */
  readonly used: boolean;
}

/**
 * **What was set at the four player columns in the main menu** (`.DS`@144..163, gs+0x36a..0x37d).
 *
 * Four byte arrays of 4 slots plus two two-byte fields for the HUMAN players — the original keeps
 * their values separately, because a human has no intelligence setting (that is the code literal
 * `0x28`, and exactly from it comes the u16 limit 65535 of the `aiRate`).
 *
 * The three sliders of a column appear in the menu as three bars; their assignment is proven THREE
 * TIMES over and not guessed: the game start derives `difficulty` / `aiRate` / `reproductionReset`
 * from them (measured), the bar x offsets 68/74/80 of the drawing pass assign them to the same column,
 * and the click zones A25/A26/A27 lie exactly on those three bars.
 */
export interface MenuPlayerSetup {
  /** Face per slot (`gs+0x36a`, `.DS`@144). `0` = slot unoccupied. */
  readonly face: readonly [number, number, number, number];
  /** Intelligence per slot (`gs+0x36e`, `.DS`@148) — source of the `aiRate` (`value · 1300 + 13535`). */
  readonly intelligence: readonly [number, number, number, number];
  /** Supply per slot (`gs+0x372`, `.DS`@152) — becomes the player's `difficulty` field 1:1. */
  readonly supply: readonly [number, number, number, number];
  /** Reproduction per slot (`gs+0x376`, `.DS`@156) — yields `reproductionReset = (60 − value) · 50`. */
  readonly reproduction: readonly [number, number, number, number];
  /** Supply of the two HUMAN players (`gs+0x37a`/`0x37b`, `.DS`@160/161). */
  readonly humanSupply: readonly [number, number];
  /** Reproduction of the two HUMAN players (`gs+0x37c`/`0x37d`, `.DS`@162/163). */
  readonly humanReproduction: readonly [number, number];
}

/**
 * Verified header primitives of a `SAVE*.DS` save game. All fields confirmed against the real bytes of
 * the original saves.
 */
export interface SaveGameHeader {
  /**
   * **Interaction options per screen half** (gs+0x3d8 / gs+0x3d9, `.DS`@72/73) — one bit byte each,
   * `[0]` = left, `[1]` = right half. The original keeps a set of its own for each of the two players
   * of a split screen (manual ch. 6.5, p. 113). Bit assignment see `VIEW_OPTION_*` in
   * `engine/view-options.ts`: bit 0 road-building scrolling, bit 1 fast map click, bit 2 fast build
   * click, bits 3..5 = message level as a thermometer (bit 5 ⇒ ≥1, bit 4 ⇒ ≥2, bit 3 ⇒ 3).
   *
   * Proven at the original: `savegame_load_header` reads `gs->field_0x3d8 = buf[0x48]` /
   * `gs->field_0x3d9 = buf[0x49]`, the save routine writes them back to the same offsets.
   */
  readonly viewOptions: readonly [number, number];
  readonly gameType: number;
  readonly tick: number;
  /** RNG state (three u16, as the original seeds its random generator). */
  readonly random: readonly [number, number, number];
  /**
   * Frame rotation counter (gs+0x26c, `.DS`@96) — the frame loop processes the flag/economy block
   * `rotation` per frame; +1 per frame, wrapping at {@link rotationWrap}. Proven at the original (load
   * routine `FUN_00047ba8` @0x47ba8: `gs->field_0x26c = buf[0x60]`).
   */
  readonly rotation: number;
  readonly flagSearchCounter: number;
  /** `.DS`@100 (gs+0x27c) - tick stamp of the last map growth pass. */
  readonly mapTick: number;
  /** `.DS`@102 (gs+0x27e) — remaining counter until the next tile round of the map growth. */
  readonly mapCounter: number;
  /** `.DS`@68 (gs+0x280) — packed position cursor of the map growth (raw). */
  readonly mapCursorRaw: number;
  /** `.DS`@188 (gs+0x28c) — decay countdown of the map growth. */
  readonly mapDecayCountdown: number;
  readonly maxFlagIndex: number;
  readonly maxBuildingIndex: number;
  readonly maxSerfIndex: number;
  readonly maxInventoryIndex: number;
  /**
   * Rotation wrap (`gs->field_0x286`, .DS offset 180) — the rotation runs `0..rotationWrap-1`
   * (observed 49): rot < 32 = entity/flag blocks, 32.. = economy rotations. Verified at the load
   * routine `FUN_00047ba8`: `gs->field_0x286 = buf[0xb4]`.
   */
  readonly rotationWrap: number;
  /**
   * Global serf reproduction budget (gs+0x48, `.DS`@176) — the number of serfs that may still be
   * NEWLY CREATED. `create_serf` (`FUN_000457dc`) decrements it per allocation, `delete_serf`
   * increments it; reproduction (`spawn_serf` `FUN_00029a17`) spawns only at budget > 0. Byte-verified:
   * between two saves of one session it falls by exactly the 28 newly created serfs.
   */
  readonly serfBudget: number;
  /**
   * Warehouse limit (gs+0x268, `.DS`@178, observed 361 = array capacity/4). The build action rejects a
   * further warehouse when `finished + under construction + 1 == warehouseLimit`.
   */
  readonly warehouseLimit: number;
  /**
   * Total gold of the map (gs+0x4c, `.DS`@184, u32) — summed from all gold deposits at map init; the
   * DENOMINATOR OF THE KNIGHT MORALE FORMULA. It falls only when gold is lost for good (a built-over
   * tile without a neighbour to move to). Verified against the ground sums: two saves exact, the third
   * higher by the amount already mined.
   */
  readonly mapGoldTotal: number;
  /**
   * Round-robin housekeeping (`FUN_0000eced`): `serviceBudget` (gs+0x52, `.DS`@192) = how many
   * buildings respectively flags are visited per frame (observed 55); `buildingServiceCursor`
   * (gs+0x54, `.DS`@194) and `flagServiceCursor` (gs+0x56, `.DS`@196) are the rolling positions. The
   * service periodically clears `Building.serfRequestFailed` respectively `Flag.serfRequestFail` →
   * failed requests are tried again.
   */
  readonly serviceBudget: number;
  readonly buildingServiceCursor: number;
  readonly flagServiceCursor: number;
  readonly playerHistoryIndex: readonly number[];
  readonly playerHistoryCounter: readonly number[];
  readonly resourceHistoryIndex: number;
  /**
   * Setup record index for `gameType == 1` (offset 122, gs+0x354) — the record is
   * `missionSetupIndex − 1`. The load routine fetches the field only under this guard; with other game
   * types a residue stands here. Used by `player-setup.ts`.
   */
  readonly missionSetupIndex: number;
  /**
   * Setup record index for `gameType == 0` (offset 124, gs+0x356) — the record is
   * `levelSetupIndex + 5`. Observed 26 / 29 / 30 in the three original saves.
   */
  readonly levelSetupIndex: number;
  /**
   * **The highest unlocked level** (offset 126, gs+0x358) — the same number the main menu uses as the
   * bound of the level choice (`MainMenuState.unlockedLevel`).
   *
   * It stands in the save because it is GLOBAL state in the original: the game start writes it from
   * the menu, `savegame_load_header` fetches it back (@0x47f2a) — and the exit "ENDE/JA" advances it
   * when the level was won (`advanceCampaignProgress`). Like {@link levelSetupIndex} the original
   * loads it ONLY at `gameType == 0` (`jne 0x47f55` @0x47f0d); with other game types a residue stands
   * in the file, hence `undefined`.
   *
   * When saving it is written WITHOUT a gate (@0x47449 has no branch) — the encoder does the same, as
   * far as our model has the value.
   */
  readonly levelSetupShown?: number;
  /**
   * **The campaign password** (offsets 128..135, gs+0x35a..0x361) — eight characters, space padded.
   *
   * The same cells are three things in the original: the input field of the password entry, the source
   * of the main menu's `PASSWORT:` line, and this save field. It stands here because the buffer is
   * GLOBAL memory there — the game start inherits whatever the menu held, `savegame_load_header`
   * fetches it back (@0x47f3d), and the **mission end** overwrites it with the password of the level
   * that follows the one just won (@0x38547).
   *
   * Loaded ONLY at `gameType == 0` (the write @0x47f3d sits behind `gs+0x352 == 0`); with other game
   * types a residue stands in the file, hence `undefined`. When saving the original writes it without a
   * gate (@0x4745a) — the encoder keeps it under the same gate as far as our model has the value, like
   * {@link levelSetupShown}.
   */
  readonly levelPassword?: string;
  /**
   * **The player settings of the main menu** (offsets 144..163, gs+0x36a..0x37d) — what was set at the
   * four columns in the menu before the game began. Loaded only at `gameType > 1` (`jb 0x48010`
   * @0x47f60); with level/mission the players come from the setup record instead and a residue stands
   * here. `undefined` when `gameType <= 1`.
   *
   * The order of the two middle arrays is DECIDED AT THE BYTE, not assumed: for an AI `.DS`@152 yields
   * the `difficulty` field and `.DS`@148 the `aiRate` — the two arrays are therefore intelligence
   * (148) and supply (152), although the setup record holds them the other way round.
   */
  readonly menuSetup?: MenuPlayerSetup;
  /**
   * The map size chosen in the main menu (`gs+0x362`, `.DS`@136). Set only at `gameType > 1`; with
   * level/mission a residue stands here that the original does not even load — hence `undefined`
   * instead of a meaningless number. Redundant to {@link mapSize}, which the load routine fills
   * independently; comparing the two is a cheap integrity test.
   */
  readonly mapSizeChoice?: number;
  /**
   * The RAW map seed (`gs+0x364/0x366/0x368`, `.DS`@138..143), from which terrain, minerals and
   * opponents arise — `undefined` at `gameType ≤ 1`, because there it comes from the setup record.
   *
   * "Raw" means: BEFORE the XOR mask. `deriveMapSeed` in `engine/map-generator.ts` applies it before
   * the generator draws its random stream from it.
   */
  readonly mapSeed?: readonly [number, number, number];
  readonly mapGoldMoraleFactor: number;
  /**
   * **Span of the population allowance** (offset 182, gs+0x4a). A player's share of land ownership is
   * scaled onto it; together with {@link populationBase} that yields the bound below which he still
   * gets new settlers. Observed 1250 / 1500 / 1750 — a game setting, not a constant. See
   * `engine/population.ts`.
   */
  readonly populationSpan: number;
  /** **Base** of the same allowance (offset 198, **gs+0x58**) — 250 in every save. */
  readonly populationBase: number;
  /**
   * Interval clock of the PLAYER statistics (offset 80, gs+0x20e). The recorder fires as soon as
   * `gameTick − statTimer >= 1500` and advances the clock by exactly 1500. Over 62 saves the distance
   * lies within the window without exception — see `engine/stats-recorder.ts`.
   */
  readonly statTimer: number;
  /** The same for the WARE statistics (offset 82, gs+0x210), interval 6000. */
  readonly resourceTimer: number;
  /**
   * Slot of the winner (offset 202, gs+0x5e), −1 = none yet. −1 in all 62 saves. Set by the victory
   * detection respectively on reaching a training mission goal.
   */
  readonly winnerIndex: number;
  /**
   * Victory bit mask (offset 204, gs+0x380): bit `slot` = this player is above 74 % in LAND OWNERSHIP,
   * bit `slot+4` = the same for COMBAT STRENGTH. The recorder rebuilds it every interval; the winner
   * is whoever has BOTH bits. Only `0x00` and `0x11` observed.
   */
  readonly victoryMask: number;
  /** `0xff` ⇒ the mission-end screen is due (offset 205, gs+0x381). 0 in all saves. */
  readonly missionEndPending: number;
  /** Map size class (3..10). */
  readonly mapSize: number;
  readonly mapCols: number;
  readonly mapRows: number;
  readonly tileCount: number;
  /**
   * Engine-internal sub-frame counter (0..7) — NOT a `.DS` field. Set only by `snapshot()` so a
   * snapshot taken mid-run continues the frame phase losslessly (multiplayer/replay). A freshly parsed
   * `.DS` leaves it undefined, and `loadState` then starts frame aligned.
   */
  readonly frameAccum?: number;
}

/**
 * Raw block of an entity class (serfs/flags/buildings/inventories): bitmap of occupied ids + fixed
 * record size. The record fields themselves are not decoded here.
 */
export interface EntityBlock {
  /** Bytes per record (serf 16, flag 70, building 18, inventory 120). */
  readonly recordSize: number;
  /** Highest index held (from the header). */
  readonly maxIndex: number;
  /** Indices whose occupied bit is set in the bitmap. */
  readonly occupied: readonly number[];
}

/**
 * Decoded building record (18 bytes). Fields verified against real saves (2 castles = 2 active
 * players, owner ∈ {0,1}, types ∈ [0,24], positions within the map bounds).
 */
/** A stock slot of a building (incoming ware): available + requested (0..15 each). */
export interface BuildingStockSlot {
  readonly available: number;
  readonly requested: number;
}

export interface BuildingRecord {
  readonly index: number;
  /** Map position, decoded from the u32 position word. */
  readonly col: number;
  readonly row: number;
  /** Building type 0..24 (0 = none/reserved slot, 24 = castle). */
  readonly type: number;
  readonly typeName: string;
  /** Owning player 0..3. */
  readonly owner: number;
  /** Under construction (not finished yet). */
  readonly constructing: boolean;
  /** Baufortschritt (u16). */
  readonly progress: number;
  /** Index of the associated flag. */
  readonly flag: number;
  readonly firstKnight: number;
  /** Status bits from byte 5. */
  readonly active: boolean;
  readonly burning: boolean;
  readonly holder: boolean;
  readonly serfRequested: boolean;
  /** Bedrohungsstufe (Byte 5, Bits 0–1). */
  readonly threatLevel: number;
  /** Carrier/worker request failed (byte 5, bit 2). */
  readonly serfRequestFailed: boolean;
  /** A sound is playing (byte 5, bit 3). */
  readonly playingSfx: boolean;
  /**
   * Two stock slots (bytes 8/9): available + requested incoming wares, 0..15 each.
   *
   * LOSSLESS: the nibbles are always those of the real byte. An inventory building carries the marker
   * `0xFF` in both slots and therefore appears here as `{15,15}` — that is not a ware stock but the
   * computed value at which the original recognises the inventory path (`hasInventoryMarker` in
   * `engine/building-tables.ts`). Reading the nibbles as a quantity requires excluding it first.
   */
  readonly stock: readonly [BuildingStockSlot, BuildingStockSlot];
  /** Inventory marker (byte 8 == 0xFF or building type warehouse/castle). */
  readonly hasInventory: boolean;
  /**
   * Index of the linked inventory record — verified through the reverse cross-check (the inventory
   * points back with `building`). Set only for a finished inventory building (byte 14 as u32 ÷120);
   * otherwise `null`.
   */
  readonly inventoryIndex: number | null;
  /** The `u.level` union (byte 14 as u16) for non-inventory buildings; otherwise `null`. */
  readonly level: number | null;
  /** Stock maxima (bytes 16/17) — set only during construction; otherwise `null`. */
  readonly stockMaximum: readonly [number, number] | null;
}

/**
 * State-dependent fields of a serf (the 5 union bytes 11..15). Which variant applies is determined by
 * the `state` (byte 10). Modelled as a discriminated union over `category`. Several original states
 * share the same layout (e.g. Transporting+Delivering → `transporting`).
 */
export type SerfStateFields =
  | { readonly category: 'none' }
  | { readonly category: 'idleInStock'; readonly invIndex: number }
  | {
      readonly category: 'walking';
      readonly dir1: number;
      readonly dest: number;
      readonly dir: number;
      readonly waitCounter: number;
    }
  | {
      readonly category: 'transporting';
      readonly res: number;
      readonly dest: number;
      readonly dir: number;
      readonly waitCounter: number;
    }
  | { readonly category: 'enteringBuilding'; readonly fieldB: number; readonly slopeLen: number }
  | {
      readonly category: 'leavingBuilding';
      readonly fieldB: number;
      readonly dest: number;
      readonly dest2: number;
      readonly dir: number;
      readonly nextState: number;
    }
  | { readonly category: 'readyToEnter'; readonly fieldB: number }
  | {
      readonly category: 'digging';
      readonly hIndex: number;
      readonly targetH: number;
      readonly digPos: number;
      readonly substate: number;
    }
  | {
      readonly category: 'building';
      readonly mode: number;
      readonly bldIndex: number;
      readonly materialStep: number;
      readonly counter: number;
    }
  | { readonly category: 'buildingCastle'; readonly invIndex: number }
  | {
      readonly category: 'moveResourceOut';
      readonly res: number;
      readonly resDest: number;
      readonly nextState: number;
    }
  | {
      readonly category: 'readyToLeaveInventory';
      readonly mode: number;
      readonly dest: number;
      readonly invIndex: number;
    }
  | {
      readonly category: 'freeWalking';
      readonly distCol: number;
      readonly distRow: number;
      readonly negDist1: number;
      readonly negDist2: number;
      readonly flags: number;
    }
  | {
      readonly category: 'leaveForWalkToFight';
      readonly distCol: number;
      readonly distRow: number;
      readonly fieldD: number;
      readonly fieldE: number;
      readonly nextState: number;
    }
  | { readonly category: 'workingMode'; readonly mode: number }
  | {
      readonly category: 'smelting';
      readonly mode: number;
      readonly counter: number;
      readonly type: number;
    }
  | { readonly category: 'mining'; readonly substate: number; readonly res: number; readonly deposit: number }
  | {
      readonly category: 'idleOnPath';
      readonly revDir: number;
      readonly flag: number;
      readonly fieldE: number;
    }
  | { readonly category: 'defending'; readonly nextKnight: number }
  | {
      readonly category: 'attacking';
      readonly move: number;
      readonly attackerWon: number;
      readonly fieldD: number;
      readonly defIndex: number;
    };

/**
 * Decoded serf record (16 bytes). The common 11-byte head is verified against real saves (types ∈
 * [0,27], states ∈ [0,76], positions within the map bounds, owner ~50/50 in a one-on-one, exactly one
 * null slot with `pos === null`). The 5 state-specific union bytes (11..15) stand ONLY RAW in
 * `stateData` — as in the original, which knows no decoded variant. Whoever needs a named view takes
 * it through `serfStateFields(serf)`; it is a DERIVATION and therefore not carried along: the state
 * machine writes the raw bytes, and a stored image of them goes stale with the first tick.
 */
export interface SerfRecord {
  readonly index: number;
  /** Owning player 0..3 (byte 0, bits 0-1). */
  readonly owner: number;
  /** Serf type 0..27 (byte 0, bits 2-6). */
  readonly type: number;
  readonly typeName: string;
  /** Sound flag (byte 0, bit 7). */
  readonly sound: boolean;
  /** Animation index (byte 1). */
  readonly animation: number;
  /** Animation counter (bytes 2-3, u16). */
  readonly counter: number;
  /** Map position (bytes 4–7); `null` if the original holds 0xFFFFFFFF (no tile). */
  readonly col: number | null;
  readonly row: number | null;
  /** Tick stamp (bytes 8-9, u16). */
  readonly tick: number;
  /** State 0..76 (byte 10). */
  readonly state: number;
  readonly stateName: string;
  /** The 5 state-dependent union bytes (11..15) — the only storage; reading via `serfStateFields`. */
  readonly stateData: readonly number[];
}

/** An endpoint a flag is connected to in one direction. */
export interface FlagConnection {
  /** `flag` = road to another flag, `building` = building (direction UpLeft only). */
  readonly kind: 'flag' | 'building';
  /** Target index (flag or building slot). Reconstructed from the byte offset (÷70 / ÷18). */
  readonly index: number;
}

/**
 * Decoded flag record (70 bytes). The structure is verified against real saves: the endpoint offsets
 * (bytes 36..59) are byte pointers into the flag/building arrays — divisible by 70 (flag) respectively
 * 18 (building) across all saves and within the index range (0 violations). That confirms the road
 * bits, `hasBuilding`, owner ∈ {0,1} and the record size simultaneously.
 *
 * The flag stores NO POSITION of its own in the record (the original sets `pos` later from the map).
 * Transient search fields, transporter counters, road lengths and stock priorities remain open.
 */
export interface FlagRecord {
  readonly index: number;
  /** Owning player (byte 3, bits 6–7); verified ∈ {0,1} in a one-on-one. */
  readonly owner: number;
  /** A building is attached to the flag (byte 4, bit 6). */
  readonly hasBuilding: boolean;
  /** Wares not yet scheduled lie at the flag (byte 4, bit 7). */
  readonly hasResources: boolean;
  /**
   * Per direction 0..5: bit `dir` of byte 4 — **"this road is a LAND ROAD"**.
   *
   * It is the gate of the SETTLER NETWORK: all network traversals of the original that move or request
   * settlers iterate this byte — not {@link paths}. Wares run over {@link transporters} (`flag[5]`)
   * instead, and on a boat road the carrier is the sailor. Survey, addresses and data evidence:
   * `engine/flag-update.ts::landNeighborFlag`.
   */
  readonly endpointDirs: readonly boolean[];
  /** Per direction 0..5 (Right, DownRight, Down, Left, UpLeft, Up): is there a road? */
  readonly paths: readonly boolean[];
  /** Per direction 0..5: connected endpoint or `null` (no road / NULL offset). */
  readonly connections: readonly (FlagConnection | null)[];
  /** 8 ware slots: resource type (-1 = empty, otherwise 0..25); verified in range. */
  readonly resourceSlots: readonly number[];
  /** Transient search state field (bytes 0..1); its meaning for the state model is open. */
  readonly searchNum: number;
  /** Search direction (byte 2); transient. */
  readonly searchDir: number;
  /** Per direction 0..5: does this road have a carrier? (byte 5, bit mask). */
  readonly transporters: readonly boolean[];
  /** The flag has requested a carrier without success (byte 5, bit 7). */
  readonly serfRequestFail: boolean;
  /** Per direction 0..5: raw `length` value (bytes 6..11) — carrier count and category, packed. */
  readonly length: readonly number[];
  /** Per ware slot 0..7: pickup direction (-1 = not scheduled, otherwise 0..5). */
  readonly slotDir: readonly number[];
  /** Per resource slot 0..7: destination index (u16, bytes 20..35). */
  readonly slotDest: readonly number[];
  /** Per direction 0..5: opposite direction at the connected endpoint (bytes 60..65, bits 3-5). */
  readonly otherEndDir: readonly number[];
  /**
   * Per direction 0..5: a ware waits for pickup in this direction (bytes 60..65, bit 7). Transport
   * scheduler state — the carrier checks it on reaching the flag.
   */
  readonly scheduled: readonly boolean[];
  /**
   * Per direction 0..5: which of the 8 ware slots is to be picked up in this direction (bytes 60..65,
   * bits 0–2). Valid only when `scheduled[dir]`.
   */
  readonly scheduledSlot: readonly number[];
  /** The stock accepts serfs (byte 66, bit 7). Meaningful only with `hasBuilding`. */
  readonly acceptsSerfs: boolean;
  /** The stock accepts wares (byte 68, bit 7). Meaningful only with `hasBuilding`. */
  readonly acceptsResources: boolean;
  /**
   * Raw flag byte 66 (`bld_flags`): bit 7 = `acceptsSerfs`, **bits 0–5 = the material demand mask for
   * stock slot 0** (which ware the attached building requests in slot 0; bit index = `reqBit` of the
   * ware demand mapping). Read by the ware scheduler, set when the worker enters.
   */
  readonly bldFlags: number;
  /** Raw flag byte 68 (`bld2_flags`): bit 7 = `acceptsResources`, bits 0-5 = demand mask of slot 1. */
  readonly bld2Flags: number;
  /** Two stock priorities (byte 67/69); relevant only with an attached building. */
  readonly stockPriority: readonly [number, number];
}

/** One entry of the outgoing queue of an inventory (bytes 58..63). */
export interface InventoryOutQueueSlot {
  /** Resource type (-1 = empty slot, otherwise 0..25); verified in range. */
  readonly type: number;
  /** Destination index (flag) the ware is to be delivered to. */
  readonly dest: number;
}

/**
 * Decoded inventory record (120 bytes) — the ware stock of a stock building (castle/warehouse). The
 * structure is verified against real saves: `building` points at a castle/warehouse without exception
 * (cross-check against the building records), `flag`/`building`/serf indices all lie in the valid
 * index range (0 violations), and the inventory count equals castles + warehouses.
 */
export interface InventoryRecord {
  readonly index: number;
  /** Owning player (byte 0); verified ∈ {0,1} in a one-on-one. */
  readonly owner: number;
  /** Raw byte 1 (resource/serf mode, packed). */
  readonly resDir: number;
  /** Resource acceptance mode (byte 1, bits 0-1): 0=in, 1=stop, 2=out. */
  readonly resMode: number;
  /** Serf acceptance mode (byte 1, bits 2-3). */
  readonly serfMode: number;
  /** Index of the associated flag (byte 2); verified < maxFlagIndex. */
  readonly flag: number;
  /** Index of the associated building (byte 4); verified: points at a castle/warehouse. */
  readonly building: number;
  /** 26 stock counts, index = resource type (0..25, see `RESOURCE_TYPE_NAMES`). */
  readonly resources: readonly number[];
  /**
   * Outgoing queue (2 slots, bytes 58..63): wares already scheduled for delivery. `type` ∈ [-1,25] and
   * `dest` < maxFlagIndex verified against real saves.
   */
  readonly outQueue: readonly InventoryOutQueueSlot[];
  /** Number of idle generic serfs in the stock (byte 64). */
  readonly genericCount: number;
  /**
   * 27 entries per serf type (byte 66+): the SERF INDEX of a stored serf (0 = none), NOT a count —
   * verified: all non-zero values < maxSerfIndex.
   */
  readonly serfIndices: readonly number[];
}

/**
 * Decoded player record (8628 bytes; only the first ~480 B are structurally known, the rest is open —
 * presumably statistics history). The building counters are cross-verified:
 * `completedBuildingCount`/`incompleteBuildingCount` agree exactly with the values tallied
 * independently from the building records over all active players of all three saves (array index j ↔
 * building type j+1). `index` == slot position, verified as well.
 */
export interface PlayerRecord {
  /** Player slot 0..3. */
  readonly slot: number;
  /** `index` field (offset 128); verified == `slot` for active players. */
  readonly index: number;
  /** „Aktiv"-Bit (flags Byte 130, Bit 6). */
  readonly active: boolean;
  /**
   * Raw flags byte (`player+2`, .DS offset 130):
   * - **Bit 0 = castle founded** (`found_castle` sets it @0x28e37; the control bar shows the geologist
   *   icon only while it is clear).
   * - **Bit 1 = on an attack the STRONGER knights attack** (default clear = "the weaker ones", manual
   *   p. 101). The two tick rows of the knight menu (screen 0x2d) are `btr`/`bts` on exactly this;
   *   `dispatchAttackers` then picks the rank from the garrison.
   * - Bit 2 = a shift change is running.
   * - **Bit 3 = wake-up "new message enqueued"** (`add_player_message` sets it; the consumer
   *   acknowledges it without emptying the list).
   * - Bit 6 = active (== {@link active}).
   * - **Bit 7 = AI player** (`init_players` sets it at face < 0xc; 78/78 players, 0 counterexamples).
   *   The countdowns `player+0x1b0/0x1b2` run for AI players only.
   */
  readonly flags: number;
  /**
   * Finished buildings per type — verified against the building records. 23 entries, array index j ↔
   * building type (j+1), i.e. [0]=Fisher … [22]=GoldSmelter (castle separately).
   */
  readonly completedBuildingCount: readonly number[];
  /** Buildings under construction per type (same indexing) — verified. */
  readonly incompleteBuildingCount: readonly number[];
  /**
   * Cached serf census per type (0..26). Agrees with the serf records up to ±1–2 (a cached counter,
   * not a live value) — the difference mostly at type 4 (TransporterInventory).
   */
  readonly serfCount: readonly number[];
  /**
   * **Land ownership score** (u32, offset 402 = `player+0x112`) — the NUMBER OF OWN MAP TILES.
   * Verified over 62 saves / 124 active players against the count taken independently from the tile
   * block: 124/124 exact, upper half (@404) 0 everywhere.
   *
   * The recorder records it as statistics aspect 1 "land ownership" and derives the first of the two
   * victory bits from it (`engine/stats-recorder.ts`). It is maintained incrementally: ±1 per
   * recoloured tile in the territory recolour, ±7 for the conquest footprint.
   */
  readonly totalLandScore: number;
  /** Total building score (u32, offset 406). */
  readonly totalBuildingScore: number;
  /** Total military score (u32, offset 410). */
  readonly totalMilitaryScore: number;
  /**
   * **Castle balance** (i16, offset 478 = `player+0x15e`) — "castles captured minus castles lost".
   *
   * It has exactly ONE READER, {@link updateKnightMorale} (@0x1185a), and two writers, both
   * castle-specific (`cmpw $0x60` = type 24): `+1` for the winner when a knight occupies an enemy
   * CASTLE (serf state 52, @0x16b90, right before the `demolish_building`), and `−1` for the owner
   * when his castle burns down (castle branch of the holder ejection, @0x49504).
   *
   * Effect on the morale: POSITIVE ⇒ `goldMorale += value · 1024` (0xffff on overflow), NEGATIVE ⇒
   * `goldMorale −= 0x3ff` (lower bound 1). A captured enemy castle is therefore a permanent morale
   * boost, losing one's own a slump.
   *
   * 0 in all 124 active players of the corpus — the effect is therefore not checkable against data and
   * proven at the ASM alone.
   */
  readonly castleCaptureBalance: number;
  /**
   * Serf index of the CASTLE BUILDER (u16, offset 494 = `player+0x16e`). Exactly one writer —
   * `create_founding_serfs` @0x2965d, right next to `bld[10] = serfIndex` — and exactly one reader:
   * the castle branch of `demolish_building` (@0x49522), which throws this serf out when the castle is
   * lost. After the castle is finished the field is NOT reset; it then points at the serf that has
   * meanwhile become a stock transporter.
   */
  readonly castleBuilderSerf: number;
  /**
   * Player/AI difficulty (u8, offset 482 = `player+0x162`) — selects/interpolates the initial ware
   * table on a new game.
   */
  readonly difficulty: number;
  /**
   * Hint message bits (u8, offset 483 = `player+0x163`): bit `n` = message `n` already shown; bit 0
   * switches the hint messages off completely.
   */
  readonly messageFlags: number;
  /**
   * **Withheld build reserve** (2× u8, offsets 484/485 = `player+0x164/0x165`): 7 planks and 2 stones
   * which the castle founding SUBTRACTS from the stock (`inv+0x14 -= 7`, `inv+0x18 -= 2`) and parks in
   * these two counters until the first hint messages have run — then `FUN_000111b2` returns them to
   * the stock and zeroes the counters.
   *
   * They become visible only in the castle window (screen 0x26): its renderer adds them onto the
   * displayed plank respectively stone count so the total is right for the player.
   */
  readonly heldPlanks: number;
  readonly heldStone: number;
  /**
   * Three message slots (3× u16, offset 486 = `player+0x166/0x168/0x16a`): index of the building for
   * which a hint message is still due — slot 0 = first LUMBERJACK (type 2), slot 1 = first SAWMILL
   * (17), slot 2 = first STONECUTTER (4). The build action fills the respective slot when placing
   * (only while `messageFlags` bit 0 is off), the message display zeroes it again → 0 in mid-game
   * saves, as expected.
   */
  readonly messageBuildingSlots: readonly number[];
  /**
   * **Delay of the material return** (u16, offset 492 = `player+0x16c`). When the hint generator
   * `FUN_000111b2` triggers the plank or stone hint, it sets this field to 2; on the transition to 0 it
   * returns the `heldPlanks`/`heldStone` parked by the castle founding to the castle inventory. The
   * player therefore first gets the hint "no more planks", and two passes later the reserve appears —
   * that is the teaching function of the tutorial, not a timer in the usual sense. Exactly one writer
   * and one reader (the same routine).
   */
  readonly hintReturnDelay: number;
  /**
   * **Generic supply throttle** (u16, offset 480 = `player+0x160`) — the first value of the history
   * prefix region. If a stock runs out of unspecialised settlers, the shared stock tail
   * (`engine/stock-building.ts`, @0x1537e) requests one from the flag network — but only every fifth
   * pass. Exactly one writer/reader.
   *
   * Byte-verified over 124 active players: the value lies WITHOUT EXCEPTION in 0..5 (observed
   * 0/1/3/4). For an arbitrary u16 region that would be practically impossible.
   */
  readonly genericRequestCooldown: number;
  /**
   * **Shift-change countdown** (u16, offset 496 = `player+0x170`). `0` = no shift change running;
   * otherwise the remaining ticks of the running rotation. The button in the knight menu (`@0x2dda4`)
   * and the AI counterpart (`@0x54862`) set it to 1200, the player tick (`@0xf0f9`) counts it down and
   * switches the three `flags` bits 2/4/5 by it (details in `engine/player-settings.ts`).
   */
  readonly knightShiftTimer: number;
  /**
   * **Request throttle of the castle** (u16, offset 500 = `player+0x174`). If the castle garrison finds
   * neither a knight nor an armable generic in its own stock, it requests one through the flag network
   * from a FOREIGN stock — but only every fifth pass. Exactly one writer/reader:
   * `castle_building_handler` (the `@0x14e9e` branch).
   */
  readonly castleRequestCooldown: number;
  /**
   * **Gold accumulator of the stocks** (u32, offset 512 = `player+0x180`). Not a stock level: the
   * shared stock tail (@0x1537e) adds the gold-bar supply of EVERY own stock here per round, and
   * `update_knight_morale` (@0x11793) reads the sum together with the military counterpart
   * `player+0x17c`, makes {@link goldDeposited} + {@link goldMorale} of it and ZEROES BOTH. Because the
   * consumer runs once per rotation round, the full sum stands in the save.
   *
   * Byte-verified over 124 active players: in 120 cases the value is exactly the sum of the gold bars
   * of all own stocks.
   */
  readonly goldAccumulator: number;
  /**
   * **Gold capacity of the military buildings** (u32, offset 504 = `player+0x178`) — an accumulator
   * like {@link goldAccumulator}: `militaryGoldDemand` adds the capacity of every OCCUPIED military
   * building per round (hut 2 / tower 4 / fortress 8), `updateKnightMorale` zeroes it.
   *
   * Verified: 116 of 124 active players exact (the rest stand between reset and next pass). NOT read
   * by the morale computation itself — the field is the reference for other evaluations and is only
   * carried along because the same pass writes it.
   */
  readonly militaryGoldCapacity: number;
  /**
   * **Gold in the military buildings** (u32, offset 508 = `player+0x17c`) — the second summand of
   * {@link goldDeposited}, counterpart to {@link goldAccumulator}. Verified: 117 of 124 exact.
   */
  readonly militaryGoldAccumulator: number;
  /**
   * **Relative military strength** (u16, offset 518 = `player+0x186`) — computed by
   * `updateKnightMorale` at the end: own `totalMilitaryScore · (goldMorale >> 5) / 128` against the SUM
   * OF THE OTHER PLAYERS, as a 16-bit fraction (`0` = hopeless, `0xffff` = superior). Purely derived.
   */
  readonly militaryStrengthRatio: number;
  /**
   * **Gold morale** (u16, offset 516 = `player+0x184`) — the "courage" of the knights, computed once
   * per rotation round from the deposited gold (`engine/knight-morale.ts`):
   * `1024 + share·mapGoldMoraleFactor`, then the castle balance. Read by combat (state 45) as the
   * morale factor on enemy/neutral land (on own land the maximum morale 0x1000 applies).
   *
   * `0x1000` is in the code only the special case "map without gold" — and at the same time the
   * denominator of the percentage display in the knight menu (4096 == 100 %). There is no clamp in the
   * computation; with the real factor 20480 about 21500 would be reachable with a full depot. Highest
   * value in unedited saves: 3984.
   */
  readonly goldMorale: number;
  /**
   * **Deposited gold** (u16, offset 520 = `player+0x188`) — the amount of gold from which
   * {@link goldMorale} arises (gold in stocks + in military buildings; gold in transit does not
   * count). The knight menu (screen 0x2d) shows it directly below the morale percentage.
   *
   * Verified through the morale formula across two saves of the same map: one has 270 deposited and
   * morale 3984 = 1024 + 2960, the other 18 and 1221 = 1024 + 197 — both yield the same factor
   * (20480 = 0x5000) at the same `mapGoldTotal`.
   */
  readonly goldDeposited: number;
  /**
   * Two coupled counters of the KNIGHT MENU (2× u16, offsets 522/524 = `player+0x18a/0x18c`). The menu
   * shows both below one another; the lower number ({@link knightMenuValue}) is adjustable between
   * 1 and 99 with `−`/`+` (`FUN_0002de5c`/`FUN_0002de8f`).
   *
   * Byte-characterised:
   * - init after the castle founding: `0x18a = 3`, `0x18c = 0`.
   * - `0x18c` is changed exclusively in the garrison reconciliation (`FUN_00014da5`/`FUN_000133a2`)
   *   and led step by step towards `0x18a`; on a tie the routine rotates knight ranks (the "shift
   *   change" of the manual, p. 100). In all saves except right after the founding both are equal.
   * - For AI players `FUN_000546ea` computes the value from a compression curve.
   */
  readonly knightMenuValue: number;
  readonly knightMenuCounter: number;
  /**
   * **Activity rate of the AI character** (block 558, `player+0x1ae`) — the threshold of the random
   * gate in the AI sweep: the AI tick runs only at `rng16 < aiRate`. The only writer is the game start
   * (@0x6aad) with `intelligence · 1300 + 13535`; the highest intelligence 40 exhausts the u16 with
   * exactly 65535. For human players the `0xFFFF` initialisation stands here (never read, because the
   * gate aborts at the AI bit beforehand).
   */
  readonly aiRate: number;
  /**
   * **AI state** (block 564, `player+0x1b4`) — index into the 4-slot jump table @0x51040:
   * 0 = search a castle site, 1 = settling-in phase after founding, 2 = continuous operation,
   * 3 = idle. Over 62 saves AI players take only 0/1/2, humans 0 without exception.
   */
  readonly aiState: number;
  /**
   * **Counter/phase of the AI state** (block 566, `player+0x1b6`). The meaning depends on the state:
   * in state 1 a countdown (start 24) until the transition into continuous operation, in state 2 an
   * upward counter whose lower 3 bits choose "probe or subtask" and whose bits 3..6 choose the
   * subtask.
   */
  readonly aiCounter: number;
  /**
   * Tool production priorities (offset 0): 9× u16 slider share (0..65535) for
   * shovel/hammer/rod/cleaver/scythe/axe/saw/pick/pincer. Verified (in range; one real save carries
   * exactly the default distribution).
   */
  readonly toolPriority: readonly number[];
  /**
   * Transport priority per resource type (offset 44): 26× u8, a PERMUTATION OF 1..26. Verified
   * (0 violations across all 6 active players).
   */
  readonly flagPriority: readonly number[];
  /**
   * Stock acceptance priority per resource type (offset 224): 26× u8, a PERMUTATION OF 1..26.
   * Verified (0 violations across all 6 active players).
   */
  readonly inventoryPriority: readonly number[];
  /**
   * Knight occupation per threat level (offset 124): 4× u8, each `(max<<4)|min` with `min≤max≤4`.
   * Verified (0 violations; default `10/21/32/43` for an untouched player).
   */
  readonly knightOccupation: readonly number[];
  /**
   * Production accumulator per resource type since the last history interval (offset 18): 26× u8,
   * small (0..2 observed), flows into `resourceHistory`.
   */
  readonly resourceCount: readonly number[];
  /** Index of the own castle building (u16, offset 388). Verified (points at a castle, owner==slot). */
  readonly castleBuilding: number;
  /** Flag index of the castle (u16, offset 390). Verified (== `Castle.flag`). */
  readonly castleFlag: number;
  /** Inventory index of the castle (u16, offset 392). */
  readonly castleInventory: number;
  /**
   * Build status bitfield (u8, offset 131): bit 0 = military building locked, bit 2 = the initial
   * castle serfs were created, bit 3 = owns a castle. Verified (bits 2|3 set for every castle owner).
   */
  readonly build: number;
  /** Last processed tick (u16, offset 414). Verified (== `header.tick`). */
  readonly lastTick: number;
  /** Reproduction counter (u16, offset 416). Verified (< `reproductionReset`). */
  readonly reproductionCounter: number;
  /**
   * Reproduction threshold (u16, offset 418) = `(60 - reproduction) * 50`. Verified (a multiple of 50,
   * `reproduction` ∈ [0,60]).
   */
  readonly reproductionReset: number;
  /** Serf-to-knight rate (u16, offset 420). Verified (default 20000 for an untouched player). */
  readonly serfToKnightRate: number;
  /** Serf-to-knight counter (u16, offset 422). A live counter (in range, characterised). */
  readonly serfToKnightCounter: number;
  /** Number of buildings selected for an attack (u16, offset 424). Verified (0 on the defensive). */
  readonly attackingBuildingCount: number;
  /** Total number of attacking knights (u16, offset 434). Verified (0 on the defensive). */
  readonly totalAttackingKnights: number;
  /** Index of the attacked enemy building (u16, offset 436; 0 = none). Verified. */
  readonly buildingAttacked: number;
  /** Indices of the own attacker buildings (offset 250, non-zero entries). Verified. */
  readonly attackingBuildings: readonly number[];
  /**
   * Attacking knights per distance band [4] (4x u16, offset 426). Verified by cross-check:
   * the sum == `totalAttackingKnights` (offset 434), exactly 6/6 over all active players.
   */
  readonly attackingKnights: readonly number[];
  /**
   * **Number of knights chosen in the attack window** (u16, offset 438 = `player+0x136`). The attack
   * branch of the map click sets it on opening to `min(type bound, available)`; the buttons of the
   * window (screen 0x14/0x15) raise or lower it. `FUN_0003169c` ("launch attack") reads it as the
   * count.
   *
   * The field is therefore proven at the code — in saves without an open attack window it is 0.
   */
  readonly knightsAttacking: number;
  /**
   * UI cursor of distribution menu 5 (u16, offset 378). Verified (default 8 for an untouched player).
   * A pure menu position, not game state.
   */
  readonly currentSett5Item: number;
  /**
   * **Build/map cursor** (u16, offsets 380/382 = `player+0xfc`/`0xfe`). The map click writes both
   * before any further evaluation (`FUN_000272d7` @0x29d84 ff.); the build-site classification and all
   * cursor-related windows read them.
   *
   * Important for the model: the original knows NO state "no tile selected" — the cursor is part of
   * the save and always valid after loading.
   */
  readonly cursorCol: number;
  readonly cursorRow: number;
  /**
   * UI cursor of distribution menu 6 (u16, offset 476). Verified (default 15, 6/6). A pure menu
   * position, not game state.
   */
  readonly currentSett6Item: number;
  /**
   * Continue-search-after-non-optimal-hit (u16, offset 394). Verified (default 7, 6/6). A
   * transport/search heuristic parameter.
   */
  readonly contSearchAfterNonOptimalFind: number;
  /** Knights to be spawned (u16, offset 396). Verified (∈ [0,2], 6/6 — matches the original clamp). */
  readonly knightsToSpawn: number;
  /**
   * Geologist analysis results [GoldOre, IronOre, Coal, Stone] (4x u16, offset 440). **Verified**
   * (= 0 in every observation — the default).
   */
  readonly analysis: readonly number[];
  /**
   * Food distribution [stone mine, coal mine, iron mine, gold mine] (4x u16, offset 448), slider
   * shares 0..65535. Verified (exact default match for an untouched player).
   */
  readonly foodDistribution: readonly number[];
  /** Plank distribution [construction, boatbuilder, toolmaker] (3x u16, offset 456). Verified. */
  readonly planksDistribution: readonly number[];
  /** Steel distribution [toolmaker, weaponsmith] (2x u16, offset 462). **Verified** (exact default match). */
  readonly steelDistribution: readonly number[];
  /** Coal distribution [steel smelter, gold smelter, weaponsmith] (3x u16, offset 466). Verified. */
  readonly coalDistribution: readonly number[];
  /** Wheat distribution [pig farm, mill] (2x u16, offset 472). Verified. */
  readonly wheatDistribution: readonly number[];
  /**
   * Statistics comparison history (player offset 2884): 16 modes × 112 samples (u8), normalised shares
   * 0..100. `mode = (aspect<<2)|level`, aspect 0=score/1=land/2=buildings/3=military, level 0..3 = the
   * four time scales. Ring buffer; the current write position per level is in
   * `header.playerHistoryIndex`. Empty (`[]`) for inactive players.
   */
  /**
   * **Message list** (block 7796 = `player+0x1df4`, 64 slots): the type bytes of the enqueued
   * messages, PREFIX-PACKED — the list ends at the first type 0. Only the occupied slots are kept.
   *
   * Written by `add_player_message` (@0x18234): first free slot, type byte + map position, plus
   * `flags` bit 3 as a wake-up. Verified over 39 saves / 78 active players, 0 violations. The consumer
   * clears only the type byte → read messages disappear from the list, their position remains as a
   * residual in the byte block.
   */
  readonly messageTypes: readonly number[];
  /**
   * Map position per message (block 7860, 64× u32), LINEAR form `row·cols + col` — the same encoded
   * source as in the building/serf record. Same length as {@link messageTypes}.
   */
  readonly messagePositions: readonly number[];
  /**
   * **Recall queue** (block 8116 = `player+0x1f34`, 64 × `{ u32 remaining time, u32 payload }`) and its
   * fill level (block 370 = `player+0x172`). The delayed self-message of the manual (pp. 109–110);
   * reading, payload union and timing are in `engine/message-recall.ts`.
   *
   * Unlike the message list beside it, ALL 64 SLOTS are kept, not only the occupied ones — the
   * original's consumer is at one point not equivalent to "remove element" (reasoning in the module
   * header of `message-recall.ts`).
   *
   * The field is proven only at the ASM (the binary's single `add $0x1f34` plus the three writers in
   * the 16-bit form) and through the field sum `7796 + 64 + 256 + 512 == 8628` == block size. **A byte
   * proof is impossible**: over 62 saves / 124 active players the counter is 0 without exception and
   * the 512 bytes are completely zeroed — no existing save has a recall set.
   */
  readonly recallCount: number;
  readonly recallQueue: readonly { readonly remaining: number; readonly payload: number }[];
  /**
   * **AI build-site candidates** (block 1204, `player+0x434`) — `[project][slot]` with
   * `{score, column, row}`, 35 projects × 8 slots. The probe evaluates a location for every eligible
   * project and records it here; the recorder (`FUN_0005dcd0`) keeps the eight best locations per
   * project. Score 0 == empty slot (the position remains as a residual).
   *
   * **Byte-verified** over 62 saves: 13146 occupied slots, 0 with a column or row outside the map, all
   * 35 projects represented; the length works out exactly — `1204 + 35 · 48 == 2884` is precisely the
   * start of the statistics history.
   */
  readonly aiCandidates: readonly (readonly {
    readonly score: number;
    readonly col: number;
    readonly row: number;
  }[])[];
  /**
   * **Supply ratio per consumer group** (block 956, `player+0x33c`) — 21 × u16, the first of the three
   * tables of the {@link ../engine/ai-census.ts AI census}. Per group "available supply" is summed
   * against "capacity" over all own buildings; stored is the RATIO AS A 16-BIT FRACTION
   * (`supply · 65536 / capacity`), `0xffff` on a tie. Slots 19/20 belong to the construction sites
   * (planks respectively stones), 0..18 to the finished consumers.
   */
  readonly aiSupplyRatio: readonly number[];
  /**
   * **Idle settlers per profession** (block 998, `player+0x366`) — 27 × u16, second table of the
   * census: how many own serfs of each type wait for work in state `IdleInStock` (1).
   */
  readonly aiIdleSerfs: readonly number[];
  /**
   * **Stock of wares across all own inventories** (block 1052, `player+0x39c`) — 26 × u16, third table
   * of the census, summed with 16-bit saturation.
   */
  readonly aiStockpile: readonly number[];
  /**
   * **AI urgencies** (block 1104, `player+0x3d0`) — 25 × u16, one per project: the product of location
   * score and {@link aiPressure} as the 25 evaluators of the build decider leave it. The maximum
   * selection over it determines what the AI builds next.
   *
   * **Byte-proven** over 62 saves: 51 of the 62 AI players have the table filled, and the highest
   * value ever observed in the geologist row (slot 23) is 59995 — just below the upper bound
   * 59996 == 14999 · 4 arising from clamp and shift of the evaluator `@0x5ae48`.
   */
  readonly aiUrgency: readonly number[];
  /**
   * **AI build pressure** (block 1154, `player+0x402`) — 25 × u16, one per project: "how urgently the
   * AI wants to build this". Grows per interval by a fraction of the interval duration (rate per
   * project between ×1/16 and ×2), saturates at `0xffff`, and is consumed when building — the urgency
   * evaluators of the build decider multiply the location score by it.
   *
   * **Byte-verified** over 62 saves: all values in `0..0xffff`; 12 of the 25 counters are saturated in
   * ALL 62 saves, and the lowest is the flag counter (avg 30442, saturated in only 14/62) — the AI
   * builds flags most often, so its pressure is drained most often. `1154 + 25·2 == 1204` == start of
   * `aiCandidates`.
   */
  readonly aiPressure: readonly number[];
  /**
   * **Catch-up pressure** (block 568, `player+0x1b8`) — falls per interval by the interval duration
   * and is pulled up by the ratio of land ownership to building score. **The direction is the reverse
   * of what one expects**: `q = land·128/buildings` is large with much land, and `q ^ 0x3ff` makes a
   * SMALL value of it — the pressure therefore rises on DENSELY built territory, not on spacious one.
   * 0 in 45 of 62 saves (the countdown has usually run out). Reading:
   * {@link ../engine/ai-pressure.ts}.
   */
  readonly aiPressureCatchUp: number;
  /**
   * **The building round cursor** (block 538, `player+0x19a`) — u16, the building INDEX at which the
   * {@link ../engine/ai-building-round.ts building round} continues at its next turn. Per turn it
   * works through 501 slots (@0x52271) and stores the position back (@0x523cf); passing
   * `maxBuildingIndex` it starts at 0 again and the turn ends.
   *
   * **0 in all 124 slots of our saves** — the field is therefore not provable at the byte, and that is
   * no accident but a prediction of the frame: the budget (501) exceeds `maxBuildingIndex` on every
   * one of our maps (largest value: 100), so a turn always wraps and stores 0 back.
   */
  readonly aiBuildingCursor: number;
  /**
   * **The job block of the AI road builder** (blocks 540/542/548/550/552/570,
   * `player+0x19c/0x19e/0x1a4/0x1a6/0x1a8/0x1ba`) — the fields with which the
   * {@link ../engine/ai-execute.ts build executor} commissions the
   * {@link ../engine/ai-road-builder.ts road builder}. The names carry the BLOCK NUMBER, because they
   * have no name of their own in the original:
   *
   * | Block | Role |
   * |---|---|
   * | **540** | cost PER STEP: a road arises only when `cost < 540 · steps` (@0x56e1e) |
   * | **542** | RETURN VALUE — `0xffff` means "a road is still missing", 0 is set on success (@0x56e78/@0x56e8d) |
   * | **548** | number of roads still to build; ≤ 0 switches the mode "single road" (@0x5726e) and the flag filter (@0x57cde) |
   * | **550** | comparison value of the flag filter against `flag.searchNum` (@0x57d9e) |
   * | **552** | value the road builder reloads into block 540 after the first road (@0x57302) |
   * | **570** | UPPER BOUND of the road cost; above it the selection aborts (@0x56da7) |
   *
   * Byte evidence over 62 saves / 62 AI players: block 552 carries exactly the three values the
   * executor writes — `0xc`×48, `0`×12, `8`×2 —, and block 542 is 0 in all 62 saves, which confirms
   * `0xffff` as a purely transient intermediate. In ALL human slots all six are 0.
   */
  readonly aiRoadJob540: number;
  readonly aiRoadJob542: number;
  readonly aiRoadJob548: number;
  readonly aiRoadJob550: number;
  readonly aiRoadJob552: number;
  readonly aiRoadJob570: number;
  /**
   * **The flag sweep cursor** (block 544, `player+0x1a0`) — u32, the place where the
   * {@link ../engine/ai-road-network.ts road-network extension} continues at its next turn. Encoded
   * LIKE A RECORD POSITION (`((row << (rowShift+1)) | column) << 2`), not as a tile index; hence the
   * raw value is kept and read with `decodePackedPos`.
   *
   * **Byte-proven** over 62 saves / 124 active players: the round trip `encode(decode(raw)) == raw`
   * holds in 124 of 124 cases — impossible for an arbitrary u32 region and therefore the proof of the
   * encoding. Written exclusively at the end of the subtask (@0x51d37).
   */
  readonly aiFlagSweepCursor: number;
  /**
   * **The loss register** (blocks 572..603, `player+0x1bc`) — eight slots `{u16 column, u16 row}` into
   * which a defensive loss of an AI player records the map location where a military building was
   * taken from it (@0x171d0, first free slot). A slot is free when its u32 is negative — i.e.
   * `row >= 0x8000`; the init value is `-1`.
   *
   * The only reader is the {@link ../engine/ai-road-network.ts road-network extension}: it tries to
   * connect every recorded location to the road network again and clears the slot afterwards.
   *
   * **Empty in all 992 slots of our 62 saves** (`0xffffffff`) — for AI players as well. The
   * corresponding branch of the subtask is therefore not reachable from stored data; that is
   * measured, not assumed, and stands as a limit in the guard.
   */
  readonly aiLossRegister: readonly { readonly col: number; readonly row: number }[];
  /**
   * **The six character traits of the AI opponent** (blocks 526..536, `player+0x18e..0x198`) — one
   * init block with SIX PARALLEL u16 TABLES (`@0x6dcc`, `@0x6de2`, `@0x6df8`, `@0x6e0e`, `@0x6e24`,
   * `@0x6e3a`, writers `@0x6d49`..`@0x6dc1`), indexed by the character. The bounds work out exactly:
   * `0x6dcc + 22 == 0x6de2 == … == 0x6e3a`, 22 B each == 11 characters. Nobody changes them
   * afterwards, and EACH HAS EXACTLY ONE READER in the whole binary.
   *
   * **Cap of the occupation level** (block 526) — it trims the row of the occupation table in
   * `aiMilitaryPolicy`, NOT the stored value of {@link aiKnightOccupationLevel} (order in the
   * original: store @0x54cf7, cap only @0x54d0f). Observed over 62 saves: 5 / 8 / 10 / 13 / 16 — all
   * from the table `@0x6dcc` = `[13,10,16,9,10,8,6,10,12,5,8]`.
   */
  readonly aiOccupationCap: number;
  /**
   * **Knight demand when attacking** (block 528, `player+0x190`, table `@0x6de2`). The only reader is
   * `@0x54589` in the attack task: the resistance estimated from the target's garrison is scaled with
   * it before the number of knights to send is derived. An aggressive character therefore sends
   * fewer, a cautious one more.
   */
  readonly aiAttackKnightFactor: number;
  /**
   * **Attack inclination** (block 530, `player+0x192`, table `@0x6df8`). The only reader is
   * `@0x53b68` in the probability gate of the attack task — the last factor before the roll.
   */
  readonly aiAttackChanceFactor: number;
  /**
   * **Preference mask over the nine attack-target kinds** (block 532, `player+0x194`, table
   * `@0x6e0e`). The only reader is `@0x53e1e`: bit `i` set ⇒ the score of candidate row `26 + i` is
   * QUADRUPLED (doubled twice, saturating). Every character therefore prefers different targets.
   */
  readonly aiAttackTargetMask: number;
  /**
   * **Inclination towards "the stronger knights attack"** (block 534, `player+0x196`, table
   * `@0x6e24`) — a 16-bit probability: `aiMilitaryPolicy` draws a random number and sets or clears
   * `flags` bit 1 with it (`cmp %ax,0x1c(%edi)` @0x546f9). This place is the only reader.
   */
  readonly aiAttackStrongChance: number;
  /**
   * **Cap of the guard-hut urgency** (block 536, `player+0x198`, table `@0x6e3a`). The only two
   * readers in the whole binary are `@0x59a46`/`@0x59a55` — both clamp the urgency of the guard-hut
   * evaluator with it.
   *
   * **Byte-proven** over 62 saves: AI players carry exclusively 60000 (12×), 63000 (2×) and 64000
   * (48×) — three round values, as expected of a trait table and not of a runtime counter; 0 in all
   * 62 human slots.
   */
  readonly aiHutUrgencyCap: number;
  /**
   * **Chosen knight occupation level** (block 554, `player+0x1aa`) — 1..16, or **0** when even the
   * cheapest row of the occupation table `@0x54da6` needs more knights than are available. The only
   * writer is `aiMilitaryPolicy` (`mov %ax,0x1aa(%ebx)` @0x54cf7); from it the same routine fills
   * {@link knightOccupation}.
   *
   * Two readers clamp the large military buildings: the watchtower evaluator returns at `< 8`
   * (`cmpw $0x8` @0x5a92b), the fortress evaluator at `< 10` (@0x5ab99).
   *
   * **Byte-proven** over 62 saves: AI players carry only 0 (23×), 5 (20×) and 16 (19×), humans 0
   * everywhere — and 38 of the 39 non-zero values are recomputed exactly.
   */
  readonly aiKnightOccupationLevel: number;
  /**
   * **Total number of knights** (block 556, `player+0x1ac`) — the sum `serfCount[Knight0..4]` that
   * `aiMilitaryPolicy` stores as an intermediate result (`mov %ax,0x1ac(%ebx)` @0x54b47). A pure
   * cache: it recomputes it every time. Parsed because the value is thereby an INDEPENDENT byte
   * proof of the sum formula.
   */
  readonly aiKnightTotal: number;
  /**
   * **Lockout until the next shift change** (block 560, `player+0x1b0`) — `aiMilitaryPolicy` sets
   * 15000 (`mov $0x3a98` @0x54890), the player tick counts down while `flags` bit 7 is set
   * (`subw $0x1,0x1b0(%ebx)` @0xf0dd, only at `!= 0`). While it runs, the AI starts no shift change.
   */
  readonly aiShiftCooldown: number;
  /**
   * **The second AI countdown** (block 562, `player+0x1b2`) — the same tick block counts it down
   * (@0xf0c3). The name carries the block number because it was open when it was named; its
   * consumers (`@0x52d4e`/`@0x52f35`, reload values `0x2328`/`0xbb8`) lie in the building round
   * (`ai-building-round.ts`) — it is the lockout of the stock switch-over.
   */
  readonly aiTimer562: number;
  readonly statHistory: readonly (readonly number[])[];
  /**
   * Resource production history (player offset 4676): 26 resources x 120 samples (u8), production per
   * interval (an accumulator, zeroed afterwards). Resource-major; the current write position is in
   * `header.resourceHistoryIndex`. Empty (`[]`) for inactive players.
   */
  readonly resourceHistory: readonly (readonly number[])[];
}

/**
 * A map tile. Every cell carries two terrain triangles (`terrainUp`/`terrainDown`), a height and
 * possibly an object (tree/stone/flag/building). The index in `SaveGameState.mapTiles` is the
 * canonical map position `pos = (row << rowShift) | col == row * cols + col`.
 */
export interface MapTile {
  /** Height 0..31 (vertex height of the tile; for rendering → screen y offset). */
  readonly height: number;
  /** Terrain type of the up triangle 0..15 (water/grass/desert/tundra/snow variants). */
  readonly terrainUp: number;
  /** Terrain type of the down triangle 0..15. */
  readonly terrainDown: number;
  /** Object id 0..127 (0 = none; 1 = flag; 2..4 = building; trees/stones/fields above that). */
  readonly object: number;
  /** Owning player 1..4, or 0 = no owner (land unclaimed). */
  readonly owner: number;
  /** Road bits per direction (bits 0..5: Right, DownRight, Down, Left, UpLeft, Up). */
  readonly paths: number;
  /**
   * Block marker (landscape byte 0 bit 6, `0x40`). Empirically set on building tiles (object 2..4),
   * stone tiles (72..81) and some empty ones — a bit maintained by the engine meaning "a blocking
   * object stands here / no serf can stand here". The free-field engage checks it as combat-ground
   * passability (`serf-military.ts`). Not fully derivable from `object`, hence loaded along.
   */
  readonly blocked: boolean;
  /** Underground mineral 0..4 (None/Gold/Iron/Coal/Stone). Set only without a building/flag. */
  readonly mineral: number;
  /** Deposit amount 0..31 of the mineral. */
  readonly resourceAmount: number;
  /** Index of the building/flag on this tile (only at `object` ∈ [1,4]), otherwise 0. */
  readonly objIndex: number;
  /** Index of a serf on this tile (0 = none). */
  readonly serfIndex: number;
}

/** Parsed save game state — serialisable (JSON friendly, no closures). */
export interface SaveGameState {
  readonly header: SaveGameHeader;
  /** Indices 0..3 of the players whose "active" bit is set. */
  readonly activePlayers: readonly number[];
  /** Decoded player records (all 4 slots; `active` marks the occupied ones). */
  readonly playerRecords: readonly PlayerRecord[];
  readonly serfs: EntityBlock;
  readonly flags: EntityBlock;
  readonly buildings: EntityBlock;
  readonly inventories: EntityBlock;
  /** Decoded building records (occupied slots only). */
  readonly buildingRecords: readonly BuildingRecord[];
  /** Decoded serf records (occupied slots only). */
  readonly serfRecords: readonly SerfRecord[];
  /** Decoded flag records (occupied slots only). */
  readonly flagRecords: readonly FlagRecord[];
  /** Decoded inventory records (occupied slots only). */
  readonly inventoryRecords: readonly InventoryRecord[];
  /**
   * Decoded map tiles, indexed by map position `pos = row * cols + col`
   * (length == `header.tileCount`).
   */
  readonly mapTiles: readonly MapTile[];
  /** Total size of the file in bytes (== size reconstructed from the layout). */
  readonly byteLength: number;
}

/** Decoded sprite (RGBA, ready for canvas `putImageData`). */
export interface DecodedSprite {
  readonly width: number;
  readonly height: number;
  /** Pivot offset relative to the logical position (used for stack aligning). */
  readonly offsetX: number;
  readonly offsetY: number;
  /**
   * Header delta (bytes 0/1) — attachment vector for relatively positioned sprites, e.g. the serf
   * head, which sits at the `Torso` pivot plus this delta. 0 for most sprites.
   */
  readonly deltaX: number;
  readonly deltaY: number;
  /** RGBA pixels; length = width * height * 4. */
  readonly pixels: Uint8ClampedArray;
}
