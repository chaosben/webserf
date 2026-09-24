import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORNER_LABEL,
  OVERLAY_CORNERS,
  OVERLAY_OPACITY_DEFAULT,
  OVERLAY_OPACITY_MAX,
  OVERLAY_OPACITY_MIN,
} from './overlay-place.js';
import { SHELL_TABLES } from '../shell/i18n.js';

const HERE = new URL('.', import.meta.url).pathname;

describe('overlay corners', () => {
  it('are four distinct spots', () => {
    expect(new Set(OVERLAY_CORNERS).size).toBe(OVERLAY_CORNERS.length);
    expect(OVERLAY_CORNERS.length).toBe(4);
  });

  it('every one has a name both languages know', () => {
    for (const corner of OVERLAY_CORNERS) {
      for (const lang of ['en', 'de'] as const) {
        expect(Object.keys(SHELL_TABLES[lang]), `${corner}/${lang}`).toContain(CORNER_LABEL[corner]);
      }
    }
  });

  /**
   * The placing lives in CSS and no test can run it, so this checks the one thing that WOULD rot
   * silently: a corner added to the list without a rule in the stack would land wherever the
   * container's origin happens to be — top left, on top of whatever is already there.
   */
  it('every one has a rule in the corner stack', () => {
    const css = readFileSync(join(HERE, 'GameOverlays.svelte'), 'utf8');
    for (const corner of OVERLAY_CORNERS) expect(css, corner).toContain(`.${corner} {`);
    // The bottom corners must stack UPWARDS, otherwise the second plate leaves the screen edge.
    expect(css.split('.bl {')[1]!.split('}')[0]).toContain('column-reverse');
    expect(css.split('.br {')[1]!.split('}')[0]).toContain('column-reverse');
  });
});

/**
 * A plate that takes the pointer sits INSIDE the viewport, so a click on it travels up through the
 * game surface. Whether that ends as a map click is decided in `MapView.svelte`, and only by where
 * the click listener hangs — a plate cannot fix it from its own side: Svelte delegates `onclick` to
 * the document root, so a `stopPropagation()` in the plate runs after the native bubble has long
 * passed the viewport. On the canvas the plates are out of reach; on the viewport they are not.
 *
 * A source scan and nothing more, and the reason is stated rather than hidden: these tests run on
 * `node`, there is no DOM and no Svelte runtime here. It catches the move back, not a new way to
 * break it.
 */
describe('the map click and our plates', () => {
  const src = readFileSync(join(HERE, '../views/MapView.svelte'), 'utf8');

  it('hangs the map click on the canvas, not on the viewport', () => {
    const attach = src.match(/const el = (\w+);\n\s*if \(el [^\n]*\n\s*el\.addEventListener\('click'/);
    expect(attach, "no imperative 'click' listener found — has it moved?").not.toBeNull();
    expect(attach![1]).toBe('host');
  });

  it('draws the plates inside the viewport, which is why the line above matters', () => {
    // Would they sit outside it, the question could not arise — and this test would be misleading.
    // `section.map` holds the viewport and nothing else, so "after its opening tag" IS "inside it".
    const body = src.slice(src.indexOf('<section class="map">'), src.indexOf('</section>'));
    expect(body).toContain('<GameOverlays');
    expect(body.indexOf('<GameOverlays')).toBeGreaterThan(body.indexOf('class="viewport"'));
  });
});

/**
 * THE SIZE OF A PLATE IS THE CONTROL BAR'S AND NOTHING ELSE — the sentence at the top of
 * `overlay-place.ts`, checked where it can rot.
 *
 * The chain: `:root` carries `--game-px`, the game's fixed pixel base; `.game-overlay` turns it with
 * the bar's factor into a font size; every measurement inside a plate is `em` and therefore that same
 * factor. `rem` is a different quantity — the size of the SHELL, which the settings move — and a
 * single `rem` inside a plate would pull it along with a setting that has nothing to do with the game
 * surface, away from the 16-pixel sprites beside it. An own `font-size` would break the chain in the
 * other direction, by giving the `em` below it a different base.
 */
describe('the size of our plates over the game surface', () => {
  const layout = readFileSync(join(HERE, '../../routes/+layout.svelte'), 'utf8');
  const plates = ['StockOverlay.svelte', 'HacksOverlay.svelte', 'RoadAssistantOverlay.svelte'];

  it('measures the game in its own pixel base, not in the shell size', () => {
    expect(layout).toContain('--game-px:');
    const rule = layout.split(':global(.game-overlay)')[1]!.split('}')[0];
    expect(rule).toContain('var(--game-px)');
    expect(rule).toContain('var(--overlay-scale');
    expect(rule, 'the plate would follow the shell size').not.toContain('rem');
  });

  it('leaves the shell size to the shell', () => {
    expect(layout).toContain('var(--ui-scale');
    // The two are separate quantities; sharing one would be the whole mistake.
    expect(layout.split('--game-px:')[1]!.split(';')[0]).not.toContain('--ui-');
  });

  for (const name of plates) {
    it(`${name} measures in em and sets no font size of its own`, () => {
      const css = readFileSync(join(HERE, name), 'utf8');
      const style = css.slice(css.indexOf('<style>'));
      const code = style
        .replace(/\/\*[\s\S]*?\*\//g, '') // comments may name either unit while explaining
        .replace(/<!--[\s\S]*?-->/g, '');
      expect(code, 'a rem here follows the shell, not the control bar').not.toMatch(/\d\s*rem/);
      expect(code, 'an own font size breaks the base the em values rest on').not.toContain(
        'font-size',
      );
      expect(code, 'nothing is measured against the bar any more').toMatch(/\dem/);
    });
  }
});

describe('overlay opacity', () => {
  /**
   * The setting fades the plate AND its content. Mixing it into the backing colour alone left the
   * pictures and numbers fully opaque, so the map stayed covered where it matters.
   */
  it('fades the whole plate in the shared rule, not the backing of each plate', () => {
    const layout = readFileSync(join(HERE, '../../routes/+layout.svelte'), 'utf8');
    const rule = layout.split(':global(.game-overlay)')[1]!.split('}')[0];
    expect(rule).toContain('opacity: var(--plate-opacity');
    for (const name of ['StockOverlay.svelte', 'HacksOverlay.svelte', 'RoadAssistantOverlay.svelte']) {
      const css = readFileSync(join(HERE, name), 'utf8');
      const style = css.slice(css.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(style, name).not.toContain('--plate-opacity');
      expect(css, `${name} must still hand the value to the rule`).toContain('style:--plate-opacity');
    }
  });

  it('never reaches zero', () => {
    // An invisible plate that still swallows clicks looks like a broken game, not like a setting.
    expect(OVERLAY_OPACITY_MIN).toBeGreaterThan(0);
    expect(OVERLAY_OPACITY_MAX).toBe(1);
  });

  it('defaults inside its own range', () => {
    expect(OVERLAY_OPACITY_DEFAULT).toBeGreaterThanOrEqual(OVERLAY_OPACITY_MIN);
    expect(OVERLAY_OPACITY_DEFAULT).toBeLessThanOrEqual(OVERLAY_OPACITY_MAX);
  });
});
