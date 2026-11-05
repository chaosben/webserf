<script lang="ts">
  /**
   * The assistants over the game surface: ONE overlay, one row per assistant listed in the settings.
   *
   * Road assistant: one button that starts it and, while it runs, cancels it. The row keeps ONE shape
   * in every step — both labels share a grid cell, the other one hidden, so the button is always as
   * wide as the longer one; an overlay that resizes shifts every overlay stacked in its corner. For the
   * same reason the step's instruction is a status message and the cost of the road under the pointer
   * is shown at the pointer. The road itself is built by the click on the target flag.
   *
   * OUR OWN ADDITION, and a DOM layer — it appears in neither a screenshot nor a recording, but what
   * the assistants do does, through the ordinary commands. It holds no game state; everything runs
   * through the buses the game view serves.
   *
   * Like the hacks overlay it takes the pointer and stops every event, so a press on it never reaches
   * the viewport underneath (panning, zoom, long press); see `HacksOverlay.svelte` for what that
   * shield can and cannot do.
   */
  import { roadAssistant } from './road-assistant.svelte.js';
  import { settings } from '../settings/settings.svelte.js';
  import IconAssistant from '~icons/material-symbols-light/brightness-auto';
  import { st } from '../shell/i18n.js';

  let {
    opacity,
    scale
  }: {
    opacity: number;
    /** The control bar's own scale (`uiScaleFor`), as for every overlay. */
    scale: number;
  } = $props();

  const swallow = (e: Event): void => e.stopPropagation();

  const showRoad = $derived(settings.value.assistShowRoad && roadAssistant.present);
  const roadActive = $derived(roadAssistant.phase !== 'idle');
</script>

{#if showRoad}
  <!-- The handlers here are a shield, not a control: they keep clicks, drags and the wheel off the
       viewport underneath. The controls are real buttons and reachable on their own. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <section
    class="assist game-overlay"
    style:--plate-opacity={opacity}
    style:--overlay-scale={scale}
    aria-label={st('enh.assist.name')}
    onpointerdown={swallow}
    onpointerup={swallow}
    onpointermove={swallow}
    onclick={swallow}
    onwheel={swallow}
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
    }}
  >
    {#if showRoad}
      <!-- The shell's own icon language, not a game sprite: the road assistant is ours, and a
           picture from the control bar would claim it were part of the original's controls. -->
      <button
        type="button"
        onclick={() => (roadActive ? roadAssistant.reset() : roadAssistant.begin())}
      >
        <IconAssistant aria-hidden="true" />
        <!-- `visibility: hidden` also takes the other label out of the accessibility tree. -->
        <span class="labels">
          <span class:hidden={roadActive}>{st('enh.assist.road.plan')}</span>
          <span class:hidden={!roadActive}>{st('enh.assist.road.cancel')}</span>
        </span>
      </button>
    {/if}
  </section>
{/if}

<style>
  /* Two columns shared by every row (symbol | label): each button takes them over as a subgrid, so
     the labels start at the same x whatever the width of the glyph in front of them. */
  .assist {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25em;
    padding: 0.35em;
    background: var(--bg-sunken);
    border: 1px solid var(--line);
    pointer-events: auto;
    user-select: none;
  }

  /* As low as a hack switch beside it. That one holds a 9 px sign (× scale) plus 0.25em padding,
     ≈ 1.2em; a 1em line with 0.1em padding comes to the same height without clipping a letter. */
  button {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: subgrid;
    align-items: center;
    justify-items: start;
    column-gap: 0.35em;
    padding: 0.1em 0.4em;
    line-height: 1;
    text-align: start;
    white-space: nowrap;
  }

  button :global(svg) {
    width: 1em;
    height: 1em;
  }

  /* `start`, not the default stretch: stretched to the width of the longer label, the shorter one
     would be centred by the button's text alignment and begin further right than the row below. */
  .labels {
    display: grid;
    justify-items: start;
  }

  .labels > span {
    grid-area: 1 / 1;
  }

  .hidden {
    visibility: hidden;
  }
</style>
