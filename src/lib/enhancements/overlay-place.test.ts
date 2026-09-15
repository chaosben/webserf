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

describe('overlay opacity', () => {
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
