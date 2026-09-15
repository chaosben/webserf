<script lang="ts">
  /**
   * All our own plates over the game surface, grouped by the corner they were sent to.
   *
   * **A corner is a stack, not a spot.** Each plate used to place itself, so two of them in the same
   * corner covered each other and the lower one was unreachable — the hack switches take the
   * pointer, so that was not merely ugly. Here the corner is a flex column and the plates are
   * ordinary blocks in it; the bottom corners stack upwards so each plate stays anchored to its own
   * edge.
   *
   * The container lets the pointer through. A plate that needs it takes it back for itself — the
   * viewport underneath carries panning, zoom and the map click, and an invisible catcher stretched
   * across a corner would eat them.
   */
  import StockOverlay from './StockOverlay.svelte';
  import HacksOverlay from './HacksOverlay.svelte';
  import { OVERLAY_CORNERS } from './overlay-place.js';
  import { settings } from '../settings/settings.svelte.js';
  import type { StockView } from './stock-overview.js';

  let {
    stockView,
    scale
  }: {
    /** `null` = nothing selected, or no player to show. */
    stockView: StockView | null;
    /** The control bar's own scale (`uiScaleFor`) — every plate is sized by it and nothing else. */
    scale: number;
  } = $props();
</script>

{#each OVERLAY_CORNERS as corner (corner)}
  <div class="corner {corner}">
    {#if settings.value.stockCorner === corner}
      <StockOverlay
        view={stockView}
        opacity={settings.value.stockOpacity}
        perRow={settings.value.stockPerRow}
        {scale}
      />
    {/if}
    {#if settings.value.hacksCorner === corner}
      <HacksOverlay opacity={settings.value.hacksOpacity} {scale} />
    {/if}
  </div>
{/each}

<style>
  .corner {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    /* Against the viewport, not against the plates: the column shrinks to its content, so a
       percentage on a plate inside would have nothing to resolve against. */
    max-width: 92%;
    max-height: 90%;
    pointer-events: none;
  }

  .tl {
    top: 0.5rem;
    left: 0.5rem;
    align-items: flex-start;
  }

  .tr {
    top: 0.5rem;
    right: 0.5rem;
    align-items: flex-end;
  }

  /* Upwards, so the first plate keeps the edge and a second one grows away from it. */
  .bl {
    bottom: 0.5rem;
    left: 0.5rem;
    flex-direction: column-reverse;
    align-items: flex-start;
  }

  .br {
    bottom: 0.5rem;
    right: 0.5rem;
    flex-direction: column-reverse;
    align-items: flex-end;
  }
</style>
