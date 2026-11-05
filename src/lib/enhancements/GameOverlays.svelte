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
   * **The bottom corners keep clear of the control bar.** A column whose measured width reaches into
   * the bar's horizontal span starts above the bar's top edge instead of at the window edge; beside
   * the bar it stays in its corner (`cornerBottom`).
   *
   * The container lets the pointer through. A plate that needs it takes it back for itself — the
   * viewport underneath carries panning, zoom and the map click, and an invisible catcher stretched
   * across a corner would eat them.
   */
  import StockOverlay from './StockOverlay.svelte';
  import HacksOverlay from './HacksOverlay.svelte';
  import AssistantsOverlay from './AssistantsOverlay.svelte';
  import { anyAssistantShown } from './assistants.js';
  import { CORNER_INSET_PX, OVERLAY_CORNERS, cornerBottom } from './overlay-place.js';
  import type { BoxRect } from '../views/ui-layout.js';
  import { settings } from '../settings/settings.svelte.js';
  import type { StockView } from './stock-overview.js';

  let {
    stockView,
    scale,
    bar,
    viewportW,
    viewportH
  }: {
    /** `null` = nothing selected, or no player to show. */
    stockView: StockView | null;
    /** The control bar's own scale (`uiScaleFor`) — every plate is sized by it and nothing else. */
    scale: number;
    /** The control bar in CSS pixels of the viewport, `null` while none is drawn. */
    bar: BoxRect | null;
    viewportW: number;
    viewportH: number;
  } = $props();

  /** Measured width of each corner column. */
  let widths = $state<Record<string, number>>({ tl: 0, tr: 0, bl: 0, br: 0 });

  function bottomOf(corner: 'bl' | 'br'): number {
    return cornerBottom(corner, widths[corner] ?? 0, bar, viewportW, viewportH);
  }
</script>

{#each OVERLAY_CORNERS as corner (corner)}
  <div
    class="corner {corner}"
    bind:clientWidth={widths[corner]}
    style:top={corner === 'tl' || corner === 'tr' ? `${CORNER_INSET_PX}px` : null}
    style:bottom={corner === 'bl' || corner === 'br' ? `${bottomOf(corner)}px` : null}
    style:left={corner === 'tl' || corner === 'bl' ? `${CORNER_INSET_PX}px` : null}
    style:right={corner === 'tr' || corner === 'br' ? `${CORNER_INSET_PX}px` : null}
    style:max-height={corner === 'bl' || corner === 'br'
      ? `min(90%, ${Math.max(0, viewportH - bottomOf(corner) - CORNER_INSET_PX)}px)`
      : null}
  >
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
    {#if settings.value.assistCorner === corner && anyAssistantShown(settings.value)}
      <AssistantsOverlay opacity={settings.value.assistOpacity} {scale} />
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
    align-items: flex-start;
  }

  .tr {
    align-items: flex-end;
  }

  /* Upwards, so the first plate keeps the edge and a second one grows away from it. */
  .bl {
    flex-direction: column-reverse;
    align-items: flex-start;
  }

  .br {
    flex-direction: column-reverse;
    align-items: flex-end;
  }
</style>
