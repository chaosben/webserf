<script lang="ts">
  /**
   * The road assistant's plate over the game surface: start it, cancel it. What the road under the
   * pointer would cost is shown at the pointer, not here — a line that changes with every tile the
   * pointer crosses makes the plate jump. The road itself is built by the click on the target flag.
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
    {#if roadAssistant.phase === 'idle'}
      <!-- The shell's own icon language, not a game sprite: the assistant is ours, and a picture
           from the control bar would claim it were part of the original's controls. -->
      <button type="button" class="start" onclick={() => roadAssistant.begin()}>
        <IconAssistant aria-hidden="true" />
        <span>{st('enh.assist.road.plan')}</span>
      </button>
    {:else}
      {#if roadAssistant.phase === 'pickStart'}
        <p>{st('enh.assist.road.pickStart')}</p>
      {:else}
        <p>{st('enh.assist.road.pickTarget')}</p>
      {/if}
      <div class="row">
        <button type="button" onclick={() => roadAssistant.reset()}>{st('enh.assist.road.cancel')}</button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .assist {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.35em;
    max-width: 18em;
    padding: 0.35em;
    background: var(--bg-sunken);
    border: 1px solid var(--line);
    pointer-events: auto;
    user-select: none;
  }

  p {
    margin: 0;
    line-height: 1.4;
  }

  .row {
    display: flex;
    gap: 0.35em;
  }

  button {
    padding: 0.25em 0.5em;
    white-space: nowrap;
  }

  .start {
    display: flex;
    align-items: center;
    gap: 0.35em;
    align-self: flex-start;
  }

  .start :global(svg) {
    width: 1.3em;
    height: 1.3em;
    flex: none;
  }
</style>
