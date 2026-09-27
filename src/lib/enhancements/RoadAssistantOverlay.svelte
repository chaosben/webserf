<script lang="ts">
  /**
   * The road assistant's plate over the game surface: one button that starts it and, while it runs,
   * cancels it. The plate keeps ONE shape in every step — both labels share a grid cell, the other one
   * hidden, so the button is always as wide as the longer one; a plate that resizes shifts every
   * plate stacked in its corner. For the same reason the step's instruction is a status message (the
   * bus shows it) and the cost of the road under the pointer is shown at the pointer. The road itself
   * is built by the click on the target flag.
   *
   * OUR OWN ADDITION, and a DOM layer — it appears in neither a screenshot nor a recording, but the
   * road it builds does, through the ordinary commands. It holds no game state; everything runs
   * through `roadAssistant`, which the game view serves.
   *
   * Like the hack plate it takes the pointer and stops every event, so a press on it never reaches
   * the viewport underneath (panning, zoom, long press); see `HacksOverlay.svelte` for what that
   * shield can and cannot do.
   */
  import { roadAssistant } from './road-assistant.svelte.js';
  import IconAssistant from '~icons/material-symbols-light/brightness-auto';
  import { st } from '../shell/i18n.js';

  let {
    opacity,
    scale
  }: {
    opacity: number;
    /** The control bar's own scale (`uiScaleFor`), as for every plate. */
    scale: number;
  } = $props();

  const swallow = (e: Event): void => e.stopPropagation();
  const active = $derived(roadAssistant.phase !== 'idle');
</script>

{#if roadAssistant.present}
  <!-- The handlers here are a shield, not a control: they keep clicks, drags and the wheel off the
       viewport underneath. The controls are real buttons and reachable on their own. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <section
    class="assist game-overlay"
    style:--plate-opacity={opacity}
    style:--overlay-scale={scale}
    aria-label={st('enh.assist.road')}
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
    <!-- The shell's own icon language, not a game sprite: the assistant is ours, and a picture
         from the control bar would claim it were part of the original's controls. -->
    <button type="button" onclick={() => (active ? roadAssistant.reset() : roadAssistant.begin())}>
      <IconAssistant aria-hidden="true" />
      <!-- `visibility: hidden` also takes the other label out of the accessibility tree. -->
      <span class="labels">
        <span class:hidden={active}>{st('enh.assist.road.plan')}</span>
        <span class:hidden={!active}>{st('enh.assist.road.cancel')}</span>
      </span>
    </button>
  </section>
{/if}

<style>
  .assist {
    display: flex;
    padding: 0.35em;
    background: var(--bg-sunken);
    border: 1px solid var(--line);
    pointer-events: auto;
    user-select: none;
  }

  button {
    display: flex;
    align-items: center;
    gap: 0.35em;
    padding: 0.25em 0.5em;
    white-space: nowrap;
  }

  button :global(svg) {
    width: 1.3em;
    height: 1.3em;
    flex: none;
  }

  .labels {
    display: grid;
  }

  .labels > span {
    grid-area: 1 / 1;
  }

  .hidden {
    visibility: hidden;
  }
</style>
