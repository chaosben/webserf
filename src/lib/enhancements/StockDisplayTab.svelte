<script lang="ts">
  /** Where the stock overview sits, how far it shows through and how wide it runs. */
  import OverlayPlacement from './OverlayPlacement.svelte';
  import { STOCK_PER_ROW_MAX, STOCK_PER_ROW_MIN } from './stock-overview.js';
  import { settings } from '../settings/settings.svelte.js';
  import { st } from '../shell/i18n.js';
</script>

<OverlayPlacement
  corner={settings.value.stockCorner}
  opacity={settings.value.stockOpacity}
  oncorner={(corner) => settings.set('stockCorner', corner)}
  onopacity={(opacity) => settings.set('stockOpacity', opacity)}
/>

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

<style>
  section {
    display: grid;
    gap: 0.5rem;
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

  .note {
    margin: 0;
    color: var(--fg-dim);
    line-height: 1.5;
  }
</style>
