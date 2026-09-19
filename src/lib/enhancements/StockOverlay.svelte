<script lang="ts">
  /**
   * The stock overview over the game surface.
   *
   * OUR OWN ADDITION — the original has no permanent readout of this kind. It is a DOM layer and
   * not part of the canvas, which is the one thing to know about it: a screen recording and a
   * screenshot see the canvas alone, so this does not appear in either.
   *
   * The component knows nothing — no engine, no settings, no archive beyond the picture cache. It
   * gets ready-made rows and draws them; everything that decides WHAT is listed lives in
   * `stock-overview.ts`, where it can be tested.
   */
  import { iconImage } from './icon-images.svelte.js';
  import { goodName, serfName } from './entity-names.js';
  import { supplyName, supplyToName } from './supply-pointers.js';
  import { st } from '../shell/i18n.js';
  import {
    STOCK_CELL_SPAN,
    gridColumnCount,
    supplyColumnSpan,
    type StockRow,
    type StockView,
    type SupplyGroup
  } from './stock-overview.js';

  let {
    view,
    opacity,
    perRow,
    scale
  }: {
    /** `null` = nothing selected, or no player to show. */
    view: StockView | null;
    opacity: number;
    /**
     * How many entries stand side by side before the list wraps — goods and professions, that is.
     * The grid is counted in half places, so a supply pointer takes one and a half of them.
     */
    perRow: number;
    /**
     * The control bar's own scale (`uiScaleFor`), passed straight through: the readout is sized
     * like the bar below and by nothing else — stepless, and not a setting. What it turns into is
     * the shared `.game-overlay` rule, so this plate and the hack switches cannot drift apart.
     */
    scale: number;
  } = $props();

  /**
   * The name is NOT displayed: the original's screens show these things as pictures alone, and so
   * does this. It serves `alt`/`title`, and it is what stands there when no archive is loaded.
   */
  const nameOf = (row: StockRow): string =>
    row.kind === 'good' ? goodName(row.type) : serfName(row.type);

  const groups = $derived.by((): { key: string; rows: readonly StockRow[] }[] => {
    if (view === null) return [];
    const out: { key: string; rows: readonly StockRow[] }[] = [];
    if (view.goods.length > 0) out.push({ key: 'goods', rows: view.goods });
    if (view.serfs.length > 0) out.push({ key: 'serfs', rows: view.serfs });
    return out;
  });

  /**
   * The supply pointers get a loop of their own rather than a place in `groups`: their cell holds a
   * receiver and a list of pairs instead of a picture and a number, and squeezing both shapes
   * through one loop would buy the shared markup with a union to narrow on every line. They share
   * the GRID with the others all the same — two loops under one parent cost nothing, and that
   * shared grid is what keeps the rows one width.
   *
   * THE RECEIVER IS A HEADING, NOT THE END OF A SENTENCE. It stands once, to the left of its pairs,
   * because five receivers take two goods and two copies of their picture say nothing about the two
   * belonging together. The sentence of the original's arrow — what is delivered, to whom — belongs
   * to one pointer, so it sits on the PAIR, as {@link supplyName} spells it out, good first. Move it
   * onto the group and the tooltip starts claiming the heading is its subject.
   */
  const supply = $derived<readonly SupplyGroup[]>(view?.supply ?? []);

  /**
   * The picture comes at step 1 and gets its size here, rounded to WHOLE pixels.
   *
   * That is what makes the readout stepless: `spriteCanvas` can only blit whole factors, so a
   * fractional one has to be the browser's job — `image-rendering: pixelated` on an `<img>` of an
   * explicit pixel size is nearest-neighbour, the same treatment the control bar gets when it is
   * blitted at a fractional `uiScale`. Rounding the destination is the same rule as `originBoxRect`.
   */
  const sized = (icon: number): { url: string; w: number; h: number } | null => {
    const img = iconImage(icon);
    if (img === null) return null;
    return {
      url: img.url,
      w: Math.max(1, Math.round(img.width * scale)),
      h: Math.max(1, Math.round(img.height * scale))
    };
  };
</script>

{#if groups.length > 0 || supply.length > 0}
  <!-- No `aria-live`: a region that changes several times a second is a barrage for a screen
       reader. Findable in the tree, but not announced. -->
  <section
    class="overview game-overlay"
    style:--plate-opacity={opacity}
    style:--cols={gridColumnCount(perRow)}
    style:--cell-span={STOCK_CELL_SPAN}
    style:--supply-span={supplyColumnSpan(perRow)}
    style:--overlay-scale={scale}
    aria-label={st('enh.stock.aria')}
  >
    <ul>
      {#each groups as group, i (group.key)}
        {#if i > 0}
          <li class="rule" aria-hidden="true"></li>
        {/if}
        {#each group.rows as row (row.icon)}
          {@const pic = sized(row.icon)}
          {@const name = nameOf(row)}
          <li>
            {#if pic === null}
              <span class="name">{name}</span>
            {:else}
              <img src={pic.url} alt={name} title={name} width={pic.w} height={pic.h} />
            {/if}
            <span class="value">{row.value}</span>
          </li>
        {/each}
      {/each}

      {#if supply.length > 0}
        {#if groups.length > 0}
          <li class="rule" aria-hidden="true"></li>
        {/if}
        {#each supply as target (target.first)}
          {@const to = sized(target.toIcon)}
          {@const toName = supplyToName(target.first)}
          <li class="supply">
            {#if to === null}
              <span class="name">{toName}</span>
            {:else}
              <img src={to.url} alt={toName} title={toName} width={to.w} height={to.h} />
            {/if}
            <ul class="pairs">
              {#each target.entries as entry (entry.index)}
                {@const good = sized(entry.goodIcon)}
                {@const needle = sized(entry.pointerIcon)}
                {@const name = supplyName(entry.index)}
                <li title={name}>
                  {#if good === null || needle === null}
                    <span class="name">{name}</span>
                  {:else}
                    <img src={good.url} alt={name} width={good.w} height={good.h} />
                    <img src={needle.url} alt="" width={needle.w} height={needle.h} />
                  {/if}
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      {/if}
    </ul>
  </section>
{/if}

<style>
  /*
   * `pointer-events: none` is not cosmetic: the viewport underneath carries panning, zoom and every
   * click. Without it the overlay would eat clicks in its corner and one could not build there.
   *
   * WHERE it sits is not decided here — `GameOverlays` stacks the plates of one corner.
   *
   * Padding and gaps are in `em`, so they are the same factor as the pictures and the plate grows as
   * ONE piece rather than as icons drifting apart inside a frame that stays put. `em` and not `rem`:
   * the font size here is already the control bar's scale times the game's pixel base
   * (`.game-overlay`), while `rem` is the SHELL's size and would pull the plate along with the
   * settings that have nothing to do with the game surface.
   */
  .overview {
    max-width: 100%;
    padding: 0.35em 0.45em;
    background: color-mix(in srgb, var(--bg-sunken) calc(var(--plate-opacity) * 100%), transparent);
    border: 1px solid color-mix(in srgb, var(--line) calc(var(--plate-opacity) * 100%), transparent);
    pointer-events: none;
    user-select: none;
    overflow: hidden;
  }

  /*
   * ONE grid for all three groups, counted in HALF places: a good or a profession takes two, a
   * pointer group three whether it holds one pair or two. Three separate grids would each be as
   * wide as its own cells, and since the plate takes the widest of them, a row of goods then ends
   * in a third of a row of blank — the pointer cell is one and a half goods wide.
   *
   * `max-content` and not `1fr`: a column becomes as wide as the widest thing spanning it, so the
   * plate stays as narrow as the chosen row width allows, and the two shapes settle against each
   * other without anyone measuring a pixel.
   */
  .overview > ul {
    display: grid;
    grid-template-columns: repeat(var(--cols), max-content);
    gap: 0.15em 0.6em;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.2em;
  }

  .overview > ul > li {
    grid-column: span var(--cell-span);
  }

  /*
   * A pointer group is as wide as three pictures whether it holds one pair or two — the second pair
   * goes under the first rather than beside it. `align-items: center` on the cell is what makes the
   * receiver a heading: with two pairs its picture sits between their lines, and that is the whole
   * bracket, drawn with no line at all.
   */
  .overview > ul > li.supply {
    grid-column: span var(--supply-span);
  }

  /*
   * The pairs of one receiver, stacked. A column and not a grid of its own: every icon is 16 wide,
   * so good and needle line up across the lines of a group without a column being declared — and a
   * grid would have to make each pair `display: contents` to reach its two pictures, which takes
   * the tooltip away with the box it hangs on.
   */
  .pairs {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: 0.15em;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* The line between two groups is a row of its own now that they share the grid. */
  .overview > ul > li.rule {
    grid-column: 1 / -1;
    margin: 0.25em 0;
    border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  }

  /*
   * The size comes from the `width`/`height` attributes, which are whole pixels. `pixelated` is what
   * keeps a fractional factor sharp: the icons are pixel art, and a browser left to interpolate
   * would turn them into mush.
   */
  img {
    display: block;
    image-rendering: pixelated;
  }

  .name {
    color: var(--fg-dim);
  }

  /*
   * The number carries the information, so it grows with the picture — a triple-size icon beside
   * thirteen-pixel text would be the wrong half enlarged; that growth comes from `.game-overlay`
   * on the plate. `min-width` keeps the column from jumping on every step from 9 to 10.
   */
  .value {
    min-width: 2ch;
    color: var(--fg);
    font-variant-numeric: tabular-nums;
  }
</style>
