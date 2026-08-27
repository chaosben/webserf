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
  import { iconUrl } from './icon-images.svelte.js';
  import { goodName, serfName } from './entity-names.js';
  import { st } from '../shell/i18n.js';
  import type { StockCorner, StockRow, StockView } from './stock-overview.js';
  import { trendKey, type StockTrend } from './stock-trend.js';

  let {
    view,
    trends,
    corner,
    opacity,
    perRow,
    scale
  }: {
    /** `null` = nothing selected, or no player to show. */
    view: StockView | null;
    /** `null` = trend switched off; then the arrow column is not built at all. */
    trends: ReadonlyMap<number, StockTrend> | null;
    corner: StockCorner;
    opacity: number;
    /** How many entries stand side by side before the list wraps. */
    perRow: number;
    /** Whole multiple of the original's pixels — see `stockScaleFactor`. */
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
</script>

{#if groups.length > 0}
  <!-- No `aria-live`: a region that changes several times a second is a barrage for a screen
       reader. Findable in the tree, but not announced. -->
  <section
    class="overview {corner}"
    style:--plate-opacity={opacity}
    style:--per-row={perRow}
    style:--stock-scale={scale}
    aria-label={st('enh.overlay.aria')}
  >
    {#each groups as group (group.key)}
      <ul>
        {#each group.rows as row (row.icon)}
          {@const url = iconUrl(row.icon, scale)}
          {@const name = nameOf(row)}
          {@const trend = trends?.get(trendKey(row.kind, row.type)) ?? 0}
          <li>
            {#if url === null}
              <span class="name">{name}</span>
            {:else}
              <img src={url} alt={name} title={name} />
            {/if}
            {#if trends !== null}
              <!-- `aria-hidden`: the readout is deliberately not announced (see above), and a lone
                   arrow glyph in the reading flow would be noise either way. -->
              <span class="trend" class:up={trend === 1} class:down={trend === -1} aria-hidden="true"
                >{trend === 1 ? '▲' : trend === -1 ? '▼' : ''}</span
              >
            {/if}
            <span class="value" class:up={trend === 1} class:down={trend === -1}>{row.value}</span>
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
   */
  .overview {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    /* Wide enough for a full strip at twelve entries; beyond that the plate would be cut off. */
    max-width: 92%;
    max-height: 80%;
    padding: 0.35rem 0.45rem;
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
    gap: 0.15rem 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  ul + ul {
    padding-top: 0.35rem;
    border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }

  /*
   * No width: the picture is rendered at its step and stands on whole pixels already. The icons are
   * pixel art; a browser asked to scale them would interpolate them into mush.
   */
  img {
    display: block;
    object-fit: contain;
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

  /*
   * The width stays even when the glyph is empty. The grid measures `max-content`, so a vanishing
   * arrow would pull the whole plate narrower and back again on every change.
   *
   * Shape carries, colour reinforces: red/green is the most common colour blindness, and at low
   * plate opacity the map shows through — a green number over grass and a red one over desert both
   * lose contrast.
   */
  .trend {
    width: 1ch;
    color: var(--fg-dim);
    font-size: calc(0.75rem * var(--stock-scale));
    line-height: 1;
  }

  .up {
    color: var(--trend-up);
  }

  .down {
    color: var(--trend-down);
  }
</style>
