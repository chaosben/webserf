<script lang="ts">
  /**
   * The two questions every overlay of ours asks: which corner, and how far it shows through.
   *
   * One component rather than one per enhancement — the controls are the same, and so are the names
   * of the corners (`enh.corner.*`, shared long before this component existed). It knows no
   * settings: it gets the two values and reports a change, like `IconPicker`.
   *
   * There is no size here. Every plate takes the control bar's scale and nothing else; see
   * `overlay-place.ts`.
   */
  import {
    CORNER_LABEL,
    OVERLAY_CORNERS,
    OVERLAY_OPACITY_MAX,
    OVERLAY_OPACITY_MIN
  } from './overlay-place.js';
  import { st } from '../shell/i18n.js';
  import type { OverlayCorner } from './overlay-place.js';

  let {
    corner,
    opacity,
    oncorner,
    onopacity
  }: {
    corner: OverlayCorner;
    opacity: number;
    oncorner: (corner: OverlayCorner) => void;
    onopacity: (opacity: number) => void;
  } = $props();

  const percent = $derived(Math.round(opacity * 100));
</script>

<section>
  <h3>{st('enh.place.corner')}</h3>
  <div class="row">
    {#each OVERLAY_CORNERS as option (option)}
      <button
        type="button"
        class:on={corner === option}
        aria-pressed={corner === option}
        onclick={() => oncorner(option)}
      >
        {st(CORNER_LABEL[option])}
      </button>
    {/each}
  </div>
</section>

<section>
  <h3>{st('enh.place.opacity')}</h3>
  <div class="row">
    <input
      type="range"
      min={OVERLAY_OPACITY_MIN}
      max={OVERLAY_OPACITY_MAX}
      step="0.05"
      value={opacity}
      aria-label={st('enh.place.opacity')}
      oninput={(e) => onopacity(Number(e.currentTarget.value))}
    />
    <span class="note">{percent} %</span>
  </div>
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
