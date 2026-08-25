import { describe, it, expect } from 'vitest';
import {
  SERF_TORSO_BASE,
  SERF_ARMS_BASE,
  SERF_HEAD_BASE,
  SERF_SHADOW_BASE,
  INDEX1,
  INDEX2,
  serfBody,
  bodyToSprites,
  serfDrawInfo,
  isIdlePathState,
  idleSerfInfo,
  worksInsideBuilding,
  type SerfBodyContext,
  type AnimationLike,
} from './serf-sprites.js';
import type { SerfRecord } from './types.js';

/** Full body context with neutral defaults; individual fields are overridden per test. */
function ctx(over: Partial<SerfBodyContext>): SerfBodyContext {
  return {
    type: 0,
    state: 2, // Walking
    animSprite: 0x10,
    delivery: 0,
    negDist1: 0,
    negDist2: 0,
    leavingNextState: -1,
    leavingFieldB: 0,
    miningRes: 0,
    ...over,
  };
}

describe('serf-sprites Konstanten', () => {
  it('Asset-Basen 0-basiert (spaIndex − 1)', () => {
    expect(SERF_TORSO_BASE).toBe(2499);
    expect(SERF_ARMS_BASE).toBe(1849);
    expect(SERF_HEAD_BASE).toBe(3149);
    expect(SERF_SHADOW_BASE).toBe(3);
  });
  it('LUTs have an even length (pairs) and the reference corner values', () => {
    expect(INDEX1.length % 2).toBe(0);
    expect(INDEX2.length % 2).toBe(0);
    expect(INDEX1[0]).toBe(0);
    expect(INDEX1[1]).toBe(0);
    expect(INDEX1[INDEX1.length - 2]).toBe(192);
    expect(INDEX1[INDEX1.length - 1]).toBe(-1);
    expect(INDEX2[INDEX2.length - 2]).toBe(64);
  });
});

describe('serfBody', () => {
  it('transporter idling on a path -> do not draw (-1)', () => {
    expect(serfBody(ctx({ type: 0, state: 66 }))).toBe(-1);
  });

  it('transporter walking (carrying nothing) -> unchanged frame code', () => {
    expect(serfBody(ctx({ type: 0, state: 2, animSprite: 0x12 }))).toBe(0x12);
  });

  it('transporter carrying a resource -> + TRANSPORTER_TYPE[delivery]', () => {
    // delivery 1 -> 0x3000 (from the reference table).
    expect(serfBody(ctx({ type: 0, state: 3, delivery: 1, animSprite: 0x05 }))).toBe(0x3005);
  });

  it('TransporterInventory during castle construction -> do not draw (-1)', () => {
    expect(serfBody(ctx({ type: 4, state: 10 }))).toBe(-1);
  });

  it('Digger: t<0x80 → +0x300, t≥0x80 → +0x380', () => {
    expect(serfBody(ctx({ type: 2, animSprite: 0x10 }))).toBe(0x310);
    expect(serfBody(ctx({ type: 2, animSprite: 0x84 }))).toBe(0x84 + 0x380);
  });

  it('knights: k-dependent offset across the three t ranges', () => {
    expect(serfBody(ctx({ type: 22, animSprite: 0x10 }))).toBe(0x7810); // Knight0, t<0x80
    expect(serfBody(ctx({ type: 24, animSprite: 0x10 }))).toBe(0x10 + 0x7800 + 0x200); // Knight2
    expect(serfBody(ctx({ type: 22, animSprite: 0x90 }))).toBe(0x90 + 0x7cd0); // t<0xc0
    expect(serfBody(ctx({ type: 22, animSprite: 0xc5 }))).toBe(0xc5 + 0x7d90); // t≥0xc0
  });

  it('Dead → +0x8700', () => {
    expect(serfBody(ctx({ type: 27, animSprite: 3 }))).toBe(3 + 0x8700);
  });

  it('Lumberjack: freilaufend-tragend (+0x1000) vs. Standard (+0xb00)', () => {
    expect(serfBody(ctx({ type: 5, state: 16, negDist1: -128, negDist2: 1, animSprite: 0x10 }))).toBe(0x1010);
    expect(serfBody(ctx({ type: 5, state: 2, animSprite: 0x10 }))).toBe(0x10 + 0xb00);
  });
});

describe('bodyToSprites', () => {
  it('body 0 → Torso/Kopf 0', () => {
    expect(bodyToSprites(0)).toEqual({ torso: 0, head: 0 });
  });
  it('uses the hi/lo split via INDEX1/INDEX2', () => {
    // body 0x0105: hi=1→INDEX1[2]=48/INDEX1[3]=6; lo=5→INDEX2[10]=5/INDEX2[11]=0.
    expect(bodyToSprites(0x0105)).toEqual({ torso: 48 + 5, head: 6 + 0 });
  });
  it('returns null for a body code outside the LUT ranges', () => {
    expect(bodyToSprites(0xffff)).toBeNull();
  });
});

describe('serfDrawInfo', () => {
  const anim: AnimationLike = {
    animations: [
      [{ sprite: 0x12, x: 3, y: -5 }], // animation 0, phase 0
      [
        { sprite: 0x00, x: 0, y: 0 },
        { sprite: 0x07, x: 1, y: 2 },
      ], // animation 1
      [
        { sprite: 0x01, x: 0, y: 0 },
        { sprite: 0x02, x: 0, y: 0 },
        { sprite: 0x03, x: 0, y: 0 },
      ], // animation 2 (3 frames, for the direction test)
    ],
  };
  const serf = (over: Partial<SerfRecord>): SerfRecord =>
    ({
      type: 0,
      state: 2,
      animation: 0,
      counter: 0,
      // The five union bytes belong to the record: `serfDrawInfo` reads the carried resource raw
      // from byte 11 (= `stateData[0]`), without the decoded view.
      stateData: [0, 0, 0, 0, 0],
      ...over,
    }) as unknown as SerfRecord;

  it('walking transporter -> torso/head + frame offset', () => {
    const info = serfDrawInfo(serf({}), anim);
    expect(info).not.toBeNull();
    expect(info!.dx).toBe(3);
    expect(info!.dy).toBe(-5 - 2); // Frame-y −5, minus konstante DOS-Serf-Korrektur (−2).
    // body = 0x12 → hi 0, lo = 0x12*2 = 36 → torso INDEX2[36]=18, head INDEX2[37]=2.
    expect(info).toMatchObject({ torso: INDEX2[36], head: INDEX2[37] });
  });

  it('counter>>3 picks the frame; the range is clamped', () => {
    // animation 1, counter 8 → phase 1 → sprite 0x07.
    const info = serfDrawInfo(serf({ animation: 1, counter: 8 }), anim);
    expect(info!.dx).toBe(1);
    expect(info!.dy).toBe(2 - 2); // Frame-y 2, minus DOS-Serf-Korrektur (−2).
  });

  it('animPhaseOffset: body from the running phase, position anchored at the stored phase', () => {
    const s = serf({ animation: 1, counter: 0 }); // gespeicherte Phase 0
    const base = serfDrawInfo(s, anim, 0);
    const phase1 = serfDrawInfo(serf({ animation: 1, counter: 8 }), anim, 0); // Phase 1 komplett
    const anim1 = serfDrawInfo(s, anim, 1); // body phase 1, position phase 0
    // body as in phase 1 ...
    expect(anim1!.torso).toBe(phase1!.torso);
    expect(anim1!.head).toBe(phase1!.head);
    // ... but the position anchored at phase 0 (no sliding); dy includes the -2 correction.
    expect(anim1!.dx).toBe(0);
    expect(anim1!.dy).toBe(0 - 2);
    // Wrap-around: offset == animation length => identical to offset 0.
    expect(serfDrawInfo(s, anim, 2)).toEqual(base);
  });

  it('animPhaseOffset runs DOWNWARDS (like the counting-down counter in the original)', () => {
    // animation 2: 3 Frames (sprites 0x01,0x02,0x03). counter 0 → gespeicherte Phase 0.
    const s = serf({ animation: 2, counter: 0 });
    // Offset 1 must give the PREVIOUS phase (0-1 -> 2), not the next one.
    const p2 = serfDrawInfo(serf({ animation: 2, counter: 16 }), anim, 0); // Phase 2 (sprite 0x03)
    const off1 = serfDrawInfo(s, anim, 1);
    expect(off1!.torso).toBe(p2!.torso);
    expect(off1!.head).toBe(p2!.head);
  });

  it('the constant -2 DOS vertical correction applies to all active serfs', () => {
    // State independent: ground serf and in-building worker get the same -2 (dx untouched).
    const ground = serfDrawInfo(serf({ animation: 1, counter: 8 }), anim); // Frame y=2
    const inside = serfDrawInfo(serf({ state: 30, animation: 1, counter: 8 }), anim);
    expect(ground!.dy).toBe(0); // 2 − 2
    expect(inside!.dy).toBe(0); // 2 - 2 (not state dependent)
    expect(ground!.dx).toBe(1);
  });

  it('ruhender Weg-Serf (IdleOnPath) → null', () => {
    expect(serfDrawInfo(serf({ state: 66 }), anim)).toBeNull();
  });

  it('unknown animation -> null', () => {
    expect(serfDrawInfo(serf({ animation: 99 }), anim)).toBeNull();
  });

  // The carried resource comes RAW from union byte 11 — not from the decoded view. The type branch
  // is the gate: inventory carriers (type 4) carry in EVERY state except 10 (@0x25f5a),
  // carrier/generic only in 3/14 (@0x25f6e/@0x25f77).
  describe('carried resource from union byte 11', () => {
    // State 11 `MoveResourceOut` — the carrier moves the resource out of the castle. Its union is
    // called `moveResourceOut`, NOT `transporting`; a category gate would let him run empty.
    const carrying = serf({ type: 4, state: 11, stateData: [4, 0, 0, 0, 0] });
    const empty = serf({ type: 4, state: 11, stateData: [0, 0, 0, 0, 0] });

    it('inventory carrier in MoveResourceOut shows his load', () => {
      // Animation sprite 0x12, resource 4 => body code 0x12 + 0x4100 (table entry @0x25b72).
      expect(serfDrawInfo(carrying, anim)).toMatchObject(bodyToSprites(0x4112)!);
      expect(serfDrawInfo(carrying, anim)).not.toEqual(serfDrawInfo(empty, anim));
    });

    it('... and with an empty byte 11 the unloaded pose', () => {
      expect(serfDrawInfo(empty, anim)).toEqual(serfDrawInfo(serf({ type: 4, state: 2 }), anim));
    });

    it('a carrier outside a carrying state stays unloaded (gate on state 3/14)', () => {
      const walking = serf({ type: 0, state: 2, stateData: [4, 0, 0, 0, 0] });
      expect(serfDrawInfo(walking, anim)).toEqual(serfDrawInfo(serf({ type: 0, state: 2 }), anim));
      // ... but inside a carrying state he does.
      const transporting = serf({ type: 0, state: 3, stateData: [4, 0, 0, 0, 0] });
      expect(serfDrawInfo(transporting, anim)).not.toEqual(serfDrawInfo(serf({ type: 0, state: 3 }), anim));
    });

    it('0xff (WaitForResourceOut) counts as "nothing" — the original reads 0x25b68 == 0 there', () => {
      const waiting = serf({ type: 4, state: 12, stateData: [0xff, 0, 0, 0, 0] });
      expect(serfDrawInfo(waiting, anim)).toEqual(serfDrawInfo(serf({ type: 4, state: 12 }), anim));
    });
  });

  /**
   * Two sites in the original read the union bytes **without any state test** — the fisher
   * `cmpb $0x1,0xe(%ebx)` @0x265bc and the farmer `mov 0xd(%ebx),%al ; or ; jne` @0x266e8, both in
   * the band `t >= 0x80`. Through a decoded view both bytes would be 0 outside the `freeWalking`
   * states, i.e. a condition the original does not have. This test uses a state that has NO
   * `freeWalking` union.
   */
  describe('ungated union bytes in the band t >= 0x80', () => {
    const hi: AnimationLike = { animations: [[{ sprite: 0x80, x: 0, y: 0 }]] };
    const SAWING = 24; // has the `workingMode` union, so no negDist1/negDist2

    it('fisher: byte 14 == 1 picks the other band, outside freeWalking too', () => {
      const on = serf({ type: 11, state: SAWING, stateData: [0, 0, 0, 1, 0] });
      const off = serf({ type: 11, state: SAWING, stateData: [0, 0, 0, 0, 0] });
      expect(serfDrawInfo(on, hi)).toMatchObject(bodyToSprites(0x80 + 0x2d80)!);
      expect(serfDrawInfo(off, hi)).toMatchObject(bodyToSprites(0x80 + 0x2c80)!);
    });

    it('farmer: byte 13 != 0 picks the other band, outside freeWalking too', () => {
      const zero = serf({ type: 14, state: SAWING, stateData: [0, 0, 0, 0, 0] });
      const set = serf({ type: 14, state: SAWING, stateData: [0, 0, 3, 0, 0] });
      expect(serfDrawInfo(zero, hi)).toMatchObject(bodyToSprites(0x80 + 0x3d80)!);
      expect(serfDrawInfo(set, hi)).toMatchObject(bodyToSprites(0x80 + 0x3e80)!);
    });
  });

});

describe('idle carriers', () => {
  it('isIdlePathState erkennt State 66..69', () => {
    expect(isIdlePathState(65)).toBe(false);
    expect(isIdlePathState(66)).toBe(true);
    expect(isIdlePathState(69)).toBe(true);
    expect(isIdlePathState(70)).toBe(false);
  });

  it('sailor idle -> fixed body 0x203, no offset', () => {
    expect(idleSerfInfo(1, 5, 3, 12345)).toEqual({ body: 0x203, dx: 0, dy: 0 });
  });

  it('transporter idle -> body from arr_2, offset from arr_3[paths]', () => {
    const info = idleSerfInfo(0, 0, 3, 0);
    // paths 3 → arr_3[6]=-2, arr_3[7]=1.
    expect(info.dx).toBe(-2);
    expect(info.dy).toBe(1);
    // The body is a valid arr_2 entry (0x88xx or small) -> resolvable through bodyToSprites.
    expect(bodyToSprites(info.body)).not.toBeNull();
  });

  it('transporter idle body varies with the tick', () => {
    const a = idleSerfInfo(0, 0, 0, 0).body;
    const b = idleSerfInfo(0, 0, 0, 8 << 3).body; // deutlich anderer Tick
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });
});

describe('worksInsideBuilding', () => {
  it('detects indoor working states (no ground shadow)', () => {
    // Smelting(30)/Baking(35)/Milling(34)/Sawing(24)/MakingWeapon(38) etc. -> inside the building.
    expect(worksInsideBuilding(30)).toBe(true);
    expect(worksInsideBuilding(35)).toBe(true);
    expect(worksInsideBuilding(34)).toBe(true);
    expect(worksInsideBuilding(24)).toBe(true);
    expect(worksInsideBuilding(38)).toBe(true);
    expect(worksInsideBuilding(40)).toBe(true);
  });

  it('keeps the shadow for ground states', () => {
    // Walking(2)/Transporting(3)/EnteringBuilding(4)/Building(9)/IdleOnPath(66) -> on the ground.
    expect(worksInsideBuilding(2)).toBe(false);
    expect(worksInsideBuilding(3)).toBe(false);
    expect(worksInsideBuilding(4)).toBe(false);
    expect(worksInsideBuilding(9)).toBe(false);
    expect(worksInsideBuilding(66)).toBe(false);
  });
});
