<script lang="ts">
  /** Which settlers the stock overview lists — and what its numbers mean. */
  import IconPicker from './IconPicker.svelte';
  import { SERF_ORDER, serfIcon } from './ui-icons.js';
  import { STOCK_SERF_MODES, type StockSerfMode } from './stock-overview.js';
  import { serfName } from './entity-names.js';
  import { settings } from '../settings/settings.svelte.js';
  import { st } from '../shell/i18n.js';

  const MODE_LABEL = {
    idle: 'enh.serfs.modeIdle',
    available: 'enh.serfs.modeAvailable'
  } as const satisfies Record<StockSerfMode, Parameters<typeof st>[0]>;
</script>

<section>
  <h3>{st('enh.serfs.title')}</h3>
  <IconPicker
    order={SERF_ORDER}
    mask={settings.value.stockSerfs}
    icon={serfIcon}
    name={serfName}
    onchange={(mask) => settings.set('stockSerfs', mask)}
  />
</section>

<section>
  <h3>{st('enh.serfs.mode')}</h3>
  <div class="row">
    {#each STOCK_SERF_MODES as mode (mode)}
      <button
        type="button"
        class:on={settings.value.stockSerfMode === mode}
        aria-pressed={settings.value.stockSerfMode === mode}
        onclick={() => settings.set('stockSerfMode', mode)}
      >
        {st(MODE_LABEL[mode])}
      </button>
    {/each}
  </div>
  <p class="note">{st('enh.serfs.modeNote')}</p>
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
