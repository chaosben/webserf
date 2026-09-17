<script lang="ts">
  /** Which goods the stock overview lists. */
  import IconPicker from './IconPicker.svelte';
  import HideUnusedToggle from './HideUnusedToggle.svelte';
  import { GOOD_ORDER, goodIcon } from './ui-icons.js';
  import { goodName } from './entity-names.js';
  import { settings } from '../settings/settings.svelte.js';
  import { st } from '../shell/i18n.js';
</script>

<section>
  <h3>{st('enh.stock.goods.title')}</h3>
  <IconPicker
    order={GOOD_ORDER}
    mask={settings.value.stockGoods}
    icon={goodIcon}
    name={goodName}
    onchange={(mask) => settings.set('stockGoods', mask)}
  />
  <p class="note">{st('enh.stock.goods.note')}</p>
  <HideUnusedToggle
    label="enh.stock.goods.hideUnused"
    checked={settings.value.stockGoodsHideUnused}
    onchange={(on) => settings.set('stockGoodsHideUnused', on)}
  />
</section>

<style>
  section {
    display: grid;
    gap: 0.5rem;
  }

  h3 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .note {
    margin: 0;
    color: var(--fg-dim);
    line-height: 1.5;
  }
</style>
