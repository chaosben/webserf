import { describe, expect, it } from 'vitest';
import { createFramebuffer, type SpriteProvider } from '../core/ui-render.js';
import { drawObjectPopupBody, garrisonKnightTypes } from './popup-draw.js';
import type { GameState, Serf } from '../core/engine/state.js';

/**
 * The one point where splitting this out of `MapView.svelte` is more than moving code: the original
 * renderers that CLOSE THEIR OWN WINDOW when the subject is unusable now report that as the return
 * value `'close'` instead of calling `closePopups()`. These tests pin exactly those cases — they are
 * the condition under which the caller still behaves as before.
 *
 * Without an archive there are no sprites; the provider returns `null`. That is enough, because
 * every branch checked here bails out BEFORE drawing.
 */
const noSprites: SpriteProvider = () => null;
const fb = (): ReturnType<typeof createFramebuffer> => createFramebuffer(144, 160);

/** Minimal state: only the fields the checked branches touch. */
function stateWith(over: Partial<GameState>): GameState {
  return {
    buildings: [],
    flags: [],
    serfs: [],
    inventories: [],
    players: [],
    ...over,
  } as unknown as GameState;
}

const view = (state: GameState) => ({
  state,
  player: 0,
  textColor: [255, 255, 255] as const,
  attachRoad: false,
});

describe('drawObjectPopupBody — closing instead of drawing', () => {
  it('closes the flag window once the flag is gone', () => {
    const state = stateWith({});
    expect(drawObjectPopupBody(fb(), noSprites, 0x2a, 7, view(state))).toBe('close');
  });

  it('closes every building window while the building burns', () => {
    const burning = { index: 3, type: 11, burning: true } as unknown as GameState['buildings'][0];
    const state = stateWith({ buildings: [undefined, undefined, undefined, burning] as never });
    for (const screen of [0x28, 0x27, 0x29, 0x26, 0x2b, 0x2c, 0x34]) {
      expect(drawObjectPopupBody(fb(), noSprites, screen, 3, view(state)), `Screen 0x${screen.toString(16)}`).toBe(
        'close',
      );
    }
  });

  it('closes the stock-mode window for a type without an inventory', () => {
    // 0x2c only draws the castle (24) and the warehouse (10); every other type closes.
    const hut = { index: 3, type: 11, burning: false, inventoryIndex: null } as unknown as GameState['buildings'][0];
    const state = stateWith({ buildings: [undefined, undefined, undefined, hut] as never });
    expect(drawObjectPopupBody(fb(), noSprites, 0x2c, 3, view(state))).toBe('close');
  });

  it('closes the attack window without a building under attack', () => {
    const state = stateWith({ players: [{ buildingAttacked: 0 }] as never });
    expect(drawObjectPopupBody(fb(), noSprites, 0x14, 0, view(state))).toBe('close');
  });
});

describe('garrisonKnightTypes', () => {
  /**
   * The successor lives in the UNION BYTES `serf[0xe]` (= `stateData[3..4]`) — that is where the
   * original reads it unconditionally (@0x3b1aa), and that is the only place the engine writes. The
   * decoded view here deliberately carries a DIFFERENT chain: if the renderer goes back to reading
   * that, these tests fail.
   */
  const knight = (index: number, type: number, next: number): Serf =>
    ({
      index,
      type,
      stateData: [0, 0, 0, next & 0xff, (next >> 8) & 0xff],
    }) as unknown as Serf;

  it('follows the knight chain `bld+10` → `serf+0xe` down to 0', () => {
    const state = stateWith({
      serfs: [undefined, knight(1, 25, 2), knight(2, 23, 3), knight(3, 22, 0)] as never,
    });
    expect(garrisonKnightTypes(state, 1)).toEqual([25, 23, 22]);
  });

  it('aborts on a cycle instead of hanging', () => {
    // A cycle must not occur in a save game — if it does anyway, an endless loop in the renderer
    // is the worst possible outcome.
    const state = stateWith({ serfs: [undefined, knight(1, 25, 2), knight(2, 23, 1)] as never });
    expect(garrisonKnightTypes(state, 1)).toEqual([25, 23]);
  });

  it('returns nothing for an empty garrison', () => {
    expect(garrisonKnightTypes(stateWith({}), 0)).toEqual([]);
  });
});
