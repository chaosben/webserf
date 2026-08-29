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
  import { st } from '../shell/i18n.js';
  import type { StockCorner, StockRow, StockView } from './stock-overview.js';

  let {
    view,
    corner,
    opacity,
    perRow,
    scale
  }: {
    /** `null` = nothing selected, or no player to show. */
    view: StockView | null;
    corner: StockCorner;
    opacity: number;
    /** How many entries stand side by side before the list wraps. */
    perRow: number;
    /**
     * The control bar's own scale (`uiScaleFor`), passed straight through: the readout is sized
     * like the bar below and by nothing else — stepless, and not a setting.
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

{#if groups.length > 0}
  <!-- No `aria-live`: a region that changes several times a second is a barrage for a screen
       reader. Findable in the tree, but not announced. -->
  <section
    class="overview {corner}"
    style:--plate-opacity={opacity}
    style:--per-row={perRow}
    style:--stock-scale={scale}
    aria-label={st('enh.stock.aria')}
  >
    {#each groups as group (group.key)}
      <ul>
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
      </ul>
    {/each}
  </section>
{/if}

<style>
  /*
   * `pointer-events: none` is not cosmetic: the viewport underneath carries panning, zoom and every
   * click. Without it the overlay would eat clicks in its corner and one could not build there.
   *
   * Padding and gaps are in the same factor as the pictures, so the plate grows as ONE piece rather
   * than as icons drifting apart inside a frame that stays put.
   */
  .overview {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: calc(0.4rem * var(--stock-scale));
    /* Wide enough for a full strip at twelve entries; beyond that the plate would be cut off. */
    max-width: 92%;
    max-height: 80%;
    padding: calc(0.35rem * var(--stock-scale)) calc(0.45rem * var(--stock-scale));
    background: color-mix(in srgb, var(--bg-sunken) calc(var(--plate-opacity) * 100%), transparent);
    border: 1px solid color-mix(in srgb, var(--line) calc(var(--plate-opacity) * 100%), transparent);
    pointer-events: none;
    user-select: none;
    overflow: hidden;
  }

  .tl {
    top: 0.5rem;
    left: 0.5rem;
  }
  .tr {
    top: 0.5rem;
    right: 0.5rem;
  }
  .bl {
    bottom: 0.5rem;
    left: 0.5rem;
  }
  .br {
    bottom: 0.5rem;
    right: 0.5rem;
  }

  /*
   * `max-content` and not `1fr`: the columns become as wide as their content, so the plate stays as
   * narrow as the chosen row width allows.
   */
  ul {
    display: grid;
    grid-template-columns: repeat(var(--per-row), max-content);
    gap: calc(0.15rem * var(--stock-scale)) calc(0.6rem * var(--stock-scale));
    margin: 0;
    padding: 0;
    list-style: none;
  }

  ul + ul {
    padding-top: calc(0.35rem * var(--stock-scale));
    border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  }

  li {
    display: flex;
    align-items: center;
    gap: calc(0.2rem * var(--stock-scale));
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
   * thirteen-pixel text would be the wrong half enlarged. `min-width` keeps the column from jumping
   * on every step from 9 to 10.
   */
  .value {
    min-width: 2ch;
    color: var(--fg);
    font-size: calc(1rem * var(--stock-scale));
    font-variant-numeric: tabular-nums;
  }
</style>
