<script lang="ts">
  /**
   * The picker both selection tabs are made of: one box per entry, in the original's display order.
   *
   * The picture is the original icon; the name next to it is the internal identifier, spelled out.
   * In the OVERLAY the picture stands alone, as in the original — here it does not, because a
   * dialog of twenty-six nameless pictures cannot be aimed at, and because a missing archive would
   * otherwise leave nothing to click.
   */
  import { PICKER_ICON_SCALE, iconUrl } from './icon-images.svelte.js';
  import { maskHas, maskToggled } from './stock-overview.js';
  import { st } from '../shell/i18n.js';

  let {
    order,
    mask,
    icon,
    name,
    onchange
  }: {
    /** The entries, in display order — the index is what the mask counts in. */
    order: readonly number[];
    mask: number;
    icon: (index: number) => number | null;
    name: (index: number) => string;
    onchange: (mask: number) => void;
  } = $props();

  const chosen = $derived(order.filter((i) => maskHas(mask, i)).length);
  const anyIcon = $derived(
    order.some((i) => {
      const pic = icon(i);
      return pic !== null && iconUrl(pic, PICKER_ICON_SCALE) !== null;
    })
  );

  const allOn = (): void => onchange(order.reduce((m, i) => m | (1 << i), mask));
  const allOff = (): void => onchange(order.reduce((m, i) => m & ~(1 << i), mask));
</script>

<div class="head">
  <button type="button" onclick={allOn}>{st('enh.pick.all')}</button>
  <button type="button" onclick={allOff}>{st('enh.pick.none')}</button>
  <span class="note">{st('enh.pick.count', { on: chosen, all: order.length })}</span>
</div>

{#if !anyIcon}
  <p class="note">{st('enh.pick.noIcons')}</p>
{/if}

<ul>
  {#each order as index (index)}
    {@const pic = icon(index)}
    {@const url = pic === null ? null : iconUrl(pic, PICKER_ICON_SCALE)}
    <li>
      <label>
        <input
          type="checkbox"
          checked={maskHas(mask, index)}
          onchange={() => onchange(maskToggled(mask, index))}
        />
        {#if url !== null}
          <img src={url} alt="" />
        {/if}
        <span>{name(index)}</span>
      </label>
    </li>
  {/each}
</ul>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  ul {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.1rem 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  /*
   * No width here on purpose: the picture is rendered at its step and therefore already stands on
   * whole pixels. A `rem` width would shrink the sixteen-pixel icons below their own resolution —
   * which is what made them look like mush before.
   */
  img {
    object-fit: contain;
    image-rendering: pixelated;
  }

  .note {
    margin: 0;
    color: var(--fg-dim);
    line-height: 1.5;
  }
</style>
