<script lang="ts">
  /**
   * The hacks over the game surface — where they are switched on, fired or dialled.
   *
   * OUR OWN ADDITION. It is a DOM layer and not part of the canvas, so it appears in neither a
   * screenshot nor a screen recording — but what a hack DRAWS does, which is why the bug report
   * names the hacks in force.
   *
   * Which hacks stand here is decided in the settings tab; this layer holds the switches alone, so
   * one does not have to open a dialog to try something and see the map change.
   *
   * **A switch shows the PICTURES of what its hack puts on the map**, not its name: the name sets
   * the width of the whole plate, and over the game surface that is a wall. The name stays as the
   * accessible name and as the fallback — without an archive there are no pictures.
   *
   * Unlike the stock overview this layer takes the pointer, so every event it gets is stopped here:
   * the viewport underneath carries panning, zoom and the long press, and a switch that also placed
   * a building would be worse than no switch.
   *
   * **What this shield can and cannot do.** It stops the viewport's own `on*` handlers, because
   * Svelte delegates both theirs and ours to one root listener and walks the tree itself — within
   * that system `stopPropagation()` arrives in time. It would NOT stop a listener the viewport
   * attached with `addEventListener`: the native bubble passes that long before the delegated walk
   * begins. The map click is such a listener, which is why it hangs on the CANVAS instead of the
   * viewport (reasoning in `MapView.svelte`); a plate is then out of its reach by construction
   * rather than by this shield.
   */
  import { HACKS, hackOn, hackShown, type Hack } from './hacks.js';
  import { mapObjectImage, type IconImage } from './icon-images.svelte.js';
  import { settings } from '../settings/settings.svelte.js';
  import { st } from '../shell/i18n.js';

  let {
    opacity,
    scale
  }: {
    /** How far the plate shows through. */
    opacity: number;
    /**
     * The control bar's own scale (`uiScaleFor`), passed straight through. What it turns into is
     * the shared `.game-overlay` rule, so a switch is the size of a readout beside it.
     */
    scale: number;
  } = $props();

  const shown = $derived(HACKS.filter((h) => hackShown(settings.value, h)));

  /**
   * The pictures at step 1, sized here to WHOLE pixels — the same treatment the stock plate gives
   * its icons, and the reason a fractional scale stays sharp.
   */
  const pictures = (hack: Hack): { url: string; w: number; h: number }[] =>
    (hack.objects ?? [])
      .map((object) => mapObjectImage(object))
      .filter((img): img is IconImage => img !== null)
      .map((img) => ({
        url: img.url,
        w: Math.max(1, Math.round(img.width * scale)),
        h: Math.max(1, Math.round(img.height * scale))
      }));

  const swallow = (e: Event): void => e.stopPropagation();
</script>

{#if shown.length > 0}
  <!-- The handlers here are a shield, not a control: they keep clicks, drags and the wheel off the
       viewport underneath. There is nothing for a keyboard to do with them — the switches are real
       buttons and reachable on their own. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <section
    class="hacks game-overlay"
    style:--plate-opacity={opacity}
    style:--overlay-scale={scale}
    aria-label={st('enh.hacks.name')}
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
    {#each shown as hack (hack.id)}
      {@const name = st(hack.labelKey)}
      {@const pics = pictures(hack)}
      {#if hack.kind === 'value'}
        <!-- A value hack dials a number, so it needs a numeric `hack…` field in `SettingsShape` —
             which is why none can exist yet. Its control belongs here, beside the name. -->
        <span>{name}</span>
      {:else}
        {@const on = hackOn(settings.value, hack)}
        <button
          type="button"
          class:on
          title={name}
          aria-label={name}
          aria-pressed={hack.kind === 'toggle' ? on : undefined}
          onclick={() => {
            if (hack.kind === 'action') hack.run();
            else settings.set(hack.key, !on);
          }}
        >
          {#if pics.length > 0}
            {#each pics as pic, i (i)}
              <img src={pic.url} alt="" width={pic.w} height={pic.h} />
            {/each}
          {:else}
            {name}
          {/if}
        </button>
      {/if}
    {/each}
  </section>
{/if}

<style>
  /*
   * The only plate of ours that TAKES the pointer — the corner stack lets it through, so it has to
   * take it back here. Where it sits is `GameOverlays`; this is shape alone.
   */
  .hacks {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.25em;
    max-width: 100%;
    padding: 0.35em;
    background: var(--bg-sunken);
    border: 1px solid var(--line);
    pointer-events: auto;
    user-select: none;
  }

  /*
   * No `font-size` here: it comes from `.game-overlay` through `font: inherit`, which is what makes
   * a switch exactly as large as a number on the stock plate — and what sizes the fallback name
   * when there are no pictures.
   */
  button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25em;
    padding: 0.25em 0.4em;
    white-space: nowrap;
  }

  button.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  /*
   * Off until the switch is on: the pictures then say WHICH hack, and the colour says whether it
   * runs — the same two readings the border carries, so the plate is legible at a glance.
   */
  img {
    display: block;
    image-rendering: pixelated;
    opacity: 0.55;
  }

  button.on img {
    opacity: 1;
  }
</style>
