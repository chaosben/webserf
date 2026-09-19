<script lang="ts">
  /**
   * Which supply pointers the stock overview lists.
   *
   * Two pictures per entry, because neither half is unique on its own: the gold smelter appears
   * twice and coal three times — see `supply-pointers.ts`. Delivered good first, receiver second,
   * the direction of the label beside it and of the original's own arrow.
   *
   * A line here is ONE pointer, so it carries the whole sentence. The overview gathers pointers
   * under their receiver and draws that receiver as a heading instead; the sentence sits on the
   * pair beneath it there, good first all the same. Both places read good first — they differ only
   * in whether the receiver leads a group or ends a line.
   */
  import IconPicker from './IconPicker.svelte';
  import HideUnusedToggle from './HideUnusedToggle.svelte';
  import { SUPPLY_ORDER, SUPPLY_POINTERS, supplyIcon, supplyName } from './supply-pointers.js';
  import { settings } from '../settings/settings.svelte.js';
  import { st } from '../shell/i18n.js';

  const sideIcon = (index: number, side: 'to' | 'good'): number | null => {
    const p = SUPPLY_POINTERS[index];
    return p === undefined ? null : supplyIcon(p[side]);
  };
</script>

<section>
  <h3>{st('enh.stock.supply.title')}</h3>
  <IconPicker
    order={SUPPLY_ORDER}
    mask={settings.value.stockSupply}
    icon={(index) => sideIcon(index, 'good')}
    icon2={(index) => sideIcon(index, 'to')}
    name={supplyName}
    onchange={(mask) => settings.set('stockSupply', mask)}
  />
  <p class="note">{st('enh.stock.supply.note')}</p>
  <HideUnusedToggle
    label="enh.stock.supply.hideUnused"
    note="enh.stock.supply.hideUnusedNote"
    checked={settings.value.stockSupplyHideUnused}
    onchange={(on) => settings.set('stockSupplyHideUnused', on)}
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
