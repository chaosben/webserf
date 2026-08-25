import { describe, it, expect } from 'vitest';
import { foundCastle, startingResources, STARTING_RESOURCES, FOUNDING_ROSTER } from './founding.js';
import { mapGeometry, posOf, neighbor, Direction } from './position.js';
import { LEVEL_WALK } from './building-construction.js';
import type { GameState, Player, Tile } from './state.js';

/**
 * Founding the castle of a new game (`FUN_00028dde` + `FUN_000295e6`) - the synthetic core cases:
 * resource interpolation, roster composition, structure, territory.
 */
describe('castle founding', () => {
  const GEO = mapGeometry(3); // 64x64

  function makeState(): GameState {
    const mapTiles: Tile[] = new Array(GEO.tileCount);
    for (let i = 0; i < mapTiles.length; i++) {
      mapTiles[i] = {
        height: 8, terrainUp: 8, terrainDown: 8, object: 0, owner: 0, paths: 0,
        blocked: false, mineral: 0, resourceAmount: 0, objIndex: 0, serfIndex: 0,
      } as Tile;
    }
    const player: Player = {
      slot: 0, index: 0, active: true, flags: 0, build: 0,
      serfCount: new Array(27).fill(0),
      castleBuilding: 0, castleFlag: 0, castleInventory: 0,
      // The hint chain belongs to it: founding switches it on (@0x2912b ff.). `messageFlags` starts
      // with bit 0 (`init_players` @0x684d sets it); the test below checks that founding clears it.
      messageFlags: 1, messageBuildingSlots: [0, 0, 0], hintReturnDelay: 0,
    } as unknown as Player;
    return {
      header: { maxSerfIndex: 1, maxFlagIndex: 1, maxBuildingIndex: 1, maxInventoryIndex: 0 },
      geo: GEO,
      gameTick: 100,
      serfBudget: 1999,
      serfs: [null, null],
      flags: [null, null],
      buildings: [null, null],
      inventories: [null],
      mapTiles,
      players: [player],
      blockMeta: {
        serfs: { recordSize: 16, maxIndex: 1 },
        flags: { recordSize: 70, maxIndex: 1 },
        buildings: { recordSize: 18, maxIndex: 1 },
        inventories: { recordSize: 120, maxIndex: 0 },
      },
    } as unknown as GameState;
  }

  describe('startingResources - interpolated initial goods', () => {
    it('difficulty 30 == sample point T3 exactly (frac 0)', () => {
      expect(startingResources(30)).toEqual([...STARTING_RESOURCES[3]]);
    });
    it('difficulty 0 == T0, 40 and above == T4', () => {
      expect(startingResources(0)).toEqual([...STARTING_RESOURCES[0]]);
      expect(startingResources(40)).toEqual([...STARTING_RESOURCES[4]]);
      expect(startingResources(45)).toEqual([...STARTING_RESOURCES[4]]);
    });
    it('difficulty 25 interpolates between T2 and T3 (midpoint, rounded up)', () => {
      const r = startingResources(25);
      // res[7]: T2=40, T3=80 -> 40 + round(40*(5*0x199a)/0x10000) = 40+20 = 60
      expect(r[7]).toBe(60);
      // res[24]: T2=60, T3=100 -> 60+20 = 80
      expect(r[24]).toBe(80);
      // each between the sample points
      for (let i = 0; i < 26; i++) {
        const lo = Math.min(STARTING_RESOURCES[2][i], STARTING_RESOURCES[3][i]);
        const hi = Math.max(STARTING_RESOURCES[2][i], STARTING_RESOURCES[3][i]);
        expect(r[i]).toBeGreaterThanOrEqual(lo);
        expect(r[i]).toBeLessThanOrEqual(hi);
      }
    });
  });

  it('Roster: 20 Serfs, fester Typ-Multiset', () => {
    const total = FOUNDING_ROSTER.reduce((s, e) => s + e.count, 0);
    expect(total).toBe(20);
  });

  /** Levelling height, supplied by `classify_build_site` in the original (`player+0x102`). */
  const LEVEL = 3;

  describe('foundCastle', () => {
    it('creates castle + flag + inventory with the right core fields', () => {
      const st = makeState();
      const { building, flag, inventory } = foundCastle(st, st.players[0]!, 53, 55, LEVEL, 30);

      expect(building.type).toBe(24);
      expect(building.owner).toBe(0);
      expect(building.constructing).toBe(true);
      expect(building.active).toBe(true);
      expect(building.holder).toBe(true);
      expect(building.hasInventory).toBe(true);
      expect(building.inventoryIndex).toBe(inventory.index);
      expect(building.flag).toBe(flag.index);
      expect(building.index).toBe(1); // slot 0 reserved
      expect(inventory.index).toBe(0); // inventory slot 0 is real
      expect(flag.hasBuilding).toBe(true);
      expect(flag.owner).toBe(0);
      expect(flag.acceptsSerfs).toBe(true);
      expect(flag.acceptsResources).toBe(true);
      expect(flag.bldFlags).toBe(0xc0);
      expect(flag.bld2Flags).toBe(0x80);
      expect(flag.connections[Direction.UpLeft]).toEqual({ kind: 'building', index: building.index });
    });

    it('creates exactly 20 serfs (serfBudget -20), 1 BuildingCastle + 19 IdleInStock, genericCount 5', () => {
      const st = makeState();
      foundCastle(st, st.players[0]!, 53, 55, LEVEL, 30);
      const serfs = st.serfs.filter((s) => s && s.index !== 0);
      expect(serfs.length).toBe(20);
      expect(st.serfBudget).toBe(1999 - 20);
      expect(serfs.filter((s) => s!.state === 10).length).toBe(1); // BuildingCastle (holder)
      expect(serfs.filter((s) => s!.state === 1).length).toBe(19); // IdleInStock
      // type multiset
      const types: Record<number, number> = {};
      for (const s of serfs) types[s!.type] = (types[s!.type] || 0) + 1;
      expect(types).toEqual({ 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 9: 2, 11: 1, 18: 1, 20: 2, 21: 5, 22: 3 });
      expect(st.inventories[0]!.genericCount).toBe(5);
    });

    it('initial goods = T3 minus build reserve (-7 plank / -2 stone) minus tool and weapon use', () => {
      const st = makeState();
      const { inventory } = foundCastle(st, st.players[0]!, 53, 55, LEVEL, 30);
      const r = inventory.resources;
      // the values observed byte-exactly in the original
      expect(r[7]).toBe(73); // plank: T3 80 -7 build reserve
      expect(r[9]).toBe(38); // stone: T3 40 -2 build reserve
      expect(r[15]).toBe(9); // shovel: T3 10 -1 (digger)
      expect(r[16]).toBe(26); // hammer: T3 30 -4 (toolmaker/builder/2x geologist)
      expect(r[17]).toBe(4); // rod: T3 5 -1 (fisher)
      expect(r[20]).toBe(5); // axe: T3 6 -1 (lumberjack)
      expect(r[21]).toBe(4); // saw: T3 6 -2 (toolmaker/sawmiller)
      expect(r[22]).toBe(9); // pick: T3 12 -3 (stonecutter/2x miner)
      expect(r[24]).toBe(97); // sword: T3 100 -3 (3 knights)
      expect(r[25]).toBe(97); // shield: T3 100 -3 (3 knights)
      // untouched slots == T3
      expect(r[0]).toBe(8);
      expect(r[12]).toBe(50);
    });

    it('claims territory around the castle and sets the map objects', () => {
      const st = makeState();
      const { building, flag } = foundCastle(st, st.players[0]!, 53, 55, LEVEL, 30);
      const cPos = posOf(53, 55, GEO);
      const fPos = neighbor(cPos, Direction.DownRight, GEO);
      expect(st.mapTiles[cPos].object).toBe(4); // Castle
      expect(st.mapTiles[cPos].objIndex).toBe(building.index);
      expect(st.mapTiles[fPos].object).toBe(1); // Flag
      expect(st.mapTiles[fPos].objIndex).toBe(flag.index);
      const owned = st.mapTiles.filter((t) => t.owner === 1).length;
      expect(owned).toBe(217); // byte-exact against the original
    });

    it('levels centre + six neighbours to the levelling height (@0x29376 ff.)', () => {
      const st = makeState();
      // Uneven terrain, so the check cannot pass by accident.
      const cPos = posOf(53, 55, GEO);
      let p = cPos;
      st.mapTiles[cPos].height = 9;
      const ring: number[] = [];
      for (const dir of LEVEL_WALK) {
        p = neighbor(p, dir, GEO);
        ring.push(p);
        st.mapTiles[p].height = 1 + ring.length;
      }
      // A ring-2 tile as counter-check: the walk must NOT touch it.
      const outside = neighbor(neighbor(cPos, Direction.Right, GEO), Direction.Right, GEO);
      st.mapTiles[outside].height = 17;

      foundCastle(st, st.players[0]!, 53, 55, LEVEL, 30);

      expect(st.mapTiles[cPos].height).toBe(LEVEL);
      for (const q of ring) expect(st.mapTiles[q].height).toBe(LEVEL);
      expect(new Set(ring).size).toBe(6); // the walk hits six DIFFERENT neighbours
      expect(st.mapTiles[outside].height).toBe(17);
    });

    it('sets the two path bits of the castle connection (@0x2938e / @0x2942a)', () => {
      const st = makeState();
      const cPos = posOf(53, 55, GEO);
      const fPos = neighbor(cPos, Direction.DownRight, GEO);
      foundCastle(st, st.players[0]!, 53, 55, LEVEL, 30);
      expect(st.mapTiles[cPos].paths & 0x3f).toBe(0x02); // DownRight to the flag
      expect(st.mapTiles[cPos].blocked).toBe(true);
      expect(st.mapTiles[fPos].paths & 0x3f).toBe(0x10); // UpLeft to the building
      // The FLAG itself does not carry the bit - only the tile (see `build-site.ts`).
      expect(st.flags[st.mapTiles[fPos].objIndex]!.paths[Direction.UpLeft]).toBe(false);
    });

    it('switches the hint chain on: bits 0..5 cleared, slots + countdown zeroed (@0x2912b ff.)', () => {
      const st = makeState();
      const p = st.players[0]!;
      // Starting point as after `init_players`: bit 0 set ("hints done"), plus bits 6/7 as a control -
      // the original's block only touches 0..5.
      p.messageFlags = 0xc1;
      p.messageBuildingSlots = [11, 12, 13];
      p.hintReturnDelay = 5;

      foundCastle(st, p, 53, 55, LEVEL, 30);

      expect(p.messageFlags).toBe(0xc0); // bits 0..5 gone, 6/7 untouched
      expect(p.messageBuildingSlots).toEqual([0, 0, 0]);
      expect(p.hintReturnDelay).toBe(0);
      // And the reserve sits parked - the one the end of the hint chain hands back. With bit 0 set it
      // would return at once, and the reserve would be lost for good.
      expect([p.heldPlanks, p.heldStone]).toEqual([7, 2]);
    });

  });
});
