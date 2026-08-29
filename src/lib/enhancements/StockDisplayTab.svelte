<script lang="ts">
  /** Where the stock overview sits, how wide it runs and how far it shows through. */
  import {
    STOCK_CORNERS,
    STOCK_OPACITY_MAX,
    STOCK_OPACITY_MIN,
    STOCK_PER_ROW_MAX,
    STOCK_PER_ROW_MIN,
    type StockCorner
  } from './stock-overview.js';
  import { settings } from '../settings/settings.svelte.js';
  import { st } from '../shell/i18n.js';

  const CORNER_LABEL = {
    tl: 'enh.corner.tl',
    tr: 'enh.corner.tr',
    bl: 'enh.corner.bl',
    br: 'enh.corner.br'
  } as const satisfies Record<StockCorner, Parameters<typeof st>[0]>;

  const percent = $derived(Math.round(settings.value.stockOpacity * 100));
</script>

<section>
  <h3>{st('enh.stock.view.title')}</h3>
  <p class="note">{st('enh.stock.intro')}</p>
  <p class="note">{st('enh.stock.view.emptyNote')}</p>
</section>

<section>
  <h3>{st('enh.stock.view.corner')}</h3>
  <div class="row">
    {#each STOCK_CORNERS as corner (corner)}
      <button
        type="button"
        class:on={settings.value.stockCorner === corner}
        aria-pressed={settings.value.stockCorner === corner}
        onclick={() => settings.set('stockCorner', corner)}
      >
        {st(CORNER_LABEL[corner])}
      </button>
    {/each}
  </div>
</section>

<section>
  <h3>{st('enh.stock.view.perRow')}</h3>
  <div class="row">
    <input
      type="range"
      min={STOCK_PER_ROW_MIN}
      max={STOCK_PER_ROW_MAX}
      step="1"
      value={settings.value.stockPerRow}
      aria-label={st('enh.stock.view.perRow')}
      oninput={(e) => settings.set('stockPerRow', Number(e.currentTarget.value))}
    />
    <span class="note">{settings.value.stockPerRow}</span>
  </div>
  <p class="note">{st('enh.stock.view.perRowNote')}</p>
</section>

<section>
  <h3>{st('enh.stock.view.opacity')}</h3>
  <div class="row">
    <input
      type="range"
      min={STOCK_OPACITY_MIN}
      max={STOCK_OPACITY_MAX}
      step="0.05"
      value={settings.value.stockOpacity}
      aria-label={st('enh.stock.view.opacity')}
      oninput={(e) => settings.set('stockOpacity', Number(e.currentTarget.value))}
    />
    <span class="note">{percent} %</span>
  </div>
</section>

<style>
  section {
    display: grid;
    gap: 0.5rem;
  }

  section + section {
    padding-top: 0.9rem;
    border-top: 1px solid var(--line);
  }

  h3 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  button.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .note {
    margin: 0;
    color: var(--fg-dim);
    line-height: 1.5;
  }
</style>
